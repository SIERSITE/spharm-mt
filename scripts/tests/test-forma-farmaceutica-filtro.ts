/**
 * scripts/tests/test-forma-farmaceutica-filtro.ts
 *
 * Unitário (sem BD, sem rede) do módulo ÚNICO do filtro de forma farmacêutica
 * (lib/catalog/forma-farmaceutica-filtro.ts): chave, agrupamento, NÃO agrupar formas compostas, rótulo, ordem,
 * sentinela, leitura de estados antigos, contadores/limpeza/comparação draft≠aplicado e linhas dos relatórios.
 *
 * Uso: npx tsx scripts/tests/test-forma-farmaceutica-filtro.ts
 */
import {
  ROTULO_SEM_FORMA,
  SEM_FORMA,
  chaveFormaFarmaceutica,
  filtroFormaFarmaceuticaLinha,
  lerChavesForma,
  normalizarTextoForma,
  opcoesFormaFarmaceutica,
  passaFiltroForma,
  rotuloDaChaveForma,
  rotuloSentenceCase,
} from "../../lib/catalog/forma-farmaceutica-filtro";
import { contarFiltrosAtivos, limparFiltrosPreservandoData } from "../../lib/reporting/filters-shared";
import { filtrosDiferem } from "../../lib/reporting/filtros-aplicados";
import { temFiltroCatalogo } from "../../lib/reporting/catalog-prefilter";
import { parsearPropostaContexto } from "../../lib/encomendas/proposal-context";
import * as XLSX from "xlsx";
import { buildVendasReport } from "../../lib/reporting/adapters/vendas";
import { buildMargensProdutoReport } from "../../lib/reporting/adapters/margens";
import { buildInventarioReport } from "../../lib/reporting/adapters/inventario";
import { buildExcessosReport } from "../../lib/reporting/adapters/excessos";
import { buildTransferenciasReport } from "../../lib/reporting/adapters/transferencias";
import { renderReportHtml } from "../../lib/reporting/report-html";
import { buildReportWorkbook } from "../../lib/reporting/report-excel-buffer";

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${label}`); }
  else { ko++; console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`); }
};
const eq = (a: unknown, b: unknown, label: string) =>
  check(JSON.stringify(a) === JSON.stringify(b), label, `obtido ${JSON.stringify(a)} · esperado ${JSON.stringify(b)}`);

console.log("A · chave");
eq(chaveFormaFarmaceutica("Comprimido"), "comprimido", "Title case -> minúsculas");
eq(chaveFormaFarmaceutica(" COMPRIMIDO "), "comprimido", "espaços nas pontas + maiúsculas");
eq(chaveFormaFarmaceutica("comprimido"), "comprimido", "já minúsculas");
eq(chaveFormaFarmaceutica("Comprimido   revestido\tpor  película"), "comprimido revestido por pelicula", "colapsa espaços internos/tabs e tira acentos");
eq(chaveFormaFarmaceutica("Cápsula"), "capsula", "acento agudo");
eq(chaveFormaFarmaceutica("CÁPSULAS DURAS"), "capsulas duras", "maiúsculas acentuadas");
eq(chaveFormaFarmaceutica("Solução injetável"), "solucao injetavel", "cedilha e til");
eq(chaveFormaFarmaceutica("Comprimido de libertação prolongada"), "comprimido de libertacao prolongada", "composta mantém as palavras");
eq(chaveFormaFarmaceutica(null), SEM_FORMA, "null -> sentinela");
eq(chaveFormaFarmaceutica(undefined), SEM_FORMA, "undefined -> sentinela");
eq(chaveFormaFarmaceutica(""), SEM_FORMA, "vazio -> sentinela");
eq(chaveFormaFarmaceutica("   \t "), SEM_FORMA, "só espaços -> sentinela");
eq(normalizarTextoForma(null), "", "normalizarTextoForma(null) = ''");
check(chaveFormaFarmaceutica(chaveFormaFarmaceutica("Cápsula Dura")) === chaveFormaFarmaceutica("Cápsula Dura"), "idempotente");
check(chaveFormaFarmaceutica("__sem_forma__") === SEM_FORMA, "a própria sentinela é estável");

