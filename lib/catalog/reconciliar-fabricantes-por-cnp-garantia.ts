/**
 * lib/catalog/reconciliar-fabricantes-por-cnp-garantia.ts
 *
 * Reconciliação automática e idempotente de `Produto.fabricanteId` a
 * partir de `RegulatoryRecord.titularAim` — exclusiva do tenant
 * garantia. Reutiliza o motor de precedência puro
 * `resolverFabricantePorCnp` (resolver-fabricante-por-cnp.ts, NUNCA
 * alterado por este ficheiro) e aplica a decisão sobre a base real, com
 * DOIS modos de escrita, partilhando a MESMA classificação:
 *
 *   · `reconciliarFabricantesPorCnpGarantia` — escrita IMEDIATA, produto
 *     a produto, sem `$transaction` (mesma disciplina de
 *     `reconciliar-grupos-laboratoriais-garantia.ts`: uma falha isolada
 *     fica em `erros`, nunca aborta o resto do lote). Usada pelos DOIS
 *     pontos de integração ONLINE, que correm em ciclos curtos e
 *     frequentes e nunca podem perder o resto de um lote por um único
 *     produto problemático:
 *       - `{ tipo: "produtos" }` — classificação imediata de uma lista
 *         concreta de produtoId, chamada pelo ingest logo depois de
 *         `Produto` ter sido escrito nesse lote (ver
 *         app/api/ingest/v1/bootstrap/products/route.ts);
 *       - `{ tipo: "lote" }` — reconciliação diária por shard rotativo
 *         de CNP (ver lib/jobs/enrich-catalog.ts), rede de segurança.
 *
 *   · `reconciliarFabricantesPorCnpGarantiaTransacional` — plano
 *     COMPLETO primeiro (zero escritas), depois aplicado numa ÚNICA
 *     `prisma.$transaction`: Fabricante + FabricanteAlias +
 *     `Produto.fabricanteId` de TODO o lote são atómicos — qualquer
 *     falha a meio (excepto dry-run, que nunca abre transacção) reverte
 *     TUDO, zero alterações. Usada exclusivamente pela CLI de backfill
 *     (scripts/reconciliar-fabricantes-por-cnp-garantia.ts, regra 8:
 *     "transação"), que corre uma vez sobre o universo inteiro e onde
 *     "meio lote aplicado" seria pior do que "nada aplicado, corre-se
 *     outra vez" (a idempotência do resolver torna isso seguro).
 *
 * ── Trava de tenant, em duas camadas ─────────────────────────────────
 * `tenantSlug` é obrigatório e verificado ANTES de qualquer `await`; os
 * dois chamadores (route.ts, enrich-catalog.ts) guardam também o seu
 * próprio lado com `=== "garantia"` — mesma filosofia documentada em
 * `reconciliar-grupos-laboratoriais-garantia.ts`. `RegulatoryRecord`
 * existe fisicamente em todas as bases (é populado só em garantia), mas
 * a trava aqui é sobre COMPORTAMENTO (nunca escrever/consultar por
 * engano fora de garantia), não sobre a existência da tabela.
 *
 * ── O que este serviço NUNCA faz ─────────────────────────────────────
 *   · nunca altera `Produto.fabricanteId` quando já está preenchido —
 *     o resolver puro já devolve `ja_tem_fabricante` antes de qualquer
 *     escrita ser considerada, em AMBOS os modos;
 *   · nunca substitui uma decisão manual — `camposManuais.includes(
 *     "fabricanteId")` é o nível 1 do resolver, avaliado antes de tudo;
 *   · nunca escolhe arbitrariamente entre vários candidatos — o
 *     resolver devolve `ambiguo`, contado à parte, nunca aplicado;
 *   · nunca funde/desactiva `Fabricante` existentes — só cria linhas
 *     novas (`Fabricante.create`) e aliases novos (`FabricanteAlias.
 *     create`), nunca `update`/`delete` em `Fabricante`;
 *   · o modo IMEDIATO nunca faz `$transaction` — cada produto é uma
 *     unidade atómica independente; o modo TRANSACIONAL nunca aplica
 *     nada FORA de uma única `$transaction` — não há um modo
 *     intermédio "algumas escritas soltas, outras em lote".
 */
import type { PrismaClient } from "../../generated/prisma/client";
import {
  resolverFabricantePorCnp,
  type MapasResolverFabricante,
  type FabricanteParaResolverFabricante,
  type EvidenciaPortfolioFabricante,
  type MotivoSemFonte,
  type MotivoAmbiguidade,
  type CandidatoAmbiguo,
  type ResultadoResolucaoFabricante,
} from "./resolver-fabricante-por-cnp";
import { ehCnpCatalogavel } from "./cnp-catalogavel";
import { normalizarTitularAimGarantia } from "./fabricante-normalizacao-garantia";
import type { MapeamentoCuradoFabricantes } from "./plano-normalizacao-fabricantes-garantia";

export const TENANT_TRAVADO = "garantia";

