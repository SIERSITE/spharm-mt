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
  ArrowLeftRight,
  PackageX,
  Mail,
  Users,
  Plug,
  ShieldCheck,
  ListOrdered,
  FilePlus,
} from "lucide-react";

type AppShellProps = {
  children: React.ReactNode;
  /**
   * Quando true, o sidebar mostra o link para /admin (Plataforma).
   * Verificado server-side via `lib/admin/auth.isPlatformAdmin()` no
   * wrapper `<MainShell>`. Default false — uma página que use directamente
   * <AppShell> não expõe o link mesmo que o user seja platform admin.
   */
  isPlatformAdmin?: boolean;
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
    items: [
      { label: "Encomendas", href: "/encomendas", icon: ClipboardList },
      { label: "Lista encomendas", href: "/encomendas/lista", icon: ListOrdered },
      { label: "Nova encomenda", href: "/encomendas/nova", icon: FilePlus },
      { label: "Transferências", href: "/transferencias", icon: ArrowLeftRight },
      { label: "Excessos", href: "/excessos", icon: PackageX },
    ],
  },
  {
    section: "CATÁLOGO",
    items: [{ label: "Catálogo", href: "/catalogo", icon: BookOpen }],
  },
  {
    section: "CONFIGURAÇÕES",
    items: [
      { label: "Utilizadores", href: "/configuracoes/utilizadores", icon: Users },
      { label: "Email", href: "/configuracoes/email", icon: Mail },
      { label: "Integração", href: "/configuracoes/integracao", icon: Plug },
    ],
  },
];

const platformGroup = {
  section: "PLATAFORMA",
  items: [{ label: "Admin", href: "/admin", icon: ShieldCheck }],
};

