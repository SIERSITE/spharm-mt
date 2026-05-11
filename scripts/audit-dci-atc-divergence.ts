/**
 * scripts/audit-dci-atc-divergence.ts
 *
 * Read-only audit dos pares que o detector
 * `findDciEquivalentSubstitutions` rejeita por `atc_diferente`. Não
 * usa o detector directamente — replica a sua lógica de pré-filtro e
 * dos 3 gates anteriores (forma, dosagem) **apenas até ao ponto** em
 * que o gate ATC5 falha, para dar visibilidade aos pares.
 *
 * Critério de emissão (mesmo do detector):
 *   1. Ambas as rows passam pré-filtro: productType=MEDICAMENTO,
 *      DCI normalizada não vazia.
 *   2. Mesmo `normalizeCatalogString(dci)`.
 *   3. Farmácias diferentes.
 *   4. `normalizeCatalogString(formaFarmaceutica)` igual.
 *   5. `normalizeDosagem(dosagem)` igual.
 *   6. **`atc5(codigoATC)` DIFERENTE** ← divergência que estamos a auditar.
 *
 * Note que o detector usa ainda o filtro coverage/ruptura para
 * decidir se conta como rejeição. Aqui queremos VER a divergência
 * em si — não importa o nível de stock. Por isso emitimos TODOS os
 * pares que casam DCI+forma+dosagem mas têm ATC5 diferente, sejam
 * eles relevantes a ruptura ou não. Isso devolve potencialmente
 * mais que os 14 que o detector reportou; comparamos no fim.
 *
 * Read-only. Sem writes. Sem alterações ao detector ou ao schema.
 */

import "dotenv/config";
import { legacyPrisma as prisma } from "../lib/prisma";
import {
  normalizeCatalogString,
  normalizeDosagem,
  atc5,
} from "../lib/transfers/dci-equivalent-substitution";

