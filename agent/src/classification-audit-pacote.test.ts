/**
 * agent/src/classification-audit-pacote.test.ts
 *
 * O PACOTE de diagnóstico `spharmmt-agent-classification-audit.zip`: constrói-se a sério (agent/build-audit-package.mjs →
 * pasta temporária), abre-se o ZIP e prova-se:
 *   · conteúdo EXATO = lista esperada; nenhum agent.config.json, log, run, lock, output, token, .env;
 *   · MANIFEST: commit completo (= HEAD), data UTC, sha256 de cada ficheiro (batem com os extraídos), diagnostico=true,
 *     instalavel=false, base rev98 — e NUNCA rev99; o bundle define AGENT_REV = "98";
 *   · o bundle só tem os módulos da lista fechada (sem http-client, lock-pipeline, pipelines) e a árvore suja é RECUSADA;
 *   · o node.exe do ZIP (SHA-256 oficial) executa `classification-audit --help` e RECUSA sem agent.config.json com
 *     mensagem clara, sem criar ficheiros; comandos de produção não existem no bundle;
 *   · o `agent:package` normal continua a ser a rev98 (build.mjs só ganhou o guarda de import + exports).
 *
 * Uso: npx tsx agent/src/classification-audit-pacote.test.ts      (Windows: usa PowerShell e o node.exe do pacote)
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let pass = 0;
let fail = 0;
const check = (c: boolean, l: string, d?: string) => {
  if (c) { pass++; console.log(`  [OK]    ${l}`); }
  else { fail++; console.log(`  [FALHA] ${l}${d ? `\n            ${d}` : ""}`); }
};

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(AQUI, "..", "..");
// build-audit-package.mjs é JavaScript (sem declarações de tipos): importado dinamicamente.
type Construtor = {
  AGENT_REV_BASE: string; BASE_COMMIT: string; FICHEIROS_ESPERADOS: string[]; MODULOS_PERMITIDOS: string[]; NODE_SHA256: string; ZIP_NOME: string;
  verificarMetafile: (m: { inputs: Record<string, unknown> }, permitidos?: string[]) => string[];
};
const { AGENT_REV_BASE, BASE_COMMIT, FICHEIROS_ESPERADOS, MODULOS_PERMITIDOS, NODE_SHA256, ZIP_NOME, verificarMetafile } = (await import(
  pathToFileURL(path.join(REPO, "agent", "build-audit-package.mjs")).href
)) as Construtor;
const sha = (f: string) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const git = (a: string[]) => spawnSync("git", a, { cwd: REPO, encoding: "utf8" }).stdout.trim();
const ps = (cmd: string) => execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function construir(out: string, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [path.join(REPO, "agent", "build-audit-package.mjs")], {
    cwd: REPO,
    encoding: "utf8",
    env: { ...process.env, AUDIT_PACKAGE_OUT: out, ...env },
    timeout: 300_000,
  });
}

async function main() {
  if (process.platform !== "win32") {
    console.log("(só em Windows: PowerShell/node.exe) — ignorado");
    process.exit(0);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "audit-pkg-test-"));
  try {
    // ═══ 1. verificarMetafile (lista fechada) ═════════════════════════
    console.log("\n=== 1. O bundle só pode conter a lista fechada de módulos ===");
    const inputs = (extra: string[] = []) => ({ inputs: Object.fromEntries([...MODULOS_PERMITIDOS, ...extra, "node_modules/mssql/index.js"].map((f) => [f, {}])) });
    check(verificarMetafile(inputs()).length === MODULOS_PERMITIDOS.length, "lista fechada completa: aceite");
    for (const intruso of ["agent/src/http-client.ts", "agent/src/lock-pipeline.ts", "agent/src/commands/daily-pipeline.ts", "agent/src/guarda-escrita.ts", "agent/src/cli.ts"]) {
      let erro = "";
      try { verificarMetafile(inputs([intruso])); } catch (e) { erro = String(e); }
      check(erro.includes(intruso), `intruso recusado: ${intruso}`);
    }
    let falta = "";
    try { verificarMetafile({ inputs: { "agent/src/audit-cli.ts": {} } }); } catch (e) { falta = String(e); }
    check(falta.includes("não contém módulos esperados"), "módulo em falta também é recusado");
    check(MODULOS_PERMITIDOS.length === 10 && !MODULOS_PERMITIDOS.some((m) => /http|lock|pipeline|sync|upload|cli\.ts$/.test(m.replace("audit-cli", ""))), "a lista fechada não tem http, lock, pipeline, sync, upload");

    // ═══ 2. árvore suja é recusada ════════════════════════════════════
    console.log("\n=== 2. O build recusa árvore git suja ===");
    const sonda = path.join(REPO, "agent", ".sonda-arvore-suja.tmp");
    fs.writeFileSync(sonda, "x");
    try {
      const r = construir(path.join(tmp, "recusa"));
      check(r.status === 1 && /Árvore git com alterações por commitar/.test(r.stderr + r.stdout), "ficheiro novo não versionado → exit 1 com mensagem clara", (r.stderr + r.stdout).slice(0, 200));
      check(!fs.existsSync(path.join(tmp, "recusa", ZIP_NOME)), "nenhum ZIP é criado");
    } finally {
      fs.rmSync(sonda, { force: true });
    }

    // ═══ 3. build real ════════════════════════════════════════════════
    console.log("\n=== 3. Build real do pacote ===");
    const saida = path.join(tmp, "dist");
    const sujoAgora = git(["status", "--porcelain"]).length > 0;
    const r = construir(saida, { AUDIT_PACKAGE_ALLOW_DIRTY: "1", AUDIT_PACKAGE_VERSION: "diag-2026-10-29" });
    check(r.status === 0, "build termina com exit 0", (r.stderr + r.stdout).slice(-400));
    const zip = path.join(saida, ZIP_NOME);
    check(fs.existsSync(zip) && fs.existsSync(`${zip}.sha256`), "ZIP + .sha256 criados com o nome spharmmt-agent-classification-audit.zip");
    check(fs.readFileSync(`${zip}.sha256`, "utf8").startsWith(sha(zip)), "o .sha256 é o do ZIP");
    check(/node\.exe .* \(SHA-256 verificado\)|descarregado e verificado/.test(r.stdout), "node.exe obtido com SHA-256 verificado");

    const lista = ps(`Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead('${zip}'); $z.Entries | ForEach-Object { $_.FullName }; $z.Dispose()`)
      .split(/\r?\n/).map((s) => s.trim()).filter(Boolean).sort();
    check(JSON.stringify(lista) === JSON.stringify([...FICHEIROS_ESPERADOS].sort()), "conteúdo do ZIP = lista esperada, exata", lista.join(", "));
    check(lista.length === 7 && !lista.some((n) => n.includes("/") || n.includes("\\")), "7 ficheiros, todos na raiz (sem pastas)");
    const proibido = /(^|[\\/])(agent\.config.*|.*\.log|run|logs|output|.*lock.*|\.env.*|.*token.*|.*secret.*|.*password.*|pipeline.*)$/i;
    check(!lista.some((n) => proibido.test(n)), "sem agent.config.json, logs, run, locks, outputs, tokens, .env");

    const ex = path.join(tmp, "extraido");
    ps(`Expand-Archive -LiteralPath '${zip}' -DestinationPath '${ex}'`);
    const m = JSON.parse(fs.readFileSync(path.join(ex, "MANIFEST.json"), "utf8"));

    console.log("\n--- MANIFEST ---");
    check(m.pacote === "classification-audit" && m.name === "spharmmt-agent-classification-audit", "identificado como classification-audit (nome próprio)");
    check(m.diagnostico === true && m.instalavel === false, "diagnostico=true, instalavel=false");
    check(m.baseRev === "98" && AGENT_REV_BASE === "98" && m.baseCommit === BASE_COMMIT && m.baseCommit === git(["rev-parse", "beb5fa7"]) , "base rev98 (commit beb5fa7c008cb33238b3e644ec1165caf99fb648)");
    check(m.versao === "diag-2026-10-29", "versão diag-<data>");
    check(/^[0-9a-f]{40}$/.test(m.commit) && m.commit === git(["rev-parse", "HEAD"]), "commit COMPLETO (40 hex) = HEAD", m.commit);
    check(!Number.isNaN(Date.parse(m.builtAtUtc)) && /Z$/.test(m.builtAtUtc), "data UTC do build");
    check(m.dirty === sujoAgora, `dirty=${m.dirty} reflete o estado real da árvore (${sujoAgora ? "suja" : "limpa"}; só com AUDIT_PACKAGE_ALLOW_DIRTY)`);
    check(!("rev" in m) && !/rev99|"99"/.test(JSON.stringify(m)), "o manifesto NUNCA diz rev99 (nem tem campo rev)");
    const nomesManifesto = Object.keys(m.files).sort();
    check(JSON.stringify(nomesManifesto) === JSON.stringify(FICHEIROS_ESPERADOS.filter((f) => f !== "MANIFEST.json").sort()), "o manifesto lista todos os ficheiros menos ele próprio");
    check(nomesManifesto.every((f) => m.files[f].sha256 === sha(path.join(ex, f)) && m.files[f].bytes === fs.statSync(path.join(ex, f)).size), "sha256 e tamanho de CADA ficheiro batem com os extraídos");
    check(m.node.versao === "v20.18.0" && m.node.sha256 === NODE_SHA256 && sha(path.join(ex, "node.exe")) === NODE_SHA256, "node.exe v20.18.0 com o SHA-256 oficial do nodejs.org");

    console.log("\n--- conteúdo sem segredos nem rev99 ---");
    const textos = ["run-classification-audit.bat", "Run-ClassificationAudit.ps1", "Collect-ClassificationAuditReport.ps1", "LEIAME.txt", "MANIFEST.json"].map((f) => fs.readFileSync(path.join(ex, f), "utf8"));
    check(!textos.some((t) => /rev99/i.test(t)), "scripts, README e manifesto: nunca rev99");
    check(!textos.some((t) => /(password|ingestKey)\s*["']?\s*[:=]\s*["']?\w/i.test(t.replace(/\$suspeito[^\n]*/g, ""))), "sem valores de credenciais nos ficheiros de texto");
    check(!textos.some((t) => /[^\x00-\x7F]/.test(t)), "scripts/README só com ASCII (PowerShell 5.1 sem BOM)");
    check(textos.slice(0, 4).every((t) => t.includes("\r\n") && !/(?<!\r)\n/.test(t)), ".bat/.ps1/LEIAME.txt do pacote com CRLF (cmd.exe e `goto` exigem)");
    const bundle = fs.readFileSync(path.join(ex, "agent.cjs"), "utf8");
    check(/classification-audit/.test(bundle) && !/rev99/i.test(bundle), "bundle contém o comando e nunca rev99");
    check(!/Perdi o lock do pipeline|pipeline\.lock|ErroLockPerdido|bootstrap\/products|\/api\/ingest/.test(bundle), "bundle sem lock, guarda de escrita nem endpoints de ingestão do SaaS");
    check(/AUDIT_PACKAGE_VERSION|diag-2026-10-29/.test(bundle) && bundle.includes('"98"'), "bundle com a versão diag-… e AGENT_REV = \"98\"");
    check(!/SENTINEL|Co-Authored/.test(bundle), "sem lixo de testes");

    // ═══ 4. o node.exe do pacote executa a sério ═══════════════════════
    console.log("\n=== 4. node.exe do pacote: --help e recusa sem config ===");
    const nodeExe = path.join(ex, "node.exe");
    const v = spawnSync(nodeExe, ["--version"], { encoding: "utf8" });
    check(v.status === 0 && v.stdout.trim() === "v20.18.0", "node.exe extraído executa (v20.18.0)");
    const antes = fs.readdirSync(ex).sort().join();
    const hlp = spawnSync(nodeExe, ["agent.cjs", "classification-audit", "--help"], { cwd: ex, encoding: "utf8" });
    check(hlp.status === 0, "classification-audit --help: exit 0", hlp.stderr);
    check(/pacote de DIAGNÓSTICO \(base rev98\), modo read-only, não instalável/.test(hlp.stdout) && hlp.stdout.includes("--cnps") && hlp.stdout.includes("--out"), "…e identifica o pacote como DIAGNÓSTICO e documenta --out/--cnps");
    check(/classification-audit diag-2026-10-29 \(base rev98/.test(hlp.stdout), "banner: classification-audit diag-… (base rev98)");
    check(!/rev99/i.test(hlp.stdout + hlp.stderr), "a consola nunca diz rev99");
    const semCfg = spawnSync(nodeExe, ["agent.cjs", "classification-audit", "--out", ".\\output\\auditoria-classificacao.json"], { cwd: ex, encoding: "utf8" });
    check(semCfg.status === 1, "sem agent.config.json: exit 1", String(semCfg.status));
    check(/agent\.config\.json não encontrado/.test(semCfg.stderr) && /Install-ClassificationAudit\.ps1/.test(semCfg.stderr), "mensagem clara a dizer o que falta e o que fazer");
    check(fs.readdirSync(ex).sort().join() === antes && !fs.existsSync(path.join(ex, "output")) && !fs.existsSync(path.join(ex, "run")), "a recusa não criou ficheiros (nem output/ nem run/)");
    for (const proibidoCmd of ["daily-pipeline", "daily-sync", "bootstrap-upload", "products-upload", "full-sync", "sync-now", "health"]) {
      const c = spawnSync(nodeExe, ["agent.cjs", proibidoCmd], { cwd: ex, encoding: "utf8" });
      check(c.status === 1 && /Comando desconhecido neste pacote de diagnóstico/.test(c.stderr), `comando de produção «${proibidoCmd}» não existe no pacote`);
    }
    check(!fs.existsSync(path.join(ex, "run")) && !fs.readdirSync(ex).some((f) => /lock/i.test(f)), "nenhum comando criou run/ nem locks");

    // ═══ 5. o agent:package normal continua a ser a rev98 ═════════════
    console.log("\n=== 5. agent:package (build.mjs) continua a ser a rev98 ===");
    const build = fs.readFileSync(path.join(REPO, "agent", "build.mjs"), "utf8");
    check(/AGENT_PACKAGE_REV \?\? "98"/.test(build) && !/\?\? "99"/.test(build), 'AGENT_REV por omissão = "98" em build.mjs');
    check(!/classification/i.test(build), "build.mjs não menciona classification-audit (nem wrappers)");
    const cli = fs.readFileSync(path.join(REPO, "agent", "src", "cli.ts"), "utf8");
    check(!/classification/i.test(cli), "cli.ts (agent de produção) não conhece o comando");
    const refBuild = spawnSync("git", ["show", "beb5fa7:agent/build.mjs"], { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (refBuild.status === 0) {
      const novo = build.replace(/\r/g, "").split("\n");
      const velho = refBuild.stdout.replace(/\r/g, "").split("\n");
      const nVelho = new Set(velho);
      const acrescentadas = novo.filter((l) => !nVelho.has(l));
      const removidas = velho.filter((l) => !new Set(novo).has(l));
      check(removidas.length === 1 && removidas[0] === "main();", "vs rev98: a única linha removida é o `main();` final (passa a condicional)", JSON.stringify(removidas).slice(0, 200));
      check(acrescentadas.every((l) => /main\(\)|process\.argv|export \{|^\/\/|^\}$|^$/.test(l)), "…e o que se acrescenta é só o guarda de import + exports", JSON.stringify(acrescentadas).slice(0, 300));
    } else {
      console.log("  (git show beb5fa7 indisponível — comparação vs rev98 ignorada)");
    }
    check(!/audit/.test(fs.readFileSync(path.join(REPO, "package.json"), "utf8").match(/"agent:package":\s*"[^"]*"/)![0]), "o script npm agent:package não foi alterado");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n${pass} ok, ${fail} falhas`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
