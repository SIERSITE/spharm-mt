/**
 * scripts/tests/test-agent-fabricante-daily-sync.ts
 *
 * Bloco C — o daily-sync agendado nunca enviava fabricante (nem dci,
 * codigoATC, grupoHomogeneo): a descoberta destas colunas só corria no
 * onboarding/refresh manual (`bootstrap-upload.ts`). `daily-sync-runner.ts`
 * passou a reaproveitar a MESMA descoberta, extraída para
 * `agent/src/catalog-discovery.ts`.
 *
 * ── O que este teste simula ──────────────────────────────────────────
 *
 * Um `pool` falso que devolve linhas de `sys.columns`/`sys.tables`
 * fabricadas — sem SQL Server real — para os três cenários que a
 * instalação pode apresentar:
 *
 *   A. coluna textual directa  (Stocks.[Fabricante])
 *   B. só FK numérica + lookup (Stocks.[GamaFabricanteID] → tblGamaFabricante)
 *   C. nenhum dos dois          (fallback limpo: NULL, sem rebentar)
 *
 * E confirma duas coisas em cada cenário:
 *   1. `buildCatalogSqlFragments` (função pura) produz o SELECT/JOIN certo;
 *   2. `daily-sync-runner.ts` usa isso: `buildProductsSql` inclui as
 *      colunas no SQL gerado, e `rowToProductPayload` (via
 *      `catalogFieldsToPayload`) leva o fabricante para o payload —
 *      o que faltava antes desta correcção.
 *
 * Uso: npx tsx scripts/tests/test-agent-fabricante-daily-sync.ts
 */
import type { SqlPool } from "../../agent/src/sql-client";
import {
  discoverCatalogPlan,
  buildCatalogSqlFragments,
  catalogFieldsToPayload,
  type CatalogPlan,
} from "../../agent/src/catalog-discovery";
import {
  buildProductsSql,
  rowToProductPayload,
  type SchemaCapabilities,
} from "../../agent/src/commands/daily-sync-runner";

let pass = 0;
let fail = 0;
const ok = (label: string, cond: boolean, extra?: string) => {
  if (cond) {
    pass++;
    console.log(`  [OK]    ${label}`);
  } else {
    fail++;
    console.log(`  [FALHA] ${label}${extra ? ` — ${extra}` : ""}`);
  }
};
const eq = <T>(label: string, obtido: T, esperado: T) =>
  ok(label, Object.is(obtido, esperado), `obtido ${JSON.stringify(obtido)}, esperado ${JSON.stringify(esperado)}`);

type ColRow = { nome: string; tipo: string };

/**
 * Pool falso: responde às TRÊS queries que `discoverCatalogPlan` emite,
 * identificadas pelo texto (sem parser de SQL — apenas as âncoras que já
 * distinguem estas três queries entre si no código real).
 */
function poolFalso(opts: {
  stocksColumns: ColRow[];
  fkTabela?: { tabela: string; pk: string; texto: string } | null;
  grupoHomogeneo?: { emStocks: number; noLookup: number };
}): SqlPool {
  const request = () => {
    const req = {
      input: () => req,
      query: async (sqlText: string) => {
        if (/AS emStocks/.test(sqlText)) {
          return { recordset: [opts.grupoHomogeneo ?? { emStocks: 0, noLookup: 0 }] };
        }
        if (/AS pk,/.test(sqlText)) {
          return { recordset: opts.fkTabela ? [opts.fkTabela] : [] };
        }
        // A query inicial de sys.columns de dbo.Stocks.
        return { recordset: opts.stocksColumns };
      },
    };
    return req;
  };
  return { request } as unknown as SqlPool;
}

const CAPS = (catalogPlan: CatalogPlan): SchemaCapabilities => ({
  hasStocksMov: true,
  stocksMovDateCol: "DataMov",
  hasDataActualiz: true,
  catalogPlan,
});

