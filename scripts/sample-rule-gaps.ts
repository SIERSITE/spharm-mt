import "dotenv/config";
import * as fs from "fs";
import { legacyPrisma as prisma } from "../lib/prisma";

async function main() {
  const j = JSON.parse(
    fs.readFileSync("scripts/data/infomed-cnp-medguid-mapping.json", "utf-8"),
  ) as { mappings: Record<string, { codigoATC: string | null }> };
  const cnps = Object.keys(j.mappings).map(Number);

  const c = await prisma.classificacao.findFirst({
    where: { tipo: "NIVEL_2", nome: { equals: "Outros Medicamentos", mode: "insensitive" } },
    select: { id: true },
  });
  if (!c) return;

  const stillOutros = await prisma.produto.findMany({
    where: {
      cnp: { in: cnps },
      classificacaoNivel2Id: c.id,
      codigoATC: { not: null },
      estado: { not: "INATIVO" },
    },
    select: { cnp: true, designacao: true, codigoATC: true, dci: true },
    orderBy: { codigoATC: "asc" },
  });

  // Diversify by ATC prefix to get up to 8 distinct examples
  const buckets: Record<string, typeof stillOutros> = {};
  for (const p of stillOutros) {
    const k = (p.codigoATC ?? "?").slice(0, 3);
    (buckets[k] = buckets[k] ?? []).push(p);
  }
  const picks: typeof stillOutros = [];
  let r = 0;
  while (picks.length < 8 && r < 5) {
    for (const k of Object.keys(buckets).sort()) {
      if (picks.length >= 8) break;
      if (buckets[k][r]) picks.push(buckets[k][r]);
    }
    r++;
  }
  console.log("CNP      | Designação                              | ATC     | DCI");
  console.log("---------|-----------------------------------------|---------|----------------------------");
  for (const p of picks) {
    const desig = (p.designacao ?? "").replace(/\s+/g, " ").slice(0, 39);
    console.log(`${String(p.cnp).padEnd(8)} | ${desig.padEnd(39)} | ${(p.codigoATC ?? "-").padEnd(7)} | ${(p.dci ?? "-").slice(0, 26)}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
