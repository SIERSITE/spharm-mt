import type { PrismaClient } from "@/generated/prisma/client";

/**
 * lib/encomendas/autosave.ts
 *
 * Gravação em lote, transacional e com bloqueio optimista das linhas
 * ALTERADAS de um rascunho de encomenda (`ListaEncomenda.estado ===
 * "RASCUNHO"`). Único caminho suportado para o autosave — server
 * actions chamam SÓ esta função, nunca `prisma.linhaEncomenda.upsert`
 * directamente (mesma disciplina de `lib/ingest/orders.ts`).
 *
 * ── Optimistic locking ──────────────────────────────────────────────
 * `ListaEncomenda.versao` incrementa a CADA gravação bem sucedida. O
 * chamador tem de saber a versão que estava a editar (`versaoEsperada`)
 * — se já não bater com a versão actual da base, `ConflitoVersaoError`
 * é lançado ANTES de qualquer escrita. Nunca last-write-wins silencioso:
 * o mesmo rascunho aberto em duas tarefas/separadores/dispositivos nunca
 * perde a segunda gravação por cima da primeira sem avisar.
 *
 * ── Porque não usa `$transaction` em lotes de N ─────────────────────
 * Uma encomenda tem, na prática, dezenas a algumas centenas de linhas —
 * não milhares (ao contrário do backfill de classificação de grupos
 * laboratoriais, que tinha esse problema real). Uma única transacção
 * interactive chega confortavelmente dentro do timeout default do
 * Prisma para este volume.
 */

export type LinhaAutosavePatch = {
  produtoId: string;
  quantidadeSugerida?: number | null;
  quantidadeAjustada?: number | null;
  fornecedorSugeridoId?: string | null;
  notas?: string | null;
  /**
   * Só deve ser enviado quando a linha está a ser criada de raiz pelo
   * autosave (produto ainda não existe na lista) — nesse caso é sempre
   * "MANUAL". Omitir num PATCH de uma linha já existente para nunca
   * apagar a proveniência PROPOSTA/SUGESTAO original (ver
   * lib/encomendas/origem-linha.ts — só linhas PROPOSTA são substituídas
   * por um recálculo; mudar `origem` aqui por engano tornava a linha
   * imune a esse recálculo sem o utilizador ter pedido nada).
   */
  origem?: "PROPOSTA" | "MANUAL" | "SUGESTAO";
};

export type AutosaveInput = {
  listaEncomendaId: string;
  versaoEsperada: number;
  linhas: readonly LinhaAutosavePatch[];
};

export type AutosaveResultado = {
  versao: number;
  gravadas: number;
};

export class ConflitoVersaoError extends Error {
  readonly versaoAtual: number;
  constructor(versaoAtual: number) {
    super(
      `A encomenda foi alterada por outra sessão (versão actual: ${versaoAtual}). ` +
        `As tuas alterações locais não foram gravadas — actualiza para ver os dados mais recentes, ou cria uma cópia.`
    );
    this.name = "ConflitoVersaoError";
    this.versaoAtual = versaoAtual;
  }
}

export class RascunhoNaoEditavelError extends Error {
  constructor(estadoActual: string) {
    super(`Esta encomenda já não é editável (estado actual: ${estadoActual}).`);
    this.name = "RascunhoNaoEditavelError";
  }
}

export async function salvarAutosaveEncomenda(
  prisma: PrismaClient,
  input: AutosaveInput
): Promise<AutosaveResultado> {
  if (input.linhas.length === 0) {
    const atual = await prisma.listaEncomenda.findUniqueOrThrow({
      where: { id: input.listaEncomendaId },
      select: { versao: true },
    });
    return { versao: atual.versao, gravadas: 0 };
  }

  return prisma.$transaction(async (tx) => {
    const lista = await tx.listaEncomenda.findUnique({
      where: { id: input.listaEncomendaId },
      select: { estado: true, versao: true },
    });
    if (!lista) throw new Error("Encomenda não encontrada.");
    if (lista.estado !== "RASCUNHO") throw new RascunhoNaoEditavelError(lista.estado);
    if (lista.versao !== input.versaoEsperada) throw new ConflitoVersaoError(lista.versao);

    for (const linha of input.linhas) {
      await tx.linhaEncomenda.upsert({
        where: {
          listaEncomendaId_produtoId: {
            listaEncomendaId: input.listaEncomendaId,
            produtoId: linha.produtoId,
          },
        },
        create: {
          listaEncomendaId: input.listaEncomendaId,
          produtoId: linha.produtoId,
          quantidadeSugerida: linha.quantidadeSugerida ?? null,
          quantidadeAjustada: linha.quantidadeAjustada ?? null,
          fornecedorSugeridoId: linha.fornecedorSugeridoId ?? null,
          notas: linha.notas ?? null,
          origem: linha.origem ?? "MANUAL",
        },
        update: {
          ...(linha.quantidadeSugerida !== undefined ? { quantidadeSugerida: linha.quantidadeSugerida } : {}),
          ...(linha.quantidadeAjustada !== undefined ? { quantidadeAjustada: linha.quantidadeAjustada } : {}),
          ...(linha.fornecedorSugeridoId !== undefined ? { fornecedorSugeridoId: linha.fornecedorSugeridoId } : {}),
          ...(linha.notas !== undefined ? { notas: linha.notas } : {}),
          ...(linha.origem !== undefined ? { origem: linha.origem } : {}),
        },
      });
    }

    const actualizada = await tx.listaEncomenda.update({
      where: { id: input.listaEncomendaId },
      data: { versao: { increment: 1 } },
      select: { versao: true },
    });

    return { versao: actualizada.versao, gravadas: input.linhas.length };
  });
}
