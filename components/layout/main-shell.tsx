import "server-only";
import type { ReactNode } from "react";
import { AppShell } from "@/components/layout/app-shell";
import { isPlatformAdmin } from "@/lib/admin/auth";

/**
 * Server wrapper para AppShell: resolve `isPlatformAdmin` server-side
 * a partir da sessão actual e injecta na shell. Páginas autenticadas
 * devem usar este componente em vez de AppShell directo, para que o
 * link "Admin" apareça na barra lateral quando o utilizador é um
 * platform admin (independentemente da página onde está).
 */
export async function MainShell({ children }: { children: ReactNode }) {
  const isAdmin = await isPlatformAdmin();
  return <AppShell isPlatformAdmin={isAdmin}>{children}</AppShell>;
}
