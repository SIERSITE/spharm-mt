"use client";

import { useState, useTransition } from "react";
import type { UtilizadorListRow } from "@/lib/utilizadores-data";
import {
  createUtilizador,
  updateUtilizador,
  toggleEstadoUtilizador,
  resetPasswordUtilizador,
  type UpsertUtilizadorInput,
} from "@/app/configuracoes/utilizadores/actions";

type Farmacia = { id: string; nome: string };
type Perfil = UtilizadorListRow["perfil"];

const PERFIL_LABELS: Record<Perfil, string> = {
  ADMINISTRADOR: "Administrador",
  GESTOR_GRUPO: "Gestor de Grupo",
  GESTOR_FARMACIA: "Gestor de Farmácia",
  OPERADOR: "Operador / Consulta",
};

type DialogState =
  | { kind: "closed" }
  | { kind: "create" }
  | { kind: "edit"; user: UtilizadorListRow };

export function UtilizadoresClient({
  initialUsers,
  farmacias,
}: {
  initialUsers: UtilizadorListRow[];
  farmacias: Farmacia[];
}) {
  const [users, setUsers] = useState(initialUsers);
  const [dialog, setDialog] = useState<DialogState>({ kind: "closed" });
  const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [, startTransition] = useTransition();

  const farmaciaNomeById = new Map(farmacias.map((f) => [f.id, f.nome]));

  const handleToggle = (id: string) => {
    setFeedback(null);
    startTransition(async () => {
      const r = await toggleEstadoUtilizador(id);
      if (r.ok) {
        const nextEstado = r.estado as "ATIVO" | "INATIVO";
        setUsers((prev) =>
          prev.map((u) => (u.id === id ? { ...u, estado: nextEstado } : u))
        );
      } else {
        setFeedback({ kind: "err", text: r.error });
      }
    });
  };

  const handleReset = (id: string) => {
    setFeedback(null);
    startTransition(async () => {
      const r = await resetPasswordUtilizador(id);
      if (r.ok) {
        setFeedback({
          kind: "ok",
          text: `Password temporária: ${r.temporaryPassword} — comunica ao utilizador. Será forçado a alterar no próximo login.`,
        });
      } else {
        setFeedback({ kind: "err", text: "Falha no reset." });
      }
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-xs text-gray-500">
          {users.length} utilizador(es)
        </div>
        <button
          type="button"
          onClick={() => setDialog({ kind: "create" })}
          className="rounded bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
        >
          Novo utilizador
        </button>
      </div>

      {feedback && (
        <div
          className={`rounded px-3 py-2 text-sm ${
            feedback.kind === "ok"
              ? "bg-green-50 text-green-700 border border-green-200"
              : "bg-red-50 text-red-700 border border-red-200"
          }`}
        >
          {feedback.text}
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-gray-50 text-xs uppercase tracking-wider text-gray-500">
            <tr>
              <th className="px-3 py-2">Nome</th>
              <th className="px-3 py-2">Email</th>
              <th className="px-3 py-2">Perfil</th>
              <th className="px-3 py-2">Farmácia primária</th>
              <th className="px-3 py-2">+ Farmácias</th>
              <th className="px-3 py-2">Estado</th>
              <th className="px-3 py-2">Último login</th>
              <th className="px-3 py-2 text-right">Ações</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {users.map((u) => (
              <tr key={u.id} className={u.estado === "INATIVO" ? "bg-gray-50 text-gray-400" : ""}>
                <td className="px-3 py-2 font-medium text-gray-900">{u.nome}</td>
                <td className="px-3 py-2">{u.email}</td>
                <td className="px-3 py-2">{PERFIL_LABELS[u.perfil]}</td>
                <td className="px-3 py-2">{u.farmaciaPrimaria ?? "—"}</td>
                <td className="px-3 py-2 text-xs">
                  {u.farmaciasExtra.length > 0 ? u.farmaciasExtra.join(", ") : "—"}
                </td>
                <td className="px-3 py-2">
                  <span
                    className={`rounded-full border px-2 py-0.5 text-xs ${
                      u.estado === "ATIVO"
                        ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                        : "border-slate-200 bg-slate-50 text-slate-500"
                    }`}
                  >
                    {u.estado}
                  </span>
                </td>
                <td className="px-3 py-2 text-xs text-gray-500">
                  {u.ultimoLogin ? new Date(u.ultimoLogin).toLocaleString("pt-PT") : "—"}
                </td>
                <td className="px-3 py-2 text-right text-xs">
                  <button
                    type="button"
                    onClick={() => setDialog({ kind: "edit", user: u })}
                    className="rounded border border-gray-300 bg-white px-2 py-1 text-gray-700 hover:bg-gray-50"
                  >
                    Editar
                  </button>
                  <button
                    type="button"
                    onClick={() => handleToggle(u.id)}
                    className="ml-1 rounded border border-gray-300 bg-white px-2 py-1 text-gray-700 hover:bg-gray-50"
                  >
                    {u.estado === "ATIVO" ? "Desativar" : "Reativar"}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleReset(u.id)}
                    className="ml-1 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-amber-700 hover:bg-amber-100"
                  >
                    Reset password
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {users.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-gray-500">Sem utilizadores.</div>
        )}
      </div>

      {dialog.kind !== "closed" && (
        <UtilizadorDialog
          mode={dialog.kind}
          initial={dialog.kind === "edit" ? dialog.user : null}
          farmacias={farmacias}
          farmaciaNomeById={farmaciaNomeById}
          onClose={() => setDialog({ kind: "closed" })}
          onSaved={(user) => {
            if (dialog.kind === "edit") {
              setUsers((prev) => prev.map((u) => (u.id === user.id ? user : u)));
            } else {
              setUsers((prev) => [user, ...prev]);
            }
            setDialog({ kind: "closed" });
            setFeedback({ kind: "ok", text: "Utilizador guardado." });
          }}
        />
      )}
    </div>
  );
}

function UtilizadorDialog({
  mode,
  initial,
  farmacias,
  farmaciaNomeById,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  initial: UtilizadorListRow | null;
  farmacias: Farmacia[];
  farmaciaNomeById: Map<string, string>;
  onClose: () => void;
  onSaved: (u: UtilizadorListRow) => void;
}) {
  const [email, setEmail] = useState(initial?.email ?? "");
  const [nome, setNome] = useState(initial?.nome ?? "");
  const [perfil, setPerfil] = useState<Perfil>(initial?.perfil ?? "OPERADOR");
  const [estado, setEstado] = useState<"ATIVO" | "INATIVO">(initial?.estado ?? "ATIVO");
  const [farmaciaId, setFarmaciaId] = useState<string>(
    // Editar: farmácia primária vem via nome; reencontrar id.
    initial
      ? farmacias.find((f) => f.nome === initial.farmaciaPrimaria)?.id ?? ""
      : ""
  );
  const [farmaciaIdsExtra, setFarmaciaIdsExtra] = useState<string[]>(
    initial
      ? initial.farmaciasExtra
          .map((nome) => farmacias.find((f) => f.nome === nome)?.id)
          .filter((x): x is string => !!x)
      : []
  );
  const [password, setPassword] = useState("");
  const [mustChange, setMustChange] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const toggleExtra = (id: string) =>
    setFarmaciaIdsExtra((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );

  const handleSubmit = () => {
    setErr(null);
    const payload: UpsertUtilizadorInput = {
      id: initial?.id,
      email,
      nome,
      perfil,
      farmaciaId: farmaciaId || null,
      farmaciaIdsExtra,
      estado,
      password: password || undefined,
      mustChangePassword: mustChange,
    };
    startTransition(async () => {
      const r =
        mode === "create"
          ? await createUtilizador(payload)
          : await updateUtilizador(payload);
      if (r.ok) {
        const createdId =
          mode === "create" && "id" in r && typeof r.id === "string" ? r.id : "";
        const saved: UtilizadorListRow = {
          id: mode === "create" ? createdId : initial!.id,
          email,
          nome,
          perfil,
          estado,
          farmaciaPrimaria: farmaciaId ? farmaciaNomeById.get(farmaciaId) ?? null : null,
          farmaciasExtra: farmaciaIdsExtra
            .map((id) => farmaciaNomeById.get(id))
            .filter((x): x is string => !!x),
          ultimoLogin: initial?.ultimoLogin ?? null,
          mustChangePassword: mustChange,
          dataCriacao: initial?.dataCriacao ?? new Date(),
        };
        onSaved(saved);
      } else {
        setErr(r.error);
      }
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-lg rounded-lg bg-white shadow-xl">
        <div className="border-b border-gray-200 px-5 py-3 text-base font-semibold text-gray-900">
          {mode === "create" ? "Novo utilizador" : `Editar ${initial?.nome}`}
        </div>
        <div className="space-y-3 px-5 py-4 text-sm">
          <Field label="Nome">
            <input
              className="w-full rounded border border-gray-300 px-3 py-2"
              value={nome}
              onChange={(e) => setNome(e.target.value)}
            />
          </Field>
          <Field label="Email">
            <input
              type="email"
              className="w-full rounded border border-gray-300 px-3 py-2"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label="Perfil">
            <select
              className="w-full rounded border border-gray-300 px-3 py-2"
              value={perfil}
              onChange={(e) => setPerfil(e.target.value as Perfil)}
            >
              {(Object.keys(PERFIL_LABELS) as Perfil[]).map((p) => (
                <option key={p} value={p}>
                  {PERFIL_LABELS[p]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Farmácia primária">
            <select
              className="w-full rounded border border-gray-300 px-3 py-2"
              value={farmaciaId}
              onChange={(e) => setFarmaciaId(e.target.value)}
            >
              <option value="">— (sem primária)</option>
              {farmacias.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.nome}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Acesso adicional a farmácias">
            <div className="flex flex-wrap gap-1.5">
              {farmacias.map((f) => {
                const on = farmaciaIdsExtra.includes(f.id);
                return (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => toggleExtra(f.id)}
                    className={`rounded-full border px-2.5 py-0.5 text-xs ${
                      on
                        ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                        : "border-gray-200 bg-white text-gray-600"
                    }`}
                  >
                    {f.nome}
                  </button>
                );
              })}
            </div>
          </Field>
          <Field
            label={
              mode === "create"
                ? "Password (mín. 8)"
                : "Nova password (vazia = manter atual)"
            }
          >
            <input
              type="password"
              className="w-full rounded border border-gray-300 px-3 py-2"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
            />
          </Field>
          <label className="inline-flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={mustChange}
              onChange={(e) => setMustChange(e.target.checked)}
            />
            Forçar alteração no próximo login
          </label>
          <Field label="Estado">
            <select
              className="w-full rounded border border-gray-300 px-3 py-2"
              value={estado}
              onChange={(e) => setEstado(e.target.value as "ATIVO" | "INATIVO")}
            >
              <option value="ATIVO">Ativo</option>
              <option value="INATIVO">Inativo</option>
            </select>
          </Field>
          {err && (
            <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {err}
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-gray-200 bg-gray-50 px-5 py-3">
          <button type="button" className="px-3 py-1.5 text-sm text-gray-600" onClick={onClose}>
            Cancelar
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={pending}
            className="rounded bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {pending ? "A guardar…" : "Guardar"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-gray-600">{label}</span>
      {children}
    </label>
  );
}
