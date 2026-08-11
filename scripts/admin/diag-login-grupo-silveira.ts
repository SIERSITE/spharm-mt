/**
 * scripts/admin/diag-login-grupo-silveira.ts
 *
 * Diagnóstico READ-ONLY do estado de credenciais de um utilizador num
 * tenant. Replica EXACTAMENTE a sequência que o `loginAction` corre em
 * produção, mas:
 *   · Não escreve nada na BD.
 *   · Não cria utilizadores.
 *   · Não muda passwords.
 *   · Não persiste sessão.
 *
 * Para cada passo, imprime sinal estruturado para o caller decidir.
 *
 * Uso (NUNCA passar a password em terminal partilhado):
 *   $env:TEST_PASSWORD=".SIER2026"; npx tsx scripts/admin/diag-login-grupo-silveira.ts
 *
 * Argumentos:
 *   --slug=<tenant-slug>          default: grupo-silveira
 *   --email=<email>               default: grp.cc.spharm@sier.pt
 *   --password-env=TEST_PASSWORD  nome da env var; valor nunca é impresso
 */

import "dotenv/config";
import { parseArgs } from "node:util";
import bcrypt from "bcryptjs";
import {
  getTenantBySlug,
  buildTenantConnectionString,
  controlPrisma,
} from "@/lib/control-plane";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

type StepResult = { ok: boolean; detail: string };

function step(label: string, r: StepResult): void {
  const mark = r.ok ? "✓" : "✗";
  console.log(`  ${mark} ${label.padEnd(56)} ${r.detail}`);
}

