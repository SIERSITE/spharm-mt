import "dotenv/config";
import { legacyPrisma as prisma } from "../lib/prisma";

const PREFIXES = ["J01", "J02", "J05", "H02", "P02", "H03", "A11", "M05", "N01"];

async function main() {
  const outrosId = (
    await prisma.classificacao.findFirst({
      where: { tipo: "NIVEL_2", nome: { equals: "Outros Medicamentos", mode: "insensitive" } },
      select: { id: true },
    })
  )?.id;
  if (!outrosId) {
    console.error("Outros Medicamentos id não encontrado");
    return;
  }

  const all = await prisma.produto.findMany({
    where: {
      productType: "MEDICAMENTO",
      estado: { not: "INATIVO" },
      classificacaoNivel2Id: outrosId,
      codigoATC: { not: null },
    },
    select: {
      cnp: true,
      designacao: true,
      codigoATC: true,
      dci: true,
      formaFarmaceutica: true,
    },
    orderBy: [{ codigoATC: "asc" }, { designacao: "asc" }],
  });

  console.log(`Total rule-gap produtos: ${all.length}\n`);

  for (const pref of PREFIXES) {
    const group = all.filter((p) => (p.codigoATC ?? "").startsWith(pref));
    console.log(`\n## ${pref}  (${group.length} produto(s))`);
    if (group.length === 0) {
      console.log("  (none)");
      continue;
    }
    // Distinct DCIs
    const dcis = new Map<string, number>();
    for (const p of group) {
      const k = p.dci ?? "(no dci)";
      dcis.set(k, (dcis.get(k) ?? 0) + 1);
    }
    console.log(`  DCIs distintos: ${dcis.size}`);
    for (const [d, n] of [...dcis.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(n).padStart(3)} × ${d}`);
    }
    // Distinct formas
    const formas = new Map<string, number>();
    for (const p of group) {
      const k = p.formaFarmaceutica ?? "(no forma)";
      formas.set(k, (formas.get(k) ?? 0) + 1);
    }
    console.log(`  Formas farmacêuticas:`);
    for (const [f, n] of [...formas.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(n).padStart(3)} × ${f}`);
    }
    // Top examples (max 5)
    console.log(`  Exemplos (até 5):`);
    for (const p of group.slice(0, 5)) {
      const desig = (p.designacao ?? "").replace(/\s+/g, " ").slice(0, 50);
      console.log(`    ${p.cnp}  ${p.codigoATC}  ${(p.dci ?? "-").slice(0, 30).padEnd(30)} · ${desig}`);
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
