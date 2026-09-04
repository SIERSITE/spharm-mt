/**
 * lib/catalog/fila-revisao-classificacao.ts
 *
 * A ponte que faltava: um REVIEW do knowledge-enrichment passa a chegar a
 * uma pessoa.
 *
 * ─── O QUE ACONTECIA ANTES ───────────────────────────────────────────
 *
 * O gate devolvia `REVIEW`, o runner gravava uma linha em
 * `KnowledgeEnrichmentCache` com `persistido=false` e um motivo, e
 * acabava aí. O propósito escrito desse registo é este, textualmente:
 *
 *   «guardar os REVIEW é o que impede o job de voltar a perguntar todos
 *    os dias por produtos que já se sabe que não passam o gate»
 *
 * É um registo de SUPRESSÃO. Faz o que diz e fá-lo bem — mas o comentário
 * do gate dizia «vai para revisão», e não ia: `FilaRevisao` é populada por
 * outro caminho (`lib/catalog-enrichment.ts`, o dos conectores). O
 * resultado prático era o pior dos dois mundos: o produto ficava por
 * classificar E deixava de ser perguntado, sem ninguém ser avisado.
 *
 * ─── O QUE ENTRA, E O QUE NÃO ENTRA ──────────────────────────────────
 *
 * Só entra o que uma pessoa possa DECIDIR. Um `DESCONHECIDO` não é uma
 * pergunta — é a ausência de uma —, e uma fila com centenas deles é uma
 * fila que ninguém abre duas vezes. A regra é dura de propósito: par
 * válido na taxonomia, ou não entra.
 *
 * A prioridade segue o VALOR, não a confiança. Um produto que ninguém tem
 * em stock nem vendeu no último ano não merece um minuto de farmacêutico,
 * por muito confiante que o modelo esteja; um que se venda todas as
 * semanas merece, mesmo que a proposta seja duvidosa — sobretudo se for.
 */
import type { PrismaClient } from "@/generated/prisma/client";

export type PropostaRevisao = {
  cnp: number;
  /** Par proposto. Ambos obrigatórios — sem par não há nada a decidir. */
  categoria: string;
  subcategoria: string;
  productType: string | null;
  confidence: number;
  evidenceType: string;
  rationale: string | null;
  /** Porque é que o gate recusou — o texto que a pessoa precisa de ver. */
  motivo: string;
  /** Chave da linha de cache que originou isto, para auditoria. */
  chaveCache: string | null;
  /** De onde veio a proposta: a corrida do modelo ou o reprocessamento. */
  fonte: "knowledge-enrichment" | "reavaliacao-cache";
};

export type ResultadoEnfileiramento = "criada" | "actualizada" | "sem-produto";

/**
 * Mete (ou actualiza) uma proposta na fila humana.
 *
 * DEDUPLICADO pela mesma doutrina que já vigora no caminho dos
 * conectores: no máximo UMA entrada PENDENTE por produto. Sem isto, cada
 * corrida que voltasse a ver o mesmo produto inseria outra linha e a fila
 * enchia-se de cópias do mesmo problema — que é como uma fila deixa de
 * ser lida.
 *
 * O tipo é sempre `CLASSIFICACAO_PENDENTE`: é literalmente o que está
 * pendente, e o valor já existe no enum desde antes disto.
 */
export async function enfileirarRevisaoClassificacao(
  prisma: PrismaClient,
  proposta: PropostaRevisao,
): Promise<ResultadoEnfileiramento> {
  const produto = await prisma.produto.findUnique({
    where: { cnp: proposta.cnp },
    select: { id: true },
  });
  if (!produto) return "sem-produto";

  const prioridade = (await temMovimento(prisma, produto.id)) ? "ALTA" : "BAIXA";

  const dadosOrigem = {
    fonte: proposta.fonte,
    chaveCache: proposta.chaveCache,
    proposta: {
      categoria: proposta.categoria,
      subcategoria: proposta.subcategoria,
      productType: proposta.productType,
    },
    confidence: proposta.confidence,
    evidenceType: proposta.evidenceType,
    motivo: proposta.motivo,
    rationale: proposta.rationale,
  };

  const existente = await prisma.filaRevisao.findFirst({
    where: { produtoId: produto.id, estado: "PENDENTE" },
    select: { id: true },
  });

  if (existente) {
    await prisma.filaRevisao.update({
      where: { id: existente.id },
      data: {
        tipoRevisao: "CLASSIFICACAO_PENDENTE",
        prioridade,
        dadosOrigem,
      },
    });
    return "actualizada";
  }

  await prisma.filaRevisao.create({
    data: {
      produtoId: produto.id,
      tipoRevisao: "CLASSIFICACAO_PENDENTE",
      prioridade,
      estado: "PENDENTE",
      dadosOrigem,
    },
  });
  return "criada";
}

/**
 * O produto tem stock nalguma farmácia, ou vendeu no último ano?
 *
 * Doze meses e não três: a pergunta aqui não é «vende agora», é «isto
 * ainda existe na operação». Um sazonal que vendeu no Inverno passado
 * continua a valer uma decisão em Setembro.
 */
async function temMovimento(prisma: PrismaClient, produtoId: string): Promise<boolean> {
  const haUmAno = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
  const pf = await prisma.produtoFarmacia.findFirst({
    where: {
      produtoId,
      OR: [{ stockAtual: { gt: 0 } }, { dataUltimaVenda: { gte: haUmAno } }],
    },
    select: { id: true },
  });
  return pf !== null;
}

/**
 * A proposta é accionável — vale a pena pedir a uma pessoa que decida?
 *
 * Separado de `enfileirarRevisaoClassificacao` porque os chamadores
 * precisam de o saber ANTES de tocar na base: é isto que lhes permite
 * contar, num dry-run, quantas entradas a fila receberia.
 */
export function propostaAccionavel(p: {
  categoria: string | null;
  subcategoria: string | null;
  evidenceType: string;
}): boolean {
  if (p.evidenceType === "DESCONHECIDO") return false;
  return !!p.categoria && !!p.subcategoria;
}
