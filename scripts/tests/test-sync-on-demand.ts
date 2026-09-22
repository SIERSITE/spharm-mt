/**
 * scripts/tests/test-sync-on-demand.ts
 *
 * Bloco E — botão "Sincronizar agora" em /stock.
 *
 *   A  mutex: não permite um 2º pedido PENDENTE/EM_CURSO para a mesma
 *      farmácia; um pedido CONCLUIDO/FALHOU/EXPIRADO liberta-a
 *   B  cálculo de expiração LAZY por timeout (`resolverEstadoEfetivo` +
 *      `deveriaPersistirExpiracao`)
 *   C  `computeTimeoutAt` — aritmética de minutos
 *   D  reclamabilidade pelo agent (`eReclamavelPeloAgent`) — farmácia
 *      certa, estado PENDENTE, ainda dentro do timeout
 *   E  ack/fail só aceites a partir de EM_CURSO (`podeReceberAckOuFail`)
 *   F  `parseSyncResultado` é defensivo contra JSON solto/malformado
 *   G  permissão `stock.sync` e `canAccessFarmaciaSync` — a matriz e o
 *      isolamento por farmácia usados pela server action
 *   H  as pontas estão ligadas (schema, migration, cli do agent, UI)
 *
 * Sem BD real: tudo aqui são funções puras de `lib/sync-request/estado.ts`
 * + `lib/permissions.ts`, e inspecção de ficheiros-fonte para a secção H.
 *
 * Corre com:  npm run test:sync-on-demand
 */
