/**
 * scripts/tests/test-tenant-resolution.ts
 *
 * Testes puros para a resolução de tenant e para as decisões que
 * dependem do alojamento. Sem rede, sem base de dados.
 *
 * Cobre o que não tinha cobertura nenhuma: `middleware.ts`,
 * `lib/tenant-registry.ts` (fallback legacy condicional),
 * `sessionCookieOptions` tal como `app/login/actions.ts` o usa, e o
 * `buildPgUrl` de `scripts/tenancy/_shared.ts`.
 *
 * Porquê: estes passaram a depender de variáveis de ambiente que mudam
 * entre alojamentos. Um default errado não parte o build nem atira — dá
 * uma resposta errada em silêncio. O caso concreto que motivou isto:
 * `secure: process.env.NODE_ENV === "production"` num acesso por IP em
 * HTTP faz o browser descartar o cookie sem erro nenhum, e a navegação
 * cai sempre em "sem tenant".
 *
 * ── Um processo por cenário ──────────────────────────────────────────
 * O middleware calcula `RESERVED_LABELS` uma vez, no carregamento do
 * módulo. Reimportá-lo com `?t=...` NÃO cria instância nova (o cache de
 * módulos ESM ignora a query), e todos os cenários acabavam a correr
 * contra a configuração do primeiro — dando falhas que pareciam do
 * produto e não eram. Cada cenário corre por isso no seu processo.
 *
 * Correr:
 *   npx tsx scripts/tests/test-tenant-resolution.ts
 *   npx tsx scripts/tests/test-tenant-resolution.ts <cenário>   (um só)
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { NextRequest as NextRequestType } from "next/server";

const errors: string[] = [];
let checks = 0;

function assert(cond: boolean, msg: string): void {
  checks++;
  if (!cond) {
    errors.push(msg);
    console.log(`  [FALHA] ${msg}`);
  } else {
    console.log(`  [OK]    ${msg}`);
  }
}

async function makeReq() {
  const { NextRequest } = await import("next/server");
  /**
   * O `Host` é definido EXPLICITAMENTE: `new NextRequest(new URL(...))`
   * não o preenche, e `subdomainSlug` lê `req.headers.get("host")` — sem
   * ele a resolução por subdomínio devolvia sempre null e parecia um bug
   * do produto.
   */
  return (url: string, cookies?: Record<string, string>): NextRequestType => {
    const u = new URL(url);
    const r = new NextRequest(u, { headers: { host: u.host } });
    if (cookies) for (const [k, v] of Object.entries(cookies)) r.cookies.set(k, v);
    return r;
  };
}

/**
 * Slug resolvido, lido de `x-tenant-resolved` (posto por `withDebug` na
 * RESPOSTA). O `x-tenant-slug` real vai nos cabeçalhos do PEDIDO
 * reencaminhado e não aparece na resposta — ler lá dava sempre null.
 */
function tenantOf(res: { headers: Headers }): string | null {
  const v = res.headers.get("x-tenant-resolved");
  return !v || v === "-" ? null : v;
}

/** Cabeçalho que o middleware injecta no pedido entregue à aplicação. */
function forwardedTenant(res: { headers: Headers }): string | null {
  return res.headers.get("x-middleware-request-x-tenant-slug");
}


/**
 * `process.env.NODE_ENV` é read-only nos tipos do Node. Atribuir através
 * de um alias mantém o teste a poder simular produção sem `any` espalhado.
 */
function setNodeEnv(v: string): void {
  (process.env as Record<string, string | undefined>).NODE_ENV = v;
}

// ─────────────────────────────────────────────────────────────────────
// Cenários
// ─────────────────────────────────────────────────────────────────────

