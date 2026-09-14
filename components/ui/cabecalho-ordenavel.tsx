"use client";

/**
 * components/ui/cabecalho-ordenavel.tsx
 *
 * O cabeçalho de coluna clicável, e o hook que lhe guarda o estado.
 *
 * Um componente para as duas formas de tabela que a aplicação usa —
 * `<table>` com `<th>` (excessos, transferências, encomendas) e grelha
 * CSS com `<div>` (ficha de produto, stock). O `as` decide a etiqueta;
 * tudo o resto é igual, e é isso que faz o indicador ser o mesmo em todo
 * o lado.
 *
 * A lógica de ordenação NÃO está aqui — está em `lib/tabela/ordenacao.ts`,
 * que é puro e testável sem DOM. Aqui fica só o que é UI: o botão, a
 * seta, e o `aria-sort`.
 *
 * ── Acessibilidade ───────────────────────────────────────────────────
 *
 * `aria-sort` no cabeçalho e um `<button>` a sério por dentro. Um `<th>`
 * com `onClick` não é alcançável por teclado e não se anuncia como
 * accionável — e uma tabela cujo único meio de ordenação exige rato
 * exclui quem navega por tabulação. A seta sozinha também não chega: é
 * cor e forma, e o `aria-sort` é o que um leitor de ecrã lê.
 */
import { ChevronDown, ChevronUp, ChevronsUpDown } from "lucide-react";
import { useCallback, useState } from "react";
import {
  proximaOrdenacao,
  type DirecaoOrdenacao,
  type EstadoOrdenacao,
} from "@/lib/tabela/ordenacao";

/**
 * O estado de ordenação de uma tabela, pronto a ligar aos cabeçalhos.
 *
 * Existe para que ligar uma tabela nova sejam duas linhas e não dez, e
 * para que o ciclo asc→desc seja o mesmo em todas — é uma decisão de
 * produto, não de cada cliente.
 */
export function useOrdenacao<K extends string>(inicial: EstadoOrdenacao<K> = null) {
  const [ordenacao, setOrdenacao] = useState<EstadoOrdenacao<K>>(inicial);
  const alternar = useCallback((coluna: K) => {
    setOrdenacao((actual) => proximaOrdenacao(actual, coluna));
  }, []);
  return { ordenacao, alternar, setOrdenacao };
}

type Props<K extends string> = {
  coluna: K;
  ordenacao: EstadoOrdenacao<K>;
  onOrdenar: (coluna: K) => void;
  children: React.ReactNode;
  /** `th` numa `<table>`, `div` numa grelha CSS. */
  as?: "th" | "div";
  align?: "left" | "right" | "center";
  className?: string;
  /** Tooltip — útil para explicar a fórmula de uma coluna calculada. */
  title?: string;
};

function ariaSort(direcao: DirecaoOrdenacao | null): "ascending" | "descending" | "none" {
  if (direcao === "asc") return "ascending";
  if (direcao === "desc") return "descending";
  return "none";
}

export function CabecalhoOrdenavel<K extends string>({
  coluna,
  ordenacao,
  onOrdenar,
  children,
  as = "th",
  align = "left",
  className = "",
  title,
}: Props<K>) {
  const activa = ordenacao?.coluna === coluna;
  const direcao = activa ? ordenacao!.direcao : null;
  const Tag = as as "th";

  const justify =
    align === "right" ? "justify-end" : align === "center" ? "justify-center" : "justify-start";

  return (
    <Tag
      scope={as === "th" ? "col" : undefined}
      aria-sort={ariaSort(direcao)}
      className={className}
      title={title}
    >
      <button
        type="button"
        onClick={() => onOrdenar(coluna)}
        className={`group inline-flex w-full items-center gap-1 ${justify} text-left transition hover:text-slate-900 ${
          activa ? "text-slate-900" : ""
        }`}
      >
        <span className="truncate">{children}</span>
        {/* A seta da coluna inactiva aparece só no hover: seis setas
            cinzentas permanentes competem com os dados por atenção, e
            nenhuma delas diz nada. */}
        {direcao === "asc" ? (
          <ChevronUp className="h-3 w-3 shrink-0 text-emerald-600" aria-hidden />
        ) : direcao === "desc" ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-emerald-600" aria-hidden />
        ) : (
          <ChevronsUpDown
            className="h-3 w-3 shrink-0 text-slate-300 opacity-0 transition group-hover:opacity-100"
            aria-hidden
          />
        )}
      </button>
    </Tag>
  );
}
