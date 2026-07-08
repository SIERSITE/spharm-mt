"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, ChevronUp, ChevronsUpDown, Plus, Trash2 } from "lucide-react";
import {
  createOrderAction,
  generateProposalAction,
  type CreateOrderFormInput,
} from "@/app/encomendas/nova/actions";
import {
  resolveProductsByCnpAction,
  type ProductSearchResult,
} from "@/app/encomendas/nova/search";
import { ProductPicker } from "@/components/encomendas/product-picker";
import type { ProposalRow, ProposalBaseRule } from "@/lib/encomendas/proposal";
import type { ReportingFilterOptions } from "@/lib/reporting-filter-options";

const TODAS_ID = "__todas__";

type Line = {
  key: number;
  produtoId: string;
  cnp: number;
  designacao: string;
  fabricante: string | null;
  fornecedor: string | null;
  farmaciaNome: string | null;
  farmaciaId: string | null;
  salesQty: number | null;
  avgDailySales: number | null;
  currentStock: number | null;
  pendingQty: number | null;
  suggestedQty: number | null;
  finalQty: string;
  notas: string;
  source: "proposal" | "manual" | "prefill";
};

type SortCol =
  | "designacao"
  | "farmaciaNome"
  | "salesQty"
  | "avgDailySales"
  | "currentStock"
  | "coberturaAtual"
  | "pendingQty"
  | "suggestedQty";

type Props = {
  farmacias: { id: string; nome: string }[];
  filterOptions: ReportingFilterOptions;
  productTypes: string[];
  /** Mês mais recente com dados em VendaMensal. Usado para o período default. */
  latestDataMonth?: { ano: number; mes: number } | null;
};

type PrefillStash = {
  farmaciaNome?: string;
  farmaciaId?: string;
  lines: Array<{ cnp: number | string; quantidade?: number | string }>;
};

const PREFILL_KEY = "encomenda-prefill";

let lineKeyCounter = 0;
function nextKey(): number {
  return ++lineKeyCounter;
}

function fmtNum(v: number | null, digits = 0): string {
  if (v == null) return "—";
  if (digits === 0) return String(Math.round(v));
  return v.toFixed(digits);
}

function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function defaultPeriod(latest?: { ano: number; mes: number } | null): { start: string; end: string } {
  if (latest) {
    // 3 meses terminando no último dia do mês mais recente com dados.
    const end = new Date(latest.ano, latest.mes, 0);
    const start = new Date(latest.ano, latest.mes - 1 - 2, 1);
    return { start: isoDate(start), end: isoDate(end) };
  }
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 89);
  return { start: isoDate(start), end: isoDate(end) };
}

