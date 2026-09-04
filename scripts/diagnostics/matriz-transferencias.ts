/**
 * scripts/diagnostics/matriz-transferencias.ts
 *
 * Diagnóstico READ-ONLY. Não escreve, não altera, não corre migrations.
 *
 * Corre o MOTOR REAL (`lib/operational/motor-stock`) sobre os dados reais
 * do tenant, uma vez por combinação de parâmetros, e mede o que cada
 * combinação produziria. Nenhum threshold é alterado em lado nenhum: os
 * parâmetros entram por argumento na função, como já entram hoje.
 *
 * ── O QUE ESTA MATRIZ RESPONDE, E O QUE NÃO ─────────────────────────
 *
 * Responde: quantas linhas, quantos CNP, quantos pares, quantas
 * sugestões, quantas unidades e que valor cada combinação produz.
 *
 * NÃO responde se as sugestões são boas. Uma configuração que gera 400
 * transferências não é melhor do que uma que gera 40 — é diferente. A
 * leitura útil é a CURVA: onde é que o número de sugestões cresce muito
 * mais depressa do que o número de CNP com necessidade real, porque é aí
 * que se começou a chamar excesso a stock normal.
 *
 * ── UM PARÂMETRO COM DOIS PAPÉIS ────────────────────────────────────
 *
 * `targetDays` é ao mesmo tempo:
 *
 *   · a cobertura-alvo que define QUANTO da origem é excesso
 *     (excesso = (cobertura − target) × avgDaily);
 *   · a cobertura-alvo a que se quer levar o DESTINO
 *     (necessidade = (target − cobertura) × avgDaily).
 *
 * Não são separáveis hoje sem mudar a assinatura do motor. Subir o
 * `target` aumenta a necessidade do destino E reduz o excesso da origem
 * ao mesmo tempo — o efeito líquido não é adivinhável, e é por isso que
 * está aqui em vez de num palpite.
 *
 * ── SEGURANÇA DA ORIGEM ─────────────────────────────────────────────
 *
 * As colunas `<Xd` contam quantas sugestões deixariam a origem com menos
 * de X dias de cobertura depois da transferência; `=0` conta as que a
 * deixam SEM STOCK NENHUM.
 *
 * Na aritmética exacta isso não podia acontecer:
 *
 *   stock − excesso = cobertura×média − (cobertura−alvo)×média
 *                   = alvo × média
 *
 * Na implementação acontece. `excesso = Math.round(...)` e, quando
 * `alvo × média ≤ 0,5`, o arredondamento engole a reserva inteira: o
 * excesso passa a ser o stock todo. É o caso dos artigos que vendem
 * menos de ~6 unidades por ano, e o corte de 5 unidades NÃO o impede —
 * está reproduzido em scripts/tests/test-seguranca-origem.ts, secção C,
 * com um caso concreto (stock 5, 6 unidades/ano, cede as 5).
 *
 * A coluna `=0` existe para medir quantas dessas há nos dados reais.
 *
 * ── LIGAÇÃO ─────────────────────────────────────────────────────────
 *
 *   npx tsx scripts/diagnostics/matriz-transferencias.ts --tenant=silveira
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "../../generated/prisma/client";
import { buildTenantConnectionString, getTenantBySlug } from "../../lib/control-plane";
import { AlvoRecusado, descreverAlvo, resolverAlvo } from "../../lib/catalog/target-db";
import { EXCESSO_COVERAGE_DAYS } from "../../lib/operational/metrics-shared";
import {
  avaliarLinha,
  ehAccionavel,
  ehDestinoElegivel,
  emparelhar,
  type EstadoStock,
  type LinhaStock,
  type ParametrosMotor,
} from "../../lib/operational/motor-stock";
import {
  diasDaJanela,
  janelaOperacionalPorOmissao,
  janelaParaIndicesMensais,
} from "../../lib/operational/janela-meses";

// ─────────────────────────────────────────────────────────────────────
const linha = (t = "") => console.log(t);
const nf = (n: number) => n.toLocaleString("pt-PT");
const eur = (n: number) =>
  n.toLocaleString("pt-PT", { minimumFractionDigits: 0, maximumFractionDigits: 0 });

function titulo(t: string) {
  linha("");
  linha("═".repeat(78));
  linha(t);
  linha("═".repeat(78));
}

/**
 * Confirma que uma regra continua escrita onde este diagnóstico julga.
 * Um diagnóstico que mede uma regra já alterada é pior do que nenhum:
 * dá um número com ar de verdade.
 */
