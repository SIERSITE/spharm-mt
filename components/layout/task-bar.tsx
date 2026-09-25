"use client";

import { useEffect, useRef } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { X, Circle, Plus } from "lucide-react";
import { useTaskBar, gerarWorkspaceId, type Tarefa } from "@/lib/workspace/task-bar-context";

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
const ROTAS: Array<{ prefixo: string; tipo: string; titulo: string; workspace?: boolean }> = [
  { prefixo: "/dashboard", tipo: "dashboard", titulo: "Dashboard" },
  { prefixo: "/stock/artigo", tipo: "artigo", titulo: "Ficha de artigo" },
  { prefixo: "/stock", tipo: "stock", titulo: "Stock" },
  { prefixo: "/devolucoes", tipo: "devolucoes", titulo: "Devoluções" },
  { prefixo: "/vendas/manutencao", tipo: "vendas-manutencao", titulo: "Manutenção de vendas" },
  { prefixo: "/vendas", tipo: "vendas", titulo: "Vendas", workspace: true },
  { prefixo: "/relatorios/inventario", tipo: "inventario", titulo: "Inventário", workspace: true },
  { prefixo: "/relatorios/margens", tipo: "margens", titulo: "Margens", workspace: true },
  { prefixo: "/encomendas/nova", tipo: "encomenda-nova", titulo: "Nova encomenda" },
  { prefixo: "/encomendas", tipo: "encomenda", titulo: "Encomendas" },
  { prefixo: "/transferencias", tipo: "transferencias", titulo: "Transferências", workspace: true },
  { prefixo: "/excessos", tipo: "excessos", titulo: "Excessos", workspace: true },
  { prefixo: "/catalogo/artigo", tipo: "artigo-catalogo", titulo: "Ficha de artigo (catálogo)" },
  { prefixo: "/catalogo", tipo: "catalogo", titulo: "Catálogo" },
];

/**
 * `workspace: true` marca os módulos de relatório com sessões de
 * análise isoladas — ver `lib/workspace/use-workspace-state.ts`. Só
 * estes ganham um `?workspace=<id>` na URL e uma tarefa por análise em
 * vez de uma tarefa por módulo; os restantes continuam exactamente como
 * antes (uma tarefa por rota).
 */
function resolverRota(pathname: string): { tipo: string; titulo: string; workspace: boolean } | null {
  for (const r of ROTAS) {
    if (pathname === r.prefixo || pathname.startsWith(`${r.prefixo}/`)) {
      return { tipo: r.tipo, titulo: r.titulo, workspace: r.workspace ?? false };
    }
  }
  return null;
}

export function TaskBar() {
  const taskBar = useTaskBar();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const workspaceParam = searchParams.get("workspace");
  const ultimaIdentidadeRef = useRef<string | null>(null);

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
    ultimaIdentidadeRef.current = identidade;
    taskBar.abrirOuActivar({
      id: identidade,
      titulo: rotaActual.titulo,
      tipo: rotaActual.tipo,
      href: identidade,
      ...(rotaActual.workspace && workspaceParam ? { workspaceId: workspaceParam } : {}),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, workspaceParam, taskBar]);

  if (!taskBar || taskBar.tarefas.length === 0) return null;

  function irPara(t: Tarefa) {
    router.push(t.href);
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
