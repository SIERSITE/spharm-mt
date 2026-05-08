/**
 * scripts/diagnose-infarmed-snapshot.ts
 *
 * Diagnóstico READ-ONLY do estado actual de `InfarmedSnapshot` e do(s)
 * ficheiro(s) fonte usado(s) pelo importador. ZERO writes.
 *
 * Responde:
 *   1. Total de registos em InfarmedSnapshot.
 *   2. Quantos têm CNP válido (> 2.000.000).
 *   3. Quantos têm `dci` preenchido.
 *   4. Quantos têm `codigoATC` preenchido.
 *   5. Quantos têm forma/dosagem/embalagem.
 *   6. Origem/ficheiro usado no import (path + tamanho + nº linhas + nº colunas).
 *   7. O importador descarta ATC/DCI ou a fonte não os traz?
 *      → resposta vinda da inspecção combinada do código + ficheiros fonte.
 *   8. Para 20 medicamentos reais ausentes do snapshot, confirmar se o CNP
 *      existe ou não na fonte.
 *
 * Uso:
 *   npx tsx scripts/diagnose-infarmed-snapshot.ts
 */

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import * as XLSX from "xlsx";
import { legacyPrisma as prisma } from "../lib/prisma";

const SOURCE_CSV = "example_files/fabricante.csv";
const SOURCE_XLSX = "example_files/novo_fabricante.xlsx";

// 20 medicamentos reais (vindos do diagnóstico anterior — todos "manter
// MEDICAMENTO" com conf 0.90, todos com ATC=null/DCI=null no snapshot
// e todos com snap=out, ou seja, ausentes da snapshot tabela).
const TEST_CNPS_KNOWN_MED: Array<{ cnp: number; nome: string }> = [
  { cnp: 2047280, nome: "Decapeptyl 3.75 Mg/2 Ml Pó (triptorelina)" },
  { cnp: 2115889, nome: "Hyalart 20 Mg/2 Ml Sol. Injetável (ácido hialurónico)" },
  { cnp: 2300796, nome: "Bromocriptina Generis 2.5 Mg" },
  { cnp: 2433084, nome: "Neurontin 100 Mg (gabapentina)" },
  { cnp: 2441889, nome: "Twinrix Adulto Vacina" },
  { cnp: 2455483, nome: "Dermestril 25 (estradiol transdérmico)" },
  { cnp: 2505485, nome: "DUROGESIC 75 µg/h (fentanilo transdérmico)" },
  { cnp: 2505584, nome: "Durogesic 100 µg/h" },
  { cnp: 2632685, nome: "Travex 50 Mg" },
  { cnp: 2638682, nome: "Femsete 50 µg/24 H Sistema Transdérmico" },
  { cnp: 2707784, nome: "Exelon 1.5 Mg (rivastigmina)" },
  { cnp: 2708089, nome: "Exelon 3 Mg 28" },
  { cnp: 2809598, nome: "Azitromicina Azitrix 500 Mg" },
  { cnp: 2816882, nome: "Innohep 10000 U.i. Anti-xa (tinzaparina)" },
  { cnp: 3221496, nome: "TOPAMAX 15 MG (topiramato)" },
  { cnp: 3256385, nome: "Etalpha 0.5 µg (alfacalcidol)" },
  { cnp: 3368289, nome: "Aciclovir Generis 200 Mg" },
  { cnp: 3404688, nome: "ESPIRONOLACTONA GENERIS 100 MG" },
  { cnp: 3545092, nome: "Captopril Generis 25 Mg" },
  { cnp: 3685096, nome: "Atenolol Generis 50 Mg" },
];

// ─── Source readers ──────────────────────────────────────────────────────────

type SourceStats = {
  path: string;
  exists: boolean;
  sizeMb: number;
  totalRows: number;
  fieldsPerRow: number; // baseado em amostra
  cnps: Set<number>;
  cnpToRow: Map<number, string[]>;
};

function readCsvSource(filePath: string): SourceStats {
  const stats: SourceStats = {
    path: filePath,
    exists: false,
    sizeMb: 0,
    totalRows: 0,
    fieldsPerRow: 0,
    cnps: new Set(),
    cnpToRow: new Map(),
  };
  if (!fs.existsSync(filePath)) return stats;
  stats.exists = true;
  stats.sizeMb = fs.statSync(filePath).size / (1024 * 1024);

  // CSV pode ser ; ou , — fabricante.csv usa ;. Vamos detectar pelo header.
  const raw = fs.readFileSync(filePath, "utf-8");
  const lines = raw.split(/\r?\n/);
  stats.totalRows = lines.filter((l) => l.trim().length > 0).length;
  if (lines.length > 0) {
    // Detecta delimitador na primeira linha
    const first = lines[0];
    const delim = first.includes(";") ? ";" : ",";
    stats.fieldsPerRow = first.split(delim).length;

    for (const line of lines) {
      if (!line.trim()) continue;
      const fields = line.split(delim);
      const cnpRaw = fields[0];
      const cnp = Math.round(Number(String(cnpRaw).replace(/[^\d]/g, "")));
      if (Number.isFinite(cnp) && cnp > 0) {
        stats.cnps.add(cnp);
        // Só guarda em memória os CNPs de teste (poupa RAM em 283k linhas)
        if (TEST_CNPS_KNOWN_MED.some((t) => t.cnp === cnp)) {
          stats.cnpToRow.set(cnp, fields);
        }
      }
    }
  }
  return stats;
}

