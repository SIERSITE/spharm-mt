import { MainShell } from "@/components/layout/main-shell";
import { getInternalSubstitutionsData } from "@/lib/transferencias-data";
import { findDciEquivalentSubstitutions, type DciSubstitutionInput } from "@/lib/transfers/dci-equivalent-substitution";
import { getPrisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { legacyPrisma } from "@/lib/prisma";
import { getIpfFreshness } from "@/lib/operational/ipf-freshness";
import { OportunidadesInbox } from "@/components/oportunidades/oportunidades-inbox";

export const dynamic = "force-dynamic";

/**
 * /oportunidades — Operational Inbox.
 *
 * Feed compacto unificado:
 *   · Substituições same-CNP (rotura iminente + excesso interno)
 *   · DCI-equivalent (cautelar)
 *   · IPF stale (read-model com idade > threshold)
 *
 * Cada item tem CTA "Criar transferência" que reusa o flow
 * existente (`createInternalTransferAction` → ListaEncomenda RASCUNHO).
 *
 * Server-rendered, sem chat, sem notificações realtime. Re-fresh
 * por reload da página.
 */
export default async function OportunidadesPage() {
  // 1. Same-CNP (mesmos thresholds que /encomendas)
  const sameCnp = await getInternalSubstitutionsData({
    ruptureThresholdDays: 15,
    excessThresholdDays: 30,
    targetCoverageDays: 15,
    reserveDaysSource: 14,
    minTransferableQty: 1,
  });

  // 2. DCI-equivalent — preciso carregar input com metadados clínicos.
  //    Reutiliza a mesma SQL pattern do encomendas-data, mas inline
  //    (não exportada). Pequena duplicação aceitável vs refactor para
  //    extrair a query — minimum delta em RC mode.
  const prisma = await getPrisma();
  const farmacias = await prisma.farmacia.findMany({
    where: { estado: "ATIVO", nome: { not: "Farmácia Teste" } },
    select: { id: true, nome: true },
    orderBy: { nome: "asc" },
  });
  const farmaciaIds = farmacias.map((f) => f.id);

  type DciInputRow = {
    produtoId: string;
    farmaciaId: string;
    farmaciaNome: string;
    cnp: string;
    designacao: string;
    stockAtual: number;
    puc: number | null;
    salesQty: number;
    dci: string | null;
    formaFarmaceutica: string | null;
    dosagem: string | null;
    flagMSRM: boolean;
    flagMNSRM: boolean;
    codigoATC: string | null;
    productType: string | null;
  };

  let dciCandidates: ReturnType<typeof findDciEquivalentSubstitutions>["candidates"] = [];
  if (farmaciaIds.length >= 2) {
    const rows = await prisma.$queryRaw<DciInputRow[]>(Prisma.sql`
      WITH sales3m AS (
        SELECT vm."produtoId", vm."farmaciaId",
               SUM(vm.quantidade)::float AS qty
        FROM "VendaMensal" vm
        WHERE (vm.ano * 12 + vm.mes) >=
              ((EXTRACT(YEAR FROM NOW())::int * 12) + EXTRACT(MONTH FROM NOW())::int - 3)
          AND (vm.ano * 12 + vm.mes) <
              ((EXTRACT(YEAR FROM NOW())::int * 12) + EXTRACT(MONTH FROM NOW())::int)
          AND vm."farmaciaId" = ANY(${farmaciaIds})
          -- Só venda normal. Uma transferência entre as nossas próprias
          -- farmácias não é procura de utente: contá-la como tal inflaria
          -- a oportunidade de substituição com stock que só mudou de sítio.
          AND vm."naturezaVenda" = 'NORMAL'
        GROUP BY vm."produtoId", vm."farmaciaId"
      )
      SELECT
        pf."produtoId",
        pf."farmaciaId",
        f.nome              AS "farmaciaNome",
        p.cnp::text         AS cnp,
        p.designacao,
        pf."stockAtual"::float AS "stockAtual",
        pf.puc::float       AS puc,
        COALESCE(s.qty, 0)  AS "salesQty",
        p.dci,
        p."formaFarmaceutica",
        p.dosagem,
        p."flagMSRM",
        p."flagMNSRM",
        p."codigoATC",
        p."productType"
      FROM "ProdutoFarmacia" pf
      JOIN "Produto"  p ON p.id = pf."produtoId"
      JOIN "Farmacia" f ON f.id = pf."farmaciaId"
      LEFT JOIN sales3m s
        ON s."produtoId" = pf."produtoId" AND s."farmaciaId" = pf."farmaciaId"
      WHERE pf."flagRetirado" = false
        AND pf."farmaciaId" = ANY(${farmaciaIds})
    `);
    const input: DciSubstitutionInput[] = rows.map((r) => ({
      produtoId: r.produtoId,
      farmaciaId: r.farmaciaId,
      farmaciaNome: r.farmaciaNome,
      cnp: r.cnp,
      designacao: r.designacao,
      stockAtual: Number(r.stockAtual ?? 0),
      puc: r.puc === null ? null : Number(r.puc),
      salesQty: Number(r.salesQty ?? 0),
      dci: r.dci,
      formaFarmaceutica: r.formaFarmaceutica,
      dosagem: r.dosagem,
      flagMSRM: !!r.flagMSRM,
      flagMNSRM: !!r.flagMNSRM,
      codigoATC: r.codigoATC,
      productType: r.productType,
    }));
    const dci = findDciEquivalentSubstitutions(input, {
      ruptureThresholdDays: 15,
      excessThresholdDays: 30,
      targetCoverageDays: 15,
      reserveDaysSource: 14,
      minTransferableQty: 1,
      requireMedicamento: true,
    });
    // Aplicar regra: DCI-only quando destino não tem same-CNP.
    const sameDestinos = new Set(
      sameCnp.map((s) => `${s.produtoId}:${s.destinoFarmaciaId}`),
    );
    dciCandidates = dci.candidates.filter(
      (c) => !sameDestinos.has(`${c.destinoProdutoId}:${c.destinoFarmaciaId}`),
    );
  }

  // 3. IPF freshness — operational alert se stale.
  const freshness = await getIpfFreshness(legacyPrisma).catch(() => null);

  return (
    <MainShell>
      <div className="relative z-10 space-y-6 pt-10">
        <section>
          <h1 className="text-[22px] font-semibold tracking-tight text-slate-900">
            Oportunidades operacionais
          </h1>
          <p className="mt-1 text-[12px] text-slate-400">
            Feed unificado · same-CNP · DCI-equivalente · saúde do read-model
          </p>
        </section>

        <OportunidadesInbox
          sameCnp={sameCnp.slice(0, 50).map((s) => ({
            produtoId: s.produtoId,
            cnp: s.cnp,
            designacao: s.designacao,
            destinoFarmaciaId: s.destinoFarmaciaId,
            destinoFarmaciaNome: s.destinoFarmaciaNome,
            destinoCoverage: s.stockCoverageDestination,
            sourceFarmaciaNome: s.suggestedSourceFarmaciaNome,
            sourceCoverage: s.stockCoverageOrigin,
            transferableQty: s.transferableQty,
            avoidedPurchaseEstimate: s.avoidedPurchaseEstimate,
          }))}
          dciEquivalent={dciCandidates.slice(0, 50).map((c) => ({
            destinoProdutoId: c.destinoProdutoId,
            destinoCnp: c.destinoCnp,
            destinoDesignacao: c.destinoDesignacao,
            destinoFarmaciaId: c.destinoFarmaciaId,
            destinoFarmaciaNome: c.destinoFarmaciaNome,
            destinoCoverage: c.destinoCoverage,
            sourceProdutoId: c.sourceProdutoId,
            sourceCnp: c.sourceCnp,
            sourceDesignacao: c.sourceDesignacao,
            sourceFarmaciaNome: c.sourceFarmaciaNome,
            sourceCoverage: c.sourceCoverage,
            transferableQty: c.transferableQty,
            avoidedPurchaseEstimate: c.avoidedPurchaseEstimate,
            dci: c.dci,
            dosagem: c.dosagem,
            forma: c.formaFarmaceutica,
            atc5: c.atc5,
          }))}
          ipfFreshness={
            freshness
              ? {
                  healthy: freshness.healthy,
                  ageHours: freshness.ageHours,
                  coverage: freshness.coverage,
                  reasons: freshness.reasons,
                  totalRows: freshness.totalIpfRows,
                }
              : null
          }
        />
      </div>
    </MainShell>
  );
}
