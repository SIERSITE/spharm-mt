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
  CanonicalDecision,
  FieldDecision,
  FieldDecisionStatus,
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
      flagMSRM: true,
      flagMNSRM: true,
    },
  });

  if (!product) throw new Error(`Produto ${productId} não encontrado`);

  // Double-check de relevância: mesmo que o resolver tenha errado e devolvido
  // um valor irrelevante, bloqueamos aqui.
  const relevance = getFieldRelevance(resolved.productType);

  /**
   * Avalia se um campo de catálogo pode ser actualizado e devolve o
   * status + razão. Nunca tem efeitos colaterais — não escreve em
   * `updates` nem em `decisions`. O caller faz isso à luz da resposta.
   *
   * Regras (em ordem de avaliação — primeira violação ganha):
   *   1. validadoManualmente=true                    → blocked
   *   2. campo já preenchido na BD                   → unchanged (cf. regra 1.4)
   *   3. campo irrelevante para este productType     → skipped
   *   4. fonte não devolveu valor (resolved.* null)  → skipped
   *   5. confiança da fonte abaixo do threshold      → skipped
   *   6. tier não-autoritário em campo autoritário   → blocked
   *   ok                                            → updateable
   */
  function evaluateField(
    fieldName: string,
    currentValue: unknown,
    field: ResolvedField<string> | null,
    isRelevant: boolean
  ): { status: FieldDecisionStatus | "ok"; reason: string } {
    if (product!.validadoManualmente)
      return { status: "blocked", reason: "produto validadoManualmente=true" };
    if (currentValue !== null && currentValue !== undefined)
      return { status: "unchanged", reason: "campo já preenchido na BD" };
    if (!isRelevant)
      return { status: "skipped", reason: `campo irrelevante para ${resolved.productType}` };
    if (!field)
      return { status: "skipped", reason: "nenhuma fonte devolveu valor" };
    if (field.confidence < THRESHOLD_PARTIAL)
      return {
        status: "skipped",
        reason: `confiança ${(field.confidence * 100).toFixed(0)}% < ${(THRESHOLD_PARTIAL * 100).toFixed(0)}%`,
      };
    if (AUTHORITATIVE_FIELDS.has(fieldName) && !AUTHORITATIVE_TIERS.includes(field.tier)) {
      console.warn(
        `[persistence] BLOQUEADO: ${fieldName} recusado por tier "${field.tier}" ` +
        `(fonte="${field.source}"). Só ${AUTHORITATIVE_TIERS.join("/")} podem escrever este campo.`
      );
      return {
        status: "blocked",
        reason: `tier ${field.tier} não-autoritário (só ${AUTHORITATIVE_TIERS.join("/")})`,
      };
    }
    return { status: "ok", reason: "" };
  }

  const updates: Record<string, unknown> = {};
  const fieldsUpdated: string[] = [];
  const decisions: FieldDecision[] = [];

  function record(decision: FieldDecision): void {
    decisions.push(decision);
    if (decision.status === "updated") fieldsUpdated.push(decision.field);
  }

  // ── productType (sempre escrito como metadado; sinalizado como
  //    "updated" quando o resolver mudou o valor face à BD).
  if (product.validadoManualmente) {
    record({
      field: "productType",
      status: "blocked",
      reason: "produto validadoManualmente=true",
      oldValue: product.productType,
      newValue: resolved.productType,
    });
  } else if (product.productType !== resolved.productType && resolved.productType !== "OUTRO") {
    record({
      field: "productType",
      status: "updated",
      reason: "resolver decidiu novo tipo",
      oldValue: product.productType,
      newValue: resolved.productType,
      confidence: resolved.productTypeConfidence,
    });
  } else if (product.productType === resolved.productType) {
    record({
      field: "productType",
      status: "unchanged",
      reason: "valor já é o mesmo na BD",
      oldValue: product.productType,
      newValue: resolved.productType,
    });
  } else {
    // resolved.productType === "OUTRO" e DB tem outra coisa — não fazemos
    // downgrade (preservamos decisão prévia melhor).
    record({
      field: "productType",
      status: "skipped",
      reason: "resolver devolveu OUTRO; não sobrescreve tipo já decidido",
      oldValue: product.productType,
      newValue: resolved.productType,
    });
  }

  // ── productTypeConfidence — sempre escrito como metadado; só conta
  //    como mudança se a magnitude diferir significativamente.
  // Não adicionamos a fieldsUpdated mas registamos para diagnóstico.
  decisions.push({
    field: "productTypeConfidence",
    status: "updated",
    reason: "metadado — escrito sempre",
    oldValue: null,
    newValue: resolved.productTypeConfidence.toFixed(2),
    confidence: resolved.productTypeConfidence,
  });

  // ── Fabricante — campo autoritário, só REGULATORY/MANUFACTURER
  {
    const ev = evaluateField("fabricante", product.fabricanteId, resolved.fabricante, relevance.fabricante);
    if (ev.status === "ok") {
      const raw = resolved.fabricante!.value;
      const normalized = normalizeManufacturerName(raw);
      if (!normalized) {
        record({ field: "fabricanteId", status: "skipped", reason: "valor normalizado vazio", newValue: raw });
      } else {
        if (!dryRun) {
          const id = await getOrCreateFabricante(normalized, raw !== normalized ? raw : null);
          updates.fabricanteId = id;
        }
        record({
          field: "fabricanteId", status: "updated",
          reason: `fonte ${resolved.fabricante!.source} (${resolved.fabricante!.tier})`,
          newValue: normalized, source: resolved.fabricante!.source, confidence: resolved.fabricante!.confidence,
        });
      }
    } else {
      record({ field: "fabricanteId", status: ev.status, reason: ev.reason });
    }
  }

  // ── DCI — campo autoritário
  {
    const ev = evaluateField("dci", product.dci, resolved.dci, relevance.dci);
    if (ev.status === "ok") {
      const normalized = normalizePrincipioAtivo(resolved.dci!.value);
      if (!normalized) {
        record({ field: "dci", status: "skipped", reason: "valor normalizado vazio" });
      } else {
        updates.dci = normalized;
        record({
          field: "dci", status: "updated",
          reason: `fonte ${resolved.dci!.source}`, newValue: normalized,
          source: resolved.dci!.source, confidence: resolved.dci!.confidence,
        });
      }
    } else {
      record({ field: "dci", status: ev.status, reason: ev.reason });
    }
  }

  // ── ATC — campo autoritário
  {
    const ev = evaluateField("codigoATC", product.codigoATC, resolved.codigoATC, relevance.atc);
    if (ev.status === "ok") {
      const normalized = normalizeATC(resolved.codigoATC!.value);
      if (!normalized) {
        record({ field: "codigoATC", status: "skipped", reason: "valor normalizado vazio" });
      } else {
        updates.codigoATC = normalized;
        record({
          field: "codigoATC", status: "updated",
          reason: `fonte ${resolved.codigoATC!.source}`, newValue: normalized,
          source: resolved.codigoATC!.source, confidence: resolved.codigoATC!.confidence,
        });
      }
    } else {
      record({ field: "codigoATC", status: ev.status, reason: ev.reason });
    }
  }

  // ── Forma farmacêutica / apresentação
  {
    const ev = evaluateField("formaFarmaceutica", product.formaFarmaceutica, resolved.formaFarmaceutica, relevance.formaFarmaceutica);
    if (ev.status === "ok") {
      const normalized = normalizeFormaFarmaceutica(resolved.formaFarmaceutica!.value);
      if (!normalized) {
        record({ field: "formaFarmaceutica", status: "skipped", reason: "valor normalizado vazio" });
      } else {
        updates.formaFarmaceutica = normalized;
        record({
          field: "formaFarmaceutica", status: "updated",
          reason: `fonte ${resolved.formaFarmaceutica!.source}`, newValue: normalized,
          source: resolved.formaFarmaceutica!.source, confidence: resolved.formaFarmaceutica!.confidence,
        });
      }
    } else {
      record({ field: "formaFarmaceutica", status: ev.status, reason: ev.reason });
    }
  }

  // ── Dosagem
  {
    const ev = evaluateField("dosagem", product.dosagem, resolved.dosagem, relevance.dosagem);
    if (ev.status === "ok") {
      const normalized = normalizeDosagem(resolved.dosagem!.value);
      if (!normalized) {
        record({ field: "dosagem", status: "skipped", reason: "valor normalizado vazio" });
      } else {
        updates.dosagem = normalized;
        record({
          field: "dosagem", status: "updated",
          reason: `fonte ${resolved.dosagem!.source}`, newValue: normalized,
          source: resolved.dosagem!.source, confidence: resolved.dosagem!.confidence,
        });
      }
    } else {
      record({ field: "dosagem", status: ev.status, reason: ev.reason });
    }
  }

  // ── Embalagem
  {
    const ev = evaluateField("embalagem", product.embalagem, resolved.embalagem, relevance.embalagem);
    if (ev.status === "ok") {
      const normalized = normalizeEmbalagem(resolved.embalagem!.value);
      if (!normalized) {
        record({ field: "embalagem", status: "skipped", reason: "valor normalizado vazio" });
      } else {
        updates.embalagem = normalized;
        record({
          field: "embalagem", status: "updated",
          reason: `fonte ${resolved.embalagem!.source}`, newValue: normalized,
          source: resolved.embalagem!.source, confidence: resolved.embalagem!.confidence,
        });
      }
    } else {
      record({ field: "embalagem", status: ev.status, reason: ev.reason });
    }
  }

  // ── Imagem URL — exige confiança alta (risco de imagem errada).
  //
  // Confiança é baseada na qualidade do MATCH do produto na fonte (CNP
  // exacto no URL/página, similaridade alta de nome com a designação),
  // não no productType. Threshold = THRESHOLD_AUTO (0.75), o que na
  // prática filtra automaticamente:
  //   - matches fuzzy_name (retail conf 0.55) → skip (não escreve imagem)
  //   - matches sku/cnp/designacao (retail conf 0.78–0.80) → write
  //   - matches OFF/OBF com baseConf 0.65–0.70 e similarity baixa →
  //     conf final < 0.75 → skip
  // INFARMED nunca devolve imagem (imagemUrl=null no connector).
  {
    const ev = evaluateField("imagemUrl", product.imagemUrl, resolved.imagemUrl, relevance.imagemUrl);
    if (ev.status !== "ok") {
      record({ field: "imagemUrl", status: ev.status, reason: ev.reason });
    } else if ((resolved.imagemUrl?.confidence ?? 0) < THRESHOLD_AUTO) {
      const src = resolved.imagemUrl?.source ?? "—";
      const conf = ((resolved.imagemUrl?.confidence ?? 0) * 100).toFixed(0);
      record({
        field: "imagemUrl",
        status: "skipped",
        reason:
          `imagemUrl exige conf ≥ ${(THRESHOLD_AUTO * 100).toFixed(0)}% ` +
          `(got ${conf}% de fonte ${src}) — match não suficientemente seguro`,
        source: resolved.imagemUrl?.source ?? null,
        confidence: resolved.imagemUrl?.confidence ?? null,
      });
    } else {
      const normalized = normalizeImageUrl(resolved.imagemUrl!.value);
      if (!normalized) {
        record({
          field: "imagemUrl",
          status: "skipped",
          reason: `URL inválida após normalização (raw=${resolved.imagemUrl!.value.slice(0, 80)})`,
          source: resolved.imagemUrl!.source,
          confidence: resolved.imagemUrl!.confidence,
        });
      } else {
        updates.imagemUrl = normalized;
        record({
          field: "imagemUrl",
          status: "updated",
          reason:
            `fonte ${resolved.imagemUrl!.source} ` +
            `(conf ${(resolved.imagemUrl!.confidence * 100).toFixed(0)}%, ` +
            `tier ${resolved.imagemUrl!.tier})`,
          newValue: normalized,
          source: resolved.imagemUrl!.source,
          confidence: resolved.imagemUrl!.confidence,
        });
      }
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
  let canonicalDecision: CanonicalDecision;
  if (product.validadoManualmente) {
    canonicalDecision = {
      outcome: "manually_validated",
      reason: "produto validadoManualmente=true — classificação não tocada",
    };
    record({ field: "classificacaoNivel1Id", status: "blocked", reason: canonicalDecision.reason });
  } else if (product.classificacaoNivel1Id) {
    canonicalDecision = {
      outcome: "already_set",
      reason: "produto já tinha classificacaoNivel1Id — não sobrescrever",
    };
    record({ field: "classificacaoNivel1Id", status: "unchanged", reason: canonicalDecision.reason });
  } else if (!relevance.categoria) {
    canonicalDecision = {
      outcome: "irrelevant",
      reason: `categoria irrelevante para ${resolved.productType}`,
    };
    record({ field: "classificacaoNivel1Id", status: "skipped", reason: canonicalDecision.reason });
  } else {
    // DCI: preferir o valor já em BD (foi gravado por uma corrida anterior
    // ou por import) — se ausente, usar o resolvido pelo motor a partir
    // dos conectores (tipicamente INFARMED, REGULATORY tier).
    const effectiveDci = product.dci ?? resolved.dci?.value ?? null;
    const effectiveAtc = resolved.codigoATC?.value ?? product.codigoATC ?? null;

    const canonical = mapToCanonical({
      productType: resolved.productType,
      productTypeConfidence: resolved.productTypeConfidence,
      externalCategory: resolved.categoria?.value ?? null,
      externalSubcategory: resolved.subcategoria?.value ?? null,
      designacao: product.designacao,
      atc: effectiveAtc,
      dci: effectiveDci,
    });

    // Log diagnóstico verbose para MEDICAMENTOS — explicita porque o
    // mapper escolheu este nivel2, especialmente quando cai no fallback
    // "Outros Medicamentos". Crítico para diagnosticar produtos que
    // ficam genericamente classificados.
    if (
      canonical &&
      canonical.nivel1 === "MEDICAMENTOS" &&
      (resolved.productType === "MEDICAMENTO" ||
        product.flagMSRM ||
        product.flagMNSRM)
    ) {
      const fallback = canonical.method === "others_fallback";
      const tag = fallback ? "[med-fallback]" : "[med-map]";
      console.log(
        `${tag} cnp-product=${productId} ` +
        `atc=${effectiveAtc ?? "—"} dci=${effectiveDci ?? "—"} ` +
        `→ ${canonical.nivel1} / ${canonical.nivel2} ` +
        `(method=${canonical.method}, conf=${canonical.confidence.toFixed(2)}). ` +
        `${canonical.reason}`,
      );
    }

    if (!canonical) {
      const reason =
        `mapper não inferiu canónica (productType=${resolved.productType} ` +
        `conf=${(resolved.productTypeConfidence * 100).toFixed(0)}%, ` +
        `extCat=${JSON.stringify(resolved.categoria?.value ?? null)})`;
      console.warn(`[persistence] canonical=null para produto ${productId} — ${reason}`);
      canonicalDecision = { outcome: "no_signal", reason };
      record({ field: "classificacaoNivel1Id", status: "skipped", reason });
    } else if (canonical.confidence < THRESHOLD_PARTIAL) {
      const reason =
        `${canonical.nivel1}/${canonical.nivel2} conf=${canonical.confidence.toFixed(2)} ` +
        `< limiar ${THRESHOLD_PARTIAL}`;
      console.warn(`[persistence] canonical abaixo do limiar — ${reason}`);
      canonicalDecision = {
        outcome: "below_threshold",
        reason,
        nivel1: canonical.nivel1,
        nivel2: canonical.nivel2,
        confidence: canonical.confidence,
      };
      record({ field: "classificacaoNivel1Id", status: "skipped", reason });
    } else if (dryRun) {
      // Em dry-run não fazemos lookup de IDs — registamos só o par canónico.
      canonicalDecision = {
        outcome: "written",
        reason: `(dry-run) ${canonical.nivel1}/${canonical.nivel2} conf=${canonical.confidence.toFixed(2)}`,
        nivel1: canonical.nivel1,
        nivel2: canonical.nivel2,
        confidence: canonical.confidence,
      };
    } else {
      const res = await resolveClassificationIdsFromCategory(canonical.nivel1, canonical.nivel2);
      if (!res.nivel1Id) {
        const reason =
          `Classificacao "${canonical.nivel1}" não encontrada (nível 1, ATIVO) — ` +
          `corre 'npx tsx scripts/seed-taxonomy.ts'`;
        console.warn(`[persistence] ${reason}`);
        canonicalDecision = {
          outcome: "row_missing",
          reason,
          nivel1: canonical.nivel1,
          nivel2: canonical.nivel2,
          confidence: canonical.confidence,
          nivel1Id: null,
          nivel2Id: null,
        };
        record({ field: "classificacaoNivel1Id", status: "skipped", reason });
      } else {
        updates.classificacaoNivel1Id = res.nivel1Id;
        record({
          field: "classificacaoNivel1Id",
          status: "updated",
          reason: `mapper → ${canonical.nivel1} (conf ${canonical.confidence.toFixed(2)})`,
          newValue: canonical.nivel1,
          confidence: canonical.confidence,
        });

        if (res.nivel2Id && !product.classificacaoNivel2Id) {
          updates.classificacaoNivel2Id = res.nivel2Id;
          record({
            field: "classificacaoNivel2Id",
            status: "updated",
            reason: `mapper → ${canonical.nivel2}`,
            newValue: canonical.nivel2,
          });
          canonicalDecision = {
            outcome: "written",
            reason: `${canonical.nivel1} / ${canonical.nivel2}`,
            nivel1: canonical.nivel1,
            nivel2: canonical.nivel2,
            confidence: canonical.confidence,
            nivel1Id: res.nivel1Id,
            nivel2Id: res.nivel2Id,
          };
        } else if (!res.nivel2Id) {
          const reason =
            `nivel2 "${canonical.nivel2}" não encontrado como filho de ` +
            `"${canonical.nivel1}" — só nivel1 gravado`;
          console.warn(`[persistence] ${reason}`);
          canonicalDecision = {
            outcome: "n1_only",
            reason,
            nivel1: canonical.nivel1,
            nivel2: canonical.nivel2,
            confidence: canonical.confidence,
            nivel1Id: res.nivel1Id,
            nivel2Id: null,
          };
          record({ field: "classificacaoNivel2Id", status: "skipped", reason });
        } else {
          // res.nivel2Id existe mas product.classificacaoNivel2Id já estava set
          canonicalDecision = {
            outcome: "written",
            reason: `nivel1 ${canonical.nivel1} (nivel2 já estava set)`,
            nivel1: canonical.nivel1,
            nivel2: canonical.nivel2,
            confidence: canonical.confidence,
            nivel1Id: res.nivel1Id,
            nivel2Id: res.nivel2Id,
          };
        }
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
    return {
      fieldsUpdated,
      produtoEstado,
      verificationStatus: effectiveVerificationStatus,
      fieldDecisions: decisions,
      canonical: canonicalDecision,
    };
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
    fieldDecisions: decisions,
    canonical: canonicalDecision,
  };
}
