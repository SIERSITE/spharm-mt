"use client";

/**
 * components/margens/margens-client.tsx
 *
 * Cliente do relatório de Margens. Três níveis commutáveis:
 *   1. Por produto    — 1 linha por (CNP × farmácia × período)
 *   2. Por categoria  — agregado por categoria canónica
 *   3. Por farmácia   — agregado por farmácia
 *
 * KPIs globais sempre visíveis no topo:
 *   Vendas € · Custo € · Margem € · Margem % · Cobertura
 *
 * Regra dura (per spec):
 *   · Margem % suprimida em vendas sem custo conhecido
 *   · Aviso permanente sobre snapshot de custo
 */

import { SEM_CLASSIFICACAO_LABEL } from "@/lib/categoria-resolver";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { AppShell } from "@/components/layout/app-shell";
import { ReportFiltersBar } from "@/components/reporting/report-filters-bar";
import type { ListaCodigosResolvida } from "@/lib/produtos/lista-codigos-tipos";
import {
  CabecalhoOrdenavel,
  useOrdenacao,
} from "@/components/ui/cabecalho-ordenavel";
import {
  ordenarLinhas,
  type EstadoOrdenacao,
  type ValorOrdenavel,
} from "@/lib/tabela/ordenacao";
import { ReportActions } from "@/components/reporting/report-actions";
import { runMargensReport } from "@/app/relatorios/margens/actions";
import type {
  ReportFilterOptions,
  SharedReportFilters,
} from "@/lib/reporting/filters-shared";
import {
  buildMargensProdutoReport,
  buildMargensAggReport,
} from "@/lib/reporting/adapters/margens";
import type {
  MargensResult,
  MargemRow,
  MargensAgg,
  EstadoMargem,
} from "@/lib/margens-data";
import { formatFarmaciaHeader, type FarmaciaInfo } from "@/lib/farmacias-header";
import type { ReportingFilterOptions } from "@/lib/reporting-filter-options";
import { AlertTriangle } from "lucide-react";

/**
 * As vistas de Margens.
 *
 * "produto" e' a UNICA que mostra detalhe linha-a-linha. Todas as outras
 * sao ja' o modo "so' totalizadores": uma linha por valor da dimensao,
 * sem os produtos por baixo. Nao ha' um interruptor separado de propósito
 * — seriam dois controlos para um so' estado, e a pergunta "estou a ver
 * detalhe ou totais?" passaria a ter duas respostas possiveis.
 *
 * Os rotulos dizem-no: "Detalhe por produto" vs "Totais por ...".
 */
type Nivel = "produto" | "categoria" | "farmacia" | "grupo" | "fabricante";

const NIVEIS: Nivel[] = ["produto", "categoria", "farmacia", "grupo", "fabricante"];

const NIVEL_LABEL: Record<Nivel, string> = {
  produto: "Detalhe por produto",
  categoria: "Totais por categoria",
  farmacia: "Totais por farmácia",
  grupo: "Totais por grupo",
  fabricante: "Totais por fabricante",
};

/** Cabeçalho da primeira coluna em cada vista agregada. */
const NIVEL_HEADER: Record<Nivel, string> = {
  produto: "Produto",
  categoria: "Categoria",
  farmacia: "Farmácia",
  grupo: "Grupo",
  fabricante: "Fabricante",
};

const MARGEM_LABEL: Record<EstadoMargem, string> = {
  FIAVEL: "Fiável",
  PARCIAL: "Parcial",
  SEM_CUSTO: "Sem custo",
  IVA_POR_APURAR: "IVA por apurar",
};
const MARGEM_BADGE: Record<EstadoMargem, string> = {
  FIAVEL: "border-emerald-200 bg-emerald-50 text-emerald-700",
  PARCIAL: "border-amber-200 bg-amber-50 text-amber-700",
  SEM_CUSTO: "border-rose-200 bg-rose-50 text-rose-700",
  IVA_POR_APURAR: "border-slate-300 bg-slate-100 text-slate-700",
};
const ALL_ESTADOS: EstadoMargem[] = ["FIAVEL", "PARCIAL", "SEM_CUSTO", "IVA_POR_APURAR"];

