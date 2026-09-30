/**
 * lib/catalogo/manutencao-massa.ts
 *
 * ManutenÃ§Ã£o em massa do catÃ¡logo â€” EXCLUSIVO do tenant silveira (gate no
 * caller, ver `TENANT_CATALOGO_MASSA` em `lib/tenant-context.ts`; este
 * mÃ³dulo nÃ£o lÃª o tenant sozinho, confia em quem o chama).
 *
 * Dois tipos de operaÃ§Ã£o:
 *   FABRICANTE  â€” escreve `Produto.fabricanteId` (catÃ¡logo partilhado do
 *                 tenant, NÃƒO por farmÃ¡cia).
 *   FORNECEDOR  â€” escreve `ProdutoFarmacia.fornecedorHabitualId` (por
 *                 farmÃ¡cia â€” `farmaciaId` Ã© obrigatÃ³rio no filtro).
 *
 * Fluxo esperado pelo caller (server actions em app/catalogo/manutencao/actions.ts):
 *   1. `validarFiltro` â€” validaÃ§Ã£o pura, sem BD.
 *   2. `listarProdutosPagina` / `listarIdsCorrespondentes` â€” para a grelha
 *      e para "seleccionar todos os N que correspondem ao filtro".
 *   3. `previewOperacao` â€” ecrÃ£ de confirmaÃ§Ã£o obrigatÃ³rio antes de gravar.
 *   4. `aplicarManutencaoMassa` â€” sÃ³ depois de confirmaÃ§Ã£o explÃ­cita.
 *   5. `reverterOperacao` â€” a partir do histÃ³rico.
 *
 * Nunca apaga/funde Fabricante/Fornecedor/aliases/grupos laboratoriais.
 * Nunca escreve fora do Ã¢mbito validado do pedido (farmÃ¡cia/tenant).
 *
 * â”€â”€ Nota sobre tipos Prisma usados aqui â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 * FunÃ§Ãµes que sÃ³ fazem leitura/escrita simples (sem resolver nomes) sÃ£o
 * tipadas com `Prisma.TransactionClient` â€” um PrismaClient real satisfaz
 * essa interface (Ã© um sobre-conjunto), por isso servem tanto fora como
 * dentro de `prisma.$transaction`. FunÃ§Ãµes que chamam
 * `resolverOuCriarFornecedor`/`resolverOuCriarFabricante` (que exigem
 * `PrismaClient` completo) sÃ³ correm FORA da transacÃ§Ã£o principal â€” ver
 * `resolverDestinoParaAplicar`. Isto evita criar Fabricante/Fornecedor
 * dentro da transacÃ§Ã£o de aplicaÃ§Ã£o (que exigiria um tipo incompatÃ­vel),
 * ao custo de, num cenÃ¡rio raro de falha a meio da transacÃ§Ã£o, deixar um
 * Fabricante/Fornecedor novo criado mas nÃ£o referenciado por nenhum
 * produto â€” nunca um duplicado (nome canÃ³nico Ã© `@unique`), apenas uma
 * entidade extra inofensiva. Documentado tambÃ©m no relatÃ³rio da tarefa.
 */
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { temFabricanteDivergenteEntreFarmacias } from "@/lib/ingest/catalog-from-erp";
import { normalizeFabricanteCanonico, normalizeFornecedorCanonico } from "@/lib/catalog-normalizers";
import { resolverOuCriarFornecedor } from "@/lib/catalogo/resolver-fornecedor";
import { resolverOuCriarFabricante } from "@/lib/catalogo/resolver-fabricante";

type Tx = Prisma.TransactionClient;

export type TipoManutencaoMassa = "FABRICANTE" | "FORNECEDOR";

/**
 * Filtros da manutenÃ§Ã£o em massa.
 *
 * `observacaoErp`: pedido na especificaÃ§Ã£o, mas NÃƒO existe nenhum campo em
 * `Produto`/`ProdutoFarmacia` que guarde uma observaÃ§Ã£o de texto livre
 * vinda do ERP (confirmado por leitura de `prisma/schema.prisma` â€” o mais
 * prÃ³ximo Ã© `ProdutoFarmacia.fornecedorOrigem`/`categoriaOrigem`, que sÃ£o
 * outra coisa). Filtro DELIBERADAMENTE omitido em vez de inventar um
 * campo ou uma migraÃ§Ã£o fora do Ã¢mbito desta tarefa.
 */
