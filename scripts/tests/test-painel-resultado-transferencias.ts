/**
 * scripts/tests/test-painel-resultado-transferencias.ts
 *
 * Melhoria pontual no `PainelResultadoFinalizacao` (order-create-client.tsx):
 * cada transferência gerada mostra directamente no ecrã farmácia origem →
 * destino, produto, CNP e quantidade por linha — sem esperar por um clique
 * em Imprimir/PDF/Email. Teste ESTÁTICO (lê o código-fonte), no mesmo
 * espírito de `test-vendas-stock-sempre-ativo.ts`: confirma a estrutura no
 * componente sem montar React.
 *
 * Confirma também os dois requisitos explícitos do pedido:
 *   - reutiliza `t.report.rows` (o MESMO Report já construído por
 *     `buildTransferenciaDocumentoReport`) — nenhuma query nova;
 *   - cada transferência tem sempre o seu bloco, mesmo havendo só uma
 *     (antes só listava o detalhe quando havia mais de uma).
 */
import { readFileSync } from "node:fs";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  [OK]    ${msg}`); }
  else { failed++; console.log(`  [FALHA] ${msg}`); }
}

const src = readFileSync(new URL("../../components/encomendas/order-create-client.tsx", import.meta.url), "utf8");
const inicio = src.indexOf("function PainelResultadoFinalizacao");
const secTransferencias = src.slice(src.indexOf("{temTransferencias &&", inicio), src.indexOf("<div className=\"flex justify-end\">", inicio));

console.log("\nA · bloco por transferência sempre presente (não só quando há várias)");
{
  check(secTransferencias.length > 0, "A1: encontra a secção «Transferências geradas»");
  const mapaSemGuarda = /resultado\.transferenciaIndividual\.map/.test(secTransferencias);
  check(mapaSemGuarda, "A2: percorre transferenciaIndividual directamente");
  // A guarda `multiplasTransferencias &&` já não envolve o .map do detalhe —
  // só continua a decidir o botão "resumo consolidado" no topo.
  const indiceMap = secTransferencias.indexOf("resultado.transferenciaIndividual.map");
  const antesDoMap = secTransferencias.slice(0, indiceMap);
  const ultimaGuardaAntes = antesDoMap.lastIndexOf("multiplasTransferencias &&");
  const fechaAntesDoMap = antesDoMap.lastIndexOf(")}");
  check(
    ultimaGuardaAntes === -1 || fechaAntesDoMap > ultimaGuardaAntes,
    "A3: o bloco por transferência já não está condicionado a «mais de uma» — uma única transferência também mostra o seu bloco"
  );
}

console.log("\nB · mostra farmácia origem → destino, produto, CNP e quantidade");
{
  check(secTransferencias.includes("{t.rota}"), "B1: farmácia origem → destino (t.rota)");
  check(secTransferencias.includes("linha.produto"), "B2: produto por linha");
  check(secTransferencias.includes("linha.cnp"), "B3: CNP por linha");
  check(secTransferencias.includes("linha.quantidade"), "B4: quantidade por linha");
}

console.log("\nC · reutiliza o Report já construído — sem query nem lógica nova");
{
  check(secTransferencias.includes("t.report.rows"), "C1: lê directamente t.report.rows (o mesmo Report que já alimenta Imprimir/PDF/Email)");
  check(!/await\s+(load|fetch|build)/.test(secTransferencias), "C2: nenhuma chamada assíncrona nova dentro da secção (sem nova query)");
}

console.log("\nD · resumo do topo inalterado (N encomenda(s) · M transferência(s))");
{
  const banner = src.slice(src.indexOf("Encomenda finalizada", inicio) - 200, src.indexOf("Encomenda finalizada", inicio) + 400);
  check(banner.includes('encomenda{resultado.encomendaIndividual.length === 1 ? "" : "s"}'), "D1: contagem de encomendas mantida");
  check(banner.includes("transferência"), "D2: contagem de transferências mantida no mesmo banner");
}

console.log(`\n${passed} ok, ${failed} falhas`);
if (failed > 0) process.exit(1);
