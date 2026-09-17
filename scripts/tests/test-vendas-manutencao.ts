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
  janelaHistoricaDozeMeses,
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
  // Com resto: 100/6 não divide exacto — soma continua a bater, tudo
  // em inteiros: 4 meses com 17, 2 meses com 16 (100 = 4×17 + 2×16).
  const r = distribuirPorMeses(100, 2026, 1, 6);
  eq(somaQuantidades(r), 100, "B7: soma exacta mesmo com resto (100/6)");
  check(r.every((m) => Number.isInteger(m.quantidade)), "B8: todos os meses recebem quantidade inteira");
  const contagem = { 16: 0, 17: 0 } as Record<number, number>;
  for (const m of r) contagem[m.quantidade] = (contagem[m.quantidade] ?? 0) + 1;
  eq(contagem[17], 4, "B9: 4 meses com 17 (o resto)");
  eq(contagem[16], 2, "B10: 2 meses com 16 (a base)");
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

console.log(`\n${ok} ok, ${ko} falhas`);
}

principal().then(() => {
  process.exit(ko === 0 ? 0 : 1);
});
