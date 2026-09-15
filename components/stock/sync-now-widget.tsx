"use client";

/**
 * components/stock/sync-now-widget.tsx
 *
 * Botão "Sincronizar agora" em /stock (Bloco E).
 *
 * O clique não sincroniza nada de imediato — deposita um `SyncRequest`
 * (padrão outbox) que o agent on-prem da farmácia processa. Desde que
 * o agent passou a fazer LONG-POLLING real (várias corridas de
 * `GET .../pending?waitSeconds=N` mantidas em espera pelo servidor —
 * ver `agent/docs/sync-now.md` secção 2), a latência típica caiu de
 * minutos para segundos — mas continua a não ser uma garantia
 * instantânea a 100% (ver `MICROCOPY_HONESTA` abaixo, e
 * `estadoParaMensagem` para o texto por estado).
 *
 * Só é montado pelo servidor (`app/stock/page.tsx`) quando a sessão tem
 * a permissão `stock.sync` E pelo menos uma farmácia acessível — sem
 * nenhuma das duas, `farmacias` chega vazio e o componente não desenha
 * nada.
 */

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { RefreshCw } from "lucide-react";
import {
  getSyncStatusAction,
  requestSyncNowAction,
  type SyncActionResult,
} from "@/app/stock/sync-actions";
import type { SyncFarmaciaOption, SyncWidgetStatus } from "@/lib/sync-request-data";

/**
 * Texto honesto sobre a latência: "muito mais rápido" (segundos, via
 * long-polling), nunca "imediato garantido" — o agent só reclama o
 * pedido no ciclo de long-poll em que ele calhar a existir, e a
 * sincronização em si ainda pode demorar consoante o ERP.
 */
const MICROCOPY_HONESTA =
  "Normalmente leva poucos segundos — o agente da farmácia responde por long-polling, não é uma garantia instantânea.";

/** Mensagem de estado mostrada junto ao botão, por estado do pedido. */
function estadoParaMensagem(status: SyncWidgetStatus | null): string | null {
  if (!status) return null;
  switch (status.estado) {
    case "PENDENTE":
      return "A solicitar actualização…";
    case "EM_CURSO":
      return "Farmácia a sincronizar…";
    case "CONCLUIDO":
      return "Atualizado agora";
    case "FALHOU":
      return "Falhou — tenta novamente.";
    case "EXPIRADO":
      return "Expirou sem resposta do agente — tenta novamente.";
    default:
      return null;
  }
}

/**
 * Enquanto activo, o widget volta a perguntar o estado ao SaaS.
 *
 * Reduzido de 5s para 2s: com o agent a reclamar pedidos em segundos
 * (long-polling, não minutos), um polling de 5s do browser passava a
 * ser ELE PRÓPRIO o maior contribuinte para a latência percebida — o
 * utilizador via "Atualizado agora" até 5s depois de já ter acontecido.
 * 2s mantém o custo desprezável (chamadas leves, só nesta janela activa)
 * e deixa de ser o gargalo.
 */
const POLL_MS = 2_000;

