/**
 * scripts/tests/test-server-actions-origins.ts
 *
 * A lista de origens autorizadas a invocar Server Actions é a excepção
 * explícita à protecção que o Next tem contra CSRF nessas invocações.
 * Uma entrada a mais abre um buraco; uma a menos deixa o login a
 * responder "Invalid Server Actions request".
 *
 * Estes casos fixam as duas fronteiras.
 *
 *   npm run test:server-actions-origins
 *
 * Saída: 0 todos os casos passaram · 1 pelo menos um falhou
 */

import {
  resolveAllowedOrigins,
  normalizeOrigin,
  isGlobalWildcard,
  hostFromPublicAppUrl,
  ServerActionsOriginsError,
} from "@/lib/server-actions-origins";

let pass = 0;
let fail = 0;

function ok(desc: string): void {
  console.log(`  ✓ ${desc}`);
  pass += 1;
}
function bad(desc: string, detail?: string): void {
  console.log(`  ✗ ${desc}${detail ? ` — ${detail}` : ""}`);
  fail += 1;
}
function eq(desc: string, expected: unknown, actual: unknown): void {
  const e = JSON.stringify(expected);
  const a = JSON.stringify(actual);
  if (e === a) ok(`${desc} → ${a}`);
  else bad(desc, `esperado ${e}, obtido ${a}`);
}
function throws(desc: string, fn: () => unknown): void {
  try {
    fn();
    bad(desc, "não atirou");
  } catch (err) {
    if (err instanceof ServerActionsOriginsError) ok(desc);
    else bad(desc, `atirou ${err instanceof Error ? err.name : typeof err}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════
console.log("\n=== Teste: origens das Server Actions ===");

console.log("\n1. A VPS actual");
const vps = resolveAllowedOrigins({
  raw: "127.0.0.1:8080,164.132.85.211",
  isProduction: true,
});
eq("lista da VPS", ["127.0.0.1:8080", "164.132.85.211"], vps);
if (vps.includes("127.0.0.1:8080")) ok("túnel SSH (127.0.0.1:8080) aceite");
else bad("túnel SSH não está na lista");
if (vps.includes("164.132.85.211")) ok("IP público aceite");
else bad("IP público não está na lista");
if (!vps.includes("exemplo-nao-listado.pt")) ok("origem não listada fica de fora");
else bad("origem não listada apareceu");

console.log("\n2. Nenhum curinga global");
throws("'*' é recusado", () => resolveAllowedOrigins({ raw: "*", isProduction: true }));
throws("'*' no meio da lista é recusado", () =>
  resolveAllowedOrigins({ raw: "app.exemplo.pt,*", isProduction: true }),
);
throws("'**' é recusado", () => resolveAllowedOrigins({ raw: "**", isProduction: true }));
throws("'*:*' é recusado", () => resolveAllowedOrigins({ raw: "*:*", isProduction: true }));
for (const w of ["*", "**", "*.*", "*:*"]) {
  if (isGlobalWildcard(w)) ok(`isGlobalWildcard("${w}")`);
  else bad(`isGlobalWildcard("${w}") devia ser verdadeiro`);
}
// Um curinga de SUBDOMÍNIO é legítimo e suportado pelo Next.
if (!isGlobalWildcard("*.app.spharm.pt")) ok("*.app.spharm.pt NÃO é curinga global");
else bad("*.app.spharm.pt foi tratado como curinga global");
eq(
  "curinga de subdomínio é preservado",
  ["*.app.spharm.pt", "app.spharm.pt"],
  resolveAllowedOrigins({ raw: "app.spharm.pt,*.app.spharm.pt", isProduction: true }),
);

console.log("\n3. Origem vazia nunca é curinga");
eq(
  "entradas vazias são descartadas",
  ["app.spharm.pt"],
  resolveAllowedOrigins({ raw: " , ,app.spharm.pt, ,", isProduction: true }),
);
throws("lista só com vazios, sem PUBLIC_APP_URL, falha em produção", () =>
  resolveAllowedOrigins({ raw: " , , ", isProduction: true }),
);
eq(
  "lista só com vazios cai no host de PUBLIC_APP_URL",
  ["app.spharm.pt"],
  resolveAllowedOrigins({ raw: "  ", publicAppUrl: "https://app.spharm.pt", isProduction: true }),
);

console.log("\n4. Normalização");
eq("protocolo removido", "app.spharm.pt", normalizeOrigin("https://app.spharm.pt"));
eq("barra final removida", "app.spharm.pt", normalizeOrigin("https://app.spharm.pt/"));
eq("caminho removido", "app.spharm.pt", normalizeOrigin("https://app.spharm.pt/login"));
eq("minúsculas", "app.spharm.pt", normalizeOrigin("  HTTPS://App.SPharm.PT  "));
eq("porto preservado", "127.0.0.1:8080", normalizeOrigin("http://127.0.0.1:8080"));
eq("credenciais embutidas recusadas", null, normalizeOrigin("https://u:p@app.spharm.pt"));
eq("vazio", null, normalizeOrigin("   "));
eq(
  "lista mista normalizada e sem duplicados",
  ["127.0.0.1:8080", "app.spharm.pt"],
  resolveAllowedOrigins({
    raw: "https://App.SPharm.PT/, app.spharm.pt , http://127.0.0.1:8080",
    isProduction: true,
  }),
);

console.log("\n5. Defaults");
eq(
  "sem variável, usa o host de PUBLIC_APP_URL",
  ["203.0.113.10"],
  resolveAllowedOrigins({ raw: undefined, publicAppUrl: "http://203.0.113.10", isProduction: true }),
);
eq(
  "porto de PUBLIC_APP_URL preservado",
  ["203.0.113.10:8080"],
  resolveAllowedOrigins({ raw: null, publicAppUrl: "http://203.0.113.10:8080", isProduction: true }),
);
throws("produção sem nada: FALHA o build", () =>
  resolveAllowedOrigins({ raw: undefined, publicAppUrl: undefined, isProduction: true }),
);
eq(
  "fora de produção, lista vazia é aceitável",
  [],
  resolveAllowedOrigins({ raw: undefined, publicAppUrl: undefined, isProduction: false }),
);
eq("host de URL sem protocolo", "app.spharm.pt", hostFromPublicAppUrl("app.spharm.pt"));
eq("URL ilegível", null, hostFromPublicAppUrl("::::"));
eq("URL vazio", null, hostFromPublicAppUrl(""));

console.log("\n6. A variável ganha ao PUBLIC_APP_URL");
eq(
  "PUBLIC_APP_URL não é acrescentado quando há lista explícita",
  ["127.0.0.1:8080"],
  resolveAllowedOrigins({
    raw: "127.0.0.1:8080",
    publicAppUrl: "https://outro.dominio.pt",
    isProduction: true,
  }),
);

console.log("\n════════════════════════════════════════════");
console.log(` ${pass} ok · ${fail} falhas`);
console.log("════════════════════════════════════════════");
process.exit(fail === 0 ? 0 : 1);
