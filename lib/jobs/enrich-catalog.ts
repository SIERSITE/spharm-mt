/**
 * lib/jobs/enrich-catalog.ts
 *
 * Lógica programática do ciclo diário de enriquecimento do catálogo,
 * invocada pelo endpoint `/api/jobs/enrich-catalog` (Vercel Cron) e
 * potencialmente reutilizável em scripts CLI.
 *
 * Diferenças face aos scripts pré-existentes (`sync-regulatory-to-produto.ts`
 * e `reprocess-catalog.ts`):
 *
 *   1. Sem hardcoded paths em `scripts/data/*.json` — escolheria CNPs do
 *      JSON de mapping INFOMED original. Para um cron serverless, o JSON
 *      não está disponível e o scope passa a ser TODOS os
 *      `RegulatoryRecord` cuja CNP cruza com um `Produto` vivo.
 *
 *   2. Sem HTTP a connectors externos. Tudo é DB-only:
 *      · Fase 1 (sync):     hidrata `Produto.<campos clínicos>` a partir
 *                           de `RegulatoryRecord` (mesma política do
 *                           script: só preenche se NULL; ignora
 *                           `validadoManualmente=true`).
 *      · Fase 2 (reclassify): recalcula `classificacaoNivel1Id` /
 *                             `classificacaoNivel2Id` para produtos
 *                             MEDICAMENTO ainda em "Outros Medicamentos"
 *                             ou sem nivel2, usando `mapToCanonical()`
 *                             com base nos sinais agora-presentes em
 *                             Produto (designação, ATC, DCI, productType).
 *
 *   3. Limites configuráveis por chamada para caber dentro do
 *      `maxDuration` do plan Vercel. Sem cursor persistente: o ciclo
 *      diário avança ao processar os "piores" candidatos primeiro
 *      (sem ATC → mais provável de melhorar com sync; em Outros
 *      Medicamentos → mais provável de melhorar com reclassify).
 *
 * Idempotente: re-correr produz o mesmo estado quando nada mudou na
 * BD entretanto.
 */

import type { PrismaClient } from "@/generated/prisma/client";
import { mapToCanonical } from "@/lib/catalog-taxonomy-map";

// ─── Tipos públicos ──────────────────────────────────────────────────────

/** Campos clínicos que copiamos de `RegulatoryRecord` → `Produto`. */
const CLINICAL_FIELDS = [
  "codigoATC",
  "dci",
  "formaFarmaceutica",
  "dosagem",
  "embalagem",
] as const;
type ClinicalField = (typeof CLINICAL_FIELDS)[number];

export type SyncRegulatorySummary = {
  /** Produtos lidos da BD (candidatos com algum campo NULL). */
  read: number;
  /** Produtos com pelo menos 1 campo actualizado. */
  updated: number;
  /** Produtos sem `RegulatoryRecord` correspondente. */
  noMatch: number;
  /** Produtos com `validadoManualmente=true` (sempre saltados). */
  skippedManual: number;
  /** Counts por campo. */
  filled: Record<ClinicalField, number>;
  /** Erros de UPDATE por produto. */
  errors: number;
  durationMs: number;
};

export type ReclassifySummary = {
  /** Produtos lidos da BD (em "Outros Medicamentos" ou sem N2). */
  read: number;
  /** Produtos para os quais o mapper devolveu (N1, N2) novo. */
  candidates: number;
  /** Produtos cuja `classificacaoNivel2Id` foi efectivamente actualizada. */
  updated: number;
  /** Produtos onde o mapper devolveu null (sem confiança suficiente). */
  noMapping: number;
  /** Produtos onde o (N1, N2) sugerido não existe na tabela `Classificacao`. */
  classifMissing: number;
  /** Por método do mapper, contagem dos candidates. */
  byMethod: Record<string, number>;
  errors: number;
  durationMs: number;
};

export type EnrichCycleSummary = {
  sync: SyncRegulatorySummary;
  reclassify: ReclassifySummary;
  totalDurationMs: number;
};

// ─── Fase 1: sync RegulatoryRecord → Produto ─────────────────────────────

/**
 * Hidrata campos clínicos em `Produto` a partir do cache `RegulatoryRecord`.
 *
 * Política (mesma do script original):
 *   · Só copia se `Produto.<campo>` é NULL — nunca sobrescreve.
 *   · Ignora `validadoManualmente=true`.
 *   · Só toca em produtos vivos (`estado != INATIVO`).
 *
 * Selecção de candidatos: produtos com pelo menos 1 dos campos clínicos
 * NULL, ordenados por `cnp` ASC para evitar dependência em "qual produto
 * acabou primeiro". `limit` aplica TOP N depois do filtro — em runs
 * diários cabe-se em janelas curtas e o backlog é absorvido em N dias.
 */
