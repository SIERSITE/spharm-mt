/**
 * agent/src/lock-pipeline.ts
 *
 * Lock ÚNICO do agent (`run/pipeline.lock`), com HEARTBEAT. É o mesmo módulo e o mesmo protocolo para
 * `daily-pipeline`, `full-sync`, `sync-now` e para os comandos de escrita avulsos (`*-upload`, `daily-sync`).
 *
 * ── Porque é que um lock só com PID não chegava ───────────────────────
 * Depois de um reinício do computador (ou de uma morte abrupta durante a espera de 15 min da retoma) o lock fica
 * no disco com um PID que o Windows pode já ter dado a OUTRO processo. «PID existe» deixava o lock órfão «vivo» até
 * às 6 h — e a corrida das 03:00 seguinte era recusada.
 *
 * ── Protocolo (versão 2) ──────────────────────────────────────────────
 *  · criação ATÓMICA e exclusiva (`wx`): só um processo ganha, mesmo que dois reclamem ao mesmo tempo;
 *  · conteúdo (sem segredos): `runId` (UUID da execução), `pid`, `host`, `imagem` (nome do executável), `criadoEm`,
 *    `heartbeatEm`, `modo` (comando) e `dia` (dia de referência, se aplicável);
 *  · HEARTBEAT: um worker thread reescreve o lock (tmp + rename) a cada 10 s. É um thread, não um timer do
 *    thread principal, porque o agent tem chamadas bloqueantes (`spawnSync`, queries): um timer normal deixaria de
 *    disparar com o processo vivo e o lock pareceria expirado;
 *  · um lock só é RECLAMADO quando:
 *      (a) o processo já não existe; ou
 *      (b) o PID existe mas pertence a OUTRO executável (PID reutilizado); ou
 *      (c) o heartbeat está expirado (120 s sem sinal) — cobre PID reutilizado por um processo do mesmo tipo e
 *          reinícios; ou
 *      (d) `--force`;
 *  · a libertação verifica o `runId`: uma execução NUNCA liberta o lock de outra (nem o heartbeat o reescreve);
 *  · processos-filho (subcomandos de `daily-pipeline`/`full-sync`) herdam o lock do pai via `SPHARMMT_LOCK_RUN_ID`:
 *    reconhecem-no como seu, não fazem heartbeat nem o libertam.
 *
 * `--plan`, `test-connection`, `*-dry-run`, previews e discovery NÃO usam lock.
 */

import { randomUUID } from "node:crypto";
import fsSync, {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Worker } from "node:worker_threads";

export const HEARTBEAT_INTERVALO_MS = 10_000;
/** Sem heartbeat há mais do que isto ⇒ o lock é reclamável (12 batimentos perdidos). */
export const HEARTBEAT_EXPIRA_MS = 120_000;
/** Locks antigos (formato rev97, sem heartbeat): mesma rede de segurança de sempre. */
export const STALE_LOCK_LEGADO_MS = 6 * 60 * 60 * 1000;
/** Compatibilidade com código/testes que importavam esta constante. */
export const STALE_LOCK_MS = STALE_LOCK_LEGADO_MS;

export const ENV_LOCK_RUN_ID = "SPHARMMT_LOCK_RUN_ID";

export type ConteudoLock = {
  versao: 2;
  runId: string;
  pid: number;
  host: string;
  /** Nome do executável (ex.: `node.exe`) — distingue um PID reutilizado por outro programa. */
  imagem: string;
  criadoEm: string;
  heartbeatEm: string;
  modo: string;
  dia: string | null;
};

/** Formato rev97 (sem versão nem heartbeat). */
export type ConteudoLockLegado = { pid: number; startedAt: string; kind?: string; date?: string };

export type EstadoProcesso = "vivo" | "morto" | "outro" | "desconhecido";

export type OpcoesLock = {
  modo: string;
  dia?: string | null;
  force?: boolean;
  dir?: string;
  /** Injetáveis (testes). */
  agora?: () => number;
  expiraMs?: number;
  intervaloHeartbeatMs?: number;
  verificarProcesso?: (pid: number, imagemEsperada: string) => EstadoProcesso;
  log?: (linha: string) => void;
  /** `false` desliga o worker de heartbeat (só testes que não precisam dele). */
  heartbeat?: boolean;
};

export class ErroLockOcupado extends Error {
  constructor(message: string, public readonly dono: { modo?: string; dia?: string | null; pid?: number; desde?: string; heartbeatHaS?: number | null }) {
    super(message);
    this.name = "ErroLockOcupado";
  }
}

