/**
 * scripts/sync-regulatory-to-produto.ts
 *
 * Hidrata os campos clínicos de `Produto` (codigoATC, dci, formaFarmaceutica,
 * dosagem, embalagem) a partir de `RegulatoryRecord`. Surgical sync:
 *
 *   · Só copia `RegulatoryRecord.<campo>` → `Produto.<campo>` quando o campo
 *     em Produto é NULL. Nunca sobrescreve dados existentes.
 *   · Ignora produtos com `validadoManualmente = true`.
 *   · Scope inicial: apenas CNPs presentes no mapping INFOMED actual
 *     (`scripts/data/infomed-cnp-medguid-mapping.json`). Não toca em produtos
 *     fora desse subset.
 *   · Default: dry-run. Tem que ser explícito com `--apply` para escrever.
 *
 * Existe para fechar o gap entre o cache regulatório (RegulatoryRecord,
 * source of truth multi-fonte) e o pipeline de reprocess existente (que
 * lê directamente de Produto.codigoATC/dci). Alternativa mais elegante
 * seria alterar `loadSnapshot` em scripts/reprocess-catalog.ts para
 * dual-read; mantemos esse refactor para outra altura e fazemos a sync
 * uma única vez aqui.
 *
 * Uso:
 *   # Dry-run (default)
 *   npx tsx scripts/sync-regulatory-to-produto.ts
 *
 *   # Aplicar escritas
 *   npx tsx scripts/sync-regulatory-to-produto.ts --apply
 */

import "dotenv/config";
import * as fs from "fs";
import { legacyPrisma as prisma } from "../lib/prisma";

const MAPPING_FILE = "scripts/data/infomed-cnp-medguid-mapping.json";

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
    } else {
      console.warn(`[aviso] argumento desconhecido: ${a}`);
    }
  }
  return out;
}

