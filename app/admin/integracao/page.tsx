import Link from "next/link";
import { requireIntegracao } from "@/lib/integracao/acesso";
import { listTenantOverviews, getOutboxCountersForTenant } from "@/lib/admin/tenant-data";
import { listTenants } from "@/lib/control-plane";

export const dynamic = "force-dynamic";

function fmt(d: Date | null): string {
  return d
    ? d.toLocaleString("pt-PT", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })
    : "—";
}

/**
 * Integração — só técnicos internos (`integration.read`, ver
 * `lib/integracao/acesso.ts`). Visão cross-tenant do estado do agent e das
 * filas; o detalhe e as operações manuais (re-tentar/cancelar) estão no
 * detalhe de cada tenant, que partilha o mesmo gate.
 *
 * O gate é repetido aqui (e não só no layout) de propósito: uma página
 * que dependa de um layout para se proteger deixa de estar protegida no dia
 * em que alguém lhe mexe.
 */
export default async function IntegracaoAdminPage() {
  await requireIntegracao();
  const [tenants, registos] = await Promise.all([listTenantOverviews(), listTenants()]);
  const registoPorId = new Map(registos.map((r) => [r.id, r]));
  const linhas = await Promise.all(
    tenants.map(async (t) => {
      const reg = registoPorId.get(t.id);
      return { t, versao: reg?.lastAgentVersion ?? null, c: reg ? await getOutboxCountersForTenant(reg) : null };
    }),
  );

  return (
    <div className="space-y-6" data-testid="integracao-admin">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900">Integração</h1>
        <p className="mt-1 text-sm text-slate-600">
          Estado do agent, versões e filas por tenant. Informação técnica — só para a equipa SIER/SoftReis.
        </p>
      </header>
      <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
        <table className="w-full text-left text-[13px]">
          <thead className="border-b border-slate-200 text-[11px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Tenant</th>
              <th className="px-4 py-3">Heartbeat</th>
              <th className="px-4 py-3">Versão do agent</th>
              <th className="px-4 py-3">Fila pendente</th>
              <th className="px-4 py-3">Falhadas</th>
              <th className="px-4 py-3">Última sincronização</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {linhas.map(({ t, c, versao }) => (
              <tr key={t.id} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-3 font-medium text-slate-900">{t.nome}<div className="font-mono text-[11px] text-slate-500">{t.slug}</div></td>
                <td className="px-4 py-3">{t.lastAgentHeartbeatAt ? `${fmt(t.lastAgentHeartbeatAt)} · ${t.heartbeatHealthy ? "ok" : "em atraso"}` : "—"}</td>
                <td className="px-4 py-3 font-mono">{versao ?? "—"}</td>
                <td className="px-4 py-3">{c ? c.pendente + c.emExportacao : "—"}</td>
                <td className="px-4 py-3">{c ? c.falhado : "—"}</td>
                <td className="px-4 py-3">{fmt(t.lastSyncAt)}{t.lastSyncStatus ? ` · ${t.lastSyncStatus.toLowerCase()}` : ""}</td>
                <td className="px-4 py-3 text-right">
                  <Link href={`/admin/tenants/${t.id}`} className="text-cyan-700 hover:underline">Detalhe</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
