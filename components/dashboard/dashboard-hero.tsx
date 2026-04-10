"use client";

import { Activity, ShieldCheck, Focus, Sparkles } from "lucide-react";

const suggestedTransfers = [
  {
    product: "Brufen 600 mg comp.",
    from: "Farmácia A",
    to: "Farmácia B",
    quantity: 8,
  },
  {
    product: "Ben-u-ron 1 g comp.",
    from: "Farmácia B",
    to: "Farmácia A",
    quantity: 12,
  },
  {
    product: "Rosucor 20 mg comp.",
    from: "Farmácia A",
    to: "Farmácia B",
    quantity: 4,
  },
];

export function DashboardHero() {
  return (
    <section className="relative overflow-hidden rounded-[28px] border border-slate-200/60 bg-white/72 p-6 shadow-[0_20px_50px_rgba(15,23,42,0.05)] backdrop-blur-xl">
      <div className="relative z-10 grid gap-6 lg:grid-cols-[1.35fr_0.95fr]">
        <div>
          <div className="mb-5 flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-[11px] font-semibold text-emerald-600">
              Estado operacional
            </span>
            <span className="inline-flex items-center rounded-full border border-emerald-100 bg-emerald-50/70 px-3 py-1 text-[11px] font-semibold text-emerald-600/80">
              Monitorização entre farmácias
            </span>
          </div>

          <h2 className="max-w-[680px] text-[22px] font-semibold leading-[30px] tracking-[-0.02em] text-slate-900">
            Cobertura, rotação e diferenças operacionais
          </h2>

          <p className="mt-3 max-w-[680px] text-[13px] leading-6 text-slate-500">
            Leitura consolidada de stock entre farmácias, com sugestões de
            transferências, diferenças de cobertura e referências com rotação desigual.
          </p>

          <div className="mt-7 grid gap-3 sm:grid-cols-3">
            <div className="rounded-[20px] border border-white/70 bg-white/78 p-4 shadow-[0_10px_30px_rgba(15,23,42,0.04)] backdrop-blur-md">
              <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-600">
                <Activity className="h-[18px] w-[18px]" />
              </div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-400">
                Farmácias
              </div>
              <div className="mt-1 text-sm font-semibold text-slate-800">
                2 em análise
              </div>
            </div>

            <div className="rounded-[20px] border border-white/70 bg-white/78 p-4 shadow-[0_10px_30px_rgba(15,23,42,0.04)] backdrop-blur-md">
              <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-600">
                <ShieldCheck className="h-[18px] w-[18px]" />
              </div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-400">
                Transferências
              </div>
              <div className="mt-1 text-sm font-semibold text-slate-800">
                14 sugeridas
              </div>
            </div>

            <div className="rounded-[20px] border border-white/70 bg-white/78 p-4 shadow-[0_10px_30px_rgba(15,23,42,0.04)] backdrop-blur-md">
              <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-600">
                <Focus className="h-[18px] w-[18px]" />
              </div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-400">
                Foco
              </div>
              <div className="mt-1 text-sm font-semibold text-slate-800">
                Cobertura e rotação
              </div>
            </div>
          </div>

          <div className="mt-6 rounded-[20px] border border-slate-100 bg-slate-50/72 p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-400">
                Transferências sugeridas
              </div>
              <span className="text-[11px] font-medium text-slate-500">
                Top 3
              </span>
            </div>

            <div className="space-y-3">
              {suggestedTransfers.map((item) => (
                <div
                  key={`${item.product}-${item.from}-${item.to}`}
                  className="rounded-xl border border-white/80 bg-white/82 px-3 py-3"
                >
                  <div className="text-sm font-semibold text-slate-800">
                    {item.product}
                  </div>
                  <div className="mt-1 text-[13px] text-slate-500">
                    {item.quantity} un. · {item.from} → {item.to}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="rounded-[24px] border border-white/70 bg-white/78 p-5 shadow-[0_16px_40px_rgba(15,23,42,0.05)] backdrop-blur-md">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-400">
                Leitura executiva
              </div>
              <h3 className="mt-2 text-[18px] font-semibold leading-7 tracking-[-0.02em] text-slate-900">
                Sinais operacionais entre farmácias
              </h3>
            </div>

            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-600">
              <Sparkles className="h-[18px] w-[18px]" />
            </div>
          </div>

          <div className="space-y-5">
            <div>
              <div className="mb-2 flex items-center justify-between gap-3">
                <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-400">
                  Tendência
                </div>
                <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-600">
                  +12%
                </span>
              </div>

              <div className="text-sm font-semibold text-slate-800">
                Cobertura e procura por farmácia
              </div>
            </div>

            <div className="rounded-[20px] border border-slate-100 bg-slate-50/72 p-4">
              <div className="mb-4 flex items-end justify-between">
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-400">
                    Transferências sugeridas
                  </div>
                  <div className="mt-1 text-sm font-semibold text-slate-800">
                    14 movimentos entre farmácias
                  </div>
                </div>

                <div className="text-right">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-400">
                    Cobertura média
                  </div>
                  <div className="mt-1 text-sm font-semibold text-slate-800">
                    4,2 dias
                  </div>
                </div>
              </div>

              <div className="mb-3 flex h-24 items-end gap-2">
                {[32, 46, 40, 58, 66, 61, 74].map((value, index) => (
                  <div
                    key={index}
                    className="flex flex-1 flex-col items-center gap-2"
                  >
                    <div
                      className="w-full rounded-t-full bg-gradient-to-t from-emerald-500/75 to-emerald-300/35"
                      style={{ height: `${value}px` }}
                    />
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-7 text-center text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                <span>S</span>
                <span>T</span>
                <span>Q</span>
                <span>Q</span>
                <span>S</span>
                <span>S</span>
                <span>D</span>
              </div>

              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-white/80 bg-white/82 px-3 py-3">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">
                    Cobertura baixa
                  </div>
                  <div className="mt-1 text-sm font-semibold text-slate-800">
                    3 diferenças a acompanhar
                  </div>
                </div>

                <div className="rounded-xl border border-white/80 bg-white/82 px-3 py-3">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">
                    Rotação desigual
                  </div>
                  <div className="mt-1 text-sm font-semibold text-slate-800">
                    8 referências a rever
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}