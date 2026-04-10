"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  Boxes,
  BookOpen,
  ClipboardList,
  FileText,
  LogOut,
  RotateCcw,
} from "lucide-react";

type AppShellProps = {
  children: React.ReactNode;
};

const navigation = [
{
  section: "ANÁLISE",
  items: [
    { label: "Dashboard", href: "/dashboard", icon: BarChart3 },
    { label: "Stock", href: "/stock", icon: Boxes },
    { label: "Vendas", href: "/vendas", icon: FileText },
    { label: "Devoluções", href: "/devolucoes", icon: RotateCcw },
  ],
},
  {
    section: "DECISÃO",
    items: [{ label: "Encomendas", href: "/encomendas", icon: ClipboardList }],
  },
  {
    section: "CATÁLOGO",
    items: [{ label: "Catálogo", href: "/catalogo", icon: BookOpen }],
  },
];

export function AppShell({ children }: AppShellProps) {
  const pathname = usePathname();

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#f7fbf9] text-slate-800">
      {/* fundo global limpo */}
      <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
  <div className="absolute -left-20 top-[-120px] h-[260px] w-[260px] rounded-full bg-emerald-100/35 blur-3xl" />
  <div className="absolute right-[-100px] top-[-80px] h-[240px] w-[240px] rounded-full bg-cyan-100/20 blur-3xl" />

  <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(15,23,42,0.01)_1px,transparent_1px),linear-gradient(to_bottom,rgba(15,23,42,0.01)_1px,transparent_1px)] bg-[size:88px_88px]" />
</div>

      <div className="relative z-10 flex min-h-screen">
        <aside className="hidden w-[242px] shrink-0 border-r border-emerald-100/70 bg-white/34 backdrop-blur-[2px] lg:flex lg:flex-col">
          <div className="flex h-16 items-center gap-3 border-b border-emerald-100/70 px-6">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-emerald-500 text-sm font-semibold text-white shadow-sm">
              SP
            </div>
            <div className="text-lg font-semibold tracking-tight text-slate-800">
              SPharm.MT
            </div>
          </div>

          <div className="flex-1 px-4 py-6">
            <nav className="space-y-8">
              {navigation.map((group) => (
                <div key={group.section}>
                  <div className="mb-3 px-3 text-[12px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                    {group.section}
                  </div>

                  <div className="space-y-1.5">
                    {group.items.map((item) => {
                      const isActive = pathname === item.href;
                      const Icon = item.icon;

                      return (
                        <Link
                          key={item.href}
                          href={item.href}
                          className={[
                            "flex items-center gap-3 rounded-2xl px-3 py-3 text-[15px] font-medium transition-all",
                            isActive
                              ? "bg-emerald-50/85 text-emerald-600 shadow-[inset_0_0_0_1px_rgba(16,185,129,0.08)]"
                              : "text-slate-500 hover:bg-white/55 hover:text-slate-700",
                          ].join(" ")}
                        >
                          <Icon className="h-[18px] w-[18px]" strokeWidth={2} />
                          <span>{item.label}</span>
                        </Link>
                      );
                    })}
                  </div>
                </div>
              ))}
            </nav>
          </div>

          <div className="border-t border-emerald-100/70 px-4 py-4">
            <div className="flex items-center gap-3 rounded-2xl px-3 py-2.5 text-slate-600">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-900 text-sm font-medium text-white">
                N
              </div>
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-slate-800">
                  Nuno
                </div>
                <div className="truncate text-xs text-slate-500">
                  Administrador
                </div>
              </div>
            </div>
          </div>
        </aside>

        <div className="relative flex min-w-0 flex-1 flex-col">
          {/* apontamento tech só no canto superior direito */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute right-0 top-0 z-0 h-[180px] w-[360px] opacity-70"
          >
            <svg
              viewBox="0 0 360 180"
              className="h-full w-full"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <g stroke="rgba(70,122,110,0.22)" strokeWidth="1">
                <path d="M80 36H340" />
                <path d="M140 92H320" />
                <path d="M210 0V110" />
                <path d="M300 28V160" />
                <path d="M210 36C210 36 210 60 234 60H288" />
                <path d="M300 92C300 92 300 116 324 116H360" />
                <circle cx="210" cy="36" r="3" fill="rgba(70,122,110,0.20)" />
                <circle cx="300" cy="92" r="3" fill="rgba(70,122,110,0.20)" />
              </g>
            </svg>
          </div>

          <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-emerald-100/70 bg-white/58 px-6 backdrop-blur-xl">
            <div className="text-sm font-medium text-slate-500">Dashboard</div>

            <div className="flex items-center gap-3">
              <button className="rounded-2xl border border-slate-200/80 bg-white/82 px-4 py-2 text-sm font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-800">
                Últimos 30 dias
              </button>

              <button className="rounded-2xl border border-slate-200/80 bg-white/82 px-4 py-2 text-sm font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-800">
                Grupo
              </button>

              <button className="inline-flex items-center gap-2 rounded-2xl px-3 py-2 text-sm font-medium text-slate-500 transition hover:bg-white/50 hover:text-slate-700">
                <LogOut className="h-4 w-4" />
                Sair
              </button>
            </div>
          </header>

          <main className="relative z-10 min-w-0 flex-1 px-8 py-8">{children}</main>
        </div>
      </div>
    </div>
  );
}