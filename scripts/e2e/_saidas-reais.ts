/**
 * scripts/e2e/_saidas-reais.ts
 *
 * Helpers dos E2E de browser para provar as SAÍDAS REAIS de um relatório (ReportActions): impressão (iframe capturado),
 * PDF real (POST /api/reports/pdf repetido fora do browser), Excel real (download lido) e email real (servidor SMTP de
 * ensaio, anexos descodificados). Mesmo método de vendas-opcoes-browser.ts; só dados sintéticos.
 *
 * Pré-requisito: `ctx.addInitScript(INIT_CAPTURA_IMPRESSAO)` ANTES de abrir a página; python com pymupdf (PDF -> texto/PNG).
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import * as XLSX from "xlsx";
import type { BrowserContext, Page } from "playwright";
import type { iniciarSmtpSink } from "./_smtp-sink";

export const norm = (t: string) => t.replace(/[  ]/g, " ").replace(/\s+/g, " ");

export const INIT_CAPTURA_IMPRESSAO = `
  window.__name = (f) => f;
  window.__impressoes = [];
  new MutationObserver((ms) => {
    for (const m of ms) for (const n of m.addedNodes) {
      if (n && n.tagName === 'IFRAME') n.addEventListener('load', () => {
        try { window.__impressoes.push(n.contentDocument.documentElement.outerHTML); } catch (e) {}
      });
    }
  }).observe(document, { childList: true, subtree: true });
`;

function postBinario(u: URL, corpo: Buffer, cookies: string): Promise<{ status: number; corpo: Buffer }> {
  return new Promise((resolve, reject) => {
    const r = httpRequest({ host: "localhost", port: Number(u.port), path: u.pathname, method: "POST", headers: { host: u.host, cookie: cookies, "content-type": "application/json", "content-length": corpo.length } }, (res) => {
      const partes: Buffer[] = [];
      res.on("data", (d) => partes.push(d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, corpo: Buffer.concat(partes) }));
    });
    r.on("error", reject);
    r.end(corpo);
  });
}

function py(script: string, ...args: string[]): string {
  const r = spawnSync("python", [path.resolve(`scripts/e2e/${script}`), ...args], { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`python ${script}: ${r.stderr}`);
  return r.stdout.trim().split("\n").pop() ?? "{}";
}
export const textoPdf = (f: string) => norm((JSON.parse(py("_texto_pdf.py", f)) as { texto: string[] }).texto.join("\n"));
export const xlsxTexto = (f: string) => JSON.parse(py("_xlsx_texto.py", f)) as { partes: string[]; folhas: Array<{ nome: string; estado: string }>; texto: string };
export const renderizarPdf = (f: string, pasta: string, prefixo: string, paginas = 1) => py("_renderizar_pdf.py", f, pasta, prefixo, String(paginas), "80");

/** Texto do corpo do que foi enviado para a impressão (o iframe que o ecrã cria). */
export async function imprimir(page: Page): Promise<string> {
  await page.evaluate(() => { (window as unknown as { __impressoes: string[] }).__impressoes = []; });
  await page.getByRole("button", { name: /^Imprimir$/ }).first().click();
  await page.waitForFunction(() => (window as unknown as { __impressoes: string[] }).__impressoes.length > 0, null, { timeout: 30000 });
  const html = await page.evaluate(() => (window as unknown as { __impressoes: string[] }).__impressoes[0]);
  return norm(html.slice(html.indexOf("<body")).replace(/<style[\s\S]*?<\/style>/g, "").replace(/&nbsp;/g, " ").replace(/<[^>]+>/g, " "));
}

/** PDF real: apanha o pedido do botão e repete-o fora do browser; devolve o ficheiro, o texto e o JSON enviado. */
export async function pdfReal(page: Page, ctx: BrowserContext, evid: string, nome: string) {
  const [req] = await Promise.all([
    page.waitForRequest((r) => r.url().includes("/api/reports/pdf"), { timeout: 180000 }),
    page.getByRole("button", { name: /^PDF$/ }).first().click(),
  ]);
  const corpo = req.postDataBuffer()!;
  const cookies = (await ctx.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  const r = await postBinario(new URL(req.url()), corpo, cookies);
  const ficheiro = path.join(evid, nome);
  fs.writeFileSync(ficheiro, r.corpo);
  await page.getByRole("button", { name: /^PDF$/ }).first().waitFor({ timeout: 60000 });
  return { ficheiro, texto: textoPdf(ficheiro), json: corpo.toString("utf8") };
}

/** Excel real: descarrega, lê com xlsx (todas as folhas, CSV) e com o inspetor de partes. */
export async function excelReal(page: Page, evid: string, nome: string) {
  const [dl] = await Promise.all([page.waitForEvent("download", { predicate: (d) => d.suggestedFilename().endsWith(".xlsx"), timeout: 60000 }), page.getByRole("button", { name: /^Excel$/ }).first().click()]);
  const ficheiro = path.join(evid, nome);
  await dl.saveAs(ficheiro);
  const wb = XLSX.read(fs.readFileSync(ficheiro));
  const csv = wb.SheetNames.map((n) => XLSX.utils.sheet_to_csv(wb.Sheets[n])).join("\n");
  const grelha = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, blankrows: false }) as unknown[][];
  return { ficheiro, csv, grelha, partes: xlsxTexto(ficheiro) };
}

/** Email real: envia pelo diálogo e devolve o PDF e o Excel RECEBIDOS pelo servidor SMTP de ensaio (texto extraído). */
export async function emailReal(page: Page, smtp: Awaited<ReturnType<typeof iniciarSmtpSink>>, evid: string, prefixo: string) {
  const antes = smtp.mensagens.length;
  await page.getByRole("button", { name: /^Email$/ }).first().click();
  await page.getByPlaceholder("nome@dominio.pt, outro@dominio.pt").fill("laboratorio@exemplo.invalid");
  await page.getByRole("button", { name: /^Enviar$/ }).click();
  await page.waitForFunction(() => /Email enviado|falhou|Falha|Erro/.test(document.body.innerText), null, { timeout: 60000 });
  const feedback = norm(await page.locator("div.fixed.inset-0").last().innerText());
  for (let t = 0; t < 40 && smtp.mensagens.length <= antes; t++) await page.waitForTimeout(250);
  const recebidos = smtp.anexos(antes);
  const aPdf = recebidos.find((a) => /\.pdf$/i.test(a.filename));
  const aXlsx = recebidos.find((a) => /\.xlsx$/i.test(a.filename));
  let pdf: string | null = null;
  let xlsx: string | null = null;
  if (aPdf) { const f = path.join(evid, `${prefixo}-email.pdf`); fs.writeFileSync(f, aPdf.conteudo); pdf = textoPdf(f); }
  if (aXlsx) { const f = path.join(evid, `${prefixo}-email.xlsx`); fs.writeFileSync(f, aXlsx.conteudo); xlsx = xlsxTexto(f).texto; }
  await page.getByText("Enviar relatório por email").waitFor({ state: "detached", timeout: 15000 }).catch(() => undefined);
  return { enviado: /Email enviado/.test(feedback), feedback, anexos: recebidos.map((a) => a.filename), pdf, xlsx };
}
