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
import {
  avaliarProjeccao,
  avaliarPromocao,
  ehEspecifica,
  registoPromocao,
  FATOR_PROJECCAO,
  type AprovacaoHumana,
  type ConhecimentoCandidato,
  type ConhecimentoGlobal,
  type EstadoLocal,
  type OrigemGlobal,
} from "./global-catalog";

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
      include: { utilizacoes: true },
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
  promovidos: number;
  recusados: number;
  /**
   * Recusados APENAS por falta de aprovação humana. Passavam tudo o
   * resto — estão à espera de alguém, não reprovados.
   */
  aguardamAprovacao: number;
  motivos: Record<string, number>;
};

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
 * Idempotente: promover o que já lá está com a mesma origem e a mesma
 * confiança não escreve nada — nem na tabela, nem no rasto de auditoria.
 * É `avaliarPromocao` que decide, e ela devolve `false` no empate
 * precisamente para isso.
 */
export async function promoverAoGlobal(
  candidatos: readonly ConhecimentoCandidato[],
  opts: OpcoesPromocao,
): Promise<ResultadoPromocao> {
  const r: ResultadoPromocao = { promovidos: 0, recusados: 0, aguardamAprovacao: 0, motivos: {} };
  if (candidatos.length === 0) return r;

  const actual = await lerConhecimentoGlobal(candidatos.map((c) => c.cnp));
  const agora = new Date();

  for (const c of candidatos) {
    const decisao = avaliarPromocao(c, actual.get(c.cnp) ?? null, { aprovacao: opts.aprovacao });
    r.motivos[decisao.motivo] = (r.motivos[decisao.motivo] ?? 0) + 1;
    if (!decisao.promover) {
      r.recusados++;
      if (decisao.aguardaAprovacao) r.aguardamAprovacao++;
      continue;
    }
    r.promovidos++;
    if (opts.dryRun) continue;

    const registo = registoPromocao(c, decisao, { actor: opts.actor, aprovacao: opts.aprovacao });
    const auditoria = {
      promovidoPor: registo.actor,
      promovidoEm: agora,
      promovidoDeTenant: registo.tenantOrigem,
      promocaoMotivo: registo.motivo,
    };

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
        origem: c.origem,
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
        origem: c.origem,
        versaoRegras: c.versaoRegras,
        verificado: c.verificado,
        ...auditoria,
      },
    });

    // O rasto: append-only, uma linha por promoção que aconteceu.
    await controlPrisma.catalogoGlobalPromocao.create({ data: registo });

    // Utilizações: cada slug tem a sua própria autoridade. Não se apaga o
    // que lá está — um slug que este candidato não traga pode ter vindo
    // de outro tenant que conhece melhor o produto.
    for (const u of c.utilizacoes) {
      await controlPrisma.catalogoGlobalUtilizacao.upsert({
        where: { cnp_slug: { cnp: c.cnp, slug: u.slug } },
        create: { cnp: c.cnp, slug: u.slug, confidence: u.confidence, origem: c.origem, versaoRegras: c.versaoRegras },
        update: { confidence: u.confidence, origem: c.origem, versaoRegras: c.versaoRegras },
      });
    }
  }
  return r;
}

// ─── Candidatos: o que a base de um tenant já sabe ────────────────────

/** Fontes de classificação que valem REGULATORY na promoção. */
const FONTES_FORTES = new Set(["REGULATORY", "MANUFACTURER", "DISTRIBUTOR"]);

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
};

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
  porOrigem: Record<string, number>;
  candidatos: ConhecimentoCandidato[];
};

/**
 * Lê a base de um tenant e monta os candidatos a promoção.
 *
 * A ORIGEM É A MAIS FORTE QUE O PRODUTO JUSTIFICA, e a ordem importa:
 * uma validação manual ganha a tudo o resto; sem ela, uma fonte
 * regulamentar; sem ela, o que o modelo escreveu.
 *
 * Consequência deliberada: um produto validado à mão que TAMBÉM tinha
 * fonte regulamentar sai daqui como HUMANO — e portanto não sobe sem
 * aprovação explícita. Perde-se a promoção automática que a fonte
 * regulamentar daria, e é o comportamento certo: se alguém corrigiu o
 * produto à mão, o valor que lá está é o dessa pessoa, não o do registo.
 *
 * Só lê. Quem escreve é `promoverAoGlobal`.
 */
