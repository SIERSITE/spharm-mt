/**
 * scripts/catalog-master/promote-global-knowledge.ts
 *
 * O CAMINHO EXPLÍCITO: leva validações manuais de um tenant ao catálogo
 * global, com nome de quem responde por isso e porquê.
 *
 * ── Porque é que isto é um comando à parte ───────────────────────────
 *
 * O `catalog:bootstrap-global` promove sozinho o que o modelo inferiu e o
 * que veio de fonte regulamentar. Não promove o que uma pessoa corrigiu à
 * mão, e a distinção não é técnica.
 *
 * Quem corrige um produto ao balcão está a dizer «nesta farmácia isto é
 * assim». Pode estar a corrigir um erro nacional — ou a acomodar uma
 * particularidade daquela farmácia, um acordo com um fornecedor, um
 * hábito de quem lá trabalha. As duas coisas parecem iguais na base de
 * dados. Só quem conhece o caso as distingue, e é essa pessoa que este
 * comando obriga a aparecer.
 *
 * ── O que exige, e não tem valores por omissão ───────────────────────
 *   --tenant=<slug>      de onde vem o conhecimento
 *   --aprovador="..."    QUEM responde por levar isto a todos os tenants
 *   --motivo="..."       PORQUÊ — fica no rasto e é o que se lê depois
 *   --cnp=... | --todos-os-validados   O QUE sobe, sempre explícito
 *
 * Nada disto tem default. Uma promoção sem autor não é auditável, e
 * `--todos-os-validados` tem de ser escrito à mão precisamente para que
 * ninguém promova o catálogo inteiro por distracção.
 *
 * ── O que continua a valer ───────────────────────────────────────────
 * A aprovação DESBLOQUEIA a origem HUMANO; não dispensa mais nada. Um
 * fallback ("Outros <X>") continua a não subir, e o que no global já tem
 * mais autoridade continua a ganhar. E na direcção inversa nada muda: o
 * `catalog:project-global` nunca toca num `validadoManualmente` local,
 * seja qual for a origem do que está no global.
 *
 * Dry-run é o default, e mostra a lista para revisão antes de assinar.
 *
 * Uso:
 *   npm run catalog:promote-global -- --tenant=<slug> \
 *     --aprovador="Bruno Reis" --motivo="revisão do catálogo de diabetes" \
 *     --cnp=5678901,5678902
 *
 *   npm run catalog:promote-global -- --tenant=<slug> \
 *     --aprovador="Bruno Reis" --motivo="..." --todos-os-validados --apply
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";
import { buildTenantConnectionString, getTenantBySlug } from "../../lib/control-plane";
import { AlvoRecusado, descreverAlvo, resolverAlvo } from "../../lib/catalog/target-db";
import { MIN_CNP } from "../../lib/catalog/knowledge-enrichment-runner";
import { KNOWLEDGE_VERSION } from "../../lib/catalog/knowledge-enrichment";
import { aprovacaoValida, type AprovacaoHumana } from "../../lib/catalog/global-catalog";
import { estatisticasGlobal, lerCandidatosDoTenant, promoverAoGlobal } from "../../lib/catalog/global-catalog-store";

const pad = (n: number | string, w = 7) => String(n).padStart(w);

const valor = (argv: string[], nome: string): string | null => {
  const p = argv.find((a) => a.startsWith(`--${nome}=`));
  return p ? p.slice(nome.length + 3).trim() : null;
};

function recusar(mensagem: string): never {
  console.error(`\n${mensagem}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");

  const aprovacao: AprovacaoHumana = {
    aprovador: valor(argv, "aprovador") ?? "",
    motivo: valor(argv, "motivo") ?? "",
  };
  if (!aprovacaoValida(aprovacao)) {
    recusar(
      "Uma promoção humana exige quem e porquê:\n" +
        '  --aprovador="Nome de quem responde por isto"\n' +
        '  --motivo="o que justifica valer para todas as farmácias"',
    );
  }

  const todos = argv.includes("--todos-os-validados");
  const listaCnp = valor(argv, "cnp");
  if (todos && listaCnp) {
    recusar("Escolher um: --cnp=<lista> ou --todos-os-validados. Os dois juntos são ambíguos.");
  }
  if (!todos && !listaCnp) {
    recusar(
      "Falta dizer O QUE promover:\n" +
        "  --cnp=5678901,5678902       produtos concretos\n" +
        "  --todos-os-validados        tudo o que este tenant validou à mão",
    );
  }

  let cnps: number[] | undefined;
  if (listaCnp) {
    cnps = listaCnp.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
    if (cnps.length === 0) recusar(`--cnp=${listaCnp} não tem nenhum código válido.`);
  }

  let alvo;
  try {
    alvo = await resolverAlvo(argv, { getTenantBySlug, buildTenantConnectionString });
  } catch (err) {
    if (err instanceof AlvoRecusado) recusar(err.message);
    throw err;
  }
  if (!alvo.tenant) {
    recusar("A promoção precisa de --tenant=<slug>: fica registado como origem do conhecimento.");
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: alvo.url }) });
  // Só lê do tenant. O que escreve é o control plane, e só com --apply.
  await prisma.$executeRawUnsafe("set session default_transaction_read_only = on");

  console.log("═".repeat(70));
  console.log(`${descreverAlvo(alvo)}${apply ? "" : "   (dry-run — nada é escrito)"}`);
  console.log(`aprovador: ${aprovacao.aprovador}`);
  console.log(`motivo   : ${aprovacao.motivo}`);
  console.log(`versão de regras: ${KNOWLEDGE_VERSION}`);
  console.log("═".repeat(70));

  const leitura = await lerCandidatosDoTenant(prisma, alvo.tenant!, {
    minCnp: MIN_CNP,
    versaoRegras: KNOWLEDGE_VERSION,
    cnps,
    // Este comando existe para o conhecimento humano. O resto sobe
    // sozinho pelo bootstrap e não precisa de assinatura de ninguém.
    apenasValidadosManualmente: true,
  });

  const humanos = leitura.candidatos.filter((c) => c.origem === "HUMANO");
  const outros = leitura.candidatos.length - humanos.length;

  console.log("\n── o que foi encontrado ───────────────────────────");
  console.log(`  ${pad(leitura.lidos)}  produtos validados à mão${cnps ? " (dentro dos --cnp pedidos)" : ""}`);
  console.log(`  ${pad(leitura.semNada)}  sem classificação específica nem utilizações — nada a promover`);
  console.log(`  ${pad(humanos.length)}  candidatos de origem HUMANO`);
  if (outros > 0) console.log(`  ${pad(outros)}  de outra origem — sobem pelo bootstrap, não por aqui`);

  if (cnps && cnps.length > 0) {
    const encontrados = new Set(leitura.candidatos.map((c) => c.cnp));
    const emFalta = cnps.filter((c) => !encontrados.has(c));
    if (emFalta.length > 0) {
      console.log(`  ${pad(emFalta.length)}  ⚠ pedidos que não estão validados à mão neste tenant`);
      console.log(`           ${emFalta.slice(0, 20).join(", ")}${emFalta.length > 20 ? " …" : ""}`);
    }
  }

  if (humanos.length === 0) {
    console.log("\n  Nada a promover.");
    await prisma.$disconnect();
    return;
  }

  // A lista é para ser lida ANTES de assinar. Em dry-run mostra-se tudo.
  console.log(`\n── o que ${apply ? "vai subir" : "subiria"} ──────────────────────────────`);
  const mostrar = apply ? 20 : humanos.length;
  for (const c of humanos.slice(0, mostrar)) {
    const classe = c.categoria ? `${c.categoria} > ${c.subcategoria}` : "(sem classificação específica)";
    const util = c.utilizacoes.length > 0 ? `  [${c.utilizacoes.map((u) => u.slug).join(", ")}]` : "";
    console.log(`  ${pad(c.cnp, 8)}  ${c.designacaoReferencia}`);
    console.log(`            ${classe}${util}`);
  }
  if (humanos.length > mostrar) console.log(`  … e mais ${humanos.length - mostrar}`);

  const antes = await estatisticasGlobal().catch(() => null);
  const r = await promoverAoGlobal(humanos, {
    dryRun: !apply,
    actor: aprovacao.aprovador,
    aprovacao,
  });

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
    console.log(`  ${pad(depois.porOrigem.HUMANO ?? 0)}  de origem HUMANO`);
    console.log("\n  Rasto em CatalogoGlobalPromocao (control plane):");
    console.log(`    select * from "CatalogoGlobalPromocao" where aprovador = '${aprovacao.aprovador}' order by "criadoEm" desc;`);
    console.log("\n  Isto NÃO alterou nenhum tenant. Para os alcançar:");
    console.log("    npm run catalog:project-global -- --tenant=<slug> --apply");
  } else {
    console.log("\n  dry-run — nada foi escrito. Rever a lista acima e, se estiver certa: --apply");
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("\n[erro fatal]", err);
  process.exit(1);
});
