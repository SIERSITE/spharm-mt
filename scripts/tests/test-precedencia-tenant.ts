/**
 * scripts/tests/test-precedencia-tenant.ts
 *
 * Quem manda no tenant: o Host, o URL, ou a memória de uma visita
 * anterior.
 *
 * ─────────────────────────────────────────────────────────────────────
 * O DEFEITO QUE ISTO GUARDA
 *
 * A ordem era subdomínio → cookie → query. O cookie vencia a query, e
 * isso tornava o `?__tenant=` inoperante para quem já tivesse visitado
 * outro tenant. Medido em produção em 2026-08-28:
 *
 *   sem cookie,  ?__tenant=silveira  →  resolved=silveira  source=query
 *   cookie=sier, ?__tenant=silveira  →  resolved=sier      source=cookie
 *
 * O link dizia silveira, o servidor servia sier, e nada na página o
 * dizia. Importa porque o instalador que vai para o PC do cliente abre
 * exactamente `https://app.spharmmt.com/login?__tenant=silveira`: um
 * cookie deixado por uma visita anterior punha lá o login do tenant
 * errado, e as credenciais certas eram recusadas com "Credenciais
 * inválidas" — a mesma mensagem, mais uma vez a apontar para o sítio
 * errado.
 *
 * ─────────────────────────────────────────────────────────────────────
 * O que corre aqui é o MIDDLEWARE REAL, importado do ficheiro, com
 * `NextRequest` a sério. Não há imitação da resolução: se a ordem
 * mudar, isto parte.
 *
 * Sem base de dados e sem rede.
 *
 * Uso: npx tsx scripts/tests/test-precedencia-tenant.ts
 */
import { SignJWT } from "jose";
import { readFileSync } from "node:fs";

let pass = 0;
let fail = 0;
const check = (ok: boolean, label: string, extra = "") => {
  if (ok) {
    pass++;
    console.log(`  [OK]    ${label}`);
  } else {
    fail++;
    console.log(`  [FALHA] ${label}${extra ? `  — ${extra}` : ""}`);
  }
};

const SEGREDO = "segredo-de-teste-com-tamanho-suficiente";

