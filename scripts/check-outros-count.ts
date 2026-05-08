import "dotenv/config";
import { legacyPrisma as prisma } from "../lib/prisma";

async function main() {
  const c = await prisma.classificacao.findFirst({
    where: { tipo: "NIVEL_2", nome: { equals: "Outros Medicamentos", mode: "insensitive" } },
    select: { id: true },
  });
  if (!c) {
    console.log("not found");
    return;
  }
  const all = await prisma.produto.count({
    where: {
      classificacaoNivel2Id: c.id,
      productType: "MEDICAMENTO",
      estado: { not: "INATIVO" },
    },
  });
  const validated = await prisma.produto.count({
    where: {
      classificacaoNivel2Id: c.id,
      productType: "MEDICAMENTO",
      estado: { not: "INATIVO" },
      validadoManualmente: true,
    },
  });
  console.log("Outros Medicamentos (MEDICAMENTO, vivos):  ", all);
  console.log("  · validadoManualmente=true (intocados): ", validated);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