export type EscopoReconciliacaoFabricantes =
  | { tipo: "produtos"; produtoIds: readonly string[] }
  | { tipo: "lote"; buckets?: number; limiteSeguranca?: number }
  /**
   * TODOS os produtos sem fabricante, sem shard nem `LIMITE_SEGURANCA` —
   * exclusivo da CLI de backfill (regra 8: "resolver numa única
   * implementação TODOS os produtos sem fabricante"), nunca usado pelos
   * dois pontos de integração online (que precisam do tecto de
   * segurança de `{ tipo: "lote" }` por correrem em cada ciclo de
   * ingest/enrich, não uma vez só sobre a base inteira).
   */
  | { tipo: "todos" };

export type ReconciliacaoFabricantesSummary = {
  analisados: number;
  jaTinhaFabricante: number;
  divergencias: number;
  protegidosManualmente: number;
  resolvidosPorNomeNormalizado: number;
  resolvidosPorAlias: number;
  resolvidosPorPlanoCurado: number;
  /** Regra 4 (geral) — resolvido por um Fabricante existente ser PREFIXO do nome completo (nomes historicamente truncados). */
  resolvidosPorPrefixo: number;
  /** Regra 5 (geral) — resolvido por evidência de portefólio (outros produtos já associados com o MESMO titularAim). */
  resolvidosPorEvidenciaPortfolio: number;
  fabricantesCriados: number;
  aliasesCriados: number;
  ambiguidades: number;
  /**
   * Regra 7 (geral) — detalhe de CADA ambiguidade final, agrupado por
   * titularAim normalizado e pelos candidatos concretos que a causaram
   * (nunca escolhidos arbitrariamente). Um titularAim pode aparecer mais
   * de uma vez se produtos diferentes o partilham — agregação por
   * titularAim é responsabilidade do relatório (CLI), não deste serviço.
   */
  ambiguidadesDetalhe: Array<{ cnp: number; motivo: MotivoAmbiguidade; nomeNormalizado: string; candidatos: readonly CandidatoAmbiguo[] }>;
  semFonte: Record<MotivoSemFonte, number>;
  /** Contagem por `estadoAim` bruto, só dos produtos efectivamente resolvidos (existente ou criado) — Autorizado/Ativo/Anulado/Revogado/... */
  estadosAim: Record<string, number>;
  /**
   * Regra 10 — produtos que, DEPOIS desta corrida, continuam sem
   * fabricante (`ambiguo` ou `sem_fonte`) mas têm `RegulatoryRecord.
   * estadoAim` "Autorizado" ou "Ativo" — ou seja, um medicamento
   * ACTUALMENTE em vigor no INFARMED sem entidade legal associada. O
   * job diário (`lib/jobs/enrich-catalog.ts`) regista um aviso explícito
   * nos logs quando este valor é > 0; um estado histórico (Anulado/
   * Revogado) nunca conta aqui, mesmo sem fabricante.
   */
  aindaSemFabricanteAtual: number;
  /**
   * Detalhe PRODUTO A PRODUTO de `aindaSemFabricanteAtual` — nunca
   * inventa um motivo: `origem: "ambiguo"` repete o `nomeNormalizado`/
   * `motivo` já reportado em `ambiguidadesDetalhe` para este CNP;
   * `origem: "sem_fonte"` repete o motivo de `semFonte` (sem nome
   * interpretável — o resolver não devolve um para este caminho).
   * Único sítio com o CNP INDIVIDUAL de cada um destes casos — a CLI usa
   * isto para o "motivo individual" pedido por produto (nunca só o
   * agregado).
   */
  aindaSemFabricanteDetalhe: Array<
    | { cnp: number; origem: "ambiguo"; motivo: MotivoAmbiguidade; nomeNormalizado: string }
    | { cnp: number; origem: "sem_fonte"; motivo: MotivoSemFonte; nomeNormalizado: null }
  >;
  /** Nome normalizado de cada Fabricante NOVO criado por este lote — uma entrada por criação real (nunca duplica: uma segunda resolução para o MESMO nome reutiliza, ver `aplicarResolucao`). */
  fabricantesCriadosDetalhe: string[];
  /** Cada FabricanteAlias novo, com o nome do Fabricante canónico a que fica associado — para o relatório poder agrupar por fabricante (nunca só a contagem total). */
  aliasesCriadosDetalhe: Array<{ aliasNormalizado: string; fabricanteNomeNormalizado: string }>;
  erros: number;
  durationMs: number;
};

/** Exportado para os relatórios (CLI) poderem separar "resolvidos actuais" de "resolvidos históricos" sem duplicar a lista. */
export const ESTADOS_AIM_ATUAIS = new Set(["Autorizado", "Ativo"]);

