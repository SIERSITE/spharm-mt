/**
 * lib/catalog/knowledge-enrichment-runner.ts
 *
 * A volta completa: selecciona o residual, lê a cache, propõe, verifica,
 * e escreve o que passar o gate.
 *
 * Separado de `knowledge-enrichment.ts` de propósito: aquele módulo é
 * puro (prompt, esquema, validação, gate, comparação) e testável sem base
 * de dados nem rede; este é o que toca em Postgres.
 *
 * ORDEM DAS FASES — não é negociável
 *   1. As regras determinísticas correm sempre primeiro (classify-backfill
 *      → fill-rules). Este runner assume-as feitas.
 *   2. Só entra aqui o que sobrou. A selecção é SQL (`SQL_RESIDUAL`), não
 *      é escolha do modelo.
 *
 * O QUE ESCREVE — e só isto
 *   productType (quando falta), classificacaoNivel1Id,
 *   classificacaoNivel2Id, ProdutoUtilizacao.
 *   Ver `CAMPOS_ESCRITOS` / `CAMPOS_PROIBIDOS`. Não há neste ficheiro
 *   nenhum UPDATE que toque em ATC, DCI, fabricante, imagem ou forma
 *   farmacêutica — todos têm fonte melhor.
 *
 * IDEMPOTÊNCIA
 *   Correr duas vezes seguidas gasta zero chamadas na segunda: tudo o que
 *   a primeira viu ficou em cache, incluindo os DESCONHECIDO e os que
 *   foram para revisão. As escritas são todas guardadas por `is null`,
 *   `ilike 'Outros %'` ou confiança superior.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import {
  KNOWLEDGE_MODEL,
  KNOWLEDGE_VERSION,
  TAMANHO_LOTE,
  avaliarGate,
  chaveCache,
  classificarLote,
  compararPassagens,
  precisaVerificacao,
  verificarLote,
  type Criterios,
  type Decisao,
  type KnowledgeResult,
  type ProdutoResidual,
} from "./knowledge-enrichment";

/** Códigos internos da farmácia não entram no catálogo regulamentar. */
const MIN_CNP = 2_000_000;

/** Marca de proveniência em ProdutoUtilizacao.fonte. */
export const FONTE = "MODELO";

/** As três fatias do residual — o canary é estratificado por elas. */
export type Estrato = "OUTROS_MEDICAMENTOS" | "NAO_CLASSIFICADO" | "SEM_UTILIZACOES";

/**
 * O residual, definido em SQL, com o estrato calculado na própria query.
 *
 * Três formas de um produto ser residual, e são exactamente os três
 * estratos do canary:
 *   · NAO_CLASSIFICADO    — sem categoria nenhuma;
 *   · OUTROS_MEDICAMENTOS — em "Outros <X>" (o balde);
 *   · SEM_UTILIZACOES     — classificado e específico, mas sem utilização.
 *
 * E duas exclusões absolutas:
 *   · `validadoManualmente` — decisão humana; nem se lê para gastar
 *     tokens a reconfirmar;
 *   · cnp abaixo de MIN_CNP — códigos internos, não são catálogo.
 *
 * A cláusula da cache é o que torna o job diário barato: um produto já
 * visto nesta versão não volta a entrar, tenha sido escrito ou não.
 */
function sqlResidual(estrato?: Estrato): string {
  const filtro =
    estrato === "NAO_CLASSIFICADO"
      ? `and p."classificacaoNivel2Id" is null`
      : estrato === "OUTROS_MEDICAMENTOS"
      ? `and c2.nome ilike 'Outros %'`
      : estrato === "SEM_UTILIZACOES"
      ? `and p."classificacaoNivel2Id" is not null and c2.nome not ilike 'Outros %'
         and not exists (select 1 from "ProdutoUtilizacao" pu where pu."produtoId" = p.id)`
      : `and (p."classificacaoNivel2Id" is null
             or c2.nome ilike 'Outros %'
             or not exists (select 1 from "ProdutoUtilizacao" pu where pu."produtoId" = p.id))`;

  return `
    select p.cnp,
           p.designacao,
           p."productType",
           c1.nome as "categoriaAtual",
           c2.nome as "subcategoriaAtual",
           case
             when p."classificacaoNivel2Id" is null then 'NAO_CLASSIFICADO'
             when c2.nome ilike 'Outros %'          then 'OUTROS_MEDICAMENTOS'
             else 'SEM_UTILIZACOES'
           end as estrato
      from "Produto" p
      left join "Classificacao" c1 on c1.id = p."classificacaoNivel1Id"
      left join "Classificacao" c2 on c2.id = p."classificacaoNivel2Id"
     where p.cnp >= $1
       and p."validadoManualmente" = false
       ${filtro}
       and not exists (
             select 1 from "KnowledgeEnrichmentCache" k
              where k.cnp = p.cnp and k.versao = $2 and k.modelo = $3
       )
     order by p.cnp
     limit $4`;
}

