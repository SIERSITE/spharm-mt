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
import { sqlCondicaoForma } from "@/lib/catalog/forma-farmaceutica-sql";
import { lerChavesForma } from "@/lib/catalog/forma-farmaceutica-filtro";
import { resolverFiltroFabricantesProposta } from "@/lib/encomendas/filtro-fabricantes-proposta";
import { ordenarLinhasProposta } from "@/lib/ordenacao-artigos";

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
   * Formas farmacêuticas por CHAVE normalizada (`chaveFormaFarmaceutica`; `SEM_FORMA` = sem forma). Vazio/omitido =
   * sem filtro. Aplicado no SQL da proposta (`= ANY($n)` parametrizado), antes do corte de linhas.
   */
  formas?: string[];
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

/**
 * Estado de uma linha da proposta. SÓ existem estes quatro, e todos derivam de vendas, stock, cobertura e stock de OUTRAS
 * farmácias (transferência). Já não existe «AGUARDAR» (2026-10): era a única classificação que dependia de encomendas anteriores
 * (`pendingQty`), e a decisão funcional é que outras encomendas nunca reduzem, anulam nem classificam a sugestão.
 */
export type ProposalEstado = "TRANSFERÊNCIA" | "COMPRAR" | "ADEQUADO";

export type ExcessoInfo = {
  farmaciaId: string;
  farmaciaNome: string;
  disponivelUnidades: number;
};

export type ProposalStats = {
  total: number;
  transferencia: number;
  comprar: number;
  adequado: number;
};

/** Uma encomenda que compõe o «Pendente» informativo de uma linha (só para apresentação — nunca entra em cálculos). */
export type PendenteInfo = {
  listaId: string;
  numero: string | null;
  nome: string;
  fornecedor: string | null;
  /** Estado de exportação da encomenda (PENDENTE | EM_EXPORTACAO). */
  estadoExport: string;
  quantidade: number;
  /** ISO — criação da encomenda. */
  data: string;
};

export type ProposalRow = {
  farmaciaId: string;
  farmaciaNome: string;
  produtoId: string;
  cnp: number;
  designacao: string;
  fabricante: string | null;
  fornecedor: string | null;
  /**
   * Sugestão INICIAL de fornecedor para esta linha — vem de
   * `ProdutoFarmacia.fornecedorHabitualId` (por produto+farmácia), quando
   * existe. É só a semente: uma vez que a linha exista num rascunho, o
   * que decide é `LinhaEncomenda.fornecedorSugeridoId` (editável por
   * linha/em massa), nunca recalculado a partir daqui ao reabrir. Ver
   * lib/encomendas/finalizar-multi-fornecedor.ts.
   *
   * Fonte ÚNICA: `ProdutoFarmacia.fornecedorHabitualId`, e só se o fornecedor estiver ATIVO. Sem habitual
   * (ou habitual inativo) = `null` («Sem fornecedor»). O texto do ERP (`fornecedor`) NUNCA a preenche.
   */
  fornecedorSugeridoId: string | null;
  /** Nome legível do fornecedor sugerido (só existe quando `fornecedorSugeridoId` existe). */
  fornecedorSugeridoNome?: string | null;
  /**
   * Informativo: o habitual desta linha existe mas está INATIVO, por isso NÃO foi usado. Só serve para a UI
   * explicar «habitual inativo: X — escolha outro»; nunca é sugestão nem entra em nenhum documento.
   */
  fornecedorHabitualInativoNome?: string | null;
  categoria: string;
  productType: string | null;
  salesQty: number;
  avgDailySales: number;
  currentStock: number | null;
  coberturaAtualDias: number | null;
  /**
   * INFORMATIVO (2026-10). Unidades que constam de OUTRAS encomendas finalizadas ainda por exportar (a mesma consulta de sempre,
   * por farmácia). NÃO participa em NENHUM cálculo: não entra em `suggestedQty`, nem no `estado`, nem nos totais, nem na decisão
   * do grupo. Existe só para o utilizador saber que há outras encomendas. Ver `PENDENTE_INFORMATIVO` e `calcularQuantidadeSugerida`.
   */
  pendingQty: number;
  /** As encomendas que compõem `pendingQty` (a soma coincide por construção: vêm da MESMA agregação). Só apresentação. */
  pendentes: PendenteInfo[];
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

/** O detalhe do pendente (JSON da agregação SQL) → `PendenteInfo[]`. Tolerante: um JSON inesperado dá lista vazia, nunca rebenta. */
export function lerPendentes(json: string | null | undefined): PendenteInfo[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json) as Array<Record<string, unknown>>;
    return arr.map((x) => ({
      listaId: String(x.listaId),
      numero: x.numero == null ? null : String(x.numero),
      nome: String(x.nome ?? ""),
      fornecedor: x.fornecedor == null ? null : String(x.fornecedor),
      estadoExport: String(x.estadoExport ?? ""),
      quantidade: Number(x.quantidade) || 0,
      data: x.data == null ? "" : new Date(String(x.data)).toISOString(),
    }));
  } catch {
    return [];
  }
}

