/**
 * scripts/ensaio-estado-b-tabelas-vazias.ts
 *
 * Ponto 6 — "Estado B": schema NOVO (migration aplicada, tabelas de
 * grupos laboratoriais existem) mas AINDA sem nenhum grupo/associação
 * criado (antes do povoamento). Confirma que o código novo NUNCA falha
 * neste estado — consulta as tabelas novas, agora existentes mas vazias,
 * e recebe conjuntos vazios, nunca um erro "relation does not exist" nem
 * um crash.
 *
 * Corre contra uma base descartável já com a migration aplicada (nunca
 * uma base real). Uso:
 *   DATABASE_URL=postgresql://test:test@localhost:55433/spharmmt_test \
 *     npx tsx scripts/ensaio-estado-b-tabelas-vazias.ts
 */
import "dotenv/config";
import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { resolverProdutoIdsPorLaboratoriosSelecionados } from "../lib/reporting/resolver-laboratorio-selecionado";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL obrigatório");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    console.log("Estado B: tabelas de grupos laboratoriais existem (migration aplicada), zero linhas.");

    const contagens = await Promise.all([
      prisma.grupoLaboratorial.count(),
      prisma.grupoLaboratorialAlias.count(),
      prisma.grupoLaboratorialFabricante.count(),
      prisma.produtoGrupoLaboratorial.count(),
      prisma.regraGrupoLaboratorialPorCnp.count(),
      prisma.catalogoNacionalImportacao.count(),
      prisma.catalogoNacionalRegistoImportado.count(),
    ]);
    console.log("Contagens (todas devem ser 0):", contagens);
    if (contagens.some((c) => c !== 0)) throw new Error("[fatal] tabela não-vazia inesperada no Estado B");

    // Simula exactamente o que resolveCurrentTenantSlug() faria em
    // garantia dentro de um pedido real — aqui forçado via override, já
    // que este script corre fora de um pedido Next.js.
    const resultado = await resolverProdutoIdsPorLaboratoriosSelecionados(prisma, ["Viatris"], async () => "garantia");
    console.log("resolverProdutoIdsPorLaboratoriosSelecionados(['Viatris']) em Estado B:", resultado);
    if (!Array.isArray(resultado) || resultado.length !== 0) throw new Error("[fatal] esperava array vazio");

    console.log("\n✔ Estado B confirmado: consultar as tabelas novas (vazias) devolve conjuntos vazios, ZERO crash, ZERO erro 'relation does not exist'.");
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

main().catch((err) => {
  console.error("[erro fatal]", err);
  process.exitCode = 1;
});
