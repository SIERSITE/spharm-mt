/**
 * GET /admin/infarmed/relatorio/<operacaoId>
 *
 * Descarrega `reconciliacao-<operacaoId>.json` (formato `infarmed-reconciliacao/v1`), reconstruído a partir
 * do registo durável nas bases dos tenants. É o ficheiro que `ops:infarmed-carga --reverter-reconciliacao=`
 * aceita. Só platform admins (a sessão é validada aqui; esconder o link não é autorização).
 */
import { getSession } from "@/lib/auth";
import { criarDependenciasReais } from "@/lib/regulamentar/infarmed-runtime";
import { acaoObterRelatorioReconciliacao } from "@/lib/regulamentar/infarmed-admin";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ operacaoId: string }> }) {
  const { operacaoId } = await ctx.params;
  const r = await acaoObterRelatorioReconciliacao(criarDependenciasReais(), await getSession(), operacaoId);
  if (!r.ok) {
    const status = r.codigo === "NAO_AUTORIZADO" ? 403 : r.codigo === "NAO_ENCONTRADO" ? 404 : r.codigo === "INVALIDO" ? 400 : 500;
    return new Response(r.erro, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  }
  return new Response(JSON.stringify(r.relatorio, null, 1), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="reconciliacao-${operacaoId}.json"`,
      "cache-control": "no-store",
    },
  });
}
