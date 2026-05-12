/**
 * scripts/tests/test-db-providers.ts
 *
 * Testes puros para `lib/db-providers/*`. Sem rede, sem BD. Cobre:
 *
 *  · ManualUrlProvider.parse — URL válidas, inválidas, parciais,
 *    encoding de password com chars especiais, preservação de query
 *    string (sslmode etc.)
 *  · selectProvider — flags exclusivas, faltas, ambos, env requirements
 *    do modo --create-db
 *  · ProviderSelectionError tipado
 *
 * Não testa createDatabase real porque requer infra (cobertura
 * E2E manual via provision-tenant.ts).
 *
 * Correr:
 *   npx tsx scripts/tests/test-db-providers.ts
 */

import "dotenv/config";
import {
  ManualUrlProvider,
  LocalPostgresProvider,
  NeonProvider,
  selectProvider,
  ProviderSelectionError,
} from "../../lib/db-providers";

const errors: string[] = [];

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    errors.push(msg);
    console.error(`  ✗ ${msg}`);
  } else {
    console.log(`  ✓ ${msg}`);
  }
}

function assertThrows(fn: () => unknown, expectedMsgFragment: string, label: string): void {
  try {
    fn();
    errors.push(`${label} — esperava throw com "${expectedMsgFragment}", não atirou`);
    console.error(`  ✗ ${label} — não atirou`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes(expectedMsgFragment)) {
      console.log(`  ✓ ${label}`);
    } else {
      errors.push(`${label} — mensagem: "${msg}" não contém "${expectedMsgFragment}"`);
      console.error(`  ✗ ${label} — mensagem inesperada: ${msg}`);
    }
  }
}

// ─── Snapshot de env para restore ─────────────────────────────────────
const ENV_KEYS = [
  "POSTGRES_ADMIN_URL",
  "TENANT_DB_HOST",
  "TENANT_DB_PORT",
  "NEON_API_KEY",
  "NEON_PROJECT_ID",
  "NEON_DEFAULT_REGION",
  "NEON_API_BASE_URL",
] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

function clearProviderEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

function restoreEnv(): void {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
}

// ─── ManualUrlProvider.parse ─────────────────────────────────────────
console.log("\n▶ ManualUrlProvider.parse");

{
  const t = ManualUrlProvider.parse("postgresql://u:p@host:5432/db");
  assert(t.host === "host", "host extraído");
  assert(t.port === 5432, "port extraído");
  assert(t.dbName === "db", "dbName extraído");
  assert(t.dbUser === "u", "user extraído");
  assert(t.dbPassword === "p", "password extraída");
  assert(t.connectionUrl === "postgresql://u:p@host:5432/db", "connectionUrl verbatim");
}

{
  const t = ManualUrlProvider.parse("postgres://u:p@host/db"); // postgres://, no port
  assert(t.host === "host" && t.port === 5432, "default port 5432 + protocol postgres://");
}

{
  // Neon-style URL com query params preservados
  const raw =
    "postgresql://u:p@ep-foo.eu-west-2.aws.neon.tech/spharmmt_t_demo?sslmode=require&channel_binding=require";
  const t = ManualUrlProvider.parse(raw);
  assert(
    t.connectionUrl === raw,
    "URL verbatim preservada (sslmode + channel_binding sobrevivem)"
  );
  assert(t.host === "ep-foo.eu-west-2.aws.neon.tech", "host Neon");
  assert(t.dbName === "spharmmt_t_demo", "dbName Neon");
}

{
  // Password com chars especiais URL-encoded
  // pw real = "p@ss/wd:x"
  const enc = encodeURIComponent("p@ss/wd:x"); // => p%40ss%2Fwd%3Ax
  const t = ManualUrlProvider.parse(`postgresql://u:${enc}@host/db`);
  assert(t.dbPassword === "p@ss/wd:x", "password URL-decoded correctamente");
}

assertThrows(
  () => ManualUrlProvider.parse("not-a-url"),
  "URL inválida",
  "URL totalmente inválida atira"
);

assertThrows(
  () => ManualUrlProvider.parse("mysql://u:p@host/db"),
  "protocolo",
  "Protocolo errado atira"
);

assertThrows(
  () => ManualUrlProvider.parse("postgresql://u@host/db"),
  "password",
  "URL sem password atira a listar password em falta"
);

assertThrows(
  () => ManualUrlProvider.parse("postgresql://u:p@/db"),
  "host",
  "URL sem host atira a listar host em falta"
);

assertThrows(
  () => ManualUrlProvider.parse("postgresql://u:p@host/"),
  "dbname",
  "URL sem dbname atira a listar dbname em falta"
);

// ─── ManualUrlProvider — name + destroyDatabase no-op ─────────────────
{
  const p = new ManualUrlProvider("postgresql://u:p@host/db");
  assert(p.name === "manual", "name='manual'");
  // destroyDatabase é no-op — não deve atirar nem fazer side-effects
  p.destroyDatabase({ dbName: "x", dbUser: "y" }).then(
    () => assert(true, "ManualUrlProvider.destroyDatabase no-op resolve"),
    (e) =>
      assert(
        false,
        `ManualUrlProvider.destroyDatabase atirou inesperadamente: ${e?.message ?? e}`
      )
  );
}

// ─── LocalPostgresProvider — só construtor (não conecta sem env) ──────
console.log("\n▶ LocalPostgresProvider");
{
  const p = new LocalPostgresProvider("postgres://admin:pw@local/postgres", "local", 5432);
  assert(p.name === "local-postgres", "name='local-postgres'");
}

// ─── selectProvider — flags + envs ────────────────────────────────────
console.log("\n▶ selectProvider");

clearProviderEnv();

