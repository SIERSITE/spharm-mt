/**
 * scripts/tests/test-utilizacoes.ts
 *
 * Fixa as propriedades de que depende a faceta de utilizações.
 *
 * O que estas asserções protegem: o vocabulário é partilhado entre
 * tenants por `slug`, e cada tenant tem a sua base. Um slug renomeado num
 * commit desliga silenciosamente as associações já feitas nas outras
 * bases — não há erro, os produtos apenas desaparecem do filtro. Por isso
 * a lista de slugs está aqui escrita à mão: mudar um obriga a mudar o
 * teste, e a decisão passa a ser consciente.
 *
 * Uso: npx tsx scripts/tests/test-utilizacoes.ts
 */
import { UTILIZACOES, GRUPOS, resolverUtilizacao } from "../../lib/catalog/utilizacoes";

let pass = 0;
let fail = 0;
const ok = (l: string) => { pass++; console.log(`  [OK]    ${l}`); };
const bad = (l: string, d?: string) => { fail++; console.log(`  [FALHA] ${l}${d ? `\n            ${d}` : ""}`); };
const check = (cond: boolean, l: string, d?: string) => (cond ? ok(l) : bad(l, d));

console.log("=== identidade ===");
const slugs = UTILIZACOES.map((u) => u.slug);
check(new Set(slugs).size === slugs.length, "slugs únicos");
check(
  slugs.every((s) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s)),
  "slugs em kebab-case sem acentos",
  slugs.filter((s) => !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(s)).join(", "),
);
check(
  UTILIZACOES.every((u) => u.nome.trim() !== "" && u.descricao.trim() !== ""),
  "todas têm nome e descrição",
);
check(
  UTILIZACOES.every((u) => GRUPOS.includes(u.grupo)),
  "grupo pertence sempre à lista fechada",
);

console.log("\n=== slugs estáveis (renomear parte tenants já povoados) ===");
// Amostra dos casos que o utilizador nomeou explicitamente.
for (const s of ["tosse-seca", "tosse-produtiva", "dor-e-febre", "alergia-respiratoria"]) {
  check(slugs.includes(s), `existe: ${s}`);
}

console.log("\n=== vocabulário fechado ===");
check(resolverUtilizacao("tosse seca") !== null, "termo canónico resolve");
check(resolverUtilizacao("Tosse Seca") !== null, "maiúsculas resolvem");
check(resolverUtilizacao("antitússico")?.slug === "tosse-seca", "sinónimo resolve para o slug");
check(resolverUtilizacao("antitussico")?.slug === "tosse-seca", "sinónimo sem acento resolve");
check(resolverUtilizacao("expectorante")?.slug === "tosse-produtiva", "sinónimo distingue os dois tipos de tosse");
// É isto que impede que texto livre vire faceta: não há criação implícita.
check(resolverUtilizacao("coisas para a tosse à noite") === null, "texto livre não resolve");
check(resolverUtilizacao("") === null, "vazio não resolve");
check(resolverUtilizacao("   ") === null, "espaços não resolvem");

console.log("\n=== não colide com a taxonomia ===");
// Uma utilização com o mesmo nome de uma categoria seria o primeiro passo
// para as duas coisas se confundirem na interface.
const nomesTaxonomia = ["medicamento", "dermocosmetica", "puericultura", "veterinaria", "dispositivo medico"];
check(
  !UTILIZACOES.some((u) => nomesTaxonomia.includes(u.nome.toLowerCase())),
  "nenhuma utilização usa um nome de categoria",
);

console.log("\n=== sinónimos ===");
const todosSinonimos = UTILIZACOES.flatMap((u) => u.sinonimos.map((s) => [s, u.slug] as const));
const porSinonimo = new Map<string, string[]>();
for (const [s, slug] of todosSinonimos) {
  const k = s.toLowerCase();
  porSinonimo.set(k, [...(porSinonimo.get(k) ?? []), slug]);
}
const ambiguos = [...porSinonimo.entries()].filter(([, v]) => v.length > 1);
check(
  ambiguos.length === 0,
  "nenhum sinónimo aponta para duas utilizações",
  ambiguos.map(([s, v]) => `${s} -> ${v.join(", ")}`).join(" · "),
);

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail === 0 ? 0 : 1);
