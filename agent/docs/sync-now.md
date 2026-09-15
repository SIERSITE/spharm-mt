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
GET /api/outbox/v1/sync-requests/pending?farmaciaId=<cuid>&waitSeconds=<N>
```

- **Parâmetros**:
  - `farmaciaId` (query string, obrigatório) — o cuid da farmácia à
    qual esta instalação do agent está ligada (`SPHARMMT_FARMACIA`,
    resolvido para cuid via `GET /api/ingest/v1/farmacias` antes desta
    chamada — ver `resolveFarmaciaId` em `agent/src/commands/sync-now.ts`).
  - `waitSeconds` (query string, opcional) — pede LONG-POLL: se não
    houver nada reclamável no primeiro `SELECT`, o servidor mantém o
    pedido HTTP em espera, repetindo a tentativa internamente a cada
    ~1.2s, até `waitSeconds` decorridos ou até aparecer algo. Tecto de
    segurança: **25s** (`LONGPOLL_MAX_WAIT_SECONDS`,
    `lib/sync-request/longpoll.ts`) — valores maiores são cortados
    para o tecto, nunca rejeitados. Omitido ou `<= 0` → comportamento
    de sempre, resposta imediata (`count: 0` se não houver nada) — não
    quebra nenhum chamador que não conheça este parâmetro.
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

Implementação: `app/api/outbox/v1/sync-requests/pending/route.ts`
(`export const runtime = "nodejs"; export const dynamic = "force-dynamic";`
declarados explicitamente — uma rota que pode ficar à espera segundos
não pode arriscar ser tratada como estática/cacheável). Lógica pura do
long-poll (testável sem BD): `lib/sync-request/longpoll.ts`. Cliente:
`SaasClient.pullPendingSyncRequests()` em `agent/src/http-client.ts`.

## 2. Long-polling — perto de tempo real, sem processo persistente

Um processo persistente no agent (Task Scheduler `/SC ONSTART`) foi
avaliado e **rejeitado**: `run/pipeline.lock` é hoje adquirido uma vez
por invocação inteira — um processo vivo há horas ficaria a segurá-lo
indefinidamente, bloqueando `daily-pipeline`/`full-sync`; e o Task
Scheduler não reinicia sozinho um processo persistente que morra.

Em vez disso, `sync-now` continua a ser uma corrida CURTA disparada
pelo Task Scheduler, mas cada corrida faz **3 ciclos sequenciais** de
`GET .../pending?waitSeconds=18` (`SYNC_NOW_LONGPOLL_CYCLES` /
`SYNC_NOW_LONGPOLL_WAIT_SECONDS` em `agent/src/commands/sync-now.ts`) —
o SERVIDOR mantém cada um em espera até 18s ou até aparecer um pedido.
Orçamento desta corrida quando NADA está pendente: ~54s (3 × 18s); se
algo aparecer num ciclo, os restantes são cancelados e a corrida segue
logo para o lock/processamento.

**Task Scheduler: `/SC MINUTE /MO 1` (a cada 1 minuto)** — reduzido dos
2 minutos do desenho anterior. Justificação: com um orçamento de ~54s
de long-poll a cada corrida de 60s, a corrida seguinte fica coberta por
uma janela de long-poll aberta quase todo o tempo — só há uma janela
"cega" de ~5-6s entre o fim de uma corrida (nada encontrado) e o
arranque da seguinte. Manter `/MO 2` faria essa janela cega crescer
para a ordem de 1 minuto (120s de intervalo − 54s de long-poll), sem
nenhum benefício de custo real: o pedido HTTP extra por minuto é uma
ligação held-open, não trabalho — o custo (ligações idle) já não é
dominado pela FREQUÊNCIA de corridas mas pela DURAÇÃO do hold em cada
uma.

**Latência pior caso (clique → agent reclama o pedido), com `/MO 1` e
orçamento de 54s**:

```
pior_caso ≈ (intervalo_scheduler − orçamento_corrida) + jitter_scheduler
          ≈ (60s − 54s) + ~2-5s
          ≈ 7-11s
