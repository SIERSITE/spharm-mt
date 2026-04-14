/**
 * scripts/backfill-produto-farmacia-origem.ts
 *
 * Backfill dos campos de origem em ProdutoFarmacia a partir dos ficheiros
 * MapaEvolucaoVendas já disponíveis em example_files/.
 *
 * Actualiza APENAS:
 *   - fornecedorOrigem   ← col "Fornecedor Habitual"
 *   - categoriaOrigem    ← col "Categoria"
 *   - subcategoriaOrigem ← col "SubCategoria"
 *
 * Não toca em pmc/pvp/stock/vendas — para re-importação completa usar
 * `scripts/import-excel.ts`.
 *
 * Regras de segurança:
 *   - Só actualiza linhas ProdutoFarmacia que JÁ existem (não cria nem apaga).
 *   - Só escreve campos para os quais o Excel tem valor não-null.
 *   - Nunca sobrescreve valores existentes na BD (só preenche nulls),
 *     excepto em --force onde sobrescreve sempre.
 *
 * Uso:
 *   npx tsx scripts/backfill-produto-farmacia-origem.ts
 *   npx tsx scripts/backfill-produto-farmacia-origem.ts --dry-run
 *   npx tsx scripts/backfill-produto-farmacia-origem.ts --force
 *
 * Opções:
 *   --dry-run   Não escreve; mostra apenas estatísticas previstas.
 *   --force     Sobrescreve valores existentes (por defeito só preenche nulls).
 */

import "dotenv/config";
import path from "path";
import * as XLSX from "xlsx";
import { legacyPrisma as prisma } from "../lib/prisma";
import { ensureFarmacia, normalizeOrigemValue } from "../lib/importer";

// ─── Args ─────────────────────────────────────────────────────────────────────

type Args = { dryRun: boolean; force: boolean };

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const out: Args = { dryRun: false, force: false };
  for (const arg of args) {
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--force") out.force = true;
    else console.warn(`[aviso] Argumento desconhecido: ${arg}`);
  }
  return out;
}

// ─── Parse do Excel — apenas colunas de origem ───────────────────────────────

type OrigemRow = {
  cnp: number;
  fornecedorOrigem: string | null;
  categoriaOrigem: string | null;
  subcategoriaOrigem: string | null;
};

function parseOrigemFromExcel(filePath: string): OrigemRow[] {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 }) as unknown[][];
  if (rows.length < 2) return [];

  const header = rows[0] as string[];
  const colLower = header.map((h) => String(h ?? "").toLowerCase().trim());
  const idxFornecedor   = colLower.findIndex((h) => h.includes("fornecedor"));
  const idxCategoria    = colLower.findIndex((h) => h === "categoria");
  const idxSubcategoria = colLower.findIndex(
    (h) => h === "subcategoria" || h === "sub categoria" || h === "sub-categoria"
  );

  if (idxFornecedor < 0 && idxCategoria < 0 && idxSubcategoria < 0) {
    console.warn(`  [aviso] Nenhuma coluna de origem encontrada em ${path.basename(filePath)}`);
    return [];
  }

  const out: OrigemRow[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] as unknown[];
    const cnpRaw = row[0];
    if (!cnpRaw) continue;
    const cnp = Math.round(Number(cnpRaw));
    if (!Number.isFinite(cnp) || cnp <= 0) continue;

    out.push({
      cnp,
      fornecedorOrigem:   idxFornecedor   >= 0 ? normalizeOrigemValue(row[idxFornecedor])   : null,
      categoriaOrigem:    idxCategoria    >= 0 ? normalizeOrigemValue(row[idxCategoria])    : null,
      subcategoriaOrigem: idxSubcategoria >= 0 ? normalizeOrigemValue(row[idxSubcategoria]) : null,
    });
  }

  return out;
}

// ─── Backfill para uma farmácia ──────────────────────────────────────────────

type BackfillStats = {
  excelRows: number;
  produtosFound: number;
  produtoFarmaciaFound: number;
  updated: number;
  skippedExisting: number;
  skippedNoValue: number;
};