async function main() {
  console.log("=== A. coluna textual directa (Stocks.[Fabricante]) ===");
  {
    const pool = poolFalso({
      stocksColumns: [
        { nome: "Fabricante", tipo: "varchar" },
        { nome: "CodigoID", tipo: "int" },
      ],
    });
    const plan = await discoverCatalogPlan(pool);
    eq("coluna directa detectada", plan.fabricante, "Fabricante");
    eq("sem FK (não precisa)", plan.fabricanteFk, null);

    const frag = buildCatalogSqlFragments(plan);
    eq("SELECT usa a coluna directa", frag.fabricanteSelect, "s.[Fabricante]");
    eq("sem JOIN extra", frag.fabricanteJoin, "");

    const sqlText = buildProductsSql(CAPS(plan));
    ok("buildProductsSql inclui a coluna no SELECT", /s\.\[Fabricante\]\s+AS fabricante/.test(sqlText), sqlText);
  }

  console.log("\n=== B. só FK numérica + lookup (Stocks.[GamaFabricanteID]) ===");
  {
    const pool = poolFalso({
      stocksColumns: [
        { nome: "GamaFabricanteID", tipo: "smallint" },
        { nome: "CodigoID", tipo: "int" },
      ],
      fkTabela: { tabela: "tblGamaFabricante", pk: "GamaFabricanteID", texto: "Descricao" },
    });
    const plan = await discoverCatalogPlan(pool);
    eq("sem coluna textual directa", plan.fabricante, null);
    ok(
      "FK resolvida com as três evidências (nome, tipo, PK)",
      plan.fabricanteFk?.stocksColumn === "GamaFabricanteID" &&
        plan.fabricanteFk?.table === "tblGamaFabricante" &&
        plan.fabricanteFk?.pk === "GamaFabricanteID" &&
        plan.fabricanteFk?.textColumn === "Descricao",
      JSON.stringify(plan.fabricanteFk),
    );

    const frag = buildCatalogSqlFragments(plan);
    eq("SELECT lê o texto do lookup", frag.fabricanteSelect, "fab_lk.[Descricao]");
    ok(
      "JOIN liga Stocks ao lookup pela FK",
      /LEFT JOIN \[dbo\]\.\[tblGamaFabricante\] fab_lk ON fab_lk\.\[GamaFabricanteID\] = s\.\[GamaFabricanteID\]/.test(
        frag.fabricanteJoin,
      ),
      frag.fabricanteJoin,
    );

    const sqlText = buildProductsSql(CAPS(plan));
    ok("buildProductsSql inclui o JOIN do lookup", sqlText.includes(frag.fabricanteJoin), sqlText);
    ok("…e o SELECT correspondente", /fab_lk\.\[Descricao\]\s+AS fabricante/.test(sqlText), sqlText);
  }

  console.log("\n=== C. nenhum dos dois → fallback limpo (NULL, sem rebentar) ===");
  {
    const pool = poolFalso({
      stocksColumns: [{ nome: "CodigoID", tipo: "int" }],
      fkTabela: null,
    });
    const plan = await discoverCatalogPlan(pool);
    eq("sem coluna directa", plan.fabricante, null);
    eq("sem FK confirmada", plan.fabricanteFk, null);

    const frag = buildCatalogSqlFragments(plan);
    eq("SELECT cai em NULL tipado, não rebenta", frag.fabricanteSelect, "CAST(NULL AS NVARCHAR(200))");
    eq("sem JOIN", frag.fabricanteJoin, "");

    const sqlText = buildProductsSql(CAPS(plan));
    ok(
      "buildProductsSql gera NULL para fabricante",
      /CAST\(NULL AS NVARCHAR\(200\)\)\s+AS fabricante/.test(sqlText),
      sqlText,
    );
    ok("…sem nenhum JOIN a um fab_lk inexistente", !/fab_lk/.test(sqlText));
  }

  console.log("\n=== o payload do daily-sync agora leva o fabricante ===");
  {
    // A lacuna do Bloco C: antes desta correcção, `ProductRow` nem tinha
    // este campo — `rowToProductPayload` simplesmente não o produzia,
    // por mais que o SELECT o trouxesse.
    const row = {
      externalProductId: 123,
      cnp: 5000001,
      designacao: "Produto Teste",
      pvp: 10,
      pmc: 5,
      puc: 5,
      dataUltimaVenda: null,
      dataUltimaCompra: null,
      retirado: 0,
      generico: 0,
      mnsrmNCompart: 0,
      fornecedorHabitualId: null,
      fornecedorHabitualNome: null,
      dci: "IBUPROFENO",
      codigoATC: "M01AE01",
      grupoHomogeneo: "A101",
      fabricante: "BAYER PORTUGAL",
    };
    const payload = rowToProductPayload(row);
    eq("fabricante chega ao payload", payload.fabricante, "BAYER PORTUGAL");
    eq("dci chega ao payload", payload.dci, "IBUPROFENO");
    eq("codigoATC chega ao payload", payload.codigoATC, "M01AE01");
    eq("grupoHomogeneo chega ao payload", payload.grupoHomogeneo, "A101");

    // A mesma coerção que o resto do payload usa: "" e null viram null.
    eq(
      "campo ausente/branco vira null, não string vazia",
      catalogFieldsToPayload({ dci: "", codigoATC: null, grupoHomogeneo: undefined, fabricante: null })
        .dci,
      null,
    );
  }

  console.log(`\n${pass} ok, ${fail} falhas`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
