import { buildVendasReport } from "../../lib/reporting/adapters/vendas";
import { dadosPiorCaso, dadosRealMult, bucketsCliente, FARMACIAS_CLIENTE, FARMACIAS_3 } from "./_cliente-real";
import { abrirBrowser, pdfDe } from "./_tabela-unica";
import { capacidadeDoRelatorio } from "../../lib/reporting/layout-vendas";
(async () => {
  const out = "C:/Users/Farm/AppData/Local/Temp/claude/c--projetos-spharm-mt/0ecd03c9-dfa7-4e9f-b05d-1ee5ca1b954e/scratchpad/";
  const b = await abrirBrowser();
  for (const [nome, rows, farms] of [["x10", dadosRealMult(10), FARMACIAS_CLIENTE], ["pior3", dadosPiorCaso({ nFarm: 3 }), FARMACIAS_3]] as const) {
    const rel = buildVendasReport({ rows: [...rows], buckets: bucketsCliente(14), filters: { agruparPor: "artigo" }, universe: { farmacias: [...farms], fornecedores: [], fabricantes: [], categorias: [] }, organization: "T" });
    const c = capacidadeDoRelatorio(rel);
    console.log(nome, c.cabe, c.mesesMax, c.padPx, c.descricaoMm, c.mensagem, JSON.stringify(c.excessos));
    await pdfDe(b, rel, out + nome + ".pdf");
  }
  await b.close();
})();
