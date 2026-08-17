/**
 * scripts/catalog-master/bootstrap-global-catalog.ts
 *
 * Promove ao CATÁLOGO GLOBAL o conhecimento que já existe na base de um
 * tenant. Sem chamadas ao modelo — isto já foi pago.
 *
 * ── Três origens, por ordem de autoridade ────────────────────────────
 *
 *   1. HUMANO      `validadoManualmente = true`
 *                  O maior ganho isolado desta camada, e o mais barato:
 *                  uma validação feita à mão numa farmácia passa a servir
 *                  todas as outras. Não custa nada e ganha a tudo.
 *
 *   2. REGULATORY  classificação específica com `classificationSource`
 *                  forte (REGULATORY, MANUFACTURER, DISTRIBUTOR) ou com
 *                  RegulatoryRecord.
 *
 *   3. MODELO      `KnowledgeEnrichmentCache.persistido = true`
 *                  O que a fase 3 já resolveu e escreveu. A coluna
 *                  `origem` distingue MODELO de PROPAGADO — foi para
 *                  isso que ela existe.
 *
 * As utilizações de cada produto vão junto, com a fonte e a confiança que
 * têm no tenant. Uma associação MANUAL sobe como HUMANO.
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
import { ehEspecifica, type ConhecimentoCandidato, type OrigemGlobal } from "../../lib/catalog/global-catalog";
import { estatisticasGlobal, promoverAoGlobal } from "../../lib/catalog/global-catalog-store";

/** Fontes de classificação que valem REGULATORY na promoção. */
const FONTES_FORTES = new Set(["REGULATORY", "MANUFACTURER", "DISTRIBUTOR"]);

type LinhaTenant = {
  cnp: number;
  designacao: string;
  productType: string | null;
  categoria: string | null;
  subcategoria: string | null;
  validadoManualmente: boolean;
  classificationSource: string | null;
  productTypeConfidence: number | null;
  temRegulatorio: boolean;
  utilSlugs: string[] | null;
  utilFontes: string[] | null;
  utilConfs: number[] | null;
  cacheOrigem: string | null;
  cacheConfidence: number | null;
  cacheEvidence: string | null;
};

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

  const linhas = await prisma.$queryRawUnsafe<LinhaTenant[]>(
    `select p.cnp,
            p.designacao,
            p."productType",
            p."validadoManualmente",
            p."classificationSource",
            p."productTypeConfidence",
            c1.nome as categoria,
            c2.nome as subcategoria,
            (r.cnp is not null) as "temRegulatorio",
            coalesce(array_agg(u.slug)   filter (where u.slug is not null), '{}') as "utilSlugs",
            coalesce(array_agg(pu.fonte) filter (where u.slug is not null), '{}') as "utilFontes",
            coalesce(array_agg(coalesce(pu.confianca, 1)) filter (where u.slug is not null), '{}') as "utilConfs",
            max(k.origem)     as "cacheOrigem",
            max(k.confidence) as "cacheConfidence",
            max(k."evidenceType") as "cacheEvidence"
       from "Produto" p
       left join "Classificacao" c1 on c1.id = p."classificacaoNivel1Id"
       left join "Classificacao" c2 on c2.id = p."classificacaoNivel2Id"
       left join "RegulatoryRecord" r on r.cnp = p.cnp
       left join "ProdutoUtilizacao" pu on pu."produtoId" = p.id
       left join "Utilizacao" u on u.id = pu."utilizacaoId"
       left join "KnowledgeEnrichmentCache" k on k.cnp = p.cnp and k.persistido = true
      where p.cnp >= $1
      group by p.cnp, p.designacao, p."productType", p."validadoManualmente",
               p."classificationSource", p."productTypeConfidence", c1.nome, c2.nome, r.cnp`,
    MIN_CNP,
  );

  const candidatos: ConhecimentoCandidato[] = [];
  const porOrigem: Record<string, number> = {};
  let semNada = 0;

  for (const l of linhas) {
    const slugs = l.utilSlugs ?? [];
    const fontes = l.utilFontes ?? [];
    const confs = l.utilConfs ?? [];
    const temClassificacao = !!l.categoria && ehEspecifica(l.subcategoria);
    if (!temClassificacao && slugs.length === 0) { semNada++; continue; }

    // A origem é a MAIS FORTE que este produto justifica. Uma validação
    // manual ganha a tudo o resto; sem ela, uma fonte regulamentar; sem
    // ela, o que o modelo escreveu.
    let origem: OrigemGlobal;
    let confidence: number;
    if (l.validadoManualmente || fontes.includes("MANUAL")) {
      origem = "HUMANO";
      confidence = 1;
    } else if (FONTES_FORTES.has(l.classificationSource ?? "") || l.temRegulatorio) {
      origem = "REGULATORY";
      confidence = l.productTypeConfidence ?? 0.95;
    } else if (l.cacheOrigem === "PROPAGADO") {
      origem = "PROPAGADO";
      confidence = l.cacheConfidence ?? l.productTypeConfidence ?? 0.85;
    } else if (l.cacheOrigem || l.classificationSource === "MODEL_INFERRED") {
      origem = "MODELO";
      confidence = l.cacheConfidence ?? l.productTypeConfidence ?? 0.85;
    } else {
      // Classificação sem proveniência conhecida: veio das regras
      // determinísticas. Vale como MODELO — é determinística e nossa,
      // mas não é uma fonte externa nem uma decisão humana.
      origem = "MODELO";
      confidence = l.productTypeConfidence ?? 0.85;
    }

    porOrigem[origem] = (porOrigem[origem] ?? 0) + 1;
    candidatos.push({
      cnp: Number(l.cnp),
      designacaoReferencia: l.designacao,
      productType: l.productType,
      categoria: temClassificacao ? l.categoria : null,
      subcategoria: temClassificacao ? l.subcategoria : null,
      utilizacoes: slugs.map((slug, i) => ({
        slug,
        confidence: fontes[i] === "MANUAL" ? 1 : (confs[i] ?? 0.85),
      })),
      confidence,
      evidenceType: l.cacheEvidence,
      origem,
      versaoRegras: KNOWLEDGE_VERSION,
      verificado: origem === "HUMANO" || origem === "REGULATORY",
      tenantOrigem: alvo.tenant!,
    });
  }

  console.log("\n── candidatos ─────────────────────────────────────");
  console.log(`  ${pad(linhas.length)}  produtos lidos (cnp >= ${MIN_CNP.toLocaleString("pt-PT")})`);
  console.log(`  ${pad(semNada)}  sem classificação específica nem utilizações — nada a promover`);
  console.log(`  ${pad(candidatos.length)}  candidatos`);
  for (const [o, n] of Object.entries(porOrigem).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pad(n)}  ${o}`);
  }

  const antes = await estatisticasGlobal().catch(() => null);
  const r = await promoverAoGlobal(candidatos, { dryRun: !apply });

  console.log("\n── promoção ───────────────────────────────────────");
  console.log(`  ${pad(r.promovidos)}  ${apply ? "promovidos" : "a promover"}`);
  console.log(`  ${pad(r.recusados)}  recusados`);
  for (const [m, n] of Object.entries(r.motivos).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`      ${pad(n, 6)}  ${m}`);
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
