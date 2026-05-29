/**
 * lib/movimentos-data.ts
 *
 * Read-model do extrato de movimentos de um produto × farmácia.
 *
 * Modelo (rev36 — ERP parity):
 *   Cada linha corresponde a UMA `MovimentoArtigo` (= UMA dbo.StocksMov).
 *   Sem agregados. Sem "Venda mensal"/"Venda diária". O ERP imprime
 *   movimento-a-movimento e nós fazemos o mesmo.
 *
 * Fontes:
 *   · Farmácia com `useMovimentosCanonical=true`  → `MovimentoArtigo`
 *   · Farmácia com `useMovimentosCanonical=false` → branch legacy
 *     (Venda / Compra / Devolucao / IngestVendaLinhaRaw) — DEPRECATED.
 *     Mantém-se enquanto houver tenants pré-rev36 por migrar; quando
 *     todos forem canónicos, este branch sai.
 *
 * NÃO toca em dashboard / ingest / export-orders. Só SELECTs.
 */

import { getPrisma } from "@/lib/prisma";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";

// ── Tipos públicos ────────────────────────────────────────────────

export type MovimentoTipo =
  | "VENDA"
  | "DEVOLUCAO_CLIENTE"
  | "VENDA_CREDITO"
  | "RESERVA_SUSPENSA"
  | "COMPRA"
  | "DEVOLUCAO_FORNECEDOR"
  | "INVENTARIO"
  | "AJUSTE"
  | "QUEBRA"
  | "PERDA"
  | "TRANSFERENCIA_ENTRADA"
  | "TRANSFERENCIA_SAIDA"
  | "DESCONHECIDO"
  // ── Legacy-only (eliminados quando o branch legacy sair) ──
  | "DEVOLUCAO_OUTRA"
  | "AJUSTE_POSITIVO"
  | "AJUSTE_NEGATIVO"
  | "AJUSTE_CORRECAO"
  | "AJUSTE_OUTRO";

export type MovimentoDirecao = "ENTRADA" | "SAIDA" | "NEUTRO";

export type ContraparteTipo =
  | "CLIENTE"
  | "FORNECEDOR"
  | "FARMACIA_ORIGEM"
  | "FARMACIA_DESTINO";

export type MovimentoRow = {
  /** Chave estável dentro da timeline — fonte + id original. */
  key: string;
  /** ISO datetime; ordenação é feita sobre este campo descendente. */
  data: string;
  farmaciaId: string;
  farmacia: string;
  tipo: MovimentoTipo;
  /** Label legível (ex: "Venda", "Devolução cliente"). */
  tipoLabel: string;
  direcao: MovimentoDirecao;

  // ── Documento (ERP "Movimento de Artigos") ───────────────────
  /** Rótulo do tipo de documento ("Factura", "Recepção", "Nota Crédito"…). */
  documentoTipo: string | null;
  /** Número visível ("G/783019", "60566", "VSG/25113", "VCG_1/2169"). */
  documentoNumero: string | null;
  /** Coluna "Externo" do ERP: factura do fornecedor, talão original duma NC. */
  referenciaExterna: string | null;

  // ── Contraparte (cliente / fornecedor / farmácia) ────────────
  contraparteNome: string | null;
  contraparteTipo: ContraparteTipo | null;

  // ── Quantidades / running balance ────────────────────────────
  /** Sinal preservado: +N entrada, −N saída. */
  quantidade: number;
  /** `existenciaApos − quantidade`. Derivado. */
  stockAntes: number;
  /** `existenciaApos` no ERP. */
  stockDepois: number;
  quantidadeBonusEnt: number;
  quantidadeBonusSai: number;
  existenciaBonusApos: number;

  // ── Económicos ────────────────────────────────────────────────
  precoUnitario: number | null;
  valorLinha: number | null;
  /** PMC novo (após este movimento). */
  pmcNovo: number | null;

  // ── Metadata ──────────────────────────────────────────────────
  armazemNome: string | null;
  utilizadorNome: string | null;
  /** Motivo livre do operador (`tblMovStocksCab_Motivo`). */
  observacao: string | null;
  /** 'A' = anulado, 'N' = normal, null para vendas/compras puras. */
  situacao: string | null;
};

