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
import { getOperationalPolicy, reservaOrigemDias } from "@/lib/operational/policy";
import { resolveCurrentTenantSlug } from "@/lib/tenant-context";
import {
  avaliarLinha,
  ehAccionavel,
  emparelhar,
  type Emparelhamento,
  type EstadoStock,
  type ParametrosMotor,
} from "@/lib/operational/motor-stock";
import {
  findInternalSubstitutions,
  type InternalSubstitution,
  type SubstitutionOptions,
} from "@/lib/transfers/internal-substitution";
import {
  diasDaJanela,
  janelaMesesAte,
  janelaParaIndicesMensais,
  mesesDaJanela,
  normalizarJanela,
  type JanelaMeses,
} from "@/lib/operational/janela-meses";

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
  /**
   * Unidades vendidas NESTA farmácia nos 6 meses civis completos até à
   * data-fim do relatório. Contexto de rotação, nada mais: não entra em
   * nenhuma fórmula de excesso, necessidade, sugestão ou prioridade.
   */
  vendas6M: number;
  /** `vendas6M / 6`, uma casa decimal. Também só informativo. */
  mediaMensal6M: number;
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
/**
 * Opções partilhadas por /excessos e /transferencias.
 *
 * O nome antigo (`ExcessosOptions`) fica exportado mais abaixo: os dois
 * relatórios passaram a aceitar exactamente as mesmas opções, porque
 * passaram a correr sobre o mesmo motor.
 */
