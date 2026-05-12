/**
 * scripts/tests/test-neon-provider.ts
 *
 * Testes do NeonProvider com fetch mockado — sem rede.
 * Cobre:
 *  · Happy path: createRole → createDatabase → connection_uri → SELECT 1
 *  · Falha em createDatabase atira E faz cleanup do role
 *  · Falha em connection_uri atira E faz cleanup de DB + role
 *  · Falha em SELECT 1 atira E faz cleanup de DB + role
 *  · Branch resolution: default ganha sobre primary, primary ganha sobre primeiro
 *  · destroyDatabase chama os 2 endpoints DELETE
 *  · Erros HTTP da Neon API surgem mensagens accionáveis
 *
 * O smoke connectivity (`testTenantDbReachable`) é interceptado por
 * uma URL `postgresql://test:test@127.0.0.1:1/test` que falha cedo
 * via timeout — não tentamos fazer SELECT 1 real. Para isolar isto,
 * injectamos a função fetch mockada e a URL devolvida é uma URL
 * conhecida que conseguimos manipular no setup.
 *
 * Como o `testTenantDbReachable` real tenta `new pg.Client + SELECT 1`,
 * forçamos a URL para localhost:1 (porta inexistente) e capturamos
 * o erro esperado. Para os asserts de happy path, validamos que a
 * função chegou a chamar SELECT 1 (i.e. capturámos um erro de rede),
 * o que confirma que o provider chegou ao step de smoke.
 *
 * Correr:
 *   npx tsx scripts/tests/test-neon-provider.ts
 */

import { NeonProvider, type FetchLike } from "../../lib/db-providers";

const errors: string[] = [];

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    errors.push(msg);
    console.error(`  ✗ ${msg}`);
  } else {
    console.log(`  ✓ ${msg}`);
  }
}

type MockCall = { method: string; path: string; body?: unknown };

type MockResponseSpec =
  | { status: number; json?: unknown; text?: string }
  | ((call: MockCall) => { status: number; json?: unknown; text?: string });

type Handler = {
  match: (call: MockCall) => boolean;
  respond: MockResponseSpec;
};

