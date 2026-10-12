// Pré-visualização de impressão: abre o HTML do relatório em Chromium com
// media=print (o que o diálogo "Imprimir" desenha) e grava um screenshot.
//   node scripts/investigacao/preview-impressao.mjs <vendas.html> <saida.png>
import puppeteer from "puppeteer";
import { readFileSync } from "node:fs";
const [, , html, out] = process.argv;
const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1123, height: 794, deviceScaleFactor: 1 });
await page.emulateMediaType("print");
await page.setContent(readFileSync(html, "utf8"), { waitUntil: "networkidle0" });
await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1123, height: 794 } });
await browser.close();
