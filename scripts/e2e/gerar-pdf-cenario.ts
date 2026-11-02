/**
 * Gera, com as opções do endpoint, os PDFs dos cenários SINTÉTICOS «PDF real ×1», «PDF real ×10» e «pior caso» (3 farmácias):
 *   cd <árvore> && OUT=<pasta> npx tsx scripts/e2e/gerar-pdf-cenario.ts      →  <OUT>/real-x1.pdf, real-x10.pdf, pior-caso-3f.pdf
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { dadosPiorCaso, dadosRealMult, FARMACIAS_3, FARMACIAS_CLIENTE } from "../tests/_cliente-real";
import { abrirBrowser, pdfDe, relatorioLinhas } from "../tests/_tabela-unica";

(async () => {
  const out = process.env.OUT ?? "out";
  mkdirSync(out, { recursive: true });
  const b = await abrirBrowser();
  const cen: [string, ReturnType<typeof relatorioLinhas>][] = [
    ["real-x1", relatorioLinhas(dadosRealMult(1), 14, FARMACIAS_CLIENTE)],
    ["real-x10", relatorioLinhas(dadosRealMult(10), 14, FARMACIAS_CLIENTE)],
    ["pior-caso-3f", relatorioLinhas(dadosPiorCaso({ nFarm: 3, mesGrande: 99999, total: 999000, stock: 999000 }), 14, FARMACIAS_3)],
  ];
  for (const [nome, rel] of cen) console.log(await pdfDe(b, rel, path.join(out, `${nome}.pdf`)));
  await b.close();
})();
