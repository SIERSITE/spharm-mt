/**
 * lib/admin/create-client-workflow.ts
 *
 * Função programática `createClient(input)` que encadeia provision +
 * register + migrate + seed + ingest-key + smoke + activate. Usada
 * pelo CLI `scripts/admin/create-client.ts` (PR 2) e por futuros
 * consumers (UI admin, REST endpoint).
 *
 * Princípios:
 *   · Pure-ish: sem console.log directo. Reporter callback opcional
 *     para CLI streamar progresso. Returna `CreateClientResult`
 *     estruturado em ambos os caminhos (sucesso e falha).
 *   · Rollback claro: cada step regista `Checkpoint` e em falha a
 *     função `rollbackUntil(checkpoint)` desfaz best-effort. Se a
 *     limpeza falhar, regressa `manualActions` accionáveis.
 *   · Segurança: passwords + ingest key voltam apenas no result
 *     final, nunca no reporter. Connection strings completas nunca
 *     são logadas — mascaramos antes.
 *   · Dry-run: imprime o plano (provider, steps, contagens) sem
 *     side-effects.
 *
 * Steps (numerados por ordem de execução):
 *   1. validate-inputs         (puro — falha antes de qualquer side-effect)
 *   2. select-provider         (instantiation, valida envs)
 *   3. check-slug-free         (control plane SELECT)
 *   4. create-database         (provider.createDatabase)
 *   5. register-tenant         (INSERT control plane, estado=PROVISIONING)
 *   6. apply-migrations        (prisma migrate deploy)
 *   7. seed-admin              (insert utilizador ADMINISTRADOR)
 *   8. seed-farmacias          (insert N farmacias ATIVO)
 *   9. issue-ingest-key        (gen+persist hash, devolve plain)
 *  10. smoke-seed              (verifica admin + N farmacias na tenant DB)
 *  11. activate                (Tenant.estado=ACTIVE + provisionedAt + audit)
 *
 * Rollback policy:
 *   · Steps 1-3: nada criado, no-op
 *   · Step 4 falha: provider trata internamente (já testado em PR1)
 *   · Steps 5-10 falham: marca Tenant=FAILED, preserva infra. Operador
 *     usa cleanup-failed-tenant.ts + provider.destroyDatabase para
 *     destruir se quiser limpar. Esta escolha é deliberada — dá
 *     debug oportunity para casos não-triviais (ex: migration drift).
 *   · Step 11 falha: caso raro (UPDATE no control plane). Tenant fica
 *     em PROVISIONING. Retry manual: re-executar UPDATE.
 */

import bcrypt from "bcryptjs";
import { PrismaClient as TenantPrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { controlPrisma, logTenantEvent } from "@/lib/control-plane";
import { encryptTenantSecret } from "@/lib/tenant-crypto";
import {
  selectProvider,
  ProviderSelectionError,
  type ConnectionTargets,
  type DatabaseProvider,
  type ProviderKind,
} from "@/lib/db-providers";
import {
  SLUG_REGEX,
  generatePassword,
  runPrismaForTenant,
  getLatestMigrationName,
} from "../../scripts/tenancy/_shared";
import { issueIngestKey } from "./ingest-key";
import { seedUtilizacoes } from "@/lib/catalog/utilizacoes-ciclo";

export type Reporter = {
  step: (name: string) => void;
  info: (msg: string) => void;
  warn: (msg: string) => void;
};

const SILENT_REPORTER: Reporter = {
  step: () => {},
  info: () => {},
  warn: () => {},
};

export type CreateClientInput = {
  slug: string;
  nome: string;
  adminEmail: string;
  adminNome?: string;
  /** Se omisso, gera 12 bytes base64url e devolve no result. */
  adminPassword?: string;
  /** Nomes de farmácias iniciais. Lista vazia OK — operador adiciona depois. */
  farmacias?: string[];
  /** Apenas informativo; Neon escolhe baseado no projecto. */
  region?: string;

  // ── Provider selection (mesma forma que selectProvider) ──
  provider?: ProviderKind;
  databaseUrl?: string;
  createDb?: boolean;

  /** Dry-run: imprime plano via reporter, devolve result.ok=true sem tocar em nada. */
  dryRun?: boolean;
  /** Callback de progresso. Default = silent. CLI passa um adapter com console. */
  reporter?: Reporter;
};

export type FarmaciaCreated = { nome: string; id: string };

export type CreateClientResult = {
  ok: boolean;
  /** Último step executado / tentado. */
  step: string;
  /** Em ms — útil para output operacional. */
  durationMs: number;
  slug: string;
  provider?: string;

  // ── Resultados quando ok=true (ou parcialmente populados em falha) ──
  tenantId?: string;
  adminEmail?: string;
  /** SHOWN ONCE — não persistida em claro em lado nenhum. */
  adminPassword?: string;
  /** SHOWN ONCE — não persistida em claro em lado nenhum. */
  ingestKey?: string;
  farmaciasCreated?: FarmaciaCreated[];
  smokeOk?: boolean;
  schemaVersion?: string | null;

  // ── Em falha ──
  error?: string;
  /** Que tenant resta no control plane após falha — para cleanup-failed. */
  failedTenantId?: string;
  rollbackStatus?: "n/a" | "marked-failed" | "manual-action-needed";
  manualActions?: string[];
};

/** Mascara uma URL Postgres mostrando user/host/db mas escondendo password. */
function maskConnectionUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "***";
  }
}

