"use client";

/**
 * components/encomendas/historico-produto-modal.tsx
 *
 * "Histórico 12 meses" por linha da encomenda — lazy/on-demand: só
 * chama a server action quando o utilizador abre o modal desta linha
 * em concreto, nunca ao carregar a tabela inteira. Ver
 * `getHistoricoProdutoAction` em `app/encomendas/actions.ts`.
 *
 * Modal manual (sem Radix/shadcn no projecto), mesmo padrão visual de
 * `components/encomendas/product-picker.tsx:224-253`
 * (`fixed inset-0 z-50 ... backdrop-blur-sm`).
 *
 * Não navega para fora da página nem toca no estado da encomenda em
 * preparação — é um `open`/`onClose` local ao botão, a árvore da
 * encomenda continua montada por baixo.
 */
import { useEffect, useState } from "react";
import { History, X } from "lucide-react";
import { getHistoricoProdutoAction } from "@/app/encomendas/actions";
import type { HistoricoProduto12MesesResult } from "@/lib/encomendas/historico-produto";

type ButtonProps = {
  produtoId: string;
  produtoDesignacao: string;
  /** Farmácia(s) a mostrar. Em modo grupo com farmácia conhecida da linha, passa só essa. */
  farmaciaIds: string[];
};

function fmt(v: number | null | undefined, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return digits === 0 ? String(Math.round(v)) : v.toFixed(digits);
}

/** Botão discreto por linha — abre o modal ao clicar. */
export function HistoricoProdutoButton({ produtoId, produtoDesignacao, farmaciaIds }: ButtonProps) {
  const [open, setOpen] = useState(false);

  if (farmaciaIds.length === 0) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Histórico 12 meses"
        className="inline-flex items-center gap-1 rounded-md border border-slate-200 p-1.5 text-slate-500 hover:border-cyan-300 hover:bg-cyan-50 hover:text-cyan-700"
      >
        <History className="h-3.5 w-3.5" />
      </button>
      {open && (
        <HistoricoProdutoModal
          produtoId={produtoId}
          produtoDesignacao={produtoDesignacao}
          farmaciaIds={farmaciaIds}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

type ModalState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ok"; data: HistoricoProduto12MesesResult };

function HistoricoProdutoModal({
  produtoId,
  produtoDesignacao,
  farmaciaIds,
  onClose,
}: ButtonProps & { onClose: () => void }) {
  const [state, setState] = useState<ModalState>({ status: "loading" });
  const farmaciaIdsKey = farmaciaIds.join(",");

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    getHistoricoProdutoAction({ produtoId, farmaciaIds }).then((r) => {
      if (cancelled) return;
      setState(r.ok ? { status: "ok", data: r.data } : { status: "error", error: r.error });
    });
    return () => {
      cancelled = true;
    };
    // farmaciaIds é recriado a cada render do caller — comparar pela
    // chave estável evita um loop de pedidos repetidos.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [produtoId, farmaciaIdsKey]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="mt-12 w-full max-w-3xl rounded-2xl border border-slate-200 bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-slate-900">Histórico · últimos 12 meses</h2>
            <p className="mt-0.5 truncate text-[12px] text-slate-500">{produtoDesignacao}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {state.status === "loading" && (
          <div className="py-10 text-center text-[12px] text-slate-400">A carregar histórico…</div>
        )}
        {state.status === "error" && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700">
            {state.error}
          </div>
        )}
        {state.status === "ok" && <HistoricoConteudo data={state.data} />}
      </div>
    </div>
  );
}

function HistoricoConteudo({ data }: { data: HistoricoProduto12MesesResult }) {
  const multiFarmacia = data.farmacias.length > 1;

  if (data.farmacias.length === 0) {
    return <div className="py-10 text-center text-[12px] text-slate-400">Sem farmácias para mostrar.</div>;
  }

  return (
    <div className="max-h-[70vh] space-y-4 overflow-y-auto">
      {data.farmacias.map((f) => (
        <div key={f.farmaciaId} className="rounded-xl border border-slate-100">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-slate-100 bg-slate-50/60 px-3 py-2">
            {multiFarmacia && (
              <span className="text-[12px] font-medium text-slate-700">{f.farmaciaNome}</span>
            )}
            <div className={`flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-600 ${multiFarmacia ? "" : "w-full justify-between"}`}>
              <span>
                <span className="text-slate-400">Stock actual:</span> {fmt(f.stockAtual)}
              </span>
              <span>
                <span className="text-slate-400">Média/dia:</span> {fmt(f.avgDaily, 2)}
              </span>
              <span>
                <span className="text-slate-400">Média/mês:</span> {fmt(f.monthlyVelocity, 1)}
              </span>
              <span>
                <span className="text-slate-400">Cobertura:</span>{" "}
                {f.coverageDays != null ? `${fmt(f.coverageDays)}d` : "—"}
              </span>
            </div>
          </div>

          {!f.temLedger && (
            <div className="border-b border-amber-100 bg-amber-50 px-3 py-1.5 text-[11px] text-amber-700">
              Sem ledger de movimentos ingerido para esta farmácia — os valores abaixo podem estar incompletos.
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-slate-100 text-left text-[10px] uppercase tracking-wider text-slate-400">
                  <th className="px-3 py-1.5">Mês</th>
                  <th className="px-3 py-1.5 text-right">Compras</th>
                  <th className="px-3 py-1.5 text-right">Vendas</th>
                </tr>
              </thead>
              <tbody>
                {f.meses.map((m) => (
                  <tr key={`${m.ano}-${m.mes}`} className="border-b border-slate-50">
                    <td className="px-3 py-1.5 text-slate-700">{m.label}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-slate-700">{fmt(m.compras)}</td>
                    <td
                      className={`px-3 py-1.5 text-right tabular-nums ${
                        m.vendas < 0 ? "text-rose-600" : "text-slate-700"
                      }`}
                    >
                      {fmt(m.vendas)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}
