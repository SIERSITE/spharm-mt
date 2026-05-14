/**
 * app/analise-operacional/page.tsx
 *
 * Server Component — Operational Intelligence v1.
 * Página accionável: o que repor, o que abrandar, onde está parado o
 * dinheiro. Isolada do dashboard existente e do /relatorios/vendas-mensais.
 *
 * Filtros via searchParams GET:
 *   · ?farmaciaId=<cuid>
 *   · ?mes=YYYY-MM
 *
 * Defaults:
 *   · 1ª farmácia activa
 *   · Mês mais recente em VendaMensal
 */

import Link from "next/link";
import { MainShell } from "@/components/layout/main-shell";
import { getFarmaciasInfo } from "@/lib/farmacias-info";
import {
  getAvailableMonths,
  getOperationalIntelligence,
  monthLabel,
  COVERAGE_RUPTURA_DAYS,
  COVERAGE_EXCESSO_DAYS,
  type OperationalIntelligenceData,
  type OperationalProductRow,
  type AnomalyProductRow,
} from "@/lib/data/operational-intelligence";

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
function fmtCnp(cnp: number | null): string {
  if (cnp === null || cnp === undefined) return "—";
  return String(cnp);
}
function fmtDays(n: number | null): string {
  if (n === null) return "—";
  if (!Number.isFinite(n)) return "∞";
  if (n < 10) return n.toFixed(1);
  return Math.round(n).toString();
}
function fmtPct(n: number | null): string {
  if (n === null) return "—";
  return `${n.toFixed(1)}%`;
}

/* ---------- Page ---------- */

export default async function AnaliseOperacionalPage({ searchParams }: Props) {
  const sp = await searchParams;
  const farmacias = await getFarmaciasInfo();
  if (farmacias.length === 0) {
    return (
      <MainShell>
        <Shell title="Análise operacional">
          <EmptyBlock message="Sem farmácias activas. Configura uma farmácia para começar." />
        </Shell>
      </MainShell>
    );
  }
  const farmaciaParam = pickString(sp.farmaciaId);
  const farmacia = farmacias.find((f) => f.id === farmaciaParam) ?? farmacias[0];
  const months = await getAvailableMonths(farmacia.id);
  const parsedMes = parseMesParam(pickString(sp.mes));
  const period =
    parsedMes && months.some((m) => m.ano === parsedMes.ano && m.mes === parsedMes.mes)
      ? parsedMes
      : months[0] ?? null;

  if (!period) {
    return (
      <MainShell>
        <Shell title="Análise operacional">
          <FilterBar farmacias={farmacias} farmaciaId={farmacia.id} months={[]} mes={null} />
          <EmptyBlock
            message={`Sem dados VendaMensal para "${farmacia.nome}".`}
            hint="Corre `npm run aggregate:vendamensal -- --tenant <slug> --month YYYY-MM --write`"
          />
        </Shell>
      </MainShell>
    );
  }

  const data = await getOperationalIntelligence(farmacia.id, period.ano, period.mes);

  return (
    <MainShell>
      <Shell
        title="Análise operacional"
        subtitle={`${farmacia.nome} · ${monthLabel(period.ano, period.mes)}`}
      >
        <FilterBar
          farmacias={farmacias}
          farmaciaId={farmacia.id}
          months={months}
          mes={`${period.ano}-${String(period.mes).padStart(2, "0")}`}
        />
        <Summary data={data} />

        <Section title="Candidatos a ruptura" tone="urgent"
          subtitle={`stockAtual < stockMinimo OU cobertura < ${COVERAGE_RUPTURA_DAYS}d OU stockAtual < qtdMensal × 0.5. Repor primeiro.`}>
          <ProductTable rows={data.ruptura} variant="ruptura" />
        </Section>

        <Section title="Candidatos a excesso" tone="warn"
          subtitle={`stockAtual > stockMaximo OU cobertura > ${COVERAGE_EXCESSO_DAYS}d. Reduzir compras.`}>
          <ProductTable rows={data.excesso} variant="excesso" />
        </Section>

        <Section title="Cobertura de stock — mais urgente" tone="info"
          subtitle="Dias de stock corrente ao ritmo do mês. Calculado: stockAtual / (qtdMensal / 30).">
          <ProductTable rows={data.cobertura} variant="cobertura" />
        </Section>

        <Section title="Top por valor bruto"
          subtitle="Maior contribuição para a receita do mês.">
          <ProductTable rows={data.topByValor} variant="default" />
        </Section>

        <Section title="Top por quantidade líquida"
          subtitle="Mais unidades vendidas (líquido de devoluções).">
          <ProductTable rows={data.topByQty} variant="default" />
        </Section>

        <Section title="Margem aproximada — top valor"
          subtitle="(PVP − PUC) / PVP × Qtd. Filtrado a produtos com PVP > 0 e PUC conhecido.">
          <ProductTable rows={data.margemTop} variant="margem" />
        </Section>

        <Section title="Devoluções líquidas"
          subtitle="Produtos onde devoluções > vendas no mês.">
          <ProductTable rows={data.devolucoes} variant="devolucao" />
        </Section>

        <Section title="Vendeu sem stock corrente"
          subtitle="Vendeu este mês mas stockAtual=0 ou desconhecido. Verificar reposição.">
          <AnomalyTable rows={data.semStock} variant="no-stock" />
        </Section>

        <Section title="Stock negativo (anomalia ERP)"
          subtitle="ProdutoFarmacia.stockAtual < 0 — corrigir no ERP.">
          <AnomalyTable rows={data.stockNegativo} variant="negative" />
        </Section>

        <Section title="Sem stockMin/stockMax"
          subtitle="Vendeu mas sem limites — bloqueia reposição automática.">
          <AnomalyTable rows={data.semBounds} variant="bounds" />
        </Section>
      </Shell>
    </MainShell>
  );
}

