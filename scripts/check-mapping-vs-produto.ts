import "dotenv/config";
import * as fs from "fs";
import { legacyPrisma as prisma } from "../lib/prisma";

async function main() {
  const j = JSON.parse(
    fs.readFileSync("scripts/data/infomed-cnp-medguid-mapping.json", "utf-8"),
  ) as { mappings: Record<string, unknown> };
  const cnps = Object.keys(j.mappings).map(Number);

  const matched = await prisma.produto.findMany({
    where: { cnp: { in: cnps }, estado: { not: "INATIVO" } },
    select: {
      id: true,
      cnp: true,
      codigoATC: true,
      dci: true,
      productType: true,
      classificacaoNivel2: { select: { nome: true } },
    },
  });
  const inOutros = matched.filter(
    (p) => p.classificacaoNivel2?.nome === "Outros Medicamentos",
  );
  const withAtc = matched.filter((p) => !!p.codigoATC).length;
  const withDci = matched.filter((p) => !!p.dci).length;

  console.log(`CNPs em mappings:                                   ${cnps.length}`);
  console.log(`Produtos vivos com esses CNPs:                      ${matched.length}`);
  console.log(`  · em "Outros Medicamentos":                       ${inOutros.length}`);
  console.log(`  · com Produto.codigoATC já populado:              ${withAtc}`);
  console.log(`  · com Produto.dci já populado:                    ${withDci}`);
  console.log();
  console.log(`(reprocess.ts faz query a Produto.codigoATC/dci, NÃO a RegulatoryRecord)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
