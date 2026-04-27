"use server";

import { revalidatePath } from "next/cache";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { controlPrisma } from "@/lib/control-plane";
import { encryptTenantSecret } from "@/lib/tenant-crypto";
import { requirePlatformAdmin } from "@/lib/admin/auth";
import { getTenantPrismaForAdmin } from "@/lib/admin/tenant-client";
import {
  retryOutboxRow,
  cancelOutboxRow,
} from "@/lib/integracao/outbox-admin";
import { logTenantEvent } from "@/lib/control-plane";

/**
 * app/admin/actions.ts
 *
 * Server actions do /admin console. Cada action começa por
 * `requirePlatformAdmin()` — gate forte. Todas escrevem
 * `TenantEvent` para audit trail no control plane.
 */

const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{1,40}[a-z0-9]$/;

type ActionOk<T extends object = object> = { ok: true } & T;
type ActionError = { ok: false; error: string };
type ActionResult<T extends object = object> = ActionOk<T> | ActionError;

function err(message: string): ActionError {
  return { ok: false, error: message };
}

// ─────────────────────────────────────────────────────────────
// Tenant: edit metadados (nome, slug)
// ─────────────────────────────────────────────────────────────

export async function updateTenantMetadataAction(
  tenantId: string,
  input: { nome: string; slug: string; nifGrupo: string | null }
): Promise<ActionResult> {
  const session = await requirePlatformAdmin();
  if (!input.nome.trim()) return err("Nome obrigatório.");
  if (!SLUG_REGEX.test(input.slug)) {
    return err("Slug inválido. Usar [a-z0-9-], 3–42 chars, sem hifens nos extremos.");
  }

  // Slug clash?
  const existingWithSlug = await controlPrisma.tenant.findUnique({
    where: { slug: input.slug },
  });
  if (existingWithSlug && existingWithSlug.id !== tenantId) {
    return err(`Slug "${input.slug}" já em uso por outro tenant.`);
  }

  const tenant = await controlPrisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) return err("Tenant não encontrado.");

  const slugChanged = tenant.slug !== input.slug;

  await controlPrisma.tenant.update({
    where: { id: tenantId },
    data: {
      nome: input.nome.trim(),
      slug: input.slug,
      nifGrupo: input.nifGrupo?.trim() || null,
    },
  });
  await logTenantEvent({
    tenantId,
    action: slugChanged ? "metadata.updated_slug_changed" : "metadata.updated",
    actorId: session.sub,
    meta: {
      from: { slug: tenant.slug, nome: tenant.nome },
      to: { slug: input.slug, nome: input.nome },
      slugChanged,
    },
  });

  revalidatePath(`/admin/tenants/${tenantId}`);
  revalidatePath("/admin/tenants");
  return {
    ok: true,
    ...(slugChanged
      ? {
          warning:
            "Slug alterado. O agent de sincronização (Windows) tem de ser reconfigurado com o novo slug — caso contrário a auth de ingest/outbox vai falhar com 401.",
        }
      : {}),
  };
}

// ─────────────────────────────────────────────────────────────
// Tenant: transição de estado
// ─────────────────────────────────────────────────────────────

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  PROVISIONING: ["ACTIVE", "FAILED"],
  ACTIVE: ["SUSPENDED", "DEACTIVATED"],
  SUSPENDED: ["ACTIVE", "DEACTIVATED"],
  DEACTIVATED: ["ACTIVE"],
  FAILED: ["PROVISIONING", "DEACTIVATED"],
};

export async function transitionTenantStateAction(
  tenantId: string,
  next: "ACTIVE" | "SUSPENDED" | "DEACTIVATED" | "PROVISIONING" | "FAILED"
): Promise<ActionResult> {
  const session = await requirePlatformAdmin();
  const tenant = await controlPrisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) return err("Tenant não encontrado.");

  const allowed = ALLOWED_TRANSITIONS[tenant.estado] ?? [];
  if (!allowed.includes(next)) {
    return err(`Transição ${tenant.estado} → ${next} não permitida.`);
  }

  await controlPrisma.tenant.update({
    where: { id: tenantId },
    data: { estado: next },
  });
  await logTenantEvent({
    tenantId,
    action: `state.${next.toLowerCase()}`,
    actorId: session.sub,
    meta: { from: tenant.estado, to: next },
  });

  revalidatePath(`/admin/tenants/${tenantId}`);
  revalidatePath("/admin/tenants");
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────
// Tenant: registar tenant existente (não provisiona DB!)
// ─────────────────────────────────────────────────────────────

