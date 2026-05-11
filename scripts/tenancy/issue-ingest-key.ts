/**
 * scripts/tenancy/issue-ingest-key.ts
 *
 * Emite (ou roda) a ingest API key de um tenant. A chave é usada
 * pelo agent/cliente da farmácia em todos os requests para
 * `/api/ingest/v1/*` e `/api/outbox/v1/*` (mesmo bearer cobre upstream
 * e downstream — ver `lib/integracao/auth.ts`).
 *
 * Política de segurança:
 *   · A chave em claro é gerada por `crypto.randomBytes(32)` (32 bytes
 *     hex = 64 chars) — entropia adequada.
 *   · O hash bcrypt (cost 10) é persistido em `Tenant.ingestApiKeyHash`.
 *   · A chave em claro é impressa APENAS uma vez no stdout — nunca
 *     mais é recuperável. Operador tem de a anotar imediatamente.
 *   · Re-emitir invalida a chave anterior (rotação). Por defeito,
 *     o script recusa se já houver chave emitida — usar `--rotate`
 *     para forçar.
 *
 * Audit: emite `TenantEvent` com action="ingest_key_issued" e meta
 * `{ keyIssuedAt }`. Não regista o hash (já está no `Tenant`).
 *
 * Uso:
 *   npx tsx scripts/tenancy/issue-ingest-key.ts --slug=farmacias-braga
 *   npx tsx scripts/tenancy/issue-ingest-key.ts --slug=farmacias-braga --rotate
 */

import "dotenv/config";
import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { controlPrisma, getTenantBySlug, logTenantEvent } from "@/lib/control-plane";
import { requireControlEnv } from "./_shared";

const BCRYPT_COST = 10;
/** 32 bytes = 64 hex chars. Equivalente a ~256 bits de entropia. */
const KEY_BYTES = 32;

async function main(): Promise<void> {
  requireControlEnv();

  const { values } = parseArgs({
    options: {
      slug: { type: "string" },
      rotate: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (!values.slug) {
    console.error("Uso: --slug X [--rotate]");
    process.exit(1);
  }

  const tenant = await getTenantBySlug(values.slug);
  if (!tenant) {
    console.error(`Tenant "${values.slug}" não encontrado no control plane.`);
    process.exit(1);
  }

  if (tenant.estado !== "ACTIVE") {
    console.error(
      `Tenant "${values.slug}" está em estado ${tenant.estado}. ` +
        `Só faz sentido emitir chave para tenants ACTIVE.`,
    );
    process.exit(1);
  }

  if (tenant.ingestApiKeyHash && !values.rotate) {
    console.error(
      `Tenant "${values.slug}" já tem ingest key emitida (issuedAt=${tenant.ingestApiKeyIssuedAt?.toISOString() ?? "—"}).\n` +
        `Para rodar (invalidando a anterior) usa: --rotate`,
    );
    process.exit(1);
  }

  // ── Gerar key + hash ──────────────────────────────────────────────
  const plainKey = randomBytes(KEY_BYTES).toString("hex");
  const hash = await bcrypt.hash(plainKey, BCRYPT_COST);
  const issuedAt = new Date();

  // ── Persistir hash no control plane ───────────────────────────────
  await controlPrisma.tenant.update({
    where: { id: tenant.id },
    data: {
      ingestApiKeyHash: hash,
      ingestApiKeyIssuedAt: issuedAt,
    },
  });

  await logTenantEvent({
    tenantId: tenant.id,
    action: values.rotate ? "ingest_key_rotated" : "ingest_key_issued",
    meta: { issuedAt: issuedAt.toISOString() },
  });

  // ── Output accionável ─────────────────────────────────────────────
  console.log("─".repeat(78));
  console.log(`Ingest key ${values.rotate ? "ROTATED" : "ISSUED"} para tenant ${tenant.slug}`);
  console.log("─".repeat(78));
  console.log(`  Tenant: ${tenant.nome}`);
  console.log(`  Slug:   ${tenant.slug}`);
  console.log(`  Issued: ${issuedAt.toISOString()}`);
  if (values.rotate) {
    console.log(`  ⚠️  A chave anterior foi INVALIDADA. Qualquer agent que use a antiga vai começar a receber 401.`);
  }
  console.log("");
  console.log("─".repeat(78));
  console.log("CHAVE EM CLARO — anotar AGORA (não é recuperável):");
  console.log("─".repeat(78));
  console.log(`  ${plainKey}`);
  console.log("");
  console.log("─".repeat(78));
  console.log("Configurar no agent / cliente da farmácia:");
  console.log("─".repeat(78));
  console.log(`  Authorization: Bearer ${plainKey}`);
  console.log(`  X-Tenant-Slug: ${tenant.slug}`);
  console.log("");
  console.log(`Validar: curl -X POST -H "Authorization: Bearer <key>" \\`);
  console.log(`              -H "X-Tenant-Slug: ${tenant.slug}" \\`);
  console.log(`              https://<deploy>/api/outbox/v1/heartbeat`);
  console.log("");
}

main()
  .catch((err) => {
    console.error("[fatal]", err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(() => controlPrisma.$disconnect());
