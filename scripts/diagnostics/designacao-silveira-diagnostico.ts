/**
 * scripts/diagnostics/designacao-silveira-diagnostico.ts
 *
 * READ-ONLY. Mostra se a autoridade da designação da Silveirense está bem
 * configurada no tenant: que farmácias existem, que codigoANF têm, o valor
 * de SILVEIRA_DESIGNACAO_AUTORITATIVA_CODIGO_ANF no ambiente DESTE processo,
 * e qual farmácia a resolução escolheria — ou porque falha.
 *
 * Só faz SELECT. Não escreve, não toca no ERP, não altera configuração.
 *
 * Uso:
 *   npm run diag:designacao-silveira -- --tenant=silveira
 *   npm run diag:designacao-silveira -- --database-url=postgresql://…@localhost/…   (base local de teste)
 *
 * Nota: a variável é lida do ambiente do processo que corre o script. Para
 * diagnosticar o que a APP vê, correr no mesmo ambiente (mesmo .env/container).
 *
 * Exit codes: 0 configuração válida · 1 configuração inválida · 2 erro de uso.
 */
import "dotenv/config";
import { parseArgs } from "node:util";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";
import { ENV_CODIGO_ANF_DESIGNACAO } from "../../lib/ingest/designacao-silveira";
import { diagnosticarDesignacao } from "../../lib/ingest/designacao-silveira-admin";

async function main() {
  const { values } = parseArgs({
    options: { tenant: { type: "string" }, "database-url": { type: "string" } },
    strict: true,
  });
  console.log("SPharm.MT · autoridade da designação (Silveirense) · READ-ONLY");
  const slug = values.tenant?.trim() ?? "";
  if (!slug) {
    // Mesma convenção dos restantes diagnósticos: o destino identifica-se sempre, nunca há um por omissão.
    console.error("✗ --tenant <slug> é obrigatório (ex.: --tenant=silveira). Opcional: --database-url=<base local de teste>.");
    process.exit(2);
  }

  let url = values["database-url"]?.trim();
  if (url) {
    const h = new URL(url).hostname;
    if (h !== "localhost" && h !== "127.0.0.1") {
      console.error(`--database-url recusado: ${h} não é local. Para produção use --tenant (control plane).`);
      process.exit(2);
    }
  } else {
    const { getTenantBySlug, buildTenantConnectionString } = await import("../../lib/control-plane");
    const tenant = await getTenantBySlug(slug);
    if (!tenant) {
      console.error(`O tenant "${slug}" não existe no control plane.`);
      process.exit(2);
    }
    url = buildTenantConnectionString(tenant);
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    await prisma.$executeRawUnsafe("set session default_transaction_read_only = on");
    const d = await diagnosticarDesignacao(prisma, slug);
    console.log(`  tenant: ${d.tenant}`);
    console.log(`  ${ENV_CODIGO_ANF_DESIGNACAO}: ${d.variavelDefinida ? `"${d.codigoConfigurado}"` : "(NÃO definida neste ambiente)"}`);
    console.log("");
    console.log("  Farmácias:");
    for (const f of d.farmacias) {
      const marca = d.resolucao.aplica && d.resolucao.valida && d.resolucao.farmaciaId === f.id ? "  ◀ AUTORITATIVA" : "";
      console.log(`   · ${f.nome.padEnd(28)} id=${f.id}  codigoANF=${f.codigoANF ?? "—"}  estado=${f.estado}  produtos=${f.produtosNaFarmacia}${marca}`);
    }
    console.log("");
    if (!d.resolucao.aplica) {
      console.log(`  Resultado: a regra não se aplica ao tenant "${slug}" (só ao tenant silveira).`);
      process.exit(0);
    }
    if (d.resolucao.valida) {
      console.log(`  Resultado: VÁLIDA — "${d.resolucao.farmaciaNome}" é a farmácia autoritativa para a designação.`);
      console.log("  A outra(s) farmácia(s) só escrevem a designação ao CRIAR produtos.");
      process.exit(0);
    }
    console.log(`  Resultado: INVÁLIDA (${d.resolucao.codigo}) — ${d.resolucao.mensagem}`);
    console.log("  Enquanto assim, NENHUMA farmácia altera designações existentes (modo seguro); a criação de produtos novos continua.");
    for (const a of d.accoes) console.log(`   → ${a}`);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
