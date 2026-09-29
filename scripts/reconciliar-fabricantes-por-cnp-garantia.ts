/**
 * scripts/reconciliar-fabricantes-por-cnp-garantia.ts
 *
 * CLI de backfill para `lib/catalog/reconciliar-fabricantes-por-cnp-
 * garantia.ts` — cobre, numa única corrida, TODOS os produtos do tenant
 * garantia sem `Produto.fabricanteId` (regra 8 da reconciliação de
 * fabricantes por CNP: "resolver numa única implementação todos os
 * produtos sem fabricante do tenant garantia, transação"). Chama
 * `reconciliarFabricantesPorCnpGarantiaTransacional` — o MESMO motor de
 * classificação usado online pelo ingest/enrich-catalog, mas com um modo
 * de escrita diferente (ver esse ficheiro): esta CLI constrói o plano
 * completo primeiro (zero escritas) e só depois aplica TUDO numa única
 * `prisma.$transaction` — nenhuma lógica de negócio própria aqui, só
 * orquestração de CLI (leitura de args, resolução do alvo real, escrita
 * do relatório).
 *
 * ── Segurança: travado ao tenant garantia, nas mesmas camadas de
 * `scripts/importar-grupos-laboratoriais-garantia.ts` ────────────────────
 *   1. `--tenant=garantia` obrigatório, verificado ANTES de resolverAlvo;
 *   2. `confirmarAlvoGarantia`, DEPOIS da resolução via control plane;
 *   3. o próprio serviço (`reconciliarFabricantesPorCnpGarantiaTransacional`)
 *      recusa qualquer `tenantSlug !== "garantia"` antes de qualquer
 *      query — terceira camada, independente desta CLI;
 *   4. para ESCREVER, exige as DUAS flags em simultâneo: `--apply` e
 *      `--confirmar-tenant=garantia` — falta uma, fica em dry-run.
 *
 * ── Dry-run é o default, sempre ───────────────────────────────────────
 * Sem `--apply` (ou sem `--confirmar-tenant=garantia` a acompanhá-lo):
 * zero escritas — o próprio serviço é chamado com `dryRun: true`, que
 * NUNCA abre uma transacção e nunca emite `produto.update`/`fabricante.
 * create`/`fabricanteAlias.create` (ver o ficheiro do serviço); a sessão
 * Postgres é também aberta read-only (`default_transaction_read_only=
 * on`), defesa em profundidade caso algum caminho novo viesse a escrever
 * sem passar por `dryRun`.
 *
 * ── Transacção única, tudo-ou-nada ──────────────────────────────────────
 * Com `--apply`, todas as escritas do lote — cada Fabricante novo, cada
 * FabricanteAlias novo, e cada `Produto.fabricanteId` — acontecem dentro
 * de uma ÚNICA `prisma.$transaction`, com timeout dimensionado ao
 * tamanho do plano (`calcularTimeoutTransacaoMs`). Se qualquer escrita
 * falhar a meio, a transacção inteira reverte — zero fabricantes, zero
 * aliases, zero `Produto.fabricanteId` alterados — e esta CLI reporta o
 * erro sem escrever nenhum relatório de sucesso (ver o `catch` em
 * `main()`). Nunca fica um subconjunto do lote aplicado.
 *
 * ── Idempotência ────────────────────────────────────────────────────────
 * Uma segunda corrida com `--apply` sobre o mesmo estado da base encontra
 * todos os produtos já resolvidos com `fabricanteId` preenchido — o nível
 * 1 do resolver (`ja_tem_fabricante`) intercepta-os antes de qualquer
 * escrita ser considerada — logo, zero escritas (e nenhuma transacção
 * chega a abrir-se) na segunda corrida.
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
 *   --plano-curado=<path>        Opcional — ver lib/catalog/plano-normalizacao-fabricantes-garantia.ts. Omitido:
 *                                reconciliação funciona sem ele (cai sempre para "criar novo"/"ambíguo", nunca
 *                                inventa). Derivado real disponível nesta branch, incluído na imagem migrator em
 *                                /app/scripts/data/plano-curado-fabricantes-garantia.json — 93 grupos, 226 aliases,
 *                                gerado por scripts/gerar-plano-curado-fabricantes-garantia.ts a partir da
 *                                investigação de 557 grupos da branch catalog/normalizacao-fabricantes-garantia.
 *   --apply                      Escreve — só com --confirmar-tenant= a acompanhar.
 *   --confirmar-tenant=garantia  Segunda confirmação explícita, exigida junto com --apply.
 *   --permitir-externo           Necessário se o tenant não for a VPS de produção.
 */
