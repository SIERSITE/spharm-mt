/**
 * scripts/reconciliar-fabricantes-por-cnp-garantia.ts
 *
 * CLI de backfill para `lib/catalog/reconciliar-fabricantes-por-cnp-
 * garantia.ts` — cobre, numa única corrida, TODOS os produtos do tenant
 * garantia sem `Produto.fabricanteId` (regra 8 da reconciliação de
 * fabricantes por CNP: "resolver numa única implementação todos os
 * produtos sem fabricante do tenant garantia"). Chama o MESMO serviço
 * usado online pelo ingest e pelo enrich-catalog diário — nenhuma lógica
 * de negócio própria, só orquestração de CLI (leitura de args, resolução
 * do alvo real, escrita do relatório).
 *
 * ── Segurança: travado ao tenant garantia, nas mesmas camadas de
 * `scripts/importar-grupos-laboratoriais-garantia.ts` ────────────────────
 *   1. `--tenant=garantia` obrigatório, verificado ANTES de resolverAlvo;
 *   2. `confirmarAlvoGarantia`, DEPOIS da resolução via control plane;
 *   3. o próprio serviço (`reconciliarFabricantesPorCnpGarantia`) recusa
 *      qualquer `tenantSlug !== "garantia"` antes de qualquer query —
 *      terceira camada, independente desta CLI;
 *   4. para ESCREVER, exige as DUAS flags em simultâneo: `--apply` e
 *      `--confirmar-tenant=garantia` — falta uma, fica em dry-run.
 *
 * ── Dry-run é o default, sempre ───────────────────────────────────────
 * Sem `--apply` (ou sem `--confirmar-tenant=garantia` a acompanhá-lo):
 * zero escritas — o próprio serviço é chamado com `dryRun: true`, que
 * nunca emite `produto.update`/`fabricante.create`/`fabricanteAlias.
 * create` (ver o ficheiro do serviço); a sessão Postgres é também aberta
 * read-only (`default_transaction_read_only=on`), defesa em profundidade
 * caso algum caminho novo viesse a escrever sem passar por `dryRun`.
 *
 * ── Idempotência ────────────────────────────────────────────────────────
 * Uma segunda corrida com `--apply` sobre o mesmo estado da base encontra
 * todos os produtos já resolvidos com `fabricanteId` preenchido — o nível
 * 1 do resolver (`ja_tem_fabricante`) intercepta-os antes de qualquer
 * escrita ser considerada — logo, zero escritas na segunda corrida.
 *
 * Uso:
 *   npx tsx scripts/reconciliar-fabricantes-por-cnp-garantia.ts \
 *     --tenant=garantia \
 *     --relatorio=/relatorios/reconciliar-fabricantes-garantia.json
 *
 *   npx tsx scripts/reconciliar-fabricantes-por-cnp-garantia.ts \
 *     --tenant=garantia \
 *     --relatorio=/relatorios/reconciliar-fabricantes-garantia-apply.json \
 *     --apply --confirmar-tenant=garantia
 *
 * Opções:
 *   --tenant=<slug>              Obrigatório — resolvido via resolverAlvo (control plane), nunca DATABASE_URL genérico.
 *   --relatorio=<path>           Obrigatório.
 *   --plano-curado=<path>        Opcional — ver lib/catalog/plano-normalizacao-fabricantes-garantia.ts. Omitido: reconciliação funciona sem ele.
 *   --apply                      Escreve — só com --confirmar-tenant= a acompanhar.
 *   --confirmar-tenant=garantia  Segunda confirmação explícita, exigida junto com --apply.
 *   --permitir-externo           Necessário se o tenant não for a VPS de produção.
 */
import "dotenv/config";
import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { buildTenantConnectionString, getTenantBySlug } from "../lib/control-plane";
import { AlvoRecusado, descreverAlvo, resolverAlvo, type AlvoDb } from "../lib/catalog/target-db";
import { reconciliarFabricantesPorCnpGarantia, TENANT_TRAVADO, type ReconciliacaoFabricantesSummary } from "../lib/catalog/reconciliar-fabricantes-por-cnp-garantia";
import { carregarMapeamentoCuradoDoPlano } from "../lib/catalog/plano-normalizacao-fabricantes-garantia";
import { escreverAtomico } from "./importar-grupos-laboratoriais-garantia";

export const BASE_ESPERADA = "spharmmt_t_garantia";

export type Args = {
  relatorioPath: string;
  planoCuradoPath?: string;
  apply: boolean;
  confirmarTenant?: string;
};