function validateInputs(input: CreateClientInput): string | null {
  if (!input.slug || !SLUG_REGEX.test(input.slug)) {
    return `slug inválido: "${input.slug ?? ""}" — tem de bater /^[a-z0-9][a-z0-9-]{1,40}[a-z0-9]$/`;
  }
  if (!input.nome || input.nome.trim().length < 2) {
    return `nome inválido: muito curto (< 2 chars)`;
  }
  if (!input.adminEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.adminEmail)) {
    return `admin-email inválido: "${input.adminEmail ?? ""}"`;
  }
  if (input.adminPassword !== undefined && input.adminPassword.length < 8) {
    return `admin-password muito curta (< 8 chars). Omite para gerar automaticamente.`;
  }
  if (input.adminNome !== undefined && input.adminNome.trim().length === 0) {
    return `admin-nome vazio — omite para usar "Administrador"`;
  }
  if (input.farmacias) {
    for (let i = 0; i < input.farmacias.length; i++) {
      const f = input.farmacias[i];
      if (!f || f.trim().length === 0) {
        return `nome de farmácia [${i}] vazio na lista`;
      }
      if (f.length > 200) {
        return `nome de farmácia [${i}] muito longo (> 200 chars): "${f.slice(0, 60)}…"`;
      }
    }
  }
  return null;
}

/**
 * Marca Tenant=FAILED + audit. Idempotente; ignora erros para não
 * mascarar o erro original do step que falhou.
 */
async function markTenantFailed(
  tenantId: string,
  step: string,
  err: unknown
): Promise<void> {
  try {
    await controlPrisma.tenant.update({
      where: { id: tenantId },
      data: { estado: "FAILED" },
    });
  } catch {
    // ignore
  }
  try {
    await logTenantEvent({
      tenantId,
      action: "provision_failed",
      meta: {
        step,
        error: err instanceof Error ? err.message : String(err),
      },
    });
  } catch {
    // ignore
  }
}

