"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, ChevronUp, ChevronsUpDown, Plus, Trash2, ArrowLeftRight } from "lucide-react";
import {
  createOrderAction,
  createInternalTransferAction,
  generateProposalAction,
  type CreateOrderFormInput,
  type ProposalMode,
} from "@/app/encomendas/nova/actions";
import {
  resolveProductsByCnpAction,
  type ProductSearchResult,
} from "@/app/encomendas/nova/search";
import { ProductPicker } from "@/components/encomendas/product-picker";
import type {
  ProposalRow,
  ProposalBaseRule,
  ProposalEstado,
  ProposalStats,
  ExcessoInfo,
} from "@/lib/encomendas/proposal";
import type { ReportingFilterOptions } from "@/lib/reporting-filter-options";

// ─── Tipos locais ─────────────────────────────────────────────────────────────

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
  coberturaAtualDias: number | null;
  pendingQty: number | null;
  suggestedQty: number | null;
  transferirQty: number;
  finalQty: string;
  notas: string;
  source: "proposal" | "manual" | "prefill";
  estado: ProposalEstado | null;
  motivo: string | null;
  excessoFonte: ExcessoInfo[];
};

type SortCol =
  | "designacao"
  | "farmaciaNome"
  | "salesQty"
  | "avgDailySales"
  | "currentStock"
  | "coberturaAtualDias"
  | "pendingQty"
  | "suggestedQty";

type Props = {
  farmacias: { id: string; nome: string }[];
  filterOptions: ReportingFilterOptions;
  productTypes: string[];
  latestDataMonth?: { ano: number; mes: number } | null;
  userPerfil: string;
  userFarmaciaId: string | null;
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

const CAN_GROUP_PERFIS = new Set(["ADMINISTRADOR", "GESTOR_GRUPO"]);

// ─── Utils ────────────────────────────────────────────────────────────────────

function fmtNum(v: number | null | undefined, digits = 0): string {
  if (v == null) return "—";
  if (digits === 0) return String(Math.round(v));
  return v.toFixed(digits);
}

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function defaultPeriod(latest?: { ano: number; mes: number } | null) {
  if (latest) {
    const end = new Date(latest.ano, latest.mes, 0);
    const start = new Date(latest.ano, latest.mes - 1 - 2, 1);
    return { start: isoDate(start), end: isoDate(end) };
  }
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 89);
  return { start: isoDate(start), end: isoDate(end) };
}

function estadoLabel(e: ProposalEstado): string {
  switch (e) {
    case "TRANSFERÊNCIA": return "Transferência";
    case "COMPRAR": return "Comprar";
    case "AGUARDAR": return "Aguardar";
    case "ADEQUADO": return "Adequado";
  }
}

function estadoColors(e: ProposalEstado): string {
  switch (e) {
    case "TRANSFERÊNCIA": return "bg-blue-50 text-blue-700 border-blue-200";
    case "COMPRAR": return "bg-rose-50 text-rose-700 border-rose-200";
    case "AGUARDAR": return "bg-amber-50 text-amber-700 border-amber-200";
    case "ADEQUADO": return "bg-emerald-50 text-emerald-700 border-emerald-200";
  }
}

function rowBg(e: ProposalEstado | null): string {
  if (!e) return "";
  switch (e) {
    case "TRANSFERÊNCIA": return "bg-blue-50/30";
    case "COMPRAR": return "";
    case "AGUARDAR": return "bg-amber-50/20";
    case "ADEQUADO": return "bg-emerald-50/20";
  }
}

// ─── Componente principal ─────────────────────────────────────────────────────

