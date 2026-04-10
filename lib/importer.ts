/**
 * lib/importer.ts
 *
 * Lógica de importação dos ficheiros Excel para a base de dados.
 *
 * Estrutura dos ficheiros:
 *
 * MapaEvolucaoVendas[_c].xlsx
 *   col 0  Codigo              → Produto.cnp
 *   col 1  Nome Comercial      → Produto.designacao
 *   col 2  Fornecedor Habitual → (ignorado neste import)
 *   col 3  Existencia Actual   → (vem do stock, ignorado aqui)
 *   col 4  PMC                 → ProdutoFarmacia.pmc  (custo médio de compra)
 *   col 5  Preco Venda Publico_Eur → ProdutoFarmacia.pvp
 *   col 6+ [jan 2025 … abr 2026]  → VendaMensal.quantidade
 *   penúltima  Total Vendas    → (ignorado — soma das mensais)
 *   Categoria / SubCategoria   → (ignorado neste import)
 *
 * stock_Atual[_castelo].xlsx
 *   col 0  Texto4        → Produto.cnp
 *   col 1  Text179       → Produto.designacao
 *   col 2  Text219       → IVA (ignorado)
 *   col 3  txtExistencia → ProdutoFarmacia.stockAtual
 *   col 4  txtCompra     → ProdutoFarmacia.puc  (custo de compra actual)
 *   col 5  txtValor      → (derivado: stockAtual * puc — ignorado)
 */

import * as XLSX from "xlsx";
import { prisma } from "@/lib/prisma";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MES_NOMES: Record<string, number> = {
  jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6,
  jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12,
};

/** Converte "jan 2025" → { mes: 1, ano: 2025 } ou null */
function parseMesColuna(col: string): { mes: number; ano: number } | null {
  const m = col.trim().match(/^([a-záàâã]{3})\s+(\d{4})$/i);
  if (!m) return null;
  const mes = MES_NOMES[m[1].toLowerCase()];
  if (!mes) return null;
  return { mes, ano: parseInt(m[2], 10) };
}

/** Divide um array em chunks de `size` elementos */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Garante que a farmácia existe; devolve o id */
export async function ensureFarmacia(nome: string): Promise<string> {
  const f = await prisma.farmacia.upsert({
    where: { nome },
    create: { nome },
    update: {},
    select: { id: true },
  });
  return f.id;
}

/**
 * Obtém (ou cria) Produto por CNP em batch.
 * Devolve Map<cnp, produtoId>.
 */
async function batchEnsureProdutos(
  rows: Array<{ cnp: number; designacao: string }>
): Promise<Map<number, string>> {
  // Deduplicar por CNP (mantém primeira ocorrência)
  const unique = new Map<number, string>();
  for (const r of rows) {
    if (!unique.has(r.cnp)) unique.set(r.cnp, r.designacao);
  }
  const allCnps = [...unique.keys()];

  // Buscar existentes
  const existing = await prisma.produto.findMany({
    where: { cnp: { in: allCnps } },
    select: { id: true, cnp: true },
  });
  const cnpMap = new Map<number, string>(existing.map((p) => [p.cnp, p.id]));

  // Criar em falta
  const missing = allCnps
    .filter((cnp) => !cnpMap.has(cnp))
    .map((cnp) => ({ cnp, designacao: unique.get(cnp)!, origemDados: "EXCEL" as const }));

  if (missing.length > 0) {
    await prisma.produto.createMany({ data: missing, skipDuplicates: true });
    const created = await prisma.produto.findMany({
      where: { cnp: { in: missing.map((r) => r.cnp) } },
      select: { id: true, cnp: true },
    });
    for (const p of created) cnpMap.set(p.cnp, p.id);
  }

  return cnpMap;
}

// ─── Import Vendas ─────────────────────────────────────────────────────────────

export type ImportSalesResult = {
  produtos: number;
  vendasMensais: number;
  skipped: number;
};

/**
 * Importa um ficheiro MapaEvolucaoVendas para a BD.
 *
 * - Cria produtos em falta pelo CNP
 * - Atualiza ProdutoFarmacia.pmc e ProdutoFarmacia.pvp
 * - Apaga e re-insere VendaMensal para os meses presentes no ficheiro
 *   (idempotente: pode ser re-executado sem duplicar dados)
 *
 * valorTotal = quantidade × pvp  (melhor aproximação de receita disponível)
 */
