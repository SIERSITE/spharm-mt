/**
 * scripts/correct-fabricantes-listagem.ts
 *
 * Bloco F — corrigir fabricantes já preenchidos (não só vazios) a partir
 * de uma listagem regulatória actualizada, sem nunca substituir uma fonte
 * superior por uma inferior.
 *
 * NÃO é um segundo importador: reaproveita a leitura/parsing/detecção de
 * mapping e o upsert de `RegulatoryRecord` de
 * `scripts/import-regulatory-record.ts` (fase 1), e a decisão tier-aware +
 * escrita de `Produto.fabricanteId` de `lib/catalog-persistence.ts`
 * (fase 2, `applyAuthoritativeManufacturerCorrections`). Este ficheiro só
 * junta as duas fases num único relatório de ponta a ponta.
 *
 * ── Porque um script consolidado, e não dois passos separados ──────────
 * Um único comando com um único relatório agregado é mais simples de
 * operar (o utilizador não tem de cruzar manualmente dois outputs) e mais
 * simples de testar (um `applyAuthoritativeManufacturerCorrections` já
 * cobre a fase 2 isoladamente; este script cobre a orquestração ponta a
 * ponta com um Prisma falso). As duas fases continuam INTERNAMENTE
 * distintas — nenhuma lógica de resolução foi duplicada, só reaproveitada.
 *
 * ── Formato do ficheiro ─────────────────────────────────────────────────
 * Igual ao de `import-regulatory-record.ts`: CSV/XLSX, posicional
 * `cnp;estadoAim;designacaoOficial;titularAim` sem header (auto-detect
 * também aceita header e `--map=` manual — ver esse ficheiro). Um ficheiro
 * de 2 colunas com header `CNP` / `Fabricante` é detectado sozinho — os
 * aliases de `titularAim` incluem literalmente "fabricante".
 *
 * ── Segurança: dry-run é o DEFAULT, aplicar exige --apply ───────────────
 * Ao contrário de `import-regulatory-record.ts` (onde dry-run é opt-in e
 * o default é aplicar), este script INVERTE a polaridade: por omissão
 * NUNCA escreve nada, mesmo sem `--dry-run`. Só escreve com `--apply`
 * explícito. Este modo pode corrigir campos já preenchidos — o risco de
 * correr por engano é maior, por isso o "opt-in para escrever" é mais
 * apertado do que no importador de base.
 *
 * ── Segurança: destino é resolvido pelo tenant, nunca por DATABASE_URL ──
 * `--tenant=<slug>` é OBRIGATÓRIO. O destino nunca vem de
 * `process.env.DATABASE_URL` nem de um valor por omissão — vem sempre do
 * control plane, via `resolverAlvo`/`getTenantBySlug`/
 * `buildTenantConnectionString` (`lib/catalog/target-db.ts`), o MESMO
 * mecanismo já usado por `scripts/catalog/alinhar-classificacao-tenant.ts`
 * e pelos scripts de `catalog-master/`. Não há um segundo caminho de
 * resolução de tenant inventado aqui.
 *
 * Um tenant inexistente é recusado (`AlvoRecusado`) ANTES de qualquer
 * ligação à base do tenant ser tentada — só a base do control plane é
 * consultada para a busca por slug. O tenant/base/host resolvidos são
 * impressos antes de o ficheiro ser processado (nunca a password). Em
 * dry-run a sessão Postgres fica `default_transaction_read_only = on` —
 * a mesma tranca do lado do servidor que os outros scripts de
 * `catalog-master/` já usam, não uma invenção nova.
 *
 * Uso:
 *   # 1. Dry-run — SEMPRE correr primeiro. Lê o ficheiro, simula as duas
 *   #    fases (RegulatoryRecord + Produto.fabricanteId) e imprime o
 *   #    relatório completo. Não escreve nada.
 *   npx tsx scripts/correct-fabricantes-listagem.ts \
 *     --tenant=<slug> \
 *     --file=caminho/para/listagem.csv \
 *     --source=cedime_anf_2026-09
 *
 *   # 2. Aplicar de facto, depois de validar o relatório do dry-run.
 *   npx tsx scripts/correct-fabricantes-listagem.ts \
 *     --tenant=<slug> \
 *     --file=caminho/para/listagem.csv \
 *     --source=cedime_anf_2026-09 \
 *     --apply
 *
 *   # 3. Aplicar incluindo correcções same-tier (REGULATORY novo substitui
 *   #    REGULATORY já preenchido) — opt-in explícito, desligado por defeito.
 *   #    Corre sempre primeiro em dry-run (sem --apply) para ver quantas
 *   #    correcções same-tier existem antes de decidir activar a flag.
 *   npx tsx scripts/correct-fabricantes-listagem.ts \
 *     --tenant=<slug> \
 *     --file=caminho/para/listagem.csv \
 *     --source=cedime_anf_2026-09 \
 *     --apply \
 *     --allow-same-tier-overwrite
 *
 * Opções:
 *   --tenant=<slug>      Obrigatório. Resolvido contra o control plane —
 *                        ver lib/catalog/target-db.ts. Sem valor por
 *                        omissão e sem fallback para DATABASE_URL.
 *   --file=<path>       Obrigatório. CSV/XLSX no formato do importador base.
 *   --source=<tag>       Obrigatório. Tag de proveniência gravada em
 *                        RegulatoryRecord.source e EnrichmentSourceLog.source.
 *   --apply              Escreve de facto (RegulatoryRecord + Produto).
 *                        Omitido → dry-run (default, seguro).
 *   --allow-same-tier-overwrite
 *                        Opt-in explícito, desligado por omissão. Sem esta
 *                        flag, um fabricante REGULATORY já preenchido nunca
 *                        é substituído por um fabricante REGULATORY novo da
 *                        listagem ("empate bloqueia" — anti-oscilação). Com
 *                        a flag, essa substituição passa a ser permitida.
 *                        Nunca afecta o caso tier inferior→superior (esse
 *                        continua sempre bloqueado) nem `validadoManualmente`
 *                        (esse continua sempre a proteger o produto).
 *   --limit=N             Como em import-regulatory-record.ts.
 *   --batch-size=N        Tamanho de lote do upsert de RegulatoryRecord (default 500).
 *   --map=campo:col,...  Override manual de mapping (ver import-regulatory-record.ts).
 *   --permitir-externo   Necessário se o tenant resolvido não for a VPS de
 *                        produção (ex.: Neon/Vercel) — ver target-db.ts.
 *
 * Qualquer outra flag não reconhecida é um erro fatal (não um aviso): um
 * `--tenant=silveira` mal-escrito como `--tenatn=silveira` tem de parar o
 * script, não correr silenciosamente contra um destino errado.
 */