async function token(tenant: string): Promise<string> {
  return new SignJWT({
    sub: "u1",
    email: "f.silveirense@gmail.com",
    nome: "Administrador",
    perfil: "ADMINISTRADOR",
    farmaciaId: null,
    tenant,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("8h")
    .sign(new TextEncoder().encode(SEGREDO));
}

function destino(res: { status: number; headers: Headers }): string | null {
  if (res.status < 300 || res.status >= 400) return null;
  const loc = res.headers.get("location");
  return loc ? new URL(loc).pathname : null;
}

async function main(): Promise<void> {
  process.env.AUTH_SECRET = SEGREDO;
  process.env.PUBLIC_APP_URL = "https://app.spharmmt.com";
  process.env.TENANT_FALLBACK_ENABLED = "1";
  const { NextRequest } = await import("next/server");
  const { middleware } = await import("../../middleware");

  const pedido = (url: string, cookies: Record<string, string> = {}) => {
    const req = new NextRequest(new URL(url), {
      headers: { host: new URL(url).host },
    });
    for (const [k, v] of Object.entries(cookies)) req.cookies.set(k, v);
    return req;
  };

  /** O que o middleware diz ter resolvido, e por que via. */
  const resolvido = (res: { headers: Headers }) => ({
    slug: res.headers.get("x-tenant-resolved"),
    via: res.headers.get("x-tenant-source"),
  });

  // ═══════════════════════════════════════════════════════════════════
  console.log("\n=== o URL vence o cookie ===");
  {
    // O caso exacto que o instalador abre no PC do cliente.
    const URL_MSI = "https://app.spharmmt.com/login?__tenant=silveira";

    const semCookie = await middleware(pedido(URL_MSI));
    const a = resolvido(semCookie);
    check(a.slug === "silveira" && a.via === "query", "sem cookie: query resolve silveira", JSON.stringify(a));

    const cookieDoutro = await middleware(pedido(URL_MSI, { __tenant: "sier" }));
    const b = resolvido(cookieDoutro);
    check(
      b.slug === "silveira",
      "cookie=sier + ?__tenant=silveira → SILVEIRA (era sier)",
      JSON.stringify(b),
    );
    check(b.via === "query", "…e a via é a query, não o cookie", String(b.via));

    // Sem query, o cookie continua a mandar — é para isso que existe.
    const soCookie = await middleware(
      pedido("https://app.spharmmt.com/login", { __tenant: "sier" }),
    );
    const c = resolvido(soCookie);
    check(
      c.slug === "sier" && c.via === "cookie",
      "controlo negativo: sem query, o cookie continua a resolver",
      JSON.stringify(c),
    );
  }

  console.log("\n=== o cookie é REESCRITO, não só criado ===");
  {
    // A outra metade do defeito: dar prioridade à query sem reescrever o
    // cookie deixava o valor antigo a mandar no pedido seguinte, que já
    // não traz a query.
    const res = await middleware(
      pedido("https://app.spharmmt.com/login?__tenant=silveira", { __tenant: "sier" }),
    );
    const ck = res.cookies.get("__tenant");
    check(ck?.value === "silveira", "o cookie passa a silveira", String(ck?.value));
    check(ck?.httpOnly === true, "…httpOnly");
    check(ck?.sameSite === "lax", "…sameSite=lax");
    check(ck?.path === "/", "…em todo o site");
    check(ck?.secure === true, "…secure, porque PUBLIC_APP_URL é https");

    // E o pedido SEGUINTE, já sem query, tem de resolver o novo.
    const seguinte = await middleware(
      pedido("https://app.spharmmt.com/login", { __tenant: "silveira" }),
    );
    check(
      resolvido(seguinte).slug === "silveira",
      "o pedido seguinte, sem query, resolve o tenant novo",
    );

    // Sem query não se toca no cookie: um pedido normal não deve
    // reescrever o que não escolheu.
    const semQuery = await middleware(
      pedido("https://app.spharmmt.com/login", { __tenant: "sier" }),
    );
    check(
      semQuery.cookies.get("__tenant") === undefined,
      "controlo negativo: sem query, o cookie não é reescrito",
    );
  }

  console.log("\n=== o subdomínio continua acima de tudo ===");
  {
    const res = await middleware(
      pedido("https://silveira.spharmmt.com/login?__tenant=sier", { __tenant: "sier" }),
    );
    const r = resolvido(res);
    check(
      r.slug === "silveira" && r.via === "subdomain",
      "o Host vence a query e o cookie",
      JSON.stringify(r),
    );
    check(
      res.cookies.get("__tenant") === undefined,
      "…e o subdomínio não escreve cookie nenhum",
    );
  }

  console.log("\n=== um ?__tenant= inválido não troca nada ===");
  {
    // Se um slug lixo caísse para o cookie, `?__tenant=admin` era uma
    // forma de rebentar a resolução de quem já estava algures.
    for (const mau of ["admin", "api", "app", "www", "spharmmt", "a", "COM MAIÚSCULAS!", ""]) {
      const res = await middleware(
        pedido(
          `https://app.spharmmt.com/login?__tenant=${encodeURIComponent(mau)}`,
          { __tenant: "silveira" },
        ),
      );
      const r = resolvido(res);
      check(
        r.slug === "silveira" && r.via === "cookie",
        `?__tenant=${JSON.stringify(mau)} é ignorado e o cookie mantém-se`,
        JSON.stringify(r),
      );
      check(
        res.cookies.get("__tenant") === undefined,
        `…e não reescreve o cookie`,
      );
    }
  }

  console.log("\n=== não há travessia entre tenants ===");
  {
    // Sessão de silveira + pedido explícito de sier: a sessão não vale.
    const t = await token("silveira");
    const res = await middleware(
      pedido("https://app.spharmmt.com/dashboard?__tenant=sier", {
        session: t,
        __tenant: "silveira",
      }),
    );
    check(destino(res) === "/login", "sessão de silveira a pedir sier → /login", String(destino(res)));
    check(
      resolvido(res).slug === "sier",
      "…e o tenant resolvido é o pedido, não o da sessão",
    );
    check(
      res.cookies.get("__tenant")?.value === "sier",
      "…e o cookie acompanha, para o login ser o do tenant certo",
    );

    // O simétrico: com a sessão do tenant certo, entra.
    const ok = await middleware(
      pedido("https://app.spharmmt.com/dashboard?__tenant=silveira", {
        session: await token("silveira"),
        __tenant: "sier",
      }),
    );
    check(
      destino(ok) === null,
      "controlo negativo: sessão de silveira + ?__tenant=silveira entra, apesar do cookie=sier",
      String(destino(ok)),
    );

    // E a query não serve para forjar tenant nenhum sem sessão.
    const semSessao = await middleware(
      pedido("https://app.spharmmt.com/dashboard?__tenant=sier"),
    );
    check(destino(semSessao) === "/login", "sem sessão, a query não abre nada");
  }

  console.log("\n=== a ordem está escrita no código, não é acidente ===");
  {
    const src = readFileSync("middleware.ts", "utf8");
    const corpo = src.slice(
      src.indexOf("function resolveSlug"),
      src.indexOf("const MW_VERSION"),
    );
    const iSub = corpo.indexOf("subdomainSlug(req)");
    const iQuery = corpo.indexOf('searchParams.get("__tenant")');
    const iCookie = corpo.indexOf("req.cookies.get(TENANT_COOKIE)");
    check(iSub >= 0 && iQuery >= 0 && iCookie >= 0, "as três estratégias estão lá");
    check(iSub < iQuery, "subdomínio antes da query");
    check(iQuery < iCookie, "query antes do cookie", `query@${iQuery} cookie@${iCookie}`);

    check(
      /if \(slug && source === "query"\) \{/.test(src),
      "o cookie é reescrito sempre que a query resolve",
    );
    check(
      !/source === "query" && fallbackEnabled\(\)/.test(src),
      "…sem a condição duplicada que impedia a escrita em dev",
    );
  }

  console.log(`\n${pass} ok, ${fail} falhas`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
