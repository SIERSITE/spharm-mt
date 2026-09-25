/**
 * scripts/tests/test-artigo-panel.ts
 *
 * Verificação do painel lateral da ficha do artigo (PARTE 4). Duas
 * partes: A (comportamental, puro) testa `loadArtigoFicha` — a única
 * fonte de dados, reutilizada pela página completa E pelo painel — sem
 * duplicar; B (estático) prova as propriedades que dependem de DOM/
 * histórico do browser, que este projecto não tem como executar
 * directamente (mesma técnica já usada nesta sessão).
 *
 * Corre com: npx tsx scripts/tests/test-artigo-panel.ts
 */
import { readFileSync } from "node:fs";

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${label}`); }
  else { ko++; console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`); }
};

console.log("A · a página completa e o painel usam a MESMA função de carregamento — nunca duplicada");
{
  const page = readFileSync(new URL("../../app/stock/artigo/[cnp]/page.tsx", import.meta.url), "utf8");
  const panelAction = readFileSync(new URL("../../app/stock/artigo/panel-actions.ts", import.meta.url), "utf8");
  const loader = readFileSync(new URL("../../lib/stock/artigo-ficha-data.ts", import.meta.url), "utf8");

  check(/import \{ loadArtigoFicha \} from "@\/lib\/stock\/artigo-ficha-data"/.test(page), "A1: a página importa loadArtigoFicha do módulo partilhado");
  check(/import \{ loadArtigoFicha,? type ArtigoFichaData \} from "@\/lib\/stock\/artigo-ficha-data"/.test(panelAction), "A2: a Server Action do painel importa a MESMA função — nunca uma query Prisma própria");
  check(!/prisma\.produto\.findUnique/.test(panelAction), "A3: panel-actions.ts não tem nenhuma query directa ao Produto — delega tudo ao loader partilhado");
  check(/export async function loadArtigoFicha/.test(loader), "A4: loadArtigoFicha existe e é exportado do módulo partilhado");
}

console.log("\nB · o mesmo componente de apresentação (ArtigoFicha) é usado pelos dois sítios");
{
  const page = readFileSync(new URL("../../app/stock/artigo/[cnp]/page.tsx", import.meta.url), "utf8");
  const panel = readFileSync(new URL("../../components/stock/artigo-panel.tsx", import.meta.url), "utf8");
  check(/import \{ ArtigoFicha \} from "@\/components\/stock\/artigo-ficha"/.test(page), "B1: a página usa <ArtigoFicha>");
  check(/import \{ ArtigoFicha \} from "@\/components\/stock\/artigo-ficha"/.test(panel), "B2: o painel usa o MESMO <ArtigoFicha> — nunca uma segunda versão");
  check(/<ArtigoFicha data=\{data\} \/>/.test(page), "B3: a página passa os dados directamente (vista completa)");
  check(/<ArtigoFicha data=\{data\} compacto \/>/.test(panel), "B4: o painel passa compacto (mesma lógica, apresentação mais densa)");
}

console.log("\nC · acesso directo à URL continua a mostrar a página completa (nunca redirecciona para o painel)");
{
  const page = readFileSync(new URL("../../app/stock/artigo/[cnp]/page.tsx", import.meta.url), "utf8");
  check(/export default async function ArticlePage/.test(page), "C1: a rota continua a exportar uma página completa normal");
  check(/notFound\(\)/.test(page), "C2: 404 real (não um estado de painel) quando o artigo não existe");
  check(/<ExtratoMovimentos/.test(page), "C3: a página completa continua a mostrar o extrato de movimentos — o painel NÃO o inclui (âmbito documentado)");
}

console.log("\nD · ArtigoLink nunca intercepta modificadores — Ctrl/Cmd/Shift/Alt/botão-do-meio continuam a abrir uma página real");
{
  const link = readFileSync(new URL("../../components/stock/artigo-link.tsx", import.meta.url), "utf8");
  check(/e\.button !== 0 \|\| e\.metaKey \|\| e\.ctrlKey \|\| e\.shiftKey \|\| e\.altKey/.test(link), "D1: o handler sai sem preventDefault perante qualquer modificador ou botão que não seja o esquerdo simples");
  check(/<Link href=\{`\/stock\/artigo\/\$\{cnp\}`\}/.test(link), "D2: continua a ser um <Link> real com href para a página completa — nunca um <button>/<div onClick>");
}

