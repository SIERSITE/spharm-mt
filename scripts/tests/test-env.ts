/**
 * scripts/tests/test-env.ts
 *
 * Testes puros para `lib/env.ts`. Sem rede, sem BD. Manipula
 * `process.env` em-process e repõe estado após cada cenário.
 *
 * Correr:
 *   npx tsx scripts/tests/test-env.ts
 */

import {
  requireEnv,
  optionalEnv,
  boolEnv,
  intEnv,
  validateScope,
  validateEnvOrThrow,
  isScopeReady,
  auditEnv,
  EnvValidationError,
} from "../../lib/env";

const errors: string[] = [];
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    errors.push(msg);
    console.error(`  ✗ ${msg}`);
  } else {
    console.log(`  ✓ ${msg}`);
  }
}
function eq(actual: unknown, expected: unknown, msg: string): void {
  assert(
    actual === expected,
    `${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const original: Record<string, string | undefined> = {};
  for (const k of Object.keys(overrides)) original[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ─── 1. requireEnv ─────────────────────────────────────────────────────
console.log("\n1. requireEnv — presente:");
withEnv({ DATABASE_URL: "postgres://test" }, () => {
  eq(requireEnv("DATABASE_URL"), "postgres://test", "devolve valor");
});

console.log("\n2. requireEnv — em falta atira com message accionável:");
withEnv({ DATABASE_URL: undefined }, () => {
  let err: EnvValidationError | null = null;
  try {
    requireEnv("DATABASE_URL");
  } catch (e) {
    err = e as EnvValidationError;
  }
  assert(err !== null, "atira EnvValidationError");
  assert(err?.message.includes("DATABASE_URL") ?? false, "mensagem inclui nome");
  assert(err?.message.includes("Postgres") ?? false, "mensagem inclui description");
});

console.log("\n3. requireEnv — vazio atira:");
withEnv({ DATABASE_URL: "" }, () => {
  let threw = false;
  try { requireEnv("DATABASE_URL"); } catch { threw = true; }
  assert(threw, "string vazia conta como missing");
});

// ─── 4. optionalEnv ───────────────────────────────────────────────────
console.log("\n4. optionalEnv:");
withEnv({ OUTBOX_MAX_ATTEMPTS: "7" }, () => {
  eq(optionalEnv("OUTBOX_MAX_ATTEMPTS"), "7", "devolve string");
});
withEnv({ OUTBOX_MAX_ATTEMPTS: undefined }, () => {
  eq(optionalEnv("OUTBOX_MAX_ATTEMPTS"), null, "null se ausente");
});

// ─── 5. boolEnv ───────────────────────────────────────────────────────
console.log("\n5. boolEnv:");
withEnv({ SPHARM_DEBUG_BROWSE: "1" }, () => eq(boolEnv("SPHARM_DEBUG_BROWSE"), true, "\"1\" = true"));
withEnv({ SPHARM_DEBUG_BROWSE: "true" }, () => eq(boolEnv("SPHARM_DEBUG_BROWSE"), true, "\"true\" = true"));
withEnv({ SPHARM_DEBUG_BROWSE: "yes" }, () => eq(boolEnv("SPHARM_DEBUG_BROWSE"), true, "\"yes\" = true"));
withEnv({ SPHARM_DEBUG_BROWSE: "0" }, () => eq(boolEnv("SPHARM_DEBUG_BROWSE"), false, "\"0\" = false"));
withEnv({ SPHARM_DEBUG_BROWSE: "anything" }, () => eq(boolEnv("SPHARM_DEBUG_BROWSE"), false, "\"anything\" = false"));
withEnv({ SPHARM_DEBUG_BROWSE: undefined }, () => eq(boolEnv("SPHARM_DEBUG_BROWSE", true), true, "default respected"));

// ─── 6. intEnv ────────────────────────────────────────────────────────
console.log("\n6. intEnv:");
withEnv({ TENANT_DB_PORT: "5433" }, () => eq(intEnv("TENANT_DB_PORT", 5432), 5433, "parsa int"));
withEnv({ TENANT_DB_PORT: "abc" }, () => eq(intEnv("TENANT_DB_PORT", 5432), 5432, "default quando NaN"));
withEnv({ TENANT_DB_PORT: undefined }, () => eq(intEnv("TENANT_DB_PORT", 5432), 5432, "default ausente"));
withEnv({ TENANT_DB_PORT: "0" }, () => eq(intEnv("TENANT_DB_PORT", 5432, 1), 1, "clamp min"));
withEnv({ TENANT_DB_PORT: "99999" }, () => eq(intEnv("TENANT_DB_PORT", 5432, 1, 65535), 65535, "clamp max"));

// ─── 7. validateScope ─────────────────────────────────────────────────
console.log("\n7. validateScope — todas presentes:");
withEnv(
  {
    DATABASE_URL: "x",
    CONTROL_DATABASE_URL: "x",
    TENANT_ENCRYPTION_SECRET: "x",
    AUTH_SECRET: "x",
  },
  () => {
    let threw = false;
    try { validateScope("web"); } catch { threw = true; }
    assert(!threw, "web scope ok quando required estão presentes");
  },
);

console.log("\n8. validateScope — falta lança com lista:");
withEnv(
  { DATABASE_URL: undefined, AUTH_SECRET: "x" },
  () => {
    let err: EnvValidationError | null = null;
    try { validateScope("web"); } catch (e) { err = e as EnvValidationError; }
    assert(err !== null, "atira");
    assert(err?.message.includes("DATABASE_URL") ?? false, "lista DATABASE_URL");
  },
);

// ─── 9. validateEnvOrThrow ────────────────────────────────────────────
console.log("\n9. validateEnvOrThrow:");
withEnv({ FOO_A: "1", FOO_B: "2" }, () => {
  let threw = false;
  try { validateEnvOrThrow(["FOO_A", "FOO_B"]); } catch { threw = true; }
  assert(!threw, "ambas presentes → ok");
});
withEnv({ FOO_A: undefined, FOO_B: "2" }, () => {
  let err: EnvValidationError | null = null;
  try { validateEnvOrThrow(["FOO_A", "FOO_B"]); } catch (e) { err = e as EnvValidationError; }
  assert(err !== null, "atira");
  assert((err?.message.includes("FOO_A")) ?? false, "lista a missing");
});

// ─── 10. isScopeReady ─────────────────────────────────────────────────
console.log("\n10. isScopeReady:");
withEnv(
  {
    DATABASE_URL: "x",
    CONTROL_DATABASE_URL: "x",
    TENANT_ENCRYPTION_SECRET: "x",
    AUTH_SECRET: "x",
  },
  () => {
    const r = isScopeReady("web");
    eq(r.ready, true, "web ready=true");
    eq(r.missing.length, 0, "missing=[]");
  },
);
withEnv({ CONTROL_DATABASE_URL: undefined }, () => {
  const r = isScopeReady("web");
  eq(r.ready, false, "web ready=false sem CONTROL_DATABASE_URL");
  assert(r.missing.includes("CONTROL_DATABASE_URL"), "missing inclui CONTROL_DATABASE_URL");
});

// ─── 11. auditEnv ─────────────────────────────────────────────────────
console.log("\n11. auditEnv:");
{
  const audit = auditEnv();
  assert(audit.length > 5, `tem entries (${audit.length})`);
  const dbUrl = audit.find((e) => e.name === "DATABASE_URL");
  assert(dbUrl !== undefined, "DATABASE_URL no catálogo");
  assert(dbUrl?.level === "required", "DATABASE_URL é required");
  assert(dbUrl?.scopes.includes("web") ?? false, "DATABASE_URL inclui scope web");
}

// ─── Sumário ──────────────────────────────────────────────────────────
console.log("\n" + "─".repeat(78));
if (errors.length === 0) {
  console.log(`✅ env: todos os testes passaram`);
  process.exit(0);
} else {
  console.error(`❌ env: ${errors.length} testes falharam`);
  for (const e of errors) console.error(`  · ${e}`);
  process.exit(1);
}
