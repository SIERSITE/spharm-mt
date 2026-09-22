/**
 * scripts/classificar-grupos-laboratoriais-garantia.ts
 *
 * Classifica o grupo laboratorial PESQUISÁVEL de cada produto do tenant
 * garantia, aplicando os 6 níveis de precedência de
 * `lib/catalog/resolver-grupo-laboratorial.ts`. Reporta também, em
 * separado (nunca confundido com grupo — ver esse ficheiro):
 *   · propostas de preenchimento de `Produto.fabricanteId` para produtos
 *     sem fabricante (`lib/catalog/propostas-fabricante-por-cnp.ts`) —
 *     NUNCA escreve `fabricanteId`, mesmo com `--apply`;
 *   · candidatos adicionais a grupo laboratorial, além dos 5 iniciais
 *     (`lib/catalog/candidatos-grupo-laboratorial.ts`) — nunca cria
 *     grupos, só lista por frequência para investigação humana.
 *
 * ── Segurança: travado ao tenant garantia, em DUAS camadas ───────────
 * Igual a todo o resto desta iniciativa: `--tenant=garantia` verificado
 * ANTES de `resolverAlvo`, e outra vez DEPOIS da resolução (o control
 * plane podia, em teoria, resolver outra coisa).
 *
 * ── Segurança: dry-run é o default; --apply só escreve ProdutoGrupoLaboratorial ──
 * Mesmo com `--apply`, este script NUNCA escreve `Produto.fabricanteId`
 * nem cria `GrupoLaboratorial`/`GrupoLaboratorialFabricante`/
 * `RegraGrupoLaboratorialPorCnp` — essas são dados curados, geridos à
 * parte (ver `scripts/data/grupos-laboratoriais-iniciais-garantia.json`).
 * `--apply` só faz upsert de `ProdutoGrupoLaboratorial` para os 3 níveis
 * seguros de aplicar automaticamente (regra_cnp, fabricante_inequivoco,
 * alias_inequivoco) — nunca para `proposta_snapshot_cnp` (nível 4, só
 * proposta) nem `sem_grupo`.
 *
 * Uso:
 *   npx tsx scripts/classificar-grupos-laboratoriais-garantia.ts \
 *     --tenant=garantia \
 *     --relatorio=/relatorios/classificacao-grupos-garantia.json
 */
import "dotenv/config";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { buildTenantConnectionString, getTenantBySlug } from "../lib/control-plane";
import { AlvoRecusado, descreverAlvo, resolverAlvo, type AlvoDb } from "../lib/catalog/target-db";
import {
  resolverGruposEmLote,
  ORIGEM_POR_TIPO,
  type ProdutoParaResolver,
  type FabricanteParaResolver,
  type RegraCnpParaResolver,
  type SnapshotParaResolver,
  type GrupoFabricanteParaResolver,
  type AliasParaResolver,
  type MapasResolverGrupo,
} from "../lib/catalog/resolver-grupo-laboratorial";
import {
  resolverPropostasFabricanteEmLote,
  type ProdutoSemFabricanteParaResolver,
} from "../lib/catalog/propostas-fabricante-por-cnp";
import { descobrirCandidatosGrupoLaboratorial, type ProdutoParaCandidatos } from "../lib/catalog/candidatos-grupo-laboratorial";

export const TENANT_TRAVADO = "garantia";
export const BASE_ESPERADA = "spharmmt_t_garantia";

export type Args = { relatorioPath: string; apply: boolean };

export function parseArgs(argv: readonly string[]): Args {
  const out: Partial<Args> = { apply: false };
  for (const a of argv) {
    if (a.startsWith("--relatorio=")) out.relatorioPath = a.slice("--relatorio=".length);
    else if (a === "--apply") out.apply = true;
    else if (a.startsWith("--tenant=") || a === "--permitir-externo") {
      // Consumido por resolverAlvo.
    } else {
      throw new Error(`argumento desconhecido: ${a}`);
    }
  }
  if (!out.relatorioPath) throw new Error("--relatorio=<path> é obrigatório");
  return out as Args;
}

