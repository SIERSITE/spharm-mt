/**
 * lib/jobs/regulatory-acquisition-fetchers.ts
 *
 * Fetchers reais (Phase 1) do regulatory acquisition pipeline. Cada
 * fetcher recebe `(prisma, cnp, designacao)` e devolve um `FetcherOutcome`
 * normalizado. Os fetchers NÃO escrevem em `RegulatoryRecord` directamente
 * — o caller (worker) agrega resultados e faz upsert idempotente.
 *
 * Estratégia hierárquica:
 *
 *   1. **infarmedSnapshotFetcher** (DB-only, instantâneo, alto recall)
 *      Lookup directo em `InfarmedSnapshot` por CNP. Snapshot mensal
 *      do INFARMED Open Data — já contém ~16k CNPs com clínica.
 *      ZERO HTTP, ZERO rate-limit. Corre em ms.
 *
 *   2. **infomedHttpFetcher** (HTTP, ~3-4 s/CNP, alto valor sobre CNPs
 *      sem snapshot match)
 *      Resolve CNP via designacao→search→detail no INFOMED. Reusa a
 *      sessão entre chamadas para amortizar latência. Anti-bot dominado
 *      no Pipeline P9 (2026-05-11). Inclui extracção de imagem (Phase C).
 *
 * Output mode = "merged" — devolve sempre o **superset** entre fontes.
 * Política de preferência por campo:
 *
 *   · codigoATC / dci / formaFarmaceutica / dosagem / embalagem
 *     → INFOMED HTTP vence sobre snapshot (INFOMED tem 5-7 chars ATC, snapshot
 *        tem só raiz; INFOMED costuma ser mais up-to-date).
 *   · titularAim / estadoAim / designacaoOficial / grupoTerapeutico
 *     → INFARMED Snapshot vence (vem do registo oficial CSV mensal).
 *   · imagemUrl → só INFOMED HTTP fornece.
 *
 * Idempotente: re-correr produz o mesmo output dado o mesmo estado das
 * fontes. Não cacheia entre invocações (caller controla).
 *
 * Constraints respeitados:
 *   · Nunca substitui dado regulatório forte por dado fraco (snapshot e
 *     INFOMED são ambos REGULATORY tier).
 *   · Tudo auditável via `sourceResults` no caller.
 *   · Não apaga dados — só agrega.
 *   · Multi-tenant safe — recebe prisma do tenant.
 */

import type { PrismaClient } from "@/generated/prisma/client";
import {
  resolveCnpViaDesignacaoSearch,
  startSearchSession,
  type SearchSession,
  type ResolveOutcome,
} from "@/lib/regulatory-sources/infomed-search-resolver";

// ─── Tipos públicos ─────────────────────────────────────────────────────

export type RegulatoryFields = {
  designacaoOficial: string | null;
  dci: string | null;
  codigoATC: string | null;
  formaFarmaceutica: string | null;
  dosagem: string | null;
  embalagem: string | null;
  grupoTerapeutico: string | null;
  titularAim: string | null;
  estadoAim: string | null;
  /** Só populado por INFOMED HTTP. */
  imagemUrl: string | null;
};

export type FetcherResult =
  | {
      kind: "ok";
      source: "infarmed_snapshot" | "infomed_http";
      fields: RegulatoryFields;
      fieldsObtained: string[];
      /** Detalhe cru para auditoria — vai para `sourceResults`. */
      raw: Record<string, unknown>;
    }
  | {
      kind: "not_found";
      source: "infarmed_snapshot" | "infomed_http";
      reason: string;
    }
  | {
      kind: "ambiguous";
      source: "infomed_http";
      candidates: number;
      reason: string;
    }
  | {
      kind: "error";
      source: "infarmed_snapshot" | "infomed_http";
      error: string;
      transient: boolean;
    };

// ─── INFARMED Snapshot fetcher ──────────────────────────────────────────

const INFARMED_FIELDS: (keyof RegulatoryFields)[] = [
  "designacaoOficial",
  "dci",
  "codigoATC",
  "formaFarmaceutica",
  "dosagem",
  "embalagem",
  "grupoTerapeutico",
  "titularAim",
  "estadoAim",
];

