"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Maximize2, Loader2 } from "lucide-react";
import { SlideOverPanel } from "@/components/ui/slide-over-panel";
import { ArtigoFicha } from "@/components/stock/artigo-ficha";
import { getArtigoFichaAction } from "@/app/stock/artigo/panel-actions";
import type { ArtigoFichaData } from "@/lib/stock/artigo-ficha-data";
import { useTaskBar } from "@/lib/workspace/task-bar-context";

const PARAM = "ficha";

/**
 * components/stock/artigo-panel.tsx
 *
 * Painel lateral da ficha do artigo, montado UMA vez (na AppShell) e
 * controlado inteiramente pelo query param `?ficha=<cnp>` da URL
 * ACTUAL — nunca por estado local solto:
 *   · abrir  = router.push(`${pathname}?ficha=${cnp}`) → nova entrada
 *              no histórico (useAbrirFichaArtigo, chamado por quem
 *              gatilha a abertura — outro componente, por isso NUNCA
 *              partilha uma ref com este);
 *   · fechar = router.replace() sem o parâmetro — nunca router.back(),
 *              que poderia sair da aplicação se o utilizador tivesse
 *              chegado directamente a um link partilhado com ?ficha= na
 *              URL (sem entrada anterior própria no histórico).
 * Por ser derivado da URL, back/forward do BROWSER abre/fecha o painel
 * correctamente sem nenhum código adicional (é a MESMA fonte de
 * verdade); o botão de fechar explícito usa replace, o que colapsa a
 * entrada aberta na mesma posição do histórico — carregar "Voltar"
 * depois de fechar não reabre o painel. "Manter como tarefa" navega
 * para a página completa (/stock/artigo/{cnp}) e regista-a na barra de
 * tarefas.
 *
 * Ecrãs abrem o painel chamando `abrirFichaArtigo(cnp)` — ver
 * components/stock/artigo-link.tsx, o trigger reutilizável.
 */
export function ArtigoPanel() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const taskBar = useTaskBar();
  const cnpParam = searchParams.get(PARAM);
  const cnp = cnpParam ? Number(cnpParam) : null;

  const [data, setData] = useState<ArtigoFichaData | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const ultimoCnpCarregado = useRef<number | null>(null);

  useEffect(() => {
    if (!cnp) {
      // Sem CNP na URL o componente nem chega a renderizar `data` (early
      // return "if (!cnp) return null;" mais abaixo) — só o cursor de
      // "já carregado" precisa de reset, nunca um setState aqui.
      ultimoCnpCarregado.current = null;
      return;
    }
    if (ultimoCnpCarregado.current === cnp) return;
    // Padrão canónico "fetch ao mudar um parâmetro" — sincronizar com um
    // sistema externo (a Server Action) é exactamente o uso legítimo de
    // efeito que a própria regra documenta; só não tem excepção
    // automática para o `setState(true)` que arma o "a carregar" antes
    // da chamada assíncrona.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCarregando(true);
    setErro(null);
    getArtigoFichaAction(cnp).then((r) => {
      if (r.ok) {
        setData(r.data);
        ultimoCnpCarregado.current = cnp;
      } else {
        setErro(r.error);
      }
      setCarregando(false);
    });
  }, [cnp]);

  const fechar = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete(PARAM);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [router, pathname, searchParams]);

  if (!cnp) return null;

  function manterComoTarefa() {
    if (!data) return;
    taskBar?.abrirOuActivar({
      id: `/stock/artigo/${data.cnp}`,
      titulo: `Artigo — ${data.designacao}`,
      tipo: "artigo",
      href: `/stock/artigo/${data.cnp}`,
    });
    router.push(`/stock/artigo/${data.cnp}`);
  }

  return (
    <SlideOverPanel
      aberto={true}
      titulo={data ? data.designacao : carregando ? "A carregar…" : "Ficha do artigo"}
      onFechar={fechar}
      acoes={
        data && (
          <button
            type="button"
            onClick={manterComoTarefa}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-medium text-slate-600 transition hover:bg-slate-50"
            title="Abrir a página completa e manter como tarefa"
          >
            <Maximize2 className="h-3.5 w-3.5" />
            Manter como tarefa
          </button>
        )
      }
    >
      {carregando && (
        <div className="flex items-center justify-center gap-2 py-12 text-[13px] text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          A carregar ficha…
        </div>
      )}
      {erro && <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-[13px] text-rose-700">{erro}</div>}
      {data && <ArtigoFicha data={data} compacto />}
    </SlideOverPanel>
  );
}

/**
 * Hook para qualquer ecrã abrir o painel — empurra `?ficha=<cnp>` para
 * o histórico (marca `pushedByUs` implicitamente: o próprio ArtigoPanel
 * lê a URL, não precisa de ser avisado directamente).
 */
export function useAbrirFichaArtigo() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  return useCallback(
    (cnp: number) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set(PARAM, String(cnp));
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [router, pathname, searchParams]
  );
}