function toF(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function computeStats(rows: ProposalRow[]): ProposalStats {
  const s: ProposalStats = { total: rows.length, transferencia: 0, comprar: 0, adequado: 0 };
  for (const r of rows) {
    if (r.estado === "TRANSFERÊNCIA") s.transferencia++;
    else if (r.estado === "COMPRAR") s.comprar++;
    else s.adequado++;
  }
  return s;
}

/**
 * A quantidade sugerida de compra de UMA farmácia, só por vendas e stock (2026-10).
 *
 *   ANTES:  max(0, ceil(alvo − stock − PENDENTE))   — outras encomendas deduziam-se e podiam pôr a sugestão a zero
 *   AGORA:  max(0, ceil(alvo − stock))              — o PENDENTE já não entra na fórmula
 *
 * Sem «considerar stock», a sugestão é o próprio alvo. O alvo é `salesQty` (regra «total») ou média diária × cobertura.
 * Função pura e exportada: é o único sítio onde a quantidade sugerida se calcula, e não tem parâmetro de pendente.
 */
export function calcularQuantidadeSugerida(input: { target: number; stock: number | null; considerStock: boolean }): number {
  const bruto = input.considerStock ? input.target - (input.stock ?? 0) : input.target;
  return Math.max(0, Math.ceil(bruto));
}

/** O estado só depende da quantidade sugerida (e de se o stock conta). Sem «AGUARDAR»: outras encomendas não classificam a linha. */
export function computeEstado(suggestedQty: number): ProposalEstado {
  return suggestedQty > 0 ? "COMPRAR" : "ADEQUADO";
}

/** Texto informativo sobre outras encomendas — NÃO sugere espera e nunca altera o estado nem a quantidade. */
export function textoPendenteInformativo(pendingQty: number): string {
  return `Informativo: ${pendingQty} unidades já constam de outras encomendas; não foram consideradas no cálculo desta proposta.`;
}

/** O motivo da linha + (se houver) a nota INFORMATIVA sobre outras encomendas. A nota é só texto: não depende do estado. */
function buildMotivo(estado: ProposalEstado, p: Parameters<typeof motivoBase>[1]): string {
  const base = motivoBase(estado, p);
  return p.pendingQty > 0 ? `${base} · ${textoPendenteInformativo(p.pendingQty)}` : base;
}

function motivoBase(
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
      stats: { total: 0, transferencia: 0, comprar: 0, adequado: 0 },
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
  fornecedorHabitualId: string | null;
  fornecedorHabitualNome: string | null;
  fornecedorHabitualEstado: string | null;
  categoriaOrigem: string | null;
  subcategoriaOrigem: string | null;
  canonN1: string | null;
  canonN2: string | null;
  salesQty: number;
  /** INFORMATIVO — ver `ProposalRow.pendingQty`. */
  pendingQty: number;
  pendentesJson: string | null;
};

// ─── Proposta por farmácia ────────────────────────────────────────────────────

export async function generateOrderProposal(
  input: ProposalInput,
  client?: PrismaClient,
  // Só para testes: simula o tenant fora de um pedido Next.js. Produção usa sempre o default.
  opcoes?: { resolverTenant?: () => Promise<string | null> }
): Promise<ProposalResult> {
  if (input.endDate < input.startDate) {
    throw new Error("Data fim anterior à data início.");
  }

  const prisma = client ?? (await getPrisma());
  const numDays = diffDaysInclusive(input.startDate, input.endDate);
  const farmaciaNome = input.farmaciaNome ?? input.farmaciaId;

  // Garantia: grupo:/fabricante: resolvem-se para produtos; nos outros tenants continua a ser por nome de fabricante.
  const fabFiltro = await resolverFiltroFabricantesProposta(prisma, input.filters?.fabricantes, opcoes?.resolverTenant);
  const fornFilter = input.filters?.fornecedores?.length ? input.filters.fornecedores : null;
  const catFilter = input.filters?.categorias?.length ? input.filters.categorias : null;
  const subcatFilter = input.filters?.subcategorias?.length ? input.filters.subcategorias : null;
  const utilFilter = input.filters?.utilizacoes?.length ? input.filters.utilizacoes : null;
  const typeFilter = input.filters?.productTypes?.length ? input.filters.productTypes : null;
  const formaCond = sqlCondicaoForma(lerChavesForma(input.filters?.formas));

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
  if (fabFiltro?.modo === "nomes") conds.push(Prisma.sql`fab."nomeNormalizado" = ANY(${fabFiltro.nomes})`);
  if (fabFiltro?.modo === "produtos") conds.push(Prisma.sql`p.id = ANY(${fabFiltro.produtoIds})`);
  if (fornFilter) conds.push(Prisma.sql`pf."fornecedorOrigem" = ANY(${fornFilter})`);
  if (typeFilter) conds.push(Prisma.sql`p."productType" = ANY(${typeFilter})`);
  if (formaCond) conds.push(formaCond);
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
      -- INFORMATIVO (2026-10) — NÃO entra em nenhum cálculo da proposta (ver calcularQuantidadeSugerida). Serve só para a
      -- coluna «Pendente» mostrar que já existem outras encomendas: as FINALIZADAS desta farmácia cuja exportação ainda não
      -- terminou (um RASCUNHO, a ANULADA/ELIMINADA e o rascunho-pai dividido nunca contam; estadoExport sozinho não chegava:
      -- nasce PENDENTE por omissão em TODOS os estados). UMA só agregação por produto (sem N+1): a soma e o detalhe saem
      -- das MESMAS linhas, por isso coincidem sempre.
      SELECT le."produtoId",
             SUM(COALESCE(le."quantidadeAjustada", le."quantidadeSugerida", 0)) AS qty,
             jsonb_agg(jsonb_build_object(
               'listaId', l.id,
               'numero', l.numero,
               'nome', l.nome,
               'fornecedor', COALESCE(fpe.nome, fpe."nomeNormalizado"),
               'estadoExport', l."estadoExport"::text,
               'quantidade', COALESCE(le."quantidadeAjustada", le."quantidadeSugerida", 0),
               'data', l."dataCriacao"
             ) ORDER BY l."dataCriacao") AS detalhe
      FROM "LinhaEncomenda" le
      JOIN "ListaEncomenda" l ON l.id = le."listaEncomendaId"
      LEFT JOIN "Fornecedor" fpe ON fpe.id = le."fornecedorSugeridoId"
      WHERE l."farmaciaId" = ${input.farmaciaId}
        AND l.estado = 'FINALIZADA'
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
      pf."fornecedorHabitualId"                   AS "fornecedorHabitualId",
      pf."categoriaOrigem"                        AS "categoriaOrigem",
      pf."subcategoriaOrigem"                     AS "subcategoriaOrigem",
      c1.nome                                     AS "canonN1",
      c2.nome                                     AS "canonN2",
      COALESCE(pending.qty::float, 0)             AS "pendingQty",
      pending.detalhe::text                       AS "pendentesJson",
      COALESCE(fo.nome, fo."nomeNormalizado")      AS "fornecedorHabitualNome",
      fo.estado::text                             AS "fornecedorHabitualEstado"`;

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
        LEFT JOIN "Fornecedor" fo ON fo.id = pf."fornecedorHabitualId"
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
        LEFT JOIN "Fornecedor" fo ON fo.id = pf."fornecedorHabitualId"
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
    // INFORMATIVO: só vai para a coluna «Pendente» e para o texto. Não entra na quantidade, no estado nem nos totais.
    const pending = toF(r.pendingQty);
    const pendentes = lerPendentes(r.pendentesJson);

    const suggestedQty = calcularQuantidadeSugerida({ target, stock, considerStock: input.considerStock });

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

    const estado = computeEstado(suggestedQty);
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
      // Só um habitual ATIVO é sugerido; um inativo fica de fora (e só é assinalado).
      fornecedorSugeridoId: r.fornecedorHabitualId && r.fornecedorHabitualEstado === "ATIVO" ? r.fornecedorHabitualId : null,
      fornecedorSugeridoNome: r.fornecedorHabitualId && r.fornecedorHabitualEstado === "ATIVO" ? r.fornecedorHabitualNome : null,
      fornecedorHabitualInativoNome: r.fornecedorHabitualId && r.fornecedorHabitualEstado !== "ATIVO" ? r.fornecedorHabitualNome : null,
      categoria,
      productType: r.productType,
      salesQty: Math.round(salesQty * 1000) / 1000,
      avgDailySales: Math.round(avgDailySales * 100) / 100,
      currentStock: stock,
      coberturaAtualDias,
      pendingQty: pending,
      pendentes,
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
    rows: ordenarLinhasProposta(rows),
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
    const emptyStats: ProposalStats = { total: 0, transferencia: 0, comprar: 0, adequado: 0 };
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
    rows: ordenarLinhasProposta(finalRows),
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