export function parseArgs(argv: readonly string[]): Args {
  const out: Partial<Args> = { apply: false };
  for (const a of argv) {
    if (a.startsWith("--relatorio=")) out.relatorioPath = a.slice("--relatorio=".length);
    else if (a.startsWith("--plano-curado=")) out.planoCuradoPath = a.slice("--plano-curado=".length);
    else if (a.startsWith("--confirmar-tenant=")) out.confirmarTenant = a.slice("--confirmar-tenant=".length);
    else if (a === "--apply") out.apply = true;
    else if (a.startsWith("--tenant=") || a === "--permitir-externo") {
      // Consumido por resolverAlvo.
    } else {
      throw new Error(`argumento desconhecido: ${a}`);
    }
  }
  if (!out.relatorioPath) throw new Error("--relatorio=<path> é obrigatório");
  if (out.apply && out.confirmarTenant !== TENANT_TRAVADO) {
    throw new Error(
      `--apply exige também --confirmar-tenant=${TENANT_TRAVADO} (dupla confirmação explícita).\n` +
        `Recebido --confirmar-tenant=${out.confirmarTenant ?? "(nenhum)"}. Sem as duas flags, não escreve.`,
    );
  }
  return out as Args;
}

/** Segunda trava, DEPOIS de resolverAlvo — mesmo padrão dos outros scripts desta iniciativa. */
export function confirmarAlvoGarantia(alvo: Pick<AlvoDb, "tenant" | "base">): void {
  if (alvo.tenant !== TENANT_TRAVADO) {
    throw new Error(`Alvo resolvido para tenant "${alvo.tenant}", não "${TENANT_TRAVADO}" — recusado.`);
  }
  if (alvo.base !== BASE_ESPERADA) {
    throw new Error(`Alvo resolvido para a base "${alvo.base}", não "${BASE_ESPERADA}" — recusado.`);
  }
}

