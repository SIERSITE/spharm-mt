/**
 * scripts/tests/test-correccoes-2026-09.ts
 *
 * Testes de regressão das quatro correcções funcionais de 2026-09-03.
 * Puros: sem base de dados, sem rede, sem Chromium.
 *
 *   A–D  Vendas — agrupamento por artigo com detalhe por farmácia
 *   E–G  PDF    — o launcher do Chromium (o que se pode testar sem o abrir)
 *   H–J  Datas  — últimos 12 meses civis completos
 *   K–Q  Excessos — sugestão de transferência
 *
 * Corre com:  npm run test:correccoes-2026-09
 */
import {
  ROTULO_TOTAL_ARTIGO,
  agruparPorArtigo,
  contarReferenciasUnicas,
  grupoPrecisaDeTotal,
} from "../../lib/reporting/vendas-agrupamento";
import { buildVendasReport } from "../../lib/reporting/adapters/vendas";
import { ehLinhaSubtotal, linhasDeDetalhe } from "../../lib/reporting/report-types";
import {
  diasDaJanela,
  janelaExcessosPorOmissao,
  janelaParaIndicesMensais,
  normalizarJanela,
  ultimoDiaDoMes,
  ultimosMesesCompletos,
} from "../../lib/operational/janela-meses";
import {
  escolherDestino,
  necessidadeAte,
  quantidadeSegura,
  type CandidatoDestino,
} from "../../lib/operational/sugestao-transferencia";
import { readFileSync } from "node:fs";

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
// A–D · VENDAS — o mesmo CNP em duas farmácias
//
// Caso real: CNP 5647904, Zolpidem Aurovitas 10 Mg 20 Comp.
//   Silveirense 557 · Segurado 443 · TOTAL ARTIGO 1000
// e CNP 2707297, Paracetamol Generis 500 mg x 20:
//   Segurado 252 · Silveirense 247 · TOTAL ARTIGO 499
// ══════════════════════════════════════════════════════════════════════

const BUCKETS = [
  { ano: 2026, mes: 7 },
  { ano: 2026, mes: 8 },
  { ano: 2026, mes: 9 },
];

type LinhaTeste = {
  codigo: string;
  descricao: string;
  farmacia: string;
  meses: { ano: number; mes: number; quantidade: number }[];
  totalVendas: number;
  valorBruto: number;
  existencia: number;
  unidadesVendidas: number;
  pvp: number;
  fornecedor: string;
  fabricante: string;
  categoria: string;
  grupo: string;
};

const linha = (
  codigo: string,
  descricao: string,
  farmacia: string,
  qtds: [number, number, number],
  existencia: number,
  pvp = 3.5,
): LinhaTeste => ({
  codigo,
  descricao,
  farmacia,
  meses: BUCKETS.map((b, i) => ({ ...b, quantidade: qtds[i] })),
  totalVendas: qtds[0] + qtds[1] + qtds[2],
  valorBruto: (qtds[0] + qtds[1] + qtds[2]) * pvp,
  existencia,
  unidadesVendidas: qtds[0] + qtds[1] + qtds[2],
  pvp,
  fornecedor: "OCP",
  fabricante: "Aurovitas",
  categoria: "MEDICAMENTOS",
  grupo: "",
});

const ZOLPIDEM_SILV = linha("5647904", "Zolpidem Aurovitas 10 Mg 20 Comp. Revest. Por Pel.", "Farmácia Silveirense", [200, 200, 157], 51);
const ZOLPIDEM_SEG = linha("5647904", "Zolpidem Aurovitas 10 Mg 20 Comp. Revest. Por Pel.", "Farmácia Segurado", [150, 150, 143], 35);
const PARACETAMOL_SEG = linha("2707297", "Paracetamol Generis MG, 500 mg x 20 comp", "Farmácia Segurado", [100, 100, 52], 20);
const PARACETAMOL_SILV = linha("2707297", "Paracetamol Generis MG, 500 mg x 20 comp", "Farmácia Silveirense", [100, 100, 47], 12);
const SO_NUMA = linha("9999999", "Artigo só numa farmácia", "Farmácia Silveirense", [5, 5, 5], 3);