const SCENARIOS: Record<string, () => Promise<void>> = {
  "subdominio": async () => {
    process.env.PUBLIC_APP_URL = "https://app.spharmmt.com";
    process.env.TENANT_FALLBACK_ENABLED = "1";
    const { middleware } = await import("../../middleware");
    const req = await makeReq();

    const sub = middleware(req("https://sier.app.spharmmt.com/dashboard"));
    assert(tenantOf(sub) === "sier", "subdomínio de tenant resolve o slug");
    // O mecanismo a sério: é este cabeçalho que a aplicação lê
    // (lib/tenant-context.ts), não o de diagnóstico.
    assert(
      forwardedTenant(sub) === "sier",
      "x-tenant-slug é injectado no pedido entregue à aplicação"
    );
    // Sem isto, `app.spharmmt.com` resolveria slug="app" e
    // curto-circuitava o fallback — é o bug que motivou platformLabel().
    assert(
      tenantOf(middleware(req("https://app.spharmmt.com/dashboard"))) === null,
      "o label do host público não é tratado como tenant"
    );
    assert(
      tenantOf(middleware(req("https://admin.spharmmt.com/x"))) === null,
      "'admin' é label reservada"
    );
  },

  "ip-nao-e-tenant": async () => {
    // Um host que é um IP não pode resolver o primeiro octeto como
    // tenant. `164` passa no formato de slug; o que o salva é o label do
    // host público estar reservado.
    process.env.PUBLIC_APP_URL = "http://164.132.85.211";
    process.env.TENANT_FALLBACK_ENABLED = "1";
    const { middleware } = await import("../../middleware");
    const req = await makeReq();
    assert(
      tenantOf(middleware(req("http://164.132.85.211/dashboard"))) === null,
      "acesso por IP não resolve o primeiro octeto como tenant"
    );
    assert(
      tenantOf(middleware(req("http://127.0.0.1:8080/dashboard"))) === null,
      "acesso pelo túnel (127.0.0.1) não resolve tenant"
    );
  },

  "labels-extra": async () => {
    process.env.PUBLIC_APP_URL = "https://app.spharmmt.com";
    process.env.TENANT_RESERVED_LABELS = "status,docs";
    const { middleware } = await import("../../middleware");
    const req = await makeReq();
    assert(
      tenantOf(middleware(req("https://status.app.spharmmt.com/"))) === null,
      "label de TENANT_RESERVED_LABELS não é tenant"
    );
    assert(
      tenantOf(middleware(req("https://sier.app.spharmmt.com/"))) === "sier",
      "um tenant real continua a resolver com a lista extra activa"
    );
  },

  "fallback-http": async () => {
    process.env.PUBLIC_APP_URL = "http://164.132.85.211";
    process.env.TENANT_FALLBACK_ENABLED = "1";
    process.env.SESSION_COOKIE_SECURE = "0";
    const { middleware } = await import("../../middleware");
    const req = await makeReq();

    const res = middleware(req("http://164.132.85.211/dashboard?__tenant=sier"));
    assert(tenantOf(res) === "sier", "?__tenant resolve quando o fallback está ligado");

    const setCookie = res.headers.get("set-cookie") ?? "";
    assert(setCookie.includes("__tenant=sier"), "o slug é persistido no cookie __tenant");
    // Sobre HTTP o cookie NÃO pode ser Secure: o browser descarta-o em
    // silêncio e o ?__tenant teria de ser repetido em cada pedido.
    assert(!/;\s*Secure/i.test(setCookie), "sobre HTTP o cookie __tenant NÃO leva Secure");

    assert(
      tenantOf(middleware(req("http://164.132.85.211/x", { __tenant: "sier" }))) === "sier",
      "o cookie __tenant resolve em pedidos seguintes"
    );
  },

  "cookie-secure-https": async () => {
    process.env.PUBLIC_APP_URL = "https://app.spharmmt.com";
    process.env.TENANT_FALLBACK_ENABLED = "1";
    process.env.SESSION_COOKIE_SECURE = "1";
    const { middleware } = await import("../../middleware");
    const req = await makeReq();
    const res = middleware(req("https://app.spharmmt.com/x?__tenant=sier"));
    assert(
      /;\s*Secure/i.test(res.headers.get("set-cookie") ?? ""),
      "com SESSION_COOKIE_SECURE=1 o cookie __tenant leva Secure"
    );
  },

  "fallback-desligado-producao": async () => {
    process.env.PUBLIC_APP_URL = "https://app.spharmmt.com";
    process.env.TENANT_FALLBACK_ENABLED = "0";
    // Essencial: fora de produção o `?__tenant` continua a ser honrado de
    // propósito, como override de desenvolvimento.
    setNodeEnv("production");
    const { middleware } = await import("../../middleware");
    const req = await makeReq();
    assert(
      tenantOf(middleware(req("https://app.spharmmt.com/x?__tenant=sier"))) === null,
      "em produção e com o fallback desligado, ?__tenant é ignorado"
    );
  },

  "override-dev": async () => {
    process.env.PUBLIC_APP_URL = "https://app.spharmmt.com";
    process.env.TENANT_FALLBACK_ENABLED = "0";
    setNodeEnv("development");
    const { middleware } = await import("../../middleware");
    const req = await makeReq();
    assert(
      tenantOf(middleware(req("https://app.spharmmt.com/x?__tenant=sier"))) === "sier",
      "fora de produção o ?__tenant funciona como override de dev"
    );
  },

  "slugs-invalidos": async () => {
    process.env.PUBLIC_APP_URL = "https://app.spharmmt.com";
    process.env.TENANT_FALLBACK_ENABLED = "1";
    const { middleware } = await import("../../middleware");
    const req = await makeReq();
    for (const bad of ["../etc", "A_MAIUSCULO", "a", "-comeca-com-hifen", "x".repeat(64)]) {
      assert(
        tenantOf(middleware(req(`https://app.spharmmt.com/x?__tenant=${encodeURIComponent(bad)}`))) === null,
        `slug inválido rejeitado: ${JSON.stringify(bad)}`
      );
    }
  },

  "cookie-sessao": async () => {
    const { sessionCookieOptions } = await import("../../lib/runtime-config");

    process.env.SESSION_COOKIE_SECURE = "0";
    assert(sessionCookieOptions(60).secure === false, "SESSION_COOKIE_SECURE=0 → secure false");

    process.env.SESSION_COOKIE_SECURE = "1";
    assert(sessionCookieOptions(60).secure === true, "SESSION_COOKIE_SECURE=1 → secure true");

    delete process.env.SESSION_COOKIE_SECURE;
    process.env.PUBLIC_APP_URL = "https://app.spharmmt.com";
    assert(sessionCookieOptions(60).secure === true, "sem valor explícito, HTTPS → secure true");

    process.env.PUBLIC_APP_URL = "http://164.132.85.211";
    assert(sessionCookieOptions(60).secure === false, "sem valor explícito, HTTP → secure false");

    assert(sessionCookieOptions(123).maxAge === 123, "maxAge é respeitado");
    assert(sessionCookieOptions(60).httpOnly === true, "o cookie de sessão é httpOnly");
  },

  "build-pg-url": async () => {
    const { buildPgUrl } = await import("../tenancy/_shared");
    const opts = { host: "postgres", port: 5432, dbName: "t_x", user: "u", password: "p@ss/1" };

    delete process.env.TENANT_DB_SSLMODE;
    assert(!buildPgUrl(opts).includes("sslmode"), "sem TENANT_DB_SSLMODE a URL fica sem sslmode");

    process.env.TENANT_DB_SSLMODE = "disable";
    assert(
      buildPgUrl(opts).endsWith("?sslmode=disable"),
      "TENANT_DB_SSLMODE=disable é anexado à URL do provisionamento"
    );

    process.env.TENANT_DB_SSLMODE = "require";
    assert(buildPgUrl(opts).endsWith("?sslmode=require"), "TENANT_DB_SSLMODE=require é anexado");

    assert(
      buildPgUrl(opts).includes(encodeURIComponent("p@ss/1")),
      "a password continua a ser escapada na URL"
    );
  },

  "registry-sem-fallback": async () => {
    setNodeEnv("production");
    process.env.ALLOW_LEGACY_DATABASE_FALLBACK = "0";
    const reg = await import("../../lib/tenant-registry");

    let threw: unknown = null;
    try {
      await reg.getTenantPrismaOrLegacy(null);
    } catch (e) {
      threw = e;
    }
    assert(
      threw !== null && (threw as Error).name === "TenantResolutionError",
      "sem tenant e sem fallback permitido, atira TenantResolutionError"
    );
    assert(
      /__tenant|subdom/i.test(String((threw as Error)?.message ?? "")),
      "a mensagem de erro indica como resolver (subdomínio ou ?__tenant)"
    );
  },
};

