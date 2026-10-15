/**
 * agent/src/lock-pipeline.ts
 *
 * Lockfile do daily-pipeline (`run/pipeline.lock`) — extraído de `daily-pipeline.ts` (rev98) para ser testável com
 * processos reais. Comportamento inalterado, com UMA adição: o lock é REENTRANTE para o mesmo processo (a retoma de
 * nível superior mantém o lock durante a espera de ~15 min entre tentativas, para que nenhuma segunda execução entre
 * no meio).
 *
 *  · outro processo vivo com lock recente → recusa (uma só execução avança);
 *  · pid morto → reclama; lock com mais de 6 h → reclama (rede de segurança); `--force` reclama.
 */

import { promises as fs } from "node:fs";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

export const STALE_LOCK_MS = 6 * 60 * 60 * 1000; // 6 horas — safety net

export type LockFileContent = {
  pid: number;
  startedAt: string;
  kind: string;
  date: string;
};

export function lockFilePath(dir?: string): string {
  return path.join(dir ?? (process.env.SPHARMMT_RUN_DIR?.trim() || path.join(process.cwd(), "run")), "pipeline.lock");
}

/**
 * Windows-specific: confirma se o PID está vivo via `tasklist`. Devolve
 * `true` se vivo, `false` se morto, `null` se não conseguimos
 * determinar (ex: tasklist indisponível, permissões). Em null, cai-se
 * no path de timestamp-based stale detection.
 */
export function isPidAlive(pid: number): boolean | null {
  if (process.platform !== "win32") return null;
  if (!Number.isFinite(pid) || pid <= 0) return null;
  try {
    const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], { encoding: "utf8", timeout: 5_000 });
    if (r.status !== 0 || !r.stdout) return null;
    // "INFO: No tasks are running..." quando PID não existe; CSV row
    // com o nome do processo quando vive.
    const out = r.stdout.trim();
    if (out.toLowerCase().includes("no tasks")) return false;
    // CSV: a primeira coluna é o image name. Se tem aspas, o PID existe.
    return out.startsWith('"');
  } catch {
    return null;
  }
}

export async function acquireLock(force: boolean, kind: string, date: string, dir?: string): Promise<void> {
  const lock = lockFilePath(dir);
  mkdirSync(path.dirname(lock), { recursive: true });

  if (existsSync(lock)) {
    try {
      const raw = await fs.readFile(lock, "utf8");
      const data = JSON.parse(raw) as LockFileContent;
      // O lock é MANTIDO entre as tentativas do mesmo processo (retoma de nível superior): reentrada.
      if (data.pid === process.pid) {
        writeFileSync(lock, JSON.stringify({ ...data, date, kind }, null, 2) + "\n", { encoding: "utf8" });
        return;
      }
      const ageMs = Date.now() - new Date(data.startedAt).getTime();
      if (!Number.isFinite(ageMs) || ageMs < 0) {
        throw new Error(`Lock corrupted (startedAt=${data.startedAt})`);
      }

      // Liveness check: se o PID já não existe, lock está stale ainda
      // que o timestamp seja recente. Evita esperar 6h após crash.
      const alive = isPidAlive(data.pid);
      if (alive === false) {
        console.warn(`⚠ Lockfile pid=${data.pid} já não está vivo (started=${data.startedAt}) — a reclamar.`);
      } else if (ageMs > STALE_LOCK_MS || force) {
        console.warn(`⚠ Lockfile stale (${(ageMs / 1000 / 60).toFixed(0)} min) ou --force — a reclamar.`);
      } else {
        // PID vivo (ou indeterminável) E timestamp recente E sem --force.
        throw new Error(
          `Pipeline já corre (pid=${data.pid}, started=${data.startedAt}, kind=${data.kind}). Usa --force ou aguarda.`
        );
      }
    } catch (err) {
      if (!force) {
        throw err instanceof Error ? err : new Error(String(err));
      }
      console.warn("⚠ Lockfile ilegível — --force a sobrescrever.");
    }
  }

  const payload: LockFileContent = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    kind,
    date,
  };
  writeFileSync(lock, JSON.stringify(payload, null, 2) + "\n", { encoding: "utf8" });
}

/** O lockfile existente foi criado por ESTE processo? (só então se liberta no fim das tentativas) */
export function lockPertenceAEsteProcesso(dir?: string): boolean {
  try {
    const data = JSON.parse(readFileSync(lockFilePath(dir), "utf8")) as LockFileContent;
    return data.pid === process.pid;
  } catch {
    return false;
  }
}

export async function releaseLock(dir?: string): Promise<void> {
  const lock = lockFilePath(dir);
  if (existsSync(lock)) {
    try {
      await fs.unlink(lock);
    } catch {
      // ignore
    }
  }
}
