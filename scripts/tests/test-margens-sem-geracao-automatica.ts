/**
 * scripts/tests/test-margens-sem-geracao-automatica.ts
 *
 * Margens (e Inventário) NÃO geram ao alterar filtros: filtros em edição (draft) ≠ filtros aplicados (os do relatório
 * visível). Só «Gerar/Atualizar» consulta o servidor; as saídas (PDF, impressão, Excel, email) usam SEMPRE os aplicados.
 *
 * Duas partes:
 *   · comportamento — `lib/reporting/filtros-aplicados.ts` (comparação draft/aplicado, sequência de gerações);
 *   · estrutural — o cliente: nenhum `useEffect` chama `runMargensReport`; `handleGerar` é o único chamador; as saídas
 *     lêem `filtrosResultado`. A prova de browser (0 pedidos ao escrever/limpar/trocar de separador, exatamente 1 ao
 *     «Atualizar», resposta fora de ordem) está em scripts/e2e/margens-sem-geracao-automatica-browser.ts.
 *
 * Puro. Corre com: npx tsx scripts/tests/test-margens-sem-geracao-automatica.ts
 */
import { readFileSync } from "node:fs";
import { filtrosDiferem, geracaoAtual, iniciarGeracao, normalizarFiltros } from "../../lib/reporting/filtros-aplicados";

const lerLF = (p: string) => readFileSync(p, "utf8").split("\r\n").join("\n");
let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${label}`); }
  else { ko++; console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`); }
};
const secao = (t: string) => console.log(`\n── ${t}`);

/** O corpo (entre chavetas balanceadas) que começa em `inicio`. */
function corpo(src: string, inicio: string): string {
  const i = src.indexOf(inicio);
  if (i < 0) return "";
  const a = src.indexOf("{", src.indexOf(")", i) >= 0 ? i + inicio.length - 1 : i);
  let nivel = 0;
  for (let j = a; j < src.length; j++) {
    if (src[j] === "{") nivel++;
    else if (src[j] === "}" && --nivel === 0) return src.slice(a, j + 1);
  }
  return "";
}

/** Os corpos de todas as chamadas `useEffect(() => {...}, [deps])`. */
function efeitos(src: string): string[] {
  const out: string[] = [];
  let i = 0;
  while ((i = src.indexOf("useEffect(", i)) >= 0) {
    const a = src.indexOf("{", i);
    let nivel = 0;
    let j = a;
    for (; j < src.length; j++) {
      if (src[j] === "{") nivel++;
      else if (src[j] === "}" && --nivel === 0) break;
    }
    out.push(src.slice(a, j + 1));
    i = j;
  }
  return out;
}

