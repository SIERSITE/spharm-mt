/**
 * scripts/tests/test-infarmed-atualizacao-db.ts
 *
 * Atualização mensal do INFARMED (dia 1, formulário público), alertas/email,
 * upload manual (ações da página /admin/infarmed), tenants e retry — contra
 * PostgreSQL REAL e DESCARTÁVEL (control plane + dois tenants):
 *
 *   docker run -d --name spharm-mg-pg -e POSTGRES_PASSWORD=test -p 15433:5432 postgres:16-alpine
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres npx tsx scripts/tests/test-infarmed-atualizacao-db.ts
 */
import Module from "node:module";
import fs from "node:fs";
import os from "node:os";
import { execSync } from "node:child_process";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import * as XLSX from "xlsx";
import { smtpSink } from "../e2e/_infarmed-comum";
import type { Dependencias, MensagemEmail } from "../../lib/regulamentar/infarmed-atualizacao";

const M = Module as unknown as { _resolveFilename: (r: string, ...a: unknown[]) => string };
const resolverOriginal = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "server-only" ? __filename : resolverOriginal.call(this, request, ...rest);
};

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  [OK]    ${msg}`); }
  else { failed++; console.log(`  [FALHA] ${msg}`); }
}
const secao = (t: string) => console.log(`\n── ${t}`);

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgresql://postgres:test@localhost:15433/postgres";
const host = new URL(ADMIN_URL).hostname;
if (host !== "localhost" && host !== "127.0.0.1") {
  console.error(`RECUSADO: ${host} não é uma base local descartável.`);
  process.exit(2);
}
const urlDe = (db: string) => { const u = new URL(ADMIN_URL); u.pathname = `/${db}`; return u.toString(); };

const CAB = ["Nº registo", "Substância Ativa/DCI", "Nome do medicamento", "Forma farmacêutica", "Dosagem", "Tamanho da embalagem", "CNPEM", "Preço (PVP)", "PVP Notificado", "Preço Utente", "Preço Pensionistas", "Comerc.", "Genérico"];
type Cel = string | number | null;
const linha = (reg: string, nome = "Ben-u-ron"): Cel[] => [reg, "Paracetamol", nome, "Comprimido", "500 mg", "20 un", 50000001, 3.5, null, 3.2, 2.9, "Comercializado", "Não"];
function xls(rows: Cel[][], cab = CAB): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([cab, ...rows]), "Medicamentos");
  return XLSX.write(wb, { type: "buffer", bookType: "biff8" }) as Buffer;
}

/** Emula o portal JSF: página com formulário + cookie, e o POST que devolve o .xls. */
function portalFalso(xlsBuf: Buffer, opcoes: { falhas503?: number; semBotao?: boolean; devolveHtml?: boolean } = {}) {
  const estado = { gets: 0, posts: 0, cookieNoPost: "", corpoPost: "", rejeitados: 0 };
  let falhas = opcoes.falhas503 ?? 0;
  const pagina = (opcoes.semBotao ? "" : `<button id="form:export-all-button" name="form:export-all-button" type="submit"></button>`);
  const html = `<html><body><form id="form" name="form" method="post" action="/CITS/pesquisaMedicamento.jsf;jsessionid=ABC" enctype="application/x-www-form-urlencoded">
    <input type="hidden" name="form" value="form" />
    <input id="form:dci_input" name="form:dci_input" type="text" />
    <input type="hidden" name="javax.faces.ViewState" value="VS-123:456" />
    <input name="form:cnpem" type="text" value="" />
    <select name="form:tbl_rppDD"><option value="10" selected="selected">10</option><option value="25">25</option></select>
    ${pagina}</form></body></html>`;
  const fetchImpl = async (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
    const res = (status: number, headers: Record<string, string>, corpo: Buffer | string, setCookie: string[] = []) => ({
      ok: status >= 200 && status < 300, status,
      headers: { get: (n: string) => headers[n.toLowerCase()] ?? null, getSetCookie: () => setCookie },
      arrayBuffer: async () => { const b = Buffer.isBuffer(corpo) ? corpo : Buffer.from(corpo); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer; },
      text: async () => (Buffer.isBuffer(corpo) ? corpo.toString("latin1") : corpo),
    });
    if (falhas > 0) { falhas--; estado.rejeitados++; return res(503, { "content-type": "text/html" }, "indisponivel"); }
    if ((init?.method ?? "GET") === "GET") {
      estado.gets++;
      return res(200, { "content-type": "text/html;charset=UTF-8" }, html, ["JSESSIONID=SESSAO42; Path=/CITS; HttpOnly"]);
    }
    estado.posts++;
    estado.cookieNoPost = init?.headers?.cookie ?? "";
    estado.corpoPost = init?.body ?? "";
    if (!estado.cookieNoPost.includes("JSESSIONID=SESSAO42")) return res(500, { "content-type": "text/html" }, "sem sessão");
    if (opcoes.devolveHtml) return res(200, { "content-type": "text/html" }, "<html>erro</html>");
    return res(200, { "content-type": "application/vnd.ms-excel", "content-disposition": `attachment;filename="allPackages.xls"` }, xlsBuf);
  };
  return { fetchImpl, estado };
}

async function main() {
  const { PrismaClient } = await import("../../generated/prisma/client");
  const { PrismaClient: ControlClient } = await import("../../generated/prisma-control/client");
  const { lerFicheiroInfarmed } = await import("../../lib/regulamentar/infarmed-ficheiro");
  const jsf = await import("../../lib/regulamentar/infarmed-jsf");
  const { obterFicheiroInfarmed } = await import("../../lib/regulamentar/infarmed-job");
  const at = await import("../../lib/regulamentar/infarmed-atualizacao");
  const adm = await import("../../lib/regulamentar/infarmed-admin");
  const rt = await import("../../lib/regulamentar/infarmed-runtime");
  const sched = await import("../../scripts/workers/scheduler.mjs");

  // ═══ 1 · scheduler ══════════════════════════════════════════════════
  secao("1 · scheduler — dia 1, Europe/Lisbon");
  const job = sched.JOBS.find((j: { name: string }) => j.name === "infarmed-regulamentar")!;
  check(job.dayOfMonth === 1 && job.timezone === "Europe/Lisbon" && job.hour === 3 && job.minute === 30, "o job está no dia 1, 03:30, Europe/Lisbon (hora de baixa utilização)");
  const quando = (iso: string) => sched.estaNaAltura(job, new Date(iso));
  check(quando("2026-11-01T03:30:00Z") === true, "1 nov 2026 (inverno) 03:30 Lisboa = 03:30Z → dispara");
  check(quando("2026-06-01T02:30:00Z") === true, "1 jun 2026 (verão) 03:30 Lisboa = 02:30Z → dispara");
  check(quando("2026-06-01T03:30:00Z") === false, "1 jun às 03:30Z (04:30 Lisboa) → não dispara");
  check(quando("2026-11-02T03:30:00Z") === false && quando("2026-11-30T03:30:00Z") === false, "outros dias do mês → não dispara");
  check(quando("2026-10-31T23:30:00Z") === false && quando("2026-12-01T00:00:00Z") === false, "31 de outubro às 23:30Z e 1 dez às 00:00 → não dispara");
  const k1 = sched.slotKey(job, new Date("2026-11-01T03:30:10Z"));
  check(k1 === sched.slotKey(job, new Date("2026-11-01T03:30:40Z")) && k1 !== sched.slotKey(job, new Date("2026-12-01T03:30:10Z")), "uma só chave por mês (uma vez por mês; os dois ticks do mesmo minuto não repetem)");
  check(sched.JOBS.filter((j: { dayOfMonth?: number }) => j.dayOfMonth).length === 1, "é o único job mensal");

  // ═══ 2 · download pelo formulário público ═══════════════════════════
  secao("2 · download pelo formulário (HTTP simples, cookies + ViewState)");
  const boa = xls([linha("5000001"), linha("5000002")]);
  const p1 = portalFalso(boa);
  const o1 = await jsf.descarregarViaFormulario({ fetchImpl: p1.fetchImpl, sleep: async () => undefined });
  check(o1.buffer.equals(boa) && o1.nomeFicheiro === "allPackages.xls", "descarrega e devolve o ficheiro (allPackages.xls)");
  check(p1.estado.gets === 1 && p1.estado.posts === 1, "um GET (sessão anónima) e um POST");
  check(p1.estado.cookieNoPost.includes("JSESSIONID=SESSAO42"), "o POST leva o cookie de sessão do GET");
  const post = new URLSearchParams(p1.estado.corpoPost);
  check(post.get("javax.faces.ViewState") === "VS-123:456" && post.get("form") === "form" && post.has("form:export-all-button") && post.get("form:tbl_rppDD") === "10", "o POST leva o ViewState, os campos do formulário e o botão form:export-all-button");
  const p2 = portalFalso(boa, { falhas503: 2 });
  const o2 = await jsf.descarregarViaFormulario({ fetchImpl: p2.fetchImpl, sleep: async () => undefined });
  check(o2.buffer.equals(boa) && p2.estado.rejeitados === 2, "503 transitórios são repetidos (2 falhas, depois sucesso)");
  const p3 = portalFalso(boa, { falhas503: 99 });
  const e3 = await jsf.descarregarViaFormulario({ fetchImpl: p3.fetchImpl, sleep: async () => undefined, tentativas: 3 }).catch((e) => e);
  check(e3 instanceof jsf.DownloadInfarmedFalhou && e3.codigo === "HTTP" && p3.estado.rejeitados === 3, "503 persistente: desiste ao fim de 3 tentativas (sem ciclo)");
  const p4 = portalFalso(boa, { semBotao: true });
  const e4 = await jsf.descarregarViaFormulario({ fetchImpl: p4.fetchImpl, sleep: async () => undefined }).catch((e) => e);
  check(e4 instanceof jsf.DownloadInfarmedFalhou && e4.codigo === "ESTRUTURA" && p4.estado.gets === 1, "estrutura da página mudou (sem botão): falha logo, sem repetir nem contornar");
  const p5 = portalFalso(boa, { devolveHtml: true });
  const e5 = await jsf.descarregarViaFormulario({ fetchImpl: p5.fetchImpl, sleep: async () => undefined }).catch((e) => e);
  check(e5 instanceof jsf.DownloadInfarmedFalhou && e5.codigo === "TIPO", "resposta HTML em vez de Excel: recusada");
  check((await jsf.descarregarViaFormulario({ urlPagina: "http://x.invalid/a.jsf" }).catch((e) => e)).codigo === "URL", "endereço http recusado");
  const fetchDireto = async () => ({
    ok: true, status: 200, headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "application/vnd.ms-excel" : null) },
    arrayBuffer: async () => boa.buffer.slice(boa.byteOffset, boa.byteOffset + boa.byteLength) as ArrayBuffer, text: async () => "",
  });
  const direto = await obterFicheiroInfarmed({ urlDireto: "https://espelho.invalid/allPackages.xls", fetchImpl: fetchDireto });
  check(direto.url === "https://espelho.invalid/allPackages.xls", "INFARMED_ALLPACKAGES_URL (se definido) substitui o formulário");

  // ═══ bases: control + dois tenants ══════════════════════════════════
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const suf = Date.now().toString(36);
  const dbs = { c: `spharm_ia_c_${suf}`, a: `spharm_ia_a_${suf}`, b: `spharm_ia_b_${suf}` };
  for (const d of Object.values(dbs)) await admin.query(`CREATE DATABASE ${d}`);
  const sink = await smtpSink();
  try {
    execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: urlDe(dbs.a) }, encoding: "utf8" });
    execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: urlDe(dbs.b) }, encoding: "utf8" });
    execSync("npx prisma migrate deploy --config prisma-control.config.ts", { env: { ...process.env, CONTROL_DATABASE_URL: urlDe(dbs.c) }, encoding: "utf8" });
    const control = new ControlClient({ adapter: new PrismaPg({ connectionString: urlDe(dbs.c) }) });
    const clienteA = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(dbs.a) }) });
    const clienteB = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(dbs.b) }) });

    // tenant B avaria quando se pede (proxy sobre o cliente real: $transaction rejeita)
    let bAvariado = false;
    const proxyB = new Proxy(clienteB as unknown as Record<string | symbol, unknown>, {
      get(t, prop, r) {
        if (prop === "$transaction" && bAvariado) return () => Promise.reject(new Error("FALHA_FORCADA_TENANT_B"));
        return Reflect.get(t, prop, r);
      },
    }) as unknown as typeof clienteB;

    // produtos: A tem 3 (5000001-3); B tem 2 (5000001 e 5000009) — contagens diferentes por tenant
    for (const [cli, cnps] of [[clienteA, [5000001, 5000002, 5000003]], [clienteB, [5000001, 5000009]]] as const) {
      for (const cnp of cnps) await cli.produto.create({ data: { cnp, designacao: `PRODUTO ${cnp}` } });
    }
    let ativos: Array<{ slug: string; nome: string; prisma: typeof clienteA }> = [
      { slug: "a", nome: "Tenant A", prisma: clienteA },
      { slug: "b", nome: "Tenant B", prisma: proxyB },
    ];
    const emails: MensagemEmail[] = [];
    let emailModo: "ok" | "falha" | "sem-config" = "ok";
    let relogio = new Date("2026-11-01T03:30:00Z");
    let ficheiroAtual: () => Promise<{ buffer: Buffer; nomeFicheiro: string | null; url: string }> = async () => ({ buffer: xls([linha("5000001"), linha("5000002"), linha("5000003"), linha("5000009")]), nomeFicheiro: "allPackages.xls", url: "portal" });
    const deps: Dependencias = {
      control,
      tenants: async (o) => ativos.filter((t) => !o?.onlySlugs?.length || o.onlySlugs.includes(t.slug)),
      obterFicheiro: () => ficheiroAtual(),
      enviarEmail: async (m) => {
        if (emailModo === "falha") throw new Error("SMTP indisponível (simulado)");
        if (emailModo === "sem-config") throw new at.EmailNaoConfigurado("sem SMTP");
        emails.push(m);
      },
      urlAdmin: "https://app.exemplo.pt/admin/infarmed",
      agora: () => relogio,
      log: () => undefined,
    };
    const contagens = async () => ({
      a: await clienteA.infarmedImportacao.count({ where: { estado: "APLICADA" } }),
      b: await clienteB.infarmedImportacao.count({ where: { estado: "APLICADA" } }),
    });
    const ativaDe = async (c: typeof clienteA) => (await c.infarmedImportacao.findFirst({ where: { ativa: true } }))?.id ?? null;

    // ═══ 3 · atualização automática com sucesso ═════════════════════
    secao("3 · atualização automática (sucesso) nos tenants ativos");
    const r1 = await at.executarAtualizacaoAutomatica(deps);
    check(r1.estado === "CONCLUIDA" && r1.periodo === "2026-11" && r1.tenants.every((t) => t.resultado === "APLICADA"), "aplicada nos dois tenants ativos (período 2026-11 em Lisboa)");
    const regA = await clienteA.produtoRegulamentar.count({ where: { importacao: { ativa: true } } });
    const regB = await clienteB.produtoRegulamentar.count({ where: { importacao: { ativa: true } } });
    check(regA === 3 && regB === 2, `cada tenant associa só os SEUS produtos (A=${regA}, B=${regB}) e tem contagens próprias`);
    check((await clienteA.produtoRegulamentar.count({ where: { cnp: 5000009 } })) === 0 && (await clienteB.produtoRegulamentar.count({ where: { cnp: { in: [5000002, 5000003] } } })) === 0, "isolamento: nada de um tenant aparece no outro");
    const ex1 = await control.infarmedExecucao.findUniqueOrThrow({ where: { id: r1.execucaoId! } });
    check(ex1.resultado === "CONCLUIDA" && ex1.origem === "AUTOMATICA" && ex1.sha256 === r1.sha256, "execução registada como CONCLUIDA/AUTOMATICA");
    check(emails.length === 0 && (await control.infarmedAlerta.count()) === 0, "sem falha: nenhum email e nenhum alerta");
    const r1b = await at.executarAtualizacaoAutomatica(deps);
    check(r1b.estado === "CONCLUIDA" && r1b.tenants.every((t) => t.resultado === "JA_PROCESSADA") && (await contagens()).a === 1, "idempotência: o mesmo ficheiro no dia seguinte não repete (JA_PROCESSADA)");
    const dry = await at.executarAtualizacaoAutomatica(deps, { dryRun: true });
    check(dry.estado === "SIMULADA" && (await control.infarmedExecucao.count()) === 2, "dry-run não escreve (nem execução, nem alerta, nem email)");
    check(typeof ativos.length === "number" && (await deps.tenants()).length === 2, "os tenants vêm de `deps.tenants()` a cada execução (sem lista fixa)");

    // ═══ 4 · falha do download ══════════════════════════════════════
    secao("4 · falha do download: versão ativa intacta, alerta e UM email");
    const versaoA = await ativaDe(clienteA);
    const versaoB = await ativaDe(clienteB);
    const nRegA = await clienteA.produtoRegulamentar.count();
    ficheiroAtual = async () => { throw new jsf.DownloadInfarmedFalhou("HTTP", "O pedido de exportação respondeu HTTP 503."); };
    relogio = new Date("2026-12-01T03:30:00Z");
    const f1 = await at.executarAtualizacaoAutomatica(deps);
    check(f1.estado === "FALHADA" && f1.motivoChave === "DOWNLOAD_HTTP" && /503/.test(f1.motivo ?? ""), "falha classificada (DOWNLOAD_HTTP) com motivo resumido");
    check((await ativaDe(clienteA)) === versaoA && (await ativaDe(clienteB)) === versaoB && (await clienteA.produtoRegulamentar.count()) === nRegA, "as versões ativas e os dados ficam integralmente iguais (nada parcial)");
    check((await clienteA.infarmedImportacao.count({ where: { estado: "FALHADA" } })) === 1 && (await clienteB.infarmedImportacao.count({ where: { estado: "FALHADA" } })) === 1, "a falha fica no histórico de cada tenant (FALHADA)");
    const ex2 = await control.infarmedExecucao.findUniqueOrThrow({ where: { id: f1.execucaoId! } });
    check(ex2.resultado === "FALHADA" && ex2.periodo === "2026-12", "a execução do mês fica FALHADA — o mês NÃO é marcado como concluído");
    const al1 = await control.infarmedAlerta.findUniqueOrThrow({ where: { periodo: "2026-12" } });
    check(al1.estado === "PENDENTE" && al1.notificacaoEstado === "ENVIADA" && al1.tentativas === 1, "alerta PENDENTE com notificação ENVIADA");
    check(emails.length === 1, "enviado exatamente um email");
    check(/não foi possível/i.test(emails[0].assunto) && /2026-12/.test(emails[0].assunto), "assunto: atualização mensal não foi possível (mês)");
    check(/HTTP 503/.test(emails[0].texto) && /https:\/\/app\.exemplo\.pt\/admin\/infarmed/.test(emails[0].texto) && /mantida/.test(emails[0].texto), "corpo: motivo resumido, ligação para o upload manual e a garantia de que a versão ativa foi mantida");

    // ═══ 5 · sem emails duplicados ══════════════════════════════════
    secao("5 · sem emails duplicados");
    await at.executarAtualizacaoAutomatica(deps);
    await at.executarAtualizacaoAutomatica(deps);
    check(emails.length === 1, "repetir a mesma falha (3 execuções no mesmo mês) não envia mais emails");
    const al2 = await control.infarmedAlerta.findUniqueOrThrow({ where: { periodo: "2026-12" } });
    check(al2.tentativas === 3 && al2.notificacaoEstado === "ENVIADA", "as tentativas contam-se (3) mas a notificação mantém-se ENVIADA");
    ficheiroAtual = async () => ({ buffer: Buffer.from("<html>erro do portal</html>"), nomeFicheiro: null, url: "portal" });
    await at.executarAtualizacaoAutomatica(deps);
    check(emails.length === 2 && /Ficheiro inválido|HTML/i.test(emails[1].texto), "um motivo DIFERENTE (ficheiro inválido) é uma nova falha relevante → novo email");
    await at.executarAtualizacaoAutomatica(deps);
    check(emails.length === 2, "…e repeti-lo não volta a enviar");
    const alVal = await control.infarmedAlerta.findUniqueOrThrow({ where: { periodo: "2026-12" } });
    check(alVal.motivoChave.startsWith("VALIDACAO_"), `chave do motivo atual: ${alVal.motivoChave}`);

    // ═══ 6 · falha no email ═════════════════════════════════════════
    secao("6 · falha no envio do email não perde a falha original");
    relogio = new Date("2027-01-01T03:30:00Z");
    ficheiroAtual = async () => { throw new jsf.DownloadInfarmedFalhou("REDE", "ECONNRESET"); };
    emailModo = "falha";
    const nEmails = emails.length;
    const f2 = await at.executarAtualizacaoAutomatica(deps);
    check(f2.estado === "FALHADA" && f2.alerta?.notificacao === "FALHOU", "a execução continua FALHADA e a notificação regista FALHOU");
    const al3 = await control.infarmedAlerta.findUniqueOrThrow({ where: { periodo: "2027-01" } });
    check(al3.estado === "PENDENTE" && /ECONNRESET/.test(al3.motivo) && al3.notificacaoEstado === "FALHOU" && /SMTP indisponível/.test(al3.notificacaoErro ?? ""), "a falha original (motivo) e a falha do email (notificacaoErro) ficam registadas SEPARADAMENTE");
    check(emails.length === nEmails && (await ativaDe(clienteA)) === versaoA, "nenhum email enviado e os dados regulamentares continuam intactos");
    emailModo = "sem-config";
    const f3 = await at.executarAtualizacaoAutomatica(deps);
    check(f3.alerta?.notificacao === "NAO_CONFIGURADA" && (await control.infarmedAlerta.findUniqueOrThrow({ where: { periodo: "2027-01" } })).notificacaoEstado === "NAO_CONFIGURADA", "sem SMTP/destinatário: NAO_CONFIGURADA, sem rebentar");
    emailModo = "ok";
    const f4 = await at.executarAtualizacaoAutomatica(deps);
    check(f4.alerta?.notificacao === "ENVIADA" && emails.length === nEmails + 1, "quando o SMTP volta, a execução seguinte envia UMA vez (não há ciclo de reenvios)");
    await at.executarAtualizacaoAutomatica(deps);
    check(emails.length === nEmails + 1, "e fica por aí");

    // ═══ 7–15 · página de upload (ações) ════════════════════════════
    secao("7-8 · autorização das ações de /admin/infarmed");
    process.env.PLATFORM_ADMIN_EMAILS = "admin@spharm.test";
    const sessAdmin = { sub: "u1", email: "admin@spharm.test", nome: "Admin", perfil: "ADMINISTRADOR", farmaciaId: null, tenant: "__legacy__" } as never;
    const sessComum = { sub: "u2", email: "gestor@spharm.test", nome: "Gestor", perfil: "GESTOR_FARMACIA", farmaciaId: null, tenant: "a" } as never;
    const sessAdminDeTenant = { sub: "u3", email: "admin@spharm.test", nome: "Admin", perfil: "ADMINISTRADOR", farmaciaId: null, tenant: "a" } as never;
    const sessAdminOutroEmail = { sub: "u4", email: "outro@spharm.test", nome: "Outro", perfil: "ADMINISTRADOR", farmaciaId: null, tenant: "__legacy__" } as never;
    const novo = xls([linha("5000001", "Ben-u-ron v2"), linha("5000002"), linha("5000003"), linha("5000009")]);
    const fich = (buf: Buffer, nome = "allPackages.xls") => new File([new Uint8Array(buf)], nome);
    for (const [nome, s] of [["utilizador comum", sessComum], ["sem sessão", null], ["admin de tenant (não da plataforma)", sessAdminDeTenant], ["ADMINISTRADOR fora da lista de platform admins", sessAdminOutroEmail]] as const) {
      const v = await adm.acaoValidarUpload(deps, s as never, fich(novo));
      const a = await adm.acaoAplicarUpload(deps, s as never, { ficheiro: fich(novo), sha256Esperado: "x", confirmar: "APLICAR" });
      const rp = await adm.acaoRepetir(deps, s as never, {});
      check(!v.ok && v.codigo === "NAO_AUTORIZADO" && !a.ok && a.codigo === "NAO_AUTORIZADO" && !rp.ok && rp.codigo === "NAO_AUTORIZADO", `${nome}: validar, aplicar e repetir recusados`);
    }
    const nExecAntes = await control.infarmedExecucao.count();
    check((await control.infarmedExecucao.count()) === nExecAntes && (await contagens()).a === 1, "as recusas não escreveram nada");

    secao("9 · validação do ficheiro carregado");
    const rec = async (f: unknown, re: RegExp) => { const r = await adm.acaoValidarUpload(deps, sessAdmin, f); return !r.ok && re.test(r.erro); };
    check(await rec(undefined, /Selecione/), "sem ficheiro");
    check(await rec(fich(novo, "dados.xlsx"), /\.xls/), "extensão errada");
    check(await rec(fich(novo, "../../etc/passwd.txt"), /\.xls/), "nome com caminho + extensão errada");
    check(await rec(fich(Buffer.alloc(0)), /vazio/), "ficheiro vazio");
    check(await rec(fich(Buffer.alloc(adm.UPLOAD_MAX_BYTES + 1, 1)), /excede/), "demasiado grande");
    check(await rec(fich(Buffer.from("<!DOCTYPE html><html>x</html>"), "enganoso.xls"), /HTML/), "HTML com extensão .xls: o nome não é prova");
    check(await rec(fich(Buffer.from("PK\u0003\u0004conteudo".repeat(20)), "zip.xls"), /assinatura|HTML/i), "conteúdo que não é Excel 97-2003");
    const wbX = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wbX, XLSX.utils.aoa_to_sheet([CAB, linha("5000001")]), "Outra");
    check(await rec(fich(XLSX.write(wbX, { type: "buffer", bookType: "biff8" }) as Buffer), /Folha/), "folha errada");
    const semPvp = CAB.filter((c) => c !== "Preço (PVP)");
    check(await rec(fich(xls([linha("5000001").filter((_, i) => CAB[i] !== "Preço (PVP)")], semPvp)), /Preço \(PVP\)/), "sem a coluna «Preço (PVP)»");
    const mau = xls([linha("0123456"), linha("5000001"), linha("5000001", "Outro nome"), linha("5000002"), linha("5000002")]);
    const vMau = await adm.acaoValidarUpload(deps, sessAdmin, fich(mau));
    check(vMau.ok && vMau.preview.linhasRejeitadas === 1 && vMau.preview.conflitos === 1 && vMau.preview.duplicadosIdenticos === 1 && vMau.preview.rejeitadasAmostra[0].motivo.includes("zeros à esquerda"), "linhas inválidas, duplicados e conflitos aparecem no resumo");

    secao("10-12 · preview sem escritas, confirmação explícita, mesmo motor");
    const nImp = [await clienteA.infarmedImportacao.count(), await clienteB.infarmedImportacao.count(), await control.infarmedExecucao.count()];
    const tmpAntes = fs.readdirSync(os.tmpdir()).length;
    const v = await adm.acaoValidarUpload(deps, sessAdmin, fich(novo));
    check(v.ok && v.preview.tenants.length === 2 && v.preview.tenants.every((t) => t.resultado === "SIMULADA"), "preview: resultado esperado por tenant (SIMULADA nos dois)");
    check(v.ok && v.preview.tenants.find((t) => t.slug === "a")!.produtosAssociados === 3 && v.preview.tenants.find((t) => t.slug === "b")!.produtosAssociados === 2, "preview: associados por tenant (A=3, B=2)");
    check([await clienteA.infarmedImportacao.count(), await clienteB.infarmedImportacao.count(), await control.infarmedExecucao.count()].join() === nImp.join(), "o preview não escreveu nada (nem importações, nem execuções)");
    if (!v.ok) throw new Error("preview falhou");
    const sha = v.preview.sha256;
    const semConf = await adm.acaoAplicarUpload(deps, sessAdmin, { ficheiro: fich(novo), sha256Esperado: sha, confirmar: "" });
    check(!semConf.ok && semConf.codigo === "CONFIRMACAO", "sem confirmação explícita: recusado");
    const confErrada = await adm.acaoAplicarUpload(deps, sessAdmin, { ficheiro: fich(novo), sha256Esperado: sha, confirmar: "aplicar" });
    check(!confErrada.ok && confErrada.codigo === "CONFIRMACAO", "confirmação diferente de «APLICAR»: recusado");
    const outroSha = await adm.acaoAplicarUpload(deps, sessAdmin, { ficheiro: fich(xls([linha("5000001", "Trocado")])), sha256Esperado: sha, confirmar: "APLICAR" });
    check(!outroSha.ok && /SHA-256/.test(outroSha.erro), "ficheiro diferente do validado (SHA-256): recusado");
    check([await clienteA.infarmedImportacao.count(), await clienteB.infarmedImportacao.count()].join() === nImp.slice(0, 2).join(), "as recusas não escreveram nada");

    secao("12-16 · aplicação manual, histórico, alerta resolvido");
    check((await control.infarmedAlerta.count({ where: { estado: "PENDENTE" } })) >= 1, "há alertas pendentes antes do upload");
    const ap = await adm.acaoAplicarUpload(deps, sessAdmin, { ficheiro: fich(novo, "allPackages-nov.xls"), sha256Esperado: sha, confirmar: "APLICAR" });
    check(ap.ok && ap.resultado.estado === "CONCLUIDA" && ap.resultado.tenants.every((t) => t.resultado === "APLICADA"), "aplicado a todos os tenants ativos");
    const impA = await clienteA.infarmedImportacao.findFirstOrThrow({ where: { ativa: true } });
    const impB = await clienteB.infarmedImportacao.findFirstOrThrow({ where: { ativa: true } });
    check(impA.origem === "UPLOAD_MANUAL" && impA.utilizadorEmail === "admin@spharm.test" && impA.nomeFicheiro === "allPackages-nov.xls" && impA.bytes === novo.length && impA.sha256 === sha, "histórico do tenant A: origem upload manual, utilizador, nome, tamanho e SHA-256");
    check(impB.origem === "UPLOAD_MANUAL" && impB.utilizadorEmail === "admin@spharm.test", "histórico do tenant B idem");
    const exM = await control.infarmedExecucao.findUniqueOrThrow({ where: { id: ap.ok ? ap.resultado.execucaoId! : "" } });
    check(exM.origem === "UPLOAD_MANUAL" && exM.utilizadorEmail === "admin@spharm.test" && exM.resultado === "CONCLUIDA", "ledger global: UPLOAD_MANUAL por admin@spharm.test");
    check((await control.infarmedAlerta.count({ where: { estado: "PENDENTE" } })) === 0, "os alertas pendentes ficaram RESOLVIDOS");
    const resolvido = await control.infarmedAlerta.findUniqueOrThrow({ where: { periodo: "2027-01" } });
    check(resolvido.estado === "RESOLVIDO" && resolvido.resolvidoPor === "admin@spharm.test" && resolvido.resolvidoEm !== null, "…com quem e quando");
    check((await clienteA.produtoRegulamentar.findFirstOrThrow({ where: { importacaoId: impA.id, cnp: 5000001 } })).nomeMedicamento === "Ben-u-ron v2", "o mesmo motor gravou os dados (nome novo do ficheiro)");
    check((await clienteA.produto.findUniqueOrThrow({ where: { cnp: 5000001 } })).designacao === "PRODUTO 5000001", "a designação do produto não foi tocada");

    secao("13 · ficheiro já processado");
    const ja = await adm.acaoValidarUpload(deps, sessAdmin, fich(novo));
    check(ja.ok && ja.preview.tenants.every((t) => t.resultado === "JA_PROCESSADA"), "o preview diz JA_PROCESSADA nos dois tenants");
    const ja2 = await adm.acaoAplicarUpload(deps, sessAdmin, { ficheiro: fich(novo), sha256Esperado: sha, confirmar: "APLICAR" });
    check(ja2.ok && ja2.resultado.tenants.every((t) => t.resultado === "JA_PROCESSADA") && (await contagens()).a === 2, "aplicar de novo não cria versão nova");

    secao("14 · sem ficheiros temporários");
    check(fs.readdirSync(os.tmpdir()).length === tmpAntes, "o diretório temporário do SO ficou igual (o ficheiro só existe em memória)");
    const fonte = fs.readFileSync("lib/regulamentar/infarmed-admin.ts", "utf8") + fs.readFileSync("lib/regulamentar/infarmed-atualizacao.ts", "utf8");
    check(!/from "node:fs"|require\("fs"\)|writeFile|createWriteStream|mkdtemp|tmpdir/.test(fonte), "o código do upload não usa o sistema de ficheiros (sem caminhos, sem temporários)");
    check(adm.nomeSeguro("../../x/y\\z:evil?.xls") === "z_evil_.xls", "o nome do ficheiro é só um rótulo sanitizado (sem caminhos)");

    // ═══ 17-19 · tenants: falha parcial e retry ═════════════════════
    secao("17-19 · tenants ativos, isolamento e retry de um tenant");
    relogio = new Date("2027-02-01T03:30:00Z");
    ficheiroAtual = async () => ({ buffer: xls([linha("5000001", "Fev"), linha("5000002"), linha("5000003"), linha("5000009")]), nomeFicheiro: "allPackages.xls", url: "portal" });
    bAvariado = true;
    const antesA = await ativaDe(clienteA);
    const antesB = await ativaDe(clienteB);
    const par = await at.executarAtualizacaoAutomatica(deps);
    check(par.estado === "PARCIAL" && par.tenants.find((t) => t.slug === "a")!.ok && !par.tenants.find((t) => t.slug === "b")!.ok, "falha só no tenant B: PARCIAL, A aplicado, B identificado como falhado");
    check((await ativaDe(clienteA)) !== antesA && (await ativaDe(clienteB)) === antesB, "A passou para a versão nova; B manteve a anterior (sem corromper)");
    const alP = await control.infarmedAlerta.findUniqueOrThrow({ where: { periodo: "2027-02" } });
    check(alP.estado === "PENDENTE" && alP.tenantsFalhados.join() === "b" && /FALHA_FORCADA_TENANT_B/.test(alP.motivo), "alerta lista o tenant falhado e o motivo");
    check(emails.some((e) => /tenant/i.test(e.texto) && /b/.test(e.texto)) && /Tenants com falha: b/.test(emails[emails.length - 1].texto), "o email indica o tenant falhado");
    const execParcial = await control.infarmedExecucao.findUniqueOrThrow({ where: { id: par.execucaoId! } });
    check(execParcial.resultado === "PARCIAL", "execução PARCIAL (o mês NÃO fica concluído)");
    // retry só do B
    bAvariado = false;
    const versaoAAntesRetry = await ativaDe(clienteA);
    const retry = await at.executarAtualizacaoAutomatica(deps, { onlySlugs: ["b"], utilizadorEmail: "admin@spharm.test" });
    check(retry.estado === "CONCLUIDA" && retry.tenants.length === 1 && retry.tenants[0].slug === "b" && retry.tenants[0].resultado === "APLICADA", "retry só do tenant B: aplicado");
    check((await ativaDe(clienteA)) === versaoAAntesRetry, "o retry não tocou no tenant A");
    check((await control.infarmedAlerta.findUniqueOrThrow({ where: { periodo: "2027-02" } })).estado === "RESOLVIDO", "o alerta do tenant B ficou resolvido pelo retry");
    const execRetry = await control.infarmedExecucao.findUniqueOrThrow({ where: { id: retry.execucaoId! } });
    check(execRetry.origem === "REPETICAO", "execução registada como REPETICAO");
    // um tenant novo entra sem alterar código
    const dbC = `spharm_ia_n_${suf}`;
    await admin.query(`CREATE DATABASE ${dbC}`);
    execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: urlDe(dbC) }, encoding: "utf8" });
    const clienteC = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(dbC) }) });
    await clienteC.produto.create({ data: { cnp: 5000003, designacao: "PRODUTO C" } });
    ativos = [...ativos, { slug: "c", nome: "Tenant C", prisma: clienteC }];
    relogio = new Date("2027-03-01T03:30:00Z");
    ficheiroAtual = async () => ({ buffer: xls([linha("5000001", "Mar"), linha("5000003")]), nomeFicheiro: "allPackages.xls", url: "portal" });
    const tres = await at.executarAtualizacaoAutomatica(deps);
    check(tres.estado === "CONCLUIDA" && tres.tenants.map((t) => t.slug).join() === "a,b,c", "um tenant novo na lista é processado sem alterar código");
    check((await clienteC.produtoRegulamentar.count()) === 1, "e só tem os seus produtos");
    ativos = ativos.filter((t) => t.slug !== "b"); // tenant desativado deixa de ser processado
    relogio = new Date("2027-04-01T03:30:00Z");
    ficheiroAtual = async () => ({ buffer: xls([linha("5000001", "Abr"), linha("5000003")]), nomeFicheiro: "allPackages.xls", url: "portal" });
    const bAntes = await ativaDe(clienteB);
    const dois = await at.executarAtualizacaoAutomatica(deps);
    check(dois.tenants.map((t) => t.slug).join() === "a,c" && (await ativaDe(clienteB)) === bAntes, "um tenant desativado deixa de ser processado e fica como estava");

    // ═══ estado para a página ═══════════════════════════════════════
    secao("estado da página");
    const est = await adm.lerEstadoAdmin(deps);
    check(est.tenants.length === 2 && est.tenants.every((t) => t.ativa !== null) && est.execucoes.length >= 5, "a página lê tenants, versão ativa e histórico");
    check(est.ultimoDownloadAutomatico !== null && est.alertaPendente === null && (await adm.existeAlertaPendente(control)) === false, "último download automático; sem alerta pendente; indicador desligado");
    await control.infarmedAlerta.create({ data: { periodo: "2027-05", motivo: "teste", motivoChave: "X" } });
    check((await adm.existeAlertaPendente(control)) === true, "indicador ligado quando há alerta pendente");

    // ═══ email real (nodemailer + EmailConfig) ══════════════════════
    secao("email: mecanismo existente (EmailConfig + nodemailer)");
    const env0 = { INFARMED_IMPORT_ALERT_EMAIL: "ops@exemplo.pt, ops2@exemplo.pt" } as unknown as NodeJS.ProcessEnv;
    const listar = async () => ativos;
    await clienteA.emailConfig.create({ data: { farmaciaId: null, smtpHost: "127.0.0.1", smtpPort: sink.port, smtpSecure: false, fromEmail: "no-reply@spharm.test", fromName: "SPharm.MT", isActive: true } });
    const enviar = rt.criarEnviadorEmail(listar, env0);
    await enviar({ assunto: "[SPharm.MT] teste", texto: "olá — ligação: https://app.exemplo.pt/admin/infarmed" });
    check(sink.mensagens.length === 1 && /ops@exemplo\.pt/.test(sink.mensagens[0]) && /ops2@exemplo\.pt/.test(sink.mensagens[0]) && /admin\/infarmed/.test(sink.mensagens[0]), "enviado por SMTP real com a configuração do tenant, para os destinatários configurados");
    check(rt.destinatariosAlerta({ PLATFORM_ADMIN_EMAILS: "Admin@Spharm.test" } as unknown as NodeJS.ProcessEnv).join() === "admin@spharm.test", "sem INFARMED_IMPORT_ALERT_EMAIL usa os platform admins (config de alertas já existente)");
    check(await rt.criarEnviadorEmail(listar, {} as unknown as NodeJS.ProcessEnv)({ assunto: "x", texto: "y" }).then(() => false, (e) => e instanceof at.EmailNaoConfigurado), "sem destinatário: EmailNaoConfigurado");
    await clienteA.emailConfig.updateMany({ data: { isActive: false } });
    check(await rt.criarEnviadorEmail(listar, env0)({ assunto: "x", texto: "y" }).then(() => false, (e) => e instanceof at.EmailNaoConfigurado), "sem SMTP ativo: EmailNaoConfigurado");
    await clienteA.emailConfig.updateMany({ data: { isActive: true, smtpPort: 1 } });
    check(await rt.criarEnviadorEmail(listar, env0)({ assunto: "x", texto: "y" }).then(() => false, (e) => !(e instanceof at.EmailNaoConfigurado)), "SMTP inacessível: erro de envio (registado como FALHOU pelo orquestrador)");

    check(lerFicheiroInfarmed(novo).linhasLidas === 4, "(sanidade) fixture");
    await control.$disconnect(); await clienteA.$disconnect(); await clienteB.$disconnect(); await clienteC.$disconnect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbC} WITH (FORCE)`);
  } finally {
    sink.close();
    for (const d of Object.values(dbs)) await admin.query(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`).catch(() => undefined);
    await admin.end();
  }
  console.log(`\n${passed} OK, ${failed} falhas`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
