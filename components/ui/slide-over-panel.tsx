"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

/**
 * components/ui/slide-over-panel.tsx
 *
 * Painel lateral genérico — primeiro uso desta forma no projecto
 * (auditoria prévia confirmou: sem Radix/headless UI instalado, todo
 * "modal" existente é uma `<div>` de overlay reimplementada por ecrã;
 * ver components/encomendas/historico-produto-modal.tsx e
 * components/encomendas/product-picker.tsx para o padrão visual que
 * este primitivo generaliza, em vez de copiar pela quarta vez).
 *
 * Acessibilidade: Escape fecha; foco move-se para o painel ao abrir e
 * volta ao elemento que o abriu ao fechar; `role="dialog"`+
 * `aria-modal`+`aria-labelledby`; clique no backdrop fecha.
 */
export function SlideOverPanel({
  aberto,
  titulo,
  onFechar,
  children,
  acoes,
}: {
  aberto: boolean;
  titulo: string;
  onFechar: () => void;
  children: React.ReactNode;
  acoes?: React.ReactNode;
}) {
  const painelRef = useRef<HTMLDivElement>(null);
  const elementoAnterior = useRef<Element | null>(null);
  const tituloId = "slide-over-titulo";

  useEffect(() => {
    if (!aberto) return;
    elementoAnterior.current = document.activeElement;
    painelRef.current?.focus();

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onFechar();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      if (elementoAnterior.current instanceof HTMLElement) elementoAnterior.current.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aberto]);

  if (!aberto || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end">
      <div
        className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
        onClick={onFechar}
        aria-hidden="true"
      />
      <div
        ref={painelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={tituloId}
        tabIndex={-1}
        className="relative flex h-full w-full max-w-xl flex-col bg-[#eef4f6] shadow-2xl outline-none"
      >
        <div className="flex items-center justify-between border-b border-slate-200 bg-white/80 px-5 py-4 backdrop-blur-xl">
          <h2 id={tituloId} className="truncate text-[16px] font-semibold text-slate-900">
            {titulo}
          </h2>
          <div className="flex items-center gap-2">
            {acoes}
            <button
              type="button"
              onClick={onFechar}
              aria-label="Fechar"
              className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
            >
              <X className="h-4.5 w-4.5" />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-5">{children}</div>
      </div>
    </div>,
    document.body
  );
}