function readXlsxSource(filePath: string): SourceStats {
  const stats: SourceStats = {
    path: filePath,
    exists: false,
    sizeMb: 0,
    totalRows: 0,
    fieldsPerRow: 0,
    cnps: new Set(),
    cnpToRow: new Map(),
  };
  if (!fs.existsSync(filePath)) return stats;
  stats.exists = true;
  stats.sizeMb = fs.statSync(filePath).size / (1024 * 1024);

  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 }) as unknown[][];
  stats.totalRows = rows.length;
  if (rows.length > 0) {
    stats.fieldsPerRow = Math.max(
      ...rows.slice(0, 50).map((r) => (Array.isArray(r) ? r.length : 0)),
    );
    for (const row of rows) {
      if (!Array.isArray(row) || row.length === 0) continue;
      const cnpRaw = row[0];
      const cnp = Math.round(Number(String(cnpRaw ?? "").replace(/[^\d]/g, "")));
      if (Number.isFinite(cnp) && cnp > 0) {
        stats.cnps.add(cnp);
        if (TEST_CNPS_KNOWN_MED.some((t) => t.cnp === cnp)) {
          stats.cnpToRow.set(cnp, row.map((x) => String(x ?? "")));
        }
      }
    }
  }
  return stats;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("═".repeat(74));
  console.log("Diagnóstico — InfarmedSnapshot + ficheiros fonte");
  console.log("READ-ONLY — zero writes");
  console.log("═".repeat(74));

  // 1–5. Counts no InfarmedSnapshot
  const [
    total,
    validCnp,
    withDci,
    withAtc,
    withForma,
    withDosagem,
    withEmbalagem,
    withGrupo,
    withTitular,
    withEstado,
    withDesignacao,
  ] = await Promise.all([
    prisma.infarmedSnapshot.count(),
    prisma.infarmedSnapshot.count({ where: { cnp: { gt: 2_000_000 } } }),
    prisma.infarmedSnapshot.count({ where: { dci: { not: null } } }),
    prisma.infarmedSnapshot.count({ where: { codigoATC: { not: null } } }),
    prisma.infarmedSnapshot.count({ where: { formaFarmaceutica: { not: null } } }),
    prisma.infarmedSnapshot.count({ where: { dosagem: { not: null } } }),
    prisma.infarmedSnapshot.count({ where: { embalagem: { not: null } } }),
    prisma.infarmedSnapshot.count({ where: { grupoTerapeutico: { not: null } } }),
    prisma.infarmedSnapshot.count({ where: { titularAim: { not: null } } }),
    prisma.infarmedSnapshot.count({ where: { estadoAim: { not: null } } }),
    prisma.infarmedSnapshot.count({ where: { designacaoOficial: { not: "" } } }),
  ]);

  const pct = (n: number, d: number) =>
    d === 0 ? "—" : `${((n / d) * 100).toFixed(1)}%`;

  console.log("\n— InfarmedSnapshot — contadores —");
  console.log(`  total registos:                  ${total}`);
  console.log(`  com CNP > 2.000.000:             ${validCnp} (${pct(validCnp, total)})`);
  console.log(`  com designacaoOficial ≠ '':      ${withDesignacao} (${pct(withDesignacao, total)})`);
  console.log(`  com titularAim preenchido:       ${withTitular} (${pct(withTitular, total)})`);
  console.log(`  com estadoAim preenchido:        ${withEstado} (${pct(withEstado, total)})`);
  console.log(`  com codigoATC preenchido:        ${withAtc} (${pct(withAtc, total)})`);
  console.log(`  com dci preenchido:              ${withDci} (${pct(withDci, total)})`);
  console.log(`  com formaFarmaceutica preenchida:${withForma} (${pct(withForma, total)})`);
  console.log(`  com dosagem preenchida:          ${withDosagem} (${pct(withDosagem, total)})`);
  console.log(`  com embalagem preenchida:        ${withEmbalagem} (${pct(withEmbalagem, total)})`);
  console.log(`  com grupoTerapeutico preenchido: ${withGrupo} (${pct(withGrupo, total)})`);

  // Distribuição estadoAim
  const estadoCounts = await prisma.infarmedSnapshot.groupBy({
    by: ["estadoAim"],
    _count: { _all: true },
  });
  console.log("\n  Distribuição estadoAim:");
  const sortedEstados = [...estadoCounts].sort(
    (a, b) => b._count._all - a._count._all,
  );
  for (const e of sortedEstados.slice(0, 10)) {
    console.log(`    ${(e.estadoAim ?? "(null)").padEnd(28)} ${e._count._all}`);
  }

  // 6. Origem dos ficheiros fonte
  console.log("\n— Ficheiros fonte (em /example_files) —");
  const csvSource = readCsvSource(path.resolve(SOURCE_CSV));
  const xlsxSource = readXlsxSource(path.resolve(SOURCE_XLSX));

  for (const s of [csvSource, xlsxSource]) {
    console.log(`\n  ${s.path}`);
    if (!s.exists) {
      console.log("    (não existe)");
      continue;
    }
    console.log(`    tamanho:        ${s.sizeMb.toFixed(2)} MB`);
    console.log(`    total linhas:   ${s.totalRows}`);
    console.log(`    colunas:        ${s.fieldsPerRow} (amostra do header)`);
    console.log(`    CNPs únicos:    ${s.cnps.size}`);
  }

  // 7. Diagnóstico do importador (resposta directa)
  console.log("\n— O importador descarta ATC/DCI ou a fonte não os traz? —");
  console.log(`  Resposta: A FONTE NÃO OS TRAZ.`);
  console.log(
    `  · scripts/import-infarmed-snapshot.ts:22-32 documenta o formato:`,
  );
  console.log(
    `    "XLSX SEM CABEÇALHO, 4 colunas por posição: cnp, estado, designacao, fabricante."`,
  );
  console.log(
    `  · scripts/import-infarmed-snapshot.ts:245-253 atribui null hardcoded a:`,
  );
  console.log(`    dci, codigoATC, formaFarmaceutica, dosagem, embalagem, grupoTerapeutico.`);
  console.log(
    `  · Os ficheiros em example_files/ (fabricante.csv, novo_fabricante.xlsx)`,
  );
  console.log(`    confirmam ${csvSource.fieldsPerRow} colunas (apenas CNP/estado/designação/fabricante).`);
  console.log(`  → Uma fonte INFARMED com ATC/DCI/forma/dosagem nunca foi usada por este importador.`);

  // 8. Test CNPs — onde estão?
  console.log(`\n— 20 medicamentos reais ausentes do snapshot —`);
  console.log(`  (verifica se o CNP está na BD do Produto, no snapshot e nas fontes)`);
  console.log("");
  console.log(
    `  ${"CNP".padEnd(9)} ${"snap".padStart(5)} ${"csv".padStart(4)} ${"xlsx".padStart(5)} ${"prod".padStart(5)} Designação`,
  );

  let inSnap = 0;
  let inCsv = 0;
  let inXlsx = 0;
  let inProd = 0;

  for (const t of TEST_CNPS_KNOWN_MED) {
    const [snap, prod] = await Promise.all([
      prisma.infarmedSnapshot.findUnique({
        where: { cnp: t.cnp },
        select: { cnp: true, codigoATC: true, dci: true, estadoAim: true },
      }),
      prisma.produto.findUnique({
        where: { cnp: t.cnp },
        select: { id: true, designacao: true },
      }),
    ]);
    const isInSnap = !!snap;
    const isInCsv = csvSource.cnps.has(t.cnp);
    const isInXlsx = xlsxSource.cnps.has(t.cnp);
    const isInProd = !!prod;
    if (isInSnap) inSnap++;
    if (isInCsv) inCsv++;
    if (isInXlsx) inXlsx++;
    if (isInProd) inProd++;

    console.log(
      `  ${String(t.cnp).padEnd(9)} ` +
        `${(isInSnap ? "yes" : "no").padStart(5)} ${(isInCsv ? "yes" : "no").padStart(4)} ` +
        `${(isInXlsx ? "yes" : "no").padStart(5)} ${(isInProd ? "yes" : "no").padStart(5)} ` +
        `${t.nome}`,
    );
  }

  console.log(`\n  Totais nas 20 amostras:`);
  console.log(`    presentes em InfarmedSnapshot: ${inSnap}/20`);
  console.log(`    presentes em fabricante.csv:   ${inCsv}/20`);
  console.log(`    presentes em novo_fabricante.xlsx: ${inXlsx}/20`);
  console.log(`    presentes em Produto (BD):     ${inProd}/20`);

  console.log(`\n${"═".repeat(74)}`);
  console.log("Diagnóstico completo. Nenhum write efectuado.");
  console.log("═".repeat(74));
}

main()
  .catch((err) => {
    console.error("[erro fatal]", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
