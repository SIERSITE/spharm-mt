/**
 * lib/ingest/bootstrap.ts
 *
 * Helpers partilhados pelos endpoints `/api/ingest/v1/bootstrap/*`:
 *   · POST /api/ingest/v1/bootstrap/products
 *   · POST /api/ingest/v1/bootstrap/stock
 *   · POST /api/ingest/v1/bootstrap/sales-lines
 *
 * Responsabilidades:
 *   · Verificar feature flag ENABLE_AGENT_BOOTSTRAP — 503 quando off
 *   · Validar farmaciaId contra a BD do tenant (defesa contra forging)
 *   · Limitar tamanho de batch (DoS defensivo + previsibilidade memória)
 *   · Padronizar shape de resposta entre os 3 endpoints
 *
 * Cada endpoint chama `assertBootstrapEnabled` e `validateBatchBody`
 * antes de qualquer escrita.
 */

import "server-only";
import { NextResponse } from "next/server";
import type { PrismaClient } from "@/generated/prisma/client";
import { boolEnv } from "@/lib/env";

/** Limite duro de items por POST. Acima → 413 payload_too_large. */
export const BOOTSTRAP_MAX_BATCH_SIZE = 1000;

/** Resposta standard em sucesso. Endpoints podem estender `details`. */
export type BootstrapBatchResponse = {
  ok: true;
  accepted: number;
  upserted: number;
  skipped: Array<{ index: number; reason: string; externalId?: number }>;
  errors: Array<{ index: number; reason: string; externalId?: number; message: string }>;
  durationMs: number;
};

/**
 * Verifica que a feature flag está activa. Devolve `null` se OK,
 * senão devolve a Response 503 já pronta a retornar. Padrão de uso:
 *
 *   const disabled = assertBootstrapEnabled();
 *   if (disabled) return disabled;
 */
export function assertBootstrapEnabled(): Response | null {
  if (boolEnv("ENABLE_AGENT_BOOTSTRAP", false)) return null;
  return NextResponse.json(
    {
      ok: false,
      error: "feature_disabled",
      message:
        "Bootstrap endpoints estão desactivados. Configurar ENABLE_AGENT_BOOTSTRAP=1 no ambiente do SaaS antes de invocar.",
    },
    { status: 503 }
  );
}

/**
 * Lê o body JSON. Falha com 400 se não for objecto válido OU se
 * `farmaciaId` e `items` não tiverem o shape esperado. Em sucesso
 * devolve `{ farmaciaId, items }` já validados.
 */
export type ParsedBatchBody<T> = {
  farmaciaId: string;
  items: T[];
};

export type BatchValidationFailure = { response: Response };

export function isFailure<T>(
  v: ParsedBatchBody<T> | BatchValidationFailure
): v is BatchValidationFailure {
  return (v as BatchValidationFailure).response !== undefined;
}

export async function parseBatchBody<T = unknown>(
  req: Request
): Promise<ParsedBatchBody<T> | BatchValidationFailure> {
  let body: unknown;
  try {
    body = await req.json();
  } catch (err) {
    return {
      response: NextResponse.json(
        {
          ok: false,
          error: "invalid_json",
          message: `Body não é JSON válido: ${err instanceof Error ? err.message : String(err)}`,
        },
        { status: 400 }
      ),
    };
  }
  if (typeof body !== "object" || body === null) {
    return {
      response: NextResponse.json(
        { ok: false, error: "invalid_body", message: "Body deve ser um objecto JSON." },
        { status: 400 }
      ),
    };
  }
  const obj = body as Record<string, unknown>;
  if (typeof obj.farmaciaId !== "string" || obj.farmaciaId.trim() === "") {
    return {
      response: NextResponse.json(
        {
          ok: false,
          error: "missing_farmacia_id",
          message: "Campo 'farmaciaId' (string) é obrigatório no body.",
        },
        { status: 400 }
      ),
    };
  }
  if (!Array.isArray(obj.items)) {
    return {
      response: NextResponse.json(
        {
          ok: false,
          error: "missing_items",
          message: "Campo 'items' (array) é obrigatório no body.",
        },
        { status: 400 }
      ),
    };
  }
  if (obj.items.length === 0) {
    return {
      response: NextResponse.json(
        { ok: false, error: "empty_batch", message: "'items' está vazio — nada a fazer." },
        { status: 400 }
      ),
    };
  }
  if (obj.items.length > BOOTSTRAP_MAX_BATCH_SIZE) {
    return {
      response: NextResponse.json(
        {
          ok: false,
          error: "payload_too_large",
          message: `Batch tem ${obj.items.length} items; máximo aceite é ${BOOTSTRAP_MAX_BATCH_SIZE}. Particionar do lado do agent.`,
        },
        { status: 413 }
      ),
    };
  }
  return {
    farmaciaId: obj.farmaciaId,
    items: obj.items as T[],
  };
}

/**
 * Confirma que `farmaciaId` existe na BD do tenant. Defesa contra
 * cabeçalhos forged (já validados em `withIntegrationAuth`) e contra
 * typos do operador.
 */
export async function assertFarmaciaInTenant(
  prisma: PrismaClient,
  farmaciaId: string
): Promise<Response | null> {
  const farmacia = await prisma.farmacia.findUnique({
    where: { id: farmaciaId },
    select: { id: true, estado: true },
  });
  if (!farmacia) {
    return NextResponse.json(
      {
        ok: false,
        error: "farmacia_not_found",
        message: `farmaciaId="${farmaciaId}" não existe na BD do tenant.`,
      },
      { status: 404 }
    );
  }
  if (farmacia.estado !== "ATIVO") {
    return NextResponse.json(
      {
        ok: false,
        error: "farmacia_inactive",
        message: `farmaciaId="${farmaciaId}" está em estado ${farmacia.estado}. Bootstrap recusa farmácias inactivas.`,
      },
      { status: 409 }
    );
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// Coerções defensivas de campos de payload — JSON do agent pode trazer
// null, undefined ou strings em qualquer campo numérico/booleano.
// ─────────────────────────────────────────────────────────────────────

export function asIntOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function asDecimalOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function asStringOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

export function asBoolOrFalse(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    return t === "1" || t === "true" || t === "y" || t === "s";
  }
  return false;
}

/**
 * Variante de `asBoolOrFalse` que preserva a distinção entre
 * "ausente/desconhecido" (null) e "false" explícito. Usado por
 * `processaStocks` em sales-lines, onde false → marcar serviço,
 * null → manter conservador.
 */
export function asBoolOrNull(v: unknown): boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    if (t === "1" || t === "true" || t === "y" || t === "s") return true;
    if (t === "0" || t === "false" || t === "n") return false;
    return null;
  }
  return null;
}

export function asIsoDateOrNull(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === "string" && v.trim() !== "") {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}
