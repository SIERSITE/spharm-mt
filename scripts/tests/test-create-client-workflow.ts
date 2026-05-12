/**
 * scripts/tests/test-create-client-workflow.ts
 *
 * Testes do workflow sem rede e sem BD. Cobre os caminhos que não
 * exigem provider funcional:
 *
 *  · validate-inputs — slug, nome, email, password, farmácias
 *  · select-provider — propaga erro accionável quando nada configurado
 *  · dry-run — short-circuit ok=true sem side-effects
 *
 * Caminhos que requerem control plane (slug-check, register-tenant,
 * migrate, etc.) ficam para integration tests manuais via CLI contra
 * Neon real.
 *
 * Correr:
 *   npx tsx scripts/tests/test-create-client-workflow.ts
 */

import "dotenv/config";
import { createClient, type CreateClientInput } from "../../lib/admin/create-client-workflow";

const errors: string[] = [];

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    errors.push(msg);
    console.error(`  ✗ ${msg}`);
  } else {
    console.log(`  ✓ ${msg}`);
  }
}

// Snapshot env
const ENV_KEYS = [
  "NEON_API_KEY",
  "NEON_PROJECT_ID",
  "POSTGRES_ADMIN_URL",
  "TENANT_DB_HOST",
] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

function clearEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}
function restoreEnv(): void {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
}

const validBase: CreateClientInput = {
  slug: "test-valid",
  nome: "Grupo Teste",
  adminEmail: "admin@test.pt",
  // databaseUrl evita requireEnv crashes no select-provider
  databaseUrl: "postgresql://u:p@127.0.0.1:1/db",
  dryRun: true,
};

async function run() {
  // ─── 1. validate-inputs: slug inválido ────────────────────────────
  console.log("\n▶ validate-inputs");
  {
    const r = await createClient({ ...validBase, slug: "Bad Slug!" });
    assert(!r.ok, "slug inválido → ok=false");
    assert(r.step === "validate-inputs", "step=validate-inputs");
    assert((r.error ?? "").includes("slug inválido"), "mensagem menciona slug");
  }
  {
    const r = await createClient({ ...validBase, slug: "" });
    assert(!r.ok && r.step === "validate-inputs", "slug vazio rejeitado em validate");
  }

  // ─── 2. validate-inputs: nome muito curto ─────────────────────────
  {
    const r = await createClient({ ...validBase, nome: "X" });
    assert(!r.ok && (r.error ?? "").includes("nome"), "nome curto rejeitado");
  }

  // ─── 3. validate-inputs: email inválido ───────────────────────────
  {
    const r = await createClient({ ...validBase, adminEmail: "no-at-here" });
    assert(!r.ok && (r.error ?? "").includes("admin-email"), "email sem @ rejeitado");
  }
  {
    const r = await createClient({ ...validBase, adminEmail: "foo@bar" });
    assert(!r.ok && (r.error ?? "").includes("admin-email"), "email sem TLD rejeitado");
  }

  // ─── 4. validate-inputs: password curta ───────────────────────────
  {
    const r = await createClient({ ...validBase, adminPassword: "short" });
    assert(!r.ok && (r.error ?? "").includes("password muito curta"), "password < 8 chars rejeitada");
  }

  // ─── 5. validate-inputs: farmácia vazia na lista ──────────────────
  {
    const r = await createClient({ ...validBase, farmacias: ["Boa", "", "Outra"] });
    assert(!r.ok && (r.error ?? "").includes("farmácia"), "farmácia vazia rejeitada");
  }
  {
    const r = await createClient({ ...validBase, farmacias: ["A".repeat(250)] });
    assert(!r.ok && (r.error ?? "").includes("muito longo"), "farmácia > 200 chars rejeitada");
  }

  // ─── 6. validate passa, select-provider falha sem nada ────────────
  console.log("\n▶ select-provider sem config");
  clearEnv();
  {
    const r = await createClient({
      slug: "ok-slug",
      nome: "Grupo OK",
      adminEmail: "a@b.pt",
      dryRun: true,
    });
    assert(!r.ok, "sem provider configurado → ok=false");
    assert(r.step === "select-provider", `step=select-provider, got ${r.step}`);
    assert((r.error ?? "").includes("Sem provider"), "erro accionável");
  }

  // ─── 7. dry-run completa quando provider seleccionável ────────────
  console.log("\n▶ dry-run com provider manual");
  {
    const r = await createClient({
      slug: "dry-test",
      nome: "Grupo Dry",
      adminEmail: "a@b.pt",
      databaseUrl: "postgresql://u:p@h/d",
      dryRun: true,
      reporter: { step: () => {}, info: () => {}, warn: () => {} },
    });
    assert(r.ok, "dry-run com manual provider → ok=true");
    assert(r.step === "dry-run-done", `step=dry-run-done, got ${r.step}`);
    assert(r.provider === "manual", "provider=manual");
    assert(r.adminPassword === undefined, "dry-run NÃO devolve password");
    assert(r.ingestKey === undefined, "dry-run NÃO devolve ingest key");
    assert(r.tenantId === undefined, "dry-run NÃO regista tenant");
  }

  // ─── 8. dry-run com Neon configurado via env ──────────────────────
  console.log("\n▶ dry-run com Neon auto-detect");
  clearEnv();
  process.env.NEON_API_KEY = "napi_test";
  process.env.NEON_PROJECT_ID = "proj-test";
  {
    const r = await createClient({
      slug: "neon-dry",
      nome: "Grupo Neon Dry",
      adminEmail: "a@b.pt",
      dryRun: true,
      reporter: { step: () => {}, info: () => {}, warn: () => {} },
    });
    assert(r.ok && r.step === "dry-run-done", "Neon dry-run → ok");
    assert(r.provider === "neon", "auto-detect Neon em dry-run");
  }

  // ─── 9. reporter recebe steps ─────────────────────────────────────
  console.log("\n▶ reporter callbacks");
  {
    const seenSteps: string[] = [];
    const seenInfo: string[] = [];
    clearEnv();
    const r = await createClient({
      slug: "rep-test",
      nome: "Rep Test",
      adminEmail: "r@b.pt",
      databaseUrl: "postgresql://u:p@h/d",
      dryRun: true,
      reporter: {
        step: (n) => seenSteps.push(n),
        info: (m) => seenInfo.push(m),
        warn: () => {},
      },
    });
    assert(r.ok, "reporter dry-run ok");
    assert(seenSteps.includes("validate-inputs"), "reporter recebeu validate-inputs");
    assert(seenSteps.includes("select-provider"), "reporter recebeu select-provider");
    assert(seenInfo.some((m) => m.includes("provider: manual")), "reporter recebeu info do provider");
  }

  // ─── 10. provider mutuamente exclusivos → erro select-provider ────
  console.log("\n▶ flags mutuamente exclusivas");
  clearEnv();
  {
    const r = await createClient({
      slug: "x-valid",
      nome: "X X",
      adminEmail: "x@b.pt",
      provider: "manual",
      createDb: true,
      dryRun: true,
    });
    assert(!r.ok, "manual + createDb → ok=false");
    assert(r.step === "select-provider", `step=select-provider, got ${r.step}`);
    assert((r.error ?? "").includes("Múltiplas"), "erro de múltiplas flags");
  }

  // ─── 11. duração registada ────────────────────────────────────────
  {
    const r = await createClient({ ...validBase });
    assert(typeof r.durationMs === "number" && r.durationMs >= 0, "durationMs registado");
  }

  restoreEnv();

  // ─── Resumo ───────────────────────────────────────────────────────
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
