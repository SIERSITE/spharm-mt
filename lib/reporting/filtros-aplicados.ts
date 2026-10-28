/**
 * lib/reporting/filtros-aplicados.ts
 *
 * Filtros EM EDIÇÃO (draft) vs filtros APLICADOS (os do relatório visível) — utilitários puros e partilhados
 * pelos mapas que só geram no botão «Gerar/Atualizar» (Margens, Inventário; o Vendas tem o seu estado próprio).
 *
 * Princípio: alterar um filtro NUNCA dispara uma consulta. O formulário muda; o relatório visível, as contagens,
 * os totais e TODAS as saídas (PDF, impressão, Excel, email) continuam a reportar os filtros APLICADOS — os
 * que o servidor usou para calcular as linhas que estão no ecrã. Só «Atualizar» aplica o draft, de uma vez.
 */
import { DEFAULT_INCLUIR_CREDITO, DEFAULT_INCLUIR_TRANSFERENCIAS } from "./natureza-venda";
import type { SharedReportFilters } from "./filters-shared";

/**
 * Forma canónica de um conjunto de filtros, para comparar «o que está no formulário» com «o que gerou o relatório».
 * Duas formas que o servidor trata da mesma maneira têm de comparar IGUAIS — senão escrever e apagar texto (ou
 * abrir e fechar um toggle) deixava «alterações por aplicar» sem nada para aplicar:
 *   · texto: aparado; vazio = ausente;
 *   · listas: ordem irrelevante; vazia = ausente — EXCETO `cnps`, onde `[]` (lista importada sem nenhum código
 *     válido ⇒ NENHUM produto) é diferente de `undefined` (sem lista) — ver `SharedReportFilters.cnps`;
 *   · booleanos: `false`/omitido iguais nos que nascem desligados; crédito/transferências comparam com o seu default.
 */
export function normalizarFiltros(f: SharedReportFilters): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lista = (k: "farmaciaNomes" | "categorias" | "subcategorias" | "utilizacoes" | "fabricantes" | "distribuidores") => {
    const v = f[k];
    if (v && v.length > 0) out[k] = [...v].sort();
  };
  lista("farmaciaNomes");
  lista("categorias");
  lista("subcategorias");
  lista("utilizacoes");
  lista("fabricantes");
  lista("distribuidores");
  if (f.cnps !== undefined) out.cnps = [...f.cnps].sort((a, b) => a - b);
  const pesquisa = f.pesquisa?.trim();
  if (pesquisa) out.pesquisa = pesquisa;
  if (f.from) out.from = f.from;
  if (f.to) out.to = f.to;
  if ((f.incluirCredito ?? DEFAULT_INCLUIR_CREDITO) !== DEFAULT_INCLUIR_CREDITO) out.incluirCredito = f.incluirCredito;
  if ((f.incluirTransferencias ?? DEFAULT_INCLUIR_TRANSFERENCIAS) !== DEFAULT_INCLUIR_TRANSFERENCIAS) out.incluirTransferencias = f.incluirTransferencias;
  if (f.apenasSemClassif) out.apenasSemClassif = true;
  if (f.apenasComStock) out.apenasComStock = true;
  if (f.incluirManutencao) out.incluirManutencao = true;
  // Chaves futuras de `SharedReportFilters` que ainda não tenham regra acima: comparam-se tal e qual (nunca ignoradas).
  const conhecidas = new Set([
    "farmaciaNomes", "categorias", "subcategorias", "utilizacoes", "fabricantes", "distribuidores", "cnps", "pesquisa",
    "from", "to", "incluirCredito", "incluirTransferencias", "apenasSemClassif", "apenasComStock", "incluirManutencao",
  ]);
  for (const [k, v] of Object.entries(f)) {
    if (!conhecidas.has(k) && v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0)) out[k] = v;
  }
  return out;
}

function serializar(o: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
}

/** `true` quando o formulário (draft) tem alterações que o relatório visível (aplicados) ainda não reflete. */
export function filtrosDiferem(draft: SharedReportFilters, aplicados: SharedReportFilters): boolean {
  return serializar(normalizarFiltros(draft)) !== serializar(normalizarFiltros(aplicados));
}

// ── Gerações em curso (uma por separador) ───────────────────────────────────────────────────────────────────────────

/**
 * Sequência de geração POR SEPARADOR. Cada pedido recebe um número; só a resposta do pedido mais RECENTE pode
 * substituir o resultado (uma resposta antiga, chegada fora de ordem, é descartada). Vive no módulo (não no
 * componente) para sobreviver a desmontar/montar a página ao trocar de separador com um pedido em curso.
 */
const sequencias = new Map<string, number>();

export function iniciarGeracao(separador: string): number {
  const n = (sequencias.get(separador) ?? 0) + 1;
  sequencias.set(separador, n);
  return n;
}

/** `true` se `n` ainda é o pedido mais recente deste separador. */
export function geracaoAtual(separador: string, n: number): boolean {
  return sequencias.get(separador) === n;
}