console.log("B · não agrupa formas diferentes (sem fuzzy)");
const compostas = ["Comprimido", "Comprimido revestido", "Comprimido revestido por película", "Comprimido de libertação prolongada", "Cápsula", "Cápsula mole"];
check(new Set(compostas.map(chaveFormaFarmaceutica)).size === compostas.length, "6 formas distintas -> 6 chaves distintas");
check(chaveFormaFarmaceutica("Comprimido") !== chaveFormaFarmaceutica("Comprimidos"), "singular != plural (sem stemming)");
check(chaveFormaFarmaceutica("Comp.") !== chaveFormaFarmaceutica("Comprimido"), "abreviatura não é expandida");
check(chaveFormaFarmaceutica("Comprimido, oral") !== chaveFormaFarmaceutica("Comprimido oral"), "vírgula conta (não é sinónimo)");

console.log("C · opções: agrupamento, rótulo, contagem, ordem");
const ops = opcoesFormaFarmaceutica([
  { valor: " COMPRIMIDO ", count: 3 },
  { valor: "comprimido", count: 10 },
  { valor: "Comprimido", count: 7 },
  { valor: "Comprimido revestido", count: 4 },
  { valor: "Comprimido de libertação prolongada", count: 2 },
  { valor: "Cápsula", count: 5 },
  { valor: "capsula", count: 5 },
  { valor: null, count: 6 },
  { valor: "   ", count: 1 },
  { valor: "Zero", count: 0 },
  { valor: "Ácido", count: 1 },
]);
eq(ops.map((o) => o.label), ["Ácido", "Cápsula", "Comprimido", "Comprimido de libertação prolongada", "Comprimido revestido", ROTULO_SEM_FORMA], "ordem alfabética pt sem acentos; sem forma no fim; contagem 0 omitida");
const comp = ops.find((o) => o.chave === "comprimido")!;
eq(comp, { chave: "comprimido", label: "Comprimido", count: 20 }, "3 variantes numa opção; rótulo = variante mais frequente em sentence-case; contagem somada");
eq(ops.find((o) => o.chave === "capsula")?.label, "Cápsula", "empate de frequência -> variante acentuada");
eq(ops.find((o) => o.chave === SEM_FORMA), { chave: SEM_FORMA, label: ROTULO_SEM_FORMA, count: 7 }, "sem forma: null + vazios somados");
check(ops.filter((o) => o.chave.startsWith("comprimido")).length === 3, "Comprimido / revestido / libertação prolongada = 3 opções");
eq(opcoesFormaFarmaceutica([]), [], "sem dados -> sem opções");
eq(opcoesFormaFarmaceutica([{ valor: "x", count: 2 }]).some((o) => o.chave === SEM_FORMA), false, "sem produtos sem forma -> sem opção sentinela");
eq(rotuloSentenceCase("  COMPRIMIDO   REVESTIDO "), "Comprimido revestido", "sentence-case com espaços limpos");
// determinismo: a ordem de entrada não muda o resultado
const emb = [...ops].reverse();
eq(opcoesFormaFarmaceutica([{ valor: "b", count: 1 }, { valor: "a", count: 1 }]), opcoesFormaFarmaceutica([{ valor: "a", count: 1 }, { valor: "b", count: 1 }]), "resultado independente da ordem de entrada");
void emb;
// pt: "Ácido" ordena com "A", não depois do "Z"
check(ops[0].label === "Ácido", "acento não manda a opção para o fim");

console.log("D · rótulos de chaves e linha dos relatórios");
eq(rotuloDaChaveForma("comprimido", ops), "Comprimido", "rótulo a partir das opções");
eq(rotuloDaChaveForma(SEM_FORMA, ops), ROTULO_SEM_FORMA, "rótulo da sentinela");
eq(rotuloDaChaveForma("pomada", ops), "Pomada", "chave desconhecida -> reconstrução legível");
eq(filtroFormaFarmaceuticaLinha(["comprimido", SEM_FORMA], ops), { label: "Forma farmacêutica", value: `Comprimido, ${ROTULO_SEM_FORMA}` }, "linha «Forma farmacêutica: A, B» com rótulos e «Sem forma»");
eq(filtroFormaFarmaceuticaLinha([], ops), null, "sem selecção -> sem linha");
eq(filtroFormaFarmaceuticaLinha(undefined, ops), null, "undefined -> sem linha");

