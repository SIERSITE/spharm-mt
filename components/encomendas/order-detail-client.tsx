"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { ArrowLeft, Plus, RefreshCw, Trash2, XCircle } from "lucide-react";
import type { OrderDetail, OrderTimelineEvent } from "@/lib/encomendas/order-detail";
import { rotuloOrigem } from "@/lib/encomendas/origem-linha";
import { OrderExportBadge } from "@/components/integracao/order-export-badge";
import { ArtigoLink } from "@/components/stock/artigo-link";
import { AutosaveStatusBadge } from "@/components/encomendas/autosave-status-badge";
import { ProductPicker } from "@/components/encomendas/product-picker";
import { HistoricoProdutoButton } from "@/components/encomendas/historico-produto-modal";
import {
  addManualLineAction,
  autosaveEncomendaAction,
  cancelDraftAction,
  cancelOutboxAction,
  duplicarRascunhoComoNovoAction,
  finalizeFromDetailAction,
  removeLineAction,
  retryOutboxAction,
} from "@/app/encomendas/[id]/actions";
import type { ProductSearchResult } from "@/app/encomendas/nova/search";
import { useAutosaveEncomenda } from "@/lib/encomendas/use-autosave-encomenda";
import { useUtilizador } from "@/components/layout/session-provider";
import { useTaskBar } from "@/lib/workspace/task-bar-context";

type Props = { detail: OrderDetail };

const ESTADO_LABEL: Record<string, string> = {
  RASCUNHO: "Rascunho",
  FINALIZADA: "Finalizada",
  EXPORTADA: "Exportada",
};

function fmtNum(v: number | null, digits = 0): string {
  if (v == null) return "—";
  if (digits === 0) return String(Math.round(v));
  return v.toFixed(digits);
}

