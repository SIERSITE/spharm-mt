/**
 * lib/catalog/global-catalog-store.ts
 *
 * A camada que toca em base de dados: lê e escreve o CatalogoGlobal no
 * control plane, e projecta-o para a base de um tenant.
 *
 * Separado de `global-catalog.ts` de propósito — aquele é puro (ordem de
 * autoridade, promoção, projecção) e testável sem base nenhuma; este é o
 * que abre ligações.
 *
 * DUAS BASES, SEMPRE EXPLÍCITAS
 *   · control plane (`controlPrisma`) — o conhecimento global;
 *   · base do tenant (`PrismaClient` passado por quem chama) — o destino.
 * Nada aqui resolve tenants por omissão: quem chama diz qual.
 */
import { controlPrisma } from "../control-plane";
import type { PrismaClient } from "@/generated/prisma/client";
import { chaveCache, LIMIAR_CLINICO } from "./knowledge-enrichment";
import {
  avaliarProjeccao,
  avaliarPromocao,
  ehEspecifica,
  origemDaClassificacao,
  origemDaClinica,
  origemDaUtilizacao,
  registoPromocao,
  validarValorClinico,
  CAMPOS_CLINICOS,
  FATOR_PROJECCAO,
  ORIGEM_CACHE_GLOBAL,
  type AprovacaoHumana,
  type CampoClinico,
  type ClinicaCandidata,
  type ConhecimentoCandidato,
  type ConhecimentoGlobal,
  type EstadoLocal,
  type OrigemGlobal,
  type UtilizacaoCandidata,
} from "./global-catalog";

/**
 * Campo clínico → coluna em `Produto` e coluna na `KnowledgeEnrichmentCache`.
 *
 * Os dois nomes divergem num campo — `formaFarmaceutica` no produto,
 * `forma` na cache — e essa divergência já existia antes desta camada.
 * Fica escrita UMA vez, aqui, em vez de repetida em cada query.
 */
const COLUNAS_CLINICAS: Record<CampoClinico, { produto: string; cache: string }> = {
  CODIGO_ATC: { produto: "codigoATC", cache: "codigoATC" },
  DCI: { produto: "dci", cache: "dci" },
  FORMA_FARMACEUTICA: { produto: "formaFarmaceutica", cache: "forma" },
  DOSAGEM: { produto: "dosagem", cache: "dosagem" },
  EMBALAGEM: { produto: "embalagem", cache: "embalagem" },
};

/** Marca de proveniência das escritas que vêm do catálogo global. */
export const FONTE_GLOBAL = "CATALOGO_GLOBAL";
export const TIER_GLOBAL = "MODEL_PROPAGATED";

// ─── Leitura ──────────────────────────────────────────────────────────

/**
 * Conhecimento global para um conjunto de CNPs.
 *
 * É esta consulta que responde à pergunta que motiva a camada toda:
 * "este CNP já é conhecido?". Um CNP que volte daqui não vai ao modelo.
 */
export async function lerConhecimentoGlobal(
  cnps: readonly number[],
): Promise<Map<number, ConhecimentoGlobal>> {
  const out = new Map<number, ConhecimentoGlobal>();
  if (cnps.length === 0) return out;

  const BLOCO = 5000;
  for (let i = 0; i < cnps.length; i += BLOCO) {
    const bloco = cnps.slice(i, i + BLOCO);
    const linhas = await controlPrisma.catalogoGlobal.findMany({
      where: { cnp: { in: [...bloco] } },
      // `clinica` entra pelo mesmo caminho das `utilizacoes`, e pela
      // mesma razão: cada linha traz a sua própria origem e confiança, e
      // é avaliada sozinha.
      include: { utilizacoes: true, clinica: true },
    });
    for (const l of linhas) {
      out.set(l.cnp, {
        cnp: l.cnp,
        categoria: l.categoria,
        subcategoria: l.subcategoria,
        productType: l.productType,
        confidence: l.confidence,
        origem: l.origem as OrigemGlobal,
        versaoRegras: l.versaoRegras,
        verificado: l.verificado,
        utilizacoes: l.utilizacoes.map((u) => ({
          slug: u.slug,
          confidence: u.confidence,
          origem: u.origem as OrigemGlobal,
        })),
        clinica: new Map(
          l.clinica.map((c) => [
            c.campo as CampoClinico,
            {
              campo: c.campo as CampoClinico,
              valor: c.valor,
              origem: c.origem as OrigemGlobal,
              confianca: c.confianca,
              versaoRegras: c.versaoRegras,
            },
          ]),
        ),
      });
    }
  }
  return out;
}

/** Quantos CNPs conhece o global, por origem. */
export async function estatisticasGlobal(): Promise<{
  total: number;
  porOrigem: Record<string, number>;
  utilizacoes: number;
  revisoesAbertas: number;
}> {
  const [total, grupos, utilizacoes, revisoesAbertas] = await Promise.all([
    controlPrisma.catalogoGlobal.count(),
    controlPrisma.catalogoGlobal.groupBy({ by: ["origem"], _count: { _all: true } }),
    controlPrisma.catalogoGlobalUtilizacao.count(),
    controlPrisma.catalogoGlobalRevisao.count({ where: { resolvidoEm: null } }),
  ]);
  return {
    total,
    porOrigem: Object.fromEntries(grupos.map((g) => [g.origem, g._count._all])),
    utilizacoes,
    revisoesAbertas,
  };
}