// ─────────────────────────────────────────────────────────────────────

async function runOne(name: string): Promise<void> {
  const fn = SCENARIOS[name];
  if (!fn) {
    console.log(`  [FALHA] cenário desconhecido: ${name}`);
    process.exit(1);
  }
  await fn();
  console.log(`__RESUMO__ ${checks} ${errors.length}`);
  process.exit(errors.length === 0 ? 0 : 1);
}

async function runAll(): Promise<void> {
  const self = fileURLToPath(import.meta.url);
  let totalChecks = 0;
  let totalErrors = 0;

  for (const name of Object.keys(SCENARIOS)) {
    console.log(`\n${name}`);
    const r = spawnSync("npx", ["tsx", self, name], {
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    for (const line of out.split(/\r?\n/)) {
      if (line.startsWith("  [OK]") || line.startsWith("  [FALHA]")) console.log(line);
    }
    const m = out.match(/__RESUMO__ (\d+) (\d+)/);
    if (m) {
      totalChecks += Number(m[1]);
      totalErrors += Number(m[2]);
    } else {
      // Sem resumo, o cenário rebentou antes de terminar. Contar como
      // falha em vez de o ignorar em silêncio.
      totalChecks += 1;
      totalErrors += 1;
      console.log(`  [FALHA] o cenário "${name}" não chegou ao fim`);
      const tail = out.split(/\r?\n/).filter(Boolean).slice(-6);
      for (const l of tail) console.log(`          ${l}`);
    }
  }

  console.log(`\n${totalChecks - totalErrors}/${totalChecks} verificações passaram`);
  if (totalErrors > 0) {
    console.error(`\n${totalErrors} FALHA(S)`);
    process.exit(1);
  }
  console.log("test-tenant-resolution: OK");
}

const arg = process.argv[2];
(arg ? runOne(arg) : runAll()).catch((e) => {
  console.error("erro inesperado:", e);
  process.exit(1);
});
