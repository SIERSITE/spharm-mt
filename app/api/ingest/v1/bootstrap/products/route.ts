/**
 * app/api/ingest/v1/bootstrap/products/route.ts
 *
 * POST /api/ingest/v1/bootstrap/products
 *
 * Recebe um batch de payloads canónicos de produto e faz upsert em:
 *   · `Produto` (catálogo — chaveado por `cnp`)
 *   · `ProdutoFarmacia` (per-farmacia — chaveado por `(produtoId, farmaciaId)`)
 *
 * Idempotência: reupload do mesmo batch actualiza in-place. Não apaga
 * dados existentes. Upsert additive — campos não-presentes no payload
 * NÃO são tocados (e.g. dci/codigoATC ficam intactos).
 *
 * Auth: withIntegrationAuth (Bearer + X-Tenant-Slug, padrão dos outros
 * endpoints /api/ingest/v1/*).
 *
 * Feature flag: ENABLE_AGENT_BOOTSTRAP=1 (lib/env.ts). Sem isto → 503.
 *
 * Body:
 *   {
 *     farmaciaId: string,
 *     items: ProductPayload[]    // até BOOTSTRAP_MAX_BATCH_SIZE
 *   }
 *
 * Response 200 sucesso:
 *   {
 *     ok: true,
 *     accepted: N,
 *     upserted: N,
 *     skipped: [{ index, reason, externalId? }],
 *     errors: [{ index, reason, externalId?, message }],
 *     durationMs: number
 *   }
 */

import { NextResponse } from "next/server";
import { withIntegrationAuth } from "@/lib/integracao/auth";
import {
  assertBootstrapEnabled,
  assertFarmaciaInTenant,
  parseBatchBody,
  isFailure,
  asIntOrNull,
  asDecimalOrNull,
  asStringOrNull,
  asBoolOrFalse,
  asIsoDateOrNull,
  type BootstrapBatchResponse,
} from "@/lib/ingest/bootstrap";
import { abrirOuContinuarCorrida } from "@/lib/ingest/produto-run";
import {
  contarDecisoes,
  normalizarDesignacao,
  resolverModoDesignacao,
  upsertProdutosComDesignacao,
  type EstatisticasDesignacao,
} from "@/lib/ingest/designacao-silveira";
import {
  bulkUpsertProdutoFarmaciaProducts,
  dedupeByKey,
  type ProdutoFarmaciaProductRow,
} from "@/lib/ingest/bulk";
import { normalizeIva } from "@/lib/iva";
import {
  aplicarClassificacaoErp,
  lerClassificacaoErpDoPayload,
  type ClassificacaoErpItem,
  type ClassificacaoErpLinha,
  type ResumoClassificacaoErp,
} from "@/lib/ingest/classificacao-erp";
import { applyErpCatalogFields } from "@/lib/ingest/catalog-from-erp";
import { applyFornecedorPreferencialSilveira } from "@/lib/ingest/fornecedor-preferencial-silveira";
import { TENANT_CATALOGO_MASSA } from "@/lib/tenant-context";
import {
  reconciliarImportacaoComGlobal,
  type ResumoReconciliacao,
} from "@/lib/catalog/reconciliar-importacao";
import type { ReconciliacaoGruposLaboratoriaisSummary } from "@/lib/catalog/reconciliar-grupos-laboratoriais-garantia";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type ProductPayload = {
  externalProductId: unknown;
  cnp: unknown;
  designacao: unknown;
  pvp: unknown;
  pmc: unknown;
  puc: unknown;
  dataUltimaVenda: unknown;
  dataUltimaCompra: unknown;
  retirado: unknown;
  generico: unknown;
  mnsrmNCompart: unknown;
  fornecedorHabitualId: unknown;
  fornecedorHabitualNome: unknown;
  /**
   * Taxa IVA do produto na tabela mestre `dbo.Stocks`. Capturada pelo
   * agent rev39+ via discovery dinâmica (`Stocks.[IVA]`, `[Codigo_IVA]`,
   * `[TaxaIVA]` — depende do quirk do SoftReis). Aceita fracção
   * (0.06/0.13/0.23) OU percentagem (6/13/23). Normaliza para {6,13,23,null}.
   * Quando o agent (≤ rev38) não envia, fica undefined → preserva o
   * existente em BD via COALESCE.
   */
  taxaIva: unknown;
  /**
   * rev46 — catálogo regulamentar lido do próprio ERP (DCI, ATC, Grupo
   * Homogéneo, Fabricante). O agent descobre as colunas em runtime; um
   * campo ausente na instalação chega como null e não escreve nada.
   * Agents ≤ rev45 não enviam de todo — os campos ficam undefined e o
   * catálogo mantém-se como está.
   */
  dci: unknown;
  codigoATC: unknown;
  grupoHomogeneo: unknown;
  fabricante: unknown;
};

