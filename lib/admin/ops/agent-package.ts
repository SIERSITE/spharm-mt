import "server-only";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { controlPrisma, logTenantEvent } from "@/lib/control-plane";
import { getTenantPrismaForAdmin } from "@/lib/admin/tenant-client";
import { AdminApiError, resolveActiveTenant } from "@/lib/admin/ops/_shared";

/**
 * lib/admin/ops/agent-package.ts
 *
 * Parte SERVIDOR do "gerar Agent ZIP". A operação privilegiada —
 * emitir/rotacionar a ingest key no control plane — corre aqui. O
 * empacotamento físico (descarregar o template base, injectar
 * agent.config.json, zipar) é feito pelo wizard localmente, porque o
 * template base (~67MB com node.exe) está em object storage e NÃO cabe
 * numa função Vercel. Ver docs/admin-wizard.md.
 *
 * Equivalente HTTP (parcial) de `scripts/admin/package-agent.ts`.
 */

const BCRYPT_COST = 10;
const KEY_BYTES = 32;
const HEX_KEY_RE = /^[0-9a-f]{64}$/i;

export type AgentPackageInput = {
  slug: string;
  /** Chave primária preferida (cuid da farmácia). Tem precedência. */
  farmaciaId?: string | null;
  /** Nome (ou id) da farmácia. Usado se farmaciaId não vier. Compat. */
  farmacia?: string | null;
  endpoint?: string | null;
  /** Key existente em claro (64 hex). Mutuamente exclusiva com rotate. */
  key?: string | null;
  /** Emitir nova key, invalidando a anterior. */
  rotate?: boolean;
  healthcheckUrl?: string | null;
  sqlHost?: string | null;
  sqlPort?: string | number | null;
  sqlDatabase?: string | null;
  sqlUser?: string | null;
  sqlPassword?: string | null;
};

export type AgentConfig = {
  _doc: string;
  saas: {
    endpoint: string;
    tenantSlug: string;
    ingestKey: string;
    farmacia: string;
    healthcheckUrl?: string;
  };
  sqlServer: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    encrypt: boolean;
    trustServerCertificate: boolean;
  };
  options: { outputDir: string; agentVersion: string };
};

export type AgentPackageResult = {
  tenantSlug: string;
  /** Nome (string) tal como vai no config — canonico vindo da BD. */
  farmacia: string;
  /** cuid da farmácia resolvida na BD do tenant. */
  farmaciaId: string;
  /** Nome canonico da farmácia (igual a `farmacia`). */
  farmaciaNome: string;
  endpoint: string;
  keyAction: "rotated" | "issued" | "provided";
  /** Plain key — só quando issued/rotated. Não recuperável depois. */
  key: string | null;
  /** Config a escrever em agent.config.json dentro do ZIP. */
  config: AgentConfig;
  /** URL do template base do agente em object storage. null se não configurado. */
  baseAgentUrl: string | null;
  /** Nome de pasta/ZIP sugerido (o wizard usa para nomear o output). */
  suggestedName: string;
  sqlPasswordIsPlaceholder: boolean;
};

const SQL_PASSWORD_PLACEHOLDER = "COMPLETAR_PASSWORD_NO_PC_DA_FARMACIA";

