/**
 * scripts/tests/test-motores-2026-09.ts
 *
 * A calibração operacional passou a ser POR FARMÁCIA. Este ficheiro
 * guarda a fronteira entre as duas categorias que não se podem misturar:
 *
 *   INVARIANTES TÉCNICOS   valem para toda a gente. São respostas a
 *                          defeitos, não opiniões sobre stock.
 *   PARÂMETROS DE NEGÓCIO  dependem do universo de cada farmácia e só se
 *                          fixam depois de medir.
 *
 * O erro que isto existe para impedir é concreto: os valores 120/45/3
 * foram calibrados com o funil da Silveirense e chegaram a ser escritos
 * como constantes globais. Isso mudava a Garantia — que nunca foi
 * medida — sem que nada no ecrã o dissesse.
 *
 * Secções:
 *   A  os defaults globais são o comportamento ANTERIOR
 *   B  override da Silveira; Garantia e desconhecidos nos defaults
 *   C  isolamento: os MESMOS dados dão resultados diferentes por policy
 *   D  a reserva é derivada do alvo, e é invariante técnico
 *   E  o invariante da origem vale em TODAS as policies
 *   F  a classificação de rotura obedece à policy
 *   G  Dashboard, /excessos e /transferencias resolvem a MESMA policy
 *
 * Corre com:  npm run test:motores-2026-09
 */
import { readFileSync } from "node:fs";
import {
  EXCESSO_COVERAGE_DAYS,
  EXCESSO_MINIMO_UNIDADES,
  EXCESSO_TARGET_DAYS,
} from "../../lib/operational/metrics-shared";
import {
  POLICY_DEFAULT,
  descreverPolicy,
  getOperationalPolicy,
  reservaOrigemDias,
  slugsCalibrados,
  type OperationalPolicy,
} from "../../lib/operational/policy";
import {
  avaliarLinha,
  ehAccionavel,
  emparelhar,
  type EstadoStock,
  type LinhaStock,
  type ParametrosMotor,
} from "../../lib/operational/motor-stock";
import { classificarRotura, semStockComProcura, type LinhaRotura } from "../../lib/operational/rotura";
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
const linha = (id: string, stock: number, vendas: number): LinhaStock => ({
  farmaciaId: id,
  farmaciaNome: id,
  stockAtual: stock,
  vendasJanela: vendas,
});

/** Os parâmetros do motor, derivados de uma policy. Um sítio só. */
function paramsDe(p: OperationalPolicy): ParametrosMotor {
  return {
    diasJanela: JANELA,
    thresholdDays: p.excesso.thresholdDias,
    targetDays: p.excesso.targetDias,
    excessoMinimo: p.excesso.minimoUnidades,
    reservaDias: reservaOrigemDias(p),
  };
}
const avaliar = (g: LinhaStock[], p: OperationalPolicy): EstadoStock[] =>
  g.map((l) => avaliarLinha(l, paramsDe(p)));

const SILVEIRA = getOperationalPolicy("silveira");
const GARANTIA = getOperationalPolicy("garantia");
const DESCONHECIDO = getOperationalPolicy("farmacia-que-nao-existe");
const NULO = getOperationalPolicy(null);

// ══════════════════════════════════════════════════════════════════════
console.log("\nA · os defaults globais são o comportamento anterior");
eq(POLICY_DEFAULT.excesso.thresholdDias, 180, "threshold de excesso: 180 dias");
eq(POLICY_DEFAULT.excesso.targetDias, 30, "cobertura-alvo: 30 dias");
eq(POLICY_DEFAULT.excesso.minimoUnidades, 5, "excesso mínimo: 5 unidades");
eq(POLICY_DEFAULT.rotura.modo, "classica", "o Dashboard mantém o cartão único");
{
  // As constantes antigas continuam a existir e a valer o mesmo — há
  // callers (Inventário) para quem um threshold fixo chega.
  eq(EXCESSO_COVERAGE_DAYS, 180, "EXCESSO_COVERAGE_DAYS não foi mudada");
  eq(EXCESSO_TARGET_DAYS, 30, "EXCESSO_TARGET_DAYS não foi mudada");
  eq(EXCESSO_MINIMO_UNIDADES, 5, "EXCESSO_MINIMO_UNIDADES não foi mudada");
  check(
    !readFileSync("lib/operational/metrics-shared.ts", "utf8").includes("RESERVA_ORIGEM_DIAS ="),
    "e a reserva NÃO é uma constante global — é derivada",
  );
}

