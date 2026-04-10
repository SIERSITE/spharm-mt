/**
 * scripts/import-excel.ts
 *
 * Script de importação dos ficheiros Excel de exemplo para a base de dados.
 *
 * Uso:
 *   npx tsx scripts/import-excel.ts
 *
 * Requer DATABASE_URL no .env (ou variável de ambiente).
 *
 * Idempotente: pode ser re-executado sem duplicar dados.
 * Os dados de VendaMensal são apagados e re-inseridos a cada execução.
 * O stock (ProdutoFarmacia) é atualizado via upsert.
 */

import "dotenv/config";
import path from "path";
import {
  ensureFarmacia,
  importSalesFromExcel,
  importStockFromExcel,
} from "../lib/importer";

const FILES_DIR = path.join(process.cwd(), "example_files");

async function main() {
  console.log("─── Importação Excel → Base de Dados ───────────────────────\n");

  // ── Garantir que as farmácias existem ────────────────────────────────────────
  console.log("▶ Garantir farmácias...");
  const [idPrincipal, idCastelo] = await Promise.all([
    ensureFarmacia("Farmácia Principal"),
    ensureFarmacia("Farmácia Castelo"),
  ]);
  console.log(`  Farmácia Principal  → ${idPrincipal}`);
  console.log(`  Farmácia Castelo    → ${idCastelo}\n`);

  // ── Farmácia Principal ───────────────────────────────────────────────────────
  console.log("▶ Farmácia Principal — Vendas...");
  const r1 = await importSalesFromExcel(
    path.join(FILES_DIR, "MapaEvolucaoVendas.xlsx"),
    idPrincipal
  );
  console.log(
    `  Produtos: ${r1.produtos} | VendasMensais: ${r1.vendasMensais} | Ignoradas: ${r1.skipped}`
  );

  console.log("▶ Farmácia Principal — Stock...");
  const r2 = await importStockFromExcel(
    path.join(FILES_DIR, "stock_Atual.xlsx"),
    idPrincipal
  );
  console.log(`  Importadas: ${r2.imported} | Ignoradas: ${r2.skipped}`);

  // ── Farmácia Castelo ─────────────────────────────────────────────────────────
  console.log("\n▶ Farmácia Castelo — Vendas...");
  const r3 = await importSalesFromExcel(
    path.join(FILES_DIR, "MapaEvolucaoVendas_c.xlsx"),
    idCastelo
  );
  console.log(
    `  Produtos: ${r3.produtos} | VendasMensais: ${r3.vendasMensais} | Ignoradas: ${r3.skipped}`
  );

  console.log("▶ Farmácia Castelo — Stock...");
  const r4 = await importStockFromExcel(
    path.join(FILES_DIR, "stock_castelo.xlsx"),
    idCastelo
  );
  console.log(`  Importadas: ${r4.imported} | Ignoradas: ${r4.skipped}`);

  console.log("\n✓ Importação concluída.");
}

main().catch((err) => {
  console.error("Erro durante a importação:", err);
  process.exit(1);
});
