/**
 * scripts/catalog-master/export-catalog.ts
 *
 * Exporta o CATÁLOGO MESTRE de uma base explícita para um bundle em
 * disco (NDJSON + manifest + checksums). Não exporta nada operacional.
 *
 * Origem SEMPRE explícita — `DATABASE_URL` nunca é usada por omissão:
 *   --source-tenant <slug>      resolve pelo control plane
 *   --source-url-env <ENV>      lê a connection string dessa env
 *
 * Uso:
 *   # dry-run (default): conta e mostra, não escreve nada
 *   npm run catalog:export -- --source-tenant grupo-silveira
 *
 *   # escrever o bundle
 *   npm run catalog:export -- --source-tenant grupo-silveira \
 *       --out exports/catalogo-mestre-2026-08-04 --apply
 *
 *   # a partir da base legacy, incluindo histórico de verificações
 *   npm run catalog:export -- --source-url-env DATABASE_URL \
 *       --out exports/legacy --include-history --apply
 *
 * Opções:
 *   --filter enriched|all   (default: enriched) produtos que carregam
 *                           valor de catálogo vs todos
 *   --regulatory all|referenced|none  (default: all)
 *   --include-history       inclui ProdutoVerificacaoHistorico
 *   --include-tipodoc       inclui TipoDocumentoClassificacao
 *   --limit <n>             corta cada tabela (só para ensaios)
 *   --apply                 escreve mesmo (sem isto é dry-run)
 */

import { parseArgs } from "node:util";
import path from "node:path";
import { writeFileSync } from "node:fs";
import type { PrismaClient } from "@/generated/prisma/client";
import {
  CatalogToolError,
  MANIFEST_VERSION,
  NdjsonWriter,
  TABLE_SPECS,
  TOOL_VERSION,
  EXCLUDED_TABLES,
  PRODUTO_TENANT_FIELDS,
  carriesCatalogValue,
  chunk,
  closeControl,
  ensureDir,
  fmt,
  openClient,
  readSchemaVersion,
  resolveDatabase,
  type CatalogManifest,
  type ManifestCoverage,
  type ManifestTable,
  type ProdutoFilter,
  type RegulatoryScope,
} from "./_shared";

const PAGE = 2000;

type Args = {
  out: string;
  filter: ProdutoFilter;
  regulatory: RegulatoryScope;
  includeHistory: boolean;
  includeTipoDoc: boolean;
  limit: number | null;
  apply: boolean;
};

function parseCli(): Args & { tenant?: string; urlEnv?: string; allowTest: boolean } {
  const { values } = parseArgs({
    options: {
      "source-tenant": { type: "string" },
      "source-url-env": { type: "string" },
      out: { type: "string" },
      filter: { type: "string", default: "enriched" },
      regulatory: { type: "string", default: "all" },
      "include-history": { type: "boolean", default: false },
      "include-tipodoc": { type: "boolean", default: false },
      "allow-test-tenant": { type: "boolean", default: false },
      limit: { type: "string" },
      apply: { type: "boolean", default: false },
    },
    strict: true,
  });

  const filter = String(values.filter);
  if (filter !== "enriched" && filter !== "all") {
    throw new CatalogToolError(`--filter aceita "enriched" ou "all" (recebido: ${filter}).`);
  }
  const regulatory = String(values.regulatory);
  if (regulatory !== "all" && regulatory !== "referenced" && regulatory !== "none") {
    throw new CatalogToolError(`--regulatory aceita "all", "referenced" ou "none" (recebido: ${regulatory}).`);
  }
  const apply = values.apply ?? false;
  if (apply && !values.out) {
    throw new CatalogToolError("--out <directório> é obrigatório quando se usa --apply.");
  }

  return {
    tenant: values["source-tenant"],
    urlEnv: values["source-url-env"],
    allowTest: values["allow-test-tenant"] ?? false,
    out: values.out ?? "",
    filter,
    regulatory,
    includeHistory: values["include-history"] ?? false,
    includeTipoDoc: values["include-tipodoc"] ?? false,
    limit: values.limit ? Number.parseInt(values.limit, 10) : null,
    apply,
  };
}

// ─── selects explícitos (o que entra no catálogo) ────────────────────

const PRODUTO_SELECT = {
  id: true,
  cnp: true,
  designacao: true,
  fabricanteId: true,
  classificacaoNivel1Id: true,
  classificacaoNivel2Id: true,
  tipoArtigo: true,
  codigoATC: true,
  dci: true,
  imagemUrl: true,
  formaFarmaceutica: true,
  dosagem: true,
  embalagem: true,
  flagGenerico: true,
  flagMSRM: true,
  flagMNSRM: true,
  flagMnsrmNCompart: true,
  grupoHomogeneo: true,
  estado: true,
  origemDados: true,
  validadoManualmente: true,
  productType: true,
  productTypeConfidence: true,
  classificationSource: true,
  classificationVersion: true,
  verificationStatus: true,
  lastVerifiedAt: true,
  externallyVerified: true,
  needsManualReview: true,
  manualReviewReason: true,
  dataCriacao: true,
} as const;

