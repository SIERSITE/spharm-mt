/**
 * scripts/normalizar-fabricantes-garantia.ts
 *
 * Executa, em lote, o plano de normalização de `Fabricante` do tenant
 * garantia. Aceita DOIS formatos de plano, ambos traduzidos para a
 * MESMA representação interna antes de planear (ver
 * `lib/catalog-fabricante-normalizacao-batch.ts`):
 *
 *   · original    `verified_business_changes` + `orthographic_merges`
 *                 (scripts/data/plano-execucao-normalizacao-garantia.json)
 *   · achatado     `groups[]` único, com `canonical_name_before`/`_after`,
 *                 `sources[].products` (contagem esperada) e `do_not_merge`
 *                 como arrays de nomes nus
 *                 (scripts/data/plano-normalizacao-garantia-achatado-checkpoint.json
 *                 — o ponto de partida ACTUAL; 555 grupos, 28 com
 *                 renomeação do canónico)
 *
 * Este ficheiro NÃO investiga nem reclassifica fabricante nenhum: só
 * verifica que os IDs do plano existem mesmo nesta base, respeita
 * `do_not_merge`, e aplica mecanicamente o que já está decidido.
 *
 * ── Segurança: travado ao tenant garantia ────────────────────────────
 * `--tenant=garantia` é o ÚNICO valor aceite — este script recusa-se a
 * correr contra qualquer outro tenant, mesmo que --tenant= aponte para
 * outro. Além disso, o `tenant` do próprio ficheiro do plano tem de ser
 * "garantia" — outra camada da mesma trava.
 *
 * ── Segurança: dry-run é o DEFAULT ───────────────────────────────────
 * Nunca escreve nada sem --apply explícito.
 *
 * ── Segurança: plano com `status` não-aprovado bloqueia --apply ──────
 * Se o plano trouxer `status` (só o achatado traz) e não for
 * exactamente `"APPROVED"` — ex.: `RESEARCH_CHECKPOINT_DO_NOT_APPLY` —
 * `--apply` é recusado ANTES de sequer ligar à base. O dry-run continua
 * a correr sempre, para se poder rever o plano.
 *
 * ── Segurança: tudo numa transacção, e recusa parcial em --apply ─────
 * `executarNormalizacaoBatch` (lib) aplica os grupos dentro de UMA
 * transacção interactiva — ou fica tudo aplicado, ou nada. E recusa-se
 * a sequer abrir essa transacção se houver QUALQUER grupo bloqueado,
 * source excluído ou renomeação bloqueada no relatório: um `--apply`
 * nunca aplica só os itens limpos e ignora os outros em silêncio.
 *
 * ── canonical_name (opcional) ─────────────────────────────────────────
 * Um grupo do plano pode trazer a denominação que o PRÓPRIO canónico
 * deve passar a ter. Só dispara escrita quando difere do
 * `nomeNormalizado` já na base — e, quando dispara, a denominação
 * ANTERIOR é preservada como `FabricanteAlias` antes de renomear, na
 * MESMA transacção dos merges desse grupo.
 *
 * ── Divergências (só no formato achatado) ─────────────────────────────
 * O plano achatado declara, por source, quantos produtos ESPERA
 * reatribuir, e no bloco `summary` os totais agregados. Este script
 * compara isso contra a base REAL (`compararDivergencias`, lib) e
 * imprime o que não bate — o plano é investigação
 * (`RESEARCH_CHECKPOINT_DO_NOT_APPLY`), e uma contagem desactualizada é
 * sinal de que os dados mudaram desde que foi escrito.
 *
 * Uso:
 *   # 1. Dry-run — SEMPRE primeiro. Imprime o relatório completo e
 *   #    grava uma cópia em JSON para auditoria. Não escreve nada.
 *   npx tsx scripts/normalizar-fabricantes-garantia.ts \
 *     --tenant=garantia \
 *     --source=normalizacao-fabricantes-garantia-2026-09
 *
 *   # 2. Aplicar, só depois de: (a) validar o dry-run, (b) o plano ter
 *   #    status="APPROVED" (ou não ter `status` nenhum).
 *   npx tsx scripts/normalizar-fabricantes-garantia.ts \
 *     --tenant=garantia \
 *     --source=normalizacao-fabricantes-garantia-2026-09 \
 *     --apply
 *
 * Opções:
 *   --tenant=garantia     Obrigatório, e tem de ser exactamente "garantia".
 *   --plano=<path>        Opcional. Default: o checkpoint achatado
 *                         (scripts/data/plano-normalizacao-garantia-achatado-checkpoint.json).
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
  combinarGruposAchatado,
  compararDivergencias,
  ehPlanoAchatado,
  executarNormalizacaoBatch,
  normalizarDoNotMerge,
  planearNormalizacaoBatch,
  type DoNotMergeEntry,
  type FabricanteDb,
  type GrupoNormalizacao,
  type PlanoNormalizacaoArquivo,
  type PlanoNormalizacaoArquivoAchatado,
  type RelatorioDivergencias,
} from "../lib/catalog-fabricante-normalizacao-batch";

const TENANT_TRAVADO = "garantia";
const PLANO_DEFAULT = resolve(__dirname, "data", "plano-normalizacao-garantia-achatado-checkpoint.json");
const RELATORIO_DEFAULT = resolve(__dirname, "data", "relatorio-normalizacao-garantia.json");
const APPLY_STATUS_PERMITIDO = "APPROVED";

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

type PlanoCarregado = {
  achatado: boolean;
  /** Só presente no formato achatado — usado para o relatório de divergências. */
  achatadoRaw?: PlanoNormalizacaoArquivoAchatado;
  status?: string;
  warnings?: string[];
  grupos: GrupoNormalizacao[];
  doNotMerge: DoNotMergeEntry[];
  totalGruposNoPlano: number;
  descricaoFormato: string;
};

