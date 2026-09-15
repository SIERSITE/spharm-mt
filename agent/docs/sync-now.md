# `sync-now` — o poll do botão "Sincronizar agora" (/stock)

Bloco E. Este documento fecha o desenho operacional que faltava: o
endpoint exacto, a frequência do poll, a autenticação, o mecanismo de
lease/lock, como a conclusão e o erro são reportados, a política de
retry, e como instalar/actualizar a tarefa do Windows que faz este
comando correr sozinho. Nada disto foi instalado neste ambiente — é
documentação + um `.bat` de exemplo, para quem for adoptar isto numa
farmácia real seguir sem inventar nada.

## 1. O endpoint que o agent consulta

```
GET /api/outbox/v1/sync-requests/pending?farmaciaId=<cuid>
```

- **Parâmetros**: `farmaciaId` (query string, obrigatório) — o cuid da
  farmácia à qual esta instalação do agent está ligada
  (`SPHARMMT_FARMACIA`, resolvido para cuid via
  `GET /api/ingest/v1/farmacias` antes desta chamada — ver
  `resolveFarmaciaId` em `agent/src/commands/sync-now.ts`).
- **Autenticação**: EXACTAMENTE a mesma do resto do agent —
  `Authorization: Bearer <ingestKey>` + `X-Tenant-Slug: <tenantSlug>`,
  aplicados por `SaasClient` (`agent/src/http-client.ts`). Nada de novo
  foi inventado para este endpoint.
- **Cabeçalho opcional**: `x-agent-instance` — identifica esta
  instalação nos logs do lease (`<tenantSlug>-<hostname>`).
- **Resposta**:
  ```json
  {
    "count": 0 | 1,
    "syncRequests": [
      {
        "syncRequestId": "cuid",
        "farmaciaId": "cuid",
        "requestedAt": "2026-09-15T10:00:00.000Z",
        "timeoutAt": "2026-09-15T10:15:00.000Z"
      }
    ]
  }
  ```
  `count` é sempre 0 ou 1: o mutex aplicacional + o índice único parcial
  (`SyncRequest_farmacia_ativo_key`) garantem no máximo um pedido
  `PENDENTE`/`EM_CURSO` por farmácia.

Implementação: `app/api/outbox/v1/sync-requests/pending/route.ts`.
Cliente: `SaasClient.pullPendingSyncRequests()` em
`agent/src/http-client.ts`.

## 2. Frequência do poll

**2 minutos.**

O Windows Task Scheduler suporta repetição a cada 1 minuto no mínimo
(`schtasks /SC MINUTE /MO 1`). Escolhemos 2 em vez de 1:

| | 1 min | **2 min (escolhido)** | 5 min |
|---|---|---|---|
| Latência pior caso (clique → resultado) | ~1 min + corrida | ~2 min + corrida | ~5 min + corrida |
| Pedidos HTTP/dia por farmácia (idle) | 1440 | 720 | 288 |
| Folga até ao timeout server-side (15 min) | maior | confortável | menor |

Um "Sincronizar agora" que demore 2-3 minutos a reflectir-se na UI é
aceitável para o caso de uso (o utilizador já sabe que não é
instantâneo — ver o aviso no `sync-now-widget.tsx`); poupar metade dos
pedidos HTTP idle face a 1 min, sem sacrificar folga face ao timeout de
15 min do pedido, foi o critério de desempate. Farmácias com ERP lento
ou pouco tráfego podem ir para 5 min editando o `/MO` da tarefa — nada
no agent assume 2 min.

## 3. Autenticação

A mesma do resto do agent: `Authorization: Bearer <ingestKey>` +
`X-Tenant-Slug: <tenantSlug>`, construídos por `SaasClient` a partir de
`agent.config.json` (ou `.env`). `pullPendingSyncRequests`,
`ackSyncRequest` e `failSyncRequest` usam o mesmo cliente que
`daily-sync`/`daily-pipeline`/`full-sync` — nenhum mecanismo novo.

## 4. Claiming / lock

Dois níveis, que já existiam antes desta revisão e continuam coerentes
com o corpo leve (correcção 1):

