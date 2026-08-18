/**
 * app/admin/pipeline/page.tsx
 *
 * Server Component — observabilidade operacional do pipeline autónomo.
 * Lê PipelineRun do tenant corrente (resolvido via subdomain pela
 * middleware) + counts derivados. Não dispara nada — read-only.
 *
 * Layout `/admin/*` exige platform admin. Pipeline é tenant-scoped, mas
 * o admin layout autoriza por sessão — não confunde com o slug
 * resolvido pelos headers.
 */

import { getPipelineStatus, type PipelineRunSummary } from "@/lib/data/pipeline-status";
import { PIPELINE_STATUS } from "@/lib/pipeline/types";
import {
  getFrescuraPorFarmacia,
  getPipelineFreshness,
  type FrescuraCelula,
} from "@/lib/pipeline-freshness";
import { CoberturaPipelines } from "@/components/stock/cobertura-pipelines";
import { getPrisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

function fmtAge(d: Date): string {
  const ms = Date.now() - d.getTime();
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s atrás`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m atrás`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h atrás`;
  const days = Math.round(h / 24);
  return `${days}d atrás`;
}

function fmtDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return "—";
  const total = Math.floor(ms / 1000);
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function fmtIso(d: Date | null): string {
  if (!d) return "—";
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function StatusBadge({ status }: { status: string }) {
  const colour = {
    [PIPELINE_STATUS.OK]: "bg-emerald-100 text-emerald-700 border-emerald-200",
    // Âmbar e não verde: o dia não fechou e vai voltar a correr.
    [PIPELINE_STATUS.PARTIAL]: "bg-amber-100 text-amber-800 border-amber-300",
    [PIPELINE_STATUS.ERROR]: "bg-rose-100 text-rose-700 border-rose-200",
    [PIPELINE_STATUS.ABORTED]: "bg-amber-100 text-amber-700 border-amber-200",
    [PIPELINE_STATUS.RUNNING]: "bg-sky-100 text-sky-700 border-sky-200",
  }[status] ?? "bg-slate-100 text-slate-600 border-slate-200";
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${colour}`}>
      {status}
    </span>
  );
}

/**
 * Frescura por dataset × farmácia.
 *
 * O agregado do tenant dizia "vendas até 17/08" e estava certo — e mesmo
 * assim a Silveirense estava em 16/08. Uma farmácia saudável mascarava
 * outra atrasada. Esta grelha existe para isso não voltar a acontecer.
 */