export async function lerCandidatosDoTenant(
  prisma: PrismaClient,
  tenantSlug: string,
  opts: OpcoesLeituraCandidatos,
): Promise<LeituraCandidatos> {
  const params: unknown[] = [opts.minCnp];
  const filtros = [`p.cnp >= $1`];

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
            max(k.origem)         as "cacheOrigem",
            max(k.confidence)     as "cacheConfidence",
            max(k."evidenceType") as "cacheEvidence"
       from "Produto" p
       left join "Classificacao" c1 on c1.id = p."classificacaoNivel1Id"
       left join "Classificacao" c2 on c2.id = p."classificacaoNivel2Id"
       left join "RegulatoryRecord" r on r.cnp = p.cnp
       left join "ProdutoUtilizacao" pu on pu."produtoId" = p.id
       left join "Utilizacao" u on u.id = pu."utilizacaoId"
       left join "KnowledgeEnrichmentCache" k on k.cnp = p.cnp and k.persistido = true
      where ${filtros.join("\n        and ")}
      group by p.id, p.cnp, p.designacao, p."productType", p."validadoManualmente",
               p."classificationSource", p."productTypeConfidence", c1.nome, c2.nome, r.cnp`,
    ...params,
  );

  const out: LeituraCandidatos = { lidos: linhas.length, semNada: 0, porOrigem: {}, candidatos: [] };

  for (const l of linhas) {
    const slugs = l.utilSlugs ?? [];
    const fontes = l.utilFontes ?? [];
    const confs = l.utilConfs ?? [];
    const temClassificacao = !!l.categoria && ehEspecifica(l.subcategoria);
    if (!temClassificacao && slugs.length === 0) { out.semNada++; continue; }

    let origem: OrigemGlobal;
    let confidence: number;
    if (l.validadoManualmente || fontes.includes("MANUAL")) {
      origem = "HUMANO";
      confidence = 1;
    } else if (FONTES_FORTES.has(l.classificationSource ?? "") || l.temRegulatorio) {
      origem = "REGULATORY";
      confidence = l.productTypeConfidence ?? 0.95;
    } else if (l.cacheOrigem === "PROPAGADO") {
      origem = "PROPAGADO";
      confidence = l.cacheConfidence ?? l.productTypeConfidence ?? 0.85;
    } else if (l.cacheOrigem || l.classificationSource === "MODEL_INFERRED") {
      origem = "MODELO";
      confidence = l.cacheConfidence ?? l.productTypeConfidence ?? 0.85;
    } else {
      // Classificação sem proveniência conhecida: veio das regras
      // determinísticas. Vale como MODELO — é determinística e nossa,
      // mas não é uma fonte externa nem uma decisão humana.
      origem = "MODELO";
      confidence = l.productTypeConfidence ?? 0.85;
    }

    out.porOrigem[origem] = (out.porOrigem[origem] ?? 0) + 1;
    out.candidatos.push({
      cnp: Number(l.cnp),
      designacaoReferencia: l.designacao,
      productType: l.productType,
      categoria: temClassificacao ? l.categoria : null,
      subcategoria: temClassificacao ? l.subcategoria : null,
      utilizacoes: slugs.map((slug, i) => ({
        slug,
        confidence: fontes[i] === "MANUAL" ? 1 : (confs[i] ?? 0.85),
      })),
      confidence,
      evidenceType: l.cacheEvidence,
      origem,
      versaoRegras: opts.versaoRegras,
      verificado: origem === "HUMANO" || origem === "REGULATORY",
      tenantOrigem: tenantSlug,
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
  exemplosRevisao: Array<{ cnp: number; global: string; local: string }>;
};

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
  opts: { dryRun?: boolean; limite?: number } = {},
): Promise<ResumoProjeccao> {
  const dryRun = opts.dryRun ?? true;
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
    exemplosRevisao: [],
  };

  // Estado local, por cnp.
  const produtos = await prisma.$queryRawUnsafe<Array<{
    id: string; cnp: number; validadoManualmente: boolean;
    categoria: string | null; subcategoria: string | null; productType: string | null;
    utilizacoes: string[] | null; fontes: string[] | null; confiancas: number[] | null;
  }>>(
    `select p.id, p.cnp, p."validadoManualmente", p."productType",
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
      group by p.id, p.cnp, p."validadoManualmente", p."productType", c1.nome, c2.nome`,
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
        if (Number(n) > 0) r.classificacoesEscritas++;
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
