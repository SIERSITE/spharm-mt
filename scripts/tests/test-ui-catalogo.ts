/**
 * scripts/tests/test-ui-catalogo.ts
 *
 * Verifica a CADEIA DE RENDERIZAÇÃO, não a presença de campos no código.
 *
 * ── O QUE FALHOU E ISTO IMPEDE ───────────────────────────────────────
 *
 * Entreguei uma matriz com ✅ em filtros de subcategoria e utilização
 * para Encomendas. O código tinha-os. Os testes passavam. O `tsc`
 * passava. E o utilizador abriu a aplicação e não os viu — porque
 * `components/encomendas/encomendas-client.tsx` NÃO É IMPORTADO POR
 * ROTA NENHUMA. Escrevi filtros para um ecrã que não existe.
 *
 * A lição não é "testar melhor os loaders": é que "o campo está no
 * ficheiro" e "o utilizador vê o campo" são afirmações diferentes, e só
 * a segunda interessa. Este teste faz a ponte:
 *
 *   rota (app/**\/page.tsx) → componente que ela renderiza → controlos
 *
 * Continua a ser análise estática — não monta o DOM. O que garante é
 * que o controlo está no componente QUE A ROTA RENDERIZA, e que nenhum
 * componente de ecrã ficou órfão sem alguém dar por isso.
 *
 * Sem base de dados e sem rede.
 *
 * Uso: npx tsx scripts/tests/test-ui-catalogo.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

let pass = 0;
let fail = 0;
const ok = (l: string) => { pass++; console.log(`  [OK]    ${l}`); };
const bad = (l: string, d?: string) => { fail++; console.log(`  [FALHA] ${l}${d ? `\n            ${d}` : ""}`); };
const check = (c: boolean, l: string, d?: string) => (c ? ok(l) : bad(l, d));

const RAIZ = new URL("../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const ler = (p: string) => readFileSync(join(RAIZ, p), "utf8");

function ficheiros(dir: string, ext: string): string[] {
  const out: string[] = [];
  const anda = (d: string) => {
    for (const e of readdirSync(join(RAIZ, d))) {
      if (e === "node_modules" || e.startsWith(".")) continue;
      const rel = `${d}/${e}`;
      if (statSync(join(RAIZ, rel)).isDirectory()) anda(rel);
      else if (e.endsWith(ext)) out.push(rel);
    }
  };
  anda(dir);
  return out;
}

/**
 * O componente que uma rota renderiza. Segue o `import` para o ficheiro
 * real — é esse passo que estava em falta na verificação anterior.
 */
function componenteDaRota(rota: string): { nome: string; caminho: string } | null {
  const src = ler(rota);
  const usado = src.match(/<([A-Z][A-Za-z0-9]*(?:Client|Bar))\b/);
  if (!usado) return null;
  const nome = usado[1]!;
  const imp = src.match(new RegExp(`import\\s*\\{[^}]*\\b${nome}\\b[^}]*\\}\\s*from\\s*"(@/[^"]+)"`));
  if (!imp) return null;
  return { nome, caminho: `${imp[1]!.replace("@/", "")}.tsx` };
}

console.log("=== cada rota renderiza mesmo um componente ===");
const ROTAS: Record<string, string[]> = {
  // rota → controlos que o utilizador TEM de conseguir ver
  "app/vendas/page.tsx": ['label="Categoria"', 'label="Subcategoria"', 'label="Utilização"'],
  "app/excessos/page.tsx": ['label="Categoria"', 'label="Subcategoria"', 'label="Utilização"'],
  "app/transferencias/page.tsx": ['label="Categoria"', 'label="Subcategoria"', 'label="Utilização"'],
  "app/stock/page.tsx": ['titulo="Categoria"', 'titulo="Subcategoria"', 'titulo="Utilização"'],
  "app/encomendas/nova/page.tsx": ['label="Categorias"', 'label="Subcategorias"', 'label="Utilizações"'],
  "app/relatorios/inventario/page.tsx": ["ReportFiltersBar"],
  "app/relatorios/margens/page.tsx": ["ReportFiltersBar"],
};