export function AppShell({ children, isPlatformAdmin = false }: AppShellProps) {
  const pathname = usePathname();
  const groups = isPlatformAdmin ? [...navigation, platformGroup] : navigation;

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#eef4f6] text-[#18323a]">
      {/* fundo global */}
      <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
        <div className="absolute -left-20 top-[-120px] h-[280px] w-[280px] rounded-full bg-[rgba(86,168,137,0.08)] blur-3xl" />
        <div className="absolute right-[-80px] top-[-80px] h-[260px] w-[260px] rounded-full bg-[rgba(157,200,224,0.10)] blur-3xl" />
        <div className="absolute inset-0 bg-[linear-gradient(to_right,rgba(138,170,178,0.06)_1px,transparent_1px),linear-gradient(to_bottom,rgba(138,170,178,0.06)_1px,transparent_1px)] bg-[size:88px_88px]" />
      </div>

      <div className="relative z-10 flex min-h-screen">
        <aside className="hidden w-[242px] shrink-0 border-r border-[rgba(165,190,196,0.30)] bg-[rgba(255,255,255,0.48)] backdrop-blur-sm md:flex md:flex-col">
          <div className="flex h-16 items-center gap-3 border-b border-[rgba(165,190,196,0.25)] px-6">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[#56a889] text-sm font-semibold text-white shadow-sm">
              SP
            </div>
            <div className="text-lg font-semibold tracking-tight text-[#18323a]">
              SPharm.MT
            </div>
          </div>

          <div className="flex-1 px-4 py-6">
            <nav className="space-y-8">
              {groups.map((group) => (
                <div key={group.section}>
                  <div className="mb-3 px-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#7f99a1]">
                    {group.section}
                  </div>

                  <div className="space-y-1">
                    {group.items.map((item) => {
                      const isActive = pathname === item.href;
                      const Icon = item.icon;

                      return (
                        <Link
                          key={item.href}
                          href={item.href}
                          className={[
                            "flex items-center gap-3 rounded-xl px-3 py-2.5 text-[14px] font-medium transition-all",
                            isActive
                              ? "bg-[rgba(86,168,137,0.12)] text-[#46997b] shadow-[inset_0_0_0_1px_rgba(86,168,137,0.15)]"
                              : "text-[#55707a] hover:bg-[rgba(255,255,255,0.60)] hover:text-[#18323a]",
                          ].join(" ")}
                        >
                          <Icon className="h-[17px] w-[17px]" strokeWidth={1.8} />
                          <span>{item.label}</span>
                        </Link>
                      );
                    })}
                  </div>
                </div>
              ))}
            </nav>
          </div>

          <div className="border-t border-[rgba(165,190,196,0.25)] px-4 py-4">
            <div className="flex items-center gap-3 rounded-xl px-3 py-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#18323a] text-xs font-medium text-white">
                N
              </div>
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-[#18323a]">
                  Nuno
                </div>
                <div className="truncate text-xs text-[#7f99a1]">
                  Administrador
                </div>
              </div>
            </div>
          </div>
        </aside>

        <div className="relative flex min-w-0 flex-1 flex-col">
          {/* decoração médica canto superior direito */}

          {/* orb ambiental */}
          <div aria-hidden="true" className="pointer-events-none absolute right-[-80px] top-[-80px] z-0 h-[300px] w-[300px] rounded-full bg-[rgba(86,168,137,0.09)] blur-3xl" />
          <div aria-hidden="true" className="pointer-events-none absolute right-[-20px] top-[-40px] z-0 h-[220px] w-[220px] rounded-full bg-[rgba(157,200,224,0.09)] blur-3xl" />

          {/* cruz 3D com CSS transforms */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute right-14 top-5 z-0"
            style={{
              width: 150,
              height: 150,
              opacity: 0.50,
              transform: "perspective(500px) rotateY(-18deg) rotateX(10deg)",
              filter: "drop-shadow(0 18px 36px rgba(40,110,82,0.35)) drop-shadow(0 0 60px rgba(86,168,137,0.22))",
            }}
          >
            {/* barra vertical */}
            <div style={{
              position: "absolute",
              left: "50%", top: 0,
              width: 46, height: "100%",
              transform: "translateX(-50%)",
              borderRadius: 12,
              background: "linear-gradient(145deg, #d0eedf 0%, #82caab 28%, #56a889 58%, #37806a 100%)",
              boxShadow: "inset 0 2px 0 rgba(255,255,255,0.80), inset 3px 0 0 rgba(255,255,255,0.25), inset -4px 0 10px rgba(0,0,0,0.18), 0 2px 8px rgba(40,110,82,0.20)",
            }} />
            {/* barra horizontal */}
            <div style={{
              position: "absolute",
              left: 0, top: "50%",
              width: "100%", height: 46,
              transform: "translateY(-50%)",
              borderRadius: 12,
              background: "linear-gradient(145deg, #d0eedf 0%, #82caab 28%, #56a889 58%, #37806a 100%)",
              boxShadow: "inset 0 2px 0 rgba(255,255,255,0.80), inset 3px 0 0 rgba(255,255,255,0.25), inset -4px 0 10px rgba(0,0,0,0.18), 0 2px 8px rgba(40,110,82,0.20)",
            }} />
          </div>

          {/* linha ECG */}
          <svg
            aria-hidden="true"
            className="pointer-events-none absolute right-0 top-0 z-0 h-[220px] w-[500px]"
            viewBox="0 0 500 220"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            style={{
              opacity: 0.75,
              maskImage: "linear-gradient(to left, black 55%, transparent 100%)",
              WebkitMaskImage: "linear-gradient(to left, black 55%, transparent 100%)",
            }}
          >
            <defs>
              <filter id="ecg-glow" x="-10%" y="-80%" width="120%" height="260%">
                <feGaussianBlur stdDeviation="3.5" result="blur"/>
                <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
              </filter>
            </defs>
            <path d="M0 148 L180 148 L198 148 L212 118 L226 178 L237 92 L251 168 L266 148 L500 148"
              stroke="rgba(86,168,137,0.20)" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M0 148 L180 148 L198 148 L212 118 L226 178 L237 92 L251 168 L266 148 L500 148"
              stroke="rgba(86,168,137,0.78)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              filter="url(#ecg-glow)"/>
          </svg>

          <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-[rgba(165,190,196,0.25)] bg-[rgba(255,255,255,0.55)] px-6 backdrop-blur-xl">
            <div className="text-sm font-medium text-slate-500">Dashboard</div>

            <div className="flex items-center gap-3">
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