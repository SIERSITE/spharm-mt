# Resiliência da sincronização diária (agent rev98)

## 1. Porquê

Em 15/10/2026, às 03:00, o `daily-pipeline` da Silveirense (dia 2026-10-14) terminou com código 1:

```
SaaS POST /api/ingest/v1/bootstrap/products — falha de rede: fetch failed
```

O servidor tinha recebido e processado com sucesso (HTTP 200, `upserted=50`, `errors=0`) o último lote — **perdeu-se a
resposta**. O cliente não repetia nada, o agent abortou o pipeline inteiro e o `RestartOnFailure` do Agendador do Windows
(`RestartCount=3`, `PT15M`) **não** reexecutou (não houve execuções às 03:15/03:30/03:45). A recuperação principal passa a ser do
próprio agent. O Agendador continua configurado como proteção adicional.

## 2. Retentativas por pedido (cliente HTTP — `http-client.ts`, `politica-retry.ts`)

Política por omissão: **tentativa original + 4 retentativas**, esperas ≈ **5 s, 15 s, 30 s, 60 s** + jitter (até +20 %, só se soma),
`Retry-After` respeitado quando existe e é razoável (≤ 120 s; nunca encurta a espera da política), **timeout de 30 s por pedido**.

| Repete-se | Não se repete |
| --- | --- |
| `fetch failed` · `AbortError`/timeout · ligação reiniciada/fechada (`ECONNRESET`, `UND_ERR_SOCKET`, …) · corpo da resposta cortado · DNS temporário (`ENOTFOUND`/`EAI_AGAIN`) · ligação recusada · HTTP **408, 425, 429, 502, 503, 504** | HTTP **400, 401, 403, 404, 409, 422** e qualquer outro 4xx/5xx · erros de validação · erros de configuração |

Exceções documentadas (só nos endpoints indicados):

* **`aggregate-month`, `aggregate-compras`, `aggregate-devolucoes`**: HTTP **500 com `acquire_lock`** no corpo (o pedido original ainda
  está a correr no servidor; a janela de retry do lock do servidor é de ~1 s). Repete-se, com espera mínima de 30 s.
* **`products/finalize`**: depois de uma retentativa, `409 sem_corrida_aberta` significa «o sweep já foi feito pela tentativa anterior»
  e é aceite como sucesso. À primeira tentativa continua a ser erro.
* **`fornecedores`, `compras`, `devolucoes-fornecedor`**: depois de uma falha **ambígua**, uma resposta 200 com `errors[]` (conflito de
  unicidade com o pedido original ainda a correr) é repetida mais uma vez.
* **Sem retry** (claim/ack não se repetem às cegas): `orders/pending`, `orders/{id}/ack|nack`, `sync-requests/pending` (long-poll),
  `sync-requests/{id}/ack|fail`.

Configurável em `agent.config.json → options` (**todas opcionais**; ausentes = defaults seguros):

```json
"options": {
  "httpRetryDelaysMs": [5000, 15000, 30000, 60000],
  "httpRetryJitter": 0.2,
  "httpTimeoutMs": 30000,
  "httpRetryAfterMaxMs": 120000,
  "pipelineMaxAttempts": 4,
  "pipelineRetryWaitMinutes": 15,
  "catchUpMaxDays": 7,
  "sqlRetryDelaysMs": [5000, 20000]
}
```

(`"httpRetryDelaysMs": []` desliga as retentativas HTTP.) Valores inválidos são ignorados. Equivalentes por variável de ambiente:
`SPHARMMT_HTTP_RETRY_ESPERAS_MS`, `SPHARMMT_HTTP_RETRY_JITTER`, `SPHARMMT_HTTP_TIMEOUT_MS`, `SPHARMMT_HTTP_RETRY_AFTER_MAX_MS`,
`SPHARMMT_PIPELINE_TENTATIVAS`, `SPHARMMT_PIPELINE_ESPERA_MIN`, `SPHARMMT_CATCHUP_MAX_DIAS`, `SPHARMMT_SQL_RETRY_ESPERAS_MS`.

### Resposta perdida ≠ pedido perdido

Quando o pedido falha, nem sempre se sabe se o servidor o recebeu. O log marca `AMBÍGUA` quando o servidor **pode** já ter escrito
(ligação caiu/expirou depois de enviar, corpo truncado, 5xx) e «o servidor não chegou a processar» quando não (DNS, ligação recusada,
429). Em qualquer caso a retentativa reenvia **exatamente o mesmo corpo** (serializado uma só vez), com as mesmas chaves naturais /
`idempotencyKey` / `ingestRunId`, e **nenhum cursor local avança** sem uma resposta válida (`lastId` só avança depois de a resposta chegar).

