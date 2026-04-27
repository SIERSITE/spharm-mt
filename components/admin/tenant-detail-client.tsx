"use client";

import { useState, useTransition } from "react";
import {
  updateTenantMetadataAction,
  transitionTenantStateAction,
  rotateIngestKeyAction,
  createFarmaciaInTenantAction,
  updateFarmaciaInTenantAction,
  adminRetryOutboxAction,
  adminCancelOutboxAction,
} from "@/app/admin/actions";
import type {
  TenantOverviewRow,
  TenantFarmaciaRow,
  TenantOutboxCounters,
  TenantFailedOrderRow,
} from "@/lib/admin/tenant-data";

type Tab = "overview" | "farmacias" | "agent" | "outbox";

type Props = {
  tenantId: string;
  overview: TenantOverviewRow;
  farmacias: TenantFarmaciaRow[];
  outboxCounters: TenantOutboxCounters;
  failedOrders: TenantFailedOrderRow[];
};

export function TenantDetailClient(props: Props) {
  const [tab, setTab] = useState<Tab>("overview");
  const [flash, setFlash] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  return (
    <div className="space-y-5">
      <Tabs current={tab} onChange={setTab} />

      {flash && (
        <div
          className={`rounded-md border px-3 py-2 text-[12px] ${
            flash.kind === "ok"
              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
              : "border-rose-200 bg-rose-50 text-rose-700"
          }`}
        >
          {flash.msg}
        </div>
      )}

      {tab === "overview" && (
        <OverviewTab
          tenantId={props.tenantId}
          overview={props.overview}
          setFlash={setFlash}
        />
      )}
      {tab === "farmacias" && (
        <FarmaciasTab
          tenantId={props.tenantId}
          initial={props.farmacias}
          setFlash={setFlash}
        />
      )}
      {tab === "agent" && (
        <AgentTab
          tenantId={props.tenantId}
          overview={props.overview}
          setFlash={setFlash}
        />
      )}
      {tab === "outbox" && (
        <OutboxTab
          tenantId={props.tenantId}
          counters={props.outboxCounters}
          failedOrders={props.failedOrders}
          setFlash={setFlash}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Tabs nav
// ─────────────────────────────────────────────────────────────

function Tabs({ current, onChange }: { current: Tab; onChange: (t: Tab) => void }) {
  const items: Array<{ key: Tab; label: string }> = [
    { key: "overview", label: "Visão geral" },
    { key: "farmacias", label: "Farmácias" },
    { key: "agent", label: "Agent / API key" },
    { key: "outbox", label: "Outbox" },
  ];
  return (
    <div className="flex gap-1 border-b border-slate-200">
      {items.map((it) => (
        <button
          key={it.key}
          onClick={() => onChange(it.key)}
          className={`px-4 py-2 text-[13px] font-medium transition ${
            current === it.key
              ? "border-b-2 border-slate-900 text-slate-900"
              : "text-slate-500 hover:text-slate-700"
          }`}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// OVERVIEW TAB
// ─────────────────────────────────────────────────────────────

type FlashFn = (
  v: { kind: "ok" | "err"; msg: string } | null
) => void;

function OverviewTab({
  tenantId,
  overview,
  setFlash,
}: {
  tenantId: string;
  overview: TenantOverviewRow;
  setFlash: FlashFn;
}) {
  const [busy, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [nome, setNome] = useState(overview.nome);
  const [slug, setSlug] = useState(overview.slug);

  function save() {
    startTransition(async () => {
      const r = await updateTenantMetadataAction(tenantId, {
        nome,
        slug,
        nifGrupo: null,
      });
      if (r.ok) {
        setEditing(false);
        setFlash({
          kind: "ok",
          msg:
            "warning" in r && typeof (r as { warning?: string }).warning === "string"
              ? `Guardado. ${(r as { warning: string }).warning}`
              : "Guardado.",
        });
      } else {
        setFlash({ kind: "err", msg: r.error });
      }
    });
  }

  function transition(next: "ACTIVE" | "SUSPENDED" | "DEACTIVATED") {
    if (!confirm(`Transitar para ${next}?`)) return;
    startTransition(async () => {
      const r = await transitionTenantStateAction(tenantId, next);
      if (r.ok) {
        setFlash({ kind: "ok", msg: `Estado alterado para ${next}.` });
      } else {
        setFlash({ kind: "err", msg: r.error });
      }
    });
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card title="Identificação">
        {editing ? (
          <div className="space-y-2">
            <LabelInput label="Nome" value={nome} onChange={setNome} />
            <LabelInput label="Slug" value={slug} onChange={setSlug} mono />
            <div className="flex gap-2 pt-2">
              <button
                onClick={save}
                disabled={busy}
                className="rounded-lg bg-slate-900 px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-50"
              >
                Guardar
              </button>
              <button
                onClick={() => {
                  setEditing(false);
                  setNome(overview.nome);
                  setSlug(overview.slug);
                }}
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-[12px] font-medium text-slate-600"
              >
                Cancelar
              </button>
            </div>
          </div>
        ) : (
          <>
            <Field k="Nome" v={overview.nome} />
            <Field k="Slug" v={overview.slug} mono />
            <Field k="Estado" v={overview.estado.toLowerCase()} />
            <Field k="Criado" v={new Date(overview.createdAt).toLocaleString("pt-PT")} />
            <button
              onClick={() => setEditing(true)}
              className="mt-2 text-[11px] font-medium text-cyan-700 hover:underline"
            >
              Editar
            </button>
          </>
        )}
      </Card>

      <Card title="Base de dados">
        <Field k="Host" v={overview.dbHost} />
        <Field k="Database" v={overview.dbName} />
        <Field k="Schema migration" v={overview.schemaVersion ?? "—"} />
        <Field
          k="Última health check"
          v={
            overview.lastHealthCheckAt
              ? new Date(overview.lastHealthCheckAt).toLocaleString("pt-PT")
              : "—"
          }
        />
        <Field k="Última status" v={overview.lastHealthStatus ?? "—"} />
        <p className="mt-2 text-[11px] text-slate-500">
          Rotação de password / aplicar migrations: usar CLI{" "}
          <code className="rounded bg-slate-100 px-1">npm run tenancy:*</code>.
        </p>
      </Card>

      <Card title="Transições de estado" wide>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => transition("ACTIVE")}
            disabled={busy || overview.estado === "ACTIVE"}
            className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-[12px] font-medium text-emerald-700 disabled:opacity-30"
          >
            Activar
          </button>
          <button
            onClick={() => transition("SUSPENDED")}
            disabled={busy || overview.estado !== "ACTIVE"}
            className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-[12px] font-medium text-amber-700 disabled:opacity-30"
          >
            Suspender
          </button>
          <button
            onClick={() => transition("DEACTIVATED")}
            disabled={
              busy || (overview.estado !== "ACTIVE" && overview.estado !== "SUSPENDED")
            }
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-[12px] font-medium text-slate-700 disabled:opacity-30"
          >
            Desactivar
          </button>
        </div>
        <p className="mt-2 text-[11px] text-slate-500">
          Transições válidas: PROVISIONING→ACTIVE, ACTIVE↔SUSPENDED, ACTIVE/SUSPENDED→DEACTIVATED.
        </p>
      </Card>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// FARMACIAS TAB
// ─────────────────────────────────────────────────────────────

function FarmaciasTab({
  tenantId,
  initial,
  setFlash,
}: {
  tenantId: string;
  initial: TenantFarmaciaRow[];
  setFlash: FlashFn;
}) {
  const [busy, startTransition] = useTransition();
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  function create(fd: FormData) {
    startTransition(async () => {
      const r = await createFarmaciaInTenantAction(tenantId, {
        nome: String(fd.get("nome") ?? ""),
        codigoANF: (String(fd.get("codigoANF") ?? "").trim() || null) as string | null,
        morada: (String(fd.get("morada") ?? "").trim() || null) as string | null,
        contacto: (String(fd.get("contacto") ?? "").trim() || null) as string | null,
      });
      if (r.ok) {
        setFlash({ kind: "ok", msg: "Farmácia criada." });
        setCreating(false);
      } else {
        setFlash({ kind: "err", msg: r.error });
      }
    });
  }

  function update(farmaciaId: string, fd: FormData) {
    startTransition(async () => {
      const r = await updateFarmaciaInTenantAction(tenantId, farmaciaId, {
        nome: String(fd.get("nome") ?? ""),
        codigoANF: (String(fd.get("codigoANF") ?? "").trim() || null) as string | null,
        morada: (String(fd.get("morada") ?? "").trim() || null) as string | null,
        contacto: (String(fd.get("contacto") ?? "").trim() || null) as string | null,
        estado: (String(fd.get("estado") ?? "ATIVO") as "ATIVO" | "INATIVO"),
      });
      if (r.ok) {
        setFlash({ kind: "ok", msg: "Farmácia actualizada." });
        setEditingId(null);
      } else {
        setFlash({ kind: "err", msg: r.error });
      }
    });
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
          <h2 className="text-[14px] font-semibold text-slate-900">
            {initial.length} {initial.length === 1 ? "farmácia" : "farmácias"}
          </h2>
          <button
            onClick={() => setCreating((v) => !v)}
            className="rounded-lg bg-slate-900 px-3 py-1.5 text-[12px] font-medium text-white"
          >
            {creating ? "Fechar" : "+ Nova"}
          </button>
        </div>
        {creating && (
          <form
            action={create}
            className="grid gap-3 border-b border-slate-100 px-5 py-4 md:grid-cols-2"
          >
            <Input name="nome" label="Nome" required />
            <Input name="codigoANF" label="Código ANF" />
            <Input name="morada" label="Morada" />
            <Input name="contacto" label="Contacto" />
            <div className="md:col-span-2 flex justify-end">
              <button
                type="submit"
                disabled={busy}
                className="rounded-lg bg-cyan-600 px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-50"
              >
                Criar
              </button>
            </div>
          </form>
        )}

        {initial.length === 0 ? (
          <div className="px-5 py-6 text-center text-[12px] text-slate-500">
            Sem farmácias neste tenant. Cria a primeira acima.
          </div>
        ) : (
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-slate-100 text-left text-[10px] uppercase tracking-wider text-slate-400">
                <th className="px-5 py-2">Nome</th>
                <th className="py-2">ANF</th>
                <th className="py-2">Morada</th>
                <th className="py-2">Contacto</th>
                <th className="py-2">Estado</th>
                <th className="py-2 pr-5"></th>
              </tr>
            </thead>
            <tbody>
              {initial.map((f) =>
                editingId === f.id ? (
                  <tr key={f.id} className="border-b border-slate-50">
                    <td colSpan={6} className="px-5 py-4">
                      <form
                        action={(fd) => update(f.id, fd)}
                        className="grid gap-3 md:grid-cols-2"
                      >
                        <Input name="nome" label="Nome" defaultValue={f.nome} required />
                        <Input
                          name="codigoANF"
                          label="Código ANF"
                          defaultValue={f.codigoANF ?? ""}
                        />
                        <Input
                          name="morada"
                          label="Morada"
                          defaultValue={f.morada ?? ""}
                        />
                        <Input
                          name="contacto"
                          label="Contacto"
                          defaultValue={f.contacto ?? ""}
                        />
                        <Select
                          name="estado"
                          label="Estado"
                          defaultValue={f.estado}
                          options={[
                            { value: "ATIVO", label: "Activo" },
                            { value: "INATIVO", label: "Inactivo" },
                          ]}
                        />
                        <div className="flex items-end justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => setEditingId(null)}
                            className="rounded-lg border border-slate-200 px-3 py-1.5 text-[12px] text-slate-600"
                          >
                            Cancelar
                          </button>
                          <button
                            type="submit"
                            disabled={busy}
                            className="rounded-lg bg-cyan-600 px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-50"
                          >
                            Guardar
                          </button>
                        </div>
                      </form>
                    </td>
                  </tr>
                ) : (
                  <tr key={f.id} className="border-b border-slate-50 last:border-b-0">
                    <td className="px-5 py-2 font-medium text-slate-800">{f.nome}</td>
                    <td className="py-2 text-slate-500">{f.codigoANF ?? "—"}</td>
                    <td className="py-2 text-slate-500">{f.morada ?? "—"}</td>
                    <td className="py-2 text-slate-500">{f.contacto ?? "—"}</td>
                    <td className="py-2 text-slate-500">{f.estado.toLowerCase()}</td>
                    <td className="py-2 pr-5 text-right">
                      <button
                        onClick={() => setEditingId(f.id)}
                        className="text-[11px] font-medium text-cyan-700 hover:underline"
                      >
                        Editar
                      </button>
                    </td>
                  </tr>
                )
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// AGENT / API KEY TAB
// ─────────────────────────────────────────────────────────────

function AgentTab({
  tenantId,
  overview,
  setFlash,
}: {
  tenantId: string;
  overview: TenantOverviewRow;
  setFlash: FlashFn;
}) {
  const [busy, startTransition] = useTransition();
  const [revealed, setRevealed] = useState<string | null>(null);

  function rotate() {
    if (
      overview.ingestKeyConfigured &&
      !confirm(
        "Rotar a key invalida a key actual imediatamente — o agent vai começar a receber 401 até ser reconfigurado. Continuar?"
      )
    ) {
      return;
    }
    startTransition(async () => {
      const r = await rotateIngestKeyAction(tenantId);
      if (r.ok) {
        setRevealed(r.plaintextKey);
        setFlash({
          kind: "ok",
          msg: "Key gerada. Copia agora — não voltarás a vê-la.",
        });
      } else {
        setFlash({ kind: "err", msg: r.error });
      }
    });
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card title="Heartbeat do agent">
        <Field
          k="Última visto"
          v={
            overview.lastAgentHeartbeatAt
              ? `${overview.heartbeatMinutesAgo} min atrás`
              : "Nunca"
          }
        />
        <Field
          k="Estado"
          v={
            overview.lastAgentHeartbeatAt
              ? overview.heartbeatHealthy
                ? "OK"
                : "Silencioso"
              : "Sem contacto"
          }
        />
        <Field
          k="Timestamp"
          v={
            overview.lastAgentHeartbeatAt
              ? new Date(overview.lastAgentHeartbeatAt).toLocaleString("pt-PT")
              : "—"
          }
        />
        <p className="mt-2 text-[11px] text-slate-500">
          Heartbeat &gt; 30 min é tratado como silencioso. Configurar alertas
          é responsabilidade externa (Cron + email).
        </p>
      </Card>

      <Card title="Ingest API key">
        <Field
          k="Estado"
          v={overview.ingestKeyConfigured ? "Configurada" : "Não emitida"}
        />
        <Field
          k="Emitida em"
          v={
            overview.ingestApiKeyIssuedAt
              ? new Date(overview.ingestApiKeyIssuedAt).toLocaleString("pt-PT")
              : "—"
          }
        />
        <button
          onClick={rotate}
          disabled={busy}
          className="mt-2 rounded-lg bg-slate-900 px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-50"
        >
          {overview.ingestKeyConfigured ? "Rotar key" : "Gerar key"}
        </button>
        {revealed && (
          <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-amber-900">
              Nova key — copia agora
            </div>
            <div className="mt-2 break-all rounded bg-white px-2 py-1 font-mono text-[11px] text-slate-900">
              {revealed}
            </div>
            <button
              onClick={() => navigator.clipboard.writeText(revealed)}
              className="mt-2 text-[11px] font-medium text-amber-900 underline"
            >
              Copiar
            </button>
            <p className="mt-2 text-[10px] text-amber-800">
              Esta é a única vez que a key é mostrada. Guarda-a no secret
              store do agent agora.
            </p>
          </div>
        )}
      </Card>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// OUTBOX TAB
// ─────────────────────────────────────────────────────────────

function OutboxTab({
  tenantId,
  counters,
  failedOrders,
  setFlash,
}: {
  tenantId: string;
  counters: TenantOutboxCounters;
  failedOrders: TenantFailedOrderRow[];
  setFlash: FlashFn;
}) {
  const [busy, startTransition] = useTransition();

  function retry(outboxId: string) {
    startTransition(async () => {
      const r = await adminRetryOutboxAction(tenantId, outboxId);
      setFlash(
        r.ok
          ? { kind: "ok", msg: "Re-enviado para a fila." }
          : { kind: "err", msg: r.error }
      );
    });
  }
  function cancel(outboxId: string) {
    const reason = window.prompt("Motivo (opcional):") ?? null;
    startTransition(async () => {
      const r = await adminCancelOutboxAction(tenantId, outboxId, reason);
      setFlash(
        r.ok
          ? { kind: "ok", msg: "Cancelado." }
          : { kind: "err", msg: r.error }
      );
    });
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-5">
        <Mini label="Pendente" value={counters.pendente} tone="amber" />
        <Mini label="Em exportação" value={counters.emExportacao} tone="cyan" />
        <Mini label="Exportado" value={counters.exportado} tone="emerald" />
        <Mini label="Falhado" value={counters.falhado} tone="rose" />
        <Mini label="Cancelado" value={counters.cancelado} tone="slate" />
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white">
        <div className="border-b border-slate-100 px-5 py-3">
          <h2 className="text-[14px] font-semibold text-slate-900">
            Encomendas falhadas ({failedOrders.length})
          </h2>
        </div>
        {failedOrders.length === 0 ? (
          <div className="px-5 py-8 text-center text-[12px] text-slate-500">
            Sem falhas no momento.
          </div>
        ) : (
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-slate-100 text-left text-[10px] uppercase tracking-wider text-slate-400">
                <th className="px-5 py-2">Lista</th>
                <th className="py-2">Farmácia</th>
                <th className="py-2">Tentativas</th>
                <th className="py-2">Último erro</th>
                <th className="py-2 pr-5"></th>
              </tr>
            </thead>
            <tbody>
              {failedOrders.map((r) => (
                <tr key={r.outboxId} className="border-b border-slate-50">
                  <td className="px-5 py-2 font-medium text-slate-800">{r.listaNome}</td>
                  <td className="py-2 text-slate-600">{r.farmaciaNome}</td>
                  <td className="py-2 text-slate-500">{r.attemptCount}</td>
                  <td
                    className="max-w-xs truncate py-2 text-rose-600"
                    title={r.lastError ?? ""}
                  >
                    {r.lastError ?? "—"}
                  </td>
                  <td className="py-2 pr-5 text-right">
                    <button
                      disabled={busy}
                      onClick={() => retry(r.outboxId)}
                      className="mr-2 rounded border border-cyan-300 bg-cyan-50 px-2 py-1 text-[10px] font-medium text-cyan-700 disabled:opacity-50"
                    >
                      Re-enviar
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => cancel(r.outboxId)}
                      className="rounded border border-slate-300 bg-white px-2 py-1 text-[10px] font-medium text-slate-700 disabled:opacity-50"
                    >
                      Cancelar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Atomos
// ─────────────────────────────────────────────────────────────

function Card({
  title,
  children,
  wide,
}: {
  title: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div
      className={`rounded-2xl border border-slate-200 bg-white p-5 ${wide ? "md:col-span-2" : ""}`}
    >
      <h3 className="mb-3 text-[13px] font-semibold text-slate-900">{title}</h3>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function Field({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <div className="text-[11px] uppercase tracking-[0.1em] text-slate-400">{k}</div>
      <div
        className={`text-[12px] text-slate-800 ${mono ? "font-mono text-[11px]" : ""}`}
      >
        {v}
      </div>
    </div>
  );
}

function LabelInput({
  label,
  value,
  onChange,
  mono,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  mono?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] font-medium uppercase tracking-[0.1em] text-slate-500">
        {label}
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`w-full rounded-lg border border-slate-200 px-3 py-1.5 text-[12px] outline-none focus:border-slate-400 ${
          mono ? "font-mono" : ""
        }`}
      />
    </label>
  );
}

function Input({
  name,
  label,
  defaultValue,
  required,
}: {
  name: string;
  label: string;
  defaultValue?: string;
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] font-medium uppercase tracking-[0.1em] text-slate-500">
        {label}
      </span>
      <input
        name={name}
        defaultValue={defaultValue}
        required={required}
        className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-[12px] outline-none focus:border-slate-400"
      />
    </label>
  );
}

function Select({
  name,
  label,
  defaultValue,
  options,
}: {
  name: string;
  label: string;
  defaultValue: string;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] font-medium uppercase tracking-[0.1em] text-slate-500">
        {label}
      </span>
      <select
        name={name}
        defaultValue={defaultValue}
        className="w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12px] outline-none focus:border-slate-400"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Mini({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "amber" | "cyan" | "emerald" | "rose" | "slate";
}) {
  const cls = {
    amber: "border-amber-200 bg-amber-50 text-amber-900",
    cyan: "border-cyan-200 bg-cyan-50 text-cyan-900",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-900",
    rose: "border-rose-200 bg-rose-50 text-rose-900",
    slate: "border-slate-200 bg-slate-50 text-slate-700",
  }[tone];
  return (
    <div className={`rounded-2xl border px-4 py-3 ${cls}`}>
      <div className="text-[10px] uppercase tracking-[0.1em] opacity-70">{label}</div>
      <div className="mt-1 text-[20px] font-semibold">{value}</div>
    </div>
  );
}
