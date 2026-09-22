/**
 * scripts/import-catalogo-nacional-completo.ts
 *
 * Importador do formato REAL do catálogo nacional completo (INFARMED-
 * like, 14 campos, delimitador `(;)`, linhas físicas de 200 caracteres,
 * Windows-1252/Latin-1) para `RegulatoryRecord` — a tabela regulatória
 * "v2" já existente (`prisma/schema.prisma`), lida primeiro pelo
 * `infarmedConnector` (`lib/catalog-connectors.ts`) antes de cair em
 * `InfarmedSnapshot`.
 *
 * NÃO duplica a lógica de upsert/batching/merge-preserva-não-null: lê e
 * reconstrói o ficheiro (via `lib/catalog/catalogo-nacional-parser.ts`,
 * streaming, nunca o ficheiro inteiro em memória) e entrega os registos
 * já parseados a `upsertBatch` de `scripts/import-regulatory-record.ts`
 * — exactamente o mesmo padrão de reaproveitamento que
 * `scripts/correct-fabricantes-listagem.ts` já usa (ver o comentário
 * sobre isso em `import-regulatory-record.ts`).
 *
 * Só 4 campos deste formato têm correspondência em RegulatoryRecord:
 * cnp, estadoAim (campo 9), designacaoOficial (campo 11), titularAim
 * (campo 12). Os restantes 9 campos (preço de referência, códigos,
 * datas, flag S/N) não têm campo correspondente no schema — ficam de
 * fora, não há perda silenciosa: o parser (`catalogo-nacional-parser.ts`)
 * preserva-os em `outrosCampos` para quem precisar deles no futuro.
 *
 * Uso:
 *   npx tsx scripts/import-catalogo-nacional-completo.ts \
 *     --tenant=garantia \
 *     --file=.local-data/fabricantes-garantia/catalogo/teste.csv \
 *     --source=catalogo_nacional_completo_2026-09 \
 *     --dry-run
 *
 * Opções:
 *   --tenant=<slug>    Obrigatório — resolvido via resolverAlvo (control plane), nunca DATABASE_URL genérico.
 *   --file=<path>      Obrigatório.
 *   --source=<tag>     Obrigatório — gravado em RegulatoryRecord.source.
 *   --dry-run          Não escreve, só simula (upsertBatch aceita dryRun).
 *   --force            Sobrescreve campos já não-nulos (default: preserva não-null).
 *   --batch-size=N     Default 500 — mesmo default de import-regulatory-record.ts.
 *   --limit=N          Limitar nº de registos processados (debug).
 *   --permitir-externo Necessário se o tenant não for a VPS de produção.
 */
import "dotenv/config";
import { createReadStream, existsSync } from "node:fs";
import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { buildTenantConnectionString, getTenantBySlug } from "../lib/control-plane";
import { AlvoRecusado, descreverAlvo, resolverAlvo, type AlvoDb } from "../lib/catalog/target-db";
import { lerCatalogoNacional, type RegistoCatalogoNacionalBruto, type ErroReconstrucaoCatalogo } from "../lib/catalog/catalogo-nacional-parser";
import { upsertBatch, type ParsedRow, type UpsertCounters } from "./import-regulatory-record";

export type Args = {
  file: string;
  source: string;
  dryRun: boolean;
  force: boolean;
  batchSize: number;
  limit: number | null;
};

export function parseArgs(argv: readonly string[]): Args {
  const out: Partial<Args> = { dryRun: false, force: false, batchSize: 500, limit: null };
  for (const a of argv) {
    if (a.startsWith("--file=")) out.file = a.slice("--file=".length);
    else if (a.startsWith("--source=")) out.source = a.slice("--source=".length);
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--force") out.force = true;
    else if (a.startsWith("--batch-size=")) {
      const n = parseInt(a.slice("--batch-size=".length), 10);
      if (!isNaN(n) && n > 0 && n <= 1000) out.batchSize = n;
    } else if (a.startsWith("--limit=")) {
      const n = parseInt(a.slice("--limit=".length), 10);
      if (!isNaN(n) && n > 0) out.limit = n;
    } else if (a.startsWith("--tenant=") || a === "--permitir-externo") {
      // Consumido por resolverAlvo.
    } else {
      throw new Error(`argumento desconhecido: ${a}`);
    }
  }
  if (!out.file) throw new Error("--file=<path> é obrigatório");
  if (!out.source) throw new Error("--source=<tag> é obrigatório");
  return out as Args;
}

export function registoParaParsedRow(r: RegistoCatalogoNacionalBruto): ParsedRow {
  return {
    cnp: r.cnp,
    designacaoOficial: r.designacao,
    titularAim: r.titular,
    estadoAim: r.estado,
  };
}

