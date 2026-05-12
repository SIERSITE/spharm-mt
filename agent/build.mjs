#!/usr/bin/env node
/**
 * agent/build.mjs
 *
 * Build script para empacotar o agent num artefacto Windows-ready.
 *
 * Output (em `<repo>/dist-agent/SPharmMT-Agent/`):
 *   · node.exe                       — Node runtime portable (Windows x64)
 *   · agent.cjs                      — bundle CJS (esbuild) com todas as deps
 *   · agent.config.example.json      — template de config (renomear → agent.config.json)
 *   · INSTALL_WINDOWS.md             — guia operacional
 *   · run-test-connection.bat        — wrapper double-clickable
 *   · run-discover.bat
 *   · run-health.bat
 *   · output/.gitkeep                — onde discovery deposita ficheiros
 *   · logs/.gitkeep                  — reservado para futuro daily-sync
 *
 * Pré-requisitos: nenhum. Build funciona em Mac/Linux/Windows; o
 * download de node.exe (Windows) acontece em qualquer host dev.
 *
 * Cache: node.exe é descarregado uma vez para `agent/.build-cache/`
 * (gitignored) e reaproveitado em builds subsequentes.
 *
 * Uso:
 *   npm run agent:package        # do repo root, top-level package.json
 *   # ou
 *   node agent/build.mjs
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as https from "node:https";
import * as esbuild from "esbuild";

const __filename = fileURLToPath(import.meta.url);
const AGENT_ROOT = path.dirname(__filename);
const REPO_ROOT = path.resolve(AGENT_ROOT, "..");

// ── Configuração ─────────────────────────────────────────────────────
const NODE_VERSION = "v20.18.0"; // pinned — actualizar com critério
const NODE_PLATFORM = "win-x64";
const NODE_URL = `https://nodejs.org/dist/${NODE_VERSION}/${NODE_PLATFORM}/node.exe`;
const NODE_SHA = null; // opcional: SHA256SUMS.txt da Node release; null = sem check

const DIST_NAME = "SPharmMT-Agent";
const DIST_ROOT = path.join(REPO_ROOT, "dist-agent", DIST_NAME);
const BUILD_CACHE = path.join(AGENT_ROOT, ".build-cache");
const CACHED_NODE = path.join(BUILD_CACHE, `node-${NODE_VERSION}-${NODE_PLATFORM}.exe`);

// ─────────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[agent:package] ${msg}`);
}
function logErr(msg) {
  console.error(`[agent:package] ✗ ${msg}`);
}

// ── Helpers ──────────────────────────────────────────────────────────

function downloadHttps(url, dest, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const fileStream = fs.createWriteStream(dest);
    https
      .get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fileStream.close();
          fs.unlinkSync(dest);
          if (redirectsLeft <= 0) {
            return reject(new Error(`too many redirects fetching ${url}`));
          }
          return downloadHttps(res.headers.location, dest, redirectsLeft - 1).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          fileStream.close();
          fs.unlinkSync(dest);
          return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        }
        res.pipe(fileStream);
        fileStream.on("finish", () => fileStream.close(() => resolve(undefined)));
      })
      .on("error", (err) => {
        fileStream.close();
        try {
          fs.unlinkSync(dest);
        } catch {}
        reject(err);
      });
  });
}

async function ensureNodeExe() {
  fs.mkdirSync(BUILD_CACHE, { recursive: true });
  if (fs.existsSync(CACHED_NODE)) {
    const stat = fs.statSync(CACHED_NODE);
    if (stat.size > 10_000_000) {
      log(`Node ${NODE_VERSION} cached (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
      return CACHED_NODE;
    }
    log(`Cache corrompido (${stat.size} bytes) — re-fetch`);
    fs.unlinkSync(CACHED_NODE);
  }
  log(`A descarregar Node ${NODE_VERSION} para ${NODE_PLATFORM}…`);
  log(`  ${NODE_URL}`);
  await downloadHttps(NODE_URL, CACHED_NODE);
  const finalSize = fs.statSync(CACHED_NODE).size;
  log(`  ✓ ${(finalSize / 1024 / 1024).toFixed(1)} MB descarregados`);
  return CACHED_NODE;
}

function cleanDist() {
  if (fs.existsSync(DIST_ROOT)) {
    log(`A limpar ${path.relative(REPO_ROOT, DIST_ROOT)}…`);
    fs.rmSync(DIST_ROOT, { recursive: true, force: true });
  }
  fs.mkdirSync(DIST_ROOT, { recursive: true });
  fs.mkdirSync(path.join(DIST_ROOT, "output"), { recursive: true });
  fs.mkdirSync(path.join(DIST_ROOT, "logs"), { recursive: true });
  fs.writeFileSync(path.join(DIST_ROOT, "output", ".gitkeep"), "");
  fs.writeFileSync(path.join(DIST_ROOT, "logs", ".gitkeep"), "");
}

async function bundle() {
  const entryPoint = path.join(AGENT_ROOT, "src", "cli.ts");
  const outfile = path.join(DIST_ROOT, "agent.cjs");
  log(`A bundlar src/cli.ts → ${path.relative(REPO_ROOT, outfile)}…`);
  const result = await esbuild.build({
    entryPoints: [entryPoint],
    outfile,
    platform: "node",
    target: "node20",
    format: "cjs",
    bundle: true,
    minify: false,
    sourcemap: false,
    logLevel: "warning",
    define: { "process.env.AGENT_BUILD_BUNDLED": '"1"' },
    // Externals: vazio — bundle tudo. mssql usa tedious (pure-JS),
    // não há native deps a externalizar.
    external: [],
  });
  if (result.errors.length > 0) {
    throw new Error(`esbuild reportou ${result.errors.length} erro(s)`);
  }
  const stat = fs.statSync(outfile);
  log(`  ✓ ${(stat.size / 1024 / 1024).toFixed(1)} MB`);
}

function copyResources() {
  log("A copiar recursos estáticos…");
  // Config example
  fs.copyFileSync(
    path.join(AGENT_ROOT, "agent.config.example.json"),
    path.join(DIST_ROOT, "agent.config.example.json")
  );
  // Install guide
  const installSrc = path.join(AGENT_ROOT, "INSTALL_WINDOWS.md");
  if (fs.existsSync(installSrc)) {
    fs.copyFileSync(installSrc, path.join(DIST_ROOT, "INSTALL_WINDOWS.md"));
  } else {
    log(`  ⚠ INSTALL_WINDOWS.md não existe em agent/ — saltado`);
  }
  // Security checklist (referenciada pelo INSTALL_WINDOWS)
  const securitySrc = path.join(AGENT_ROOT, "SECURITY.md");
  if (fs.existsSync(securitySrc)) {
    fs.copyFileSync(securitySrc, path.join(DIST_ROOT, "SECURITY.md"));
  }
  log("  ✓ config example + docs");
}

function writeBatchWrappers() {
  log("A escrever wrappers .bat…");
  const wrappers = {
    "run-test-connection.bat": "test-connection",
    "run-discover.bat": "discover",
    "run-health.bat": "health",
  };
  for (const [filename, command] of Object.entries(wrappers)) {
    const content = [
      `@echo off`,
      `REM SPharm.MT agent — ${command}`,
      `REM Gerado por agent/build.mjs. Não editar manualmente.`,
      ``,
      `cd /d "%~dp0"`,
      `if not exist agent.config.json (`,
      `  echo.`,
      `  echo ERRO: agent.config.json nao encontrado.`,
      `  echo Copia agent.config.example.json para agent.config.json e edita.`,
      `  echo Detalhes em INSTALL_WINDOWS.md.`,
      `  echo.`,
      `  pause`,
      `  exit /b 1`,
      `)`,
      `if not exist node.exe (`,
      `  echo.`,
      `  echo ERRO: node.exe nao encontrado nesta pasta.`,
      `  echo O pacote SPharmMT-Agent deve incluir node.exe. Verifica o ZIP.`,
      `  echo.`,
      `  pause`,
      `  exit /b 1`,
      `)`,
      `node.exe agent.cjs ${command}`,
      `set EXIT=%ERRORLEVEL%`,
      `echo.`,
      `pause`,
      `exit /b %EXIT%`,
      ``,
    ].join("\r\n");
    fs.writeFileSync(path.join(DIST_ROOT, filename), content, "utf8");
  }
  log(`  ✓ ${Object.keys(wrappers).length} wrappers`);
}

function copyNodeExe(srcExe) {
  const destExe = path.join(DIST_ROOT, "node.exe");
  log(`A copiar node.exe → ${path.relative(REPO_ROOT, destExe)}…`);
  fs.copyFileSync(srcExe, destExe);
}

function writeReadme() {
  const readme = [
    `SPharm.MT — Local Agent v0.1.0 (Windows x64)`,
    ``,
    `Distribuição self-contained. NÃO requer Node, npm, nem código fonte`,
    `instalado no servidor da farmácia.`,
    ``,
    `Quick start:`,
    `  1. Renomeia agent.config.example.json para agent.config.json`,
    `  2. Edita agent.config.json com os valores reais do servidor`,
    `  3. Duplo-clique em run-test-connection.bat`,
    `  4. Se tudo OK, duplo-clique em run-discover.bat`,
    `  5. Envia o conteudo de output\\ ao dev`,
    ``,
    `Detalhes completos: abre INSTALL_WINDOWS.md (qualquer editor de texto`,
    `ou viewer Markdown).`,
    ``,
    `Conteudo deste pacote:`,
    `  node.exe                        Node runtime portable (Windows x64, ${NODE_VERSION})`,
    `  agent.cjs                       Bundle do agent (TypeScript + deps)`,
    `  agent.config.example.json       Template de config (copia para agent.config.json)`,
    `  run-test-connection.bat         Validar config + SQL Server + SaaS`,
    `  run-discover.bat                Inspecionar schema ERP read-only`,
    `  run-health.bat                  Diagnostico verboso`,
    `  INSTALL_WINDOWS.md              Guia passo a passo`,
    `  SECURITY.md                     Checklist de seguranca`,
    `  output\\                         Onde discover deposita ficheiros`,
    `  logs\\                           Reservado para sync futuro`,
    ``,
  ].join("\r\n");
  fs.writeFileSync(path.join(DIST_ROOT, "README.txt"), readme, "utf8");
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  try {
    const nodeExe = await ensureNodeExe();
    cleanDist();
    await bundle();
    copyNodeExe(nodeExe);
    copyResources();
    writeBatchWrappers();
    writeReadme();
    const dur = ((Date.now() - t0) / 1000).toFixed(1);
    log("─".repeat(60));
    log(`✓ Build concluído em ${dur}s`);
    log(`  Output : ${path.relative(REPO_ROOT, DIST_ROOT)}`);
    log("  Conteúdo:");
    const entries = fs.readdirSync(DIST_ROOT).sort();
    for (const e of entries) {
      const full = path.join(DIST_ROOT, e);
      const stat = fs.statSync(full);
      const size = stat.isFile() ? ` (${(stat.size / 1024).toFixed(0)} KB)` : " (dir)";
      log(`    · ${e}${size}`);
    }
    log("");
    log("Próximo passo: zip dist-agent/SPharmMT-Agent/ e envia ao operador.");
  } catch (err) {
    logErr(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();