- **Servidor** — `GET .../pending` reclama de forma ATÓMICA via
  `UPDATE ... FROM (SELECT ... FOR UPDATE SKIP LOCKED)`: dois agents (ou
  duas corridas simultâneas do mesmo `sync-now`) nunca reclamam o mesmo
  pedido. O pedido passa `PENDENTE → EM_CURSO` nesse mesmo `UPDATE`, com
  `leasedAt`/`leasedBy`/`startedAt` gravados. Sem TTL de lease
  reclamável — o agent corre o trabalho de forma SÍNCRONA logo a
  seguir, dentro da mesma invocação do comando; não há um segundo
  processo a competir pela mesma farmácia.
- **Agent (local)** — `run/pipeline.lock`, o MESMO ficheiro que
  `daily-pipeline`/`full-sync` já usam (`agent/src/commands/sync-now.ts`,
  função `acquireLock`). Um "sync agora" nunca corre ao mesmo tempo que
  o pipeline nocturno na mesma farmácia — ambos tocam produtos/stock.
  Se o lock estiver ocupado, `sync-now` sai com exit 0 (não reclama
  nenhum pedido) e o PRÓXIMO poll tenta de novo — o pedido continua
  `PENDENTE` no SaaS até alguém o reclamar.

O corpo leve (correcção 1) não mudou nenhuma destas duas garantias:
continua a escrever produtos+stock da mesma farmácia que o pipeline
nocturno, portanto continua a precisar de serializar com ele.

## 5. Conclusão

```
POST /api/outbox/v1/sync-requests/{syncRequestId}/ack
Body: { "resultado": { "stockAtualizado": N, "produtosAtualizados": N, "fabricantesAlterados": N } }
```

Os três contadores vêm directamente do `PipelineRunCounts` devolvido por
`runPipelineForDay({ scope: "products-stock" })`
(`agent/src/commands/daily-sync-runner.ts`):

- `stockAtualizado` ← `counts.stockUpserted`
- `produtosAtualizados` ← `counts.productsUpserted`
- `fabricantesAlterados` ← `counts.fabricantesAlterados` (agregado a
  partir de `BootstrapBatchResponse.catalogoErp.{preenchidos,substituidos}.fabricante`
  em cada batch — rev93)

Transita `EM_CURSO → CONCLUIDO` e grava uma `PipelineRun`
(`kind="sync-now"`, `status="OK"`, `triggeredBy="operator"`) para
auditoria — ver `app/api/outbox/v1/sync-requests/[syncRequestId]/ack/route.ts`.

## 6. Erro / timeout

```
POST /api/outbox/v1/sync-requests/{syncRequestId}/fail
Body: { "error": "mensagem" }
```

Dois níveis de timeout, complementares:

1. **Por-query, no driver SQL** — `ERP_SQLSERVER_REQUEST_TIMEOUT_MS`
   (default 30s, configurável até 30 min), já aplicado a QUALQUER
   comando do agent via `agent/src/sql-client.ts`. Limita UMA query.
2. **Por-corrida, neste comando** — `SYNC_NOW_LOCAL_TIMEOUT_MS` = **8
   minutos**, em `agent/src/commands/sync-now.ts`. Envolve o passo 4
   inteiro (produtos + stock, múltiplos batches + POSTs ao SaaS) numa
   corrida contra o relógio; se exceder, é tratado como qualquer outro
   erro — cai no mesmo `catch` que chama `failSyncRequest` e devolve
   exit 2. Nunca fica pendurado indefinidamente numa farmácia com ERP
   lento.

   Porque 8 min: o timeout SERVER-SIDE do pedido é 15 min
   (`SYNC_REQUEST_TIMEOUT_MINUTOS_DEFAULT`, `lib/sync-request/estado.ts`),
   contado desde o CLIQUE, não desde a reclamação. Até o agent reclamar
   já pode ter passado ~1 poll (2 min, ver secção 2); depois do trabalho
   ainda falta o `ack`/`fail` viajar até ao SaaS. 8 min deixa essa
   folga (~2 min de espera + chamada final) dentro dos 15 min totais,
   e continua generoso para o caso leve (um só dia, não o histórico
   inteiro).

Se o `fail` também falhar (ex.: rede caiu entre o erro local e o POST),
o pedido fica `EM_CURSO` preso — a leitura lazy do SaaS
(`resolverEstadoEfetivo` em `lib/sync-request/estado.ts`) trata-o como
`EXPIRADO` ao fim dos 15 min, e o mutex volta a libertar a farmácia sem
intervenção manual.