```

— i.e., um clique que aconteça mesmo no instante em que uma corrida
acabou de desistir (nada pendente nos 3 ciclos) espera até à corrida
seguinte ser disparada; qualquer clique durante os ~54s em que uma
corrida está com um long-poll aberto é apanhado em ≤ ~1.2s (o intervalo
interno de repetição do servidor). Isto substitui a latência do
desenho anterior (~2 min + corrida, dominada pelo intervalo entre
polls) por uma latência dominada pelo `waitSeconds` de cada ciclo — o
Task Scheduler deixa de ser o gargalo.

Depois de reclamado, o processamento em si (produtos+stock de hoje)
ainda tem o seu próprio timeout de parede — ver secção 6.

## 3. Autenticação

A mesma do resto do agent: `Authorization: Bearer <ingestKey>` +
`X-Tenant-Slug: <tenantSlug>`, construídos por `SaasClient` a partir de
`agent.config.json` (ou `.env`). `pullPendingSyncRequests`,
`ackSyncRequest` e `failSyncRequest` usam o mesmo cliente que
`daily-sync`/`daily-pipeline`/`full-sync` — nenhum mecanismo novo.

## 4. Claiming / lock

Dois níveis:

- **Servidor** — `GET .../pending` reclama de forma ATÓMICA via
  `UPDATE ... FROM (SELECT ... FOR UPDATE SKIP LOCKED)`, repetida a
  cada tentativa interna do long-poll (secção 2): dois agents (ou duas
  corridas simultâneas do mesmo `sync-now`) nunca reclamam o mesmo
  pedido. O pedido passa `PENDENTE → EM_CURSO` nesse mesmo `UPDATE`, com
  `leasedAt`/`leasedBy`/`startedAt` gravados. Sem TTL de lease
  reclamável — o agent corre o trabalho de forma SÍNCRONA logo a
  seguir, dentro da mesma invocação do comando; não há um segundo
  processo a competir pela mesma farmácia.
- **Agent (local)** — `run/pipeline.lock`, o MESMO ficheiro que
  `daily-pipeline`/`full-sync` já usam (`agent/src/commands/sync-now.ts`,
  função `acquireLock`). Um "sync agora" nunca corre ao mesmo tempo que
  o pipeline nocturno na mesma farmácia — ambos tocam produtos/stock.

  **Adquirido SÓ quando um pedido é efectivamente reclamado** — nunca
  durante os 3 ciclos de long-poll da secção 2 (`runLongPollCycles` em
  `agent/src/commands/sync-now.ts` nem sequer importa `acquireLock`).
  Não há nada a proteger enquanto o comando só está a perguntar "há
  algo pendente?"; segurar o lock durante ~54s de long-poll em TODAS as
  corridas — mesmo as que não têm nada para processar — bloquearia
  `daily-pipeline`/`full-sync` sem motivo. Isto é uma mudança face ao
  desenho anterior (que adquiria o lock antes mesmo de perguntar).

  Se o lock estiver ocupado **no momento em que um pedido É reclamado**,
  `sync-now` NÃO espera por ele — chama `.../fail` de imediato (ver
  secção 6) e sai com exit 2. O pedido não fica pendurado como
  `EM_CURSO` até expirar aos 15 min; o utilizador vê o erro e decide se
  carrega no botão outra vez.

O corpo leve continua a escrever produtos+stock da mesma farmácia que o
pipeline nocturno, portanto continua a precisar de serializar com ele —
só o MOMENTO em que essa serialização é pedida mudou.

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

Três níveis de timeout, complementares:

1. **Por-query, no driver SQL** — `ERP_SQLSERVER_REQUEST_TIMEOUT_MS`
   (default 30s, configurável até 30 min), já aplicado a QUALQUER
   comando do agent via `agent/src/sql-client.ts`. Limita UMA query.
2. **Por-ciclo de long-poll, no cliente HTTP** —
   `syncNowLongPollTimeoutMs(waitSeconds)` em `agent/src/http-client.ts`
   (`waitSeconds * 1000 + 10_000`, ex. 28s para `waitSeconds=18`).
   Tem de exceder o `waitSeconds` pedido ao servidor — senão o `fetch`
   aborta antes do servidor responder, mesmo num "nada pendente"
   perfeitamente normal. Limita a ESPERA por um pedido, não o trabalho
   a seguir.
3. **Por-corrida, neste comando** — `SYNC_NOW_LOCAL_TIMEOUT_MS` = **8
   minutos**, em `agent/src/commands/sync-now.ts`. Envolve o passo de
   processamento inteiro (produtos + stock, múltiplos batches + POSTs
   ao SaaS) numa corrida contra o relógio, DEPOIS de o pedido já ter
   sido reclamado; se exceder, é tratado como qualquer outro erro — cai
   no mesmo `catch` que chama `failSyncRequest` e devolve exit 2. Nunca
   fica pendurado indefinidamente numa farmácia com ERP lento.

   Porque 8 min: o timeout SERVER-SIDE do pedido é 15 min
   (`SYNC_REQUEST_TIMEOUT_MINUTOS_DEFAULT`, `lib/sync-request/estado.ts`),
   contado desde o CLIQUE, não desde a reclamação. Até o agent reclamar
   o pior caso é agora ~1 minuto (secção 2), não os ~2 min do desenho
   anterior; depois do trabalho ainda falta o `ack`/`fail` viajar até ao
   SaaS. 8 min deixa essa espera (menor que antes) + a chamada final com
   folga ainda maior dentro dos 15 min totais, e continua generoso para
   o caso leve (um só dia, não o histórico inteiro).

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
  erro do SaaS, **ou lock local ocupado no momento da reclamação** — ver
  secção 4) → `FALHOU`. O utilizador vê o erro no widget e decide se
  carrega no botão outra vez; o mutex já permite um novo pedido assim
  que este deixa de estar activo (`podeCriarNovoPedido` em
  `lib/sync-request/estado.ts`).
- Um pedido ainda `PENDENTE` (nunca chegou a ser reclamado — ex.: o
  comando falhou ANTES de completar nenhum ciclo de long-poll, ou a
  chamada ao SaaS falhou de rede) fica candidato à PRÓXIMA corrida
  automaticamente, sem nenhuma acção do utilizador — não é preciso
  voltar a carregar no botão.

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
  /SC MINUTE /MO 1 ^
  /RL LIMITED ^
  /F
```

- `/SC MINUTE /MO 1` — a frequência decidida na secção 2. Cada corrida
  já gasta até ~54s em long-poll quando não há nada pendente, por isso
  `/MO 1` mantém as corridas quase costas-com-costas sem se
  sobreporem (o Task Scheduler, por omissão, não arranca uma nova
  instância enquanto a anterior ainda corre).
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
