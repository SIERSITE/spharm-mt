/**
 * scripts/tests/test-selecao-fornecedor-massa.ts
 *
 * Testes PUROS da selecção e atribuição colectiva de fornecedor nas encomendas
 * (`lib/encomendas/selecao-fornecedor-massa.ts`) e verificação estrutural da barra
 * e da sua ligação ao motor de persistência existente.
 *
 * Uso: npx tsx scripts/tests/test-selecao-fornecedor-massa.ts
 */
import { readFileSync } from "node:fs";
import {
  alternarPagina,
  paginar,
  resumirAtribuicao,
  selecaoValida,
  selecionarDaFarmacia,
  selecionarPrimeiras,
  selecionarSemFornecedor,
  selecionarTodas,
  type LinhaSelecionavel,
} from "../../lib/encomendas/selecao-fornecedor-massa";

let pass = 0;
let fail = 0;
function check(cond: boolean, msg: string) {
  if (cond) { pass++; console.log(`  [OK]    ${msg}`); }
  else { fail++; console.log(`  [FALHA] ${msg}`); }
}
const src = (f: string) => readFileSync(f, "utf8").replace(/\r\n/g, "\n");
const ks = (s: ReadonlySet<number>) => [...s].sort((a, b) => a - b).join(",");

// 60 linhas: farmácia A (1-30), B (31-60); produtos repetem entre farmácias; as 10 primeiras de cada têm fornecedor.
const linhas: LinhaSelecionavel[] = Array.from({ length: 60 }, (_, i) => {
  const key = i + 1;
  const emA = key <= 30;
  return {
    key,
    produtoId: `p${((key - 1) % 30) + 1}`,
    farmaciaId: emA ? "fA" : "fB",
    farmaciaNome: emA ? "Silveirense" : "Segurado",
    fornecedorSugeridoId: key % 30 !== 0 && ((key - 1) % 30) < 10 ? (emA ? "fornX" : "fornY") : null,
  };
});

console.log("\n=== âmbitos de selecção ===");
check(ks(selecionarPrimeiras(linhas, 20)) === Array.from({ length: 20 }, (_, i) => i + 1).join(","), "primeiras 20");
check(selecionarPrimeiras(linhas, 30).size === 30, "primeiras 30");
check(selecionarPrimeiras(linhas, 500).size === 60, "primeiras N maior que o total = todas");
check(selecionarPrimeiras(linhas, 0).size === 0 && selecionarPrimeiras(linhas, -3).size === 0 && selecionarPrimeiras(linhas, NaN).size === 0, "N inválido (0, negativo, NaN) = nenhuma");
check(selecionarPrimeiras(linhas.filter((l) => l.farmaciaId === "fB"), 5).has(31), "«primeiras N» respeita a ORDEM das linhas visíveis (filtradas) recebidas");
check(selecionarTodas(linhas).size === 60, "toda a encomenda");
check(selecionarSemFornecedor(linhas).size === 40, "só sem fornecedor (40)");
check(selecionarDaFarmacia(linhas, "fA").size === 30 && selecionarDaFarmacia(linhas, "fB").size === 30, "todas as linhas de uma farmácia (30 cada)");
check(selecionarDaFarmacia(linhas, "fZ").size === 0, "farmácia sem linhas = nenhuma");

console.log("\n=== página: alterna, mantém o resto ===");
const pagina1 = linhas.slice(0, 20);
const pagina2 = linhas.slice(20, 40);
const s1 = alternarPagina(new Set(), pagina1);
check(s1.size === 20, "seleccionar página 1");
const s2 = alternarPagina(s1, pagina2);
check(s2.size === 40, "seleccionar também a página 2 mantém a 1");
const s3 = alternarPagina(s2, pagina1);
check(s3.size === 20 && !s3.has(1) && s3.has(21), "desseleccionar a página 1 remove só as suas linhas");
const parcial = alternarPagina(new Set([1, 2]), pagina1);
check(parcial.size === 20, "página parcialmente seleccionada → selecciona o resto (não desselecciona)");
check(alternarPagina(new Set([5]), []).size === 1, "página vazia não altera nada");

console.log("\n=== só linhas que ainda existem ===");
check(selecaoValida(new Set([1, 2, 999]), linhas).length === 2, "uma linha removida (key inexistente) deixa de contar na selecção");