export async function importSalesFromExcel(
  filePath: string,
  farmaciaId: string
): Promise<ImportSalesResult> {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 }) as unknown[][];
  if (rows.length < 2) return { produtos: 0, vendasMensais: 0, skipped: 0 };

  const header = rows[0] as string[];

  // Identificar colunas mensais e os seus índices
  const mesCols: Array<{ idx: number; mes: number; ano: number }> = [];
  for (let i = 0; i < header.length; i++) {
    const p = parseMesColuna(String(header[i] ?? ""));
    if (p) mesCols.push({ idx: i, ...p });
  }
  if (mesCols.length === 0) {
    throw new Error(`Nenhuma coluna mensal encontrada em ${filePath}`);
  }

  // Índices das colunas de preço (busca flexível por nome)
  const colNomeLower = header.map((h) => String(h ?? "").toLowerCase().trim());
  const idxPmc = colNomeLower.indexOf("pmc");
  const idxPvp = colNomeLower.findIndex((h) => h.startsWith("preco") || h.includes("pvp"));

  // ── Parse de todas as linhas ────────────────────────────────────────────────
  type ParsedRow = {
    cnp: number;
    designacao: string;
    pmc: number | null;
    pvp: number | null;
    meses: Array<{ mes: number; ano: number; quantidade: number }>;
  };

  const parsed: ParsedRow[] = [];
  let skipped = 0;

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] as unknown[];
    const cnpRaw = row[0];
    const designacao = String(row[1] ?? "").trim();

    if (!cnpRaw || !designacao) { skipped++; continue; }
    const cnp = Math.round(Number(cnpRaw));
    if (!Number.isFinite(cnp) || cnp <= 0) { skipped++; continue; }

    const pmc = idxPmc >= 0 && row[idxPmc] != null ? (Number(row[idxPmc]) || null) : null;
    const pvp = idxPvp >= 0 && row[idxPvp] != null ? (Number(row[idxPvp]) || null) : null;

    const meses: ParsedRow["meses"] = [];
    for (const { idx, mes, ano } of mesCols) {
      const raw = row[idx];
      if (raw === undefined || raw === null || raw === "") continue;
      const quantidade = Number(raw);
      // Ignorar zeros e valores não-numéricos (evita criação de registos vazios)
      if (!Number.isFinite(quantidade) || quantidade === 0) continue;
      meses.push({ mes, ano, quantidade });
    }

    parsed.push({ cnp, designacao, pmc, pvp, meses });
  }

  // ── Batch upsert Produto ────────────────────────────────────────────────────
  const cnpMap = await batchEnsureProdutos(parsed);

  // ── Batch upsert ProdutoFarmacia (pmc, pvp) ─────────────────────────────────
  // Deduplicar por cnp, depois agrupar em chunks de 50 upserts concorrentes
  const seenCnps = new Set<number>();
  const pfRows = parsed
    .filter((r) => {
      if (seenCnps.has(r.cnp)) return false;
      seenCnps.add(r.cnp);
      return cnpMap.has(r.cnp);
    })
    .map((r) => ({
      produtoId: cnpMap.get(r.cnp)!,
      farmaciaId,
      pmc: r.pmc,
      pvp: r.pvp,
    }));

  for (const c of chunk(pfRows, 50)) {
    await Promise.all(
      c.map((pf) =>
        prisma.produtoFarmacia.upsert({
          where: {
            produtoId_farmaciaId: { produtoId: pf.produtoId, farmaciaId },
          },
          create: {
            produtoId: pf.produtoId,
            farmaciaId,
            ...(pf.pmc !== null ? { pmc: pf.pmc } : {}),
            ...(pf.pvp !== null ? { pvp: pf.pvp } : {}),
          },
          update: {
            ...(pf.pmc !== null ? { pmc: pf.pmc } : {}),
            ...(pf.pvp !== null ? { pvp: pf.pvp } : {}),
          },
        })
      )
    );
  }

  // ── Limpar VendaMensal existente para estes meses (idempotência) ─────────────
  // Apaga apenas os registos dos meses presentes no ficheiro para esta farmácia
  const periodos = mesCols.map((c) => ({ ano: c.ano, mes: c.mes }));
  await prisma.vendaMensal.deleteMany({
    where: {
      farmaciaId,
      OR: periodos.map(({ ano, mes }) => ({ ano, mes })),
    },
  });

  // ── Batch insert VendaMensal ─────────────────────────────────────────────────
  type VendaRow = {
    farmaciaId: string;
    produtoId: string;
    ano: number;
    mes: number;
    quantidade: number;
    valorTotal: number;
    origemBootstrap: boolean;
  };

  const vendaRows: VendaRow[] = [];
  for (const r of parsed) {
    const produtoId = cnpMap.get(r.cnp);
    if (!produtoId) continue;
    // valorTotal = quantidade × pvp (preço de venda público)
    // Fallback: pmc (custo) se pvp não disponível — valorTotal será subavaliado
    const precoVenda = r.pvp ?? r.pmc ?? 0;
    for (const { mes, ano, quantidade } of r.meses) {
      vendaRows.push({
        farmaciaId,
        produtoId,
        ano,
        mes,
        quantidade,
        valorTotal: quantidade * precoVenda,
        origemBootstrap: true,
      });
    }
  }

  // Inserir em chunks de 1000 (createMany é muito mais eficiente que upserts individuais)
  for (const c of chunk(vendaRows, 1000)) {
    await prisma.vendaMensal.createMany({ data: c, skipDuplicates: true });
  }

  return { produtos: cnpMap.size, vendasMensais: vendaRows.length, skipped };
}

