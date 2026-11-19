/**
 * GET /api/ultima-atualizacao
 *
 * Alimenta o bloco «Última atualização» do menu lateral. Exige a sessão do
 * tenant do host (`getSession` recusa cookies de outro tenant) e devolve só
 * nomes de farmácias e datas: nada técnico.
 */
import { getSession } from "@/lib/auth";
import { carregarUltimasAtualizacoes } from "@/lib/ultima-atualizacao";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  if (!session) return Response.json({ ok: false }, { status: 401, headers: { "cache-control": "no-store" } });
  try {
    const farmacias = await carregarUltimasAtualizacoes(session);
    return Response.json({ ok: true, farmacias }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ ok: false }, { status: 500, headers: { "cache-control": "no-store" } });
  }
}
