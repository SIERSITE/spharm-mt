/**
 * scripts/tests/test-vendas-manutencao.ts
 *
 * Manutenção de Vendas — a lógica pura: distribuição por maior resto
 * (farmácia e mês), janela histórica de 12 meses, cálculo de pesos
 * (incl. "sem histórico" — secção 1.7), validação da soma.
 *
 * Puro: sem base de dados, sem rede. Corre com:
 *   npx tsx scripts/tests/test-vendas-manutencao.ts
 */
import {
  distribuirPorMaiorResto,
  distribuirPorMeses,
  gerarMesesConsecutivos,
} from "../../lib/vendas-manutencao/distribuicao";
import {
  calcularPesosFarmacia,
  janelaHistoricaDozeMeses,
} from "../../lib/vendas-manutencao/peso";
import { somaQuantidades, validarSomaTotal } from "../../lib/vendas-manutencao/validacao";

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) {
    ok++;
    console.log(`  [OK]    ${label}`);
  } else {
    ko++;
    console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`);
  }
};
const eq = <T,>(a: T, b: T, label: string) =>
  check(JSON.stringify(a) === JSON.stringify(b), label, `esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);

// ══════════════════════════════════════════════════════════════════════
// A · distribuirPorMaiorResto — nunca perde nem acrescenta unidade
// ══════════════════════════════════════════════════════════════════════
console.log("\nA · distribuirPorMaiorResto");
{
  // O exemplo exacto do pedido: 100 por pesos 40/25/15/10/10 — divide
  // sem resto nenhum, prova o caso trivial primeiro.
  const partes = [
    { chave: "Garantia", peso: 0.4 },
    { chave: "Principal", peso: 0.25 },
    { chave: "Castelo", peso: 0.15 },
    { chave: "Pereiro", peso: 0.1 },
    { chave: "Nogueira", peso: 0.1 },
  ];
  const r = distribuirPorMaiorResto(100, partes);
  eq(r.map((p) => p.quantidade), [40, 25, 15, 10, 10], "A1: exemplo do pedido, sem resto");
  eq(somaQuantidades(r), 100, "A2: soma exacta");
}
{
  // Caso com resto real: 100 por 3 partes iguais — 33.333... cada.
  const partes = [{ chave: "X", peso: 1 }, { chave: "Y", peso: 1 }, { chave: "Z", peso: 1 }];
  const r = distribuirPorMaiorResto(100, partes);
  eq(somaQuantidades(r), 100, "A3: soma exacta mesmo com resto (100/3)");
  check(r.every((p) => Math.abs(p.quantidade - 33.333) < 0.01), "A4: cada parte ~33,333");
  // O resto (0.001) vai para a 1ª parte — todas as fracções são iguais,
  // o desempate é pela ORDEM de entrada (X antes de Y antes de Z).
  eq(r[0].quantidade, 33.334, "A5: desempate por ordem de entrada — X recebe o resto");
}
{
  // Peso 0 em todas as partes — nunca divide por zero, reparte igual.
  const partes = [{ chave: "A", peso: 0 }, { chave: "B", peso: 0 }];
  const r = distribuirPorMaiorResto(10, partes);
  eq(r.map((p) => p.quantidade), [5, 5], "A6: sem pesos, reparte em partes iguais");
}
{
  // Uma farmácia sem histórico (peso 0) fica mesmo a 0 — nunca herda uma fatia.
  const partes = [{ chave: "ComHistorico", peso: 1 }, { chave: "SemHistorico", peso: 0 }];
  const r = distribuirPorMaiorResto(50, partes);
  eq(r.map((p) => p.quantidade), [50, 0], "A7: peso 0 fica mesmo a 0, não herda fatia");
}
{
  // Quantidade grande, muitas partes — soma continua exacta.
  const partes = Array.from({ length: 7 }, (_, i) => ({ chave: i, peso: i + 1 }));
  const r = distribuirPorMaiorResto(1000, partes);
  eq(Math.round(somaQuantidades(r) * 1000) / 1000, 1000, "A8: soma exacta com 7 partes e pesos desiguais");
}

// ══════════════════════════════════════════════════════════════════════
// B · gerarMesesConsecutivos / distribuirPorMeses
// ══════════════════════════════════════════════════════════════════════
console.log("\nB · distribuição pelos meses");
{
  const meses = gerarMesesConsecutivos(2026, 11, 4);
  eq(meses, [
    { ano: 2026, mes: 11 }, { ano: 2026, mes: 12 },
    { ano: 2027, mes: 1 }, { ano: 2027, mes: 2 },
  ], "B1: vira o ano civil correctamente");
}
{
  // O exemplo exacto do pedido: 48 por 6 meses a partir de 04/2026 → 8 cada.
  const r = distribuirPorMeses(48, 2026, 4, 6);
  eq(r.map((m) => m.quantidade), [8, 8, 8, 8, 8, 8], "B2: exemplo do pedido — Garantia, 48/6=8");
  eq(somaQuantidades(r), 48, "B3: soma exacta");
}
{
  // Os outros quatro do mesmo exemplo — todos exactos, sem resto.
  eq(distribuirPorMeses(30, 2026, 4, 6).map((m) => m.quantidade), [5, 5, 5, 5, 5, 5], "B4: Principal, 30/6=5");
  eq(distribuirPorMeses(18, 2026, 4, 6).map((m) => m.quantidade), [3, 3, 3, 3, 3, 3], "B5: Castelo, 18/6=3");
  eq(distribuirPorMeses(12, 2026, 4, 6).map((m) => m.quantidade), [2, 2, 2, 2, 2, 2], "B6: Pereiro, 12/6=2");
}
{
  // Com resto: 100/6 não divide exacto — soma continua a bater.
  const r = distribuirPorMeses(100, 2026, 1, 6);
  eq(somaQuantidades(r), 100, "B7: soma exacta mesmo com resto (100/6)");
  const base = Math.floor((100 / 6) * 1000) / 1000; // 16.666
  check(r.every((m) => Math.abs(m.quantidade - base) < 0.01 || Math.abs(m.quantidade - (base + 0.001)) < 0.0001), "B8: cada mês ~16,666 ou 16,667 (o resto)");
}

