/**
 * lib/catalog/classificacao-coerencia.ts
 *
 * Duas perguntas pequenas sobre uma classificação proposta, com uma só
 * definição cada.
 *
 *   · é um balde? ("Outros Medicamentos" não é uma classificação, é o
 *     sítio onde se põe o que não se classificou)
 *   · contradiz FORTEMENTE o productType já decidido?
 *
 * Vive em `lib/` e não no diagnóstico que o inventou por uma razão
 * concreta: o diagnóstico simulou uma política e produziu um número
 * (2 195 recuperáveis) sobre o qual se decidiu escrever em produção. Se a
 * simulação e a escrita tivessem cópias diferentes desta regra, o número
 * medido e o número obtido divergiriam no dia em que alguém corrigisse
 * uma e não a outra — e a divergência só apareceria depois de escrever.
 *
 * Módulo PURO: sem Prisma, sem rede. O diagnóstico importa-o daqui.
 */

/**
 * O nível 1 que cada `productType` implica, quando implica algum.
 *
 * Só os quatro tipos com consequência REGULAMENTAR estão aqui. Não é uma
 * omissão dos outros — é o critério: `DERMOCOSMETICA`, `HIGIENE_CUIDADO`,
 * `PUERICULTURA` e `ORTOPEDIA` descrevem o corredor da loja, e o corredor
 * é discutível. Um creme de bebé pode estar em "Mãe e bebé" ou em
 * "Dermocosmética" consoante a arrumação, e chamar erro a essa escolha
 * seria transformar uma questão de organização numa recusa de escrita.
 *
 * Já um suplemento alimentar em "MEDICAMENTOS" não é arrumação: é uma
 * troca de estatuto regulamentar, e essa não se aceita por dedução.
 */
export const FAMILIA_DE_TIPO: Readonly<Record<string, string>> = Object.freeze({
  MEDICAMENTO: "MEDICAMENTOS",
  SUPLEMENTO: "SUPLEMENTOS ALIMENTARES",
  DISPOSITIVO_MEDICO: "DISPOSITIVOS MÉDICOS",
  VETERINARIA: "VETERINÁRIA",
});

/**
 * "Outros X" é um nível 2 LITERAL da taxonomia canónica — há 24 deles.
 * Um produto lá dentro está tão por classificar como um sem nível 2
 * nenhum; a diferença é que este não aparece nas contagens de "sem
 * classificação".
 */
export function ehBalde(nome: string | null | undefined): boolean {
  return !!nome && /^outros\b/i.test(nome.trim());
}

/**
 * O productType e o nível 1 proposto trocam o ESTATUTO REGULAMENTAR do
 * produto?
 *
 * Deliberadamente conservador — devolve `false` sempre que houver dúvida:
 *
 *   · sem productType ou sem categoria      → não há contradição a medir
 *   · productType "mole" (dermocosmética…)  → não implica família nenhuma
 *   · proposta fora do grupo forte          → é arrumação, não estatuto
 *
 * Só devolve `true` quando os dois lados são estatutos regulamentares e
 * são estatutos DIFERENTES. Um falso `true` recusa uma classificação boa
 * em silêncio, que é o modo de falha que este trabalho todo existe para
 * corrigir — portanto o erro, quando houver, cai para o lado de deixar
 * passar e ser visto.
 */
export function contradicaoForte(
  productType: string | null | undefined,
  categoria: string | null | undefined,
): boolean {
  if (!productType || !categoria) return false;
  const esperada = FAMILIA_DE_TIPO[productType];
  if (!esperada) return false;
  const propostaEhForte = Object.values(FAMILIA_DE_TIPO).includes(categoria);
  if (!propostaEhForte) return false;
  return esperada !== categoria;
}
