import "server-only";
import { getPrisma } from "@/lib/prisma";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { resolveCategoria } from "@/lib/categoria-resolver";
import { avgDaily } from "@/lib/operational/metrics-shared";
import { temListaCodigos } from "@/lib/produtos/lista-codigos-tipos";
import {
  resumirListaImportada,
  type ResumoListaImportada,
} from "@/lib/encomendas/resumo-lista";
import { MAX_LINHAS_PROPOSTA } from "@/lib/encomendas/limites";

/**
 * Factor aplicado à cobertura alvo para calcular excedente transferível.
 * excedente = stockActual − avgDaily × coverageDays × EXCESSO_FACTOR
 * Centralizado aqui para parametrização futura.
 */
export const EXCESSO_FACTOR = 1.2;

/**
 * Reexportado: a regra vive em `resumo-lista.ts` (puro, testavel fora
 * do Next), mas o tipo pertence ao vocabulario da proposta e os
 * consumidores importam-no daqui.
 */
export type { ResumoListaImportada };
export { MAX_LINHAS_PROPOSTA };

export type ProposalBaseRule = "total" | "coverage";

export type ProposalFilters = {
  fabricantes?: string[];
  fornecedores?: string[];
  /** Nível 1 canónico. */
  categorias?: string[];
  /** Nível 2 canónico — nível DIFERENTE, não uma versão fina do nível 1. */
  subcategorias?: string[];
  /** Utilizações por SLUG. Produto entra se corresponder a QUALQUER uma. */
  utilizacoes?: string[];
  productTypes?: string[];
  /**
   * Lista de CNP importada por ficheiro. MESMO nome e MESMA semântica
   * que `SharedReportFilters.cnps` — é o que garante que o mesmo
   * ficheiro define o mesmo universo nos Relatórios e aqui.
   *
   *   · `undefined` → sem restrição
   *   · `[]`        → nenhum produto
   *   · não-vazio   → exactamente estes CNP
   *
   * Define o UNIVERSO de artigos. Não altera nenhuma regra de cálculo da
   * encomenda: cobertura, stock, pendentes e excedente continuam a ser
   * calculados exactamente como sem lista.
   */
  cnps?: number[];
};

export type ProposalInput = {
  farmaciaId: string;
  farmaciaNome?: string;
  startDate: Date;
  endDate: Date;
  considerStock: boolean;
  baseRule: ProposalBaseRule;
  targetCoverageDays: number;
  filters?: ProposalFilters;
};

export type GroupProposalInput = {
  farmaciaIds: string[];
  farmaciaNames: Record<string, string>;
  startDate: Date;
  endDate: Date;
  considerStock: boolean;
  baseRule: ProposalBaseRule;
  targetCoverageDays: number;
  filters?: ProposalFilters;
};

// ─── Estado e Motivo ─────────────────────────────────────────────────────────

export type ProposalEstado = "TRANSFERÊNCIA" | "COMPRAR" | "AGUARDAR" | "ADEQUADO";

export type ExcessoInfo = {
  farmaciaId: string;
  farmaciaNome: string;
  disponivelUnidades: number;
};

export type ProposalStats = {
  total: number;
  transferencia: number;
  comprar: number;
  aguardar: number;
  adequado: number;
};

export type ProposalRow = {
  farmaciaId: string;
  farmaciaNome: string;
  produtoId: string;
  cnp: number;
  designacao: string;
  fabricante: string | null;
  fornecedor: string | null;
  categoria: string;
  productType: string | null;
  salesQty: number;
  avgDailySales: number;
  currentStock: number | null;
  coberturaAtualDias: number | null;
  pendingQty: number;
  targetQty: number;
  suggestedQty: number;
  transferirQty: number;
  estado: ProposalEstado;
  motivo: string;
  excessoFonte: ExcessoInfo[];
  /**
   * A linha existe porque o utilizador a NOMEOU numa lista importada, e
   * não porque o artigo vendeu no período.
   *
   * Sem lista, é sempre `false`: a proposta automática continua a ser
   * conduzida pelas vendas, exactamente como era. Com lista, o universo
   * passa a ser a lista, e um artigo com zero vendas entra com
   * `suggestedQty = 0` em vez de desaparecer.
   *
   * É um marcador e não um `ProposalEstado` novo de propósito: o estado
   * descreve o que fazer com o artigo (comprar, aguardar, transferir), e
   * «não vendeu» é a razão de não haver nada a fazer, não uma acção.
   * Um valor novo no enum obrigaria a rever `stats`, os quatro cartões
   * de resumo e as cores dos badges para dizer o que um booleano diz.
   */
  semVendasNoPeriodo: boolean;
};

