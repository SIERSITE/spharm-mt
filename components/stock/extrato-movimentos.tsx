"use client";

import { useMemo, useState, useTransition } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { MovimentoRow, MovimentoTipo } from "@/lib/movimentos-data";
import { runExtratoMovimentos } from "@/app/stock/artigo/[cnp]/actions";

type FarmaciaOpt = { id: string; nome: string };

type Props = {
  cnp: number;
  farmacias: FarmaciaOpt[];
  /** Carregado server-side no page open. */
  initialRows: MovimentoRow[];
  /** Janela inicial (ISO yyyy-mm-dd) — reflecte o default de 30 dias. */
  defaultFrom?: string;
  defaultTo?: string;
};

type QuickFilter = "todos" | "vendas" | "compras" | "devolucoes" | "outros";

function categoria(tipo: MovimentoTipo): Exclude<QuickFilter, "todos"> {
  if (tipo === "VENDA") return "vendas";
  if (tipo === "COMPRA") return "compras";
  if (tipo.startsWith("DEVOLUCAO")) return "devolucoes";
  return "outros";
}

/** Estilo do badge de tipo por categoria — distinção visual clara. */
const CAT_BADGE: Record<Exclude<QuickFilter, "todos">, string> = {
  vendas: "border-sky-200 bg-sky-50 text-sky-700",
  compras: "border-emerald-200 bg-emerald-50 text-emerald-700",
  devolucoes: "border-rose-200 bg-rose-50 text-rose-700",
  outros: "border-slate-200 bg-slate-50 text-slate-600",
};

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("pt-PT", { year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    return iso;
  }
}
function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("pt-PT", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}
function fmtCurrency(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "—";
  return v.toLocaleString("pt-PT", { style: "currency", currency: "EUR" });
}
function signedQty(row: MovimentoRow): string {
  if (row.quantidade === 0) return "0";
  if (row.direcao === "ENTRADA") return `+${row.quantidade}`;
  if (row.direcao === "SAIDA") return `−${row.quantidade}`;
  return String(row.quantidade);
}
function qtyColor(direcao: MovimentoRow["direcao"]): string {
  if (direcao === "ENTRADA") return "text-emerald-700";
  if (direcao === "SAIDA") return "text-rose-700";
  return "text-slate-600";
}
/** Tem detalhe documental REAL (documento/stock/utilizador) — só então expande. */
function hasRealDetail(r: MovimentoRow): boolean {
  return r.documento !== null || r.stockAntes !== null || r.stockDepois !== null || r.utilizador !== null;
}

