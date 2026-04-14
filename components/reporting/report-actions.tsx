"use client";

/**
 * components/reporting/report-actions.tsx
 *
 * Barra de ações única (Imprimir · PDF · Excel · Email) que consome
 * um Report comum de lib/reporting. Cada página só precisa de produzir
 * um Report (ou uma factory Report) e passar para este componente.
 *
 * O report é passado como função `() => Report` para que seja avaliado
 * no momento do clique — garante que reflecte os filtros actuais do
 * cliente, não o snapshot do primeiro render.
 */

import { useState, useTransition } from "react";
import { FileSpreadsheet, FileText, Mail, Printer, X } from "lucide-react";
import type { Report } from "@/lib/reporting/report-types";
import { printReport } from "@/lib/reporting/report-print";
import { exportPdf } from "@/lib/reporting/report-pdf";
import { exportExcel } from "@/lib/reporting/report-excel";
import { sendReportByEmail } from "@/lib/reporting/report-email";

type ReportSource = Report | (() => Report);

type Props = {
  report: ReportSource;
  className?: string;
  /** Esconde alguma ação específica se não fizer sentido para a página. */
  hide?: Partial<Record<"print" | "pdf" | "excel" | "email", boolean>>;
};

function resolve(src: ReportSource): Report | null {
  try {
    return typeof src === "function" ? src() : src;
  } catch (err) {
    console.error("[report-actions] falha a construir o Report", err);
    return null;
  }
}

function safeRun(label: string, fn: () => void | Promise<void>): void {
  try {
    const r = fn();
    if (r && typeof (r as Promise<void>).catch === "function") {
      (r as Promise<void>).catch((err) => {
        console.error(`[report-actions] falha async em "${label}"`, err);
      });
    }
  } catch (err) {
    console.error(`[report-actions] falha em "${label}"`, err);
  }
}

const btn =
  "inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium " +
  "rounded-md border border-gray-300 text-gray-700 bg-white " +
  "hover:bg-gray-50 hover:border-gray-400 transition-colors";

export function ReportActions({ report, className, hide }: Props) {
  const [emailOpen, setEmailOpen] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);

  return (
    <>
      <div className={`flex items-center gap-2 ${className ?? ""}`}>
        {!hide?.print && (
          <button
            type="button"
            className={btn}
            onClick={() =>
              safeRun("print", () => {
                const r = resolve(report);
                if (r) printReport(r);
              })
            }
          >
            <Printer className="w-3.5 h-3.5" />
            Imprimir
          </button>
        )}
        {!hide?.pdf && (
          <button
            type="button"
            className={btn}
            disabled={pdfBusy}
            onClick={() =>
              safeRun("pdf", async () => {
                const r = resolve(report);
                if (!r) return;
                setPdfBusy(true);
                try {
                  await exportPdf(r);
                } finally {
                  setPdfBusy(false);
                }
              })
            }
          >
            <FileText className="w-3.5 h-3.5" />
            {pdfBusy ? "A gerar…" : "PDF"}
          </button>
        )}
        {!hide?.excel && (
          <button
            type="button"
            className={btn}
            onClick={() =>
              safeRun("excel", () => {
                const r = resolve(report);
                if (r) exportExcel(r);
              })
            }
          >
            <FileSpreadsheet className="w-3.5 h-3.5" />
            Excel
          </button>
        )}
        {!hide?.email && (
          <button type="button" className={btn} onClick={() => setEmailOpen(true)}>
            <Mail className="w-3.5 h-3.5" />
            Email
          </button>
        )}
      </div>

      {emailOpen && (
        <EmailDialog
          reportSource={report}
          onClose={() => setEmailOpen(false)}
        />
      )}
    </>
  );
}

// ─── Diálogo de email ────────────────────────────────────────────────────────

type DialogProps = {
  reportSource: ReportSource;
  onClose: () => void;
};

function EmailDialog({ reportSource, onClose }: DialogProps) {
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [includePdf, setIncludePdf] = useState(true);
  const [includeExcel, setIncludeExcel] = useState(true);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  const handleSend = () => {
    setFeedback(null);
    const recipients = to
      .split(/[,;]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (recipients.length === 0) {
      setFeedback({ kind: "err", text: "Indique pelo menos um destinatário." });
      return;
    }
    const formats: Array<"pdf" | "excel"> = [];
    if (includePdf) formats.push("pdf");
    if (includeExcel) formats.push("excel");

    const resolvedReport = resolve(reportSource);
    if (!resolvedReport) {
      setFeedback({ kind: "err", text: "Não foi possível construir o relatório." });
      return;
    }
    startTransition(async () => {
      try {
        const result = await sendReportByEmail(resolvedReport, {
          to: recipients,
          subject: subject.trim() || undefined,
          message: message.trim() || undefined,
          attachFormats: formats,
        });
        if (result.ok) {
          setFeedback({
            kind: "ok",
            text: result.messageId
              ? `Email enviado (id: ${result.messageId}).`
              : "Email enviado.",
          });
          setTimeout(onClose, 1500);
        } else {
          setFeedback({ kind: "err", text: result.error ?? "Falha no envio." });
        }
      } catch (err) {
        setFeedback({
          kind: "err",
          text: err instanceof Error ? err.message : "Erro inesperado.",
        });
      }
    });
  };

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg relative">
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200">
          <h3 className="text-base font-semibold text-gray-900">Enviar relatório por email</h3>
          <button
            type="button"
            className="text-gray-400 hover:text-gray-600"
            onClick={onClose}
            aria-label="Fechar"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3">
          <label className="block">
            <span className="block text-xs font-medium text-gray-600 mb-1">
              Destinatários (separe por vírgula)
            </span>
            <input
              type="text"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="nome@dominio.pt, outro@dominio.pt"
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
            />
          </label>

          <label className="block">
            <span className="block text-xs font-medium text-gray-600 mb-1">Assunto</span>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="(opcional — usa o título do relatório)"
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
            />
          </label>

          <label className="block">
            <span className="block text-xs font-medium text-gray-600 mb-1">Mensagem</span>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
              placeholder="(opcional)"
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500"
            />
          </label>

          <div className="flex items-center gap-4 pt-1">
            <label className="inline-flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={includePdf}
                onChange={(e) => setIncludePdf(e.target.checked)}
              />
              Anexar PDF
            </label>
            <label className="inline-flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={includeExcel}
                onChange={(e) => setIncludeExcel(e.target.checked)}
              />
              Anexar Excel
            </label>
          </div>

          {feedback && (
            <div
              className={`text-sm px-3 py-2 rounded ${
                feedback.kind === "ok"
                  ? "bg-green-50 text-green-700 border border-green-200"
                  : "bg-red-50 text-red-700 border border-red-200"
              }`}
            >
              {feedback.text}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-gray-200 bg-gray-50 rounded-b-lg">
          <button
            type="button"
            className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded"
            onClick={onClose}
            disabled={isPending}
          >
            Cancelar
          </button>
          <button
            type="button"
            className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
            onClick={handleSend}
            disabled={isPending || to.trim().length === 0}
          >
            {isPending ? "A enviar…" : "Enviar"}
          </button>
        </div>
      </div>
    </div>
  );
}
