/**
 * O Inventário mantém o comportamento do base (a69cbc5): só gera em «Gerar»; só difere em forma farmacêutica.
 * Ver notes/inventario-decisao.md.  Executar: npx tsx scripts/tests/test-inventario-inalterado.ts
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const BASE = "a69cbc5";
let ok = 0;
let ko = 0;
function check(c: boolean, m: string) {
  if (c) { ok++; console.log("  ok  " + m); } else { ko++; console.log("  FALHA " + m); }
}
const lf = (s: string) => s.replace(/\r\n/g, "\n");
const atual = (p: string) => lf(readFileSync(p, "utf8"));
function noBase(p: string): string | null {
  try { return lf(execFileSync("git", ["show", `${BASE}:${p}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })); } catch { return null; }
}
/** Linhas acrescentadas/removidas em relação ao base (multiconjunto simples; suficiente para o que se afirma). */
function diferenca(a: string, b: string) {
  const conta = (s: string) => { const m = new Map<string, number>(); for (const l of s.split("\n")) m.set(l.trim(), (m.get(l.trim()) ?? 0) + 1); return m; };
  const ma = conta(a), mb = conta(b);
  const mais: string[] = [], menos: string[] = [];
  for (const [l, n] of mb) if (n > (ma.get(l) ?? 0)) mais.push(l);
  for (const [l, n] of ma) if (n > (mb.get(l) ?? 0)) menos.push(l);
  return { mais: mais.filter((l) => l), menos: menos.filter((l) => l) };
}

const CLIENTE = "components/inventario/inventario-client.tsx";
const src = atual(CLIENTE);

console.log("\nA · estrutura do cliente (comportamento do base)");
check(!/filtrosResultado|filtrosDiferem|iniciarGeracao|geracaoAtual|filtros-aplicados/.test(src), "A1: sem estado draft/aplicado nem sequência de gerações");
check(!/alteracoes-por-aplicar|alterações por aplicar/.test(src), "A2: sem indicação «alterações por aplicar»");
check(!/"Atualizar"/.test(src) && /: "Gerar"\}/.test(src), "A3: o botão é «Gerar» (nunca «Atualizar»)");
check((src.match(/runInventarioReport\(/g) ?? []).length === 1, "A4: runInventarioReport só é chamado em handleGerar");
const efeitos = [...src.matchAll(/useEffect\(\(\) => \{([\s\S]*?)\n  \}, \[/g)].map((m) => m[1]);
check(efeitos.every((e) => !e.includes("runInventarioReport") && !e.includes("handleGerar")), "A5: nenhum useEffect gera o relatório (sem auto-regeneração)");
check(/onClick=\{handleGerar\}/.test(src), "A6: handleGerar só ligado ao botão");
check(/const r = await runInventarioReport\(filters\);/.test(src), "A7: o pedido envia os filtros do formulário (como no base)");

console.log("\nB · diferença em relação ao base");
const base = noBase(CLIENTE);
if (base === null) {
  console.log(`  (base ${BASE} indisponível — secção B ignorada)`);
} else {
  const d = diferenca(base, src);
  check(d.menos.length === 0, `B1: o cliente não remove nada do base (${d.menos.length} removidas)`);
  check(d.mais.length === 2 && d.mais.every((l) => /^formas: (filterOptions|universe)\.formas,$/.test(l)), `B2: as únicas linhas novas são as da forma farmacêutica (${JSON.stringify(d.mais)})`);
  const adap = "lib/reporting/adapters/inventario.ts";
  const da = diferenca(noBase(adap) ?? "", atual(adap));
  check(da.menos.length === 0, "B3: o adapter do Inventário não remove nada do base");
  check(da.mais.every((l) => /forma|Forma|OpcaoFormaFarmaceutica|^\/\*\*|^\}|^\)|^\{/.test(l) || l === "if (forma) out.push(forma);"), `B4: o adapter só ganha código de forma farmacêutica (${da.mais.length} linhas)`);
  const data = "lib/inventario-data.ts";
  const dd = diferenca(noBase(data) ?? "", atual(data));
  check(dd.mais.length === 0 && dd.menos.length === 0, "B5: lib/inventario-data.ts idêntico ao base");
}

console.log("\nC · barra partilhada não impõe nada ao Inventário");
const barra = atual("components/reporting/report-filters-bar.tsx");
check(!/alteracoesPorAplicar|porAplicar|filtrosResultado|filtros-aplicados/.test(barra), "C1: ReportFiltersBar não conhece «por aplicar» (a indicação é do cliente de cada mapa)");
check(/options\.formas &&/.test(barra), "C2: o filtro de forma aparece só quando as opções de forma são passadas");
check(/formas: filterOptions\.formas/.test(src), "C3: o Inventário passa as opções de forma à barra");

console.log(`\n${ok} ok, ${ko} falhas`);
process.exit(ko > 0 ? 1 : 0);
