/**
 * scripts/copy-enriched-catalog-to-tenant.ts
 *
 * Propaga o catálogo ENRIQUECIDO (dci, codigoATC, fabricante,
 * classificação N1/N2, productType, utilizações) de uma base FONTE para a base de um
 * TENANT, com match por `Produto.cnp`. BD → BD, sem lookups web.
 *
 *   Fonte  : legacy DATABASE_URL (default) ou --source-tenant <slug>
 *   Destino: --tenant <slug>  (resolvido via control plane)
 *
 * REGRAS (additive, nunca destrutivo):
 *   1. NUNCA sobrescreve um campo já preenchido no destino — só preenche
 *      NULLs (preserva qualquer trabalho existente).
 *   2. NUNCA toca em produtos com `validadoManualmente=true` no destino.
 *   3. Só copia de produtos-fonte de CONFIANÇA: validadoManualmente=true
 *      OU verificationStatus ∈ {VERIFIED, PARTIALLY_VERIFIED}. Produtos
 *      PENDING (não enriquecidos) na fonte são ignorados → nunca propaga
 *      dados fracos sobre nada.
 *   4. "Outros Medicamentos" (Nivel1) é fallback fraco: NÃO é propagado
 *      (deixa o destino a NULL para uma classificação melhor no futuro).
 *   5. FKs (fabricante, classificação) resolvidas por NOME e criadas no
 *      destino se faltarem (upsert idempotente por chave canónica).
 *   6. Provenance: classificationSource/verificationStatus/lastVerifiedAt
 *      copiados quando se copia enriquecimento (só se o destino estava
 *      PENDING) para refletir a origem.
 *   7. UTILIZAÇÕES: propagadas com a mesma doutrina — MANUAL no destino é
 *      intocável, automática só cede a confiança ESTRITAMENTE superior, e
 *      um slug que o destino não tenha no vocabulário NÃO é criado aqui
 *      (corre-se `catalog:seed-utilizacoes` primeiro).
 *
 * Idempotente: re-run não muda nada (os campos já ficaram preenchidos).
 * DRY-RUN por defeito. `--apply` para escrever.
 *
 * Uso:
 *   npx tsx scripts/copy-enriched-catalog-to-tenant.ts --tenant grupo-silveira
 *   npx tsx scripts/copy-enriched-catalog-to-tenant.ts --tenant grupo-silveira --apply
 *   npx tsx scripts/copy-enriched-catalog-to-tenant.ts --tenant grupo-silveira --source-tenant demo-neon
 */

import "dotenv/config";
import { parseArgs } from "node:util";
import {
  controlPrisma,
  getTenantBySlug,
  buildTenantConnectionString,
} from "@/lib/control-plane";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const STRONG = new Set(["VERIFIED", "PARTIALLY_VERIFIED"]);
const OUTROS = "outros medicamentos";

type SourceProduto = {
  cnp: number;
  dci: string | null;
  codigoATC: string | null;
  productType: string | null;
  productTypeConfidence: number | null;
  classificationSource: string | null;
  classificationVersion: string | null;
  verificationStatus: string;
  validadoManualmente: boolean;
  lastVerifiedAt: Date | null;
  fabricante: { nomeNormalizado: string } | null;
  classificacaoNivel1: { nome: string; tipo: string } | null;
  classificacaoNivel2: { nome: string; tipo: string } | null;
};

