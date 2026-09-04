/**
 * scripts/tests/test-excessos-transferencias.ts
 *
 * A separação funcional entre EXCESSOS (diagnóstico) e TRANSFERÊNCIAS
 * (operação), e a janela partilhada pelos dois.
 *
 * Puros: sem base de dados, sem rede. Os testes F, G e H leem o código
 * dos componentes — é a única forma de provar "existe UM trigger de
 * geração" sem montar o React.
 *
 *   A  excesso sem destino continua a ser excesso
 *   B  excesso com destino: a sugestão respeita a necessidade
 *   C  necessidade sem excesso não cria origem
 *   D  datas por omissão dos Excessos
 *   E  datas por omissão das Transferências — as MESMAS
 *   F  Excessos: um único trigger de geração
 *   G  Transferências: um único trigger de geração
 *   H  as datas da UI chegam ao backend
 *   I  a linha sem destino conta para os totais
 *   J  Transferências só conta sugestões realizáveis
 *   K  elegibilidade de destino: consumo E necessidade
 *
 * Corre com:  npm run test:excessos-transferencias
 */
import { readFileSync } from "node:fs";
import {
  apenasComExcesso,
  avaliarGrupo,
  avaliarLinha,
  coberturaDe,
  ehAccionavel,
  ehDestinoElegivel,
  emparelhar,
  mediaDiaria,
  type EstadoStock,
  type LinhaStock,
  type ParametrosMotor,
} from "../../lib/operational/motor-stock";
import {
  janelaExcessosPorOmissao,
  janelaOperacionalPorOmissao,
  ultimosMesesCompletos,
} from "../../lib/operational/janela-meses";

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

/**
 * O código sem comentários.
 *
 * Os comentários CITAM o defeito que corrigem (`useState("2026-04-01")`),
 * e uma procura ingénua por literais de data encontrava a citação e
 * declarava o defeito presente. O que interessa é o código.
 */
const semComentarios = (t: string) =>
  t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const excessos = readFileSync("components/excessos/excessos-client.tsx", "utf8");
const transferencias = readFileSync(
  "components/transferencias/transferencias-client.tsx",
  "utf8",
);

/**
 * Parâmetros dos testes: janela de 365 dias, threshold 180, alvo 30.
 *
 * `excessoMinimo: 0` para a matemática ser mensurável sem o corte
 * comercial de 5 unidades pelo meio. Em produção é 5.
 */
const P: ParametrosMotor = {
  diasJanela: 365,
  thresholdDays: 180,
  targetDays: 30,
  excessoMinimo: 0,
};

/** Uma linha com o consumo escolhido a partir da cobertura pretendida. */
function linha(
  farmaciaId: string,
  farmaciaNome: string,
  stockAtual: number,
  coberturaPretendida: number | null,
): LinhaStock {
  // vendasJanela tal que stock / (vendas/365) = cobertura
  const vendasJanela =
    coberturaPretendida === null ? 0 : (stockAtual * P.diasJanela) / coberturaPretendida;
  return { farmaciaId, farmaciaNome, stockAtual, vendasJanela };
}

