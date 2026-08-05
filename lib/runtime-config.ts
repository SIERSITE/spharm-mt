/**
 * lib/runtime-config.ts
 *
 * Configuração que muda entre alojamentos (Vercel, VPS self-hosted, dev)
 * e que tem de ser lida em RUNTIME, nunca fixada no build.
 *
 * Porquê um módulo só para isto: `NEXT_PUBLIC_*` é substituído
 * literalmente durante o `next build`. Uma imagem construída uma vez e
 * promovida entre ambientes não pode depender dessas variáveis para saber
 * o seu próprio URL, se está atrás de TLS, ou qual é o host da plataforma.
 * Tudo o que aqui está é lido de `process.env` no momento da chamada.
 *
 * Sem `import "server-only"` — os scripts CLI e o worker também consomem
 * este módulo fora do bundler.
 */

import { boolEnv, optionalEnv } from "@/lib/env";

// ─────────────────────────────────────────────────────────────────────
// URL público
// ─────────────────────────────────────────────────────────────────────

/**
 * URL público da plataforma, sem barra final. Ex.: `https://app.spharm.pt`
 * ou `http://203.0.113.10` enquanto não houver domínio.
 *
 * Ordem: `PUBLIC_APP_URL` (canónica, runtime) → `NEXT_PUBLIC_APP_URL`
 * (compatibilidade com deployments Vercel existentes) → `VERCEL_URL`
 * (injectada pela Vercel, sem esquema) → null.
 *
 * Devolver null é um resultado legítimo: em dev não há URL público e
 * quem precisar dele deve tratar a ausência, não inventar um default.
 */
export function publicAppUrl(): string | null {
  const direct = optionalEnv("PUBLIC_APP_URL") ?? optionalEnv("NEXT_PUBLIC_APP_URL");
  if (direct) return direct.replace(/\/+$/, "");
  const vercel = optionalEnv("VERCEL_URL");
  if (vercel) return `https://${vercel.replace(/\/+$/, "")}`;
  return null;
}

