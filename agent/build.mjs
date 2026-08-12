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
import { execSync } from "node:child_process";
import * as esbuild from "esbuild";

const __filename = fileURLToPath(import.meta.url);
const AGENT_ROOT = path.dirname(__filename);
const REPO_ROOT = path.resolve(AGENT_ROOT, "..");

// ── Configuração ─────────────────────────────────────────────────────
const NODE_VERSION = "v20.18.0"; // pinned — actualizar com critério
const NODE_PLATFORM = "win-x64";
const NODE_URL = `https://nodejs.org/dist/${NODE_VERSION}/${NODE_PLATFORM}/node.exe`;
const NODE_SHA = null; // opcional: SHA256SUMS.txt da Node release; null = sem check

// AGENT_REV: versão do ZIP/distribuição. Bumpar manualmente a cada rev
// que vai para uma farmácia real. Tem de coincidir com o sufixo do ZIP
// (SPharmMT-Agent-YYYY-MM-DD-rev<N>.zip). Operador vê este valor no
// banner que o cli.ts imprime no arranque de qualquer comando.
const AGENT_REV = "56";

function readGitShortCommit() {
  try {
    return execSync("git rev-parse --short HEAD", {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

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
  const commit = readGitShortCommit();
  const buildTs = new Date().toISOString();
  log(`A bundlar src/cli.ts → ${path.relative(REPO_ROOT, outfile)}…`);
  log(`  rev=${AGENT_REV} commit=${commit} buildTs=${buildTs}`);
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
    define: {
      "process.env.AGENT_BUILD_BUNDLED": '"1"',
      "process.env.AGENT_REV": JSON.stringify(AGENT_REV),
      "process.env.AGENT_COMMIT": JSON.stringify(commit),
      "process.env.AGENT_BUILD_TS": JSON.stringify(buildTs),
    },
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
    "run-discover-products.bat": "discover-products",
    "run-discover-stock.bat": "discover-stock",
    "run-discover-sales.bat": "discover-sales",
    "run-products-preview.bat": "products-preview",
    "run-stock-preview.bat": "stock-preview",
    "run-movimentos-audit.bat": "movimentos-audit",
    "run-iva-audit.bat": "iva-audit",
    // rev46 — localiza DCI, ATC, Grupo Homogéneo e Fabricante no schema do
    // ERP. Read-only. Tem de correr ANTES do products-upload para se saber
    // o que a instalação expõe.
    "run-catalog-audit.bat": "catalog-audit",
    "run-catalog-discover-links.bat": "catalog-discover-links",
    "run-health.bat": "health",
  };
  const preamble = [
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
  ];
  for (const [filename, command] of Object.entries(wrappers)) {
    const content = [
      `@echo off`,
      `REM SPharm.MT agent — ${command}`,
      `REM Gerado por agent/build.mjs. Não editar manualmente.`,
      ``,
      ...preamble,
      `node.exe agent.cjs ${command}`,
      `set EXIT=%ERRORLEVEL%`,
      `echo.`,
      `pause`,
      `exit /b %EXIT%`,
      ``,
    ].join("\r\n");
    fs.writeFileSync(path.join(DIST_ROOT, filename), content, "utf8");
  }
  // probe-table — wrapper interactivo que prompta a tabela alvo
  const probeTableBat = [
    `@echo off`,
    `REM SPharm.MT agent — probe-table (interactivo)`,
    `REM Gerado por agent/build.mjs. Não editar manualmente.`,
    `setlocal`,
    ``,
    ...preamble,
    `echo.`,
    `echo ============================================================`,
    `echo   probe-table — probe generico read-only`,
    `echo ============================================================`,
    `echo.`,
    `echo Exemplos:`,
    `echo   dbo.Stocks`,
    `echo   dbo.ArmazensStocks`,
    `echo   dbo.Atendimento Detalhe       ^(nome com espaco^)`,
    `echo   dbo.EntidadesFact_Cab`,
    `echo.`,
    `set "TABELA="`,
    `set /p "TABELA=Tabela alvo (schema.tabela): "`,
    `if "%TABELA%"=="" (`,
    `  echo.`,
    `  echo Nome vazio. Aborta.`,
    `  echo.`,
    `  pause`,
    `  exit /b 1`,
    `)`,
    `echo.`,
    `node.exe agent.cjs probe-table --table "%TABELA%"`,
    `set EXIT=%ERRORLEVEL%`,
    `echo.`,
    `pause`,
    `endlocal & exit /b %EXIT%`,
    ``,
  ].join("\r\n");
  fs.writeFileSync(path.join(DIST_ROOT, "run-probe-table.bat"), probeTableBat, "utf8");

  // inspect-codigoid — wrapper interactivo que prompta lista de IDs
  const inspectCodigoIdBat = [
    `@echo off`,
    `REM SPharm.MT agent — inspect-codigoid (interactivo)`,
    `REM Gerado por agent/build.mjs. Não editar manualmente.`,
    `setlocal`,
    ``,
    ...preamble,
    `echo.`,
    `echo ============================================================`,
    `echo   inspect-codigoid — diagnose de CodigoIDs orfaos`,
    `echo ============================================================`,
    `echo.`,
    `echo Consulta dbo.Stocks read-only para a lista de CodigoIDs.`,
    `echo Mostra Codigo (CNP), Nome Comercial, flags Retirado/Processa_Stocks,`,
    `echo datas chave, PVP. Util para perceber porque um produto vendido`,
    `echo nao foi upserted em Produto SaaS.`,
    `echo.`,
    `echo Formato: lista CSV de inteiros, ex.: 35023,12551,34972`,
    `echo.`,
    `set "IDS="`,
    `set /p "IDS=CodigoIDs (separados por virgula): "`,
    `if "%IDS%"=="" (`,
    `  echo Lista vazia. Aborta.`,
    `  echo.`,
    `  pause`,
    `  exit /b 1`,
    `)`,
    `echo.`,
    `node.exe agent.cjs inspect-codigoid --ids "%IDS%"`,
    `set EXIT=%ERRORLEVEL%`,
    `echo.`,
    `pause`,
    `endlocal & exit /b %EXIT%`,
    ``,
  ].join("\r\n");
  fs.writeFileSync(path.join(DIST_ROOT, "run-inspect-codigoid.bat"), inspectCodigoIdBat, "utf8");

  // inspect-orders-schema — probe read-only às tabelas SPharm de encomendas.
  // Sem args, sem prompts. Gera output/orders-schema-<data>/inspection.md.
  // NUNCA escreve no SPharm. NUNCA chama a SaaS.
  const inspectOrdersSchemaBat = [
    `@echo off`,
    `REM SPharm.MT agent — inspect-orders-schema`,
    `REM Gerado por agent/build.mjs. Não editar manualmente.`,
    `setlocal`,
    ``,
    ...preamble,
    `echo.`,
    `echo ============================================================`,
    `echo   inspect-orders-schema`,
    `echo ============================================================`,
    `echo.`,
    `echo Probe READ-ONLY as tabelas de encomendas no SPharm local.`,
    `echo NAO escreve nada no ERP. NAO envia nada para a SaaS.`,
    `echo.`,
    `echo Pre-requisito: run-test-connection.bat OK.`,
    `echo.`,
    `echo Tabelas-alvo (default):`,
    `echo   - dbo.Encomendas`,
    `echo   - dbo.Encomendas Detalhe`,
    `echo   - dbo.EncomendasFaltas`,
    `echo   - dbo.Encomendas_Prepara`,
    `echo   - dbo.Fornecedores`,
    `echo   - dbo.Stocks`,
    `echo.`,
    `node.exe agent.cjs inspect-orders-schema`,
    `set EXIT=%ERRORLEVEL%`,
    `echo.`,
    `echo ============================================================`,
    `if "%EXIT%"=="0" (`,
    `  echo Ficheiro gerado em:`,
    `  echo   output\\orders-schema-^<YYYY-MM-DD^>\\inspection.md`,
    `  echo   ^(ver caminho exacto na linha "Markdown completo:" acima^)`,
    `  echo.`,
    `  echo IMPORTANTE: este comando NAO activa escrita real no SPharm.`,
    `  echo A escrita real so sera implementada depois do operador SPharm`,
    `  echo validar o conteudo de inspection.md.`,
    `  echo.`,
    `  echo Proximo passo: enviar inspection.md ao admin SPharm.MT.`,
    `) else (`,
    `  echo Falhou com exit code %EXIT%.`,
    `  echo Verifica que o SQL Server esta acessivel:`,
    `  echo   - run-test-connection.bat OK?`,
    `  echo   - agent.config.json com host/user/password correctos?`,
    `)`,
    `echo ============================================================`,
    `echo.`,
    `pause`,
    `endlocal & exit /b %EXIT%`,
    ``,
  ].join("\r\n");
  fs.writeFileSync(
    path.join(DIST_ROOT, "run-inspect-orders-schema.bat"),
    inspectOrdersSchemaBat,
    "utf8"
  );

  // inspect-compras-schema — probe read-only às tabelas de compras +
  // devoluções a fornecedor. Análogo a inspect-orders-schema mas para
  // o outro lado do fluxo (SPharm → SaaS, leitura de mercadoria recebida).
  // NUNCA escreve no SPharm. NUNCA chama a SaaS.
  const inspectComprasSchemaBat = [
    `@echo off`,
    `REM SPharm.MT agent — inspect-compras-schema`,
    `REM Gerado por agent/build.mjs. Não editar manualmente.`,
    `setlocal`,
    ``,
    ...preamble,
    `echo.`,
    `echo ============================================================`,
    `echo   inspect-compras-schema`,
    `echo ============================================================`,
    `echo.`,
    `echo Probe READ-ONLY ao schema de compras + devolucoes a fornecedor`,
    `echo no SPharm local.`,
    `echo NAO escreve nada no ERP. NAO envia nada para a SaaS.`,
    `echo.`,
    `echo Domios cobertos:`,
    `echo   - compras / recepcoes / facturas de compra / notas de entrada`,
    `echo   - devolucoes a fornecedor / notas de devolucao`,
    `echo   - fornecedores (master)`,
    `echo.`,
    `echo Pre-requisito: run-test-connection.bat OK.`,
    `echo.`,
    `echo Tabelas-alvo default ^(16 candidatas reais Softreis confirmadas em rev22:`,
    `echo Recepcao + Recepcao Detalhe + satelites + Recepcao_Anulados/Situacao/Encomenda;`,
    `echo Devolucao + Devolucao Detalhe + Anulados/Situacao/Resolucao + link a Recepcao;`,
    `echo MotivosDevolucaoRec + Tbl_Tipo_Fornecedores^) + auto-discovery sys.tables:`,
    `echo   compra, recep, entrada, devol, fornec, fact, nota, aquisi, moviment`,
    `echo.`,
    `node.exe agent.cjs inspect-compras-schema`,
    `set EXIT=%ERRORLEVEL%`,
    `echo.`,
    `echo ============================================================`,
    `if "%EXIT%"=="0" (`,
    `  echo Ficheiro gerado em:`,
    `  echo   output\\compras-schema-^<YYYY-MM-DD^>\\inspection.md`,
    `  echo   ^(ver caminho exacto na linha "Markdown completo:" acima^)`,
    `  echo.`,
    `  echo IMPORTANTE: este comando e' apenas DISCOVERY.`,
    `  echo NAO activa qualquer ingestao de compras/devolucoes para a SaaS.`,
    `  echo A Fase 1 ^(staging + ingest endpoints + agent extract^) so e'`,
    `  echo desenhada depois do operador SPharm validar o inspection.md.`,
    `  echo.`,
    `  echo Proximo passo: enviar inspection.md + respostas ao admin SPharm.MT.`,
    `) else (`,
    `  echo Falhou com exit code %EXIT%.`,
    `  echo Verifica que o SQL Server esta acessivel:`,
    `  echo   - run-test-connection.bat OK?`,
    `  echo   - agent.config.json com host/user/password correctos?`,
    `)`,
    `echo ============================================================`,
    `echo.`,
    `pause`,
    `endlocal & exit /b %EXIT%`,
    ``,
  ].join("\r\n");
  fs.writeFileSync(
    path.join(DIST_ROOT, "run-inspect-compras-schema.bat"),
    inspectComprasSchemaBat,
    "utf8"
  );

  // inspect-compras-lookups — probe read-only focado em Fornecedores +
  // Tipo Documento + amostras pós-data-corte + fórmulas + estados +
  // orphans. Complementa inspect-compras-schema (que mapeia tabelas) com
  // o detalhe operacional necessário para desenhar a Fase 1.
  // NUNCA escreve no SPharm. NUNCA chama a SaaS.
  const inspectComprasLookupsBat = [
    `@echo off`,
    `REM SPharm.MT agent — inspect-compras-lookups`,
    `REM Gerado por agent/build.mjs. Não editar manualmente.`,
    `setlocal`,
    ``,
    ...preamble,
    `echo.`,
    `echo ============================================================`,
    `echo   inspect-compras-lookups`,
    `echo ============================================================`,
    `echo.`,
    `echo Probe READ-ONLY focado nos lookups + amostras reais.`,
    `echo Complementa inspect-compras-schema com detalhe operacional.`,
    `echo NAO escreve nada no ERP. NAO envia nada para a SaaS.`,
    `echo.`,
    `echo Cobre:`,
    `echo   1. dbo.Fornecedores      schema + TOP 20 activos`,
    `echo   2. dbo.Tipo Documento    schema + cross-ref Recepcao/Devolucao`,
    `echo   3. Amostras reais pos data-corte ^(default 2024-01-01^)`,
    `echo   4. Validacao formulas Quantidade x preco`,
    `echo   5. Contagens por estado ^(RecepcaoSituacaoID, DevolucaoSituacaoID^)`,
    `echo   6. Orphans: linhas sem header/Stocks/Fornecedor`,
    `echo.`,
    `echo Pre-requisito: run-inspect-compras-schema.bat ja correu e admin`,
    `echo validou as tabelas reais ^(rev22/rev23^).`,
    `echo.`,
    `echo Para passar data-corte alternativa:`,
    `echo   node.exe agent.cjs inspect-compras-lookups --data-corte 2023-01-01`,
    `echo.`,
    `node.exe agent.cjs inspect-compras-lookups`,
    `set EXIT=%ERRORLEVEL%`,
    `echo.`,
    `echo ============================================================`,
    `if "%EXIT%"=="0" (`,
    `  echo Ficheiro gerado em:`,
    `  echo   output\\compras-lookups-^<YYYY-MM-DD^>\\inspection.md`,
    `  echo   ^(ver caminho exacto na linha "Markdown completo:" acima^)`,
    `  echo.`,
    `  echo IMPORTANTE: este comando e' DISCOVERY focado.`,
    `  echo NAO activa qualquer ingestao de compras/devolucoes para a SaaS.`,
    `  echo Fase 1 ^(staging + endpoints + agent extract^) so e' desenhada`,
    `  echo depois do operador validar este inspection.md.`,
    `  echo.`,
    `  echo Proximo passo: enviar inspection.md ao admin SPharm.MT.`,
    `) else (`,
    `  echo Falhou com exit code %EXIT%.`,
    `  echo Verifica que o SQL Server esta acessivel:`,
    `  echo   - run-test-connection.bat OK?`,
    `  echo   - agent.config.json com host/user/password correctos?`,
    `)`,
    `echo ============================================================`,
    `echo.`,
    `pause`,
    `endlocal & exit /b %EXIT%`,
    ``,
  ].join("\r\n");
  fs.writeFileSync(
    path.join(DIST_ROOT, "run-inspect-compras-lookups.bat"),
    inspectComprasLookupsBat,
    "utf8"
  );

  // fornecedores-dry-run — read-only, sem POST.
  // Lê dbo.Fornecedores + LEFT JOIN Tbl_Tipo_Fornecedores e imprime
  // sumário + TOP 10 amostra. Não faz qualquer chamada à SaaS.
  const fornecedoresDryRunBat = [
    `@echo off`,
    `REM SPharm.MT agent — fornecedores-dry-run`,
    `REM Gerado por agent/build.mjs. Não editar manualmente.`,
    `setlocal`,
    ``,
    ...preamble,
    `echo.`,
    `echo ============================================================`,
    `echo   fornecedores-dry-run`,
    `echo ============================================================`,
    `echo.`,
    `echo Fase 1a do pipeline compras/devolucoes:`,
    `echo Le dbo.Fornecedores + LEFT JOIN dbo.Tbl_Tipo_Fornecedores`,
    `echo read-only. Imprime sumario + TOP 10 amostra. SEM POST.`,
    `echo.`,
    `echo Pre-requisito: run-test-connection.bat OK.`,
    `echo.`,
    `echo Apos validar o output, corre run-fornecedores-upload.bat.`,
    `echo.`,
    `node.exe agent.cjs fornecedores-dry-run`,
    `set EXIT=%ERRORLEVEL%`,
    `echo.`,
    `echo ============================================================`,
    `if "%EXIT%"=="0" (`,
    `  echo Dry-run OK. Nada escrito no ERP. Nada enviado para a SaaS.`,
    `  echo.`,
    `  echo Proximo passo: run-fornecedores-upload.bat`,
    `) else (`,
    `  echo Falhou com exit code %EXIT%. Ver mensagens acima.`,
    `)`,
    `echo ============================================================`,
    `echo.`,
    `pause`,
    `endlocal & exit /b %EXIT%`,
    ``,
  ].join("\r\n");
  fs.writeFileSync(
    path.join(DIST_ROOT, "run-fornecedores-dry-run.bat"),
    fornecedoresDryRunBat,
    "utf8"
  );

  // fornecedores-upload — POST batched a /api/ingest/v1/bootstrap/fornecedores.
  // Idempotente: (farmaciaId, externalFornecedorId) único. Re-run seguro.
  // Confirmação explícita porque escreve para a SaaS.
  const fornecedoresUploadBat = [
    `@echo off`,
    `REM SPharm.MT agent — fornecedores-upload (interactivo, com confirmacao)`,
    `REM Gerado por agent/build.mjs. Não editar manualmente.`,
    `setlocal`,
    ``,
    ...preamble,
    `echo.`,
    `echo ============================================================`,
    `echo   fornecedores-upload — Fase 1a INGEST REAL`,
    `echo ============================================================`,
    `echo.`,
    `echo Vai POSTar fornecedores para a SaaS SPharm.MT:`,
    `echo   - UPSERT Fornecedor canonico ^(por nomeNormalizado^)`,
    `echo   - UPSERT FornecedorErpRef ^(por farmaciaId+externalFornecedorId^)`,
    `echo   - ADD aliases ^(nunca apaga^)`,
    `echo   - Mapeia [Inactivo]=1 em Fornecedor.estado=INATIVO`,
    `echo.`,
    `echo Idempotente: re-run produz mesmo estado, sem duplicacao.`,
    `echo Requer: ENABLE_AGENT_BOOTSTRAP=1 no SaaS.`,
    `echo.`,
    `echo Pre-requisitos:`,
    `echo   - run-test-connection.bat OK ^(SQL + SaaS^)`,
    `echo   - run-fornecedores-dry-run.bat OK e revisto`,
    `echo   - SPHARMMT_FARMACIA configurado em agent.config.json`,
    `echo.`,
    `echo --- CONFIRMACAO ---`,
    `set "CONFIRM="`,
    `set /p "CONFIRM=Escreve CONFIRMO ^(em maiusculas^) para prosseguir: "`,
    `if not "%CONFIRM%"=="CONFIRMO" (`,
    `  echo.`,
    `  echo Confirmacao invalida. Aborta sem escrever nada.`,
    `  echo.`,
    `  pause`,
    `  exit /b 1`,
    `)`,
    `echo.`,
    `node.exe agent.cjs fornecedores-upload`,
    `set EXIT=%ERRORLEVEL%`,
    `echo.`,
    `echo ============================================================`,
    `if "%EXIT%"=="0" (`,
    `  echo Upload OK. Idempotente: re-run nao duplica.`,
    `  echo.`,
    `  echo Validacao recomendada ^(do admin SPharm.MT^):`,
    `  echo   SELECT COUNT^(*^) FROM "FornecedorErpRef" WHERE "farmaciaId"=...`,
    `) else (`,
    `  echo Falhou com exit code %EXIT%. Ver mensagens acima.`,
    `)`,
    `echo ============================================================`,
    `echo.`,
    `pause`,
    `endlocal & exit /b %EXIT%`,
    ``,
  ].join("\r\n");
  fs.writeFileSync(
    path.join(DIST_ROOT, "run-fornecedores-upload.bat"),
    fornecedoresUploadBat,
    "utf8"
  );

  // ── Fase 1b.5/1b.6 — staging compras + devoluções fornecedor ─────
  // Quatro BATs. Pedem --from / --to interactivamente. dry-runs sem
  // confirmação. uploads pedem CONFIRMO (escrita real ao SaaS).

  const comprasDryRunBat = [
    `@echo off`,
    `REM SPharm.MT agent — compras-dry-run (interactivo)`,
    `REM Gerado por agent/build.mjs. Não editar manualmente.`,
    `setlocal`,
    ``,
    ...preamble,
    `echo.`,
    `echo ============================================================`,
    `echo   compras-dry-run`,
    `echo ============================================================`,
    `echo.`,
    `echo Fase 1b: le dbo.Recepcao + dbo.[Recepcao Detalhe] read-only.`,
    `echo Imprime: contagens, estados, reconciliacao per-header,`,
    `echo orphans locais (dbo.Stocks + dbo.Fornecedores), TOP 10. SEM POST.`,
    `echo.`,
    `echo Pre-requisitos:`,
    `echo   - run-test-connection.bat OK`,
    `echo   - run-fornecedores-upload.bat ja correu`,
    `echo.`,
    `echo Formato datas: YYYY-MM-DD`,
    `echo.`,
    `set "FROM="`,
    `set /p "FROM=Data inicial (--from): "`,
    `if "%FROM%"=="" ( echo --from vazio. Aborta. & pause & exit /b 1 )`,
    `set "TO="`,
    `set /p "TO=Data final   (--to)  : "`,
    `if "%TO%"=="" ( echo --to vazio. Aborta. & pause & exit /b 1 )`,
    `echo.`,
    `node.exe agent.cjs compras-dry-run --from %FROM% --to %TO%`,
    `set EXIT=%ERRORLEVEL%`,
    `echo.`,
    `echo ============================================================`,
    `if "%EXIT%"=="0" (`,
    `  echo Dry-run OK. Nada escrito ERP. Nada enviado SaaS.`,
    `  echo Proximo passo: run-compras-upload.bat ^(mesmo intervalo^)`,
    `) else (`,
    `  echo Falhou ^(exit %EXIT%^). Ver mensagens acima.`,
    `)`,
    `echo ============================================================`,
    `pause`,
    `endlocal & exit /b %EXIT%`,
    ``,
  ].join("\r\n");
  fs.writeFileSync(
    path.join(DIST_ROOT, "run-compras-dry-run.bat"),
    comprasDryRunBat,
    "utf8"
  );

  // Diagnostico de documentos de compra. Read-only, sem POST: pede os
  // Recepcao ID e despeja header, linhas, tabelas relacionadas e as
  // sequencias em falta. Existe como .bat porque o `--rec-deep` nao cabe
  // no wrapper de datas, e nao se pede a um tecnico que abra uma consola.
  const comprasInspectBat = [
    `@echo off`,
    `REM SPharm.MT agent - compras-dry-run --rec-deep (diagnostico)`,
    `REM Gerado por agent/build.mjs. Nao editar manualmente.`,
    `setlocal`,
    ``,
    ...preamble,
    `echo.`,
    `echo ============================================================`,
    `echo  DIAGNOSTICO DE DOCUMENTOS DE COMPRA`,
    `echo ============================================================`,
    `echo Read-only. NAO escreve no ERP e NAO envia nada para o SaaS.`,
    `echo.`,
    `echo Indica os Recepcao ID separados por virgula. Exemplo:`,
    `echo   58865,64250`,
    `echo.`,
    `set "IDS="`,
    `set /p "IDS=Recepcao IDs: "`,
    `if "%IDS%"=="" ( echo Nenhum ID indicado. Aborta. & pause & exit /b 1 )`,
    `if not exist logs mkdir logs`,
    `for /f "tokens=*" %%I in ('node.exe -e "process.stdout.write(new Date().toISOString().slice(0,10))"') do set "HOJE=%%I"`,
    `set "SAIDA=logs\\compras-inspect-%HOJE%.txt"`,
    `echo.`,
    `echo A analisar... a saida fica tambem em %SAIDA%`,
    `echo.`,
    `node.exe agent.cjs compras-dry-run --rec-deep %IDS% > "%SAIDA%" 2>&1`,
    `set EXIT=%ERRORLEVEL%`,
    `type "%SAIDA%"`,
    `echo.`,
    `echo ============================================================`,
    `if "%EXIT%"=="0" (`,
    `  echo Concluido. Envia o ficheiro %SAIDA%`,
    `) else (`,
    `  echo Falhou. Ver mensagens acima.`,
    `)`,
    `echo ============================================================`,
    `pause`,
    `endlocal & exit /b %EXIT%`,
    ``,
  ].join("\r\n");
  fs.writeFileSync(
    path.join(DIST_ROOT, "run-compras-inspect.bat"),
    comprasInspectBat,
    "utf8"
  );

  const comprasUploadBat = [
    `@echo off`,
    `REM SPharm.MT agent — compras-upload (interactivo + CONFIRMO)`,
    `REM Gerado por agent/build.mjs. Não editar manualmente.`,
    `setlocal`,
    ``,
    ...preamble,
    `echo.`,
    `echo ============================================================`,
    `echo   compras-upload — Fase 1b.5 INGEST REAL (staging)`,
    `echo ============================================================`,
    `echo.`,
    `echo Vai POSTar linhas de compra para a SaaS SPharm.MT:`,
    `echo   - UPSERT StagingCompraRawLine ^(staging-only, sem aggregation^)`,
    `echo   - Idempotente por ^(farmaciaId, externalLineId^)`,
    `echo   - HTTP timeout 120s ^(rev26 alinha com bootstrap-upload^)`,
    `echo.`,
    `echo NAO toca em Compra final, dashboard, vendas, export-orders.`,
    `echo Requer: ENABLE_AGENT_BOOTSTRAP=1 no SaaS.`,
    `echo.`,
    `echo Pre-requisitos:`,
    `echo   - run-compras-dry-run.bat OK e revisto`,
    `echo   - run-fornecedores-upload.bat concluido`,
    `echo   - SPHARMMT_FARMACIA configurado`,
    `echo.`,
    `echo Formato datas: YYYY-MM-DD`,
    `echo.`,
    `set "FROM="`,
    `set /p "FROM=Data inicial (--from): "`,
    `if "%FROM%"=="" ( echo --from vazio. & pause & exit /b 1 )`,
    `set "TO="`,
    `set /p "TO=Data final   (--to)  : "`,
    `if "%TO%"=="" ( echo --to vazio. & pause & exit /b 1 )`,
    `set "BATCH=200"`,
    `set /p "BATCH=Batch size [200]: "`,
    `if "%BATCH%"=="" set "BATCH=200"`,
    `echo.`,
    `echo --- CONFIRMACAO ---`,
    `echo Vai escrever em StagingCompraRawLine ^(SaaS^).`,
    `set "CONFIRM="`,
    `set /p "CONFIRM=Escreve CONFIRMO ^(em maiusculas^) para prosseguir: "`,
    `if not "%CONFIRM%"=="CONFIRMO" (`,
    `  echo.`,
    `  echo Confirmacao invalida. Aborta sem escrever.`,
    `  pause`,
    `  exit /b 1`,
    `)`,
    `echo.`,
    `node.exe agent.cjs compras-upload --from %FROM% --to %TO% --batch-size %BATCH%`,
    `set EXIT=%ERRORLEVEL%`,
    `echo.`,
    `echo ============================================================`,
    `if "%EXIT%"=="0" (`,
    `  echo Upload OK. Idempotente: re-run nao duplica.`,
    `) else (`,
    `  echo Falhou ^(exit %EXIT%^). Ver mensagens acima.`,
    `)`,
    `echo ============================================================`,
    `pause`,
    `endlocal & exit /b %EXIT%`,
    ``,
  ].join("\r\n");
  fs.writeFileSync(
    path.join(DIST_ROOT, "run-compras-upload.bat"),
    comprasUploadBat,
    "utf8"
  );

  // ── Block B — stocksmov-dry-run + stocksmov-upload (rev33) ────────
  // Canónico: StocksMov → MovimentoArtigo. Idempotente por StocksMovID.
  // Dry-run sem confirmação. Upload pede CONFIRMO + intervalo + since-id
  // opcional (catch-up incremental).

  const stocksmovDryRunBat = [
    `@echo off`,
    `REM SPharm.MT agent — stocksmov-dry-run (interactivo)`,
    `REM Gerado por agent/build.mjs. Não editar manualmente.`,
    `setlocal`,
    ``,
    ...preamble,
    `echo.`,
    `echo ============================================================`,
    `echo   stocksmov-dry-run — Block B1 (read-only, sem POST)`,
    `echo ============================================================`,
    `echo.`,
    `echo Le dbo.StocksMov + JOINs ^(Cab/Det/Motivo/Atendimento^) read-only.`,
    `echo Classifica localmente via lib/movimento-classifier.`,
    `echo Imprime distribuicao por tipo, top motivos, lista DESCONHECIDO`,
    `echo e cobertura ^(<1%% esperado^).`,
    `echo.`,
    `echo Pre-requisito: run-test-connection.bat OK.`,
    `echo.`,
    `echo Formato datas: YYYY-MM-DD`,
    `echo.`,
    `set "FROM="`,
    `set /p "FROM=Data inicial (--from): "`,
    `if "%FROM%"=="" ( echo --from vazio. Aborta. & pause & exit /b 1 )`,
    `set "TO="`,
    `set /p "TO=Data final   (--to)  : "`,
    `if "%TO%"=="" ( echo --to vazio. Aborta. & pause & exit /b 1 )`,
    `echo.`,
    `node.exe agent.cjs stocksmov-dry-run --from %FROM% --to %TO%`,
    `set EXIT=%ERRORLEVEL%`,
    `echo.`,
    `echo ============================================================`,
    `if "%EXIT%"=="0" (`,
    `  echo Dry-run OK. Nada escrito ERP. Nada enviado SaaS.`,
    `  echo Proximo passo: run-stocksmov-upload.bat ^(mesmo intervalo^)`,
    `) else (`,
    `  echo Falhou ^(exit %EXIT%^). Ver mensagens acima.`,
    `)`,
    `echo ============================================================`,
    `pause`,
    `endlocal & exit /b %EXIT%`,
    ``,
  ].join("\r\n");
  fs.writeFileSync(
    path.join(DIST_ROOT, "run-stocksmov-dry-run.bat"),
    stocksmovDryRunBat,
    "utf8"
  );

  const stocksmovUploadBat = [
    `@echo off`,
    `REM SPharm.MT agent — stocksmov-upload (interactivo + CONFIRMO)`,
    `REM Gerado por agent/build.mjs. Não editar manualmente.`,
    `setlocal`,
    ``,
    ...preamble,
    `echo.`,
    `echo ============================================================`,
    `echo   stocksmov-upload — Block B2 INGEST CANONICO`,
    `echo ============================================================`,
    `echo.`,
    `echo Vai POSTar StocksMov para a SaaS SPharm.MT:`,
    `echo   - UPSERT MovimentoArtigo ^(canonico, 1 row por StocksMovID^)`,
    `echo   - Snapshot raw em IngestStocksMovRaw ^(replay/auditoria^)`,
    `echo   - Idempotente por ^(farmaciaId, externalMovId^)`,
    `echo   - Paginacao por StocksMovID > since-id ^(chunks 50k SQL^)`,
    `echo.`,
    `echo NAO toca Venda, Compra, Devolucao, VendaMensal, AjusteStock.`,
    `echo NAO toca dashboard reads.`,
    `echo Requer: ENABLE_AGENT_BOOTSTRAP=1 no SaaS.`,
    `echo.`,
    `echo Pre-requisitos:`,
    `echo   - run-stocksmov-dry-run.bat OK e revisto`,
    `echo   - run-fornecedores-upload.bat ^(catalogo Fornecedor populado^)`,
    `echo   - SPHARMMT_FARMACIA configurado`,
    `echo.`,
    `echo Formato datas: YYYY-MM-DD`,
    `echo.`,
    `set "FROM="`,
    `set /p "FROM=Data inicial (--from): "`,
    `if "%FROM%"=="" ( echo --from vazio. & pause & exit /b 1 )`,
    `set "TO="`,
    `set /p "TO=Data final   (--to)  : "`,
    `if "%TO%"=="" ( echo --to vazio. & pause & exit /b 1 )`,
    `set "SINCE=0"`,
    `set /p "SINCE=Since StocksMovID [0]: "`,
    `if "%SINCE%"=="" set "SINCE=0"`,
    `set "BATCH=100"`,
    `set /p "BATCH=HTTP batch size [100]: "`,
    `if "%BATCH%"=="" set "BATCH=100"`,
    `echo.`,
    `echo --- CONFIRMACAO ---`,
    `echo Vai escrever em MovimentoArtigo + IngestStocksMovRaw ^(SaaS^).`,
    `set "CONFIRM="`,
    `set /p "CONFIRM=Escreve CONFIRMO ^(em maiusculas^) para prosseguir: "`,
    `if not "%CONFIRM%"=="CONFIRMO" (`,
    `  echo.`,
    `  echo Confirmacao invalida. Aborta sem escrever.`,
    `  pause`,
    `  exit /b 1`,
    `)`,
    `echo.`,
    `node.exe agent.cjs stocksmov-upload --from %FROM% --to %TO% --since-id %SINCE% --batch-size %BATCH%`,
    `set EXIT=%ERRORLEVEL%`,
    `echo.`,
    `echo ============================================================`,
    `if "%EXIT%"=="0" (`,
    `  echo Upload OK. Idempotente: re-run com mesmo intervalo nao duplica.`,
    `  echo MovimentoArtigo populado; verificar feature flag useMovimentosCanonical na farmacia.`,
    `) else (`,
    `  echo Falhou ^(exit %EXIT%^). Ver mensagens acima.`,
    `)`,
    `echo ============================================================`,
    `pause`,
    `endlocal & exit /b %EXIT%`,
    ``,
  ].join("\r\n");
  fs.writeFileSync(
    path.join(DIST_ROOT, "run-stocksmov-upload.bat"),
    stocksmovUploadBat,
    "utf8"
  );

  // stock-upload — upload SÓ de stock (snapshot), CONFIRMO, SEM datas.
  // Para repor/atualizar o stock de uma farmácia sem re-bootstrap completo.
  const stockUploadBat = [
    `@echo off`,
    `REM SPharm.MT agent — stock-upload (interactivo + CONFIRMO)`,
    `REM Gerado por agent/build.mjs. Não editar manualmente.`,
    `setlocal`,
    ``,
    ...preamble,
    `echo.`,
    `echo ============================================================`,
    `echo   stock-upload — UPLOAD SO DE STOCK (snapshot corrente)`,
    `echo ============================================================`,
    `echo.`,
    `echo Vai POSTar SO o stock para a SaaS SPharm.MT:`,
    `echo   - UPSERT ProdutoFarmacia ^(campos de stock^) por ^(produtoId, farmaciaId^)`,
    `echo   - Idempotente: re-run produz o mesmo estado`,
    `echo   - NAO envia products nem sales-lines`,
    `echo.`,
    `echo Requer: ENABLE_AGENT_BOOTSTRAP=1 no SaaS.`,
    `echo Pre-requisito: /bootstrap/products ja correu ^(resolucao produtoId^).`,
    `echo Usa a config actual do agent ^(SPHARMMT_FARMACIA^).`,
    `echo.`,
    `echo --- CONFIRMACAO ---`,
    `echo Vai escrever campos de stock em ProdutoFarmacia ^(SaaS^).`,
    `set "CONFIRM="`,
    `set /p "CONFIRM=Escreve CONFIRMO ^(em maiusculas^) para prosseguir: "`,
    `if not "%CONFIRM%"=="CONFIRMO" (`,
    `  echo.`,
    `  echo Confirmacao invalida. Aborta sem escrever.`,
    `  pause`,
    `  exit /b 1`,
    `)`,
    `echo.`,
    `node.exe agent.cjs stock-upload`,
    `set EXIT=%ERRORLEVEL%`,
    `echo.`,
    `echo ============================================================`,
    `if "%EXIT%"=="0" (`,
    `  echo Upload OK. Idempotente: re-run nao duplica.`,
    `) else (`,
    `  echo Falhou ^(exit %EXIT%^). Ver mensagens acima.`,
    `)`,
    `echo ============================================================`,
    `pause`,
    `endlocal & exit /b %EXIT%`,
    ``,
  ].join("\r\n");
  fs.writeFileSync(
    path.join(DIST_ROOT, "run-stock-upload.bat"),
    stockUploadBat,
    "utf8"
  );

  // products-upload — rev45. Upload SÓ de produtos (catalogo + IVA).
  // Sem datas (catalogo = snapshot). CONFIRMO. Batch 25 + retry+shrink.
  // Caso de uso: refresh ProdutoFarmacia.taxaIvaPercent sem mexer em
  // stock/vendas/agregações.
  const productsUploadBat = [
    `@echo off`,
    `REM SPharm.MT agent — products-upload (interactivo + CONFIRMO)`,
    `REM Gerado por agent/build.mjs. Não editar manualmente.`,
    `setlocal`,
    ``,
    ...preamble,
    `echo.`,
    `echo ============================================================`,
    `echo   products-upload — UPLOAD SO DE PRODUTOS (rev45)`,
    `echo ============================================================`,
    `echo.`,
    `echo Vai POSTar SO o catalogo de produtos para a SaaS SPharm.MT:`,
    `echo   - UPSERT Produto ^(catalogo global^)`,
    `echo   - UPSERT ProdutoFarmacia ^(PVP/PMC/PUC + taxaIvaPercent^)`,
    `echo   - Idempotente: re-run produz o mesmo estado`,
    `echo   - NAO envia stock, sales-lines, compras nem devolucoes`,
    `echo.`,
    `echo Comportamento ^(rev45^):`,
    `echo   - batch HTTP inicial = 25 ^(vs 50 do bootstrap-upload^)`,
    `echo   - retry + backoff 1s/2s/4s/8s em 502/503/504/timeout/cancel`,
    `echo   - shrink em metade ate floor 10 quando os retries esgotam`,
    `echo   - "Failed to cancel request in 5000ms" tratado como transient`,
    `echo.`,
    `echo Novo na rev46 - catalogo regulamentar do proprio ERP:`,
    `echo   - DCI, ATC, Grupo Homogeneo e Fabricante lidos de dbo.Stocks`,
    `echo   - colunas descobertas em runtime; ausente = NULL, nunca inventado`,
    `echo   - no fim mostra quantos campos entraram no catalogo central`,
    `echo   - nunca substitui dados de confianca igual ou superior`,
    `echo.`,
    `echo Requer: ENABLE_AGENT_BOOTSTRAP=1 no SaaS.`,
    `echo Pre-requisito 1: run-iva-audit.bat OK ^(confirma dbo.IVA master + JOIN^).`,
    `echo Pre-requisito 2: run-catalog-audit.bat OK ^(mostra que campos existem^).`,
    `echo Usa a config actual do agent ^(SPHARMMT_FARMACIA^).`,
    `echo.`,
    `echo --- CONFIRMACAO ---`,
    `echo Vai escrever no catalogo SaaS ^(Produto + ProdutoFarmacia^).`,
    `set "CONFIRM="`,
    `set /p "CONFIRM=Escreve CONFIRMO ^(em maiusculas^) para prosseguir: "`,
    `if not "%CONFIRM%"=="CONFIRMO" (`,
    `  echo.`,
    `  echo Confirmacao invalida. Aborta sem escrever.`,
    `  pause`,
    `  exit /b 1`,
    `)`,
    `echo.`,
    `node.exe agent.cjs products-upload`,
    `set EXIT=%ERRORLEVEL%`,
    `echo.`,
    `echo ============================================================`,
    `if "%EXIT%"=="0" (`,
    `  echo Upload OK. Idempotente: re-run nao duplica.`,
    `  echo Proximo passo: correr no SaaS:`,
    `  echo   npx tsx scripts/admin/recover-iva-produtos.ts --slug=^<tenant^> --apply`,
    `) else (`,
    `  echo Falhou ^(exit %EXIT%^). Ver mensagens acima.`,
    `)`,
    `echo ============================================================`,
    `pause`,
    `endlocal & exit /b %EXIT%`,
    ``,
  ].join("\r\n");
  fs.writeFileSync(
    path.join(DIST_ROOT, "run-products-upload.bat"),
    productsUploadBat,
    "utf8"
  );

  // full-sync — onboarding completo (produtos→...→agregações) numa execução.
  // Idempotente, retomável por fase. Pergunta --from/--to + flags de
  // agregação. UPLOAD pede CONFIRMO; DRY-RUN não escreve nada.
  const fullSyncDryRunBat = [
    `@echo off`,
    `REM SPharm.MT agent — full-sync --dry-run (onboarding preview)`,
    `REM Gerado por agent/build.mjs. Não editar manualmente.`,
    `setlocal`,
    ``,
    ...preamble,
    `echo.`,
    `echo ============================================================`,
    `echo   full-sync DRY-RUN — onboarding completo ^(preview^)`,
    `echo ============================================================`,
    `echo.`,
    `echo Corre TODAS as fases em modo preview ^(NAO escreve nada^):`,
    `echo   1 produtos  2 stock  3 vendas  4 fornecedores  5 compras`,
    `echo   6 devolucoes  7 agg VendaMensal  8 agg Compra  9 agg Devolucao`,
    `echo Ingest le o ERP sem POST; agregacoes correm com write=false.`,
    `echo.`,
    `set "FROM="`,
    `set /p "FROM=Data inicial (--from YYYY-MM-DD): "`,
    `if "%FROM%"=="" ( echo --from vazio. Aborta. & pause & exit /b 1 )`,
    `set "TO="`,
    `set /p "TO=Data final   (--to   YYYY-MM-DD): "`,
    `if "%TO%"=="" ( echo --to vazio. Aborta. & pause & exit /b 1 )`,
    `set "ALLOW="`,
    `set /p "ALLOW=Permitir UNKNOWN/orphans na agregacao VendaMensal? (SIM/nao): "`,
    `set "AGGFLAGS="`,
    `if /I "%ALLOW%"=="SIM" set "AGGFLAGS=--allow-unknowns --allow-orphans"`,
    `echo.`,
    `node.exe agent.cjs full-sync --dry-run --from %FROM% --to %TO% %AGGFLAGS%`,
    `set EXIT=%ERRORLEVEL%`,
    `echo.`,
    `echo ============================================================`,
    `if "%EXIT%"=="0" (`,
    `  echo Dry-run OK. Revê o relatorio acima. Depois: run-full-sync-upload.bat`,
    `) else (`,
    `  echo Falhou ^(exit %EXIT%^). Ver relatorio acima.`,
    `)`,
    `echo ============================================================`,
    `pause`,
    `endlocal & exit /b %EXIT%`,
    ``,
  ].join("\r\n");
  fs.writeFileSync(
    path.join(DIST_ROOT, "run-full-sync-dry-run.bat"),
    fullSyncDryRunBat,
    "utf8"
  );

  const fullSyncUploadBat = [
    `@echo off`,
    `REM SPharm.MT agent — full-sync (onboarding REAL, CONFIRMO)`,
    `REM Gerado por agent/build.mjs. Não editar manualmente.`,
    `setlocal`,
    ``,
    ...preamble,
    `echo.`,
    `echo ============================================================`,
    `echo   full-sync UPLOAD — onboarding completo ^(ESCREVE no SaaS^)`,
    `echo ============================================================`,
    `echo.`,
    `echo Corre TODAS as fases por ordem, idempotente, retomavel por fase:`,
    `echo   1 produtos  2 stock  3 vendas  4 fornecedores  5 compras`,
    `echo   6 devolucoes  7 agg VendaMensal  8 agg Compra  9 agg Devolucao`,
    `echo Fases ja concluidas sao saltadas ^(estado em run\\full-sync-state.json^).`,
    `echo Para repetir tudo: corre com --force a partir de uma janela cmd.`,
    `echo.`,
    `echo Requer: ENABLE_AGENT_BOOTSTRAP=1 no SaaS.`,
    `echo NAO toca dashboard, export-orders nem workers.`,
    `echo.`,
    `set "FROM="`,
    `set /p "FROM=Data inicial (--from YYYY-MM-DD): "`,
    `if "%FROM%"=="" ( echo --from vazio. Aborta. & pause & exit /b 1 )`,
    `set "TO="`,
    `set /p "TO=Data final   (--to   YYYY-MM-DD): "`,
    `if "%TO%"=="" ( echo --to vazio. Aborta. & pause & exit /b 1 )`,
    `set "ALLOW="`,
    `set /p "ALLOW=Permitir UNKNOWN/orphans na agregacao VendaMensal? (SIM/nao): "`,
    `set "AGGFLAGS="`,
    `if /I "%ALLOW%"=="SIM" set "AGGFLAGS=--allow-unknowns --allow-orphans"`,
    `echo.`,
    `echo --- CONFIRMACAO ---`,
    `echo Vai ESCREVER produtos/stock/vendas/fornecedores/compras/devolucoes`,
    `echo e agregar VendaMensal/Compra/Devolucao no SaaS ^(%FROM% a %TO%^).`,
    `set "CONFIRM="`,
    `set /p "CONFIRM=Escreve CONFIRMO ^(em maiusculas^) para prosseguir: "`,
    `if not "%CONFIRM%"=="CONFIRMO" (`,
    `  echo.`,
    `  echo Confirmacao invalida. Aborta sem escrever.`,
    `  pause`,
    `  exit /b 1`,
    `)`,
    `echo.`,
    `node.exe agent.cjs full-sync --from %FROM% --to %TO% %AGGFLAGS%`,
    `set EXIT=%ERRORLEVEL%`,
    `echo.`,
    `echo ============================================================`,
    `if "%EXIT%"=="0" (`,
    `  echo Full-sync OK. Idempotente: re-run salta fases DONE.`,
    `) else (`,
    `  echo Falhou ^(exit %EXIT%^). Corrige e re-corre — retoma a partir da fase que falhou.`,
    `)`,
    `echo ============================================================`,
    `pause`,
    `endlocal & exit /b %EXIT%`,
    ``,
  ].join("\r\n");
  fs.writeFileSync(
    path.join(DIST_ROOT, "run-full-sync-upload.bat"),
    fullSyncUploadBat,
    "utf8"
  );

  const devolucoesDryRunBat = [
    `@echo off`,
    `REM SPharm.MT agent — devolucoes-fornecedor-dry-run`,
    `REM Gerado por agent/build.mjs. Não editar manualmente.`,
    `setlocal`,
    ``,
    ...preamble,
    `echo.`,
    `echo ============================================================`,
    `echo   devolucoes-fornecedor-dry-run`,
    `echo ============================================================`,
    `echo.`,
    `echo Fase 1b: le dbo.Devolucao + dbo.[Devolucao Detalhe] read-only.`,
    `echo Imprime: contagens, estados P/E/R/X, reconciliacao,`,
    `echo orphans locais, TOP 10. SEM POST.`,
    `echo Filtro: DevolucaoSituacaoID^<^>'A' (anuladas excluidas no SQL).`,
    `echo.`,
    `set "FROM="`,
    `set /p "FROM=Data inicial (--from): "`,
    `if "%FROM%"=="" ( echo --from vazio. & pause & exit /b 1 )`,
    `set "TO="`,
    `set /p "TO=Data final   (--to)  : "`,
    `if "%TO%"=="" ( echo --to vazio. & pause & exit /b 1 )`,
    `echo.`,
    `node.exe agent.cjs devolucoes-fornecedor-dry-run --from %FROM% --to %TO%`,
    `set EXIT=%ERRORLEVEL%`,
    `echo.`,
    `echo ============================================================`,
    `if "%EXIT%"=="0" (`,
    `  echo Dry-run OK. Proximo passo: run-devolucoes-fornecedor-upload.bat`,
    `) else (`,
    `  echo Falhou ^(exit %EXIT%^).`,
    `)`,
    `echo ============================================================`,
    `pause`,
    `endlocal & exit /b %EXIT%`,
    ``,
  ].join("\r\n");
  fs.writeFileSync(
    path.join(DIST_ROOT, "run-devolucoes-fornecedor-dry-run.bat"),
    devolucoesDryRunBat,
    "utf8"
  );

  const devolucoesUploadBat = [
    `@echo off`,
    `REM SPharm.MT agent — devolucoes-fornecedor-upload (CONFIRMO)`,
    `REM Gerado por agent/build.mjs. Não editar manualmente.`,
    `setlocal`,
    ``,
    ...preamble,
    `echo.`,
    `echo ============================================================`,
    `echo   devolucoes-fornecedor-upload — Fase 1b.6 INGEST REAL`,
    `echo ============================================================`,
    `echo.`,
    `echo Vai POSTar linhas de devolucao AO fornecedor para a SaaS:`,
    `echo   - UPSERT StagingDevolucaoFornecedorRawLine ^(staging-only^)`,
    `echo   - Idempotente, captura transicao P -^> R`,
    `echo.`,
    `echo NAO toca em Devolucao final, dashboard, vendas, export-orders.`,
    `echo.`,
    `set "FROM="`,
    `set /p "FROM=Data inicial (--from): "`,
    `if "%FROM%"=="" ( echo --from vazio. & pause & exit /b 1 )`,
    `set "TO="`,
    `set /p "TO=Data final   (--to)  : "`,
    `if "%TO%"=="" ( echo --to vazio. & pause & exit /b 1 )`,
    `set "BATCH=200"`,
    `set /p "BATCH=Batch size [200]: "`,
    `if "%BATCH%"=="" set "BATCH=200"`,
    `echo.`,
    `echo --- CONFIRMACAO ---`,
    `set "CONFIRM="`,
    `set /p "CONFIRM=Escreve CONFIRMO para prosseguir: "`,
    `if not "%CONFIRM%"=="CONFIRMO" (`,
    `  echo Confirmacao invalida. Aborta. & pause & exit /b 1`,
    `)`,
    `echo.`,
    `node.exe agent.cjs devolucoes-fornecedor-upload --from %FROM% --to %TO% --batch-size %BATCH%`,
    `set EXIT=%ERRORLEVEL%`,
    `echo.`,
    `echo ============================================================`,
    `if "%EXIT%"=="0" (`,
    `  echo Upload OK. Idempotente.`,
    `) else (`,
    `  echo Falhou ^(exit %EXIT%^).`,
    `)`,
    `echo ============================================================`,
    `pause`,
    `endlocal & exit /b %EXIT%`,
    ``,
  ].join("\r\n");
  fs.writeFileSync(
    path.join(DIST_ROOT, "run-devolucoes-fornecedor-upload.bat"),
    devolucoesUploadBat,
    "utf8"
  );

  // inspect-product-identifiers — probe read-only para identificar a
  // coluna em dbo.Stocks que contém o CNP individual.
  // CodCNPEM é grupo homogéneo — NÃO serve para mapear produto.
  const inspectProductIdentifiersBat = [
    `@echo off`,
    `REM SPharm.MT agent — inspect-product-identifiers`,
    `REM Gerado por agent/build.mjs. Não editar manualmente.`,
    `setlocal`,
    ``,
    ...preamble,
    `echo.`,
    `echo ============================================================`,
    `echo   inspect-product-identifiers`,
    `echo ============================================================`,
    `echo.`,
    `echo Probe READ-ONLY para identificar a coluna em dbo.Stocks`,
    `echo que contem o CNP INDIVIDUAL ^(nao o grupo homogeneo CodCNPEM^).`,
    `echo.`,
    `echo Testa CNPs conhecidos contra colunas candidatas`,
    `echo ^(LIKE %%cnp%%/%%codigo%%/%%cnpem%%/%%barras%%/%%ean%%^).`,
    `echo.`,
    `echo Para passar CNPs alternativos:`,
    `echo   node.exe agent.cjs inspect-product-identifiers --cnps "6433359,5771464"`,
    `echo.`,
    `node.exe agent.cjs inspect-product-identifiers`,
    `set EXIT=%ERRORLEVEL%`,
    `echo.`,
    `echo ============================================================`,
    `if "%EXIT%"=="0" (`,
    `  echo Ficheiro gerado em:`,
    `  echo   output\\product-identifiers-^<YYYY-MM-DD^>\\inspection.md`,
    `  echo.`,
    `  echo IMPORTANTE: revalidar manualmente a coluna sugerida antes`,
    `  echo de a configurar como productLookupColumn em agent.config.json.`,
    `  echo NUNCA configurar CodCNPEM ^(grupo homogeneo^).`,
    `) else (`,
    `  echo Falhou ^(exit %EXIT%^). Verifica mensagens acima.`,
    `)`,
    `echo ============================================================`,
    `echo.`,
    `pause`,
    `endlocal & exit /b %EXIT%`,
    ``,
  ].join("\r\n");
  fs.writeFileSync(
    path.join(DIST_ROOT, "run-inspect-product-identifiers.bat"),
    inspectProductIdentifiersBat,
    "utf8"
  );

  // setup-orders-write-log — cria (idempotente) a tabela auxiliar de
  // idempotência. Pré-requisito para ordersWriteMode=insert. SEM prompts.
  // Tabela é EXCLUSIVAMENTE nossa (dbo.SPharmMT_OrderWriteLog) — não
  // toca em nenhuma coluna operacional do SPharm.
  const setupOrdersWriteLogBat = [
    `@echo off`,
    `REM SPharm.MT agent — setup-orders-write-log`,
    `REM Gerado por agent/build.mjs. Não editar manualmente.`,
    `setlocal`,
    ``,
    ...preamble,
    `echo.`,
    `echo ============================================================`,
    `echo   setup-orders-write-log`,
    `echo ============================================================`,
    `echo.`,
    `echo Cria ^(ou verifica^) a tabela auxiliar:`,
    `echo   dbo.SPharmMT_OrderWriteLog`,
    `echo.`,
    `echo Esta tabela e EXCLUSIVAMENTE do agent SPharm.MT.`,
    `echo NAO interfere com schema SPharm operacional.`,
    `echo NAO escreve em colunas existentes do SPharm.`,
    `echo.`,
    `echo Guarda mapeamento outboxId ^(SaaS^) -^> Encomenda ID ^(SPharm^)`,
    `echo para garantir idempotencia sem tocar em colunas como VVM_ID.`,
    `echo.`,
    `echo Pre-requisitos:`,
    `echo   - run-test-connection.bat OK`,
    `echo   - SQL login com permissao CREATE TABLE em dbo`,
    `echo     ^(se nao tiver, o comando imprime SQL para o DBA executar^)`,
    `echo.`,
    `node.exe agent.cjs setup-orders-write-log`,
    `set EXIT=%ERRORLEVEL%`,
    `echo.`,
    `echo ============================================================`,
    `if "%EXIT%"=="0" (`,
    `  echo Setup OK. Proximo passo: run-test-order-write.bat ^(dry-run^).`,
    `) else (`,
    `  echo Falhou ^(exit %EXIT%^). Ver mensagens acima.`,
    `  echo Se CREATE TABLE foi negado, segue o SQL impresso para o DBA.`,
    `)`,
    `echo ============================================================`,
    `pause`,
    `endlocal & exit /b %EXIT%`,
    ``,
  ].join("\r\n");
  fs.writeFileSync(
    path.join(DIST_ROOT, "run-setup-orders-write-log.bat"),
    setupOrdersWriteLogBat,
    "utf8"
  );

  // test-order-write — interactivo. DRY-RUN por defeito (rollback
  // automático). Operador pode escolher --commit para escrita real.
  // Pré-requisito: secção ordersInsert preenchida em agent.config.json
  // se quiser correr em modo insert.
  const testOrderWriteBat = [
    `@echo off`,
    `REM SPharm.MT agent — test-order-write (interactivo)`,
    `REM Gerado por agent/build.mjs. Não editar manualmente.`,
    `setlocal`,
    ``,
    ...preamble,
    `echo.`,
    `echo ============================================================`,
    `echo   test-order-write — smoke test de INSERT de encomenda`,
    `echo ============================================================`,
    `echo.`,
    `echo Cria UMA encomenda sintetica de teste no SPharm local.`,
    `echo Modo DRY-RUN por defeito: rollback automatico, nada permanente.`,
    `echo.`,
    `echo Pre-requisitos:`,
    `echo   - run-test-connection.bat OK`,
    `echo   - run-inspect-orders-schema.bat correu e admin validou`,
    `echo   - agent.config.json:`,
    `echo       * ordersWriteMode = "insert"  (para testar caminho real)`,
    `echo       * seccao ordersInsert preenchida com valores reais:`,
    `echo           userIdForInsert, fornecedorIdForOrders,`,
    `echo           armazemId, tipoEncomendaId,`,
    `echo           encomendaSituacaoInitial, idempotencyColumn`,
    `echo       * SQL login com db_datawriter ^(ou INSERT grant em`,
    `echo         dbo.Encomendas + dbo.[Encomendas Detalhe]^)`,
    `echo.`,
    `echo Formato CNP: 7-8 digitos (numerico, ex: 5440987)`,
    `echo.`,
    `set "CNP="`,
    `set /p "CNP=CNP de um produto existente em dbo.Stocks: "`,
    `if "%CNP%"=="" (`,
    `  echo CNP vazio. Aborta.`,
    `  pause`,
    `  exit /b 1`,
    `)`,
    `set "QTD=1"`,
    `set /p "QTD=Quantidade [1]: "`,
    `if "%QTD%"=="" set "QTD=1"`,
    `echo.`,
    `echo --- Modo ---`,
    `echo   1 ^) DRY-RUN  ^(default, rollback automatico, sem efeito permanente^)`,
    `echo   2 ^) COMMIT   ^(escrita REAL — encomenda fica visivel em SPharm^)`,
    `echo.`,
    `set "MODE=1"`,
    `set /p "MODE=Escolha [1]: "`,
    `if "%MODE%"=="" set "MODE=1"`,
    `set "FLAG=--dry-run"`,
    `if not "%MODE%"=="2" goto :EXEC`,
    `echo.`,
    `echo --- CONFIRMACAO ---`,
    `echo Vais ESCREVER 1 encomenda REAL em SPharm:`,
    `echo   CNP ^= %CNP%   Quantidade ^= %QTD%`,
    `echo.`,
    `echo Esta encomenda fica visivel imediatamente em SPharm UI`,
    `echo na lista de encomendas pendentes. Idempotente: re-run com`,
    `echo o mesmo outbox-id NAO duplica.`,
    `echo.`,
    `set "CONFIRM="`,
    `set /p "CONFIRM=Escreve CONFIRMO ^(em maiusculas^) para prosseguir: "`,
    `if not "%CONFIRM%"=="CONFIRMO" (`,
    `  echo.`,
    `  echo Confirmacao invalida. Aborta sem escrever.`,
    `  pause`,
    `  exit /b 1`,
    `)`,
    `set "FLAG=--commit"`,
    ``,
    `:EXEC`,
    `echo.`,
    `node.exe agent.cjs test-order-write --synthetic --cnp %CNP% --quantidade %QTD% %FLAG%`,
    `set EXIT=%ERRORLEVEL%`,
    `echo.`,
    `echo ============================================================`,
    `if not "%EXIT%"=="0" goto :FAIL`,
    `if "%FLAG%"=="--commit" goto :OKCOMMIT`,
    `echo DRY-RUN OK. Nada visivel em SPharm ^(rollback aplicado^).`,
    `echo O caminho de INSERT funciona end-to-end.`,
    `echo.`,
    `echo Para escrita real: re-corre este BAT e escolhe opcao 2.`,
    `goto :END`,
    ``,
    `:OKCOMMIT`,
    `echo COMMIT OK. Verifica em SPharm UI:`,
    `echo   - Lista de encomendas: nova entry com Encomenda ID mostrado acima`,
    `echo   - 1 linha com o CNP %CNP% e quantidade %QTD%`,
    `echo   - Estado = situacao inicial configurada em ordersInsert`,
    `echo.`,
    `echo Para validar idempotencia: re-run com --outbox-id mesmo id.`,
    `goto :END`,
    ``,
    `:FAIL`,
    `echo Falhou ^(exit code %EXIT%^). Verifica mensagens acima.`,
    `echo Causas comuns:`,
    `echo   - SQL login sem db_datawriter`,
    `echo   - CNP nao existe em dbo.Stocks`,
    `echo   - ordersInsert config incompleta`,
    `echo   - fornecedorIdForOrders/userIdForInsert apontam para IDs inexistentes`,
    ``,
    `:END`,
    `echo ============================================================`,
    `pause`,
    `endlocal & exit /b %EXIT%`,
    ``,
  ].join("\r\n");
  fs.writeFileSync(
    path.join(DIST_ROOT, "run-test-order-write.bat"),
    testOrderWriteBat,
    "utf8"
  );

  // Factory para wrappers que pedem --from/--to interactivamente
  const buildDatePromptBat = (command, intro) =>
    [
      `@echo off`,
      `REM SPharm.MT agent — ${command} (interactivo)`,
      `REM Gerado por agent/build.mjs. Não editar manualmente.`,
      `setlocal`,
      ``,
      ...preamble,
      `echo.`,
      `echo ============================================================`,
      `echo   ${command}`,
      `echo ============================================================`,
      `echo.`,
      ...intro.map((line) => `echo ${line}`),
      `echo.`,
      `echo Formato das datas: YYYY-MM-DD ^(ex.: 2026-04-01^)`,
      `echo.`,
      `set "FROM="`,
      `set /p "FROM=Data inicial (--from): "`,
      `if "%FROM%"=="" (`,
      `  echo.`,
      `  echo --from vazio. Aborta.`,
      `  echo.`,
      `  pause`,
      `  exit /b 1`,
      `)`,
      `set "TO="`,
      `set /p "TO=Data final   (--to)  : "`,
      `if "%TO%"=="" (`,
      `  echo.`,
      `  echo --to vazio. Aborta.`,
      `  echo.`,
      `  pause`,
      `  exit /b 1`,
      `)`,
      `echo.`,
      `node.exe agent.cjs ${command} --from %FROM% --to %TO%`,
      `set EXIT=%ERRORLEVEL%`,
      `echo.`,
      `pause`,
      `endlocal & exit /b %EXIT%`,
      ``,
    ].join("\r\n");

  fs.writeFileSync(
    path.join(DIST_ROOT, "run-sales-preview.bat"),
    buildDatePromptBat("sales-preview", [
      "Preview operacional de vendas - linha-a-linha (TOP 20).",
      "Junta dbo.Atendimento + dbo.Atendimento Detalhe + dbo.Stocks.",
      "Filtros: [Fim Venda]='S' AND [Data Venda] BETWEEN @from AND @to",
    ]),
    "utf8"
  );

  fs.writeFileSync(
    path.join(DIST_ROOT, "run-sales-summary-preview.bat"),
    buildDatePromptBat("sales-summary-preview", [
      "Caracterizacao semantica de vendas - agregado.",
      "Query 1: GROUP BY [Tipo Documento], [Entidade ID]",
      "Query 2: TOP 10 documentos por SUM([Valor_EUR]) DESC",
      "Mesmos filtros que sales-preview.",
    ]),
    "utf8"
  );

  fs.writeFileSync(
    path.join(DIST_ROOT, "run-bootstrap-dry-run.bat"),
    buildDatePromptBat("bootstrap-dry-run", [
      "Preview da 1a ingestao - payloads canonicos SPharm.MT.",
      "Tres pipelines: PRODUTOS, STOCK, VENDAS.",
      "Imprime contagens, amostras (TOP 10/20), metricas e alertas.",
      "SEM chamadas SaaS, SEM escrita em Neon, SEM bootstrap real.",
    ]),
    "utf8"
  );

  // Factory para wrappers que pedem --date interactivamente (single day)
  const buildSingleDatePromptBat = (command, intro) =>
    [
      `@echo off`,
      `REM SPharm.MT agent — ${command} (interactivo)`,
      `REM Gerado por agent/build.mjs. Não editar manualmente.`,
      `setlocal`,
      ``,
      ...preamble,
      `echo.`,
      `echo ============================================================`,
      `echo   ${command}`,
      `echo ============================================================`,
      `echo.`,
      ...intro.map((line) => `echo ${line}`),
      `echo.`,
      `echo Formato da data: YYYY-MM-DD ^(ex.: 2024-04-01^)`,
      `echo.`,
      `set "DT="`,
      `set /p "DT=Dia (--date): "`,
      `if "%DT%"=="" (`,
      `  echo --date vazio. Aborta.`,
      `  echo.`,
      `  pause`,
      `  exit /b 1`,
      `)`,
      `echo.`,
      `node.exe agent.cjs ${command} --date %DT%`,
      `set EXIT=%ERRORLEVEL%`,
      `echo.`,
      `pause`,
      `endlocal & exit /b %EXIT%`,
      ``,
    ].join("\r\n");

  fs.writeFileSync(
    path.join(DIST_ROOT, "run-daily-sync-dry-run.bat"),
    buildSingleDatePromptBat("daily-sync-dry-run", [
      "Dry-run do sync incremental diario. SEM escrita SaaS.",
      "Le do ERP apenas alteracoes no dia e imprime contagens + amostras.",
    ]),
    "utf8"
  );

  fs.writeFileSync(
    path.join(DIST_ROOT, "run-daily-sync.bat"),
    buildSingleDatePromptBat("daily-sync", [
      "Sync incremental diario — ESCREVE para a SaaS via /bootstrap/*.",
      "Idempotente: re-run do mesmo --date e seguro.",
      "Requer ENABLE_AGENT_BOOTSTRAP=1 no SaaS.",
      "Designed para rodar via Task Scheduler — SEM confirmacao explicita.",
    ]),
    "utf8"
  );

  // export-orders-auto — TASK SCHEDULER target.
  // Sem prompts. Output redirigido para logs/export-orders-<YYYY-MM-DD>.log.
  // Exit code do node propagado para que o Task Scheduler distinga sucesso/falha.
  // A data é calculada via node.exe (independente do locale de %DATE%).
  const exportOrdersAutoBat = [
    `@echo off`,
    `REM SPharm.MT agent — export-orders AUTO (Task Scheduler)`,
    `REM Gerado por agent/build.mjs. Não editar manualmente.`,
    `setlocal`,
    ``,
    `cd /d "%~dp0"`,
    `if not exist agent.config.json (`,
    `  echo ERRO: agent.config.json nao encontrado em %~dp0.`,
    `  exit /b 1`,
    `)`,
    `if not exist node.exe (`,
    `  echo ERRO: node.exe nao encontrado em %~dp0.`,
    `  exit /b 1`,
    `)`,
    `if not exist logs mkdir logs`,
    ``,
    `REM Data YYYY-MM-DD via node (sem dependencia de locale)`,
    `for /f "tokens=*" %%I in ('node.exe -e "process.stdout.write(new Date().toISOString().slice(0,10))"') do set "TODAY=%%I"`,
    `set "LOGFILE=logs\\export-orders-%TODAY%.log"`,
    ``,
    `echo. >> "%LOGFILE%"`,
    `echo === [%DATE% %TIME%] export-orders-auto START === >> "%LOGFILE%"`,
    `node.exe agent.cjs export-orders >> "%LOGFILE%" 2>&1`,
    `set EXIT=%ERRORLEVEL%`,
    `echo === [%DATE% %TIME%] export-orders-auto END (exit=%EXIT%) === >> "%LOGFILE%"`,
    ``,
    `if not "%EXIT%"=="0" (`,
    `  echo ERROR: export-orders retornou %EXIT% — ver %LOGFILE%`,
    `)`,
    `endlocal & exit /b %EXIT%`,
    ``,
  ].join("\r\n");
  fs.writeFileSync(
    path.join(DIST_ROOT, "run-export-orders-auto.bat"),
    exportOrdersAutoBat,
    "utf8"
  );

  // export-orders-once — manual interactivo. Mostra output em tempo real
  // + ainda assim escreve no log para forensics. pause no fim.
  const exportOrdersOnceBat = [
    `@echo off`,
    `REM SPharm.MT agent — export-orders ONCE (manual interactivo)`,
    `REM Gerado por agent/build.mjs. Não editar manualmente.`,
    `setlocal`,
    ``,
    ...preamble,
    `if not exist logs mkdir logs`,
    ``,
    `for /f "tokens=*" %%I in ('node.exe -e "process.stdout.write(new Date().toISOString().slice(0,10))"') do set "TODAY=%%I"`,
    `set "LOGFILE=logs\\export-orders-%TODAY%.log"`,
    ``,
    `echo.`,
    `echo ============================================================`,
    `echo   export-orders — execucao manual (1 passagem)`,
    `echo ============================================================`,
    `echo.`,
    `echo Vai correr 1 ciclo de export-orders:`,
    `echo   - GET pending no SaaS (lease atomico de ate 50)`,
    `echo   - writeOrderToSpharm por encomenda`,
    `echo   - ack/nack ao SaaS por resultado`,
    `echo.`,
    `echo Log gravado em: %LOGFILE%`,
    `echo (a janela mostra output em tempo real)`,
    `echo.`,
    `pause`,
    `echo.`,
    `echo === [%DATE% %TIME%] export-orders-once START === >> "%LOGFILE%"`,
    `node.exe agent.cjs export-orders`,
    `set EXIT=%ERRORLEVEL%`,
    `echo === [%DATE% %TIME%] export-orders-once END (exit=%EXIT%) === >> "%LOGFILE%"`,
    `echo.`,
    `echo ============================================================`,
    `if "%EXIT%"=="0" (`,
    `  echo Exit code: 0 ^(OK^)`,
    `) else (`,
    `  echo Exit code: %EXIT% ^(erro^)`,
    `)`,
    `echo Log: %LOGFILE%`,
    `echo ============================================================`,
    `echo.`,
    `pause`,
    `endlocal & exit /b %EXIT%`,
    ``,
  ].join("\r\n");
  fs.writeFileSync(
    path.join(DIST_ROOT, "run-export-orders-once.bat"),
    exportOrdersOnceBat,
    "utf8"
  );

  // daily-pipeline-auto — orquestrador autonomo (TASK SCHEDULER target).
  // Calcula ontem internamente. Sem prompt interactivo. Lockfile + logs locais.
  const dailyPipelineAutoBat = [
    `@echo off`,
    `REM SPharm.MT agent — daily-pipeline AUTO (Task Scheduler)`,
    `REM Gerado por agent/build.mjs. Não editar manualmente.`,
    `setlocal`,
    ``,
    ...preamble,
    `echo [%DATE% %TIME%] daily-pipeline-auto a arrancar...`,
    `node.exe agent.cjs daily-pipeline`,
    `set EXIT=%ERRORLEVEL%`,
    `if not "%EXIT%"=="0" (`,
    `  echo.`,
    `  echo ERROR: daily-pipeline retornou %EXIT%`,
    `  echo Consulta logs\\pipeline-*.log para detalhes.`,
    `)`,
    `endlocal & exit /b %EXIT%`,
    ``,
  ].join("\r\n");
  fs.writeFileSync(
    path.join(DIST_ROOT, "run-daily-pipeline-auto.bat"),
    dailyPipelineAutoBat,
    "utf8"
  );

  // bootstrap-upload — wrapper interactivo com CONFIRMAÇÃO explícita,
  // já que este comando ESCREVE para a SaaS (idempotente, mas real)
  const bootstrapUploadBat = [
    `@echo off`,
    `REM SPharm.MT agent — bootstrap-upload (interactivo, com confirmacao)`,
    `REM Gerado por agent/build.mjs. Não editar manualmente.`,
    `setlocal`,
    ``,
    ...preamble,
    `echo.`,
    `echo ============================================================`,
    `echo   bootstrap-upload — PRIMEIRA INGESTAO REAL`,
    `echo ============================================================`,
    `echo.`,
    `echo Este comando ESCREVE para a SaaS SPharm.MT.`,
    `echo  - upsert de produtos no catalogo`,
    `echo  - upsert de ProdutoFarmacia (precos + stock agregado)`,
    `echo  - insert/upsert de linhas de venda raw em staging`,
    `echo.`,
    `echo Idempotente: reupload do mesmo intervalo produz mesmo estado.`,
    `echo Mas: o feature flag ENABLE_AGENT_BOOTSTRAP deve estar a 1 no SaaS.`,
    `echo.`,
    `echo Pre-requisito: bootstrap-dry-run validado para este intervalo.`,
    `echo.`,
    `echo Formato das datas: YYYY-MM-DD ^(ex.: 2026-04-01^)`,
    `echo.`,
    `set "FROM="`,
    `set /p "FROM=Data inicial (--from): "`,
    `if "%FROM%"=="" (`,
    `  echo --from vazio. Aborta.`,
    `  echo.`,
    `  pause`,
    `  exit /b 1`,
    `)`,
    `set "TO="`,
    `set /p "TO=Data final   (--to)  : "`,
    `if "%TO%"=="" (`,
    `  echo --to vazio. Aborta.`,
    `  echo.`,
    `  pause`,
    `  exit /b 1`,
    `)`,
    `echo.`,
    `echo --- CONFIRMACAO ---`,
    `echo Vais correr bootstrap-upload --from %FROM% --to %TO%`,
    `echo Isto escreve dados na SaaS.`,
    `echo.`,
    `set "CONFIRM="`,
    `set /p "CONFIRM=Escreve CONFIRMO (em maiusculas) para prosseguir: "`,
    `if not "%CONFIRM%"=="CONFIRMO" (`,
    `  echo.`,
    `  echo Confirmacao invalida. Aborta sem escrever nada.`,
    `  echo.`,
    `  pause`,
    `  exit /b 1`,
    `)`,
    `echo.`,
    `node.exe agent.cjs bootstrap-upload --from %FROM% --to %TO%`,
    `set EXIT=%ERRORLEVEL%`,
    `echo.`,
    `pause`,
    `endlocal & exit /b %EXIT%`,
    ``,
  ].join("\r\n");
  fs.writeFileSync(path.join(DIST_ROOT, "run-bootstrap-upload.bat"), bootstrapUploadBat, "utf8");

  log(`  ✓ ${Object.keys(wrappers).length + 22} wrappers (probe-table + inspect-codigoid + inspect-orders-schema + inspect-compras-schema + inspect-compras-lookups + inspect-product-identifiers + fornecedores x2 + compras x2 + devolucoes-fornecedor x2 + setup-orders-write-log + test-order-write + export-orders auto/once + datas + daily-sync x2 + daily-pipeline-auto + bootstrap-upload + products-upload)`);
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
    `  run-discover.bat                Inspecionar schema ERP read-only (JSON+MD em output\\)`,
    `  run-discover-products.bat       Probe TOP 5 categoria=produtos (requer --table; mostra hint sem)`,
    `  run-discover-stock.bat          Probe TOP 5 categoria=stocks (requer --table; mostra hint sem)`,
    `  run-discover-sales.bat          Probe TOP 5 categoria=vendas (requer --table; mostra hint sem)`,
    `  run-probe-table.bat             Probe generico (PK/FKs/datas/TOP 5). Pergunta a tabela.`,
    `  run-products-preview.bat        PREVIEW TOP 20: Stocks + ArmazensStocks + Fornecedores`,
    `  run-stock-preview.bat           PREVIEW TOP 20: Stocks + ArmazensStocks + Armazens`,
    `  run-sales-preview.bat           PREVIEW TOP 20: Atendimento + Detalhe + Stocks. Pergunta datas.`,
    `  run-sales-summary-preview.bat   PREVIEW agregado por TipoDoc+EntidadeID + TOP 10 docs. Pergunta datas.`,
    `  run-bootstrap-dry-run.bat       DRY-RUN da 1a ingestao: payloads canonicos + counts + alerts. Pergunta datas.`,
    `  run-bootstrap-upload.bat        INGESTAO REAL para a SaaS. Pergunta datas E confirmacao explicita.`,
    `  run-catalog-audit.bat           (rev46) Auditoria READ-ONLY: localiza DCI, ATC, Grupo Homogeneo e Fabricante em dbo.Stocks e nas tabelas de lookup. Gera run\catalog-audit-<ts>.md. Correr ANTES de products-upload.`,
    `  run-products-upload.bat         (rev46) Upload SO de produtos -> /bootstrap/products. NAO envia stock/sales. Batch 25 + retry+shrink. CONFIRMO.`,
    `  run-stock-upload.bat            Upload SO de stock (snapshot) -> /bootstrap/stock. NAO envia products/sales. CONFIRMO.`,
    `  run-full-sync-dry-run.bat       ONBOARDING preview: corre TODAS as fases sem escrever. Pergunta datas.`,
    `  run-full-sync-upload.bat        ONBOARDING completo REAL: produtos->...->agregacoes. Idempotente, retomavel. CONFIRMO.`,
    `  run-daily-sync-dry-run.bat      Dry-run incremental para 1 dia. Sem POST.`,
    `  run-daily-sync.bat              Sync incremental diario — ESCREVE no SaaS. Pergunta --date.`,
    `  run-inspect-orders-schema.bat       Probe READ-ONLY ao schema das encomendas SPharm. Gera inspection.md.`,
    `  run-inspect-compras-schema.bat      Probe READ-ONLY ao schema de compras/recepcoes + devolucoes fornec. Gera inspection.md.`,
    `  run-inspect-compras-lookups.bat     Probe READ-ONLY focado: Fornecedores + Tipo Documento + amostras pos-corte + formulas + orphans.`,
    `  run-fornecedores-dry-run.bat        Fase 1a: le dbo.Fornecedores + LEFT JOIN Tbl_Tipo_Fornecedores. Sumario + TOP 10. SEM POST.`,
    `  run-fornecedores-upload.bat         Fase 1a: POST a /api/ingest/v1/bootstrap/fornecedores. Idempotente. Confirmacao explicita.`,
    `  run-compras-dry-run.bat             Fase 1b: le dbo.Recepcao + dbo.[Recepcao Detalhe]. Reconciliacao + orphans. SEM POST.`,
    `  run-compras-inspect.bat         Diagnostico read-only de documentos de compra.`,
    `  run-compras-upload.bat              Fase 1b: POST a /api/ingest/v1/bootstrap/compras (StagingCompraRawLine). CONFIRMO.`,
    `  run-devolucoes-fornecedor-dry-run.bat  Fase 1b: le dbo.Devolucao + dbo.[Devolucao Detalhe]. Estados P/E/R/X. SEM POST.`,
    `  run-devolucoes-fornecedor-upload.bat   Fase 1b: POST a /api/ingest/v1/bootstrap/devolucoes-fornecedor. CONFIRMO.`,
    `  run-stocksmov-dry-run.bat           Block B1: le dbo.StocksMov + classifica local. Sumario por tipo + DESCONHECIDO. SEM POST.`,
    `  run-stocksmov-upload.bat            Block B2: POST a /api/ingest/v1/movimentos. Canonico MovimentoArtigo. Idempotente. CONFIRMO.`,
    `  run-inspect-product-identifiers.bat Probe READ-ONLY: descobre a coluna em dbo.Stocks com o CNP (NAO usar CodCNPEM).`,
    `  run-setup-orders-write-log.bat      Cria dbo.SPharmMT_OrderWriteLog (tabela auxiliar de idempotencia). PRE-REQUISITO para insert.`,
    `  run-test-order-write.bat        Smoke test de INSERT de encomenda. DRY-RUN default; opcao 2 = COMMIT.`,
    `  run-export-orders-auto.bat      Task Scheduler: 1 ciclo de export-orders. Log em logs\\export-orders-*.log.`,
    `  run-export-orders-once.bat      Execucao manual interactiva (pause no fim).`,
    `  run-health.bat                  Diagnostico verboso`,
    `  INSTALL_WINDOWS.md              Guia passo a passo`,
    `  SECURITY.md                     Checklist de seguranca`,
    `  output\\                         Onde discover deposita ficheiros (JSON+MD)`,
    `  logs\\                           Reservado para sync futuro`,
    ``,
    `Probes dirigidos (rev2 — 2026-05-13):`,
    `  · A heuristica do discover acerta umas vezes e outras nao. Os 3`,
    `    discover-* requerem --table explicito. Sem --table, mostram a lista`,
    `    de candidatos detectados (ranked) como hint — nao escolhem.`,
    `  · Para tabelas dirigidas (dbo.Stocks, dbo.ArmazensStocks, dbo.Atendimento, etc.)`,
    `    usa run-probe-table.bat — pergunta a tabela e dumpa PK/FKs/datas/TOP 5.`,
    `  · Lêem TOP 5 linhas read-only. Nao escrevem nada em disco.`,
    ``,
    `Previews operacionais (rev3+ — 2026-05-13):`,
    `  · run-products-preview.bat       Stocks + ArmazensStocks + Fornecedores  (TOP 20)`,
    `  · run-stock-preview.bat          Stocks + ArmazensStocks + Armazens      (TOP 20)`,
    `  · run-sales-preview.bat          Atendimento + Detalhe + Stocks          (TOP 20)`,
    `  · run-sales-summary-preview.bat  Agregado por TipoDoc + EntidadeID + TOP 10 docs`,
    `  · run-bootstrap-dry-run.bat      DRY-RUN da 1a ingestao - payloads canonicos`,
    `                                   Pergunta --from e --to em formato YYYY-MM-DD.`,
    `                                   Hardcoded: [Fim Venda]='S'.`,
    `                                   [Tipo Documento] no SELECT para caracterizacao`,
    `                                   de tipos tecnicos.`,
    `  · Todos sao read-only. TOP 5/10/20. Nao escrevem nada em disco.`,
    `  · Output fica visivel na janela cmd — copia o bloco antes de fechar.`,
    `  · Operador precisa de janela cmd com >= 180 chars de largura`,
    `    (clica direito na barra do cmd > Propriedades > Esquema).`,
    ``,
    `Para passar --table sem editar o .bat, abre cmd na pasta e corre:`,
    `  node.exe agent.cjs probe-table --table "dbo.Stocks"`,
    `  node.exe agent.cjs probe-table --table "dbo.Atendimento Detalhe"`,
    `  node.exe agent.cjs sales-preview --from 2026-04-01 --to 2026-05-12`,
    ``,
  ].join("\r\n");
  fs.writeFileSync(path.join(DIST_ROOT, "README.txt"), readme, "utf8");
}

// ── Artefacto base único da release ──────────────────────────────────
// Zipa dist-agent/SPharmMT-Agent/ num único spharmmt-agent-base-rev<N>.zip.
// Este é o ÚNICO artefacto a publicar em storage por release; o Admin
// Wizard (STANDALONE) descarrega-o e injecta o agent.config.json por
// farmácia localmente. NÃO contém dados de tenant/farmácia — só o
// runtime/template comum (inclui agent.config.example.json, não o real).
function zipBase() {
  const zipName = `spharmmt-agent-base-rev${AGENT_REV}.zip`;
  const zipPath = path.join(REPO_ROOT, "dist-agent", zipName);
  // Defensivo: o artefacto base NUNCA pode conter config real de tenant.
  const stray = path.join(DIST_ROOT, "agent.config.json");
  if (fs.existsSync(stray)) fs.rmSync(stray);
  if (fs.existsSync(zipPath)) fs.rmSync(zipPath);
  log(`A criar artefacto base da release → dist-agent/${zipName}…`);
  if (process.platform === "win32") {
    const psCmd = `Compress-Archive -Path '${DIST_ROOT}\\*' -DestinationPath '${zipPath}' -Force`;
    execSync(`powershell -NoProfile -NonInteractive -Command "${psCmd}"`, {
      stdio: ["ignore", "pipe", "pipe"],
    });
  } else {
    // Unix: zip -r com conteudo na raiz do zip.
    execSync(`zip -r ${JSON.stringify(zipPath)} .`, {
      cwd: DIST_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  const stat = fs.statSync(zipPath);
  log(`  ✓ ${zipName} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
  return { zipName, zipPath };
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
    const base = zipBase();
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
    log(`✓ Artefacto base da release: dist-agent/${base.zipName}`);
    log("Próximos passos (uma vez por release):");
    // A plataforma é self-hosted. O ZIP é servido pelo próprio nginx, no
    // domínio administrativo, com nome de ficheiro ESTÁVEL: a revisão vive
    // dentro do pacote e nunca no URL. Não há nada a configurar por
    // release — o AGENT_BASE_ZIP_URL é gerado pelo install-platform.sh e
    // não muda.
    log(`  1. Copiar para a VPS:`);
    log(`       scp dist-agent/${base.zipName} deploy@<vps>:/tmp/`);
    log(`  2. Instalar com o nome ESTÁVEL (substitui a revisão anterior):`);
    log(`       sudo install -m 0644 -o deploy -g spharmmt /tmp/${base.zipName} /opt/spharmmt/agent-base/spharmmt-agent-base.zip`);
    log(`  3. O Admin Wizard (STANDALONE) gera os ZIPs por farmácia sozinho.`);
  } catch (err) {
    logErr(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();
