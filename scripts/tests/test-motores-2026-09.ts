/**
 * scripts/tests/test-motores-2026-09.ts
 *
 * A alteração de 2026-09 aos motores de stock:
 *
 *   TRANSFERÊNCIAS   origem > 120d · alvo 45d · mínimo 3 · reserva 30d
 *   ROTURAS          três níveis, com a crítica a ter dois ramos
 *   DASHBOARD        o valor em excesso passa a ser o do motor de /excessos
 *
 * Secções:
 *   A  os parâmetros canónicos, num sítio só
 *   B  a reserva da origem: nunca abaixo, nunca negativa, nunca zero
 *   C  o caso patológico (stock 5, 6 un/ano) deixa de esvaziar a origem
 *   D  rotura crítica pelos dois ramos, e por nenhum
 *   E  os três níveis particionam o universo antigo
 *   F  os filtros de stock para os três estados
 *   G  o Dashboard e /excessos passam a somar a mesma coisa
 *
 * Corre com:  npm run test:motores-2026-09
 */
import { readFileSync } from "node:fs";
import {
  EXCESSO_COVERAGE_DAYS,
  EXCESSO_MINIMO_UNIDADES,
  EXCESSO_TARGET_DAYS,
  RESERVA_ORIGEM_DIAS,
} from "../../lib/operational/metrics-shared";
import {
  avaliarLinha,
  ehAccionavel,
  emparelhar,
  type EstadoStock,
  type LinhaStock,
  type ParametrosMotor,
} from "../../lib/operational/motor-stock";
import {
  ROTURA_MESES_MINIMOS,
  ROTURA_RECENCIA_DIAS,
  ROTURA_UNIDADES_MINIMAS,
  classificarRotura,
  semStockComProcura,
  type LinhaRotura,
} from "../../lib/operational/rotura";
import { matchStockFilter, type StockRowEnriched } from "../../lib/stock-shared";

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
  check(
    JSON.stringify(a) === JSON.stringify(b),
    label,
    `esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`,
  );

const JANELA = 365;
const PARAMS: ParametrosMotor = {
  diasJanela: JANELA,
  thresholdDays: EXCESSO_COVERAGE_DAYS,
  targetDays: EXCESSO_TARGET_DAYS,
  excessoMinimo: EXCESSO_MINIMO_UNIDADES,
  reservaDias: RESERVA_ORIGEM_DIAS,
};

const linha = (id: string, stock: number, vendas: number): LinhaStock => ({
  farmaciaId: id,
  farmaciaNome: id,
  stockAtual: stock,
  vendasJanela: vendas,
});

const avaliar = (g: LinhaStock[], p = PARAMS): EstadoStock[] => g.map((l) => avaliarLinha(l, p));

// ══════════════════════════════════════════════════════════════════════
console.log("\nA · os parâmetros canónicos");
eq(EXCESSO_COVERAGE_DAYS, 120, "cobertura de origem: 120 dias");
eq(EXCESSO_TARGET_DAYS, 45, "cobertura-alvo: 45 dias");
eq(EXCESSO_MINIMO_UNIDADES, 3, "excesso mínimo: 3 unidades");
eq(RESERVA_ORIGEM_DIAS, 30, "reserva da origem: 30 dias");
{
  // Os relatórios têm de LER as constantes, e não repetir os números.
  // Foi assim que os dois motores divergiram da primeira vez.
  const dados = readFileSync("lib/transferencias-data.ts", "utf8");
  check(
    dados.includes("excessoMinimo: EXCESSO_MINIMO_UNIDADES"),
    "transferencias-data lê a constante do mínimo",
  );
  check(
    dados.includes("reservaDias: RESERVA_ORIGEM_DIAS"),
    "…e a da reserva",
  );
  check(
    dados.includes("options?.targetDays ?? EXCESSO_TARGET_DAYS"),
    "…e a do alvo",
  );
  check(!/excessoMinimo: 5\b/.test(dados), "e já não tem o 5 escrito à mão");
}

