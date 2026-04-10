import { logoutAction } from "@/app/dashboard/actions";
import { ChevronDown, LogOut } from "lucide-react";

type TopbarProps = {
  title: string;
  subtitle?: string;
};

export function Topbar({ title }: TopbarProps) {
  return (
    <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center justify-between border-b border-border-subtle bg-white/35 px-8 backdrop-blur-xl">
      <div className="flex items-center gap-2 text-sm">
        <span className="font-medium text-text-secondary">{title}</span>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-border bg-white/55 px-3 text-sm font-medium text-text-secondary shadow-xs transition-colors hover:bg-white/72 hover:text-text-primary"
        >
          <span>Últimos 30 dias</span>
          <ChevronDown className="h-4 w-4 text-text-tertiary" strokeWidth={2} />
        </button>

        <button
          type="button"
          className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-border bg-white/55 px-3 text-sm font-medium text-text-secondary shadow-xs transition-colors hover:bg-white/72 hover:text-text-primary"
        >
          <span>Grupo</span>
          <ChevronDown className="h-4 w-4 text-text-tertiary" strokeWidth={2} />
        </button>

        <div className="mx-1 h-5 w-px bg-border" aria-hidden />

        <form action={logoutAction}>
          <button
            type="submit"
            className="inline-flex h-9 items-center gap-1.5 rounded-xl px-3 text-sm font-medium text-text-secondary transition-colors hover:bg-white/40 hover:text-text-primary"
          >
            <LogOut className="h-4 w-4" strokeWidth={2} />
            <span>Sair</span>
          </button>
        </form>
      </div>
    </header>
  );
}