/**
 * lib/farmacia-catalogo.ts
 *
 * Farmácia AUTORITATIVA para o catálogo partilhado de um tenant — ver
 * `Farmacia.autoridadeCatalogo` em prisma/schema.prisma. Genérico e
 * por-tenant: nada aqui compara nomes de farmácia nem lê `tenantSlug`.
 * Cada tenant tem a SUA base física própria, por isso "farmácia
 * autoritativa do tenant" é sempre, na prática, "a farmácia com
 * `autoridadeCatalogo = true` NESTA base" — nunca precisa de um
 * `tenantId` explícito.
 *
 * Hoje só `lib/ingest/catalog-from-erp.ts` (Produto.fabricanteId) lê
 * isto. Pensado para outros campos de catálogo por-farmácia no futuro,
 * sem precisar de mudar de forma.
 */
import type { PrismaClient } from "@/generated/prisma/client";

export type FarmaciaAutoridadeCatalogo = { id: string; nome: string };

/**
 * Devolve a farmácia autoritativa do tenant desta ligação `prisma`, ou
 * `null` se nenhuma estiver configurada — nesse caso o comportamento
 * histórico aplica-se (todas as farmácias simétricas, cada uma com o
 * seu próprio baseline). NUNCA escolhe arbitrariamente entre duas: se,
 * por alguma inconsistência de dados, mais do que uma farmácia tiver
 * `autoridadeCatalogo = true` (não deveria — `setFarmaciaAutoridadeCatalogo`
 * impede isto — mas nunca se confia cegamente numa invariante só
 * imposta pelo próprio código de escrita), devolve `null` e regista um
 * aviso, tratando o tenant como "sem autoridade configurada" em vez de
 * escolher uma das duas.
 */
export async function getFarmaciaAutoridadeCatalogo(
  prisma: Pick<PrismaClient, "farmacia">,
): Promise<FarmaciaAutoridadeCatalogo | null> {
  const candidatas = await prisma.farmacia.findMany({
    where: { autoridadeCatalogo: true },
    select: { id: true, nome: true },
  });
  if (candidatas.length === 0) return null;
  if (candidatas.length > 1) {
    console.warn(
      `[farmacia-catalogo] ${candidatas.length} farmácias marcadas como autoridadeCatalogo=true nesta base — dado inconsistente, a tratar como SEM autoridade configurada (nunca escolhida arbitrariamente). IDs: ${candidatas.map((f) => f.id).join(", ")}`,
    );
    return null;
  }
  return candidatas[0]!;
}

/**
 * Define QUAL farmácia é a autoridade de catálogo do tenant — nunca mais
 * do que uma. Dentro de uma única transacção: desliga a flag em todas as
 * outras, liga na farmácia pedida. `farmaciaId: null` remove a
 * autoridade por completo (volta ao comportamento histórico simétrico).
 *
 * Ferramenta administrativa — nunca chamada pelo caminho de ingestão em
 * si (esse só LÊ via `getFarmaciaAutoridadeCatalogo`). Ver
 * scripts/admin/set-farmacia-autoridade-catalogo.ts para o uso real.
 */
export async function setFarmaciaAutoridadeCatalogo(
  prisma: Pick<PrismaClient, "farmacia" | "$transaction">,
  farmaciaId: string | null,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.farmacia.updateMany({ where: { autoridadeCatalogo: true }, data: { autoridadeCatalogo: false } });
    if (farmaciaId) {
      await tx.farmacia.update({ where: { id: farmaciaId }, data: { autoridadeCatalogo: true } });
    }
  });
}
