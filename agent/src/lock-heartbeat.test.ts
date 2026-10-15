/**
 * agent/src/lock-heartbeat.test.ts
 *
 * Lock único com heartbeat (`lock-pipeline.ts`) — com PROCESSOS REAIS (filhos) sempre que o cenário o exige:
 * concorrência, morte abrupta, herança por subprocessos, saída normal; e com locks fabricados para o PID
 * reutilizado e o heartbeat expirado.
 *
 * Uso: npx tsx agent/src/lock-heartbeat.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  ENV_LOCK_RUN_ID,
  ErroLockOcupado,
  HEARTBEAT_EXPIRA_MS,
  _reporLockDoProcesso,
  adquirirLock,
  avaliarLock,
  descreverLock,
  lockFilePath,
  type ConteudoLock,
} from "./lock-pipeline.js";

const espera = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Modo filho ────────────────────────────────────────────────────────
if (process.argv[2] === "--filho") {
  const [, , , modo, dir, extra] = process.argv;
  (async () => {
    try {
      const h = await adquirirLock({ modo: `filho-${modo}`, dia: "2026-10-14", dir, intervaloHeartbeatMs: 200, expiraMs: 1500, log: () => undefined });
      console.log(`ADQUIRIU herdado=${h.herdado} runId=${h.runId}`);
      if (modo === "matar") {
        await espera(Number(extra ?? 700)); // deixa o heartbeat bater, depois morre SEM libertar nada (TerminateProcess)
        process.kill(process.pid, "SIGKILL");
        await espera(5000);
      } else if (modo === "saida-normal") {
        process.exit(0); // o handler de 'exit' liberta o lock
      } else {
        await espera(Number(extra ?? 1500));
        console.log(`LIBERTOU=${h.libertar()}`);
      }
      process.exit(0);
    } catch (e) {
      console.log(e instanceof ErroLockOcupado ? `RECUSADO ${e.message.slice(0, 120)}` : `ERRO ${(e as Error).message}`);
      process.exit(3);
    }
  })();
} else {
  principal();
}

function filho(modo: string, dir: string, extra?: number, env: NodeJS.ProcessEnv = process.env) {
  const p = spawn(process.execPath, ["--import", "tsx", process.argv[1]!, "--filho", modo, dir, String(extra ?? "")], { env });
  let saida = "";
  p.stdout.on("data", (d) => (saida += d));
  p.stderr.on("data", (d) => (saida += d));
  const fim = new Promise<{ code: number | null; saida: string }>((r) => p.on("close", (code) => r({ code, saida })));
  return { p, fim, saida: () => saida };
}

async function aguardar(cond: () => boolean, ms = 15_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await espera(50);
  }
  return cond();
}

async function principal() {
  let ok = 0;
  let ko = 0;
  const check = (c: boolean, label: string, det?: string) => {
    if (c) { ok++; console.log(`  [OK]    ${label}`); }
    else { ko++; console.log(`  [FALHA] ${label}${det ? `\n            ${det}` : ""}`); }
  };
  const secao = (t: string) => console.log(`\n${t}`);
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "spharm-lock-"));
  const lerLock = (dir: string): ConteudoLock => JSON.parse(fs.readFileSync(lockFilePath(dir), "utf8"));
  const silencio = () => undefined;
  delete process.env[ENV_LOCK_RUN_ID];

  secao("1 · conteúdo do lock e heartbeat ativo");
  {
    const dir = tmp();
    const f = filho("segura", dir, 2500);
    await aguardar(() => f.saida().includes("ADQUIRIU"));
    const l1 = lerLock(dir);
    check(l1.versao === 2 && /^[0-9a-f-]{36}$/.test(l1.runId) && typeof l1.pid === "number" && l1.modo === "filho-segura" && l1.dia === "2026-10-14", "tem runId aleatório, pid, modo e dia de referência");
    check(!!l1.criadoEm && !!l1.heartbeatEm && !!l1.host && l1.imagem.length > 0, "tem criadoEm, heartbeatEm, host e imagem do executável");
    check(!/token|password|ingestKey|secret/i.test(JSON.stringify(l1)), "não contém segredos");
    await espera(900);
    const l2 = lerLock(dir);
    check(Date.parse(l2.heartbeatEm) > Date.parse(l1.heartbeatEm) && l2.runId === l1.runId, "o heartbeat avança (thread dedicado) com o mesmo runId");
    const tentativa = await adquirirLock({ modo: "sync-now", dir, log: silencio }).then(() => "adquiriu", (e) => (e instanceof ErroLockOcupado ? "recusado" : "erro"));
    check(tentativa === "recusado", "heartbeat ativo: uma 2.ª execução (sync-now) é RECUSADA");
    const r = await f.fim;
    check(/LIBERTOU=true/.test(r.saida), "o dono liberta o seu lock (runId confere)");
    check(!fs.existsSync(lockFilePath(dir)), "lock removido");
    fs.rmSync(dir, { recursive: true, force: true });
  }

  secao("2 · concorrência: 5 processos a tentar ao mesmo tempo — só um avança");
  {
    const dir = tmp();
    const fs5 = Array.from({ length: 5 }, () => filho("segura", dir, 1500));
    const rs = await Promise.all(fs5.map((f) => f.fim));
    const adquiriram = rs.filter((r) => /ADQUIRIU/.test(r.saida)).length;
    const recusados = rs.filter((r) => /RECUSADO/.test(r.saida)).length;
    check(adquiriram === 1 && recusados === 4, `1 adquiriu, 4 recusados (adquiriram=${adquiriram}, recusados=${recusados})`);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  secao("3 · processo terminado abruptamente: o lock órfão recupera-se logo (sem esperar 6 h)");
  {
    const dir = tmp();
    const f = filho("matar", dir, 700);
    await f.fim;
    check(fs.existsSync(lockFilePath(dir)), "o lock fica no disco depois da morte abrupta");
    const logs: string[] = [];
    const t0 = Date.now();
    const h = await adquirirLock({ modo: "daily-pipeline", dia: "2026-10-14", dir, log: (l) => logs.push(l), heartbeat: false });
    check(!h.herdado && Date.now() - t0 < 10_000, `reclamado de imediato (${Date.now() - t0} ms)`);
    check(logs.some((l) => /já não existe/.test(l)), "motivo registado: o processo já não existe");
    check(lerLock(dir).pid === process.pid, "o lock passou a ser desta execução");
    h.libertar();
    _reporLockDoProcesso();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  secao("4 · PID reutilizado e heartbeat expirado");
  {
    const agora = Date.now();
    const base: ConteudoLock = { versao: 2, runId: "r1", pid: 4242, host: "x", imagem: "node.exe", criadoEm: new Date(agora - 600_000).toISOString(), heartbeatEm: new Date(agora - 1_000).toISOString(), modo: "daily-pipeline", dia: "2026-10-14" };
    const av = (c: ConteudoLock, estado: "vivo" | "morto" | "outro" | "desconhecido") => avaliarLock(c, { agora, expiraMs: HEARTBEAT_EXPIRA_MS, verificar: () => estado });
    check(av(base, "vivo").veredicto === "ocupado", "processo vivo + heartbeat fresco ⇒ ocupado");
    check(av(base, "morto").veredicto === "reclamavel", "processo morto ⇒ reclamável");
    check(av(base, "outro").veredicto === "reclamavel" && /outro programa/.test((av(base, "outro") as { motivo: string }).motivo), "PID de OUTRO programa (PID reutilizado) ⇒ reclamável");
    check(av({ ...base, heartbeatEm: new Date(agora - 180_000).toISOString() }, "vivo").veredicto === "reclamavel", "PID reutilizado por um processo do MESMO tipo, mas heartbeat expirado (180 s) ⇒ reclamável em minutos, não em 6 h");
    check(av({ ...base, heartbeatEm: new Date(agora - 60_000).toISOString() }, "vivo").veredicto === "ocupado", "heartbeat com 60 s (< 120 s) ⇒ ainda ocupado");
    check(av(base, "desconhecido").veredicto === "ocupado", "sem conseguir verificar o processo e com heartbeat fresco ⇒ prudência: ocupado");
    check(avaliarLock({ pid: 4242, startedAt: new Date(agora - 7 * 3_600_000).toISOString(), kind: "daily-pipeline" }, { agora, expiraMs: HEARTBEAT_EXPIRA_MS, verificar: () => "vivo" }).veredicto === "reclamavel", "lock rev97 (sem heartbeat) com mais de 6 h ⇒ reclamável");
    check(avaliarLock({ pid: 4242, startedAt: new Date(agora - 600_000).toISOString(), kind: "full-sync" }, { agora, expiraMs: HEARTBEAT_EXPIRA_MS, verificar: () => "vivo" }).veredicto === "ocupado", "lock rev97 recente de processo vivo ⇒ ocupado");

    // com o ficheiro no disco e a função real
    const dir = tmp();
    fs.writeFileSync(lockFilePath(dir), JSON.stringify({ ...base, pid: process.pid, heartbeatEm: new Date(agora - 600_000).toISOString() }));
    const logs: string[] = [];
    const h = await adquirirLock({ modo: "daily-pipeline", dir, log: (l) => logs.push(l), heartbeat: false });
    check(logs.some((l) => /heartbeat expirado/.test(l)) && lerLock(dir).runId === h.runId, "lock de um PID «vivo» (o nosso, reutilizado) mas com heartbeat de 10 min: reclamado");
    h.libertar();
    _reporLockDoProcesso();
    if (process.platform === "win32") {
      fs.writeFileSync(lockFilePath(dir), JSON.stringify({ ...base, pid: process.pid, imagem: "svchost.exe", heartbeatEm: new Date().toISOString() }));
      const logs2: string[] = [];
      const h2 = await adquirirLock({ modo: "daily-pipeline", dir, log: (l) => logs2.push(l), heartbeat: false });
      check(logs2.some((l) => /outro programa/.test(l)), "Windows: PID vivo com imagem diferente da registada (svchost.exe ≠ node.exe) ⇒ reclamado de imediato");
      h2.libertar();
      _reporLockDoProcesso();
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  secao("5 · uma execução nunca liberta nem reescreve o lock de outra");
  {
    const dir = tmp();
    const a = await adquirirLock({ modo: "daily-pipeline", dir, intervaloHeartbeatMs: 150, log: silencio });
    // outra execução reclamou entretanto (ex.: heartbeat expirado durante uma suspensão do PC)
    const outro: ConteudoLock = { versao: 2, runId: "execucao-B", pid: 99999, host: "x", imagem: "node.exe", criadoEm: new Date().toISOString(), heartbeatEm: new Date().toISOString(), modo: "sync-now", dia: null };
    fs.writeFileSync(lockFilePath(dir), JSON.stringify(outro));
    await espera(600); // o worker de A tem de perceber e NÃO reescrever
    check(a.perdido() && lerLock(dir).runId === "execucao-B", "o heartbeat de A não reescreve o lock de B (e A fica a saber que o perdeu)");
    check(a.libertar() === false && fs.existsSync(lockFilePath(dir)) && lerLock(dir).runId === "execucao-B", "A.libertar() NÃO remove o lock de B (compara o runId, não o PID)");
    fs.rmSync(dir, { recursive: true, force: true });
    _reporLockDoProcesso();
  }

  secao("6 · subprocessos herdam o lock do pai; saída normal liberta");
  {
    const dir = tmp();
    const pai = await adquirirLock({ modo: "daily-pipeline", dia: "2026-10-14", dir, log: silencio });
    check(process.env[ENV_LOCK_RUN_ID] === pai.runId, "o runId é exportado para os subprocessos");
    const f = filho("herda", dir, 100, { ...process.env, SPHARMMT_RUN_DIR: dir });
    const r = await f.fim;
    check(r.code === 0 && /ADQUIRIU herdado=true/.test(r.saida) && /LIBERTOU=false/.test(r.saida), "o filho reconhece o lock como herdado e não o liberta");
    check(fs.existsSync(lockFilePath(dir)) && lerLock(dir).runId === pai.runId, "o lock do pai continua intacto");
    const alheio = filho("alheio", dir, 100, { ...process.env, [ENV_LOCK_RUN_ID]: "" });
    const r2 = await alheio.fim;
    check(r2.code === 3 && /RECUSADO/.test(r2.saida), "um processo SEM a herança (ex.: sync-now lançado à parte) é recusado");
    check(pai.libertar() === true && !fs.existsSync(lockFilePath(dir)), "o pai liberta no fim");
    _reporLockDoProcesso();
    const dir2 = tmp();
    const s = filho("saida-normal", dir2);
    await s.fim;
    check(!fs.existsSync(lockFilePath(dir2)), "saída normal do processo: o lock é libertado (handler de exit)");
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(dir2, { recursive: true, force: true });
  }

  secao("7 · reinício durante a espera da retoma + sync-now concorrente");
  {
    const dir = tmp();
    // «daily-pipeline» em espera de retoma: segura o lock com heartbeat ativo
    const emEspera = filho("matar", dir, 1500);
    await aguardar(() => emEspera.saida().includes("ADQUIRIU"));
    const sn = await adquirirLock({ modo: "sync-now", dir, log: silencio }).then(() => "adquiriu", () => "recusado");
    check(sn === "recusado", "durante a espera da retoma (heartbeat ativo) o sync-now é recusado (não corre por cima do pipeline)");
    await emEspera.fim; // morte abrupta = o PC reiniciou a meio da espera
    const logs: string[] = [];
    const h = await adquirirLock({ modo: "daily-pipeline", dia: "2026-10-14", dir, log: (l) => logs.push(l), heartbeat: false });
    check(logs.some((l) => /já não existe/.test(l)), "no arranque seguinte o lock órfão é reclamado e o pipeline avança");
    h.libertar();
    _reporLockDoProcesso();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  secao("8 · só os comandos de escrita têm lock; plan/dry-run não; um só módulo");
  {
    const ler = (f: string) => fs.readFileSync(new URL(f, import.meta.url), "utf8").replace(/\r\n/g, "\n");
    const cli = ler("./cli.ts");
    const conj = /COMANDOS_DE_ESCRITA = new Set\(\[([\s\S]*?)\]\)/.exec(cli)?.[1] ?? "";
    const nomes = [...conj.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    check(nomes.length >= 8 && nomes.every((n) => !/dry-run|preview|discover|audit|test-connection|health|inspect/.test(n)), `o conjunto com lock (${nomes.join(", ")}) não inclui dry-runs, previews, discovery nem test-connection`);
    check(!nomes.includes("daily-pipeline") && !nomes.includes("full-sync") && !nomes.includes("sync-now"), "daily-pipeline, full-sync e sync-now gerem o seu próprio lock (mesmo módulo)");
    for (const f of ["./commands/daily-pipeline.ts", "./commands/full-sync.ts", "./commands/sync-now.ts", "./cli.ts"]) {
      check(/lock-pipeline\.js/.test(ler(f)), `${f.replace("./", "")} usa o módulo único lock-pipeline`);
    }
    check(!/tasklist|isPidAlive/.test(ler("./commands/sync-now.ts")) && !/tasklist/.test(ler("./commands/full-sync.ts")), "sync-now e full-sync deixaram de ter deteção própria por PID");
    check(!/adquirirLock|acquireLock/.test(ler("./commands/daily-sync.ts").split("export async function dailySyncDryRun")[1] ?? ""), "daily-sync-dry-run não adquire lock");
    const dir = tmp();
    check(descreverLock(dir) === "livre" && !fs.existsSync(lockFilePath(dir)), "descreverLock (usado por --plan) é só leitura: não cria lock");
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${ok} OK, ${ko} falhas`);
  process.exit(ko === 0 ? 0 : 1);
}