// ══════════════════════════════════════════════════════════════════════
console.log("\nB · quem está calibrado e quem não está");
eq(slugsCalibrados(), ["silveira"], "só a Silveira tem override");

eq(SILVEIRA.excesso.thresholdDias, 120, "silveira: 120");
eq(SILVEIRA.excesso.targetDias, 45, "silveira: alvo 45");
eq(SILVEIRA.excesso.minimoUnidades, 3, "silveira: mínimo 3");
check(SILVEIRA.calibrada, "silveira diz-se calibrada");

for (const [nome, p] of [
  ["garantia", GARANTIA],
  ["tenant desconhecido", DESCONHECIDO],
  ["sem tenant (script)", NULO],
] as const) {
  eq(
    [p.excesso.thresholdDias, p.excesso.targetDias, p.excesso.minimoUnidades],
    [180, 30, 5],
    `${nome}: 180 / 30 / 5`,
  );
  check(!p.calibrada, `${nome}: diz que NÃO está calibrado`);
  eq(p.rotura.modo, "classica", `${nome}: cartão de rotura clássico`);
}

// Case e espaços não podem criar um tenant novo por acidente.
eq(getOperationalPolicy(" Silveira ").excesso.thresholdDias, 120, "o slug é normalizado");

// A policy é IMUTÁVEL para quem a recebe: mexer numa cópia não pode
// contaminar a próxima chamada.
{
  const a = getOperationalPolicy("silveira");
  a.excesso.thresholdDias = 999;
  eq(
    getOperationalPolicy("silveira").excesso.thresholdDias,
    120,
    "alterar a policy devolvida não contamina a seguinte",
  );
  const g = getOperationalPolicy("garantia");
  g.excesso.targetDias = 999;
  eq(getOperationalPolicy("garantia").excesso.targetDias, 30, "…nem sequer a de outro tenant");
}

// ══════════════════════════════════════════════════════════════════════
console.log("\nC · isolamento: os mesmos dados, resultados diferentes");
{
  // Uma linha com cobertura de 150 dias: acima do threshold da Silveira
  // (120) e ABAIXO do default (180). É excesso para uma e não para a
  // outra — que é exactamente o ponto.
  //   stock 150, 365 vendas/ano ⇒ média 1/dia ⇒ cobertura 150 d
  const dados = [linha("A", 150, 365), linha("B", 1, 365)];

  const sil = avaliar(dados, SILVEIRA);
  const gar = avaliar(dados, GARANTIA);

  check(sil[0].excesso > 0, `silveira: cobertura 150d É excesso (${sil[0].excesso} un)`);
  eq(gar[0].excesso, 0, "garantia: a MESMA linha não é excesso nenhum");

  const parSil = emparelhar(sil[0], sil);
  const parGar = emparelhar(gar[0], gar);
  check(ehAccionavel(parSil), "silveira: há transferência");
  check(!ehAccionavel(parGar), "garantia: não há transferência nenhuma");

  // E o destino também difere: a Garantia enche até 30, a Silveira até 45.
  eq(sil[1].necessidade, 44, "silveira: o destino precisa de 44 unidades (45 − 1)");
  eq(gar[1].necessidade, 29, "garantia: precisa de 29 (30 − 1)");

  // Mudar a Silveira não pode mexer na Garantia. Prova-se recalculando
  // a Garantia DEPOIS de correr a Silveira, com os mesmos dados.
  const garOutraVez = avaliar(dados, GARANTIA);
  eq(
    garOutraVez.map((e) => [e.excesso, e.necessidade]),
    gar.map((e) => [e.excesso, e.necessidade]),
    "correr a policy da Silveira não altera a da Garantia",
  );
}