// ─── Promoção ─────────────────────────────────────────────────────────

export type ResultadoPromocao = {
  /** Produtos que promoveram ALGUMA coisa — classificação ou utilizações. */
  produtosPromovidos: number;
  classificacoesPromovidas: number;
  utilizacoesPromovidas: number;
  recusasClassificacao: number;
  recusasUtilizacao: number;
  /**
   * Recusados APENAS por falta de aprovação humana. Passavam tudo o
   * resto — estão à espera de alguém, não reprovados.
   */
  aguardamAprovacao: number;
  /** Distribuição por origem REAL, das que subiram. */
  porOrigemClassificacao: Record<string, number>;
  porOrigemUtilizacao: Record<string, number>;
  /**
   * Motivo de CADA decisão de classificação — promoções incluídas.
   *
   * Não é a distribuição das recusas: uma promoção também tem motivo
   * ("cnp ainda não conhecido globalmente"), e é contado aqui. Quem
   * imprimir isto sob o rótulo de "recusas" mostra números que não
   * fecham com `recusasClassificacao`.
   */
  motivosClassificacao: Record<string, number>;
  /** Só recusas — contado dentro do laço das utilizações recusadas. */
  motivosUtilizacao: Record<string, number>;
  /** Campos clínicos escritos no global, por campo. */
  clinicaPromovida: Record<string, number>;
  /** Campos clínicos escritos, por origem. */
  clinicaPorOrigem: Record<string, number>;
  /** Só recusas clínicas — contado dentro do laço das recusadas. */
  motivosClinica: Record<string, number>;
  /** Total de campos clínicos escritos. Soma de `clinicaPromovida`. */
  clinicaTotal: number;
  /** Campos clínicos recusados. */
  recusasClinica: number;
};

const contar = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };

export type OpcoesPromocao = {
  dryRun?: boolean;
  /**
   * Quem promove. Obrigatório e sem valor por omissão: uma promoção sem
   * autor identificado não é auditável, e o custo de o exigir é uma
   * string em cada sítio que chama isto.
   */
  actor: string;
  /**
   * Aprovação humana explícita. Só com ela sobem candidatos de origem
   * HUMANO — ver `avaliarPromocao`.
   */
  aprovacao?: AprovacaoHumana | null;
};

/**
 * Promove candidatos ao global, um a um, com a regra de autoridade.
 *
 * DUAS PARTES INDEPENDENTES. A classificação e as utilizações sobem
 * separadamente: um produto sem classificação específica pode na mesma
 * levar as suas utilizações ao global, e é isso que as recusas de
 * "832 sem classificação específica" estavam a deitar fora.
 *
 * Idempotente: promover o que já lá está com a mesma origem e a mesma
 * confiança não escreve nada — nem na tabela, nem no rasto de auditoria.
 * É `avaliarPromocao` que decide, e ela recusa o empate para isso.
 */
