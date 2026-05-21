import { NextResponse, type NextRequest } from "next/server";

/**
 * Middleware de resolução de tenant.
 *
 * Corre em Edge runtime — NÃO pode importar Prisma, control plane,
 * nem nada Node-only. Só trata de parsing de URL/Host/cookies e escreve
 * o header `x-tenant-slug` no pedido reencaminhado. A validação e
 * resolução do cliente DB acontecem mais tarde em lib/tenant-registry.ts.
 *
 * Estratégias de resolução (pela ordem):
 *   1. Subdomain do Host             (CANÓNICO — prod + lvh.me + /etc/hosts)
 *   2. Cookie `__tenant`             (fallback piloto — só se TENANT_FALLBACK_ENABLED)
 *   3. Query param ?__tenant=slug    (fallback piloto se TENANT_FALLBACK_ENABLED;
 *                                      senão só em dev, como override prático)
 *
 * Fallback piloto (sem wildcard DNS): quando `TENANT_FALLBACK_ENABLED=1`,
 * o tenant pode ser escolhido por `?__tenant=<slug>` (bootstrap/switch) e
 * fica PERSISTIDO num cookie httpOnly seguro, para que os requests
 * seguintes (sem query) resolvam o mesmo tenant. O subdomínio mantém-se
 * SEMPRE prioritário e canónico. Migração futura → ver docs/tenant-fallback.md.
 *
 * Segurança: o fallback muda apenas COMO se escolhe o tenant, não a auth.
 * O login continua a validar credenciais na BD do tenant e a sessão fica
 * vinculada ao slug (getSession compara com o tenant resolvido). Apontar
 * ?__tenant a outro tenant só mostra o login desse tenant — sem
 * credenciais válidas não há acesso, e a consola admin exige
 * LEGACY_TENANT (logo o fallback não dá escalonamento de privilégios).
 *
 * Labels reservadas que NUNCA são tratadas como tenant:
 *   www, admin, api, spharmmt, spharm-mt, localhost, 127
 *
 * CRÍTICO: o host de produção é `spharm-mt.vercel.app`, cujo PRIMEIRO
 * label é `spharm-mt` (COM hífen). Sem o reservar, o subdomínio (que é
 * prioritário) resolvia sempre slug="spharm-mt" → cache miss → legacy,
 * curto-circuitando o fallback de query/cookie (o login do piloto nunca
 * chegava a ser consultado). Reservá-lo faz o apex devolver null no
 * subdomínio e deixa o fallback (?__tenant → cookie) entrar em acção.
 *
 * Se nenhuma estratégia resolver, o header fica por escrever e o
 * getPrisma() cai no legacy fallback.
 */

const RESERVED_LABELS = new Set([
  "www",
  "admin",
  "api",
  "spharmmt",
  "spharm-mt", // host da própria plataforma (spharm-mt.vercel.app) — não é tenant
  "localhost",
  "127",
]);

const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{1,40}[a-z0-9]$/;

const TENANT_COOKIE = "__tenant";
const TENANT_COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 dias

function fallbackEnabled(): boolean {
  return (
    process.env.TENANT_FALLBACK_ENABLED === "1" ||
    process.env.TENANT_FALLBACK_ENABLED === "true"
  );
}

/** Valida + normaliza um slug candidato. Rejeita reservados e formato inválido. */
function validSlug(value: string | null | undefined): string | null {
  if (!value) return null;
  const s = value.toLowerCase();
  if (RESERVED_LABELS.has(s)) return null;
  if (!SLUG_REGEX.test(s)) return null;
  return s;
}

/** 1. Subdomain do Host (canónico). */
function subdomainSlug(req: NextRequest): string | null {
  const host = req.headers.get("host") ?? "";
  const hostname = host.split(":")[0].toLowerCase(); // strip porto
  const labels = hostname.split(".");
  if (labels.length < 2) return null; // "localhost" isolado
  return validSlug(labels[0]);
}

