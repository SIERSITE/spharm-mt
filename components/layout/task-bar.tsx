"use client";

import { useEffect, useRef } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { X, Circle, Plus } from "lucide-react";
import { useTaskBar, gerarWorkspaceId, type Tarefa } from "@/lib/workspace/task-bar-context";
import { resolverRota, hrefDoSeparador } from "@/lib/workspace/rotas";

/**
 * components/layout/task-bar.tsx
 *
 * A barra de tarefas visível — auto-regista a rota actual como tarefa
 * (uma entrada por caminho distinto: cada encomenda tem o seu próprio
 * `/encomendas/{id}`, por isso já fica naturalmente isolada das outras;
 * os módulos de relatório — Vendas, Margens, etc. — têm UMA rota fixa,
 * por isso hoje só uma tarefa por módulo se abre automaticamente; ver
 * nota no relatório final sobre "nova análise do mesmo módulo").
 */
export function TaskBar() {
  const taskBar = useTaskBar();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const workspaceParam = searchParams.get("workspace");
  const ultimaIdentidadeRef = useRef<string | null>(null);
  // Navegação iniciada pelo clique no próprio separador: não define «origem» (só as navegações por links/botões da app definem).
  const viaBarraRef = useRef(false);

  const rotaActual = pathname ? resolverRota(pathname) : null;

  // Auto-regista/activa a tarefa correspondente à rota actual — é o que
  // faz "abrir o módulo Vendas" aparecer na barra sem nenhum código no
  // ecrã de Vendas ter de saber que a barra existe.
  //
  // Módulos `workspace: true` (Vendas/Margens/Inventário/Transferências/
  // Excessos): a IDENTIDADE da tarefa passa a ser pathname+`?workspace=
  // <id>`, não só pathname — duas análises do mesmo módulo com ids
  // diferentes são tarefas DISTINTAS. Sem `?workspace=` na URL ainda
  // (1ª visita ao módulo), gera-se um id e substitui-se a URL (replace,
  // sem entrada nova no histórico) — a partir daí a URL identifica
  // sempre a sessão, tal como pedido.
  useEffect(() => {
    if (!taskBar || !pathname || !rotaActual) return;

    if (rotaActual.workspace && !workspaceParam) {
      const novoId = gerarWorkspaceId();
      const params = new URLSearchParams(searchParams.toString());
      params.set("workspace", novoId);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
      return;
    }

    const identidade = rotaActual.workspace ? `${pathname}?workspace=${workspaceParam}` : pathname;
    if (ultimaIdentidadeRef.current === identidade) return;
    const anterior = ultimaIdentidadeRef.current;
    ultimaIdentidadeRef.current = identidade;
    const origemId = !viaBarraRef.current && anterior && anterior !== identidade ? anterior : undefined;
    viaBarraRef.current = false;
    taskBar.abrirOuActivar({
      id: identidade,
      titulo: rotaActual.titulo,
      tipo: rotaActual.tipo,
      // O separador regressa à localização COMPLETA (pesquisa, ordenação, página…), não só à rota.
      href: hrefDoSeparador(pathname, searchParams),
      ...(rotaActual.workspace && workspaceParam ? { workspaceId: workspaceParam } : {}),
      ...(origemId ? { origemId } : {}),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, workspaceParam, taskBar]);

  // Dentro do mesmo separador (pesquisa, página, ordenação…) o URL muda sem trocar de identidade: guarda-se a localização
  // completa para que voltar ao separador a restaure.
  const hrefCompleto = pathname ? hrefDoSeparador(pathname, new URLSearchParams(searchParams.toString())) : null;
  const identidadeParaHref = pathname && rotaActual ? (rotaActual.workspace ? (workspaceParam ? `${pathname}?workspace=${workspaceParam}` : null) : pathname) : null;
  useEffect(() => {
    if (taskBar && identidadeParaHref && hrefCompleto) taskBar.actualizarHref(identidadeParaHref, hrefCompleto);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identidadeParaHref, hrefCompleto]);

  if (!taskBar || taskBar.tarefas.length === 0) return null;

  function irPara(t: Tarefa) {
    viaBarraRef.current = true;
    // scroll:false — a posição de scroll do separador é restaurada por components/layout/scroll-separadores.tsx.
    router.push(t.href, { scroll: false });
  }

  function novaAnalise() {
    if (!rotaActual?.workspace || !pathname) return;
    const novoId = gerarWorkspaceId();
    // Nunca reaproveita o workspace actual — cria sempre um novo, mesmo
    // que os filtros venham a ficar idênticos por coincidência.
    router.push(`${pathname}?workspace=${novoId}`);
  }

  const identidadeActual =
    rotaActual?.workspace && workspaceParam ? `${pathname}?workspace=${workspaceParam}` : pathname;

  function fechar(e: React.MouseEvent, t: Tarefa) {
    e.stopPropagation();
    if (t.sujo && !confirm(`"${t.titulo}" tem alterações por guardar. Fechar mesmo assim?`)) return;
    taskBar!.fechar(t.id);
    if (t.id === identidadeActual) router.push("/dashboard");
  }

  return (
    <div className="flex h-10 items-center gap-1 overflow-x-auto border-b border-[rgba(165,190,196,0.25)] bg-[rgba(255,255,255,0.4)] px-3">
      {taskBar.tarefas.map((t) => {
        const activa = t.id === taskBar.activaId;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => irPara(t)}
            data-navegacao-href={t.href}
            title={t.titulo}
            className={`group flex shrink-0 items-center gap-1.5 rounded-t-lg border-b-2 px-3 py-1.5 text-[12px] font-medium transition ${
              activa
                ? "border-emerald-500 bg-white/70 text-slate-900"
                : "border-transparent text-slate-500 hover:bg-white/40 hover:text-slate-700"
            }`}
          >
            {t.sujo && <Circle className="h-1.5 w-1.5 shrink-0 fill-amber-500 text-amber-500" />}
            <span className="max-w-[160px] truncate">{t.titulo}</span>
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => fechar(e, t)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") fechar(e as unknown as React.MouseEvent, t);
              }}
              className="rounded p-0.5 text-slate-400 opacity-0 transition hover:bg-slate-200 hover:text-slate-700 group-hover:opacity-100"
              aria-label={`Fechar ${t.titulo}`}
            >
              <X className="h-3 w-3" />
            </span>
          </button>
        );
      })}
      {rotaActual?.workspace && (
        <button
          type="button"
          onClick={novaAnalise}
          title="Nova análise — abre uma sessão independente deste módulo, sem tocar na actual"
          className="ml-1 flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium text-slate-500 hover:bg-white/40 hover:text-slate-700"
        >
          <Plus className="h-3.5 w-3.5" />
          Nova análise
        </button>
      )}
    </div>
  );
}
