/**
 * lib/encomendas/proposal-context.ts
 *
 * Contexto funcional de uma proposta em `/encomendas/nova` — modo,
 * farmácia(s), período, cobertura, filtros e critérios — serializado
 * para `ListaEncomenda.contextoJson` assim que existe um rascunho
 * persistido (ver `lib/encomendas/autosave.ts`). Puramente para
 * RECONSTRUIR o ecrã ao reabrir (reload, outro computador) — nunca lido
 * por nada fora de `order-create-client.tsx` e do carregador do
 * rascunho, nunca uma segunda fonte de verdade para os produtos em si
 * (isso continua a ser só `LinhaEncomenda`).
 *
 * Deliberadamente NÃO inclui a lista de CNP importada por ficheiro
 * inteira (pode ir até MAX_CODIGOS = 25 000 códigos — rebentaria
 * qualquer tecto razoável de contexto). Guarda só metadados
 * (nome do ficheiro, contagens) para mostrar um resumo ao reabrir; os
 * produtos que essa lista trouxe já estão, eles próprios, gravados como
 * `LinhaEncomenda` — a lista importada é uma FERRAMENTA de composição,
 * não um dado que precise de sobreviver por si.
 */

export type PropostaContexto = {
  version: 1;
  mode: "farmacia" | "grupo" | "consolidacao";
  farmaciaId: string | null;
  startDate: string;
  endDate: string;
  considerStock: boolean;
  baseRule: string;
  coverageDays: number;
  filters: {
    fabricantes: string[];
    fornecedores: string[];
    categorias: string[];
    subcategorias: string[];
    utilizacoes: string[];
    productTypes: string[];
  };
  /** Resumo da lista importada, se houver — ver nota acima. */
  listaImportadaResumo: { nomeFicheiro: string; encontrados: number; naoEncontrados: number } | null;
  nome: string;
};

const CONTEXTO_MAX_CHARS = 20_000;

/** `undefined` = nada a gravar (chamador não tem contexto para oferecer). */
export function serializarPropostaContexto(c: PropostaContexto): string | undefined {
  const json = JSON.stringify(c);
  if (json.length > CONTEXTO_MAX_CHARS) {
    // Nunca bloqueia o autosave por causa disto — perde-se o contexto
    // (a reconstrução ao reabrir fica mais pobre), mas as LINHAS, que são
    // o dado que importa, continuam a gravar normalmente.
    return undefined;
  }
  return json;
}

/** `null` = contexto ausente ou ilegível (rascunhos antigos, ou JSON corrompido) — nunca lança. */
export function parsearPropostaContexto(raw: string | null): PropostaContexto | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const p = parsed as Record<string, unknown>;
    if (p.version !== 1) return null;
    if (p.mode !== "farmacia" && p.mode !== "grupo" && p.mode !== "consolidacao") return null;
    if (typeof p.startDate !== "string" || typeof p.endDate !== "string") return null;
    if (typeof p.considerStock !== "boolean") return null;
    if (typeof p.baseRule !== "string") return null;
    if (typeof p.coverageDays !== "number") return null;
    const f = p.filters as Record<string, unknown> | undefined;
    const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    return {
      version: 1,
      mode: p.mode,
      farmaciaId: typeof p.farmaciaId === "string" ? p.farmaciaId : null,
      startDate: p.startDate,
      endDate: p.endDate,
      considerStock: p.considerStock,
      baseRule: p.baseRule,
      coverageDays: p.coverageDays,
      filters: {
        fabricantes: arr(f?.fabricantes),
        fornecedores: arr(f?.fornecedores),
        categorias: arr(f?.categorias),
        subcategorias: arr(f?.subcategorias),
        utilizacoes: arr(f?.utilizacoes),
        productTypes: arr(f?.productTypes),
      },
      listaImportadaResumo:
        p.listaImportadaResumo && typeof p.listaImportadaResumo === "object"
          ? (p.listaImportadaResumo as PropostaContexto["listaImportadaResumo"])
          : null,
      nome: typeof p.nome === "string" ? p.nome : "",
    };
  } catch {
    return null;
  }
}