type Resolution = {
  slug: string | null;
  source: "subdomain" | "cookie" | "query" | "none";
};

function resolveSlug(req: NextRequest): Resolution {
  // 1. Subdomain — sempre prioritário e canónico.
  const sub = subdomainSlug(req);
  if (sub) return { slug: sub, source: "subdomain" };

  const allowFallback = fallbackEnabled();

  // 2. Cookie (persistência do fallback piloto).
  if (allowFallback) {
    const ck = validSlug(req.cookies.get(TENANT_COOKIE)?.value);
    if (ck) return { slug: ck, source: "cookie" };
  }

  // 3. Query param ?__tenant — fallback piloto (prod se enabled) OU
  //    override de dev (comportamento existente preservado).
  if (allowFallback || process.env.NODE_ENV !== "production") {
    const qp = validSlug(req.nextUrl.searchParams.get("__tenant"));
    if (qp) return { slug: qp, source: "query" };
  }

  return { slug: null, source: "none" };
}

/**
 * Versão do middleware. A presença do header `x-tenant-mw` na resposta
 * PROVA que este build (415b252+) está realmente no deployment activo.
 */
const MW_VERSION = "fallback-v1";

/**
 * Anexa headers de diagnóstico (NÃO-sensíveis) à resposta. Permitem
 * confirmar via `curl -I` qual o elo da cadeia que falha SEM acesso live:
 *   x-tenant-mw       → versão do middleware (deployment inclui o fallback?)
 *   x-tenant-fallback → on|off (estado RUNTIME de TENANT_FALLBACK_ENABLED)
 *   x-tenant-resolved → slug resolvido (ou "-")
 *   x-tenant-source   → subdomain|cookie|query|none
 * Nenhum valor é segredo: o slug já está no URL/Host; source/fallback são
 * sinais operacionais. Remover quando o piloto estabilizar.
 */
function withDebug(
  res: NextResponse,
  slug: string | null,
  source: Resolution["source"]
): NextResponse {
  res.headers.set("x-tenant-mw", MW_VERSION);
  res.headers.set("x-tenant-fallback", fallbackEnabled() ? "on" : "off");
  res.headers.set("x-tenant-resolved", slug ?? "-");
  res.headers.set("x-tenant-source", source);
  return res;
}

export function middleware(req: NextRequest): NextResponse {
  const { slug, source } = resolveSlug(req);
  if (!slug) {
    return withDebug(NextResponse.next(), null, source);
  }

  // Injecta x-tenant-slug no pedido forwarded aos server components /
  // route handlers (single source of truth: lib/tenant-context.ts lê este
  // header).
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-tenant-slug", slug);

  const res = NextResponse.next({ request: { headers: requestHeaders } });

  // Persistir no cookie quando o tenant veio do query param (bootstrap ou
  // switch) e o fallback está activo. O subdomínio é canónico e NÃO
  // escreve cookie. httpOnly + secure (prod): só o servidor lê.
  if (source === "query" && fallbackEnabled()) {
    res.cookies.set(TENANT_COOKIE, slug, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: TENANT_COOKIE_MAX_AGE,
    });
  }

  return withDebug(res, slug, source);
}

/**
 * Não corre middleware em:
 *  · assets estáticos / imagens / _next  (custo por request)
 *  · /api/health                          (sem deps de tenant)
 *  · /api/ingest, /api/outbox             (auth própria via
 *    withIntegrationAuth + header `x-tenant-slug` enviado pelo
 *    agent on-premise; o middleware NÃO pode sobrescrever esse
 *    header com o subdomínio do host, senão `spharm-mt.vercel.app`
 *    força slug="spharm-mt" e o agent recebe 401 tenant_not_found)
 *  · /api/jobs                            (auth via CRON_SECRET, sem
 *    dependência de tenant no path)
 */
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api/health|api/ingest|api/outbox|api/jobs).*)",
  ],
};