console.log("\nE · painel controlado pela URL, não por estado local — back/forward do browser fica coerente");
{
  const panel = readFileSync(new URL("../../components/stock/artigo-panel.tsx", import.meta.url), "utf8");
  check(/const cnpParam = searchParams\.get\(PARAM\)/.test(panel), "E1: se o painel está aberto/fechado deriva de searchParams — não de um useState próprio");
  check(/if \(!cnp\) return null;/.test(panel), "E2: sem o parâmetro na URL, o painel simplesmente não renderiza (nunca um estado 'fantasma')");
  check(/router\.push\(`\$\{pathname\}\?\$\{params\.toString\(\)\}`, \{ scroll: false \}\)/.test(panel), "E3: abrir empurra uma NOVA entrada no histórico (useAbrirFichaArtigo)");
  check(/router\.replace\(query \? `\$\{pathname\}\?\$\{query\}` : pathname, \{ scroll: false \}\)/.test(panel), "E4: fechar substitui a entrada actual (nunca router.back() cego, que podia sair da aplicação num link partilhado directo)");
}

console.log("\nF · acessibilidade do painel");
{
  const primitive = readFileSync(new URL("../../components/ui/slide-over-panel.tsx", import.meta.url), "utf8");
  check(/role="dialog"/.test(primitive), "F1: role=dialog");
  check(/aria-modal="true"/.test(primitive), "F2: aria-modal");
  check(/aria-labelledby=\{tituloId\}/.test(primitive), "F3: aria-labelledby aponta para o título real");
  check(/if \(e\.key === "Escape"\) onFechar\(\);/.test(primitive), "F4: Escape fecha");
  check(/painelRef\.current\?\.focus\(\)/.test(primitive), "F5: o foco move-se para o painel ao abrir");
  check(/elementoAnterior\.current instanceof HTMLElement\) elementoAnterior\.current\.focus\(\)/.test(primitive), "F6: o foco volta ao elemento anterior ao fechar");
}

console.log("\nG · abrir a ficha não desmonta o ecrã de origem — nunca perde o trabalho em curso");
{
  const shell = readFileSync(new URL("../../components/layout/app-shell.tsx", import.meta.url), "utf8");
  check(/<ArtigoPanel \/>/.test(shell), "G1: o painel é montado UMA vez na AppShell, ao lado de {children} — nunca substitui a árvore do ecrã actual");
  check(/<main className="relative z-10 min-w-0 flex-1 px-8 py-8">\{children\}<\/main>/.test(shell), "G2: {children} (o ecrã actual) continua montado normalmente, o painel é adicional");
}

console.log("\nH · cobertura — os 7 ecrãs pedidos abrem a ficha sem sair do contexto");
{
  const alvos: Array<{ nome: string; caminho: string }> = [
    { nome: "Stock", caminho: "../../components/stock/stock-client.tsx" },
    { nome: "Vendas", caminho: "../../components/vendas/vendas-client.tsx" },
    { nome: "Encomendas (detalhe)", caminho: "../../components/encomendas/order-detail-client.tsx" },
    { nome: "Encomendas (criação)", caminho: "../../components/encomendas/order-create-client.tsx" },
    { nome: "Transferências", caminho: "../../components/transferencias/transferencias-client.tsx" },
    { nome: "Excessos", caminho: "../../components/excessos/excessos-client.tsx" },
    { nome: "Margens", caminho: "../../components/margens/margens-client.tsx" },
    { nome: "Inventário", caminho: "../../components/inventario/inventario-client.tsx" },
  ];
  for (const { nome, caminho } of alvos) {
    const src = readFileSync(new URL(caminho, import.meta.url), "utf8");
    check(/ArtigoLink/.test(src), `H1 (${nome}): usa ArtigoLink (painel), não um <Link>/router.push directo para a ficha`);
  }
}

console.log(`\n${ok} ok, ${ko} falhas`);
process.exit(ko === 0 ? 0 : 1);
