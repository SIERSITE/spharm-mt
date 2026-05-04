"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { runExcessosReport } from "@/app/excessos/actions";
import {
  Download,
  Eye,
  Filter,
  Mail,
  Printer,
  FileText,
  ChevronDown,
  Search,
  X,
} from "lucide-react";
import { AppShell } from "@/components/layout/app-shell";
import { ReportActions } from "@/components/reporting/report-actions";
import { buildExcessosReport } from "@/lib/reporting/adapters/excessos";
import { formatFarmaciaHeader, type FarmaciaInfo } from "@/lib/farmacias-header";
import type { ReportingFilterOptions } from "@/lib/reporting-filter-options";

type ModoVisualizacao = "tabela" | "relatorio";
type Ordenacao =
  | "prioridade"
  | "quantidadeSugerida"
  | "produto"
  | "farmaciaOrigem"
  | "farmaciaDestino";

type Priority = "alta" | "media" | "baixa";

type TransferSuggestionRow = {
  cnp: string;
  produto: string;
  farmaciaOrigem: string;
  farmaciaDestino: string;
  stockOrigem: number;
  stockDestino: number;
  coberturaOrigem: number;
  coberturaDestino: number;
  quantidadeSugerida: number;
  excessoOrigem: number;
  necessidadeDestino: number;
  fabricante: string;
  categoria: string;
  fornecedor: string;
  prioridade: Priority;
  observacao?: string;
};

type ReportSnapshot = {
  farmaciasOrigemSelecionadas: string[];
  farmaciasDestinoSelecionadas: string[];
  fornecedoresSelecionados: string[];
  fabricantesSelecionados: string[];
  categoriasSelecionadas: string[];
  prioridadesSelecionadas: string[];
  artigo: string;
  dataInicio: string;
  dataFim: string;
  ordenarPor: Ordenacao;
  apenasComNecessidade: boolean;
  apenasComExcesso: boolean;
  apenasAltaPrioridade: boolean;
  quantidadeMinima: string;
  incluirTotais: boolean;
};

function toggleValue(
  value: string,
  selected: string[],
  setter: React.Dispatch<React.SetStateAction<string[]>>
) {
  setter((prev) =>
    prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]
  );
}

