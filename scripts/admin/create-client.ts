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

/**
 * URL público da plataforma, sem barra final. Mesma ordem que
 * `lib/runtime-config.ts` usa em runtime: `PUBLIC_APP_URL` é a canónica.
 *
 * Devolve `null` quando nenhuma está definida — e nesse caso o output
 * diz-lo em vez de imprimir um domínio inventado. Foi um domínio
 * inventado, aqui, que mandou um operador configurar agents contra um
 * host que já não era o de produção.
 */
function publicAppUrl(): string | null {
  const raw = (process.env.PUBLIC_APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "").trim();
  return raw ? raw.replace(/\/+$/, "") : null;
}

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
    const base = publicAppUrl();
    console.log(
      base
        ? `       URL: ${base}/login?__tenant=${r.slug}`
        : `       URL: (define PUBLIC_APP_URL para o obter) /login?__tenant=${r.slug}`
    );
    console.log("");
    console.log(`  2. Configurar o local agent na farmácia (futuro PR 3):`);
    console.log(`       SPHARMMT_ENDPOINT=${base ?? "(define PUBLIC_APP_URL)"}`);
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

const USAGE = `Cria um cliente (tenant) novo: base de dados, admin e farmácias iniciais.

Uso:
  npm run tenant:create -- --slug X --name "Y" --admin-email E [outros]

Obrigatórias:
  --slug            identificador curto, minúsculas (ex.: farmacias-braga)
  --name, --nome    nome do cliente (ex.: "Grupo Farmácias de Braga")
  --admin-email     email do primeiro administrador do cliente

Base de dados (escolher uma):
  --provider        neon | manual | local
  --database-url    postgresql://USER:PASS@HOST/DB?sslmode=require
  --create-db       cria a base no provider configurado

Opcionais:
  --farmacias       "Nome A,Nome B"   farmácias criadas de início
  --admin-password  omitir para gerar uma senha (mostrada UMA vez)
  --admin-nome      nome do administrador
  --region          ex.: eu-west-2
  --dry-run         valida e mostra o plano, sem escrever nada
  --json            output em JSON
  --quiet           sem progresso
  --help, -h        esta ajuda

A senha do admin e a ingest key são mostradas UMA única vez.`;

async function main() {
  // `--help` ANTES do requireControlEnv(): pedir ajuda não pode exigir
  // CONTROL_DATABASE_URL nem TENANT_ENCRYPTION_SECRET. É também o que
  // torna este comando verificável dentro do container migrator sem
  // tocar em base de dados nenhuma — ver deploy/tests/live-tools-run.sh.
  const { values } = parseArgs({
    options: {
      help: { type: "boolean", short: "h", default: false },
      slug: { type: "string" },
      // `--nome` e `--name` ambos aceites; `--name` é o nome preferido no
      // doc de onboarding por consistência com os outros comandos.
      nome: { type: "string" },
      name: { type: "string" },
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

  if (values.help) {
    console.log(USAGE);
    process.exit(0);
    return;
  }

  requireControlEnv();

  const slug = values.slug;
  const nome = values.nome ?? values.name;
  const adminEmail = values["admin-email"];

  if (!slug || !nome || !adminEmail) {
    console.error(USAGE);
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
