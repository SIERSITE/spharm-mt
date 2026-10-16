"use client";

import { useEffect, useRef } from "react";
import { estadoSeparadores } from "@/lib/workspace/armazem-separadores";
import { useEscopoSeparadores } from "@/lib/workspace/task-bar-context";
import { useIdSeparador } from "@/lib/workspace/estado-separador";

/**
 * components/layout/scroll-separadores.tsx
 *
 * Guarda e restaura a posição de scroll de cada separador — SEM integração por página:
 *   · o scroll da JANELA é sempre guardado;
 *   · qualquer contentor com scroll que declare `data-scroll-key="<nome>"` (único dentro da página) também.
 *
 * Montado UMA vez no layout raiz (sobrevive às navegações). Guarda no armazém em memória do separador
 * (`estado-separador.ts`) e, quando o separador volta a ficar activo, restaura assim que o conteúdo já tem altura/largura
 * suficiente (a página restaura os seus resultados do armazém na primeira renderização, por isso é imediato; o ciclo de
 * tentativas cobre apenas conteúdo que chega depois). Qualquer interacção do utilizador (roda, toque, tecla, rato)
 * cancela a restauração — nunca «luta» com quem já está a deslocar a página.
 *
 * Ignora os eventos de scroll gerados pela própria navegação (o Next repõe a janela no topo ao montar a rota nova):
 * durante `JANELA_IGNORAR_MS` após a mudança de separador nada é gravado.
 */
const PREFIXO = "__scroll:";
const JANELA_IGNORAR_MS = 500;
const MAX_TENTATIVAS = 90; // ≈ 1,5 s a 60 fps

type Pos = { x: number; y: number };

export function ScrollSeparadores() {
  const escopo = useEscopoSeparadores();
  const id = useIdSeparador();
  const idRef = useRef<string | null>(id);
  const escopoRef = useRef<string | null>(escopo);
  const mudouEm = useRef(0);

  // Gravação: um listener global em captura apanha o scroll da janela e de qualquer contentor.
  useEffect(() => {
    let pendente: { chave: string; pos: Pos } | null = null;
    let raf = 0;
    const gravar = () => {
      raf = 0;
      const e = escopoRef.current;
      const i = idRef.current;
      if (pendente && e && i && Date.now() - mudouEm.current > JANELA_IGNORAR_MS) {
        estadoSeparadores.escrever(e, i, PREFIXO + pendente.chave, pendente.pos);
      }
      pendente = null;
    };
    const aoScroll = (ev: Event) => {
      const alvo = ev.target;
      if (alvo === document || alvo === document.documentElement || alvo === document.body) {
        pendente = { chave: "__janela", pos: { x: window.scrollX, y: window.scrollY } };
      } else if (alvo instanceof HTMLElement) {
        const el = alvo.closest<HTMLElement>("[data-scroll-key]");
        if (!el) return;
        pendente = { chave: el.dataset.scrollKey as string, pos: { x: el.scrollLeft, y: el.scrollTop } };
      } else return;
      if (!raf) raf = requestAnimationFrame(gravar);
    };
    document.addEventListener("scroll", aoScroll, { capture: true, passive: true });
    return () => {
      document.removeEventListener("scroll", aoScroll, true);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  // Restauração ao ativar um separador.
  useEffect(() => {
    idRef.current = id;
    escopoRef.current = escopo;
    mudouEm.current = Date.now();
    if (!escopo || !id) return;

    let cancelado = false;
    let tentativas = 0;
    const feitos = new Set<string>();
    const cancelar = () => {
      cancelado = true;
    };
    const eventos = ["wheel", "touchstart", "keydown", "mousedown"] as const;
    for (const ev of eventos) window.addEventListener(ev, cancelar, { passive: true, once: true });

    const guardado = (chave: string) => estadoSeparadores.ler<Pos>(escopo, id, PREFIXO + chave);
    const tentar = () => {
      if (cancelado || tentativas++ > MAX_TENTATIVAS) return;
      const j = guardado("__janela");
      if (j && !feitos.has("__janela") && (j.x || j.y)) {
        const alturaMax = document.documentElement.scrollHeight - window.innerHeight;
        if (alturaMax >= j.y - 1) {
          window.scrollTo(j.x, j.y);
          feitos.add("__janela");
        }
      }
      document.querySelectorAll<HTMLElement>("[data-scroll-key]").forEach((el) => {
        const chave = el.dataset.scrollKey as string;
        if (feitos.has(chave)) return;
        const p = guardado(chave);
        if (!p || (!p.x && !p.y)) return;
        if (el.scrollHeight - el.clientHeight >= p.y - 1 && el.scrollWidth - el.clientWidth >= p.x - 1) {
          el.scrollTo(p.x, p.y);
          feitos.add(chave);
        }
      });
      requestAnimationFrame(tentar);
    };
    requestAnimationFrame(tentar);

    return () => {
      cancelado = true;
      for (const ev of eventos) window.removeEventListener(ev, cancelar);
    };
  }, [escopo, id]);

  return null;
}
