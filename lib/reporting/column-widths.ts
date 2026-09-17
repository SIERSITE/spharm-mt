/**
 * lib/reporting/column-widths.ts
 *
 * Normaliza um orçamento de larguras de coluna (% da largura útil da
 * página) para somar exactamente 100 — preserva as proporções relativas
 * "editoriais" já escolhidas por cada adapter, só corrige a soma.
 *
 * Nasceu da auditoria de uniformização (2026-09): vários adapters
 * (Margens Por Produto, Transferências, Excessos, Encomendas) tinham
 * larguras que somavam bem acima de 100% (ex.: Transferências somava
 * 254%). Com `table-layout:fixed` (report-html.ts), isso não encolhe a
 * tabela — as colunas a mais TRANSBORDAM da página impressa, cortadas ou
 * sobrepostas consoante o motor de PDF. `normalizarLargura` garante que
 * isso nunca mais acontece, mesmo que uma largura seja adicionada ou
 * ajustada no futuro sem se voltar a somar tudo à mão.
 *
 * Nunca arredondar cada largura individualmente antes de normalizar — ver
 * nota histórica em `adapters/vendas.ts`: o erro de arredondamento
 * acumula-se entre colunas. A soma final aqui é sempre exactamente 100
 * (dentro da precisão de ponto flutuante).
 */
export function normalizarLargura<K extends string>(
  base: Record<K, number>,
): Record<K, number> {
  const soma = (Object.values(base) as number[]).reduce((s, v) => s + v, 0);
  const escala = soma > 0 ? 100 / soma : 1;
  const out = {} as Record<K, number>;
  for (const k of Object.keys(base) as K[]) out[k] = base[k] * escala;
  return out;
}
