/**
 * lib/encomendas-data.ts
 * Server-side data para a página Encomendas.
 *
 * Devolve linhas (cnp, farmácia) com stock, rotação média (3 meses),
 * cobertura, fornecedor habitual, fabricante canónico e movimentos
 * dos últimos 6 meses. Mesmas garantias de Vendas/Transferências:
 * sem mocks, sem hardcoded, fabricante via Produto.fabricante.
 *
 * Os campos "ultimasCompras" e "condicoesFornecedor" do shape antigo
 * ficam vazios nesta passagem — não há ainda pipeline real para eles
 * (ver nota no fim do ficheiro).
 */
import { getPrisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { resolveCategoria } from "@/lib/categoria-resolver";
import {
  avgDaily,
  coverageDays,
  monthlyVelocity,
  WINDOW_90D,
} from "@/lib/operational/metrics-shared";
import { loadIpfBatch, resolveAvgDaily90d } from "@/lib/operational/ipf-reader";
import { findInternalSubstitutions } from "@/lib/transfers/internal-substitution";
import { findDciEquivalentSubstitutions } from "@/lib/transfers/dci-equivalent-substitution";

export type EncomendaMonthlyMovement = { mes: string; compras: number; vendas: number };
export type EncomendaPurchaseHistory = {
  data: string;
  fornecedor: string;
  quantidade: number;
  precoCusto: number;
};
export type EncomendaSupplierCondition = {
  fornecedor: string;
  campanha: string;
  desconto: string;
  bonus: string;
};

export type EncomendaBaseRow = {
  /** ID interno do produto, exposto ao client para o CTA "Criar
   *  transferência" (server action precisa do produtoId, não só do
   *  CNP). Não é renderizado na UI. */
  produtoId: string;
  /** ID interno da farmácia desta linha — necessário para o CTA de
   *  transferência (destino). Não é renderizado. */
  farmaciaId: string;
  cnp: string;
  produto: string;
  farmacia: string;
  stockAtual: number;
  coberturaAtual: number;
  rotacaoMedia: number; // unidades por dia × 30 = unidades/mês
  fornecedor: string; // grossista habitual
  fabricante: string; // canónico
  categoria: string;
  // Enriquecimento clínico — surfaced em tooltip + chip ATC na UI.
  dci: string | null;
  codigoATC: string | null;
  movimentos6M: EncomendaMonthlyMovement[];
  ultimasCompras: EncomendaPurchaseHistory[];
  condicoesFornecedor: EncomendaSupplierCondition[];
  /**
   * Substituição operacional interna same-CNP: existe stock de excesso
   * noutra farmácia do grupo para o mesmo CNP. Quando true, os campos
   * `substitution*` ficam preenchidos. A decisão de mostrar a sugestão
   * ao utilizador é client-side (tipicamente só quando `sugestao > 0`).
   *
   * Same-CNP tem **prioridade**: quando existe alternativa same-CNP, o
   * detector DCI-equivalente (campos `dciEquivalent*` abaixo) não é
   * aplicado a esta linha. DCI-equivalente entra apenas como fallback.
   * Read-only, recomendação não-bloqueante.
   */
  internalSubstitutionAvailable: boolean;
  substitutionSourceFarmacia?: string;
  substitutionQtySuggested?: number;
  /** Valor evitado em €. `transferableQty × puc` com fallbacks. */
  substitutionAvoidedPurchaseValue?: number;
  substitutionCoverageOrigin?: number;
  substitutionCoverageDestination?: number;

  /**
   * Substituição interna DCI-equivalente (recomendação CAUTELAR).
   *
   * Aplicada APENAS quando `internalSubstitutionAvailable === false`
   * para a mesma linha — same-CNP tem prioridade sempre. Quando
   * presente, o produto source tem um CNP DIFERENTE mas partilha:
   *   · DCI normalizada
   *   · forma farmacêutica
   *   · dosagem
   *   · ATC5 (primeiros 5 chars do código ATC)
   *   · flags MSRM/MNSRM
   *
   * Read-only, recomendação não-bloqueante. UI deve sinalizar com
   * cor/texto distintos do same-CNP e exigir validação humana antes
   * da transferência.
   *
   * `dciEquivalentReason` documenta a base clínica (ex: "Mesmo DCI:
   * dapagliflozina 10mg comprimido rev (ATC A10BK)"). Não é o motivo
   * de incluir/excluir — é o detalhe a apresentar ao operador.
   */
  dciEquivalentAvailable: boolean;
  dciEquivalentCnp?: string;
  dciEquivalentProductName?: string;
  dciEquivalentSourceFarmacia?: string;
  dciEquivalentQtySuggested?: number;
  dciEquivalentAvoidedPurchaseValue?: number;
  dciEquivalentReason?: string;
  /** Produto source para DCI-equivalent (produtoId interno do produto
   *  que vai ser fisicamente transferido). Para same-CNP é igual a
   *  `produtoId` do destino. */
  dciEquivalentSourceProdutoId?: string;
  /** Farmácia origem (id) — same-CNP: `substitutionSourceFarmaciaId`;
   *  DCI: `dciEquivalentSourceFarmaciaId`. */
  substitutionSourceFarmaciaId?: string;
  dciEquivalentSourceFarmaciaId?: string;
};

function toF(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

const MES_ABBR = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];

export async function getEncomendasData(): Promise<EncomendaBaseRow[]> {
  const prisma = await getPrisma();
  const farmacias = await prisma.farmacia.findMany({
    where: { estado: "ATIVO", nome: { not: "Farmácia Teste" } },
    select: { id: true, nome: true },
    orderBy: { nome: "asc" },
  });
  const farmaciaIds = farmacias.map((f) => f.id);
  if (farmaciaIds.length === 0) return [];

  // 1. ProdutoFarmacia activos das farmácias seleccionadas + relações canónicas
  type PfRow = {
    produtoId: string;
    farmaciaId: string;
    farmaciaNome: string;
    cnp: string;
    designacao: string;
    stockAtual: number;
    /** Preço unitário de custo. Usado em `avoidedPurchaseEstimate` da substituição. */
    puc: number | null;
    fornecedorOrigem: string | null;
    categoriaOrigem: string | null;
    subcategoriaOrigem: string | null;
    canonN1: string | null;
    canonN2: string | null;
    fabricanteCanonico: string | null;
    // Catálogo (Produto) — usado pelo detector DCI-equivalente
    dci: string | null;
    formaFarmaceutica: string | null;
    dosagem: string | null;
    flagMSRM: boolean;
    flagMNSRM: boolean;
    codigoATC: string | null;
    productType: string | null;
  };

  // Puxa as 4 fontes de categoria que o resolver precisa: canónico N1/N2
  // e os campos brutos do importer. O resolveCategoria no loop decide a
  // precedência (mesma regra em toda a app).
  const pfRows = await prisma.$queryRaw<PfRow[]>(Prisma.sql`
    SELECT
      pf."produtoId",
      pf."farmaciaId",
      f.nome                        AS "farmaciaNome",
      p.cnp::text                   AS cnp,
      p.designacao,
      pf."stockAtual"::float        AS "stockAtual",
      pf.puc::float                 AS puc,
      pf."fornecedorOrigem",
      pf."categoriaOrigem",
      pf."subcategoriaOrigem",
      c1.nome                       AS "canonN1",
      c2.nome                       AS "canonN2",
      fab."nomeNormalizado"         AS "fabricanteCanonico",
      p.dci                         AS dci,
      p."formaFarmaceutica"         AS "formaFarmaceutica",
      p.dosagem                     AS dosagem,
      p."flagMSRM"                  AS "flagMSRM",
      p."flagMNSRM"                 AS "flagMNSRM",
      p."codigoATC"                 AS "codigoATC",
      p."productType"               AS "productType"
    FROM "ProdutoFarmacia" pf
    JOIN "Produto"  p   ON p.id  = pf."produtoId"
    JOIN "Farmacia" f   ON f.id  = pf."farmaciaId"
    LEFT JOIN "Fabricante"    fab ON fab.id = p."fabricanteId"
    LEFT JOIN "Classificacao" c1  ON c1.id  = p."classificacaoNivel1Id"
    LEFT JOIN "Classificacao" c2  ON c2.id  = p."classificacaoNivel2Id"
    WHERE
      pf."flagRetirado" = false
      AND f.id = ANY(${farmaciaIds})
      AND pf."stockAtual" IS NOT NULL
  `);

  if (pfRows.length === 0) return [];

  // Dual-read: IPF carregado em paralelo com vendas mensais. Quando IPF
  // tem linha, `mediaVendasDiarias90d` substitui o cálculo `recent3 / 90`
  // (numericamente idêntico — drift 0.0000 validado em scripts/tests
  // e em scripts/indicadores-produto-farmacia-dry-run.ts).
  const ipfMap = await loadIpfBatch(farmaciaIds);

  // 2. Vendas dos últimos 6 meses agrupadas por (produto, farmácia, ano, mes)
  const now = new Date();
  const periodEnd = now.getFullYear() * 12 + now.getMonth() + 1;
  const periodStart = periodEnd - 6;

  type VmRow = {
    produtoId: string;
    farmaciaId: string;
    ano: number;
    mes: number;
    qty: number;
  };

  const vmRows = await prisma.$queryRaw<VmRow[]>(Prisma.sql`
    SELECT
      vm."produtoId",
      vm."farmaciaId",
      vm.ano,
      vm.mes,
      SUM(vm.quantidade)::float AS qty
    FROM "VendaMensal" vm
    WHERE
      vm."farmaciaId" = ANY(${farmaciaIds})
      AND (vm.ano * 12 + vm.mes) >= ${periodStart}
      AND (vm.ano * 12 + vm.mes) < ${periodEnd}
    GROUP BY vm."produtoId", vm."farmaciaId", vm.ano, vm.mes
  `);

  // Index: key=produtoId:farmaciaId → array de {ano, mes, qty}
  const vmIndex = new Map<string, Array<{ ano: number; mes: number; qty: number }>>();
  for (const r of vmRows) {
    const k = `${r.produtoId}:${r.farmaciaId}`;
    if (!vmIndex.has(k)) vmIndex.set(k, []);
    vmIndex.get(k)!.push({ ano: r.ano, mes: r.mes, qty: toF(r.qty) });
  }

  // Cache recent3 (vendas 3m) por par — reaproveitado no main loop e na
  // detecção de substituição.
  const recent3ByKey = new Map<string, number>();
  for (const pf of pfRows) {
    const k = `${pf.produtoId}:${pf.farmaciaId}`;
    const vendas = vmIndex.get(k) ?? [];
    const recent3 = vendas
      .filter((v) => v.ano * 12 + v.mes >= periodEnd - 3)
      .reduce((s, v) => s + v.qty, 0);
    recent3ByKey.set(k, recent3);
  }

  // 3. Substituição operacional interna (same-CNP).
  //
  // Thresholds adaptados a encomendas (vs. /transferencias):
  //   - ruptureThresholdDays: 15  → destino abaixo da cobertura-alvo
  //     canónica (≈ período usual de encomenda)
  //   - excessThresholdDays:  30  → origem com excesso confortável
  //   - targetCoverageDays:   15  → alinhado com encomenda
  //   - reserveDaysSource:    14  → mantém origem acima de 14d
  //
  // O detector é puro (`findInternalSubstitutions`) e reutiliza a fórmula
  // canónica de avgDaily/coverage. Quando IPF está populada, a fonte
  // numérica é a mesma (drift 0.0000 validado em Fase 1).
  const substitutionInput = pfRows.map((pf) => ({
    produtoId: pf.produtoId,
    farmaciaId: pf.farmaciaId,
    farmaciaNome: pf.farmaciaNome,
    cnp: pf.cnp,
    designacao: pf.designacao,
    stockAtual: toF(pf.stockAtual),
    puc: pf.puc,
    salesQty: recent3ByKey.get(`${pf.produtoId}:${pf.farmaciaId}`) ?? 0,
  }));
  const substitutions = findInternalSubstitutions(substitutionInput, {
    ruptureThresholdDays: 15,
    excessThresholdDays: 30,
    targetCoverageDays: 15,
    reserveDaysSource: 14,
    minTransferableQty: 1,
  });
  const subsByDestino = new Map<string, (typeof substitutions)[number]>();
  for (const s of substitutions) {
    subsByDestino.set(`${s.produtoId}:${s.destinoFarmaciaId}`, s);
  }

  // 3b. Substituição DCI-equivalente — RECOMENDAÇÃO CAUTELAR.
  //
  // Aplica os mesmos thresholds que same-CNP (mesma cobertura-alvo,
  // mesma reserva-origem) e os gates clínicos do detector
  // (`findDciEquivalentSubstitutions`): pré-filtro
  // productType=MEDICAMENTO + DCI não vazio; gates pair-level forma /
  // dosagem / ATC5 / MSRM-MNSRM. Quando qualquer campo clínico está
  // ausente num lado do par, o detector rejeita silenciosamente —
  // fallback seguro.
  //
  // Indexação por `${produtoId}:${destinoFarmaciaId}` à imagem de
  // same-CNP, para o lookup no main loop ser O(1).
  const dciInput = pfRows.map((pf) => ({
    produtoId: pf.produtoId,
    farmaciaId: pf.farmaciaId,
    farmaciaNome: pf.farmaciaNome,
    cnp: pf.cnp,
    designacao: pf.designacao,
    stockAtual: toF(pf.stockAtual),
    puc: pf.puc,
    salesQty: recent3ByKey.get(`${pf.produtoId}:${pf.farmaciaId}`) ?? 0,
    dci: pf.dci,
    formaFarmaceutica: pf.formaFarmaceutica,
    dosagem: pf.dosagem,
    flagMSRM: !!pf.flagMSRM,
    flagMNSRM: !!pf.flagMNSRM,
    codigoATC: pf.codigoATC,
    productType: pf.productType,
  }));
  const dciResult = findDciEquivalentSubstitutions(dciInput, {
    ruptureThresholdDays: 15,
    excessThresholdDays: 30,
    targetCoverageDays: 15,
    reserveDaysSource: 14,
    minTransferableQty: 1,
    requireMedicamento: true,
  });
  const dciByDestino = new Map<string, (typeof dciResult.candidates)[number]>();
  for (const c of dciResult.candidates) {
    dciByDestino.set(`${c.destinoProdutoId}:${c.destinoFarmaciaId}`, c);
  }

  // 4. Construir as linhas finais
  const result: EncomendaBaseRow[] = [];
  for (const pf of pfRows) {
    const k = `${pf.produtoId}:${pf.farmaciaId}`;
    const vendas = vmIndex.get(k) ?? [];

    const recent3 = recent3ByKey.get(k) ?? 0;
    const liveAd = avgDaily(recent3, WINDOW_90D);
    const { value: ad } = resolveAvgDaily90d(ipfMap.get(k), liveAd);
    const rotacaoMedia = monthlyVelocity(ad);
    const stockAtual = Math.round(toF(pf.stockAtual));
    // Convenção legada do shape EncomendaBaseRow: 999 quando há stock
    // mas sem demanda mensurável; 0 quando stock vazio. coverageDays
    // canónico devolve null no primeiro caso — mapear no boundary.
    const cov = coverageDays(stockAtual, ad);
    const coberturaAtual = cov === null ? 999 : Math.round(cov);

    // Movimentos 6M — só vendas; compras ficam a 0 enquanto não houver pipeline real
    const movimentos6M: EncomendaMonthlyMovement[] = vendas
      .sort((a, b) => a.ano * 12 + a.mes - (b.ano * 12 + b.mes))
      .map((v) => ({
        mes: `${MES_ABBR[v.mes - 1]} ${String(v.ano).slice(2)}`,
        compras: 0,
        vendas: Math.round(v.qty),
      }));

    const { grupo: categoriaResolvida } = resolveCategoria({
      classificacaoNivel1: pf.canonN1 ? { nome: pf.canonN1 } : null,
      classificacaoNivel2: pf.canonN2 ? { nome: pf.canonN2 } : null,
      categoriaOrigem: pf.categoriaOrigem,
      subcategoriaOrigem: pf.subcategoriaOrigem,
    });

    const sub = subsByDestino.get(k);
    // DCI-equivalente APENAS quando same-CNP indisponível (prioridade
    // same-CNP). Esta regra mantém a UI determinística — um destino
    // tem 0 ou 1 substituição associada, nunca duas concorrentes.
    const dciCand = sub === undefined ? dciByDestino.get(k) : undefined;
    const dciReason = dciCand
      ? `Mesmo DCI: ${dciCand.dci} ${dciCand.dosagem} ${dciCand.formaFarmaceutica}` +
        (dciCand.atc5 ? ` (ATC ${dciCand.atc5})` : "")
      : undefined;

    result.push({
      produtoId: pf.produtoId,
      farmaciaId: pf.farmaciaId,
      cnp: pf.cnp,
      produto: pf.designacao,
      farmacia: pf.farmaciaNome,
      stockAtual,
      coberturaAtual,
      rotacaoMedia,
      fornecedor: pf.fornecedorOrigem ?? "",
      fabricante: pf.fabricanteCanonico ?? "",
      categoria: categoriaResolvida,
      dci: pf.dci,
      codigoATC: pf.codigoATC,
      movimentos6M,
      ultimasCompras: [], // ver nota
      condicoesFornecedor: [], // ver nota
      // Substituição operacional interna (same-CNP) — recomendação
      // não-bloqueante. Cliente decide quando mostrar (tipicamente só
      // quando sugestao > 0).
      internalSubstitutionAvailable: sub !== undefined,
      substitutionSourceFarmacia: sub?.suggestedSourceFarmaciaNome,
      substitutionSourceFarmaciaId: sub?.suggestedSourceFarmaciaId,
      substitutionQtySuggested: sub?.transferableQty,
      substitutionAvoidedPurchaseValue: sub?.avoidedPurchaseEstimate,
      substitutionCoverageOrigin: sub?.stockCoverageOrigin,
      substitutionCoverageDestination: sub?.stockCoverageDestination ?? undefined,
      // Substituição DCI-equivalente — RECOMENDAÇÃO CAUTELAR,
      // populada APENAS se same-CNP não estiver disponível.
      dciEquivalentAvailable: dciCand !== undefined,
      dciEquivalentCnp: dciCand?.sourceCnp,
      dciEquivalentProductName: dciCand?.sourceDesignacao,
      dciEquivalentSourceFarmacia: dciCand?.sourceFarmaciaNome,
      dciEquivalentSourceFarmaciaId: dciCand?.sourceFarmaciaId,
      dciEquivalentSourceProdutoId: dciCand?.sourceProdutoId,
      dciEquivalentQtySuggested: dciCand?.transferableQty,
      dciEquivalentAvoidedPurchaseValue: dciCand?.avoidedPurchaseEstimate,
      dciEquivalentReason: dciReason,
    });
  }

  return result;
}

/*
 * NOTAS DE LIMITAÇÃO (intencionais nesta passagem):
 *
 * - movimentos6M.compras: o campo de compras mensais não tem ainda uma
 *   tabela agregada equivalente a VendaMensal. Quando existir
 *   CompraMensal (ou snapshot), preencher aqui. Por agora == 0.
 *
 * - ultimasCompras: requer agregação por Compra (modelo já existe) com
 *   join a Fornecedor + ordenação por data desc. Não foi feito nesta
 *   passagem por não termos confirmação de que o universo de Compra
 *   esteja populado. Adicionar quando o pipeline de ingestão de compras
 *   estiver fechado.
 *
 * - condicoesFornecedor: não existe tabela de condições comerciais por
 *   fornecedor. É uma feature de produto que requer um modelo dedicado
 *   (CampanhaFornecedor / DescontoFornecedor). Fica como TODO de
 *   produto, não como dummy de UI.
 */
