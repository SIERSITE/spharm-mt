/**
 * lib/reporting/adapters/margens.ts
 *
 * Converte os dados de Margens (Por Produto / Por Categoria / Por
 * Farmácia) para o `Report` comum. Os agregados (Categoria e Farmácia)
 * usam o mesmo shape `MargensAgg` e partilham o builder genérico
 * `buildMargensAggReport` — só muda o título e o cabeçalho da primeira
 * coluna.
 *
 * Regra dura preservada: a coluna "Margem %" só recebe valor quando o
 * estado da linha é FIAVEL. Para PARCIAL e SEM_CUSTO emitimos null,
 * que o renderer pinta como "—" (vs "0%", que seria mentira).
 */

import type {
  Report,
  ReportColumn,
  ReportFilter,
  ReportRow,
  ReportSummaryItem,
} from "../report-types";
import type {
  MargemRow,
  MargensAgg,
  EstadoMargem,
} from "@/lib/margens-data";
import type { SharedReportFilters } from "@/lib/reporting/filters-shared";

const MARGEM_LABEL: Record<EstadoMargem, string> = {
  FIAVEL: "Fiável",
  PARCIAL: "Parcial",
  SEM_CUSTO: "Sem custo",
};

// Por produto: CNP 6 · Descrição 22 · Categoria 11 · Farmácia 11 ·
//              Qtd 6 · Valor vend. 9 · Custo est. 9 · Margem € 8 ·
//              Margem % 6 · Cobertura 6 · Estado 6   = 100
const MARGENS_PRODUTO_COLUMNS: ReportColumn[] = [
  { key: "cnp",            label: "CNP",          format: "text",     width: 6 },
  { key: "designacao",     label: "Descrição",    format: "text",     width: 22 },
  { key: "categoria",      label: "Categoria",    format: "text",     width: 11 },
  { key: "farmacia",       label: "Farmácia",     format: "text",     width: 11 },
  { key: "qtdVendida",     label: "Qtd",          format: "integer",  width: 6,  showTotal: true },
  { key: "valorVendido",   label: "Valor vend.",  format: "currency", width: 9,  showTotal: true },
  { key: "custoEstimado",  label: "Custo est.",   format: "currency", width: 9,  showTotal: true },
  { key: "margemEur",      label: "Margem €",     format: "currency", width: 8,  showTotal: true },
  { key: "margemPct",      label: "Margem %",     format: "text",     width: 6 },
  { key: "coberturaPct",   label: "Cobert.",      format: "text",     width: 6 },
  { key: "estado",         label: "Estado",       format: "text",     width: 6 },
];

function joinList(list: string[] | undefined, total: number, labelTodas: string): string {
  if (!list || list.length === 0) return labelTodas;
  if (list.length === total) return labelTodas;
  if (list.length <= 3) return list.join(", ");
  return `${list.slice(0, 3).join(", ")} (+${list.length - 3})`;
}

function buildFiltersLabel(
  f: SharedReportFilters,
  universe: {
    farmacias: string[];
    categorias: string[];
    fabricantes: string[];
    distribuidores: string[];
  },
): ReportFilter[] {
  const out: ReportFilter[] = [];
  if (f.from && f.to) out.push({ label: "Período", value: `${f.from} a ${f.to}` });
  out.push({
    label: "Farmácias",
    value: joinList(f.farmaciaNomes, universe.farmacias.length, "Todas"),
  });
  if (f.categorias && f.categorias.length > 0) {
    out.push({
      label: "Categorias",
      value: joinList(f.categorias, universe.categorias.length, "Todas"),
    });
  }
  if (f.fabricantes && f.fabricantes.length > 0) {
    out.push({
      label: "Fabricantes",
      value: joinList(f.fabricantes, universe.fabricantes.length, "Todos"),
    });
  }
  if (f.distribuidores && f.distribuidores.length > 0) {
    out.push({
      label: "Distribuidores",
      value: joinList(f.distribuidores, universe.distribuidores.length, "Todos"),
    });
  }
  if (f.pesquisa && f.pesquisa.trim()) out.push({ label: "Pesquisa", value: f.pesquisa.trim() });
  return out;
}

function pct(n: number | null, suffix = "%"): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return `${n.toLocaleString("pt-PT", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}${suffix}`;
}

// Aviso permanente: snapshot de custo (PMC/PUC actual aplica-se ao
// período histórico). Cobertura < 50 % suprime margem; entre 50 e 95 %
// é PARCIAL e só margem € é fiável.
function commonSubtitle(): string {
  return "Custo estimado a partir de PMC/PUC actual de ProdutoFarmacia · margem % suprimida em vendas sem custo conhecido";
}

