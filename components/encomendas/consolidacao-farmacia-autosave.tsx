"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { autosaveEncomendaAction, type AutosaveLinhaInput } from "@/app/encomendas/[id]/actions";
import { useAutosaveEncomenda, type EstadoAutosave } from "@/lib/encomendas/use-autosave-encomenda";

/**
 * components/encomendas/consolidacao-farmacia-autosave.tsx
 *
 * (2026-09-30) O modo "consolidacao" precisa de N rascunhos reais em
 * simultâneo — um por farmácia presente no ecrã — cada um com o SEU
 * próprio autosave (debounce, bloqueio optimista, fallback local,
 * reconciliação de conflito). `useAutosaveEncomenda` é um HOOK: não pode
 * ser chamado N vezes dinamicamente dentro do componente principal (N
 * varia com o número de farmácias tocadas na sessão). A solução, pedida
 * explicitamente no desenho desta funcionalidade, é esta: UM componente
 * "de lógica" (sem UI própria — devolve `null`) que chama o hook UMA
 * única vez, montado uma vez por farmácia (`key={farmaciaId}` no `.map`
 * do componente pai) — nunca um segundo motor de autosave.
 *
 * Expõe a API do hook via `ref` (imperative handle) para o componente pai
 * poder chamar `marcarSujo`/`marcarRemovido`/`flushSincrono` a partir de
 * handlers de evento (onChange de um input), e reporta mudanças de estado
 * (para a badge de estado) e conflitos de versão via callbacks — nunca o
 * pai lendo directamente o hook de um componente que não é o seu.
 */

export type ConsolidacaoAutosaveHandle = {
  marcarSujo: (produtoId: string, patch: Omit<AutosaveLinhaInput, "produtoId">) => void;
  marcarRemovido: (produtoId: string) => void;
  marcarContexto: (contexto: string) => void;
  guardarAgora: () => Promise<void>;
  flushSincrono: () => Promise<boolean>;
  resolverConflitoActualizar: () => void;
  versaoAtual: number;
  /** Versão ACTUAL do rascunho desta farmácia (lida no momento — nunca congelada no último render). */
  obterVersaoActual: () => number;
  temAlteracoesPendentes: boolean;
};

export type ConsolidacaoFarmaciaAutosaveProps = {
  farmaciaId: string;
  listaEncomendaId: string;
  versaoInicial: number;
  tenantSlug: string;
  userId: string;
  onEstadoChange?: (farmaciaId: string, estado: EstadoAutosave) => void;
  onGravado?: (farmaciaId: string, produtoIds: string[], novaVersao: number) => void;
};

export const ConsolidacaoFarmaciaAutosave = forwardRef<ConsolidacaoAutosaveHandle, ConsolidacaoFarmaciaAutosaveProps>(
  function ConsolidacaoFarmaciaAutosave(props, ref) {
    const { farmaciaId, listaEncomendaId, versaoInicial, tenantSlug, userId, onEstadoChange, onGravado } = props;

    const autosave = useAutosaveEncomenda({
      listaEncomendaId,
      farmaciaId,
      versaoInicial,
      tenantSlug,
      userId,
      autosaveAction: autosaveEncomendaAction,
      onGravado: (produtoIds, novaVersao) => onGravado?.(farmaciaId, produtoIds, novaVersao),
    });

    // Navegar para outra página desmonta este componente: tenta gravar já o
    // que ainda estiver pendente (o debounce ficaria perdido). Usa o `guardarAgora`
    // mais recente via ref — o efeito corre só no desmonte.
    const guardarAgoraRef = useRef(autosave.guardarAgora);
    guardarAgoraRef.current = autosave.guardarAgora;
    useEffect(
      () => () => {
        void guardarAgoraRef.current();
      },
      []
    );

    useImperativeHandle(
      ref,
      () => ({
        marcarSujo: autosave.marcarSujo,
        marcarRemovido: autosave.marcarRemovido,
        marcarContexto: autosave.marcarContexto,
        guardarAgora: autosave.guardarAgora,
        flushSincrono: autosave.flushSincrono,
        resolverConflitoActualizar: autosave.resolverConflitoActualizar,
        versaoAtual: autosave.versaoAtual,
        obterVersaoActual: autosave.obterVersaoActual,
        temAlteracoesPendentes: autosave.temAlteracoesPendentes,
      }),
      [autosave]
    );

    // Reporta o estado (para a badge de autosave por farmácia) sempre que muda.
    useEffect(() => {
      onEstadoChange?.(farmaciaId, autosave.estado);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [farmaciaId, autosave.estado]);

    return null;
  }
);
