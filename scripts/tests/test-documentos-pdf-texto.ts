/**
 * scripts/tests/test-documentos-pdf-texto.ts
 *
 * Testa os dois documentos profissionais (Nota de Encomenda, Guia de
 * Transferência) por EXTRAÇÃO DE TEXTO REAL do PDF gerado (via
 * `buildReportPdfBuffer` + `pdf-parse`) — não apenas a estrutura do
 * `Report` em memória. Cobre directamente os pontos do pedido:
 *
 *   13. o documento externo de encomenda não contém fornecedor por
 *       linha, fabricante nem quantidade sugerida
 *   14. o PDF mostra sempre a quantidade FINAL confirmada
 *   15. uma encomenda com vários fornecedores gera documentos separados
 *       (o PDF de um fornecedor nunca menciona o nome do outro)
 *   16. o documento de transferência só tem informação profissional
 *       externa (sem fabricante/stock/cobertura/rotação/custo)
 *   17. a ordem das linhas no PDF corresponde à ordem confirmada
 *
 * A validação VISUAL (renderização real) foi feita manualmente a partir
 * dos mesmos PDFs gerados por este ficheiro — ver
 * `scripts/investigacao/gerar-exemplos-documentos-profissionais.ts` e o
 * relatório final da funcionalidade.
 *
 * Puro — sem BD (fixtures no formato de `OrderDetail`/`TransferenciaDetail`).
 * Uso: npx tsx scripts/tests/test-documentos-pdf-texto.ts
 */
import Module from "node:module";
import { PDFParse } from "pdf-parse";
import type { OrderDetail } from "../../lib/encomendas/order-detail";
import type { TransferenciaDetail } from "../../lib/transferencias/transferencia-detail";

const M = Module as unknown as { _resolveFilename: (r: string, ...a: unknown[]) => string };
const resolverOriginal = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "server-only" ? __filename : resolverOriginal.call(this, request, ...rest);
};

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string, detalhe?: string) {
  if (cond) { passed++; console.log(`  [OK]    ${msg}`); }
  else { failed++; console.log(`  [FALHA] ${msg}${detalhe ? `\n            ${detalhe}` : ""}`); }
}

async function extrairTexto(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  const result = await parser.getText();
  await parser.destroy?.();
  return result.text;
}

function encomenda(over: Partial<OrderDetail> & { farmaciaNome: string; linhas: OrderDetail["linhas"] }): OrderDetail {
  return {
    id: `lst-${over.farmaciaNome}`,
    nome: "Encomenda teste",
    estado: "FINALIZADA",
    estadoExport: "PENDENTE",
    farmaciaId: `f-${over.farmaciaNome}`,
    farmaciaMorada: null,
    farmaciaNif: null,
    farmaciaContacto: null,
    criadoPorNome: "U",
    dataCriacao: new Date(),
    dataAtualizacao: new Date(),
    numero: "EN-000001",
    motivoAnulacao: null,
    anuladoPorNome: null,
    anuladoEm: null,
    versao: 1,
    outbox: null,
    timeline: [],
    editable: false,
    ...over,
  } as OrderDetail;
}
function linha(over: Partial<OrderDetail["linhas"][number]> & { produtoId: string; cnp: number }): OrderDetail["linhas"][number] {
  return {
    id: `l-${over.produtoId}`,
    designacao: `Produto ${over.cnp}`,
    fabricante: "Fabricante Sigiloso Lda",
    fornecedor: null,
    fornecedorSugeridoId: null,
    fornecedorSugeridoNome: null,
    currentStock: 99,
    quantidadeSugerida: 1,
    quantidadeAjustada: 0,
    notas: null,
    origem: "PROPOSTA",
    ...over,
  } as OrderDetail["linhas"][number];
}