type ProdutoRow = {
  id: string;
  cnp: number;
  fabricanteId: string | null;
  classificacaoNivel1Id: string | null;
  classificacaoNivel2Id: string | null;
  codigoATC: string | null;
  dci: string | null;
  formaFarmaceutica: string | null;
  dosagem: string | null;
  embalagem: string | null;
  imagemUrl: string | null;
  validadoManualmente: boolean;
  verificationStatus: string;
  [key: string]: unknown;
};

async function main(): Promise<void> {
  const args = parseCli();
  const source = await resolveDatabase({
    tenant: args.tenant,
    urlEnv: args.urlEnv,
    role: "origem",
    allowBlockedTenant: args.allowTest,
  });
  const prisma = openClient(source.url);

  const dataDir = path.join(args.out, "data");
  const tables: ManifestTable[] = [];

  console.log("─".repeat(72));
  console.log("catalog:export — CATÁLOGO MESTRE");
  console.log("─".repeat(72));
  console.log(`  origem   : ${source.label}`);
  console.log(`  modo     : ${args.apply ? "APPLY (escreve bundle)" : "DRY-RUN (não escreve)"}`);
  console.log(`  filtro   : produtos=${args.filter} · regulatory=${args.regulatory}`);
  console.log(`  opcionais: history=${args.includeHistory} tipodoc=${args.includeTipoDoc}`);
  if (args.apply) console.log(`  destino  : ${path.resolve(args.out)}`);
  console.log("");

  const schemaVersion = await readSchemaVersion(prisma);
  console.log(`  schema   : ${schemaVersion ?? "(desconhecido)"}`);
  console.log("");

  try {
    if (args.apply) ensureDir(dataDir);

    // ── 1. Classificacao (árvore inteira, ordenada por profundidade) ──
    const classificacoes = await prisma.classificacao.findMany({
      select: {
        id: true,
        nome: true,
        tipo: true,
        classificacaoPaiId: true,
        estado: true,
        ordem: true,
        dataCriacao: true,
      },
      orderBy: { dataCriacao: "asc" },
    });
    tables.push(
      await dump(args, dataDir, "classificacao", sortByDepth(classificacoes)),
    );

    // ── 2. Fabricante + 3. aliases ────────────────────────────────────
    const fabricantes = await prisma.fabricante.findMany({
      select: {
        id: true,
        nomeNormalizado: true,
        paisOrigem: true,
        estado: true,
        dataCriacao: true,
      },
      orderBy: { nomeNormalizado: "asc" },
    });
    tables.push(await dump(args, dataDir, "fabricante", fabricantes));

    const aliases = await prisma.fabricanteAlias.findMany({
      select: { id: true, fabricanteId: true, aliasNome: true },
      orderBy: [{ fabricanteId: "asc" }, { aliasNome: "asc" }],
    });
    tables.push(await dump(args, dataDir, "fabricanteAlias", aliases));

    // ── 4. Produto (paginado; filtro de valor de catálogo) ────────────
    const produtoWriter = args.apply
      ? new NdjsonWriter(path.join(dataDir, TABLE_SPECS.produto.file))
      : null;
    const coverage: ManifestCoverage = {
      produtos: 0,
      comATC: 0,
      comDCI: 0,
      comFormaFarmaceutica: 0,
      comDosagem: 0,
      comEmbalagem: 0,
      comImagem: 0,
      comFabricante: 0,
      comNivel1: 0,
      comNivel2: 0,
      validadosManualmente: 0,
    };
    const exportedCnps: number[] = [];
    let skippedSemValor = 0;
    let cursor: string | undefined;
    let produtoRows = 0;

    for (;;) {
      const page: ProdutoRow[] = (await prisma.produto.findMany({
        select: PRODUTO_SELECT,
        orderBy: { id: "asc" },
        take: PAGE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      })) as unknown as ProdutoRow[];
      if (page.length === 0) break;
      cursor = page[page.length - 1].id;

      for (const row of page) {
        if (args.filter === "enriched" && !carriesCatalogValue(row)) {
          skippedSemValor += 1;
          continue;
        }
        if (args.limit !== null && produtoRows >= args.limit) break;
        produtoRows += 1;
        exportedCnps.push(row.cnp);
        countCoverage(coverage, row);
        produtoWriter?.write(row);
      }
      if (args.limit !== null && produtoRows >= args.limit) break;
      if (page.length < PAGE) break;
    }

    tables.push(await finish("produto", produtoWriter, produtoRows));

    // ── 5. RegulatoryRecord ───────────────────────────────────────────
    tables.push(
      await dumpRegulatory(args, dataDir, prisma, exportedCnps),
    );

    // ── 6. InfarmedSnapshot ───────────────────────────────────────────
    const snapshots =
      args.regulatory === "none"
        ? []
        : await prisma.infarmedSnapshot.findMany({
            ...(args.regulatory === "referenced"
              ? { where: { cnp: { in: exportedCnps.slice(0, 30_000) } } }
              : {}),
            orderBy: { cnp: "asc" },
          });
    tables.push(await dump(args, dataDir, "infarmedSnapshot", snapshots));

    // ── 7. ProdutoVerificacaoHistorico (opcional) ─────────────────────
    if (args.includeHistory) {
      const historico = await prisma.produtoVerificacaoHistorico.findMany({
        orderBy: { verificadoEm: "asc" },
        ...(args.limit ? { take: args.limit } : {}),
      });
      tables.push(await dump(args, dataDir, "produtoVerificacaoHistorico", historico));
    } else {
      tables.push(emptyTable("produtoVerificacaoHistorico"));
    }

    // ── 8. TipoDocumentoClassificacao (opcional) ──────────────────────
    if (args.includeTipoDoc) {
      const tipos = await prisma.tipoDocumentoClassificacao.findMany({
        orderBy: { tipoDocumento: "asc" },
      });
      tables.push(await dump(args, dataDir, "tipoDocumentoClassificacao", tipos));
    } else {
      tables.push(emptyTable("tipoDocumentoClassificacao"));
    }

    // ── Manifest + checksums ──────────────────────────────────────────
    const manifest: CatalogManifest = {
      manifestVersion: MANIFEST_VERSION,
      tool: TOOL_VERSION,
      exportedAt: new Date().toISOString(),
      source: {
        label: source.label,
        kind: source.kind,
        tenantSlug: source.tenantSlug,
        schemaVersion,
      },
      options: {
        filter: args.filter,
        includeHistory: args.includeHistory,
        includeTipoDoc: args.includeTipoDoc,
        regulatory: args.regulatory,
      },
      tables,
      coverage,
      omittedProdutoFields: [...PRODUTO_TENANT_FIELDS],
      excludedTables: EXCLUDED_TABLES,
    };

    if (args.apply) {
      writeFileSync(path.join(args.out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      const lines = tables
        .filter((t) => t.rows > 0)
        .map((t) => `${t.sha256}  data/${t.file}`)
        .join("\n");
      writeFileSync(path.join(args.out, "checksums.sha256"), `${lines}\n`, "utf8");
    }

    // ── Relatório ─────────────────────────────────────────────────────
    console.log("  Tabelas:");
    for (const t of tables) {
      const spec = TABLE_SPECS[t.table];
      const flag = spec.optional && t.rows === 0 ? " (opcional, não incluída)" : "";
      console.log(`    ${t.model.padEnd(30)} ${fmt(t.rows).padStart(9)} linhas${flag}`);
    }
    if (skippedSemValor > 0) {
      console.log(`\n  ${fmt(skippedSemValor)} produtos ignorados por não carregarem valor de catálogo (--filter enriched).`);
    }
    console.log("\n  Cobertura do catálogo exportado:");
    printCoverage(coverage);

    if (args.apply) {
      console.log(`\n✓ Bundle escrito em ${path.resolve(args.out)}`);
      console.log("  manifest.json + checksums.sha256 + data/*.ndjson");
      console.log("  Nenhum dado operacional e nenhum segredo incluído.");
    } else {
      console.log("\n(dry-run — nada foi escrito. Repete com --out <dir> --apply.)");
    }
  } finally {
    await prisma.$disconnect().catch(() => {});
    await closeControl();
  }
}

// ─── helpers ─────────────────────────────────────────────────────────

function sortByDepth<T extends { id: string; classificacaoPaiId: string | null }>(rows: T[]): T[] {
  // Import faz o remap por chave natural, que precisa do pai já resolvido.
  // Ordenar por profundidade garante isso sem precisar de segunda passagem.
  const parent = new Map(rows.map((r) => [r.id, r.classificacaoPaiId]));
  const depthOf = (id: string): number => {
    let d = 0;
    let cur = parent.get(id) ?? null;
    const seen = new Set<string>([id]);
    while (cur && parent.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      d += 1;
      cur = parent.get(cur) ?? null;
    }
    return d;
  };
  return [...rows].sort((a, b) => depthOf(a.id) - depthOf(b.id) || a.id.localeCompare(b.id));
}

async function dump(
  args: Args,
  dataDir: string,
  table: keyof typeof TABLE_SPECS,
  rows: unknown[],
): Promise<ManifestTable> {
  const spec = TABLE_SPECS[table];
  if (!args.apply) {
    return { table: spec.table, model: spec.model, file: spec.file, rows: rows.length, sha256: "", bytes: 0 };
  }
  const writer = new NdjsonWriter(path.join(dataDir, spec.file));
  for (const row of rows) writer.write(row);
  const res = await writer.close();
  return { table: spec.table, model: spec.model, file: spec.file, ...res };
}

async function finish(
  table: keyof typeof TABLE_SPECS,
  writer: NdjsonWriter | null,
  rows: number,
): Promise<ManifestTable> {
  const spec = TABLE_SPECS[table];
  if (!writer) {
    return { table: spec.table, model: spec.model, file: spec.file, rows, sha256: "", bytes: 0 };
  }
  const res = await writer.close();
  return { table: spec.table, model: spec.model, file: spec.file, ...res };
}

function emptyTable(table: keyof typeof TABLE_SPECS): ManifestTable {
  const spec = TABLE_SPECS[table];
  return { table: spec.table, model: spec.model, file: spec.file, rows: 0, sha256: "", bytes: 0 };
}

async function dumpRegulatory(
  args: Args,
  dataDir: string,
  prisma: PrismaClient,
  cnps: number[],
): Promise<ManifestTable> {
  const spec = TABLE_SPECS.regulatoryRecord;
  if (args.regulatory === "none") return emptyTable("regulatoryRecord");

  const writer = args.apply ? new NdjsonWriter(path.join(dataDir, spec.file)) : null;
  let rows = 0;

  if (args.regulatory === "referenced") {
    for (const batch of chunk(cnps, 5000)) {
      const found = await prisma.regulatoryRecord.findMany({
        where: { cnp: { in: batch } },
        orderBy: { cnp: "asc" },
      });
      for (const r of found) {
        rows += 1;
        writer?.write(r);
      }
    }
  } else {
    let cursor: number | undefined;
    for (;;) {
      const page = await prisma.regulatoryRecord.findMany({
        orderBy: { cnp: "asc" },
        take: PAGE,
        ...(cursor !== undefined ? { cursor: { cnp: cursor }, skip: 1 } : {}),
      });
      if (page.length === 0) break;
      cursor = page[page.length - 1].cnp;
      for (const r of page) {
        rows += 1;
        writer?.write(r);
      }
      if (page.length < PAGE) break;
    }
  }

  return finish("regulatoryRecord", writer, rows);
}

function countCoverage(c: ManifestCoverage, row: ProdutoRow): void {
  c.produtos += 1;
  if (row.codigoATC) c.comATC += 1;
  if (row.dci) c.comDCI += 1;
  if (row.formaFarmaceutica) c.comFormaFarmaceutica += 1;
  if (row.dosagem) c.comDosagem += 1;
  if (row.embalagem) c.comEmbalagem += 1;
  if (row.imagemUrl) c.comImagem += 1;
  if (row.fabricanteId) c.comFabricante += 1;
  if (row.classificacaoNivel1Id) c.comNivel1 += 1;
  if (row.classificacaoNivel2Id) c.comNivel2 += 1;
  if (row.validadoManualmente) c.validadosManualmente += 1;
}

function printCoverage(c: ManifestCoverage): void {
  const pct = (n: number) => (c.produtos === 0 ? "  0,0%" : `${((n / c.produtos) * 100).toFixed(1).padStart(5)}%`);
  const line = (label: string, n: number) =>
    console.log(`    ${label.padEnd(26)} ${fmt(n).padStart(9)}  ${pct(n)}`);
  console.log(`    ${"produtos".padEnd(26)} ${fmt(c.produtos).padStart(9)}`);
  line("com ATC", c.comATC);
  line("com DCI", c.comDCI);
  line("com forma farmacêutica", c.comFormaFarmaceutica);
  line("com dosagem", c.comDosagem);
  line("com embalagem", c.comEmbalagem);
  line("com imagem", c.comImagem);
  line("com fabricante", c.comFabricante);
  line("com classificação N1", c.comNivel1);
  line("com classificação N2", c.comNivel2);
  line("validados manualmente", c.validadosManualmente);
}

main().catch(async (err) => {
  await closeControl();
  if (err instanceof CatalogToolError) {
    console.error(`\n✗ ${err.message}`);
    process.exit(1);
  }
  console.error("\n✗ Falha inesperada no export:", err);
  process.exit(1);
});
