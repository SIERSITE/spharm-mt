/**
 * scripts/tests/test-filtros-estado-inicial.ts
 *
 * «Incluir stock sem vendas» (`apenasComStock`) e os restantes interruptores de movimento têm UM
 * estado inicial, definido num só sítio (`lib/reporting/estado-inicial-movimento.ts`), e «Limpar
 * filtros» repõe EXACTAMENTE esse estado — em Vendas e na Manutenção em massa.
 *
 * Antes: Vendas abria com `apenasComStock: true` mas «Limpar filtros» repunha `false`.
 *
 * Verificações estáticas sobre o código-fonte + puras sobre a normalização do filtro. O
 * comportamento no browser (abrir, ligar/desligar, limpar, query do servidor) está em
 * `scripts/e2e/manutencao-massa-silveira-browser.ts` (Passo 2 e 3k).
 */
import { readFileSync } from "node:fs";
import Module from "node:module";

const M = Module as unknown as { _resolveFilename: (r: string, ...a: unknown[]) => string };
const resolverOriginal = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "server-only" ? __filename : resolverOriginal.call(this, request, ...rest);
};

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string, detalhe?: string) {
  if (cond) { passed++; console.log(`  [OK]    ${msg}`); }
  else { failed++; console.log(`  [FALHA] ${msg}${detalhe ? `\n            ${detalhe}` : ""}`); }
}
const src = (f: string) => readFileSync(f, "utf8").replace(/\r\n/g, "\n");

async function main() {
  const { ESTADO_INICIAL_MOVIMENTO } = await import("../../lib/reporting/estado-inicial-movimento");
  const { DEFAULTS_MOVIMENTO, normalizarFiltro } = await import("../../lib/catalogo/manutencao-massa-filtro");
  const { DEFAULT_INCLUIR_CREDITO, DEFAULT_INCLUIR_TRANSFERENCIAS } = await import("../../lib/reporting/natureza-venda");

  console.log("\nA · fonte única do estado inicial");
  check(ESTADO_INICIAL_MOVIMENTO.apenasComStock === true, "A1: «Incluir stock sem vendas» nasce LIGADO (decisão 2026-09: não depender de o utilizador se lembrar)");
  check(ESTADO_INICIAL_MOVIMENTO.incluirManutencao === false, "A2: «Incluir manutenção de vendas» nasce desligado");
  check(ESTADO_INICIAL_MOVIMENTO.incluirCredito === DEFAULT_INCLUIR_CREDITO && ESTADO_INICIAL_MOVIMENTO.incluirTransferencias === DEFAULT_INCLUIR_TRANSFERENCIAS, "A3: crédito e transferências seguem os defaults de natureza-venda");
  check(DEFAULTS_MOVIMENTO === ESTADO_INICIAL_MOVIMENTO, "A4: a Manutenção usa o MESMO objecto (não uma cópia)");
  const nPer = normalizarFiltro({ from: "2026-01-01", to: "2026-01-31" });
  check(nPer.apenasComStock === ESTADO_INICIAL_MOVIMENTO.apenasComStock, "A5: sem o campo explícito, o filtro normalizado assume o estado inicial");

  console.log("\nV · Vendas");
  const vendas = src("components/vendas/vendas-client.tsx");
  const inicio = vendas.slice(vendas.indexOf("useState<{") > 0 ? vendas.indexOf("apenasComVendas: true") : 0, vendas.indexOf("ordenacaoTabela: null"));
  check(/apenasComStock:\s*ESTADO_INICIAL_MOVIMENTO\.apenasComStock/.test(inicio), "V1: o estado inicial de Vendas lê ESTADO_INICIAL_MOVIMENTO.apenasComStock");
  const limpar = vendas.slice(vendas.indexOf("function limparFiltros()"), vendas.indexOf("const showFarmaciaColumnInReport"));
  check(/setApenasComStock\(ESTADO_INICIAL_MOVIMENTO\.apenasComStock\)/.test(limpar), "V2: «Limpar filtros» repõe apenasComStock ao estado inicial");
  check(!/setApenasComStock\(false\)/.test(limpar), "V3: «Limpar filtros» já não força apenasComStock = false");
  check(/setIncluirManutencao\(ESTADO_INICIAL_MOVIMENTO\.incluirManutencao\)/.test(limpar), "V4: …nem incluirManutencao com um literal");
  check(/setIncluirCredito\(DEFAULT_INCLUIR_CREDITO\)/.test(limpar) && /setIncluirTransferencias\(DEFAULT_INCLUIR_TRANSFERENCIAS\)/.test(limpar), "V5: crédito/transferências repostos aos seus defaults");
  check(!/setDataInicio|setDataFim/.test(limpar), "V6: «Limpar filtros» não toca no período (é vista, não filtragem)");

  console.log("\nM · Manutenção em massa");
  const manut = src("components/catalogo/manutencao-massa-client.tsx");
  const vazio = manut.slice(manut.indexOf("const FORM_VAZIO"), manut.indexOf("function paraFiltro"));
  check(/apenasComStock:\s*DEFAULTS_MOVIMENTO\.apenasComStock/.test(vazio) && /incluirManutencao:\s*DEFAULTS_MOVIMENTO\.incluirManutencao/.test(vazio), "M1: o estado inicial da Manutenção vem de DEFAULTS_MOVIMENTO (= ESTADO_INICIAL_MOVIMENTO)");
  const limparM = manut.slice(manut.indexOf("function limparFiltros()"), manut.indexOf("const extra = ("));
  check(/\.\.\.FORM_VAZIO/.test(limparM), "M2: «Limpar filtros» repõe o estado inicial completo (FORM_VAZIO), sem manter nada de uma selecção anterior");
  check(/dataInicio:\s*prev\.dataInicio/.test(limparM) && /dataFim:\s*prev\.dataFim/.test(limparM), "M3: …excepto o período, como em Vendas");
  check(!/apenasComStock/.test(limparM), "M4: nenhum interruptor é tratado à parte — não há inconsistência possível");

  console.log("\nC · ambos partilham o painel e a regra");
  const painel = src("components/reporting/vendas-filtros.tsx");
  check(vendas.includes("VendasFiltrosPainel") && manut.includes("VendasFiltrosPainel") || vendas.includes("vendas-filtros") && manut.includes("vendas-filtros"), "C1: Vendas e Manutenção usam o mesmo módulo de painel de filtros");
  check(src("components/reporting/filter-panel.tsx").includes('role="switch"') && src("components/reporting/filter-panel.tsx").includes("aria-checked"), "C2: o interruptor expõe o estado (role=switch/aria-checked) — verificável no browser");
  void painel;
  console.log(`\n${passed} ok, ${failed} falhas`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
