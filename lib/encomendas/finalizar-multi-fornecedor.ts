import "server-only";
import type { PrismaClient, Prisma } from "@/generated/prisma/client";
import {
  criarListaNaTransaccao,
  IdempotencyConflictError,
  type OrderLineInput,
} from "@/lib/ingest/orders";
import {
  agruparLinhasPorFornecedor,
  contarFornecedoresDistintos,
  deveUsarFinalizacaoMultiFornecedor,
  deriveFornecedorIdempotencyKey,
  formatarResumoFinalizacaoMultiFornecedor,
  validarLinhasParaFinalizacaoMultiFornecedor,
} from "@/lib/encomendas/finalizar-multi-fornecedor-regras";

/**
 * lib/encomendas/finalizar-multi-fornecedor.ts
 *
 * Divide uma `ListaEncomenda` em RASCUNHO, cujas linhas apontam para MAIS
 * DO QUE UM fornecedor, em N documentos `ListaEncomenda` FINALIZADA — um
 * por fornecedor — mantendo o rascunho original como "lote" (continua com
 * `estado = "RASCUNHO"`, mas `loteDivididoEm` passa a ter uma data — nunca
 * apagado, nunca mais editável). NÃO é um novo valor de
 * `EstadoListaEncomenda` — ver o comentário de `loteDivididoEm` em
 * `prisma/schema.prisma` para o porquê (um Prisma Client mais antigo
 * lança em qualquer query sobre `ListaEncomenda` ao encontrar um valor de
 * enum que não conhece; um campo aditivo nullable não tem esse risco).
 * Ver também `ListaEncomenda.loteOrigemId` e as regras puras em
 * `lib/encomendas/finalizar-multi-fornecedor-regras.ts`.
 *
 * ── Âmbito da transacção: TUDO, all-or-nothing ────────────────────────
 *
 * Precedente mais próximo, `gerarPlanoGrupoAction` (`app/encomendas/
 * nova/actions.ts`), cria N `ListaEncomenda` cada uma na SUA PRÓPRIA
 * transacção — explicitamente documentado lá como aceitável para esse
 * caso, porque cada documento é uma decisão independente de origem (a
 * proposta de grupo), sem um "documento pai" que precise de acompanhar o
 * resultado.
 *
 * Aqui é diferente: existe um ÚNICO rascunho original que TEM de acabar
 * num de dois estados — ainda não dividido (`loteDivididoEm === null`,
 * nada aconteceu) ou dividido com os N documentos todos presentes
 * (`loteDivididoEm` preenchido, aconteceu tudo). Um resultado a meio (2 de
 * 3 documentos criados e o rascunho ainda não marcado como dividido, ou
 * pior, já marcado sem os 3) deixaria a preparação num estado sem saída —
 * não se pode voltar a tentar (já não está "livre") nem está completa.
 * Por isso esta função usa UMA `prisma.$transaction` para todo o
 * conjunto: os N `criarListaNaTransaccao` (cada um com a sua própria
 * `ListaEncomenda`+linhas+`OrderOutbox`), o `loteOrigemId` de cada um, e
 * a marcação do rascunho como dividido — tudo ou nada.
 *
 * ── Idempotência ───────────────────────────────────────────────────────
 *
 * `batchKey` (obrigatório, gerado pelo cliente — mesmo papel que
 * `ConsolidatedOrdersInput.batchKey`) deriva uma
 * `clientIdempotencyKey` PRÓPRIA para cada documento filho
 * (`deriveFornecedorIdempotencyKey`), reutilizando o mecanismo já
 * existente de `criarListaNaTransaccao` (índice único na BD): um retry
 * com a MESMA chave e o MESMO conteúdo devolve os mesmos documentos;
 * conteúdo diferente sob a mesma chave lança `IdempotencyConflictError`
 * (nunca um duplicado silencioso).
 *
 * Uma vez que o rascunho original recebe `loteDivididoEm`, essa transição
 * é TERMINAL — o rascunho nunca mais tem linhas alteráveis, e
 * por isso qualquer chamada post-hoc (com a mesma `batchKey` ou não)
 * encontra sempre EXACTAMENTE o mesmo conjunto de documentos já gerados;
 * devolvê-los é sempre a resposta correcta, nunca uma criação nova.
 *
 * Concorrência real (duas chamadas em voo ao mesmo tempo, mesma
 * `batchKey`): a corrida resolve-se ao nível de CADA filho, pelo mesmo
 * índice único + retry-uma-vez que já protege `createEncomendaWithOutbox`
 * — ver `transaccaoIdempotente` aqui em baixo. Concorrência com
 * `batchKey` DIFERENTES no MESMO rascunho é coberta por um
 * compare-and-swap explícito na marcação como dividido (`updateMany` com
 * `estado`+`loteDivididoEm IS NULL`+`versao` no WHERE) — se outra chamada
 * já tiver vencido a corrida, esta tentativa aborta e repete, encontrando
 * a divisão já feita.
 */