// ══════════════════════════════════════════════════════════════════════
// A · EXCESSO SEM DESTINO CONTINUA A SER EXCESSO
//
// O caso que estava partido em produção. Origem com stock muito acima do
// objectivo; nenhuma outra farmácia precisa. O relatório de Excessos TEM
// de mostrar a linha; o de Transferências NÃO.
// ══════════════════════════════════════════════════════════════════════
console.log("\nA · excesso sem destino");
{
  // Origem: 25 unidades, cobertura 1000 dias.
  // Objectivo 30 dias ⇒ excesso = (1000−30) × (25/1000) = 24,25 → 24.
  const origem = linha("f1", "Silveirense", 25, 1000);
  // Destino: cobertura 270 dias — muito acima do alvo, logo necessidade 0.
  const destino = linha("f2", "Segurado", 6, 270);

  const grupo = avaliarGrupo([origem, destino], P);
  const [o, d] = grupo;

  check(o.excesso > 0, "origem tem excesso", `excesso=${o.excesso}`);
  eq(o.excesso, 24, "excesso = 24 unidades");
  eq(d.necessidade, 0, "destino não precisa (cobertura 270 > alvo 30)");

  const par = emparelhar(o, grupo);
  eq(par.destino, null, "destino escolhido = null");
  eq(par.necessidadeDestino, 0, "necessidade do destino = 0");
  eq(par.quantidadeSugerida, 0, "sugestão = 0");

  // EXCESSOS: a linha fica.
  //
  // E ficam DUAS: com 270 dias de cobertura, o "destino" está ele
  // próprio acima do threshold de 180 e é também um excesso. É o caso
  // real do Nasalmer — origem com 2250 dias, destino com 270 — e é a
  // resposta certa: nenhuma das duas precisa do artigo, as duas têm-no
  // a mais. O que NÃO pode acontecer é a linha da origem desaparecer.
  const linhasExcesso = apenasComExcesso(grupo);
  eq(linhasExcesso.length, 2, "EXCESSOS: 2 linhas (as duas estão em excesso)");
  check(
    linhasExcesso.some((l) => l.farmaciaNome === "Silveirense"),
    "EXCESSOS: a linha da origem está presente",
  );
  check(
    linhasExcesso.every((l) => emparelhar(l, grupo).quantidadeSugerida === 0),
    "EXCESSOS: nenhuma das linhas gera sugestão",
  );

  // TRANSFERÊNCIAS: a linha sai.
  eq(ehAccionavel(par), false, "TRANSFERÊNCIAS: linha AUSENTE");
}

// O caso exacto do enunciado: stock 25, objectivo 8 ⇒ excesso 17.
{
  // Cobertura tal que (cob − 30) × (25/cob) = 17 com alvo 30 não dá 17
  // directamente; o enunciado fala em "stock objectivo" em UNIDADES.
  // Provamos a identidade na forma em que o motor a calcula: com alvo
  // 8 dias e consumo de 1 unidade/dia, 25 de stock ⇒ excesso 17.
  const p8: ParametrosMotor = { diasJanela: 365, thresholdDays: 10, targetDays: 8, excessoMinimo: 0 };
  const so = avaliarLinha(
    { farmaciaId: "f1", farmaciaNome: "A", stockAtual: 25, vendasJanela: 365 },
    p8,
  );
  eq(so.coberturaDias, 25, "cobertura = 25 dias (1 un/dia)");
  eq(so.excesso, 17, "stock 25, objectivo 8 ⇒ excesso 17");
}

// ══════════════════════════════════════════════════════════════════════
// B · EXCESSO COM DESTINO: a sugestão respeita a necessidade
// ══════════════════════════════════════════════════════════════════════
console.log("\nB · excesso com destino que precisa");
{
  // Origem: 1 un/dia, 400 de stock ⇒ cobertura 400, excesso (400−30)×1 = 370.
  const origem: LinhaStock = {
    farmaciaId: "f1",
    farmaciaNome: "Silveirense",
    stockAtual: 400,
    vendasJanela: 365,
  };
  // Destino: 1 un/dia, 26 de stock ⇒ cobertura 26, necessidade (30−26)×1 = 4.
  const destino: LinhaStock = {
    farmaciaId: "f2",
    farmaciaNome: "Segurado",
    stockAtual: 26,
    vendasJanela: 365,
  };
  const grupo = avaliarGrupo([origem, destino], P);
  const [o, d] = grupo;

  eq(o.excesso, 370, "excesso da origem = 370");
  eq(d.necessidade, 4, "necessidade do destino = 4");

  const par = emparelhar(o, grupo);
  check(par.destino?.farmaciaNome === "Segurado", "destino = Segurado");
  eq(par.quantidadeSugerida, 4, "sugestão = 4 (limitada pela necessidade)");
  check(par.quantidadeSugerida <= o.excesso, "sugestão ≤ excesso");
  check(par.quantidadeSugerida <= par.necessidadeDestino, "sugestão ≤ necessidade");
  check(par.quantidadeSugerida <= o.stockAtual, "sugestão ≤ stock da origem");

  eq(apenasComExcesso(grupo).length, 1, "EXCESSOS: linha presente");
  eq(ehAccionavel(par), true, "TRANSFERÊNCIAS: linha presente");
}