function maskEmail(e: string): string {
  // grp.cc.spharm@sier.pt → grp.****.******@sier.pt
  const [u, d] = e.split("@");
  if (!u || !d) return "(invalid)";
  const tokens = u.split(".");
  const masked = tokens
    .map((t, i) => (i === 0 ? t : t.length <= 1 ? t : t[0] + "*".repeat(t.length - 1)))
    .join(".");
  return `${masked}@${d}`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      slug: { type: "string", default: "grupo-silveira" },
      email: { type: "string", default: "grp.cc.spharm@sier.pt" },
      "password-env": { type: "string", default: "TEST_PASSWORD" },
    },
  });
  const slug = values.slug!;
  const email = values.email!.trim().toLowerCase();
  const pwdEnvName = values["password-env"]!;
  const password = process.env[pwdEnvName];

  console.log("─".repeat(78));
  console.log(`Diag login — read-only`);
  console.log("─".repeat(78));
  console.log(`  slug          : ${slug}`);
  console.log(`  email (masked): ${maskEmail(email)}`);
  console.log(`  password env  : ${pwdEnvName}=${password ? "(set, length=" + password.length + ")" : "(NOT SET)"}`);
  console.log("");

  // ── Etapa 1 — control plane: tenant existe + estado ─────────────
  console.log("[1] control plane lookup");
  const tenant = await getTenantBySlug(slug);
  step(
    `getTenantBySlug("${slug}")`,
    tenant
      ? { ok: true, detail: `id=${tenant.id}  estado=${tenant.estado}` }
      : { ok: false, detail: "NULL — tenant não existe no control plane" },
  );
  if (!tenant) {
    await controlPrisma.$disconnect();
    return;
  }
  step(
    "estado === ACTIVE",
    tenant.estado === "ACTIVE"
      ? { ok: true, detail: "ACTIVE → entra no warm-up do registry" }
      : {
          ok: false,
          detail: `${tenant.estado} → listTenants({estado:'ACTIVE'}) NÃO devolve este tenant → cache miss → fallback legacy`,
        },
  );
  step(
    "schemaVersion / lastMigratedAt",
    tenant.schemaVersion
      ? {
          ok: true,
          detail: `v=${tenant.schemaVersion}, migrado=${tenant.lastMigratedAt?.toISOString() ?? "-"}`,
        }
      : { ok: false, detail: "schemaVersion=null (pode ou não bloquear; só info)" },
  );

  // ── Etapa 2 — connection string ──────────────────────────────────
  console.log("\n[2] decifrar credenciais do tenant + montar URL");
  let url: string;
  try {
    url = buildTenantConnectionString(tenant);
    step("decryptTenantSecret + buildTenantConnectionString", {
      ok: true,
      detail: `${tenant.dbHost}:${tenant.dbPort}/${tenant.dbName} user=${tenant.dbUser} (pwd OK)`,
    });
  } catch (err) {
    step("decryptTenantSecret", {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
    await controlPrisma.$disconnect();
    return;
  }

  // ── Etapa 3 — conectar à BD do tenant ────────────────────────────
  console.log("\n[3] ligar à BD do tenant");
  const tenantPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    const ping = await tenantPrisma.$queryRaw<Array<{ ok: number }>>`SELECT 1::int as ok`;
    step("$queryRaw SELECT 1", {
      ok: ping[0]?.ok === 1,
      detail: ping[0]?.ok === 1 ? "ligação OK" : "ping falhou (?)",
    });
  } catch (err) {
    step("ligação BD tenant", {
      ok: false,
      detail: err instanceof Error ? err.message.slice(0, 200) : String(err),
    });
    await tenantPrisma.$disconnect();
    await controlPrisma.$disconnect();
    return;
  }

  // ── Etapa 4 — utilizador (réplica EXACTA do loginAction) ─────────
  console.log("\n[4] lookup Utilizador (mesma query que loginAction)");
  const utilizador = await tenantPrisma.utilizador.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      nome: true,
      perfil: true,
      farmaciaId: true,
      estado: true,
      passwordHash: true,
      mustChangePassword: true,
      ultimoLogin: true,
      dataCriacao: true,
      dataAtualizacao: true,
    },
  });
  step(
    "findUnique({where:{email}})",
    utilizador
      ? { ok: true, detail: `id=${utilizador.id} perfil=${utilizador.perfil}` }
      : { ok: false, detail: "NULL — email não existe na BD deste tenant" },
  );
  if (!utilizador) {
    // Não encontrado — diagnóstico de match-mode
    console.log("\n  [4b] possíveis variantes do email (debug match):");
    const variants = await tenantPrisma.utilizador.findMany({
      where: {
        OR: [
          { email: { contains: email.split("@")[0], mode: "insensitive" } },
          { email: { contains: email.split("@")[1] ?? "@?", mode: "insensitive" } },
        ],
      },
      select: { id: true, email: true, estado: true, perfil: true },
      take: 8,
    });
    if (variants.length === 0) {
      console.log("       (nenhum utilizador com partes deste email no tenant)");
    } else {
      for (const v of variants) {
        console.log(`       · ${v.email}  estado=${v.estado}  perfil=${v.perfil}`);
      }
    }
    await tenantPrisma.$disconnect();
    await controlPrisma.$disconnect();
    return;
  }

  step(
    "utilizador.estado === ATIVO",
    utilizador.estado === "ATIVO"
      ? { ok: true, detail: "ATIVO" }
      : { ok: false, detail: `${utilizador.estado} → action devolve 'Credenciais inválidas.'` },
  );
  step(
    "utilizador.passwordHash não-null",
    utilizador.passwordHash
      ? { ok: true, detail: `bcrypt hash presente (${utilizador.passwordHash.length} chars, ${utilizador.passwordHash.slice(0, 7)}…)` }
      : { ok: false, detail: "NULL → action devolve 'Credenciais inválidas.'" },
  );
  step(
    "mustChangePassword",
    !utilizador.mustChangePassword
      ? { ok: true, detail: "false" }
      : { ok: true, detail: "true (não bloqueia login na action actual; só é flag UI)" },
  );
  step("dataCriacao", { ok: true, detail: utilizador.dataCriacao.toISOString() });
  step("dataAtualizacao", { ok: true, detail: utilizador.dataAtualizacao.toISOString() });
  step("ultimoLogin", {
    ok: !!utilizador.ultimoLogin,
    detail: utilizador.ultimoLogin?.toISOString() ?? "(NULL — nunca houve login bem-sucedido)",
  });

  // ── Etapa 5 — bcrypt compare ─────────────────────────────────────
  if (utilizador.passwordHash && password) {
    console.log("\n[5] bcrypt.compare(password, hash)");
    let pwOk = false;
    try {
      pwOk = await bcrypt.compare(password, utilizador.passwordHash);
    } catch (err) {
      step("bcrypt.compare", {
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    step("password bate com hash", {
      ok: pwOk,
      detail: pwOk
        ? "MATCH → action passaria desta validação"
        : "NO MATCH → action devolveria 'Credenciais inválidas.'",
    });
  } else if (!password) {
    console.log(
      `\n[5] bcrypt.compare — SKIPPED (env ${pwdEnvName} não definida; passar via 'set ${pwdEnvName}=...')`,
    );
  }

  // ── Etapa 6 — comparar com legacy (qual BD a action usaria se warm-up falhar?) ──
  console.log("\n[6] sanity: BD apontada pelo DATABASE_URL legacy contém este email?");
  const legacyUrl = process.env.DATABASE_URL;
  if (!legacyUrl) {
    step("DATABASE_URL", { ok: false, detail: "não definida no env local — não posso comparar" });
  } else if (legacyUrl === url) {
    step("DATABASE_URL == tenant URL", {
      ok: true,
      detail: "legacy aponta para o MESMO tenant — fallback legacy é inofensivo neste env",
    });
  } else {
    const legacyPrisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: legacyUrl }),
    });
    try {
      const legacyUser = await legacyPrisma.utilizador.findUnique({
        where: { email },
        select: { id: true, estado: true },
      });
      step("legacy DB tem este email?", {
        ok: !legacyUser,
        detail: legacyUser
          ? `SIM (id=${legacyUser.id}, estado=${legacyUser.estado}) — se prod cair em legacy, este user existe lá também`
          : "NÃO — se prod cair em legacy aqui, o user não é encontrado → 'Credenciais inválidas.'",
      });
    } catch (err) {
      step("ligação legacy DB", {
        ok: false,
        detail: err instanceof Error ? err.message.slice(0, 200) : String(err),
      });
    } finally {
      await legacyPrisma.$disconnect();
    }
  }

  await tenantPrisma.$disconnect();
  await controlPrisma.$disconnect();

  console.log("\n" + "─".repeat(78));
  console.log("FIM — read-only. Nenhuma escrita executada.");
  console.log("─".repeat(78));
}

main().catch(async (err) => {
  console.error("[fatal]", err instanceof Error ? err.message : err);
  await controlPrisma.$disconnect().catch(() => {});
  process.exit(1);
});
