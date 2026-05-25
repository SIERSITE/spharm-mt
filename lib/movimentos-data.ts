/**
 * lib/movimentos-data.ts
 *
 * Read-model agregador do histórico de movimentos de um produto.
 * Unifica várias fontes transaccionais dispersas numa única timeline
 * ordenada por data descendente, pronta para a ficha do artigo e
 * (futuramente) para exportação.
 *
 * Fontes consumidas (só o que existe persistido na BD):
 *   · Venda             → saída
 *   · Compra            → entrada
 *   · Devolucao         → saída (FORNECEDOR) / entrada (CLIENTE) / neutro
 *   · AjusteStock       → entrada (POSITIVO) / saída (NEGATIVO, QUEBRA, PERDA) / neutro
 *   · LinhaInventario   → regularização (via Inventario.dataInventario)
 *
 * Fontes NÃO disponíveis nesta fase (intencional — não inventamos):
 *   · Transferências entre farmácias (o módulo Transferências só gera
 *     sugestões, não persiste execuções)
 *   · Recepção de encomenda como evento distinto (Compra já cobre a
 *     entrada; quando existir um modelo dedicado de RecepcaoEncomenda,
 *     adicionar aqui)
 *   · Utilizador que executou o movimento — nenhuma tabela actual
 *     guarda esse campo. Fica a null; UI mostra "—".
 *   · Stock antes / Stock depois — nenhuma tabela guarda esse delta.
 *     Poderia ser reconstruído por running balance a partir de
 *     HistoricoStock + todos os movimentos, mas é trabalho dedicado
 *     com precisão discutível. Fica como TODO explícito.
 */

import { getPrisma } from "@/lib/prisma";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";

export type MovimentoTipo =
  | "VENDA"
  | "COMPRA"
  | "DEVOLUCAO_FORNECEDOR" // devolução AO fornecedor (saída)
  | "DEVOLUCAO_CLIENTE"    // devolução DO cliente (entrada)
  | "DEVOLUCAO_OUTRA"
  | "AJUSTE_POSITIVO"
  | "AJUSTE_NEGATIVO"
  | "AJUSTE_CORRECAO"
  | "QUEBRA"
  | "PERDA"
  | "AJUSTE_OUTRO"
  | "INVENTARIO";

export type MovimentoDirecao = "ENTRADA" | "SAIDA" | "NEUTRO";

export type MovimentoRow = {
  /** Chave estável dentro da timeline — fonte + id original. */
  key: string;
  /** ISO datetime; ordenação é feita sobre este campo descendente. */
  data: string;
  farmaciaId: string;
  farmacia: string;
  tipo: MovimentoTipo;
  /** Label legível, já em português. */
  tipoLabel: string;
  direcao: MovimentoDirecao;
  /** Número de documento individual quando existe (raro: fontes são agregadas). */
  documento: string | null;
  /** Quantidade ABSOLUTA. A direção é lida de `direcao`. */
  quantidade: number;
  /** Valor monetário (EUR) magnitude quando a fonte o tem; null caso contrário. */
  valor: number | null;
  /** Origem/Fornecedor (compra/devolução). null para vendas/ajustes. */
  origem: string | null;
  /** Sempre null nesta fase — nenhuma fonte persiste. */
  stockAntes: number | null;
  stockDepois: number | null;
  /** Sempre null nesta fase — ver nota no topo. */
  utilizador: string | null;
  /** Motivo/observação livre quando existe. */
  observacao: string | null;
  /**
   * Marca quando a linha NÃO é transacional — é um agregado (ex: soma
   * mensal vinda de VendaMensal). A UI pinta um badge "mensal" para o
   * leitor perceber que é uma soma, não um evento venda-a-venda.
   */
  agregado: boolean;
};

