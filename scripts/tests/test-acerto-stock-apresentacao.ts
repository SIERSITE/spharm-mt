/**
 * scripts/tests/test-acerto-stock-apresentacao.ts
 *
 * A camada de leitura, durante a janela em que os dois formatos
 * coexistem.
 *
 * A migração `movimento_interno_acerto_stock` recolhe as linhas
 * existentes para ACERTO_STOCK, mas corre uma vez por tenant. Entre a
 * primeira e a última, a mesma instalação tem linhas antigas com
 * INVENTARIO / QUEBRA / PERDA / AJUSTE / TRANSFERENCIA_* e linhas novas
 * com ACERTO_STOCK — a descrever exactamente a mesma operação.
 *
 * O defeito que estes testes impedem: um utilizador que vê "Acerto de
 * stock" na grelha, clica no chip "Acerto de stock", e a linha
 * desaparece. Aconteceria se o rótulo cobrisse a família toda mas o
 * filtro só cobrisse o valor canónico.
 *
 * Uso: npx tsx scripts/tests/test-acerto-stock-apresentacao.ts
 */
import {
  TIPOS_ACERTO_STOCK,
  getTiposDisponiveis,
  type MovimentoTipo,
} from "../../lib/movimentos-data";
import {
  ACERTO_STOCK,
  TIPOS_INTERNOS_LEGADOS,
  ehAcertoStock,
} from "../../lib/movimento-classifier";

let pass = 0;
let fail = 0;
const eq = (label: string, obtido: unknown, esperado: unknown) => {
  if (obtido === esperado) {
    pass++;
    console.log(`  [OK]    ${label}`);
  } else {
    fail++;
    console.log(`  [FALHA] ${label}: obtido "${String(obtido)}", esperado "${String(esperado)}"`);
  }
};
const ok = (label: string, cond: boolean) => eq(label, cond, true);

// Reproduz a expansão feita pelo filtro em `getMovimentos`.
function expandir(tipos: MovimentoTipo[]): Set<MovimentoTipo> {
  const set = new Set(tipos);
  if (set.has("ACERTO_STOCK")) for (const t of TIPOS_ACERTO_STOCK) set.add(t);
  return set;
}

console.log("=== o canónico e os retirados são a mesma família ===");
eq("ACERTO_STOCK está na família", TIPOS_ACERTO_STOCK.includes(ACERTO_STOCK), true);
for (const t of TIPOS_INTERNOS_LEGADOS) {
  ok(`${t} está na família`, TIPOS_ACERTO_STOCK.includes(t as MovimentoTipo));
  ok(`${t} é reconhecido por ehAcertoStock`, ehAcertoStock(t));
}
// O simétrico: nenhum tipo transaccional entrou na família por descuido.
for (const t of ["VENDA", "COMPRA", "DEVOLUCAO_FORNECEDOR", "VENDA_CREDITO", "RESERVA_SUSPENSA", "DESCONHECIDO"]) {
  ok(`${t} NÃO é acerto`, !ehAcertoStock(t));
  ok(`${t} fora da família`, !TIPOS_ACERTO_STOCK.includes(t as MovimentoTipo));
}

console.log("");
console.log("=== filtrar por acertos apanha as linhas antigas ===");
const filtro = expandir(["ACERTO_STOCK"]);
for (const t of TIPOS_INTERNOS_LEGADOS) {
  ok(`linha histórica ${t} sobrevive ao filtro`, filtro.has(t as MovimentoTipo));
}
ok("linha nova ACERTO_STOCK sobrevive ao filtro", filtro.has("ACERTO_STOCK"));
// A expansão não pode alargar-se a mais nada.
ok("VENDA não entra pela expansão", !filtro.has("VENDA"));
ok("COMPRA não entra pela expansão", !filtro.has("COMPRA"));

// Filtrar por outra coisa não puxa acertos.
const soVendas = expandir(["VENDA"]);
ok("filtrar VENDA não traz acertos", !soVendas.has("ACERTO_STOCK"));
ok("filtrar VENDA não traz INVENTARIO", !soVendas.has("INVENTARIO"));

console.log("");
console.log("=== o dropdown não oferece o que já não se escreve ===");
const valores = getTiposDisponiveis().map((o) => o.value);
ok("oferece ACERTO_STOCK", valores.includes("ACERTO_STOCK"));
for (const t of TIPOS_INTERNOS_LEGADOS) {
  // Oferecer "Quebra" daria um filtro cujo resultado depende de a
  // migração ter corrido — zero num tenant, não-zero noutro.
  ok(`não oferece ${t}`, !valores.includes(t as MovimentoTipo));
}
// Um rótulo por valor, e sem duplicados no dropdown.
eq("dropdown sem duplicados", new Set(valores).size, valores.length);

console.log("");
console.log(`${pass} ok, ${fail} falhas`);
process.exit(fail === 0 ? 0 : 1);