async function main() {
  const { values } = parseArgs({
    options: {
      tenant: { type: "string" },
      "source-tenant": { type: "string" },
      apply: { type: "boolean", default: false },
      limit: { type: "string" },
    },
    strict: true,
  });
  if (!values.tenant) {
    console.error("✗ --tenant <slug> (destino) é obrigatório.");
    process.exit(1);
  }
  const apply = values.apply ?? false;
  const limit = values.limit ? parseInt(values.limit, 10) : undefined;

  const tgtTenant = await getTenantBySlug(values.tenant);
  if (!tgtTenant) {
    console.error(`✗ Tenant destino "${values.tenant}" não existe.`);
    process.exit(1);
  }
  if (tgtTenant.estado !== "ACTIVE") {
    console.error(`✗ Tenant "${values.tenant}" em estado ${tgtTenant.estado}.`);
    process.exit(1);
  }

  let sourceUrl: string;
  let sourceLabel: string;
  if (values["source-tenant"]) {
    const s = await getTenantBySlug(values["source-tenant"]);
    if (!s) { console.error(`✗ Source tenant "${values["source-tenant"]}" não existe.`); process.exit(1); }
    sourceUrl = buildTenantConnectionString(s);
    sourceLabel = `tenant:${s.slug}`;
  } else {
    if (!process.env.DATABASE_URL) { console.error("✗ DATABASE_URL (fonte legacy) em falta."); process.exit(1); }
    sourceUrl = process.env.DATABASE_URL;
    sourceLabel = "legacy (DATABASE_URL)";
  }

  const src = new PrismaClient({ adapter: new PrismaPg({ connectionString: sourceUrl }) });
  const tgt = new PrismaClient({ adapter: new PrismaPg({ connectionString: buildTenantConnectionString(tgtTenant) }) });

  console.log("─".repeat(70));
  console.log(`copy-enriched-catalog — ${sourceLabel} → tenant:${tgtTenant.slug} (${apply ? "APPLY" : "DRY-RUN"})`);
  console.log("─".repeat(70));

  // Caches FK no destino (nome → id), preenchidos lazy (upsert só em --apply).
  const fabCache = new Map<string, string>();
  const classCache = new Map<string, string>(); // key: `${tipo}|${paiId ?? "-"}|${nome}`

  async function resolveFabricante(nome: string): Promise<string | null> {
    const key = nome.trim();
    if (!key) return null;
    if (fabCache.has(key)) return fabCache.get(key)!;
    if (!apply) { fabCache.set(key, "DRY"); return "DRY"; }
    const f = await tgt.fabricante.upsert({
      where: { nomeNormalizado: key },
      create: { nomeNormalizado: key },
      update: {},
      select: { id: true },
    });
    fabCache.set(key, f.id);
    return f.id;
  }

  async function resolveClassificacao(nome: string, tipo: string, paiId: string | null): Promise<string | null> {
    const key = `${tipo}|${paiId ?? "-"}|${nome}`;
    if (classCache.has(key)) return classCache.get(key)!;
    if (!apply) { classCache.set(key, "DRY"); return "DRY"; }
    // @@unique([nome, tipo, classificacaoPaiId])
    const existing = await tgt.classificacao.findFirst({
      where: { nome, tipo: tipo as never, classificacaoPaiId: paiId },
      select: { id: true },
    });
    let id: string;
    if (existing) id = existing.id;
    else {
      const c = await tgt.classificacao.create({
        data: { nome, tipo: tipo as never, classificacaoPaiId: paiId },
        select: { id: true },
      });
      id = c.id;
    }
    classCache.set(key, id);
    return id;
  }

  // 1) CNPs do destino (id + estado actual dos campos).
  const tgtRows = await tgt.produto.findMany({
    select: {
      id: true, cnp: true, dci: true, codigoATC: true, productType: true,
      fabricanteId: true, classificacaoNivel1Id: true, classificacaoNivel2Id: true,
      validadoManualmente: true, verificationStatus: true,
    },
  });
  const tgtByCnp = new Map(tgtRows.map((r) => [r.cnp, r]));
  console.log(`Destino: ${tgtRows.length} produtos.`);

  // 2) Stream fonte por chunks dos CNPs do destino.
  const cnps = [...tgtByCnp.keys()];
  const counts = {
    sourcePresent: 0, sourceTrusted: 0, productsTouched: 0,
    dci: 0, codigoATC: 0, fabricante: 0, nivel1: 0, nivel2: 0, productType: 0,
    skippedManual: 0, skippedOutros: 0,
    utilEscritas: 0, utilInalteradas: 0, utilSkippedManual: 0, utilSemVocabulario: 0,
  };
  let touchedBudget = limit ?? Infinity;

  const CH = 2000;
  for (let i = 0; i < cnps.length && touchedBudget > 0; i += CH) {
    const chunk = cnps.slice(i, i + CH);
    const sources = (await src.produto.findMany({
      where: { cnp: { in: chunk } },
      select: {
        cnp: true, dci: true, codigoATC: true, productType: true, productTypeConfidence: true,
        classificationSource: true, classificationVersion: true, verificationStatus: true,
        validadoManualmente: true, lastVerifiedAt: true,
        fabricante: { select: { nomeNormalizado: true } },
        classificacaoNivel1: { select: { nome: true, tipo: true } },
        classificacaoNivel2: { select: { nome: true, tipo: true } },
      },
    })) as unknown as SourceProduto[];

    for (const s of sources) {
      if (touchedBudget <= 0) break;
      counts.sourcePresent++;
      const trusted = s.validadoManualmente || STRONG.has(s.verificationStatus);
      if (!trusted) continue;
      counts.sourceTrusted++;

      const t = tgtByCnp.get(s.cnp);
      if (!t) continue;
      if (t.validadoManualmente) { counts.skippedManual++; continue; }

      const update: Record<string, unknown> = {};
      let copiedClass = false;

      if (t.dci == null && s.dci) { update.dci = s.dci; counts.dci++; }
      if (t.codigoATC == null && s.codigoATC) { update.codigoATC = s.codigoATC; counts.codigoATC++; }
      if (t.productType == null && s.productType) {
        update.productType = s.productType;
        if (s.productTypeConfidence != null) update.productTypeConfidence = s.productTypeConfidence;
        counts.productType++;
      }
      if (t.fabricanteId == null && s.fabricante?.nomeNormalizado) {
        const fid = await resolveFabricante(s.fabricante.nomeNormalizado);
        if (fid) { update.fabricanteId = fid; counts.fabricante++; }
      }
      if (t.classificacaoNivel1Id == null && s.classificacaoNivel1) {
        if (s.classificacaoNivel1.nome.trim().toLowerCase() === OUTROS) {
          counts.skippedOutros++;
        } else {
          const n1 = await resolveClassificacao(s.classificacaoNivel1.nome, s.classificacaoNivel1.tipo, null);
          if (n1) {
            update.classificacaoNivel1Id = n1; counts.nivel1++; copiedClass = true;
            if (s.classificacaoNivel2) {
              const n2 = await resolveClassificacao(s.classificacaoNivel2.nome, s.classificacaoNivel2.tipo, n1 === "DRY" ? null : n1);
              if (n2) { update.classificacaoNivel2Id = n2; counts.nivel2++; }
            }
          }
        }
      }

      if (Object.keys(update).length === 0) continue;

      // Provenance — só quando o destino estava PENDING.
      if (t.verificationStatus === "PENDING") {
        update.verificationStatus = s.verificationStatus;
        if (s.classificationSource) update.classificationSource = s.classificationSource;
        if (s.classificationVersion) update.classificationVersion = s.classificationVersion;
        if (s.lastVerifiedAt) update.lastVerifiedAt = s.lastVerifiedAt;
      }

      counts.productsTouched++;
      touchedBudget--;
      if (apply) {
        // remover sentinelas DRY (não devem existir em apply)
        await tgt.produto.update({ where: { id: t.id }, data: update as never });
      }
    }
  }

  // ── 3) Utilizações ─────────────────────────────────────────────────
  //
  // "Para que serve este produto" é verdade sobre o PRODUTO, e faltava
  // aqui: a propagação levava classificação, ATC e fabricante e deixava
  // as utilizações para trás.
  //
  // Precedência, a mesma do resto:
  //   · produto validadoManualmente no destino — nem se toca;
  //   · associação MANUAL no destino — intocável, mesmo com confiança
  //     maior na fonte: uma decisão humana não perde para um número;
  //   · associação automática — só cede a confiança ESTRITAMENTE superior;
  //   · a fonte tem de ser de confiança, como para o resto.
  const slugPorIdDestino = new Map<string, string>();
  const idPorSlugDestino = new Map<string, string>();
  for (const u of await tgt.utilizacao.findMany({ select: { id: true, slug: true } })) {
    slugPorIdDestino.set(u.id, u.slug);
    idPorSlugDestino.set(u.slug, u.id);
  }

  for (let i = 0; i < cnps.length; i += CH) {
    const bloco = cnps.slice(i, i + CH);

    const fonteAssoc = (await src.produtoUtilizacao.findMany({
      where: {
        produto: {
          cnp: { in: bloco },
          OR: [
            { validadoManualmente: true },
            { verificationStatus: { in: [...STRONG] as never } },
          ],
        },
      },
      select: {
        fonte: true, confianca: true,
        produto: { select: { cnp: true } },
        utilizacao: { select: { slug: true } },
      },
    })) as unknown as Array<{
      fonte: string; confianca: number | null;
      produto: { cnp: number }; utilizacao: { slug: string };
    }>;
    if (fonteAssoc.length === 0) continue;

    const destinoAssoc = await tgt.produtoUtilizacao.findMany({
      where: { produto: { cnp: { in: bloco } } },
      select: { produtoId: true, utilizacaoId: true, fonte: true, confianca: true },
    });
    const jaLa = new Map(destinoAssoc.map((a) => [`${a.produtoId}::${a.utilizacaoId}`, a]));

    for (const a of fonteAssoc) {
      const t = tgtByCnp.get(a.produto.cnp);
      if (!t) continue;
      if (t.validadoManualmente) { counts.utilSkippedManual++; continue; }

      const utilizacaoId = idPorSlugDestino.get(a.utilizacao.slug);
      // Vocabulário fechado: um slug que o destino não tem não é criado
      // aqui. Corre-se `catalog:seed-utilizacoes` primeiro.
      if (!utilizacaoId) { counts.utilSemVocabulario++; continue; }

      const existente = jaLa.get(`${t.id}::${utilizacaoId}`);
      if (existente?.fonte === "MANUAL") { counts.utilSkippedManual++; continue; }

      const conf = a.confianca;
      if (existente && (conf == null || conf <= (existente.confianca ?? 0))) {
        counts.utilInalteradas++;
        continue;
      }

      counts.utilEscritas++;
      if (!apply) continue;
      await tgt.produtoUtilizacao.upsert({
        where: { produtoId_utilizacaoId: { produtoId: t.id, utilizacaoId } },
        create: { produtoId: t.id, utilizacaoId, fonte: a.fonte, confianca: conf },
        update: { fonte: a.fonte, confianca: conf },
      });
    }
  }

  console.log("");
  console.log("Counts:");
  console.log(`  CNPs do destino presentes na fonte : ${counts.sourcePresent}`);
  console.log(`  …de confiança (VERIFIED|PARTIAL|manual): ${counts.sourceTrusted}`);
  console.log(`  produtos a enriquecer (≥1 campo)   : ${counts.productsTouched}`);
  console.log("  por campo (NULLs preenchidos):");
  console.log(`    dci                 : ${counts.dci}`);
  console.log(`    codigoATC           : ${counts.codigoATC}`);
  console.log(`    fabricante          : ${counts.fabricante}`);
  console.log(`    classificacaoNivel1 : ${counts.nivel1}`);
  console.log(`    classificacaoNivel2 : ${counts.nivel2}`);
  console.log(`    productType         : ${counts.productType}`);
  console.log(`  saltados (validadoManualmente)     : ${counts.skippedManual}`);
  console.log(`  saltados (Nivel1 "Outros Medicamentos"): ${counts.skippedOutros}`);
  console.log("  utilizações:");
  console.log(`    escritas            : ${counts.utilEscritas}`);
  console.log(`    inalteradas         : ${counts.utilInalteradas}`);
  console.log(`    saltadas (MANUAL)   : ${counts.utilSkippedManual}`);
  console.log(`    slug sem vocabulário: ${counts.utilSemVocabulario}`);
  console.log("");
  if (!apply) {
    console.log("DRY-RUN — nada escrito. Re-corre com --apply para aplicar.");
  } else {
    console.log(`✓ APPLY concluído — ${counts.productsTouched} produtos enriquecidos em ${tgtTenant.slug}.`);
  }

  await src.$disconnect();
  await tgt.$disconnect();
  await controlPrisma.$disconnect();
}

main().catch((err) => {
  console.error("[fatal]", err instanceof Error ? err.message : err);
  process.exit(1);
});
