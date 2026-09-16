/**
 * scripts/tests/test-vendas-para-encomenda.ts
 *
 * Bloco B — "Criar encomenda com estes produtos" a partir do Relatório
 * de Vendas.
 *
 * ── O que isto testa ──────────────────────────────────────────────────
 *
 * `lib/encomendas/prefill-from-vendas.ts` é o único sítio onde Vendas e
 * Encomendas se tocam neste fluxo: constrói o payload (puro, sem BD) e
 * valida-o do outro lado (`OrderCreateClient`). Nenhuma lógica de
 * CÁLCULO de proposta vive aqui — isso continua em
 * `generateOrderProposal`/`generateGroupProposal`, chamados sempre
 * através de `generateProposalAction`. Este teste corre sem BD.
 *
 * Corre com:  npm run test:vendas-para-encomenda
 */
import { readFileSync } from "node:fs";
import {
  ENCOMENDA_PREFILL_VERSION,
  buildEncomendaPrefillFromVendas,
  modoEncomendaParaVendas,
  parseEncomendaPrefillPayload,
  type FarmaciaRef,
} from "../../lib/encomendas/prefill-from-vendas";
import {
  ROTULO_TOTAL_ARTIGO,
  codigosVisiveisVendas,
  type LinhaAgrupavel,
} from "../../lib/reporting/vendas-agrupamento";

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
const eq = (a: unknown, b: unknown, label: string) =>
  check(
    JSON.stringify(a) === JSON.stringify(b),
    label,
    `esperado ${JSON.stringify(b)}, obtido ${JSON.stringify(a)}`,
  );

const src = (p: string) => readFileSync(p, "utf8");

const FARMACIAS: FarmaciaRef[] = [
  { id: "f1", nome: "Silveirense" },
  { id: "f2", nome: "Segurado" },
  { id: "f3", nome: "Castelo" },
];

// ═════════════════════════════════════════════════════════════════════
// A. modoEncomendaParaVendas — a regra de decisão farmácia vs. grupo
// ═════════════════════════════════════════════════════════════════════
console.log("\nA. farmacia vs. grupo\n");

eq(modoEncomendaParaVendas("farmacia", 1, 3), "farmacia", "1 seleccionada, ambito farmácia → farmacia");
eq(modoEncomendaParaVendas("farmacia", 2, 3), "grupo", "2 seleccionadas → grupo, mesmo com ambito farmácia");
eq(modoEncomendaParaVendas("farmacia", 0, 3), "grupo", "0 seleccionadas = todas → grupo (3 farmácias)");
eq(modoEncomendaParaVendas("farmacia", 0, 1), "farmacia", "0 seleccionadas mas só há 1 farmácia no sistema → farmacia");
eq(modoEncomendaParaVendas("grupo", 1, 3), "grupo", "ambito grupo força grupo mesmo com 1 seleccionada");
eq(modoEncomendaParaVendas("comparativo", 2, 3), "grupo", "comparativo com várias farmácias → grupo");
eq(modoEncomendaParaVendas("comparativo", 1, 3), "farmacia", "comparativo estreitado a 1 farmácia → farmacia");
eq(modoEncomendaParaVendas("farmacia", 3, 3), "grupo", "todas seleccionadas explicitamente → grupo");

// ═════════════════════════════════════════════════════════════════════
// B. buildEncomendaPrefillFromVendas — o caminho feliz
// ═════════════════════════════════════════════════════════════════════
console.log("\nB. Construção do payload — farmácia única\n");

{
  const r = buildEncomendaPrefillFromVendas({
    ambito: "farmacia",
    farmaciasSelecionadas: ["Silveirense"],
    farmaciasDisponiveis: FARMACIAS,
    codigos: ["12345", "67890", "12345"], // duplicado de propósito
    dataInicio: "2026-06-01",
    dataFim: "2026-08-31",
    targetCoverageDays: 21,
  });

  check(r.ok, "constrói com sucesso");
  if (r.ok) {
    eq(r.payload.version, ENCOMENDA_PREFILL_VERSION, "leva a versão do contrato");
    eq(r.payload.mode, "farmacia", "modo farmácia");
    eq(r.payload.farmaciaId, "f1", "resolve o id pelo nome");
    eq(r.payload.cnps, [12345, 67890], "deduplica e converte para número, preservando ordem");
    eq(r.payload.startDate, "2026-06-01", "período histórico = o do relatório");
    eq(r.payload.endDate, "2026-08-31", "…as duas pontas");
    eq(r.payload.targetCoverageDays, 21, "cobertura futura = a pedida no modal");
    eq(r.payload.baseRule, "coverage", "default: média × cobertura");
    eq(r.payload.considerStock, true, "default: considera stock");
  }
}