export function OrderCreateClient({
  farmacias,
  filterOptions,
  productTypes,
  latestDataMonth,
  userPerfil,
  userFarmaciaId,
}: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [busy, startTransition] = useTransition();
  const [generating, startGenerate] = useTransition();
  const [creatingTransfer, startTransfer] = useTransition();
  const [flash, setFlash] = useState<{ type: "ok" | "err" | "info"; msg: string } | null>(null);

  const canGroupMode = CAN_GROUP_PERFIS.has(userPerfil);

  // Farmácias visíveis para o utilizador
  const farmaciasVisiveis = useMemo(() => {
    if (canGroupMode) return farmacias;
    if (!userFarmaciaId) return farmacias;
    return farmacias.filter((f) => f.id === userFarmaciaId);
  }, [farmacias, canGroupMode, userFarmaciaId]);

  // ─── Modo ────────────────────────────────────────────────────────────────
  const [mode, setMode] = useState<ProposalMode>("farmacia");

  // ─── Critérios ───────────────────────────────────────────────────────────
  const period = useMemo(() => defaultPeriod(latestDataMonth), []);
  const [farmaciaId, setFarmaciaId] = useState(farmaciasVisiveis[0]?.id ?? "");
  const [startDate, setStartDate] = useState(period.start);
  const [endDate, setEndDate] = useState(period.end);
  const [considerStock, setConsiderStock] = useState(true);
  const [baseRule, setBaseRule] = useState<ProposalBaseRule>("coverage");
  const [coverageDays, setCoverageDays] = useState(15);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selFabricantes, setSelFabricantes] = useState<string[]>([]);
  const [selFornecedores, setSelFornecedores] = useState<string[]>([]);
  const [selCategorias, setSelCategorias] = useState<string[]>([]);
  const [selSubcategorias, setSelSubcategorias] = useState<string[]>([]);
  const [selUtilizacoes, setSelUtilizacoes] = useState<string[]>([]);
  const [selProductTypes, setSelProductTypes] = useState<string[]>([]);

  // Subcategorias acompanham a categoria escolhida — oferecer uma
  // subcategoria de outra categoria é oferecer zero linhas.
  const subcategoriasVisiveis = (
    selCategorias.length > 0
      ? filterOptions.subcategorias.filter((s) => selCategorias.includes(s.categoria))
      : filterOptions.subcategorias
  ).map((s) => s.nome);
  // O filtro viaja em slug; mostra-se pelo nome.
  const nomePorSlug = new Map(filterOptions.utilizacoes.map((u) => [u.slug, u.nome]));
  const slugPorNome = new Map(filterOptions.utilizacoes.map((u) => [u.nome, u.slug]));

  // ─── Linhas ──────────────────────────────────────────────────────────────
  const [linhas, setLinhas] = useState<Line[]>([]);
  const [hasProposal, setHasProposal] = useState(false);
  const [proposalMeta, setProposalMeta] = useState<{
    numDays: number;
    stats: ProposalStats;
  } | null>(null);

  // ─── Filtros da tabela ────────────────────────────────────────────────────
  const [tableSearch, setTableSearch] = useState("");
  const [filterEstado, setFilterEstado] = useState<ProposalEstado | null>(null);
  const [filterFarmaciaTabela, setFilterFarmaciaTabela] = useState("");
  const [filterRuturas, setFilterRuturas] = useState(false);
  const [filterStockBaixo, setFilterStockBaixo] = useState(false);
  const [sortCol, setSortCol] = useState<SortCol>("salesQty");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  // ─── Picker manual ────────────────────────────────────────────────────────
  const [manualOpen, setManualOpen] = useState(false);

  // ─── Cabeçalho ────────────────────────────────────────────────────────────
  const [nome, setNome] = useState("");

  const isGroupMode = mode === "grupo" || mode === "consolidacao";

  // Farmácias com linhas (para filtro em modo grupo)
  const farmaciaOptions = useMemo(() => {
    if (!isGroupMode) return [];
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
  }, [linhas, isGroupMode, farmacias]);

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
    if (filterFarmaciaTabela) list = list.filter((l) => l.farmaciaNome === filterFarmaciaTabela);
    if (filterEstado) list = list.filter((l) => l.estado === filterEstado);
    if (filterRuturas) list = list.filter((l) => l.currentStock != null && l.currentStock <= 0);
    if (filterStockBaixo)
      list = list.filter(
        (l) => l.currentStock != null && l.currentStock > 0 && l.suggestedQty != null && l.suggestedQty > 0
      );

    return [...list].sort((a, b) => {
      let va: number | string | null = null;
      let vb: number | string | null = null;
      switch (sortCol) {
        case "designacao": va = a.designacao; vb = b.designacao; break;
        case "farmaciaNome": va = a.farmaciaNome ?? ""; vb = b.farmaciaNome ?? ""; break;
        case "salesQty": va = a.salesQty; vb = b.salesQty; break;
        case "avgDailySales": va = a.avgDailySales; vb = b.avgDailySales; break;
        case "currentStock": va = a.currentStock; vb = b.currentStock; break;
        case "coberturaAtualDias": va = a.coberturaAtualDias; vb = b.coberturaAtualDias; break;
        case "pendingQty": va = a.pendingQty; vb = b.pendingQty; break;
        case "suggestedQty": va = a.suggestedQty; vb = b.suggestedQty; break;
      }
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      if (typeof va === "string" && typeof vb === "string")
        return sortDir === "asc" ? va.localeCompare(vb, "pt") : vb.localeCompare(va, "pt");
      return sortDir === "asc" ? Number(va) - Number(vb) : Number(vb) - Number(va);
    });
  }, [linhas, tableSearch, filterFarmaciaTabela, filterEstado, filterRuturas, filterStockBaixo, sortCol, sortDir]);

  // Vista consolidada (agrupada por produto)
  const consolidadoRows = useMemo(() => {
    if (mode !== "consolidacao") return [];
    const byProduct = new Map<
      string,
      {
        produtoId: string; cnp: number; designacao: string; fabricante: string | null;
        totalFinalQty: number;
        estadoPriority: ProposalEstado;
        farmaciaLinhas: Line[];
      }
    >();
    const priority: Record<ProposalEstado, number> = {
      COMPRAR: 4, TRANSFERÊNCIA: 3, AGUARDAR: 2, ADEQUADO: 1,
    };
    for (const l of linhas) {
      const k = l.produtoId;
      if (!byProduct.has(k)) {
        byProduct.set(k, {
          produtoId: l.produtoId, cnp: l.cnp, designacao: l.designacao,
          fabricante: l.fabricante, totalFinalQty: 0,
          estadoPriority: l.estado ?? "ADEQUADO", farmaciaLinhas: [],
        });
      }
      const g = byProduct.get(k)!;
      g.totalFinalQty += Number(l.finalQty || "0") || 0;
      g.farmaciaLinhas.push(l);
      const ep = l.estado ? priority[l.estado] : 0;
      const gp = priority[g.estadoPriority];
      if (ep > gp) g.estadoPriority = l.estado ?? g.estadoPriority;
    }
    return [...byProduct.values()].sort(
      (a, b) =>
        (priority[b.estadoPriority] ?? 0) - (priority[a.estadoPriority] ?? 0) ||
        b.totalFinalQty - a.totalFinalQty
    );
  }, [linhas, mode]);

  // ─── Prefill ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (searchParams.get("prefill") !== "1") return;
    if (typeof window === "undefined") return;
    const raw = window.sessionStorage.getItem(PREFILL_KEY);
    if (!raw) return;
    window.sessionStorage.removeItem(PREFILL_KEY);

    let stash: PrefillStash;
    try { stash = JSON.parse(raw) as PrefillStash; } catch { return; }
    if (!Array.isArray(stash.lines) || stash.lines.length === 0) return;

    let resolvedFarmaciaId = "";
    if (stash.farmaciaId && farmaciasVisiveis.some((f) => f.id === stash.farmaciaId))
      resolvedFarmaciaId = stash.farmaciaId;
    else if (stash.farmaciaNome)
      resolvedFarmaciaId = farmaciasVisiveis.find((f) => f.nome === stash.farmaciaNome)?.id ?? "";

    if (!resolvedFarmaciaId) {
      setFlash({ type: "err", msg: "Farmácia da sugestão não encontrada." });
      return;
    }
    setFarmaciaId(resolvedFarmaciaId);

    const cnps: number[] = [];
    const qtyByCnp = new Map<number, number>();
    for (const l of stash.lines) {
      const cnp = Number(l.cnp);
      if (!Number.isFinite(cnp) || cnp <= 0) continue;
      cnps.push(cnp);
      const q = Number(l.quantidade);
      if (Number.isFinite(q) && q > 0) qtyByCnp.set(cnp, q);
    }
    if (cnps.length === 0) return;

    startGenerate(async () => {
      const products = await resolveProductsByCnpAction({ cnps, farmaciaId: resolvedFarmaciaId });
      const farmNome = farmaciasVisiveis.find((f) => f.id === resolvedFarmaciaId)?.nome ?? null;
      setLinhas(products.map((p) => buildPrefillLine(p, qtyByCnp.get(p.cnp) ?? null, resolvedFarmaciaId, farmNome)));
      setHasProposal(true);
      const missing = cnps.length - products.length;
      setFlash({
        type: "info",
        msg: missing > 0
          ? `${products.length} de ${cnps.length} produtos pré-preenchidos. ${missing} CNP não encontrados.`
          : `${products.length} produtos pré-preenchidos.`,
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Builders de linha ────────────────────────────────────────────────────

  function buildPrefillLine(
    p: ProductSearchResult,
    qty: number | null,
    lineFarmaciaId: string,
    lineFarmaciaNome: string | null
  ): Line {
    return {
      key: nextKey(), produtoId: p.id, cnp: p.cnp, designacao: p.designacao,
      fabricante: p.fabricante, fornecedor: null,
      farmaciaNome: lineFarmaciaNome, farmaciaId: lineFarmaciaId,
      salesQty: null, avgDailySales: null, currentStock: p.stockAtual,
      coberturaAtualDias: null, pendingQty: null, suggestedQty: qty,
      transferirQty: 0, finalQty: qty != null ? String(qty) : "", notas: "",
      source: "prefill", estado: null, motivo: null, excessoFonte: [],
    };
  }

  function buildProposalLine(r: ProposalRow): Line {
    return {
      key: nextKey(), produtoId: r.produtoId, cnp: r.cnp, designacao: r.designacao,
      fabricante: r.fabricante, fornecedor: r.fornecedor,
      farmaciaNome: r.farmaciaNome, farmaciaId: r.farmaciaId,
      salesQty: r.salesQty, avgDailySales: r.avgDailySales,
      currentStock: r.currentStock, coberturaAtualDias: r.coberturaAtualDias,
      pendingQty: r.pendingQty, suggestedQty: r.suggestedQty,
      transferirQty: r.transferirQty,
      finalQty: r.estado === "TRANSFERÊNCIA" ? "0" : String(r.suggestedQty),
      notas: "", source: "proposal",
      estado: r.estado, motivo: r.motivo, excessoFonte: r.excessoFonte,
    };
  }

  function buildManualLine(p: ProductSearchResult): Line {
    return {
      key: nextKey(), produtoId: p.id, cnp: p.cnp, designacao: p.designacao,
      fabricante: p.fabricante, fornecedor: null,
      farmaciaNome: isGroupMode ? null : (farmaciasVisiveis.find((f) => f.id === farmaciaId)?.nome ?? null),
      farmaciaId: isGroupMode ? null : farmaciaId,
      salesQty: null, avgDailySales: null, currentStock: p.stockAtual,
      coberturaAtualDias: null, pendingQty: null, suggestedQty: null,
      transferirQty: 0, finalQty: "1", notas: "",
      source: "manual", estado: null, motivo: null, excessoFonte: [],
    };
  }

  // ─── Acções ───────────────────────────────────────────────────────────────

  function handleModeChange(next: ProposalMode) {
    if (next === mode) return;
    if (linhas.length > 0 && !window.confirm("Mudar de modo limpa as linhas actuais. Continuar?"))
      return;
    setLinhas([]);
    setHasProposal(false);
    setProposalMeta(null);
    setFilterEstado(null);
    setMode(next);
  }

  function handleFarmaciaChange(nextId: string) {
    if (nextId === farmaciaId) return;
    if (linhas.length > 0 && !window.confirm("Mudar de farmácia limpa as linhas actuais. Continuar?")) return;
    setLinhas([]);
    setHasProposal(false);
    setProposalMeta(null);
    setFarmaciaId(nextId);
  }

  function handleSort(col: SortCol) {
    if (sortCol === col) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortCol(col); setSortDir("desc"); }
  }

  function handleGenerate() {
    setFlash(null);
    if (mode === "farmacia" && !farmaciaId) {
      setFlash({ type: "err", msg: "Seleccione uma farmácia." });
      return;
    }
    if (linhas.length > 0 && !window.confirm("Gerar nova proposta substitui as linhas actuais. Continuar?"))
      return;

    const commonInput = {
      mode,
      farmaciaId: mode === "farmacia" ? farmaciaId : undefined,
      startDate, endDate, considerStock, baseRule,
      targetCoverageDays: coverageDays,
      filters: {
        fabricantes: selFabricantes, fornecedores: selFornecedores,
        categorias: selCategorias, subcategorias: selSubcategorias,
        utilizacoes: selUtilizacoes, productTypes: selProductTypes,
      },
    };

    startGenerate(async () => {
      const result = await generateProposalAction(commonInput);
      if (!result.ok) { setFlash({ type: "err", msg: result.error }); return; }

      const lines = result.data.rows
        .filter((r) => r.estado !== "ADEQUADO" || !considerStock)
        .map(buildProposalLine);

      setLinhas(lines);
      setHasProposal(true);
      setProposalMeta({ numDays: result.data.meta.numDays, stats: result.data.meta.stats });
      setFilterEstado(null);
      setFilterFarmaciaTabela("");

      const { stats } = result.data.meta;
      const parts: string[] = [];
      if (stats.comprar > 0) parts.push(`${stats.comprar} a comprar`);
      if (stats.transferencia > 0) parts.push(`${stats.transferencia} transferências`);
      if (stats.aguardar > 0) parts.push(`${stats.aguardar} aguardar`);
      setFlash({
        type: "info",
        msg: `${lines.length} linhas · ${result.data.meta.numDays} dias${parts.length ? " · " + parts.join(" · ") : ""}`,
      });
    });
  }

  function handlePickManual(p: ProductSearchResult) {
    setLinhas((prev) => {
      const existing = prev.findIndex((l) => l.produtoId === p.id);
      if (existing >= 0)
        return prev.map((l, i) =>
          i !== existing ? l : { ...l, finalQty: String((Number(l.finalQty || "0") || 0) + 1) }
        );
      return [...prev, buildManualLine(p)];
    });
  }

  function updateLine(key: number, patch: Partial<Line>) {
    setLinhas((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function removeLine(key: number) {
    setLinhas((prev) => prev.filter((l) => l.key !== key));
  }

  function handleCriarTransferencia(l: Line) {
    if (!l.farmaciaId || l.excessoFonte.length === 0) return;
    const fonte = l.excessoFonte[0];
    const quantidade = l.transferirQty > 0 ? l.transferirQty : (l.suggestedQty ?? 0);
    if (quantidade <= 0) return;

    startTransfer(async () => {
      const result = await createInternalTransferAction({
        destinoFarmaciaId: l.farmaciaId!,
        sourceFarmaciaNome: fonte.farmaciaNome,
        produtoId: l.produtoId,
        cnp: String(l.cnp),
        designacao: l.designacao,
        quantidade,
        kind: "same-cnp",
        motivo: l.motivo ?? "Proposta de encomenda — excedente disponível no grupo",
      });
      if (result.ok) {
        setFlash({
          type: "ok",
          msg: `Transferência criada (rascunho) para ${l.designacao}. A abrir…`,
        });
        setTimeout(() => router.push(`/encomendas/${result.listaEncomendaId}`), 800);
      } else {
        setFlash({ type: "err", msg: result.error });
      }
    });
  }

  function submit(finalize: boolean) {
    setFlash(null);
    const validLines = linhas.filter((l) => {
      const q = Number(l.finalQty || "0");
      return Number.isFinite(q) && q > 0;
    });
    if (validLines.length === 0) {
      setFlash({ type: "err", msg: "Sem linhas com quantidade > 0." });
      return;
    }

    if (mode === "consolidacao") {
      // Cria uma ListaEncomenda por farmácia
      const byFarmacia = new Map<string, Line[]>();
      for (const l of validLines) {
        const fId = l.farmaciaId ?? "";
        if (!fId) continue;
        if (!byFarmacia.has(fId)) byFarmacia.set(fId, []);
        byFarmacia.get(fId)!.push(l);
      }
      if (byFarmacia.size === 0) {
        setFlash({ type: "err", msg: "Sem farmácias identificadas nas linhas." });
        return;
      }

      startTransition(async () => {
        const results = await Promise.all(
          [...byFarmacia.entries()].map(([fId, fLinhas]) =>
            createOrderAction({
              farmaciaId: fId,
              nome: (nome.trim() || `Grupo ${new Date().toLocaleDateString("pt-PT")}`).slice(0, 180),
              finalize,
              linhas: fLinhas.map((l) => ({
                produtoId: l.produtoId,
                quantidadeSugerida: l.suggestedQty ?? null,
                quantidadeAjustada: Number(l.finalQty),
                notas: l.notas.trim() || null,
              })),
            })
          )
        );
        const errors = results.filter((r) => !r.ok);
        if (errors.length > 0) {
          setFlash({ type: "err", msg: `${errors.length} encomenda(s) falharam.` });
        } else {
          setFlash({ type: "ok", msg: `${byFarmacia.size} encomenda(s) criadas.` });
          setLinhas([]);
          setHasProposal(false);
          setProposalMeta(null);
          setTimeout(() => router.push("/encomendas"), 800);
        }
      });
    } else {
      const input: CreateOrderFormInput = {
        farmaciaId,
        nome: nome.trim() || `Encomenda ${new Date().toLocaleDateString("pt-PT")}`,
        finalize,
        linhas: validLines.map((l) => ({
          produtoId: l.produtoId,
          quantidadeSugerida: l.suggestedQty ?? null,
          quantidadeAjustada: Number(l.finalQty),
          notas: l.notas.trim() || null,
        })),
      };
      startTransition(async () => {
        const result = await createOrderAction(input);
        if (result.ok) {
          setFlash({ type: "ok", msg: finalize ? "Encomenda finalizada." : "Rascunho guardado." });
          setNome(""); setLinhas([]); setHasProposal(false); setProposalMeta(null);
          setTimeout(() => router.push(`/encomendas/${result.listaEncomendaId}`), 800);
        } else {
          setFlash({ type: "err", msg: result.error });
        }
      });
    }
  }

  // ─── Cálculos derivados ───────────────────────────────────────────────────

  const totalFinalVisible = visibleLinhas.reduce((s, l) => s + (Number(l.finalQty || "0") || 0), 0);
  const totalFinalAll = linhas.reduce((s, l) => s + (Number(l.finalQty || "0") || 0), 0);
  const hasTableFilters = !!tableSearch || !!filterEstado || filterRuturas || filterStockBaixo || !!filterFarmaciaTabela;

  const filtersCount =
    selFabricantes.length + selFornecedores.length + selCategorias.length +
    selSubcategorias.length + selUtilizacoes.length + selProductTypes.length;

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Aviso posicionamento */}
      <div
        role="note"
        className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] leading-snug text-amber-900"
      >
        <span className="font-semibold">Assistente operacional.</span>{" "}
        As sugestões baseiam-se em vendas reais. Não contemplam descontos, MOQ, campanhas
        nem prazos — valide condições comerciais antes de finalizar.
      </div>

      {flash && (
        <div
          className={`rounded-xl border px-4 py-3 text-[13px] ${
            flash.type === "ok" ? "border-emerald-200 bg-emerald-50 text-emerald-800"
            : flash.type === "info" ? "border-cyan-200 bg-cyan-50 text-cyan-800"
            : "border-rose-200 bg-rose-50 text-rose-800"
          }`}
        >
          {flash.msg}
        </div>
      )}

      {/* MODO */}
      {canGroupMode && (
        <div className="flex gap-1 rounded-xl border border-slate-200 bg-white p-1">
          {(["farmacia", "grupo", "consolidacao"] as ProposalMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => handleModeChange(m)}
              disabled={generating || busy}
              className={`flex-1 rounded-lg px-3 py-2 text-[13px] font-medium transition-all ${
                mode === m
                  ? "bg-slate-900 text-white shadow-sm"
                  : "text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              }`}
            >
              {m === "farmacia" ? "Farmácia" : m === "grupo" ? "Grupo" : "Consolidação"}
            </button>
          ))}
        </div>
      )}

      {/* CRITÉRIOS */}
      <section className="rounded-xl border border-slate-200 bg-white">
        <div className="border-b border-slate-100 px-4 py-3">
          <h2 className="text-[14px] font-semibold text-slate-900">Critérios</h2>
          <p className="mt-0.5 text-[12px] text-slate-500">
            {mode === "farmacia"
              ? "Proposta para uma farmácia. Produtos retirados são excluídos automaticamente."
              : mode === "grupo"
                ? "Necessidades de todas as farmácias do grupo. Sugere transferências antes de compra."
                : "Vista consolidada por produto para negociação de volume. Cria uma encomenda por farmácia."}
          </p>
        </div>

        <div className="grid gap-4 px-4 py-4 md:grid-cols-3">
          {mode === "farmacia" && (
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
                {farmaciasVisiveis.map((f) => (
                  <option key={f.id} value={f.id}>{f.nome}</option>
                ))}
              </select>
            </div>
          )}
          {isGroupMode && (
            <div>
              <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-slate-500">
                Farmácias
              </label>
              <div className="flex h-[42px] items-center rounded-lg border border-slate-200 bg-slate-50 px-3 text-[13px] text-slate-600">
                Todas as farmácias activas ({farmacias.length})
              </div>
            </div>
          )}
          <div>
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-slate-500">
              Data início
            </label>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
              disabled={busy || generating}
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-[14px] text-slate-800 shadow-sm focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-400 disabled:opacity-50" />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-slate-500">
              Data fim
            </label>
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)}
              disabled={busy || generating}
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-[14px] text-slate-800 shadow-sm focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-400 disabled:opacity-50" />
          </div>

          <div className="md:col-span-2">
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-slate-500">
              Regra de cálculo
            </label>
            <div className="flex flex-wrap gap-3">
              {(["coverage", "total"] as ProposalBaseRule[]).map((r) => (
                <label key={r} className="inline-flex items-center gap-2 text-[13px] text-slate-700">
                  <input type="radio" name="baseRule" checked={baseRule === r}
                    onChange={() => setBaseRule(r)}
                    disabled={busy || generating || (r === "total" && considerStock)} />
                  {r === "coverage" ? "Média diária × cobertura" : "Total de vendas no período"}
                </label>
              ))}
            </div>
          </div>

          <div>
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-slate-500">
              Cobertura alvo (dias)
            </label>
            <input type="number" min="1" value={coverageDays}
              onChange={(e) => setCoverageDays(Math.max(1, Number(e.target.value) || 1))}
              disabled={busy || generating || (baseRule === "total" && !considerStock)}
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-[14px] text-slate-800 shadow-sm focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-400 disabled:opacity-50" />
          </div>
        </div>

        <div className="grid gap-3 border-t border-slate-100 px-4 py-3 md:grid-cols-[auto_1fr_auto] md:items-center">
          <label className="inline-flex items-center gap-2 text-[13px] text-slate-700">
            <input type="checkbox" checked={considerStock}
              onChange={(e) => { setConsiderStock(e.target.checked); if (e.target.checked) setBaseRule("coverage"); }}
              disabled={busy || generating} />
            Considerar stock e pendentes
          </label>
          <button type="button" onClick={() => setFiltersOpen((v) => !v)} disabled={busy || generating}
            className="inline-flex items-center justify-self-start gap-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
            <ChevronDown className={`h-3.5 w-3.5 transition ${filtersOpen ? "rotate-180" : ""}`} />
            Filtros
            {filtersCount > 0 && (
              <span className="ml-1 rounded-full bg-cyan-50 px-2 text-[11px] font-semibold text-cyan-700">
                {filtersCount}
              </span>
            )}
          </button>
          <button type="button" onClick={handleGenerate}
            disabled={busy || generating || (mode === "farmacia" && !farmaciaId)}
            className="inline-flex items-center gap-2 rounded-xl border border-emerald-500 bg-emerald-600 px-5 py-2 text-[13px] font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50">
            {generating ? "A gerar…" : hasProposal ? "Gerar nova proposta" : "Gerar proposta"}
          </button>
        </div>

        {filtersOpen && (
          <div className="grid gap-4 border-t border-slate-100 px-4 py-4 md:grid-cols-2 lg:grid-cols-4">
            <FilterMulti label="Fabricantes" options={filterOptions.fabricantes} selected={selFabricantes} onChange={setSelFabricantes} disabled={busy || generating} />
            <FilterMulti label="Distribuidores" options={filterOptions.distribuidores} selected={selFornecedores} onChange={setSelFornecedores} disabled={busy || generating} />
            <FilterMulti label="Categorias" options={filterOptions.categorias} selected={selCategorias} onChange={setSelCategorias} disabled={busy || generating} />
            <FilterMulti label="Subcategorias" options={subcategoriasVisiveis} selected={selSubcategorias} onChange={setSelSubcategorias} disabled={busy || generating} />
            <FilterMulti
              label="Utilizações"
              options={filterOptions.utilizacoes.map((u) => u.nome)}
              selected={selUtilizacoes.map((s) => nomePorSlug.get(s) ?? s)}
              onChange={(nomes) => setSelUtilizacoes(nomes.map((n) => slugPorNome.get(n) ?? n))}
              disabled={busy || generating}
            />
            <FilterMulti label="Tipos" options={productTypes} selected={selProductTypes} onChange={setSelProductTypes} disabled={busy || generating} />
          </div>
        )}
      </section>

      {/* PAINEL DE RESUMO */}
      {proposalMeta && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {(
            [
              { estado: "COMPRAR" as ProposalEstado, count: proposalMeta.stats.comprar, label: "A comprar", bg: "bg-rose-50 border-rose-200", text: "text-rose-700", dot: "bg-rose-500" },
              { estado: "TRANSFERÊNCIA" as ProposalEstado, count: proposalMeta.stats.transferencia, label: "Transferência", bg: "bg-blue-50 border-blue-200", text: "text-blue-700", dot: "bg-blue-500" },
              { estado: "AGUARDAR" as ProposalEstado, count: proposalMeta.stats.aguardar, label: "Aguardar", bg: "bg-amber-50 border-amber-200", text: "text-amber-700", dot: "bg-amber-500" },
              { estado: "ADEQUADO" as ProposalEstado, count: proposalMeta.stats.adequado, label: "Adequado", bg: "bg-emerald-50 border-emerald-200", text: "text-emerald-700", dot: "bg-emerald-500" },
            ] as const
          ).map(({ estado, count, label, bg, text, dot }) => (
            <button
              key={estado}
              type="button"
              onClick={() => setFilterEstado(filterEstado === estado ? null : estado)}
              className={`rounded-xl border px-4 py-3 text-left transition-all ${bg} ${
                filterEstado === estado ? "ring-2 ring-offset-1 ring-slate-400" : "hover:opacity-80"
              }`}
            >
              <div className="flex items-center gap-2">
                <div className={`h-2 w-2 rounded-full ${dot}`} />
                <span className={`text-[11px] font-medium uppercase tracking-wider ${text}`}>{label}</span>
              </div>
              <div className={`mt-1 text-2xl font-bold ${text}`}>{count}</div>
            </button>
          ))}
        </div>
      )}

      {/* PROPOSTA */}
      {mode !== "consolidacao" && (
        <section className="rounded-xl border border-slate-200 bg-white">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <div>
              <h2 className="text-[14px] font-semibold text-slate-900">Proposta</h2>
              <p className="mt-0.5 text-[12px] text-slate-500">
                {linhas.length === 0
                  ? hasProposal ? "Sem linhas accionáveis."
                    : "Defina os critérios e clique em Gerar proposta."
                  : hasTableFilters
                    ? `${visibleLinhas.length} de ${linhas.length} linhas · total visível: ${totalFinalVisible} · total geral: ${totalFinalAll}${proposalMeta ? ` · ${proposalMeta.numDays}d` : ""}`
                    : `${linhas.length} linha${linhas.length === 1 ? "" : "s"} · total: ${totalFinalAll}${proposalMeta ? ` · ${proposalMeta.numDays}d` : ""}`}
              </p>
            </div>
          </div>

          {linhas.length > 0 && (
            <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 bg-slate-50/50 px-4 py-2.5">
              <input type="text" value={tableSearch} onChange={(e) => setTableSearch(e.target.value)}
                placeholder="Pesquisar produto, CNP, fabricante…"
                className="w-56 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12px] placeholder:text-slate-400 focus:border-cyan-400 focus:outline-none" />
              {isGroupMode && farmaciaOptions.length > 0 && (
                <select value={filterFarmaciaTabela} onChange={(e) => setFilterFarmaciaTabela(e.target.value)}
                  className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12px] text-slate-700 focus:border-cyan-400 focus:outline-none">
                  <option value="">Todas as farmácias</option>
                  {farmaciaOptions.map((f) => <option key={f.id} value={f.nome}>{f.nome}</option>)}
                </select>
              )}
              <label className="inline-flex cursor-pointer items-center gap-1.5 text-[12px] text-slate-700">
                <input type="checkbox" checked={filterRuturas} onChange={(e) => { setFilterRuturas(e.target.checked); if (e.target.checked) setFilterStockBaixo(false); }} className="rounded" />
                Ruturas
              </label>
              <label className="inline-flex cursor-pointer items-center gap-1.5 text-[12px] text-slate-700">
                <input type="checkbox" checked={filterStockBaixo} onChange={(e) => { setFilterStockBaixo(e.target.checked); if (e.target.checked) setFilterRuturas(false); }} className="rounded" />
                Stock baixo
              </label>
              {filterEstado && (
                <span className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${estadoColors(filterEstado)}`}>
                  {estadoLabel(filterEstado)} ×
                </span>
              )}
              {hasTableFilters && (
                <button type="button"
                  onClick={() => { setTableSearch(""); setFilterEstado(null); setFilterRuturas(false); setFilterStockBaixo(false); setFilterFarmaciaTabela(""); }}
                  className="ml-auto text-[11px] text-slate-500 hover:text-slate-700">
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
                    <th className="px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-slate-400">Estado</th>
                    <SortableHeader col="designacao" label="Produto" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
                    {isGroupMode && <SortableHeader col="farmaciaNome" label="Farmácia" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />}
                    <SortableHeader col="salesQty" label="Vendas" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} right />
                    <SortableHeader col="avgDailySales" label="Média/d" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} right />
                    <SortableHeader col="currentStock" label="Stock" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} right />
                    <SortableHeader col="coberturaAtualDias" label="Cobert." sortCol={sortCol} sortDir={sortDir} onSort={handleSort} right />
                    <SortableHeader col="pendingQty" label="Pendente" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} right />
                    <SortableHeader col="suggestedQty" label="Sugerida" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} right />
                    <th className="px-3 py-2 text-right text-[10px] font-medium uppercase tracking-wider text-slate-400">Final</th>
                    <th className="px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-slate-400">Notas / Motivo</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {visibleLinhas.map((l) => {
                    const isRutura = l.currentStock != null && l.currentStock <= 0;
                    const cobBaixo = l.coberturaAtualDias != null && l.coberturaAtualDias > 0 && l.coberturaAtualDias < 7;
                    return (
                      <tr key={l.key} className={`border-b border-slate-50 ${rowBg(l.estado)} ${isRutura ? "!bg-rose-50/50" : ""}`}>
                        <td className="px-3 py-2">
                          {l.estado && (
                            <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold ${estadoColors(l.estado)}`}>
                              {estadoLabel(l.estado)}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 min-w-[200px]">
                          <div className="flex items-baseline gap-1.5">
                            <span className="font-medium text-slate-900">{l.designacao}</span>
                            {l.source === "manual" && <span className="rounded-full border border-amber-200 bg-amber-50 px-1.5 text-[10px] text-amber-700">manual</span>}
                            {l.source === "prefill" && <span className="rounded-full border border-cyan-200 bg-cyan-50 px-1.5 text-[10px] text-cyan-700">sugestão</span>}
                          </div>
                          <div className="mt-0.5 text-[11px] text-slate-500">
                            <span className="font-mono">CNP {l.cnp}</span>
                            {l.fabricante && <><span className="mx-1 text-slate-300">·</span>{l.fabricante}</>}
                          </div>
                        </td>
                        {isGroupMode && <td className="px-3 py-2 text-[11px] text-slate-600">{l.farmaciaNome ?? "—"}</td>}
                        <td className="px-3 py-2 text-right tabular-nums text-slate-700">{fmtNum(l.salesQty)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-slate-700">{fmtNum(l.avgDailySales, 1)}</td>
                        <td className={`px-3 py-2 text-right tabular-nums font-medium ${isRutura ? "text-rose-600" : "text-slate-700"}`}>
                          {fmtNum(l.currentStock)}
                        </td>
                        <td className={`px-3 py-2 text-right tabular-nums ${cobBaixo ? "font-medium text-amber-600" : "text-slate-500"}`}>
                          {l.coberturaAtualDias != null ? `${l.coberturaAtualDias.toFixed(1)}d` : "—"}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-slate-500">{fmtNum(l.pendingQty)}</td>
                        <td className="px-3 py-2 text-right tabular-nums font-semibold text-slate-800">{fmtNum(l.suggestedQty)}</td>
                        <td className="px-3 py-2">
                          <input type="number" min="0" value={l.finalQty}
                            onChange={(e) => updateLine(l.key, { finalQty: e.target.value })}
                            disabled={busy}
                            className="w-20 rounded-lg border border-slate-200 px-2 py-1 text-right text-[13px] focus:border-cyan-400 focus:outline-none disabled:opacity-50" />
                        </td>
                        <td className="px-3 py-2 min-w-[220px]">
                          {l.estado === "TRANSFERÊNCIA" && l.excessoFonte.length > 0 ? (
                            <div className="space-y-1">
                              <p className="text-[11px] text-blue-700">{l.motivo}</p>
                              <button type="button"
                                onClick={() => handleCriarTransferencia(l)}
                                disabled={creatingTransfer || busy}
                                className="inline-flex items-center gap-1 rounded-lg border border-blue-300 bg-blue-50 px-2 py-1 text-[11px] font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-50">
                                <ArrowLeftRight className="h-3 w-3" />
                                Criar transferência
                              </button>
                            </div>
                          ) : l.motivo ? (
                            <p className="text-[11px] text-slate-500">{l.motivo}</p>
                          ) : (
                            <input type="text" value={l.notas}
                              onChange={(e) => updateLine(l.key, { notas: e.target.value })}
                              placeholder="notas"
                              disabled={busy}
                              className="w-full rounded-lg border border-slate-200 px-2 py-1 text-[12px] placeholder:text-slate-300 focus:border-cyan-400 focus:outline-none disabled:opacity-50" />
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <button type="button" onClick={() => removeLine(l.key)} disabled={busy}
                            className="rounded-md border border-slate-200 p-1.5 text-slate-500 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-700 disabled:opacity-50">
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
      )}

      {/* VISTA CONSOLIDAÇÃO */}
      {mode === "consolidacao" && (
        <section className="rounded-xl border border-slate-200 bg-white">
          <div className="border-b border-slate-100 px-4 py-3">
            <h2 className="text-[14px] font-semibold text-slate-900">Vista consolidada</h2>
            <p className="mt-0.5 text-[12px] text-slate-500">
              Agrupado por produto. Ajuste as quantidades finais por farmácia antes de criar as encomendas.
              {consolidadoRows.length > 0 && ` ${consolidadoRows.length} produtos · total: ${totalFinalAll} und`}
            </p>
          </div>

          {consolidadoRows.length === 0 ? (
            <div className="px-4 py-10 text-center text-[12px] text-slate-400">
              {generating ? "A calcular…" : "Gere uma proposta para ver a vista consolidada."}
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {consolidadoRows.map((g) => (
                <div key={g.produtoId} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold ${estadoColors(g.estadoPriority)}`}>
                          {estadoLabel(g.estadoPriority)}
                        </span>
                        <span className="font-medium text-slate-900">{g.designacao}</span>
                        <span className="font-mono text-[11px] text-slate-500">CNP {g.cnp}</span>
                        {g.fabricante && <span className="text-[11px] text-slate-500">{g.fabricante}</span>}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {g.farmaciaLinhas.map((l) => (
                          <div key={l.key} className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5">
                            <span className="text-[11px] font-medium text-slate-700">{l.farmaciaNome ?? "—"}</span>
                            <span className="text-[11px] text-slate-400">suger. {fmtNum(l.suggestedQty)}</span>
                            <input type="number" min="0" value={l.finalQty}
                              onChange={(e) => updateLine(l.key, { finalQty: e.target.value })}
                              disabled={busy}
                              className="w-16 rounded border border-slate-300 bg-white px-1.5 py-0.5 text-right text-[12px] focus:border-cyan-400 focus:outline-none disabled:opacity-50" />
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-[11px] text-slate-500">Total</div>
                      <div className="text-lg font-bold text-slate-900">{g.totalFinalQty}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* PICKER MANUAL */}
      {mode === "farmacia" && (
        <section className="rounded-xl border border-slate-200 bg-white">
          <button type="button" onClick={() => setManualOpen((v) => !v)}
            className="flex w-full items-center justify-between border-b border-slate-100 px-4 py-3 text-left">
            <div>
              <h2 className="text-[14px] font-semibold text-slate-900">Adicionar produto manual</h2>
              <p className="mt-0.5 text-[12px] text-slate-500">Para produtos sem vendas no período ou fora dos filtros.</p>
            </div>
            <Plus className={`h-4 w-4 text-slate-400 transition ${manualOpen ? "rotate-45" : ""}`} />
          </button>
          {manualOpen && (
            <div className="p-4">
              <ProductPicker farmaciaId={farmaciaId} disabled={busy || generating} onPick={handlePickManual} />
            </div>
          )}
        </section>
      )}

      {/* GUARDAR / FINALIZAR */}
      <section className="rounded-xl border border-slate-200 bg-white px-4 py-4">
        <div className="grid gap-4 md:grid-cols-[1fr_auto_auto] md:items-end">
          <div>
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-slate-500">
              {mode === "consolidacao" ? "Prefixo do nome (aplicado a cada encomenda)" : "Nome da encomenda"}
            </label>
            <input type="text" value={nome} onChange={(e) => setNome(e.target.value)}
              placeholder={mode === "consolidacao"
                ? `Grupo ${new Date().toLocaleDateString("pt-PT")}`
                : `Encomenda ${new Date().toLocaleDateString("pt-PT")}`}
              disabled={busy}
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-[14px] text-slate-800 shadow-sm placeholder:text-slate-400 focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-400 disabled:opacity-50" />
            {mode === "consolidacao" && linhas.length > 0 && (
              <p className="mt-1 text-[11px] text-slate-500">
                Vai criar {new Set(linhas.map((l) => l.farmaciaId).filter(Boolean)).size} encomenda(s) — uma por farmácia.
              </p>
            )}
          </div>
          <button type="button" onClick={() => submit(false)}
            disabled={busy || linhas.length === 0}
            className="rounded-xl border border-slate-300 bg-white px-5 py-2.5 text-[13px] font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50">
            {busy ? "A guardar..." : "Guardar rascunho"}
          </button>
          <button type="button" onClick={() => submit(true)}
            disabled={busy || linhas.length === 0}
            className="rounded-xl border border-cyan-500 bg-cyan-600 px-5 py-2.5 text-[13px] font-medium text-white shadow-sm hover:bg-cyan-700 disabled:opacity-50">
            {busy ? "A finalizar..." : mode === "consolidacao" ? "Criar encomendas" : "Finalizar e enviar para fila"}
          </button>
        </div>
      </section>
    </div>
  );
}

// ─── SortableHeader ───────────────────────────────────────────────────────────

function SortableHeader({ col, label, sortCol, sortDir, onSort, right = false }: {
  col: SortCol; label: string; sortCol: SortCol;
  sortDir: "asc" | "desc"; onSort: (c: SortCol) => void; right?: boolean;
}) {
  const active = sortCol === col;
  return (
    <th className={`px-3 py-2 ${right ? "text-right" : ""}`}>
      <button type="button" onClick={() => onSort(col)}
        className={`inline-flex items-center gap-0.5 text-[10px] font-medium uppercase tracking-wider transition-colors ${
          active ? "text-cyan-600" : "text-slate-400 hover:text-slate-600"
        }`}>
        {label}
        {active ? (
          sortDir === "asc" ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
        ) : <ChevronsUpDown className="h-3 w-3 opacity-40" />}
      </button>
    </th>
  );
}

// ─── FilterMulti ─────────────────────────────────────────────────────────────

function FilterMulti({ label, options, selected, onChange, disabled }: {
  label: string; options: string[]; selected: string[];
  onChange: (next: string[]) => void; disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((o) => o.toLowerCase().includes(q)) : options;
  }, [options, query]);

  function toggle(value: string) {
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  }

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <label className="text-[11px] font-medium uppercase tracking-wider text-slate-500">{label}</label>
        {selected.length > 0 && (
          <button type="button" onClick={() => onChange([])} disabled={disabled}
            className="text-[11px] text-slate-500 hover:text-slate-700">Limpar</button>
        )}
      </div>
      <input type="text" value={query} onChange={(e) => setQuery(e.target.value)}
        placeholder={`Procurar… (${options.length})`} disabled={disabled}
        className="mb-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[12px] placeholder:text-slate-400 focus:border-cyan-400 focus:outline-none disabled:opacity-50" />
      <div className="max-h-44 overflow-y-auto rounded-lg border border-slate-200 bg-white">
        {filtered.length === 0 ? (
          <div className="px-2 py-2 text-[11px] text-slate-400">Sem resultados.</div>
        ) : (
          <ul>
            {filtered.map((o) => (
              <li key={o}>
                <label className="flex cursor-pointer items-center gap-2 px-2 py-1 text-[12px] hover:bg-slate-50">
                  <input type="checkbox" checked={selected.includes(o)} onChange={() => toggle(o)} disabled={disabled} />
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
