"use client";

import { useMemo, useState, useTransition } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type {
  MovimentoRow,
  MovimentoTipo,
  ContraparteTipo,
} from "@/lib/movimentos-tipos";
import { TIPOS_ACERTO_STOCK } from "@/lib/movimentos-tipos";
import { runExtratoMovimentos } from "@/app/stock/artigo/[cnp]/actions";

type FarmaciaOpt = { id: string; nome: string };

type Props = {
  cnp: number;
  farmacias: FarmaciaOpt[];
  /** Carregado server-side no page open. */
  initialRows: MovimentoRow[];
  /** Janela inicial (ISO yyyy-mm-dd) — reflecte o default do ano corrente. */
  defaultFrom?: string;
  defaultTo?: string;
};

// ── Chips: 1:1 com `MovimentoTipo` canónico, espelho do "Resumo por
// Tipo de Documento" do relatório ERP. Cada chip filtra um conjunto
// PRECISO de tipos — não há catch-all "Outros". ─────────────────────
type Chip = {
  key: string;
  label: string;
  tipos: MovimentoTipo[];
};

const CHIPS: Chip[] = [
  { key: "todos", label: "Todos", tipos: [] }, // [] = sem filtro
  { key: "venda", label: "Venda", tipos: ["VENDA", "VENDA_CREDITO"] },
  { key: "dev-cliente", label: "Devolução cliente", tipos: ["DEVOLUCAO_CLIENTE", "DEVOLUCAO_OUTRA"] },
  { key: "compra", label: "Compra / Recepção", tipos: ["COMPRA"] },
  { key: "dev-fornecedor", label: "Devolução fornecedor", tipos: ["DEVOLUCAO_FORNECEDOR"] },
  // Cinco chips internos passaram a um. Não é simplificação de UI: os
  // cinco distinguiam-se por uma inferência sobre o texto do motivo,
  // que rev60 retirou. A lista de tipos vem de TIPOS_ACERTO_STOCK e
  // inclui os históricos, para que o chip não esconda as linhas
  // gravadas antes da migração.
  { key: "acerto", label: "Acerto de stock", tipos: [...TIPOS_ACERTO_STOCK] },
  { key: "reserva", label: "Reserva", tipos: ["RESERVA_SUSPENSA"] },
];

const TIPO_BADGE: Partial<Record<MovimentoTipo, string>> = {
  VENDA: "border-sky-200 bg-sky-50 text-sky-700",
  VENDA_CREDITO: "border-sky-200 bg-sky-50 text-sky-700",
  DEVOLUCAO_CLIENTE: "border-rose-200 bg-rose-50 text-rose-700",
  DEVOLUCAO_OUTRA: "border-rose-200 bg-rose-50 text-rose-700",
  COMPRA: "border-emerald-200 bg-emerald-50 text-emerald-700",
  DEVOLUCAO_FORNECEDOR: "border-amber-200 bg-amber-50 text-amber-700",
  // Uma cor só para a operação toda. Cores diferentes para linhas com o
  // mesmo rótulo davam a entender uma distinção que já não existe.
  ACERTO_STOCK: "border-violet-200 bg-violet-50 text-violet-700",
  TRANSFERENCIA_ENTRADA: "border-violet-200 bg-violet-50 text-violet-700",
  TRANSFERENCIA_SAIDA: "border-violet-200 bg-violet-50 text-violet-700",
  INVENTARIO: "border-violet-200 bg-violet-50 text-violet-700",
  QUEBRA: "border-violet-200 bg-violet-50 text-violet-700",
  PERDA: "border-violet-200 bg-violet-50 text-violet-700",
  AJUSTE: "border-violet-200 bg-violet-50 text-violet-700",
  AJUSTE_POSITIVO: "border-violet-200 bg-violet-50 text-violet-700",
  AJUSTE_NEGATIVO: "border-violet-200 bg-violet-50 text-violet-700",
  AJUSTE_CORRECAO: "border-violet-200 bg-violet-50 text-violet-700",
  AJUSTE_OUTRO: "border-violet-200 bg-violet-50 text-violet-700",
  RESERVA_SUSPENSA: "border-slate-200 bg-slate-50 text-slate-600",
  DESCONHECIDO: "border-slate-200 bg-slate-50 text-slate-500",
};