console.log("\n=== resumo antes de atribuir ===");
const sel = linhas.filter((l) => l.key <= 20 || l.key > 50); // 20 de A + 10 de B
const r = resumirAtribuicao(sel, "fornX");
check(r.linhas === 30, "linhas = 30");
check(r.produtosDistintos === 30 - 0 && r.produtosDistintos <= 30, "produtos distintos contados por produto (não por linha)");
check(r.farmacias.length === 2 && r.farmacias.find((f) => f.farmaciaNome === "Silveirense")?.linhas === 20 && r.farmacias.find((f) => f.farmaciaNome === "Segurado")?.linhas === 10, "farmácias abrangidas, com o nº de linhas de cada");
check(r.semFornecedor === sel.filter((l) => l.fornecedorSugeridoId == null).length, "sem fornecedor hoje");
check(r.jaComDestino === sel.filter((l) => l.fornecedorSugeridoId === "fornX").length, "já têm o fornecedor escolhido");
check(r.aAlterar === r.linhas - r.jaComDestino, "serão alteradas = total − já têm o destino");
const limpar = resumirAtribuicao(sel, null);
check(limpar.jaComDestino === limpar.semFornecedor && limpar.aAlterar === limpar.linhas - limpar.semFornecedor, "limpar: só se altera quem TEM fornecedor");
check(resumirAtribuicao([], "x").aAlterar === 0 && resumirAtribuicao([], "x").produtosDistintos === 0, "resumo de selecção vazia");

console.log("\n=== paginação ===");
const p = paginar(linhas, 1, 20);
check(p.fatia.length === 20 && p.totalPaginas === 3 && p.pagina === 1, "60 linhas / 20 = 3 páginas");
check(paginar(linhas, 3, 20).fatia[0].key === 41, "página 3 começa na linha 41");
check(paginar(linhas, 99, 20).pagina === 3, "página fora do intervalo é ajustada à última");
check(paginar(linhas, 0, 20).pagina === 1, "página 0 é ajustada à primeira");
check(paginar(linhas, 1, 0).fatia.length === 60 && paginar(linhas, 1, 0).totalPaginas === 1, "tamanho 0 = todas numa página");
check(paginar([], 1, 20).totalPaginas === 1 && paginar([], 1, 20).fatia.length === 0, "lista vazia = 1 página vazia");
check(paginar(linhas, 1, 50).totalPaginas === 2 && paginar(linhas, 2, 50).fatia.length === 10, "50 por página: 2 páginas, a última com 10");

console.log("\n=== estrutura: um só motor de persistência; nunca o habitual ===");
const barra = src("components/encomendas/barra-fornecedor-massa.tsx");
const cliente = src("components/encomendas/order-create-client.tsx");
check(!/from "@\/app\//.test(barra) && !/Action\b/.test(barra.replace(/\/\*[\s\S]*?\*\//g, "")), "a barra não importa nem chama nenhuma server action — só devolve (keys, fornecedorId)");
check(!/produtoFarmacia|fornecedorHabitual/i.test(barra.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").replace(/[«»][^«»]*[«»]/g, "")) || /nunca altera o fornecedor habitual/i.test(barra), "a barra declara que NÃO altera o fornecedor habitual");
check(/onAplicar=\{\(keys, id\) => handleBulkFornecedorChange\(keys, id\)\}/.test(cliente), "farmácia/grupo: a atribuição em massa passa por handleBulkFornecedorChange (→ persistLineChange → autosave)");
check(/onAplicar=\{\(keys, id\) => handleBulkFornecedorChangeConsolidacao\(keys, id\)\}/.test(cliente), "consolidação: passa por handleBulkFornecedorChangeConsolidacao (→ persistLineChangeConsolidacao → o MESMO useAutosaveEncomenda)");
check(!/handleBulkFornecedorFarmaciaConsolidacao|bulkFornecedorIdFarmacia/.test(cliente), "o antigo controlo «por farmácia» foi absorvido pela barra (sem duplicados)");
check(/aria-label="Seleccionar todas as linhas desta página"/.test(cliente) && /data-testid="paginacao-tabela"/.test(cliente), "o cabeçalho selecciona a PÁGINA e existe paginação (20/30/50/100/todas)");
check(/BarraFornecedorEmMassa/.test(cliente) && (cliente.match(/<BarraFornecedorEmMassa/g) ?? []).length === 2, "a MESMA barra serve a tabela (farmácia/grupo) e a vista consolidada");
check(!/gravarComoHabitual|atualizarFornecedorHabitual/.test(cliente + barra), "nenhuma acção grava a escolha da encomenda como fornecedor habitual");

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail === 0 ? 0 : 1);