export function ExtratoMovimentos({ cnp, farmacias, initialRows, defaultFrom, defaultTo }: Props) {
  const [rows, setRows] = useState<MovimentoRow[]>(initialRows);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [farmaciaIds, setFarmaciaIds] = useState<string[]>(farmacias.map((f) => f.id));
  const [from, setFrom] = useState(defaultFrom ?? "");
  const [to, setTo] = useState(defaultTo ?? "");
  const [quick, setQuick] = useState<QuickFilter>("todos");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggleFarmacia = (id: string) =>
    setFarmaciaIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const toggleExpand = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const handleAtualizar = () => {
    setError(null);
    startTransition(async () => {
      try {
        const result = await runExtratoMovimentos(cnp, {
          farmaciaIds:
            farmaciaIds.length > 0 && farmaciaIds.length < farmacias.length ? farmaciaIds : undefined,
          from: from || undefined,
          to: to || undefined,
        });
        setRows(result);
        setExpanded(new Set());
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  // Contagens por categoria (sobre TODAS as linhas carregadas) — surgem nos
  // chips para que as compras antigas não fiquem escondidas: "Compras (6)".
  const counts = useMemo(() => {
    const c = { todos: rows.length, vendas: 0, compras: 0, devolucoes: 0, outros: 0 };
    for (const r of rows) c[categoria(r.tipo)]++;
    return c;
  }, [rows]);

  const visibleRows = useMemo(
    () => (quick === "todos" ? rows : rows.filter((r) => categoria(r.tipo) === quick)),
    [rows, quick],
  );

  const chips: Array<{ key: QuickFilter; label: string; n: number }> = [
    { key: "todos", label: "Todos", n: counts.todos },
    { key: "vendas", label: "Vendas", n: counts.vendas },
    { key: "compras", label: "Compras", n: counts.compras },
    { key: "devolucoes", label: "Devoluções", n: counts.devolucoes },
    ...(counts.outros > 0 ? [{ key: "outros" as QuickFilter, label: "Outros", n: counts.outros }] : []),
  ];

  return (
    <section className="rounded-[16px] border border-slate-200/60 bg-white/72 px-4 py-3 shadow-[0_14px_30px_rgba(15,23,42,0.045)]">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-[14px] font-semibold text-slate-900">Extrato de movimentos</h2>
          <p className="mt-0.5 text-[11px] text-slate-500">
            Por defeito mostra os <span className="font-semibold text-slate-700">últimos 30 dias</span> —
            a mesma janela para <span className="font-semibold text-slate-700">todos os tipos</span>
            {" "}(vendas, compras, devoluções, ajustes). Altera <span className="font-semibold text-slate-700">Desde</span>/
            <span className="font-semibold text-slate-700">Até</span> para ver histórico (ex: receções de 2024);
            acima de ~2 meses as vendas passam a mensais. Linhas{" "}
            <span className="font-semibold text-amber-700">agregado</span> são somas (sem documento/utilizador/stock individual).
          </p>
        </div>
        <button
          type="button"
          onClick={handleAtualizar}
          disabled={isPending}
          className="inline-flex h-9 shrink-0 items-center gap-2 rounded-xl border border-emerald-300 bg-emerald-50 px-4 text-[13px] font-semibold text-emerald-700 transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isPending ? "A atualizar…" : "Atualizar"}
        </button>
      </div>

      {/* Filtros rápidos por tipo (client-side, com contagem) */}
      <div className="flex flex-wrap items-center gap-1.5 border-t border-slate-100 pt-3">
        {chips.map((c) => {
          const on = quick === c.key;
          return (
            <button
              key={c.key}
              type="button"
              onClick={() => setQuick(c.key)}
              className={`rounded-full border px-3 py-1 text-[11px] font-medium transition ${
                on ? "border-slate-800 bg-slate-800 text-white" : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
              }`}
            >
              {c.label} <span className={on ? "text-white/70" : "text-slate-400"}>({c.n})</span>
            </button>
          );
        })}
      </div>

      {/* Filtros de farmácia + período */}
      <div className="mt-3 grid gap-3 md:grid-cols-[1fr_140px_140px]">
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">Farmácia</div>
          <div className="flex flex-wrap gap-1.5">
            {farmacias.map((f) => {
              const on = farmaciaIds.includes(f.id);
              return (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => toggleFarmacia(f.id)}
                  className={`rounded-full border px-2.5 py-0.5 text-[11px] ${
                    on ? "border-emerald-300 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-white text-slate-600"
                  }`}
                >
                  {f.nome}
                </button>
              );
            })}
          </div>
        </div>
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">Desde</div>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="h-9 w-full rounded-[10px] border border-slate-200 bg-white px-2 text-[12px] text-slate-700 outline-none focus:border-emerald-200"
          />
        </div>
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">Até</div>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="h-9 w-full rounded-[10px] border border-slate-200 bg-white px-2 text-[12px] text-slate-700 outline-none focus:border-emerald-200"
          />
        </div>
      </div>

      {error && (
        <div className="mt-3 rounded-[10px] border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700">
          Falha ao carregar o extrato: {error}
        </div>
      )}

      {/* Resultados — colunas simplificadas (detalhe documental no expandir) */}
      <div className="mt-4 overflow-x-auto">
        {visibleRows.length === 0 ? (
          <div className="rounded-[12px] border border-dashed border-slate-200 bg-white/60 px-4 py-8 text-center text-[12px] text-slate-500">
            {rows.length === 0
              ? "Sem movimentos neste período."
              : "Sem movimentos deste tipo neste período. Vê todos os tipos no filtro acima ou alarga as datas."}
          </div>
        ) : (
          <table className="min-w-full text-left text-[12px]">
            <thead className="border-b border-slate-200 text-[10px] uppercase tracking-[0.14em] text-slate-500">
              <tr>
                <th className="py-2 pr-3">Data</th>
                <th className="py-2 pr-3">Farmácia</th>
                <th className="py-2 pr-3">Tipo</th>
                <th className="py-2 pr-3 text-right">Quantidade</th>
                <th className="py-2 pr-3 text-right">Valor</th>
                <th className="py-2 pr-3">Origem / Fornecedor</th>
                <th className="py-2 w-6" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {visibleRows.map((row) => {
                const cat = categoria(row.tipo);
                const canExpand = hasRealDetail(row);
                const isOpen = expanded.has(row.key);
                return (
                  <FragmentRow
                    key={row.key}
                    row={row}
                    cat={cat}
                    canExpand={canExpand}
                    isOpen={isOpen}
                    onToggle={() => canExpand && toggleExpand(row.key)}
                  />
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );

  function FragmentRow({
    row,
    cat,
    canExpand,
    isOpen,
    onToggle,
  }: {
    row: MovimentoRow;
    cat: Exclude<QuickFilter, "todos">;
    canExpand: boolean;
    isOpen: boolean;
    onToggle: () => void;
  }) {
    return (
      <>
        <tr className={canExpand ? "cursor-pointer hover:bg-slate-50/70" : ""} onClick={onToggle}>
          <td className="py-2 pr-3 whitespace-nowrap text-slate-700">{formatDate(row.data)}</td>
          <td className="py-2 pr-3 text-slate-700">{row.farmacia}</td>
          <td className="py-2 pr-3">
            <span className="flex flex-wrap items-center gap-1.5">
              <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium ${CAT_BADGE[cat]}`}>
                {row.tipoLabel}
              </span>
              {row.agregado && (
                <span
                  className="rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-700"
                  title="Total agregado — não é movimento individual (sem documento/utilizador/stock antes-depois)"
                >
                  agregado
                </span>
              )}
            </span>
          </td>
          <td className={`py-2 pr-3 text-right font-medium ${qtyColor(row.direcao)}`}>{signedQty(row)}</td>
          <td className="py-2 pr-3 text-right text-slate-600">{fmtCurrency(row.valor)}</td>
          <td className="py-2 pr-3 text-slate-500">{row.origem ?? "—"}</td>
          <td className="py-2 text-slate-400">
            {canExpand ? (isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />) : null}
          </td>
        </tr>
        {canExpand && isOpen && (
          <tr className="bg-slate-50/60">
            <td colSpan={7} className="px-3 py-2">
              <div className="grid gap-x-6 gap-y-1 text-[11px] text-slate-600 sm:grid-cols-2 lg:grid-cols-4">
                <Detail label="Documento" value={row.documento} />
                <Detail label="Stock antes" value={row.stockAntes !== null ? String(row.stockAntes) : null} />
                <Detail label="Stock depois" value={row.stockDepois !== null ? String(row.stockDepois) : null} />
                <Detail label="Utilizador" value={row.utilizador} />
                {row.observacao && (
                  <div className="sm:col-span-2 lg:col-span-4">
                    <span className="text-slate-400">Observação: </span>
                    <span className="text-slate-600">{row.observacao}</span>
                  </div>
                )}
                <div className="sm:col-span-2 lg:col-span-4 text-[10px] text-slate-400">
                  Registado em {formatDateTime(row.data)}
                </div>
              </div>
            </td>
          </tr>
        )}
      </>
    );
  }
}

function Detail({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <span className="text-slate-400">{label}: </span>
      <span className="text-slate-700">{value ?? "—"}</span>
    </div>
  );
}
