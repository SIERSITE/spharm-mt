import "dotenv/config";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import pg from "pg";

/**
 * Helpers partilhados por todos os scripts de tenancy.
 *
 * Contém:
 *  · validação de env vars necessárias
 *  · construção de cliente pg admin (CREATE DATABASE/ROLE)
 *  · geração de identificadores de DB a partir do slug
 *  · geração de password aleatória
 *  · wrapper para `prisma migrate deploy` contra uma URL específica
 *  · parse CLI via node:util.parseArgs (sem deps extras)
 */

export const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{1,40}[a-z0-9]$/;

/** Exit com mensagem se qualquer env obrigatória do control plane falhar. */
export function requireControlEnv(): void {
  const missing: string[] = [];
  if (!process.env.CONTROL_DATABASE_URL) missing.push("CONTROL_DATABASE_URL");
  if (!process.env.TENANT_ENCRYPTION_SECRET) missing.push("TENANT_ENCRYPTION_SECRET");
  if (missing.length > 0) {
    console.error(`[tenancy] env em falta: ${missing.join(", ")}`);
    process.exit(1);
  }
}

/**
 * Env extra só necessária para operações que criam/destroem DBs ou
 * roles (provision-tenant e destroy-tenant). Outras operações (list,
 * migrate, health) não precisam.
 */
export function requireAdminEnv(): void {
  const missing: string[] = [];
  if (!process.env.POSTGRES_ADMIN_URL) missing.push("POSTGRES_ADMIN_URL");
  if (!process.env.TENANT_DB_HOST) missing.push("TENANT_DB_HOST");
  if (missing.length > 0) {
    console.error(`[tenancy] env em falta para operações admin: ${missing.join(", ")}`);
    process.exit(1);
  }
}

/** Converte slug "grupo-braga" → identificadores SQL "grupo_braga". */
export function slugToDbNames(slug: string): { dbUser: string; dbName: string } {
  if (!SLUG_REGEX.test(slug)) {
    throw new Error(
      `slug inválido: "${slug}". Usa /^[a-z0-9][a-z0-9-]{1,40}[a-z0-9]$/.`
    );
  }
  const safe = slug.replace(/-/g, "_");
  return {
    dbUser: `spharmmt_${safe}`,
    dbName: `spharmmt_t_${safe}`,
  };
}

/** Password aleatória 24 bytes base64url. 32 chars, URL-safe. */
export function generatePassword(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

/** Escape de identificador SQL (double-quoted). */
export function quoteIdent(name: string): string {
  if (!/^[a-zA-Z0-9_]+$/.test(name)) {
    throw new Error(`Identificador SQL inválido: ${name}`);
  }
  return `"${name}"`;
}

/** Escape de literal SQL (single-quoted). Só para valores que o pg
 *  não consegue parameterizar (ex: CREATE ROLE ... PASSWORD '...'). */
export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Admin pg.Client — criar/destruir DBs e roles. Fecha no end(). */
export async function openAdminClient(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: process.env.POSTGRES_ADMIN_URL });
  await client.connect();
  return client;
}

/** Constrói URL Postgres a partir de {host, port, dbName, user, password}. */
export function buildPgUrl(opts: {
  host: string;
  port: number;
  dbName: string;
  user: string;
  password: string;
}): string {
  return `postgresql://${encodeURIComponent(opts.user)}:${encodeURIComponent(opts.password)}@${opts.host}:${opts.port}/${opts.dbName}`;
}

/**
 * Corre `prisma migrate deploy` (ou outro subcomando) contra uma
 * connection string específica. O `prisma.config.ts` lê DATABASE_URL,
 * logo injectamos via env do processo filho.
 */
export function runPrismaForTenant(
  args: string[],
  databaseUrl: string
): { status: number; stdout?: string; stderr?: string } {
  const result = spawnSync("npx", ["prisma", ...args], {
    stdio: "pipe",
    env: { ...process.env, DATABASE_URL: databaseUrl },
    shell: process.platform === "win32",
    encoding: "utf8",
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout?.toString(),
    stderr: result.stderr?.toString(),
  };
}

/**
 * Lê o nome da última migration em prisma/migrations (ordenação
 * alfabética — todas têm timestamp como prefixo). Usado para registar
 * schemaVersion no control plane.
 */
export function getLatestMigrationName(): string | null {
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  try {
    const migrationsDir = path.join(process.cwd(), "prisma", "migrations");
    const entries = fs
      .readdirSync(migrationsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    return entries[entries.length - 1] ?? null;
  } catch {
    return null;
  }
}