## 7. Retry

**Terminal, sem reagendamento automático** — mesma decisão do endpoint
`.../fail` (ver o cabeçalho de
`app/api/outbox/v1/sync-requests/[syncRequestId]/fail/route.ts`):

- Uma falha a MEIO (erro de ligação ao SQL Server local, timeout local,
  erro do SaaS) → `FALHOU`. O utilizador vê o erro no widget e decide
  se carrega no botão outra vez; o mutex já permite um novo pedido
  assim que este deixa de estar activo (`podeCriarNovoPedido` em
  `lib/sync-request/estado.ts`).
- Um pedido ainda `PENDENTE` (nunca chegou a ser reclamado — ex.: o
  comando falhou ANTES do passo 3, ou o lock local estava ocupado) fica
  candidato ao PRÓXIMO poll automaticamente, sem nenhuma acção do
  utilizador — não é preciso voltar a carregar no botão.

Não há retry automático do LADO DO AGENT para o MESMO pedido depois de
reclamado: reclamar, tentar, e desistir para o SaaS decidir (terminal
ou próximo clique) é mais simples e mais visível do que um agent a
tentar sozinho outra vez uma farmácia cujo ERP acabou de recusar uma
ligação.

## 8. A tarefa do Windows

Ficheiro de exemplo: **`agent/run-sync-now-poll-auto.bat`** — segue o
mesmo estilo de `run-export-orders-auto.bat` (sem prompts, sem janela
visível, log por dia em `logs\sync-now-<YYYY-MM-DD>.log`, exit code
propagado). Como os `.bat` de `daily-pipeline`/`export-orders`, este
ficheiro de exemplo fica ao lado dos fontes do agent; o empacotamento
real (`agent:package` → `dist-agent/<DIST_NAME>/`) e a publicação de
uma revisão que o inclua ficam para quando esta funcionalidade for
adoptada — não faz parte deste bloco (ver o comentário junto de
`AGENT_REV` em `agent/build.mjs`).

### Instalar (primeira vez)

Numa instalação já extraída em `C:\SPharmMT-Agent\` (ajustar o caminho
se for outro):

```bat
schtasks /Create ^
  /TN "SPharmMT-SyncNowPoll" ^
  /TR "\"C:\SPharmMT-Agent\run-sync-now-poll-auto.bat\"" ^
  /SC MINUTE /MO 2 ^
  /RL LIMITED ^
  /F
```

- `/SC MINUTE /MO 2` — a frequência decidida na secção 2.
- `/RL LIMITED` — corre sem privilégios elevados; este comando só faz
  SELECT ao SQL Server local + HTTPS ao SaaS.
- `/F` — cria mesmo que já exista uma tarefa com o mesmo nome (idempotente).

Se a tarefa precisar de correr mesmo com a sessão de Windows fechada,
acrescentar `/RU "<utilizador>" /RP "<password>"` (mesma decisão
operacional que já se aplica a `daily-pipeline`/`export-orders` — não é
específica do `sync-now`).

### Actualizar (nova revisão do agent já publicada)

O `.bat` e o `agent.cjs` mudam de conteúdo mas não de NOME nem de
CAMINHO num upgrade normal (o ZIP é extraído por cima da instalação
existente) — a tarefa do Task Scheduler não precisa de ser recriada.
Para confirmar ou reparar uma instalação onde a tarefa nunca foi
criada, ou para mudar a frequência, repetir o `schtasks /Create ... /F`
acima — `/F` substitui a definição existente sem duplicar.

### Consultar / remover

```bat
schtasks /Query /TN "SPharmMT-SyncNowPoll" /V /FO LIST
schtasks /Delete /TN "SPharmMT-SyncNowPoll" /F
```

### Logs

`logs\sync-now-<YYYY-MM-DD>.log`, um ficheiro por dia (append), mesmo
padrão de `logs\export-orders-<YYYY-MM-DD>.log`. Exit code 0 (nada
pendente ou sucesso) não gera nenhuma linha de alerta; exit 1/2 escreve
um `ERROR:` explícito no fim do ficheiro do dia — grep por `ERROR:` é
suficiente para uma primeira triagem.
