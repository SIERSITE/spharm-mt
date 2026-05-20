/**
 * scripts/admin/upload-agent-base.ts
 *
 * Tooling de release/admin: publica o artefacto base único do agent
 * (dist-agent/spharmmt-agent-base-rev<N>.zip) em Vercel Blob Storage e
 * imprime a URL pública para usar em AGENT_BASE_ZIP_URL.
 *
 * Porquê Blob (e não GitHub Releases): o base tem ~27 MB e o anexo de
 * release do GitHub via API tem limites/atritos; o Blob serve ficheiros
 * grandes com URL pública estável e é o storage oficial do SaaS (Vercel).
 *
 * Upload directo do Node para o Blob (com o RW token) — NÃO passa por
 * função serverless, logo não há limite de 4.5 MB. Suporta multipart.
 *
 * Uso:
 *   # auto-detecta o único spharmmt-agent-base-rev*.zip em dist-agent/
 *   npm run agent:publish-base
 *
 *   # ou ficheiro explícito
 *   npm run agent:publish-base -- --file dist-agent/spharmmt-agent-base-rev26.zip
 *
 * Env:
 *   BLOB_READ_WRITE_TOKEN   token RW do Blob store (vercel_blob_rw_...).
 *                           Vercel → Storage → (Blob store) → tokens, ou
 *                           `vercel env pull` / .env local.
 *
 * NÃO toca em dashboard/ingest/export-orders. Só tooling.
 */

import "dotenv/config";
import { parseArgs } from "node:util";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { put } from "@vercel/blob";

const BASE_RE = /^spharmmt-agent-base-rev\d+\.zip$/;
const BLOB_PREFIX = "agent-base";

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function resolveZipPath(explicit?: string): string {
  if (explicit) {
    const p = path.resolve(explicit);
    if (!existsSync(p)) fail(`ficheiro não encontrado: ${p}`);
    return p;
  }
  const distDir = path.join(process.cwd(), "dist-agent");
  if (!existsSync(distDir)) {
    fail("dist-agent/ não existe. Corre primeiro 'npm run agent:package'.");
  }
  const matches = readdirSync(distDir).filter((f) => BASE_RE.test(f));
  if (matches.length === 0) {
    fail(
      "nenhum spharmmt-agent-base-rev*.zip em dist-agent/. " +
        "Corre 'npm run agent:package' para o gerar."
    );
  }
  if (matches.length > 1) {
    fail(
      `vários artefactos base encontrados (${matches.join(", ")}). ` +
        "Indica qual com --file dist-agent/<nome>.zip."
    );
  }
  return path.join(distDir, matches[0]);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { file: { type: "string" } },
    strict: true,
  });

  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    fail(
      "BLOB_READ_WRITE_TOKEN em falta.\n" +
        "  Vercel → Storage → (cria/abre um Blob store) → .env.local / tokens,\n" +
        "  ou `vercel env pull .env.local`. Depois define no shell ou .env:\n" +
        "    BLOB_READ_WRITE_TOKEN=vercel_blob_rw_xxx"
    );
  }

  const zipPath = resolveZipPath(values.file);
  const fileName = path.basename(zipPath);
  const sizeMB = statSync(zipPath).size / 1024 / 1024;
  const blobPath = `${BLOB_PREFIX}/${fileName}`;

  console.log("─".repeat(72));
  console.log("upload-agent-base → Vercel Blob");
  console.log("─".repeat(72));
  console.log(`  ficheiro : ${path.relative(process.cwd(), zipPath)} (${sizeMB.toFixed(1)} MB)`);
  console.log(`  blob path: ${blobPath}`);
  console.log(`  a enviar...`);

  const body = readFileSync(zipPath);
  const result = await put(blobPath, body, {
    access: "public",
    token,
    contentType: "application/zip",
    addRandomSuffix: false, // URL estável (mesmo nome → mesma URL)
    allowOverwrite: true, // permite re-publicar a mesma rev
    multipart: true, // robusto para ficheiros grandes
  });

  console.log("");
  console.log("✓ Upload concluído");
  console.log(`  URL pública : ${result.url}`);
  console.log("");
  console.log("Configurar no Vercel (Settings → Environment Variables) + Redeploy:");
  console.log(`  AGENT_BASE_ZIP_URL=${result.url}`);
}

main().catch((err) => {
  console.error("[fatal]", err instanceof Error ? err.message : err);
  process.exit(1);
});
