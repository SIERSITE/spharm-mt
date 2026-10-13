/**
 * scripts/e2e/_infarmed-comum.ts
 *
 * Peças comuns dos ensaios da atualização/upload do INFARMED: SMTP de teste,
 * segundo tenant e sessões. Só em bases/servidores LOCAIS e descartáveis.
 */
import net from "node:net";
import { execSync } from "node:child_process";
import { Client } from "pg";
import { SignJWT } from "jose";
import bcrypt from "bcryptjs";
import { PrismaPg } from "@prisma/adapter-pg";
import type { Ambiente } from "./_ambiente-silveira";
import { ADMIN_URL, SECRET } from "./_ambiente-silveira";

/** SMTP mínimo (sem STARTTLS/auth) que guarda as mensagens recebidas. */
export function smtpSink(): Promise<{ port: number; mensagens: string[]; close: () => void }> {
  const mensagens: string[] = [];
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => {
      sock.write("220 sink ESMTP\r\n");
      let buf = "";
      let dados = false;
      let corpo = "";
      sock.on("data", (d) => {
        buf += d.toString("latin1");
        while (true) {
          if (dados) {
            const i = buf.indexOf("\r\n.\r\n");
            if (i < 0) return;
            corpo += buf.slice(0, i);
            buf = buf.slice(i + 5);
            mensagens.push(corpo);
            corpo = "";
            dados = false;
            sock.write("250 OK queued\r\n");
            continue;
          }
          const i = buf.indexOf("\r\n");
          if (i < 0) return;
          const cmd = buf.slice(0, i).toUpperCase();
          buf = buf.slice(i + 2);
          if (cmd.startsWith("EHLO") || cmd.startsWith("HELO")) sock.write("250 sink\r\n");
          else if (cmd.startsWith("DATA")) { dados = true; sock.write("354 go\r\n"); }
          else if (cmd.startsWith("QUIT")) { sock.write("221 bye\r\n"); sock.end(); }
          else sock.write("250 OK\r\n");
        }
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve({ port: (srv.address() as net.AddressInfo).port, mensagens, close: () => srv.close() }));
  });
}


export const TENANT_ENC_SECRET = "e2e-tenant-encryption-secret-0123456789abcdef";

const urlDe = (db: string) => {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${db}`;
  return u.toString();
};

/** Cria um 2.º tenant ACTIVE (base + migrations + registo no control plane). Devolve o cliente e uma função para o apagar. */
export async function adicionarTenant(amb: Ambiente, slug: string) {
  const db = `spharm_e2e_${slug}_${Date.now().toString(36)}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${db}`);
  const url = urlDe(db);
  execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: url }, encoding: "utf8", stdio: "pipe" });
  process.env.TENANT_ENCRYPTION_SECRET = TENANT_ENC_SECRET;
  const { encryptTenantSecret } = await import("../../lib/tenant-crypto");
  const { PrismaClient: ControlClient } = await import("../../generated/prisma-control/client");
  const { PrismaClient } = await import("../../generated/prisma/client");
  const control = new ControlClient({ adapter: new PrismaPg({ connectionString: amb.controlUrl }) });
  const u = new URL(url);
  await control.tenant.create({
    data: {
      slug, nome: `Tenant ${slug}`, estado: "ACTIVE", dbHost: u.hostname, dbPort: Number(u.port), dbName: db,
      dbUser: decodeURIComponent(u.username), dbPassEncrypted: encryptTenantSecret(decodeURIComponent(u.password)),
      ingestApiKeyHash: await bcrypt.hash("x-" + slug + "-key-0123456789abcdef", 10), ingestApiKeyIssuedAt: new Date(),
    },
  });
  await control.$disconnect();
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  return {
    prisma, url,
    apagar: async () => {
      await prisma.$disconnect();
      await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => undefined);
      await admin.end();
    },
  };
}

/** Sessão forjada (cookie `session`). `tenant`: slug, ou "__legacy__" para a consola de plataforma. */
export async function tokenSessaoCom(p: { sub: string; email: string; perfil: string; tenant: string }): Promise<string> {
  return new SignJWT({ sub: p.sub, email: p.email, nome: "E2E", perfil: p.perfil, farmaciaId: null, tenant: p.tenant })
    .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("8h").sign(new TextEncoder().encode(SECRET));
}
