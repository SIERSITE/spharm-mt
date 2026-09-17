import { listarManutencoesAction } from "./actions";
import { ManutencaoListaClient } from "@/components/vendas-manutencao/manutencao-lista-client";

export const dynamic = "force-dynamic";

/**
 * app/vendas/manutencao/page.tsx
 *
 * Manutenção de Vendas — ecrã principal. Lista as manutenções já
 * criadas (activas e anuladas); "Nova manutenção" leva a
 * /vendas/manutencao/nova.
 */
export default async function ManutencaoVendasPage() {
  const manutencoes = await listarManutencoesAction();
  return <ManutencaoListaClient manutencoesIniciais={manutencoes} />;
}
