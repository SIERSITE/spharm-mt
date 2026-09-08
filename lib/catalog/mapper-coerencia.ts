/**
 * lib/catalog/mapper-coerencia.ts
 *
 * A invariante do mapper: a mesma designação dá a mesma classificação,
 * venha por onde vier.
 *
 * ─────────────────────────────────────────────────────────────────────
 * PORQUE É QUE ISTO VIVE EM `lib/` E NÃO NO TESTE
 *
 * Porque tem de correr em dois sítios com a MESMA tabela de casos:
 *
 *   · `scripts/tests/test-mapper-porta-de-entrada.ts` — em
 *     desenvolvimento e em revisão de código;
 *   · `scripts/diagnostics/mapper-coerencia.ts` — dentro da imagem
 *     operacional, onde `scripts/tests/` não entra (e não deve entrar:
 *     o Dockerfile copia só o que os comandos operacionais tocam, e um
 *     teste unitário não é um comando operacional).
 *
 * Duas cópias da lista divergiriam, e a que divergiria primeiro seria a
 * do diagnóstico — a que ninguém corre todos os dias. `lib/` já está na
 * imagem, portanto isto entra sem alterar o Dockerfile.
 *
 * ─────────────────────────────────────────────────────────────────────
 * O DEFEITO QUE ISTO GUARDA
 *
 * `catalog-taxonomy-map.ts` tem dois conjuntos de regras: um dicionário
 * por N1, usado quando o nível 1 já é conhecido, e uma rota de salvamento
 * plana, usada quando não é. Até 2026-09-08 os tokens de material de
 * curativo estavam nos dois, apontados a famílias diferentes:
 *
 *   "Leukotape K Lig Elast Ades"
 *     sem productType ............ PRIMEIROS SOCORROS > Ligaduras
 *     com DISPOSITIVO_MEDICO ..... DISPOSITIVOS MÉDICOS > Material de Curativo
 *
 * O mapper determinístico a discordar de si próprio conforme a porta de
 * entrada — e o resultado a aparecer em `CatalogoGlobalRevisao` como se
 * fosse desacordo entre farmácias.
 *
 * Puro: sem base de dados, sem rede, sem variáveis de ambiente. É por
 * isso que corre igual na máquina de quem programa e dentro do container.
 */
import { mapToCanonical, type TaxonomyMapInput } from "../catalog-taxonomy-map";
import type { ProductType } from "../catalog-types";

/** Uma porta de entrada do mapper. */
export type Porta = { nome: string; input: (designacao: string) => TaxonomyMapInput };

const base = (designacao: string): TaxonomyMapInput => ({
  productType: "OUTRO",
  productTypeConfidence: 0,
  externalCategory: null,
  externalSubcategory: null,
  designacao,
  atc: null,
});

const comTipo = (designacao: string, productType: ProductType): TaxonomyMapInput => ({
  ...base(designacao),
  productType,
  productTypeConfidence: 0.9,
});

/**
 * Os quatro caminhos por onde um produto chega ao mapper.
 *
 * Não são hipotéticos: o primeiro é o do ERP sem `productType`, o segundo
 * o do classificador, os dois últimos os de um conector retail com
 * breadcrumb.
 */
export const PORTAS: readonly Porta[] = [
  { nome: "sem nada", input: base },
  { nome: "productType=DISPOSITIVO_MEDICO", input: (d) => comTipo(d, "DISPOSITIVO_MEDICO") },
  {
    nome: "breadcrumb Dispositivos Médicos",
    input: (d) => ({ ...base(d), externalCategory: "Dispositivos Médicos" }),
  },
  {
    nome: "breadcrumb Primeiros Socorros",
    input: (d) => ({ ...base(d), externalCategory: "Primeiros Socorros" }),
  },
];

/**
 * As designações com que o defeito foi reproduzido, e o resultado que
 * cada uma tem de dar em TODAS as portas.
 *
 * São designações reais da Garantia — abreviaturas do ERP incluídas.
 * Inventar nomes limpos aqui seria testar um catálogo que não existe.
 */
