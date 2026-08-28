import { NextResponse, type NextRequest } from "next/server";
// Edge-safe de proposito: `lib/auth.ts` importa `server-only` e
// `next/headers`, e nenhum dos dois existe aqui.
import { LEGACY_TENANT, segredoDaSessao, verificarToken } from "@/lib/session-claims";

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
 * Labels reservadas que NUNCA são tratadas como tenant: ver
 * BASE_RESERVED_LABELS, mais o label do host público e as de
 * TENANT_RESERVED_LABELS.
 *
 * CRÍTICO: o primeiro label do host da PRÓPRIA plataforma tem de ser
 * reservado. Sendo o subdomínio prioritário, um host como
 * `spharm-mt.vercel.app` resolvia sempre slug="spharm-mt" → cache miss →
 * legacy, curto-circuitando o fallback de query/cookie (o login do piloto
 * nunca chegava a ser consultado). Reservá-lo faz o apex devolver null no
 * subdomínio e deixa o fallback (?__tenant → cookie) entrar em acção.
 *
 * Esse label deixou de estar escrito à mão: vem de `PUBLIC_APP_URL`, para
 * que a resolução funcione igual em `*.vercel.app`, num domínio próprio
 * ou num IP nu. `TENANT_RESERVED_LABELS` (CSV) acrescenta outros sem
 * tocar em código.
 *
 * Este ficheiro corre em Edge e lê `process.env.X` de forma ESTÁTICA de
 * propósito — o equivalente dinâmico vive em `lib/runtime-config.ts`, que
 * o middleware não pode importar sem arrastar dependências Node.
 *
 * Se nenhuma estratégia resolver, o header fica por escrever e a
 * resolução do cliente decide (ver `lib/tenant-registry.ts` — em produção
 * NÃO cai silenciosamente na base legacy).
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

/** Primeiro label do host público configurado, se houver. */
function platformLabel(): string | null {
  const url = process.env.PUBLIC_APP_URL || process.env.NEXT_PUBLIC_APP_URL;
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().split(".")[0] || null;
  } catch {
    return null;
  }
}

function buildReservedLabels(): Set<string> {
  const set = new Set(BASE_RESERVED_LABELS);
  const own = platformLabel();
  if (own) set.add(own);
  const extra = process.env.TENANT_RESERVED_LABELS;
  if (extra) {
    for (const raw of extra.split(",")) {
      const label = raw.trim().toLowerCase();
      if (label) set.add(label);
    }
  }
  return set;
}

// Calculado uma vez por instância: as envs não mudam durante a vida do
// processo, e isto está no caminho de TODOS os requests.
const RESERVED_LABELS = buildReservedLabels();

const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{1,40}[a-z0-9]$/;

const TENANT_COOKIE = "__tenant";
const TENANT_COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 dias

function fallbackEnabled(): boolean {
  return (
    process.env.TENANT_FALLBACK_ENABLED === "1" ||
    process.env.TENANT_FALLBACK_ENABLED === "true"
  );
}

/**
 * `secure` do cookie `__tenant`, com a MESMA regra do cookie de sessão
 * (`lib/runtime-config.ts`) — replicada aqui porque o middleware é Edge.
 *
 * Deduzir de `NODE_ENV === "production"`, como estava, era exactamente o
 * errado no cenário que motiva o fallback: acesso por IP em HTTP com
 * NODE_ENV=production. O browser descartava o cookie em silêncio, o
 * `?__tenant=` tinha de ser repetido em cada pedido e a navegação
 * normal caía sempre em "sem tenant".
 */