// ── Tipo do Prisma aceite — prova em tempo de compilação que este ──────
// serviço não pode `update`/`delete` `Fabricante`, não pode escrever
// `Produto.fabricanteId` quando já preenchido (a única escrita
// permitida é o `update` COM `where: { fabricanteId: null }`, que o
// Prisma recusa em runtime se a condição não bater — ver `aplicar-
// Resolucao`), e não pode `updateMany`/`deleteMany` em lado nenhum.
export type PrismaParaReconciliacaoFabricantes = {
  produto: Pick<PrismaClient["produto"], "findMany" | "update">;
  produtoFarmacia: Pick<PrismaClient["produtoFarmacia"], "findMany">;
  fabricante: Pick<PrismaClient["fabricante"], "findMany" | "create">;
  fabricanteAlias: Pick<PrismaClient["fabricanteAlias"], "findMany" | "create">;
  regulatoryRecord: Pick<PrismaClient["regulatoryRecord"], "findMany">;
};

/**
 * Igual ao anterior, mais `$transaction` — só o modo transacional exige
 * este tipo (o tipo mais largo, não o mais restrito: prova em tempo de
 * compilação que só QUEM PODE abrir transacções chama o modo de
 * backfill).
 */
export type PrismaParaReconciliacaoFabricantesTransacional = PrismaParaReconciliacaoFabricantes & {
  $transaction: PrismaClient["$transaction"];
};

const BUCKETS_DEFAULT = 20;
const LIMITE_SEGURANCA_DEFAULT = 5000;
/** Tempo para conseguir um "slot" de transacção interactive do Prisma — não é o tempo da transacção em si. */
const TX_MAX_WAIT_MS_DEFAULT = 10_000;
/** Piso e tecto do timeout da transacção — ver `calcularTimeoutTransacaoMs`. */
const TX_TIMEOUT_MS_MIN = 30_000;
const TX_TIMEOUT_MS_MAX = 600_000;

/**
 * Timeout apropriado ao TAMANHO do lote de escritas planeadas — o
 * default do Prisma (5000ms) chega para uma dúzia de produtos mas nunca
 * para um backfill de milhares. ~50ms por escrita planeada (a maioria é
 * um único `produto.update`; criar Fabricante/alias custa uma escrita
 * extra ocasional, absorvida pela margem), com piso de 30s e tecto de
 * 10min — nunca deixa uma transacção pendurada indefinidamente.
 */
export function calcularTimeoutTransacaoMs(nPendentes: number): number {
  return Math.min(TX_TIMEOUT_MS_MAX, Math.max(TX_TIMEOUT_MS_MIN, nPendentes * 50));
}

type ProdutoLeve = { id: string; cnp: number; fabricanteId: string | null; camposManuais: string[] };

type PendenteEscrita = {
  produtoId: string;
  resultado: Extract<ResultadoResolucaoFabricante, { tipo: "resolvido_existente" | "resolvido_criar_novo" }>;
};

function novoSummary(): ReconciliacaoFabricantesSummary {
  return {
    analisados: 0, jaTinhaFabricante: 0, divergencias: 0, protegidosManualmente: 0,
    resolvidosPorNomeNormalizado: 0, resolvidosPorAlias: 0, resolvidosPorPlanoCurado: 0,
    resolvidosPorPrefixo: 0, resolvidosPorEvidenciaPortfolio: 0,
    fabricantesCriados: 0, aliasesCriados: 0, ambiguidades: 0, ambiguidadesDetalhe: [],
    semFonte: { FORA_UNIVERSO_INFARMED: 0, SEM_REGISTO_CATALOGO: 0, FABRICANTE_NAO_INFORMADO_PELA_ORIGEM: 0, TITULAR_INVALIDO: 0 },
    estadosAim: {},
    aindaSemFabricanteAtual: 0,
    aindaSemFabricanteDetalhe: [],
    fabricantesCriadosDetalhe: [],
    aliasesCriadosDetalhe: [],
    erros: 0, durationMs: 0,
  };
}

async function seleccionarProdutos(
  prisma: PrismaParaReconciliacaoFabricantes,
  opts: EscopoReconciliacaoFabricantes,
): Promise<ProdutoLeve[]> {
  if (opts.tipo === "produtos") {
    if (opts.produtoIds.length === 0) return [];
    return prisma.produto.findMany({
      where: { id: { in: [...opts.produtoIds] } },
      select: { id: true, cnp: true, fabricanteId: true, camposManuais: true },
    });
  }

  // Leitura leve de TODOS os produtos SEM fabricante — mesmo padrão de
  // `reconciliar-grupos-laboratoriais-garantia.ts::seleccionarProdutos`,
  // mas já filtrando `fabricanteId: null` no próprio `where` (aqui não
  // há necessidade de reler os que já têm fabricante para decidir nada
  // — regra 1 do resolver já os descartaria sempre da mesma forma).
  const todos = await prisma.produto.findMany({
    where: { fabricanteId: null },
    select: { id: true, cnp: true, fabricanteId: true, camposManuais: true },
  });

  if (opts.tipo === "todos") return todos;

  const buckets = opts.buckets ?? BUCKETS_DEFAULT;
  const diaEpoch = Math.floor(Date.now() / 86_400_000);
  const shardDoDia = diaEpoch % buckets;
  const doShard = todos.filter((p) => ((p.cnp % buckets) + buckets) % buckets === shardDoDia);
  const limiteSeguranca = opts.limiteSeguranca ?? LIMITE_SEGURANCA_DEFAULT;
  return doShard.slice(0, limiteSeguranca);
}

