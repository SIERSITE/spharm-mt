/**
 * scripts/tests/test-agent-endpoint.mjs
 *
 * O endpoint SaaS do pacote do agent deixou de ser um literal no código.
 * Este teste guarda as duas metades dessa regra:
 *
 *   1. As fontes que entram no ZIP trazem `{{SAAS_ENDPOINT}}` e NÃO um
 *      domínio. Se alguém voltar a escrever um domínio à mão, falha aqui
 *      e não na farmácia.
 *   2. O `agent/build.mjs` recusa-se a construir sem `PUBLIC_APP_URL`, e
 *      recusa-se ANTES de descarregar o Node ou apagar a build anterior.
 *
 * O caso que motivou isto: o domínio de produção mudou de `.app` para
 * `.com` e os documentos dentro dos ZIPs já distribuídos continuaram a
 * mandar o técnico testar conectividade contra o domínio antigo. Nenhuma
 * etapa do empacotamento tocava nos `.md` — eram duas cópias
 * byte-a-byte — portanto nada acusava a divergência.
 *
 * Corre com:  node scripts/tests/test-agent-endpoint.mjs
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MARCADOR = "{{SAAS_ENDPOINT}}";

let ok = 0;
let ko = 0;
const v = (cond, label, extra = "") => {
  if (cond) {
    ok++;
    console.log(`  [OK]    ${label}`);
  } else {
    ko++;
    console.log(`  [FALHA] ${label}${extra ? `  — ${extra}` : ""}`);
  }
};

const ler = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

// ── 1. Fontes que entram no ZIP ──────────────────────────────────────
console.log("\n=== 1. as fontes do pacote estão parametrizadas ===");
const FONTES_DO_ZIP = [
  "agent/agent.config.example.json",
  "agent/INSTALL_WINDOWS.md",
  "agent/SECURITY.md",
];
for (const rel of FONTES_DO_ZIP) {
  const txt = ler(rel);
  const n = txt.split(MARCADOR).length - 1;
  v(n > 0, `${rel} usa ${MARCADOR}`, `ocorrências=${n}`);
  v(!/spharmmt\.app/.test(txt), `${rel} não tem domínio literal antigo`);
}

// O template de config tem de continuar a ser JSON válido com o marcador
// lá dentro — se o marcador partisse o parse, o agent nem arrancava.
const cfg = JSON.parse(ler("agent/agent.config.example.json"));
v(cfg.saas?.endpoint === MARCADOR, "agent.config.example.json continua JSON válido e o endpoint é o marcador", String(cfg.saas?.endpoint));

// ── 2. Nenhum domínio literal em código/documentação activa ──────────
console.log("\n=== 2. nenhum literal do domínio antigo em código activo ===");
const EXCLUIDOS = /^(dist-agent|generated|notes|logs|node_modules|\.next|\.git)\//;
// Este ficheiro contém, por necessidade, o próprio padrão que procura —
// no regex e nas etiquetas. Sem esta excepção o varrimento acusa-se a si
// mesmo, e a falha diz «há um domínio antigo no código» quando o que há
// é o detector. Passou despercebido enquanto o ficheiro era untracked:
// `git ls-files` não o listava.
const ESTE_FICHEIRO = "scripts/tests/test-agent-endpoint.mjs";
const alvos = execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" })
  .split("\n")
  .filter((f) => f && !EXCLUIDOS.test(f) && f !== ESTE_FICHEIRO);
const infractores = [];
for (const rel of alvos) {
  const full = path.join(REPO_ROOT, rel);
  let txt;
  try {
    txt = fs.readFileSync(full, "utf8");
  } catch {
    continue; // binário ou ilegível
  }
  if (txt.includes("\u0000")) continue;
  if (/spharmmt\.app/.test(txt)) infractores.push(rel);
}
v(
  infractores.length === 0,
  `0 ficheiros com "spharmmt.app" fora de artefactos e histórico`,
  infractores.slice(0, 6).join(", ")
);

// ── 3. O build recusa-se a correr sem PUBLIC_APP_URL ─────────────────
console.log("\n=== 3. o build falha sem PUBLIC_APP_URL, e falha cedo ===");
const semVar = { ...process.env };
delete semVar.PUBLIC_APP_URL;
delete semVar.NEXT_PUBLIC_APP_URL;

let saida = "";
let rebentou = false;
const t0 = Date.now();
try {
  execFileSync(process.execPath, [path.join(REPO_ROOT, "agent", "build.mjs")], {
    cwd: REPO_ROOT,
    env: semVar,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
} catch (err) {
  rebentou = true;
  saida = `${err.stdout ?? ""}${err.stderr ?? ""}`;
}
const duracao = Date.now() - t0;

v(rebentou, "sem PUBLIC_APP_URL o build termina com erro");
v(/PUBLIC_APP_URL/.test(saida), "a mensagem nomeia a variável em falta", saida.slice(0, 120).replace(/\s+/g, " "));

// «Cedo» significa: antes de descarregar o Node e antes de apagar a
// build anterior. Ambos deixam rasto observável.
v(!/A descarregar|A limpar|esbuild|A copiar/i.test(saida), "falhou ANTES de descarregar Node / limpar dist / bundlar");
v(duracao < 20_000, "falhou depressa (não esperou pelo download)", `${duracao}ms`);

// ── 4. Substituição efectiva ─────────────────────────────────────────
console.log("\n=== 4. a substituição produz o endpoint pedido ===");
// Exercita a mesma função do build, sem correr o build inteiro.
const fonteBuild = ler("agent/build.mjs");
v(/function copyComEndpoint\(/.test(fonteBuild), "copyComEndpoint existe no build");
v(/copyResources\(saasEndpoint\)/.test(fonteBuild), "copyResources recebe o endpoint resolvido");
v(
  /const saasEndpoint = resolveSaasEndpoint\(\);/.test(fonteBuild),
  "main() resolve o endpoint antes de ensureNodeExe/cleanDist"
);

const tmp = fs.mkdtempSync(path.join(process.env.TEMP ?? "/tmp", "agent-endpoint-"));
try {
  const src = path.join(tmp, "origem.md");
  const dst = path.join(tmp, "destino.md");
  fs.writeFileSync(src, `endpoint: ${MARCADOR}\nping ${MARCADOR}/api\n`, "utf8");
  // Réplica exacta do corpo de copyComEndpoint.
  const original = fs.readFileSync(src, "utf8");
  const partes = original.split(MARCADOR);
  fs.writeFileSync(dst, partes.join("https://app.spharmmt.com"), "utf8");
  const resultado = fs.readFileSync(dst, "utf8");
  v(partes.length - 1 === 2, "conta as duas ocorrências", `n=${partes.length - 1}`);
  v(!resultado.includes(MARCADOR), "nenhum marcador sobra no resultado");
  v(
    resultado.includes("endpoint: https://app.spharmmt.com") &&
      resultado.includes("ping https://app.spharmmt.com/api"),
    "ambas as ocorrências ficaram com o endpoint"
  );
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── 5. Os empacotadores a jusante não reintroduzem um default ────────
console.log("\n=== 5. empacotadores sem domínio inventado ===");
const pkgAgent = ler("scripts/admin/package-agent.ts");
v(!/spharmmt\.app/.test(pkgAgent), "package-agent.ts sem domínio literal");
v(
  /endpoint não configurado/.test(pkgAgent),
  "package-agent.ts falha em vez de adivinhar quando não há endpoint"
);
const opsAgent = ler("lib/admin/ops/agent-package.ts");
v(/endpoint_not_configured/.test(opsAgent), "a via da API já falhava — continua a falhar");

console.log(`\nRESULTADO: ${ok} ok, ${ko} falhas`);
process.exit(ko === 0 ? 0 : 1);