export type EstatisticasImportacao = {
  registosLidos: number;
  erros: ErroReconstrucaoCatalogo[];
  cnpDuplicadosNoFicheiro: number;
  totais: UpsertCounters;
};

/**
 * Consome o generator do parser em batches, delega cada batch a
 * `upsertBatch` — nunca acumula o ficheiro inteiro em memória (o maior
 * array vivo em qualquer momento é UM batch, `batchSize` registos).
 */
export async function importarCatalogoNacional(
  filePath: string,
  args: Pick<Args, "source" | "dryRun" | "force" | "batchSize" | "limit">,
  prismaClient: Parameters<typeof upsertBatch>[4],
  onBatch?: (processados: number) => void,
): Promise<EstatisticasImportacao> {
  const stats: EstatisticasImportacao = {
    registosLidos: 0,
    erros: [],
    cnpDuplicadosNoFicheiro: 0,
    totais: { inserted: 0, updatedSomeFields: 0, unchanged: 0, failed: 0 },
  };

  const cnpVistos = new Set<number>();
  let batch: ParsedRow[] = [];

  const input = createReadStream(filePath, { encoding: "latin1" });

  const processarBatch = async () => {
    if (batch.length === 0) return;
    const c = await upsertBatch(batch, args.source, args.force, args.dryRun, prismaClient);
    stats.totais.inserted += c.inserted;
    stats.totais.updatedSomeFields += c.updatedSomeFields;
    stats.totais.unchanged += c.unchanged;
    stats.totais.failed += c.failed;
    onBatch?.(stats.registosLidos);
    batch = [];
  };

  for await (const evento of lerCatalogoNacional(input)) {
    if (evento.tipo === "erro") {
      stats.erros.push(evento.erro);
      continue;
    }
    if (args.limit !== null && stats.registosLidos >= args.limit) break;

    stats.registosLidos++;
    if (cnpVistos.has(evento.registo.cnp)) stats.cnpDuplicadosNoFicheiro++;
    else cnpVistos.add(evento.registo.cnp);

    batch.push(registoParaParsedRow(evento.registo));
    if (batch.length >= args.batchSize) await processarBatch();
  }
  await processarBatch();

  return stats;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  if (!existsSync(args.file)) {
    console.error(`[fatal] ficheiro não encontrado: ${args.file}`);
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

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: alvo.url }) });
  try {
    await prisma.$executeRawUnsafe(`set session default_transaction_read_only = ${args.dryRun ? "on" : "off"}`);

    console.log("═".repeat(78));
    console.log("Importador do catálogo nacional completo — RegulatoryRecord");
    console.log("═".repeat(78));
    console.log(`  ${descreverAlvo(alvo)}`);
    console.log(`  Modo: ${args.dryRun ? "DRY-RUN" : "APPLY"}`);
    console.log(`  Ficheiro: ${args.file}`);
    console.log(`  source: ${args.source}`);
    console.log(`  force: ${args.force}`);
    console.log(`  batchSize: ${args.batchSize}`);
    if (args.limit) console.log(`  limit: ${args.limit}`);

    const t0 = Date.now();
    const stats = await importarCatalogoNacional(args.file, args, prisma, (processados) => {
      if (processados % 20000 === 0) {
        console.log(`  … ${processados} registos processados (${Math.round((Date.now() - t0) / 1000)}s)`);
      }
    });

    console.log(`\n${"─".repeat(78)}`);
    console.log("Resultado:");
    console.log(`  registos lidos:              ${stats.registosLidos}`);
    console.log(`  cnp duplicados no ficheiro:   ${stats.cnpDuplicadosNoFicheiro}`);
    console.log(`  erros de reconstrução:        ${stats.erros.length}`);
    if (stats.erros.length > 0) {
      console.log(`  amostra de erros:`);
      for (const e of stats.erros.slice(0, 10)) {
        console.log(`    registo #${e.indiceRegisto} [${e.motivo}]: ${e.detalhe}`);
      }
    }
    console.log(`  inseridos:                    ${stats.totais.inserted}`);
    console.log(`  actualizados (algum campo):   ${stats.totais.updatedSomeFields}`);
    console.log(`  inalterados:                  ${stats.totais.unchanged}`);
    console.log(`  falhas:                       ${stats.totais.failed}`);
    console.log(`  tempo total:                  ${Math.round((Date.now() - t0) / 1000)}s`);
    console.log(`\n${args.dryRun ? "⚠  DRY-RUN — nenhuma alteração foi gravada." : "✔  Aplicado."}`);
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

if (/[\\/]import-catalogo-nacional-completo\.(ts|js|mjs|cjs)$/.test(process.argv[1] ?? "")) {
  main().catch((err) => {
    console.error("[erro fatal]", err);
    process.exitCode = 1;
  });
}
