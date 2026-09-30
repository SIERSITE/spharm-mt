/**
 * lib/encomendas/finalizar-multi-fornecedor-regras.ts
 *
 * Regras PURAS (sem Prisma, sem `server-only`) da finalização de uma
 * `ListaEncomenda` cujas linhas apontam para MAIS DO QUE UM fornecedor —
 * ver `lib/encomendas/finalizar-multi-fornecedor.ts` para a orquestração
 * real (transacção, numeração, outbox) que usa estas funções.
 *
 * Mesma filosofia de `lib/encomendas/origem-linha.ts`: a regra de
 * negócio vive aqui, testável com arrays simples, sem montar Prisma nem
 * um DOM.
 *
 * ── Decisão: linhas sem fornecedor bloqueiam a finalização ───────────
 *
 * Um documento externo (a "Nota de Encomenda" que sai para o fornecedor
 * — ver `lib/reporting/adapters/encomenda-documento.ts`) precisa sempre
 * de um destinatário real. Uma preparação com QUALQUER linha sem
 * fornecedor decidido não é dividida silenciosamente (a linha
 * desapareceria de todos os documentos) nem cai num grupo "Fornecedor
 * não definido" (isso criaria um documento sem destinatário real,
 * inutilizável) — é REJEITADA por inteiro, com a lista exacta dos
 * produtos em falta, para o utilizador completar a atribuição antes de
 * voltar a tentar.
 *
 * ── Decisão: quando usar este caminho vs. o de fornecedor único ──────
 *
 * `deveUsarFinalizacaoMultiFornecedor` só é `true` quando há MAIS DE UM
 * valor distinto de `fornecedorSugeridoId` entre as linhas (tratando
 * `null` como um valor distinto próprio). Um rascunho com um único
 * fornecedor (ou nenhum — o fluxo legado, anterior a esta funcionalidade)
 * continua pelo caminho de sempre (`finalizeAndQueueOrder`), sem
 * qualquer mudança de comportamento.
 */
import { createHash } from "node:crypto";

export type LinhaAgrupavel = {
  produtoId: string;
  fornecedorSugeridoId: string | null;
};

export type GrupoFornecedor<T extends LinhaAgrupavel> = {
  fornecedorId: string;
  linhas: T[];
};

/** Marcador interno — nunca um id real de `Fornecedor` (esses são cuid()). */
const SEM_FORNECEDOR_MARCADOR = "__sem_fornecedor__";

/**
 * Quantos fornecedores distintos aparecem nas linhas — `null` conta como
 * um valor próprio. Deliberadamente pede só `fornecedorSugeridoId` (não
 * o `LinhaAgrupavel` completo): quem só precisa de decidir QUAL caminho
 * de finalização seguir (ver `deveUsarFinalizacaoMultiFornecedor`,
 * `finalizeFromDetailAction`) não tem, nesse momento, mais nada da linha
 * à mão.
 */
export function contarFornecedoresDistintos(linhas: readonly { fornecedorSugeridoId: string | null }[]): number {
  return new Set(linhas.map((l) => l.fornecedorSugeridoId ?? SEM_FORNECEDOR_MARCADOR)).size;
}

/**
 * `true` quando a finalização desta lista tem de passar pelo caminho de
 * separação por fornecedor (mais de um fornecedor distinto entre as
 * linhas, incluindo a possibilidade de um dos "distintos" ser
 * "sem fornecedor"). `false` = caminho de sempre, fornecedor único
 * (`finalizeAndQueueOrder`) — inclui o caso legado de TODAS as linhas
 * sem fornecedor nenhum.
 */
export function deveUsarFinalizacaoMultiFornecedor(linhas: readonly { fornecedorSugeridoId: string | null }[]): boolean {
  return contarFornecedoresDistintos(linhas) > 1;
}

export type ValidacaoLinhasMultiFornecedor =
  | { ok: true }
  | { ok: false; error: string; produtoIdsSemFornecedor: string[] };

/**
 * Uma preparação só pode ser dividida por fornecedor se TODAS as linhas
 * tiverem um fornecedor decidido — ver o comentário do ficheiro.
 */
export function validarLinhasParaFinalizacaoMultiFornecedor<T extends LinhaAgrupavel>(
  linhas: readonly T[]
): ValidacaoLinhasMultiFornecedor {
  if (linhas.length === 0) {
    return { ok: false, error: "Sem linhas para finalizar.", produtoIdsSemFornecedor: [] };
  }
  const semFornecedor = linhas.filter((l) => l.fornecedorSugeridoId == null);
  if (semFornecedor.length > 0) {
    return {
      ok: false,
      error:
        `${semFornecedor.length} linha(s) sem fornecedor definido — esta encomenda tem linhas de mais ` +
        `do que um fornecedor, e um documento final precisa sempre de um destinatário. Atribua um ` +
        `fornecedor a todas as linhas antes de finalizar.`,
      produtoIdsSemFornecedor: semFornecedor.map((l) => l.produtoId),
    };
  }
  return { ok: true };
}

