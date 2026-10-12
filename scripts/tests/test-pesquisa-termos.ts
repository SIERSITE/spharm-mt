/**
 * scripts/tests/test-pesquisa-termos.ts
 *
 * Testes PUROS (sem BD) da regra de pesquisa textual de produtos:
 * `lib/reporting/pesquisa-termos.ts` (termos, correspondência client-side) e
 * a forma do predicado SQL de `lib/reporting/pesquisa-produto.ts`.
 *
 * Defeito: "parace" encontrava produtos mas "parace ciclum" devolvia zero —
 * a pesquisa procurava a frase contígua `%parace ciclum%`, que não existe
 * dentro de "PARACETAMOL CICLUM". A prova contra Postgres real está em
 * test-pesquisa-termos-db.ts.
 *
 * Corre com:  npx tsx scripts/tests/test-pesquisa-termos.ts
 */
import { readFileSync } from "node:fs";
import {
  correspondeAPesquisa,
  termosDePesquisa,
  termosDePesquisaComAcentos,
} from "../../lib/reporting/pesquisa-termos";
import { construirCondicaoPesquisa, construirPredicadoPesquisa } from "../../lib/reporting/pesquisa-produto";
import { Prisma } from "../../generated/prisma/client";

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
  ok(label, JSON.stringify(obtido) === JSON.stringify(esperado), `esperado ${JSON.stringify(esperado)}, obtido ${JSON.stringify(obtido)}`);

const PARACETAMOL = "PARACETAMOL CICLUM 650 MG 20 COMP.";

console.log("\n=== A. Termos: caixa, acentos, pontuação, espaços ===");
eq("um termo", termosDePesquisa("parace"), ["parace"]);
eq("dois termos", termosDePesquisa("parace ciclum"), ["parace", "ciclum"]);
eq("caixa e acentos", termosDePesquisa("PARÁCE   cíclum"), ["parace", "ciclum"]);
eq("pontuação separa termos", termosDePesquisa("parace, ciclum."), ["parace", "ciclum"]);
eq("barras e hífens separam termos", termosDePesquisa("mg/d  c-vit"), ["mg", "d", "c", "vit"]);
eq("NBSP e tabs são espaços", termosDePesquisa("parace \tciclum"), ["parace", "ciclum"]);
eq("termos repetidos colapsam", termosDePesquisa("parace PARACE"), ["parace"]);
eq("vazio", termosDePesquisa(""), []);
eq("só espaços", termosDePesquisa("   "), []);
eq("só pontuação", termosDePesquisa(" ,.;/ "), []);
eq("null/undefined", [termosDePesquisa(null), termosDePesquisa(undefined)], [[], []]);
eq("dígitos mantêm-se", termosDePesquisa("650 mg"), ["650", "mg"]);
eq("variante com acentos mantém-os (where do Prisma)", termosDePesquisaComAcentos("Avène  Crème"), ["avène", "crème"]);

console.log("\n=== B. Correspondência (espelho client-side) — exemplos obrigatórios ===");
ok('"parace" encontra o artigo', correspondeAPesquisa(PARACETAMOL, "parace"));
ok('"parace ciclum" encontra o artigo (o defeito)', correspondeAPesquisa(PARACETAMOL, "parace ciclum"));
ok('"ciclum parace" (ordem invertida) encontra o artigo', correspondeAPesquisa(PARACETAMOL, "ciclum parace"));
ok('"PARÁCE   cíclum" encontra o artigo', correspondeAPesquisa(PARACETAMOL, "PARÁCE   cíclum"));
ok('"parace, ciclum." (pontuação) encontra o artigo', correspondeAPesquisa(PARACETAMOL, "parace, ciclum."));
ok("correspondência parcial dentro de cada palavra", correspondeAPesquisa(PARACETAMOL, "para cicl 65"));
ok("todos os termos são obrigatórios: um termo inexistente exclui", !correspondeAPesquisa(PARACETAMOL, "parace inexistente"));
ok("outro laboratório não casa", !correspondeAPesquisa("PARACETAMOL GENERIS 650 MG 20 COMP.", "parace ciclum"));
ok("termo inexistente", !correspondeAPesquisa(PARACETAMOL, "zzzz"));
ok("pesquisa vazia aceita tudo", correspondeAPesquisa(PARACETAMOL, "  "));
ok("CNP + designação (texto da linha inclui o código)", correspondeAPesquisa(`8322628 ${PARACETAMOL}`, "8322 parace"));
ok("acentos do lado do texto também são ignorados", correspondeAPesquisa("Avène Eau Thermale", "avene thermale"));

