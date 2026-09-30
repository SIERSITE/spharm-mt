/**
 * scripts/tests/test-documentos-finalizacao.ts
 *
 * Pontos 3/4/7 — documentos gerados após finalizar (Nota de Encomenda,
 * Encomenda Consolidada do Grupo, Guia de Transferência). Puro: fixtures
 * no formato de `OrderDetail`/`TransferenciaDetail`, sem Prisma.
 *
 * O ponto central do Ponto 3 (decisão de arquitectura): a "Encomenda
 * Consolidada do Grupo" agrega quantidades por produto SEM nunca perder
 * a origem por farmácia — testado explicitamente abaixo (secção B).
 */
import { buildEncomendaDocumentoReport } from "../../lib/reporting/adapters/encomenda-documento";
import { buildEncomendaConsolidadaDocumentoReport } from "../../lib/reporting/adapters/encomenda-consolidada-documento";
import { buildTransferenciaDocumentoReport } from "../../lib/reporting/adapters/transferencia-documento";
import { GROUP_KEY, ROW_KIND_KEY, linhasDeDetalhe } from "../../lib/reporting/report-types";
import type { OrderDetail } from "../../lib/encomendas/order-detail";
import type { TransferenciaDetail } from "../../lib/transferencias/transferencia-detail";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  [OK]    ${msg}`); }
  else { failed++; console.log(`  [FALHA] ${msg}`); }
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
    numero: null,
    motivoAnulacao: null,
    anuladoPorNome: null,
    anuladoEm: null,
    versao: 1,
    loteOrigemId: null,
    loteOrigemNome: null,
    loteDivididoEm: null,
    documentosGerados: [],
    outbox: null,
    timeline: [],
    editable: false,
    ...over,
  };
}
function linha(over: Partial<OrderDetail["linhas"][number]> & { produtoId: string; cnp: number }): OrderDetail["linhas"][number] {
  return {
    id: `l-${over.produtoId}`,
    designacao: `Produto ${over.cnp}`,
    fabricante: null,
    fornecedor: null,
    fornecedorSugeridoId: null,
    fornecedorSugeridoNome: null,
    currentStock: null,
    quantidadeSugerida: null,
    quantidadeAjustada: 0,
    notas: null,
    origem: "PROPOSTA",
    ...over,
  };
}

console.log("\nA · encomenda-documento — 1 farmácia, 1 fornecedor (documento único)");
{
  const d = encomenda({
    farmaciaNome: "Silveirense",
    linhas: [
      linha({ produtoId: "p1", cnp: 1001, quantidadeAjustada: 10, quantidadeSugerida: 8, fornecedorSugeridoId: "forn-A", fornecedorSugeridoNome: "Fornecedor A" }),
      linha({ produtoId: "p2", cnp: 1002, quantidadeAjustada: 5, fornecedorSugeridoId: "forn-A", fornecedorSugeridoNome: "Fornecedor A" }),
    ],
  });
  const reports = buildEncomendaDocumentoReport([d]);
  check(reports.length === 1, "A0: um só fornecedor → um só documento");
  const r = reports[0];
  check(r.title.includes("Fornecedor A"), "A1: título identifica o FORNECEDOR (nunca a farmácia)");
  check(r.rows.length === 2, "A2: 2 linhas");
  check(!r.columns.some((c) => c.key === "fabricante"), "A3: sem coluna Fabricante (informação interna)");
  check(!r.columns.some((c) => c.key === "fornecedor"), "A3b: sem coluna Fornecedor por linha — está no cabeçalho, nunca repetido");
  check(!r.columns.some((c) => c.key === "sugerida"), "A3c: sem coluna Qtd. sugerida — só a quantidade CONFIRMADA aparece");
  check(r.rows.every((row) => row.quantidade === 10 || row.quantidade === 5), "A3d: a quantidade mostrada é sempre a ajustada/confirmada, nunca a sugerida");
  const totalUnid = r.summary?.find((s) => s.label === "Unidades")?.value;
  check(totalUnid === 15, "A4: resumo soma as unidades certas (10+5)");
  check(r.meta?.organization === "Silveirense", "A5: organization é a farmácia (emissora), não o fornecedor");
}

console.log("\nB · encomenda-documento — vários fornecedores na MESMA encomenda → documentos separados");
{
  const d = encomenda({
    farmaciaNome: "Silveirense",
    linhas: [
      linha({ produtoId: "p1", cnp: 1001, quantidadeAjustada: 10, fornecedorSugeridoId: "forn-A", fornecedorSugeridoNome: "Fornecedor A" }),
      linha({ produtoId: "p2", cnp: 1002, quantidadeAjustada: 3, fornecedorSugeridoId: "forn-B", fornecedorSugeridoNome: "Fornecedor B" }),
      linha({ produtoId: "p3", cnp: 1003, quantidadeAjustada: 7, fornecedorSugeridoId: "forn-A", fornecedorSugeridoNome: "Fornecedor A" }),
    ],
  });
  const reports = buildEncomendaDocumentoReport([d]);
  check(reports.length === 2, "B1: 2 fornecedores → 2 documentos separados, nunca um misto");
  const rA = reports.find((r) => r.title.includes("Fornecedor A"));
  const rB = reports.find((r) => r.title.includes("Fornecedor B"));
  check(!!rA && rA.rows.length === 2, "B2: documento do Fornecedor A só tem as SUAS 2 linhas (p1+p3)");
  check(!!rB && rB.rows.length === 1, "B3: documento do Fornecedor B só tem a SUA 1 linha (p2)");
  check(rA?.summary?.find((s) => s.label === "Unidades")?.value === 17, "B4: total do Fornecedor A soma 10+7=17 — nunca inclui a linha do B");
  check(rB?.summary?.find((s) => s.label === "Unidades")?.value === 3, "B5: total do Fornecedor B é só 3");
  check(
    !!rA?.rows.every((row) => !("fornecedor" in row)) && !!rB?.rows.every((row) => !("fornecedor" in row)),
    "B6: nenhum documento repete o fornecedor por linha — cada um só sabe do seu próprio, no título"
  );
}

console.log("\nB-bis · encomenda-documento — linha sem fornecedor decidido cai num grupo próprio, nunca omitida");
{
  const d = encomenda({
    farmaciaNome: "Silveirense",
    linhas: [linha({ produtoId: "p1", cnp: 1001, quantidadeAjustada: 4 })],
  });
  const reports = buildEncomendaDocumentoReport([d]);
  check(reports.length === 1, "B7: 1 documento para a linha sem fornecedor");
  check(reports[0].title.includes("Fornecedor não definido"), "B8: título deixa claro que o fornecedor não está decidido — nunca esconde a linha");
}

console.log("\nB-ter · encomenda-documento — ANULADA gera cancelledStamp");
{
  const d = encomenda({
    farmaciaNome: "Silveirense",
    estado: "ANULADA",
    numero: "EN-000009",
    motivoAnulacao: "Preço alterado pelo fornecedor",
    anuladoPorNome: "João",
    anuladoEm: new Date("2026-09-25T09:00:00Z"),
    linhas: [linha({ produtoId: "p1", cnp: 1001, quantidadeAjustada: 4, fornecedorSugeridoId: "forn-A", fornecedorSugeridoNome: "Fornecedor A" })],
  });
  const [r] = buildEncomendaDocumentoReport([d]);
  check(r.meta?.cancelledStamp?.motivo === "Preço alterado pelo fornecedor", "B9: ANULADA gera cancelledStamp com o motivo real");
  check(r.meta?.cancelledStamp?.por === "João", "B10: cancelledStamp identifica quem anulou");
}

console.log("\nC · encomenda-consolidada — agrega por produto, preserva origem por farmácia");
{
  const d1 = encomenda({ farmaciaNome: "Segurado", linhas: [linha({ produtoId: "pA", cnp: 2001, quantidadeAjustada: 10 }), linha({ produtoId: "pB", cnp: 2002, quantidadeAjustada: 4 })] });
  const d2 = encomenda({ farmaciaNome: "Silveirense", linhas: [linha({ produtoId: "pA", cnp: 2001, quantidadeAjustada: 20 }), linha({ produtoId: "pC", cnp: 2003, quantidadeAjustada: 7 })] });
  const r = buildEncomendaConsolidadaDocumentoReport([d1, d2]);
  const detalhe = linhasDeDetalhe(r.rows);
  check(detalhe.length === 4, "C1: 4 linhas de detalhe (10+4 da Segurado, 20+7 da Silveirense) — nenhuma linha perdida");
  const totalA = r.rows.find((row) => row[ROW_KIND_KEY] === "subtotal" && row.cnp === "2001");
  check(totalA?.quantidade === 30, "C2: produto A agregado — 10 (Segurado) + 20 (Silveirense) = 30, exactamente o exemplo do pedido");
  check(!r.rows.some((row) => row[ROW_KIND_KEY] === "subtotal" && row.cnp === "2002"), "C3: produto B (só 1 farmácia) não gera TOTAL — seria cópia exacta da linha");
  const linhasA = detalhe.filter((row) => row.cnp === "2001");
  check(
    linhasA.some((l) => l.farmacia === "Segurado" && l.quantidade === 10) &&
      linhasA.some((l) => l.farmacia === "Silveirense" && l.quantidade === 20),
    "C4: origem por farmácia preservada dentro do grupo — nunca perdida, só apresentada agregada"
  );
  check(!!r.summary?.some((s) => s.label === "Farmácias" && s.value === 2), "C5: resumo conta as 2 farmácias envolvidas");
}

console.log("\nD · transferencia-documento — 1 e N transferências");
{
  const t1: TransferenciaDetail = {
    id: "t1", farmaciaOrigemId: "fo", farmaciaOrigemNome: "Segurado",
    farmaciaOrigemMorada: "Rua Teste, 1", farmaciaOrigemNif: "123456789", farmaciaOrigemContacto: "210000000",
    farmaciaDestinoId: "fd", farmaciaDestinoNome: "Silveirense",
    estado: "FINALIZADA", criadoPorNome: "U", dataCriacao: new Date(),
    numero: "TR-000001", dataFinalizacao: new Date(),
    motivoAnulacao: null, anuladoPorNome: null, anuladoEm: null,
    linhas: [{ produtoId: "p1", cnp: 3001, designacao: "Produto A", fabricante: null, quantidade: 5, notas: null }],
  };
  const r1 = buildTransferenciaDocumentoReport([t1]);
  check(r1.title === "Guia de Transferência", "D1: título singular para uma só transferência");
  check(!!r1.subtitle?.includes("Segurado") && !!r1.subtitle?.includes("Silveirense"), "D2: subtítulo mostra origem → destino");
  check(!r1.columns.some((c) => c.key === "rota"), "D3: sem coluna Rota redundante (já está no subtítulo)");
  check(!r1.columns.some((c) => c.key === "fabricante"), "D3b: sem coluna Fabricante (informação interna, nunca no documento)");
  check(r1.rows.every((row) => !("fabricante" in row)), "D3c: nenhuma linha traz a chave fabricante");
  // "Preparado por"/"Recebido por" vivem em `meta.footer` (não `summary`)
  // porque `density: "compact"` esconde os cartões de resumo em HTML/PDF
  // — ver comentário de `buildSummary` no adapter.
  check(!!r1.meta?.footer?.includes("Preparado por: U"), "D3d: rodapé mostra Preparado por");
  check(!!r1.meta?.footer?.includes("Recebido por: ____________________"), "D3e: rodapé mostra linha para assinatura de Recebido por");
  check(!!r1.filtersApplied?.some((f) => f.label === "Nº Documento" && f.value === "TR-000001"), "D3f: cabeçalho (filtersApplied) mostra o número do documento");
  check(r1.meta?.organization === "Segurado", "D3g: organization é a farmácia de ORIGEM, não o nome do SaaS");
  check(r1.meta?.organizationAddress === "Rua Teste, 1", "D3h: organizationAddress vem da farmácia de origem");
  check(r1.meta?.organizationNif === "123456789", "D3i: organizationNif vem da farmácia de origem");
  check(r1.meta?.cancelledStamp === undefined, "D3j: sem selo ANULADO numa transferência FINALIZADA");

  const t2: TransferenciaDetail = { ...t1, id: "t2", farmaciaOrigemNome: "Garantia", linhas: [{ ...t1.linhas[0], quantidade: 8 }] };
  const rTodas = buildTransferenciaDocumentoReport([t1, t2]);
  check(!!rTodas.columns.some((c) => c.key === "rota" && c.spanGroup), "D4: «todas» mostra a coluna Rota, agrupada");
  check(linhasDeDetalhe(rTodas.rows).length === 2, "D5: as 2 transferências aparecem, cada uma com a sua linha");

  // Número/rascunho e morada/NIF/contacto ausentes — nunca "null" nem "()" no output.
  const t5: TransferenciaDetail = {
    ...t1, id: "t5", numero: null,
    farmaciaOrigemMorada: null, farmaciaOrigemNif: null, farmaciaOrigemContacto: null,
  };
  const r5 = buildTransferenciaDocumentoReport([t5]);
  check(!!r5.filtersApplied?.some((f) => f.label === "Nº Documento" && f.value === "(rascunho)"), "D6: sem número mostra (rascunho), nunca null");
  check(r5.meta?.organizationAddress === undefined, "D7: morada ausente vira undefined (nunca string vazia)");
  check(r5.meta?.organizationNif === undefined, "D8: NIF ausente vira undefined");
  check(r5.meta?.organizationContact === undefined, "D9: contacto ausente vira undefined");

  // Transferência ANULADA — selo "ANULADO" (documento simples).
  const t3: TransferenciaDetail = {
    ...t1, id: "t3", estado: "ANULADA", numero: "TR-000002",
    motivoAnulacao: "Erro de picking", anuladoPorNome: "Maria", anuladoEm: new Date("2026-09-20T10:00:00Z"),
  };
  const r3 = buildTransferenciaDocumentoReport([t3]);
  check(r3.meta?.cancelledStamp?.motivo === "Erro de picking", "D10: transferência ANULADA gera cancelledStamp com o motivo certo");
  check(r3.meta?.cancelledStamp?.por === "Maria", "D11: cancelledStamp identifica quem anulou");

  // Lote TODO anulado — o selo aparece ao nível do documento.
  const t4: TransferenciaDetail = { ...t3, id: "t4", farmaciaOrigemNome: "Garantia" };
  const rTodasAnuladas = buildTransferenciaDocumentoReport([t3, t4]);
  check(!!rTodasAnuladas.meta?.cancelledStamp, "D12: lote inteiro ANULADO também gera cancelledStamp");

  // Lote MISTO (uma ANULADA, outra não) — sem selo de documento; a linha/grupo
  // afectado fica marcada com "(ANULADO)" no próprio texto da rota.
  const rMista = buildTransferenciaDocumentoReport([t1, t3]);
  check(rMista.meta?.cancelledStamp === undefined, "D13: lote misto não acende o selo do documento inteiro");
  check(
    rMista.rows.some((row) => row[GROUP_KEY] === "t3" && typeof row.rota === "string" && row.rota.startsWith("(ANULADO)")),
    "D14: lote misto marca só a linha da transferência ANULADA com «(ANULADO)» na rota"
  );
}

console.log(`\n${passed} ok, ${failed} falhas`);
if (failed > 0) process.exit(1);