function confirmarRegra(ficheiro: string, trecho: string, descricao: string) {
  let fonte = "";
  try {
    fonte = readFileSync(ficheiro, "utf8");
  } catch {
    linha(`  !! não consegui ler ${ficheiro} — não posso confirmar: ${descricao}`);
    return;
  }
  if (fonte.includes(trecho)) linha(`  ✓ ${descricao}`);
  else linha(`  !! ATENÇÃO: ${descricao} — MUDOU em ${ficheiro}`);
}

// ─────────────────────────────────────────────────────────────────────
type LinhaPf = {
  produtoId: string;
  farmaciaId: string;
  farmaciaNome: string;
  stockAtual: number;
  pvp: number | null;
  puc: number | null;
};

async function carregarProdutoFarmacia(
  prisma: PrismaClient,
  farmaciaIds: string[],
): Promise<LinhaPf[]> {
  // Só stock > 0: é o default de `loadPfAndSales` que os Excessos usam.
  return prisma.$queryRaw<LinhaPf[]>(Prisma.sql`
    SELECT
      pf."produtoId",
      pf."farmaciaId",
      f.nome                 AS "farmaciaNome",
      pf."stockAtual"::float AS "stockAtual",
      pf.pvp::float          AS "pvp",
      pf.puc::float          AS "puc"
    FROM "ProdutoFarmacia" pf
    JOIN "Farmacia" f ON f.id = pf."farmaciaId"
    WHERE pf."stockAtual" IS NOT NULL
      AND pf."stockAtual" > 0
      AND pf."flagRetirado" = false
      AND f.id = ANY(${farmaciaIds})
  `);
}

async function somarVendas(
  prisma: PrismaClient,
  farmaciaIds: string[],
  inicioIndice: number,
  fimExclusivo: number,
): Promise<Map<string, number>> {
  const linhas = await prisma.$queryRaw<
    Array<{ produtoId: string; farmaciaId: string; totalQty: number }>
  >(Prisma.sql`
    SELECT vm."produtoId", vm."farmaciaId", SUM(vm.quantidade)::float AS "totalQty"
    FROM "VendaMensal" vm
    WHERE (vm.ano * 12 + vm.mes) >= ${inicioIndice}
      AND (vm.ano * 12 + vm.mes) < ${fimExclusivo}
      AND vm."farmaciaId" = ANY(${farmaciaIds})
    GROUP BY vm."produtoId", vm."farmaciaId"
  `);
  const mapa = new Map<string, number>();
  for (const l of linhas) mapa.set(`${l.produtoId}:${l.farmaciaId}`, Number(l.totalQty) || 0);
  return mapa;
}

// ─────────────────────────────────────────────────────────────────────
type LinhaMotor = LinhaStock & { produtoId: string; pvp: number | null; puc: number | null };

type Celula = {
  thresholdDays: number;
  targetDays: number;
  excessoMinimo: number;
  linhasExcesso: number;
  cnpExcesso: number;
  linhasNecessidade: number;
  paresElegiveis: number;
  sugestoes: number;
  unidades: number;
  valorPvp: number;
  valorCusto: number;
  /** Sugestões que deixariam a origem abaixo de X dias de cobertura. */
  abaixo30: number;
  abaixo45: number;
  abaixo60: number;
  /**
   * Sugestoes que deixam a origem SEM STOCK NENHUM.
   *
   * Nao e' hipotetico: `excesso = Math.round((cobertura - alvo) x media)`
   * e, quando `alvo x media <= 0,5`, o arredondamento engole a reserva e
   * o excesso passa a ser o stock inteiro. Acontece em artigos que vendem
   * menos de ~6 unidades por ano, e o corte de 5 unidades NAO o impede
   * (ver scripts/tests/test-seguranca-origem.ts, seccao C).
   */
  zeradas: number;
};

