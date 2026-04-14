/**
 * lib/catalog-persistence.ts
 *
 * Camada de persistência do pipeline de enriquecimento SPharm.MT.
 *
 * Responsabilidades:
 *   - Filtrar campos por relevância do tipo de produto
 *   - Aplicar limiares de confiança antes de gravar
 *   - Nunca sobrescrever campos já preenchidos
 *   - Nunca sobrescrever campos de produtos validados manualmente
 *     (excepto com confiança >= THRESHOLD_AUTO)
 *   - Gravar metadados de verificação no Produto
 *   - Registar histórico de verificação (ProdutoVerificacaoHistorico)
 *
 * Limiares:
 *   confidence >= 0.90  → ENRIQUECIDO_AUTOMATICAMENTE
 *   confidence >= 0.75  → PARCIALMENTE_ENRIQUECIDO
 *   confidence <  0.75  → sem persistência de campos de catálogo
 *   (metadados de verificação são sempre gravados, independentemente)
 *
 * REGRAS DE BLOQUEIO (inviolav.)
 *   1. validadoManualmente === true → NUNCA actualiza campos de catálogo.
 *      Sem excepção por confiança. Apenas os metadados de verificação
 *      (productType, verificationStatus, lastVerifiedAt…) são gravados.
 *   2. Campos com valor não-null na BD → NUNCA são sobrescritos.
 *      O pipeline só preenche campos em falta.
 *   3. Campos irrelevantes para o productType → NUNCA são gravados,
 *      mesmo que o ResolvedProduct traga o valor (double-check defensivo).
 *   4. Em caso de conflito detectado (resolved.verificationStatus === NEEDS_REVIEW),
 *      só se persistem campos sem conflito — mas como o resolver já só devolve
 *      o valor vencedor, a regra manifesta-se via FilaRevisao criada no orquestrador.
 */

import { legacyPrisma as prisma } from "@/lib/prisma";
import type {
  PersistenceInput,
  PersistenceResult,
  ResolvedField,
  SourceTier,
} from "./catalog-types";
import { getFieldRelevance } from "./catalog-classifier";
import {
  normalizeManufacturerName,
  normalizePrincipioAtivo,
  normalizeATC,
  normalizeDosagem,
  normalizeEmbalagem,
  normalizeFormaFarmaceutica,
  normalizeImageUrl,
} from "./catalog-normalizers";
import { resolveClassificationIdsFromCategory } from "./catalog-classification";
import { mapToCanonical } from "./catalog-taxonomy-map";

const THRESHOLD_AUTO    = 0.90;
const THRESHOLD_PARTIAL = 0.75;

/**
 * Tiers que podem legitimamente escrever campos autoritários do catálogo.
 * Defesa em profundidade: o resolver já filtra por `allowedTiers`, mas esta
 * verificação secundária garante que, mesmo em caso de bug no resolver,
 * a persistência nunca grava fabricante/DCI/ATC a partir de fontes de
 * baixa autoridade (como o conector interno que lê fornecedores habituais).
 */
const AUTHORITATIVE_TIERS: readonly SourceTier[] = ["REGULATORY", "MANUFACTURER"];
const AUTHORITATIVE_FIELDS = new Set(["fabricante", "dci", "codigoATC"]);

// ─── Fabricante ───────────────────────────────────────────────────────────────

/**
 * Devolve o ID de um Fabricante pelo nome normalizado.
 * Cria se não existir. Garante FabricanteAlias quando o nome original
 * difere do nome normalizado.
 *
 * Resolução:
 *   1. Match exacto por nomeNormalizado
 *   2. Match por FabricanteAlias.aliasNome
 *   3. Criação de novo Fabricante
 */