export async function syncRegulatoryToProduto(opts: {
  prisma: PrismaClient;
  limit: number;
}): Promise<SyncRegulatorySummary> {
  const t0 = Date.now();
  const { prisma, limit } = opts;

  const summary: SyncRegulatorySummary = {
    read: 0,
    updated: 0,
    noMatch: 0,
    skippedManual: 0,
    filled: { codigoATC: 0, dci: 0, formaFarmaceutica: 0, dosagem: 0, embalagem: 0 },
    errors: 0,
    durationMs: 0,
  };

  // 1. Selecciona candidatos: produtos vivos, não-validados-manualmente,
  // com pelo menos 1 campo clínico NULL.
  const produtos = await prisma.produto.findMany({
    where: {
      estado: { not: "INATIVO" },
      validadoManualmente: false,
      OR: [
        { codigoATC: null },
        { dci: null },
        { formaFarmaceutica: null },
        { dosagem: null },
        { embalagem: null },
      ],
    },
    select: {
      id: true,
      cnp: true,
      codigoATC: true,
      dci: true,
      formaFarmaceutica: true,
      dosagem: true,
      embalagem: true,
    },
    orderBy: { cnp: "asc" },
    take: limit,
  });
  summary.read = produtos.length;
  if (produtos.length === 0) {
    summary.durationMs = Date.now() - t0;
    return summary;
  }

  // 2. Carrega RegulatoryRecord correspondente em batch.
  const cnps = produtos.map((p) => p.cnp);
  const regs = await prisma.regulatoryRecord.findMany({
    where: { cnp: { in: cnps } },
    select: {
      cnp: true,
      codigoATC: true,
      dci: true,
      formaFarmaceutica: true,
      dosagem: true,
      embalagem: true,
    },
  });
  const regByCnp = new Map(regs.map((r) => [r.cnp, r]));

  // 3. Constrói updates só com campos NULL no produto E não-NULL no RR.
  for (const p of produtos) {
    const r = regByCnp.get(p.cnp);
    if (!r) {
      summary.noMatch++;
      continue;
    }
    const data: Partial<Record<ClinicalField, string>> = {};
    for (const f of CLINICAL_FIELDS) {
      if (p[f] == null && r[f] != null) {
        data[f] = r[f] as string;
      }
    }
    if (Object.keys(data).length === 0) continue;

    try {
      await prisma.produto.update({ where: { id: p.id }, data });
      summary.updated++;
      for (const f of CLINICAL_FIELDS) {
        if (data[f] != null) summary.filled[f]++;
      }
    } catch {
      summary.errors++;
    }
  }

  summary.durationMs = Date.now() - t0;
  return summary;
}

// ─── Fase 2: reclassify via mapToCanonical() ─────────────────────────────

/** Cache de `Classificacao.id` por (nivel, nome). Construído por tenant. */
type ClassifIndex = {
  byNivel1: Map<string, string>; // nome → id
  byNivel2ByNivel1: Map<string, Map<string, string>>; // nivel1 → (nome → id)
};

async function buildClassifIndex(prisma: PrismaClient): Promise<ClassifIndex> {
  // Lê NIVEL_1 (lookup directo por nome) + NIVEL_2 com `classificacaoPai`
  // para indexar por (parentNome → filhoNome) sem segunda round-trip.
  const rows = await prisma.classificacao.findMany({
    where: { estado: "ATIVO" },
    select: {
      id: true,
      nome: true,
      tipo: true,
      classificacaoPaiId: true,
      classificacaoPai: { select: { nome: true } },
    },
  });
  const byNivel1 = new Map<string, string>();
  const byNivel2ByNivel1 = new Map<string, Map<string, string>>();
  for (const r of rows) {
    if (r.tipo === "NIVEL_1") {
      byNivel1.set(r.nome, r.id);
    } else if (r.tipo === "NIVEL_2" && r.classificacaoPai) {
      const parentName = r.classificacaoPai.nome;
      let inner = byNivel2ByNivel1.get(parentName);
      if (!inner) {
        inner = new Map();
        byNivel2ByNivel1.set(parentName, inner);
      }
      inner.set(r.nome, r.id);
    }
  }
  return { byNivel1, byNivel2ByNivel1 };
}

/**
 * Recalcula `classificacaoNivel1Id` / `classificacaoNivel2Id` para
 * produtos MEDICAMENTO que estão em "Outros Medicamentos" OU sem N2,
 * usando `mapToCanonical()`. Não invoca HTTP nem connectors externos —
 * usa só os sinais já presentes no `Produto` (designação, ATC, DCI,
 * productType + confidence).
 *
 * Selecciona com prioridade os produtos onde o mapping é mais provável:
 *   · MEDICAMENTO ATIVO + validadoManualmente=false
 *   · COM `codigoATC` OU `dci` (sem sinal clínico, o mapper devolve null)
 *   · Em "Outros Medicamentos" OU sem N2
 *
 * Atualiza só quando o (N1, N2) sugerido difere do actual E existe na
 * `Classificacao`. Não toca em produtos sem mapping (confidence baixa).
 */
