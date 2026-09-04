/**
 * scripts/diagnostics/baldes-outros.ts
 *
 * Diagnóstico READ-ONLY das categorias "Outros <X>". Não escreve, não
 * altera, não corre migrations, não reclassifica nada.
 *
 * ══════════════════════════════════════════════════════════════════════
 * O QUE "OUTROS <X>" É — confirmado no código, não assumido
 * ══════════════════════════════════════════════════════════════════════
 *
 * É um nível 2 LITERAL da taxonomia canónica. Existe um por cada nível 1,
 * escrito à mão em `lib/catalog-taxonomy.ts` ("Outros Medicamentos",
 * "Outros Dermocosmética", …). NÃO é concatenado em tempo de relatório,
 * NÃO é um `null` disfarçado, e NÃO vem da fonte: `categoria-resolver.ts`
 * ignora `categoriaOrigem`/`subcategoriaOrigem` por decisão explícita.
 *
 * Um produto SEM classificação nenhuma não aparece como "Outros <X>" —
 * aparece como "Por Classificar" (SEM_CLASSIFICACAO_LABEL). São coisas
 * diferentes, e confundi-las é o erro mais fácil de cometer aqui.
 *
 * ══════════════════════════════════════════════════════════════════════
 * CINCO CAMINHOS, COM SIGNIFICADOS DIFERENTES
 * ══════════════════════════════════════════════════════════════════════
 *
 * O `method` do mapper (`lib/catalog-taxonomy-map.ts`) distingue-os, mas
 * NÃO é persistido — só a classificação final o é. Por isso este
 * diagnóstico RECALCULA o mapeamento a partir dos sinais que estão hoje
 * na base, e é assim que separa os casos:
 *
 *   1. `atc_prefix` / `atc`  — o ATC aponta DELIBERADAMENTE para o balde.
 *      A11 (vitaminas), A12 (minerais), B02, B03, J06, J07, M05, N01, e
 *      as letras B/H/J/L/P/V. Confiança 0,92. Isto é classificação
 *      CORRECTA numa subcategoria residual, não falha nenhuma.
 *
 *   2. `designacao_rota` — uma rota de salvamento manda explicitamente
 *      para o balde (ex.: ostomia → "Outros Dispositivos Médicos").
 *      Também deliberado.
 *
 *   3. `others_fallback` — nível 1 forte, nenhum sinal para o nível 2.
 *      Confiança 0,55. É o fallback técnico a sério.
 *
 *   4. Enriquecimento por modelo — `knowledge-enrichment.ts` instrui
 *      explicitamente: "Se só sabes o nível 1, devolve Outros <X>".
 *
 *   5. Herança do catálogo global.
 *
 * Só o 3 (e por vezes o 4) é que representa "não sabemos". Somá-los
 * todos e chamar-lhes "por classificar" seria inflacionar o problema;
 * ignorá-los seria escondê-lo.
 *
 * ══════════════════════════════════════════════════════════════════════
 *   npx tsx scripts/diagnostics/baldes-outros.ts --tenant=silveira
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "../../generated/prisma/client";
import { buildTenantConnectionString, getTenantBySlug } from "../../lib/control-plane";
import { AlvoRecusado, descreverAlvo, resolverAlvo } from "../../lib/catalog/target-db";
import { mapToCanonical } from "../../lib/catalog-taxonomy-map";
import type { ProductType } from "../../lib/catalog-types";

const linha = (t = "") => console.log(t);
const nf = (n: number) => n.toLocaleString("pt-PT");
const pct = (n: number, total: number) =>
  total > 0 ? `${((n / total) * 100).toFixed(1)}%` : "—";

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
type LinhaProduto = {
  produtoId: string;
  cnp: number;
  designacao: string;
  nivel1: string | null;
  nivel2: string | null;
  codigoATC: string | null;
  dci: string | null;
  productType: string | null;
  productTypeConfidence: number | null;
  fabricante: string | null;
  categoriaOrigem: string | null;
  subcategoriaOrigem: string | null;
  utilizacoes: string | null;
};

async function carregar(prisma: PrismaClient): Promise<LinhaProduto[]> {
  // Um produto por CNP, com TUDO o que poderia servir para o
  // reclassificar. `categoriaOrigem` vive em ProdutoFarmacia (é da
  // farmácia, não do produto) — junta-se a primeira não-vazia, que é o
  // que interessa para saber se o sinal EXISTE.
  return prisma.$queryRaw<LinhaProduto[]>(Prisma.sql`
    SELECT
      p.id                       AS "produtoId",
      p.cnp                      AS cnp,
      p.designacao               AS designacao,
      c1.nome                    AS nivel1,
      c2.nome                    AS nivel2,
      p."codigoATC"              AS "codigoATC",
      p.dci                      AS dci,
      p."productType"            AS "productType",
      p."productTypeConfidence"  AS "productTypeConfidence",
      fab."nomeNormalizado"      AS fabricante,
      pf."categoriaOrigem"       AS "categoriaOrigem",
      pf."subcategoriaOrigem"    AS "subcategoriaOrigem",
      (
        SELECT string_agg(u.slug, ', ' ORDER BY u.slug)
        FROM "ProdutoUtilizacao" pu
        JOIN "Utilizacao" u ON u.id = pu."utilizacaoId"
        WHERE pu."produtoId" = p.id
      )                          AS utilizacoes
    FROM "Produto" p
    LEFT JOIN "Classificacao" c1  ON c1.id = p."classificacaoNivel1Id"
    LEFT JOIN "Classificacao" c2  ON c2.id = p."classificacaoNivel2Id"
    LEFT JOIN "Fabricante"    fab ON fab.id = p."fabricanteId"
    LEFT JOIN LATERAL (
      SELECT x."categoriaOrigem", x."subcategoriaOrigem"
      FROM "ProdutoFarmacia" x
      WHERE x."produtoId" = p.id
        AND (COALESCE(x."categoriaOrigem", '') <> '' OR COALESCE(x."subcategoriaOrigem", '') <> '')
      LIMIT 1
    ) pf ON true
  `);
}

/**
 * Recalcula o mapeamento com os sinais que ESTÃO HOJE na base.
 *
 * Não altera nada — só responde à pergunta "com o que já sabemos, o
 * mapper de hoje daria outra coisa?". É a medida honesta de quanto é
 * reclassificável sem dados novos e sem trabalho manual.
 */
