import {
  getStockData,
  isStockFilter,
  isStockCoverageBucket,
  isStockStatus,
  clampStockPage,
  clampStockPageSize,
  STOCK_DEFAULT_PAGE_SIZE,
  type StockFilter,
  type StockSearchParams,
  type StockCoverageBucket,
  type StockRow,
} from "@/lib/stock-data";
import { StockClient } from "@/components/stock/stock-client";
import { lerOrdenacaoDeParams } from "@/lib/tabela/ordenacao";
import { getSession } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { loadFarmaciasParaSync } from "@/lib/sync-request-data";
import { resolveCurrentTenantSlug, TENANT_SYNC_BLOQUEADO } from "@/lib/tenant-context";

export const dynamic = "force-dynamic";

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function asString(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

function asArray(v: string | string[] | undefined): string[] {
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string" && x.length > 0);
  if (typeof v === "string" && v.length > 0) {
    return v.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  }
  return [];
}

function parseParams(sp: Record<string, string | string[] | undefined>): StockSearchParams {
  const rawFilter = asString(sp.filter);
  const filter: StockFilter | undefined = isStockFilter(rawFilter) ? rawFilter : undefined;

  const coverageRaw = asArray(sp.coverage);
  const coverageBuckets: StockCoverageBucket[] = coverageRaw.filter(isStockCoverageBucket);

  const statusRaw = asArray(sp.status);
  const statusBuckets: StockRow["status"][] = statusRaw.filter(isStockStatus);

  return {
    q: asString(sp.q)?.trim() || undefined,
    pharmacies: asArray(sp.pharmacy),
    coverageBuckets,
    statusBuckets,
    filter,
    // Nomes novos e distintos: `categoria` é o nível 1, `subcategoria` o
    // nível 2, `utilizacao` viaja em slug. Os parâmetros já existentes
    // não mudam de nome nem de significado.
    categorias: asArray(sp.categoria),
    subcategorias: asArray(sp.subcategoria),
    utilizacoes: asArray(sp.utilizacao),
    // A ordenacao viaja na query-string, como a pagina e os filtros:
    // esta tabela pagina no servidor, e o criterio tem de sobreviver a
    // uma mudanca de pagina e a um refresh. Chave invalida cai no
    // default sem erro — pode ser um bookmark antigo.
    ordenacao: lerOrdenacaoDeParams({ ord: asString(sp.ord), dir: asString(sp.dir) }),
    page: clampStockPage(Number(asString(sp.page) ?? 1)),
    pageSize: clampStockPageSize(Number(asString(sp.pageSize) ?? STOCK_DEFAULT_PAGE_SIZE)),
  };
}

export default async function StockPage({ searchParams }: Props) {
  const sp = await searchParams;
  const params = parseParams(sp);
  const data = await getStockData(params);

  // Bloco E — botão "Sincronizar agora". A página em si não exige
  // nenhuma permissão (comportamento pré-existente, intocado); o widget
  // é que só aparece para quem tem `stock.sync` e só sobre farmácias a
  // que a sessão tem acesso (`canAccessFarmaciaSync`, mesmo padrão do
  // Bloco A). Sem sessão ou sem permissão, `syncFarmacias` fica vazio e
  // `SyncNowWidget` não desenha nada.
  //
  // Trava garantia (2026-09, ver lib/tenant-context.ts): mesmo princípio
  // — `syncFarmacias` vazio também esconde o widget. A recusa REAL vive
  // em `requestSyncNowAction` (servidor); isto é só a UI a não oferecer
  // um botão que o servidor ia recusar. Outros tenants: comportamento
  // inalterado.
  const [session, tenantSlug] = await Promise.all([getSession(), resolveCurrentTenantSlug()]);
  const syncFarmacias =
    session && can(session, "stock.sync") && tenantSlug !== TENANT_SYNC_BLOQUEADO
      ? await loadFarmaciasParaSync(session)
      : [];

  return <StockClient data={data} syncFarmacias={syncFarmacias} />;
}