/**
 * Agrupa as linhas por `fornecedorSugeridoId`. Chamar SÓ depois de
 * `validarLinhasParaFinalizacaoMultiFornecedor` confirmar que não há
 * nenhuma linha `null` — esta função ignora-as silenciosamente (não é o
 * sítio da validação, é só o agrupamento).
 */
export function agruparLinhasPorFornecedor<T extends LinhaAgrupavel>(
  linhas: readonly T[]
): GrupoFornecedor<T>[] {
  const porFornecedor = new Map<string, T[]>();
  for (const l of linhas) {
    const chave = l.fornecedorSugeridoId;
    if (chave == null) continue;
    if (!porFornecedor.has(chave)) porFornecedor.set(chave, []);
    porFornecedor.get(chave)!.push(l);
  }
  return [...porFornecedor.entries()].map(([fornecedorId, ls]) => ({ fornecedorId, linhas: ls }));
}

export type DocumentoGeradoResumo = {
  fornecedorNome: string;
  numero: string | null;
  nLinhas: number;
};

/**
 * O texto exacto pedido para o resumo pós-finalização, ex.:
 *
 *   3 encomendas criadas
 *   Fornecedor A — 120 linhas — EN-000101
 *   Fornecedor B — 95 linhas — EN-000102
 *   Fornecedor C — 85 linhas — EN-000103
 */
export function formatarResumoFinalizacaoMultiFornecedor(documentos: readonly DocumentoGeradoResumo[]): string {
  const n = documentos.length;
  const linhasTexto = [`${n} encomenda${n === 1 ? "" : "s"} criada${n === 1 ? "" : "s"}`];
  for (const d of documentos) {
    linhasTexto.push(`${d.fornecedorNome} — ${d.nLinhas} linha${d.nLinhas === 1 ? "" : "s"} — ${d.numero ?? "(sem número)"}`);
  }
  return linhasTexto.join("\n");
}

/**
 * Chave de idempotência POR fornecedor, derivada de forma estável do
 * `batchKey` da operação inteira — mesmo padrão de
 * `deriveFarmaciaIdempotencyKey`/`deriveDirectionIdempotencyKey` em
 * `lib/ingest/orders.ts`/`lib/transferencias/criar-transferencia.ts`.
 * Persistida em `ListaEncomenda.clientIdempotencyKey` de cada documento
 * gerado — é o que torna cada filho da divisão, individualmente,
 * idempotente e seguro sob concorrência (índice único na BD).
 */
export function deriveFornecedorIdempotencyKey(batchKey: string, fornecedorId: string): string {
  return createHash("sha256").update(`${batchKey}:${fornecedorId}`).digest("hex");
}

/**
 * ── Modo grupo · fornecedor por linha (ver gerarPlanoGrupoAction) ──────
 *
 * O modo grupo não tem noção de "rascunho editável" (ver o comentário
 * sobre isso em `app/encomendas/nova/actions.ts` e em
 * `order-create-client.tsx`) — mas reutilizar `finalizarEncomendaMulti-
 * Fornecedor` exige um `ListaEncomenda` já persistido para dividir. A
 * solução é um RASCUNHO TRANSITÓRIO: criado e dividido na MESMA chamada
 * do servidor, nunca devolvido ao cliente como um rascunho editável —
 * fica como registo do "lote" dessa farmácia, exactamente como o
 * rascunho manual de `finalizar-multi-fornecedor.ts` fica depois de
 * dividido (loteDivididoEm preenchido, nunca apagado).
 *
 * As duas chaves abaixo derivam do MESMO `encomendaBatchKey` (uma vez
 * por chamada a `gerarPlanoGrupoAction`) mas com SALTS distintos — nunca
 * a mesma chave para dois papéis diferentes (criar o rascunho vs. o
 * batchKey da sua própria divisão), mesmo que, coincidentemente, o
 * `farmaciaId` usado em ambas seja o mesmo.
 */

/** Chave de idempotência do RASCUNHO TRANSITÓRIO por farmácia (criação). */
export function deriveGrupoDraftIdempotencyKey(batchKey: string, farmaciaId: string): string {
  return createHash("sha256").update(`${batchKey}:grupo-draft:${farmaciaId}`).digest("hex");
}

/** Chave de idempotência (batchKey) da DIVISÃO desse rascunho transitório, por farmácia. */
export function deriveGrupoFinalizacaoBatchKey(batchKey: string, farmaciaId: string): string {
  return createHash("sha256").update(`${batchKey}:grupo-fin:${farmaciaId}`).digest("hex");
}