function fmtCurrency(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("pt-PT", { style: "currency", currency: "EUR" });
}
function fmtInt(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("pt-PT");
}
function fmtPct(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return `${n.toLocaleString("pt-PT", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
}
function fmtCobertura(f: number): string {
  return `${Math.round(f * 1000) / 10}%`;
}

function startOfYearISO(): string {
  return `${new Date().getUTCFullYear()}-01-01`;
}

export function MargensClient({
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
      distribuidores: filterOptions.distribuidores,
      semClassificacao: filterOptions.semClassificacao,
    }),
    [farmaciasInfo, filterOptions],
  );

  const [filters, setFilters] = useState<SharedReportFilters>({
    farmaciaNomes: universe.farmacias,
    from: startOfYearISO(),
    to: new Date().toISOString().slice(0, 10),
  });

  /**
   * A lista de CNP importada por ficheiro.
   *
   * Vive ao lado dos filtros e não dentro deles: `filters.cnps` é só o
   * array de números que o loader precisa, e isto é o resumo que a UI
   * mostra (ficheiro, encontrados, não encontrados). Quem os mantém em
   * sincronia é o `ReportFiltersBar`, num único `onChange`.
   */
  const [lista, setLista] = useState<ListaCodigosResolvida | null>(null);

    const [nivel, setNivel] = useState<Nivel>("produto");
  const [estadoChip, setEstadoChip] = useState<"todos" | EstadoMargem>("todos");

  const [result, setResult] = useState<MargensResult | null>(null);
  const [hasGenerated, setHasGenerated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const handleGerar = () => {
    setError(null);
    startTransition(async () => {
      try {
        const r = await runMargensReport(filters);
        setResult(r);
        setHasGenerated(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  /**
   * Os filtros passam a APLICAR-SE.
   *
   * Antes, alterar a pesquisa (ou qualquer outro filtro) mudava o estado
   * do formulário e mais nada: só um clique em "Gerar" reenviava os
   * filtros ao servidor. Quem escrevia um CNP via a mesma lista de
   * sempre e concluía, com razão, que a pesquisa era ignorada — quando
   * o que estava no ecrã era simplesmente o resultado anterior.
   *
   * A geração continua a ser explícita da PRIMEIRA vez: a página não
   * pré-carrega Margens. Depois disso, cada alteração de filtro relança
   * o relatório, com 400 ms de espera para não disparar uma query por
   * cada tecla.
   *
   * O `JSON.stringify` é a chave de dependência de propósito: `filters`
   * é recriado a cada `patch` do formulário e comparar por identidade
   * relançava a query em renders que não mudaram nada.
   */
  const filtrosSerial = JSON.stringify(filters);
  const primeiroEfeito = useRef(true);
  useEffect(() => {
    if (!hasGenerated) return;
    if (primeiroEfeito.current) {
      primeiroEfeito.current = false;
      return;
    }
    const t = setTimeout(() => {
      startTransition(async () => {
        try {
          setError(null);
          setResult(await runMargensReport(JSON.parse(filtrosSerial)));
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    }, 400);
    return () => clearTimeout(t);
    // `filtrosSerial` é a única dependência que representa uma mudança
    // real de critérios; as restantes são estáveis.
  }, [filtrosSerial, hasGenerated]);

  const rowsByEstadoProduto = useMemo(() => {
    if (!result) return [];
    if (estadoChip === "todos") return result.porProduto;
    return result.porProduto.filter((r) => r.estado === estadoChip);
  }, [result, estadoChip]);

  // ── Ordenação por cabeçalho ──────────────────────────────────────
  //
  // `getMargensData` não pagina: devolve o universo e o cliente refina.
  // Ordenar aqui ordena TUDO.
  const { ordenacao, alternar } = useOrdenacao<ColunaMargens>(null);

  const rowsOrdenadasProduto = useMemo(
    () =>
      ordenacao
        ? ordenarLinhas(rowsByEstadoProduto, ordenacao, acessorMargens)
        : rowsByEstadoProduto,
    [rowsByEstadoProduto, ordenacao],
  );

  const counts = useMemo(() => {
    const c: Record<"todos" | EstadoMargem, number> = {
      todos: result?.porProduto.length ?? 0,
      FIAVEL: 0,
      PARCIAL: 0,
      SEM_CUSTO: 0,
      IVA_POR_APURAR: 0,
    };
    for (const r of result?.porProduto ?? []) c[r.estado]++;
    return c;
  }, [result]);

  const organization = formatFarmaciaHeader(filters.farmaciaNomes ?? [], farmaciasInfo);

  /**
   * As linhas da vista agregada actual.
   *
   * Partilhado pela tabela e pela exportacao: e' esta funcao que garante
   * que o PDF/Excel exporta EXACTAMENTE a vista que esta' no ecra, e nao
   * volta ao detalhe por produto.
   */
  const linhasAgregadas = (r: MargensResult | null, n: Nivel): MargensAgg[] => {
    switch (n) {
      case "categoria": return r?.porCategoria ?? [];
      case "farmacia": return r?.porFarmacia ?? [];
      case "grupo": return r?.porGrupo ?? [];
      case "fabricante": return r?.porFabricante ?? [];
      case "produto": return [];
    }
  };

  const buildReport = () => {
    if (nivel === "produto") {
      return buildMargensProdutoReport({
        // As MESMAS linhas do ecrã, na MESMA ordem: quem ordena e
        // exporta espera o ficheiro pela ordem que viu.
        rows: rowsOrdenadasProduto,
        filters,
        universe: {
          farmacias: universe.farmacias,
          categorias: universe.categorias,
          fabricantes: universe.fabricantes,
          distribuidores: universe.distribuidores,
        },
        organization,
      });
    }
    // Exportacao e ecra leem a MESMA lista. Se divergissem, o PDF de
    // "Totais por fabricante" podia trazer as categorias.
    const aggRows = linhasAgregadas(result, nivel);
    return buildMargensAggReport({
      rows: aggRows,
      filters,
      universe: {
        farmacias: universe.farmacias,
        categorias: universe.categorias,
        fabricantes: universe.fabricantes,
        distribuidores: universe.distribuidores,
      },
      organization,
      groupBy: nivel,
    });
  };

  return (
    <AppShell>
      <div className="space-y-5">
        {/* Header + Acções */}
        <section className="flex items-end justify-between gap-3">
          <div>
            <h1 className="text-[20px] font-semibold text-slate-900">Margens</h1>
            <p className="mt-1 text-[12px] text-slate-500">
              Margens operacionais por produto, categoria, farmácia e grupo.
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

        {/* Aviso permanente sobre snapshot de custo e plano fiscal */}
        <section className="flex items-start gap-2 rounded-[12px] border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>
            Margem calculada <b>SEM IVA</b>: <code>(PVP/(1+taxa)) − PMC</code>. Taxas válidas
            de farmácia: <b>6% · 13% · 23%</b>. Taxa por produto vem da última compra em{" "}
            <code>StagingCompraRawLine</code>, normalizada para uma destas três. Fora deste
            conjunto → estado <span className="font-semibold">IVA por apurar</span>, margem
            €/% suprimidas (não inventamos taxa). Sem custo conhecido →{" "}
            <span className="font-semibold">Sem custo</span> ou{" "}
            <span className="font-semibold">Parcial</span>.
          </span>
        </section>

        {/* Filtros canónicos */}
        <ReportFiltersBar
          options={universe}
          value={filters}
          onChange={setFilters}
          searchPlaceholder="Pesquisar CNP ou descrição"
          // Mesmo comportamento de /vendas: os dois interruptores do
          // relatório oficial do SPharm (crédito/transferências) têm de
          // valer aqui também — Margens agregava sempre as três naturezas
          // sem opção de desligar, o que fazia "vendas consideradas"
          // divergir de Vendas quando os toggles não estavam nos
          // defaults. `getMargensData` já aplica `naturezasIncluidas`.
          mostrarNaturezas
          lista={lista}
          onListaChange={setLista}
        />

        {error && (
          <section className="rounded-[16px] border border-rose-200 bg-rose-50 px-4 py-3 text-[12px] text-rose-700">
            Falha a gerar Margens: {error}
          </section>
        )}

        {!hasGenerated ? (
          <section className="rounded-[16px] border border-slate-200/60 bg-white/72 px-6 py-16 text-center shadow-[0_14px_30px_rgba(15,23,42,0.045)]">
            <h2 className="text-[15px] font-semibold text-slate-900">
              Nenhum relatório gerado ainda
            </h2>
            <p className="mx-auto mt-2 max-w-[480px] text-[12px] leading-5 text-slate-500">
              Define o período e clica em{" "}
              <span className="font-semibold text-emerald-700">Gerar</span>. A página não
              pré-carrega Margens — só lê da BD após o trigger explícito.
            </p>
          </section>
        ) : (
          <>
            <KPIBar result={result!} />

            {/* Tabs de nível */}
            <div className="flex flex-wrap gap-1.5">
              {NIVEIS.map((n) => {
                const on = nivel === n;
                const label = NIVEL_LABEL[n];
                return (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setNivel(n)}
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

            {/* Chips de estado (apenas Por Produto) */}
            {nivel === "produto" && (
              <div className="flex flex-wrap items-center gap-1.5">
                {(["todos", ...ALL_ESTADOS] as const).map((k) => {
                  const on = estadoChip === k;
                  const label = k === "todos" ? "Todos" : MARGEM_LABEL[k];
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
            )}

            {nivel === "produto" ? (
              <TabelaProduto rows={rowsOrdenadasProduto} ordenacao={ordenacao} onOrdenar={alternar} />
            ) : (
              <TabelaAgg rows={linhasAgregadas(result, nivel)} header={NIVEL_HEADER[nivel]} />
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}

// ── KPIs globais ──────────────────────────────────────────────────

function KPIBar({ result }: { result: MargensResult }) {
  const t = result.totals;
  return (
    <section className="grid gap-3 md:grid-cols-6">
      <KPI label="Vendas € (c/ IVA)" value={fmtCurrency(t.valorVendido)} />
      <KPI
        label="Vendas € (s/ IVA)"
        value={t.valorVendidoSemIva > 0 ? fmtCurrency(t.valorVendidoSemIva) : "—"}
        helper={t.valorVendidoSemIva === 0 ? "Sem linhas com IVA conhecido" : undefined}
      />
      <KPI label="Custo €" value={fmtCurrency(t.custoEstimado)} />
      <KPI label="Margem €" value={fmtCurrency(t.margemEur)} />
      <KPI
        label="Margem %"
        value={t.margemPct !== null ? fmtPct(t.margemPct) : "—"}
        helper={
          t.margemPct === null
            ? t.estado === "IVA_POR_APURAR"
              ? "Suprimida — IVA por apurar"
              : "Suprimida — cobertura insuficiente"
            : undefined
        }
      />
      <KPI
        label="Cobertura"
        value={fmtCobertura(t.coberturaCusto)}
        helper={MARGEM_LABEL[t.estado]}
        helperTone={t.estado === "FIAVEL" ? "ok" : t.estado === "PARCIAL" ? "warn" : "bad"}
      />
    </section>
  );
}

function KPI({
  label,
  value,
  helper,
  helperTone,
}: {
  label: string;
  value: string;
  helper?: string;
  helperTone?: "ok" | "warn" | "bad";
}) {
  const toneClass =
    helperTone === "ok"
      ? "text-emerald-700"
      : helperTone === "warn"
        ? "text-amber-700"
        : helperTone === "bad"
          ? "text-rose-700"
          : "text-slate-500";
  return (
    <div className="rounded-[14px] border border-slate-200/60 bg-white/80 px-3 py-3 shadow-[0_8px_20px_rgba(15,23,42,0.035)]">
      <div className="text-[10px] uppercase tracking-[0.14em] text-slate-400">{label}</div>
      <div className="mt-1 text-[16px] font-semibold tabular-nums text-slate-900">{value}</div>
      {helper && <div className={`mt-1 text-[10px] ${toneClass}`}>{helper}</div>}
    </div>
  );
}

// ── Tabela Por Produto ────────────────────────────────────────────

function TabelaProduto({
  rows,
  ordenacao,
  onOrdenar,
}: {
  rows: MargemRow[];
  ordenacao: EstadoOrdenacao<ColunaMargens>;
  onOrdenar: (c: ColunaMargens) => void;
}) {
  if (rows.length === 0) {
    return (
      <section className="rounded-[16px] border border-slate-200/60 bg-white/72 px-6 py-12 text-center text-[12px] text-slate-500">
        Sem produtos para os filtros actuais.
      </section>
    );
  }
  return (
    <section className="rounded-[16px] border border-slate-200/60 bg-white/72 p-3 shadow-[0_14px_30px_rgba(15,23,42,0.045)]">
      <div className="overflow-x-auto">
        <table className="min-w-full text-left text-[12px]">
          <thead className="border-b border-slate-200 text-[10px] uppercase tracking-[0.14em] text-slate-500">
            <tr>
              <CabecalhoOrdenavel as="th" ordenacao={ordenacao} onOrdenar={onOrdenar} coluna="cnp" className="py-2 pr-3">CNP</CabecalhoOrdenavel>
              <CabecalhoOrdenavel as="th" ordenacao={ordenacao} onOrdenar={onOrdenar} coluna="designacao" className="py-2 pr-3">Descrição</CabecalhoOrdenavel>
              <CabecalhoOrdenavel as="th" ordenacao={ordenacao} onOrdenar={onOrdenar} coluna="categoria" className="py-2 pr-3">Categoria</CabecalhoOrdenavel>
              <CabecalhoOrdenavel as="th" ordenacao={ordenacao} onOrdenar={onOrdenar} coluna="farmacia" className="py-2 pr-3">Farmácia</CabecalhoOrdenavel>
              <CabecalhoOrdenavel as="th" ordenacao={ordenacao} onOrdenar={onOrdenar} coluna="qtdVendida" align="right" className="py-2 pr-3 text-right">Qtd</CabecalhoOrdenavel>
              <CabecalhoOrdenavel as="th" ordenacao={ordenacao} onOrdenar={onOrdenar} coluna="pvpUnitario" align="right" className="py-2 pr-3 text-right">PVP unit.</CabecalhoOrdenavel>
              <CabecalhoOrdenavel as="th" ordenacao={ordenacao} onOrdenar={onOrdenar} coluna="valorVendido" align="right" className="py-2 pr-3 text-right">Vendas c/IVA</CabecalhoOrdenavel>
              <CabecalhoOrdenavel as="th" ordenacao={ordenacao} onOrdenar={onOrdenar} coluna="taxaIva" align="right" className="py-2 pr-3 text-right">IVA %</CabecalhoOrdenavel>
              <CabecalhoOrdenavel as="th" ordenacao={ordenacao} onOrdenar={onOrdenar} coluna="valorVendidoSemIva" align="right" className="py-2 pr-3 text-right">Vendas s/IVA</CabecalhoOrdenavel>
              <CabecalhoOrdenavel as="th" ordenacao={ordenacao} onOrdenar={onOrdenar} coluna="custoUnitario" align="right" className="py-2 pr-3 text-right">Custo unit. est.</CabecalhoOrdenavel>
              <CabecalhoOrdenavel as="th" ordenacao={ordenacao} onOrdenar={onOrdenar} coluna="custoEstimado" align="right" className="py-2 pr-3 text-right">Custo est.</CabecalhoOrdenavel>
              <CabecalhoOrdenavel as="th" ordenacao={ordenacao} onOrdenar={onOrdenar} coluna="margemEur" align="right" className="py-2 pr-3 text-right">Margem €</CabecalhoOrdenavel>
              <CabecalhoOrdenavel as="th" ordenacao={ordenacao} onOrdenar={onOrdenar} coluna="margemPct" align="right" className="py-2 pr-3 text-right">Margem %</CabecalhoOrdenavel>
              <CabecalhoOrdenavel as="th" ordenacao={ordenacao} onOrdenar={onOrdenar} coluna="estado" className="py-2 pr-3">Estado</CabecalhoOrdenavel>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => (
              <tr key={`${r.cnp}:${r.farmaciaId}`}>
                <td className="py-2 pr-3 font-mono text-[11px] text-slate-600">{r.cnp}</td>
                <td className="py-2 pr-3 text-slate-800">{r.designacao}</td>
                <td className="py-2 pr-3 text-slate-600">
                  <div className="flex flex-col leading-tight">
                    <span>{r.categoria ?? "—"}</span>
                    {/* Nivel 2 (grupo) por baixo do Nivel 1 quando difere — */}
                    {/* o resolver devolve `grupo === categoria` se só houver  */}
                    {/* um nível, evita repetição visual.                     */}
                    {r.grupo && r.grupo !== r.categoria ? (
                      <span className="text-[10px] text-slate-400">{r.grupo}</span>
                    ) : r.categoria && r.categoria !== SEM_CLASSIFICACAO_LABEL ? (
                      // Classificado ao nível da família e nada mais. NÃO é
                      // "por classificar" — tem categoria, falta-lhe
                      // granularidade dentro dela.
                      <span className="text-[10px] italic text-slate-300">sem detalhe</span>
                    ) : null}
                  </div>
                </td>
                <td className="py-2 pr-3 text-slate-600">{r.farmacia}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{fmtInt(r.qtdVendida)}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-slate-600">
                  {fmtCurrency(r.pvpUnitario)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">{fmtCurrency(r.valorVendido)}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-slate-500">
                  {r.taxaIva === null ? "—" : `${r.taxaIva}%`}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums text-slate-600">
                  {fmtCurrency(r.valorVendidoSemIva)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums text-slate-600">
                  {fmtCurrency(r.custoUnitario)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums text-slate-600">
                  {fmtCurrency(r.custoEstimado)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums font-medium text-slate-800">
                  {fmtCurrency(r.margemEur)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">{fmtPct(r.margemPct)}</td>
                <td className="py-2 pr-3">
                  <span
                    className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium ${MARGEM_BADGE[r.estado]}`}
                  >
                    {MARGEM_LABEL[r.estado]}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ── Tabela Agregada (Por Categoria / Por Farmácia) ────────────────

