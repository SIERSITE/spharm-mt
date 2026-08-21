/**
 * lib/catalog/reconciliar-importacao.ts
 *
 * O passo que faltava entre "o agent importou um CNP" e "o catálogo sabe
 * o que esse CNP é".
 *
 * ─────────────────────────────────────────────────────────────────────
 * O BURACO QUE ISTO FECHA
 *
 * Antes disto, um CNP novo entrava em `Produto` e ficava parado. Não era
 * consultado contra o catálogo global — mesmo quando outro tenant já
 * tinha pago a classificação do mesmo produto nacional — e não entrava
 * em fila nenhuma. A `EnriquecimentoFila` existia, tinha código que a
 * preenchia, e tinha ZERO linhas em produção: ninguém a escrevia no
 * caminho que importa.
 *
 * A consequência prática media-se: 15 260 CNPs no global, 15 370
 * elegíveis no tenant. Os 110 de diferença eram produtos classificados
 * numa corrida que nunca subiram, e o desvio crescia a cada corrida.
 *
 * ─────────────────────────────────────────────────────────────────────
 * AS DUAS METADES, E PORQUE SÃO SÍNCRONA E ASSÍNCRONA
 *
 *  1. CNP QUE O GLOBAL CONHECE → projecta JÁ, dentro do request.
 *     É um SELECT por lote e escritas guardadas; o produto nasce
 *     classificado e nunca chega a ser candidato a uma chamada ao
 *     modelo. É esta metade que cumpre "um tenant novo não volta a
 *     pagar o que já se sabe" e "não há enriquecimento duplicado por
 *     tenant" — a duplicação deixa de ser evitada por disciplina e
 *     passa a ser impossível, porque quando o residual for calculado
 *     estes produtos já não estão lá.
 *
 *  2. CNP DESCONHECIDO → entra na fila, e o modelo corre às 04:00.
 *     Deliberadamente NÃO é síncrono. Chamar o Claude dentro do request
 *     de importação punha latência e custo de API no caminho crítico, e
 *     uma indisponibilidade da API passava a fazer falhar a importação
 *     de stock — que não tem nada a ver com classificação.
 *
 * ─────────────────────────────────────────────────────────────────────
 * NUNCA DERRUBA A IMPORTAÇÃO
 *
 * O contrato do endpoint de products é ingerir catálogo e stock. Isto é
 * enriquecimento por cima. Todas as falhas aqui são registadas e
 * engolidas — a mesma política que o `applyErpCatalogFields` já segue no
 * mesmo endpoint. Um erro a projectar não pode fazer uma farmácia perder
 * o upload de stock do dia.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { projectarParaTenant } from "./global-catalog-store";
import { lerConhecimentoGlobal } from "./global-catalog-store";

export type ResumoReconciliacao = {
  /** CNPs considerados (os do lote que acabou de entrar). */
  candidatos: number;
  /** Quantos o catálogo global já conhecia. */
  conhecidosNoGlobal: number;
  /** Classificações escritas pela projecção. */
  classificacoesProjectadas: number;
  /** Utilizações escritas pela projecção. */
  utilizacoesProjectadas: number;
  /** CNPs desconhecidos que ficaram em fila para o ciclo das 04:00. */
  enfileirados: number;
  /** Já estavam em fila — a fila é idempotente por produto. */
  jaEmFila: number;
  /** Preenchido quando a reconciliação falhou sem derrubar a ingestão. */
  erro: string | null;
};

const VAZIO: ResumoReconciliacao = {
  candidatos: 0,
  conhecidosNoGlobal: 0,
  classificacoesProjectadas: 0,
  utilizacoesProjectadas: 0,
  enfileirados: 0,
  jaEmFila: 0,
  erro: null,
};

/**
 * Reconcilia um lote acabado de importar com o catálogo global.
 *
 * `cnps` são os do lote, não o catálogo todo: projectar o universo a
 * cada upload seria trabalho quadrático e a maior parte dele já estaria
 * feito da vez anterior.
 */
export async function reconciliarImportacaoComGlobal(
  prisma: PrismaClient,
  tenantSlug: string,
  cnps: readonly number[],
): Promise<ResumoReconciliacao> {
  if (cnps.length === 0) return { ...VAZIO };

  const unicos = [...new Set(cnps.filter((c) => Number.isInteger(c) && c > 0))];
  const r: ResumoReconciliacao = { ...VAZIO, candidatos: unicos.length };

  try {
    // ── 1. O que o global já sabe ──────────────────────────────────
    const global = await lerConhecimentoGlobal(unicos);
    r.conhecidosNoGlobal = global.size;

    if (global.size > 0) {
      // `dryRun: false` — esta é a escrita. As guardas de
      // não-degradação vivem dentro de `projectarParaTenant` e são as
      // mesmas do CLI: não toca em `validadoManualmente`, não sobrepõe
      // uma classificação específica local, não cria vocabulário.
      const proj = await projectarParaTenant(prisma, tenantSlug, {
        dryRun: false,
        cnps: unicos,
      });
      r.classificacoesProjectadas = proj.classificacoesEscritas;
      r.utilizacoesProjectadas = proj.utilizacoesEscritas;
    }

    // ── 2. Os que o global não conhece vão para a fila ─────────────
    //
    // Só estes. Um CNP que o global conhecia acabou de ser classificado
    // pela projecção e mandá-lo ao modelo seria pagar duas vezes pela
    // mesma resposta — que é exactamente o que este módulo existe para
    // impedir.
    const desconhecidos = unicos.filter((c) => !global.has(c));
    if (desconhecidos.length > 0) {
      const produtos = await prisma.produto.findMany({
        where: {
          cnp: { in: desconhecidos },
          estado: { not: "INATIVO" },
          // Um produto que já tem classificação específica não precisa
          // do modelo. Cai aqui o que o `applyErpCatalogFields` acabou
          // de classificar a partir do ERP, por exemplo.
          classificacaoNivel2Id: null,
        },
        select: { id: true },
      });

      if (produtos.length > 0) {
        // `createMany` + `skipDuplicates` em vez de upsert linha-a-linha:
        // a fila tem `@@unique([produtoId])`, portanto o skip é a
        // idempotência. Reimportar o mesmo ficheiro não duplica nada e
        // não repõe o estado de um produto que já falhou — quem decide
        // repescar FALHOU é o job, não a importação.
        const criados = await prisma.enriquecimentoFila.createMany({
          data: produtos.map((p) => ({
            produtoId: p.id,
            prioridade: "MEDIA" as const,
            estado: "PENDENTE" as const,
            ultimaFonte: "IMPORTACAO_AGENT",
          })),
          skipDuplicates: true,
        });
        r.enfileirados = criados.count;
        r.jaEmFila = produtos.length - criados.count;
      }
    }
  } catch (e) {
    r.erro = e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300);
  }

  return r;
}