## 3. Auditoria de idempotência (repetir o mesmo pedido é seguro?)

Evidência no servidor (`app/api/…`, `lib/ingest/bulk.ts`) e provada contra PostgreSQL real em
`scripts/tests/test-agent-reenvio-idempotente-db.ts` (produtos, stock, linhas de venda e PipelineRun repetidos 2–3×).

| Endpoint | Escrita | Repetição exata | Veredicto |
| --- | --- | --- | --- |
| `POST bootstrap/products` | `INSERT … ON CONFLICT (cnp)` e `(produtoId, farmaciaId)` | mesmo estado final; só contadores (`produtosNovos`↘, `produtosRecebidos` da corrida↗ — telemetria) | **Seguro** |
| `POST bootstrap/products/finalize` | `UPDATE … SET flagRetirado WHERE dataAtualizacao < corte` + fecha a corrida | 1.ª passagem fez tudo; a 2.ª dá `409 sem_corrida_aberta` | **Seguro com ressalva** → o agent trata o 409 após retentativa como «já feito» |
| `GET/POST …/products/designacoes` | `UPDATE … WHERE designacao IS DISTINCT FROM` | 2.ª passagem altera 0 | **Seguro** |
| `POST bootstrap/stock` | soma só DENTRO do pedido; `ON CONFLICT DO UPDATE` **substitui** | idêntico (não acumula) | **Seguro** |
| `POST bootstrap/sales-lines` | `ON CONFLICT (farmaciaId, sourceNamespace, externalSaleLineId) DO UPDATE` | sem duplicados | **Seguro** |
| `POST bootstrap/fornecedores` · `compras` · `devolucoes-fornecedor` | `findUnique` + `create`/`update`; únicos `(farmaciaId, externalLineId)`… | convergem; `created`↘/`updated`↗; se o pedido original ainda corre, `P2002` por item em `errors[]` | **Seguro com ressalva** → repete-se 1× se `errors[]` após falha ambígua |
| `POST /api/ingest/v1/movimentos` | `ON CONFLICT (farmaciaId, externalMovId)`; `ingestRunId` | sem duplicados | **Seguro** (o `ingestRunId` mantém-se na repetição) |
| `POST admin/pipeline/aggregate-month` | `DELETE` do mês + `createMany` numa transação, com advisory lock | recalcula e substitui (não soma); **cria um `PipelineRun` `aggregate-month` por chamada** | **Seguro com ressalva** (lock ocupado → 500 `acquire_lock`, tratado; histórico de `aggregate-month` pode ter linhas extra — não afeta o catch-up, que só lê `daily-pipeline`) |
| `POST admin/pipeline/aggregate-compras` · `aggregate-devolucoes` | upserts por chave, com lock | substitui por valores recalculados | **Seguro** (idem lock) |
| `POST admin/pipeline/record` | `upsert` por `idempotencyKey` | atualiza a mesma linha | **Seguro com a chave** (o agent envia-a sempre; sem chave duplicava) |
| `GET …/dias-concluidos`, `GET …/farmacias`, `POST outbox/v1/heartbeat` | leitura / `lastAgentHeartbeatAt` | sem efeitos | **Seguro** |

**Nenhuma alteração ao servidor foi necessária.**

## 4. Retoma do pipeline (`retoma-pipeline.ts`, `lock-pipeline.ts`)

Quando uma falha **transitória** esgota as retentativas HTTP, o próprio processo espera **~15 min** e repete o dia, até **4 tentativas**
no total (1 + 3 retomas), registando `tentativa k/4`:

* **dia de referência original** (nunca recalculado);
* **checkpoint** em memória dos passos já confirmados (daily-sync, fornecedores, compras, devoluções, movimentos, refresh operacional,
  designações, aggregate-month): numa retoma não se repetem; um passo sem checkpoint (ou depois de um reinício) repete-se de forma idempotente;
* só retoma se **todas** as falhas da tentativa forem transitórias (HTTP esgotado, subprocesso a sair com 75 = `EX_TEMPFAIL`); um 409 de gate
  (`unknowns_present`…), uma falha de validação ou a saúde das vendas **não** esperam — o catch-up volta a propô-los;
* o **lock** (`run/pipeline.lock`, com heartbeat — ver 4b) mantém-se durante a espera: nenhuma segunda execução entra; um processo concorrente é recusado;
* as tentativas intermédias **não** registam `PipelineRun` nem alertam — só o desfecho final (a mesma `idempotencyKey` cobre a execução toda);
* o estado `pendente` é gravado **antes** de dormir: se o computador ou o processo reiniciar durante a espera, o dia é recuperado pelo catch-up na
  corrida seguinte (3).

