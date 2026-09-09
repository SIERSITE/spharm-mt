/**
 * scripts/tests/test-pvp-referencia.ts
 *
 * O PVP de referência da ficha de stock.
 *
 * ── O defeito que isto guarda ────────────────────────────────────────
 *
 * A referência era `pfsActive.find((pf) => pf.pvp !== null)` — a
 * primeira `ProdutoFarmacia` com preço, numa consulta sem `orderBy`.
 * Duas coisas erradas ao mesmo tempo: a baseline era arbitrária, e não
 * era sequer estável entre carregamentos.
 *
 * Enquanto era só um número no cabeçalho, ninguém dava por isso. Deixou
 * de ser, quando a tabela por farmácia passou a mostrar o desvio face à
 * referência: com uma baseline instável os desvios trocam de sinal
 * sozinhos. A asserção que fecha isto é a do determinismo — permutar as
 * linhas não pode mudar a resposta.
 *
 * Corre com:  npm run test:pvp-referencia
 */
import {
  calcularPvpReferencia,
  descreverPvpReferencia,
  desvioFaceAReferencia,
} from "../../lib/pvp-referencia";

let ok = 0;
let ko = 0;
const eq = (label: string, obtido: unknown, esperado: unknown) => {
  if (Object.is(obtido, esperado)) {
    ok++;
    console.log(`  [OK]    ${label}`);
  } else {
    ko++;
    console.log(`  [FALHA] ${label}: obtido ${JSON.stringify(obtido)}, esperado ${JSON.stringify(esperado)}`);
  }
};
const check = (cond: boolean, label: string, extra?: string) => {
  if (cond) {
    ok++;
    console.log(`  [OK]    ${label}`);
  } else {
    ko++;
    console.log(`  [FALHA] ${label}${extra ? ` — ${extra}` : ""}`);
  }
};

const linhas = (...pvps: Array<number | null>) => pvps.map((pvp) => ({ pvp }));

// ── 1. A moda ───────────────────────────────────────────────────────
console.log("\n=== a referência é o preço que a maioria pratica ===");
{
  const r = calcularPvpReferencia(linhas(4.25, 4.49, 4.25, 4.1, 4.25));
  eq("valor", r.valor, 4.25);
  eq("quantas o praticam", r.farmaciasComEsseValor, 3);
  eq("quantas têm preço", r.farmaciasComPreco, 5);
  eq("não é unânime", r.unanime, false);
  eq("texto", descreverPvpReferencia(r), "praticado por 3 de 5 farmácias");
}

// ── 2. O empate ─────────────────────────────────────────────────────
console.log("\n=== empate resolve-se pelo mais baixo ===");
{
  // Sem desempate explícito, quem ganhava era a ordem de inserção do
  // Map — que é a ordem das linhas, que é exactamente o que esta função
  // existe para não usar.
  const r = calcularPvpReferencia(linhas(4.5, 4.2, 4.5, 4.2));
  eq("ganha o mais baixo", r.valor, 4.2);
  eq("com a contagem certa", r.farmaciasComEsseValor, 2);

  const invertido = calcularPvpReferencia(linhas(4.2, 4.5, 4.2, 4.5));
  eq("e a ordem de entrada não altera nada", invertido.valor, 4.2);
}

// ── 3. Determinismo ─────────────────────────────────────────────────
//
// A asserção central. Se esta passar, a instabilidade que motivou o
// módulo não pode voltar por outra porta.
console.log("\n=== permutar as linhas não muda a resposta ===");
{
  const base = [4.25, 4.49, 4.25, 4.1, 4.25, null, 4.49];
  const esperado = calcularPvpReferencia(linhas(...base)).valor;
  let estavel = true;
  // Rotações: barato, e cobre a família de ordens que uma consulta sem
  // `orderBy` consegue devolver.
  for (let i = 1; i < base.length; i++) {
    const rodado = [...base.slice(i), ...base.slice(0, i)];
    if (calcularPvpReferencia(linhas(...rodado)).valor !== esperado) estavel = false;
  }
  check(estavel, `todas as ${base.length} rotações dão ${esperado}`);
  // Inversão, que não é uma rotação.
  eq("e a ordem inversa também", calcularPvpReferencia(linhas(...[...base].reverse())).valor, esperado);
}

// ── 4. Os casos de fronteira ────────────────────────────────────────
console.log("\n=== fronteiras ===");
{
  const vazio = calcularPvpReferencia([]);
  eq("sem farmácias: valor null", vazio.valor, null);
  eq("sem farmácias: texto", descreverPvpReferencia(vazio), "sem registo");

  const soNulls = calcularPvpReferencia(linhas(null, null));
  eq("só nulls: valor null", soNulls.valor, null);
  eq("só nulls: denominador zero", soNulls.farmaciasComPreco, 0);

  // "praticado por 1 de 1" leria como consenso quando é o único dado.
  const uma = calcularPvpReferencia(linhas(4.25, null, null));
  eq("uma só com preço: valor", uma.valor, 4.25);
  eq("uma só com preço: texto", descreverPvpReferencia(uma), "única farmácia com preço");

  const todas = calcularPvpReferencia(linhas(4.25, 4.25, 4.25));
  eq("unânime", todas.unanime, true);
  eq("unânime: texto", descreverPvpReferencia(todas), "igual nas 3 farmácias");

  // As farmácias sem preço não entram no denominador: dizer "1 de 5"
  // quando quatro nem preço têm descreve mal o acordo que existe.
  const comBuracos = calcularPvpReferencia(linhas(4.25, null, 4.25, null, 4.49));
  eq("nulls fora do denominador", comBuracos.farmaciasComPreco, 3);
  eq("…e da contagem", comBuracos.farmaciasComEsseValor, 2);
}

// ── 5. Precisão ─────────────────────────────────────────────────────
console.log("\n=== a coluna é Decimal(12,4), não um float ===");
{
  // 4.25 e 4.2500 são o mesmo preço e têm de contar como um só, senão a
  // moda parte-se em dois grupos de um e o desempate escolhe ao acaso.
  const r = calcularPvpReferencia(linhas(4.25, 4.25, 4.49));
  eq("mesmo preço, um só grupo", r.farmaciasComEsseValor, 2);

  // Meia décima de milésimo separa preços de verdade.
  const finos = calcularPvpReferencia(linhas(4.2501, 4.2502, 4.2501));
  eq("quatro casas distinguem", finos.valor, 4.2501);
  eq("…e contam certo", finos.farmaciasComEsseValor, 2);
}

// ── 6. O desvio ─────────────────────────────────────────────────────
console.log("\n=== o desvio só existe quando há diferença ===");
{
  eq("igual → sem desvio", desvioFaceAReferencia(4.25, 4.25), null);
  // Um "+0,00" em todas as linhas seria ruído a fingir sinal.
  eq("igual a quatro casas → sem desvio", desvioFaceAReferencia(4.25, 4.2500), null);
  eq("sem preço → sem desvio", desvioFaceAReferencia(null, 4.25), null);
  eq("sem referência → sem desvio", desvioFaceAReferencia(4.25, null), null);

  const acima = desvioFaceAReferencia(4.49, 4.25);
  check(acima !== null && Math.abs(acima - 0.24) < 1e-9, "mais caro → positivo", String(acima));
  const abaixo = desvioFaceAReferencia(4.1, 4.25);
  check(abaixo !== null && Math.abs(abaixo + 0.15) < 1e-9, "mais barato → negativo", String(abaixo));
}

console.log(`\n${ok} ok, ${ko} falhas`);
process.exit(ko === 0 ? 0 : 1);