const LINHAS = [ZOLPIDEM_SILV, ZOLPIDEM_SEG, PARACETAMOL_SEG, PARACETAMOL_SILV, SO_NUMA];

console.log("\n=== A · agrupamento por artigo preserva o detalhe e soma o total ===");
{
  const grupos = agruparPorArtigo(LINHAS, BUCKETS);
  eq(grupos.length, 3, "três CNPs distintos formam três grupos");

  const zolpidem = grupos.find((g) => g.codigo === "5647904")!;
  eq(zolpidem.detalhes.length, 2, "Zolpidem: duas linhas de detalhe (uma por farmácia)");
  eq(zolpidem.detalhes.map((d) => d.farmacia), ["Farmácia Silveirense", "Farmácia Segurado"], "…as duas farmácias, pela ordem de entrada");
  eq(zolpidem.detalhes.map((d) => d.totalVendas), [557, 443], "…com 557 e 443 unidades");
  eq(zolpidem.total.totalVendas, 1000, "…e TOTAL ARTIGO = 1000");
  eq(zolpidem.total.farmacia, ROTULO_TOTAL_ARTIGO, "…a linha de total identifica-se como TOTAL ARTIGO");
  eq(zolpidem.total.existencia, 86, "…stock somado = 51 + 35 = 86");

  const paracetamol = grupos.find((g) => g.codigo === "2707297")!;
  eq(paracetamol.detalhes.map((d) => d.totalVendas), [252, 247], "Paracetamol: 252 (Segurado) e 247 (Silveirense)");
  eq(paracetamol.total.totalVendas, 499, "…e TOTAL ARTIGO = 499");

  const soNuma = grupos.find((g) => g.codigo === "9999999")!;
  check(!grupoPrecisaDeTotal(soNuma), "um artigo numa farmácia só NÃO leva linha de total");
  check(grupoPrecisaDeTotal(zolpidem), "…e um em duas farmácias leva");
}

console.log("\n=== B · agrupar por farmácia não introduz subtotais por artigo ===");
{
  const rel = buildVendasReport({
    rows: LINHAS,
    buckets: BUCKETS,
    filters: { agruparPor: "farmacia" },
    universe: { farmacias: [], fornecedores: [], fabricantes: [], categorias: [] },
    organization: "Grupo",
  });
  eq(rel.rows.length, LINHAS.length, "uma linha por linha de dados, e mais nenhuma");
  check(rel.rows.every((r) => !ehLinhaSubtotal(r)), "nenhuma linha de subtotal foi introduzida");
}

console.log("\n=== C · os totais mensais do TOTAL ARTIGO são a soma das farmácias ===");
{
  const zolpidem = agruparPorArtigo(LINHAS, BUCKETS).find((g) => g.codigo === "5647904")!;
  eq(zolpidem.total.meses.map((m) => m.quantidade), [350, 350, 300], "mês a mês: 200+150, 200+150, 157+143");
  eq(
    zolpidem.total.meses.reduce((s, m) => s + m.quantidade, 0),
    zolpidem.detalhes.reduce((s, d) => s + d.totalVendas, 0),
    "…e a soma dos meses bate certo com a soma dos detalhes",
  );
  // Bucket desalinhado: uma linha sem o mês de Setembro não pode somar
  // Agosto na casa de Setembro.
  const curta = { ...ZOLPIDEM_SEG, meses: ZOLPIDEM_SEG.meses.slice(0, 2), totalVendas: 300 };
  const g2 = agruparPorArtigo([ZOLPIDEM_SILV, curta], BUCKETS).find((g) => g.codigo === "5647904")!;
  eq(g2.total.meses.map((m) => m.quantidade), [350, 350, 157], "linha curta não desalinha os meses");
}