export async function promoverAoGlobal(
  candidatos: readonly ConhecimentoCandidato[],
  opts: OpcoesPromocao,
): Promise<ResultadoPromocao> {
  const r: ResultadoPromocao = {
    produtosPromovidos: 0,
    classificacoesPromovidas: 0,
    utilizacoesPromovidas: 0,
    recusasClassificacao: 0,
    recusasUtilizacao: 0,
    aguardamAprovacao: 0,
    porOrigemClassificacao: {},
    porOrigemUtilizacao: {},
    motivosClassificacao: {},
    motivosUtilizacao: {},
    clinicaPromovida: {},
    clinicaPorOrigem: {},
    motivosClinica: {},
    clinicaTotal: 0,
    recusasClinica: 0,
  };
  if (candidatos.length === 0) return r;

  const actual = await lerConhecimentoGlobal(candidatos.map((c) => c.cnp));
  const agora = new Date();

  for (const c of candidatos) {
    const decisao = avaliarPromocao(c, actual.get(c.cnp) ?? null, { aprovacao: opts.aprovacao });

    contar(r.motivosClassificacao, decisao.classificacao.motivo);
    if (decisao.classificacao.promover) {
      r.classificacoesPromovidas++;
      if (c.origem) contar(r.porOrigemClassificacao, c.origem);
    } else {
      r.recusasClassificacao++;
      if (decisao.classificacao.aguardaAprovacao) r.aguardamAprovacao++;
    }

    for (const u of decisao.utilizacoes.promover) {
      r.utilizacoesPromovidas++;
      if (u.origem) contar(r.porOrigemUtilizacao, u.origem);
    }
    for (const u of decisao.utilizacoes.recusadas) {
      r.recusasUtilizacao++;
      contar(r.motivosUtilizacao, u.motivo);
    }

    for (const c of decisao.clinica.promover) {
      r.clinicaTotal++;
      contar(r.clinicaPromovida, c.campo);
      if (c.origem) contar(r.clinicaPorOrigem, c.origem);
    }
    for (const c of decisao.clinica.recusadas) {
      r.recusasClinica++;
      contar(r.motivosClinica, c.motivo);
    }

    if (!decisao.promover) continue;
    r.produtosPromovidos++;
    if (opts.dryRun) continue;

    const registo = registoPromocao(c, decisao, { actor: opts.actor, aprovacao: opts.aprovacao });
    // `origemDaPromocao` só devolve null quando nada sobe, e nesse caso
    // já saímos acima. A guarda existe para o compilador e para o dia em
    // que alguém mexer numa das duas.
    if (!registo) continue;

    const auditoria = {
      promovidoPor: registo.actor,
      promovidoEm: agora,
      promovidoDeTenant: registo.tenantOrigem,
      promocaoMotivo: registo.motivo,
    };

    if (decisao.classificacao.promover) {
      await controlPrisma.catalogoGlobal.upsert({
        where: { cnp: c.cnp },
        create: {
          cnp: c.cnp,
          designacaoReferencia: c.designacaoReferencia,
          productType: c.productType,
          categoria: c.categoria,
          subcategoria: c.subcategoria,
          confidence: c.confidence,
          evidenceType: c.evidenceType,
          fonteOriginal: c.fonteOriginal,
          origem: registo.origem,
          versaoRegras: c.versaoRegras,
          verificado: c.verificado,
          tenantOrigem: c.tenantOrigem,
          ...auditoria,
        },
        update: {
          designacaoReferencia: c.designacaoReferencia,
          productType: c.productType,
          categoria: c.categoria,
          subcategoria: c.subcategoria,
          confidence: c.confidence,
          evidenceType: c.evidenceType,
          fonteOriginal: c.fonteOriginal,
          origem: registo.origem,
          versaoRegras: c.versaoRegras,
          verificado: c.verificado,
          ...auditoria,
        },
      });
    } else {
      // Só sobem utilizações. A linha do produto tem de existir — é o
      // alvo da chave estrangeira — mas nasce SEM classificação e, se já
      // existir, não se lhe toca em campo nenhum. Uma promoção de
      // utilizações não pode reescrever uma classificação que não ganhou.
      await controlPrisma.catalogoGlobal.upsert({
        where: { cnp: c.cnp },
        create: {
          cnp: c.cnp,
          designacaoReferencia: c.designacaoReferencia,
          productType: null,
          categoria: null,
          subcategoria: null,
          confidence: c.confidence,
          evidenceType: null,
          fonteOriginal: c.fonteOriginal,
          origem: registo.origem,
          versaoRegras: c.versaoRegras,
          verificado: false,
          tenantOrigem: c.tenantOrigem,
          ...auditoria,
        },
        update: {},
      });
    }

    // O rasto: append-only, uma linha por promoção que aconteceu.
    await controlPrisma.catalogoGlobalPromocao.create({ data: registo });

    // Utilizações: cada slug tem a SUA própria autoridade e a sua própria
    // origem. Não se apaga o que lá está — um slug que este candidato não
    // traga pode ter vindo de outro tenant que conhece melhor o produto.
    for (const u of decisao.utilizacoes.promover) {
      await controlPrisma.catalogoGlobalUtilizacao.upsert({
        where: { cnp_slug: { cnp: c.cnp, slug: u.slug } },
        create: { cnp: c.cnp, slug: u.slug, confidence: u.confidence, origem: u.origem!, versaoRegras: c.versaoRegras },
        update: { confidence: u.confidence, origem: u.origem!, versaoRegras: c.versaoRegras },
      });
    }

    // Clínica: uma linha por campo, cada uma com a SUA origem. Só chegam
    // aqui os campos que `avaliarClinica` aprovou — um campo recusado não
    // é escrito, e um campo ausente nunca chegou a ser candidato. Não há
    // `delete` neste ficheiro: informação clínica não se apaga por uma
    // corrida não a ter trazido.
    for (const cl of decisao.clinica.promover) {
      await controlPrisma.catalogoGlobalClinica.upsert({
        where: { cnp_campo: { cnp: c.cnp, campo: cl.campo } },
        create: {
          cnp: c.cnp,
          campo: cl.campo,
          valor: cl.valor,
          origem: cl.origem!,
          confianca: cl.confianca,
          versaoRegras: cl.versaoRegras,
          tenantOrigem: c.tenantOrigem,
          promovidoPor: registo.actor,
          promovidoEm: agora,
        },
        update: {
          valor: cl.valor,
          origem: cl.origem!,
          confianca: cl.confianca,
          versaoRegras: cl.versaoRegras,
          tenantOrigem: c.tenantOrigem,
          promovidoPor: registo.actor,
          promovidoEm: agora,
        },
      });
    }
  }
  return r;
}

// ─── Candidatos: o que a base de um tenant já sabe ────────────────────