console.log("\nC. Construção do payload — grupo\n");

{
  const r = buildEncomendaPrefillFromVendas({
    ambito: "grupo",
    farmaciasSelecionadas: [],
    farmaciasDisponiveis: FARMACIAS,
    codigos: [111, 222],
    dataInicio: "2026-01-01",
    dataFim: "2026-01-31",
    targetCoverageDays: 10,
  });
  check(r.ok, "constrói com sucesso");
  if (r.ok) {
    eq(r.payload.mode, "grupo", "modo grupo");
    eq(r.payload.farmaciaId, undefined, "sem farmaciaId — o servidor decide as farmácias do grupo");
  }
}

{
  // Duas farmácias seleccionadas em ambito "farmacia": a UI de Vendas
  // permite multi-selecção mesmo aí, e o motor de grupo é o único que
  // sabe lidar com mais que uma farmácia.
  const r = buildEncomendaPrefillFromVendas({
    ambito: "farmacia",
    farmaciasSelecionadas: ["Silveirense", "Segurado"],
    farmaciasDisponiveis: FARMACIAS,
    codigos: [111],
    dataInicio: "2026-01-01",
    dataFim: "2026-01-31",
    targetCoverageDays: 10,
  });
  check(r.ok && r.payload.mode === "grupo", "2 farmácias seleccionadas força modo grupo mesmo com ambito 'farmacia'");
}

console.log("\nD. Erros — universo vazio, cobertura inválida, farmácia não identificada\n");

{
  const r = buildEncomendaPrefillFromVendas({
    ambito: "farmacia",
    farmaciasSelecionadas: ["Silveirense"],
    farmaciasDisponiveis: FARMACIAS,
    codigos: ["abc", "0", "-5"],
    dataInicio: "2026-01-01",
    dataFim: "2026-01-31",
    targetCoverageDays: 10,
  });
  check(!r.ok, "sem CNP válido → erro, não catálogo inteiro");
}
{
  const r = buildEncomendaPrefillFromVendas({
    ambito: "farmacia",
    farmaciasSelecionadas: ["Silveirense"],
    farmaciasDisponiveis: FARMACIAS,
    codigos: [111],
    dataInicio: "2026-01-01",
    dataFim: "2026-01-31",
    targetCoverageDays: 0,
  });
  check(!r.ok, "cobertura 0 dias é rejeitada");
}
{
  const r = buildEncomendaPrefillFromVendas({
    ambito: "farmacia",
    farmaciasSelecionadas: ["Farmácia Inexistente"],
    farmaciasDisponiveis: FARMACIAS,
    codigos: [111],
    dataInicio: "2026-01-01",
    dataFim: "2026-01-31",
    targetCoverageDays: 10,
  });
  check(!r.ok, "farmácia seleccionada que não está no universo disponível → erro, não farmácia adivinhada");
}
{
  const r = buildEncomendaPrefillFromVendas({
    ambito: "farmacia",
    farmaciasSelecionadas: ["Silveirense"],
    farmaciasDisponiveis: FARMACIAS,
    codigos: [111],
    dataInicio: "",
    dataFim: "2026-01-31",
    targetCoverageDays: 10,
  });
  check(!r.ok, "sem data de início do relatório → erro");
}

// ═════════════════════════════════════════════════════════════════════
// E. parseEncomendaPrefillPayload — o lado que lê, do OrderCreateClient
// ═════════════════════════════════════════════════════════════════════
console.log("\nE. Parsing do lado da encomenda\n");

{
  const build = buildEncomendaPrefillFromVendas({
    ambito: "farmacia",
    farmaciasSelecionadas: ["Castelo"],
    farmaciasDisponiveis: FARMACIAS,
    codigos: [555, 666],
    dataInicio: "2026-03-01",
    dataFim: "2026-05-31",
    targetCoverageDays: 30,
  });
  check(build.ok, "payload de referência construído");
  if (build.ok) {
    // Ida-e-volta por JSON — exactamente o que passa pelo sessionStorage.
    const roundTrip = JSON.parse(JSON.stringify(build.payload));
    const parsed = parseEncomendaPrefillPayload(roundTrip);
    check(parsed !== null, "sobrevive à serialização JSON");
    if (parsed) eq(parsed, build.payload, "…e volta byte a byte igual");
  }
}

