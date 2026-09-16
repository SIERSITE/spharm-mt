/**
 * lib/vendas-data.ts
 * Server-side data fetching para a página Vendas.
 *
 * ─── FECHO 2026-08: a janela passa a ter DIAS ────────────────────────────────
 *
 * Até aqui o loader lia `from`/`to` com um regex `^(\d{4})-(\d{2})` e deitava
 * o dia fora. Duas consequências, ambas confirmadas em produção:
 *
 *   · `01/08→17/08` e `01/08→31/08` devolviam o mesmo — o índice de mês era
 *     idêntico. Mudar as datas dentro do mesmo mês não mudava nada.
 *   · o período DEVOLVIDO era o mês inteiro, e a UI acreditava nele: a média
 *     diária dividia por 31 dias uma janela de 17.
 *
 * Agora a janela é de dias (ver `lib/vendas/janela.ts`) e a FONTE é escolhida
 * por equivalência semântica, não por conveniência:
 *
 *   janela mês-alinhada  → `VendaMensal` (a mesma soma, já feita, barata)
 *   janela parcial       → `IngestVendaLinhaRaw` (a única com dia)
 *
 * Sem rateio do mês. `VendaMensal` não tem dias e nenhuma aritmética lhos dá.
 *
 * ─── Sinal e universo ────────────────────────────────────────────────────────
 *
 * Os dois caminhos usam os fragmentos de `lib/aggregate/vendamensal.ts` —
 * VENDA soma, DEVOLUCAO_ANULACAO subtrai, UNKNOWN e serviços sem stock ficam
 * de fora. Era aqui que estava o segundo desvio: o loader somava
 * `vm.quantidade` (não assinado) e descartava com `HAVING > 0` os produtos de
 * saldo líquido negativo, inflando o total. Na Silveirense, Agosto/2026, isso
 * dava 6936 unidades onde o ledger tem 6931.
 *
 * Filtros suportados (canónicos via `SharedReportFilters`):
 *   farmaciaNomes, from, to, categorias, subcategorias, utilizacoes,
 *   fabricantes, distribuidores, pesquisa, apenasSemClassif, apenasComStock.
 *
 * Pré-filtros de produto correm SQL-side antes do pivot — mesma estratégia de
 * Margens, para não puxar produtos que vão ser descartados a seguir.
 *
 * ─── `apenasComStock`: união com ProdutoFarmacia, não filtro (2026-09) ──────
 *
 * O universo desta função nasce SEMPRE do ledger de vendas (`VendaMensal`/
 * `IngestVendaLinhaRaw`) — um produto sem qualquer venda líquida no período
 * nunca chega a `aggRows`, `HAVING <> 0` obriga a isso. Um filtro aplicado
 * DEPOIS (`existencia > 0`) só consegue ESTREITAR esse universo — nunca
 * alargá-lo — e foi exactamente isso que a página fazia client-side antes
 * desta correcção: "Apenas com stock" comportava-se como
 * `vendas > 0 AND stock > 0`, quando o pedido sempre foi
 * `vendas > 0 OR stock > 0`.
 *
 * A correcção tem de ser aqui, na origem do universo: quando
 * `apenasComStock` está activo, além dos pares (produto, farmácia) que já
 * vieram do ledger, procura-se em `ProdutoFarmacia` os pares com
 * `stockAtual > 0` que NÃO têm venda no período — respeitando os mesmos
 * pré-filtros de produto (categoria/fabricante/pesquisa/catálogo) e o mesmo
 * filtro de farmácia/distribuidor — e sintetiza-se uma linha para cada um,
 * com `meses`/`totalVendas` a ZERO (nunca inventados) e o resto dos campos
 * (PVP, custo, descrição, fabricante, farmácia) preenchidos a partir de
 * `Produto`/`ProdutoFarmacia`, exactamente como qualquer outra linha.
 */
