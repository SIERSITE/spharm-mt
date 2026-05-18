/**
 * scripts/admin/inspect-product-collision.ts
 *
 * Diagnóstico de colisão de Produto.externalProductId — investiga 3+ IDs
 * que falharam P2002 unique violation no bootstrap/products.
 *
 * Para cada externalProductId reporta:
 *   · Produto: existe? cnp/designacao/origemDados/dataCriacao
 *   · ProdutoFarmacia: para que farmácias? (id + nome + designacaoLocal)
 *
 * Read-only.
 */
import "dotenv/config";
import { parseArgs } from "node:util";
import {
  controlPrisma,
  getTenantBySlug,
  buildTenantConnectionString,
} from "@/lib/control-plane";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

async function main() {
  const { values } = parseArgs({
    options: {
      slug: { type: "string" },
      ids: { type: "string" },
    },
  });
  const slug = values.slug ?? "demo-neon";
  const idsArg = values.ids ?? "";
  const ids = idsArg
    .split(",")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
  if (ids.length === 0) {
    console.error("Usage: --slug=demo-neon --ids=11819,17247,21235");
    process.exit(1);
  }

  const tenant = await getTenantBySlug(slug);
  if (!tenant) throw new Error(`tenant ${slug} not found`);
  const tp = new PrismaClient({
    adapter: new PrismaPg({ connectionString: buildTenantConnectionString(tenant) }),
  });

  // Sample staging count for the affected IDs — quantas linhas no
  // staging compras referenciam estes codigos.
  for (const id of ids) {
    console.log("=".repeat(70));
    console.log(`externalProductId = ${id}`);

    // Após drop do unique, `externalProductId` deixou de ser
    // findUnique-able. Esperamos no máximo 1 row aqui (a entrega
    // anterior tinha unique constraint); se aparecerem múltiplos,
    // o script imprime o primeiro mas avisa.
    const produto = await tp.produto.findFirst({
      where: { externalProductId: id },
      select: {
        id: true,
        cnp: true,
        designacao: true,
        origemDados: true,
        estado: true,
        dataCriacao: true,
        dataAtualizacao: true,
      },
    });
    if (!produto) {
      console.log("  Produto.externalProductId NÃO existe (não é colisão por owner)");
    } else {
      console.log("  Produto existente:");
      console.log(`    id=${produto.id}`);
      console.log(`    cnp=${produto.cnp}`);
      console.log(`    designacao=${JSON.stringify(produto.designacao)}`);
      console.log(`    origemDados=${produto.origemDados}  estado=${produto.estado}`);
      console.log(`    dataCriacao=${produto.dataCriacao.toISOString()}  dataAtualizacao=${produto.dataAtualizacao.toISOString()}`);
    }

    // Tentar encontrar TODOS os Produtos cujo `Produto.externalProductId`
    // OU cujos `ProdutoFarmacia.externalProductId` (denormalizado) ==id
    const pfs = await tp.produtoFarmacia.findMany({
      where: { externalProductId: id },
      select: {
        id: true,
        produtoId: true,
        farmaciaId: true,
        designacaoLocal: true,
        externalProductId: true,
        farmacia: { select: { nome: true } },
        produto: { select: { id: true, cnp: true, designacao: true } },
      },
    });
    if (pfs.length === 0) {
      console.log("  ProdutoFarmacia: nenhum registo aponta para este externalProductId");
    } else {
      console.log(`  ProdutoFarmacia: ${pfs.length} registo(s)`);
      for (const pf of pfs) {
        console.log(
          `    farmaciaId=${pf.farmaciaId} (${pf.farmacia.nome}) ` +
            `produtoId=${pf.produtoId} (cnp=${pf.produto.cnp} designacao=${JSON.stringify(pf.produto.designacao)})`
        );
      }
    }

    // Linhas no staging compras a referenciar este codigo (qualquer farmácia)
    const stagingHits = await tp.stagingCompraRawLine.findMany({
      where: { externalCodigoId: id },
      select: {
        farmaciaId: true,
        externalLineId: true,
        externalReceptionId: true,
        dataRecepcao: true,
      },
      take: 5,
      orderBy: { dataRecepcao: "desc" },
    });
    console.log(`  StagingCompraRawLine refs: ${stagingHits.length} (top 5)`);
    for (const s of stagingHits) {
      console.log(
        `    farmaciaId=${s.farmaciaId}  linha=${s.externalLineId}  rec=${s.externalReceptionId}  data=${s.dataRecepcao.toISOString().slice(0, 10)}`
      );
    }
  }

  console.log("=".repeat(70));
  // Quantos Produto.cnp existem com origemDados=FARMACIA total e por farmácia
  const totalProdutos = await tp.produto.count();
  const produtosFromFarmacia = await tp.produto.count({ where: { origemDados: "FARMACIA" } });
  console.log(`Produto count: total=${totalProdutos}  origemDados=FARMACIA=${produtosFromFarmacia}`);

  // Por farmácia, quantos ProdutoFarmacia existem
  const farmacias = await tp.farmacia.findMany({
    where: { estado: "ATIVO" },
    select: { id: true, nome: true },
  });
  for (const f of farmacias) {
    const n = await tp.produtoFarmacia.count({ where: { farmaciaId: f.id } });
    const nWithExternal = await tp.produtoFarmacia.count({
      where: { farmaciaId: f.id, externalProductId: { not: null } },
    });
    console.log(`  farmacia=${f.nome} (id=${f.id}) ProdutoFarmacia=${n} comExternalProductId=${nWithExternal}`);
  }

  await tp.$disconnect();
  await controlPrisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
