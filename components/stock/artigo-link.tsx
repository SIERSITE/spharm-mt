"use client";

import Link from "next/link";
import type { MouseEvent, ReactNode } from "react";
import { useAbrirFichaArtigo } from "@/components/stock/artigo-panel";

/**
 * components/stock/artigo-link.tsx
 *
 * Substituto directo de `<Link href={`/stock/artigo/${cnp}`}>` — em vez
 * de navegar para fora do ecrã actual, abre o painel lateral
 * (components/stock/artigo-panel.tsx) e preserva o trabalho em curso.
 *
 * Continua a ser um `<Link>` REAL (href aponta para a página completa):
 * Ctrl/Cmd+clique, botão do meio e "Abrir em novo separador" do browser
 * continuam a funcionar exactamente como esperado, porque só
 * intercepta um clique ESQUERDO simples sem modificadores — a mesma
 * convenção que qualquer link da aplicação já segue implicitamente.
 * Acesso directo à URL (`/stock/artigo/{cnp}`) nunca passa por aqui.
 */
export function ArtigoLink({ cnp, children, className, title }: { cnp: number; children: ReactNode; className?: string; title?: string }) {
  const abrirFicha = useAbrirFichaArtigo();

  function handleClick(e: MouseEvent<HTMLAnchorElement>) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    abrirFicha(cnp);
  }

  return (
    <Link href={`/stock/artigo/${cnp}`} onClick={handleClick} className={className} title={title}>
      {children}
    </Link>
  );
}
