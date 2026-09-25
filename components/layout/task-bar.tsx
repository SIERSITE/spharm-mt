"use client";

import { useEffect, useRef } from "react";
import { useRouter, usePathname } from "next/navigation";
import { X, Circle } from "lucide-react";
import { useTaskBar, type Tarefa } from "@/lib/workspace/task-bar-context";

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
const ROTAS: Array<{ prefixo: string; tipo: string; titulo: string }> = [
  { prefixo: "/dashboard", tipo: "dashboard", titulo: "Dashboard" },
  { prefixo: "/stock/artigo", tipo: "artigo", titulo: "Ficha de artigo" },
  { prefixo: "/stock", tipo: "stock", titulo: "Stock" },
  { prefixo: "/devolucoes", tipo: "devolucoes", titulo: "Devoluções" },
  { prefixo: "/vendas/manutencao", tipo: "vendas-manutencao", titulo: "Manutenção de vendas" },
  { prefixo: "/vendas", tipo: "vendas", titulo: "Vendas" },
  { prefixo: "/relatorios/inventario", tipo: "inventario", titulo: "Inventário" },
  { prefixo: "/relatorios/margens", tipo: "margens", titulo: "Margens" },
  { prefixo: "/encomendas/nova", tipo: "encomenda-nova", titulo: "Nova encomenda" },
  { prefixo: "/encomendas", tipo: "encomenda", titulo: "Encomendas" },
  { prefixo: "/transferencias", tipo: "transferencias", titulo: "Transferências" },
  { prefixo: "/excessos", tipo: "excessos", titulo: "Excessos" },
  { prefixo: "/catalogo/artigo", tipo: "artigo-catalogo", titulo: "Ficha de artigo (catálogo)" },
  { prefixo: "/catalogo", tipo: "catalogo", titulo: "Catálogo" },
];

function resolverRota(pathname: string): { tipo: string; titulo: string } | null {
  for (const r of ROTAS) {
    if (pathname === r.prefixo || pathname.startsWith(`${r.prefixo}/`)) return r;
  }
  return null;
}

export function TaskBar() {
  const taskBar = useTaskBar();
  const router = useRouter();
  const pathname = usePathname();
  const ultimoPathname = useRef<string | null>(null);

  // Auto-regista/activa a tarefa correspondente à rota actual — é o que
  // faz "abrir o módulo Vendas" aparecer na barra sem nenhum código no
  // ecrã de Vendas ter de saber que a barra existe.
  useEffect(() => {
    if (!taskBar || !pathname) return;
    if (ultimoPathname.current === pathname) return;
    ultimoPathname.current = pathname;
    const rota = resolverRota(pathname);
    if (!rota) return;
    taskBar.abrirOuActivar({ id: pathname, titulo: rota.titulo, tipo: rota.tipo, href: pathname });
  }, [pathname, taskBar]);

  if (!taskBar || taskBar.tarefas.length === 0) return null;

  function irPara(t: Tarefa) {
    router.push(t.href);
  }

  function fechar(e: React.MouseEvent, t: Tarefa) {
    e.stopPropagation();
    if (t.sujo && !confirm(`"${t.titulo}" tem alterações por guardar. Fechar mesmo assim?`)) return;
    taskBar!.fechar(t.id);
    if (t.id === pathname) router.push("/dashboard");
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
    </div>
  );
}
