"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, Plus, Trash2 } from "lucide-react";
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

type Line = {
  key: number;
  produtoId: string;
  cnp: number;
  designacao: string;
  fabricante: string | null;
  fornecedor: string | null;
  salesQty: number | null;
  avgDailySales: number | null;
  currentStock: number | null;
  pendingQty: number | null;
  suggestedQty: number | null;
  finalQty: string;
  notas: string;
  source: "proposal" | "manual" | "prefill";
};

type Props = {
  farmacias: { id: string; nome: string }[];
  filterOptions: ReportingFilterOptions;
  productTypes: string[];
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

function defaultPeriod(): { start: string; end: string } {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 29);
  return { start: isoDate(start), end: isoDate(end) };
}

export function OrderCreateClient({ farmacias, filterOptions, productTypes }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [busy, startTransition] = useTransition();
  const [generating, startGenerate] = useTransition();
  const [flash, setFlash] = useState<{ type: "ok" | "err" | "info"; msg: string } | null>(
    null
  );

  // Critérios
  const period = useMemo(defaultPeriod, []);
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

  // Linhas
  const [linhas, setLinhas] = useState<Line[]>([]);
  const [hasProposal, setHasProposal] = useState(false);
  const [proposalMeta, setProposalMeta] = useState<{
    numDays: number;
    filtered: number;
  } | null>(null);

  // Picker manual
  const [manualOpen, setManualOpen] = useState(false);

  // Header
  const [nome, setNome] = useState("");

  // ───────── Prefill a partir do dashboard ─────────
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
        products.map((p) =>
          buildPrefillLine(p, qtyByCnp.get(p.cnp) ?? null)
        )
      );
      setHasProposal(true);
      const missing = cnps.length - products.length;
      setFlash({
        type: "info",
        msg:
          missing > 0
            ? `${products.length} de ${cnps.length} produtos pré-preenchidos. ${missing} CNP não foram encontrados no catálogo.`
            : `${products.length} produtos pré-preenchidos a partir da sugestão.`,
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function buildPrefillLine(p: ProductSearchResult, qty: number | null): Line {
    return {
      key: nextKey(),
      produtoId: p.id,
      cnp: p.cnp,
      designacao: p.designacao,
      fabricante: p.fabricante,
      fornecedor: null,
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

  function buildProposalLine(r: ProposalRow): Line {
    return {
      key: nextKey(),
      produtoId: r.produtoId,
      cnp: r.cnp,
      designacao: r.designacao,
      fabricante: r.fabricante,
      fornecedor: r.fornecedor,
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

  // ───────── Acções ─────────

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
    startGenerate(async () => {
      const result = await generateProposalAction({
        farmaciaId,
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
      });
      if (!result.ok) {
        setFlash({ type: "err", msg: result.error });
        return;
      }
      const lines = result.data.rows
        .filter((r) => r.suggestedQty > 0 || !considerStock)
        .map(buildProposalLine);
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
  }

  function submit(finalize: boolean) {
    setFlash(null);
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
            ? `Encomenda criada e finalizada. A abrir o detalhe…`
            : `Rascunho guardado. A abrir o detalhe…`,
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

  const totalFinal = linhas.reduce(
    (s, l) => s + (Number(l.finalQty || "0") || 0),
    0
  );

  const filtersCount =
    selFabricantes.length +
    selFornecedores.length +
    selCategorias.length +
    selProductTypes.length;

  return (
    <div className="space-y-6">
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
          <h2 className="text-[14px] font-semibold text-slate-900">
            Critérios de geração
          </h2>
          <p className="mt-0.5 text-[12px] text-slate-500">
            Define a janela de vendas e a regra de cálculo. A proposta é gerada a
            partir destas vendas reais.
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
                      ? "Quando considerar stock está activo, a regra é fixa em média × cobertura"
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
                : `${linhas.length} linha${linhas.length === 1 ? "" : "s"} · total a encomendar: ${totalFinal}${proposalMeta ? ` · ${proposalMeta.numDays} dias analisados` : ""}`}
            </p>
          </div>
        </div>

        {linhas.length === 0 ? (
          <div className="px-4 py-10 text-center text-[12px] text-slate-400">
            {generating ? "A calcular proposta…" : "Sem linhas."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-slate-100 text-left text-[10px] uppercase tracking-wider text-slate-400">
                  <th className="px-3 py-2">Produto</th>
                  <th className="px-3 py-2 text-right">Vendas</th>
                  <th className="px-3 py-2 text-right">Média/dia</th>
                  <th className="px-3 py-2 text-right">Stock</th>
                  <th className="px-3 py-2 text-right">Pendente</th>
                  <th className="px-3 py-2 text-right">Sugerida</th>
                  <th className="px-3 py-2 text-right">Final</th>
                  <th className="px-3 py-2">Notas</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {linhas.map((l) => (
                  <tr key={l.key} className="border-b border-slate-50">
                    <td className="px-3 py-2">
                      <div className="flex items-baseline gap-2">
                        <span className="font-medium text-slate-900">
                          {l.designacao}
                        </span>
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
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                      {fmtNum(l.salesQty)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                      {fmtNum(l.avgDailySales, 1)}
                    </td>
                    <td
                      className={`px-3 py-2 text-right tabular-nums ${
                        l.currentStock != null && l.currentStock <= 0
                          ? "text-rose-600"
                          : "text-slate-700"
                      }`}
                    >
                      {fmtNum(l.currentStock)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-500">
                      {fmtNum(l.pendingQty)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium text-slate-800">
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
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* PICKER MANUAL (auxiliar) */}
      <section className="rounded-xl border border-slate-200 bg-white">
        <button
          type="button"
          onClick={() => setManualOpen((v) => !v)}
          className="flex w-full items-center justify-between border-b border-slate-100 px-4 py-3 text-left"
        >
          <div>
            <h2 className="text-[14px] font-semibold text-slate-900">
              Adicionar produto manual
            </h2>
            <p className="mt-0.5 text-[12px] text-slate-500">
              Excepção para produtos sem vendas no período ou fora dos filtros.
            </p>
          </div>
          <Plus
            className={`h-4 w-4 text-slate-400 transition ${manualOpen ? "rotate-45" : ""}`}
          />
        </button>
        {manualOpen && (
          <div className="p-4">
            <ProductPicker
              farmaciaId={farmaciaId}
              disabled={busy || generating}
              onPick={handlePickManual}
            />
          </div>
        )}
      </section>

      {/* CABECALHO + FINALIZAR */}
      <section className="rounded-xl border border-slate-200 bg-white px-4 py-4">
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
      </section>
    </div>
  );
}

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
