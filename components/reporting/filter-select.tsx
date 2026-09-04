"use client";

import { useMemo, useState } from "react";

/**
 * components/reporting/filter-select.tsx
 *
 * Multi-select compacto para barras de filtros de relatórios. Extracção
 * literal do `FilterSelect` que estava duplicado em devolucoes-client,
 * vendas-client, excessos-client, transferencias-client e
 * encomendas-client — mesma assinatura, mesma aparência, mesmo
 * comportamento. Os módulos novos (Inventário, Margens) consomem este
 * componente directamente; os existentes podem migrar mais tarde.
 *
 * Decisões preservadas:
 *   · `<details>/<summary>` para colapsar sem hooks de estado
 *   · Contagem ao lado do label quando há selecção
 *   · Mensagem "sem dados" quando `options` chega vazio
 *   · Estilo idêntico ao dos relatórios existentes (paleta emerald)
 *
 * ── Pesquisa local ───────────────────────────────────────────────────
 *
 * Com 400 fabricantes numa lista de checkboxes, encontrar "MENARINI"
 * era percorrer a lista a olho. A caixa de pesquisa filtra as OPÇÕES
 * VISÍVEIS e mais nada:
 *
 *   · não toca na selecção — escrever não desselecciona o que já estava
 *     escolhido, mesmo que essas opções deixem de estar à vista;
 *   · não vai à base de dados: o universo já veio todo do servidor;
 *   · limpar a caixa repõe a lista completa.
 *
 * Só aparece acima de `MINIMO_PARA_PESQUISA` opções: numa lista de
 * cinco farmácias, uma caixa de pesquisa é ruído.
 */

/** Abaixo disto a lista vê-se toda de uma vez e a caixa só estorva. */
const MINIMO_PARA_PESQUISA = 8;

/**
 * Sem acentos e em minúsculas — "menarini" tem de encontrar "MENARINI",
 * e "aspirina" tem de encontrar "Aspirina®" tal como "ASPIRINA".
 */
export function normalizarOpcao(v: string): string {
  // U+0300..U+036F = marcas diacríticas combinantes, que o NFD separa
  // da letra base. Escapadas, e não escritas em cru: um combining char
  // literal no código-fonte é invisível e o próximo editor apaga-o sem
  // dar por isso.
  return v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/** As opções que a pesquisa deixa visíveis. Pura, para ser testável. */
export function opcoesVisiveis(options: readonly string[], procura: string): string[] {
  const q = normalizarOpcao(procura.trim());
  if (!q) return [...options];
  return options.filter((o) => normalizarOpcao(o).includes(q));
}

export function FilterSelect({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: string[];
  selected: string[];
  onChange: (v: string[]) => void;
}) {
  // Os hooks vivem ANTES de qualquer return condicional: a alternativa
  // é a ordem dos hooks mudar entre renders quando `options` passa de
  // vazio a não-vazio, e o React rebenta.
  const [procura, setProcura] = useState("");

  const visiveis = useMemo(() => opcoesVisiveis(options, procura), [options, procura]);

  if (options.length === 0) {
    return (
      <div className="rounded-[12px] border border-slate-100 bg-white/60 p-3 text-[11px] text-slate-400">
        {label}: sem dados
      </div>
    );
  }

  const toggle = (v: string) =>
    onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);

  const comPesquisa = options.length >= MINIMO_PARA_PESQUISA;
  // Seleccionadas que a pesquisa escondeu. Mostrar a contagem evita a
  // leitura errada de "escrevi e perdi as minhas escolhas".
  const escondidasSeleccionadas = selected.filter((v) => !visiveis.includes(v)).length;

  return (
    <details className="rounded-[12px] border border-slate-100 bg-white/70 p-3">
      <summary className="cursor-pointer text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
        {label} {selected.length > 0 && `(${selected.length})`}
      </summary>

      {comPesquisa && (
        <div className="mt-2">
          <input
            type="text"
            value={procura}
            onChange={(e) => setProcura(e.target.value)}
            placeholder={`Pesquisar ${label.toLowerCase()}…`}
            className="h-7 w-full rounded-lg border border-slate-200 bg-white px-2 text-[11px] text-slate-700 outline-none transition focus:border-emerald-300"
          />
        </div>
      )}

      <div className="mt-2 max-h-40 space-y-1 overflow-y-auto">
        {visiveis.length === 0 ? (
          <div className="py-2 text-[11px] text-slate-400">Sem correspondências.</div>
        ) : (
          visiveis.map((opt) => (
            <label
              key={opt}
              className="flex cursor-pointer items-center gap-2 text-[12px] text-slate-600"
            >
              <input
                type="checkbox"
                checked={selected.includes(opt)}
                onChange={() => toggle(opt)}
                className="h-3.5 w-3.5 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
              />
              <span className="truncate">{opt}</span>
            </label>
          ))
        )}
      </div>

      {escondidasSeleccionadas > 0 && (
        <div className="mt-1 text-[10px] text-slate-400">
          +{escondidasSeleccionadas} seleccionada{escondidasSeleccionadas > 1 ? "s" : ""} fora
          da pesquisa
        </div>
      )}
    </details>
  );
}
