/**
 * scripts/diagnostics/funil-rotura-transferencias.ts
 *
 * Diagnóstico READ-ONLY. Não escreve nada, não altera nada, não corre
 * migrations. Responde a duas perguntas com números reais do tenant:
 *
 *   1. Como se chega aos "em rotura" do Dashboard, e como é que esses
 *      produtos se distribuem por recência e por volume de procura.
 *
 *   2. Como se chega às N sugestões de transferência — etapa a etapa,
 *      com a contagem de eliminados em cada regra.
 *
 * Usa os mesmos loaders das páginas (`loadPfAndSales`, `ipf-reader`,
 * `motor-stock`), para o funil não ser uma segunda implementação que
 * explica um número diferente do real. A única excepção é
 * `lib/stock-data`, que importa `server-only` e não resolve fora do
 * build do Next: a regra de rotura é copiada e a cópia é verificada
 * contra o ficheiro-fonte em cada execução.
 *
 * Corre com (o directório é montado porque não vai na imagem):
 *   sudo docker compose ... --profile tools run --rm  *     -v /tmp/spharmmt/scripts/diagnostics:/app/scripts/diagnostics:ro  *     migrate npx tsx scripts/diagnostics/funil-rotura-transferencias.ts
 */
import { readFileSync } from "node:fs";
import { getPrisma } from "@/lib/prisma";
import { loadPfAndSales } from "@/lib/transferencias-data";
import {
  EXCESSO_COVERAGE_DAYS,
  WINDOW_90D,
  avgDaily as mediaDiaria90,
} from "@/lib/operational/metrics-shared";
import { loadIpfBatch, resolveAvgDaily90d } from "@/lib/operational/ipf-reader";
import {
  avaliarLinha,
  ehAccionavel,
  ehDestinoElegivel,
  emparelhar,
  type EstadoStock,
  type LinhaStock,
  type ParametrosMotor,
} from "@/lib/operational/motor-stock";
import {
  diasDaJanela,
  janelaOperacionalPorOmissao,
} from "@/lib/operational/janela-meses";

const nf = (n: number) => n.toLocaleString("pt-PT");
const linha = (r: string) => console.log(r);
const titulo = (t: string) => {
  console.log("");
  console.log("═".repeat(72));
  console.log(t);
  console.log("═".repeat(72));
};

function tabela(rotulos: string[], valores: number[], total: number) {
  const larg = Math.max(...rotulos.map((r) => r.length));
  rotulos.forEach((r, i) => {
    const v = valores[i];
    const pct = total > 0 ? ((v / total) * 100).toFixed(1) : "0.0";
    const barra = "█".repeat(Math.round((total > 0 ? v / total : 0) * 40));
    linha(`  ${r.padEnd(larg)}  ${String(nf(v)).padStart(7)}  ${pct.padStart(5)}%  ${barra}`);
  });
}

