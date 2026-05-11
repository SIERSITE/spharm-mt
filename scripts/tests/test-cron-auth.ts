/**
 * scripts/tests/test-cron-auth.ts
 *
 * Testes puros para `lib/jobs/cron-auth`. Cobre:
 *   1. `verifyCronSecret` — função pura sobre dois strings (expected/received).
 *   2. `extractCronCredential` — parsing do `Authorization: Bearer <x>`
 *      e fallback para `?secret=<x>` query.
 *   3. `authorizeCronRequest` — integração via Request + env.
 *
 * Sem rede, sem BD.
 *
 * Correr:
 *   npx tsx scripts/tests/test-cron-auth.ts
 */

import {
  verifyCronSecret,
  extractCronCredential,
  authorizeCronRequest,
} from "../../lib/jobs/cron-auth";

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

// ─── 1. verifyCronSecret — matching ────────────────────────────────────────
console.log("\n1. verifyCronSecret — match correcto:");
{
  const r = verifyCronSecret("topsecret123", "topsecret123");
  eq(r.ok, true, "ok=true quando expected === received");
}

console.log("\n2. verifyCronSecret — mismatch:");
{
  const r = verifyCronSecret("topsecret123", "wrongguess123");
  eq(r.ok, false, "ok=false quando mismatch");
  assert(r.ok === false && r.reason === "invalid_credential", "reason=invalid_credential");
}

console.log("\n3. verifyCronSecret — comprimento diferente:");
{
  const r = verifyCronSecret("topsecret123", "short");
  eq(r.ok, false, "ok=false quando comprimentos diferem");
  assert(r.ok === false && r.reason === "invalid_credential", "reason=invalid_credential");
}

console.log("\n4. verifyCronSecret — expected vazio (env não configurado):");
{
  eq(verifyCronSecret(null, "any").ok, false, "null expected → recusa");
  eq(verifyCronSecret("", "any").ok, false, "string vazia expected → recusa");
  const r = verifyCronSecret(null, "any");
  assert(r.ok === false && r.reason === "missing_env", "reason=missing_env");
}

console.log("\n5. verifyCronSecret — received vazio:");
{
  const r1 = verifyCronSecret("topsecret", null);
  assert(r1.ok === false && r1.reason === "missing_credential", "null received → missing_credential");
  const r2 = verifyCronSecret("topsecret", "");
  assert(r2.ok === false && r2.reason === "missing_credential", "string vazia received → missing_credential");
}

console.log("\n6. verifyCronSecret — não revela info do expected via short-circuit:");
{
  // Mesmo quando o comprimento é diferente, devolvemos "invalid_credential"
  // (não "wrong_length"). Isto faz com que o cliente não consiga inferir
  // se está perto do tamanho certo.
  const r = verifyCronSecret("longexpectedsecret", "x");
  assert(r.ok === false && r.reason === "invalid_credential", "comprimento incorrecto também devolve invalid_credential");
}

// ─── 7. extractCronCredential — Authorization header ───────────────────────
console.log("\n7. extractCronCredential — Bearer header:");
{
  const req = new Request("http://x.test/api/jobs/refresh-ipf", {
    headers: { authorization: "Bearer abc123" },
  });
  eq(extractCronCredential(req), "abc123", "extrai abc123 do Bearer");
}

console.log("\n8. extractCronCredential — case-insensitive scheme:");
{
  const req = new Request("http://x.test/api/jobs/refresh-ipf", {
    headers: { authorization: "bearer  abc123  " },
  });
  eq(extractCronCredential(req), "abc123", "scheme case-insensitive + trim");
}

console.log("\n9. extractCronCredential — query secret fallback:");
{
  const req = new Request("http://x.test/api/jobs/refresh-ipf?secret=qfromquery");
  eq(extractCronCredential(req), "qfromquery", "extrai do ?secret=");
}

console.log("\n10. extractCronCredential — header tem prioridade sobre query:");
{
  const req = new Request("http://x.test/api/jobs/refresh-ipf?secret=qval", {
    headers: { authorization: "Bearer hval" },
  });
  eq(extractCronCredential(req), "hval", "header preferido sobre query");
}

console.log("\n11. extractCronCredential — sem nenhum dos canais:");
{
  const req = new Request("http://x.test/api/jobs/refresh-ipf");
  eq(extractCronCredential(req), null, "null quando ausente");
}

console.log("\n12. extractCronCredential — Authorization sem Bearer scheme:");
{
  const req = new Request("http://x.test/api/jobs/refresh-ipf", {
    headers: { authorization: "Basic somebase64" },
  });
  eq(extractCronCredential(req), null, "Basic scheme ignorado → null");
}

// ─── 13. authorizeCronRequest — integração com env ─────────────────────────
console.log("\n13. authorizeCronRequest — env não configurado:");
{
  const prev = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  const req = new Request("http://x.test/api/jobs/refresh-ipf", {
    headers: { authorization: "Bearer anything" },
  });
  const r = authorizeCronRequest(req);
  assert(r.ok === false && r.reason === "missing_env", "recusa quando CRON_SECRET ausente");
  if (prev !== undefined) process.env.CRON_SECRET = prev;
}

console.log("\n14. authorizeCronRequest — header válido:");
{
  const prev = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "good-secret-32-chars-or-longer-x";
  const req = new Request("http://x.test/api/jobs/refresh-ipf", {
    headers: { authorization: "Bearer good-secret-32-chars-or-longer-x" },
  });
  eq(authorizeCronRequest(req).ok, true, "ok=true quando header bate com env");
  if (prev !== undefined) process.env.CRON_SECRET = prev;
  else delete process.env.CRON_SECRET;
}

console.log("\n15. authorizeCronRequest — query válida:");
{
  const prev = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "good-secret-32-chars-or-longer-x";
  const req = new Request("http://x.test/api/jobs/refresh-ipf?secret=good-secret-32-chars-or-longer-x");
  eq(authorizeCronRequest(req).ok, true, "ok=true quando ?secret= bate com env");
  if (prev !== undefined) process.env.CRON_SECRET = prev;
  else delete process.env.CRON_SECRET;
}

console.log("\n16. authorizeCronRequest — header inválido:");
{
  const prev = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "good-secret-32-chars-or-longer-x";
  const req = new Request("http://x.test/api/jobs/refresh-ipf", {
    headers: { authorization: "Bearer wrong-but-same-length---------x" },
  });
  const r = authorizeCronRequest(req);
  assert(r.ok === false && r.reason === "invalid_credential", "recusa header inválido");
  if (prev !== undefined) process.env.CRON_SECRET = prev;
  else delete process.env.CRON_SECRET;
}

// ─── Sumário ─────────────────────────────────────────────────────────────
console.log("\n" + "─".repeat(78));
if (errors.length === 0) {
  console.log(`✅ cron-auth: todos os testes passaram`);
  process.exit(0);
} else {
  console.error(`❌ cron-auth: ${errors.length} testes falharam`);
  for (const e of errors) console.error(`  · ${e}`);
  process.exit(1);
}
