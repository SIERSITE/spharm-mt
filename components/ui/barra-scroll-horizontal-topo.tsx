"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Barra de scroll horizontal ESPELHO, no topo da tabela: sincronizada com o contentor, só aparece quando a tabela não
 * cabe. Assim o scroll horizontal está sempre à mão, sem ter de descer centenas de linhas até ao fim. Só de ecrã —
 * nunca entra na impressão/PDF/Excel/email (`print:hidden` + `data-nao-imprimir`).
 */
export function BarraScrollHorizontalTopo({ alvo }: { alvo: React.RefObject<HTMLDivElement | null> }) {
  const barra = useRef<HTMLDivElement>(null);
  const [largura, setLargura] = useState(0);
  const [visivel, setVisivel] = useState(false);
  useEffect(() => {
    const el = alvo.current;
    if (!el) return;
    const medir = () => {
      setLargura(el.scrollWidth);
      setVisivel(el.scrollWidth > el.clientWidth + 1);
    };
    medir();
    const ro = new ResizeObserver(medir);
    ro.observe(el);
    const tabela = el.querySelector("table");
    if (tabela) ro.observe(tabela);
    let aSincronizar = false;
    const doAlvo = () => {
      if (aSincronizar) {
        aSincronizar = false;
        return;
      }
      if (barra.current && barra.current.scrollLeft !== el.scrollLeft) {
        aSincronizar = true;
        barra.current.scrollLeft = el.scrollLeft;
      }
    };
    el.addEventListener("scroll", doAlvo, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", doAlvo);
    };
  });
  const daBarra = () => {
    const el = alvo.current;
    if (el && barra.current && el.scrollLeft !== barra.current.scrollLeft) el.scrollLeft = barra.current.scrollLeft;
  };
  return (
    <div
      ref={barra}
      onScroll={daBarra}
      className={`overflow-x-auto overflow-y-hidden print:hidden ${visivel ? "" : "hidden"}`}
      style={{ height: 14 }}
      data-testid="barra-scroll-topo"
      data-nao-imprimir
      aria-hidden="true"
    >
      <div style={{ width: largura, height: 1 }} />
    </div>
  );
}
