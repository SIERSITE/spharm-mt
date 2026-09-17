"use client";

/**
 * components/vendas-manutencao/manutencao-lista-client.tsx
 *
 * Ecrã principal de "Manutenção de Vendas" — lista as manutenções já
 * criadas. Estado (activa/anulada), origem (automática/ajustada), e as
 * acções Editar/Anular/Nova.
 */
import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { PlusCircle, Pencil, Ban } from "lucide-react";
import { AppShell } from "@/components/layout/app-shell";
import { anularManutencaoAction } from "@/app/vendas/manutencao/actions";
import type { ManutencaoResumo } from "@/lib/vendas-manutencao/tipos";

const MES_LABEL = [
  "Jan", "Fev", "Mar", "Abr", "Mai", "Jun",
  "Jul", "Ago", "Set", "Out", "Nov", "Dez",
];

function fmtMes(ano: number, mes: number): string {
  return `${MES_LABEL[mes - 1]}/${String(ano).slice(-2)}`;
}

function fmtQtd(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toLocaleString("pt-PT", { maximumFractionDigits: 3 });
}

const ORIGEM_LABEL: Record<ManutencaoResumo["origemDistribuicao"], string> = {
  AUTOMATICA: "Automática",
  MANUAL_AJUSTADA: "Ajustada à mão",
};

type Props = { manutencoesIniciais: ManutencaoResumo[] };

export function ManutencaoListaClient({ manutencoesIniciais }: Props) {
  const [manutencoes, setManutencoes] = useState(manutencoesIniciais);
  const [filtro, setFiltro] = useState<"ATIVA" | "ANULADA" | "TODAS">("ATIVA");
  const [aAnular, setAAnular] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [erro, setErro] = useState<string | null>(null);

  const visiveis = useMemo(
    () => (filtro === "TODAS" ? manutencoes : manutencoes.filter((m) => m.estado === filtro)),
    [manutencoes, filtro],
  );

  function confirmarAnulacao(id: string) {
    setErro(null);
    startTransition(async () => {
      const r = await anularManutencaoAction(id);
      if (!r.ok) {
        setErro(r.erro);
        return;
      }
      setManutencoes((prev) =>
        prev.map((m) => (m.id === id ? { ...m, estado: "ANULADA" } : m)),
      );
      setAAnular(null);
    });
  }

  return (
    <AppShell>
      <div className="space-y-4">
        <section className="flex items-start justify-between gap-4">
          <div className="space-y-0.5">
            <div className="text-xs font-medium text-slate-500">Vendas</div>
            <h1 className="text-[28px] font-semibold tracking-tight text-slate-900">
              Manutenção de Vendas
            </h1>
            <p className="text-[13px] text-slate-600">
              Quantidades adicionais para um artigo, distribuídas por farmácia e por mês —
              separadas das vendas reais, opt-in no mapa de Vendas.
            </p>
          </div>
          <Link
            href="/vendas/manutencao/nova"
            className="mt-1 inline-flex items-center gap-1.5 rounded-xl bg-cyan-600 px-4 py-2 text-[13px] font-medium text-white shadow-sm transition hover:bg-cyan-700"
          >
            <PlusCircle className="h-4 w-4" aria-hidden />
            Nova manutenção
          </Link>
        </section>

        <div className="flex items-center gap-1.5">
          {(["ATIVA", "ANULADA", "TODAS"] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFiltro(f)}
              className={`rounded-full border px-3 py-1 text-[12px] font-medium transition ${
                filtro === f
                  ? "border-cyan-500 bg-cyan-50 text-cyan-700"
                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
              }`}
            >
              {f === "ATIVA" ? "Activas" : f === "ANULADA" ? "Anuladas" : "Todas"}
            </button>
          ))}
        </div>

        {erro && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[13px] text-rose-700">
            {erro}
          </div>
        )}

        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500">
                <th className="px-4 py-2.5 font-medium">Artigo</th>
                <th className="px-4 py-2.5 font-medium">Período</th>
                <th className="px-4 py-2.5 font-medium text-right">Quantidade</th>
                <th className="px-4 py-2.5 font-medium text-right">Nº meses</th>
                <th className="px-4 py-2.5 font-medium">Origem</th>
                <th className="px-4 py-2.5 font-medium">Estado</th>
                <th className="px-4 py-2.5 font-medium">Criado por</th>
                <th className="px-4 py-2.5 font-medium text-right">Acções</th>
              </tr>
            </thead>
            <tbody>
              {visiveis.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-slate-400">
                    Sem manutenções {filtro === "ATIVA" ? "activas" : filtro === "ANULADA" ? "anuladas" : ""}.
                  </td>
                </tr>
              )}
              {visiveis.map((m) => {
                const mesFinal = (() => {
                  const idx = m.mesInicialAno * 12 + (m.mesInicialMes - 1) + (m.numMeses - 1);
                  return { ano: Math.floor(idx / 12), mes: (idx % 12) + 1 };
                })();
                return (
                  <tr key={m.id} className="border-b border-slate-100 last:border-b-0 hover:bg-slate-50">
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-slate-900">{m.designacao}</div>
                      <div className="font-mono text-[11px] text-slate-500">CNP {m.cnp}</div>
                    </td>
                    <td className="px-4 py-2.5 text-slate-700">
                      {fmtMes(m.mesInicialAno, m.mesInicialMes)} – {fmtMes(mesFinal.ano, mesFinal.mes)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-medium text-slate-900">{fmtQtd(m.quantidadeTotal)}</td>
                    <td className="px-4 py-2.5 text-right text-slate-700">{m.numMeses}</td>
                    <td className="px-4 py-2.5 text-slate-600">{ORIGEM_LABEL[m.origemDistribuicao]}</td>
                    <td className="px-4 py-2.5">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${
                          m.estado === "ATIVA"
                            ? "bg-emerald-50 text-emerald-700"
                            : "bg-slate-100 text-slate-500"
                        }`}
                      >
                        {m.estado === "ATIVA" ? "Activa" : "Anulada"}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-slate-600">{m.criadoPorNome}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center justify-end gap-2">
                        <Link
                          href={`/vendas/manutencao/${m.id}`}
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1 text-[12px] text-slate-600 transition hover:bg-slate-50"
                        >
                          <Pencil className="h-3.5 w-3.5" aria-hidden />
                          Editar
                        </Link>
                        {m.estado === "ATIVA" && (
                          <button
                            type="button"
                            onClick={() => setAAnular(m.id)}
                            className="inline-flex items-center gap-1 rounded-lg border border-rose-200 px-2.5 py-1 text-[12px] text-rose-600 transition hover:bg-rose-50"
                          >
                            <Ban className="h-3.5 w-3.5" aria-hidden />
                            Anular
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {aAnular && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-5 shadow-xl">
            <h2 className="text-[15px] font-semibold text-slate-900">Anular manutenção?</h2>
            <p className="mt-2 text-[13px] text-slate-600">
              A manutenção deixa imediatamente de contribuir para o mapa de Vendas. O
              histórico fica preservado — não é possível reverter esta acção a partir daqui.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setAAnular(null)}
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-[13px] text-slate-600 hover:bg-slate-50"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={isPending}
                onClick={() => confirmarAnulacao(aAnular)}
                className="rounded-lg bg-rose-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-rose-700 disabled:opacity-50"
              >
                {isPending ? "A anular…" : "Anular"}
              </button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
