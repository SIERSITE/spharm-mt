/**
 * scripts/e2e/_ambiente-silveira.ts
 *
 * Ambiente DESCARTÁVEL e REAL para os ensaios de browser do tenant `silveira`:
 *
 *   · PostgreSQL local (TEST_PG_ADMIN_URL, recusa hosts não locais) com duas
 *     bases novas: a do tenant (todas as migrations) e o control plane
 *     (migrations do control) com um Tenant `silveira` ACTIVE, password da
 *     base cifrada como em produção e uma ingest API key (bcrypt);
 *   · o servidor REAL (`.next/standalone/server.js`, build de produção) a
 *     resolver o tenant pelo control plane — a mesma cadeia que a produção
 *     usa (middleware → registry → getPrisma), SEM o fallback legacy;
 *   · sessões forjadas (JWT assinado com o AUTH_SECRET do servidor) e um
 *     "agent" HTTP real (Bearer + X-Tenant-Slug) para os endpoints
 *     /api/ingest e /api/outbox.
 *
 * Pré-requisito: `npx next build` com
 *   SERVER_ACTIONS_ALLOWED_ORIGINS="localhost:3100,127.0.0.1:3100,*.localhost:3100"
 *
 * Nunca toca em bases reais: tudo é criado e apagado aqui.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { SignJWT } from "jose";
import bcrypt from "bcryptjs";
import { PrismaPg } from "@prisma/adapter-pg";

export const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgresql://postgres:test@localhost:55490/postgres";
export const PORT = process.env.E2E_PORT ?? "3100";
export const SECRET = "e2e-test-secret-e2e-test-secret-0123456789";
const TENANT_ENC_SECRET = "e2e-tenant-encryption-secret-0123456789abcdef";
export const INGEST_KEY = "e2e-ingest-key-0123456789abcdef0123456789";
export const CODIGO_ANF_SILVEIRENSE = "ANF-SILV-E2E";

{
  const h = new URL(ADMIN_URL).hostname;
  if (h !== "localhost" && h !== "127.0.0.1") {
    console.error(`RECUSADO: ${h} não é uma base local descartável.`);
    process.exit(2);
  }
}

export const baseFor = (slug: string) => `http://${slug}.localhost:${PORT}`;
const urlDe = (db: string) => {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${db}`;
  return u.toString();
};
const raiz = path.resolve(__dirname, "../..");

export type Ambiente = {
  tenantUrl: string;
  controlUrl: string;
  prisma: import("../../generated/prisma/client").PrismaClient;
  /** Chamada HTTP de "agent": Bearer + X-Tenant-Slug. */
  agente: (method: "GET" | "POST", caminho: string, corpo?: unknown) => Promise<{ status: number; json: any }>;
  /** Sessão forjada para o tenant (cookie `session`). */
  tokenSessao: (sub: string, email: string) => Promise<string>;
  logs: () => string;
  parar: () => Promise<void>;
};