function carregarPlano(path: string): PlanoCarregado {
  const bruto = readFileSync(path, "utf8");
  const json = JSON.parse(bruto) as PlanoNormalizacaoArquivo | PlanoNormalizacaoArquivoAchatado;

  if (json.tenant !== TENANT_TRAVADO) {
    throw new Error(
      `O plano em ${path} diz respeito ao tenant "${json.tenant}", não "${TENANT_TRAVADO}". ` +
        `Este script está travado ao tenant garantia — recusado.`,
    );
  }

  if (ehPlanoAchatado(json)) {
    return {
      achatado: true,
      achatadoRaw: json,
      status: json.status,
      warnings: json.warnings,
      grupos: combinarGruposAchatado(json),
      doNotMerge: normalizarDoNotMerge(json.do_not_merge),
      totalGruposNoPlano: json.groups.length,
      descricaoFormato: `achatado — groups[] (${json.groups.length} grupos)`,
    };
  }

  const grupos = combinarGrupos(json);
  return {
    achatado: false,
    grupos,
    doNotMerge: normalizarDoNotMerge(json.do_not_merge),
    totalGruposNoPlano: grupos.length,
    descricaoFormato: `original — ${json.verified_business_changes.length} verified_business_changes + ${json.orthographic_merges.length} orthographic_merges`,
  };
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

  const args = parseArgs(argv);
  const dryRun = !args.apply;

  const plano = carregarPlano(args.planoPath);

  // ── Status do plano bloqueia --apply, ANTES de qualquer ligação à base ──
  // Um plano achatado sem status="APPROVED" (ex.: RESEARCH_CHECKPOINT_DO_NOT_APPLY,
  // o valor actual) nunca aplica — só o dry-run corre. Falha aqui, sem tocar
  // em rede nenhuma, é mais seguro do que falhar depois de já ter ligado à VPS.
  if (args.apply && plano.status && plano.status !== APPLY_STATUS_PERMITIDO) {
    console.error(
      `\n[fatal] O plano em ${args.planoPath} declara status="${plano.status}" — não é "${APPLY_STATUS_PERMITIDO}".\n` +
        `--apply recusado. Corre sem --apply (dry-run) para rever o plano; só aplicar depois de uma aprovação\n` +
        `humana explícita que actualize este status no ficheiro.\n`,
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

  const grupos = plano.grupos;

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: alvo.url }) });
  try {
    await prisma.$executeRawUnsafe(`set session default_transaction_read_only = ${dryRun ? "on" : "off"}`);

    console.log("═".repeat(78));
    console.log("Normalização de fabricantes — tenant garantia");
    console.log("═".repeat(78));
    console.log(`  ${descreverAlvo(alvo)}`);
    console.log(`  Modo: ${dryRun ? "DRY-RUN" : "APPLY"}`);
    console.log(`  Plano: ${args.planoPath}`);
    console.log(`  Formato: ${plano.descricaoFormato}`);
    console.log(`  source: ${args.source}`);
    console.log(`  Grupos no plano: ${plano.totalGruposNoPlano}`);
    console.log(`  do_not_merge: ${plano.doNotMerge.length} entrada(s)`);
    if (plano.status) console.log(`  Estado do plano: ${plano.status}`);
    if (plano.warnings?.length) {
      console.log(`  Avisos do plano:`);
      for (const w of plano.warnings) console.log(`    - ${w}`);
    }
    console.log(
      `  Âmbito: normalização de fabricantes do tenant garantia — ${plano.totalGruposNoPlano} grupos deste plano. ` +
        `Fabricantes fora deste plano permanecem ATIVOS e não são tocados nem revistos aqui.`,
    );

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
      doNotMerge: plano.doNotMerge,
      incluirValidadosManualmente: args.incluirValidadosManualmente,
    });

    // ── 4. Contagens antes ──
    const [totalFabricantesAtivosAntes, totalFabricantesInativosAntes] = await Promise.all([
      prisma.fabricante.count({ where: { estado: "ATIVO" } }),
      prisma.fabricante.count({ where: { estado: "INATIVO" } }),
    ]);

    // ── 4b. Divergências: o que o plano achatado DECLAROU vs a base REAL ──
    let divergencias: RelatorioDivergencias | undefined;
    if (plano.achatado && plano.achatadoRaw) {
      divergencias = compararDivergencias({
        planoAchatado: plano.achatadoRaw,
        relatorio,
        produtosPorFabricanteId,
        totalFabricantesAtivosAntes,
      });
    }

    // ── 5. Relatório em consola ──
    console.log(`\n${"─".repeat(78)}`);
    console.log("Fabricantes de origem envolvidos (grupos válidos):");
    for (const g of relatorio.grupos) {
      console.log(`  [${g.kind}] → "${g.canonicalNome}" (${g.canonicalId})`);
      if (g.renomeacao) {
        console.log(`      ✎ RENOMEAÇÃO DO CANÓNICO`);
        console.log(`        canonicalNameBefore: "${g.renomeacao.nomeAntes}"`);
        console.log(`        canonicalNameAfter:  "${g.renomeacao.nomeDepois}"`);
        console.log(
          g.renomeacao.aliasACriar
            ? `        alias criado com a denominação anterior: "${g.renomeacao.aliasACriar}"`
            : `        denominação anterior já existia como alias — nada a criar`,
        );
      }
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

    if (relatorio.renomeacoesBloqueadas.length > 0) {
      console.log(`\n${"─".repeat(78)}`);
      console.log(`Renomeações bloqueadas (colisão de nomeNormalizado) — ${relatorio.renomeacoesBloqueadas.length}:`);
      for (const r of relatorio.renomeacoesBloqueadas) {
        console.log(
          `  [${r.kind}] grupo #${r.groupIndex} canonical_id=${r.canonicalId} — ` +
            `"${r.nomeAtual}" → "${r.nomeSolicitado}" recusado: ${r.detalhe}`,
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
    console.log(`  Aliases a criar no canónico (por merge):    ${relatorio.totais.aliasesACriar}`);
    console.log(`  Canónicos a renomear:                       ${relatorio.totais.canonicaisRenomeados}`);
    console.log(`  Aliases a criar por renomeação:              ${relatorio.totais.aliasesCriadosPorRenomeacao}`);

    console.log(`\n${"─".repeat(78)}`);
    console.log("Contagens antes / depois (estimado):");
    console.log(`  Fabricante ATIVO antes:   ${totalFabricantesAtivosAntes}`);
    console.log(`  Fabricante ATIVO depois:  ${totalFabricantesAtivosAntes - relatorio.totais.fabricantesOrigemAInativar}`);
    console.log(`  Fabricante INATIVO antes: ${totalFabricantesInativosAntes}`);
    console.log(`  Fabricante INATIVO depois: ${totalFabricantesInativosAntes + relatorio.totais.fabricantesOrigemAInativar}`);

    // ── 5b. Divergências: plano DECLAROU vs base REAL diz agora ──
    if (divergencias) {
      console.log(`\n${"─".repeat(78)}`);
      const piores = divergencias.resumo.filter((r) => !r.bate);
      console.log(`Divergências vs o plano (summary declarado): ${piores.length ? piores.length + " campo(s) não batem" : "nenhuma — tudo bate certo"}`);
      for (const r of divergencias.resumo) {
        console.log(`  ${r.bate ? "✓" : "✗"} ${r.campo}: declarado=${r.esperado}  real=${r.real}`);
      }
      if (divergencias.produtos.length > 0) {
        console.log(`\n  Divergências de produtos por source — ${divergencias.produtos.length}:`);
        for (const d of divergencias.produtos) {
          console.log(
            `    grupo #${d.groupIndex} source_id=${d.sourceId}${d.sourceNome ? ` ("${d.sourceNome}")` : ""} — ` +
              `declarado=${d.produtosEsperados} real=${d.produtosReais}`,
          );
        }
      } else {
        console.log(`  Nenhuma divergência de produtos por source.`);
      }
    }

    // ── 6. Executar (dry-run por omissão) ──
    let resultado: Awaited<ReturnType<typeof executarNormalizacaoBatch>> | undefined;
    let applyRecusado: string | undefined;
    try {
      resultado = await executarNormalizacaoBatch(prisma, { relatorio, source: args.source, dryRun });
    } catch (err) {
      if (!dryRun && err instanceof Error) {
        // Abort estrutural de executarNormalizacaoBatch (conflitos por resolver) — não é um
        // erro de infra-estrutura, é a trava a funcionar. Reporta e sai sem propagar como fatal.
        applyRecusado = err.message;
      } else {
        throw err;
      }
    }

    if (applyRecusado) {
      console.log(`\n${"─".repeat(78)}`);
      console.log(`✗ ${applyRecusado}`);
    } else if (resultado) {
      console.log(`\n${"─".repeat(78)}`);
      console.log(
        `${dryRun ? "[dry-run] Seriam" : "Foram"} reatribuídos ${resultado.produtosReatribuidos} produto(s), ` +
          `criado(s) ${resultado.aliasesCriados} alias(es), inactivado(s) ${resultado.fabricantesInativados} fabricante(s), ` +
          `renomeado(s) ${resultado.canonicaisRenomeados} canónico(s).`,
      );
    }

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
        ...(g.renomeacao
          ? {
              renomeacao: {
                canonicalNameBefore: g.renomeacao.nomeAntes,
                canonicalNameAfter: g.renomeacao.nomeDepois,
                aliasCriado: g.renomeacao.aliasACriar,
                aliasJaExistente: g.renomeacao.aliasJaExistente,
              },
            }
          : {}),
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
      renomeacoesBloqueadas: relatorio.renomeacoesBloqueadas,
      ...(divergencias ? { divergencias } : {}),
      ...(applyRecusado ? { applyRecusado } : {}),
    };
    writeFileSync(args.relatorioPath, JSON.stringify(relatorioParaDisco, null, 2), "utf8");
    console.log(`\nRelatório detalhado gravado em: ${args.relatorioPath}`);

    if (applyRecusado) {
      console.log(`\n✗  --apply RECUSADO — nada foi escrito. Ver motivo acima.`);
      process.exitCode = 1;
    } else if (dryRun) {
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