export async function prepareAgentPackage(
  input: AgentPackageInput
): Promise<AgentPackageResult> {
  const farmaciaId = (input.farmaciaId ?? "").trim();
  const farmacia = (input.farmacia ?? "").trim();
  if (farmaciaId === "" && farmacia === "") {
    throw new AdminApiError(400, "farmaciaId ou farmacia é obrigatório", "bad_request");
  }
  if (input.key && input.rotate) {
    throw new AdminApiError(400, "key e rotate são mutuamente exclusivos", "bad_request");
  }
  if (input.key && !HEX_KEY_RE.test(input.key)) {
    throw new AdminApiError(400, "key deve ser 64 chars hex (256-bit)", "bad_request");
  }

  const endpoint =
    input.endpoint?.trim() ||
    process.env.SPHARMMT_PUBLIC_ENDPOINT ||
    "https://app.spharmmt.app";
  if (!/^https?:\/\//.test(endpoint)) {
    throw new AdminApiError(400, `endpoint inválido: ${endpoint}`, "bad_request");
  }

  const tenant = await resolveActiveTenant(input.slug);

  // ── Resolver a farmácia na BD do tenant (id + nome canonico) ──────
  // Preferir farmaciaId (chave primária, imune a acentos/encoding); cair
  // para nome-ou-id (compat). Usamos o nome canonico da BD no
  // agent.config.json para casar com o /api/ingest/v1/farmacias do agent.
  const prisma = getTenantPrismaForAdmin(tenant);
  const farmaciaRow = farmaciaId
    ? await prisma.farmacia.findUnique({
        where: { id: farmaciaId },
        select: { id: true, nome: true },
      })
    : await prisma.farmacia.findFirst({
        where: { OR: [{ id: farmacia }, { nome: farmacia }] },
        select: { id: true, nome: true },
      });
  if (!farmaciaRow) {
    const ref = farmaciaId ? `id "${farmaciaId}"` : `"${farmacia}"`;
    throw new AdminApiError(
      404,
      `farmácia ${ref} não encontrada no tenant "${tenant.slug}"`,
      "farmacia_not_found"
    );
  }

  // ── Resolver ingest key ───────────────────────────────────────────
  let plainKey: string;
  let keyAction: AgentPackageResult["keyAction"];

  if (input.key) {
    plainKey = input.key.toLowerCase();
    keyAction = "provided";
    // Não validamos contra o hash (bcrypt é caro; admin é responsável).
  } else {
    if (tenant.ingestApiKeyHash && !input.rotate) {
      throw new AdminApiError(
        409,
        `tenant "${tenant.slug}" já tem ingest key. Forneça a key existente ou use rotate.`,
        "key_exists"
      );
    }
    plainKey = randomBytes(KEY_BYTES).toString("hex");
    const hash = await bcrypt.hash(plainKey, BCRYPT_COST);
    const issuedAt = new Date();
    await controlPrisma.tenant.update({
      where: { id: tenant.id },
      data: { ingestApiKeyHash: hash, ingestApiKeyIssuedAt: issuedAt },
    });
    await logTenantEvent({
      tenantId: tenant.id,
      action: tenant.ingestApiKeyHash ? "ingest_key_rotated" : "ingest_key_issued",
      meta: { issuedAt: issuedAt.toISOString(), via: "admin-api/agent-package" },
    });
    keyAction = tenant.ingestApiKeyHash ? "rotated" : "issued";
  }

  // ── agent.config.json ─────────────────────────────────────────────
  const sqlPassword = input.sqlPassword?.trim() || SQL_PASSWORD_PLACEHOLDER;
  const config: AgentConfig = {
    _doc:
      `Configuração SPharm.MT agent para tenant=${tenant.slug}. ` +
      `Gerado por admin-api em ${new Date().toISOString()}. ` +
      `NUNCA commitar nem partilhar fora do contexto seguro.`,
    saas: {
      endpoint,
      tenantSlug: tenant.slug,
      ingestKey: plainKey,
      farmacia: farmaciaRow.nome,
      ...(input.healthcheckUrl?.trim()
        ? { healthcheckUrl: input.healthcheckUrl.trim() }
        : {}),
    },
    sqlServer: {
      host: input.sqlHost?.trim() || "localhost",
      port: input.sqlPort ? parseInt(String(input.sqlPort), 10) || 1433 : 1433,
      database: input.sqlDatabase?.trim() || "SPHARM",
      user: input.sqlUser?.trim() || "spharm_readonly",
      password: sqlPassword,
      encrypt: false,
      trustServerCertificate: true,
    },
    options: { outputDir: "output", agentVersion: "0.1.0" },
  };

  const date = new Date().toISOString().slice(0, 10);
  const stamp = randomBytes(3).toString("hex");

  return {
    tenantSlug: tenant.slug,
    farmacia: farmaciaRow.nome,
    farmaciaId: farmaciaRow.id,
    farmaciaNome: farmaciaRow.nome,
    endpoint,
    keyAction,
    key: keyAction === "provided" ? null : plainKey,
    config,
    baseAgentUrl: process.env.AGENT_BASE_ZIP_URL ?? null,
    suggestedName: `${tenant.slug}-${date}-${stamp}`,
    sqlPasswordIsPlaceholder: sqlPassword === SQL_PASSWORD_PLACEHOLDER,
  };
}
