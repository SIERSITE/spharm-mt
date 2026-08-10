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
 * SELF-HOSTED: com `--dest`, o ZIP é escrito num directório local em vez
 * de ir para a Vercel. Na VPS esse directório é servido pelo nginx em
 * /agent-base/ — e assim instalar uma farmácia deixa de depender de
 * object storage externo. O token do Blob passa a ser preciso apenas
 * para quem publica na Vercel.
 *
 *   npm run agent:publish-base -- --dest /opt/spharmmt/agent-base
 *
 * Uso (self-hosted — o caminho normal):
 *   npm run agent:publish-base -- --dest /opt/spharmmt/agent-base
 *
 *   # ou ficheiro explícito
 *   npm run agent:publish-base -- --file dist-agent/spharmmt-agent-base-rev46.zip --dest /opt/spharmmt/agent-base
 *
 * Publicar na Vercel Blob exige --blob explícito. A plataforma de
 * produção é self-hosted e não deve depender de object storage externo.
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
import {
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
  writeFileSync,
  renameSync,
  chmodSync,
} from "node:fs";
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
    options: {
      file: { type: "string" },
      // Modo self-hosted: em vez de enviar para a Vercel Blob, escreve o
      // ZIP num directório local — tipicamente
      // /opt/spharmmt/agent-base, que o nginx serve em /agent-base/.
      // Não é um comando novo: é o mesmo `agent:publish-base` com outro
      // destino, para que exista UM sítio onde se publica o agent.
      dest: { type: "string" },
      // Publicar na Vercel Blob. Explícito de propósito — ver nota abaixo.
      blob: { type: "boolean", default: false },
      // Nome com que fica no destino. O default é estável de propósito:
      // a configuração (AGENT_BASE_ZIP_URL) não muda a cada revisão, e a
      // revisão fica registada dentro do próprio pacote.
      as: { type: "string" },
    },
    strict: true,
  });

  // ── Publicação local (VPS) ──────────────────────────────────────────
  if (values.dest) {
    const zipPath = resolveZipPath(values.file);
    const destDir = path.resolve(values.dest);
    if (!existsSync(destDir) || !statSync(destDir).isDirectory()) {
      fail(`--dest não é um directório existente: ${destDir}`);
    }
    const targetName = values.as ?? "spharmmt-agent-base.zip";
    if (!/^[A-Za-z0-9._-]+\.zip$/.test(targetName)) {
      // O nginx só serve /agent-base/<nome>.zip com este alfabeto; um
      // nome fora dele ficaria publicado e inalcançável.
      fail(`--as inválido: "${targetName}". Só [A-Za-z0-9._-] e terminar em .zip`);
    }
    const target = path.join(destDir, targetName);
    const sizeMB = statSync(zipPath).size / 1024 / 1024;

    console.log("─".repeat(72));
    console.log("publish-agent-base → directório local (self-hosted)");
    console.log("─".repeat(72));
    console.log(`  origem  : ${path.relative(process.cwd(), zipPath)} (${sizeMB.toFixed(1)} MB)`);
    console.log(`  destino : ${target}`);

    // Escrita atómica: um ficheiro temporário no MESMO directório e
    // depois rename. Sem isto, quem descarregasse durante a cópia
    // apanhava um ZIP truncado — e o erro apareceria na farmácia, ao
    // extrair, não aqui.
    const tmp = `${target}.tmp-${process.pid}`;
    writeFileSync(tmp, readFileSync(zipPath));
    renameSync(tmp, target);
    // 0644: o nginx corre como uid 101 e tem de o ler.
    chmodSync(target, 0o644);

    console.log("");
    console.log("✓ Publicado localmente");
    console.log(`  Servido em : <PUBLIC_APP_URL>/agent-base/${targetName}`);
    console.log(`  Confirmar  : curl -sI <PUBLIC_APP_URL>/agent-base/${targetName}`);
    return;
  }

  // ── Publicação na Vercel Blob ───────────────────────────────────────
  //
  // A plataforma de produção é self-hosted. O ZIP base do agent é servido
  // pelo nginx em https://admin.spharmmt.com/agent-base/, e o
  // AGENT_BASE_ZIP_URL é gerado pelo install-platform.sh — não há nada a
  // configurar por release.
  //
  // Este caminho já foi o default, e por isso foi corrido duas vezes por
  // engano depois de a plataforma ter deixado de usar a Vercel. Passa a
  // exigir `--blob` explícito: um erro de memória deixa de bastar para
  // reintroduzir uma dependência externa na arquitectura.
  if (!values.blob) {
    fail(
      [
        "publicar na Vercel Blob exige --blob explicito.",
        "",
        "  A plataforma e self-hosted. Para publicar o agent base:",
        "",
        "    scp dist-agent/spharmmt-agent-base-rev<N>.zip deploy@<vps>:/tmp/",
        "    sudo install -m 0644 -o deploy -g spharmmt \\",
        "      /tmp/spharmmt-agent-base-rev<N>.zip \\",
        "      /opt/spharmmt/agent-base/spharmmt-agent-base.zip",
        "",
        "  Ou, com acesso ao directorio montado:",
        "    npm run agent:publish-base -- --dest /opt/spharmmt/agent-base",
        "",
        "  O nome do ficheiro e ESTAVEL: a revisao vive dentro do pacote,",
        "  nunca no URL.",
      ].join("\n"),
    );
  }

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
