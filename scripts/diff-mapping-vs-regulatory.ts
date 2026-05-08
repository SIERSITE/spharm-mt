/**
 * scripts/diff-mapping-vs-regulatory.ts
 *
 * Mostra 20 exemplos antes/depois confrontando o staging file
 * (`infomed-cnp-medguid-mapping.json`) contra o estado actual de
 * `RegulatoryRecord`. Aplica a regra "preservar não-null" do importer
 * sem escrever em BD. Serve para auditar o efeito do import live.
 *
 * Uso:
 *   npx tsx scripts/diff-mapping-vs-regulatory.ts
 *   npx tsx scripts/diff-mapping-vs-regulatory.ts --n=30
 */

import "dotenv/config";
import * as fs from "fs";
import { legacyPrisma as prisma } from "../lib/prisma";

const MAPPING_FILE = "scripts/data/infomed-cnp-medguid-mapping.json";
const FIELDS = [
  "designacaoOficial",
  "dci",
  "codigoATC",
  "formaFarmaceutica",
  "dosagem",
  "embalagem",
  "grupoTerapeutico",
  "titularAim",
  "estadoAim",
] as const;

function normEstado(raw: string | null): string | null {
  if (!raw) return null;
  const s = raw.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  if (s.includes("autoriz")) return "Autorizado";
  if (s.includes("suspens")) return "Suspenso";
  if (s.includes("revog")) return "Revogado";
  if (s.includes("caduc")) return "Caducado";
  if (s.includes("desactiv") || s.includes("desativ")) return "Desactivado";
  if (s.includes("descontinuad")) return "Descontinuado";
  if (s.includes("retirad")) return "Retirado";
  if (s.includes("activ")) return "Activo";
  return raw.trim();
}

type MappingEntry = {
  cnp: number;
  matchedVia: "search_designacao" | "sibling_cnp";
  designacaoOficial: string;
  dci: string | null;
  codigoATC: string | null;
  formaFarmaceutica: string | null;
  dosagem: string | null;
  embalagem: string | null;
  titularAim: string | null;
  estadoAim: string | null;
  grupoTerapeutico: string | null;
};

async function main(): Promise<void> {
  const arg = process.argv.find((a) => a.startsWith("--n="));
  const N = arg ? parseInt(arg.slice("--n=".length), 10) : 20;

  const j = JSON.parse(fs.readFileSync(MAPPING_FILE, "utf-8")) as {
    mappings: Record<string, MappingEntry>;
  };
  const all = Object.values(j.mappings);

  // Diversificar por letra ATC (1ª char), incluir mistura direct/sibling
  const buckets: Record<string, MappingEntry[]> = {};
  for (const m of all) {
    const k = (m.codigoATC || "?")[0];
    (buckets[k] = buckets[k] ?? []).push(m);
  }
  const picks: MappingEntry[] = [];
  const seen = new Set<number>();
  let round = 0;
  while (picks.length < N && round < 10) {
    for (const k of Object.keys(buckets).sort()) {
      if (picks.length >= N) break;
      const e = buckets[k][round];
      if (e && !seen.has(e.cnp)) {
        seen.add(e.cnp);
        picks.push(e);
      }
    }
    round++;
  }

  const cnps = picks.map((p) => p.cnp);
  const existing = await prisma.regulatoryRecord.findMany({ where: { cnp: { in: cnps } } });
  const byCnp = new Map(existing.map((r) => [r.cnp, r]));

  let fieldsSet = 0;
  let fieldsPreserved = 0;
  let fieldsSame = 0;
  let recordsInsertNew = 0;

  for (const p of picks) {
    const cur = byCnp.get(p.cnp);
    console.log(`\nCNP ${p.cnp}  (${p.matchedVia})`);
    if (!cur) {
      recordsInsertNew++;
      console.log("  [INSERT NEW]");
      for (const f of FIELDS) {
        const v = (p as unknown as Record<string, string | null>)[f];
        if (v != null) console.log(`    ${f.padEnd(20)} = "${String(v).slice(0, 50)}"`);
      }
      continue;
    }
    for (const f of FIELDS) {
      const rawNew = (p as unknown as Record<string, string | null>)[f];
      const newVal = rawNew == null ? null : f === "estadoAim" ? normEstado(rawNew) : rawNew;
      const curVal = (cur as unknown as Record<string, string | null>)[f];

      let action: string;
      let mark: string;
      if (curVal == null && newVal != null) {
        action = "SET";
        mark = "→";
        fieldsSet++;
      } else if (curVal != null && newVal != null && curVal !== newVal) {
        action = "PRESERVE";
        mark = "×";
        fieldsPreserved++;
      } else if (curVal != null && newVal != null && curVal === newVal) {
        action = "same";
        mark = "=";
        fieldsSame++;
      } else if (curVal != null && newVal == null) {
        action = "(no new)";
        mark = " ";
      } else {
        action = "(both ∅)";
        mark = " ";
      }

      const curS = curVal == null ? "∅" : String(curVal).slice(0, 40);
      const newS = newVal == null ? "∅" : String(newVal).slice(0, 40);
      console.log(
        `  ${mark} ${f.padEnd(20)} cur="${curS}"  new="${newS}"  [${action}]`,
      );
    }
  }

  console.log("\n" + "─".repeat(74));
  console.log(`Resumo dos ${picks.length} exemplos:`);
  console.log(`  registos novos (insert):                ${recordsInsertNew}`);
  console.log(`  fields SET (curVal=∅ → newVal):         ${fieldsSet}`);
  console.log(`  fields PRESERVE (curVal!=∅, mantém):    ${fieldsPreserved}`);
  console.log(`  fields SAME (igual):                    ${fieldsSame}`);
  console.log("─".repeat(74));
}

main()
  .catch((e) => {
    console.error("[fatal]", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