export type OpcoesOperacionais = {
  /**
   * Coverage threshold in days; products with coverage > thresholdDays are
   * excess. Por omissão vem da POLICY DA FARMÁCIA — ver
   * `lib/operational/policy.ts`. Passá-lo explicitamente serve para
   * diagnósticos e testes; a UI nunca o passa.
   */
  thresholdDays?: number;
  /** Cobertura-alvo. Por omissão vem da policy da farmácia. */
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

/** Nome antigo. Mantido para não partir chamadores. */
export type ExcessosOptions = OpcoesOperacionais;

/** Uma linha do loader, já com as vendas das duas janelas coladas. */
type LinhaPf = PfBase & { vendasJanela: number; vendas6M: number };

/**
 * Soma de `VendaMensal` por (produto, farmácia) numa janela.
 *
 * UMA query agregada para o relatório inteiro — não uma por linha. É a
 * mesma forma da agregação que `loadPfAndSales` já faz para a janela
 * principal; vive à parte porque a janela dos 6 meses é outra e não se
 * quis mexer num loader partilhado por /stock, /transferencias, o
 * dashboard e a substituição interna.
 *
 * O custo acrescentado ao relatório é um round-trip, independentemente
 * de haver 500 ou 50 000 produtos.
 */
async function somarVendasNaJanela(
  farmaciaIds: string[],
  janela: JanelaMeses,
): Promise<Map<string, number>> {
  const prisma = await getPrisma();
  const { inicioIndice, fimExclusivo } = janelaParaIndicesMensais(janela);
  const linhas = await prisma.$queryRaw<
    Array<{ produtoId: string; farmaciaId: string; totalQty: number }>
  >(Prisma.sql`
    SELECT
      vm."produtoId",
      vm."farmaciaId",
      SUM(vm.quantidade)::float AS "totalQty"
    FROM "VendaMensal" vm
    WHERE
      (vm.ano * 12 + vm.mes) >= ${inicioIndice}
      AND (vm.ano * 12 + vm.mes) < ${fimExclusivo}
      AND vm."farmaciaId" = ANY(${farmaciaIds})
    GROUP BY vm."produtoId", vm."farmaciaId"
  `);
  const mapa = new Map<string, number>();
  for (const l of linhas) mapa.set(`${l.produtoId}:${l.farmaciaId}`, toF(l.totalQty));
  return mapa;
}

/**
 * O carregamento comum aos dois relatórios.
 *
 * Uma janela, uma query de vendas, um motor. Antes disto, /excessos lia
 * `VendaMensal` na janela escolhida e /transferencias lia o IPF de 90
 * dias — dois consumos diferentes para o mesmo artigo no mesmo dia.
 */
async function carregarEstadosOperacionais(options?: OpcoesOperacionais): Promise<{
  janela: JanelaMeses;
  /** Janela de contexto da coluna "Vendas 6M". */
  janela6M: JanelaMeses;
  params: ParametrosMotor;
  grupos: Map<string, EstadoStock<LinhaPf>[]>;
}> {
  // A calibração da FARMÁCIA, não uma constante global. Fora de um
  // request o slug é null e cai nos defaults — que é o comportamento
  // certo para um script que não disse com quem está a falar.
  const policy = getOperationalPolicy(await resolveCurrentTenantSlug());

  const thresholdDays = options?.thresholdDays ?? policy.excesso.thresholdDias;
  const targetDays = options?.targetDays ?? policy.excesso.targetDias;
  const janela = normalizarJanela(options?.dataInicio, options?.dataFim);
  const params: ParametrosMotor = {
    diasJanela: diasDaJanela(janela),
    thresholdDays,
    targetDays,
    // O corte comercial que já existia nos Excessos: abaixo deste número
    // de unidades a "sobra" é ruído de arredondamento.
    excessoMinimo: policy.excesso.minimoUnidades,
    // A reserva da origem. Derivada do alvo EFECTIVO — se o chamador
    // passou um `targetDays` próprio (diagnósticos), a reserva
    // acompanha-o, senão a regra que o excesso já promete deixava de
    // ser cumprida. Sem ela, o `Math.round` do excesso podia entregar o
    // stock inteiro de um artigo de baixa rotação.
    reservaDias: reservaOrigemDias({ ...policy, excesso: { ...policy.excesso, targetDias: targetDays } }),
  };

  const grupos = new Map<string, EstadoStock<LinhaPf>[]>();

  const prisma = await getPrisma();
  const farmacias = await prisma.farmacia.findMany({
    where: { estado: "ATIVO", nome: { not: "Farmácia Teste" } },
    select: { id: true, nome: true },
    orderBy: { nome: "asc" },
  });
  const farmaciaIds = farmacias.map((f) => f.id);
  const janelaVazia = janelaMesesAte(janela.fim, 6);
  if (farmaciaIds.length === 0) {
    return { janela, janela6M: janelaVazia, params, grupos };
  }

  // A janela dos 6 meses acompanha a data-fim ESCOLHIDA, e não o dia de
  // hoje: mudar o fim do relatório desloca as duas janelas em conjunto.
  const janela6M = janelaMesesAte(janela.fim, 6);

  const [{ pfRows, salesMap }, vendas6MMap] = await Promise.all([
    loadPfAndSales(farmaciaIds, { janela }),
    somarVendasNaJanela(farmaciaIds, janela6M),
  ]);

  for (const row of pfRows) {
    const chave = `${row.produtoId}:${row.farmaciaId}`;
    const vendasJanela = salesMap.get(chave) ?? 0;
    const vendas6M = vendas6MMap.get(chave) ?? 0;
    const estado = avaliarLinha<LinhaPf>({ ...row, vendasJanela, vendas6M }, params);
    const lista = grupos.get(row.produtoId);
    if (lista) lista.push(estado);
    else grupos.set(row.produtoId, [estado]);
  }

  return { janela, janela6M, params, grupos };
}

/**
 * Monta a linha do relatório a partir de uma origem e do seu par.
 *
 * Partilhada pelos dois ecrãs: as colunas são as mesmas, a diferença
 * está em QUE linhas cada relatório deixa passar — não em como as
 * apresenta.
 */
function montarLinha(
  par: Emparelhamento<LinhaPf>,
  prioridade: Priority,
  observacao: string,
  mesesContexto: number,
): TransferSuggestionRow {
  const origem = par.origem;
  const destino = par.destino;
  return {
    cnp: origem.cnp,
    produto: origem.designacao,
    farmaciaOrigem: origem.farmaciaNome,
    // Vazio, e não "—" nem uma farmácia arbitrária: quando ninguém
    // precisa, não há destino possível. A UI mostra o travessão.
    farmaciaDestino: destino?.farmaciaNome ?? "",
    stockOrigem: Math.round(toF(origem.stockAtual)),
    stockDestino: destino ? Math.round(toF(destino.stockAtual)) : 0,
    coberturaOrigem: origem.coberturaDias === null ? 0 : Math.round(origem.coberturaDias),
    coberturaDestino:
      destino && destino.coberturaDias !== null ? Math.round(destino.coberturaDias) : 0,
    quantidadeSugerida: par.quantidadeSugerida,
    excessoOrigem: origem.excesso,
    necessidadeDestino: par.necessidadeDestino,
    // Contexto de rotação da ORIGEM — é dela que o stock sai.
    vendas6M: origem.vendas6M,
    mediaMensal6M:
      mesesContexto > 0 ? Math.round((origem.vendas6M / mesesContexto) * 10) / 10 : 0,
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
    observacao,
    // O valor libertado é o da quantidade que SE VAI MESMO transferir.
    // Com sugestão 0 não se liberta nada.
    valorUnlocked:
      origem.pvp != null && origem.pvp > 0 ? par.quantidadeSugerida * origem.pvp : 0,
    dci: origem.dci,
    codigoATC: origem.codigoATC,
    produtoId: origem.produtoId,
    farmaciaOrigemId: origem.farmaciaId,
    farmaciaDestinoId: destino?.farmaciaId ?? "",
  };
}

/**
 * TRANSFERÊNCIAS — o relatório OPERACIONAL.
 *
 * Subconjunto estrito dos Excessos: só entram as linhas onde existe
 * simultaneamente excesso na origem, necessidade no destino e uma
 * quantidade realizável depois da regra de segurança.
 *
 *   excessoOrigem > 0  E  necessidadeDestino > 0  E  sugestao > 0
 *
 * Responde a "que parte do stock a mais consigo aproveitar noutra
 * farmácia?". Quem responde a "que stock tenho a mais?" é /excessos, e
 * a resposta lá inclui os artigos que ninguém quer.
 *
 * ── O que mudou, e porquê ────────────────────────────────────────────
 *
 * A heurística anterior (rácio de cobertura 2.5:1, destino < 20 dias,
 * equalizar a 20 dias, IPF de 90 dias) era um segundo motor matemático,
 * com uma janela própria. Dava um número diferente do de /excessos para
 * o mesmo artigo no mesmo dia, e nenhum dos dois ecrãs dizia porquê.
 * Passa a ser o mesmo motor, a mesma janela e o mesmo objectivo de
 * cobertura dos Excessos.
 */
export async function getTransferenciasData(
  options?: OpcoesOperacionais,
): Promise<TransferSuggestionRow[]> {
  const { grupos, janela6M } = await carregarEstadosOperacionais(options);
  const mesesContexto = mesesDaJanela(janela6M);

  const result: TransferSuggestionRow[] = [];
  for (const [, grupo] of grupos) {
    // Sem duas farmácias não há transferência possível. Nos Excessos não
    // é assim: uma farmácia sozinha continua a poder ter stock a mais.
    if (grupo.length < 2) continue;

    for (const origem of grupo) {
      if (origem.excesso <= 0) continue;
      const par = emparelhar(origem, grupo);
      if (!ehAccionavel(par)) continue;

      const cobDestino = par.destino?.coberturaDias ?? 0;
      const prioridade: Priority =
        cobDestino < 7 ? "alta" : cobDestino < 14 ? "media" : "baixa";

      result.push(
        montarLinha(
          par,
          prioridade,
          prioridade === "alta"
            ? "Rutura previsível no destino, excesso confortável na origem."
            : prioridade === "media"
              ? "Transferência recomendada antes de reposição externa."
              : "Afinação opcional de cobertura.",
          mesesContexto,
        ),
      );
    }
  }

  const rank: Record<Priority, number> = { alta: 3, media: 2, baixa: 1 };
  result.sort(
    (a, b) => rank[b.prioridade] - rank[a.prioridade] || a.coberturaDestino - b.coberturaDestino,
  );
  return result.slice(0, 200);
}

/**
 * EXCESSOS — o relatório de DIAGNÓSTICO.
 *
 * Um critério, e só um:
 *
 *     excessoOrigem > 0
 *
 * O destino é informação ADICIONAL, nunca uma condição. Uma linha com
 * stock a mais e nenhuma farmácia interessada continua a ser um excesso
 * — é, aliás, o excesso mais caro, porque não há para onde o escoar. Sai
 * com `farmaciaDestino: ""`, `necessidadeDestino: 0` e
 * `quantidadeSugerida: 0`, e conta para os totais na mesma.
 */
export async function getExcessosData(
  options?: OpcoesOperacionais,
): Promise<TransferSuggestionRow[]> {
  const { params, grupos, janela6M } = await carregarEstadosOperacionais(options);
  const mesesContexto = mesesDaJanela(janela6M);

  const result: TransferSuggestionRow[] = [];
  for (const [, grupo] of grupos) {
    for (const origem of grupo) {
      if (origem.excesso <= 0) continue;

      const par = emparelhar(origem, grupo);
      const cobertura = origem.coberturaDias ?? 0;

      // Prioridade relativa ao threshold base — mantém a ordenação útil
      // qualquer que seja `thresholdDays` (default 120 ⇒ alta>240, media>180).
      const prioridade: Priority =
        cobertura > params.thresholdDays * 2
          ? "alta"
          : cobertura > params.thresholdDays * 1.5
            ? "media"
            : "baixa";

      result.push(
        montarLinha(
          par,
          prioridade,
          par.destino
            ? `Excesso de ${Math.round(cobertura)} dias de cobertura.`
            : `Excesso de ${Math.round(cobertura)} dias — nenhuma farmácia do grupo tem necessidade.`,
          mesesContexto,
        ),
      );
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
