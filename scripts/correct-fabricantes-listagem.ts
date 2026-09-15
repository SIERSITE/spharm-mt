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
 * também aceita header e `--map=` manual — ver esse ficheiro).
 *
 * ── Segurança: dry-run é o DEFAULT, aplicar exige --apply ───────────────
 * Ao contrário de `import-regulatory-record.ts` (onde dry-run é opt-in e
 * o default é aplicar), este script INVERTE a polaridade: por omissão
 * NUNCA escreve nada, mesmo sem `--dry-run`. Só escreve com `--apply`
 * explícito. Este modo pode corrigir campos já preenchidos — o risco de
 * correr por engano é maior, por isso o "opt-in para escrever" é mais
 * apertado do que no importador de base.
 *
 * Uso:
 *   # 1. Dry-run — SEMPRE correr primeiro. Lê o ficheiro, simula as duas
 *   #    fases (RegulatoryRecord + Produto.fabricanteId) e imprime o
 *   #    relatório completo. Não escreve nada.
 *   npx tsx scripts/correct-fabricantes-listagem.ts \
 *     --file=caminho/para/listagem.csv \
 *     --source=cedime_anf_2026-09
 *
 *   # 2. Aplicar de facto, depois de validar o relatório do dry-run.
 *   npx tsx scripts/correct-fabricantes-listagem.ts \
 *     --file=caminho/para/listagem.csv \
 *     --source=cedime_anf_2026-09 \
 *     --apply
 *
 *   # 3. Aplicar incluindo correcções same-tier (REGULATORY novo substitui
 *   #    REGULATORY já preenchido) — opt-in explícito, desligado por defeito.
 *   #    Corre sempre primeiro em dry-run (sem --apply) para ver quantas
 *   #    correcções same-tier existem antes de decidir activar a flag.
 *   npx tsx scripts/correct-fabricantes-listagem.ts \
 *     --file=caminho/para/listagem.csv \
 *     --source=cedime_anf_2026-09 \
 *     --apply \
 *     --allow-same-tier-overwrite
 *
 * Opções:
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
 */

import "dotenv/config";
import * as fs from "fs";
import { legacyPrisma as prisma } from "../lib/prisma";
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

type Args = {
  file: string;
  source: string;
  apply: boolean;
  allowSameTierOverwrite: boolean;
  limit: number | null;
  batchSize: number;
  manualMap: Partial<Record<FieldName, number>> | null;
};

function parseArgs(): Args {
  const argv = process.argv.slice(2);
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
    else if (a === "--dry-run") {
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
      console.warn(`[aviso] argumento desconhecido: ${a}`);
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
  const args = parseArgs();
  const dryRun = !args.apply;

  console.log("═".repeat(78));
  console.log("Correcção tier-aware de fabricantes a partir de listagem regulatória");
  console.log("═".repeat(78));
  console.log(`  file:       ${args.file}`);
  console.log(`  source:     ${args.source}`);
  console.log(`  modo:       ${dryRun ? "DRY-RUN (nada é escrito)" : "APLICAR (escreve na BD)"}`);
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
    const c = await upsertBatch(slice, args.source, /* force */ true, dryRun);
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
if (/[\\/]correct-fabricantes-listagem\.(ts|js|mjs|cjs)$/.test(process.argv[1] ?? "")) {
  main()
    .catch((err) => {
      console.error("[erro fatal]", err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