check(parseEncomendaPrefillPayload(null) === null, "null não é um payload válido");
check(parseEncomendaPrefillPayload(undefined) === null, "undefined também não");
check(parseEncomendaPrefillPayload("string qualquer") === null, "uma string não é objecto");
check(parseEncomendaPrefillPayload({}) === null, "objecto vazio falha por falta de versão");
check(
  parseEncomendaPrefillPayload({ version: 1, farmaciaNome: "x", lines: [{ cnp: 1 }] }) === null,
  "o FORMATO ANTIGO (v1, lines com quantidade) é recusado, não migrado às cegas",
);
check(
  parseEncomendaPrefillPayload({
    version: ENCOMENDA_PREFILL_VERSION,
    mode: "consolidacao",
    cnps: [1],
    startDate: "2026-01-01",
    endDate: "2026-01-31",
    targetCoverageDays: 10,
    baseRule: "coverage",
    considerStock: true,
  }) === null,
  "mode 'consolidacao' não é produzido por Vendas e é recusado",
);
check(
  parseEncomendaPrefillPayload({
    version: ENCOMENDA_PREFILL_VERSION,
    mode: "farmacia",
    // sem farmaciaId
    cnps: [1],
    startDate: "2026-01-01",
    endDate: "2026-01-31",
    targetCoverageDays: 10,
    baseRule: "coverage",
    considerStock: true,
  }) === null,
  "modo 'farmacia' sem farmaciaId é recusado",
);
check(
  parseEncomendaPrefillPayload({
    version: ENCOMENDA_PREFILL_VERSION,
    mode: "grupo",
    cnps: ["1", "2"], // strings, não números
    startDate: "2026-01-01",
    endDate: "2026-01-31",
    targetCoverageDays: 10,
    baseRule: "coverage",
    considerStock: true,
  }) === null,
  "cnps como strings são recusados — o contrato é number[]",
);
check(
  parseEncomendaPrefillPayload({
    version: ENCOMENDA_PREFILL_VERSION,
    mode: "grupo",
    cnps: [],
    startDate: "2026-01-01",
    endDate: "2026-01-31",
    targetCoverageDays: 10,
    baseRule: "coverage",
    considerStock: true,
  }) === null,
  "lista de CNP vazia é recusada — não vira 'sem filtro'",
);
check(
  parseEncomendaPrefillPayload({
    version: ENCOMENDA_PREFILL_VERSION,
    mode: "grupo",
    cnps: [1],
    startDate: "2026-01-01",
    endDate: "2026-01-31",
    targetCoverageDays: 0,
    baseRule: "coverage",
    considerStock: true,
  }) === null,
  "cobertura < 1 dia é recusada também deste lado",
);

// ═════════════════════════════════════════════════════════════════════
// F. Onde isto está ligado
// ═════════════════════════════════════════════════════════════════════
console.log("\nF. As pontas estão ligadas\n");

