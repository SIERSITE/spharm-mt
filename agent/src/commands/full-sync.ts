/**
 * agent/src/commands/full-sync.ts
 *
 * Sincronização COMPLETA inicial de uma farmácia/BD SPharm → SaaS, numa
 * única execução, idempotente e retomável por fase. Pensado para onboarding
 * de novos grupos/farmácias e reutilizável tal-e-qual no próximo grupo.
 *
 * Fases (por ordem; fornecedores SEMPRE antes de compras/devoluções porque
 * a agregação resolve fornecedorId via FornecedorErpRef):
 *
 *   1. produtos                (in-proc: runProductsPipeline)
 *   2. stock                   (in-proc: runStockPipeline)
 *   3. vendas                  (in-proc: runSalesPipeline, usa --from/--to)
 *   4. fornecedores            (subprocess: fornecedores-upload / -dry-run)
 *   5. compras                 (subprocess: compras-upload / -dry-run)
 *   6. devolucoes-fornecedor   (subprocess: devolucoes-fornecedor-upload / -dry-run)
 *   7. agg-vendamensal         (SaaS: aggregate-month por mês em [from,to])
 *   8. agg-compras             (SaaS: aggregate-compras, automático se staging OK)
 *   9. agg-devolucoes          (SaaS: aggregate-devolucoes; NOT_IMPLEMENTED se
 *                               o endpoint não existir no deploy SaaS)
 *  10. movimentos              (subprocess: stocksmov-upload / -dry-run, usa --from/--to)
 *  11. relatório final         (sempre — nenhuma fase desaparece)
 *
 * ── Fase 10 (movimentos) ──────────────────────────────────────────────
 *
 * Sem ela, um onboarding terminava 9/9 com o extrato de artigo VAZIO: as
 * fases 1-6 alimentam agregados (Venda, Compra, Devolucao) e nenhuma
 * escreve em `MovimentoArtigo`. A farmácia via KPIs certos e um extrato
 * em branco.
 *
 * O que ingere: TODAS as origens de `dbo.StocksMov` — vendas, compras,
 * devoluções, reservas e acertos —, uma linha por `StocksMovID`. Isto
 * NÃO duplica as fases 3/5/6: `Venda`/`Compra`/`Devolucao` são agregados
 * por produto-dia-fornecedor e servem KPIs; `MovimentoArtigo` é o
 * extrato movimento-a-movimento. Tabelas diferentes, propósitos
 * diferentes, e a fase nova não re-corre nenhum dos pipelines deles.
 *
 * Porque é ÚLTIMA: é a fase mais pesada (centenas de milhares de linhas
 * numa janela de anos) e as agregações 7-9 não lêem `MovimentoArtigo`.
 * Com halt-on-error, tê-la mais cedo faria uma falha no histórico de
 * movimentos impedir agregações independentes — e obrigaria a
 * re-corrê-las na retoma. Assim, uma falha aqui deixa as nove primeiras
 * DONE e a corrida seguinte retoma só esta.
 *
 * Não confundir com a fase 2 (stock): essa é o SNAPSHOT de existências
 * actuais (`dbo.Stocks`), não tem janela temporal e continua intocada.
 * `StocksMov` é o histórico de movimento. São ficheiros, comandos e
 * tabelas distintos — e é para ficarem distintos que a fase 2 não recebe
 * `--from/--to` e a 10 recebe.
 *
 * Os movimentos internos (MOV_INTERNO) chegam como ACERTO_STOCK: o
 * endpoint re-classifica server-side com `lib/movimento-classifier`, que
 * desde rev60 decide só pela origem (FK).
 *
 * Idempotência: cada fase é idempotente (upserts / agregações scoped).
 * Retoma: o estado por-fase fica em `run/full-sync-state.json` keyed por
 * (farmaciaId, from, to). Re-correr salta fases DONE excepto com `--force`.
 * Uma fase que falha PÁRA o pipeline (halt-on-error) e fica registada como
 * FAILED — corrige-se e re-corre-se (retoma a partir dela). Fases não
 * implementadas aparecem como NOT_IMPLEMENTED no relatório, não somem.
 *
 * Dry-run (`--dry-run`, ou via run-full-sync-dry-run.bat): NADA É ESCRITO,
 * mas não é verdade que não haja pedidos ao SaaS. Ser exacto aqui importa:
 *
 *   · fases 1-6 e 10 (ingest) — lêem o ERP e NÃO fazem POST nenhum;
 *   · fases 7-9 (agregações) — FAZEM POST aos endpoints de agregação com
 *     `write=false`. O servidor calcula e devolve as contagens sem gravar.
 *
 * Ou seja: o dry-run contacta o SaaS e precisa dos endpoints acessíveis.
 * Um 404 nas fases 7-9 aparece no dry-run tal como apareceria no upload.
 * O dry-run não persiste estado (corre sempre todas as fases).
 *
 * Flags: --from YYYY-MM-DD --to YYYY-MM-DD (obrigatórios)
 *        --dry-run  --force  --only <fase>  --allow-unknowns  --allow-orphans
 *
 * NÃO toca dashboard / export-orders / outbox workers.
 */

