/**
 * lib/catalog/resolver-fabricante-por-cnp.ts
 *
 * Motor de precedência PURO (sem Prisma, sem I/O) que decide o que fazer
 * a `Produto.fabricanteId` a partir de `RegulatoryRecord.titularAim` —
 * exclusivo do tenant garantia (ver
 * `reconciliar-fabricantes-por-cnp-garantia.ts`, que aplica a decisão
 * sobre a base real). Mesma separação pura/aplicação de
 * `resolver-grupo-laboratorial.ts` — testável com arrays, sem montar
 * nenhuma ligação à BD.
 *
 * ── Precedência (da mais segura à mais arriscada) ─────────────────────
 *   1. `fabricanteId` já preenchido            → NUNCA tocar (só reporta divergência).
 *   2. `camposManuais` inclui "fabricanteId"   → protegido — ausência é uma decisão humana.
 *   3. CNP fora do universo INFARMED (<=2M)    → só tenta o fabricante da origem/ERP.
 *   4. Sem `RegulatoryRecord`                  → idem.
 *   5. `titularAim` presente                   → usa-o como entidade legal, INDEPENDENTEMENTE
 *                                                 de o estado (`estadoAim`) ser actual ou
 *                                                 histórico — o fabricante de um medicamento
 *                                                 não muda retroactivamente por a AIM ter sido
 *                                                 revogada depois.
 *      5a. nome normalizado bate com um Fabricante existente   → usa-o.
 *      5b. bate com um FabricanteAlias existente (1 candidato) → usa-o.
 *      5c. mais de um candidato por alias                      → AMBÍGUO, nunca escolhe.
 *      5d. o plano curado de normalização mapeia este nome     → usa o canónico do plano
 *          para um Fabricante que já existe (cria alias); ou cria um Fabricante novo com
 *          o NOME CANÓNICO do plano, se esse canónico ainda não existir na base.
 *      5e. nenhuma correspondência                              → cria um Fabricante novo
 *          com o nome do titular.
 *   6. Nada disto aplicável (titular vazio/inválido, sem origem)  → sem fonte, motivo
 *      explícito (nunca inventa).
 */
import { normalizarTitularAimGarantia } from "./fabricante-normalizacao-garantia";

export type ProdutoParaResolverFabricante = {
  id: string;
  cnp: number;
  fabricanteIdExistente: string | null;
  /** Nome normalizado do fabricante JÁ associado — só para detectar divergência (nunca para decidir). */
  fabricanteExistenteNomeNormalizado: string | null;
  camposManuais: readonly string[];
};

export type RegistoRegulatorioParaResolver = { titularAim: string | null; estadoAim: string | null };

export type FabricanteParaResolverFabricante = { id: string; nomeNormalizado: string };

export type MapasResolverFabricante = {
  fabricantesPorNomeNormalizado: ReadonlyMap<string, FabricanteParaResolverFabricante>;
  /** aliasNormalizado → candidatos. Mais de um candidato = dado ambíguo (nunca escolhido aqui). */
  fabricantesPorAlias: ReadonlyMap<string, readonly FabricanteParaResolverFabricante[]>;
  /** Ver plano-normalizacao-fabricantes-garantia.ts — nomeOrigemNormalizado → nomeCanonicoNormalizado. Opcional. */
  mapeamentoCurado?: ReadonlyMap<string, string>;
};

export type MotivoSemFonte =
  | "FORA_UNIVERSO_INFARMED"
  | "SEM_REGISTO_CATALOGO"
  | "FABRICANTE_NAO_INFORMADO_PELA_ORIGEM"
  | "TITULAR_INVALIDO";

export type ResultadoResolucaoFabricante =
  | { tipo: "protegido_manual" }
  /** `divergente`: o titular normalizado não bate com o fabricante já associado — só para o relatório, nunca escreve. */
  | { tipo: "ja_tem_fabricante"; divergente: boolean }
  | {
      tipo: "resolvido_existente";
      fabricanteId: string;
      via: "nome_normalizado" | "alias" | "plano_curado";
      /** Nome a persistir como NOVO FabricanteAlias, se ainda não existir (idempotência — ver rule 4). */
      criarAliasNormalizado: string | null;
      estadoAim: string | null;
    }
  | { tipo: "resolvido_criar_novo"; nomeCanonicoNormalizado: string; estadoAim: string | null }
  | { tipo: "ambiguo" }
  | { tipo: "sem_fonte"; motivo: MotivoSemFonte };

