/**
 * lib/catalogo/resolver-fornecedor.ts
 *
 * Resolução/criação de `Fornecedor` por nome — mesma forma de
 * `getOrCreateFabricante` (lib/catalog-persistence.ts): match exacto por
 * `nomeNormalizado`, depois por `FornecedorAlias.aliasNome`, e só então
 * criação. A diferença deliberada face a `getOrCreateFabricante` é que esta
 * função recebe o `prisma` TENANT-SCOPED como parâmetro em vez de importar
 * o singleton `legacyPrisma` — `Fornecedor` vive numa base por tenant como
 * qualquer outra entidade de catálogo, e um singleton ligado a
 * `DATABASE_URL` resolveria sempre para o mesmo tenant, quebrando o
 * isolamento entre bases físicas.
 *
 * Resolução ("resolve por id/nome exacto/alias inequívoco, senão cria" —
 * especificação da manutenção em massa/fornecedor por linha):
 *   1. `fornecedorId` explícito, se dado e existente → usa directamente.
 *   2. Match exacto por `nomeNormalizado` (canónico).
 *   3. Match por `FornecedorAlias.aliasNome` — só se INEQUÍVOCO (exactamente
 *      um `fornecedorId` distinto). Um alias que aponte para mais do que um
 *      fornecedor é ambíguo e NUNCA é resolvido automaticamente — devolve
 *      `null` e o chamador decide (tipicamente: não escreve, reporta).
 *   4. Criação de um novo `Fornecedor`, com o nome legível preservado como
 *      alias quando diferir do canónico.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { normalizeFornecedorCanonico } from "@/lib/catalog-normalizers";

export type ResolverFornecedorResult =
  | { status: "resolvido"; fornecedorId: string; criado: boolean }
  | { status: "ambiguo"; candidatos: string[] }
  | { status: "invalido" };

/**
 * Resolve (ou cria) um Fornecedor a partir de um nome cru vindo do ERP ou
 * de input do utilizador. `prisma` tem de ser o cliente TENANT-SCOPED do
 * pedido corrente (nunca `legacyPrisma`).
 */
export async function resolverOuCriarFornecedor(
  prisma: PrismaClient,
  nomeCru: string | null | undefined,
  opts?: {
    /** Nome legível a preservar como alias quando diferir do canónico. Default: o próprio `nomeCru`. */
    aliasNome?: string | null;
    /** false (default) só resolve, nunca cria. true cria quando não há match. */
    criarSeInexistente?: boolean;
  }
): Promise<ResolverFornecedorResult> {
  const canonico = normalizeFornecedorCanonico(nomeCru);
  if (!canonico) return { status: "invalido" };

  const criarSeInexistente = opts?.criarSeInexistente ?? true;
  // Forma a registar como alias se um novo Fornecedor tiver de ser criado —
  // só faz sentido quando difere do canónico (senão seria um alias igual
  // ao próprio nomeNormalizado, redundante).
  const aliasParaCriar =
    opts?.aliasNome !== undefined
      ? opts.aliasNome
      : nomeCru && nomeCru.trim() !== canonico
        ? nomeCru.trim()
        : null;
  // Chave de BUSCA em FornecedorAlias — ao contrário de `aliasParaCriar`,
  // tem de correr SEMPRE que o match exacto por nomeNormalizado falhar,
  // mesmo quando o texto recebido já está na forma canónica (um alias pode
  // ter sido registado com esse valor exacto para OUTRO fornecedor — ex.:
  // "GENERIS DIRECTO" como alias, sem nunca ter sido dado como
  // `nomeNormalizado` de ninguém).
  const buscaAlias = opts?.aliasNome !== undefined ? opts.aliasNome : (nomeCru?.trim() || canonico);

  const byNome = await prisma.fornecedor.findUnique({
    where: { nomeNormalizado: canonico },
    select: { id: true },
  });
  if (byNome) {
    if (aliasParaCriar && aliasParaCriar !== canonico) {
      await prisma.fornecedorAlias
        .upsert({
          where: { fornecedorId_aliasNome: { fornecedorId: byNome.id, aliasNome: aliasParaCriar } },
          create: { fornecedorId: byNome.id, aliasNome: aliasParaCriar },
          update: {},
        })
        .catch(() => {});
    }
    return { status: "resolvido", fornecedorId: byNome.id, criado: false };
  }

  if (buscaAlias) {
    const porAlias = await prisma.fornecedorAlias.findMany({
      where: { aliasNome: buscaAlias },
      select: { fornecedorId: true },
    });
    const distintos = [...new Set(porAlias.map((a) => a.fornecedorId))];
    if (distintos.length === 1) {
      return { status: "resolvido", fornecedorId: distintos[0], criado: false };
    }
    if (distintos.length > 1) {
      return { status: "ambiguo", candidatos: distintos };
    }
  }

  if (!criarSeInexistente) return { status: "invalido" };

  const created = await prisma.fornecedor.create({
    data: {
      nomeNormalizado: canonico,
      nome: aliasParaCriar ?? canonico,
      estado: "ATIVO",
      ...(aliasParaCriar && aliasParaCriar !== canonico
        ? { aliases: { create: { aliasNome: aliasParaCriar } } }
        : {}),
    },
    select: { id: true },
  });

  return { status: "resolvido", fornecedorId: created.id, criado: true };
}
