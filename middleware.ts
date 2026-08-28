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
 *   2. Query param ?__tenant=slug    (ESCOLHA EXPLÍCITA — fallback piloto se
 *                                      TENANT_FALLBACK_ENABLED; senão só em dev)
 *   3. Cookie `__tenant`             (memória da escolha anterior)
 *
 * ── PORQUE É QUE A QUERY VEM ANTES DO COOKIE ─────────────────────────
 *
 * Vinha depois, e isso tornava o `?__tenant=` inoperante para quem já
 * tivesse visitado outro tenant. Medido em produção:
 *
 *   sem cookie,  ?__tenant=silveira  →  resolved=silveira  source=query
 *   cookie=sier, ?__tenant=silveira  →  resolved=sier      source=cookie
 *
 * O link dizia silveira, o servidor servia sier, e nada na página o
 * dizia. O instalador que vai para o PC do cliente abre exactamente
 * `https://app.spharmmt.com/login?__tenant=silveira`: um cookie deixado
 * por uma visita anterior punha lá o login do tenant errado, e as
 * credenciais certas eram recusadas com "Credenciais inválidas".
 *
 * A regra é a natural: o que está escrito no URL é uma escolha
 * deliberada e vence a memória de uma escolha antiga. O cookie continua
 * a servir para o que foi feito — manter o tenant nos pedidos seguintes,
 * que já não trazem a query — e é REESCRITO sempre que a query resolve,
 * para que a memória passe a ser a nova escolha e não a velha.
 *
 * O subdomínio mantém-se SEMPRE prioritário e canónico: é o Host, e o
 * Host não se escolhe por engano. Migração futura → ver
 * docs/tenant-fallback.md.
 *
 * ── CROSS-TENANT ─────────────────────────────────────────────────────
 *
 * Trocar de tenant pela query NÃO transporta a sessão. O claim `tenant`
 * do token é comparado com o tenant resolvido, aqui e em `getSession()`;
 * quem chega com sessão de A e pede ?__tenant=B é mandado para o login
 * de B. Mudar de tenant é, quando muito, uma forma mais lenta de fazer
 * logout — nunca uma forma de ver os dados do outro.
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

  // 2. Query param ?__tenant — a ESCOLHA EXPLÍCITA. Vence o cookie: o
  //    que está escrito no URL é deliberado, o cookie é memória. Só é
  //    aceite onde já era: fallback piloto em produção, ou dev.
  //
  //    Um slug inválido ou reservado NÃO cai para o cookie por engano —
  //    cai, e é isso que se quer: `?__tenant=lixo` não deve trocar de
  //    tenant nem apagar o que estava.
  if (allowFallback || process.env.NODE_ENV !== "production") {
    const qp = validSlug(req.nextUrl.searchParams.get("__tenant"));
    if (qp) return { slug: qp, source: "query" };
  }

  // 3. Cookie — a memória da escolha anterior, para os pedidos seguintes
  //    que já não trazem a query.
  if (allowFallback) {
    const ck = validSlug(req.cookies.get(TENANT_COOKIE)?.value);
    if (ck) return { slug: ck, source: "cookie" };
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
    // Sempre que a QUERY resolveu, o cookie é reescrito — não só quando
    // não existia. Era esta a outra metade do defeito: mesmo depois de
    // se dar prioridade à query, um cookie antigo sobreviveria ao pedido
    // e voltaria a mandar no seguinte, que já não traz a query.
    //
    // A condição do `fallbackEnabled()` saiu: a query só chega aqui como
    // `source === "query"` se `resolveSlug` já a tiver aceite, e isso só
    // acontece com o fallback ligado ou fora de produção. Repetir a
    // condição aqui fazia com que, em dev, a query resolvesse o tenant e
    // o cookie nunca fosse escrito — a navegação seguinte perdia-o.
    if (slug && source === "query") {
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
  // O `x-tenant-source` encaminhado saiu com o bloco de diagnóstico do
  // `loginAction`, que era o seu único consumidor — o comentário que
  // aqui estava pedia-o. Continua a ser exposto na RESPOSTA
  // (`withDebug`), onde serve para diagnosticar com um `curl -I` sem
  // acesso à máquina, e onde nenhum código depende dele.

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
