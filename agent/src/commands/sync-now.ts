/**
 * agent/src/commands/sync-now.ts
 *
 * Bloco E — consumidor do botão "Sincronizar agora" em /stock.
 *
 * O SaaS não consegue invocar o agent directamente (comunicação
 * agent↔SaaS é 100% unidireccional — o agent só faz PULL agendado via
 * Task Scheduler). Um PROCESSO PERSISTENTE (`/SC ONSTART`) foi avaliado
 * e rejeitado: o lock `run/pipeline.lock` é adquirido uma vez por
 * invocação inteira, e um processo vivo há horas ficaria a segurá-lo
 * indefinidamente, bloqueando `daily-pipeline`/`full-sync`; e o Task
 * Scheduler não reinicia sozinho um processo persistente que morra.
 *
 * O desenho em vez disso: continua a ser uma corrida CURTA disparada
 * pelo Task Scheduler, mas cada corrida faz LONG-POLLING real —
 * `SYNC_NOW_LONGPOLL_CYCLES` ciclos sequenciais de
 * `GET .../pending?waitSeconds=N`, com o SERVIDOR a manter cada pedido
 * em espera (não resposta imediata) até `N` segundos ou até aparecer
 * um pedido. Isto dá latência de segundos (a duração de um hold), não
 * do intervalo entre corridas do Task Scheduler — sem processo
 * persistente nem reescrita do lock. Ver `agent/docs/sync-now.md`
 * secção 2 para a frequência do Task Scheduler escolhida e o número
 * concreto de latência pior-caso.
 *
 * ── Corpo LEVE, não o bootstrap ───────────────────────────────────────
 *
 * A primeira versão deste comando reaproveitava `runProductsPipeline` /
 * `runStockPipeline` / `resolveFarmaciaId` de `bootstrap-upload.ts` —
 * o caminho do onboarding/bootstrap completo, pensado para reler o
 * catálogo INTEIRO (produtos activos + históricos recuperados por
 * janela) e o stock corrente de TODOS os armazéns. Clicar em
 * "Sincronizar agora" não pode desencadear esse trabalho: é o oposto de
 * "agora".
 *
 * Este comando usa antes `runPipelineForDay` de `daily-sync-runner.ts`
 * — a MESMA leitura incremental do `daily-sync`/`daily-pipeline`, com
 * `scope: "products-stock"` para nunca correr o Pipeline 3 (vendas) — e
 * `date = hojeNaFarmacia()`: o que mudou desde a meia-noite, que é
 * exactamente o que motivou o clique. Um clique de manhã cedo sem
 * nenhum movimento ainda hoje devolve zeros — correcto, não um bug: o
 * ERP não tem nada de novo para dar.
 *
 * `resolveFarmaciaId` está duplicada aqui de propósito, não importada —
 * `daily-pipeline.ts` e `daily-sync.ts` já têm cada uma a sua própria
 * cópia (ver os cabeçalhos desses ficheiros); juntar-se à MESMA
 * duplicação em vez de importar de `bootstrap-upload.ts` é o que garante
 * que este ficheiro não arrasta a esse módulo pesado.
 *
 * Fluxo por invocação:
 *   1. Resolve a farmácia configurada (`SPHARMMT_FARMACIA`). SEM lock
 *      ainda — nada a proteger enquanto só se está a perguntar se há
 *      trabalho.
 *   2. Até `SYNC_NOW_LONGPOLL_CYCLES` ciclos sequenciais de
 *      `GET .../pending?waitSeconds=SYNC_NOW_LONGPOLL_WAIT_SECONDS`
 *      (`runLongPollCycles`) — cada um mantido em espera pelo SERVIDOR.
 *      Continua sem lock: os ciclos só perguntam, não escrevem
 *      produtos/stock.
 *   3. Nada reclamado em nenhum ciclo → sai com exit 0. O lock NUNCA
 *      foi tocado nesta corrida.
 *   4. Algo reclamado → SÓ AGORA adquire o lockfile
 *      (`run/pipeline.lock`, partilhado com `daily-pipeline`/
 *      `full-sync`). Se estiver ocupado (pipeline nocturno a correr),
 *      não espera por ele: chama `.../fail` de imediato (o pedido não
 *      fica pendurado até expirar aos 15 min) e sai com exit 2.
 *   5. Lock livre → corre o subconjunto LEVE — produtos (que já inclui
 *      fabricante + os outros campos do catálogo regulamentar, via
 *      `catalog-discovery.ts` partilhado) e stock (existências), ambos
 *      de HOJE. NUNCA vendas.
 *   6. POST .../ack com os três contadores, ou .../fail com o erro.
 *      `releaseLock()` no `finally` — só liberta o que só agora
 *      adquiriu.
 *
 * Timeout local: a corrida do passo 5 tem um limite de parede de
 * `SYNC_NOW_LOCAL_TIMEOUT_MS` — ver essa constante para o porquê do
 * valor. Um ERP preso não deixa este comando pendurado indefinidamente:
 * ao expirar, é tratado como qualquer outro erro (cai no mesmo
 * catch → `failSyncRequest` → exit 2). Isto é complementar, não
 * substituto, do `requestTimeout` já configurado por-pedido no pool SQL
 * (`ERP_SQLSERVER_REQUEST_TIMEOUT_MS`, default 30s) — aquele limita UMA
 * query; este limita a corrida inteira (múltiplos batches + POSTs).
 * Também complementar ao timeout do CLIENTE HTTP nos ciclos de
 * long-poll (`syncNowLongPollTimeoutMs` em `http-client.ts`) — aquele
 * cobre só a ESPERA por um pedido; este cobre o TRABALHO depois de o
 * reclamar.
 *
 * Exit codes:
 *   0  nada pendente após todos os ciclos de long-poll (lock nunca
 *      tocado), ou pedido reclamado, processado e acked com sucesso
 *   1  config inválida / erro a perguntar por pedidos (antes de
 *      reclamar nada)
 *   2  pedido reclamado mas: o lock local estava ocupado (fail enviado
 *      de imediato), ou a sincronização falhou/excedeu o timeout local
 *      (fail enviado ao SaaS)
 *
 * ── Retry ──────────────────────────────────────────────────────────
 *
 * Uma falha a MEIO (ex.: SQL Server local inacessível, ou lock ocupado
 * no momento da reclamação) chama `failSyncRequest` e o pedido fica
 * `FALHOU` — TERMINAL, sem reagendamento automático (mesma decisão do
 * endpoint `.../fail`, ver o cabeçalho de
 * `app/api/outbox/v1/sync-requests/[syncRequestId]/fail/route.ts`).
 * O utilizador vê o erro no widget e decide se carrega no botão outra
 * vez — o mutex já permite um novo pedido assim que este deixa de estar
 * activo. Não há retry automático do LADO DO AGENT para o MESMO pedido:
 * se `failSyncRequest` falhar também (ex.: rede caiu entre o erro local
 * e o POST), o pedido fica `EM_CURSO` preso, e a leitura lazy do SaaS
 * trata-o como `EXPIRADO` ao fim de `SYNC_REQUEST_TIMEOUT_MINUTOS_DEFAULT`
 * (15 min) — o mutex volta a libertar a farmácia sem intervenção manual.
 * Um pedido ainda `PENDENTE` (nunca chegou a ser reclamado, ex.: este
 * comando falhou ANTES do passo 2) fica candidato à PRÓXIMA corrida, que
 * o reclama normalmente — nenhuma acção extra necessária.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig, type AgentConfig } from "../config.js";
import { withPool } from "../sql-client.js";
import {
  SaasClient,
  SaasApiError,
  type SyncNowResultado,
  type PendingSyncRequest,
  type PendingSyncRequestsResponse,
} from "../http-client.js";
import { tableExists, listColumns } from "./probe-helpers.js";
import { hojeNaFarmacia } from "../janela.js";
import { runPipelineForDay, type DailySyncLogger } from "./daily-sync-runner.js";

// ─────────────────────────────────────────────────────────────────────
// Long-poll — quantos ciclos, quanto tempo cada um.
//
// 3 ciclos × 18s ≈ 54s de orçamento nesta corrida QUANDO NADA ESTÁ
// PENDENTE (o caso comum). Escolhido a par da frequência do Task
// Scheduler documentada em `agent/docs/sync-now.md` secção 2 — ali está
// o número concreto de latência pior-caso, não repetido aqui para não
// desalinhar os dois ficheiros.
//
// Quando ALGO está pendente, o primeiro ciclo que o apanha interrompe
// os restantes de imediato (`runLongPollCycles` pára ao primeiro
// `count > 0`) — a corrida não gasta os 54s inteiros nesse caso.
// ─────────────────────────────────────────────────────────────────────
export const SYNC_NOW_LONGPOLL_CYCLES = 3;
export const SYNC_NOW_LONGPOLL_WAIT_SECONDS = 18;

const RULE = "─".repeat(70);

// ─────────────────────────────────────────────────────────────────────
// Timeout local — parede de tempo para a corrida inteira (passo 4).
//
// 8 minutos, escolhido com folga face ao timeout SERVER-SIDE do pedido
// (`SYNC_REQUEST_TIMEOUT_MINUTOS_DEFAULT` = 15 min, em
// `lib/sync-request/estado.ts`): entre o clique e este comando reclamar
// o pedido, o pior caso agora é ~1 minuto (ver `agent/docs/sync-now.md`
// secção 2 — gap entre corridas do Task Scheduler, dominado pelos
// ciclos de long-poll, não pelo intervalo entre corridas), e depois do
// trabalho ainda falta o `ack`/`fail` viajar até ao SaaS. 8 min deixa
// essa espera + a chamada final com folga larga dentro dos 15 min
// totais, e continua generoso para o caso leve (produtos+stock de um
// só dia, não o histórico inteiro).
// ─────────────────────────────────────────────────────────────────────
const SYNC_NOW_LOCAL_TIMEOUT_MS = 8 * 60 * 1000;

class SyncNowTimeoutError extends Error {}

function withLocalTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new SyncNowTimeoutError(
          `${label} excedeu o timeout local de ${(ms / 60_000).toFixed(0)} min — ERP lento ou preso. ` +
            `A abortar sem esperar mais (ver SYNC_NOW_LOCAL_TIMEOUT_MS em sync-now.ts).`
        )
      );
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

// ─────────────────────────────────────────────────────────────────────
// Lockfile — MESMO ficheiro que daily-pipeline.ts/full-sync.ts.
//
// `run/pipeline.lock` já é o mutex de facto entre daily-pipeline e
// full-sync (cada um com a sua própria cópia local desta lógica — ver
// `daily-pipeline.ts::acquireLock` e `full-sync.ts::acquireLock`; a
// duplicação é deliberada e já existia antes deste bloco). sync-now
// junta-se ao mesmo ficheiro em vez de inventar um lock dedicado: um
// "sync agora" que corresse ao mesmo tempo que o pipeline nocturno
// tocaria as mesmas tabelas (produtos/stock) sem coordenação nenhuma.
// Continua coerente com o corpo leve desta revisão: o corpo mudou (para
// `runPipelineForDay`), a necessidade de serializar com o pipeline
// nocturno não — ambos escrevem produtos/stock da mesma farmácia.
//
// QUANDO é adquirido: só depois de `runLongPollCycles` devolver um
// pedido reclamado — nunca durante os ciclos de espera. Não há nada a
// proteger enquanto o comando só está a perguntar "há algo pendente?";
// adquirir o lock antes disso (o desenho anterior a este bloco)
// seguraria `run/pipeline.lock` pelos ~54s do orçamento de long-poll em
// TODAS as corridas, mesmo nas que não têm nada para processar —
// exactamente o cenário que se quer evitar (um `daily-pipeline` que
// precise do lock teria de esperar por um sync-now ocioso).
//
// A verificação de liveness por PID (via `tasklist`) é copiada de
// `daily-pipeline.ts::isPidAlive` — não apenas a idade do timestamp —
// porque um `daily-pipeline`/`full-sync` legítimo pode correr durante
// HORAS (full-sync histórico de uma farmácia grande). Um sync-now que
// só olhasse para a idade do lock e o considerasse "stale" ao fim de,
// digamos, 10 minutos sequestraria o lock de um pipeline nocturno ainda
// vivo. Só um PID confirmadamente morto (ou um lock preso há mais de
// `STALE_LOCK_MS`, rede de segurança final) é reclamado.
// ─────────────────────────────────────────────────────────────────────

const STALE_LOCK_MS = 6 * 60 * 60 * 1000; // 6h — mesma rede de segurança do daily-pipeline.

type LockFileContent = { pid: number; startedAt: string; kind: string };

function lockFilePath(): string {
  return path.join(process.cwd(), "run", "pipeline.lock");
}

function isPidAlive(pid: number): boolean | null {
  if (process.platform !== "win32") return null;
  if (!Number.isFinite(pid) || pid <= 0) return null;
  try {
    const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    if (r.status !== 0 || !r.stdout) return null;
    const out = r.stdout.trim();
    if (out.toLowerCase().includes("no tasks")) return false;
    return out.startsWith('"');
  } catch {
    return null;
  }
}

/** Devolve `null` se conseguiu adquirir; uma mensagem se recusou (lock ocupado). */
function acquireLock(): string | null {
  const lock = lockFilePath();
  mkdirSync(path.dirname(lock), { recursive: true });

  if (existsSync(lock)) {
    try {
      const data = JSON.parse(readFileSync(lock, "utf8")) as LockFileContent;
      const ageMs = Date.now() - new Date(data.startedAt).getTime();
      const alive = isPidAlive(data.pid);
      const stale = alive === false || !Number.isFinite(ageMs) || ageMs > STALE_LOCK_MS;
      if (!stale) {
        return `Outro pipeline já corre (pid=${data.pid}, kind=${data.kind}, started=${data.startedAt}) — sync-now recusa correr em paralelo.`;
      }
      console.warn(
        `⚠ Lockfile de ${data.kind ?? "?"} (pid=${data.pid}) já não está vivo ou está stale — sync-now a reclamar.`
      );
    } catch {
      console.warn("⚠ Lockfile ilegível — sync-now a sobrescrever.");
    }
  }

  writeFileSync(
    lock,
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), kind: "sync-now" }, null, 2) + "\n",
    "utf8"
  );
  return null;
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
// Resolução de farmaciaId — cópia deliberada, ver cabeçalho do ficheiro.
// ─────────────────────────────────────────────────────────────────────

