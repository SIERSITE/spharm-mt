/**
 * agent/src/lock-heartbeat.test.ts
 *
 * Lock único com heartbeat e IDENTIDADE do proprietário (`lock-pipeline.ts`, `identidade-processo.ts`) — com PROCESSOS REAIS
 * (filhos) sempre que o cenário o exige e com o sistema operativo SIMULADO onde é preciso determinismo.
 *
 * Regra central: um heartbeat expirado, por si só, NUNCA permite reclamar um lock cujo proprietário continua vivo com a mesma
 * identidade (computador suspenso, processo bloqueado, worker atrasado).
 *
 * Uso: npx tsx agent/src/lock-heartbeat.test.ts
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import {
  ENV_LOCK_RUN_ID,
  ErroLockOcupado,
  ErroLockPerdido,
  HEARTBEAT_EXPIRA_MS,
  _reporLockDoProcesso,
  adquirirLock,
  avaliarLock,
  descreverLock,
  exigirLock,
  lockFilePath,
  lockPerdidoAgora,
  type ConteudoLock,
} from "./lock-pipeline.js";
import { sistemaReal, compararIdentidade, type IdentidadeProcesso, type SistemaLock } from "./identidade-processo.js";
import { correrSubcomando } from "./subprocesso.js";
import { SaasClient } from "./http-client.js";

const espera = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Modo filho ────────────────────────────────────────────────────────
if (process.argv[2] === "--filho") {
  const [, , , modo, dir, extra] = process.argv;
  (async () => {
    try {
      const h = await adquirirLock({ modo: `filho-${modo}`, dia: "2026-10-14", dir, intervaloHeartbeatMs: modo === "sem-hb" ? 60_000 : 200, expiraMs: 1500, log: (l) => console.log(`LOG ${l}`) });
      console.log(`ADQUIRIU herdado=${h.herdado} runId=${h.runId}`);
      if (modo === "matar") {
        await espera(Number(extra ?? 700)); // deixa o heartbeat bater, depois morre SEM libertar nada (TerminateProcess)
        process.kill(process.pid, "SIGKILL");
        await espera(5000);
      } else if (modo === "saida-normal") {
        process.exit(0); // o handler de 'exit' liberta o lock
      } else if (modo === "perde") {
        // Mantém-se a escrever «periodicamente»; assim que o lock deixa de ser seu, para ANTES da próxima escrita.
        const t0 = Date.now();
        while (Date.now() - t0 < Number(extra ?? 6000)) {
          if (lockPerdidoAgora()) {
            let abortou = false;
            try { exigirLock(); } catch (e) { abortou = e instanceof ErroLockPerdido; }
            console.log(`PERDEU abortou=${abortou} libertou=${h.libertar()}`);
            process.exit(4);
          }
          await espera(100);
        }
        console.log("NAO-PERDEU");
      } else if (modo === "tenta") {
        console.log("ADQUIRIU-INESPERADO");
      } else {
        await espera(Number(extra ?? 1500));
        console.log(`LIBERTOU=${h.libertar()}`);
      }
      process.exit(0);
    } catch (e) {
      console.log(e instanceof ErroLockOcupado ? `RECUSADO ${e.message}` : `ERRO ${(e as Error).message}`);
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

async function aguardar(cond: () => boolean, ms = 20_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await espera(50);
  }
  return cond();
}

/** Sistema operativo SIMULADO: o que o `identidadeDe` devolve para cada PID e o arranque do sistema. */
function sistemaFalso(o: { propria?: IdentidadeProcesso; processos?: Record<number, IdentidadeProcesso | "morto" | "desconhecido">; boot?: number | null }): SistemaLock {
  const propria = o.propria ?? { pid: process.pid, inicioMs: 1_000_000, caminho: "C:\\agent\\node.exe", imagem: "node.exe" };
  return {
    identidadePropria: () => propria,
    identidadeDe: (pid) => o.processos?.[pid] ?? "morto",
    bootMs: () => (o.boot === undefined ? 5_000_000 : o.boot),
  };
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
  const escreverLock = (dir: string, c: Partial<ConteudoLock> & { runId: string }) => fs.writeFileSync(lockFilePath(dir), JSON.stringify(c));
  const silencio = () => undefined;
  delete process.env[ENV_LOCK_RUN_ID];

  secao("1 · conteúdo do lock (identidade) e heartbeat ativo");
  {
    const dir = tmp();
    const f = filho("segura", dir, 3500);
    await aguardar(() => f.saida().includes("ADQUIRIU"));
    const l1 = lerLock(dir);
    check(l1.versao === 2 && /^[0-9a-f-]{36}$/.test(l1.runId) && typeof l1.pid === "number" && l1.modo === "filho-segura" && l1.dia === "2026-10-14", "tem runId aleatório, pid, modo e dia de referência");
    check(!!l1.criadoEm && !!l1.heartbeatEm && !!l1.host && l1.imagem.length > 0 && !!l1.caminhoImagem, "tem criadoEm, heartbeatEm, host, imagem e caminho do executável");
    check(typeof l1.inicioProcessoMs === "number" && Math.abs(l1.inicioProcessoMs - Date.now()) < 300_000, `tem o instante de CRIAÇÃO do processo dado pelo sistema (${new Date(l1.inicioProcessoMs ?? 0).toISOString()})`);
    check(typeof l1.bootMs === "number" && l1.bootMs < Date.now(), `tem o instante de ARRANQUE do sistema (${new Date(l1.bootMs ?? 0).toISOString()})`);
    check(!/token|password|ingestKey|secret/i.test(JSON.stringify(l1)), "não contém segredos");
    await espera(900);
    const l2 = lerLock(dir);
    check(Date.parse(l2.heartbeatEm) > Date.parse(l1.heartbeatEm) && l2.runId === l1.runId, "o heartbeat avança (thread dedicado) com o mesmo runId");
    const t = filho("tenta", dir);
    const rt = await t.fim;
    check(rt.code === 3 && /RECUSADO/.test(rt.saida), "heartbeat ativo + processo vivo: uma 2.ª execução é RECUSADA");
    const r = await f.fim;
    check(/LIBERTOU=true/.test(r.saida) && !fs.existsSync(lockFilePath(dir)), "o dono liberta o seu lock (runId confere)");
    fs.rmSync(dir, { recursive: true, force: true });
  }

  secao("2 · concorrência: 5 processos a tentar ao mesmo tempo — só um avança");
  {
    const dir = tmp();
    const fs5 = Array.from({ length: 5 }, () => filho("segura", dir, 2500));
    const rs = await Promise.all(fs5.map((f) => f.fim));
    const adquiriram = rs.filter((r) => /ADQUIRIU/.test(r.saida)).length;
    const recusados = rs.filter((r) => /RECUSADO/.test(r.saida)).length;
    check(adquiriram === 1 && recusados === 4, `1 adquiriu, 4 recusados (adquiriram=${adquiriram}, recusados=${recusados})`);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  secao("3 · processo terminado abruptamente: o lock órfão recupera-se logo (sem esperar horas)");
  {
    const dir = tmp();
    const f = filho("matar", dir, 700);
    await f.fim;
    check(fs.existsSync(lockFilePath(dir)), "o lock fica no disco depois da morte abrupta");
    const logs: string[] = [];
    const t0 = Date.now();
    const h = await adquirirLock({ modo: "daily-pipeline", dia: "2026-10-14", dir, log: (l) => logs.push(l), heartbeat: false });
    check(!h.herdado && Date.now() - t0 < 20_000, `reclamado de imediato (${Date.now() - t0} ms)`);
    check(logs.some((l) => /já não existe/.test(l)), "motivo registado: o processo já não existe (confirmado pelo sistema operativo)");
    check(lerLock(dir).pid === process.pid, "o lock passou a ser desta execução");
    h.libertar();
    _reporLockDoProcesso();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  secao("4 · matriz de decisão (sistema operativo simulado)");
  {
    const agora = 10_000_000_000;
    const eu: IdentidadeProcesso = { pid: 4242, inicioMs: 1_000_000, caminho: "C:\\agent\\node.exe", imagem: "node.exe" };
    const base: ConteudoLock = {
      versao: 2, runId: "r1", pid: 4242, host: os.hostname(), imagem: "node.exe", caminhoImagem: "C:\\agent\\node.exe", inicioProcessoMs: 1_000_000, bootMs: 5_000_000,
      criadoEm: new Date(agora - 600_000).toISOString(), heartbeatEm: new Date(agora - 1_000).toISOString(), modo: "daily-pipeline", dia: "2026-10-14",
    };
    const av = (c: Partial<ConteudoLock>, sis: SistemaLock) => avaliarLock({ ...base, ...c }, { agora, expiraMs: HEARTBEAT_EXPIRA_MS, sistema: sis, hostLocal: os.hostname() });
    const vivo = sistemaFalso({ processos: { 4242: eu } });

    check(av({}, vivo).veredicto === "ocupado", "processo vivo, mesma identidade, heartbeat fresco ⇒ ocupado");
    const atrasado = av({ heartbeatEm: new Date(agora - 600_000).toISOString() }, vivo);
    check(atrasado.veredicto === "ocupado" && /vivo com heartbeat atrasado/.test((atrasado as { motivo: string }).motivo), "processo vivo, mesma identidade, heartbeat com 10 MINUTOS ⇒ OCUPADO («vivo com heartbeat atrasado»)");
    check(av({ heartbeatEm: new Date(agora - 24 * 3_600_000).toISOString() }, vivo).veredicto === "ocupado", "…mesmo com o heartbeat parado há 24 h (computador suspenso um dia inteiro)");
    check(av({}, sistemaFalso({ processos: { 4242: "morto" } })).veredicto === "reclamavel", "processo morto ⇒ reclamável");
    check(av({}, sistemaFalso({ processos: { 4242: { ...eu, imagem: "svchost.exe", caminho: "C:\\Windows\\svchost.exe" } } })).veredicto === "reclamavel", "PID de OUTRO executável ⇒ reclamável");
    const outroNode = av({}, sistemaFalso({ processos: { 4242: { ...eu, inicioMs: 9_000_000 } } }));
    check(outroNode.veredicto === "reclamavel" && /PID foi reutilizado/.test((outroNode as { motivo: string }).motivo), "PID reutilizado por OUTRO node.exe (mesmo nome e caminho, criação diferente) ⇒ reclamável");
    check(av({}, sistemaFalso({ processos: { 4242: { ...eu, inicioMs: 1_001_500 } } })).veredicto === "ocupado", "diferença de 1,5 s no instante de criação (arredondamento) ⇒ mesma identidade");
    const reboot = av({ bootMs: 5_000_000 - 3_600_000 }, vivo);
    check(reboot.veredicto === "reclamavel" && /arranque do sistema mudou/.test((reboot as { motivo: string }).motivo), "arranque do Windows diferente ⇒ reclamável (o PID só coincide por acaso)");
    check(av({ bootMs: 5_000_000 - 30_000 }, vivo).veredicto === "ocupado", "arranque que difere só 30 s (tolerância do relógio/Fast Startup) ⇒ ocupado");
    check(av({}, sistemaFalso({ processos: { 4242: "desconhecido" } })).veredicto === "ocupado", "não é possível apurar o processo ⇒ prudência: ocupado");
    check(av({ inicioProcessoMs: null }, vivo).veredicto === "ocupado", "sem instante de criação registado, a identidade não se prova ⇒ ocupado (nunca por palpite)");
    check(av({ heartbeatEm: new Date(agora - 600_000).toISOString() }, sistemaFalso({ processos: { 4242: "morto" } })).veredicto === "reclamavel", "heartbeat expirado + processo morto ⇒ reclamável");
    check(av({ host: "OUTRO-PC" }, vivo).veredicto === "ocupado", "lock de outro computador ⇒ ocupado");
    check(avaliarLock(null, { agora, expiraMs: HEARTBEAT_EXPIRA_MS, sistema: vivo, mtimeMs: agora - 600_000 }).veredicto === "reclamavel", "registo inválido, parado e sem proprietário comprovável ⇒ reclamável");
    check(avaliarLock(null, { agora, expiraMs: HEARTBEAT_EXPIRA_MS, sistema: vivo, mtimeMs: agora - 5_000 }).veredicto === "ocupado", "registo inválido mas recente ⇒ ocupado");
    check(avaliarLock({ pid: 4242, startedAt: new Date(agora - 7 * 3_600_000).toISOString(), kind: "daily-pipeline" }, { agora, expiraMs: HEARTBEAT_EXPIRA_MS, sistema: vivo }).veredicto === "reclamavel", "lock rev97 (sem identidade) com mais de 6 h ⇒ reclamável");
    check(avaliarLock({ pid: 4242, startedAt: new Date(agora - 600_000).toISOString(), kind: "full-sync" }, { agora, expiraMs: HEARTBEAT_EXPIRA_MS, sistema: vivo }).veredicto === "ocupado", "lock rev97 recente de processo vivo ⇒ ocupado");
    check(compararIdentidade({ imagem: "node.exe", inicioProcessoMs: 1000 }, { pid: 1, inicioMs: 1000, caminho: null, imagem: "node.exe" }).veredicto === "mesma", "compararIdentidade: mesma");
  }

  secao("5 · SUSPENSÃO do computador: heartbeat expirado, processo vivo — a 2.ª execução é recusada e o dono retoma");
  {
    const dir = tmp();
    // 1. A adquire o lock (processo real, identidade real obtida do Windows/Linux), heartbeat rápido para a retoma ser observável
    const A = await adquirirLock({ modo: "daily-pipeline", dia: "2026-10-14", dir, intervaloHeartbeatMs: 1500, log: silencio });
    const original = lerLock(dir);
    // 2. o computador «suspende»: o heartbeat fica com >120 s (10 minutos)
    escreverLock(dir, { ...original, heartbeatEm: new Date(Date.now() - 600_000).toISOString() });
    // 3. o processo A continua vivo e com a mesma identidade — 4. B tenta iniciar (processo real)
    const B = filho("tenta", dir, undefined, { ...process.env, [ENV_LOCK_RUN_ID]: "" });
    const rb = await B.fim;
    // 5. B é recusada, com o diagnóstico certo
    check(rb.code === 3 && /RECUSADO/.test(rb.saida), "B é RECUSADA com o heartbeat de A expirado há 10 minutos");
    check(/vivo com heartbeat atrasado/.test(rb.saida), "mensagem: «processo proprietário vivo com heartbeat atrasado»");
    const diag = path.join(dir, "pipeline-lock-diagnostico.json");
    check(fs.existsSync(diag) && /heartbeatAtrasado/.test(fs.readFileSync(diag, "utf8")), "fica um diagnóstico em run/pipeline-lock-diagnostico.json");
    check(lerLock(dir).runId === original.runId && lerLock(dir).pid === process.pid, "o lock continua a ser de A (não foi reclamado)");
    // 6. A retoma o heartbeat e mantém a propriedade
    await aguardar(() => Date.now() - Date.parse(lerLock(dir).heartbeatEm) < 5_000, 10_000);
    check(Date.now() - Date.parse(lerLock(dir).heartbeatEm) < 5_000 && lerLock(dir).runId === original.runId && !A.perdido(), "A retoma o heartbeat (agora fresco) e mantém a propriedade (perdido() = false)");
    check(!lockPerdidoAgora(), "A não se considera «perdida»");
    check(A.libertar() === true, "A liberta o seu lock no fim");
    _reporLockDoProcesso();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  secao("6 · PID reutilizado por OUTRO node.exe, arranque diferente, --force (processos reais)");
  {
    // um processo «vivo» qualquer para emprestar o PID
    const alvo = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"]);
    await espera(1500);
    const real = sistemaReal.identidadeDe(alvo.pid!);
    check(typeof real === "object" && real.inicioMs !== null && /node/i.test(real.imagem), `o sistema devolve a identidade de um node.exe vivo (início ${typeof real === "object" && real.inicioMs ? new Date(real.inicioMs).toISOString() : "?"})`);
    const idReal = real as IdentidadeProcesso;
    const dir = tmp();
    const baseReal: Partial<ConteudoLock> & { runId: string } = {
      versao: 2, runId: "dono-original", pid: alvo.pid!, host: os.hostname(), imagem: idReal.imagem, caminhoImagem: idReal.caminho, inicioProcessoMs: idReal.inicioMs,
      bootMs: sistemaReal.bootMs(), criadoEm: new Date().toISOString(), heartbeatEm: new Date(Date.now() - 900_000).toISOString(), modo: "daily-pipeline", dia: "2026-10-14",
    };
    // a) mesmo PID, mesmo executável, MESMO início, heartbeat expirado ⇒ proprietário vivo: RECUSA
    escreverLock(dir, baseReal);
    const r = await adquirirLock({ modo: "sync-now", dir, log: silencio, heartbeat: false }).then(() => "adquiriu", (e) => (e instanceof ErroLockOcupado && /vivo com heartbeat atrasado/.test(e.message) ? "recusado-atrasado" : "erro"));
    check(r === "recusado-atrasado", "processo vivo (real), mesma identidade, heartbeat expirado há 15 min ⇒ RECUSADO");
    // b) PID reutilizado por outro node.exe: mesmo nome e caminho, criação diferente
    escreverLock(dir, { ...baseReal, inicioProcessoMs: (idReal.inicioMs ?? 0) - 3_600_000 });
    const logs: string[] = [];
    let h = await adquirirLock({ modo: "daily-pipeline", dir, log: (l) => logs.push(l), heartbeat: false });
    check(logs.some((l) => /PID foi reutilizado/.test(l)) && lerLock(dir).runId === h.runId, "PID reutilizado por outro node.exe (criação diferente em 1 h) ⇒ reclamado, com o motivo registado");
    h.libertar(); _reporLockDoProcesso();
    // c) arranque do Windows diferente
    escreverLock(dir, { ...baseReal, bootMs: (sistemaReal.bootMs() ?? Date.now()) - 86_400_000, heartbeatEm: new Date().toISOString() });
    const logs2: string[] = [];
    h = await adquirirLock({ modo: "daily-pipeline", dir, log: (l) => logs2.push(l), heartbeat: false });
    check(logs2.some((l) => /arranque do sistema mudou/.test(l)), "arranque do sistema diferente (processo «vivo» só por coincidência de PID) ⇒ reclamado");
    h.libertar(); _reporLockDoProcesso();
    // d) executável diferente com o mesmo PID
    escreverLock(dir, { ...baseReal, imagem: "svchost.exe", caminhoImagem: "C:\\Windows\\System32\\svchost.exe" });
    const logs3: string[] = [];
    h = await adquirirLock({ modo: "daily-pipeline", dir, log: (l) => logs3.push(l), heartbeat: false });
    check(logs3.some((l) => /outro executável/.test(l)), "mesmo PID mas executável diferente ⇒ reclamado");
    h.libertar(); _reporLockDoProcesso();
    alvo.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  secao("7 · perda REAL da propriedade: a execução aborta antes de escrever; nada apaga o lock de outra");
  {
    const dir = tmp();
    // dono A (processo real) que escreve periodicamente e vigia o lock
    const A = filho("perde", dir, 15_000);
    await aguardar(() => A.saida().includes("ADQUIRIU"));
    const lockA = lerLock(dir);
    // B toma o lock COM --force, conscientemente
    const logs: string[] = [];
    const B = await adquirirLock({ modo: "daily-pipeline", dir, force: true, log: (l) => logs.push(l), heartbeat: false });
    check(logs.some((l) => /--force/.test(l)) && lerLock(dir).runId === B.runId && B.runId !== lockA.runId, "--force reclama mesmo com o proprietário vivo (decisão consciente do operador)");
    const ra = await A.fim;
    check(ra.code === 4 && /PERDEU abortou=true libertou=false/.test(ra.saida), "A deteta a perda, ABORTA (exigirLock lança ErroLockPerdido) e NÃO apaga o lock de B (libertou=false)");
    check(lerLock(dir).runId === B.runId, "o lock continua a ser de B");
    check(B.libertar() === true && !fs.existsSync(lockFilePath(dir)), "só B liberta o seu");
    _reporLockDoProcesso();

    // Escritas: o cliente HTTP não escreve depois de perder o lock (mas continua a poder ler e a registar o resultado)
    const pedidos: Array<{ m: string; u: string }> = [];
    const srv = http.createServer((req, res) => { req.resume(); req.on("end", () => { pedidos.push({ m: req.method ?? "", u: (req.url ?? "").split("?")[0]! }); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, accepted: 0, upserted: 0, skipped: [], errors: [], farmacias: [], pipelineRunId: "x" })); }); });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const cliente = new SaasClient({ saasEndpoint: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, tenantSlug: "t", ingestKey: "CHAVE-TESTE-123456", agentVersion: "t" }, { politica: { esperasMs: [], jitter: 0, retryAfterMaxMs: 0, timeoutMs: 5000 }, log: silencio });
    const A2 = await adquirirLock({ modo: "daily-pipeline", dir, log: silencio, sistema: sistemaFalso({}), heartbeat: false });
    await cliente.bootstrapProducts({ farmaciaId: "f", items: [] });
    check(pedidos.filter((p) => p.m === "POST").length === 1, "com o lock, a escrita segue");
    // outra execução reclama (ex.: --force) enquanto A2 «dorme»
    escreverLock(dir, { ...lerLock(dir), runId: "nova-dona", pid: 77777 });
    let erro: unknown;
    try { await cliente.bootstrapProducts({ farmaciaId: "f", items: [{ x: 1 }] }); } catch (e) { erro = e; }
    check(erro instanceof ErroLockPerdido && pedidos.filter((p) => p.m === "POST").length === 1, "sem o lock: a escrita é ABORTADA antes de ser enviada (nenhum POST chegou ao servidor)");
    check(!(erro as { transitoria?: boolean }).transitoria, "ErroLockPerdido nunca é transitório (não se repete nem se retoma)");
    let lerOk = true;
    try { await cliente.listFarmacias(); } catch { lerOk = false; }
    check(lerOk && pedidos.some((p) => p.m === "GET"), "leituras (GET) continuam possíveis");
    let regOk = true;
    try { await cliente.pipelineRecord({ farmaciaId: "f", kind: "daily-pipeline", status: "ABORTED", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() }); } catch { regOk = false; }
    check(regOk, "o registo do resultado (PipelineRun ABORTED) ainda pode ser enviado");
    let ex = false;
    try { exigirLock(); } catch (e) { ex = e instanceof ErroLockPerdido; }
    check(ex && A2.libertar() === false && lerLock(dir).runId === "nova-dona", "exigirLock() lança e A2.libertar() NÃO remove o lock da nova dona");
    _reporLockDoProcesso();
    await new Promise<void>((r) => srv.close(() => r()));

    // Subprocessos controlados são TERMINADOS
    fs.rmSync(dir, { recursive: true, force: true });
    let perdeu = false;
    const t1 = Date.now();
    const longo = correrSubcomando(["-e", "setTimeout(()=>{}, 60000)"], process.env, { perdido: () => perdeu, intervaloMs: 200, log: silencio, nome: "filho-longo" });
    setTimeout(() => { perdeu = true; }, 800);
    const rcPerda = await longo;
    check(rcPerda === 1 && Date.now() - t1 < 15_000, `com o lock perdido o subprocesso é terminado (exit ${rcPerda}, ${Date.now() - t1} ms em vez de 60 s)`);
  }

  secao("8 · subprocessos herdam o lock do pai; saída normal liberta; reinício durante a espera");
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
    // reinício do PC durante a espera da retoma: dono morre sem libertar; entretanto sync-now é recusado; depois é reclamado
    const dir3 = tmp();
    const emEspera = filho("matar", dir3, 2500);
    await aguardar(() => emEspera.saida().includes("ADQUIRIU"));
    const sn = filho("tenta", dir3, undefined, { ...process.env, [ENV_LOCK_RUN_ID]: "" });
    const rsn = await sn.fim;
    check(rsn.code === 3, "durante a espera da retoma o sync-now é recusado");
    await emEspera.fim;
    const logs: string[] = [];
    const h = await adquirirLock({ modo: "daily-pipeline", dia: "2026-10-14", dir: dir3, log: (l) => logs.push(l), heartbeat: false });
    check(logs.some((l) => /já não existe/.test(l)), "depois da morte do dono, o lock órfão é reclamado e o pipeline avança");
    h.libertar(); _reporLockDoProcesso();
    for (const d of [dir, dir2, dir3]) fs.rmSync(d, { recursive: true, force: true });
  }

  secao("9 · só os comandos de escrita têm lock; plan/dry-run não; um só módulo; guardas ligadas");
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
    const http_ = ler("./http-client.ts");
    check(/if \(method !== "GET" && !opts\.semGuarda\) verificarGuardaEscrita\(\);/.test(http_), "o cliente HTTP verifica a propriedade do lock antes de CADA escrita (e de cada retentativa)");
    check(/semGuarda: true/.test(http_) && (http_.match(/semGuarda: true/g) ?? []).length === 1, "só o registo do PipelineRun está isento da guarda");
    const dp = ler("./commands/daily-pipeline.ts");
    check((dp.match(/exigirLock\(\)/g) ?? []).length >= 5 && /perdido: lockPerdidoAgora/.test(dp) && /LOCK PERDIDO/.test(dp), "daily-pipeline: pontos seguros entre fases, subprocessos vigiados e ABORTED claro ao perder o lock");
    check(/exigirLock\(\)/.test(ler("./commands/full-sync.ts")) && /perdido: lockPerdidoAgora/.test(ler("./commands/full-sync.ts")), "full-sync: idem");
    check(!/spawnSync/.test(dp.split("async function correrComandoDoDia")[1]?.split("export const PIPELINES_DIARIOS_EXTRA")[0] ?? "x"), "os subcomandos do pipeline são assíncronos (o pai pode reagir à perda do lock)");
    const dir = tmp();
    check(descreverLock(dir) === "livre" && !fs.existsSync(lockFilePath(dir)), "descreverLock (usado por --plan) é só leitura: não cria lock");
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${ok} OK, ${ko} falhas`);
  process.exit(ko === 0 ? 0 : 1);
}
