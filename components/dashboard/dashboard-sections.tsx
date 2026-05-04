import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  ArrowRightLeft,
  ChevronDown,
  Layers,
  PackageMinus,
  Sparkles,
} from "lucide-react";
import type { DashboardData } from "@/lib/dashboard";

// ─── Formatadores ────────────────────────────────────────────────────────────

function fmtNumber(n: number, digits = 0): string {
  return n.toLocaleString("pt-PT", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function fmtEur(n: number, digits = 0): string {
  return `${fmtNumber(n, digits)} €`;
}

// ─── Building blocks ─────────────────────────────────────────────────────────

const CARD_CLASS = "rounded-2xl border border-slate-100 bg-white";

function CardShell({
  icon,
  title,
  hint,
  className = "",
  children,
}: {
  icon?: React.ReactNode;
  title: string;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={`${CARD_CLASS} p-5 ${className}`}>
      <header className="flex items-start justify-between gap-3 pb-4">
        <div className="flex items-center gap-2.5">
          {icon && (
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-slate-50 text-slate-700">
              {icon}
            </div>
          )}
          <div>
            <h2 className="text-[16px] font-semibold leading-tight text-slate-900">
              {title}
            </h2>
            {hint && <p className="mt-0.5 text-[12px] text-slate-400">{hint}</p>}
          </div>
        </div>
      </header>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function KpiTile({
  label,
  value,
  sublabel,
  href,
  tone = "neutral",
}: {
  label: string;
  value: string;
  sublabel?: string;
  href?: string;
  tone?: "neutral" | "warn" | "alert" | "ok";
}) {
  const valueTone: Record<string, string> = {
    neutral: "text-slate-900",
    warn: "text-amber-700",
    alert: "text-rose-700",
    ok: "text-emerald-700",
  };
  const inner = (
    <>
      <div className="text-[12px] font-medium text-slate-500">{label}</div>
      <div
        className={`mt-1.5 text-[22px] font-semibold leading-none tracking-tight tabular-nums ${valueTone[tone]}`}
      >
        {value}
      </div>
      {sublabel && (
        <div className="mt-1 text-[12px] text-slate-400">{sublabel}</div>
      )}
    </>
  );
  const baseClass = "block rounded-xl bg-slate-50 p-3";
  if (href) {
    return (
      <Link
        href={href}
        className={`${baseClass} transition hover:bg-slate-100`}
      >
        {inner}
      </Link>
    );
  }
  return <div className={baseClass}>{inner}</div>;
}

function CollapsibleDetail({ children }: { children: React.ReactNode }) {
  return (
    <details className="group">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-sm font-medium text-slate-700 transition hover:text-slate-900">
        <span className="group-open:hidden">Ver detalhe</span>
        <span className="hidden group-open:inline">Ocultar detalhe</span>
        <ChevronDown className="h-4 w-4 text-slate-400 transition group-open:rotate-180" />
      </summary>
      <div className="mt-3">{children}</div>
    </details>
  );
}

function ProductPreviewList({
  items,
  emptyMessage,
}: {
  items: DashboardData["criticalAlerts"]["outOfStockSample"];
  emptyMessage: string;
}) {
  if (items.length === 0) {
    return (
      <div className="rounded-lg bg-slate-50 px-3 py-2 text-center text-[12px] text-slate-400">
        {emptyMessage}
      </div>
    );
  }
  return (
    <ul className="space-y-1.5">
      {items.map((p) => (
        <li
          key={`${p.cnp}-${p.farmaciaNome}`}
          className="rounded-lg bg-slate-50 px-3 py-2"
        >
          <Link
            href={`/catalogo/artigo/${p.cnp}`}
            className="block truncate text-[13px] font-medium text-slate-900 transition hover:text-emerald-700"
          >
            {p.designacao}
          </Link>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[12px] text-slate-400">
            <span className="font-medium text-slate-500">{p.farmaciaNome}</span>
            <span>·</span>
            <span>{p.detail}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

function SeeAllLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="mt-2 inline-flex items-center gap-1 text-[12px] font-medium text-emerald-700 transition hover:text-emerald-800"
    >
      {label}
      <ArrowRight className="h-3 w-3" />
    </Link>
  );
}

// ─── Top: Executive summary (left) ───────────────────────────────────────────

export function ExecutiveSummary({
  pharmaciesCount,
  transferSuggestionsTotal,
  atRiskCount,
  excessStockValueEur,
}: {
  pharmaciesCount: number;
  transferSuggestionsTotal: number;
  atRiskCount: number;
  excessStockValueEur: number;
}) {
  return (
    <section className={`${CARD_CLASS} p-5`}>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center rounded-full bg-emerald-50 px-2.5 py-1 text-[12px] font-medium text-emerald-700">
          Estado operacional
        </span>
        <span className="inline-flex items-center rounded-full bg-emerald-50/60 px-2.5 py-1 text-[12px] font-medium text-emerald-600">
          Monitorização entre farmácias
        </span>
      </div>

      <h2 className="max-w-[44ch] text-[20px] font-semibold leading-tight tracking-tight text-slate-900">
        Cobertura, rotação e diferenças operacionais
      </h2>
      <p className="mt-2 max-w-[64ch] text-[12px] leading-relaxed text-slate-400">
        Leitura consolidada de stock entre farmácias, com sugestões de
        transferências, diferenças de cobertura e referências com rotação
        desigual.
      </p>

      <div className="mt-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiTile
          label="Farmácias"
          value={fmtNumber(pharmaciesCount)}
          sublabel="em análise"
        />
        <KpiTile
          label="Transferências"
          value={fmtNumber(transferSuggestionsTotal)}
          sublabel="sugeridas"
          href={transferSuggestionsTotal > 0 ? "/transferencias" : undefined}
          tone={transferSuggestionsTotal > 0 ? "ok" : "neutral"}
        />
        <KpiTile
          label="Produtos em risco"
          value={fmtNumber(atRiskCount)}
          sublabel="cobertura < 7d"
          href={atRiskCount > 0 ? "/stock?filter=at-risk" : undefined}
          tone={atRiskCount > 0 ? "warn" : "ok"}
        />
        <KpiTile
          label="Valor em excesso"
          value={fmtEur(excessStockValueEur)}
          sublabel="cobertura > 60d"
          href={excessStockValueEur > 0 ? "/excessos?days=60" : undefined}
          tone={excessStockValueEur > 0 ? "warn" : "ok"}
        />
      </div>
    </section>
  );
}

// TendenciaCard live em components/dashboard/trend-card.tsx (client component
// — precisa de estado local para o filtro de farmácia e selecção de mês). É
// importado directamente em app/dashboard/page.tsx.

// ─── Card: Alertas críticos ──────────────────────────────────────────────────

export function CriticalAlertsCard({
  data,
}: {
  data: DashboardData["criticalAlerts"];
}) {
  return (
    <CardShell
      icon={<AlertTriangle className="h-4 w-4 text-rose-600" />}
      title="Alertas críticos"
      hint="Stock que precisa de atenção"
    >
      <div className="space-y-3">
        <Link
          href="/stock?filter=out-of-stock"
          className="block rounded-xl bg-red-50 p-3 transition hover:bg-red-100"
        >
          <div className="text-[12px] font-medium text-rose-700/80">Em rotura</div>
          <div className="mt-1.5 text-[22px] font-semibold leading-none tracking-tight tabular-nums text-rose-700">
            {fmtNumber(data.outOfStockCount)}
          </div>
          <div className="mt-1 text-[12px] text-rose-600/70">
            sem stock, vendia em 90d
          </div>
        </Link>

        <Link
          href="/stock?filter=at-risk"
          className="block rounded-xl bg-yellow-50 p-3 transition hover:bg-yellow-100"
        >
          <div className="text-[12px] font-medium text-amber-700/80">Em risco</div>
          <div className="mt-1.5 text-[22px] font-semibold leading-none tracking-tight tabular-nums text-amber-700">
            {fmtNumber(data.atRiskCount)}
          </div>
          <div className="mt-1 text-[12px] text-amber-600/70">
            cobertura inferior a 7 dias
          </div>
        </Link>
      </div>

      <CollapsibleDetail>
        <div className="space-y-4">
          <div>
            <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.14em] text-slate-500">
              Top em rotura
            </h3>
            <ProductPreviewList
              items={data.outOfStockSample}
              emptyMessage="Sem produtos em rotura."
            />
            {data.outOfStockCount > data.outOfStockSample.length && (
              <SeeAllLink
                href="/stock?filter=out-of-stock"
                label={`Ver os ${fmtNumber(data.outOfStockCount)} produtos em rotura`}
              />
            )}
          </div>
          <div>
            <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.14em] text-slate-500">
              Top em risco
            </h3>
            <ProductPreviewList
              items={data.atRiskSample}
              emptyMessage="Sem produtos em risco."
            />
            {data.atRiskCount > data.atRiskSample.length && (
              <SeeAllLink
                href="/stock?filter=at-risk"
                label={`Ver os ${fmtNumber(data.atRiskCount)} produtos em risco`}
              />
            )}
          </div>
        </div>
      </CollapsibleDetail>
    </CardShell>
  );
}

// ─── Card: Transferências sugeridas ──────────────────────────────────────────

const PRIORITY_TONE: Record<string, string> = {
  alta: "bg-rose-50 text-rose-700",
  media: "bg-amber-50 text-amber-700",
  baixa: "bg-slate-100 text-slate-600",
};
const PRIORITY_LABEL: Record<string, string> = {
  alta: "Alta",
  media: "Média",
  baixa: "Baixa",
};

export function TransferenciasCard({
  data,
}: {
  data: DashboardData["optimization"];
}) {
  return (
    <CardShell
      icon={<Sparkles className="h-4 w-4 text-emerald-700" />}
      title="Transferências"
      hint="Equilíbrio de stock entre farmácias"
    >
      <div className="space-y-3">
        {data.transferSuggestionsTotal > 0 ? (
          <Link
            href="/transferencias"
            className="block rounded-xl bg-emerald-50 p-3 transition hover:bg-emerald-100"
          >
            <div className="text-[12px] font-medium text-emerald-700/80">
              Sugestões activas
            </div>
            <div className="mt-1.5 text-[22px] font-semibold leading-none tracking-tight tabular-nums text-emerald-700">
              {fmtNumber(data.transferSuggestionsTotal)}
            </div>
            <div className="mt-1 text-[12px] text-emerald-600/70">
              calculadas pelo motor
            </div>
          </Link>
        ) : (
          <div className="rounded-xl bg-slate-50 p-3">
            <div className="text-[12px] font-medium text-slate-500">
              Sugestões activas
            </div>
            <div className="mt-1.5 text-[22px] font-semibold leading-none tracking-tight tabular-nums text-slate-900">
              0
            </div>
            <div className="mt-1 text-[12px] text-slate-400">
              sem desequilíbrios
            </div>
          </div>
        )}

        <div className="rounded-xl bg-slate-50 p-3">
          <div className="text-[12px] font-medium text-slate-500">
            Valor a libertar
          </div>
          <div className="mt-1.5 text-[22px] font-semibold leading-none tracking-tight tabular-nums text-slate-900">
            {fmtEur(data.estimatedValueUnlockedEur)}
          </div>
          <div className="mt-1 text-[12px] text-slate-400">
            Σ qty × pvp das sugestões
          </div>
        </div>
      </div>

      <CollapsibleDetail>
        <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          Top 3 sugestões
        </h3>
        {data.topTransferSuggestions.length === 0 ? (
          <div className="rounded-lg bg-slate-50 px-3 py-2 text-center text-[12px] text-slate-400">
            Sem transferências sugeridas no momento.
          </div>
        ) : (
          <ul className="space-y-2">
            {data.topTransferSuggestions.map((t) => (
              <li
                key={`${t.cnp}-${t.farmaciaOrigem}-${t.farmaciaDestino}`}
                className="rounded-lg bg-slate-50 px-3 py-2.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <Link
                    href={`/catalogo/artigo/${t.cnp}`}
                    className="block min-w-0 flex-1 truncate text-[13px] font-medium text-slate-900 transition hover:text-emerald-700"
                  >
                    {t.produto}
                  </Link>
                  <span
                    className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${
                      PRIORITY_TONE[t.prioridade] ?? PRIORITY_TONE.baixa
                    }`}
                  >
                    {PRIORITY_LABEL[t.prioridade] ?? t.prioridade}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-slate-400">
                  <span className="font-medium text-slate-600">
                    {t.farmaciaOrigem}
                  </span>
                  <ArrowRightLeft className="h-3 w-3 text-slate-300" />
                  <span className="font-medium text-slate-600">
                    {t.farmaciaDestino}
                  </span>
                  <span>·</span>
                  <span>{fmtNumber(t.quantidadeSugerida)} un.</span>
                  {t.valorUnlocked > 0 && (
                    <>
                      <span>·</span>
                      <span>{fmtEur(t.valorUnlocked)}</span>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {data.transferSuggestionsTotal > data.topTransferSuggestions.length && (
          <SeeAllLink
            href="/transferencias"
            label={`Ver as ${fmtNumber(data.transferSuggestionsTotal)} sugestões`}
          />
        )}
      </CollapsibleDetail>
    </CardShell>
  );
}

// ─── Card: Excessos / stock parado ───────────────────────────────────────────

export function ExcessosCard({
  data,
}: {
  data: DashboardData["excess"];
}) {
  const valorTone =
    data.excessStockValueEur > 0 ? "text-amber-700" : "text-slate-900";
  const valorBg = data.excessStockValueEur > 0 ? "bg-amber-50" : "bg-slate-50";

  return (
    <CardShell
      icon={<PackageMinus className="h-4 w-4 text-amber-700" />}
      title="Excessos / stock parado"
      hint="Inventário sub-utilizado"
    >
      <div className="space-y-3">
        {data.excessStockCount > 0 ? (
          <Link
            href="/excessos?days=60"
            className={`block rounded-xl ${valorBg} p-3 transition hover:bg-amber-100`}
          >
            <div className="text-[12px] font-medium text-slate-500">
              Valor em excesso
            </div>
            <div
              className={`mt-1.5 text-[24px] font-semibold leading-none tracking-tight tabular-nums ${valorTone}`}
            >
              {fmtEur(data.excessStockValueEur)}
            </div>
            <div className="mt-1 text-[12px] text-slate-400">
              cobertura {">"} 60 dias
            </div>
          </Link>
        ) : (
          <div className={`rounded-xl ${valorBg} p-3`}>
            <div className="text-[12px] font-medium text-slate-500">
              Valor em excesso
            </div>
            <div
              className={`mt-1.5 text-[24px] font-semibold leading-none tracking-tight tabular-nums ${valorTone}`}
            >
              {fmtEur(data.excessStockValueEur)}
            </div>
            <div className="mt-1 text-[12px] text-slate-400">
              cobertura {">"} 60 dias
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <KpiTile
            label="Coberturas > 60d"
            value={fmtNumber(data.excessStockCount)}
            sublabel="produtos em excesso"
            href={data.excessStockCount > 0 ? "/excessos?days=60" : undefined}
            tone={data.excessStockCount > 0 ? "warn" : "neutral"}
          />
          <KpiTile
            label="Sem vendas 90d"
            value={fmtNumber(data.noMovementCount)}
            sublabel="produtos parados"
            href={
              data.noMovementCount > 0 ? "/stock?filter=no-movement-3m" : undefined
            }
            tone={data.noMovementCount > 0 ? "warn" : "neutral"}
          />
        </div>
      </div>

      <CollapsibleDetail>
        <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          Top excessos por valor
        </h3>
        <ProductPreviewList
          items={data.excessSample}
          emptyMessage="Sem produtos em excesso."
        />
        {data.excessStockCount > data.excessSample.length && (
          <SeeAllLink
            href="/excessos?days=60"
            label={`Ver os ${fmtNumber(data.excessStockCount)} produtos em excesso`}
          />
        )}
      </CollapsibleDetail>
    </CardShell>
  );
}

// ─── Per-pharmacy detail (collapsed by default) ──────────────────────────────

export function PerPharmacyDetail({
  pharmacies,
}: {
  pharmacies: DashboardData["perPharmacy"];
}) {
  return (
    <details className={`group ${CARD_CLASS} p-5`}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-slate-50 text-slate-700">
            <Layers className="h-4 w-4" />
          </div>
          <div>
            <h2 className="text-[16px] font-semibold leading-tight text-slate-900">
              Detalhe por farmácia
            </h2>
            <p className="mt-0.5 text-[12px] text-slate-400">
              {pharmacies.length} farmácia{pharmacies.length === 1 ? "" : "s"} ·
              {" "}vendas, margem, stock parado, alertas
            </p>
          </div>
        </div>
        <span className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-700 transition hover:text-slate-900">
          <span className="group-open:hidden">Ver detalhe</span>
          <span className="hidden group-open:inline">Ocultar detalhe</span>
          <ChevronDown className="h-4 w-4 text-slate-400 transition group-open:rotate-180" />
        </span>
      </summary>

      <div className="mt-4 overflow-x-auto">
        <table className="min-w-full text-left">
          <thead className="border-b border-slate-100 text-[12px] font-medium text-slate-400">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Farmácia</th>
              <th className="px-3 py-2 text-right font-medium">Vendas (mês)</th>
              <th className="px-3 py-2 text-right font-medium">Margem</th>
              <th className="px-3 py-2 text-right font-medium">Stock parado</th>
              <th className="px-3 py-2 text-right font-medium">Alertas mín.</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 text-[13px] text-slate-700">
            {pharmacies.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-slate-400">
                  Sem farmácias activas.
                </td>
              </tr>
            ) : (
              pharmacies.map((p) => (
                <tr key={p.id} className="hover:bg-slate-50/70">
                  <td className="px-3 py-2.5 font-medium text-slate-900">
                    {p.name}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {fmtEur(p.sales)}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {p.margin.toFixed(1)}%
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {fmtEur(p.stoppedStockValue)}
                    <span className="ml-1 text-[12px] text-slate-400">
                      ({fmtNumber(p.stoppedStockCount)})
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {fmtNumber(p.alerts)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </details>
  );
}