function TabelaAgg({ rows, header }: { rows: MargensAgg[]; header: string }) {
  if (rows.length === 0) {
    return (
      <section className="rounded-[16px] border border-slate-200/60 bg-white/72 px-6 py-12 text-center text-[12px] text-slate-500">
        Sem agregação para os filtros actuais.
      </section>
    );
  }
  return (
    <section className="rounded-[16px] border border-slate-200/60 bg-white/72 p-3 shadow-[0_14px_30px_rgba(15,23,42,0.045)]">
      <div className="overflow-x-auto">
        <table className="min-w-full text-left text-[12px]">
          <thead className="border-b border-slate-200 text-[10px] uppercase tracking-[0.14em] text-slate-500">
            <tr>
              <th className="py-2 pr-3">{header}</th>
              <th className="py-2 pr-3 text-right">Qtd</th>
              <th className="py-2 pr-3 text-right">Vendas c/IVA</th>
              <th className="py-2 pr-3 text-right">Vendas s/IVA</th>
              <th className="py-2 pr-3 text-right">Custo est.</th>
              <th className="py-2 pr-3 text-right">Margem €</th>
              <th className="py-2 pr-3 text-right">Margem %</th>
              <th className="py-2 pr-3 text-right">Cobert.</th>
              <th className="py-2 pr-3">Estado</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => (
              <tr key={r.key}>
                <td className="py-2 pr-3 font-medium text-slate-800">{r.label}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{fmtInt(r.qtdVendida)}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{fmtCurrency(r.valorVendido)}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-slate-600">
                  {fmtCurrency(r.valorVendidoSemIva)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums text-slate-600">
                  {fmtCurrency(r.custoEstimado)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums font-medium text-slate-800">
                  {fmtCurrency(r.margemEur)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">{fmtPct(r.margemPct)}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-slate-500">
                  {fmtCobertura(r.coberturaCusto)}
                </td>
                <td className="py-2 pr-3">
                  <span
                    className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium ${MARGEM_BADGE[r.estado]}`}
                  >
                    {MARGEM_LABEL[r.estado]}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}


/** As colunas ordenáveis das Margens «Por produto». */
type ColunaMargens =
  | "cnp"
  | "designacao"
  | "categoria"
  | "farmacia"
  | "qtdVendida"
  | "pvpUnitario"
  | "valorVendido"
  | "taxaIva"
  | "valorVendidoSemIva"
  | "custoUnitario"
  | "custoEstimado"
  | "margemEur"
  | "margemPct"
  | "estado";

/**
 * A severidade dos estados de margem.
 *
 * `EstadoMargem` descreve QUANTO se pode confiar no número da margem, e
 * a ordem útil é a da desconfiança: quem clica nesta coluna quer ver
 * primeiro as linhas cujo cálculo é duvidoso, não as que começam pela
 * letra mais baixa do alfabeto.
 *
 * A ordem vem de `lib/margens-data.ts`, onde o enum é definido: FIAVEL
 * é o estado em que a margem tem custo e IVA conhecidos; os outros
 * descrevem o que falta.
 */
// `Record<EstadoMargem, number>` e nao `Record<string, number>`: com
// `string` o compilador aceita uma chave inventada e o `?? 0` esconde-a
// em runtime — foi exactamente o que aconteceu na primeira versao deste
// mapa, com um "SEM_IVA" que nao existe no enum. Tipado assim, faltar
// ou sobrar um estado e' erro de compilacao.
const SEVERIDADE_MARGEM: Record<EstadoMargem, number> = {
  SEM_CUSTO: 4,
  IVA_POR_APURAR: 3,
  PARCIAL: 2,
  FIAVEL: 1,
};

function acessorMargens(row: MargemRow, coluna: ColunaMargens): ValorOrdenavel {
  // `estado` é um enum: ordenado como texto daria a ordem do alfabeto.
  if (coluna === "estado") return SEVERIDADE_MARGEM[row.estado];
  return row[coluna] as ValorOrdenavel;
}
