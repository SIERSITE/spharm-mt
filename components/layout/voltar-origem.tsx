"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { useTaskBar } from "@/lib/workspace/task-bar-context";
import { useIdSeparador } from "@/lib/workspace/estado-separador";

/**
 * components/layout/voltar-origem.tsx
 *
 * «Voltar a …» DE ONDE O UTILIZADOR VEIO — navegação contextual do workspace. A barra de separadores regista, em cada
 * separador novo, o separador de origem (`Tarefa.origemId`); aqui ativa-se esse separador (o router leva-o à sua localização
 * completa e a página restaura o estado do armazém). Se o separador de origem já não existe (foi fechado) ou o acesso foi
 * directo, usa-se o destino por omissão da página (ex.: Stock, Catálogo) — nunca um rótulo falso.
 */
export function VoltarOrigem({
  destinoPorOmissao,
  rotuloPorOmissao,
  className,
  variante = "texto",
}: {
  destinoPorOmissao: string;
  /** Ex.: «Voltar a Stock». */
  rotuloPorOmissao: string;
  className?: string;
  variante?: "texto" | "pilula";
}) {
  const taskBar = useTaskBar();
  const router = useRouter();
  const id = useIdSeparador();
  const tarefa = id ? taskBar?.tarefas.find((t) => t.id === id) : undefined;
  const origem = tarefa?.origemId ? taskBar?.tarefas.find((t) => t.id === tarefa.origemId) : undefined;
  const base =
    variante === "pilula"
      ? "inline-flex items-center rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
      : "inline-flex items-center gap-2 text-[12px] font-medium text-slate-500 transition hover:text-slate-700";
  const conteudoRotulo = (txt: string) => (variante === "pilula" ? `← ${txt}` : txt);

  if (origem) {
    return (
      <button
        type="button"
        data-testid="voltar-origem"
        data-origem-id={origem.id}
        onClick={() => router.push(origem.href, { scroll: false })}
        className={className ?? base}
      >
        {variante === "texto" && <ArrowLeft className="h-4 w-4" />}
        {conteudoRotulo(`Voltar a ${origem.titulo}`)}
      </button>
    );
  }
  return (
    <Link href={destinoPorOmissao} data-testid="voltar-origem" className={className ?? base}>
      {variante === "texto" && <ArrowLeft className="h-4 w-4" />}
      {conteudoRotulo(rotuloPorOmissao)}
    </Link>
  );
}