async function carregarMapas(
  prisma: PrismaParaReconciliacaoFabricantes,
  mapeamentoCurado: MapeamentoCuradoFabricantes | undefined,
): Promise<{
  mapas: MapasResolverFabricante;
  fabricantesPorId: Map<string, FabricanteParaResolverFabricante>;
  fabricantesTodos: FabricanteParaResolverFabricante[];
}> {
  const [fabricantesRaw, aliasesRaw] = await Promise.all([
    prisma.fabricante.findMany({ select: { id: true, nomeNormalizado: true } }),
    prisma.fabricanteAlias.findMany({ select: { fabricanteId: true, aliasNome: true } }),
  ]);
  const fabricantesPorId = new Map<string, FabricanteParaResolverFabricante>(fabricantesRaw.map((f) => [f.id, f]));
  const fabricantesPorNomeNormalizado = new Map<string, FabricanteParaResolverFabricante>(
    fabricantesRaw.map((f) => [f.nomeNormalizado, f]),
  );
  const fabricantesPorAlias = new Map<string, FabricanteParaResolverFabricante[]>();
  for (const a of aliasesRaw) {
    const fabricante = fabricantesPorId.get(a.fabricanteId);
    if (!fabricante) continue;
    const lista = fabricantesPorAlias.get(a.aliasNome) ?? [];
    lista.push(fabricante);
    fabricantesPorAlias.set(a.aliasNome, lista);
  }

  return { mapas: { fabricantesPorNomeNormalizado, fabricantesPorAlias, mapeamentoCurado }, fabricantesPorId, fabricantesTodos: fabricantesRaw };
}

/**
 * Evidência de portefólio (regra 5e do resolver) — para cada titularAim
 * (bruto) RELEVANTE a este lote (os das próprias `registosRaw` deste
 * classificar()), procura produtos JÁ associados a um Fabricante cujo
 * `RegulatoryRecord.titularAim` seja O MESMO (normalizado). Âmbito
 * deliberadamente restrito aos titulares deste lote — nunca varre as
 * ~294 071 linhas de `RegulatoryRecord` de uma vez, só as que interessam
 * às decisões desta corrida.
 *
 * Assume que a MESMA entidade legal, dentro de um único import
 * regulatório, é escrita com o texto bruto IDÊNTICO em `titularAim` —
 * por isso a primeira query filtra por igualdade EXACTA do texto bruto
 * (rápida, indexável), e só a normalização (para agregar variações
 * triviais de espaço) acontece em memória a seguir.
 */
async function carregarEvidenciaPortfolio(
  prisma: PrismaParaReconciliacaoFabricantes,
  titularesRawRelevantes: readonly string[],
  fabricantesPorId: ReadonlyMap<string, FabricanteParaResolverFabricante>,
): Promise<Map<string, EvidenciaPortfolioFabricante[]>> {
  const resultado = new Map<string, EvidenciaPortfolioFabricante[]>();
  if (titularesRawRelevantes.length === 0) return resultado;

  const registosComEsseTitular = await prisma.regulatoryRecord.findMany({
    where: { titularAim: { in: [...titularesRawRelevantes] } },
    select: { cnp: true, titularAim: true },
  });
  if (registosComEsseTitular.length === 0) return resultado;

  const cnps = registosComEsseTitular.map((r) => r.cnp);
  const produtosComFabricante = await prisma.produto.findMany({
    where: { cnp: { in: cnps }, fabricanteId: { not: null } },
    select: { cnp: true, fabricanteId: true },
  });
  if (produtosComFabricante.length === 0) return resultado;

  const titularPorCnp = new Map(registosComEsseTitular.map((r) => [r.cnp, r.titularAim]));
  const contagemPorNomeEFabricante = new Map<string, Map<string, number>>();
  for (const p of produtosComFabricante) {
    const titularRaw = titularPorCnp.get(p.cnp);
    const norm = titularRaw ? normalizarTitularAimGarantia(titularRaw) : null;
    if (!norm || !p.fabricanteId) continue;
    const porFabricante = contagemPorNomeEFabricante.get(norm) ?? new Map<string, number>();
    porFabricante.set(p.fabricanteId, (porFabricante.get(p.fabricanteId) ?? 0) + 1);
    contagemPorNomeEFabricante.set(norm, porFabricante);
  }

  for (const [nomeNorm, porFabricante] of contagemPorNomeEFabricante) {
    const candidatos: EvidenciaPortfolioFabricante[] = [];
    for (const [fabricanteId, contagem] of porFabricante) {
      const fabricante = fabricantesPorId.get(fabricanteId);
      if (!fabricante) continue;
      candidatos.push({ fabricanteId, nomeNormalizado: fabricante.nomeNormalizado, contagem });
    }
    if (candidatos.length > 0) resultado.set(nomeNorm, candidatos);
  }
  return resultado;
}

