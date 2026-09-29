/**
 * scripts/investigacao/gerar-exemplos-documentos-profissionais.ts
 *
 * Gera PDFs REAIS (via `buildReportPdfBuffer`, Puppeteer) dos dois
 * documentos profissionais novos — Nota de Encomenda (por fornecedor) e
 * Guia de Transferência — a partir de fixtures realistas, para inspecção
 * visual manual. Não faz parte da suite de testes.
 */
import Module from "node:module";
import { writeFileSync, mkdirSync } from "node:fs";

const M = Module as unknown as { _resolveFilename: (r: string, ...a: unknown[]) => string };
const resolverOriginal = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "server-only" ? __filename : resolverOriginal.call(this, request, ...rest);
};

const OUT_DIR = process.argv[2] ?? "scratchpad";
mkdirSync(OUT_DIR, { recursive: true });

async function main() {
  const { buildEncomendaDocumentoReport } = await import("../../lib/reporting/adapters/encomenda-documento");
  const { buildTransferenciaDocumentoReport } = await import("../../lib/reporting/adapters/transferencia-documento");
  const { buildReportPdfBuffer } = await import("../../lib/reporting/report-pdf-server");

  const encomenda = {
    id: "lst-demo-1",
    nome: "Encomenda Silveirense · Setembro",
    estado: "FINALIZADA" as const,
    estadoExport: "PENDENTE" as const,
    farmaciaId: "f-silveirense",
    farmaciaNome: "Farmácia Silveirense",
    farmaciaMorada: "Rua Principal, 123, 4700-000 Braga",
    farmaciaNif: "500123456",
    farmaciaContacto: "253 000 000 · silveirense@exemplo.pt",
    criadoPorNome: "Ana Costa",
    dataCriacao: new Date("2026-09-28T10:00:00Z"),
    dataAtualizacao: new Date("2026-09-28T10:00:00Z"),
    numero: "EN-000042",
    motivoAnulacao: null,
    anuladoPorNome: null,
    anuladoEm: null,
    versao: 1,
    linhas: [
      { id: "l1", produtoId: "p1", cnp: 5601234, designacao: "Ben-u-ron 1000mg 20 Comprimidos", fabricante: "Bene Farmacia", fornecedor: null, fornecedorSugeridoId: "forn-mepha", fornecedorSugeridoNome: "MEPHA - Investimento e Desenvolvimento Farmacêutico, Lda", currentStock: 12, quantidadeSugerida: 8, quantidadeAjustada: 10, notas: null, origem: "PROPOSTA" as const },
      { id: "l2", produtoId: "p2", cnp: 5602345, designacao: "Brufen 600mg 30 Comprimidos", fabricante: "Abbott", fornecedor: null, fornecedorSugeridoId: "forn-mepha", fornecedorSugeridoNome: "MEPHA - Investimento e Desenvolvimento Farmacêutico, Lda", currentStock: 3, quantidadeSugerida: 20, quantidadeAjustada: 24, notas: "Urgente", origem: "PROPOSTA" as const },
      { id: "l3", produtoId: "p3", cnp: 5603456, designacao: "Voltaren Emulgel 1% 100g", fabricante: "Novartis", fornecedor: null, fornecedorSugeridoId: "forn-udifar", fornecedorSugeridoNome: "UDIFAR - União Distribuidora Farmacêutica, S.A.", currentStock: 0, quantidadeSugerida: 6, quantidadeAjustada: 6, notas: null, origem: "MANUAL" as const },
    ],
    outbox: null,
    timeline: [],
    editable: false,
  };

  const encomendaAnulada = {
    ...encomenda,
    id: "lst-demo-2",
    numero: "EN-000043",
    estado: "ANULADA" as const,
    motivoAnulacao: "Preço alterado pelo fornecedor após confirmação",
    anuladoPorNome: "João Silva",
    anuladoEm: new Date("2026-09-29T09:15:00Z"),
    linhas: [encomenda.linhas[0]],
  };

  const transferencia = {
    id: "trf-demo-1",
    farmaciaOrigemId: "f-silveirense",
    farmaciaOrigemNome: "Farmácia Silveirense",
    farmaciaOrigemMorada: "Rua Principal, 123, 4700-000 Braga",
    farmaciaOrigemNif: "500123456",
    farmaciaOrigemContacto: "253 000 000 · silveirense@exemplo.pt",
    farmaciaDestinoId: "f-segurado",
    farmaciaDestinoNome: "Farmácia Segurado",
    estado: "FINALIZADA" as const,
    criadoPorNome: "Ana Costa",
    dataCriacao: new Date("2026-09-28T14:00:00Z"),
    numero: "TR-000101",
    dataFinalizacao: new Date("2026-09-28T14:05:00Z"),
    motivoAnulacao: null,
    anuladoPorNome: null,
    anuladoEm: null,
    linhas: [
      { produtoId: "p1", cnp: 5601234, designacao: "Ben-u-ron 1000mg 20 Comprimidos", fabricante: "Bene Farmacia", quantidade: 15, notas: null },
      { produtoId: "p4", cnp: 5604567, designacao: "Augmentin 875+125mg 20 Comprimidos", fabricante: "GSK", quantidade: 5, notas: "Reserva para cliente habitual" },
    ],
  };

  const transferenciaAnulada = {
    ...transferencia,
    id: "trf-demo-2",
    numero: "TR-000102",
    estado: "ANULADA" as const,
    motivoAnulacao: "Erro de picking — produto trocado",
    anuladoPorNome: "Maria Fernandes",
    anuladoEm: new Date("2026-09-29T08:30:00Z"),
  };

  const encReports = buildEncomendaDocumentoReport([encomenda as never, encomendaAnulada as never]);
  console.log(`Encomenda: ${encReports.length} documento(s) gerado(s) — ${encReports.map((r) => r.title).join(" | ")}`);
  for (const [i, r] of encReports.entries()) {
    const pdf = await buildReportPdfBuffer(r);
    const path = `${OUT_DIR}/nota-encomenda-${i + 1}.pdf`;
    writeFileSync(path, pdf.buffer);
    console.log(`  → ${path}`);
  }

  const trfReports = [
    buildTransferenciaDocumentoReport([transferencia as never]),
    buildTransferenciaDocumentoReport([transferenciaAnulada as never]),
  ];
  for (const [i, r] of trfReports.entries()) {
    const pdf = await buildReportPdfBuffer(r);
    const path = `${OUT_DIR}/guia-transferencia-${i + 1}.pdf`;
    writeFileSync(path, pdf.buffer);
    console.log(`Transferência: ${r.title} → ${path}`);
  }

  // `buildReportPdfBuffer` mantém um browser Puppeteer singleton a nível
  // de módulo (ver lib/reporting/report-pdf-server.ts), nunca fechado —
  // sem process.exit explícito este script nunca terminaria sozinho.
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