export function ExcessosClient({
  farmaciasInfo,
  filterOptions,
  initialRows: preloadedRows,
  initialThresholdDays,
}: {
  farmaciasInfo: FarmaciaInfo[];
  filterOptions: ReportingFilterOptions;
  /** Linhas pré-carregadas pelo server quando há ?days na URL (entrada da dashboard). */
  initialRows?: TransferSuggestionRow[];
  /** Threshold (em dias) usado quando ?days está presente. */
  initialThresholdDays?: number;
}) {
  // Lazy: sem ?days na URL, não carrega nada até clicar em "Gerar". Com ?days,
  // já vem pré-carregado do server e o mesmo threshold é reutilizado em
  // re-execuções (botão "Gerar").
  const [rows, setRows] = useState<TransferSuggestionRow[]>(preloadedRows ?? []);
  const [hasGenerated, setHasGenerated] = useState(
    (preloadedRows?.length ?? 0) > 0,
  );
  const [isPending, startTransition] = useTransition();
  const [generationError, setGenerationError] = useState<string | null>(null);
  const initialRows = rows;

  const handleGerar = () => {
    setGenerationError(null);
    startTransition(async () => {
      try {
        const result = await runExcessosReport(
          initialThresholdDays !== undefined
            ? { thresholdDays: initialThresholdDays }
            : undefined,
        );
        setRows(result);
        setHasGenerated(true);
      } catch (err) {
        setGenerationError(err instanceof Error ? err.message : String(err));
        setRows([]);
      }
    });
  };

  const farmacias = Array.from(new Set(farmaciasInfo.map((f) => f.nome)));
  const fornecedores = filterOptions.fornecedores;
  const fabricantes = filterOptions.fabricantes;
  const categorias = filterOptions.categorias;
  void initialRows;
  const prioridades = ["alta", "media", "baixa"];

  const [farmaciasOrigemSelecionadas, setFarmaciasOrigemSelecionadas] =
    useState<string[]>(farmacias);
  const [farmaciasDestinoSelecionadas, setFarmaciasDestinoSelecionadas] =
    useState<string[]>(farmacias);
  const [fornecedoresSelecionados, setFornecedoresSelecionados] = useState<string[]>([]);
  const [fabricantesSelecionados, setFabricantesSelecionados] = useState<string[]>([]);
  const [categoriasSelecionadas, setCategoriasSelecionadas] = useState<string[]>([]);
  const [prioridadesSelecionadas, setPrioridadesSelecionadas] = useState<string[]>([]);
  const [artigo, setArtigo] = useState("");
  const [dataInicio, setDataInicio] = useState("2026-04-01");
  const [dataFim, setDataFim] = useState("2026-04-13");
  const [ordenarPor, setOrdenarPor] = useState<Ordenacao>("prioridade");
  const [apenasComNecessidade, setApenasComNecessidade] = useState(false);
  const [apenasComExcesso, setApenasComExcesso] = useState(true);
  const [apenasAltaPrioridade, setApenasAltaPrioridade] = useState(false);
  const [quantidadeMinima, setQuantidadeMinima] = useState("");
  const [incluirTotais, setIncluirTotais] = useState(true);
  const [modoVisualizacao, setModoVisualizacao] = useState<ModoVisualizacao>("tabela");
  const [filtrosAbertos, setFiltrosAbertos] = useState(false);
  const [relatorioGerado, setRelatorioGerado] = useState(false);
  const [snapshot, setSnapshot] = useState<ReportSnapshot | null>(null);

  function handleGerarRelatorio() {
    setSnapshot({
      farmaciasOrigemSelecionadas: [...farmaciasOrigemSelecionadas],
      farmaciasDestinoSelecionadas: [...farmaciasDestinoSelecionadas],
      fornecedoresSelecionados: [...fornecedoresSelecionados],
      fabricantesSelecionados: [...fabricantesSelecionados],
      categoriasSelecionadas: [...categoriasSelecionadas],
      prioridadesSelecionadas: [...prioridadesSelecionadas],
      artigo,
      dataInicio,
      dataFim,
      ordenarPor,
      apenasComNecessidade,
      apenasComExcesso,
      apenasAltaPrioridade,
      quantidadeMinima,
      incluirTotais,
    });
    setRelatorioGerado(true);
  }

  const filtrosAtivosCount =
    farmaciasOrigemSelecionadas.length +
    farmaciasDestinoSelecionadas.length +
    fornecedoresSelecionados.length +
    fabricantesSelecionados.length +
    categoriasSelecionadas.length +
    prioridadesSelecionadas.length;

  const rowsForReport = useMemo(() => {
    if (!snapshot) return [];
    const quantidadeMin = Number(snapshot.quantidadeMinima || 0);
    return initialRows.filter((row) => {
      if (snapshot.farmaciasOrigemSelecionadas.length > 0 && !snapshot.farmaciasOrigemSelecionadas.includes(row.farmaciaOrigem)) return false;
      if (snapshot.farmaciasDestinoSelecionadas.length > 0 && !snapshot.farmaciasDestinoSelecionadas.includes(row.farmaciaDestino)) return false;
      if (snapshot.fornecedoresSelecionados.length > 0 && !snapshot.fornecedoresSelecionados.includes(row.fornecedor)) return false;
      if (snapshot.fabricantesSelecionados.length > 0 && !snapshot.fabricantesSelecionados.includes(row.fabricante)) return false;
      if (snapshot.categoriasSelecionadas.length > 0 && !snapshot.categoriasSelecionadas.includes(row.categoria)) return false;
      if (snapshot.prioridadesSelecionadas.length > 0 && !snapshot.prioridadesSelecionadas.includes(row.prioridade)) return false;
      if (snapshot.artigo.trim() && !`${row.cnp} ${row.produto}`.toLowerCase().includes(snapshot.artigo.toLowerCase())) return false;
      if (snapshot.apenasComNecessidade && row.necessidadeDestino <= 0) return false;
      if (snapshot.apenasComExcesso && row.excessoOrigem <= 0) return false;
      if (snapshot.apenasAltaPrioridade && row.prioridade !== "alta") return false;
      if (quantidadeMin > 0 && row.quantidadeSugerida < quantidadeMin) return false;
      return true;
    });
  }, [snapshot, initialRows]);

  const orderedRows = useMemo(() => {
    if (!snapshot) return [];
    const priorityRank: Record<Priority, number> = { alta: 3, media: 2, baixa: 1 };
    return [...rowsForReport].sort((a, b) => {
      switch (snapshot.ordenarPor) {
        case "produto": return a.produto.localeCompare(b.produto);
        case "farmaciaOrigem": return a.farmaciaOrigem.localeCompare(b.farmaciaOrigem);
        case "farmaciaDestino": return a.farmaciaDestino.localeCompare(b.farmaciaDestino);
        case "quantidadeSugerida": return b.quantidadeSugerida - a.quantidadeSugerida;
        case "prioridade":
        default: return priorityRank[b.prioridade] - priorityRank[a.prioridade];
      }
    });
  }, [rowsForReport, snapshot]);

  const resumo = useMemo(() => ({
    totalSugestoes: orderedRows.length,
    totalUnidades: sum(orderedRows.map((row) => row.quantidadeSugerida)),
    referencias: new Set(orderedRows.map((row) => row.cnp)).size,
    farmaciasOrigem: new Set(orderedRows.map((row) => row.farmaciaOrigem)).size,
    farmaciasDestino: new Set(orderedRows.map((row) => row.farmaciaDestino)).size,
  }), [orderedRows]);

  const resumoOrigem = useMemo(() => {
    const grouped = new Map<string, { farmacia: string; referencias: number; unidades: number; linhas: number }>();
    for (const row of orderedRows) {
      const current = grouped.get(row.farmaciaOrigem);
      if (!current) {
        grouped.set(row.farmaciaOrigem, { farmacia: row.farmaciaOrigem, referencias: 1, unidades: row.quantidadeSugerida, linhas: 1 });
      } else {
        current.unidades += row.quantidadeSugerida;
        current.linhas += 1;
      }
    }
    return Array.from(grouped.values()).map((item) => ({
      ...item,
      referencias: new Set(orderedRows.filter((row) => row.farmaciaOrigem === item.farmacia).map((row) => row.cnp)).size,
    }));
  }, [orderedRows]);

  const resumoDestino = useMemo(() => {
    const grouped = new Map<string, { farmacia: string; referencias: number; unidades: number; linhas: number }>();
    for (const row of orderedRows) {
      const current = grouped.get(row.farmaciaDestino);
      if (!current) {
        grouped.set(row.farmaciaDestino, { farmacia: row.farmaciaDestino, referencias: 1, unidades: row.quantidadeSugerida, linhas: 1 });
      } else {
        current.unidades += row.quantidadeSugerida;
        current.linhas += 1;
      }
    }
    return Array.from(grouped.values()).map((item) => ({
      ...item,
      referencias: new Set(orderedRows.filter((row) => row.farmaciaDestino === item.farmacia).map((row) => row.cnp)).size,
    }));
  }, [orderedRows]);

  return (
    <AppShell>
      <div className="space-y-3">
        <section className="flex items-start justify-between gap-4">
          <div className="space-y-0.5">
            <div className="text-xs font-medium text-slate-500">
              Stock / Excessos
            </div>
            <h1 className="text-[28px] font-semibold tracking-tight text-slate-900">
              Relatório de Excessos
            </h1>
            <p className="text-[13px] text-slate-600">
              Análise consolidada de stock excessivo por farmácia do grupo.
            </p>
          </div>
          <div className="mt-1 flex items-center gap-2">
          <button
            type="button"
            onClick={handleGerar}
            disabled={isPending}
            className="inline-flex h-9 items-center gap-2 rounded-xl border border-emerald-300 bg-emerald-50 px-4 text-[13px] font-semibold text-emerald-700 transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isPending ? "A gerar…" : hasGenerated ? "Atualizar" : "Gerar"}
          </button>
          <ReportActions
            hide={!hasGenerated ? { print: true, pdf: true, excel: true, email: true } : undefined}
            report={() =>
              buildExcessosReport({
                rows: rowsForReport,
                filters: {
                  farmaciasOrigemSelecionadas,
                  farmaciasDestinoSelecionadas,
                  fornecedoresSelecionados,
                  fabricantesSelecionados,
                  categoriasSelecionadas,
                  prioridadesSelecionadas,
                  artigo,
                  dataInicio,
                  dataFim,
                  ordenarPor,
                  apenasComNecessidade,
                  apenasComExcesso,
                  apenasAltaPrioridade,
                  quantidadeMinima,
                },
                universe: { farmacias, fornecedores, fabricantes, categorias, prioridades },
                organization: formatFarmaciaHeader(
                  Array.from(
                    new Set([
                      ...farmaciasOrigemSelecionadas,
                      ...farmaciasDestinoSelecionadas,
                    ])
                  ),
                  farmaciasInfo
                ),
              })
            }
          />
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
              Carregue em <span className="font-semibold text-emerald-700">Gerar</span> para
              identificar excessos de stock. A página não pré-carrega dados.
            </p>
          </section>
        )}

        {hasGenerated && (<>
        <section className="rounded-[20px] border border-white/70 bg-white/84 px-4 py-3 shadow-[0_8px_18px_rgba(15,23,42,0.04)] backdrop-blur-xl">
          <div className="grid gap-2.5 xl:grid-cols-[1fr_1fr_0.9fr_0.9fr_auto]">
            <CompactInput label="Artigo" value={artigo} onChange={setArtigo} placeholder="Código ou descrição" />
            <CompactSelect
              label="Ordenar por"
              value={ordenarPor}
              onChange={(value) => setOrdenarPor(value as Ordenacao)}
              options={["prioridade", "quantidadeSugerida", "produto", "farmaciaOrigem", "farmaciaDestino"]}
            />
            <CompactDate label="Data início" value={dataInicio} onChange={setDataInicio} />
            <CompactDate label="Data fim" value={dataFim} onChange={setDataFim} />
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
                <ChevronDown className={["h-3.5 w-3.5 transition", filtrosAbertos ? "rotate-180" : ""].join(" ")} />
              </button>
            </div>
          </div>

          <div className="mt-2.5 grid gap-2.5 xl:grid-cols-[0.9fr_auto]">
            <CompactInput label="Qtd. mínima sugerida" value={quantidadeMinima} onChange={setQuantidadeMinima} placeholder="Ex.: 5" />
            <div className="flex items-end gap-2">
              <ActionButton icon={<Eye className="h-3.5 w-3.5" />} label="Gerar relatório" primary onClick={handleGerarRelatorio} />
              <ActionButton icon={<Eye className="h-3.5 w-3.5" />} label="Ver em ecrã" />
              <ActionButton icon={<Printer className="h-3.5 w-3.5" />} label="Imprimir" onClick={() => window.print()} />
              <ActionButton icon={<FileText className="h-3.5 w-3.5" />} label="PDF" />
              <ActionButton icon={<Download className="h-3.5 w-3.5" />} label="Excel" />
              <ActionButton icon={<Mail className="h-3.5 w-3.5" />} label="Email" />
            </div>
          </div>

          {filtrosAbertos && (
            <div className="mt-3 rounded-2xl border border-slate-200 bg-white p-3">
              <div className="grid gap-3 xl:grid-cols-3">
                <SearchableMultiSelect label="Farmácia origem" options={farmacias} selected={farmaciasOrigemSelecionadas} onToggle={(value) => toggleValue(value, farmaciasOrigemSelecionadas, setFarmaciasOrigemSelecionadas)} />
                <SearchableMultiSelect label="Farmácia destino" options={farmacias} selected={farmaciasDestinoSelecionadas} onToggle={(value) => toggleValue(value, farmaciasDestinoSelecionadas, setFarmaciasDestinoSelecionadas)} />
                <SearchableMultiSelect label="Prioridade" options={prioridades} selected={prioridadesSelecionadas} onToggle={(value) => toggleValue(value, prioridadesSelecionadas, setPrioridadesSelecionadas)} />
                <SearchableMultiSelect label="Distribuidor" options={fornecedores} selected={fornecedoresSelecionados} onToggle={(value) => toggleValue(value, fornecedoresSelecionados, setFornecedoresSelecionados)} />
                <SearchableMultiSelect label="Fabricante" options={fabricantes} selected={fabricantesSelecionados} onToggle={(value) => toggleValue(value, fabricantesSelecionados, setFabricantesSelecionados)} />
                <SearchableMultiSelect label="Categoria" options={categorias} selected={categoriasSelecionadas} onToggle={(value) => toggleValue(value, categoriasSelecionadas, setCategoriasSelecionadas)} />
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {farmaciasOrigemSelecionadas.map((item) => (
                  <FilterPill key={`origem-${item}`} label={`Origem: ${item}`} onRemove={() => setFarmaciasOrigemSelecionadas((prev) => prev.filter((v) => v !== item))} />
                ))}
                {farmaciasDestinoSelecionadas.map((item) => (
                  <FilterPill key={`destino-${item}`} label={`Destino: ${item}`} onRemove={() => setFarmaciasDestinoSelecionadas((prev) => prev.filter((v) => v !== item))} />
                ))}
                {prioridadesSelecionadas.map((item) => (
                  <FilterPill key={`prioridade-${item}`} label={`Prioridade: ${humanizeOption(item)}`} onRemove={() => setPrioridadesSelecionadas((prev) => prev.filter((v) => v !== item))} />
                ))}
                {fornecedoresSelecionados.map((item) => (
                  <FilterPill key={`fornecedor-${item}`} label={`Fornecedor: ${item}`} onRemove={() => setFornecedoresSelecionados((prev) => prev.filter((v) => v !== item))} />
                ))}
                {fabricantesSelecionados.map((item) => (
                  <FilterPill key={`fabricante-${item}`} label={`Fabricante: ${item}`} onRemove={() => setFabricantesSelecionados((prev) => prev.filter((v) => v !== item))} />
                ))}
                {categoriasSelecionadas.map((item) => (
                  <FilterPill key={`categoria-${item}`} label={`Categoria: ${item}`} onRemove={() => setCategoriasSelecionadas((prev) => prev.filter((v) => v !== item))} />
                ))}
              </div>
            </div>
          )}

          <div className="mt-2.5 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-slate-100 pt-2.5">
            <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.14em] text-slate-400">
              <Filter className="h-3 w-3" />
              Filtros rápidos
            </div>
            <ToggleRow label="Apenas com necessidade" checked={apenasComNecessidade} onChange={setApenasComNecessidade} compact />
            <ToggleRow label="Apenas com excesso" checked={apenasComExcesso} onChange={setApenasComExcesso} compact />
            <ToggleRow label="Só alta prioridade" checked={apenasAltaPrioridade} onChange={setApenasAltaPrioridade} compact />
            <ToggleRow label="Incluir totais" checked={incluirTotais} onChange={setIncluirTotais} compact />
            <div className="ml-auto flex flex-wrap items-center gap-3 text-[13px] text-slate-600">
              <span><span className="font-semibold text-slate-900">{relatorioGerado ? resumo.totalSugestoes : 0}</span> excessos</span>
              <span><span className="font-semibold text-slate-900">{relatorioGerado ? resumo.totalUnidades.toLocaleString("pt-PT") : "0"}</span> unidades</span>
              <span><span className="font-semibold text-slate-900">{relatorioGerado ? resumo.referencias : 0}</span> referências</span>
            </div>
          </div>
        </section>

        <section className="rounded-[20px] border border-white/70 bg-white/92 px-3 py-2 shadow-[0_8px_18px_rgba(15,23,42,0.04)] backdrop-blur-xl">
          <div className="flex items-center gap-2">
            <TabButton label="Tabela" active={modoVisualizacao === "tabela"} onClick={() => setModoVisualizacao("tabela")} />
            <TabButton label="Relatório" active={modoVisualizacao === "relatorio"} onClick={() => setModoVisualizacao("relatorio")} />
          </div>
        </section>

        {!relatorioGerado || !snapshot ? (
          <section className="rounded-[20px] border border-dashed border-slate-300 bg-white/84 px-6 py-12 text-center shadow-[0_8px_18px_rgba(15,23,42,0.04)] backdrop-blur-xl">
            <div className="mx-auto max-w-2xl">
              <h2 className="text-base font-semibold text-slate-900">O relatório de excessos é gerado sob pedido</h2>
              <p className="mt-2 text-[13px] leading-6 text-slate-600">
                Defina os critérios pretendidos e carregue em <span className="font-semibold text-slate-900">Gerar relatório</span> para construir a análise consolidada.
              </p>
            </div>
          </section>
        ) : modoVisualizacao === "tabela" ? (
          <section className="overflow-hidden rounded-[20px] border border-white/70 bg-white/84 shadow-[0_8px_18px_rgba(15,23,42,0.04)] backdrop-blur-xl">
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
              <div>
                <h2 className="text-sm font-semibold text-slate-900">Vista operacional</h2>
                <p className="mt-0.5 text-[12px] text-slate-500">Leitura dos excessos de stock por farmácia.</p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] text-slate-500">
                {humanizeOption(snapshot.ordenarPor)}
              </div>
            </div>

            <div className="max-h-[calc(100vh-360px)] min-h-[420px] overflow-y-auto">
              <table className="min-w-full table-fixed text-left">
                <colgroup>
                  <col className="w-[8%]" />
                  <col className="w-[22%]" />
                  <col className="w-[10%]" />
                  <col className="w-[10%]" />
                  <col className="w-[7%]" />
                  <col className="w-[7%]" />
                  <col className="w-[7%]" />
                  <col className="w-[7%]" />
                  <col className="w-[8%]" />
                  <col className="w-[7%]" />
                  <col className="w-[7%]" />
                </colgroup>
                <thead className="sticky top-0 z-10 border-b border-slate-100 bg-slate-50/95 text-[10px] uppercase tracking-[0.14em] text-slate-500 backdrop-blur">
                  <tr>
                    <th className="px-4 py-2.5 font-semibold">CNP</th>
                    <th className="px-3 py-2.5 font-semibold">Produto</th>
                    <th className="px-3 py-2.5 font-semibold">Farmácia</th>
                    <th className="px-3 py-2.5 font-semibold">Destino poss.</th>
                    <th className="px-2 py-2.5 text-center font-semibold">St. O.</th>
                    <th className="px-2 py-2.5 text-center font-semibold">St. D.</th>
                    <th className="px-2 py-2.5 text-center font-semibold">Cob. O.</th>
                    <th className="px-2 py-2.5 text-center font-semibold">Cob. D.</th>
                    <th className="px-2 py-2.5 text-center font-semibold">Excesso</th>
                    <th className="px-2 py-2.5 text-center font-semibold">Sug.</th>
                    <th className="px-2 py-2.5 text-center font-semibold">Necess.</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-[13px] text-slate-700">
                  {orderedRows.map((row, index) => (
                    <tr key={`${row.cnp}-${row.farmaciaOrigem}-${index}`} className="transition hover:bg-slate-50/70">
                      <td className="px-4 py-2.5 align-top font-medium text-slate-800">{row.cnp}</td>
                      <td className="px-3 py-2.5 align-top">
                        <div className="space-y-0.5">
                          <Link href={`/stock/artigo/${row.cnp}`} className="block font-semibold leading-5 text-slate-900 transition hover:text-emerald-600">
                            {row.produto}
                          </Link>
                          <div className="text-[12px] text-slate-500">
                            {[row.fabricante, row.categoria].filter(Boolean).join(" · ") || "—"}
                          </div>
                          <div className="mt-1"><PriorityBadge prioridade={row.prioridade} /></div>
                        </div>
                      </td>
                      <td className="px-3 py-2.5">{row.farmaciaOrigem}</td>
                      <td className="px-3 py-2.5">{row.farmaciaDestino}</td>
                      <td className="px-2 py-2.5 text-center">{row.stockOrigem}</td>
                      <td className="px-2 py-2.5 text-center">{row.stockDestino}</td>
                      <td className="px-2 py-2.5 text-center">{row.coberturaOrigem}</td>
                      <td className="px-2 py-2.5 text-center">{row.coberturaDestino}</td>
                      <td className="px-2 py-2.5 text-center font-semibold text-slate-900">{row.excessoOrigem}</td>
                      <td className="px-2 py-2.5 text-center">{row.quantidadeSugerida}</td>
                      <td className="px-2 py-2.5 text-center">{row.necessidadeDestino}</td>
                    </tr>
                  ))}
                  {snapshot.incluirTotais && orderedRows.length > 0 && (
                    <tr className="bg-slate-50/70 font-semibold text-slate-900">
                      <td className="px-4 py-2.5" colSpan={8}>Totais</td>
                      <td className="px-2 py-2.5 text-center">{sum(orderedRows.map((r) => r.excessoOrigem))}</td>
                      <td className="px-2 py-2.5 text-center">{sum(orderedRows.map((r) => r.quantidadeSugerida))}</td>
                      <td className="px-2 py-2.5 text-center">{sum(orderedRows.map((r) => r.necessidadeDestino))}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        ) : (
          <section className="overflow-hidden rounded-[20px] border border-white/70 bg-white/84 shadow-[0_8px_18px_rgba(15,23,42,0.04)] backdrop-blur-xl">
            <div className="border-b border-slate-100 px-4 py-3">
              <h2 className="text-sm font-semibold text-slate-900">Vista relatório</h2>
              <p className="mt-0.5 text-[12px] text-slate-500">Estrutura preparada para impressão, PDF e leitura consolidada.</p>
            </div>
            <div className="max-h-[calc(100vh-360px)] overflow-y-auto p-4">
              <div className="mx-auto max-w-[1280px] space-y-4">
                <div className="rounded-[18px] border border-slate-200 bg-white p-5 shadow-sm">
                  <div className="border-b border-dashed border-slate-300 pb-3">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <div className="text-[11px] text-slate-500">Farmácia Silveirense, Lda. (NIF: 507529930)</div>
                        <div className="mt-2 text-[15px] font-semibold text-slate-900">Relatório de Excessos de Stock</div>
                        <div className="mt-1 text-[12px] text-slate-600">
                          Período: De {formatDatePt(snapshot.dataInicio)} até {formatDatePt(snapshot.dataFim)}
                        </div>
                      </div>
                      <div className="text-right text-[12px] text-slate-500">
                        <div>{formatDatePt("2026-04-13")}</div>
                        <div className="mt-1">Moeda: Euro</div>
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 grid gap-3 md:grid-cols-5">
                    <MetricCard label="Excessos" value={String(resumo.totalSugestoes)} />
                    <MetricCard label="Unidades" value={resumo.totalUnidades.toLocaleString("pt-PT")} />
                    <MetricCard label="Referências" value={String(resumo.referencias)} />
                    <MetricCard label="Farmácias com excesso" value={String(resumo.farmaciasOrigem)} />
                    <MetricCard label="Destinos possíveis" value={String(resumo.farmaciasDestino)} />
                  </div>

                  <div className="mt-4 overflow-hidden rounded-xl border border-slate-200">
                    <table className="min-w-full text-left">
                      <thead className="bg-slate-50 text-[10px] uppercase tracking-[0.14em] text-slate-500">
                        <tr>
                          <th className="px-3 py-2 font-semibold">CNP</th>
                          <th className="px-3 py-2 font-semibold">Produto</th>
                          <th className="px-3 py-2 font-semibold">Farmácia</th>
                          <th className="px-3 py-2 font-semibold">Destino poss.</th>
                          <th className="px-3 py-2 text-center font-semibold">Excesso</th>
                          <th className="px-3 py-2 text-center font-semibold">Sug.</th>
                          <th className="px-3 py-2 text-center font-semibold">Necess.</th>
                          <th className="px-3 py-2 font-semibold">Prioridade</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200 text-[12px] text-slate-700">
                        {orderedRows.map((row, index) => (
                          <tr key={`report-${row.cnp}-${row.farmaciaOrigem}-${index}`}>
                            <td className="whitespace-nowrap px-3 py-1.5">{row.cnp}</td>
                            <td className="px-3 py-1.5">{row.produto}</td>
                            <td className="px-3 py-1.5">{row.farmaciaOrigem}</td>
                            <td className="px-3 py-1.5">{row.farmaciaDestino}</td>
                            <td className="px-3 py-1.5 text-center">{row.excessoOrigem}</td>
                            <td className="px-3 py-1.5 text-center">{row.quantidadeSugerida}</td>
                            <td className="px-3 py-1.5 text-center">{row.necessidadeDestino}</td>
                            <td className="px-3 py-1.5"><PriorityBadge prioridade={row.prioridade} /></td>
                          </tr>
                        ))}
                        {snapshot.incluirTotais && orderedRows.length > 0 && (
                          <tr className="bg-slate-50 font-semibold text-slate-900">
                            <td className="px-3 py-2" colSpan={4}>Totais</td>
                            <td className="px-3 py-2 text-center">{sum(orderedRows.map((r) => r.excessoOrigem))}</td>
                            <td className="px-3 py-2 text-center">{sum(orderedRows.map((r) => r.quantidadeSugerida))}</td>
                            <td className="px-3 py-2 text-center">{sum(orderedRows.map((r) => r.necessidadeDestino))}</td>
                            <td className="px-3 py-2" />
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>

                  <div className="mt-4 flex items-center justify-between text-[11px] text-slate-400">
                    <div>SoftReis Informática</div>
                    <div>Página 1 de 1</div>
                  </div>
                </div>

                <div className="grid gap-4 xl:grid-cols-2">
                  <div className="rounded-[18px] border border-slate-200 bg-white p-5 shadow-sm">
                    <div className="border-b border-dashed border-slate-300 pb-3">
                      <h3 className="text-[15px] font-semibold text-slate-900">Resumo por farmácia (origem)</h3>
                      <p className="mt-1 text-[12px] text-slate-600">Volume de excesso por farmácia.</p>
                    </div>
                    <div className="mt-4 overflow-hidden rounded-xl border border-slate-200">
                      <table className="min-w-full text-left">
                        <thead className="bg-slate-50 text-[10px] uppercase tracking-[0.14em] text-slate-500">
                          <tr>
                            <th className="px-3 py-2 font-semibold">Farmácia</th>
                            <th className="px-3 py-2 text-center font-semibold">Linhas</th>
                            <th className="px-3 py-2 text-center font-semibold">Referências</th>
                            <th className="px-3 py-2 text-center font-semibold">Unidades</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-200 text-[12px] text-slate-700">
                          {resumoOrigem.map((row) => (
                            <tr key={row.farmacia}>
                              <td className="px-3 py-1.5 font-medium text-slate-900">{row.farmacia}</td>
                              <td className="px-3 py-1.5 text-center">{row.linhas}</td>
                              <td className="px-3 py-1.5 text-center">{row.referencias}</td>
                              <td className="px-3 py-1.5 text-center">{row.unidades}</td>
                            </tr>
                          ))}
                          {snapshot.incluirTotais && resumoOrigem.length > 0 && (
                            <tr className="bg-slate-50 font-semibold text-slate-900">
                              <td className="px-3 py-2">Totais</td>
                              <td className="px-3 py-2 text-center">{sum(resumoOrigem.map((r) => r.linhas))}</td>
                              <td className="px-3 py-2 text-center">{sum(resumoOrigem.map((r) => r.referencias))}</td>
                              <td className="px-3 py-2 text-center">{sum(resumoOrigem.map((r) => r.unidades))}</td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div className="rounded-[18px] border border-slate-200 bg-white p-5 shadow-sm">
                    <div className="border-b border-dashed border-slate-300 pb-3">
                      <h3 className="text-[15px] font-semibold text-slate-900">Resumo por farmácia (destino possível)</h3>
                      <p className="mt-1 text-[12px] text-slate-600">Farmácias que poderiam absorver o excesso.</p>
                    </div>
                    <div className="mt-4 overflow-hidden rounded-xl border border-slate-200">
                      <table className="min-w-full text-left">
                        <thead className="bg-slate-50 text-[10px] uppercase tracking-[0.14em] text-slate-500">
                          <tr>
                            <th className="px-3 py-2 font-semibold">Farmácia</th>
                            <th className="px-3 py-2 text-center font-semibold">Linhas</th>
                            <th className="px-3 py-2 text-center font-semibold">Referências</th>
                            <th className="px-3 py-2 text-center font-semibold">Unidades</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-200 text-[12px] text-slate-700">
                          {resumoDestino.map((row) => (
                            <tr key={row.farmacia}>
                              <td className="px-3 py-1.5 font-medium text-slate-900">{row.farmacia}</td>
                              <td className="px-3 py-1.5 text-center">{row.linhas}</td>
                              <td className="px-3 py-1.5 text-center">{row.referencias}</td>
                              <td className="px-3 py-1.5 text-center">{row.unidades}</td>
                            </tr>
                          ))}
                          {snapshot.incluirTotais && resumoDestino.length > 0 && (
                            <tr className="bg-slate-50 font-semibold text-slate-900">
                              <td className="px-3 py-2">Totais</td>
                              <td className="px-3 py-2 text-center">{sum(resumoDestino.map((r) => r.linhas))}</td>
                              <td className="px-3 py-2 text-center">{sum(resumoDestino.map((r) => r.referencias))}</td>
                              <td className="px-3 py-2 text-center">{sum(resumoDestino.map((r) => r.unidades))}</td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>
        )}
        </>)}
      </div>
    </AppShell>
  );
}

function CompactSelect({ label, value, onChange, options, disabled = false }: { label: string; value: string; onChange: (value: string) => void; options: string[]; disabled?: boolean }) {
  return (
    <label className="block">
      <div className="mb-1 text-[11px] font-medium text-slate-500">{label}</div>
      <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} className={["h-9 w-full rounded-xl border px-3 text-[13px] font-medium outline-none transition", disabled ? "border-slate-100 bg-slate-50 text-slate-400" : "border-slate-200 bg-white text-slate-800 focus:border-emerald-300 focus:ring-4 focus:ring-emerald-100"].join(" ")}>
        {options.map((option) => (<option key={option} value={option}>{humanizeOption(option)}</option>))}
      </select>
    </label>
  );
}

function CompactInput({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string }) {
  return (
    <label className="block">
      <div className="mb-1 text-[11px] font-medium text-slate-500">{label}</div>
      <input type="text" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className="h-9 w-full rounded-xl border border-slate-200 bg-white px-3 text-[13px] font-medium text-slate-800 outline-none transition focus:border-emerald-300 focus:ring-4 focus:ring-emerald-100" />
    </label>
  );
}

function CompactDate({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="block">
      <div className="mb-1 text-[11px] font-medium text-slate-500">{label}</div>
      <input type="date" value={value} onChange={(e) => onChange(e.target.value)} className="h-9 w-full rounded-xl border border-slate-200 bg-white px-3 text-[13px] font-medium text-slate-800 outline-none transition focus:border-emerald-300 focus:ring-4 focus:ring-emerald-100" />
    </label>
  );
}

function SearchableMultiSelect({ label, options, selected, onToggle }: { label: string; options: string[]; selected: string[]; onToggle: (value: string) => void }) {
  const [query, setQuery] = useState("");
  const filteredOptions = useMemo(() => { const q = query.trim().toLowerCase(); if (!q) return options; return options.filter((option) => option.toLowerCase().includes(q)); }, [options, query]);
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium text-slate-500">{label}</div>
      <div className="rounded-xl border border-slate-200 bg-white p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Pesquisar ${label.toLowerCase()}...`} className="h-9 w-full rounded-lg border border-slate-200 bg-slate-50 pl-9 pr-3 text-[13px] text-slate-700 outline-none transition focus:border-emerald-300 focus:bg-white" />
        </div>
        <div className="mt-2 max-h-44 space-y-1 overflow-y-auto">
          {filteredOptions.map((option) => {
            const active = selected.includes(option);
            return (
              <button key={option} type="button" onClick={() => onToggle(option)} className={["flex w-full items-center justify-between rounded-lg px-2 py-2 text-left text-[12px] font-medium transition", active ? "bg-emerald-600 text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200"].join(" ")}>
                <span className="truncate">{humanizeOption(option)}</span>
                {active && <span className="ml-2 text-[11px] font-semibold">✓</span>}
              </button>
            );
          })}
          {filteredOptions.length === 0 && <div className="rounded-lg border border-dashed border-slate-200 px-3 py-3 text-[12px] text-slate-500">Sem resultados.</div>}
        </div>
      </div>
    </div>
  );
}

function FilterPill({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[12px] text-slate-700">
      {label}
      <button type="button" onClick={onRemove} className="text-slate-400 transition hover:text-slate-700"><X className="h-3 w-3" /></button>
    </span>
  );
}

function ToggleRow({ label, checked, onChange, compact = false }: { label: string; checked: boolean; onChange: (value: boolean) => void; compact?: boolean }) {
  return (
    <label className={compact ? "flex items-center gap-2.5" : "flex items-center justify-between gap-2.5"}>
      <span className="text-[13px] text-slate-700">{label}</span>
      <button type="button" onClick={() => onChange(!checked)} className={["relative h-5 w-10 rounded-full transition", checked ? "bg-emerald-500" : "bg-slate-200"].join(" ")}>
        <span className={["absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition", checked ? "left-[20px]" : "left-0.5"].join(" ")} />
      </button>
    </label>
  );
}

function ActionButton({ icon, label, primary = false, onClick }: { icon: React.ReactNode; label: string; primary?: boolean; onClick?: () => void }) {
  return (
    <button type="button" onClick={onClick} className={["inline-flex h-9 items-center gap-1.5 rounded-xl px-3 text-[13px] font-medium transition", primary ? "bg-emerald-600 text-white shadow-sm hover:bg-emerald-700" : "border border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-800"].join(" ")}>
      {icon}{label}
    </button>
  );
}

function TabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={["rounded-xl px-3 py-1.5 text-[13px] font-medium transition", active ? "bg-emerald-600 text-white" : "bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-900"].join(" ")}>
      {label}
    </button>
  );
}

function PriorityBadge({ prioridade }: { prioridade: Priority }) {
  const styles = prioridade === "alta" ? "border-rose-200 bg-rose-50 text-rose-700" : prioridade === "media" ? "border-amber-200 bg-amber-50 text-amber-700" : "border-slate-200 bg-slate-50 text-slate-700";
  return <span className={["inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold", styles].join(" ")}>{humanizeOption(prioridade)}</span>;
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">{label}</div>
      <div className="mt-1 text-sm font-semibold text-slate-900">{value}</div>
    </div>
  );
}

function sum(values: number[]) { return values.reduce((acc, value) => acc + value, 0); }
function formatDatePt(value: string) { return new Date(value).toLocaleDateString("pt-PT"); }
function humanizeOption(option: string) {
  const map: Record<string, string> = { prioridade: "Prioridade", quantidadeSugerida: "Quantidade sugerida", produto: "Produto", farmaciaOrigem: "Farmácia origem", farmaciaDestino: "Farmácia destino", alta: "Alta", media: "Média", baixa: "Baixa" };
  return map[option] ?? option;
}
