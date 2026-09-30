import "server-only";
import type { PrismaClient, Prisma } from "@/generated/prisma/client";
import {
  finalizarNaTransaccao,
  LinhasSemFornecedorError,
  PreparacaoConcorrenteError,
  type DocumentoGerado,
} from "@/lib/encomendas/finalizar-multi-fornecedor";
import { deriveConsolidacaoFinalizacaoBatchKey } from "@/lib/encomendas/finalizar-multi-fornecedor-regras";
import { deriveFarmaciaIdempotencyKey, IdempotencyConflictError } from "@/lib/ingest/orders";

/**
 * lib/encomendas/consolidacao-multi-fornecedor.ts
 *
 * Finalização da consolidação (modo "consolidacao" — N farmácias, cada
 * uma com o seu rascunho REAL e persistente, autosave próprio) quando as
 * linhas de QUALQUER farmácia apontam para mais de um fornecedor.
 * Agrupa PRIMEIRO por farmácia, DEPOIS por fornecedor:
 *
 *   farmácia A + fornecedor X → encomenda 1
 *   farmácia A + fornecedor Y → encomenda 2
 *   farmácia B + fornecedor X → encomenda 3
 *   farmácia B + fornecedor Z → encomenda 4
 *
 * ── Nunca uma segunda implementação da divisão por fornecedor ──────────
 *
 * Cada farmácia é dividida chamando `finalizarNaTransaccao` (exportada de
 * `lib/encomendas/finalizar-multi-fornecedor.ts` precisamente para este
 * reaproveitamento) — a MESMA função, testada com 56 asserções reais, que
 * já divide um rascunho "grupo" ou "farmacia". A única coisa que muda é o
 * `batchKey` passado a cada chamada: `deriveConsolidacaoFinalizacaoBatchKey`
 * dá-lhe um valor NAMESPACED por farmácia, por isso as chaves de
 * idempotência dos documentos filhos (derivadas internamente por essa
 * função, sem qualquer alteração) saem automaticamente únicas por
 * (farmácia, fornecedor).
 *
 * ── Transacção ÚNICA para a consolidação inteira ────────────────────────
 *
 * Ao contrário do modo "grupo" (`gerarPlanoGrupoAction`, onde cada
 * farmácia é uma decisão independente, documentado como aceitável ter
 * transacções separadas), a consolidação já era, antes desta
 * funcionalidade, "todas as encomendas — uma por farmácia — numa ÚNICA
 * transacção" (`createConsolidatedOrdersWithOutbox`, em
 * lib/ingest/orders.ts — continua a existir, inalterada, para quem
 * precisar do caminho simples sem fornecedor por linha). Esta função
 * preserva EXACTAMENTE essa garantia ao nível da farmácia×fornecedor:
 * uma falha em qualquer farmácia (ou em qualquer fornecedor dentro dela)
 * reverte TUDO — zero encomendas, zero outboxes, para a consolidação
 * inteira.
 *
 * ── Idempotência composta ────────────────────────────────────────────────
 *
 * Não precisa de lógica de replay própria: cada chamada a
 * `finalizarNaTransaccao` já decide, PARA O SEU PRÓPRIO rascunho, se é um
 * replay (`loteDivididoEm` já preenchido — devolve os documentos
 * existentes) ou uma divisão nova. Como as N chamadas estão todas dentro
 * da MESMA transacção, a atomicidade do Postgres garante que ou TODAS as
 * farmácias ficam divididas ou NENHUMA fica — por isso um retry desta
 * função encontra sempre um de dois estados consistentes: todas por
 * dividir (a transacção anterior não chegou a commitar — repete do
 * zero) ou todas já divididas (commitou — cada chamada interna devolve
 * replay, e esta função agrega exactamente os mesmos documentos).
 */

type Tx = Prisma.TransactionClient;

export type FinalizarConsolidacaoMultiFornecedorInput = {
  /** Chave de idempotência do LOTE de consolidação inteiro (gerada pelo cliente). */
  batchKey: string;
  /** Farmácias envolvidas — cada uma já tem de ter um rascunho RASCUNHO real (ver `deriveFarmaciaIdempotencyKey`). */
  farmaciaIds: readonly string[];
  /** Versão esperada por farmácia (bloqueio optimista) — omitida = sem verificação amigável para essa farmácia. */
  versaoEsperadaPorFarmacia?: ReadonlyMap<string, number>;
};

export type DocumentoConsolidacaoGerado = DocumentoGerado & { farmaciaId: string };

export type ResultadoFinalizacaoConsolidacaoMultiFornecedor = {
  reutilizado: boolean;
  /** Por farmácia: os documentos que ela gerou (1 ou mais, um por fornecedor distinto). */
  porFarmacia: Array<{ farmaciaId: string; loteOrigemId: string; documentos: DocumentoConsolidacaoGerado[] }>;
  /** Achatado — todos os documentos de todas as farmácias, na ordem em que `farmaciaIds` foi dado. */
  documentos: DocumentoConsolidacaoGerado[];
  /** Texto pronto a mostrar — ver o formato pedido: "Farmácia A\n  Fornecedor X — N linhas\n...\nTotal: M encomendas". */
  resumoTexto: string;
};

