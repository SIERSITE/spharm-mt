"use client";

/**
 * components/inventario/inventario-client.tsx
 *
 * Cliente do relatório de Inventário. Duas vistas commutáveis:
 *   1. Por produto  — 1 linha por (CNP × farmácia), com chips de
 *                     estado, agrupamento Artigo/Farmácia/Grupo, e
 *                     ordenação por descrição (default).
 *   2. Por farmácia — KPIs executivos por farmácia: nº produtos,
 *                     stock total, valor stock, contagens de estado.
 *
 * Reutiliza:
 *   · <AppShell>                  layout principal
 *   · <ReportFiltersBar>          filtros canónicos partilhados
 *   · <ReportActions>             export CSV/XLSX/PDF/Print/Email
 *   · SharedReportFilters         tipo de filtros
 *   · buildInventarioReport       adapter Por Produto
 *   · buildInventarioPorFarmaciaReport  adapter Por Farmácia
 */

import { SEM_CLASSIFICACAO_LABEL } from "@/lib/categoria-resolver";
import { useEffect, useMemo, useState, useTransition } from "react";
import { useSearchParams, usePathname } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";
import { ArtigoLink } from "@/components/stock/artigo-link";
import { ReportFiltersBar } from "@/components/reporting/report-filters-bar";
import { useUtilizador } from "@/components/layout/session-provider";
import { useTaskBar } from "@/lib/workspace/task-bar-context";
import { useWorkspaceState } from "@/lib/workspace/use-workspace-state";
import type { ListaCodigosResolvida } from "@/lib/produtos/lista-codigos-tipos";
import { CabecalhoOrdenavel } from "@/components/ui/cabecalho-ordenavel";
import {
  ordenarLinhas,
  proximaOrdenacao,
  type EstadoOrdenacao,
  type ValorOrdenavel,
} from "@/lib/tabela/ordenacao";
import { ReportActions } from "@/components/reporting/report-actions";
import { runInventarioReport } from "@/app/relatorios/inventario/actions";
import type {
  ReportFilterOptions,
  SharedReportFilters,
} from "@/lib/reporting/filters-shared";
import {
  buildInventarioReport,
  buildInventarioPorFarmaciaReport,
  buildInventarioPorGrupoReport,
  buildInventarioPorIvaReport,
} from "@/lib/reporting/adapters/inventario";
import type {
  InventarioResult,
  InventarioRow,
  InventarioPorFarmaciaRow,
  InventarioPorGrupoRow,
  InventarioPorIvaRow,
  EstadoInventario,
} from "@/lib/inventario-data";
import { formatFarmaciaHeader, type FarmaciaInfo } from "@/lib/farmacias-header";
import type { ReportingFilterOptions } from "@/lib/reporting-filter-options";
import { AlertTriangle } from "lucide-react";

type Vista = "produto" | "farmacia" | "grupo" | "iva";
// "Grupo" foi promovido a vista top-level — dentro da vista "Por produto"
// mantemos só artigo/farmácia para não duplicar a função.
type AgrupamentoProduto = "artigo" | "farmacia";

/**
 * Critérios de UMA sessão de análise (workspace) de Inventário: filtros
 * partilhados, lista de CNP, vista, agrupamento, chip de estado e
 * ordenação de cabeçalho. NUNCA inclui `result` — ver
 * `lib/workspace/use-workspace-state.ts`.
 */
type InventarioCriterios = {
  filters: SharedReportFilters;
  lista: ListaCodigosResolvida | null;
  vista: Vista;
  agrupamento: AgrupamentoProduto;
  estadoChip: "todos" | EstadoInventario;
  ordenacaoTabela: EstadoOrdenacao<ColunaInventario>;
};

const ESTADO_LABEL: Record<EstadoInventario, string> = {
  NORMAL: "Normal",
  ROTURA: "Rotura",
  EXCESSO: "Excesso",
  SEM_MOVIMENTO: "Sem movimento",
  SEM_CUSTO: "Sem custo",
  SEM_STOCK: "Sem stock",
};

const ESTADO_BADGE: Record<EstadoInventario, string> = {
  NORMAL: "border-emerald-200 bg-emerald-50 text-emerald-700",
  ROTURA: "border-rose-200 bg-rose-50 text-rose-700",
  EXCESSO: "border-amber-200 bg-amber-50 text-amber-700",
  SEM_MOVIMENTO: "border-slate-200 bg-slate-50 text-slate-600",
  SEM_CUSTO: "border-violet-200 bg-violet-50 text-violet-700",
  SEM_STOCK: "border-orange-200 bg-orange-50 text-orange-700",
};

const ALL_ESTADOS: EstadoInventario[] = [
  "NORMAL",
  "ROTURA",
  "EXCESSO",
  "SEM_MOVIMENTO",
  "SEM_CUSTO",
  "SEM_STOCK",
];

function fmtNumber(n: number | null, opts?: Intl.NumberFormatOptions): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("pt-PT", opts);
}
function fmtCurrency(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("pt-PT", { style: "currency", currency: "EUR" });
}
function fmtDay(iso: string | null): string {
  if (!iso) return "—";
  return iso.slice(0, 10);
}

function startOfYearISO(): string {
  return `${new Date().getUTCFullYear()}-01-01`;
}

