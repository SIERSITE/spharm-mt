"use client";

/**
 * components/ui/searchable-select.tsx
 *
 * Combobox genérico, pesquisável, com filtragem em memória — a
 * generalização do padrão já usado em `components/encomendas/
 * product-picker.tsx` (debounce + pesquisa no servidor, para um
 * catálogo potencialmente enorme) para o caso mais comum de uma lista
 * já carregada e pequena o suficiente para filtrar no cliente (ex.:
 * fornecedores) — sem nenhum round-trip por tecla.
 *
 * Nasceu para substituir o `<select>` nativo do picker de "fornecedor
 * por linha" em `order-detail-client.tsx`/`order-create-client.tsx`
 * (linha a linha e no controlo de definição em massa), que deixa de
 * escalar visualmente a partir de umas dezenas de fornecedores — mas é
 * deliberadamente genérico (`items: {id,label}[]`) para poder servir
 * qualquer lista pequena/média no resto da aplicação.
 *
 * ── "Só um aberto de cada vez" ──────────────────────────────────────
 *
 * Numa tabela com centenas de linhas, cada uma com o seu picker, expandir
 * TODOS ao mesmo tempo (ou não fechar os outros ao abrir um novo) seria
 * confuso e pesado. Em vez de pedir a cada tabela chamadora que giria um
 * "qual está aberto" central, este módulo mantém esse estado num
 * pequeno store módulo-scoped (fora do React) e cada instância subscreve-o
 * via `useSyncExternalStore` — abrir uma fecha automaticamente qualquer
 * outra, sem qualquer Context/Provider a envolver a tabela.
 *
 * Linhas FECHADAS (a esmagadora maioria, numa tabela grande) renderizam
 * só um botão com o valor actual — nunca a lista de opções nem lógica de
 * filtragem — por isso montar centenas delas é barato.
 */
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ChevronDown, X } from "lucide-react";

// ─── Store módulo-scoped: qual instância está aberta ───────────────────────

type Listener = () => void;
let openInstanceId: string | null = null;
const listeners = new Set<Listener>();

function setOpenInstanceId(id: string | null) {
  if (openInstanceId === id) return;
  openInstanceId = id;
  for (const l of listeners) l();
}
function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function getOpenInstanceId(): string | null {
  return openInstanceId;
}
function getServerSnapshot(): string | null {
  return null;
}

// ─── Componente ─────────────────────────────────────────────────────────────

export type SearchableSelectItem = { id: string; label: string };

type Props = {
  items: readonly SearchableSelectItem[];
  value: string | null;
  onChange: (value: string | null) => void;
  placeholder?: string;
  /**
   * Rótulo do valor seleccionado a mostrar quando fechado, mesmo que
   * `value` não esteja (já não esteja, ou nunca tenha estado) presente
   * em `items` — ex.: uma lista truncada/paginada no chamador. Omitido
   * OU `null` caem ambos para `items.find(i => i.id === value)?.label`
   * — um chamador que ainda não sabe o nome (ex.: uma linha de proposta
   * acabada de gerar, com `fornecedorSugeridoId` já resolvido mas o nome
   * só disponível via `items`) passa `null` com frequência; tratar isso
   * como "mostra vazio à força" em vez de "ainda não sei, resolve
   * sozinho" já causou uma linha a mostrar "Sem fornecedor" com um
   * `value` real por trás — nunca dar a um `null` o poder de esconder um
   * valor real que os `items` sabiam resolver.
   */
  selectedLabel?: string | null;
  disabled?: boolean;
  /** Rótulo acessível do combobox — importante quando não há `<label>` visível associado (ex.: dentro de uma célula de tabela). */
  ariaLabel?: string;
  className?: string;
  emptyMessage?: string;
  /** Estilo do controlo fechado quando não há valor seleccionado — replica o antigo `<select>` "âmbar" para "sem fornecedor". */
  emptyVariant?: "default" | "warning";
};

const MAX_RESULTADOS = 200;

