"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import {
  formatarAtualizacao,
  TEXTO_SEM_ATUALIZACAO,
  TITULO_BLOCO,
  type UltimaAtualizacaoFarmacia,
} from "@/lib/ultima-atualizacao-core";

/**
 * «Última atualização» — fundo do menu lateral, antes da identificação do
 * utilizador. Uma linha por farmácia acessível: nome, data e hora. Só texto:
 * sem clique, painel ou tooltip. Volta a ler ao mudar de ecrã e ao regressar
 * ao separador do browser (o layout não é remontado em navegação).
 */
export function UltimaAtualizacaoMenu() {
  const pathname = usePathname();
  const [farmacias, setFarmacias] = useState<UltimaAtualizacaoFarmacia[] | null>(null);

  const ler = useCallback(async () => {
    try {
      const r = await fetch("/api/ultima-atualizacao", { cache: "no-store", credentials: "same-origin" });
      if (!r.ok) return;
      const j = (await r.json()) as { ok: boolean; farmacias?: UltimaAtualizacaoFarmacia[] };
      if (j.ok && Array.isArray(j.farmacias)) setFarmacias(j.farmacias);
    } catch {
      /* mantém o último valor conhecido */
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

  if (!farmacias || farmacias.length === 0) return null;

  return (
    <div data-testid="ultima-atualizacao" className="shrink-0 border-t border-[rgba(165,190,196,0.25)] px-6 py-3">
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7f99a1]">{TITULO_BLOCO}</div>
      <ul className="max-h-[34vh] space-y-2 overflow-y-auto pr-1">
        {farmacias.map((f) => (
          <li key={f.id} data-testid="ultima-atualizacao-farmacia" className="text-[12px] leading-snug">
            <div className="truncate font-medium text-[#55707a]">{f.nome}</div>
            <div className="text-[#7f99a1]">{f.ate ? formatarAtualizacao(f.ate) : TEXTO_SEM_ATUALIZACAO}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}
