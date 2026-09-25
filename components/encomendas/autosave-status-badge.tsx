"use client";

import { AlertTriangle, Check, CloudOff, Loader2, PenLine } from "lucide-react";
import type { EstadoAutosave } from "@/lib/encomendas/use-autosave-encomenda";

/**
 * Indicação visual do estado do autosave — sempre visível quando a
 * encomenda é editável, para nunca deixar o utilizador a adivinhar se
 * as suas alterações já estão a salvo no servidor.
 */
export function AutosaveStatusBadge({ estado }: { estado: EstadoAutosave }) {
  switch (estado.tipo) {
    case "limpo":
      return null;
    case "sujo":
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-700">
          <PenLine className="h-3 w-3" />
          Alterações por guardar
        </span>
      );
    case "a_guardar":
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-cyan-200 bg-cyan-50 px-2.5 py-1 text-[11px] font-medium text-cyan-700">
          <Loader2 className="h-3 w-3 animate-spin" />
          A guardar…
        </span>
      );
    case "guardado":
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-medium text-emerald-700">
          <Check className="h-3 w-3" />
          Guardado às {estado.hora}
        </span>
      );
    case "sem_ligacao":
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-orange-200 bg-orange-50 px-2.5 py-1 text-[11px] font-medium text-orange-700">
          <CloudOff className="h-3 w-3" />
          Sem ligação — alterações pendentes
        </span>
      );
    case "erro":
      return (
        <span
          className="inline-flex items-center gap-1.5 rounded-full border border-rose-200 bg-rose-50 px-2.5 py-1 text-[11px] font-medium text-rose-700"
          title={estado.mensagem}
        >
          <AlertTriangle className="h-3 w-3" />
          Não foi possível guardar
        </span>
      );
    case "conflito":
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-rose-300 bg-rose-100 px-2.5 py-1 text-[11px] font-semibold text-rose-800">
          <AlertTriangle className="h-3 w-3" />
          Conflito de versão
        </span>
      );
  }
}