/** Segunda trava, DEPOIS de resolverAlvo — ver a mesma trava nos outros scripts desta iniciativa. */
export function confirmarAlvoGarantia(alvo: Pick<AlvoDb, "tenant" | "base">): void {
  if (alvo.tenant !== TENANT_TRAVADO) {
    throw new Error(`Alvo resolvido para tenant "${alvo.tenant}", não "${TENANT_TRAVADO}" — recusado.`);
  }
  if (alvo.base !== BASE_ESPERADA) {
    throw new Error(`Alvo resolvido para a base "${alvo.base}", não "${BASE_ESPERADA}" — recusado.`);
  }
}

/** Só os 3 níveis seguros de aplicar automaticamente. Nunca proposta_snapshot_cnp nem sem_grupo. */
export const TIPOS_APLICAVEIS_AUTOMATICAMENTE: ReadonlySet<string> = new Set(["regra_cnp", "fabricante_inequivoco", "alias_inequivoco"]);

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

type PrismaParaClassificacao = Pick<
  PrismaClient,
  "produto" | "fabricante" | "regraGrupoLaboratorialPorCnp" | "grupoLaboratorialFabricante" | "grupoLaboratorialAlias" | "produtoGrupoLaboratorial" | "regulatoryRecord" | "$transaction"
>;

export type ResultadoClassificacao = {
  grupos: ReturnType<typeof resolverGruposEmLote>["totais"];
  fabricante: ReturnType<typeof resolverPropostasFabricanteEmLote>["totais"];
  candidatosAdicionais: ReturnType<typeof descobrirCandidatosGrupoLaboratorial>;
  escritos?: number;
};

/**
 * Núcleo da classificação — extraído de `main()` para ser chamável
 * directamente com um `PrismaClient` já ligado (testes de integração,
 * incluindo o ensaio de volume real em Postgres descartável), sem passar
 * por `resolverAlvo`/`confirmarAlvoGarantia` (que são especificamente
 * para o caminho de produção via control plane, nunca para uma base de
 * testes local). `main()` (abaixo) continua a ser o único caminho que
 * escreve na VPS real — chama esta função DEPOIS das duas camadas de
 * confirmação de tenant.
 */
