"use client";

import { useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Check, CircleAlert, Search, X } from "lucide-react";
import type { EstadoRevisao, RevisaoGlobal } from "@/lib/catalog/revisao-global";
import { resolverRevisaoGlobalAction } from "@/app/admin/catalogo/revisao-global/actions";

type Props = {
  linhas: RevisaoGlobal[];
  total: number;
  page: number;
  pageSize: number;
  estado: EstadoRevisao;
  tenantSlug?: string;
  cnp?: number;
  tenants: Array<{ tenantSlug: string; n: number }>;
  pendentes: number;
  resolvidas: number;
};

function fmt(d: Date | string | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("pt-PT", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

export function GlobalReviewList(p: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [cnpBusca, setCnpBusca] = useState(p.cnp ? String(p.cnp) : "");

  const irPara = (patch: Record<string, string | undefined>) => {
    const q = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === "") q.delete(k);
      else q.set(k, v);
    }
    // Qualquer mudança de filtro volta à primeira página: manter a página
    // corrente sobre um conjunto diferente mostra um vazio que parece
    // "não há nada" quando é só "não há nada NESTA página".
    if (!("page" in patch)) q.delete("page");
    router.push(`${pathname}?${q.toString()}`);
  };

  const paginas = Math.max(1, Math.ceil(p.total / p.pageSize));

  return (
    <div className="space-y-4">
      {/* ── filtros ───────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        {(["PENDENTE", "RESOLVIDA", "TODAS"] as EstadoRevisao[]).map((e) => (
          <button
            key={e}
            onClick={() => irPara({ estado: e === "PENDENTE" ? undefined : e })}
            className={`rounded-md border px-3 py-1.5 text-sm ${
              p.estado === e
                ? "border-slate-900 bg-slate-900 text-white"
                : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
            }`}
          >
            {e === "PENDENTE"
              ? `Por resolver (${p.pendentes})`
              : e === "RESOLVIDA"
                ? `Resolvidas (${p.resolvidas})`
                : "Todas"}
          </button>
        ))}

        <select
          value={p.tenantSlug ?? ""}
          onChange={(ev) => irPara({ tenant: ev.target.value || undefined })}
          className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700"
        >
          <option value="">Todos os tenants</option>
          {p.tenants.map((t) => (
            <option key={t.tenantSlug} value={t.tenantSlug}>
              {t.tenantSlug} ({t.n})
            </option>
          ))}
        </select>

        <div className="flex items-center gap-1">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              value={cnpBusca}
              onChange={(e) => setCnpBusca(e.target.value.replace(/\D/g, ""))}
              onKeyDown={(e) => {
                if (e.key === "Enter") irPara({ cnp: cnpBusca || undefined });
              }}
              placeholder="CNP"
              className="w-32 rounded-md border border-slate-200 py-1.5 pl-8 pr-2 text-sm"
            />
          </div>
          {p.cnp !== undefined && (
            <button
              onClick={() => { setCnpBusca(""); irPara({ cnp: undefined }); }}
              className="rounded-md border border-slate-200 p-1.5 text-slate-500 hover:bg-slate-50"
              aria-label="limpar CNP"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* ── lista ─────────────────────────────────────────────────── */}
      {p.linhas.length === 0 ? (
        <p className="rounded-lg border border-slate-200 bg-white p-6 text-sm text-slate-500">
          Nada a mostrar com este filtro.
        </p>
      ) : (
        <ul className="space-y-3">
          {p.linhas.map((r) => (
            <LinhaRevisao key={r.id} r={r} />
          ))}
        </ul>
      )}

      {/* ── paginação ─────────────────────────────────────────────── */}
      {paginas > 1 && (
        <div className="flex items-center justify-between text-sm text-slate-600">
          <span>
            Página {p.page} de {paginas} · {p.total} no total
          </span>
          <div className="flex gap-2">
            <button
              disabled={p.page <= 1}
              onClick={() => irPara({ page: String(p.page - 1) })}
              className="rounded-md border border-slate-200 px-3 py-1 disabled:opacity-40"
            >
              Anterior
            </button>
            <button
              disabled={p.page >= paginas}
              onClick={() => irPara({ page: String(p.page + 1) })}
              className="rounded-md border border-slate-200 px-3 py-1 disabled:opacity-40"
            >
              Seguinte
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function LinhaRevisao({ r }: { r: RevisaoGlobal }) {
  const [motivo, setMotivo] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [pendente, startTransition] = useTransition();
  const resolvida = r.resolvidoEm !== null;

  const submeter = () => {
    setErro(null);
    startTransition(async () => {
      const res = await resolverRevisaoGlobalAction({ id: r.id, motivo });
      if (!res.ok) setErro(res.erro);
      else setMotivo("");
    });
  };

  return (
    <li className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-sm font-semibold text-slate-900">{r.cnp}</span>
        <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-xs text-slate-600">
          {r.tenantSlug}
        </span>
        <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-xs text-slate-600">
          {r.tipo}
        </span>
        <span className="text-xs text-slate-400">detectada {fmt(r.detectadoEm)}</span>
      </div>

      {/* Lado a lado: é a comparação que a pessoa veio fazer. */}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="rounded-md border border-sky-200 bg-sky-50 p-3">
          <p className="text-xs font-medium uppercase tracking-wide text-sky-700">Catálogo global</p>
          <p className="mt-1 text-sm text-slate-900">{r.valorGlobal ?? "—"}</p>
          <p className="mt-1 text-xs text-slate-500">
            {r.globalOrigem ?? "—"}
            {r.globalConfidence !== null && ` · confiança ${r.globalConfidence.toFixed(2)}`}
            {r.globalVersaoRegras && ` · ${r.globalVersaoRegras}`}
          </p>
          {r.globalCategoria && (r.globalCategoria !== null) && (
            <p className="mt-1 text-xs text-slate-400">
              hoje: {r.globalCategoria} &gt; {r.globalSubcategoria ?? "—"}
            </p>
          )}
        </div>
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
          <p className="text-xs font-medium uppercase tracking-wide text-amber-700">No tenant</p>
          <p className="mt-1 text-sm text-slate-900">{r.valorLocal ?? "—"}</p>
        </div>
      </div>

      {r.detalhe && <p className="mt-2 text-xs text-slate-500">{r.detalhe}</p>}

      {resolvida ? (
        <p className="mt-3 flex items-center gap-2 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          <Check className="h-4 w-4 shrink-0" />
          <span>
            Resolvida {fmt(r.resolvidoEm)} por{" "}
            <strong>{r.resolvidoPor ?? "(sem autor registado)"}</strong>
            {r.resolucao && ` — ${r.resolucao}`}
          </span>
        </p>
      ) : (
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap gap-2">
            <input
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              placeholder="O que ficou decidido (obrigatório)"
              className="min-w-[16rem] flex-1 rounded-md border border-slate-200 px-3 py-1.5 text-sm"
            />
            <button
              onClick={submeter}
              disabled={pendente || motivo.trim().length === 0}
              className="rounded-md bg-slate-900 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40"
            >
              {pendente ? "A registar…" : "Marcar resolvida"}
            </button>
          </div>
          <p className="text-xs text-slate-400">
            Regista que foi vista e o que se decidiu. Não altera classificações —
            nem no tenant, nem no catálogo global.
          </p>
          {erro && (
            <p className="flex items-center gap-2 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800">
              <CircleAlert className="h-4 w-4 shrink-0" />
              {erro}
            </p>
          )}
        </div>
      )}
    </li>
  );
}
