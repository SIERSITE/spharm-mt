"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  ShoppingCart,
  Package,
  Undo2,
  BookOpen,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
};

type NavSection = {
  label: string;
  items: NavItem[];
};

const sections: NavSection[] = [
  {
    label: "Análise",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { href: "/stock", label: "Stock", icon: Package },
      { href: "/devolucoes", label: "Devoluções", icon: Undo2 },
    ],
  },
  {
    label: "Decisão",
    items: [
      { href: "/encomendas", label: "Encomendas", icon: ShoppingCart },
    ],
  },
  {
    label: "Catálogo",
    items: [
      { href: "/catalogo", label: "Catálogo", icon: BookOpen },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="hidden w-60 shrink-0 border-r border-border bg-surface-soft backdrop-blur-xl xl:flex xl:flex-col">
      <div className="flex h-14 items-center border-b border-border-subtle px-5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary text-xs font-semibold text-white shadow-sm">
            SP
          </div>
          <p className="text-sm font-semibold text-text-primary">SPharm.MT</p>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-5">
        {sections.map((section, index) => (
          <div key={section.label} className={index > 0 ? "mt-6" : ""}>
            <p className="px-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-text-tertiary">
              {section.label}
            </p>

            <ul className="mt-2 space-y-1">
              {section.items.map((item) => {
                const Icon = item.icon;
                const active =
                  pathname === item.href || pathname.startsWith(`${item.href}/`);

                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={`group flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-medium transition-all ${
                        active
                          ? "bg-primary-soft text-primary shadow-xs"
                          : "text-text-secondary hover:bg-white/50 hover:text-text-primary"
                      }`}
                    >
                      <Icon
                        className={`h-4 w-4 shrink-0 transition-colors ${
                          active
                            ? "text-primary"
                            : "text-text-tertiary group-hover:text-text-secondary"
                        }`}
                        strokeWidth={2}
                      />
                      <span>{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </aside>
  );
}