/**
 * Insere um Tenant que aponta a uma BD JÁ EXISTENTE com migrações
 * já aplicadas. NÃO cria a database, NÃO cria o role, NÃO corre
 * migrations. Para esse fluxo completo de criação de zero, usa o
 * CLI: `npm run tenancy:provision` numa workstation com as
 * credenciais de PROVISIONING_ADMIN_*.
 *
 * O tenant é criado em estado PROVISIONING. O administrador deve
 * verificar a saúde com `npm run tenancy:health` e depois transitar
 * para ACTIVE via UI ou CLI.
 */
export async function registerExistingTenantAction(input: {
  slug: string;
  nome: string;
  nifGrupo: string | null;
  dbHost: string;
  dbPort: number;
  dbName: string;
  dbUser: string;
  dbPassword: string;
}): Promise<ActionResult<{ tenantId: string }>> {
  const session = await requirePlatformAdmin();
  if (!SLUG_REGEX.test(input.slug)) {
    return err("Slug inválido. Usar [a-z0-9-], 3–42 chars, sem hifens nos extremos.");
  }
  if (!input.nome.trim()) return err("Nome obrigatório.");
  if (!input.dbHost.trim()) return err("DB host obrigatório.");
  if (!input.dbName.trim()) return err("DB name obrigatório.");
  if (!input.dbUser.trim()) return err("DB user obrigatório.");
  if (!input.dbPassword) return err("DB password obrigatória.");
  if (!Number.isFinite(input.dbPort) || input.dbPort <= 0 || input.dbPort > 65535) {
    return err("DB port inválido.");
  }

  const existing = await controlPrisma.tenant.findUnique({
    where: { slug: input.slug },
  });
  if (existing) return err(`Já existe um tenant com slug "${input.slug}".`);

  const dbPassEncrypted = encryptTenantSecret(input.dbPassword);

  const tenant = await controlPrisma.tenant.create({
    data: {
      slug: input.slug,
      nome: input.nome.trim(),
      nifGrupo: input.nifGrupo?.trim() || null,
      estado: "PROVISIONING",
      dbHost: input.dbHost.trim(),
      dbPort: input.dbPort,
      dbName: input.dbName.trim(),
      dbUser: input.dbUser.trim(),
      dbPassEncrypted,
    },
  });
  await logTenantEvent({
    tenantId: tenant.id,
    action: "registered_via_admin_ui",
    actorId: session.sub,
    meta: {
      slug: input.slug,
      dbHost: input.dbHost,
      dbName: input.dbName,
    },
  });

  revalidatePath("/admin/tenants");
  revalidatePath("/admin");
  return { ok: true, tenantId: tenant.id };
}

// ─────────────────────────────────────────────────────────────
// Tenant: ingest API key — generate / rotate
// ─────────────────────────────────────────────────────────────

/**
 * Gera uma key nova (ou rota a existente — semantica idêntica).
 * A key em CLARO é devolvida UMA VEZ no resultado da action e tem
 * de ser mostrada imediatamente na UI; a partir desse momento só
 * o hash bcrypt persiste.
 */
