import { requirePlatformAdmin } from "@/lib/admin/auth";
import {
  listarRevisoesGlobais,
  resumoRevisoesGlobais,
  type EstadoRevisao,
} from "@/lib/catalog/revisao-global";
import { GlobalReviewList } from "@/components/admin/global-review-list";

export const dynamic = "force-dynamic";

/**
 * /admin/catalogo/revisao-global
 *
 * As divergências entre o catálogo global e cada tenant.
 *
 * ── Porque é irmã de /admin/catalogo/revisao e não filha ─────────────
 *
 * `/admin/catalogo/global/revisao` obrigava a um segmento `global` que
 * não tem página nem serve para mais nada. E as duas filas não são a
 * mesma coisa vista a níveis diferentes: aquela é a `FilaRevisao` de UM
 * tenant, esta é o control plane a olhar para TODOS. Rotas irmãs dizem
 * isso; aninhar dizia que uma contém a outra.
 *
 * ── O que esta página NÃO faz ────────────────────────────────────────
 *
 * Não altera classificações. É um ecrã de triagem: mostra os dois lados
 * da divergência e regista que foi vista, com quem e porquê.
 */
function texto(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return s?.trim() || undefined;
}

const ESTADOS: EstadoRevisao[] = ["PENDENTE", "RESOLVIDA", "TODAS"];

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePlatformAdmin();
  const sp = await searchParams;

  const estadoBruto = texto(sp.estado);
  const estado: EstadoRevisao = ESTADOS.includes(estadoBruto as EstadoRevisao)
    ? (estadoBruto as EstadoRevisao)
    : "PENDENTE";

  // Um CNP com letras não é um filtro vazio nem um erro 500: é um filtro
  // que não se aplica. Descartar em silêncio é o comportamento certo num
  // parâmetro de URL, que qualquer pessoa pode editar à mão.
  const cnpBruto = texto(sp.cnp);
  const cnp = cnpBruto && /^\d+$/.test(cnpBruto) ? Number(cnpBruto) : undefined;

  const pageBruto = Number(texto(sp.page) ?? 1);
  const page = Number.isFinite(pageBruto) && pageBruto > 0 ? Math.floor(pageBruto) : 1;

  const [resumo, lista] = await Promise.all([
    resumoRevisoesGlobais(),
    listarRevisoesGlobais({ estado, tenantSlug: texto(sp.tenant), cnp, page }),
  ]);

  return (
    <div className="space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-slate-900">Revisões do catálogo global</h1>
        <p className="text-sm text-slate-600">
          Onde o catálogo nacional e um tenant discordam. A projecção nunca sobrepõe
          uma classificação específica local — abre uma destas e deixa como está.
        </p>
        {resumo.maisAntiga && resumo.pendentes > 0 && (
          <p className="text-xs text-slate-400">
            A mais antiga por resolver é de{" "}
            {new Date(resumo.maisAntiga).toLocaleDateString("pt-PT")}.
          </p>
        )}
      </header>

      <GlobalReviewList
        linhas={lista.linhas}
        total={lista.total}
        page={lista.page}
        pageSize={lista.pageSize}
        estado={estado}
        tenantSlug={texto(sp.tenant)}
        cnp={cnp}
        tenants={resumo.porTenant}
        pendentes={resumo.pendentes}
        resolvidas={resumo.resolvidas}
      />
    </div>
  );
}
