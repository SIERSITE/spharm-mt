// Gera o PDF do manual a partir de manual-completo.html (Chromium), em duas passagens:
//   1.ª — PDF provisório; 2.ª — repete com os números de página do índice (calculados a partir do PDF).
// O PDF final tem marcadores laterais (outline), ligações internas e texto selecionável (tagged).
//
//   cd <pasta com node_modules/playwright> && node <repo>/docs/manual/gerar-completo.cjs <manual-completo.html> <saida.pdf>
// Requer Python com `pymupdf` (só para ler os números de página).
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { createRequire } = require("node:module");
const { chromium } = createRequire(path.join(process.cwd(), "/"))("playwright");

const [entrada, saida] = process.argv.slice(2).map((p) => path.resolve(p));
const pasta = path.dirname(entrada);
const temp = path.join(pasta, ".manual-paginado.html");

async function render(html, pdf) {
  const b = await chromium.launch();
  const pg = await b.newPage();
  await pg.goto(pathToFileURL(html).href, { waitUntil: "load" });
  await pg.waitForSelector("body[data-pronto]", { timeout: 30000 });
  await pg.evaluate(() => document.fonts.ready);
  await pg.pdf({ path: pdf, preferCSSPageSize: true, printBackground: true, outline: true, tagged: true });
  await b.close();
}

(async () => {
  const provisorio = path.join(os.tmpdir(), "manual-provisorio.pdf");
  await render(entrada, provisorio);
  const py = spawnSync("python", ["-X", "utf8", path.join(pasta, "paginas.py"), provisorio], { encoding: "utf8" });
  if (py.status !== 0) throw new Error(py.stderr || "paginas.py falhou");
  const paginas = JSON.parse(py.stdout);
  let html = fs.readFileSync(entrada, "utf8");
  for (const [id, n] of Object.entries(paginas)) html = html.replace(`<!--p:${id}-->`, String(n));
  fs.writeFileSync(temp, html, "utf8");
  await render(temp, saida);
  fs.unlinkSync(temp);
  const lp = spawnSync("python", ["-X", "utf8", path.join(pasta, "limpar_marcadores.py"), saida], { encoding: "utf8" });
  if (lp.status !== 0) throw new Error(lp.stderr || "limpar_marcadores.py falhou");
  console.log("PDF:", saida, JSON.stringify(paginas));
})().catch((e) => { console.error(e); process.exit(1); });
