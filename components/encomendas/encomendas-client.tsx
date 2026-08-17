"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  Filter,
  RefreshCw,
  Search,
  ShoppingCart,
  X,
} from "lucide-react";
import { AppShell } from "@/components/layout/app-shell";
import { ReportActions } from "@/components/reporting/report-actions";
import { buildEncomendasReport } from "@/lib/reporting/adapters/encomendas";
import { useTransition } from "react";
import { formatFarmaciaHeader, type FarmaciaInfo } from "@/lib/farmacias-header";
import type { EncomendaBaseRow } from "@/lib/encomendas-data";
import { CreateInternalTransferButton } from "@/components/transferencias/create-internal-transfer-button";
import type { ReportingFilterOptions } from "@/lib/reporting-filter-options";
import { runEncomendasReport } from "@/app/encomendas/actions";
import { passaFiltroCatalogo } from "@/lib/reporting/filters-shared";

type Prioridade = "Crítica" | "Elevada" | "Normal" | "Estável";

type MonthlyMovement = {
  mes: string;
  compras: number;
  vendas: number;
};

type PurchaseHistory = {
  data: string;
  fornecedor: string;
  quantidade: number;
  precoCusto: number;
};

type SupplierCondition = {
  fornecedor: string;
  campanha: string;
  desconto: string;
  bonus: string;
};

type EncomendaFarmaciaRow = {
  produtoId?: string;
  farmaciaId?: string;
  cnp: string;
  produto: string;
  farmacia: string;
  stockAtual: number;
  coberturaAtual: number;
  rotacaoMedia: number;
  sugestao: number;
  fornecedor: string;
  fabricante: string;
  categoria: string;
  dci?: string | null;
  codigoATC?: string | null;
  valorEstimado: number;
  prioridade: Prioridade;
  movimentos6M: MonthlyMovement[];
  condicoesFornecedor: SupplierCondition[];
  ultimasCompras: PurchaseHistory[];
  // Substituição interna same-CNP (recomendação, não bloqueio).
  // Carregada do server; mostrada apenas quando há sugestão a ordenar.
  internalSubstitutionAvailable: boolean;
  substitutionSourceFarmacia?: string;
  substitutionSourceFarmaciaId?: string;
  substitutionQtySuggested?: number;
  substitutionAvoidedPurchaseValue?: number;
  substitutionCoverageOrigin?: number;
  substitutionCoverageDestination?: number;
  // Substituição DCI-equivalente — RECOMENDAÇÃO CAUTELAR. Aparece
  // apenas quando NÃO há alternativa same-CNP para a mesma linha
  // (same-CNP tem prioridade). UI mostra com tom distinto e exige
  // validação humana.
  dciEquivalentAvailable: boolean;
  dciEquivalentCnp?: string;
  dciEquivalentProductName?: string;
  dciEquivalentSourceFarmacia?: string;
  dciEquivalentSourceFarmaciaId?: string;
  dciEquivalentSourceProdutoId?: string;
  dciEquivalentQtySuggested?: number;
  dciEquivalentAvoidedPurchaseValue?: number;
  dciEquivalentReason?: string;
};

type GroupEncomendaRow = {
  cnp: string;
  produto: string;
  fornecedor: string;
  fabricante: string;
  categoria: string;
  dci: string | null;
  codigoATC: string | null;
  stockGrupo: number;
  sugestaoGrupo: number;
  encomendarGrupo: number;
  valorEstimado: number;
  prioridade: Prioridade;
  porFarmacia: Array<{
    farmacia: string;
    stockAtual: number;
    coberturaAtual: number;
    rotacaoMedia: number;
    sugestao: number;
    prioridade: Prioridade;
    movimentos6M: MonthlyMovement[];
    ultimasCompras: PurchaseHistory[];
    // IDs internos — necessários ao CTA de transferência interna.
    produtoId?: string;
    farmaciaId?: string;
    // Substituição interna por farmácia (badge na linha por-farmácia).
    internalSubstitutionAvailable: boolean;
    substitutionSourceFarmacia?: string;
    substitutionSourceFarmaciaId?: string;
    substitutionQtySuggested?: number;
    substitutionAvoidedPurchaseValue?: number;
    // DCI-equivalente per-farmácia. Populado apenas quando same-CNP
    // não está disponível para essa farmácia.
    dciEquivalentAvailable: boolean;
    dciEquivalentCnp?: string;
    dciEquivalentProductName?: string;
    dciEquivalentSourceFarmacia?: string;
    dciEquivalentSourceFarmaciaId?: string;
    dciEquivalentSourceProdutoId?: string;
    dciEquivalentQtySuggested?: number;
    dciEquivalentAvoidedPurchaseValue?: number;
    dciEquivalentReason?: string;
  }>;
  condicoesFornecedor: SupplierCondition[];
  // Agregado ao nível do grupo: existe transferência interna possível
  // em pelo menos uma das farmácias e quantos € evitáveis no total.
  hasInternalSubstitution: boolean;
  substitutionAvoidedTotal: number;
  substitutionQtyTotal: number;
  // DCI-equivalente agregado (sempre mutuamente exclusivo com same-CNP
  // para a mesma farmácia, mas o grupo pode ter ambos em farmácias
  // diferentes).
  hasDciEquivalent: boolean;
  dciEquivalentAvoidedTotal: number;
  dciEquivalentQtyTotal: number;
};

// O shape das linhas reais vem de EncomendaBaseRow. Mantemos o nome
// BaseRow localmente por compatibilidade com o resto da componente.
type BaseRow = EncomendaBaseRow;

function calcularSugestao(stockAtual: number, rotacaoMedia: number, coberturaAlvoDias: number) {
  const stockAlvo = rotacaoMedia * coberturaAlvoDias;
  return Math.max(0, Math.ceil(stockAlvo - stockAtual));
}

function calcularPrioridade(coberturaAtual: number, sugestao: number): Prioridade {
  if (sugestao <= 0) return "Estável";
  if (coberturaAtual <= 2) return "Crítica";
  if (coberturaAtual <= 5) return "Elevada";
  return "Normal";
}

function getPriorityClasses(prioridade: Prioridade) {
  switch (prioridade) {
    case "Crítica":
      return "border-red-200 bg-red-50 text-red-700";
    case "Elevada":
      return "border-amber-200 bg-amber-50 text-amber-700";
    case "Normal":
      return "border-sky-200 bg-sky-50 text-sky-700";
    case "Estável":
      return "border-slate-200 bg-slate-50 text-slate-600";
  }
}
function toggleValue(
  value: string,
  selected: string[],
  setSelected: React.Dispatch<React.SetStateAction<string[]>>
) {
  setSelected((prev) =>
    prev.includes(value)
      ? prev.filter((item) => item !== value)
      : [...prev, value]
  );
}
type Props = {
  farmaciasInfo: FarmaciaInfo[];
  filterOptions: ReportingFilterOptions;
};

