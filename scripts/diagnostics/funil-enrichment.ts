/**
 * scripts/diagnostics/funil-enrichment.ts
 *
 * Diagnóstico READ-ONLY. Não escreve, não reclassifica, não corre
 * enrichment, não altera taxonomia.
 *
 * ══════════════════════════════════════════════════════════════════════
 * A PERGUNTA
 * ══════════════════════════════════════════════════════════════════════
 *
 * Na Silveirense, 24 % do catálogo não tem classificação analítica útil:
 * 3 348 em "Outros <X>" e 3 515 "Por Classificar". Investiu-se em
 * enriquecimento. Onde é que a informação se perde?
 *
 * Há cinco sítios possíveis, e são mutuamente exclusivos por produto:
 *
 *   A  nunca foi enriquecido        — não há linha em cache
 *   B  enrichment sem resposta útil — respondeu DESCONHECIDO / sem campos
 *   C  soube mas não persistiu      — `persistido=false` + `motivo`
 *   D  a taxonomia não tem casa     — sugeriu "Outros <X>"
 *   E  o mapper não soube usar      — havia ATC/DCI e mesmo assim caiu
 *
 * Distinguir C de B é o ponto todo deste ficheiro: um é dinheiro gasto
 * cujo resultado foi recusado por nós, o outro é dinheiro gasto que não
 * produziu nada. O schema foi feito para os separar — o comentário de
 * `KnowledgeEnrichmentCache.persistido` diz-o por palavras suas:
 * "distingue 'o modelo não soube' de 'o modelo soube e nós recusámos'".
 *
 * ══════════════════════════════════════════════════════════════════════
 * O QUE ESTE DIAGNÓSTICO NÃO PODE RESPONDER
 * ══════════════════════════════════════════════════════════════════════
 *
 * **Custo em euros.** Não existe no schema: nem tokens, nem preço, nem
 * contador de chamadas por corrida. `EnrichmentSourceLog` guarda
 * `durationMs` mas não consumo. O que se consegue medir é o NÚMERO de
 * decisões do modelo (linhas de cache com `origem='CLAUDE'`), que é o
 * numerador certo para um custo — mas o preço tem de vir de fora, da
 * consola de faturação.
 *
 * Dizê-lo é melhor do que multiplicar por uma estimativa e apresentar o
 * resultado como se fosse medido.
 *
 *   npx tsx scripts/diagnostics/funil-enrichment.ts --tenant=silveira
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "../../generated/prisma/client";
import { buildTenantConnectionString, getTenantBySlug } from "../../lib/control-plane";
import { AlvoRecusado, descreverAlvo, resolverAlvo } from "../../lib/catalog/target-db";
import {
  LIMIAR_CLINICO,
  LIMIAR_PERSISTENCIA,
} from "../../lib/catalog/knowledge-enrichment";
import { mapToCanonical } from "../../lib/catalog-taxonomy-map";
import type { ProductType } from "../../lib/catalog-types";

const linha = (t = "") => console.log(t);
const nf = (n: number) => n.toLocaleString("pt-PT");
const pct = (n: number, total: number) =>
  total > 0 ? `${((n / total) * 100).toFixed(1)}%` : "—";
const col = (n: number, total: number, w = 8) =>
  `${String(nf(n)).padStart(w)}  ${pct(n, total).padStart(6)}`;

function titulo(t: string) {
  linha("");
  linha("═".repeat(78));
  linha(t);
  linha("═".repeat(78));
}

const corta = (s: string | null, n: number) => {
  const v = (s ?? "").replace(/\s+/g, " ").trim();
  return v.length > n ? `${v.slice(0, n - 1)}…` : v.padEnd(n);
};

// ─────────────────────────────────────────────────────────────────────
type LinhaAudit = {
  produtoId: string;
  cnp: number;
  designacao: string;
  nivel1: string | null;
  nivel2: string | null;
  codigoATC: string | null;
  dci: string | null;
  productType: string | null;
  productTypeConfidence: number | null;
  fabricanteId: string | null;
  nUtilizacoes: number;
  // ── cache de enriquecimento (a melhor linha por CNP) ──────────────
  cacheExiste: boolean;
  cCategoria: string | null;
  cSubcategoria: string | null;
  cAtc: string | null;
  cDci: string | null;
  cConfidence: number | null;
  cConfidenceClinica: number | null;
  cEvidence: string | null;
  cPersistido: boolean | null;
  cMotivo: string | null;
  cOrigem: string | null;
  cUtilizacoes: number;
};

async function carregar(prisma: PrismaClient): Promise<LinhaAudit[]> {
  // A "melhor" linha de cache por CNP: a mais recente. Uma segunda
  // corrida sobre o mesmo produto deixa duas linhas, e contá-las ambas
  // faria o funil somar mais do que o catálogo.
  return prisma.$queryRaw<LinhaAudit[]>(Prisma.sql`
    SELECT
      p.id                      AS "produtoId",
      p.cnp                     AS cnp,
      p.designacao              AS designacao,
      c1.nome                   AS nivel1,
      c2.nome                   AS nivel2,
      p."codigoATC"             AS "codigoATC",
      p.dci                     AS dci,
      p."productType"           AS "productType",
      p."productTypeConfidence" AS "productTypeConfidence",
      p."fabricanteId"          AS "fabricanteId",
      COALESCE(u.n, 0)::int     AS "nUtilizacoes",
      (k.chave IS NOT NULL)     AS "cacheExiste",
      k.categoria               AS "cCategoria",
      k.subcategoria            AS "cSubcategoria",
      k."codigoATC"             AS "cAtc",
      k.dci                     AS "cDci",
      k.confidence              AS "cConfidence",
      k."confidenceClinica"     AS "cConfidenceClinica",
      k."evidenceType"          AS "cEvidence",
      k.persistido              AS "cPersistido",
      k.motivo                  AS "cMotivo",
      k.origem                  AS "cOrigem",
      COALESCE(array_length(k.utilizacoes, 1), 0)::int AS "cUtilizacoes"
    FROM "Produto" p
    LEFT JOIN "Classificacao" c1 ON c1.id = p."classificacaoNivel1Id"
    LEFT JOIN "Classificacao" c2 ON c2.id = p."classificacaoNivel2Id"
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS n FROM "ProdutoUtilizacao" pu WHERE pu."produtoId" = p.id
    ) u ON true
    LEFT JOIN LATERAL (
      SELECT *
      FROM "KnowledgeEnrichmentCache" kk
      WHERE kk.cnp = p.cnp
      ORDER BY kk."criadoEm" DESC
      LIMIT 1
    ) k ON true
  `);
}

const ehBalde = (n2: string | null) => !!n2 && /^outros\b/i.test(n2);
const semClassificacao = (r: LinhaAudit) => !r.nivel1 && !r.nivel2;

/** Onde é que ESTE produto perdeu a informação. Exclusivo e ordenado. */
type Causa = "A_NUNCA" | "B_SEM_RESPOSTA" | "C_NAO_PERSISTIU" | "D_TAXONOMIA" | "E_MAPPER";

