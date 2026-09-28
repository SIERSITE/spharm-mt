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
    criadoPorNome: "U",
    dataCriacao: new Date(),
    dataAtualizacao: new Date(),
    versao: 1,
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
    currentStock: null,
    quantidadeSugerida: null,
    quantidadeAjustada: 0,
    notas: null,
    origem: "PROPOSTA",
    ...over,
  };
}

console.log("\nA · encomenda-documento — 1 farmácia (documento simples)");
{
  const d = encomenda({
    farmaciaNome: "Silveirense",
    linhas: [
      linha({ produtoId: "p1", cnp: 1001, quantidadeAjustada: 10, quantidadeSugerida: 8 }),
      linha({ produtoId: "p2", cnp: 1002, quantidadeAjustada: 5 }),
    ],
  });
  const r = buildEncomendaDocumentoReport([d]);
  check(r.title.includes("Silveirense"), "A1: título identifica a farmácia");
  check(r.rows.length === 2, "A2: 2 linhas, sem grupo nem subtotal (uma só farmácia)");
  check(!r.columns.some((c) => c.key === "farmacia"), "A3: sem coluna Farmácia (redundante com o título)");
  const totalUnid = r.summary?.find((s) => s.label === "Unidades")?.value;
  check(totalUnid === 15, "A4: resumo soma as unidades certas (10+5)");
}

console.log("\nB · encomenda-documento — «todas» (multi-farmácia, agrupado)");
{
  const d1 = encomenda({ farmaciaNome: "Silveirense", linhas: [linha({ produtoId: "p1", cnp: 1001, quantidadeAjustada: 10 }), linha({ produtoId: "p2", cnp: 1002, quantidadeAjustada: 3 })] });
  const d2 = encomenda({ farmaciaNome: "Segurado", linhas: [linha({ produtoId: "p1", cnp: 1001, quantidadeAjustada: 20 })] });
  const r = buildEncomendaDocumentoReport([d1, d2]);
  check(!!r.columns.some((c) => c.key === "farmacia" && c.spanGroup), "B1: coluna Farmácia agrupada (spanGroup) — uma por lista");
  check(r.rows.filter((row) => row[GROUP_KEY] === d1.id).length === 3, "B2: grupo da Silveirense tem 2 linhas + TOTAL (2 linhas → tem subtotal)");
  check(r.rows.filter((row) => row[GROUP_KEY] === d2.id).length === 1, "B3: grupo da Segurado só tem 1 linha, sem TOTAL (uma só linha não precisa)");
  const totalSilv = r.rows.find((row) => row[GROUP_KEY] === d1.id && row[ROW_KIND_KEY] === "subtotal");
  check(totalSilv?.quantidade === 13, "B4: TOTAL da Silveirense soma 10+3=13");
  const detalhe = linhasDeDetalhe(r.rows);
  check(detalhe.length === 3, "B5: 3 linhas de detalhe reais (o subtotal não conta)");
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
    farmaciaDestinoId: "fd", farmaciaDestinoNome: "Silveirense",
    estado: "FINALIZADA", criadoPorNome: "U", dataCriacao: new Date(),
    linhas: [{ produtoId: "p1", cnp: 3001, designacao: "Produto A", fabricante: null, quantidade: 5, notas: null }],
  };
  const r1 = buildTransferenciaDocumentoReport([t1]);
  check(r1.title === "Guia de Transferência", "D1: título singular para uma só transferência");
  check(!!r1.subtitle?.includes("Segurado") && !!r1.subtitle?.includes("Silveirense"), "D2: subtítulo mostra origem → destino");
  check(!r1.columns.some((c) => c.key === "rota"), "D3: sem coluna Rota redundante (já está no subtítulo)");

  const t2: TransferenciaDetail = { ...t1, id: "t2", farmaciaOrigemNome: "Garantia", linhas: [{ ...t1.linhas[0], quantidade: 8 }] };
  const rTodas = buildTransferenciaDocumentoReport([t1, t2]);
  check(!!rTodas.columns.some((c) => c.key === "rota" && c.spanGroup), "D4: «todas» mostra a coluna Rota, agrupada");
  check(linhasDeDetalhe(rTodas.rows).length === 2, "D5: as 2 transferências aparecem, cada uma com a sua linha");
}

console.log(`\n${passed} ok, ${failed} falhas`);
if (failed > 0) process.exit(1);