import { parseArgs } from "node:util";
import { promises as fs } from "node:fs";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { loadConfig, type AgentConfig } from "../config.js";
import { withPool } from "../sql-client.js";
import { SaasClient, SaasApiError } from "../http-client.js";
import { parseDateArg } from "./probe-helpers.js";
import { diaAindaAberto, hojeNaFarmacia, ontemNaFarmacia, FUSO_FARMACIA } from "../janela.js";
import {
  runProductsPipeline,
  runStockPipeline,
  runSalesPipeline,
  resolveFarmaciaId,
  renderTotals,
} from "./bootstrap-upload.js";

const RULE = "─".repeat(70);
const DOUBLE_RULE = "═".repeat(70);
const STALE_LOCK_MS = 6 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────

type Args = {
  from?: string;
  to?: string;
  dryRun: boolean;
  force: boolean;
  only?: string;
  incluirHoje: boolean;
  allowUnknowns: boolean;
  allowOrphans: boolean;
  help: boolean;
};

function parseCmdArgs(): Args {
  const raw = parseArgs({
    args: process.argv.slice(3),
    options: {
      from: { type: "string" },
      to: { type: "string" },
      "dry-run": { type: "boolean" },
      force: { type: "boolean" },
      only: { type: "string" },
      "incluir-hoje": { type: "boolean" },
      "allow-unknowns": { type: "boolean" },
      "allow-orphans": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });
  return {
    from: typeof raw.values.from === "string" ? raw.values.from : undefined,
    to: typeof raw.values.to === "string" ? raw.values.to : undefined,
    dryRun: raw.values["dry-run"] === true,
    force: raw.values.force === true,
    only: typeof raw.values.only === "string" ? raw.values.only : undefined,
    incluirHoje: raw.values["incluir-hoje"] === true,
    allowUnknowns: raw.values["allow-unknowns"] === true,
    allowOrphans: raw.values["allow-orphans"] === true,
    help: raw.values.help === true,
  };
}

function printHelp(): void {
  console.log("Uso: full-sync --from YYYY-MM-DD --to YYYY-MM-DD [flags]");
  console.log("");
  console.log("Sincronização completa inicial (onboarding). Idempotente, retomável por fase.");
  console.log("");
  console.log("Flags:");
  console.log("  --from / --to        intervalo de vendas/compras/devoluções + agregações (obrigatórios)");
  console.log("  --dry-run            não escreve nada (preview ingest + agregações write=false)");
  console.log("  --force              re-corre fases já DONE");
  console.log("  --incluir-hoje       permite --to = hoje (dia AINDA ABERTO — parcial)");
  // Gerado a partir de PHASE_ORDER: uma fase nova aparece aqui sozinha,
  // em vez de ficar por listar num texto que ninguém se lembra de rever.
  console.log(`  --only <fase>        corre só uma fase:`);
  console.log(`                       ${PHASE_ORDER.map((p) => p.id).join("|")}`);
  console.log("  --allow-unknowns     agregação VendaMensal não bloqueia em TipoDoc UNKNOWN");
  console.log("  --allow-orphans      agregação VendaMensal não bloqueia em orphans");
  console.log("");
  console.log("Estado/retoma: run/full-sync-state.json (por farmácia+janela).");
}

// ─────────────────────────────────────────────────────────────────────
// Lockfile (partilhado com daily-pipeline → mutuamente exclusivos)
// ─────────────────────────────────────────────────────────────────────

function lockFilePath(): string {
  return path.join(process.cwd(), "run", "pipeline.lock");
}

function acquireLock(force: boolean): void {
  const lock = lockFilePath();
  mkdirSync(path.dirname(lock), { recursive: true });
  if (existsSync(lock)) {
    try {
      const data = JSON.parse(readFileSync(lock, "utf8")) as { startedAt?: string; pid?: number; kind?: string };
      const ageMs = Date.now() - new Date(data.startedAt ?? 0).getTime();
      if (!force && Number.isFinite(ageMs) && ageMs >= 0 && ageMs < STALE_LOCK_MS) {
        throw new Error(
          `Outro pipeline já corre (pid=${data.pid}, kind=${data.kind}, started=${data.startedAt}). Usa --force ou aguarda.`
        );
      }
      console.warn("⚠ Lockfile stale ou --force — a reclamar.");
    } catch (err) {
      if (!force) throw err instanceof Error ? err : new Error(String(err));
    }
  }
  writeFileSync(
    lock,
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), kind: "full-sync" }, null, 2) + "\n",
    "utf8"
  );
}

