import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { AppShell } from "@/components/layout/app-shell";

export default async function DevolucoesPage() {
  const session = await getSession();

  if (!session) {
    redirect("/login");
  }

  return (
    <AppShell title="Devoluções" subtitle="Análise de perdas e padrões">
      <div className="rounded-2xl bg-white p-8 shadow-sm ring-1 ring-slate-200">
        <h2 className="text-lg font-semibold text-slate-900">Módulo em construção</h2>
        <p className="mt-2 text-sm text-slate-500">
          Aqui vamos construir o ecrã premium de devoluções.
        </p>
      </div>
    </AppShell>
  );
}