import { getPrisma } from "@/lib/prisma";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { resolverPar } from "@/lib/categoria-resolver";
import { custoDaFarmacia, valorizar } from "@/lib/produtos/custo-farmacia";
import {
  restringirPorCatalogo,
  restringirSemClassificacao,
  temFiltroCatalogo,
} from "@/lib/reporting/catalog-prefilter";
import type { SharedReportFilters } from "@/lib/reporting/filters-shared";
import { naturezasIncluidas } from "@/lib/reporting/natureza-venda";
import { construirCondicaoPesquisa } from "@/lib/reporting/pesquisa-produto";
import {
  SQL_LINHAS_ELEGIVEIS,
  SQL_QUANTIDADE_ASSINADA,
  SQL_VALOR_BRUTO_ASSINADO,
} from "@/lib/aggregate/vendamensal";
import {
  bucketsDaJanela,
  decomporJanela,
  diaSeguinte,
  normalizarJanela,
  type JanelaVendas,
} from "@/lib/vendas/janela";

/** Linha por (CNP × farmácia) com vendas decompostas por mês no período. */
export type SalesMonthBucket = {
  /** Ano calendário (ex: 2026). */
  ano: number;
  /** Mês 1-12. */
  mes: number;
  /** Unidades vendidas no mês (já arredondado a inteiro). */
  quantidade: number;
};

export type SalesReportRow = {
  codigo: string;
  descricao: string;
  pvp: number;
  /** Buckets mês-a-mês na ordem cronológica do período seleccionado. */
  meses: SalesMonthBucket[];
  /** Soma das `meses[].quantidade`. */
  totalVendas: number;
  /**
   * Valor bruto assinado da janela — PVP × quantidade AO PREÇO DA VENDA,
   * somado a partir do ledger.
   *
   * Existe porque a UI calculava o total em euros como
   * `totalVendas × pvp`, com `pvp` a vir de `ProdutoFarmacia` — o preço
   * de hoje na prateleira. Isso reprecifica o histórico: em Agosto/2026
   * na Silveirense dava 98 952,93 € onde o ledger tem 98 829,51 €.
   */
  valorBruto: number;
  existencia: number;
  /**
   * Custo unitário ESTIMADO, sem IVA. `null` quando desconhecido.
   *
   * ── Porque «estimado», e porque o nome tem de o dizer ──────────────
   *
   * É o PMC (ou PUC em recurso) que a ficha `ProdutoFarmacia` tem HOJE.
   * Não é o custo daquelas unidades no dia em que foram vendidas: uma
   * venda de Janeiro mostrada com o PMC de Setembro é o custo errado
   * com ar de certo.
   *
   * Não há alternativa nos dados. O ledger de vendas
   * (`IngestVendaLinhaRaw` → `VendaMensal`) não tem coluna de custo
   * nenhuma, e o `Venda.custoUnitario` do schema tem 0 linhas em
   * produção — é resíduo da era do import por Excel.
   *
   * Medido no ledger de movimentos, que é onde havia esperança:
   * `MovimentoArtigo.custoUnitario` está a 0 em TODOS os 3 380 464
   * movimentos de VENDA. O ERP regista custo nas ENTRADAS (COMPRA:
   * 100 %, ACERTO_STOCK: 99,5 %) e não nas saídas.
   *
   * O caminho para custo histórico real existe e fica registado:
   * `MovimentoArtigo.pmcNovo` está preenchido em 98,0 % dos movimentos
   * de venda e é o PMC que vigorava NAQUELE dia. Usá-lo exige activar
   * `Farmacia.useMovimentosCanonical`, hoje `false` nas cinco farmácias,
   * e isso tem gates próprios. Não é esta fase.
   *
   * A regra é a partilhada de `lib/produtos/custo-farmacia.ts`:
   * PMC>0 → PUC>0 → `null`. Zero nunca é custo — o ERP escreve 0 tanto
   * para «não sei» como para «é zero».
   */
  custoUnitarioEstimado: number | null;
  /**
   * `totalVendas × custoUnitarioEstimado`. `null` quando o custo é
   * desconhecido — nunca 0, que somaria em silêncio e daria um total
   * curto que ninguém consegue auditar.
   */
  custoEstimado: number | null;
  /** Alias legado de totalVendas — preservado para callers existentes. */
  unidadesVendidas: number;
  fornecedor: string;
  fabricante: string;
  /** Nível 1 canónico, ou "Por Classificar". */
  categoria: string;
  /** Nível 2 canónico estrito, ou "" — é o que o filtro usa. */
  subcategoria: string;
  /** Slugs das utilizações do produto. */
  utilizacoes: string[];
  farmacia: string;
  /**
   * Chave de agregação "Agrupar por: grupo". N2 com queda para N1 —
   * semântica antiga, preservada de propósito. Para FILTRAR use
   * `subcategoria`.
   */
  grupo: string;
};