function badgeClassFor(tipo: MovimentoTipo): string {
  return TIPO_BADGE[tipo] ?? "border-slate-200 bg-slate-50 text-slate-600";
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("pt-PT", { year: "numeric", month: "2-digit", day: "2-digit" });
  } catch {
    return iso;
  }
}
function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}
function fmtCurrency(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "—";
  return v.toLocaleString("pt-PT", { style: "currency", currency: "EUR" });
}
function fmtPrice4(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "—";
  return v.toLocaleString("pt-PT", { minimumFractionDigits: 4, maximumFractionDigits: 4 }) + " €";
}
function signedQty(qty: number): string {
  if (qty === 0) return "0";
  if (qty > 0) return `+${qty.toLocaleString("pt-PT")}`;
  return `−${Math.abs(qty).toLocaleString("pt-PT")}`;
}
function qtyColor(qty: number): string {
  if (qty > 0) return "text-emerald-700";
  if (qty < 0) return "text-rose-700";
  return "text-slate-600";
}

function composeDocumento(r: MovimentoRow): string {
  const tipo = r.documentoTipo?.trim();
  const num = r.documentoNumero?.trim();
  if (tipo && num) return `${tipo} ${num}`;
  if (tipo) return tipo;
  if (num) return num;
  return "—";
}

function contraparteLabel(tipo: ContraparteTipo | null): string {
  switch (tipo) {
    case "CLIENTE":
      return "Cliente";
    case "FORNECEDOR":
      return "Fornecedor";
    case "FARMACIA_ORIGEM":
      return "Farmácia origem";
    case "FARMACIA_DESTINO":
      return "Farmácia destino";
    default:
      return "";
  }
}

