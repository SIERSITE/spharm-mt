/**
 * app/admin/infarmed/page.tsx
 *
 * Dados regulamentares do INFARMED: estado da última atualização, histórico e
 * upload manual do ficheiro mensal. Só platform admins (o layout de /admin
 * valida a sessão no servidor; as ações validam-na de novo).
 */

import { criarDependenciasReais } from "@/lib/regulamentar/infarmed-runtime";
import { lerEstadoAdmin } from "@/lib/regulamentar/infarmed-admin";
import { InfarmedAdminClient } from "@/components/admin/infarmed-admin-client";

export const dynamic = "force-dynamic";

export default async function InfarmedAdminPage() {
  const estado = await lerEstadoAdmin(criarDependenciasReais());
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[20px] font-semibold text-slate-900">Dados regulamentares — INFARMED</h1>
        <p className="mt-1 text-[12px] text-slate-500">
          Atualização automática no dia 1 de cada mês (Lisboa). Se falhar, a versão ativa mantém-se e o ficheiro pode ser carregado aqui.
        </p>
      </header>
      <InfarmedAdminClient estado={estado} />
    </div>
  );
}
