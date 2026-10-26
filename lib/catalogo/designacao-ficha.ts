/**
 * lib/catalogo/designacao-ficha.ts
 *
 * Correção MANUAL da designação de um produto, na ficha do artigo. A designação é do produto COMUM do tenant: a alteração vale
 * para todas as farmácias do grupo (o CNP identifica o produto; as farmácias partilham o mesmo `Produto`).
 *
 * ── Proteção contra a sincronização ──────────────────────────────────────────────────────────────────────────────────────
 * A proteção que a ingestão efetivamente consulta para a designação é `Produto.camposManuais ∋ "designacao"`:
 *   · `lib/ingest/bulk.ts` (upsert por lote)             — `CASE WHEN 'designacao' = ANY("camposManuais") THEN <atual>`;
 *   · `lib/ingest/designacao-silveira.ts`                 — `decidirDesignacao` (IGNORADA_MANUAL) e o UPDATE do passo leve;
 *   · `app/api/ingest/v1/bootstrap/products/route.ts`     — caminho de recurso (`manual.has("designacao")`).
 * Desde 2026-10 isto vale TAMBÉM para a farmácia Silveirense (antes era a única exceção). Esta proteção é INDEPENDENTE da do
 * fabricante (`validadoManualmente` + marcador `"fabricante"`): editar a designação não toca em `validadoManualmente` nem no
 * marcador do fabricante, e retirar a proteção da designação não retira nenhuma outra.
 *
 * ── O que a escrita faz e NÃO faz ────────────────────────────────────────────────────────────────────────────────────────
 * Atualiza `Produto.designacao`, acrescenta `"designacao"` a `camposManuais` e regista o AuditLog — na MESMA transação. Não
 * altera CNP, fabricante, DCI, dosagem, embalagem, forma, preços, stock nem os snapshots das farmácias (`ProdutoFarmacia`), não
 * cria nem funde produtos, e não reescreve documentos históricos (`designacaoSnapshot` em encomendas finalizadas/transferências).
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { normalizarDesignacao } from "@/lib/ingest/designacao-silveira";

export const MARCADOR_DESIGNACAO_MANUAL = "designacao";
export const ORIGEM_AUDITORIA_FICHA = "FICHA_ARTIGO";
/** Os mesmos limites da criação manual de produtos (`lib/produtos/criar-produto.ts`). */
export const DESIGNACAO_MIN = 3;
export const DESIGNACAO_MAX = 300;

export type ValidacaoDesignacao = { ok: true; valor: string } | { ok: false; mensagem: string };

/** Valida e normaliza (só espaços: trim + reduzir sequências) — capitalização, acentos e pontuação ficam como o utilizador escreveu. */
export function validarDesignacao(entrada: unknown): ValidacaoDesignacao {
  if (typeof entrada !== "string") return { ok: false, mensagem: "Designação obrigatória." };
  const valor = normalizarDesignacao(entrada);
  if (valor === null) return { ok: false, mensagem: "A designação é obrigatória (não pode ficar vazia nem só com espaços)." };
  if (valor.length < DESIGNACAO_MIN) return { ok: false, mensagem: `A designação tem de ter pelo menos ${DESIGNACAO_MIN} caracteres.` };
  if (valor.length > DESIGNACAO_MAX) return { ok: false, mensagem: `A designação não pode ter mais de ${DESIGNACAO_MAX} caracteres.` };
  return { ok: true, valor };
}

export type PedidoAplicarDesignacao = {
  cnp: number;
  /** Designação que o utilizador VIU na ficha: a alteração só se aplica se ainda for esta (concorrência otimista). */
  designacaoAnterior: string;
  nova: string;
  /** O utilizador confirmou no diálogo. Sem isto nada é escrito. */
  confirmado: boolean;
  ator: { id: string };
  tenant: string;
};

export type CodigoRecusaDesignacao = "nao_confirmado" | "sem_produto" | "invalida" | "conflito";

export type ResultadoAplicarDesignacao =
  | { ok: true; designacao: string; anterior: string; alterado: boolean; protegido: boolean }
  | { ok: false; codigo: CodigoRecusaDesignacao; mensagem: string };

class Recusa extends Error {
  constructor(public readonly resultado: Extract<ResultadoAplicarDesignacao, { ok: false }>) {
    super(resultado.mensagem);
  }
}

