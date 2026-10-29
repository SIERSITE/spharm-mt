#!/usr/bin/env node
/**
 * agent/build-audit-package.mjs
 *
 * Empacota o pacote de DIAGNÓSTICO `classification-audit` (base rev98) — SEPARADO do `npm run agent:package`
 * (agent/build.mjs), que continua a produzir exatamente a rev98. Nada daqui é um agent de produção:
 *
 *   · bundle com ENTRY POINT PRÓPRIO (agent/src/audit-cli.ts): só o comando `classification-audit`. O metafile do esbuild
 *     é conferido contra uma lista fechada de módulos; se o bundle arrastasse http-client, lock-pipeline, daily-pipeline,
 *     guarda-escrita, … o build FALHA (`verificarMetafile`);
 *   · o valor de AGENT_REV é o da rev98 ("98"); o pacote identifica-se como DIAGNÓSTICO (`classification-audit`,
 *     `diag-<data UTC>`, base rev98, `diagnostico: true`, `instalavel: false`) no manifesto, no relatório e na consola.
 *     Nada diz rev99;
 *   · RECUSA árvore git suja (como o MANIFEST da rev97/98); `AUDIT_PACKAGE_ALLOW_DIRTY=1` só para ensaios (o manifesto
 *     fica com dirty=true);
 *   · node.exe: a MESMA versão do build.mjs (v20.18.0 win-x64), procurada primeiro em caches locais
 *     (agent/.build-cache de qualquer worktree) e verificada contra o SHA-256 oficial (SHASUMS256.txt do nodejs.org);
 *     só sem cache descarrega de https://nodejs.org (ficheiro público; não toca em nenhum ERP/VPS) e verifica o hash;
 *   · NÃO inclui: agent.config.json, logs, run, locks, outputs, tokens, nem qualquer configuração de farmácia.
 *
 * Uso:   node agent/build-audit-package.mjs
 * Env:   AUDIT_PACKAGE_OUT (pasta de saída; omissão <repo>/dist-agent), AUDIT_PACKAGE_VERSION (omissão diag-AAAA-MM-DD),
 *        AUDIT_PACKAGE_ALLOW_DIRTY=1 (ensaios), AUDIT_NODE_EXE (caminho explícito para um node.exe; é verificado por hash).
 * Saída: <OUT>/spharmmt-agent-classification-audit.zip (+ .sha256). O ZIP NÃO é versionado.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as esbuild from "esbuild";
import { NODE_PLATFORM, NODE_URL, NODE_VERSION, downloadHttps, readGit } from "./build.mjs";

const __filename = fileURLToPath(import.meta.url);
const AGENT_ROOT = path.dirname(__filename);
const REPO_ROOT = path.resolve(AGENT_ROOT, "..");

export const PACOTE_ID = "classification-audit";
export const ZIP_NOME = "spharmmt-agent-classification-audit.zip";
/** Valor do AGENT_REV no bundle: o da rev98. O pacote NÃO é uma revisão nova do agent. */
export const AGENT_REV_BASE = "98";
export const BASE_COMMIT = "beb5fa7c008cb33238b3e644ec1165caf99fb648";
/** SHA-256 oficial de https://nodejs.org/dist/v20.18.0/SHASUMS256.txt → win-x64/node.exe. */
export const NODE_SHA256 = "35b7c95a379beb606f5798ed83081690df13190077630b234163c6607aa4cc94";

/** Ficheiros do pacote (lista FECHADA; o teste compara o ZIP com esta lista). */
export const FICHEIROS_ESPERADOS = [
  "Collect-ClassificationAuditReport.ps1",
  "LEIAME.txt",
  "MANIFEST.json",
  "Run-ClassificationAudit.ps1",
  "agent.cjs",
  "node.exe",
  "run-classification-audit.bat",
];

/** Módulos de agent/src que o bundle pode conter (lista fechada; tudo o resto faz o build falhar). */
export const MODULOS_PERMITIDOS = [
  "agent/src/audit-cli.ts",
  "agent/src/commands/classification-audit.ts",
  "agent/src/classificacao-auditoria.ts",
  "agent/src/sql-somente-leitura.ts",
  "agent/src/sql-validador.ts",
  "agent/src/diagnostico-pacote.ts",
  "agent/src/config.ts",
  "agent/src/sql-client.ts",
  "agent/src/sql-erros.ts",
  "agent/src/politica-retry.ts",
];

const log = (m) => console.log(`[audit:package] ${m}`);

