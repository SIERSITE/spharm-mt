import { NextResponse, type NextRequest } from "next/server";

/**
 * Middleware de resolução de tenant (Fase 1 do Commit 3).
 *
 * Corre em Edge runtime — NÃO pode importar Prisma, control plane,
 * nem nada Node-only. Só trata de parsing de URL e Host, e escreve
 * o header `x-tenant-slug` no pedido reencaminhado. A validação e
 * resolução do cliente DB acontecem mais tarde em lib/tenant-registry.ts.
 *
 * Estratégias de resolução (pela ordem):
 *   1. Query param ?__tenant=slug   (só em dev — override prático)
 *   2. Subdomain do Host             (prod + lvh.me + /etc/hosts)
 *
 * Labels reservadas que NUNCA são tratadas como tenant:
 *   www, admin, api, spharmmt, localhost, 127
 *
 * Se nenhuma estratégia resolver, o header fica por escrever e o
 * getPrisma() cai no legacy fallback (BD de dev actual).
 */

const RESERVED_LABELS = new Set([
  "www",
  "admin",
  "api",
  "spharmmt",
  "localhost",
  "127",
]);

const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{1,40}[a-z0-9]$/;

function resolveSlug(req: NextRequest): string | null {
  // 1. Query param override (dev only)
  if (process.env.NODE_ENV !== "production") {
    const qp = req.nextUrl.searchParams.get("__tenant");
    if (qp && SLUG_REGEX.test(qp)) return qp;
  }

  // 2. Subdomain
  const host = req.headers.get("host") ?? "";
  // Strip porto (":3000") antes de partir por pontos
  const hostname = host.split(":")[0].toLowerCase();
  const labels = hostname.split(".");
  if (labels.length < 2) return null; // "localhost" isolado
  const first = labels[0];
  if (RESERVED_LABELS.has(first)) return null;
  if (!SLUG_REGEX.test(first)) return null;
  return first;
}

export function middleware(req: NextRequest): NextResponse {
  const slug = resolveSlug(req);
  if (!slug) {
    return NextResponse.next();
  }

  // Reescreve os headers para injectar x-tenant-slug no pedido
  // forwarded aos server components / route handlers.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-tenant-slug", slug);

  return NextResponse.next({
    request: { headers: requestHeaders },
  });
}

/**
 * Não corre middleware em assets estáticos, imagens, _next, ou na
 * rota de health-check (se existir). Reduz custo por request.
 */
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api/health).*)",
  ],
};
