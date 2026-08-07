/**
 * scripts/sync-enriched-fields.ts
 *
 * Sync read-mostly de campos enriquecidos do catálogo entre duas bases
 * de dados Postgres, com match por Produto.cnp. NÃO faz nenhum lookup
 * web nem chama conectores. É puramente BD → BD.
 *
 *   Source : .env                  (default)
 *   Target : .env.production.local (default)
 *
 * Filtros aplicados ao conjunto sincronizado:
 *   · cnp > MIN_CATALOGUABLE_CNP (2.000.000) — códigos catalogáveis
 *   · só produtos com cnp presente em ambas as bases
 *   · em target, salta produtos com validadoManualmente=true
 *
 * Campos sincronizados (cópia directa de local → target):
 *   productType, productTypeConfidence, verificationStatus,
 *   classificationSource, classificationVersion, externallyVerified,
 *   needsManualReview, manualReviewReason, origemDados, lastVerifiedAt,
 *   imagemUrl, dci, codigoATC, formaFarmaceutica, dosagem, embalagem,
 *   flagMSRM, flagMNSRM, flagGenerico
 *
 * Referências mapeadas por NOME (NUNCA por id):
 *   · fabricanteId          ← Fabricante.nomeNormalizado
 *   · classificacaoNivel1Id ← (nome, tipo, classificacaoPaiId=null)
 *   · classificacaoNivel2Id ← (nome, tipo, classificacaoPaiId=<N1 mapeada>)
 *
 * Comportamento das FKs:
 *   · entidade nomeada não existe em target → campo marcado UNMAPPABLE,
 *     SALTADO para esse produto. Os outros campos do produto continuam
 *     a ser sincronizados.
 *   · não cria Fabricantes nem Classificacoes em target.
 *
 * Semântica de null:
 *   · cópia estrita: se local tem null e target tem valor, faz null em target.
 *     A intenção é "target deve espelhar local". O dry-run mostra essa
 *     transição claramente para revisão.
 *
 * Modos:
 *   npx tsx scripts/sync-enriched-fields.ts                  # dry-run completo
 *   npx tsx scripts/sync-enriched-fields.ts --limit=200      # dry-run dos 200 primeiros matches
 *   npx tsx scripts/sync-enriched-fields.ts --apply          # APPLY (writes)
 *   npx tsx scripts/sync-enriched-fields.ts --source-env=PATH --target-env=PATH
 *
 * Idempotência:
 *   · re-execução com --apply sem alterações intermédias deve devolver
 *     0 updates. Cada produto só é tocado se pelo menos um campo difere.
 *
 * Sanidade:
 *   · se source DATABASE_URL == target DATABASE_URL, aborta antes de
 *     qualquer leitura.
 */

import { readFileSync } from "fs";
import { parse as parseEnv } from "dotenv";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { MIN_CATALOGUABLE_CNP } from "../lib/catalog-enrichment";

// ─── Lista exaustiva dos campos sincronizados ────────────────────────────────

const DIRECT_FIELDS = [
  "productType",
  "productTypeConfidence",
  "verificationStatus",
  "classificationSource",
  "classificationVersion",
  "externallyVerified",
  "needsManualReview",
  "manualReviewReason",
  "origemDados",
  "lastVerifiedAt",
  "imagemUrl",
  "dci",
  "codigoATC",
  "formaFarmaceutica",
  "dosagem",
  "embalagem",
  "flagMSRM",
  "flagMNSRM",
  "flagGenerico",
] as const;

const FK_FIELDS = [
  "fabricanteId",
  "classificacaoNivel1Id",
  "classificacaoNivel2Id",
] as const;

const SELECT_PRODUTO = {
  id: true,
  cnp: true,
  validadoManualmente: true,
  fabricanteId: true,
  classificacaoNivel1Id: true,
  classificacaoNivel2Id: true,
  productType: true,
  productTypeConfidence: true,
  verificationStatus: true,
  classificationSource: true,
  classificationVersion: true,
  externallyVerified: true,
  needsManualReview: true,
  manualReviewReason: true,
  origemDados: true,
  lastVerifiedAt: true,
  imagemUrl: true,
  dci: true,
  codigoATC: true,
  formaFarmaceutica: true,
  dosagem: true,
  embalagem: true,
  flagMSRM: true,
  flagMNSRM: true,
  flagGenerico: true,
} as const;

