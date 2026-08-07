/**
 * scripts/sync-rr-to-produto-broad.ts
 *
 * Sync broad: para qualquer Produto vivo onde algum dos 5 campos clínicos
 * (codigoATC, dci, formaFarmaceutica, dosagem, embalagem) está null E o
 * correspondente RegulatoryRecord tem valor, copia. Política preserve-non-null.
 *
 * Diferente de sync-regulatory-to-produto.ts (que lê CNPs de um mapping JSON
 * específico) — este NÃO depende de input file; usa o estado actual de
 * RegulatoryRecord como source-of-truth.
 *
 * Read-only por defeito (--dry-run); --apply escreve.
 */

import "dotenv/config";
import { legacyPrisma as prisma } from "../lib/prisma";

const FIELDS = ["codigoATC", "dci", "formaFarmaceutica", "dosagem", "embalagem"] as const;
type FieldName = (typeof FIELDS)[number];

type Args = { apply: boolean; sampleN: number };

function parseArgs(): Args {
  const out: Args = { apply: false, sampleN: 20 };
  for (const a of process.argv.slice(2)) {
    if (a === "--apply") out.apply = true;
    else if (a.startsWith("--sample=")) {
      const n = parseInt(a.split("=")[1], 10);
      if (!isNaN(n) && n >= 0 && n <= 200) out.sampleN = n;
    }
  }
  return out;
}

type ProdutoRow = {
  id: string;
  cnp: number;
  designacao: string;
  validadoManualmente: boolean;
  codigoATC: string | null;
  dci: string | null;
  formaFarmaceutica: string | null;
  dosagem: string | null;
  embalagem: string | null;
};

type RrRow = {
  cnp: number;
  codigoATC: string | null;
  dci: string | null;
  formaFarmaceutica: string | null;
  dosagem: string | null;
  embalagem: string | null;
};

function buildUpdates(p: ProdutoRow, r: RrRow): Partial<Record<FieldName, string>> {
  const upd: Partial<Record<FieldName, string>> = {};
  for (const f of FIELDS) {
    if (p[f] == null && r[f] != null) upd[f] = r[f] as string;
  }
  return upd;
}