export const CASOS: ReadonlyArray<{ designacao: string; esperado: string }> = [
  // Os tokens que estavam nos dois conjuntos de regras.
  { designacao: "Leukotape K Lig Elast Ades 5x5cm Bege", esperado: "PRIMEIROS SOCORROS > Ligaduras" },
  { designacao: "Leukotape K Lig Elast Ades 5x5cm Azul", esperado: "PRIMEIROS SOCORROS > Ligaduras" },
  { designacao: "COMPRESSA NAO TECIDO 10CMX10CM X 5UNI BV", esperado: "PRIMEIROS SOCORROS > Pensos e Compressas" },
  { designacao: "Compressa N Tecid Est 7,5x7,5 30g Ee1 X10 BV", esperado: "PRIMEIROS SOCORROS > Pensos e Compressas" },

  // A ordem na rota plana: a marca vale mais que o formato. O par é
  // deliberado — o segundo sempre esteve certo, e foi ele que provou que
  // o primeiro estava errado por causa da palavra "gaze".
  { designacao: "BETADINE GAZE IMPREGNADA 10X10CM CAIXA", esperado: "PRIMEIROS SOCORROS > Antissépticos" },
  { designacao: "BETADINE SOLUCAO CUTANEA 125ML", esperado: "PRIMEIROS SOCORROS > Antissépticos" },
  { designacao: "Iodopovidona Solucao Dermica 100ml", esperado: "PRIMEIROS SOCORROS > Antissépticos" },

  // Estes nunca dependeram da porta, e a correcção não os podia tocar.
  { designacao: "Agulhas Clickfine 6mmx31g 100", esperado: "MATERIAL CLÍNICO E CONSUMÍVEIS > Seringas e Agulhas" },
  { designacao: "Agulhas Clickfine 8mmx31g 100", esperado: "MATERIAL CLÍNICO E CONSUMÍVEIS > Seringas e Agulhas" },
  { designacao: "Wellion Lancetas De Seguranca 23g 200", esperado: "MATERIAL CLÍNICO E CONSUMÍVEIS > Seringas e Agulhas" },
  { designacao: "Seringa Insulina 1ml 100ui", esperado: "MATERIAL CLÍNICO E CONSUMÍVEIS > Seringas e Agulhas" },
];

export type ResultadoCaso = {
  designacao: string;
  esperado: string;
  /** O que cada porta devolveu. */
  porPorta: Array<{ porta: string; valor: string }>;
  /** Quantos resultados distintos as portas deram. 1 é o que se quer. */
  distintos: number;
  /** Todas as portas deram o esperado? */
  correcto: boolean;
};

const par = (i: TaxonomyMapInput): string => {
  const r = mapToCanonical(i);
  return r ? `${r.nivel1} > ${r.nivel2}` : "(null)";
};

/**
 * Corre um caso por todas as portas.
 *
 * Devolve as duas metades em separado — `distintos` e `correcto` — e as
 * duas importam. Só "todas iguais" passaria se fossem todas iguais e
 * erradas; só "é o esperado" não diria QUAL porta divergiu.
 */
export function verificarCaso(designacao: string, esperado: string): ResultadoCaso {
  const porPorta = PORTAS.map((p) => ({ porta: p.nome, valor: par(p.input(designacao)) }));
  return {
    designacao,
    esperado,
    porPorta,
    distintos: new Set(porPorta.map((p) => p.valor)).size,
    correcto: porPorta.every((p) => p.valor === esperado),
  };
}

/** Todos os casos. `ok` só quando cada um dá um resultado, e o certo. */
export function verificarCoerenciaDoMapper(): { ok: boolean; resultados: ResultadoCaso[] } {
  const resultados = CASOS.map((c) => verificarCaso(c.designacao, c.esperado));
  return { ok: resultados.every((r) => r.distintos === 1 && r.correcto), resultados };
}