type Tx = Prisma.TransactionClient;

export class LinhasSemFornecedorError extends Error {
  readonly produtoIdsSemFornecedor: string[];
  constructor(message: string, produtoIdsSemFornecedor: string[]) {
    super(message);
    this.name = "LinhasSemFornecedorError";
    this.produtoIdsSemFornecedor = produtoIdsSemFornecedor;
  }
}

/** Lançado quando outra chamada concorrente já mudou o rascunho entretanto — apanhado internamente e retentado. */
class PreparacaoConcorrenteError extends Error {
  constructor() {
    super("[finalizar-multi-fornecedor] outra operação concorrente alterou o rascunho — a repetir.");
    this.name = "PreparacaoConcorrenteError";
  }
}

export type FinalizarMultiFornecedorInput = {
  listaEncomendaId: string;
  /** Chave de idempotência do LOTE desta operação — gerada pelo cliente uma vez por tentativa de finalizar. */
  batchKey: string;
  /**
   * Quando fornecida, a finalização só prossegue se a versão actual do
   * rascunho bater com esta — mesmo bloqueio optimista do autosave (ver
   * `lib/encomendas/autosave.ts`). Verificação "amigável" (mensagem clara
   * ao utilizador); a corrida REAL entre duas finalizações concorrentes é
   * apanhada à parte, ver `PreparacaoConcorrenteError`.
   */
  versaoEsperada?: number;
};

export type DocumentoGerado = {
  fornecedorId: string;
  fornecedorNome: string;
  listaEncomendaId: string;
  numero: string | null;
  nLinhas: number;
};

export type ResultadoFinalizacaoMultiFornecedor = {
  /** `true` quando esta chamada só reencontrou um resultado já existente (replay idempotente). */
  reutilizado: boolean;
  loteOrigemId: string;
  documentos: DocumentoGerado[];
  /** Texto pronto a mostrar/imprimir — ver `formatarResumoFinalizacaoMultiFornecedor`. */
  resumoTexto: string;
};

async function nomesFornecedores(tx: Tx, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.fornecedor.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, nome: true, nomeNormalizado: true },
  });
  return new Map(rows.map((f) => [f.id, f.nome ?? f.nomeNormalizado]));
}

async function replayDocumentosGerados(tx: Tx, loteOrigemId: string): Promise<DocumentoGerado[]> {
  const gerados = await tx.listaEncomenda.findMany({
    where: { loteOrigemId },
    orderBy: { dataCriacao: "asc" },
    include: {
      _count: { select: { linhas: true } },
      linhas: {
        take: 1,
        select: { fornecedorSugeridoId: true, fornecedorSugerido: { select: { nome: true, nomeNormalizado: true } } },
      },
    },
  });
  return gerados.map((g) => ({
    fornecedorId: g.linhas[0]?.fornecedorSugeridoId ?? "",
    fornecedorNome:
      g.linhas[0]?.fornecedorSugerido?.nome ?? g.linhas[0]?.fornecedorSugerido?.nomeNormalizado ?? "Fornecedor",
    listaEncomendaId: g.id,
    numero: g.numero,
    nLinhas: g._count.linhas,
  }));
}