function medir(base: LinhaMotor[], params: ParametrosMotor): Celula {
  const grupos = new Map<string, EstadoStock<LinhaMotor>[]>();
  for (const l of base) {
    const estado = avaliarLinha<LinhaMotor>(l, params);
    const lista = grupos.get(l.produtoId);
    if (lista) lista.push(estado);
    else grupos.set(l.produtoId, [estado]);
  }

  const c: Celula = {
    thresholdDays: params.thresholdDays,
    targetDays: params.targetDays,
    excessoMinimo: params.excessoMinimo ?? 0,
    linhasExcesso: 0,
    cnpExcesso: 0,
    linhasNecessidade: 0,
    paresElegiveis: 0,
    sugestoes: 0,
    unidades: 0,
    valorPvp: 0,
    valorCusto: 0,
    abaixo30: 0,
    abaixo45: 0,
    abaixo60: 0,
    zeradas: 0,
  };

  for (const grupo of grupos.values()) {
    const origens = grupo.filter((e) => e.excesso > 0);
    c.linhasExcesso += origens.length;
    if (origens.length > 0) c.cnpExcesso++;
    c.linhasNecessidade += grupo.filter((e) => e.necessidade > 0).length;
    if (grupo.length < 2) continue;

    for (const origem of origens) {
      c.paresElegiveis += grupo.filter(
        (x) => x.farmaciaId !== origem.farmaciaId && ehDestinoElegivel(x),
      ).length;

      const par = emparelhar(origem, grupo);
      if (!ehAccionavel(par)) continue;

      const q = par.quantidadeSugerida;
      c.sugestoes++;
      c.unidades += q;
      if (origem.pvp && origem.pvp > 0) c.valorPvp += q * origem.pvp;
      if (origem.puc && origem.puc > 0) c.valorCusto += q * origem.puc;

      // Cobertura da ORIGEM depois de ceder as unidades.
      const restante = origem.avgDaily > 0 ? (origem.stockAtual - q) / origem.avgDaily : Infinity;
      if (restante < 30) c.abaixo30++;
      if (restante < 45) c.abaixo45++;
      if (restante < 60) c.abaixo60++;
      if (origem.stockAtual - q <= 0) c.zeradas++;
    }
  }
  return c;
}

/**
 * O mesmo motor, mas com uma RESERVA na origem: a sugestão é adicionalmente
 * limitada a `stock − reservaDias × avgDaily`.
 *
 * Não altera o motor — recalcula por cima do emparelhamento que ele
 * devolve, que é exactamente o que uma futura regra de reserva faria.
 */
function medirComReserva(
  base: LinhaMotor[],
  params: ParametrosMotor,
  reservaDias: number,
): { sugestoes: number; unidades: number; valorPvp: number; perdidas: number; unidadesPerdidas: number } {
  const grupos = new Map<string, EstadoStock<LinhaMotor>[]>();
  for (const l of base) {
    const estado = avaliarLinha<LinhaMotor>(l, params);
    const lista = grupos.get(l.produtoId);
    if (lista) lista.push(estado);
    else grupos.set(l.produtoId, [estado]);
  }

  let sugestoes = 0;
  let unidades = 0;
  let valorPvp = 0;
  let perdidas = 0;
  let unidadesPerdidas = 0;

  for (const grupo of grupos.values()) {
    if (grupo.length < 2) continue;
    for (const origem of grupo.filter((e) => e.excesso > 0)) {
      const par = emparelhar(origem, grupo);
      if (!ehAccionavel(par)) continue;

      const tecto = Math.floor(Math.max(0, origem.stockAtual - reservaDias * origem.avgDaily));
      const q = Math.min(par.quantidadeSugerida, tecto);
      if (q <= 0) {
        perdidas++;
        unidadesPerdidas += par.quantidadeSugerida;
        continue;
      }
      sugestoes++;
      unidades += q;
      if (origem.pvp && origem.pvp > 0) valorPvp += q * origem.pvp;
      unidadesPerdidas += par.quantidadeSugerida - q;
    }
  }
  return { sugestoes, unidades, valorPvp, perdidas, unidadesPerdidas };
}

