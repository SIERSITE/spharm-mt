/**
 * lib/catalog/knowledge-enrich-saida.ts
 *
 * O código de saída do `catalog:knowledge-enrich`, e só isso.
 *
 * ─────────────────────────────────────────────────────────────────────
 * PORQUE É QUE ISTO É UM MÓDULO E NÃO TRÊS `if` NO CLI
 *
 * O encadeamento automático de lotes decide se lança o lote seguinte a
 * partir DESTE número. Enquanto a decisão viveu dentro do `main()` de um
 * script — que corre ao ser importado — não havia maneira de a testar
 * sem uma base de dados e uma chave da API. O que não se testa, num
 * caminho que gasta dinheiro sozinho, mais vale não existir.
 *
 * ─────────────────────────────────────────────────────────────────────
 * O DEFEITO QUE ISTO FECHA
 *
 * O relatório não imprimia `avisos` nem `falhaInfraestrutura`, e o CLI
 * saía com 0 em qualquer dos casos. Uma corrida parada por saldo
 * esgotado, credencial inválida ou 429 persistente era indistinguível de
 * "já não havia trabalho": relatório curto, código 0. Num encadeamento
 * de lotes isso é o pior caso — o lote seguinte arranca, falha da mesma
 * maneira, e a série passa em branco até ao tecto sem ninguém ver.
 *
 * A ORDEM importa. Infraestrutura ANTES de contabilidade: quando a
 * corrida é interrompida a meio por falta de saldo, a reconciliação
 * também não fecha — mas a causa é a primeira, e é essa que o operador
 * tem de resolver. Reportar "reconciliação não fechou" a quem ficou sem
 * saldo manda-o procurar um defeito que não existe.
 */

/** O que o CLI sabe no fim da corrida. */
export type EstadoSaida = {
  /** Saldo, credencial, 429/5xx persistente, rede. */
  falhaInfraestrutura: boolean;
  /** Ficaram produtos lidos sem destino contabilizado. */
  semDestino: boolean;
};

export const SAIDA = {
  /** Correu e fechou. */
  OK: 0,
  /** Uso do comando, alvo por resolver, credencial ausente à partida. */
  USO: 1,
  /** A reconciliação não fechou: há produtos lidos sem destino nomeado. */
  RECONCILIACAO: 2,
  /** A corrida parou por causa do mundo lá fora, não do catálogo. */
  INFRAESTRUTURA: 3,
} as const;

export function codigoDeSaida(e: EstadoSaida): number {
  if (e.falhaInfraestrutura) return SAIDA.INFRAESTRUTURA;
  if (e.semDestino) return SAIDA.RECONCILIACAO;
  return SAIDA.OK;
}
