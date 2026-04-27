"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { registerExistingTenantAction } from "@/app/admin/actions";

export function RegisterTenantForm() {
  const router = useRouter();
  const [busy, startTransition] = useTransition();
  const [flash, setFlash] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFlash(null);
    const fd = new FormData(e.currentTarget);
    const input = {
      slug: String(fd.get("slug") ?? "").trim(),
      nome: String(fd.get("nome") ?? "").trim(),
      nifGrupo: (String(fd.get("nifGrupo") ?? "").trim() || null) as string | null,
      dbHost: String(fd.get("dbHost") ?? "").trim(),
      dbPort: Number(fd.get("dbPort") ?? 5432),
      dbName: String(fd.get("dbName") ?? "").trim(),
      dbUser: String(fd.get("dbUser") ?? "").trim(),
      dbPassword: String(fd.get("dbPassword") ?? ""),
    };
    startTransition(async () => {
      const r = await registerExistingTenantAction(input);
      if (r.ok) {
        setFlash({ kind: "ok", msg: `Tenant registado (${r.tenantId}). A redireccionar…` });
        router.push(`/admin/tenants/${r.tenantId}`);
      } else {
        setFlash({ kind: "err", msg: r.error });
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2">
        <Field name="slug" label="Slug" placeholder="grupo-demo" required />
        <Field name="nome" label="Nome" placeholder="Grupo Demo" required />
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <Field name="nifGrupo" label="NIF do grupo (opcional)" placeholder="500000000" />
        <div />
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <Field name="dbHost" label="DB host" placeholder="db.example.com" required />
        <Field name="dbPort" label="DB port" placeholder="5432" type="number" defaultValue="5432" required />
        <Field name="dbName" label="DB name" placeholder="spharmmt_grupo_demo" required />
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <Field name="dbUser" label="DB user" placeholder="spharmmt_grupo_demo" required />
        <Field name="dbPassword" label="DB password" type="password" required />
      </div>

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

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={busy}
          className="rounded-xl bg-slate-900 px-4 py-2 text-[13px] font-medium text-white transition hover:bg-slate-800 disabled:opacity-50"
        >
          {busy ? "A registar…" : "Registar tenant"}
        </button>
      </div>
    </form>
  );
}

function Field({
  name,
  label,
  placeholder,
  type = "text",
  required,
  defaultValue,
}: {
  name: string;
  label: string;
  placeholder?: string;
  type?: string;
  required?: boolean;
  defaultValue?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-[0.1em] text-slate-500">
        {label}
      </span>
      <input
        name={name}
        type={type}
        placeholder={placeholder}
        required={required}
        defaultValue={defaultValue}
        className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-[13px] text-slate-900 outline-none focus:border-slate-400"
      />
    </label>
  );
}
