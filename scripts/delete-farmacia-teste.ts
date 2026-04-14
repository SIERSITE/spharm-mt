import "dotenv/config";
import { legacyPrisma as prisma } from "../lib/prisma";

async function main() {
  const farmacia = await prisma.farmacia.findFirst({
    where: { nome: "Farmácia Teste" },
    select: { id: true, nome: true },
  });

  if (!farmacia) {
    console.log("Farmácia Teste não encontrada — nada a fazer.");
    return;
  }

  console.log(`A eliminar farmácia: ${farmacia.nome} (${farmacia.id})`);

  // Delete dependent records first
  await prisma.vendaMensal.deleteMany({ where: { farmaciaId: farmacia.id } });
  await prisma.produtoFarmacia.deleteMany({ where: { farmaciaId: farmacia.id } });
  await prisma.farmacia.delete({ where: { id: farmacia.id } });

  console.log("Eliminada com sucesso.");
}

main().catch(console.error).finally(() => prisma.$disconnect());