async function main() {
  const { buildEncomendaDocumentoReport } = await import("../../lib/reporting/adapters/encomenda-documento");
  const { buildTransferenciaDocumentoReport } = await import("../../lib/reporting/adapters/transferencia-documento");
  const { buildReportPdfBuffer } = await import("../../lib/reporting/report-pdf-server");

  console.log("\nA · encomenda com 1 fornecedor — extração de texto");
  {
    const d = encomenda({
      farmaciaNome: "Silveirense",
      linhas: [
        linha({ produtoId: "p1", cnp: 5551111, designacao: "Produto Confidencial X", quantidadeSugerida: 999, quantidadeAjustada: 7, fabricante: "Segredo Industrial Lda", fornecedorSugeridoId: "forn-A", fornecedorSugeridoNome: "Distribuidora Alfa" }),
      ],
    });
    const [report] = buildEncomendaDocumentoReport([d]);
    const texto = await extrairTexto((await buildReportPdfBuffer(report)).buffer);

    check(!texto.includes("Segredo Industrial"), "A1 (ponto 13): PDF real NÃO contém o nome do fabricante");
    check(!/\b999\b/.test(texto), "A2 (ponto 13/14): PDF real NÃO mostra a quantidade SUGERIDA (999)");
    check(/\b7\b/.test(texto), "A3 (ponto 14): PDF real mostra a quantidade CONFIRMADA (7)");
    check(texto.includes("Distribuidora Alfa"), "A4: PDF real identifica o fornecedor no cabeçalho");
    check(!/Fabricante/i.test(texto), "A5 (ponto 13): a palavra \"Fabricante\" não aparece em lado nenhum do documento");
  }

  console.log("\nB · encomenda com 2 fornecedores — documentos separados (ponto 15)");
  {
    const d = encomenda({
      farmaciaNome: "Silveirense",
      linhas: [
        linha({ produtoId: "p1", cnp: 5551111, designacao: "Produto Alfa", quantidadeAjustada: 3, fornecedorSugeridoId: "forn-A", fornecedorSugeridoNome: "Distribuidora Alfa Exclusiva" }),
        linha({ produtoId: "p2", cnp: 5552222, designacao: "Produto Beta", quantidadeAjustada: 9, fornecedorSugeridoId: "forn-B", fornecedorSugeridoNome: "Distribuidora Beta Exclusiva" }),
      ],
    });
    const reports = buildEncomendaDocumentoReport([d]);
    check(reports.length === 2, "B1: 2 documentos gerados, um por fornecedor");
    const textoA = await extrairTexto((await buildReportPdfBuffer(reports[0])).buffer);
    const textoB = await extrairTexto((await buildReportPdfBuffer(reports[1])).buffer);
    check(textoA.includes("Distribuidora Alfa Exclusiva") && !textoA.includes("Distribuidora Beta Exclusiva"), "B2: PDF real do fornecedor A nunca menciona o fornecedor B");
    check(textoB.includes("Distribuidora Beta Exclusiva") && !textoB.includes("Distribuidora Alfa Exclusiva"), "B3: PDF real do fornecedor B nunca menciona o fornecedor A");
    check(textoA.includes("Produto Alfa") && !textoA.includes("Produto Beta"), "B4: PDF real do fornecedor A só tem a SUA linha (Produto Alfa)");
    check(textoB.includes("Produto Beta") && !textoB.includes("Produto Alfa"), "B5: PDF real do fornecedor B só tem a SUA linha (Produto Beta)");
  }

  console.log("\nC · ordem das linhas no PDF corresponde à ordem confirmada (ponto 17)");
  {
    const d = encomenda({
      farmaciaNome: "Silveirense",
      linhas: [
        linha({ produtoId: "p3", cnp: 5553333, designacao: "Zebra Produto Terceiro", quantidadeAjustada: 1, fornecedorSugeridoId: "forn-A", fornecedorSugeridoNome: "Único Fornecedor" }),
        linha({ produtoId: "p1", cnp: 5551111, designacao: "Alfa Produto Primeiro", quantidadeAjustada: 2, fornecedorSugeridoId: "forn-A", fornecedorSugeridoNome: "Único Fornecedor" }),
        linha({ produtoId: "p2", cnp: 5552222, designacao: "Meio Produto Segundo", quantidadeAjustada: 3, fornecedorSugeridoId: "forn-A", fornecedorSugeridoNome: "Único Fornecedor" }),
      ],
    });
    const [report] = buildEncomendaDocumentoReport([d]);
    const texto = await extrairTexto((await buildReportPdfBuffer(report)).buffer);
    const posTerceiro = texto.indexOf("Zebra Produto Terceiro");
    const posPrimeiro = texto.indexOf("Alfa Produto Primeiro");
    const posSegundo = texto.indexOf("Meio Produto Segundo");
    check(
      posTerceiro >= 0 && posPrimeiro > posTerceiro && posSegundo > posPrimeiro,
      "C1: PDF real preserva a ordem exacta das linhas confirmadas (Terceiro, Primeiro, Segundo — nunca reordenado alfabeticamente)",
      `posições: terceiro=${posTerceiro} primeiro=${posPrimeiro} segundo=${posSegundo}`
    );
  }

  console.log("\nD · guia de transferência — só informação profissional externa (ponto 16)");
  {
    const t: TransferenciaDetail = {
      id: "t1",
      farmaciaOrigemId: "fo",
      farmaciaOrigemNome: "Farmácia Origem",
      farmaciaOrigemMorada: null,
      farmaciaOrigemNif: null,
      farmaciaOrigemContacto: null,
      farmaciaDestinoId: "fd",
      farmaciaDestinoNome: "Farmácia Destino",
      estado: "FINALIZADA",
      criadoPorNome: "Rita Andrade",
      dataCriacao: new Date(),
      numero: "TR-000009",
      dataFinalizacao: new Date(),
      motivoAnulacao: null,
      anuladoPorNome: null,
      anuladoEm: null,
      linhas: [
        { produtoId: "p1", cnp: 5559999, designacao: "Produto Transferido", fabricante: "Fabricante Nunca Deve Aparecer Lda", quantidade: 4, notas: null },
      ],
    };
    const report = buildTransferenciaDocumentoReport([t]);
    const texto = await extrairTexto((await buildReportPdfBuffer(report)).buffer);
    check(!texto.includes("Fabricante Nunca Deve Aparecer"), "D1 (ponto 16): PDF real NÃO contém o nome do fabricante");
    check(!/Fabricante|Stock|Cobertura|Rotaç|Custo/i.test(texto), "D2 (ponto 16): nenhum termo interno (Fabricante/Stock/Cobertura/Rotação/Custo) aparece no documento real");
    check(texto.includes("Preparado por: Rita Andrade"), "D3: PDF real mostra quem preparou");
    check(texto.includes("Recebido por:"), "D4: PDF real mostra o campo para o destinatário assinar");
    check(texto.includes("TR-000009"), "D5: PDF real mostra o número do documento");
  }

  console.log(`\n${passed} ok, ${failed} falhas`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