import { readFileSync } from "node:fs";
import {
  computeTimeoutAt,
  deveriaPersistirExpiracao,
  eReclamavelPeloAgent,
  parseSyncResultado,
  podeCriarNovoPedido,
  podeReceberAckOuFail,
  resolverEstadoEfetivo,
  resultadoVazio,
  SYNC_REQUEST_TIMEOUT_MINUTOS_DEFAULT,
  type EstadoSyncRequest,
  type SyncRequestEstadoSnapshot,
} from "../../lib/sync-request/estado";
import { can, canAccessFarmaciaSync } from "../../lib/permissions-core";
import type { SessionUser } from "../../lib/session-claims";
import { clampWaitSeconds, longPollClaim, LONGPOLL_MAX_WAIT_SECONDS } from "../../lib/sync-request/longpoll";
import {
  runLongPollCycles,
  decidePostClaim,
  SYNC_NOW_LONGPOLL_CYCLES,
  SYNC_NOW_LONGPOLL_WAIT_SECONDS,
} from "../../agent/src/commands/sync-now";
import { syncNowLongPollTimeoutMs } from "../../agent/src/http-client";

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) {
    ok++;
    console.log(`  [OK]    ${label}`);
  } else {
    ko++;
    console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`);
  }
};
const eq = (a: unknown, b: unknown, label: string) =>
  check(
    JSON.stringify(a) === JSON.stringify(b),
    label,
    `esperado ${JSON.stringify(b)}, obtido ${JSON.stringify(a)}`,
  );

const src = (p: string) => readFileSync(p, "utf8");

const AGORA = new Date("2026-09-14T10:00:00.000Z");
const ANTES_DO_TIMEOUT = new Date("2026-09-14T10:05:00.000Z");
const DEPOIS_DO_TIMEOUT = new Date("2026-09-14T10:20:00.000Z");
const TIMEOUT_15MIN = computeTimeoutAt(AGORA); // 10:15:00

function snap(estado: EstadoSyncRequest, timeoutAt: Date = TIMEOUT_15MIN): SyncRequestEstadoSnapshot {
  return { estado, timeoutAt };
}

// ═════════════════════════════════════════════════════════════════════
// A — Mutex
// ═════════════════════════════════════════════════════════════════════
console.log("\n== A. Mutex — um pedido activo por farmácia ==");
{
  const semPedido = podeCriarNovoPedido(null, AGORA);
  check(semPedido.permitido === true, "sem pedido anterior → permitido");

  const comPendente = podeCriarNovoPedido(snap("PENDENTE"), ANTES_DO_TIMEOUT);
  check(comPendente.permitido === false, "PENDENTE ainda dentro do timeout → bloqueado");
  if (!comPendente.permitido) {
    eq(comPendente.estadoActual, "PENDENTE", "…estadoActual reportado = PENDENTE");
    check(comPendente.motivo.length > 0, "…mensagem amigável não vazia");
  }

  const comEmCurso = podeCriarNovoPedido(snap("EM_CURSO"), ANTES_DO_TIMEOUT);
  check(comEmCurso.permitido === false, "EM_CURSO ainda dentro do timeout → bloqueado");

  const pendenteExpirado = podeCriarNovoPedido(snap("PENDENTE"), DEPOIS_DO_TIMEOUT);
  check(
    pendenteExpirado.permitido === true,
    "PENDENTE mas já passou o timeoutAt → permitido (expirado efectivamente liberta a farmácia)",
  );

  for (const estadoTerminal of ["CONCLUIDO", "FALHOU", "EXPIRADO"] as const) {
    const r = podeCriarNovoPedido(snap(estadoTerminal), ANTES_DO_TIMEOUT);
    check(r.permitido === true, `${estadoTerminal} → permitido criar um novo pedido`);
  }
}

// ═════════════════════════════════════════════════════════════════════
// B — Expiração lazy
// ═════════════════════════════════════════════════════════════════════
console.log("\n== B. Expiração lazy por timeout ==");
{
  eq(resolverEstadoEfetivo(snap("PENDENTE"), ANTES_DO_TIMEOUT), "PENDENTE", "PENDENTE antes do timeout mantém-se PENDENTE");
  eq(resolverEstadoEfetivo(snap("PENDENTE"), DEPOIS_DO_TIMEOUT), "EXPIRADO", "PENDENTE depois do timeout → EXPIRADO");
  eq(resolverEstadoEfetivo(snap("EM_CURSO"), DEPOIS_DO_TIMEOUT), "EXPIRADO", "EM_CURSO depois do timeout → EXPIRADO");
  eq(
    resolverEstadoEfetivo(snap("PENDENTE", AGORA), AGORA),
    "PENDENTE",
    "exactamente no instante do timeout (now == timeoutAt) ainda NÃO expirou — só `now > timeoutAt` expira",
  );

  for (const estadoTerminal of ["CONCLUIDO", "FALHOU", "EXPIRADO"] as const) {
    eq(
      resolverEstadoEfetivo(snap(estadoTerminal), DEPOIS_DO_TIMEOUT),
      estadoTerminal,
      `${estadoTerminal} não muda mesmo muito depois do timeoutAt (só PENDENTE/EM_CURSO expiram)`,
    );
  }

  check(
    deveriaPersistirExpiracao(snap("PENDENTE"), DEPOIS_DO_TIMEOUT) === true,
    "deveriaPersistirExpiracao: PENDENTE expirado → true (a leitura deve gravar EXPIRADO)",
  );
  check(
    deveriaPersistirExpiracao(snap("PENDENTE"), ANTES_DO_TIMEOUT) === false,
    "deveriaPersistirExpiracao: PENDENTE ainda válido → false",
  );
  check(
    deveriaPersistirExpiracao(snap("EXPIRADO"), DEPOIS_DO_TIMEOUT) === false,
    "deveriaPersistirExpiracao: já persistido como EXPIRADO → false (nada a fazer)",
  );
}

// ═════════════════════════════════════════════════════════════════════
// C — computeTimeoutAt
// ═════════════════════════════════════════════════════════════════════
console.log("\n== C. computeTimeoutAt ==");
{
  eq(
    computeTimeoutAt(AGORA).toISOString(),
    new Date(AGORA.getTime() + SYNC_REQUEST_TIMEOUT_MINUTOS_DEFAULT * 60_000).toISOString(),
    `default = ${SYNC_REQUEST_TIMEOUT_MINUTOS_DEFAULT} minutos`,
  );
  eq(
    computeTimeoutAt(AGORA, 5).toISOString(),
    new Date(AGORA.getTime() + 5 * 60_000).toISOString(),
    "minutos configurável (5 min)",
  );
}

// ═════════════════════════════════════════════════════════════════════
// D — Reclamabilidade pelo agent
// ═════════════════════════════════════════════════════════════════════
console.log("\n== D. eReclamavelPeloAgent ==");
{
  const req = { ...snap("PENDENTE"), farmaciaId: "farm-1" };
  check(eReclamavelPeloAgent(req, ANTES_DO_TIMEOUT, "farm-1") === true, "farmácia certa + PENDENTE + dentro do timeout → reclamável");
  check(eReclamavelPeloAgent(req, ANTES_DO_TIMEOUT, "farm-2") === false, "farmácia errada (agent configurado para outra) → NÃO reclamável");
  check(eReclamavelPeloAgent(req, DEPOIS_DO_TIMEOUT, "farm-1") === false, "já expirado → NÃO reclamável (trabalho a caminho de ninguém)");
  check(
    eReclamavelPeloAgent({ ...snap("EM_CURSO"), farmaciaId: "farm-1" }, ANTES_DO_TIMEOUT, "farm-1") === false,
    "EM_CURSO (já reclamado por outra invocação) → NÃO reclamável de novo",
  );
}

// ═════════════════════════════════════════════════════════════════════
// E — ack/fail só a partir de EM_CURSO
// ═════════════════════════════════════════════════════════════════════
console.log("\n== E. podeReceberAckOuFail ==");
{
  check(podeReceberAckOuFail("EM_CURSO") === true, "EM_CURSO → aceita ack/fail");
  for (const estado of ["PENDENTE", "CONCLUIDO", "FALHOU", "EXPIRADO"] as const) {
    check(podeReceberAckOuFail(estado) === false, `${estado} → recusa ack/fail (defesa contra races/ack tardio)`);
  }
}

// ═════════════════════════════════════════════════════════════════════
// F — parseSyncResultado defensivo
// ═════════════════════════════════════════════════════════════════════
console.log("\n== F. parseSyncResultado ==");
{
  eq(
    parseSyncResultado({ stockAtualizado: 12, produtosAtualizados: 34, fabricantesAlterados: 5 }),
    { stockAtualizado: 12, produtosAtualizados: 34, fabricantesAlterados: 5 },
    "objecto bem formado passa tal e qual",
  );
  eq(parseSyncResultado(null), resultadoVazio(), "null → resultado vazio (nunca lança)");
  eq(parseSyncResultado(undefined), resultadoVazio(), "undefined → resultado vazio");
  eq(parseSyncResultado("garbage"), resultadoVazio(), "string solta → resultado vazio");
  eq(
    parseSyncResultado({ stockAtualizado: "12", fabricantesAlterados: null }),
    resultadoVazio(),
    "campos com tipo errado (string/null em vez de number) caem para 0, nunca NaN nem excepção",
  );
  eq(
    parseSyncResultado({ stockAtualizado: 7 }),
    { stockAtualizado: 7, produtosAtualizados: 0, fabricantesAlterados: 0 },
    "campos em falta default a 0",
  );
}

// ═════════════════════════════════════════════════════════════════════
// G — Permissão + isolamento por farmácia
// ═════════════════════════════════════════════════════════════════════
console.log("\n== G. Permissão `stock.sync` + canAccessFarmaciaSync ==");
{
  function sessao(perfil: SessionUser["perfil"], farmaciaId: string | null): SessionUser {
    return { sub: "u1", tenant: "acme", perfil, farmaciaId } as SessionUser;
  }

  check(can(sessao("ADMINISTRADOR", null), "stock.sync") === true, "ADMINISTRADOR pode sincronizar");
  check(can(sessao("GESTOR_GRUPO", null), "stock.sync") === true, "GESTOR_GRUPO pode sincronizar");
  check(can(sessao("GESTOR_FARMACIA", "farm-1"), "stock.sync") === true, "GESTOR_FARMACIA pode sincronizar");
  check(can(sessao("OPERADOR", "farm-1"), "stock.sync") === false, "OPERADOR (só-leitura) NÃO pode sincronizar");
  check(can(null, "stock.sync") === false, "sem sessão → nunca");

  check(
    canAccessFarmaciaSync(sessao("ADMINISTRADOR", null), "qualquer-farmacia") === true,
    "ADMINISTRADOR acede a qualquer farmácia pedida explicitamente",
  );
  check(
    canAccessFarmaciaSync(sessao("GESTOR_GRUPO", null), "qualquer-farmacia") === true,
    "GESTOR_GRUPO acede a qualquer farmácia pedida explicitamente",
  );
  check(
    canAccessFarmaciaSync(sessao("GESTOR_FARMACIA", "farm-1"), "farm-1") === true,
    "GESTOR_FARMACIA acede à SUA farmácia",
  );
  check(
    canAccessFarmaciaSync(sessao("GESTOR_FARMACIA", "farm-1"), "farm-2") === false,
    "GESTOR_FARMACIA NÃO acede a uma farmácia forjada no pedido (isolamento — mesmo padrão do Bloco A)",
  );
  check(
    canAccessFarmaciaSync(sessao("OPERADOR", "farm-1"), "farm-2") === false,
    "OPERADOR também isolado à sua farmácia (embora nem chegue aqui — falha primeiro em `can`)",
  );
}

// ═════════════════════════════════════════════════════════════════════
// H — As pontas estão ligadas
// ═════════════════════════════════════════════════════════════════════
console.log("\n== H. Wiring ponta-a-ponta ==");
{
  const schema = src("prisma/schema.prisma");
  check(schema.includes("enum EstadoSyncRequest"), "schema.prisma declara EstadoSyncRequest");
  check(schema.includes("model SyncRequest"), "schema.prisma declara SyncRequest");
  check(
    /farmacia\s+Farmacia\s+@relation\(fields: \[farmaciaId\], references: \[id\], onDelete: Cascade\)/.test(
      schema.slice(schema.indexOf("model SyncRequest")),
    ),
    "SyncRequest → Farmacia (FK, cascade)",
  );
  check(
    /requestedBy\s+Utilizador\s+@relation\(fields: \[requestedByUserId\], references: \[id\]\)/.test(
      schema.slice(schema.indexOf("model SyncRequest")),
    ),
    "SyncRequest → Utilizador (FK, quem pediu)",
  );
  check(schema.includes("syncRequests                        SyncRequest[]"), "Farmacia.syncRequests[] presente");
  check(schema.includes("syncRequestsPedidos SyncRequest[]"), "Utilizador.syncRequestsPedidos[] presente");

  const migration = src("prisma/migrations/20260915110000_sync_request_outbox/migration.sql");
  check(
    migration.includes('CREATE UNIQUE INDEX "SyncRequest_farmacia_ativo_key"') &&
      migration.includes("WHERE \"estado\" IN ('PENDENTE', 'EM_CURSO')"),
    "migração cria o índice único PARCIAL do mutex (rede de segurança real contra races)",
  );

  const cli = src("agent/src/cli.ts");
  check(cli.includes('"sync-now"'), "cli.ts regista o comando sync-now");
  check(cli.includes("./commands/sync-now.js"), "cli.ts importa de commands/sync-now.js");

  const httpClient = src("agent/src/http-client.ts");
  check(httpClient.includes("pullPendingSyncRequests"), "SaasClient expõe pullPendingSyncRequests");
  check(httpClient.includes("ackSyncRequest"), "SaasClient expõe ackSyncRequest");
  check(httpClient.includes("failSyncRequest"), "SaasClient expõe failSyncRequest");

  // rev94 (long-polling real) → rev95 (refresh operacional diário +
  // observabilidade do lock, ver refresh-operacional.test.ts). O número
  // exacto muda a cada rev; o que este teste garante é que o bloco de
  // comentários fica por perto de "94" — prova de que a rev de
  // long-polling não regrediu para uma anterior.
  check(
    src("agent/build.mjs").includes('rev94 — sync-now passa a fazer LONG-POLLING real'),
    "AGENT_REV: o histórico de rev94 (long-polling real) continua documentado",
  );
  check(
    src("agent/build.mjs").includes('process.env.AGENT_PACKAGE_REV ?? "95"'),
    "AGENT_REV avançou para 95 (refresh operacional diário)",
  );

  const stockClient = src("components/stock/stock-client.tsx");
  check(stockClient.includes("SyncNowWidget"), "StockClient desenha o SyncNowWidget no cabeçalho");
  check(stockClient.includes("syncFarmacias"), "StockClient recebe syncFarmacias como prop");

  const page = src("app/stock/page.tsx");
  check(page.includes('can(session, "stock.sync")'), "StockPage só carrega farmácias de sync quando a sessão tem a permissão");

  const ackRoute = src("app/api/outbox/v1/sync-requests/[syncRequestId]/ack/route.ts");
  check(ackRoute.includes("withIntegrationAuthParams"), "endpoint ack usa a MESMA auth do resto do outbox (Bearer + X-Tenant-Slug)");
  check(ackRoute.includes("PIPELINE_KIND.SYNC_NOW"), "ack regista PipelineRun kind=sync-now (auditoria de execução)");

  const pendingRoute = src("app/api/outbox/v1/sync-requests/pending/route.ts");
  check(pendingRoute.includes("FOR UPDATE SKIP LOCKED"), "lease do pending é atómico (mesmo padrão do outbox de encomendas)");
}

// ═════════════════════════════════════════════════════════════════════
// I — Correcção 1: o corpo leve não arrasta bootstrap-upload.ts
// ═════════════════════════════════════════════════════════════════════
console.log("\n== I. sync-now.ts usa daily-sync-runner.ts, não bootstrap-upload.ts ==");
{
  const syncNow = src("agent/src/commands/sync-now.ts");
  check(
    !/from ["']\.\/bootstrap-upload\.js["']/.test(syncNow),
    "sync-now.ts NÃO importa nada de ./bootstrap-upload.js (o corpo leve não arrasta o caminho de onboarding)",
  );
  check(
    !/import\s*\{[^}]*\b(runProductsPipeline|runStockPipeline|renderTotals)\b[^}]*\}/.test(syncNow),
    "sync-now.ts não IMPORTA runProductsPipeline/runStockPipeline/renderTotals (podem ficar mencionadas em prosa, a explicar a mudança, mas não usadas)",
  );
  check(
    /from "\.\/daily-sync-runner\.js"/.test(syncNow),
    "sync-now.ts importa de ./daily-sync-runner.js",
  );
  check(
    /runPipelineForDay/.test(syncNow),
    "sync-now.ts chama runPipelineForDay (o MESMO runner do daily-sync/daily-pipeline)",
  );
  check(
    /scope:\s*"products-stock"/.test(syncNow),
    'sync-now.ts pede scope: "products-stock" — nunca o pipeline de vendas',
  );
  check(
    /hojeNaFarmacia/.test(syncNow),
    "sync-now.ts usa hojeNaFarmacia() — sincroniza o que mudou desde a meia-noite, não o histórico inteiro",
  );

  const runner = src("agent/src/commands/daily-sync-runner.ts");
  check(
    /scope\?:\s*"full"\s*\|\s*"products-stock"/.test(runner),
    'daily-sync-runner.ts declara a opção scope?: "full" | "products-stock" em runPipelineForDay',
  );
  check(
    /if \(scope === "full"\)/.test(runner),
    "daily-sync-runner.ts só corre pipelineSales quando scope === \"full\"",
  );
  check(
    /fabricantesAlterados: number/.test(runner),
    "PipelineRunCounts ganhou fabricantesAlterados — é o 3º contador que o ack de sync-now reporta",
  );
}

// ═════════════════════════════════════════════════════════════════════
// J — Correcção 2: timeout local + retry do agent
// ═════════════════════════════════════════════════════════════════════
console.log("\n== J. Timeout local e política de retry do agent ==");
{
  const syncNow = src("agent/src/commands/sync-now.ts");
  check(
    /SYNC_NOW_LOCAL_TIMEOUT_MS\s*=\s*8 \* 60 \* 1000/.test(syncNow),
    "sync-now.ts define um timeout local de parede (8 min) para a corrida inteira",
  );
  check(
    /withLocalTimeout/.test(syncNow),
    "sync-now.ts envolve a corrida (withPool+runPipelineForDay) num withLocalTimeout",
  );
  check(
    /catch \(err\) \{[\s\S]{0,400}failSyncRequest/.test(syncNow),
    "um timeout local (como qualquer outro erro na corrida) cai no catch que chama failSyncRequest",
  );

  const docSyncNow = src("agent/docs/sync-now.md");
  check(
    /schtasks \/Create/.test(docSyncNow) && /\/SC MINUTE \/MO 1/.test(docSyncNow),
    "docs/sync-now.md documenta o comando schtasks exacto, a 1 minuto",
  );
  check(
    /Terminal, sem reagendamento automático/.test(docSyncNow),
    "docs/sync-now.md declara a política de retry (terminal + candidato ao próximo poll se ainda PENDENTE)",
  );

  const bat = src("agent/run-sync-now-poll-auto.bat");
  check(
    /node\.exe agent\.cjs sync-now/.test(bat),
    "run-sync-now-poll-auto.bat invoca o comando sync-now",
  );
  check(
    /logs\\sync-now-/.test(bat),
    "run-sync-now-poll-auto.bat escreve em logs\\sync-now-<data>.log, como os outros .bat auto",
  );
}

// ═════════════════════════════════════════════════════════════════════
// P — Trava garantia (2026-09): "Sincronizar agora" desligado só para o
//     tenant garantia, enquanto decorre a classificação de fabricantes/
//     grupos laboratoriais — recusado no SERVIDOR (não só escondido na
//     UI), outros tenants seguem inalterados. Verificação por inspecção
//     do código-fonte, mesmo padrão das secções H/N/O acima (a acção
//     real precisa de `requirePermission`/`headers()` de um pedido Next
//     a sério para correr).
// ═════════════════════════════════════════════════════════════════════
console.log("\n== P. Trava garantia — Sincronizar agora recusado no servidor, outros tenants inalterados ==");
{
  const tenantContext = src("lib/tenant-context.ts");
  check(
    tenantContext.includes('export const TENANT_SYNC_BLOQUEADO = "garantia"'),
    "lib/tenant-context.ts declara TENANT_SYNC_BLOQUEADO = \"garantia\" — fonte única para as duas camadas (servidor + UI)",
  );

  const syncActions = src("app/stock/sync-actions.ts");
  const bodyRequestSyncNow = syncActions.slice(syncActions.indexOf("export async function requestSyncNowAction"));
  check(
    bodyRequestSyncNow.includes("resolveCurrentTenantSlug") && bodyRequestSyncNow.includes("TENANT_SYNC_BLOQUEADO"),
    "requestSyncNowAction resolve o tenant actual e compara com TENANT_SYNC_BLOQUEADO",
  );
  check(
    /tenantSlug === TENANT_SYNC_BLOQUEADO/.test(bodyRequestSyncNow),
    "a comparação é POR IGUALDADE ao tenant bloqueado (=== \"garantia\") — nunca uma negação tipo '!== outroTenant', que bloquearia todos os OUTROS tenants em vez de só o garantia",
  );
  const idxCheck = bodyRequestSyncNow.indexOf("TENANT_SYNC_BLOQUEADO");
  const idxCreate = bodyRequestSyncNow.indexOf("syncRequest.create(");
  check(
    idxCheck !== -1 && idxCreate !== -1 && idxCheck < idxCreate,
    "a verificação do tenant acontece ANTES do INSERT do SyncRequest — recusa mesmo antes de tocar na base",
  );
  check(
    !bodyRequestSyncNow.slice(0, bodyRequestSyncNow.indexOf("resolveCurrentTenantSlug")).includes("syncRequest.create("),
    "não há nenhum caminho de escrita ANTES da trava — a trava é a primeira coisa depois da permissão",
  );

  const page = src("app/stock/page.tsx");
  check(
    page.includes("resolveCurrentTenantSlug") && page.includes("TENANT_SYNC_BLOQUEADO"),
    "app/stock/page.tsx também verifica o tenant — a UI não oferece um botão que o servidor ia recusar",
  );
  check(
    /tenantSlug !== TENANT_SYNC_BLOQUEADO/.test(page),
    "a UI só carrega syncFarmacias quando o tenant NÃO é o bloqueado — outros tenants continuam a ver o widget normalmente",
  );

  // Import a partir de app/stock/sync-actions.ts teria rebentado o build
  // (ficheiro "use server" só pode exportar funções) — confirma que a
  // constante NÃO é exportada de lá.
  check(
    !/export const TENANT_SYNC_BLOQUEADO/.test(syncActions),
    "TENANT_SYNC_BLOQUEADO NÃO é declarada em sync-actions.ts (ficheiro \"use server\" só pode exportar funções — a constante vive em lib/tenant-context.ts)",
  );
}

// ═════════════════════════════════════════════════════════════════════
// K — Long-poll no SERVIDOR (`lib/sync-request/longpoll.ts`)
//
// Núcleo puro (sem BD) — testado com um `attemptClaim` falso e um
// relógio/sleep INJECTADOS, para nunca esperar `waitSeconds` a sério:
// o "sleep" falso só avança um contador em vez de dormir de verdade.
// ═════════════════════════════════════════════════════════════════════
async function correrTestesAssincronos(): Promise<void> {
console.log("\n== K. Long-poll no servidor (lib/sync-request/longpoll.ts) ==");
{
  // -- clampWaitSeconds --
  eq(clampWaitSeconds(null), 0, "clampWaitSeconds(null) → 0 (sem long-poll, comportamento actual)");
  eq(clampWaitSeconds(""), 0, "clampWaitSeconds('') → 0");
  eq(clampWaitSeconds("0"), 0, "clampWaitSeconds('0') → 0");
  eq(clampWaitSeconds("-5"), 0, "clampWaitSeconds negativo → 0");
  eq(clampWaitSeconds("abc"), 0, "clampWaitSeconds não-numérico → 0");
  eq(clampWaitSeconds("10"), 10, "clampWaitSeconds('10') → 10 (dentro do tecto)");
  eq(
    clampWaitSeconds("999"),
    LONGPOLL_MAX_WAIT_SECONDS,
    `clampWaitSeconds('999') → cortado ao tecto (${LONGPOLL_MAX_WAIT_SECONDS}s)`,
  );
  eq(LONGPOLL_MAX_WAIT_SECONDS, 25, "tecto de segurança do long-poll é 25s");

  // -- longPollClaim: relógio/sleep falsos, deterministas --
  function fakeClock() {
    let clock = 0;
    return {
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms;
      },
    };
  }

  // a) já havia algo pendente no primeiro SELECT → devolve de imediato,
  //    sem esperar nenhum waitSeconds.
  {
    let calls = 0;
    const { now, sleep } = fakeClock();
    const result = await longPollClaim(
      async () => {
        calls++;
        return [{ id: "ja-pendente" }];
      },
      { waitSeconds: 20, now, sleep },
    );
    eq(result, [{ id: "ja-pendente" }], "já pendente no 1º SELECT → devolve esse pedido");
    eq(calls, 1, "…sem repetir a tentativa — 1 única chamada a attemptClaim");
    eq(now(), 0, "…e sem avançar o relógio — não esperou nada");
  }

  // b) nada aparece → devolve vazio exactamente ao fim do waitSeconds.
  {
    let calls = 0;
    const { now, sleep } = fakeClock();
    const result = await longPollClaim(
      async () => {
        calls++;
        return [] as Array<{ id: string }>;
      },
      { waitSeconds: 2, pollIntervalMs: 1200, now, sleep },
    );
    eq(result, [], "nada em todo o waitSeconds → devolve vazio (count:0 equivalente)");
    check(calls >= 2, "…repetiu a tentativa pelo menos uma vez durante a espera", `calls=${calls}`);
    check(now() >= 2000, "…o relógio avançou pelo menos os 2000ms pedidos", `now()=${now()}`);
  }

  // c) aparece a meio da espera → pára logo, não espera o waitSeconds todo.
  {
    let calls = 0;
    const { now, sleep } = fakeClock();
    const result = await longPollClaim(
      async () => {
        calls++;
        return calls >= 3 ? [{ id: "apareceu-a-meio" }] : [];
      },
      { waitSeconds: 20, pollIntervalMs: 1200, now, sleep },
    );
    eq(result, [{ id: "apareceu-a-meio" }], "aparece no 3º attempt → devolve-o");
    eq(calls, 3, "…pára exactamente no attempt que encontrou algo (não continua a tentar)");
    check(
      now() < 20_000,
      "…o relógio NÃO chegou aos 20s pedidos — não esperou o waitSeconds todo",
      `now()=${now()}`,
    );
  }

  // d) waitSeconds <= 0 → uma única tentativa, resposta imediata (o
  //    comportamento de sempre para quem não pede long-poll).
  {
    let calls = 0;
    const result = await longPollClaim(
      async () => {
        calls++;
        return [] as Array<{ id: string }>;
      },
      { waitSeconds: 0 },
    );
    eq(result, [], "waitSeconds=0 e nada pendente → vazio de imediato");
    eq(calls, 1, "…1 única tentativa, sem loop de espera");
  }
}

// ═════════════════════════════════════════════════════════════════════
// L — Ciclos de long-poll do AGENT (`runLongPollCycles`) e a decisão
//     pós-claim quando o lock está ocupado (`decidePostClaim`) —
//     ambas puras, sem SQL/fs/rede.
// ═════════════════════════════════════════════════════════════════════
console.log("\n== L. runLongPollCycles + decidePostClaim (agent/src/commands/sync-now.ts) ==");
{
  eq(SYNC_NOW_LONGPOLL_CYCLES, 3, "3 ciclos de long-poll por corrida");
  eq(SYNC_NOW_LONGPOLL_WAIT_SECONDS, 18, "18s por ciclo (orçamento total ~54s quando nada está pendente)");

  // -- runLongPollCycles --
  {
    let pulls = 0;
    const req = { syncRequestId: "s1", farmaciaId: "f1", requestedAt: "t", timeoutAt: "t2" };
    const r = await runLongPollCycles(
      async (waitSeconds) => {
        pulls++;
        eq(waitSeconds, 18, `ciclo ${pulls} pede waitSeconds=18`);
        return { count: 1, syncRequests: [req] };
      },
      { cycles: 3, waitSeconds: 18 },
    );
    eq(r.claimed, req, "1º ciclo já encontra algo → devolve esse pedido");
    eq(r.cyclesUsed, 1, "…cyclesUsed=1 (não gastou os 3 ciclos)");
    eq(pulls, 1, "…só chamou pullOnce 1 vez — parou ao encontrar");
  }
  {
    let pulls = 0;
    const r = await runLongPollCycles(
      async () => {
        pulls++;
        return { count: 0, syncRequests: [] };
      },
      { cycles: 3, waitSeconds: 18 },
    );
    eq(r.claimed, null, "nenhum ciclo encontra nada → claimed=null");
    eq(r.cyclesUsed, 3, "…cyclesUsed=3 (gastou todos os ciclos configurados)");
    eq(pulls, 3, "…chamou pullOnce exactamente 3 vezes, nem mais nem menos");
  }
  {
    let pulls = 0;
    const req = { syncRequestId: "s2", farmaciaId: "f1", requestedAt: "t", timeoutAt: "t2" };
    const r = await runLongPollCycles(
      async () => {
        pulls++;
        return pulls === 2 ? { count: 1, syncRequests: [req] } : { count: 0, syncRequests: [] };
      },
      { cycles: 3, waitSeconds: 18 },
    );
    eq(r.claimed, req, "encontra no 2º de 3 ciclos → devolve-o");
    eq(r.cyclesUsed, 2, "…cyclesUsed=2");
    eq(pulls, 2, "…não chega a fazer o 3º ciclo (pára ao encontrar)");
  }

  // -- decidePostClaim --
  eq(decidePostClaim(null), { action: "process" }, "lock livre (acquireLock devolveu null) → processar");
  {
    const decisao = decidePostClaim("Outro pipeline já corre (pid=123, kind=daily-pipeline, started=...)");
    check(decisao.action === "fail-lock-busy", "lock ocupado → fail-lock-busy, não 'process'");
    if (decisao.action === "fail-lock-busy") {
      check(decisao.message.length > 0, "…mensagem não vazia (vai para failSyncRequest)");
    }
  }
}

// ═════════════════════════════════════════════════════════════════════
// M — Timeout do cliente HTTP para long-poll (`syncNowLongPollTimeoutMs`)
// ═════════════════════════════════════════════════════════════════════
console.log("\n== M. syncNowLongPollTimeoutMs (agent/src/http-client.ts) ==");
{
  eq(syncNowLongPollTimeoutMs(18), 28_000, "waitSeconds=18 → timeout do cliente 28s (18s + 10s de folga)");
  eq(syncNowLongPollTimeoutMs(0), 10_000, "waitSeconds=0 → ainda assim 10s de folga (nunca 0)");
  eq(syncNowLongPollTimeoutMs(-5), 10_000, "waitSeconds negativo tratado como 0 (nunca timeout negativo)");
  check(
    syncNowLongPollTimeoutMs(18) > 18_000,
    "timeout do cliente é sempre MAIOR que waitSeconds*1000 — nunca aborta antes do servidor poder responder",
  );
}

// ═════════════════════════════════════════════════════════════════════
// N — Correcção 3: o long-poll está de facto ligado (rota + agent),
//     e o lock só é adquirido DEPOIS do claim, nunca durante a espera.
// ═════════════════════════════════════════════════════════════════════
console.log("\n== N. Wiring do long-poll (rota + agent) e ordem lock-depois-do-claim ==");
{
  const pendingRoute = src("app/api/outbox/v1/sync-requests/pending/route.ts");
  check(pendingRoute.includes('export const runtime = "nodejs"'), "rota pending declara runtime nodejs");
  check(pendingRoute.includes('export const dynamic = "force-dynamic"'), "rota pending declara dynamic force-dynamic");
  check(
    pendingRoute.includes("longPollClaim") && pendingRoute.includes("clampWaitSeconds"),
    "rota pending usa longPollClaim + clampWaitSeconds de lib/sync-request/longpoll",
  );
  check(
    pendingRoute.includes('from "@/lib/sync-request/longpoll"'),
    "rota pending importa de lib/sync-request/longpoll (núcleo partilhado/testável)",
  );

  const httpClient = src("agent/src/http-client.ts");
  check(
    httpClient.includes("waitSeconds") && httpClient.includes("syncNowLongPollTimeoutMs"),
    "http-client.ts: pullPendingSyncRequests aceita waitSeconds e usa syncNowLongPollTimeoutMs",
  );

  const syncNowSrc = src("agent/src/commands/sync-now.ts");
  check(
    syncNowSrc.includes("SYNC_NOW_LONGPOLL_CYCLES") && syncNowSrc.includes("SYNC_NOW_LONGPOLL_WAIT_SECONDS"),
    "sync-now.ts declara as constantes de ciclos/duração do long-poll",
  );
  check(syncNowSrc.includes("runLongPollCycles"), "sync-now.ts chama runLongPollCycles");
  check(syncNowSrc.includes("decidePostClaim"), "sync-now.ts usa decidePostClaim para decidir com o lock ocupado");

  // Ordem: dentro de syncNow(), a CHAMADA a runLongPollCycles(...) tem de
  // vir ANTES da CHAMADA a acquireLock() — nunca lock antes de reclamar.
  const bodyStart = syncNowSrc.indexOf("export async function syncNow");
  check(bodyStart !== -1, "encontra o corpo de syncNow() para verificar a ordem");
  const body = syncNowSrc.slice(bodyStart);
  const idxCyclesCall = body.indexOf("runLongPollCycles(");
  // A definição de acquireLock() está ANTES de "export async function
  // syncNow" no ficheiro, logo fora de `body` — o único "acquireLock()"
  // que sobra aqui dentro é a chamada real.
  const idxLockCall = body.indexOf("acquireLock()");
  check(
    idxCyclesCall !== -1 && idxLockCall !== -1 && idxCyclesCall < idxLockCall,
    "dentro de syncNow(): a chamada a runLongPollCycles() precede a chamada a acquireLock() — lock só depois do claim",
    `idxCyclesCall=${idxCyclesCall}, idxLockCall=${idxLockCall}`,
  );

  check(
    /fail-lock-busy[\s\S]{0,300}failSyncRequest/.test(syncNowSrc),
    "quando decidePostClaim devolve fail-lock-busy, o código chama failSyncRequest de imediato (não fica pendurado)",
  );
  check(
    !/acquireLock\(\)[\s\S]{0,400}runLongPollCycles/.test(body),
    "acquireLock() não é chamado antes de runLongPollCycles em lado nenhum do corpo (sem call-site invertido)",
  );
}

// ═════════════════════════════════════════════════════════════════════
// O — UI: textos honestos, sem falar em "próximo poll"
// ═════════════════════════════════════════════════════════════════════
console.log('\n== O. UI — textos deixam de falar em "próximo poll" ==');
{
  const widget = src("components/stock/sync-now-widget.tsx");
  check(!/próximo poll/.test(widget), "sync-now-widget.tsx já não menciona 'próximo poll'");
  check(widget.includes("A solicitar actualização"), "widget: texto de PENDENTE");
  check(widget.includes("Farmácia a sincronizar"), "widget: texto de EM_CURSO");
  check(widget.includes("Atualizado agora"), "widget: texto de CONCLUIDO");
  check(
    /garantia instantânea/.test(widget),
    "widget continua honesto: 'muito mais rápido', não 'instantâneo garantido'",
  );

  const estado = src("lib/sync-request/estado.ts");
  check(
    !/assim que o agent fizer o próximo poll/.test(estado),
    "estado.ts já não usa a redacção antiga (poll dedicado a minutos)",
  );

  const syncActions = src("app/stock/sync-actions.ts");
  check(
    !/assim que o agent fizer o próximo poll dedicado/.test(syncActions),
    "sync-actions.ts já não usa a redacção antiga",
  );
}
}

// ═════════════════════════════════════════════════════════════════════
correrTestesAssincronos().then(() => {
  console.log(`\n${ko === 0 ? "PASSOU" : "FALHOU"} — ${ok} OK, ${ko} falhas\n`);
  process.exit(ko === 0 ? 0 : 1);
});