export async function infarmedSnapshotFetcher(
  prisma: PrismaClient,
  cnp: number,
): Promise<FetcherResult> {
  try {
    const snap = await prisma.infarmedSnapshot.findUnique({
      where: { cnp },
      select: {
        designacaoOficial: true,
        dci: true,
        codigoATC: true,
        formaFarmaceutica: true,
        dosagem: true,
        embalagem: true,
        grupoTerapeutico: true,
        titularAim: true,
        estadoAim: true,
        snapshotVersion: true,
      },
    });
    if (!snap) {
      return { kind: "not_found", source: "infarmed_snapshot", reason: "cnp_not_in_snapshot" };
    }
    // Produtos com estado regulatório negativo não devem ser propagados —
    // mantemos a política do conector original (estado=Suspenso/Revogado/
    // Caducado ⇒ não há dado clínico válido para sincronizar).
    if (
      snap.estadoAim &&
      ["Suspenso", "Revogado", "Caducado"].includes(snap.estadoAim)
    ) {
      return {
        kind: "not_found",
        source: "infarmed_snapshot",
        reason: `estadoAim=${snap.estadoAim}`,
      };
    }

    const fields: RegulatoryFields = {
      designacaoOficial: snap.designacaoOficial ?? null,
      dci: snap.dci ?? null,
      codigoATC: snap.codigoATC ?? null,
      formaFarmaceutica: snap.formaFarmaceutica ?? null,
      dosagem: snap.dosagem ?? null,
      embalagem: snap.embalagem ?? null,
      grupoTerapeutico: snap.grupoTerapeutico ?? null,
      titularAim: snap.titularAim ?? null,
      estadoAim: snap.estadoAim ?? null,
      imagemUrl: null, // snapshot CSV não traz imagem
    };
    const fieldsObtained = INFARMED_FIELDS.filter((f) => fields[f] != null);
    return {
      kind: "ok",
      source: "infarmed_snapshot",
      fields,
      fieldsObtained,
      raw: { snapshotVersion: snap.snapshotVersion },
    };
  } catch (err) {
    return {
      kind: "error",
      source: "infarmed_snapshot",
      error: err instanceof Error ? err.message : String(err),
      transient: true, // DB query failure — recuperável
    };
  }
}

// ─── INFOMED HTTP fetcher ───────────────────────────────────────────────

export type InfomedFetcherOptions = {
  /** Session pré-aberta para reusar entre N CNPs (poupa GET index.xhtml). */
  session?: SearchSession;
  /** ms entre requests no mesmo session. Default 1500 (conforme spike). */
  rateLimitMs?: number;
  /** Max rows a evaluar do search result. Default 3. */
  maxCandidatesToFetch?: number;
};

