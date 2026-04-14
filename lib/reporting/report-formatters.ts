/**
 * lib/reporting/report-formatters.ts
 *
 * Formatadores PT-PT partilhados entre HTML, print, Excel e email.
 * Usar sempre estes helpers — nunca inlined toFixed/toLocaleString.
 */

import type { ReportCell, ReportFormat } from "./report-types";

const LOCALE = "pt-PT";
const CURRENCY = "EUR";

const currencyFmt = new Intl.NumberFormat(LOCALE, {
  style: "currency",
  currency: CURRENCY,
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const numberFmt = new Intl.NumberFormat(LOCALE, {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

const integerFmt = new Intl.NumberFormat(LOCALE, {
  maximumFractionDigits: 0,
});

const percentFmt = new Intl.NumberFormat(LOCALE, {
  style: "percent",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

const dateFmt = new Intl.DateTimeFormat(LOCALE, {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const dateTimeFmt = new Intl.DateTimeFormat(LOCALE, {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

function toDate(v: unknown): Date | null {
  if (v instanceof Date) return v;
  if (typeof v === "string" || typeof v === "number") {
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function formatCurrency(v: unknown): string {
  const n = toNumber(v);
  return n === null ? "—" : currencyFmt.format(n);
}

export function formatNumber(v: unknown): string {
  const n = toNumber(v);
  return n === null ? "—" : numberFmt.format(n);
}

export function formatInteger(v: unknown): string {
  const n = toNumber(v);
  return n === null ? "—" : integerFmt.format(n);
}

export function formatPercent(v: unknown): string {
  const n = toNumber(v);
  if (n === null) return "—";
  // Convenção: valores <= 1 tratados como fração (0.25 → 25%);
  // valores > 1 já vêm em pontos percentuais (25 → 25%)
  return percentFmt.format(Math.abs(n) <= 1 ? n : n / 100);
}

export function formatDate(v: unknown): string {
  const d = toDate(v);
  return d ? dateFmt.format(d) : "—";
}

export function formatDateTime(v: unknown): string {
  const d = toDate(v);
  return d ? dateTimeFmt.format(d) : "—";
}

/**
 * Dispatcher central — todo o render textual de células passa por aqui.
 * Valores null/undefined/"" viram "—" uniformemente.
 */
export function formatCell(value: ReportCell, format?: ReportFormat): string {
  if (value === null || value === undefined || value === "") return "—";
  switch (format) {
    case "currency": return formatCurrency(value);
    case "number":   return formatNumber(value);
    case "integer":  return formatInteger(value);
    case "percent":  return formatPercent(value);
    case "date":     return formatDate(value);
    case "datetime": return formatDateTime(value);
    case "text":
    default:
      return String(value);
  }
}

/**
 * Padrão de formato Excel por ReportFormat (z attribute).
 * Documentação SheetJS: https://docs.sheetjs.com/docs/csf/features/nf
 */
export function excelNumberFormat(format: ReportFormat | undefined): string | undefined {
  switch (format) {
    case "currency": return '#,##0.00 "€"';
    case "number":   return "#,##0.00";
    case "integer":  return "#,##0";
    case "percent":  return "0.00%";
    case "date":     return "dd/mm/yyyy";
    case "datetime": return "dd/mm/yyyy hh:mm";
    default:         return undefined;
  }
}
