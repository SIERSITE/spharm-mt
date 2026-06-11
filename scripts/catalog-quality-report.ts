/**
 * scripts/catalog-quality-report.ts
 *
 * Diagnóstico read-only do catálogo pós-enrichment.
 * Não escreve nada na BD. Exporta um snapshot em markdown para
 * `notes/catalog-quality-report.md`.
 *
 * Secções:
 *   1. Totais (Produto, MEDICAMENTO, cobertura de campos clínicos)
 *   2. Regulatory coverage (RegulatoryRecord, intersecção com Produto)
 *   3. Qualidade da classificação (nivel2 distribution, top ATC, rule gaps)
 *   4. Before/after vs baseline conhecido (6195 → actual)
 *
 * Uso:
 *   npx tsx scripts/catalog-quality-report.ts
 *
 * O markdown é regenerado em cada run com o estado actual da BD.
 */

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { legacyPrisma as prisma } from "../lib/prisma";
import { Prisma } from "../generated/prisma/client";

const REPORT_PATH = path.resolve("notes/catalog-quality-report.md");
const BASELINE_OUTROS = 6195;

// Hoisted: `pct` é usado por gather*() acima da sua declaração original.
function pct(n: number, d: number): string {
  if (d === 0) return "—";
  return `${((n / d) * 100).toFixed(1)}%`;
}

type SectionTotals = {
  totalVivos: number;
  totalMedicamento: number;
  totalMedicamentoVivos: number;
  outrosMedicamentos: number;
  comATC: number;
  comDCI: number;
  comForma: number;
  comDosagem: number;
  comEmbalagem: number;
  comImagem: number;
  validadoManualmente: number;
};

/**
 * Cobertura para o universo NÃO-MEDICAMENTO (cosmética, suplementos,
 * dispositivos, alimentar, OUTRO). Adicionado em 2026-06 para suportar o
 * pipeline D (retail enrichment) — sem isto, não havia visibilidade sobre
 * 49% do catálogo.
 *
 * Bucket "totalNaoMedicamento" inclui todos os productType ≠ MEDICAMENTO
 * (incluindo NULL, tratado como "sem classificação").
 */
type SectionNaoMedicamento = {
  totalNaoMedicamento: number;
  porType: Array<{ productType: string; n: number; pct: string }>;
  comNivel2: number;
  comMarca: number;
  comDescricaoRica: number; // designacao com > 30 chars (heurística simples)
  comImagem: number;
  semClassificacao: number; // productType IS NULL OR classificacaoNivel2 IS NULL
  validadoManualmente: number;
};

/**
 * Cobertura de imagens cross-cutting. Resume o estado do pipeline C
 * (imagens medicamentos + retail) num único bloco para o dashboard
 * conseguir mostrar o KPI sem agregar a partir das outras secções.
 */
type SectionImagens = {
  totalVivos: number;
  comImagem: number;
  semImagem: number;
  comImagemMedicamento: number;
  comImagemNaoMedicamento: number;
};

type SectionRegulatory = {
  totalRR: number;
  rrComATC: number;
  rrComDCI: number;
  rrComForma: number;
  rrComDosagem: number;
  rrComEmbalagem: number;
  rrComGrupo: number;
  rrComTitular: number;
  rrComEstado: number;
  intersect: number;
  produtoComRRClinico: number;
};

type SectionClassification = {
  nivel2Distribution: Array<{ nivel2: string; n: number; pct: string }>;
  topAtcPrefixes: Array<{ prefix: string; n: number; topNivel2: string }>;
  ruleGapsByPrefix: Array<{ prefix: string; n: number; sample: string; known: boolean }>;
  totalRuleGaps: number;
};

type Report = {
  generatedAt: string;
  totals: SectionTotals;
  naoMedicamento: SectionNaoMedicamento;
  imagens: SectionImagens;
  regulatory: SectionRegulatory;
  classification: SectionClassification;
  baseline: { outrosBefore: number; outrosNow: number; delta: number; pct: string };
};

const KNOWN_GAPS = new Set([
  "J01", "J02", "J04", "J05", "J06", "J07",
  "M05",
  "N01",
  "A11", "A12", "A16",
  "B02", "B03",
  "H03",
  "L01",
  "P01", "P03",
  "V03", "V04", "V06", "V07", "V08", "V09", "V10",
]);

