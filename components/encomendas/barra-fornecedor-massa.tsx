"use client";

/**
 * components/encomendas/barra-fornecedor-massa.tsx
 *
 * Barra de SELECÇÃO e ATRIBUIÇÃO COLECTIVA de fornecedor nas linhas de uma
 * encomenda — a mesma nos três ecrãs (farmácia, grupo, consolidação).
 *
 * Não persiste nada por si: chama `onAplicar(keys, fornecedorId)` — o ecrã liga
 * isso ao MESMO caminho de gravação que a edição linha a linha
 * (`handleBulkFornecedorChange*` → `persistLineChange*` → autosave). Decide o
 * `fornecedorSugeridoId` DAS LINHAS DESTA ENCOMENDA; nunca altera o fornecedor
 * habitual em `ProdutoFarmacia` (esse mantém-se pela manutenção do catálogo).
 *
 * As regras (âmbitos, resumo, paginação) estão em
 * `lib/encomendas/selecao-fornecedor-massa.ts` (puras e testadas).
 */
import { useMemo, useState } from "react";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  alternarPagina,
  resumirAtribuicao,
  selecaoValida,
  selecionarDaFarmacia,
  selecionarPrimeiras,
  selecionarSemFornecedor,
  selecionarTodas,
  type LinhaSelecionavel,
} from "@/lib/encomendas/selecao-fornecedor-massa";

type ItemFornecedor = { id: string; label: string };

type Pendente = { tipo: "atribuir"; keys: number[] } | { tipo: "limpar"; keys: number[] };

