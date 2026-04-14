/**
 * lib/reporting/report-pdf-server.ts
 *
 * SERVER-ONLY: usa puppeteer para gerar um PDF a partir do HTML
 * produzido por `renderReportHtml(report)`. Nunca importar num Client
 * Component — puxaria o Chromium para o bundle.
 *
 * O browser instance é mantido em cache module-level (singleton) para
 * amortizar o custo de arranque do Chromium — fazer launch+close a
 * cada pedido demora 2–4s cada, enquanto reutilizar ronda os 300ms.
 */

import "server-only";
import puppeteer, { type Browser } from "puppeteer";
import type { Report } from "./report-types";
import { renderReportHtml } from "./report-html";
import { makeReportFilename } from "./report-filename";

// ─── Singleton browser ────────────────────────────────────────────────────────

let browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (browserPromise) {
    try {
      const existing = await browserPromise;
      if (existing.connected) return existing;
    } catch {
      // Fall through — reinicia
    }
  }
  browserPromise = puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });
  return browserPromise;
}

// Cleanup em shutdown do processo (dev server reload, SIGINT…)
if (typeof process !== "undefined") {
  const close = async () => {
    try {
      if (browserPromise) {
        const b = await browserPromise;
        await b.close();
      }
    } catch {
      /* ignore */
    }
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  process.once("beforeExit", close);
}

// ─── Geração do PDF ───────────────────────────────────────────────────────────

export type PdfResult = {
  buffer: Buffer;
  filename: string;
  mime: string;
};

export async function buildReportPdfBuffer(report: Report): Promise<PdfResult> {
  const html = renderReportHtml(report);
  const landscape = report.meta?.orientation === "landscape";

  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.emulateMediaType("print");
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 30_000 });

    const pdfBytes = await page.pdf({
      format: "A4",
      landscape,
      printBackground: true,
      preferCSSPageSize: true,
      margin: {
        top: "10mm",
        right: "8mm",
        bottom: "10mm",
        left: "8mm",
      },
    });

    // puppeteer devolve Uint8Array em versões recentes — normalizar para Buffer
    const buffer = Buffer.isBuffer(pdfBytes) ? pdfBytes : Buffer.from(pdfBytes);

    return {
      buffer,
      filename: makeReportFilename(report, "pdf"),
      mime: "application/pdf",
    };
  } finally {
    await page.close().catch(() => {});
  }
}