export function InventarioClient({
  farmaciasInfo,
  filterOptions,
}: {
  farmaciasInfo: FarmaciaInfo[];
  filterOptions: ReportingFilterOptions;
}) {
  const universe: ReportFilterOptions = useMemo(
    () => ({
      farmacias: farmaciasInfo.map((f) => f.nome),
      categorias: filterOptions.categorias,
      subcategorias: filterOptions.subcategorias,
      utilizacoes: filterOptions.utilizacoes,
      fabricantes: filterOptions.fabricantes,
      laboratorios: filterOptions.laboratorios,
      distribuidores: filterOptions.distribuidores,
      semClassificacao: filterOptions.semClassificacao,
    }),
    [farmaciasInfo, filterOptions],
  );

  // Filtros canónicos partilhados. Inventário é "snapshot actual" —
  // por isso `from`/`to` ficam unused (hideDates no FiltersBar) mas o
  // tipo é o mesmo dos restantes relatórios.
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const workspaceId = searchParams.get("workspace");
  const utilizador = useUtilizador();
  const taskBar = useTaskBar();

  // Sessão de análise isolada (workspace) — mesmo padrão de vendas-client.tsx.
  const [criterios, setCriterios] = useWorkspaceState<InventarioCriterios>({
    workspaceId,
    tenantSlug: utilizador?.tenant ?? "desconhecido",
    userId: utilizador?.userId ?? "desconhecido",
    moduleKey: "inventario",
    initial: {
      filters: {
        farmaciaNomes: universe.farmacias, // todas seleccionadas por defeito
        from: startOfYearISO(),            // semantic only — Inventário ignora
        to: new Date().toISOString().slice(0, 10),
      },
      lista: null,
      vista: "produto",
      agrupamento: "artigo",
      estadoChip: "todos",
      ordenacaoTabela: null,
    },
  });

  function campo<K extends keyof InventarioCriterios>(
    chave: K
  ): [InventarioCriterios[K], React.Dispatch<React.SetStateAction<InventarioCriterios[K]>>] {
    const setter: React.Dispatch<React.SetStateAction<InventarioCriterios[K]>> = (valor) => {
      setCriterios((prev) => ({
        ...prev,
        [chave]:
          typeof valor === "function"
            ? (valor as (p: InventarioCriterios[K]) => InventarioCriterios[K])(prev[chave])
            : valor,
      }));
    };
    return [criterios[chave], setter];
  }

  const filters = criterios.filters;
  const [, setFilters] = campo("filters");

  /**
   * A lista de CNP importada por ficheiro.
   *
   * Vive ao lado dos filtros e não dentro deles: `filters.cnps` é só o
   * array de números que o loader precisa, e isto é o resumo que a UI
   * mostra (ficheiro, encontrados, não encontrados). Quem os mantém em
   * sincronia é o `ReportFiltersBar`, num único `onChange`.
   */
  const [lista, setLista] = campo("lista");

    // Vista + agrupamento dentro de "Por produto"
  const vista = criterios.vista;
  const [, setVista] = campo("vista");
  const agrupamento = criterios.agrupamento;
  const [, setAgrupamento] = campo("agrupamento");
  const estadoChip = criterios.estadoChip;
  const [, setEstadoChip] = campo("estadoChip");

  // Estado do dataset (lazy — só após "Gerar")
  const [result, setResult] = useState<InventarioResult | null>(null);
  const [hasGenerated, setHasGenerated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const handleGerar = () => {
    setError(null);
    startTransition(async () => {
      try {
        const r = await runInventarioReport(filters);
        setResult(r);
        setHasGenerated(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  // Filtragem por chip de estado (cliente-side; rápido)
  const rowsByEstado = useMemo(() => {
    if (!result) return [];
    if (estadoChip === "todos") return result.porProduto;
    return result.porProduto.filter((r) => r.estado === estadoChip);
  }, [result, estadoChip]);

  // ── Ordenação por cabeçalho ──────────────────────────────────────
  //
  // O loader NÃO pagina: `getInventarioData` devolve o universo inteiro
  // e o cliente refina. Ordenar aqui ordena TUDO, não a página — ao
  // contrário de /stock, que pagina no servidor e por isso manda a
  // ordenação para o SQL. Ver `lib/tabela/ordenacao.ts`.
  // A ordenação de cabeçalho é critério — vive em `criterios` (fonte única).
  const ordenacao = criterios.ordenacaoTabela;
  const [, setOrdenacaoTabela] = campo("ordenacaoTabela");
  function alternar(coluna: ColunaInventario) {
    setOrdenacaoTabela((prev) => proximaOrdenacao(prev, coluna));
  }

  // Trocar de workspace restaura os critérios mas NUNCA um resultado
  // calculado com os critérios do workspace anterior.
  useEffect(() => {
    // Sincroniza com uma identidade externa (workspace da URL) — caso legítimo.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHasGenerated(false);
    setResult(null);
    setError(null);
  }, [workspaceId]);

  // Título descritivo na barra de tarefas (distingue duas análises).
  useEffect(() => {
    if (!taskBar || !pathname || !workspaceId) return;
    const identidade = `${pathname}?workspace=${workspaceId}`;
    const foco =
      (filters.fabricantes?.length ?? 0) === 1
        ? filters.fabricantes![0]
        : (filters.categorias?.length ?? 0) === 1
          ? filters.categorias![0]
          : (filters.farmaciaNomes?.length ?? 0) === 1
            ? filters.farmaciaNomes![0]
            : null;
    taskBar.actualizarTitulo(identidade, ["Inventário", foco].filter(Boolean).join(" — "));
  }, [pathname, workspaceId, taskBar, filters.fabricantes, filters.categorias, filters.farmaciaNomes]);

  const rowsOrdenadas = useMemo(
    () => (ordenacao ? ordenarLinhas(rowsByEstado, ordenacao, acessorInventario) : rowsByEstado),
    [rowsByEstado, ordenacao],
  );

  // Agregações para "agruparPor=farmacia" sobre rowsByEstado.
  // (artigo = sem agregação, mostra linha-a-linha.)
  const aggregated = useMemo(() => {
    if (agrupamento === "artigo") return null;
    type Acc = {
      key: string;
      label: string;
      numProdutos: number;
      stockTotal: number;
      valorStockSemIva: number;
      valorIva: number;
      valorStockComIva: number;
      rotura: number;
      excesso: number;
      semMovimento: number;
      // Contadas também aqui (não só em `counts`) para que a exportação
      // (buildInventarioPorFarmaciaReport, que exige InventarioPorFarmaciaRow
      // completo) possa reutilizar exactamente estas linhas agregadas —
      // ver buildReport() abaixo.
      semCusto: number;
      semStock: number;
      normal: number;
    };
    const m = new Map<string, Acc>();
    for (const r of rowsByEstado) {
      const key = r.farmacia;
      if (!m.has(key)) {
        m.set(key, {
          key,
          label: key,
          numProdutos: 0,
          stockTotal: 0,
          valorStockSemIva: 0,
          valorIva: 0,
          valorStockComIva: 0,
          rotura: 0,
          excesso: 0,
          semMovimento: 0,
          semCusto: 0,
          semStock: 0,
          normal: 0,
        });
      }
      const acc = m.get(key)!;
      acc.numProdutos++;
      if (r.stockAtual !== null) acc.stockTotal += r.stockAtual;
      if (r.valorStock !== null) acc.valorStockSemIva += r.valorStock;
      if (r.valorIva !== null) acc.valorIva += r.valorIva;
      if (r.valorStockComIva !== null) acc.valorStockComIva += r.valorStockComIva;
      if (r.estado === "ROTURA") acc.rotura++;
      if (r.estado === "EXCESSO") acc.excesso++;
      if (r.estado === "SEM_MOVIMENTO") acc.semMovimento++;
      if (r.estado === "SEM_CUSTO") acc.semCusto++;
      if (r.estado === "SEM_STOCK") acc.semStock++;
      if (r.estado === "NORMAL") acc.normal++;
    }
    return Array.from(m.values()).sort((a, b) =>
      a.label.localeCompare(b.label, "pt-PT"),
    );
  }, [rowsByEstado, agrupamento]);

  const counts = useMemo(() => {
    const c: Record<"todos" | EstadoInventario, number> = {
      todos: result?.porProduto.length ?? 0,
      NORMAL: 0,
      ROTURA: 0,
      EXCESSO: 0,
      SEM_MOVIMENTO: 0,
      SEM_CUSTO: 0,
      SEM_STOCK: 0,
    };
    for (const r of result?.porProduto ?? []) c[r.estado]++;
    return c;
  }, [result]);

  const organization = formatFarmaciaHeader(filters.farmaciaNomes ?? [], farmaciasInfo);

  // Adapter para export reflecte VISTA actual
  const buildReport = () => {
    const uni = {
      farmacias: universe.farmacias,
      categorias: universe.categorias,
      fabricantes: universe.fabricantes,
      laboratorios: universe.laboratorios,
      distribuidores: universe.distribuidores,
    };
    if (vista === "farmacia") {
      return buildInventarioPorFarmaciaReport({
        rows: result?.porFarmacia ?? [],
        filters,
        universe: uni,
        organization,
      });
    }
    if (vista === "grupo") {
      return buildInventarioPorGrupoReport({
        rows: result?.porGrupo ?? [],
        filters,
        universe: uni,
        organization,
      });
    }
    if (vista === "iva") {
      return buildInventarioPorIvaReport({
        rows: result?.porIva ?? [],
        filters,
        universe: uni,
        organization,
      });
    }
    // Dentro de vista="produto" existe um SEGUNDO toggle, "Agrupar por:
    // Farmácia" (`agrupamento`), que troca a tabela para as linhas
    // agregadas (`aggregated`, KPIs por farmácia) em vez do detalhe por
    // produto. buildReport() nunca olhava para `agrupamento` — exportava
    // sempre o detalhe plano, mesmo quando o ecrã mostrava os agregados.
    if (agrupamento === "farmacia" && aggregated) {
      return buildInventarioPorFarmaciaReport({
        rows: aggregated.map((a) => ({
          farmaciaId: a.key,
          farmacia: a.label,
          numProdutos: a.numProdutos,
          stockTotal: a.stockTotal,
          valorStockSemIva: a.valorStockSemIva,
          valorIva: a.valorIva,
          valorStockComIva: a.valorStockComIva,
          rotura: a.rotura,
          excesso: a.excesso,
          semMovimento: a.semMovimento,
          semCusto: a.semCusto,
          semStock: a.semStock,
          normal: a.normal,
        })),
        filters,
        universe: uni,
        organization,
      });
    }

    return buildInventarioReport({
      // As MESMAS linhas que estão no ecrã, na MESMA ordem: quem ordena
      // a tabela e depois exporta espera o PDF pela ordem que viu.
      rows: rowsOrdenadas,
      filters,
      universe: uni,
      organization,
    });
  };

  return (
    <AppShell>
      <div className="space-y-5">
        {/* Header */}
        <section className="flex items-end justify-between gap-3">
          <div>
            <h1 className="text-[20px] font-semibold text-slate-900">Inventário de Stock</h1>
            <p className="mt-1 text-[12px] text-slate-500">
              Snapshot operacional por produto, farmácia, grupo homogéneo e taxa IVA.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleGerar}
              disabled={isPending}
              className="inline-flex h-10 items-center gap-2 rounded-xl border border-emerald-300 bg-emerald-500 px-4 text-[13px] font-semibold text-white shadow-sm transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isPending ? "A gerar…" : "Gerar"}
            </button>
            {result && <ReportActions report={buildReport} />}
          </div>
        </section>

        {/* Aviso permanente sobre plano fiscal */}
        <section className="flex items-start gap-2 rounded-[12px] border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>
            <b>Valor stock s/IVA</b> = <code>stockAtual × PMC</code> (PMC/PUC do ERP são sem
            IVA). <b>Valor stock c/IVA</b> aplica a taxa da última compra do produto
            (<code>StagingCompraRawLine</code>), normalizada para o conjunto canónico de
            farmácia <b>6% · 13% · 23%</b>. Taxa fora deste conjunto (ou ausente) → linha em{" "}
            <span className="font-semibold">IVA por apurar</span>, valor c/IVA não calculado.
            Não inventamos taxa.
          </span>
        </section>

        {/* Tabs de vista (Por produto / Por farmácia / Por grupo / Por IVA) */}
        <div className="flex flex-wrap gap-1.5">
          {(["produto", "farmacia", "grupo", "iva"] as Vista[]).map((v) => {
            const on = vista === v;
            const label =
              v === "produto"
                ? "Por produto"
                : v === "farmacia"
                  ? "Por farmácia"
                  : v === "grupo"
                    ? "Por grupo"
                    : "Por taxa IVA";
            return (
              <button
                key={v}
                type="button"
                onClick={() => setVista(v)}
                className={`rounded-full border px-4 py-1.5 text-[12px] font-medium transition ${
                  on
                    ? "border-slate-800 bg-slate-800 text-white"
                    : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>

        {/* Filtros canónicos partilhados (sem datas — snapshot) */}
        <ReportFiltersBar
          options={universe}
          value={filters}
          onChange={setFilters}
          hideDates
          searchPlaceholder="Pesquisar CNP ou descrição"
          lista={lista}
          onListaChange={setLista}
        />

        {error && (
          <section className="rounded-[16px] border border-rose-200 bg-rose-50 px-4 py-3 text-[12px] text-rose-700">
            Falha a gerar Inventário: {error}
          </section>
        )}

        {!hasGenerated ? (
          <section className="rounded-[16px] border border-slate-200/60 bg-white/72 px-6 py-16 text-center shadow-[0_14px_30px_rgba(15,23,42,0.045)]">
            <h2 className="text-[15px] font-semibold text-slate-900">
              Nenhum relatório gerado ainda
            </h2>
            <p className="mx-auto mt-2 max-w-[460px] text-[12px] leading-5 text-slate-500">
              Define os filtros e clica em{" "}
              <span className="font-semibold text-emerald-700">Gerar</span>. A página
              não pré-carrega dados — só lê da BD após o trigger explícito.
            </p>
          </section>
        ) : vista === "farmacia" ? (
          <ViewPorFarmacia rows={result?.porFarmacia ?? []} />
        ) : vista === "grupo" ? (
          <ViewPorGrupo rows={result?.porGrupo ?? []} />
        ) : vista === "iva" ? (
          <ViewPorIva rows={result?.porIva ?? []} />
        ) : (
          <ViewPorProduto
            rows={rowsOrdenadas}
            ordenacao={ordenacao}
            onOrdenar={alternar}
            counts={counts}
            estadoChip={estadoChip}
            setEstadoChip={setEstadoChip}
            agrupamento={agrupamento}
            setAgrupamento={setAgrupamento}
            aggregated={aggregated}
          />
        )}
      </div>
    </AppShell>
  );
}

// ── Vista Por Produto ───────────────────────────────────────────

function ViewPorProduto({
  rows,
  counts,
  estadoChip,
  setEstadoChip,
  agrupamento,
  setAgrupamento,
  aggregated,
  ordenacao,
  onOrdenar,
}: {
  rows: InventarioRow[];
  ordenacao: EstadoOrdenacao<ColunaInventario>;
  onOrdenar: (c: ColunaInventario) => void;
  counts: Record<"todos" | EstadoInventario, number>;
  estadoChip: "todos" | EstadoInventario;
  setEstadoChip: (s: "todos" | EstadoInventario) => void;
  agrupamento: AgrupamentoProduto;
  setAgrupamento: (a: AgrupamentoProduto) => void;
  aggregated:
    | Array<{
        key: string;
        label: string;
        numProdutos: number;
        stockTotal: number;
        valorStockSemIva: number;
        valorIva: number;
        valorStockComIva: number;
        rotura: number;
        excesso: number;
        semMovimento: number;
      }>
    | null;
}) {
  return (
    <>
      {/* Chips de estado */}
      <div className="flex flex-wrap items-center gap-1.5">
        {(["todos", ...ALL_ESTADOS] as const).map((k) => {
          const on = estadoChip === k;
          const label = k === "todos" ? "Todos" : ESTADO_LABEL[k];
          return (
            <button
              key={k}
              type="button"
              onClick={() => setEstadoChip(k)}
              className={`rounded-full border px-3 py-1 text-[11px] font-medium transition ${
                on
                  ? "border-slate-800 bg-slate-800 text-white"
                  : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
              }`}
            >
              {label}{" "}
              <span className={on ? "text-white/70" : "text-slate-400"}>
                ({counts[k]})
              </span>
            </button>
          );
        })}
      </div>

      {/* Agrupar por */}
      <div className="flex items-center gap-2 text-[12px] text-slate-600">
        <span className="font-medium">Agrupar por:</span>
        {(["artigo", "farmacia"] as AgrupamentoProduto[]).map((a) => {
          const on = agrupamento === a;
          const label = a === "artigo" ? "Artigo" : "Farmácia";
          return (
            <button
              key={a}
              type="button"
              onClick={() => setAgrupamento(a)}
              className={`rounded-full border px-3 py-1 text-[11px] font-medium transition ${
                on
                  ? "border-emerald-300 bg-emerald-100 text-emerald-700"
                  : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>

      {/* Tabela (agregada ou linha-a-linha) */}
      <section className="rounded-[16px] border border-slate-200/60 bg-white/72 p-3 shadow-[0_14px_30px_rgba(15,23,42,0.045)]">
        {aggregated ? (
          <TabelaAgregadaProduto rows={aggregated} groupBy={agrupamento} />
        ) : (
          <TabelaLinhaProduto rows={rows} ordenacao={ordenacao} onOrdenar={onOrdenar} />
        )}
      </section>
    </>
  );
}

function TabelaLinhaProduto({
  rows,
  ordenacao,
  onOrdenar,
}: {
  rows: InventarioRow[];
  ordenacao: EstadoOrdenacao<ColunaInventario>;
  onOrdenar: (c: ColunaInventario) => void;
}) {
  if (rows.length === 0) {
    return (
      <div className="px-4 py-10 text-center text-[12px] text-slate-500">
        Sem produtos para os filtros actuais.
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-left text-[12px]">
        <thead className="border-b border-slate-200 text-[10px] uppercase tracking-[0.14em] text-slate-500">
          <tr>
            <CabecalhoOrdenavel as="th" ordenacao={ordenacao} onOrdenar={onOrdenar} coluna="cnp" className="py-2 pr-3">CNP</CabecalhoOrdenavel>
            <CabecalhoOrdenavel as="th" ordenacao={ordenacao} onOrdenar={onOrdenar} coluna="designacao" className="py-2 pr-3">Descrição</CabecalhoOrdenavel>
            <CabecalhoOrdenavel as="th" ordenacao={ordenacao} onOrdenar={onOrdenar} coluna="categoria" className="py-2 pr-3">Categoria</CabecalhoOrdenavel>
            <CabecalhoOrdenavel as="th" ordenacao={ordenacao} onOrdenar={onOrdenar} coluna="farmacia" className="py-2 pr-3">Farmácia</CabecalhoOrdenavel>
            <CabecalhoOrdenavel as="th" ordenacao={ordenacao} onOrdenar={onOrdenar} coluna="stockAtual" align="right" className="py-2 pr-3 text-right">Stock</CabecalhoOrdenavel>
            <CabecalhoOrdenavel as="th" ordenacao={ordenacao} onOrdenar={onOrdenar} coluna="pmc" align="right" className="py-2 pr-3 text-right">PMC</CabecalhoOrdenavel>
            <CabecalhoOrdenavel as="th" ordenacao={ordenacao} onOrdenar={onOrdenar} coluna="pvp" align="right" className="py-2 pr-3 text-right">PVP</CabecalhoOrdenavel>
            <CabecalhoOrdenavel as="th" ordenacao={ordenacao} onOrdenar={onOrdenar} coluna="taxaIva" align="right" className="py-2 pr-3 text-right">IVA %</CabecalhoOrdenavel>
            <CabecalhoOrdenavel as="th" ordenacao={ordenacao} onOrdenar={onOrdenar} coluna="valorStock" align="right" className="py-2 pr-3 text-right">Val. s/IVA</CabecalhoOrdenavel>
            <CabecalhoOrdenavel as="th" ordenacao={ordenacao} onOrdenar={onOrdenar} coluna="valorIva" align="right" className="py-2 pr-3 text-right">IVA €</CabecalhoOrdenavel>
            <CabecalhoOrdenavel as="th" ordenacao={ordenacao} onOrdenar={onOrdenar} coluna="valorStockComIva" align="right" className="py-2 pr-3 text-right">Val. c/IVA</CabecalhoOrdenavel>
            <CabecalhoOrdenavel as="th" ordenacao={ordenacao} onOrdenar={onOrdenar} coluna="coberturaDias" align="right" className="py-2 pr-3 text-right">Cobert.</CabecalhoOrdenavel>
            <CabecalhoOrdenavel as="th" ordenacao={ordenacao} onOrdenar={onOrdenar} coluna="estado" className="py-2 pr-3">Estado</CabecalhoOrdenavel>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r) => (
            <tr key={`${r.cnp}:${r.farmaciaId}`}>
              <td className="py-2 pr-3 font-mono text-[11px] text-slate-600">{r.cnp}</td>
              <td className="py-2 pr-3 text-slate-800">
                <ArtigoLink cnp={Number(r.cnp)} className="hover:text-emerald-600 hover:underline">
                  {r.designacao}
                </ArtigoLink>
              </td>
              <td className="py-2 pr-3 text-slate-600">
                {r.categoria ?? "—"}
                {/* "Outros X" deixou de ser devolvido como grupo: quando o
                    grupo é igual à categoria, o produto está classificado
                    só ao nível da família. Dizê-lo em vez de o esconder. */}
                {r.categoria && r.grupo === r.categoria && r.categoria !== SEM_CLASSIFICACAO_LABEL ? (
                  <span className="ml-1.5 text-[10px] italic text-slate-300">sem detalhe</span>
                ) : null}
              </td>
              <td className="py-2 pr-3 text-slate-600">{r.farmacia}</td>
              <td className="py-2 pr-3 text-right tabular-nums text-slate-700">
                {fmtNumber(r.stockAtual)}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums text-slate-600">
                {fmtCurrency(r.pmc)}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums text-slate-600">
                {fmtCurrency(r.pvp)}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums text-slate-500">
                {r.taxaIva === null ? "—" : `${r.taxaIva}%`}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums font-medium text-slate-800">
                {fmtCurrency(r.valorStock)}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums text-slate-600">
                {fmtCurrency(r.valorIva)}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums font-medium text-slate-800">
                {fmtCurrency(r.valorStockComIva)}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums text-slate-600">
                {r.coberturaDias === null ? "—" : `${r.coberturaDias}d`}
              </td>
              <td className="py-2 pr-3">
                <span
                  className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium ${ESTADO_BADGE[r.estado]}`}
                >
                  {ESTADO_LABEL[r.estado]}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TabelaAgregadaProduto({
  rows,
  groupBy,
}: {
  rows: Array<{
    key: string;
    label: string;
    numProdutos: number;
    stockTotal: number;
    valorStockSemIva: number;
    valorIva: number;
    valorStockComIva: number;
    rotura: number;
    excesso: number;
    semMovimento: number;
  }>;
  groupBy: AgrupamentoProduto;
}) {
  if (rows.length === 0) {
    return (
      <div className="px-4 py-10 text-center text-[12px] text-slate-500">
        Sem agregação possível para os filtros actuais.
      </div>
    );
  }
  const header = groupBy === "farmacia" ? "Farmácia" : "Artigo";
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-left text-[12px]">
        <thead className="border-b border-slate-200 text-[10px] uppercase tracking-[0.14em] text-slate-500">
          <tr>
            <th className="py-2 pr-3">{header}</th>
            <th className="py-2 pr-3 text-right">Produtos</th>
            <th className="py-2 pr-3 text-right">Stock total</th>
            <th className="py-2 pr-3 text-right">Val. s/IVA</th>
            <th className="py-2 pr-3 text-right">IVA €</th>
            <th className="py-2 pr-3 text-right">Val. c/IVA</th>
            <th className="py-2 pr-3 text-right">Roturas</th>
            <th className="py-2 pr-3 text-right">Excesso</th>
            <th className="py-2 pr-3 text-right">Sem mov.</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r) => (
            <tr key={r.key}>
              <td className="py-2 pr-3 font-medium text-slate-800">{r.label}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{r.numProdutos}</td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {Math.round(r.stockTotal).toLocaleString("pt-PT")}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {fmtCurrency(r.valorStockSemIva)}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums text-slate-600">
                {fmtCurrency(r.valorIva)}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {fmtCurrency(r.valorStockComIva)}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums text-rose-700">
                {r.rotura}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums text-amber-700">
                {r.excesso}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums text-slate-500">
                {r.semMovimento}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Vista Por Grupo (KPIs executivos por grupo homogéneo) ────────

function ViewPorGrupo({ rows }: { rows: InventarioPorGrupoRow[] }) {
  if (rows.length === 0) {
    return (
      <section className="rounded-[16px] border border-slate-200/60 bg-white/72 px-6 py-12 text-center text-[12px] text-slate-500">
        Sem grupos no resultado.
      </section>
    );
  }
  return (
    <section className="rounded-[16px] border border-slate-200/60 bg-white/72 p-3 shadow-[0_14px_30px_rgba(15,23,42,0.045)]">
      <div className="overflow-x-auto">
        <table className="min-w-full text-left text-[12px]">
          <thead className="border-b border-slate-200 text-[10px] uppercase tracking-[0.14em] text-slate-500">
            <tr>
              <th className="py-2 pr-3">Grupo</th>
              <th className="py-2 pr-3 text-right">Produtos</th>
              <th className="py-2 pr-3 text-right">Stock total</th>
              <th className="py-2 pr-3 text-right">Val. s/IVA</th>
              <th className="py-2 pr-3 text-right">IVA €</th>
              <th className="py-2 pr-3 text-right">Val. c/IVA</th>
              <th className="py-2 pr-3 text-right">Rotura</th>
              <th className="py-2 pr-3 text-right">Excesso</th>
              <th className="py-2 pr-3 text-right">Sem mov.</th>
              <th className="py-2 pr-3 text-right">Sem custo</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => (
              <tr key={r.key}>
                <td className="py-2 pr-3 font-medium text-slate-800">{r.grupo}</td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {r.numProdutos.toLocaleString("pt-PT")}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {r.stockTotal.toLocaleString("pt-PT")}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums font-medium">
                  {fmtCurrency(r.valorStockSemIva)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums text-slate-600">
                  {fmtCurrency(r.valorIva)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums font-medium">
                  {fmtCurrency(r.valorStockComIva)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums text-rose-700">{r.rotura}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-amber-700">{r.excesso}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-slate-500">
                  {r.semMovimento}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums text-violet-700">
                  {r.semCusto}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t border-slate-200 bg-slate-50/60 text-[11px] font-semibold">
            <tr>
              <td className="py-2 pr-3 text-slate-700">Total</td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {rows.reduce((s, r) => s + r.numProdutos, 0).toLocaleString("pt-PT")}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {rows.reduce((s, r) => s + r.stockTotal, 0).toLocaleString("pt-PT")}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {fmtCurrency(rows.reduce((s, r) => s + r.valorStockSemIva, 0))}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {fmtCurrency(rows.reduce((s, r) => s + r.valorIva, 0))}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {fmtCurrency(rows.reduce((s, r) => s + r.valorStockComIva, 0))}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums text-rose-700">
                {rows.reduce((s, r) => s + r.rotura, 0)}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums text-amber-700">
                {rows.reduce((s, r) => s + r.excesso, 0)}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums text-slate-600">
                {rows.reduce((s, r) => s + r.semMovimento, 0)}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums text-violet-700">
                {rows.reduce((s, r) => s + r.semCusto, 0)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}

// ── Vista Por Taxa IVA (executiva fiscal) ────────────────────────

function ViewPorIva({ rows }: { rows: InventarioPorIvaRow[] }) {
  if (rows.length === 0) {
    return (
      <section className="rounded-[16px] border border-slate-200/60 bg-white/72 px-6 py-12 text-center text-[12px] text-slate-500">
        Sem buckets de IVA no resultado.
      </section>
    );
  }
  const totalSemIva = rows.reduce((s, r) => s + r.valorStockSemIva, 0);
  return (
    <section className="rounded-[16px] border border-slate-200/60 bg-white/72 p-3 shadow-[0_14px_30px_rgba(15,23,42,0.045)]">
      <div className="overflow-x-auto">
        <table className="min-w-full text-left text-[12px]">
          <thead className="border-b border-slate-200 text-[10px] uppercase tracking-[0.14em] text-slate-500">
            <tr>
              <th className="py-2 pr-3">Taxa IVA</th>
              <th className="py-2 pr-3 text-right">Produtos</th>
              <th className="py-2 pr-3 text-right">Stock total</th>
              <th className="py-2 pr-3 text-right">Val. s/IVA</th>
              <th className="py-2 pr-3 text-right">IVA €</th>
              <th className="py-2 pr-3 text-right">Val. c/IVA</th>
              <th className="py-2 pr-3 text-right">% Valor</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => {
              const apurar = r.key === "APURAR";
              return (
                <tr key={r.key} className={apurar ? "bg-slate-50/60" : undefined}>
                  <td
                    className={`py-2 pr-3 font-medium ${apurar ? "text-slate-500 italic" : "text-slate-800"}`}
                  >
                    {r.label}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {r.numProdutos.toLocaleString("pt-PT")}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {r.stockTotal.toLocaleString("pt-PT")}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums font-medium">
                    {fmtCurrency(r.valorStockSemIva)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-slate-600">
                    {apurar ? "—" : fmtCurrency(r.valorIva)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums font-medium">
                    {apurar ? "—" : fmtCurrency(r.valorStockComIva)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-slate-500">
                    {totalSemIva > 0
                      ? `${(Math.round((r.valorStockSemIva / totalSemIva) * 1000) / 10).toLocaleString("pt-PT")}%`
                      : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="border-t border-slate-200 bg-slate-50/60 text-[11px] font-semibold">
            <tr>
              <td className="py-2 pr-3 text-slate-700">Total</td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {rows.reduce((s, r) => s + r.numProdutos, 0).toLocaleString("pt-PT")}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {rows.reduce((s, r) => s + r.stockTotal, 0).toLocaleString("pt-PT")}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {fmtCurrency(totalSemIva)}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {fmtCurrency(rows.reduce((s, r) => s + r.valorIva, 0))}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {fmtCurrency(rows.reduce((s, r) => s + r.valorStockComIva, 0))}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums text-slate-500">100%</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}

// ── Vista Por Farmácia (KPIs executivos) ─────────────────────────

function ViewPorFarmacia({ rows }: { rows: InventarioPorFarmaciaRow[] }) {
  if (rows.length === 0) {
    return (
      <section className="rounded-[16px] border border-slate-200/60 bg-white/72 px-6 py-12 text-center text-[12px] text-slate-500">
        Sem farmácias no resultado.
      </section>
    );
  }
  return (
    <section className="rounded-[16px] border border-slate-200/60 bg-white/72 p-3 shadow-[0_14px_30px_rgba(15,23,42,0.045)]">
      <div className="overflow-x-auto">
        <table className="min-w-full text-left text-[12px]">
          <thead className="border-b border-slate-200 text-[10px] uppercase tracking-[0.14em] text-slate-500">
            <tr>
              <th className="py-2 pr-3">Farmácia</th>
              <th className="py-2 pr-3 text-right">Produtos</th>
              <th className="py-2 pr-3 text-right">Stock total</th>
              <th className="py-2 pr-3 text-right">Val. s/IVA</th>
              <th className="py-2 pr-3 text-right">IVA €</th>
              <th className="py-2 pr-3 text-right">Val. c/IVA</th>
              <th className="py-2 pr-3 text-right">Rotura</th>
              <th className="py-2 pr-3 text-right">Excesso</th>
              <th className="py-2 pr-3 text-right">Sem mov.</th>
              <th className="py-2 pr-3 text-right">Sem custo</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => (
              <tr key={r.farmaciaId}>
                <td className="py-2 pr-3 font-medium text-slate-800">{r.farmacia}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{r.numProdutos.toLocaleString("pt-PT")}</td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {r.stockTotal.toLocaleString("pt-PT")}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums font-medium">
                  {fmtCurrency(r.valorStockSemIva)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums text-slate-600">
                  {fmtCurrency(r.valorIva)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums font-medium">
                  {fmtCurrency(r.valorStockComIva)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums text-rose-700">
                  {r.rotura}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums text-amber-700">
                  {r.excesso}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums text-slate-500">
                  {r.semMovimento}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums text-violet-700">
                  {r.semCusto}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t border-slate-200 bg-slate-50/60 text-[11px] font-semibold">
            <tr>
              <td className="py-2 pr-3 text-slate-700">Total</td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {rows.reduce((s, r) => s + r.numProdutos, 0).toLocaleString("pt-PT")}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {rows.reduce((s, r) => s + r.stockTotal, 0).toLocaleString("pt-PT")}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {fmtCurrency(rows.reduce((s, r) => s + r.valorStockSemIva, 0))}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {fmtCurrency(rows.reduce((s, r) => s + r.valorIva, 0))}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {fmtCurrency(rows.reduce((s, r) => s + r.valorStockComIva, 0))}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums text-rose-700">
                {rows.reduce((s, r) => s + r.rotura, 0)}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums text-amber-700">
                {rows.reduce((s, r) => s + r.excesso, 0)}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums text-slate-600">
                {rows.reduce((s, r) => s + r.semMovimento, 0)}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums text-violet-700">
                {rows.reduce((s, r) => s + r.semCusto, 0)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}


/**
 * As colunas ordenáveis do Inventário «Por produto».
 *
 * União de literais: acrescentar um cabeçalho sem lhe dar acessor passa
 * a ser erro de compilação, e não uma coluna que se clica sem efeito.
 */
type ColunaInventario =
  | "cnp"
  | "designacao"
  | "categoria"
  | "farmacia"
  | "stockAtual"
  | "pmc"
  | "pvp"
  | "taxaIva"
  | "valorStock"
  | "valorIva"
  | "valorStockComIva"
  | "coberturaDias"
  | "estado";

/**
 * A severidade dos estados, para a coluna «Estado» ordenar por algo que
 * signifique alguma coisa.
 *
 * Alfabeticamente, `EXCESSO` vem antes de `NORMAL` que vem antes de
 * `ROTURA` — uma ordem que não diz nada a ninguém. A ordem útil é a da
 * gravidade operacional: a rotura é o que custa vendas hoje, o excesso é
 * capital preso, e as ausências de dado ficam no fim porque não são um
 * estado do artigo mas do que sabemos sobre ele.
 *
 * Ordenar descendente põe as roturas no topo, que é a razão de alguém
 * clicar nesta coluna.
 */
const SEVERIDADE_INVENTARIO: Record<EstadoInventario, number> = {
  ROTURA: 6,
  EXCESSO: 5,
  SEM_MOVIMENTO: 4,
  NORMAL: 3,
  SEM_STOCK: 2,
  SEM_CUSTO: 1,
};

function acessorInventario(row: InventarioRow, coluna: ColunaInventario): ValorOrdenavel {
  // `estado` é um enum e não um texto: ordenado como texto daria a ordem
  // do alfabeto, que não é a ordem de ninguém.
  if (coluna === "estado") return SEVERIDADE_INVENTARIO[row.estado];
  return row[coluna] as ValorOrdenavel;
}
