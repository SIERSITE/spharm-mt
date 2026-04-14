/**
 * lib/reporting/report-email-transport.ts
 *
 * SERVER-ONLY. Constrói um transporter nodemailer a partir da configuração
 * SMTP guardada em BD (modelo EmailConfig), resolvida por farmácia.
 *
 * Esta era a ÚNICA peça que dependia de SMTP_HOST/SMTP_PASS no .env. Agora
 * todas as configurações vivem em BD, editáveis em /configuracoes/email.
 * Ver lib/email-config.ts para o resolver e cifragem.
 */

import "server-only";
import type { Transporter } from "nodemailer";
import { resolveEmailConfig, buildTransporter } from "@/lib/email-config";

export async function getMailerForFarmacia(
  farmaciaId: string | null
): Promise<{ transporter: Transporter; from: string; replyTo: string | undefined }> {
  const cfg = await resolveEmailConfig(farmaciaId);
  return buildTransporter(cfg);
}
