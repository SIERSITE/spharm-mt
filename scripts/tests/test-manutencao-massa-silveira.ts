/**
 * scripts/tests/test-manutencao-massa-silveira.ts
 *
 * Testes PUROS (sem BD) da manutenção em massa do catálogo:
 *   · validação e normalização do filtro (`manutencao-massa-filtro.ts`);
 *   · selecção («todos menos», manual, chaves forjadas) — nunca alarga;
 *   · snapshot/hash do preview — estável, sensível a tudo o que importa;
 *   · o filtro usa o vocabulário de Vendas (mesmos nomes que SharedReportFilters);
 *   · estrutura: tenant, menu, reutilização dos componentes de Vendas.
 *
 * Os comportamentos contra Postgres estão em
 * `test-manutencao-massa-silveira-db.ts` e `test-manutencao-massa-filtros-db.ts`.
 *
 * Uso: npx tsx scripts/tests/test-manutencao-massa-silveira.ts
 */
import Module from "node:module";
import { readFileSync } from "node:fs";

const MM = Module as unknown as { _resolveFilename: (r: string, ...a: unknown[]) => string };
const resolverOriginal = MM._resolveFilename;
MM._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "server-only" ? __filename : resolverOriginal.call(this, request, ...rest);
};

let pass = 0;
let fail = 0;
function check(cond: boolean, msg: string) {
  if (cond) { pass++; console.log(`  [OK]    ${msg}`); }
  else { fail++; console.log(`  [FALHA] ${msg}`); }
}
const src = (f: string) => readFileSync(f, "utf8").replace(/\r\n/g, "\n");