// A regra de segurança corta pelo stock quando é ele o menor dos três.
{
  const origem: LinhaStock = { farmaciaId: "f1", farmaciaNome: "A", stockAtual: 3, vendasJanela: 3 };
  const destino: LinhaStock = { farmaciaId: "f2", farmaciaNome: "B", stockAtual: 1, vendasJanela: 365 };
  const grupo = avaliarGrupo([origem, destino], P);
  const par = emparelhar(grupo[0], grupo);
  check(
    par.quantidadeSugerida <= 3,
    "sugestão nunca passa o stock da origem",
    `veio ${par.quantidadeSugerida}`,
  );
}

// ══════════════════════════════════════════════════════════════════════
// C · NECESSIDADE SEM EXCESSO NÃO CRIA ORIGEM
// ══════════════════════════════════════════════════════════════════════
console.log("\nC · destino precisa, mas ninguém tem excesso");
{
  // Ambas com cobertura abaixo do threshold: nenhuma é origem.
  const a: LinhaStock = { farmaciaId: "f1", farmaciaNome: "A", stockAtual: 40, vendasJanela: 365 };
  const b: LinhaStock = { farmaciaId: "f2", farmaciaNome: "B", stockAtual: 5, vendasJanela: 365 };
  const grupo = avaliarGrupo([a, b], P);

  eq(grupo[0].excesso, 0, "A não tem excesso (cobertura 40 < 180)");
  eq(grupo[1].excesso, 0, "B não tem excesso");
  check(grupo[1].necessidade > 0, "B tem necessidade", `necessidade=${grupo[1].necessidade}`);

  eq(apenasComExcesso(grupo).length, 0, "EXCESSOS: nenhuma linha");
  const pares = grupo.map((o) => emparelhar(o, grupo));
  eq(pares.filter(ehAccionavel).length, 0, "TRANSFERÊNCIAS: nenhuma linha");
}

// Sem consumo mensurável não há cobertura, e sem cobertura não há
// necessidade inventada.
{
  eq(coberturaDe(50, 0), null, "cobertura indefinida sem consumo (não Infinity)");
  eq(mediaDiaria(0, 365), 0, "média diária 0 sem vendas");
  const parado = avaliarLinha(
    { farmaciaId: "f1", farmaciaNome: "A", stockAtual: 50, vendasJanela: 0 },
    P,
  );
  eq(parado.coberturaDias, null, "artigo parado: cobertura null");
  eq(parado.excesso, 0, "artigo parado: excesso 0");
  eq(parado.necessidade, 0, "artigo parado: necessidade 0");
}

// ══════════════════════════════════════════════════════════════════════
// D · DATAS POR OMISSÃO DOS EXCESSOS — 12 meses civis completos
// ══════════════════════════════════════════════════════════════════════
console.log("\nD · janela por omissão dos Excessos");
{
  const set2026 = new Date("2026-09-04T10:00:00Z");
  eq(
    janelaExcessosPorOmissao(set2026),
    { inicio: "2025-09-01", fim: "2026-08-31" },
    "hoje 04/09/2026 ⇒ 01/09/2025 … 31/08/2026",
  );
  eq(
    ultimosMesesCompletos(12, new Date("2027-01-15T10:00:00Z")),
    { inicio: "2026-01-01", fim: "2026-12-31" },
    "Janeiro atravessa o ano correctamente",
  );
  check(
    excessos.includes("janelaExcessosPorOmissao()") ||
      excessos.includes("janelaOperacionalPorOmissao()"),
    "Excessos usa a função central para as datas iniciais",
  );
  check(
    !/useState\("20\d\d-\d\d-\d\d"\)/.test(semComentarios(excessos)),
    "Excessos não tem datas escritas à mão",
  );
}