// ─── Args ────────────────────────────────────────────────────────────────────

type Args = {
  sourceEnv: string;
  targetEnv: string;
  limit: number | null;
  apply: boolean;
};

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let sourceEnv = ".env";
  let targetEnv = ".env.production.local";
  let limit: number | null = null;
  let apply = false;

  for (const a of argv) {
    if (a === "--apply") apply = true;
    else if (a.startsWith("--limit=")) {
      const n = parseInt(a.split("=")[1], 10);
      if (!isNaN(n) && n > 0) limit = n;
    } else if (a.startsWith("--source-env=")) sourceEnv = a.split("=")[1];
    else if (a.startsWith("--target-env=")) targetEnv = a.split("=")[1];
    else console.warn(`[aviso] argumento desconhecido: ${a}`);
  }
  return { sourceEnv, targetEnv, limit, apply };
}

// ─── Env loading sem mexer em process.env ────────────────────────────────────

function loadDbUrl(envFile: string): string {
  let content: string;
  try {
    content = readFileSync(envFile, "utf8");
  } catch (e) {
    throw new Error(`Não foi possível ler ${envFile}: ${(e as Error).message}`);
  }
  const parsed = parseEnv(content);
  const url = parsed.DATABASE_URL;
  if (!url) throw new Error(`DATABASE_URL não encontrado em ${envFile}`);
  return url;
}

function sanitiseUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//<user>:<pass>@${u.host}${u.pathname}`;
  } catch {
    return "<unparseable>";
  }
}

function makePrisma(connectionString: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

// ─── Comparação ──────────────────────────────────────────────────────────────

function eq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return false;
}

function fmtVal(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") {
    return v.length > 60 ? `"${v.slice(0, 57)}..."` : `"${v}"`;
  }
  return String(v);
}

// ─── Maps de Fabricante e Classificacao ──────────────────────────────────────

type FabMaps = {
  byId: Map<string, string>; // id → nomeNormalizado
  byName: Map<string, string>; // nomeNormalizado → id
};

async function buildFabMaps(client: PrismaClient): Promise<FabMaps> {
  const all = await client.fabricante.findMany({
    select: { id: true, nomeNormalizado: true },
  });
  const byId = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const f of all) {
    byId.set(f.id, f.nomeNormalizado);
    byName.set(f.nomeNormalizado, f.id);
  }
  return { byId, byName };
}

type ClassifNode = {
  id: string;
  nome: string;
  tipo: string;
  classificacaoPaiId: string | null;
};

type ClassifMaps = {
  byId: Map<string, ClassifNode>;
  byKey: Map<string, string>; // composite key → id
  /** Devolve a chave composta estável de um id local. Lê recursivamente os pais. */
  compositeKey: (id: string) => string | null;
};

async function buildClassifMaps(client: PrismaClient): Promise<ClassifMaps> {
  const all = (await client.classificacao.findMany({
    select: {
      id: true,
      nome: true,
      tipo: true,
      classificacaoPaiId: true,
    },
  })) as ClassifNode[];

  const byId = new Map<string, ClassifNode>();
  for (const c of all) byId.set(c.id, c);

  function compositeKey(id: string): string | null {
    const seen = new Set<string>();
    function walk(curr: string): string | null {
      if (seen.has(curr)) return null; // ciclo defensivo
      seen.add(curr);
      const node = byId.get(curr);
      if (!node) return null;
      const paiKey = node.classificacaoPaiId
        ? walk(node.classificacaoPaiId)
        : "ROOT";
      if (paiKey === null) return null;
      return `${node.tipo}|${node.nome}|${paiKey}`;
    }
    return walk(id);
  }

  const byKey = new Map<string, string>();
  for (const c of all) {
    const k = compositeKey(c.id);
    if (k) byKey.set(k, c.id);
  }

  return { byId, byKey, compositeKey };
}

// ─── Mapping helpers ─────────────────────────────────────────────────────────

const UNMAPPABLE = Symbol("UNMAPPABLE");
type Mapped = string | null | typeof UNMAPPABLE;

function mapFabId(
  localId: string | null,
  src: FabMaps,
  tgt: FabMaps,
): Mapped {
  if (localId === null) return null;
  const name = src.byId.get(localId);
  if (!name) return UNMAPPABLE;
  const id = tgt.byName.get(name);
  return id ?? UNMAPPABLE;
}