console.log("E · leitura de estados antigos / não fiáveis");
eq(lerChavesForma(undefined), [], "undefined -> []");
eq(lerChavesForma(null), [], "null -> []");
eq(lerChavesForma(42), [], "número -> []");
eq(lerChavesForma(["Comprimido", "comprimido", "", "  "]), ["comprimido"], "re-normaliza, deduplica e remove vazios");
eq(lerChavesForma(["__sem_forma__"]), [SEM_FORMA], "sentinela preservada");
eq(lerChavesForma("comprimido, oral"), ["comprimido, oral"], "string única NÃO se separa por vírgulas");
eq(lerChavesForma([1, null, "x"]), ["x"], "elementos não-string ignorados");
check(lerChavesForma(Array.from({ length: 500 }, (_, i) => `forma ${i}`)).length <= 60, "limite de chaves (URL forjada)");
eq(parsearPropostaContexto(JSON.stringify({ version: 1, mode: "farmacia", farmaciaId: "f", startDate: "2026-01-01", endDate: "2026-01-31", considerStock: true, baseRule: "coverage", coverageDays: 15, filters: { fabricantes: [], fornecedores: [], categorias: [], subcategorias: [], utilizacoes: [], productTypes: [] }, listaImportadaResumo: null, nome: "x" }))?.filters.formas, [], "rascunho v1 SEM o campo -> formas []");
eq(parsearPropostaContexto(JSON.stringify({ version: 1, mode: "farmacia", farmaciaId: "f", startDate: "2026-01-01", endDate: "2026-01-31", considerStock: true, baseRule: "coverage", coverageDays: 15, filters: { formas: ["Comprimido", "x"] }, listaImportadaResumo: null, nome: "x" }))?.filters.formas, ["comprimido", "x"], "rascunho com formas -> lidas e normalizadas");

console.log("F · passaFiltroForma (refinamento sobre a linha)");
check(passaFiltroForma("Comprimido", []) && passaFiltroForma(null, undefined), "sem selecção passa tudo");
check(passaFiltroForma(" COMPRIMIDO ", ["comprimido"]), "valor cru normaliza para a chave");
check(!passaFiltroForma("Comprimido revestido", ["comprimido"]), "Comprimido não apanha Comprimido revestido");
check(passaFiltroForma(null, [SEM_FORMA]) && passaFiltroForma("  ", [SEM_FORMA]), "sem forma apanha nulos e vazios");
check(!passaFiltroForma("Cápsula", [SEM_FORMA]), "sentinela não apanha produtos com forma");
check(passaFiltroForma("chave já normalizada: comprimido", ["chave ja normalizada: comprimido"]) && passaFiltroForma("comprimido", ["comprimido"]), "chave de linha (já normalizada) também passa");

