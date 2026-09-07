/**
 * lib/catalog/projeccao-classificacao.ts
 *
 * Que proveniência e que estado carimba uma classificação RECEBIDA do
 * catálogo global. Puro: sem base de dados, sem rede.
 *
 * ─────────────────────────────────────────────────────────────────────
 * O DEFEITO QUE ISTO FECHA
 *
 * `projectarParaTenant` escrevia `classificacaoNivel1Id` e
 * `classificacaoNivel2Id` e mais nada. O produto ficava classificado com
 * o enum a dizer `AUSENTE` — e, ao contrário do que o nome sugere, isso
 * não é um estado transitório à espera de rotina nenhuma: não havia
 * rotina. Ficava assim até alguém correr `catalog:sincronizar-estado` à
 * mão.
 *
 * Mediu-se na Garantia: 775 produtos com N1/N2 preenchidos e estado
 * AUSENTE, logo a seguir a `catalog:project-global`. E como o endpoint de
 * importação chama a MESMA função de forma síncrona, cada upload de
 * qualquer farmácia produzia casos novos.
 *
 * ─────────────────────────────────────────────────────────────────────
 * PORQUE É QUE A ORIGEM É `GLOBAL`
 *
 * O valor já existia em `OrigemClassificacao` e nunca tinha sido usado —
 * estava reservado exactamente para isto. É o que é verdade: esta
 * classificação não foi decidida aqui, foi recebida do catálogo nacional.
 *
 * NÃO se usa a origem com que o tenant de origem a escreveu. Duas razões:
 * o global guarda a origem DELE (`OrigemGlobal`, outro vocabulário), e
 * copiá-la faria um produto projectado parecer decidido localmente —
 * apagando o único facto que distingue as duas coisas.
 *
 * ─────────────────────────────────────────────────────────────────────
 * PORQUE É QUE O ESTADO NÃO É SEMPRE `CANONICA`
 *
 * Seria a resposta fácil, e lavaria uma provisória.
 *
 * Uma classificação provisória — par válido, subcategoria específica,
 * evidência `CATEGORIA_PRODUTO` — é promovida ao global como qualquer
 * outra: `juntarCandidato` só exige `APPLY`, e o ramo provisório do gate
 * devolve `APPLY`. `avaliarPromocao` também não filtra por evidência.
 * Logo, o global CONTÉM conhecimento provisório.
 *
 * Se a projecção carimbasse tudo como `CANONICA`, uma dedução provisória
 * feita na Silveira chegava à Garantia como facto estabelecido — e o
 * atravessar da fronteira entre tenants era o que a promovia. Uma lavagem
 * silenciosa, do mesmo género da que `marcarComoProjectada` já existe
 * para impedir do lado da re-promoção.
 *
 * Por isso o estado é derivado da mesma regra que decidiu do outro lado:
 * `EVIDENCIA_PROVISORIA`. Uma fonte só, usada nas duas pontas.
 */
import { EVIDENCIA_PROVISORIA, type EvidenceType } from "./knowledge-enrichment";
import { FATOR_PROJECCAO } from "./global-catalog";
import type { EstadoClassificacao, OrigemClassificacao } from "./escrita-classificacao";

/**
 * O que a projecção carimba, para lá de N1/N2.
 *
 * `confianca` e `versao` não são decoração: sem elas o produto ficava
 * com estado e origem preenchidos e a confiança a NULL, e ninguém
 * conseguia distinguir uma projecção de uma linha reparada à mão pelo
 * `catalog:sincronizar-estado` — que deixa esses campos vazios de
 * propósito, porque não os conhece. Aqui conhecem-se.
 */
export type CarimboProjeccao = {
  estado: EstadoClassificacao;
  origem: OrigemClassificacao;
  confianca: number;
  versao: string;
};

/** O mínimo que é preciso saber do global para carimbar. */
export type OrigemDoCarimbo = {
  evidenceType?: string | null;
  confidence: number;
  versaoRegras: string;
};

/**
 * Deriva o carimbo de uma classificação recebida do global.
 *
 * A confiança entra reduzida por `FATOR_PROJECCAO`, pela mesma razão que
 * já reduz a do `productType` e a das utilizações projectadas: o que vem
 * do global vale um pouco menos que uma decisão directa sobre este
 * produto neste tenant. Sem isso, uma projecção empatava com a decisão
 * local e a ordem de chegada passava a decidir.
 */
export function carimboProjeccao(g: OrigemDoCarimbo): CarimboProjeccao {
  const provisoria =
    !!g.evidenceType && EVIDENCIA_PROVISORIA.has(g.evidenceType as EvidenceType);
  return {
    estado: provisoria ? "PROVISORIA" : "CANONICA",
    origem: "GLOBAL",
    confianca: g.confidence * FATOR_PROJECCAO,
    versao: g.versaoRegras,
  };
}