for (const [rota, controlos] of Object.entries(ROTAS)) {
  const alvo = componenteDaRota(rota);
  if (!alvo) { bad(`${rota}: não se resolveu o componente renderizado`); continue; }
  let src: string;
  try {
    src = ler(alvo.caminho);
  } catch {
    bad(`${rota} → ${alvo.nome}: ficheiro ${alvo.caminho} não existe`);
    continue;
  }
  ok(`${rota} → ${alvo.nome}`);
  for (const c of controlos) {
    check(src.includes(c), `    ${alvo.nome} renderiza ${c}`);
  }
}

console.log("\n=== a barra partilhada renderiza os dois níveis e a utilização ===");
{
  // Inventário e Margens delegam nela; se ela perder um controlo, os
  // dois perdem-no em silêncio.
  const src = ler("components/reporting/report-filters-bar.tsx");
  for (const c of ['label="Categoria"', 'label="Subcategoria"', 'label="Utilização"']) {
    check(src.includes(c), `ReportFiltersBar renderiza ${c}`);
  }
}

console.log("\n=== a ficha de artigo mostra os quatro campos ===");
{
  const src = ler("app/stock/artigo/[cnp]/page.tsx");
  for (const campo of ['label="Categoria"', 'label="Subcategoria"', 'label="Tipo de produto"', 'label="Utilizações"']) {
    check(src.includes(campo), `ficha de stock mostra ${campo}`);
  }
}
{
  const src = ler("app/catalogo/artigo/[cnp]/page.tsx");
  for (const campo of ['label: "Categoria"', 'label: "Subcategoria"', 'label: "Tipo de produto"', 'label: "Utilizações"']) {
    check(src.includes(campo), `ficha de catálogo mostra ${campo}`);
  }
  check(
    !src.includes('label: "Fonte da classificação"'),
    "…e já não chama 'Fonte da classificação' ao que é a fonte do productType",
  );
}

console.log("\n=== nenhum ecrã órfão a fingir que existe ===");
{
  // Um componente de ecrã que nenhuma rota alcança é código que parece
  // funcionalidade. Foi assim que os filtros de Encomendas foram parar a
  // lado nenhum. Os conhecidos ficam nesta lista, de propósito; um novo
  // faz o teste falhar.
  const CONHECIDOS_SEM_ROTA: Record<string, string> = {
    "components/encomendas/encomendas-client.tsx":
      "relatório de encomendas antigo; /encomendas usa OrderListClient e /encomendas/nova usa OrderCreateClient",
  };

  const rotas = ficheiros("app", "page.tsx").map((p) => ler(p)).join("\n");
  const restantes = ficheiros("components", ".tsx").map((p) => ler(p)).join("\n");
  const todos = `${rotas}\n${restantes}`;

  const clientes = ficheiros("components", ".tsx").filter((p) => /-client\.tsx$/.test(p));
  const orfaos: string[] = [];
  for (const c of clientes) {
    const modulo = c.replace(/\.tsx$/, "");
    // Importado por alguém? (o próprio ficheiro não conta)
    const outros = ficheiros("components", ".tsx")
      .filter((o) => o !== c)
      .map((o) => ler(o))
      .join("\n");
    const universo = `${rotas}\n${outros}`;
    if (!universo.includes(`@/${modulo}`)) orfaos.push(relative(".", c).replace(/\\/g, "/"));
  }
  void todos;

  for (const o of orfaos) {
    const motivo = CONHECIDOS_SEM_ROTA[o];
    check(!!motivo, `${o} sem rota — está declarado como tal?`, motivo ? undefined : "NOVO órfão: ligar a uma rota ou declarar aqui com motivo");
  }
  for (const [conhecido] of Object.entries(CONHECIDOS_SEM_ROTA)) {
    check(
      orfaos.includes(conhecido),
      `${conhecido} continua sem rota (se passou a ter, tirar da lista)`,
    );
  }
  ok(`${clientes.length} componentes de ecrã verificados, ${orfaos.length} sem rota`);
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail === 0 ? 0 : 1);
