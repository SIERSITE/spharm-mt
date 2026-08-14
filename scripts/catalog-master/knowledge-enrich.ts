/**
 * scripts/catalog-master/knowledge-enrich.ts
 *
 * Fase 3 do catálogo: knowledge-enrichment sobre o residual que as regras
 * determinísticas deixaram.
 *
 * Corre-o DEPOIS de classify-backfill e fill-rules, nunca antes. Se as
 * regras ainda não correram, este script paga o modelo para resolver
 * coisas que uma keyword resolvia de graça.
 *
 * A base é SEMPRE explícita — resolvida por `lib/catalog/target-db.ts`,
 * que recusa omissões e recusa hosts que não sejam produção. Não há
 * `--db` por omissão neste ficheiro, de propósito: um nome por omissão é
 * uma decisão tomada há meses por outra pessoa noutro contexto.
 *
 * Custa dinheiro real. Por isso:
 *   · dry-run é o default — sem `--apply` não escreve nada, nem cache;
 *   · `--canary` faz uma amostra ESTRATIFICADA (40/30/30) em vez dos
 *     primeiros N, que seriam só os cnp mais baixos;
 *   · `--tecto-usd` corta por custo estimado, que é a unidade em que a
 *     fatura vem.
 *
 * Uso:
 *   # canary estratificado de 100, sem escrever
 *   npx tsx scripts/catalog-master/knowledge-enrich.ts --tenant=silveira --canary
 *
 *   # o mesmo, a escrever
 *   npx tsx scripts/catalog-master/knowledge-enrich.ts --tenant=silveira --canary --apply
 *
 *   # bootstrap por lotes, com tecto de custo
 *   npx tsx scripts/catalog-master/knowledge-enrich.ts --tenant=silveira --limite=2000 --tecto-usd=15 --apply
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";
import { buildTenantConnectionString, getTenantBySlug } from "../../lib/control-plane";
import { AlvoRecusado, descreverAlvo, resolverAlvo } from "../../lib/catalog/target-db";
import {
  CAMPOS_ESCRITOS,
  CAMPOS_PROIBIDOS,
  KNOWLEDGE_MODEL,
  KNOWLEDGE_VERSION,
  LIMIAR_PERSISTENCIA,
  MAX_RETENTATIVAS,
  TIMEOUT_MS,
} from "../../lib/catalog/knowledge-enrichment";
import {
  runKnowledgeEnrichment,
  type Estrato,
  type LinhaRelatorio,
} from "../../lib/catalog/knowledge-enrichment-runner";

/** As quotas do canary, como pedidas. */
const QUOTAS_CANARY: Partial<Record<Estrato, number>> = {
  OUTROS_MEDICAMENTOS: 40,
  NAO_CLASSIFICADO: 30,
  SEM_UTILIZACOES: 30,
};

function corta(s: string, n: number): string {
  return s.length <= n ? s.padEnd(n) : `${s.slice(0, n - 1)}…`;
}