async function gatherTotals(): Promise<SectionTotals> {
  const livesFilter = { estado: { not: "INATIVO" as const } };
  const medFilter = { productType: "MEDICAMENTO" as const, ...livesFilter };

  const [
    totalVivos,
    totalMedicamento,
    totalMedicamentoVivos,
    outrosId,
  ] = await Promise.all([
    prisma.produto.count({ where: livesFilter }),
    prisma.produto.count({ where: { productType: "MEDICAMENTO" } }),
    prisma.produto.count({ where: medFilter }),
    prisma.classificacao
      .findFirst({
        where: { tipo: "NIVEL_2", nome: { equals: "Outros Medicamentos", mode: "insensitive" } },
        select: { id: true },
      })
      .then((r) => r?.id ?? null),
  ]);

  const [
    outrosMedicamentos,
    comATC,
    comDCI,
    comForma,
    comDosagem,
    comEmbalagem,
    comImagem,
    validadoManualmente,
  ] = await Promise.all([
    outrosId
      ? prisma.produto.count({
          where: { ...medFilter, classificacaoNivel2Id: outrosId },
        })
      : Promise.resolve(0),
    prisma.produto.count({ where: { ...medFilter, codigoATC: { not: null } } }),
    prisma.produto.count({ where: { ...medFilter, dci: { not: null } } }),
    prisma.produto.count({ where: { ...medFilter, formaFarmaceutica: { not: null } } }),
    prisma.produto.count({ where: { ...medFilter, dosagem: { not: null } } }),
    prisma.produto.count({ where: { ...medFilter, embalagem: { not: null } } }),
    prisma.produto.count({ where: { ...medFilter, imagemUrl: { not: null } } }),
    prisma.produto.count({ where: { ...medFilter, validadoManualmente: true } }),
  ]);

  return {
    totalVivos,
    totalMedicamento,
    totalMedicamentoVivos,
    outrosMedicamentos,
    comATC,
    comDCI,
    comForma,
    comDosagem,
    comEmbalagem,
    comImagem,
    validadoManualmente,
  };
}

async function gatherRegulatory(): Promise<SectionRegulatory> {
  const [
    totalRR,
    rrComATC,
    rrComDCI,
    rrComForma,
    rrComDosagem,
    rrComEmbalagem,
    rrComGrupo,
    rrComTitular,
    rrComEstado,
  ] = await Promise.all([
    prisma.regulatoryRecord.count(),
    prisma.regulatoryRecord.count({ where: { codigoATC: { not: null } } }),
    prisma.regulatoryRecord.count({ where: { dci: { not: null } } }),
    prisma.regulatoryRecord.count({ where: { formaFarmaceutica: { not: null } } }),
    prisma.regulatoryRecord.count({ where: { dosagem: { not: null } } }),
    prisma.regulatoryRecord.count({ where: { embalagem: { not: null } } }),
    prisma.regulatoryRecord.count({ where: { grupoTerapeutico: { not: null } } }),
    prisma.regulatoryRecord.count({ where: { titularAim: { not: null } } }),
    prisma.regulatoryRecord.count({ where: { estadoAim: { not: null } } }),
  ]);

  // Intersect: produtos vivos com cnp existente em RegulatoryRecord
  const produtoCnps = (
    await prisma.produto.findMany({
      where: { cnp: { gt: 2_000_000 }, estado: { not: "INATIVO" } },
      select: { cnp: true },
    })
  ).map((p) => p.cnp);

  // Limita 'in:' para listas razoáveis; chunked count para grandes listas
  let intersect = 0;
  const CHUNK = 10_000;
  for (let i = 0; i < produtoCnps.length; i += CHUNK) {
    const slice = produtoCnps.slice(i, i + CHUNK);
    intersect += await prisma.regulatoryRecord.count({ where: { cnp: { in: slice } } });
  }

  // Produto vivos com RR clínico (ATC ou DCI populado em RR)
  let produtoComRRClinico = 0;
  for (let i = 0; i < produtoCnps.length; i += CHUNK) {
    const slice = produtoCnps.slice(i, i + CHUNK);
    produtoComRRClinico += await prisma.regulatoryRecord.count({
      where: {
        cnp: { in: slice },
        OR: [{ codigoATC: { not: null } }, { dci: { not: null } }],
      },
    });
  }

  return {
    totalRR,
    rrComATC,
    rrComDCI,
    rrComForma,
    rrComDosagem,
    rrComEmbalagem,
    rrComGrupo,
    rrComTitular,
    rrComEstado,
    intersect,
    produtoComRRClinico,
  };
}

