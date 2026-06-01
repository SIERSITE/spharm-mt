/**
 * lib/reporting/adapters/inventario.ts
 *
 * Converte os dados de Inventário (vista Por Produto) para o `Report`
 * comum. A vista executiva Por Farmácia tem o seu próprio builder
 * (`buildInventarioPorFarmaciaReport`) porque é uma tabela de KPIs e
 * usa colunas diferentes.
 *
 * Mantém-se a mesma estrutura visual dos adapters existentes:
 * `colgroup` com larguras em %, summary com KPIs, filtros impressos
 * cabeçalho-style.
 */

import type {
  Report,
  ReportColumn,
  ReportFilter,
  ReportRow,
  ReportSummaryItem,
} from "../report-types";
import type {
  InventarioRow,
  InventarioPorFarmaciaRow,
  InventarioPorGrupoRow,
  EstadoInventario,
} from "@/lib/inventario-data";
import type { SharedReportFilters } from "@/lib/reporting/filters-shared";

const ESTADO_LABEL: Record<EstadoInventario, string> = {
  NORMAL: "Normal",
  ROTURA: "Rotura",
  EXCESSO: "Excesso",
  SEM_MOVIMENTO: "Sem movimento",
  SEM_CUSTO: "Sem custo",
  SEM_STOCK: "Sem stock",
};

// Larguras somam 100 (landscape ~277mm úteis).
//   CNP 6 · Descrição 22 · Categoria 11 · Farmácia 11 ·
//   Stock 5 · Mín 5 · PMC 5 · PVP 6 · Valor 7 · Últ. venda 8 ·
//   Dias s/v 5 · Cobertura 5 · Estado 4   = 100
const INVENTARIO_COLUMNS: ReportColumn[] = [
  { key: "cnp",             label: "CNP",            format: "text",     width: 6 },
  { key: "designacao",      label: "Descrição",      format: "text",     width: 22 },
  { key: "categoria",       label: "Categoria",      format: "text",     width: 11 },
  { key: "farmacia",        label: "Farmácia",       format: "text",     width: 11 },
  { key: "stockAtual",      label: "Stock",          format: "integer",  width: 5,  showTotal: true },
  { key: "stockMinimo",     label: "Mín.",           format: "integer",  width: 5 },
  { key: "pmc",             label: "PMC",            format: "currency", width: 5 },
  { key: "pvp",             label: "PVP",            format: "currency", width: 6 },
  { key: "valorStock",      label: "Valor stock",    format: "currency", width: 7,  showTotal: true },
  { key: "dataUltimaVenda", label: "Últ. venda",     format: "text",     width: 8 },
  { key: "diasSemVenda",    label: "Dias s/v",       format: "integer",  width: 5 },
  { key: "coberturaDias",   label: "Cobertura (d)",  format: "integer",  width: 5 },
  { key: "estado",          label: "Estado",         format: "text",     width: 4 },
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
  if (f.pesquisa && f.pesquisa.trim()) {
    out.push({ label: "Pesquisa", value: f.pesquisa.trim() });
  }
  if (f.apenasSemClassif) {
    out.push({ label: "Apenas sem classificação", value: "Sim" });
  }
  return out;
}

function fmtDay(iso: string | null): string {
  if (!iso) return "—";
  return iso.slice(0, 10);
}