export function EncomendasClient({ farmaciasInfo, filterOptions }: Props) {
  const router = useRouter();
  // Lazy: nada de Encomendas é carregado até clicar em "Gerar".
  const [rows, setRows] = useState<BaseRow[]>([]);
  const [hasGenerated, setHasGenerated] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [generationError, setGenerationError] = useState<string | null>(null);
  const initialRows = rows;

  const handleGerar = () => {
    setGenerationError(null);
    startTransition(async () => {
      try {
        const result = await runEncomendasReport();
        setRows(result);
        setHasGenerated(true);
      } catch (err) {
        setGenerationError(err instanceof Error ? err.message : String(err));
        setRows([]);
      }
    });
  };

  // Universo de farmácias vem do server-side leve.
  const farmaciasUniverse = Array.from(
    new Set(farmaciasInfo.map((f) => f.nome))
  ).sort((a, b) => a.localeCompare(b, "pt-PT"));

  // Lookup nome→id para CTAs de transferência interna.
  const farmaciaIdByNome = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of farmaciasInfo) m.set(f.nome, f.id);
    return m;
  }, [farmaciasInfo]);

  const [farmaciasSelecionadas, setFarmaciasSelecionadas] = useState<string[]>(
    farmaciasUniverse
  );
  const [fornecedoresSelecionados, setFornecedoresSelecionados] = useState<string[]>([]);
  const [fabricantesSelecionados, setFabricantesSelecionados] = useState<string[]>([]);
  const [categoriasSelecionadas, setCategoriasSelecionadas] = useState<string[]>([]);
  const [subcategoriasSelecionadas, setSubcategoriasSelecionadas] = useState<string[]>([]);
  const [utilizacoesSelecionadas, setUtilizacoesSelecionadas] = useState<string[]>([]);
  const [periodoAnalise, setPeriodoAnalise] = useState<7 | 15 | 30 | 60 | 90>(30);
  const [coberturaAlvoDias, setCoberturaAlvoDias] = useState(15);
  const [apenasComSugestao, setApenasComSugestao] = useState(true);
  const [apenasCriticos, setApenasCriticos] = useState(false);
  const [editableGroupRows, setEditableGroupRows] = useState<Record<string, number>>({});
  const [filtrosAbertos, setFiltrosAbertos] = useState(false);
  const [activeRowIndex, setActiveRowIndex] = useState(0);

  const inputRefs = useRef<Array<HTMLInputElement | null>>([]);

  // Universo de filtros — tudo eager, vindo do servidor no page open.
  const farmacias = farmaciasUniverse;
  const fornecedores = filterOptions.fornecedores;
  const fabricantes = filterOptions.fabricantes;
  const categorias = filterOptions.categorias;
  // Subcategorias acompanham a categoria escolhida.
  const subcategorias = (
    categoriasSelecionadas.length > 0
      ? filterOptions.subcategorias.filter((s) => categoriasSelecionadas.includes(s.categoria))
      : filterOptions.subcategorias
  ).map((s) => s.nome);
  const nomePorSlug = new Map(filterOptions.utilizacoes.map((u) => [u.slug, u.nome]));
  const slugPorNome = new Map(filterOptions.utilizacoes.map((u) => [u.nome, u.slug]));

  // A rotacaoMedia vem já calculada pelo server (lib/operational/metrics-shared)
  // a partir de VendaMensal × 90d. O selector "Período" controla apenas a
  // cobertura-alvo lida (via coberturaAlvoDias) e a UX de leitura — NÃO
  // reescreve o número server. O factor mágico ×1.08/×1.04/×1/×0.96/×0.93
  // que existia aqui foi removido em Fase 1 WS-A: deformava o output
  // server (até 8% acima ou 7% abaixo) sem base estatística e fazia com
  // que o número visível ao utilizador não correspondesse ao que estava
  // na BD.
  const rowsCalculadas = useMemo<EncomendaFarmaciaRow[]>(() => {
    return initialRows.map((item) => {
      const sugestao = calcularSugestao(item.stockAtual, item.rotacaoMedia, coberturaAlvoDias);
      const prioridade = calcularPrioridade(item.coberturaAtual, sugestao);
      const valorEstimado = Number((sugestao * (4.5 + item.rotacaoMedia * 1.8)).toFixed(2));

      return {
        ...item,
        sugestao,
        prioridade,
        valorEstimado,
      };
    });
  }, [initialRows, coberturaAlvoDias]);

  const groupRows = useMemo<GroupEncomendaRow[]>(() => {
    const filtered = rowsCalculadas.filter((row) => {
      if (farmaciasSelecionadas.length > 0 && !farmaciasSelecionadas.includes(row.farmacia)) return false;
      if (fornecedoresSelecionados.length > 0 && !fornecedoresSelecionados.includes(row.fornecedor)) return false;
      if (fabricantesSelecionados.length > 0 && !fabricantesSelecionados.includes(row.fabricante)) return false;
      if (
        !passaFiltroCatalogo(row, {
          categorias: categoriasSelecionadas,
          subcategorias: subcategoriasSelecionadas,
          utilizacoes: utilizacoesSelecionadas,
        })
      ) return false;
      return true;
    });

    const grouped = new Map<string, EncomendaFarmaciaRow[]>();

    for (const row of filtered) {
      const key = row.cnp;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(row);
    }

   const result = Array.from(grouped.values()).map((rows): GroupEncomendaRow => {
  const first = rows[0]!;
  const stockGrupo = rows.reduce((sum, r) => sum + r.stockAtual, 0);
  const sugestaoGrupo = rows.reduce((sum, r) => sum + r.sugestao, 0);
  const valorEstimado = Number(
    rows.reduce((sum, r) => sum + r.valorEstimado, 0).toFixed(2)
  );

  const prioridade = (
    rows.some((r) => r.prioridade === "Crítica")
      ? "Crítica"
      : rows.some((r) => r.prioridade === "Elevada")
        ? "Elevada"
        : sugestaoGrupo > 0
          ? "Normal"
          : "Estável"
  ) as Prioridade;

  // Agregado de substituição — só conta linhas em que o destino TEM
  // sugestão a encomendar (caso contrário a transferência não evita
  // compra que não existe).
  const rowsComSubstituicao = rows.filter(
    (r) => r.internalSubstitutionAvailable && r.sugestao > 0,
  );
  const hasInternalSubstitution = rowsComSubstituicao.length > 0;
  const substitutionAvoidedTotal = Number(
    rowsComSubstituicao
      .reduce((s, r) => s + (r.substitutionAvoidedPurchaseValue ?? 0), 0)
      .toFixed(2),
  );
  const substitutionQtyTotal = rowsComSubstituicao.reduce(
    (s, r) => s + (r.substitutionQtySuggested ?? 0),
    0,
  );

  // DCI-equivalente — mutuamente exclusivo com same-CNP por linha
  // (server-side garante), portanto não há sobreposição a desfazer.
  const rowsComDci = rows.filter(
    (r) => r.dciEquivalentAvailable && r.sugestao > 0,
  );
  const hasDciEquivalent = rowsComDci.length > 0;
  const dciEquivalentAvoidedTotal = Number(
    rowsComDci
      .reduce((s, r) => s + (r.dciEquivalentAvoidedPurchaseValue ?? 0), 0)
      .toFixed(2),
  );
  const dciEquivalentQtyTotal = rowsComDci.reduce(
    (s, r) => s + (r.dciEquivalentQtySuggested ?? 0),
    0,
  );

  return {
    cnp: first.cnp,
    produto: first.produto,
    fornecedor: first.fornecedor,
    fabricante: first.fabricante,
    categoria: first.categoria,
    dci: first.dci ?? null,
    codigoATC: first.codigoATC ?? null,
    stockGrupo,
    sugestaoGrupo,
    encomendarGrupo: sugestaoGrupo,
    valorEstimado,
    prioridade,
    porFarmacia: rows
      .sort((a, b) => a.farmacia.localeCompare(b.farmacia))
      .map((r) => ({
        produtoId: r.produtoId,
        farmaciaId: r.farmaciaId,
        farmacia: r.farmacia,
        stockAtual: r.stockAtual,
        coberturaAtual: r.coberturaAtual,
        rotacaoMedia: r.rotacaoMedia,
        sugestao: r.sugestao,
        prioridade: r.prioridade as Prioridade,
        movimentos6M: r.movimentos6M,
        ultimasCompras: r.ultimasCompras,
        internalSubstitutionAvailable: r.internalSubstitutionAvailable,
        substitutionSourceFarmacia: r.substitutionSourceFarmacia,
        substitutionSourceFarmaciaId: r.substitutionSourceFarmaciaId,
        substitutionQtySuggested: r.substitutionQtySuggested,
        substitutionAvoidedPurchaseValue: r.substitutionAvoidedPurchaseValue,
        dciEquivalentAvailable: r.dciEquivalentAvailable,
        dciEquivalentCnp: r.dciEquivalentCnp,
        dciEquivalentProductName: r.dciEquivalentProductName,
        dciEquivalentSourceFarmacia: r.dciEquivalentSourceFarmacia,
        dciEquivalentSourceFarmaciaId: r.dciEquivalentSourceFarmaciaId,
        dciEquivalentSourceProdutoId: r.dciEquivalentSourceProdutoId,
        dciEquivalentQtySuggested: r.dciEquivalentQtySuggested,
        dciEquivalentAvoidedPurchaseValue: r.dciEquivalentAvoidedPurchaseValue,
        dciEquivalentReason: r.dciEquivalentReason,
      })),
    condicoesFornecedor: first.condicoesFornecedor,
    hasInternalSubstitution,
    substitutionAvoidedTotal,
    substitutionQtyTotal,
    hasDciEquivalent,
    dciEquivalentAvoidedTotal,
    dciEquivalentQtyTotal,
  };
});

    return result.filter((row) => {
      if (apenasComSugestao && row.sugestaoGrupo <= 0) return false;
      if (apenasCriticos && row.prioridade !== "Crítica") return false;
      return true;
    });
  }, [
    rowsCalculadas,
    farmaciasSelecionadas,
    fornecedoresSelecionados,
    fabricantesSelecionados,
    categoriasSelecionadas,
    apenasComSugestao,
    apenasCriticos,
  ]);

  const currentActiveIndex =
    groupRows.length === 0 ? -1 : Math.min(activeRowIndex, groupRows.length - 1);

  const activeRow = currentActiveIndex >= 0 ? groupRows[currentActiveIndex] : null;
  const farmaciaMaiorNecessidade = activeRow
    ? [...activeRow.porFarmacia].sort((a, b) => b.sugestao - a.sugestao)[0] ?? null
    : null;

  useEffect(() => {
    if (groupRows.length === 0) return;
    if (activeRowIndex > groupRows.length - 1) {
      setActiveRowIndex(groupRows.length - 1);
    }
  }, [groupRows.length, activeRowIndex]);

  const encomendarGrupoValue = (row: GroupEncomendaRow) =>
    editableGroupRows[row.cnp] ?? row.encomendarGrupo;

  const handleChangeEncomendarGrupo = (cnp: string, value: string) => {
    const parsed = Number(value);
    setEditableGroupRows((prev) => ({
      ...prev,
      [cnp]: Number.isNaN(parsed) ? 0 : Math.max(0, parsed),
    }));
  };

  const handleRowKeyNavigation = (
    event: React.KeyboardEvent<HTMLInputElement>,
    rowIndex: number
  ) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const nextIndex = Math.min(rowIndex + 1, groupRows.length - 1);
      setActiveRowIndex(nextIndex);
      inputRefs.current[nextIndex]?.focus();
      inputRefs.current[nextIndex]?.select();
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      const prevIndex = Math.max(rowIndex - 1, 0);
      setActiveRowIndex(prevIndex);
      inputRefs.current[prevIndex]?.focus();
      inputRefs.current[prevIndex]?.select();
    }
  };

  const resumo = useMemo(() => {
    const artigos = groupRows.length;
    const criticos = groupRows.filter((r) => r.prioridade === "Crítica").length;
    const valor = groupRows.reduce((sum, row) => {
      const qtd = encomendarGrupoValue(row);
      const valorUnitario = row.sugestaoGrupo > 0 ? row.valorEstimado / row.sugestaoGrupo : 0;
      return sum + qtd * valorUnitario;
    }, 0);
    // KPI agregado: artigos onde existe alternativa interna (same-CNP)
    // e valor de compra evitável estimado.
    const comSubstituicao = groupRows.filter(
      (r) => r.hasInternalSubstitution && r.sugestaoGrupo > 0,
    ).length;
    const valorEvitavel = groupRows.reduce(
      (s, r) => (r.sugestaoGrupo > 0 ? s + r.substitutionAvoidedTotal : s),
      0,
    );
    // DCI-equivalente (cautelar) — contabilizado em separado.
    const comDciEquivalente = groupRows.filter(
      (r) => r.hasDciEquivalent && r.sugestaoGrupo > 0,
    ).length;
    const valorEvitavelDci = groupRows.reduce(
      (s, r) => (r.sugestaoGrupo > 0 ? s + r.dciEquivalentAvoidedTotal : s),
      0,
    );

    return { artigos, criticos, valor, comSubstituicao, valorEvitavel, comDciEquivalente, valorEvitavelDci };
  }, [groupRows, editableGroupRows]);

  const filtrosAtivosCount =
    farmaciasSelecionadas.length +
    fornecedoresSelecionados.length +
    fabricantesSelecionados.length +
    categoriasSelecionadas.length;

  return (
    <AppShell>
      <div className="space-y-3">
        <section className="space-y-0.5">
          <div className="text-xs font-medium text-slate-500">Decisão / Encomendas</div>
          <h1 className="text-[28px] font-semibold tracking-tight text-slate-900">
            Encomendas
          </h1>
          <p className="text-[13px] text-slate-600">
            Proposta de grupo com necessidade discriminada por farmácia.
          </p>
        </section>

        {/*
         * Aviso permanente de posicionamento (fecho 2026-06): este módulo
         * é um assistente operacional, não um motor de decisão automática.
         * Quantidades sugeridas são orientativas e ignoram condições
         * comerciais (descontos, MOQ, campanhas, prazos). A decisão final
         * é sempre humana — ver header de lib/encomendas-data.ts.
         */}
        <section
          role="note"
          aria-label="Aviso sobre as sugestões de encomenda"
          className="rounded-[14px] border border-amber-200 bg-amber-50/80 px-4 py-2.5 text-[12px] leading-snug text-amber-900 shadow-[0_2px_8px_rgba(252,211,77,0.10)]"
        >
          <span className="font-semibold">Assistente operacional.</span>{" "}
          As quantidades sugeridas baseiam-se em cobertura e rotação. Não
          contemplam descontos, MOQ, campanhas nem prazos do fornecedor —
          valide condições comerciais antes de finalizar a encomenda.
        </section>

        <section className="rounded-[20px] border border-white/70 bg-white/84 px-4 py-3 shadow-[0_8px_18px_rgba(15,23,42,0.04)] backdrop-blur-xl">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
            <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-[0.95fr_0.95fr_auto]">
              <CompactSelect
                label="Período"
                value={String(periodoAnalise)}
                onChange={(value) => setPeriodoAnalise(Number(value) as 7 | 15 | 30 | 60 | 90)}
                options={["7", "15", "30", "60", "90"]}
                suffix=" dias"
              />
              <CompactInput
                label="Cobertura"
                value={coberturaAlvoDias}
                onChange={(value) => setCoberturaAlvoDias(Math.max(1, Number(value) || 1))}
                suffix="dias"
              />

              <div className="flex items-end">
                <button
                  type="button"
                  onClick={() => setFiltrosAbertos((prev) => !prev)}
                  className={[
                    "inline-flex h-9 items-center gap-2 rounded-xl border px-3 text-[13px] font-medium transition",
                    filtrosAbertos
                      ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                      : "border-slate-200 bg-white text-slate-700 hover:border-slate-300",
                  ].join(" ")}
                >
                  <Filter className="h-3.5 w-3.5" />
                  Filtros
                  <span className="inline-flex min-w-[18px] items-center justify-center rounded-full bg-slate-100 px-1.5 py-0.5 text-[11px] font-semibold text-slate-600">
                    {filtrosAtivosCount}
                  </span>
                  <ChevronDown
                    className={[
                      "h-3.5 w-3.5 transition",
                      filtrosAbertos ? "rotate-180" : "",
                    ].join(" ")}
                  />
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleGerar}
                disabled={isPending}
                className="inline-flex h-9 items-center gap-2 rounded-xl border border-emerald-300 bg-emerald-50 px-4 text-[13px] font-semibold text-emerald-700 transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isPending ? "A gerar…" : hasGenerated ? "Atualizar" : "Gerar"}
              </button>
              <ActionButton icon={<RefreshCw className="h-3.5 w-3.5" />} label="Atualizar" />
              <ReportActions
                hide={!hasGenerated ? { print: true, pdf: true, excel: true, email: true } : undefined}
                report={() =>
                  buildEncomendasReport({
                    rows: groupRows.map((g) => ({
                      cnp: g.cnp,
                      produto: g.produto,
                      fornecedor: g.fornecedor,
                      fabricante: g.fabricante,
                      categoria: g.categoria,
                      stockGrupo: g.stockGrupo,
                      sugestaoGrupo: g.sugestaoGrupo,
                      encomendarGrupo:
                        editableGroupRows[g.cnp] ?? g.encomendarGrupo,
                      valorEstimado: g.valorEstimado,
                      prioridade: g.prioridade,
                    })),
                    filters: {
                      farmaciasSelecionadas,
                      fornecedoresSelecionados,
                      fabricantesSelecionados,
                      categoriasSelecionadas,
                      periodoAnalise,
                      coberturaAlvoDias,
                      apenasComSugestao,
                      apenasCriticos,
                    },
                    universe: { farmacias, fornecedores, fabricantes, categorias },
                    organization: formatFarmaciaHeader(farmaciasSelecionadas, farmaciasInfo),
                  })
                }
              />
              {(() => {
                const farmaciaUnica =
                  farmaciasSelecionadas.length === 1 ? farmaciasSelecionadas[0]! : null;
                const linhasParaEncomenda = farmaciaUnica
                  ? groupRows
                      .map((g) => {
                        const qty = encomendarGrupoValue(g);
                        return qty > 0
                          ? { cnp: Number(g.cnp), quantidade: qty }
                          : null;
                      })
                      .filter((x): x is { cnp: number; quantidade: number } =>
                        x !== null && Number.isFinite(x.cnp)
                      )
                  : [];
                const podeCriar =
                  hasGenerated && farmaciaUnica !== null && linhasParaEncomenda.length > 0;
                const motivoBloqueio = !hasGenerated
                  ? "Gere o relatório primeiro."
                  : !farmaciaUnica
                    ? "Filtre para uma única farmácia para criar uma encomenda."
                    : linhasParaEncomenda.length === 0
                      ? "Sem linhas com quantidade a encomendar."
                      : "";
                return (
                  <button
                    type="button"
                    disabled={!podeCriar}
                    title={podeCriar ? "Criar encomenda com as linhas seleccionadas" : motivoBloqueio}
                    onClick={() => {
                      if (!podeCriar || !farmaciaUnica) return;
                      try {
                        window.sessionStorage.setItem(
                          "encomenda-prefill",
                          JSON.stringify({
                            farmaciaNome: farmaciaUnica,
                            lines: linhasParaEncomenda,
                          })
                        );
                      } catch {
                        /* sessionStorage indisponível — segue na mesma; o prefill não vai aparecer */
                      }
                      router.push("/encomendas/nova?prefill=1");
                    }}
                    className="inline-flex h-9 items-center gap-2 rounded-xl border border-cyan-500 bg-cyan-600 px-4 text-[13px] font-semibold text-white shadow-sm transition hover:bg-cyan-700 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <ShoppingCart className="h-3.5 w-3.5" />
                    Criar encomenda
                  </button>
                );
              })()}
            </div>
          </div>

          {filtrosAbertos && (
            <div className="mt-3 rounded-2xl border border-slate-200 bg-white p-3">
              <div className="grid gap-3 xl:grid-cols-4">
                <SearchableMultiSelect
                  label="Farmácias"
                  options={farmacias}
                  selected={farmaciasSelecionadas}
                  onToggle={(value) =>
                    toggleValue(value, farmaciasSelecionadas, setFarmaciasSelecionadas)
                  }
                />
                <SearchableMultiSelect
                  label="Distribuidores"
                  options={fornecedores}
                  selected={fornecedoresSelecionados}
                  onToggle={(value) =>
                    toggleValue(value, fornecedoresSelecionados, setFornecedoresSelecionados)
                  }
                />
                <SearchableMultiSelect
                  label="Fabricantes"
                  options={fabricantes}
                  selected={fabricantesSelecionados}
                  onToggle={(value) =>
                    toggleValue(value, fabricantesSelecionados, setFabricantesSelecionados)
                  }
                />
                <SearchableMultiSelect
                  label="Categorias"
                  options={categorias}
                  selected={categoriasSelecionadas}
                  onToggle={(value) =>
                    toggleValue(value, categoriasSelecionadas, setCategoriasSelecionadas)
                  }
                />
                <SearchableMultiSelect
                  label="Subcategorias"
                  options={subcategorias}
                  selected={subcategoriasSelecionadas}
                  onToggle={(value) =>
                    toggleValue(value, subcategoriasSelecionadas, setSubcategoriasSelecionadas)
                  }
                />
                {/* Viaja em slug, mostra-se pelo nome. */}
                <SearchableMultiSelect
                  label="Utilizações"
                  options={filterOptions.utilizacoes.map((u) => u.nome)}
                  selected={utilizacoesSelecionadas.map((s) => nomePorSlug.get(s) ?? s)}
                  onToggle={(nome) => {
                    const slug = slugPorNome.get(nome) ?? nome;
                    setUtilizacoesSelecionadas((prev) =>
                      prev.includes(slug) ? prev.filter((v) => v !== slug) : [...prev, slug]
                    );
                  }}
                />
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                {farmaciasSelecionadas.map((item) => (
                  <FilterPill
                    key={`farmacia-${item}`}
                    label={item}
                    onRemove={() =>
                      setFarmaciasSelecionadas((prev) => prev.filter((v) => v !== item))
                    }
                  />
                ))}
                {fornecedoresSelecionados.map((item) => (
                  <FilterPill
                    key={`fornecedor-${item}`}
                    label={item}
                    onRemove={() =>
                      setFornecedoresSelecionados((prev) => prev.filter((v) => v !== item))
                    }
                  />
                ))}
                {fabricantesSelecionados.map((item) => (
                  <FilterPill
                    key={`fabricante-${item}`}
                    label={item}
                    onRemove={() =>
                      setFabricantesSelecionados((prev) => prev.filter((v) => v !== item))
                    }
                  />
                ))}
                {categoriasSelecionadas.map((item) => (
                  <FilterPill
                    key={`categoria-${item}`}
                    label={item}
                    onRemove={() =>
                      setCategoriasSelecionadas((prev) => prev.filter((v) => v !== item))
                    }
                  />
                ))}
              </div>
            </div>
          )}

          <div className="mt-2.5 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-slate-100 pt-2.5">
            <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.14em] text-slate-400">
              <Filter className="h-3 w-3" />
              Filtros rápidos
            </div>

            <ToggleRow
              label="Apenas com sugestão"
              checked={apenasComSugestao}
              onChange={setApenasComSugestao}
              compact
            />
            <ToggleRow
              label="Apenas críticos"
              checked={apenasCriticos}
              onChange={setApenasCriticos}
              compact
            />

            <div className="ml-auto flex flex-wrap items-center gap-3 text-[13px] text-slate-600">
              <span>
                <span className="font-semibold text-slate-900">{resumo.artigos}</span> artigos
              </span>
              <span>
                <span className="font-semibold text-red-600">{resumo.criticos}</span> críticos
              </span>
              {resumo.comSubstituicao > 0 && (
                <span title="Artigos com alternativa interna same-CNP detectada">
                  <span className="font-semibold text-cyan-700">
                    {resumo.comSubstituicao}
                  </span>{" "}
                  c/ transf. interna
                  {resumo.valorEvitavel > 0 && (
                    <span className="ml-1 text-cyan-600">
                      (−
                      {resumo.valorEvitavel.toLocaleString("pt-PT", {
                        minimumFractionDigits: 0,
                        maximumFractionDigits: 0,
                      })}{" "}
                      €)
                    </span>
                  )}
                </span>
              )}
              {resumo.comDciEquivalente > 0 && (
                <span title="Artigos com equivalente por DCI noutra farmácia (CNP diferente). Requer validação humana antes de transferir.">
                  <span className="font-semibold text-amber-700">
                    {resumo.comDciEquivalente}
                  </span>{" "}
                  c/ DCI-equiv. (cautelar)
                  {resumo.valorEvitavelDci > 0 && (
                    <span className="ml-1 text-amber-700">
                      (~−
                      {resumo.valorEvitavelDci.toLocaleString("pt-PT", {
                        minimumFractionDigits: 0,
                        maximumFractionDigits: 0,
                      })}{" "}
                      €)
                    </span>
                  )}
                </span>
              )}
              <span>
                <span className="font-semibold text-slate-900">
                  {resumo.valor.toLocaleString("pt-PT", {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })} €
                </span>{" "}
                estimados
              </span>
            </div>
          </div>
        </section>

        {generationError && (
          <section className="rounded-[16px] border border-rose-200 bg-rose-50 px-4 py-3 text-[12px] text-rose-700">
            Falha a gerar o relatório: {generationError}
          </section>
        )}

        {!hasGenerated && (
          <section className="rounded-[20px] border border-white/70 bg-white/84 px-6 py-16 text-center shadow-[0_8px_18px_rgba(15,23,42,0.04)] backdrop-blur-xl">
            <h2 className="text-[16px] font-semibold text-slate-900">
              Nenhum relatório gerado ainda
            </h2>
            <p className="mx-auto mt-2 max-w-[460px] text-[13px] leading-5 text-slate-500">
              Defina os parâmetros (período, cobertura, filtros) e clique em{" "}
              <span className="font-semibold text-emerald-700">Gerar</span> para
              calcular as propostas de encomenda. A página não pré-carrega dados.
            </p>
          </section>
        )}

        {hasGenerated && (<>
        <section className="sticky top-16 z-20 overflow-hidden rounded-[20px] border border-white/70 bg-white/92 shadow-[0_8px_18px_rgba(15,23,42,0.04)] backdrop-blur-xl">
          {activeRow ? (
            <div className="grid gap-0 xl:grid-cols-[1.05fr_1.1fr_1.15fr]">
              <div className="border-b border-slate-100 px-4 py-3 xl:border-b-0 xl:border-r">
                <h3 className="text-sm font-semibold text-slate-900">Condições do fornecedor</h3>
                <div className="mt-3 overflow-hidden rounded-xl border border-slate-100">
                  <table className="min-w-full text-left">
                    <thead className="bg-slate-50 text-[10px] uppercase tracking-[0.14em] text-slate-500">
                      <tr>
                        <th className="px-2.5 py-1.5 font-semibold">Fornecedor</th>
                        <th className="px-2.5 py-1.5 font-semibold">Desc.</th>
                        <th className="px-2.5 py-1.5 font-semibold">Bónus</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-[12px] text-slate-700">
                      {activeRow.condicoesFornecedor.slice(0, 4).map((item, index) => (
                        <tr key={`${item.fornecedor}-${index}`}>
                          <td className="px-2.5 py-1.5">
                            <div className="font-medium">{item.fornecedor}</div>
                            <div className="text-[11px] text-slate-400">{item.campanha}</div>
                          </td>
                          <td className="px-2.5 py-1.5 whitespace-nowrap">{item.desconto}</td>
                          <td className="px-2.5 py-1.5 whitespace-nowrap">{item.bonus}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="border-b border-slate-100 px-4 py-3 xl:border-b-0 xl:border-r">
                <h3 className="text-sm font-semibold text-slate-900">Compras vs vendas</h3>
                <p className="mt-0.5 text-[12px] text-slate-500">
                  {farmaciaMaiorNecessidade
                    ? `Farmácia com maior necessidade: ${farmaciaMaiorNecessidade.farmacia}`
                    : "Sem dados disponíveis"}
                </p>
                <div className="mt-3">
                  <MovementChart
                    data={farmaciaMaiorNecessidade?.movimentos6M ?? []}
                  />
                </div>
              </div>

              <div className="px-4 py-3">
                <h3 className="text-sm font-semibold text-slate-900">Últimas 4 compras</h3>
                <p className="mt-0.5 text-[12px] text-slate-500">
                  {farmaciaMaiorNecessidade
                    ? `Referência: ${farmaciaMaiorNecessidade.farmacia}`
                    : "Sem histórico disponível"}
                </p>

                <div className="mt-3 overflow-hidden rounded-xl border border-slate-100">
                  <table className="min-w-full text-left">
                    <thead className="bg-slate-50 text-[10px] uppercase tracking-[0.14em] text-slate-500">
                      <tr>
                        <th className="px-2.5 py-1.5 font-semibold">Data</th>
                        <th className="px-2.5 py-1.5 font-semibold">Fornecedor</th>
                        <th className="px-2.5 py-1.5 text-right font-semibold">Qtd.</th>
                        <th className="px-2.5 py-1.5 text-right font-semibold">P. custo</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-[12px] text-slate-700">
                      {(farmaciaMaiorNecessidade?.ultimasCompras ?? []).slice(0, 4).map((item, index) => (
                        <tr key={`${item.data}-${index}`}>
                          <td className="px-2.5 py-1.5 whitespace-nowrap">{item.data}</td>
                          <td className="px-2.5 py-1.5">{item.fornecedor}</td>
                          <td className="px-2.5 py-1.5 whitespace-nowrap text-right">{item.quantidade}</td>
                          <td className="px-2.5 py-1.5 whitespace-nowrap text-right">
                            {item.precoCusto.toLocaleString("pt-PT", {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })} €
                          </td>
                        </tr>
                      ))}

                      {(farmaciaMaiorNecessidade?.ultimasCompras ?? []).length === 0 && (
                        <tr>
                          <td colSpan={4} className="px-3 py-6 text-center text-[12px] text-slate-500">
                            Sem compras registadas.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          ) : (
            <div className="px-4 py-4 text-[13px] text-slate-500">Sem artigo selecionado.</div>
          )}
        </section>

        <section className="overflow-hidden rounded-[20px] border border-white/70 bg-white/84 shadow-[0_8px_18px_rgba(15,23,42,0.04)] backdrop-blur-xl">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">Proposta consolidada</h2>
              <p className="mt-0.5 text-[12px] text-slate-500">
                Encomenda única com discriminação por farmácia
              </p>
            </div>
          </div>

          <div className="max-h-[calc(100vh-500px)] min-h-[320px] overflow-y-auto">
            <table className="min-w-full table-fixed text-left">
              <colgroup>
                <col className="w-[26%]" />
                <col className="w-[16%]" />
                <col className="w-[8%]" />
                <col className="w-[9%]" />
                <col className="w-[9%]" />
                <col className="w-[24%]" />
                <col className="w-[8%]" />
              </colgroup>

              <thead className="sticky top-0 z-10 border-b border-slate-100 bg-slate-50/95 text-[10px] uppercase tracking-[0.14em] text-slate-500 backdrop-blur">
                <tr>
                  <th className="px-4 py-2.5 font-semibold">Produto</th>
                  <th className="px-3 py-2.5 font-semibold">Contexto</th>
                  <th className="px-2 py-2.5 text-center font-semibold">Stock grupo</th>
                  <th className="px-2 py-2.5 text-center font-semibold">Sug. grupo</th>
                  <th className="px-2 py-2.5 text-center font-semibold">Enc. grupo</th>
                  <th className="px-3 py-2.5 font-semibold">Distribuição por farmácia</th>
                  <th className="px-2 py-2.5 text-center font-semibold">Prioridade</th>
                </tr>
              </thead>

              <tbody className="divide-y divide-slate-100 text-[13px] text-slate-700">
                {groupRows.map((row, index) => (
                  <tr
                    key={row.cnp}
                    onMouseEnter={() => setActiveRowIndex(index)}
                    className={[
                      "transition",
                      currentActiveIndex === index ? "bg-emerald-50/70" : "hover:bg-slate-50/70",
                    ].join(" ")}
                  >
                    <td className="px-4 py-2.5 align-top">
                      <div className="space-y-0.5">
                        <Link
                          href={`/stock/artigo/${row.cnp}`}
                          className="block leading-5 font-semibold text-slate-900 transition hover:text-emerald-600"
                          title={[
                            row.dci ? `DCI: ${row.dci}` : null,
                            row.codigoATC ? `ATC: ${row.codigoATC}` : null,
                          ].filter(Boolean).join(" · ") || undefined}
                        >
                          {row.produto}
                        </Link>
                        <div className="flex flex-wrap items-center gap-x-1.5 text-[12px] text-slate-500">
                          <span>CNP {row.cnp}</span>
                          {row.codigoATC && (
                            <span className="rounded bg-slate-100 px-1 font-mono text-[10px] text-slate-600">
                              {row.codigoATC}
                            </span>
                          )}
                          {row.dci && (
                            <span className="truncate text-slate-500" title={row.dci}>
                              · {row.dci}
                            </span>
                          )}
                        </div>
                        {row.hasInternalSubstitution && (
                          <div
                            className="mt-1 inline-flex items-center gap-1 rounded-md border border-cyan-200 bg-cyan-50 px-1.5 py-0.5 text-[10px] font-medium text-cyan-700"
                            title={`Existe excesso same-CNP noutra farmácia do grupo. Transferência interna pode evitar ${row.substitutionAvoidedTotal.toLocaleString("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} € em compras.`}
                          >
                            ↻ Transferência interna possível
                            {row.substitutionAvoidedTotal > 0 && (
                              <span className="ml-1 text-cyan-600">
                                · −
                                {row.substitutionAvoidedTotal.toLocaleString("pt-PT", {
                                  minimumFractionDigits: 0,
                                  maximumFractionDigits: 0,
                                })}{" "}
                                €
                              </span>
                            )}
                          </div>
                        )}
                        {row.hasDciEquivalent && (
                          <div
                            className="mt-1 inline-flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-800"
                            title={`Equivalente por DCI noutra farmácia (CNP diferente). Validar antes de transferir. Estimativa de poupança: ${row.dciEquivalentAvoidedTotal.toLocaleString("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €.`}
                          >
                            ⚠ Equivalente por DCI — validar antes de transferir
                            {row.dciEquivalentAvoidedTotal > 0 && (
                              <span className="ml-1 text-amber-700">
                                · −
                                {row.dciEquivalentAvoidedTotal.toLocaleString("pt-PT", {
                                  minimumFractionDigits: 0,
                                  maximumFractionDigits: 0,
                                })}{" "}
                                €
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </td>

                    <td className="px-3 py-2.5 align-top">
                      <div className="space-y-0.5">
                        <div className="text-[12px] leading-5 text-slate-500">
                          {row.fornecedor} · {row.fabricante}
                        </div>
                        <div className="text-[12px] leading-5 text-slate-400">{row.categoria}</div>
                      </div>
                    </td>

                    <td className="px-2 py-2.5 text-center font-medium">{row.stockGrupo}</td>
                    <td className="px-2 py-2.5 text-center font-semibold text-slate-900">
                      {row.sugestaoGrupo}
                    </td>

                    <td className="px-2 py-2.5 text-center">
                      <input
                        ref={(el) => {
                          inputRefs.current[index] = el;
                        }}
                        type="number"
                        min={0}
                        value={encomendarGrupoValue(row)}
                        onFocus={() => setActiveRowIndex(index)}
                        onChange={(e) => handleChangeEncomendarGrupo(row.cnp, e.target.value)}
                        onKeyDown={(e) => handleRowKeyNavigation(e, index)}
                        className="h-8 w-[66px] rounded-xl border border-slate-200 bg-white px-2 text-center text-[13px] font-semibold text-slate-800 outline-none transition focus:border-emerald-300 focus:ring-4 focus:ring-emerald-100"
                      />
                    </td>

                    <td className="px-3 py-2.5 align-top">
                      <div className="space-y-1">
                        {row.porFarmacia.map((item) => {
                          const mostraSubstituicao =
                            item.internalSubstitutionAvailable &&
                            item.sugestao > 0 &&
                            (item.substitutionQtySuggested ?? 0) > 0;
                          const mostraDci =
                            !item.internalSubstitutionAvailable &&
                            item.dciEquivalentAvailable &&
                            item.sugestao > 0 &&
                            (item.dciEquivalentQtySuggested ?? 0) > 0;
                          return (
                            <div
                              key={`${row.cnp}-${item.farmacia}`}
                              className="rounded-lg bg-slate-50 px-2 py-1"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-[12px] text-slate-700">
                                  {item.farmacia}
                                </span>
                                <span className="text-[12px] text-slate-500">
                                  stock {item.stockAtual} · cob. {item.coberturaAtual} d · sug.{" "}
                                  <span className="font-semibold text-slate-900">
                                    {item.sugestao}
                                  </span>
                                </span>
                              </div>
                              {mostraSubstituicao && (
                                <div className="mt-0.5 text-[11px] leading-4 text-cyan-700">
                                  ↻ Transferir {item.substitutionQtySuggested} un. de{" "}
                                  <span className="font-medium">
                                    {item.substitutionSourceFarmacia}
                                  </span>
                                  {(item.substitutionAvoidedPurchaseValue ?? 0) > 0 && (
                                    <span className="text-cyan-600">
                                      {" "}
                                      · evita{" "}
                                      {item.substitutionAvoidedPurchaseValue!.toLocaleString(
                                        "pt-PT",
                                        { minimumFractionDigits: 2, maximumFractionDigits: 2 },
                                      )}{" "}
                                      €
                                    </span>
                                  )}
                                  {item.produtoId && item.farmaciaId && (
                                    <div className="mt-1">
                                      <CreateInternalTransferButton
                                        kind="same-cnp"
                                        variant="cyan"
                                        input={{
                                          destinoFarmaciaId: item.farmaciaId,
                                          sourceFarmaciaNome: item.substitutionSourceFarmacia ?? "",
                                          produtoId: item.produtoId,
                                          cnp: row.cnp,
                                          designacao: row.produto,
                                          quantidade: item.substitutionQtySuggested ?? 0,
                                          kind: "same-cnp",
                                          motivo: "rotura iminente · excesso interno",
                                        }}
                                      />
                                    </div>
                                  )}
                                </div>
                              )}
                              {mostraDci && (
                                <div
                                  className="mt-0.5 text-[11px] leading-4 text-amber-800"
                                  title={item.dciEquivalentReason ?? "Equivalente por DCI — validar antes de transferir"}
                                >
                                  ⚠ DCI-equivalente: {item.dciEquivalentQtySuggested} un. de{" "}
                                  <span className="font-medium">
                                    {item.dciEquivalentProductName}
                                  </span>
                                  {" "}(CNP {item.dciEquivalentCnp}) em{" "}
                                  <span className="font-medium">
                                    {item.dciEquivalentSourceFarmacia}
                                  </span>
                                  {(item.dciEquivalentAvoidedPurchaseValue ?? 0) > 0 && (
                                    <span className="text-amber-700">
                                      {" "}
                                      · ~
                                      {item.dciEquivalentAvoidedPurchaseValue!.toLocaleString(
                                        "pt-PT",
                                        { minimumFractionDigits: 2, maximumFractionDigits: 2 },
                                      )}{" "}
                                      €
                                    </span>
                                  )}
                                  <div className="text-amber-700/80">
                                    Validar antes de transferir
                                  </div>
                                  {item.farmaciaId && item.dciEquivalentSourceProdutoId && (
                                    <div className="mt-1">
                                      <CreateInternalTransferButton
                                        kind="dci-equivalent"
                                        variant="amber"
                                        input={{
                                          destinoFarmaciaId: item.farmaciaId,
                                          sourceFarmaciaNome: item.dciEquivalentSourceFarmacia ?? "",
                                          produtoId: item.dciEquivalentSourceProdutoId,
                                          cnp: item.dciEquivalentCnp ?? row.cnp,
                                          designacao: item.dciEquivalentProductName ?? row.produto,
                                          quantidade: item.dciEquivalentQtySuggested ?? 0,
                                          kind: "dci-equivalent",
                                          motivo: item.dciEquivalentReason ?? "DCI-equivalente",
                                          dciSourceProductName: item.dciEquivalentProductName,
                                          dciSourceCnp: item.dciEquivalentCnp,
                                        }}
                                      />
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </td>

                    <td className="px-2 py-2.5 text-center align-top">
                      <span
                        className={[
                          "inline-flex rounded-full border px-1.5 py-0.5 text-[11px] font-semibold whitespace-nowrap",
                          getPriorityClasses(row.prioridade),
                        ].join(" ")}
                      >
                        {row.prioridade}
                      </span>
                    </td>
                  </tr>
                ))}

                {groupRows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-6 py-12 text-center">
                      <div className="mx-auto max-w-md">
                        <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl bg-slate-100 text-slate-500">
                          <Filter className="h-4 w-4" />
                        </div>
                        <div className="mt-3 text-[13px] font-semibold text-slate-900">
                          Sem artigos para os filtros selecionados
                        </div>
                        <p className="mt-1.5 text-[12px] text-slate-500">
                          Ajuste farmácias, fabricantes, fornecedores ou categorias.
                        </p>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
        </>)}
      </div>
    </AppShell>
  );
}

function CompactSelect({
  label,
  value,
  onChange,
  options,
  suffix,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
  suffix?: string;
}) {
  return (
    <label className="block">
      <div className="mb-1 text-[11px] font-medium text-slate-500">{label}</div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-full rounded-xl border border-slate-200 bg-white px-3 text-[13px] font-medium text-slate-800 outline-none transition focus:border-emerald-300 focus:ring-4 focus:ring-emerald-100"
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {suffix && ["7", "15", "30", "60", "90"].includes(option)
              ? `${option}${suffix}`
              : option}
          </option>
        ))}
      </select>
    </label>
  );
}

function CompactInput({
  label,
  value,
  onChange,
  suffix,
}: {
  label: string;
  value: number;
  onChange: (value: string) => void;
  suffix?: string;
}) {
  return (
    <label className="block min-w-[110px]">
      <div className="mb-1 text-[11px] font-medium text-slate-500">{label}</div>
      <div className="relative">
        <input
          type="number"
          min={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-full rounded-xl border border-slate-200 bg-white px-3 pr-12 text-[13px] font-medium text-slate-800 outline-none transition focus:border-emerald-300 focus:ring-4 focus:ring-emerald-100"
        />
        {suffix && (
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-slate-400">
            {suffix}
          </span>
        )}
      </div>
    </label>
  );
}

function SearchableMultiSelect({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string;
  options: string[];
  selected: string[];
  onToggle: (value: string) => void;
}) {
  const [query, setQuery] = useState("");

  const filteredOptions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((option) => option.toLowerCase().includes(q));
  }, [options, query]);

  return (
    <div>
      <div className="mb-1 text-[11px] font-medium text-slate-500">{label}</div>

      <div className="rounded-xl border border-slate-200 bg-white p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Pesquisar ${label.toLowerCase()}...`}
            className="h-9 w-full rounded-lg border border-slate-200 bg-slate-50 pl-9 pr-3 text-[13px] text-slate-700 outline-none transition focus:border-emerald-300 focus:bg-white"
          />
        </div>

        <div className="mt-2 max-h-44 space-y-1 overflow-y-auto">
          {filteredOptions.map((option) => {
            const active = selected.includes(option);
            return (
              <button
                key={option}
                type="button"
                onClick={() => onToggle(option)}
                className={[
                  "flex w-full items-center justify-between rounded-lg px-2 py-2 text-left text-[12px] font-medium transition",
                  active
                    ? "bg-emerald-600 text-white"
                    : "bg-slate-100 text-slate-700 hover:bg-slate-200",
                ].join(" ")}
              >
                <span className="truncate">{option}</span>
                {active && <span className="ml-2 text-[11px] font-semibold">✓</span>}
              </button>
            );
          })}

          {filteredOptions.length === 0 && (
            <div className="rounded-lg border border-dashed border-slate-200 px-3 py-3 text-[12px] text-slate-500">
              Sem resultados.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FilterPill({
  label,
  onRemove,
}: {
  label: string;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[12px] text-slate-700">
      {label}
      <button
        type="button"
        onClick={onRemove}
        className="text-slate-400 transition hover:text-slate-700"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
  compact = false,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  compact?: boolean;
}) {
  return (
    <label className={compact ? "flex items-center gap-2.5" : "flex items-center justify-between gap-2.5"}>
      <span className="text-[13px] text-slate-700">{label}</span>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={[
          "relative h-5 w-10 rounded-full transition",
          checked ? "bg-emerald-500" : "bg-slate-200",
        ].join(" ")}
      >
        <span
          className={[
            "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition",
            checked ? "left-[20px]" : "left-0.5",
          ].join(" ")}
        />
      </button>
    </label>
  );
}

function ActionButton({
  icon,
  label,
  primary = false,
}: {
  icon: React.ReactNode;
  label: string;
  primary?: boolean;
}) {
  return (
    <button
      className={[
        "inline-flex h-9 items-center gap-1.5 rounded-xl px-3 text-[13px] font-medium transition",
        primary
          ? "bg-emerald-600 text-white shadow-sm hover:bg-emerald-700"
          : "border border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-800",
      ].join(" ")}
    >
      {icon}
      {label}
    </button>
  );
}

function MovementChart({ data }: { data: MonthlyMovement[] }) {
  const safeData = data.length > 0 ? data : [{ mes: "-", compras: 0, vendas: 0 }];
  const maxValue = Math.max(...safeData.flatMap((item) => [item.compras, item.vendas]), 1);

  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50/60 p-3">
      <div className="flex h-[118px] items-end gap-2">
        {safeData.map((item) => {
          const comprasHeight = Math.max((item.compras / maxValue) * 74, 8);
          const vendasHeight = Math.max((item.vendas / maxValue) * 74, 8);

          return (
            <div key={item.mes} className="flex flex-1 flex-col items-center gap-1.5">
              <div className="flex h-[84px] items-end gap-1">
                <div className="w-3 rounded-t-md bg-emerald-300" style={{ height: `${comprasHeight}px` }} />
                <div className="w-3 rounded-t-md bg-sky-300" style={{ height: `${vendasHeight}px` }} />
              </div>
              <div className="text-[10px] font-medium text-slate-500">{item.mes}</div>
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex items-center gap-3 text-[11px] text-slate-500">
        <div className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-emerald-300" />
          Compras
        </div>
        <div className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-sky-300" />
          Vendas
        </div>
      </div>
    </div>
  );
}