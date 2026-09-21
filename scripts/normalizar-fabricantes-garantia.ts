/**
 * scripts/normalizar-fabricantes-garantia.ts
 *
 * Executa, em lote, o plano de normalização de `Fabricante` do tenant
 * garantia descrito em `scripts/data/plano-execucao-normalizacao-garantia.json`
 * (7 `verified_business_changes` + 561 `orthographic_merges`, cada um
 * um merge winner/loser(s) já decidido e aprovado fora deste script —
 * ver `execution_rules` desse ficheiro). Este ficheiro NÃO investiga
 * nem reclassifica fabricante nenhum: só verifica que os IDs do plano
 * existem mesmo nesta base, respeita `do_not_merge`, e aplica
 * mecanicamente o que `lib/catalog-fabricante-merge.ts` já sabe fazer
 * a um par de cada vez — `lib/catalog-fabricante-normalizacao-batch.ts`
 * é só a orquestração dos ~570 grupos numa única transacção.
 *
 * ── Segurança: travado ao tenant garantia ────────────────────────────
 * `--tenant=garantia` é o ÚNICO valor aceite — este script recusa-se a
 * correr contra qualquer outro tenant, mesmo que --tenant= aponte para
 * outro (o plano é específico da garantia; correr isto acidentalmente
 * noutro tenant reatribuiria produtos de fabricantes que nem existem
 * lá com o mesmo significado). Além disso, o `tenant` do próprio
 * ficheiro do plano tem de ser "garantia" — outra camada da mesma
 * trava.
 *
 * ── Segurança: dry-run é o DEFAULT ───────────────────────────────────
 * Mesma polaridade de `merge-fabricantes.ts` e
 * `correct-fabricantes-listagem.ts` — nunca escreve nada sem --apply
 * explícito.
 *
 * ── Segurança: tudo numa transacção ──────────────────────────────────
 * `executarNormalizacaoBatch` (lib) aplica os ~570 grupos dentro de UMA
 * transacção interactiva — ou fica tudo aplicado, ou nada (rollback
 * automático em caso de erro a meio).
 *
 * Uso:
 *   # 1. Dry-run — SEMPRE primeiro. Imprime o relatório completo e
 *   #    grava uma cópia em JSON para auditoria. Não escreve nada.
 *   npx tsx scripts/normalizar-fabricantes-garantia.ts \
 *     --tenant=garantia \
 *     --source=normalizacao-fabricantes-garantia-2026-09
 *
 *   # 2. Aplicar, depois de validar o dry-run.
 *   npx tsx scripts/normalizar-fabricantes-garantia.ts \
 *     --tenant=garantia \
 *     --source=normalizacao-fabricantes-garantia-2026-09 \
 *     --apply
 *
 * Opções:
 *   --tenant=garantia     Obrigatório, e tem de ser exactamente "garantia".
 *   --plano=<path>        Opcional. Default:
 *                         scripts/data/plano-execucao-normalizacao-garantia.json
 *   --source=<tag>        Obrigatório. Gravado em EnrichmentSourceLog.source.
 *   --apply               Escreve de facto. Omitido → dry-run (default).
 *   --relatorio=<path>    Opcional. Onde gravar o relatório JSON detalhado.
 *                         Default: scripts/data/relatorio-normalizacao-garantia.json
 *   --incluir-validados-manualmente
 *                         Opt-in — ver lib/catalog-fabricante-merge.ts.
 *   --permitir-externo    Necessário se o tenant não for a VPS de produção.
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { buildTenantConnectionString, getTenantBySlug } from "../lib/control-plane";
import { AlvoRecusado, descreverAlvo, resolverAlvo, type AlvoDb } from "../lib/catalog/target-db";
import type { ProdutoDoLoser } from "../lib/catalog-fabricante-merge";
import {
  combinarGrupos,
  executarNormalizacaoBatch,
  planearNormalizacaoBatch,
  type FabricanteDb,
  type PlanoNormalizacaoArquivo,
} from "../lib/catalog-fabricante-normalizacao-batch";

const TENANT_TRAVADO = "garantia";
const PLANO_DEFAULT = resolve(__dirname, "data", "plano-execucao-normalizacao-garantia.json");
const RELATORIO_DEFAULT = resolve(__dirname, "data", "relatorio-normalizacao-garantia.json");

type Args = {
  planoPath: string;
  relatorioPath: string;
  source: string;
  apply: boolean;
  incluirValidadosManualmente: boolean;
};

export function parseArgs(argv: readonly string[]): Args {
  const out: Partial<Args> = { apply: false, incluirValidadosManualmente: false };
  for (const a of argv) {
    if (a.startsWith("--plano=")) out.planoPath = a.slice("--plano=".length);
    else if (a.startsWith("--relatorio=")) out.relatorioPath = a.slice("--relatorio=".length);
    else if (a.startsWith("--source=")) out.source = a.slice("--source=".length);
    else if (a === "--apply") out.apply = true;
    else if (a === "--incluir-validados-manualmente") out.incluirValidadosManualmente = true;
    else if (a.startsWith("--tenant=") || a === "--permitir-externo") {
      // Consumido por resolverAlvo. Nada a fazer aqui.
    } else {
      throw new Error(`argumento desconhecido: ${a}`);
    }
  }
  if (!out.source) throw new Error("--source=<tag> é obrigatório");
  out.planoPath ??= PLANO_DEFAULT;
  out.relatorioPath ??= RELATORIO_DEFAULT;
  return out as Args;
}

function carregarPlano(path: string): PlanoNormalizacaoArquivo {
  const bruto = readFileSync(path, "utf8");
  const plano = JSON.parse(bruto) as PlanoNormalizacaoArquivo;
  if (plano.tenant !== TENANT_TRAVADO) {
    throw new Error(
      `O plano em ${path} diz respeito ao tenant "${plano.tenant}", não "${TENANT_TRAVADO}". ` +
        `Este script está travado ao tenant garantia — recusado.`,
    );
  }
  return plano;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  const slugPedido = argv.find((a) => a.startsWith("--tenant="))?.slice("--tenant=".length);
  if (slugPedido !== TENANT_TRAVADO) {
    console.error(
      `\n[fatal] Este script está travado ao tenant "${TENANT_TRAVADO}" — recebeu --tenant=${slugPedido ?? "(nenhum)"}.\n` +
        `O plano em scripts/data/plano-execucao-normalizacao-garantia.json só faz sentido nesse tenant;\n` +
        `correr noutro reatribuiria produtos de Fabricante IDs que lá significam outra coisa (ou não existem).\n`,
    );
    process.exitCode = 1;
    return;
  }

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

  const args = parseArgs(argv);
  const dryRun = !args.apply;

  const plano = carregarPlano(args.planoPath);
  const grupos = combinarGrupos(plano);

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: alvo.url }) });
  try {
    await prisma.$executeRawUnsafe(`set session default_transaction_read_only = ${dryRun ? "on" : "off"}`);

    console.log("═".repeat(78));
    console.log("Normalização de fabricantes — tenant garantia");
    console.log("═".repeat(78));
    console.log(`  ${descreverAlvo(alvo)}`);
    console.log(`  Modo: ${dryRun ? "DRY-RUN" : "APPLY"}`);
    console.log(`  Plano: ${args.planoPath}`);
    console.log(`  source: ${args.source}`);
    console.log(`  Grupos no plano: ${plano.verified_business_changes.length} verified_business_changes + ${plano.orthographic_merges.length} orthographic_merges = ${grupos.length}`);
    console.log(`  do_not_merge: ${plano.do_not_merge.length} entrada(s)`);

    // ── 1. Ler todos os Fabricante referenciados pelo plano, numa query só ──
    const idsReferenciados = new Set<string>();
    for (const g of grupos) {
      idsReferenciados.add(g.canonical_id);
      for (const s of g.source_ids) idsReferenciados.add(s);
    }

    const fabricantesEncontrados = await prisma.fabricante.findMany({
      where: { id: { in: [...idsReferenciados] } },
      select: { id: true, nomeNormalizado: true, estado: true, aliases: { select: { aliasNome: true } } },
    });
    const fabricantesPorId = new Map<string, FabricanteDb>(
      fabricantesEncontrados.map((f) => [
        f.id,
        { id: f.id, nomeNormalizado: f.nomeNormalizado, estado: f.estado, aliases: f.aliases.map((a) => a.aliasNome) },
      ]),
    );

    // ── 2. Produtos de cada fabricante referenciado (só interessam os dos sources, mas pedir todos é uma query só) ──
    const produtos = await prisma.produto.findMany({
      where: { fabricanteId: { in: [...idsReferenciados] } },
      select: { id: true, fabricanteId: true, validadoManualmente: true },
    });
    const produtosPorFabricanteId = new Map<string, ProdutoDoLoser[]>();
    for (const p of produtos) {
      if (!p.fabricanteId) continue;
      const lista = produtosPorFabricanteId.get(p.fabricanteId) ?? [];
      lista.push({ id: p.id, validadoManualmente: p.validadoManualmente });
      produtosPorFabricanteId.set(p.fabricanteId, lista);
    }

    // ── 3. Planear o lote inteiro (puro, sem tocar em nada) ──
    const relatorio = planearNormalizacaoBatch({
      grupos,
      fabricantesPorId,
      produtosPorFabricanteId,
      doNotMerge: plano.do_not_merge,
      incluirValidadosManualmente: args.incluirValidadosManualmente,
    });

    // ── 4. Contagens antes ──
    const [totalFabricantesAtivosAntes, totalFabricantesInativosAntes] = await Promise.all([
      prisma.fabricante.count({ where: { estado: "ATIVO" } }),
      prisma.fabricante.count({ where: { estado: "INATIVO" } }),
    ]);

    // ── 5. Relatório em consola ──
    console.log(`\n${"─".repeat(78)}`);
    console.log("Fabricantes de origem envolvidos (grupos válidos):");
    for (const g of relatorio.grupos) {
      console.log(`  [${g.kind}] → "${g.canonicalNome}" (${g.canonicalId})`);
      for (const s of g.sources) {
        console.log(
          `      ← "${s.nomeNormalizado}" (${s.sourceId})  produtos=${s.plano.produtosAReatribuir.length}` +
            (s.plano.produtosBloqueadosValidadoManualmente.length
              ? ` bloqueados=${s.plano.produtosBloqueadosValidadoManualmente.length}`
              : "") +
            `  aliases_novos=${s.plano.aliasesACriar.length}`,
        );
      }
    }

    if (relatorio.gruposBloqueados.length > 0) {
      console.log(`\n${"─".repeat(78)}`);
      console.log(`Grupos bloqueados (canonical_id inexistente ou já inactivo) — ${relatorio.gruposBloqueados.length}:`);
      for (const b of relatorio.gruposBloqueados) {
        console.log(`  [${b.kind}] grupo #${b.groupIndex} canonical_id=${b.canonicalId} — ${b.motivo}: ${b.detalhe}`);
      }
    }

    if (relatorio.sourcesExcluidos.length > 0) {
      console.log(`\n${"─".repeat(78)}`);
      console.log(`source_ids excluídos (ids inexistentes/inactivos/conflitos) — ${relatorio.sourcesExcluidos.length}:`);
      const porMotivo = new Map<string, number>();
      for (const s of relatorio.sourcesExcluidos) porMotivo.set(s.motivo, (porMotivo.get(s.motivo) ?? 0) + 1);
      for (const [motivo, n] of porMotivo) console.log(`  ${motivo}: ${n}`);
      for (const s of relatorio.sourcesExcluidos) {
        console.log(`    grupo #${s.groupIndex} [${s.kind}] source_id=${s.sourceId} → ${s.motivo} — ${s.detalhe}`);
      }
    }

    console.log(`\n${"─".repeat(78)}`);
    console.log("Totais (grupos válidos, a aplicar com --apply):");
    console.log(`  Grupos:                                    ${relatorio.totais.grupos}`);
    console.log(`  Fabricantes de origem a marcar INATIVO:     ${relatorio.totais.fabricantesOrigemAInativar}`);
    console.log(`  Produtos a reatribuir:                      ${relatorio.totais.produtosAReatribuir}`);
    console.log(`  Produtos bloqueados (validadoManualmente):  ${relatorio.totais.produtosBloqueadosValidadoManualmente}`);
    console.log(`  Aliases a criar no canónico:                 ${relatorio.totais.aliasesACriar}`);

    console.log(`\n${"─".repeat(78)}`);
    console.log("Contagens antes / depois (estimado):");
    console.log(`  Fabricante ATIVO antes:   ${totalFabricantesAtivosAntes}`);
    console.log(`  Fabricante ATIVO depois:  ${totalFabricantesAtivosAntes - relatorio.totais.fabricantesOrigemAInativar}`);
    console.log(`  Fabricante INATIVO antes: ${totalFabricantesInativosAntes}`);
    console.log(`  Fabricante INATIVO depois: ${totalFabricantesInativosAntes + relatorio.totais.fabricantesOrigemAInativar}`);

    // ── 6. Executar (dry-run por omissão) ──
    const resultado = await executarNormalizacaoBatch(prisma, { relatorio, source: args.source, dryRun });

    console.log(`\n${"─".repeat(78)}`);
    console.log(
      `${dryRun ? "[dry-run] Seriam" : "Foram"} reatribuídos ${resultado.produtosReatribuidos} produto(s), ` +
        `criado(s) ${resultado.aliasesCriados} alias(es), inactivado(s) ${resultado.fabricantesInativados} fabricante(s).`,
    );

    // ── 7. Gravar relatório detalhado para auditoria ──
    const relatorioParaDisco = {
      geradoEm: new Date().toISOString(),
      alvo: { base: alvo.base, host: alvo.host, tenant: alvo.tenant },
      modo: dryRun ? "DRY-RUN" : "APPLY",
      planoPath: args.planoPath,
      totais: relatorio.totais,
      contagens: {
        fabricanteAtivoAntes: totalFabricantesAtivosAntes,
        fabricanteAtivoDepoisEstimado: totalFabricantesAtivosAntes - relatorio.totais.fabricantesOrigemAInativar,
        fabricanteInativoAntes: totalFabricantesInativosAntes,
        fabricanteInativoDepoisEstimado: totalFabricantesInativosAntes + relatorio.totais.fabricantesOrigemAInativar,
      },
      grupos: relatorio.grupos.map((g) => ({
        kind: g.kind,
        canonicalId: g.canonicalId,
        canonicalNome: g.canonicalNome,
        sources: g.sources.map((s) => ({
          sourceId: s.sourceId,
          nomeNormalizado: s.nomeNormalizado,
          produtosAReatribuir: s.plano.produtosAReatribuir,
          produtosBloqueadosValidadoManualmente: s.plano.produtosBloqueadosValidadoManualmente,
          aliasesACriar: s.plano.aliasesACriar,
          aliasesJaExistentes: s.plano.aliasesJaExistentes,
        })),
      })),
      gruposBloqueados: relatorio.gruposBloqueados,
      sourcesExcluidos: relatorio.sourcesExcluidos,
    };
    writeFileSync(args.relatorioPath, JSON.stringify(relatorioParaDisco, null, 2), "utf8");
    console.log(`\nRelatório detalhado gravado em: ${args.relatorioPath}`);

    if (dryRun) {
      console.log(`\n⚠  DRY-RUN — nenhuma alteração foi gravada. Reveja o relatório acima e, se estiver correcto, corra com --apply.`);
    } else {
      console.log(`\n✔  Aplicado.`);
    }
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

if (/[\\/]normalizar-fabricantes-garantia\.(ts|js|mjs|cjs)$/.test(process.argv[1] ?? "")) {
  main().catch((err) => {
    console.error("[erro fatal]", err);
    process.exitCode = 1;
  });
}
