"use client";

/**
 * components/reporting/filtro-generico.tsx
 *
 * O filtro «Genérico» — UM componente para todos os mapas e listagens de produtos. Escolha única de 3 estados:
 * Todos (omissão) · Apenas genéricos · Apenas não genéricos. Regra e semântica em `lib/catalog/generico-filtro.ts`.
 *
 * O valor que viaja é `undefined` (Todos) | `GENERICO` | `NAO_GENERICO`. Aplica-se no servidor, antes de totais e paginação.
 */
import { FilterPill } from "@/components/reporting/filter-panel";
import { ROTULO_GENERICO, ROTULO_GENERICO_TODOS, lerValorGenerico, rotuloChipGenerico, type ValorGenerico } from "@/lib/catalog/generico-filtro";

export type ContagensGenerico = { genericos: number; naoGenericos: number };

export function FiltroGenerico({
  valor,
  onChange,
  contagens,
  label = "Genérico",
}: {
  valor: ValorGenerico | undefined;
  onChange: (v: ValorGenerico | undefined) => void;
  contagens?: ContagensGenerico;
  label?: string;
}) {
  const atual = lerValorGenerico(valor);
  const opcoes: Array<{ v: ValorGenerico | undefined; rotulo: string; n?: number }> = [
    { v: undefined, rotulo: ROTULO_GENERICO_TODOS, n: contagens ? contagens.genericos + contagens.naoGenericos : undefined },
    { v: "GENERICO", rotulo: ROTULO_GENERICO.GENERICO, n: contagens?.genericos },
    { v: "NAO_GENERICO", rotulo: ROTULO_GENERICO.NAO_GENERICO, n: contagens?.naoGenericos },
  ];
  return (
    <div data-testid="filtro-generico" className="min-w-0">
      <div className="mb-1 text-[11px] font-medium uppercase tracking-[0.12em] text-slate-500">{label}</div>
      <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
        {opcoes.map((o) => {
          const ativo = atual === o.v;
          return (
            <button
              key={o.v ?? "TODOS"}
              type="button"
              role="radio"
              aria-checked={ativo}
              data-valor={o.v ?? "TODOS"}
              onClick={() => onChange(o.v)}
              className={`rounded-full border px-3 py-1.5 text-[12px] transition ${
                ativo ? "border-emerald-600 bg-emerald-600 font-medium text-white" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
              }`}
            >
              {o.rotulo}
              {o.n !== undefined && <span className={`ml-1.5 text-[10px] ${ativo ? "text-emerald-100" : "text-slate-400"}`}>{o.n}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** O chip removível da selecção (só quando ≠ Todos) — o mesmo `FilterPill` dos outros eixos. */
export function ChipGenerico({ valor, onRemove }: { valor: ValorGenerico | undefined; onRemove: () => void }) {
  const v = lerValorGenerico(valor);
  return v ? <FilterPill label={rotuloChipGenerico(v)} onRemove={onRemove} /> : null;
}
