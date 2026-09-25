"use client";

/**
 * lib/encomendas/use-autosave-encomenda.ts
 *
 * Autosave de cliente para rascunhos de encomenda — debounce, gravação
 * em lote SÓ das linhas alteradas, serialização (nunca duas gravações
 * em voo ao mesmo tempo, nunca uma resposta antiga sobrescreve uma mais
 * recente), bloqueio optimista, fallback local de contingência isolado
 * por tenant+utilizador+rascunho, e aviso antes de fechar/navegar
 * enquanto houver alterações não confirmadas pelo servidor.
 *
 * ── Regra central ────────────────────────────────────────────────────
 * `sessionStorage`/`localStorage` NUNCA é a fonte principal — é só uma
 * cópia de contingência para o caso de a gravação no servidor falhar
 * (rede em baixo). Assim que o servidor confirma, a cópia local é
 * apagada. Se a página recarregar com uma cópia pendente ainda por
 * sincronizar, ela é retomada automaticamente (nunca perdida
 * silenciosamente, nunca escondida do utilizador).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { AutosaveLinhaInput, AutosaveResult } from "@/app/encomendas/[id]/actions";

const DEBOUNCE_MS_DEFAULT = 1200;

export type EstadoAutosave =
  | { tipo: "limpo" }
  | { tipo: "sujo" }
  | { tipo: "a_guardar" }
  | { tipo: "guardado"; hora: string }
  | { tipo: "sem_ligacao" }
  | { tipo: "erro"; mensagem: string }
  | { tipo: "conflito"; versaoAtual: number };

function chaveFallback(tenantSlug: string, userId: string, listaEncomendaId: string): string {
  return `spharmmt:autosave-encomenda:${tenantSlug}:${userId}:${listaEncomendaId}`;
}

function lerFallback(chave: string): Record<string, AutosaveLinhaInput> | null {
  try {
    const raw = window.localStorage.getItem(chave);
    if (!raw) return null;
    return JSON.parse(raw) as Record<string, AutosaveLinhaInput>;
  } catch {
    // Privado/bloqueado/indisponível — sem fallback, nunca rebenta o autosave real.
    return null;
  }
}

function escreverFallback(chave: string, pendentes: Record<string, AutosaveLinhaInput>): void {
  try {
    if (Object.keys(pendentes).length === 0) {
      window.localStorage.removeItem(chave);
    } else {
      window.localStorage.setItem(chave, JSON.stringify(pendentes));
    }
  } catch {
    // Quota excedida ou indisponível — a gravação real no servidor continua a ser a fonte de verdade.
  }
}

export function useAutosaveEncomenda(opts: {
  listaEncomendaId: string | null;
  farmaciaId: string;
  versaoInicial: number;
  tenantSlug: string;
  userId: string;
  debounceMs?: number;
  /** Chamada quando o autosave grava com sucesso — o ecrã pode limpar o campo "sujo" das linhas gravadas. */
  onGravado?: (produtoIds: string[], novaVersao: number) => void;
  autosaveAction: (input: {
    listaEncomendaId: string;
    farmaciaId: string;
    versaoEsperada: number;
    linhas: AutosaveLinhaInput[];
  }) => Promise<AutosaveResult>;
}) {
  const { listaEncomendaId, farmaciaId, tenantSlug, userId, onGravado, autosaveAction } = opts;
  const debounceMs = opts.debounceMs ?? DEBOUNCE_MS_DEFAULT;

  const [estado, setEstado] = useState<EstadoAutosave>({ tipo: "limpo" });
  const versaoRef = useRef(opts.versaoInicial);
  const pendentesRef = useRef<Map<string, AutosaveLinhaInput>>(new Map());
  const emVooRef = useRef(false);
  const reagendarRef = useRef(false);
  const bloqueadoRef = useRef(false); // true durante um conflito por resolver
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const montadoRef = useRef(true);

  const chave = listaEncomendaId ? chaveFallback(tenantSlug, userId, listaEncomendaId) : null;

  // Retoma alterações locais de uma sessão anterior interrompida (crash,
  // fecho do browser sem sincronizar) — nunca perdidas silenciosamente.
  useEffect(() => {
    if (!chave) return;
    const guardadas = lerFallback(chave);
    if (guardadas && Object.keys(guardadas).length > 0) {
      for (const [produtoId, patch] of Object.entries(guardadas)) {
        pendentesRef.current.set(produtoId, patch);
      }
      setEstado({ tipo: "sujo" });
      // Agenda o flush de retoma — não bloqueia a primeira renderização.
      timerRef.current = setTimeout(() => void flush(), 300);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chave]);

  useEffect(() => {
    montadoRef.current = true;
    return () => {
      montadoRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const persistirFallback = useCallback(() => {
    if (!chave) return;
    escreverFallback(chave, Object.fromEntries(pendentesRef.current));
  }, [chave]);

  const flush = useCallback(async (): Promise<void> => {
    if (!listaEncomendaId) return;
    if (bloqueadoRef.current) return; // conflito por resolver — autosave em pausa
    if (pendentesRef.current.size === 0) return;

    if (emVooRef.current) {
      // Já há uma gravação em curso — nunca duas ao mesmo tempo. Marca
      // para repetir assim que a actual terminar, com o que estiver
      // pendente NESSA altura (nunca uma resposta antiga sobrescreve
      // edições feitas entretanto).
      reagendarRef.current = true;
      return;
    }

    emVooRef.current = true;
    if (montadoRef.current) setEstado({ tipo: "a_guardar" });

    const lote = new Map(pendentesRef.current);
    const linhas = [...lote.entries()].map(([produtoId, patch]) => ({ ...patch, produtoId }));

    try {
      const resultado = await autosaveAction({
        listaEncomendaId,
        farmaciaId,
        versaoEsperada: versaoRef.current,
        linhas,
      });

      if (!resultado.ok) {
        if (resultado.conflito) {
          bloqueadoRef.current = true;
          if (montadoRef.current) {
            setEstado({ tipo: "conflito", versaoAtual: resultado.versaoAtual ?? versaoRef.current });
          }
          return;
        }
        if (montadoRef.current) setEstado({ tipo: "erro", mensagem: resultado.error });
        // Pendentes mantêm-se — nada é descartado por uma falha de gravação.
        return;
      }

      // Sucesso: remove do pendente SÓ as chaves que fizeram parte deste
      // lote e que não voltaram a mudar entretanto (comparação por
      // referência do patch — se `marcarSujo` correu de novo para o
      // mesmo produto durante o voo, o Map tem uma entrada NOVA, e essa
      // fica para o próximo flush).
      for (const [produtoId, patchEnviado] of lote) {
        if (pendentesRef.current.get(produtoId) === patchEnviado) {
          pendentesRef.current.delete(produtoId);
        }
      }
      versaoRef.current = resultado.versao;
      persistirFallback();
      onGravado?.(linhas.map((l) => l.produtoId), resultado.versao);
      if (montadoRef.current) {
        const hora = new Date().toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" });
        setEstado(pendentesRef.current.size > 0 ? { tipo: "sujo" } : { tipo: "guardado", hora });
      }
    } catch {
      // Falha de rede (fetch/Server Action rejeitou) — nunca perde o
      // pendente, fica marcado como sem ligação até à próxima tentativa.
      if (montadoRef.current) setEstado({ tipo: "sem_ligacao" });
    } finally {
      emVooRef.current = false;
      if (reagendarRef.current) {
        reagendarRef.current = false;
        void flush();
      }
    }
  }, [listaEncomendaId, farmaciaId, autosaveAction, onGravado, persistirFallback]);

  const agendar = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => void flush(), debounceMs);
  }, [flush, debounceMs]);

  const marcarSujo = useCallback(
    (produtoId: string, patch: Omit<AutosaveLinhaInput, "produtoId">) => {
      if (bloqueadoRef.current) return; // não acumula mais sujidade durante um conflito por resolver
      const anterior = pendentesRef.current.get(produtoId);
      pendentesRef.current.set(produtoId, { ...(anterior ?? {}), ...patch, produtoId } as AutosaveLinhaInput);
      persistirFallback();
      setEstado({ tipo: "sujo" });
      agendar();
    },
    [agendar, persistirFallback]
  );

  const guardarAgora = useCallback(async () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    await flush();
  }, [flush]);

  /** Chamar ANTES de fechar uma tarefa/mudar de módulo/logout — tenta concluir a gravação pendente. */
  const flushSincrono = useCallback(async (): Promise<boolean> => {
    if (pendentesRef.current.size === 0) return true;
    await flush();
    return pendentesRef.current.size === 0 && !bloqueadoRef.current;
  }, [flush]);

  const resolverConflitoActualizar = useCallback(() => {
    // Quem chama é responsável por recarregar os dados do servidor
    // (router.refresh()) — aqui só desbloqueia o autosave e descarta o
    // pendente local, que já não se aplica à versão nova.
    pendentesRef.current.clear();
    if (chave) escreverFallback(chave, {});
    bloqueadoRef.current = false;
    setEstado({ tipo: "limpo" });
  }, [chave]);

  const temAlteracoesPendentes =
    pendentesRef.current.size > 0 || estado.tipo === "a_guardar" || estado.tipo === "sem_ligacao";

  // Aviso ao fechar/recarregar o browser — SÓ enquanto houver alterações
  // que o servidor ainda não confirmou. Depois de confirmadas, nunca
  // bloqueia — navegar ou fechar é seguro porque o rascunho já está na
  // base de dados.
  useEffect(() => {
    function handler(e: BeforeUnloadEvent) {
      if (!temAlteracoesPendentes) return;
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [temAlteracoesPendentes]);

  return {
    estado,
    versaoAtual: versaoRef.current,
    temAlteracoesPendentes,
    marcarSujo,
    guardarAgora,
    flushSincrono,
    resolverConflitoActualizar,
  };
}
