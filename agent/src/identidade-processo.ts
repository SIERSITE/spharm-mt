/**
 * agent/src/identidade-processo.ts
 *
 * Identidade ROBUSTA de um processo, para o lock saber com segurança se o PROPRIETÁRIO é exatamente o mesmo processo
 * que o criou — e não um outro que herdou o mesmo PID:
 *
 *   · `inicioMs`  — instante de CRIAÇÃO do processo, dado pelo sistema operativo (UTC, ms). Dois processos nunca têm o
 *                   mesmo PID E o mesmo instante de criação: um `node.exe` com PID reutilizado tem outro instante;
 *   · `caminho` / `imagem` — executável (caminho completo quando acessível; nome sempre);
 *   · `bootMs`    — instante de ARRANQUE do sistema (Windows: `LastBootUpTime`; Linux: `btime`; macOS: `kern.boottime`).
 *
 * Não usa só «PID + node.exe» (um PID reutilizado por outro `node.exe` enganaria essa verificação).
 *
 * Windows: PowerShell (`Get-Process` / `Get-CimInstance`) — sem WMIC, que já não existe em versões recentes. Linux: `/proc`.
 * macOS: `ps`/`sysctl`. Se o sistema não deixar provar a identidade, devolve `"desconhecido"` — o lock trata isso como
 * «não provado» e RECUSA (nunca reclama por palpite).
 */

import { existsSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export type IdentidadeProcesso = {
  pid: number;
  /** Instante de criação do processo (epoch ms, UTC); `null` se o sistema não o devolveu. */
  inicioMs: number | null;
  /** Caminho completo do executável; `null` se inacessível. */
  caminho: string | null;
  /** Nome do executável em minúsculas (ex.: `node.exe`). */
  imagem: string;
};

export type SistemaLock = {
  identidadePropria(): IdentidadeProcesso;
  /** `"morto"` se o PID não existe; `"desconhecido"` se não foi possível apurar. */
  identidadeDe(pid: number): IdentidadeProcesso | "morto" | "desconhecido";
  /** Instante de arranque do sistema (epoch ms) ou `null`. */
  bootMs(): number | null;
};

/** Tolerância ao comparar instantes de criação de processo (a mesma fonte dá o mesmo valor; margem para arredondamentos). */
export const TOLERANCIA_INICIO_MS = 2_000;
/** Tolerância no instante de arranque do sistema (Fast Startup/ajustes do relógio). */
export const TOLERANCIA_BOOT_MS = 120_000;

const imagemDe = (p: string) => path.basename(p).toLowerCase();

function ps(script: string): string | null {
  try {
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
    });
    if (r.status !== 0 || r.error) return null;
    return (r.stdout ?? "").trim();
  } catch {
    return null;
  }
}

function paraMs(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function windowsProcesso(pid: number): IdentidadeProcesso | "morto" | "desconhecido" {
  const out = ps(
    `$p = Get-Process -Id ${Math.floor(pid)} -ErrorAction SilentlyContinue; ` +
      `if (-not $p) { 'NONE' } else { $i = $null; $c = $null; try { $i = $p.StartTime.ToUniversalTime().ToString('o') } catch {}; try { $c = $p.Path } catch {}; ` +
      `ConvertTo-Json -Compress @{ i = $i; p = $c; n = $p.ProcessName } }`,
  );
  if (out === null) return "desconhecido";
  if (out === "NONE" || out === "") return "morto";
  try {
    const j = JSON.parse(out) as { i?: string | null; p?: string | null; n?: string };
    const nome = (j.p ? imagemDe(j.p) : `${(j.n ?? "").toLowerCase()}.exe`);
    return { pid, inicioMs: paraMs(j.i ?? undefined), caminho: j.p ?? null, imagem: nome };
  } catch {
    return "desconhecido";
  }
}

let bootWindows: number | null | undefined;
function windowsBoot(): number | null {
  if (bootWindows !== undefined) return bootWindows;
  const out = ps("(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')");
  bootWindows = paraMs(out ?? undefined);
  return bootWindows;
}

function linuxBtime(): number | null {
  try {
    const m = /^btime\s+(\d+)/m.exec(readFileSync("/proc/stat", "utf8"));
    return m ? Number(m[1]) * 1000 : null;
  } catch {
    return null;
  }
}

function linuxProcesso(pid: number): IdentidadeProcesso | "morto" | "desconhecido" {
  if (!existsSync(`/proc/${pid}`)) return "morto";
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const resto = stat.slice(stat.lastIndexOf(")") + 2).split(" "); // campos a partir do 3.º
    const ticks = Number(resto[19]); // campo 22 (starttime)
    const btime = linuxBtime();
    let caminho: string | null = null;
    try { caminho = readlinkSync(`/proc/${pid}/exe`); } catch { /* sem permissão */ }
    const nome = caminho ? imagemDe(caminho) : (/^\d+ \((.*)\)/.exec(stat)?.[1] ?? "").toLowerCase();
    return { pid, inicioMs: btime !== null && Number.isFinite(ticks) ? btime + Math.round((ticks / 100) * 1000) : null, caminho, imagem: nome };
  } catch {
    return "desconhecido";
  }
}

