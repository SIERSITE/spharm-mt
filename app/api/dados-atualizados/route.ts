/**
 * GET /api/dados-atualizados
 *
 * Alimenta o «Dados atualizados até …» do cabeçalho. Exige sessão (a do
 * tenant do host — `getSession` já recusa cookies de outro tenant) e só
 * devolve datas e nomes de farmácias: nada técnico.
 */
import { getSession } from "@/lib/auth";
import { carregarDadosAtualizados } from "@/lib/dados-atualizados";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  if (!session) return Response.json({ ok: false }, { status: 401, headers: { "cache-control": "no-store" } });
  try {
    const dados = await carregarDadosAtualizados(session);
    return Response.json({ ok: true, ...dados }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ ok: false }, { status: 500, headers: { "cache-control": "no-store" } });
  }
}