// ─── Import Stock ──────────────────────────────────────────────────────────────

export type ImportStockResult = {
  imported: number;
  skipped: number;
};

/**
 * Importa um ficheiro stock_Atual para a BD.
 *
 * - Cria produtos em falta pelo CNP
 * - Atualiza ProdutoFarmacia.stockAtual e ProdutoFarmacia.puc
 * - Não afecta pmc/pvp (definidos pelo importSalesFromExcel)
 */
export async function importStockFromExcel(
  filePath: string,
  farmaciaId: string
): Promise<ImportStockResult> {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 }) as unknown[][];
  if (rows.length < 2) return { imported: 0, skipped: 0 };

  // ── Parse ───────────────────────────────────────────────────────────────────
  type StockRow = {
    cnp: number;
    designacao: string;
    stockAtual: number | null;
    puc: number | null;
  };

  const parsed: StockRow[] = [];
  let skipped = 0;

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] as unknown[];
    const cnpRaw = row[0];
    const designacao = String(row[1] ?? "").trim();

    if (!cnpRaw || !designacao) { skipped++; continue; }
    const cnp = Math.round(Number(cnpRaw));
    if (!Number.isFinite(cnp) || cnp <= 0) { skipped++; continue; }

    const stockAtual = row[3] != null ? Number(row[3]) : null;
    // puc = 0 em alguns registos (produto sem custo definido) → tratar como null
    const puc = row[4] != null && Number(row[4]) > 0 ? Number(row[4]) : null;

    parsed.push({ cnp, designacao, stockAtual, puc });
  }

  // ── Batch upsert Produto ────────────────────────────────────────────────────
  const cnpMap = await batchEnsureProdutos(parsed);

  // ── Batch upsert ProdutoFarmacia (stockAtual, puc) ──────────────────────────
  const pfRows = parsed
    .filter((r) => cnpMap.has(r.cnp))
    .map((r) => ({
      produtoId: cnpMap.get(r.cnp)!,
      farmaciaId,
      stockAtual: r.stockAtual,
      puc: r.puc,
    }));

  let imported = 0;
  for (const c of chunk(pfRows, 50)) {
    await Promise.all(
      c.map((pf) =>
        prisma.produtoFarmacia.upsert({
          where: {
            produtoId_farmaciaId: { produtoId: pf.produtoId, farmaciaId },
          },
          create: {
            produtoId: pf.produtoId,
            farmaciaId,
            stockAtual: pf.stockAtual,
            ...(pf.puc !== null ? { puc: pf.puc } : {}),
          },
          update: {
            stockAtual: pf.stockAtual,
            // Só actualiza puc se tiver valor — não apaga dados de importação anterior
            ...(pf.puc !== null ? { puc: pf.puc } : {}),
          },
        })
      )
    );
    imported += c.length;
  }

  return { imported, skipped };
}
