/**
 * lib/transferencias-data.ts
 * Server-side data for the transferencias and excessos pages.
 *
 * Transfer suggestions: products existing in BOTH pharmacies where one has
 * significant excess coverage and the other has a deficit.
 *
 * Excess identification: products with coverage >> threshold in any pharmacy,
 * regardless of whether the other pharmacy needs them.
 */
import { getPrisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { resolverPar } from "@/lib/categoria-resolver";
import {
  avgDaily,
  coverageDays,
  EXCESSO_COVERAGE_DAYS,
  WINDOW_90D,
} from "@/lib/operational/metrics-shared";
import { loadIpfBatch, resolveAvgDaily90d } from "@/lib/operational/ipf-reader";
import {
  findInternalSubstitutions,
  type InternalSubstitution,
  type SubstitutionOptions,
} from "@/lib/transfers/internal-substitution";
import {
  diasDaJanela,
  janelaParaIndicesMensais,
  normalizarJanela,
  type JanelaMeses,
} from "@/lib/operational/janela-meses";
import {
  escolherDestino,
  quantidadeSegura,
  type CandidatoDestino,
} from "@/lib/operational/sugestao-transferencia";

export type Priority = "alta" | "media" | "baixa";

export type TransferSuggestionRow = {
  cnp: string;
  produto: string;
  farmaciaOrigem: string;
  farmaciaDestino: string;
  stockOrigem: number;
  stockDestino: number;
  coberturaOrigem: number;
  coberturaDestino: number;
  quantidadeSugerida: number;
  excessoOrigem: number;
  necessidadeDestino: number;
  fabricante: string;
  /** Nível 1 canónico. Ver `resolverPar` — era o nível 2 até 2026-08. */
  categoria: string;
  /** Nível 2 canónico, ou "" quando não há um distinto do nível 1. */
  subcategoria: string;
  /** Slugs das utilizações do produto. Vazio quando não tem nenhuma. */
  utilizacoes: string[];
  fornecedor: string;
  prioridade: Priority;
  observacao?: string;
  /**
   * Valor estimado em € que fica disponível ao executar a transferência:
   * `quantidadeSugerida × pvp` na farmácia de origem. 0 quando não há pvp
   * registado.
   */
  valorUnlocked: number;
  // Enriquecimento clínico — surfaced em tooltip na UI.
  dci: string | null;
  codigoATC: string | null;
  // IDs internos — necessários ao CTA "Criar transferência".
  produtoId: string;
  farmaciaOrigemId: string;
  farmaciaDestinoId: string;
};

function toF(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export type PfBase = {
  produtoId: string;
  farmaciaId: string;
  farmaciaNome: string;
  cnp: string;
  designacao: string;
  stockAtual: number;
  stockMinimo: number | null;
  pvp: number | null;
  puc: number | null;
  pmc: number | null;
  dataUltimaVenda: Date | null;
  categoriaOrigem: string | null;
  subcategoriaOrigem: string | null;
  canonN1: string | null;
  canonN2: string | null;
  /** Slugs das utilizações do PRODUTO (não da farmácia). */
  utilizacoes: string[];
  fornecedorOrigem: string | null;
  fabricanteCanonico: string | null;
  // Enriquecimento clínico — usado por tooltips na UI (item 3) e pelo
  // detector DCI-equivalente (lib/transfers/dci-equivalent-substitution).
  dci: string | null;
  codigoATC: string | null;
  productType: string | null;
};

export type LoadPfAndSalesOptions = {
  /**
   * Janela de vendas a agregar. OMITIDA = comportamento histórico
   * (últimos 3 meses), que é o que /transferencias, /stock e o
   * dashboard esperam. Só os Excessos a passam, porque só lá a janela é
   * escolhida pelo utilizador — e tem de ser a MESMA que a UI mostra.
   */
  janela?: JanelaMeses;
  /**
   * Por defeito (false) `loadPfAndSales` só devolve linhas com
   * stockAtual > 0 — preserva o comportamento original usado pela
   * página /transferencias e /excessos. Para a página /stock e o
   * dashboard, que precisam de ver produtos em rotura, passar `true`.
   */
  includeOutOfStock?: boolean;
};

export async function loadPfAndSales(
  farmaciaIds: string[],
  options?: LoadPfAndSalesOptions,
): Promise<{
  pfRows: PfBase[];
  salesMap: Map<string, number>;
}> {
  const prisma = await getPrisma();
  const now = new Date();
  // Sem janela explícita: últimos 3 meses, como sempre foi.
  const janelaDefault = { periodEnd: now.getFullYear() * 12 + now.getMonth() + 1 };
  const { periodStart, periodEnd } = options?.janela
    ? (() => {
        const idx = janelaParaIndicesMensais(options.janela);
        return { periodStart: idx.inicioIndice, periodEnd: idx.fimExclusivo };
      })()
    : { periodStart: janelaDefault.periodEnd - 3, periodEnd: janelaDefault.periodEnd };

  const includeOutOfStock = options?.includeOutOfStock ?? false;
  const stockClause = includeOutOfStock
    ? Prisma.sql`pf."stockAtual" IS NOT NULL`
    : Prisma.sql`pf."stockAtual" IS NOT NULL AND pf."stockAtual" > 0`;

  const pfRows = await prisma.$queryRaw<PfBase[]>(Prisma.sql`
    SELECT
      pf."produtoId",
      pf."farmaciaId",
      f.nome            AS "farmaciaNome",
      p.cnp::text       AS cnp,
      p.designacao,
      pf."stockAtual"::float           AS "stockAtual",
      pf."stockMinimo"::float          AS "stockMinimo",
      pf.pvp::float                    AS pvp,
      pf.puc::float                    AS puc,
      pf.pmc::float                    AS pmc,
      pf."dataUltimaVenda"             AS "dataUltimaVenda",
      pf."categoriaOrigem",
      pf."subcategoriaOrigem",
      c1.nome                          AS "canonN1",
      c2.nome                          AS "canonN2",
      pf."fornecedorOrigem",
      fab."nomeNormalizado"            AS "fabricanteCanonico",
      p.dci                            AS dci,
      p."codigoATC"                    AS "codigoATC",
      p."productType"                  AS "productType"
    FROM "ProdutoFarmacia" pf
    JOIN "Produto"  p ON p.id  = pf."produtoId"
    JOIN "Farmacia" f ON f.id  = pf."farmaciaId"
    LEFT JOIN "Fabricante"    fab ON fab.id = p."fabricanteId"
    LEFT JOIN "Classificacao" c1  ON c1.id  = p."classificacaoNivel1Id"
    LEFT JOIN "Classificacao" c2  ON c2.id  = p."classificacaoNivel2Id"
    WHERE
      ${stockClause}
      AND pf."flagRetirado" = false
      AND f.id = ANY(${farmaciaIds})
  `);

  type SalesAgg = { produtoId: string; farmaciaId: string; totalQty: number };
  const salesRows = await prisma.$queryRaw<SalesAgg[]>(Prisma.sql`
    SELECT
      vm."produtoId",
      vm."farmaciaId",
      SUM(vm.quantidade)::float AS "totalQty"
    FROM "VendaMensal" vm
    WHERE
      (vm.ano * 12 + vm.mes) >= ${periodStart}
      AND (vm.ano * 12 + vm.mes) < ${periodEnd}
      AND vm."farmaciaId" = ANY(${farmaciaIds})
    GROUP BY vm."produtoId", vm."farmaciaId"
  `);

  const salesMap = new Map<string, number>();
  for (const s of salesRows) salesMap.set(`${s.produtoId}:${s.farmaciaId}`, toF(s.totalQty));

  // Utilizações numa consulta À PARTE e não numa lateral por linha: a
  // mesma associação repete-se em todas as farmácias que têm o produto,
  // e agregar por produto custa uma ida à base em vez de uma por linha.
  const utilRows = await prisma.$queryRaw<Array<{ produtoId: string; slugs: string[] }>>(Prisma.sql`
    SELECT pu."produtoId", array_agg(u.slug ORDER BY u.slug) AS slugs
      FROM "ProdutoUtilizacao" pu
      JOIN "Utilizacao" u ON u.id = pu."utilizacaoId"
     WHERE u.estado = 'ATIVO'
     GROUP BY pu."produtoId"
  `);
  const utilPorProduto = new Map(utilRows.map((u) => [u.produtoId, u.slugs]));
  for (const row of pfRows) row.utilizacoes = utilPorProduto.get(row.produtoId) ?? [];

  return { pfRows, salesMap };
}

/** Transfer suggestions: products with coverage imbalance between the two pharmacies. */
export async function getTransferenciasData(): Promise<TransferSuggestionRow[]> {
  const prisma = await getPrisma();
  const farmacias = await prisma.farmacia.findMany({
    where: { estado: "ATIVO", nome: { not: "Farmácia Teste" } },
    select: { id: true, nome: true },
    orderBy: { nome: "asc" },
  });
  const farmaciaIds = farmacias.map((f) => f.id);
  if (farmaciaIds.length < 2) return [];

  // Dual-read: IPF + sales em paralelo. Quando IPF tem linha, usa
  // mediaVendasDiarias90d (pré-calculado, drift 0 vs live); cai para
  // VendaMensal × 90d quando IPF ausente.
  const [{ pfRows, salesMap }, ipfMap] = await Promise.all([
    loadPfAndSales(farmaciaIds),
    loadIpfBatch(farmaciaIds),
  ]);

  // Group by produtoId
  type Entry = PfBase & { avgDaily: number; coverage: number };
  const byProduto = new Map<string, Entry[]>();
  for (const row of pfRows) {
    const key = `${row.produtoId}:${row.farmaciaId}`;
    const qty3m = salesMap.get(key) ?? 0;
    const liveAd = avgDaily(qty3m, WINDOW_90D);
    const { value: ad } = resolveAvgDaily90d(ipfMap.get(key), liveAd);
    const cov = coverageDays(toF(row.stockAtual), ad);
    const coverage = cov === null ? Infinity : cov;
    if (!byProduto.has(row.produtoId)) byProduto.set(row.produtoId, []);
    byProduto.get(row.produtoId)!.push({ ...row, avgDaily: ad, coverage });
  }

  const result: TransferSuggestionRow[] = [];

  for (const [, entries] of byProduto) {
    if (entries.length < 2) continue; // must exist in both pharmacies

    // Find pairs with coverage imbalance
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i];
        const b = entries[j];
        if (a.coverage === Infinity || b.coverage === Infinity) continue;

        // Determine origin (excess) and destination (deficit)
        let origem = a;
        let destino = b;
        if (b.coverage > a.coverage) { origem = b; destino = a; }

        // Only suggest if ratio >= 2.5:1 and destination has < 20 days
        if (origem.coverage < 20 || destino.coverage > 20) continue;
        if (origem.coverage / Math.max(destino.coverage, 1) < 2.5) continue;

        // Equalize to ~20 days each
        const targetDays = 20;
        const qtyToTransfer = Math.max(1, Math.round((origem.coverage - targetDays) * origem.avgDaily * 0.5));
        if (qtyToTransfer < 1) continue;

        const excessoOrigem = Math.round((origem.coverage - targetDays) * origem.avgDaily);
        const necessidadeDestino = Math.round((targetDays - destino.coverage) * destino.avgDaily);

        const prioridade: Priority =
          destino.coverage < 7 ? "alta" : destino.coverage < 14 ? "media" : "baixa";

        // A MESMA regra de segurança dos Excessos, aplicada aqui: a
        // sugestão nunca pode passar a necessidade do destino. Neste
        // caminho o destino já é escolhido por défice de cobertura
        // (`destino.coverage <= 20`), portanto a necessidade é quase
        // sempre positiva — mas "quase sempre" não é uma garantia, e a
        // regra vale para os dois relatórios pelas mesmas razões.
        const finalQty = quantidadeSegura(
          qtyToTransfer,
          Math.max(0, necessidadeDestino),
          Math.round(toF(origem.stockAtual)),
        );
        if (finalQty < 1) continue;
        const valorUnlocked =
          origem.pvp != null && origem.pvp > 0 ? finalQty * origem.pvp : 0;

        result.push({
          cnp: origem.cnp,
          produto: origem.designacao,
          farmaciaOrigem: origem.farmaciaNome,
          farmaciaDestino: destino.farmaciaNome,
          stockOrigem: Math.round(toF(origem.stockAtual)),
          stockDestino: Math.round(toF(destino.stockAtual)),
          coberturaOrigem: Math.round(origem.coverage),
          coberturaDestino: Math.round(destino.coverage),
          quantidadeSugerida: finalQty,
          excessoOrigem: Math.max(0, excessoOrigem),
          necessidadeDestino: Math.max(0, necessidadeDestino),
          // Fabricante CANÓNICO via Produto.fabricante; fornecedor é o
          // grossista habitual (ProdutoFarmacia.fornecedorOrigem).
          fabricante: origem.fabricanteCanonico ?? "",
          ...resolverPar({
            classificacaoNivel1: origem.canonN1 ? { nome: origem.canonN1 } : null,
            classificacaoNivel2: origem.canonN2 ? { nome: origem.canonN2 } : null,
          }),
          utilizacoes: origem.utilizacoes ?? [],
          fornecedor: origem.fornecedorOrigem ?? "",
          prioridade,
          observacao:
            prioridade === "alta"
              ? "Rutura previsível no destino, excesso confortável na origem."
              : prioridade === "media"
                ? "Transferência recomendada antes de reposição externa."
                : "Afinação opcional de cobertura.",
          valorUnlocked,
          dci: origem.dci,
          codigoATC: origem.codigoATC,
          produtoId: origem.produtoId,
          farmaciaOrigemId: origem.farmaciaId,
          farmaciaDestinoId: destino.farmaciaId,
        });
      }
    }
  }

  // Sort by priority then by deficit severity
  const rank: Record<Priority, number> = { alta: 3, media: 2, baixa: 1 };
  result.sort((a, b) => rank[b.prioridade] - rank[a.prioridade] || a.coberturaDestino - b.coberturaDestino);

  return result.slice(0, 200);
}

