import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { AlterarPasswordForm } from "./alterar-password-form";

/**
 * A página que o `mustChangePassword` obriga a atravessar.
 *
 * Não usa a `MainShell`: a barra lateral leva a rotas que o middleware
 * vai recusar enquanto a password não for trocada, e uma navegação que
 * volta sempre ao mesmo sítio parece uma avaria. Aqui há uma coisa para
 * fazer e um sítio para a fazer.
 */
export const dynamic = "force-dynamic";

export default async function AlterarPasswordPage() {
  const sessao = await getSession();
  if (!sessao) redirect("/login");

  const obrigatoria = sessao.mustChangePassword === true;

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-sm ring-1 ring-slate-200">
        <h1 className="text-2xl font-semibold text-slate-900">
          {obrigatoria ? "Define a tua password" : "Alterar password"}
        </h1>
        <p className="mt-2 text-sm text-slate-500">
          {obrigatoria
            ? "A password actual foi definida por um administrador. Escolhe uma tua antes de continuares."
            : "Escolhe uma nova password para a tua conta."}
        </p>
        <p className="mt-1 text-sm text-slate-400">{sessao.email}</p>

        <div className="mt-6">
          <AlterarPasswordForm />
        </div>
      </div>
    </main>
  );
}
