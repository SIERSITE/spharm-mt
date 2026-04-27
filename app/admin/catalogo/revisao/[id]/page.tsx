import { notFound } from "next/navigation";
import {
  loadReviewDetail,
  loadFabricantes,
  loadClassificacoes,
} from "@/lib/admin/catalog-review-data";
import { CatalogReviewDetail } from "@/components/admin/catalog-review-detail";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ id: string }>;
};

export default async function CatalogReviewDetailPage({ params }: Props) {
  // requirePlatformAdmin é aplicado pelo /admin layout.
  const { id } = await params;

  // Tenta primeiro como FilaRevisao.id; se não encontrar, tenta como Produto.id
  // — útil para abrir a UI directamente para um produto sem entrada na fila.
  let detail = await loadReviewDetail(id, "revisao");
  if (!detail) detail = await loadReviewDetail(id, "produto");
  if (!detail) notFound();

  const [fabricantes, classificacoes] = await Promise.all([
    loadFabricantes(),
    loadClassificacoes(),
  ]);

  return (
    <CatalogReviewDetail
      detail={detail}
      fabricantes={fabricantes}
      classificacoes={classificacoes}
    />
  );
}
