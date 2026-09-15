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

  check(
    src("agent/build.mjs").includes('process.env.AGENT_PACKAGE_REV ?? "93"'),
    "AGENT_REV avançou para 93 (Bloco E)",
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
    /schtasks \/Create/.test(docSyncNow) && /\/SC MINUTE \/MO 2/.test(docSyncNow),
    "docs/sync-now.md documenta o comando schtasks exacto, a 2 minutos",
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
console.log(`\n${ko === 0 ? "PASSOU" : "FALHOU"} — ${ok} OK, ${ko} falhas\n`);
process.exit(ko === 0 ? 0 : 1);