export async function getOrCreateFabricante(
  normalizedName: string,
  aliasName?: string | null
): Promise<string> {
  const byNome = await prisma.fabricante.findUnique({
    where: { nomeNormalizado: normalizedName },
    select: { id: true },
  });

  if (byNome) {
    if (aliasName && aliasName !== normalizedName) {
      await prisma.fabricanteAlias
        .upsert({
          where: { fabricanteId_aliasNome: { fabricanteId: byNome.id, aliasNome: aliasName } },
          create: { fabricanteId: byNome.id, aliasNome: aliasName },
          update: {},
        })
        .catch(() => {});
    }
    return byNome.id;
  }

  if (aliasName) {
    const byAlias = await prisma.fabricanteAlias.findFirst({
      where: { aliasNome: aliasName },
      select: { fabricanteId: true },
    });
    if (byAlias) return byAlias.fabricanteId;
  }

  const created = await prisma.fabricante.create({
    data: {
      nomeNormalizado: normalizedName,
      estado: "ATIVO",
      ...(aliasName && aliasName !== normalizedName
        ? { aliases: { create: { aliasNome: aliasName } } }
        : {}),
    },
    select: { id: true },
  });

  return created.id;
}

// ─── Persistência principal ───────────────────────────────────────────────────

/**
 * Persiste o resultado resolvido no Produto central.
 *
 * Aplica três filtros antes de actualizar cada campo de catálogo:
 *   1. Relevância — o campo faz sentido para este tipo de produto?
 *      (já incorporada no ResolvedProduct: campos irrelevantes são null)
 *   2. Preenchimento — só actualiza campos ainda null na BD.
 *   3. Confiança — o campo resolvido tem confiança >= THRESHOLD_PARTIAL?
 *      (+ regra extra: validadoManualmente exige confiança >= THRESHOLD_AUTO)
 *
 * Os metadados de verificação (productType, verificationStatus, etc.)
 * são sempre gravados, independentemente dos limiares de confiança.
 */
