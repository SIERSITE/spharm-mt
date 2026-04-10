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

type ModoVisualizacao = "tabela" | "relatorio";
type Ordenacao = "produto" | "cnp" | "fabricante" | "atc" | "pvp";

type CatalogRow = {
  cnp: string;
  produto: string;
  fabricante: string;
  principioAtivo: string;
  atc: string;
  categoria: string;
  formaFarmaceutica: string;
  dosagem: string;
  embalagem: string;
  pvp: number;
  estado: "ativo" | "inativo";
};

const mockRows: CatalogRow[] = [
  {
    cnp: "5440987",
    produto: "BEN-U-RON COMP 1 G X 18",
    fabricante: "Bene",
    principioAtivo: "Paracetamol",
    atc: "N02BE01",
    categoria: "Analgésicos",
    formaFarmaceutica: "Comprimido",
    dosagem: "1 g",
    embalagem: "18 un.",
    pvp: 3.09,
    estado: "ativo",
  },
  {
    cnp: "2401180",
    produto: "Nebilet Comp 5 mg x 28",
    fabricante: "Menarini",
    principioAtivo: "Nebivolol",
    atc: "C07AB12",
    categoria: "Cardiovascular",
    formaFarmaceutica: "Comprimido",
    dosagem: "5 mg",
    embalagem: "28 un.",
    pvp: 11.7,
    estado: "ativo",
  },
  {
    cnp: "5674239",
    produto: "Skudexa 75 mg + 25 mg x 20",
    fabricante: "Menarini",
    principioAtivo: "Dexketoprofeno + Tramadol",
    atc: "N02AJ14",
    categoria: "Analgésicos",
    formaFarmaceutica: "Comprimido revestido",
    dosagem: "75 mg + 25 mg",
    embalagem: "20 un.",
    pvp: 18.5,
    estado: "ativo",
  },
  {
    cnp: "1124509",
    produto: "Brufen 600 mg x 20",
    fabricante: "Abbott",
    principioAtivo: "Ibuprofeno",
    atc: "M01AE01",
    categoria: "Anti-inflamatórios",
    formaFarmaceutica: "Comprimido",
    dosagem: "600 mg",
    embalagem: "20 un.",
    pvp: 6.85,
    estado: "ativo",
  },
  {
    cnp: "9988123",
    produto: "Zyrtec 10 mg x 20",
    fabricante: "UCB",
    principioAtivo: "Cetirizina",
    atc: "R06AE07",
    categoria: "Alergias",
    formaFarmaceutica: "Comprimido revestido",
    dosagem: "10 mg",
    embalagem: "20 un.",
    pvp: 8.4,
    estado: "ativo",
  },
  {
    cnp: "7788001",
    produto: "Daflon 500 mg x 60",
    fabricante: "Servier",
    principioAtivo: "Diosmina + Hesperidina",
    atc: "C05CA53",
    categoria: "Circulação",
    formaFarmaceutica: "Comprimido revestido",
    dosagem: "500 mg",
    embalagem: "60 un.",
    pvp: 14.9,
    estado: "inativo",
  },
];

function toggleValue(
  value: string,
  selected: string[],
  setter: React.Dispatch<React.SetStateAction<string[]>>
) {
  setter((prev) =>
    prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]
  );
}

