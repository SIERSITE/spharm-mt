/**
 * scripts/tests/test-generico.ts — regra pura do filtro «Genérico» (sem base de dados).
 *   npx tsx scripts/tests/test-generico.ts
 */
import {
  filtroGenericoLinha,
  flagDoFiltroGenerico,
  lerValorGenerico,
  passaFiltroGenerico,
  rotuloChipGenerico,
} from "../../lib/catalog/generico-filtro";
import { contarFiltrosAtivos, limparFiltrosPreservandoData } from "../../lib/reporting/filters-shared";
import { filtrosDiferem, normalizarFiltros } from "../../lib/reporting/filtros-aplicados";
import { temFiltroCatalogo } from "../../lib/reporting/catalog-prefilter";

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${label}`); }
  else { ko++; console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`); }
};
const secao = (t: string) => console.log(`\n── ${t}`);

secao("A · leitura do valor (estado, URL, Server Action)");
check(lerValorGenerico("GENERICO") === "GENERICO" && lerValorGenerico("NAO_GENERICO") === "NAO_GENERICO", "GENERICO e NAO_GENERICO lidos");
check(lerValorGenerico(undefined) === undefined && lerValorGenerico(null) === undefined && lerValorGenerico("") === undefined, "ausente/nulo/vazio = Todos");
check(lerValorGenerico("TODOS") === undefined && lerValorGenerico("genérico") === undefined && lerValorGenerico("x'; DROP TABLE") === undefined && lerValorGenerico(1) === undefined, "qualquer outro valor = Todos (nunca SQL)");
check(lerValorGenerico(["GENERICO", "NAO_GENERICO"]) === "GENERICO", "URL repetida: vale o primeiro");

secao("B · flag e predicado");
check(flagDoFiltroGenerico("GENERICO") === true && flagDoFiltroGenerico("NAO_GENERICO") === false && flagDoFiltroGenerico(undefined) === undefined, "flag: true / false / sem restrição");
check(passaFiltroGenerico(true, "GENERICO") && !passaFiltroGenerico(false, "GENERICO"), "GENERICO deixa passar só flagGenerico=true");
check(passaFiltroGenerico(false, "NAO_GENERICO") && !passaFiltroGenerico(true, "NAO_GENERICO"), "NAO_GENERICO deixa passar só flagGenerico=false");
check(passaFiltroGenerico(null, "NAO_GENERICO") && passaFiltroGenerico(undefined, "NAO_GENERICO") && !passaFiltroGenerico(null, "GENERICO"), "valores nulos/ausentes contam como NÃO genérico (a coluna é NOT NULL; defensivo)");
check(passaFiltroGenerico(true, undefined) && passaFiltroGenerico(false, undefined) && passaFiltroGenerico(null, undefined), "Todos deixa passar tudo");

secao("C · rótulos e linha dos filtros aplicados");
check(rotuloChipGenerico("GENERICO") === "Genérico: Apenas genéricos" && rotuloChipGenerico("NAO_GENERICO") === "Genérico: Apenas não genéricos", "chips");
check(JSON.stringify(filtroGenericoLinha("GENERICO")) === JSON.stringify({ label: "Genérico", value: "Apenas genéricos" }), "linha do PDF/Excel/email: «Genérico: Apenas genéricos»");
check(filtroGenericoLinha(undefined) === null && filtroGenericoLinha("lixo") === null, "Todos não tem linha");

secao("D · integração nos filtros partilhados");
check(contarFiltrosAtivos({ generico: "GENERICO" }) === 1 && contarFiltrosAtivos({}) === 0 && contarFiltrosAtivos({ generico: undefined }) === 0, "conta como 1 eixo só quando ≠ Todos");
check(limparFiltrosPreservandoData({ generico: "NAO_GENERICO", from: "2026-01-01" }).generico === undefined, "«Limpar filtros» repõe Todos");
check(limparFiltrosPreservandoData({ generico: "NAO_GENERICO", from: "2026-01-01" }).from === "2026-01-01", "…e mantém as datas");
check(filtrosDiferem({ generico: "GENERICO" }, {}) && !filtrosDiferem({ generico: undefined }, {}), "draft ≠ aplicado quando o Genérico muda; undefined = ausente");
check(normalizarFiltros({ generico: "GENERICO" }).generico === "GENERICO" && !("generico" in normalizarFiltros({})), "normalização estável");
check(temFiltroCatalogo({ generico: "GENERICO" }) && temFiltroCatalogo({ generico: "NAO_GENERICO" }) && !temFiltroCatalogo({}), "o pré-filtro de catálogo só corre com GENERICO/NAO_GENERICO");

console.log(`\n${ok} OK, ${ko} FALHA(S)`);
process.exit(ko === 0 ? 0 : 1);