console.log("G · SharedReportFilters: contagem, limpar, draft≠aplicado, pré-filtro");
check(contarFiltrosAtivos({}) === 0, "sem filtros = 0");
check(contarFiltrosAtivos({ formasFarmaceuticas: ["comprimido", "capsula"] }) === 1, "formas contam 1 EIXO (não 2)");
check(contarFiltrosAtivos({ formasFarmaceuticas: [] }) === 0, "[] não conta");
check(contarFiltrosAtivos({ fabricantes: ["x"], formasFarmaceuticas: ["comprimido"] }) === 2, "soma com os restantes eixos");
const limpo = limparFiltrosPreservandoData({ from: "2026-01-01", to: "2026-02-01", formasFarmaceuticas: ["comprimido"], pesquisa: "x" });
eq(limpo.formasFarmaceuticas, [], "«Limpar filtros» repõe as formas");
check(limpo.from === "2026-01-01" && limpo.to === "2026-02-01", "…e mantém o período");
check(!filtrosDiferem({ formasFarmaceuticas: [] }, {}), "[] vs ausente = iguais (estado antigo)");
check(!filtrosDiferem({ formasFarmaceuticas: undefined }, { formasFarmaceuticas: [] }), "undefined vs [] = iguais");
check(filtrosDiferem({ formasFarmaceuticas: ["comprimido"] }, {}), "escolher uma forma = alterações por aplicar");
check(!filtrosDiferem({ formasFarmaceuticas: ["a", "b"] }, { formasFarmaceuticas: ["b", "a"] }), "ordem da selecção é irrelevante");
check(filtrosDiferem({ formasFarmaceuticas: ["a"] }, { formasFarmaceuticas: ["b"] }), "outra forma = diferem");
check(temFiltroCatalogo({ formasFarmaceuticas: ["comprimido"] }) && !temFiltroCatalogo({ formasFarmaceuticas: [] }) && !temFiltroCatalogo({}), "temFiltroCatalogo considera o eixo novo (vazio = sem restrição)");

console.log("H · relatórios (adapters, HTML e Excel) — rótulos, nunca chaves");
const uni = { farmacias: ["F1", "F2"], fornecedores: [], fabricantes: [], categorias: [], distribuidores: [], prioridades: [], formas: ops };
const sel = ["comprimido", SEM_FORMA];
const linhaForma = (r: { filtersApplied?: Array<{ label: string; value: string }> }) => r.filtersApplied?.find((f) => f.label === "Forma farmacêutica")?.value;
const ESPERADO = `Comprimido, ${ROTULO_SEM_FORMA}`;
const rVendas = buildVendasReport({ rows: [], buckets: [{ ano: 2026, mes: 1 }], filters: { formasSelecionadas: sel }, universe: uni, organization: "Org" } as never);
const rMarg = buildMargensProdutoReport({ rows: [], filters: { formasFarmaceuticas: sel }, universe: uni, organization: "Org" } as never);
const rInv = buildInventarioReport({ rows: [], filters: { formasFarmaceuticas: sel }, universe: uni, organization: "Org" } as never);
const rExc = buildExcessosReport({ rows: [], filters: { formasSelecionadas: sel }, universe: uni, organization: "Org" } as never);
const rTrf = buildTransferenciasReport({ rows: [], filters: { formasSelecionadas: sel }, universe: uni, organization: "Org" } as never);
eq(linhaForma(rVendas), ESPERADO, "Vendas: «Forma farmacêutica: Comprimido, Sem forma farmacêutica»");
eq(linhaForma(rMarg), ESPERADO, "Margens: linha com rótulos");
eq(linhaForma(rInv), ESPERADO, "Inventário: linha com rótulos");
eq(linhaForma(rExc), ESPERADO, "Excessos: linha com rótulos");
eq(linhaForma(rTrf), ESPERADO, "Transferências: linha com rótulos");
const semSelRel = buildMargensProdutoReport({ rows: [], filters: { formasFarmaceuticas: [] }, universe: uni, organization: "Org" } as never);
check(linhaForma(semSelRel) === undefined, "sem selecção não aparece a linha (relatórios anteriores inalterados)");
const html = renderReportHtml(rMarg);
check(html.includes("Forma farmacêutica") && html.includes(ESPERADO), "HTML (impressão/PDF/email) mostra a linha");
const wb = buildReportWorkbook(rMarg);
const textoExcel = wb.SheetNames.map((n) => JSON.stringify(XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, blankrows: false }))).join("\n");
check(textoExcel.includes("Forma farmacêutica") && textoExcel.includes(ESPERADO), "Excel mostra «Forma farmacêutica: Comprimido, Sem forma farmacêutica»");
check(!html.includes("__sem_forma__") && !textoExcel.includes("__sem_forma__"), "a chave interna (sentinela) nunca chega ao relatório");

console.log(`\n${ok} OK, ${ko} FALHA`);
process.exit(ko > 0 ? 1 : 0);