async function main() {
  const F = await import("../../lib/catalogo/manutencao-massa-filtro");
  const { hashSnapshot } = await import("../../lib/catalogo/manutencao-massa");

  console.log("\n=== validarFiltro ===");
  check(F.validarFiltro("FABRICANTE", {}) === null, "FABRICANTE sem filtros é válido (todo o catálogo)");
  check(F.validarFiltro("FORNECEDOR", {}) !== null, "FORNECEDOR sem farmácia é inválido");
  check(F.validarFiltro("FORNECEDOR", { farmaciaIds: [] }) !== null, "FORNECEDOR com lista de farmácias vazia é inválido");
  check(F.validarFiltro("FORNECEDOR", { farmaciaIds: ["f1"] }) === null, "FORNECEDOR com uma farmácia é válido");
  check(F.validarFiltro("FORNECEDOR", { farmaciaIds: ["f1", "f2"] }) === null, "FORNECEDOR com duas farmácias explícitas é válido");
  check(F.validarFiltro("FORNECEDOR", { farmaciaIds: ["f1"], fabricanteDivergente: true }) !== null, "«fabricante divergente» só existe em FABRICANTE");
  check(F.validarFiltro("FABRICANTE", { fornecedorAtualIds: ["x"] }) !== null, "fornecedor actual não se aplica a FABRICANTE");
  check(F.validarFiltro("FABRICANTE", { semFornecedor: true }) !== null, "«sem fornecedor» não se aplica a FABRICANTE");
  check(F.validarFiltro("FABRICANTE", { fabricanteAtualIds: ["a"], semFabricante: true }) === null, "fabricante actual + «sem fabricante» = OU, válido");
  check(F.validarFiltro("FABRICANTE", { from: "2026-01-01" }) !== null, "período exige início E fim");
  check(F.validarFiltro("FABRICANTE", { from: "2026-01-01", to: "2026-02-xx" }) !== null, "datas inválidas são recusadas");
  check(F.validarFiltro("FABRICANTE", { from: "2026-01-01", to: "2026-01-31" }) === null, "período completo é válido");
  check(F.validarFiltro("FORNECEDOR", { farmaciaIds: ["f1"], fornecedorAtualIds: ["x"], semFornecedor: true }) === null, "fornecedor actual + «sem fornecedor» = OU, válido");

  console.log("\n=== normalizarFiltro (forma canónica) ===");
  const n1 = F.normalizarFiltro({ categorias: ["B", "A", "A", " "], pesquisa: "  x  ", farmaciaIds: ["z", "a"], semFabricante: false, fabricanteAtualIds: [] });
  check(JSON.stringify(n1) === JSON.stringify({ farmaciaIds: ["a", "z"], pesquisa: "x", categorias: ["A", "B"] }), "arrays únicos e ordenados; vazios/false omitidos; strings aparadas");
  check(JSON.stringify(F.normalizarFiltro({ categorias: ["B", "A"] })) === JSON.stringify(F.normalizarFiltro({ categorias: ["A", "B", "A"] })), "filtros equivalentes têm o MESMO JSON");
  check(F.normalizarFiltro({ cnps: [] }).cnps?.length === 0, "lista de CNP vazia é PRESERVADA (filtra para zero)");
  check(F.normalizarFiltro({}).cnps === undefined, "sem lista de CNP continua sem restrição");
  const nPer = F.normalizarFiltro({ from: "2026-01-01", to: "2026-01-31" });
  check(nPer.incluirCredito === true && nPer.incluirTransferencias === false && nPer.apenasComStock === true && nPer.incluirManutencao === false, "com período, os interruptores assumem os defaults de Vendas");
  check(F.normalizarFiltro({ incluirCredito: false }).incluirCredito === undefined, "sem período, os interruptores de movimento não entram no filtro");
  check(F.periodoActivo({ from: "2026-01-01", to: "2026-01-31" }) && !F.periodoActivo({ from: "2026-01-01" }), "período só activo com as duas datas");

  console.log("\n=== chaveAlvo / aplicarSelecao ===");
  const alvos = ["a", "b", "c", "d"].map((p) => ({ chave: F.chaveAlvo(p, null), p }));
  check(F.chaveAlvo("p", "f") === "p|f" && F.chaveAlvo("p", null) === "p", "chave: produto|farmácia ou só produto");
  check(F.aplicarSelecao(alvos, undefined).length === 4, "sem selecção = todos");
  check(F.aplicarSelecao(alvos, { modo: "todos" }).length === 4, "«todos» = todos");
  check(F.aplicarSelecao(alvos, { modo: "todos", excluidas: ["b"] }).map((a) => a.p).join("") === "acd", "«todos menos b»");
  check(F.aplicarSelecao(alvos, { modo: "manual", chaves: ["a", "c"] }).map((a) => a.p).join("") === "ac", "manual: só as escolhidas");
  check(F.aplicarSelecao(alvos, { modo: "manual", chaves: ["a", "x-forjada", "z"] }).map((a) => a.p).join("") === "a", "chaves forjadas / fora do filtro são IGNORADAS — nunca alargam");
  check(F.aplicarSelecao(alvos, { modo: "manual", chaves: [] }).length === 0, "manual vazio = nada");
  check(F.aplicarSelecao(alvos, { modo: "todos", excluidas: ["x"] }).length === 4, "excluir uma chave inexistente não muda nada");

  console.log("\n=== hashSnapshot ===");
  const A = [
    { chave: "p1", produtoId: "p1", farmaciaId: null, valorAnteriorId: "fabA" },
    { chave: "p2", produtoId: "p2", farmaciaId: null, valorAnteriorId: null },
  ];
  const h1 = hashSnapshot("FABRICANTE", { categorias: ["X"] }, A);
  check(/^[0-9a-f]{64}$/.test(h1), "SHA-256 em hexadecimal");
  check(h1 === hashSnapshot("FABRICANTE", { categorias: ["X", "X"] }, [...A].reverse()), "estável: independente da ordem dos alvos e da forma do filtro");
  check(h1 !== hashSnapshot("FABRICANTE", { categorias: ["Y"] }, A), "muda se o filtro mudar");
  check(h1 !== hashSnapshot("FORNECEDOR", { categorias: ["X"] }, A), "muda com o tipo");
  check(h1 !== hashSnapshot("FABRICANTE", { categorias: ["X"] }, A.slice(0, 1)), "muda se um produto sair do conjunto");
  check(h1 !== hashSnapshot("FABRICANTE", { categorias: ["X"] }, [A[0], { ...A[1], valorAnteriorId: "fabB" }]), "muda se o VALOR ANTERIOR de um produto mudar");
  check(h1 !== hashSnapshot("FABRICANTE", { categorias: ["X"] }, [...A, { chave: "p3", produtoId: "p3", farmaciaId: null, valorAnteriorId: null }]), "muda se um produto entrar no conjunto");

  console.log("\n=== o filtro usa o vocabulário e as funções de Vendas ===");
  const filtroSrc = src("lib/catalogo/manutencao-massa-filtro.ts");
  for (const campo of ["pesquisa", "cnps", "categorias", "subcategorias", "utilizacoes", "distribuidores", "apenasSemClassif", "incluirCredito", "incluirTransferencias", "apenasComStock", "incluirManutencao"]) {
    check(new RegExp(`\\b${campo}\\?:`).test(filtroSrc), `o filtro tem «${campo}» (mesmo nome que SharedReportFilters)`);
  }
  const lib = src("lib/catalogo/manutencao-massa.ts");
  check(lib.includes("resolverPrefiltroProdutos(prisma"), "o universo usa o pré-filtro partilhado de Vendas");
  check(lib.includes("getVendasData("), "o período usa o MESMO loader de Vendas (getVendasData)");
  check(src("lib/vendas-data.ts").includes("resolverPrefiltroProdutos(prisma, filters)"), "…e Vendas usa esse mesmo pré-filtro (uma só implementação)");
  const vendasFiltros = src("components/reporting/vendas-filtros.tsx");
  const cliente = src("components/catalogo/manutencao-massa-client.tsx");
  const vendasCliente = src("components/vendas/vendas-client.tsx");
  check(vendasCliente.includes("VendasFiltrosPainel") && vendasCliente.includes("CompactInput") && !/function CompactInput/.test(vendasCliente), "Vendas usa o painel/campos extraídos (não tem cópia própria)");
  check(cliente.includes("VendasFiltrosPainel") && cliente.includes("CompactInput") && cliente.includes("CompactDate"), "a manutenção usa os MESMOS componentes de filtro de Vendas");
  check(/FiltrosToggleButton/.test(cliente) && /LimparFiltrosButton/.test(cliente), "…e o mesmo botão de abrir/fechar filtros e de limpar");
  check(vendasFiltros.includes("alternarValor") && vendasFiltros.includes("FilterPill") && vendasFiltros.includes("ImportListaCodigos"), "o painel partilhado traz toggle, chips e lista importada");
  check(!/<select[^>]*>\s*<option value="">Seleccione/.test(cliente) && !cliente.includes("Designação contém"), "já não existe o painel simplificado antigo (CNP / designação / selects soltos)");
  check(cliente.includes("Fabricante actual") && cliente.includes("Fornecedor habitual atual") && cliente.includes("DESTINO"), "valor actual e valor de DESTINO são controlos separados e rotulados");

  console.log("\n=== tenant e menu ===");
  const consts = src("lib/tenant-constants.ts");
  check(/TENANT_CATALOGO_MASSA = "silveira"/.test(consts), "a constante vive no módulo simples (lib/tenant-constants.ts)");
  check(!/next\/headers|server-only|@\/lib\/prisma|node:/.test(consts.replace(/\/\*[\s\S]*?\*\//g, "")), "…sem next/headers, server-only, Prisma ou Node");
  check(/export \{[^}]*TENANT_CATALOGO_MASSA[^}]*\} from "@\/lib\/tenant-constants"/.test(src("lib/tenant-context.ts")), "tenant-context re-exporta (imports antigos continuam a funcionar)");
  const shell = src("components/layout/app-shell.tsx");
  check(shell.includes('from "@/lib/tenant-constants"') && shell.includes("soTenant: TENANT_CATALOGO_MASSA"), "o AppShell usa a constante (não repete a string)");
  check(!/["']silveira["']/.test(shell.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")), "o AppShell não contém a string \"silveira\"");
  check(/label: "Catálogo", href: "\/catalogo"[\s\S]{0,400}label: "Manutenção do catálogo", href: "\/catalogo\/manutencao"/.test(shell), "«Manutenção do catálogo» aparece imediatamente abaixo de «Catálogo»");
  check(/\(!i\.soTenant \|\| utilizador\?\.tenant === i\.soTenant\)/.test(shell), "o item só aparece quando utilizador.tenant === constante");
  const acoes = src("app/catalogo/manutencao/actions.ts");
  const corpos = acoes.split(/^export async function /m).slice(1);
  const guardada = corpos.filter((c) => c.includes("await guardaBase()") || /(previewAction|aplicarAction)\(/.test(c));
  check(corpos.length > 0 && guardada.length === corpos.length, `todas as ${corpos.length} server actions passam por guardaBase() (directamente ou via previewAction/aplicarAction) antes de qualquer query`);
  const auxiliares = acoes.split(/^async function /m).slice(1).filter((c) => /^(previewAction|aplicarAction)\b/.test(c));
  check(auxiliares.length === 2 && auxiliares.every((c) => c.includes("await guardaBase()")), "…e previewAction/aplicarAction chamam guardaBase()");
  const pagina = src("app/catalogo/manutencao/page.tsx");
  check(pagina.indexOf("notFound()") > 0 && pagina.indexOf("notFound()") < pagina.indexOf("getPrisma()"), "a página recusa o tenant ANTES de qualquer query");

  console.log(`\n${pass} ok, ${fail} falhas`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