export type MovimentosFilters = {
  /** Se vazio/omitido, agrega todas as farmácias activas (não-Teste). */
  farmaciaIds?: string[];
  /** ISO date string inclusivo, opcional. */
  from?: string;
  to?: string;
  /** Se vazio/omitido, devolve todos os tipos. */
  tipos?: MovimentoTipo[];
};

// ── Constantes ────────────────────────────────────────────────────

/** Janela default do extrato — espelho do ERP ("Da Data: AAAA-01-01 ..hoje"). */
function startOfYearIso(d = new Date()): string {
  return `${d.getUTCFullYear()}-01-01`;
}

/**
 * Janela por defeito (ano corrente → hoje) em ISO yyyy-mm-dd.
 * Vive aqui (e não no render do server component) para a página passar
 * a mesma janela ao loader e aos inputs sem chamar `Date.now()` no render.
 */
export function getDefaultMovimentosWindow(): { from: string; to: string } {
  const isoDay = (d: Date) => d.toISOString().slice(0, 10);
  return { from: startOfYearIso(), to: isoDay(new Date()) };
}

const TIPO_LABELS: Record<MovimentoTipo, string> = {
  VENDA: "Venda",
  DEVOLUCAO_CLIENTE: "Devolução cliente",
  VENDA_CREDITO: "Venda crédito",
  RESERVA_SUSPENSA: "Reserva",
  COMPRA: "Compra / Receção",
  DEVOLUCAO_FORNECEDOR: "Devolução fornecedor",
  INVENTARIO: "Inventário",
  AJUSTE: "Ajuste",
  QUEBRA: "Quebra",
  PERDA: "Perda",
  TRANSFERENCIA_ENTRADA: "Transferência entrada",
  TRANSFERENCIA_SAIDA: "Transferência saída",
  DESCONHECIDO: "Movimento",
  DEVOLUCAO_OUTRA: "Devolução",
  AJUSTE_POSITIVO: "Ajuste positivo",
  AJUSTE_NEGATIVO: "Ajuste negativo",
  AJUSTE_CORRECAO: "Correção",
  AJUSTE_OUTRO: "Ajuste",
};

/** Lista usada pelo dropdown "Tipo de movimento" na UI. */
export function getTiposDisponiveis(): Array<{ value: MovimentoTipo; label: string }> {
  // Apenas tipos canónicos rev36 (os legacy-only ficam fora do dropdown).
  const canonical: MovimentoTipo[] = [
    "VENDA",
    "DEVOLUCAO_CLIENTE",
    "VENDA_CREDITO",
    "RESERVA_SUSPENSA",
    "COMPRA",
    "DEVOLUCAO_FORNECEDOR",
    "INVENTARIO",
    "AJUSTE",
    "QUEBRA",
    "PERDA",
    "TRANSFERENCIA_ENTRADA",
    "TRANSFERENCIA_SAIDA",
    "DESCONHECIDO",
  ];
  return canonical.map((v) => ({ value: v, label: TIPO_LABELS[v] }));
}

// ── Helpers ───────────────────────────────────────────────────────