// ══════════════════════════════════════════════════════════════════════
console.log("\nD · a reserva é derivada do alvo");
eq(reservaOrigemDias(SILVEIRA), 45, "silveira: reserva 45 (= alvo)");
eq(reservaOrigemDias(GARANTIA), 30, "garantia: reserva 30 (= alvo)");
eq(reservaOrigemDias(NULO), 30, "default: reserva 30 (= alvo)");
{
  const pol = readFileSync("lib/operational/policy.ts", "utf8");
  check(
    pol.includes("return p.excesso.targetDias;"),
    "a reserva é literalmente o alvo, não um número paralelo",
  );
  check(
    !/reservaOrigemDias\??:\s*number/.test(pol),
    "e NÃO é um campo configurável — não há segunda opinião sobre o alvo",
  );
}

// ══════════════════════════════════════════════════════════════════════
console.log("\nE · o invariante da origem vale em TODAS as policies");
{
  // O invariante técnico: a origem nunca fica abaixo da sua reserva, e
  // o stock residual nunca é negativo nem zero. Vale para quem foi
  // medido e para quem não foi.
  for (const [nome, pol] of [
    ["silveira (120/45/3)", SILVEIRA],
    ["garantia (180/30/5)", GARANTIA],
  ] as const) {
    let esvaziadas = 0;
    let negativas = 0;
    let abaixoReserva = 0;
    let piorCobertura = Infinity;
    let sugestoes = 0;
    const reserva = reservaOrigemDias(pol);

    for (let vendas = 1; vendas <= 60; vendas++) {
      for (let stock = 1; stock <= 400; stock++) {
        const g = avaliar([linha("A", stock, vendas), linha("B", 1, vendas * 50)], pol);
        const par = emparelhar(g[0], g);
        if (!ehAccionavel(par)) continue;
        sugestoes++;
        const resto = stock - par.quantidadeSugerida;
        if (resto < 0) negativas++;
        if (resto <= 0) esvaziadas++;
        const cob = resto / g[0].avgDaily;
        if (cob < reserva - 1e-9) abaixoReserva++;
        if (cob < piorCobertura) piorCobertura = cob;
      }
    }
    console.log(
      `            ${nome}: ${sugestoes} sugestões · pior cobertura residual ${piorCobertura.toFixed(1)}d`,
    );
    check(sugestoes > 0, `${nome}: a varredura produziu sugestões (não é vácua)`);
    eq(negativas, 0, `${nome}: stock residual nunca negativo`);
    eq(esvaziadas, 0, `${nome}: nenhuma origem fica a zero`);
    eq(abaixoReserva, 0, `${nome}: nenhuma origem abaixo da reserva de ${reserva}d`);
  }

  // O caso patológico concreto, nas duas policies.
  for (const [nome, pol] of [["silveira", SILVEIRA], ["garantia", GARANTIA]] as const) {
    const g = avaliar([linha("A", 5, 6), linha("B", 1, 600)], pol);
    const par = emparelhar(g[0], g);
    check(
      5 - par.quantidadeSugerida > 0,
      `${nome}: stock 5 com 6 un/ano não fica a zero (cede ${par.quantidadeSugerida})`,
    );
  }

  // Sem reserva, o defeito reaparece — o teste não é vácuo.
  {
    let esvaziadas = 0;
    for (let vendas = 1; vendas <= 20; vendas++) {
      for (let stock = 1; stock <= 100; stock++) {
        const semReserva: ParametrosMotor = { ...paramsDe(GARANTIA), reservaDias: 0 };
        const g = [linha("A", stock, vendas), linha("B", 1, vendas * 50)].map((l) =>
          avaliarLinha(l, semReserva),
        );
        const par = emparelhar(g[0], g);
        if (ehAccionavel(par) && stock - par.quantidadeSugerida <= 0) esvaziadas++;
      }
    }
    check(esvaziadas > 0, "sem reserva o defeito reaparece — o invariante está a fazer trabalho");
  }
}

