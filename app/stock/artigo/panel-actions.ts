"use server";

import { requireSession } from "@/lib/permissions";
import { loadArtigoFicha, type ArtigoFichaData } from "@/lib/stock/artigo-ficha-data";

/**
 * app/stock/artigo/panel-actions.ts
 *
 * Server Action que alimenta o painel lateral da ficha do artigo
 * (components/stock/artigo-panel.tsx) — chamada a partir de QUALQUER
 * ecrã de cliente (Vendas, Encomendas, Margens, ...) sem navegar para
 * fora do contexto actual. Usa o MESMO loader da página completa
 * (lib/stock/artigo-ficha-data.ts) — nunca uma segunda implementação.
 *
 * Autenticação: `requireSession()` — mesma sessão de qualquer página
 * autenticada; a ficha do artigo não tem restrição de farmácia (é
 * catálogo, não dado por farmácia isolado), mas exige sessão válida
 * como qualquer outro dado da aplicação.
 */
export async function getArtigoFichaAction(cnp: number): Promise<
  { ok: true; data: ArtigoFichaData } | { ok: false; error: string }
> {
  await requireSession();
  if (!Number.isFinite(cnp) || cnp <= 0) {
    return { ok: false, error: "CNP inválido." };
  }
  const data = await loadArtigoFicha(cnp);
  if (!data) return { ok: false, error: "Artigo não encontrado." };
  return { ok: true, data };
}
