import { notFound } from "next/navigation";
import { getFarmaciasInfo } from "@/lib/farmacias-info";
import { obterManutencaoAction } from "../actions";
import { ManutencaoFormClient } from "@/components/vendas-manutencao/manutencao-form-client";

export const dynamic = "force-dynamic";

export default async function EditarManutencaoPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [manutencao, farmacias] = await Promise.all([
    obterManutencaoAction(id),
    getFarmaciasInfo(),
  ]);
  if (!manutencao) notFound();

  return (
    <ManutencaoFormClient
      modo="editar"
      manutencao={manutencao}
      farmacias={farmacias.map((f) => ({ id: f.id, nome: f.nome }))}
    />
  );
}
