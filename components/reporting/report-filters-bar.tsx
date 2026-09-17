"use client";

/**
 * components/reporting/report-filters-bar.tsx
 *
 * Barra completa de filtros canónicos para relatórios operacionais.
 * Controlled — o cliente do relatório passa `value` e `onChange` e
 * recebe alterações imediatas. NÃO contém botão "Gerar" porque cada
 * relatório decide quando disparar o loader (alguns são lazy, outros
 * podem ser auto-refresh).
 *
 * ── Uniformização com o padrão do Vendas ──────────────────────────────
 *
 * Até aqui, os multi-selects (farmácia/categoria/subcategoria/
 * utilização/fabricante/distribuidor) + o importador de CNP + os
 * toggles de classificação/natureza ficavam TODOS sempre visíveis, de
 * uma vez — o oposto do padrão do Vendas (linha de topo sempre visível,
 * filtros avançados atrás de um botão "Filtros" com contador, filtros
 * rápidos numa faixa à parte). Como o Vendas foi escolhido como
 * referência de UX para os três relatórios, este componente passou a
 * seguir a mesma disposição:
 *
 *   · linha de topo — pesquisa, Desde/Até (quando não `hideDates`), o
 *     botão `FiltrosToggleButton` (contador de `contarFiltrosAtivos`) e
 *     `LimparFiltrosButton` — sempre visíveis;
 *   · painel avançado — importador de CNP + os 6 multi-selects + chips
 *     das selecções activas — só quando o painel está aberto;
 *   · faixa de filtros rápidos — "Apenas produtos sem classificação" e
 *     (quando `mostrarNaturezas`) crédito/transferências — sempre
 *     visível, como no Vendas.
 *
 * A LÓGICA de filtragem não mudou nada: mesmo `value`/`onChange`,
 * mesmos campos, mesmo `SharedReportFilters` — só a disposição.
 *
 * Reaproveita:
 *   · `<FilterSelect>` para os multi-selects (chevron + checkboxes)
 *   · `SearchableMultiSelect`/`FilterPill`/`ToggleRow`/
 *     `FiltrosToggleButton`/`LimparFiltrosButton` do Vendas
 *     (components/reporting/filter-panel.tsx)
 *   · `contarFiltrosAtivos`/`limparFiltrosPreservandoData` — a MESMA
 *     regra usada pelo Vendas (lib/reporting/filters-shared.ts)
 *   · `SharedReportFilters` como tipo do estado
 *   · `ReportFilterOptions` como universo de opções
 *
 * Props ocultas opcionais:
 *   · hideDates    — Inventário "stock actual" não tem período
 *   · hidePeriodLabel — quem queira sobrepor o título acima das datas
 */
import { useState } from "react";
import { Search } from "lucide-react";
import { FilterSelect } from "./filter-select";
import { FilterPill, FiltrosToggleButton, LimparFiltrosButton, ToggleRow } from "./filter-panel";
import { ImportListaCodigos } from "./import-lista-codigos";
import type { ListaCodigosResolvida } from "@/lib/produtos/lista-codigos-tipos";
import {
  contarFiltrosAtivos,
  limparFiltrosPreservandoData,
  type ReportFilterOptions,
  type SharedReportFilters,
} from "@/lib/reporting/filters-shared";
import {
  DEFAULT_INCLUIR_CREDITO,
  DEFAULT_INCLUIR_TRANSFERENCIAS,
  rotuloNaturezas,
} from "@/lib/reporting/natureza-venda";

type Props = {
  options: ReportFilterOptions;
  value: SharedReportFilters;
  onChange: (next: SharedReportFilters) => void;
  /** Esconde Desde/Até quando o relatório é "snapshot actual" (ex: Inventário). */
  hideDates?: boolean;
  /** Placeholder customizável para o input de pesquisa. */
  searchPlaceholder?: string;
  /**
   * Mostra os interruptores de crédito / guias de transferência.
   *
   * Só faz sentido onde há vendas: o Inventário é um snapshot de stock e
   * não tem naturezas para ligar ou desligar.
   */
  mostrarNaturezas?: boolean;
  /**
   * Lista de CNP importada por ficheiro. Vive no pai porque é ele que a
   * mostra no cabeçalho do relatório e a limpa quando muda de contexto.
   *
   * O importador só aparece se `onListaChange` for passado — opt-in
   * explícito, para que um relatório onde a lista não faça sentido não
   * a ganhe por acidente.
   */
  lista?: ListaCodigosResolvida | null;
  onListaChange?: (lista: ListaCodigosResolvida | null) => void;
};