// ══════════════════════════════════════════════════════════════════════
console.log("\nF · a classificação de rotura obedece à policy");
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
  const pol = POLICY_DEFAULT.rotura;

  // Ramo 1 · recorrência
  eq(
    classificarRotura(base({ mesesComVenda12M: 2 }), pol, AGORA),
    "CRITICA",
    "ramo recorrência: 2 meses com venda, mesmo com 1 unidade",
  );
  // Ramo 2 · volume — o artigo NOVO
  eq(
    classificarRotura(base({ mesesComVenda12M: 1, salesQty90d: 4 }), pol, AGORA),
    "CRITICA",
    "ramo volume: artigo novo com 4 unidades num único mês",
  );
  // Nenhum dos dois
  eq(
    classificarRotura(base({}), pol, AGORA),
    "OCASIONAL",
    "1 unidade num único mês, vendida há 5 dias, NÃO é crítica",
  );
  eq(
    classificarRotura(base({ dataUltimaVenda: haDias(45), mesesComVenda12M: 6 }), pol, AGORA),
    "OCASIONAL",
    "sem venda há 45 dias não é crítica, por muito recorrente que seja",
  );
  eq(
    classificarRotura(base({ dataUltimaVenda: haDias(120) }), pol, AGORA),
    "SEM_PROCURA",
    "sem venda há 120 dias",
  );
  eq(classificarRotura(base({ salesQty90d: 0 }), pol, AGORA), "SEM_PROCURA", "sem vendas em 3M");
  eq(
    classificarRotura(base({ dataUltimaVenda: null, salesQty90d: 2 }), pol, AGORA),
    "SEM_PROCURA",
    "sem data: não se inventa recência",
  );
  eq(classificarRotura(base({ stockAtual: 3 }), pol, AGORA), null, "com stock não há pergunta");

  // Fronteiras
  eq(
    classificarRotura(base({ dataUltimaVenda: haDias(30), mesesComVenda12M: 2 }), pol, AGORA),
    "CRITICA",
    "exactamente 30 dias ainda conta",
  );
  eq(
    classificarRotura(base({ dataUltimaVenda: haDias(31), mesesComVenda12M: 2 }), pol, AGORA),
    "OCASIONAL",
    "31 dias já não",
  );

  // A MESMA linha, duas policies diferentes.
  const linhaLimite = base({ mesesComVenda12M: 1, salesQty90d: 4 });
  const polApertada = { ...pol, unidadesMinimas: 10 };
  eq(classificarRotura(linhaLimite, pol, AGORA), "CRITICA", "com o default é crítica");
  eq(
    classificarRotura(linhaLimite, polApertada, AGORA),
    "OCASIONAL",
    "com um limiar de volume mais alto, a MESMA linha deixa de ser",
  );

  // Partição exacta do universo antigo.
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
  const c = amostra.filter((l) => classificarRotura(l, pol, AGORA) === "CRITICA").length;
  const o = amostra.filter((l) => classificarRotura(l, pol, AGORA) === "OCASIONAL").length;
  const sp = amostra.filter(
    (l) => semStockComProcura(l) && classificarRotura(l, pol, AGORA) === "SEM_PROCURA",
  ).length;
  eq(antigo, 5, "a regra antiga conta 5 destas 7 linhas");
  eq([c, o, sp], [2, 2, 1], "duas críticas, duas ocasionais, uma sem procura");
  eq(c + o + sp, antigo, "os três somam EXACTAMENTE o total antigo — é uma partição");
}