// ── Não-medicamentos ────────────────────────────────────────────────────
//
// Cobertura do universo não-MEDICAMENTO. Heurística "descrição rica":
// designacao > 30 chars — o ERP costuma truncar nomes a 30-40 chars, e
// produtos enriquecidos por retail trazem nomes mais completos.
async function gatherNaoMedicamento(): Promise<SectionNaoMedicamento> {
  const livesFilter = { estado: { not: "INATIVO" as const } };
  const naoMedFilter: Prisma.ProdutoWhereInput = {
    ...livesFilter,
    OR: [
      { productType: { not: "MEDICAMENTO" } },
      { productType: null },
    ],
  };

  const [
    totalNaoMedicamento,
    porTypeGroup,
    comNivel2,
    comMarca,
    comDescricaoRica,
    comImagem,
    semClassificacao,
    validadoManualmente,
  ] = await Promise.all([
    prisma.produto.count({ where: naoMedFilter }),
    prisma.produto.groupBy({
      by: ["productType"],
      where: naoMedFilter,
      _count: { _all: true },
    }),
    prisma.produto.count({
      where: { ...naoMedFilter, classificacaoNivel2Id: { not: null } },
    }),
    prisma.produto.count({
      where: { ...naoMedFilter, fabricanteId: { not: null } },
    }),
    prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT COUNT(*)::bigint AS n
      FROM "Produto"
      WHERE "estado" != 'INATIVO'
        AND ("productType" IS NULL OR "productType" != 'MEDICAMENTO')
        AND LENGTH("designacao") > 30
    `.then((r) => Number(r[0]?.n ?? 0)),
    prisma.produto.count({
      where: { ...naoMedFilter, imagemUrl: { not: null } },
    }),
    prisma.produto.count({
      where: {
        ...naoMedFilter,
        OR: [{ productType: null }, { classificacaoNivel2Id: null }],
      },
    }),
    prisma.produto.count({
      where: { ...naoMedFilter, validadoManualmente: true },
    }),
  ]);

  const porType = porTypeGroup
    .map((g) => ({
      productType: g.productType ?? "(NULL)",
      n: g._count._all,
      pct: pct(g._count._all, totalNaoMedicamento),
    }))
    .sort((a, b) => b.n - a.n);

  return {
    totalNaoMedicamento,
    porType,
    comNivel2,
    comMarca,
    comDescricaoRica,
    comImagem,
    semClassificacao,
    validadoManualmente,
  };
}

// ── Imagens (cross-cutting) ─────────────────────────────────────────────
async function gatherImagens(): Promise<SectionImagens> {
  const livesFilter = { estado: { not: "INATIVO" as const } };

  const [totalVivos, comImagem, comImagemMedicamento, comImagemNaoMedicamento] = await Promise.all([
    prisma.produto.count({ where: livesFilter }),
    prisma.produto.count({ where: { ...livesFilter, imagemUrl: { not: null } } }),
    prisma.produto.count({
      where: { ...livesFilter, productType: "MEDICAMENTO", imagemUrl: { not: null } },
    }),
    prisma.produto.count({
      where: {
        ...livesFilter,
        OR: [{ productType: { not: "MEDICAMENTO" } }, { productType: null }],
        imagemUrl: { not: null },
      },
    }),
  ]);

  return {
    totalVivos,
    comImagem,
    semImagem: totalVivos - comImagem,
    comImagemMedicamento,
    comImagemNaoMedicamento,
  };
}

async function gatherClassification(): Promise<SectionClassification> {
  const medLive = { productType: "MEDICAMENTO" as const, estado: { not: "INATIVO" as const } };

  // Distribuição nivel2 entre MEDICAMENTO vivos
  const groupedN2 = await prisma.produto.groupBy({
    by: ["classificacaoNivel2Id"],
    where: medLive,
    _count: { _all: true },
  });
  const classifIds = groupedN2
    .map((g) => g.classificacaoNivel2Id)
    .filter((id): id is string => id !== null);
  const classifMap = new Map(
    (
      await prisma.classificacao.findMany({
        where: { id: { in: classifIds } },
        select: { id: true, nome: true },
      })
    ).map((c) => [c.id, c.nome]),
  );
  const totalMedLive = groupedN2.reduce((a, g) => a + g._count._all, 0);
  const nivel2Distribution = groupedN2
    .map((g) => ({
      nivel2: g.classificacaoNivel2Id ? classifMap.get(g.classificacaoNivel2Id) ?? "(?)" : "(sem nivel2)",
      n: g._count._all,
      pct: ((g._count._all / totalMedLive) * 100).toFixed(1) + "%",
    }))
    .sort((a, b) => b.n - a.n);

  // Top 20 ATC prefixes (3 chars) entre MEDICAMENTO vivos com ATC
  const withAtc = await prisma.produto.findMany({
    where: { ...medLive, codigoATC: { not: null } },
    select: {
      codigoATC: true,
      classificacaoNivel2: { select: { nome: true } },
    },
  });
  const prefBucket: Record<string, { count: number; n2: Record<string, number> }> = {};
  for (const p of withAtc) {
    const atc = p.codigoATC ?? "";
    if (atc.length < 3) continue;
    const k = atc.slice(0, 3);
    if (!prefBucket[k]) prefBucket[k] = { count: 0, n2: {} };
    prefBucket[k].count++;
    const n2 = p.classificacaoNivel2?.nome ?? "(sem nivel2)";
    prefBucket[k].n2[n2] = (prefBucket[k].n2[n2] ?? 0) + 1;
  }
  const topAtcPrefixes = Object.entries(prefBucket)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 20)
    .map(([prefix, v]) => {
      const top = Object.entries(v.n2).sort((a, b) => b[1] - a[1])[0];
      return { prefix, n: v.count, topNivel2: top ? `${top[0]} (${top[1]})` : "?" };
    });

  // Rule gaps: MEDICAMENTO em Outros Medicamentos com ATC populado
  const outrosId = (
    await prisma.classificacao.findFirst({
      where: { tipo: "NIVEL_2", nome: { equals: "Outros Medicamentos", mode: "insensitive" } },
      select: { id: true },
    })
  )?.id;
  let ruleGapsByPrefix: SectionClassification["ruleGapsByPrefix"] = [];
  let totalRuleGaps = 0;
  if (outrosId) {
    const gaps = await prisma.produto.findMany({
      where: {
        ...medLive,
        classificacaoNivel2Id: outrosId,
        codigoATC: { not: null },
      },
      select: { codigoATC: true, dci: true, designacao: true },
    });
    totalRuleGaps = gaps.length;
    const byPref: Record<string, { count: number; sample: string }> = {};
    for (const g of gaps) {
      const atc = g.codigoATC ?? "";
      if (atc.length < 3) continue;
      const k = atc.slice(0, 3);
      if (!byPref[k]) {
        byPref[k] = {
          count: 0,
          sample: g.dci ?? g.designacao?.slice(0, 30) ?? "",
        };
      }
      byPref[k].count++;
    }
    ruleGapsByPrefix = Object.entries(byPref)
      .sort((a, b) => b[1].count - a[1].count)
      .map(([prefix, v]) => ({
        prefix,
        n: v.count,
        sample: v.sample,
        known: KNOWN_GAPS.has(prefix),
      }));
  }

  return {
    nivel2Distribution,
    topAtcPrefixes,
    ruleGapsByPrefix,
    totalRuleGaps,
  };
}

function renderMarkdown(r: Report): string {
  const t = r.totals;
  const reg = r.regulatory;
  const c = r.classification;
  const b = r.baseline;

  const lines: string[] = [];
  lines.push("# Catalog Quality Report");
  lines.push("");
  lines.push(`**Gerado em:** ${r.generatedAt}`);
  lines.push(`**Origem:** read-only snapshot de \`Produto\` + \`RegulatoryRecord\` + \`Classificacao\``);
  lines.push("");

  // ── 1. Totais ────────────────────────────────────────────────────────────
  lines.push("## 1. Totais");
  lines.push("");
  lines.push("| Métrica | Valor |");
  lines.push("|---|---:|");
  lines.push(`| Produto vivos (estado ≠ INATIVO) | ${t.totalVivos.toLocaleString()} |`);
  lines.push(`| MEDICAMENTO (todos) | ${t.totalMedicamento.toLocaleString()} |`);
  lines.push(`| MEDICAMENTO vivos | ${t.totalMedicamentoVivos.toLocaleString()} |`);
  lines.push(`| MEDICAMENTO em "Outros Medicamentos" | ${t.outrosMedicamentos.toLocaleString()} (${pct(t.outrosMedicamentos, t.totalMedicamentoVivos)}) |`);
  lines.push(`| MEDICAMENTO com codigoATC | ${t.comATC.toLocaleString()} (${pct(t.comATC, t.totalMedicamentoVivos)}) |`);
  lines.push(`| MEDICAMENTO com dci | ${t.comDCI.toLocaleString()} (${pct(t.comDCI, t.totalMedicamentoVivos)}) |`);
  lines.push(`| MEDICAMENTO com formaFarmaceutica | ${t.comForma.toLocaleString()} (${pct(t.comForma, t.totalMedicamentoVivos)}) |`);
  lines.push(`| MEDICAMENTO com dosagem | ${t.comDosagem.toLocaleString()} (${pct(t.comDosagem, t.totalMedicamentoVivos)}) |`);
  lines.push(`| MEDICAMENTO com embalagem | ${t.comEmbalagem.toLocaleString()} (${pct(t.comEmbalagem, t.totalMedicamentoVivos)}) |`);
  lines.push(`| MEDICAMENTO com imagemUrl | ${t.comImagem.toLocaleString()} (${pct(t.comImagem, t.totalMedicamentoVivos)}) |`);
  lines.push(`| MEDICAMENTO validadoManualmente=true | ${t.validadoManualmente.toLocaleString()} (${pct(t.validadoManualmente, t.totalMedicamentoVivos)}) |`);
  lines.push("");

  // ── 1b. Não-medicamentos ────────────────────────────────────────────────
  const nm = r.naoMedicamento;
  lines.push("## 1b. Não-medicamentos (cosmética, suplementos, dispositivos, alimentar, OUTRO)");
  lines.push("");
  lines.push("| Métrica | Valor |");
  lines.push("|---|---:|");
  lines.push(`| Total não-medicamento vivos | ${nm.totalNaoMedicamento.toLocaleString()} |`);
  lines.push(`| Com classificação N2 | ${nm.comNivel2.toLocaleString()} (${pct(nm.comNivel2, nm.totalNaoMedicamento)}) |`);
  lines.push(`| Com fabricante/marca | ${nm.comMarca.toLocaleString()} (${pct(nm.comMarca, nm.totalNaoMedicamento)}) |`);
  lines.push(`| Com designação rica (>30 chars) | ${nm.comDescricaoRica.toLocaleString()} (${pct(nm.comDescricaoRica, nm.totalNaoMedicamento)}) |`);
  lines.push(`| Com imagem | ${nm.comImagem.toLocaleString()} (${pct(nm.comImagem, nm.totalNaoMedicamento)}) |`);
  lines.push(`| **Sem classificação** (productType OU N2 NULL) | **${nm.semClassificacao.toLocaleString()}** (${pct(nm.semClassificacao, nm.totalNaoMedicamento)}) |`);
  lines.push(`| Validado manualmente | ${nm.validadoManualmente.toLocaleString()} (${pct(nm.validadoManualmente, nm.totalNaoMedicamento)}) |`);
  lines.push("");
  lines.push("### Distribuição por productType");
  lines.push("");
  lines.push("| productType | N | % |");
  lines.push("|---|---:|---:|");
  for (const row of nm.porType) {
    lines.push(`| ${row.productType} | ${row.n.toLocaleString()} | ${row.pct} |`);
  }
  lines.push("");

  // ── 1c. Imagens (cross-cutting) ─────────────────────────────────────────
  const im = r.imagens;
  lines.push("## 1c. Imagens (cross-cutting)");
  lines.push("");
  lines.push("| Métrica | Valor |");
  lines.push("|---|---:|");
  lines.push(`| Total Produto vivo | ${im.totalVivos.toLocaleString()} |`);
  lines.push(`| Com imagem | ${im.comImagem.toLocaleString()} (${pct(im.comImagem, im.totalVivos)}) |`);
  lines.push(`| **Sem imagem** | **${im.semImagem.toLocaleString()}** (${pct(im.semImagem, im.totalVivos)}) |`);
  lines.push(`| Com imagem — MEDICAMENTO | ${im.comImagemMedicamento.toLocaleString()} |`);
  lines.push(`| Com imagem — não-medicamento | ${im.comImagemNaoMedicamento.toLocaleString()} |`);
  lines.push("");

  // ── 2. Regulatory coverage ──────────────────────────────────────────────
  lines.push("## 2. Regulatory coverage");
  lines.push("");
  lines.push("| Métrica | Valor |");
  lines.push("|---|---:|");
  lines.push(`| Total RegulatoryRecord | ${reg.totalRR.toLocaleString()} |`);
  lines.push(`| RR com codigoATC | ${reg.rrComATC.toLocaleString()} (${pct(reg.rrComATC, reg.totalRR)}) |`);
  lines.push(`| RR com dci | ${reg.rrComDCI.toLocaleString()} (${pct(reg.rrComDCI, reg.totalRR)}) |`);
  lines.push(`| RR com formaFarmaceutica | ${reg.rrComForma.toLocaleString()} (${pct(reg.rrComForma, reg.totalRR)}) |`);
  lines.push(`| RR com dosagem | ${reg.rrComDosagem.toLocaleString()} (${pct(reg.rrComDosagem, reg.totalRR)}) |`);
  lines.push(`| RR com embalagem | ${reg.rrComEmbalagem.toLocaleString()} (${pct(reg.rrComEmbalagem, reg.totalRR)}) |`);
  lines.push(`| RR com grupoTerapeutico | ${reg.rrComGrupo.toLocaleString()} (${pct(reg.rrComGrupo, reg.totalRR)}) |`);
  lines.push(`| RR com titularAim | ${reg.rrComTitular.toLocaleString()} (${pct(reg.rrComTitular, reg.totalRR)}) |`);
  lines.push(`| RR com estadoAim | ${reg.rrComEstado.toLocaleString()} (${pct(reg.rrComEstado, reg.totalRR)}) |`);
  lines.push(`| **RegulatoryRecord ∩ Produto vivos (cnp match)** | **${reg.intersect.toLocaleString()}** |`);
  lines.push(`| **Produto vivos com RR clínico (ATC ou DCI)** | **${reg.produtoComRRClinico.toLocaleString()}** |`);
  lines.push("");

  // ── 3. Qualidade da classificação ────────────────────────────────────────
  lines.push("## 3. Qualidade da classificação");
  lines.push("");
  lines.push("### Distribuição MEDICAMENTO vivos por nivel2");
  lines.push("");
  lines.push("| Nivel2 | N | % |");
  lines.push("|---|---:|---:|");
  for (const row of c.nivel2Distribution) {
    lines.push(`| ${row.nivel2} | ${row.n.toLocaleString()} | ${row.pct} |`);
  }
  lines.push("");

  lines.push("### Top 20 ATC prefixes (MEDICAMENTO vivos com ATC)");
  lines.push("");
  lines.push("| ATC prefix | N | Nivel2 dominante (N) |");
  lines.push("|---|---:|---|");
  for (const row of c.topAtcPrefixes) {
    lines.push(`| ${row.prefix} | ${row.n} | ${row.topNivel2} |`);
  }
  lines.push("");

  lines.push(`### Rule gaps — MEDICAMENTO em "Outros Medicamentos" com ATC (total: ${c.totalRuleGaps})`);
  lines.push("");
  if (c.ruleGapsByPrefix.length === 0) {
    lines.push("_Sem rule gaps activos._");
  } else {
    lines.push("| ATC prefix | N | Tipo | Sample DCI/designação |");
    lines.push("|---|---:|---|---|");
    for (const row of c.ruleGapsByPrefix) {
      const tipo = row.known ? "known" : "**NEW**";
      lines.push(`| ${row.prefix} | ${row.n} | ${tipo} | ${row.sample} |`);
    }
  }
  lines.push("");

  // ── 4. Before/after ──────────────────────────────────────────────────────
  lines.push("## 4. Before / after vs baseline");
  lines.push("");
  lines.push("| | Valor |");
  lines.push("|---|---:|");
  lines.push(`| Baseline "Outros Medicamentos" (pré-pipeline) | ${b.outrosBefore.toLocaleString()} |`);
  lines.push(`| Actual "Outros Medicamentos" (live) | ${b.outrosNow.toLocaleString()} |`);
  lines.push(`| Delta absoluto | ${b.delta.toLocaleString()} |`);
  lines.push(`| Delta percentual | ${b.pct} |`);
  lines.push("");

  lines.push("---");
  lines.push("");
  lines.push(`_Regenerar este relatório: \`npx tsx scripts/catalog-quality-report.ts\`_`);
  lines.push("");

  return lines.join("\n");
}

async function main(): Promise<void> {
  console.log("─".repeat(74));
  console.log("Catalog quality report — read-only diagnostic");
  console.log("─".repeat(74));

  console.log("\n[1/5] Totais...");
  const totals = await gatherTotals();
  console.log(`  produtos vivos:              ${totals.totalVivos}`);
  console.log(`  MEDICAMENTO vivos:           ${totals.totalMedicamentoVivos}`);
  console.log(`  em "Outros Medicamentos":    ${totals.outrosMedicamentos}`);

  console.log("\n[2/5] Não-medicamentos...");
  const naoMedicamento = await gatherNaoMedicamento();
  console.log(`  não-medicamento vivos:       ${naoMedicamento.totalNaoMedicamento}`);
  console.log(`  com nivel2:                  ${naoMedicamento.comNivel2}`);
  console.log(`  com imagem:                  ${naoMedicamento.comImagem}`);
  console.log(`  sem classificação:           ${naoMedicamento.semClassificacao}`);

  console.log("\n[3/5] Imagens...");
  const imagens = await gatherImagens();
  console.log(`  com imagem (total):          ${imagens.comImagem}`);
  console.log(`  sem imagem:                  ${imagens.semImagem}`);

  console.log("\n[4/5] Regulatory coverage...");
  const regulatory = await gatherRegulatory();
  console.log(`  total RegulatoryRecord:      ${regulatory.totalRR}`);
  console.log(`  RR ∩ Produto vivos:          ${regulatory.intersect}`);
  console.log(`  RR clínico ∩ Produto vivos:  ${regulatory.produtoComRRClinico}`);

  console.log("\n[5/5] Classification...");
  const classification = await gatherClassification();
  console.log(`  nivel2 distribuídos:         ${classification.nivel2Distribution.length}`);
  console.log(`  top ATC prefixes:            ${classification.topAtcPrefixes.length}`);
  console.log(`  rule gaps activos:           ${classification.totalRuleGaps}`);

  const baseline = {
    outrosBefore: BASELINE_OUTROS,
    outrosNow: totals.outrosMedicamentos,
    delta: totals.outrosMedicamentos - BASELINE_OUTROS,
    pct: `${(((totals.outrosMedicamentos - BASELINE_OUTROS) / BASELINE_OUTROS) * 100).toFixed(1)}%`,
  };

  const report: Report = {
    generatedAt: new Date().toISOString(),
    totals,
    naoMedicamento,
    imagens,
    regulatory,
    classification,
    baseline,
  };

  const md = renderMarkdown(report);
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, md, "utf-8");

  console.log("\n" + "─".repeat(74));
  console.log(`Relatório escrito: ${path.relative(process.cwd(), REPORT_PATH)}`);
  console.log(
    `Baseline 6195 → ${totals.outrosMedicamentos} (${baseline.delta}, ${baseline.pct})`,
  );
  console.log("─".repeat(74));
}

main()
  .catch((e) => {
    console.error("[fatal]", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
