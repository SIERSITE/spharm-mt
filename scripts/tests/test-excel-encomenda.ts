/**
 * scripts/tests/test-excel-encomenda.ts
 *
 * Excel da encomenda finalizada: estrutura EXATA (3 colunas, sem cabeçalho/título/totais, 1.ª linha = 1.º produto, uma folha
 * «Encomenda», CNP inteiro com todos os dígitos, quantidade numérica, sem fórmulas), exclusão de quantidade 0, um Excel por
 * encomenda/fornecedor, nome do ficheiro sanitizado — o XLSX gerado é ABERTO com a biblioteca de leitura e as células/tipos validados.
 *
 * Corre com:  npx tsx scripts/tests/test-excel-encomenda.ts
 */
import * as XLSX from "xlsx";
import { construirXlsxEncomenda, linhasParaExcel, nomeFicheiroExcelEncomenda } from "../../lib/encomendas/excel-encomenda";
import { urlExcelEncomenda } from "../../lib/encomendas/excel-url";
import { fornecedoresDaEncomenda } from "../../lib/reporting/adapters/encomenda-documento";
import type { OrderDetail, OrderDetailLine } from "../../lib/encomendas/order-detail";

let pass = 0;
let fail = 0;
const ok = (label: string, cond: boolean, detalhe?: string) => {
  if (cond) { pass++; console.log(`  [OK]    ${label}`); }
  else { fail++; console.log(`  [FALHA] ${label}${detalhe ? ` — ${detalhe}` : ""}`); }
};

function linha(cnp: number, designacao: string, qtd: number | null, fornecedor: { id: string; nome: string } | null): OrderDetailLine {
  return {
    id: `l${cnp}`, produtoId: `p${cnp}`, cnp, designacao, fabricante: "Fab", fornecedor: null,
    fornecedorSugeridoId: fornecedor?.id ?? null, fornecedorSugeridoNome: fornecedor?.nome ?? null, currentStock: 3,
    quantidadeSugerida: 5, quantidadeAjustada: qtd, notas: "nota interna", origem: "PROPOSTA",
  } as OrderDetailLine;
}
const F1 = { id: "f1", nome: "Alliance Healthcare" };
const F2 = { id: "f2", nome: "OCP Portugal" };
function detalhe(over: Partial<OrderDetail> = {}, linhas: OrderDetailLine[] = []): OrderDetail {
  return { id: "cmabc123", nome: "Enc", estado: "FINALIZADA", farmaciaNome: "Farmácia Silveirense", numero: "EN-000012", linhas, ...over } as OrderDetail;
}
function ler(buf: Buffer) {
  const wb = XLSX.read(buf, { type: "buffer", cellNF: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return { wb, ws, aoa: XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: true }) as unknown[][] };
}

console.log("\n=== A. Estrutura do ficheiro (aberto com a biblioteca de leitura) ===");
{
  const d = detalhe({}, [
    linha(5418488, "ACLASTA 5 MG/100 ML SOL. PARA PERFUSÃO", 2, F1),
    linha(7009597, "Aerochamber Plus Flow Vu/medium Mask", 6, F1),
    linha(1234567890123, "ARTIGO COM CÓDIGO LONGO DE 13 DÍGITOS", 1, F1),
    linha(8000001, "PRODUTO A ZERO", 0, F1),
    linha(8000002, "PRODUTO SEM QUANTIDADE", null, F1),
    linha(8000003, "FRAÇÃO", 2.5, F1),
  ]);
  const linhas = linhasParaExcel(d);
  const { wb, ws, aoa } = ler(construirXlsxEncomenda(linhas));
  ok("uma única folha, chamada «Encomenda»", wb.SheetNames.length === 1 && wb.SheetNames[0] === "Encomenda");
  ok("a 1.ª linha da folha é IMEDIATAMENTE o 1.º produto (sem cabeçalho, título, nome da farmácia, data…)", aoa[0][0] === 5418488 && aoa[0][1] === "ACLASTA 5 MG/100 ML SOL. PARA PERFUSÃO" && aoa[0][2] === 2, JSON.stringify(aoa[0]));
  ok("apenas 3 colunas (A:C) e nenhuma linha em branco antes/depois dos dados", ws["!ref"] === `A1:C${linhas.length}` && aoa.length === linhas.length && aoa.every((r) => r.length === 3 && r.every((c) => c !== undefined && c !== "")));
  ok("quantidade 0 e quantidade ausente NÃO entram", !aoa.some((r) => r[0] === 8000001 || r[0] === 8000002) && linhas.length === 4);
  ok("CNP e quantidade são NÚMEROS (não texto); designação é texto", aoa.every((r) => typeof r[0] === "number" && typeof r[2] === "number" && typeof r[1] === "string"));
  ok("CNP longo preservado (13 dígitos) e formato «0» — nunca notação científica", aoa[2][0] === 1234567890123 && ws["A3"].z === "0" && ws["A1"].z === "0");
  ok("quantidade fracionária preservada", aoa[3][2] === 2.5);
  ok("sem fórmulas, sem células fora de A:C, sem colunas ocultas", Object.keys(ws).filter((k) => !k.startsWith("!")).every((k) => /^[ABC]\d+$/.test(k) && !ws[k].f) && !ws["!cols"]?.some((c) => c.hidden) && !ws["!rows"]?.length);
  ok("sem merges nem filtros nem painéis (nenhuma formatação de relatório)", !ws["!merges"] && !ws["!autofilter"]);
  ok("texto sem cabeçalho nenhum: nenhuma célula contém «CNP», «Designação», «Quantidade», farmácia, data ou totais", !aoa.flat().some((c) => typeof c === "string" && /^(CNP|Designa[cç][aã]o|Quantidade|Total)/i.test(c)) && !JSON.stringify(aoa).match(/Silveirense|EN-000012|nota interna/i));
}