console.log("\n=== D · PDF/print/Excel: mesma semântica, e o subtotal fora dos totais ===");
{
  const rel = buildVendasReport({
    rows: LINHAS,
    buckets: BUCKETS,
    filters: { agruparPor: "artigo" },
    universe: { farmacias: [], fornecedores: [], fabricantes: [], categorias: [] },
    organization: "Grupo",
  });

  const detalhe = linhasDeDetalhe(rel.rows);
  const subtotais = rel.rows.filter(ehLinhaSubtotal);
  eq(detalhe.length, 5, "cinco linhas de detalhe");
  eq(subtotais.length, 2, "dois subtotais (só os CNPs em duas farmácias)");

  const totalZolpidem = subtotais.find((r) => r.codigo === "5647904")!;
  eq(totalZolpidem.totalVendas, 1000, "o subtotal do Zolpidem no relatório = 1000");
  eq(totalZolpidem.farmacia, ROTULO_TOTAL_ARTIGO, "…e vem identificado");
  eq(totalZolpidem.pvp, null, "…sem PVP: somar preços de prateleiras diferentes não significa nada");

  // O QUE MAIS IMPORTA: os subtotais não podem entrar no total geral.
  const somaDetalhe = detalhe.reduce((s, r) => s + Number(r.totalVendas ?? 0), 0);
  const somaTudo = rel.rows.reduce((s, r) => s + Number(r.totalVendas ?? 0), 0);
  eq(somaDetalhe, 1514, "unidades reais: 557+443+252+247+15");
  eq(somaTudo, 1514 + 1000 + 499, "…e somar as linhas todas duplicaria — é isto que o marcador evita");

  const resumo = Object.fromEntries((rel.summary ?? []).map((s) => [s.label, s.value]));
  eq(resumo["Unidades vendidas"], 1514, "o resumo conta as unidades REAIS");
  eq(resumo["Referências únicas"], 3, "…e 3 referências únicas, não 5");
  eq(resumo["Linhas"], 5, "…com 5 linhas de detalhe");

  // A ordem importa: cada total vem logo a seguir ao seu grupo.
  const ordem = rel.rows.map((r) => `${r.codigo}:${ehLinhaSubtotal(r) ? "T" : "d"}`);
  eq(
    ordem,
    ["5647904:d", "5647904:d", "5647904:T", "2707297:d", "2707297:d", "2707297:T", "9999999:d"],
    "detalhes seguidos do respectivo TOTAL ARTIGO",
  );

  eq(contarReferenciasUnicas(LINHAS), 3, "referências únicas = CNPs distintos");
}

// ══════════════════════════════════════════════════════════════════════
// E–G · PDF — o launcher
//
// Abrir mesmo o Chromium não é trabalho para um teste unitário (precisa
// do binário e de ~300 ms). O que se testa aqui é a CAUSA do crash de
// produção: o HOME e o perfil graváveis, e o crashpad desligado.
// A validação com o browser a sério está no plano de produção.
// ══════════════════════════════════════════════════════════════════════