function FrescuraPorFarmacia({ celulas }: { celulas: FrescuraCelula[] }) {
  if (celulas.length === 0) return null;
  const datasets = [...new Set(celulas.map((c) => c.dataset))];
  const farmacias = [...new Map(celulas.map((c) => [c.farmaciaId, c.farmacia])).entries()];

  return (
    <section className="rounded-2xl border border-[rgba(165,190,196,0.40)] bg-white/70 p-5">
      <h2 className="text-[14px] font-semibold text-slate-900">Frescura por farmácia</h2>
      <p className="mt-1 text-[11px] text-slate-500">
        Última data ingerida em cada dataset. O atraso é medido contra a farmácia
        mais fresca do mesmo dataset — é o desequilíbrio que denuncia um pipeline parado.
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="min-w-full text-left text-[12px]">
          <thead className="border-b border-slate-200 text-[10px] uppercase tracking-[0.14em] text-slate-500">
            <tr>
              <th className="py-2 pr-4">Dataset</th>
              {farmacias.map(([id, nome]) => (
                <th key={id} className="py-2 pr-4">{nome}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {datasets.map((ds) => (
              <tr key={ds} className="border-b border-slate-100">
                <td className="py-2 pr-4 text-slate-700">{ds}</td>
                {farmacias.map(([id]) => {
                  const c = celulas.find((x) => x.dataset === ds && x.farmaciaId === id);
                  const atras = c?.diasAtras ?? null;
                  const cor =
                    atras === null
                      ? "text-slate-400"
                      : atras > 0
                        ? "text-amber-700 font-medium"
                        : "text-slate-700";
                  return (
                    <td key={id} className={`py-2 pr-4 ${cor}`}>
                      {c?.dataMax ? c.dataMax.toISOString().slice(0, 10) : "sem dados"}
                      {atras !== null && atras > 0 ? ` · −${atras}d` : ""}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default async function AdminPipelinePage() {
  const prisma = await getPrisma();
  const [data, pipelineFreshness, frescuraPorFarmacia] = await Promise.all([
    getPipelineStatus(),
    getPipelineFreshness(prisma),
    getFrescuraPorFarmacia(prisma),
  ]);

  const build = {
    commit:
      process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ??
      process.env.SAAS_GIT_COMMIT?.slice(0, 7) ??
      "dev",
    env: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "dev",
  };

  return (
    <div className="space-y-6">
      <section className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight text-slate-900">Pipeline operacional</h1>
          <p className="mt-1 text-[12px] text-slate-500">
            Estado do ciclo daily-sync → aggregate. Read-only. Dados do tenant resolvido pelo subdomínio.
          </p>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white/70 px-3 py-2 text-right font-mono text-[10px] text-slate-500">
          <div>SaaS build {build.commit}</div>
          <div className="text-[9px] uppercase tracking-[0.15em] text-slate-400">{build.env}</div>
        </div>
      </section>

      <Metrics data={data} />
      {/* Freshness por domínio (vendas / compras / devoluções / ajustes /
          inventário / movimentos canónicos). Anteriormente vivia na ficha
          do artigo — saiu de lá porque é tenant-wide, não per-produto. */}
      <CoberturaPipelines rows={pipelineFreshness} />
      <FrescuraPorFarmacia celulas={frescuraPorFarmacia} />
      <LastRunsSection data={data} />
      <RecentRunsTable rows={data.recentRuns} />
      {data.recentFailures.length > 0 ? <FailuresTable rows={data.recentFailures} /> : null}
      <HelpFooter />
    </div>
  );
}

function Metrics({ data }: { data: Awaited<ReturnType<typeof getPipelineStatus>> }) {
  const m = data.metrics;
  const lastMonth = m.lastAggregatedMonth
    ? `${m.lastAggregatedMonth.ano}-${String(m.lastAggregatedMonth.mes).padStart(2, "0")} (${m.lastAggregatedMonth.rows} rows)`
    : "—";
  const items = [
    { label: "Mês mais recente agregado", value: lastMonth },
    { label: "Rows VendaMensal (agent)", value: m.vendaMensalRowsAgent.toLocaleString("pt-PT") },
    { label: "Rows VendaMensal (todas)", value: m.vendaMensalRowsAll.toLocaleString("pt-PT") },
    { label: "UNKNOWN staging", value: m.unknowns.toString(), alert: m.unknowns > 0 },
    { label: "Operational orphans", value: m.operationalOrphans.toString(), alert: m.operationalOrphans > 0 },
    { label: "Non-stock services", value: m.nonStockServices.toString() },
  ];
  return (
    <section className="rounded-2xl border border-[rgba(165,190,196,0.40)] bg-white/70 p-5">
      <h2 className="text-sm font-semibold text-slate-700">Métricas globais</h2>
      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-3">
        {items.map((it) => (
          <div key={it.label}>
            <dt className="text-[11px] uppercase tracking-wide text-slate-400">{it.label}</dt>
            <dd
              className={`text-base font-semibold tabular-nums ${
                it.alert ? "text-rose-600" : "text-slate-800"
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

function LastRunsSection({ data }: { data: Awaited<ReturnType<typeof getPipelineStatus>> }) {
  const items: { label: string; run: PipelineRunSummary | null }[] = [
    { label: "Último daily-pipeline (auto)", run: data.lastDailyPipeline },
    { label: "Último aggregate-month", run: data.lastAggregate },
    { label: "Último daily-sync (standalone)", run: data.lastDailySync },
  ];
  return (
    <section className="grid gap-4 md:grid-cols-3">
      {items.map((it) => (
        <div key={it.label} className="rounded-2xl border border-[rgba(165,190,196,0.40)] bg-white/70 p-5">
          <div className="text-[11px] uppercase tracking-wide text-slate-400">{it.label}</div>
          {it.run ? (
            <div className="mt-2 space-y-1">
              <div className="flex items-center gap-2">
                <StatusBadge status={it.run.status} />
                <span className="text-xs text-slate-500">{fmtAge(it.run.startedAt)}</span>
              </div>
              <div className="text-xs text-slate-600">
                Started: <span className="font-mono">{fmtIso(it.run.startedAt)}</span>
              </div>
              <div className="text-xs text-slate-600">
                Duration: <span className="tabular-nums">{fmtDuration(it.run.durationMs)}</span>
                {it.run.dateRef ? <> · ref: <span className="font-mono">{it.run.dateRef}</span></> : null}
              </div>
              {it.run.errorMessage ? (
                <div className="text-xs text-rose-600">⚠ {it.run.errorMessage.slice(0, 200)}</div>
              ) : null}
            </div>
          ) : (
            <div className="mt-2 text-sm text-slate-400">(sem execuções)</div>
          )}
        </div>
      ))}
    </section>
  );
}

function RecentRunsTable({ rows }: { rows: PipelineRunSummary[] }) {
  return (
    <section className="rounded-2xl border border-[rgba(165,190,196,0.40)] bg-white/70">
      <header className="border-b border-slate-200/60 px-5 py-3">
        <h2 className="text-sm font-semibold text-slate-700">Últimas {rows.length} execuções</h2>
      </header>
      {rows.length === 0 ? (
        <div className="px-5 py-6 text-sm text-slate-400">(sem registos)</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <Th>Started</Th>
                <Th>Kind</Th>
                <Th>Status</Th>
                <Th>Date ref</Th>
                <Th align="right">Duração</Th>
                <Th>Trigger</Th>
                <Th>Erro / Detalhes</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <Td><span className="font-mono text-[12px]">{fmtIso(r.startedAt)}</span></Td>
                  <Td>{r.kind}</Td>
                  <Td><StatusBadge status={r.status} /></Td>
                  <Td>{r.dateRef ?? "—"}</Td>
                  <Td align="right" emph>{fmtDuration(r.durationMs)}</Td>
                  <Td>{r.triggeredBy}</Td>
                  <Td>
                    {r.errorMessage ? (
                      <span className="text-xs text-rose-600">{r.errorMessage.slice(0, 80)}</span>
                    ) : (
                      <DetailsSnippet details={r.details} />
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function FailuresTable({ rows }: { rows: PipelineRunSummary[] }) {
  return (
    <section className="rounded-2xl border border-rose-200 bg-rose-50/40">
      <header className="border-b border-rose-200/60 px-5 py-3">
        <h2 className="text-sm font-semibold text-rose-700">Últimas falhas</h2>
        <p className="mt-0.5 text-xs text-rose-500">ERROR + ABORTED. Para detalhes completos, ver logs locais no PC da farmácia.</p>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <Th>Started</Th>
              <Th>Kind</Th>
              <Th>Status</Th>
              <Th>Date ref</Th>
              <Th>Mensagem</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <Td><span className="font-mono text-[12px]">{fmtIso(r.startedAt)}</span></Td>
                <Td>{r.kind}</Td>
                <Td><StatusBadge status={r.status} /></Td>
                <Td>{r.dateRef ?? "—"}</Td>
                <Td><span className="text-xs">{r.errorMessage ?? ""}</span></Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DetailsSnippet({ details }: { details: Record<string, unknown> }) {
  // Mostra um resumo compacto dos campos canónicos quando estão lá.
  const parts: string[] = [];
  const insert = (k: keyof typeof details, label: string) => {
    const v = details[k];
    if (typeof v === "number") parts.push(`${label}=${v}`);
  };
  insert("rowsInserted", "ins");
  insert("rowsDeleted", "del");
  insert("operationalOrphans", "op_orph");
  insert("unknowns", "unk");
  insert("valorBrutoSum", "vb");
  if (parts.length === 0) return <span className="text-xs text-slate-400">—</span>;
  return <span className="font-mono text-[11px] text-slate-500">{parts.join("  ")}</span>;
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
}: {
  children: React.ReactNode;
  align?: "left" | "right";
  emph?: boolean;
}) {
  return (
    <td
      className={`border-t border-slate-100 px-3 py-2 text-[13px] ${
        align === "right" ? "text-right tabular-nums" : "text-left"
      } ${emph ? "font-semibold text-slate-900" : "text-slate-700"}`}
    >
      {children}
    </td>
  );
}

function HelpFooter() {
  return (
    <section className="rounded-2xl border border-slate-200/60 bg-white/40 px-5 py-4 text-xs text-slate-500">
      <p>
        <strong>Logs locais</strong> ficam no PC da farmácia, em
        <span className="font-mono"> dist-agent\\SPharmMT-Agent\\logs\\</span>.
        Os ficheiros mais úteis: <span className="font-mono">pipeline-YYYY-MM-DD.log</span> (resumo do orquestrador),
        <span className="font-mono"> daily-sync-YYYY-MM-DD.log</span> (output dos pipelines SQL→SaaS) e
        <span className="font-mono"> aggregate-YYYY-MM.log</span> (resposta da agregação server-side).
      </p>
      <p className="mt-2">
        Para verificar o estado via terminal:
        <span className="font-mono"> npm run pipeline:health -- --tenant &lt;slug&gt;</span>
      </p>
    </section>
  );
}
