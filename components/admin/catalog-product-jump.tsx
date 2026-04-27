"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Search } from "lucide-react";

/**
 * Pequeno formulário que envia o admin para a página de revisão de um
 * produto específico, dado o CNP. Aceita qualquer string numérica — o
 * resolver no servidor (loadReviewDetail mode="cnp") garante o lookup.
 */
export function CatalogProductJump() {
  const router = useRouter();
  const [value, setValue] = useState("");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const v = value.trim();
    if (!v) return;
    router.push(`/admin/catalogo/revisao/${encodeURIComponent(v)}`);
  }

  return (
    <form onSubmit={submit} className="flex items-center gap-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
        <input
          inputMode="numeric"
          pattern="[0-9]*"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="CNP"
          className="h-9 w-32 rounded-lg border border-slate-200 bg-white pl-8 pr-2 text-[13px] font-medium text-slate-800 outline-none transition focus:border-cyan-400 focus:ring-2 focus:ring-cyan-100"
        />
      </div>
      <button
        type="submit"
        className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-[12px] font-medium text-slate-700 transition hover:border-cyan-400 hover:text-cyan-700"
      >
        Abrir produto
      </button>
    </form>
  );
}
