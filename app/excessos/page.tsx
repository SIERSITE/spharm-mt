import { getFarmaciasInfo } from "@/lib/farmacias-info";
import { getReportingFilterOptions } from "@/lib/reporting-filter-options";
import { ExcessosClient } from "@/components/excessos/excessos-client";
import { getExcessosData } from "@/lib/transferencias-data";

export const dynamic = "force-dynamic";

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function asString(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

function parseDays(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

export default async function ExcessosPage({ searchParams }: Props) {
  const sp = await searchParams;
  const thresholdDays = parseDays(asString(sp.days));

  const [farmaciasInfo, filterOptions, initialRows] = await Promise.all([
    getFarmaciasInfo(),
    getReportingFilterOptions(),
    // Pré-carrega o relatório quando há ?days na URL — vem da dashboard com
    // o subconjunto exacto. Sem o param, mantém o comportamento original
    // (cliente carrega via "Gerar" com o threshold por defeito de 90 dias).
    thresholdDays !== undefined ? getExcessosData({ thresholdDays }) : Promise.resolve(null),
  ]);

  return (
    <ExcessosClient
      farmaciasInfo={farmaciasInfo}
      filterOptions={filterOptions}
      initialRows={initialRows ?? undefined}
      initialThresholdDays={thresholdDays}
    />
  );
}
