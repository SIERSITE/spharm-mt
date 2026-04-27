import { MainShell } from "@/components/layout/main-shell";
import { requirePermission } from "@/lib/permissions";
import { listUtilizadores } from "@/lib/utilizadores-data";
import { getFarmaciasInfo } from "@/lib/farmacias-info";
import { UtilizadoresClient } from "@/components/settings/utilizadores-client";

export const dynamic = "force-dynamic";

export default async function UtilizadoresPage() {
  await requirePermission("users.view");
  const [utilizadores, farmacias] = await Promise.all([
    listUtilizadores(),
    getFarmaciasInfo(),
  ]);
  return (
    <MainShell>
      <div className="mx-auto max-w-6xl px-6 py-8">
        <h1 className="text-2xl font-semibold text-gray-900">Utilizadores</h1>
        <p className="mt-1 text-sm text-gray-600">
          Gestão de contas, perfis e associação a farmácias.
        </p>
        <div className="mt-6">
          <UtilizadoresClient
            initialUsers={utilizadores}
            farmacias={farmacias.map((f) => ({ id: f.id, nome: f.nome }))}
          />
        </div>
      </div>
    </MainShell>
  );
}
