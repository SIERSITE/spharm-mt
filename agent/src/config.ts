/**
 * agent/src/config.ts
 *
 * Carrega e valida configuração do `.env` local. Não importa nada do
 * repo SaaS — duplicação consciente para que o agent seja deployable
 * standalone (sem `lib/env.ts` do SaaS).
 *
 * Cada comando declara que envs precisa via `loadConfig(scope)`. O
 * scope determina quais envs são obrigatórias para esse comando.
 */

import "dotenv/config";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Raiz do agent (folder pai de src/). Usada para resolver paths de
 * output e .env. Sobrevive a tsx, ESM, build compilado para dist/.
 */
export const AGENT_ROOT = path.resolve(__dirname, "..");

export type Scope =
  /** Comandos que só falam com a SaaS (ex: heartbeat futuro). */
  | "saas"
  /** Comandos que só falam com o SQL Server (ex: discover). */
  | "sql"
  /** Comandos que precisam de ambos (test-connection, bootstrap, daily-sync). */
  | "both";

export type AgentConfig = {
  // SaaS
  saasEndpoint: string;
  tenantSlug: string;
  ingestKey: string;
  farmacia?: string;
  // SQL Server
  sqlHost: string;
  sqlPort: number;
  sqlDatabase: string;
  sqlUser: string;
  sqlPassword: string;
  sqlEncrypt: boolean;
  sqlTrustCert: boolean;
  // Output
  outputDir: string;
  // Misc
  agentVersion: string;
};

