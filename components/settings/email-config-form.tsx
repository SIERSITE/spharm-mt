"use client";

import { useState, useTransition } from "react";

type ConfigShape = {
  smtpHost: string;
  smtpPort: number;
  smtpUser: string | null;
  hasPassword: boolean;
  smtpSecure: boolean;
  fromEmail: string;
  fromName: string | null;
  replyTo: string | null;
  isActive: boolean;
  lastTestAt: Date | string | null;
  lastTestStatus: string | null;
  lastTestError: string | null;
};

type Props = {
  scope: "farmacia" | "global";
  initial: ConfigShape | null;
};

const inputCls =
  "w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500";
const labelCls = "block text-xs font-medium text-gray-600 mb-1";

export function EmailConfigForm({ scope, initial }: Props) {
  const [smtpHost, setSmtpHost] = useState(initial?.smtpHost ?? "");
  const [smtpPort, setSmtpPort] = useState(String(initial?.smtpPort ?? 587));
  const [smtpUser, setSmtpUser] = useState(initial?.smtpUser ?? "");
  const [smtpPass, setSmtpPass] = useState("");
  const [smtpSecure, setSmtpSecure] = useState(initial?.smtpSecure ?? false);
  const [fromEmail, setFromEmail] = useState(initial?.fromEmail ?? "");
  const [fromName, setFromName] = useState(initial?.fromName ?? "");
  const [replyTo, setReplyTo] = useState(initial?.replyTo ?? "");
  const [isActive, setIsActive] = useState(initial?.isActive ?? true);
  const hasPassword = !!initial?.hasPassword;

  const [testTo, setTestTo] = useState("");
  const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const qs = `?scope=${scope}`;

  const handleSave = () => {
    setFeedback(null);
    startTransition(async () => {
      const res = await fetch(`/api/settings/email${qs}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          smtpHost,
          smtpPort: Number(smtpPort),
          smtpUser: smtpUser || null,
          smtpPass: smtpPass || null, // vazio = manter actual
          smtpSecure,
          fromEmail,
          fromName: fromName || null,
          replyTo: replyTo || null,
          isActive,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setFeedback({ kind: "ok", text: "Configuração guardada." });
        setSmtpPass("");
      } else {
        setFeedback({ kind: "err", text: data.error ?? "Falha a guardar." });
      }
    });
  };

  const handleTest = () => {
    setFeedback(null);
    if (!testTo.trim()) {
      setFeedback({ kind: "err", text: "Indica um email destino para o teste." });
      return;
    }
    startTransition(async () => {
      const res = await fetch(`/api/settings/email/test${qs}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: testTo.trim() }),
      });
      const data = await res.json();
      if (data.ok) {
        setFeedback({
          kind: "ok",
          text: `Email de teste enviado${data.messageId ? ` (id: ${data.messageId})` : ""}.`,
        });
      } else {
        setFeedback({ kind: "err", text: data.error ?? "Teste falhou." });
      }
    });
  };

  return (
    <div className="space-y-4 rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="sm:col-span-2">
          <label className={labelCls}>Servidor SMTP</label>
          <input className={inputCls} value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} placeholder="smtp.exemplo.pt" />
        </div>
        <div>
          <label className={labelCls}>Porta</label>
          <input className={inputCls} type="number" value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className={labelCls}>Utilizador</label>
          <input className={inputCls} value={smtpUser ?? ""} onChange={(e) => setSmtpUser(e.target.value)} autoComplete="off" />
        </div>
        <div>
          <label className={labelCls}>
            Password {hasPassword && <span className="text-emerald-600">(definida — deixar vazio mantém)</span>}
          </label>
          <input
            className={inputCls}
            type="password"
            value={smtpPass}
            onChange={(e) => setSmtpPass(e.target.value)}
            placeholder={hasPassword ? "••••••••" : ""}
            autoComplete="new-password"
          />
        </div>
      </div>

      <label className="inline-flex items-center gap-2 text-sm">
        <input type="checkbox" checked={smtpSecure} onChange={(e) => setSmtpSecure(e.target.checked)} />
        Ligação segura SSL/TLS (porta 465). Se desligado, usa STARTTLS.
      </label>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className={labelCls}>From — email</label>
          <input className={inputCls} value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} placeholder="no-reply@dominio.pt" />
        </div>
        <div>
          <label className={labelCls}>From — nome</label>
          <input className={inputCls} value={fromName ?? ""} onChange={(e) => setFromName(e.target.value)} placeholder="SPharm.MT" />
        </div>
      </div>

      <div>
        <label className={labelCls}>Reply-To (opcional)</label>
        <input className={inputCls} value={replyTo ?? ""} onChange={(e) => setReplyTo(e.target.value)} />
      </div>

      <label className="inline-flex items-center gap-2 text-sm">
        <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
        Configuração activa (caso contrário o sistema cai no fallback global)
      </label>

      {initial?.lastTestAt && (
        <div className="text-xs text-gray-500">
          Último teste: {new Date(initial.lastTestAt).toLocaleString("pt-PT")} —{" "}
          <span className={initial.lastTestStatus === "ok" ? "text-emerald-600" : "text-red-600"}>
            {initial.lastTestStatus}
          </span>
          {initial.lastTestError ? ` · ${initial.lastTestError}` : ""}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-gray-200 pt-4">
        <button
          type="button"
          onClick={handleSave}
          disabled={pending}
          className="rounded bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {pending ? "A guardar…" : "Guardar"}
        </button>

        <div className="flex flex-1 items-center gap-2">
          <input
            className={inputCls + " max-w-xs"}
            placeholder="email para teste"
            value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
          />
          <button
            type="button"
            onClick={handleTest}
            disabled={pending}
            className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            Enviar teste
          </button>
        </div>
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
  );
}
