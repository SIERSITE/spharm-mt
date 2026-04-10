import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { AppShell } from "@/components/layout/app-shell";

export default async function CatalogoPage() {
  const session = await getSession();

  if (!session) {
    redirect("/login");
  }

  return (
    <AppShell title="Catálogo" subtitle="Produtos e normalização central">
      <div className="rounded-2xl bg-white p-8 shadow-sm ring-1 ring-slate-200">
        <h2 className="text-lg font-semibold text-slate-900">Módulo em construção</h2>
        <p className="mt-2 text-sm text-slate-500">
          Aqui vamos construir o ecrã premium do catálogo central.
        </p>
      </div>
    </AppShell>
  );
}