// ══ A · comparação draft vs aplicado ═════════════════════════════════
secao("A · filtrosDiferem");
{
  const base = { farmaciaNomes: ["A", "B"], from: "2026-01-01", to: "2026-06-30" };
  check(!filtrosDiferem(base, { ...base }), "A1: iguais ⇒ sem alterações por aplicar");
  check(filtrosDiferem({ ...base, pesquisa: "ibuprofeno" }, base), "A2: escrever na pesquisa ⇒ alterações por aplicar");
  check(!filtrosDiferem({ ...base, pesquisa: "  " }, base), "A3: pesquisa só com espaços = sem pesquisa");
  check(!filtrosDiferem({ ...base, pesquisa: "" }, { ...base, pesquisa: undefined }), "A4: escrever e apagar o texto volta a «sem alterações»");
  check(filtrosDiferem({ ...base, fabricantes: ["X"] }, base), "A5: selecionar fabricante ⇒ alterações");
  check(!filtrosDiferem({ ...base, fabricantes: [] }, base), "A6: remover o fabricante (lista vazia) = sem fabricante");
  check(!filtrosDiferem({ ...base, farmaciaNomes: ["B", "A"] }, base), "A7: a ORDEM das listas não conta");
  check(filtrosDiferem({ ...base, cnps: [] }, base), "A8: lista importada vazia (NENHUM produto) ≠ sem lista");
  check(filtrosDiferem({ ...base, cnps: [1, 2] }, { ...base, cnps: [1] }), "A9: lista de CNP diferente");
  check(!filtrosDiferem({ ...base, cnps: [2, 1] }, { ...base, cnps: [1, 2] }), "A10: lista de CNP — ordem irrelevante");
  check(filtrosDiferem({ ...base, to: "2026-07-31" }, base), "A11: mudar a data ⇒ alterações");
  check(!filtrosDiferem({ ...base, incluirCredito: true, incluirTransferencias: false }, base), "A12: defaults explícitos = omitidos (crédito sim / transferências não)");
  check(filtrosDiferem({ ...base, incluirTransferencias: true }, base), "A13: ligar transferências ⇒ alterações");
  check(filtrosDiferem({ ...base, subcategorias: ["S"] }, base) && filtrosDiferem({ ...base, utilizacoes: ["tosse"] }, base), "A14: subcategorias e utilizações contam");
  // Um campo futuro (ex.: forma farmacêutica) ainda sem regra própria nunca é ignorado.
  check(filtrosDiferem({ ...base, formaFarmaceutica: ["Comprimido"] } as never, base), "A15: campo novo sem regra própria (ex.: forma farmacêutica) conta na comparação");
  check(!("formaFarmaceutica" in normalizarFiltros({ ...base, formaFarmaceutica: [] } as never)), "A16: campo novo vazio não conta");
}

// ══ B · sequência de gerações ════════════════════════════════════════
secao("B · resposta fora de ordem");
{
  const a = iniciarGeracao("sep-1");
  const b = iniciarGeracao("sep-1");
  check(!geracaoAtual("sep-1", a), "B1: a geração antiga deixa de ser a atual quando começa outra");
  check(geracaoAtual("sep-1", b), "B2: a mais recente é a atual (só ela pode substituir o resultado)");
  const c = iniciarGeracao("sep-2");
  check(geracaoAtual("sep-2", c) && geracaoAtual("sep-1", b), "B3: separadores independentes (duas análises não se pisam)");
}

