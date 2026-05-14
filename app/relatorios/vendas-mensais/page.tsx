/**
 * app/relatorios/vendas-mensais/page.tsx
 *
 * Server Component — relatório mensal operacional baseado em
 * `VendaMensal`. Isolado do dashboard existente. Loader dedicado em
 * `lib/data/vendas-mensais-report.ts`.
 *
 * Filtros (via searchParams GET — sem JS no cliente):
 *   · ?farmaciaId=<cuid>
 *   · ?mes=YYYY-MM
 *
 * Defaults:
 *   · farmaciaId não dado → primeira farmácia activa por nome
 *   · mes não dado        → mês mais recente em VendaMensal para a farmácia
 *   · sem dados de todo   → render explicito "(sem dados)"
 *
 * Sem mock data. Sem gráficos. Tabelas compactas para impressão e leitura.
 */

import Link from "next/link";
import { MainShell } from "@/components/layout/main-shell";
import { getFarmaciasInfo } from "@/lib/farmacias-info";
import {
  getAvailableMonths,
  getMonthlyReport,
  monthLabel,
  type ReportData,
  type TopProductRow,
  type StockAnomalyRow,
  type MarginRow,
} from "@/lib/data/vendas-mensais-report";

export const dynamic = "force-dynamic";

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function pickString(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

function parseMesParam(raw: string | undefined): { ano: number; mes: number } | null {
  if (!raw) return null;
  const m = /^(\d{4})-(\d{2})$/.exec(raw);
  if (!m) return null;
  const ano = parseInt(m[1], 10);
  const mes = parseInt(m[2], 10);
  if (mes < 1 || mes > 12) return null;
  return { ano, mes };
}

function fmtEur(n: number): string {
  return n.toLocaleString("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtQty(n: number): string {
  return n.toLocaleString("pt-PT", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}
function fmtInt(n: number): string {
  return n.toLocaleString("pt-PT");
}
function fmtPct(n: number | null): string {
  if (n === null) return "—";
  return `${n.toFixed(1)}%`;
}
function fmtCnp(cnp: number | null): string {
  if (cnp === null || cnp === undefined) return "—";
  return String(cnp);
}

export default async function VendasMensaisReportPage({ searchParams }: Props) {
  const sp = await searchParams;

  const farmacias = await getFarmaciasInfo();
  if (farmacias.length === 0) {
    return (
      <MainShell>
        <ReportShell title="Relatório mensal de vendas">
          <EmptyState message="Sem farmácias activas neste tenant. Configura uma farmácia para começar." />
        </ReportShell>
      </MainShell>
    );
  }

  const farmaciaParam = pickString(sp.farmaciaId);
  const farmacia =
    farmacias.find((f) => f.id === farmaciaParam) ?? farmacias[0];

  const months = await getAvailableMonths(farmacia.id);

  const parsedMes = parseMesParam(pickString(sp.mes));
  const period =
    parsedMes && months.some((m) => m.ano === parsedMes.ano && m.mes === parsedMes.mes)
      ? parsedMes
      : months[0] ?? null;

  // Caso edge: farmácia existe mas ainda não tem nenhuma row em VendaMensal.
  if (!period) {
    return (
      <MainShell>
        <ReportShell title="Relatório mensal de vendas">
          <FilterBar farmacias={farmacias} farmaciaId={farmacia.id} months={[]} mes={null} />
          <EmptyState
            message={`Sem dados de VendaMensal para a farmácia "${farmacia.nome}".`}
            hint="Corre primeiro: npm run aggregate:vendamensal -- --tenant <slug> --month YYYY-MM --write"
          />
        </ReportShell>
      </MainShell>
    );
  }

  const report = await getMonthlyReport(farmacia.id, period.ano, period.mes);

  return (
    <MainShell>
      <ReportShell
        title="Relatório mensal de vendas"
        subtitle={`${farmacia.nome} · ${monthLabel(period.ano, period.mes)}`}
      >
        <FilterBar
          farmacias={farmacias}
          farmaciaId={farmacia.id}
          months={months}
          mes={`${period.ano}-${String(period.mes).padStart(2, "0")}`}
        />

        <SummarySection report={report} />
        <TopProductsCard
          title="Top produtos por valor bruto"
          subtitle="Ordenado por valor bruto DESC. Devoluções contam como negativas."
          rows={report.topByValor}
        />
        <TopProductsCard
          title="Top produtos por quantidade"
          subtitle="Ordenado por quantidade líquida DESC."
          rows={report.topByQty}
        />
        <DevolucoesCard rows={report.devolucoesLiquidas} />
        <MarginRankingCard rows={report.marginRanking} />
        <StockAnomalyCard
          title="Vendeu mas sem stock corrente"
          subtitle="Vendeu este mês mas stockAtual=0 ou desconhecido — candidatos a reposição."
          rows={report.soldWithoutStock}
          variant="no-stock"
        />
        <StockAnomalyCard
          title="Stock negativo (anomalia)"
          subtitle="ProdutoFarmacia.stockAtual < 0 — corrigir manualmente no ERP."
          rows={report.negativeStock}
          variant="negative"
        />
        <StockAnomalyCard
          title="Vendeu mas sem stockMin/stockMax"
          subtitle="Sem limites definidos — impossível sugerir reposição automática."
          rows={report.soldWithoutStockBounds}
          variant="bounds"
        />
      </ReportShell>
    </MainShell>
  );
}

/* ---------- Shell + helpers ---------- */

function ReportShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="relative z-10 space-y-6 pt-10">
      <section>
        <h1 className="text-[22px] font-semibold tracking-tight text-slate-900">{title}</h1>
        {subtitle ? (
          <p className="mt-1 text-[12px] text-slate-500">{subtitle}</p>
        ) : null}
      </section>
      {children}
    </div>
  );
}

function EmptyState({ message, hint }: { message: string; hint?: string }) {
  return (
    <section className="rounded-2xl border border-[rgba(165,190,196,0.40)] bg-white/60 p-8 text-center text-sm text-slate-500">
      <div>{message}</div>
      {hint ? <div className="mt-2 text-xs text-slate-400">{hint}</div> : null}
    </section>
  );
}

/* ---------- Filter bar ---------- */

function FilterBar({
  farmacias,
  farmaciaId,
  months,
  mes,
}: {
  farmacias: { id: string; nome: string }[];
  farmaciaId: string;
  months: { ano: number; mes: number; label: string }[];
  mes: string | null;
}) {
  return (
    <form
      method="get"
      className="flex flex-wrap items-end gap-3 rounded-2xl border border-[rgba(165,190,196,0.40)] bg-white/60 p-4"
    >
      <label className="flex flex-col text-xs font-medium text-slate-600">
        Farmácia
        <select
          name="farmaciaId"
          defaultValue={farmaciaId}
          className="mt-1 min-w-[220px] rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-800"
        >
          {farmacias.map((f) => (
            <option key={f.id} value={f.id}>{f.nome}</option>
          ))}
        </select>
      </label>
      <label className="flex flex-col text-xs font-medium text-slate-600">
        Mês
        <select
          name="mes"
          defaultValue={mes ?? ""}
          className="mt-1 min-w-[160px] rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-800"
          disabled={months.length === 0}
        >
          {months.length === 0 ? (
            <option value="">(sem dados)</option>
          ) : (
            months.map((m) => {
              const value = `${m.ano}-${String(m.mes).padStart(2, "0")}`;
              return (
                <option key={value} value={value}>{m.label}</option>
              );
            })
          )}
        </select>
      </label>
      <button
        type="submit"
        className="rounded-lg bg-[#56a889] px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-[#46997b]"
      >
        Atualizar
      </button>
    </form>
  );
}

/* ---------- Summary ---------- */

function SummarySection({ report }: { report: ReportData }) {
  const t = report.totals;
  const items = [
    { label: "Produtos distintos", value: fmtInt(t.produtosDistinctos) },
    { label: "Quantidade líquida (Σ)", value: fmtQty(t.quantidadeLiquida) },
    { label: "Valor bruto (Σ)", value: `${fmtEur(t.valorBruto)} EUR` },
    { label: "Valor pago utente (Σ)", value: `${fmtEur(t.valorPagoUtente)} EUR` },
    { label: "Valor comparticipado (Σ)", value: `${fmtEur(t.valorComparticipado)} EUR` },
    { label: "Linhas de venda (Σ)", value: fmtInt(t.linhasVenda) },
    { label: "Atendimentos (Σ)", value: fmtInt(t.atendimentos) },
    {
      label: "Produtos c/ devolução líq.",
      value: fmtInt(t.produtosComDevolucaoLiquida),
    },
  ];
  return (
    <section className="rounded-2xl border border-[rgba(165,190,196,0.40)] bg-white/70 p-5">
      <h2 className="text-sm font-semibold text-slate-700">Totais do mês</h2>
      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-4">
        {items.map((it) => (
          <div key={it.label}>
            <dt className="text-[11px] uppercase tracking-wide text-slate-400">{it.label}</dt>
            <dd className="text-base font-semibold text-slate-800 tabular-nums">{it.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/* ---------- Card primitives ---------- */

function Card({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-[rgba(165,190,196,0.40)] bg-white/70">
      <header className="border-b border-slate-200/60 px-5 py-3">
        <h2 className="text-sm font-semibold text-slate-700">{title}</h2>
        {subtitle ? <p className="mt-0.5 text-xs text-slate-400">{subtitle}</p> : null}
      </header>
      <div className="overflow-x-auto">{children}</div>
    </section>
  );
}

function ProductLink({ cnp, designacao }: { cnp: number | null; designacao: string }) {
  if (cnp === null || cnp === undefined) {
    return <span className="text-slate-700">{designacao}</span>;
  }
  return (
    <Link
      href={`/catalogo/artigo/${cnp}`}
      className="text-slate-800 transition hover:text-emerald-600"
    >
      {designacao}
    </Link>
  );
}

function Th({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" }) {
  return (
    <th
      className={`px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400 ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align = "left",
  emph = false,
  negative = false,
}: {
  children: React.ReactNode;
  align?: "left" | "right";
  emph?: boolean;
  negative?: boolean;
}) {
  return (
    <td
      className={[
        "border-t border-slate-100 px-3 py-2 text-[13px] tabular-nums",
        align === "right" ? "text-right" : "text-left",
        emph ? "font-semibold text-slate-900" : "text-slate-700",
        negative ? "text-rose-600" : "",
      ].join(" ")}
    >
      {children}
    </td>
  );
}

/* ---------- Sections ---------- */

function TopProductsCard({
  title,
  subtitle,
  rows,
}: {
  title: string;
  subtitle?: string;
  rows: TopProductRow[];
}) {
  return (
    <Card title={title} subtitle={subtitle}>
      {rows.length === 0 ? (
        <div className="px-5 py-6 text-sm text-slate-400">(sem dados)</div>
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <Th>#</Th>
              <Th>CNP</Th>
              <Th>Designação</Th>
              <Th align="right">Qtd líq.</Th>
              <Th align="right">Valor bruto</Th>
              <Th align="right">Pago utente</Th>
              <Th align="right">Compart.</Th>
              <Th align="right">Linhas</Th>
              <Th align="right">Atend.</Th>
              <Th align="right">Stock</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const neg = r.quantidadeLiquida < 0;
              return (
                <tr key={r.produtoId}>
                  <Td>{i + 1}</Td>
                  <Td>{fmtCnp(r.cnp)}</Td>
                  <Td emph>
                    <ProductLink cnp={r.cnp} designacao={r.designacao} />
                  </Td>
                  <Td align="right" negative={neg}>{fmtQty(r.quantidadeLiquida)}</Td>
                  <Td align="right" emph negative={neg}>{fmtEur(r.valorBruto)}</Td>
                  <Td align="right">{fmtEur(r.valorPagoUtente)}</Td>
                  <Td align="right">{fmtEur(r.valorComparticipado)}</Td>
                  <Td align="right">{fmtInt(r.linhasVenda)}</Td>
                  <Td align="right">{fmtInt(r.atendimentos)}</Td>
                  <Td align="right">
                    {r.stockAtual === null ? "—" : fmtQty(r.stockAtual)}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function DevolucoesCard({ rows }: { rows: TopProductRow[] }) {
  return (
    <Card
      title="Devoluções líquidas do mês"
      subtitle="Produtos cuja qtd líquida ficou negativa (devoluções > vendas)."
    >
      {rows.length === 0 ? (
        <div className="px-5 py-6 text-sm text-slate-400">(sem devoluções líquidas)</div>
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <Th>#</Th>
              <Th>CNP</Th>
              <Th>Designação</Th>
              <Th align="right">Qtd líq.</Th>
              <Th align="right">Valor bruto</Th>
              <Th align="right">Linhas</Th>
              <Th align="right">Stock</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.produtoId}>
                <Td>{i + 1}</Td>
                <Td>{fmtCnp(r.cnp)}</Td>
                <Td emph>
                  <ProductLink cnp={r.cnp} designacao={r.designacao} />
                </Td>
                <Td align="right" negative>{fmtQty(r.quantidadeLiquida)}</Td>
                <Td align="right" emph negative>{fmtEur(r.valorBruto)}</Td>
                <Td align="right">{fmtInt(r.linhasVenda)}</Td>
                <Td align="right">{r.stockAtual === null ? "—" : fmtQty(r.stockAtual)}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function MarginRankingCard({ rows }: { rows: MarginRow[] }) {
  return (
    <Card
      title="Margem aproximada (top valor de margem)"
      subtitle="Margem = (PVP − PUC) / PVP. Valor margem = margem% × Qtd × PVP. Filtrado a produtos com PVP > 0 e PUC conhecido."
    >
      {rows.length === 0 ? (
        <div className="px-5 py-6 text-sm text-slate-400">
          (sem dados — PVP/PUC ausentes nos produtos vendidos)
        </div>
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <Th>#</Th>
              <Th>CNP</Th>
              <Th>Designação</Th>
              <Th align="right">Qtd líq.</Th>
              <Th align="right">PVP</Th>
              <Th align="right">PUC</Th>
              <Th align="right">Margem %</Th>
              <Th align="right">Valor margem</Th>
              <Th align="right">Stock</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.produtoId}>
                <Td>{i + 1}</Td>
                <Td>{fmtCnp(r.cnp)}</Td>
                <Td emph>
                  <ProductLink cnp={r.cnp} designacao={r.designacao} />
                </Td>
                <Td align="right">{fmtQty(r.quantidadeLiquida)}</Td>
                <Td align="right">{r.pvp === null ? "—" : fmtEur(r.pvp)}</Td>
                <Td align="right">{r.puc === null ? "—" : fmtEur(r.puc)}</Td>
                <Td align="right">{fmtPct(r.margemPercent)}</Td>
                <Td align="right" emph>
                  {r.margemValor === null ? "—" : fmtEur(r.margemValor)}
                </Td>
                <Td align="right">{r.stockAtual === null ? "—" : fmtQty(r.stockAtual)}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function StockAnomalyCard({
  title,
  subtitle,
  rows,
  variant,
}: {
  title: string;
  subtitle?: string;
  rows: StockAnomalyRow[];
  variant: "no-stock" | "negative" | "bounds";
}) {
  return (
    <Card title={title} subtitle={subtitle}>
      {rows.length === 0 ? (
        <div className="px-5 py-6 text-sm text-slate-400">(sem ocorrências neste mês)</div>
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <Th>#</Th>
              <Th>CNP</Th>
              <Th>Designação</Th>
              <Th align="right">Stock</Th>
              <Th align="right">Min</Th>
              <Th align="right">Max</Th>
              <Th align="right">Qtd líq. mês</Th>
              <Th align="right">Valor bruto mês</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.produtoId}>
                <Td>{i + 1}</Td>
                <Td>{fmtCnp(r.cnp)}</Td>
                <Td emph>
                  <ProductLink cnp={r.cnp} designacao={r.designacao} />
                </Td>
                <Td
                  align="right"
                  emph={variant === "negative"}
                  negative={variant === "negative" || (r.stockAtual !== null && r.stockAtual < 0)}
                >
                  {r.stockAtual === null ? "—" : fmtQty(r.stockAtual)}
                </Td>
                <Td align="right">{r.stockMinimo === null ? "—" : fmtQty(r.stockMinimo)}</Td>
                <Td align="right">{r.stockMaximo === null ? "—" : fmtQty(r.stockMaximo)}</Td>
                <Td align="right">{fmtQty(r.quantidadeLiquida)}</Td>
                <Td align="right">{fmtEur(r.valorBruto)}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