export async function infomedHttpFetcher(
  cnp: number,
  designacao: string | null | undefined,
  opts: InfomedFetcherOptions = {},
): Promise<FetcherResult> {
  if (!designacao || !designacao.trim()) {
    return {
      kind: "not_found",
      source: "infomed_http",
      reason: "missing_designacao",
    };
  }

  let outcome: ResolveOutcome;
  try {
    outcome = await resolveCnpViaDesignacaoSearch(cnp, designacao, {
      rateLimitMs: opts.rateLimitMs ?? 1500,
      maxCandidatesToFetch: opts.maxCandidatesToFetch ?? 3,
      session: opts.session,
    });
  } catch (err) {
    return {
      kind: "error",
      source: "infomed_http",
      error: err instanceof Error ? err.message : String(err),
      transient: true,
    };
  }

  switch (outcome.kind) {
    case "matched_strong": {
      const d = outcome.detail;
      const fields: RegulatoryFields = {
        designacaoOficial: d.designacaoOficial ?? null,
        dci: d.dci ?? null,
        codigoATC: d.codigoATC ?? null,
        formaFarmaceutica: d.formaFarmaceutica ?? null,
        dosagem: d.dosagem ?? null,
        embalagem: d.embalagens.find((e) => e.cnp === cnp)?.descricao ?? null,
        grupoTerapeutico: d.grupoTerapeutico ?? null,
        titularAim: d.titularAim ?? null,
        estadoAim: d.estadoAim ?? null,
        imagemUrl: d.imagemUrl ?? null,
      };
      const all: (keyof RegulatoryFields)[] = [
        "designacaoOficial",
        "dci",
        "codigoATC",
        "formaFarmaceutica",
        "dosagem",
        "embalagem",
        "grupoTerapeutico",
        "titularAim",
        "estadoAim",
        "imagemUrl",
      ];
      const fieldsObtained = all.filter((f) => fields[f] != null);
      return {
        kind: "ok",
        source: "infomed_http",
        fields,
        fieldsObtained,
        raw: {
          medGuid: d.medGuid,
          matchedRow: { medId: outcome.matchedRow.medId, nome: outcome.matchedRow.nome },
          candidatesEvaluated: outcome.candidatesEvaluated,
          fetchedAt: d.raw.fetchedAt,
        },
      };
    }
    case "ambiguous":
      return {
        kind: "ambiguous",
        source: "infomed_http",
        candidates: outcome.matchedRowsWithDetail.length,
        reason: `cnp matched in ${outcome.matchedRowsWithDetail.length} candidates`,
      };
    case "not_found":
      return {
        kind: "not_found",
        source: "infomed_http",
        reason: `${outcome.reason} (rows=${outcome.rowsTotal})`,
      };
    case "failed":
      return {
        kind: "error",
        source: "infomed_http",
        error: `${outcome.stage}: ${outcome.error}`,
        // 503 / network / timeout / parse → transient; HTTP 4xx → permanent.
        transient: /503|network|timeout|connect|abort/i.test(outcome.error),
      };
  }
}

// ─── Session helper exporte ──────────────────────────────────────────────

/** Abre uma sessão INFOMED para reuse N pedidos. Throw se anti-bot bloquear. */
export async function openInfomedSession(): Promise<SearchSession> {
  return startSearchSession();
}

// ─── Merge fields ───────────────────────────────────────────────────────

/**
 * Funde dois `RegulatoryFields` segundo a política descrita no header:
 *
 *   · Para campos clínicos (ATC/DCI/forma/dosagem/embalagem/imagemUrl):
 *     INFOMED HTTP > INFARMED Snapshot (mais up-to-date, ATC full).
 *   · Para campos administrativos (titularAim, estadoAim, designacao,
 *     grupoTerapeutico): INFARMED Snapshot > INFOMED HTTP (registo
 *     oficial, mais autoritário para o que é).
 *   · Não-null vence sempre sobre null. Já no caller, o upsert em
 *     `RegulatoryRecord` é preserve-non-null contra o que já existe.
 */
export function mergeRegulatoryFields(
  http: RegulatoryFields | null,
  snapshot: RegulatoryFields | null,
): RegulatoryFields {
  const empty: RegulatoryFields = {
    designacaoOficial: null,
    dci: null,
    codigoATC: null,
    formaFarmaceutica: null,
    dosagem: null,
    embalagem: null,
    grupoTerapeutico: null,
    titularAim: null,
    estadoAim: null,
    imagemUrl: null,
  };
  const h = http ?? empty;
  const s = snapshot ?? empty;

  const pick = <K extends keyof RegulatoryFields>(
    primary: RegulatoryFields,
    fallback: RegulatoryFields,
    key: K,
  ): RegulatoryFields[K] => (primary[key] != null ? primary[key] : fallback[key]);

  return {
    // Clínicos: INFOMED HTTP primary, snapshot fallback
    dci: pick(h, s, "dci"),
    codigoATC: pick(h, s, "codigoATC"),
    formaFarmaceutica: pick(h, s, "formaFarmaceutica"),
    dosagem: pick(h, s, "dosagem"),
    embalagem: pick(h, s, "embalagem"),
    imagemUrl: pick(h, s, "imagemUrl"),
    // Administrativos: snapshot primary, HTTP fallback
    designacaoOficial: pick(s, h, "designacaoOficial"),
    titularAim: pick(s, h, "titularAim"),
    estadoAim: pick(s, h, "estadoAim"),
    grupoTerapeutico: pick(s, h, "grupoTerapeutico"),
  };
}
