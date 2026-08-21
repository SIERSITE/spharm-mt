/**
 * lib/catalog/clinica-validacao.ts
 *
 * Gramática dos campos clínicos. UMA definição, dois consumidores.
 *
 * ─────────────────────────────────────────────────────────────────────
 * PORQUE É UM MÓDULO E NÃO DUAS CONSTANTES ONDE CALHAVA
 *
 * Estas regras nasceram em `knowledge-enrichment.ts`, onde validam o que
 * o modelo devolve antes de se escrever no tenant. O catálogo global
 * precisa exactamente das mesmas: recebe de vários sítios e não pode
 * depender da higiene de quem lhe chama.
 *
 * Importá-las de lá resolvia a duplicação e criava um problema pior: o
 * `knowledge-enrichment.ts` instancia o SDK do Anthropic ao carregar, e o
 * `global-catalog.ts` declara-se puro — sem base de dados e sem rede. É
 * essa pureza que o deixa correr no control plane e nos testes sem
 * ambiente. Um import inocente arrastava o SDK para dentro dela.
 *
 * Duas cópias do padrão também não: divergiriam, e a divergência
 * apareceria como um ATC malformado a chegar a um tenant que nunca o
 * pediu — vindo do catálogo nacional, portanto a todos ao mesmo tempo.
 */

/**
 * Código ATC COMPLETO: sete caracteres, cinco níveis.
 *
 * A validação é de tudo-ou-nada de propósito. "N02" não é um ATC
 * incompleto que se aproveite — é um grupo anatómico que não identifica
 * substância nenhuma. Guardá-lo como se fosse um código dá a um produto
 * uma identidade química que ele não tem, e no catálogo global espalha-a
 * por todos os tenants de uma vez.
 *
 * A primeira letra vem do conjunto real dos grupos anatómicos (não há
 * grupo E, F, I, K, O, Q, T, U, W, X, Y, Z): um "I02BE01" tem a forma
 * certa e é inválido na mesma.
 */
export const ATC_COMPLETO = /^[ABCDGHJLMNPRSV][0-9]{2}[A-Z]{2}[0-9]{2}$/;

/**
 * DCI plausível: começa por letra e não passa de 80 caracteres.
 *
 * Não valida contra um dicionário — não temos um, e inventá-lo seria pior
 * do que não ter. O que esta regra apanha é o modo de falha real: o
 * modelo a escrever uma FRASE onde devia estar uma substância
 * ("associação de paracetamol com cafeína indicada para..."). Combinações
 * legítimas levam vírgulas, barras e parênteses, e por isso passam.
 *
 * O limite tem de ser validado ANTES de qualquer truncagem. Truncar a 80
 * e validar depois transforma uma frase de 86 caracteres numa "DCI"
 * perfeitamente plausível de 80 — foi exactamente esse o defeito que um
 * teste apanhou.
 */
export const DCI_PLAUSIVEL = /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9 ,''\-\/()+.]{1,79}$/;
