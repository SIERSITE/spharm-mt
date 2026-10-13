/**
 * lib/regulamentar/infarmed-runtime.ts
 *
 * Liga o orquestrador (`infarmed-atualizacao.ts`) ao mundo real: control plane,
 * tenants ativos (infraestrutura de tenancy existente — nunca uma lista fixa),
 * obtenção do ficheiro e envio de email (o MESMO mecanismo do projeto: a
 * configuração SMTP `EmailConfig` + nodemailer de `lib/email-config.ts`).
 *
 * Email operacional:
 *   · destinatários: `INFARMED_IMPORT_ALERT_EMAIL` (lista separada por vírgulas);
 *     se não existir, os administradores da plataforma (`PLATFORM_ADMIN_EMAILS`) —
 *     a configuração de destinatários de alertas operacionais que o projeto já tem;
 *   · remetente/SMTP: a configuração SMTP global ativa do primeiro tenant ativo
 *     que a tenha (`INFARMED_ALERT_SMTP_TENANT` fixa o tenant, opcionalmente).
 *   Sem destinatário ou sem SMTP ⇒ `EmailNaoConfigurado` (registado, sem bloquear nada).
 */

import { getControlPrismaCli } from "@/lib/sync/control-client-cli";
import { getTenantPrismaOrLegacy } from "@/lib/tenant-registry";
import { publicAppUrl } from "@/lib/runtime-config";
import { buildTransporter, resolveEmailConfig } from "@/lib/email-config";
import { obterFicheiroInfarmed } from "./infarmed-job";
import { EmailNaoConfigurado, type Dependencias, type MensagemEmail, type TenantAlvo } from "./infarmed-atualizacao";

export type TenantAlvoNome = TenantAlvo & { nome: string };

export async function listarTenantsAtivos(opcoes: { onlySlugs?: string[] } = {}): Promise<TenantAlvoNome[]> {
  const control = getControlPrismaCli();
  const rows = await control.tenant.findMany({
    where: { estado: "ACTIVE", ...(opcoes.onlySlugs?.length ? { slug: { in: opcoes.onlySlugs } } : {}) },
    select: { slug: true, nome: true },
    orderBy: { slug: "asc" },
  });
  const out: TenantAlvoNome[] = [];
  for (const t of rows) out.push({ slug: t.slug, nome: t.nome, prisma: await getTenantPrismaOrLegacy(t.slug) });
  return out;
}

export function destinatariosAlerta(env: NodeJS.ProcessEnv = process.env): string[] {
  const bruto = env.INFARMED_IMPORT_ALERT_EMAIL?.trim() || env.PLATFORM_ADMIN_EMAILS || "";
  const vistos = new Set<string>();
  for (const parte of bruto.split(/[,;]/)) {
    const e = parte.trim();
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) vistos.add(e.toLowerCase());
  }
  return [...vistos];
}

export function criarEnviadorEmail(
  tenants: () => Promise<TenantAlvo[]>,
  env: NodeJS.ProcessEnv = process.env,
): (m: MensagemEmail) => Promise<void> {
  return async (m) => {
    const para = destinatariosAlerta(env);
    if (para.length === 0) {
      throw new EmailNaoConfigurado("Sem destinatário: defina INFARMED_IMPORT_ALERT_EMAIL (ou PLATFORM_ADMIN_EMAILS).");
    }
    const fixo = env.INFARMED_ALERT_SMTP_TENANT?.trim();
    const candidatos = (await tenants()).filter((t) => !fixo || t.slug === fixo);
    let cfg: Awaited<ReturnType<typeof resolveEmailConfig>> | null = null;
    for (const t of candidatos) {
      try {
        cfg = await resolveEmailConfig(null, t.prisma);
        break;
      } catch {
        /* este tenant não tem SMTP global ativo — tenta o seguinte */
      }
    }
    if (!cfg) throw new EmailNaoConfigurado("Nenhum tenant ativo tem uma configuração SMTP global ativa.");
    const { transporter, from, replyTo } = buildTransporter(cfg);
    await transporter.sendMail({ from, to: para.join(", "), replyTo, subject: m.assunto, text: m.texto });
  };
}

export function urlPaginaAdmin(): string {
  return `${publicAppUrl() ?? ""}/admin/infarmed`;
}

export function criarDependenciasReais(): Dependencias {
  const tenants = (o?: { onlySlugs?: string[] }) => listarTenantsAtivos(o);
  return {
    control: getControlPrismaCli(),
    tenants,
    obterFicheiro: () => obterFicheiroInfarmed({ urlDireto: process.env.INFARMED_ALLPACKAGES_URL?.trim() || null, urlPagina: process.env.INFARMED_PESQUISA_URL?.trim() || undefined }),
    enviarEmail: criarEnviadorEmail(() => listarTenantsAtivos()),
    urlAdmin: urlPaginaAdmin(),
    log: (m) => console.log(m),
  };
}
