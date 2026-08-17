/**
 * scripts/catalog-master/import-catalog.ts
 *
 * Importa um bundle de CATÁLOGO MESTRE (produzido por export-catalog.ts)
 * para uma base nova. Idempotente, aditivo e nunca destrutivo.
 *
 * Destino SEMPRE explícito — `DATABASE_URL` nunca é usada por omissão:
 *   --target-tenant <slug>     resolve pelo control plane
 *   --target-url-env <ENV>     lê a connection string dessa env
 *
 * Uso:
 *   # dry-run (default): decide tudo e reporta, não escreve nada
 *   npm run catalog:import -- --from exports/catalogo-mestre --target-tenant silveira
 *
 *   # escrever
 *   npm run catalog:import -- --from exports/catalogo-mestre --target-tenant silveira --apply
 *
 * Garantias:
 *   · IDs de Classificacao / Fabricante / Produto são PRESERVADOS quando
 *     a base de destino ainda não os usa; quando já existe uma linha com
 *     a mesma CHAVE NATURAL mas outro id (caso típico: taxonomia semeada
 *     no provisionamento), o id do destino ganha e as FKs são remapeadas.
 *   · Nunca sobrescreve dados mais fortes: um campo preenchido no destino
 *     só cede a uma origem validada manualmente; `validadoManualmente` no
 *     destino é intocável; N1 "Outros Medicamentos" nunca substitui uma
 *     classificação existente.
 *   · Falha antes de escrever se faltarem dependências (FK do bundle sem
 *     linha correspondente) ou se o schema do destino divergir.
 */

import { parseArgs } from "node:util";
import path from "node:path";
import { PrismaClient } from "@/generated/prisma/client";
import {
  CatalogToolError,
  TABLE_SPECS,
  WEAK_NIVEL1,
  buildProdutoPatch,
  chunk,
  classificacaoDepth,
  closeControl,
  fmt,
  naturalKeyClass,
  openClient,
  readManifest,
  readNdjson,
  readSchemaVersion,
  resolveDatabase,
  verifyBundle,
  type CatalogManifest,
} from "./_shared";

const BATCH = 1000;

type Counters = { inserted: number; updated: number; unchanged: number; skipped: number };

const zero = (): Counters => ({ inserted: 0, updated: 0, unchanged: 0, skipped: 0 });

type Stats = Record<string, Counters>;

type ClassificacaoRow = {
  id: string;
  nome: string;
  tipo: string;
  classificacaoPaiId: string | null;
  estado: string;
  ordem: number | null;
  dataCriacao: string | null;
};

type FabricanteRow = {
  id: string;
  nomeNormalizado: string;
  paisOrigem: string | null;
  estado: string;
  dataCriacao: string | null;
};

type AliasRow = { id: string; fabricanteId: string; aliasNome: string };

type ProdutoRow = Record<string, unknown> & {
  id: string;
  cnp: number;
  designacao: string;
  fabricanteId: string | null;
  classificacaoNivel1Id: string | null;
  classificacaoNivel2Id: string | null;
  validadoManualmente: boolean;
};

const PRODUTO_DATE_FIELDS = ["lastVerifiedAt", "dataCriacao"] as const;