export type ExcessosOptions = {
  /**
   * Coverage threshold in days; products with coverage > thresholdDays are
   * excess. Default = `EXCESSO_COVERAGE_DAYS` (180), partilhado com
   * Inventário e Dashboard via `lib/operational/metrics-shared.ts`.
   */
  thresholdDays?: number;
  /** Target coverage in days for the "excess quantity" calculation. Default 30. */
  targetDays?: number;
  /**
   * Janela de consumo, `YYYY-MM-DD`. A MESMA que a UI mostra e que o
   * PDF imprime.
   *
   * Antes destas datas existirem aqui, o ecrã mostrava um período e o
   * cálculo usava outro — a UI tinha duas datas em `useState` que nunca
   * chegavam ao servidor, e o consumo vinha sempre dos últimos 3 meses.
   * Omitida = últimos 12 meses civis completos.
   */
  dataInicio?: string;
  dataFim?: string;
};

/**
 * Excess stock identification: products where coverage > thresholdDays.
 *
 * Default `thresholdDays = EXCESSO_COVERAGE_DAYS` (180) — mesma regra usada
 * por Inventário (`classifyEstado→EXCESSO`) e pelo Dashboard (filtro
 * `excess-stock-canonical`). Single source of truth em
 * `lib/operational/metrics-shared.ts`.
 *
 * `farmaciaDestino` mostra a outra farmácia se puder absorver parte do
 * excesso. As prioridades alta/média/baixa são relativas ao threshold base.
 */