export default function CatalogoPage() {
  const fabricantes = Array.from(new Set(mockRows.map((r) => r.fabricante)));
  const atcs = Array.from(new Set(mockRows.map((r) => r.atc)));
  const categorias = Array.from(new Set(mockRows.map((r) => r.categoria)));
  const formas = Array.from(new Set(mockRows.map((r) => r.formaFarmaceutica)));
  const estados = ["ativo", "inativo"];

  const [pesquisa, setPesquisa] = useState("");
  const [fabricantesSelecionados, setFabricantesSelecionados] = useState<string[]>([]);
  const [atcsSelecionados, setAtcsSelecionados] = useState<string[]>([]);
  const [categoriasSelecionadas, setCategoriasSelecionadas] = useState<string[]>([]);
  const [formasSelecionadas, setFormasSelecionadas] = useState<string[]>([]);
  const [estadosSelecionados, setEstadosSelecionados] = useState<string[]>(["ativo"]);
  const [ordenarPor, setOrdenarPor] = useState<Ordenacao>("produto");
  const [apenasComPvp, setApenasComPvp] = useState(true);
  const [apenasAtivos, setApenasAtivos] = useState(true);
  const [modoVisualizacao, setModoVisualizacao] =
    useState<ModoVisualizacao>("tabela");
  const [filtrosAbertos, setFiltrosAbertos] = useState(false);

  const filtrosAtivosCount =
    fabricantesSelecionados.length +
    atcsSelecionados.length +
    categoriasSelecionadas.length +
    formasSelecionadas.length +
    estadosSelecionados.length;

  const filteredRows = useMemo(() => {
    return mockRows.filter((row) => {
      if (
        fabricantesSelecionados.length > 0 &&
        !fabricantesSelecionados.includes(row.fabricante)
      ) {
        return false;
      }

      if (atcsSelecionados.length > 0 && !atcsSelecionados.includes(row.atc)) {
        return false;
      }

      if (
        categoriasSelecionadas.length > 0 &&
        !categoriasSelecionadas.includes(row.categoria)
      ) {
        return false;
      }

      if (
        formasSelecionadas.length > 0 &&
        !formasSelecionadas.includes(row.formaFarmaceutica)
      ) {
        return false;
      }

      if (
        estadosSelecionados.length > 0 &&
        !estadosSelecionados.includes(row.estado)
      ) {
        return false;
      }

      if (
        pesquisa.trim() &&
        !`${row.cnp} ${row.produto} ${row.principioAtivo} ${row.fabricante} ${row.atc}`
          .toLowerCase()
          .includes(pesquisa.toLowerCase())
      ) {
        return false;
      }

      if (apenasComPvp && row.pvp <= 0) return false;
      if (apenasAtivos && row.estado !== "ativo") return false;

      return true;
    });
  }, [
    fabricantesSelecionados,
    atcsSelecionados,
    categoriasSelecionadas,
    formasSelecionadas,
    estadosSelecionados,
    pesquisa,
    apenasComPvp,
    apenasAtivos,
  ]);

  const orderedRows = useMemo(() => {
    return [...filteredRows].sort((a, b) => {
      switch (ordenarPor) {
        case "cnp":
          return a.cnp.localeCompare(b.cnp);
        case "fabricante":
          return a.fabricante.localeCompare(b.fabricante);
        case "atc":
          return a.atc.localeCompare(b.atc);
        case "pvp":
          return b.pvp - a.pvp;
        case "produto":
        default:
          return a.produto.localeCompare(b.produto);
      }
    });
  }, [filteredRows, ordenarPor]);

  const resumo = useMemo(() => {
    return {
      linhas: orderedRows.length,
      fabricantes: new Set(orderedRows.map((row) => row.fabricante)).size,
      categorias: new Set(orderedRows.map((row) => row.categoria)).size,
      ativos: orderedRows.filter((row) => row.estado === "ativo").length,
    };
  }, [orderedRows]);

  return (
    <AppShell>
      <div className="space-y-3">
        <section className="space-y-0.5">
          <div className="text-xs font-medium text-slate-500">
            Catálogo / Master data
          </div>
          <h1 className="text-[28px] font-semibold tracking-tight text-slate-900">
            Catálogo
          </h1>
          <p className="text-[13px] text-slate-600">
            Visão mestre do produto, sem lógica operacional por farmácia.
          </p>
        </section>

        <section className="rounded-[20px] border border-white/70 bg-white/84 px-4 py-3 shadow-[0_8px_18px_rgba(15,23,42,0.04)] backdrop-blur-xl">
          <div className="grid gap-2.5 xl:grid-cols-[1fr_0.8fr_auto]">
            <CompactInput
              label="Pesquisa"
              value={pesquisa}
              onChange={setPesquisa}
              placeholder="CNP, nome, princípio ativo, fabricante ou ATC"
            />

            <CompactSelect
              label="Ordenar por"
              value={ordenarPor}
              onChange={(value) => setOrdenarPor(value as Ordenacao)}
              options={["produto", "cnp", "fabricante", "atc", "pvp"]}
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

          <div className="mt-2.5 flex items-end gap-2">
            <ActionButton
              icon={<Eye className="h-3.5 w-3.5" />}
              label="Ver em ecrã"
            />
            <ActionButton
              icon={<Printer className="h-3.5 w-3.5" />}
              label="Imprimir"
              onClick={() => window.print()}
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
            />
          </div>

          {filtrosAbertos && (
            <div className="mt-3 rounded-2xl border border-slate-200 bg-white p-3">
              <div className="grid gap-3 xl:grid-cols-3">
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
                  label="ATC"
                  options={atcs}
                  selected={atcsSelecionados}
                  onToggle={(value) =>
                    toggleValue(value, atcsSelecionados, setAtcsSelecionados)
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

                <SearchableMultiSelect
                  label="Forma farmacêutica"
                  options={formas}
                  selected={formasSelecionadas}
                  onToggle={(value) =>
                    toggleValue(value, formasSelecionadas, setFormasSelecionadas)
                  }
                />

                <SearchableMultiSelect
                  label="Estado"
                  options={estados}
                  selected={estadosSelecionados}
                  onToggle={(value) =>
                    toggleValue(value, estadosSelecionados, setEstadosSelecionados)
                  }
                />
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                {fabricantesSelecionados.map((item) => (
                  <FilterPill
                    key={`fabricante-${item}`}
                    label={`Fabricante: ${item}`}
                    onRemove={() =>
                      setFabricantesSelecionados((prev) =>
                        prev.filter((v) => v !== item)
                      )
                    }
                  />
                ))}

                {atcsSelecionados.map((item) => (
                  <FilterPill
                    key={`atc-${item}`}
                    label={`ATC: ${item}`}
                    onRemove={() =>
                      setAtcsSelecionados((prev) =>
                        prev.filter((v) => v !== item)
                      )
                    }
                  />
                ))}

                {categoriasSelecionadas.map((item) => (
                  <FilterPill
                    key={`categoria-${item}`}
                    label={`Categoria: ${item}`}
                    onRemove={() =>
                      setCategoriasSelecionadas((prev) =>
                        prev.filter((v) => v !== item)
                      )
                    }
                  />
                ))}

                {formasSelecionadas.map((item) => (
                  <FilterPill
                    key={`forma-${item}`}
                    label={`Forma: ${item}`}
                    onRemove={() =>
                      setFormasSelecionadas((prev) =>
                        prev.filter((v) => v !== item)
                      )
                    }
                  />
                ))}

                {estadosSelecionados.map((item) => (
                  <FilterPill
                    key={`estado-${item}`}
                    label={`Estado: ${humanizeOption(item)}`}
                    onRemove={() =>
                      setEstadosSelecionados((prev) =>
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
              label="Apenas com PVP"
              checked={apenasComPvp}
              onChange={setApenasComPvp}
              compact
            />
            <ToggleRow
              label="Apenas ativos"
              checked={apenasAtivos}
              onChange={setApenasAtivos}
              compact
            />

            <div className="ml-auto flex flex-wrap items-center gap-3 text-[13px] text-slate-600">
              <span>
                <span className="font-semibold text-slate-900">
                  {resumo.linhas}
                </span>{" "}
                linhas
              </span>
              <span>
                <span className="font-semibold text-slate-900">
                  {resumo.fabricantes}
                </span>{" "}
                fabricantes
              </span>
              <span>
                <span className="font-semibold text-slate-900">
                  {resumo.categorias}
                </span>{" "}
                categorias
              </span>
              <span>
                ativos{" "}
                <span className="font-semibold text-slate-900">
                  {resumo.ativos}
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
                  Vista catálogo
                </h2>
                <p className="mt-0.5 text-[12px] text-slate-500">
                  Estrutura mestre do artigo.
                </p>
              </div>

              <div className="rounded-xl border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] text-slate-500">
                {humanizeOption(ordenarPor)}
              </div>
            </div>

            <div className="max-h-[calc(100vh-360px)] min-h-[420px] overflow-y-auto">
              <table className="min-w-full table-fixed text-left">
                <colgroup>
                  <col className="w-[8%]" />
                  <col className="w-[24%]" />
                  <col className="w-[10%]" />
                  <col className="w-[14%]" />
                  <col className="w-[10%]" />
                  <col className="w-[10%]" />
                  <col className="w-[8%]" />
                  <col className="w-[8%]" />
                  <col className="w-[8%]" />
                </colgroup>

                <thead className="sticky top-0 z-10 border-b border-slate-100 bg-slate-50/95 text-[10px] uppercase tracking-[0.14em] text-slate-500 backdrop-blur">
                  <tr>
                    <th className="px-4 py-2.5 font-semibold">CNP</th>
                    <th className="px-3 py-2.5 font-semibold">Produto</th>
                    <th className="px-3 py-2.5 font-semibold">Fabricante</th>
                    <th className="px-3 py-2.5 font-semibold">Princípio ativo</th>
                    <th className="px-3 py-2.5 font-semibold">ATC</th>
                    <th className="px-3 py-2.5 font-semibold">Forma</th>
                    <th className="px-2 py-2.5 text-center font-semibold">Dosagem</th>
                    <th className="px-2 py-2.5 text-center font-semibold">PVP</th>
                    <th className="px-2 py-2.5 text-center font-semibold">Estado</th>
                  </tr>
                </thead>

                <tbody className="divide-y divide-slate-100 text-[13px] text-slate-700">
                  {orderedRows.map((row) => (
                    <tr
                      key={row.cnp}
                      className="transition hover:bg-slate-50/70"
                    >
                      <td className="px-4 py-2.5 align-top font-medium text-slate-800">
                        {row.cnp}
                      </td>
                      <td className="px-3 py-2.5 align-top">
                        <div className="space-y-0.5">
                          <Link
                            href={`/catalogo/artigo/${row.cnp}`}
                            className="block font-semibold leading-5 text-slate-900 transition hover:text-emerald-600"
                          >
                            {row.produto}
                          </Link>
                          <div className="text-[12px] text-slate-500">
                            {row.categoria} · {row.embalagem}
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2.5">{row.fabricante}</td>
                      <td className="px-3 py-2.5">{row.principioAtivo}</td>
                      <td className="px-3 py-2.5">{row.atc}</td>
                      <td className="px-3 py-2.5">{row.formaFarmaceutica}</td>
                      <td className="px-2 py-2.5 text-center">{row.dosagem}</td>
                      <td className="px-2 py-2.5 text-center">
                        {row.pvp.toLocaleString("pt-PT", {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}{" "}
                        €
                      </td>
                      <td className="px-2 py-2.5 text-center">
                        <StatusBadge estado={row.estado} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : (
          <section className="overflow-hidden rounded-[20px] border border-white/70 bg-white/84 shadow-[0_8px_18px_rgba(15,23,42,0.04)] backdrop-blur-xl">
            <div className="border-b border-slate-100 px-4 py-3">
              <h2 className="text-sm font-semibold text-slate-900">
                Vista relatório
              </h2>
              <p className="mt-0.5 text-[12px] text-slate-500">
                Estrutura preparada para impressão, PDF e exportação.
              </p>
            </div>

            <div className="max-h-[calc(100vh-360px)] overflow-y-auto p-4">
              <div className="mx-auto max-w-[1280px] space-y-4">
                <div className="rounded-[18px] border border-slate-200 bg-white p-5 shadow-sm">
                  <div className="border-b border-dashed border-slate-300 pb-3">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <div className="text-[11px] text-slate-500">
                          Farmácia Silveirense, Lda. (NIF: 507529930)
                        </div>
                        <div className="mt-2 text-[15px] font-semibold text-slate-900">
                          Relatório de Catálogo
                        </div>
                      </div>

                      <div className="text-right text-[12px] text-slate-500">
                        <div>{new Date().toLocaleDateString("pt-PT")}</div>
                        <div className="mt-1">Moeda: Euro</div>
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 grid gap-3 md:grid-cols-4">
                    <MetricCard label="Linhas" value={String(resumo.linhas)} />
                    <MetricCard
                      label="Fabricantes"
                      value={String(resumo.fabricantes)}
                    />
                    <MetricCard
                      label="Categorias"
                      value={String(resumo.categorias)}
                    />
                    <MetricCard label="Ativos" value={String(resumo.ativos)} />
                  </div>

                  <div className="mt-4 overflow-hidden rounded-xl border border-slate-200">
                    <table className="min-w-full text-left">
                      <thead className="bg-slate-50 text-[10px] uppercase tracking-[0.14em] text-slate-500">
                        <tr>
                          <th className="px-3 py-2 font-semibold">CNP</th>
                          <th className="px-3 py-2 font-semibold">Produto</th>
                          <th className="px-3 py-2 font-semibold">Fabricante</th>
                          <th className="px-3 py-2 font-semibold">ATC</th>
                          <th className="px-3 py-2 font-semibold">Forma</th>
                          <th className="px-3 py-2 text-center font-semibold">PVP</th>
                          <th className="px-3 py-2 font-semibold">Estado</th>
                        </tr>
                      </thead>

                      <tbody className="divide-y divide-slate-200 text-[12px] text-slate-700">
                        {orderedRows.map((row) => (
                          <tr key={`report-${row.cnp}`}>
                            <td className="whitespace-nowrap px-3 py-1.5">{row.cnp}</td>
                            <td className="px-3 py-1.5">{row.produto}</td>
                            <td className="px-3 py-1.5">{row.fabricante}</td>
                            <td className="px-3 py-1.5">{row.atc}</td>
                            <td className="px-3 py-1.5">{row.formaFarmaceutica}</td>
                            <td className="px-3 py-1.5 text-center">
                              {row.pvp.toLocaleString("pt-PT", {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              })}{" "}
                              €
                            </td>
                            <td className="px-3 py-1.5">
                              <StatusBadge estado={row.estado} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="mt-4 flex items-center justify-between text-[11px] text-slate-400">
                    <div>SoftReis Informática</div>
                    <div>Página 1 de 1</div>
                  </div>
                </div>
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
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
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
                <span className="truncate">{humanizeOption(option)}</span>
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
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 text-[13px] font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-800"
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

function StatusBadge({ estado }: { estado: "ativo" | "inativo" }) {
  const styles =
    estado === "ativo"
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : "border-slate-200 bg-slate-50 text-slate-700";

  return (
    <span
      className={[
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold",
        styles,
      ].join(" ")}
    >
      {humanizeOption(estado)}
    </span>
  );
}

function MetricCard({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
        {label}
      </div>
      <div className="mt-1 text-sm font-semibold text-slate-900">{value}</div>
    </div>
  );
}

function humanizeOption(option: string) {
  const map: Record<string, string> = {
    produto: "Produto",
    cnp: "CNP",
    fabricante: "Fabricante",
    atc: "ATC",
    pvp: "PVP",
    ativo: "Ativo",
    inativo: "Inativo",
  };

  return map[option] ?? option;
}