function causaDe(r: LinhaAudit): Causa {
  if (!r.cacheExiste) return "A_NUNCA";
  // O modelo respondeu mas declarou não conhecer o produto.
  if (r.cEvidence === "DESCONHECIDO") return "B_SEM_RESPOSTA";
  // Trouxe alguma coisa e não foi escrita.
  const trouxe =
    !!r.cAtc || !!r.cDci || !!r.cSubcategoria || !!r.cCategoria || r.cUtilizacoes > 0;
  if (trouxe && r.cPersistido === false) return "C_NAO_PERSISTIU";
  // Sugeriu explicitamente o balde: a taxonomia não tem casa melhor.
  if (r.cSubcategoria && /^outros\b/i.test(r.cSubcategoria)) return "D_TAXONOMIA";
  // Persistiu ATC ou DCI e mesmo assim o produto está sem nível 2 útil.
  if ((r.codigoATC || r.dci) && (semClassificacao(r) || ehBalde(r.nivel2))) return "E_MAPPER";
  return "B_SEM_RESPOSTA";
}

const ROTULO_CAUSA: Record<Causa, string> = {
  A_NUNCA: "A · nunca enriquecido",
  B_SEM_RESPOSTA: "B · enrichment sem resposta útil",
  C_NAO_PERSISTIU: "C · trouxe informação, não persistiu",
  D_TAXONOMIA: "D · taxonomia sem categoria adequada",
  E_MAPPER: "E · mapper não usou a informação",
};