type LinhaTenant = {
  id: string;
  cnp: number;
  designacao: string;
  productType: string | null;
  categoria: string | null;
  subcategoria: string | null;
  validadoManualmente: boolean;
  classificationSource: string | null;
  productTypeConfidence: number | null;
  temRegulatorio: boolean;
  utilSlugs: string[] | null;
  utilFontes: string[] | null;
  utilConfs: number[] | null;
  cacheOrigem: string | null;
  cacheConfidence: number | null;
  cacheEvidence: string | null;
  cacheConfClinica: number | null;
  cacheVersao: string | null;
} & Partial<
  // Uma coluna por campo clínico e por fonte, com prefixo:
  //   p… valor no `Produto`   k… valor na cache   r… valor regulamentar
  //
  // Os prefixos existem porque as três fontes têm de chegar aqui LADO A
  // LADO: a origem de um campo sai da igualdade entre elas, e comparar
  // exige tê-las todas na mesma linha.
  Record<`p${CampoClinico}` | `k${CampoClinico}` | `r${CampoClinico}`, string | null>
>;

export type OpcoesLeituraCandidatos = {
  /** Códigos internos da farmácia não entram no catálogo nacional. */
  minCnp: number;
  versaoRegras: string;
  /** Restringir a estes CNPs. Omitido = todo o catálogo do tenant. */
  cnps?: readonly number[];
  /** Só o que uma pessoa validou à mão. Usado pela promoção explícita. */
  apenasValidadosManualmente?: boolean;
};

export type LeituraCandidatos = {
  lidos: number;
  /** Sem classificação específica nem utilizações: não há o que promover. */
  semNada: number;
  /** Distribuição da origem da CLASSIFICAÇÃO entre os candidatos. */
  porOrigem: Record<string, number>;
  /** `Produto.classificationSource` cru — a proveniência do productType. */
  porFonteOriginal: Record<string, number>;
  /** Distribuição da origem das utilizações, por associação. */
  porOrigemUtilizacao: Record<string, number>;
  /** Candidatos que só têm utilizações: sem classificação específica. */
  soUtilizacoes: number;
  /** Quantos campos clínicos com valor foram encontrados, por campo. */
  clinicaPorCampo: Record<string, number>;
  /** Origem atribuída a esses campos — inclui os que ficaram por atribuir. */
  clinicaPorOrigem: Record<string, number>;
  candidatos: ConhecimentoCandidato[];
};

/**
 * Lê a base de um tenant e monta os candidatos a promoção.
 *
 * CADA PARTE TRAZ A SUA PROVENIÊNCIA. A classificação deriva-a de
 * `origemDaClassificacao`, cada utilização da sua própria
 * `ProdutoUtilizacao.fonte`. Um produto com a classificação vinda de uma
 * regra e uma etiqueta posta à mão sai daqui com as duas coisas ditas
 * como são — antes, a mais forte de qualquer das partes contaminava o
 * produto inteiro.
 *
 * Consequência deliberada: um produto com `validadoManualmente` sai com a
 * CLASSIFICAÇÃO como HUMANO, e portanto não sobe sem aprovação explícita.
 * As utilizações dele sobem na mesma, se as fontes delas o permitirem.
 *
 * Só lê. Quem escreve é `promoverAoGlobal`.
 */