async function resolveFarmaciaId(client: SaasClient, hint: string): Promise<string> {
  const r = await client.listFarmacias(15_000);
  const isCuid = /^c[a-z0-9]{20,}$/i.test(hint);
  const match = isCuid
    ? r.farmacias.find((f) => f.id === hint)
    : r.farmacias.find((f) => f.nome.toLowerCase() === hint.toLowerCase());
  if (!match) {
    throw new Error(
      `Farmácia "${hint}" não encontrada no tenant. ${r.farmacias.length} disponíveis: ` +
        r.farmacias.map((f) => f.nome).slice(0, 5).join(", ")
    );
  }
  if (match.estado !== "ATIVO") {
    throw new Error(`Farmácia "${match.nome}" está em estado ${match.estado}. sync-now recusa farmácias inactivas.`);
  }
  return match.id;
}

// ─────────────────────────────────────────────────────────────────────
// Ciclos de long-poll — PURO (sem lock, sem SQL, sem fs), testável sem
// rede injectando um `pullOnce` falso (ver
// scripts/tests/test-sync-on-demand.ts). Não toca no lockfile por
// construção: esta função nem sequer importa `acquireLock`.
// ─────────────────────────────────────────────────────────────────────

export type LongPollCyclesResult = {
  claimed: PendingSyncRequest | null;
  /** Quantos ciclos foram efectivamente consultados (1..cycles). */
  cyclesUsed: number;
};