/**
 * Aplica um `ResultadoResolucaoFabricante` sobre a base real — ou, com
 * `dryRun=true`, só simula em memória o que seria escrito (nunca toca
 * em `prisma`). Em dry-run, os mapas em memória são actualizados na
 * mesma (com um id sintético `dryrun:<nomeCanonico>` para um Fabricante
 * ainda por criar) para que um segundo produto do MESMO lote que
 * resolva para o mesmo canónico seja contado como reutilização, não
 * como uma segunda criação — a mesma idempotência que aconteceria numa
 * execução real sequencial.
 *
 * `abortarEmConflito` distingue os dois modos do módulo:
 *   - `false` (modo imediato, online): uma condição `where: {
 *     fabricanteId: null }` que já não bate (P2025 — outra execução
 *     resolveu o MESMO produto entretanto) é um no-op seguro, nunca uma
 *     falha — cada produto é uma unidade independente.
 *   - `true` (modo transacional, CLI de backfill): a MESMA condição a
 *     não bater é tratada como uma falha real, que se deixa propagar —
 *     dentro de uma `$transaction`, isso aborta e reverte o lote
 *     INTEIRO, exactamente a garantia que o backfill pede (mais seguro
 *     do que aplicar parte de um lote sobre um estado que já mudou
 *     desde a classificação).
 */
const PREFIXO_PENDENTE = "pendente:";

async function aplicarResolucao(
  prisma: PrismaParaReconciliacaoFabricantes,
  produtoId: string,
  resultado: Extract<ResultadoResolucaoFabricante, { tipo: "resolvido_existente" | "resolvido_criar_novo" }>,
  fabricantesPorId: Map<string, FabricanteParaResolverFabricante>,
  fabricantesPorNomeNormalizado: Map<string, FabricanteParaResolverFabricante>,
  summary: ReconciliacaoFabricantesSummary,
  dryRun: boolean,
  abortarEmConflito: boolean,
): Promise<void> {
  let fabricanteId: string;

  if (resultado.tipo === "resolvido_existente") {
    fabricanteId = resultado.fabricanteId;
    // Referência a um placeholder registado durante classificar() —
    // "outro produto do MESMO lote ainda não aplicado vai criar este
    // canónico". Por construção, o pendente QUE CRIA está sempre antes
    // deste na lista (classificar() só regista o placeholder depois de
    // produzir o resolvido_criar_novo correspondente) — a esta altura já
    // foi aplicado e `fabricantesPorNomeNormalizado` já tem a entrada
    // REAL sob o mesmo nome.
    if (fabricanteId.startsWith(PREFIXO_PENDENTE)) {
      const nomeAlvo = fabricanteId.slice(PREFIXO_PENDENTE.length);
      fabricanteId = fabricantesPorNomeNormalizado.get(nomeAlvo)?.id ?? fabricanteId;
    }
  } else {
    // resolvido_criar_novo — nunca a partir de valor vazio/inválido: o
    // resolver só devolve isto com um `nomeCanonicoNormalizado` já
    // validado por `normalizarTitularAimGarantia` (>=2 chars).
    const existente = fabricantesPorNomeNormalizado.get(resultado.nomeCanonicoNormalizado);
    if (existente) {
      // Corrida entre duas execuções concorrentes já pode ter criado o
      // mesmo canónico entretanto (ou, em dry-run/plano transacional, um
      // produto anterior do MESMO lote já "criou" o sintético/real) —
      // reutiliza em vez de duplicar (nomeNormalizado é @unique; isto
      // evita depender só do índice para a idempotência do relatório).
      fabricanteId = existente.id;
    } else if (dryRun) {
      const sintetico = { id: `dryrun:${resultado.nomeCanonicoNormalizado}`, nomeNormalizado: resultado.nomeCanonicoNormalizado };
      fabricantesPorId.set(sintetico.id, sintetico);
      fabricantesPorNomeNormalizado.set(sintetico.nomeNormalizado, sintetico);
      fabricanteId = sintetico.id;
      summary.fabricantesCriados++;
      summary.fabricantesCriadosDetalhe.push(sintetico.nomeNormalizado);
    } else {
      const novo = await prisma.fabricante.create({
        data: { nomeNormalizado: resultado.nomeCanonicoNormalizado },
        select: { id: true, nomeNormalizado: true },
      });
      fabricantesPorId.set(novo.id, novo);
      fabricantesPorNomeNormalizado.set(novo.nomeNormalizado, novo);
      fabricanteId = novo.id;
      summary.fabricantesCriados++;
      summary.fabricantesCriadosDetalhe.push(novo.nomeNormalizado);
    }
  }

  // Comum aos dois tipos: um nome "antigo" (plano curado) a registar como
  // alias do canónico agora resolvido — quer o canónico já existisse
  // (resolvido_existente/via:plano_curado), quer tenha acabado de ser
  // criado por ESTE MESMO produto (resolvido_criar_novo, quando é o
  // primeiro do lote a precisar deste canónico).
  if (resultado.criarAliasNormalizado) {
    const jaExiste = dryRun
      ? []
      : await prisma.fabricanteAlias.findMany({
          where: { fabricanteId, aliasNome: resultado.criarAliasNormalizado },
          select: { fabricanteId: true },
          take: 1,
        });
    if (jaExiste.length === 0) {
      if (!dryRun) await prisma.fabricanteAlias.create({ data: { fabricanteId, aliasNome: resultado.criarAliasNormalizado } });
      summary.aliasesCriados++;
      const nomeFabricante = fabricantesPorId.get(fabricanteId)?.nomeNormalizado ?? fabricanteId;
      summary.aliasesCriadosDetalhe.push({ aliasNormalizado: resultado.criarAliasNormalizado, fabricanteNomeNormalizado: nomeFabricante });
    }
  }

  if (dryRun) {
    contarPorVia(resultado, summary);
    if (resultado.estadoAim) summary.estadosAim[resultado.estadoAim] = (summary.estadosAim[resultado.estadoAim] ?? 0) + 1;
    return;
  }

  // `where: { id, fabricanteId: null }` — dupla garantia (para além da
  // já feita pelo resolver, que só chega aqui quando fabricanteId era
  // null) de que nunca se sobrescreve um valor já preenchido, mesmo
  // perante uma corrida entre duas execuções concorrentes sobre o MESMO
  // produto. Ver `abortarEmConflito` na doc do cabeçalho desta função
  // para o que acontece quando a condição não bate.
  try {
    await prisma.produto.update({ where: { id: produtoId }, data: { fabricanteId } });
  } catch (err) {
    if (!abortarEmConflito && (err as { code?: string }).code === "P2025") return; // já resolvido por outra execução — no-op seguro
    throw err;
  }

  contarPorVia(resultado, summary);
  if (resultado.estadoAim) summary.estadosAim[resultado.estadoAim] = (summary.estadosAim[resultado.estadoAim] ?? 0) + 1;
}