/* ---------- Shell + filters ---------- */

function Shell({
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
        {subtitle ? <p className="mt-1 text-[12px] text-slate-500">{subtitle}</p> : null}
      </section>
      {children}
    </div>
  );
}

function EmptyBlock({ message, hint }: { message: string; hint?: string }) {
  return (
    <section className="rounded-2xl border border-[rgba(165,190,196,0.40)] bg-white/60 p-8 text-center text-sm text-slate-500">
      <div>{message}</div>
      {hint ? <div className="mt-2 font-mono text-xs text-slate-400">{hint}</div> : null}
    </section>
  );
}

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
      <div className="ml-auto self-end text-[11px] text-slate-400">
        Ver também{" "}
        <Link href="/relatorios/vendas-mensais" className="underline transition hover:text-emerald-600">
          relatório completo
        </Link>
      </div>
    </form>
  );
}

/* ---------- Summary ---------- */

function Summary({ data }: { data: OperationalIntelligenceData }) {
  const t = data.totals;
  const items = [
    { label: "Produtos vendidos no mês", value: fmtInt(t.produtosVendidos) },
    { label: "Valor bruto Σ", value: `${fmtEur(t.valorBrutoSum)} EUR` },
    { label: "Pago utente Σ", value: `${fmtEur(t.valorPagoUtenteSum)} EUR` },
    {
      label: "Candidatos a ruptura",
      value: fmtInt(t.produtosRuptura),
      alert: t.produtosRuptura > 0 ? "danger" : null,
    },
    {
      label: "Candidatos a excesso",
      value: fmtInt(t.produtosExcesso),
      alert: t.produtosExcesso > 0 ? "warn" : null,
    },
    {
      label: "Valor parado em stock",
      value: `${fmtEur(t.valorParadoTotal)} EUR`,
    },
  ] as Array<{ label: string; value: string; alert?: "danger" | "warn" | null }>;
  return (
    <section className="rounded-2xl border border-[rgba(165,190,196,0.40)] bg-white/70 p-5">
      <h2 className="text-sm font-semibold text-slate-700">Resumo do mês</h2>
      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-3">
        {items.map((it) => (
          <div key={it.label}>
            <dt className="text-[11px] uppercase tracking-wide text-slate-400">{it.label}</dt>
            <dd
              className={`text-base font-semibold tabular-nums ${
                it.alert === "danger"
                  ? "text-rose-600"
                  : it.alert === "warn"
                    ? "text-amber-600"
                    : "text-slate-800"
              }`}
            >
              {it.value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/* ---------- Section + cards ---------- */

function Section({
  title,
  subtitle,
  tone,
  children,
}: {
  title: string;
  subtitle?: string;
  tone?: "urgent" | "warn" | "info";
  children: React.ReactNode;
}) {
  const borderColour =
    tone === "urgent"
      ? "border-rose-200/80 bg-rose-50/40"
      : tone === "warn"
        ? "border-amber-200/70 bg-amber-50/40"
        : tone === "info"
          ? "border-sky-200/70 bg-sky-50/40"
          : "border-[rgba(165,190,196,0.40)] bg-white/70";
  const titleColour =
    tone === "urgent"
      ? "text-rose-700"
      : tone === "warn"
        ? "text-amber-700"
        : tone === "info"
          ? "text-sky-700"
          : "text-slate-700";
  return (
    <section className={`rounded-2xl border ${borderColour}`}>
      <header className="border-b border-slate-200/60 px-5 py-3">
        <h2 className={`text-sm font-semibold ${titleColour}`}>{title}</h2>
        {subtitle ? <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p> : null}
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
  tone,
}: {
  children: React.ReactNode;
  align?: "left" | "right";
  emph?: boolean;
  tone?: "danger" | "warn" | "ok" | null;
}) {
  const toneClass =
    tone === "danger"
      ? "text-rose-600"
      : tone === "warn"
        ? "text-amber-600"
        : tone === "ok"
          ? "text-emerald-700"
          : "";
  return (
    <td
      className={[
        "border-t border-slate-100 px-3 py-2 text-[13px] tabular-nums",
        align === "right" ? "text-right" : "text-left",
        emph ? "font-semibold text-slate-900" : "text-slate-700",
        toneClass,
      ].join(" ")}
    >
      {children}
    </td>
  );
}

type ProductVariant =
  | "ruptura"
  | "excesso"
  | "cobertura"
  | "margem"
  | "devolucao"
  | "default";

function ProductTable({ rows, variant }: { rows: OperationalProductRow[]; variant: ProductVariant }) {
  if (rows.length === 0) {
    return <div className="px-5 py-6 text-sm text-slate-400">(sem ocorrências)</div>;
  }
  const showCoverage =
    variant === "ruptura" || variant === "excesso" || variant === "cobertura";
  const showValorParado = variant === "excesso";
  const showMargin = variant === "margem";
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr>
          <Th>#</Th>
          <Th>CNP</Th>
          <Th>Designação</Th>
          <Th align="right">Qtd mês</Th>
          <Th align="right">Valor bruto</Th>
          <Th align="right">Stock</Th>
          <Th align="right">Min</Th>
          <Th align="right">Max</Th>
          {showCoverage ? <Th align="right">Cobertura (d)</Th> : null}
          {showValorParado ? <Th align="right">Valor parado</Th> : null}
          {showMargin ? <Th align="right">PVP</Th> : null}
          {showMargin ? <Th align="right">PUC</Th> : null}
          {showMargin ? <Th align="right">Margem %</Th> : null}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => {
          const neg = r.quantidadeMensal < 0;
          const coverage = r.coverageDays;
          const coverageTone: "danger" | "warn" | "ok" | null =
            coverage === null
              ? null
              : coverage < 7
                ? "danger"
                : coverage > 90
                  ? "warn"
                  : "ok";
          const stockTone: "danger" | null =
            r.stockAtual !== null && r.stockAtual < 0 ? "danger" : null;
          return (
            <tr key={r.produtoId}>
              <Td>{i + 1}</Td>
              <Td>{fmtCnp(r.cnp)}</Td>
              <Td emph>
                <ProductLink cnp={r.cnp} designacao={r.designacao} />
              </Td>
              <Td align="right" tone={neg ? "danger" : null}>{fmtQty(r.quantidadeMensal)}</Td>
              <Td align="right" emph tone={neg ? "danger" : null}>{fmtEur(r.valorBruto)}</Td>
              <Td align="right" tone={stockTone}>
                {r.stockAtual === null ? "—" : fmtQty(r.stockAtual)}
              </Td>
              <Td align="right">{r.stockMinimo === null ? "—" : fmtQty(r.stockMinimo)}</Td>
              <Td align="right">{r.stockMaximo === null ? "—" : fmtQty(r.stockMaximo)}</Td>
              {showCoverage ? (
                <Td align="right" emph tone={coverageTone}>
                  {fmtDays(coverage)}
                </Td>
              ) : null}
              {showValorParado ? (
                <Td align="right" emph tone="warn">
                  {r.valorParado === null ? "—" : fmtEur(r.valorParado)}
                </Td>
              ) : null}
              {showMargin ? (
                <Td align="right">{r.pvp === null ? "—" : fmtEur(r.pvp)}</Td>
              ) : null}
              {showMargin ? (
                <Td align="right">{r.puc === null ? "—" : fmtEur(r.puc)}</Td>
              ) : null}
              {showMargin ? (
                <Td align="right" emph>{fmtPct(r.margemPercent)}</Td>
              ) : null}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function AnomalyTable({
  rows,
  variant,
}: {
  rows: AnomalyProductRow[];
  variant: "no-stock" | "negative" | "bounds";
}) {
  if (rows.length === 0) {
    return <div className="px-5 py-6 text-sm text-slate-400">(sem ocorrências neste mês)</div>;
  }
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr>
          <Th>#</Th>
          <Th>CNP</Th>
          <Th>Designação</Th>
          <Th align="right">Stock</Th>
          <Th align="right">Min</Th>
          <Th align="right">Max</Th>
          <Th align="right">Qtd mês</Th>
          <Th align="right">Valor bruto</Th>
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
              tone={
                variant === "negative" || (r.stockAtual !== null && r.stockAtual < 0)
                  ? "danger"
                  : null
              }
            >
              {r.stockAtual === null ? "—" : fmtQty(r.stockAtual)}
            </Td>
            <Td align="right">{r.stockMinimo === null ? "—" : fmtQty(r.stockMinimo)}</Td>
            <Td align="right">{r.stockMaximo === null ? "—" : fmtQty(r.stockMaximo)}</Td>
            <Td align="right">{fmtQty(r.quantidadeMensal)}</Td>
            <Td align="right">{fmtEur(r.valorBruto)}</Td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
