/**
 * lib/workspace/pendentes.ts
 *
 * Declarações de «alterações por confirmar» de um separador, por FONTE. Um separador pode ter vários editores (ex.: a ficha do
 * artigo tem o editor do fabricante E o da designação): cada um declara a sua fonte e o separador está «sujo» se QUALQUER fonte
 * tiver alterações por confirmar. Sem isto, os editores sobrepunham-se (o último a declarar `false` apagava o `true` do outro) e
 * fechar o separador a meio de uma edição não pedia confirmação.
 *
 * O registo vive no armazém em memória do próprio separador (`armazem-separadores.ts`): sobrevive a mudar de separador (a
 * página regressa e redeclara a sua fonte), e é libertado com o resto do estado do separador ao fechá-lo.
 */
import { estadoSeparadores } from "@/lib/workspace/armazem-separadores";

export const CHAVE_PENDENTES = "__pendentes";
export const FONTE_PAGINA = "pagina";

/** Regista a declaração desta fonte e devolve se o separador tem alterações por confirmar (qualquer fonte). Puro sobre o armazém. */
export function declararPendente(escopo: string, separador: string, fonte: string, pendentes: boolean): boolean {
  const atuais = estadoSeparadores.ler<Record<string, boolean>>(escopo, separador, CHAVE_PENDENTES) ?? {};
  const novas = { ...atuais, [fonte]: pendentes };
  estadoSeparadores.escrever(escopo, separador, CHAVE_PENDENTES, novas);
  return Object.values(novas).some(Boolean);
}