// ══════════════════════════════════════════════════════════════════════
console.log("\nB · a reserva da origem");
{
  // Origem com 2 anos de cobertura, destino insaciável: a origem cede
  // tudo o que a regra permite.
  const grupo = avaliar([linha("A", 730, 365), linha("B", 1, 36500)]);
  const par = emparelhar(grupo[0], grupo);
  check(ehAccionavel(par), "há transferência");

  const restante = grupo[0].stockAtual - par.quantidadeSugerida;
  check(restante >= 0, `o stock residual não é negativo (${restante})`);
  check(restante > 0, `…nem zero (${restante})`);

  const coberturaRestante = restante / grupo[0].avgDaily;
  check(
    coberturaRestante >= RESERVA_ORIGEM_DIAS,
    `a origem fica com ${coberturaRestante.toFixed(1)}d, não menos do que a reserva de ${RESERVA_ORIGEM_DIAS}d`,
  );

  // `transferivel` é o tecto, e tem de ser FLOOR — arredondar para cima
  // devolveria a meia unidade que a reserva existe para proteger.
  eq(
    grupo[0].transferivel,
    Math.floor(730 - RESERVA_ORIGEM_DIAS * grupo[0].avgDaily),
    "o tecto transferível é floor(stock − reserva × média)",
  );
  const motor = readFileSync("lib/operational/motor-stock.ts", "utf8");
  check(
    motor.includes("Math.floor(linha.stockAtual - reserva * avgDaily)"),
    "e está escrito com floor, não com round",
  );
  check(
    motor.includes("origem.transferivel,"),
    "a terceira fronteira da sugestão é o tecto, já não o stock",
  );
}

// ══════════════════════════════════════════════════════════════════════
console.log("\nC · o caso patológico deixa de esvaziar a origem");
{
  // stock 5, 6 unidades/ano ⇒ média 0,0164/dia ⇒ cobertura 304 dias.
  // excesso = round((304 − 45) × 0,0164) = round(4,26) = 4
  // Sem reserva, a origem ficava com 1. Com reserva de 30 dias o tecto
  // é floor(5 − 0,49) = 4 — e o que a protege de verdade é o alvo ter
  // subido para 45. O teste vale pelos dois.
  const grupo = avaliar([linha("A", 5, 6), linha("B", 1, 600)]);
  const par = emparelhar(grupo[0], grupo);
  const restante = 5 - par.quantidadeSugerida;
  console.log(
    `            excesso=${grupo[0].excesso} tecto=${grupo[0].transferivel} sugestão=${par.quantidadeSugerida} resto=${restante}`,
  );
  check(restante > 0, `stock 5 com 6 un/ano: a origem NÃO fica a zero (fica com ${restante})`);

  // E a varredura: nenhuma combinação de stock e consumo baixos
  // consegue esvaziar a origem.
  let esvaziadas = 0;
  let piorCobertura = Infinity;
  for (let vendas = 1; vendas <= 60; vendas++) {
    for (let stock = 1; stock <= 400; stock++) {
      const g = avaliar([linha("A", stock, vendas), linha("B", 1, vendas * 50)]);
      const p = emparelhar(g[0], g);
      if (!ehAccionavel(p)) continue;
      const resto = stock - p.quantidadeSugerida;
      if (resto <= 0) esvaziadas++;
      const cob = resto / g[0].avgDaily;
      if (cob < piorCobertura) piorCobertura = cob;
    }
  }
  console.log(
    `            varredura: ${esvaziadas} origens esvaziadas · pior cobertura residual ${piorCobertura.toFixed(1)}d`,
  );
  eq(esvaziadas, 0, "em 24 000 combinações, NENHUMA origem fica a zero");
  check(
    piorCobertura >= RESERVA_ORIGEM_DIAS,
    `e a pior cobertura residual (${piorCobertura.toFixed(1)}d) respeita a reserva`,
  );
}