console.log("\n=== B. Uma encomenda ↔ um Excel; vários fornecedores; farmácias diferentes ===");
{
  const d = detalhe({}, [
    linha(100, "A", 1, F1), linha(101, "B", 2, F2), linha(102, "C", 3, F1), linha(103, "D", 4, null), linha(104, "E zero", 0, F2),
  ]);
  ok("sem filtro: a encomenda toda (quantidade > 0)", linhasParaExcel(d).map((l) => l.cnp).join() === "100,101,102,103");
  ok("por fornecedor: só as linhas desse fornecedor", linhasParaExcel(d, "f1").map((l) => l.cnp).join() === "100,102" && linhasParaExcel(d, "f2").map((l) => l.cnp).join() === "101");
  ok("«sem fornecedor» só as linhas sem fornecedor decidido", linhasParaExcel(d, "sem").map((l) => l.cnp).join() === "103");
  const fornecedores = fornecedoresDaEncomenda(d);
  ok("os fornecedores seguem a MESMA ordem dos documentos (Imprimir/PDF/Email)", fornecedores.map((f) => f.id).join() === "f1,f2," && fornecedores[2].id === null);
  ok("URL: um documento → Excel da encomenda; vários → o do SEU fornecedor", urlExcelEncomenda("abc", fornecedores[0], 1) === "/api/encomendas/abc/excel" && urlExcelEncomenda("abc", fornecedores[1], 3) === "/api/encomendas/abc/excel?fornecedor=f2" && urlExcelEncomenda("abc", fornecedores[2], 3) === "/api/encomendas/abc/excel?fornecedor=sem");
  const d2 = detalhe({ id: "cmzzz", farmaciaNome: "Farmácia Segurado", numero: null }, [linha(200, "Z", 9, F2)]);
  const a = linhasParaExcel(d); const b = linhasParaExcel(d2);
  ok("duas encomendas (farmácias/fornecedores diferentes) → cada Excel só tem as SUAS linhas", a.every((l) => l.cnp < 200) && b.length === 1 && b[0].cnp === 200);
}

console.log("\n=== C. Nome do ficheiro ===");
{
  const d = detalhe({}, [linha(1, "A", 1, F1)]);
  ok("encomenda-<farmácia>-<fornecedor>-<número>.xlsx, sanitizado", nomeFicheiroExcelEncomenda(d) === "encomenda-farmacia-silveirense-alliance-healthcare-en-000012.xlsx", nomeFicheiroExcelEncomenda(d));
  ok("sem número documental usa o identificador (sem colisões)", nomeFicheiroExcelEncomenda(detalhe({ numero: null }, [linha(1, "A", 1, F1)])) === "encomenda-farmacia-silveirense-alliance-healthcare-cmabc123.xlsx");
  const varios = detalhe({}, [linha(1, "A", 1, F1), linha(2, "B", 1, F2)]);
  ok("vários fornecedores sem filtro: «varios-fornecedores»; com filtro: o nome do fornecedor", nomeFicheiroExcelEncomenda(varios).includes("varios-fornecedores") && nomeFicheiroExcelEncomenda(varios, "f2").includes("ocp-portugal"));
  ok("caracteres perigosos não passam para o nome do ficheiro", !/[\\/:*?"<>|\s]/.test(nomeFicheiroExcelEncomenda(detalhe({ farmaciaNome: "Farm/ácia: <X>\"" , numero: "A/B\\C" }, [linha(1, "A", 1, F1)]))));
}

console.log(`\n${fail === 0 ? "PASSOU" : "FALHOU"} — ${pass} OK, ${fail} falhas\n`);
process.exit(fail === 0 ? 0 : 1);
