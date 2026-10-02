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
 *
 * `prisma` é tipado como `Prisma.TransactionClient` em vez de `PrismaClient`
 * de propósito: um `PrismaClient` real é estruturalmente um sobre-conjunto
 * de `Prisma.TransactionClient` (este último é gerado como
 * `Omit<PrismaClient, ITXClientDenyList>`), por isso é atribuível onde um
 * `Prisma.TransactionClient` é esperado — mas o inverso não é verdade. Tipar
 * pelo mais restrito permite chamar esta função tanto com o `PrismaClient`
 * do pedido (fora de transacção) como com o `tx` dentro de
 * `prisma.$transaction(async (tx) => ...)`, sem `as any`/type-casts — ver
 * `resolverDestinoParaAplicar` em `lib/catalogo/manutencao-massa.ts`, que
 * precisa de criar o Fornecedor DENTRO da transacção de aplicação.
 */
import type { Prisma } from "@/generated/prisma/client";
import { normalizeFornecedorCanonico } from "@/lib/catalog-normalizers";

export type ResolverFornecedorResult =
  | { status: "resolvido"; fornecedorId: string; criado: boolean }
  | { status: "ambiguo"; candidatos: string[] }
  | { status: "invalido" };

/**
 * Resolve (ou cria) um Fornecedor a partir de um nome cru vindo do ERP ou
 * de input do utilizador. `prisma` tem de ser o cliente TENANT-SCOPED do
 * pedido corrente (nunca `legacyPrisma`) — um `PrismaClient` completo ou um
 * `Prisma.TransactionClient` (dentro de `$transaction`), ver nota de tipos
 * acima.
 */
export async function resolverOuCriarFornecedor(
  prisma: Prisma.TransactionClient,
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

export type FornecedorResolvidoPorTexto = { id: string; nome: string; estado: "ATIVO" | "INATIVO" };

/**
 * Resolução SÓ DE LEITURA de um conjunto de textos de fornecedor (ex.:
 * `ProdutoFarmacia.fornecedorOrigem`, o nome do fornecedor habitual no ERP)
 * para `Fornecedor` existentes. Nunca cria nem escreve nada (nem aliases —
 * ao contrário de `resolverOuCriarFornecedor`, que faz upsert de alias).
 *
 * Só devolve correspondências com EVIDÊNCIA: match exacto por
 * `nomeNormalizado` canónico, ou por `FornecedorAlias.aliasNome` quando aponta
 * para exactamente UM fornecedor. Ambíguo ou desconhecido → fica de fora do mapa.
 * Duas consultas em lote, nunca uma por texto.
 */
export async function resolverFornecedoresPorTextoSoLeitura(
  prisma: Prisma.TransactionClient,
  textos: readonly string[]
): Promise<Map<string, FornecedorResolvidoPorTexto>> {
  const out = new Map<string, FornecedorResolvidoPorTexto>();
  const unicos = [...new Set(textos.map((t) => t.trim()).filter(Boolean))];
  if (unicos.length === 0) return out;

  const canonicoDe = new Map<string, string>();
  for (const t of unicos) {
    const c = normalizeFornecedorCanonico(t);
    if (c) canonicoDe.set(t, c);
  }
  const canonicos = [...new Set(canonicoDe.values())];
  const porNome = canonicos.length
    ? await prisma.fornecedor.findMany({
        where: { nomeNormalizado: { in: canonicos } },
        select: { id: true, nome: true, nomeNormalizado: true, estado: true },
      })
    : [];
  const fornecedorPorCanonico = new Map(porNome.map((f) => [f.nomeNormalizado, f]));

  const semMatch = unicos.filter((t) => !fornecedorPorCanonico.has(canonicoDe.get(t) ?? "\u0000"));
  const alias = semMatch.length
    ? await prisma.fornecedorAlias.findMany({
        where: { aliasNome: { in: semMatch } },
        select: { aliasNome: true, fornecedorId: true },
      })
    : [];
  const idsPorAlias = new Map<string, Set<string>>();
  for (const a of alias) {
    const s = idsPorAlias.get(a.aliasNome) ?? new Set<string>();
    s.add(a.fornecedorId);
    idsPorAlias.set(a.aliasNome, s);
  }
  const idsUnicos = [...new Set([...idsPorAlias.values()].filter((s) => s.size === 1).map((s) => [...s][0]))];
  const porAliasFornecedor = idsUnicos.length
    ? await prisma.fornecedor.findMany({
        where: { id: { in: idsUnicos } },
        select: { id: true, nome: true, nomeNormalizado: true, estado: true },
      })
    : [];
  const fornecedorPorId = new Map(porAliasFornecedor.map((f) => [f.id, f]));

  for (const t of unicos) {
    const direto = fornecedorPorCanonico.get(canonicoDe.get(t) ?? "\u0000");
    if (direto) {
      out.set(t, { id: direto.id, nome: direto.nome ?? direto.nomeNormalizado, estado: direto.estado });
      continue;
    }
    const ids = idsPorAlias.get(t);
    if (ids && ids.size === 1) {
      const f = fornecedorPorId.get([...ids][0]);
      if (f) out.set(t, { id: f.id, nome: f.nome ?? f.nomeNormalizado, estado: f.estado });
    }
  }
  return out;
}