// ══════════════════════════════════════════════════════════════════════
console.log("\nD · rotura crítica: os dois ramos");
{
  const AGORA = new Date("2026-09-04T12:00:00Z").getTime();
  const haDias = (n: number) => new Date(AGORA - n * 86_400_000);

  const base = (over: Partial<LinhaRotura>): LinhaRotura => ({
    stockAtual: 0,
    dataUltimaVenda: haDias(5),
    salesQty90d: 1,
    mesesComVenda12M: 1,
    ...over,
  });

  // Ramo 1 · recorrência
  eq(
    classificarRotura(base({ mesesComVenda12M: 2, salesQty90d: 1 }), AGORA),
    "CRITICA",
    "ramo recorrência: 2 meses com venda, mesmo com 1 unidade",
  );

  // Ramo 2 · volume — o artigo NOVO
  eq(
    classificarRotura(base({ mesesComVenda12M: 1, salesQty90d: 4 }), AGORA),
    "CRITICA",
    "ramo volume: artigo novo com 4 unidades num único mês",
  );

  // Nenhum dos dois: o caso que motivou tudo isto.
  eq(
    classificarRotura(base({ mesesComVenda12M: 1, salesQty90d: 1 }), AGORA),
    "OCASIONAL",
    "1 unidade num único mês, vendida há 5 dias, NÃO é crítica",
  );

  // Recência é obrigatória nos dois ramos.
  eq(
    classificarRotura(
      base({ dataUltimaVenda: haDias(45), mesesComVenda12M: 6, salesQty90d: 20 }),
      AGORA,
    ),
    "OCASIONAL",
    "sem venda há 45 dias não é crítica, por muito recorrente que seja",
  );
  eq(
    classificarRotura(base({ dataUltimaVenda: haDias(120), salesQty90d: 5 }), AGORA),
    "SEM_PROCURA",
    "sem venda há 120 dias: procura que já não é actual",
  );
  eq(
    classificarRotura(base({ salesQty90d: 0 }), AGORA),
    "SEM_PROCURA",
    "sem vendas na janela de 3 meses",
  );
  eq(
    classificarRotura(base({ dataUltimaVenda: null, salesQty90d: 2 }), AGORA),
    "SEM_PROCURA",
    "sem data de última venda: não se inventa recência",
  );
  eq(
    classificarRotura(base({ stockAtual: 3 }), AGORA),
    null,
    "com stock não há classificação nenhuma — é a ausência da pergunta",
  );

  // Fronteiras exactas.
  eq(
    classificarRotura(
      base({ dataUltimaVenda: haDias(ROTURA_RECENCIA_DIAS), mesesComVenda12M: 2 }),
      AGORA,
    ),
    "CRITICA",
    `exactamente ${ROTURA_RECENCIA_DIAS} dias ainda conta`,
  );
  eq(
    classificarRotura(
      base({ dataUltimaVenda: haDias(ROTURA_RECENCIA_DIAS + 1), mesesComVenda12M: 2 }),
      AGORA,
    ),
    "OCASIONAL",
    `${ROTURA_RECENCIA_DIAS + 1} dias já não`,
  );
  eq(
    classificarRotura(base({ salesQty90d: ROTURA_UNIDADES_MINIMAS - 1 }), AGORA),
    "OCASIONAL",
    `${ROTURA_UNIDADES_MINIMAS - 1} unidades não chegam pelo ramo do volume`,
  );
  eq(ROTURA_MESES_MINIMOS, 2, "o ramo da recorrência exige 2 meses");
}