function imprimirRelatorio(linhas: LinhaRelatorio[]): void {
  const ordem: Record<string, number> = { APPLY: 0, REVIEW: 1, SKIP: 2 };
  const ordenadas = [...linhas].sort(
    (a, b) => ordem[a.decisao] - ordem[b.decisao] || a.estrato.localeCompare(b.estrato),
  );

  console.log("\n── relatório por produto ──────────────────────────────────────────────");
  let estratoActual = "";
  for (const l of ordenadas) {
    const cabeca = `${l.decisao}/${l.estrato}`;
    if (cabeca !== estratoActual) {
      console.log(`\n  ▸ ${l.decisao} · ${l.estrato}`);
      estratoActual = cabeca;
    }
    console.log(`    cnp ${String(l.cnp).padStart(7)}  ${corta(l.designacao, 46)}`);
    console.log(`      actual   : ${l.estadoAtual}`);
    console.log(`      proposta : ${l.proposta}   [${l.evidenceType} conf=${l.confidence.toFixed(2)}${l.verificado ? " ✓verificado" : ""}]`);
    if (l.utilizacoes.length) console.log(`      utiliz.  : ${l.utilizacoes.join(", ")}`);
    console.log(`      razão    : ${l.motivo}`);
    if (l.criterios && l.decisao !== "APPLY") {
      const falhados = Object.entries(l.criterios)
        .filter(([, v]) => !v)
        .map(([k]) => k);
      if (falhados.length) console.log(`      critérios falhados: ${falhados.join(", ")}`);
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const canary = argv.includes("--canary");
  const semRelatorio = argv.includes("--sem-relatorio");
  const limite = Number(argv.find((a) => a.startsWith("--limite="))?.split("=")[1] ?? 100);
  const tectoUsd = Number(argv.find((a) => a.startsWith("--tecto-usd="))?.split("=")[1] ?? 5);

  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.error(
      "Sem credencial da API. Exporta ANTHROPIC_API_KEY, ou corre `ant auth login`\n" +
        'e reexporta com: set -a; eval "$(ant auth print-credentials --env)"; set +a',
    );
    process.exit(1);
  }

  let alvo;
  try {
    alvo = await resolverAlvo(argv, { getTenantBySlug, buildTenantConnectionString });
  } catch (e) {
    if (e instanceof AlvoRecusado) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: alvo.url }) });
  // Sem `--apply` a sessão fica read-only na própria base. O runner já
  // não escreve em dry-run; isto é a segunda tranca, do lado do Postgres,
  // para o caso de um dia alguém acrescentar uma escrita no sítio errado.
  await prisma.$executeRawUnsafe(
    `set session default_transaction_read_only = ${apply ? "off" : "on"}`,
  );

  console.log(
    `${descreverAlvo(alvo)}${apply ? "" : "   (dry-run — sessão read-only; não escreve Produto, ProdutoUtilizacao nem cache)"}`,
  );
  console.log(`regras: ${KNOWLEDGE_VERSION} · modelo ${KNOWLEDGE_MODEL} · limiar ${LIMIAR_PERSISTENCIA}`);
  console.log(`rede: timeout ${TIMEOUT_MS / 1000}s · até ${MAX_RETENTATIVAS} retentativas (só 429/5xx/timeout)`);
  console.log(`escreve: ${CAMPOS_ESCRITOS.join(", ")}`);
  console.log(`nunca escreve: ${CAMPOS_PROIBIDOS.join(", ")}`);
  console.log(
    canary
      ? `amostra: canary estratificado ${Object.entries(QUOTAS_CANARY).map(([k, v]) => `${v} ${k}`).join(" + ")}`
      : `amostra: ${limite} produtos (ordem de cnp)`,
  );
  console.log(`tecto: $${tectoUsd}\n`);

  const r = await runKnowledgeEnrichment(prisma, {
    limite,
    dryRun: !apply,
    tectoUsd,
    canary: canary ? QUOTAS_CANARY : undefined,
    onProgress: (feito, total) => process.stdout.write(`\r  ${feito}/${total}`),
  });

  if (!semRelatorio) imprimirRelatorio(r.relatorio);

  const pad = (n: number) => String(n).padStart(6);
  const pct = (n: number, d: number) => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "—");

  console.log("\n\n── amostra ────────────────────────────────────────");
  console.log(`  ${pad(r.residualAnalisado)}  produtos entraram`);
  for (const [k, v] of Object.entries(r.porEstrato)) console.log(`  ${pad(v)}  ${k}`);

  console.log("\n── métricas do canary ─────────────────────────────");
  console.log(`  propostas válidas      ${pad(r.propostasValidas)}  ${pct(r.propostasValidas, r.residualAnalisado)} do que entrou`);
  console.log(`  exigiram verificação   ${pad(r.verificacoesAplicaveis)}  ${pct(r.verificacoesAplicaveis, r.propostasValidas)} das propostas`);
  console.log(`  acordo proposta/verif. ${pad(r.verificacoesConcordantes)}  ${pct(r.verificacoesConcordantes, r.verificacoesAplicaveis)} das verificadas`);
  console.log(`  auto-apply             ${pad(r.apply)}  ${pct(r.apply, r.residualAnalisado)} do que entrou`);
  console.log(`  para revisão           ${pad(r.review)}  ${pct(r.review, r.residualAnalisado)}`);
  console.log(`  skip (já resolvido)    ${pad(r.skip)}  ${pct(r.skip, r.residualAnalisado)}`);

  console.log("\n── discordâncias (candidatos a falso positivo) ────");
  const discordantes = r.relatorio.filter((l) => l.discordancia);
  if (discordantes.length === 0) {
    console.log("  nenhuma — as duas passagens concordaram em tudo o que exigiu verificação");
  } else {
    for (const d of discordantes.slice(0, 25)) {
      console.log(`  cnp ${d.cnp}  ${corta(d.designacao, 40)}`);
      console.log(`     ${d.motivo}`);
    }
    if (discordantes.length > 25) console.log(`  … e mais ${discordantes.length - 25}`);
  }

  console.log("\n── escrita ────────────────────────────────────────");
  if (apply) {
    console.log(`  ${pad(r.categoriasEscritas)}  categorias`);
    console.log(`  ${pad(r.productTypesEscritos)}  productType (só onde faltava)`);
    console.log(`  ${pad(r.utilizacoesEscritas)}  utilizações`);
  } else {
    console.log("  dry-run — nada foi escrito.");
  }

  console.log("\n── evidência ──────────────────────────────────────");
  for (const [k, v] of Object.entries(r.porEvidencia).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pad(v)}  ${k}`);
  }

  console.log("\n── custo ──────────────────────────────────────────");
  console.log(`  chamadas: ${r.chamadasProposta} proposta + ${r.chamadasVerificacao} verificação`);
  console.log(`  tokens: in ${r.usage.inputTokens} · out ${r.usage.outputTokens}`);
  console.log(`  cache: read ${r.usage.cacheReadTokens} · write ${r.usage.cacheWriteTokens}`);
  console.log(`  estimado: $${r.custoEstimadoUsd.toFixed(4)}`);
  if (r.cortadoPorTecto) {
    console.log(`  ⚠ corrida CORTADA ao atingir o tecto de $${tectoUsd} — o residual não foi todo visto.`);
  }
  if (r.residualAnalisado > 0) {
    const por100 = (r.custoEstimadoUsd / r.residualAnalisado) * 100;
    console.log(`  por 100 produtos: $${por100.toFixed(2)}`);
    console.log(`  extrapolado a 18 952 elegíveis: $${((por100 / 100) * 18952).toFixed(0)}`);
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