/** Erro tipado — caller pode imprimir lista completa de falhas. */
export class ConfigError extends Error {
  constructor(
    message: string,
    public readonly missing: string[]
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

function requireEnv(name: string, missing: string[]): string {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") {
    missing.push(name);
    return "";
  }
  return raw;
}

function optionalEnv(name: string): string | undefined {
  const raw = process.env[name];
  return raw && raw.trim() !== "" ? raw : undefined;
}

function boolEnv(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const norm = raw.toLowerCase().trim();
  return norm === "1" || norm === "true" || norm === "yes";
}

function intEnv(name: string, defaultValue: number, min?: number, max?: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return defaultValue;
  if (min !== undefined && n < min) return min;
  if (max !== undefined && n > max) return max;
  return n;
}

const REQUIRED_BY_SCOPE: Record<Scope, ("saas" | "sql")[]> = {
  saas: ["saas"],
  sql: ["sql"],
  both: ["saas", "sql"],
};

const SAAS_REQUIRED = ["SPHARMMT_ENDPOINT", "SPHARMMT_TENANT_SLUG", "SPHARMMT_INGEST_KEY"];
const SQL_REQUIRED = [
  "ERP_SQLSERVER_HOST",
  "ERP_SQLSERVER_DATABASE",
  "ERP_SQLSERVER_USER",
  "ERP_SQLSERVER_PASSWORD",
];

/**
 * Carrega config para o scope dado. Lança `ConfigError` listando
 * TODAS as envs em falta (não atira na primeira — diagnose completo
 * no primeiro arranque).
 */
export function loadConfig(scope: Scope): AgentConfig {
  const groups = REQUIRED_BY_SCOPE[scope];
  const missing: string[] = [];

  const need = (name: string) => requireEnv(name, missing);

  // Sempre tenta carregar todos os campos (lê mesmo os opcionais
  // para popular a struct). Só marca em falta os que pertencem ao
  // scope pedido.
  const wantsSaas = groups.includes("saas");
  const wantsSql = groups.includes("sql");

  const saasEndpoint = wantsSaas
    ? need("SPHARMMT_ENDPOINT")
    : (optionalEnv("SPHARMMT_ENDPOINT") ?? "");
  const tenantSlug = wantsSaas
    ? need("SPHARMMT_TENANT_SLUG")
    : (optionalEnv("SPHARMMT_TENANT_SLUG") ?? "");
  const ingestKey = wantsSaas
    ? need("SPHARMMT_INGEST_KEY")
    : (optionalEnv("SPHARMMT_INGEST_KEY") ?? "");
  const farmacia = optionalEnv("SPHARMMT_FARMACIA");

  const sqlHost = wantsSql
    ? need("ERP_SQLSERVER_HOST")
    : (optionalEnv("ERP_SQLSERVER_HOST") ?? "");
  const sqlDatabase = wantsSql
    ? need("ERP_SQLSERVER_DATABASE")
    : (optionalEnv("ERP_SQLSERVER_DATABASE") ?? "");
  const sqlUser = wantsSql
    ? need("ERP_SQLSERVER_USER")
    : (optionalEnv("ERP_SQLSERVER_USER") ?? "");
  const sqlPassword = wantsSql
    ? need("ERP_SQLSERVER_PASSWORD")
    : (optionalEnv("ERP_SQLSERVER_PASSWORD") ?? "");

  // Validações que não envolvem env-missing (formato, etc.)
  if (wantsSaas && saasEndpoint && !/^https?:\/\//.test(saasEndpoint)) {
    missing.push(`SPHARMMT_ENDPOINT (formato inválido — deve começar por http(s)://)`);
  }
  if (wantsSaas && saasEndpoint && saasEndpoint.endsWith("/")) {
    // Sem trailing slash — concatenação fica previsível em http-client
    process.env.SPHARMMT_ENDPOINT = saasEndpoint.replace(/\/+$/, "");
  }

  if (missing.length > 0) {
    const labelled = missing.map((m) => `  · ${m}`).join("\n");
    throw new ConfigError(
      `${missing.length} env(s) obrigatória(s) em falta ou inválida(s) para scope=${scope}:\n${labelled}\n\nVer .env.example para o template completo.`,
      missing
    );
  }

  const sqlPort = intEnv("ERP_SQLSERVER_PORT", 1433, 1, 65535);
  const sqlEncrypt = boolEnv("ERP_SQLSERVER_ENCRYPT", false);
  const sqlTrustCert = boolEnv("ERP_SQLSERVER_TRUST_CERT", true);

  const outputDir =
    optionalEnv("SPHARMMT_AGENT_OUTPUT_DIR") ?? path.join(AGENT_ROOT, "output");

  const agentVersion = optionalEnv("SPHARMMT_AGENT_VERSION") ?? "0.1.0";

  return {
    saasEndpoint: (process.env.SPHARMMT_ENDPOINT ?? saasEndpoint).replace(/\/+$/, ""),
    tenantSlug,
    ingestKey,
    farmacia,
    sqlHost,
    sqlPort,
    sqlDatabase,
    sqlUser,
    sqlPassword,
    sqlEncrypt,
    sqlTrustCert,
    outputDir,
    agentVersion,
  };
}

/** Mascara um string sensível para logs: "xxxxxxx" → "x*****x". */
export function maskSecret(value: string): string {
  if (!value) return "";
  if (value.length <= 4) return "*".repeat(value.length);
  return value[0] + "*".repeat(Math.max(value.length - 2, 4)) + value[value.length - 1];
}

/** Resumo público (sem secrets) — usado por `health`. */
export function describeConfig(cfg: AgentConfig): Record<string, string> {
  return {
    saasEndpoint: cfg.saasEndpoint || "(unset)",
    tenantSlug: cfg.tenantSlug || "(unset)",
    ingestKey: cfg.ingestKey ? maskSecret(cfg.ingestKey) : "(unset)",
    farmacia: cfg.farmacia ?? "(unset — usa SPHARMMT_FARMACIA para bind)",
    sqlHost: cfg.sqlHost ? `${cfg.sqlHost}:${cfg.sqlPort}` : "(unset)",
    sqlDatabase: cfg.sqlDatabase || "(unset)",
    sqlUser: cfg.sqlUser ? maskSecret(cfg.sqlUser) : "(unset)",
    sqlPassword: cfg.sqlPassword ? "***" : "(unset)",
    sqlEncrypt: String(cfg.sqlEncrypt),
    sqlTrustCert: String(cfg.sqlTrustCert),
    outputDir: cfg.outputDir,
    agentVersion: cfg.agentVersion,
  };
}
