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
    level: "optional",
    description:
      "Host Postgres onde as BDs por-tenant são criadas. Usado APENAS pelo modo legacy `--create-db` (LocalPostgresProvider). Em NeonProvider o host vem da própria API.",
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
    level: "optional",
    description:
      "Connection string com privilégios CREATEDB / CREATE ROLE. Usada APENAS pelo modo legacy `--create-db` (LocalPostgresProvider). Em Neon partilhado normalmente falha com 42501 — usa NeonProvider em vez.",
    example: "postgres://owner:pass@host/postgres?sslmode=require",
  },
  // ── Neon API (Platform Admin Tool) ─────────────────────────────────
  {
    name: "NEON_API_KEY",
    scopes: ["cli"],
    level: "optional",
    description:
      "API key da Neon (criar em https://console.neon.tech/app/settings/api-keys). Activa o NeonProvider — provisão automática de DBs por cliente. Sem isto, cai em ManualUrlProvider/LocalPostgresProvider conforme flags.",
    example: "napi_xxxxxxxxxxxxxxxxxxxxxxxx",
  },
  {
    name: "NEON_PROJECT_ID",
    scopes: ["cli"],
    level: "optional",
    description:
      "ID do Neon project onde criar as DBs por cliente. Obrigatório quando NEON_API_KEY está definido. Visível no dashboard Neon — ex: `morning-snow-12345678`.",
    example: "old-leaf-12345678",
  },
  {
    name: "NEON_DEFAULT_REGION",
    scopes: ["cli"],
    level: "optional",
    description:
      "Região por defeito para novas DBs Neon. Não muda DBs já criadas — Neon escolhe automaticamente baseado no projecto. Informativo.",
    example: "eu-west-2",
  },
  {
    name: "NEON_API_BASE_URL",
    scopes: ["cli"],
    level: "optional",
    description:
      "Override do base URL da Neon API. Default https://console.neon.tech/api/v2. Útil para staging/testing.",
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
  // ── Feature flags ──────────────────────────────────────────────────
  {
    name: "ENABLE_AGENT_BOOTSTRAP",
    scopes: ["ingest"],
    level: "optional",
    description:
      "Feature flag para activar os endpoints /api/ingest/v1/bootstrap/* (products, stock, sales-lines). Quando ausente ou '0', endpoints respondem 503 feature_disabled. Activar SÓ depois de validar bootstrap-dry-run contra dados reais.",
    example: "1",
  },
  {
    name: "SPHARM_DEBUG_BROWSE",
    scopes: ["cli"],
    level: "optional",
    description:
      "Quando '1', activa logs verbosos do browser Puppeteer em scripts de scraping INFARMED.",
  },
  // ── ERP SPharm (SQL Server) — discovery + on-premise sync ──────────
  {
    name: "ERP_SQLSERVER_HOST",
    scopes: ["cli"],
    level: "optional",
    description:
      "Host SQL Server do ERP SPharm da farmácia (on-premise). Só necessário em scripts erp:* (discover/bootstrap/daily).",
    example: "localhost  ou  192.168.1.10  ou  SERVER\\SQLEXPRESS",
  },
  {
    name: "ERP_SQLSERVER_PORT",
    scopes: ["cli"],
    level: "optional",
    description: "Porta SQL Server. Default 1433. Não aplicável a instâncias nomeadas (usa o named pipe).",
    example: "1433",
  },
  {
    name: "ERP_SQLSERVER_DATABASE",
    scopes: ["cli"],
    level: "optional",
    description: "Nome da BD SPharm no SQL Server.",
    example: "SPHARM",
  },
  {
    name: "ERP_SQLSERVER_USER",
    scopes: ["cli"],
    level: "optional",
    description: "User SQL Server com permissão SELECT na BD SPharm. Idealmente um login dedicado read-only.",
    example: "spharm_readonly",
  },
  {
    name: "ERP_SQLSERVER_PASSWORD",
    scopes: ["cli"],
    level: "optional",
    description: "Password do user SQL Server. NUNCA logar — mascarada em todos os outputs.",
  },
  {
    name: "ERP_SQLSERVER_ENCRYPT",
    scopes: ["cli"],
    level: "optional",
    description: "TLS para a conexão. '1' liga, '0' desliga. Default '0' (LAN local).",
    example: "0",
  },
  {
    name: "ERP_SQLSERVER_TRUST_CERT",
    scopes: ["cli"],
    level: "optional",
    description: "Confiar em certificado self-signed quando ENCRYPT=1. '1' aceita, '0' valida. Default '1' (típico em LAN).",
    example: "1",
  },
  {
    name: "NODE_ENV",
    scopes: ["web", "cron", "cli", "ingest"],
    level: "optional",
    description: "Standard Next.js. Production / development. Inferido pelo runner.",
  },
  // ── Alojamento (self-hosted / Vercel) ──────────────────────────────
  // Tudo o que muda entre alojamentos e é lido em RUNTIME. Ver
  // lib/runtime-config.ts — nenhuma destas pode ser NEXT_PUBLIC_*, senão
  // ficaria fixada no build e a mesma imagem deixaria de servir dois
  // ambientes.
  {
    name: "PUBLIC_APP_URL",
    scopes: ["web"],
    level: "recommended",
    description:
      "URL público da plataforma, lido em runtime. Alimenta o label reservado da resolução de tenant e o default de SESSION_COOKIE_SECURE. Sem isto cai em NEXT_PUBLIC_APP_URL e depois em VERCEL_URL.",
    example: "https://app.spharmmt.pt  ou  http://203.0.113.10",
  },
  {
    name: "SESSION_COOKIE_SECURE",
    scopes: ["web"],
    level: "recommended",
    description:
      "'1' emite o cookie de sessão com `secure`. TEM de ser 0 enquanto o acesso for HTTP: um cookie secure sobre HTTP é descartado pelo browser sem erro e o login entra em ciclo. Sem valor, deduz de PUBLIC_APP_URL.",
    example: "0",
  },
  {
    name: "SESSION_COOKIE_SAMESITE",
    scopes: ["web"],
    level: "optional",
    description: "lax (default) | strict | none. 'none' exige secure=1.",
    example: "lax",
  },
  {
    name: "SESSION_COOKIE_DOMAIN",
    scopes: ["web"],
    level: "optional",
    description:
      "Domínio do cookie. Definir só com wildcard DNS, para a sessão ser partilhada entre subdomínios de tenant.",
    example: ".spharmmt.pt",
  },
  {
    name: "TENANT_RESERVED_LABELS",
    scopes: ["web"],
    level: "optional",
    description:
      "CSV de labels de subdomínio que nunca são tenant, além dos base e do label de PUBLIC_APP_URL.",
    example: "status,docs",
  },
  {
    name: "TENANT_FALLBACK_ENABLED",
    scopes: ["web"],
    level: "optional",
    description:
      "'1' permite escolher o tenant por ?__tenant=<slug> e persisti-lo em cookie. Necessário enquanto não houver DNS wildcard — é o caso de um acesso por IP.",
    example: "1",
  },
  {
    name: "ALLOW_LEGACY_DATABASE_FALLBACK",
    scopes: ["web"],
    level: "optional",
    description:
      "'1' deixa a app cair em DATABASE_URL quando o tenant não resolve. Em produção multi-tenant tem de ficar a 0: servir a base legacy a quem pediu um tenant é fuga de dados silenciosa. Default: ligado fora de produção, desligado em produção.",
    example: "0",
  },
  {
    name: "TENANT_DB_SSLMODE",
    scopes: ["web", "cli"],
    level: "optional",
    description:
      "sslmode das connection strings dos tenants. 'require' em fornecedores geridos; 'disable' quando o PostgreSQL está na mesma rede Docker privada. Sem valor mantém a heurística antiga (TLS em tudo o que não for localhost) — que estava errada para hosts Docker.",
    example: "disable",
  },
  {
    name: "DATABASE_SSLMODE",
    scopes: ["web", "cli"],
    level: "optional",
    description:
      "sslmode usado ao construir DATABASE_URL / CONTROL_DATABASE_URL a partir das peças POSTGRES_*. Lido pelo entrypoint do container, não pela app.",
    example: "disable",
  },
  {
    name: "SCHEDULER_ENABLED",
    scopes: ["cron"],
    level: "optional",
    description:
      "'1' faz o worker local disparar os jobs periódicos. Default 0 — o worker arranca, diz que está desligado e não toca em dados. Não afecta a invocação manual dos endpoints, que continua a exigir CRON_SECRET.",
    example: "0",
  },
  {
    name: "APP_INTERNAL_URL",
    scopes: ["cron"],
    level: "optional",
    description:
      "URL pelo qual o worker alcança a aplicação na rede interna. Default http://web:3000. Não é o URL público — não depende de DNS, TLS nem do proxy.",
    example: "http://web:3000",
  },
  {
    name: "APP_REVISION",
    scopes: ["web"],
    level: "optional",
    description:
      "Revisão do código a correr, injectada no build da imagem e devolvida por /api/health. Permite confirmar qual o build activo sem entrar no servidor.",
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
