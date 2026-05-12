/**
 * scripts/admin/create-client.ts
 *
 * CLI thin: parse de flags, chama `lib/admin/create-client-workflow.ts`,
 * imprime output accionável. Toda a lógica de negócio vive no workflow
 * — este ficheiro só formata input/output.
 *
 * Uso (Neon — auto-detect):
 *   npm run tenant:create -- \
 *     --slug=farmacias-braga \
 *     --nome="Grupo Farmácias de Braga" \
 *     --admin-email=admin@braga.pt \
 *     --farmacias="Farmácia Central,Farmácia Norte"
 *
 * Uso (manual URL):
 *   npm run tenant:create -- --provider=manual \
 *     --database-url="postgresql://USER:PASS@HOST/DB?sslmode=require" \
 *     --slug=... --nome="..." --admin-email=...
 *
 * Uso (dry-run):
 *   npm run tenant:create -- --slug=test --nome="X" --admin-email=a@b.pt --dry-run
 *
 * Output em texto (default) ou JSON (`--json` — útil para piping):
 *   · admin password mostrada UMA VEZ
 *   · ingest key mostrada UMA VEZ
 *   · checklist de próximos passos (instalação agent etc.)
 */

import "dotenv/config";
import { parseArgs } from "node:util";
import { controlPrisma } from "@/lib/control-plane";
import {
  createClient,
  type CreateClientInput,
  type CreateClientResult,
  type Reporter,
} from "@/lib/admin/create-client-workflow";
import type { ProviderKind } from "@/lib/db-providers";
import { requireControlEnv } from "../tenancy/_shared";

function buildReporter(quiet: boolean): Reporter {
  if (quiet) {
    return { step: () => {}, info: () => {}, warn: () => {} };
  }
  return {
    step: (name) => console.log(`▶ ${name}`),
    info: (msg) => console.log(`  ${msg}`),
    warn: (msg) => console.warn(`  ⚠ ${msg}`),
  };
}

function printTextResult(r: CreateClientResult): void {
  console.log("");
  if (r.ok && r.step === "done") {
    console.log("─".repeat(72));
    console.log(`✓ Tenant "${r.slug}" provisionado (${(r.durationMs / 1000).toFixed(1)}s)`);
    console.log("─".repeat(72));
    console.log(`  Provider       : ${r.provider}`);
    console.log(`  Tenant id      : ${r.tenantId}`);
    console.log(`  Schema version : ${r.schemaVersion ?? "—"}`);
    console.log(`  Smoke          : ${r.smokeOk ? "OK" : "FAIL"}`);
    console.log("");
    console.log("─".repeat(72));
    console.log("CREDENCIAIS — MOSTRADAS UMA VEZ (anotar AGORA, não recuperáveis)");
    console.log("─".repeat(72));
    console.log(`  Admin email    : ${r.adminEmail}`);
    console.log(`  Admin password : ${r.adminPassword}`);
    console.log(`  Ingest key     : ${r.ingestKey}`);
    if (r.farmaciasCreated && r.farmaciasCreated.length > 0) {
      console.log("");
      console.log(`  Farmácias criadas (${r.farmaciasCreated.length}):`);
      for (const f of r.farmaciasCreated) {
        console.log(`    · ${f.nome.padEnd(40)}  id=${f.id}`);
      }
    } else {
      console.log("");
      console.log(`  Farmácias      : nenhuma — usa o admin UI para adicionar`);
    }
    console.log("");
    console.log("─".repeat(72));
    console.log("Próximos passos");
    console.log("─".repeat(72));
    console.log(`  1. Comunicar ao admin do cliente:`);
    console.log(`       email: ${r.adminEmail}`);
    console.log(`       password: ${r.adminPassword}  (mudança forçada no primeiro login)`);
    console.log(`       URL: https://${r.slug}.spharmmt.app  (ou o teu domínio)`);
    console.log("");
    console.log(`  2. Configurar o local agent na farmácia (futuro PR 3):`);
    console.log(`       SPHARMMT_ENDPOINT=https://app.spharmmt.app`);
    console.log(`       SPHARMMT_TENANT_SLUG=${r.slug}`);
    console.log(`       SPHARMMT_INGEST_KEY=${r.ingestKey}`);
    console.log("");
    console.log(`  3. Validar conectividade do agent:`);
    console.log(`       curl -X POST -H "Authorization: Bearer <key>" \\`);
    console.log(`            -H "X-Tenant-Slug: ${r.slug}" \\`);
    console.log(`            https://<endpoint>/api/outbox/v1/heartbeat`);
    console.log("");
    return;
  }
  // Falha ou dry-run
  if (r.ok && r.step === "dry-run-done") {
    console.log("─".repeat(72));
    console.log(`[dry-run] OK — plano validado, nenhum side-effect.`);
    console.log("─".repeat(72));
    console.log(`  slug      : ${r.slug}`);
    console.log(`  provider  : ${r.provider ?? "—"}`);
    console.log(`  duration  : ${r.durationMs}ms`);
    return;
  }
  // Falha
  console.error("─".repeat(72));
  console.error(`✗ create-client falhou no step: ${r.step}`);
  console.error("─".repeat(72));
  console.error(`  slug   : ${r.slug}`);
  if (r.provider) console.error(`  provider: ${r.provider}`);
  console.error(`  erro   : ${r.error ?? "(sem mensagem)"}`);
  if (r.rollbackStatus) {
    console.error(`  rollback: ${r.rollbackStatus}`);
  }
  if (r.failedTenantId) {
    console.error(`  tenant id: ${r.failedTenantId}  (FAILED no control plane)`);
  }
  if (r.manualActions && r.manualActions.length > 0) {
    console.error("");
    console.error("  Acções manuais necessárias:");
    for (const m of r.manualActions) console.error(`    · ${m}`);
  }
}