export async function getExcessosData(
  options?: ExcessosOptions,
): Promise<TransferSuggestionRow[]> {
  const thresholdDays = options?.thresholdDays ?? EXCESSO_COVERAGE_DAYS;
  const targetDays = options?.targetDays ?? 30;
  // Uma janela só, daqui até à query, à média diária e ao cabeçalho do
  // relatório. `normalizarJanela` cai para os 12 meses completos quando
  // as datas não vêm ou não fazem sentido.
  const janela = normalizarJanela(options?.dataInicio, options?.dataFim);
  const diasJanela = diasDaJanela(janela);

  const prisma = await getPrisma();
  const farmacias = await prisma.farmacia.findMany({
    where: { estado: "ATIVO", nome: { not: "Farmácia Teste" } },
    select: { id: true, nome: true },
    orderBy: { nome: "asc" },
  });
  const farmaciaIds = farmacias.map((f) => f.id);
  if (farmaciaIds.length === 0) return [];

  // Dual-read também em /excessos (mesma política de stock-data /
  // transferencias).
  const { pfRows, salesMap } = await loadPfAndSales(farmaciaIds, { janela });

  // ── Consumo: a janela escolhida, e SÓ ela ─────────────────────────
  //
  // O IPF (`resolveAvgDaily90d`) fica de fora aqui de propósito: é uma
  // média de 90 dias pré-calculada, e misturá-la com uma janela de 12
  // meses dava um consumo que não corresponde a período nenhum. Os
  // outros relatórios continuam a usá-lo — só os Excessos é que têm
  // janela escolhida pelo utilizador.
  //
  // `coberturaDias` é `null` quando não há consumo mensurável, e NÃO
  // Infinity: um artigo sem vendas não tem cobertura infinita, tem
  // cobertura indefinida. É a distinção que impede a necessidade de ser
  // inventada no destino.
  type Entry = PfBase & { avgDaily: number; coberturaDias: number | null };
  const byProduto = new Map<string, Entry[]>();
  for (const row of pfRows) {
    const key = `${row.produtoId}:${row.farmaciaId}`;
    const qtyJanela = salesMap.get(key) ?? 0;
    const ad = avgDaily(qtyJanela, diasJanela);
    const coberturaDias = coverageDays(toF(row.stockAtual), ad);
    if (!byProduto.has(row.produtoId)) byProduto.set(row.produtoId, []);
    byProduto.get(row.produtoId)!.push({ ...row, avgDaily: ad, coberturaDias });
  }

  const result: TransferSuggestionRow[] = [];

  for (const [, entries] of byProduto) {
    for (const entry of entries) {
      // Sem cobertura definida não há excesso a declarar: um artigo sem
      // consumo não tem "1000 dias de stock", tem stock parado. Fica de
      // fora do relatório de excessos como sempre ficou.
      if (entry.coberturaDias === null) continue;
      if (entry.coberturaDias <= thresholdDays) continue;
      if (entry.avgDaily <= 0) continue;

      const excessQty = Math.round((entry.coberturaDias - targetDays) * entry.avgDaily);
      if (excessQty < 5) continue; // Only meaningful excesses

      // ── O DESTINO ─────────────────────────────────────────────────
      //
      // Antes: `others[0]` — a primeira farmácia da lista, tivesse ela
      // necessidade ou não. Agora: a que MAIS precisa, e nenhuma se
      // ninguém precisar. Ver lib/operational/sugestao-transferencia.ts.
      const candidatos: CandidatoDestino[] = entries
        .filter((e) => e.farmaciaId !== entry.farmaciaId)
        .map((e) => ({
          farmaciaId: e.farmaciaId,
          farmaciaNome: e.farmaciaNome,
          stockAtual: Math.round(toF(e.stockAtual)),
          avgDaily: e.avgDaily,
          coberturaDias: e.coberturaDias,
        }));

      const escolha = escolherDestino(candidatos, {
        excessoOrigem: excessQty,
        stockOrigem: Math.round(toF(entry.stockAtual)),
        coberturaAlvoDias: targetDays,
        origemFarmaciaId: entry.farmaciaId,
      });

      // Prioridade relativa ao threshold base — mantém a ordenação útil
      // qualquer que seja `thresholdDays` (default 180 ⇒ alta>360, media>270).
      const prioridade: Priority =
        entry.coberturaDias > thresholdDays * 2
          ? "alta"
          : entry.coberturaDias > thresholdDays * 1.5
            ? "media"
            : "baixa";

      // O valor libertado é o da quantidade que SE VAI MESMO transferir.
      // Com sugestão 0 não se liberta nada — antes somava-se o excesso
      // inteiro a um valor que nunca ia acontecer.
      const valorUnlocked =
        entry.pvp != null && entry.pvp > 0 ? escolha.quantidadeSugerida * entry.pvp : 0;

      result.push({
        cnp: entry.cnp,
        produto: entry.designacao,
        farmaciaOrigem: entry.farmaciaNome,
        // Vazio, e não "—" nem uma farmácia arbitrária: quando ninguém
        // precisa, não há destino possível. A UI mostra o travessão.
        farmaciaDestino: escolha.destino?.farmaciaNome ?? "",
        stockOrigem: Math.round(toF(entry.stockAtual)),
        stockDestino: escolha.destino ? escolha.destino.stockAtual : 0,
        coberturaOrigem: Math.round(entry.coberturaDias),
        coberturaDestino:
          escolha.destino && escolha.destino.coberturaDias !== null
            ? Math.round(escolha.destino.coberturaDias)
            : 0,
        quantidadeSugerida: escolha.quantidadeSugerida,
        excessoOrigem: excessQty,
        necessidadeDestino: escolha.necessidadeDestino,
        fabricante: entry.fabricanteCanonico ?? "",
        ...resolverPar({
          classificacaoNivel1: entry.canonN1 ? { nome: entry.canonN1 } : null,
          classificacaoNivel2: entry.canonN2 ? { nome: entry.canonN2 } : null,
        }),
        utilizacoes: entry.utilizacoes ?? [],
        fornecedor: entry.fornecedorOrigem ?? "",
        prioridade,
        observacao: escolha.destino
          ? `Excesso de ${Math.round(entry.coberturaDias)} dias de cobertura.`
          : `Excesso de ${Math.round(entry.coberturaDias)} dias — nenhuma farmácia do grupo tem necessidade.`,
        valorUnlocked,
        dci: entry.dci,
        codigoATC: entry.codigoATC,
        produtoId: entry.produtoId,
        farmaciaOrigemId: entry.farmaciaId,
        farmaciaDestinoId: escolha.destino?.farmaciaId ?? "",
      });
    }
  }

  result.sort((a, b) => b.coberturaOrigem - a.coberturaOrigem);
  return result.slice(0, 200);
}