// 1. databaseUrl → manual
{
  const p = selectProvider({ databaseUrl: "postgresql://u:p@h/d" });
  assert(p.name === "manual", "databaseUrl → ManualUrlProvider");
}

// 2. ambos → erro
assertThrows(
  () => selectProvider({ databaseUrl: "postgresql://u:p@h/d", createDb: true }),
  "mutuamente exclusiv",
  "databaseUrl + createDb → erro mutuamente exclusiv*"
);

// 3. nenhum → erro accionável
assertThrows(
  () => selectProvider({}),
  "Sem provider seleccionado",
  "Sem flag → erro accionável"
);

// 4. --create-db sem envs → erro a listar env obrigatória
clearProviderEnv();
assertThrows(
  () => selectProvider({ createDb: true }),
  "POSTGRES_ADMIN_URL",
  "--create-db sem POSTGRES_ADMIN_URL → erro accionável"
);

// 5. --create-db com POSTGRES_ADMIN_URL mas sem TENANT_DB_HOST → erro
clearProviderEnv();
process.env.POSTGRES_ADMIN_URL = "postgres://admin:pw@local/postgres";
assertThrows(
  () => selectProvider({ createDb: true }),
  "TENANT_DB_HOST",
  "--create-db sem TENANT_DB_HOST → erro accionável"
);

// 6. --create-db com tudo → LocalPostgresProvider
clearProviderEnv();
process.env.POSTGRES_ADMIN_URL = "postgres://admin:pw@local/postgres";
process.env.TENANT_DB_HOST = "local";
{
  const p = selectProvider({ createDb: true });
  assert(p.name === "local-postgres", "--create-db + envs → LocalPostgresProvider");
}

// 7. databaseUrl tem trim — string só com whitespace é tratada como ausente
clearProviderEnv();
assertThrows(
  () => selectProvider({ databaseUrl: "   " }),
  "Sem provider seleccionado",
  "databaseUrl em branco é ignorada (cai em 'sem provider')"
);

// 8. ProviderSelectionError tipado
clearProviderEnv();
try {
  selectProvider({});
  errors.push("ProviderSelectionError não atirou");
} catch (err) {
  assert(err instanceof ProviderSelectionError, "selectProvider atira ProviderSelectionError tipado");
}

// 9. --provider neon sem envs → erro accionável
clearProviderEnv();
assertThrows(
  () => selectProvider({ provider: "neon" }),
  "NEON_API_KEY",
  "--provider=neon sem NEON_API_KEY → erro accionável"
);

// 10. --provider neon com NEON_API_KEY mas sem NEON_PROJECT_ID
clearProviderEnv();
process.env.NEON_API_KEY = "napi_fake";
assertThrows(
  () => selectProvider({ provider: "neon" }),
  "NEON_PROJECT_ID",
  "--provider=neon sem NEON_PROJECT_ID → erro accionável"
);

// 11. --provider neon com tudo → NeonProvider
clearProviderEnv();
process.env.NEON_API_KEY = "napi_fake";
process.env.NEON_PROJECT_ID = "proj-123";
{
  const p = selectProvider({ provider: "neon" });
  assert(p.name === "neon", "--provider=neon + envs → NeonProvider");
}

// 12. Auto-detect Neon a partir de env (sem flags)
clearProviderEnv();
process.env.NEON_API_KEY = "napi_fake";
process.env.NEON_PROJECT_ID = "proj-123";
{
  const p = selectProvider({});
  assert(p.name === "neon", "Auto-detect Neon (NEON_API_KEY+NEON_PROJECT_ID definidos)");
}

// 13. Auto-detect local a partir de env (sem flags, sem Neon)
clearProviderEnv();
process.env.POSTGRES_ADMIN_URL = "postgres://admin:pw@local/postgres";
process.env.TENANT_DB_HOST = "local";
{
  const p = selectProvider({});
  assert(p.name === "local-postgres", "Auto-detect local (POSTGRES_ADMIN_URL + TENANT_DB_HOST sem Neon)");
}

// 14. Auto-detect Neon ganha sobre local quando ambos definidos
clearProviderEnv();
process.env.NEON_API_KEY = "napi_fake";
process.env.NEON_PROJECT_ID = "proj-123";
process.env.POSTGRES_ADMIN_URL = "postgres://admin:pw@local/postgres";
process.env.TENANT_DB_HOST = "local";
{
  const p = selectProvider({});
  assert(p.name === "neon", "Auto-detect prefere Neon sobre local quando ambos disponíveis");
}

// 15. --provider=manual sem --database-url → erro
clearProviderEnv();
assertThrows(
  () => selectProvider({ provider: "manual" }),
  "--database-url",
  "--provider=manual sem --database-url → erro accionável"
);

// 16. Flags em conflito (--provider + outra flag de modo diferente)
clearProviderEnv();
assertThrows(
  () => selectProvider({ provider: "manual", createDb: true }),
  "Múltiplas",
  "--provider=manual + --create-db (modos diferentes) → erro de conflito"
);

// 17. NeonProvider construtor recusa apiKey vazia
assertThrows(
  () => new NeonProvider({ apiKey: "", projectId: "x" }),
  "apiKey obrigatória",
  "NeonProvider sem apiKey → erro de constructor"
);

// 18. NeonProvider construtor recusa projectId vazio
assertThrows(
  () => new NeonProvider({ apiKey: "k", projectId: "" }),
  "projectId obrigatório",
  "NeonProvider sem projectId → erro de constructor"
);

restoreEnv();

// ─── Resumo ───────────────────────────────────────────────────────────
console.log("");
if (errors.length === 0) {
  console.log("✓ Todos os asserts passaram.");
  process.exit(0);
} else {
  console.error(`✗ ${errors.length} falha(s):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