export async function rotateIngestKeyAction(
  tenantId: string
): Promise<ActionResult<{ plaintextKey: string; issuedAt: string }>> {
  const session = await requirePlatformAdmin();

  const tenant = await controlPrisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) return err("Tenant não encontrado.");

  // 32 bytes random base64url → ~43 chars URL-safe.
  const plaintextKey = `sphmt_${randomBytes(32).toString("base64url")}`;
  const hash = await bcrypt.hash(plaintextKey, 10);
  const issuedAt = new Date();

  await controlPrisma.tenant.update({
    where: { id: tenantId },
    data: {
      ingestApiKeyHash: hash,
      ingestApiKeyIssuedAt: issuedAt,
    },
  });
  await logTenantEvent({
    tenantId,
    action: tenant.ingestApiKeyHash ? "ingest_key.rotated" : "ingest_key.issued",
    actorId: session.sub,
  });

  revalidatePath(`/admin/tenants/${tenantId}`);
  return {
    ok: true,
    plaintextKey,
    issuedAt: issuedAt.toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────
// Farmácias dentro de um tenant (cross-tenant write)
// ─────────────────────────────────────────────────────────────

export async function createFarmaciaInTenantAction(
  tenantId: string,
  input: {
    nome: string;
    codigoANF: string | null;
    morada: string | null;
    contacto: string | null;
  }
): Promise<ActionResult<{ farmaciaId: string }>> {
  const session = await requirePlatformAdmin();
  if (!input.nome.trim()) return err("Nome obrigatório.");

  const tenant = await controlPrisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) return err("Tenant não encontrado.");

  try {
    const prisma = getTenantPrismaForAdmin(tenant);
    const created = await prisma.farmacia.create({
      data: {
        nome: input.nome.trim(),
        codigoANF: input.codigoANF?.trim() || null,
        morada: input.morada?.trim() || null,
        contacto: input.contacto?.trim() || null,
        estado: "ATIVO",
      },
      select: { id: true },
    });
    await logTenantEvent({
      tenantId,
      action: "farmacia.created",
      actorId: session.sub,
      meta: { farmaciaId: created.id, nome: input.nome },
    });
    revalidatePath(`/admin/tenants/${tenantId}`);
    return { ok: true, farmaciaId: created.id };
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

export async function updateFarmaciaInTenantAction(
  tenantId: string,
  farmaciaId: string,
  input: {
    nome: string;
    codigoANF: string | null;
    morada: string | null;
    contacto: string | null;
    estado: "ATIVO" | "INATIVO";
  }
): Promise<ActionResult> {
  const session = await requirePlatformAdmin();
  if (!input.nome.trim()) return err("Nome obrigatório.");

  const tenant = await controlPrisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) return err("Tenant não encontrado.");

  try {
    const prisma = getTenantPrismaForAdmin(tenant);
    await prisma.farmacia.update({
      where: { id: farmaciaId },
      data: {
        nome: input.nome.trim(),
        codigoANF: input.codigoANF?.trim() || null,
        morada: input.morada?.trim() || null,
        contacto: input.contacto?.trim() || null,
        estado: input.estado,
      },
    });
    await logTenantEvent({
      tenantId,
      action: "farmacia.updated",
      actorId: session.sub,
      meta: { farmaciaId, estado: input.estado },
    });
    revalidatePath(`/admin/tenants/${tenantId}`);
    return { ok: true };
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

// ─────────────────────────────────────────────────────────────
// Outbox cross-tenant: retry / cancel a partir do admin
// ─────────────────────────────────────────────────────────────

export async function adminRetryOutboxAction(
  tenantId: string,
  outboxId: string
): Promise<ActionResult> {
  const session = await requirePlatformAdmin();
  const tenant = await controlPrisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) return err("Tenant não encontrado.");
  const prisma = getTenantPrismaForAdmin(tenant);
  const result = await retryOutboxRow(prisma, outboxId, session.sub);
  if (!result.ok) return err(result.error);
  await logTenantEvent({
    tenantId,
    action: "outbox.retry",
    actorId: session.sub,
    meta: { outboxId },
  });
  revalidatePath(`/admin/tenants/${tenantId}`);
  return { ok: true };
}

export async function adminCancelOutboxAction(
  tenantId: string,
  outboxId: string,
  reason: string | null
): Promise<ActionResult> {
  const session = await requirePlatformAdmin();
  const tenant = await controlPrisma.tenant.findUnique({ where: { id: tenantId } });
  if (!tenant) return err("Tenant não encontrado.");
  const prisma = getTenantPrismaForAdmin(tenant);
  const result = await cancelOutboxRow(prisma, outboxId, session.sub, reason);
  if (!result.ok) return err(result.error);
  await logTenantEvent({
    tenantId,
    action: "outbox.cancel",
    actorId: session.sub,
    meta: { outboxId, reason },
  });
  revalidatePath(`/admin/tenants/${tenantId}`);
  return { ok: true };
}
