/**
 * lib/vendas-manutencao/valorizacao.ts
 *
 * O valor bruto de uma célula de manutenção é SEMPRE
 * `quantidade × pvpReferencia` — nunca guardado, sempre recalculado a
 * partir dos dois números imutáveis (ver a nota grande em
 * `VendaManutencaoFarmacia` no schema.prisma sobre porquê nunca
 * duplicar isto). Reutiliza `valorizar()`, o MESMO helper que todo o
 * resto do SPharm.MT já usa para "quantidade × preço unitário,
 * arredondado a cêntimos" (custo estimado de Vendas/Margens/Inventário)
 * — nunca uma segunda fórmula de arredondamento a divergir da primeira.
 *
 * `pvpReferencia === null` (farmácia sem PVP válido no momento da
 * captura, secção 6 do pedido) propaga para `null` — nunca inventa um
 * valor bruto a partir de um preço que não existe.
 *
 * Puro — sem Prisma, sem `server-only`.
 */
import { valorizar } from "@/lib/produtos/custo-farmacia";

/** `quantidade × pvpReferencia`, arredondado a cêntimos. `null` se o PVP for desconhecido. */
export function calcularValorBrutoCelula(
  quantidade: number,
  pvpReferencia: number | null,
): number | null {
  return valorizar(quantidade, pvpReferencia);
}

/**
 * `true` quando esta farmácia tem quantidade atribuída (em qualquer
 * mês) mas nenhum PVP de referência válido — o estado que a secção 6 do
 * pedido pede para identificar claramente ANTES da confirmação, nunca
 * silenciar com um 0.
 */
export function precisaDePvpReferencia(
  quantidadeTotalDaFarmacia: number,
  pvpReferencia: number | null,
): boolean {
  return quantidadeTotalDaFarmacia > 0 && pvpReferencia === null;
}
