import Link from "next/link";
import {
  loadAdminOverviewSummary,
  listTenantOverviews,
} from "@/lib/admin/tenant-data";
import { CheckCircle2, AlertTriangle, AlertCircle, Activity } from "lucide-react";

export const dynamic = "force-dynamic";

function Stat({
  label,
  value,
  tone = "neutral",
  hint,
}: {
  label: string;
  value: number | string;
  tone?: "neutral" | "ok" | "warn" | "error";
  hint?: string;
}) {
  const toneCls = {
    neutral: "border-slate-200 bg-white text-slate-900",
    ok: "border-emerald-200 bg-emerald-50 text-emerald-900",
    warn: "border-amber-200 bg-amber-50 text-amber-900",
    error: "border-rose-200 bg-rose-50 text-rose-900",
  }[tone];
  return (
    <div className={`rounded-2xl border px-5 py-4 ${toneCls}`}>
      <div className="text-[11px] uppercase tracking-[0.14em] opacity-70">{label}</div>
      <div className="mt-1 text-[26px] font-semibold leading-tight">{value}</div>
      {hint && <div className="mt-1 text-[11px] opacity-70">{hint}</div>}
    </div>
  );
}

export default async function AdminOverviewPage() {
  const [summary, tenants] = await Promise.all([
    loadAdminOverviewSummary(),
    listTenantOverviews(),
  ]);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900">Visão geral</h1>
        <p className="mt-1 text-sm text-slate-600">
          Estado da plataforma SPharm.MT em todos os tenants registados.
        </p>
      </header>

      {/* Control plane health */}
      <section
        className={`rounded-2xl border px-5 py-4 ${
          summary.controlPlaneOk
            ? "border-emerald-200 bg-emerald-50"
            : "border-rose-200 bg-rose-50"
        }`}
      >
        <div className="flex items-center gap-3">
          {summary.controlPlaneOk ? (
            <CheckCircle2 className="h-5 w-5 text-emerald-600" />
          ) : (
            <AlertCircle className="h-5 w-5 text-rose-600" />
          )}
          <div>
            <div className="text-[14px] font-semibold text-slate-900">
              Control plane: {summary.controlPlaneOk ? "OK" : "indisponível"}
            </div>
            {!summary.controlPlaneOk && summary.controlPlaneError && (
              <div className="mt-1 text-[12px] text-rose-700">
                {summary.controlPlaneError}
              </div>
            )}
            {summary.controlPlaneOk && (
              <div className="text-[11px] text-slate-600">
                CONTROL_DATABASE_URL está acessível e responde a queries.
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Tenants" value={summary.totalTenants} />
        <Stat
          label="Activos"
          value={summary.activeTenants}
          tone={summary.activeTenants > 0 ? "ok" : "neutral"}
        />
        <Stat
          label="Suspensos"
          value={summary.suspendedTenants}
          tone={summary.suspendedTenants > 0 ? "warn" : "neutral"}
        />
        <Stat
          label="Em falha"
          value={summary.failedTenants}
          tone={summary.failedTenants > 0 ? "error" : "neutral"}
        />
        <Stat
          label="Sem ingest key"
          value={summary.withoutIngestKey}
          tone={summary.withoutIngestKey > 0 ? "warn" : "ok"}
          hint="Tenants que ainda não têm key emitida"
        />
        <Stat
          label="Agent silencioso"
          value={summary.agentSilent}
          tone={summary.agentSilent > 0 ? "warn" : "ok"}
          hint="Sem heartbeat há > 30 min ou nunca contactou"
        />
      </section>

      {/* Lista compacta de tenants */}
      <section className="rounded-2xl border border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
          <h2 className="text-[14px] font-semibold text-slate-900">Tenants registados</h2>
          <Link
            href="/admin/tenants"
            className="text-[12px] font-medium text-slate-600 hover:text-slate-900"
          >
            Ver todos →
          </Link>
        </div>
        {tenants.length === 0 ? (
          <div className="px-5 py-10 text-center text-[13px] text-slate-500">
            Sem tenants registados. Vai a{" "}
            <Link href="/admin/tenants" className="font-medium text-cyan-700 hover:underline">
              Tenants
            </Link>{" "}
            para registar o primeiro.
          </div>
        ) : (
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-slate-100 text-left text-[10px] uppercase tracking-wider text-slate-400">
                <th className="px-5 py-2">Slug</th>
                <th className="py-2">Nome</th>
                <th className="py-2">Estado</th>
                <th className="py-2">DB</th>
                <th className="py-2">Heartbeat</th>
                <th className="py-2">Ingest key</th>
                <th className="py-2"></th>
              </tr>
            </thead>
            <tbody>
              {tenants.map((t) => (
                <tr key={t.id} className="border-b border-slate-50 last:border-b-0">
                  <td className="px-5 py-2 font-mono text-[11px] text-slate-700">{t.slug}</td>
                  <td className="py-2 font-medium text-slate-800">{t.nome}</td>
                  <td className="py-2">
                    <StateBadge state={t.estado} />
                  </td>
                  <td className="py-2 text-slate-500">
                    {t.dbHost}/{t.dbName}
                  </td>
                  <td className="py-2">
                    {t.lastAgentHeartbeatAt ? (
                      <span
                        className={
                          t.heartbeatHealthy ? "text-emerald-600" : "text-amber-600"
                        }
                      >
                        {t.heartbeatMinutesAgo}m
                      </span>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  <td className="py-2">
                    {t.ingestKeyConfigured ? (
                      <span className="text-emerald-600">configurada</span>
                    ) : (
                      <span className="text-amber-600">em falta</span>
                    )}
                  </td>
                  <td className="py-2 pr-5 text-right">
                    <Link
                      href={`/admin/tenants/${t.id}`}
                      className="text-[11px] font-medium text-cyan-700 hover:underline"
                    >
                      Abrir →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function StateBadge({ state }: { state: string }) {
  const styles: Record<string, string> = {
    ACTIVE: "bg-emerald-50 text-emerald-700 border-emerald-200",
    PROVISIONING: "bg-cyan-50 text-cyan-700 border-cyan-200",
    SUSPENDED: "bg-amber-50 text-amber-700 border-amber-200",
    DEACTIVATED: "bg-slate-50 text-slate-600 border-slate-200",
    FAILED: "bg-rose-50 text-rose-700 border-rose-200",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${
        styles[state] ?? styles.DEACTIVATED
      }`}
    >
      {state.toLowerCase()}
    </span>
  );
}