export function lockFilePath(dir?: string): string {
  return path.join(dir ?? (process.env.SPHARMMT_RUN_DIR?.trim() || path.join(process.cwd(), "run")), "pipeline.lock");
}

const imagemDeste = () => path.basename(process.execPath).toLowerCase();

/**
 * O processo `pid` existe e é do tipo esperado?
 *  · Windows: `tasklist` dá o nome do executável (distingue PID reutilizado por outro programa);
 *  · outros SO: `kill(pid, 0)`.
 */
export function verificarProcessoReal(pid: number, imagemEsperada: string): EstadoProcesso {
  if (!Number.isFinite(pid) || pid <= 0) return "morto";
  if (process.platform === "win32") {
    try {
      const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], { encoding: "utf8", timeout: 5_000 });
      if (r.status !== 0 || !r.stdout) return "desconhecido";
      const out = r.stdout.trim();
      if (out.toLowerCase().includes("no tasks") || out === "") return "morto";
      const m = /^"([^"]+)"/.exec(out.split(/\r?\n/)[0] ?? "");
      if (!m) return "desconhecido";
      return m[1]!.toLowerCase() === imagemEsperada.toLowerCase() ? "vivo" : "outro";
    } catch {
      return "desconhecido";
    }
  }
  try {
    process.kill(pid, 0);
    return "vivo";
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM" ? "vivo" : "morto";
  }
}