/** Host (sem porto) do URL público, em minúsculas. Null se não configurado. */
export function publicAppHost(): string | null {
  const url = publicAppUrl();
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Cookies de sessão
// ─────────────────────────────────────────────────────────────────────

export type SessionCookieOptions = {
  httpOnly: true;
  sameSite: "lax" | "strict" | "none";
  secure: boolean;
  path: "/";
  domain?: string;
  maxAge: number;
};

/**
 * `secure` de forma explícita e configurável.
 *
 * A armadilha que isto resolve: um cookie `secure` enviado sobre HTTP é
 * DESCARTADO pelo browser sem erro visível — o login parece funcionar e
 * volta ao formulário, em ciclo. Enquanto o acesso à VPS for por IP em
 * HTTP, `secure` tem mesmo de ser 0; passa a 1 no mesmo momento em que
 * houver certificado.
 *
 * Ordem: `SESSION_COOKIE_SECURE` explícito → deduzido de `PUBLIC_APP_URL`
 * começar por `https://` → `NODE_ENV === "production"`.
 */
export function sessionCookieSecure(): boolean {
  const explicit = optionalEnv("SESSION_COOKIE_SECURE");
  if (explicit !== null) return boolEnv("SESSION_COOKIE_SECURE");
  const url = publicAppUrl();
  if (url) return url.startsWith("https://");
  return process.env.NODE_ENV === "production";
}

function sessionCookieSameSite(): SessionCookieOptions["sameSite"] {
  switch ((optionalEnv("SESSION_COOKIE_SAMESITE") ?? "lax").toLowerCase()) {
    case "strict":
      return "strict";
    case "none":
      return "none";
    default:
      return "lax";
  }
}

/** Opções completas do cookie de sessão. `maxAge` em segundos. */
export function sessionCookieOptions(maxAgeSeconds: number): SessionCookieOptions {
  const domain = optionalEnv("SESSION_COOKIE_DOMAIN");
  return {
    httpOnly: true,
    sameSite: sessionCookieSameSite(),
    secure: sessionCookieSecure(),
    path: "/",
    ...(domain ? { domain } : {}),
    maxAge: maxAgeSeconds,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Resolução multi-tenant
// ─────────────────────────────────────────────────────────────────────

/**
 * Labels de subdomínio que NUNCA são um tenant.
 *
 * O host da própria plataforma tem de estar aqui: sendo o subdomínio a
 * estratégia prioritária, `spharm-mt.vercel.app` resolvia sempre
 * slug="spharm-mt" e curto-circuitava os restantes mecanismos. Antes isso
 * estava escrito à mão no middleware, o que amarrava o código ao domínio
 * `.vercel.app`; agora o primeiro label vem de `PUBLIC_APP_URL` e a lista
 * é extensível por `TENANT_RESERVED_LABELS` sem tocar em código.
 */
const BASE_RESERVED_LABELS = [
  "www",
  "admin",
  "api",
  "app",
  "static",
  "assets",
  "spharmmt",
  "spharm-mt",
  "localhost",
  "127",
];

export function reservedTenantLabels(): Set<string> {
  const labels = new Set(BASE_RESERVED_LABELS);

  const host = publicAppHost();
  if (host) {
    // Primeiro label do host público (`app` em `app.spharm.pt`) e o host
    // completo quando não tem pontos (`spharmmt` numa rede interna).
    const first = host.split(".")[0];
    if (first) labels.add(first);
  }

  const extra = optionalEnv("TENANT_RESERVED_LABELS");
  if (extra) {
    for (const raw of extra.split(",")) {
      const label = raw.trim().toLowerCase();
      if (label) labels.add(label);
    }
  }

  return labels;
}

/**
 * `true` quando o tenant pode vir de `?__tenant=` / cookie em vez do
 * subdomínio. Necessário enquanto não houver DNS wildcard — que é
 * exactamente a situação de um acesso por IP.
 */
export function tenantFallbackEnabled(): boolean {
  return boolEnv("TENANT_FALLBACK_ENABLED");
}

/**
 * `true` quando é aceitável cair na base apontada por `DATABASE_URL`
 * porque o tenant não foi resolvido.
 *
 * Em produção self-hosted isto tem de estar DESLIGADO: `DATABASE_URL`
 * aponta para a base legacy, e servir dados dessa base a quem pediu um
 * tenant é uma fuga entre clientes — silenciosa, porque a página abre
 * na mesma. Em dev mantém-se ligado, que é o comportamento histórico.
 */
export function legacyDatabaseFallbackAllowed(): boolean {
  const explicit = optionalEnv("ALLOW_LEGACY_DATABASE_FALLBACK");
  if (explicit !== null) return boolEnv("ALLOW_LEGACY_DATABASE_FALLBACK");
  return process.env.NODE_ENV !== "production";
}

// ─────────────────────────────────────────────────────────────────────
// Base de dados
// ─────────────────────────────────────────────────────────────────────

/**
 * `sslmode` a usar nas connection strings dos tenants.
 *
 * A heurística anterior — TLS obrigatório em tudo o que não fosse
 * localhost — era correcta para Neon e errada para a VPS: aí o Postgres
 * responde ao nome `postgres` numa rede Docker privada, sem certificado,
 * e o `sslmode=require` implícito rebentava a ligação a todos os tenants.
 *
 * `TENANT_DB_SSLMODE` decide explicitamente. Vazio mantém a heurística.
 */
export function tenantDbSslMode(): string | null {
  return optionalEnv("TENANT_DB_SSLMODE");
}

// ─────────────────────────────────────────────────────────────────────
// Scheduler
// ─────────────────────────────────────────────────────────────────────

/**
 * `true` quando o worker local deve disparar os jobs periódicos.
 *
 * DESLIGADO por defeito, e deliberadamente: um scheduler a correr contra
 * uma base a meio de uma migração faz mais estragos do que scheduler
 * nenhum. Não afecta a invocação manual dos endpoints `/api/jobs/*`, que
 * continua a exigir `CRON_SECRET` — é assim que se testa antes de ligar.
 */
export function schedulerEnabled(): boolean {
  return boolEnv("SCHEDULER_ENABLED", false);
}

/**
 * `true` quando o `/api/jobs/refresh-ipf` deve correr o fluxo
 * multi-tenant em vez do fluxo legacy single-DB.
 *
 * DESLIGADO por defeito, e a ausência da variável conta como desligado.
 * O commit que introduziu o fluxo multi-tenant é implantado também na
 * Vercel, onde o cron continua agendado: sem esta guarda, o disparo
 * seguinte mudava de comportamento sozinho — passava a escrever nas
 * bases dos tenants em vez da base actual, sem ninguém ter decidido
 * isso. Uma alteração de comportamento em produção tem de ser um acto
 * explícito, não um efeito secundário de um deploy.
 *
 * Ligar só depois de: catálogo instalado, tenants reais criados, jobs
 * validados manualmente, scheduler da VPS activo e cron equivalente da
 * Vercel desligado. Ligar antes do último ponto põe dois schedulers a
 * escrever nas mesmas bases.
 */
export function refreshIpfMultiTenantEnabled(): boolean {
  return boolEnv("REFRESH_IPF_MULTI_TENANT_ENABLED", false);
}
