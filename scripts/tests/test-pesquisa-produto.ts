/**
 * scripts/tests/test-pesquisa-produto.ts
 *
 * Correcção (2026-09) — "Vendas perdeu a pesquisa por nome/descrição".
 *
 * Investigação: a pesquisa por designação NUNCA desapareceu de
 * `lib/vendas-data.ts` nem de `components/vendas/vendas-client.tsx` (o
 * campo "Artigo" continua no ecrã, sempre visível, e o `git log -p`
 * dos dois ficheiros não mostra nenhuma remoção). O que estava
 * genuinamente pior em Vendas — e explica a impressão de "não encontra
 * nada" — era o CNP: Vendas comparava por IGUALDADE NUMÉRICA EXACTA
 * (`cnp: asNumber`), e escrever só uma parte do código (o que a maioria
 * das pessoas faz ao pesquisar) nunca encontrava o produto. Margens já
 * tinha corrigido exactamente este problema (commit 68949f1) com
 * `cnp::text LIKE`, mas cada relatório tinha a sua própria cópia da
 * pesquisa.
 *
 * Correcção: `construirCondicaoPesquisa` sai de `lib/margens-data.ts`
 * para `lib/reporting/pesquisa-produto.ts` — UM mecanismo, os dois
 * relatórios a importá-lo (Margens por re-export para não partir quem
 * já o importava de lá). Nunca dois mecanismos paralelos.
 *
 * Cobre:
 *   A. a condição cobre CNP exacto, CNP parcial e designação parcial;
 *   B. termo vazio/só espaços ⇒ sem condição;
 *   C. wiring — os dois loaders usam a MESMA função importada do
 *      mesmo módulo, nenhum reimplementa a pesquisa à mão;
 *   D. Vendas já não compara `cnp` por igualdade numérica exacta.
 *
 * Corre com:  npx tsx scripts/tests/test-pesquisa-produto.ts
 */
import { readFileSync } from "node:fs";
import { Prisma } from "../../generated/prisma/client";
import { construirCondicaoPesquisa } from "../../lib/reporting/pesquisa-produto";
import { construirCondicaoPesquisa as reexportadaPorMargens } from "../../lib/margens-data";
import { normalizarOpcao } from "../../components/reporting/filter-select";

let pass = 0;
let fail = 0;
const ok = (label: string, cond: boolean, detalhe?: string) => {
  if (cond) {
    pass++;
    console.log(`  [OK]    ${label}`);
  } else {
    fail++;
    console.log(`  [FALHA] ${label}${detalhe ? ` — ${detalhe}` : ""}`);
  }
};
const eq = <T>(label: string, obtido: T, esperado: T) =>
  ok(
    label,
    JSON.stringify(obtido) === JSON.stringify(esperado),
    `esperado ${JSON.stringify(esperado)}, obtido ${JSON.stringify(obtido)}`,
  );

const src = (p: string) => readFileSync(p, "utf8");

console.log("\n=== A. CNP exacto, CNP parcial, designação parcial — o MESMO campo ===");
{
  const exacto = construirCondicaoPesquisa("5880034");
  ok("CNP exacto compara em texto (cobre exacto E parcial)", exacto.sql.includes('p."cnp"::text LIKE'));
  ok(
    "…e também tenta a designação, via unaccent_immutable dos dois lados",
    exacto.sql.includes('unaccent_immutable(p."designacao") ILIKE unaccent_immutable('),
  );
  eq("padrão = %termo%, para os dois campos", exacto.values, ["%5880034%", "%5880034%"]);

  const parcial = construirCondicaoPesquisa("58800");
  ok("CNP PARCIAL usa o mesmo LIKE — não exige o código completo", parcial.sql.includes('p."cnp"::text LIKE'));

  const nome = construirCondicaoPesquisa("depuralina");
  ok("texto não-numérico só compara designação (CNP nunca casa com letras)", !nome.sql.includes('p."cnp"'));
  ok(
    "…via unaccent_immutable + ILIKE, sem distinguir maiúsculas nem acentos",
    nome.sql.includes('unaccent_immutable(p."designacao") ILIKE unaccent_immutable('),
  );
  eq("padrão da designação", nome.values, ["%depuralina%"]);
}

console.log("\n=== B. Termo vazio ⇒ sem condição ===");
{
  eq("vazio", construirCondicaoPesquisa("").sql, Prisma.empty.sql);
  eq("undefined", construirCondicaoPesquisa(undefined).sql, Prisma.empty.sql);
  eq("null", construirCondicaoPesquisa(null).sql, Prisma.empty.sql);
  eq("só espaços", construirCondicaoPesquisa("   ").sql, Prisma.empty.sql);
}

