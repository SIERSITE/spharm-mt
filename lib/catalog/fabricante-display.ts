/**
 * lib/catalog/fabricante-display.ts
 *
 * Texto de exibição do fabricante na ficha/tabelas do catálogo — regra 9
 * da reconciliação de fabricantes por CNP (garantia). Puro, sem Prisma:
 * o chamador já resolveu `fabricanteNome` (via `Produto.fabricante.
 * nomeNormalizado`, se associado) e `titularAim` (via `RegulatoryRecord`
 * pelo mesmo cnp, quando não há fabricante associado).
 */
export function formatarFabricanteParaExibicao(dados: {
  fabricanteNome: string | null | undefined;
  titularAim: string | null | undefined;
}): string {
  if (dados.fabricanteNome && dados.fabricanteNome.trim().length > 0) {
    return dados.fabricanteNome;
  }
  if (dados.titularAim && dados.titularAim.trim().length > 0) {
    return `${dados.titularAim} — titular AIM por validar`;
  }
  return "Fabricante não informado pela origem";
}
