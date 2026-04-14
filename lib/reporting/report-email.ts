/**
 * lib/reporting/report-email.ts
 *
 * CLIENT: wrapper de `POST /api/reports/email` que envia o relatório
 * real por email com os anexos pedidos (Excel e/ou PDF).
 *
 * O endpoint server gera os anexos a partir do MESMO Report que o
 * browser já tem em memória — usa `buildReportWorkbook()` para o
 * Excel e `buildReportPdfBuffer()` (puppeteer) para o PDF. Nenhuma
 * credencial SMTP passa pelo cliente.
 */

import type { Report } from "./report-types";

export type ReportAttachmentFormat = "pdf" | "excel";

export type SendReportByEmailOptions = {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  message?: string;
  /** Formatos a incluir em anexo. Omitir / [] envia sem anexos. */
  attachFormats?: ReportAttachmentFormat[];
};

export type SendReportByEmailResult = {
  ok: boolean;
  messageId?: string;
  error?: string;
};

export async function sendReportByEmail(
  report: Report,
  options: SendReportByEmailOptions
): Promise<SendReportByEmailResult> {
  try {
    const res = await fetch("/api/reports/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...options, report }),
    });
    const data = (await res.json().catch(() => null)) as SendReportByEmailResult | null;
    if (!res.ok) {
      return {
        ok: false,
        error: data?.error ?? `HTTP ${res.status}`,
      };
    }
    return data ?? { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Erro de rede",
    };
  }
}
