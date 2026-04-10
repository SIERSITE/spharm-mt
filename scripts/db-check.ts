import "dotenv/config";
import { prisma } from "../lib/prisma";
async function main() {
  const farmacias = await prisma.farmacia.findMany({ select: { id: true, nome: true, estado: true } });
  console.log("FARMACIAS:" + JSON.stringify(farmacias));
  const withCat = await prisma.produtoFarmacia.count({ where: { categoriaOrigem: { not: null } } });
  console.log("WITH_CAT:" + withCat);
  const months = await prisma.vendaMensal.groupBy({ by: ["ano", "mes"], orderBy: [{ ano: "desc" }, { mes: "desc" }], take: 8 });
  console.log("MONTHS:" + JSON.stringify(months));
}
main().catch(console.error).finally(() => prisma.$disconnect());