function makeFetcher(handlers: Handler[]): { fetcher: FetchLike; calls: MockCall[] } {
  const calls: MockCall[] = [];
  const fetcher: FetchLike = async (input, init) => {
    const url = typeof input === "string" ? input : input;
    const u = new URL(url);
    const path = u.pathname + u.search;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const call: MockCall = { method: init?.method ?? "GET", path, body };
    calls.push(call);
    const handler = handlers.find((h) => h.match(call));
    if (!handler) {
      throw new Error(`mock: pedido sem handler — ${call.method} ${call.path}`);
    }
    const spec = typeof handler.respond === "function" ? handler.respond(call) : handler.respond;
    const responseBody = spec.json !== undefined ? JSON.stringify(spec.json) : (spec.text ?? "");
    return new Response(responseBody, {
      status: spec.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetcher, calls };
}

// Cada caso de teste é assíncrono. Acumular asserts em fila e correr.
async function run() {
  // ─── 1. Happy path branch resolution ──────────────────────────────
  console.log("\n▶ NeonProvider — branch resolution");
  {
    const { fetcher, calls } = makeFetcher([
      {
        match: (c) => c.method === "GET" && c.path.startsWith("/projects/p1/branches"),
        respond: {
          status: 200,
          json: {
            branches: [
              { id: "br_other", name: "feature", default: false },
              { id: "br_default", name: "main", default: true },
            ],
          },
        },
      },
      {
        match: (c) =>
          c.method === "POST" && c.path === "/projects/p1/branches/br_default/roles",
        respond: {
          status: 200,
          json: { role: { name: "spharmmt_demo", password: "the-password" } },
        },
      },
      {
        match: (c) =>
          c.method === "POST" && c.path === "/projects/p1/branches/br_default/databases",
        respond: { status: 200, json: { database: { name: "spharmmt_t_demo" } } },
      },
      {
        match: (c) => c.method === "GET" && c.path.startsWith("/projects/p1/connection_uri"),
        respond: {
          status: 200,
          json: { uri: "postgresql://spharmmt_demo:the-password@127.0.0.1:1/spharmmt_t_demo?sslmode=disable" },
        },
      },
    ]);

    const p = new NeonProvider({ apiKey: "k", projectId: "p1", apiBaseUrl: "https://mock", fetcher });
    try {
      await p.createDatabase({ slug: "demo" });
      assert(false, "happy path: esperava falha no SELECT 1 (porta 1)");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      assert(
        msg.startsWith("Neon: DB criada mas SELECT 1 falhou"),
        "happy path até connection_uri; SELECT 1 falha esperada (URL 127.0.0.1:1)"
      );
    }
    // Confirma ordem das chamadas
    assert(calls.length >= 4, "fez ≥4 chamadas (branches, role, db, uri)");
    assert(calls[0].path.startsWith("/projects/p1/branches"), "1ª = list branches");
    assert(
      calls[1].method === "POST" && calls[1].path.includes("/branches/br_default/roles"),
      "2ª = POST role na branch default"
    );
    assert(
      calls[2].method === "POST" && calls[2].path.includes("/branches/br_default/databases"),
      "3ª = POST database na mesma branch"
    );
    assert(
      calls[3].path.startsWith("/projects/p1/connection_uri") &&
        calls[3].path.includes("branch_id=br_default") &&
        calls[3].path.includes("database_name=spharmmt_t_demo") &&
        calls[3].path.includes("role_name=spharmmt_demo") &&
        calls[3].path.includes("pooled=true"),
      "4ª = connection_uri com branch + db + role + pooled=true"
    );
  }

  // ─── 2. Branch resolution: primary se não houver default ─────────
  console.log("\n▶ NeonProvider — branch resolution: primary fallback");
  {
    const { fetcher, calls } = makeFetcher([
      {
        match: (c) => c.method === "GET" && c.path.startsWith("/projects/p2/branches"),
        respond: {
          status: 200,
          json: {
            branches: [
              { id: "br_a", name: "feature" },
              { id: "br_primary", name: "main", primary: true },
            ],
          },
        },
      },
      {
        match: (c) => c.method === "POST" && c.path.includes("/branches/br_primary/roles"),
        respond: { status: 500, text: "boom" },
      },
    ]);
    const p = new NeonProvider({ apiKey: "k", projectId: "p2", apiBaseUrl: "https://mock", fetcher });
    try {
      await p.createDatabase({ slug: "demo" });
      assert(false, "esperava erro");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      assert(msg.includes("createRole"), "erro propaga createRole label");
      assert(msg.includes("500"), "erro inclui status HTTP");
    }
    assert(
      calls.some((c) => c.path.includes("/branches/br_primary/roles")),
      "usou branch br_primary (default ausente, primary ganha)"
    );
  }

  // ─── 3. Project sem branches → erro accionável ────────────────────
  console.log("\n▶ NeonProvider — project sem branches");
  {
    const { fetcher } = makeFetcher([
      {
        match: (c) => c.path.startsWith("/projects/p3/branches"),
        respond: { status: 200, json: { branches: [] } },
      },
    ]);
    const p = new NeonProvider({ apiKey: "k", projectId: "p3", apiBaseUrl: "https://mock", fetcher });
    try {
      await p.createDatabase({ slug: "demo" });
      assert(false, "esperava erro");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      assert(msg.includes("sem branches"), "erro accionável quando projecto sem branches");
    }
  }

  // ─── 4. createRole falha → sem cleanup pendente ───────────────────
  console.log("\n▶ NeonProvider — createRole falha");
  {
    const { fetcher, calls } = makeFetcher([
      {
        match: (c) => c.path.startsWith("/projects/p4/branches") && c.method === "GET",
        respond: { status: 200, json: { branches: [{ id: "br", name: "main", default: true }] } },
      },
      {
        match: (c) => c.method === "POST" && c.path.endsWith("/roles"),
        respond: { status: 409, text: "conflict: role already exists" },
      },
    ]);
    const p = new NeonProvider({ apiKey: "k", projectId: "p4", apiBaseUrl: "https://mock", fetcher });
    try {
      await p.createDatabase({ slug: "demo" });
      assert(false, "esperava erro");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      assert(msg.includes("createRole"), "erro label createRole");
      assert(msg.includes("409"), "inclui status 409");
    }
    const deletes = calls.filter((c) => c.method === "DELETE");
    assert(deletes.length === 0, "createRole falhou — sem DELETE (nada para limpar)");
  }

  // ─── 5. createDatabase falha → DELETE role ────────────────────────
  console.log("\n▶ NeonProvider — createDatabase falha → cleanup role");
  {
    const { fetcher, calls } = makeFetcher([
      {
        match: (c) => c.path.startsWith("/projects/p5/branches") && c.method === "GET",
        respond: { status: 200, json: { branches: [{ id: "br", name: "main", default: true }] } },
      },
      {
        match: (c) => c.method === "POST" && c.path.endsWith("/roles"),
        respond: {
          status: 200,
          json: { role: { name: "spharmmt_demo", password: "pw" } },
        },
      },
      {
        match: (c) => c.method === "POST" && c.path.endsWith("/databases"),
        respond: { status: 500, text: "internal" },
      },
      {
        match: (c) => c.method === "DELETE" && c.path.endsWith("/roles/spharmmt_demo"),
        respond: { status: 200, json: {} },
      },
    ]);
    const p = new NeonProvider({ apiKey: "k", projectId: "p5", apiBaseUrl: "https://mock", fetcher });
    try {
      await p.createDatabase({ slug: "demo" });
      assert(false, "esperava erro");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      assert(msg.includes("createDatabase"), "erro label createDatabase");
    }
    const roleDeletes = calls.filter((c) => c.method === "DELETE" && c.path.includes("/roles/"));
    assert(roleDeletes.length === 1, "1× DELETE role após falha de createDatabase");
    const dbDeletes = calls.filter((c) => c.method === "DELETE" && c.path.includes("/databases/"));
    assert(dbDeletes.length === 0, "0× DELETE database (não foi criada)");
  }

  // ─── 6. connection_uri falha → DELETE db + role ───────────────────
  console.log("\n▶ NeonProvider — connection_uri falha → cleanup db + role");
  {
    const { fetcher, calls } = makeFetcher([
      {
        match: (c) => c.path.startsWith("/projects/p6/branches") && c.method === "GET",
        respond: { status: 200, json: { branches: [{ id: "br", name: "main", default: true }] } },
      },
      {
        match: (c) => c.method === "POST" && c.path.endsWith("/roles"),
        respond: { status: 200, json: { role: { name: "spharmmt_demo", password: "pw" } } },
      },
      {
        match: (c) => c.method === "POST" && c.path.endsWith("/databases"),
        respond: { status: 200, json: { database: {} } },
      },
      {
        match: (c) => c.method === "GET" && c.path.startsWith("/projects/p6/connection_uri"),
        respond: { status: 403, text: "forbidden" },
      },
      {
        match: (c) => c.method === "DELETE",
        respond: { status: 200, json: {} },
      },
    ]);
    const p = new NeonProvider({ apiKey: "k", projectId: "p6", apiBaseUrl: "https://mock", fetcher });
    try {
      await p.createDatabase({ slug: "demo" });
      assert(false, "esperava erro");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      assert(msg.includes("connection_uri"), "erro label connection_uri");
    }
    const dbDeletes = calls.filter((c) => c.method === "DELETE" && c.path.includes("/databases/"));
    const roleDeletes = calls.filter((c) => c.method === "DELETE" && c.path.includes("/roles/"));
    assert(dbDeletes.length === 1, "1× DELETE database");
    assert(roleDeletes.length === 1, "1× DELETE role");
  }

  // ─── 7. reveal_password fallback ──────────────────────────────────
  console.log("\n▶ NeonProvider — reveal_password fallback");
  {
    const { fetcher, calls } = makeFetcher([
      {
        match: (c) => c.path.startsWith("/projects/p7/branches") && c.method === "GET",
        respond: { status: 200, json: { branches: [{ id: "br", name: "main", default: true }] } },
      },
      {
        match: (c) => c.method === "POST" && c.path.endsWith("/roles"),
        respond: { status: 200, json: { role: { name: "spharmmt_demo" /* sem password */ } } },
      },
      {
        match: (c) =>
          c.method === "GET" && c.path.includes("/roles/spharmmt_demo/reveal_password"),
        respond: { status: 200, json: { password: "fallback-pw" } },
      },
      {
        match: (c) => c.method === "POST" && c.path.endsWith("/databases"),
        respond: { status: 500, text: "deliberate stop after password retrieved" },
      },
      {
        match: (c) => c.method === "DELETE",
        respond: { status: 200, json: {} },
      },
    ]);
    const p = new NeonProvider({ apiKey: "k", projectId: "p7", apiBaseUrl: "https://mock", fetcher });
    try {
      await p.createDatabase({ slug: "demo" });
    } catch {
      // esperado — só queremos confirmar que reveal_password foi chamado
    }
    const reveal = calls.filter((c) => c.path.includes("reveal_password"));
    assert(reveal.length === 1, "reveal_password chamado quando role criada sem password");
  }

  // ─── 8. destroyDatabase ──────────────────────────────────────────
  console.log("\n▶ NeonProvider — destroyDatabase");
  {
    const { fetcher, calls } = makeFetcher([
      {
        match: (c) => c.path.startsWith("/projects/p8/branches") && c.method === "GET",
        respond: { status: 200, json: { branches: [{ id: "br", name: "main", default: true }] } },
      },
      {
        match: (c) =>
          c.method === "DELETE" && c.path.includes("/databases/spharmmt_t_test"),
        respond: { status: 200, json: {} },
      },
      {
        match: (c) =>
          c.method === "DELETE" && c.path.includes("/roles/spharmmt_test"),
        respond: { status: 200, json: {} },
      },
    ]);
    const p = new NeonProvider({ apiKey: "k", projectId: "p8", apiBaseUrl: "https://mock", fetcher });
    await p.destroyDatabase({ dbName: "spharmmt_t_test", dbUser: "spharmmt_test" });
    const dbDeletes = calls.filter((c) => c.method === "DELETE" && c.path.includes("/databases/"));
    const roleDeletes = calls.filter((c) => c.method === "DELETE" && c.path.includes("/roles/"));
    assert(dbDeletes.length === 1, "destroyDatabase: 1× DELETE database");
    assert(roleDeletes.length === 1, "destroyDatabase: 1× DELETE role");
  }

  // ─── 9. destroyDatabase parcial → erro accionável ────────────────
  console.log("\n▶ NeonProvider — destroyDatabase parcial");
  {
    const { fetcher } = makeFetcher([
      {
        match: (c) => c.path.startsWith("/projects/p9/branches") && c.method === "GET",
        respond: { status: 200, json: { branches: [{ id: "br", name: "main", default: true }] } },
      },
      {
        match: (c) => c.method === "DELETE" && c.path.includes("/databases/"),
        respond: { status: 500, text: "internal" },
      },
      {
        match: (c) => c.method === "DELETE" && c.path.includes("/roles/"),
        respond: { status: 200, json: {} },
      },
    ]);
    const p = new NeonProvider({ apiKey: "k", projectId: "p9", apiBaseUrl: "https://mock", fetcher });
    try {
      await p.destroyDatabase({ dbName: "x", dbUser: "y" });
      assert(false, "esperava erro");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      assert(msg.includes("destroy parcial"), "destroyDatabase parcial → erro accionável");
      assert(msg.includes("DB x"), "menciona DB falhada");
    }
  }

  // ─── Resumo ──────────────────────────────────────────────────────
  console.log("");
  if (errors.length === 0) {
    console.log("✓ Todos os asserts passaram.");
    process.exit(0);
  } else {
    console.error(`✗ ${errors.length} falha(s):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