/** Uma linha do relatório por produto — o que o dry-run imprime. */
export type LinhaRelatorio = {
  cnp: number;
  designacao: string;
  estrato: Estrato;
  estadoAtual: string;
  proposta: string;
  utilizacoes: string[];
  decisao: Decisao;
  motivo: string;
  criterios: Criterios | null;
  confidence: number;
  evidenceType: string;
  verificado: boolean;
  /** true quando a proposta e a verificação divergiram. */
  discordancia: boolean;
};

export type RunnerResumo = {
  residualAnalisado: number;
  porEstrato: Record<string, number>;
  chamadasProposta: number;
  chamadasVerificacao: number;
  /** Resultados que sobreviveram à validação de vocabulário. */
  propostasValidas: number;
  /** Precisavam de segunda passagem. */
  verificacoesAplicaveis: number;
  /** Segunda passagem concordou. */
  verificacoesConcordantes: number;
  apply: number;
  review: number;
  skip: number;
  categoriasEscritas: number;
  productTypesEscritos: number;
  utilizacoesEscritas: number;
  porEvidencia: Record<string, number>;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
  custoEstimadoUsd: number;
  /** A corrida parou por ter atingido `tectoUsd`, não por ter acabado. */
  cortadoPorTecto: boolean;
  relatorio: LinhaRelatorio[];
};

/** Preço do claude-opus-5 por milhão de tokens (Junho 2026). */
const USD_POR_MTOK = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };

function estimarCusto(u: RunnerResumo["usage"]): number {
  return (
    (u.inputTokens * USD_POR_MTOK.input +
      u.outputTokens * USD_POR_MTOK.output +
      u.cacheReadTokens * USD_POR_MTOK.cacheRead +
      u.cacheWriteTokens * USD_POR_MTOK.cacheWrite) /
    1_000_000
  );
}

type LinhaResidual = ProdutoResidual & { estrato: Estrato };

/**
 * Amostra estratificada. Os primeiros N por cnp não são uma amostra do
 * catálogo — são uma amostra dos cnp mais baixos, que é outra coisa e
 * não representa as três fatias do residual.
 */
export async function selecionarCanary(
  prisma: PrismaClient,
  quotas: Partial<Record<Estrato, number>> = {
    OUTROS_MEDICAMENTOS: 40,
    NAO_CLASSIFICADO: 30,
    SEM_UTILIZACOES: 30,
  },
): Promise<LinhaResidual[]> {
  const out: LinhaResidual[] = [];
  for (const [estrato, n] of Object.entries(quotas) as [Estrato, number][]) {
    if (!n) continue;
    const linhas = await prisma.$queryRawUnsafe<LinhaResidual[]>(
      sqlResidual(estrato),
      MIN_CNP,
      KNOWLEDGE_VERSION,
      KNOWLEDGE_MODEL,
      n,
    );
    out.push(...linhas);
  }
  return out;
}

