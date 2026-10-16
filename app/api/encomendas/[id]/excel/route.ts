/**
 * app/api/encomendas/[id]/excel/route.ts
 *
 * GET /api/encomendas/<id>/excel[?fornecedor=<id|sem>]
 *
 * Excel da encomenda (CNP · Designação · Quantidade, sem cabeçalho) gerado SEMPRE a partir do detalhe persistido.
 *
 * Autorização: sessão + `reports.write` (a mesma exigida pela página de detalhe e por `buildDocumentosFinalizacaoAction`) +
 * acesso à farmácia da encomenda. Isolamento por tenant: `loadOrderDetail` usa o cliente Prisma do tenant da SESSÃO
 * (`getPrisma()`); um id de outro tenant não existe nessa base e dá 404 — nunca se aceita um tenant vindo do pedido.
 */
import { getSession } from "@/lib/auth";
import { can, canAccessFarmaciaSync } from "@/lib/permissions-core";
import { loadOrderDetail } from "@/lib/encomendas/order-detail";
import { construirXlsxEncomenda, linhasParaExcel, nomeFicheiroExcelEncomenda } from "@/lib/encomendas/excel-encomenda";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(status: number, erro: string): Response {
  return Response.json({ ok: false, erro }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const session = await getSession();
  if (!session) return json(401, "Sessão expirada. Entre novamente.");
  if (!can(session, "reports.write")) return json(403, "Sem permissão para exportar encomendas.");

  const { id } = await ctx.params;
  const detail = await loadOrderDetail(id);
  if (!detail) return json(404, "Encomenda não encontrada.");
  if (!canAccessFarmaciaSync(session, detail.farmaciaId)) return json(403, "Sem acesso à farmácia desta encomenda.");

  const fornecedor = new URL(request.url).searchParams.get("fornecedor") ?? undefined;
  const linhas = linhasParaExcel(detail, fornecedor);
  if (linhas.length === 0) return json(409, "A encomenda não tem produtos com quantidade a encomendar.");

  const buffer = construirXlsxEncomenda(linhas);
  return new Response(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${nomeFicheiroExcelEncomenda(detail, fornecedor)}"`,
      "Content-Length": String(buffer.length),
      "Cache-Control": "no-store",
    },
  });
}