// ═════════════════════════════════════════════════════════════════════
async function principal() {
  linha("SPharm.MT · matriz de sensibilidade das transferências · read-only");
  linha("");

  let alvo;
  try {
    alvo = await resolverAlvo(process.argv.slice(2), {
      getTenantBySlug,
      buildTenantConnectionString,
    });
  } catch (e) {
    if (e instanceof AlvoRecusado) {
      linha(`ERRO: ${e.message}`);
      linha("");
      linha("Uso: npx tsx scripts/diagnostics/matriz-transferencias.ts --tenant=<slug>");
      process.exit(2);
    }
    throw e;
  }
  linha(`base: ${descreverAlvo(alvo)}`);

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: alvo.url }) });

  try {
    titulo("REGRAS CONFIRMADAS NO CÓDIGO");
    confirmarRegra(
      "lib/transferencias-data.ts",
      "excessoMinimo: 5,",
      "corte herdado: excessos abaixo de 5 unidades contam como 0",
    );
    confirmarRegra(
      "lib/transferencias-data.ts",
      "targetDays: 30,",
      "cobertura-alvo de 30 dias",
    );
    confirmarRegra(
      "lib/operational/motor-stock.ts",
      "const bruto = Math.round((coberturaDias - params.targetDays) * avgDaily);",
      "excesso = (cobertura − alvo) × média diária",
    );
    confirmarRegra(
      "lib/operational/motor-stock.ts",
      "return p.origem.excesso > 0 && p.necessidadeDestino > 0 && p.quantidadeSugerida > 0;",
      "filtro final das transferências",
    );

    const farmacias = await prisma.$queryRaw<Array<{ id: string; nome: string }>>(
      Prisma.sql`SELECT id, nome FROM "Farmacia"
                 WHERE estado = 'ATIVO' AND nome <> 'Farmácia Teste' ORDER BY nome`,
    );
    const farmaciaIds = farmacias.map((f) => f.id);
    linha("");
    linha(`  farmácias activas: ${farmacias.length} — ${farmacias.map((f) => f.nome).join(", ")}`);
    if (farmaciaIds.length < 2) {
      linha("  menos de 2 farmácias: não há transferências possíveis. Fim.");
      return;
    }

    const janela = janelaOperacionalPorOmissao();
    const dias = diasDaJanela(janela);
    const idx = janelaParaIndicesMensais(janela);
    const vendas = await somarVendas(prisma, farmaciaIds, idx.inicioIndice, idx.fimExclusivo);
    const pf = await carregarProdutoFarmacia(prisma, farmaciaIds);

    const base: LinhaMotor[] = pf.map((r) => ({
      produtoId: r.produtoId,
      farmaciaId: r.farmaciaId,
      farmaciaNome: r.farmaciaNome,
      stockAtual: Number(r.stockAtual),
      vendasJanela: vendas.get(`${r.produtoId}:${r.farmaciaId}`) ?? 0,
      pvp: r.pvp,
      puc: r.puc,
    }));

    linha(`  janela: ${janela.inicio} a ${janela.fim} (${dias} dias)`);
    linha(`  linhas produto×farmácia com stock > 0: ${nf(base.length)}`);
    const semPvp = base.filter((b) => !b.pvp || b.pvp <= 0).length;
    const semPuc = base.filter((b) => !b.puc || b.puc <= 0).length;
    linha(`  sem PVP: ${nf(semPvp)} · sem PUC: ${nf(semPuc)}  (valores abaixo são SUBESTIMADOS)`);

    // ══════════════════════════════════════════════════════════════════
    // O CONFRONTO. As duas configurações lado a lado, linha a linha, sem
    // a matriz pelo meio — é a única comparação que decide alguma coisa.
    // ══════════════════════════════════════════════════════════════════
    titulo("CONFRONTO · 180/30/5 sem reserva   vs   120/45/3 com reserva 30d");

    const ANTES: ParametrosMotor = {
      diasJanela: dias,
      thresholdDays: 180,
      targetDays: 30,
      excessoMinimo: 5,
    };
    const DEPOIS: ParametrosMotor = {
      diasJanela: dias,
      thresholdDays: 120,
      targetDays: 45,
      excessoMinimo: 3,
      reservaDias: 30,
    };
    const antes = medir(base, ANTES);
    const depois = medir(base, DEPOIS);
    // O mesmo cenário 120/45/3 SEM reserva, para isolar quanto é que a
    // reserva custa — de outra forma o efeito dos thresholds e o da
    // reserva ficavam somados e indistinguíveis.
    const depoisSemReserva = medir(base, { ...DEPOIS, reservaDias: 0 });

    const delta = (a: number, b: number) => {
      const d = b - a;
      const pct = a > 0 ? ` (${d >= 0 ? "+" : ""}${Math.round((d / a) * 100)}%)` : "";
      return `${d >= 0 ? "+" : ""}${nf(d)}${pct}`;
    };
    const linhaConfronto = (rotulo: string, a: number, b: number, moeda = false) => {
      const fmt = moeda ? eur : nf;
      linha(
        `  ${rotulo.padEnd(34)}${fmt(a).padStart(12)}${fmt(b).padStart(12)}   ${delta(a, b)}`,
      );
    };

    linha("");
    linha(`  ${"".padEnd(34)}${"180/30/5".padStart(12)}${"120/45/3+r30".padStart(12)}   diferença`);
    linha("  " + "─".repeat(74));
    linhaConfronto("linhas com excesso", antes.linhasExcesso, depois.linhasExcesso);
    linhaConfronto("CNP com excesso", antes.cnpExcesso, depois.cnpExcesso);
    linhaConfronto("linhas com necessidade", antes.linhasNecessidade, depois.linhasNecessidade);
    linhaConfronto("pares origem→destino", antes.paresElegiveis, depois.paresElegiveis);
    linhaConfronto("SUGESTÕES FINAIS", antes.sugestoes, depois.sugestoes);
    linhaConfronto("unidades sugeridas", antes.unidades, depois.unidades);
    linhaConfronto("valor a PVP (€)", antes.valorPvp, depois.valorPvp, true);
    linhaConfronto("valor a custo (€)", antes.valorCusto, depois.valorCusto, true);
    linha("  " + "─".repeat(74));
    linhaConfronto("origens que ficam < 30d", antes.abaixo30, depois.abaixo30);
    linhaConfronto("origens que ficam < 45d", antes.abaixo45, depois.abaixo45);
    linhaConfronto("origens que ficam < 60d", antes.abaixo60, depois.abaixo60);
    linhaConfronto("origens que ficam A ZERO", antes.zeradas, depois.zeradas);
    linha("  " + "─".repeat(74));
    linha("");
    linha("  Quanto custa a RESERVA, isolada dos thresholds:");
    linha(`    120/45/3 sem reserva ...... ${nf(depoisSemReserva.sugestoes)} sugestões, ${nf(depoisSemReserva.unidades)} unidades`);
    linha(`    120/45/3 com reserva 30d .. ${nf(depois.sugestoes)} sugestões, ${nf(depois.unidades)} unidades`);
    linha(`    sugestões anuladas ........ ${nf(depoisSemReserva.sugestoes - depois.sugestoes)}`);
    linha(`    unidades cortadas ......... ${nf(depoisSemReserva.unidades - depois.unidades)}`);
    linha(`    origens salvas do zero .... ${nf(depoisSemReserva.zeradas - depois.zeradas)}`);

    // ══════════════════════════════════════════════════════════════════
    titulo("MATRIZ · cobertura de origem × excesso mínimo   (alvo = 30 dias)");
    linha("");
    linha("  orig  min │  linhas    CNP    pares   sugest   unid.     € PVP    € custo │ <30d <45d <60d  =0");
    linha("  ──────────┼───────────────────────────────────────────────────────────────────┼────────────────────");

    const COBERTURAS = [180, 150, 120, 90, 60];
    const MINIMOS = [5, 3, 2, 1];
    const ALVOS = [30, 45, 60];
    const celulas: Celula[] = [];

    for (const thresholdDays of COBERTURAS) {
      for (const excessoMinimo of MINIMOS) {
        const c = medir(base, { diasJanela: dias, thresholdDays, targetDays: 30, excessoMinimo });
        celulas.push(c);
        linha(
          `  ${String(thresholdDays).padStart(4)} ${String(excessoMinimo).padStart(4)} │` +
            `${nf(c.linhasExcesso).padStart(8)}` +
            `${nf(c.cnpExcesso).padStart(7)}` +
            `${nf(c.paresElegiveis).padStart(9)}` +
            `${nf(c.sugestoes).padStart(9)}` +
            `${nf(c.unidades).padStart(8)}` +
            `${eur(c.valorPvp).padStart(11)}` +
            `${eur(c.valorCusto).padStart(11)} │` +
            `${nf(c.abaixo30).padStart(5)}${nf(c.abaixo45).padStart(5)}${nf(c.abaixo60).padStart(5)}${nf(c.zeradas).padStart(5)}`,
        );
      }
      linha("  ──────────┼───────────────────────────────────────────────────────────────────┼────────────────────");
    }

    // ══════════════════════════════════════════════════════════════════
    titulo("MATRIZ · cobertura de origem × alvo   (excesso mínimo = 5)");
    linha("");
    linha("  ATENÇÃO: `alvo` muda DUAS coisas ao mesmo tempo — quanto da origem");
    linha("  é excesso E até onde se enche o destino. Não são separáveis hoje.");
    linha("");
    linha("  orig  alvo │  linhas    CNP    pares   sugest   unid.     € PVP    € custo │ <30d <45d <60d  =0");
    linha("  ───────────┼───────────────────────────────────────────────────────────────────┼────────────────────");

    for (const thresholdDays of COBERTURAS) {
      for (const targetDays of ALVOS) {
        const c = medir(base, { diasJanela: dias, thresholdDays, targetDays, excessoMinimo: 5 });
        celulas.push(c);
        linha(
          `  ${String(thresholdDays).padStart(4)} ${String(targetDays).padStart(5)} │` +
            `${nf(c.linhasExcesso).padStart(8)}` +
            `${nf(c.cnpExcesso).padStart(7)}` +
            `${nf(c.paresElegiveis).padStart(9)}` +
            `${nf(c.sugestoes).padStart(9)}` +
            `${nf(c.unidades).padStart(8)}` +
            `${eur(c.valorPvp).padStart(11)}` +
            `${eur(c.valorCusto).padStart(11)} │` +
            `${nf(c.abaixo30).padStart(5)}${nf(c.abaixo45).padStart(5)}${nf(c.abaixo60).padStart(5)}${nf(c.zeradas).padStart(5)}`,
        );
      }
      linha("  ───────────┼───────────────────────────────────────────────────────────────────┼────────────────────");
    }

    // ══════════════════════════════════════════════════════════════════
    titulo("RESERVA MÍNIMA NA ORIGEM");
    linha("");
    linha("  A sugestão passa a ser limitada também a  stock − reserva × média diária.");
    linha("  `perdidas` = sugestões que a reserva anula por completo.");
    linha("");
    linha("  config                 reserva │  sugest    unid.      € PVP │ perdidas  un. cortadas");
    linha("  ───────────────────────────────┼────────────────────────────────┼───────────────────────────");

    const CONFIGS: Array<{ nome: string; p: ParametrosMotor }> = [
      { nome: "actual (180/30/5)", p: { diasJanela: dias, thresholdDays: 180, targetDays: 30, excessoMinimo: 5 } },
      { nome: "120/30/3         ", p: { diasJanela: dias, thresholdDays: 120, targetDays: 30, excessoMinimo: 3 } },
      { nome: "90/30/3          ", p: { diasJanela: dias, thresholdDays: 90, targetDays: 30, excessoMinimo: 3 } },
      { nome: "90/45/3          ", p: { diasJanela: dias, thresholdDays: 90, targetDays: 45, excessoMinimo: 3 } },
    ];
    for (const { nome, p } of CONFIGS) {
      for (const reserva of [0, 14, 30, 45]) {
        const r = medirComReserva(base, p, reserva);
        linha(
          `  ${nome} ${String(reserva).padStart(6)}d │` +
            `${nf(r.sugestoes).padStart(8)}` +
            `${nf(r.unidades).padStart(9)}` +
            `${eur(r.valorPvp).padStart(11)} │` +
            `${nf(r.perdidas).padStart(9)}` +
            `${nf(r.unidadesPerdidas).padStart(13)}`,
        );
      }
      linha("  ───────────────────────────────┼────────────────────────────────┼───────────────────────────");
    }

    // ══════════════════════════════════════════════════════════════════
    titulo("DASHBOARD vs PÁGINA EXCESSOS · valor em excesso");
    linha("");
    confirmarRegra(
      "lib/stock-shared.ts",
      "return row.coverage != null && row.coverage > EXCESSO_COVERAGE_DAYS;",
      "Dashboard: qualquer linha com cobertura > 180 dias",
    );
    confirmarRegra(
      "lib/dashboard.ts",
      "(sum, r) => sum + r.stockAtual * unitCost(r),",
      "Dashboard: valoriza o STOCK TODO, não só o excedente",
    );

    // Dashboard: cobertura > 180 ⇒ Σ stockAtual × custo unitário.
    // `unitCost` do dashboard usa pmc/puc; aqui só há puc — a diferença
    // é dita em vez de escondida.
    const paramsDash: ParametrosMotor = {
      diasJanela: dias,
      thresholdDays: EXCESSO_COVERAGE_DAYS,
      targetDays: 30,
      excessoMinimo: 0, // o Dashboard NÃO aplica corte
    };
    let dashLinhas = 0;
    let dashValor = 0;
    let excLinhas = 0;
    let excValorExcedente = 0;
    let excValorStockTodo = 0;

    for (const l of base) {
      const e = avaliarLinha<LinhaMotor>(l, paramsDash);
      const custo = e.puc && e.puc > 0 ? e.puc : 0;
      if (e.coberturaDias !== null && e.coberturaDias > EXCESSO_COVERAGE_DAYS) {
        dashLinhas++;
        dashValor += e.stockAtual * custo;
      }
      // Excessos: mesmo threshold, MAS com o corte de 5 e valorizando só
      // o excedente.
      const eExc = avaliarLinha<LinhaMotor>(l, { ...paramsDash, excessoMinimo: 5 });
      if (eExc.excesso > 0) {
        excLinhas++;
        excValorExcedente += eExc.excesso * custo;
        excValorStockTodo += eExc.stockAtual * custo;
      }
    }

    linha("");
    linha(`  Dashboard  · linhas cobertura > 180d ......... ${nf(dashLinhas)}`);
    linha(`             · Σ stock TODO × custo ............ ${eur(dashValor)} €`);
    linha(`  Excessos   · linhas com excesso >= 5 un ...... ${nf(excLinhas)}`);
    linha(`             · Σ EXCEDENTE × custo ............. ${eur(excValorExcedente)} €`);
    linha(`             · (Σ stock todo dessas linhas) .... ${eur(excValorStockTodo)} €`);
    linha("");
    linha(`  Diferença de universo ....................... ${nf(dashLinhas - excLinhas)} linhas`);
    linha(`  Diferença de valor .......................... ${eur(dashValor - excValorExcedente)} €`);
    linha("");
    linha("  Duas causas independentes, ambas a inflacionar o Dashboard:");
    linha("   1. universo: o Dashboard não aplica o corte de 5 unidades;");
    linha("   2. grandeza: o Dashboard valoriza o stock inteiro da linha,");
    linha("      e não apenas o que está acima da cobertura-alvo.");
  } finally {
    await prisma.$disconnect();
  }
}

principal().catch((e) => {
  console.error(e);
  process.exit(1);
});