function fmtDateTime(d: Date | string | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("pt-PT", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const TIMELINE_STATUS_STYLE: Record<string, string> = {
  ATTEMPT: "border-slate-200 bg-slate-50 text-slate-700",
  LEASE_CLAIMED: "border-cyan-200 bg-cyan-50 text-cyan-700",
  LEASE_RELEASED: "border-slate-200 bg-slate-50 text-slate-600",
  LEASE_EXPIRED: "border-amber-200 bg-amber-50 text-amber-700",
  SUCCESS: "border-emerald-200 bg-emerald-50 text-emerald-700",
  FAILURE: "border-rose-200 bg-rose-50 text-rose-700",
  RETRY_SCHEDULED: "border-amber-200 bg-amber-50 text-amber-700",
  GAVE_UP: "border-rose-300 bg-rose-100 text-rose-800",
  MANUAL_RETRY: "border-cyan-200 bg-cyan-50 text-cyan-700",
  MANUAL_CANCEL: "border-slate-200 bg-slate-50 text-slate-600",
};

export function OrderDetailClient({ detail }: Props) {
  const router = useRouter();
  const [busy, startTransition] = useTransition();
  const [flash, setFlash] = useState<{ type: "ok" | "err" | "info"; msg: string } | null>(
    null
  );
  const [manualOpen, setManualOpen] = useState(false);

  // Estado optimista das linhas — actualizamos localmente e a server
  // action revalida o path (refresh do server component empurra a fonte
  // de verdade). Em caso de erro, o flash mostra e o router refresh
  // restaura.
  const [linhas, setLinhas] = useState(detail.linhas);

  const utilizador = useUtilizador();
  const autosave = useAutosaveEncomenda({
    listaEncomendaId: detail.id,
    farmaciaId: detail.farmaciaId,
    versaoInicial: detail.versao,
    tenantSlug: utilizador?.tenant ?? "desconhecido",
    userId: utilizador?.userId ?? "desconhecido",
    autosaveAction: autosaveEncomendaAction,
  });

  // Barra de tarefas: título mais claro que o genérico "Encomendas" (a
  // rota auto-regista só o tipo), e sincroniza o indicador "por guardar"
  // com o MESMO sinal que já governa o beforeunload do autosave — nunca
  // duas fontes de verdade para "há trabalho por guardar".
  const taskBar = useTaskBar();
  const pathname = usePathname();
  useEffect(() => {
    if (pathname) taskBar?.actualizarTitulo(pathname, `Encomenda — ${detail.nome}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, detail.nome]);
  useEffect(() => {
    if (pathname) taskBar?.marcarSujo(pathname, autosave.temAlteracoesPendentes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, autosave.temAlteracoesPendentes]);

  // ─── Ponto 3 (secundário) — navegação por teclado no campo "Final" ────────
  //
  // Tabela mais simples que a de `order-create-client.tsx` — sem célula
  // de Decisão, um único campo operacional por linha ("Final"). Mesmo
  // padrão de índice estável (posição na lista renderizada) + refs, sem
  // capturar Tab nem as setas de nenhum `<select>` (não há nenhum aqui).
  const finalQtyRefs = useRef<Array<HTMLInputElement | null>>([]);

  function handleFinalQtyKeyDown(e: ReactKeyboardEvent<HTMLInputElement>, rowIndex: number) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const el = finalQtyRefs.current[Math.min(rowIndex + 1, linhas.length - 1)];
      if (el) { el.focus(); el.select(); }
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      const el = finalQtyRefs.current[Math.max(rowIndex - 1, 0)];
      if (el) { el.focus(); el.select(); }
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const targetIndex = e.shiftKey ? rowIndex - 1 : rowIndex + 1;
      if (targetIndex < 0 || targetIndex > linhas.length - 1) return;
      const el = finalQtyRefs.current[targetIndex];
      if (el) { el.focus(); el.select(); }
    }
  }

  const editable = detail.editable && !busy;
  const totalQty = linhas.reduce(
    (s, l) => s + (l.quantidadeAjustada ?? 0),
    0
  );

  // Autosave, não escrita imediata: cada mudança marca a LINHA como suja
  // (por produtoId — a chave que o servidor usa para upsert) e agenda um
  // autosave debounced (ver lib/encomendas/use-autosave-encomenda.ts).
  // Quantidade/notas SUGERIDA nunca é enviada — só o que o utilizador
  // decidiu (quantidadeAjustada/notas); a origem também não é enviada
  // aqui, para nunca sobrescrever PROPOSTA/SUGESTAO já gravadas.
  function handleQtyChange(linhaId: string, value: string) {
    const n = value === "" ? null : Number(value);
    const quantidadeAjustada = n != null && Number.isFinite(n) ? Math.max(0, n) : null;
    setLinhas((prev) => prev.map((l) => (l.id === linhaId ? { ...l, quantidadeAjustada } : l)));
    const line = linhas.find((l) => l.id === linhaId);
    if (line) autosave.marcarSujo(line.produtoId, { quantidadeAjustada });
  }

  function handleNotasChange(linhaId: string, value: string) {
    setLinhas((prev) => prev.map((l) => (l.id === linhaId ? { ...l, notas: value } : l)));
    const line = linhas.find((l) => l.id === linhaId);
    if (line) autosave.marcarSujo(line.produtoId, { notas: value });
  }

  // "Guardar também no blur de campos críticos" — força o flush
  // imediato (ignora o debounce) em vez de esperar o temporizador. O
  // autosave já sabe quais produtos estão sujos (marcarSujo), por isso
  // não precisa de saber qual linha originou o blur.
  function handleBlurAutosave() {
    void autosave.guardarAgora();
  }

  function handleRemove(linhaId: string) {
    if (!confirm("Remover esta linha da encomenda?")) return;
    setFlash(null);
    startTransition(async () => {
      const r = await removeLineAction({
        listaEncomendaId: detail.id,
        linhaId,
      });
      if (r.ok) {
        setLinhas((prev) => prev.filter((l) => l.id !== linhaId));
        setFlash({ type: "info", msg: "Linha removida." });
      } else {
        setFlash({ type: "err", msg: r.error });
      }
    });
  }

  function handlePickManual(p: ProductSearchResult) {
    setFlash(null);
    startTransition(async () => {
      const r = await addManualLineAction({
        listaEncomendaId: detail.id,
        produtoId: p.id,
        quantidadeAjustada: 1,
      });
      if (r.ok) {
        setFlash({ type: "ok", msg: `${p.designacao} adicionado.` });
        router.refresh();
      } else {
        setFlash({ type: "err", msg: r.error });
      }
    });
  }

  function handleFinalize() {
    if (!confirm("Finalizar esta encomenda e enviar para a fila de exportação?")) return;
    setFlash(null);
    startTransition(async () => {
      // Força a conclusão de qualquer gravação pendente ANTES de
      // finalizar — nunca finaliza deixando alterações locais para trás.
      const gravado = await autosave.flushSincrono();
      if (!gravado) {
        setFlash({
          type: "err",
          msg: "Não foi possível gravar as últimas alterações — tenta novamente antes de finalizar.",
        });
        return;
      }
      const r = await finalizeFromDetailAction(detail.id, autosave.versaoAtual);
      if (r.ok) {
        setFlash({ type: "ok", msg: `Finalizada. Outbox: ${r.outboxId}` });
        router.refresh();
      } else if (r.conflito) {
        setFlash({
          type: "err",
          msg: "Esta encomenda foi alterada por outra sessão entretanto — actualiza a página para ver os dados mais recentes antes de finalizar.",
        });
      } else {
        setFlash({ type: "err", msg: r.error });
      }
    });
  }

  function handleCancelDraft() {
    if (!confirm("Cancelar este rascunho? Fica arquivado, nunca eliminado — podes sempre consultá-lo depois.")) return;
    setFlash(null);
    startTransition(async () => {
      const r = await cancelDraftAction(detail.id);
      if (r.ok) {
        setFlash({ type: "info", msg: "Rascunho cancelado." });
        router.refresh();
      } else {
        setFlash({ type: "err", msg: r.error });
      }
    });
  }

  function handleConflitoActualizar() {
    autosave.resolverConflitoActualizar();
    router.refresh();
  }

  function handleConflitoCriarCopia() {
    setFlash(null);
    startTransition(async () => {
      const r = await duplicarRascunhoComoNovoAction({
        farmaciaId: detail.farmaciaId,
        nomeOriginal: detail.nome,
        linhas: linhas.map((l) => ({
          produtoId: l.produtoId,
          quantidadeSugerida: l.quantidadeSugerida,
          quantidadeAjustada: l.quantidadeAjustada,
          notas: l.notas,
          origem: l.origem,
        })),
      });
      if (r.ok) {
        autosave.resolverConflitoActualizar();
        setFlash({ type: "ok", msg: "Cópia criada com as tuas alterações locais." });
        router.push(`/encomendas/${r.novoId}`);
      } else {
        setFlash({ type: "err", msg: r.error });
      }
    });
  }

  function handleRetryOutbox(outboxId: string) {
    if (!confirm("Repor a encomenda para PENDENTE para o agent tentar novamente?")) return;
    setFlash(null);
    startTransition(async () => {
      const r = await retryOutboxAction(outboxId);
      if (r.ok) {
        setFlash({ type: "ok", msg: "Encomenda reposta para PENDENTE — o agent tentará na próxima passagem." });
        router.refresh();
      } else {
        setFlash({ type: "err", msg: r.error });
      }
    });
  }

  function handleCancelOutbox(outboxId: string) {
    if (!confirm("Cancelar a exportação desta encomenda? O agent não a tentará exportar novamente.")) return;
    setFlash(null);
    startTransition(async () => {
      const r = await cancelOutboxAction(outboxId);
      if (r.ok) {
        setFlash({ type: "ok", msg: "Exportação cancelada." });
        router.refresh();
      } else {
        setFlash({ type: "err", msg: r.error });
      }
    });
  }

  return (
    <div className="space-y-6">
      {/* Voltar + título */}
      <div className="flex items-center justify-between">
        <Link
          href="/encomendas"
          className="inline-flex items-center gap-1.5 text-[13px] text-slate-600 hover:text-slate-900"
        >
          <ArrowLeft className="h-4 w-4" />
          Lista de encomendas
        </Link>
      </div>

      {/* Header */}
      <section className="rounded-xl border border-slate-200 bg-white px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold text-slate-900">{detail.nome}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-slate-600">
              <span>
                <span className="text-slate-400">Farmácia:</span> {detail.farmaciaNome}
              </span>
              <span className="text-slate-300">·</span>
              <span>
                <span className="text-slate-400">Criado por:</span> {detail.criadoPorNome}
              </span>
              <span className="text-slate-300">·</span>
              <span>
                <span className="text-slate-400">Criado:</span> {fmtDateTime(detail.dataCriacao)}
              </span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                detail.estado === "RASCUNHO"
                  ? "border-slate-200 bg-slate-50 text-slate-600"
                  : detail.estado === "FINALIZADA"
                    ? "border-cyan-200 bg-cyan-50 text-cyan-700"
                    : "border-emerald-200 bg-emerald-50 text-emerald-700"
              }`}
            >
              {ESTADO_LABEL[detail.estado] ?? detail.estado}
            </span>
            <OrderExportBadge
              state={detail.estadoExport}
              spharmDocumentId={detail.outbox?.spharmDocumentId ?? null}
              exportedAt={detail.outbox?.exportedAt ?? null}
            />
          </div>
        </div>

        {detail.outbox && (
          <div className="mt-3 grid gap-x-6 gap-y-1 border-t border-slate-100 pt-3 text-[12px] text-slate-600 md:grid-cols-3">
            <div>
              <span className="text-slate-400">Outbox:</span>{" "}
              <span className="font-mono">{detail.outbox.id}</span>
            </div>
            <div>
              <span className="text-slate-400">Tentativas:</span> {detail.outbox.attemptCount}
            </div>
            {detail.outbox.spharmDocumentId && (
              <div>
                <span className="text-slate-400">SPharm doc:</span>{" "}
                <span className="font-mono">{detail.outbox.spharmDocumentId}</span>
              </div>
            )}
            {detail.outbox.lastError && (
              <div className="md:col-span-3">
                <span className="text-rose-500">Último erro:</span>{" "}
                <span className="text-rose-700">{detail.outbox.lastError}</span>
              </div>
            )}
          </div>
        )}

        {/* Acções de gestão do outbox — visíveis só quando há outbox e estado permite */}
        {detail.outbox &&
          (detail.outbox.state === "FALHADO" || detail.outbox.state === "PENDENTE") && (
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
              {detail.outbox.state === "FALHADO" && (
                <button
                  type="button"
                  onClick={() => handleRetryOutbox(detail.outbox!.id)}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-300 bg-cyan-50 px-3 py-1.5 text-[12px] font-medium text-cyan-700 hover:bg-cyan-100 disabled:opacity-50"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Tentar novamente
                </button>
              )}
              <button
                type="button"
                onClick={() => handleCancelOutbox(detail.outbox!.id)}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-3 py-1.5 text-[12px] font-medium text-rose-700 hover:bg-rose-100 disabled:opacity-50"
              >
                <XCircle className="h-3.5 w-3.5" />
                Cancelar exportação
              </button>
              <span className="text-[11px] text-slate-400">
                Requer permissão de administrador.
              </span>
            </div>
          )}
      </section>

      {flash && (
        <div
          className={`rounded-xl border px-4 py-3 text-[13px] ${
            flash.type === "ok"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : flash.type === "info"
                ? "border-cyan-200 bg-cyan-50 text-cyan-800"
                : "border-rose-200 bg-rose-50 text-rose-800"
          }`}
        >
          {flash.msg}
        </div>
      )}

      {!detail.editable && (
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-[12px] text-slate-600">
          Esta encomenda já não é editável (estado: {ESTADO_LABEL[detail.estado] ?? detail.estado}).
          O payload do outbox é congelado na finalização — qualquer mudança implicaria cancelar e
          recriar.
        </div>
      )}

      {/* Linhas */}
      <section className="rounded-xl border border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <div>
            <h2 className="text-[14px] font-semibold text-slate-900">Linhas</h2>
            <p className="mt-0.5 text-[12px] text-slate-500">
              {linhas.length === 0
                ? "Sem linhas."
                : `${linhas.length} linha${linhas.length === 1 ? "" : "s"} · total: ${totalQty}`}
            </p>
          </div>
        </div>

        {linhas.length === 0 ? (
          <div className="px-4 py-10 text-center text-[12px] text-slate-400">
            Nenhuma linha — adicione produtos abaixo.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-slate-100 text-left text-[10px] uppercase tracking-wider text-slate-400">
                  <th className="px-3 py-2">Produto</th>
                  <th className="px-3 py-2 text-right">Stock</th>
                  <th className="px-3 py-2 text-right">Sugerida</th>
                  <th className="px-3 py-2 text-right">Final</th>
                  <th className="px-3 py-2">Notas</th>
                  <th className="px-3 py-2" />
                  {editable && <th className="px-3 py-2"></th>}
                </tr>
              </thead>
              <tbody>
                {linhas.map((l, rowIndex) => (
                  <tr key={l.id} className="border-b border-slate-50">
                    <td className="px-3 py-2">
                      <div className="flex items-baseline gap-1.5">
                        <ArtigoLink cnp={l.cnp} className="font-medium text-slate-900 hover:text-emerald-600 hover:underline">
                          {l.designacao}
                        </ArtigoLink>
                        {/* A origem sobrevive a guardar-e-reabrir. Sem
                            isto, uma encomenda reaberta era uma lista de
                            linhas todas iguais e ninguem distinguia o
                            que foi calculado do que foi decidido. */}
                        {rotuloOrigem(l.origem) && (
                          <span
                            className={`rounded-full border px-1.5 text-[10px] ${
                              l.origem === "MANUAL"
                                ? "border-amber-200 bg-amber-50 text-amber-700"
                                : "border-cyan-200 bg-cyan-50 text-cyan-700"
                            }`}
                          >
                            {rotuloOrigem(l.origem)}
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-slate-500">
                        <span className="font-mono">CNP {l.cnp}</span>
                        {l.fabricante && (
                          <>
                            <span className="text-slate-300">·</span>
                            <span>{l.fabricante}</span>
                          </>
                        )}
                        {l.fornecedor && (
                          <>
                            <span className="text-slate-300">·</span>
                            <span className="text-slate-400">{l.fornecedor}</span>
                          </>
                        )}
                      </div>
                    </td>
                    <td
                      className={`px-3 py-2 text-right tabular-nums ${
                        l.currentStock != null && l.currentStock <= 0
                          ? "text-rose-600"
                          : "text-slate-700"
                      }`}
                    >
                      {fmtNum(l.currentStock)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                      {fmtNum(l.quantidadeSugerida)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {editable ? (
                        <input
                          ref={(el) => { finalQtyRefs.current[rowIndex] = el; }}
                          type="number"
                          min="0"
                          value={l.quantidadeAjustada ?? ""}
                          onChange={(e) => handleQtyChange(l.id, e.target.value)}
                          onBlur={handleBlurAutosave}
                          onFocus={(e) => e.target.select()}
                          onKeyDown={(e) => handleFinalQtyKeyDown(e, rowIndex)}
                          disabled={busy}
                          className="w-20 rounded-lg border border-slate-200 px-2 py-1 text-right text-[13px] focus:border-cyan-400 focus:outline-none disabled:opacity-50"
                        />
                      ) : (
                        <span className="font-medium text-slate-800">
                          {fmtNum(l.quantidadeAjustada)}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {editable ? (
                        <input
                          type="text"
                          value={l.notas ?? ""}
                          onChange={(e) => handleNotasChange(l.id, e.target.value)}
                          onBlur={handleBlurAutosave}
                          placeholder="opcional"
                          disabled={busy}
                          className="w-full rounded-lg border border-slate-200 px-2 py-1 text-[12px] placeholder:text-slate-300 focus:border-cyan-400 focus:outline-none disabled:opacity-50"
                        />
                      ) : (
                        <span className="text-slate-600">{l.notas ?? "—"}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <HistoricoProdutoButton
                        produtoId={l.produtoId}
                        produtoDesignacao={l.designacao}
                        farmaciaIds={[detail.farmaciaId]}
                      />
                    </td>
                    {editable && (
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => handleRemove(l.id)}
                          disabled={busy}
                          title="Remover linha"
                          className="rounded-md border border-slate-200 p-1.5 text-slate-500 hover:border-rose-300 hover:bg-rose-50 hover:text-rose-700 disabled:opacity-50"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Adicionar produto manual */}
      {detail.editable && (
        <section className="rounded-xl border border-slate-200 bg-white">
          <button
            type="button"
            onClick={() => setManualOpen((v) => !v)}
            className="flex w-full items-center justify-between border-b border-slate-100 px-4 py-3 text-left"
          >
            <div>
              <h2 className="text-[14px] font-semibold text-slate-900">
                Adicionar produto manual
              </h2>
              <p className="mt-0.5 text-[12px] text-slate-500">
                Excepção — adiciona uma linha extra fora da proposta original.
              </p>
            </div>
            <Plus
              className={`h-4 w-4 text-slate-400 transition ${manualOpen ? "rotate-45" : ""}`}
            />
          </button>
          {manualOpen && (
            <div className="p-4">
              {/* Tambem aqui: um rascunho aberto e' onde se descobre
                  que falta um artigo, e obrigar a sair para o criar
                  perdia a encomenda que se estava a rever. */}
              <ProductPicker
                farmaciaId={detail.farmaciaId}
                disabled={busy}
                onPick={handlePickManual}
                permitirCriar
              />
            </div>
          )}
        </section>
      )}

      {/* Conflito de versão — bloqueia novas gravações automáticas até o
          utilizador escolher: actualizar (perde as alterações locais,
          que já não se aplicam à versão nova) ou criar uma cópia
          independente (preserva as alterações locais como um NOVO
          rascunho, nunca sobrescreve o original). */}
      {detail.editable && autosave.estado.tipo === "conflito" && (
        <section className="rounded-xl border border-rose-300 bg-rose-50 px-4 py-3">
          <p className="text-[13px] font-medium text-rose-800">
            Esta encomenda foi alterada por outra sessão (separador, dispositivo ou
            utilizador) enquanto a editavas aqui. As tuas alterações locais não foram
            gravadas por cima — escolhe como continuar:
          </p>
          <div className="mt-2.5 flex gap-2">
            <button
              type="button"
              onClick={handleConflitoActualizar}
              className="rounded-lg border border-rose-300 bg-white px-3.5 py-1.5 text-[12px] font-medium text-rose-800 hover:bg-rose-100"
            >
              Actualizar (descarta as alterações locais)
            </button>
            <button
              type="button"
              onClick={handleConflitoCriarCopia}
              disabled={busy}
              className="rounded-lg border border-rose-500 bg-rose-600 px-3.5 py-1.5 text-[12px] font-medium text-white hover:bg-rose-700 disabled:opacity-50"
            >
              Criar cópia com as minhas alterações
            </button>
          </div>
        </section>
      )}

      {/* Acções */}
      {detail.editable && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <AutosaveStatusBadge estado={autosave.estado} />
            {autosave.temAlteracoesPendentes && (
              <button
                type="button"
                onClick={() => void autosave.guardarAgora()}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1 text-[12px] font-medium text-slate-700 hover:bg-slate-50"
              >
                Guardar agora
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleCancelDraft}
              disabled={busy}
              className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-[13px] font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            >
              Cancelar rascunho
            </button>
            <button
              type="button"
              onClick={handleFinalize}
              disabled={busy || linhas.length === 0 || autosave.estado.tipo === "conflito"}
              className="rounded-xl border border-cyan-500 bg-cyan-600 px-5 py-2.5 text-[13px] font-medium text-white shadow-sm hover:bg-cyan-700 disabled:opacity-50"
            >
              {busy ? "A finalizar..." : "Finalizar e enviar para fila"}
            </button>
          </div>
        </div>
      )}

      {/* Timeline de exportação */}
      {detail.outbox && (
        <section className="rounded-xl border border-slate-200 bg-white">
          <div className="border-b border-slate-100 px-4 py-3">
            <h2 className="text-[14px] font-semibold text-slate-900">
              Timeline de exportação
            </h2>
            <p className="mt-0.5 text-[12px] text-slate-500">
              Eventos do agent SPharm — tentativas, ACK/NACK, retries, cancelamentos.
            </p>
          </div>

          {detail.timeline.length === 0 ? (
            <div className="px-4 py-8 text-center text-[12px] text-slate-400">
              Sem eventos — outbox criado mas o agent ainda não tentou exportar.
            </div>
          ) : (
            <ul className="divide-y divide-slate-50">
              {detail.timeline.map((ev) => (
                <TimelineItem key={ev.id} event={ev} />
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

function TimelineItem({ event }: { event: OrderTimelineEvent }) {
  const cls = TIMELINE_STATUS_STYLE[event.status] ?? "border-slate-200 bg-slate-50 text-slate-700";
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${cls}`}>
          {event.status.toLowerCase().replace(/_/g, " ")}
        </span>
        <span className="text-[11px] text-slate-500">tentativa {event.attempt}</span>
        <span className="text-[11px] text-slate-400">·</span>
        <span className="text-[11px] text-slate-500">{fmtDateTime(event.at)}</span>
        {event.httpStatus != null && (
          <>
            <span className="text-[11px] text-slate-400">·</span>
            <span className="text-[11px] text-slate-500">HTTP {event.httpStatus}</span>
          </>
        )}
      </div>
      {event.message && (
        <div className="mt-1 text-[12px] text-slate-700">{event.message}</div>
      )}
      {event.spharmSqlError && (
        <div className="mt-1 rounded-md border border-rose-100 bg-rose-50 px-2 py-1 font-mono text-[11px] text-rose-700">
          {event.spharmSqlError}
        </div>
      )}
    </li>
  );
}
