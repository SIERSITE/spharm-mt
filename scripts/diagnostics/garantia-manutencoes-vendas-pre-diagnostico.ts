/**
 * scripts/diagnostics/garantia-manutencoes-vendas-pre-diagnostico.ts
 *
 * READ-ONLY. Prepara o dry-run da reposição das 36 manutenções do tenant
 * `garantia` (scripts/ops/garantia-reposicao-manutencoes-vendas.ts): mostra o
 * que a operação vai encontrar — sem assumir nenhum email nem nenhum id.
 *
 *   1. as farmácias do tenant (id, nome, estado) e a que cada coluna
 *      (Garantia, Principal, Castelo, Pereiro, Nogueira) resolveria;
 *   2. os utilizadores ACTIVOS (email, perfil) — escolher um para --utilizador-email;
 *   3. quantos registos `hg1_` já existem (têm de ser 0 antes do primeiro apply);
 *   4. as contagens actuais de VendaManutencao / Celula / Farmacia.
 *
 * Só SELECT; a sessão abre em `default_transaction_read_only`. Aceita
 * exclusivamente --tenant=garantia, resolvido pelo control plane.
 *
 *   docker compose --profile tools run --rm migrate \
 *     npm run diag:garantia-manutencoes-vendas -- --tenant=garantia
 *
 * Exit codes: 0 pronto para o dry-run · 1 há farmácias por resolver ou registos
 * hg1_ preexistentes · 2 erro de uso.
 */
import "dotenv/config";
import { parseArgs } from "node:util";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";
import { COLUNAS, TENANT_ALVO, contar, resolverFarmacias } from "../ops/garantia-manutencoes-vendas/operacao";

async function main() {
  const { values } = parseArgs({ options: { tenant: { type: "string" } }, strict: true });
  console.log("SPharm.MT · pré-diagnóstico da reposição de manutenções de Vendas (garantia) · READ-ONLY");
  if (values.tenant !== TENANT_ALVO) {
    console.error(`✗ Aceita exclusivamente --tenant=${TENANT_ALVO} (recebido: ${values.tenant ?? "nada"}).`);
    process.exit(2);
  }
  const { getTenantBySlug, buildTenantConnectionString } = await import("../../lib/control-plane");
  const tenant = await getTenantBySlug(TENANT_ALVO);
  if (!tenant) {
    console.error(`✗ O tenant "${TENANT_ALVO}" não existe no control plane.`);
    process.exit(2);
  }
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: buildTenantConnectionString(tenant) }) });
  try {
    await prisma.$executeRawUnsafe("set session default_transaction_read_only = on");
    console.log(`  tenant: ${TENANT_ALVO} · estado ${tenant.estado} · base ${tenant.dbHost}:${tenant.dbPort}/${tenant.dbName}`);

    const farmacias = await prisma.farmacia.findMany({ select: { id: true, nome: true, estado: true, codigoANF: true }, orderBy: { nome: "asc" } });
    console.log(`\n1. Farmácias do tenant (${farmacias.length}):`);
    for (const f of farmacias) console.log(`   · ${f.nome.padEnd(30)} id=${f.id}  estado=${f.estado}  codigoANF=${f.codigoANF ?? "—"}`);
    const res = resolverFarmacias(farmacias);
    console.log("\n   Resolução das colunas (o que o dry-run vai usar):");
    for (const c of COLUNAS) {
      const f = res.resolvidas[c];
      console.log(`   · ${c.padEnd(9)} → ${f ? `${f.nome}  id=${f.id}  estado=${f.estado}` : "NÃO RESOLVIDA"}`);
    }
    for (const e of res.erros) console.log(`   ✗ ${e}`);

    const users = await prisma.utilizador.findMany({ where: { estado: "ATIVO" }, select: { email: true, nome: true, perfil: true }, orderBy: { email: "asc" } });
    console.log(`\n2. Utilizadores activos (${users.length}) — escolher um para --utilizador-email:`);
    for (const u of users) console.log(`   · ${u.email.padEnd(40)} ${u.perfil}  (${u.nome})`);

    const c = await contar(prisma);
    console.log("\n3. Registos desta operação já existentes (prefixo hg1_):");
    console.log(`   · cabeçalhos=${c.desteConjunto.cabecalhos} células=${c.desteConjunto.celulas} itens por farmácia=${c.desteConjunto.farmaciasPvp}   (esperado: 0 / 0 / 0)`);
    console.log("\n4. Contagens actuais:");
    console.log(`   · VendaManutencao=${c.vendaManutencao}  VendaManutencaoCelula=${c.vendaManutencaoCelula}  VendaManutencaoFarmacia=${c.vendaManutencaoFarmacia}`);

    const pronto = res.erros.length === 0 && c.desteConjunto.cabecalhos === 0;
    console.log(`\nESTADO=${pronto ? "PRONTO_PARA_DRY_RUN" : res.erros.length ? "FARMACIAS_POR_RESOLVER" : "JA_EXISTEM_REGISTOS_HG1"}`);
    process.exit(pronto ? 0 : 1);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