export function buildInventarioReport(input: {
  rows: InventarioRow[];
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
    stockAtual: r.stockAtual ?? 0,
    stockMinimo: r.stockMinimo ?? 0,
    pmc: r.pmc ?? 0,
    pvp: r.pvp ?? 0,
    valorStock: r.valorStock ?? 0,
    dataUltimaVenda: fmtDay(r.dataUltimaVenda),
    diasSemVenda: r.diasSemVenda ?? 0,
    coberturaDias: r.coberturaDias ?? 0,
    estado: ESTADO_LABEL[r.estado],
  }));

  // Summary: KPIs operacionais que dão o quadro geral do dataset.
  const counts: Record<EstadoInventario, number> = {
    NORMAL: 0,
    ROTURA: 0,
    EXCESSO: 0,
    SEM_MOVIMENTO: 0,
    SEM_CUSTO: 0,
    SEM_STOCK: 0,
  };
  let totalStock = 0;
  let totalValor = 0;
  for (const r of input.rows) {
    counts[r.estado]++;
    if (r.stockAtual !== null) totalStock += r.stockAtual;
    if (r.valorStock !== null) totalValor += r.valorStock;
  }
  const summary: ReportSummaryItem[] = [
    { label: "Linhas", value: input.rows.length, format: "integer" },
    { label: "Stock total (un.)", value: Math.round(totalStock), format: "integer" },
    { label: "Valor stock", value: Math.round(totalValor * 100) / 100, format: "currency" },
    { label: "Roturas", value: counts.ROTURA, format: "integer" },
    { label: "Excesso", value: counts.EXCESSO, format: "integer" },
    { label: "Sem movimento", value: counts.SEM_MOVIMENTO, format: "integer" },
    { label: "Sem custo", value: counts.SEM_CUSTO, format: "integer" },
  ];

  return {
    title: "Relatório de Inventário",
    subtitle: `Stock à data de ${new Date().toISOString().slice(0, 10)}`,
    generatedAt: new Date(),
    filtersApplied: buildFiltersLabel(input.filters, input.universe),
    summary,
    columns: INVENTARIO_COLUMNS,
    rows: rowsForReport,
    meta: {
      slug: "inventario",
      orientation: "landscape",
      organization: input.organization,
      footer: "SPharm.MT · Inventário operacional",
    },
  };
}

// ── Vista executiva — Por Farmácia ────────────────────────────────
//
// Colunas: Farmácia | Produtos | Stock total | Valor stock | Rotura |
//          Excesso | Sem movimento | Sem custo | Normal
// Não há "cobertura" agregada porque é nonsense matemático na soma.

const INVENTARIO_FARM_COLUMNS: ReportColumn[] = [
  { key: "farmacia",     label: "Farmácia",      format: "text",     width: 22 },
  { key: "numProdutos",  label: "Produtos",      format: "integer",  width: 10, showTotal: true },
  { key: "stockTotal",   label: "Stock total",   format: "integer",  width: 12, showTotal: true },
  { key: "valorStock",   label: "Valor stock",   format: "currency", width: 14, showTotal: true },
  { key: "rotura",       label: "Rotura",        format: "integer",  width: 8,  showTotal: true },
  { key: "excesso",      label: "Excesso",       format: "integer",  width: 8,  showTotal: true },
  { key: "semMovimento", label: "Sem mov.",      format: "integer",  width: 9,  showTotal: true },
  { key: "semCusto",     label: "Sem custo",     format: "integer",  width: 9,  showTotal: true },
  { key: "normal",       label: "Normal",        format: "integer",  width: 8,  showTotal: true },
];

export function buildInventarioPorFarmaciaReport(input: {
  rows: InventarioPorFarmaciaRow[];
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
    farmacia: r.farmacia,
    numProdutos: r.numProdutos,
    stockTotal: r.stockTotal,
    valorStock: r.valorStock,
    rotura: r.rotura,
    excesso: r.excesso,
    semMovimento: r.semMovimento,
    semCusto: r.semCusto,
    normal: r.normal,
  }));

  const totalProdutos = input.rows.reduce((s, r) => s + r.numProdutos, 0);
  const totalStock = input.rows.reduce((s, r) => s + r.stockTotal, 0);
  const totalValor = input.rows.reduce((s, r) => s + r.valorStock, 0);
  const totalRotura = input.rows.reduce((s, r) => s + r.rotura, 0);
  const totalSemMov = input.rows.reduce((s, r) => s + r.semMovimento, 0);

  const summary: ReportSummaryItem[] = [
    { label: "Farmácias", value: input.rows.length, format: "integer" },
    { label: "Produtos (total)", value: totalProdutos, format: "integer" },
    { label: "Stock total (un.)", value: totalStock, format: "integer" },
    { label: "Valor stock", value: Math.round(totalValor * 100) / 100, format: "currency" },
    { label: "Roturas", value: totalRotura, format: "integer" },
    { label: "Sem movimento", value: totalSemMov, format: "integer" },
  ];

  return {
    title: "Inventário por Farmácia",
    subtitle: `Snapshot ${new Date().toISOString().slice(0, 10)}`,
    generatedAt: new Date(),
    filtersApplied: buildFiltersLabel(input.filters, input.universe),
    summary,
    columns: INVENTARIO_FARM_COLUMNS,
    rows: rowsForReport,
    meta: {
      slug: "inventario-por-farmacia",
      orientation: "landscape",
      organization: input.organization,
      footer: "SPharm.MT · Inventário executivo",
    },
  };
}