export async function lerCandidatosDoTenant(
  prisma: PrismaClient,
  tenantSlug: string,
  opts: OpcoesLeituraCandidatos,
): Promise<LeituraCandidatos> {
  const params: unknown[] = [opts.minCnp];
  // `>` e nao `>=`: a mesma fronteira do resto do pipeline. Ver
  // lib/catalog/cnp-catalogavel.ts.
  const filtros = [`p.cnp > $1`];

  if (opts.cnps && opts.cnps.length > 0) {
    params.push([...opts.cnps]);
    filtros.push(`p.cnp = any($${params.length}::int[])`);
  }
  if (opts.apenasValidadosManualmente) {
    filtros.push(
      `(p."validadoManualmente" = true
        or exists (select 1 from "ProdutoUtilizacao" x
                    where x."produtoId" = p.id and x.fonte = 'MANUAL'))`,
    );
  }

  const linhas = await prisma.$queryRawUnsafe<LinhaTenant[]>(
    `select p.id,
            p.cnp,
            p.designacao,
            p."productType",
            p."validadoManualmente",
            p."classificationSource",
            p."productTypeConfidence",
            c1.nome as categoria,
            c2.nome as subcategoria,
            (r.cnp is not null) as "temRegulatorio",
            coalesce(array_agg(u.slug)   filter (where u.slug is not null), '{}') as "utilSlugs",
            coalesce(array_agg(pu.fonte) filter (where u.slug is not null), '{}') as "utilFontes",
            coalesce(array_agg(coalesce(pu.confianca, 1)) filter (where u.slug is not null), '{}') as "utilConfs",
            max(k.origem)              as "cacheOrigem",
            max(k.confidence)          as "cacheConfidence",
            max(k."evidenceType")      as "cacheEvidence",
            max(k."confidenceClinica") as "cacheConfClinica",
            max(k.versao)              as "cacheVersao",
            -- Clínica: valor no produto, valor na cache, valor na fonte
            -- regulamentar. A origem sai da IGUALDADE entre eles, em
            -- origemDaClinica() -- nunca de um default.
            p."codigoATC"          as "pCODIGO_ATC",
            p.dci                  as "pDCI",
            p."formaFarmaceutica"  as "pFORMA_FARMACEUTICA",
            p.dosagem              as "pDOSAGEM",
            p.embalagem            as "pEMBALAGEM",
            max(k."codigoATC")     as "kCODIGO_ATC",
            max(k.dci)             as "kDCI",
            max(k.forma)           as "kFORMA_FARMACEUTICA",
            max(k.dosagem)         as "kDOSAGEM",
            max(k.embalagem)       as "kEMBALAGEM",
            max(r."codigoATC")         as "rCODIGO_ATC",
            max(r.dci)                 as "rDCI",
            max(r."formaFarmaceutica") as "rFORMA_FARMACEUTICA",
            max(r.dosagem)             as "rDOSAGEM",
            max(r.embalagem)           as "rEMBALAGEM"
       from "Produto" p
       left join "Classificacao" c1 on c1.id = p."classificacaoNivel1Id"
       left join "Classificacao" c2 on c2.id = p."classificacaoNivel2Id"
       left join "RegulatoryRecord" r on r.cnp = p.cnp
       left join "ProdutoUtilizacao" pu on pu."produtoId" = p.id
       left join "Utilizacao" u on u.id = pu."utilizacaoId"
       left join "KnowledgeEnrichmentCache" k on k.cnp = p.cnp and k.persistido = true
      where ${filtros.join("\n        and ")}
      group by p.id, p.cnp, p.designacao, p."productType", p."validadoManualmente",
               p."classificationSource", p."productTypeConfidence", c1.nome, c2.nome, r.cnp,
               p."codigoATC", p.dci, p."formaFarmaceutica", p.dosagem, p.embalagem`,
    ...params,
  );

  const out: LeituraCandidatos = {
    lidos: linhas.length,
    semNada: 0,
    porOrigem: {},
    porFonteOriginal: {},
    porOrigemUtilizacao: {},
    soUtilizacoes: 0,
    clinicaPorCampo: {},
    clinicaPorOrigem: {},
    candidatos: [],
  };

  for (const l of linhas) {
    const slugs = l.utilSlugs ?? [];
    const fontes = l.utilFontes ?? [];
    const confs = l.utilConfs ?? [];
    const temClassificacao = !!l.categoria && ehEspecifica(l.subcategoria);

    // ── Clínica, campo a campo ────────────────────────────────────────
    //
    // Só entram campos COM VALOR. Um campo vazio não vira candidato a
    // null: é assim que se garante, na estrutura e não por disciplina,
    // que um valor em falta nunca apaga o que o global já sabe.
    const clinica: ClinicaCandidata[] = [];
    for (const campo of CAMPOS_CLINICOS) {
      const valorProduto = l[`p${campo}`] ?? null;
      if (!valorProduto || !valorProduto.trim()) continue;
      contar(out.clinicaPorCampo, campo);

      const m = origemDaClinica({
        valorProduto,
        validadoManualmente: l.validadoManualmente,
        valorRegulatorio: l[`r${campo}`] ?? null,
        valorCache: l[`k${campo}`] ?? null,
        cacheOrigem: l.cacheOrigem,
      });
      contar(out.clinicaPorOrigem, m.origem ?? `(nao atribuido) ${m.motivo}`);

      clinica.push({
        campo,
        valor: valorProduto,
        origem: m.origem,
        // A confiança clínica é a do gate clínico (0.90), não a da
        // classificação (0.85). Um valor humano vale 1; um valor sem
        // confiança registada não passa a valer o da classificação —
        // seria misturar duas medidas diferentes — e fica no piso do
        // gate que o deixou entrar.
        confianca: m.origem === "HUMANO" ? 1 : (l.cacheConfClinica ?? LIMIAR_CLINICO),
        versaoRegras: l.cacheVersao ?? opts.versaoRegras,
        motivoOrigem: m.motivo,
      });
    }

    // "Nada a promover" passa a incluir a clínica: um produto sem
    // classificação e sem utilizações pode na mesma trazer um ATC.
    if (!temClassificacao && slugs.length === 0 && clinica.length === 0) { out.semNada++; continue; }
    if (!temClassificacao && slugs.length > 0) out.soUtilizacoes++;

    const mapeada = origemDaClassificacao({
      validadoManualmente: l.validadoManualmente,
      cacheOrigem: l.cacheOrigem,
    });
    const confidence = mapeada.origem === "HUMANO"
      ? 1
      : (l.cacheConfidence ?? l.productTypeConfidence ?? 0.85);

    const utilizacoes: UtilizacaoCandidata[] = slugs.map((slug, i) => {
      const fonte = fontes[i] ?? null;
      const m = origemDaUtilizacao(fonte);
      contar(out.porOrigemUtilizacao, m.origem ?? `(por mapear) ${fonte ?? "null"}`);
      return {
        slug,
        confidence: m.origem === "HUMANO" ? 1 : (confs[i] ?? 0.85),
        origem: m.origem,
        fonteOriginal: fonte,
        motivo: m.motivo,
      };
    });

    contar(out.porOrigem, mapeada.origem ?? `(por mapear) ${mapeada.motivo}`);
    contar(out.porFonteOriginal, l.classificationSource ?? "(sem classificationSource)");

    out.candidatos.push({
      cnp: Number(l.cnp),
      designacaoReferencia: l.designacao,
      productType: l.productType,
      categoria: temClassificacao ? l.categoria : null,
      subcategoria: temClassificacao ? l.subcategoria : null,
      utilizacoes,
      confidence,
      evidenceType: l.cacheEvidence,
      origem: mapeada.origem,
      motivoOrigem: mapeada.motivo,
      fonteOriginal: l.classificationSource,
      versaoRegras: opts.versaoRegras,
      // `verificado` diz que passou a segunda passagem de verificação.
      // Uma regra determinística não passa por lá; uma validação humana
      // dispensa-a. O registo regulamentar, quando existir, também.
      verificado: mapeada.origem === "HUMANO" || mapeada.origem === "REGULATORY",
      tenantOrigem: tenantSlug,
      clinica,
    });
  }

  return out;
}