function remapear(p: LinhaProduto) {
  if (!p.productType) return null;
  try {
    return mapToCanonical({
      productType: p.productType as ProductType,
      productTypeConfidence: p.productTypeConfidence ?? 0.5,
      externalCategory: p.categoriaOrigem,
      externalSubcategory: p.subcategoriaOrigem,
      designacao: p.designacao,
      atc: p.codigoATC,
      dci: p.dci,
    });
  } catch {
    return null;
  }
}

const ehBalde = (n2: string | null) => !!n2 && /^outros\b/i.test(n2);

// ═════════════════════════════════════════════════════════════════════
async function principal() {
  linha('SPharm.MT · baldes "Outros <X>" · diagnóstico read-only');
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
      linha("Uso: npx tsx scripts/diagnostics/baldes-outros.ts --tenant=<slug>");
      process.exit(2);
    }
    throw e;
  }
  linha(`Alvo: ${descreverAlvo(alvo)}`);

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: alvo.url }) });

  try {
    const produtos = await carregar(prisma);

    // ══════════════════════════════════════════════════════════════════
    titulo("PARTE 1 · Dimensão");

    const total = produtos.length;
    const semClassificacao = produtos.filter((p) => !p.nivel1 && !p.nivel2).length;
    const semNivel2 = produtos.filter((p) => p.nivel1 && !p.nivel2).length;
    const emBalde = produtos.filter((p) => ehBalde(p.nivel2));
    const especificos = produtos.filter((p) => p.nivel2 && !ehBalde(p.nivel2)).length;

    linha("");
    linha(`  produtos no catálogo ................... ${String(nf(total)).padStart(8)}`);
    linha(`  · com nível 2 específico ............... ${String(nf(especificos)).padStart(8)}  ${pct(especificos, total)}`);
    linha(`  · em "Outros <X>" ...................... ${String(nf(emBalde.length)).padStart(8)}  ${pct(emBalde.length, total)}`);
    linha(`  · com nível 1 mas SEM nível 2 .......... ${String(nf(semNivel2)).padStart(8)}  ${pct(semNivel2, total)}`);
    linha(`  · sem classificação ("Por Classificar")  ${String(nf(semClassificacao)).padStart(8)}  ${pct(semClassificacao, total)}`);
    linha("");
    linha('  Nota: "Outros <X>" e "Por Classificar" são estados DIFERENTES.');
    linha("  O primeiro é um nível 2 real da taxonomia; o segundo é a ausência");
    linha("  de classificação. Somá-los seria contar o mesmo problema duas vezes.");

    // ══════════════════════════════════════════════════════════════════
    titulo("PARTE 2 · Os baldes, por tamanho");

    // Total por família (nível 1), para a percentagem ter denominador.
    const porFamilia = new Map<string, number>();
    for (const p of produtos) {
      if (!p.nivel1) continue;
      porFamilia.set(p.nivel1, (porFamilia.get(p.nivel1) ?? 0) + 1);
    }

    type Agg = {
      nivel2: string;
      nivel1: string;
      n: number;
      comAtc: number;
      comDci: number;
      comOrigem: number;
      comFabricante: number;
      comUtilizacoes: number;
      remapEspecifico: number;
      remapMesmoBalde: number;
      remapNulo: number;
    };
    const baldes = new Map<string, Agg>();

    for (const p of emBalde) {
      const chave = p.nivel2!;
      let a = baldes.get(chave);
      if (!a) {
        a = {
          nivel2: chave,
          nivel1: p.nivel1 ?? "(sem nível 1)",
          n: 0,
          comAtc: 0,
          comDci: 0,
          comOrigem: 0,
          comFabricante: 0,
          comUtilizacoes: 0,
          remapEspecifico: 0,
          remapMesmoBalde: 0,
          remapNulo: 0,
        };
        baldes.set(chave, a);
      }
      a.n++;
      if (p.codigoATC) a.comAtc++;
      if (p.dci) a.comDci++;
      if ((p.categoriaOrigem ?? "").trim() || (p.subcategoriaOrigem ?? "").trim()) a.comOrigem++;
      if (p.fabricante) a.comFabricante++;
      if (p.utilizacoes) a.comUtilizacoes++;

      const novo = remapear(p);
      if (!novo) a.remapNulo++;
      else if (ehBalde(novo.nivel2)) a.remapMesmoBalde++;
      else a.remapEspecifico++;
    }

    const ordenados = Array.from(baldes.values()).sort((a, b) => b.n - a.n);

    linha("");
    linha("  BALDE                              PRODUTOS   % DA FAMÍLIA   (família)");
    linha("  " + "─".repeat(74));
    for (const b of ordenados) {
      const famTotal = porFamilia.get(b.nivel1) ?? 0;
      linha(
        `  ${corta(b.nivel2, 32)} ${String(nf(b.n)).padStart(8)}   ${pct(b.n, famTotal).padStart(8)}      ${nf(famTotal)}`,
      );
    }

    // ══════════════════════════════════════════════════════════════════
    titulo("PARTE 3 · Os 10 maiores — que sinais existem hoje");

    linha("");
    linha("  Todos estes produtos TÊM nível 1 e TÊM nível 2 — por construção:");
    linha('  "Outros <X>" só é atribuído quando o nível 1 é forte. As colunas');
    linha("  abaixo dizem que OUTROS sinais existem, e portanto o que se poderia");
    linha("  usar para os reclassificar sem inventar nada.");
    linha("");
    linha("  BALDE                         TOTAL     ATC     DCI  ORIGEM   FABR.   UTIL.");
    linha("  " + "─".repeat(74));
    for (const b of ordenados.slice(0, 10)) {
      linha(
        `  ${corta(b.nivel2, 28)} ${String(nf(b.n)).padStart(7)}` +
          `${String(nf(b.comAtc)).padStart(8)}${String(nf(b.comDci)).padStart(8)}` +
          `${String(nf(b.comOrigem)).padStart(8)}${String(nf(b.comFabricante)).padStart(8)}` +
          `${String(nf(b.comUtilizacoes)).padStart(8)}`,
      );
    }

    // ══════════════════════════════════════════════════════════════════
    titulo("PARTE 4 · Quanto é reclassificável SEM dados novos");

    linha("");
    linha("  Recorre-se o mapper de HOJE sobre os sinais que já estão na base.");
    linha("  Se ele devolve um nível 2 específico, o produto está no balde por");
    linha("  ter sido classificado por uma versão anterior das regras — e um");
    linha("  reprocessamento resolvia-o, sem trabalho manual e sem dados novos.");
    linha("");
    linha("  BALDE                         TOTAL   ESPECÍFICO   MESMO BALDE   SEM RESPOSTA");
    linha("  " + "─".repeat(74));
    let totEspecifico = 0;
    let totMesmo = 0;
    let totNulo = 0;
    for (const b of ordenados.slice(0, 10)) {
      linha(
        `  ${corta(b.nivel2, 28)} ${String(nf(b.n)).padStart(7)}` +
          `${String(nf(b.remapEspecifico)).padStart(13)}` +
          `${String(nf(b.remapMesmoBalde)).padStart(14)}` +
          `${String(nf(b.remapNulo)).padStart(15)}`,
      );
    }
    for (const b of ordenados) {
      totEspecifico += b.remapEspecifico;
      totMesmo += b.remapMesmoBalde;
      totNulo += b.remapNulo;
    }
    linha("  " + "─".repeat(74));
    linha(
      `  ${"TOTAL (todos os baldes)".padEnd(28)} ${String(nf(emBalde.length)).padStart(7)}` +
        `${String(nf(totEspecifico)).padStart(13)}` +
        `${String(nf(totMesmo)).padStart(14)}` +
        `${String(nf(totNulo)).padStart(15)}`,
    );
    linha("");
    linha(`  ⇒ ${nf(totEspecifico)} produtos (${pct(totEspecifico, emBalde.length)} dos baldes) sairiam do balde`);
    linha("    só por reprocessamento — sem dados novos, sem intervenção manual.");
    linha("");
    linha(`  ⇒ ${nf(totMesmo)} continuariam no balde: para esses, o balde é a`);
    linha("    resposta certa das regras actuais (ATC deliberado, rota de");
    linha("    salvamento) ou falta mesmo informação.");

    // ══════════════════════════════════════════════════════════════════
    titulo("PARTE 5 · Amostras");

    const AMOSTRAR = [
      "Outros Medicamentos",
      "Outros Dispositivos Médicos",
      "Outros Dermocosmética",
    ];
    for (const nome of AMOSTRAR) {
      const lista = emBalde.filter((p) => p.nivel2 === nome).slice(0, 20);
      linha("");
      linha(`  ─── ${nome} (${nf(baldes.get(nome)?.n ?? 0)} produtos, amostra de ${lista.length}) ───`);
      if (lista.length === 0) {
        linha("  (nenhum produto neste balde)");
        continue;
      }
      for (const p of lista) {
        const novo = remapear(p);
        const destino = novo && !ehBalde(novo.nivel2) ? `${novo.nivel2} [${novo.method}]` : "—";
        linha("");
        linha(`  CNP ${p.cnp}  ${corta(p.designacao, 52)}`);
        linha(
          `      nível1=${corta(p.nivel1, 22)} tipo=${corta(p.productType, 16)} ATC=${corta(p.codigoATC, 8)}`,
        );
        linha(
          `      DCI=${corta(p.dci, 26)} fabricante=${corta(p.fabricante, 24)}`,
        );
        linha(
          `      origem=${corta(p.categoriaOrigem, 22)}/${corta(p.subcategoriaOrigem, 18)} util=${corta(p.utilizacoes, 20)}`,
        );
        linha(`      remapeado hoje → ${destino}`);
      }
    }

    // ══════════════════════════════════════════════════════════════════
    titulo("PARTE 6 · Onde é que o balde vem do ATC, deliberadamente");

    // Para MEDICAMENTOS: os prefixos ATC que APONTAM para o balde não são
    // falha nenhuma. Separá-los é a diferença entre "não sabemos" e
    // "sabemos, e a taxonomia não tem casa melhor".
    const med = emBalde.filter((p) => p.nivel2 === "Outros Medicamentos");
    const porPrefixo = new Map<string, number>();
    for (const p of med) {
      const k = p.codigoATC ? p.codigoATC.toUpperCase().slice(0, 3) : "(sem ATC)";
      porPrefixo.set(k, (porPrefixo.get(k) ?? 0) + 1);
    }
    const topPrefixos = Array.from(porPrefixo.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20);
    linha("");
    linha(`  "Outros Medicamentos": ${nf(med.length)} produtos, por prefixo ATC`);
    linha("");
    for (const [k, n] of topPrefixos) {
      linha(`    ${k.padEnd(12)} ${String(nf(n)).padStart(7)}   ${pct(n, med.length)}`);
    }
    const semAtc = porPrefixo.get("(sem ATC)") ?? 0;
    linha("");
    linha(`  Sem ATC nenhum: ${nf(semAtc)} (${pct(semAtc, med.length)}) — para estes, o`);
    linha("  balde é mesmo ausência de informação.");
  } finally {
    await prisma.$disconnect();
  }
}

principal().catch((e) => {
  console.error(e);
  process.exit(1);
});
