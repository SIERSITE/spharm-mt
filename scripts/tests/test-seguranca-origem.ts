/**
 * scripts/tests/test-seguranca-origem.ts
 *
 * A pergunta era: "devemos garantir uma reserva mínima na origem depois
 * da transferência — 30 dias? 45?"
 *
 * A resposta não precisa de dados: sai da própria fórmula do excesso.
 *
 *     excesso   = (cobertura − alvo) × médiaDiária
 *     sugestão ≤ excesso
 *
 *     stock − excesso = cobertura×média − (cobertura−alvo)×média
 *                     = alvo × média
 *
 * ou seja, na aritmética exacta **a origem fica sempre com `alvo` dias
 * de cobertura**, e isso já é hoje 30 dias.
 *
 * NA IMPLEMENTAÇÃO, NÃO. O `Math.round` do excesso quebra-o: quando
 * `alvo × médiaDiária <= 0,5`, o arredondamento engole a reserva inteira
 * e a origem fica a ZERO. Acontece com artigos que vendem menos de ~6
 * unidades por ano, e o corte de 5 unidades NÃO o impede — está medido
 * em C, com um caso concreto: stock 5, 6 unidades/ano, cede as 5.
 *
 * É esta a resposta à pergunta da reserva mínima: ela não é precisa
 * contra thresholds generosos — é precisa contra o arredondamento nos
 * artigos de baixa rotação.
 *
 * Corre com:  npm run test:seguranca-origem
 */
import {
  avaliarLinha,
  ehAccionavel,
  emparelhar,
  type EstadoStock,
  type LinhaStock,
  type ParametrosMotor,
} from "../../lib/operational/motor-stock";

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

const JANELA = 365;

function linha(
  farmaciaId: string,
  farmaciaNome: string,
  stockAtual: number,
  vendasJanela: number,
): LinhaStock {
  return { farmaciaId, farmaciaNome, stockAtual, vendasJanela };
}

function avaliar(grupo: LinhaStock[], params: ParametrosMotor): EstadoStock[] {
  return grupo.map((l) => avaliarLinha(l, params));
}

// ══════════════════════════════════════════════════════════════════════
// A · O invariante, em casos construídos à mão
// ══════════════════════════════════════════════════════════════════════
console.log("\nA · a origem nunca desce abaixo da cobertura-alvo");
{
  const params: ParametrosMotor = {
    diasJanela: JANELA,
    thresholdDays: 180,
    targetDays: 30,
    excessoMinimo: 5,
  };

  // Origem com 2 anos de cobertura; destino esfomeado.
  //   origem: 730 un, 365 vendidas/ano ⇒ 1 un/dia ⇒ cobertura 730 d
  //   excesso = (730 − 30) × 1 = 700
  const grupo = avaliar(
    [linha("A", "Alfa", 730, 365), linha("B", "Beta", 1, 365)],
    params,
  );
  const par = emparelhar(grupo[0], grupo);

  check(par.destino?.farmaciaId === "B", "há transferência de Alfa para Beta");
  check(ehAccionavel(par), "…e é accionável");

  const restante = (grupo[0].stockAtual - par.quantidadeSugerida) / grupo[0].avgDaily;
  check(
    restante >= params.targetDays,
    `a origem fica com ${restante.toFixed(1)} dias — não menos do que os ${params.targetDays} do alvo`,
  );

  // O destino esfomeado precisa de 29 unidades (30 − 1 dia de cobertura),
  // muito menos do que o excesso: é a necessidade que limita, não o stock.
  check(
    par.quantidadeSugerida < grupo[0].excesso,
    "aqui é a necessidade do destino que limita, não o excesso da origem",
  );
}

