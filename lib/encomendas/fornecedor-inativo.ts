/**
 * lib/encomendas/fornecedor-inativo.ts
 *
 * Regra dos fornecedores INATIVOS nas encomendas (única, partilhada):
 *
 *   · A proposta NUNCA usa automaticamente um fornecedor habitual inativo
 *     (ver `lib/encomendas/proposal.ts`): a linha nasce «sem fornecedor».
 *   · Um rascunho/documento que JÁ aponta para um fornecedor entretanto inativo
 *     mantém o nome histórico (o nome vem do JOIN ao `Fornecedor`, sem filtrar o
 *     estado) e a UI assinala-o como inativo.
 *   · Um fornecedor inativo NÃO pode ser escolhido como novo valor de uma linha
 *     (o autosave recusa a mudança para um inativo; manter o valor que já lá
 *     está é permitido, para não impedir gravar outros campos).
 *   · A FINALIZAÇÃO recusa qualquer linha cujo fornecedor esteja inativo — o
 *     utilizador tem de o substituir. Nunca se troca silenciosamente.
 *
 * Só recebe um cliente/transacção e não importa nada do motor de finalização,
 * para poder ser usado por `lib/ingest/orders.ts` e por
 * `finalizar-multi-fornecedor.ts` sem dependências circulares.
 */
import type { Prisma, PrismaClient } from "@/generated/prisma/client";

type Db = Prisma.TransactionClient | PrismaClient;

/** Erro «há linhas sem fornecedor utilizável». */
export class LinhasSemFornecedorError extends Error {
  readonly produtoIdsSemFornecedor: string[];
  constructor(message: string, produtoIdsSemFornecedor: string[]) {
    super(message);
    this.name = "LinhasSemFornecedorError";
    this.produtoIdsSemFornecedor = produtoIdsSemFornecedor;
  }
}

/**
 * Linhas que apontam para um fornecedor inativo. Estende `LinhasSemFornecedorError`:
 * os mesmos tratadores (acções, consolidação, UI) destacam as linhas a substituir.
 */
export class FornecedorInativoError extends LinhasSemFornecedorError {
  readonly fornecedoresInativos: string[];
  constructor(message: string, produtoIds: string[], fornecedoresInativos: string[]) {
    super(message, produtoIds);
    this.name = "FornecedorInativoError";
    this.fornecedoresInativos = fornecedoresInativos;
  }
}

/** Ids (de entre `ids`) que existem e NÃO estão ativos, com o nome histórico. */
export async function fornecedoresInativosEntre(db: Db, ids: readonly string[]): Promise<Map<string, string>> {
  const unicos = [...new Set(ids.filter(Boolean))];
  if (unicos.length === 0) return new Map();
  const rows = await db.fornecedor.findMany({
    where: { id: { in: unicos }, estado: { not: "ATIVO" } },
    select: { id: true, nome: true, nomeNormalizado: true },
  });
  return new Map(rows.map((r) => [r.id, r.nome ?? r.nomeNormalizado]));
}

/** Finalização: recusa linhas cujo fornecedor está inativo (nunca substitui por outro). */
export async function exigirFornecedoresAtivos(
  db: Db,
  linhas: readonly { produtoId: string; fornecedorSugeridoId?: string | null }[]
): Promise<void> {
  const inativos = await fornecedoresInativosEntre(
    db,
    linhas.map((l) => l.fornecedorSugeridoId).filter((x): x is string => !!x)
  );
  if (inativos.size === 0) return;
  const afectadas = linhas.filter((l) => l.fornecedorSugeridoId && inativos.has(l.fornecedorSugeridoId));
  const nomes = [...new Set(afectadas.map((l) => inativos.get(l.fornecedorSugeridoId!)!))];
  throw new FornecedorInativoError(
    `${afectadas.length} linha(s) apontam para um fornecedor inativo (${nomes.join(", ")}) — substitua-o por um fornecedor ativo antes de finalizar.`,
    afectadas.map((l) => l.produtoId),
    nomes
  );
}

/**
 * Autosave: uma linha só pode MUDAR para um fornecedor ativo. `atuais` = o que a
 * linha já tinha gravado (por produto): repetir esse mesmo valor é permitido.
 */
export async function exigirNovoFornecedorAtivo(
  db: Db,
  pedidos: readonly { produtoId: string; fornecedorSugeridoId?: string | null }[],
  atuais: ReadonlyMap<string, string | null>
): Promise<void> {
  const novos = pedidos.filter(
    (p) => p.fornecedorSugeridoId && (atuais.get(p.produtoId) ?? null) !== p.fornecedorSugeridoId
  );
  if (novos.length === 0) return;
  const inativos = await fornecedoresInativosEntre(db, novos.map((p) => p.fornecedorSugeridoId!));
  const recusadas = novos.filter((p) => inativos.has(p.fornecedorSugeridoId!));
  if (recusadas.length === 0) return;
  const nomes = [...new Set(recusadas.map((p) => inativos.get(p.fornecedorSugeridoId!)!))];
  throw new FornecedorInativoError(
    `Não é possível escolher um fornecedor inativo (${nomes.join(", ")}).`,
    recusadas.map((p) => p.produtoId),
    nomes
  );
}
