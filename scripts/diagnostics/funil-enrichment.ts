/**
 * scripts/diagnostics/funil-enrichment.ts
 *
 * Diagnóstico READ-ONLY da CLASSIFICAÇÃO do catálogo. Não escreve, não
 * reclassifica, não corre enrichment, não altera taxonomia nem limiares.
 *
 * O eixo é a classificação — família, categoria, segmentos. O ATC
 * aparece como coluna auxiliar quando existe e nunca como conclusão.
 *
 * ══════════════════════════════════════════════════════════════════════
 * O SÍTIO ONDE A CADEIA QUEBRA EM SILÊNCIO
 * ══════════════════════════════════════════════════════════════════════
 *
 * `lib/catalog/knowledge-enrichment.ts:837`:
 *
 *     if (cat && sub && isValidNivel2(cat, sub)) { categoria = cat; ... }
 *
 * Um par (categoria, subcategoria) que não valide contra a taxonomia é
 * posto a `null`. Sem motivo, sem registo do que o modelo disse. Na cache
 * fica INDISTINGUÍVEL de "o modelo não soube".
 *
 * E o prompt avisa que isso acontece (linha 612):
 *
 *     "Qualquer valor fora das listas é descartado pelo sistema — não é
 *      corrigido, é deitado fora, e o produto fica por classificar."
 *
 * Ora a taxonomia obriga a escolher UM nível 1 entre eixos diferentes:
 * "Um medicamento veterinário é VETERINARIA, não MEDICAMENTO" (regra 6
 * do prompt). Uma fralda de adulto é PUERICULTURA ou é DISPOSITIVOS? Um
 * solar infantil é PROTEÇÃO SOLAR ou PUERICULTURA? Se o modelo escolher
 * a família certa e a subcategoria da outra, o par não valida e o
 * produto fica Por Classificar — sem que fique escrito porquê.
 *
 * ══════════════════════════════════════════════════════════════════════
 * NÃO SE PODE MEDIR DIRECTAMENTE. MEDE-SE A SOMBRA.
 * ══════════════════════════════════════════════════════════════════════
 *
 * Como o descarte não deixa rasto, ninguém consegue contar os pares
 * perdidos. O que se consegue contar é a sua impressão digital:
 *
 *     cache existe
 *     E evidenceType != DESCONHECIDO      (o modelo AFIRMOU conhecer)
 *     E confidence >= LIMIAR_PERSISTENCIA (com confiança bastante)
 *     E categoria IS NULL E subcategoria IS NULL
 *
 * Um modelo que diz "reconheço este produto, confiança 0,93" e não deixa
 * classificação nenhuma ou respondeu vazio de propósito, ou respondeu um
 * par que a taxonomia recusou. `rationale` — que sobrevive — costuma
 * dizer qual dos dois.
 *
 * Este número é o mais importante deste ficheiro.
 *
 *   npx tsx scripts/diagnostics/funil-enrichment.ts --tenant=silveira
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "../../generated/prisma/client";
import { buildTenantConnectionString, getTenantBySlug } from "../../lib/control-plane";
import { AlvoRecusado, descreverAlvo, resolverAlvo } from "../../lib/catalog/target-db";
import { LIMIAR_PERSISTENCIA } from "../../lib/catalog/knowledge-enrichment";
import { CANONICAL_TAXONOMY, isValidNivel2 } from "../../lib/catalog-taxonomy";

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

/**
 * Os níveis 1 que são SEGMENTO e não família — "para quem / para quê".
 *
 * Não é opinião solta: é a leitura de `lib/catalog-taxonomy.ts` contra a
 * pergunta "isto responde a O QUE O PRODUTO É?". Uma fralda é um produto;
 * "bebé" é para quem ele serve. Estar aqui significa que, num modelo de
 * três eixos, este nível 1 deixaria de competir com MEDICAMENTOS e
 * passava a poder coexistir com ele.
 */
const NIVEL1_SEGMENTO = new Set([
  "PUERICULTURA E BEBÉ",
  "MÃE E GRAVIDEZ",
  "SAÚDE SEXUAL",
  "PRIMEIROS SOCORROS",
  "CONTROLO DE PESO",
  "BEM-ESTAR",
  "SAÚDE NATURAL",
  "VETERINÁRIA",
  "MOBILIDADE E APOIO DIÁRIO",
]);