/**
 * Header do período devolvido junto com as linhas — permite à UI e ao
 * adapter de exportação saberem **quais** meses esperar em cada `row.meses`,
 * sem precisarem de inferir a partir das datas.
 */
export type SalesPeriodHeader = {
  /** Início efectivo aplicado (ISO yyyy-mm-dd), inclusivo. */
  from: string;
  /**
   * Fim efectivo aplicado (ISO yyyy-mm-dd), INCLUSIVO e igual ao dia
   * pedido. Já não é esticado ao fim do mês: era essa esticadela que
   * fazia a média diária dividir por dias que o utilizador não pediu.
   */
  to: string;
  /** Lista de buckets na mesma ordem que aparece em `row.meses`. */
  buckets: { ano: number; mes: number }[];
  /**
   * De onde saíram os números desta resposta. Visível de propósito: um
   * relatório que muda de fonte conforme a janela tem de conseguir
   * dizê-lo, senão uma divergência entre duas janelas parece um bug de
   * dados quando é uma diferença de caminho.
   */
  fonte: "VENDA_MENSAL" | "LINHAS_RAW" | "MISTA";
};

export type SalesReportResult = {
  period: SalesPeriodHeader;
  rows: SalesReportRow[];
};

function toF(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function getVendasData(
  filters: SharedReportFilters = {},
  /**
   * Injecção opcional de `PrismaClient` — mesmo padrão de
   * `applyAuthoritativeManufacturerCorrections` em `lib/catalog-persistence.ts`.
   * Nunca usado em produção (o singleton do tenant é sempre o caminho
   * real); existe para os testes conseguirem exercitar esta função com
   * um Prisma falso, sem BD viva. Ver `scripts/tests/test-vendas-apenas-com-stock.ts`.
   */
  prismaOverride?: PrismaClient,
): Promise<SalesReportResult> {
  const prisma = prismaOverride ?? (await getPrisma());

  // ── Janela: dias civis, ambas as pontas inclusivas ──────────────────
  const janela = normalizarJanela(filters.from, filters.to);
  const buckets = bucketsDaJanela(janela);
  const decomposta = decomporJanela(janela);
  const period: SalesPeriodHeader = {
    from: janela.from,
    to: janela.to,
    buckets,
    fonte:
      decomposta.parciais.length === 0
        ? "VENDA_MENSAL"
        : decomposta.mesesInteiros
          ? "MISTA"
          : "LINHAS_RAW",
  };

  if (buckets.length === 0) {
    return { period, rows: [] };
  }

  // ── Farmácias activas (filtradas cedo pelos nomes pedidos) ──────────
  const farmacias = await prisma.farmacia.findMany({
    where: {
      estado: "ATIVO",
      nome: {
        not: "Farmácia Teste",
        ...(filters.farmaciaNomes && filters.farmaciaNomes.length > 0
          ? { in: filters.farmaciaNomes }
          : {}),
      },
    },
    select: { id: true, nome: true },
  });
  const farmaciaIds = farmacias.map((f) => f.id);
  const farmaciaNameById = new Map(farmacias.map((f) => [f.id, f.nome]));
  if (farmaciaIds.length === 0) return { period, rows: [] };

  // ── Pré-filtros de produto (categorias / fabricantes / semClassif /
  //    pesquisa). Mesmo padrão de lib/margens-data.ts:189-232. Encolhe
  //    o universo antes do pivot pesado em VendaMensal.
  let produtoIdFilter: string[] | null = null;
  if (filters.categorias && filters.categorias.length > 0) {
    const classifs = await prisma.classificacao.findMany({
      where: { tipo: "NIVEL_1", estado: "ATIVO", nome: { in: filters.categorias } },
      select: { id: true },
    });
    const classifIds = classifs.map((c) => c.id);
    if (classifIds.length === 0) return { period, rows: [] };
    const produtos = await prisma.produto.findMany({
      where: { classificacaoNivel1Id: { in: classifIds } },
      select: { id: true },
    });
    produtoIdFilter = produtos.map((p) => p.id);
    if (produtoIdFilter.length === 0) return { period, rows: [] };
  }
  if (filters.apenasSemClassif) {
    // Helper central: o mesmo `where` estava escrito em tres loaders, e
    // faltava-lhe a mesma condicao nos tres — os codigos internos do ERP.
    // Ver lib/reporting/catalog-prefilter.ts.
    produtoIdFilter = await restringirSemClassificacao(prisma, produtoIdFilter);
    if (produtoIdFilter.length === 0) return { period, rows: [] };
  }
  if (filters.fabricantes && filters.fabricantes.length > 0) {
    const fabs = await prisma.fabricante.findMany({
      where: { nomeNormalizado: { in: filters.fabricantes }, estado: "ATIVO" },
      select: { id: true },
    });
    const fabIds = fabs.map((f) => f.id);
    if (fabIds.length === 0) return { period, rows: [] };
    const produtos = await prisma.produto.findMany({
      where: {
        fabricanteId: { in: fabIds },
        ...(produtoIdFilter ? { id: { in: produtoIdFilter } } : {}),
      },
      select: { id: true },
    });
    produtoIdFilter = produtos.map((p) => p.id);
    if (produtoIdFilter.length === 0) return { period, rows: [] };
  }
  // Lista de CNP importada, subcategoria (N2) e utilizacao —
  // mesmo padrao, helper partilhado. A lista entra por aqui e nao
  // por um ramo proprio: e' o que faz os tres relatorios ganharem-na
  // sem nenhum deles a conhecer. Ver lib/reporting/catalog-prefilter.ts.
  if (temFiltroCatalogo(filters)) {
    produtoIdFilter = await restringirPorCatalogo(prisma, filters, produtoIdFilter);
    if (produtoIdFilter && produtoIdFilter.length === 0) return { period, rows: [] };
  }
  // Pesquisa por CNP (exacto OU parcial) ou designação — MESMA regra que
  // Margens (`construirCondicaoPesquisa`, lib/reporting/pesquisa-produto.ts).
  // Antes desta correcção (2026-09), Vendas reimplementava esta pesquisa à
  // mão com `prisma.produto.findMany` e só encontrava o CNP por igualdade
  // EXACTA (`cnp: asNumber`) — escrever metade do código não encontrava
  // nada, o mesmo problema que Margens já tinha corrigido no seu próprio
  // loader. `$queryRaw` (em vez de `findMany`) é o que permite `cnp::text
  // LIKE`, que o query-builder do Prisma Client não expõe para um campo Int.
  if (filters.pesquisa && filters.pesquisa.trim()) {
    const pesquisaCond = construirCondicaoPesquisa(filters.pesquisa);
    const produtos = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT p.id FROM "Produto" p
      WHERE 1 = 1
        ${pesquisaCond}
        ${produtoIdFilter ? Prisma.sql`AND p.id = ANY(${produtoIdFilter})` : Prisma.empty}
    `);
    produtoIdFilter = produtos.map((p) => p.id);
    if (produtoIdFilter.length === 0) return { period, rows: [] };
  }
  // Distribuidor (fornecedorOrigem em PF) — corre via filtro em PF mais
  // abaixo (não pré-encolhe Produto, porque mesmo produto pode ter
  // distribuidor diferente por farmácia).

  // ── Query principal ─────────────────────────────────────────────────
  //
  // Um de dois caminhos, escolhido por `mesAlinhada`. Ambos devolvem o
  // MESMO shape (produto × farmácia × mês, com sinal) e, para uma janela
  // mês-alinhada, os MESMOS números — é isso que o teste de
  // reconciliação fixa.
  //
  // `HAVING ... <> 0` e não `> 0`: um produto com mais devoluções que
  // vendas na janela tem saldo líquido negativo e é informação
  // operacional real. Descartá-lo fazia o total do relatório não bater
  // com a soma do seu próprio universo.
  type AggRow = {
    produtoId: string;
    farmaciaId: string;
    ano: number;
    mes: number;
    quantidade: number;
    valorBruto: number;
  };
  // Os dois interruptores do relatório oficial. A MESMA lista nos dois
  // caminhos: se divergissem, um período que atravessa o início de um mês
  // somava populações diferentes de cada lado da fronteira.
  const naturezas = naturezasIncluidas(filters);

  const mensal = (minIdx: number, maxIdx: number) =>
    prisma.$queryRaw<AggRow[]>(Prisma.sql`
      SELECT
        vm."produtoId",
        vm."farmaciaId",
        vm.ano,
        vm.mes,
        SUM(COALESCE(vm."quantidadeLiquida", vm.quantidade))::float AS quantidade,
        SUM(COALESCE(vm."valorBruto", 0))::float AS "valorBruto"
      FROM "VendaMensal" vm
      WHERE
        vm."farmaciaId" = ANY(${farmaciaIds})
        AND vm."naturezaVenda" = ANY(${naturezas})
        AND (vm.ano * 12 + vm.mes) BETWEEN ${minIdx} AND ${maxIdx}
        ${
          produtoIdFilter
            ? Prisma.sql`AND vm."produtoId" = ANY(${produtoIdFilter})`
            : Prisma.empty
        }
      GROUP BY vm."produtoId", vm."farmaciaId", vm.ano, vm.mes
      HAVING SUM(COALESCE(vm."quantidadeLiquida", vm.quantidade)) <> 0
    `);

  // Sem alias na tabela porque os fragmentos partilhados usam nomes de
  // coluna sem prefixo — é o que garante que este SQL e o da agregação
  // mensal são literalmente o mesmo. Índice: ("farmaciaId", "dataVenda").
  const porLinhas = (j: JanelaVendas) =>
    prisma.$queryRaw<AggRow[]>(Prisma.sql`
      SELECT
        "produtoId",
        "farmaciaId",
        EXTRACT(YEAR  FROM "dataVenda")::int AS ano,
        EXTRACT(MONTH FROM "dataVenda")::int AS mes,
        SUM(${SQL_QUANTIDADE_ASSINADA})::float  AS quantidade,
        SUM(${SQL_VALOR_BRUTO_ASSINADO})::float AS "valorBruto"
      FROM "IngestVendaLinhaRaw"
      WHERE
        "farmaciaId" = ANY(${farmaciaIds})
        AND "dataVenda" >= ${`${j.from}T00:00:00.000Z`}::timestamptz
        AND "dataVenda" <  ${`${diaSeguinte(j.to)}T00:00:00.000Z`}::timestamptz
        AND "naturezaVenda" = ANY(${naturezas})
        AND ${SQL_LINHAS_ELEGIVEIS}
        ${
          produtoIdFilter
            ? Prisma.sql`AND "produtoId" = ANY(${produtoIdFilter})`
            : Prisma.empty
        }
      GROUP BY "produtoId", "farmaciaId", 3, 4
      HAVING SUM(${SQL_QUANTIDADE_ASSINADA}) <> 0
    `);

  // Cada mês pertence a exactamente uma das partes — concatenar não
  // duplica nada. Em paralelo: são no máximo três consultas disjuntas.
  const partes = await Promise.all([
    decomposta.mesesInteiros
      ? mensal(decomposta.mesesInteiros.minIdx, decomposta.mesesInteiros.maxIdx)
      : Promise.resolve([] as AggRow[]),
    ...decomposta.parciais.map(porLinhas),
  ]);
  const aggRows = partes.flat();

  // Com `apenasComStock` activo, um universo vazio de VENDAS não implica
  // um relatório vazio — pode haver produtos só com stock. O corte cedo
  // fica reservado ao caso normal (sem essa opção), onde continua a
  // significar exactamente o que sempre significou.
  if (aggRows.length === 0 && !filters.apenasComStock) {
    return { period, rows: [] };
  }

  // ── Agrupa por (produtoId, farmaciaId) e indexa cada mês ──────────
  type Acc = {
    produtoId: string;
    farmaciaId: string;
    byBucket: Map<string, number>;
    total: number;
    valorBruto: number;
  };
  const bucketKey = (ano: number, mes: number) => `${ano}-${mes}`;
  const accByKey = new Map<string, Acc>();
  for (const r of aggRows) {
    const key = `${r.produtoId}:${r.farmaciaId}`;
    let acc = accByKey.get(key);
    if (!acc) {
      acc = {
        produtoId: r.produtoId,
        farmaciaId: r.farmaciaId,
        byBucket: new Map(),
        total: 0,
        valorBruto: 0,
      };
      accByKey.set(key, acc);
    }
    const q = Math.round(toF(r.quantidade));
    const bk = bucketKey(r.ano, r.mes);
    // `+=` e não `set`: as partes da janela são disjuntas por mês, mas
    // acumular é a operação certa e não depende dessa invariante.
    acc.byBucket.set(bk, (acc.byBucket.get(bk) ?? 0) + q);
    acc.total += q;
    acc.valorBruto += toF(r.valorBruto);
  }

  // ── Metadata do produto (canónica) + ProdutoFarmacia (PVP/stock/origem)
  const produtoIds = [...new Set(Array.from(accByKey.values()).map((a) => a.produtoId))];
  const produtos = await prisma.produto.findMany({
    where: { id: { in: produtoIds } },
    select: {
      id: true,
      cnp: true,
      designacao: true,
      fabricante: { select: { nomeNormalizado: true } },
      classificacaoNivel1: { select: { nome: true } },
      classificacaoNivel2: { select: { nome: true } },
      // Uma ida à base para os produtos todos — não uma por produto.
      utilizacoes: { select: { utilizacao: { select: { slug: true } } } },
    },
  });
  const produtoById = new Map(produtos.map((p) => [p.id, p]));

  const pfWhere: Prisma.ProdutoFarmaciaWhereInput = {
    produtoId: { in: produtoIds },
    farmaciaId: { in: farmaciaIds },
  };
  if (filters.distribuidores && filters.distribuidores.length > 0) {
    pfWhere.fornecedorOrigem = { in: filters.distribuidores };
  }
  const pfRecords = await prisma.produtoFarmacia.findMany({
    where: pfWhere,
    select: {
      produtoId: true,
      farmaciaId: true,
      stockAtual: true,
      pvp: true,
      pmc: true,
      // O PUC é o recurso quando não há PMC — a mesma cascata do
      // Inventário, dos Excessos e da ficha do produto.
      puc: true,
      categoriaOrigem: true,
      subcategoriaOrigem: true,
      fornecedorOrigem: true,
    },
  });
  const pfByKey = new Map(pfRecords.map((r) => [`${r.produtoId}:${r.farmaciaId}`, r]));

  // Quando há filtro de distribuidor, descarta acc cujos pares
  // (produto, farmácia) não estão em pfByKey (i.e., não correspondem ao
  // distribuidor seleccionado naquela farmácia).
  const distribuidorFilterActive =
    !!filters.distribuidores && filters.distribuidores.length > 0;

  const rows: SalesReportRow[] = [];
  for (const acc of accByKey.values()) {
    const produto = produtoById.get(acc.produtoId);
    if (!produto) continue;
    const pf = pfByKey.get(`${acc.produtoId}:${acc.farmaciaId}`);
    if (distribuidorFilterActive && !pf) continue;
    const farmaciaNome = farmaciaNameById.get(acc.farmaciaId) ?? "—";

    const meses: SalesMonthBucket[] = buckets.map((b) => ({
      ano: b.ano,
      mes: b.mes,
      quantidade: acc.byBucket.get(bucketKey(b.ano, b.mes)) ?? 0,
    }));
    const totalVendas = meses.reduce((s, m) => s + m.quantidade, 0);

    const pvp = toF(pf?.pvp ?? pf?.pmc ?? 0);
    const existencia = Math.round(toF(pf?.stockAtual ?? 0));

    // Custo ESTIMADO — ver `SalesReportRow.custoUnitarioEstimado`.
    const custoUnitarioEstimado = custoDaFarmacia(
      pf?.pmc != null ? Number(pf.pmc) : null,
      pf?.puc != null ? Number(pf.puc) : null,
    ).valor;
    // Sobre as unidades LÍQUIDAS do período, que é o que `totalVendas`
    // já é: uma devolução desconta a venda e tem de descontar o custo.
    const custoEstimado = valorizar(totalVendas, custoUnitarioEstimado);

    const { categoria, subcategoria } = resolverPar({
      classificacaoNivel1: produto.classificacaoNivel1,
      classificacaoNivel2: produto.classificacaoNivel2,
    });
    // `grupo` mantém a semântica antiga (N2 com queda para N1) porque é a
    // chave de agregação "Agrupar por: grupo" — mudá-la mudava relatórios
    // que já circulam. `subcategoria` é o nível 2 estrito, para filtrar.
    const grupo = subcategoria || categoria;
    const fornecedor = pf?.fornecedorOrigem ?? "";
    const fabricante = produto.fabricante?.nomeNormalizado ?? "";

    rows.push({
      codigo: String(produto.cnp),
      descricao: produto.designacao,
      pvp,
      meses,
      totalVendas,
      valorBruto: acc.valorBruto,
      existencia,
      custoUnitarioEstimado,
      custoEstimado,
      unidadesVendidas: totalVendas,
      fornecedor,
      fabricante,
      categoria,
      subcategoria,
      utilizacoes: produto.utilizacoes.map((u) => u.utilizacao.slug),
      farmacia: farmaciaNome,
      grupo,
    });
  }

  // ── `apenasComStock`: UNIÃO com produtos só de stock (sem venda) ─────
  //
  // Mesmos pré-filtros de produto (`produtoIdFilter`) e as mesmas
  // farmácias/distribuidor de `pfWhere` — nunca um universo à parte.
  // Só entram pares (produto, farmácia) que `accByKey` ainda não tem:
  // um par com venda já ganhou a sua linha real no loop acima, e não
  // pode duplicar-se aqui com uma cópia "sem vendas".
  if (filters.apenasComStock) {
    const stockWhere: Prisma.ProdutoFarmaciaWhereInput = {
      farmaciaId: { in: farmaciaIds },
      stockAtual: { gt: 0 },
      ...(produtoIdFilter ? { produtoId: { in: produtoIdFilter } } : {}),
    };
    if (filters.distribuidores && filters.distribuidores.length > 0) {
      stockWhere.fornecedorOrigem = { in: filters.distribuidores };
    }
    const stockPfRecords = await prisma.produtoFarmacia.findMany({
      where: stockWhere,
      select: {
        produtoId: true,
        farmaciaId: true,
        stockAtual: true,
        pvp: true,
        pmc: true,
        puc: true,
        fornecedorOrigem: true,
      },
    });
    const stockOnly = stockPfRecords.filter(
      (r) => !accByKey.has(`${r.produtoId}:${r.farmaciaId}`),
    );

    if (stockOnly.length > 0) {
      // Metadata do produto para os que ainda não vieram na primeira
      // ida (produtos sem qualquer venda no período não estavam em
      // `produtoIds`, que nasce de `accByKey`).
      const idsEmFalta = [...new Set(stockOnly.map((r) => r.produtoId))].filter(
        (id) => !produtoById.has(id),
      );
      if (idsEmFalta.length > 0) {
        const maisProdutos = await prisma.produto.findMany({
          where: { id: { in: idsEmFalta } },
          select: {
            id: true,
            cnp: true,
            designacao: true,
            fabricante: { select: { nomeNormalizado: true } },
            classificacaoNivel1: { select: { nome: true } },
            classificacaoNivel2: { select: { nome: true } },
            utilizacoes: { select: { utilizacao: { select: { slug: true } } } },
          },
        });
        for (const p of maisProdutos) produtoById.set(p.id, p);
      }

      for (const pf of stockOnly) {
        const produto = produtoById.get(pf.produtoId);
        if (!produto) continue;
        const farmaciaNome = farmaciaNameById.get(pf.farmaciaId) ?? "—";

        // Sem venda no período — os meses ficam a zero por CONSTRUÇÃO,
        // nunca inventados: não há `acc`/`byBucket` nenhum para este
        // par, por isso não há nada a somar.
        const meses: SalesMonthBucket[] = buckets.map((b) => ({
          ano: b.ano,
          mes: b.mes,
          quantidade: 0,
        }));
        const totalVendas = 0;

        const pvp = toF(pf.pvp ?? pf.pmc ?? 0);
        const existencia = Math.round(toF(pf.stockAtual ?? 0));
        const custoUnitarioEstimado = custoDaFarmacia(
          pf.pmc != null ? Number(pf.pmc) : null,
          pf.puc != null ? Number(pf.puc) : null,
        ).valor;
        // Mesma fórmula da linha com vendas — `valorizar(0, custo)` dá
        // 0 quando o custo é conhecido e `null` quando não é, sem
        // nenhum caso especial para "linha só de stock".
        const custoEstimado = valorizar(totalVendas, custoUnitarioEstimado);

        const { categoria, subcategoria } = resolverPar({
          classificacaoNivel1: produto.classificacaoNivel1,
          classificacaoNivel2: produto.classificacaoNivel2,
        });
        const grupo = subcategoria || categoria;
        const fornecedor = pf.fornecedorOrigem ?? "";
        const fabricante = produto.fabricante?.nomeNormalizado ?? "";

        rows.push({
          codigo: String(produto.cnp),
          descricao: produto.designacao,
          pvp,
          meses,
          totalVendas,
          valorBruto: 0,
          existencia,
          custoUnitarioEstimado,
          custoEstimado,
          unidadesVendidas: totalVendas,
          fornecedor,
          fabricante,
          categoria,
          subcategoria,
          utilizacoes: produto.utilizacoes.map((u) => u.utilizacao.slug),
          farmacia: farmaciaNome,
          grupo,
        });
      }
    }
  }

  // Ordenação default: mais vendidos primeiro. UI pode reordenar.
  rows.sort((a, b) => b.totalVendas - a.totalVendas);
  return { period, rows };
}