function darwinProcesso(pid: number): IdentidadeProcesso | "morto" | "desconhecido" {
  try {
    const r = spawnSync("ps", ["-p", String(pid), "-o", "lstart=,comm="], { encoding: "utf8", timeout: 5_000 });
    const out = (r.stdout ?? "").trim();
    if (r.status !== 0 || out === "") return r.status === 1 ? "morto" : "desconhecido";
    const m = /^(\w{3} \w{3}\s+\d+ [\d:]+ \d{4})\s+(.*)$/.exec(out);
    return { pid, inicioMs: m ? paraMs(new Date(m[1]!).toISOString()) : null, caminho: m?.[2] ?? null, imagem: imagemDe(m?.[2] ?? "") };
  } catch {
    return "desconhecido";
  }
}

function darwinBoot(): number | null {
  try {
    const r = spawnSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf8", timeout: 5_000 });
    const m = /sec\s*=\s*(\d+)/.exec(r.stdout ?? "");
    return m ? Number(m[1]) * 1000 : null;
  } catch {
    return null;
  }
}

function deste(): IdentidadeProcesso {
  const eu = process.platform === "win32" ? windowsProcesso(process.pid) : process.platform === "linux" ? linuxProcesso(process.pid) : darwinProcesso(process.pid);
  if (typeof eu === "object") {
    // `process.execPath` é a verdade para o caminho próprio; o início vem do sistema (mesma fonte que a verificação dos outros).
    return { ...eu, caminho: eu.caminho ?? process.execPath, imagem: imagemDe(eu.caminho ?? process.execPath) };
  }
  return { pid: process.pid, inicioMs: null, caminho: process.execPath, imagem: imagemDe(process.execPath) };
}

let propriaCache: IdentidadeProcesso | null = null;

export const sistemaReal: SistemaLock = {
  identidadePropria: () => (propriaCache ??= deste()),
  identidadeDe: (pid) => {
    if (!Number.isFinite(pid) || pid <= 0) return "morto";
    if (process.platform === "win32") return windowsProcesso(pid);
    if (process.platform === "linux") return linuxProcesso(pid);
    return darwinProcesso(pid);
  },
  bootMs: () => (process.platform === "win32" ? windowsBoot() : process.platform === "linux" ? linuxBtime() : darwinBoot()),
};

/** Resultado da comparação entre a identidade registada no lock e a do processo que hoje tem esse PID. */
export type VeredictoIdentidade = "morto" | "outro" | "mesma" | "desconhecido";

export function compararIdentidade(
  registada: { imagem?: string; caminhoImagem?: string | null; inicioProcessoMs?: number | null },
  atual: IdentidadeProcesso | "morto" | "desconhecido",
): { veredicto: VeredictoIdentidade; motivo: string } {
  if (atual === "morto") return { veredicto: "morto", motivo: "o processo proprietário já não existe" };
  if (atual === "desconhecido") return { veredicto: "desconhecido", motivo: "não foi possível apurar o processo proprietário" };
  if (registada.imagem && atual.imagem && registada.imagem.toLowerCase() !== atual.imagem.toLowerCase()) {
    return { veredicto: "outro", motivo: `o PID pertence agora a outro executável (${atual.imagem}, não ${registada.imagem})` };
  }
  if (registada.caminhoImagem && atual.caminho && registada.caminhoImagem.toLowerCase() !== atual.caminho.toLowerCase()) {
    return { veredicto: "outro", motivo: "o PID pertence agora a outro executável (caminho diferente)" };
  }
  if (registada.inicioProcessoMs != null && atual.inicioMs != null) {
    const dif = Math.abs(registada.inicioProcessoMs - atual.inicioMs);
    return dif <= TOLERANCIA_INICIO_MS
      ? { veredicto: "mesma", motivo: "mesmo processo (PID, executável e instante de criação coincidem)" }
      : { veredicto: "outro", motivo: `o PID foi reutilizado: instante de criação do processo diferente em ${Math.round(dif / 1000)} s` };
  }
  return { veredicto: "desconhecido", motivo: "sem instante de criação para provar que é o mesmo processo" };
}
