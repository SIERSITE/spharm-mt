"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Trash2 } from "lucide-react";
import { createOrderAction, type CreateOrderFormInput } from "@/app/encomendas/nova/actions";
import {
  resolveProductsByCnpAction,
  type ProductSearchResult,
} from "@/app/encomendas/nova/search";
import { ProductPicker } from "@/components/encomendas/product-picker";

type Line = {
  key: number;
  produtoId: string;
  cnp: number;
  designacao: string;
  fabricante: string | null;
  stockAtual: number | null;
  quantidadeSugerida: string;
  quantidadeAjustada: string;
  notas: string;
};

type Props = {
  farmacias: { id: string; nome: string }[];
};

type PrefillStash = {
  farmaciaNome?: string;
  farmaciaId?: string;
  lines: Array<{ cnp: number | string; quantidade?: number | string }>;
};

const PREFILL_KEY = "encomenda-prefill";

let lineKeyCounter = 0;
function nextKey(): number {
  return ++lineKeyCounter;
}

function fmtStock(v: number | null): string {
  if (v == null) return "—";
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(1);
}

export function OrderCreateClient({ farmacias }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [busy, startTransition] = useTransition();
  const [flash, setFlash] = useState<{ type: "ok" | "err" | "info"; msg: string } | null>(null);

  const [farmaciaId, setFarmaciaId] = useState(farmacias[0]?.id ?? "");
  const [nome, setNome] = useState("");
  const [linhas, setLinhas] = useState<Line[]>([]);
  const [prefilling, setPrefilling] = useState(false);

  // Prefill a partir do dashboard de sugestões.
  useEffect(() => {
    if (searchParams.get("prefill") !== "1") return;
    if (typeof window === "undefined") return;
    const raw = window.sessionStorage.getItem(PREFILL_KEY);
    if (!raw) return;
    window.sessionStorage.removeItem(PREFILL_KEY);

    let stash: PrefillStash;
    try {
      stash = JSON.parse(raw) as PrefillStash;
    } catch {
      return;
    }
    if (!Array.isArray(stash.lines) || stash.lines.length === 0) return;

    let resolvedFarmaciaId = "";
    if (stash.farmaciaId && farmacias.some((f) => f.id === stash.farmaciaId)) {
      resolvedFarmaciaId = stash.farmaciaId;
    } else if (stash.farmaciaNome) {
      resolvedFarmaciaId =
        farmacias.find((f) => f.nome === stash.farmaciaNome)?.id ?? "";
    }
    if (!resolvedFarmaciaId) {
      setFlash({
        type: "err",
        msg: "Farmácia da sugestão não encontrada — escolha uma farmácia e adicione os produtos manualmente.",
      });
      return;
    }
    setFarmaciaId(resolvedFarmaciaId);

    const cnps: number[] = [];
    const qtyByCnp = new Map<number, number>();
    for (const l of stash.lines) {
      const cnp = typeof l.cnp === "number" ? l.cnp : Number(l.cnp);
      if (!Number.isFinite(cnp) || cnp <= 0) continue;
      cnps.push(cnp);
      const q = typeof l.quantidade === "number" ? l.quantidade : Number(l.quantidade);
      if (Number.isFinite(q) && q > 0) qtyByCnp.set(cnp, q);
    }
    if (cnps.length === 0) return;

    setPrefilling(true);
    startTransition(async () => {
      try {
        const products = await resolveProductsByCnpAction({
          cnps,
          farmaciaId: resolvedFarmaciaId,
        });
        const newLines = products.map((p) => buildLine(p, qtyByCnp.get(p.cnp) ?? null));
        setLinhas(newLines);
        const missing = cnps.length - products.length;
        if (missing > 0) {
          setFlash({
            type: "info",
            msg: `${products.length} de ${cnps.length} produtos pré-preenchidos. ${missing} CNP não foram encontrados no catálogo.`,
          });
        } else {
          setFlash({
            type: "info",
            msg: `${products.length} produtos pré-preenchidos a partir da sugestão.`,
          });
        }
      } finally {
        setPrefilling(false);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function buildLine(p: ProductSearchResult, sugerida: number | null): Line {
    return {
      key: nextKey(),
      produtoId: p.id,
      cnp: p.cnp,
      designacao: p.designacao,
      fabricante: p.fabricante,
      stockAtual: p.stockAtual,
      quantidadeSugerida: sugerida != null ? String(sugerida) : "",
      quantidadeAjustada: sugerida != null ? String(sugerida) : "",
      notas: "",
    };
  }

  function handlePick(p: ProductSearchResult) {
    setLinhas((prev) => {
      const existingIdx = prev.findIndex((l) => l.produtoId === p.id);
      if (existingIdx >= 0) {
        // Já existe — incrementar quantidade ajustada e dar foco implicito ao chip existente.
        return prev.map((l, i) => {
          if (i !== existingIdx) return l;
          const current = Number(l.quantidadeAjustada || "0") || 0;
          return { ...l, quantidadeAjustada: String(current + 1) };
        });
      }
      return [...prev, buildLine(p, null)];
    });
  }

  function updateLine(key: number, patch: Partial<Line>) {
    setLinhas((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function removeLine(key: number) {
    setLinhas((prev) => prev.filter((l) => l.key !== key));
  }

  function handleFarmaciaChange(nextId: string) {
    if (nextId === farmaciaId) return;
    if (linhas.length > 0) {
      const ok = window.confirm(
        "Mudar de farmácia limpa as linhas actuais (o stock e a sugestão são por farmácia). Continuar?"
      );
      if (!ok) return;
      setLinhas([]);
    }
    setFarmaciaId(nextId);
  }

  function submit(finalize: boolean) {
    setFlash(null);

    if (linhas.length === 0) {
      setFlash({ type: "err", msg: "Adicione pelo menos um produto." });
      return;
    }

    const input: CreateOrderFormInput = {
      farmaciaId,
      nome: nome.trim() || `Encomenda ${new Date().toLocaleDateString("pt-PT")}`,
      finalize,
      linhas: linhas.map((l) => ({
        produtoId: l.produtoId,
        quantidadeSugerida: l.quantidadeSugerida ? Number(l.quantidadeSugerida) : null,
        quantidadeAjustada: l.quantidadeAjustada ? Number(l.quantidadeAjustada) : null,
        notas: l.notas.trim() || null,
      })),
    };

    startTransition(async () => {
      const result = await createOrderAction(input);
      if (result.ok) {
        setFlash({
          type: "ok",
          msg: finalize
            ? `Encomenda criada e finalizada. Outbox ID: ${result.outboxId}`
            : `Rascunho guardado (${result.listaEncomendaId}).`,
        });
        setNome("");
        setLinhas([]);
        setTimeout(() => router.push("/encomendas/lista"), 1200);
      } else {
        setFlash({ type: "err", msg: result.error });
      }
    });
  }

  const totalAjustada = linhas.reduce(
    (s, l) => s + (Number(l.quantidadeAjustada || "0") || 0),
    0
  );

  return (
    <div className="space-y-6">
      {flash && (
        <div
          className={`rounded-xl border px-4 py-3 text-[13px] ${
            flash.type === "ok"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : flash.type === "info"
                ? "border-cyan-200 bg-cyan-50 text-cyan-800"
                : "border-rose-200 bg-rose-50 text-rose-800"
          }`}
        >
          {flash.msg}
        </div>
      )}

      {/* Header fields */}
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label className="mb-1 block text-[12px] font-medium uppercase tracking-wider text-slate-500">
            Farmácia
          </label>
          <select
            value={farmaciaId}
            onChange={(e) => handleFarmaciaChange(e.target.value)}
            disabled={busy}
            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-[14px] text-slate-800 shadow-sm focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-400 disabled:opacity-50"
          >
            {farmacias.map((f) => (
              <option key={f.id} value={f.id}>
                {f.nome}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-[12px] font-medium uppercase tracking-wider text-slate-500">
            Nome da encomenda
          </label>
          <input
            type="text"
            value={nome}
            onChange={(e) => setNome(e.target.value)}
            placeholder={`Encomenda ${new Date().toLocaleDateString("pt-PT")}`}
            disabled={busy}
            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-[14px] text-slate-800 shadow-sm placeholder:text-slate-400 focus:border-cyan-400 focus:outline-none focus:ring-1 focus:ring-cyan-400 disabled:opacity-50"
          />
        </div>
      </div>

      {/* Picker */}
      <section className="rounded-xl border border-slate-200 bg-white">
        <div className="border-b border-slate-100 px-4 py-3">
          <h2 className="text-[14px] font-semibold text-slate-900">Adicionar produto</h2>
          <p className="mt-0.5 text-[12px] text-slate-500">
            Procure por CNP, designação ou fabricante. O stock mostrado é o da farmácia
            seleccionada.
          </p>
        </div>
        <div className="p-4">
          <ProductPicker
            farmaciaId={farmaciaId}
            disabled={busy || prefilling}
            onPick={handlePick}
          />
        </div>
      </section>

      {/* Lines */}
      <section className="rounded-xl border border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <div>
            <h2 className="text-[14px] font-semibold text-slate-900">
              Linhas da encomenda
            </h2>
            <p className="mt-0.5 text-[12px] text-slate-500">
              {linhas.length === 0
                ? "Sem linhas — adicione produtos acima."
                : `${linhas.length} linha${linhas.length === 1 ? "" : "s"} · total ajustado: ${totalAjustada}`}
            </p>
          </div>
        </div>

        {linhas.length === 0 ? (
          <div className="px-4 py-10 text-center text-[12px] text-slate-400">
            {prefilling ? "A pré-preencher a partir da sugestão…" : "Nenhum produto adicionado."}
          </div>
        ) : (
          <ul className="divide-y divide-slate-50">
            {linhas.map((l) => (
              <li key={l.key} className="px-4 py-3">
                <div className="grid gap-3 md:grid-cols-[1fr_90px_100px_100px_1fr_auto]">
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-medium text-slate-900">
                      {l.designacao}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-[11px] text-slate-500">
                      <span className="font-mono">CNP {l.cnp}</span>
                      {l.fabricante && (
                        <>
                          <span className="text-slate-300">·</span>
                          <span>{l.fabricante}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <div>
                    <label className="mb-1 block text-[10px] uppercase tracking-wider text-slate-400">
                      Stock
                    </label>
                    <div
                      className={`px-2.5 py-2 text-[13px] font-medium ${
                        l.stockAtual == null
                          ? "text-slate-400"
                          : l.stockAtual <= 0
                            ? "text-rose-600"
                            : "text-slate-700"
                      }`}
                    >
                      {fmtStock(l.stockAtual)}
                    </div>
                  </div>
                  <div>
                    <label className="mb-1 block text-[10px] uppercase tracking-wider text-slate-400">
                      Qt. sugerida
                    </label>
                    <input
                      type="number"
                      min="0"
                      value={l.quantidadeSugerida}
                      onChange={(e) =>
                        updateLine(l.key, { quantidadeSugerida: e.target.value })
                      }
                      disabled={busy}
                      className="w-full rounded-lg border border-slate-200 px-2.5 py-2 text-[13px] focus:border-cyan-400 focus:outline-none disabled:opacity-50"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-[10px] uppercase tracking-wider text-slate-400">
                      Qt. ajustada
                    </label>
                    <input
                      type="number"
                      min="0"
                      value={l.quantidadeAjustada}
                      onChange={(e) =>
                        updateLine(l.key, { quantidadeAjustada: e.target.value })
                      }
                      disabled={busy}
                      className="w-full rounded-lg border border-slate-200 px-2.5 py-2 text-[13px] focus:border-cyan-400 focus:outline-none disabled:opacity-50"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-[10px] uppercase tracking-wider text-slate-400">
                      Notas
                    </label>
                    <input
                      type="text"
                      value={l.notas}
                      onChange={(e) => updateLine(l.key, { notas: e.target.value })}
                      placeholder="opcional"
                      disabled={busy}
                      className="w-full rounded-lg border border-slate-200 px-2.5 py-2 text-[13px] placeholder:text-slate-300 focus:border-cyan-400 focus:outline-none disabled:opacity-50"
                    />
                  </div>
                  <div className="flex items-end">
                    <button
                      type="button"
                      onClick={() => removeLine(l.key)}
                      disabled={busy}
                      title="Remover linha"
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-2 text-[12px] text-slate-500 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-700 disabled:opacity-50"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Actions */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => submit(false)}
          disabled={busy || linhas.length === 0}
          className="rounded-xl border border-slate-300 bg-white px-5 py-2.5 text-[13px] font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50"
        >
          {busy ? "A guardar..." : "Guardar rascunho"}
        </button>
        <button
          type="button"
          onClick={() => submit(true)}
          disabled={busy || linhas.length === 0}
          className="rounded-xl border border-cyan-500 bg-cyan-600 px-5 py-2.5 text-[13px] font-medium text-white shadow-sm hover:bg-cyan-700 disabled:opacity-50"
        >
          {busy ? "A finalizar..." : "Finalizar e enviar para fila"}
        </button>
      </div>
    </div>
  );
}