## 4b. Lock único com heartbeat (`lock-pipeline.ts`)

O MESMO módulo e protocolo para `daily-pipeline`, `full-sync`, `sync-now` e os comandos de escrita avulsos (`products-upload`, `stock-upload`,
`bootstrap-upload`, `fornecedores-upload`, `compras-upload`, `devolucoes-fornecedor-upload`, `stocksmov-upload`, `daily-sync`). **Sem lock:**
`--plan`, `test-connection`, `*-dry-run`, previews e discovery. Os subcomandos lançados por `daily-pipeline`/`full-sync` herdam o lock do pai
(`SPHARMMT_LOCK_RUN_ID`): não o renovam nem o libertam.

* **Criação atómica e exclusiva** (`wx`): só um processo ganha, mesmo com vários a reclamar em simultâneo.
* **Conteúdo** (JSON, sem segredos): `runId` (UUID da execução), `pid`, `host`, `imagem` (ex.: `node.exe`), `criadoEm`, `heartbeatEm`, `modo`, `dia`.
* **Heartbeat** a cada 10 s, escrito (tmp + rename) por um **worker thread** — o agent tem chamadas bloqueantes (`spawnSync`, queries) e um timer
  normal deixaria de disparar com o processo vivo.
* **Só se reclama** um lock quando: o processo **já não existe**; ou o PID pertence a **outro programa** (Windows: `tasklist` devolve outra imagem —
  PID reutilizado); ou o **heartbeat expirou** (120 s) — cobre reinícios do PC e PID reutilizado por outro `node.exe`; ou `--force`. Um lock com
  heartbeat fresco e processo vivo nunca é reclamado, por mais horas que dure a execução. Locks rev97 (sem heartbeat): só se o processo morreu ou
  passaram 6 h.
* **A libertação compara o `runId`**, não o PID: uma execução nunca liberta (nem reescreve, nem renova) o lock de outra; se o perde, o heartbeat para
  e a execução fica a sabê-lo.
* Libertação também no fim normal do processo (handler de `exit`). Morte abrupta ⇒ lock órfão ⇒ reclamado no arranque seguinte em segundos
  (processo morto) ou em ≤ 2 min (heartbeat expirado), **não** em 6 h.
* `--plan` mostra o estado do lock só em leitura (`livre` / `OCUPADO — …` / `órfão (reclamável) — …`).

## 4c. Falhas do SQL Server (`sql-erros.ts`, `withPool`)

Classificação prudente sobre os erros reais do `mssql` (`code`, `number`, `originalError`); **desconhecido ⇒ não transitório**.

| Transitórias (repetem-se) | Permanentes (nunca se repetem) |
| --- | --- |
| `ETIMEOUT` (ligação ou pedido) · `ESOCKET` · `ECONNCLOSED` · reset/ligação terminada · rede temporária (`ECONNREFUSED` com o serviço a reiniciar, `EHOSTUNREACH`, `EAI_AGAIN`) · pool a fechar/indisponível · deadlock (1205) · servidor a desligar (6005/6006) · Winsock 10053/10054/10060/10061 | credenciais (`ELOGIN`/18456) · base inexistente (4060) · tabela (208) / coluna (207) inexistente · sintaxe (102/156…) · permissão (229/262…) · nome do servidor errado (`ENOTFOUND`) · certificado/encrypt mal configurado · configuração inválida · qualquer erro desconhecido |

`withPool` repete **só o transitório**: até 2 retentativas (5 s e 20 s; `options.sqlRetryDelaysMs`), cada uma com um **pool novo** (o anterior é fechado sem
mascarar o erro). Esgotadas, o erro sai marcado como transitório e o comando sai com 75 ⇒ o `daily-pipeline` retoma (até 4 tentativas, ~15 min) e, em
qualquer caso, o dia fica pendente para o catch-up da corrida seguinte. Um erro permanente falha logo, sem esperas: não vira um ciclo de horas.

## 5. Recuperação de dias em falta (catch-up)

Ao arrancar, o agent pergunta ao SaaS que dias estão concluídos (`GET …/pipeline/dias-concluidos`, só `status=OK`), mostra o **último dia
concluído confirmado** e processa, por ordem cronológica, os dias em falta **antes** do dia normal (ontem em Europe/Lisbon). Não repete dias
concluídos; cada dia agrega no seu mês (mudança de mês incluída); limite configurável (`catchUpMaxDays`, `--max-catch-up`, default 7) — o que
excede fica **registado** e é apanhado na corrida seguinte.