// ─────────────────────────────────────────────────────────────────────
type LinhaAudit = {
  produtoId: string;
  cnp: number;
  designacao: string;
  nivel1: string | null;
  nivel2: string | null;
  codigoATC: string | null;
  productType: string | null;
  productTypeConfidence: number | null;
  utilizacoes: string | null;
  nUtilizacoes: number;
  cacheExiste: boolean;
  cCategoria: string | null;
  cSubcategoria: string | null;
  cProductType: string | null;
  cConfidence: number | null;
  cEvidence: string | null;
  cPersistido: boolean | null;
  cMotivo: string | null;
  cRationale: string | null;
  cOrigem: string | null;
  cUtilizacoes: string[] | null;
  cAtc: string | null;
};

async function carregar(prisma: PrismaClient): Promise<LinhaAudit[]> {
  // A linha de cache MAIS RECENTE por CNP. Uma segunda corrida deixa
  // duas linhas, e contá-las ambas faria o funil somar mais do que o
  // catálogo tem.
  return prisma.$queryRaw<LinhaAudit[]>(Prisma.sql`
    SELECT
      p.id                      AS "produtoId",
      p.cnp                     AS cnp,
      p.designacao              AS designacao,
      c1.nome                   AS nivel1,
      c2.nome                   AS nivel2,
      p."codigoATC"             AS "codigoATC",
      p."productType"           AS "productType",
      p."productTypeConfidence" AS "productTypeConfidence",
      u.slugs                   AS utilizacoes,
      COALESCE(u.n, 0)::int     AS "nUtilizacoes",
      (k.chave IS NOT NULL)     AS "cacheExiste",
      k.categoria               AS "cCategoria",
      k.subcategoria            AS "cSubcategoria",
      k."productType"           AS "cProductType",
      k.confidence              AS "cConfidence",
      k."evidenceType"          AS "cEvidence",
      k.persistido              AS "cPersistido",
      k.motivo                  AS "cMotivo",
      k.rationale               AS "cRationale",
      k.origem                  AS "cOrigem",
      k.utilizacoes             AS "cUtilizacoes",
      k."codigoATC"             AS "cAtc"
    FROM "Produto" p
    LEFT JOIN "Classificacao" c1 ON c1.id = p."classificacaoNivel1Id"
    LEFT JOIN "Classificacao" c2 ON c2.id = p."classificacaoNivel2Id"
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS n, string_agg(uu.slug, ',' ORDER BY uu.slug) AS slugs
      FROM "ProdutoUtilizacao" pu
      JOIN "Utilizacao" uu ON uu.id = pu."utilizacaoId"
      WHERE pu."produtoId" = p.id
    ) u ON true
    LEFT JOIN LATERAL (
      SELECT * FROM "KnowledgeEnrichmentCache" kk
      WHERE kk.cnp = p.cnp ORDER BY kk."criadoEm" DESC LIMIT 1
    ) k ON true
  `);
}

const ehBalde = (n2: string | null) => !!n2 && /^outros\b/i.test(n2);
const porClassificar = (r: LinhaAudit) => !r.nivel1 && !r.nivel2;

/**
 * A impressão digital do par descartado: o modelo afirmou conhecer, com
 * confiança suficiente, e não sobrou classificação nenhuma.
 */
function parDescartado(r: LinhaAudit): boolean {
  return (
    r.cacheExiste &&
    r.cEvidence !== "DESCONHECIDO" &&
    (r.cConfidence ?? 0) >= LIMIAR_PERSISTENCIA &&
    !r.cCategoria &&
    !r.cSubcategoria
  );
}

/** Onde é que ESTE produto perdeu a classificação. Exclusivo e ordenado. */
type Causa =
  | "A_NUNCA"
  | "B_DESCONHECIDO"
  | "C_PAR_DESCARTADO"
  | "D_ABAIXO_LIMIAR"
  | "E_RECUSADO"
  | "F_SO_FAMILIA"
  | "G_PERSISTIU_NAO_CHEGOU"
  | "H_OUTRO";