// ══════════════════════════════════════════════════════════════════════
console.log("\nE · os três níveis particionam o universo antigo");
{
  const AGORA = new Date("2026-09-04T12:00:00Z").getTime();
  const haDias = (n: number) => new Date(AGORA - n * 86_400_000);

  // Uma amostra que cobre os casos todos, incluindo os que a regra
  // antiga já não contava.
  const amostra: LinhaRotura[] = [
    { stockAtual: 0, dataUltimaVenda: haDias(2), salesQty90d: 10, mesesComVenda12M: 8 },
    { stockAtual: 0, dataUltimaVenda: haDias(20), salesQty90d: 4, mesesComVenda12M: 1 },
    { stockAtual: 0, dataUltimaVenda: haDias(10), salesQty90d: 1, mesesComVenda12M: 1 },
    { stockAtual: 0, dataUltimaVenda: haDias(70), salesQty90d: 3, mesesComVenda12M: 2 },
    { stockAtual: 0, dataUltimaVenda: haDias(200), salesQty90d: 2, mesesComVenda12M: 1 },
    { stockAtual: 0, dataUltimaVenda: haDias(3), salesQty90d: 0, mesesComVenda12M: 0 },
    { stockAtual: 7, dataUltimaVenda: haDias(3), salesQty90d: 9, mesesComVenda12M: 5 },
  ];

  const antigo = amostra.filter(semStockComProcura).length;
  const criticas = amostra.filter((l) => classificarRotura(l, AGORA) === "CRITICA").length;
  const ocasionais = amostra.filter((l) => classificarRotura(l, AGORA) === "OCASIONAL").length;
  const semProcura = amostra.filter(
    (l) => semStockComProcura(l) && classificarRotura(l, AGORA) === "SEM_PROCURA",
  ).length;

  eq(antigo, 5, "a regra antiga conta 5 destas 7 linhas");
  eq(criticas, 2, "duas críticas (uma por cada ramo)");
  eq(ocasionais, 2, "duas ocasionais");
  eq(semProcura, 1, "uma sem procura recente");
  eq(criticas + ocasionais + semProcura, antigo, "e os três somam exactamente o total antigo");

  // A linha sem vendas nenhumas fica FORA do universo antigo — não é
  // rotura, é catálogo parado, e tem filtro próprio.
  const semVendas = amostra[5];
  check(!semStockComProcura(semVendas), "a linha sem vendas nenhumas não entra no universo");
}

// ══════════════════════════════════════════════════════════════════════
console.log("\nF · os filtros de /stock");
{
  const AGORA = new Date("2026-09-04T12:00:00Z").getTime();
  const haDias = (n: number) => new Date(AGORA - n * 86_400_000);

  const row = (over: Partial<StockRowEnriched>): StockRowEnriched =>
    ({
      produtoId: "p",
      farmaciaId: "f",
      farmaciaNome: "F",
      cnp: "1",
      designacao: "X",
      stockAtual: 0,
      stockMinimo: null,
      pvp: 10,
      puc: 5,
      pmc: 5,
      dataUltimaVenda: haDias(5),
      salesQty90d: 1,
      mesesComVenda12M: 1,
      avgDaily90d: 0.01,
      coverage: 0,
      dci: null,
      codigoATC: null,
      categoria: "",
      subcategoria: "",
      productType: null,
      utilizacoes: [],
      ...over,
    }) as StockRowEnriched;

  const critica = row({ mesesComVenda12M: 4, salesQty90d: 12 });
  const ocasional = row({});
  const antiga = row({ dataUltimaVenda: haDias(150), salesQty90d: 2 });

  check(matchStockFilter(critica, "rotura-critica", AGORA), "rotura-critica apanha a crítica");
  check(!matchStockFilter(ocasional, "rotura-critica", AGORA), "…e não apanha a ocasional");
  check(
    matchStockFilter(ocasional, "sem-stock-ocasional", AGORA),
    "sem-stock-ocasional apanha a ocasional",
  );
  check(
    matchStockFilter(antiga, "sem-stock-sem-procura", AGORA),
    "sem-stock-sem-procura apanha a venda antiga",
  );

  // O filtro antigo continua a ser o universo total.
  for (const r of [critica, ocasional, antiga]) {
    check(matchStockFilter(r, "out-of-stock", AGORA), "out-of-stock continua a apanhar as três");
  }

  // Um artigo que nunca vendeu não é "sem procura recente".
  const nunca = row({ salesQty90d: 0, dataUltimaVenda: null });
  check(
    !matchStockFilter(nunca, "sem-stock-sem-procura", AGORA),
    "quem nunca vendeu não entra em 'sem procura recente' — é catálogo parado",
  );
  check(!matchStockFilter(nunca, "out-of-stock", AGORA), "…nem no universo total");

  // Cada linha cai em exactamente um dos três.
  for (const r of [critica, ocasional, antiga]) {
    const n = (["rotura-critica", "sem-stock-ocasional", "sem-stock-sem-procura"] as const).filter(
      (f) => matchStockFilter(r, f, AGORA),
    ).length;
    eq(n, 1, "cada linha cai em exactamente um dos três níveis");
  }

  // Os rótulos existem e não repetem o antigo.
  const partilhado = readFileSync("lib/stock-shared.ts", "utf8");
  check(
    partilhado.includes('"out-of-stock": "Sem stock (todos)"'),
    "o rótulo antigo passou a dizer o que é",
  );
  check(
    !partilhado.includes("Em rotura (com vendas recentes)"),
    "e o nome enganador desapareceu",
  );
}