export async function criarAmbiente(nome: string, envExtra: Record<string, string> = {}): Promise<Ambiente> {
  const sufixo = Date.now().toString(36);
  const dbTenant = `spharm_e2e_${nome}_t_${sufixo}`;
  const dbControl = `spharm_e2e_${nome}_c_${sufixo}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbTenant}`);
  await admin.query(`CREATE DATABASE ${dbControl}`);
  const tenantUrl = urlDe(dbTenant);
  const controlUrl = urlDe(dbControl);

  const migrar = (args: string[], env: Record<string, string>) => {
    const r = spawnSync("npx", ["prisma", ...args], { cwd: raiz, encoding: "utf8", shell: process.platform === "win32", env: { ...process.env, ...env } });
    if (r.status !== 0) throw new Error(`prisma ${args.join(" ")} falhou:\n${r.stdout}\n${r.stderr}`);
  };
  migrar(["migrate", "deploy"], { DATABASE_URL: tenantUrl });
  migrar(["migrate", "deploy", "--config", "prisma-control.config.ts"], { CONTROL_DATABASE_URL: controlUrl });

  // Tenant `silveira` no control plane — password da base cifrada como em produção.
  process.env.TENANT_ENCRYPTION_SECRET = TENANT_ENC_SECRET;
  const { encryptTenantSecret } = await import("../../lib/tenant-crypto");
  const { PrismaClient: ControlClient } = await import("../../generated/prisma-control/client");
  const control = new ControlClient({ adapter: new PrismaPg({ connectionString: controlUrl }) });
  const dbUrl = new URL(tenantUrl);
  await control.tenant.create({
    data: {
      slug: "silveira",
      nome: "Silveira (E2E)",
      estado: "ACTIVE",
      dbHost: dbUrl.hostname,
      dbPort: Number(dbUrl.port),
      dbName: dbTenant,
      dbUser: decodeURIComponent(dbUrl.username),
      dbPassEncrypted: encryptTenantSecret(decodeURIComponent(dbUrl.password)),
      ingestApiKeyHash: await bcrypt.hash(INGEST_KEY, 10),
      ingestApiKeyIssuedAt: new Date(),
    },
  });
  await control.$disconnect();

  const { PrismaClient } = await import("../../generated/prisma/client");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: tenantUrl }) });

  // Servidor standalone (build de produção real).
  const standalone = path.join(raiz, ".next", "standalone");
  if (!existsSync(path.join(standalone, "server.js"))) throw new Error("Falta .next/standalone/server.js — correr `npx next build` primeiro.");
  rmSync(path.join(standalone, ".next", "static"), { recursive: true, force: true });
  mkdirSync(path.join(standalone, ".next"), { recursive: true });
  cpSync(path.join(raiz, ".next", "static"), path.join(standalone, ".next", "static"), { recursive: true });
  if (existsSync(path.join(raiz, "public"))) cpSync(path.join(raiz, "public"), path.join(standalone, "public"), { recursive: true });

  let saida = "";
  const filho: ChildProcess = spawn(process.execPath, ["server.js"], {
    cwd: standalone,
    env: {
      ...process.env,
      PORT, HOSTNAME: "localhost",
      DATABASE_URL: tenantUrl,
      CONTROL_DATABASE_URL: controlUrl,
      TENANT_ENCRYPTION_SECRET: TENANT_ENC_SECRET,
      TENANT_DB_SSLMODE: "disable",
      AUTH_SECRET: SECRET,
      ENABLE_AGENT_BOOTSTRAP: "1",
      SERVER_ACTIONS_ALLOWED_ORIGINS: `localhost:${PORT},127.0.0.1:${PORT},*.localhost:${PORT}`,
      ...envExtra,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  filho.stdout?.on("data", (d) => { saida += String(d); });
  filho.stderr?.on("data", (d) => { saida += String(d); });

  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(`http://localhost:${PORT}/login`, { redirect: "manual" });
      if (r.status > 0) break;
    } catch { /* ainda a arrancar */ }
    if (filho.exitCode !== null) throw new Error(`O servidor terminou (${filho.exitCode}):\n${saida}`);
    await new Promise((r) => setTimeout(r, 1000));
  }

  const agente: Ambiente["agente"] = async (method, caminho, corpo) => {
    const r = await fetch(`http://localhost:${PORT}${caminho}`, {
      method,
      headers: {
        authorization: `Bearer ${INGEST_KEY}`,
        "x-tenant-slug": "silveira",
        "content-type": "application/json",
        host: `silveira.localhost:${PORT}`,
      },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    let json: any = null;
    try { json = await r.json(); } catch { /* sem corpo */ }
    return { status: r.status, json };
  };

  return {
    tenantUrl, controlUrl, prisma, agente,
    tokenSessao: (sub, email) =>
      new SignJWT({ sub, email, nome: "E2E Admin", perfil: "ADMINISTRADOR", farmaciaId: null, tenant: "silveira" })
        .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("8h").sign(new TextEncoder().encode(SECRET)),
    logs: () => saida,
    parar: async () => {
      filho.kill();
      await prisma.$disconnect();
      await new Promise((r) => setTimeout(r, 500));
      await admin.query(`DROP DATABASE IF EXISTS ${dbTenant} WITH (FORCE)`);
      await admin.query(`DROP DATABASE IF EXISTS ${dbControl} WITH (FORCE)`);
      await admin.end();
    },
  };
}