export async function classificarGruposLaboratoriais(prisma: PrismaParaClassificacao, args: { apply: boolean }): Promise<ResultadoClassificacao> {
  // ── 1. Carregar tudo o que o resolver precisa ──────────────────────
  const [produtosRaw, fabricantesRaw, regrasCnpRaw, gruposFabricanteRaw, aliasesRaw, existentesRaw] = await Promise.all([
    prisma.produto.findMany({ select: { id: true, cnp: true, fabricanteId: true, camposManuais: true } }),
    prisma.fabricante.findMany({ select: { id: true, nomeNormalizado: true } }),
    prisma.regraGrupoLaboratorialPorCnp.findMany({ select: { id: true, cnp: true, grupoLaboratorialId: true, estado: true, validadoManualmente: true } }),
    prisma.grupoLaboratorialFabricante.findMany({ select: { fabricanteId: true, grupoLaboratorialId: true } }),
    prisma.grupoLaboratorialAlias.findMany({ select: { grupoLaboratorialId: true, aliasNormalizado: true, estado: true } }),
    prisma.produtoGrupoLaboratorial.findMany({ select: { produtoId: true, grupoLaboratorialId: true, validadoManualmente: true } }),
  ]);

  const cnpsProdutos = [...new Set(produtosRaw.map((p) => p.cnp))];
  const snapshotsRaw = await prisma.regulatoryRecord.findMany({
    where: { cnp: { in: cnpsProdutos } },
    select: { cnp: true, titularAim: true, estadoAim: true },
  });

  // ── 2. Montar os mapas puros ────────────────────────────────────────
  const fabricantesPorId = new Map<string, FabricanteParaResolver>(fabricantesRaw.map((f) => [f.id, f]));
  const fabricantesPorNomeNormalizado = new Map<string, FabricanteParaResolver>(fabricantesRaw.map((f) => [f.nomeNormalizado, f]));
  const regrasCnpPorCnp = new Map<number, RegraCnpParaResolver>(regrasCnpRaw.map((r) => [r.cnp, r]));
  const snapshotsPorCnp = new Map<number, SnapshotParaResolver>(snapshotsRaw.map((s) => [s.cnp, s]));
  const gruposFabricantePorFabricanteId = new Map<string, GrupoFabricanteParaResolver>(gruposFabricanteRaw.map((g) => [g.fabricanteId, g]));
  const aliasesPorNomeNormalizado = new Map<string, AliasParaResolver[]>();
  for (const a of aliasesRaw) {
    const lista = aliasesPorNomeNormalizado.get(a.aliasNormalizado) ?? [];
    lista.push({ grupoLaboratorialId: a.grupoLaboratorialId, estado: a.estado });
    aliasesPorNomeNormalizado.set(a.aliasNormalizado, lista);
  }
  const existentesPorProdutoId = new Map(existentesRaw.map((e) => [e.produtoId, e]));

  const mapas: MapasResolverGrupo = {
    fabricantesPorId,
    fabricantesPorNomeNormalizado,
    regrasCnpPorCnp,
    snapshotsPorCnp,
    gruposFabricantePorFabricanteId,
    aliasesPorNomeNormalizado,
  };

  const produtosParaResolver: ProdutoParaResolver[] = produtosRaw.map((p) => ({
    id: p.id,
    cnp: p.cnp,
    fabricanteId: p.fabricanteId,
    grupoExistente: existentesPorProdutoId.get(p.id) ?? null,
  }));

  // ── 3. Resolver grupo laboratorial (todos os produtos) ─────────────
  const relatorioGrupos = resolverGruposEmLote(produtosParaResolver, mapas);

  // ── 4. Propostas de fabricante — SEPARADO, nunca escreve fabricanteId ──
  const produtosSemFabricante: ProdutoSemFabricanteParaResolver[] = produtosRaw
    .filter((p) => p.fabricanteId === null)
    .map((p) => ({ id: p.id, cnp: p.cnp, camposManuais: p.camposManuais }));
  const relatorioFabricante = resolverPropostasFabricanteEmLote(produtosSemFabricante, snapshotsPorCnp, fabricantesPorNomeNormalizado);

  // ── 5. Candidatos adicionais a grupo — nunca cria grupos ────────────
  const produtosParaCandidatos: ProdutoParaCandidatos[] = produtosRaw
    .filter((p) => p.fabricanteId !== null)
    .map((p) => ({ cnp: p.cnp, fabricanteNomeNormalizado: fabricantesPorId.get(p.fabricanteId!)?.nomeNormalizado ?? null }));
  const candidatos = descobrirCandidatosGrupoLaboratorial(produtosParaCandidatos, snapshotsPorCnp);

  console.log(`\n${"─".repeat(78)}`);
  console.log("Classificação de grupo laboratorial:");
  console.log(`  produtos:                 ${relatorioGrupos.totais.produtos}`);
  console.log(`  mantido manual:           ${relatorioGrupos.totais.mantidoManual}`);
  console.log(`  regra por CNP:            ${relatorioGrupos.totais.regraCnp}`);
  console.log(`  proposta snapshot (só dry-run): ${relatorioGrupos.totais.propostaSnapshotCnp}`);
  console.log(`  fabricante inequívoco:    ${relatorioGrupos.totais.fabricanteInequivoco}`);
  console.log(`  alias inequívoco:         ${relatorioGrupos.totais.aliasInequivoco}`);
  console.log(`  sem grupo (revisão):      ${relatorioGrupos.totais.semGrupo}`);

  console.log(`\n${"─".repeat(78)}`);
  console.log("Propostas de fabricante (produtos sem fabricante — SEPARADO de grupo):");
  console.log(`  total sem fabricante:     ${relatorioFabricante.totais.total}`);
  console.log(`  protegido manual:         ${relatorioFabricante.totais.protegidoManual}`);
  console.log(`  proposta actual: ${relatorioFabricante.totais.propostaAtual}`);
  console.log(`  revisão histórico: ${relatorioFabricante.totais.revisaoHistorico}`);
  console.log(`  sem correspondência:      ${relatorioFabricante.totais.semCorrespondencia}`);

  console.log(`\n${"─".repeat(78)}`);
  console.log(`Candidatos adicionais a grupo laboratorial (top 20 de ${candidatos.length}, nunca aplicados):`);
  for (const c of candidatos.slice(0, 20)) {
    console.log(`  ${c.ocorrencias}x  "${c.fabricanteGarantia}" → "${c.titularCatalogo}"`);
  }

  // ── 6. Apply — só ProdutoGrupoLaboratorial, só 3 níveis seguros ────
  //
  // Em lotes (LOTE_APPLY), cada um na sua própria transacção interactive —
  // NUNCA todos os upserts numa única transacção. Encontrado no ensaio de
  // volume real (2026-09-23): com ~3400 produtos a escrever, uma única
  // transacção interactive excede o timeout DEFAULT do Prisma (5000ms —
  // P2028 "query cannot be executed on an expired transaction") e a
  // corrida inteira falha a meio, sem nenhum produto escrito (rollback).
  // Em produção, com mais grupos/regras, o volume só tende a crescer —
  // isto teria falhado da mesma forma na VPS real. Cada lote continua
  // atómico dentro de si (all-or-nothing por lote de LOTE_APPLY produtos),
  // só deixou de ser atómico ao nível do TOTAL — uma troca aceitável para
  // uma operação idempotente (upsert): uma corrida interrompida a meio
  // não deixa nada inconsistente, só incompleto — repetir a classificação
  // retoma e completa (ver ensaio de idempotência, secção K).
  const LOTE_APPLY = 200;
  let escritos = 0;
  if (args.apply) {
    const paraEscrever = relatorioGrupos.resultados.filter((r) => TIPOS_APLICAVEIS_AUTOMATICAMENTE.has(r.resultado.tipo));
    for (let i = 0; i < paraEscrever.length; i += LOTE_APPLY) {
      const lote = paraEscrever.slice(i, i + LOTE_APPLY);
      await prisma.$transaction(async (tx) => {
        for (const r of lote) {
          if (r.resultado.tipo === "sem_grupo" || r.resultado.tipo === "mantido_manual" || r.resultado.tipo === "proposta_snapshot_cnp") continue;
          const grupoLaboratorialId = r.resultado.grupoLaboratorialId;
          const origem = ORIGEM_POR_TIPO[r.resultado.tipo];
          const regraCnpId = r.resultado.tipo === "regra_cnp" ? r.resultado.regraCnpId : null;
          await tx.produtoGrupoLaboratorial.upsert({
            where: { produtoId: r.produtoId },
            create: { produtoId: r.produtoId, grupoLaboratorialId, origem, regraCnpId },
            update: { grupoLaboratorialId, origem, regraCnpId },
          });
          escritos++;
        }
      });
    }
    console.log(`\n✔  Aplicado: ${escritos} ProdutoGrupoLaboratorial escritos/actualizados.`);
  }

  return {
    grupos: relatorioGrupos.totais,
    fabricante: relatorioFabricante.totais,
    candidatosAdicionais: candidatos,
    ...(args.apply ? { escritos } : {}),
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  const slugPedido = argv.find((a) => a.startsWith("--tenant="))?.slice("--tenant=".length);
  if (slugPedido !== TENANT_TRAVADO) {
    console.error(
      `\n[fatal] Este script está travado ao tenant "${TENANT_TRAVADO}" — recebeu --tenant=${slugPedido ?? "(nenhum)"}.\n` +
        `A classificação de grupos laboratoriais é exclusiva do tenant garantia nesta fase.\n`,
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

  const dryRun = !args.apply;
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: alvo.url }) });
  try {
    await prisma.$executeRawUnsafe(`set session default_transaction_read_only = ${dryRun ? "on" : "off"}`);

    console.log("═".repeat(78));
    console.log("Classificação de grupos laboratoriais — tenant garantia");
    console.log("═".repeat(78));
    console.log(`  ${descreverAlvo(alvo)}`);
    console.log(`  Modo: ${dryRun ? "DRY-RUN" : "APPLY"}`);

    const resultado = await classificarGruposLaboratoriais(prisma, { apply: args.apply });

    const relatorioParaDisco = {
      geradoEm: new Date().toISOString(),
      alvo: { base: alvo.base, host: alvo.host, tenant: alvo.tenant },
      modo: dryRun ? "DRY-RUN" : "APPLY",
      ...resultado,
    };
    escreverAtomico(args.relatorioPath, JSON.stringify(relatorioParaDisco, null, 2));
    console.log(`\nRelatório gravado em: ${args.relatorioPath}`);
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

if (/[\\/]classificar-grupos-laboratoriais-garantia\.(ts|js|mjs|cjs)$/.test(process.argv[1] ?? "")) {
  main().catch((err) => {
    console.error("[erro fatal]", err);
    process.exitCode = 1;
  });
}
