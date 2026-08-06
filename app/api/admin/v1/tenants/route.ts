/**
 * app/api/admin/v1/tenants/route.ts
 *
 * GET  /api/admin/v1/tenants   — lista tenants (sem segredos). Read-only.
 * POST /api/admin/v1/tenants   — cria um cliente novo.
 *
 * Auth: bearer admin token (ADMIN_API_TOKENS) nos dois.
 *
 * ── Porquê o POST existe ─────────────────────────────────────────────
 * Era o único passo do onboarding sem caminho por API. O Admin Wizard
 * tinha de correr `npm run tenancy:create` NA MÁQUINA DO TÉCNICO, o que
 * exigia lá o repositório, o Node e — pior — CONTROL_DATABASE_URL com
 * alcance à base. Na stack self-hosted o PostgreSQL não publica porto,
 * por desenho, portanto esse caminho simplesmente não existe.
 *
 * Este handler é FINO de propósito: valida, chama
 * `lib/admin/ops/create-tenant.ts` (que por sua vez chama o workflow que
 * o CLI já usa) e devolve. Nenhuma regra de negócio vive aqui, e o
 * `tenant:create` continua a ser o mesmo comando com o mesmo contrato.
 *
 * ── Segredos ─────────────────────────────────────────────────────────
 * A senha do administrador e a ingest key vêm no corpo da resposta de
 * sucesso, UMA vez, e não são recuperáveis depois. Não são registadas em
 * lado nenhum: o log de auditoria abaixo escreve apenas o slug, o
 * resultado e os nomes dos passos.
 */

import { type NextRequest } from "next/server";
import { withAdminApiAuth, AdminApiError } from "@/lib/admin/api-token";
import { listTenantsForAdmin } from "@/lib/admin/ops/list-tenants";
import { createTenant } from "@/lib/admin/ops/create-tenant";
import { rateLimit, bearerOf } from "@/lib/admin/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Criar um cliente cria a base, corre as migrations do tenant, semeia o
// admin e faz um smoke test. Nas medições reais fica na ordem das
// dezenas de segundos; os 30s das outras rotas admin cortavam a operação
// a meio, deixando um tenant meio-criado e um erro que não explica nada.
export const maxDuration = 300;

// Uma criação por minuto por token, no máximo 5 em 10 minutos. Não é uma
// defesa contra um atacante — a autenticação é que é. É contra o
// duplo-clique e contra o ciclo mal escrito, que aqui custam bases de
// dados órfãs a ocupar disco.
const CREATE_LIMIT = 5;
const CREATE_WINDOW_MS = 10 * 60 * 1000;

export const GET = withAdminApiAuth(async (_req: NextRequest) => {
  const tenants = await listTenantsForAdmin();
  return Response.json({ ok: true, tenants });
});

export const POST = withAdminApiAuth(async (req: NextRequest) => {
  // Verificar sem consumir. A quota só é gasta por uma tentativa que
  // chegue a executar — ver a chamada com `record` mais abaixo. Sem esta
  // distinção, quatro erros de validação seguidos esgotavam o limite e a
  // primeira criação legítima levava 429.
  const token = bearerOf(req);
  const decision = rateLimit("create-tenant", token, CREATE_LIMIT, CREATE_WINDOW_MS, false);
  if (!decision.allowed) {
    return Response.json(
      {
        ok: false,
        error: `demasiadas criações de cliente: máximo ${CREATE_LIMIT} em ${CREATE_WINDOW_MS / 60000} minutos`,
        code: "rate_limited",
        retryAfterSec: decision.retryAfterSec,
      },
      { status: 429, headers: { "retry-after": String(decision.retryAfterSec) } }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    throw new AdminApiError(400, "body JSON inválido", "bad_request");
  }

  const outcome = await createTenant(body);

  // A quota é consumida DEPOIS, e só por tentativas reais. Um 400 é uma
  // resposta barata: recusar entrada malformada não deve aproximar o
  // operador do limite. Um 409 já conta — chegou a consultar a base.
  //
  // O custo desta escolha: pedidos concorrentes podem passar todos a
  // verificação antes de qualquer um registar. Aceitável — isto protege
  // contra repetição acidental, não contra um atacante, e quem manda os
  // pedidos tem um token válido.
  if (outcome.status !== 400) {
    rateLimit("create-tenant", token, CREATE_LIMIT, CREATE_WINDOW_MS, true);
  }

  // Auditoria: slug, veredicto e passos. Sem senha, sem ingest key, sem
  // connection string. O `steps` é o que permite dizer onde parou uma
  // criação falhada sem ter de reproduzir nada.
  console.log(
    JSON.stringify({
      at: "admin.tenants.create",
      slug: typeof body.slug === "string" ? body.slug : null,
      status: outcome.status,
      ok: outcome.body.ok === true,
      steps: outcome.steps,
      // A mensagem de erro entra no log; os segredos não. O workflow
      // mascara connection strings antes de as pôr aqui (ver
      // maskConnectionUrl) e nunca coloca senhas no campo `error`.
      //
      // Sem isto, uma criação falhada registava só a lista de passos — e
      // diagnosticar "parou em apply-migrations" sem saber PORQUÊ obriga
      // a reproduzir a stack inteira. Custou uma volta completa a
      // descobrir isso.
      error: outcome.body.ok === true ? undefined : outcome.body.error,
    })
  );

  return Response.json(outcome.body, {
    status: outcome.status,
    headers: { "x-ratelimit-remaining": String(decision.remaining) },
  });
});
