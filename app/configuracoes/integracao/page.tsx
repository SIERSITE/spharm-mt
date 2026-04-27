import { MainShell } from "@/components/layout/main-shell";
import { requirePermission } from "@/lib/permissions";
import { loadOutboxTabData } from "@/lib/integracao/outbox-data";
import { OutboxClient } from "@/components/integracao/outbox-client";

export const dynamic = "force-dynamic";

export default async function IntegracaoPage() {
  await requirePermission("settings.global");
  const data = await loadOutboxTabData();

  return (
    <MainShell>
      <div className="mx-auto max-w-6xl px-6 py-8">
        <h1 className="text-2xl font-semibold text-gray-900">Integração SPharm</h1>
        <p className="mt-1 text-sm text-gray-600">
          Estado do fluxo bidireccional entre SPharmMT e as instâncias SPharm das farmácias.
        </p>
        <div className="mt-6">
          <OutboxClient data={data} />
        </div>
      </div>
    </MainShell>
  );
}