import "dotenv/config";
import * as fs from "fs";
import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { buildTenantConnectionString, getTenantBySlug } from "../lib/control-plane";
import { AlvoRecusado, descreverAlvo, resolverAlvo, type AlvoDb } from "../lib/catalog/target-db";
import {
  applyAuthoritativeManufacturerCorrections,
  type ManufacturerListingRow,
} from "../lib/catalog-persistence";
import {
  DEFAULT_4COL_MAPPING,
  FIELDS,
  MIN_CNP,
  parseRows,
  readRows,
  resolveMapping,
  upsertBatch,
  type FieldName,
  type ParsedRow,
} from "./import-regulatory-record";

// ─── CLI args ───────────────────────────────────────────────────────────────
//
// `--tenant=` e `--permitir-externo` são reconhecidos aqui só para NÃO
// caírem no ramo "argumento desconhecido" — quem os consome de facto é
// `resolverAlvo` em `main()`, antes desta função ser chamada. Duplicar a
// leitura do slug aqui traria dois sítios a poder discordar sobre o
// destino; nenhuma lógica de tenant vive nesta função.

type Args = {
  file: string;
  source: string;
  apply: boolean;
  allowSameTierOverwrite: boolean;
  limit: number | null;
  batchSize: number;
  manualMap: Partial<Record<FieldName, number>> | null;
};