async function main() {
  const prisma = await getPrisma();
  const farmacias = await prisma.farmacia.findMany({
    where: { estado: "ATIVO", nome: { not: "Farmácia Teste" } },
    select: { id: true, nome: true },
    orderBy: { nome: "asc" },
  });
  linha(`Farmácias activas: ${farmacias.map((f) => f.nome).join(", ")}`);

  // ══════════════════════════════════════════════════════════════════
  // PARTE 1 · "EM ROTURA"
  //
  // A regra vive em `matchStockFilter(row, "out-of-stock")` e é, na
  // íntegra:
  //
  //     row.stockAtual <= 0 && row.salesQty90d > 0
  //
  // `salesQty90d` vem de `loadPfAndSales` SEM janela — ou seja, os três
  // meses civis ANTERIORES ao corrente. Uma unidade vendida chega.
  // ══════════════════════════════════════════════════════════════════
  titulo("PARTE 1 · Em rotura — a regra actual e o que ela apanha");

  // `lib/stock-data` importa `server-only`, que so' resolve dentro do
  // build do Next — nao se pode importar aqui. As linhas sao construidas
  // com os MESMOS helpers que ele usa (`loadPfAndSales` sem janela +
  // `resolveAvgDaily90d`), e a regra e' copiada de `matchStockFilter`.
  //
  // Para a copia nao poder divergir em silencio, o ficheiro-fonte e'
  // lido e a linha da regra confirmada. Se alguem a mudar, isto grita.
  const REGRA = 'return row.stockAtual <= 0 && row.salesQty90d > 0;';
  const fonte = readFileSync("lib/stock-shared.ts", "utf8");
  if (!fonte.includes(REGRA)) {
    linha("  !! ATENCAO: a regra de 'out-of-stock' em lib/stock-shared.ts MUDOU.");
    linha("     Este diagnostico esta' a medir a regra antiga:");
    linha(`     ${REGRA}`);
  } else {
    linha(`  regra confirmada em lib/stock-shared.ts:  ${REGRA}`);
  }

  const farmaciaIdsTodos = farmacias.map((f) => f.id);
  const [{ pfRows: pfTodos, salesMap: sales90 }, ipfMap] = await Promise.all([
    loadPfAndSales(farmaciaIdsTodos, { includeOutOfStock: true }),
    loadIpfBatch(farmaciaIdsTodos),
  ]);

  type LinhaRotura = {
    produtoId: string;
    farmaciaId: string;
    stockAtual: number;
    salesQty90d: number;
    dataUltimaVenda: Date | null;
  };
  const stockRows: LinhaRotura[] = pfTodos.map((p) => {
    const chave = `${p.produtoId}:${p.farmaciaId}`;
    const salesQty90d = sales90.get(chave) ?? 0;
    // `avgDaily90d` nao entra na regra de rotura, mas resolve-se na
    // mesma para o diagnostico nao divergir do loader real.
    void resolveAvgDaily90d(ipfMap.get(chave), mediaDiaria90(salesQty90d, WINDOW_90D));
    return {
      produtoId: p.produtoId,
      farmaciaId: p.farmaciaId,
      stockAtual: Number(p.stockAtual),
      salesQty90d,
      dataUltimaVenda: p.dataUltimaVenda,
    };
  });

  const emRotura = stockRows.filter((r) => r.stockAtual <= 0 && r.salesQty90d > 0);
  const semStock = stockRows.filter((r) => r.stockAtual <= 0);

  linha("");
  linha(`  linhas (produto × farmácia) carregadas ...... ${nf(stockRows.length)}`);
  linha(`  com stock <= 0 ............................. ${nf(semStock.length)}`);
  linha(`  …e salesQty90d > 0  ⇒ EM ROTURA ............ ${nf(emRotura.length)}`);
  linha(`  (stock 0 sem vendas na janela, excluídos) ... ${nf(semStock.length - emRotura.length)}`);

  // ── Distribuição por recência da última venda ─────────────────────
  const hoje = Date.now();
  const diasDesde = (d: Date | null) =>
    d ? Math.floor((hoje - new Date(d).getTime()) / 86_400_000) : null;

  const baldesRecencia = ["<= 7 dias", "8–30", "31–60", "61–90", "> 90", "sem data"];
  const contagemRecencia = [0, 0, 0, 0, 0, 0];
  for (const r of emRotura) {
    const d = diasDesde(r.dataUltimaVenda);
    if (d === null) contagemRecencia[5]++;
    else if (d <= 7) contagemRecencia[0]++;
    else if (d <= 30) contagemRecencia[1]++;
    else if (d <= 60) contagemRecencia[2]++;
    else if (d <= 90) contagemRecencia[3]++;
    else contagemRecencia[4]++;
  }
  linha("");
  linha("  Última venda (ProdutoFarmacia.dataUltimaVenda):");
  tabela(baldesRecencia, contagemRecencia, emRotura.length);

  // ── Distribuição por volume vendido na janela ─────────────────────
  const baldesVolume = ["1 unidade", "2–3", "4–10", "> 10"];
  const contagemVolume = [0, 0, 0, 0];
  for (const r of emRotura) {
    const q = r.salesQty90d;
    if (q <= 1) contagemVolume[0]++;
    else if (q <= 3) contagemVolume[1]++;
    else if (q <= 10) contagemVolume[2]++;
    else contagemVolume[3]++;
  }
  linha("");
  linha("  Unidades vendidas na janela de 3 meses:");
  tabela(baldesVolume, contagemVolume, emRotura.length);

  // ── Ocorrências: em quantos MESES distintos houve venda ───────────
  //
  // `VendaMensal` é mensal, portanto o mais fino que se consegue sem
  // ir às linhas de venda é o número de meses com quantidade > 0.
  // Não é "dias distintos com venda" — é o que os dados permitem, e
  // dizê-lo é melhor do que inventar uma precisão que não existe.
  const farmaciaIds = farmacias.map((f) => f.id);
  const ocorrencias = await prisma.$queryRaw<
    Array<{ produtoId: string; farmaciaId: string; meses: bigint }>
  >`
    SELECT vm."produtoId", vm."farmaciaId", COUNT(*)::bigint AS meses
    FROM "VendaMensal" vm
    WHERE vm."farmaciaId" = ANY(${farmaciaIds})
      AND vm.quantidade > 0
      AND (vm.ano * 12 + vm.mes) >= ${(() => {
        const j = janelaOperacionalPorOmissao();
        const [a, m] = j.inicio.split("-").map(Number);
        return a * 12 + m;
      })()}
    GROUP BY 1, 2
  `;
  const mesesPorChave = new Map(
    ocorrencias.map((o) => [`${o.produtoId}:${o.farmaciaId}`, Number(o.meses)]),
  );
  const baldesOcorr = ["1 mês só", "2–3 meses", "4–6 meses", "> 6 meses", "nenhum"];
  const contagemOcorr = [0, 0, 0, 0, 0];
  for (const r of emRotura) {
    const m = mesesPorChave.get(`${r.produtoId}:${r.farmaciaId}`) ?? 0;
    if (m === 0) contagemOcorr[4]++;
    else if (m === 1) contagemOcorr[0]++;
    else if (m <= 3) contagemOcorr[1]++;
    else if (m <= 6) contagemOcorr[2]++;
    else contagemOcorr[3]++;
  }
  linha("");
  linha("  Meses distintos com venda (janela de 12 meses):");
  tabela(baldesOcorr, contagemOcorr, emRotura.length);

  // ── Cruzamento: recência × recorrência ────────────────────────────
  //
  // É esta tabela que sustenta (ou derruba) uma classificação em três
  // níveis. Não se propõe nenhum limiar aqui — só se mede.
  let critico = 0;
  let pontual = 0;
  let semProcura = 0;
  for (const r of emRotura) {
    const d = diasDesde(r.dataUltimaVenda) ?? 999;
    const m = mesesPorChave.get(`${r.produtoId}:${r.farmaciaId}`) ?? 0;
    if (d <= 30 && m >= 2) critico++;
    else if (d <= 90 && m >= 1) pontual++;
    else semProcura++;
  }
  linha("");
  linha("  Recorte exploratório (NÃO implementado em lado nenhum):");
  tabela(
    [
      "A · <=30d e >=2 meses com venda",
      "B · <=90d, procura esporádica  ",
      "C · sem procura recente        ",
    ],
    [critico, pontual, semProcura],
    emRotura.length,
  );

  // ══════════════════════════════════════════════════════════════════
  // PARTE 2 · FUNIL DAS TRANSFERÊNCIAS
  //
  // Reproduz `getTransferenciasData` etapa a etapa, contando o que cai
  // em cada regra. Os parâmetros são os defaults reais.
  // ══════════════════════════════════════════════════════════════════
  titulo("PARTE 2 · Funil das transferências");

  const janela = janelaOperacionalPorOmissao();
  const params: ParametrosMotor = {
    diasJanela: diasDaJanela(janela),
    thresholdDays: EXCESSO_COVERAGE_DAYS,
    targetDays: 30,
    excessoMinimo: 5,
  };
  linha(`  janela ................ ${janela.inicio} a ${janela.fim} (${params.diasJanela} dias)`);
  linha(`  threshold de excesso .. cobertura > ${params.thresholdDays} dias`);
  linha(`  cobertura-alvo ........ ${params.targetDays} dias`);
  linha(`  excesso mínimo ........ ${params.excessoMinimo} unidades  ← regra herdada`);

  const { pfRows, salesMap } = await loadPfAndSales(farmaciaIds, { janela });
  type LinhaPf = LinhaStock & { produtoId: string; cnp: string };
  const grupos = new Map<string, EstadoStock<LinhaPf>[]>();
  for (const row of pfRows) {
    const estado = avaliarLinha<LinhaPf>(
      {
        produtoId: row.produtoId,
        cnp: row.cnp,
        farmaciaId: row.farmaciaId,
        farmaciaNome: row.farmaciaNome,
        stockAtual: Number(row.stockAtual),
        vendasJanela: salesMap.get(`${row.produtoId}:${row.farmaciaId}`) ?? 0,
      },
      params,
    );
    const lista = grupos.get(row.produtoId);
    if (lista) lista.push(estado);
    else grupos.set(row.produtoId, [estado]);
  }

  const todos = Array.from(grupos.values()).flat();
  const semConsumo = todos.filter((e) => e.avgDaily <= 0).length;
  const semCobertura = todos.filter((e) => e.coberturaDias === null).length;
  const acimaThreshold = todos.filter(
    (e) => e.coberturaDias !== null && e.coberturaDias > params.thresholdDays,
  ).length;
  const comExcesso = todos.filter((e) => e.excesso > 0).length;
  const cortadosPorMinimo = acimaThreshold - comExcesso;
  const comNecessidade = todos.filter((e) => e.necessidade > 0).length;
  const destinosElegiveis = todos.filter(ehDestinoElegivel).length;

  linha("");
  linha("  ETAPA                                              LINHAS   (queda)");
  linha(`  1. produto × farmácia carregados ............... ${String(nf(pfRows.length)).padStart(8)}`);
  linha(`     · CNP distintos ........................... ${String(nf(grupos.size)).padStart(8)}`);
  linha(`  2. sem consumo mensurável (avgDaily = 0) ....... ${String(nf(semConsumo)).padStart(8)}`);
  linha(`     · logo, sem cobertura definida ............ ${String(nf(semCobertura)).padStart(8)}`);
  linha(`  3. cobertura > ${params.thresholdDays}d .......................... ${String(nf(acimaThreshold)).padStart(8)}`);
  linha(`  4. …e excesso >= ${params.excessoMinimo} un.  ⇒ COM EXCESSO ....... ${String(nf(comExcesso)).padStart(8)}   (−${nf(cortadosPorMinimo)})`);
  linha(`  5. linhas com necessidade > 0 .................. ${String(nf(comNecessidade)).padStart(8)}`);
  linha(`  6. destinos elegíveis (consumo E necessidade) .. ${String(nf(destinosElegiveis)).padStart(8)}`);

  // ── Cruzamento por CNP ────────────────────────────────────────────
  let cnpComExcesso = 0;
  let cnpComAmbos = 0;
  let gruposUmaFarmacia = 0;
  let paresCandidatos = 0;
  let semDestino = 0;
  let cortadosPorStockOrigem = 0;
  let accionaveis = 0;

  for (const grupo of grupos.values()) {
    const origens = grupo.filter((e) => e.excesso > 0);
    if (origens.length > 0) cnpComExcesso++;
    if (grupo.length < 2) {
      if (origens.length > 0) gruposUmaFarmacia++;
      continue;
    }
    const temDestino = grupo.some(ehDestinoElegivel);
    if (origens.length > 0 && temDestino) cnpComAmbos++;

    for (const origem of origens) {
      const candidatos = grupo.filter(
        (c) => c.farmaciaId !== origem.farmaciaId && ehDestinoElegivel(c),
      );
      paresCandidatos += candidatos.length;
      const par = emparelhar(origem, grupo);
      if (!par.destino) {
        // Sem destino: ou ninguém precisa, ou a regra de segurança
        // cortou a sugestão a 0 (stock da origem insuficiente).
        if (candidatos.length === 0) semDestino++;
        else cortadosPorStockOrigem++;
        continue;
      }
      if (ehAccionavel(par)) accionaveis++;
    }
  }

  linha("");
  linha(`  7. CNP com pelo menos uma origem em excesso .... ${String(nf(cnpComExcesso)).padStart(8)}`);
  linha(`     · desses, só existem numa farmácia ........ ${String(nf(gruposUmaFarmacia)).padStart(8)}`);
  linha(`  8. CNP com excesso numa E necessidade noutra ... ${String(nf(cnpComAmbos)).padStart(8)}`);
  linha(`  9. pares origem→destino candidatos ............ ${String(nf(paresCandidatos)).padStart(8)}`);
  linha(` 10. origens sem nenhum destino elegível ........ ${String(nf(semDestino)).padStart(8)}`);
  linha(` 11. cortadas pelo stock da origem (sugestão 0) . ${String(nf(cortadosPorStockOrigem)).padStart(8)}`);
  linha(` 12. ⇒ LINHAS NO RELATÓRIO ..................... ${String(nf(accionaveis)).padStart(8)}`);
  linha("");
  linha("  Nota: o relatório aplica ainda `.slice(0, 200)` no fim.");
  linha(`        Neste tenant isso ${accionaveis > 200 ? "CORTA" : "não corta"} nada.`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
