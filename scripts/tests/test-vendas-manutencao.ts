/**
 * scripts/tests/test-vendas-manutencao.ts
 *
 * Manutenção de Vendas — a lógica pura: distribuição por maior resto
 * (farmácia e mês, em INTEIROS), janela histórica de 12 meses, cálculo
 * de pesos (incl. "sem histórico" — secção 1.7), validação da soma,
 * valorização (PVP de referência) e — o pedido explícito — a prova de
 * que uma alteração posterior de `ProdutoFarmacia.pvp` NUNCA altera os
 * valores de uma manutenção já gravada (secção 6·G, com um Prisma
 * falso, já que o caminho de dados é o único ponto que fala com a BD).
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
  calcularPesosMensais,
  janelaHistoricaDozeMeses,
  janelaHistoricaMeses,
} from "../../lib/vendas-manutencao/peso";
import { somaQuantidades, validarSomaTotal, validarPvpReferencia } from "../../lib/vendas-manutencao/validacao";
import { calcularValorBrutoCelula, precisaDePvpReferencia } from "../../lib/vendas-manutencao/valorizacao";
import {
  calcularDistribuicaoQuantidades,
  criarManutencao,
  guardarCelulasAjustadas,
  obterPvpReferenciaAtual,
  substituirDistribuicao,
} from "../../lib/vendas-manutencao-data";

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
  // Caso com resto real: 100 por 3 partes iguais — 33/33/34 (Int).
  const partes = [{ chave: "X", peso: 1 }, { chave: "Y", peso: 1 }, { chave: "Z", peso: 1 }];
  const r = distribuirPorMaiorResto(100, partes);
  eq(somaQuantidades(r), 100, "A3: soma exacta mesmo com resto (100/3)");
  check(r.every((p) => Number.isInteger(p.quantidade)), "A4: todas as partes são inteiras (quantidade é Int)");
  // O resto (1 unidade) vai para a 1ª parte — todas as fracções são
  // iguais, o desempate é pela ORDEM de entrada (X antes de Y antes de Z).
  eq(r.map((p) => p.quantidade), [34, 33, 33], "A5: desempate por ordem de entrada — X recebe o resto");
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
//
// `distribuirPorMeses` deixou de calcular peso nenhum sozinha — recebe
// SEMPRE o peso de cada mês já decidido por quem chama (ver
// `peso.ts::calcularPesosMensais`). Partes iguais só acontecem aqui
// quando é o PRÓPRIO CHAMADOR que passa pesos iguais — nunca mais é o
// comportamento por omissão desta função (era exactamente esse
// "por omissão igual" que causava o bug de 500/5=100×5 relatado).
// ══════════════════════════════════════════════════════════════════════
console.log("\nB · distribuição pelos meses (mecânica — peso vem de fora)");
{
  const meses = gerarMesesConsecutivos(2026, 11, 4);
  eq(meses, [
    { ano: 2026, mes: 11 }, { ano: 2026, mes: 12 },
    { ano: 2027, mes: 1 }, { ano: 2027, mes: 2 },
  ], "B1: vira o ano civil correctamente");
}
function comPesoIgual(meses: { ano: number; mes: number }[]) {
  return meses.map((m) => ({ ...m, peso: 1 / meses.length }));
}
{
  // O exemplo exacto do pedido original: 48 por 6 meses, pesos iguais → 8 cada.
  const meses = gerarMesesConsecutivos(2026, 4, 6);
  const r = distribuirPorMeses(48, comPesoIgual(meses));
  eq(r.map((m) => m.quantidade), [8, 8, 8, 8, 8, 8], "B2: pesos iguais explícitos — 48/6=8");
  eq(somaQuantidades(r), 48, "B3: soma exacta");
}
{
  // Com resto: 100/6 não divide exacto — soma continua a bater, tudo
  // em inteiros: 4 meses com 17, 2 meses com 16 (100 = 4×17 + 2×16).
  const meses = gerarMesesConsecutivos(2026, 1, 6);
  const r = distribuirPorMeses(100, comPesoIgual(meses));
  eq(somaQuantidades(r), 100, "B4: soma exacta mesmo com resto (100/6, pesos iguais)");
  check(r.every((m) => Number.isInteger(m.quantidade)), "B5: todos os meses recebem quantidade inteira");
  const contagem = { 16: 0, 17: 0 } as Record<number, number>;
  for (const m of r) contagem[m.quantidade] = (contagem[m.quantidade] ?? 0) + 1;
  eq(contagem[17], 4, "B6: 4 meses com 17 (o resto)");
  eq(contagem[16], 2, "B7: 2 meses com 16 (a base)");
}
{
  // O CASO DO BUG RELATADO — 500 unidades, 5 meses, SET/2026..JAN/2027 —
  // mas agora com pesos DESIGUAIS (o histórico real jamais é plano).
  // Prova que a função respeita o peso dado — nunca "esquece" e divide
  // por igual sozinha.
  const meses = gerarMesesConsecutivos(2026, 9, 5); // SET,OUT,NOV,DEZ,JAN/27
  const pesos = [0.05, 0.1, 0.15, 0.4, 0.3]; // um perfil claramente sazonal
  const r = distribuirPorMeses(500, meses.map((m, i) => ({ ...m, peso: pesos[i] })));
  eq(somaQuantidades(r), 500, "B8: soma exacta com pesos desiguais");
  check(
    JSON.stringify(r.map((m) => m.quantidade)) !== JSON.stringify([100, 100, 100, 100, 100]),
    "B9: NÃO é 100/100/100/100/100 — o bug relatado (divisão plana) está corrigido",
  );
  eq(r.map((m) => m.quantidade), [25, 50, 75, 200, 150], "B10: proporcional ao peso — 500×[0.05,0.1,0.15,0.4,0.3]");
}
{
  // 1 mês só — todo o peso (qualquer que seja) tem de ir para ele.
  const meses = gerarMesesConsecutivos(2026, 6, 1);
  const r = distribuirPorMeses(37, [{ ...meses[0], peso: 1 }]);
  eq(r.map((m) => m.quantidade), [37], "B11: caso de 1 mês — recebe tudo");
}
{
  // 12 meses — cruza o ano civil inteiro, com pesos desiguais e resto.
  const meses = gerarMesesConsecutivos(2026, 1, 12);
  const pesos = meses.map((_, i) => i + 1); // 1..12, pesos crescentes
  const r = distribuirPorMeses(1000, meses.map((m, i) => ({ ...m, peso: pesos[i] })));
  eq(somaQuantidades(r), 1000, "B12: caso de 12 meses — soma exacta");
  check(r[11].quantidade > r[0].quantidade, "B13: o mês com mais peso (Dez, peso 12) recebe mais do que o de menos peso (Jan, peso 1)");
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
// D2 · janelaHistoricaMeses — generalização da janela de 12 meses
// ══════════════════════════════════════════════════════════════════════
console.log("\nD2 · janela histórica genérica (sazonalidade usa 36 meses)");
{
  // Com numMeses=12, tem de dar EXACTAMENTE o mesmo que janelaHistoricaDozeMeses.
  const j36 = janelaHistoricaMeses(2026, 9, 36);
  eq(j36.fim, { ano: 2026, mes: 8 }, "D2.1: fim é sempre o mês anterior ao de referência, seja qual for o comprimento");
  eq(j36.inicio, { ano: 2023, mes: 9 }, "D2.2: 36 meses para trás — Set/2023..Ago/2026");
  const j12 = janelaHistoricaMeses(2026, 9, 12);
  eq(j12, janelaHistoricaDozeMeses(2026, 9), "D2.3: janelaHistoricaMeses(...,12) === janelaHistoricaDozeMeses(...) — mesma fórmula");
}

// ══════════════════════════════════════════════════════════════════════
// D3 · calcularPesosMensais — o CORAÇÃO da correcção (secção 3 do pedido)
//
// A hierarquia de fallback: farmácia específica (com amostra) → global
// do artigo (com amostra) → partes iguais (só quando não há amostra em
// lado nenhum). Nunca "quantidade / nº meses" salvo nesse último caso.
// ══════════════════════════════════════════════════════════════════════
console.log("\nD3 · pesos mensais (sazonalidade) — hierarquia de fallback");
{
  // O FIXTURE EXACTO pedido: histórico irregular SET10/OUT20/NOV30/DEZ80/JAN60.
  // Uma manutenção de 500 unidades para os mesmos 5 meses civis NÃO
  // pode dar 100×5 — tem de aproximar as proporções históricas.
  const historicoFarmacia = [
    { mes: 9, qty: 10 }, { mes: 10, qty: 20 }, { mes: 11, qty: 30 },
    { mes: 12, qty: 80 }, { mes: 1, qty: 60 },
  ];
  const mesesAlvo = gerarMesesConsecutivos(2026, 9, 5); // SET,OUT,NOV,DEZ,JAN/27
  const r = calcularPesosMensais(historicoFarmacia, [], mesesAlvo);
  eq(r.origem, "FARMACIA", "D3.1: usa o perfil da PRÓPRIA farmácia — tem amostra suficiente (5 meses distintos)");
  const somaHist = 10 + 20 + 30 + 80 + 60; // 200
  eq(r.pesos.map((p) => Math.round((p.peso * 1000)) / 1000), [10 / somaHist, 20 / somaHist, 30 / somaHist, 80 / somaHist, 60 / somaHist].map((x) => Math.round(x * 1000) / 1000), "D3.2: pesos proporcionais ao histórico irregular");

  // A distribuição final de 500 unidades por este peso — NÃO pode ser 100×5.
  const distribuido = distribuirPorMeses(500, mesesAlvo.map((m, i) => ({ ...m, peso: r.pesos[i].peso })));
  check(
    JSON.stringify(distribuido.map((m) => m.quantidade)) !== JSON.stringify([100, 100, 100, 100, 100]),
    "D3.3: 500 unidades NÃO ficam 100/100/100/100/100 — o bug relatado está corrigido",
  );
  eq(somaQuantidades(distribuido), 500, "D3.4: soma continua exacta (500)");
  // Aproxima as proporções: DEZ (peso 80/200=40%) tem de ser claramente
  // o mês com mais quantidade, SET (peso 10/200=5%) o com menos.
  const porMes = new Map(distribuido.map((m) => [m.mes, m.quantidade]));
  check((porMes.get(12) ?? 0) > (porMes.get(9) ?? 0), "D3.5: Dezembro (mais histórico) recebe mais unidades do que Setembro (menos histórico)");
  eq(porMes.get(12), 200, "D3.6: Dezembro ≈ 40% de 500 = 200 (exacto, sem resto)");
  eq(porMes.get(9), 25, "D3.7: Setembro ≈ 5% de 500 = 25 (exacto, sem resto)");
}
{
  // Farmácia SEM histórico do artigo, mas o artigo TEM histórico global
  // — fallback para o perfil global, nunca para partes iguais.
  const historicoGlobal = [{ mes: 9, qty: 5 }, { mes: 10, qty: 5 }, { mes: 11, qty: 5 }, { mes: 12, qty: 30 }, { mes: 1, qty: 5 }];
  const mesesAlvo = gerarMesesConsecutivos(2026, 9, 5);
  const r = calcularPesosMensais([], historicoGlobal, mesesAlvo);
  eq(r.origem, "GLOBAL", "D3.8: sem histórico próprio — cai para o perfil GLOBAL do artigo, nunca partes iguais");
  const porMes = new Map(r.pesos.map((p) => [p.mes, p.peso]));
  check((porMes.get(12) ?? 0) > (porMes.get(9) ?? 0), "D3.9: o perfil global também é sazonal — Dezembro pesa mais");
}
{
  // Artigo SEM histórico nenhum, em lado nenhum — só aqui é legítimo
  // usar partes iguais (secção 1.7/3.c do pedido).
  const mesesAlvo = gerarMesesConsecutivos(2026, 9, 5);
  const r = calcularPesosMensais([], [], mesesAlvo);
  eq(r.origem, "NEUTRO", "D3.10: sem histórico em lado nenhum — só agora partes iguais");
  check(r.pesos.every((p) => Math.abs(p.peso - 0.2) < 1e-9), "D3.11: todos os 5 meses com peso 20% (1/5)");
}
{
  // Farmácia tem histórico rico, mas SÓ em meses fora da janela-alvo
  // (ex.: só vende este artigo na Primavera, a manutenção é para o
  // Verão) — os meses-alvo não têm amostra NESSE perfil específico,
  // por isso cai para o global, mesmo a farmácia "tendo histórico".
  const historicoFarmacia = [{ mes: 3, qty: 50 }, { mes: 4, qty: 60 }, { mes: 5, qty: 40 }]; // Mar/Abr/Mai
  const historicoGlobal = [{ mes: 6, qty: 10 }, { mes: 7, qty: 90 }]; // Jun/Jul
  const mesesAlvo = gerarMesesConsecutivos(2026, 6, 2); // Jun, Jul
  const r = calcularPesosMensais(historicoFarmacia, historicoGlobal, mesesAlvo);
  eq(r.origem, "GLOBAL", "D3.12: farmácia tem amostra suficiente, mas não NOS meses-alvo — cai para o global");
}
{
  // Só 1 mês distinto com venda — amostra INSUFICIENTE para revelar
  // forma nenhuma (não distingue sazonalidade de coincidência).
  const historicoFarmacia = [{ mes: 9, qty: 100 }]; // só Setembro, nenhum outro mês
  const historicoGlobal: { mes: number; qty: number }[] = [];
  const mesesAlvo = gerarMesesConsecutivos(2026, 9, 3);
  const r = calcularPesosMensais(historicoFarmacia, historicoGlobal, mesesAlvo);
  eq(r.origem, "NEUTRO", "D3.13: 1 mês distinto só não chega (MIN_MESES_DISTINTOS_PARA_PERFIL=2) — cai para partes iguais");
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

// ══════════════════════════════════════════════════════════════════════
// F · valorizacao.ts + validarPvpReferencia — nunca inventar preço
// ══════════════════════════════════════════════════════════════════════
console.log("\nF · valorização e validação do PVP de referência");
{
  eq(calcularValorBrutoCelula(10, 6.66), 66.6, "F1: quantidade × PVP de referência, arredondado a cêntimos");
  eq(calcularValorBrutoCelula(10, null), null, "F2: sem PVP de referência ⇒ valor bruto null, nunca 0 inventado");
  eq(calcularValorBrutoCelula(0, 6.66), 0, "F3: quantidade 0 a um PVP conhecido vale mesmo 0 (facto, não ausência)");
}
{
  check(precisaDePvpReferencia(10, null), "F4: farmácia com quantidade e sem PVP precisa de referência");
  check(!precisaDePvpReferencia(0, null), "F5: sem quantidade nenhuma, não precisa (nada para valorizar)");
  check(!precisaDePvpReferencia(10, 6.66), "F6: com PVP válido, não precisa");
}
{
  const celulas = [
    { farmaciaId: "f1", quantidade: 10 },
    { farmaciaId: "f2", quantidade: 0 },
  ];
  const farmaciasPvp = [
    { farmaciaId: "f1", pvpReferencia: null },
    { farmaciaId: "f2", pvpReferencia: null },
  ];
  const r = validarPvpReferencia(celulas, farmaciasPvp);
  check(!r.ok, "F7: f1 tem quantidade e não tem PVP — bloqueia");
  eq(r.farmaciasSemPvp, ["f1"], "F8: só f1 é apontada (f2 tem quantidade 0, não precisa)");
}
{
  const celulas = [{ farmaciaId: "f1", quantidade: 10 }];
  const farmaciasPvp = [{ farmaciaId: "f1", pvpReferencia: 6.66 }];
  const r = validarPvpReferencia(celulas, farmaciasPvp);
  check(r.ok, "F9: com PVP válido para toda a farmácia com quantidade, passa");
}

// ══════════════════════════════════════════════════════════════════════
// G · PVP de referência é IMUTÁVEL — uma alteração posterior de
//     ProdutoFarmacia.pvp nunca altera uma manutenção já gravada
//     (secção 6/2/5 do pedido — testado com um Prisma falso, já que a
//     garantia é sobre QUAIS tabelas cada caminho de código consulta).
//
// `tsx` compila para CJS, onde não há top-level await — os testes que
// exercitam o Prisma falso (todos assíncronos) vivem dentro desta
// função, mesma convenção de scripts/tests/test-margens.ts.
// ══════════════════════════════════════════════════════════════════════
type ChamadaFalsa = { metodo: string; args: unknown };

/**
 * Um Prisma falso mínimo — só os métodos que
 * lib/vendas-manutencao-data.ts realmente chama. `pvpAtual` simula o
 * que `ProdutoFarmacia.pvp` vale "hoje" nesta instância falsa — cada
 * teste cria a SUA própria instância para representar um instante no
 * tempo diferente (nunca a mesma instância muda de valor a meio).
 */