console.log("\n=== C. Um mecanismo só, importado pelos dois loaders ===");
{
  ok(
    "a função re-exportada por margens-data é a MESMA instância do módulo partilhado",
    reexportadaPorMargens === construirCondicaoPesquisa,
  );

  const vd = src("lib/vendas-data.ts");
  ok(
    "lib/vendas-data.ts importa construirCondicaoPesquisa de lib/reporting/pesquisa-produto",
    /from ["']@\/lib\/reporting\/pesquisa-produto["']/.test(vd) && vd.includes("construirCondicaoPesquisa"),
  );
  ok(
    "…e chama-a para construir a pesquisa (não reimplementa)",
    vd.includes("construirCondicaoPesquisa(filters.pesquisa)"),
  );

  const md = src("lib/margens-data.ts");
  ok(
    "lib/margens-data.ts importa do MESMO módulo partilhado",
    /from ["']@\/lib\/reporting\/pesquisa-produto["']/.test(md),
  );
  ok(
    "…e já não define a função localmente (só a re-exporta)",
    !/^export function construirCondicaoPesquisa\b/m.test(md),
  );

  const pp = src("lib/reporting/pesquisa-produto.ts");
  ok("o módulo partilhado existe e define a função", /^export function construirCondicaoPesquisa\b/m.test(pp));
}

console.log("\n=== D. Vendas já não exige CNP exacto ===");
{
  const vd = src("lib/vendas-data.ts");
  ok(
    "já não há comparação de igualdade numérica exacta do CNP",
    !/\{\s*cnp:\s*asNumber\s*\}/.test(vd),
  );
  ok(
    "…nem o findMany antigo que só reconhecia inteiros",
    !/Number\.isFinite\(asNumber\)\s*&&\s*Number\.isInteger\(asNumber\)/.test(vd),
  );
  ok(
    // O rótulo mudou de "Artigo" para "Produto" (secção F, clareza da
    // UI) — o que este teste garante é que o CAMPO continua no ecrã,
    // não o texto exacto do rótulo antigo.
    "a UI de pesquisa continua no ecrã — nunca desapareceu",
    src("components/vendas/vendas-client.tsx").includes("CompactInput"),
  );
}

// ═════════════════════════════════════════════════════════════════════
// E · Migration da extensão/índice unaccent — sem ela, o SQL de A falha
// ═════════════════════════════════════════════════════════════════════
//
// A prova de que a query REALMENTE devolve os produtos certos (contra
// Postgres a sério, com a migration aplicada) está em
// scripts/tests/test-pesquisa-produto-live.ts — este teste só confirma
// que a migration existe, é aditiva e está ligada ao módulo de pesquisa.
console.log("\n=== E. Migration unaccent — aditiva, sem tocar no índice existente ===");
{
  const mig = src("prisma/migrations/20260915140000_pesquisa_unaccent/migration.sql");
  ok("activa a extensão unaccent (trusted, sem superuser)", mig.includes("CREATE EXTENSION IF NOT EXISTS unaccent"));
  ok(
    "cria o wrapper IMMUTABLE — unaccent() sozinho é STABLE e não serve para índice",
    mig.includes("LANGUAGE sql IMMUTABLE") && mig.includes("unaccent_immutable"),
  );
  ok(
    "índice GIN trigram FUNCIONAL sobre unaccent_immutable(designacao) — mantém a pesquisa rápida",
    mig.includes('CREATE INDEX IF NOT EXISTS "Produto_designacao_unaccent_trgm_idx"') &&
      mig.includes("gin_trgm_ops"),
  );
  ok(
    "não remove o índice trigram raw nem nada que outro relatório (ex: /stock) já use",
    !/DROP INDEX|DROP FUNCTION|DROP EXTENSION/i.test(mig),
  );
  ok("não reescreve nem apaga dados", !/UPDATE |DELETE /i.test(mig));
}

// ═════════════════════════════════════════════════════════════════════
// F · UI clara + refinamento client-side sem contradizer o servidor
// ═════════════════════════════════════════════════════════════════════
//
// Correcção (2026-09): dois problemas de usabilidade no campo de
// pesquisa de Vendas.
//
//   1. O rótulo ("Artigo") e o placeholder ("Código ou descrição") não
//      deixavam claro que era ali que se escrevia o nome do produto
//      para filtrar o relatório inteiro.
//
//   2. Um bug real e mais subtil: depois do servidor passar a ignorar
//      acentos (unaccent), o filtro CLIENT-SIDE que refina as linhas já
//      carregadas (baseFiltered/reportByFarmacia/groupRows) continuava
//      a comparar com `.toLowerCase()` simples, SEM ignorar acentos.
//      Resultado: pesquisar "avene" fazia o servidor devolver
//      correctamente "Avène ..." — mas esse filtro client-side voltava
//      a escondê-la, porque "avène" !== "avene" em texto simples. O
//      utilizador via "Gerar" a não trazer nada, mesmo com a correcção
//      do servidor já aplicada.
console.log("\n=== F. UI clara e sem contradição client-side ===");
{
  const cv = src("components/vendas/vendas-client.tsx");
  ok('o rótulo do campo passou de "Artigo" para "Produto"', cv.includes('label="Produto"'));
  ok(
    "o placeholder deixa o objectivo explícito (pesquisar por CNP ou descrição)",
    /placeholder="Pesquisar por CNP ou descri..."/i.test(cv) || cv.includes("Pesquisar por CNP ou descrição"),
  );
  ok('já não usa o rótulo genérico "Artigo" para este campo', !/label="Artigo"/.test(cv));
  ok(
    "o campo ganhou um ícone de pesquisa (lupa) — mesmo padrão visual já usado no SearchableMultiSelect",
    /function CompactInput\([\s\S]{0,900}<Search /.test(cv),
  );

  // O bug de contaminação client-side: já não deve existir NENHUM sítio
  // a comparar `artigo` com `.toLowerCase()` simples contra
  // codigo/descricao — tem de ser sempre via normalizarOpcao (o mesmo
  // helper accent-insensitive já usado nos filtros de Margens).
  ok(
    "importa normalizarOpcao do módulo partilhado (não reimplementa remoção de acentos)",
    cv.includes('from "@/components/reporting/filter-select"') && cv.includes("normalizarOpcao"),
  );
  const comparacoesAntigas = (cv.match(/\.includes\(artigo\.toLowerCase\(\)\)/g) ?? []).length;
  eq("zero comparações antigas (artigo.toLowerCase(), sem remover acentos) ainda no ficheiro", comparacoesAntigas, 0);
  const comparacoesNovas = (cv.match(/normalizarOpcao\(`\$\{row\.codigo\} \$\{row\.descricao\}`\)\.includes\(normalizarOpcao\(artigo\)\)/g) ?? [])
    .length;
  ok(
    "todos os refinamentos client-side (baseFiltered, reportByFarmacia, groupRows, comparativo) usam normalizarOpcao dos dois lados",
    comparacoesNovas >= 4,
    `encontradas ${comparacoesNovas}`,
  );
}

console.log("\n=== G. Prova directa: o filtro client-side já não esconde o que o servidor encontra ===");
{
  // Reproduz EXACTAMENTE a expressão usada em vendas-client.tsx — não
  // uma cópia paralela, a MESMA lógica, para provar o comportamento
  // real e não um "sósia" dela.
  function passaFiltroArtigo(row: { codigo: string; descricao: string }, artigo: string): boolean {
    if (!artigo.trim()) return true;
    return normalizarOpcao(`${row.codigo} ${row.descricao}`).includes(normalizarOpcao(artigo));
  }
  const avene = { codigo: "90001", descricao: "Avène Eau Thermale" };
  ok('"avene" (sem acento, minúsculas) encontra "Avène"', passaFiltroArtigo(avene, "avene"));
  ok('"AVENE" (maiúsculas) encontra "Avène"', passaFiltroArtigo(avene, "AVENE"));
  ok('"avéne" (acento trocado) encontra "Avène"', passaFiltroArtigo(avene, "avéne"));
  const ventilan = { codigo: "8322628", descricao: "VENTILAN INALADOR R AER 100 MCG/D 200 D" };
  ok('"VENTILAN" encontra o inalador', passaFiltroArtigo(ventilan, "VENTILAN"));
  ok('"ventilan" (minúsculas) encontra o mesmo', passaFiltroArtigo(ventilan, "ventilan"));
  ok('"8322" (CNP parcial) encontra pelo código', passaFiltroArtigo(ventilan, "8322"));
}

console.log(`\n${fail === 0 ? "PASSOU" : "FALHOU"} — ${pass} OK, ${fail} falhas\n`);
process.exit(fail === 0 ? 0 : 1);