// ══════════════════════════════════════════════════════════════════════
console.log("\nG · Dashboard e /excessos somam a mesma coisa");
{
  const dash = readFileSync("lib/dashboard.ts", "utf8");
  check(
    !dash.includes("sum + r.stockAtual * unitCost(r)"),
    "o Dashboard já NÃO valoriza o stock inteiro",
  );
  check(
    dash.includes("sum + x.estado.excesso * unitCost(x.row)"),
    "…passa a valorizar o EXCEDENTE",
  );
  check(
    dash.includes("avaliarLinha("),
    "…usando o mesmo motor de /excessos",
  );
  check(
    dash.includes("thresholdDays: EXCESSO_COVERAGE_DAYS") &&
      dash.includes("targetDays: EXCESSO_TARGET_DAYS") &&
      dash.includes("excessoMinimo: EXCESSO_MINIMO_UNIDADES"),
    "…com os mesmos parâmetros canónicos",
  );

  // Prova numérica: uma linha em que as duas grandezas divergem muito.
  //   stock 400, 200 un/ano ⇒ média 0,548/dia ⇒ cobertura 730d
  //   excedente = round((730 − 45) × 0,548) = 375
  //   valor pelo motor  = 375 × 2 € =   750 €
  //   valor pelo antigo = 400 × 2 € =   800 €
  const e = avaliarLinha(linha("A", 400, 200), PARAMS);
  const custo = 2;
  const valorNovo = e.excesso * custo;
  const valorAntigo = e.stockAtual * custo;
  eq(e.excesso, 375, "o excedente desta linha é 375 unidades");
  check(valorNovo < valorAntigo, `${valorNovo} € < ${valorAntigo} € — o novo é sempre menor ou igual`);

  // E o corte mínimo tira linhas inteiras do universo.
  const pequena = avaliarLinha(linha("A", 130, 100), PARAMS);
  console.log(
    `            linha pequena: cobertura ${pequena.coberturaDias?.toFixed(0)}d, excedente ${pequena.excesso}`,
  );
  check(
    pequena.coberturaDias !== null && pequena.coberturaDias > EXCESSO_COVERAGE_DAYS,
    "há linhas acima do threshold…",
  );
  check(
    pequena.excesso === 0 || pequena.excesso >= EXCESSO_MINIMO_UNIDADES,
    "…mas o excedente ou é zero ou respeita o mínimo — nunca 1 ou 2 unidades",
  );
}

// ══════════════════════════════════════════════════════════════════════
console.log(`\n${ok} ok, ${ko} falhas`);
process.exit(ko === 0 ? 0 : 1);
