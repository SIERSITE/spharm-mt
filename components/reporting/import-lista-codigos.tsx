"use client";

/**
 * components/reporting/import-lista-codigos.tsx
 *
 * O importador de listas de CNP/códigos. UM componente, usado tal e qual
 * nos Relatórios e nas Encomendas.
 *
 * Controlled: o pai guarda a `ListaCodigosResolvida` (ou `null`) e
 * decide o que fazer com ela. Este componente não sabe o que é um
 * relatório nem o que é uma encomenda — só sabe transformar um ficheiro
 * numa lista e mostrá-la.
 *
 * ── Porque é que não importa o parser ────────────────────────────────
 *
 * Só importa TIPOS, de `lista-codigos-tipos.ts`. O parser vive no
 * servidor porque depende do `xlsx`, e um `import` de valor daqui
 * arrastava ~900 KB para o bundle do browser. O upload vai por `fetch`
 * para `/api/produtos/lista-codigos`.
 */
import { useRef, useState } from "react";
import { FileUp, Loader2, X } from "lucide-react";
import {
  EXTENSOES_ACEITES,
  type ListaCodigosResolvida,
  type ListaCodigosResposta,
} from "@/lib/produtos/lista-codigos-tipos";

type Props = {
  lista: ListaCodigosResolvida | null;
  onChange: (lista: ListaCodigosResolvida | null) => void;
  disabled?: boolean;
  /**
   * Nota contextual à direita do resumo. É por aqui que as Encomendas
   * dizem "120 com vendas no período" — informação que só o módulo
   * consumidor tem, e que o importador não pode inventar.
   */
  nota?: string;
};

const ENDPOINT = "/api/produtos/lista-codigos";

function plural(n: number, singular: string, pluralForm: string): string {
  return `${n.toLocaleString("pt-PT")} ${n === 1 ? singular : pluralForm}`;
}

export function ImportListaCodigos({ lista, onChange, disabled, nota }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [aCarregar, setACarregar] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [verNaoEncontrados, setVerNaoEncontrados] = useState(false);

  async function enviar(file: File) {
    setErro(null);
    setACarregar(true);
    setVerNaoEncontrados(false);
    try {
      const form = new FormData();
      form.append("file", file);
      const r = await fetch(ENDPOINT, { method: "POST", body: form });
      const body = (await r.json()) as ListaCodigosResposta;
      if (!body.ok) {
        setErro(body.erro);
        return;
      }
      onChange(body.lista);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Falha a enviar o ficheiro.");
    } finally {
      setACarregar(false);
      // Sem isto, escolher o MESMO ficheiro outra vez (depois de o
      // corrigir no Excel) não dispara `change` e nada acontece.
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  function limpar() {
    onChange(null);
    setErro(null);
    setVerNaoEncontrados(false);
    if (inputRef.current) inputRef.current.value = "";
  }

  const bloqueado = disabled || aCarregar;

  return (
    <div className="rounded-[12px] border border-slate-200 bg-white/70 p-3">
      <input
        ref={inputRef}
        type="file"
        accept={EXTENSOES_ACEITES.join(",")}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void enviar(f);
        }}
      />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <button
          type="button"
          disabled={bloqueado}
          onClick={() => inputRef.current?.click()}
          className="inline-flex items-center gap-1.5 rounded-[10px] border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-medium text-slate-700 transition hover:border-emerald-300 hover:text-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {aCarregar ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <FileUp className="h-3.5 w-3.5" aria-hidden />
          )}
          {aCarregar
            ? "A ler ficheiro…"
            : lista
              ? "Substituir ficheiro"
              : "Importar lista de CNP/Códigos"}
        </button>

        {!lista && !aCarregar && (
          <span className="text-[11px] text-slate-400">
            .txt, .csv, .xlsx ou .xls — um código por linha ou separados por ; , ou tabulação
          </span>
        )}

        {lista && (
          <>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-[12px] font-medium text-emerald-800">
              Lista importada: {plural(lista.encontrados, "produto", "produtos")}
            </span>
            {nota && <span className="text-[11px] text-slate-500">{nota}</span>}
            <button
              type="button"
              onClick={limpar}
              disabled={bloqueado}
              className="inline-flex items-center gap-1 text-[11px] text-slate-500 underline-offset-2 transition hover:text-rose-600 hover:underline disabled:opacity-50"
            >
              <X className="h-3 w-3" aria-hidden />
              Limpar lista
            </button>
          </>
        )}
      </div>

      {/* Contabilidade do ficheiro. Todos os números que o pedido
          enumerou, e sempre os quatro — um "0 duplicados" é informação:
          diz que o ficheiro estava limpo. */}
      {lista && (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500">
          <span className="font-mono text-slate-400">{lista.nomeFicheiro}</span>
          {lista.folha && <span>folha «{lista.folha}»</span>}
          {lista.coluna && <span>coluna «{lista.coluna}»</span>}
          <span>{plural(lista.totalLidos, "código lido", "códigos lidos")}</span>
          <span>{plural(lista.encontrados, "produto encontrado", "produtos encontrados")}</span>
          <span>{plural(lista.duplicados, "duplicado", "duplicados")}</span>
          {lista.naoEncontrados.length > 0 ? (
            <button
              type="button"
              onClick={() => setVerNaoEncontrados((v) => !v)}
              className="font-medium text-amber-700 underline-offset-2 hover:underline"
            >
              {plural(lista.naoEncontrados.length, "código não encontrado", "códigos não encontrados")}
              {verNaoEncontrados ? " ▴" : " ▾"}
            </button>
          ) : (
            <span>0 códigos não encontrados</span>
          )}
          {lista.ignorados.length > 0 && (
            <span
              title={`Descartado por não ser um código: ${lista.ignorados.slice(0, 10).join(", ")}`}
            >
              {plural(lista.ignorados.length, "valor ignorado", "valores ignorados")}
            </span>
          )}
        </div>
      )}

      {/* Os não encontrados, consultáveis — era requisito explícito.
          Em texto seleccionável e não numa tabela: o que o utilizador faz
          a seguir é copiá-los para o ERP. */}
      {lista && verNaoEncontrados && lista.naoEncontrados.length > 0 && (
        <div className="mt-2 rounded-[10px] border border-amber-200 bg-amber-50/70 p-2.5">
          <div className="mb-1.5 flex items-center justify-between gap-3">
            <span className="text-[11px] font-medium text-amber-900">
              Códigos do ficheiro que não existem no catálogo
            </span>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(lista.naoEncontrados.join("\n"));
              }}
              className="text-[11px] text-amber-800 underline-offset-2 hover:underline"
            >
              Copiar
            </button>
          </div>
          <div className="max-h-32 overflow-y-auto font-mono text-[11px] leading-5 text-amber-900">
            {lista.naoEncontrados.join(", ")}
          </div>
        </div>
      )}

      {erro && (
        <p className="mt-2 rounded-[10px] border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[11px] text-rose-700">
          {erro}
        </p>
      )}
    </div>
  );
}