export function ReportFiltersBar({
  options,
  value,
  onChange,
  hideDates = false,
  searchPlaceholder = "Pesquisar produto, CNP, fornecedor ou fabricante",
  mostrarNaturezas = false,
  lista = null,
  onListaChange,
}: Props) {
  const [filtrosAbertos, setFiltrosAbertos] = useState(false);
  const patch = (delta: Partial<SharedReportFilters>) => onChange({ ...value, ...delta });
  const filtrosAtivosCount = contarFiltrosAtivos(value);

  /**
   * "Limpar filtros" — mesma regra e alcance definidos em
   * `limparFiltrosPreservandoData` (mantém `from`/`to`, repõe o resto).
   * A lista importada é um caso à parte: vive em `lista`/`onListaChange`
   * (estado do PAI, não de `value`), por isso é limpa aqui explicitamente
   * junto com o resto — nunca fica um "437 produtos" esquecido no
   * cabeçalho depois de "Limpar filtros".
   */
  const limpar = () => {
    onListaChange?.(null);
    onChange(limparFiltrosPreservandoData(value));
  };

  /**
   * A lista e o filtro movem-se JUNTOS, num único `onChange` de cada
   * lado. Manter `filters.cnps` sincronizado noutro sítio (um `useEffect`
   * no pai, por exemplo) abria a janela em que o chip já diz "437
   * produtos" e o relatório ainda corre sem restrição — e é exactamente
   * essa janela que o utilizador apanharia, porque carrega em "Gerar"
   * logo a seguir a importar.
   *
   * `undefined` quando não há lista, e não `[]`: são coisas diferentes.
   * Ver `SharedReportFilters.cnps`.
   */
  const aplicarLista = (nova: ListaCodigosResolvida | null) => {
    onListaChange?.(nova);
    onChange({ ...value, cnps: nova ? nova.cnps : undefined });
  };

  // As subcategorias visíveis acompanham a categoria escolhida: com
  // "MEDICAMENTOS" seleccionado, oferecer "Solares" seria oferecer uma
  // combinação que devolve zero linhas. Sem categoria escolhida, todas.
  const subcategoriasVisiveis = (
    value.categorias && value.categorias.length > 0
      ? options.subcategorias.filter((s) => value.categorias!.includes(s.categoria))
      : options.subcategorias
  ).map((s) => s.nome);

  // O filtro viaja em SLUG (estável entre bases) mas mostra-se pelo nome.
  const utilizacaoNomes = options.utilizacoes.map((u) => u.nome);
  const slugPorNome = new Map(options.utilizacoes.map((u) => [u.nome, u.slug]));
  const nomePorSlug = new Map(options.utilizacoes.map((u) => [u.slug, u.nome]));

  return (
    <section className="rounded-[16px] border border-slate-200/60 bg-white/72 p-3.5 shadow-[0_14px_30px_rgba(15,23,42,0.045)]">
      {/* Linha de topo: search + datas (datas escondidas em snapshot
          mode) + o botão "Filtros" (com contador) + "Limpar filtros" —
          sempre visíveis, mesmo padrão do Vendas. */}
      <div
        className={
          hideDates
            ? "grid gap-3 md:grid-cols-[1fr_auto_auto]"
            : "grid gap-3 md:grid-cols-[1.5fr_160px_160px_auto_auto]"
        }
      >
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={value.pesquisa ?? ""}
            onChange={(e) => patch({ pesquisa: e.target.value })}
            placeholder={searchPlaceholder}
            className="h-10 w-full rounded-[12px] border border-slate-200 bg-white pl-9 pr-3 text-[13px] text-slate-700 outline-none focus:border-emerald-200"
          />
        </div>
        {!hideDates && (
          <>
            <input
              type="date"
              value={value.from ?? ""}
              onChange={(e) => patch({ from: e.target.value || undefined })}
              className="h-10 rounded-[12px] border border-slate-200 bg-white px-3 text-[12px] text-slate-700 outline-none focus:border-emerald-200"
              aria-label="Desde"
            />
            <input
              type="date"
              value={value.to ?? ""}
              onChange={(e) => patch({ to: e.target.value || undefined })}
              className="h-10 rounded-[12px] border border-slate-200 bg-white px-3 text-[12px] text-slate-700 outline-none focus:border-emerald-200"
              aria-label="Até"
            />
          </>
        )}
        <FiltrosToggleButton
          aberto={filtrosAbertos}
          onToggle={() => setFiltrosAbertos((prev) => !prev)}
          contagem={filtrosAtivosCount}
        />
        <LimparFiltrosButton onClick={limpar} />
      </div>

      {/* ── Painel avançado — só quando aberto ── */}
      {filtrosAbertos && (
        <div className="mt-3 rounded-2xl border border-slate-200 bg-white p-3">
          {/* Lista importada por ficheiro. Fica logo no topo do painel
              porque é a mesma pergunta — "que artigos?" — feita com um
              ficheiro em vez de com uma caixa de texto. Combina-se com
              tudo o resto por E lógico. */}
          {onListaChange && (
            <div className="mb-3">
              <ImportListaCodigos lista={lista} onChange={aplicarLista} />
            </div>
          )}

          {/* Catálogo — farmácia, os DOIS níveis, e utilização.
              Categoria e subcategoria são selects separados de
              propósito: são níveis diferentes, e tratá-los como um só
              foi o defeito que isto corrige. */}
          <div className="grid gap-3 md:grid-cols-4">
            <FilterSelect
              label="Farmácia"
              options={options.farmacias}
              selected={value.farmaciaNomes ?? []}
              onChange={(v) => patch({ farmaciaNomes: v })}
            />
            <FilterSelect
              label="Categoria"
              options={options.categorias}
              selected={value.categorias ?? []}
              onChange={(v) => patch({ categorias: v })}
            />
            <FilterSelect
              label="Subcategoria"
              options={subcategoriasVisiveis}
              selected={value.subcategorias ?? []}
              onChange={(v) => patch({ subcategorias: v })}
            />
            <FilterSelect
              label="Utilização"
              options={utilizacaoNomes}
              selected={(value.utilizacoes ?? []).map((s) => nomePorSlug.get(s) ?? s)}
              onChange={(nomes) =>
                patch({ utilizacoes: nomes.map((n) => slugPorNome.get(n) ?? n) })
              }
            />
          </div>

          {/* Proveniência comercial. */}
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <FilterSelect
              label="Fabricante"
              options={options.fabricantes}
              selected={value.fabricantes ?? []}
              onChange={(v) => patch({ fabricantes: v })}
            />
            <FilterSelect
              label="Distribuidor"
              options={options.distribuidores}
              selected={value.distribuidores ?? []}
              onChange={(v) => patch({ distribuidores: v })}
            />
          </div>

          {/* Chips das selecções activas — mesmo padrão do Vendas, para
              ver de relance o que está a restringir o relatório sem ter
              de reabrir cada multi-select. */}
          <div className="mt-3 flex flex-wrap gap-2">
            {(value.farmaciaNomes ?? []).map((item) => (
              <FilterPill key={`farmacia-${item}`} label={item} onRemove={() => patch({ farmaciaNomes: (value.farmaciaNomes ?? []).filter((v) => v !== item) })} />
            ))}
            {(value.categorias ?? []).map((item) => (
              <FilterPill key={`categoria-${item}`} label={item} onRemove={() => patch({ categorias: (value.categorias ?? []).filter((v) => v !== item) })} />
            ))}
            {(value.subcategorias ?? []).map((item) => (
              <FilterPill key={`subcategoria-${item}`} label={item} onRemove={() => patch({ subcategorias: (value.subcategorias ?? []).filter((v) => v !== item) })} />
            ))}
            {(value.utilizacoes ?? []).map((slug) => (
              <FilterPill key={`utilizacao-${slug}`} label={nomePorSlug.get(slug) ?? slug} onRemove={() => patch({ utilizacoes: (value.utilizacoes ?? []).filter((v) => v !== slug) })} />
            ))}
            {(value.fabricantes ?? []).map((item) => (
              <FilterPill key={`fabricante-${item}`} label={item} onRemove={() => patch({ fabricantes: (value.fabricantes ?? []).filter((v) => v !== item) })} />
            ))}
            {(value.distribuidores ?? []).map((item) => (
              <FilterPill key={`distribuidor-${item}`} label={item} onRemove={() => patch({ distribuidores: (value.distribuidores ?? []).filter((v) => v !== item) })} />
            ))}
          </div>
        </div>
      )}

      {/* ── Filtros rápidos — sempre visíveis, fora do painel ── */}
      {(options.semClassificacao || mostrarNaturezas) && (
        <div className="mt-2.5 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-slate-100 pt-2.5">
          {/* "Apenas produtos sem classificação" — só aparece se houver
              produtos de CATÁLOGO sem classificação no tenant. Evita
              poluir a UI quando não é relevante.

              O rótulo dizia "sem classificação canónica" e implementava
              "sem classificação nenhuma". Antes das classificações
              provisórias as duas frases eram sinónimas; deixaram de ser
              no dia em que passou a existir um terceiro estado. Quem
              ligasse o filtro à procura de provisórias não encontrava
              nenhuma — elas TÊM nível 1 — e concluía que a grelha as
              escondia. */}
          {options.semClassificacao && (
            <ToggleRow
              label="Apenas produtos sem classificação"
              checked={!!value.apenasSemClassif}
              onChange={(v) => patch({ apenasSemClassif: v || undefined })}
              compact
            />
          )}

          {/* Os dois interruptores do relatório oficial do SPharm.
              Os defaults são os do relatório contra o qual reconciliamos
              — crédito Sim, transferências Não — e o rótulo à direita
              está sempre à vista para ninguém ter de adivinhar o que
              está a ver. Um total já somado não se desligava: a natureza
              vive até à query. */}
          {mostrarNaturezas && (
            <>
              <ToggleRow
                label="Incluir vendas a crédito"
                checked={value.incluirCredito ?? DEFAULT_INCLUIR_CREDITO}
                onChange={(v) => patch({ incluirCredito: v })}
                compact
              />
              <ToggleRow
                label="Incluir guias de transferência"
                checked={value.incluirTransferencias ?? DEFAULT_INCLUIR_TRANSFERENCIAS}
                onChange={(v) => patch({ incluirTransferencias: v })}
                compact
              />
              <span className="text-[11px] text-slate-400">{rotuloNaturezas(value)}</span>
            </>
          )}
        </div>
      )}
    </section>
  );
}
