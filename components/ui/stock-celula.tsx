/**
 * components/ui/stock-celula.tsx
 *
 * Célula de STOCK ATUAL partilhada pelos mapas de ecrã (Vendas, Margens): positivo = número simples; zero =
 * número em CAIXA; negativo = branco sobre escuro. Lê-se a preto e branco (a cor só reforça) — igual ao PDF/impressão
 * (`stockIndicator` em lib/reporting/report-html.ts).
 *
 * `valor === null` = stock DESCONHECIDO: «—», nunca 0 (um zero seria lido como ruptura). O Vendas trata o
 * desconhecido fora deste componente; Margens passa `null` diretamente.
 */
export function StockCelula({ valor }: { valor: number | null }) {
  if (valor === null) {
    return <span className="text-slate-400" data-stock="desconhecido" title="Stock desconhecido (sem ficha de stock desta farmácia)">—</span>;
  }
  if (valor < 0) {
    return <span className="inline-block min-w-[1.6em] rounded bg-slate-900 px-1 text-center font-bold tabular-nums text-white" data-stock="negativo" title="Stock negativo">{valor}</span>;
  }
  if (valor === 0) {
    return <span className="inline-block min-w-[1.6em] rounded border border-slate-900 bg-rose-50 px-1 text-center font-bold tabular-nums text-rose-800" data-stock="zero" title="Sem stock">0</span>;
  }
  return <span className="font-semibold tabular-nums text-emerald-800" data-stock="positivo">{valor}</span>;
}