export async function runLongPollCycles(
  pullOnce: (waitSeconds: number) => Promise<PendingSyncRequestsResponse>,
  opts: { cycles: number; waitSeconds: number },
): Promise<LongPollCyclesResult> {
  for (let i = 1; i <= opts.cycles; i++) {
    const pending = await pullOnce(opts.waitSeconds);
    if (pending.count > 0 && pending.syncRequests[0]) {
      return { claimed: pending.syncRequests[0], cyclesUsed: i };
    }
  }
  return { claimed: null, cyclesUsed: opts.cycles };
}

// ─────────────────────────────────────────────────────────────────────
// Decisão pós-claim quando o lock local está ocupado — PURA, testável
// sem fs/SQL. `acquireLock()` já devolve `null` (adquirido) ou uma
// mensagem (recusado); esta função só decide o que fazer com isso
// DEPOIS de já se ter reclamado um pedido — nunca antes.
// ─────────────────────────────────────────────────────────────────────

export type PostClaimDecision =
  | { action: "process" }
  | { action: "fail-lock-busy"; message: string };

export function decidePostClaim(lockRefusal: string | null): PostClaimDecision {
  if (lockRefusal) {
    return {
      action: "fail-lock-busy",
      message:
        `Pedido reclamado mas o lock local está ocupado (${lockRefusal}). ` +
        `A falhar de imediato em vez de esperar pelo lock — o pedido não fica pendurado até expirar aos 15 min.`,
    };
  }
  return { action: "process" };
}