console.log("\n=== C. Predicado SQL ===");
{
  const vazio = construirCondicaoPesquisa("   ");
  ok("pesquisa vazia ⇒ Prisma.empty", vazio.sql === Prisma.empty.sql);
  ok("predicado nulo para texto sem termos", construirPredicadoPesquisa(" ,. ") === null);

  const um = construirCondicaoPesquisa("parace");
  ok("um termo ⇒ um ILIKE", (um.sql.match(/ILIKE/g) ?? []).length === 1);
  eq("valores: %termo%", um.values, ["%parace%"]);

  const dois = construirCondicaoPesquisa("parace ciclum");
  ok("dois termos ⇒ dois ILIKE ligados por AND (não uma frase contígua)", (dois.sql.match(/ILIKE/g) ?? []).length === 2 && /ILIKE[^A]*AND unaccent_immutable/.test(dois.sql));
  eq("valores: cada termo separado, nunca a frase inteira", dois.values, ["%parace%", "%ciclum%"]);
  ok("nenhum padrão contém espaço", dois.values.every((v) => !String(v).includes(" ")));

  const invertido = construirCondicaoPesquisa("ciclum parace");
  eq("a ordem não muda o conjunto de termos", [...invertido.values].sort(), [...dois.values].sort());

  const normal = construirCondicaoPesquisa("PARÁCE   cíclum");
  eq("caixa/acentos/espaços normalizados antes do SQL", normal.values, ["%parace%", "%ciclum%"]);

  const cnp = construirCondicaoPesquisa("5880034");
  ok("termo só de dígitos também compara o CNP em texto", cnp.sql.includes('p."cnp"::text LIKE'));
  const misto = construirCondicaoPesquisa("parace 8500");
  ok("com vários termos, um número de 4+ dígitos também toca no CNP (e só ele)", (misto.sql.match(/cnp/g) ?? []).length === 1);
  const dose = construirCondicaoPesquisa("parace 650");
  ok("com vários termos, um número curto (dose) é só designação — nunca CNP", !dose.sql.includes('p."cnp"'));
  const omega = construirCondicaoPesquisa("omega 3");
  ok("«omega 3» nunca vai ao CNP (o '3' está no CNP de metade do catálogo)", !omega.sql.includes('p."cnp"'));
  ok("um único termo numérico, mesmo curto, continua a comparar o CNP", construirCondicaoPesquisa("58").sql.includes('p."cnp"::text LIKE'));

  const extra = construirCondicaoPesquisa("lab x", { colunasExtra: [Prisma.sql`f."nomeNormalizado"`] });
  ok("colunas extra entram em OR dentro de cada termo", /\(unaccent_immutable\(p\."designacao"\)[^)]*\) OR unaccent_immutable\(f\./.test(extra.sql.replace(/\s+/g, " ")) || extra.sql.includes('f."nomeNormalizado"'));

  const injeccao = construirCondicaoPesquisa("a%b_c'; DROP TABLE x;--");
  ok("input hostil nunca chega ao SQL (só parâmetros, sem % nem _ literais)", !injeccao.sql.includes("DROP") && injeccao.values.every((v) => /^%[\p{L}\p{N}]+%$/u.test(String(v))));
}

console.log("\n=== D. Todos os pontos de pesquisa usam a regra partilhada ===");
{
  const src = (p: string) => readFileSync(p, "utf8");
  ok("Vendas (pré-filtro) → construirCondicaoPesquisa", src("lib/reporting/prefiltro-produtos.ts").includes("construirCondicaoPesquisa"));
  ok("Manutenção de vendas (picker) → construirCondicaoPesquisa", src("app/vendas/manutencao/search.ts").includes("construirCondicaoPesquisa"));
  ok("Margens → módulo partilhado", src("lib/margens-data.ts").includes("lib/reporting/pesquisa-produto"));
  ok("Inventário → construirCondicaoPesquisa", src("lib/inventario-data.ts").includes("construirCondicaoPesquisa(filters.pesquisa)"));
  ok("Stock → construirPredicadoPesquisa", src("lib/stock-data.ts").includes("construirPredicadoPesquisa(q"));
  ok("Encomendas (picker) → construirPredicadoPesquisa", src("app/encomendas/nova/search.ts").includes("construirPredicadoPesquisa"));
  ok("Catálogo → condicoesPrismaPesquisa", src("lib/catalogo-data.ts").includes("condicoesPrismaPesquisa(filters.search"));
  ok("Fila de revisão (admin) → condicoesPrismaPesquisa", src("lib/admin/catalog-review-data.ts").includes("condicoesPrismaPesquisa(filters.search"));
  ok("Vendas (cliente) → correspondeAPesquisa", src("components/vendas/vendas-client.tsx").includes("correspondeAPesquisa"));
  const proibidos = [
    "lib/inventario-data.ts",
    "lib/stock-data.ts",
    "app/encomendas/nova/search.ts",
    "lib/catalogo-data.ts",
  ].filter((f) => /designacao[^\n]{0,40}(ILIKE|contains: q\b)/.test(src(f)));
  eq("nenhuma pesquisa de designação por frase inteira restante nestes ficheiros", proibidos, []);
}

console.log(`\n${fail === 0 ? "PASSOU" : "FALHOU"} — ${pass} OK, ${fail} falhas\n`);
process.exit(fail === 0 ? 0 : 1);
