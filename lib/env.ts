/**
 * lib/env.ts
 *
 * Schema único de variáveis de ambiente da plataforma. Cada chave é
 * classificada por scope (em que contexto é obrigatória) e por nível
 * (required / recommended / optional). Helpers de validação dão
 * fail-fast com mensagem accionável.
 *
 * Scope:
 *   · "web"   — Next.js runtime (server components, route handlers,
 *               server actions). Faltar uma chave required deste
 *               scope = `/admin` / dashboard / encomendas em erro 500.
 *   · "cron"  — endpoint `/api/jobs/refresh-ipf` e wrappers
 *               schedulers. Faltar = cron job recusa (HTTP 503).
 *   · "cli"   — scripts CLI de tenancy / ingestão / manutenção.
 *               Faltar = script falha-rápido com instrução de fix.
 *   · "ingest"— API de ingest do agent Windows. Sem isto não há
 *               upload de dados.
 *
 * Nível:
 *   · required    — sistema não arranca / endpoint recusa
 *   · recommended — degraded mode aceitável mas deve ser configurado
 *                   antes de produção
 *   · optional    — afina comportamento; sem default razoável
 *
 * Use:
 *   import { requireEnv, validateEnvOrThrow } from "@/lib/env";
 *   const url = requireEnv("CONTROL_DATABASE_URL"); // throws se vazio
 *
 *   // No arranque de um script CLI:
 *   validateEnvOrThrow(["DATABASE_URL", "TENANT_ENCRYPTION_SECRET"]);
 *
 * Sem `import "server-only"` — testes e scripts CLI também importam.
 */

export type EnvScope = "web" | "cron" | "cli" | "ingest";
export type EnvLevel = "required" | "recommended" | "optional";

export type EnvSpec = {
  name: string;
  scopes: EnvScope[];
  level: EnvLevel;
  description: string;
  /** Exemplo de valor — informativo. Nunca contém segredo real. */
  example?: string;
};

/**
 * Catálogo completo das envs reconhecidas pela plataforma. Adicionar
 * aqui qualquer nova env antes de a usar — central source of truth.
 */
export const ENV_CATALOG: EnvSpec[] = [
  // ── Bases de dados ─────────────────────────────────────────────────
  {
    name: "DATABASE_URL",
    scopes: ["web", "cli", "ingest", "cron"],
    level: "required",
    description:
      "Connection string Postgres da BD legacy (ou tenant default em multi-tenant). Sem isto, Prisma não arranca.",
    example: "postgres://user:pass@host/db?sslmode=require",
  },
  {
    name: "CONTROL_DATABASE_URL",
    scopes: ["web", "cli"],
    level: "required",
    description:
      "Connection string para o control plane (registo de tenants). Falta → /admin 500, tenant:onboard falha.",
    example: "postgres://user:pass@host/spharmmt_control?sslmode=require",
  },
  {
    name: "TENANT_ENCRYPTION_SECRET",
    scopes: ["web", "cli"],
    level: "required",
    description:
      "Chave AES-256-GCM para cifrar Tenant.dbPassEncrypted. Gerar com `openssl rand -hex 32`. Nunca rodar sem migrar BDs.",
    example: "64-char-hex-string",
  },
  // ── Tenant provisioning ────────────────────────────────────────────
  {
    name: "TENANT_DB_HOST",
    scopes: ["cli"],
    level: "required",
    description:
      "Host Postgres onde as BDs por-tenant são criadas. Em Neon, é o pooler do projecto (ex: ep-xxx-pooler.eu-central-1.aws.neon.tech).",
    example: "ep-xxxx.eu-central-1.aws.neon.tech",
  },
  {
    name: "TENANT_DB_PORT",
    scopes: ["cli"],
    level: "optional",
    description: "Porta Postgres. Default 5432. Em Neon é sempre 5432.",
    example: "5432",
  },
  {
    name: "POSTGRES_ADMIN_URL",
    scopes: ["cli"],
    level: "required",
    description:
      "Connection string com privilégios CREATEDB / CREATE ROLE. Em Neon, role owner do projecto. Usada APENAS por `provision-tenant.ts` para criar BDs novas.",
    example: "postgres://owner:pass@host/postgres?sslmode=require",
  },
  // ── Auth ───────────────────────────────────────────────────────────
  {
    name: "AUTH_SECRET",
    scopes: ["web"],
    level: "required",
    description:
      "Secret para JWT/session sign. Gerar com `openssl rand -base64 32`.",
  },
  {
    name: "PLATFORM_ADMIN_EMAILS",
    scopes: ["web"],
    level: "recommended",
    description:
      "Lista CSV de emails com acesso ao /admin. Sem isto, ninguém consegue gerir tenants pelo portal.",
    example: "admin@spharm.mt,ops@spharm.mt",
  },
  // ── Cron ───────────────────────────────────────────────────────────
  {
    name: "CRON_SECRET",
    scopes: ["cron"],
    level: "required",
    description:
      "Bearer secret que o Vercel Cron injecta no header Authorization quando dispara /api/jobs/*. Sem isto, cron jobs recusam (HTTP 503).",
    example: "openssl rand -hex 24",
  },
  // ── Email ──────────────────────────────────────────────────────────
  {
    name: "EMAIL_CONFIG_SECRET",
    scopes: ["web"],
    level: "recommended",
    description:
      "AES key para cifrar credenciais de email das farmácias. Sem isto, agendamento de email cai em modo degradado.",
  },
  // ── Misc ───────────────────────────────────────────────────────────
  {
    name: "OUTBOX_MAX_ATTEMPTS",
    scopes: ["ingest"],
    level: "optional",
    description: "Nº máximo de tentativas de export de uma OrderOutbox. Default 5.",
  },
  {
    name: "SPHARM_DEBUG_BROWSE",
    scopes: ["cli"],
    level: "optional",
    description:
      "Quando '1', activa logs verbosos do browser Puppeteer em scripts de scraping INFARMED.",
  },
  {
    name: "NODE_ENV",
    scopes: ["web", "cron", "cli", "ingest"],
    level: "optional",
    description: "Standard Next.js. Production / development. Inferido pelo runner.",
  },
];