export function SearchableSelect({
  items,
  value,
  onChange,
  placeholder = "Seleccionar…",
  selectedLabel,
  disabled = false,
  ariaLabel,
  className,
  emptyMessage = "Sem resultados.",
  emptyVariant = "default",
}: Props) {
  const instanceId = useId();
  const openId = useSyncExternalStore(subscribe, getOpenInstanceId, getServerSnapshot);
  const isOpen = openId === instanceId && !disabled;

  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const optionRefs = useRef<Array<HTMLLIElement | null>>([]);

  const resolvedSelectedLabel =
    selectedLabel != null
      ? selectedLabel
      : value != null
        ? (items.find((i) => i.id === value)?.label ?? null)
        : null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q ? items.filter((i) => i.label.toLowerCase().includes(q)) : items;
    return base.slice(0, MAX_RESULTADOS);
  }, [items, query]);

  function open() {
    if (disabled) return;
    setQuery("");
    const idx = value != null ? Math.max(0, items.findIndex((i) => i.id === value)) : 0;
    setHighlight(idx);
    setOpenInstanceId(instanceId);
  }

  /** Fecha, mas só se for ESTA a instância aberta — nunca rouba o fecho de outra. */
  function closeIfMine() {
    if (openInstanceId === instanceId) setOpenInstanceId(null);
  }

  function select(item: SearchableSelectItem) {
    onChange(item.id);
    closeIfMine();
  }

  function clear(e?: React.MouseEvent) {
    e?.stopPropagation();
    e?.preventDefault();
    onChange(null);
    closeIfMine();
  }

  // Focar o input assim que este picker abre.
  useEffect(() => {
    if (isOpen) {
      // Um tick depois da montagem do input controlado por `isOpen`.
      const id = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [isOpen]);

  // Reset do highlight quando a lista filtrada muda de tamanho.
  useEffect(() => {
    setHighlight((h) => Math.min(h, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  // Manter a opção destacada visível ao navegar por teclado.
  useEffect(() => {
    if (!isOpen) return;
    optionRefs.current[highlight]?.scrollIntoView({ block: "nearest" });
  }, [highlight, isOpen]);

  // Clique fora fecha (mesmo padrão de `product-picker.tsx`).
  useEffect(() => {
    if (!isOpen) return;
    function handleClick(e: MouseEvent) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) closeIfMine();
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = filtered[highlight];
      if (item) select(item);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeIfMine();
    } else if (e.key === "Tab") {
      closeIfMine();
    }
  }

  const listboxId = `${instanceId}-listbox`;
  const activeOptionId = filtered[highlight] ? `${instanceId}-option-${filtered[highlight].id}` : undefined;

  if (!isOpen) {
    const semValor = value == null;
    return (
      <button
        type="button"
        onClick={open}
        disabled={disabled}
        aria-label={ariaLabel}
        className={
          className ??
          `flex w-full items-center justify-between gap-1.5 rounded-lg border px-2 py-1 text-left text-[12px] focus:border-cyan-400 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${
            semValor && emptyVariant === "warning"
              ? "border-amber-200 bg-amber-50 text-amber-700"
              : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
          }`
        }
      >
        <span className="min-w-0 flex-1 truncate">{resolvedSelectedLabel ?? placeholder}</span>
        <span className="flex shrink-0 items-center gap-1">
          {!semValor && !disabled && (
            <X
              role="button"
              aria-label="Limpar selecção"
              tabIndex={0}
              onClick={clear}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") { e.preventDefault(); clear(); }
              }}
              className="h-3.5 w-3.5 text-slate-400 hover:text-rose-600"
            />
          )}
          <ChevronDown className="h-3.5 w-3.5 text-slate-400" aria-hidden />
        </span>
      </button>
    );
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="flex items-center gap-1.5 rounded-lg border border-cyan-400 bg-white px-2 py-1 shadow-sm ring-1 ring-cyan-400">
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={true}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={activeOptionId}
          aria-label={ariaLabel}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={(e) => {
            // Deixar o mousedown do `<li>` (que previne default) processar
            // a selecção antes de fechar por blur.
            if (!containerRef.current?.contains(e.relatedTarget as Node)) closeIfMine();
          }}
          placeholder={placeholder}
          className="w-full min-w-0 flex-1 bg-transparent text-[12px] text-slate-800 placeholder:text-slate-400 focus:outline-none"
        />
        {value != null && (
          <button
            type="button"
            aria-label="Limpar selecção"
            onMouseDown={(e) => { e.preventDefault(); clear(); }}
            className="shrink-0 rounded p-0.5 text-slate-400 hover:text-rose-600"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <ul
        ref={listRef}
        id={listboxId}
        role="listbox"
        className="absolute z-30 mt-1 max-h-64 w-full min-w-[200px] overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-lg"
      >
        {filtered.length === 0 ? (
          <li className="px-3 py-2 text-[12px] text-slate-400">{emptyMessage}</li>
        ) : (
          filtered.map((item, i) => (
            <li
              key={item.id}
              id={`${instanceId}-option-${item.id}`}
              ref={(el) => { optionRefs.current[i] = el; }}
              role="option"
              aria-selected={item.id === value}
              onMouseEnter={() => setHighlight(i)}
              onMouseDown={(e) => { e.preventDefault(); select(item); }}
              className={`cursor-pointer truncate border-b border-slate-50 px-3 py-1.5 text-[12px] last:border-b-0 ${
                i === highlight ? "bg-cyan-50 text-cyan-900" : "bg-white text-slate-700 hover:bg-slate-50"
              } ${item.id === value ? "font-medium" : ""}`}
            >
              {item.label}
            </li>
          ))
        )}
        {items.length > MAX_RESULTADOS && filtered.length === MAX_RESULTADOS && (
          <li className="border-t border-slate-100 px-3 py-1.5 text-[11px] text-slate-400">
            Mostrando os primeiros {MAX_RESULTADOS} — refine a pesquisa para ver mais.
          </li>
        )}
      </ul>
    </div>
  );
}
