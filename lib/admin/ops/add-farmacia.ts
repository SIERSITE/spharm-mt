import "server-only";
import { getTenantPrismaForAdmin } from "@/lib/admin/tenant-client";
import { AdminApiError, resolveActiveTenant } from "@/lib/admin/ops/_shared";

/**
 * lib/admin/ops/add-farmacia.ts
 *
 * Equivalente HTTP de `scripts/tenancy/add-farmacia.ts` (DEV CLI).
 * Mesma lógica: resolver tenant ACTIVE → detectar duplicado por nome →
 * INSERT Farmacia (ATIVO) → devolver criada + lista completa.
 */

export type AddFarmaciaInput = {
  slug: string;
  nome: string;
  codigo?: string | null;
  morada?: string | null;
  contacto?: string | null;
};

export type FarmaciaRow = {
  id: string;
  nome: string;
  codigoANF: string | null;
  estado: string;
};

export type AddFarmaciaResult = {
  tenantSlug: string;
  created: FarmaciaRow & { dataCriacao: string };
  farmacias: FarmaciaRow[];
};

export async function addFarmacia(
  input: AddFarmaciaInput
): Promise<AddFarmaciaResult> {
  const nome = (input.nome ?? "").trim();
  if (nome === "") {
    throw new AdminApiError(400, "nome é obrigatório", "bad_request");
  }
  if (nome.length > 200) {
    throw new AdminApiError(400, "nome deve ter ≤ 200 caracteres", "bad_request");
  }
  const codigoANF = input.codigo?.trim() || null;
  if (codigoANF && codigoANF.length > 50) {
    throw new AdminApiError(400, "código deve ter ≤ 50 caracteres", "bad_request");
  }

  const tenant = await resolveActiveTenant(input.slug);
  const prisma = getTenantPrismaForAdmin(tenant);

  const existing = await prisma.farmacia.findFirst({
    where: { nome },
    select: { id: true, estado: true },
  });
  if (existing) {
    throw new AdminApiError(
      409,
      `farmácia "${nome}" já existe (id=${existing.id}, estado=${existing.estado})`,
      "duplicate"
    );
  }

  const created = await prisma.farmacia.create({
    data: {
      nome,
      codigoANF,
      morada: input.morada?.trim() || null,
      contacto: input.contacto?.trim() || null,
      estado: "ATIVO",
    },
    select: {
      id: true,
      nome: true,
      codigoANF: true,
      estado: true,
      dataCriacao: true,
    },
  });

  const all = await prisma.farmacia.findMany({
    select: { id: true, nome: true, codigoANF: true, estado: true },
    orderBy: { nome: "asc" },
  });

  return {
    tenantSlug: tenant.slug,
    created: {
      id: created.id,
      nome: created.nome,
      codigoANF: created.codigoANF,
      estado: created.estado,
      dataCriacao: created.dataCriacao.toISOString(),
    },
    farmacias: all,
  };
}
