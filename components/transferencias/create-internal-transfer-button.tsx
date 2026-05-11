"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  createInternalTransferAction,
  type CreateInternalTransferInput,
  type InternalTransferKind,
} from "@/app/encomendas/nova/actions";

type Props = {
  input: CreateInternalTransferInput;
  kind: InternalTransferKind;
  /** Visual variant: cyan para same-CNP, amber para DCI-equivalent. */
  variant?: "cyan" | "amber";
  /** Override label do botão. Default depende do `kind`. */
  label?: string;
  /** Quando true, ao criar abre a `ListaEncomenda` no editor. Default true. */
  redirectOnSuccess?: boolean;
  /** className extra para integrar com layouts apertados. */
  className?: string;
};

/**
 * CTA "Criar transferência" — wrapper único reutilizado em encomendas,
 * transferências, dashboard e inbox de oportunidades. Cria uma
 * `ListaEncomenda` em RASCUNHO via `createInternalTransferAction` e
 * redirecciona para o flow de edição existente em /encomendas/[id].
 *
 * Exige confirmação humana — pop-up nativo do browser confirma a
 * intenção antes de submeter. Zero side-effects automáticos.
 */
export function CreateInternalTransferButton({
  input,
  kind,
  variant,
  label,
  redirectOnSuccess = true,
  className,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const v = variant ?? (kind === "same-cnp" ? "cyan" : "amber");
  const colours =
    v === "cyan"
      ? "border-cyan-300 bg-cyan-600 text-white hover:bg-cyan-700"
      : "border-amber-300 bg-amber-600 text-white hover:bg-amber-700";

  const handle = () => {
    const confirmMsg =
      kind === "same-cnp"
        ? `Criar transferência interna?\n\n${input.designacao}\nOrigem: ${input.sourceFarmaciaNome}\nQtd. sugerida: ${input.quantidade}`
        : `Criar transferência DCI-equivalente?\n\nEquivalente por DCI — VALIDAR antes de transferir.\n${input.designacao}\nOrigem (CNP diferente): ${input.dciSourceProductName ?? "—"} (${input.dciSourceCnp ?? "—"}) em ${input.sourceFarmaciaNome}\nQtd. sugerida: ${input.quantidade}`;
    if (!confirm(confirmMsg)) return;
    setError(null);
    startTransition(async () => {
      const result = await createInternalTransferAction(input);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (redirectOnSuccess) {
        router.push(`/encomendas/${result.listaEncomendaId}`);
      } else {
        router.refresh();
      }
    });
  };

  return (
    <div className={["inline-flex flex-col items-start gap-0.5", className ?? ""].join(" ")}>
      <button
        type="button"
        disabled={pending}
        onClick={handle}
        className={[
          "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium transition disabled:cursor-not-allowed disabled:opacity-60",
          colours,
        ].join(" ")}
      >
        {pending ? "A criar…" : label ?? "Criar transferência"}
      </button>
      {error && (
        <span className="text-[10px] text-rose-600" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