function releaseLock(): void {
  const lock = lockFilePath();
  if (existsSync(lock)) {
    try {
      unlinkSync(lock);
    } catch {
      /* ignore */
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// State file (resume)
// ─────────────────────────────────────────────────────────────────────

type PersistedStatus = "DONE" | "FAILED";
type StateFile = {
  version: 1;
  key: string;
  phases: Record<string, PersistedStatus>;
  updatedAt: string;
};

function stateFilePath(): string {
  return path.join(process.cwd(), "run", "full-sync-state.json");
}

function loadState(key: string): StateFile {
  const p = stateFilePath();
  if (existsSync(p)) {
    try {
      const s = JSON.parse(readFileSync(p, "utf8")) as StateFile;
      if (s.key === key && s.version === 1 && s.phases) return s;
    } catch {
      /* corrupted → reset */
    }
  }
  return { version: 1, key, phases: {}, updatedAt: new Date().toISOString() };
}

function persistState(state: StateFile): void {
  mkdirSync(path.dirname(stateFilePath()), { recursive: true });
  state.updatedAt = new Date().toISOString();
  writeFileSync(stateFilePath(), JSON.stringify(state, null, 2) + "\n", "utf8");
}

// ─────────────────────────────────────────────────────────────────────
// Subprocess: invoca um comando-irmão do agent (fornecedores/compras/devol.)
// ─────────────────────────────────────────────────────────────────────

function spawnAgentCommand(cmd: string, extraArgs: string[]): number {
  const entry = process.argv[1] ?? "";
  const isTs = entry.endsWith(".ts");
  // Produção: `node agent.cjs <cmd>`. Dev (tsx): `node --import tsx cli.ts <cmd>`.
  const nodeArgs = isTs
    ? ["--import", "tsx", entry, cmd, ...extraArgs]
    : [entry, cmd, ...extraArgs];
  const r = spawnSync(process.execPath, nodeArgs, {
    stdio: "inherit",
    env: process.env,
  });
  if (r.error) {
    console.error(`✗ spawn ${cmd} falhou: ${r.error.message}`);
    return 1;
  }
  return typeof r.status === "number" ? r.status : 1;
}

// ─────────────────────────────────────────────────────────────────────
// Meses no intervalo [from, to] (YYYY-MM)
// ─────────────────────────────────────────────────────────────────────

function monthsInRange(from: string, to: string): string[] {
  const [fy, fm] = from.split("-").map((x) => parseInt(x, 10));
  const [ty, tm] = to.split("-").map((x) => parseInt(x, 10));
  const out: string[] = [];
  let y = fy;
  let m = fm;
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// Modelo de fase + execução
// ─────────────────────────────────────────────────────────────────────

export type PhaseId =
  | "produtos"
  | "stock"
  | "vendas"
  | "fornecedores"
  | "compras"
  | "devolucoes"
  | "movimentos"
  | "agg-vendamensal"
  | "agg-compras"
  | "agg-devolucoes";

type RunStatus = "DONE" | "FAILED" | "NOT_IMPLEMENTED" | "BLOCKED";
type PhaseRun = { status: RunStatus; metric?: string; error?: string };

type ReportRow = {
  n: number;
  id: PhaseId;
  label: string;
  status: RunStatus | "SKIPPED";
  detail: string;
};

export const PHASE_ORDER: Array<{ id: PhaseId; label: string }> = [
  { id: "produtos", label: "produtos" },
  { id: "stock", label: "stock (snapshot)" },
  { id: "vendas", label: "vendas" },
  { id: "fornecedores", label: "fornecedores" },
  { id: "compras", label: "compras (staging)" },
  { id: "devolucoes", label: "devoluções (staging)" },
  { id: "agg-vendamensal", label: "agg VendaMensal" },
  { id: "agg-compras", label: "agg Compra" },
  { id: "agg-devolucoes", label: "agg Devolucao" },
  // ÚLTIMA, e a posição é deliberada. É a fase mais pesada — centenas de
  // milhares de linhas numa janela de anos — logo a mais provável de
  // falhar ou de ser interrompida. As três agregações não lêem
  // `MovimentoArtigo`, portanto não dependem dela; pô-la antes fazia com
  // que o halt-on-error impedisse agregações que correriam bem.
  //
  // Assim, uma falha aqui deixa as nove primeiras DONE no ficheiro de
  // estado e a retoma volta a correr só esta.
  { id: "movimentos", label: "movimentos (StocksMov)" },
];

// ─────────────────────────────────────────────────────────────────────
// Decisão de correr / saltar uma fase
// ─────────────────────────────────────────────────────────────────────

export type ContextoDecisao = {
  /** `--only <fase>`, se dado. */
  only?: string;
  /** Uma fase anterior falhou (halt-on-error). */
  halted: boolean;
  dryRun: boolean;
  force: boolean;
  /** O que está em `run/full-sync-state.json` para esta fase. */
  estadoPersistido?: PersistedStatus;
};

export type DecisaoFase =
  | { correr: true }
  | { correr: false; motivo: string };

/**
 * Se esta fase corre, e porquê não quando não corre.
 *
 * Vive fora do `execPhase` para poder ser testada: a retoma é a parte do
 * full-sync que mais custa a verificar à mão, porque exige um ficheiro
 * de estado, uma corrida interrompida e outra a seguir. Como função
 * pura, cada regra é uma linha de teste.
 *
 * A ordem das regras é significativa e não é arbitrária:
 *
 *   1. `--only` é avaliado primeiro: tudo o que não é a fase pedida sai
 *      já aqui. Na prática isso faz `halted` inalcançável durante um
 *      `--only`, porque as outras fases nunca chegam a correr e
 *      portanto nunca falham.
 *   2. `halted` vem antes do estado persistido: depois de uma falha, as
 *      seguintes não correm nem sequer são consultadas.
 *   3. DONE salta; FAILED NÃO salta. É isto a retoma — re-correr pega
 *      na fase que ficou a meio, e as anteriores já concluídas não se
 *      repetem.
 *   4. O dry-run ignora o estado por completo: nunca o lê nem o escreve,
 *      portanto corre sempre tudo. Um preview que saltasse fases não
 *      seria um preview.
 */
export function decidirFase(id: PhaseId, ctx: ContextoDecisao): DecisaoFase {
  if (ctx.only && ctx.only !== id) {
    return { correr: false, motivo: "--only outra fase" };
  }
  if (ctx.halted) {
    return { correr: false, motivo: "fase anterior falhou" };
  }
  if (!ctx.dryRun && !ctx.force && ctx.estadoPersistido === "DONE") {
    return { correr: false, motivo: "já concluída (usa --force)" };
  }
  return { correr: true };
}

// ─────────────────────────────────────────────────────────────────────
// Entrypoint
// ─────────────────────────────────────────────────────────────────────

export async function fullSync(): Promise<number> {
  let args: Args;
  try {
    args = parseCmdArgs();
  } catch (err) {
    console.error("✗ Argumentos inválidos:", err instanceof Error ? err.message : err);
    printHelp();
    return 1;
  }
  if (args.help) {
    printHelp();
    return 0;
  }
  if (!args.from || !args.to) {
    console.error("✗ --from e --to são obrigatórios (YYYY-MM-DD).");
    printHelp();
    return 1;
  }
  let from: string;
  let to: string;
  try {
    from = parseDateArg("--from", args.from) as string;
    to = parseDateArg("--to", args.to) as string;
  } catch (err) {
    console.error("✗", err instanceof Error ? err.message : String(err));
    return 1;
  }
  if (from > to) {
    console.error(`✗ --from (${from}) é posterior a --to (${to}).`);
    return 1;
  }
  // O dia de hoje ainda está aberto: a farmácia continua a vender. Um
  // histórico que o inclua grava um dia parcial, e a única forma de o
  // corrigir é reenviá-lo depois de fechado — o que ninguém se lembra de
  // fazer, porque a corrida terminou com sucesso.
  if (diaAindaAberto(to) && !args.incluirHoje) {
    console.error(`✗ --to (${to}) inclui o dia de HOJE (${hojeNaFarmacia()} em ${FUSO_FARMACIA}), que ainda não fechou.`);
    console.error(`  O histórico ficaria com um dia parcial.`);
    console.error(`  Usa --to ${ontemNaFarmacia()} (último dia completo),`);
    console.error(`  ou --incluir-hoje se sabes o que estás a fazer.`);
    return 1;
  }
  if (diaAindaAberto(to) && args.incluirHoje) {
    console.warn(`⚠ --incluir-hoje: ${to} ainda está aberto. As vendas de hoje ficam INCOMPLETAS`);
    console.warn(`  e só ficam certas reenviando este dia depois de fechar.`);
  }
  if (args.only && !PHASE_ORDER.some((p) => p.id === args.only)) {
    console.error(`✗ --only "${args.only}" inválido. Fases: ${PHASE_ORDER.map((p) => p.id).join(", ")}`);
    return 1;
  }

  let cfg: AgentConfig;
  try {
    cfg = loadConfig("both");
  } catch (err) {
    console.error("✗ Config inválida:", err instanceof Error ? err.message : String(err));
    return 1;
  }
  if (!cfg.farmacia) {
    console.error("✗ SPHARMMT_FARMACIA não definido (cuid ou nome da farmácia).");
    return 1;
  }

  const client = new SaasClient(cfg);
  let farmaciaId: string;
  try {
    farmaciaId = await resolveFarmaciaId(client, cfg.farmacia);
  } catch (err) {
    console.error("✗ Resolução de farmácia falhou:", err instanceof Error ? err.message : String(err));
    return 1;
  }

  const { dryRun } = args;
  const stateKey = `${farmaciaId}|${from}|${to}`;
  const state = dryRun ? null : loadState(stateKey);

  const t0 = Date.now();
  console.log(DOUBLE_RULE);
  console.log(`full-sync — onboarding ${dryRun ? "(DRY-RUN)" : "(UPLOAD)"}`);
  console.log(DOUBLE_RULE);
  console.log(`SaaS endpoint     : ${cfg.saasEndpoint}`);
  console.log(`Tenant slug       : ${cfg.tenantSlug}`);
  console.log(`Farmácia (resolved): ${farmaciaId}`);
  console.log(`ERP database      : ${cfg.sqlDatabase}@${cfg.sqlHost}:${cfg.sqlPort}`);
  console.log(`Intervalo         : ${from} → ${to}`);
  console.log(`Modo              : ${dryRun ? "dry-run (nada escrito)" : "upload (idempotente)"}`);
  console.log(`Force             : ${args.force ? "sim" : "não"}`);
  if (args.only) console.log(`Only              : ${args.only}`);
  console.log(`allow-unknowns    : ${args.allowUnknowns ? "sim" : "não"}`);
  console.log(`allow-orphans     : ${args.allowOrphans ? "sim" : "não"}`);
  console.log("");

  const report: ReportRow[] = [];
  let halted = false;
  let lockAcquired = false;

  const indexOf = (id: PhaseId) => PHASE_ORDER.findIndex((p) => p.id === id) + 1;

  /** Executa uma fase respeitando skip/halt/state. */
  async function execPhase(id: PhaseId, runner: () => Promise<PhaseRun>): Promise<void> {
    const meta = PHASE_ORDER.find((p) => p.id === id)!;
    const n = indexOf(id);

    const decisao = decidirFase(id, {
      only: args.only,
      halted,
      dryRun,
      force: args.force,
      estadoPersistido: state?.phases[id],
    });
    if (!decisao.correr) {
      report.push({ n, id, label: meta.label, status: "SKIPPED", detail: decisao.motivo });
      if (decisao.motivo.startsWith("já concluída")) {
        console.log(`⏭ Fase ${n}/${PHASE_ORDER.length}: ${meta.label} — SKIPPED (já DONE)`);
      }
      return;
    }

    console.log(RULE);
    console.log(`▶ Fase ${n}/${PHASE_ORDER.length}: ${meta.label}`);
    console.log(RULE);
    const tp = Date.now();
    try {
      const r = await runner();
      const secs = ((Date.now() - tp) / 1000).toFixed(1);
      const detail = `${r.metric ?? ""}${r.metric ? " · " : ""}${secs}s`;
      report.push({ n, id, label: meta.label, status: r.status, detail });
      console.log(`  → ${r.status}${r.metric ? `: ${r.metric}` : ""} (${secs}s)`);
      if (r.status === "FAILED") {
        halted = true;
        if (state) {
          state.phases[id] = "FAILED";
          persistState(state);
        }
      } else if (r.status === "DONE" && state) {
        state.phases[id] = "DONE";
        persistState(state);
      }
      // NOT_IMPLEMENTED / BLOCKED não param o pipeline nem persistem DONE.
    } catch (err) {
      const msg = err instanceof SaasApiError ? `${err.method} ${err.path} → HTTP ${err.statusCode}: ${err.bodySnippet ?? ""}` : err instanceof Error ? err.message : String(err);
      const secs = ((Date.now() - tp) / 1000).toFixed(1);
      report.push({ n, id, label: meta.label, status: "FAILED", detail: `${msg} · ${secs}s` });
      console.error(`  ✗ FAILED: ${msg}`);
      halted = true;
      if (state) {
        state.phases[id] = "FAILED";
        persistState(state);
      }
    }
    console.log("");
  }

  try {
    acquireLock(args.force);
    lockAcquired = true;

    // ── Fases 1-3: in-process (partilham um pool SQL) ──
    await withPool(cfg, async (pool) => {
      await execPhase("produtos", async () => {
        // A janela histórica é passada aqui e SÓ aqui. É o que faz o
        // catálogo do onboarding incluir os artigos que se mexeram no
        // período, mesmo que hoje estejam retirados — sem isso, um
        // medicamento vendido em 2024 e retirado em 2026 nunca entra e
        // as vendas dele ficam órfãs para sempre.
        //
        // O `daily-sync`, o `products-upload` e o `bootstrap-upload`
        // não a passam e mantêm o filtro de catálogo activo, que é o
        // correcto para eles: um artigo retirado não tem vendas novas.
        const t = await runProductsPipeline(pool, client, farmaciaId, {
          dryRun,
          janelaHistorica: { from, to },
        });
        renderTotals("produtos", t);
        return { status: t.errors > 0 ? "FAILED" : "DONE", metric: `read=${t.read} upserted=${t.upserted} errors=${t.errors}` };
      });
      await execPhase("stock", async () => {
        const t = await runStockPipeline(pool, client, farmaciaId, { dryRun });
        renderTotals("stock", t);
        return { status: t.errors > 0 ? "FAILED" : "DONE", metric: `read=${t.read} upserted=${t.upserted} errors=${t.errors}` };
      });
      await execPhase("vendas", async () => {
        const t = await runSalesPipeline(pool, client, farmaciaId, from, to, { dryRun });
        renderTotals("vendas", t);
        return { status: t.errors > 0 ? "FAILED" : "DONE", metric: `read=${t.read} upserted=${t.upserted} errors=${t.errors}` };
      });
    });

    // ── Fases 4-6: subprocess dos comandos provados ──
    await execPhase("fornecedores", async () => {
      const code = spawnAgentCommand(dryRun ? "fornecedores-dry-run" : "fornecedores-upload", []);
      return { status: code === 0 ? "DONE" : "FAILED", metric: `exit=${code}` };
    });
    await execPhase("compras", async () => {
      const code = spawnAgentCommand(dryRun ? "compras-dry-run" : "compras-upload", ["--from", from, "--to", to]);
      return { status: code === 0 ? "DONE" : "FAILED", metric: `exit=${code}` };
    });
    await execPhase("devolucoes", async () => {
      const code = spawnAgentCommand(
        dryRun ? "devolucoes-fornecedor-dry-run" : "devolucoes-fornecedor-upload",
        ["--from", from, "--to", to]
      );
      return { status: code === 0 ? "DONE" : "FAILED", metric: `exit=${code}` };
    });

    // ── Fase 7: agregação VendaMensal (por mês) ──
    await execPhase("agg-vendamensal", async () => {
      const months = monthsInRange(from, to);
      let rows = 0;
      for (const m of months) {
        const resp = await client.pipelineAggregateMonth(
          { month: m, write: !dryRun, allowUnknowns: args.allowUnknowns, allowOrphans: args.allowOrphans },
          120_000
        );
        rows += resp.rowsInserted ?? 0;
      }
      return { status: "DONE", metric: `${months.length} mes(es)${dryRun ? " (preview)" : `, rows=${rows}`}` };
    });

    // ── Fase 8: agregação Compra (automática se staging OK) ──
    await execPhase("agg-compras", async () => {
      const r = await client.pipelineAggregateCompras({ farmaciaId, from, to, write: !dryRun }, 120_000);
      const metric = dryRun
        ? `groups=${r.candidateGroups} val=${r.projectedValorTotal} orphPrd=${r.orphanProducts.count} orphFn=${r.orphanFornecedores.count}`
        : `created=${r.created ?? 0} updated=${r.updated ?? 0} orphFn=${r.orphanFornecedores.count}`;
      return { status: "DONE", metric };
    });

    // ── Fase 9: agregação Devolucao (NOT_IMPLEMENTED se endpoint ausente) ──
    await execPhase("agg-devolucoes", async () => {
      try {
        const r = await client.pipelineAggregateDevolucoes({ farmaciaId, from, to, write: !dryRun }, 120_000);
        const metric = dryRun
          ? `lines=${r.candidateLines} recebida=${r.projectedQuantidadeRecebida} enviada=${r.projectedQuantidadeEnviada}`
          : `created=${r.created ?? 0} updated=${r.updated ?? 0}`;
        return { status: "DONE", metric };
      } catch (err) {
        if (err instanceof SaasApiError && err.statusCode === 404) {
          return {
            status: "NOT_IMPLEMENTED",
            metric: "endpoint /aggregate-devolucoes ausente no SaaS (deploy mais antigo) — redeploy para activar",
          };
        }
        throw err;
      }
    });
    // ── Fase 10: movimentos canónicos (StocksMov → MovimentoArtigo) ──
    //
    // ÚLTIMA de propósito: é a fase mais pesada e as agregações 7-9 não
    // lêem `MovimentoArtigo`. Com halt-on-error, tê-la antes fazia com
    // que uma falha no histórico de movimentos impedisse agregações que
    // correriam bem — e obrigasse a re-corrê-las na retoma.
    //
    // MESMA janela das fases 3/5/6, passada verbatim. O `stocksmov`
    // aplica-lhe o contrato temporal de `janela.ts` (meio-aberta, --to
    // inclusivo) tal como os outros pipelines históricos, portanto todas
    // as fases históricas cobrem exactamente o mesmo intervalo.
    //
    // Idempotência: UPSERT por (farmaciaId, externalMovId=StocksMovID).
    // Re-correr a mesma janela actualiza, não duplica — que é o que
    // permite retomar esta fase depois de uma falha a meio sem limpar
    // nada primeiro.
    await execPhase("movimentos", async () => {
      const code = spawnAgentCommand(dryRun ? "stocksmov-dry-run" : "stocksmov-upload", [
        "--from",
        from,
        "--to",
        to,
      ]);
      // O dry-run do stocksmov lê UM chunk de 50k linhas e mostra a
      // distribuição; não percorre a janela toda. Dizê-lo na métrica
      // evita que um preview curto passe por cobertura completa.
      const metric = dryRun ? `exit=${code} (preview: 1º chunk, até 50k linhas)` : `exit=${code}`;
      return { status: code === 0 ? "DONE" : "FAILED", metric };
    });

  } catch (err) {
    console.error("✗ Erro inesperado no full-sync:", err instanceof Error ? err.message : String(err));
    halted = true;
  } finally {
    if (lockAcquired) releaseLock();
  }

  // ── Fase 11 (relatório final) ──
  printReport(report, { dryRun, from, to, farmaciaId, wallMs: Date.now() - t0 });

  const anyFailed = report.some((r) => r.status === "FAILED");
  return anyFailed ? 1 : 0;
}

function printReport(
  report: ReportRow[],
  ctx: { dryRun: boolean; from: string; to: string; farmaciaId: string; wallMs: number }
): void {
  console.log(DOUBLE_RULE);
  console.log(`RELATÓRIO FULL-SYNC ${ctx.dryRun ? "(DRY-RUN)" : "(UPLOAD)"}`);
  console.log(DOUBLE_RULE);
  console.log(`Farmácia: ${ctx.farmaciaId}   Janela: ${ctx.from} → ${ctx.to}`);
  console.log("");

  // Garantir que TODAS as fases aparecem (mesmo as nunca alcançadas).
  const byId = new Map(report.map((r) => [r.id, r]));
  const labelW = Math.max(...PHASE_ORDER.map((p) => p.label.length)) + 2;
  for (let i = 0; i < PHASE_ORDER.length; i++) {
    const meta = PHASE_ORDER[i];
    const r = byId.get(meta.id);
    const status = r?.status ?? "SKIPPED";
    const detail = r?.detail ?? "não alcançada";
    const icon =
      status === "DONE" ? "✓" : status === "FAILED" ? "✗" : status === "NOT_IMPLEMENTED" ? "□" : status === "BLOCKED" ? "▣" : "·";
    console.log(`  ${icon} ${String(i + 1).padStart(2)}. ${meta.label.padEnd(labelW)} ${status.padEnd(16)} ${detail}`);
  }
  console.log("");

  const failed = report.filter((r) => r.status === "FAILED");
  const notImpl = report.filter((r) => r.status === "NOT_IMPLEMENTED" || r.status === "BLOCKED");
  console.log(RULE);
  console.log(`Wall time: ${(ctx.wallMs / 1000).toFixed(1)}s`);
  if (failed.length > 0) {
    console.log(`✗ FALHOU na fase: ${failed.map((f) => f.label).join(", ")} — corrige e re-corre (retoma a partir daí).`);
  } else if (notImpl.length > 0) {
    console.log(`✓ Concluído com avisos: ${notImpl.map((f) => `${f.label}=${f.status}`).join(", ")}.`);
  } else {
    console.log(ctx.dryRun ? "✓ Dry-run concluído — nada escrito." : "✓ Full-sync concluído sem erros.");
  }
  console.log(DOUBLE_RULE);
}
