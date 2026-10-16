/**
 * agent/src/lock-pipeline.ts
 *
 * Lock ÚNICO do agent (`run/pipeline.lock`), com HEARTBEAT e IDENTIDADE ROBUSTA do proprietário. É o mesmo módulo e o mesmo
 * protocolo para `daily-pipeline`, `full-sync`, `sync-now` e para os comandos de escrita avulsos (`*-upload`, `daily-sync`).
 *
 * ── Regra de ouro ─────────────────────────────────────────────────────
 * Duas sincronizações NUNCA podem correr em simultâneo. Por isso **um heartbeat expirado, por si só, não permite reclamar o lock**:
 * um computador suspenso (sleep/hibernação), um event loop atrasado ou um processo bloqueado deixam o heartbeat parado e o
 * processo proprietário continua vivo — reclamar nessa altura punha duas execuções a escrever ao mesmo tempo.
 *
 * ── Identidade do proprietário ────────────────────────────────────────
 * O lock regista: \`runId\` (UUID da execução), \`pid\`, \`inicioProcessoMs\` (instante de CRIAÇÃO do processo, dado pelo sistema),
 * \`caminhoImagem\`/\`imagem\` (executável), \`bootMs\` (instante de arranque do sistema), \`host\`, \`modo\`, \`dia\`, \`criadoEm\`, \`heartbeatEm\`.
 * «PID + node.exe» não chega (um PID reutilizado por outro node.exe passaria), por isso compara-se também o instante de criação.
 *
 * ── Quando se reclama (automaticamente) ───────────────────────────────
 *  · o PID já não existe;
 *  · o PID pertence a OUTRO executável;
 *  · o instante de criação do processo não corresponde (PID reutilizado, incluindo por outro node.exe);
 *  · o arranque do sistema mudou (o computador reiniciou: nenhum processo anterior sobreviveu);
 *  · o registo é ilegível, está parado há mais do que o limite e não há processo proprietário comprovável;
 *  · \`--force\`, conscientemente.
 *
 * ── Quando NÃO se reclama ─────────────────────────────────────────────
 *  · o heartbeat passou o limite (120 s) mas o processo proprietário está vivo e é o mesmo (mesma identidade): a 2.ª execução
 *    é RECUSADA com «processo proprietário vivo com heartbeat atrasado», fica um diagnóstico em \`run/pipeline-lock-diagnostico.json\`
 *    (e o \`daily-pipeline\` regista o ABORTED e alerta); o operador termina o processo ou usa \`--force\`;
 *  · não é possível provar a identidade do processo vivo (prudência: recusa);
 *  · o lock é de outro computador.
 *
 * ── Perda de propriedade ──────────────────────────────────────────────
 * Se uma execução deteta que o lock já não é seu (reclamado com \`--force\`, apagado…), \`guarda-escrita\` faz o cliente HTTP abortar
 * ANTES da próxima escrita (\`ErroLockPerdido\`), o pipeline pára, os subprocessos que controla são terminados e nada apaga o lock
 * do novo dono (a libertação compara o \`runId\`).
 *
 * Mecânica: criação atómica e exclusiva (\`wx\`); heartbeat de 10 s por um worker thread (as chamadas bloqueantes não o param);
 * subprocessos herdam o lock do pai por \`SPHARMMT_LOCK_RUN_ID\`.
 *
 * \`--plan\`, \`test-connection\`, \`*-dry-run\`, previews e discovery NÃO usam lock.
 */