// ══════════════════════════════════════════════════════════════════════
// C · janelaHistoricaDozeMeses — 12 meses completos ANTERIORES
// ══════════════════════════════════════════════════════════════════════
console.log("\nC · janela histórica de 12 meses");
{
  const j = janelaHistoricaDozeMeses(2026, 4);
  eq(j.inicio, { ano: 2025, mes: 4 }, "C1: início — Abr/2025");
  eq(j.fim, { ano: 2026, mes: 3 }, "C2: fim — Mar/2026 (o mês ANTERIOR ao de referência, nunca o próprio)");
}
{
  // Vira o ano — mês de referência é Janeiro.
  const j = janelaHistoricaDozeMeses(2026, 1);
  eq(j.inicio, { ano: 2025, mes: 1 }, "C3: início — Jan/2025");
  eq(j.fim, { ano: 2025, mes: 12 }, "C4: fim — Dez/2025");
}
{
  // A janela é só função de (ano,mês) de referência — chamar duas vezes
  // com os mesmos argumentos (em dias diferentes) dá SEMPRE o mesmo
  // resultado. É a garantia da secção 1.4: nunca varia depois.
  const j1 = janelaHistoricaDozeMeses(2026, 9);
  const j2 = janelaHistoricaDozeMeses(2026, 9);
  eq(j1, j2, "C5: determinística — mesmo mês de referência, sempre a mesma janela");
}

// ══════════════════════════════════════════════════════════════════════
// D · calcularPesosFarmacia — nunca inventa peso (secção 1.7)
// ══════════════════════════════════════════════════════════════════════
console.log("\nD · pesos por farmácia");
{
  const historico = [
    { farmaciaId: "segurado", qty: 40 },
    { farmaciaId: "silveirense", qty: 60 },
  ];
  const r = calcularPesosFarmacia(historico, ["segurado", "silveirense"]);
  check(!r.semHistoricoNenhum, "D1: há histórico");
  eq(r.pesos.map((p) => p.peso), [0.4, 0.6], "D2: pesos proporcionais (40/100, 60/100)");
  check(r.pesos.every((p) => p.temHistorico), "D3: as duas têm histórico");
}
{
  // Uma farmácia sem QUALQUER histórico entre as que têm.
  const historico = [{ farmaciaId: "segurado", qty: 40 }];
  const r = calcularPesosFarmacia(historico, ["segurado", "silveirense", "central"]);
  check(!r.semHistoricoNenhum, "D4: histórico parcial não é 'sem histórico nenhum'");
  eq(r.pesos.find((p) => p.farmaciaId === "segurado")?.peso, 1, "D5: única com histórico fica com 100%");
  eq(r.pesos.find((p) => p.farmaciaId === "silveirense")?.peso, 0, "D6: sem histórico fica a 0 — NUNCA uma fatia igual forçada");
  check(r.pesos.find((p) => p.farmaciaId === "silveirense")?.temHistorico === false, "D7: sinalizada explicitamente sem histórico");
}
{
  // Nenhuma farmácia do âmbito tem histórico nenhum.
  const r = calcularPesosFarmacia([], ["segurado", "silveirense"]);
  check(r.semHistoricoNenhum, "D8: sem histórico nenhum — sinalizado para a UI pedir distribuição manual");
  check(r.pesos.every((p) => p.peso === 0), "D9: todos os pesos a 0 — nunca um peso inventado");
}

// ══════════════════════════════════════════════════════════════════════
// E · validarSomaTotal — nunca gravar com diferença
// ══════════════════════════════════════════════════════════════════════
console.log("\nE · validação da soma");
{
  const celulas = [{ quantidade: 40 }, { quantidade: 60 }];
  const r = validarSomaTotal(celulas, 100);
  check(r.ok, "E1: soma bate exactamente");
  eq(r.diferenca, 0, "E2: diferença zero");
}
{
  const celulas = [{ quantidade: 40 }, { quantidade: 59 }];
  const r = validarSomaTotal(celulas, 100);
  check(!r.ok, "E3: falta 1 unidade — bloqueia");
  eq(r.diferenca, -1, "E4: diferença negativa reportada com precisão");
}
{
  const celulas = [{ quantidade: 40 }, { quantidade: 61 }];
  const r = validarSomaTotal(celulas, 100);
  check(!r.ok, "E5: a mais também bloqueia");
  eq(r.diferenca, 1, "E6: diferença positiva reportada");
}
{
  // Erro de ponto-flutuante do JS (0.1+0.2!==0.3) não pode bloquear uma
  // matriz que, na prática, está correcta.
  const celulas = [{ quantidade: 0.1 }, { quantidade: 0.2 }];
  const r = validarSomaTotal(celulas, 0.3);
  check(r.ok, "E7: tolera erro de representação de ponto-flutuante");
}

console.log(`\n${ok} ok, ${ko} falhas`);
process.exit(ko === 0 ? 0 : 1);