console.log("\n=== E–G · o launcher do Chromium ===");
{
  const fonte = readFileSync("lib/reporting/report-pdf-server.ts", "utf8");
  check(/HOME: home/.test(fonte), "o launch passa um HOME próprio — a causa do crash em produção");
  check(/userDataDir: perfil/.test(fonte), "…e um user-data-dir isolado");
  check(/mkdtempSync/.test(fonte), "…criados em os.tmpdir(), que é tmpfs gravável no container");
  check(/--disable-crashpad/.test(fonte), "crashpad desligado — era ele que emitia '--database is required'");
  check(/executablePath: process\.env\.PUPPETEER_EXECUTABLE_PATH/.test(fonte), "usa o Chromium do sistema quando a env o indica");
  check(/arranqueEmCurso/.test(fonte), "dois PDFs simultâneos não lançam dois browsers (sem processos órfãos)");
  check(/page\.close\(\)/.test(fonte) && /finally/.test(fonte), "a página fecha sempre, em finally");
  check(/rmSync/.test(fonte), "o perfil temporário é apagado no shutdown");
  // Um gerador só: se aparecer um segundo launch noutro ficheiro, é
  // porque alguém copiou a correcção em vez de a partilhar.
  check(/puppeteer[\s\S]{0,20}\.launch\(/.test(fonte), "o launch vive no gerador central");
}

// ══════════════════════════════════════════════════════════════════════
// H–J · DATAS — últimos 12 meses civis completos
// ══════════════════════════════════════════════════════════════════════

console.log("\n=== H–J · janela por omissão dos Excessos ===");
{
  // H) hoje 03/09/2026 → 01/09/2025 a 31/08/2026
  eq(
    janelaExcessosPorOmissao(new Date("2026-09-03T10:00:00Z")),
    { inicio: "2025-09-01", fim: "2026-08-31" },
    "03/09/2026 → 01/09/2025 … 31/08/2026",
  );
  // I) hoje 15/01/2027 → 01/01/2026 a 31/12/2026
  eq(
    janelaExcessosPorOmissao(new Date("2027-01-15T10:00:00Z")),
    { inicio: "2026-01-01", fim: "2026-12-31" },
    "15/01/2027 → 01/01/2026 … 31/12/2026",
  );
  // 01/03/2027 → 01/03/2026 a 28/02/2027 (não bissexto)
  eq(
    janelaExcessosPorOmissao(new Date("2027-03-01T10:00:00Z")),
    { inicio: "2026-03-01", fim: "2027-02-28" },
    "01/03/2027 → 01/03/2026 … 28/02/2027",
  );
  // Bissexto: 2028 tem 29 de Fevereiro.
  eq(
    janelaExcessosPorOmissao(new Date("2028-03-10T10:00:00Z")),
    { inicio: "2027-03-01", fim: "2028-02-29" },
    "ano bissexto: fim a 29/02/2028",
  );
  eq(ultimoDiaDoMes(2028, 2), 29, "Fevereiro de 2028 tem 29 dias");
  eq(ultimoDiaDoMes(2026, 2), 28, "…e o de 2026 tem 28");

  // TIMEZONE: 31/08 às 23:30 em Lisboa é 22:30 UTC do MESMO dia; e
  // 01/09 às 00:30 em Lisboa (Verão, UTC+1) é 23:30 UTC do dia 31.
  // A janela tem de seguir o dia de Lisboa, não o de UTC.
  // 23:30 UTC de 31/08 são 00:30 de 01/09 em Lisboa (Verão, UTC+1): o mês
  // corrente já é Setembro e a janela avança com ele.
  eq(
    janelaExcessosPorOmissao(new Date("2026-08-31T23:30:00Z")),
    { inicio: "2025-09-01", fim: "2026-08-31" },
    "23:30 UTC de 31/08 já é 01/09 em Lisboa — a janela segue Lisboa",
  );
  // 23:30 de Lisboa do dia 31/08 (= 22:30 UTC) ainda é Agosto: um
  // servidor a raciocinar em UTC teria dado o mesmo aqui, mas o teste
  // acima é o que separa os dois — e é o que partia à meia-noite.
  eq(
    janelaExcessosPorOmissao(new Date("2026-08-31T23:30:00+01:00")),
    { inicio: "2025-08-01", fim: "2026-07-31" },
    "23:30 de Lisboa de 31/08 ainda é Agosto",
  );

  // J) o intervalo que a UI mostra é o que a query usa.
  const j = janelaExcessosPorOmissao(new Date("2026-09-03T10:00:00Z"));
  eq(janelaParaIndicesMensais(j), { inicioIndice: 2025 * 12 + 9, fimExclusivo: 2026 * 12 + 9 }, "índices mensais meio-abertos cobrem exactamente 12 meses");
  eq(
    janelaParaIndicesMensais(j).fimExclusivo - janelaParaIndicesMensais(j).inicioIndice,
    12,
    "…doze meses, nem mais nem menos",
  );
  eq(diasDaJanela(j), 365, "365 dias de 01/09/2025 a 31/08/2026");
  eq(diasDaJanela({ inicio: "2026-01-01", fim: "2026-01-31" }), 31, "…e um mês de 31 dias dá 31");

  // Datas do utilizador respeitadas; lixo cai para o default.
  eq(normalizarJanela("2026-01-01", "2026-06-30"), { inicio: "2026-01-01", fim: "2026-06-30" }, "as datas do utilizador são respeitadas");
  eq(
    normalizarJanela("2026-06-30", "2026-01-01", new Date("2026-09-03T10:00:00Z")),
    { inicio: "2025-09-01", fim: "2026-08-31" },
    "janela invertida cai para o default",
  );
  eq(
    normalizarJanela("nao-e-data", undefined, new Date("2026-09-03T10:00:00Z")),
    { inicio: "2025-09-01", fim: "2026-08-31" },
    "data inválida cai para o default",
  );
  eq(ultimosMesesCompletos(3, new Date("2026-09-03T10:00:00Z")), { inicio: "2026-06-01", fim: "2026-08-31" }, "a mesma função serve outras larguras de janela");
}

// ══════════════════════════════════════════════════════════════════════
// K–Q · EXCESSOS — a sugestão de transferência
// ══════════════════════════════════════════════════════════════════════

const destino = (
  nome: string,
  stock: number,
  avgDaily: number,
  coberturaDias: number | null,
): CandidatoDestino => ({
  farmaciaId: `id-${nome}`,
  farmaciaNome: nome,
  stockAtual: stock,
  avgDaily,
  coberturaDias,
});

console.log("\n=== K–M · a regra de segurança ===");
{
  // K) necessidade 0 ⇒ sugestão 0. O caso real do Nasalmer.
  const nasalmer = escolherDestino([destino("Silveirense", 6, 0.0222, 270)], {
    excessoOrigem: 25,
    stockOrigem: 25,
    coberturaAlvoDias: 30,
  });
  eq(nasalmer.quantidadeSugerida, 0, "Nasalmer: destino com 270 dias de cobertura não precisa de nada");
  eq(nasalmer.necessidadeDestino, 0, "…necessidade 0");
  eq(nasalmer.destino, null, "…e nenhum destino possível");

  // Vitorange: destino com mais stock que a origem.
  const vitorange = escolherDestino([destino("Segurado", 26, 0.05, 520)], {
    excessoOrigem: 25,
    stockOrigem: 25,
    coberturaAlvoDias: 30,
  });
  eq(vitorange.quantidadeSugerida, 0, "Vitorange: destino com 26 em stock não recebe 25 unidades");

  // L) excesso 20, necessidade 7 → 7
  const l = escolherDestino([destino("B", 2, 1, 2)], {
    excessoOrigem: 20,
    stockOrigem: 100,
    coberturaAlvoDias: 9,
  });
  eq(l.necessidadeDestino, 7, "necessidade = (9 − 2) × 1 = 7");
  eq(l.quantidadeSugerida, 7, "excesso 20 + necessidade 7 → sugestão 7");

  // M) excesso 5, necessidade 20 → 5
  const m = escolherDestino([destino("B", 0, 1, 0)], {
    excessoOrigem: 5,
    stockOrigem: 100,
    coberturaAlvoDias: 20,
  });
  eq(m.necessidadeDestino, 20, "necessidade = 20");
  eq(m.quantidadeSugerida, 5, "excesso 5 + necessidade 20 → sugestão 5");

  // A regra em si, isolada.
  eq(quantidadeSegura(20, 7, 100), 7, "min(excesso, necessidade, stock)");
  eq(quantidadeSegura(5, 20, 100), 5, "…a menor das três");
  eq(quantidadeSegura(20, 7, 3), 3, "…e o stock da origem também limita");
  eq(quantidadeSegura(-5, 10, 10), 0, "nunca negativo");
  eq(quantidadeSegura(Number.NaN, 10, 10), 0, "NaN é saneado para 0");
  // Infinity é tratado como "não sei", e não-sei vale 0: mais vale não
  // sugerir nada do que sugerir a partir de um número que não existe.
  eq(quantidadeSegura(Number.POSITIVE_INFINITY, 10, 10), 0, "Infinity é saneado para 0 — não se transfere a partir de um valor indefinido");
}

console.log("\n=== N–O · a escolha do destino ===");
{
  // N) A não precisa, B precisa de 8 → escolhe B.
  const escolha = escolherDestino(
    [destino("A", 100, 1, 100), destino("B", 1, 1, 1)],
    { excessoOrigem: 20, stockOrigem: 50, coberturaAlvoDias: 9 },
  );
  eq(escolha.destino?.farmaciaNome, "B", "escolhe a farmácia que PRECISA, não a primeira da lista");
  eq(escolha.quantidadeSugerida, 8, "…e sugere as 8 que faltam");

  // Entre dois que precisam, ganha o que precisa MAIS.
  const dois = escolherDestino(
    [destino("A", 5, 1, 5), destino("B", 1, 1, 1)],
    { excessoOrigem: 50, stockOrigem: 50, coberturaAlvoDias: 10 },
  );
  eq(dois.destino?.farmaciaNome, "B", "entre dois candidatos, ganha o de maior necessidade");
  eq(dois.necessidadeDestino, 9, "…9 contra 5");

  // Estabilidade: necessidades iguais → ordem alfabética, sempre igual.
  const empate = escolherDestino(
    [destino("Zeta", 1, 1, 1), destino("Alfa", 1, 1, 1)],
    { excessoOrigem: 50, stockOrigem: 50, coberturaAlvoDias: 10 },
  );
  eq(empate.destino?.farmaciaNome, "Alfa", "empate desfeito de forma estável");

  // O) ninguém precisa → destino null, sugestão 0.
  const nenhum = escolherDestino(
    [destino("A", 100, 1, 100), destino("B", 200, 2, 100)],
    { excessoOrigem: 30, stockOrigem: 30, coberturaAlvoDias: 30 },
  );
  eq(nenhum.destino, null, "nenhuma farmácia com necessidade → destino nulo");
  eq(nenhum.quantidadeSugerida, 0, "…e sugestão 0");
  eq(nenhum.necessidadeDestino, 0, "…e necessidade 0");

  // A origem nunca é destino de si própria.
  const semAuto = escolherDestino(
    [{ ...destino("Origem", 0, 1, 0), farmaciaId: "eu" }],
    { excessoOrigem: 10, stockOrigem: 10, coberturaAlvoDias: 30, origemFarmaciaId: "eu" },
  );
  eq(semAuto.destino, null, "a origem é excluída dos candidatos");
}

console.log("\n=== P–Q · consumo zero, residual, e nada de Infinity ===");
{
  // P) produto sem consumo: necessidade 0, sem divisão por zero.
  eq(necessidadeAte({ avgDaily: 0, coberturaDias: null }, 30), 0, "consumo 0 → necessidade 0, e não uma necessidade inventada");
  eq(necessidadeAte({ avgDaily: 0, coberturaDias: 0 }, 30), 0, "…mesmo com cobertura 0 no papel");
  eq(necessidadeAte({ avgDaily: Number.NaN, coberturaDias: 10 }, 30), 0, "NaN no consumo não produz necessidade");
  eq(
    necessidadeAte({ avgDaily: 1, coberturaDias: Number.POSITIVE_INFINITY }, 30),
    0,
    "cobertura infinita não produz necessidade",
  );
  const semConsumo = escolherDestino([destino("B", 0, 0, null)], {
    excessoOrigem: 10,
    stockOrigem: 10,
    coberturaAlvoDias: 30,
  });
  eq(semConsumo.destino, null, "um destino sem procura não é destino");
  eq(semConsumo.quantidadeSugerida, 0, "…e não recebe transferência automática");
  check(
    Number.isFinite(semConsumo.quantidadeSugerida) && !Number.isNaN(semConsumo.quantidadeSugerida),
    "sem Infinity e sem NaN na saída",
  );

  // Q) consumo residual: coerente, e a sugestão nunca passa a necessidade.
  const residual = escolherDestino([destino("B", 1, 0.02, 50)], {
    excessoOrigem: 25,
    stockOrigem: 25,
    coberturaAlvoDias: 90,
  });
  eq(residual.necessidadeDestino, 1, "consumo residual (0,02/dia) e alvo 90d → necessidade 1");
  eq(residual.quantidadeSugerida, 1, "…e a sugestão é 1, não o excesso inteiro");
  const arredondaParaBaixo = escolherDestino([destino("B", 1, 0.004, 50)], {
    excessoOrigem: 25,
    stockOrigem: 25,
    coberturaAlvoDias: 90,
  });
  eq(arredondaParaBaixo.necessidadeDestino, 0, "consumo tão residual que a necessidade arredonda a 0");
  eq(arredondaParaBaixo.quantidadeSugerida, 0, "…e então não há transferência");
}

console.log(`\nRESULTADO: ${ok} ok, ${ko} falhas`);
process.exit(ko === 0 ? 0 : 1);