export type ManutencaoMassaFiltro = {
  /** ObrigatÃ³rio para FORNECEDOR; ignorado para FABRICANTE. */
  farmaciaId?: string | null;
  cnp?: number | null;
  designacao?: string | null;
  classificacaoNivel1Id?: string | null;
  classificacaoNivel2Id?: string | null;
  tipoArtigo?: string | null;
  fabricanteAtualId?: string | null;
  semFabricante?: boolean;
  fornecedorAtualId?: string | null;
  semFornecedor?: boolean;
  /** SÃ³ FABRICANTE â€” sinal informativo, nunca resolve nada sozinho. */
  fabricanteDivergente?: boolean;
  pesquisaTextual?: string | null;
};

export type DestinoInput =
  | { modo: "existente"; id: string }
  | { modo: "novo"; nome: string };

/**
 * ValidaÃ§Ã£o pura do filtro â€” sem BD. Devolve uma mensagem de erro, ou
 * `null` quando vÃ¡lido.
 */
export function validarFiltro(tipo: TipoManutencaoMassa, filtro: ManutencaoMassaFiltro): string | null {
  if (tipo === "FORNECEDOR") {
    if (!filtro.farmaciaId) {
      return "FarmÃ¡cia Ã© obrigatÃ³ria para manutenÃ§Ã£o de fornecedor preferencial.";
    }
    if (filtro.fabricanteDivergente) {
      return "\"Fabricante divergente\" sÃ³ Ã© aplicÃ¡vel ao tipo Fabricante.";
    }
  } else {
    if (filtro.fornecedorAtualId || filtro.semFornecedor) {
      return "Filtros de fornecedor sÃ³ sÃ£o aplicÃ¡veis ao tipo Fornecedor.";
    }
  }
  if (filtro.semFabricante && filtro.fabricanteAtualId) {
    return "\"Sem fabricante\" e \"fabricante actual\" sÃ£o mutuamente exclusivos.";
  }
  if (filtro.semFornecedor && filtro.fornecedorAtualId) {
    return "\"Sem fornecedor\" e \"fornecedor actual\" sÃ£o mutuamente exclusivos.";
  }
  return null;
}

/** Parte do filtro que se aplica sempre ao nÃ­vel de `Produto`. */
export function buildProdutoLevelWhere(filtro: ManutencaoMassaFiltro): Prisma.ProdutoWhereInput {
  const AND: Prisma.ProdutoWhereInput[] = [];
  if (filtro.cnp != null) AND.push({ cnp: filtro.cnp });
  if (filtro.designacao) {
    AND.push({ designacao: { contains: filtro.designacao, mode: "insensitive" } });
  }
  if (filtro.classificacaoNivel1Id) AND.push({ classificacaoNivel1Id: filtro.classificacaoNivel1Id });
  if (filtro.classificacaoNivel2Id) AND.push({ classificacaoNivel2Id: filtro.classificacaoNivel2Id });
  if (filtro.tipoArtigo) AND.push({ tipoArtigo: filtro.tipoArtigo });
  if (filtro.pesquisaTextual && filtro.pesquisaTextual.trim().length > 0) {
    const txt = filtro.pesquisaTextual.trim();
    const asNum = Number(txt);
    const or: Prisma.ProdutoWhereInput[] = [{ designacao: { contains: txt, mode: "insensitive" } }];
    if (Number.isFinite(asNum) && txt !== "") or.push({ cnp: asNum });
    AND.push({ OR: or });
  }
  return AND.length > 0 ? { AND } : {};
}

/** Where completo para FABRICANTE â€” directamente sobre `Produto`. */
export function buildFabricanteWhere(
  filtro: ManutencaoMassaFiltro,
  divergentIds?: Set<string>
): Prisma.ProdutoWhereInput {
  const AND: Prisma.ProdutoWhereInput[] = [buildProdutoLevelWhere(filtro)];
  if (filtro.semFabricante) {
    AND.push({ fabricanteId: null });
  } else if (filtro.fabricanteAtualId) {
    AND.push({ fabricanteId: filtro.fabricanteAtualId });
  }
  if (filtro.fabricanteDivergente) {
    const ids = divergentIds ? Array.from(divergentIds) : [];
    AND.push({ id: { in: ids.length > 0 ? ids : ["__nenhum__"] } });
  }
  return { AND };
}

/** Where completo para FORNECEDOR â€” sobre `ProdutoFarmacia`, farmÃ¡cia fixa. */
export function buildFornecedorWhere(filtro: ManutencaoMassaFiltro): Prisma.ProdutoFarmaciaWhereInput {
  const AND: Prisma.ProdutoFarmaciaWhereInput[] = [{ farmaciaId: filtro.farmaciaId! }];
  if (filtro.semFornecedor) {
    AND.push({ fornecedorHabitualId: null });
  } else if (filtro.fornecedorAtualId) {
    AND.push({ fornecedorHabitualId: filtro.fornecedorAtualId });
  }
  const produtoWhere = buildProdutoLevelWhere(filtro);
  if (Object.keys(produtoWhere).length > 0) {
    AND.push({ produto: produtoWhere });
  }
  return { AND };
}

