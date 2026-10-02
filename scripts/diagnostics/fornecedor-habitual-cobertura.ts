/**
 * scripts/diagnostics/fornecedor-habitual-cobertura.ts
 *
 * Diagnóstico READ-ONLY: porque é que tantas linhas de uma proposta de encomenda
 * ficam «sem fornecedor»? Só faz SELECTs — não escreve, não altera, não cria
 * fornecedores nem aliases, não corre migrations.
 *
 *   DATABASE_URL=<base do tenant> npx tsx scripts/diagnostics/fornecedor-habitual-cobertura.ts
 *
 * A fonte de verdade do fornecedor habitual é `ProdutoFarmacia.fornecedorHabitualId`
 * (por produto E por farmácia). Esse campo só é preenchido por:
 *   1. a ingestão do agent — SÓ no tenant silveira, e só quando está nulo
 *      (lib/ingest/fornecedor-preferencial-silveira.ts);
 *   2. a manutenção em massa do catálogo — SÓ silveira.
 * Nos outros tenants fica nulo para sempre, mesmo com `fornecedorOrigem` (texto) preenchido.
 *
 * Por farmácia (apenas ProdutoFarmacia não retirados — o universo da proposta), classifica cada par
 * produto×farmácia numa categoria EXCLUSIVA:
 *
 *   HABITUAL_ATIVO        fornecedorHabitualId preenchido e Fornecedor ATIVO — a linha sai preenchida
 *   HABITUAL_INATIVO      preenchido mas o Fornecedor está INATIVO — antes a linha ficava sem nome
 *   SO_TEXTO_RESOLVIVEL   sem id, mas o texto do ERP corresponde SEM ambiguidade a um Fornecedor
 *                         (agora a proposta preenche-o — fonte TEXTO_ERP)
 *   SO_TEXTO_AMBIGUO      sem id; o texto é um alias de mais do que um fornecedor — nunca adivinhado
 *   SO_TEXTO_DESCONHECIDO sem id; o texto não corresponde a nenhum Fornecedor/alias
 *   SO_EXTERNAL_ID        sem id e sem texto, mas com `fornecedorExternalId` do ERP (nunca resolvido)
 *   SEM_NADA              sem id, sem texto, sem external id — o ERP não tem habitual
 *
 * Também mostra, para os rascunhos abertos, quantas linhas têm fornecedor nulo apesar de o
 * ProdutoFarmacia já ter habitual («semente perdida»: o rascunho foi criado antes de o habitual existir).
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";
import { resolverFornecedoresPorTextoSoLeitura } from "../../lib/catalogo/resolver-fornecedor";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL em falta (base do tenant a diagnosticar).");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

  const farmacias = await prisma.farmacia.findMany({ where: { estado: "ATIVO" }, select: { id: true, nome: true }, orderBy: { nome: "asc" } });
  const todosTextos = await prisma.produtoFarmacia.findMany({
    where: { flagRetirado: false, fornecedorHabitualId: null, fornecedorOrigem: { not: null } },
    select: { fornecedorOrigem: true },
    distinct: ["fornecedorOrigem"],
  });
  const resolvidos = await resolverFornecedoresPorTextoSoLeitura(prisma, todosTextos.map((t) => t.fornecedorOrigem!));
  const aliasAmbiguos = new Map<string, number>();
  const aliases = await prisma.fornecedorAlias.findMany({ select: { aliasNome: true, fornecedorId: true } });
  for (const a of aliases) aliasAmbiguos.set(a.aliasNome, (aliasAmbiguos.get(a.aliasNome) ?? 0) + 1);

  console.log("farmácia | total | HABITUAL_ATIVO | HABITUAL_INATIVO | SO_TEXTO_RESOLVIVEL | SO_TEXTO_AMBIGUO | SO_TEXTO_DESCONHECIDO | SO_EXTERNAL_ID | SEM_NADA");
  for (const f of farmacias) {
    const pfs = await prisma.produtoFarmacia.findMany({
      where: { farmaciaId: f.id, flagRetirado: false },
      select: { fornecedorHabitualId: true, fornecedorOrigem: true, fornecedorExternalId: true, fornecedorHabitual: { select: { estado: true } } },
    });
    const c = { total: pfs.length, HABITUAL_ATIVO: 0, HABITUAL_INATIVO: 0, SO_TEXTO_RESOLVIVEL: 0, SO_TEXTO_AMBIGUO: 0, SO_TEXTO_DESCONHECIDO: 0, SO_EXTERNAL_ID: 0, SEM_NADA: 0 };
    for (const p of pfs) {
      const txt = p.fornecedorOrigem?.trim() || null;
      if (p.fornecedorHabitualId) {
        if (p.fornecedorHabitual?.estado === "INATIVO") c.HABITUAL_INATIVO++;
        else c.HABITUAL_ATIVO++;
      } else if (txt) {
        if (resolvidos.has(txt)) c.SO_TEXTO_RESOLVIVEL++;
        else if ((aliasAmbiguos.get(txt) ?? 0) > 1) c.SO_TEXTO_AMBIGUO++;
        else c.SO_TEXTO_DESCONHECIDO++;
      } else if (p.fornecedorExternalId != null) c.SO_EXTERNAL_ID++;
      else c.SEM_NADA++;
    }
    console.log([f.nome, c.total, c.HABITUAL_ATIVO, c.HABITUAL_INATIVO, c.SO_TEXTO_RESOLVIVEL, c.SO_TEXTO_AMBIGUO, c.SO_TEXTO_DESCONHECIDO, c.SO_EXTERNAL_ID, c.SEM_NADA].join(" | "));
  }

  const perdidas = await prisma.$queryRaw<Array<{ farmacia: string; linhas: bigint }>>`
    SELECT f.nome AS farmacia, COUNT(*)::bigint AS linhas
    FROM "LinhaEncomenda" le
    JOIN "ListaEncomenda" l ON l.id = le."listaEncomendaId" AND l.estado = 'RASCUNHO'
    JOIN "ProdutoFarmacia" pf ON pf."produtoId" = le."produtoId" AND pf."farmaciaId" = l."farmaciaId"
    JOIN "Farmacia" f ON f.id = l."farmaciaId"
    WHERE le."fornecedorSugeridoId" IS NULL AND pf."fornecedorHabitualId" IS NOT NULL
    GROUP BY f.nome`;
  console.log("\nLinhas de rascunhos abertos SEM fornecedor mas com habitual já preenchido (semente perdida):");
  if (perdidas.length === 0) console.log("  nenhuma");
  for (const r of perdidas) console.log(`  ${r.farmacia}: ${Number(r.linhas)}`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
