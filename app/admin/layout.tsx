import type { ReactNode } from "react";
import { requirePlatformAdmin } from "@/lib/admin/auth";
import { AdminShell } from "@/components/admin/admin-shell";
import { getControlPrismaCli } from "@/lib/sync/control-client-cli";
import { existeAlertaPendente } from "@/lib/regulamentar/infarmed-admin";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const session = await requirePlatformAdmin();
  // Indicador discreto: nunca bloqueia nada (uma falha a ler o alerta não derruba o /admin).
  const alertaInfarmed = await existeAlertaPendente(getControlPrismaCli()).catch(() => false);
  return (
    <AdminShell adminEmail={session.email} alertaInfarmed={alertaInfarmed}>
      {children}
    </AdminShell>
  );
}