export function ExtratoMovimentos({ cnp, farmacias, initialRows, defaultFrom, defaultTo }: Props) {
  const [rows, setRows] = useState<MovimentoRow[]>(initialRows);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [farmaciaSel, setFarmaciaSel] = useState<"todas" | string>("todas");
  const [from, setFrom] = useState(defaultFrom ?? "");
  const [to, setTo] = useState(defaultTo ?? "");
  const [quickKey, setQuickKey] = useState<string>("todos");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
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
          farmaciaIds: farmaciaSel === "todas" ? undefined : [farmaciaSel],
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

  // Contagens por chip — sobre TODAS as linhas carregadas. "Todos" usa
  // rows.length; cada outro chip conta apenas os tipos que filtra.
  const counts = useMemo(() => {
    const m: Record<string, number> = { todos: rows.length };
    for (const c of CHIPS) {
      if (c.tipos.length === 0) continue;
      const set = new Set(c.tipos);
      m[c.key] = rows.filter((r) => set.has(r.tipo)).length;
    }
    return m;
  }, [rows]);

  const visibleChips = useMemo(
    () => CHIPS.filter((c) => c.key === "todos" || (counts[c.key] ?? 0) > 0),
    [counts],
  );

  const visibleRows = useMemo(() => {
    if (quickKey === "todos") return rows;
    const chip = CHIPS.find((c) => c.key === quickKey);
    if (!chip || chip.tipos.length === 0) return rows;
    const set = new Set(chip.tipos);
    return rows.filter((r) => set.has(r.tipo));
  }, [rows, quickKey]);

  // Totais — espelho do "Resumo Geral / Período" do ERP.
  const totals = useMemo(() => {
    let entradas = 0;
    let saidas = 0;
    let bonusEnt = 0;
    let bonusSai = 0;
    for (const r of visibleRows) {
      if (r.quantidade > 0) entradas += r.quantidade;
      else if (r.quantidade < 0) saidas += -r.quantidade;
      bonusEnt += r.quantidadeBonusEnt;
      bonusSai += r.quantidadeBonusSai;
    }
    return {
      entradas,
      saidas,
      saldo: entradas - saidas,
      bonusEnt,
      bonusSai,
    };
  }, [visibleRows]);

  return (
    <section className="rounded-[16px] border border-slate-200/60 bg-white/72 px-4 py-3 shadow-[0_14px_30px_rgba(15,23,42,0.045)]">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-[14px] font-semibold text-slate-900">Extrato de movimentos</h2>
          <p className="mt-0.5 text-[11px] text-slate-500">
            Espelho do relatório <span className="font-medium">Movimento de Artigos</span> do ERP — uma
            linha por movimento, com documento, contraparte, quantidades e running balance. Altera{" "}
            <span className="font-semibold text-slate-700">Desde / Até</span> para mudar o período.
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

      {/* Chips de filtro rápido */}
      <div className="flex flex-wrap items-center gap-1.5 border-t border-slate-100 pt-3">
        {visibleChips.map((c) => {
          const on = quickKey === c.key;
          const n = counts[c.key] ?? 0;
          return (
            <button
              key={c.key}
              type="button"
              onClick={() => setQuickKey(c.key)}
              className={`rounded-full border px-3 py-1 text-[11px] font-medium transition ${
                on ? "border-slate-800 bg-slate-800 text-white" : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
              }`}
            >
              {c.label} <span className={on ? "text-white/70" : "text-slate-400"}>({n})</span>
            </button>
          );
        })}
      </div>

      {/* Filtros de farmácia + período */}
      <div className="mt-3 grid gap-3 md:grid-cols-[1fr_140px_140px]">
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
            Filtro de farmácia
          </div>
          <div className="flex flex-wrap gap-1.5">
            {([{ id: "todas", nome: "Todas" }, ...farmacias] as Array<{ id: string; nome: string }>).map((f) => {
              const on = farmaciaSel === f.id;
              return (
                <button
                  key={f.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setFarmaciaSel(f.id)}
                  className={`rounded-full border px-3 py-0.5 text-[11px] font-medium transition ${
                    on
                      ? "border-emerald-400 bg-emerald-500 text-white shadow-sm"
                      : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
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

      {/* Grelha principal — 7 colunas */}
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
                <th className="py-2 pr-3">Documento</th>
                <th className="py-2 pr-3">Tipo</th>
                <th className="py-2 pr-3">Cliente / Fornecedor</th>
                <th className="py-2 pr-3 text-right">Qtd</th>
                <th className="py-2 pr-3 text-right">Stock depois</th>
                <th className="py-2 pr-3">Observação</th>
                <th className="py-2 w-6" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {visibleRows.map((row) => {
                const isOpen = expanded.has(row.key);
                return (
                  <FragmentRow
                    key={row.key}
                    row={row}
                    isOpen={isOpen}
                    onToggle={() => toggleExpand(row.key)}
                  />
                );
              })}
            </tbody>
            {/* Linha de totais — espelho do "Total Entradas / Saídas / Saldo" */}
            <tfoot className="border-t border-slate-200 bg-slate-50/60 text-[11px] font-semibold">
              <tr>
                <td className="px-2 py-2 text-slate-600" colSpan={4}>
                  Total no período
                </td>
                <td className="px-2 py-2 text-right">
                  <span className="text-emerald-700">+{totals.entradas.toLocaleString("pt-PT")}</span>{" "}
                  <span className="text-rose-700">−{totals.saidas.toLocaleString("pt-PT")}</span>
                </td>
                <td className="px-2 py-2 text-right text-slate-800">
                  Saldo {totals.saldo >= 0 ? "+" : "−"}
                  {Math.abs(totals.saldo).toLocaleString("pt-PT")}
                </td>
                <td className="px-2 py-2 text-slate-500" colSpan={2}>
                  Bónus: +{totals.bonusEnt.toLocaleString("pt-PT")} / −{totals.bonusSai.toLocaleString("pt-PT")}
                </td>
              </tr>
            </tfoot>
          </table>
        )}
      </div>
    </section>
  );
}

function FragmentRow({
  row,
  isOpen,
  onToggle,
}: {
  row: MovimentoRow;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const anulado = row.situacao === "A";
  const rowClasses = [
    "cursor-pointer hover:bg-slate-50/70",
    anulado ? "text-slate-400 line-through decoration-slate-300" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <>
      <tr className={rowClasses} onClick={onToggle}>
        <td className="py-2 pr-3 whitespace-nowrap text-slate-700">
          <div>{formatDate(row.data)}</div>
          <div className="text-[10px] text-slate-400">{formatTime(row.data)}</div>
        </td>
        <td className="py-2 pr-3 text-slate-700">
          <div className="font-medium">{composeDocumento(row)}</div>
          {row.referenciaExterna && (
            <div className="text-[10px] text-slate-500">Ref: {row.referenciaExterna}</div>
          )}
        </td>
        <td className="py-2 pr-3">
          <span className="flex flex-wrap items-center gap-1.5">
            <span
              className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium ${badgeClassFor(row.tipo)}`}
            >
              {row.tipoLabel}
            </span>
            {anulado && (
              <span className="rounded-full border border-slate-300 bg-slate-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-slate-500">
                Anulado
              </span>
            )}
          </span>
        </td>
        <td className="py-2 pr-3 text-slate-700">
          {row.contraparteNome ?? "—"}
          {row.contraparteTipo && row.contraparteNome && (
            <div className="text-[10px] text-slate-400">{contraparteLabel(row.contraparteTipo)}</div>
          )}
        </td>
        <td className={`py-2 pr-3 text-right font-medium ${qtyColor(row.quantidade)}`}>
          {signedQty(row.quantidade)}
        </td>
        <td className="py-2 pr-3 text-right text-slate-700 tabular-nums">
          {row.stockDepois.toLocaleString("pt-PT")}
        </td>
        <td className="py-2 pr-3 text-slate-600">{row.observacao ?? "—"}</td>
        <td className="py-2 text-slate-400">
          {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </td>
      </tr>
      {isOpen && (
        <tr className="bg-slate-50/60">
          <td colSpan={8} className="px-3 py-2">
            <div className="grid gap-x-6 gap-y-1 text-[11px] text-slate-600 sm:grid-cols-2 lg:grid-cols-4">
              <Detail label="Stock antes" value={row.stockAntes.toLocaleString("pt-PT")} />
              <Detail label="Stock depois" value={row.stockDepois.toLocaleString("pt-PT")} />
              <Detail
                label="Bónus +/−"
                value={
                  row.quantidadeBonusEnt > 0 || row.quantidadeBonusSai > 0
                    ? `+${row.quantidadeBonusEnt} / −${row.quantidadeBonusSai}`
                    : "—"
                }
              />
              <Detail
                label="Ex. bónus"
                value={row.existenciaBonusApos > 0 ? row.existenciaBonusApos.toLocaleString("pt-PT") : "—"}
              />
              <Detail label="PMC" value={fmtPrice4(row.pmcNovo)} />
              <Detail label="Preço" value={fmtPrice4(row.precoUnitario)} />
              <Detail label="Valor" value={fmtCurrency(row.valorLinha)} />
              <Detail label="Armazém" value={row.armazemNome ?? "—"} />
              <Detail label="Utilizador" value={row.utilizadorNome ?? "—"} />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function Detail({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <span className="text-slate-400">{label}: </span>
      <span className="text-slate-700">{value ?? "—"}</span>
    </div>
  );
}
