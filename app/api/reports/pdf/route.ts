/**
 * app/api/reports/pdf/route.ts
 *
 * POST /api/reports/pdf
 * Body: Report (JSON serializado)
 * Response: application/pdf (binary)
 *
 * Usa puppeteer para renderizar o MESMO HTML de renderReportHtml(report)
 * num Chromium headless e devolver o PDF. O layout A4/landscape vem do
 * CSS @page do próprio HTML — a rota só replica a orientação no
 * `page.pdf()` para corresponder.
 */

import { buildReportPdfBuffer } from "@/lib/reporting/report-pdf-server";
import type { Report } from "@/lib/reporting/report-types";

// Forçar Node runtime — puppeteer não corre em Edge.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let report: Report;
  try {
    report = (await request.json()) as Report;
  } catch {
    return Response.json({ error: "Body inválido (JSON esperado)" }, { status: 400 });
  }

  if (!report || !report.title || !Array.isArray(report.columns) || !Array.isArray(report.rows)) {
    return Response.json({ error: "Report mal formado" }, { status: 400 });
  }

  // Re-hidratar `generatedAt` — JSON.stringify transformou-o em string
  if (typeof report.generatedAt === "string") {
    const d = new Date(report.generatedAt);
    if (!isNaN(d.getTime())) report.generatedAt = d;
  }
  if (!(report.generatedAt instanceof Date)) {
    report.generatedAt = new Date();
  }

  try {
    const { buffer, filename, mime } = await buildReportPdfBuffer(report);
    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": mime,
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(buffer.length),
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("[api/reports/pdf] falha a gerar PDF", err);
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: `Falha a gerar PDF: ${msg}` }, { status: 500 });
  }
}