function cookieSecure(): boolean {
  const explicit = process.env.SESSION_COOKIE_SECURE;
  if (explicit !== undefined && explicit !== "") {
    return explicit === "1" || explicit === "true" || explicit === "yes";
  }
  const url = process.env.PUBLIC_APP_URL || process.env.NEXT_PUBLIC_APP_URL;
  if (url) return url.startsWith("https://");
  return process.env.NODE_ENV === "production";
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

// ═════════════════════════════════════════════════════════════════════
// SESSÃO: O ÚNICO PONTO POR ONDE TUDO PASSA
// ═════════════════════════════════════════════════════════════════════
//
// ── O QUE ISTO REPARA, E FOI MEDIDO ──────────────────────────────────
//
// O middleware só resolvia o tenant. A autenticação estava confiada a
// `requireSession()` no topo dos server components — e só duas áreas o
// chamavam: /encomendas e /configuracoes. Todas as outras não tinham
// guarda nenhuma.
//
// Verificado contra produção, sem cookie de sessão:
//
//   GET https://app.spharmmt.com/dashboard?__tenant=silveira  →  200
//
// e a resposta trazia a barra lateral e os dados do dashboard, que vêm
// de `getDashboardData()` — uma consulta à base do tenant. Não era só
// uma página bonita sem dados: era o dashboard.
//
// ── PORQUE É QUE O BLOQUEIO TEM DE SER AQUI ──────────────────────────
//
// O requisito é que um utilizador com `mustChangePassword` não consiga
// contornar a página de troca escrevendo outra rota no browser. Posto
// nas páginas, o bloqueio cobria as duas que já chamavam
// `requireSession()` — exactamente o mesmo buraco. O middleware é o
// único sítio por onde /stock, /vendas e /dashboard passam de facto.
//
// ── O QUE ISTO NÃO FAZ ───────────────────────────────────────────────
//
// Não substitui `requirePermission()`. Autenticação e autorização são
// perguntas diferentes: aqui verifica-se QUEM é, nas páginas continua a
// verificar-se o que PODE. As duas camadas ficam.

/** Rotas que existem para quem ainda não tem sessão. */
const ROTAS_PUBLICAS = ["/login"];

/**
 * A página de troca de password, e a única coisa que um utilizador com
 * `mustChangePassword` pode ver.
 */
const ROTA_TROCA = "/alterar-password";

/**
 * Prefixos que este portão não julga.
 *
 * As rotas de API têm autenticação própria — `CRON_SECRET` nos jobs,
 * `withIntegrationAuth` no ingest — e mandá-las para um redireccionamento
 * HTML transformaria um 401 legível num 307 para uma página de login que
 * o agente on-premise não sabe ler.
 */
const SEM_PORTAO = ["/api/", "/_next/", "/favicon.ico"];

function ehPublica(pathname: string): boolean {
  if (SEM_PORTAO.some((p) => pathname.startsWith(p))) return true;
  return ROTAS_PUBLICAS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function paraLogin(req: NextRequest): NextResponse {
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

function paraTroca(req: NextRequest): NextResponse {
  const url = req.nextUrl.clone();
  url.pathname = ROTA_TROCA;
  url.search = "";
  return NextResponse.redirect(url);
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { slug, source } = resolveSlug(req);
  const pathname = req.nextUrl.pathname;

  /**
   * O tenant tem de sobreviver a um redireccionamento.
   *
   * Quem escreve `/dashboard?__tenant=silveira` sem sessão é mandado
   * para `/login` — e se o cookie do tenant não fosse escrito nessa
   * resposta, aterrava num login que resolve para o tenant legacy e
   * recusa credenciais correctas. O bloqueio ficava a parecer um erro de
   * password.
   */
  const comTenant = (res: NextResponse): NextResponse => {
    if (slug && source === "query" && fallbackEnabled()) {
      res.cookies.set(TENANT_COOKIE, slug, {
        httpOnly: true,
        sameSite: "lax",
        secure: cookieSecure(),
        path: "/",
        maxAge: TENANT_COOKIE_MAX_AGE,
      });
    }
    return withDebug(res, slug, source);
  };

  // ── PORTÃO DE SESSÃO ──────────────────────────────────────────────
  if (!ehPublica(pathname)) {
    const token = req.cookies.get("session")?.value;
    const sessao = token ? await verificarToken(token, segredoDaSessao()) : null;
    if (!sessao) return comTenant(paraLogin(req));

    // O claim `tenant` tem de bater com o tenant do request: uma sessão
    // de outro tenant é a sessão de outra pessoa. A mesma regra que o
    // `getSession()` já aplicava do lado do servidor — aqui aplicada
    // antes de a rota sequer correr.
    if (sessao.tenant !== (slug ?? LEGACY_TENANT)) return comTenant(paraLogin(req));

    // Password reposta e ainda por trocar: só a página de troca. Escrever
    // /stock à mão volta para cá.
    if (sessao.mustChangePassword === true && pathname !== ROTA_TROCA) {
      return comTenant(paraTroca(req));
    }
    // E o inverso, senão quem já trocou fica preso na página.
    if (sessao.mustChangePassword !== true && pathname === ROTA_TROCA) {
      const url = req.nextUrl.clone();
      url.pathname = "/dashboard";
      url.search = "";
      return comTenant(NextResponse.redirect(url));
    }
  }

  if (!slug) {
    return withDebug(NextResponse.next(), null, source);
  }

  // Injecta x-tenant-slug no pedido forwarded aos server components /
  // route handlers (single source of truth: lib/tenant-context.ts lê este
  // header).
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-tenant-slug", slug);
  // x-tenant-source também forwarded — permite ao loginAction diagnosticar
  // se chegou por subdomain/query/cookie sem ter de re-inferir.
  // Não-sensível (a origem do slug não é segredo). REMOVER se o diag
  // temporário do loginAction for retirado e não houver outro consumer.
  requestHeaders.set("x-tenant-source", source);

  return comTenant(NextResponse.next({ request: { headers: requestHeaders } }));
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