function parseCli() {
  const { values } = parseArgs({
    options: {
      from: { type: "string" },
      "target-tenant": { type: "string" },
      "target-url-env": { type: "string" },
      "allow-test-tenant": { type: "boolean", default: false },
      "allow-schema-drift": { type: "boolean", default: false },
      "skip-checksums": { type: "boolean", default: false },
      apply: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (!values.from) {
    throw new CatalogToolError("--from <directório do bundle> é obrigatório.");
  }
  return {
    from: values.from,
    tenant: values["target-tenant"],
    urlEnv: values["target-url-env"],
    allowTest: values["allow-test-tenant"] ?? false,
    allowDrift: values["allow-schema-drift"] ?? false,
    skipChecksums: values["skip-checksums"] ?? false,
    apply: values.apply ?? false,
  };
}

async function main(): Promise<void> {
  const args = parseCli();
  const dir = args.from;
  const manifest = readManifest(dir);
  const target = await resolveDatabase({
    tenant: args.tenant,
    urlEnv: args.urlEnv,
    role: "destino",
    allowBlockedTenant: args.allowTest,
  });
  const prisma = openClient(target.url);
  const stats: Stats = {};

  console.log("─".repeat(72));
  console.log("catalog:import — CATÁLOGO MESTRE");
  console.log("─".repeat(72));
  console.log(`  bundle  : ${path.resolve(dir)}`);
  console.log(`  origem  : ${manifest.source.label} (exportado ${manifest.exportedAt})`);
  console.log(`  destino : ${target.label}`);
  console.log(`  modo    : ${args.apply ? "APPLY (escreve)" : "DRY-RUN (não escreve)"}`);
  console.log("");

  try {
    // ── Pré-voo 1: integridade do bundle ──────────────────────────────
    if (!args.skipChecksums) {
      const problems = await verifyBundle(dir, manifest);
      if (problems.length > 0) {
        throw new CatalogToolError(
          `Bundle corrompido ou incompleto:\n${problems.map((p) => `  · ${p}`).join("\n")}`,
        );
      }
      console.log("  ✓ checksums verificados");
    }

    // ── Pré-voo 2: schema ─────────────────────────────────────────────
    const targetSchema = await readSchemaVersion(prisma);
    if (manifest.source.schemaVersion && targetSchema && manifest.source.schemaVersion !== targetSchema) {
      const msg =
        `Schema divergente:\n` +
        `  bundle : ${manifest.source.schemaVersion}\n` +
        `  destino: ${targetSchema}\n` +
        `  Corre \`npm run tenancy:migrate-all\` no destino, ou passa --allow-schema-drift se souberes que as tabelas do catálogo não mudaram.`;
      if (!args.allowDrift) throw new CatalogToolError(msg);
      console.log(`  ⚠ ${msg.split("\n").join("\n    ")}`);
    } else {
      console.log(`  ✓ schema do destino: ${targetSchema ?? "(desconhecido)"}`);
    }

    // ── Pré-voo 3: dependências do bundle ─────────────────────────────
    await preflightDependencies(dir, manifest);
    console.log("  ✓ dependências do bundle completas\n");

    // ── 1. Classificacao ──────────────────────────────────────────────
    const classMap = await importClassificacoes(prisma, dir, args.apply, stats);

    // ── 2. Fabricante ─────────────────────────────────────────────────
    const fabMap = await importFabricantes(prisma, dir, args.apply, stats);

    // ── 3. FabricanteAlias ────────────────────────────────────────────
    await importAliases(prisma, dir, fabMap, args.apply, stats);

    // ── 4. Utilizacao (vocabulário, antes das associações) ────────────
    const utilMap = await importUtilizacoes(prisma, dir, args.apply, stats);

    // ── 5. Produto ────────────────────────────────────────────────────
    await importProdutos(prisma, dir, classMap, fabMap, args.apply, stats);

    // ── 6. ProdutoUtilizacao (→ Produto, Utilizacao) ──────────────────
    await importProdutoUtilizacoes(prisma, dir, utilMap, args.apply, stats);

    // ── 5/6. RegulatoryRecord + InfarmedSnapshot ──────────────────────
    await importRegulatoryRecords(prisma, dir, args.apply, stats);
    await importInfarmedSnapshots(prisma, dir, args.apply, stats);

    // ── 7/8. Opcionais ────────────────────────────────────────────────
    await importHistorico(prisma, dir, args.apply, stats);
    await importTipoDoc(prisma, dir, args.apply, stats);

    // ── Relatório ─────────────────────────────────────────────────────
    console.log("\n  Resultado por tabela:");
    console.log(`    ${"tabela".padEnd(30)} ${"inseridos".padStart(10)} ${"actualiz.".padStart(10)} ${"iguais".padStart(9)} ${"ignorados".padStart(10)}`);
    for (const [name, c] of Object.entries(stats)) {
      console.log(
        `    ${name.padEnd(30)} ${fmt(c.inserted).padStart(10)} ${fmt(c.updated).padStart(10)} ${fmt(c.unchanged).padStart(9)} ${fmt(c.skipped).padStart(10)}`,
      );
    }

    // ── Validação pós-import ──────────────────────────────────────────
    if (args.apply) {
      console.log("\n  Validação pós-import:");
      const problems = await validateCounts(prisma, dir, manifest);
      if (problems.length === 0) {
        console.log("    ✓ todas as chaves do bundle existem no destino");
      } else {
        for (const p of problems) console.log(`    ✗ ${p}`);
        throw new CatalogToolError("Validação pós-import falhou — ver linhas acima.");
      }
      console.log("\n✓ Import concluído. Corre `npm run catalog:audit` para o relatório de cobertura.");
    } else {
      console.log("\n(dry-run — nada foi escrito. Repete com --apply.)");
    }
  } finally {
    await prisma.$disconnect().catch(() => {});
    await closeControl();
  }
}

// ─────────────────────────────────────────────────────────────────────
// Pré-voo
// ─────────────────────────────────────────────────────────────────────

async function preflightDependencies(dir: string, manifest: CatalogManifest): Promise<void> {
  const classIds = new Set<string>();
  const fabIds = new Set<string>();
  const produtoIds = new Set<string>();

  for await (const c of readNdjson<ClassificacaoRow>(file(dir, "classificacao"))) classIds.add(c.id);
  for await (const f of readNdjson<FabricanteRow>(file(dir, "fabricante"))) fabIds.add(f.id);

  const missing: string[] = [];
  let checkedProdutos = 0;

  for await (const p of readNdjson<ProdutoRow>(file(dir, "produto"))) {
    checkedProdutos += 1;
    produtoIds.add(p.id);
    if (p.fabricanteId && !fabIds.has(p.fabricanteId)) {
      missing.push(`Produto cnp=${p.cnp} → Fabricante ${p.fabricanteId} ausente do bundle`);
    }
    if (p.classificacaoNivel1Id && !classIds.has(p.classificacaoNivel1Id)) {
      missing.push(`Produto cnp=${p.cnp} → Classificacao N1 ${p.classificacaoNivel1Id} ausente do bundle`);
    }
    if (p.classificacaoNivel2Id && !classIds.has(p.classificacaoNivel2Id)) {
      missing.push(`Produto cnp=${p.cnp} → Classificacao N2 ${p.classificacaoNivel2Id} ausente do bundle`);
    }
    if (missing.length > 20) break;
  }

  for await (const a of readNdjson<AliasRow>(file(dir, "fabricanteAlias"))) {
    if (!fabIds.has(a.fabricanteId)) {
      missing.push(`FabricanteAlias "${a.aliasNome}" → Fabricante ${a.fabricanteId} ausente do bundle`);
      if (missing.length > 20) break;
    }
  }

  const declared = manifest.tables.find((t) => t.table === "produto")?.rows ?? 0;
  if (declared !== checkedProdutos) {
    missing.push(`produto.ndjson tem ${checkedProdutos} linhas mas o manifest declara ${declared}`);
  }

  if (missing.length > 0) {
    throw new CatalogToolError(
      `Dependências em falta no bundle (${missing.length}${missing.length > 20 ? "+" : ""}):\n` +
        missing.slice(0, 20).map((m) => `  · ${m}`).join("\n") +
        `\n\nO bundle está incompleto — reexporta com o mesmo --filter e sem --limit.`,
    );
  }
}

function file(dir: string, table: keyof typeof TABLE_SPECS): string {
  return path.join(dir, "data", TABLE_SPECS[table].file);
}

// ─────────────────────────────────────────────────────────────────────
// Importadores
// ─────────────────────────────────────────────────────────────────────

async function importClassificacoes(
  prisma: PrismaClient,
  dir: string,
  apply: boolean,
  stats: Stats,
): Promise<Map<string, string>> {
  const c = zero();
  const rows: ClassificacaoRow[] = [];
  for await (const r of readNdjson<ClassificacaoRow>(file(dir, "classificacao"))) rows.push(r);

  const depth = classificacaoDepth(rows);
  rows.sort((a, b) => (depth.get(a.id) ?? 0) - (depth.get(b.id) ?? 0) || a.id.localeCompare(b.id));

  const existing = await prisma.classificacao.findMany({
    select: { id: true, nome: true, tipo: true, classificacaoPaiId: true },
  });
  const byNatural = new Map<string, string>();
  const takenIds = new Set<string>();
  for (const e of existing) {
    byNatural.set(naturalKeyClass(e.nome, e.tipo, e.classificacaoPaiId), e.id);
    takenIds.add(e.id);
  }

  const idMap = new Map<string, string>();

  for (const row of rows) {
    const paiTarget = row.classificacaoPaiId ? idMap.get(row.classificacaoPaiId) ?? null : null;
    if (row.classificacaoPaiId && !paiTarget) {
      // Não deveria acontecer (ordenado por profundidade) — falha claro.
      throw new CatalogToolError(
        `Classificacao "${row.nome}" refere pai ${row.classificacaoPaiId} que ainda não foi importado. Bundle inconsistente.`,
      );
    }
    const key = naturalKeyClass(row.nome, row.tipo, paiTarget);
    const hit = byNatural.get(key);
    if (hit) {
      idMap.set(row.id, hit);
      c.unchanged += 1;
      continue;
    }
    const newId = takenIds.has(row.id) ? undefined : row.id;
    if (apply) {
      const created = await prisma.classificacao.create({
        data: {
          ...(newId ? { id: newId } : {}),
          nome: row.nome,
          tipo: row.tipo as never,
          classificacaoPaiId: paiTarget,
          estado: row.estado as never,
          ordem: row.ordem,
          ...(row.dataCriacao ? { dataCriacao: new Date(row.dataCriacao) } : {}),
        },
        select: { id: true },
      });
      idMap.set(row.id, created.id);
      byNatural.set(key, created.id);
      takenIds.add(created.id);
    } else {
      idMap.set(row.id, newId ?? `(novo:${row.nome})`);
      byNatural.set(key, newId ?? row.id);
    }
    c.inserted += 1;
  }

  stats["Classificacao"] = c;
  return idMap;
}

// `naturalKeyClass` vive em ./_shared.ts — partilhada com os testes.

async function importFabricantes(
  prisma: PrismaClient,
  dir: string,
  apply: boolean,
  stats: Stats,
): Promise<Map<string, string>> {
  const c = zero();
  const existing = await prisma.fabricante.findMany({
    select: { id: true, nomeNormalizado: true, paisOrigem: true },
  });
  const byName = new Map(existing.map((e) => [e.nomeNormalizado.toLowerCase(), e]));
  const takenIds = new Set(existing.map((e) => e.id));
  const idMap = new Map<string, string>();

  for await (const row of readNdjson<FabricanteRow>(file(dir, "fabricante"))) {
    const hit = byName.get(row.nomeNormalizado.toLowerCase());
    if (hit) {
      idMap.set(row.id, hit.id);
      // País de origem: preenche se o destino não tiver.
      if (row.paisOrigem && !hit.paisOrigem) {
        if (apply) {
          await prisma.fabricante.update({ where: { id: hit.id }, data: { paisOrigem: row.paisOrigem } });
        }
        c.updated += 1;
      } else {
        c.unchanged += 1;
      }
      continue;
    }
    const newId = takenIds.has(row.id) ? undefined : row.id;
    if (apply) {
      const created = await prisma.fabricante.create({
        data: {
          ...(newId ? { id: newId } : {}),
          nomeNormalizado: row.nomeNormalizado,
          paisOrigem: row.paisOrigem,
          estado: row.estado as never,
          ...(row.dataCriacao ? { dataCriacao: new Date(row.dataCriacao) } : {}),
        },
        select: { id: true },
      });
      idMap.set(row.id, created.id);
      byName.set(row.nomeNormalizado.toLowerCase(), { id: created.id, nomeNormalizado: row.nomeNormalizado, paisOrigem: row.paisOrigem });
      takenIds.add(created.id);
    } else {
      idMap.set(row.id, newId ?? row.id);
      byName.set(row.nomeNormalizado.toLowerCase(), { id: row.id, nomeNormalizado: row.nomeNormalizado, paisOrigem: row.paisOrigem });
    }
    c.inserted += 1;
  }

  stats["Fabricante"] = c;
  return idMap;
}

async function importAliases(
  prisma: PrismaClient,
  dir: string,
  fabMap: Map<string, string>,
  apply: boolean,
  stats: Stats,
): Promise<void> {
  const c = zero();
  const existing = await prisma.fabricanteAlias.findMany({ select: { fabricanteId: true, aliasNome: true } });
  const seen = new Set(existing.map((e) => `${e.fabricanteId} ${e.aliasNome.toLowerCase()}`));

  for await (const row of readNdjson<AliasRow>(file(dir, "fabricanteAlias"))) {
    const fabricanteId = fabMap.get(row.fabricanteId);
    if (!fabricanteId) {
      c.skipped += 1;
      continue;
    }
    const key = `${fabricanteId} ${row.aliasNome.toLowerCase()}`;
    if (seen.has(key)) {
      c.unchanged += 1;
      continue;
    }
    if (apply) {
      await prisma.fabricanteAlias.create({ data: { fabricanteId, aliasNome: row.aliasNome } });
    }
    seen.add(key);
    c.inserted += 1;
  }

  stats["FabricanteAlias"] = c;
}

async function importProdutos(
  prisma: PrismaClient,
  dir: string,
  classMap: Map<string, string>,
  fabMap: Map<string, string>,
  apply: boolean,
  stats: Stats,
): Promise<void> {
  const c = zero();
  const weakNivel1Ids = await resolveWeakNivel1Ids(prisma);
  let batch: ProdutoRow[] = [];

  const flush = async () => {
    if (batch.length === 0) return;
    const cnps = batch.map((r) => r.cnp);
    const existing = await prisma.produto.findMany({
      where: { cnp: { in: cnps } },
    });
    const byCnp = new Map(existing.map((e) => [e.cnp, e as unknown as Record<string, unknown>]));
    const takenIds = new Set(existing.map((e) => e.id));

    for (const row of batch) {
      const remapped = remapProduto(row, classMap, fabMap);
      const target = byCnp.get(row.cnp);

      if (!target) {
        if (apply) {
          const { id, ...rest } = remapped;
          await prisma.produto.create({
            data: {
              ...(takenIds.has(id) ? {} : { id }),
              ...rest,
            } as never,
          });
        }
        c.inserted += 1;
        continue;
      }

      const patch = buildProdutoPatch(remapped, target, weakNivel1Ids);
      if (Object.keys(patch).length === 0) {
        c.unchanged += 1;
        continue;
      }
      if (apply) {
        await prisma.produto.update({ where: { cnp: row.cnp }, data: patch as never });
      }
      c.updated += 1;
    }
    batch = [];
  };

  for await (const row of readNdjson<ProdutoRow>(file(dir, "produto"))) {
    batch.push(row);
    if (batch.length >= BATCH) await flush();
  }
  await flush();

  stats["Produto"] = c;
}

/** IDs de Classificacao N1 considerados fallback fraco no destino. */
async function resolveWeakNivel1Ids(prisma: PrismaClient): Promise<Set<string>> {
  const rows = await prisma.classificacao.findMany({
    where: { tipo: "NIVEL_1" },
    select: { id: true, nome: true },
  });
  return new Set(rows.filter((r) => r.nome.trim().toLowerCase() === WEAK_NIVEL1).map((r) => r.id));
}

function remapProduto(
  row: ProdutoRow,
  classMap: Map<string, string>,
  fabMap: Map<string, string>,
): ProdutoRow {
  const out: ProdutoRow = { ...row };
  out.fabricanteId = row.fabricanteId ? fabMap.get(row.fabricanteId) ?? null : null;
  out.classificacaoNivel1Id = row.classificacaoNivel1Id ? classMap.get(row.classificacaoNivel1Id) ?? null : null;
  out.classificacaoNivel2Id = row.classificacaoNivel2Id ? classMap.get(row.classificacaoNivel2Id) ?? null : null;
  for (const f of PRODUTO_DATE_FIELDS) {
    const v = out[f];
    if (typeof v === "string") out[f] = new Date(v);
  }
  return out;
}

/**
 * Vocabulário de utilizações. Chave natural: `slug`.
 *
 * O slug é estável entre bases de propósito — é o que permite que uma
 * associação feita num tenant signifique o mesmo noutro. Um slug que já
 * exista no destino mantém o SEU id, e é esse id que as associações
 * passam a usar.
 */
async function importUtilizacoes(
  prisma: PrismaClient,
  dir: string,
  apply: boolean,
  stats: Stats,
): Promise<Map<string, string>> {
  const c = zero();
  /** slug → id NO DESTINO. */
  const porSlug = new Map<string, string>();

  const existentes = await prisma.utilizacao.findMany({ select: { id: true, slug: true } });
  for (const e of existentes) porSlug.set(e.slug, e.id);

  for await (const row of readNdjson<Record<string, unknown>>(file(dir, "utilizacao"))) {
    const slug = String(row.slug ?? "").trim();
    if (!slug) { c.skipped += 1; continue; }

    const jaExiste = porSlug.get(slug);
    if (jaExiste) {
      // O vocabulário do destino manda. Renomear nome/descrição a partir
      // do bundle não acrescenta nada e podia divergir de uma edição
      // local deliberada.
      c.unchanged += 1;
      continue;
    }
    if (apply) {
      const criada = await prisma.utilizacao.create({
        data: {
          id: typeof row.id === "string" ? row.id : undefined,
          slug,
          nome: String(row.nome ?? slug),
          descricao: (row.descricao as string | null) ?? null,
          grupo: (row.grupo as string | null) ?? null,
          ...(typeof row.ordem === "number" ? { ordem: row.ordem } : {}),
          ...(typeof row.descontinuada === "boolean" ? { descontinuada: row.descontinuada } : {}),
        } as never,
        select: { id: true },
      });
      porSlug.set(slug, criada.id);
    } else {
      porSlug.set(slug, `(dry-run:${slug})`);
    }
    c.inserted += 1;
  }

  stats["Utilizacao"] = c;
  return porSlug;
}

/**
 * Associações produto↔utilização.
 *
 * Chave natural (cnp, slug) — ids locais não sobrevivem à mudança de
 * base. As FKs são remapeadas: `cnp` → `Produto.id` do destino, `slug` →
 * `Utilizacao.id` do destino.
 *
 * PRECEDÊNCIA, a mesma do resto do catálogo:
 *   · produto `validadoManualmente` no destino — nem se toca;
 *   · associação MANUAL no destino — intocável, mesmo que o bundle traga
 *     confiança maior; uma decisão humana não perde para um número;
 *   · associação automática — só cede a confiança ESTRITAMENTE superior.
 */
async function importProdutoUtilizacoes(
  prisma: PrismaClient,
  dir: string,
  utilPorSlug: Map<string, string>,
  apply: boolean,
  stats: Stats,
): Promise<void> {
  const c = zero();

  const produtos = await prisma.produto.findMany({
    select: { id: true, cnp: true, validadoManualmente: true },
  });
  const produtoPorCnp = new Map(produtos.map((p) => [p.cnp, p]));

  const existentes = await prisma.produtoUtilizacao.findMany({
    select: { produtoId: true, utilizacaoId: true, fonte: true, confianca: true },
  });
  const actual = new Map(existentes.map((e) => [`${e.produtoId}::${e.utilizacaoId}`, e]));

  let batch: Array<Record<string, unknown>> = [];
  const flush = async () => {
    if (batch.length === 0) return;
    const toCreate: Array<Record<string, unknown>> = [];

    for (const row of batch) {
      const cnp = Number(row.cnp);
      const slug = String(row.slug ?? "");
      const produto = produtoPorCnp.get(cnp);
      const utilizacaoId = utilPorSlug.get(slug);

      // Sem produto no destino não há a quem associar; sem slug conhecido
      // a associação não significa nada. Nos dois casos: ignorar, não
      // criar o que falta.
      if (!produto || !utilizacaoId) { c.skipped += 1; continue; }
      if (produto.validadoManualmente) { c.skipped += 1; continue; }

      const chave = `${produto.id}::${utilizacaoId}`;
      const jaLa = actual.get(chave);
      const confiancaBundle = typeof row.confianca === "number" ? row.confianca : null;

      if (!jaLa) {
        toCreate.push({
          produtoId: produto.id,
          utilizacaoId,
          fonte: String(row.fonte ?? "IMPORT"),
          confianca: confiancaBundle,
        });
        c.inserted += 1;
        continue;
      }
      if (jaLa.fonte === "MANUAL") { c.skipped += 1; continue; }
      if (confiancaBundle == null || confiancaBundle <= (jaLa.confianca ?? 0)) {
        c.unchanged += 1;
        continue;
      }
      if (apply) {
        await prisma.produtoUtilizacao.update({
          where: { produtoId_utilizacaoId: { produtoId: produto.id, utilizacaoId } },
          data: { fonte: String(row.fonte ?? "IMPORT"), confianca: confiancaBundle },
        });
      }
      c.updated += 1;
    }

    if (apply && toCreate.length > 0) {
      await prisma.produtoUtilizacao.createMany({ data: toCreate as never, skipDuplicates: true });
    }
    batch = [];
  };

  for await (const row of readNdjson<Record<string, unknown>>(file(dir, "produtoUtilizacao"))) {
    batch.push(row);
    if (batch.length >= BATCH) await flush();
  }
  await flush();

  stats["ProdutoUtilizacao"] = c;
}

async function importRegulatoryRecords(
  prisma: PrismaClient,
  dir: string,
  apply: boolean,
  stats: Stats,
): Promise<void> {
  const c = zero();
  const FIELDS = [
    "designacaoOficial",
    "dci",
    "codigoATC",
    "formaFarmaceutica",
    "dosagem",
    "embalagem",
    "grupoTerapeutico",
    "titularAim",
    "estadoAim",
  ] as const;

  let batch: Array<Record<string, unknown>> = [];
  const flush = async () => {
    if (batch.length === 0) return;
    const cnps = batch.map((r) => Number(r.cnp));
    const existing = await prisma.regulatoryRecord.findMany({ where: { cnp: { in: cnps } } });
    const byCnp = new Map(existing.map((e) => [e.cnp, e as unknown as Record<string, unknown>]));
    const toCreate: Array<Record<string, unknown>> = [];

    for (const row of batch) {
      const target = byCnp.get(Number(row.cnp));
      if (!target) {
        toCreate.push({
          cnp: Number(row.cnp),
          ...Object.fromEntries(FIELDS.map((f) => [f, row[f] ?? null])),
          source: String(row.source ?? "catalog-master"),
          ...(typeof row.importedAt === "string" ? { importedAt: new Date(row.importedAt) } : {}),
        });
        c.inserted += 1;
        continue;
      }
      const patch: Record<string, unknown> = {};
      for (const f of FIELDS) {
        // Preserve-non-null: só preenche buracos, nunca sobrepõe.
        if (row[f] != null && target[f] == null) patch[f] = row[f];
      }
      if (Object.keys(patch).length === 0) {
        c.unchanged += 1;
        continue;
      }
      if (apply) {
        await prisma.regulatoryRecord.update({ where: { cnp: Number(row.cnp) }, data: patch as never });
      }
      c.updated += 1;
    }

    if (apply && toCreate.length > 0) {
      await prisma.regulatoryRecord.createMany({ data: toCreate as never, skipDuplicates: true });
    }
    batch = [];
  };

  for await (const row of readNdjson<Record<string, unknown>>(file(dir, "regulatoryRecord"))) {
    batch.push(row);
    if (batch.length >= BATCH) await flush();
  }
  await flush();

  stats["RegulatoryRecord"] = c;
}

async function importInfarmedSnapshots(
  prisma: PrismaClient,
  dir: string,
  apply: boolean,
  stats: Stats,
): Promise<void> {
  const c = zero();
  let batch: Array<Record<string, unknown>> = [];

  const flush = async () => {
    if (batch.length === 0) return;
    const cnps = batch.map((r) => Number(r.cnp));
    const existing = await prisma.infarmedSnapshot.findMany({
      where: { cnp: { in: cnps } },
      select: { cnp: true },
    });
    const seen = new Set(existing.map((e) => e.cnp));
    const toCreate = batch
      .filter((r) => !seen.has(Number(r.cnp)))
      .map((r) => ({
        ...r,
        cnp: Number(r.cnp),
        importedAt: typeof r.importedAt === "string" ? new Date(r.importedAt) : undefined,
      }));
    c.inserted += toCreate.length;
    c.unchanged += batch.length - toCreate.length;
    if (apply && toCreate.length > 0) {
      await prisma.infarmedSnapshot.createMany({ data: toCreate as never, skipDuplicates: true });
    }
    batch = [];
  };

  for await (const row of readNdjson<Record<string, unknown>>(file(dir, "infarmedSnapshot"))) {
    batch.push(row);
    if (batch.length >= BATCH) await flush();
  }
  await flush();

  stats["InfarmedSnapshot"] = c;
}

async function importHistorico(
  prisma: PrismaClient,
  dir: string,
  apply: boolean,
  stats: Stats,
): Promise<void> {
  const c = zero();
  const filePath = file(dir, "produtoVerificacaoHistorico");
  let batch: Array<Record<string, unknown>> = [];

  const flush = async () => {
    if (batch.length === 0) return;
    const ids = batch.map((r) => String(r.id));
    const produtoIds = [...new Set(batch.map((r) => String(r.produtoId)))];
    const [existing, produtos] = await Promise.all([
      prisma.produtoVerificacaoHistorico.findMany({ where: { id: { in: ids } }, select: { id: true } }),
      prisma.produto.findMany({ where: { id: { in: produtoIds } }, select: { id: true } }),
    ]);
    const seen = new Set(existing.map((e) => e.id));
    const known = new Set(produtos.map((p) => p.id));
    const toCreate: Array<Record<string, unknown>> = [];
    for (const row of batch) {
      if (seen.has(String(row.id))) {
        c.unchanged += 1;
        continue;
      }
      if (!known.has(String(row.produtoId))) {
        // O produto não veio no bundle (ex.: --filter enriched cortou-o).
        c.skipped += 1;
        continue;
      }
      toCreate.push({
        ...row,
        verificadoEm: typeof row.verificadoEm === "string" ? new Date(row.verificadoEm) : undefined,
      });
      c.inserted += 1;
    }
    if (apply && toCreate.length > 0) {
      await prisma.produtoVerificacaoHistorico.createMany({ data: toCreate as never, skipDuplicates: true });
    }
    batch = [];
  };

  for await (const row of readNdjson<Record<string, unknown>>(filePath)) {
    batch.push(row);
    if (batch.length >= BATCH) await flush();
  }
  await flush();

  stats["ProdutoVerificacaoHistorico"] = c;
}

async function importTipoDoc(
  prisma: PrismaClient,
  dir: string,
  apply: boolean,
  stats: Stats,
): Promise<void> {
  const c = zero();
  for await (const row of readNdjson<Record<string, unknown>>(file(dir, "tipoDocumentoClassificacao"))) {
    const tipoDocumento = Number(row.tipoDocumento);
    const existing = await prisma.tipoDocumentoClassificacao.findUnique({ where: { tipoDocumento } });
    if (existing) {
      c.unchanged += 1;
      continue;
    }
    if (apply) {
      await prisma.tipoDocumentoClassificacao.create({
        data: {
          tipoDocumento,
          classe: String(row.classe),
          descricao: row.descricao == null ? null : String(row.descricao),
          notas: row.notas == null ? null : String(row.notas),
          classifiedBy: row.classifiedBy == null ? null : String(row.classifiedBy),
        },
      });
    }
    c.inserted += 1;
  }
  stats["TipoDocumentoClassificacao"] = c;
}

// ─────────────────────────────────────────────────────────────────────
// Validação pós-import
// ─────────────────────────────────────────────────────────────────────

async function validateCounts(
  prisma: PrismaClient,
  dir: string,
  manifest: CatalogManifest,
): Promise<string[]> {
  const problems: string[] = [];

  const declared = (table: string) => manifest.tables.find((t) => t.table === table)?.rows ?? 0;

  // Produto: todos os CNPs do bundle têm de existir no destino.
  const cnps: number[] = [];
  for await (const p of readNdjson<{ cnp: number }>(file(dir, "produto"))) cnps.push(p.cnp);
  let found = 0;
  for (const batch of chunk(cnps, 5000)) {
    found += await prisma.produto.count({ where: { cnp: { in: batch } } });
  }
  console.log(`    Produto           : ${fmt(found)}/${fmt(cnps.length)} CNPs presentes`);
  if (found !== cnps.length) {
    problems.push(`Produto: faltam ${fmt(cnps.length - found)} CNPs no destino.`);
  }

  // RegulatoryRecord
  const rrCnps: number[] = [];
  for await (const r of readNdjson<{ cnp: number }>(file(dir, "regulatoryRecord"))) rrCnps.push(r.cnp);
  if (rrCnps.length > 0) {
    let rrFound = 0;
    for (const batch of chunk(rrCnps, 5000)) {
      rrFound += await prisma.regulatoryRecord.count({ where: { cnp: { in: batch } } });
    }
    console.log(`    RegulatoryRecord  : ${fmt(rrFound)}/${fmt(rrCnps.length)} CNPs presentes`);
    if (rrFound !== rrCnps.length) {
      problems.push(`RegulatoryRecord: faltam ${fmt(rrCnps.length - rrFound)} CNPs no destino.`);
    }
  }

  // Fabricante / Classificacao: contagem mínima
  const [fabCount, classCount] = await Promise.all([
    prisma.fabricante.count(),
    prisma.classificacao.count(),
  ]);
  console.log(`    Fabricante        : ${fmt(fabCount)} no destino (bundle: ${fmt(declared("fabricante"))})`);
  console.log(`    Classificacao     : ${fmt(classCount)} no destino (bundle: ${fmt(declared("classificacao"))})`);
  if (fabCount < declared("fabricante")) {
    problems.push(`Fabricante: destino tem menos linhas (${fabCount}) do que o bundle (${declared("fabricante")}).`);
  }

  // Referências órfãs criadas pelo import (não deveria haver — FKs activas).
  const orfaos = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT COUNT(*)::bigint AS n FROM "Produto" p
    LEFT JOIN "Fabricante" f ON f.id = p."fabricanteId"
    WHERE p."fabricanteId" IS NOT NULL AND f.id IS NULL
  `;
  if (Number(orfaos[0]?.n ?? 0) > 0) {
    problems.push(`Produto: ${orfaos[0].n} linhas com fabricanteId órfão.`);
  }

  return problems;
}

main().catch(async (err) => {
  await closeControl();
  if (err instanceof CatalogToolError) {
    console.error(`\n✗ ${err.message}`);
    process.exit(1);
  }
  console.error("\n✗ Falha inesperada no import:", err);
  process.exit(1);
});
