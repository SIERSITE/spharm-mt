/**
 * app/api/reports/email/route.ts
 *
 * POST /api/reports/email
 * Body:
 *   {
 *     report: Report,
 *     to: string[],
 *     cc?: string[],
 *     bcc?: string[],
 *     subject?: string,
 *     message?: string,
 *     attachFormats?: ("pdf" | "excel")[]
 *   }
 *
 * Response:
 *   { ok: true,  messageId: string }
 *   { ok: false, error: string }
 *
 * Gera os anexos server-side (mesma estrutura Report, mesmo código que
 * o download no browser) e despacha via nodemailer.
 */

import { buildReportPdfBuffer } from "@/lib/reporting/report-pdf-server";
import { buildReportExcelBuffer } from "@/lib/reporting/report-excel-buffer";
import { getMailerForFarmacia } from "@/lib/reporting/report-email-transport";
import { getSession } from "@/lib/auth";
import { aplicarPrivacidade } from "@/lib/reporting/privacidade";
import type { Report } from "@/lib/reporting/report-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type EmailPayload = {
  report: Report;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  message?: string;
  attachFormats?: Array<"pdf" | "excel">;
};

function isValidEmail(e: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());
}

function normalizeList(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((s): s is string => typeof s === "string")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function POST(request: Request): Promise<Response> {
  let payload: EmailPayload;
  try {
    payload = (await request.json()) as EmailPayload;
  } catch {
    return Response.json({ ok: false, error: "Body inválido (JSON esperado)" }, { status: 400 });
  }

  // ─── Validação de destinatários ───────────────────────────────────────────
  const to = normalizeList(payload.to);
  const cc = normalizeList(payload.cc);
  const bcc = normalizeList(payload.bcc);
  if (to.length === 0) {
    return Response.json({ ok: false, error: "Sem destinatários" }, { status: 400 });
  }
  const invalid = [...to, ...cc, ...bcc].filter((e) => !isValidEmail(e));
  if (invalid.length > 0) {
    return Response.json(
      { ok: false, error: `Endereços inválidos: ${invalid.join(", ")}` },
      { status: 400 }
    );
  }

  // ─── Validação do Report ──────────────────────────────────────────────────
  const recebido = payload.report;
  if (!recebido || !recebido.title || !Array.isArray(recebido.columns) || !Array.isArray(recebido.rows)) {
    return Response.json({ ok: false, error: "Report mal formado" }, { status: 400 });
  }
  if (typeof recebido.generatedAt === "string") {
    const d = new Date(recebido.generatedAt);
    if (!isNaN(d.getTime())) recebido.generatedAt = d;
  }
  if (!(recebido.generatedAt instanceof Date)) {
    recebido.generatedAt = new Date();
  }
  // Privacidade validada NO SERVIDOR: preços de venda/compra que o utilizador não quis partilhar são retirados do relatório antes
  // de gerar o PDF E o Excel anexos (os dois saem do mesmo relatório, já sem essa informação) — ver lib/reporting/privacidade.ts.
  const report = aplicarPrivacidade(recebido);

  const formats = (payload.attachFormats ?? []).filter(
    (f): f is "pdf" | "excel" => f === "pdf" || f === "excel"
  );

  // ─── Transportador (resolve por farmácia da sessão; fallback global) ──────
  const session = await getSession();
  let mailer: Awaited<ReturnType<typeof getMailerForFarmacia>>;
  try {
    mailer = await getMailerForFarmacia(session?.farmaciaId ?? null);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }

  // ─── Construção de anexos em paralelo ─────────────────────────────────────
  type Attachment = { filename: string; content: Buffer; contentType: string };
  const attachments: Attachment[] = [];
  try {
    const jobs: Promise<Attachment>[] = [];
    if (formats.includes("pdf")) {
      jobs.push(
        buildReportPdfBuffer(report).then((r) => ({
          filename: r.filename,
          content: r.buffer,
          contentType: r.mime,
        }))
      );
    }
    if (formats.includes("excel")) {
      const xlsx = buildReportExcelBuffer(report);
      jobs.push(
        Promise.resolve({
          filename: xlsx.filename,
          content: xlsx.buffer,
          contentType: xlsx.mime,
        })
      );
    }
    const resolved = await Promise.all(jobs);
    attachments.push(...resolved);
  } catch (err) {
    console.error("[api/reports/email] falha a gerar anexos", err);
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json(
      { ok: false, error: `Falha a gerar anexos: ${msg}` },
      { status: 500 }
    );
  }

  // ─── Envio ────────────────────────────────────────────────────────────────
  const subject = payload.subject?.trim() || `Relatório: ${report.title}`;
  const bodyText =
    (payload.message?.trim() ? payload.message.trim() + "\n\n" : "") +
    `Relatório: ${report.title}\n` +
    (report.subtitle ? `${report.subtitle}\n` : "") +
    `${report.meta?.tableNote ? `Conteúdo: ${report.meta.tableNote}` : `Linhas: ${report.rows.length}`}\n` +
    `Gerado em: ${report.generatedAt.toISOString()}\n` +
    (attachments.length > 0
      ? `\nAnexos: ${attachments.map((a) => a.filename).join(", ")}\n`
      : "\n(sem anexos)\n") +
    `\n—\nSPharm.MT`;

  try {
    const info = await mailer.transporter.sendMail({
      from: mailer.from,
      replyTo: mailer.replyTo,
      to,
      cc: cc.length ? cc : undefined,
      bcc: bcc.length ? bcc : undefined,
      subject,
      text: bodyText,
      attachments,
    });
    return Response.json({ ok: true, messageId: info.messageId });
  } catch (err) {
    console.error("[api/reports/email] falha no sendMail", err);
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ ok: false, error: `Envio falhou: ${msg}` }, { status: 500 });
  }
}