function contarPorVia(
  resultado: Extract<ResultadoResolucaoFabricante, { tipo: "resolvido_existente" | "resolvido_criar_novo" }>,
  summary: ReconciliacaoFabricantesSummary,
): void {
  if (resultado.tipo === "resolvido_criar_novo") {
    summary.resolvidosPorNomeNormalizado++;
    return;
  }
  switch (resultado.via) {
    case "nome_normalizado": summary.resolvidosPorNomeNormalizado++; break;
    case "alias": summary.resolvidosPorAlias++; break;
    case "plano_curado": summary.resolvidosPorPlanoCurado++; break;
    case "prefixo_truncado": summary.resolvidosPorPrefixo++; break;
    case "evidencia_portfolio": summary.resolvidosPorEvidenciaPortfolio++; break;
  }
}

/**
 * Classifica TODOS os produtos do escopo — leituras apenas, zero
 * escritas, partilhado pelos dois modos exportados. Devolve o summary
 * já com as contagens que NÃO dependem de escrita (já-tinha-fabricante,
 * protegido, ambíguo, sem-fonte, divergências, regra 10) e a lista de
 * `pendentes` — produtos resolvidos que AINDA precisam de ser
 * aplicados, pelo modo escolhido pelo chamador.
 */
async function classificar(
  prisma: PrismaParaReconciliacaoFabricantes,
  tenantSlug: string,
  opts: EscopoReconciliacaoFabricantes & { mapeamentoCurado?: MapeamentoCuradoFabricantes },
): Promise<{
  summary: ReconciliacaoFabricantesSummary;
  pendentes: PendenteEscrita[];
  fabricantesPorId: Map<string, FabricanteParaResolverFabricante>;
  fabricantesPorNomeNormalizado: Map<string, FabricanteParaResolverFabricante>;
}> {
  if (tenantSlug !== TENANT_TRAVADO) {
    throw new Error(`reconciliarFabricantesPorCnpGarantia: tenant "${tenantSlug}" recusado — exclusivo do tenant "${TENANT_TRAVADO}".`);
  }

  const summary = novoSummary();
  const pendentes: PendenteEscrita[] = [];

  const produtos = await seleccionarProdutos(prisma, opts);
  if (produtos.length === 0) {
    return { summary, pendentes, fabricantesPorId: new Map(), fabricantesPorNomeNormalizado: new Map() };
  }

  const { mapas, fabricantesPorId, fabricantesTodos } = await carregarMapas(prisma, opts.mapeamentoCurado);
  // Devolvido para APLICAÇÃO — nunca leva placeholders sintéticos, só o
  // que já existe de facto na base ao carregar.
  const fabricantesPorNomeNormalizado = new Map([...mapas.fabricantesPorNomeNormalizado.entries()]);
  // Cópia SEPARADA, só para o resolver e só durante ESTA classificação —
  // vai sendo actualizada com placeholders `pendente:<nome>` à medida
  // que produtos resolvem "resolvido_criar_novo", para que um SEGUNDO
  // produto do MESMO lote que precise do MESMO canónico (por nome exacto
  // OU por um alias do plano curado) o veja como já "resolvido" em vez
  // de gerar uma segunda ordem de criação — e, no caso do plano curado,
  // para nunca perder o alias do nome "antigo" desse segundo produto (ver
  // resolver-fabricante-por-cnp.ts: só quem CRIA arrasta
  // `criarAliasNormalizado`; sem esta cópia, o segundo produto também
  // "criaria", silenciosamente a partir do zero, perdendo o seu próprio
  // alias).
  const fabricantesPorNomeNormalizadoClassificacao = new Map(fabricantesPorNomeNormalizado);

  const cnps = [...new Set(produtos.map((p) => p.cnp))];
  const registosRaw = cnps.length > 0
    ? await prisma.regulatoryRecord.findMany({ where: { cnp: { in: cnps } }, select: { cnp: true, titularAim: true, estadoAim: true } })
    : [];
  const registosPorCnp = new Map(registosRaw.map((r) => [r.cnp, { titularAim: r.titularAim, estadoAim: r.estadoAim }]));

  // Regra 5e (evidência de portefólio) — âmbito restrito aos titulares
  // brutos deste próprio lote (ver a doc de carregarEvidenciaPortfolio).
  const titularesRawRelevantes = [...new Set(registosRaw.map((r) => r.titularAim).filter((t): t is string => !!t))];
  const evidenciaPortfolioPorNomeNormalizado = await carregarEvidenciaPortfolio(prisma, titularesRawRelevantes, fabricantesPorId);
  const mapasComGeral: MapasResolverFabricante = { ...mapas, fabricantesTodos, evidenciaPortfolioPorNomeNormalizado };

  const produtosComFabricanteId = produtos.filter((p) => p.fabricanteId);
  const fabricantesExistentesPorProdutoId = new Map<string, string | null>();
  if (produtosComFabricanteId.length > 0) {
    const idsFabricante = [...new Set(produtosComFabricanteId.map((p) => p.fabricanteId!))];
    for (const id of idsFabricante) {
      fabricantesExistentesPorProdutoId.set(id, fabricantesPorId.get(id)?.nomeNormalizado ?? null);
    }
  }

  const pfRaw = await prisma.produtoFarmacia.findMany({
    where: { produtoId: { in: produtos.map((p) => p.id) }, fabricanteErpAtual: { not: null } },
    select: { produtoId: true, fabricanteErpAtual: true },
  });
  const fabricanteOrigemPorProdutoId = new Map<string, string | null>();
  for (const pf of pfRaw) {
    if (!fabricanteOrigemPorProdutoId.has(pf.produtoId)) fabricanteOrigemPorProdutoId.set(pf.produtoId, pf.fabricanteErpAtual);
  }

  for (const p of produtos) {
    summary.analisados++;
    try {
      const registo = registosPorCnp.get(p.cnp) ?? null;
      const resultado = resolverFabricantePorCnp(
        {
          id: p.id,
          cnp: p.cnp,
          fabricanteIdExistente: p.fabricanteId,
          fabricanteExistenteNomeNormalizado: p.fabricanteId ? (fabricantesExistentesPorProdutoId.get(p.fabricanteId) ?? null) : null,
          camposManuais: p.camposManuais,
        },
        registo,
        fabricanteOrigemPorProdutoId.get(p.id) ?? null,
        ehCnpCatalogavel(p.cnp),
        { ...mapasComGeral, fabricantesPorNomeNormalizado: fabricantesPorNomeNormalizadoClassificacao },
      );

      switch (resultado.tipo) {
        case "ja_tem_fabricante":
          summary.jaTinhaFabricante++;
          if (resultado.divergente) summary.divergencias++;
          break;
        case "protegido_manual":
          summary.protegidosManualmente++;
          break;
        case "ambiguo":
          summary.ambiguidades++;
          summary.ambiguidadesDetalhe.push({ cnp: p.cnp, motivo: resultado.motivo, nomeNormalizado: resultado.nomeNormalizado, candidatos: resultado.candidatos });
          if (registo?.estadoAim && ESTADOS_AIM_ATUAIS.has(registo.estadoAim)) {
            summary.aindaSemFabricanteAtual++;
            summary.aindaSemFabricanteDetalhe.push({ cnp: p.cnp, origem: "ambiguo", motivo: resultado.motivo, nomeNormalizado: resultado.nomeNormalizado });
          }
          break;
        case "sem_fonte":
          summary.semFonte[resultado.motivo]++;
          if (registo?.estadoAim && ESTADOS_AIM_ATUAIS.has(registo.estadoAim)) {
            summary.aindaSemFabricanteAtual++;
            summary.aindaSemFabricanteDetalhe.push({ cnp: p.cnp, origem: "sem_fonte", motivo: resultado.motivo, nomeNormalizado: null });
          }
          break;
        case "resolvido_existente":
          pendentes.push({ produtoId: p.id, resultado });
          break;
        case "resolvido_criar_novo":
          if (!fabricantesPorNomeNormalizadoClassificacao.has(resultado.nomeCanonicoNormalizado)) {
            fabricantesPorNomeNormalizadoClassificacao.set(resultado.nomeCanonicoNormalizado, {
              id: `${PREFIXO_PENDENTE}${resultado.nomeCanonicoNormalizado}`,
              nomeNormalizado: resultado.nomeCanonicoNormalizado,
            });
          }
          pendentes.push({ produtoId: p.id, resultado });
          break;
      }
    } catch {
      summary.erros++;
    }
  }

  return { summary, pendentes, fabricantesPorId, fabricantesPorNomeNormalizado };
}