type Row = {
  produtoId: string;
  farmaciaId: string;
  farmaciaNome: string;
  cnp: number;
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

async function loadRows(): Promise<Row[]> {
  return prisma.$queryRawUnsafe<Row[]>(`
    WITH sales90 AS (
      SELECT vm."produtoId", vm."farmaciaId",
             SUM(vm.quantidade)::float AS qty
      FROM "VendaMensal" vm
      WHERE (vm.ano * 12 + vm.mes) >=
            ((EXTRACT(YEAR FROM NOW())::int * 12) + EXTRACT(MONTH FROM NOW())::int - 3)
        AND (vm.ano * 12 + vm.mes) <
            ((EXTRACT(YEAR FROM NOW())::int * 12) + EXTRACT(MONTH FROM NOW())::int)
      GROUP BY vm."produtoId", vm."farmaciaId"
    )
    SELECT
      pf."produtoId",
      pf."farmaciaId",
      f.nome              AS "farmaciaNome",
      p.cnp,
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
    JOIN "Produto" p   ON p.id = pf."produtoId"
    JOIN "Farmacia" f  ON f.id = pf."farmaciaId"
    LEFT JOIN sales90 s
      ON s."produtoId" = pf."produtoId" AND s."farmaciaId" = pf."farmaciaId"
    WHERE pf."flagRetirado" = false
      AND f.estado = 'ATIVO'
      AND f.nome <> 'Farmácia Teste'
  `);
}

type Enriched = Row & {
  normDci: string;
  normForma: string | null;
  normDosagem: string | null;
  normAtc5: string | null;
};

type DivergentPair = {
  // Side A
  aCnp: string;
  aDesignacao: string;
  aFarmaciaNome: string;
  aStockAtual: number;
  aSalesQty: number;
  aPuc: number | null;
  aAtcRaw: string | null;
  aAtc5: string | null;
  aMSRM: boolean;
  aMNSRM: boolean;
  // Side B
  bCnp: string;
  bDesignacao: string;
  bFarmaciaNome: string;
  bStockAtual: number;
  bSalesQty: number;
  bPuc: number | null;
  bAtcRaw: string | null;
  bAtc5: string | null;
  bMSRM: boolean;
  bMNSRM: boolean;
  // Common
  dci: string;
  formaFarmaceutica: string;
  dosagem: string;
};

async function main() {
  console.log("─".repeat(78));
  console.log("Audit DCI / ATC5 divergence (READ-ONLY)");
  console.log("─".repeat(78));

  const rows = await loadRows();
  console.log(`Loaded ${rows.length} ProdutoFarmacia rows.`);

  // Pré-filtro: MEDICAMENTO + DCI não vazio
  const considered: Enriched[] = [];
  let skippedNotMed = 0;
  let skippedNoDci = 0;
  for (const r of rows) {
    if (r.productType !== "MEDICAMENTO") {
      skippedNotMed++;
      continue;
    }
    const normDci = normalizeCatalogString(r.dci);
    if (normDci === null) {
      skippedNoDci++;
      continue;
    }
    considered.push({
      ...r,
      normDci,
      normForma: normalizeCatalogString(r.formaFarmaceutica),
      normDosagem: normalizeDosagem(r.dosagem),
      normAtc5: atc5(r.codigoATC),
    });
  }
  console.log(`Pre-filter: skipped ${skippedNotMed} non-MEDICAMENTO, ${skippedNoDci} sem DCI → considered ${considered.length}`);

  // Agrupar por DCI
  const byDci = new Map<string, Enriched[]>();
  for (const e of considered) {
    if (!byDci.has(e.normDci)) byDci.set(e.normDci, []);
    byDci.get(e.normDci)!.push(e);
  }
  console.log(`DCI groups: ${byDci.size}`);

  // Para cada grupo, gerar pares onde forma+dosagem casam mas ATC5 difere.
  // De-duplicamos por (cnpMin, cnpMax) — cada par é único como conjunto
  // de 2 CNPs, ignorando direcção.
  const divergentByPair = new Map<string, DivergentPair>();
  let totalProduct = 0;

  for (const entries of byDci.values()) {
    if (entries.length < 2) continue;
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i];
        const b = entries[j];
        totalProduct++;
        if (a.farmaciaId === b.farmaciaId) continue;
        if (a.normForma === null || b.normForma === null || a.normForma !== b.normForma) continue;
        if (a.normDosagem === null || b.normDosagem === null || a.normDosagem !== b.normDosagem) continue;
        if (a.normAtc5 === null || b.normAtc5 === null) continue; // ATC ausente trata-se em separado
        if (a.normAtc5 === b.normAtc5) continue;

        // ATC5 difere — divergência
        const aCnp = String(a.cnp);
        const bCnp = String(b.cnp);
        const key = aCnp < bCnp ? `${aCnp}|${bCnp}` : `${bCnp}|${aCnp}`;
        if (divergentByPair.has(key)) continue;
        divergentByPair.set(key, {
          aCnp,
          aDesignacao: a.designacao,
          aFarmaciaNome: a.farmaciaNome,
          aStockAtual: Math.round(a.stockAtual),
          aSalesQty: Math.round(a.salesQty),
          aPuc: a.puc,
          aAtcRaw: a.codigoATC,
          aAtc5: a.normAtc5,
          aMSRM: a.flagMSRM,
          aMNSRM: a.flagMNSRM,

          bCnp,
          bDesignacao: b.designacao,
          bFarmaciaNome: b.farmaciaNome,
          bStockAtual: Math.round(b.stockAtual),
          bSalesQty: Math.round(b.salesQty),
          bPuc: b.puc,
          bAtcRaw: b.codigoATC,
          bAtc5: b.normAtc5,
          bMSRM: b.flagMSRM,
          bMNSRM: b.flagMNSRM,

          dci: a.normDci,
          formaFarmaceutica: a.normForma,
          dosagem: a.normDosagem,
        });
      }
    }
  }

  console.log(`\nTotal ordered pairs inspected: ${totalProduct}`);
  console.log(`Distinct (CNP-CNP) divergent pairs: ${divergentByPair.size}`);

  // Output JSON para o relatório
  const out = Array.from(divergentByPair.values()).sort((a, b) =>
    a.dci.localeCompare(b.dci) || a.aCnp.localeCompare(b.aCnp),
  );

  console.log("\n" + "═".repeat(78));
  console.log("DIVERGENT PAIRS (full detail)");
  console.log("═".repeat(78));
  for (const p of out) {
    console.log("\n─── DCI=" + p.dci + " │ forma=" + p.formaFarmaceutica + " │ dose=" + p.dosagem + " ───");
    console.log(`  A: CNP=${p.aCnp}  ATC=${p.aAtcRaw ?? "—"} (ATC5=${p.aAtc5})  MSRM=${p.aMSRM} MNSRM=${p.aMNSRM}`);
    console.log(`     "${p.aDesignacao}" (${p.aFarmaciaNome})  stock=${p.aStockAtual} sales90d=${p.aSalesQty} puc=${p.aPuc ?? "—"}`);
    console.log(`  B: CNP=${p.bCnp}  ATC=${p.bAtcRaw ?? "—"} (ATC5=${p.bAtc5})  MSRM=${p.bMSRM} MNSRM=${p.bMNSRM}`);
    console.log(`     "${p.bDesignacao}" (${p.bFarmaciaNome})  stock=${p.bStockAtual} sales90d=${p.bSalesQty} puc=${p.bPuc ?? "—"}`);
  }

  // JSON export para o relatório
  console.log("\n" + "═".repeat(78));
  console.log("JSON DUMP");
  console.log("═".repeat(78));
  console.log(JSON.stringify(out, null, 2));
}

main()
  .catch((e) => {
    console.error("[fatal]", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