function toF(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function direcaoForTipo(tipo: MovimentoTipo, qty: number): MovimentoDirecao {
  switch (tipo) {
    case "VENDA":
    case "VENDA_CREDITO":
    case "DEVOLUCAO_FORNECEDOR":
    case "TRANSFERENCIA_SAIDA":
    case "QUEBRA":
    case "PERDA":
    case "AJUSTE_NEGATIVO":
      return "SAIDA";
    case "COMPRA":
    case "DEVOLUCAO_CLIENTE":
    case "TRANSFERENCIA_ENTRADA":
    case "AJUSTE_POSITIVO":
      return "ENTRADA";
    case "INVENTARIO":
    case "AJUSTE":
    case "AJUSTE_CORRECAO":
    case "AJUSTE_OUTRO":
    case "DEVOLUCAO_OUTRA":
    case "RESERVA_SUSPENSA":
    case "DESCONHECIDO":
      return qty > 0 ? "ENTRADA" : qty < 0 ? "SAIDA" : "NEUTRO";
  }
}

/** Resolve o universo de farmácias a considerar + split por feature flag. */
async function resolveFarmaciaIds(
  prisma: PrismaClient,
  filters: MovimentosFilters,
): Promise<{
  ids: string[];
  nomeById: Map<string, string>;
  canonicalIds: string[];
  legacyIds: string[];
}> {
  const farmacias = await prisma.farmacia.findMany({
    where: {
      estado: "ATIVO",
      nome: { not: "Farmácia Teste" },
      ...(filters.farmaciaIds && filters.farmaciaIds.length > 0
        ? { id: { in: filters.farmaciaIds } }
        : {}),
    },
    select: { id: true, nome: true, useMovimentosCanonical: true },
  });
  return {
    ids: farmacias.map((f) => f.id),
    nomeById: new Map(farmacias.map((f) => [f.id, f.nome])),
    canonicalIds: farmacias.filter((f) => f.useMovimentosCanonical).map((f) => f.id),
    legacyIds: farmacias.filter((f) => !f.useMovimentosCanonical).map((f) => f.id),
  };
}

// ── Canónico (rev36) ──────────────────────────────────────────────

/**
 * Lê `MovimentoArtigo` para (produtoId × farmaciaIds × janela). Já no
 * shape final `MovimentoRow` que a UI consome. Sem JOINs adicionais —
 * todos os campos vêm directamente da tabela (foram populados pelo
 * agent rev36 a partir dos JOINs SoftReis).
 */
async function readCanonicalMovimentos(
  prisma: PrismaClient,
  produtoId: string,
  farmaciaIds: string[],
  effFrom: Date,
  effTo: Date,
  nomeById: Map<string, string>,
): Promise<MovimentoRow[]> {
  if (farmaciaIds.length === 0) return [];
  const rows = await prisma.movimentoArtigo.findMany({
    where: {
      produtoId,
      farmaciaId: { in: farmaciaIds },
      dataMovimento: { gte: effFrom, lte: effTo },
    },
    select: {
      id: true,
      farmaciaId: true,
      dataMovimento: true,
      tipo: true,
      quantidade: true,
      existenciaApos: true,
      // ── rev36 — ERP parity ────────────────────────────────
      documentoTipo: true,
      documentoNumero: true,
      referenciaExterna: true,
      contraparteNome: true,
      contraparteTipo: true,
      armazemNome: true,
      utilizadorNome: true,
      quantidadeBonusEnt: true,
      quantidadeBonusSai: true,
      existenciaBonusApos: true,
      precoUnitario: true,
      valorLinha: true,
      pmcNovo: true,
      // ── Legacy enrichment (para fallback de display em rows pré-rev36) ──
      custoUnitario: true,
      movStocksCabNDocExterno: true,
      movStocksCabMotivoTexto: true,
      movStocksCabSituacao: true,
      externalSaleId: true,
      externalRecpDetalheId: true,
      externalDevolucaoDetalheId: true,
    },
    orderBy: { dataMovimento: "desc" },
  });

  return rows.map((r): MovimentoRow => {
    const qty = r.quantidade;
    const tipo = r.tipo as MovimentoTipo;
    const direcao = direcaoForTipo(tipo, qty);
    const existencia = r.existenciaApos;

    // Fallback display para rows uploaded por agents pré-rev36 (não têm
    // documentoNumero populado): cair para o que existe.
    const documentoNumeroFallback =
      r.movStocksCabNDocExterno ??
      (r.externalSaleId != null
        ? `#${r.externalSaleId}`
        : r.externalRecpDetalheId != null
          ? `Rec #${r.externalRecpDetalheId}`
          : r.externalDevolucaoDetalheId != null
            ? `Dev #${r.externalDevolucaoDetalheId}`
            : null);

    return {
      key: `mov:${r.id}`,
      data: r.dataMovimento.toISOString(),
      farmaciaId: r.farmaciaId,
      farmacia: nomeById.get(r.farmaciaId) ?? "—",
      tipo,
      tipoLabel: TIPO_LABELS[tipo],
      direcao,
      documentoTipo: r.documentoTipo,
      documentoNumero: r.documentoNumero ?? documentoNumeroFallback,
      referenciaExterna: r.referenciaExterna,
      contraparteNome: r.contraparteNome,
      contraparteTipo: r.contraparteTipo as ContraparteTipo | null,
      quantidade: qty,
      stockAntes: existencia - qty,
      stockDepois: existencia,
      quantidadeBonusEnt: r.quantidadeBonusEnt,
      quantidadeBonusSai: r.quantidadeBonusSai,
      existenciaBonusApos: r.existenciaBonusApos,
      precoUnitario:
        r.precoUnitario != null
          ? toF(r.precoUnitario)
          : r.custoUnitario != null
            ? toF(r.custoUnitario)
            : null,
      valorLinha: r.valorLinha != null ? toF(r.valorLinha) : null,
      pmcNovo: r.pmcNovo != null ? toF(r.pmcNovo) : null,
      armazemNome: r.armazemNome,
      utilizadorNome: r.utilizadorNome,
      observacao: r.movStocksCabMotivoTexto?.trim() || null,
      situacao: r.movStocksCabSituacao,
    };
  });
}

// ── Legacy (deprecated; só corre para farmácias pré-rev36) ────────

/**
 * Branch legacy. Lê Venda/Compra/Devolucao/IngestVendaLinhaRaw e devolve
 * no shape `MovimentoRow`. Conceitualmente é UMA aproximação (vendas
 * vêm agregadas por dia/mês porque nunca foram per-row no legacy) e
 * por isso a coluna "Documento" fica fraca. Para fechar este branch é
 * preciso activar a flag `useMovimentosCanonical` na farmácia.
 */
async function readLegacyMovimentos(
  prisma: PrismaClient,
  produtoId: string,
  legacyIds: string[],
  effFrom: Date,
  effTo: Date,
  nomeById: Map<string, string>,
): Promise<MovimentoRow[]> {
  if (legacyIds.length === 0) return [];
  const commonWhere = {
    produtoId,
    farmaciaId: { in: legacyIds },
    data: { gte: effFrom, lte: effTo },
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
        produtoId,
        inventario: {
          farmaciaId: { in: legacyIds },
          dataInventario: { gte: effFrom, lte: effTo },
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

  // Vendas individuais (sem agregação) — uma linha por Venda.
  const rows: MovimentoRow[] = [];
  for (const v of vendas) {
    const qty = -Math.abs(toF(v.quantidade));
    rows.push(legacyRow({
      key: `venda:${v.id}`,
      farmaciaId: v.farmaciaId,
      data: v.data,
      tipo: "VENDA",
      quantidade: qty,
      documentoTipo: "Factura",
      documentoNumero: v.tipoVenda ? `Tipo ${v.tipoVenda}` : null,
      contraparteNome: null,
      contraparteTipo: null,
      valorLinha: null,
      observacao: null,
      nomeById,
    }));
  }
  for (const c of compras) {
    rows.push(legacyRow({
      key: `compra:${c.id}`,
      farmaciaId: c.farmaciaId,
      data: c.data,
      tipo: "COMPRA",
      quantidade: Math.abs(toF(c.quantidade)),
      documentoTipo: "Recepção",
      documentoNumero: c.numeroDocumento ?? null,
      contraparteNome: c.fornecedor?.nomeNormalizado ?? null,
      contraparteTipo: c.fornecedor ? "FORNECEDOR" : null,
      valorLinha: c.valorTotal != null ? Math.abs(toF(c.valorTotal)) : null,
      observacao: null,
      nomeById,
    }));
  }
  for (const d of devolucoes) {
    const tipo: MovimentoTipo =
      d.tipo === "FORNECEDOR"
        ? "DEVOLUCAO_FORNECEDOR"
        : d.tipo === "CLIENTE"
          ? "DEVOLUCAO_CLIENTE"
          : "DEVOLUCAO_OUTRA";
    const sign = tipo === "DEVOLUCAO_FORNECEDOR" ? -1 : 1;
    rows.push(legacyRow({
      key: `devolucao:${d.id}`,
      farmaciaId: d.farmaciaId,
      data: d.data,
      tipo,
      quantidade: sign * Math.abs(toF(d.quantidade)),
      documentoTipo: tipo === "DEVOLUCAO_CLIENTE" ? "Nota Crédito" : "Devolução",
      documentoNumero: null,
      contraparteNome: d.fornecedorDestino?.nomeNormalizado ?? null,
      contraparteTipo: d.fornecedorDestino ? "FORNECEDOR" : null,
      valorLinha: d.valor != null ? Math.abs(toF(d.valor)) : null,
      observacao: d.motivo ?? null,
      nomeById,
    }));
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
    const qty = toF(a.quantidade);
    rows.push(legacyRow({
      key: `ajuste:${a.id}`,
      farmaciaId: a.farmaciaId,
      data: a.data,
      tipo,
      quantidade: qty,
      documentoTipo: "Ajuste",
      documentoNumero: null,
      contraparteNome: null,
      contraparteTipo: null,
      valorLinha: a.valor != null ? Math.abs(toF(a.valor)) : null,
      observacao: a.motivo || a.observacoes || null,
      nomeById,
    }));
  }
  for (const li of linhasInventario) {
    const qty = toF(li.diferenca);
    rows.push(legacyRow({
      key: `inv:${li.id}`,
      farmaciaId: li.inventario.farmaciaId,
      data: li.inventario.dataInventario,
      tipo: "INVENTARIO",
      quantidade: qty,
      documentoTipo: "Inventário",
      documentoNumero: li.inventario.nome ?? null,
      contraparteNome: null,
      contraparteTipo: null,
      valorLinha: li.valorDiferenca != null ? Math.abs(toF(li.valorDiferenca)) : null,
      observacao: li.observacoes ?? null,
      nomeById,
    }));
  }
  return rows;
}

function legacyRow(args: {
  key: string;
  farmaciaId: string;
  data: Date;
  tipo: MovimentoTipo;
  quantidade: number;
  documentoTipo: string | null;
  documentoNumero: string | null;
  contraparteNome: string | null;
  contraparteTipo: ContraparteTipo | null;
  valorLinha: number | null;
  observacao: string | null;
  nomeById: Map<string, string>;
}): MovimentoRow {
  return {
    key: args.key,
    data: args.data.toISOString(),
    farmaciaId: args.farmaciaId,
    farmacia: args.nomeById.get(args.farmaciaId) ?? "—",
    tipo: args.tipo,
    tipoLabel: TIPO_LABELS[args.tipo],
    direcao: direcaoForTipo(args.tipo, args.quantidade),
    documentoTipo: args.documentoTipo,
    documentoNumero: args.documentoNumero,
    referenciaExterna: null,
    contraparteNome: args.contraparteNome,
    contraparteTipo: args.contraparteTipo,
    quantidade: args.quantidade,
    // Stock antes/depois desconhecido no legacy — sem running balance.
    stockAntes: 0,
    stockDepois: 0,
    quantidadeBonusEnt: 0,
    quantidadeBonusSai: 0,
    existenciaBonusApos: 0,
    precoUnitario: null,
    valorLinha: args.valorLinha,
    pmcNovo: null,
    armazemNome: null,
    utilizadorNome: null,
    observacao: args.observacao,
    situacao: null,
  };
}

// ── Entry point ───────────────────────────────────────────────────

/**
 * Carrega o extrato de movimentos de um produto. Devolve array ordenado
 * por data desc (mais recente primeiro). Ignora `Prisma`/`PrismaClient`
 * exterior — usa o cliente partilhado via `getPrisma()`.
 */
export async function getMovimentosProduto(
  cnp: number,
  filters: MovimentosFilters = {},
): Promise<MovimentoRow[]> {
  const prisma = await getPrisma();
  // 1. Resolver produto
  const produto = await prisma.produto.findUnique({
    where: { cnp },
    select: { id: true },
  });
  if (!produto) return [];

  // 2. Resolver farmácias + split por flag canónica
  const { ids: farmaciaIds, nomeById, canonicalIds, legacyIds } =
    await resolveFarmaciaIds(prisma, filters);
  if (farmaciaIds.length === 0) return [];

  // 3. Janela. Sem `from` ⇒ início do ano corrente. Sem `to` ⇒ agora.
  const effFrom = filters.from
    ? new Date(filters.from)
    : new Date(`${startOfYearIso()}T00:00:00Z`);
  const effTo = filters.to ? new Date(filters.to) : new Date();
  effTo.setHours(23, 59, 59, 999);

  // 4. Buscar das duas streams (mutuamente exclusivas por farmácia)
  const [canonicalRows, legacyRows] = await Promise.all([
    readCanonicalMovimentos(prisma, produto.id, canonicalIds, effFrom, effTo, nomeById),
    readLegacyMovimentos(prisma, produto.id, legacyIds, effFrom, effTo, nomeById),
  ]);

  // 5. Merge + filtro de tipos + ordem desc por data
  let rows = [...canonicalRows, ...legacyRows];
  if (filters.tipos && filters.tipos.length > 0) {
    const set = new Set(filters.tipos);
    rows = rows.filter((r) => set.has(r.tipo));
  }
  rows.sort((a, b) => b.data.localeCompare(a.data));
  return rows;
}

// Prisma import preservado para callers que necessitem do tipo (re-export
// implícito via type imports). Não é usado runtime nesta versão.
void Prisma;
