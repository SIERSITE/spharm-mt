/**
 * lib/reporting/report-filename.ts
 *
 * Convenção única de nomes de ficheiro para exports.
 * Formato: <slug>-YYYYMMDD-HHMM.<ext>
 */

import type { Report } from "./report-types";

export function slugify(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function pad(n: number, len = 2): string {
  return String(n).padStart(len, "0");
}

function timestamp(d: Date): string {
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}`
  );
}

export function makeReportFilename(report: Report, ext: string): string {
  const slug = report.meta?.slug ?? slugify(report.title);
  const ts = timestamp(report.generatedAt ?? new Date());
  return `${slug || "relatorio"}-${ts}.${ext.replace(/^\./, "")}`;
}