export function parseArgs(argv: readonly string[]): Args {
  const out: Partial<Args> = {
    apply: false,
    allowSameTierOverwrite: false,
    limit: null,
    batchSize: 500,
    manualMap: null,
  };
  for (const a of argv) {
    if (a.startsWith("--file=")) out.file = a.slice("--file=".length);
    else if (a.startsWith("--source=")) out.source = a.slice("--source=".length);
    else if (a === "--apply") out.apply = true;
    else if (a === "--allow-same-tier-overwrite") out.allowSameTierOverwrite = true;
    else if (a.startsWith("--tenant=") || a === "--permitir-externo") {
      // Consumido por resolverAlvo (ver main()). Nada a fazer aqui.
    } else if (a === "--dry-run") {
      // Aceite por compatibilidade/clareza — é o comportamento default de
      // qualquer forma. Nunca inverte para "aplicar".
    } else if (a.startsWith("--limit=")) {
      const n = parseInt(a.split("=")[1], 10);
      if (!isNaN(n) && n > 0) out.limit = n;
    } else if (a.startsWith("--batch-size=")) {
      const n = parseInt(a.split("=")[1], 10);
      if (!isNaN(n) && n > 0 && n <= 1000) out.batchSize = n;
    } else if (a.startsWith("--map=")) {
      const map: Partial<Record<FieldName, number>> = {};
      for (const part of a.slice("--map=".length).split(",")) {
        const [field, col] = part.split(":");
        const colNum = parseInt(col, 10);
        if ((FIELDS as readonly string[]).includes(field) && !isNaN(colNum)) {
          map[field as FieldName] = colNum;
        } else {
          console.warn(`[aviso] map inválido: ${part}`);
        }
      }
      out.manualMap = map;
    } else {
      // Fatal, não aviso — um argumento mal-escrito (ex.: --tenatn=x) não
      // pode deixar o script continuar a correr contra um destino que
      // ninguém pediu.
      throw new Error(`argumento desconhecido: ${a}`);
    }
  }
  if (!out.file) throw new Error("--file=<path> é obrigatório");
  if (!out.source) throw new Error("--source=<tag> é obrigatório");
  return out as Args;
}

// ─── Deduplicação por CNP ─────────────────────────────────────────────────
//
// O importador base (`upsertBatch`) tolera CNPs repetidos no ficheiro (a
// última linha processada vence no valor final gravado), mas não reporta
// duplicados como categoria própria. Para o relatório desta ferramenta —
// que promete explicitamente contar "duplicados" — colapsamos aqui: a
// ÚLTIMA ocorrência de cada CNP no ficheiro vence (mesma regra implícita
// do importador base), as anteriores contam como duplicados.

export function dedupeByLastCnp(rows: ParsedRow[]): { deduped: ParsedRow[]; duplicateCount: number } {
  const byCnp = new Map<number, ParsedRow>();
  for (const row of rows) byCnp.set(row.cnp, row);
  return { deduped: [...byCnp.values()], duplicateCount: rows.length - byCnp.size };
}

// ─── Main ───────────────────────────────────────────────────────────────────

