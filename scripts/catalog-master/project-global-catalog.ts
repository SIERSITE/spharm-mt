/**
 * scripts/catalog-master/project-global-catalog.ts
 *
 * Projecta o CATÁLOGO GLOBAL (control plane, por CNP) para a base de um
 * tenant. Sem chamadas ao modelo — o conhecimento já foi pago uma vez.
 *
 * ── Para que serve ───────────────────────────────────────────────────
 * O mesmo CNP é o mesmo produto nacional. Um tenant novo não tem de
 * pagar outra vez pelo Ozempic: corre isto e recebe tudo o que já se
 * sabe. É este comando que torna a camada global útil no onboarding.
 *
 * ── O que NUNCA faz ──────────────────────────────────────────────────
 *   · não toca em produtos com `validadoManualmente = true`;
 *   · não sobrepõe uma classificação específica local — abre uma
 *     CatalogoGlobalRevisao e deixa como está;
 *   · não sobrepõe uma utilização MANUAL;
 *   · não cria classificações nem utilizações que o tenant não tenha no
 *     vocabulário (correr `catalog:seed-taxonomy` e
 *     `catalog:seed-utilizacoes` primeiro);
 *   · não escreve nada operacional.
 *
 * Dry-run é o default. `--apply` para escrever.
 *
 * Uso:
 *   npm run catalog:project-global -- --tenant=<slug>
 *   npm run catalog:project-global -- --tenant=<slug> --apply
 *   npm run catalog:project-global -- --estatisticas
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";
import { buildTenantConnectionString, getTenantBySlug } from "../../lib/control-plane";
import { AlvoRecusado, descreverAlvo, resolverAlvo } from "../../lib/catalog/target-db";
import { estatisticasGlobal, projectarParaTenant } from "../../lib/catalog/global-catalog-store";

const pad = (n: number | string, w = 7) => String(n).padStart(w);

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const limite = Number(argv.find((a) => a.startsWith("--limite="))?.split("=")[1] ?? 0) || undefined;

  if (argv.includes("--estatisticas")) {
    const e = await estatisticasGlobal();
    console.log("── catálogo global ────────────────────────────────");
    console.log(`  ${pad(e.total)}  CNPs conhecidos`);
    for (const [origem, n] of Object.entries(e.porOrigem).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${pad(n)}  ${origem}`);
    }
    console.log(`  ${pad(e.utilizacoes)}  associações de utilização`);
    console.log(`  ${pad(e.revisoesAbertas)}  revisões por resolver`);
    process.exit(0);
  }

  let alvo;
  try {
    alvo = await resolverAlvo(argv, { getTenantBySlug, buildTenantConnectionString });
  } catch (err) {
    if (err instanceof AlvoRecusado) {
      console.error(`\n${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }
  if (!alvo.tenant) {
    console.error("\nA projecção precisa de --tenant=<slug>: o slug é registado nas revisões.\n");
    process.exit(2);
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: alvo.url }) });
  await prisma.$executeRawUnsafe(
    `set session default_transaction_read_only = ${apply ? "off" : "on"}`,
  );

  console.log("═".repeat(70));
  console.log(`${descreverAlvo(alvo)}${apply ? "" : "   (dry-run — nada é escrito)"}`);
  console.log("═".repeat(70));

  const r = await projectarParaTenant(prisma, alvo.tenant, { dryRun: !apply, limite });

  console.log("\n── projecção ──────────────────────────────────────");
  console.log(`  ${pad(r.cnpsNoTenant)}  produtos no tenant`);
  console.log(`  ${pad(r.cnpsConhecidosGlobal)}  já conhecidos pelo catálogo global`);
  console.log(`  ${pad(r.classificacoesEscritas)}  classificações ${apply ? "escritas" : "a escrever"}`);
  console.log(`  ${pad(r.productTypesEscritos)}  productType (só onde faltava)`);
  console.log(`  ${pad(r.utilizacoesEscritas)}  utilizações`);
  console.log(`  ${pad(r.noOp)}  já iguais ao global (nada a fazer)`);
  console.log(`  ${pad(r.intocaveis)}  intocáveis (validadoManualmente)`);
  console.log(`  ${pad(r.revisoesAbertas)}  divergências → revisão (NUNCA sobrepostas)`);
  if (r.semVocabulario > 0) {
    console.log(`  ${pad(r.semVocabulario)}  ⚠ nome/slug que o tenant não tem no vocabulário`);
    console.log("           correr catalog:seed-taxonomy e catalog:seed-utilizacoes");
  }

  if (r.exemplosRevisao.length > 0) {
    console.log("\n── divergências (candidatos a auditoria) ──────────");
    for (const d of r.exemplosRevisao) {
      console.log(`  cnp ${pad(d.cnp, 8)}`);
      console.log(`     global: ${d.global}`);
      console.log(`     local : ${d.local}`);
    }
  }

  if (!apply) console.log("\n  dry-run — nada foi escrito. Para aplicar: --apply");

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("\n[erro fatal]", err);
  process.exit(1);
});
