/**
 * agent/src/resiliencia-pipeline.test.ts
 *
 * Camada de PIPELINE da resiliência (rev98): retoma de nível superior, recuperação de dias em falta,
 * lock entre processos reais, estado local (pendentes / registos / alertas), configuração rev97,
 * interrupção durante a espera. Determinístico: sem Internet, sem relógio real (`dormir` injetado).
 *
 * Uso: npx tsx agent/src/resiliencia-pipeline.test.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  abrirAlerta,
  alertasAbertos,
  guardarRegistoPendente,
  listarPendentes,
  listarRegistosPendentes,
  registarPendente,
  reenviarAlertasPendentes,
  reenviarRegistosPendentes,
  removerPendente,
  resolverAlertasDoDia,
  type Alerta,
} from "./estado-local.js";
import { classificarDesfecho, correrComRetoma, ROTULO_DESFECHO, type ResultadoTentativa } from "./retoma-pipeline.js";
import { planearDiasDoPipeline } from "./plano-diario.js";
import { acquireLock, lockFilePath, releaseLock } from "./lock-pipeline.js";

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${label}`); }
  else { ko++; console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`); }
};
const secao = (t: string) => console.log(`\n${t}`);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "spharm-res-"));

const OK_: ResultadoTentativa = { rc: 0, status: "OK", transitoria: false };
const TRANSITORIA: ResultadoTentativa = { rc: 1, status: "ERROR", transitoria: true, erro: "SaaS POST /api/ingest/v1/bootstrap/products — falha de rede: fetch failed", passoFalhado: "daily-sync" };
const PERMANENTE: ResultadoTentativa = { rc: 1, status: "ABORTED", transitoria: false, erro: "aggregate-month → HTTP 409 unknowns_present", passoFalhado: "aggregate-month" };

async function retoma(seq: ResultadoTentativa[], over: { total?: number; dormir?: (ms: number) => Promise<void>; antes?: () => void } = {}) {
  const esperas: number[] = [];
  const logs: string[] = [];
  const chamadas: number[] = [];
  const r = await correrComRetoma({
    dia: "2026-10-14",
    totalTentativas: over.total ?? 4,
    esperaMs: 15 * 60_000,
    log: (l) => logs.push(l),
    dormir: over.dormir ?? (async (ms) => { esperas.push(ms); }),
    correr: async (info) => { chamadas.push(info.tentativa); return seq[Math.min(info.tentativa - 1, seq.length - 1)]!; },
    antesDeEsperar: over.antes,
  });
  return { r, esperas, logs, chamadas };
}

async function main() {
  // ═══ Retoma de nível superior ═══
  secao("1 · retoma do pipeline");
  {
    const a = await retoma([OK_]);
    check(a.r.final.status === "OK" && a.r.tentativas === 1 && a.esperas.length === 0 && !a.r.retomado, "dia sem falhas: 1 tentativa, nenhuma espera, nenhuma retoma (comportamento atual)");
    check(a.logs.some((l) => /tentativa 1\/4/.test(l)) && !a.logs.some((l) => /tentativa 2\/4/.test(l)), "log «tentativa 1/4» e nada mais");
  }
  {
    const b = await retoma([TRANSITORIA, OK_]);
    check(b.r.final.status === "OK" && b.r.tentativas === 2 && b.r.retomado, "falha transitória + sucesso: concluído à 2.ª tentativa");
    check(b.esperas.length === 1 && b.esperas[0] === 15 * 60_000, "espera de 15 minutos antes da retoma");
    check(b.logs.some((l) => /tentativa 1\/4/.test(l)) && b.logs.some((l) => /tentativa 2\/4/.test(l)), "log «tentativa 1/4», «2/4»");
    check(b.chamadas.join() === "1,2", "o MESMO dia de referência (o chamador recebe só a tentativa; o dia é fixo)");
    check(classificarDesfecho({ status: "OK", tentativas: 2, pedidosRecuperadosHttp: 0, diaEmFalta: false }) === "CONCLUIDO_APOS_RETOMA", "desfecho: concluído após retoma do pipeline");
  }
  {
    const c = await retoma([TRANSITORIA, TRANSITORIA, TRANSITORIA, OK_]);
    check(c.r.final.status === "OK" && c.r.tentativas === 4 && c.esperas.length === 3, "três retomas (4 tentativas no total) — a última consegue");
    const d = await retoma([TRANSITORIA]);
    check(d.r.final.status === "ERROR" && d.r.tentativas === 4 && d.esperas.length === 3, "falha transitória persistente: 4 tentativas, 3 esperas, falha definitiva");
    check(d.logs.some((l) => /FALHA DEFINITIVA/.test(l)) && d.logs.some((l) => /tentativa 4\/4/.test(l)), "log da falha definitiva e «4/4»");
    check(classificarDesfecho({ status: "ERROR", tentativas: 4, pedidosRecuperadosHttp: 0, diaEmFalta: false }) === "FALHA_DEFINITIVA", "desfecho: falha definitiva");
  }
  {
    const e = await retoma([PERMANENTE, OK_]);
    check(e.r.tentativas === 1 && e.esperas.length === 0 && e.r.final.status === "ABORTED", "falha PERMANENTE (409 de negócio): não retoma, não espera");
    const f = await retoma([{ ...TRANSITORIA, status: "PARTIAL", rc: 2 }, OK_]);
    check(f.r.final.status === "OK" && f.r.tentativas === 2, "PARTIAL transitório (ex.: compras sem SaaS) também retoma");
  }
  check(
    classificarDesfecho({ status: "OK", tentativas: 1, pedidosRecuperadosHttp: 3, diaEmFalta: false }) === "CONCLUIDO_APOS_RETENTATIVA_HTTP" &&
      classificarDesfecho({ status: "OK", tentativas: 1, pedidosRecuperadosHttp: 0, diaEmFalta: false }) === "CONCLUIDO_A_PRIMEIRA" &&
      classificarDesfecho({ status: "OK", tentativas: 1, pedidosRecuperadosHttp: 0, diaEmFalta: true }) === "RECUPERADO_DIA_EM_FALTA" &&
      ROTULO_DESFECHO.RECUPERADO_DIA_EM_FALTA === "recuperado como dia em falta",
    "o resumo distingue: à primeira · após retentativa HTTP · após retoma · dia em falta · falha definitiva",
  );

  // ═══ Duas execuções simultâneas ═══
  secao("2 · duas execuções simultâneas (processos reais): só uma avança");
  {
    const dir = tmp();
    if (process.argv[2] === "--filho") {
      // processo filho: tenta o lock e diz o que aconteceu
      try { await acquireLock(false, "daily-pipeline", "2026-10-14", process.argv[3]); console.log("FILHO:ADQUIRIU"); process.exit(0); } catch { console.log("FILHO:RECUSADO"); process.exit(3); }
    }
    await acquireLock(false, "daily-pipeline", "2026-10-14", dir);
    const filho = () => spawnSync(process.execPath, ["--import", "tsx", process.argv[1]!, "--filho", dir], { encoding: "utf8", env: { ...process.env, SPHARMMT_LOCK_RUN_ID: "" } }); // processo ESTRANHO: sem a herança do lock
    const f1 = filho();
    check(f1.status === 3 && /FILHO:RECUSADO/.test(f1.stdout), "um 2.º processo é RECUSADO enquanto o 1.º tem o lock (incl. durante a espera da retoma)");
    // reentrada: o mesmo processo (retoma) reaproveita o lock
    let reentrou = true;
    try { await acquireLock(false, "daily-pipeline", "2026-10-14", dir); } catch { reentrou = false; }
    check(reentrou, "o próprio processo reentra no lock entre tentativas (não se auto-bloqueia)");
    await releaseLock(dir);
    const f2 = filho();
    check(f2.status === 0 && /FILHO:ADQUIRIU/.test(f2.stdout), "libertado o lock, o outro processo avança");
    fs.rmSync(dir, { recursive: true, force: true });
    void lockFilePath;
  }

  // ═══ Dias em falta ═══
  secao("3 · recuperação automática de dias em falta");
  {
    const dias = (o: Parameters<typeof planearDiasDoPipeline>[0]) => planearDiasDoPipeline(o);
    const feitos = ["2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13"];
    const p1 = dias({ ontem: "2026-10-15", diasOkNoSaas: feitos, pendentesLocais: [], maxDias: 7 });
    check(JSON.stringify(p1.dias) === JSON.stringify(["2026-10-14", "2026-10-15"]), "14/10 falhou e o 15/10 é o dia normal: recupera 14/10 PRIMEIRO, depois 15/10");
    check(p1.ultimoDiaConcluido === "2026-10-13" && p1.diasEmFalta.join() === "2026-10-14", "diagnóstico: último dia concluído confirmado = 13/10; em falta = 14/10");
    const p2 = dias({ ontem: "2026-10-15", diasOkNoSaas: [...feitos, "2026-10-14"], pendentesLocais: [], maxDias: 7 });
    check(JSON.stringify(p2.dias) === JSON.stringify(["2026-10-15"]), "dias já concluídos não se repetem");
    const p3 = dias({ ontem: "2026-10-16", diasOkNoSaas: ["2026-10-09", "2026-10-12", "2026-10-13"], pendentesLocais: [], maxDias: 7 });
    check(JSON.stringify(p3.dias) === JSON.stringify(["2026-10-10", "2026-10-11", "2026-10-14", "2026-10-15", "2026-10-16"]), "vários dias (incl. buracos no meio) por ordem CRONOLÓGICA");
    const p4 = dias({ ontem: "2026-10-02", diasOkNoSaas: ["2026-09-27", "2026-09-28"], pendentesLocais: [], maxDias: 7 });
    check(JSON.stringify(p4.dias) === JSON.stringify(["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]), "mudança de mês: setembro antes de outubro");
    check(new Set(p4.dias.map((d) => d.slice(0, 7))).size === 2, "…e o pipeline agrega cada dia no SEU mês (2026-09 e 2026-10)");
    const p5 = dias({ ontem: "2026-10-30", diasOkNoSaas: ["2026-10-01"], pendentesLocais: [], maxDias: 5 });
    check(p5.dias.length === 5 && p5.adiados.length > 0 && p5.dias[0] === "2026-10-02", "limite configurável: processa 5 (os mais antigos) e REGISTA os adiados");
    const p6 = dias({ ontem: "2026-10-15", diasOkNoSaas: null, pendentesLocais: [{ dia: "2026-10-14", estado: "ERROR", causa: "x", tentativas: 1, primeiraFalhaEm: "", ultimaFalhaEm: "" }], maxDias: 7 });
    check(p6.semConfirmacaoDoSaas && JSON.stringify(p6.dias) === JSON.stringify(["2026-10-14", "2026-10-15"]), "SaaS não informa: usa a pista local + dia normal");
    check(p6.diagnostico.some((l) => /não conseguiu informar o último dia concluído/.test(l)), "…e deixa um diagnóstico CLARO");
    const p7 = dias({ ontem: "2026-10-15", diasOkNoSaas: null, pendentesLocais: [], maxDias: 7 });
    check(JSON.stringify(p7.dias) === JSON.stringify(["2026-10-15"]) && p7.semConfirmacaoDoSaas, "SaaS não informa e sem pista local: só o dia normal (nunca recupera um período ilimitado)");
    const p8 = dias({ ontem: "2026-10-15", diasOkNoSaas: [...feitos, "2026-10-14"], pendentesLocais: [{ dia: "2026-10-14", estado: "ERROR", causa: "x", tentativas: 1, primeiraFalhaEm: "", ultimaFalhaEm: "" }], maxDias: 7 });
    check(p8.pendentesJaConcluidos.join() === "2026-10-14" && !p8.dias.includes("2026-10-14"), "o SaaS manda: pista local de um dia que o SaaS dá como concluído é descartada");
  }

  // ═══ Estado local ═══
  secao("4 · estado local: pendentes, interrupção durante a espera, registos e alertas");
  {
    const dir = tmp();
    // 19) o processo é interrompido DURANTE a espera (reinício do PC): o pendente já está gravado
    let interrompido = false;
    try {
      await correrComRetoma({
        dia: "2026-10-14", totalTentativas: 4, esperaMs: 900_000, log: () => undefined,
        correr: async () => TRANSITORIA,
        antesDeEsperar: (r, _i, retomaEm) => { registarPendente(dir, { dia: "2026-10-14", estado: r.status, causa: r.erro ?? "", retomaPrevistaEm: retomaEm }); },
        dormir: async () => { throw new Error("SIGKILL (reinício do computador)"); },
      });
    } catch { interrompido = true; }
    const pend = listarPendentes(dir);
    check(interrompido && pend.length === 1 && pend[0]!.dia === "2026-10-14" && !!pend[0]!.retomaPrevistaEm, "interrupção a meio da espera: o dia fica registado como pendente (com a retoma prevista)");
    const depois = planearDiasDoPipeline({ ontem: "2026-10-15", diasOkNoSaas: ["2026-10-13"], pendentesLocais: pend, maxDias: 7 });
    check(JSON.stringify(depois.dias) === JSON.stringify(["2026-10-14", "2026-10-15"]), "no arranque seguinte o dia é recuperado, depois o dia normal — sem intervenção manual");
    removerPendente(dir, "2026-10-14");
    check(listarPendentes(dir).length === 0, "concluído o dia, o pendente é removido");
    // ficheiro corrompido nunca derruba o pipeline
    fs.writeFileSync(path.join(dir, "pipeline-pendentes.json"), "{lixo");
    check(listarPendentes(dir).length === 0, "estado local ilegível é tratado como vazio (não rebenta)");

    // 15) registo PipelineRun sem duplicar
    const corpo = { farmaciaId: "f1", kind: "daily-pipeline", status: "OK", idempotencyKey: "daily-pipeline:f1:2026-10-14:2026-10-15T02:00:00.000Z" };
    guardarRegistoPendente(dir, corpo);
    guardarRegistoPendente(dir, { ...corpo, status: "ERROR" });
    check(listarRegistosPendentes(dir).length === 1, "PipelineRun: a mesma idempotencyKey guarda UM só registo local");
    check(guardarRegistoPendente(dir, { farmaciaId: "f1" } as { idempotencyKey?: string }) === null, "sem idempotencyKey não se guarda (não haveria garantia contra duplicados)");
    const servidor = new Map<string, number>();
    let falhar = true;
    const enviar = async (b: Record<string, unknown>) => {
      if (falhar) throw new Error("SaaS indisponível");
      const k = String(b.idempotencyKey);
      servidor.set(k, (servidor.get(k) ?? 0) + 1); // upsert por chave
    };
    const r1 = await reenviarRegistosPendentes(dir, enviar, () => undefined);
    check(r1.falhados === 1 && r1.enviados === 0 && listarRegistosPendentes(dir).length === 1, "SaaS inacessível: o registo continua guardado (nada se perde)");
    falhar = false;
    const r2 = await reenviarRegistosPendentes(dir, enviar, () => undefined);
    const r3 = await reenviarRegistosPendentes(dir, enviar, () => undefined);
    check(r2.enviados === 1 && r3.enviados === 0 && servidor.size === 1 && servidor.get(corpo.idempotencyKey) === 1, "recuperado o SaaS: enviado UMA vez e removido do disco (sem duplicados)");

    // 16) falha do alerta não apaga a causa original
    const dadosAlerta = { farmacia: "Silveirense", dia: "2026-10-14", causa: "daily-sync:ERROR:transitoria", mensagem: "fetch failed" };
    const a1 = await abrirAlerta(dir, dadosAlerta, async () => { throw new Error("healthchecks.io inacessível"); });
    check(!a1.notificou && !!a1.erroNotificacao && a1.alerta.causa === dadosAlerta.causa, "falha do envio: o alerta NÃO notifica…");
    check(alertasAbertos(dir).length === 1 && alertasAbertos(dir)[0]!.notificadoEm === null && /inacessível/.test(alertasAbertos(dir)[0]!.ultimoErroNotificacao ?? ""), "…mas a causa original continua gravada e visível, com o erro da notificação");
    let envios = 0;
    const notif = async (_a: Alerta) => { envios++; };
    const rr = await reenviarAlertasPendentes(dir, notif);
    check(rr.reenviados === 1 && envios === 1, "no arranque seguinte o alerta é reenviado");
    const a2 = await abrirAlerta(dir, dadosAlerta, notif);
    const a3 = await abrirAlerta(dir, dadosAlerta, notif);
    check(envios === 1 && !a2.notificou && !a3.notificou, "mesma farmácia+dia+causa: SEM notificações duplicadas");
    const a4 = await abrirAlerta(dir, { ...dadosAlerta, causa: "aggregate-month:ABORTED:permanente" }, notif);
    check(a4.notificou && envios === 2, "causa diferente: nova notificação");
    const res = resolverAlertasDoDia(dir, "Silveirense", "2026-10-14");
    check(res.length === 2 && alertasAbertos(dir).length === 0, "recuperação do dia: os alertas ficam resolvidos");
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ═══ Configuração rev97 ═══
  secao("5 · compatibilidade com a configuração rev97");
  {
    const dir = tmp();
    const cwd = process.cwd();
    const rev97 = {
      saas: { endpoint: "https://exemplo.invalido", tenantSlug: "silveira", ingestKey: "CHAVE-DE-TESTE-123456", farmacia: "Farmácia Silveirense", healthcheckUrl: "https://hc-ping.invalido/uuid" },
      sqlServer: { host: "localhost", port: 1433, database: "Spharm", user: "u", password: "p", encrypt: false, trustServerCertificate: true },
      options: { allowUnknowns: true, allowOrphans: false },
    };
    const antigas = { ...process.env };
    try {
      for (const k of Object.keys(process.env)) if (/^(SPHARMMT_|ERP_SQLSERVER_)/.test(k)) delete process.env[k];
      fs.writeFileSync(path.join(dir, "agent.config.json"), JSON.stringify(rev97));
      process.chdir(dir);
      // O caminho do agent.config.json fixa-se ao carregar o módulo: importa-se DEPOIS do chdir.
      const { loadConfig } = await import("./config.js");
      const c = loadConfig("both");
      check(c.saasEndpoint === "https://exemplo.invalido" && c.tenantSlug === "silveira" && c.allowUnknowns === true, "um agent.config.json rev97 (sem as opções novas) carrega sem alterações");
      check(c.politicaRetry.esperasMs.join() === "5000,15000,30000,60000" && c.politicaRetry.timeoutMs === 30_000, "defaults seguros: retentativas 5/15/30/60 s, timeout 30 s");
      check(c.pipelineTentativas === 4 && c.pipelineEsperaMs === 15 * 60_000 && c.catchUpMaxDias === 7, "defaults seguros: 4 tentativas de pipeline, 15 min, 7 dias de catch-up");

      for (const k of Object.keys(process.env)) if (/^(SPHARMMT_|ERP_SQLSERVER_)/.test(k)) delete process.env[k];
      fs.writeFileSync(path.join(dir, "agent.config.json"), JSON.stringify({ ...rev97, options: { ...rev97.options, httpRetryDelaysMs: [1000, 2000], httpTimeoutMs: 45000, pipelineMaxAttempts: 3, pipelineRetryWaitMinutes: 10, catchUpMaxDays: 14 } }));
      const c2 = loadConfig("both");
      check(c2.politicaRetry.esperasMs.join() === "1000,2000" && c2.politicaRetry.timeoutMs === 45_000 && c2.pipelineTentativas === 3 && c2.pipelineEsperaMs === 10 * 60_000 && c2.catchUpMaxDias === 14, "as opções novas (opcionais) são respeitadas");

      for (const k of Object.keys(process.env)) if (/^(SPHARMMT_|ERP_SQLSERVER_)/.test(k)) delete process.env[k];
      fs.writeFileSync(path.join(dir, "agent.config.json"), JSON.stringify({ ...rev97, options: { httpRetryDelaysMs: "lixo", pipelineMaxAttempts: -2, catchUpMaxDays: "x" } }));
      const c3 = loadConfig("both");
      check(c3.politicaRetry.esperasMs.length === 4 && c3.pipelineTentativas === 4 && c3.catchUpMaxDias === 7, "valores inválidos caem nos defaults (nunca partem o agent)");
    } finally {
      process.chdir(cwd);
      for (const k of Object.keys(process.env)) if (/^(SPHARMMT_|ERP_SQLSERVER_)/.test(k)) delete process.env[k];
      Object.assign(process.env, antigas);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log(`\n${ok} OK, ${ko} falhas`);
  process.exit(ko === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