export type MovimentosFilters = {
  /** Se vazio/omitido, agrega todas as farmácias activas (não-Teste). */
  farmaciaIds?: string[];
  /** ISO date string inclusivo, opcional. */
  from?: string;
  to?: string;
  /** Se vazio/omitido, devolve todos os tipos. */
  tipos?: MovimentoTipo[];
  /**
   * Granularidade das vendas:
   *   · "diaria" → agregado por dia a partir de IngestVendaLinhaRaw (vista
   *      operacional recente; readonly sobre staging, NUNCA expõe o schema raw).
   *   · "mensal" → VendaMensal (histórico longo).
   * Se omitido, é auto-decidida pela janela (`from` nos últimos ~62 dias →
   * "diaria"; senão "mensal"). As duas fontes NUNCA são misturadas na mesma
   * vista, para não duplicar a mesma venda.
   */
  salesGranularity?: "diaria" | "mensal";
};

/** Janela máx. (dias) em que se serve a granularidade diária a partir do raw. */
const DAILY_WINDOW_MAX_DAYS = 62;
/** Janela por defeito (dias) quando o utilizador não define `Desde`/`Até`. */
const DEFAULT_WINDOW_DAYS = 30;

/**
 * Granularidade das vendas decidida pela janela EFECTIVA (já com o default
 * de 30 dias aplicado). Janela curta (≤62d) → diária a partir do raw; janela
 * longa → mensal (VendaMensal). As duas fontes nunca se misturam.
 */
function decideGranularity(filters: MovimentosFilters, effFrom: Date): "diaria" | "mensal" {
  if (filters.salesGranularity) return filters.salesGranularity;
  return Date.now() - effFrom.getTime() <= DAILY_WINDOW_MAX_DAYS * 86_400_000
    ? "diaria"
    : "mensal";
}