function prismaFalsoManutencao(opts: {
  pvpAtual?: Record<string, number | null>;
  bloquearProdutoFarmacia?: boolean;
}) {
  const chamadas: ChamadaFalsa[] = [];
  const fake = {
    produtoFarmacia: {
      findMany: async (args: { where: { farmaciaId: { in: string[] } } }) => {
        if (opts.bloquearProdutoFarmacia) {
          throw new Error("produtoFarmacia.findMany NUNCA deveria ser chamado num recálculo/ajuste de células");
        }
        chamadas.push({ metodo: "produtoFarmacia.findMany", args });
        return args.where.farmaciaId.in.map((farmaciaId: string) => ({
          farmaciaId,
          pvp: opts.pvpAtual?.[farmaciaId] ?? null,
        }));
      },
    },
    $queryRaw: async () => {
      chamadas.push({ metodo: "$queryRaw", args: null });
      return []; // sem histórico — irrelevante para esta prova, ver secção D
    },
    vendaManutencao: {
      create: async (args: unknown) => {
        chamadas.push({ metodo: "vendaManutencao.create", args });
        return { id: "m-teste" };
      },
      update: async (args: unknown) => {
        chamadas.push({ metodo: "vendaManutencao.update", args });
        return {};
      },
    },
    vendaManutencaoCelula: {
      deleteMany: async (args: unknown) => {
        chamadas.push({ metodo: "vendaManutencaoCelula.deleteMany", args });
        return {};
      },
    },
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { fake, chamadas };
}

async function principal() {
console.log("\nG · imutabilidade do PVP de referência (Prisma falso)");
{
  // 1) Criação: o PVP de HOJE é 6,66 € — capturado como referência.
  const { fake: fakeCriacao } = prismaFalsoManutencao({ pvpAtual: { f1: 6.66 } });
  const farmaciasPvpNaCriacao = await obterPvpReferenciaAtual(fakeCriacao, "p1", [{ id: "f1", nome: "Segurado" }]);
  eq(farmaciasPvpNaCriacao[0].pvpReferencia, 6.66, "G1: PVP capturado na criação é o de HOJE (6,66 €)");

  // 2) O TEMPO PASSA — o PVP em ProdutoFarmacia muda para 9,99 €. Uma
  // instância NOVA do Prisma falso representa esse instante posterior —
  // prova que a mudança é real (se chamado, o loader veria 9,99 €).
  const { fake: fakeMaisTarde } = prismaFalsoManutencao({ pvpAtual: { f1: 9.99 } });
  const farmaciasPvpMaisTarde = await obterPvpReferenciaAtual(fakeMaisTarde, "p1", [{ id: "f1", nome: "Segurado" }]);
  eq(farmaciasPvpMaisTarde[0].pvpReferencia, 9.99, "G2: confirma que o PVP realmente mudou entretanto (9,99 €)");

  // 3) RECALCULAR a distribuição da manutenção já criada — com um
  // Prisma que REBENTA se `produtoFarmacia.findMany` for chamado. Se o
  // recálculo tentasse reler o PVP actual, este teste falhava com uma
  // excepção, não com um valor errado — é a prova mais forte possível.
  const { fake: fakeRecalculo } = prismaFalsoManutencao({ bloquearProdutoFarmacia: true });
  const distribuicaoRecalculada = await calcularDistribuicaoQuantidades(fakeRecalculo, {
    produtoId: "p1",
    farmacias: [{ id: "f1", nome: "Segurado" }],
    quantidadeTotal: 30,
    numMeses: 3,
    mesInicialAno: 2026,
    mesInicialMes: 4,
  });
  eq(somaQuantidades(distribuicaoRecalculada.celulas), 30, "G3: o recálculo funciona — nunca precisou de tocar em ProdutoFarmacia");

  // 4) O valor bruto usado tem de continuar a ser calculado com o PVP
  // ORIGINAL (6,66 €, capturado no passo 1) — nunca com o actual
  // (9,99 €, passo 2). `calcularValorBrutoCelula` é pura: não tem
  // acesso a Prisma nenhum, por isso é estruturalmente impossível que
  // "veja" o PVP actual — só o que o chamador lhe der.
  const valorComPvpOriginal = calcularValorBrutoCelula(30, farmaciasPvpNaCriacao[0].pvpReferencia);
  const valorComPvpActual = calcularValorBrutoCelula(30, farmaciasPvpMaisTarde[0].pvpReferencia);
  eq(valorComPvpOriginal, 199.8, "G4: valor bruto com o PVP de referência ORIGINAL (30×6,66)");
  eq(valorComPvpActual, 299.7, "G5: …é diferente do que daria com o PVP ACTUAL (30×9,99) — nunca são confundidos");
  check(valorComPvpOriginal !== valorComPvpActual, "G6: os dois valores são distintos — prova que importa qual PVP se usa");
}

{
  // criarManutencao persiste o snapshot EXACTAMENTE como veio — sem
  // recalcular, sem arredondar de novo, sem tocar no valor.
  const { fake, chamadas } = prismaFalsoManutencao({});
  await criarManutencao(fake, {
    produtoId: "p1",
    cnp: 8322628,
    quantidadeTotal: 15,
    numMeses: 3,
    mesInicialAno: 2026,
    mesInicialMes: 4,
    origemDistribuicao: "AUTOMATICA",
    celulas: [{ farmaciaId: "f1", ano: 2026, mes: 4, quantidade: 15 }],
    farmaciasPvp: [{ farmaciaId: "f1", pvpReferencia: 6.66 }],
    criadoPorId: "u1",
  });
  const chamadaCreate = chamadas.find((c) => c.metodo === "vendaManutencao.create");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dataEnviada = (chamadaCreate?.args as any)?.data;
  eq(dataEnviada?.farmaciasPvp?.create, [{ farmaciaId: "f1", pvpReferencia: 6.66 }], "G7: criarManutencao grava o PVP de referência tal como capturado");
}

{
  // substituirDistribuicao (Recalcular → Gravar) NUNCA escreve
  // farmaciasPvp — prova estrutural de que o PVP de referência fica
  // exactamente como estava, mesmo na gravação.
  const { fake, chamadas } = prismaFalsoManutencao({ bloquearProdutoFarmacia: true });
  await substituirDistribuicao(fake, {
    id: "m1",
    quantidadeTotal: 15,
    numMeses: 3,
    mesInicialAno: 2026,
    mesInicialMes: 4,
    celulas: [{ farmaciaId: "f1", ano: 2026, mes: 4, quantidade: 15 }],
    atualizadoPorId: "u1",
  });
  const chamadaUpdate = chamadas.find((c) => c.metodo === "vendaManutencao.update");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dataEnviada = (chamadaUpdate?.args as any)?.data;
  check(!("farmaciasPvp" in dataEnviada), "G8: substituirDistribuicao nunca inclui farmaciasPvp no update (Prisma bloqueado confirma que nem tentou reler)");
}

{
  // guardarCelulasAjustadas (ajuste manual de uma célula) — mesma prova.
  const { fake, chamadas } = prismaFalsoManutencao({ bloquearProdutoFarmacia: true });
  await guardarCelulasAjustadas(fake, {
    id: "m1",
    celulas: [{ farmaciaId: "f1", ano: 2026, mes: 4, quantidade: 20 }],
    atualizadoPorId: "u1",
  });
  const chamadaUpdate = chamadas.find((c) => c.metodo === "vendaManutencao.update");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dataEnviada = (chamadaUpdate?.args as any)?.data;
  check(!("farmaciasPvp" in dataEnviada), "G9: guardarCelulasAjustadas nunca inclui farmaciasPvp no update");
  eq(dataEnviada?.origemDistribuicao, "MANUAL_AJUSTADA", "G10: mas marca correctamente a origem como ajustada à mão");
}

// ══════════════════════════════════════════════════════════════════════
// H · calcularDistribuicaoQuantidades — sazonalidade PONTA-A-PONTA
//
// Prisma falso que distingue as TRÊS queries raw (peso por farmácia,
// perfil mensal por farmácia, perfil mensal global) pelo texto do SQL
// — `prisma.$queryRaw` é chamado aqui como tagged template DIRECTO
// (nunca via `Prisma.sql` primeiro), por isso o falso recebe sempre
// `(strings: TemplateStringsArray, ...values)`; reconstruir o texto com
// `strings.join(" ")` é o único jeito correcto de inspeccionar qual SQL
// está a ser pedido, sem depender de nenhuma conversão que só o Prisma
// real faz.
//
// Cenário espelha o caso relatado (CNP 8168534): 500 unidades, 2
// farmácias, 5 meses (Set/2026..Jan/2027) — Segurado com histórico
// pequeno (30 no total, perfil mensal PRÓPRIO irregular), Silveirense
// com histórico grande (470) mas SEM perfil mensal próprio (cai para o
// perfil GLOBAL do artigo).
// ══════════════════════════════════════════════════════════════════════
type LinhaFake = { farmaciaId?: string; mes?: number; qty: number };

function prismaFalsoSazonalidade(opts: {
  pesoFarmacia: { farmaciaId: string; qty: number }[];
  perfilMensalFarmacia: { farmaciaId: string; mes: number; qty: number }[];
  perfilMensalGlobal: { mes: number; qty: number }[];
}) {
  const chamadas = { pesoFarmacia: 0, mensalFarmacia: 0, mensalGlobal: 0 };
  const fake = {
    $queryRaw: async (strings: TemplateStringsArray): Promise<LinhaFake[]> => {
      const texto = Array.isArray(strings) ? strings.join(" ") : String(strings);
      if (texto.includes('GROUP BY vm."farmaciaId", vm.mes')) {
        chamadas.mensalFarmacia++;
        return opts.perfilMensalFarmacia;
      }
      if (texto.includes("GROUP BY vm.mes")) {
        chamadas.mensalGlobal++;
        return opts.perfilMensalGlobal;
      }
      if (texto.includes('GROUP BY vm."farmaciaId"')) {
        chamadas.pesoFarmacia++;
        return opts.pesoFarmacia;
      }
      throw new Error(`SQL raw inesperado no teste: ${texto}`);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { fake, chamadas };
}

console.log("\nH · calcularDistribuicaoQuantidades — sazonalidade ponta-a-ponta");
{
  const { fake, chamadas } = prismaFalsoSazonalidade({
    pesoFarmacia: [
      { farmaciaId: "segurado", qty: 30 },
      { farmaciaId: "silveirense", qty: 470 },
    ],
    // Só Segurado tem perfil mensal PRÓPRIO — irregular, o fixture pedido.
    perfilMensalFarmacia: [
      { farmaciaId: "segurado", mes: 9, qty: 10 },
      { farmaciaId: "segurado", mes: 10, qty: 20 },
      { farmaciaId: "segurado", mes: 11, qty: 30 },
      { farmaciaId: "segurado", mes: 12, qty: 80 },
      { farmaciaId: "segurado", mes: 1, qty: 60 },
    ],
    // Perfil global do artigo — usado pela Silveirense (sem perfil próprio).
    perfilMensalGlobal: [
      { mes: 9, qty: 5 }, { mes: 10, qty: 5 }, { mes: 11, qty: 10 },
      { mes: 12, qty: 50 }, { mes: 1, qty: 30 },
    ],
  });

  const proposta = await calcularDistribuicaoQuantidades(fake, {
    produtoId: "p-8168534",
    farmacias: [{ id: "segurado", nome: "Segurado" }, { id: "silveirense", nome: "Silveirense" }],
    quantidadeTotal: 500,
    numMeses: 5,
    mesInicialAno: 2026,
    mesInicialMes: 9,
  });

  eq(chamadas.pesoFarmacia, 1, "H1: a query de peso por farmácia correu exactamente 1 vez (não uma vez por farmácia)");
  eq(chamadas.mensalFarmacia, 1, "H2: a query de perfil mensal por farmácia correu exactamente 1 vez");
  eq(chamadas.mensalGlobal, 1, "H3: a query de perfil mensal global correu exactamente 1 vez");

  // Peso por farmácia — exactamente o caso relatado: 6%/94%.
  const pesoSegurado = proposta.pesosFarmacia.find((p) => p.farmaciaId === "segurado");
  const pesoSilveirense = proposta.pesosFarmacia.find((p) => p.farmaciaId === "silveirense");
  eq(pesoSegurado?.peso, 0.06, "H4: Segurado — peso histórico 6,0% (30/500)");
  eq(pesoSilveirense?.peso, 0.94, "H5: Silveirense — peso histórico 94,0% (470/500)");

  const somaCelulas = somaQuantidades(proposta.celulas);
  eq(somaCelulas, 500, "H6: soma final exacta — 500");

  const totalPorFarmacia = new Map<string, number>();
  for (const c of proposta.celulas) totalPorFarmacia.set(c.farmaciaId, (totalPorFarmacia.get(c.farmaciaId) ?? 0) + c.quantidade);
  eq(totalPorFarmacia.get("segurado"), 30, "H7: Segurado recebe 30 no total (6% de 500) — bate com o caso relatado");
  eq(totalPorFarmacia.get("silveirense"), 470, "H8: Silveirense recebe 470 no total (94% de 500) — bate com o caso relatado");

  // Transparência do peso mensal — origens diferentes por farmácia.
  const pesosMensaisSegurado = proposta.pesosMensais.find((p) => p.farmaciaId === "segurado");
  const pesosMensaisSilveirense = proposta.pesosMensais.find((p) => p.farmaciaId === "silveirense");
  eq(pesosMensaisSegurado?.origem, "FARMACIA", "H9: Segurado usa o PRÓPRIO perfil mensal (tem amostra suficiente)");
  eq(pesosMensaisSilveirense?.origem, "GLOBAL", "H10: Silveirense cai para o perfil GLOBAL (sem perfil mensal próprio)");

  // Segurado: 30 unidades pelo perfil [10,20,30,80,60]/200 — NUNCA 6×5.
  const celulasSegurado = proposta.celulas.filter((c) => c.farmaciaId === "segurado");
  const porMesSegurado = new Map(celulasSegurado.map((c) => [c.mes, c.quantidade]));
  check(
    JSON.stringify(celulasSegurado.map((c) => c.quantidade)) !== JSON.stringify([6, 6, 6, 6, 6]),
    "H11: Segurado NÃO fica 6/6/6/6/6 (30÷5) — o bug relatado está corrigido também ao nível de UMA farmácia",
  );
  check((porMesSegurado.get(12) ?? 0) > (porMesSegurado.get(9) ?? 0), "H12: Dezembro > Setembro para o Segurado — reflecte o histórico irregular");
  eq(somaQuantidades(celulasSegurado.map((c) => ({ quantidade: c.quantidade }))), 30, "H13: soma do Segurado bate — 30");

  // Silveirense: 470 unidades pelo perfil global [5,5,10,50,30]/100.
  const celulasSilveirense = proposta.celulas.filter((c) => c.farmaciaId === "silveirense");
  const porMesSilveirense = new Map(celulasSilveirense.map((c) => [c.mes, c.quantidade]));
  check(
    JSON.stringify(celulasSilveirense.map((c) => c.quantidade)) !== JSON.stringify([94, 94, 94, 94, 94]),
    "H14: Silveirense NÃO fica 94/94/94/94/94 (470÷5) — mesma correcção aplicada à farmácia dominante",
  );
  check((porMesSilveirense.get(12) ?? 0) > (porMesSilveirense.get(9) ?? 0), "H15: Dezembro > Setembro para a Silveirense também (perfil global sazonal)");
  eq(somaQuantidades(celulasSilveirense.map((c) => ({ quantidade: c.quantidade }))), 470, "H16: soma da Silveirense bate — 470");
}

{
  // Farmácia SEM histórico nenhum do artigo (nem peso, nem perfil
  // mensal) — a distribuição por farmácia já assinala isto (secção
  // 1.7); a parte mensal, para essa farmácia, cai directamente em
  // NEUTRO se também não houver perfil global.
  const { fake } = prismaFalsoSazonalidade({
    pesoFarmacia: [{ farmaciaId: "comHistorico", qty: 100 }], // "semHistorico" nem aparece — 0 implícito
    perfilMensalFarmacia: [
      { farmaciaId: "comHistorico", mes: 1, qty: 20 }, { farmaciaId: "comHistorico", mes: 2, qty: 80 },
    ],
    perfilMensalGlobal: [],
  });
  const proposta = await calcularDistribuicaoQuantidades(fake, {
    produtoId: "p-x",
    farmacias: [{ id: "comHistorico", nome: "Com histórico" }, { id: "semHistorico", nome: "Sem histórico" }],
    quantidadeTotal: 100,
    numMeses: 2,
    mesInicialAno: 2026,
    mesInicialMes: 1,
  });
  const totalSemHistorico = proposta.celulas.filter((c) => c.farmaciaId === "semHistorico").reduce((s, c) => s + c.quantidade, 0);
  eq(totalSemHistorico, 0, "H17: farmácia sem histórico algum recebe 0 (nunca inventa peso) — aviso é responsabilidade da UI");
  const pesosMensaisSemHistorico = proposta.pesosMensais.find((p) => p.farmaciaId === "semHistorico");
  eq(pesosMensaisSemHistorico?.origem, "NEUTRO", "H18: sem histórico mensal em lado nenhum para esta farmácia — origem NEUTRO");
}

{
  // Artigo sem QUALQUER histórico, em lado nenhum — o único caso
  // legítimo de partes iguais (secção 1.7/3.c).
  const { fake } = prismaFalsoSazonalidade({ pesoFarmacia: [], perfilMensalFarmacia: [], perfilMensalGlobal: [] });
  const proposta = await calcularDistribuicaoQuantidades(fake, {
    produtoId: "p-novo",
    farmacias: [{ id: "f1", nome: "F1" }, { id: "f2", nome: "F2" }],
    quantidadeTotal: 10,
    numMeses: 5,
    mesInicialAno: 2026,
    mesInicialMes: 9,
  });
  eq(proposta.aviso?.tipo, "SEM_HISTORICO_NENHUM", "H19: aviso correcto quando nenhuma farmácia tem histórico");
  check(proposta.pesosMensais.every((p) => p.origem === "NEUTRO"), "H20: sem histórico em lado nenhum — todas as farmácias com origem NEUTRO");
  eq(somaQuantidades(proposta.celulas), 10, "H21: mesmo sem histórico nenhum, a soma continua exacta — partes iguais é só o ÚLTIMO recurso, nunca falha a somar");
}

{
  // Edição manual seguida de "Recalcular pelo histórico" — o recálculo
  // tem de voltar a produzir a distribuição sazonal (nunca reaparece
  // a versão editada à mão, porque `calcularDistribuicaoQuantidades`
  // é sempre um cálculo FRESCO a partir do histórico, nunca lê a
  // matriz anterior).
  const { fake } = prismaFalsoSazonalidade({
    pesoFarmacia: [{ farmaciaId: "f1", qty: 100 }],
    perfilMensalFarmacia: [
      { farmaciaId: "f1", mes: 9, qty: 10 }, { farmaciaId: "f1", mes: 10, qty: 90 },
    ],
    perfilMensalGlobal: [],
  });
  const params = {
    produtoId: "p1",
    farmacias: [{ id: "f1", nome: "F1" }],
    quantidadeTotal: 100,
    numMeses: 2,
    mesInicialAno: 2026,
    mesInicialMes: 9,
  };
  const automatica = await calcularDistribuicaoQuantidades(fake, params);
  // Simula uma edição manual (o utilizador muda tudo para 50/50).
  const editadaAMao = automatica.celulas.map((c) => ({ ...c, quantidade: 50 }));
  check(JSON.stringify(editadaAMao.map((c) => c.quantidade)) !== JSON.stringify(automatica.celulas.map((c) => c.quantidade)), "H22: a edição manual difere mesmo da proposta automática (pré-condição do teste)");
  // "Recalcular pelo histórico" — chama a MESMA função outra vez, com
  // os mesmos parâmetros — tem de IGNORAR a edição manual e voltar a
  // dar a distribuição sazonal (10/90), nunca a versão editada.
  const recalculada = await calcularDistribuicaoQuantidades(fake, params);
  eq(recalculada.celulas.map((c) => c.quantidade), automatica.celulas.map((c) => c.quantidade), "H23: recalcular reconstrói a proposta do zero a partir do histórico — descarta qualquer edição manual anterior");
  eq(recalculada.celulas.map((c) => c.quantidade), [10, 90], "H24: mantém a distribuição sazonal (10/90), nunca a editada à mão (50/50)");
}

console.log(`\n${ok} ok, ${ko} falhas`);
}

principal().then(() => {
  process.exit(ko === 0 ? 0 : 1);
});
