/**
 * scripts/tests/test-workspace-separadores.ts
 *
 * O mecanismo GLOBAL de estado por separador (não é específico de nenhuma página): armazém em memória, identidade dos
 * separadores, localização completa, reducers da barra e garantias estruturais (nenhuma página persiste resultados em
 * storage do browser; o armazém é a única via). O comportamento no browser (preservar/restaurar, isolamento, fecho,
 * logout, scroll, «Voltar a…») prova-se em scripts/e2e/workspace-separadores-browser.ts.
 *
 * Corre com:  npx tsx scripts/tests/test-workspace-separadores.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { estadoSeparadores } from "../../lib/workspace/armazem-separadores";
import { declararPendente } from "../../lib/workspace/pendentes";
import { identidadeDoSeparador, hrefDoSeparador, resolverRota, ROTAS } from "../../lib/workspace/rotas";
import { reduzirHref, reduzirSujo, reduzirTitulo, type EstadoPersistido } from "../../lib/workspace/task-bar-context";

let pass = 0;
let fail = 0;
const ok = (label: string, cond: boolean, detalhe?: string) => {
  if (cond) { pass++; console.log(`  [OK]    ${label}`); }
  else { fail++; console.log(`  [FALHA] ${label}${detalhe ? ` — ${detalhe}` : ""}`); }
};

console.log("\n=== A. Armazém em memória: isolamento por escopo e por separador ===");
{
  estadoSeparadores.limparTudo();
  const grande = Array.from({ length: 50_000 }, (_, i) => ({ i }));
  estadoSeparadores.escrever("t1:u1", "/vendas?workspace=A", "rows", grande);
  estadoSeparadores.escrever("t1:u1", "/vendas?workspace=B", "rows", [{ i: 1 }]);
  estadoSeparadores.escrever("t2:u9", "/vendas?workspace=A", "rows", [{ i: 9 }]);
  ok("a mesma rota com `workspace` diferente tem estados independentes", estadoSeparadores.ler<unknown[]>("t1:u1", "/vendas?workspace=A", "rows")!.length === 50_000 && estadoSeparadores.ler<unknown[]>("t1:u1", "/vendas?workspace=B", "rows")!.length === 1);
  ok("o mesmo separador noutro tenant/utilizador NÃO partilha estado", (estadoSeparadores.ler<unknown[]>("t2:u9", "/vendas?workspace=A", "rows")![0] as { i: number }).i === 9);
  ok("guarda a MESMA referência (sem cópia/serialização): resultados grandes não pagam JSON nem quota", estadoSeparadores.ler("t1:u1", "/vendas?workspace=A", "rows") === grande);
  ok("`tem` distingue «sem valor» de «valor falsy»", (() => { estadoSeparadores.escrever("t1:u1", "/x", "n", 0); return estadoSeparadores.tem("t1:u1", "/x", "n") && !estadoSeparadores.tem("t1:u1", "/x", "outra"); })());
  estadoSeparadores.apagar("t1:u1", "/x", "n");
  ok("`apagar` remove só a chave", !estadoSeparadores.tem("t1:u1", "/x", "n"));
}

console.log("\n=== B. Ciclo de vida: fechar, evicção, logout, mudança de tenant ===");
{
  estadoSeparadores.limparTudo();
  const e = "t1:u1";
  for (const id of ["/vendas?workspace=A", "/vendas?workspace=B", "/relatorios/margens?workspace=C"]) estadoSeparadores.escrever(e, id, "k", 1);
  estadoSeparadores.limparSeparador(e, "/vendas?workspace=B");
  ok("fechar um separador liberta o SEU estado e só o seu", !estadoSeparadores.tem(e, "/vendas?workspace=B", "k") && estadoSeparadores.tem(e, "/vendas?workspace=A", "k") && estadoSeparadores.tem(e, "/relatorios/margens?workspace=C", "k"));
  ok("reabrir (id novo) começa limpo — não herda estado do separador fechado", estadoSeparadores.ler(e, "/vendas?workspace=B", "k") === undefined);
  estadoSeparadores.manterApenas(e, new Set(["/vendas?workspace=A"]));
  ok("evicção/«fechar todos»: manterApenas liberta os separadores que já não existem", estadoSeparadores.diagnostico().length === 1);
  estadoSeparadores.escrever("t2:u2", "/vendas?workspace=A", "k", 1);
  estadoSeparadores.limparForaDoEscopo("t2:u2");
  ok("mudar de tenant/utilizador limpa TODO o estado do escopo anterior", estadoSeparadores.diagnostico().every((d) => d.escopo === "t2:u2"));
  estadoSeparadores.limparForaDoEscopo(null);
  ok("terminar sessão (escopo nulo) limpa tudo", estadoSeparadores.diagnostico().length === 0);
  estadoSeparadores.escrever(e, "/a", "k", { segredo: 1 });
  ok("o diagnóstico expõe só identidades e nº de chaves — nunca valores", JSON.stringify(estadoSeparadores.diagnostico()) === JSON.stringify([{ escopo: e, separador: "/a", chaves: 1 }]));
  estadoSeparadores.limparTudo();
}

console.log("\n=== C. Identidade e localização dos separadores ===");
{
  ok("módulo de relatório: identidade = rota + ?workspace=", identidadeDoSeparador("/vendas", "w1") === "/vendas?workspace=w1" && identidadeDoSeparador("/relatorios/margens", "w2") === "/relatorios/margens?workspace=w2");
  ok("módulo de relatório sem workspace ainda: sem identidade (a barra gera o id)", identidadeDoSeparador("/vendas", null) === null);
  ok("outras rotas: a identidade é o pathname (uma encomenda/ficha por separador)", identidadeDoSeparador("/encomendas/abc", null) === "/encomendas/abc" && identidadeDoSeparador("/stock/artigo/123", null) === "/stock/artigo/123");
  ok("rotas fora do workspace (login/admin) não são separadores", identidadeDoSeparador("/login", null) === null && resolverRota("/admin/x") === null);
  ok("`/vendas/manutencao` não é confundido com `/vendas` (prefixo mais específico primeiro)", resolverRota("/vendas/manutencao")?.tipo === "vendas-manutencao" && resolverRota("/vendas")?.tipo === "vendas");
  ok("`/catalogo/artigo/x` e `/catalogo/manutencao` têm separador próprio", resolverRota("/catalogo/artigo/x")?.tipo === "artigo-catalogo" && resolverRota("/catalogo/manutencao")?.tipo === "catalogo-manutencao");
  ok("só 5 módulos têm sessões de análise isoladas", ROTAS.filter((r) => r.workspace).map((r) => r.tipo).sort().join() === "excessos,inventario,margens,transferencias,vendas");
  ok("a localização completa mantém pesquisa/página/ordenação e o workspace…", hrefDoSeparador("/catalogo", new URLSearchParams("search=ben&page=3&sort=nome")) === "/catalogo?search=ben&page=3&sort=nome" && hrefDoSeparador("/vendas", new URLSearchParams("workspace=w1")) === "/vendas?workspace=w1");
  ok("…e descarta o painel lateral transitório `ficha`", hrefDoSeparador("/vendas", new URLSearchParams("workspace=w1&ficha=7608059")) === "/vendas?workspace=w1");
}

console.log("\n=== D. Reducers da barra: sem mudança real devolvem a MESMA referência (sem ciclos de render) ===");
{
  const base: EstadoPersistido = { tarefas: [{ id: "/a", titulo: "A", tipo: "x", href: "/a", sujo: false }], activaId: "/a" };
  ok("href igual → mesma referência", reduzirHref(base, "/a", "/a") === base);
  ok("href novo → atualiza só essa tarefa", reduzirHref(base, "/a", "/a?page=2").tarefas[0].href === "/a?page=2");
  ok("id inexistente → mesma referência", reduzirHref(base, "/z", "/z") === base && reduzirSujo(base, "/z", true) === base && reduzirTitulo(base, "/z", "Z") === base);
  ok("marcar sujo/limpo", reduzirSujo(base, "/a", true).tarefas[0].sujo === true);
}

// uso real de storage (chamadas/acessos), não menções em comentários
const USA_STORAGE = /(?:window\.)?(?:local|session)Storage\s*(?:\.|\[)/;
console.log("\n=== E. Garantias estruturais: nada de resultados em storage do browser; Vendas sem cache própria ===");
{
  const ler = (p: string) => readFileSync(p, "utf8");
  const ficheiros = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = path.join(dir, n);
      return statSync(p).isDirectory() ? ficheiros(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
    });
  const wsLib = ficheiros("lib/workspace").concat(["components/layout/scroll-separadores.tsx", "components/layout/voltar-origem.tsx"]);
  ok("o estado por separador não usa localStorage/sessionStorage (só o armazém em memória)", wsLib.filter((f) => !f.endsWith("task-bar-context.tsx") && !f.endsWith("use-workspace-state.ts")).every((f) => !USA_STORAGE.test(ler(f))));
  ok("Vendas guarda o resultado pela API comum do workspace (sem cache/persistência própria)", /useEstadoSeparador/.test(ler("components/vendas/vendas-client.tsx")) && /useEstadoSeparador<SalesReportRow\[\]>\("vendas:rows"/.test(ler("components/vendas/vendas-client.tsx")));
  const modulos = ["vendas/vendas-client", "margens/margens-client", "inventario/inventario-client", "transferencias/transferencias-client", "excessos/excessos-client", "encomendas/order-create-client", "encomendas/order-detail-client", "catalogo/catalogo-list-client", "stock/stock-client"];
  ok("todos os módulos auditados usam a MESMA API (useEstadoSeparador)", modulos.every((m) => /useEstadoSeparador/.test(ler(`components/${m}.tsx`))));
  ok("nenhum módulo repõe o resultado ao mudar de workspace (o separador re-hidrata o seu)", !/setHasGenerated\(false\);\s*\n\s*setRows\(\[\]\)/.test(ler("components/vendas/vendas-client.tsx")));
  ok("as fichas usam a navegação contextual (VoltarOrigem), não um «Voltar a Stock» fixo", /VoltarOrigem/.test(ler("app/stock/artigo/[cnp]/page.tsx")) && !/Voltar a Stock\s*\n\s*<\/Link>/.test(ler("app/stock/artigo/[cnp]/page.tsx")) && /VoltarOrigem/.test(ler("app/catalogo/artigo/[cnp]/page.tsx")));
  ok("terminar sessão avisa se QUALQUER separador tem alterações por confirmar", /tarefas\.find\(\(t\) => t\.sujo\)/.test(ler("components/layout/app-shell.tsx")));
}

console.log("\n=== P. Várias fontes de «alterações por confirmar» no mesmo separador (fabricante + designação) ===");
{
  estadoSeparadores.limparTudo();
  const E = "t1:u1", S = "/stock/artigo/7100002";
  ok("uma fonte pendente → o separador está sujo", declararPendente(E, S, "designacao", true) === true);
  ok("outra fonte declara «sem pendentes» e NÃO apaga a pendente da primeira", declararPendente(E, S, "fabricante", false) === true);
  ok("a fonte pendente resolve-se → deixa de estar sujo", declararPendente(E, S, "designacao", false) === false);
  ok("as duas pendentes → sujo; resolve uma → continua sujo; resolve a outra → limpo", declararPendente(E, S, "fabricante", true) === true && declararPendente(E, S, "designacao", true) === true && declararPendente(E, S, "fabricante", false) === true && declararPendente(E, S, "designacao", false) === false);
  ok("outro separador não é afetado", declararPendente(E, "/stock/artigo/9", "designacao", false) === false);
  estadoSeparadores.limparSeparador(E, S);
  ok("fechar o separador liberta as declarações (um separador reaberto não nasce sujo)", declararPendente(E, S, "fabricante", false) === false);
  const ler = (f: string) => readFileSync(f, "utf8");
  const hook = ler("lib/workspace/estado-separador.ts");
  ok("o hook passa a fonte (omisso: «pagina») e os dois editores da ficha declaram fontes distintas", /useAlteracoesPendentes\(pendentes: boolean, fonte: string = FONTE_PAGINA\)/.test(hook) && /useAlteracoesPendentes\(pendente, "designacao"\)/.test(ler("components/stock/editor-designacao.tsx")) && /useAlteracoesPendentes\(pendente, "fabricante"\)/.test(ler("components/stock/editor-fabricante.tsx")));
}

console.log(`\n${fail === 0 ? "PASSOU" : "FALHOU"} — ${pass} OK, ${fail} falhas\n`);
process.exit(fail === 0 ? 0 : 1);