export type ProposalResult = {
  rows: ProposalRow[];
  meta: {
    numDays: number;
    farmaciaIds: string[];
    startDate: string;
    endDate: string;
    considerStock: boolean;
    baseRule: ProposalBaseRule;
    targetCoverageDays: number;
    filtered: number;
    totalProductsWithSales: number;
    stats: ProposalStats;
    /**
     * A proposta bateu no tecto de `MAX_ROWS` e foi cortada.
     *
     * Existe por causa da lista importada. O `LIMIT 500` sempre lá
     * esteve, e com os filtros interactivos raramente se atingia; com um
     * ficheiro de 3 000 CNP atinge-se sempre, e as 2 500 linhas que
     * faltam desapareciam sem uma palavra. O corte é por vendas
     * decrescentes, portanto o que se perde é a cauda — mas isso é uma
     * decisão que o utilizador tem de poder ver, não adivinhar.
     */
    truncated: boolean;
    /** Quantos CNP vinham da lista importada, quando havia uma. */
    cnpsNaLista?: number;
    /**
     * O que aconteceu a cada CNP da lista importada. Ausente sem lista.
     *
     * Existe porque «1 210 encontrados» e «940 na proposta» são números
     * diferentes e o utilizador precisa de ver os dois — senão conclui
     * que 270 artigos se perderam.
     */
    listaImportada?: ResumoListaImportada;
  };
};


// ─── Helpers ─────────────────────────────────────────────────────────────────


function diffDaysInclusive(start: Date, end: Date): number {
  return Math.max(1, Math.floor((end.getTime() - start.getTime()) / 86400000) + 1);
}