/**
 * Reconcilia `Produto.fabricanteId` contra o estado ACTUAL da base,
 * aplicando cada resolução IMEDIATAMENTE, produto a produto, sem
 * `$transaction` — ver o cabeçalho do ficheiro para a escolha entre os
 * dois modos. Nunca lança excepção por produto individual (erros ficam
 * em `erros`); só lança se `tenantSlug !== "garantia"` (antes de
 * qualquer query).
 *
 * `opts.dryRun` (default false): quando `true`, classifica e conta tudo
 * exactamente como uma execução real, mas nunca chama `produto.update`,
 * `fabricante.create` nem `fabricanteAlias.create`.
 */
export async function reconciliarFabricantesPorCnpGarantia(
  prisma: PrismaParaReconciliacaoFabricantes,
  tenantSlug: string,
  opts: EscopoReconciliacaoFabricantes & { mapeamentoCurado?: MapeamentoCuradoFabricantes; dryRun?: boolean },
): Promise<ReconciliacaoFabricantesSummary> {
  const t0 = Date.now();
  const { summary, pendentes, fabricantesPorId, fabricantesPorNomeNormalizado } = await classificar(prisma, tenantSlug, opts);

  const dryRun = opts.dryRun === true;
  for (const item of pendentes) {
    try {
      await aplicarResolucao(prisma, item.produtoId, item.resultado, fabricantesPorId, fabricantesPorNomeNormalizado, summary, dryRun, false);
    } catch {
      summary.erros++;
    }
  }

  summary.durationMs = Date.now() - t0;
  return summary;
}