/** Nomes de farmácia para o resumo — só leitura, nunca cria/altera nada. */
async function nomesFarmacias(tx: Tx, ids: readonly string[]): Promise<Map<string, string>> {
  const rows = await tx.farmacia.findMany({ where: { id: { in: [...ids] } }, select: { id: true, nome: true } });
  return new Map(rows.map((f) => [f.id, f.nome]));
}

function formatarResumo(
  porFarmacia: Array<{ farmaciaId: string; documentos: DocumentoConsolidacaoGerado[] }>,
  nomesPorFarmacia: Map<string, string>
): string {
  const linhas: string[] = [];
  let total = 0;
  for (const f of porFarmacia) {
    linhas.push(nomesPorFarmacia.get(f.farmaciaId) ?? f.farmaciaId);
    for (const d of f.documentos) {
      linhas.push(`  ${d.fornecedorNome} — ${d.nLinhas} linha${d.nLinhas === 1 ? "" : "s"}`);
      total++;
    }
    linhas.push("");
  }
  linhas.push(`Total: ${total} encomenda${total === 1 ? "" : "s"}`);
  return linhas.join("\n");
}

async function finalizarConsolidacaoNaTransaccao(
  tx: Tx,
  tenantSlug: string,
  input: FinalizarConsolidacaoMultiFornecedorInput
): Promise<ResultadoFinalizacaoConsolidacaoMultiFornecedor> {
  const porFarmacia: Array<{ farmaciaId: string; loteOrigemId: string; documentos: DocumentoConsolidacaoGerado[] }> = [];
  let algumReutilizado = false;
  let algumNovo = false;

  for (const farmaciaId of input.farmaciaIds) {
    const draft = await tx.listaEncomenda.findFirst({
      where: { clientIdempotencyKey: deriveFarmaciaIdempotencyKey(input.batchKey, farmaciaId) },
      select: { id: true },
    });
    if (!draft) {
      throw new Error(`[consolidacao-multi-fornecedor] farmácia ${farmaciaId} não tem rascunho — nada para finalizar.`);
    }

    const resultado = await finalizarNaTransaccao(tx, tenantSlug, {
      listaEncomendaId: draft.id,
      batchKey: deriveConsolidacaoFinalizacaoBatchKey(input.batchKey, farmaciaId),
      versaoEsperada: input.versaoEsperadaPorFarmacia?.get(farmaciaId),
    });

    if (resultado.reutilizado) algumReutilizado = true;
    else algumNovo = true;

    porFarmacia.push({
      farmaciaId,
      loteOrigemId: resultado.loteOrigemId,
      documentos: resultado.documentos.map((d) => ({ ...d, farmaciaId })),
    });
  }

  // Lote misto (parte replay, parte novo) nunca é aceite — mesma regra de
  // `createConsolidatedOrdersWithOutbox` para o caso sem fornecedor por
  // linha: seria um conjunto inconsistente, sintoma de duas chamadas com
  // batchKeys diferentes a colidir por acaso numa farmácia, nunca um
  // estado legítimo desta função (que só é chamada com UM batchKey).
  if (algumReutilizado && algumNovo) {
    throw new IdempotencyConflictError(
      "Consolidação parcialmente já dividida sob a mesma chave — estado inconsistente."
    );
  }

  const nomesPorFarmacia = await nomesFarmacias(tx, input.farmaciaIds);
  return {
    reutilizado: algumReutilizado,
    porFarmacia,
    documentos: porFarmacia.flatMap((f) => f.documentos),
    resumoTexto: formatarResumo(porFarmacia, nomesPorFarmacia),
  };
}

/**
 * Ponto de entrada. `farmaciaIds` tem de listar TODAS as farmácias da
 * consolidação, na mesma ordem usada para gerar os rascunhos
 * (`deriveFarmaciaIdempotencyKey`) — normalmente vem do próprio pedido do
 * cliente, nunca inferida a partir do que já está na BD (evita finalizar
 * "o que calhar existir" em vez do que o utilizador realmente pediu).
 */
export async function finalizarConsolidacaoMultiFornecedor(
  prisma: PrismaClient,
  tenantSlug: string,
  input: FinalizarConsolidacaoMultiFornecedorInput
): Promise<ResultadoFinalizacaoConsolidacaoMultiFornecedor> {
  if (!tenantSlug) throw new Error("[consolidacao-multi-fornecedor] tenantSlug em falta.");
  if (!input.batchKey) throw new Error("[consolidacao-multi-fornecedor] batchKey em falta.");
  if (input.farmaciaIds.length === 0) throw new Error("[consolidacao-multi-fornecedor] sem farmácias.");
  if (new Set(input.farmaciaIds).size !== input.farmaciaIds.length) {
    throw new Error("[consolidacao-multi-fornecedor] farmácia repetida no pedido.");
  }

  for (let tentativa = 0; ; tentativa++) {
    try {
      return await prisma.$transaction((tx) => finalizarConsolidacaoNaTransaccao(tx, tenantSlug, input), {
        maxWait: 10_000,
        timeout: 30_000,
      });
    } catch (err) {
      const codigo = (err as { code?: string })?.code;
      const concorrente = err instanceof PreparacaoConcorrenteError;
      if (tentativa === 0 && (codigo === "P2002" || concorrente)) continue;
      throw err;
    }
  }
}

export { LinhasSemFornecedorError };