import "dotenv/config";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { buildTenantConnectionString, getTenantBySlug } from "../lib/control-plane";
import { AlvoRecusado, descreverAlvo, resolverAlvo, type AlvoDb } from "../lib/catalog/target-db";
import {
  reconciliarFabricantesPorCnpGarantiaTransacional,
  TENANT_TRAVADO,
  ESTADOS_AIM_ATUAIS,
  type ReconciliacaoFabricantesSummary,
} from "../lib/catalog/reconciliar-fabricantes-por-cnp-garantia";
import { carregarMapeamentoCuradoDoPlano } from "../lib/catalog/plano-normalizacao-fabricantes-garantia";

export const BASE_ESPERADA = "spharmmt_t_garantia";

/** Cópia local — cada CLI desta iniciativa tem a sua (ver o mesmo padrão em scripts/importar-grupos-laboratoriais-garantia.ts, scripts/simular-grupos-laboratoriais-garantia.ts): evita que a imagem `migrator` (deploy/docker/Dockerfile) tivesse de copiar um script inteiro só por esta função. */
export function escreverAtomico(caminhoFinal: string, conteudo: string): void {
  mkdirSync(dirname(caminhoFinal), { recursive: true });
  const tmp = `${caminhoFinal}.tmp-${process.pid}`;
  writeFileSync(tmp, conteudo, "utf8");
  try {
    renameSync(tmp, caminhoFinal);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

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

/**
 * Agrega `summary.ambiguidadesDetalhe` (uma entrada por PRODUTO
 * ambíguo) por `nomeNormalizado` — regra 7: "ambiguidades finais,
 * agrupadas por titularAim e candidatos". Vários produtos com o MESMO
 * titularAim geram a MESMA ambiguidade; o relatório mostra-a UMA vez,
 * com quantos produtos a partilham.
 */
function agruparAmbiguidades(summary: ReconciliacaoFabricantesSummary) {
  const porNome = new Map<string, { nomeNormalizado: string; motivo: string; candidatos: { fabricanteId: string; nomeNormalizado: string }[]; produtosAfectados: number; cnps: number[] }>();
  for (const a of summary.ambiguidadesDetalhe) {
    const existente = porNome.get(a.nomeNormalizado);
    if (existente) {
      existente.produtosAfectados++;
      existente.cnps.push(a.cnp);
    } else {
      porNome.set(a.nomeNormalizado, { nomeNormalizado: a.nomeNormalizado, motivo: a.motivo, candidatos: [...a.candidatos], produtosAfectados: 1, cnps: [a.cnp] });
    }
  }
  return [...porNome.values()].sort((a, b) => b.produtosAfectados - a.produtosAfectados);
}

/** Regra 8/9 (relatório) — os "ainda sem fabricante Autorizado/Ativo" agrupados por Fabricante canónico proposto para os aliases (regra 7: "240 aliases agrupados por fabricante"). */
function agruparAliasesPorFabricante(summary: ReconciliacaoFabricantesSummary) {
  const porFabricante = new Map<string, string[]>();
  for (const a of summary.aliasesCriadosDetalhe) {
    const lista = porFabricante.get(a.fabricanteNomeNormalizado) ?? [];
    lista.push(a.aliasNormalizado);
    porFabricante.set(a.fabricanteNomeNormalizado, lista);
  }
  return [...porFabricante.entries()]
    .map(([fabricanteNomeNormalizado, aliases]) => ({ fabricanteNomeNormalizado, aliases: aliases.sort(), total: aliases.length }))
    .sort((a, b) => b.total - a.total);
}

function calcularDerivados(summary: ReconciliacaoFabricantesSummary) {
  const resolvidosAutomaticamente =
    summary.resolvidosPorNomeNormalizado + summary.resolvidosPorAlias + summary.resolvidosPorPlanoCurado +
    summary.resolvidosPorPrefixo + summary.resolvidosPorEvidenciaPortfolio;
  const semFonteTotal =
    summary.semFonte.FORA_UNIVERSO_INFARMED + summary.semFonte.SEM_REGISTO_CATALOGO +
    summary.semFonte.FABRICANTE_NAO_INFORMADO_PELA_ORIGEM + summary.semFonte.TITULAR_INVALIDO;
  const resolvidosHistoricos = Object.entries(summary.estadosAim)
    .filter(([estado]) => !ESTADOS_AIM_ATUAIS.has(estado))
    .reduce((soma, [, n]) => soma + n, 0);
  const totalAindaSemFabricante = semFonteTotal + summary.ambiguidades;
  const ambiguidadesAgrupadas = agruparAmbiguidades(summary);
  const aliasesAgrupados = agruparAliasesPorFabricante(summary);
  return { resolvidosAutomaticamente, semFonteTotal, resolvidosHistoricos, totalAindaSemFabricante, ambiguidadesAgrupadas, aliasesAgrupados };
}

function imprimirResumo(summary: ReconciliacaoFabricantesSummary, dryRun: boolean): void {
  const d = calcularDerivados(summary);
  console.log(`\nModo: ${dryRun ? "DRY-RUN" : "APPLY"}`);
  console.log(`Total sem fabricante (analisados):             ${summary.analisados}`);
  console.log(`Já tinham fabricante (não tocados):             ${summary.jaTinhaFabricante}  (divergências: ${summary.divergencias})`);
  console.log(`Protegidos manualmente:                        ${summary.protegidosManualmente}`);
  console.log(`Resolvidos — correspondência exacta:            ${summary.resolvidosPorNomeNormalizado}`);
  console.log(`Resolvidos — alias:                             ${summary.resolvidosPorAlias}`);
  console.log(`Resolvidos — plano curado:                      ${summary.resolvidosPorPlanoCurado}`);
  console.log(`Resolvidos — truncagem (prefixo):               ${summary.resolvidosPorPrefixo}`);
  console.log(`Resolvidos — evidência de portefólio:           ${summary.resolvidosPorEvidenciaPortfolio}`);
  console.log(`Resolvidos automaticamente (total):             ${d.resolvidosAutomaticamente}`);
  console.log(`Novos fabricantes a criar:                      ${summary.fabricantesCriados}`);
  for (const nome of summary.fabricantesCriadosDetalhe) console.log(`  · "${nome}"`);
  console.log(`Aliases/mapeamentos criados:                    ${summary.aliasesCriados}`);
  for (const g of d.aliasesAgrupados) {
    console.log(`  · "${g.fabricanteNomeNormalizado}" — ${g.total} alias(es): ${g.aliases.map((a) => `"${a}"`).join(", ")}`);
  }
  console.log(`Históricos resolvidos (Anulado/Revogado/etc.):  ${d.resolvidosHistoricos}`);
  console.log(`CNP abaixo de 2.000.000:                        ${summary.semFonte.FORA_UNIVERSO_INFARMED}`);
  console.log(`Sem registo no catálogo:                        ${summary.semFonte.SEM_REGISTO_CATALOGO}`);
  console.log(`Sem fabricante na origem/ERP:                   ${summary.semFonte.FABRICANTE_NAO_INFORMADO_PELA_ORIGEM}`);
  console.log(`Titular inválido:                               ${summary.semFonte.TITULAR_INVALIDO}`);
  console.log(`Ambiguidades finais (produtos):                 ${summary.ambiguidades}  (${d.ambiguidadesAgrupadas.length} titularAim distinto(s))`);
  for (const amb of d.ambiguidadesAgrupadas.slice(0, 20)) {
    console.log(`  · "${amb.nomeNormalizado}" [${amb.motivo}] — ${amb.produtosAfectados} produto(s) [CNP ${amb.cnps.join(", ")}], candidatos: ${amb.candidatos.map((c) => `${c.nomeNormalizado} (${c.fabricanteId})`).join(" vs ")}`);
  }
  if (d.ambiguidadesAgrupadas.length > 20) console.log(`  · … e mais ${d.ambiguidadesAgrupadas.length - 20} titularAim distinto(s) — ver o relatório completo em disco.`);
  console.log(`Estados AIM dos resolvidos:                     ${JSON.stringify(summary.estadosAim)}`);
  console.log(`Ainda sem fabricante e Autorizado/Ativo (#10):  ${summary.aindaSemFabricanteAtual}`);
  for (const d2 of summary.aindaSemFabricanteDetalhe.slice(0, 50)) {
    console.log(`  · CNP ${d2.cnp} — ${d2.origem}:${d2.motivo}${d2.nomeNormalizado ? ` ("${d2.nomeNormalizado}")` : ""}`);
  }
  if (summary.aindaSemFabricanteDetalhe.length > 50) console.log(`  · … e mais ${summary.aindaSemFabricanteDetalhe.length - 50} CNP(s) — ver o relatório completo em disco.`);
  console.log(`Erros (isolados por produto):                   ${summary.erros}`);
  console.log(`Duração:                                        ${summary.durationMs}ms`);

  console.log(`\nResumo — dos ${summary.analisados} produtos sem fabricante analisados:`);
  console.log(`  resolvidos automaticamente: ${d.resolvidosAutomaticamente}`);
  console.log(`  continuam sem fabricante (total): ${d.totalAindaSemFabricante}`);
  console.log(`    · sem fonte (motivo explícito): ${d.semFonteTotal}`);
  console.log(`    · bloqueados por ambiguidade: ${summary.ambiguidades}`);
  console.log(`  protegidos manualmente: ${summary.protegidosManualmente}`);
}

const USO = `Reconciliação de fabricantes por CNP (garantia) — CLI de backfill.

Uso:
  npx tsx scripts/reconciliar-fabricantes-por-cnp-garantia.ts \\
    --tenant=garantia --relatorio=<path> [--plano-curado=<path>]

  npx tsx scripts/reconciliar-fabricantes-por-cnp-garantia.ts \\
    --tenant=garantia --relatorio=<path> \\
    --apply --confirmar-tenant=garantia

Opções:
  --tenant=<slug>              Obrigatório — só "garantia" é aceite.
  --relatorio=<path>           Obrigatório.
  --plano-curado=<path>        Opcional. Na imagem migrator: /app/scripts/data/plano-curado-fabricantes-garantia.json
  --apply                      Escreve — só com --confirmar-tenant= a acompanhar.
  --confirmar-tenant=garantia  Segunda confirmação explícita, exigida junto com --apply.
  --permitir-externo           Necessário se o tenant não for a VPS de produção.
  --help, -h                   Mostra esta ajuda e sai (sem tocar em nenhuma base).
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USO);
    return;
  }

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

    let summary: ReconciliacaoFabricantesSummary;
    try {
      summary = await reconciliarFabricantesPorCnpGarantiaTransacional(prisma, TENANT_TRAVADO, { tipo: "todos", mapeamentoCurado, dryRun });
    } catch (err) {
      // O plano é construído por inteiro ANTES de qualquer escrita, e em
      // --apply as escritas do lote são uma ÚNICA prisma.$transaction —
      // se isto lançar, a transacção reverteu por inteiro (Fabricante,
      // FabricanteAlias e Produto.fabricanteId incluídos). Reporta o erro
      // e sai sem fingir que algo foi persistido.
      console.error(`\n[fatal] a transacção falhou e foi revertida por inteiro — zero alterações persistidas:\n  ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
      return;
    }

    imprimirResumo(summary, dryRun);

    const d = calcularDerivados(summary);

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
      resolvidosPorCorrespondenciaExata: summary.resolvidosPorNomeNormalizado,
      resolvidosPorAlias: summary.resolvidosPorAlias,
      resolvidosPorPlanoCurado: summary.resolvidosPorPlanoCurado,
      resolvidosPorTruncagem: summary.resolvidosPorPrefixo,
      resolvidosPorEvidenciaPortfolio: summary.resolvidosPorEvidenciaPortfolio,
      resolvidosAutomaticamenteTotal: d.resolvidosAutomaticamente,
      resolvidosHistoricos: d.resolvidosHistoricos,
      fabricantesCriados: summary.fabricantesCriados,
      fabricantesCriadosNomes: summary.fabricantesCriadosDetalhe,
      aliasesCriados: summary.aliasesCriados,
      aliasesCriadosPorFabricante: d.aliasesAgrupados,
      fabricantesExistentesPreservados: summary.jaTinhaFabricante,
      cnpAbaixoDe2Milhoes: summary.semFonte.FORA_UNIVERSO_INFARMED,
      semRegistoNoCatalogo: summary.semFonte.SEM_REGISTO_CATALOGO,
      semFabricanteNaOrigem: summary.semFonte.FABRICANTE_NAO_INFORMADO_PELA_ORIGEM,
      titularInvalido: summary.semFonte.TITULAR_INVALIDO,
      semFontePorMotivo: summary.semFonte,
      semFonteTotal: d.semFonteTotal,
      ambiguidades: summary.ambiguidades,
      ambiguidadesAgrupadasPorTitularAim: d.ambiguidadesAgrupadas,
      estadosAim: summary.estadosAim,
      naoResolvidosTotal: d.totalAindaSemFabricante,
      aindaSemFabricanteAutorizadoOuAtivo: summary.aindaSemFabricanteAtual,
      aindaSemFabricanteAutorizadoOuAtivoDetalhe: summary.aindaSemFabricanteDetalhe,
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
