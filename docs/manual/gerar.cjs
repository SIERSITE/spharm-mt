// Gera o PDF do manual a partir de manual.html (Chromium). Sem dependências na aplicação.
//   cd <pasta com node_modules/playwright> && node <repo>/docs/manual/gerar.cjs <manual.html> <saida.pdf>
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createRequire } = require("node:module");
const { chromium } = createRequire(path.join(process.cwd(), "/"))("playwright");
(async () => {
  const [entrada, saida] = process.argv.slice(2).map((p) => path.resolve(p));
  const b = await chromium.launch();
  const pg = await b.newPage();
  await pg.goto(pathToFileURL(entrada).href, { waitUntil: "load" });
  await pg.pdf({ path: saida, preferCSSPageSize: true, printBackground: true });
  await b.close();
  console.log("PDF:", saida);
})();