async function main() {
  const args = parseArgs();
  const t0 = Date.now();
  console.log("─".repeat(74));
  console.log(`Sync RR → Produto BROAD (${args.apply ? "LIVE" : "DRY-RUN"})`);
  console.log("─".repeat(74));
  console.log(`  política:   só copia se Produto.<campo> == null`);
  console.log(`  ignora:     validadoManualmente=true`);
  console.log(`  scope:      todos os Produto vivos com pelo menos 1 campo clínico null`);

  console.log(`\n[1] Carregar Produto vivos com campos null...`);
  const produtos = (await prisma.produto.findMany({
    where: {
      estado: { not: "INATIVO" },
      validadoManualmente: false,
      OR: [
        { codigoATC: null },
        { dci: null },
        { formaFarmaceutica: null },
        { dosagem: null },
        { embalagem: null },
      ],
    },
    select: {
      id: true,
      cnp: true,
      designacao: true,
      validadoManualmente: true,
      codigoATC: true,
      dci: true,
      formaFarmaceutica: true,
      dosagem: true,
      embalagem: true,
    },
  })) as ProdutoRow[];
  console.log(`    candidates (Produto vivos c/ ≥1 null): ${produtos.length}`);

  if (produtos.length === 0) {
    console.log("Nada para sync.");
    return;
  }

  console.log(`\n[2] Carregar RegulatoryRecord para os CNPs candidates...`);
  const cnps = produtos.map((p) => p.cnp);
  const CHUNK = 10_000;
  const regs: RrRow[] = [];
  for (let i = 0; i < cnps.length; i += CHUNK) {
    const slice = cnps.slice(i, i + CHUNK);
    const found = (await prisma.regulatoryRecord.findMany({
      where: { cnp: { in: slice } },
      select: {
        cnp: true,
        codigoATC: true,
        dci: true,
        formaFarmaceutica: true,
        dosagem: true,
        embalagem: true,
      },
    })) as RrRow[];
    regs.push(...found);
  }
  const regByCnp = new Map(regs.map((r) => [r.cnp, r]));
  console.log(`    RR rows correspondentes: ${regs.length}`);

  console.log(`\n[3] Construir plano de updates...`);
  const wouldFill: Record<FieldName, number> = {
    codigoATC: 0,
    dci: 0,
    formaFarmaceutica: 0,
    dosagem: 0,
    embalagem: 0,
  };
  type Plan = { p: ProdutoRow; r: RrRow; updates: Partial<Record<FieldName, string>> };
  const plans: Plan[] = [];
  let unchanged = 0;
  let noRr = 0;
  for (const p of produtos) {
    const r = regByCnp.get(p.cnp);
    if (!r) {
      noRr++;
      continue;
    }
    const upd = buildUpdates(p, r);
    if (Object.keys(upd).length === 0) {
      unchanged++;
      continue;
    }
    for (const f of FIELDS) if (upd[f] != null) wouldFill[f]++;
    plans.push({ p, r, updates: upd });
  }

  console.log(`    com mudanças (would update):  ${plans.length}`);
  console.log(`    sem mudanças (RR ≤ Produto):  ${unchanged}`);
  console.log(`    sem RR match:                  ${noRr}`);
  console.log(`\n  would_fill por campo:`);
  for (const f of FIELDS) console.log(`    ${f.padEnd(20)} ${String(wouldFill[f]).padStart(5)}`);

  // Amostra (apenas dry-run)
  if (!args.apply && args.sampleN > 0 && plans.length > 0) {
    const N = Math.min(args.sampleN, plans.length);
    console.log(`\n  Amostra (${N} produtos antes/depois):`);
    for (const { p, updates } of plans.slice(0, N)) {
      const desig = p.designacao.replace(/\s+/g, " ").slice(0, 40);
      const fills = Object.entries(updates)
        .map(([k, v]) => `${k}="${(v ?? "").slice(0, 30)}"`)
        .join(", ");
      console.log(`    CNP ${p.cnp}  "${desig}"  → ${fills}`);
    }
  }

  if (args.apply && plans.length > 0) {
    console.log(`\n[apply] A aplicar ${plans.length} updates...`);
    let done = 0;
    let failed = 0;
    const filled: Record<FieldName, number> = { ...wouldFill, codigoATC: 0, dci: 0, formaFarmaceutica: 0, dosagem: 0, embalagem: 0 };
    for (const { p, updates } of plans) {
      try {
        await prisma.produto.update({ where: { id: p.id }, data: updates });
        done++;
        for (const f of FIELDS) if (updates[f] != null) filled[f]++;
        if (done % 200 === 0 || done === plans.length) {
          const elapsed = (Date.now() - t0) / 1000;
          const rate = done / Math.max(1, elapsed);
          const eta = (plans.length - done) / Math.max(0.001, rate);
          console.log(
            `    progresso: ${done}/${plans.length}  rate=${rate.toFixed(1)}/s  eta=${(eta / 60).toFixed(1)}min`,
          );
        }
      } catch (err) {
        failed++;
        console.warn(`    [err] cnp=${p.cnp}: ${err instanceof Error ? err.message.slice(0, 80) : "?"}`);
      }
    }
    console.log(`    feito em ${((Date.now() - t0) / 1000).toFixed(1)}s · falhas=${failed}`);
  }

  console.log("\n" + "─".repeat(74));
  console.log(`Resumo (${args.apply ? "LIVE" : "DRY-RUN"}):`);
  console.log(`  candidates:                   ${produtos.length}`);
  console.log(`  ${args.apply ? "actualizados" : "would_update"}:                ${plans.length}`);
  console.log(`  unchanged:                    ${unchanged}`);
  console.log(`  sem RR match:                 ${noRr}`);
  console.log(`  por campo (${args.apply ? "filled" : "would_fill"}):`);
  for (const f of FIELDS) console.log(`    ${f.padEnd(20)} ${String(wouldFill[f]).padStart(5)}`);
  console.log(`  elapsed:                      ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log("─".repeat(74));
}

main()
  .catch((e) => {
    console.error("[fatal]", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