/**
 * Produtos com `fabricanteErpAtual` divergente entre farmÃ¡cias do tenant.
 * Sinal informativo â€” nunca resolve nada sozinho (ver
 * `temFabricanteDivergenteEntreFarmacias`, lib/ingest/catalog-from-erp.ts).
 *
 * Varre `ProdutoFarmacia` inteira do tenant (tenant-scoped, nÃ£o Ã© global):
 * aceitÃ¡vel para o volume de uma farmÃ¡cia/grupo, mas nÃ£o escala
 * indefinidamente â€” ver limitaÃ§Ã£o conhecida no relatÃ³rio da tarefa.
 */
export async function resolverProdutosComFabricanteDivergente(prisma: Tx): Promise<Set<string>> {
  const rows = await prisma.produtoFarmacia.findMany({
    select: { produtoId: true, farmaciaId: true, fabricanteErpAtual: true },
  });
  const porProduto = new Map<string, Array<{ farmaciaId: string; fabricanteErpAtual: string | null }>>();
  for (const r of rows) {
    const arr = porProduto.get(r.produtoId) ?? [];
    arr.push({ farmaciaId: r.farmaciaId, fabricanteErpAtual: r.fabricanteErpAtual });
    porProduto.set(r.produtoId, arr);
  }
  const result = new Set<string>();
  for (const [produtoId, valores] of porProduto) {
    if (temFabricanteDivergenteEntreFarmacias(valores)) result.add(produtoId);
  }
  return result;
}

async function resolveDivergentIdsSeNecessario(
  prisma: Tx,
  tipo: TipoManutencaoMassa,
  filtro: ManutencaoMassaFiltro
): Promise<Set<string> | undefined> {
  if (tipo === "FABRICANTE" && filtro.fabricanteDivergente) {
    return resolverProdutosComFabricanteDivergente(prisma);
  }
  return undefined;
}

/** Todos os ids de Produto que correspondem ao filtro (para "seleccionar todos"). */
export async function listarIdsCorrespondentes(
  prisma: Tx,
  tipo: TipoManutencaoMassa,
  filtro: ManutencaoMassaFiltro
): Promise<string[]> {
  const erro = validarFiltro(tipo, filtro);
  if (erro) throw new Error(erro);

  if (tipo === "FABRICANTE") {
    const divergentIds = await resolveDivergentIdsSeNecessario(prisma, tipo, filtro);
    const where = buildFabricanteWhere(filtro, divergentIds);
    const rows = await prisma.produto.findMany({ where, select: { id: true } });
    return rows.map((r) => r.id);
  }
  const where = buildFornecedorWhere(filtro);
  const rows = await prisma.produtoFarmacia.findMany({ where, select: { produtoId: true } });
  return rows.map((r) => r.produtoId);
}

export type ItemManutencaoMassaPreview = {
  produtoId: string;
  cnp: number;
  designacao: string;
  valorAtualId: string | null;
  valorAtualNome: string | null;
};