export function sha256Ficheiro(f) {
  return createHash("sha256").update(fs.readFileSync(f)).digest("hex");
}

/** Falha se o bundle contiver módulos do agent fora da lista fechada. Pura (recebe o metafile). */
export function verificarMetafile(metafile, permitidos = MODULOS_PERMITIDOS) {
  const dentro = Object.keys(metafile.inputs)
    .map((i) => i.replace(/\\/g, "/"))
    .filter((i) => /(^|\/)agent\/src\//.test(i))
    .map((i) => i.slice(i.search(/agent\/src\//)));
  const extra = dentro.filter((i) => !permitidos.includes(i));
  if (extra.length > 0) {
    throw new Error(`o bundle de diagnóstico arrastou módulos fora da lista fechada: ${extra.join(", ")}`);
  }
  const ausentes = permitidos.filter((p) => !dentro.includes(p));
  if (ausentes.length > 0) {
    throw new Error(`o bundle de diagnóstico não contém módulos esperados: ${ausentes.join(", ")}`);
  }
  return dentro;
}

/** Candidatos a cache do node.exe: o agent/.build-cache deste repo e o de cada worktree conhecido. */
export function candidatosNode() {
  const nome = `node-${NODE_VERSION}-${NODE_PLATFORM}.exe`;
  const raizes = new Set([REPO_ROOT]);
  const lista = readGit("worktree list --porcelain");
  for (const l of lista.split(/\r?\n/)) {
    if (l.startsWith("worktree ")) raizes.add(l.slice("worktree ".length).trim());
  }
  const c = [];
  if (process.env.AUDIT_NODE_EXE) c.push(process.env.AUDIT_NODE_EXE);
  for (const r of raizes) c.push(path.join(r, "agent", ".build-cache", nome));
  return c;
}

async function obterNodeExe() {
  for (const c of candidatosNode()) {
    if (!fs.existsSync(c)) continue;
    const h = sha256Ficheiro(c);
    if (h === NODE_SHA256) {
      log(`node.exe ${NODE_VERSION} da cache local (SHA-256 verificado): ${c}`);
      return c;
    }
    log(`AVISO: ${c} ignorado (SHA-256 ${h} ≠ ${NODE_SHA256})`);
  }
  const cache = path.join(AGENT_ROOT, ".build-cache");
  fs.mkdirSync(cache, { recursive: true });
  const destino = path.join(cache, `node-${NODE_VERSION}-${NODE_PLATFORM}.exe`);
  log(`sem cache local válida: a descarregar ${NODE_URL} (ficheiro público do nodejs.org)`);
  await downloadHttps(NODE_URL, destino);
  const h = sha256Ficheiro(destino);
  if (h !== NODE_SHA256) {
    fs.rmSync(destino, { force: true });
    throw new Error(`SHA-256 do node.exe descarregado não confere (${h})`);
  }
  log("node.exe descarregado e verificado");
  return destino;
}

function estadoGit(permitirSujo) {
  const commit = readGit("rev-parse HEAD");
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("não foi possível ler o commit git completo (HEAD)");
  const sujo = readGit("status --porcelain").length > 0;
  if (sujo && !permitirSujo) {
    throw new Error(
      "Árvore git com alterações por commitar — o pacote não seria reprodutível a partir de um commit selado. " +
        "Faz commit (ou AUDIT_PACKAGE_ALLOW_DIRTY=1 só para ensaios; o manifesto fica com dirty=true).",
    );
  }
  return { commit, branch: readGit("rev-parse --abbrev-ref HEAD"), dirty: sujo };
}

export async function construirPacote(opcoes = {}) {
  const t0 = Date.now();
  const permitirSujo = (opcoes.permitirSujo ?? process.env.AUDIT_PACKAGE_ALLOW_DIRTY === "1") === true;
  const saida = path.resolve(opcoes.saida ?? process.env.AUDIT_PACKAGE_OUT ?? path.join(REPO_ROOT, "dist-agent"));
  const agoraUtc = new Date();
  const versao = opcoes.versao ?? process.env.AUDIT_PACKAGE_VERSION ?? `diag-${agoraUtc.toISOString().slice(0, 10)}`;
  if (!/^diag-[0-9A-Za-z._-]+$/.test(versao)) throw new Error(`versão inválida (esperado diag-<data>): ${versao}`);

  // 1) ANTES de qualquer trabalho: árvore limpa.
  const git = estadoGit(permitirSujo);
  const nodeExe = await obterNodeExe();

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "spharmmt-audit-pkg-"));
  try {
    // 2) bundle (entry point dedicado; AGENT_REV = 98)
    log(`a bundlar agent/src/audit-cli.ts → agent.cjs (versão ${versao}, base rev${AGENT_REV_BASE})`);
    const resultado = await esbuild.build({
      entryPoints: [path.join(AGENT_ROOT, "src", "audit-cli.ts")],
      outfile: path.join(staging, "agent.cjs"),
      platform: "node",
      target: "node20",
      format: "cjs",
      bundle: true,
      minify: false,
      sourcemap: false,
      logLevel: "warning",
      metafile: true,
      define: {
        "process.env.AGENT_BUILD_BUNDLED": '"1"',
        "process.env.AGENT_REV": JSON.stringify(AGENT_REV_BASE),
        "process.env.AGENT_COMMIT": JSON.stringify(git.commit.slice(0, 7)),
        "process.env.AGENT_BUILD_TS": JSON.stringify(agoraUtc.toISOString()),
        "process.env.AUDIT_PACKAGE_VERSION": JSON.stringify(versao),
      },
    });
    if (resultado.errors.length > 0) throw new Error(`esbuild reportou ${resultado.errors.length} erro(s)`);
    const modulos = verificarMetafile(resultado.metafile);
    log(`  ✓ bundle com ${modulos.length} módulos do agent (lista fechada verificada)`);

    // 3) ficheiros do pacote
    fs.copyFileSync(nodeExe, path.join(staging, "node.exe"));
    const pacoteDir = path.join(AGENT_ROOT, "audit", "pacote");
    // .bat/.ps1/.txt do pacote saem SEMPRE com CRLF (independente do fim-de-linha do checkout): o cmd.exe falha com
    // `goto :etiqueta` em .bat só com LF, e o resultado fica reprodutível entre máquinas.
    for (const f of fs.readdirSync(pacoteDir)) {
      const texto = fs.readFileSync(path.join(pacoteDir, f), "utf8").replace(/\r?\n/g, "\r\n");
      fs.writeFileSync(path.join(staging, f), texto, "utf8");
    }

    // 4) MANIFEST (por último; não se auto-referencia; sem segredos)
    const files = {};
    for (const f of fs.readdirSync(staging).sort((a, b) => a.localeCompare(b))) {
      files[f] = { sha256: sha256Ficheiro(path.join(staging, f)), bytes: fs.statSync(path.join(staging, f)).size };
    }
    const manifest = {
      name: "spharmmt-agent-classification-audit",
      pacote: PACOTE_ID,
      versao,
      diagnostico: true,
      instalavel: false,
      baseRev: AGENT_REV_BASE,
      baseCommit: BASE_COMMIT,
      commit: git.commit,
      branch: git.branch,
      builtAtUtc: agoraUtc.toISOString(),
      dirty: git.dirty,
      node: { versao: NODE_VERSION, plataforma: NODE_PLATFORM, sha256: NODE_SHA256 },
      files,
    };
    fs.writeFileSync(path.join(staging, "MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

    // 5) lista exata
    const conteudo = fs.readdirSync(staging).sort();
    const esperado = [...FICHEIROS_ESPERADOS].sort();
    if (JSON.stringify(conteudo) !== JSON.stringify(esperado)) {
      throw new Error(`conteúdo do pacote ≠ lista esperada: [${conteudo.join(", ")}] vs [${esperado.join(", ")}]`);
    }

    // 6) ZIP
    fs.mkdirSync(saida, { recursive: true });
    const zipPath = path.join(saida, ZIP_NOME);
    fs.rmSync(zipPath, { force: true });
    if (process.platform !== "win32") throw new Error("o empacotamento do diagnóstico é feito em Windows (Compress-Archive)");
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `Compress-Archive -Path '${staging}\\*' -DestinationPath '${zipPath}' -Force`],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const zipSha = sha256Ficheiro(zipPath);
    fs.writeFileSync(`${zipPath}.sha256`, `${zipSha}  ${ZIP_NOME}\n`, "ascii");
    const bytes = fs.statSync(zipPath).size;
    log(`✓ ${zipPath}`);
    log(`  tamanho ${bytes} bytes · SHA-256 ${zipSha} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return { zipPath, zipSha, bytes, manifest };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === path.resolve(__filename).toLowerCase()) {
  construirPacote().catch((err) => {
    console.error(`[audit:package] ✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
