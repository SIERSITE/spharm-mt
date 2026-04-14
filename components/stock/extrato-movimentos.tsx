"use client";

import { useState, useTransition } from "react";
import type {
  MovimentoRow,
  MovimentoTipo,
} from "@/lib/movimentos-data";
import { runExtratoMovimentos } from "@/app/stock/artigo/[cnp]/actions";

type FarmaciaOpt = { id: string; nome: string };

type Props = {
  cnp: number;
  farmacias: FarmaciaOpt[];
  /** Lista de tipos disponíveis no dropdown (vindos do server). */
  tiposDisponiveis: Array<{ value: MovimentoTipo; label: string }>;
  /** Carregado server-side no page open. A UI começa já com estes
   *  movimentos visíveis — o botão "Atualizar" só refresca em cima. */
  initialRows: MovimentoRow[];
};

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("pt-PT", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
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

export function ExtratoMovimentos({
  cnp,
  farmacias,
  tiposDisponiveis,
  initialRows,
}: Props) {
  // O extrato carrega imediatamente via server component — o user já
  // escolheu o artigo, não faz sentido pedir um "Gerar" inicial. O
  // botão "Atualizar" só refresca depois de mudar filtros.
  const [rows, setRows] = useState<MovimentoRow[]>(initialRows);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [farmaciaIds, setFarmaciaIds] = useState<string[]>(farmacias.map((f) => f.id));
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [tipos, setTipos] = useState<MovimentoTipo[]>([]);

  const toggleFarmacia = (id: string) =>
    setFarmaciaIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  const toggleTipo = (t: MovimentoTipo) =>
    setTipos((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));

  const handleAtualizar = () => {
    setError(null);
    startTransition(async () => {
      try {
        const result = await runExtratoMovimentos(cnp, {
          farmaciaIds:
            farmaciaIds.length > 0 && farmaciaIds.length < farmacias.length
              ? farmaciaIds
              : undefined,
          from: from || undefined,
          to: to || undefined,
          tipos: tipos.length > 0 ? tipos : undefined,
        });
        setRows(result);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  };

  return (
    <section className="rounded-[16px] border border-slate-200/60 bg-white/72 px-4 py-3 shadow-[0_14px_30px_rgba(15,23,42,0.045)]">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-[14px] font-semibold text-slate-900">Extrato de movimentos</h2>
          <p className="mt-0.5 text-[11px] text-slate-500">
            Entradas e saídas do artigo por farmácia, ordenado do mais recente para o mais antigo.
            Linhas marcadas como <span className="font-semibold text-amber-700">mensal</span> são
            totais mensais agregados, não movimentos venda-a-venda.
          </p>
        </div>
        <button
          type="button"
          onClick={handleAtualizar}
          disabled={isPending}
          className="inline-flex h-9 items-center gap-2 rounded-xl border border-emerald-300 bg-emerald-50 px-4 text-[13px] font-semibold text-emerald-700 transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isPending ? "A atualizar…" : "Atualizar"}
        </button>
      </div>

      {/* Filtros */}
      <div className="grid gap-3 border-t border-slate-100 pt-3 md:grid-cols-[1fr_140px_140px]">
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
            Farmácia
          </div>
          <div className="flex flex-wrap gap-1.5">
            {farmacias.map((f) => {
              const on = farmaciaIds.includes(f.id);
              return (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => toggleFarmacia(f.id)}
                  className={`rounded-full border px-2.5 py-0.5 text-[11px] ${
                    on
                      ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                      : "border-slate-200 bg-white text-slate-600"
                  }`}
                >
                  {f.nome}
                </button>
              );
            })}
          </div>
        </div>
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
            Desde
          </div>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="h-9 w-full rounded-[10px] border border-slate-200 bg-white px-2 text-[12px] text-slate-700 outline-none focus:border-emerald-200"
          />
        </div>
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
            Até
          </div>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="h-9 w-full rounded-[10px] border border-slate-200 bg-white px-2 text-[12px] text-slate-700 outline-none focus:border-emerald-200"
          />
        </div>
      </div>

      <div className="mt-3">
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
          Tipo de movimento {tipos.length > 0 && `(${tipos.length})`}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {tiposDisponiveis.map((t) => {
            const on = tipos.includes(t.value);
            return (
              <button
                key={t.value}
                type="button"
                onClick={() => toggleTipo(t.value)}
                className={`rounded-full border px-2.5 py-0.5 text-[11px] ${
                  on
                    ? "border-cyan-300 bg-cyan-50 text-cyan-700"
                    : "border-slate-200 bg-white text-slate-600"
                }`}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      {error && (
        <div className="mt-3 rounded-[10px] border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700">
          Falha ao carregar o extrato: {error}
        </div>
      )}

      {/* Resultados */}
      <div className="mt-4 overflow-x-auto">
        {rows.length === 0 ? (
          <div className="rounded-[12px] border border-dashed border-slate-200 bg-white/60 px-4 py-8 text-center text-[12px] text-slate-500">
            Sem movimentos para os critérios seleccionados.
          </div>
        ) : (
          <table className="min-w-full text-left text-[12px]">
            <thead className="border-b border-slate-200 text-[10px] uppercase tracking-[0.14em] text-slate-500">
              <tr>
                <th className="py-2 pr-3">Data</th>
                <th className="py-2 pr-3">Farmácia</th>
                <th className="py-2 pr-3">Tipo</th>
                <th className="py-2 pr-3">Documento</th>
                <th className="py-2 pr-3 text-right">Qtd.</th>
                <th className="py-2 pr-3 text-right">Stock antes</th>
                <th className="py-2 pr-3 text-right">Stock depois</th>
                <th className="py-2 pr-3">Utilizador</th>
                <th className="py-2">Observação</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => (
                <tr key={row.key}>
                  <td className="py-2 pr-3 whitespace-nowrap text-slate-700">
                    {formatDateTime(row.data)}
                  </td>
                  <td className="py-2 pr-3 text-slate-700">{row.farmacia}</td>
                  <td className="py-2 pr-3 text-slate-700">
                    <div className="flex items-center gap-1.5">
                      <span>{row.tipoLabel}</span>
                      {row.agregado && (
                        <span
                          className="rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-700"
                          title="Total mensal agregado (não é venda-a-venda)"
                        >
                          mensal
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="py-2 pr-3 text-slate-500">{row.documento ?? "—"}</td>
                  <td className={`py-2 pr-3 text-right font-medium ${qtyColor(row.direcao)}`}>
                    {signedQty(row)}
                  </td>
                  <td className="py-2 pr-3 text-right text-slate-500">
                    {row.stockAntes ?? "—"}
                  </td>
                  <td className="py-2 pr-3 text-right text-slate-500">
                    {row.stockDepois ?? "—"}
                  </td>
                  <td className="py-2 pr-3 text-slate-500">{row.utilizador ?? "—"}</td>
                  <td className="py-2 text-slate-500">{row.observacao ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
