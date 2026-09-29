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
 *                                                 revogada depois. Resolvido por
 *                                                 `resolverPorNomeNormalizado`, a MESMA função
 *                                                 usada pelo fabricante de origem/ERP (3/4) —
 *                                                 é uma ÚNICA cadeia de precedência geral,
 *                                                 nunca um caso especial por titular:
 *
 *      5a. nome normalizado bate EXACTAMENTE com um Fabricante existente → usa-o.
 *      5b. bate com um FabricanteAlias existente (1 candidato)           → usa-o.
 *          Mais de um candidato por alias                                → AMBÍGUO.
 *      5c. o plano curado de normalização mapeia este nome               → usa o canónico do
 *          plano (cria-o se ainda não existir nesta base) e regista o nome antigo como alias.
 *      5d. um Fabricante existente é PREFIXO do nome completo (nomes      → usa o prefixo MAIS
 *          historicamente truncados na origem/ERP ou num import antigo)    LONGO, só se for
 *                                                                           inequívoco (um único
 *                                                                           candidato no
 *                                                                           comprimento máximo);
 *          empate no comprimento máximo                                  → AMBÍGUO.
 *      5e. evidência de portefólio: outros produtos já associados a um   → usa o Fabricante com
 *          Fabricante têm o MESMO titularAim (nome normalizado igual)      mais produtos nessa
 *          — sinal indirecto, só usado quando nenhuma das regras acima     evidência, só se for
 *          decidiu;                                                       inequívoco (sem
 *                                                                           empate no topo);
 *          empate no topo                                                → AMBÍGUO.
 *      5f. nenhuma das regras 5a-5e decidiu E nunca houve um candidato    → cria um Fabricante
 *          concreto (nem ambíguo) em qualquer uma delas                    novo com o nome
 *                                                                           (canónico do titular.
 *      5g. qualquer uma das regras 5b/5d/5e detectou MAIS DE UM           → AMBÍGUO — nunca
 *          candidato plausível, e nenhuma regra seguinte resolveu           escolhido
 *          isso sozinha                                                     arbitrariamente,
 *                                                                            nunca cria um
 *                                                                            fabricante novo
 *                                                                            (que seria um
 *                                                                            TERCEIRO/adicional
 *                                                                            quando já há
 *                                                                            candidatos reais).
 *   6. Nada disto aplicável (titular vazio/inválido, sem origem)  → sem fonte, motivo
 *      explícito (nunca inventa).
 *
 * Nenhuma regra é exclusiva de nenhum titular/fabricante concreto — não
 * há excepção de código para nenhuma entidade nomeada (ex.: Pharmakern).
 * O caso Pharmakern real (CNP 5701651) é apenas um teste de regressão
 * desta cadeia geral (ver scripts/tests/test-resolver-fabricante-por-cnp.ts).
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

/** Evidência de portefólio (regra 5e) — quantos produtos JÁ associados a este Fabricante têm o MESMO titularAim normalizado. */
export type EvidenciaPortfolioFabricante = { fabricanteId: string; nomeNormalizado: string; contagem: number };

export type MapasResolverFabricante = {
  fabricantesPorNomeNormalizado: ReadonlyMap<string, FabricanteParaResolverFabricante>;
  /** aliasNormalizado → candidatos. Mais de um candidato = dado ambíguo (nunca escolhido aqui). */
  fabricantesPorAlias: ReadonlyMap<string, readonly FabricanteParaResolverFabricante[]>;
  /** Ver plano-normalizacao-fabricantes-garantia.ts — nomeOrigemNormalizado → nomeCanonicoNormalizado. Opcional. */
  mapeamentoCurado?: ReadonlyMap<string, string>;
  /**
   * TODOS os Fabricante activos conhecidos — só para a regra 5d (prefixo).
   * Ausente/vazio = regra 5d nunca dispara (nunca é obrigatória).
   */
  fabricantesTodos?: readonly FabricanteParaResolverFabricante[];
  /**
   * nomeNormalizado do titular → candidatos com evidência de portefólio —
   * só para a regra 5e. Ausente/vazio = regra 5e nunca dispara.
   */
  evidenciaPortfolioPorNomeNormalizado?: ReadonlyMap<string, readonly EvidenciaPortfolioFabricante[]>;
};

export type MotivoSemFonte =
  | "FORA_UNIVERSO_INFARMED"
  | "SEM_REGISTO_CATALOGO"
  | "FABRICANTE_NAO_INFORMADO_PELA_ORIGEM"
  | "TITULAR_INVALIDO"
  /**
   * A origem/ERP TEM um fabricante para este CNP, mas duas ou mais
   * `ProdutoFarmacia` (farmácias diferentes a stockar o MESMO CNP)
   * discordam entre si depois de normalizar — nunca se escolhe uma
   * arbitrariamente (podiam ser produtos fisicamente diferentes a
   * partilhar um código interno <2M). Ver
   * reconciliar-fabricantes-por-cnp-garantia.ts::agregarOrigemErp.
   */
  | "FABRICANTE_DIVERGENTE_ENTRE_FARMACIAS";

/**
 * O que a origem/ERP diz sobre o fabricante de um produto, já resolvido
 * para UM valor por `reconciliar-fabricantes-por-cnp-garantia.ts` a
 * partir de (potencialmente várias) `ProdutoFarmacia.fabricanteErpAtual`:
 *   - `null`                 → nenhuma farmácia informou um fabricante.
 *   - `{ divergente: true }` → mais de uma farmácia informou, e discordam
 *     entre si (depois de normalizar) — nunca se escolhe uma.
 *   - `{ valor }`            → todas as farmácias que informaram concordam
 *     (ou só uma o fez) — seguro para usar na cadeia de precedência geral.
 */
export type FabricanteOrigemErp = { valor: string } | { divergente: true } | null;

export type MotivoAmbiguidade = "alias_multiplo" | "prefixo_empatado" | "evidencia_portfolio_empatada";

export type CandidatoAmbiguo = { fabricanteId: string; nomeNormalizado: string };

export type ResultadoResolucaoFabricante =
  | { tipo: "protegido_manual" }
  /** `divergente`: o titular normalizado não bate com o fabricante já associado — só para o relatório, nunca escreve. */
  | { tipo: "ja_tem_fabricante"; divergente: boolean }
  | {
      tipo: "resolvido_existente";
      fabricanteId: string;
      via: "nome_normalizado" | "alias" | "plano_curado" | "prefixo_truncado" | "evidencia_portfolio";
      /** Nome a persistir como NOVO FabricanteAlias, se ainda não existir (idempotência). */
      criarAliasNormalizado: string | null;
      estadoAim: string | null;
    }
  | {
      tipo: "resolvido_criar_novo";
      nomeCanonicoNormalizado: string;
      /**
       * Nome a persistir como NOVO FabricanteAlias assim que o Fabricante
       * for criado — presente quando esta criação vem do plano curado
       * (o produto tem um nome "antigo" que o plano mapeia para um
       * canónico que ainda não existe nesta base): sem isto, o alias do
       * "antigo" seria perdido para sempre.
       */
      criarAliasNormalizado: string | null;
      estadoAim: string | null;
      /**
       * Regra 5e não bloqueia a criação quando o EMPATE de evidência de
       * portefólio é a ÚNICA coisa que a regra 5a-5d encontrou — um empate
       * é um sinal indirecto e INCONCLUSIVO (reflecte associações antigas
       * inconsistentes de OUTROS produtos, não a identidade do titular
       * ACTUAL), nunca uma razão para bloquear a criação do fabricante
       * legal explícito do titular. Transparência, nunca bloqueio: quando
       * isto acontece, os candidatos empatados vão aqui — o relatório
       * mostra-os, mas a criação prossegue. Guarda `contagem` (não só o
       * candidato) — o relatório mostra o tamanho real do empate (ex.:
       * "2 vs 2"), nunca só os nomes. `null` quando não houve nenhum
       * empate a ignorar.
       */
      avisoEvidenciaEmpatada: readonly EvidenciaPortfolioFabricante[] | null;
    }
  | { tipo: "ambiguo"; motivo: MotivoAmbiguidade; nomeNormalizado: string; candidatos: readonly CandidatoAmbiguo[] }
  | { tipo: "sem_fonte"; motivo: MotivoSemFonte };

/**
 * Abaixo disto, um candidato a prefixo (regra 5d) nem entra em jogo —
 * evita que um nome societário curto e genérico (ex.: só "LDA" sobrasse
 * de alguma normalização degenerada) "capture" nomes completamente
 * distintos só por coincidência de poucos caracteres iniciais.
 */
const LIMIAR_PREFIXO_MIN = 12;

function paraCandidatos(fs: readonly FabricanteParaResolverFabricante[]): CandidatoAmbiguo[] {
  return fs.map((f) => ({ fabricanteId: f.id, nomeNormalizado: f.nomeNormalizado }));
}

function resolverPorNomeNormalizado(
  nomeNorm: string,
  mapas: MapasResolverFabricante,
  estadoAim: string | null,
): ResultadoResolucaoFabricante {
  // 5a — nome normalizado exacto.
  const directo = mapas.fabricantesPorNomeNormalizado.get(nomeNorm);
  if (directo) {
    return { tipo: "resolvido_existente", fabricanteId: directo.id, via: "nome_normalizado", criarAliasNormalizado: null, estadoAim };
  }

  // Ambiguidade da PRIMEIRA regra (5b/5d/5e) que a detectar — regras
  // seguintes continuam a ser tentadas (podem resolver sozinhas); só se
  // NENHUMA resolver é que esta ambiguidade é devolvida (nunca se cria
  // um Fabricante novo quando já se sabe que existem candidatos reais).
  let ambiguidadePendente: Extract<ResultadoResolucaoFabricante, { tipo: "ambiguo" }> | null = null;

  // 5b — alias confirmado.
  const viaAlias = mapas.fabricantesPorAlias.get(nomeNorm);
  if (viaAlias && viaAlias.length === 1) {
    return { tipo: "resolvido_existente", fabricanteId: viaAlias[0].id, via: "alias", criarAliasNormalizado: null, estadoAim };
  }
  if (viaAlias && viaAlias.length > 1) {
    // Mais de um Fabricante reclama o MESMO alias — dado ambíguo, nunca
    // escolhido arbitrariamente (mesma filosofia de
    // resolver-grupo-laboratorial.ts::alias_inequivoco).
    ambiguidadePendente = { tipo: "ambiguo", motivo: "alias_multiplo", nomeNormalizado: nomeNorm, candidatos: paraCandidatos(viaAlias) };
  }

  // 5c — plano curado de normalização.
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
    // titular, que o plano já decidiu não ser o nome final) — e regista-se
    // o nome "antigo" (nomeNorm) como alias a criar a seguir, para nunca
    // se perder essa correspondência. Uma decisão do plano curado é, por
    // definição, uma fonte que já resolveu a ambiguidade — nunca cai no
    // "ambiguidadePendente" das regras seguintes.
    return { tipo: "resolvido_criar_novo", nomeCanonicoNormalizado: canonicoPlano, criarAliasNormalizado: nomeNorm, estadoAim, avisoEvidenciaEmpatada: null };
  }

  // 5d — nomes historicamente truncados: um Fabricante existente cujo
  // nome é um PREFIXO exacto (por caracteres, não por palavras — a
  // truncagem real observada corta a meio de uma palavra) do nome
  // completo. Escolhe-se o prefixo MAIS LONGO, só se for inequívoco.
  const candidatosPrefixo = (mapas.fabricantesTodos ?? []).filter(
    (f) =>
      f.nomeNormalizado.length >= LIMIAR_PREFIXO_MIN &&
      f.nomeNormalizado.length < nomeNorm.length &&
      nomeNorm.startsWith(f.nomeNormalizado),
  );
  if (candidatosPrefixo.length > 0) {
    const comprimentoMaximo = Math.max(...candidatosPrefixo.map((f) => f.nomeNormalizado.length));
    const maisLongos = candidatosPrefixo.filter((f) => f.nomeNormalizado.length === comprimentoMaximo);
    if (maisLongos.length === 1) {
      // Regista também o nome completo como alias — a próxima ocorrência
      // do MESMO titular resolve directamente por alias (5b), mais
      // barato e mais forte do que repetir a inferência por prefixo.
      return { tipo: "resolvido_existente", fabricanteId: maisLongos[0].id, via: "prefixo_truncado", criarAliasNormalizado: nomeNorm, estadoAim };
    }
    if (!ambiguidadePendente) {
      ambiguidadePendente = { tipo: "ambiguo", motivo: "prefixo_empatado", nomeNormalizado: nomeNorm, candidatos: paraCandidatos(maisLongos) };
    }
  }

  // 5e — evidência de portefólio: só um sinal de APOIO, nunca a única
  // fonte quando há um empate real no topo. Um empate aqui é DIFERENTE de
  // um empate em 5b/5d: alias_multiplo/prefixo_empatado são sinais
  // DIRECTOS — o próprio NOME do titular aponta para um pequeno conjunto
  // de candidatos concretos, e criar um Fabricante novo seria
  // inequivocamente errado (um terceiro, a mais). A evidência de
  // portefólio é um sinal INDIRECTO — reflecte como OUTROS produtos, com
  // o MESMO titular bruto, ficaram historicamente associados; um empate
  // aí prova uma inconsistência PASSADA nesses outros produtos, não diz
  // nada sobre a identidade legal do titular ACTUAL. Por isso um empate
  // de evidência NUNCA bloqueia sozinho a criação do fabricante legal
  // explícito (5f) — só é registado para transparência no relatório.
  let avisoEvidenciaEmpatada: readonly EvidenciaPortfolioFabricante[] | null = null;
  const evidencia = mapas.evidenciaPortfolioPorNomeNormalizado?.get(nomeNorm);
  if (evidencia && evidencia.length > 0) {
    const ordenada = [...evidencia].sort((a, b) => b.contagem - a.contagem);
    const topo = ordenada[0]!;
    const segundo = ordenada[1];
    if (!segundo || topo.contagem > segundo.contagem) {
      return { tipo: "resolvido_existente", fabricanteId: topo.fabricanteId, via: "evidencia_portfolio", criarAliasNormalizado: null, estadoAim };
    }
    avisoEvidenciaEmpatada = ordenada.filter((c) => c.contagem === topo.contagem);
  }

  if (ambiguidadePendente) return ambiguidadePendente;

  // 5f — nenhum candidato concreto e DIRECTO em nenhuma regra: cria-se de
  // novo, mesmo que 5e tenha visto um empate inconclusivo (acima).
  return { tipo: "resolvido_criar_novo", nomeCanonicoNormalizado: nomeNorm, criarAliasNormalizado: null, estadoAim, avisoEvidenciaEmpatada };
}