export async function aplicarDesignacaoFicha(prisma: PrismaClient, pedido: PedidoAplicarDesignacao): Promise<ResultadoAplicarDesignacao> {
  if (!pedido.confirmado) return { ok: false, codigo: "nao_confirmado", mensagem: "A alteração tem de ser confirmada." };
  const v = validarDesignacao(pedido.nova);
  if (!v.ok) return { ok: false, codigo: "invalida", mensagem: v.mensagem };
  try {
    return await prisma.$transaction(async (tx) => {
      const produto = await tx.produto.findUnique({
        where: { cnp: pedido.cnp },
        select: { id: true, cnp: true, designacao: true, camposManuais: true },
      });
      if (!produto) throw new Recusa({ ok: false, codigo: "sem_produto", mensagem: "Artigo não encontrado." });
      if (produto.designacao !== pedido.designacaoAnterior) {
        throw new Recusa({ ok: false, codigo: "conflito", mensagem: "A designação deste artigo mudou entretanto. Reabra a ficha e tente de novo." });
      }
      const jaProtegido = produto.camposManuais.includes(MARCADOR_DESIGNACAO_MANUAL);
      // Igual à atual (depois de normalizar espaços): não se escreve nem se audita — e a proteção não muda.
      if (normalizarDesignacao(produto.designacao) === v.valor) {
        return { ok: true as const, designacao: produto.designacao, anterior: produto.designacao, alterado: false, protegido: jaProtegido };
      }
      await tx.produto.update({
        where: { id: produto.id },
        data: {
          designacao: v.valor,
          // A proteção que a ingestão consulta para a designação. NÃO se toca em `validadoManualmente` (é a do fabricante).
          camposManuais: jaProtegido ? produto.camposManuais : [...produto.camposManuais, MARCADOR_DESIGNACAO_MANUAL],
          dataAtualizacao: new Date(),
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: pedido.ator.id,
          action: "produto.designacao.alterada",
          entity: "Produto",
          entityId: produto.id,
          metaJson: JSON.stringify({
            origem: ORIGEM_AUDITORIA_FICHA,
            tenant: pedido.tenant,
            produtoId: produto.id,
            cnp: produto.cnp,
            designacaoAnterior: produto.designacao,
            designacaoNova: v.valor,
            protecaoDesignacao: { antes: jaProtegido, depois: true },
          }),
        },
      });
      return { ok: true as const, designacao: v.valor, anterior: produto.designacao, alterado: true, protegido: true };
    });
  } catch (err) {
    if (err instanceof Recusa) return err.resultado;
    throw err;
  }
}

export type PedidoPermitirDesignacao = {
  cnp: number;
  confirmado: boolean;
  ator: { id: string };
  tenant: string;
};

export type ResultadoPermitirDesignacao =
  | { ok: true; designacao: string }
  | { ok: false; codigo: "nao_confirmado" | "sem_produto" | "sem_protecao"; mensagem: string };

/**
 * «Voltar a permitir atualização automática» da designação: retira SÓ `"designacao"` de `camposManuais`. O nome atual NÃO muda
 * agora (uma sincronização futura poderá substituí-lo); `validadoManualmente`, a proteção do fabricante e as dos restantes
 * campos ficam exatamente como estão. Auditado à parte (`produto.designacao.protecao_removida`).
 */
export async function permitirAtualizacaoDesignacao(prisma: PrismaClient, pedido: PedidoPermitirDesignacao): Promise<ResultadoPermitirDesignacao> {
  if (!pedido.confirmado) return { ok: false, codigo: "nao_confirmado", mensagem: "A alteração tem de ser confirmada." };
  return prisma.$transaction(async (tx): Promise<ResultadoPermitirDesignacao> => {
    const produto = await tx.produto.findUnique({
      where: { cnp: pedido.cnp },
      select: { id: true, cnp: true, designacao: true, camposManuais: true },
    });
    if (!produto) return { ok: false, codigo: "sem_produto", mensagem: "Artigo não encontrado." };
    if (!produto.camposManuais.includes(MARCADOR_DESIGNACAO_MANUAL)) {
      return { ok: false, codigo: "sem_protecao", mensagem: "A designação deste artigo não está protegida (não foi corrigida manualmente)." };
    }
    await tx.produto.update({
      where: { id: produto.id },
      data: {
        camposManuais: produto.camposManuais.filter((c) => c !== MARCADOR_DESIGNACAO_MANUAL),
        dataAtualizacao: new Date(),
      },
    });
    await tx.auditLog.create({
      data: {
        actorId: pedido.ator.id,
        action: "produto.designacao.protecao_removida",
        entity: "Produto",
        entityId: produto.id,
        metaJson: JSON.stringify({
          origem: ORIGEM_AUDITORIA_FICHA,
          tenant: pedido.tenant,
          produtoId: produto.id,
          cnp: produto.cnp,
          designacaoAnterior: produto.designacao,
          designacaoNova: produto.designacao,
          alterado: false,
          protecaoDesignacao: { antes: true, depois: false },
        }),
      },
    });
    return { ok: true, designacao: produto.designacao };
  });
}