import { randomUUID } from "node:crypto";
import fsSync, {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import {
  TOLERANCIA_BOOT_MS,
  compararIdentidade,
  sistemaReal,
  type SistemaLock,
} from "./identidade-processo.js";
import { ErroLockPerdido, instalarGuardaEscrita } from "./guarda-escrita.js";

export { ErroLockPerdido } from "./guarda-escrita.js";

export const HEARTBEAT_INTERVALO_MS = 10_000;
/** Heartbeat sem sinal há mais do que isto = «atrasado». NÃO autoriza reclamar (só o diagnostica); ver cabeçalho. */
export const HEARTBEAT_EXPIRA_MS = 120_000;
/** Locks antigos (formato rev97, sem identidade): mesma rede de segurança de sempre. */
export const STALE_LOCK_LEGADO_MS = 6 * 60 * 60 * 1000;
/** Compatibilidade com código/testes que importavam esta constante. */
export const STALE_LOCK_MS = STALE_LOCK_LEGADO_MS;

export const ENV_LOCK_RUN_ID = "SPHARMMT_LOCK_RUN_ID";

export type ConteudoLock = {
  versao: 2;
  runId: string;
  pid: number;
  host: string;
  /** Nome do executável (ex.: `node.exe`). */
  imagem: string;
  /** Caminho completo do executável, quando acessível. */
  caminhoImagem: string | null;
  /** Instante de criação do processo (epoch ms, UTC), dado pelo sistema. */
  inicioProcessoMs: number | null;
  /** Instante de arranque do sistema (epoch ms, UTC). */
  bootMs: number | null;
  criadoEm: string;
  heartbeatEm: string;
  modo: string;
  dia: string | null;
};

/** Formato rev97 (sem versão nem heartbeat). */
export type ConteudoLockLegado = { pid: number; startedAt: string; kind?: string; date?: string };

export type OpcoesLock = {
  modo: string;
  dia?: string | null;
  force?: boolean;
  dir?: string;
  /** Injetáveis (testes). */
  agora?: () => number;
  expiraMs?: number;
  intervaloHeartbeatMs?: number;
  sistema?: SistemaLock;
  log?: (linha: string) => void;
  /** `false` desliga o worker de heartbeat (só testes que não precisam dele). */
  heartbeat?: boolean;
};

export type DonoLock = { modo?: string; dia?: string | null; pid?: number; desde?: string; heartbeatHaS?: number | null; heartbeatAtrasado?: boolean };

export class ErroLockOcupado extends Error {
  constructor(message: string, public readonly dono: DonoLock) {
    super(message);
    this.name = "ErroLockOcupado";
  }
}

export function lockFilePath(dir?: string): string {
  return path.join(dir ?? (process.env.SPHARMMT_RUN_DIR?.trim() || path.join(process.cwd(), "run")), "pipeline.lock");
}

function diagnosticoPath(dir?: string): string {
  return path.join(path.dirname(lockFilePath(dir)), "pipeline-lock-diagnostico.json");
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
  | { veredicto: "ocupado"; motivo: string; dono: DonoLock }
  | { veredicto: "reclamavel"; motivo: string };

/**
 * Puro (o sistema operativo é injetado): decide se um lock existente está ocupado ou é reclamável. O heartbeat só
 * DIAGNOSTICA (`heartbeatAtrasado`); nunca autoriza a reclamação de um processo proprietário vivo com a mesma identidade.
 */
export function avaliarLock(
  dados: unknown,
  ctx: { agora: number; expiraMs: number; sistema: SistemaLock; mtimeMs?: number; hostLocal?: string },
): AvaliacaoLock {
  const d = (dados ?? {}) as Partial<ConteudoLock & ConteudoLockLegado>;

  if (d.versao === 2 && typeof d.pid === "number") {
    const hb = Date.parse(String(d.heartbeatEm));
    const idade = Number.isFinite(hb) ? ctx.agora - hb : Number.POSITIVE_INFINITY;
    const atrasado = idade > ctx.expiraMs;
    const dono: DonoLock = {
      modo: d.modo, dia: d.dia ?? null, pid: d.pid, desde: d.criadoEm,
      heartbeatHaS: Number.isFinite(idade) ? Math.round(idade / 1000) : null, heartbeatAtrasado: atrasado,
    };
    // 1) Outro computador (pasta partilhada): não há como provar nada sobre o processo.
    if (d.host && ctx.hostLocal && d.host !== ctx.hostLocal) {
      return { veredicto: "ocupado", motivo: `lock criado noutro computador (${d.host}) — não é possível verificar o processo; usa --force só se tiveres a certeza`, dono };
    }
    // 2) O sistema reiniciou desde que o lock foi criado: nenhum processo anterior sobreviveu.
    const bootAgora = ctx.sistema.bootMs();
    if (d.bootMs != null && bootAgora != null && Math.abs(d.bootMs - bootAgora) > TOLERANCIA_BOOT_MS) {
      return { veredicto: "reclamavel", motivo: `o arranque do sistema mudou (o computador reiniciou desde ${d.criadoEm})` };
    }
    // 3) Identidade do processo proprietário.
    const id = compararIdentidade(
      { imagem: d.imagem, caminhoImagem: d.caminhoImagem, inicioProcessoMs: d.inicioProcessoMs },
      ctx.sistema.identidadeDe(d.pid),
    );
    if (id.veredicto === "morto") return { veredicto: "reclamavel", motivo: id.motivo };
    if (id.veredicto === "outro") return { veredicto: "reclamavel", motivo: id.motivo };
    if (id.veredicto === "mesma") {
      return atrasado
        ? { veredicto: "ocupado", motivo: `processo proprietário vivo com heartbeat atrasado (${Math.round(idade / 1000)} s; ${d.modo ?? "?"}, pid ${d.pid}) — computador suspenso, processo bloqueado ou worker atrasado; NÃO se reclama`, dono }
        : { veredicto: "ocupado", motivo: `execução ativa (${d.modo ?? "?"}, pid ${d.pid}, heartbeat há ${Math.round(idade / 1000)} s)`, dono };
    }
    return { veredicto: "ocupado", motivo: `${id.motivo} — por prudência o lock mantém-se (${d.modo ?? "?"}, pid ${d.pid}${atrasado ? `, heartbeat atrasado ${Math.round(idade / 1000)} s` : ""})`, dono };
  }

  if (typeof d.pid === "number" && typeof d.startedAt === "string") {
    // Formato rev97: sem identidade. Processo inexistente ⇒ reclamável; mais de 6 h ⇒ reclamável; caso contrário ocupado.
    const idade = ctx.agora - Date.parse(d.startedAt);
    const dono: DonoLock = { modo: d.kind, dia: d.date ?? null, pid: d.pid, desde: d.startedAt, heartbeatHaS: null };
    if (ctx.sistema.identidadeDe(d.pid) === "morto") return { veredicto: "reclamavel", motivo: `lock rev97 de um processo (${d.pid}) que já não existe` };
    if (!Number.isFinite(idade) || idade > STALE_LOCK_LEGADO_MS) return { veredicto: "reclamavel", motivo: "lock rev97 com mais de 6 h" };
    return { veredicto: "ocupado", motivo: `lock rev97 ativo (${d.kind ?? "?"}, pid ${d.pid})`, dono };
  }

  // Ilegível/estranho e sem processo proprietário comprovável: só é reclamável se estiver parado há mais do que o limite.
  const idadeFicheiro = ctx.mtimeMs !== undefined ? ctx.agora - ctx.mtimeMs : 0;
  if (idadeFicheiro > ctx.expiraMs) return { veredicto: "reclamavel", motivo: "registo do lock inválido, parado, sem processo proprietário comprovável" };
  return { veredicto: "ocupado", motivo: "registo do lock ilegível (recente) — aguarda", dono: {} };
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
  /** O lock já não é desta execução (sinalizado pelo worker ou detetado por leitura). */
  perdido(): boolean;
};

let atual: { handle: LockHandle; dir?: string; file: string } | null = null;

type Propriedade = "ok" | "perdido" | "incerto";
function propriedade(file: string, runId: string): Propriedade {
  const l = lerComRetry(file);
  if (l.estado === "ausente") return "perdido";
  if (l.estado === "ilegivel") return "incerto"; // a meio de uma troca: nunca se conclui a perda por uma leitura falhada
  return (l.dados as Partial<ConteudoLock>).runId === runId ? "ok" : "perdido";
}

function instalarGuarda(file: string, runId: string, estado: { perdido: boolean }): void {
  instalarGuardaEscrita(() => {
    if (estado.perdido || propriedade(file, runId) === "perdido") {
      estado.perdido = true;
      throw new ErroLockPerdido(
        `Perdi o lock do pipeline (execução ${runId.slice(0, 8)}): outra execução tem agora o run/pipeline.lock. Abortado ANTES da próxima escrita no SaaS.`,
      );
    }
  });
}

/** Lança `ErroLockPerdido` se esta execução já não é a dona do lock (ponto seguro de verificação entre fases/lotes). */
export function exigirLock(): void {
  if (!atual) return;
  const { handle, file } = atual;
  if (handle.perdido() || propriedade(file, handle.runId) === "perdido") {
    throw new ErroLockPerdido(`Perdi o lock do pipeline (execução ${handle.runId.slice(0, 8)}): abortado antes da próxima fase.`);
  }
}

/** Sem lançar: o lock já não é desta execução? (usado pelos observadores de subprocessos) */
export function lockPerdidoAgora(): boolean {
  if (!atual) return false;
  return atual.handle.perdido() || propriedade(atual.file, atual.handle.runId) === "perdido";
}

function escreverNovo(file: string, c: ConteudoLock): void {
  const fd = openSync(file, "wx");
  try {
    writeSync(fd, JSON.stringify(c, null, 2) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function escreverDiagnostico(dir: string | undefined, motivo: string, dono: DonoLock): void {
  try {
    const f = diagnosticoPath(dir);
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ detetadoEm: new Date().toISOString(), motivo, dono, acao: "Termine o processo proprietário (ou use --force conscientemente). O lock NÃO foi reclamado." }, null, 2) + "\n");
    renameSync(tmp, f);
  } catch {
    /* o diagnóstico em disco nunca impede a recusa */
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
  const sistema = op.sistema ?? sistemaReal;
  mkdirSync(path.dirname(file), { recursive: true });

  // Reentrada no mesmo processo.
  if (atual && (atual.dir ?? "") === (dir ?? "")) {
    if (propriedade(file, atual.handle.runId) !== "perdido") {
      atual.handle.atualizar({ modo: op.modo, dia: op.dia ?? null });
      return atual.handle;
    }
    atual = null; // o lock deixou de ser nosso (reclamado/apagado): adquire de novo
    instalarGuardaEscrita(null);
  }

  for (let tentativa = 0; tentativa < 4; tentativa++) {
    const runId = randomUUID();
    const eu = sistema.identidadePropria();
    const conteudo: ConteudoLock = {
      versao: 2, runId, pid: process.pid, host: os.hostname(), imagem: eu.imagem, caminhoImagem: eu.caminho, inicioProcessoMs: eu.inicioMs,
      bootMs: sistema.bootMs(), criadoEm: new Date(agora()).toISOString(), heartbeatEm: new Date(agora()).toISOString(), modo: op.modo, dia: op.dia ?? null,
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
        const estado = { perdido: false };
        instalarGuarda(file, herdadoId, estado);
        const herdado: LockHandle = { runId: herdadoId, herdado: true, atualizar: () => undefined, libertar: () => false, perdido: () => estado.perdido };
        atual = { handle: herdado, dir, file };
        return herdado;
      }
      let mtimeMs: number | undefined;
      try { mtimeMs = statSync(file).mtimeMs; } catch { /* ignore */ }
      const aval = avaliarLock(lido.estado === "ok" ? lido.dados : null, { agora: agora(), expiraMs, sistema, mtimeMs, hostLocal: os.hostname() });
      if (op.force || aval.veredicto === "reclamavel") {
        log(`⚠ Lock a reclamar: ${op.force && aval.veredicto === "ocupado" ? `--force (a ignorar: ${aval.motivo})` : (aval as { motivo: string }).motivo}`);
        try { unlinkSync(file); } catch { /* outro processo reclamou primeiro: a próxima volta decide */ }
        continue;
      }
      const o = aval as Extract<AvaliacaoLock, { veredicto: "ocupado" }>;
      if (o.dono.heartbeatAtrasado) escreverDiagnostico(dir, o.motivo, o.dono);
      throw new ErroLockOcupado(
        `Pipeline já corre: ${o.motivo}${o.dono.dia ? `, dia ${o.dono.dia}` : ""}${o.dono.desde ? `, desde ${o.dono.desde}` : ""}. ` +
          `Aguarda, termina o processo proprietário ou usa --force apenas se tiveres a certeza de que já não está a correr.`,
        o.dono,
      );
    }

    // Lock nosso: heartbeat + exportar o runId aos subprocessos + guarda de escrita.
    process.env[ENV_LOCK_RUN_ID] = runId;
    const estado = { perdido: false };
    instalarGuarda(file, runId, estado);
    let worker: Worker | null = null;
    if (op.heartbeat !== false) {
      try {
        worker = new Worker(CODIGO_WORKER, { eval: true, workerData: { file, runId, intervalMs: op.intervaloHeartbeatMs ?? HEARTBEAT_INTERVALO_MS } });
        worker.unref();
        worker.on("message", (m) => { if (m === "perdido") estado.perdido = true; });
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
        // SÓ remove o ficheiro se o runId for ESTE: nunca o lock de outra execução.
        const l = lerComRetry(file);
        let libertou = false;
        if (l.estado === "ok" && (l.dados as Partial<ConteudoLock>).runId === runId) {
          try { unlinkSync(file); libertou = true; } catch { /* ignore */ }
        }
        if (process.env[ENV_LOCK_RUN_ID] === runId) delete process.env[ENV_LOCK_RUN_ID];
        if (atual && atual.handle.runId === runId) { atual = null; instalarGuardaEscrita(null); }
        try { for (const f of fsSync.readdirSync(path.dirname(file))) if (f.startsWith("pipeline.lock.") && f.endsWith(".hb")) unlinkSync(path.join(path.dirname(file), f)); } catch { /* ignore */ }
        return libertou;
      },
      perdido: () => estado.perdido,
    };
    atual = { handle, dir, file };
    return handle;
  }
  throw new ErroLockOcupado("Não foi possível adquirir o lock (concorrência com outra execução).", {});
}

// Libertação best-effort no fim normal do processo (nunca toca num lock de outra execução).
process.on("exit", () => {
  try { atual?.handle.libertar(); } catch { /* ignore */ }
});

/** Leitura read-only do estado do lock (para `--plan` e diagnóstico). Nunca cria nem altera nada. */
export function descreverLock(dir?: string, agora: number = Date.now(), sistema: SistemaLock = sistemaReal): string {
  const file = lockFilePath(dir);
  const l = lerComRetry(file);
  if (l.estado === "ausente") return "livre";
  if (l.estado === "ilegivel") return "ilegível (será tratado como órfão se estiver parado)";
  const aval = avaliarLock(l.dados, { agora, expiraMs: HEARTBEAT_EXPIRA_MS, sistema, hostLocal: os.hostname() });
  return aval.veredicto === "ocupado" ? `OCUPADO — ${aval.motivo}` : `órfão (reclamável) — ${aval.motivo}`;
}

// ── API compatível com o `daily-pipeline` ───────────────────────────

export async function acquireLock(force: boolean, kind: string, date: string, dir?: string): Promise<void> {
  await adquirirLock({ modo: kind, dia: date, force, dir });
}

/** O lock existente pertence a ESTA execução? (só então se liberta no fim das tentativas) */
export function lockPertenceAEsteProcesso(dir?: string): boolean {
  if (!atual || atual.handle.herdado || (atual.dir ?? "") !== (dir ?? "")) return false;
  return propriedade(atual.file, atual.handle.runId) === "ok";
}

export async function releaseLock(dir?: string): Promise<void> {
  if (atual && (atual.dir ?? "") === (dir ?? "")) atual.handle.libertar();
}

/** Só testes: esquece o handle do processo (simula um processo novo). */
export function _reporLockDoProcesso(): void {
  try { atual?.handle.libertar(); } catch { /* ignore */ }
  atual = null;
  instalarGuardaEscrita(null);
}