export async function createClient(input: CreateClientInput): Promise<CreateClientResult> {
  const t0 = Date.now();
  const reporter = input.reporter ?? SILENT_REPORTER;
  const result: CreateClientResult = {
    ok: false,
    step: "validate-inputs",
    durationMs: 0,
    slug: input.slug,
  };

  // ── Step 1: validate ──────────────────────────────────────────────
  reporter.step("validate-inputs");
  const inputErr = validateInputs(input);
  if (inputErr) {
    result.error = inputErr;
    result.durationMs = Date.now() - t0;
    return result;
  }

  // ── Step 2: select provider ───────────────────────────────────────
  result.step = "select-provider";
  reporter.step("select-provider");
  let provider: DatabaseProvider;
  try {
    provider = selectProvider({
      provider: input.provider,
      databaseUrl: input.databaseUrl,
      createDb: input.createDb,
    });
  } catch (err) {
    result.error =
      err instanceof ProviderSelectionError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    result.durationMs = Date.now() - t0;
    return result;
  }
  result.provider = provider.name;
  reporter.info(`provider: ${provider.name}`);

  // ── Dry-run short-circuit ─────────────────────────────────────────
  if (input.dryRun) {
    result.step = "dry-run-done";
    reporter.info(`[dry-run] plano:`);
    reporter.info(`  · slug=${input.slug}, nome="${input.nome}"`);
    reporter.info(`  · provider=${provider.name}, region=${input.region ?? "default"}`);
    reporter.info(`  · admin=${input.adminEmail}`);
    reporter.info(
      `  · farmácias: ${input.farmacias && input.farmacias.length > 0 ? input.farmacias.length : 0}`
    );
    reporter.info(`  · steps: create-db → register → migrate → seed → ingest-key → smoke → activate`);
    result.ok = true;
    result.durationMs = Date.now() - t0;
    return result;
  }

  // ── Step 3: slug livre ────────────────────────────────────────────
  result.step = "check-slug-free";
  reporter.step("check-slug-free");
  const existing = await controlPrisma.tenant.findUnique({ where: { slug: input.slug } });
  if (existing) {
    result.error = `slug já em uso por tenant id=${existing.id} (estado=${existing.estado}). Limpa com: npm run tenancy:cleanup-failed -- --slug ${input.slug}`;
    result.durationMs = Date.now() - t0;
    return result;
  }

  // ── Step 4: create database ───────────────────────────────────────
  result.step = "create-database";
  reporter.step("create-database");
  let targets: ConnectionTargets;
  try {
    targets = await provider.createDatabase({ slug: input.slug, region: input.region });
  } catch (err) {
    result.error = `${provider.name}.createDatabase falhou: ${err instanceof Error ? err.message : String(err)}`;
    result.rollbackStatus = "n/a";
    result.durationMs = Date.now() - t0;
    return result;
  }
  reporter.info(`db criada: ${targets.dbName} @ ${targets.host}:${targets.port}`);
  reporter.info(`url: ${maskConnectionUrl(targets.connectionUrl)}`);

  // ── Step 5: register tenant ───────────────────────────────────────
  result.step = "register-tenant";
  reporter.step("register-tenant");
  let tenant;
  try {
    tenant = await controlPrisma.tenant.create({
      data: {
        slug: input.slug,
        nome: input.nome,
        estado: "PROVISIONING",
        dbHost: targets.host,
        dbPort: targets.port,
        dbName: targets.dbName,
        dbUser: targets.dbUser,
        dbPassEncrypted: encryptTenantSecret(targets.dbPassword),
      },
    });
    result.tenantId = tenant.id;
  } catch (err) {
    // Rollback DB porque ainda não há linha no control plane —
    // destruir é seguro (não há referências externas).
    const manualActions: string[] = [];
    try {
      await provider.destroyDatabase({
        dbName: targets.dbName,
        dbUser: targets.dbUser,
      });
    } catch (rollbackErr) {
      manualActions.push(
        `${provider.name}: destruir manualmente DB="${targets.dbName}" + role="${targets.dbUser}" (rollback automático falhou: ${
          rollbackErr instanceof Error ? rollbackErr.message : rollbackErr
        })`
      );
    }
    result.error = `register-tenant falhou: ${err instanceof Error ? err.message : String(err)}`;
    result.rollbackStatus = manualActions.length === 0 ? "n/a" : "manual-action-needed";
    result.manualActions = manualActions.length > 0 ? manualActions : undefined;
    result.durationMs = Date.now() - t0;
    return result;
  }

  // A partir daqui o pattern é: erro → markTenantFailed + preservar
  // infra para inspecção. Operador usa cleanup-failed-tenant.ts.
  result.failedTenantId = tenant.id;

  // ── Step 6: apply migrations ─────────────────────────────────────
  try {
    result.step = "apply-migrations";
    reporter.step("apply-migrations");
    const migrate = runPrismaForTenant(
      ["migrate", "deploy", "--schema", "prisma/schema.prisma"],
      targets.connectionUrl
    );
    if (migrate.status !== 0) {
      throw new Error(
        `prisma migrate deploy exit ${migrate.status}: ${(migrate.stderr ?? "").slice(0, 500)}`
      );
    }
    result.schemaVersion = getLatestMigrationName();

    // ── Step 7+8: seed admin + farmacias ───────────────────────────
    result.step = "seed-admin";
    reporter.step("seed-admin");
    const adminNome = input.adminNome?.trim() || "Administrador";
    let adminPassword = input.adminPassword;
    if (!adminPassword) {
      adminPassword = generatePassword(12);
    }
    const passwordHash = await bcrypt.hash(adminPassword, 10);
    const adminEmail = input.adminEmail.trim().toLowerCase();

    const adapter = new PrismaPg({ connectionString: targets.connectionUrl });
    const tenantDb = new TenantPrismaClient({ adapter });
    let farmaciasCreated: FarmaciaCreated[] = [];
    try {
      await tenantDb.utilizador.create({
        data: {
          email: adminEmail,
          nome: adminNome,
          perfil: "ADMINISTRADOR",
          estado: "ATIVO",
          passwordHash,
          mustChangePassword: true,
        },
      });

      result.step = "seed-farmacias";
      reporter.step("seed-farmacias");
      const farmaciaNames = (input.farmacias ?? []).map((f) => f.trim()).filter(Boolean);
      for (const nome of farmaciaNames) {
        const f = await tenantDb.farmacia.create({
          data: { nome, estado: "ATIVO" },
          select: { id: true, nome: true },
        });
        farmaciasCreated.push({ nome: f.nome, id: f.id });
      }

      // ── Step 8b: vocabulário de utilizações ──────────────────────
      //
      // Aqui e não no job: um tenant criado pelo Wizard tem de sair
      // completo. Se o vocabulário só chegasse na passagem seguinte do
      // /api/jobs/utilizacoes, existiria uma janela em que a farmácia
      // está instalada e a pesquisa por necessidade não funciona — e
      // ninguém saberia dizer se era erro ou se era só esperar.
      //
      // Não aborta a criação: o tenant já tem base, schema, admin e
      // farmácias, e desfazer tudo isso por causa de 56 linhas de
      // vocabulário seria trocar um problema pequeno por um grande. O
      // job repõe, e o passo fica registado como falhado.
      result.step = "seed-utilizacoes";
      reporter.step("seed-utilizacoes");
      try {
        const u = await seedUtilizacoes(tenantDb);
        reporter.info(`utilizações: ${u.novas} novas, ${u.actualizadas} actualizadas`);
      } catch (err) {
        console.warn(
          `[create-client] seed-utilizacoes falhou para ${input.slug}: ${
            err instanceof Error ? err.message : String(err)
          } — o job /api/jobs/utilizacoes repõe.`,
        );
      }
    } finally {
      await tenantDb.$disconnect();
    }
    result.farmaciasCreated = farmaciasCreated;
    result.adminEmail = adminEmail;
    result.adminPassword = adminPassword;

    // ── Step 9: issue ingest key ───────────────────────────────────
    result.step = "issue-ingest-key";
    reporter.step("issue-ingest-key");
    const { plainKey } = await issueIngestKey(tenant.id);
    result.ingestKey = plainKey;

    // ── Step 10: smoke seed ────────────────────────────────────────
    result.step = "smoke-seed";
    reporter.step("smoke-seed");
    await runSmokeSeed({
      connectionUrl: targets.connectionUrl,
      expectedAdminEmail: adminEmail,
      expectedFarmaciaCount: farmaciasCreated.length,
    });
    result.smokeOk = true;

    // ── Step 11: activate ──────────────────────────────────────────
    result.step = "activate";
    reporter.step("activate");
    await controlPrisma.tenant.update({
      where: { id: tenant.id },
      data: {
        estado: "ACTIVE",
        provisionedAt: new Date(),
        schemaVersion: result.schemaVersion ?? null,
      },
    });
    await logTenantEvent({
      tenantId: tenant.id,
      action: "created",
      meta: {
        slug: input.slug,
        nome: input.nome,
        adminEmail,
        provider: provider.name,
        farmaciasCount: farmaciasCreated.length,
      },
    });

    result.ok = true;
    result.step = "done";
    result.failedTenantId = undefined;
    result.rollbackStatus = undefined;
    result.durationMs = Date.now() - t0;
    return result;
  } catch (err) {
    await markTenantFailed(tenant.id, result.step, err);
    result.error = `${result.step} falhou: ${err instanceof Error ? err.message : String(err)}`;
    result.rollbackStatus = "marked-failed";
    result.manualActions = [
      `tenant ${input.slug} marcado FAILED — infra preservada para inspecção.`,
      `Para destruir DB + role:    use o provider.destroyDatabase ou o painel ${provider.name}.`,
      `Para limpar control plane:  npm run tenancy:cleanup-failed -- --slug ${input.slug} --confirm`,
    ];
    result.durationMs = Date.now() - t0;
    return result;
  }
}

async function runSmokeSeed(opts: {
  connectionUrl: string;
  expectedAdminEmail: string;
  expectedFarmaciaCount: number;
}): Promise<void> {
  const adapter = new PrismaPg({ connectionString: opts.connectionUrl });
  const db = new TenantPrismaClient({ adapter });
  try {
    const admins = await db.utilizador.count({
      where: { email: opts.expectedAdminEmail, perfil: "ADMINISTRADOR" },
    });
    if (admins !== 1) {
      throw new Error(
        `esperava 1 utilizador ADMINISTRADOR com email=${opts.expectedAdminEmail}, encontrei ${admins}`
      );
    }
    const farmacias = await db.farmacia.count({ where: { estado: "ATIVO" } });
    if (farmacias !== opts.expectedFarmaciaCount) {
      throw new Error(
        `esperava ${opts.expectedFarmaciaCount} farmácia(s) ATIVO, encontrei ${farmacias}`
      );
    }
  } finally {
    await db.$disconnect();
  }
}