// ─────────────────────────────────────────────────────────────────────

export async function syncNow(): Promise<number> {
  let cfg: AgentConfig;
  try {
    cfg = loadConfig("both"); // precisa SQL E SaaS
  } catch (err) {
    console.error("✗ Config inválida:");
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  if (!cfg.farmacia) {
    console.error("✗ SPHARMMT_FARMACIA não está definido (cuid ou nome da farmácia).");
    return 1;
  }

  console.log(RULE);
  console.log("sync-now — poll dedicado do botão \"Sincronizar agora\" (/stock)");
  console.log(RULE);

  const client = new SaasClient(cfg);
  let farmaciaId: string;
  try {
    farmaciaId = await resolveFarmaciaId(client, cfg.farmacia);
  } catch (err) {
    console.error("✗ Resolução de farmácia falhou:");
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  console.log(`Farmácia (resolved): ${farmaciaId}`);
  console.log(
    `Long-poll: até ${SYNC_NOW_LONGPOLL_CYCLES} ciclo(s) de ${SYNC_NOW_LONGPOLL_WAIT_SECONDS}s cada ` +
      `(orçamento desta corrida quando nada está pendente: ~${SYNC_NOW_LONGPOLL_CYCLES * SYNC_NOW_LONGPOLL_WAIT_SECONDS}s). ` +
      `Lock local só é tocado se algo for reclamado.`
  );

  const agentInstance = `${cfg.tenantSlug}-${os.hostname()}`.slice(0, 100);

  // ── Ciclos de long-poll — SEM lock. Nada aqui escreve produtos/stock,
  // por isso nada aqui precisa de serializar com daily-pipeline/full-sync.
  let cycleResult: LongPollCyclesResult;
  try {
    cycleResult = await runLongPollCycles(
      (waitSeconds) => client.pullPendingSyncRequests(farmaciaId, { agentInstance, waitSeconds }),
      { cycles: SYNC_NOW_LONGPOLL_CYCLES, waitSeconds: SYNC_NOW_LONGPOLL_WAIT_SECONDS }
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`✗ pullPendingSyncRequests falhou: ${msg}`);
    return 1;
  }

  const req = cycleResult.claimed;
  if (!req) {
    console.log(`Nada pendente após ${cycleResult.cyclesUsed} ciclo(s) de long-poll. OK. (lock nunca foi tocado)`);
    return 0;
  }

  console.log(
    `▶ Pedido reclamado: ${req.syncRequestId} (farmácia=${req.farmaciaId}, timeoutAt=${req.timeoutAt}, ` +
      `ciclo ${cycleResult.cyclesUsed}/${SYNC_NOW_LONGPOLL_CYCLES})`
  );
  console.log("");

  // ── SÓ AGORA o lock — algo foi reclamado e vai ser processado.
  const lockRefusal = acquireLock();
  const decision = decidePostClaim(lockRefusal);
  if (decision.action === "fail-lock-busy") {
    console.log(decision.message);
    try {
      await client.failSyncRequest(req.syncRequestId, decision.message);
      console.log("· fail enviado ao SaaS (pedido reclamado mas não processado — lock ocupado).");
    } catch (failErr) {
      console.error(
        `✗ fail também falhou (o pedido fica EM_CURSO até expirar por timeout): ${
          failErr instanceof Error ? failErr.message : String(failErr)
        }`
      );
    }
    return 2;
  }

  try {
    const date = hojeNaFarmacia();
    console.log(`Dia (hoje na farmácia): ${date}`);
    console.log(`Timeout local         : ${(SYNC_NOW_LOCAL_TIMEOUT_MS / 60_000).toFixed(0)} min`);
    console.log("");

    const logger: DailySyncLogger = {
      log: (l: string) => console.log(l),
      raw: (l: string) => console.log(l),
    };

    const t0 = Date.now();
    let resultado: SyncNowResultado;
    try {
      const counts = await withLocalTimeout(
        withPool(cfg, (pool) =>
          runPipelineForDay({
            pool,
            client,
            farmaciaId,
            date,
            schemaProbes: { tableExists, listColumns },
            logger,
            scope: "products-stock", // NUNCA vendas — ver cabeçalho do ficheiro.
          })
        ),
        SYNC_NOW_LOCAL_TIMEOUT_MS,
        "sync-now"
      );

      if (counts.productsErrors > 0 || counts.stockErrors > 0) {
        throw new Error(
          `${counts.productsErrors} erro(s) em produtos, ${counts.stockErrors} erro(s) em stock — ver detalhes acima.`
        );
      }

      resultado = {
        stockAtualizado: counts.stockUpserted,
        produtosAtualizados: counts.productsUpserted,
        fabricantesAlterados: counts.fabricantesAlterados,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const retryableHint = err instanceof SaasApiError ? ` (HTTP ${err.statusCode})` : "";
      console.error(`✗ sincronização falhou${retryableHint}: ${msg}`);
      try {
        await client.failSyncRequest(req.syncRequestId, msg);
        console.log("· fail enviado ao SaaS.");
      } catch (failErr) {
        console.error(
          `✗ fail também falhou (o pedido fica EM_CURSO até expirar por timeout): ${
            failErr instanceof Error ? failErr.message : String(failErr)
          }`
        );
      }
      return 2;
    }

    try {
      await client.ackSyncRequest(req.syncRequestId, resultado);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `✗ ack falhou (sincronização OK; o pedido fica EM_CURSO até expirar por timeout): ${msg}`
      );
      return 2;
    }

    const wallMs = Date.now() - t0;
    console.log("");
    console.log(RULE);
    console.log("SYNC-NOW SUMMARY");
    console.log(RULE);
    console.log(`  stock actualizado      : ${resultado.stockAtualizado}`);
    console.log(`  produtos actualizados  : ${resultado.produtosAtualizados}`);
    console.log(`  fabricantes alterados  : ${resultado.fabricantesAlterados}`);
    console.log(`  duração                : ${(wallMs / 1000).toFixed(1)}s`);
    console.log(RULE);
    console.log("✓ sync-now concluído e acked com sucesso.");
    return 0;
  } finally {
    // Só liberta o que foi adquirido acima (depois do claim) — nunca
    // tocado durante os ciclos de long-poll.
    releaseLock();
  }
}
