import type { ReactNode } from "react";
import { requirePlatformAdmin } from "@/lib/admin/auth";
import { AdminShell } from "@/components/admin/admin-shell";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const session = await requirePlatformAdmin();
  return <AdminShell adminEmail={session.email}>{children}</AdminShell>;
}
