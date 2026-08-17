/**
 * scripts/catalog-master/bootstrap-global-catalog.ts
 *
 * Promove ao CATÁLOGO GLOBAL o conhecimento que já existe na base de um
 * tenant. Sem chamadas ao modelo — isto já foi pago.
 *
 * ── O que sobe por aqui ──────────────────────────────────────────────
 *
 *   REGULATORY  classificação específica com `classificationSource`
 *               forte (REGULATORY, MANUFACTURER, DISTRIBUTOR) ou com
 *               RegulatoryRecord.
 *
 *   MODELO      `KnowledgeEnrichmentCache.persistido = true` — o que a
 *               fase 3 já resolveu e escreveu. A coluna `origem`
 *               distingue MODELO de PROPAGADO; foi para isso que existe.
 *
 * As utilizações de cada produto vão junto, com a fonte e a confiança que
 * têm no tenant.
 *
 * ── O que NÃO sobe por aqui ──────────────────────────────────────────
 *
 *   HUMANO      `validadoManualmente = true`, ou uma utilização MANUAL.
 *
 * Uma pessoa que corrige um produto ao balcão está a dizer «nesta
 * farmácia isto é assim» — não «isto é assim em Portugal». Este comando
 * conta-os e mostra o comando que os promove, mas não os promove. Ver
 * `catalog:promote-global`.
 *
 * Idempotente: correr duas vezes não escreve na segunda. Quem decide é
 * `avaliarPromocao`, que recusa o empate exactamente para isso.
 *
 * Dry-run é o default. `--apply` para escrever.
 *
 * Uso:
 *   npm run catalog:bootstrap-global -- --tenant=<slug>
 *   npm run catalog:bootstrap-global -- --tenant=<slug> --apply
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";
import { buildTenantConnectionString, getTenantBySlug } from "../../lib/control-plane";
import { AlvoRecusado, descreverAlvo, resolverAlvo } from "../../lib/catalog/target-db";
import { MIN_CNP } from "../../lib/catalog/knowledge-enrichment-runner";
import { KNOWLEDGE_VERSION } from "../../lib/catalog/knowledge-enrichment";
import { estatisticasGlobal, lerCandidatosDoTenant, promoverAoGlobal } from "../../lib/catalog/global-catalog-store";

const pad = (n: number | string, w = 7) => String(n).padStart(w);

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");

  let alvo;
  try {
    alvo = await resolverAlvo(argv, { getTenantBySlug, buildTenantConnectionString });
  } catch (err) {
    if (err instanceof AlvoRecusado) { console.error(`\n${err.message}\n`); process.exit(2); }
    throw err;
  }
  if (!alvo.tenant) {
    console.error("\nO bootstrap precisa de --tenant=<slug>: é registado como origem do conhecimento.\n");
    process.exit(2);
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: alvo.url }) });
  // Só lê do tenant. O que escreve é o control plane, e só com --apply.
  await prisma.$executeRawUnsafe("set session default_transaction_read_only = on");

  console.log("═".repeat(70));
  console.log(`${descreverAlvo(alvo)}${apply ? "" : "   (dry-run — nada é escrito)"}`);
  console.log(`versão de regras: ${KNOWLEDGE_VERSION}`);
  console.log("═".repeat(70));

  const leitura = await lerCandidatosDoTenant(prisma, alvo.tenant, {
    minCnp: MIN_CNP,
    versaoRegras: KNOWLEDGE_VERSION,
  });

  console.log("\n── candidatos ─────────────────────────────────────");
  console.log(`  ${pad(leitura.lidos)}  produtos lidos (cnp >= ${MIN_CNP.toLocaleString("pt-PT")})`);
  console.log(`  ${pad(leitura.semNada)}  sem classificação específica nem utilizações — nada a promover`);
  console.log(`  ${pad(leitura.candidatos.length)}  candidatos`);
  for (const [o, n] of Object.entries(leitura.porOrigem).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pad(n)}  ${o}${o === "HUMANO" ? "  ← não sobe por aqui" : ""}`);
  }

  const antes = await estatisticasGlobal().catch(() => null);
  // Sem aprovação: os candidatos HUMANO são contados e recusados.
  const r = await promoverAoGlobal(leitura.candidatos, {
    dryRun: !apply,
    actor: "catalog:bootstrap-global",
  });

  console.log("\n── promoção ───────────────────────────────────────");
  console.log(`  ${pad(r.promovidos)}  ${apply ? "promovidos" : "a promover"}`);
  console.log(`  ${pad(r.recusados)}  recusados`);
  for (const [m, n] of Object.entries(r.motivos).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`      ${pad(n, 6)}  ${m}`);
  }

  if (r.aguardamAprovacao > 0) {
    console.log("\n── à espera de decisão humana ─────────────────────");
    console.log(`  ${pad(r.aguardamAprovacao)}  validações manuais deste tenant NÃO subiram`);
    console.log("           Uma correcção local não se torna verdade nacional sozinha.");
    console.log("           Quem quiser levá-las ao catálogo global, assina:");
    console.log("");
    console.log(`             npm run catalog:promote-global -- --tenant=${alvo.tenant} \\`);
    console.log(`               --aprovador="Nome de quem responde" \\`);
    console.log(`               --motivo="porque estas valem para todas as farmácias" \\`);
    console.log("               --todos-os-validados");
  }

  if (apply) {
    const depois = await estatisticasGlobal();
    console.log("\n── catálogo global ────────────────────────────────");
    console.log(`  ${pad(antes?.total ?? 0)} → ${depois.total} CNPs conhecidos`);
    console.log(`  ${pad(depois.utilizacoes)}  associações de utilização`);
  } else {
    console.log("\n  dry-run — nada foi escrito. Para aplicar: --apply");
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("\n[erro fatal]", err);
  process.exit(1);
});
