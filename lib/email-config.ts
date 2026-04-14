import "server-only";
import nodemailer, { type Transporter } from "nodemailer";
import { getPrisma } from "@/lib/prisma";
import { decryptSecret, encryptSecret } from "@/lib/email-crypto";

export type EmailConfigInput = {
  smtpHost: string;
  smtpPort: number;
  smtpUser: string | null;
  /** Plaintext. Se null/empty, mantém a actual (não sobrescreve). */
  smtpPass: string | null;
  smtpSecure: boolean;
  fromEmail: string;
  fromName: string | null;
  replyTo: string | null;
  isActive: boolean;
};

export type ResolvedEmailConfig = {
  id: string;
  scope: "farmacia" | "global";
  farmaciaId: string | null;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string | null;
  smtpPass: string | null;
  smtpSecure: boolean;
  fromEmail: string;
  fromName: string | null;
  replyTo: string | null;
};

/**
 * Resolve a configuração SMTP a usar para uma farmácia.
 * Ordem: config da farmácia (se isActive) → config global (se isActive) → erro.
 */
export async function resolveEmailConfig(
  farmaciaId: string | null
): Promise<ResolvedEmailConfig> {
  const prisma = await getPrisma();
  let row = farmaciaId
    ? await prisma.emailConfig.findUnique({ where: { farmaciaId } })
    : null;

  if (!row || !row.isActive) {
    row = await prisma.emailConfig.findFirst({
      where: { farmaciaId: null, isActive: true },
    });
  }

  if (!row) {
    throw new Error(
      "Sem configuração SMTP. Define em Configurações → Email (por farmácia ou global)."
    );
  }

  return {
    id: row.id,
    scope: row.farmaciaId ? "farmacia" : "global",
    farmaciaId: row.farmaciaId,
    smtpHost: row.smtpHost,
    smtpPort: row.smtpPort,
    smtpUser: row.smtpUser,
    smtpPass: row.smtpPassEncrypted ? decryptSecret(row.smtpPassEncrypted) : null,
    smtpSecure: row.smtpSecure,
    fromEmail: row.fromEmail,
    fromName: row.fromName,
    replyTo: row.replyTo,
  };
}

export function buildTransporter(cfg: ResolvedEmailConfig): {
  transporter: Transporter;
  from: string;
  replyTo: string | undefined;
} {
  const transporter = nodemailer.createTransport({
    host: cfg.smtpHost,
    port: cfg.smtpPort,
    secure: cfg.smtpSecure,
    auth: cfg.smtpUser && cfg.smtpPass ? { user: cfg.smtpUser, pass: cfg.smtpPass } : undefined,
  });
  const from = cfg.fromName ? `${cfg.fromName} <${cfg.fromEmail}>` : cfg.fromEmail;
  return { transporter, from, replyTo: cfg.replyTo ?? undefined };
}

/** Lê config (sem password em claro) para mostrar na UI. */
export async function readEmailConfig(farmaciaId: string | null) {
  const prisma = await getPrisma();
  const row = farmaciaId
    ? await prisma.emailConfig.findUnique({ where: { farmaciaId } })
    : await prisma.emailConfig.findFirst({ where: { farmaciaId: null } });
  if (!row) return null;
  return {
    id: row.id,
    farmaciaId: row.farmaciaId,
    smtpHost: row.smtpHost,
    smtpPort: row.smtpPort,
    smtpUser: row.smtpUser,
    hasPassword: !!row.smtpPassEncrypted,
    smtpSecure: row.smtpSecure,
    fromEmail: row.fromEmail,
    fromName: row.fromName,
    replyTo: row.replyTo,
    isActive: row.isActive,
    lastTestAt: row.lastTestAt,
    lastTestStatus: row.lastTestStatus,
    lastTestError: row.lastTestError,
  };
}

/** Cria/actualiza config. Password só é escrita se vier não-vazia. */
export async function saveEmailConfig(
  farmaciaId: string | null,
  input: EmailConfigInput
) {
  const prisma = await getPrisma();
  const passEncrypted =
    input.smtpPass && input.smtpPass.length > 0 ? encryptSecret(input.smtpPass) : undefined;

  const data = {
    smtpHost: input.smtpHost.trim(),
    smtpPort: input.smtpPort,
    smtpUser: input.smtpUser?.trim() || null,
    smtpSecure: input.smtpSecure,
    fromEmail: input.fromEmail.trim(),
    fromName: input.fromName?.trim() || null,
    replyTo: input.replyTo?.trim() || null,
    isActive: input.isActive,
    ...(passEncrypted !== undefined ? { smtpPassEncrypted: passEncrypted } : {}),
  };

  if (farmaciaId) {
    return prisma.emailConfig.upsert({
      where: { farmaciaId },
      create: { farmaciaId, ...data, smtpPassEncrypted: passEncrypted ?? null },
      update: data,
    });
  }

  // Global: singleton garantido por índice parcial; usamos findFirst+update/create.
  const existing = await prisma.emailConfig.findFirst({ where: { farmaciaId: null } });
  if (existing) {
    return prisma.emailConfig.update({ where: { id: existing.id }, data });
  }
  return prisma.emailConfig.create({
    data: { farmaciaId: null, ...data, smtpPassEncrypted: passEncrypted ?? null },
  });
}

/**
 * Envia um email de teste usando a config resolvida.
 * Actualiza lastTestAt/lastTestStatus/lastTestError no registo correspondente.
 */
export async function sendTestEmail(
  farmaciaId: string | null,
  toEmail: string
): Promise<{ ok: boolean; error?: string; messageId?: string }> {
  let cfg: ResolvedEmailConfig;
  try {
    cfg = await resolveEmailConfig(farmaciaId);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const { transporter, from, replyTo } = buildTransporter(cfg);
  let result: { ok: boolean; error?: string; messageId?: string };
  try {
    await transporter.verify();
    const info = await transporter.sendMail({
      from,
      to: toEmail,
      replyTo,
      subject: "SPharm.MT — teste de configuração SMTP",
      text:
        "Este é um email de teste do SPharm.MT.\n\n" +
        `Servidor: ${cfg.smtpHost}:${cfg.smtpPort} (${cfg.smtpSecure ? "SSL" : "STARTTLS"})\n` +
        `Âmbito: ${cfg.scope}\n` +
        `Enviado em: ${new Date().toISOString()}\n`,
    });
    result = { ok: true, messageId: info.messageId };
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const prisma = await getPrisma();
  await prisma.emailConfig.update({
    where: { id: cfg.id },
    data: {
      lastTestAt: new Date(),
      lastTestStatus: result.ok ? "ok" : "error",
      lastTestError: result.ok ? null : result.error ?? null,
    },
  });

  return result;
}
