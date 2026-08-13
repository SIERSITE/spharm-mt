/**
 * agent/src/politica-gates.test.ts
 *
 * A política de gates (UNKNOWN / órfãos) e o registo final da corrida.
 *
 * ── O que aconteceu na Silveirense ────────────────────────────────
 *
 * O full-sync foi corrido explicitamente com `allow-unknowns=sim` e
 * `allow-orphans=sim`, e passou. Na primeira corrida diária, os MESMOS
 * dados abortaram Agosto:
 *
 *     409 unknowns_present — 12 linhas com tipoDocumentoClass='UNKNOWN'
 *
 * A causa não é o gate: é o gate ser configurado em dois sítios
 * diferentes. O onboarding recebia a decisão por flag de linha de
 * comandos; o diário não recebia nada e usava o default. Uma farmácia
 * não pode ser aceite no onboarding e recusada no dia seguinte pelos
 * mesmos dados.
 *
 * A política passa a ser UMA e a viver na farmácia
 * (`agent.config.json` → `options.allowUnknowns` / `allowOrphans`), não
 * na memória de quem correu o comando.
 *
 * Uso: npx tsx agent/src/politica-gates.test.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";

let pass = 0;
let fail = 0;
const eq = (label: string, obtido: unknown, esperado: unknown) => {
  if (obtido === esperado) {
    pass++;
    console.log(`  [OK]    ${label}`);
  } else {
    fail++;
    console.log(`  [FALHA] ${label}: obtido "${String(obtido)}", esperado "${String(esperado)}"`);
  }
};
const ok = (label: string, cond: boolean) => eq(label, cond, true);

const raiz = path.join(import.meta.dirname, "..", "..");
const ler = (p: string) => readFileSync(path.join(raiz, p), "utf8");

const daily = ler("agent/src/commands/daily-pipeline.ts");
const config = ler("agent/src/config.ts");
const vendamensal = ler("lib/aggregate/vendamensal.ts");

// ── 1. A política é única e persistente ───────────────────────────

console.log("=== a política vive na farmácia, não no comando ===");
ok("config declara allowUnknowns", /allowUnknowns\?: boolean/.test(config));
ok("config declara allowOrphans", /allowOrphans\?: boolean/.test(config));
ok("lê-se de options.allowUnknowns", /set\("SPHARMMT_ALLOW_UNKNOWNS", options\.allowUnknowns\)/.test(config));
ok("lê-se de options.allowOrphans", /set\("SPHARMMT_ALLOW_ORPHANS", options\.allowOrphans\)/.test(config));
// Default restritivo: o gate existe para forçar caracterização, e só
// sai do caminho quando alguém o escreve no ficheiro da farmácia.
ok(
  "default é false (só 'true' liga)",
  /optionalEnv\("SPHARMMT_ALLOW_UNKNOWNS"\) === "true"/.test(config),
);

console.log("");
console.log("=== o diário usa a MESMA política ===");
const chamadaMes = daily.slice(
  daily.indexOf("client.pipelineAggregateMonth"),
  daily.indexOf("client.pipelineAggregateMonth") + 400,
);
ok("passa allowUnknowns", /allowUnknowns:\s*cfg\.allowUnknowns === true/.test(chamadaMes));
ok("passa allowOrphans", /allowOrphans:\s*cfg\.allowOrphans === true/.test(chamadaMes));
// O defeito exacto: antes não passava nada e o servidor usava o default.
ok(
  "já não chama com apenas { month, write }",
  !/pipelineAggregateMonth\(\s*\{\s*month,\s*write:\s*true\s*\}/.test(daily),
);

// ── 2. UNKNOWN não é mascarado ────────────────────────────────────

console.log("");
console.log("=== UNKNOWN não é mascarado automaticamente ===");
// O gate continua a existir e a abortar. O que muda é de onde vem a
// decisão de o dispensar — nunca é implícita.
ok("o gate mantém-se", /preflight\.unknowns > 0 && !allowUnknowns/.test(vendamensal));
ok("continua a atirar AggregateAbortError", /throw new AggregateAbortError\(\s*"unknowns_present"/.test(vendamensal));
// E as linhas UNKNOWN nunca entram na soma, com ou sem bypass — o que
// significa que dispensar o gate não altera números, só decide se o mês
// avança.
ok(
  "UNKNOWN nunca entra na agregação",
  /WHERE "tipoDocumentoClass" IN \('VENDA', 'DEVOLUCAO_ANULACAO'\)/.test(vendamensal),
);

console.log("");
console.log("=== a origem do UNKNOWN é identificável ===");
// Sem isto, "12 linhas UNKNOWN" é um número sem acção associada. Uma
// linha fica UNKNOWN quando o seu tipoDocumento não está em
// TipoDocumentoClassificacao; a lista diz exactamente o que classificar.
ok("o preflight expõe os TipoDoc", /unknownTipoDocs: Array<\{ externalTipoDocumentoId/.test(vendamensal));
ok("agrupados por tipoDocumento", /by: \["tipoDocumento"\],\s*\n\s*where: \{ \.\.\.where, tipoDocumentoClass: "UNKNOWN" \}/.test(vendamensal));
ok("a mensagem de abort diz quais", /Por classificar: \$\{quais/.test(vendamensal));
ok("e diz o que fazer", /Classifica em TipoDocumentoClassificacao e re-agrega/.test(vendamensal));
ok("os detalhes vão no erro", /\{ unknowns: preflight\.unknowns, unknownTipoDocs: preflight\.unknownTipoDocs \}/.test(vendamensal));

// ── 3. Registo final ──────────────────────────────────────────────

console.log("");
console.log("=== o registo final da corrida ===");
// A route existe e é a certa. O 404 vinha do proxy, não de código
// obsoleto nem de caminho errado.
const rota = ler("app/api/admin/pipeline/record/route.ts");
ok("a route existe", rota.length > 0);
ok("é um POST", /export const POST/.test(rota));
ok("autentica com a ingest key do agent", /withIntegrationAuth/.test(rota));
ok("o agent chama o mesmo caminho", /"\/api\/admin\/pipeline\/record"/.test(ler("agent/src/http-client.ts")));

// A allowlist do proxy — a correcção verdadeira.
for (const conf of ["deploy/docker/proxy/spharmmt-tls.conf", "deploy/docker/proxy/spharmmt.conf"]) {
  const c = ler(conf);
  ok(
    `${path.basename(conf)}: record está na allowlist`,
    c.includes("location = /api/admin/pipeline/record {"),
  );
  // O `set` é o que entrega o X-Tenant-Slug. Sem ele passa o 404 mas
  // apanha 401 missing_credentials — metade da credencial.
  const bloco = c.slice(c.indexOf("location = /api/admin/pipeline/record {"));
  ok(
    `${path.basename(conf)}: repõe o slug`,
    /set \$spharmmt_tenant_slug \$http_x_tenant_slug;/.test(bloco.slice(0, 200)),
  );
}

// A falha do registo não pode continuar invisível quando é ela que
// sustenta o catch-up.
ok(
  "a falha do registo é reportada",
  /Falha a registar PipelineRun no SaaS/.test(daily),
);

// ── 4. Catch-up desligado até o PipelineRun ser fiável ────────────

console.log("");
console.log("=== catch-up não corre sem se pedir ===");
ok("existe a flag --catch-up", /"catch-up": \{ type: "boolean" \}/.test(daily));
ok("sem a flag corre só ontem", /if \(!args\.catchUp\) \{/.test(daily));
ok("e diz que está desligado", /Catch-up desligado \(usa --catch-up\)/.test(daily));

// ── 5. Fornecedores antes das compras ─────────────────────────────

console.log("");
console.log("=== fornecedores antes das compras ===");
const lista = daily.slice(
  daily.indexOf("PIPELINES_DIARIOS_EXTRA = ["),
  daily.indexOf("] as const;", daily.indexOf("PIPELINES_DIARIOS_EXTRA = [")),
);
ok("fornecedores está na lista", /fornecedores-upload/.test(lista));
ok(
  "antes das compras",
  lista.indexOf("fornecedores-upload") < lista.indexOf("compras-upload"),
);
ok(
  "sem janela temporal",
  /\{ cmd: "fornecedores-upload", label: "fornecedores", janela: false \}/.test(lista),
);

console.log("");
console.log(`${pass} ok, ${fail} falhas`);
process.exit(fail === 0 ? 0 : 1);