async function finalizarNaTransaccao(
  tx: Tx,
  tenantSlug: string,
  input: FinalizarMultiFornecedorInput
): Promise<ResultadoFinalizacaoMultiFornecedor> {
  const draft = await tx.listaEncomenda.findUniqueOrThrow({
    where: { id: input.listaEncomendaId },
    include: { linhas: true },
  });

  // Replay: a preparação já foi dividida — o rascunho é terminal a partir
  // daqui, por isso qualquer chamada seguinte (com a mesma `batchKey` ou
  // não) encontra sempre o MESMO conjunto de documentos. Devolvê-los é a
  // resposta correcta, nunca uma tentativa de criar de novo.
  if (draft.loteDivididoEm !== null) {
    const documentos = await replayDocumentosGerados(tx, draft.id);
    return {
      reutilizado: true,
      loteOrigemId: draft.id,
      documentos,
      resumoTexto: formatarResumoFinalizacaoMultiFornecedor(documentos),
    };
  }

  if (draft.estado !== "RASCUNHO") {
    throw new Error(
      `[finalizar-multi-fornecedor] não é possível finalizar por fornecedor uma encomenda em estado ${draft.estado}.`
    );
  }

  if (input.versaoEsperada !== undefined && draft.versao !== input.versaoEsperada) {
    const { ConflitoVersaoError } = await import("@/lib/encomendas/autosave");
    throw new ConflitoVersaoError(draft.versao);
  }

  const validacao = validarLinhasParaFinalizacaoMultiFornecedor(draft.linhas);
  if (!validacao.ok) {
    throw new LinhasSemFornecedorError(validacao.error, validacao.produtoIdsSemFornecedor);
  }

  const grupos = agruparLinhasPorFornecedor(draft.linhas);
  const nomePorId = await nomesFornecedores(
    tx,
    grupos.map((g) => g.fornecedorId)
  );

  const documentos: DocumentoGerado[] = [];
  for (const grupo of grupos) {
    const fornecedorNome = nomePorId.get(grupo.fornecedorId) ?? "Fornecedor";
    const chaveFilho = deriveFornecedorIdempotencyKey(input.batchKey, grupo.fornecedorId);
    const linhasInput: OrderLineInput[] = grupo.linhas.map((l) => ({
      produtoId: l.produtoId,
      quantidadeSugerida: l.quantidadeSugerida !== null ? Number(l.quantidadeSugerida) : null,
      quantidadeAjustada: l.quantidadeAjustada !== null ? Number(l.quantidadeAjustada) : null,
      fornecedorSugeridoId: l.fornecedorSugeridoId,
      notas: l.notas,
      origem: l.origem,
    }));

    const criado = await criarListaNaTransaccao(
      tx,
      tenantSlug,
      {
        farmaciaId: draft.farmaciaId,
        // O autor de cada documento gerado é o autor ORIGINAL do
        // rascunho — isto é o mesmo pedido, dividido, não uma nova
        // decisão de quem carregou em "Finalizar".
        criadoPorId: draft.criadoPorId,
        nome: `${draft.nome} · ${fornecedorNome}`.slice(0, 180),
        finalize: true,
        linhas: linhasInput,
        clientIdempotencyKey: chaveFilho,
      },
      "multi-fornecedor"
    );

    await tx.listaEncomenda.update({
      where: { id: criado.listaEncomendaId },
      data: { loteOrigemId: draft.id },
    });

    documentos.push({
      fornecedorId: grupo.fornecedorId,
      fornecedorNome,
      listaEncomendaId: criado.listaEncomendaId,
      numero: criado.numero,
      nLinhas: grupo.linhas.length,
    });
  }

  // Compare-and-swap explícito: só marca como dividido se o rascunho
  // continuar EXACTAMENTE como foi lido no início desta transacção (mesmo
  // estado, ainda não dividido, mesma versão). Protege contra duas
  // finalizações concorrentes com `batchKey` DIFERENTES sobre o MESMO
  // rascunho — a corrida entre duas chamadas com a MESMA `batchKey` já
  // está coberta pelo índice único por documento filho, acima. `estado`
  // NUNCA muda aqui (fica RASCUNHO) — ver `loteDivididoEm` em
  // prisma/schema.prisma para o porquê de não ser um novo valor de enum.
  const cas = await tx.listaEncomenda.updateMany({
    where: { id: draft.id, estado: "RASCUNHO", loteDivididoEm: null, versao: draft.versao },
    data: { loteDivididoEm: new Date(), versao: { increment: 1 } },
  });
  if (cas.count === 0) {
    throw new PreparacaoConcorrenteError();
  }

  return {
    reutilizado: false,
    loteOrigemId: draft.id,
    documentos,
    resumoTexto: formatarResumoFinalizacaoMultiFornecedor(documentos),
  };
}

/**
 * Ponto de entrada. Ver o comentário do ficheiro para o desenho da
 * transacção e da idempotência.
 */
export async function finalizarEncomendaMultiFornecedor(
  prisma: PrismaClient,
  tenantSlug: string,
  input: FinalizarMultiFornecedorInput
): Promise<ResultadoFinalizacaoMultiFornecedor> {
  if (!tenantSlug) {
    throw new Error("[finalizar-multi-fornecedor] tenantSlug em falta.");
  }
  if (!input.batchKey) {
    throw new Error("[finalizar-multi-fornecedor] batchKey em falta — obrigatória para uma operação idempotente.");
  }

  for (let tentativa = 0; ; tentativa++) {
    try {
      return await prisma.$transaction((tx) => finalizarNaTransaccao(tx, tenantSlug, input));
    } catch (err) {
      const codigo = (err as { code?: string })?.code;
      const concorrente = err instanceof PreparacaoConcorrenteError;
      if (tentativa === 0 && (codigo === "P2002" || concorrente)) continue;
      throw err;
    }
  }
}

// Reexportado para os chamadores (server actions) nunca precisarem de
// importar de dois sítios diferentes para tratar o mesmo tipo de erro.
export { IdempotencyConflictError, contarFornecedoresDistintos, deveUsarFinalizacaoMultiFornecedor };