export async function runKnowledgeEnrichment(
  prisma: PrismaClient,
  opts: {
    limite?: number;
    dryRun?: boolean;
    /** Corta a corrida quando o custo estimado passa disto. */
    tectoUsd?: number;
    /** Amostra estratificada em vez dos primeiros N. */
    canary?: Partial<Record<Estrato, number>>;
    onProgress?: (feito: number, total: number) => void;
    /**
     * Substituem as chamadas ao modelo. Existem para o teste de
     * read-only poder correr a volta inteira sem rede — sem isto, provar
     * que o dry-run não escreve exigia uma credencial e dinheiro real.
     * Em produção ficam por omissão.
     */
    classificar?: typeof classificarLote;
    verificar?: typeof verificarLote;
  } = {},
): Promise<RunnerResumo> {
  const dryRun = opts.dryRun ?? false;
  const classificar = opts.classificar ?? classificarLote;
  const verificar = opts.verificar ?? verificarLote;

  const residual: LinhaResidual[] = opts.canary
    ? await selecionarCanary(prisma, opts.canary)
    : await prisma.$queryRawUnsafe<LinhaResidual[]>(
        sqlResidual(),
        MIN_CNP,
        KNOWLEDGE_VERSION,
        KNOWLEDGE_MODEL,
        opts.limite ?? 500,
      );

  const resumo: RunnerResumo = {
    residualAnalisado: residual.length,
    porEstrato: {},
    chamadasProposta: 0,
    chamadasVerificacao: 0,
    propostasValidas: 0,
    verificacoesAplicaveis: 0,
    verificacoesConcordantes: 0,
    apply: 0,
    review: 0,
    skip: 0,
    categoriasEscritas: 0,
    productTypesEscritos: 0,
    utilizacoesEscritas: 0,
    porEvidencia: {},
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    custoEstimadoUsd: 0,
    cortadoPorTecto: false,
    relatorio: [],
  };
  for (const l of residual) resumo.porEstrato[l.estrato] = (resumo.porEstrato[l.estrato] ?? 0) + 1;
  if (residual.length === 0) return resumo;

  // Vocabulário → id, resolvido uma vez. Taxonomia fechada: um nome que
  // não exista em BD não é criado, o produto fica por classificar.
  const tax = await prisma.$queryRawUnsafe<{ id: string; nome: string; pai: string | null }[]>(
    `select id, nome, "classificacaoPaiId" as pai from "Classificacao" where estado = 'ATIVO'`,
  );
  const n1PorNome = new Map<string, string>();
  const n2PorChave = new Map<string, string>();
  for (const r of tax) if (!r.pai) n1PorNome.set(r.nome.toUpperCase(), r.id);
  for (const r of tax) if (r.pai) n2PorChave.set(`${r.pai}::${r.nome.toUpperCase()}`, r.id);

  const utilVocab = await prisma.$queryRawUnsafe<{ id: string; slug: string }[]>(
    `select id, slug from "Utilizacao" where estado = 'ATIVO'`,
  );
  const utilPorSlug = new Map(utilVocab.map((u) => [u.slug, u.id]));

  const somaUsage = (u: RunnerResumo["usage"]) => {
    resumo.usage.inputTokens += u.inputTokens;
    resumo.usage.outputTokens += u.outputTokens;
    resumo.usage.cacheReadTokens += u.cacheReadTokens;
    resumo.usage.cacheWriteTokens += u.cacheWriteTokens;
    resumo.custoEstimadoUsd = estimarCusto(resumo.usage);
  };

  // Atingido o tecto, não sai mais nenhuma chamada — nem a verificação
  // de um lote já proposto. O custo é reavaliado a cada resposta, por
  // isso "imediatamente" quer dizer: na primeira fronteira depois de o
  // tecto ser ultrapassado, nunca um lote inteiro depois.
  const tectoAtingido = () => !!opts.tectoUsd && resumo.custoEstimadoUsd >= opts.tectoUsd;

  for (let i = 0; i < residual.length; i += TAMANHO_LOTE) {
    if (tectoAtingido()) {
      resumo.cortadoPorTecto = true;
      break;
    }

    const lote = residual.slice(i, i + TAMANHO_LOTE);

    // ── Passagem 1: proposta ────────────────────────────────────────
    const p1 = await classificar(lote);
    resumo.chamadasProposta++;
    somaUsage(p1.usage);
    resumo.propostasValidas += p1.resultados.length;

    // ── Passagem 2: verificação cega, só para o que a exige ─────────
    // Se o tecto caiu já com a proposta, esta chamada não chega a sair.
    // Sem verificação não há acordo, logo nada deste lote é escrito —
    // é o resultado certo: preferimos não escrever a escrever sem a
    // segunda passagem que o gate exige.
    const carecemVerificacao = p1.resultados.filter(precisaVerificacao);
    const verificacoes = new Map<number, KnowledgeResult>();
    if (carecemVerificacao.length > 0 && !tectoAtingido()) {
      const cnpsV = new Set(carecemVerificacao.map((r) => r.cnp));
      const p2 = await verificar(lote.filter((l) => cnpsV.has(l.cnp)));
      resumo.chamadasVerificacao++;
      somaUsage(p2.usage);
      for (const v of p2.resultados) verificacoes.set(v.cnp, v);
    } else if (carecemVerificacao.length > 0) {
      resumo.cortadoPorTecto = true;
    }

    const porCnp = new Map(lote.map((p) => [p.cnp, p]));
    for (const r of p1.resultados) {
      const p = porCnp.get(r.cnp);
      if (!p) continue;

      resumo.porEvidencia[r.evidenceType] = (resumo.porEvidencia[r.evidenceType] ?? 0) + 1;

      const exigeVerificacao = precisaVerificacao(r);
      const comparacao = exigeVerificacao
        ? compararPassagens(r, verificacoes.get(r.cnp) ?? null)
        : { concorda: true, utilizacoesConfirmadas: r.utilizacoes, motivo: "não exige verificação" };
      if (exigeVerificacao) {
        resumo.verificacoesAplicaveis++;
        if (comparacao.concorda) resumo.verificacoesConcordantes++;
      }

      const gate = avaliarGate(
        r,
        { categoria: p.categoriaAtual, subcategoria: p.subcategoriaAtual, productType: p.productType },
        { concorda: comparacao.concorda, aplicavel: exigeVerificacao },
      );

      // Só se escrevem utilizações confirmadas pelas duas passagens.
      const utilizacoesFinais = gate.utilizacoes.filter((u) =>
        comparacao.utilizacoesConfirmadas.includes(u),
      );

      resumo[gate.decisao === "APPLY" ? "apply" : gate.decisao === "REVIEW" ? "review" : "skip"]++;

      const motivo = gate.decisao === "REVIEW" && exigeVerificacao && !comparacao.concorda
        ? comparacao.motivo
        : gate.motivo;

      resumo.relatorio.push({
        cnp: r.cnp,
        designacao: p.designacao,
        estrato: p.estrato,
        estadoAtual: p.subcategoriaAtual
          ? `${p.categoriaAtual} > ${p.subcategoriaAtual}`
          : "NÃO CLASSIFICADO",
        proposta: r.categoria ? `${r.categoria} > ${r.subcategoria}` : "(nenhuma)",
        utilizacoes: utilizacoesFinais,
        decisao: gate.decisao,
        motivo,
        criterios: gate.criterios,
        confidence: r.confidence,
        evidenceType: r.evidenceType,
        verificado: exigeVerificacao,
        discordancia: exigeVerificacao && !comparacao.concorda,
      });

      // ── FRONTEIRA DO DRY-RUN ────────────────────────────────────────
      // Acima desta linha só se lê e se acumula relatório. Abaixo está
      // TODA a escrita desta fase: Produto, ProdutoUtilizacao e a própria
      // cache. Nada de escrita pode subir daqui — é o que
      // `test-knowledge-enrichment` verifica, com um prisma que rebenta
      // se lhe pedirem uma escrita durante um dry-run.
      if (dryRun) continue;

      let escreveuCategoria = false;
      if (gate.decisao === "APPLY" && r.categoria && r.subcategoria) {
        const n1Id = n1PorNome.get(r.categoria.toUpperCase());
        const n2Id = n1Id ? n2PorChave.get(`${n1Id}::${r.subcategoria.toUpperCase()}`) : undefined;
        if (n1Id && n2Id) {
          // A não-degradação está escrita outra vez aqui, no WHERE: mesmo
          // que o estado tenha mudado entre o SELECT e agora, uma
          // subcategoria específica não é sobreposta.
          const n = await prisma.$executeRawUnsafe(
            `update "Produto" p
                set "classificacaoNivel1Id" = $1,
                    "classificacaoNivel2Id" = $2,
                    "dataAtualizacao"       = now()
              where p.cnp = $3
                and p."validadoManualmente" = false
                and (p."classificacaoNivel2Id" is null
                     or exists (select 1 from "Classificacao" c
                                 where c.id = p."classificacaoNivel2Id"
                                   and c.nome ilike 'Outros %'))`,
            n1Id,
            n2Id,
            r.cnp,
          );
          escreveuCategoria = Number(n) > 0;
          if (escreveuCategoria) resumo.categoriasEscritas++;
        }

        // productType só quando falta — `is null` no WHERE é a guarda.
        if (gate.gravarProductType && r.productType) {
          const n = await prisma.$executeRawUnsafe(
            `update "Produto" p
                set "productType"           = $1,
                    "productTypeConfidence" = $2,
                    "classificationSource"  = 'MODEL_INFERRED',
                    "classificationVersion" = $3,
                    "dataAtualizacao"       = now()
              where p.cnp = $4
                and p."validadoManualmente" = false
                and p."productType" is null`,
            r.productType,
            r.confidence,
            KNOWLEDGE_VERSION,
            r.cnp,
          );
          if (Number(n) > 0) resumo.productTypesEscritos++;
        }
      }

      // Utilizações seguem a política do backfill de regras: MANUAL nunca
      // é tocada, automática só cede a confiança superior.
      if (gate.decisao === "APPLY") {
        for (const slug of utilizacoesFinais) {
          const uid = utilPorSlug.get(slug);
          if (!uid) continue;
          const n = await prisma.$executeRawUnsafe(
            `insert into "ProdutoUtilizacao" ("produtoId", "utilizacaoId", fonte, confianca)
             select p.id, $1, $2, $3 from "Produto" p
              where p.cnp = $4 and p."validadoManualmente" = false
             on conflict ("produtoId", "utilizacaoId") do update
                set fonte = excluded.fonte, confianca = excluded.confianca
              where "ProdutoUtilizacao".fonte <> 'MANUAL'
                and excluded.confianca > coalesce("ProdutoUtilizacao".confianca, 0)`,
            uid,
            FONTE,
            r.confidence,
            r.cnp,
          );
          resumo.utilizacoesEscritas += Number(n) || 0;
        }
      }

      await gravarCache(prisma, r, p, gate.decisao === "APPLY", motivo);
    }

    opts.onProgress?.(Math.min(i + TAMANHO_LOTE, residual.length), residual.length);
  }

  resumo.custoEstimadoUsd = estimarCusto(resumo.usage);
  return resumo;
}