// ══════════════════════════════════════════════════════════════════════
console.log("\nG · os filtros de /stock e a policy única");
{
  const AGORA = new Date("2026-09-04T12:00:00Z").getTime();
  const haDias = (n: number) => new Date(AGORA - n * 86_400_000);
  const row = (over: Partial<StockRowEnriched>): StockRowEnriched =>
    ({
      produtoId: "p", farmaciaId: "f", farmaciaNome: "F", cnp: "1", designacao: "X",
      stockAtual: 0, stockMinimo: null, pvp: 10, puc: 5, pmc: 5,
      dataUltimaVenda: haDias(5), salesQty90d: 1, mesesComVenda12M: 1,
      avgDaily90d: 0.01, coverage: 0, dci: null, codigoATC: null,
      categoria: "", subcategoria: "", productType: null, utilizacoes: [],
      ...over,
    }) as StockRowEnriched;

  const ctx = { agora: AGORA };
  const critica = row({ mesesComVenda12M: 4, salesQty90d: 12 });
  const ocasional = row({});
  const antiga = row({ dataUltimaVenda: haDias(150), salesQty90d: 2 });

  check(matchStockFilter(critica, "rotura-critica", ctx), "rotura-critica apanha a crítica");
  check(!matchStockFilter(ocasional, "rotura-critica", ctx), "…e não a ocasional");
  check(matchStockFilter(ocasional, "sem-stock-ocasional", ctx), "sem-stock-ocasional");
  check(matchStockFilter(antiga, "sem-stock-sem-procura", ctx), "sem-stock-sem-procura");
  for (const r of [critica, ocasional, antiga]) {
    check(matchStockFilter(r, "out-of-stock", ctx), "out-of-stock continua a apanhar as três");
    const n = (["rotura-critica", "sem-stock-ocasional", "sem-stock-sem-procura"] as const).filter(
      (f) => matchStockFilter(r, f, ctx),
    ).length;
    eq(n, 1, "cada linha cai em exactamente um nível");
  }
  // O filtro respeita a policy que lhe passam.
  check(
    !matchStockFilter(critica, "rotura-critica", {
      agora: AGORA,
      rotura: { ...POLICY_DEFAULT.rotura, unidadesMinimas: 99, mesesMinimos: 99 },
    }),
    "com uma policy mais apertada, a mesma linha deixa de ser crítica",
  );

  // ── A policy é resolvida no MESMO sítio pelos três consumidores ────
  const dados = readFileSync("lib/transferencias-data.ts", "utf8");
  const dash = readFileSync("lib/dashboard.ts", "utf8");
  for (const [nome, fonte] of [
    ["transferencias-data", dados],
    ["dashboard", dash],
  ] as const) {
    check(
      fonte.includes("getOperationalPolicy(await resolveCurrentTenantSlug())"),
      `${nome} resolve a policy pelo tenant do pedido`,
    );
  }
  check(
    dash.includes("thresholdDays: policy.excesso.thresholdDias") &&
      dash.includes("excessoMinimo: policy.excesso.minimoUnidades") &&
      dash.includes("reservaDias: reservaOrigemDias(policy)"),
    "o Dashboard usa a policy inteira, e não parte dela",
  );
  check(
    dash.includes("sum + x.estado.excesso * unitCost(x.row)"),
    "o Dashboard valoriza o EXCEDENTE, como /excessos",
  );
  check(
    !dash.includes("sum + r.stockAtual * unitCost(r)"),
    "…e já não o stock inteiro",
  );

  // Nada de `if (tenant === "silveira")` espalhado pelo código.
  for (const f of [
    "lib/dashboard.ts",
    "lib/transferencias-data.ts",
    "lib/stock-shared.ts",
    "lib/stock-data.ts",
    "lib/operational/motor-stock.ts",
    "lib/operational/rotura.ts",
  ]) {
    const fonte = readFileSync(f, "utf8").replace(/\/\/.*|\/\*[\s\S]*?\*\//g, "");
    check(
      !/silveira|garantia/i.test(fonte),
      `${f} não conhece nenhum tenant pelo nome`,
    );
  }

  // O cabeçalho dos diagnósticos diz o que está a ser medido.
  const desc = descreverPolicy(SILVEIRA).join("\n");
  check(desc.includes("tenant: silveira"), "descreverPolicy nomeia o tenant");
  check(desc.includes("excessoDias    = 120"), "…e imprime os parâmetros");
  check(desc.includes("reservaOrigem  = 45"), "…incluindo a reserva derivada");
  check(
    descreverPolicy(GARANTIA).join("\n").includes("sem calibração própria"),
    "e diz quando NÃO há calibração própria",
  );
}

// ══════════════════════════════════════════════════════════════════════
console.log(`\n${ok} ok, ${ko} falhas`);
process.exit(ko === 0 ? 0 : 1);