// ══════════════════════════════════════════════════════════════════════
// B · O caso que realmente testa o limite: destino insaciável
//
// Se o destino precisar de MAIS do que o excesso todo, a sugestão passa
// a ser o excesso inteiro — e é aí que o invariante fica apertado.
// ══════════════════════════════════════════════════════════════════════
console.log("\nB · com o destino a absorver o excesso inteiro");
{
  const params: ParametrosMotor = {
    diasJanela: JANELA,
    thresholdDays: 180,
    targetDays: 30,
    excessoMinimo: 5,
  };

  // Destino consome 100× mais do que a origem: a sua necessidade é
  // enorme e a origem cede tudo o que pode.
  const grupo = avaliar(
    [linha("A", "Alfa", 730, 365), linha("B", "Beta", 0 + 1, 36500)],
    params,
  );
  const par = emparelhar(grupo[0], grupo);

  check(ehAccionavel(par), "há transferência");
  check(
    par.quantidadeSugerida === grupo[0].excesso,
    `a sugestão é o excesso inteiro (${par.quantidadeSugerida} = ${grupo[0].excesso})`,
  );

  const restante = (grupo[0].stockAtual - par.quantidadeSugerida) / grupo[0].avgDaily;
  check(
    restante >= params.targetDays,
    `mesmo assim a origem fica com ${restante.toFixed(1)} dias`,
  );
}

// ══════════════════════════════════════════════════════════════════════
// C · A fuga: o arredondamento pode entregar o STOCK INTEIRO
//
// `excesso = Math.round((cobertura − alvo) × média)`. Quando a média
// diária é muito pequena, `alvo × média` é inferior a meia unidade e o
// arredondamento engole-a: o excesso passa a ser o stock todo e a origem
// fica a ZERO.
//
// Descoberto a varrer, não a raciocinar — o raciocínio anterior
// ("stock − excesso = alvo × média, logo a origem fica sempre com o
// alvo") é verdadeiro na aritmética exacta e falso na implementação.
//
// Condição: alvo × média <= 0,5  ⇒  média <= 1/60 un/dia com alvo 30,
// ou seja, artigos que vendem menos de ~6 unidades por ano.
// ══════════════════════════════════════════════════════════════════════
console.log("\nC · o arredondamento pode esvaziar a origem");
{
  // Com o corte REAL de produção (5 unidades), não com 1.
  const params: ParametrosMotor = {
    diasJanela: JANELA,
    thresholdDays: 180,
    targetDays: 30,
    excessoMinimo: 5,
  };

  let esvaziadas = 0;
  let pior = 0;
  let piorCaso = "";
  for (let vendas = 1; vendas <= 60; vendas++) {
    for (let stock = 1; stock <= 400; stock++) {
      const grupo = avaliar(
        [linha("A", "Alfa", stock, vendas), linha("B", "Beta", 1, vendas * 50)],
        params,
      );
      const par = emparelhar(grupo[0], grupo);
      if (!ehAccionavel(par)) continue;
      const restante = (stock - par.quantidadeSugerida) / grupo[0].avgDaily;
      if (restante <= 0) esvaziadas++;
      const desvio = params.targetDays - restante;
      if (desvio > pior) {
        pior = desvio;
        piorCaso = `stock=${stock}, ${vendas} un/ano ⇒ origem fica com ${restante.toFixed(1)}d`;
      }
    }
  }

  console.log(`            pior caso: ${piorCaso || "nenhum"}`);
  console.log(`            sugestões que deixam a origem a zero: ${esvaziadas}`);
  check(
    esvaziadas > 0,
    "o corte de 5 unidades NÃO fecha o buraco — há casos que esvaziam a origem",
  );
  check(
    pior >= params.targetDays,
    `o desvio chega aos ${pior.toFixed(1)} dias — não é um erro de cêntimos`,
  );

  // E confirma-se a condição teórica: só acontece com consumo baixo.
  const grupoLimite = avaliar(
    [linha("A", "Alfa", 5, 6), linha("B", "Beta", 1, 600)],
    params,
  );
  const parLimite = emparelhar(grupoLimite[0], grupoLimite);
  check(
    parLimite.quantidadeSugerida === 5,
    "stock 5 com 6 unidades/ano: cede as 5 e fica sem nenhuma",
    `sugeriu ${parLimite.quantidadeSugerida}`,
  );
}