const CATALOG_BY_NAME = new Map(ENV_CATALOG.map((spec) => [spec.name, spec]));

export class EnvValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvValidationError";
  }
}

/**
 * Retorna o valor da env. Atira `EnvValidationError` se vazia.
 * Mensagem inclui description + example para diagnóstico imediato.
 */
export function requireEnv(name: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === "") {
    const spec = CATALOG_BY_NAME.get(name);
    const hint = spec
      ? `\n  ${spec.description}${spec.example ? `\n  Exemplo: ${spec.example}` : ""}`
      : "";
    throw new EnvValidationError(`Env obrigatória em falta: ${name}${hint}`);
  }
  return raw;
}

/** Tem o valor se presente; null se vazio. */
export function optionalEnv(name: string): string | null {
  const raw = process.env[name];
  return raw === undefined || raw === null || raw === "" ? null : raw;
}

/** Boolean parsing — "1"|"true"|"yes" são truthy; tudo o resto false. */
export function boolEnv(name: string, defaultValue = false): boolean {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const norm = raw.toLowerCase().trim();
  return norm === "1" || norm === "true" || norm === "yes";
}

/** Int parsing com default + clamp. */
export function intEnv(name: string, defaultValue: number, min?: number, max?: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return defaultValue;
  if (min !== undefined && n < min) return min;
  if (max !== undefined && n > max) return max;
  return n;
}

/**
 * Valida que todas as envs `required` para o scope dado estão
 * presentes. Atira `EnvValidationError` com lista completa de falhas
 * (não pára na primeira — facilita debug).
 */
export function validateScope(scope: EnvScope): void {
  const missing: EnvSpec[] = [];
  for (const spec of ENV_CATALOG) {
    if (spec.level !== "required") continue;
    if (!spec.scopes.includes(scope)) continue;
    const raw = process.env[spec.name];
    if (raw === undefined || raw === null || raw === "") missing.push(spec);
  }
  if (missing.length === 0) return;
  const lines = missing.map((s) => `  · ${s.name}: ${s.description}${s.example ? ` (ex: ${s.example})` : ""}`);
  throw new EnvValidationError(
    `${missing.length} env(s) obrigatória(s) em falta para scope=${scope}:\n${lines.join("\n")}`,
  );
}

/**
 * Verifica uma lista ad-hoc de envs. Usado por scripts CLI que querem
 * a sua própria selecção (ex: provision-tenant.ts).
 */
export function validateEnvOrThrow(names: string[]): void {
  const missing = names.filter((n) => {
    const raw = process.env[n];
    return raw === undefined || raw === null || raw === "";
  });
  if (missing.length === 0) return;
  const lines = missing.map((n) => {
    const spec = CATALOG_BY_NAME.get(n);
    return `  · ${n}${spec ? `: ${spec.description}` : ""}${spec?.example ? ` (ex: ${spec.example})` : ""}`;
  });
  throw new EnvValidationError(
    `${missing.length} env(s) em falta:\n${lines.join("\n")}`,
  );
}

/**
 * Resumo do estado actual — útil para health checks e /admin.
 * Não atira. Devolve estrutura com missing por scope.
 */
export type EnvAuditEntry = {
  name: string;
  scopes: EnvScope[];
  level: EnvLevel;
  present: boolean;
  description: string;
};

export function auditEnv(): EnvAuditEntry[] {
  return ENV_CATALOG.map((spec) => ({
    name: spec.name,
    scopes: spec.scopes,
    level: spec.level,
    present: !!process.env[spec.name],
    description: spec.description,
  }));
}

/**
 * Devolve `true` se todas as envs `required` para o scope dado estão
 * configuradas. Não atira.
 */
export function isScopeReady(scope: EnvScope): { ready: boolean; missing: string[] } {
  const missing: string[] = [];
  for (const spec of ENV_CATALOG) {
    if (spec.level !== "required") continue;
    if (!spec.scopes.includes(scope)) continue;
    if (!process.env[spec.name]) missing.push(spec.name);
  }
  return { ready: missing.length === 0, missing };
}