function mapClassifId(
  localId: string | null,
  src: ClassifMaps,
  tgt: ClassifMaps,
): Mapped {
  if (localId === null) return null;
  const key = src.compositeKey(localId);
  if (!key) return UNMAPPABLE;
  const id = tgt.byKey.get(key);
  return id ?? UNMAPPABLE;
}

function describeUnmappableClassif(
  localId: string,
  src: ClassifMaps,
): string {
  const key = src.compositeKey(localId);
  if (!key) return `id=${localId} (chave irresolúvel)`;
  return `path=${key.replace(/\|/g, " / ")}`;
}

function describeUnmappableFab(
  localId: string,
  src: FabMaps,
): string {
  return `nome="${src.byId.get(localId) ?? "?"}" (id=${localId})`;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();
  const sep = "─".repeat(74);

  const sourceUrl = loadDbUrl(args.sourceEnv);
  const targetUrl = loadDbUrl(args.targetEnv);

  console.log(sep);
  console.log(
    `Sync enriched fields  —  ${args.apply ? "MODO APPLY (vai escrever)" : "DRY-RUN"}`,
  );
  console.log(`Source : ${args.sourceEnv}    ${sanitiseUrl(sourceUrl)}`);
  console.log(`Target : ${args.targetEnv}    ${sanitiseUrl(targetUrl)}`);
  console.log(sep);

  if (sourceUrl === targetUrl) {
    throw new Error(
      "DATABASE_URL idêntico em source e target — abortado por segurança.",
    );
  }

  const source = makePrisma(sourceUrl);
  const target = makePrisma(targetUrl);

  try {
    // 1. Maps
    console.log("A carregar maps de Fabricante / Classificacao…");
    const [srcFab, tgtFab, srcCl, tgtCl] = await Promise.all([
      buildFabMaps(source),
      buildFabMaps(target),
      buildClassifMaps(source),
      buildClassifMaps(target),
    ]);
    console.log(
      `  source: ${srcFab.byId.size} fabricantes, ${srcCl.byId.size} classificacoes`,
    );
    console.log(
      `  target: ${tgtFab.byId.size} fabricantes, ${tgtCl.byId.size} classificacoes`,
    );

    // 2. Produtos source
    console.log("\nA carregar produtos source (cnp > limite)…");
    const srcProducts = await source.produto.findMany({
      where: { cnp: { gt: MIN_CATALOGUABLE_CNP } },
      select: SELECT_PRODUTO,
      orderBy: { cnp: "asc" },
    });
    console.log(`  ${srcProducts.length} produtos catalogáveis em source`);

    // 3. Produtos target correspondentes
    console.log("A carregar produtos target correspondentes…");
    const cnps = srcProducts.map((p) => p.cnp);
    const tgtProducts = await target.produto.findMany({
      where: { cnp: { in: cnps } },
      select: SELECT_PRODUTO,
    });
    const tgtByCnp = new Map<number, (typeof tgtProducts)[number]>();
    for (const p of tgtProducts) tgtByCnp.set(p.cnp, p);
    console.log(`  ${tgtProducts.length} produtos correspondentes em target`);

    // 4. Iterar
    const targets = args.limit ? srcProducts.slice(0, args.limit) : srcProducts;
    let matched = 0;
    let skippedManual = 0;
    let localOnly = 0;
    let withChanges = 0;
    let updated = 0;
    const fieldDiff: Record<string, number> = {};
    const fieldUnmappable: Record<string, number> = {};
    const samples: Array<{ cnp: number; changes: string[] }> = [];
    const unmappableSamples: Array<{ cnp: number; field: string; detail: string }> = [];

    for (const lp of targets) {
      const tp = tgtByCnp.get(lp.cnp);
      if (!tp) {
        localOnly++;
        continue;
      }
      matched++;
      if (tp.validadoManualmente) {
        skippedManual++;
        continue;
      }

      const updateData: Record<string, unknown> = {};
      const changes: string[] = [];

      // Direct fields
      for (const f of DIRECT_FIELDS) {
        const lv = (lp as Record<string, unknown>)[f];
        const tv = (tp as Record<string, unknown>)[f];
        if (!eq(lv, tv)) {
          updateData[f] = lv;
          fieldDiff[f] = (fieldDiff[f] ?? 0) + 1;
          changes.push(`${f}: ${fmtVal(tv)} → ${fmtVal(lv)}`);
        }
      }

      // FK fields
      const fkResolved: Record<(typeof FK_FIELDS)[number], Mapped> = {
        fabricanteId: mapFabId(lp.fabricanteId, srcFab, tgtFab),
        classificacaoNivel1Id: mapClassifId(lp.classificacaoNivel1Id, srcCl, tgtCl),
        classificacaoNivel2Id: mapClassifId(lp.classificacaoNivel2Id, srcCl, tgtCl),
      };

      for (const f of FK_FIELDS) {
        const r = fkResolved[f];
        const tv = (tp as Record<string, unknown>)[f];
        if (r === UNMAPPABLE) {
          fieldUnmappable[f] = (fieldUnmappable[f] ?? 0) + 1;
          if (unmappableSamples.length < 10) {
            const localFkId = (lp as Record<string, unknown>)[f] as string | null;
            const detail =
              f === "fabricanteId"
                ? describeUnmappableFab(localFkId!, srcFab)
                : describeUnmappableClassif(localFkId!, srcCl);
            unmappableSamples.push({ cnp: lp.cnp, field: f, detail });
          }
          continue;
        }
        if (!eq(r, tv)) {
          updateData[f] = r;
          fieldDiff[f] = (fieldDiff[f] ?? 0) + 1;
          changes.push(`${f}: ${fmtVal(tv)} → ${fmtVal(r)}`);
        }
      }

      if (changes.length > 0) {
        withChanges++;
        if (samples.length < 10) samples.push({ cnp: lp.cnp, changes });

        if (args.apply) {
          await target.produto.update({
            where: { id: tp.id },
            data: updateData,
          });
          updated++;
          if (updated % 100 === 0) console.log(`  …updated ${updated}`);
        }
      }
    }

    // 5. Report
    console.log(`\n${sep}`);
    console.log("Resumo");
    console.log(sep);
    console.log(`  source produtos (cnp > limite)        : ${srcProducts.length}`);
    console.log(`  considerados (após --limit)            : ${targets.length}`);
    console.log(`  matched em target                      : ${matched}`);
    console.log(`  só em source (sem match em target)     : ${localOnly}`);
    console.log(`  saltados (validadoManualmente=true)    : ${skippedManual}`);
    console.log(`  com pelo menos uma alteração           : ${withChanges}`);
    if (args.apply) {
      console.log(`  actualizados (apply)                   : ${updated}`);
    }
    console.log();

    console.log("Diff por campo (qty alteradas | unmappable):");
    const allFields = [...DIRECT_FIELDS, ...FK_FIELDS];
    for (const f of allFields) {
      const diff = fieldDiff[f] ?? 0;
      const unm = fieldUnmappable[f] ?? 0;
      if (diff === 0 && unm === 0) continue;
      const left = `  ${f}`.padEnd(34);
      const diffPart = String(diff).padStart(5);
      const unmPart = unm > 0 ? `  | unmappable ${unm}` : "";
      console.log(`${left}${diffPart}${unmPart}`);
    }
    console.log();

    console.log("Amostra de até 10 produtos com alteração:");
    for (const s of samples) {
      console.log(`  cnp=${s.cnp}`);
      for (const c of s.changes) console.log(`    · ${c}`);
    }
    if (samples.length === 0) console.log("  (nenhum)");
    console.log();

    if (unmappableSamples.length > 0) {
      console.log("Amostra de até 10 referências unmappable:");
      for (const u of unmappableSamples) {
        console.log(`  cnp=${u.cnp}  ${u.field}  ${u.detail}`);
      }
      console.log();
    }

    if (!args.apply) {
      console.log("DRY-RUN — nenhuma alteração foi escrita em target.");
      console.log("Para aplicar de facto: --apply");
    } else {
      console.log(`APPLY concluído. ${updated} produto(s) actualizado(s) em target.`);
    }
    console.log(sep);
  } finally {
    await source.$disconnect();
    await target.$disconnect();
  }
}

main().catch((err) => {
  console.error("\n[erro fatal]", err);
  process.exit(1);
});