export async function reclassifyByCanonicalMapping(opts: {
  prisma: PrismaClient;
  limit: number;
}): Promise<ReclassifySummary> {
  const t0 = Date.now();
  const { prisma, limit } = opts;

  const summary: ReclassifySummary = {
    read: 0,
    candidates: 0,
    updated: 0,
    noMapping: 0,
    classifMissing: 0,
    byMethod: {},
    errors: 0,
    durationMs: 0,
  };

  // Identifica o id de "Outros Medicamentos" (N2 ATIVO). Se não existe,
  // a Fase 2 fica vazia — a taxonomy precisa de seed primeiro.
  const outrosRow = await prisma.classificacao.findFirst({
    where: { tipo: "NIVEL_2", estado: "ATIVO", nome: "Outros Medicamentos" },
    select: { id: true },
  });
  const outrosId = outrosRow?.id ?? null;

  const classifIndex = await buildClassifIndex(prisma);

  // Selecciona candidatos: MEDICAMENTO + ATIVO + não-validado + com ATC ou DCI
  // + em "Outros Medicamentos" ou sem N2.
  const candidates = await prisma.produto.findMany({
    where: {
      productType: "MEDICAMENTO",
      validadoManualmente: false,
      estado: { not: "INATIVO" },
      cnp: { gt: 2_000_000 },
      OR: [
        { codigoATC: { not: null } },
        { dci: { not: null } },
      ],
      AND: [
        outrosId
          ? { OR: [{ classificacaoNivel2Id: outrosId }, { classificacaoNivel2Id: null }] }
          : { classificacaoNivel2Id: null },
      ],
    },
    select: {
      id: true,
      cnp: true,
      designacao: true,
      productType: true,
      productTypeConfidence: true,
      codigoATC: true,
      dci: true,
      tipoArtigo: true,
      classificacaoNivel1Id: true,
      classificacaoNivel2Id: true,
    },
    orderBy: { cnp: "asc" },
    take: limit,
  });
  summary.read = candidates.length;
  if (candidates.length === 0) {
    summary.durationMs = Date.now() - t0;
    return summary;
  }

  for (const p of candidates) {
    let mapping;
    try {
      mapping = mapToCanonical({
        productType: (p.productType ?? "OUTRO") as Parameters<typeof mapToCanonical>[0]["productType"],
        productTypeConfidence: p.productTypeConfidence ?? 0.5,
        externalCategory: null, // não disponível neste contexto DB-only
        externalSubcategory: null,
        designacao: p.designacao,
        atc: p.codigoATC,
        dci: p.dci,
      });
    } catch {
      summary.errors++;
      continue;
    }

    if (!mapping) {
      summary.noMapping++;
      continue;
    }
    summary.candidates++;
    summary.byMethod[mapping.method] = (summary.byMethod[mapping.method] ?? 0) + 1;

    const n1Id = classifIndex.byNivel1.get(mapping.nivel1);
    const n2Id = classifIndex.byNivel2ByNivel1.get(mapping.nivel1)?.get(mapping.nivel2);
    if (!n1Id || !n2Id) {
      summary.classifMissing++;
      continue;
    }

    // No-op quando o mapping não muda nada.
    if (p.classificacaoNivel1Id === n1Id && p.classificacaoNivel2Id === n2Id) {
      continue;
    }

    try {
      await prisma.produto.update({
        where: { id: p.id },
        data: { classificacaoNivel1Id: n1Id, classificacaoNivel2Id: n2Id },
      });
      summary.updated++;
    } catch {
      summary.errors++;
    }
  }

  summary.durationMs = Date.now() - t0;
  return summary;
}

// ─── Orquestrador ────────────────────────────────────────────────────────

/**
 * Corre o ciclo completo (sync + reclassify) num tenant. Sequencial:
 * o reclassify beneficia do sync ter corrido primeiro (mais produtos
 * com ATC/DCI ⇒ mais candidates para o mapper).
 *
 * Limites default (1000 + 500) dimensionados para caber em <60 s por
 * tenant em Neon morno; em 5 tenants × 1 min ≈ 5 min totais, dentro
 * do `maxDuration=300s` do plan Hobby. Caller pode reduzir.
 */
export async function runEnrichCycle(opts: {
  prisma: PrismaClient;
  syncLimit?: number;
  reclassifyLimit?: number;
}): Promise<EnrichCycleSummary> {
  const t0 = Date.now();
  const sync = await syncRegulatoryToProduto({
    prisma: opts.prisma,
    limit: opts.syncLimit ?? 1000,
  });
  const reclassify = await reclassifyByCanonicalMapping({
    prisma: opts.prisma,
    limit: opts.reclassifyLimit ?? 500,
  });
  return { sync, reclassify, totalDurationMs: Date.now() - t0 };
}
