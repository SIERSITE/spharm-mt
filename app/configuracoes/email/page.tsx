import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { readEmailConfig } from "@/lib/email-config";
import { EmailConfigForm } from "@/components/settings/email-config-form";
import { AppShell } from "@/components/layout/app-shell";

export const dynamic = "force-dynamic";

export default async function EmailConfigPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  const sp = await searchParams;
  const requestedGlobal = sp.scope === "global";
  const canGlobal =
    session.perfil === "ADMINISTRADOR" || session.perfil === "GESTOR_GRUPO";

  // Default scope: farmácia se houver; senão global (se permitido).
  const useGlobal = requestedGlobal ? canGlobal : !session.farmaciaId;
  const farmaciaId = useGlobal ? null : session.farmaciaId;

  const initial = await readEmailConfig(farmaciaId);

  return (
    <AppShell>
    <div className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="text-2xl font-semibold text-gray-900">Configuração de Email</h1>
      <p className="mt-1 text-sm text-gray-600">
        Configuração SMTP usada pelo envio de relatórios. {useGlobal
          ? "Âmbito: configuração global (fallback)."
          : "Âmbito: esta farmácia. Se vazia, o sistema usa a configuração global."}
      </p>

      {canGlobal && (
        <div className="mt-4 flex gap-2 text-xs">
          <a
            href="/configuracoes/email"
            className={`px-3 py-1.5 rounded border ${
              !useGlobal ? "bg-blue-600 text-white border-blue-600" : "bg-white border-gray-300"
            }`}
          >
            Esta farmácia
          </a>
          <a
            href="/configuracoes/email?scope=global"
            className={`px-3 py-1.5 rounded border ${
              useGlobal ? "bg-blue-600 text-white border-blue-600" : "bg-white border-gray-300"
            }`}
          >
            Configuração global
          </a>
        </div>
      )}

      <div className="mt-6">
        <EmailConfigForm scope={useGlobal ? "global" : "farmacia"} initial={initial} />
      </div>
    </div>
    </AppShell>
  );
}