function formatDateTime(iso: string | null): string {
  if (!iso) return "nunca";
  try {
    return new Date(iso).toLocaleString("pt-PT", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function EstadoBadge({ estado }: { estado: SyncWidgetStatus["estado"] }) {
  const styles: Record<SyncWidgetStatus["estado"], string> = {
    SEM_PEDIDO: "bg-slate-100 text-slate-500 border-slate-200",
    PENDENTE: "bg-amber-50 text-amber-700 border-amber-100",
    EM_CURSO: "bg-cyan-50 text-cyan-700 border-cyan-100",
    CONCLUIDO: "bg-emerald-50 text-emerald-700 border-emerald-100",
    FALHOU: "bg-red-50 text-red-700 border-red-100",
    EXPIRADO: "bg-slate-100 text-slate-600 border-slate-200",
  };
  const labels: Record<SyncWidgetStatus["estado"], string> = {
    SEM_PEDIDO: "Sem pedidos",
    PENDENTE: "Pendente",
    EM_CURSO: "Em curso",
    CONCLUIDO: "Concluído",
    FALHOU: "Falhou",
    EXPIRADO: "Expirou",
  };
  return (
    <span className={`inline-flex rounded-full border px-2 py-1 text-[10px] font-medium ${styles[estado]}`}>
      {labels[estado]}
    </span>
  );
}

type Props = {
  farmacias: SyncFarmaciaOption[];
};

export function SyncNowWidget({ farmacias }: Props) {
  const [farmaciaId, setFarmaciaId] = useState<string>(farmacias[0]?.id ?? "");
  const [status, setStatus] = useState<SyncWidgetStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const aplicarResultado = useCallback((result: SyncActionResult) => {
    if (result.ok) {
      setStatus(result.status);
      setError(null);
    } else {
      setError(result.error);
    }
  }, []);

  const carregarEstado = useCallback(
    (id: string) => {
      startTransition(() => {
        getSyncStatusAction({ farmaciaId: id }).then(aplicarResultado);
      });
    },
    [aplicarResultado],
  );

  // Carrega ao montar e sempre que a farmácia escolhida muda.
  useEffect(() => {
    if (!farmaciaId) return;
    carregarEstado(farmaciaId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [farmaciaId]);

  // Polling curto enquanto há um pedido activo — pára sozinho quando
  // o estado deixa de ser PENDENTE/EM_CURSO.
  useEffect(() => {
    const activo = status?.estado === "PENDENTE" || status?.estado === "EM_CURSO";
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (activo && farmaciaId) {
      pollRef.current = setInterval(() => carregarEstado(farmaciaId), POLL_MS);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [status?.estado, farmaciaId, carregarEstado]);

  if (farmacias.length === 0) return null;

  const activo = status?.estado === "PENDENTE" || status?.estado === "EM_CURSO";
  const mensagemEstado = estadoParaMensagem(status);

  const onSincronizar = () => {
    if (!farmaciaId || activo) return;
    startTransition(() => {
      requestSyncNowAction({ farmaciaId }).then(aplicarResultado);
    });
  };

  return (
    <div className="rounded-[14px] border border-white/70 bg-white/78 px-3 py-2.5 shadow-[0_8px_20px_rgba(15,23,42,0.035)]">
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-400">
          Sincronizar agora
        </div>
        {farmacias.length > 1 ? (
          <select
            value={farmaciaId}
            onChange={(e) => setFarmaciaId(e.target.value)}
            disabled={activo}
            className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-700 disabled:opacity-60"
          >
            {farmacias.map((f) => (
              <option key={f.id} value={f.id}>
                {f.nome}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-[11px] text-slate-600">{farmacias[0]?.nome}</span>
        )}
        {status ? <EstadoBadge estado={status.estado} /> : null}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onSincronizar}
          disabled={activo || isPending || !farmaciaId}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-xl border border-emerald-300 bg-emerald-50 px-3 text-[12px] font-medium text-emerald-700 transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-50 disabled:text-slate-400"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${activo ? "animate-spin" : ""}`} aria-hidden />
          {activo ? mensagemEstado ?? "A sincronizar…" : "Sincronizar agora"}
        </button>
        <span className="text-[10px] text-slate-500">
          Última sincronização: {formatDateTime(status?.ultimaSincronizacaoOk ?? null)}
        </span>
      </div>

      {status?.estado === "CONCLUIDO" && status.resultado ? (
        <div className="mt-1.5 text-[10px] text-emerald-700">
          {mensagemEstado} — Stock actualizado: {status.resultado.stockAtualizado} · Produtos
          actualizados: {status.resultado.produtosAtualizados} · Fabricantes alterados:{" "}
          {status.resultado.fabricantesAlterados}
        </div>
      ) : null}
      {(status?.estado === "FALHOU" || status?.estado === "EXPIRADO") ? (
        <div className="mt-1.5 text-[10px] text-red-600">
          {mensagemEstado}
          {status.erro ? ` ${status.erro}` : ""}
        </div>
      ) : null}
      {error ? <div className="mt-1.5 text-[10px] text-red-600">{error}</div> : null}

      <div className="mt-1.5 text-[9.5px] italic text-slate-400">{MICROCOPY_HONESTA}</div>
    </div>
  );
}