// ─── Projecção ────────────────────────────────────────────────────────

export type ResumoProjeccao = {
  tenantSlug: string;
  cnpsNoTenant: number;
  cnpsConhecidosGlobal: number;
  classificacoesEscritas: number;
  productTypesEscritos: number;
  utilizacoesEscritas: number;
  noOp: number;
  intocaveis: number;
  revisoesAbertas: number;
  semVocabulario: number;
  /** Campos clínicos escritos no tenant, por campo. */
  clinicaEscrita: Record<string, number>;
  /** Total de campos clínicos escritos. */
  clinicaTotal: number;
  /** Campos que o global tinha e o tenant já tinha preenchidos. */
  clinicaJaPreenchida: number;
  exemplosRevisao: Array<{ cnp: number; global: string; local: string }>;
};

/**
 * Deixa no tenant a marca de que ESTA classificação veio do global.
 *
 * Sem ela, o `bootstrap-global` volta a ler a classificação projectada
 * como se fosse conhecimento local e repromove-a — com a autoridade de
 * uma regra determinística, que é superior à do modelo que a produziu.
 * Um ciclo de lavagem, e silencioso.
 *
 * A marca vive em `KnowledgeEnrichmentCache.origem`, o mesmo sítio onde o
 * runner distingue CLAUDE de PROPAGADO, e é simétrica da que a projecção
 * de utilizações já deixava em `ProdutoUtilizacao.fonte`.
 */
async function marcarComoProjectada(
  prisma: PrismaClient,
  cnp: number,
  designacao: string,
  g: ConhecimentoGlobal,
): Promise<void> {
  const chave = chaveCache(cnp, designacao);
  await prisma.knowledgeEnrichmentCache.upsert({
    where: { chave },
    create: {
      chave,
      cnp,
      designacao,
      versao: g.versaoRegras,
      modelo: FONTE_GLOBAL,
      categoria: g.categoria,
      subcategoria: g.subcategoria,
      productType: g.productType,
      confidence: g.confidence * FATOR_PROJECCAO,
      // Não houve evidência recolhida aqui: isto não foi decidido, foi
      // recebido. Quem decidiu guardou a evidência dele no global.
      evidenceType: FONTE_GLOBAL,
      persistido: true,
      origem: ORIGEM_CACHE_GLOBAL,
    },
    update: { origem: ORIGEM_CACHE_GLOBAL, persistido: true },
  });
}

/**
 * Projecta o conhecimento global para a base de um tenant.
 *
 * Nunca cria classificações nem utilizações que o tenant não tenha: o
 * vocabulário é fechado, e um nome que não exista no destino significa
 * que falta correr o seed, não que se deva inventar a entrada.
 */
