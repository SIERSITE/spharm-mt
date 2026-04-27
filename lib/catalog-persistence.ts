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
 * Limiares (política Abril 2026 — accept some imperfection):
 *   confidence >= 0.75  → ENRIQUECIDO_AUTOMATICAMENTE
 *   confidence >= 0.50  → PARCIALMENTE_ENRIQUECIDO (campos persistidos)
 *   confidence <  0.50  → sem persistência de campos; produto vai para
 *                          revisão manual (verificationStatus=NEEDS_REVIEW
 *                          definido pelo resolver).
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
  VerificationStatus,
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

// Política Abril 2026:
//   write threshold (PARTIAL) baixa a 0.50 — campos com confiança ≥ 0.50
//     são gravados automaticamente.
//   verified threshold (AUTO) baixa a 0.75 — produtos com algum campo
//     ≥ 0.75 ficam ENRIQUECIDO_AUTOMATICAMENTE (estado VERIFIED no resolver).
//   imagemUrl continua a ter checagem extra contra THRESHOLD_AUTO (0.75) —
//     era 0.90 e nunca passava; agora RETAIL/Open*Facts podem alimentar imagem.
const THRESHOLD_AUTO    = 0.75;
const THRESHOLD_PARTIAL = 0.50;

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
      productType: true,
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

  // productType: contar como campo actualizado sempre que o resolver
  // produziu um tipo concreto (≠ OUTRO) que difere do que está em BD,
  // OU quando a confiança subiu materialmente (>= 5 pontos absolutos).
  // O write em si acontece sempre no UPDATE final; adicionar a
  // `fieldsUpdated` é a única forma de o orquestrador "saber" que houve
  // uma decisão útil — caso contrário, um produto OUTRO upgraded para
  // DERMOCOSMETICA nesta corrida apareceria como `failed` no relatório.
  const typeChanged =
    resolved.productType !== "OUTRO" &&
    !product.validadoManualmente &&
    product.productType !== resolved.productType;
  if (typeChanged) {
    fieldsUpdated.push("productType");
  }

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

  // Classificação — passa SEMPRE pelo mapper canónico.
  //
  // Regras:
  //   · Nenhuma categoria livre vinda de fontes externas pode ser gravada.
  //   · Nenhuma categoria técnica/transitória (Em Revisão, Por Classificar,
  //     Sem Match de Fonte) é persistida — esses estados são representados
  //     por `verificationStatus` / `needsManualReview`, não por categorias.
  //   · O mapper devolve `null` quando não há sinal suficiente. Nesse caso,
  //     `classificacaoNivel1Id` / `classificacaoNivel2Id` ficam `null` e o
  //     produto aparece como "sem classificação" na UI.
  //   · Quando o mapper devolve um par (nivel1, nivel2) com confidence
  //     >= THRESHOLD_PARTIAL, gravamos os IDs canónicos e contamos em
  //     `fieldsUpdated` (promove o produto a enriquecido).
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

    if (!canonical) {
      // Diagnóstico: o mapper não achou (nivel1, nivel2) com confiança
      // suficiente. Mais comum quando o productType ficou OUTRO ou a
      // categoria externa não tem keyword conhecida. Não impede o resto
      // do enriquecimento.
      console.warn(
        `[persistence] canonical=null para produto ${productId} ` +
        `(type=${resolved.productType} conf=${(resolved.productTypeConfidence * 100).toFixed(0)}% ` +
        `extCat=${JSON.stringify(resolved.categoria?.value ?? null)})`
      );
    } else if (canonical.confidence < THRESHOLD_PARTIAL) {
      console.warn(
        `[persistence] canonical abaixo do limiar para ${productId}: ` +
        `${canonical.nivel1}/${canonical.nivel2} ` +
        `conf=${canonical.confidence.toFixed(2)} < ${THRESHOLD_PARTIAL}`
      );
    } else {
      const res = await resolveClassificationIdsFromCategory(canonical.nivel1, canonical.nivel2);
      if (!res.nivel1Id) {
        // Diagnóstico: o mapper deu um par válido mas a tabela
        // Classificacao não tem essa linha (seed não foi corrido?
        // estado=INATIVO?). Pode acontecer após cleanup-technical-categories.
        console.warn(
          `[persistence] Classificacao "${canonical.nivel1}" não encontrada ` +
          `(nível 1, ATIVO) — corre 'npx tsx scripts/seed-taxonomy.ts'`
        );
      } else {
        updates.classificacaoNivel1Id = res.nivel1Id;
        fieldsUpdated.push("classificacaoNivel1Id");
      }
      if (res.nivel2Id && !product.classificacaoNivel2Id) {
        updates.classificacaoNivel2Id = res.nivel2Id;
        fieldsUpdated.push("classificacaoNivel2Id");
      } else if (res.nivel1Id && !res.nivel2Id) {
        console.warn(
          `[persistence] Classificacao N2 "${canonical.nivel2}" não encontrada ` +
          `como filho de "${canonical.nivel1}" — só nivel1 foi gravado`
        );
      }
    }
  }

  // Estado resultante do produto.
  //
  // "Catálogo" = campos do catálogo do produto (fabricante, DCI, ATC,
  //              forma, dosagem, embalagem, imagem, classificações N1/N2).
  // "Type-only" = só o productType foi escrito; nada do catálogo chegou.
  //
  // Um produto que só tenha productType actualizado mantém verificationStatus
  // PARTIALLY_VERIFIED no máximo — VERIFIED implica que houve confirmação
  // externa material que se traduziu em pelo menos um campo persistido.
  const catalogFields = fieldsUpdated.filter((f) => f !== "productType");
  const hasCatalogField = catalogFields.length > 0;

  const maxConf = hasCatalogField
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

  const produtoEstado = !hasCatalogField && fieldsUpdated.length === 0
    ? "PENDENTE"
    : !hasCatalogField
    ? "PARCIALMENTE_ENRIQUECIDO" // só productType inferido, sem campos de catálogo
    : maxConf >= THRESHOLD_AUTO
    ? "ENRIQUECIDO_AUTOMATICAMENTE"
    : "PARCIALMENTE_ENRIQUECIDO";

  // verificationStatus efectivo: a única downgrade é VERIFIED → PARTIALLY_VERIFIED
  // quando NÃO se persistiu nenhum campo de catálogo. Tipos NEEDS_REVIEW e
  // PENDING/IN_PROGRESS/FAILED ficam intactos. PARTIALLY_VERIFIED idem.
  const effectiveVerificationStatus: VerificationStatus =
    resolved.verificationStatus === "VERIFIED" && !hasCatalogField
      ? "PARTIALLY_VERIFIED"
      : resolved.verificationStatus;

  if (dryRun) {
    console.log(
      `  [dry-run] ${productId} [${resolved.productType} ${(resolved.productTypeConfidence * 100).toFixed(0)}%]:`
    );
    console.log(`    Campos: ${fieldsUpdated.join(", ") || "nenhum"}`);
    console.log(
      `    Verificação: ${effectiveVerificationStatus}${
        effectiveVerificationStatus !== resolved.verificationStatus
          ? ` (downgrade de ${resolved.verificationStatus})`
          : ""
      } | Estado: ${produtoEstado}`
    );
    return { fieldsUpdated, produtoEstado, verificationStatus: effectiveVerificationStatus };
  }

  // Gravar campos de catálogo + metadados de verificação numa única operação.
  // Para produtos validados manualmente, NUNCA reverter os flags de revisão
  // — o admin já decidiu, e produtos validados não devem voltar à fila.
  // O resto dos metadados (lastVerifiedAt, productType, conf) é descritivo
  // do último attempt e é seguro escrever.
  const isValidated = product.validadoManualmente;
  await prisma.produto.update({
    where: { id: productId },
    data: {
      ...(updates as object),
      // estado / origemDados não tocam em produtos validados (admin pôs VALIDADO/MANUAL)
      ...(isValidated
        ? {}
        : {
            estado: produtoEstado as Parameters<typeof prisma.produto.update>[0]["data"]["estado"],
            origemDados: "ENRIQUECIMENTO" as const,
            classificationSource: resolved.classificationSource,
          }),
      // Metadados descritivos sempre escritos.
      productType: resolved.productType,
      productTypeConfidence: resolved.productTypeConfidence,
      classificationVersion: resolved.classificationVersion,
      verificationStatus: effectiveVerificationStatus as Parameters<
        typeof prisma.produto.update
      >[0]["data"]["verificationStatus"],
      lastVerifiedAt: resolved.lastVerifiedAt,
      lastVerificationAttemptAt: resolved.lastVerifiedAt,
      externallyVerified: resolved.externallyVerified,
      // Em produtos validados manualmente, força sempre needsManualReview=false.
      needsManualReview: isValidated ? false : resolved.needsManualReview,
      manualReviewReason: isValidated ? null : resolved.manualReviewReason,
    },
  });

  // Histórico de verificação — não crítico, falha silenciosa
  try {
    await prisma.produtoVerificacaoHistorico.create({
      data: {
        produtoId: productId,
        productType: resolved.productType,
        productTypeConf: resolved.productTypeConfidence,
        verificationStatus: effectiveVerificationStatus,
        sourceSummary: resolved.sourceSummary as object,
        fieldsUpdated,
      },
    });
  } catch {
    // Histórico é auxiliar — não interromper o fluxo principal
  }

  return {
    fieldsUpdated,
    produtoEstado,
    verificationStatus: effectiveVerificationStatus,
  };
}