/** PÃ¡gina (para a grelha) â€” sempre com contagem total exacta. */
export async function listarProdutosPagina(
  prisma: Tx,
  tipo: TipoManutencaoMassa,
  filtro: ManutencaoMassaFiltro,
  opts: { page: number; pageSize: number }
): Promise<{ totalCount: number; items: ItemManutencaoMassaPreview[] }> {
  const erro = validarFiltro(tipo, filtro);
  if (erro) throw new Error(erro);

  const page = Math.max(1, Math.floor(opts.page));
  const pageSize = Math.min(500, Math.max(1, Math.floor(opts.pageSize)));

  if (tipo === "FABRICANTE") {
    const divergentIds = await resolveDivergentIdsSeNecessario(prisma, tipo, filtro);
    const where = buildFabricanteWhere(filtro, divergentIds);
    const [totalCount, produtos] = await Promise.all([
      prisma.produto.count({ where }),
      prisma.produto.findMany({
        where,
        select: { id: true, cnp: true, designacao: true, fabricanteId: true, fabricante: { select: { nomeNormalizado: true } } },
        orderBy: { designacao: "asc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return {
      totalCount,
      items: produtos.map((p) => ({
        produtoId: p.id,
        cnp: p.cnp,
        designacao: p.designacao,
        valorAtualId: p.fabricanteId,
        valorAtualNome: p.fabricante?.nomeNormalizado ?? null,
      })),
    };
  }

  const where = buildFornecedorWhere(filtro);
  const [totalCount, linhas] = await Promise.all([
    prisma.produtoFarmacia.count({ where }),
    prisma.produtoFarmacia.findMany({
      where,
      select: {
        produtoId: true,
        fornecedorHabitualId: true,
        fornecedorHabitual: { select: { nomeNormalizado: true, nome: true } },
        produto: { select: { cnp: true, designacao: true } },
      },
      orderBy: { produto: { designacao: "asc" } },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);
  return {
    totalCount,
    items: linhas.map((l) => ({
      produtoId: l.produtoId,
      cnp: l.produto.cnp,
      designacao: l.produto.designacao,
      valorAtualId: l.fornecedorHabitualId,
      valorAtualNome: l.fornecedorHabitual?.nome ?? l.fornecedorHabitual?.nomeNormalizado ?? null,
    })),
  };
}

export type DestinoResolvido =
  | { status: "existente"; id: string; nome: string }
  | { status: "novo"; nomeCanonico: string }
  | { status: "ambiguo"; candidatos: string[] }
  | { status: "invalido" };

/**
 * Resolve o destino SEM criar nada â€” usado no preview, para poder mostrar
 * "este nome nÃ£o existe, vai ser criado" sem jÃ¡ ter criado.
 */
export async function resolverDestinoPreview(
  prisma: PrismaClient,
  tipo: TipoManutencaoMassa,
  destino: DestinoInput
): Promise<DestinoResolvido> {
  if (destino.modo === "existente") {
    if (tipo === "FABRICANTE") {
      const f = await prisma.fabricante.findUnique({
        where: { id: destino.id },
        select: { id: true, nomeNormalizado: true, estado: true },
      });
      if (!f || f.estado !== "ATIVO") return { status: "invalido" };
      return { status: "existente", id: f.id, nome: f.nomeNormalizado };
    }
    const f = await prisma.fornecedor.findUnique({
      where: { id: destino.id },
      select: { id: true, nomeNormalizado: true, nome: true, estado: true },
    });
    if (!f || f.estado !== "ATIVO") return { status: "invalido" };
    return { status: "existente", id: f.id, nome: f.nome ?? f.nomeNormalizado };
  }

  // modo "novo": nome cru vindo do utilizador â€” resolve exacto/alias, nunca cria.
  if (tipo === "FABRICANTE") {
    const r = await resolverOuCriarFabricante(prisma, destino.nome, { criarSeInexistente: false });
    if (r.status === "resolvido") {
      const f = await prisma.fabricante.findUnique({ where: { id: r.fabricanteId }, select: { nomeNormalizado: true } });
      return { status: "existente", id: r.fabricanteId, nome: f?.nomeNormalizado ?? "" };
    }
    if (r.status === "ambiguo") return { status: "ambiguo", candidatos: r.candidatos };
    const canonico = normalizeFabricanteCanonico(destino.nome);
    return canonico ? { status: "novo", nomeCanonico: canonico } : { status: "invalido" };
  }

  const r = await resolverOuCriarFornecedor(prisma, destino.nome, { criarSeInexistente: false });
  if (r.status === "resolvido") {
    const f = await prisma.fornecedor.findUnique({ where: { id: r.fornecedorId }, select: { nomeNormalizado: true, nome: true } });
    return { status: "existente", id: r.fornecedorId, nome: f?.nome ?? f?.nomeNormalizado ?? "" };
  }
  if (r.status === "ambiguo") return { status: "ambiguo", candidatos: r.candidatos };
  const canonico = normalizeFornecedorCanonico(destino.nome);
  return canonico ? { status: "novo", nomeCanonico: canonico } : { status: "invalido" };
}

/** Resolve o destino PARA APLICAR â€” cria quando `modo:"novo"` e nÃ£o existir ainda. */
async function resolverDestinoParaAplicar(
  prisma: PrismaClient,
  tipo: TipoManutencaoMassa,
  destino: DestinoInput
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (destino.modo === "existente") {
    const check = await resolverDestinoPreview(prisma, tipo, destino);
    if (check.status !== "existente") return { ok: false, error: "Destino invÃ¡lido." };
    return { ok: true, id: check.id };
  }
  if (tipo === "FABRICANTE") {
    const r = await resolverOuCriarFabricante(prisma, destino.nome, { criarSeInexistente: true });
    if (r.status !== "resolvido") {
      return { ok: false, error: r.status === "ambiguo" ? "Nome de fabricante ambÃ­guo." : "Nome de fabricante invÃ¡lido." };
    }
    return { ok: true, id: r.fabricanteId };
  }
  const r = await resolverOuCriarFornecedor(prisma, destino.nome, { criarSeInexistente: true });
  if (r.status !== "resolvido") {
    return { ok: false, error: r.status === "ambiguo" ? "Nome de fornecedor ambÃ­guo." : "Nome de fornecedor invÃ¡lido." };
  }
  return { ok: true, id: r.fornecedorId };
}

export type GrupoValorAnterior = {
  valorAnteriorId: string | null;
  valorAnteriorNome: string | null;
  count: number;
};

export type PreviewOperacaoResultado =
  | {
      ok: true;
      tipo: TipoManutencaoMassa;
      totalCount: number;
      agrupadoPorValorAnterior: GrupoValorAnterior[];
      jaNoDestinoCount: number;
      iraAlterarCount: number;
      destino: DestinoResolvido;
      amostra: ItemManutencaoMassaPreview[];
    }
  | { ok: false; error: string };

const AMOSTRA_LIMITE = 200;

/**
 * Preview obrigatÃ³rio antes de aplicar. Contagens sÃ£o sempre exactas
 * (nunca estimadas); sÃ³ a amostra devolvida Ã© capada.
 */
export async function previewOperacao(
  prisma: PrismaClient,
  tipo: TipoManutencaoMassa,
  filtro: ManutencaoMassaFiltro,
  destinoInput: DestinoInput
): Promise<PreviewOperacaoResultado> {
  const erroFiltro = validarFiltro(tipo, filtro);
  if (erroFiltro) return { ok: false, error: erroFiltro };

  const destino = await resolverDestinoPreview(prisma, tipo, destinoInput);
  if (destino.status === "invalido") return { ok: false, error: "Nome de destino invÃ¡lido." };
  if (destino.status === "ambiguo") {
    return { ok: false, error: "Nome de destino ambÃ­guo â€” corresponde a mais do que um registo existente." };
  }
  const destinoId = destino.status === "existente" ? destino.id : null;

  if (tipo === "FABRICANTE") {
    const divergentIds = await resolveDivergentIdsSeNecessario(prisma, tipo, filtro);
    const where = buildFabricanteWhere(filtro, divergentIds);
    const [totalCount, grupos, amostraRows] = await Promise.all([
      prisma.produto.count({ where }),
      prisma.produto.groupBy({ by: ["fabricanteId"], where, _count: { _all: true } }),
      prisma.produto.findMany({
        where,
        select: { id: true, cnp: true, designacao: true, fabricanteId: true, fabricante: { select: { nomeNormalizado: true } } },
        orderBy: { designacao: "asc" },
        take: AMOSTRA_LIMITE,
      }),
    ]);
    const fabricanteIds = grupos.map((g) => g.fabricanteId).filter((id): id is string => id !== null);
    const fabricantes = fabricanteIds.length
      ? await prisma.fabricante.findMany({ where: { id: { in: fabricanteIds } }, select: { id: true, nomeNormalizado: true } })
      : [];
    const nomePorId = new Map(fabricantes.map((f) => [f.id, f.nomeNormalizado]));
    const agrupadoPorValorAnterior: GrupoValorAnterior[] = grupos.map((g) => ({
      valorAnteriorId: g.fabricanteId,
      valorAnteriorNome: g.fabricanteId ? (nomePorId.get(g.fabricanteId) ?? null) : null,
      count: g._count._all,
    }));
    const jaNoDestinoCount = destinoId
      ? (agrupadoPorValorAnterior.find((g) => g.valorAnteriorId === destinoId)?.count ?? 0)
      : 0;
    return {
      ok: true,
      tipo,
      totalCount,
      agrupadoPorValorAnterior,
      jaNoDestinoCount,
      iraAlterarCount: totalCount - jaNoDestinoCount,
      destino,
      amostra: amostraRows.map((p) => ({
        produtoId: p.id,
        cnp: p.cnp,
        designacao: p.designacao,
        valorAtualId: p.fabricanteId,
        valorAtualNome: p.fabricante?.nomeNormalizado ?? null,
      })),
    };
  }

  const where = buildFornecedorWhere(filtro);
  const [totalCount, grupos, amostraRows] = await Promise.all([
    prisma.produtoFarmacia.count({ where }),
    prisma.produtoFarmacia.groupBy({ by: ["fornecedorHabitualId"], where, _count: { _all: true } }),
    prisma.produtoFarmacia.findMany({
      where,
      select: {
        produtoId: true,
        fornecedorHabitualId: true,
        fornecedorHabitual: { select: { nomeNormalizado: true, nome: true } },
        produto: { select: { cnp: true, designacao: true } },
      },
      orderBy: { produto: { designacao: "asc" } },
      take: AMOSTRA_LIMITE,
    }),
  ]);
  const fornecedorIds = grupos.map((g) => g.fornecedorHabitualId).filter((id): id is string => id !== null);
  const fornecedores = fornecedorIds.length
    ? await prisma.fornecedor.findMany({ where: { id: { in: fornecedorIds } }, select: { id: true, nomeNormalizado: true, nome: true } })
    : [];
  const nomePorId = new Map(fornecedores.map((f) => [f.id, f.nome ?? f.nomeNormalizado]));
  const agrupadoPorValorAnterior: GrupoValorAnterior[] = grupos.map((g) => ({
    valorAnteriorId: g.fornecedorHabitualId,
    valorAnteriorNome: g.fornecedorHabitualId ? (nomePorId.get(g.fornecedorHabitualId) ?? null) : null,
    count: g._count._all,
  }));
  const jaNoDestinoCount = destinoId
    ? (agrupadoPorValorAnterior.find((g) => g.valorAnteriorId === destinoId)?.count ?? 0)
    : 0;
  return {
    ok: true,
    tipo,
    totalCount,
    agrupadoPorValorAnterior,
    jaNoDestinoCount,
    iraAlterarCount: totalCount - jaNoDestinoCount,
    destino,
    amostra: amostraRows.map((l) => ({
      produtoId: l.produtoId,
      cnp: l.produto.cnp,
      designacao: l.produto.designacao,
      valorAtualId: l.fornecedorHabitualId,
      valorAtualNome: l.fornecedorHabitual?.nome ?? l.fornecedorHabitual?.nomeNormalizado ?? null,
    })),
  };
}

export type AplicarManutencaoMassaInput = {
  tipo: TipoManutencaoMassa;
  filtro: ManutencaoMassaFiltro;
  destino: DestinoInput;
  /**
   * Subconjunto explÃ­cito escolhido pelo utilizador (ex.: depois de
   * desseleccionar alguns itens de "seleccionar todos"). NUNCA tratado
   * como super-conjunto â€” Ã© sempre intersectado com o que o filtro
   * confirma server-side dentro da transacÃ§Ã£o. `undefined` = todos os
   * que correspondem ao filtro.
   */
  produtoIdsSubconjunto?: string[];
  utilizadorId: string;
  motivo?: string | null;
};

export type AplicarManutencaoMassaResultado =
  | {
      ok: true;
      operacaoId: string;
      quantidadeSolicitada: number;
      quantidadeAlterada: number;
      quantidadeIgnorada: number;
    }
  | { ok: false; error: string };

/**
 * Aplica a operaÃ§Ã£o, totalmente transaccional. Revalida o filtro
 * SERVER-SIDE dentro da transacÃ§Ã£o â€” nunca confia num id de produto vindo
 * do cliente como autoritÃ¡rio; um subconjunto explÃ­cito Ã© intersectado
 * com os matches reais, nunca alarga a selecÃ§Ã£o.
 */
export async function aplicarManutencaoMassa(
  prisma: PrismaClient,
  input: AplicarManutencaoMassaInput
): Promise<AplicarManutencaoMassaResultado> {
  const erroFiltro = validarFiltro(input.tipo, input.filtro);
  if (erroFiltro) return { ok: false, error: erroFiltro };

  const destinoResolvido = await resolverDestinoParaAplicar(prisma, input.tipo, input.destino);
  if (!destinoResolvido.ok) return destinoResolvido;
  const destinoId = destinoResolvido.id;

  try {
    const resultado = await prisma.$transaction(async (tx) => {
      let alvo: Array<{ produtoId: string; valorAnterior: string | null }>;

      if (input.tipo === "FABRICANTE") {
        const divergentIds = await resolveDivergentIdsSeNecessario(tx, input.tipo, input.filtro);
        const where = buildFabricanteWhere(input.filtro, divergentIds);
        const produtos = await tx.produto.findMany({ where, select: { id: true, fabricanteId: true } });
        alvo = produtos.map((p) => ({ produtoId: p.id, valorAnterior: p.fabricanteId }));
      } else {
        const where = buildFornecedorWhere(input.filtro);
        const linhas = await tx.produtoFarmacia.findMany({ where, select: { produtoId: true, fornecedorHabitualId: true } });
        alvo = linhas.map((l) => ({ produtoId: l.produtoId, valorAnterior: l.fornecedorHabitualId }));
      }

      if (input.produtoIdsSubconjunto) {
        const subset = new Set(input.produtoIdsSubconjunto);
        alvo = alvo.filter((a) => subset.has(a.produtoId));
      }

      if (alvo.length === 0) {
        throw new Error("NENHUM_PRODUTO_CORRESPONDE");
      }

      let alterados = 0;
      let ignorados = 0;
      const itens: Prisma.CatalogoManutencaoOperacaoItemCreateManyOperacaoInput[] = [];

      for (const item of alvo) {
        if (item.valorAnterior === destinoId) {
          ignorados++;
        } else {
          alterados++;
          if (input.tipo === "FABRICANTE") {
            await tx.produto.update({
              where: { id: item.produtoId },
              data: { fabricanteId: destinoId, dataAtualizacao: new Date() },
            });
          } else {
            await tx.produtoFarmacia.update({
              where: { produtoId_farmaciaId: { produtoId: item.produtoId, farmaciaId: input.filtro.farmaciaId! } },
              data: { fornecedorHabitualId: destinoId },
            });
          }
        }
        itens.push({ produtoId: item.produtoId, valorAnteriorId: item.valorAnterior, valorNovoId: destinoId });
      }

      const operacao = await tx.catalogoManutencaoOperacao.create({
        data: {
          tipo: input.tipo,
          utilizadorId: input.utilizadorId,
          farmaciaId: input.tipo === "FORNECEDOR" ? input.filtro.farmaciaId! : null,
          filtrosJson: JSON.stringify(input.filtro),
          valorNovoId: destinoId,
          quantidadeSolicitada: alvo.length,
          quantidadeAlterada: alterados,
          quantidadeIgnorada: ignorados,
          motivo: input.motivo ?? null,
          origem: "MANUTENCAO_MASSA",
          itens: { createMany: { data: itens } },
        },
        select: { id: true },
      });

      return {
        operacaoId: operacao.id,
        quantidadeSolicitada: alvo.length,
        quantidadeAlterada: alterados,
        quantidadeIgnorada: ignorados,
      };
    });

    return { ok: true, ...resultado };
  } catch (err) {
    if (err instanceof Error && err.message === "NENHUM_PRODUTO_CORRESPONDE") {
      return { ok: false, error: "Nenhum produto corresponde aos filtros indicados." };
    }
    return { ok: false, error: err instanceof Error ? err.message : "Erro desconhecido ao aplicar manutenÃ§Ã£o em massa." };
  }
}

/** Moda (valor mais frequente) â€” sÃ³ usado como resumo informativo no cabeÃ§alho da reversÃ£o. */
export function modaValorNovoId(itens: Array<{ valorNovoId: string }>): string {
  const counts = new Map<string, number>();
  for (const i of itens) counts.set(i.valorNovoId, (counts.get(i.valorNovoId) ?? 0) + 1);
  let melhor = itens[0].valorNovoId;
  let melhorCount = -1;
  for (const [id, c] of counts) {
    if (c > melhorCount) {
      melhor = id;
      melhorCount = c;
    }
  }
  return melhor;
}

export type ReverterOperacaoResultado =
  | {
      ok: true;
      operacaoOrigemId: string;
      novaOperacaoId: string;
      revertidos: number;
      ignorados: Array<{ produtoId: string; motivo: string }>;
    }
  | { ok: false; error: string };

/**
 * Reverte uma operaÃ§Ã£o: cada item sÃ³ Ã© revertido se (a) tiver um valor
 * anterior registado â€” restaurar para "vazio" nÃ£o Ã© representÃ¡vel neste
 * esquema, ver nota abaixo â€” (b) nenhuma operaÃ§Ã£o POSTERIOR do mesmo tipo
 * (e mesma farmÃ¡cia, quando aplicÃ¡vel) tocou o mesmo produto, e (c) o
 * valor ao vivo do produto ainda for exactamente o que esta operaÃ§Ã£o
 * escreveu. Cria uma NOVA operaÃ§Ã£o (`origem: "REVERSAO"`,
 * `operacaoOrigemId` a apontar para a original) â€” a original nunca Ã©
 * apagada nem alterada.
 *
 * â”€â”€ LimitaÃ§Ã£o conhecida do esquema â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 * `CatalogoManutencaoOperacaoItem.valorNovoId` Ã© `String` (NOT NULL).
 * Um item cujo `valorAnteriorId` original era `null` (o produto nÃ£o tinha
 * fabricante/fornecedor antes da operaÃ§Ã£o) nÃ£o pode ser revertido: a
 * reversÃ£o teria de escrever `valorNovoId = null` nesse item, o que o
 * esquema (jÃ¡ aplicado por uma migraÃ§Ã£o anterior, fora do Ã¢mbito desta
 * tarefa) nÃ£o permite. Esses itens sÃ£o sempre reportados como
 * "ignorados" com o motivo correspondente â€” nunca silenciosamente.
 *
 * O `valorNovoId` do CABEÃ‡ALHO da reversÃ£o Ã© sÃ³ um resumo informativo
 * (a moda dos valores restaurados nos itens) â€” a fonte de verdade Ã©
 * sempre `item.valorNovoId` por item, nunca o campo do cabeÃ§alho, porque
 * uma reversÃ£o restaura um valor DIFERENTE por produto, nÃ£o um valor
 * Ãºnico.
 */
export async function reverterOperacao(
  prisma: PrismaClient,
  operacaoOrigemId: string,
  utilizadorId: string,
  motivo?: string | null
): Promise<ReverterOperacaoResultado> {
  const original = await prisma.catalogoManutencaoOperacao.findUnique({
    where: { id: operacaoOrigemId },
    include: { itens: true },
  });
  if (!original) return { ok: false, error: "OperaÃ§Ã£o nÃ£o encontrada." };

  try {
    const resultado = await prisma.$transaction(async (tx) => {
      const produtoIds = original.itens.map((i) => i.produtoId);
      const itensPosteriores = produtoIds.length
        ? await tx.catalogoManutencaoOperacaoItem.findMany({
            where: {
              produtoId: { in: produtoIds },
              operacao: {
                tipo: original.tipo,
                farmaciaId: original.farmaciaId,
                dataCriacao: { gt: original.dataCriacao },
              },
            },
            select: { produtoId: true },
          })
        : [];
      const tocadosDepois = new Set(itensPosteriores.map((i) => i.produtoId));

      const ignorados: Array<{ produtoId: string; motivo: string }> = [];
      const itensRevert: Prisma.CatalogoManutencaoOperacaoItemCreateManyOperacaoInput[] = [];

      for (const item of original.itens) {
        if (item.valorAnteriorId === null) {
          ignorados.push({
            produtoId: item.produtoId,
            motivo: "Sem valor anterior registado â€” reversÃ£o para vazio nÃ£o suportada.",
          });
          continue;
        }
        if (tocadosDepois.has(item.produtoId)) {
          ignorados.push({ produtoId: item.produtoId, motivo: "Produto alterado por uma operaÃ§Ã£o posterior." });
          continue;
        }

        let valorAtual: string | null;
        if (original.tipo === "FABRICANTE") {
          const p = await tx.produto.findUnique({ where: { id: item.produtoId }, select: { fabricanteId: true } });
          valorAtual = p?.fabricanteId ?? null;
        } else {
          const pf = await tx.produtoFarmacia.findUnique({
            where: { produtoId_farmaciaId: { produtoId: item.produtoId, farmaciaId: original.farmaciaId! } },
            select: { fornecedorHabitualId: true },
          });
          valorAtual = pf?.fornecedorHabitualId ?? null;
        }
        if (valorAtual !== item.valorNovoId) {
          ignorados.push({
            produtoId: item.produtoId,
            motivo: "Valor actual jÃ¡ nÃ£o corresponde ao valor aplicado por esta operaÃ§Ã£o.",
          });
          continue;
        }

        if (original.tipo === "FABRICANTE") {
          await tx.produto.update({
            where: { id: item.produtoId },
            data: { fabricanteId: item.valorAnteriorId, dataAtualizacao: new Date() },
          });
        } else {
          await tx.produtoFarmacia.update({
            where: { produtoId_farmaciaId: { produtoId: item.produtoId, farmaciaId: original.farmaciaId! } },
            data: { fornecedorHabitualId: item.valorAnteriorId },
          });
        }
        itensRevert.push({ produtoId: item.produtoId, valorAnteriorId: item.valorNovoId, valorNovoId: item.valorAnteriorId });
      }

      if (itensRevert.length === 0) {
        throw new Error("NENHUM_ELEGIVEL");
      }

      const novaOperacao = await tx.catalogoManutencaoOperacao.create({
        data: {
          tipo: original.tipo,
          utilizadorId,
          farmaciaId: original.farmaciaId,
          filtrosJson: original.filtrosJson,
          valorNovoId: modaValorNovoId(itensRevert.map((i) => ({ valorNovoId: i.valorNovoId }))),
          quantidadeSolicitada: original.itens.length,
          quantidadeAlterada: itensRevert.length,
          quantidadeIgnorada: ignorados.length,
          motivo: motivo ?? null,
          origem: "REVERSAO",
          operacaoOrigemId: original.id,
          itens: { createMany: { data: itensRevert } },
        },
        select: { id: true },
      });

      return { novaOperacaoId: novaOperacao.id, revertidos: itensRevert.length, ignorados };
    });

    return {
      ok: true,
      operacaoOrigemId,
      novaOperacaoId: resultado.novaOperacaoId,
      revertidos: resultado.revertidos,
      ignorados: resultado.ignorados,
    };
  } catch (err) {
    if (err instanceof Error && err.message === "NENHUM_ELEGIVEL") {
      return { ok: false, error: "Nenhum produto elegÃ­vel para reversÃ£o â€” todos foram alterados desde entÃ£o." };
    }
    return { ok: false, error: err instanceof Error ? err.message : "Erro desconhecido ao reverter." };
  }
}