function lerComRetry(file: string): { estado: "ausente" } | { estado: "ilegivel" } | { estado: "ok"; dados: unknown } {
  for (let i = 0; i < 4; i++) {
    if (!existsSync(file)) return { estado: "ausente" };
    try {
      const raw = readFileSync(file, "utf8");
      if (raw.trim() !== "") return { estado: "ok", dados: JSON.parse(raw) };
    } catch {
      /* a meio de uma escrita/rename: tenta de novo */
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
  }
  return { estado: "ilegivel" };
}

export type AvaliacaoLock =
  | { veredicto: "ocupado"; motivo: string; dono: ErroLockOcupado["dono"] }
  | { veredicto: "reclamavel"; motivo: string };

/** Puro (a verificação do processo é injetada): decide se um lock existente está ocupado ou é reclamável. */
export function avaliarLock(
  dados: unknown,
  ctx: { agora: number; expiraMs: number; verificar: (pid: number, imagem: string) => EstadoProcesso; mtimeMs?: number },
): AvaliacaoLock {
  const d = (dados ?? {}) as Partial<ConteudoLock & ConteudoLockLegado>;
  if (d.versao === 2 && typeof d.pid === "number") {
    const hb = Date.parse(String(d.heartbeatEm));
    const idade = Number.isFinite(hb) ? ctx.agora - hb : Number.POSITIVE_INFINITY;
    const dono = { modo: d.modo, dia: d.dia ?? null, pid: d.pid, desde: d.criadoEm, heartbeatHaS: Number.isFinite(idade) ? Math.round(idade / 1000) : null };
    const proc = ctx.verificar(d.pid, String(d.imagem ?? ""));
    if (proc === "morto") return { veredicto: "reclamavel", motivo: `o processo ${d.pid} já não existe` };
    if (proc === "outro") return { veredicto: "reclamavel", motivo: `o PID ${d.pid} pertence agora a outro programa (PID reutilizado)` };
    if (idade > ctx.expiraMs) return { veredicto: "reclamavel", motivo: `heartbeat expirado há ${Math.round(idade / 1000)}s (limite ${Math.round(ctx.expiraMs / 1000)}s)` };
    return { veredicto: "ocupado", motivo: `execução ativa (${d.modo ?? "?"}, pid ${d.pid}, heartbeat há ${Math.round(idade / 1000)}s)`, dono };
  }
  if (typeof d.pid === "number" && typeof d.startedAt === "string") {
    // Formato rev97: sem heartbeat. PID morto, ou mais de 6 h ⇒ reclamável.
    const idade = ctx.agora - Date.parse(d.startedAt);
    const dono = { modo: d.kind, dia: d.date ?? null, pid: d.pid, desde: d.startedAt, heartbeatHaS: null };
    if (ctx.verificar(d.pid, "") === "morto") return { veredicto: "reclamavel", motivo: `lock rev97 de um processo (${d.pid}) que já não existe` };
    if (!Number.isFinite(idade) || idade > STALE_LOCK_LEGADO_MS) return { veredicto: "reclamavel", motivo: "lock rev97 com mais de 6 h" };
    return { veredicto: "ocupado", motivo: `lock rev97 ativo (${d.kind ?? "?"}, pid ${d.pid})`, dono };
  }
  // Ilegível/estranho: só é reclamável se o ficheiro estiver parado há mais do que o limite (nunca por palpite).
  const idadeFicheiro = ctx.mtimeMs !== undefined ? ctx.agora - ctx.mtimeMs : 0;
  if (idadeFicheiro > ctx.expiraMs) return { veredicto: "reclamavel", motivo: "lock ilegível e parado há mais do que o limite" };
  return { veredicto: "ocupado", motivo: "lock ilegível (recente) — aguarda", dono: {} };
}

const CODIGO_WORKER = `
const { workerData, parentPort } = require('worker_threads');
const fs = require('fs');
const { file, runId, intervalMs } = workerData;
let extra = {};
parentPort.on('message', (m) => { extra = { ...extra, ...m }; });
const t = setInterval(() => {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (c.runId !== runId) { parentPort.postMessage('perdido'); clearInterval(t); return; }
    const novo = { ...c, ...extra, heartbeatEm: new Date().toISOString() };
    const tmp = file + '.' + process.pid + '.hb';
    fs.writeFileSync(tmp, JSON.stringify(novo, null, 2) + '\\n');
    fs.renameSync(tmp, file);
  } catch (e) { /* a meio de uma troca/leitura concorrente: tenta no próximo batimento */ }
}, intervalMs);
`;

export type LockHandle = {
  runId: string;
  /** `true` quando o lock pertence ao processo-pai (herdado): não se renova nem se liberta. */
  herdado: boolean;
  /** Atualiza modo/dia de referência (aparece no lock no próximo batimento). */
  atualizar(p: { modo?: string; dia?: string | null }): void;
  /** Liberta SE o lock ainda for desta execução (verifica o `runId`). Devolve se libertou. */
  libertar(): boolean;
  /** O worker reportou que o lock passou para outra execução. */
  perdido(): boolean;
};

let atual: { handle: LockHandle; dir?: string } | null = null;

function escreverNovo(file: string, c: ConteudoLock): void {
  const fd = openSync(file, "wx");
  try {
    writeSync(fd, JSON.stringify(c, null, 2) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Adquire o lock (ou reconhece-o como herdado do processo-pai). Lança `ErroLockOcupado` se outra execução ativa o tem.
 * Reentrante dentro do mesmo processo (a retoma do pipeline mantém o lock entre tentativas).
 */
export async function adquirirLock(op: OpcoesLock): Promise<LockHandle> {
  const dir = op.dir;
  const file = lockFilePath(dir);
  const log = op.log ?? ((l: string) => console.warn(l));
  const agora = op.agora ?? Date.now;
  const expiraMs = op.expiraMs ?? HEARTBEAT_EXPIRA_MS;
  const verificar = op.verificarProcesso ?? verificarProcessoReal;
  mkdirSync(path.dirname(file), { recursive: true });

  // Reentrada no mesmo processo.
  if (atual && (atual.dir ?? "") === (dir ?? "")) {
    const l = lerComRetry(file);
    if (l.estado === "ok" && (l.dados as Partial<ConteudoLock>).runId === atual.handle.runId) {
      atual.handle.atualizar({ modo: op.modo, dia: op.dia ?? null });
      return atual.handle;
    }
    atual = null; // o lock deixou de ser nosso (reclamado/apagado): adquire de novo
  }

  for (let tentativa = 0; tentativa < 4; tentativa++) {
    const runId = randomUUID();
    const conteudo: ConteudoLock = {
      versao: 2, runId, pid: process.pid, host: os.hostname(), imagem: imagemDeste(),
      criadoEm: new Date(agora()).toISOString(), heartbeatEm: new Date(agora()).toISOString(), modo: op.modo, dia: op.dia ?? null,
    };
    try {
      escreverNovo(file, conteudo);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const lido = lerComRetry(file);
      if (lido.estado === "ausente") continue; // libertado entretanto
      // Herdado do processo-pai?
      const herdadoId = process.env[ENV_LOCK_RUN_ID];
      if (lido.estado === "ok" && herdadoId && (lido.dados as Partial<ConteudoLock>).runId === herdadoId) {
        return { runId: herdadoId, herdado: true, atualizar: () => undefined, libertar: () => false, perdido: () => false };
      }
      let mtimeMs: number | undefined;
      try { mtimeMs = statSync(file).mtimeMs; } catch { /* ignore */ }
      const aval = lido.estado === "ok"
        ? avaliarLock(lido.dados, { agora: agora(), expiraMs, verificar, mtimeMs })
        : avaliarLock(null, { agora: agora(), expiraMs, verificar, mtimeMs });
      if (op.force || aval.veredicto === "reclamavel") {
        log(`⚠ Lock órfão/expirado — a reclamar: ${op.force && aval.veredicto === "ocupado" ? "--force (a ignorar execução ativa)" : (aval as { motivo: string }).motivo}`);
        try { unlinkSync(file); } catch { /* outro processo reclamou primeiro: a próxima volta decide */ }
        continue;
      }
      const o = aval as Extract<AvaliacaoLock, { veredicto: "ocupado" }>;
      throw new ErroLockOcupado(
        `Pipeline já corre (${o.motivo}${o.dono.dia ? `, dia ${o.dono.dia}` : ""}${o.dono.desde ? `, desde ${o.dono.desde}` : ""}). Usa --force ou aguarda.`,
        o.dono,
      );
    }

    // Lock nosso: heartbeat + exportar o runId aos subprocessos.
    process.env[ENV_LOCK_RUN_ID] = runId;
    let perdido = false;
    let worker: Worker | null = null;
    if (op.heartbeat !== false) {
      try {
        worker = new Worker(CODIGO_WORKER, { eval: true, workerData: { file, runId, intervalMs: op.intervaloHeartbeatMs ?? HEARTBEAT_INTERVALO_MS } });
        worker.unref();
        worker.on("message", (m) => { if (m === "perdido") perdido = true; });
        worker.on("error", () => undefined);
      } catch {
        worker = null; // sem worker o lock continua válido; só deixa de ser renovado
      }
    }
    const handle: LockHandle = {
      runId,
      herdado: false,
      atualizar: (p) => { try { worker?.postMessage({ ...(p.modo !== undefined ? { modo: p.modo } : {}), ...(p.dia !== undefined ? { dia: p.dia } : {}) }); } catch { /* ignore */ } },
      libertar: () => {
        try { void worker?.terminate(); } catch { /* ignore */ }
        worker = null;
        const l = lerComRetry(file);
        let libertou = false;
        if (l.estado === "ok" && (l.dados as Partial<ConteudoLock>).runId === runId) {
          try { unlinkSync(file); libertou = true; } catch { /* ignore */ }
        }
        if (process.env[ENV_LOCK_RUN_ID] === runId) delete process.env[ENV_LOCK_RUN_ID];
        if (atual && atual.handle.runId === runId) atual = null;
        try { for (const f of fsSync.readdirSync(path.dirname(file))) if (f.startsWith("pipeline.lock.") && f.endsWith(".hb")) unlinkSync(path.join(path.dirname(file), f)); } catch { /* ignore */ }
        return libertou;
      },
      perdido: () => perdido,
    };
    atual = { handle, dir };
    return handle;
  }
  throw new ErroLockOcupado("Não foi possível adquirir o lock (concorrência com outra execução).", {});
}

// Libertação best-effort no fim normal do processo (nunca toca num lock de outra execução).
process.on("exit", () => {
  try { atual?.handle.libertar(); } catch { /* ignore */ }
});

/** Leitura read-only do estado do lock (para `--plan` e diagnóstico). Nunca cria nem altera nada. */
export function descreverLock(dir?: string, agora: number = Date.now()): string {
  const file = lockFilePath(dir);
  const l = lerComRetry(file);
  if (l.estado === "ausente") return "livre";
  if (l.estado === "ilegivel") return "ilegível (será tratado como órfão se estiver parado)";
  const aval = avaliarLock(l.dados, { agora, expiraMs: HEARTBEAT_EXPIRA_MS, verificar: verificarProcessoReal });
  return aval.veredicto === "ocupado" ? `OCUPADO — ${aval.motivo}` : `órfão (reclamável) — ${aval.motivo}`;
}

// ── API compatível com o `daily-pipeline` ───────────────────────────

export async function acquireLock(force: boolean, kind: string, date: string, dir?: string): Promise<void> {
  await adquirirLock({ modo: kind, dia: date, force, dir });
}

/** O lock existente pertence a ESTA execução? (só então se liberta no fim das tentativas) */
export function lockPertenceAEsteProcesso(dir?: string): boolean {
  if (!atual || (atual.dir ?? "") !== (dir ?? "")) return false;
  const l = lerComRetry(lockFilePath(dir));
  return l.estado === "ok" && (l.dados as Partial<ConteudoLock>).runId === atual.handle.runId;
}

export async function releaseLock(dir?: string): Promise<void> {
  if (atual && (atual.dir ?? "") === (dir ?? "")) atual.handle.libertar();
}

/** Só testes: esquece o handle do processo (simula um processo novo). */
export function _reporLockDoProcesso(): void {
  try { atual?.handle.libertar(); } catch { /* ignore */ }
  atual = null;
}