export const POST = withIntegrationAuth(async (ctx, req) => {
  const t0 = Date.now();

  // 1. Feature flag
  const disabled = assertBootstrapEnabled();
  if (disabled) return disabled;

  // 2. Body
  const parsed = await parseBatchBody<ProductPayload>(req);
  if (isFailure(parsed)) return parsed.response;
  const { farmaciaId, items } = parsed;

  // 3. Farmácia existe no tenant
  const farmaciaErr = await assertFarmaciaInTenant(ctx.prisma, farmaciaId);
  if (farmaciaErr) return farmaciaErr;

  // 3a. Quem manda na designação (SÓ tenant silveira — ver
  // lib/ingest/designacao-silveira.ts). Nos outros tenants `modoDesignacao`
  // é "LEGACY" e nada abaixo muda. Se a configuração do tenant silveira
  // for inválida (ou a leitura falhar), o modo é SO_CRIACAO — ninguém
  // altera designações existentes — e o erro vai explícito na resposta.
  const { autoridade, modo: modoDesignacao } = await resolverModoDesignacao(
    ctx.prisma,
    ctx.tenant.slug,
    farmaciaId,
  );
  if (autoridade.aplica && !autoridade.valida) {
    console.error(
      `[bootstrap/products] designacao: configuração inválida (${autoridade.codigo}) — modo seguro, designações existentes não são alteradas`,
    );
  }

  // 3b. Fronteira da corrida, marcada pelo relógio da BASE.
  //
  // O agent também envia um `runStartedAt`, mas vem do relógio da máquina
  // da farmácia e não pode decidir o que é retirado: se estiver
  // adiantado, o sweep do /finalize apanha as linhas que esta mesma
  // corrida acabou de escrever. Aqui abre-se (ou continua-se) uma
  // corrida cujo `startedAtServer` é o único corte que o sweep usa.
  //
  // Nunca falha o batch: o upload dos produtos é o que interessa, e uma
  // falha a contabilizar a corrida só faz o /finalize recusar-se a
  // varrer — que é o lado seguro.
  try {
    await abrirOuContinuarCorrida(ctx.prisma, farmaciaId, items.length);
  } catch (err) {
    console.error("[bootstrap/products] run_tracking_failed", err);
  }

  console.log(
    `[bootstrap/products] start ${JSON.stringify({
      tenant: ctx.tenant.slug,
      farmaciaId,
      received: items.length,
    })}`
  );

  // 4. Upsert linha-a-linha. SEM `$transaction` wrapper: cada upsert
  // (Produto e ProdutoFarmacia) é internamente atómico via unique
  // constraints. Eliminar a transaction reduz ~50ms/item de overhead
  // BEGIN/COMMIT — significativo em batches grandes via Neon serverless.
  //
  // Edge case: se Produto upsert OK e ProdutoFarmacia upsert falha,
  // ficamos com Produto sem ProdutoFarmacia para esta farmácia. NÃO é
  // inconsistência — retry do batch refaz o ProdutoFarmacia (idempotente
  // via @@unique(produtoId, farmaciaId)). Reportado em `errors[]` para
  // diagnose.
  const skipped: BootstrapBatchResponse["skipped"] = [];
  const errors: BootstrapBatchResponse["errors"] = [];
  let upserted = 0;

  type Accepted = {
    index: number;
    cnp: number;
    externalProductId: number | null;
    designacao: string;
    flagGenerico: boolean;
    flagMnsrmNCompart: boolean;
    pvp: number | null;
    pmc: number | null;
    puc: number | null;
    dataUltimaVenda: Date | null;
    dataUltimaCompra: Date | null;
    flagRetirado: boolean;
    fornecedorExternalId: number | null;
    fornecedorOrigem: string | null;
    /** {6, 13, 23, null}. null se agent não enviou ou valor não-canónico. */
    taxaIvaPercent: number | null;
    dci: string | null;
    codigoATC: string | null;
    grupoHomogeneo: string | null;
    fabricante: string | null;
    classificacao: ClassificacaoErpItem;
  };

  // Contagens do enriquecimento a partir do ERP, declaradas aqui para
  // sobreviverem ao bloco try e chegarem à resposta.
  let produtosNovos = 0;
  let produtosAtualizados = 0;
  // Observabilidade da designação (só quando há regra: tenant silveira).
  let designacoesVazias = 0;
  let estatDesignacao: EstatisticasDesignacao | null = null;
  let catalogoErp: {
    candidatos: number;
    preenchidos: Record<string, number>;
    substituidos: Record<string, number>;
    preservados: Record<string, number>;
  } | null = null;
  let reconciliacaoGlobal: ResumoReconciliacao | null = null;
  let classificacaoErp: ResumoClassificacaoErp | null = null;
  // Grupo laboratorial pesquisável — exclusivo do tenant garantia (as
  // tabelas nem existem fisicamente nos outros tenants). Nunca escreve
  // Produto/Fabricante, nunca falha o ingest — ver lib/catalog/
  // reconciliar-grupos-laboratoriais-garantia.ts.
  let gruposLaboratoriais: ReconciliacaoGruposLaboratoriaisSummary | null = null;

  // 1) Validar/coercer. CNP é a chave canónica (Produto.cnp @unique);
  //    sem CNP o produto não entra no catálogo.
  const accepted: Accepted[] = [];
  for (let i = 0; i < items.length; i++) {
    const raw = items[i] ?? ({} as ProductPayload);
    const externalProductId = asIntOrNull(raw.externalProductId);
    const cnp = asIntOrNull(raw.cnp);
    const designacao = asStringOrNull(raw.designacao);
    if (cnp === null) {
      skipped.push({ index: i, reason: "missing_cnp", externalId: externalProductId ?? undefined });
      continue;
    }
    if (designacao === null) {
      designacoesVazias++;
      skipped.push({ index: i, reason: "missing_designacao", externalId: externalProductId ?? undefined });
      continue;
    }
    // IVA: agent ≤ rev38 não envia (undefined) → fica null e o pipeline
    // preserva o existente via COALESCE no bulk. rev39+ envia número
    // (fracção 0.06 ou percentagem 6) que normalizamos para {6,13,23,null}.
    const taxaIvaRaw = asDecimalOrNull(raw.taxaIva);
    const taxaIvaPercent = taxaIvaRaw === null ? null : (normalizeIva(taxaIvaRaw) ?? null);
    accepted.push({
      index: i,
      cnp,
      externalProductId,
      // Tenant silveira: o valor escrito é o do ERP só com os espaços
      // técnicos normalizados. Nos restantes, exactamente como sempre.
      designacao: modoDesignacao === "LEGACY" ? designacao : (normalizarDesignacao(designacao) ?? designacao),
      flagGenerico: asBoolOrFalse(raw.generico),
      flagMnsrmNCompart: asBoolOrFalse(raw.mnsrmNCompart),
      pvp: asDecimalOrNull(raw.pvp),
      pmc: asDecimalOrNull(raw.pmc),
      puc: asDecimalOrNull(raw.puc),
      dataUltimaVenda: asIsoDateOrNull(raw.dataUltimaVenda),
      dataUltimaCompra: asIsoDateOrNull(raw.dataUltimaCompra),
      flagRetirado: asBoolOrFalse(raw.retirado),
      fornecedorExternalId: asIntOrNull(raw.fornecedorHabitualId),
      fornecedorOrigem: asStringOrNull(raw.fornecedorHabitualNome),
      taxaIvaPercent,
      dci: asStringOrNull(raw.dci),
      codigoATC: asStringOrNull(raw.codigoATC),
      grupoHomogeneo: asStringOrNull(raw.grupoHomogeneo),
      fabricante: asStringOrNull(raw.fabricante),
      classificacao: lerClassificacaoErpDoPayload(raw as Record<string, unknown>),
    });
  }

  // Dedupe por cnp (last wins) — evita o ON CONFLICT recusar a mesma
  // chave duas vezes no bulk e iguala a semântica de upserts sequenciais.
  const dedup = dedupeByKey(accepted, (a) => String(a.cnp));

  // 2) Bulk: Produto por cnp (RETURNING id) → mapa cnp→id → ProdutoFarmacia.
  //    Update aditivo: campos fortes do catálogo (dci, codigoATC, etc.) e
  //    campos de stock NÃO são tocados. Fallback per-row se o bulk falhar.
  try {
    // Novos vs actualizados: o upsert não distingue, e a distinção é o que
    // mostra se uma farmácia está a trazer catálogo novo ou a reforçar o
    // que já existe. Contado ANTES do upsert, senão já não há diferença.
    const cnpsDoLote = dedup.map((a) => a.cnp);
    // Upsert do Produto com a regra da designação (tenant silveira) — ver
    // lib/ingest/designacao-silveira.ts. Em LEGACY (todos os outros tenants)
    // é o bulkUpsertProdutosByCnp de sempre.
    const up = await upsertProdutosComDesignacao(
      ctx.prisma,
      modoDesignacao,
      dedup.map((a) => ({
        cnp: a.cnp,
        externalProductId: a.externalProductId,
        designacao: a.designacao,
        flagGenerico: a.flagGenerico,
        flagMnsrmNCompart: a.flagMnsrmNCompart,
      })),
    );
    produtosAtualizados = up.existentes;
    produtosNovos = cnpsDoLote.length - produtosAtualizados;
    estatDesignacao = up.estatisticas;
    const cnpToId = up.cnpToId;

    // rev46 — o ERP da farmácia já conhece DCI, ATC, Grupo Homogéneo e
    // Fabricante. Corre DEPOIS do upsert do Produto, para que os produtos
    // criados agora também sejam enriquecidos na mesma passagem.
    //
    // Nunca substitui dados de confiança igual ou superior: a decisão está
    // em applyErpCatalogFields, que lê a proveniência existente do
    // RegulatoryRecord e do EnrichmentSourceLog. Uma falha aqui não pode
    // derrubar a ingestão de produtos e stock — é enriquecimento, não o
    // contrato do endpoint.
    try {
      const erp = await applyErpCatalogFields(
        ctx.prisma,
        dedup.map((a) => ({
          cnp: a.cnp,
          dci: a.dci,
          codigoATC: a.codigoATC,
          grupoHomogeneo: a.grupoHomogeneo,
          fabricante: a.fabricante,
        })),
        farmaciaId,
        { modoNuncaReescreverFabricante: ctx.tenant.slug === TENANT_CATALOGO_MASSA },
      );
      const escritos =
        Object.values(erp.preenchidos).reduce((x, y) => x + y, 0) +
        Object.values(erp.substituidos).reduce((x, y) => x + y, 0);
      catalogoErp = erp;
      if (escritos > 0 || erp.candidatos > 0) {
        console.log(
          `[bootstrap/products] catálogo ERP: ${erp.candidatos} candidatos, ` +
            `${escritos} campos escritos, ` +
            `${Object.values(erp.preservados).reduce((x, y) => x + y, 0)} preservados por fonte mais forte`,
        );
      }
    } catch (err) {
      console.error(
        "[bootstrap/products] enriquecimento a partir do ERP falhou (ingestão continua):",
        err instanceof Error ? err.message : err,
      );
    }

    // Genérico tri-estado do ERP (PROVISÓRIO). Um único UPDATE
    // idempotente (IS DISTINCT FROM) SÓ com os campos que o agent enviou;
    // não toca designação nem fabricante. Uma falha aqui não derruba o lote
    // (o reenvio refaz-a, é idempotente) e fica explícita na resposta.
    classificacaoErp = await aplicarClassificacaoSegura(
      ctx.prisma,
      dedup.flatMap((a) => {
        const produtoId = cnpToId.get(a.cnp);
        return produtoId ? [{ produtoId, item: a.classificacao }] : [];
      }),
    );

    // Fornecedor preferencial (ProdutoFarmacia.fornecedorHabitualId) —
    // EXCLUSIVO do tenant silveira. O gate é validado ANTES de qualquer
    // query/escrita específica desta funcionalidade — nas restantes
    // tenants este bloco nem chega a correr, e o comportamento de
    // ingestão fica idêntico ao anterior a esta funcionalidade. Mesma
    // política de erro dos blocos de enriquecimento acima: nunca pode
    // fazer a farmácia perder o upload de stock do dia.
    if (ctx.tenant.slug === TENANT_CATALOGO_MASSA) {
      try {
        const fornecedorPref = await applyFornecedorPreferencialSilveira(
          ctx.prisma,
          dedup.map((a) => ({ cnp: a.cnp, fornecedorNome: a.fornecedorOrigem })),
          farmaciaId,
          cnpToId,
        );
        if (fornecedorPref.candidatos > 0) {
          console.log(
            `[bootstrap/products] fornecedor preferencial (silveira): ${fornecedorPref.candidatos} candidatos, ` +
              `${fornecedorPref.preenchidos} preenchidos, ${fornecedorPref.preservados} preservados, ` +
              `${fornecedorPref.ambiguos} ambíguos, ${fornecedorPref.cnpNaoEncontrado} sem produto`,
          );
        }
      } catch (err) {
        console.error(
          "[bootstrap/products] fornecedor preferencial (silveira) falhou (ingestão continua):",
          err instanceof Error ? err.message : err,
        );
      }
    }

    // Catálogo global: o CNP que já se conhece é projectado AGORA, e o
    // desconhecido entra em fila para o ciclo das 04:00. Corre depois do
    // upsert e depois do enriquecimento ERP, de propósito — o ERP pode
    // ter acabado de classificar um produto, e nesse caso ele já não
    // precisa de ir à fila.
    //
    // Mesma política de erro do bloco acima: isto é enriquecimento por
    // cima do contrato do endpoint, e uma falha aqui não pode fazer a
    // farmácia perder o upload de stock do dia.
    try {
      reconciliacaoGlobal = await reconciliarImportacaoComGlobal(
        ctx.prisma,
        ctx.tenant.slug,
        dedup.map((a) => a.cnp),
      );
      const rg = reconciliacaoGlobal;
      if (rg.conhecidosNoGlobal > 0 || rg.enfileirados > 0) {
        console.log(
          `[bootstrap/products] catálogo global: ${rg.conhecidosNoGlobal}/${rg.candidatos} conhecidos, ` +
            `${rg.classificacoesProjectadas} classificações projectadas, ` +
            `${rg.utilizacoesProjectadas} utilizações, ` +
            `${rg.enfileirados} enfileirados (${rg.jaEmFila} já em fila)`,
        );
      }
      if (rg.erro) {
        console.error(`[bootstrap/products] reconciliação com o global falhou: ${rg.erro}`);
      }
    } catch (err) {
      console.error(
        "[bootstrap/products] reconciliação com o global falhou (ingestão continua):",
        err instanceof Error ? err.message : err,
      );
    }

    // Grupo laboratorial pesquisável — corre DEPOIS de applyErpCatalogFields
    // (que pode ter acabado de escrever Produto.fabricanteId) e é, tal como
    // os dois blocos anteriores, enriquecimento por cima do contrato do
    // endpoint: uma falha aqui nunca pode fazer a farmácia perder o upload.
    if (ctx.tenant.slug === "garantia") {
      try {
        const { reconciliarGruposLaboratoriaisGarantia } = await import("@/lib/catalog/reconciliar-grupos-laboratoriais-garantia");
        gruposLaboratoriais = await reconciliarGruposLaboratoriaisGarantia(ctx.prisma, ctx.tenant.slug, {
          tipo: "produtos",
          produtoIds: [...cnpToId.values()],
        });
      } catch (err) {
        console.error(
          "[bootstrap/products] classificação de grupos laboratoriais falhou (ingestão continua):",
          err instanceof Error ? err.message : err,
        );
      }
    }

    const pfRows: ProdutoFarmaciaProductRow[] = [];
    for (const a of dedup) {
      const produtoId = cnpToId.get(a.cnp);
      if (!produtoId) continue;
      pfRows.push({
        produtoId,
        farmaciaId,
        externalProductId: a.externalProductId,
        pvp: a.pvp,
        pmc: a.pmc,
        puc: a.puc,
        dataUltimaVenda: a.dataUltimaVenda,
        dataUltimaCompra: a.dataUltimaCompra,
        flagRetirado: a.flagRetirado,
        fornecedorExternalId: a.fornecedorExternalId,
        fornecedorOrigem: a.fornecedorOrigem,
        taxaIvaPercent: a.taxaIvaPercent,
      });
    }
    await bulkUpsertProdutoFarmaciaProducts(ctx.prisma, pfRows);
    upserted = dedup.length;
  } catch (bulkErr) {
    console.warn(
      `[bootstrap/products] bulk_failed_fallback_per_row ${JSON.stringify({
        tenant: ctx.tenant.slug,
        farmaciaId,
        rows: dedup.length,
        message: (bulkErr instanceof Error ? bulkErr.message : String(bulkErr)).slice(0, 200),
      })}`
    );
    upserted = 0;
    const produtoIdsFallback: string[] = [];
    const classificacaoFallback: ClassificacaoErpLinha[] = [];
    for (const a of dedup) {
      try {
        // O caminho de recurso tem de aplicar as MESMAS proteccoes do
        // bulk. Se so' o bulk as tivesse, uma falha transitoria — que e'
        // exactamente quando este ramo corre — apagava silenciosamente
        // a designacao escrita a mao, e ninguem ligaria as duas coisas.
        //
        // Aqui nao ha `ON CONFLICT` com acesso a linha existente, por
        // isso le-se primeiro. E' uma consulta por linha, mas este ramo
        // ja' e' o lento por definicao.
        const existente = await ctx.prisma.produto.findUnique({
          where: { cnp: a.cnp },
          select: { camposManuais: true, designacao: true, origemDados: true, primeiraFarmaciaEm: true },
        });
        const manual = new Set(existente?.camposManuais ?? []);
        const designacaoNova = a.designacao.trim();
        const produto = await ctx.prisma.produto.upsert({
          where: { cnp: a.cnp },
          create: {
            cnp: a.cnp,
            externalProductId: a.externalProductId ?? null,
            designacao: a.designacao,
            flagGenerico: a.flagGenerico,
            flagMnsrmNCompart: a.flagMnsrmNCompart,
            origemDados: "FARMACIA",
          },
          update: {
            externalProductId: a.externalProductId ?? undefined,
            // `undefined` no Prisma significa "nao mexer" — e' assim que
            // se preserva sem precisar de um segundo caminho de escrita.
            // SO_CRIACAO (tenant silveira, farmácia não autoritativa): num
            // produto existente a designação nunca é tocada.
            designacao:
              modoDesignacao === "SO_CRIACAO" ||
              manual.has("designacao") ||
              designacaoNova === ""
                ? undefined
                : a.designacao,
            flagGenerico: manual.has("flagGenerico") ? undefined : a.flagGenerico,
            flagMnsrmNCompart: manual.has("flagMnsrmNCompart")
              ? undefined
              : a.flagMnsrmNCompart,
            primeiraFarmaciaEm:
              existente?.origemDados === "MANUAL" && existente.primeiraFarmaciaEm === null
                ? new Date()
                : undefined,
          },
        });
        await ctx.prisma.produtoFarmacia.upsert({
          where: { produtoId_farmaciaId: { produtoId: produto.id, farmaciaId } },
          create: {
            produtoId: produto.id,
            farmaciaId,
            externalProductId: a.externalProductId ?? null,
            pvp: a.pvp ?? null,
            pmc: a.pmc ?? null,
            puc: a.puc ?? null,
            dataUltimaVenda: a.dataUltimaVenda,
            dataUltimaCompra: a.dataUltimaCompra,
            flagRetirado: a.flagRetirado,
            fornecedorExternalId: a.fornecedorExternalId ?? null,
            fornecedorOrigem: a.fornecedorOrigem ?? null,
            ...(a.taxaIvaPercent !== null
              ? {
                  taxaIvaPercent: a.taxaIvaPercent,
                  taxaIvaSource: "STOCKS_MESTRE",
                  taxaIvaUpdatedAt: new Date(),
                }
              : {}),
          },
          update: {
            externalProductId: a.externalProductId ?? undefined,
            pvp: a.pvp ?? undefined,
            pmc: a.pmc ?? undefined,
            puc: a.puc ?? undefined,
            dataUltimaVenda: a.dataUltimaVenda ?? undefined,
            dataUltimaCompra: a.dataUltimaCompra ?? undefined,
            flagRetirado: a.flagRetirado,
            fornecedorExternalId: a.fornecedorExternalId ?? undefined,
            fornecedorOrigem: a.fornecedorOrigem ?? undefined,
            // IVA: rev39+ → sobrescreve com source mestre. rev≤38 → null.
            ...(a.taxaIvaPercent !== null
              ? {
                  taxaIvaPercent: a.taxaIvaPercent,
                  taxaIvaSource: "STOCKS_MESTRE",
                  taxaIvaUpdatedAt: new Date(),
                }
              : {}),
          },
        });
        upserted++;
        produtoIdsFallback.push(produto.id);
        classificacaoFallback.push({ produtoId: produto.id, item: a.classificacao });
      } catch (err) {
        if (estatDesignacao) estatDesignacao.erros++;
        errors.push({
          index: a.index,
          reason: "upsert_failed",
          externalId: a.externalProductId ?? undefined,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Classificação ERP no caminho de recurso: mesmo UPDATE idempotente.
    classificacaoErp = await aplicarClassificacaoSegura(ctx.prisma, classificacaoFallback);

    // Mesmo passo do caminho bulk (ver acima) — o caminho de recurso
    // também escreve Produto/ProdutoFarmacia e merece a mesma manutenção.
    if (ctx.tenant.slug === "garantia") {
      try {
        const { reconciliarGruposLaboratoriaisGarantia } = await import("@/lib/catalog/reconciliar-grupos-laboratoriais-garantia");
        gruposLaboratoriais = await reconciliarGruposLaboratoriaisGarantia(ctx.prisma, ctx.tenant.slug, {
          tipo: "produtos",
          produtoIds: produtoIdsFallback,
        });
      } catch (err) {
        console.error(
          "[bootstrap/products] classificação de grupos laboratoriais falhou no caminho de recurso (ingestão continua):",
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  const durationMs = Date.now() - t0;
  console.log(
    `[bootstrap/products] done ${JSON.stringify({
      tenant: ctx.tenant.slug,
      farmaciaId,
      received: items.length,
      upserted,
      skipped: skipped.length,
      errors: errors.length,
      durationMs,
    })}`
  );
  for (const e of errors.slice(0, 10)) {
    console.warn(`[bootstrap/products] item_error ${JSON.stringify({
      tenant: ctx.tenant.slug,
      index: e.index,
      externalId: e.externalId,
      reason: e.reason,
      message: e.message.slice(0, 200),
    })}`);
  }

  const response: BootstrapBatchResponse = {
    ok: true,
    accepted: items.length,
    upserted,
    skipped,
    errors,
    durationMs,
  };
  // rev46 — contagens do enriquecimento a partir do ERP, para o técnico
  // ver no ecrã do agent quantos campos entraram, sem ir à base de dados.
  // Campo extra e opcional: agents antigos ignoram-no.
  // `catalogoGlobal` diz ao técnico, no ecrã do agent, quantos produtos
  // nasceram já classificados por o catálogo nacional os conhecer e
  // quantos ficaram em fila. Sem isto, a diferença entre "o pipeline
  // correu e não havia nada a fazer" e "o pipeline não correu" só se via
  // indo à base. Campo extra e opcional: agents antigos ignoram-no.
  // Designações (tenant silveira): contagens apenas — nunca payloads nem
  // designações completas nos logs/resposta.
  let designacoes: Record<string, unknown> | null = null;
  if (autoridade.aplica) {
    const est: EstatisticasDesignacao = estatDesignacao ?? contarDecisoes(modoDesignacao, []);
    est.ignoradasVazias += designacoesVazias;
    designacoes = {
      modo: modoDesignacao,
      ...est,
      ...(autoridade.valida ? {} : { erroConfiguracao: { codigo: autoridade.codigo, mensagem: autoridade.mensagem } }),
    };
    console.log(
      `[bootstrap/products] designacao ${JSON.stringify({ tenant: ctx.tenant.slug, farmaciaId, ...designacoes, erroConfiguracao: undefined, erroConfiguracaoCodigo: autoridade.valida ? undefined : autoridade.codigo })}`,
    );
  }
  return NextResponse.json({
    ...response,
    produtosNovos,
    produtosAtualizados,
    ...(designacoes ? { designacoes } : {}),
    ...(catalogoErp ? { catalogoErp } : {}),
    ...(classificacaoErp && (classificacaoErp.candidatos > 0 || classificacaoErp.erro) ? { classificacaoErp } : {}),
    ...(reconciliacaoGlobal ? { catalogoGlobal: reconciliacaoGlobal } : {}),
    ...(gruposLaboratoriais ? { gruposLaboratoriais } : {}),
  });
});
/** Nunca lança: a classificação é enriquecimento por cima do contrato do endpoint. */
async function aplicarClassificacaoSegura(
  prisma: Parameters<typeof aplicarClassificacaoErp>[0],
  linhas: ClassificacaoErpLinha[],
): Promise<ResumoClassificacaoErp> {
  try {
    const r = await aplicarClassificacaoErp(prisma, linhas);
    if (r.candidatos > 0) {
      console.log(
        `[bootstrap/products] classificação ERP: ${r.candidatos} candidatos, ${r.alterados} alterados, ` +
          `${r.valoresDesconhecidos} valores desconhecidos`,
      );
    }
    return r;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[bootstrap/products] classificação ERP falhou (ingestão continua):", msg);
    return {
      candidatos: linhas.filter((l) => "genericoErp" in l.item).length,
      alterados: 0,
      valoresDesconhecidos: 0,
      erro: msg.slice(0, 300),
    };
  }
}
