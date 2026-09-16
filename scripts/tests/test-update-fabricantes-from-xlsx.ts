/**
 * scripts/tests/test-update-fabricantes-from-xlsx.ts
 *
 * Investigação (2026-09): CNP 1100921 (INTIMINA ESTERILIZADOR COPO
 * MENSTRUAL) tinha "DISFAPORT DIRECTO" no Excel de gamas do fabricante,
 * mas a ficha do produto no SPharm.MT ficava com Fabricante vazio ("—").
 *
 * Causa encontrada: `scripts/update-fabricantes-from-xlsx.ts` tinha um
 * cutoff `cnp <= MIN_CNP` (2_000_000) copiado de
 * `import-regulatory-record.ts` — lá faz sentido (listagens INFARMED, CNP
 * baixo = taxa/acto clínico); aqui não, porque este script já só actualiza
 * produtos que existem de facto em `Produto` (`produtoCnps.has(cnp)`).
 * 1100921 é um artigo de parafarmácia REAL, mais antigo, com CNP
 * sequencial baixo — a linha era descartada ANTES de a coluna Fabricante
 * ser sequer lida, sem qualquer tier/validadoManualmente/sync ERP
 * envolvido: o importador simplesmente nunca gravava nada para este CNP.
 *
 * Esta suite prova, sem BD viva (só `parseFile`, puro):
 *   1. o CNP 1100921 já não é descartado — a linha chega com o fabricante
 *      correcto do Excel;
 *   2. a única guarda que resta (`produtoCnps.has(cnp)`) continua a
 *      proteger contra CNP que não existem como Produto;
 *   3. "sem fabricante na coluna" continua a ser descartado, seja qual for
 *      o CNP;
 *   4. ponta-a-ponta com uma simulação leve do ciclo escrita→leitura,
 *      provando que a ficha (que lê `Produto.fabricante.nomeNormalizado`)
 *      devolveria "DISFAPORT DIRECTO" depois da importação.
 *
 * Corre com:  npx tsx scripts/tests/test-update-fabricantes-from-xlsx.ts
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as XLSX from "xlsx";
import { parseFile, normalizeFabricanteNome, type ParsedRow } from "../update-fabricantes-from-xlsx";

let pass = 0;
let fail = 0;
const ok = (label: string, cond: boolean, detalhe?: string) => {
  if (cond) {
    pass++;
    console.log(`  [OK]    ${label}`);
  } else {
    fail++;
    console.log(`  [FALHA] ${label}${detalhe ? ` — ${detalhe}` : ""}`);
  }
};
const eq = <T>(label: string, obtido: T, esperado: T) =>
  ok(label, Object.is(obtido, esperado), `esperado ${JSON.stringify(esperado)}, obtido ${JSON.stringify(obtido)}`);

// ─────────────────────────────────────────────────────────────────────────
// Fixture — mesmo formato posicional do script (sem cabeçalho):
//   col0=cnp col1=estado col2=designacao col3=fabricante
// ─────────────────────────────────────────────────────────────────────────

function buildXlsxFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabricantes-xlsx-"));
  const file = path.join(dir, "gamas.xlsx");
  const rows = [
    [1100921, "Autorizado", "INTIMINA ESTERILIZADOR COPO MENSTRUAL", "DISFAPORT DIRECTO"], // o caso real — cnp <= 2_000_000
    [5000001, "Autorizado", "Produto A", "Bayer AG"], // cnp normal, para contraste
    [1200000, "Autorizado", "Produto fora do catálogo desta farmácia", "Fabricante Fantasma"], // cnp baixo, NÃO é Produto conhecido
    [5000002, "Autorizado", "Produto sem fabricante no Excel", ""], // fabricante vazio na coluna
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  XLSX.writeFile(wb, file);
  return file;
}

// ─────────────────────────────────────────────────────────────────────────
// A. parseFile — CNP 1100921 já não é descartado pelo cutoff
// ─────────────────────────────────────────────────────────────────────────

function testParseFile(): string {
  console.log("\n=== A. parseFile — CNP 1100921 sobrevive, guardas reais continuam a funcionar ===");

  const file = buildXlsxFixture();
  // Produto conhecido nesta farmácia: 1100921 e 5000001 e 5000002 existem;
  // 1200000 NÃO existe (simula "não é Produto desta farmácia/tenant").
  const produtoCnps = new Set<number>([1100921, 5000001, 5000002]);

  const stats = parseFile(file, null, produtoCnps);

  const linha1100921 = stats.rows.find((r) => r.cnp === 1100921);
  ok(
    "CNP 1100921 aparece nas linhas a processar (já não é descartado por cnp<=2_000_000)",
    linha1100921 !== undefined,
    JSON.stringify(stats.rows),
  );
  eq("…com o fabricante exacto do Excel", linha1100921?.fabricanteRaw, "DISFAPORT DIRECTO");

  const linha5000001 = stats.rows.find((r) => r.cnp === 5000001);
  ok("CNP alto normal continua a funcionar (sem regressão)", linha5000001?.fabricanteRaw === "Bayer AG");

  eq(
    "CNP 1200000 (baixo, mas NÃO é Produto conhecido) continua filtrado — a guarda real preservada",
    stats.filteredNotInProduto,
    1,
  );
  eq(
    "CNP 5000002 (fabricante vazio na coluna) continua descartado, independentemente do CNP",
    stats.missingFabricante,
    1,
  );
  eq("no total, só as 2 linhas legítimas chegam a processar", stats.rows.length, 2);

  return file;
}

// ─────────────────────────────────────────────────────────────────────────
// B. Ponta-a-ponta — simulação leve do ciclo escrita→leitura da ficha
// ─────────────────────────────────────────────────────────────────────────
//
// Reproduz exactamente a lógica de `processBatches` (normaliza o nome,
// obtém/cria o Fabricante, grava `Produto.fabricanteId`) com um Map em vez
// de Prisma — sem precisar de BD viva — e depois lê pelo MESMO caminho que
// a ficha do produto usa (`Produto.fabricante.nomeNormalizado`, ver
// app/stock/artigo/[cnp]/page.tsx e app/catalogo/artigo/[cnp]/page.tsx).

type ProdutoFake = { cnp: number; fabricanteId: string | null };
type FabricanteFake = { id: string; nomeNormalizado: string };

function aplicarLinhas(rows: ParsedRow[], produtos: Map<number, ProdutoFake>) {
  const fabricantesPorNome = new Map<string, FabricanteFake>();
  let novoId = 0;
  for (const r of rows) {
    const nomeNorm = normalizeFabricanteNome(r.fabricanteRaw);
    let fab = fabricantesPorNome.get(nomeNorm);
    if (!fab) {
      fab = { id: `fab-${++novoId}`, nomeNormalizado: nomeNorm };
      fabricantesPorNome.set(nomeNorm, fab);
    }
    const produto = produtos.get(r.cnp);
    if (produto) produto.fabricanteId = fab.id;
  }
  return fabricantesPorNome;
}

/** Simula a leitura que a ficha do produto faz: Produto.fabricanteId → Fabricante.nomeNormalizado. */
function lerFichaFabricante(
  cnp: number,
  produtos: Map<number, ProdutoFake>,
  fabricantes: Map<string, FabricanteFake>,
): string | null {
  const produto = produtos.get(cnp);
  if (!produto?.fabricanteId) return null;
  const fab = [...fabricantes.values()].find((f) => f.id === produto.fabricanteId);
  return fab?.nomeNormalizado ?? null;
}

