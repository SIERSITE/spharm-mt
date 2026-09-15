/**
 * agent/src/commands/sync-now.ts
 *
 * Bloco E — consumidor do botão "Sincronizar agora" em /stock.
 *
 * O SaaS não consegue invocar o agent directamente (comunicação
 * agent↔SaaS é 100% unidireccional — o agent só faz PULL agendado via
 * Task Scheduler). Este comando é esse PULL: uma verificação única,
 * pensada para correr num poll dedicado MAIS CURTO do que o
 * `daily-pipeline` — ver `agent/docs/sync-now.md` para a frequência
 * escolhida (2 min), a tarefa `.bat` (`run-sync-now-poll-auto.bat`) e o
 * comando `schtasks` exacto para a instalar/actualizar.
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
 *   1. Resolve a farmácia configurada (`SPHARMMT_FARMACIA`).
 *   2. Adquire o MESMO lockfile do `daily-pipeline`/`full-sync`
 *      (`run/pipeline.lock`) — serializa com o pipeline nocturno. Um
 *      "sync agora" nunca corre ao mesmo tempo que um `daily-pipeline`
 *      ou `full-sync` na mesma máquina (ver secção "Lockfile" abaixo).
 *   3. GET /api/outbox/v1/sync-requests/pending?farmaciaId=... — se não
 *      houver nada, sai com 0 (nada a fazer, não é erro).
 *   4. Se houver um pedido: corre o subconjunto LEVE — produtos (que já
 *      inclui fabricante + os outros campos do catálogo regulamentar,
 *      via `catalog-discovery.ts` partilhado) e stock (existências),
 *      ambos de HOJE. NUNCA vendas.
 *   5. POST .../ack com os três contadores, ou .../fail com o erro.
 *
 * Timeout local: a corrida inteira (passo 4) tem um limite de parede de
 * `SYNC_NOW_LOCAL_TIMEOUT_MS` — ver essa constante para o porquê do
 * valor. Um ERP preso não deixa este comando pendurado indefinidamente:
 * ao expirar, é tratado como qualquer outro erro (cai no mesmo
 * catch → `failSyncRequest` → exit 2). Isto é complementar, não
 * substituto, do `requestTimeout` já configurado por-pedido no pool SQL
 * (`ERP_SQLSERVER_REQUEST_TIMEOUT_MS`, default 30s) — aquele limita UMA
 * query; este limita a corrida inteira (múltiplos batches + POSTs).
 *
 * Exit codes:
 *   0  nada pendente, ou pedido processado e acked com sucesso
 *   1  config inválida / lock ocupado / erro antes de reclamar o pedido
 *   2  pedido reclamado mas a sincronização falhou ou excedeu o timeout
 *      local (fail enviado ao SaaS)
 *
 * ── Retry ──────────────────────────────────────────────────────────
 *
 * Uma falha a MEIO (ex.: SQL Server local inacessível) chama
 * `failSyncRequest` e o pedido fica `FALHOU` — TERMINAL, sem
 * reagendamento automático (mesma decisão do endpoint `.../fail`, ver o
 * cabeçalho de `app/api/outbox/v1/sync-requests/[syncRequestId]/fail/route.ts`).
 * O utilizador vê o erro no widget e decide se carrega no botão outra
 * vez — o mutex já permite um novo pedido assim que este deixa de estar
 * activo. Não há retry automático do LADO DO AGENT para o MESMO pedido:
 * se `failSyncRequest` falhar também (ex.: rede caiu entre o erro local
 * e o POST), o pedido fica `EM_CURSO` preso, e a leitura lazy do SaaS
 * trata-o como `EXPIRADO` ao fim de `SYNC_REQUEST_TIMEOUT_MINUTOS_DEFAULT`
 * (15 min) — o mutex volta a libertar a farmácia sem intervenção manual.
 * Um pedido ainda `PENDENTE` (nunca chegou a ser reclamado, ex.: este
 * comando falhou ANTES do passo 3) fica candidato ao PRÓXIMO poll, que
 * o reclama normalmente — nenhuma acção extra necessária.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig, type AgentConfig } from "../config.js";
import { withPool } from "../sql-client.js";
import { SaasClient, SaasApiError, type SyncNowResultado } from "../http-client.js";
import { tableExists, listColumns } from "./probe-helpers.js";
import { hojeNaFarmacia } from "../janela.js";
import { runPipelineForDay, type DailySyncLogger } from "./daily-sync-runner.js";

const RULE = "─".repeat(70);

// ─────────────────────────────────────────────────────────────────────
// Timeout local — parede de tempo para a corrida inteira (passo 4).
//
// 8 minutos, escolhido com folga face ao timeout SERVER-SIDE do pedido
// (`SYNC_REQUEST_TIMEOUT_MINUTOS_DEFAULT` = 15 min, em
// `lib/sync-request/estado.ts`): entre o clique e este comando reclamar
// o pedido já passou até 1 poll (ver `agent/docs/sync-now.md` — 2 min),
// e depois do trabalho ainda falta o `ack`/`fail` viajar até ao SaaS.
// 8 min deixa esses ~2 min de espera + a chamada final com folga
// confortável dentro dos 15 min totais, e ainda é generoso para o caso
// leve (produtos+stock de um só dia, não o histórico inteiro).
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

  const lockRefusal = acquireLock();
  if (lockRefusal) {
    console.log(lockRefusal);
    console.log("✓ sync-now sai sem tentar reclamar nenhum pedido (lock ocupado).");
    return 0; // Não é uma falha do sync-now — é o mutex a funcionar. O
    // próximo poll (minutos depois) tenta de novo.
  }

  try {
    const agentInstance = `${cfg.tenantSlug}-${os.hostname()}`.slice(0, 100);
    let pending;
    try {
      pending = await client.pullPendingSyncRequests(farmaciaId, { agentInstance });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`✗ pullPendingSyncRequests falhou: ${msg}`);
      return 1;
    }

    if (pending.count === 0) {
      console.log("Nada pendente. OK.");
      return 0;
    }

    const req = pending.syncRequests[0];
    console.log(`▶ Pedido reclamado: ${req.syncRequestId} (farmácia=${req.farmaciaId}, timeoutAt=${req.timeoutAt})`);
    console.log("");

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
    releaseLock();
  }
}