async function backfillForFarmacia(
  filePath: string,
  farmaciaId: string,
  args: Args
): Promise<BackfillStats> {
  const stats: BackfillStats = {
    excelRows: 0,
    produtosFound: 0,
    produtoFarmaciaFound: 0,
    updated: 0,
    skippedExisting: 0,
    skippedNoValue: 0,
  };

  const origens = parseOrigemFromExcel(filePath);
  stats.excelRows = origens.length;

  // Mapa CNP → produtoId (produtos que existem na BD)
  const cnps = origens.map((o) => o.cnp);
  const produtos = await prisma.produto.findMany({
    where: { cnp: { in: cnps } },
    select: { id: true, cnp: true },
  });
  const cnpToProdutoId = new Map(produtos.map((p) => [p.cnp, p.id]));
  stats.produtosFound = produtos.length;

  // Mapa produtoId → estado actual de origem
  const produtoIds = [...cnpToProdutoId.values()];
  const pfs = await prisma.produtoFarmacia.findMany({
    where: { farmaciaId, produtoId: { in: produtoIds } },
    select: {
      id: true,
      produtoId: true,
      fornecedorOrigem: true,
      categoriaOrigem: true,
      subcategoriaOrigem: true,
    },
  });
  const pfMap = new Map(pfs.map((pf) => [pf.produtoId, pf]));
  stats.produtoFarmaciaFound = pfs.length;

  // Construir lista de updates
  type UpdatePlan = {
    pfId: string;
    data: Partial<{
      fornecedorOrigem: string;
      categoriaOrigem: string;
      subcategoriaOrigem: string;
    }>;
  };
  const plans: UpdatePlan[] = [];

  for (const o of origens) {
    const produtoId = cnpToProdutoId.get(o.cnp);
    if (!produtoId) continue;
    const pf = pfMap.get(produtoId);
    if (!pf) continue;

    // Só escreve o que tem valor no Excel
    const hasAny = o.fornecedorOrigem || o.categoriaOrigem || o.subcategoriaOrigem;
    if (!hasAny) { stats.skippedNoValue++; continue; }

    const data: UpdatePlan["data"] = {};

    if (o.fornecedorOrigem && (args.force || pf.fornecedorOrigem === null)) {
      data.fornecedorOrigem = o.fornecedorOrigem;
    }
    if (o.categoriaOrigem && (args.force || pf.categoriaOrigem === null)) {
      data.categoriaOrigem = o.categoriaOrigem;
    }
    if (o.subcategoriaOrigem && (args.force || pf.subcategoriaOrigem === null)) {
      data.subcategoriaOrigem = o.subcategoriaOrigem;
    }

    if (Object.keys(data).length === 0) {
      stats.skippedExisting++;
      continue;
    }

    plans.push({ pfId: pf.id, data });
  }

  if (args.dryRun) {
    stats.updated = plans.length;
    return stats;
  }

  // Aplicar em chunks de 100 updates concorrentes
  const CHUNK = 100;
  for (let i = 0; i < plans.length; i += CHUNK) {
    const batch = plans.slice(i, i + CHUNK);
    await Promise.all(
      batch.map((p) =>
        prisma.produtoFarmacia.update({
          where: { id: p.pfId },
          data: p.data,
        })
      )
    );
  }
  stats.updated = plans.length;

  return stats;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const FILES_DIR = path.join(process.cwd(), "example_files");

const TARGETS = [
  { file: "MapaEvolucaoVendas.xlsx",   farmacia: "Farmácia Principal" },
  { file: "MapaEvolucaoVendas_c.xlsx", farmacia: "Farmácia Castelo" },
];

function printStats(label: string, stats: BackfillStats, dryRun: boolean): void {
  const tag = dryRun ? " (simulado)" : "";
  console.log(`  Linhas no Excel        : ${stats.excelRows}`);
  console.log(`  Produtos encontrados    : ${stats.produtosFound}`);
  console.log(`  ProdutoFarmacia encontr.: ${stats.produtoFarmaciaFound}`);
  console.log(`  Actualizados${tag}     : ${stats.updated}`);
  console.log(`  Saltados (já preenchido): ${stats.skippedExisting}`);
  console.log(`  Saltados (sem valor)    : ${stats.skippedNoValue}`);
  void label;
}

async function main(): Promise<void> {
  const args = parseArgs();

  console.log("─".repeat(66));
  console.log("SPharm.MT — Backfill ProdutoFarmacia.*Origem");
  console.log("─".repeat(66));
  if (args.dryRun) console.log("Modo: DRY-RUN (nenhuma escrita)");
  if (args.force)  console.log("Modo: FORCE (sobrescreve valores existentes)");
  console.log();

  const totals: BackfillStats = {
    excelRows: 0,
    produtosFound: 0,
    produtoFarmaciaFound: 0,
    updated: 0,
    skippedExisting: 0,
    skippedNoValue: 0,
  };

  for (const t of TARGETS) {
    const farmaciaId = await ensureFarmacia(t.farmacia);
    const filePath = path.join(FILES_DIR, t.file);
    console.log(`▶ ${t.farmacia} — ${t.file}`);
    const stats = await backfillForFarmacia(filePath, farmaciaId, args);
    printStats(t.farmacia, stats, args.dryRun);
    console.log();

    totals.excelRows            += stats.excelRows;
    totals.produtosFound        += stats.produtosFound;
    totals.produtoFarmaciaFound += stats.produtoFarmaciaFound;
    totals.updated              += stats.updated;
    totals.skippedExisting      += stats.skippedExisting;
    totals.skippedNoValue       += stats.skippedNoValue;
  }

  console.log("─".repeat(66));
  console.log("TOTAIS");
  console.log("─".repeat(66));
  printStats("totais", totals, args.dryRun);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("\n[erro fatal]", err);
  prisma.$disconnect().finally(() => process.exit(1));
});