function printJsonResult(r: CreateClientResult): void {
  // Imprime tudo — caller responsável por não logar este JSON em sítios
  // partilhados (contém password + ingest key em claro).
  console.log(JSON.stringify(r, null, 2));
}

function parseProviderKind(raw: string | undefined): ProviderKind | undefined {
  if (!raw) return undefined;
  if (raw === "neon" || raw === "manual" || raw === "local") return raw;
  throw new Error(`--provider inválido: "${raw}". Usa neon|manual|local.`);
}

async function main() {
  requireControlEnv();

  const { values } = parseArgs({
    options: {
      slug: { type: "string" },
      nome: { type: "string" },
      "admin-email": { type: "string" },
      "admin-password": { type: "string" },
      "admin-nome": { type: "string" },
      farmacias: { type: "string" },
      region: { type: "string" },
      provider: { type: "string" },
      "database-url": { type: "string" },
      "create-db": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      quiet: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  const slug = values.slug;
  const nome = values.nome;
  const adminEmail = values["admin-email"];

  if (!slug || !nome || !adminEmail) {
    console.error(
      'Uso: --slug X --nome "Y" --admin-email E [outros]\n' +
        '  Provider (escolhe um): --provider=neon|manual|local | --database-url "..." | --create-db\n' +
        '  Farmácias iniciais  : --farmacias "Nome A,Nome B,Nome C"\n' +
        '  Senha admin         : --admin-password XXX  (omite para gerar)\n' +
        '  Outros              : --admin-nome "Nome", --region eu-west-2, --dry-run, --json, --quiet'
    );
    process.exit(1);
    return;
  }

  let providerKind: ProviderKind | undefined;
  try {
    providerKind = parseProviderKind(values.provider);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
    return;
  }

  const farmacias = values.farmacias
    ? values.farmacias.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;

  const input: CreateClientInput = {
    slug,
    nome,
    adminEmail,
    adminNome: values["admin-nome"],
    adminPassword: values["admin-password"],
    farmacias,
    region: values.region,
    provider: providerKind,
    databaseUrl: values["database-url"],
    createDb: values["create-db"],
    dryRun: values["dry-run"],
    reporter: buildReporter(!!values.quiet || !!values.json),
  };

  const result = await createClient(input);

  if (values.json) {
    printJsonResult(result);
  } else {
    printTextResult(result);
  }

  await controlPrisma.$disconnect();
  process.exit(result.ok ? 0 : 1);
}

main().catch(async (err) => {
  console.error("[fatal]", err instanceof Error ? err.message : err);
  try {
    await controlPrisma.$disconnect();
  } catch {}
  process.exit(1);
});