const ROTULO: Record<Causa, string> = {
  A_NUNCA: "A · nunca passou por enrichment",
  B_DESCONHECIDO: "B · modelo respondeu DESCONHECIDO",
  C_PAR_DESCARTADO: "C · afirmou saber, par não sobreviveu à validação",
  D_ABAIXO_LIMIAR: "D · respondeu, confiança abaixo do limiar",
  E_RECUSADO: "E · classificação aceite pelo modelo, recusada por nós",
  F_SO_FAMILIA: "F · só conseguiu a família (sugeriu Outros)",
  G_PERSISTIU_NAO_CHEGOU: "G · persistiu mas não chegou ao produto",
  H_OUTRO: "H · outros motivos",
};

function causaDe(r: LinhaAudit): Causa {
  if (!r.cacheExiste) return "A_NUNCA";
  if (r.cEvidence === "DESCONHECIDO") return "B_DESCONHECIDO";
  if (parDescartado(r)) return "C_PAR_DESCARTADO";
  if (!r.cCategoria && !r.cSubcategoria) {
    return (r.cConfidence ?? 0) < LIMIAR_PERSISTENCIA ? "D_ABAIXO_LIMIAR" : "H_OUTRO";
  }
  if (r.cSubcategoria && /^outros\b/i.test(r.cSubcategoria)) return "F_SO_FAMILIA";
  if (r.cPersistido === false) return "E_RECUSADO";
  if (r.cPersistido === true) return "G_PERSISTIU_NAO_CHEGOU";
  return "H_OUTRO";
}

