"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Building2,
  ArrowLeft,
} from "lucide-react";

type Props = {
  children: React.ReactNode;
  /** Email do platform admin actual, mostrado no rodapé do sidebar. */
  adminEmail: string;
};

const NAV = [
  { label: "Visão geral", href: "/admin", icon: LayoutDashboard, exact: true },
  { label: "Tenants", href: "/admin/tenants", icon: Building2, exact: false },
];

export function AdminShell({ children, adminEmail }: Props) {
  const pathname = usePathname();

  return (
    <div className="relative min-h-screen bg-[#f4f6f8] text-[#18323a]">
      <div className="flex min-h-screen">
        <aside className="hidden w-[260px] shrink-0 border-r border-slate-200 bg-white md:flex md:flex-col">
          <div className="flex h-16 items-center gap-3 border-b border-slate-100 px-5">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-slate-900 text-sm font-semibold text-white">
              ADM
            </div>
            <div>
              <div className="text-[15px] font-semibold tracking-tight text-slate-900">
                SPharm.MT · Admin
              </div>
              <div className="text-[11px] text-slate-500">Plataforma</div>
            </div>
          </div>

          <nav className="flex-1 space-y-1 px-3 py-5">
            {NAV.map((item) => {
              const isActive = item.exact
                ? pathname === item.href
                : pathname === item.href || pathname.startsWith(item.href + "/");
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={[
                    "flex items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] font-medium transition-all",
                    isActive
                      ? "bg-slate-900 text-white"
                      : "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
                  ].join(" ")}
                >
                  <Icon className="h-[16px] w-[16px]" strokeWidth={1.8} />
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="border-t border-slate-100 px-3 py-3">
            <Link
              href="/dashboard"
              className="mb-2 flex items-center gap-2 rounded-xl px-3 py-2 text-[12px] text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Voltar à app
            </Link>
            <div className="rounded-xl bg-slate-50 px-3 py-2 text-[11px] text-slate-600">
              <div className="font-medium text-slate-900 truncate">{adminEmail}</div>
              <div className="text-slate-500">Platform admin</div>
            </div>
          </div>
        </aside>

        <main className="min-w-0 flex-1 px-8 py-8">
          {children}
        </main>
      </div>
    </div>
  );
}