/**
 * Substituição operacional interna (WS-C Fase 1): para produtos em
 * ruptura iminente, encontra **mesmo CNP** com excesso noutra
 * farmácia do grupo. Mais agressivo do que `getTransferenciasData`
 * — destinos com `coverage < 7d` e origens com `coverage > 30d`.
 *
 * NÃO substitui `getTransferenciasData` — é um path adicional focado
 * em "encomendas evitáveis hoje". Para o relatório de transferência
 * tradicional (rebalancing entre farmácias com ratio 2.5:1), continua
 * a usar `getTransferenciasData`.
 *
 * Output: linhas `InternalSubstitution` com `suggestedSourceFarmaciaId`,
 * `stockCoverageOrigin`, `stockCoverageDestination`,
 * `avoidedPurchaseEstimate`. Ordenado por € poupados desc.
 */
export async function getInternalSubstitutionsData(
  options?: SubstitutionOptions,
): Promise<InternalSubstitution[]> {
  const prisma = await getPrisma();
  const farmacias = await prisma.farmacia.findMany({
    where: { estado: "ATIVO", nome: { not: "Farmácia Teste" } },
    select: { id: true, nome: true },
    orderBy: { nome: "asc" },
  });
  const farmaciaIds = farmacias.map((f) => f.id);
  if (farmaciaIds.length < 2) return [];

  // includeOutOfStock=true porque o destino em ruptura pode ter
  // stockAtual=0. A origem precisa de ter stock para ser candidata —
  // o filtro final acontece em findInternalSubstitutions.
  const { pfRows, salesMap } = await loadPfAndSales(farmaciaIds, {
    includeOutOfStock: true,
  });

  const input = pfRows.map((p) => ({
    produtoId: p.produtoId,
    farmaciaId: p.farmaciaId,
    farmaciaNome: p.farmaciaNome,
    cnp: p.cnp,
    designacao: p.designacao,
    stockAtual: Number(p.stockAtual),
    puc: p.puc,
    salesQty: salesMap.get(`${p.produtoId}:${p.farmaciaId}`) ?? 0,
  }));

  return findInternalSubstitutions(input, options);
}