function testFichaDevolveFabricanteDepoisDaImportacao(file: string): void {
  console.log("\n=== B. Ponta-a-ponta: depois da importação, a ficha devolve o fabricante ===");

  const produtoCnps = new Set<number>([1100921, 5000001, 5000002]);
  const stats = parseFile(file, null, produtoCnps);

  // Produto real, já existente, SEM fabricante — exactamente o sintoma
  // relatado ("—" na ficha).
  const produtos = new Map<number, ProdutoFake>([
    [1100921, { cnp: 1100921, fabricanteId: null }],
    [5000001, { cnp: 5000001, fabricanteId: null }],
  ]);
  ok("ANTES da importação: ficha sem fabricante (fabricanteId null)", produtos.get(1100921)?.fabricanteId === null);

  const fabricantes = aplicarLinhas(stats.rows, produtos);

  const fabricanteNaFicha = lerFichaFabricante(1100921, produtos, fabricantes);
  eq(
    "DEPOIS da importação: a ficha do produto (CNP 1100921) devolve DISFAPORT DIRECTO",
    fabricanteNaFicha,
    "DISFAPORT DIRECTO",
  );

  const fabricanteBayer = lerFichaFabricante(5000001, produtos, fabricantes);
  eq("…e o outro produto (CNP 5000001) continua a funcionar normalmente", fabricanteBayer, "BAYER AG");
}

function limpar(file: string): void {
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
}

async function main() {
  const file = testParseFile();
  testFichaDevolveFabricanteDepoisDaImportacao(file);
  limpar(file);

  console.log(`\n${fail === 0 ? "PASSOU" : "FALHOU"} — ${pass} OK, ${fail} falhas\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
