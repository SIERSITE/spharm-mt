import Link from "next/link";
import { listTenantOverviews } from "@/lib/admin/tenant-data";
import { RegisterTenantForm } from "@/components/admin/register-tenant-form";

export const dynamic = "force-dynamic";

export default async function TenantsListPage() {
  const tenants = await listTenantOverviews();

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900">Tenants</h1>
        <p className="mt-1 text-sm text-slate-600">
          Grupos de farmácias registados no control plane. Cada tenant tem a
          sua própria base de dados.
        </p>
      </header>

      <section className="rounded-2xl border border-slate-200 bg-white">
        <div className="border-b border-slate-100 px-5 py-3">
          <h2 className="text-[14px] font-semibold text-slate-900">
            {tenants.length} {tenants.length === 1 ? "tenant" : "tenants"}
          </h2>
        </div>
        {tenants.length === 0 ? (
          <div className="px-5 py-10 text-center text-[13px] text-slate-500">
            Sem tenants. Regista o primeiro abaixo.
          </div>
        ) : (
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-slate-100 text-left text-[10px] uppercase tracking-wider text-slate-400">
                <th className="px-5 py-2">Slug</th>
                <th className="py-2">Nome</th>
                <th className="py-2">Estado</th>
                <th className="py-2">DB host</th>
                <th className="py-2">DB name</th>
                <th className="py-2">Schema</th>
                <th className="py-2">Criado</th>
                <th className="py-2"></th>
              </tr>
            </thead>
            <tbody>
              {tenants.map((t) => (
                <tr key={t.id} className="border-b border-slate-50 last:border-b-0">
                  <td className="px-5 py-2 font-mono text-[11px] text-slate-700">{t.slug}</td>
                  <td className="py-2 font-medium text-slate-800">{t.nome}</td>
                  <td className="py-2 text-slate-600">{t.estado.toLowerCase()}</td>
                  <td className="py-2 text-slate-500">{t.dbHost}</td>
                  <td className="py-2 text-slate-500">{t.dbName}</td>
                  <td className="py-2 text-slate-500">{t.schemaVersion ?? "—"}</td>
                  <td className="py-2 text-slate-500">
                    {new Date(t.createdAt).toLocaleDateString("pt-PT")}
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

      <section className="rounded-2xl border border-slate-200 bg-white">
        <div className="border-b border-slate-100 px-5 py-3">
          <h2 className="text-[14px] font-semibold text-slate-900">
            Registar tenant existente
          </h2>
          <p className="mt-1 text-[11px] text-slate-500">
            Esta acção cria a row no control plane e cifra a password com
            TENANT_ENCRYPTION_SECRET. Não cria a base de dados nem corre
            migrations — usa <code className="rounded bg-slate-100 px-1">npm run tenancy:provision</code> numa workstation com PROVISIONING_ADMIN_* para esse fluxo.
          </p>
        </div>
        <div className="px-5 py-5">
          <RegisterTenantForm />
        </div>
      </section>

      <section className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4">
        <h3 className="text-[13px] font-semibold text-amber-900">
          Provisionar BD nova (CLI obrigatório)
        </h3>
        <p className="mt-1 text-[12px] text-amber-900">
          Criar uma base de dados Postgres do zero envolve <code>CREATE DATABASE</code>{" "}
          + <code>CREATE ROLE</code> contra o cluster com credenciais admin, e
          correr <code>prisma migrate deploy</code> via Prisma CLI. Nenhum dos
          dois é seguro nem fiável a partir de uma serverless function. Por
          isso este fluxo continua exclusivo do CLI:
        </p>
        <pre className="mt-2 overflow-x-auto rounded-lg bg-amber-100/60 px-3 py-2 text-[11px] text-amber-950">
{`# numa workstation com .env contendo PROVISIONING_ADMIN_USER + PASS
npm run tenancy:provision -- \\
  --slug grupo-demo \\
  --nome "Grupo Demo" \\
  --db-host db.example.com --db-port 5432 --db-name spharmmt_grupo_demo`}
        </pre>
        <p className="mt-2 text-[11px] text-amber-800">
          Depois de provisionado pelo CLI, o tenant aparece automaticamente
          aqui na lista — o /admin lê do mesmo control plane.
        </p>
      </section>
    </div>
  );
}
