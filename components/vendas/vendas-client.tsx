"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
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

type Agrupamento =
  | "artigo"
  | "grupo"
  | "fornecedor"
  | "fabricante"
  | "categoria"
  | "farmacia";

type Ordenacao = "totalVendas" | "descricao" | "codigo" | "existencia";
type ModoVisualizacao = "tabela" | "relatorio";
type AmbitoAnalise = "farmacia" | "grupo" | "comparativo";

type SalesReportRow = {
  codigo: string;
  descricao: string;
  pvp: number;
  jan: number;
  fev: number;
  mar: number;
  abr: number;
  totalVendas: number;
  existencia: number;
  unidadesVendidas: number;
  fornecedor: string;
  fabricante: string;
  categoria: string;
  farmacia: string;
  grupo: string;
};

type AggregatedRow = {
  codigo: string;
  descricao: string;
  pvp: number;
  jan: number;
  fev: number;
  mar: number;
  abr: number;
  totalVendas: number;
  existencia: number;
  unidadesVendidas: number;
  fornecedor: string;
  fabricante: string;
  categoria: string;
  farmacia: string;
  grupo: string;
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

export function VendasClient({ initialRows }: { initialRows: SalesReportRow[] }) {
  const farmacias = Array.from(new Set(initialRows.map((r) => r.farmacia)));
  const fornecedores = Array.from(new Set(initialRows.map((r) => r.fornecedor)));
  const fabricantes = Array.from(new Set(initialRows.map((r) => r.fabricante)));
  const categorias = Array.from(new Set(initialRows.map((r) => r.categoria)));

  const [ambito, setAmbito] = useState<AmbitoAnalise>("farmacia");
  const [farmaciasSelecionadas, setFarmaciasSelecionadas] = useState<string[]>(farmacias);
  const [fornecedoresSelecionados, setFornecedoresSelecionados] = useState<string[]>([]);
  const [fabricantesSelecionados, setFabricantesSelecionados] = useState<string[]>([]);
  const [categoriasSelecionadas, setCategoriasSelecionadas] = useState<string[]>([]);
  const [artigo, setArtigo] = useState("");
  const [dataInicio, setDataInicio] = useState("2026-01-01");
  const [dataFim, setDataFim] = useState("2026-04-09");
  const [agruparPor, setAgruparPor] = useState<Agrupamento>("artigo");
  const [ordenarPor, setOrdenarPor] = useState<Ordenacao>("totalVendas");
  const [apenasComVendas, setApenasComVendas] = useState(true);
  const [apenasComStock, setApenasComStock] = useState(false);
  const [incluirTotais, setIncluirTotais] = useState(true);
  const [compararPeriodoAnterior, setCompararPeriodoAnterior] = useState(false);
  const [modoVisualizacao, setModoVisualizacao] =
    useState<ModoVisualizacao>("tabela");
  const [filtrosAbertos, setFiltrosAbertos] = useState(false);

  const baseFiltered = useMemo(() => {
    return initialRows.filter((row) => {
      if (
        fornecedoresSelecionados.length > 0 &&
        !fornecedoresSelecionados.includes(row.fornecedor)
      ) {
        return false;
      }
      if (
        fabricantesSelecionados.length > 0 &&
        !fabricantesSelecionados.includes(row.fabricante)
      ) {
        return false;
      }
      if (
        categoriasSelecionadas.length > 0 &&
        !categoriasSelecionadas.includes(row.categoria)
      ) {
        return false;
      }
      if (
        artigo.trim() &&
        !`${row.codigo} ${row.descricao}`
          .toLowerCase()
          .includes(artigo.toLowerCase())
      ) {
        return false;
      }
      if (
        farmaciasSelecionadas.length > 0 &&
        !farmaciasSelecionadas.includes(row.farmacia)
      ) {
        return false;
      }
      if (apenasComVendas && row.totalVendas <= 0) return false;
      if (apenasComStock && row.existencia <= 0) return false;
      return true;
    });
  }, [
    fornecedoresSelecionados,
    fabricantesSelecionados,
    categoriasSelecionadas,
    artigo,
    farmaciasSelecionadas,
    apenasComVendas,
    apenasComStock,
    initialRows,
  ]);

  const groupRows = useMemo<AggregatedRow[]>(() => {
    const grouped = new Map<string, SalesReportRow[]>();

    for (const row of initialRows) {
      if (
        fornecedoresSelecionados.length > 0 &&
        !fornecedoresSelecionados.includes(row.fornecedor)
      ) {
        continue;
      }
      if (
        fabricantesSelecionados.length > 0 &&
        !fabricantesSelecionados.includes(row.fabricante)
      ) {
        continue;
      }
      if (
        categoriasSelecionadas.length > 0 &&
        !categoriasSelecionadas.includes(row.categoria)
      ) {
        continue;
      }
      if (
        artigo.trim() &&
        !`${row.codigo} ${row.descricao}`
          .toLowerCase()
          .includes(artigo.toLowerCase())
      ) {
        continue;
      }
      if (
        farmaciasSelecionadas.length > 0 &&
        !farmaciasSelecionadas.includes(row.farmacia)
      ) {
        continue;
      }

      const key =
        agruparPor === "artigo"
          ? row.codigo
          : agruparPor === "grupo"
            ? row.grupo
            : agruparPor === "fornecedor"
              ? row.fornecedor
              : agruparPor === "fabricante"
                ? row.fabricante
                : agruparPor === "categoria"
                  ? row.categoria
                  : row.farmacia;

      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(row);
    }

    const aggregated = Array.from(grouped.entries()).map(([key, rows]) => {
      const first = rows[0];
      return {
        codigo: agruparPor === "artigo" ? first.codigo : key,
        descricao:
          agruparPor === "artigo"
            ? first.descricao
            : agruparPor === "grupo"
              ? key
              : agruparPor === "fornecedor"
                ? key
                : agruparPor === "fabricante"
                  ? key
                  : agruparPor === "categoria"
                    ? key
                    : key,
        pvp: first.pvp,
        jan: rows.reduce((s, r) => s + r.jan, 0),
        fev: rows.reduce((s, r) => s + r.fev, 0),
        mar: rows.reduce((s, r) => s + r.mar, 0),
        abr: rows.reduce((s, r) => s + r.abr, 0),
        totalVendas: rows.reduce((s, r) => s + r.totalVendas, 0),
        existencia: rows.reduce((s, r) => s + r.existencia, 0),
        unidadesVendidas: rows.reduce((s, r) => s + r.unidadesVendidas, 0),
        fornecedor: first.fornecedor,
        fabricante: first.fabricante,
        categoria: first.categoria,
        farmacia: first.farmacia,
        grupo: first.grupo,
      };
    });

    return aggregated.filter((row) => {
      if (apenasComVendas && row.totalVendas <= 0) return false;
      if (apenasComStock && row.existencia <= 0) return false;
      return true;
    });
  }, [
    fornecedoresSelecionados,
    fabricantesSelecionados,
    categoriasSelecionadas,
    artigo,
    agruparPor,
    farmaciasSelecionadas,
    apenasComVendas,
    apenasComStock,
    initialRows,
  ]);

  const currentRows = ambito === "grupo" ? groupRows : baseFiltered;

  const orderedRows = useMemo(() => {
    return [...currentRows].sort((a, b) => {
      switch (ordenarPor) {
        case "codigo":
          return a.codigo.localeCompare(b.codigo);
        case "descricao":
          return a.descricao.localeCompare(b.descricao);
        case "existencia":
          return b.existencia - a.existencia;
        case "totalVendas":
        default:
          return b.totalVendas - a.totalVendas;
      }
    });
  }, [currentRows, ordenarPor]);

  const resumo = useMemo(() => {
    const totalVendido = orderedRows.reduce(
      (sum, row) => sum + row.totalVendas * row.pvp,
      0
    );
    const totalUnidades = orderedRows.reduce(
      (sum, row) => sum + row.unidadesVendidas,
      0
    );
    const referencias = orderedRows.length;
    const mediaDiaria = totalUnidades / 99;

    return {
      totalVendido,
      totalUnidades,
      referencias,
      mediaDiaria,
    };
  }, [orderedRows]);

  const comparativoRows = useMemo(() => {
    return initialRows
      .filter((row) => {
        if (
          fornecedoresSelecionados.length > 0 &&
          !fornecedoresSelecionados.includes(row.fornecedor)
        ) {
          return false;
        }
        if (
          fabricantesSelecionados.length > 0 &&
          !fabricantesSelecionados.includes(row.fabricante)
        ) {
          return false;
        }
        if (
          categoriasSelecionadas.length > 0 &&
          !categoriasSelecionadas.includes(row.categoria)
        ) {
          return false;
        }
        if (
          artigo.trim() &&
          !`${row.codigo} ${row.descricao}`
            .toLowerCase()
            .includes(artigo.toLowerCase())
        ) {
          return false;
        }
        if (
          farmaciasSelecionadas.length > 0 &&
          !farmaciasSelecionadas.includes(row.farmacia)
        ) {
          return false;
        }
        if (apenasComVendas && row.totalVendas <= 0) return false;
        if (apenasComStock && row.existencia <= 0) return false;
        return true;
      })
      .sort((a, b) =>
        a.codigo === b.codigo
          ? a.farmacia.localeCompare(b.farmacia)
          : a.codigo.localeCompare(b.codigo)
      );
  }, [
    fornecedoresSelecionados,
    fabricantesSelecionados,
    categoriasSelecionadas,
    artigo,
    farmaciasSelecionadas,
    apenasComVendas,
    apenasComStock,
    initialRows,
  ]);

  const reportByFarmacia = useMemo(() => {
    const grouped = new Map<string, SalesReportRow[]>();

    for (const row of initialRows) {
      if (
        fornecedoresSelecionados.length > 0 &&
        !fornecedoresSelecionados.includes(row.fornecedor)
      ) {
        continue;
      }
      if (
        fabricantesSelecionados.length > 0 &&
        !fabricantesSelecionados.includes(row.fabricante)
      ) {
        continue;
      }
      if (
        categoriasSelecionadas.length > 0 &&
        !categoriasSelecionadas.includes(row.categoria)
      ) {
        continue;
      }
      if (
        artigo.trim() &&
        !`${row.codigo} ${row.descricao}`
          .toLowerCase()
          .includes(artigo.toLowerCase())
      ) {
        continue;
      }
      if (
        farmaciasSelecionadas.length > 0 &&
        !farmaciasSelecionadas.includes(row.farmacia)
      ) {
        continue;
      }
      if (apenasComVendas && row.totalVendas <= 0) continue;
      if (apenasComStock && row.existencia <= 0) continue;

      if (!grouped.has(row.farmacia)) grouped.set(row.farmacia, []);
      grouped.get(row.farmacia)!.push(row);
    }

    return Array.from(grouped.entries()).map(([farmacia, rows]) => ({
      farmacia,
      jan: sum(rows.map((r) => r.jan)),
      fev: sum(rows.map((r) => r.fev)),
      mar: sum(rows.map((r) => r.mar)),
      abr: sum(rows.map((r) => r.abr)),
      totalVendas: sum(rows.map((r) => r.totalVendas)),
      existencia: sum(rows.map((r) => r.existencia)),
      totalValor: rows.reduce((acc, row) => acc + row.totalVendas * row.pvp, 0),
    }));
  }, [
    fornecedoresSelecionados,
    fabricantesSelecionados,
    categoriasSelecionadas,
    artigo,
    farmaciasSelecionadas,
    apenasComVendas,
    apenasComStock,
    initialRows,
  ]);

  const filtrosAtivosCount =
    farmaciasSelecionadas.length +
    fornecedoresSelecionados.length +
    fabricantesSelecionados.length +
    categoriasSelecionadas.length;

  const showFarmaciaColumnInReport =
    ambito === "comparativo" || farmaciasSelecionadas.length !== 1;

  return (
    <AppShell>
      <div className="space-y-3">
        <section className="space-y-0.5">
          <div className="text-xs font-medium text-slate-500">
            Análise / Relatório de Vendas
          </div>
          <h1 className="text-[28px] font-semibold tracking-tight text-slate-900">
            Relatório de Vendas
          </h1>
          <p className="text-[13px] text-slate-600">
            Consulta por farmácia, grupo ou comparativo entre farmácias.
          </p>
        </section>

        <section className="rounded-[20px] border border-white/70 bg-white/84 px-4 py-3 shadow-[0_8px_18px_rgba(15,23,42,0.04)] backdrop-blur-xl">
          <div className="grid gap-2.5 xl:grid-cols-[0.9fr_1fr_0.9fr_0.9fr_0.9fr_auto]">
            <CompactSelect
              label="Âmbito da análise"
              value={ambito}
              onChange={(value) => setAmbito(value as AmbitoAnalise)}
              options={["farmacia", "grupo", "comparativo"]}
            />

            <CompactInput
              label="Artigo"
              value={artigo}
              onChange={setArtigo}
              placeholder="Código ou descrição"
            />

            <CompactDate
              label="Data início"
              value={dataInicio}
              onChange={setDataInicio}
            />

            <CompactDate label="Data fim" value={dataFim} onChange={setDataFim} />

            <CompactSelect
              label="Agrupar por"
              value={agruparPor}
              onChange={(value) => setAgruparPor(value as Agrupamento)}
              options={[
                "artigo",
                "grupo",
                "fornecedor",
                "fabricante",
                "categoria",
                "farmacia",
              ]}
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

          <div className="mt-2.5 grid gap-2.5 xl:grid-cols-[0.9fr_auto]">
            <CompactSelect
              label="Ordenar por"
              value={ordenarPor}
              onChange={(value) => setOrdenarPor(value as Ordenacao)}
              options={["totalVendas", "descricao", "codigo", "existencia"]}
            />

            <div className="flex items-end gap-2">
              <ActionButton
                icon={<Eye className="h-3.5 w-3.5" />}
                label="Ver em ecrã"
              />
              <ActionButton
                icon={<Printer className="h-3.5 w-3.5" />}
                label="Imprimir"
              />
              <ActionButton
                icon={<FileText className="h-3.5 w-3.5" />}
                label="PDF"
              />
              <ActionButton
                icon={<Download className="h-3.5 w-3.5" />}
                label="Excel"
              />
              <ActionButton
                icon={<Mail className="h-3.5 w-3.5" />}
                label="Email"
                primary
              />
            </div>
          </div>

          {filtrosAbertos && (
            <div className="mt-3 rounded-2xl border border-slate-200 bg-white p-3">
              <div className="grid gap-3 xl:grid-cols-4">
                <SearchableMultiSelect
                  label="Farmácia"
                  options={farmacias}
                  selected={farmaciasSelecionadas}
                  onToggle={(value) =>
                    toggleValue(value, farmaciasSelecionadas, setFarmaciasSelecionadas)
                  }
                />
                <SearchableMultiSelect
                  label="Fornecedor"
                  options={fornecedores}
                  selected={fornecedoresSelecionados}
                  onToggle={(value) =>
                    toggleValue(
                      value,
                      fornecedoresSelecionados,
                      setFornecedoresSelecionados
                    )
                  }
                />
                <SearchableMultiSelect
                  label="Fabricante"
                  options={fabricantes}
                  selected={fabricantesSelecionados}
                  onToggle={(value) =>
                    toggleValue(
                      value,
                      fabricantesSelecionados,
                      setFabricantesSelecionados
                    )
                  }
                />
                <SearchableMultiSelect
                  label="Categoria"
                  options={categorias}
                  selected={categoriasSelecionadas}
                  onToggle={(value) =>
                    toggleValue(
                      value,
                      categoriasSelecionadas,
                      setCategoriasSelecionadas
                    )
                  }
                />
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                {farmaciasSelecionadas.map((item) => (
                  <FilterPill
                    key={`farmacia-${item}`}
                    label={item}
                    onRemove={() =>
                      setFarmaciasSelecionadas((prev) =>
                        prev.filter((v) => v !== item)
                      )
                    }
                  />
                ))}
                {fornecedoresSelecionados.map((item) => (
                  <FilterPill
                    key={`fornecedor-${item}`}
                    label={item}
                    onRemove={() =>
                      setFornecedoresSelecionados((prev) =>
                        prev.filter((v) => v !== item)
                      )
                    }
                  />
                ))}
                {fabricantesSelecionados.map((item) => (
                  <FilterPill
                    key={`fabricante-${item}`}
                    label={item}
                    onRemove={() =>
                      setFabricantesSelecionados((prev) =>
                        prev.filter((v) => v !== item)
                      )
                    }
                  />
                ))}
                {categoriasSelecionadas.map((item) => (
                  <FilterPill
                    key={`categoria-${item}`}
                    label={item}
                    onRemove={() =>
                      setCategoriasSelecionadas((prev) =>
                        prev.filter((v) => v !== item)
                      )
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
              label="Apenas com vendas"
              checked={apenasComVendas}
              onChange={setApenasComVendas}
              compact
            />
            <ToggleRow
              label="Apenas com stock"
              checked={apenasComStock}
              onChange={setApenasComStock}
              compact
            />
            <ToggleRow
              label="Incluir totais"
              checked={incluirTotais}
              onChange={setIncluirTotais}
              compact
            />
            <ToggleRow
              label="Comparar período anterior"
              checked={compararPeriodoAnterior}
              onChange={setCompararPeriodoAnterior}
              compact
            />

            <div className="ml-auto flex flex-wrap items-center gap-3 text-[13px] text-slate-600">
              <span>
                <span className="font-semibold text-slate-900">
                  {resumo.referencias}
                </span>{" "}
                linhas
              </span>
              <span>
                <span className="font-semibold text-slate-900">
                  {resumo.totalUnidades.toLocaleString("pt-PT")}
                </span>{" "}
                unidades
              </span>
              <span>
                <span className="font-semibold text-slate-900">
                  {resumo.totalVendido.toLocaleString("pt-PT", {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}{" "}
                  €
                </span>
              </span>
              <span>
                média diária{" "}
                <span className="font-semibold text-slate-900">
                  {resumo.mediaDiaria.toLocaleString("pt-PT", {
                    minimumFractionDigits: 1,
                    maximumFractionDigits: 1,
                  })}
                </span>
              </span>
            </div>
          </div>
        </section>

        <section className="rounded-[20px] border border-white/70 bg-white/92 px-3 py-2 shadow-[0_8px_18px_rgba(15,23,42,0.04)] backdrop-blur-xl">
          <div className="flex items-center gap-2">
            <TabButton
              label="Tabela"
              active={modoVisualizacao === "tabela"}
              onClick={() => setModoVisualizacao("tabela")}
            />
            <TabButton
              label="Relatório"
              active={modoVisualizacao === "relatorio"}
              onClick={() => setModoVisualizacao("relatorio")}
            />
          </div>
        </section>

        {modoVisualizacao === "tabela" ? (
          <section className="overflow-hidden rounded-[20px] border border-white/70 bg-white/84 shadow-[0_8px_18px_rgba(15,23,42,0.04)] backdrop-blur-xl">
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
              <div>
                <h2 className="text-sm font-semibold text-slate-900">
                  {ambito === "farmacia" && "Vista por farmácia"}
                  {ambito === "grupo" && "Vista consolidada"}
                  {ambito === "comparativo" && "Vista comparativa"}
                </h2>
                <p className="mt-0.5 text-[12px] text-slate-500">
                  {ambito === "farmacia" && "Leitura da(s) farmácia(s) selecionada(s)"}
                  {ambito === "grupo" &&
                    "Consolidação do grupo segundo o agrupamento escolhido"}
                  {ambito === "comparativo" &&
                    "Comparação da mesma referência entre farmácias"}
                </p>
              </div>

              <div className="rounded-xl border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] text-slate-500">
                {humanizeOption(agruparPor)} · {humanizeOption(ordenarPor)}
              </div>
            </div>

            <div className="max-h-[calc(100vh-360px)] min-h-[420px] overflow-y-auto">
              {ambito !== "comparativo" ? (
                <table className="min-w-full table-fixed text-left">
                  <colgroup>
                    <col className="w-[10%]" />
                    <col className="w-[30%]" />
                    <col className="w-[8%]" />
                    <col className="w-[7%]" />
                    <col className="w-[7%]" />
                    <col className="w-[7%]" />
                    <col className="w-[7%]" />
                    <col className="w-[10%]" />
                    <col className="w-[8%]" />
                  </colgroup>

                  <thead className="sticky top-0 z-10 border-b border-slate-100 bg-slate-50/95 text-[10px] uppercase tracking-[0.14em] text-slate-500 backdrop-blur">
                    <tr>
                      <th className="px-4 py-2.5 font-semibold">Código</th>
                      <th className="px-3 py-2.5 font-semibold">Descrição</th>
                      <th className="px-2 py-2.5 text-center font-semibold">
                        PVP
                      </th>
                      <th className="px-2 py-2.5 text-center font-semibold">
                        Jan
                      </th>
                      <th className="px-2 py-2.5 text-center font-semibold">
                        Fev
                      </th>
                      <th className="px-2 py-2.5 text-center font-semibold">
                        Mar
                      </th>
                      <th className="px-2 py-2.5 text-center font-semibold">
                        Abr
                      </th>
                      <th className="px-2 py-2.5 text-center font-semibold">
                        Tot. Ven.
                      </th>
                      <th className="px-2 py-2.5 text-center font-semibold">
                        Exist.
                      </th>
                    </tr>
                  </thead>

                  <tbody className="divide-y divide-slate-100 text-[13px] text-slate-700">
                    {orderedRows.map((row, index) => (
                      <tr
                        key={`${row.codigo}-${row.descricao}-${index}`}
                        className="transition hover:bg-slate-50/70"
                      >
                        <td className="px-4 py-2.5 align-top">
                          <span className="font-medium text-slate-800">
                            {row.codigo}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 align-top">
                          <div className="space-y-0.5">
                            <Link
                              href={`/stock/artigo/${row.codigo}`}
                              className="block font-semibold leading-5 text-slate-900 transition hover:text-emerald-600"
                            >
                              {row.descricao}
                            </Link>
                            <div className="text-[12px] text-slate-500">
                              {ambito === "farmacia"
                                ? `${row.fornecedor} · ${row.farmacia}`
                                : `${row.fornecedor} · ${row.categoria}`}
                            </div>
                          </div>
                        </td>
                        <td className="px-2 py-2.5 text-center">
                          {formatMoney(row.pvp)} €
                        </td>
                        <td className="px-2 py-2.5 text-center">{row.jan}</td>
                        <td className="px-2 py-2.5 text-center">{row.fev}</td>
                        <td className="px-2 py-2.5 text-center">{row.mar}</td>
                        <td className="px-2 py-2.5 text-center">{row.abr}</td>
                        <td className="px-2 py-2.5 text-center font-semibold text-slate-900">
                          {row.totalVendas}
                        </td>
                        <td className="px-2 py-2.5 text-center">
                          {row.existencia}
                        </td>
                      </tr>
                    ))}

                    {incluirTotais && orderedRows.length > 0 && (
                      <tr className="bg-slate-50/70 font-semibold text-slate-900">
                        <td className="px-4 py-2.5" colSpan={3}>
                          Totais
                        </td>
                        <td className="px-2 py-2.5 text-center">
                          {sum(orderedRows.map((r) => r.jan))}
                        </td>
                        <td className="px-2 py-2.5 text-center">
                          {sum(orderedRows.map((r) => r.fev))}
                        </td>
                        <td className="px-2 py-2.5 text-center">
                          {sum(orderedRows.map((r) => r.mar))}
                        </td>
                        <td className="px-2 py-2.5 text-center">
                          {sum(orderedRows.map((r) => r.abr))}
                        </td>
                        <td className="px-2 py-2.5 text-center">
                          {sum(orderedRows.map((r) => r.totalVendas))}
                        </td>
                        <td className="px-2 py-2.5 text-center">
                          {sum(orderedRows.map((r) => r.existencia))}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              ) : (
                <table className="min-w-full table-fixed text-left">
                  <colgroup>
                    <col className="w-[12%]" />
                    <col className="w-[28%]" />
                    <col className="w-[12%]" />
                    <col className="w-[8%]" />
                    <col className="w-[8%]" />
                    <col className="w-[8%]" />
                    <col className="w-[8%]" />
                    <col className="w-[10%]" />
                    <col className="w-[6%]" />
                  </colgroup>

                  <thead className="sticky top-0 z-10 border-b border-slate-100 bg-slate-50/95 text-[10px] uppercase tracking-[0.14em] text-slate-500 backdrop-blur">
                    <tr>
                      <th className="px-4 py-2.5 font-semibold">Código</th>
                      <th className="px-3 py-2.5 font-semibold">Descrição</th>
                      <th className="px-3 py-2.5 font-semibold">Farmácia</th>
                      <th className="px-2 py-2.5 text-center font-semibold">
                        Jan
                      </th>
                      <th className="px-2 py-2.5 text-center font-semibold">
                        Fev
                      </th>
                      <th className="px-2 py-2.5 text-center font-semibold">
                        Mar
                      </th>
                      <th className="px-2 py-2.5 text-center font-semibold">
                        Abr
                      </th>
                      <th className="px-2 py-2.5 text-center font-semibold">
                        Tot. Ven.
                      </th>
                      <th className="px-2 py-2.5 text-center font-semibold">
                        Exist.
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-[13px] text-slate-700">
                    {comparativoRows.map((row) => (
                      <tr
                        key={`${row.codigo}-${row.farmacia}`}
                        className="transition hover:bg-slate-50/70"
                      >
                        <td className="px-4 py-2.5">{row.codigo}</td>
                        <td className="px-3 py-2.5">
                          <Link
                            href={`/stock/artigo/${row.codigo}`}
                            className="font-semibold text-slate-900 transition hover:text-emerald-600"
                          >
                            {row.descricao}
                          </Link>
                        </td>
                        <td className="px-3 py-2.5">{row.farmacia}</td>
                        <td className="px-2 py-2.5 text-center">{row.jan}</td>
                        <td className="px-2 py-2.5 text-center">{row.fev}</td>
                        <td className="px-2 py-2.5 text-center">{row.mar}</td>
                        <td className="px-2 py-2.5 text-center">{row.abr}</td>
                        <td className="px-2 py-2.5 text-center font-semibold text-slate-900">
                          {row.totalVendas}
                        </td>
                        <td className="px-2 py-2.5 text-center">
                          {row.existencia}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        ) : (
          <section className="overflow-hidden rounded-[20px] border border-white/70 bg-white/84 shadow-[0_8px_18px_rgba(15,23,42,0.04)] backdrop-blur-xl">
            <div className="border-b border-slate-100 px-4 py-3">
              <h2 className="text-sm font-semibold text-slate-900">
                Vista relatório
              </h2>
              <p className="mt-0.5 text-[12px] text-slate-500">
                Estrutura formal preparada para impressão e PDF
              </p>
            </div>

            <div className="max-h-[calc(100vh-360px)] overflow-y-auto p-4">
              <div className="mx-auto max-w-[1200px] space-y-4">
                <div className="rounded-[18px] border border-slate-200 bg-white p-5 shadow-sm">
                  <div className="border-b border-dashed border-slate-300 pb-3">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <div className="text-[11px] text-slate-500">
                          Farmácia Silveirense, Lda. (NIF: 507529930)
                        </div>
                        <div className="mt-2 text-[15px] font-semibold text-slate-900">
                          Mapa de Evolução de Vendas -{" "}
                          {ambito === "farmacia"
                            ? "Farmácia"
                            : ambito === "grupo"
                              ? "Grupo"
                              : "Comparativo"}
                        </div>
                        <div className="mt-1 text-[12px] text-slate-600">
                          Período: De {formatDatePt(dataInicio)} até{" "}
                          {formatDatePt(dataFim)}
                        </div>
                      </div>

                      <div className="text-right text-[12px] text-slate-500">
                        <div>{formatDatePt("2026-04-09")}</div>
                        <div className="mt-1">Moeda: Euro</div>
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 overflow-hidden rounded-xl border border-slate-200">
                    {ambito === "comparativo" ? (
                      <table className="min-w-full text-left">
                        <thead className="bg-slate-50 text-[10px] uppercase tracking-[0.14em] text-slate-500">
                          <tr>
                            <th className="px-3 py-2 font-semibold">Código</th>
                            <th className="px-3 py-2 font-semibold">Descrição</th>
                            <th className="px-3 py-2 font-semibold">Farmácia</th>
                            <th className="px-3 py-2 text-center font-semibold">Jan</th>
                            <th className="px-3 py-2 text-center font-semibold">Fev</th>
                            <th className="px-3 py-2 text-center font-semibold">Mar</th>
                            <th className="px-3 py-2 text-center font-semibold">Abr</th>
                            <th className="px-3 py-2 text-center font-semibold">Tot. Ven.</th>
                            <th className="px-3 py-2 text-center font-semibold">Exist.</th>
                          </tr>
                        </thead>

                        <tbody className="divide-y divide-slate-200 text-[12px] text-slate-700">
                          {comparativoRows.map((row, index) => (
                            <tr key={`report-comp-${row.codigo}-${row.farmacia}-${index}`}>
                              <td className="whitespace-nowrap px-3 py-1.5">{row.codigo}</td>
                              <td className="px-3 py-1.5">{row.descricao}</td>
                              <td className="px-3 py-1.5">{row.farmacia}</td>
                              <td className="px-3 py-1.5 text-center">{row.jan}</td>
                              <td className="px-3 py-1.5 text-center">{row.fev}</td>
                              <td className="px-3 py-1.5 text-center">{row.mar}</td>
                              <td className="px-3 py-1.5 text-center">{row.abr}</td>
                              <td className="px-3 py-1.5 text-center">{row.totalVendas}</td>
                              <td className="px-3 py-1.5 text-center">{row.existencia}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <table className="min-w-full text-left">
                        <thead className="bg-slate-50 text-[10px] uppercase tracking-[0.14em] text-slate-500">
                          <tr>
                            <th className="px-3 py-2 font-semibold">Código</th>
                            <th className="px-3 py-2 font-semibold">Descrição</th>

                            {showFarmaciaColumnInReport && (
                              <th className="px-3 py-2 font-semibold">Farmácia</th>
                            )}

                            <th className="px-3 py-2 text-center font-semibold">Jan</th>
                            <th className="px-3 py-2 text-center font-semibold">Fev</th>
                            <th className="px-3 py-2 text-center font-semibold">Mar</th>
                            <th className="px-3 py-2 text-center font-semibold">Abr</th>
                            <th className="px-3 py-2 text-center font-semibold">Tot. Ven.</th>
                            <th className="px-3 py-2 text-center font-semibold">Exist.</th>
                          </tr>
                        </thead>

                        <tbody className="divide-y divide-slate-200 text-[12px] text-slate-700">
                          {orderedRows.map((row, index) => (
                            <tr key={`report-main-${row.codigo}-${row.farmacia}-${index}`}>
                              <td className="whitespace-nowrap px-3 py-1.5">{row.codigo}</td>
                              <td className="px-3 py-1.5">{row.descricao}</td>

                              {showFarmaciaColumnInReport && (
                                <td className="px-3 py-1.5">{row.farmacia}</td>
                              )}

                              <td className="px-3 py-1.5 text-center">{row.jan}</td>
                              <td className="px-3 py-1.5 text-center">{row.fev}</td>
                              <td className="px-3 py-1.5 text-center">{row.mar}</td>
                              <td className="px-3 py-1.5 text-center">{row.abr}</td>
                              <td className="px-3 py-1.5 text-center">{row.totalVendas}</td>
                              <td className="px-3 py-1.5 text-center">{row.existencia}</td>
                            </tr>
                          ))}

                          {incluirTotais && orderedRows.length > 0 && (
                            <tr className="bg-slate-50 font-semibold text-slate-900">
                              <td
                                className="px-3 py-2"
                                colSpan={showFarmaciaColumnInReport ? 3 : 2}
                              >
                                Totais
                              </td>
                              <td className="px-3 py-2 text-center">
                                {sum(orderedRows.map((r) => r.jan))}
                              </td>
                              <td className="px-3 py-2 text-center">
                                {sum(orderedRows.map((r) => r.fev))}
                              </td>
                              <td className="px-3 py-2 text-center">
                                {sum(orderedRows.map((r) => r.mar))}
                              </td>
                              <td className="px-3 py-2 text-center">
                                {sum(orderedRows.map((r) => r.abr))}
                              </td>
                              <td className="px-3 py-2 text-center">
                                {sum(orderedRows.map((r) => r.totalVendas))}
                              </td>
                              <td className="px-3 py-2 text-center">
                                {sum(orderedRows.map((r) => r.existencia))}
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    )}
                  </div>

                  <div className="mt-4 flex items-center justify-between text-[11px] text-slate-400">
                    <div>SoftReis Informática</div>
                    <div>Página 1 de 1</div>
                  </div>
                </div>

                {ambito === "grupo" && reportByFarmacia.length > 0 && (
                  <div className="rounded-[18px] border border-slate-200 bg-white p-5 shadow-sm">
                    <div className="border-b border-dashed border-slate-300 pb-3">
                      <h3 className="text-[15px] font-semibold text-slate-900">
                        Distribuição por farmácia
                      </h3>
                      <p className="mt-1 text-[12px] text-slate-600">
                        Leitura do total consolidado repartido por farmácia.
                      </p>
                    </div>

                    <div className="mt-4 overflow-hidden rounded-xl border border-slate-200">
                      <table className="min-w-full text-left">
                        <thead className="bg-slate-50 text-[10px] uppercase tracking-[0.14em] text-slate-500">
                          <tr>
                            <th className="px-3 py-2 font-semibold">Farmácia</th>
                            <th className="px-3 py-2 text-center font-semibold">Jan</th>
                            <th className="px-3 py-2 text-center font-semibold">Fev</th>
                            <th className="px-3 py-2 text-center font-semibold">Mar</th>
                            <th className="px-3 py-2 text-center font-semibold">Abr</th>
                            <th className="px-3 py-2 text-center font-semibold">Tot. Ven.</th>
                            <th className="px-3 py-2 text-center font-semibold">Exist.</th>
                            <th className="px-3 py-2 text-center font-semibold">Valor</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-200 text-[12px] text-slate-700">
                          {reportByFarmacia.map((row) => (
                            <tr key={row.farmacia}>
                              <td className="px-3 py-1.5 font-medium text-slate-900">
                                {row.farmacia}
                              </td>
                              <td className="px-3 py-1.5 text-center">{row.jan}</td>
                              <td className="px-3 py-1.5 text-center">{row.fev}</td>
                              <td className="px-3 py-1.5 text-center">{row.mar}</td>
                              <td className="px-3 py-1.5 text-center">{row.abr}</td>
                              <td className="px-3 py-1.5 text-center">{row.totalVendas}</td>
                              <td className="px-3 py-1.5 text-center">{row.existencia}</td>
                              <td className="px-3 py-1.5 text-center">
                                {row.totalValor.toLocaleString("pt-PT", {
                                  minimumFractionDigits: 2,
                                  maximumFractionDigits: 2,
                                })}{" "}
                                €
                              </td>
                            </tr>
                          ))}

                          {incluirTotais && (
                            <tr className="bg-slate-50 font-semibold text-slate-900">
                              <td className="px-3 py-2">Totais</td>
                              <td className="px-3 py-2 text-center">
                                {sum(reportByFarmacia.map((r) => r.jan))}
                              </td>
                              <td className="px-3 py-2 text-center">
                                {sum(reportByFarmacia.map((r) => r.fev))}
                              </td>
                              <td className="px-3 py-2 text-center">
                                {sum(reportByFarmacia.map((r) => r.mar))}
                              </td>
                              <td className="px-3 py-2 text-center">
                                {sum(reportByFarmacia.map((r) => r.abr))}
                              </td>
                              <td className="px-3 py-2 text-center">
                                {sum(reportByFarmacia.map((r) => r.totalVendas))}
                              </td>
                              <td className="px-3 py-2 text-center">
                                {sum(reportByFarmacia.map((r) => r.existencia))}
                              </td>
                              <td className="px-3 py-2 text-center">
                                {reportByFarmacia
                                  .reduce((acc, r) => acc + r.totalValor, 0)
                                  .toLocaleString("pt-PT", {
                                    minimumFractionDigits: 2,
                                    maximumFractionDigits: 2,
                                  })}{" "}
                                €
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </section>
        )}
      </div>
    </AppShell>
  );
}

function CompactSelect({
  label,
  value,
  onChange,
  options,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
  disabled?: boolean;
}) {
  return (
    <label className="block">
      <div className="mb-1 text-[11px] font-medium text-slate-500">{label}</div>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={[
          "h-9 w-full rounded-xl border px-3 text-[13px] font-medium outline-none transition",
          disabled
            ? "border-slate-100 bg-slate-50 text-slate-400"
            : "border-slate-200 bg-white text-slate-800 focus:border-emerald-300 focus:ring-4 focus:ring-emerald-100",
        ].join(" ")}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {humanizeOption(option)}
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
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <div className="mb-1 text-[11px] font-medium text-slate-500">{label}</div>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-full rounded-xl border border-slate-200 bg-white px-3 text-[13px] font-medium text-slate-800 outline-none transition focus:border-emerald-300 focus:ring-4 focus:ring-emerald-100"
      />
    </label>
  );
}

function CompactDate({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <div className="mb-1 text-[11px] font-medium text-slate-500">{label}</div>
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-full rounded-xl border border-slate-200 bg-white px-3 text-[13px] font-medium text-slate-800 outline-none transition focus:border-emerald-300 focus:ring-4 focus:ring-emerald-100"
      />
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
    <label
      className={
        compact
          ? "flex items-center gap-2.5"
          : "flex items-center justify-between gap-2.5"
      }
    >
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

function TabButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={[
        "rounded-xl px-3 py-1.5 text-[13px] font-medium transition",
        active
          ? "bg-emerald-600 text-white"
          : "bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-900",
      ].join(" ")}
    >
      {label}
    </button>
  );
}

function sum(values: number[]) {
  return values.reduce((acc, value) => acc + value, 0);
}

function formatMoney(value: number) {
  return value.toLocaleString("pt-PT", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatDatePt(value: string) {
  const date = new Date(value);
  return date.toLocaleDateString("pt-PT");
}

function humanizeOption(option: string) {
  const map: Record<string, string> = {
    totalVendas: "Total vendas",
    descricao: "Descrição",
    codigo: "Código",
    existencia: "Existência",
    artigo: "Artigo",
    grupo: "Grupo",
    fornecedor: "Fornecedor",
    fabricante: "Fabricante",
    categoria: "Categoria",
    farmacia: "Farmácia",
    comparativo: "Comparativo",
  };

  return map[option] ?? option;
}