function toF(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function computeStats(rows: ProposalRow[]): ProposalStats {
  const s: ProposalStats = { total: rows.length, transferencia: 0, comprar: 0, aguardar: 0, adequado: 0 };
  for (const r of rows) {
    if (r.estado === "TRANSFERÊNCIA") s.transferencia++;
    else if (r.estado === "COMPRAR") s.comprar++;
    else if (r.estado === "AGUARDAR") s.aguardar++;
    else s.adequado++;
  }
  return s;
}

function computeEstado(suggestedQty: number, pendingQty: number, considerStock: boolean): ProposalEstado {
  if (!considerStock) return suggestedQty > 0 ? "COMPRAR" : "ADEQUADO";
  if (suggestedQty <= 0 && pendingQty > 0) return "AGUARDAR";
  if (suggestedQty <= 0) return "ADEQUADO";
  return "COMPRAR";
}

function buildMotivo(
  estado: ProposalEstado,
  p: {
    currentStock: number | null;
    coberturaAtualDias: number | null;
    pendingQty: number;
    suggestedQty: number;
    transferirQty: number;
    excessoFonte: ExcessoInfo[];
    targetCoverageDays: number;
  }
): string {
  const stock = p.currentStock ?? 0;
  const cobStr = p.coberturaAtualDias != null ? `${p.coberturaAtualDias.toFixed(1)}d` : "—";

  switch (estado) {
    case "ADEQUADO":
      return `Stock: ${stock} und (${cobStr}) · acima do alvo de ${p.targetCoverageDays}d`;

    case "AGUARDAR":
      return `Encomenda pendente: ${p.pendingQty} und · cobre a necessidade`;

    case "COMPRAR": {
      const base = `Stock: ${stock} und (${cobStr}) · alvo ${p.targetCoverageDays}d`;
      if (p.excessoFonte.length > 0) {
        const excTotal = Math.round(p.excessoFonte.reduce((s, e) => s + e.disponivelUnidades, 0));
        const names = p.excessoFonte.map((e) => e.farmaciaNome).join(", ");
        return `${base} · excedente parcial em ${names} (${excTotal} und) · comprar ${p.suggestedQty}`;
      }
      return `${base} · sugerido: ${p.suggestedQty} und`;
    }

    case "TRANSFERÊNCIA": {
      const total = Math.round(p.excessoFonte.reduce((s, e) => s + e.disponivelUnidades, 0));
      const names = p.excessoFonte.map((e) => e.farmaciaNome).join(", ");
      return `Excedente em ${names}: ${total} und disponíveis · não é necessário comprar`;
    }
  }
}

/**
 * Proposta vazia — o resultado de um universo vazio.
 *
 * Existe por causa da lista importada: quando o ficheiro nao resolve
 * nenhum CNP, `cnps` chega aqui como `[]` e a resposta certa e' zero
 * linhas, nao o catalogo todo. Sair por aqui evita mandar um
 * `= ANY('{}')` a` base de dados so' para confirmar o obvio.
 */
function emptyProposal(
  input: ProposalInput,
  numDays: number,
  cnpsNaLista?: number,
): ProposalResult {
  return {
    rows: [],
    meta: {
      numDays,
      farmaciaIds: [input.farmaciaId],
      startDate: input.startDate.toISOString(),
      endDate: input.endDate.toISOString(),
      considerStock: input.considerStock,
      baseRule: input.baseRule,
      targetCoverageDays: input.targetCoverageDays,
      filtered: 0,
      totalProductsWithSales: 0,
      stats: { total: 0, transferencia: 0, comprar: 0, aguardar: 0, adequado: 0 },
      truncated: false,
      ...(cnpsNaLista !== undefined ? { cnpsNaLista } : {}),
    },
  };
}

// ─── RawRow do SQL ────────────────────────────────────────────────────────────

type RawRow = {
  produtoId: string;
  cnp: number;
  designacao: string;
  productType: string | null;
  fabricante: string | null;
  stockAtual: number | null;
  fornecedorOrigem: string | null;
  categoriaOrigem: string | null;
  subcategoriaOrigem: string | null;
  canonN1: string | null;
  canonN2: string | null;
  salesQty: number;
  pendingQty: number;
};

// ─── Proposta por farmácia ────────────────────────────────────────────────────

export async function generateOrderProposal(
  input: ProposalInput,
  client?: PrismaClient
): Promise<ProposalResult> {
  if (input.endDate < input.startDate) {
    throw new Error("Data fim anterior à data início.");
  }

  const prisma = client ?? (await getPrisma());
  const numDays = diffDaysInclusive(input.startDate, input.endDate);
  const farmaciaNome = input.farmaciaNome ?? input.farmaciaId;

  const fabFilter = input.filters?.fabricantes?.length ? input.filters.fabricantes : null;
  const fornFilter = input.filters?.fornecedores?.length ? input.filters.fornecedores : null;
  const catFilter = input.filters?.categorias?.length ? input.filters.categorias : null;
  const subcatFilter = input.filters?.subcategorias?.length ? input.filters.subcategorias : null;
  const utilFilter = input.filters?.utilizacoes?.length ? input.filters.utilizacoes : null;
  const typeFilter = input.filters?.productTypes?.length ? input.filters.productTypes : null;

  // Lista importada: PRESENÇA, não comprimento. Uma lista vazia é uma
  // lista de que nada foi encontrado no catálogo — o universo é vazio, e
  // a proposta correcta é vazia. Sai já aqui, sem tocar na BD.
  const cnpFilter = temListaCodigos(input.filters?.cnps) ? input.filters!.cnps! : null;
  if (cnpFilter !== null && cnpFilter.length === 0) {
    return emptyProposal(input, numDays, 0);
  }

  // A lista NÃO entra em `conds`. Com lista, ela decide a FORMA da
  // consulta — ver o bloco `rawRows` abaixo — e não é mais um `AND`.
  const conds: Prisma.Sql[] = [];
  if (fabFilter) conds.push(Prisma.sql`fab."nomeNormalizado" = ANY(${fabFilter})`);
  if (fornFilter) conds.push(Prisma.sql`pf."fornecedorOrigem" = ANY(${fornFilter})`);
  if (typeFilter) conds.push(Prisma.sql`p."productType" = ANY(${typeFilter})`);
  if (catFilter) {
    conds.push(Prisma.sql`(c1.nome = ANY(${catFilter}) OR pf."categoriaOrigem" = ANY(${catFilter}))`);
  }
  // Nível 2 só pelo canónico. `subcategoriaOrigem` é texto livre do ERP e
  // não é classificação — ver lib/categoria-resolver.ts.
  if (subcatFilter) conds.push(Prisma.sql`c2.nome = ANY(${subcatFilter})`);
  // EXISTS correlacionado: continua a ser UMA consulta, não uma por
  // produto. `= ANY` dá o OU entre as utilizações escolhidas.
  if (utilFilter) {
    conds.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "ProdutoUtilizacao" pu
        JOIN "Utilizacao" u ON u.id = pu."utilizacaoId"
       WHERE pu."produtoId" = p.id AND u.estado = 'ATIVO' AND u.slug = ANY(${utilFilter})
    )`);
  }
  const whereExtra =
    conds.length > 0 ? Prisma.sql`AND ${Prisma.join(conds, " AND ")}` : Prisma.empty;

  const startYM = input.startDate.getFullYear() * 100 + (input.startDate.getMonth() + 1);
  const endYM = input.endDate.getFullYear() * 100 + (input.endDate.getMonth() + 1);

  // ── As DUAS CTE, iguais nos dois caminhos ──────────────────────────
  const cteVendas = Prisma.sql`
    vendas AS (
      SELECT vm."produtoId",
             GREATEST(SUM(COALESCE(vm."quantidadeLiquida", vm.quantidade)), 0) AS qty
      FROM "VendaMensal" vm
      WHERE vm."farmaciaId" = ${input.farmaciaId}
        AND (vm.ano * 100 + vm.mes) >= ${startYM}
        AND (vm.ano * 100 + vm.mes) <= ${endYM}
      GROUP BY vm."produtoId"
    ),
    pending AS (
      SELECT le."produtoId",
             SUM(COALESCE(le."quantidadeAjustada", le."quantidadeSugerida", 0)) AS qty
      FROM "LinhaEncomenda" le
      JOIN "ListaEncomenda" l ON l.id = le."listaEncomendaId"
      WHERE l."farmaciaId" = ${input.farmaciaId}
        AND l."estadoExport" IN ('PENDENTE', 'EM_EXPORTACAO')
      GROUP BY le."produtoId"
    )`;

  const colunas = Prisma.sql`
      p.cnp                                       AS cnp,
      p.designacao                                AS designacao,
      p."productType"                             AS "productType",
      fab."nomeNormalizado"                       AS fabricante,
      pf."stockAtual"::float                      AS "stockAtual",
      pf."fornecedorOrigem"                       AS "fornecedorOrigem",
      pf."categoriaOrigem"                        AS "categoriaOrigem",
      pf."subcategoriaOrigem"                     AS "subcategoriaOrigem",
      c1.nome                                     AS "canonN1",
      c2.nome                                     AS "canonN2",
      COALESCE(pending.qty::float, 0)             AS "pendingQty"`;

  const joinsCatalogo = Prisma.sql`
    LEFT JOIN "Fabricante"     fab ON fab.id = p."fabricanteId"
    LEFT JOIN "Classificacao"  c1  ON c1.id  = p."classificacaoNivel1Id"
    LEFT JOIN "Classificacao"  c2  ON c2.id  = p."classificacaoNivel2Id"`;

  // ── A consulta, em duas FORMAS ─────────────────────────────────────
  //
  // Não é um `AND` a mais: é o universo a mudar de dono.
  //
  //   SEM LISTA — conduzida pelas VENDAS. `FROM vendas` e `qty > 0`: a
  //   proposta automática é «o que esta farmácia vende». É o
  //   comportamento de sempre, e não muda, porque a fórmula não é minha
  //   para mudar.
  //
  //   COM LISTA — conduzida pela LISTA. `FROM ProdutoFarmacia` e as
  //   vendas em LEFT JOIN. O utilizador nomeou os artigos um a um; um
  //   artigo que não vendeu no período tem proposta ZERO, e zero é uma
  //   resposta — desaparecer não é. Era o que acontecia: o `JOIN vendas`
  //   eliminava-o antes de qualquer cálculo, e a UI dizia «1 210
  //   encontrados» e mostrava 940 sem explicar os 270 em falta.
  //
  // A ordenação também muda de sentido. Sem lista, `qty DESC` é o
  // critério que escolhe QUAIS entram (com o tecto). Com lista já não
  // escolhe nada — todos entram — e serve só para pôr à cabeça o que
  // mais roda; o desempate por designação torna a ordem estável entre
  // execuções, que a paginação do cliente assume.
  const rawRows = cnpFilter
    ? await prisma.$queryRaw<RawRow[]>(Prisma.sql`
        WITH ${cteVendas}
        SELECT
          pf."produtoId"                          AS "produtoId",
          ${colunas},
          COALESCE(v.qty, 0)::float               AS "salesQty"
        FROM "ProdutoFarmacia" pf
        JOIN "Produto"  p ON p.id = pf."produtoId"
        ${joinsCatalogo}
        LEFT JOIN vendas  v       ON v."produtoId"       = pf."produtoId"
        LEFT JOIN pending         ON pending."produtoId" = pf."produtoId"
        WHERE pf."farmaciaId" = ${input.farmaciaId}
          AND (pf."flagRetirado" IS NOT TRUE)
          AND p.cnp = ANY(${cnpFilter})
          ${whereExtra}
        ORDER BY COALESCE(v.qty, 0) DESC, p.designacao ASC
        LIMIT ${MAX_LINHAS_PROPOSTA}
      `)
    : await prisma.$queryRaw<RawRow[]>(Prisma.sql`
        WITH ${cteVendas}
        SELECT
          v."produtoId"                           AS "produtoId",
          ${colunas},
          v.qty::float                            AS "salesQty"
        FROM vendas v
        JOIN "Produto" p ON p.id = v."produtoId"
        ${joinsCatalogo}
        LEFT JOIN "ProdutoFarmacia" pf ON pf."produtoId" = v."produtoId"
                                      AND pf."farmaciaId" = ${input.farmaciaId}
        LEFT JOIN pending              ON pending."produtoId" = v."produtoId"
        WHERE v.qty > 0
          AND (pf."flagRetirado" IS NOT TRUE)
          ${whereExtra}
        ORDER BY v.qty DESC
        LIMIT ${MAX_LINHAS_PROPOSTA}
      `);

  const rows: ProposalRow[] = [];
  for (const r of rawRows) {
    const salesQty = toF(r.salesQty);
    const avgDailySales = avgDaily(salesQty, numDays);
    const target =
      input.baseRule === "total"
        ? salesQty
        : avgDailySales * Math.max(1, input.targetCoverageDays);

    const stock = r.stockAtual == null ? null : toF(r.stockAtual);
    const pending = toF(r.pendingQty);

    const suggestedRaw = input.considerStock ? target - (stock ?? 0) - pending : target;
    const suggestedQty = Math.max(0, Math.ceil(suggestedRaw));

    const coberturaAtualDias =
      stock != null && avgDailySales > 0
        ? Math.round((stock / avgDailySales) * 10) / 10
        : null;

    const { categoria } = resolveCategoria({
      classificacaoNivel1: r.canonN1 ? { nome: r.canonN1 } : null,
      classificacaoNivel2: r.canonN2 ? { nome: r.canonN2 } : null,
      categoriaOrigem: r.categoriaOrigem,
      subcategoriaOrigem: r.subcategoriaOrigem,
    });

    const estado = computeEstado(suggestedQty, pending, input.considerStock);
    const excessoFonte: ExcessoInfo[] = [];
    // Só pode ser verdade quando há lista: sem lista a consulta exige
    // `qty > 0` e uma linha com zero vendas nunca chega aqui.
    const semVendasNoPeriodo = cnpFilter !== null && salesQty <= 0;

    rows.push({
      farmaciaId: input.farmaciaId,
      farmaciaNome,
      produtoId: r.produtoId,
      cnp: Number(r.cnp),
      designacao: r.designacao,
      fabricante: r.fabricante,
      fornecedor: r.fornecedorOrigem,
      categoria,
      productType: r.productType,
      salesQty: Math.round(salesQty * 1000) / 1000,
      avgDailySales: Math.round(avgDailySales * 100) / 100,
      currentStock: stock,
      coberturaAtualDias,
      pendingQty: pending,
      targetQty: Math.round(target * 100) / 100,
      suggestedQty,
      transferirQty: 0,
      estado,
      motivo: buildMotivo(estado, {
        currentStock: stock,
        coberturaAtualDias,
        pendingQty: pending,
        suggestedQty,
        transferirQty: 0,
        excessoFonte,
        targetCoverageDays: input.targetCoverageDays,
      }),
      excessoFonte,
      semVendasNoPeriodo,
    });
  }

  return {
    rows,
    meta: {
      numDays,
      farmaciaIds: [input.farmaciaId],
      startDate: input.startDate.toISOString(),
      endDate: input.endDate.toISOString(),
      considerStock: input.considerStock,
      baseRule: input.baseRule,
      targetCoverageDays: input.targetCoverageDays,
      filtered: rows.length,
      totalProductsWithSales: rawRows.length,
      stats: computeStats(rows),
      truncated: rawRows.length >= MAX_LINHAS_PROPOSTA,
      ...(cnpFilter
        ? {
            cnpsNaLista: cnpFilter.length,
            listaImportada: resumirListaImportada(cnpFilter, rows),
          }
        : {}),
    },
  };
}

// ─── Proposta de grupo ────────────────────────────────────────────────────────

export async function generateGroupProposal(
  input: GroupProposalInput,
  client?: PrismaClient
): Promise<ProposalResult> {
  if (input.farmaciaIds.length === 0) throw new Error("Nenhuma farmácia especificada.");
  if (input.endDate < input.startDate) throw new Error("Data fim anterior à data início.");

  const prisma = client ?? (await getPrisma());
  const numDays = diffDaysInclusive(input.startDate, input.endDate);
  const startYM = input.startDate.getFullYear() * 100 + (input.startDate.getMonth() + 1);
  const endYM = input.endDate.getFullYear() * 100 + (input.endDate.getMonth() + 1);

  // ── 1. Proposta individual por farmácia ──────────────────────────────────
  const perFarmacia = await Promise.all(
    input.farmaciaIds.map((fId) =>
      generateOrderProposal(
        {
          farmaciaId: fId,
          farmaciaNome: input.farmaciaNames[fId] ?? fId,
          startDate: input.startDate,
          endDate: input.endDate,
          considerStock: input.considerStock,
          baseRule: input.baseRule,
          targetCoverageDays: input.targetCoverageDays,
          filters: input.filters,
        },
        prisma
      )
    )
  );

  const allRows: ProposalRow[] = perFarmacia.flatMap((r) => r.rows);
  // Uma farmacia truncada trunca o grupo: a consolidacao soma propostas
  // individuais, e uma delas cortada ja' nao e' o total.
  const perFarmaciaTruncado = perFarmacia.some((r) => r.meta.truncated);

  if (allRows.length === 0) {
    const emptyStats: ProposalStats = { total: 0, transferencia: 0, comprar: 0, aguardar: 0, adequado: 0 };
    return {
      rows: [],
      meta: {
        numDays, farmaciaIds: input.farmaciaIds,
        startDate: input.startDate.toISOString(), endDate: input.endDate.toISOString(),
        considerStock: input.considerStock, baseRule: input.baseRule,
        targetCoverageDays: input.targetCoverageDays,
        filtered: 0, totalProductsWithSales: 0, stats: emptyStats,
        truncated: false,
        ...(temListaCodigos(input.filters?.cnps)
          ? {
              cnpsNaLista: input.filters!.cnps!.length,
              listaImportada: resumirListaImportada(input.filters!.cnps!, []),
            }
          : {}),
      },
    };
  }

  // ── 2. Identificar produtos que necessitam compra ────────────────────────
  const productIds = [
    ...new Set(allRows.filter((r) => r.estado === "COMPRAR").map((r) => r.produtoId)),
  ];

  // ── 3. Stock cross-farmácia para esses produtos ──────────────────────────
  type CrossRow = {
    produtoId: string;
    farmaciaId: string;
    farmaciaNome: string;
    stockAtual: number | null;
    avgDailySales: number;
  };

  const crossRows = productIds.length > 0
    ? await prisma.$queryRaw<CrossRow[]>(Prisma.sql`
        WITH vendas_agg AS (
          SELECT vm."produtoId", vm."farmaciaId",
                 GREATEST(SUM(COALESCE(vm."quantidadeLiquida", vm.quantidade)), 0)::float AS "totalQty"
          FROM "VendaMensal" vm
          WHERE vm."produtoId" = ANY(${productIds})
            AND vm."farmaciaId" = ANY(${input.farmaciaIds})
            AND (vm.ano * 100 + vm.mes) >= ${startYM}
            AND (vm.ano * 100 + vm.mes) <= ${endYM}
          GROUP BY vm."produtoId", vm."farmaciaId"
        )
        SELECT
          pf."produtoId",
          pf."farmaciaId",
          f.nome                                          AS "farmaciaNome",
          pf."stockAtual"::float                          AS "stockAtual",
          COALESCE(va."totalQty", 0) / ${numDays}::float AS "avgDailySales"
        FROM "ProdutoFarmacia" pf
        JOIN "Farmacia" f ON f.id = pf."farmaciaId"
        LEFT JOIN vendas_agg va ON va."produtoId" = pf."produtoId"
                                AND va."farmaciaId" = pf."farmaciaId"
        WHERE pf."produtoId" = ANY(${productIds})
          AND pf."farmaciaId" = ANY(${input.farmaciaIds})
          AND (pf."flagRetirado" IS NOT TRUE)
      `)
    : [];

  // ── 4. Mapa de excedentes: produtoId → [ExcessoInfo] ────────────────────
  const excessByProduct = new Map<string, ExcessoInfo[]>();

  for (const cs of crossRows) {
    const stock = toF(cs.stockAtual);
    if (stock <= 0) continue;
    const avgD = toF(cs.avgDailySales);
    const excedente = stock - avgD * input.targetCoverageDays * EXCESSO_FACTOR;
    if (excedente <= 0) continue;
    if (!excessByProduct.has(cs.produtoId)) excessByProduct.set(cs.produtoId, []);
    excessByProduct.get(cs.produtoId)!.push({
      farmaciaId: cs.farmaciaId,
      farmaciaNome: cs.farmaciaNome,
      disponivelUnidades: excedente,
    });
  }

  // ── 5. Re-avaliar COMPRAR rows com excedente de outras farmácias ─────────
  const finalRows: ProposalRow[] = [];

  for (const row of allRows) {
    if (row.estado !== "COMPRAR") {
      finalRows.push(row);
      continue;
    }

    const fontes = (excessByProduct.get(row.produtoId) ?? [])
      .filter((e) => e.farmaciaId !== row.farmaciaId);

    if (fontes.length === 0) {
      finalRows.push(row);
      continue;
    }

    const totalExcesso = fontes.reduce((s, e) => s + e.disponivelUnidades, 0);
    const needed = row.suggestedQty;

    if (totalExcesso >= needed) {
      // Transferência total — não é necessário comprar
      const transferirQty = needed;
      finalRows.push({
        ...row,
        suggestedQty: 0,
        transferirQty,
        estado: "TRANSFERÊNCIA",
        excessoFonte: fontes,
        motivo: buildMotivo("TRANSFERÊNCIA", {
          currentStock: row.currentStock,
          coberturaAtualDias: row.coberturaAtualDias,
          pendingQty: row.pendingQty,
          suggestedQty: 0,
          transferirQty,
          excessoFonte: fontes,
          targetCoverageDays: input.targetCoverageDays,
        }),
      });
    } else {
      // Transferência parcial — reduz quantidade a comprar
      const comprar = Math.ceil(needed - totalExcesso);
      const transferirQty = Math.floor(totalExcesso);
      finalRows.push({
        ...row,
        suggestedQty: comprar,
        transferirQty,
        excessoFonte: fontes,
        motivo: buildMotivo("COMPRAR", {
          currentStock: row.currentStock,
          coberturaAtualDias: row.coberturaAtualDias,
          pendingQty: row.pendingQty,
          suggestedQty: comprar,
          transferirQty,
          excessoFonte: fontes,
          targetCoverageDays: input.targetCoverageDays,
        }),
      });
    }
  }

  return {
    rows: finalRows,
    meta: {
      numDays,
      farmaciaIds: input.farmaciaIds,
      startDate: input.startDate.toISOString(),
      endDate: input.endDate.toISOString(),
      considerStock: input.considerStock,
      baseRule: input.baseRule,
      targetCoverageDays: input.targetCoverageDays,
      filtered: finalRows.length,
      totalProductsWithSales: allRows.length,
      stats: computeStats(finalRows),
      // Qualquer farmacia truncada trunca o grupo: a consolidacao soma
      // propostas individuais, e uma delas cortada ja' nao e' o total.
      truncated: perFarmaciaTruncado,
      // O resumo do GRUPO é calculado sobre `allRows` — as linhas de
      // todas as farmácias — e não somando os resumos individuais. Um
      // artigo que vende na Principal e não vende no Castelo conta uma
      // vez, como «com vendas»; somar os parciais contá-lo-ia nas duas
      // colunas e o total deixaria de bater com a lista.
      ...(temListaCodigos(input.filters?.cnps)
        ? {
            cnpsNaLista: input.filters!.cnps!.length,
            listaImportada: resumirListaImportada(input.filters!.cnps!, allRows),
          }
        : {}),
    },
  };
}