function toF(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

const TIPO_LABELS: Record<MovimentoTipo, string> = {
  VENDA: "Venda",
  COMPRA: "Compra / Receção",
  DEVOLUCAO_FORNECEDOR: "Devolução a fornecedor",
  DEVOLUCAO_CLIENTE: "Devolução de cliente",
  DEVOLUCAO_OUTRA: "Devolução",
  AJUSTE_POSITIVO: "Ajuste positivo",
  AJUSTE_NEGATIVO: "Ajuste negativo",
  AJUSTE_CORRECAO: "Correção",
  QUEBRA: "Quebra",
  PERDA: "Perda",
  AJUSTE_OUTRO: "Ajuste",
  INVENTARIO: "Regularização de inventário",
};

const TIPO_DIRECAO: Record<MovimentoTipo, MovimentoDirecao> = {
  VENDA: "SAIDA",
  COMPRA: "ENTRADA",
  DEVOLUCAO_FORNECEDOR: "SAIDA",
  DEVOLUCAO_CLIENTE: "ENTRADA",
  DEVOLUCAO_OUTRA: "NEUTRO",
  AJUSTE_POSITIVO: "ENTRADA",
  AJUSTE_NEGATIVO: "SAIDA",
  AJUSTE_CORRECAO: "NEUTRO",
  QUEBRA: "SAIDA",
  PERDA: "SAIDA",
  AJUSTE_OUTRO: "NEUTRO",
  INVENTARIO: "NEUTRO",
};

/**
 * Janela por defeito do extrato (últimos 30 dias) em ISO yyyy-mm-dd.
 * Vive aqui (e não no render do server component) para a página passar a
 * mesma janela ao loader e aos inputs sem chamar `Date.now()` no render
 * (regra de pureza do React/Next).
 */
export function getDefaultMovimentosWindow(): { from: string; to: string } {
  const isoDay = (d: Date) => d.toISOString().slice(0, 10);
  return {
    from: isoDay(new Date(Date.now() - DEFAULT_WINDOW_DAYS * 86_400_000)),
    to: isoDay(new Date()),
  };
}

/** Lista estática usada pelo dropdown "Tipo de movimento" na UI. */
export function getTiposDisponiveis(): Array<{ value: MovimentoTipo; label: string }> {
  return (Object.keys(TIPO_LABELS) as MovimentoTipo[]).map((v) => ({
    value: v,
    label: TIPO_LABELS[v],
  }));
}

/** Resolve o universo de farmácias a considerar. */
async function resolveFarmaciaIds(
  prisma: PrismaClient,
  filters: MovimentosFilters
): Promise<{
  ids: string[];
  nomeById: Map<string, string>;
}> {
  const farmacias = await prisma.farmacia.findMany({
    where: {
      estado: "ATIVO",
      nome: { not: "Farmácia Teste" },
      ...(filters.farmaciaIds && filters.farmaciaIds.length > 0
        ? { id: { in: filters.farmaciaIds } }
        : {}),
    },
    select: { id: true, nome: true },
  });
  return {
    ids: farmacias.map((f) => f.id),
    nomeById: new Map(farmacias.map((f) => [f.id, f.nome])),
  };
}

/**
 * Carrega e agrega o extrato de movimentos de um produto.
 * Retorna array ordenado por data desc (mais recente primeiro).
 */
export async function getMovimentosProduto(
  cnp: number,
  filters: MovimentosFilters = {}
): Promise<MovimentoRow[]> {
  const prisma = await getPrisma();
  // 1. Resolver produto
  const produto = await prisma.produto.findUnique({
    where: { cnp },
    select: { id: true },
  });
  if (!produto) return [];

  // 2. Resolver farmácias
  const { ids: farmaciaIds, nomeById } = await resolveFarmaciaIds(prisma, filters);
  if (farmaciaIds.length === 0) return [];

  // 3. Janela temporal EFECTIVA — aplicada a TODOS os tipos de movimento.
  // Decisão operacional: por defeito o extrato mostra APENAS os últimos 30
  // dias (vendas, compras, devoluções, ajustes, inventário). Não se mistura
  // histórico antigo por defeito — uma receção de 2024 só aparece quando o
  // utilizador alarga `Desde`/`Até`. Sem `from` explícito ⇒ today−30d;
  // sem `to` ⇒ agora (fim do dia).
  const effFrom = filters.from
    ? new Date(filters.from)
    : new Date(Date.now() - DEFAULT_WINDOW_DAYS * 86_400_000);
  const effTo = filters.to ? new Date(filters.to) : new Date();
  effTo.setHours(23, 59, 59, 999);
  const dateFilter = { gte: effFrom, lte: effTo };

  // 4. Queries em paralelo — só para o produto em questão, dentro da janela.
  const commonWhere = {
    produtoId: produto.id,
    farmaciaId: { in: farmaciaIds },
    data: dateFilter,
  };

  // VendaMensal filtra por (ano, mes) e não por DateTime — traduz-se a mesma
  // janela efectiva para o par ano/mês, inclusivo nas duas pontas.
  const vmWhere: {
    produtoId: string;
    farmaciaId: { in: string[] };
    AND: Array<Record<string, unknown>>;
  } = {
    produtoId: produto.id,
    farmaciaId: { in: farmaciaIds },
    AND: [
      {
        OR: [
          { ano: { gt: effFrom.getFullYear() } },
          { ano: effFrom.getFullYear(), mes: { gte: effFrom.getMonth() + 1 } },
        ],
      },
      {
        OR: [
          { ano: { lt: effTo.getFullYear() } },
          { ano: effTo.getFullYear(), mes: { lte: effTo.getMonth() + 1 } },
        ],
      },
    ],
  };

  const [vendas, compras, devolucoes, ajustes, linhasInventario] = await Promise.all([
    prisma.venda.findMany({
      where: commonWhere,
      select: {
        id: true,
        data: true,
        farmaciaId: true,
        quantidade: true,
        tipoVenda: true,
      },
      orderBy: { data: "desc" },
    }),
    prisma.compra.findMany({
      where: commonWhere,
      select: {
        id: true,
        data: true,
        farmaciaId: true,
        quantidade: true,
        valorTotal: true,
        numeroDocumento: true,
        fornecedor: { select: { nomeNormalizado: true } },
      },
      orderBy: { data: "desc" },
    }),
    prisma.devolucao.findMany({
      where: commonWhere,
      select: {
        id: true,
        data: true,
        farmaciaId: true,
        quantidade: true,
        valor: true,
        tipo: true,
        motivo: true,
        fornecedorDestino: { select: { nomeNormalizado: true } },
      },
      orderBy: { data: "desc" },
    }),
    prisma.ajusteStock.findMany({
      where: commonWhere,
      select: {
        id: true,
        data: true,
        farmaciaId: true,
        quantidade: true,
        valor: true,
        tipo: true,
        motivo: true,
        observacoes: true,
      },
      orderBy: { data: "desc" },
    }),
    prisma.linhaInventario.findMany({
      where: {
        produtoId: produto.id,
        inventario: {
          farmaciaId: { in: farmaciaIds },
          dataInventario: dateFilter,
        },
      },
      select: {
        id: true,
        stockSistema: true,
        stockContado: true,
        diferenca: true,
        valorDiferenca: true,
        observacoes: true,
        inventario: {
          select: { dataInventario: true, farmaciaId: true, nome: true },
        },
      },
    }),
  ]);

  // Vendas: granularidade DIÁRIA (raw, janela recente) OU MENSAL
  // (VendaMensal, histórico longo) — nunca as duas na mesma vista, para não
  // duplicar a mesma venda. Auto-decidida pela janela.
  const granularity = decideGranularity(filters, effFrom);

  type VendaMensalRow = {
    id: string;
    farmaciaId: string;
    ano: number;
    mes: number;
    quantidade: unknown;
    valorBruto: unknown;
    valorTotal: unknown;
  };
  let vendasMensais: VendaMensalRow[] = [];
  let vendasDiarias: Array<{ dia: Date; farmaciaId: string; qtd: number; valor: number }> = [];

  if (granularity === "diaria") {
    // Readonly sobre IngestVendaLinhaRaw, agregado por dia, dentro da MESMA
    // janela efectiva dos restantes movimentos. Mesma convenção de sinal que a
    // agregação VendaMensal (VENDA=+ABS, DEVOLUCAO=−ABS).
    vendasDiarias = await prisma.$queryRaw<Array<{ dia: Date; farmaciaId: string; qtd: number; valor: number }>>(
      Prisma.sql`
        SELECT date_trunc('day', "dataVenda") AS dia, "farmaciaId",
          SUM(CASE "tipoDocumentoClass"
            WHEN 'VENDA'              THEN  ABS(COALESCE("quantidade", 0))
            WHEN 'DEVOLUCAO_ANULACAO' THEN -ABS(COALESCE("quantidade", 0))
            ELSE 0 END)::float AS qtd,
          SUM(CASE "tipoDocumentoClass"
            WHEN 'VENDA'              THEN  ABS(COALESCE("valorLinha", 0))
            WHEN 'DEVOLUCAO_ANULACAO' THEN -ABS(COALESCE("valorLinha", 0))
            ELSE 0 END)::float AS valor
        FROM "IngestVendaLinhaRaw"
        WHERE "produtoId" = ${produto.id}
          AND "tipoDocumentoClass" IN ('VENDA', 'DEVOLUCAO_ANULACAO')
          AND "dataVenda" >= ${effFrom} AND "dataVenda" <= ${effTo}
          AND "farmaciaId" = ANY(${farmaciaIds})
        GROUP BY 1, 2
        ORDER BY 1 DESC
      `,
    );
  } else {
    // Fonte sintética: vendas mensais agregadas. Uma linha por
    // (produto, farmácia, ano, mes). Não é transacional — é soma.
    vendasMensais = await prisma.vendaMensal.findMany({
      where: vmWhere,
      select: { id: true, farmaciaId: true, ano: true, mes: true, quantidade: true, valorBruto: true, valorTotal: true },
      orderBy: [{ ano: "desc" }, { mes: "desc" }],
    });
  }

  // 5. Normalizar tudo num único shape
  const rows: MovimentoRow[] = [];

  for (const v of vendas) {
    rows.push({
      key: `venda:${v.id}`,
      data: v.data.toISOString(),
      farmaciaId: v.farmaciaId,
      farmacia: nomeById.get(v.farmaciaId) ?? "—",
      tipo: "VENDA",
      tipoLabel: TIPO_LABELS.VENDA,
      direcao: TIPO_DIRECAO.VENDA,
      documento: v.tipoVenda ? `Tipo: ${v.tipoVenda}` : null,
      quantidade: Math.abs(Math.round(toF(v.quantidade))),
      valor: null,
      origem: null,
      stockAntes: null,
      stockDepois: null,
      utilizador: null,
      observacao: null,
      agregado: false,
    });
  }

  for (const c of compras) {
    rows.push({
      key: `compra:${c.id}`,
      data: c.data.toISOString(),
      farmaciaId: c.farmaciaId,
      farmacia: nomeById.get(c.farmaciaId) ?? "—",
      tipo: "COMPRA",
      tipoLabel: TIPO_LABELS.COMPRA,
      direcao: TIPO_DIRECAO.COMPRA,
      // Documento real só quando existe; as compras agregadas (produto-dia-
      // fornecedor) não têm nº de documento individual → "—" na UI.
      documento: c.numeroDocumento ?? null,
      quantidade: Math.abs(Math.round(toF(c.quantidade))),
      valor: c.valorTotal != null ? Math.abs(toF(c.valorTotal)) : null,
      origem: c.fornecedor?.nomeNormalizado ?? null,
      stockAntes: null,
      stockDepois: null,
      utilizador: null,
      observacao: null,
      // Sem documento individual = linha agregada (dia × fornecedor). Marcada
      // para a UI sinalizar "agregado" e não a confundir com documento real.
      agregado: c.numeroDocumento == null,
    });
  }

  for (const d of devolucoes) {
    const tipo: MovimentoTipo =
      d.tipo === "FORNECEDOR"
        ? "DEVOLUCAO_FORNECEDOR"
        : d.tipo === "CLIENTE"
          ? "DEVOLUCAO_CLIENTE"
          : "DEVOLUCAO_OUTRA";
    rows.push({
      key: `devolucao:${d.id}`,
      data: d.data.toISOString(),
      farmaciaId: d.farmaciaId,
      farmacia: nomeById.get(d.farmaciaId) ?? "—",
      tipo,
      tipoLabel: TIPO_LABELS[tipo],
      direcao: TIPO_DIRECAO[tipo],
      // Devolução não tem nº de documento individual nesta fase → "—".
      // O fornecedor (destino) e o motivo vão para Observação (não inventamos
      // um "documento" a partir do nome do fornecedor).
      documento: null,
      quantidade: Math.abs(Math.round(toF(d.quantidade))),
      valor: d.valor != null ? Math.abs(toF(d.valor)) : null,
      origem: d.fornecedorDestino?.nomeNormalizado ?? null,
      stockAntes: null,
      stockDepois: null,
      utilizador: null,
      observacao: d.motivo ?? null,
      agregado: false,
    });
  }

  for (const a of ajustes) {
    const tipo: MovimentoTipo =
      a.tipo === "POSITIVO"
        ? "AJUSTE_POSITIVO"
        : a.tipo === "NEGATIVO"
          ? "AJUSTE_NEGATIVO"
          : a.tipo === "CORRECAO"
            ? "AJUSTE_CORRECAO"
            : a.tipo === "QUEBRA"
              ? "QUEBRA"
              : a.tipo === "PERDA"
                ? "PERDA"
                : "AJUSTE_OUTRO";
    rows.push({
      key: `ajuste:${a.id}`,
      data: a.data.toISOString(),
      farmaciaId: a.farmaciaId,
      farmacia: nomeById.get(a.farmaciaId) ?? "—",
      tipo,
      tipoLabel: TIPO_LABELS[tipo],
      direcao: TIPO_DIRECAO[tipo],
      documento: null,
      quantidade: Math.abs(Math.round(toF(a.quantidade))),
      valor: a.valor != null ? Math.abs(toF(a.valor)) : null,
      origem: null,
      stockAntes: null,
      stockDepois: null,
      utilizador: null,
      observacao: a.motivo || a.observacoes || null,
      agregado: false,
    });
  }

  for (const li of linhasInventario) {
    const diferenca = toF(li.diferenca);
    rows.push({
      key: `inv:${li.id}`,
      data: li.inventario.dataInventario.toISOString(),
      farmaciaId: li.inventario.farmaciaId,
      farmacia: nomeById.get(li.inventario.farmaciaId) ?? "—",
      tipo: "INVENTARIO",
      tipoLabel: TIPO_LABELS.INVENTARIO,
      direcao:
        diferenca > 0 ? "ENTRADA" : diferenca < 0 ? "SAIDA" : "NEUTRO",
      documento: li.inventario.nome ?? null,
      quantidade: Math.abs(Math.round(diferenca)),
      valor: li.valorDiferenca != null ? Math.abs(toF(li.valorDiferenca)) : null,
      origem: null,
      stockAntes: li.stockSistema !== null ? Math.round(toF(li.stockSistema)) : null,
      stockDepois: Math.round(toF(li.stockContado)),
      utilizador: null,
      observacao: li.observacoes ?? null,
      agregado: false,
    });
  }

  // VendaMensal → uma linha sintética por mês/farmácia. Data = último
  // dia do mês (para ordenação cronológica junto com os transacionais
  // quando existirem). Marcada como `agregado: true` para a UI sinalizar.
  for (const vm of vendasMensais) {
    const qty = Math.round(toF(vm.quantidade));
    if (qty <= 0) continue;
    // new Date(year, monthIndex1based, 0) = último dia do monthIndex1based
    const endOfMonth = new Date(vm.ano, vm.mes, 0, 23, 59, 59);
    rows.push({
      key: `vm:${vm.id}`,
      data: endOfMonth.toISOString(),
      farmaciaId: vm.farmaciaId,
      farmacia: nomeById.get(vm.farmaciaId) ?? "—",
      tipo: "VENDA",
      tipoLabel: "Venda (mensal)",
      direcao: "SAIDA",
      documento: null,
      quantidade: qty,
      valor: vm.valorBruto != null ? Math.abs(toF(vm.valorBruto)) : (vm.valorTotal != null ? Math.abs(toF(vm.valorTotal)) : null),
      origem: null,
      stockAntes: null,
      stockDepois: null,
      utilizador: null,
      observacao: "Total do mês — agregado, não venda-a-venda",
      agregado: true,
    });
  }

  // Vendas diárias (raw agregado por dia) — vista operacional recente.
  // net = vendas − devoluções do dia; net<0 (devoluções > vendas) → ENTRADA.
  for (const d of vendasDiarias) {
    const net = Math.round(toF(d.qtd));
    if (net === 0) continue;
    rows.push({
      key: `vd:${d.farmaciaId}:${d.dia.toISOString().slice(0, 10)}`,
      data: d.dia.toISOString(),
      farmaciaId: d.farmaciaId,
      farmacia: nomeById.get(d.farmaciaId) ?? "—",
      tipo: "VENDA",
      tipoLabel: "Venda (diária)",
      direcao: net >= 0 ? "SAIDA" : "ENTRADA",
      documento: null,
      quantidade: Math.abs(net),
      valor: Math.abs(Math.round(toF(d.valor) * 100) / 100),
      origem: null,
      stockAntes: null,
      stockDepois: null,
      utilizador: null,
      observacao: "Total diário de vendas líquidas",
      // É um agregado (soma do dia), não venda-a-venda → badge "agregado" + UI
      // mostra documento/utilizador/stock como "—" (não inventa).
      agregado: true,
    });
  }

  // 6. Filtrar por tipos pedidos (aplicado em JS — é barato sobre o
  //    universo já reduzido por produto/farmácia/data)
  const tipoSet =
    filters.tipos && filters.tipos.length > 0 ? new Set(filters.tipos) : null;
  const filtered = tipoSet ? rows.filter((r) => tipoSet.has(r.tipo)) : rows;

  // 7. Ordenar por data desc
  filtered.sort((a, b) => b.data.localeCompare(a.data));

  return filtered;
}
