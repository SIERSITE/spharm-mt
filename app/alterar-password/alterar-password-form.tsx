"use client";

import { useActionState } from "react";
import { alterarPassword, type EstadoTroca } from "./actions";

const inicial: EstadoTroca = {};

export function AlterarPasswordForm() {
  const [estado, formAction, pending] = useActionState(alterarPassword, inicial);

  return (
    <form action={formAction} className="space-y-4">
      <div>
        <label className="mb-1 block text-sm font-medium text-slate-700">
          Password actual
        </label>
        <input
          name="actual"
          type="password"
          autoComplete="current-password"
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
          placeholder="A que te foi entregue"
        />
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-slate-700">
          Nova password
        </label>
        <input
          name="nova"
          type="password"
          autoComplete="new-password"
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
          placeholder="Pelo menos 10 caracteres"
        />
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-slate-700">
          Confirmar nova password
        </label>
        <input
          name="confirmacao"
          type="password"
          autoComplete="new-password"
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
          placeholder="Escreve outra vez"
        />
      </div>

      {estado.erro ? (
        <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">
          {estado.erro}
        </div>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-60"
      >
        {pending ? "A guardar…" : "Guardar nova password"}
      </button>
    </form>
  );
}