export function BarraFornecedorEmMassa({
  todas,
  visiveis,
  pagina,
  selecionadas,
  setSelecionadas,
  fornecedoresItems,
  nomeFornecedor,
  farmacias,
  onAplicar,
  disabled,
  idPrefixo = "bulk",
}: {
  /** TODAS as linhas da encomenda. */
  todas: readonly LinhaSelecionavel[];
  /** As linhas visíveis (depois dos filtros), na ordem do ecrã. */
  visiveis: readonly LinhaSelecionavel[];
  /** As linhas da página actual (omitir para esconder a selecção por página). */
  pagina?: readonly LinhaSelecionavel[];
  selecionadas: ReadonlySet<number>;
  setSelecionadas: (s: Set<number>) => void;
  fornecedoresItems: ItemFornecedor[];
  nomeFornecedor: (id: string) => string;
  /** Farmácias presentes na encomenda (para «todas as linhas da farmácia X»). */
  farmacias: Array<{ id: string; nome: string }>;
  /** `fornecedorId === ""` limpa o fornecedor. */
  onAplicar: (keys: ReadonlySet<number>, fornecedorId: string) => void;
  disabled?: boolean;
  idPrefixo?: string;
}) {
  const [destinoId, setDestinoId] = useState("");
  const [nPrimeiras, setNPrimeiras] = useState("20");
  const [pendente, setPendente] = useState<Pendente | null>(null);
  const [mensagem, setMensagem] = useState<string | null>(null);

  const validas = useMemo(() => selecaoValida(selecionadas, todas), [selecionadas, todas]);
  const semFornecedorTotal = todas.filter((l) => l.fornecedorSugeridoId == null).length;

  const resumo = useMemo(() => {
    if (!pendente) return null;
    const linhas = todas.filter((l) => pendente.keys.includes(l.key));
    return resumirAtribuicao(linhas, pendente.tipo === "limpar" ? null : destinoId || null);
  }, [pendente, todas, destinoId]);

  function sel(s: Set<number>) {
    setMensagem(null);
    setPendente(null);
    setSelecionadas(s);
  }

  function abrirAtribuir(keys: number[]) {
    if (!destinoId || keys.length === 0) return;
    setMensagem(null);
    setPendente({ tipo: "atribuir", keys });
  }

  function confirmar() {
    if (!pendente || !resumo) return;
    const keys = new Set(pendente.keys);
    onAplicar(keys, pendente.tipo === "limpar" ? "" : destinoId);
    setMensagem(
      pendente.tipo === "limpar"
        ? `Fornecedor limpo em ${resumo.aAlterar} linha(s).`
        : `Fornecedor «${nomeFornecedor(destinoId)}» atribuído a ${resumo.aAlterar} linha(s) (${resumo.jaComDestino} já o tinham).`
    );
    setPendente(null);
    setSelecionadas(new Set());
  }

  const btn =
    "rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[12px] font-medium text-slate-700 hover:border-cyan-300 disabled:opacity-40";
  const keysSelecionadas = validas.map((l) => l.key);
  const keysVisiveis = visiveis.map((l) => l.key);
  const keysTodas = todas.map((l) => l.key);

  return (
    <div className="space-y-2 border-b border-slate-100 bg-white px-4 py-2.5 text-[12px]" data-testid={`${idPrefixo}-barra`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-slate-700">Seleccionar:</span>
        <button type="button" className={btn} disabled={disabled || visiveis.length === 0} onClick={() => sel(selecionarPrimeiras(visiveis, 20))} data-testid={`${idPrefixo}-primeiras-20`}>
          Primeiras 20
        </button>
        <button type="button" className={btn} disabled={disabled || visiveis.length === 0} onClick={() => sel(selecionarPrimeiras(visiveis, 30))} data-testid={`${idPrefixo}-primeiras-30`}>
          Primeiras 30
        </button>
        <span className="inline-flex items-center gap-1">
          <input
            type="number"
            min={1}
            value={nPrimeiras}
            onChange={(e) => setNPrimeiras(e.target.value)}
            aria-label="Número de linhas a seleccionar"
            className="w-16 rounded-lg border border-slate-200 px-2 py-1 text-right text-[12px]"
          />
          <button type="button" className={btn} disabled={disabled || visiveis.length === 0} onClick={() => sel(selecionarPrimeiras(visiveis, Number(nPrimeiras)))} data-testid={`${idPrefixo}-primeiras-n`}>
            Primeiras N
          </button>
        </span>
        {pagina && (
          <button type="button" className={btn} disabled={disabled || pagina.length === 0} onClick={() => sel(alternarPagina(selecionadas, pagina))} data-testid={`${idPrefixo}-pagina`}>
            Página ({pagina.length})
          </button>
        )}
        <button type="button" className={btn} disabled={disabled || visiveis.length === 0} onClick={() => sel(new Set(keysVisiveis))} data-testid={`${idPrefixo}-filtradas`}>
          Todas as filtradas ({visiveis.length})
        </button>
        <button type="button" className={btn} disabled={disabled || semFornecedorTotal === 0} onClick={() => sel(selecionarSemFornecedor(todas))} data-testid={`${idPrefixo}-sem-fornecedor`}>
          Só sem fornecedor ({semFornecedorTotal}) — toda a encomenda
        </button>
        {farmacias.length > 1 && (
          <select
            aria-label="Seleccionar todas as linhas de uma farmácia"
            data-testid={`${idPrefixo}-farmacia`}
            value=""
            disabled={disabled}
            onChange={(e) => {
              if (e.target.value) sel(selecionarDaFarmacia(todas, e.target.value));
            }}
            className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-[12px] text-slate-700"
          >
            <option value="">Todas as linhas da farmácia…</option>
            {farmacias.map((f) => (
              <option key={f.id} value={f.id}>
                {f.nome} ({todas.filter((l) => l.farmaciaId === f.id).length})
              </option>
            ))}
          </select>
        )}
        <button type="button" className={btn} disabled={disabled || todas.length === 0} onClick={() => sel(selecionarTodas(todas))} data-testid={`${idPrefixo}-toda`}>
          Toda a encomenda ({todas.length})
        </button>
        <button type="button" className={`${btn} text-slate-500`} disabled={disabled || selecionadas.size === 0} onClick={() => sel(new Set())} data-testid={`${idPrefixo}-limpar-selecao`}>
          Limpar selecção
        </button>
        <span className="ml-auto font-medium text-slate-700" data-testid={`${idPrefixo}-contagem`} aria-live="polite">
          {validas.length} linha{validas.length === 1 ? "" : "s"} seleccionada{validas.length === 1 ? "" : "s"} de {todas.length}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-slate-700">Fornecedor:</span>
        <div className="w-60">
          <SearchableSelect
            items={fornecedoresItems}
            value={destinoId || null}
            onChange={(v) => {
              setDestinoId(v ?? "");
              setPendente(null);
            }}
            placeholder="— Pesquisar fornecedor —"
            ariaLabel="Fornecedor a atribuir"
          />
        </div>
        <button type="button" className={btn} disabled={disabled || !destinoId || validas.length === 0} onClick={() => abrirAtribuir(keysSelecionadas)} data-testid={`${idPrefixo}-atribuir`}>
          Atribuir fornecedor às seleccionadas
        </button>
        <button type="button" className={btn} disabled={disabled || !destinoId || visiveis.length === 0} onClick={() => abrirAtribuir(keysVisiveis)} data-testid={`${idPrefixo}-atribuir-filtradas`}>
          Atribuir a todas as filtradas
        </button>
        <button type="button" className={btn} disabled={disabled || !destinoId || todas.length === 0} onClick={() => abrirAtribuir(keysTodas)} data-testid={`${idPrefixo}-atribuir-toda`}>
          Atribuir a toda a encomenda
        </button>
        <button
          type="button"
          className={`${btn} hover:border-rose-300 hover:text-rose-700`}
          disabled={disabled || validas.length === 0}
          onClick={() => {
            setMensagem(null);
            setPendente({ tipo: "limpar", keys: keysSelecionadas });
          }}
          data-testid={`${idPrefixo}-limpar-fornecedor`}
        >
          Limpar fornecedor das seleccionadas
        </button>
      </div>

      {pendente && resumo && (
        <div className="rounded-lg border border-cyan-200 bg-cyan-50/60 p-3" role="dialog" aria-label="Confirmar atribuição de fornecedor" data-testid={`${idPrefixo}-resumo`}>
          <p className="font-semibold text-slate-800">
            {pendente.tipo === "limpar"
              ? "Limpar o fornecedor destas linhas"
              : `Atribuir «${nomeFornecedor(destinoId)}» a estas linhas`}
          </p>
          <ul className="mt-1 space-y-0.5 text-slate-700">
            <li data-testid={`${idPrefixo}-resumo-linhas`}>Linhas: <strong>{resumo.linhas}</strong> · produtos distintos: <strong>{resumo.produtosDistintos}</strong></li>
            <li>
              Farmácias:{" "}
              {resumo.farmacias.map((f) => `${f.farmaciaNome} (${f.linhas})`).join(" · ") || "—"}
            </li>
            {pendente.tipo === "atribuir" && <li>Fornecedor de destino: <strong>{nomeFornecedor(destinoId)}</strong></li>}
            <li>Sem fornecedor hoje: <strong>{resumo.semFornecedor}</strong></li>
            <li>{pendente.tipo === "atribuir" ? "Já têm o fornecedor escolhido" : "Já estão sem fornecedor"}: <strong>{resumo.jaComDestino}</strong></li>
            <li data-testid={`${idPrefixo}-resumo-alterar`}>Serão efectivamente alteradas: <strong>{resumo.aAlterar}</strong></li>
          </ul>
          <p className="mt-1 text-[11px] text-slate-500">
            Isto só decide o fornecedor desta encomenda — o fornecedor habitual do produto na farmácia não é alterado.
          </p>
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={confirmar} disabled={resumo.aAlterar === 0} className="rounded-lg border border-cyan-600 bg-cyan-600 px-3 py-1 text-[12px] font-semibold text-white disabled:opacity-40" data-testid={`${idPrefixo}-confirmar`}>
              {pendente.tipo === "limpar" ? "Limpar fornecedor" : "Atribuir fornecedor"}
            </button>
            <button type="button" onClick={() => setPendente(null)} className="rounded-lg border border-slate-200 bg-white px-3 py-1 text-[12px] text-slate-600">
              Cancelar
            </button>
          </div>
        </div>
      )}
      {mensagem && (
        <p role="status" className="text-emerald-700" data-testid={`${idPrefixo}-mensagem`}>
          {mensagem}
        </p>
      )}
    </div>
  );
}