/**
 * Guarda o resultado — escrito ou não. O `upsert` torna a corrida
 * re-executável a meio sem duplicar linhas, e guardar os REVIEW é o que
 * impede o job de voltar a perguntar todos os dias por produtos que já
 * se sabe que não passam o gate.
 */
async function gravarCache(
  prisma: PrismaClient,
  r: KnowledgeResult,
  p: ProdutoResidual,
  persistido: boolean,
  motivo: string,
): Promise<void> {
  const chave = chaveCache(r.cnp, p.designacao);
  await prisma.knowledgeEnrichmentCache.upsert({
    where: { chave },
    create: {
      chave,
      cnp: r.cnp,
      designacao: p.designacao,
      versao: KNOWLEDGE_VERSION,
      modelo: KNOWLEDGE_MODEL,
      productType: r.productType,
      categoria: r.categoria,
      subcategoria: r.subcategoria,
      // Guardado como evidência de que o modelo entendeu o produto.
      // NUNCA escrito em Produto.formaFarmaceutica — ver CAMPOS_PROIBIDOS.
      forma: r.forma,
      utilizacoes: r.utilizacoes,
      confidence: r.confidence,
      evidenceType: r.evidenceType,
      rationale: r.rationale,
      persistido,
      motivo: persistido ? null : motivo,
    },
    update: { persistido, motivo: persistido ? null : motivo },
  });
}
