"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Search } from "lucide-react";
import {
  searchProductsAction,
  type ProductSearchResult,
} from "@/app/encomendas/nova/search";
import { CriarProdutoForm } from "@/components/produtos/criar-produto-form";

type Props = {
  farmaciaId: string;
  disabled?: boolean;
  onPick: (product: ProductSearchResult) => void;
  /** Mensagem opcional mostrada quando o picker não tem farmácia escolhida. */
  noFarmaciaMessage?: string;
  /**
   * Oferece «Criar produto» quando a pesquisa não devolve nada.
   *
   * Opt-in: o picker é usado em sítios onde criar catálogo não faz
   * sentido, e um botão que cria uma ficha central a partir de um ecrã
   * de consulta seria uma surpresa desagradável.
   */
  permitirCriar?: boolean;
};

const DEBOUNCE_MS = 250;

function fmtStock(v: number | null): string {
  if (v == null) return "—";
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(1);
}

export function ProductPicker({
  farmaciaId,
  disabled,
  onPick,
  noFarmaciaMessage,
  permitirCriar = false,
}: Props) {
  const [criarAberto, setCriarAberto] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ProductSearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [loading, startSearch] = useTransition();
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const tokenRef = useRef(0);

  useEffect(() => {
    if (!farmaciaId) return;
    const q = query.trim();
    if (q.length < 2) return;
    const token = ++tokenRef.current;
    const t = setTimeout(() => {
      startSearch(async () => {
        const rows = await searchProductsAction({ query: q, farmaciaId, limit: 20 });
        if (token !== tokenRef.current) return;
        setResults(rows);
        setHighlight(0);
        setOpen(true);
      });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
      // Invalidar quaisquer respostas pendentes desta query — quando o
      // utilizador continua a digitar ou troca de farmácia, descartamos
      // o resultado em curso.
      tokenRef.current++;
    };
  }, [query, farmaciaId]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  function handleSelect(item: ProductSearchResult) {
    onPick(item);
    setQuery("");
    setResults([]);
    setOpen(false);
    inputRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = results[highlight];
      if (item) handleSelect(item);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  // O que o utilizador escreveu, interpretado. So digitos e' um CNP;
  // o resto e' uma designacao. Nao ha terceira hipotese a adivinhar.
  const cnpPesquisado = /^\d+$/.test(query.trim()) ? Number(query.trim()) : null;

  const noFarmacia = !farmaciaId;
  const queryReady = query.trim().length >= 2;
  const dropdownOpen = open && queryReady && results.length > 0;
  const showNoResults =
    open && queryReady && !loading && results.length === 0;

  return (
    <div ref={containerRef} className="relative">
      <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-sm focus-within:border-cyan-400 focus-within:ring-1 focus-within:ring-cyan-400">
        <Search className="h-4 w-4 text-slate-400" aria-hidden />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => {
            if (results.length > 0) setOpen(true);
          }}
          onKeyDown={handleKeyDown}
          disabled={disabled || noFarmacia}
          placeholder={
            noFarmacia
              ? noFarmaciaMessage ?? "Seleccione uma farmácia primeiro"
              : "Procurar por CNP, designação ou fabricante…"
          }
          className="flex-1 bg-transparent text-[14px] text-slate-800 placeholder:text-slate-400 focus:outline-none disabled:cursor-not-allowed"
        />
        {loading && (
          <span className="text-[11px] text-slate-400">a procurar…</span>
        )}
      </div>

      {dropdownOpen && (
        <ul className="absolute z-20 mt-1 max-h-80 w-full overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-lg">
          {results.map((r, i) => (
            <li
              key={r.id}
              onMouseEnter={() => setHighlight(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                handleSelect(r);
              }}
              className={`cursor-pointer border-b border-slate-50 px-3 py-2 last:border-b-0 ${
                i === highlight ? "bg-cyan-50" : "bg-white hover:bg-slate-50"
              }`}
            >
              <div className="flex items-baseline justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium text-slate-900">
                    {r.designacao}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[11px] text-slate-500">
                    <span className="font-mono">CNP {r.cnp}</span>
                    {r.fabricante && (
                      <>
                        <span className="text-slate-300">·</span>
                        <span>{r.fabricante}</span>
                      </>
                    )}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-[10px] uppercase tracking-wider text-slate-400">
                    Stock
                  </div>
                  <div
                    className={`text-[13px] font-semibold ${
                      r.stockAtual == null
                        ? "text-slate-400"
                        : r.stockAtual <= 0
                          ? "text-rose-600"
                          : "text-slate-800"
                    }`}
                  >
                    {fmtStock(r.stockAtual)}
                  </div>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {showNoResults && (
        <div className="absolute z-20 mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-[12px] text-slate-500 shadow-lg">
          <div>Nenhum produto encontrado para “{query}”.</div>
          {/* O caminho curto. Sem isto o utilizador tinha de sair da
              encomenda, ir a Stocks, criar o produto, e voltar — e a
              encomenda que estava a montar entretanto perdia-se. */}
          {permitirCriar && (
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                setCriarAberto(true);
                setOpen(false);
              }}
              className="mt-2 inline-flex items-center gap-1 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[12px] font-medium text-emerald-700 transition hover:bg-emerald-100"
            >
              + Criar produto
            </button>
          )}
        </div>
      )}

      {/* O MESMO formulário de Stocks, em modal. O que muda é o
          invólucro e o que acontece a seguir — aqui o produto volta ao
          picker, já seleccionado, e a encomenda continua onde estava. */}
      {criarAberto && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 backdrop-blur-sm">
          <div className="mt-12 w-full max-w-3xl rounded-2xl border border-slate-200 bg-white p-5 shadow-xl">
            <h2 className="mb-3 text-[15px] font-semibold text-slate-900">
              Criar produto
            </h2>
            <CriarProdutoForm
              contexto="ENCOMENDA"
              cnpInicial={cnpPesquisado}
              designacaoInicial={cnpPesquisado === null ? query.trim() : null}
              onCancelar={() => setCriarAberto(false)}
              onCriado={(p) => {
                setCriarAberto(false);
                setQuery("");
                setResults([]);
                // Devolvido ao picker exactamente como um resultado de
                // pesquisa. `stockAtual: null` e' a verdade: a ficha
                // acabou de nascer no catalogo e nenhuma farmacia a tem.
                onPick({
                  id: p.produtoId,
                  cnp: p.cnp,
                  designacao: p.designacao,
                  fabricante: null,
                  stockAtual: null,
                });
                inputRef.current?.focus();
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