function resolverPorNomeNormalizado(
  nomeNorm: string,
  mapas: MapasResolverFabricante,
  estadoAim: string | null,
): ResultadoResolucaoFabricante {
  const directo = mapas.fabricantesPorNomeNormalizado.get(nomeNorm);
  if (directo) {
    return { tipo: "resolvido_existente", fabricanteId: directo.id, via: "nome_normalizado", criarAliasNormalizado: null, estadoAim };
  }

  const viaAlias = mapas.fabricantesPorAlias.get(nomeNorm);
  if (viaAlias && viaAlias.length === 1) {
    return { tipo: "resolvido_existente", fabricanteId: viaAlias[0].id, via: "alias", criarAliasNormalizado: null, estadoAim };
  }
  if (viaAlias && viaAlias.length > 1) {
    // Mais de um Fabricante reclama o MESMO alias — dado ambíguo, nunca
    // escolhido arbitrariamente (mesma filosofia de
    // resolver-grupo-laboratorial.ts::alias_inequivoco).
    return { tipo: "ambiguo" };
  }

  const canonicoPlano = mapas.mapeamentoCurado?.get(nomeNorm);
  if (canonicoPlano) {
    const fabricanteCanonico = mapas.fabricantesPorNomeNormalizado.get(canonicoPlano);
    if (fabricanteCanonico) {
      return {
        tipo: "resolvido_existente",
        fabricanteId: fabricanteCanonico.id,
        via: "plano_curado",
        criarAliasNormalizado: nomeNorm,
        estadoAim,
      };
    }
    // O plano aponta para um canónico que ainda não existe nesta base —
    // cria-se pelo NOME CANÓNICO do plano (nunca pelo nome bruto do
    // titular, que o plano já decidiu não ser o nome final).
    return { tipo: "resolvido_criar_novo", nomeCanonicoNormalizado: canonicoPlano, estadoAim };
  }

  return { tipo: "resolvido_criar_novo", nomeCanonicoNormalizado: nomeNorm, estadoAim };
}

export function resolverFabricantePorCnp(
  produto: ProdutoParaResolverFabricante,
  registo: RegistoRegulatorioParaResolver | null,
  fabricanteOrigemErp: string | null,
  cnpCatalogavel: boolean,
  mapas: MapasResolverFabricante,
): ResultadoResolucaoFabricante {
  // 1 — nunca alterar um fabricante já preenchido; só reportar divergência.
  if (produto.fabricanteIdExistente) {
    if (!registo?.titularAim) return { tipo: "ja_tem_fabricante", divergente: false };
    const normTitular = normalizarTitularAimGarantia(registo.titularAim);
    if (!normTitular) return { tipo: "ja_tem_fabricante", divergente: false };
    const bateComExistente = normTitular === produto.fabricanteExistenteNomeNormalizado;
    const bateComAliasDoExistente = (mapas.fabricantesPorAlias.get(normTitular) ?? []).some(
      (f) => f.id === produto.fabricanteIdExistente,
    );
    return { tipo: "ja_tem_fabricante", divergente: !bateComExistente && !bateComAliasDoExistente };
  }

  // 2 — ausência de fabricante como decisão humana explícita.
  if (produto.camposManuais.includes("fabricanteId")) {
    return { tipo: "protegido_manual" };
  }

  // 3/4 — sem universo INFARMED ou sem registo: só a origem/ERP, nunca inventa.
  if (!cnpCatalogavel || !registo) {
    const normErp = normalizarTitularAimGarantia(fabricanteOrigemErp);
    if (normErp) return resolverPorNomeNormalizado(normErp, mapas, registo?.estadoAim ?? null);
    return { tipo: "sem_fonte", motivo: cnpCatalogavel ? "SEM_REGISTO_CATALOGO" : "FORA_UNIVERSO_INFARMED" };
  }

  // 5 — titularAim, independentemente de o estado ser actual ou histórico.
  const normTitular = normalizarTitularAimGarantia(registo.titularAim);
  if (normTitular) {
    return resolverPorNomeNormalizado(normTitular, mapas, registo.estadoAim);
  }

  // titularAim ausente/vazio/inválido — última tentativa: a origem/ERP.
  const normErp = normalizarTitularAimGarantia(fabricanteOrigemErp);
  if (normErp) return resolverPorNomeNormalizado(normErp, mapas, registo.estadoAim);

  return {
    tipo: "sem_fonte",
    motivo: registo.titularAim ? "TITULAR_INVALIDO" : "FABRICANTE_NAO_INFORMADO_PELA_ORIGEM",
  };
}