/**
 * Reconcilia `Produto.fabricanteId` contra o estado ACTUAL da base,
 * construindo primeiro o PLANO COMPLETO (classificação, zero escritas)
 * e só depois aplicando-o — quando `dryRun` é `false` e há pelo menos
 * um item pendente — dentro de uma ÚNICA `prisma.$transaction`: se
 * qualquer escrita do lote falhar, TODAS revertem (Fabricante,
 * FabricanteAlias e Produto.fabricanteId incluídos), nunca fica um
 * subconjunto aplicado. Ver o cabeçalho do ficheiro.
 *
 * Nunca abre transacção em dry-run, nem quando o plano está vazio
 * (idempotência: uma segunda corrida sobre o mesmo estado não tem nada
 * para aplicar). Só lança se `tenantSlug !== "garantia"` (antes de
 * qualquer query) ou se a própria transacção falhar — nesse caso o
 * chamador (a CLI) recebe a excepção e é responsável por reportar que
 * NADA foi escrito, nunca por assumir sucesso parcial.
 */
export async function reconciliarFabricantesPorCnpGarantiaTransacional(
  prisma: PrismaParaReconciliacaoFabricantesTransacional,
  tenantSlug: string,
  opts: EscopoReconciliacaoFabricantes & { mapeamentoCurado?: MapeamentoCuradoFabricantes; dryRun?: boolean; timeoutMs?: number; maxWaitMs?: number },
): Promise<ReconciliacaoFabricantesSummary> {
  const t0 = Date.now();
  const { summary, pendentes, fabricantesPorId, fabricantesPorNomeNormalizado } = await classificar(prisma, tenantSlug, opts);

  const dryRun = opts.dryRun === true;
  if (dryRun) {
    for (const item of pendentes) {
      // dry-run nunca toca `prisma` (ver aplicarResolucao) — seguro chamar fora de qualquer transacção.
      await aplicarResolucao(prisma, item.produtoId, item.resultado, fabricantesPorId, fabricantesPorNomeNormalizado, summary, true, false);
    }
    summary.durationMs = Date.now() - t0;
    return summary;
  }

  if (pendentes.length > 0) {
    const timeout = opts.timeoutMs ?? calcularTimeoutTransacaoMs(pendentes.length);
    const maxWait = opts.maxWaitMs ?? TX_MAX_WAIT_MS_DEFAULT;
    await prisma.$transaction(async (tx) => {
      for (const item of pendentes) {
        await aplicarResolucao(
          tx as PrismaParaReconciliacaoFabricantes,
          item.produtoId,
          item.resultado,
          fabricantesPorId,
          fabricantesPorNomeNormalizado,
          summary,
          false,
          true, // abortarEmConflito — qualquer falha reverte o lote INTEIRO.
        );
      }
    }, { timeout, maxWait });
  }

  summary.durationMs = Date.now() - t0;
  return summary;
}