// ══════════════════════════════════════════════════════════════════════
// E · DATAS POR OMISSÃO DAS TRANSFERÊNCIAS — exactamente as mesmas
// ══════════════════════════════════════════════════════════════════════
console.log("\nE · janela por omissão das Transferências");
{
  const agora = new Date("2026-09-04T10:00:00Z");
  eq(
    janelaOperacionalPorOmissao(agora),
    janelaExcessosPorOmissao(agora),
    "a mesma função devolve a mesma janela aos dois relatórios",
  );
  check(
    transferencias.includes("janelaOperacionalPorOmissao()"),
    "Transferências usa a função central",
  );
  const codigoT = semComentarios(transferencias);
  check(
    !codigoT.includes('useState("2026-04-01")') && !codigoT.includes('useState("2026-04-10")'),
    "Transferências já não tem 01/04/2026 → 10/04/2026",
  );
  check(
    !/useState\("20\d\d-\d\d-\d\d"\)/.test(codigoT),
    "Transferências não tem nenhuma data escrita à mão",
  );
  check(
    !/function\s+\w*[Jj]anela|const\s+\w*[Jj]anela\s*=\s*\(/.test(
      transferencias.replace(/janelaOperacionalPorOmissao/g, ""),
    ),
    "Transferências não reimplementa cálculo de datas",
  );
}

// ══════════════════════════════════════════════════════════════════════
// F · EXCESSOS — um único trigger de geração
// ══════════════════════════════════════════════════════════════════════
console.log("\nF · Excessos: uma acção de geração");
{
  const chamadasHandleGerar = (excessos.match(/onClick=\{handleGerar\}/g) ?? []).length;
  eq(chamadasHandleGerar, 1, "handleGerar ligado a exactamente 1 botão");
  check(
    !excessos.includes("onClick={handleGerarRelatorio}"),
    "o segundo botão de geração desapareceu",
  );
  check(
    !excessos.includes("Nenhum relatório gerado ainda"),
    "o estado intermédio vazio desapareceu",
  );
  check(
    !excessos.includes("{hasGenerated && (<>"),
    "os filtros já não estão escondidos atrás de hasGenerated",
  );
  check(
    excessos.includes('label={isPending ? "A gerar…" : relatorioGerado ? "Atualizar" : "Gerar relatório"}'),
    "o botão único passa a Atualizar depois de haver resultado",
  );
  check(excessos.includes("fixarSnapshot()"), "a geração fixa o snapshot no fim");
}

// ══════════════════════════════════════════════════════════════════════
// G · TRANSFERÊNCIAS — um único trigger de geração
// ══════════════════════════════════════════════════════════════════════
console.log("\nG · Transferências: uma acção de geração");
{
  const chamadas = (transferencias.match(/onClick=\{handleGerar\}/g) ?? []).length;
  eq(chamadas, 1, "handleGerar ligado a exactamente 1 botão");
  check(
    !transferencias.includes("onClick={handleGerarRelatorio}"),
    "o segundo botão de geração desapareceu",
  );
  check(
    !transferencias.includes("Nenhum relatório gerado ainda"),
    "o estado intermédio vazio desapareceu",
  );
  check(
    transferencias.includes('label={isPending ? "A gerar…" : relatorioGerado ? "Atualizar" : "Gerar relatório"}'),
    "o botão único passa a Atualizar depois de haver resultado",
  );
}

// ══════════════════════════════════════════════════════════════════════
// H · AS DATAS DA UI CHEGAM AO BACKEND
// ══════════════════════════════════════════════════════════════════════
console.log("\nH · as datas viajam até ao cálculo");
{
  check(
    /runExcessosReport\(\{[\s\S]{0,400}dataInicio,[\s\S]{0,80}dataFim,/.test(excessos),
    "Excessos envia dataInicio/dataFim na server action",
  );
  check(
    transferencias.includes("runTransferenciasReport({ dataInicio, dataFim })"),
    "Transferências envia dataInicio/dataFim na server action",
  );

  const actionT = readFileSync("app/transferencias/actions.ts", "utf8");
  check(
    actionT.includes("options?: OpcoesOperacionais") &&
      actionT.includes("getTransferenciasData(options)"),
    "a server action das Transferências repassa as opções",
  );

  const dados = readFileSync("lib/transferencias-data.ts", "utf8");
  check(
    dados.includes("normalizarJanela(options?.dataInicio, options?.dataFim)"),
    "o loader constrói a janela a partir das datas recebidas",
  );
  check(
    dados.includes("loadPfAndSales(farmaciaIds, { janela })"),
    "a janela é usada na query de vendas",
  );
  check(
    (dados.match(/carregarEstadosOperacionais\(options\)/g) ?? []).length === 2,
    "os DOIS relatórios passam pelo mesmo carregamento",
  );
}

// ══════════════════════════════════════════════════════════════════════
// I · A LINHA SEM DESTINO CONTA PARA OS TOTAIS
// ══════════════════════════════════════════════════════════════════════
console.log("\nI · totais dos Excessos incluem linhas sem destino");
{
  // Três artigos: dois com excesso e sem destino, um com excesso e destino.
  const semDestino1 = avaliarGrupo([linha("f1", "A", 25, 1000)], P);
  const semDestino2 = avaliarGrupo([linha("f1", "A", 60, 900)], P);
  const comDestino = avaliarGrupo(
    [
      { farmaciaId: "f1", farmaciaNome: "A", stockAtual: 400, vendasJanela: 365 },
      { farmaciaId: "f2", farmaciaNome: "B", stockAtual: 26, vendasJanela: 365 },
    ],
    P,
  );

  const linhasExcessos = [
    ...apenasComExcesso(semDestino1),
    ...apenasComExcesso(semDestino2),
    ...apenasComExcesso(comDestino),
  ];
  eq(linhasExcessos.length, 3, "3 linhas nos Excessos");

  const unidades = linhasExcessos.reduce((s, l) => s + l.excesso, 0);
  check(unidades > 0, "unidades em excesso > 0", `veio ${unidades}`);
  eq(
    unidades,
    semDestino1[0].excesso + semDestino2[0].excesso + comDestino[0].excesso,
    "as unidades somam o excesso de TODAS as linhas",
  );

  // O totalizador do ecrã soma `excessoOrigem`, e não `quantidadeSugerida`.
  check(
    excessos.includes("totalUnidades: sum(orderedRows.map((row) => row.excessoOrigem))"),
    "o cartão de unidades soma excesso, não sugestão",
  );

  // E o filtro de destino não pode apagar uma linha sem destino.
  check(
    excessos.includes('row.farmaciaDestino !== "" &&'),
    "o filtro de farmácia destino ignora as linhas sem destino",
  );
  check(
    excessos.includes("row.quantidadeSugerida > 0 && row.quantidadeSugerida < quantidadeMin"),
    "a quantidade mínima só se aplica a linhas com sugestão",
  );
}

// ══════════════════════════════════════════════════════════════════════
// J · TRANSFERÊNCIAS CONTA APENAS SUGESTÕES REALIZÁVEIS
// ══════════════════════════════════════════════════════════════════════
console.log("\nJ · Transferências é um subconjunto dos Excessos");
{
  const grupos = [
    // excesso sem destino
    avaliarGrupo([linha("f1", "A", 25, 1000), linha("f2", "B", 6, 270)], P),
    // excesso com destino
    avaliarGrupo(
      [
        { farmaciaId: "f1", farmaciaNome: "A", stockAtual: 400, vendasJanela: 365 },
        { farmaciaId: "f2", farmaciaNome: "B", stockAtual: 26, vendasJanela: 365 },
      ],
      P,
    ),
    // sem excesso nenhum
    avaliarGrupo(
      [
        { farmaciaId: "f1", farmaciaNome: "A", stockAtual: 40, vendasJanela: 365 },
        { farmaciaId: "f2", farmaciaNome: "B", stockAtual: 5, vendasJanela: 365 },
      ],
      P,
    ),
  ];

  const linhasExcessos = grupos.flatMap((g) => apenasComExcesso(g));
  const linhasTransf = grupos.flatMap((g) =>
    apenasComExcesso(g)
      .map((o) => emparelhar(o, g))
      .filter(ehAccionavel),
  );

  // 3 = origem sem escoamento + o seu "destino" (270 dias, também em
  // excesso) + a origem do grupo com destino real.
  eq(linhasExcessos.length, 3, "EXCESSOS: 3 linhas");
  eq(linhasTransf.length, 1, "TRANSFERÊNCIAS: 1 linha");
  check(
    linhasTransf.length <= linhasExcessos.length,
    "Transferências é sempre um subconjunto de Excessos",
  );
  check(
    linhasTransf.every((p) => p.quantidadeSugerida > 0),
    "todas as sugestões são realizáveis",
  );
  check(
    linhasTransf.every((p) => p.necessidadeDestino > 0 && p.origem.excesso > 0),
    "todas têm excesso na origem E necessidade no destino",
  );

  const dados = readFileSync("lib/transferencias-data.ts", "utf8");
  check(
    dados.includes("if (!ehAccionavel(par)) continue;"),
    "getTransferenciasData filtra pelas três condições",
  );
  check(
    !/getExcessosData[\s\S]{0,3000}ehAccionavel/.test(dados),
    "getExcessosData NÃO filtra por accionabilidade",
  );
}

// ══════════════════════════════════════════════════════════════════════
// K · ELEGIBILIDADE DE DESTINO
//
// Uma farmácia só é destino possível se CONSOME o artigo e precisa de
// mais do que tem. Stock 0 não é necessidade: uma prateleira vazia de um
// artigo que nunca vendeu continua a não precisar dele.
// ══════════════════════════════════════════════════════════════════════
console.log("\nK · elegibilidade de destino");

// ── A · stock 0, consumo 0 ⇒ NÃO é destino ────────────────────────────
{
  const origem: LinhaStock = {
    farmaciaId: "f1",
    farmaciaNome: "Silveirense",
    stockAtual: 400,
    vendasJanela: 365,
  };
  // Nunca vendeu, e tem a prateleira vazia. As duas coisas ao mesmo
  // tempo — que é precisamente o caso que aparecia como destino.
  const vazia: LinhaStock = {
    farmaciaId: "f2",
    farmaciaNome: "Segurado",
    stockAtual: 0,
    vendasJanela: 0,
  };
  const grupo = avaliarGrupo([origem, vazia], P);
  const [o, d] = grupo;

  eq(d.avgDaily, 0, "A: destino sem consumo ⇒ avgDaily 0");
  eq(d.coberturaDias, null, "A: cobertura indefinida, não 0");
  eq(d.necessidade, 0, "A: necessidade 0");
  eq(ehDestinoElegivel(d), false, "A: NÃO é destino elegível");

  const par = emparelhar(o, grupo);
  eq(par.destino, null, "A: destino null");
  eq(par.necessidadeDestino, 0, "A: necessidade do destino 0");
  eq(par.quantidadeSugerida, 0, "A: sugestão 0");
  eq(ehAccionavel(par), false, "A: TRANSFERÊNCIAS não mostra a linha");
  eq(apenasComExcesso(grupo).length, 1, "A: EXCESSOS mantém a linha da origem");
}

// ── B · stock 0 MAS com consumo ⇒ é destino ──────────────────────────
{
  const origem: LinhaStock = {
    farmaciaId: "f1",
    farmaciaNome: "Silveirense",
    stockAtual: 400,
    vendasJanela: 365,
  };
  // Vende 1/dia e está a zero: é exactamente quem precisa.
  const rutura: LinhaStock = {
    farmaciaId: "f2",
    farmaciaNome: "Segurado",
    stockAtual: 0,
    vendasJanela: 365,
  };
  const grupo = avaliarGrupo([origem, rutura], P);
  const [o, d] = grupo;

  check(d.avgDaily > 0, "B: destino consome o artigo", `avgDaily=${d.avgDaily}`);
  eq(d.coberturaDias, 0, "B: cobertura 0 (stock 0 com consumo)");
  eq(d.necessidade, 30, "B: necessidade = 30 dias × 1/dia");
  eq(ehDestinoElegivel(d), true, "B: É destino elegível");

  const par = emparelhar(o, grupo);
  check(par.destino?.farmaciaNome === "Segurado", "B: destino = Segurado");
  eq(par.quantidadeSugerida, 30, "B: sugestão = 30");
  eq(ehAccionavel(par), true, "B: TRANSFERÊNCIAS mostra a linha");
}

// ── C · vários candidatos: só entram os que precisam ─────────────────
{
  const origem: LinhaStock = { farmaciaId: "f1", farmaciaNome: "Origem", stockAtual: 400, vendasJanela: 365 };
  const semConsumo: LinhaStock = { farmaciaId: "f2", farmaciaNome: "A-SemConsumo", stockAtual: 0, vendasJanela: 0 };
  const servida: LinhaStock = { farmaciaId: "f3", farmaciaNome: "B-Servida", stockAtual: 100, vendasJanela: 365 };
  const precisaPouco: LinhaStock = { farmaciaId: "f4", farmaciaNome: "C-PrecisaPouco", stockAtual: 20, vendasJanela: 365 };
  const precisaMuito: LinhaStock = { farmaciaId: "f5", farmaciaNome: "D-PrecisaMuito", stockAtual: 5, vendasJanela: 365 };

  const grupo = avaliarGrupo([origem, semConsumo, servida, precisaPouco, precisaMuito], P);
  const elegiveis = grupo.filter((c) => c.farmaciaId !== "f1").filter(ehDestinoElegivel);

  eq(
    elegiveis.map((e) => e.farmaciaNome),
    ["C-PrecisaPouco", "D-PrecisaMuito"],
    "C: só os dois que consomem E precisam",
  );
  check(
    !elegiveis.some((e) => e.farmaciaNome === "A-SemConsumo"),
    "C: a farmácia sem consumo fica de fora, apesar do stock 0",
  );
  check(
    !elegiveis.some((e) => e.farmaciaNome === "B-Servida"),
    "C: a farmácia já servida (cobertura 100 > alvo 30) fica de fora",
  );

  const par = emparelhar(grupo[0], grupo);
  check(par.destino?.farmaciaNome === "D-PrecisaMuito", "C: ganha a MAIOR necessidade");
  eq(par.necessidadeDestino, 25, "C: necessidade = (30 − 5) × 1/dia");
}

// ── D · ninguém precisa ⇒ Excessos mantém, Transferências não ────────
{
  const origem: LinhaStock = { farmaciaId: "f1", farmaciaNome: "Origem", stockAtual: 400, vendasJanela: 365 };
  const vazia: LinhaStock = { farmaciaId: "f2", farmaciaNome: "Vazia", stockAtual: 0, vendasJanela: 0 };
  const servida: LinhaStock = { farmaciaId: "f3", farmaciaNome: "Servida", stockAtual: 100, vendasJanela: 365 };

  const grupo = avaliarGrupo([origem, vazia, servida], P);
  const par = emparelhar(grupo[0], grupo);

  eq(par.destino, null, "D: destino null");
  eq(par.quantidadeSugerida, 0, "D: sugestão 0");

  // EXCESSOS: a linha da origem fica.
  const linhas = apenasComExcesso(grupo);
  check(
    linhas.some((l) => l.farmaciaNome === "Origem"),
    "D: EXCESSOS mantém a linha da origem",
  );
  // TRANSFERÊNCIAS: nenhuma linha accionável.
  const accionaveis = linhas.map((o) => emparelhar(o, grupo)).filter(ehAccionavel);
  eq(accionaveis.length, 0, "D: TRANSFERÊNCIAS não mostra nenhuma linha");
}

// ── Sugestão 0 ⇒ destino null, mesmo com necessidade real ───────────
{
  // Há necessidade a sério no destino, mas a origem não tem stock
  // inteiro para dar. Mostrar uma farmácia ao lado de "0 unidades" era
  // anunciar uma transferência que não existe.
  const origem: EstadoStock<LinhaStock> = {
    ...avaliarLinha({ farmaciaId: "f1", farmaciaNome: "Origem", stockAtual: 0, vendasJanela: 1 }, P),
    excesso: 10, // forçado: o que se está a medir é o corte pelo stock
  };
  const destino = avaliarLinha(
    { farmaciaId: "f2", farmaciaNome: "Destino", stockAtual: 0, vendasJanela: 365 },
    P,
  );
  const par = emparelhar(origem, [origem, destino]);

  check(destino.necessidade > 0, "necessidade real no destino", `${destino.necessidade}`);
  eq(par.quantidadeSugerida, 0, "sugestão 0 (a origem não tem stock)");
  eq(par.destino, null, "…e por isso o destino é null");
  eq(par.necessidadeDestino, 0, "…e a necessidade apresentada também");
}

// ── Nenhum caminho preenche o destino antes de validar ──────────────
{
  const motor = readFileSync("lib/operational/motor-stock.ts", "utf8");
  check(
    motor.includes(".filter(ehDestinoElegivel)"),
    "emparelhar filtra ANTES de escolher",
  );
  check(
    motor.includes("if (quantidadeSugerida <= 0) return semDestino;"),
    "e volta a anular o destino se a sugestão for 0",
  );
  const dadosT = readFileSync("lib/transferencias-data.ts", "utf8");
  check(
    dadosT.includes('farmaciaDestino: destino?.farmaciaNome ?? ""'),
    "a linha só recebe nome quando ha' destino",
  );
  check(
    !/others\[0\]/.test(dadosT),
    "não resta nenhum fallback others[0] no loader",
  );
}

// ══════════════════════════════════════════════════════════════════════
console.log(`\n${ok} ok, ${ko} falhas`);
process.exit(ko === 0 ? 0 : 1);