export async function persistResolvedProduct(
  input: PersistenceInput
): Promise<PersistenceResult> {
  const { productId, resolved, dryRun = false } = input;

  const product = await prisma.produto.findUnique({
    where: { id: productId },
    select: {
      designacao: true,
      validadoManualmente: true,
      fabricanteId: true,
      codigoATC: true,
      dci: true,
      imagemUrl: true,
      formaFarmaceutica: true,
      dosagem: true,
      embalagem: true,
      classificacaoNivel1Id: true,
      classificacaoNivel2Id: true,
    },
  });

  if (!product) throw new Error(`Produto ${productId} não encontrado`);

  // Double-check de relevância: mesmo que o resolver tenha errado e devolvido
  // um valor irrelevante, bloqueamos aqui.
  const relevance = getFieldRelevance(resolved.productType);

  /**
   * Um campo de catálogo pode ser actualizado APENAS se:
   *   a) o campo resolvido existir
   *   b) o campo for relevante para o productType (double-check)
   *   c) a confiança for >= THRESHOLD_PARTIAL
   *   d) o campo estiver null na BD (nunca sobrescrever)
   *   e) o produto NÃO estiver validado manualmente (regra absoluta)
   *   f) para campos autoritários (fabricante/dci/atc), a fonte tem de ser
   *      de tier autoritário (REGULATORY ou MANUFACTURER) — defesa dupla
   *      sobre o resolver.
   */
  function canUpdate(
    fieldName: string,
    currentValue: unknown,
    field: ResolvedField<string> | null,
    isRelevant: boolean
  ): boolean {
    if (product!.validadoManualmente) return false;            // regra 1
    if (currentValue !== null && currentValue !== undefined) return false; // regra 2
    if (!isRelevant) return false;                              // regra 3
    if (!field) return false;
    if (field.confidence < THRESHOLD_PARTIAL) return false;
    // regra 4: defesa de tier para campos autoritários
    if (AUTHORITATIVE_FIELDS.has(fieldName) && !AUTHORITATIVE_TIERS.includes(field.tier)) {
      console.warn(
        `[persistence] BLOQUEADO: ${fieldName} recusado por tier "${field.tier}" ` +
        `(fonte="${field.source}"). Só ${AUTHORITATIVE_TIERS.join("/")} podem escrever este campo.`
      );
      return false;
    }
    return true;
  }

  const updates: Record<string, unknown> = {};
  const fieldsUpdated: string[] = [];

  // Fabricante — campo autoritário, só REGULATORY/MANUFACTURER
  if (canUpdate("fabricante", product.fabricanteId, resolved.fabricante, relevance.fabricante)) {
    const raw = resolved.fabricante!.value;
    const normalized = normalizeManufacturerName(raw);
    if (normalized) {
      if (!dryRun) {
        const id = await getOrCreateFabricante(normalized, raw !== normalized ? raw : null);
        updates.fabricanteId = id;
      }
      fieldsUpdated.push("fabricanteId");
    }
  }

  // DCI — campo autoritário, só REGULATORY/MANUFACTURER
  if (canUpdate("dci", product.dci, resolved.dci, relevance.dci)) {
    const normalized = normalizePrincipioAtivo(resolved.dci!.value);
    if (normalized) {
      updates.dci = normalized;
      fieldsUpdated.push("dci");
    }
  }

  // ATC — campo autoritário, só REGULATORY/MANUFACTURER
  if (canUpdate("codigoATC", product.codigoATC, resolved.codigoATC, relevance.atc)) {
    const normalized = normalizeATC(resolved.codigoATC!.value);
    if (normalized) {
      updates.codigoATC = normalized;
      fieldsUpdated.push("codigoATC");
    }
  }

  // Forma farmacêutica / apresentação
  if (canUpdate("formaFarmaceutica", product.formaFarmaceutica, resolved.formaFarmaceutica, relevance.formaFarmaceutica)) {
    const normalized = normalizeFormaFarmaceutica(resolved.formaFarmaceutica!.value);
    if (normalized) {
      updates.formaFarmaceutica = normalized;
      fieldsUpdated.push("formaFarmaceutica");
    }
  }

  // Dosagem
  if (canUpdate("dosagem", product.dosagem, resolved.dosagem, relevance.dosagem)) {
    const normalized = normalizeDosagem(resolved.dosagem!.value);
    if (normalized) {
      updates.dosagem = normalized;
      fieldsUpdated.push("dosagem");
    }
  }

  // Embalagem
  if (canUpdate("embalagem", product.embalagem, resolved.embalagem, relevance.embalagem)) {
    const normalized = normalizeEmbalagem(resolved.embalagem!.value);
    if (normalized) {
      updates.embalagem = normalized;
      fieldsUpdated.push("embalagem");
    }
  }

  // Imagem URL — exige confiança alta (risco de imagem errada)
  if (
    canUpdate("imagemUrl", product.imagemUrl, resolved.imagemUrl, relevance.imagemUrl) &&
    (resolved.imagemUrl?.confidence ?? 0) >= THRESHOLD_AUTO
  ) {
    const normalized = normalizeImageUrl(resolved.imagemUrl!.value);
    if (normalized) {
      updates.imagemUrl = normalized;
      fieldsUpdated.push("imagemUrl");
    }
  }

  // Classificação — passa SEMPRE pelo mapper canónico
  //
  // Regra: nenhuma categoria livre vinda de fontes externas pode ser gravada.
  // O mapper (lib/catalog-taxonomy-map.ts) recebe todos os sinais disponíveis
  // (productType, designação, ATC, categoria externa) e devolve uma combinação
  // (nivel1, nivel2) dentro da taxonomia canónica de lib/catalog-taxonomy.ts.
  //
  // - Mapping real (não-fallback) com confidence >= THRESHOLD_PARTIAL
  //   → grava normalmente e conta em fieldsUpdated (afecta o estado do produto).
  // - Mapping em fallback (Em Revisão / Por Classificar)
  //   → grava também, para rastreabilidade e métrica de "não classificado",
  //     mas NÃO conta em fieldsUpdated (não promove o produto a enriquecido).
  if (
    !product.classificacaoNivel1Id &&
    !product.validadoManualmente &&
    relevance.categoria &&
    !dryRun
  ) {
    const canonical = mapToCanonical({
      productType: resolved.productType,
      productTypeConfidence: resolved.productTypeConfidence,
      externalCategory: resolved.categoria?.value ?? null,
      externalSubcategory: resolved.subcategoria?.value ?? null,
      designacao: product.designacao,
      atc: resolved.codigoATC?.value ?? product.codigoATC ?? null,
    });

    const shouldWrite =
      !canonical.isFallback && canonical.confidence >= THRESHOLD_PARTIAL;
    const shouldWriteAsFallback = canonical.isFallback;

    if (shouldWrite || shouldWriteAsFallback) {
      const res = await resolveClassificationIdsFromCategory(canonical.nivel1, canonical.nivel2);
      if (res.nivel1Id) {
        updates.classificacaoNivel1Id = res.nivel1Id;
        if (shouldWrite) fieldsUpdated.push("classificacaoNivel1Id");
      }
      if (res.nivel2Id && !product.classificacaoNivel2Id) {
        updates.classificacaoNivel2Id = res.nivel2Id;
        if (shouldWrite) fieldsUpdated.push("classificacaoNivel2Id");
      }
      if (shouldWriteAsFallback) {
        console.log(
          `[persistence] classificação canónica: ${canonical.nivel1} / ${canonical.nivel2} ` +
          `(fallback=${canonical.method}, conf=${canonical.confidence.toFixed(2)})`
        );
      }
    }
  }

  // Estado resultante do produto
  const maxConf = fieldsUpdated.length > 0
    ? Math.max(...[
        resolved.fabricante?.confidence,
        resolved.dci?.confidence,
        resolved.codigoATC?.confidence,
        resolved.formaFarmaceutica?.confidence,
        resolved.dosagem?.confidence,
        resolved.embalagem?.confidence,
        resolved.imagemUrl?.confidence,
        resolved.categoria?.confidence,
      ].filter((c): c is number => c !== undefined && c !== null))
    : 0;

  const produtoEstado = fieldsUpdated.length === 0
    ? "PENDENTE"
    : maxConf >= THRESHOLD_AUTO
    ? "ENRIQUECIDO_AUTOMATICAMENTE"
    : "PARCIALMENTE_ENRIQUECIDO";

  if (dryRun) {
    console.log(
      `  [dry-run] ${productId} [${resolved.productType} ${(resolved.productTypeConfidence * 100).toFixed(0)}%]:`
    );
    console.log(`    Campos: ${fieldsUpdated.join(", ") || "nenhum"}`);
    console.log(`    Verificação: ${resolved.verificationStatus} | Estado: ${produtoEstado}`);
    return { fieldsUpdated, produtoEstado };
  }

  // Gravar campos de catálogo + metadados de verificação numa única operação
  await prisma.produto.update({
    where: { id: productId },
    data: {
      ...(updates as object),
      estado: produtoEstado as Parameters<typeof prisma.produto.update>[0]["data"]["estado"],
      origemDados: "ENRIQUECIMENTO",
      // Metadados de verificação (sempre gravados)
      productType: resolved.productType,
      productTypeConfidence: resolved.productTypeConfidence,
      classificationSource: resolved.classificationSource,
      classificationVersion: resolved.classificationVersion,
      verificationStatus: resolved.verificationStatus as Parameters<
        typeof prisma.produto.update
      >[0]["data"]["verificationStatus"],
      lastVerifiedAt: resolved.lastVerifiedAt,
      lastVerificationAttemptAt: resolved.lastVerifiedAt,
      externallyVerified: resolved.externallyVerified,
      needsManualReview: resolved.needsManualReview,
      manualReviewReason: resolved.manualReviewReason,
    },
  });

  // Histórico de verificação — não crítico, falha silenciosa
  try {
    await prisma.produtoVerificacaoHistorico.create({
      data: {
        produtoId: productId,
        productType: resolved.productType,
        productTypeConf: resolved.productTypeConfidence,
        verificationStatus: resolved.verificationStatus,
        sourceSummary: resolved.sourceSummary as object,
        fieldsUpdated,
      },
    });
  } catch {
    // Histórico é auxiliar — não interromper o fluxo principal
  }

  return { fieldsUpdated, produtoEstado };
}