function loadMappingCnps(): number[] {
  if (!fs.existsSync(MAPPING_FILE)) {
    throw new Error(`mapping file não encontrado: ${MAPPING_FILE}`);
  }
  const j = JSON.parse(fs.readFileSync(MAPPING_FILE, "utf-8")) as {
    mappings: Record<string, unknown>;
  };
  return Object.keys(j.mappings).map(Number).filter((n) => Number.isFinite(n) && n > 0);
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

type RegulatoryRow = {
  cnp: number;
  codigoATC: string | null;
  dci: string | null;
  formaFarmaceutica: string | null;
  dosagem: string | null;
  embalagem: string | null;
};

function buildUpdates(p: ProdutoRow, r: RegulatoryRow): Partial<Record<FieldName, string>> {
  const upd: Partial<Record<FieldName, string>> = {};
  for (const f of FIELDS) {
    if (p[f] == null && r[f] != null) {
      upd[f] = r[f] as string;
    }
  }
  return upd;
}

async function main(): Promise<void> {
  const args = parseArgs();
  console.log("─".repeat(74));
  console.log(`Sync RegulatoryRecord → Produto (${args.apply ? "LIVE" : "DRY-RUN"})`);
  console.log("─".repeat(74));
  console.log(`  campos:    ${FIELDS.join(", ")}`);
  console.log(`  scope:     CNPs em ${MAPPING_FILE}`);
  console.log(`  política:  só copia se Produto.<campo> == null`);
  console.log(`  ignora:    validadoManualmente=true`);
  console.log();

  const mappingCnps = loadMappingCnps();
  console.log(`[1/4] CNPs em mapping: ${mappingCnps.length}`);

  // Carrega produtos elegíveis (vivos, não-validados manualmente)
  const produtos = (await prisma.produto.findMany({
    where: {
      cnp: { in: mappingCnps },
      estado: { not: "INATIVO" },
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
  console.log(`[2/4] Produtos vivos com esses CNPs: ${produtos.length}`);

  const skippedManual = produtos.filter((p) => p.validadoManualmente);
  const eligible = produtos.filter((p) => !p.validadoManualmente);
  console.log(`        · skipped validadoManualmente=true: ${skippedManual.length}`);
  console.log(`        · elegíveis (não-validados):        ${eligible.length}`);

  if (eligible.length === 0) {
    console.log("\nNada para sincronizar.");
    return;
  }

  // Carrega RegulatoryRecord para os CNPs elegíveis
  const eligibleCnps = eligible.map((p) => p.cnp);
  const regs = (await prisma.regulatoryRecord.findMany({
    where: { cnp: { in: eligibleCnps } },
    select: {
      cnp: true,
      codigoATC: true,
      dci: true,
      formaFarmaceutica: true,
      dosagem: true,
      embalagem: true,
    },
  })) as RegulatoryRow[];
  const regByCnp = new Map(regs.map((r) => [r.cnp, r]));
  console.log(`[3/4] RegulatoryRecord rows correspondentes: ${regs.length}`);

  // Constrói plano
  const wouldFill: Record<FieldName, number> = {
    codigoATC: 0,
    dci: 0,
    formaFarmaceutica: 0,
    dosagem: 0,
    embalagem: 0,
  };
  const filled: Record<FieldName, number> = {
    codigoATC: 0,
    dci: 0,
    formaFarmaceutica: 0,
    dosagem: 0,
    embalagem: 0,
  };

  type Plan = { p: ProdutoRow; r: RegulatoryRow; updates: Partial<Record<FieldName, string>> };
  const plans: Plan[] = [];
  let unchanged = 0;
  let noRegMatch = 0;

  for (const p of eligible) {
    const r = regByCnp.get(p.cnp);
    if (!r) {
      noRegMatch++;
      continue;
    }
    const updates = buildUpdates(p, r);
    if (Object.keys(updates).length === 0) {
      unchanged++;
      continue;
    }
    for (const f of FIELDS) {
      if (updates[f] != null) wouldFill[f]++;
    }
    plans.push({ p, r, updates });
  }

  console.log(`[4/4] Plano:`);
  console.log(`        · com mudanças (would update): ${plans.length}`);
  console.log(`        · sem mudanças (todos campos já preenchidos): ${unchanged}`);
  console.log(`        · sem RegulatoryRecord match: ${noRegMatch}`);
  console.log();
  console.log(`  would_fill por campo:`);
  for (const f of FIELDS) {
    console.log(`    ${f.padEnd(20)} ${String(wouldFill[f]).padStart(4)}`);
  }

  // Amostra antes/depois
  if (args.sampleN > 0 && plans.length > 0) {
    const N = Math.min(args.sampleN, plans.length);
    console.log(`\n  Amostra (${N} produtos antes/depois):`);
    for (const { p, updates } of plans.slice(0, N)) {
      const designacao = p.designacao.replace(/\s+/g, " ").slice(0, 42);
      console.log(`\n  CNP ${p.cnp}  "${designacao}"`);
      for (const f of FIELDS) {
        const cur = p[f];
        const newVal = updates[f] ?? null;
        if (newVal != null) {
          const newStr = newVal.length > 50 ? `${newVal.slice(0, 47)}…` : newVal;
          console.log(`    → ${f.padEnd(20)} cur=∅  new="${newStr}"  [FILL]`);
        } else if (cur != null) {
          const curStr = cur.length > 50 ? `${cur.slice(0, 47)}…` : cur;
          console.log(`    · ${f.padEnd(20)} cur="${curStr}"  [keep]`);
        }
        // Campos com cur=null e new=null não interessantes — silenciam
      }
    }
  }

  // Apply
  if (args.apply && plans.length > 0) {
    console.log(`\n[apply] A aplicar ${plans.length} updates...`);
    const t0 = Date.now();
    for (const { p, updates } of plans) {
      try {
        await prisma.produto.update({ where: { id: p.id }, data: updates });
        for (const f of FIELDS) {
          if (updates[f] != null) filled[f]++;
        }
      } catch (err) {
        console.warn(
          `  [erro update produto.id=${p.id} cnp=${p.cnp}]: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    console.log(`  feitos em ${Math.round((Date.now() - t0) / 100) / 10}s`);
  }

  // Sumário
  console.log(`\n${"─".repeat(74)}`);
  console.log(`Resumo:`);
  console.log(`  elegíveis:                         ${eligible.length}`);
  console.log(`  ${args.apply ? "actualizados" : "would_update"}:                    ${plans.length}`);
  console.log(`  unchanged:                         ${unchanged}`);
  console.log(`  skipped validadoManualmente=true:  ${skippedManual.length}`);
  console.log(`  sem RegulatoryRecord match:        ${noRegMatch}`);
  console.log(`  por campo (${args.apply ? "filled" : "would_fill"}):`);
  for (const f of FIELDS) {
    const v = args.apply ? filled[f] : wouldFill[f];
    console.log(`    ${f.padEnd(20)} ${String(v).padStart(4)}`);
  }
  console.log(`  modo: ${args.apply ? "LIVE" : "DRY-RUN"}`);
  console.log("─".repeat(74));
}

main()
  .catch((err) => {
    console.error("[fatal]", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
