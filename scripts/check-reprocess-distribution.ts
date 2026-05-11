import "dotenv/config";
import * as fs from "fs";
import { legacyPrisma as prisma } from "../lib/prisma";

async function main() {
  const j = JSON.parse(
    fs.readFileSync("scripts/data/infomed-cnp-medguid-mapping.json", "utf-8"),
  ) as { mappings: Record<string, { codigoATC: string | null }> };

  const cnps = Object.keys(j.mappings).map(Number);

  // Distribution of nivel2 for all synced produtos (those with mapping CNPs)
  const produtos = await prisma.produto.findMany({
    where: { cnp: { in: cnps }, estado: { not: "INATIVO" } },
    select: {
      cnp: true,
      codigoATC: true,
      classificacaoNivel2: { select: { nome: true } },
    },
  });

  const dist: Record<string, number> = {};
  const stillOutrosByPref: Record<string, number> = {};
  let total = 0;
  let stillOutros = 0;

  for (const p of produtos) {
    total++;
    const n2 = p.classificacaoNivel2?.nome ?? "(no nivel2)";
    dist[n2] = (dist[n2] ?? 0) + 1;
    if (n2 === "Outros Medicamentos" && p.codigoATC) {
      stillOutros++;
      const pref = p.codigoATC.slice(0, 3);
      stillOutrosByPref[pref] = (stillOutrosByPref[pref] ?? 0) + 1;
    }
  }

  console.log(`\nDistribuição nivel2 actual dos ${total} produtos sincronizados:`);
  for (const [n2, n] of Object.entries(dist).sort((a, b) => b[1] - a[1])) {
    const pct = ((n / total) * 100).toFixed(1);
    console.log(`  ${n2.padEnd(36)} ${String(n).padStart(4)}  (${pct}%)`);
  }

  console.log(`\nTop rule gaps (still Outros Medicamentos com ATC):`);
  console.log(`  Total still in Outros: ${stillOutros}`);
  for (const [pref, n] of Object.entries(stillOutrosByPref).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pref.padEnd(5)} ${String(n).padStart(4)}`);
  }

  // Total Outros Medicamentos (geral)
  const c = await prisma.classificacao.findFirst({
    where: { tipo: "NIVEL_2", nome: { equals: "Outros Medicamentos", mode: "insensitive" } },
    select: { id: true },
  });
  if (c) {
    const totalOutros = await prisma.produto.count({
      where: {
        classificacaoNivel2Id: c.id,
        productType: "MEDICAMENTO",
        estado: { not: "INATIVO" },
      },
    });
    console.log(`\nOutros Medicamentos (TOTAL geral, vivos): ${totalOutros}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