/**
 * Traduz o que a origem/ERP diz (já agregado entre farmácias — ver
 * `FabricanteOrigemErp`) para um resultado, ou `null` se não há nada de
 * útil a tentar por aqui — nunca escolhe entre farmácias que discordam.
 */
function resolverViaOrigemErp(
  origem: FabricanteOrigemErp,
  mapas: MapasResolverFabricante,
  estadoAim: string | null,
): ResultadoResolucaoFabricante | null {
  if (!origem) return null;
  if ("divergente" in origem) {
    return { tipo: "sem_fonte", motivo: "FABRICANTE_DIVERGENTE_ENTRE_FARMACIAS" };
  }
  const norm = normalizarTitularAimGarantia(origem.valor);
  if (!norm) return null;
  return resolverPorNomeNormalizado(norm, mapas, estadoAim);
}

export function resolverFabricantePorCnp(
  produto: ProdutoParaResolverFabricante,
  registo: RegistoRegulatorioParaResolver | null,
  fabricanteOrigemErp: FabricanteOrigemErp,
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
    const viaErp = resolverViaOrigemErp(fabricanteOrigemErp, mapas, registo?.estadoAim ?? null);
    if (viaErp) return viaErp;
    return { tipo: "sem_fonte", motivo: cnpCatalogavel ? "SEM_REGISTO_CATALOGO" : "FORA_UNIVERSO_INFARMED" };
  }

  // 5 — titularAim, independentemente de o estado ser actual ou histórico.
  const normTitular = normalizarTitularAimGarantia(registo.titularAim);
  if (normTitular) {
    return resolverPorNomeNormalizado(normTitular, mapas, registo.estadoAim);
  }

  // titularAim ausente/vazio/inválido — última tentativa: a origem/ERP.
  const viaErp = resolverViaOrigemErp(fabricanteOrigemErp, mapas, registo.estadoAim);
  if (viaErp) return viaErp;

  return {
    tipo: "sem_fonte",
    motivo: registo.titularAim ? "TITULAR_INVALIDO" : "FABRICANTE_NAO_INFORMADO_PELA_ORIGEM",
  };
}