export function buildMargensProdutoReport(input: {
  rows: MargemRow[];
  filters: SharedReportFilters;
  universe: {
    farmacias: string[];
    categorias: string[];
    fabricantes: string[];
    distribuidores: string[];
  };
  organization: string;
}): Report {
  const rowsForReport: ReportRow[] = input.rows.map((r) => ({
    cnp: String(r.cnp),
    designacao: r.designacao,
    categoria: r.categoria ?? "—",
    farmacia: r.farmacia,
    qtdVendida: r.qtdVendida,
    valorVendido: r.valorVendido,
    custoEstimado: r.custoEstimado ?? 0,
    margemEur: r.margemEur ?? 0,
    margemPct: pct(r.margemPct),
    coberturaPct: pct(r.coberturaCusto * 100),
    estado: MARGEM_LABEL[r.estado],
  }));

  // KPIs globais — só sobre linhas com custo conhecido para evitar
  // valores enganadores ao nível agregado.
  let qty = 0;
  let valor = 0;
  let custo = 0;
  let margem = 0;
  let qtyCom = 0;
  for (const r of input.rows) {
    qty += r.qtdVendida;
    valor += r.valorVendido;
    if (r.custoEstimado !== null && r.margemEur !== null) {
      qtyCom += r.qtdVendida;
      custo += r.custoEstimado;
      margem += r.margemEur;
    }
  }
  const cobertura = qty > 0 ? qtyCom / qty : 0;
  const margemPctGlobal =
    cobertura >= 0.95 && valor > 0
      ? Math.round((margem / valor) * 10000) / 100
      : null;

  const summary: ReportSummaryItem[] = [
    { label: "Linhas", value: input.rows.length, format: "integer" },
    { label: "Unidades vendidas", value: Math.round(qty), format: "integer" },
    { label: "Valor vendido", value: Math.round(valor * 100) / 100, format: "currency" },
    { label: "Custo estimado", value: Math.round(custo * 100) / 100, format: "currency" },
    { label: "Margem €", value: Math.round(margem * 100) / 100, format: "currency" },
    { label: "Margem %", value: margemPctGlobal !== null ? `${margemPctGlobal}%` : "—", format: "text" },
    { label: "Cobertura", value: `${Math.round(cobertura * 1000) / 10}%`, format: "text" },
  ];

  return {
    title: "Relatório de Margens — Por Produto",
    subtitle: commonSubtitle(),
    generatedAt: new Date(),
    filtersApplied: buildFiltersLabel(input.filters, input.universe),
    summary,
    columns: MARGENS_PRODUTO_COLUMNS,
    rows: rowsForReport,
    meta: {
      slug: "margens-produto",
      orientation: "landscape",
      organization: input.organization,
      footer: "SPharm.MT · Margens operacional",
    },
  };
}

// ── Agregação genérica (Por Categoria / Por Farmácia) ─────────────

export function buildMargensAggReport(input: {
  rows: MargensAgg[];
  filters: SharedReportFilters;
  universe: {
    farmacias: string[];
    categorias: string[];
    fabricantes: string[];
    distribuidores: string[];
  };
  organization: string;
  groupBy: "categoria" | "farmacia" | "grupo";
}): Report {
  const headerLabel =
    input.groupBy === "categoria"
      ? "Categoria"
      : input.groupBy === "farmacia"
        ? "Farmácia"
        : "Grupo";
  const columns: ReportColumn[] = [
    { key: "label",          label: headerLabel,     format: "text",     width: 24 },
    { key: "qtdVendida",     label: "Qtd",           format: "integer",  width: 9,  showTotal: true },
    { key: "valorVendido",   label: "Valor vend.",   format: "currency", width: 12, showTotal: true },
    { key: "custoEstimado",  label: "Custo est.",    format: "currency", width: 12, showTotal: true },
    { key: "margemEur",      label: "Margem €",      format: "currency", width: 11, showTotal: true },
    { key: "margemPct",      label: "Margem %",      format: "text",     width: 8 },
    { key: "coberturaPct",   label: "Cobert.",       format: "text",     width: 8 },
    { key: "estado",         label: "Estado",        format: "text",     width: 8 },
  ];

  const rowsForReport: ReportRow[] = input.rows.map((r) => ({
    label: r.label,
    qtdVendida: r.qtdVendida,
    valorVendido: r.valorVendido,
    custoEstimado: r.custoEstimado,
    margemEur: r.margemEur,
    margemPct: pct(r.margemPct),
    coberturaPct: pct(r.coberturaCusto * 100),
    estado: MARGEM_LABEL[r.estado],
  }));

  const totalQty = input.rows.reduce((s, r) => s + r.qtdVendida, 0);
  const totalValor = input.rows.reduce((s, r) => s + r.valorVendido, 0);
  const totalCusto = input.rows.reduce((s, r) => s + r.custoEstimado, 0);
  const totalMargem = input.rows.reduce((s, r) => s + r.margemEur, 0);

  const summary: ReportSummaryItem[] = [
    { label: headerLabel + "s", value: input.rows.length, format: "integer" },
    { label: "Unidades vendidas", value: Math.round(totalQty), format: "integer" },
    { label: "Valor vendido", value: Math.round(totalValor * 100) / 100, format: "currency" },
    { label: "Custo estimado", value: Math.round(totalCusto * 100) / 100, format: "currency" },
    { label: "Margem €", value: Math.round(totalMargem * 100) / 100, format: "currency" },
  ];

  const titleByGroup: Record<"categoria" | "farmacia" | "grupo", string> = {
    categoria: "Relatório de Margens — Por Categoria",
    farmacia: "Relatório de Margens — Por Farmácia",
    grupo: "Relatório de Margens — Por Grupo",
  };
  const slugByGroup: Record<"categoria" | "farmacia" | "grupo", string> = {
    categoria: "margens-categoria",
    farmacia: "margens-farmacia",
    grupo: "margens-grupo",
  };

  return {
    title: titleByGroup[input.groupBy],
    subtitle: commonSubtitle(),
    generatedAt: new Date(),
    filtersApplied: buildFiltersLabel(input.filters, input.universe),
    summary,
    columns,
    rows: rowsForReport,
    meta: {
      slug: slugByGroup[input.groupBy],
      orientation: "landscape",
      organization: input.organization,
      footer: "SPharm.MT · Margens executivo",
    },
  };
}
