import { getFarmaciasInfo } from "@/lib/farmacias-info";
import { ManutencaoFormClient } from "@/components/vendas-manutencao/manutencao-form-client";

export const dynamic = "force-dynamic";

export default async function NovaManutencaoPage() {
  const farmacias = await getFarmaciasInfo();
  return (
    <ManutencaoFormClient
      modo="criar"
      farmacias={farmacias.map((f) => ({ id: f.id, nome: f.nome }))}
    />
  );
}
