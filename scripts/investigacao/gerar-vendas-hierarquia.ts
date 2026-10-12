/**
 * scripts/investigacao/gerar-vendas-hierarquia.ts
 *
 * Gera o Relatório de Vendas REAL (adapter `buildVendasReport` → HTML partilhado
 * `renderReportHtml` → PDF via Puppeteer, o mesmo motor de "PDF") com dados
 * sintéticos que cobrem os casos do pedido: duas farmácias, vários artigos,
 * linhas com vendas / sem vendas / com stock, e páginas suficientes para
 * repetir o cabeçalho. Escreve `<dir>/vendas.pdf` e `<dir>/vendas.html`.
 *
 * Ferramenta de validação visual — não faz parte da suite de testes:
 *   npx tsx scripts/investigacao/gerar-vendas-hierarquia.ts <dir>
 */
import Module from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// `server-only` só existe no build do Next — stub antes de carregar o PDF server.
const M = Module as unknown as { _resolveFilename: (r: string, ...a: unknown[]) => string };
const resolverOriginal = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "server-only" ? __filename : resolverOriginal.call(this, request, ...rest);
};

async function main() {
  const dir = process.argv[2] ?? "scratchpad";
  mkdirSync(dir, { recursive: true });
  const { buildVendasReport } = await import("../../lib/reporting/adapters/vendas");
  const { renderReportHtml } = await import("../../lib/reporting/report-html");
  const { buildReportPdfBuffer } = await import("../../lib/reporting/report-pdf-server");

  const buckets = [
    { ano: 2026, mes: 7 },
    { ano: 2026, mes: 8 },
    { ano: 2026, mes: 9 },
  ];
  const farmacias = ["Farmácia Segurado", "Farmácia Silveirense"];
  const nomes = [
    "PARACETAMOL CICLUM 650 MG 20 COMP.", "IBUPROFENO GENERIS 400 MG 20 COMP.", "VENTILAN INALADOR R AER 100 MCG/D 200 D",
    "AVENE EAU THERMALE SPRAY 150 ML", "OMEPRAZOL MYLAN 20 MG 14 CAPS.", "ATORVASTATINA SANDOZ 20 MG 30 COMP.",
    "AMOXICILINA + AC. CLAV. 875+125 MG 12 COMP.", "VITAMINA C 1000 MG 20 COMP. EFERV.", "LORATADINA 10 MG 20 COMP.",
    "DICLOFENac GEL 1% 60 G", "SERUM FISIOLOGICO 5 ML 30 AMP.", "CETIRIZINA 10 MG 20 COMP.", "METFORMINA 850 MG 60 COMP.",
    "BISOLVON 8 MG/ML XAROPE 200 ML", "ASPIRINA 500 MG 20 COMP.", "ZYRTEC 10 MG 20 COMP.", "FLUIMUCIL 600 MG 20 COMP. EFERV.",
    "TERMOMETRO DIGITAL RAPIDO", "PROTETOR SOLAR SPF50 200 ML", "ALPRAZOLAM 0.5 MG 60 COMP.",
    "LEVOTIROXINA 100 MCG 100 COMP.", "RAMIPRIL 5 MG 28 COMP.", "SINVASTATINA 20 MG 30 COMP.", "PANTOPRAZOL 40 MG 28 COMP.",
    "BETAMETASONA CREME 30 G", "XAROPE DE TOSSE ADULTO 150 ML", "COLIRIO LUBRIFICANTE 10 ML", "MAGNESIO + B6 60 COMP.",
    "OMEGA 3 1000 MG 60 CAPS.", "GEL DE BANHO DERMATOLOGICO 500 ML", "PENSOS RAPIDOS 20 UN.", "ALCOOL 70 250 ML",
    "ACIDO FOLICO 5 MG 20 COMP.", "TRAMADOL 50 MG 20 CAPS.", "FUROSEMIDA 40 MG 60 COMP.", "NAPROXENO 500 MG 20 COMP.",
  ];
  const rows = [];
  nomes.forEach((descricao, i) => {
    const codigo = String(5_000_100 + i * 7);
    farmacias.forEach((farmacia, fi) => {
      // Alguns artigos só existem numa farmácia (sem linha TOTAL ARTIGO).
      if (i % 9 === 4 && fi === 1) return;
      const semVendas = (i + fi) % 5 === 3;
      const meses = buckets.map((b, bi) => ({
        ano: b.ano,
        mes: b.mes,
        quantidade: semVendas ? 0 : ((i * 3 + fi * 5 + bi * 2) % 11),
      }));
      const totalVendas = meses.reduce((s, m) => s + m.quantidade, 0);
      rows.push({
        produtoId: `p${i}`,
        codigo,
        descricao,
        farmaciaId: `f${fi}`,
        farmacia,
        pvp: 3.5 + (i % 7) * 2.1,
        custoUnitarioEstimado: 1.8 + (i % 5) * 0.9,
        meses,
        totalVendas,
        valorBruto: totalVendas * (3.5 + (i % 7) * 2.1),
        quantidadeManutencao: 0,
        valorBrutoManutencao: 0,
        existencia: (i * 2 + fi * 3) % 13,
        fabricante: "Fabricante X",
        fornecedor: "Distribuidor Y",
        semVendasNoPeriodo: semVendas,
      });
    });
  });

  const report = buildVendasReport({
    rows: rows as never,
    buckets,
    filters: { agruparPor: "artigo", dataInicio: "2026-07-01", dataFim: "2026-09-30", farmaciasSelecionadas: farmacias, apenasComStock: true },
    universe: { farmacias, fornecedores: [], fabricantes: [], categorias: [] },
    organization: "Grupo Silveira · Exemplo",
  });
  writeFileSync(join(dir, "vendas.html"), renderReportHtml(report), "utf8");
  const pdf = await buildReportPdfBuffer(report);
  writeFileSync(join(dir, "vendas.pdf"), pdf.buffer);
  console.log(`OK: ${report.rows.length} linhas, PDF ${pdf.buffer.length} bytes → ${dir}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