// ═════════════════════════════════════════════════════════════════════
async function principal() {
  linha("SPharm.MT · funil do enriquecimento · diagnóstico read-only");
  linha("");

  let alvo;
  try {
    alvo = await resolverAlvo(process.argv.slice(2), {
      getTenantBySlug,
      buildTenantConnectionString,
    });
  } catch (e) {
    if (e instanceof AlvoRecusado) {
      linha(`ERRO: ${e.message}`);
      linha("");
      linha("Uso: npx tsx scripts/diagnostics/funil-enrichment.ts --tenant=<slug>");
      process.exit(2);
    }
    throw e;
  }
  linha(`Alvo: ${descreverAlvo(alvo)}`);
  linha("");
  linha(`Limiares em vigor: persistência ${LIMIAR_PERSISTENCIA} · clínico ${LIMIAR_CLINICO}`);

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: alvo.url }) });

  try {
    const rows = await carregar(prisma);
    const total = rows.length;

    // ══════════════════════════════════════════════════════════════════
    titulo("PARTE 1 · O funil, do catálogo ao que ficou escrito");

    const comCache = rows.filter((r) => r.cacheExiste);
    const desconhecido = comCache.filter((r) => r.cEvidence === "DESCONHECIDO");
    const comResposta = comCache.filter((r) => r.cEvidence !== "DESCONHECIDO");
    const persistidos = comCache.filter((r) => r.cPersistido === true);
    const recusados = comCache.filter((r) => r.cPersistido === false);

    linha("");
    linha(`  produtos no catálogo ..................... ${col(total, total)}`);
    linha(`  · com linha em cache de enriquecimento ... ${col(comCache.length, total)}`);
    linha(`  · SEM linha nenhuma (nunca processados) .. ${col(total - comCache.length, total)}`);
    linha("");
    linha("  Dentro dos que passaram por lá:");
    linha(`  · o modelo declarou DESCONHECIDO ......... ${col(desconhecido.length, comCache.length)}`);
    linha(`  · deu resposta ........................... ${col(comResposta.length, comCache.length)}`);
    linha(`  · …e foi PERSISTIDA ...................... ${col(persistidos.length, comCache.length)}`);
    linha(`  · …e foi RECUSADA ........................ ${col(recusados.length, comCache.length)}`);

    // O que a cache TROUXE, campo a campo, e o que ficou escrito.
    const trouxe = {
      atc: comCache.filter((r) => !!r.cAtc).length,
      dci: comCache.filter((r) => !!r.cDci).length,
      categoria: comCache.filter((r) => !!r.cCategoria).length,
      subcategoria: comCache.filter((r) => !!r.cSubcategoria).length,
      subEspecifica: comCache.filter(
        (r) => !!r.cSubcategoria && !/^outros\b/i.test(r.cSubcategoria),
      ).length,
      utilizacoes: comCache.filter((r) => r.cUtilizacoes > 0).length,
    };
    const escrito = {
      atc: rows.filter((r) => !!r.codigoATC).length,
      dci: rows.filter((r) => !!r.dci).length,
      fabricante: rows.filter((r) => !!r.fabricanteId).length,
      utilizacoes: rows.filter((r) => r.nUtilizacoes > 0).length,
    };
    linha("");
    linha("  CAMPO             TROUXE DA IA        ESTÁ NO CATÁLOGO");
    linha("  " + "─".repeat(60));
    linha(`  ATC          ${col(trouxe.atc, comCache.length)}      ${col(escrito.atc, total)}`);
    linha(`  DCI          ${col(trouxe.dci, comCache.length)}      ${col(escrito.dci, total)}`);
    linha(`  utilizações  ${col(trouxe.utilizacoes, comCache.length)}      ${col(escrito.utilizacoes, total)}`);
    linha(`  categoria    ${col(trouxe.categoria, comCache.length)}      ${"(ver abaixo)".padStart(16)}`);
    linha(`  subcategoria ${col(trouxe.subcategoria, comCache.length)}`);
    linha(`   · específica${col(trouxe.subEspecifica, comCache.length)}`);
    linha(`  fabricante   ${"(não vem da IA)".padStart(16)}      ${col(escrito.fabricante, total)}`);

    // ── Porque é que foi recusada ────────────────────────────────────
    linha("");
    linha("  Motivos de recusa (os 12 mais frequentes):");
    const motivos = new Map<string, number>();
    for (const r of recusados) {
      // Normaliza o número dentro do motivo — "confiança 0.72 < 0.85" e
      // "confiança 0.61 < 0.85" são o MESMO motivo.
      const m = (r.cMotivo ?? "(sem motivo)").replace(/\d+[.,]\d+/g, "N");
      motivos.set(m, (motivos.get(m) ?? 0) + 1);
    }
    for (const [m, n] of Array.from(motivos.entries()).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
      linha(`    ${String(nf(n)).padStart(7)}  ${pct(n, recusados.length).padStart(6)}  ${corta(m, 52)}`);
    }

    // ══════════════════════════════════════════════════════════════════
    titulo("PARTE 2 · Onde estão os produtos hoje");

    const especificos = rows.filter((r) => r.nivel2 && !ehBalde(r.nivel2));
    const emBalde = rows.filter((r) => ehBalde(r.nivel2));
    const porClassificar = rows.filter(semClassificacao);
    const semN2 = rows.filter((r) => r.nivel1 && !r.nivel2);

    linha("");
    linha(`  com nível 2 específico ................... ${col(especificos.length, total)}`);
    linha(`  em "Outros <X>" .......................... ${col(emBalde.length, total)}`);
    linha(`  com nível 1 mas sem nível 2 .............. ${col(semN2.length, total)}`);
    linha(`  Por Classificar (sem nível nenhum) ....... ${col(porClassificar.length, total)}`);

    // Causa por grupo — é a tabela que responde "de quem é a culpa".
    const tabelaCausas = (nome: string, grupo: LinhaAudit[]) => {
      linha("");
      linha(`  ─── ${nome} (${nf(grupo.length)}) ───`);
      const c = new Map<Causa, number>();
      for (const r of grupo) c.set(causaDe(r), (c.get(causaDe(r)) ?? 0) + 1);
      for (const k of [
        "A_NUNCA",
        "B_SEM_RESPOSTA",
        "C_NAO_PERSISTIU",
        "D_TAXONOMIA",
        "E_MAPPER",
      ] as Causa[]) {
        linha(`    ${ROTULO_CAUSA[k].padEnd(40)} ${col(c.get(k) ?? 0, grupo.length)}`);
      }
    };
    tabelaCausas("Por Classificar", porClassificar);
    tabelaCausas('Em "Outros <X>"', emBalde);

    // ══════════════════════════════════════════════════════════════════
    titulo("PARTE 3 · Chamadas ao modelo (o custo, na parte que é medível)");

    const porOrigem = new Map<string, number>();
    for (const r of comCache) porOrigem.set(r.cOrigem ?? "(sem origem)", (porOrigem.get(r.cOrigem ?? "(sem origem)") ?? 0) + 1);
    const totalCache = await prisma.$queryRaw<Array<{ n: bigint }>>(
      Prisma.sql`SELECT COUNT(*)::bigint AS n FROM "KnowledgeEnrichmentCache"`,
    );
    const cnpsDistintos = await prisma.$queryRaw<Array<{ n: bigint }>>(
      Prisma.sql`SELECT COUNT(DISTINCT cnp)::bigint AS n FROM "KnowledgeEnrichmentCache"`,
    );
    const porVersao = await prisma.$queryRaw<Array<{ versao: string; modelo: string; n: bigint }>>(
      Prisma.sql`SELECT versao, modelo, COUNT(*)::bigint AS n
                 FROM "KnowledgeEnrichmentCache" GROUP BY 1,2 ORDER BY 3 DESC`,
    );

    linha("");
    linha(`  linhas de cache (todas as corridas) ...... ${nf(Number(totalCache[0]?.n ?? 0))}`);
    linha(`  CNP distintos processados ................ ${nf(Number(cnpsDistintos[0]?.n ?? 0))}`);
    linha("");
    linha("  Por origem da decisão:");
    for (const [o, n] of Array.from(porOrigem.entries()).sort((a, b) => b[1] - a[1])) {
      linha(`    ${o.padEnd(14)} ${col(n, comCache.length)}`);
    }
    linha("");
    linha("  Por versão do prompt e modelo:");
    for (const v of porVersao.slice(0, 10)) {
      linha(`    ${corta(v.versao, 12)} ${corta(v.modelo, 30)} ${String(nf(Number(v.n))).padStart(8)}`);
    }
    linha("");
    linha("  ATENÇÃO: não há tokens nem custo no schema. `origem='CLAUDE'` é o");
    linha("  número de decisões PAGAS; `PROPAGADO` foi reaproveitamento gratuito.");
    linha("  O preço por chamada tem de vir da consola de faturação — multiplicar");
    linha("  por uma estimativa aqui seria apresentar um palpite como medição.");

    const claude = porOrigem.get("CLAUDE") ?? 0;
    const melhorados = persistidos.length;
    linha("");
    linha(`  decisões pagas (CLAUDE) .................. ${nf(claude)}`);
    linha(`  produtos efectivamente melhorados ........ ${nf(melhorados)}`);
    linha(
      `  ⇒ ${claude > 0 ? (melhorados / claude).toFixed(2) : "—"} produtos melhorados por decisão paga`,
    );

    // ══════════════════════════════════════════════════════════════════
    titulo("PARTE 4 · Amostra dos Por Classificar (100)");

    // Amostra determinística e distribuída: uma em cada N, ordenada por
    // CNP. Os primeiros 100 por CNP seriam todos do mesmo laboratório.
    const passo = Math.max(1, Math.floor(porClassificar.length / 100));
    const amostra = porClassificar
      .slice()
      .sort((a, b) => a.cnp - b.cnp)
      .filter((_, i) => i % passo === 0)
      .slice(0, 100);

    for (const r of amostra) {
      const causa = causaDe(r);
      linha("");
      linha(`  CNP ${r.cnp}  ${corta(r.designacao, 50)}`);
      linha(
        `      tipo=${corta(r.productType, 16)}(${(r.productTypeConfidence ?? 0).toFixed(2)}) ` +
          `ATC=${corta(r.codigoATC, 8)} DCI=${corta(r.dci, 20)} util=${r.nUtilizacoes}`,
      );
      if (r.cacheExiste) {
        linha(
          `      IA: ${corta(r.cEvidence, 14)} conf=${(r.cConfidence ?? 0).toFixed(2)}` +
            ` clin=${r.cConfidenceClinica === null ? "—" : r.cConfidenceClinica.toFixed(2)}` +
            ` → ${corta(r.cCategoria, 20)} / ${corta(r.cSubcategoria, 24)}`,
        );
        linha(
          `      persistido=${r.cPersistido ? "SIM" : "NÃO"}  motivo: ${corta(r.cMotivo, 46)}`,
        );
      } else {
        linha("      IA: (nunca processado)");
      }
      linha(`      ⇒ ${ROTULO_CAUSA[causa]}`);
    }

    // ══════════════════════════════════════════════════════════════════
    titulo("PARTE 5 · Outros Medicamentos");

    const om = rows.filter((r) => r.nivel2 === "Outros Medicamentos");
    const omSemAtc = om.filter((r) => !r.codigoATC);
    const omNuncaEnriq = om.filter((r) => !r.cacheExiste);
    const omEnriqSemAtc = om.filter((r) => r.cacheExiste && !r.codigoATC);
    const omIaTinhaAtc = om.filter((r) => !r.codigoATC && !!r.cAtc);
    const omComDci = om.filter((r) => !r.codigoATC && !!r.dci);
    const omIaTinhaDci = om.filter((r) => !r.dci && !!r.cDci);

    // Quantos sairiam do balde HOJE, só com o que já lá está.
    let omRemapEspecifico = 0;
    for (const r of om) {
      if (!r.productType) continue;
      try {
        const novo = mapToCanonical({
          productType: r.productType as ProductType,
          productTypeConfidence: r.productTypeConfidence ?? 0.5,
          externalCategory: null,
          externalSubcategory: null,
          designacao: r.designacao,
          atc: r.codigoATC,
          dci: r.dci,
        });
        if (novo && !ehBalde(novo.nivel2)) omRemapEspecifico++;
      } catch {
        /* ignora */
      }
    }
    // E quantos sairiam se o ATC que a IA trouxe (e não foi escrito)
    // fosse usado. É a medida do que se perdeu na recusa.
    let omComAtcDaIa = 0;
    for (const r of omIaTinhaAtc) {
      if (!r.productType) continue;
      try {
        const novo = mapToCanonical({
          productType: r.productType as ProductType,
          productTypeConfidence: r.productTypeConfidence ?? 0.5,
          externalCategory: null,
          externalSubcategory: null,
          designacao: r.designacao,
          atc: r.cAtc,
          dci: r.cDci ?? r.dci,
        });
        if (novo && !ehBalde(novo.nivel2)) omComAtcDaIa++;
      } catch {
        /* ignora */
      }
    }

    linha("");
    linha(`  total em "Outros Medicamentos" ........... ${col(om.length, om.length)}`);
    linha(`  · sem ATC no catálogo .................... ${col(omSemAtc.length, om.length)}`);
    linha(`  · nunca enriquecidos ..................... ${col(omNuncaEnriq.length, om.length)}`);
    linha(`  · enriquecidos e continuam sem ATC ....... ${col(omEnriqSemAtc.length, om.length)}`);
    linha(`  · a IA TROUXE ATC que não foi escrito .... ${col(omIaTinhaAtc.length, om.length)}`);
    linha(`  · a IA trouxe DCI que não foi escrito .... ${col(omIaTinhaDci.length, om.length)}`);
    linha(`  · têm DCI mas não ATC .................... ${col(omComDci.length, om.length)}`);
    linha("");
    linha(`  sairiam do balde com o mapper de hoje .... ${col(omRemapEspecifico, om.length)}`);
    linha(`  sairiam se o ATC da IA fosse aceite ...... ${col(omComAtcDaIa, om.length)}`);
    linha("");
    linha("  A última linha é a que decide: se for alta, o problema é o limiar");
    linha(`  clínico (${LIMIAR_CLINICO}); se for baixa, o ATC não existe em lado nenhum e`);
    linha("  é preciso uma fonte externa (INFARMED) e não mais chamadas ao modelo.");
  } finally {
    await prisma.$disconnect();
  }
}

principal().catch((e) => {
  console.error(e);
  process.exit(1);
});
