import { notFound } from "next/navigation";
import {
  loadReviewDetail,
  loadFabricantes,
  loadClassificacoes,
  loadProductSourceEvidence,
} from "@/lib/admin/catalog-review-data";
import { CatalogReviewDetail } from "@/components/admin/catalog-review-detail";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ id: string }>;
};

export default async function CatalogReviewDetailPage({ params }: Props) {
  // requirePlatformAdmin é aplicado pelo /admin layout.
  const { id } = await params;

  // Tenta primeiro como FilaRevisao.id; depois como Produto.id; e finalmente,
  // se for puramente numérico, como CNP — útil para entrar a partir de
  // /catalogo/artigo/<cnp> ou de uma pesquisa por CNP.
  let detail = await loadReviewDetail(id, "revisao");
  if (!detail) detail = await loadReviewDetail(id, "produto");
  if (!detail && /^\d+$/.test(id)) detail = await loadReviewDetail(id, "cnp");
  if (!detail) notFound();

  const [fabricantes, classificacoes, evidence] = await Promise.all([
    loadFabricantes(),
    loadClassificacoes(),
    loadProductSourceEvidence(detail.produto.id),
  ]);

  return (
    <CatalogReviewDetail
      detail={detail}
      fabricantes={fabricantes}
      classificacoes={classificacoes}
      evidence={evidence}
    />
  );
}