export async function projectarParaTenant(
  prisma: PrismaClient,
  tenantSlug: string,
  opts: {
    dryRun?: boolean;
    limite?: number;
    /**
     * Restringe a projecção a estes CNPs.
     *
     * Existe para a importação poder projectar SÓ o lote que acabou de
     * entrar, em vez de varrer o catálogo inteiro a cada upload. A
     * alternativa era uma segunda função com a mesma lógica — e duas
     * cópias da regra de não-degradação acabariam por divergir.
     *
     * Omitido = catálogo todo, que é o comportamento do CLI.
     */
    cnps?: readonly number[];
  } = {},
): Promise<ResumoProjeccao> {
  const dryRun = opts.dryRun ?? true;
  // Lista vazia é diferente de ausente: "projecta estes zero produtos"
  // devolve zero, e não "projecta tudo".
  if (opts.cnps && opts.cnps.length === 0) {
    return {
      tenantSlug, cnpsNoTenant: 0, cnpsConhecidosGlobal: 0,
      classificacoesEscritas: 0, productTypesEscritos: 0, utilizacoesEscritas: 0,
      noOp: 0, intocaveis: 0, revisoesAbertas: 0, semVocabulario: 0,
      clinicaEscrita: {}, clinicaTotal: 0, clinicaJaPreenchida: 0,
      exemplosRevisao: [],
    };
  }
  const r: ResumoProjeccao = {
    tenantSlug,
    cnpsNoTenant: 0,
    cnpsConhecidosGlobal: 0,
    classificacoesEscritas: 0,
    productTypesEscritos: 0,
    utilizacoesEscritas: 0,
    noOp: 0,
    intocaveis: 0,
    revisoesAbertas: 0,
    semVocabulario: 0,
    clinicaEscrita: {},
    clinicaTotal: 0,
    clinicaJaPreenchida: 0,
    exemplosRevisao: [],
  };

  // Estado local, por cnp.
  const produtos = await prisma.$queryRawUnsafe<Array<{
    id: string; cnp: number; designacao: string; validadoManualmente: boolean;
    categoria: string | null; subcategoria: string | null; productType: string | null;
    utilizacoes: string[] | null; fontes: string[] | null; confiancas: number[] | null;
    codigoATC: string | null; dci: string | null; formaFarmaceutica: string | null;
    dosagem: string | null; embalagem: string | null;
  }>>(
    `select p.id, p.cnp, p.designacao, p."validadoManualmente", p."productType",
            p."codigoATC", p.dci, p."formaFarmaceutica", p.dosagem, p.embalagem,
            c1.nome as categoria,
            c2.nome as subcategoria,
            coalesce(array_agg(u.slug)        filter (where u.slug is not null), '{}') as utilizacoes,
            coalesce(array_agg(pu.fonte)      filter (where u.slug is not null), '{}') as fontes,
            coalesce(array_agg(coalesce(pu.confianca, 0)) filter (where u.slug is not null), '{}') as confiancas
       from "Produto" p
       left join "Classificacao" c1 on c1.id = p."classificacaoNivel1Id"
       left join "Classificacao" c2 on c2.id = p."classificacaoNivel2Id"
       left join "ProdutoUtilizacao" pu on pu."produtoId" = p.id
       left join "Utilizacao" u on u.id = pu."utilizacaoId"
      ${opts.cnps ? `where p.cnp = any('{${opts.cnps.map((n) => Number(n) | 0).join(",")}}'::int[])` : ""}
      group by p.id, p.cnp, p.designacao, p."validadoManualmente", p."productType", c1.nome, c2.nome,
               p."codigoATC", p.dci, p."formaFarmaceutica", p.dosagem, p.embalagem`,
  );
  r.cnpsNoTenant = produtos.length;

  const global = await lerConhecimentoGlobal(produtos.map((p) => Number(p.cnp)));
  r.cnpsConhecidosGlobal = global.size;
  if (global.size === 0) return r;

  // Vocabulário local: nomes → ids. Fechado — nada é criado.
  const tax = await prisma.$queryRawUnsafe<Array<{ id: string; nome: string; pai: string | null }>>(
    `select id, nome, "classificacaoPaiId" as pai from "Classificacao" where estado = 'ATIVO'`,
  );
  const n1PorNome = new Map<string, string>();
  const n2PorChave = new Map<string, string>();
  for (const t of tax) if (!t.pai) n1PorNome.set(t.nome.toUpperCase(), t.id);
  for (const t of tax) if (t.pai) n2PorChave.set(`${t.pai}::${t.nome.toUpperCase()}`, t.id);

  const utilVocab = await prisma.$queryRawUnsafe<Array<{ id: string; slug: string }>>(
    `select id, slug from "Utilizacao" where estado = 'ATIVO'`,
  );
  const utilPorSlug = new Map(utilVocab.map((u) => [u.slug, u.id]));

  let feitos = 0;
  for (const p of produtos) {
    if (opts.limite && feitos >= opts.limite) break;
    const cnp = Number(p.cnp);
    const g = global.get(cnp);
    if (!g) continue;

    const slugs = p.utilizacoes ?? [];
    const fontes = p.fontes ?? [];
    const confs = p.confiancas ?? [];
    const local: EstadoLocal = {
      cnp,
      validadoManualmente: p.validadoManualmente,
      categoria: p.categoria,
      subcategoria: p.subcategoria,
      productType: p.productType,
      utilizacoes: slugs.map((slug, i) => ({
        slug,
        fonte: fontes[i] ?? "?",
        confianca: confs[i] ?? null,
      })),
    };

    const d = avaliarProjeccao(g, local);

    // ── CLÍNICA: ANTES dos `continue` da taxonomia ───────────────────
    //
    // Deliberadamente aqui, e não lá em baixo com as escritas de
    // classificação. A decisão da taxonomia para a maior parte dos
    // produtos é NO_OP — o tenant já tem a classificação certa — e um
    // `continue` nesse ramo saltava a clínica de todos eles. O resultado
    // seria o pior possível: a projecção a dizer que correu, e o ATC a
    // não chegar precisamente aos produtos mais bem classificados.
    //
    // A única excepção é INTOCAVEL, que é `validadoManualmente`: aí não
    // se toca em nada, e isso inclui a clínica.
    if (d.accao !== "INTOCAVEL" && g.clinica && g.clinica.size > 0) {
      const localClinica: Record<CampoClinico, string | null> = {
        CODIGO_ATC: p.codigoATC,
        DCI: p.dci,
        FORMA_FARMACEUTICA: p.formaFarmaceutica,
        DOSAGEM: p.dosagem,
        EMBALAGEM: p.embalagem,
      };
      for (const [campo, cg] of g.clinica) {
        // O tenant não guarda a origem de cada campo clínico, portanto
        // não há como PROVAR que o global é superior ao que já lá está.
        // Sem prova, não se substitui: preenche-se a lacuna e mais nada.
        // É a mesma política do runner (`and p."<coluna>" is null`), e é
        // conservadora de propósito — o custo de não preencher é um
        // campo vazio; o de substituir às cegas é apagar informação
        // melhor do que a que entra.
        if (localClinica[campo]) { r.clinicaJaPreenchida++; continue; }
        const valor = validarValorClinico(campo, cg.valor);
        if (!valor) continue;
        if (dryRun) {
          r.clinicaTotal++;
          r.clinicaEscrita[campo] = (r.clinicaEscrita[campo] ?? 0) + 1;
          continue;
        }
        const coluna = COLUNAS_CLINICAS[campo].produto;
        // A guarda repete-se no WHERE, como no runner: entre o SELECT e
        // este UPDATE o estado pode ter mudado, e a garantia tem de
        // viver onde a escrita acontece.
        const n = await prisma.$executeRawUnsafe(
          `update "Produto" p
              set "${coluna}" = $1, "dataAtualizacao" = now()
            where p.cnp = $2
              and p."validadoManualmente" = false
              and p."${coluna}" is null`,
          valor, cnp,
        );
        if (Number(n) > 0) {
          r.clinicaTotal++;
          r.clinicaEscrita[campo] = (r.clinicaEscrita[campo] ?? 0) + 1;
        }
      }
    }

    if (d.accao === "INTOCAVEL") { r.intocaveis++; continue; }
    if (d.accao === "NO_OP") { r.noOp++; continue; }

    if (d.accao === "REVISAO") {
      r.revisoesAbertas++;
      if (r.exemplosRevisao.length < 30 && d.revisao) {
        r.exemplosRevisao.push({ cnp, global: d.revisao.valorGlobal, local: d.revisao.valorLocal });
      }
      if (!dryRun && d.revisao) {
        // Idempotente: uma divergência que já está aberta não gera outra.
        const jaAberta = await controlPrisma.catalogoGlobalRevisao.findFirst({
          where: { cnp, tenantSlug, tipo: d.revisao.tipo, resolvidoEm: null },
          select: { id: true },
        });
        if (!jaAberta) {
          await controlPrisma.catalogoGlobalRevisao.create({
            data: {
              cnp, tenantSlug, tipo: d.revisao.tipo,
              valorGlobal: d.revisao.valorGlobal,
              valorLocal: d.revisao.valorLocal,
              detalhe: d.motivo,
            },
          });
        }
      }
      continue;
    }

    // ── ESCREVER ──────────────────────────────────────────────────────
    feitos++;

    if (g.categoria && ehEspecifica(g.subcategoria) && !ehEspecifica(local.subcategoria)) {
      const n1Id = n1PorNome.get(g.categoria.toUpperCase());
      const n2Id = n1Id ? n2PorChave.get(`${n1Id}::${g.subcategoria!.toUpperCase()}`) : undefined;
      if (!n1Id || !n2Id) {
        r.semVocabulario++;
      } else if (!dryRun) {
        // A não-degradação está escrita outra vez no WHERE, como no
        // runner: mesmo que o estado tenha mudado entre o SELECT e agora,
        // uma subcategoria específica não é sobreposta.
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
          n1Id, n2Id, cnp,
        );
        if (Number(n) > 0) {
          r.classificacoesEscritas++;
          await marcarComoProjectada(prisma, cnp, p.designacao, g);
        }
      } else {
        r.classificacoesEscritas++;
      }
    }

    if (d.escreverProductType && g.productType) {
      if (!dryRun) {
        const n = await prisma.$executeRawUnsafe(
          `update "Produto" p
              set "productType"           = $1,
                  "productTypeConfidence" = $2,
                  "classificationSource"  = $3,
                  "classificationVersion" = $4,
                  "dataAtualizacao"       = now()
            where p.cnp = $5
              and p."validadoManualmente" = false
              and p."productType" is null`,
          g.productType, g.confidence * FATOR_PROJECCAO, TIER_GLOBAL, g.versaoRegras, cnp,
        );
        if (Number(n) > 0) r.productTypesEscritos++;
      } else {
        r.productTypesEscritos++;
      }
    }

    for (const slug of d.utilizacoes) {
      const uid = utilPorSlug.get(slug);
      if (!uid) { r.semVocabulario++; continue; }
      const conf = (g.utilizacoes.find((u) => u.slug === slug)?.confidence ?? 0) * FATOR_PROJECCAO;
      if (!dryRun) {
        const n = await prisma.$executeRawUnsafe(
          `insert into "ProdutoUtilizacao" ("produtoId", "utilizacaoId", fonte, confianca)
           select p.id, $1, $2, $3 from "Produto" p
            where p.cnp = $4 and p."validadoManualmente" = false
           on conflict ("produtoId", "utilizacaoId") do update
              set fonte = excluded.fonte, confianca = excluded.confianca
            where "ProdutoUtilizacao".fonte <> 'MANUAL'
              and excluded.confianca > coalesce("ProdutoUtilizacao".confianca, 0)`,
          uid, FONTE_GLOBAL, conf, cnp,
        );
        r.utilizacoesEscritas += Number(n) || 0;
      } else {
        r.utilizacoesEscritas++;
      }
    }
  }

  return r;
}