// ── Vista executiva — Por Grupo Homogéneo ─────────────────────────
//
// Mesmas colunas/semantica da vista Por Farmácia, mas o header passa a
// "Grupo". Útil para olhar para roturas/excesso a nível de molécula.

const INVENTARIO_GRUPO_COLUMNS: ReportColumn[] = [
  { key: "grupo",        label: "Grupo",         format: "text",     width: 22 },
  { key: "numProdutos",  label: "Produtos",      format: "integer",  width: 10, showTotal: true },
  { key: "stockTotal",   label: "Stock total",   format: "integer",  width: 12, showTotal: true },
  { key: "valorStock",   label: "Valor stock",   format: "currency", width: 14, showTotal: true },
  { key: "rotura",       label: "Rotura",        format: "integer",  width: 8,  showTotal: true },
  { key: "excesso",      label: "Excesso",       format: "integer",  width: 8,  showTotal: true },
  { key: "semMovimento", label: "Sem mov.",      format: "integer",  width: 9,  showTotal: true },
  { key: "semCusto",     label: "Sem custo",     format: "integer",  width: 9,  showTotal: true },
  { key: "normal",       label: "Normal",        format: "integer",  width: 8,  showTotal: true },
];

export function buildInventarioPorGrupoReport(input: {
  rows: InventarioPorGrupoRow[];
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
    grupo: r.grupo,
    numProdutos: r.numProdutos,
    stockTotal: r.stockTotal,
    valorStock: r.valorStock,
    rotura: r.rotura,
    excesso: r.excesso,
    semMovimento: r.semMovimento,
    semCusto: r.semCusto,
    normal: r.normal,
  }));

  const totalProdutos = input.rows.reduce((s, r) => s + r.numProdutos, 0);
  const totalStock = input.rows.reduce((s, r) => s + r.stockTotal, 0);
  const totalValor = input.rows.reduce((s, r) => s + r.valorStock, 0);
  const totalRotura = input.rows.reduce((s, r) => s + r.rotura, 0);
  const totalSemMov = input.rows.reduce((s, r) => s + r.semMovimento, 0);

  const summary: ReportSummaryItem[] = [
    { label: "Grupos", value: input.rows.length, format: "integer" },
    { label: "Produtos (total)", value: totalProdutos, format: "integer" },
    { label: "Stock total (un.)", value: totalStock, format: "integer" },
    { label: "Valor stock", value: Math.round(totalValor * 100) / 100, format: "currency" },
    { label: "Roturas", value: totalRotura, format: "integer" },
    { label: "Sem movimento", value: totalSemMov, format: "integer" },
  ];

  return {
    title: "Inventário por Grupo",
    subtitle: `Snapshot ${new Date().toISOString().slice(0, 10)}`,
    generatedAt: new Date(),
    filtersApplied: buildFiltersLabel(input.filters, input.universe),
    summary,
    columns: INVENTARIO_GRUPO_COLUMNS,
    rows: rowsForReport,
    meta: {
      slug: "inventario-por-grupo",
      orientation: "landscape",
      organization: input.organization,
      footer: "SPharm.MT · Inventário executivo",
    },
  };
}
