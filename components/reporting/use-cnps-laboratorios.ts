"use client";

/**
 * Resolve, no servidor, a selecção do filtro "Laboratório ou grupo" para o conjunto de CNP e devolve o
 * `EstadoFiltroLaboratorio` usado por `passaFiltroLaboratorioLinha`. Fora de garantia (`modoGrupos=false`) não faz
 * nenhum pedido — o filtro continua a comparar nomes, como sempre.
 */
import { useEffect, useMemo, useState } from "react";
import { resolverCnpsLaboratoriosAction } from "@/lib/reporting/laboratorio-actions";
import type { EstadoFiltroLaboratorio } from "@/lib/reporting/filtro-laboratorio-linhas";

export function useFiltroLaboratorio(selecionados: readonly string[], modoGrupos: boolean): EstadoFiltroLaboratorio {
  const chave = useMemo(() => [...selecionados].sort().join("\u0000"), [selecionados]);
  const [resolvido, setResolvido] = useState<{ chave: string; cnps: Set<string> } | null>(null);

  useEffect(() => {
    if (!modoGrupos || chave === "") return;
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
  }, [chave, modoGrupos]);

  return useMemo(
    () => ({ modoGrupos, cnps: modoGrupos && resolvido && resolvido.chave === chave ? resolvido.cnps : null }),
    [modoGrupos, resolvido, chave],
  );
}
