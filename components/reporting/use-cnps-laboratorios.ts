"use client";

/**
 * Estado do filtro "Laboratório ou grupo" das listas operacionais (`EstadoFiltroLaboratorio`, usado por
 * `passaFiltroLaboratorioLinha`).
 *
 *   · Fora de garantia (`modoGrupos=false`) não faz nenhum pedido — o filtro continua a comparar nomes, como sempre.
 *   · LOCAL (normal em garantia): se a página trouxe `local.pertencaGrupos` (um SELECT no carregamento da página) o
 *     estado calcula-se de forma síncrona com `useMemo` — nenhuma ida ao servidor por selecção, nenhum estado
 *     «a resolver», nenhuma corrida possível.
 *   · SERVIDOR (reserva, só sem `pertencaGrupos`): uma server action por alteração de selecção, sequenciada — a
 *     resposta de uma selecção antiga é descartada (`cancelado` + comparação da chave) e enquanto resolve `cnps=null`.
 */
import { useEffect, useMemo, useState } from "react";
import { resolverCnpsLaboratoriosAction } from "@/lib/reporting/laboratorio-actions";
import { construirEstadoFiltroLaboratorio, type EstadoFiltroLaboratorio } from "@/lib/reporting/filtro-laboratorio-linhas";
import type { CatalogoFilterOptionLaboratorio } from "@/lib/catalog/laboratorio-filtro";

export type FiltroLaboratorioLocal = {
  laboratorios: readonly CatalogoFilterOptionLaboratorio[] | undefined;
  pertencaGrupos: Readonly<Record<string, readonly string[]>> | undefined;
};

export function useFiltroLaboratorio(
  selecionados: readonly string[],
  modoGrupos: boolean,
  local?: FiltroLaboratorioLocal,
): EstadoFiltroLaboratorio {
  const chave = useMemo(() => [...selecionados].sort().join("\u0000"), [selecionados]);
  const laboratorios = local?.laboratorios;
  const pertencaGrupos = local?.pertencaGrupos;
  const resolveLocalmente = modoGrupos && !!laboratorios && !!pertencaGrupos;
  const [resolvido, setResolvido] = useState<{ chave: string; cnps: Set<string> } | null>(null);

  useEffect(() => {
    if (!modoGrupos || resolveLocalmente || chave === "") return;
    let cancelado = false;
    resolverCnpsLaboratoriosAction(chave.split("\u0000"))
      .then((cnps) => {
        if (!cancelado) setResolvido({ chave, cnps: new Set(cnps) });
      })
      .catch(() => {
        if (!cancelado) setResolvido({ chave, cnps: new Set() });
      });
    return () => {
      cancelado = true;
    };
  }, [chave, modoGrupos, resolveLocalmente]);

  return useMemo(() => {
    if (resolveLocalmente) return construirEstadoFiltroLaboratorio(selecionados, laboratorios!, pertencaGrupos!);
    return { modoGrupos, cnps: modoGrupos && resolvido && resolvido.chave === chave ? resolvido.cnps : null };
  }, [resolveLocalmente, selecionados, laboratorios, pertencaGrupos, modoGrupos, resolvido, chave]);
}