function fmtPct(n: number, d: number): string {
  return d === 0 ? "—" : `${((n / d) * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // ── Destino: resolvido pelo tenant, nunca por DATABASE_URL ──────────────
  //
  // Isto corre ANTES de qualquer parsing de --file/--source e antes de
  // qualquer ligação à base do tenant ser tentada — um tenant que não
  // existe no control plane pára aqui, sem nunca chegar a
  // `buildTenantConnectionString`/`new PrismaClient`.
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

  // Defesa em profundidade: `resolverAlvo` já garante isto por construção
  // (`alvo.tenant` vem do MESMO `--tenant=` que foi parseado), mas o
  // requisito pede uma garantia explícita e testável, não só confiança na
  // implementação de `resolverAlvo`.
  const tenantPedido = argv.find((a) => a.startsWith("--tenant="))?.slice("--tenant=".length).trim();
  if (alvo.tenant !== tenantPedido) {
    throw new Error(
      `invariante violada: tenant resolvido ("${alvo.tenant}") difere do tenant pedido ("${tenantPedido}")`,
    );
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: alvo.url }) });

  try {
    // Em dry-run a sessão fica read-only do lado do Postgres — a mesma
    // tranca que os scripts de catalog-master já usam. Fora do dry-run,
    // limpa-se o estado herdado (ligações -pooler do Neon reutilizam
    // sessão entre clientes).
    await prisma.$executeRawUnsafe(
      `set session default_transaction_read_only = ${dryRun ? "on" : "off"}`,
    );

    console.log("═".repeat(78));
    console.log("Correcção tier-aware de fabricantes a partir de listagem regulatória");
    console.log("═".repeat(78));
    console.log(`  Tenant:   ${alvo.tenant}`);
    console.log(`  Database: ${alvo.base}`);
    console.log(`  Host:     ${alvo.host}`);
    console.log(`  Modo:     ${dryRun ? "DRY-RUN" : "APPLY"}`);
    // Formato longo, igual ao resto dos scripts que resolvem por tenant.
    console.log(`  ${descreverAlvo(alvo)}`);
    console.log(`  file:       ${args.file}`);
    console.log(`  source:     ${args.source}`);
    console.log(
      `  allow-same-tier-overwrite: ${args.allowSameTierOverwrite ? "ON (empate REGULATORY↔REGULATORY permitido)" : "OFF (default — empate bloqueia)"}`,
    );
    if (args.limit) console.log(`  limit:      ${args.limit}`);
    console.log(`  batchSize:  ${args.batchSize}`);
    if (args.manualMap) console.log(`  manualMap:  ${JSON.stringify(args.manualMap)}`);

    if (!fs.existsSync(args.file)) {
      console.error(`[fatal] ficheiro não encontrado: ${args.file}`);
      process.exitCode = 1;
      return;
    }

    await runCorrecao(prisma, args, dryRun);
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

async function runCorrecao(
  prisma: PrismaClient,
  args: Args,
  dryRun: boolean,
): Promise<void> {
  // ── Leitura + parsing (reaproveita import-regulatory-record.ts) ─────────
  console.log(`\n[1/4] A ler e a parsear o ficheiro...`);
  const rows = readRows(args.file);
  console.log(`  ${rows.length} linha(s) lidas`);

  const { mapping, hasHeader } = resolveMapping(rows, args.manualMap);
  console.log(
    args.manualMap
      ? `  mapping: manual override ${JSON.stringify(mapping)}`
      : hasHeader
        ? `  mapping: detectado por header → ${JSON.stringify(mapping)}`
        : `  mapping: sem header → 4-col positional default ${JSON.stringify(DEFAULT_4COL_MAPPING)}`,
  );

  if (mapping.cnp === undefined) {
    console.error(`[fatal] coluna 'cnp' não mapeada. Use --map=cnp:<col>,... para forçar.`);
    process.exitCode = 1;
    return;
  }
  if (mapping.titularAim === undefined) {
    console.error(
      `[fatal] coluna 'titularAim' (fabricante) não mapeada — nada a corrigir. ` +
        `Use --map=cnp:0,titularAim:3,... para forçar.`,
    );
    process.exitCode = 1;
    return;
  }

  const stats = parseRows(rows, mapping, hasHeader, args.limit);
  const { deduped, duplicateCount } = dedupeByLastCnp(stats.parsed);
  const linhasInvalidas = stats.skippedNoCnp + stats.skippedBelowMin + stats.skippedNoFields;

  console.log(`  linhas úteis parseadas: ${stats.parsed.length}`);
  console.log(`  CNP duplicados no ficheiro (última ocorrência vence): ${duplicateCount}`);
  console.log(
    `  linhas inválidas: ${linhasInvalidas} ` +
      `(cnp inválido=${stats.skippedNoCnp}, cnp≤${MIN_CNP}=${stats.skippedBelowMin}, sem campos úteis=${stats.skippedNoFields})`,
  );

  if (deduped.length === 0) {
    console.warn("\nNada para processar depois do parsing/deduplicação.");
    return;
  }

  // ── Fase 1: RegulatoryRecord (força correcção de campos já preenchidos) ──
  console.log(
    `\n[2/4] Fase 1/2 — RegulatoryRecord (força correcção de campos já preenchidos; ${dryRun ? "simulado" : "aplicado"})...`,
  );
  const regTotals = { inserted: 0, updatedSomeFields: 0, unchanged: 0, failed: 0 };
  for (let i = 0; i < deduped.length; i += args.batchSize) {
    const slice = deduped.slice(i, i + args.batchSize);
    // prisma explícito: sem isto, a fase 1 escreveria sempre em
    // DATABASE_URL, ignorando o tenant resolvido para a fase 2.
    const c = await upsertBatch(slice, args.source, /* force */ true, dryRun, prisma);
    regTotals.inserted += c.inserted;
    regTotals.updatedSomeFields += c.updatedSomeFields;
    regTotals.unchanged += c.unchanged;
    regTotals.failed += c.failed;
  }
  console.log(
    `  RegulatoryRecord — inseridos=${regTotals.inserted} actualizados=${regTotals.updatedSomeFields} ` +
      `inalterados=${regTotals.unchanged} falhas=${regTotals.failed}`,
  );

  // ── Fase 2: Produto.fabricanteId (tier-aware, opt-in) ────────────────────
  console.log(`\n[3/4] Fase 2/2 — Produto.fabricanteId (correcção tier-aware; ${dryRun ? "simulado" : "aplicado"})...`);
  const listingRows: ManufacturerListingRow[] = deduped.map((r) => ({
    cnp: r.cnp,
    titularAim: r.titularAim ?? null,
  }));
  const report = await applyAuthoritativeManufacturerCorrections(prisma, listingRows, {
    source: args.source,
    dryRun,
    allowSameTierOverwrite: args.allowSameTierOverwrite,
  });

  // ── Relatório agregado ────────────────────────────────────────────────
  console.log(`\n[4/4] Relatório${dryRun ? " (DRY-RUN — nada foi escrito)" : ""}:`);
  console.log("─".repeat(78));
  console.log(`  Linhas lidas do ficheiro:            ${rows.length}`);
  console.log(`  Linhas inválidas/malformadas:        ${linhasInvalidas}`);
  console.log(`  CNP duplicados no ficheiro:          ${duplicateCount}`);
  console.log(`  Linhas úteis processadas:            ${report.linhasProcessadas}`);
  console.log(
    `  Produtos encontrados por CNP:        ${report.produtosEncontrados} ` +
      `(${fmtPct(report.produtosEncontrados, report.linhasProcessadas)})`,
  );
  console.log(`  CNP não encontrados:                 ${report.cnpNaoEncontrado}`);
  console.log(`  Fabricante vazio na listagem:         ${report.fabricanteVazio}`);
  console.log(`  Sem alteração (valor já correcto):    ${report.semAlteracao}`);
  console.log(`  Fabricantes a actualizar/corrigir:    ${report.atualizados}`);
  if (args.allowSameTierOverwrite) {
    console.log(
      `  Same-tier ${dryRun ? "seriam actualizados" : "actualizados"} (--allow-same-tier-overwrite activo): ${report.mesmoTierAtualizado}`,
    );
  } else {
    console.log(
      `  ${report.mesmoTierBloqueado} produto(s) têm correcção same-tier disponível mas bloqueada ` +
        `(usa --allow-same-tier-overwrite para os incluir)`,
    );
  }
  console.log(`  Conflitos (bloqueados):               ${report.conflitos}`);
  console.log("─".repeat(78));

  if (report.conflitos > 0) {
    console.log(`\n  Detalhe dos conflitos (primeiros 20):`);
    for (const d of report.detalhes.filter((d) => d.categoria.startsWith("bloqueado")).slice(0, 20)) {
      console.log(
        `    cnp=${d.cnp} [${d.categoria}] actual="${d.valorAtual ?? "—"}" novo="${d.valorNovo ?? "—"}" — ${d.detalhe}`,
      );
    }
  }

  if (dryRun) {
    console.log(
      `\n⚠  DRY-RUN — nenhuma alteração foi gravada. Reveja o relatório acima e, ` +
        `se estiver correcto, corra novamente com --apply.`,
    );
  } else {
    console.log(`\n✔  Aplicado. ${report.atualizados} fabricante(s) corrigido(s)/preenchido(s).`);
  }
}

// Guarda de entry-point: este módulo é importado por
// `scripts/tests/test-fabricante-correcao-tier-aware.ts` para reaproveitar
// `dedupeByLastCnp` sem duplicar a lógica. Sem esta guarda, `main()`
// corria também quando importado (mesmo padrão de `import-regulatory-record.ts`
// e de `scripts/vendas/reconciliar-dia.ts`).
//
// O disconnect do Prisma do tenant já acontece dentro de `main()` (o
// cliente só existe depois de o tenant ser resolvido — não há um
// singleton module-level para desligar aqui).
if (/[\\/]correct-fabricantes-listagem\.(ts|js|mjs|cjs)$/.test(process.argv[1] ?? "")) {
  main().catch((err) => {
    console.error("[erro fatal]", err);
    process.exitCode = 1;
  });
}