function imprimirResumo(summary: ReconciliacaoFabricantesSummary, dryRun: boolean): void {
  console.log(`\nModo: ${dryRun ? "DRY-RUN" : "APPLY"}`);
  console.log(`Produtos analisados (sem fabricante):        ${summary.analisados}`);
  console.log(`Já tinham fabricante (não tocados):          ${summary.jaTinhaFabricante}  (divergências: ${summary.divergencias})`);
  console.log(`Protegidos manualmente:                      ${summary.protegidosManualmente}`);
  console.log(`Resolvidos — nome normalizado:                ${summary.resolvidosPorNomeNormalizado}`);
  console.log(`Resolvidos — alias:                           ${summary.resolvidosPorAlias}`);
  console.log(`Resolvidos — plano curado:                    ${summary.resolvidosPorPlanoCurado}`);
  console.log(`Fabricantes criados:                          ${summary.fabricantesCriados}`);
  console.log(`Aliases criados:                              ${summary.aliasesCriados}`);
  console.log(`Ambiguidades (nunca escolhidas):               ${summary.ambiguidades}`);
  console.log(`Sem fonte — FORA_UNIVERSO_INFARMED:            ${summary.semFonte.FORA_UNIVERSO_INFARMED}`);
  console.log(`Sem fonte — SEM_REGISTO_CATALOGO:              ${summary.semFonte.SEM_REGISTO_CATALOGO}`);
  console.log(`Sem fonte — FABRICANTE_NAO_INFORMADO_ORIGEM:   ${summary.semFonte.FABRICANTE_NAO_INFORMADO_PELA_ORIGEM}`);
  console.log(`Sem fonte — TITULAR_INVALIDO:                  ${summary.semFonte.TITULAR_INVALIDO}`);
  console.log(`Estados AIM dos resolvidos:                    ${JSON.stringify(summary.estadosAim)}`);
  console.log(`Ainda sem fabricante e Autorizado/Ativo (#10): ${summary.aindaSemFabricanteAtual}`);
  console.log(`Erros (isolados por produto):                  ${summary.erros}`);
  console.log(`Duração:                                       ${summary.durationMs}ms`);

  const resolvidosAutomaticamente = summary.resolvidosPorNomeNormalizado + summary.resolvidosPorAlias + summary.resolvidosPorPlanoCurado;
  const semFonteTotal = summary.semFonte.FORA_UNIVERSO_INFARMED + summary.semFonte.SEM_REGISTO_CATALOGO + summary.semFonte.FABRICANTE_NAO_INFORMADO_PELA_ORIGEM + summary.semFonte.TITULAR_INVALIDO;
  console.log(`\nResumo — dos ${summary.analisados} produtos sem fabricante analisados:`);
  console.log(`  resolvidos automaticamente: ${resolvidosAutomaticamente}`);
  console.log(`  sem fonte (motivo explícito): ${semFonteTotal}`);
  console.log(`  bloqueados por ambiguidade: ${summary.ambiguidades}`);
  console.log(`  protegidos manualmente: ${summary.protegidosManualmente}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  const slugPedido = argv.find((a) => a.startsWith("--tenant="))?.slice("--tenant=".length);
  if (slugPedido !== TENANT_TRAVADO) {
    console.error(
      `\n[fatal] Este script está travado ao tenant "${TENANT_TRAVADO}" — recebeu --tenant=${slugPedido ?? "(nenhum)"}.\n` +
        `A reconciliação de fabricantes por CNP é exclusiva do tenant garantia.\n`,
    );
    process.exitCode = 1;
    return;
  }

  const args = parseArgs(argv);

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
  confirmarAlvoGarantia(alvo);

  const mapeamentoCurado = carregarMapeamentoCuradoDoPlano(args.planoCuradoPath);
  const dryRun = !args.apply;
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: alvo.url }) });
  try {
    await prisma.$executeRawUnsafe(`set session default_transaction_read_only = ${dryRun ? "on" : "off"}`);

    console.log("═".repeat(78));
    console.log("Reconciliação de fabricantes por CNP — tenant garantia");
    console.log("═".repeat(78));
    console.log(`  ${descreverAlvo(alvo)}`);
    console.log(`  Modo: ${dryRun ? "DRY-RUN" : "APPLY"}`);
    console.log(`  plano curado: ${args.planoCuradoPath ?? "(nenhum)"} — ${mapeamentoCurado.size} mapeamento(s) carregado(s)`);

    const summary = await reconciliarFabricantesPorCnpGarantia(prisma, TENANT_TRAVADO, { tipo: "todos", mapeamentoCurado, dryRun });

    imprimirResumo(summary, dryRun);

    const resolvidosAutomaticamente = summary.resolvidosPorNomeNormalizado + summary.resolvidosPorAlias + summary.resolvidosPorPlanoCurado;
    const semFonteTotal = summary.semFonte.FORA_UNIVERSO_INFARMED + summary.semFonte.SEM_REGISTO_CATALOGO + summary.semFonte.FABRICANTE_NAO_INFORMADO_PELA_ORIGEM + summary.semFonte.TITULAR_INVALIDO;

    const relatorioParaDisco = {
      geradoEm: new Date().toISOString(),
      tenant: alvo.tenant,
      base: alvo.base,
      modo: dryRun ? "DRY-RUN" : "APPLY",
      planoCuradoPath: args.planoCuradoPath ?? null,
      planoCuradoMapeamentos: mapeamentoCurado.size,
      totalSemFabricanteAnalisados: summary.analisados,
      jaTinhaFabricante: summary.jaTinhaFabricante,
      divergencias: summary.divergencias,
      protegidosManualmente: summary.protegidosManualmente,
      resolvidosPorNomeNormalizado: summary.resolvidosPorNomeNormalizado,
      resolvidosPorAlias: summary.resolvidosPorAlias,
      resolvidosPorPlanoCurado: summary.resolvidosPorPlanoCurado,
      resolvidosAutomaticamenteTotal: resolvidosAutomaticamente,
      fabricantesCriados: summary.fabricantesCriados,
      aliasesCriados: summary.aliasesCriados,
      fabricantesExistentesPreservados: summary.jaTinhaFabricante,
      ambiguidades: summary.ambiguidades,
      semFontePorMotivo: summary.semFonte,
      semFonteTotal,
      estadosAim: summary.estadosAim,
      naoResolvidosTotal: semFonteTotal + summary.ambiguidades,
      aindaSemFabricanteAutorizadoOuAtivo: summary.aindaSemFabricanteAtual,
      erros: summary.erros,
      durationMs: summary.durationMs,
    };
    escreverAtomico(args.relatorioPath, JSON.stringify(relatorioParaDisco, null, 2));
    console.log(`\nRelatório gravado em: ${args.relatorioPath}`);
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

if (/[\\/]reconciliar-fabricantes-por-cnp-garantia\.(ts|js|mjs|cjs)$/.test(process.argv[1] ?? "")) {
  main().catch((err) => {
    console.error("[erro fatal]", err);
    process.exitCode = 1;
  });
}
