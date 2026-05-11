import "dotenv/config";
import { legacyPrisma as prisma } from "../lib/prisma";

async function main() {
  // Confirmar A11/M05 ainda em Outros
  const outrosId = (
    await prisma.classificacao.findFirst({
      where: { tipo: "NIVEL_2", nome: { equals: "Outros Medicamentos", mode: "insensitive" } },
      select: { id: true },
    })
  )?.id;

  const stillOutros = await prisma.produto.findMany({
    where: {
      productType: "MEDICAMENTO",
      estado: { not: "INATIVO" },
      classificacaoNivel2Id: outrosId ?? undefined,
      codigoATC: { not: null },
    },
    select: { cnp: true, designacao: true, codigoATC: true, dci: true },
    orderBy: { codigoATC: "asc" },
  });

  console.log(`Still in Outros Medicamentos com ATC: ${stillOutros.length}`);
  for (const p of stillOutros) {
    const desig = (p.designacao ?? "").replace(/\s+/g, " ").slice(0, 50);
    console.log(`  ${p.cnp} ${(p.codigoATC ?? "").padEnd(8)} ${(p.dci ?? "-").slice(0, 35).padEnd(35)} · ${desig}`);
  }

  // Distribuição nas 2 novas categorias
  console.log("\n--- Distribuição nas novas categorias ---");
  for (const nome of ["Anti-infecciosos", "Hormonas e Corticoides"]) {
    const cat = await prisma.classificacao.findFirst({
      where: { tipo: "NIVEL_2", nome: { equals: nome, mode: "insensitive" } },
      select: { id: true },
    });
    if (!cat) {
      console.log(`  [${nome}] não encontrado`);
      continue;
    }
    const count = await prisma.produto.count({
      where: {
        classificacaoNivel2Id: cat.id,
        productType: "MEDICAMENTO",
        estado: { not: "INATIVO" },
      },
    });
    console.log(`  ${nome.padEnd(28)}  ${count} produtos`);
  }

  // P02 em Sistema Digestivo e N01BB em Dermatológicos (confirmar)
  console.log("\n--- Confirmar reuse pragmático ---");
  const p02 = await prisma.produto.findMany({
    where: {
      productType: "MEDICAMENTO",
      estado: { not: "INATIVO" },
      codigoATC: { startsWith: "P02" },
    },
    select: { cnp: true, codigoATC: true, dci: true, classificacaoNivel2: { select: { nome: true } } },
  });
  console.log(`P02 (vermífugos): ${p02.length} produtos`);
  for (const p of p02) {
    console.log(`  ${p.cnp} ${p.codigoATC} ${p.dci} → ${p.classificacaoNivel2?.nome ?? "(no nivel2)"}`);
  }

  const n01bb = await prisma.produto.findMany({
    where: {
      productType: "MEDICAMENTO",
      estado: { not: "INATIVO" },
      codigoATC: { startsWith: "N01BB" },
    },
    select: { cnp: true, codigoATC: true, dci: true, classificacaoNivel2: { select: { nome: true } } },
  });
  console.log(`\nN01BB (anestésicos tópicos): ${n01bb.length} produtos`);
  for (const p of n01bb) {
    console.log(`  ${p.cnp} ${p.codigoATC} ${p.dci} → ${p.classificacaoNivel2?.nome ?? "(no nivel2)"}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