Se o SaaS **não** conseguir informar, o log diz-o de forma explícita («o SaaS não conseguiu informar o último dia concluído») e o plano usa a
**pista local** `run/pipeline-pendentes.json` (que só acrescenta dias) + o dia normal; um dia que o SaaS dê como concluído descarta a pista.

`--plan` mostra o plano e **não executa nada**: `node.exe agent.cjs daily-pipeline --plan` (ou `run-daily-pipeline-plan.bat`).

## 6. Logs, resumo e estado local

Cada tentativa HTTP com problema escreve uma linha, por exemplo:

```
[http] POST /api/ingest/v1/bootstrap/products dia=2026-10-14 etapa=daily-sync lote=6 tentativa 1/5 falhou: ligacao_reiniciada [ECONNRESET] em 412ms — AMBÍGUA (o servidor pode já ter processado; repete-se o mesmo pedido idempotente) — nova tentativa em 5.7s
[http] POST /api/ingest/v1/bootstrap/products dia=2026-10-14 etapa=daily-sync lote=6 ✓ concluído na tentativa 2/5 em 380ms (houve tentativa ambígua — pedido idempotente repetido com o mesmo corpo) | última falha: ligacao_reiniciada ECONNRESET
```

Nunca se registam o token, os headers nem o conteúdo dos pedidos (todo o log HTTP passa por uma redação final de segredos). O resumo de cada dia
é um de: **concluído à primeira · concluído após retentativa HTTP · concluído após retoma do pipeline · recuperado como dia em falta · falha
definitiva**; o mesmo desfecho e as estatísticas HTTP seguem no `details.resiliencia` do `PipelineRun`.

Ficheiros em `run/` (atómicos; nenhum contém segredos nem dados de negócio):

| Ficheiro | Para quê |
| --- | --- |
| `pipeline-pendentes.json` | dias com falha / retoma agendada (pista local do catch-up) |
| `pipelinerun-pendentes/*.json` | `PipelineRun` que o SaaS não aceitou — reenviado no arranque seguinte com a **mesma `idempotencyKey`** (sem duplicar) |
| `pipeline-alertas.json` | alertas por (farmácia, dia, causa): notificado ou não, erro da notificação, resolvido em |

## 7. Alerta operacional

* Falha definitiva (não vai ser retomada) → `PipelineRun` com `ERROR`/`PARTIAL`/`ABORTED` no SaaS (visível em `/admin/pipeline`), alerta aberto
  em `run/pipeline-alertas.json`, evento no **Registo de Eventos do Windows** (Application, origem `SPharmMT-Agent`, ID 901; best-effort) e,
  se `saas.healthcheckUrl` estiver configurado, `POST <url>/fail` no **Healthchecks.io** (infraestrutura já existente — sem SMTP nem credenciais
  novas no pacote).
* **Uma notificação por farmácia + dia + causa**; repetir o mesmo problema não reenvia.
* Se a notificação falhar, **a causa fica gravada** (`notificadoEm: null`, `ultimoErroNotificacao`) e é reenviada no arranque seguinte; o log
  diz «a notificação FALHOU … a causa mantém-se».
* Quando o dia fica concluído, os alertas desse dia ficam resolvidos e o pendente é removido (e o ping `ok` repõe o Healthchecks).

## 8. Códigos de saída

`0` OK · `1` falha · `2` parcial (`EXIT_PARTIAL`) · `75` (`EX_TEMPFAIL`) num **subcomando** que falhou por causa transitória do SaaS depois de
esgotadas as retentativas (o `daily-pipeline` usa-o para esperar e repetir; mantém os seus próprios 0/1/2).

## 9. Limitações conhecidas

* O checkpoint é **em memória**: depois de um reinício repete-se o dia todo (idempotente, ~3,5 min na Silveirense).
* Se o SaaS estiver em baixo mais de ~45 min (4 tentativas), o dia fica para o catch-up da corrida seguinte — com o alerta aberto.
* `aggregate-month` regista um `PipelineRun` por chamada (também nas repetições) — só ruído no histórico.
* Um pedido SQL que expira repetidamente por ser genuinamente lento (e não por falha de rede) gasta as retentativas e a retoma antes de falhar; resolve-se afinando a query ou `sqlServer.requestTimeoutMs`, não esperando mais.
* O heartbeat é um worker thread: se o computador **suspender** (sleep/hibernação) mais de 120 s, o lock pode ser reclamado por outra execução ao acordar; a primeira passa a saber que o perdeu (`perdido()`).
* A tarefa agendada deve ter `ExecutionTimeLimit = PT8H` — **só um teto de segurança** (pior caso teórico de um dia ≈ 3 h 25 min); a execução normal demora o mesmo que na rev97 (~3,5 min).