{
  const oc = src("components/encomendas/order-create-client.tsx");
  check(
    oc.includes("parseEncomendaPrefillPayload"),
    "OrderCreateClient valida o payload com a função partilhada",
  );
  check(
    !oc.includes("resolveProductsByCnpAction"),
    "…e já não resolve produtos um a um com quantidades pré-calculadas",
  );
  check(
    !oc.includes("PrefillStash"),
    "…o tipo antigo do prefill (com 'lines'/'quantidade') desapareceu",
  );
  check(
    /generateProposalAction\(\{/.test(oc) && oc.includes("filters: { cnps: payload.cnps }"),
    "o prefill chama generateProposalAction com o universo fechado — o cálculo continua no motor de Encomendas",
  );
  check(
    oc.includes(`ENCOMENDA_PREFILL_STORAGE_KEY`),
    "…e usa a MESMA chave de sessionStorage que Vendas escreve",
  );
}
{
  const vc = src("components/vendas/vendas-client.tsx");
  check(vc.includes("Criar encomenda com estes produtos"), "Vendas tem o botão");
  check(vc.includes("buildEncomendaPrefillFromVendas"), "…e usa o construtor partilhado, não lógica própria");
  check(
    !/generate(Order|Group)Proposal\(/.test(vc),
    "Vendas NUNCA CHAMA o motor de cálculo directamente (podem mencionar o nome em comentários)",
  );
  check(
    vc.includes("encomendaBloqueadaPorPerfil"),
    "…desactiva o botão para quem não tem perfil de grupo, em vez de deixar a chamada falhar em silêncio",
  );
  check(
    vc.includes("ENCOMENDA_PREFILL_STORAGE_KEY"),
    "…grava na mesma chave partilhada que OrderCreateClient lê",
  );
  check(
    /router\.push\(["']\/encomendas\/nova\?prefill=1["']\)/.test(vc),
    "…e navega para o fluxo normal de Encomendas",
  );
}

// ═════════════════════════════════════════════════════════════════════
// G. Correcção — universo pós-toggles, não o relatório bruto
// ═════════════════════════════════════════════════════════════════════
//
// Bug corrigido: "Criar encomenda com estes produtos" usava
// `rows.map(r => r.codigo)` — as linhas CRUAS do relatório, de antes
// dos toggles "Apenas com vendas" / "Apenas com stock". Devia usar o
// que fica efectivamente no ecrã depois desses toggles. A ponte é
// `codigosVisiveisVendas` (`lib/reporting/vendas-agrupamento.ts`), que
// `vendas-client` chama sobre `currentRows` (a mesma fonte da tabela).
console.log("\nG. Universo pós-toggles\n");

function linha(codigo: string, opts: Partial<LinhaAgrupavel> = {}): LinhaAgrupavel {
  return {
    codigo,
    descricao: `Produto ${codigo}`,
    farmacia: "Silveirense",
    meses: [],
    totalVendas: 0,
    existencia: 0,
    ...opts,
  };
}

// Correcção (2026-09): "Apenas com stock" deixou de ser um filtro que
// ESTREITA o universo (`vendas>0 AND stock>0`) para ser uma UNIÃO que o
// ALARGA (`vendas>0 OR stock>0`) — ver `passaTogglesRapidosVendas` em
// lib/reporting/vendas-agrupamento.ts. O fixture abaixo tem as quatro
// combinações da regra pedida (A/B/C/D), 100 códigos cada:
//   [0,100)   A: vendas=10, stock=5  → sempre visível
//   [100,200) B: vendas=10, stock=0  → sempre visível (tem venda)
//   [200,300) C: vendas=0,  stock=5  → só visível com "Apenas com stock"
//   [300,400) D: vendas=0,  stock=0  → nunca visível
function relatorioMisto(): LinhaAgrupavel[] {
  return Array.from({ length: 400 }, (_, i) => {
    const codigo = String(i + 1);
    const totalVendas = i < 200 ? 10 : 0; // A ou B
    const existencia = i < 100 || (i >= 200 && i < 300) ? 5 : 0; // A ou C
    return linha(codigo, { totalVendas, existencia });
  });
}

{
  // Defaults do relatório: "Apenas com vendas" ON, "Apenas com stock" OFF
  // — comportamento de sempre, inalterado por esta correcção. C (só
  // stock) fica de fora; A e B (300 total) ficam visíveis.
  const relatorioBruto = relatorioMisto();
  eq(relatorioBruto.length, 400, "relatório bruto tem 400 linhas (A+B+C+D)");

  const visiveis = codigosVisiveisVendas(relatorioBruto, {
    apenasComVendas: true,
    apenasComStock: false,
  });
  eq(visiveis.length, 200, "só 'Apenas com vendas': A+B (200) — C e D ficam de fora");
  eq(
    [...visiveis].sort((a, b) => Number(a) - Number(b)),
    Array.from({ length: 200 }, (_, i) => String(i + 1)),
    "…exactamente os códigos 1-200 (A e B)",
  );
}

{
  // "Apenas com stock" ligado (com "Apenas com vendas" também ligado,
  // que é o default do ecrã) — a UNIÃO pedida: A+B+C (300), nunca D.
  // Isto é o cenário que estava errado antes da correcção: C tinha de
  // aparecer e não aparecia.
  const relatorioBruto = relatorioMisto();
  const visiveis = codigosVisiveisVendas(relatorioBruto, {
    apenasComVendas: true,
    apenasComStock: true,
  });

  eq(visiveis.length, 300, "com 'Apenas com stock' ligado: A+B+C (300) — só D fica de fora");
  eq(
    [...visiveis].sort((a, b) => Number(a) - Number(b)),
    Array.from({ length: 300 }, (_, i) => String(i + 1)),
    "…exactamente os códigos 1-300 (A, B e C) — D (301-400) continua ausente",
  );

  const resultado = buildEncomendaPrefillFromVendas({
    ambito: "farmacia",
    farmaciasSelecionadas: ["Silveirense"],
    farmaciasDisponiveis: FARMACIAS,
    codigos: visiveis,
    dataInicio: "2026-01-01",
    dataFim: "2026-06-30",
    targetCoverageDays: 15,
  });

  check(resultado.ok, "a encomenda constrói-se a partir do universo pós-toggles (A+B+C)");
  if (resultado.ok) {
    eq(resultado.payload.cnps.length, 300, "o payload leva exactamente 300 CNP");
  }
}

{
  // "Apenas com stock" ligado SOZINHO ("Apenas com vendas" desligado) —
  // "com stock" continua a mandar: mesma união A+B+C, D fora. Prova que
  // os dois toggles deixam de ser independentes quando "com stock" está
  // ligado (ver comentário em passaTogglesRapidosVendas).
  const relatorioBruto = relatorioMisto();
  const visiveis = codigosVisiveisVendas(relatorioBruto, {
    apenasComVendas: false,
    apenasComStock: true,
  });
  eq(visiveis.length, 300, "'Apenas com stock' sozinho também dá A+B+C (300)");
}

{
  // Sem toggles activos, as 400 linhas ficam todas visíveis — confirma
  // que qualquer redução vem mesmo dos toggles, não de um filtro
  // escondido em `codigosVisiveisVendas`.
  const relatorioBruto = relatorioMisto();
  const semToggles = codigosVisiveisVendas(relatorioBruto, {
    apenasComVendas: false,
    apenasComStock: false,
  });
  eq(semToggles.length, 400, "sem toggles activos, as 400 linhas ficam todas visíveis");
}

console.log("\nH. Linha sintética de totais nunca entra na encomenda\n");

{
  // `agruparPorArtigo` insere uma linha `TOTAL ARTIGO` por apresentação
  // (ver `lib/reporting/vendas-agrupamento.ts`) — nunca é uma venda, e
  // tem de ficar de fora mesmo que apareça na lista recebida.
  const comTotal: LinhaAgrupavel[] = [
    linha("111", { totalVendas: 5, existencia: 2, farmacia: "Silveirense" }),
    linha("111", { totalVendas: 5, existencia: 2, farmacia: "Segurado" }),
    linha("111", {
      totalVendas: 10,
      existencia: 4,
      farmacia: ROTULO_TOTAL_ARTIGO,
    }),
    linha("222", { totalVendas: 3, existencia: 1, farmacia: "Silveirense" }),
  ];

  const visiveis = codigosVisiveisVendas(comTotal, {
    apenasComVendas: true,
    apenasComStock: true,
  });

  eq(visiveis.length, 3, "3 linhas reais sobrevivem (2× código 111 detalhe + 1× código 222) — a TOTAL ARTIGO fica de fora");
  eq(
    [...new Set(visiveis)].sort(),
    ["111", "222"],
    "o universo de CNP tem 111 e 222 — nunca uma terceira entrada vinda do total",
  );
}

// ═════════════════════════════════════════════════════════════════════
// I. Agrupamento diferente de "artigo" — o botão desactiva-se
// ═════════════════════════════════════════════════════════════════════
//
// Fora de "Agrupar por = Artigo", `codigo` deixa de ser garantidamente
// um CNP (em `groupRows`, com `ambito === "grupo"`, passa a guardar a
// chave do grupo — fabricante, categoria, etc.). Em vez de tentar
// distinguir os casos em que ainda seria seguro, `vendas-client`
// desactiva sempre o botão fora de "artigo" — mais simples, sem zonas
// cinzentas. Verificação por inspecção de código, ao estilo da secção F.
console.log("\nI. Agrupamento ≠ artigo desactiva o botão\n");

{
  const vc = src("components/vendas/vendas-client.tsx");
  check(
    vc.includes('const encomendaDisponivelPorAgrupamento = agruparPor === "artigo";'),
    "só disponível quando agrupado por artigo — é o único agrupamento onde `codigo` é mesmo um CNP",
  );
  check(
    /disabled=\{encomendaBloqueadaPorPerfil \|\| !encomendaDisponivelPorAgrupamento\}/.test(vc),
    "o botão respeita as duas condições de bloqueio: perfil E agrupamento",
  );
  check(
    vc.includes("codigosVisiveisVendas(currentRows,"),
    "a extracção de CNP usa o universo pós-toggles (`currentRows`), não `rows` cru",
  );
  check(
    !/codigos:\s*rows\.map/.test(vc),
    "…e já não usa `rows.map(...)` — as linhas cruas de antes dos toggles",
  );
}

// ═════════════════════════════════════════════════════════════════════
console.log(`\n${ko === 0 ? "PASSOU" : "FALHOU"} — ${ok} OK, ${ko} falhas\n`);
process.exit(ko === 0 ? 0 : 1);
