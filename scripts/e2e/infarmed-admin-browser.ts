/**
 * scripts/e2e/infarmed-admin-browser.ts
 *
 * Ensaio de BROWSER REAL da página /admin/infarmed e do job mensal, contra o
 * servidor de produção (build) com control plane + DOIS tenants descartáveis e
 * um SMTP de teste local:
 *
 *   · acesso: sem sessão, utilizador comum e admin de tenant recusados; platform admin entra;
 *   · job mensal com falha ⇒ alerta, indicador, email (um só), sem duplicados;
 *   · upload: validar (sem escrever) ⇒ confirmar «APLICAR» ⇒ aplicar nos 2 tenants ⇒ alerta resolvido;
 *   · ficheiro já processado e ficheiro inválido.
 *
 * Pré-requisito: `npx next build` com SERVER_ACTIONS_ALLOWED_ORIGINS="localhost:3100,127.0.0.1:3100,*.localhost:3100".
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres npx tsx scripts/e2e/infarmed-admin-browser.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import * as XLSX from "xlsx";
import { baseFor, criarAmbiente, PORT } from "./_ambiente-silveira";
import { adicionarTenant, smtpSink, tokenSessaoCom } from "./_infarmed-comum";

let ok = 0;
let falhas = 0;
const check = (cond: boolean, msg: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${msg}`); }
  else { falhas++; console.log(`  [FALHA] ${msg}`); }
};
const secao = (t: string) => console.log(`\n── ${t}`);
const EVID = path.resolve("docs/validacao-visual/2026-10-infarmed-admin");
const ADMIN_EMAIL = "admin@spharm.test";
const CRON = "e2e-cron-secret-0123456789abcdef";
const ADMIN_BASE = `http://localhost:${PORT}`;

const CAB = ["Nº registo", "Substância Ativa/DCI", "Nome do medicamento", "Forma farmacêutica", "Dosagem", "Tamanho da embalagem", "CNPEM", "Preço (PVP)", "PVP Notificado", "Preço Utente", "Preço Pensionistas", "Comerc.", "Genérico"];
const linha = (reg: string, nome = "Ben-u-ron") => [reg, "Paracetamol", nome, "Comprimido", "500 mg", "20 un", 50000001, 3.5, null, 3.2, 2.9, "Comercializado", "Não"];
const xlsBuf = (rows: Array<Array<string | number | null>>) => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([CAB, ...rows]), "Medicamentos");
  return XLSX.write(wb, { type: "buffer", bookType: "biff8" }) as Buffer;
};

async function trabalho(url: string) {
  const r = await fetch(`http://localhost:${PORT}${url}`, { headers: { authorization: `Bearer ${CRON}` } });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

async function main() {
  fs.mkdirSync(EVID, { recursive: true });
  const sink = await smtpSink();
  const amb = await criarAmbiente("ia", {
    PLATFORM_ADMIN_EMAILS: ADMIN_EMAIL,
    CRON_SECRET: CRON,
    // endereço direto inatingível ⇒ falha de rede no download (sem depender do portal real)
    INFARMED_ALLPACKAGES_URL: "https://127.0.0.1:1/falha.xls",
    INFARMED_IMPORT_ALERT_EMAIL: "ops@exemplo.test",
    PUBLIC_APP_URL: `http://localhost:${PORT}`,
  });
  const norte = await adicionarTenant(amb, "norte");
  const browser = await chromium.launch();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-infarmed-"));
  try {
    await amb.prisma.utilizador.create({ data: { email: "e2e@spharm.test", nome: "Comum", perfil: "GESTOR_FARMACIA" } }).catch(() => undefined);
    for (const [cli, cnps] of [[amb.prisma, [5000001, 5000002, 5000003]], [norte.prisma, [5000001, 5000009]]] as const) {
      for (const cnp of cnps) await cli.produto.create({ data: { cnp, designacao: `PRODUTO ${cnp}` } });
    }
    const novo = path.join(tmp, "allPackages.xls");
    fs.writeFileSync(novo, xlsBuf([linha("5000001", "Ben-u-ron v2"), linha("5000002"), linha("5000003"), linha("5000009")]));

    // ═══ 1 · acesso ═══════════════════════════════════════════════
    secao("1 · acesso à página administrativa");
    const semSessao = await browser.newContext();
    const pSem = await semSessao.newPage();
    await pSem.goto(`${ADMIN_BASE}/admin/infarmed`, { waitUntil: "networkidle" });
    check(!/\/admin\/infarmed/.test(pSem.url()), `sem sessão → redirecionado (${new URL(pSem.url()).pathname})`);
    await semSessao.close();

    const ctxComum = await browser.newContext();
    await ctxComum.addCookies([{ name: "session", value: await tokenSessaoCom({ sub: "u-comum", email: "gestor@spharm.test", perfil: "GESTOR_FARMACIA", tenant: "silveira" }), url: baseFor("silveira") }]);
    await ctxComum.addCookies([{ name: "session", value: await tokenSessaoCom({ sub: "u-comum", email: "gestor@spharm.test", perfil: "GESTOR_FARMACIA", tenant: "__legacy__" }), url: ADMIN_BASE }]);
    const pComum = await ctxComum.newPage();
    await pComum.goto(`${ADMIN_BASE}/admin/infarmed`, { waitUntil: "networkidle" });
    check(!/\/admin\/infarmed/.test(pComum.url()) && !(await pComum.locator("body").innerText()).includes("Dados regulamentares"), `utilizador comum recusado (${new URL(pComum.url()).pathname})`);
    await pComum.goto(`${baseFor("silveira")}/admin/infarmed`, { waitUntil: "networkidle" });
    check(!/\/admin\/infarmed/.test(pComum.url()), "utilizador comum recusado também no host do tenant");
    await ctxComum.close();

    const ctxAdminTenant = await browser.newContext();
    await ctxAdminTenant.addCookies([{ name: "session", value: await tokenSessaoCom({ sub: "u-at", email: ADMIN_EMAIL, perfil: "ADMINISTRADOR", tenant: "silveira" }), url: baseFor("silveira") }]);
    const pAT = await ctxAdminTenant.newPage();
    await pAT.goto(`${baseFor("silveira")}/admin/infarmed`, { waitUntil: "networkidle" });
    check(!/\/admin\/infarmed/.test(pAT.url()), "ADMINISTRADOR de tenant (não da plataforma) recusado");
    await ctxAdminTenant.close();

    const ctx = await browser.newContext();
    await ctx.addCookies([{ name: "session", value: await tokenSessaoCom({ sub: "u-admin", email: ADMIN_EMAIL, perfil: "ADMINISTRADOR", tenant: "__legacy__" }), url: ADMIN_BASE }]);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
    await page.setViewportSize({ width: 1400, height: 1000 });
    await page.goto(`${ADMIN_BASE}/admin/infarmed`, { waitUntil: "networkidle" });
    check(/\/admin\/infarmed/.test(page.url()) && (await page.locator("h1").innerText()).includes("Dados regulamentares"), "platform admin entra na página");
    check((await page.locator('a[href="/admin/infarmed"]').count()) === 1, "o acesso aparece no menu de administração");
    check((await page.locator('[data-testid="infarmed-alerta"]').count()) === 0 && (await page.locator('[data-testid="infarmed-indicador"]').count()) === 0, "sem falhas: nem alerta nem indicador");
    const tenantsMostrados = await page.locator("[data-tenant-estado]").evaluateAll((l) => l.map((x) => (x as HTMLElement).dataset.tenantEstado));
    check(tenantsMostrados.join() === "norte,silveira", `a página lista os tenants ativos (${tenantsMostrados})`);

    // ═══ 2 · job mensal com falha ═════════════════════════════════
    secao("2 · job mensal falhado: alerta, indicador e email (um só)");
    const naoAuth = await fetch(`http://localhost:${PORT}/api/jobs/infarmed-regulamentar`);
    check(naoAuth.status === 401, "o endpoint do job exige o segredo do scheduler");
    const versaoAntes = await amb.prisma.infarmedImportacao.count({ where: { ativa: true } });
    const j1 = await trabalho("/api/jobs/infarmed-regulamentar");
    check(j1.status === 502 && j1.json.estado === "FALHADA" && /Download/.test(String(j1.json.motivo)), `download falhado: 502 FALHADA — ${String(j1.json.motivo).slice(0, 80)}`);
    check((await amb.prisma.infarmedImportacao.count({ where: { ativa: true } })) === versaoAntes, "nenhuma versão ativa foi alterada");
    check(sink.mensagens.length === 0, "sem SMTP configurado: nenhum email (a falha do email fica registada, a falha original também)");
    await page.reload({ waitUntil: "networkidle" });
    check((await page.locator('[data-testid="infarmed-alerta"]').count()) === 1 && (await page.locator('[data-testid="infarmed-indicador"]').count()) === 1, "a página mostra o alerta e o menu mostra o indicador");
    check((await page.locator('[data-testid="infarmed-notificacao"]').innerText()) === "NAO_CONFIGURADA", "estado da notificação: NAO_CONFIGURADA");
    check(/Download/.test(await page.locator('[data-testid="infarmed-ultimo-erro"]').innerText()), "último erro visível");
    await page.screenshot({ path: path.join(EVID, "admin-infarmed-alerta.png"), fullPage: true });

    await amb.prisma.emailConfig.create({ data: { farmaciaId: null, smtpHost: "127.0.0.1", smtpPort: sink.port, smtpSecure: false, fromEmail: "no-reply@spharm.test", isActive: true } });
    const j2 = await trabalho("/api/jobs/infarmed-regulamentar");
    check(j2.status === 502 && sink.mensagens.length === 1, "SMTP configurado: a execução seguinte envia o email (1)");
    const email = sink.mensagens[0] ?? "";
    check(/To: ops@exemplo\.test/i.test(email) && /Subject: .*INFARMED.*n=C3=A3o foi poss|Subject: .*INFARMED/i.test(email), "enviado para o destinatário configurado, com assunto sobre o INFARMED");
    check(/localhost:\d+\/admin\/infarmed/.test(email.replace(/=\r?\n/g, "")), "o email inclui a ligação para a página de upload manual");
    await trabalho("/api/jobs/infarmed-regulamentar");
    await trabalho("/api/jobs/infarmed-regulamentar");
    check(sink.mensagens.length === 1, "repetir o job (mais 2 execuções) não envia emails duplicados");
    await page.reload({ waitUntil: "networkidle" });
    check((await page.locator('[data-testid="infarmed-notificacao"]').innerText()) === "ENVIADA", "estado da notificação: ENVIADA");

    // ═══ 3 · upload manual ════════════════════════════════════════
    secao("3 · upload manual: validar → confirmar → aplicar");
    const antesApl = [await amb.prisma.infarmedImportacao.count({ where: { estado: "APLICADA" } }), await norte.prisma.infarmedImportacao.count({ where: { estado: "APLICADA" } })];
    await page.setInputFiles('[data-testid="infarmed-input-ficheiro"]', novo);
    check(await page.locator('[data-testid="infarmed-validar"]').isEnabled(), "com ficheiro escolhido o botão Validar fica ativo");
    await page.locator('[data-testid="infarmed-validar"]').click();
    await page.locator('[data-testid="infarmed-preview"]').waitFor({ timeout: 60000 });
    const linhasPreview = await page.locator('[data-testid="infarmed-preview"] [data-tenant]').evaluateAll((l) => l.map((x) => `${(x as HTMLElement).dataset.tenant}:${x.querySelectorAll("td")[1].textContent}`));
    check(linhasPreview.join() === "norte:SIMULADA,silveira:SIMULADA", `resumo por tenant antes de escrever [${linhasPreview}]`);
    const prev = await page.locator('[data-testid="infarmed-preview"]').innerText();
    check(/4 lidas · 4 válidas · 0 rejeitadas/.test(prev), "resumo do ficheiro: linhas lidas/válidas/rejeitadas");
    const apos = [await amb.prisma.infarmedImportacao.count({ where: { estado: "APLICADA" } }), await norte.prisma.infarmedImportacao.count({ where: { estado: "APLICADA" } })];
    check(apos.join() === antesApl.join(), "a validação não escreveu nada nos tenants");
    check(await page.locator('[data-testid="infarmed-aplicar"]').isDisabled(), "Aplicar desativado sem confirmação");
    await page.locator('[data-testid="infarmed-confirmar"]').fill("aplicar");
    check(await page.locator('[data-testid="infarmed-aplicar"]').isDisabled(), "…e com «aplicar» em minúsculas");
    await page.screenshot({ path: path.join(EVID, "admin-infarmed-preview.png"), fullPage: true });
    await page.locator('[data-testid="infarmed-confirmar"]').fill("APLICAR");
    await page.locator('[data-testid="infarmed-aplicar"]').click();
    await page.locator('[data-testid="infarmed-resultado"]').waitFor({ timeout: 90000 });
    check((await page.locator('[data-testid="infarmed-resultado-estado"]').innerText()) === "CONCLUIDA", "resultado final: CONCLUIDA");
    const aplicadas = await page.locator('[data-testid="infarmed-resultado"] [data-tenant]').evaluateAll((l) => l.map((x) => `${(x as HTMLElement).dataset.tenant}:${x.querySelectorAll("td")[1].textContent}`));
    check(aplicadas.join() === "norte:APLICADA,silveira:APLICADA", `aplicado nos dois tenants [${aplicadas}]`);
    const impS = await amb.prisma.infarmedImportacao.findFirstOrThrow({ where: { ativa: true } });
    const impN = await norte.prisma.infarmedImportacao.findFirstOrThrow({ where: { ativa: true } });
    check(impS.origem === "UPLOAD_MANUAL" && impS.utilizadorEmail === ADMIN_EMAIL && impS.nomeFicheiro === "allPackages.xls" && impS.bytes === fs.statSync(novo).size && impN.origem === "UPLOAD_MANUAL" && impN.sha256 === impS.sha256, "histórico: origem upload manual, utilizador, nome, tamanho e SHA-256 em cada tenant");
    check((await amb.prisma.produtoRegulamentar.count({ where: { importacaoId: impS.id } })) === 3 && (await norte.prisma.produtoRegulamentar.count({ where: { importacaoId: impN.id } })) === 2, "cada tenant só tem os seus produtos (3 e 2)");
    const alRes = await amb.prisma.produto.findUniqueOrThrow({ where: { cnp: 5000001 } });
    check(alRes.designacao === "PRODUTO 5000001", "a designação dos produtos não foi alterada");
    await page.reload({ waitUntil: "networkidle" });
    check((await page.locator('[data-testid="infarmed-alerta"]').count()) === 0 && (await page.locator('[data-testid="infarmed-indicador"]').count()) === 0, "o alerta ficou resolvido: sem alerta nem indicador");
    check((await page.locator('[data-testid="infarmed-execucao"]').first().innerText()).includes("Upload manual") && (await page.locator('[data-testid="infarmed-execucao"]').first().innerText()).includes(ADMIN_EMAIL), "o histórico mostra o upload manual e o utilizador");
    await page.screenshot({ path: path.join(EVID, "admin-infarmed-aplicado.png"), fullPage: true });

    // ═══ 4 · já processado e inválido ═════════════════════════════
    secao("4 · ficheiro já processado e ficheiro inválido");
    await page.setInputFiles('[data-testid="infarmed-input-ficheiro"]', novo);
    await page.locator('[data-testid="infarmed-validar"]').click();
    await page.locator('[data-testid="infarmed-ja-processado"]').waitFor({ timeout: 60000 });
    check((await page.locator('[data-testid="infarmed-aplicar"]').count()) === 0, "ficheiro já processado: diz-se e não há Aplicar");
    const falso = path.join(tmp, "falso.xls");
    fs.writeFileSync(falso, "<!DOCTYPE html><html><body>erro</body></html>");
    await page.setInputFiles('[data-testid="infarmed-input-ficheiro"]', falso);
    await page.locator('[data-testid="infarmed-validar"]').click();
    await page.locator('[data-testid="infarmed-erro"]').waitFor({ timeout: 30000 });
    check(/HTML/.test(await page.locator('[data-testid="infarmed-erro"]').innerText()) && (await page.locator('[data-testid="infarmed-preview"]').count()) === 0, "ficheiro .xls que é HTML: recusado com mensagem clara, sem resumo");
    const semPvp = CAB.filter((c) => c !== "Preço (PVP)");
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([semPvp, linha("5000001").filter((_, i) => CAB[i] !== "Preço (PVP)")]), "Medicamentos");
    const semCol = path.join(tmp, "sem-pvp.xls");
    fs.writeFileSync(semCol, XLSX.write(wb, { type: "buffer", bookType: "biff8" }));
    await page.setInputFiles('[data-testid="infarmed-input-ficheiro"]', semCol);
    await page.locator('[data-testid="infarmed-validar"]').click();
    await page.locator('[data-testid="infarmed-erro"]').waitFor({ timeout: 30000 });
    check(/Preço \(PVP\)/.test(await page.locator('[data-testid="infarmed-erro"]').innerText()), "sem a coluna «Preço (PVP)»: recusado");
    check((await amb.prisma.infarmedImportacao.count({ where: { estado: "APLICADA" } })) === 1, "nada foi aplicado pelos ficheiros recusados");
    check(fs.readdirSync(os.tmpdir()).filter((f) => /^(infarmed|upload)/i.test(f)).length === 0, "nenhum ficheiro temporário do upload no diretório temporário");
    await ctx.close();
  } catch (e) {
    console.log(["--- logs do servidor ---", amb.logs().slice(-3500)].join("\u000a"));
    throw e;
  } finally {
    await browser.close();
    sink.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    await norte.apagar();
    await amb.parar();
  }
  console.log(`\n${ok} OK, ${falhas} falhas`);
  process.exit(falhas === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
