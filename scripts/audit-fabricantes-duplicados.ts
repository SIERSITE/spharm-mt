/**
 * scripts/audit-fabricantes-duplicados.ts
 *
 * Diagnóstico de possíveis duplicados/denominações desactualizadas em
 * `Fabricante` — SÓ LEITURA, nunca escreve nada (não tem `--apply`
 * nem nunca terá; para corrigir, ver `scripts/merge-fabricantes.ts`
 * depois de reveres este relatório).
 *
 * Produz, por cada `Fabricante` ATIVO: ID, denominação actual, nº de
 * produtos associados, denominação oficial mais actual (quando
 * conhecida), relação entre as entidades, fonte usada na validação,
 * grau de confiança, e acção recomendada (manter / atualizar
 * denominação / unificar / analisar manualmente). A classificação em
 * si é pura — ver `lib/catalog-fabricante-audit.ts`.
 *
 * ── Segurança ─────────────────────────────────────────────────────────
 * Mesmo mecanismo de resolução de destino que o resto de `scripts/` —
 * `--tenant=<slug>` obrigatório, resolvido pelo control plane, nunca
 * por `DATABASE_URL`. A sessão fica sempre
 * `default_transaction_read_only = on` — este script NUNCA precisa de
 * escrever, por isso a tranca fica ligada sempre, sem opção para desligar.
 *
 * Uso:
 *   npx tsx scripts/audit-fabricantes-duplicados.ts --tenant=<slug>
 *
 * Opções:
 *   --tenant=<slug>      Obrigatório.
 *   --permitir-externo   Necessário se o tenant não for a VPS de produção.
 *   --so-candidatos       Só imprime linhas com acção != "manter" (reduz
 *                         ruído em tenants com muitos fabricantes limpos).
 *   --json                Imprime o relatório completo como JSON (para
 *                         alimentar outra ferramenta / guardar em ficheiro).
 */
import "dotenv/config";
import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { buildTenantConnectionString, getTenantBySlug } from "../lib/control-plane";
import { AlvoRecusado, descreverAlvo, resolverAlvo, type AlvoDb } from "../lib/catalog/target-db";
import {
  classificarFabricante,
  IDENTIDADES_CONHECIDAS,
  type FabricanteResumo,
  type LinhaRelatorioFabricante,
} from "../lib/catalog-fabricante-audit";

async function carregarFabricantes(prisma: PrismaClient): Promise<FabricanteResumo[]> {
  const rows = await prisma.fabricante.findMany({
    where: { estado: "ATIVO" },
    select: {
      id: true,
      nomeNormalizado: true,
      estado: true,
      aliases: { select: { aliasNome: true } },
      _count: { select: { produtos: true } },
    },
    orderBy: { nomeNormalizado: "asc" },
  });
  return rows.map((r) => ({
    id: r.id,
    nomeNormalizado: r.nomeNormalizado,
    estado: r.estado as "ATIVO" | "INATIVO",
    numProdutos: r._count.produtos,
    aliases: r.aliases.map((a) => a.aliasNome),
  }));
}

function imprimirLinha(l: LinhaRelatorioFabricante): void {
  console.log(`\n[${l.acao.toUpperCase()}] ${l.nomeAtual}  (id=${l.id}, ${l.numProdutos} produto(s))`);
  console.log(`  Situação:   ${l.situacao}`);
  console.log(`  Denominação oficial mais actual: ${l.denominacaoOficial ?? "—"}`);
  console.log(`  Relação:    ${l.relacao}`);
  console.log(`  Fonte:      ${l.fonte}`);
  console.log(`  Confiança:  ${l.confianca}`);
  if (l.candidatosPorSemelhanca?.length) {
    console.log(`  Candidatos por semelhança textual (NÃO validados):`);
    for (const c of l.candidatosPorSemelhanca) {
      console.log(`    - "${c.nome}" (score ${(c.score * 100).toFixed(0)}%)`);
    }
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  let alvo: AlvoDb;
  try {
    alvo = await resolverAlvo(argv, { getTenantBySlug, buildTenantConnectionString });
  } catch (err) {
    if (err instanceof AlvoRecusado) {
      console.error(`\n[fatal] ${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  const soCandidatos = argv.includes("--so-candidatos");
  const comoJson = argv.includes("--json");

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: alvo.url }) });
  try {
    // SÓ LEITURA — sempre. Este script nunca escreve nada, por isso não
    // há sequer uma flag para desligar esta tranca.
    await prisma.$executeRawUnsafe(`set session default_transaction_read_only = on`);

    if (!comoJson) {
      console.log("═".repeat(78));
      console.log("Diagnóstico de fabricantes — possíveis duplicados / denominações desactualizadas");
      console.log("═".repeat(78));
      console.log(`  ${descreverAlvo(alvo)}`);
      console.log(`  Modo:  SÓ LEITURA (este script nunca escreve)`);
      console.log(
        `  Tabela curada de identidades conhecidas: ${IDENTIDADES_CONHECIDAS.length} entrada(s)`,
      );
    }

    const fabricantes = await carregarFabricantes(prisma);
    const linhas = fabricantes.map((f) => classificarFabricante(f, fabricantes));

    if (comoJson) {
      console.log(JSON.stringify({ tenant: alvo.tenant, base: alvo.base, linhas }, null, 2));
      return;
    }

    const porAcao = {
      manter: linhas.filter((l) => l.acao === "manter"),
      atualizar_denominacao: linhas.filter((l) => l.acao === "atualizar_denominacao"),
      unificar: linhas.filter((l) => l.acao === "unificar"),
      analisar_manualmente: linhas.filter((l) => l.acao === "analisar_manualmente"),
    };

    console.log(`\nTotal de fabricantes ATIVOS: ${fabricantes.length}`);
    console.log(`  manter:                ${porAcao.manter.length}`);
    console.log(`  atualizar_denominacao: ${porAcao.atualizar_denominacao.length}`);
    console.log(`  unificar:              ${porAcao.unificar.length}`);
    console.log(`  analisar_manualmente:  ${porAcao.analisar_manualmente.length}`);

    const aImprimir = soCandidatos
      ? linhas.filter((l) => l.acao !== "manter")
      : linhas;

    console.log(`\n${"─".repeat(78)}\nDetalhe${soCandidatos ? " (só candidatos — omite 'manter')" : ""}:\n${"─".repeat(78)}`);
    for (const l of aImprimir) imprimirLinha(l);

    if (porAcao.unificar.length > 0 || porAcao.atualizar_denominacao.length > 0) {
      console.log(
        `\n⚠  Há ${porAcao.unificar.length + porAcao.atualizar_denominacao.length} caso(s) com correspondência ` +
          `VALIDADA (fonte oficial/credível) prontos para correcção. Revê o detalhe acima e, se ` +
          `concordares, usa scripts/merge-fabricantes.ts (dry-run primeiro).`,
      );
    }
    if (porAcao.analisar_manualmente.length > 0) {
      console.log(
        `\nℹ  Há ${porAcao.analisar_manualmente.length} caso(s) com semelhança textual mas SEM validação — ` +
          `não são corrigidos por nenhuma ferramenta automática. Precisam de investigação manual ` +
          `(consultar INFARMED/registo comercial) antes de decidir manter, actualizar ou unificar.`,
      );
    }
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

if (/[\\/]audit-fabricantes-duplicados\.(ts|js|mjs|cjs)$/.test(process.argv[1] ?? "")) {
  main().catch((err) => {
    console.error("[erro fatal]", err);
    process.exitCode = 1;
  });
}
