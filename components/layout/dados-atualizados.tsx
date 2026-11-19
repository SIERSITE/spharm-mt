"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Clock } from "lucide-react";
import {
  formatarDataHora,
  TEXTO_SEM_INFO,
  textoCabecalho,
  type DadosAtualizados,
} from "@/lib/dados-atualizados-core";

/**
 * «Dados atualizados até DD/MM/AAAA, HH:mm» — no cabeçalho, em todos os
 * ecrãs. Lê /api/dados-atualizados (data real de receção, não a hora
 * actual); volta a ler ao mudar de página e ao regressar ao separador do
 * browser, porque o layout não é remontado em navegação.
 */
export function DadosAtualizadosCabecalho() {
  const pathname = usePathname();
  const [dados, setDados] = useState<DadosAtualizados | null>(null);
  const [falhou, setFalhou] = useState(false);
  const [aberto, setAberto] = useState(false);
  const raiz = useRef<HTMLDivElement>(null);

  const ler = useCallback(async () => {
    try {
      const r = await fetch("/api/dados-atualizados", { cache: "no-store", credentials: "same-origin" });
      if (!r.ok) throw new Error(String(r.status));
      const j = (await r.json()) as { ok: boolean } & DadosAtualizados;
      if (!j.ok) throw new Error("nok");
      setDados({ ate: j.ate, farmacias: j.farmacias });
      setFalhou(false);
    } catch {
      setFalhou(true);
    }
  }, []);

  useEffect(() => {
    void ler();
  }, [ler, pathname]);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible") void ler();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [ler]);

  useEffect(() => {
    if (!aberto) return;
    const onDoc = (e: MouseEvent) => {
      if (raiz.current && !raiz.current.contains(e.target as Node)) setAberto(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAberto(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [aberto]);

  // Antes da 1.ª resposta não se mostra nada (evita piscar um texto errado).
  if (!dados && !falhou) return <div data-testid="dados-atualizados" aria-hidden className="h-5 w-0" />;

  const texto = dados ? textoCabecalho(dados.ate) : TEXTO_SEM_INFO;
  const curto = dados?.ate ? `Até ${formatarDataHora(dados.ate)}` : "Sem atualização";

  return (
    <div ref={raiz} className="sm:relative" data-testid="dados-atualizados">
      <button
        type="button"
        onClick={() => setAberto((v) => !v)}
        aria-expanded={aberto}
        aria-haspopup="dialog"
        title={texto}
        data-testid="dados-atualizados-botao"
        className="inline-flex max-w-full items-center gap-1.5 rounded-2xl px-2.5 py-2 text-xs font-medium text-slate-500 transition hover:bg-white/50 hover:text-slate-700 sm:text-sm"
      >
        <Clock className="h-4 w-4 shrink-0" aria-hidden />
        <span className="hidden sm:inline" data-testid="dados-atualizados-texto">{texto}</span>
        <span className="sm:hidden" data-testid="dados-atualizados-texto-curto">{curto}</span>
      </button>

      {aberto && (
        <div
          role="dialog"
          aria-label="Última atualização de cada farmácia"
          data-testid="dados-atualizados-detalhe"
          className="absolute left-3 right-3 top-full z-50 mt-1 rounded-2xl sm:left-auto sm:right-0 sm:mt-2 sm:w-[22rem] border border-[rgba(165,190,196,0.4)] bg-white p-4 text-sm shadow-xl"
        >
          <p className="mb-3 font-semibold text-slate-700">Última atualização de cada farmácia</p>
          {dados && dados.farmacias.length > 0 ? (
            <ul className="space-y-2">
              {dados.farmacias.map((f) => (
                <li key={f.id} className="flex items-baseline justify-between gap-3">
                  <span className="text-slate-700">{f.nome}</span>
                  <span className="whitespace-nowrap text-right text-slate-500">
                    {f.ate ? formatarDataHora(f.ate) : TEXTO_SEM_INFO}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-slate-500">{TEXTO_SEM_INFO}</p>
          )}
          <p className="mt-3 text-xs text-slate-400">
            Data e hora em que recebemos os dados mais recentes de cada farmácia.
          </p>
        </div>
      )}
    </div>
  );
}
