/**
 * lib/catalogo/resolver-fabricante.ts
 *
 * Resolução/criação de `Fabricante` por nome — equivalente tenant-scoped
 * de `getOrCreateFabricante` (lib/catalog-persistence.ts), que importa o
 * singleton `legacyPrisma` e por isso não serve aqui: a manutenção em
 * massa recebe o `prisma` TENANT-SCOPED do pedido corrente, e um
 * singleton ligado a `DATABASE_URL` resolveria sempre para o mesmo
 * tenant, quebrando o isolamento entre bases físicas (mesmo motivo que
 * levou `resolverOuCriarFornecedor` a existir em vez de reaproveitar um
 * helper equivalente ligado ao singleton).
 *
 * Mesma forma de `resolverOuCriarFornecedor` (lib/catalogo/resolver-fornecedor.ts),
 * incluindo a detecção de alias ambíguo (`getOrCreateFabricante` usa
 * `findFirst` e nunca reporta ambiguidade — aqui usamos `findMany` +
 * verificação de unicidade, mais seguro para uma acção que o utilizador
 * dispara directamente sobre o catálogo em massa).
 *
 * Resolução ("resolve por nome exacto/alias inequívoco, senão cria"):
 *   1. Match exacto por `nomeNormalizado` (canónico).
 *   2. Match por `FabricanteAlias.aliasNome` — só se INEQUÍVOCO (exactamente
 *      um `fabricanteId` distinto). Ambíguo nunca resolve sozinho.
 *   3. Criação de um novo `Fabricante` (só quando `criarSeInexistente`).
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { normalizeFabricanteCanonico } from "@/lib/catalog-normalizers";

export type ResolverFabricanteResult =
  | { status: "resolvido"; fabricanteId: string; criado: boolean }
  | { status: "ambiguo"; candidatos: string[] }
  | { status: "invalido" };

/**
 * Resolve (ou cria) um Fabricante a partir de um nome cru. `prisma` tem de
 * ser o cliente TENANT-SCOPED do pedido corrente (nunca `legacyPrisma`).
 */
export async function resolverOuCriarFabricante(
  prisma: PrismaClient,
  nomeCru: string | null | undefined,
  opts?: {
    /** Nome a preservar como alias quando diferir do canónico. Default: o próprio `nomeCru`. */
    aliasNome?: string | null;
    /** false (default) só resolve, nunca cria. true cria quando não há match. */
    criarSeInexistente?: boolean;
  }
): Promise<ResolverFabricanteResult> {
  const canonico = normalizeFabricanteCanonico(nomeCru);
  if (!canonico) return { status: "invalido" };

  const criarSeInexistente = opts?.criarSeInexistente ?? true;
  const aliasParaCriar =
    opts?.aliasNome !== undefined
      ? opts.aliasNome
      : nomeCru && nomeCru.trim() !== canonico
        ? nomeCru.trim()
        : null;
  const buscaAlias = opts?.aliasNome !== undefined ? opts.aliasNome : (nomeCru?.trim() || canonico);

  const byNome = await prisma.fabricante.findUnique({
    where: { nomeNormalizado: canonico },
    select: { id: true },
  });
  if (byNome) {
    if (aliasParaCriar && aliasParaCriar !== canonico) {
      await prisma.fabricanteAlias
        .upsert({
          where: { fabricanteId_aliasNome: { fabricanteId: byNome.id, aliasNome: aliasParaCriar } },
          create: { fabricanteId: byNome.id, aliasNome: aliasParaCriar },
          update: {},
        })
        .catch(() => {});
    }
    return { status: "resolvido", fabricanteId: byNome.id, criado: false };
  }

  if (buscaAlias) {
    const porAlias = await prisma.fabricanteAlias.findMany({
      where: { aliasNome: buscaAlias },
      select: { fabricanteId: true },
    });
    const distintos = [...new Set(porAlias.map((a) => a.fabricanteId))];
    if (distintos.length === 1) {
      return { status: "resolvido", fabricanteId: distintos[0], criado: false };
    }
    if (distintos.length > 1) {
      return { status: "ambiguo", candidatos: distintos };
    }
  }

  if (!criarSeInexistente) return { status: "invalido" };

  const created = await prisma.fabricante.create({
    data: {
      nomeNormalizado: canonico,
      estado: "ATIVO",
      ...(aliasParaCriar && aliasParaCriar !== canonico
        ? { aliases: { create: { aliasNome: aliasParaCriar } } }
        : {}),
    },
    select: { id: true },
  });

  return { status: "resolvido", fabricanteId: created.id, criado: true };
}