// ═════════════════════════════════════════════════════════════════════
async function principal() {
  linha("SPharm.MT · funil da CLASSIFICAÇÃO · diagnóstico read-only");
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
  linha(`Limiar de persistência da classificação: ${LIMIAR_PERSISTENCIA}`);

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: alvo.url }) });

  try {
    const rows = await carregar(prisma);
    const total = rows.length;

    const especificos = rows.filter((r) => r.nivel2 && !ehBalde(r.nivel2));
    const emBalde = rows.filter((r) => ehBalde(r.nivel2));
    const semClass = rows.filter(porClassificar);
    const comCache = rows.filter((r) => r.cacheExiste);

    // ══════════════════════════════════════════════════════════════════
    titulo("PARTE 1 · Onde está o catálogo");
    linha("");
    linha(`  produtos ................................. ${col(total, total)}`);
    linha(`  · nível 2 específico ..................... ${col(especificos.length, total)}`);
    linha(`  · em "Outros <X>" ........................ ${col(emBalde.length, total)}`);
    linha(`  · Por Classificar ........................ ${col(semClass.length, total)}`);

    // ══════════════════════════════════════════════════════════════════
    titulo("PARTE 2 · O par descartado — o silêncio da cadeia");
    linha("");
    linha("  Um par (categoria, subcategoria) que não valida contra a taxonomia");
    linha("  é posto a null em knowledge-enrichment.ts:837, sem motivo e sem");
    linha("  registo. Não se conta directamente; conta-se a impressão digital:");
    linha(`  modelo AFIRMOU conhecer, confiança >= ${LIMIAR_PERSISTENCIA}, e não sobrou nada.`);
    linha("");
    const descartados = rows.filter(parDescartado);
    const descPorClass = descartados.filter(porClassificar);
    const descBalde = descartados.filter((r) => ehBalde(r.nivel2));
    linha(`  produtos com esta impressão digital ...... ${col(descartados.length, total)}`);
    linha(`  · dos quais Por Classificar .............. ${col(descPorClass.length, Math.max(1, semClass.length))}  (dos Por Classificar)`);
    linha(`  · dos quais em "Outros <X>" .............. ${col(descBalde.length, Math.max(1, emBalde.length))}  (dos baldes)`);
    linha("");
    linha("  Amostra de `rationale` destes casos — é o único vestígio do que o");
    linha("  modelo tinha dito antes de a validação o deitar fora:");
    for (const r of descartados.slice(0, 15)) {
      linha(`    ${String(r.cnp).padEnd(9)} ${corta(r.designacao, 32)} ${corta(r.cRationale, 30)}`);
    }

    // ══════════════════════════════════════════════════════════════════
    titulo("PARTE 3 · Funil dos Por Classificar");
    linha("");
    const contar = (grupo: LinhaAudit[]) => {
      const m = new Map<Causa, number>();
      for (const r of grupo) {
        const c = causaDe(r);
        m.set(c, (m.get(c) ?? 0) + 1);
      }
      return m;
    };
    const cPorClass = contar(semClass);
    for (const k of Object.keys(ROTULO) as Causa[]) {
      linha(`  ${ROTULO[k].padEnd(46)} ${col(cPorClass.get(k) ?? 0, semClass.length)}`);
    }

    // Quantos, dentro dos Por Classificar, JÁ TÊM utilizações — ou seja,
    // o enrichment conseguiu dizer PARA QUE SERVE e não conseguiu dizer
    // O QUE É. É o sintoma directo dos eixos misturados.
    const semClassComUtil = semClass.filter((r) => r.nUtilizacoes > 0);
    linha("");
    linha(`  Por Classificar que JÁ TÊM segmentos/utilizações: ${col(semClassComUtil.length, semClass.length)}`);
    linha("  (o sistema sabe PARA QUE SERVE mas não sabe O QUE É — é o");
    linha("   sintoma directo de os dois eixos estarem no mesmo campo)");

    // ══════════════════════════════════════════════════════════════════
    titulo("PARTE 4 · Funil dos Outros <X>");
    linha("");
    const cBalde = contar(emBalde);
    for (const k of Object.keys(ROTULO) as Causa[]) {
      linha(`  ${ROTULO[k].padEnd(46)} ${col(cBalde.get(k) ?? 0, emBalde.length)}`);
    }

    // ══════════════════════════════════════════════════════════════════
    titulo("PARTE 5 · O que o enrichment devolve, em classificação");
    linha("");
    const respondeu = comCache.filter((r) => r.cEvidence !== "DESCONHECIDO");
    const comCat = comCache.filter((r) => !!r.cCategoria);
    const comSub = comCache.filter((r) => !!r.cSubcategoria);
    const comSubEsp = comCache.filter(
      (r) => !!r.cSubcategoria && !/^outros\b/i.test(r.cSubcategoria),
    );
    const comSubBalde = comSub.length - comSubEsp.length;
    const comUtil = comCache.filter((r) => (r.cUtilizacoes?.length ?? 0) > 0);
    const comTipo = comCache.filter((r) => !!r.cProductType);

    linha(`  linhas de cache (1 por produto, a mais recente)  ${col(comCache.length, total)}`);
    linha(`  · respondeu (não DESCONHECIDO) .................. ${col(respondeu.length, comCache.length)}`);
    linha(`  · devolveu família/productType ................. ${col(comTipo.length, comCache.length)}`);
    linha(`  · devolveu categoria (nível 1) ................. ${col(comCat.length, comCache.length)}`);
    linha(`  · devolveu subcategoria ....................... ${col(comSub.length, comCache.length)}`);
    linha(`    · específica ................................ ${col(comSubEsp.length, comCache.length)}`);
    linha(`    · "Outros <X>" .............................. ${col(comSubBalde, comCache.length)}`);
    linha(`  · devolveu segmentos/utilizações .............. ${col(comUtil.length, comCache.length)}`);
    linha(`  · (auxiliar) devolveu ATC ..................... ${col(comCache.filter((r) => !!r.cAtc).length, comCache.length)}`);

    linha("");
    linha("  Distribuição de confiança de quem RESPONDEU:");
    const baldesConf = [
      ["< 0,60", 0, 0.6],
      ["0,60–0,74", 0.6, 0.75],
      ["0,75–0,84", 0.75, LIMIAR_PERSISTENCIA],
      [`>= ${LIMIAR_PERSISTENCIA}`, LIMIAR_PERSISTENCIA, 1.01],
    ] as const;
    for (const [rot, lo, hi] of baldesConf) {
      const n = respondeu.filter((r) => (r.cConfidence ?? 0) >= lo && (r.cConfidence ?? 0) < hi).length;
      linha(`    ${rot.padEnd(12)} ${col(n, respondeu.length)}`);
    }

    linha("");
    linha("  Motivos de não-persistência (os 12 mais frequentes):");
    const motivos = new Map<string, number>();
    for (const r of comCache.filter((x) => x.cPersistido === false)) {
      const m = (r.cMotivo ?? "(sem motivo)").replace(/\d+[.,]\d+/g, "N");
      motivos.set(m, (motivos.get(m) ?? 0) + 1);
    }
    for (const [m, n] of Array.from(motivos.entries()).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
      linha(`    ${String(nf(n)).padStart(7)}  ${corta(m, 56)}`);
    }

    // ══════════════════════════════════════════════════════════════════
    titulo("PARTE 6 · Eficácia: quantos ficaram MELHOR classificados");
    linha("");
    const persistidos = comCache.filter((r) => r.cPersistido === true);
    const saiuPorClass = persistidos.filter((r) => !porClassificar(r));
    const ganhouEspecifica = persistidos.filter((r) => r.nivel2 && !ehBalde(r.nivel2));
    const ganhouSegmentos = persistidos.filter((r) => r.nUtilizacoes > 0);
    const ficouBalde = persistidos.filter((r) => ehBalde(r.nivel2));
    const ficouPorClass = persistidos.filter(porClassificar);

    linha(`  processados (têm linha de cache) ......... ${col(comCache.length, comCache.length)}`);
    linha(`  → resposta útil (não DESCONHECIDO) ....... ${col(respondeu.length, comCache.length)}`);
    linha(`  → classificação aceite e persistida ...... ${col(persistidos.length, comCache.length)}`);
    linha(`  → deixaram de estar Por Classificar ...... ${col(saiuPorClass.length, comCache.length)}`);
    linha(`  → ganharam categoria ESPECÍFICA .......... ${col(ganhouEspecifica.length, comCache.length)}`);
    linha(`  → ganharam segmentos/utilizações ......... ${col(ganhouSegmentos.length, comCache.length)}`);
    linha(`  → ficaram na mesma em "Outros <X>" ....... ${col(ficouBalde.length, comCache.length)}`);
    linha(`  → ficaram na mesma Por Classificar ....... ${col(ficouPorClass.length, comCache.length)}`);

    const porOrigem = new Map<string, number>();
    for (const r of comCache) {
      const o = r.cOrigem ?? "(sem origem)";
      porOrigem.set(o, (porOrigem.get(o) ?? 0) + 1);
    }
    linha("");
    for (const [o, n] of Array.from(porOrigem.entries()).sort((a, b) => b[1] - a[1])) {
      linha(`  origem ${o.padEnd(12)} ${col(n, comCache.length)}`);
    }
    const claude = porOrigem.get("CLAUDE") ?? 0;
    linha("");
    linha(
      `  ⇒ ${claude > 0 ? ((ganhouEspecifica.length / claude) * 100).toFixed(1) : "—"}% das decisões pagas resultaram em categoria específica.`,
    );
    linha("");
    linha("  CUSTO: não há tokens nem preço no schema — `EnrichmentSourceLog`");
    linha("  guarda durationMs e não consumo. O número de decisões pagas está");
    linha("  acima (origem=CLAUDE); o preço unitário tem de vir da faturação.");
    linha("  Multiplicar por uma estimativa seria dar um palpite como medição.");

    // ══════════════════════════════════════════════════════════════════
    titulo("PARTE 7 · Os eixos misturados, medidos");
    linha("");
    linha("  Produtos classificados sob um nível 1 que é SEGMENTO e não");
    linha("  família. No modelo de três eixos, estes passariam a ter tipo +");
    linha("  categoria próprios E o segmento — deixavam de competir.");
    linha("");
    let totalSeg = 0;
    let totalSegBalde = 0;
    for (const n1 of Array.from(NIVEL1_SEGMENTO).sort()) {
      const g = rows.filter((r) => r.nivel1 === n1);
      const b = g.filter((r) => ehBalde(r.nivel2));
      totalSeg += g.length;
      totalSegBalde += b.length;
      if (g.length === 0) continue;
      linha(
        `  ${corta(n1, 28)} ${String(nf(g.length)).padStart(7)}   em balde: ${String(nf(b.length)).padStart(6)}  ${pct(b.length, g.length)}`,
      );
    }
    linha("  " + "─".repeat(70));
    linha(`  ${"TOTAL sob segmento".padEnd(28)} ${String(nf(totalSeg)).padStart(7)}   em balde: ${String(nf(totalSegBalde)).padStart(6)}  ${pct(totalSegBalde, Math.max(1, totalSeg))}`);
    linha("");
    linha(`  ⇒ ${nf(totalSegBalde)} produtos estão em "Outros <segmento>": o sistema sabe`);
    linha("    PARA QUEM servem e não sabe O QUE SÃO. É a colisão de eixos a");
    linha("    produzir baldes, e nenhuma regra nova a resolve — só a separação.");

    // ══════════════════════════════════════════════════════════════════
    titulo("PARTE 8 · Amostra de 100 Por Classificar");

    const passo = Math.max(1, Math.floor(semClass.length / 100));
    const amostra = semClass
      .slice()
      .sort((a, b) => a.cnp - b.cnp)
      .filter((_, i) => i % passo === 0)
      .slice(0, 100);

    for (const r of amostra) {
      linha("");
      linha(`  CNP ${r.cnp}  ${corta(r.designacao, 50)}`);
      linha(
        `      actual: tipo=${corta(r.productType, 16)}(${(r.productTypeConfidence ?? 0).toFixed(2)})` +
          `  classificação=(nenhuma)  segmentos=${corta(r.utilizacoes, 24)}`,
      );
      if (!r.cacheExiste) {
        linha("      enrichment: (nunca processado)");
      } else {
        linha(
          `      enrichment: ${corta(r.cEvidence, 14)} conf=${(r.cConfidence ?? 0).toFixed(2)}` +
            `  família=${corta(r.cProductType ?? r.cCategoria, 20)}`,
        );
        linha(
          `        categoria=${corta(r.cCategoria, 22)} subcategoria=${corta(r.cSubcategoria, 26)}`,
        );
        linha(
          `        segmentos=${corta((r.cUtilizacoes ?? []).join(","), 26)}` +
            `  persistido=${r.cPersistido ? "SIM" : "NÃO"}` +
            (r.cAtc ? `  [aux ATC=${r.cAtc}]` : ""),
        );
        linha(`        motivo: ${corta(r.cMotivo, 56)}`);
        if (parDescartado(r)) {
          linha(`        ⚠ PAR DESCARTADO — rationale: ${corta(r.cRationale, 44)}`);
        }
      }
      linha(`      ⇒ ${ROTULO[causaDe(r)]}`);
    }

    // ══════════════════════════════════════════════════════════════════
    titulo("PARTE 9 · A taxonomia consegue exprimir o que o modelo diz?");
    linha("");
    linha("  Para cada categoria (nível 1) sugerida pelo enrichment, quantas");
    linha("  subcategorias específicas existem para escolher. Um nível 1 com");
    linha("  poucas filhas força o balde por construção.");
    linha("");
    const sugeridas = new Map<string, number>();
    for (const r of comCache) {
      if (!r.cCategoria) continue;
      sugeridas.set(r.cCategoria, (sugeridas.get(r.cCategoria) ?? 0) + 1);
    }
    linha("  NÍVEL 1 SUGERIDO                 SUGESTÕES   FILHAS   ESPECÍFICAS");
    linha("  " + "─".repeat(70));
    for (const [n1, n] of Array.from(sugeridas.entries()).sort((a, b) => b[1] - a[1]).slice(0, 20)) {
      const fam = CANONICAL_TAXONOMY.find((c) => c.nivel1 === n1);
      const filhas = fam?.nivel2.length ?? 0;
      const esp = fam?.nivel2.filter((x) => !/^outros\b/i.test(x)).length ?? 0;
      linha(`  ${corta(n1, 30)} ${String(nf(n)).padStart(9)} ${String(filhas).padStart(8)} ${String(esp).padStart(13)}`);
    }

    // Sanidade: o par que o modelo devolveu valida mesmo?
    const paresInvalidos = comCache.filter(
      (r) => r.cCategoria && r.cSubcategoria && !isValidNivel2(r.cCategoria, r.cSubcategoria),
    ).length;
    linha("");
    linha(`  pares gravados que HOJE já não validam: ${nf(paresInvalidos)}`);
    linha("  (> 0 significa que a taxonomia mudou depois de eles serem gravados)");
  } finally {
    await prisma.$disconnect();
  }
}

principal().catch((e) => {
  console.error(e);
  process.exit(1);
});
