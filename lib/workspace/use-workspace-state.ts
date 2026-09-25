"use client";

/**
 * lib/workspace/use-workspace-state.ts
 *
 * Isolamento de sessões de análise ("workspaces") do MESMO módulo de
 * relatório — duas análises de Vendas com farmácia/período/filtros
 * diferentes têm de coexistir sem se pisarem, cada uma com a sua própria
 * tarefa na barra (ver `lib/workspace/task-bar-context.tsx`) e o seu
 * próprio estado de critérios (filtros, datas, agrupamento, vista,
 * ordenação, direcção, listas de CNP, paginação).
 *
 * ── Onde vive o estado ──────────────────────────────────────────────
 * `sessionStorage`, chaveado por `tenant:userId:workspaceId:moduleKey` —
 * NUNCA uma única chave por módulo (isso é exactamente o bug que isto
 * corrige: hoje `/vendas` é uma única rota, logo um único estado,
 * partilhado por qualquer análise de Vendas aberta). `sessionStorage` e
 * não `localStorage`: uma análise é uma sessão de trabalho, não algo que
 * deva sobreviver a fechar o separador — sobrevive a recarregar a
 * página (o que `sessionStorage` já garante) e a alternar entre tarefas
 * na MESMA aba, que é o requisito real.
 *
 * ── O que persiste aqui ──────────────────────────────────────────────
 * SÓ critérios (o INPUT de uma análise — farmácia(s), período, filtros,
 * agrupamento, ordenação, listas de CNP importadas, paginação). NUNCA os
 * RESULTADOS calculados (linhas da tabela, totais) — esses são sempre
 * recalculados a partir dos critérios restaurados, o mesmo princípio já
 * usado em `carregarRascunhoNovaEncomendaAction` (nunca congelar um
 * snapshot que fica desactualizado; recalcular a partir do que foi
 * pedido). Guardar resultados aqui também arriscaria estourar a quota
 * de `sessionStorage` com tabelas de milhares de linhas.
 *
 * ── Trocar de workspace ──────────────────────────────────────────────
 * Mudar `workspaceId` (voltar a uma tarefa diferente na barra) faz o
 * hook reidratar do zero a partir da chave NOVA — nunca continua a
 * escrever na antiga, nunca mistura as duas.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export function chaveWorkspaceState(tenant: string, userId: string, workspaceId: string, moduleKey: string): string {
  return `spharmmt:workspace:${tenant}:${userId}:${workspaceId}:${moduleKey}`;
}

/** Subconjunto de `Storage` usado aqui — permite testar sem DOM. */
export type StorageLike = Pick<Storage, "getItem" | "setItem">;

function storagePadrao(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function lerEstado<T>(chaveLS: string, storage: StorageLike | null = storagePadrao()): T | null {
  try {
    const raw = storage?.getItem(chaveLS);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function escreverEstado<T>(chaveLS: string, estado: T, storage: StorageLike | null = storagePadrao()): void {
  try {
    storage?.setItem(chaveLS, JSON.stringify(estado));
  } catch {
    // Quota excedida/bloqueado — a análise continua a funcionar, só não sobrevive a reidratar.
  }
}

export type UseWorkspaceStateOpts<T> = {
  /** `null` = sem workspace ainda resolvido (ex.: sessão a carregar) — o hook fica inerte, comporta-se como useState local sem persistência. */
  workspaceId: string | null;
  tenantSlug: string;
  userId: string;
  /** Identifica o MÓDULO (ex.: "vendas", "margens") — parte da chave, nunca partilhada entre módulos diferentes. */
  moduleKey: string;
  /** Estado por omissão quando não há nada guardado ainda para este workspace. */
  initial: T;
};

/**
 * Como `useState`, mas com o estado espelhado em `sessionStorage` sob a
 * chave deste workspace+módulo, e reidratado sempre que `workspaceId`
 * muda. `setState` aceita valor directo OU updater funcional, como
 * `useState`.
 */
export function useWorkspaceState<T>(
  opts: UseWorkspaceStateOpts<T>
): [T, (updater: T | ((prev: T) => T)) => void] {
  const { workspaceId, tenantSlug, userId, moduleKey, initial } = opts;
  const chaveLS = workspaceId ? chaveWorkspaceState(tenantSlug, userId, workspaceId, moduleKey) : null;

  const [estado, setEstadoInterno] = useState<T>(() => {
    if (!chaveLS) return initial;
    return lerEstado<T>(chaveLS) ?? initial;
  });

  // Rastreia a última chave já hidratada — evita reidratar no MESMO
  // workspace a cada render (só quando `workspaceId` muda de verdade).
  const ultimaChaveRef = useRef<string | null>(chaveLS);

  useEffect(() => {
    if (chaveLS === ultimaChaveRef.current) return;
    ultimaChaveRef.current = chaveLS;
    setEstadoInterno(chaveLS ? (lerEstado<T>(chaveLS) ?? initial) : initial);
    // `initial` é deliberadamente omitido das deps — normalmente é um
    // literal novo a cada render do chamador, e incluí-lo reidratava a
    // CADA render, não só quando o workspace muda de verdade.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chaveLS]);

  const setEstado = useCallback(
    (updater: T | ((prev: T) => T)) => {
      setEstadoInterno((prev) => {
        const proximo = typeof updater === "function" ? (updater as (prev: T) => T)(prev) : updater;
        if (chaveLS) escreverEstado(chaveLS, proximo);
        return proximo;
      });
    },
    [chaveLS]
  );

  return [estado, setEstado];
}