// ══════════════════════════════════════════════════════════════════════
// D · Uma reserva igual ao alvo é quase inerte — mas fecha o buraco
//
// "Quase" tem um número: muda no máximo uma unidade por sugestão, porque
// é a diferença entre o `round` do excesso e o `floor` da reserva. O que
// ela muda de facto é o caso do C.
// ══════════════════════════════════════════════════════════════════════
console.log("\nD · o efeito de uma reserva, medido");
{
  const params: ParametrosMotor = {
    diasJanela: JANELA,
    thresholdDays: 180,
    targetDays: 30,
    excessoMinimo: 5,
  };

  const casos: Array<[number, number, number]> = [
    [730, 365, 36500],
    [400, 200, 20000],
    [1000, 100, 10000],
    [250, 50, 5000],
    [5, 6, 600],       // o caso do C
  ];

  const efeito = (reserva: number) => {
    let alteradas = 0;
    let anuladas = 0;
    let maiorCorte = 0;
    for (const [stock, vendasO, vendasD] of casos) {
      const grupo = avaliar([linha("A", "Alfa", stock, vendasO), linha("B", "Beta", 1, vendasD)], params);
      const par = emparelhar(grupo[0], grupo);
      if (!ehAccionavel(par)) continue;
      const tecto = Math.floor(Math.max(0, stock - reserva * grupo[0].avgDaily));
      const q = Math.min(par.quantidadeSugerida, tecto);
      const corte = par.quantidadeSugerida - q;
      if (corte > 0) alteradas++;
      if (q <= 0) anuladas++;
      if (corte > maiorCorte) maiorCorte = corte;
    }
    return { alteradas, anuladas, maiorCorte };
  };

  const r14 = efeito(14);
  const r30 = efeito(30);
  const r45 = efeito(45);
  console.log(`            reserva 14d: ${r14.alteradas} alteradas, ${r14.anuladas} anuladas, corte máx ${r14.maiorCorte} un`);
  console.log(`            reserva 30d: ${r30.alteradas} alteradas, ${r30.anuladas} anuladas, corte máx ${r30.maiorCorte} un`);
  console.log(`            reserva 45d: ${r45.alteradas} alteradas, ${r45.anuladas} anuladas, corte máx ${r45.maiorCorte} un`);

  check(
    r30.maiorCorte <= 1 || r30.anuladas > 0,
    "reserva = alvo: ou corta no máximo 1 unidade, ou anula o caso patológico",
  );
  // O que interessa nao e' anular a sugestao — e' a origem nao ficar a
  // zero. Com reserva, o caso [5, 6 un/ano] passa de ceder 5 (fica com 0)
  // a ceder 4 (fica com 1). A transferencia continua a acontecer.
  const semZero = (reserva: number) => {
    for (const [stock, vendasO, vendasD] of casos) {
      const grupo = avaliar([linha("A", "Alfa", stock, vendasO), linha("B", "Beta", 1, vendasD)], params);
      const par = emparelhar(grupo[0], grupo);
      if (!ehAccionavel(par)) continue;
      const tecto = Math.floor(Math.max(0, stock - reserva * grupo[0].avgDaily));
      const q = reserva > 0 ? Math.min(par.quantidadeSugerida, tecto) : par.quantidadeSugerida;
      if (stock - q <= 0) return false;
    }
    return true;
  };
  check(!semZero(0), "sem reserva, ha' pelo menos uma origem que fica a zero");
  check(semZero(30), "com reserva = alvo, nenhuma origem fica a zero — e a transferencia mantem-se");
  check(
    r45.alteradas >= r30.alteradas,
    "uma reserva maior corta mais, como tem de ser (o teste não é vácuo)",
  );
}

// ══════════════════════════════════════════════════════════════════════
// E · O outro motor usa outros números — e isso é o problema, não o teste
// ══════════════════════════════════════════════════════════════════════
console.log("\nE · os dois motores não concordam");
{
  const fonte = require("node:fs").readFileSync(
    "lib/transfers/internal-substitution.ts",
    "utf8",
  ) as string;

  check(
    fonte.includes("options.reserveDaysSource ?? 14"),
    "internal-substitution já tem reserva na origem: 14 dias",
  );
  check(
    fonte.includes("options.excessThresholdDays ?? 30"),
    "…e considera excesso a partir de 30 dias de cobertura (motor-stock: 180)",
  );
  check(
    fonte.includes("options.targetCoverageDays ?? 15"),
    "…e enche o destino até 15 dias (motor-stock: 30)",
  );
  check(
    fonte.includes("options.ruptureThresholdDays ?? 7"),
    "…e só trata como destino quem tem menos de 7 dias (motor-stock: menos de 30)",
  );
}

// ══════════════════════════════════════════════════════════════════════
console.log(`\n${ok} ok, ${ko} falhas`);
process.exit(ko === 0 ? 0 : 1);