// ══ C · estrutura do cliente de Margens ══════════════════════════════
secao("C · margens-client.tsx");
{
  const src = lerLF("components/margens/margens-client.tsx");
  const chamadas = (src.match(/runMargensReport\(/g) ?? []).length;
  check(chamadas === 1, `C1: runMargensReport é chamado em UM só sítio (${chamadas})`);
  const handle = corpo(src, "const handleGerar = () =>");
  check(handle.includes("await runMargensReport(aplicar)"), "C2: esse sítio é handleGerar");
  const ef = efeitos(src);
  check(ef.length > 0 && ef.every((e) => !e.includes("runMargensReport") && !e.includes("handleGerar")), `C3: nenhum useEffect (${ef.length}) chama runMargensReport/handleGerar`);
  check(!/setTimeout|setInterval|debounce/i.test(src.replace(/\/\/.*$/gm, "")), "C4: sem timers/debounce que gerem por alteração de filtros");
  check(!src.includes("filtrosSerial") || !/JSON\.parse\(filtrosSerial\)\s*\)\s*;?\s*\n\s*setFiltros/.test(src), "C5: sem chave de dependência por JSON.stringify(filters) a relançar");
  const usos = (src.replace(/\/\/.*$/gm, "").match(/\bhandleGerar\b/g) ?? []).length;
  check(usos === 2 && src.includes("onClick={handleGerar}"), `C6: handleGerar só é definido e ligado ao botão (${usos} referências)`);
  check(!/onKeyDown|onKeyUp|onSubmit|<form/.test(src), "C7: Enter num campo não gera (mesmo padrão do Vendas: só o botão)");
  check(/hasGenerated \? "Atualizar" : "Gerar"/.test(src), "C8: botão «Gerar» antes da 1.ª geração, «Atualizar» depois");
  check(/disabled=\{isPending\}/.test(src) && handle.includes("if (isPending || emCursoRef.current) return;"), "C9: pedido em curso — botão desativado e duplo clique ignorado");
  check(handle.includes("iniciarGeracao(idSeparador)") && (handle.match(/geracaoAtual\(idSeparador, minha\)/g) ?? []).length === 2, "C10: resposta (e erro) antigos descartados pela sequência");
  check(handle.includes("const aplicar = filters;") && handle.includes("setFiltrosResultado(aplicar)"), "C11: o instantâneo do draft enviado é o que passa a «aplicado» (nenhum filtro perdido)");
  check(/data-testid="margens-alteracoes-por-aplicar"/.test(src) && /aria-live="polite"/.test(src) && /hasGenerated && filtrosDiferem\(filters, filtrosResultado\)/.test(src), "C12: indicação acessível «Existem alterações por aplicar» só com draft ≠ aplicado");
  check(/useEstadoSeparador<SharedReportFilters>\("margens:filtrosResultado"/.test(src) && /useWorkspaceState<MargensCriterios>/.test(src), "C13: draft em useWorkspaceState (sessionStorage); aplicados+resultado em useEstadoSeparador (mesma vida)");

  const build = corpo(src, "const buildReport = () =>");
  check(build.length > 100 && !/\bfilters\b(?!:\s*filtrosResultado)/.test(build.replace(/filters: filtrosResultado/g, "")), "C14: buildReport (PDF/impressão/Excel/email) NÃO lê o draft `filters`");
  check((build.match(/filters: filtrosResultado/g) ?? []).length === 2, "C15: os dois adapters (produto e agregado) recebem os filtros APLICADOS");
  check(/formatFarmaciaHeader\(filtrosResultado\.farmaciaNomes/.test(src), "C16: o cabeçalho da organização vem das farmácias APLICADAS");
  check(/subcategorias: universe\.subcategorias/.test(src) && /utilizacoes: universe\.utilizacoes/.test(src), "C17: o universo do relatório traz subcategorias/utilizações para o rótulo de filtros");
  // Limpar filtros: só o draft (ReportFiltersBar altera `value` via onChange e nunca consulta).
  const barra = lerLF("components/reporting/report-filters-bar.tsx");
  check(!/run[A-Z]\w*Report|"use server"|fetch\(/.test(barra), "C18: a barra de filtros (Limpar incluído) não faz nenhuma consulta — só altera o draft");
  check(/onChange=\{setFilters\}/.test(src), "C19: a barra altera o DRAFT (setFilters)");
}

// ══ D · Inventário (mesma barra, Gerar manual) ═══════════════════════
secao("D · inventario-client.tsx");
{
  const src = lerLF("components/inventario/inventario-client.tsx");
  const chamadas = (src.match(/runInventarioReport\(/g) ?? []).length;
  check(chamadas === 1, `D1: runInventarioReport é chamado em UM só sítio (${chamadas})`);
  const ef = efeitos(src);
  check(ef.every((e) => !e.includes("runInventarioReport") && !e.includes("handleGerar")), `D2: nenhum useEffect (${ef.length}) gera o relatório`);
  const build = corpo(src, "const buildReport = () =>");
  check(!/\bfilters,\n/.test(build) && (build.match(/filters: filtrosResultado/g) ?? []).length >= 5, "D3: as saídas do Inventário usam os filtros APLICADOS");
  check(/hasGenerated \? "Atualizar" : "Gerar"/.test(src) && /inventario-alteracoes-por-aplicar/.test(src), "D4: «Atualizar» e indicação de alterações por aplicar");
}

console.log(`\n${ok} ok, ${ko} falhas`);
process.exit(ko > 0 ? 1 : 0);