export function OrderCreateClient({ farmacias, filterOptions, productTypes, latestDataMonth }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [busy, startTransition] = useTransition();
  const [generating, startGenerate] = useTransition();
  const [flash, setFlash] = useState<{ type: "ok" | "err" | "info"; msg: string } | null>(null);

  // ─── Critérios ───────────────────────────────────────────────────────────────
  const period = useMemo(() => defaultPeriod(latestDataMonth), []);
  const [farmaciaId, setFarmaciaId] = useState(farmacias[0]?.id ?? "");
  const [startDate, setStartDate] = useState(period.start);
  const [endDate, setEndDate] = useState(period.end);
  const [considerStock, setConsiderStock] = useState(true);
  const [baseRule, setBaseRule] = useState<ProposalBaseRule>("coverage");
  const [coverageDays, setCoverageDays] = useState(15);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selFabricantes, setSelFabricantes] = useState<string[]>([]);
  const [selFornecedores, setSelFornecedores] = useState<string[]>([]);
  const [selCategorias, setSelCategorias] = useState<string[]>([]);
  const [selProductTypes, setSelProductTypes] = useState<string[]>([]);

  // ─── Linhas ──────────────────────────────────────────────────────────────────
  const [linhas, setLinhas] = useState<Line[]>([]);
  const [hasProposal, setHasProposal] = useState(false);
  const [proposalMeta, setProposalMeta] = useState<{ numDays: number; filtered: number } | null>(null);

  // ─── Filtros e ordenação da tabela ───────────────────────────────────────────
  const [tableSearch, setTableSearch] = useState("");
  const [filterRuturas, setFilterRuturas] = useState(false);
  const [filterStockBaixo, setFilterStockBaixo] = useState(false);
  const [filterFarmaciaTabela, setFilterFarmaciaTabela] = useState("");
  const [sortCol, setSortCol] = useState<SortCol>("salesQty");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  // ─── Picker manual ───────────────────────────────────────────────────────────
  const [manualOpen, setManualOpen] = useState(false);

  // ─── Cabeçalho da encomenda ──────────────────────────────────────────────────
  const [nome, setNome] = useState("");

  const isTodasMode = farmaciaId === TODAS_ID;

  // Farmácias com linhas geradas (para filtro em modo "todas")
  const farmaciaOptions = useMemo(() => {
    if (!isTodasMode) return [];
    const seen = new Set<string>();
    const opts: { id: string; nome: string }[] = [];
    for (const l of linhas) {
      if (l.farmaciaNome && !seen.has(l.farmaciaNome)) {
        seen.add(l.farmaciaNome);
        const f = farmacias.find((fv) => fv.nome === l.farmaciaNome);
        opts.push({ id: f?.id ?? l.farmaciaNome, nome: l.farmaciaNome });
      }
    }
    return opts;
  }, [linhas, isTodasMode, farmacias]);

  // Linhas visíveis após filtros + ordenação
  const visibleLinhas = useMemo(() => {
    let list = linhas;

    const q = tableSearch.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (l) =>
          l.designacao.toLowerCase().includes(q) ||
          String(l.cnp).includes(q) ||
          (l.fabricante?.toLowerCase().includes(q) ?? false)
      );
    }

    if (filterFarmaciaTabela) {
      list = list.filter((l) => l.farmaciaNome === filterFarmaciaTabela);
    }

    if (filterRuturas) {
      list = list.filter((l) => l.currentStock != null && l.currentStock <= 0);
    }

    if (filterStockBaixo) {
      list = list.filter(
        (l) =>
          l.currentStock != null &&
          l.currentStock > 0 &&
          l.suggestedQty != null &&
          l.suggestedQty > 0
      );
    }

    return [...list].sort((a, b) => {
      let va: number | string | null = null;
      let vb: number | string | null = null;

      switch (sortCol) {
        case "designacao":
          va = a.designacao;
          vb = b.designacao;
          break;
        case "farmaciaNome":
          va = a.farmaciaNome ?? "";
          vb = b.farmaciaNome ?? "";
          break;
        case "salesQty":
          va = a.salesQty;
          vb = b.salesQty;
          break;
        case "avgDailySales":
          va = a.avgDailySales;
          vb = b.avgDailySales;
          break;
        case "currentStock":
          va = a.currentStock;
          vb = b.currentStock;
          break;
        case "coberturaAtual":
          va =
            a.currentStock != null && a.avgDailySales != null && a.avgDailySales > 0
              ? a.currentStock / a.avgDailySales
              : null;
          vb =
            b.currentStock != null && b.avgDailySales != null && b.avgDailySales > 0
              ? b.currentStock / b.avgDailySales
              : null;
          break;
        case "pendingQty":
          va = a.pendingQty;
          vb = b.pendingQty;
          break;
        case "suggestedQty":
          va = a.suggestedQty;
          vb = b.suggestedQty;
          break;
      }

      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      if (typeof va === "string" && typeof vb === "string") {
        return sortDir === "asc" ? va.localeCompare(vb, "pt") : vb.localeCompare(va, "pt");
      }
      const na = Number(va);
      const nb = Number(vb);
      return sortDir === "asc" ? na - nb : nb - na;
    });
  }, [linhas, tableSearch, filterFarmaciaTabela, filterRuturas, filterStockBaixo, sortCol, sortDir]);

  // ─── Prefill a partir do dashboard ───────────────────────────────────────────
  useEffect(() => {
    if (searchParams.get("prefill") !== "1") return;
    if (typeof window === "undefined") return;
    const raw = window.sessionStorage.getItem(PREFILL_KEY);
    if (!raw) return;
    window.sessionStorage.removeItem(PREFILL_KEY);

    let stash: PrefillStash;
    try {
      stash = JSON.parse(raw) as PrefillStash;
    } catch {
      return;
    }
    if (!Array.isArray(stash.lines) || stash.lines.length === 0) return;

    let resolvedFarmaciaId = "";
    if (stash.farmaciaId && farmacias.some((f) => f.id === stash.farmaciaId)) {
      resolvedFarmaciaId = stash.farmaciaId;
    } else if (stash.farmaciaNome) {
      resolvedFarmaciaId =
        farmacias.find((f) => f.nome === stash.farmaciaNome)?.id ?? "";
    }
    if (!resolvedFarmaciaId) {
      setFlash({
        type: "err",
        msg: "Farmácia da sugestão não encontrada — escolha uma farmácia e gere a proposta manualmente.",
      });
      return;
    }
    setFarmaciaId(resolvedFarmaciaId);

    const cnps: number[] = [];
    const qtyByCnp = new Map<number, number>();
    for (const l of stash.lines) {
      const cnp = typeof l.cnp === "number" ? l.cnp : Number(l.cnp);
      if (!Number.isFinite(cnp) || cnp <= 0) continue;
      cnps.push(cnp);
      const q = typeof l.quantidade === "number" ? l.quantidade : Number(l.quantidade);
      if (Number.isFinite(q) && q > 0) qtyByCnp.set(cnp, q);
    }
    if (cnps.length === 0) return;

    startGenerate(async () => {
      const products = await resolveProductsByCnpAction({
        cnps,
        farmaciaId: resolvedFarmaciaId,
      });
      setLinhas(
        products.map((p) => buildPrefillLine(p, qtyByCnp.get(p.cnp) ?? null, resolvedFarmaciaId))
      );
      setHasProposal(true);
      const missing = cnps.length - products.length;
      setFlash({
        type: "info",
        msg:
          missing > 0
            ? `${products.length} de ${cnps.length} produtos pré-preenchidos. ${missing} CNP não encontrados no catálogo.`
            : `${products.length} produtos pré-preenchidos a partir da sugestão.`,
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function buildPrefillLine(p: ProductSearchResult, qty: number | null, lineFarmaciaId: string): Line {
    return {
      key: nextKey(),
      produtoId: p.id,
      cnp: p.cnp,
      designacao: p.designacao,
      fabricante: p.fabricante,
      fornecedor: null,
      farmaciaNome: null,
      farmaciaId: lineFarmaciaId,
      salesQty: null,
      avgDailySales: null,
      currentStock: p.stockAtual,
      pendingQty: null,
      suggestedQty: qty,
      finalQty: qty != null ? String(qty) : "",
      notas: "",
      source: "prefill",
    };
  }

  function buildProposalLine(
    r: ProposalRow,
    farmaciaNome?: string | null,
    lineFarmaciaId?: string | null
  ): Line {
    return {
      key: nextKey(),
      produtoId: r.produtoId,
      cnp: r.cnp,
      designacao: r.designacao,
      fabricante: r.fabricante,
      fornecedor: r.fornecedor,
      farmaciaNome: farmaciaNome ?? null,
      farmaciaId: lineFarmaciaId ?? null,
      salesQty: r.salesQty,
      avgDailySales: r.avgDailySales,
      currentStock: r.currentStock,
      pendingQty: r.pendingQty,
      suggestedQty: r.suggestedQty,
      finalQty: String(r.suggestedQty),
      notas: "",
      source: "proposal",
    };
  }

  function buildManualLine(p: ProductSearchResult): Line {
    return {
      key: nextKey(),
      produtoId: p.id,
      cnp: p.cnp,
      designacao: p.designacao,
      fabricante: p.fabricante,
      fornecedor: null,
      farmaciaNome: null,
      farmaciaId: isTodasMode ? null : farmaciaId,
      salesQty: null,
      avgDailySales: null,
      currentStock: p.stockAtual,
      pendingQty: null,
      suggestedQty: null,
      finalQty: "1",
      notas: "",
      source: "manual",
    };
  }

  // ─── Acções ──────────────────────────────────────────────────────────────────

  function handleGenerate() {
    setFlash(null);
    if (!farmaciaId) {
      setFlash({ type: "err", msg: "Seleccione uma farmácia." });
      return;
    }
    if (linhas.length > 0) {
      const ok = window.confirm(
        "Gerar uma nova proposta substitui as linhas actuais. Continuar?"
      );
      if (!ok) return;
    }

    const commonInput = {
      startDate,
      endDate,
      considerStock,
      baseRule,
      targetCoverageDays: coverageDays,
      filters: {
        fabricantes: selFabricantes,
        fornecedores: selFornecedores,
        categorias: selCategorias,
        productTypes: selProductTypes,
      },
    };

    if (farmaciaId === TODAS_ID) {
      startGenerate(async () => {
        const results = await Promise.all(
          farmacias.map((f) =>
            generateProposalAction({ farmaciaId: f.id, ...commonInput }).then(
              (r) => ({ r, farmacia: f })
            )
          )
        );

        let numDays = 0;
        let totalAnalyzed = 0;
        const allLines: Line[] = [];
        const errors: string[] = [];

        for (const { r, farmacia } of results) {
          if (!r.ok) {
            errors.push(`${farmacia.nome}: ${r.error}`);
            continue;
          }
          numDays = r.data.meta.numDays;
          totalAnalyzed += r.data.rows.length;
          const farmLines = r.data.rows
            .filter((row) => row.suggestedQty > 0 || !considerStock)
            .map((row) => buildProposalLine(row, farmacia.nome, farmacia.id));
          allLines.push(...farmLines);
        }

        setLinhas(allLines);
        setHasProposal(true);
        setProposalMeta({ numDays, filtered: allLines.length });
        setFilterFarmaciaTabela("");

        if (errors.length > 0) {
          setFlash({
            type: "err",
            msg: `Erros em ${errors.length} farmácia(s): ${errors.join("; ")}`,
          });
        } else {
          setFlash({
            type: "info",
            msg: `${allLines.length} linhas · ${farmacias.length} farmácias · ${totalAnalyzed} produtos analisados · ${numDays} dias`,
          });
        }
      });
    } else {
      startGenerate(async () => {
        const result = await generateProposalAction({ farmaciaId, ...commonInput });
        if (!result.ok) {
          setFlash({ type: "err", msg: result.error });
          return;
        }
        const lines = result.data.rows
          .filter((r) => r.suggestedQty > 0 || !considerStock)
          .map((r) => buildProposalLine(r));
        setLinhas(lines);
        setHasProposal(true);
        setProposalMeta({
          numDays: result.data.meta.numDays,
          filtered: result.data.rows.length,
        });
        setFlash({
          type: "info",
          msg: `${lines.length} linhas propostas (${result.data.rows.length} produtos analisados em ${result.data.meta.numDays} dias).`,
        });
      });
    }
  }

  function handlePickManual(p: ProductSearchResult) {
    setLinhas((prev) => {
      const existing = prev.findIndex((l) => l.produtoId === p.id);
      if (existing >= 0) {
        return prev.map((l, i) => {
          if (i !== existing) return l;
          const cur = Number(l.finalQty || "0") || 0;
          return { ...l, finalQty: String(cur + 1) };
        });
      }
      return [...prev, buildManualLine(p)];
    });
  }

  function updateLine(key: number, patch: Partial<Line>) {
    setLinhas((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function removeLine(key: number) {
    setLinhas((prev) => prev.filter((l) => l.key !== key));
  }

  function handleFarmaciaChange(nextId: string) {
    if (nextId === farmaciaId) return;
    if (linhas.length > 0) {
      const ok = window.confirm(
        "Mudar de farmácia limpa as linhas actuais (stock e vendas são por farmácia). Continuar?"
      );
      if (!ok) return;
      setLinhas([]);
      setHasProposal(false);
      setProposalMeta(null);
    }
    setFarmaciaId(nextId);
    setFilterFarmaciaTabela("");
  }

  function handleSort(col: SortCol) {
    if (sortCol === col) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortCol(col);
      setSortDir("desc");
    }
  }

  function submit(finalize: boolean) {
    setFlash(null);
    if (isTodasMode) {
      setFlash({
        type: "err",
        msg: "Modo «Todas as farmácias» — seleccione uma farmácia específica para guardar a encomenda.",
      });
      return;
    }
    const validLines = linhas.filter((l) => {
      const q = Number(l.finalQty || "0");
      return Number.isFinite(q) && q > 0;
    });
    if (validLines.length === 0) {
      setFlash({
        type: "err",
        msg: "Sem linhas com quantidade > 0. Edite as quantidades ou remova linhas vazias.",
      });
      return;
    }

    const input: CreateOrderFormInput = {
      farmaciaId,
      nome: nome.trim() || `Encomenda ${new Date().toLocaleDateString("pt-PT")}`,
      finalize,
      linhas: validLines.map((l) => ({
        produtoId: l.produtoId,
        quantidadeSugerida: l.suggestedQty != null ? l.suggestedQty : null,
        quantidadeAjustada: Number(l.finalQty),
        notas: l.notas.trim() || null,
      })),
    };

    startTransition(async () => {
      const result = await createOrderAction(input);
      if (result.ok) {
        setFlash({
          type: "ok",
          msg: finalize
            ? "Encomenda criada e finalizada. A abrir o detalhe…"
            : "Rascunho guardado. A abrir o detalhe…",
        });
        setNome("");
        setLinhas([]);
        setHasProposal(false);
        setProposalMeta(null);
        setTimeout(() => router.push(`/encomendas/${result.listaEncomendaId}`), 800);
      } else {
        setFlash({ type: "err", msg: result.error });
      }
    });
  }

  const totalFinalVisible = visibleLinhas.reduce(
    (s, l) => s + (Number(l.finalQty || "0") || 0),
    0
  );
  const totalFinalAll = linhas.reduce(
    (s, l) => s + (Number(l.finalQty || "0") || 0),
    0
  );
  const hasTableFilters =
    !!tableSearch || filterRuturas || filterStockBaixo || !!filterFarmaciaTabela;

  const filtersCount =
    selFabricantes.length +
    selFornecedores.length +
    selCategorias.length +
    selProductTypes.length;

  return (
    <div className="space-y-6">
      {/*
       * Aviso permanente de posicionamento: assistente operacional, não motor
       * de decisão automática.
       */}
      <div
        role="note"
        aria-label="Aviso sobre as sugestões de encomenda"
        className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] leading-snug text-amber-900"
      >
        <span className="font-semibold">Assistente operacional.</span>{" "}
        As quantidades sugeridas baseiam-se em cobertura e rotação reais.
        Não contemplam descontos, MOQ, campanhas nem prazos do fornecedor —
        valide condições comerciais antes de finalizar a encomenda.
      </div>

      {flash && (
        <div
          className={`rounded-xl border px-4 py-3 text-[13px] ${
            flash.type === "ok"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : flash.type === "info"
                ? "border-cyan-200 bg-cyan-50 text-cyan-800"
                : "border-rose-200 bg-rose-50 text-rose-800"
          }`}
        >
          {flash.msg}
        </div>
      )}

      {/* CRITÉRIOS */}
      <section className="rounded-xl border border-slate-200 bg-white">
        <div className="border-b border-slate-100 px-4 py-3">
          <h2 className="text-[14px] font-semibold text-slate-900">Critérios de geração</h2>
          <p className="mt-0.5 text-[12px] text-slate-500">
            Define a janela de vendas e a regra de cálculo. A proposta é gerada a
            partir de vendas reais (VendaMensal). Produtos retirados são excluídos automaticamente.
          </p>
        </div>

        <div className="grid gap-4 px-4 py-4 md:grid-cols-3">
          <div>
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-slate-500">
              Farmácia
            </label>
            <select
              value={farmaciaId}
              onChange={(e) => handleFarmaciaChange(e.target.value)}
              disabled={busy || generating}
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-[14px] text-slate-800 shadow-sm focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-400 disabled:opacity-50"
            >
              <option value={TODAS_ID}>— Todas as farmácias —</option>
              {farmacias.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.nome}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-slate-500">
              Data início
            </label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              disabled={busy || generating}
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-[14px] text-slate-800 shadow-sm focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-400 disabled:opacity-50"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-slate-500">
              Data fim
            </label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              disabled={busy || generating}
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-[14px] text-slate-800 shadow-sm focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-400 disabled:opacity-50"
            />
          </div>

          <div className="md:col-span-2">
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-slate-500">
              Regra de cálculo
            </label>
            <div className="flex flex-wrap gap-3">
              <label className="inline-flex items-center gap-2 text-[13px] text-slate-700">
                <input
                  type="radio"
                  name="baseRule"
                  checked={baseRule === "coverage"}
                  onChange={() => setBaseRule("coverage")}
                  disabled={busy || generating}
                />
                Média diária × cobertura
              </label>
              <label className="inline-flex items-center gap-2 text-[13px] text-slate-700">
                <input
                  type="radio"
                  name="baseRule"
                  checked={baseRule === "total"}
                  onChange={() => setBaseRule("total")}
                  disabled={busy || generating || considerStock}
                  title={
                    considerStock
                      ? "Quando «considerar stock» está activo, a regra é fixa em média × cobertura"
                      : undefined
                  }
                />
                Total de vendas no período
              </label>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-slate-500">
              Cobertura alvo (dias)
            </label>
            <input
              type="number"
              min="1"
              value={coverageDays}
              onChange={(e) => setCoverageDays(Math.max(1, Number(e.target.value) || 1))}
              disabled={busy || generating || (baseRule === "total" && !considerStock)}
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-[14px] text-slate-800 shadow-sm focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-400 disabled:opacity-50"
            />
          </div>
        </div>

        <div className="grid gap-3 border-t border-slate-100 px-4 py-3 md:grid-cols-[auto_1fr_auto] md:items-center">
          <label className="inline-flex items-center gap-2 text-[13px] text-slate-700">
            <input
              type="checkbox"
              checked={considerStock}
              onChange={(e) => {
                const next = e.target.checked;
                setConsiderStock(next);
                if (next) setBaseRule("coverage");
              }}
              disabled={busy || generating}
            />
            Considerar stock e pendentes
          </label>
          <button
            type="button"
            onClick={() => setFiltersOpen((v) => !v)}
            disabled={busy || generating}
            className="inline-flex items-center justify-self-start gap-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            <ChevronDown
              className={`h-3.5 w-3.5 transition ${filtersOpen ? "rotate-180" : ""}`}
            />
            Filtros
            {filtersCount > 0 && (
              <span className="ml-1 rounded-full bg-cyan-50 px-2 text-[11px] font-semibold text-cyan-700">
                {filtersCount}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={handleGenerate}
            disabled={busy || generating || !farmaciaId}
            className="inline-flex items-center gap-2 rounded-xl border border-emerald-500 bg-emerald-600 px-5 py-2 text-[13px] font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {generating ? "A gerar…" : hasProposal ? "Gerar nova proposta" : "Gerar proposta"}
          </button>
        </div>

        {filtersOpen && (
          <div className="grid gap-4 border-t border-slate-100 px-4 py-4 md:grid-cols-2 lg:grid-cols-4">
            <FilterMulti
              label="Fabricantes"
              options={filterOptions.fabricantes}
              selected={selFabricantes}
              onChange={setSelFabricantes}
              disabled={busy || generating}
            />
            <FilterMulti
              label="Distribuidores"
              options={filterOptions.distribuidores}
              selected={selFornecedores}
              onChange={setSelFornecedores}
              disabled={busy || generating}
            />
            <FilterMulti
              label="Categorias"
              options={filterOptions.categorias}
              selected={selCategorias}
              onChange={setSelCategorias}
              disabled={busy || generating}
            />
            <FilterMulti
              label="Tipos de produto"
              options={productTypes}
              selected={selProductTypes}
              onChange={setSelProductTypes}
              disabled={busy || generating}
            />
          </div>
        )}
      </section>

      {/* PROPOSTA */}
      <section className="rounded-xl border border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <div>
            <h2 className="text-[14px] font-semibold text-slate-900">Proposta</h2>
            <p className="mt-0.5 text-[12px] text-slate-500">
              {linhas.length === 0
                ? hasProposal
                  ? "Sem linhas — todas com quantidade sugerida 0."
                  : "Defina os critérios e clique em Gerar proposta."
                : hasTableFilters
                  ? `${visibleLinhas.length} de ${linhas.length} linha${linhas.length === 1 ? "" : "s"} visíveis · total visível: ${totalFinalVisible} · total geral: ${totalFinalAll}${proposalMeta ? ` · ${proposalMeta.numDays} dias` : ""}`
                  : `${linhas.length} linha${linhas.length === 1 ? "" : "s"} · total a encomendar: ${totalFinalAll}${proposalMeta ? ` · ${proposalMeta.numDays} dias analisados` : ""}`}
            </p>
          </div>
        </div>

        {/* Barra de filtros da tabela — só visível quando há linhas */}
        {linhas.length > 0 && (
          <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 bg-slate-50/50 px-4 py-2.5">
            <input
              type="text"
              value={tableSearch}
              onChange={(e) => setTableSearch(e.target.value)}
              placeholder="Pesquisar produto, CNP, fabricante…"
              className="w-56 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12px] placeholder:text-slate-400 focus:border-cyan-400 focus:outline-none"
            />
            {isTodasMode && farmaciaOptions.length > 0 && (
              <select
                value={filterFarmaciaTabela}
                onChange={(e) => setFilterFarmaciaTabela(e.target.value)}
                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12px] text-slate-700 focus:border-cyan-400 focus:outline-none"
              >
                <option value="">Todas as farmácias</option>
                {farmaciaOptions.map((f) => (
                  <option key={f.id} value={f.nome}>
                    {f.nome}
                  </option>
                ))}
              </select>
            )}
            <label className="inline-flex cursor-pointer items-center gap-1.5 text-[12px] text-slate-700">
              <input
                type="checkbox"
                checked={filterRuturas}
                onChange={(e) => {
                  setFilterRuturas(e.target.checked);
                  if (e.target.checked) setFilterStockBaixo(false);
                }}
                className="rounded"
              />
              Apenas ruturas (stock = 0)
            </label>
            <label className="inline-flex cursor-pointer items-center gap-1.5 text-[12px] text-slate-700">
              <input
                type="checkbox"
                checked={filterStockBaixo}
                onChange={(e) => {
                  setFilterStockBaixo(e.target.checked);
                  if (e.target.checked) setFilterRuturas(false);
                }}
                className="rounded"
              />
              Stock baixo (tem stock, precisa encomenda)
            </label>
            {hasTableFilters && (
              <button
                type="button"
                onClick={() => {
                  setTableSearch("");
                  setFilterRuturas(false);
                  setFilterStockBaixo(false);
                  setFilterFarmaciaTabela("");
                }}
                className="ml-auto text-[11px] text-slate-500 hover:text-slate-700"
              >
                Limpar filtros
              </button>
            )}
          </div>
        )}

        {linhas.length === 0 ? (
          <div className="px-4 py-10 text-center text-[12px] text-slate-400">
            {generating ? "A calcular proposta…" : "Sem linhas."}
          </div>
        ) : visibleLinhas.length === 0 ? (
          <div className="px-4 py-10 text-center text-[12px] text-slate-400">
            Nenhuma linha corresponde aos filtros activos.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-slate-100 text-left">
                  <SortableHeader col="designacao" label="Produto" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
                  {isTodasMode && (
                    <SortableHeader col="farmaciaNome" label="Farmácia" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
                  )}
                  <SortableHeader col="salesQty" label="Vendas" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} right />
                  <SortableHeader col="avgDailySales" label="Média/dia" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} right />
                  <SortableHeader col="currentStock" label="Stock" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} right />
                  <SortableHeader col="coberturaAtual" label="Cobert. (d)" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} right />
                  <SortableHeader col="pendingQty" label="Pendente" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} right />
                  <SortableHeader col="suggestedQty" label="Sugerida" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} right />
                  <th className="px-3 py-2 text-right text-[10px] font-medium uppercase tracking-wider text-slate-400">Final</th>
                  <th className="px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-slate-400">Notas</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {visibleLinhas.map((l) => {
                  const coberturaAtual =
                    l.currentStock != null && l.avgDailySales != null && l.avgDailySales > 0
                      ? l.currentStock / l.avgDailySales
                      : null;
                  const isRutura = l.currentStock != null && l.currentStock <= 0;
                  const isStockBaixo = !isRutura && coberturaAtual != null && coberturaAtual < 7;
                  return (
                    <tr
                      key={l.key}
                      className={`border-b border-slate-50 ${
                        isRutura ? "bg-rose-50/40" : isStockBaixo ? "bg-amber-50/30" : ""
                      }`}
                    >
                      <td className="px-3 py-2">
                        <div className="flex items-baseline gap-2">
                          <span className="font-medium text-slate-900">{l.designacao}</span>
                          {isRutura && (
                            <span className="rounded-full border border-rose-200 bg-rose-50 px-1.5 text-[10px] font-semibold text-rose-700">
                              rutura
                            </span>
                          )}
                          {l.source === "manual" && (
                            <span className="rounded-full border border-amber-200 bg-amber-50 px-1.5 text-[10px] font-medium text-amber-700">
                              manual
                            </span>
                          )}
                          {l.source === "prefill" && (
                            <span className="rounded-full border border-cyan-200 bg-cyan-50 px-1.5 text-[10px] font-medium text-cyan-700">
                              sugestão
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-slate-500">
                          <span className="font-mono">CNP {l.cnp}</span>
                          {l.fabricante && (
                            <>
                              <span className="text-slate-300">·</span>
                              <span>{l.fabricante}</span>
                            </>
                          )}
                          {l.fornecedor && (
                            <>
                              <span className="text-slate-300">·</span>
                              <span className="text-slate-400">{l.fornecedor}</span>
                            </>
                          )}
                        </div>
                      </td>
                      {isTodasMode && (
                        <td className="px-3 py-2 text-[11px] text-slate-600">
                          {l.farmaciaNome ?? "—"}
                        </td>
                      )}
                      <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                        {fmtNum(l.salesQty)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                        {fmtNum(l.avgDailySales, 1)}
                      </td>
                      <td
                        className={`px-3 py-2 text-right tabular-nums font-medium ${
                          isRutura ? "text-rose-600" : "text-slate-700"
                        }`}
                      >
                        {fmtNum(l.currentStock)}
                      </td>
                      <td
                        className={`px-3 py-2 text-right tabular-nums ${
                          coberturaAtual != null && coberturaAtual < 7
                            ? "font-medium text-amber-600"
                            : "text-slate-500"
                        }`}
                      >
                        {coberturaAtual != null ? coberturaAtual.toFixed(1) : "—"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-500">
                        {fmtNum(l.pendingQty)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums font-semibold text-slate-800">
                        {fmtNum(l.suggestedQty)}
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="number"
                          min="0"
                          value={l.finalQty}
                          onChange={(e) => updateLine(l.key, { finalQty: e.target.value })}
                          disabled={busy}
                          className="w-20 rounded-lg border border-slate-200 px-2 py-1 text-right text-[13px] focus:border-cyan-400 focus:outline-none disabled:opacity-50"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="text"
                          value={l.notas}
                          onChange={(e) => updateLine(l.key, { notas: e.target.value })}
                          placeholder="opcional"
                          disabled={busy}
                          className="w-full rounded-lg border border-slate-200 px-2 py-1 text-[12px] placeholder:text-slate-300 focus:border-cyan-400 focus:outline-none disabled:opacity-50"
                        />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => removeLine(l.key)}
                          disabled={busy}
                          title="Remover linha"
                          className="rounded-md border border-slate-200 p-1.5 text-slate-500 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-700 disabled:opacity-50"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* PICKER MANUAL */}
      <section className="rounded-xl border border-slate-200 bg-white">
        <button
          type="button"
          onClick={() => {
            if (!isTodasMode) setManualOpen((v) => !v);
          }}
          disabled={isTodasMode}
          className={`flex w-full items-center justify-between border-b border-slate-100 px-4 py-3 text-left ${
            isTodasMode ? "cursor-not-allowed opacity-40" : ""
          }`}
        >
          <div>
            <h2 className="text-[14px] font-semibold text-slate-900">
              Adicionar produto manual
            </h2>
            <p className="mt-0.5 text-[12px] text-slate-500">
              {isTodasMode
                ? "Seleccione uma farmácia específica para adicionar produtos manualmente."
                : "Excepção para produtos sem vendas no período ou fora dos filtros."}
            </p>
          </div>
          {!isTodasMode && (
            <Plus
              className={`h-4 w-4 text-slate-400 transition ${manualOpen ? "rotate-45" : ""}`}
            />
          )}
        </button>
        {manualOpen && !isTodasMode && (
          <div className="p-4">
            <ProductPicker
              farmaciaId={farmaciaId}
              disabled={busy || generating}
              onPick={handlePickManual}
            />
          </div>
        )}
      </section>

      {/* CABEÇALHO + FINALIZAR */}
      <section className="rounded-xl border border-slate-200 bg-white px-4 py-4">
        {isTodasMode ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800">
            <span className="font-semibold">Modo comparação.</span> Seleccione uma farmácia
            específica para criar uma encomenda.
            {linhas.length > 0 && (
              <span className="ml-2 text-amber-700">
                ({linhas.length} linhas geradas para {farmacias.length} farmácias — use o filtro acima para ver por farmácia.)
              </span>
            )}
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-[1fr_auto_auto] md:items-end">
            <div>
              <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-slate-500">
                Nome da encomenda
              </label>
              <input
                type="text"
                value={nome}
                onChange={(e) => setNome(e.target.value)}
                placeholder={`Encomenda ${new Date().toLocaleDateString("pt-PT")}`}
                disabled={busy}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-[14px] text-slate-800 shadow-sm placeholder:text-slate-400 focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-400 disabled:opacity-50"
              />
            </div>
            <button
              type="button"
              onClick={() => submit(false)}
              disabled={busy || linhas.length === 0}
              className="rounded-xl border border-slate-300 bg-white px-5 py-2.5 text-[13px] font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50"
            >
              {busy ? "A guardar..." : "Guardar rascunho"}
            </button>
            <button
              type="button"
              onClick={() => submit(true)}
              disabled={busy || linhas.length === 0}
              className="rounded-xl border border-cyan-500 bg-cyan-600 px-5 py-2.5 text-[13px] font-medium text-white shadow-sm hover:bg-cyan-700 disabled:opacity-50"
            >
              {busy ? "A finalizar..." : "Finalizar e enviar para fila"}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

// ─── SortableHeader ───────────────────────────────────────────────────────────

function SortableHeader({
  col,
  label,
  sortCol,
  sortDir,
  onSort,
  right = false,
}: {
  col: SortCol;
  label: string;
  sortCol: SortCol;
  sortDir: "asc" | "desc";
  onSort: (col: SortCol) => void;
  right?: boolean;
}) {
  const active = sortCol === col;
  return (
    <th className={`px-3 py-2 ${right ? "text-right" : ""}`}>
      <button
        type="button"
        onClick={() => onSort(col)}
        className={`inline-flex items-center gap-0.5 text-[10px] font-medium uppercase tracking-wider transition-colors ${
          active ? "text-cyan-600" : "text-slate-400 hover:text-slate-600"
        }`}
      >
        {label}
        {active ? (
          sortDir === "asc" ? (
            <ChevronUp className="h-3 w-3" />
          ) : (
            <ChevronDown className="h-3 w-3" />
          )
        ) : (
          <ChevronsUpDown className="h-3 w-3 opacity-40" />
        )}
      </button>
    </th>
  );
}

// ─── FilterMulti ─────────────────────────────────────────────────────────────

function FilterMulti({
  label,
  options,
  selected,
  onChange,
  disabled,
}: {
  label: string;
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.toLowerCase().includes(q));
  }, [options, query]);

  function toggle(value: string) {
    onChange(
      selected.includes(value)
        ? selected.filter((v) => v !== value)
        : [...selected, value]
    );
  }

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <label className="text-[11px] font-medium uppercase tracking-wider text-slate-500">
          {label}
        </label>
        {selected.length > 0 && (
          <button
            type="button"
            onClick={() => onChange([])}
            disabled={disabled}
            className="text-[11px] text-slate-500 hover:text-slate-700"
          >
            Limpar
          </button>
        )}
      </div>
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={`Procurar… (${options.length})`}
        disabled={disabled}
        className="mb-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[12px] placeholder:text-slate-400 focus:border-cyan-400 focus:outline-none disabled:opacity-50"
      />
      <div className="max-h-44 overflow-y-auto rounded-lg border border-slate-200 bg-white">
        {filtered.length === 0 ? (
          <div className="px-2 py-2 text-[11px] text-slate-400">Sem resultados.</div>
        ) : (
          <ul>
            {filtered.map((o) => (
              <li key={o}>
                <label className="flex cursor-pointer items-center gap-2 px-2 py-1 text-[12px] hover:bg-slate-50">
                  <input
                    type="checkbox"
                    checked={selected.includes(o)}
                    onChange={() => toggle(o)}
                    disabled={disabled}
                  />
                  <span className="truncate">{o}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
