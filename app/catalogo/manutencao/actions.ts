"use server";

/**
 * app/catalogo/manutencao/actions.ts
 *
 * Server actions da manutenção em massa do catálogo — EXCLUSIVAS do
 * tenant silveira. Todas seguem a mesma ordem de guardas, antes de
 * qualquer chamada à BD:
 *   1. `resolveCurrentTenantSlug() === TENANT_CATALOGO_MASSA` — se não,
 *      rejeita de forma limpa (nunca um throw não tratado).
 *   2. Sessão + `can(session, "catalog.write")`.
 *   3. Validação do payload contra os dados REAIS do tenant (farmaciaId
 *      tem de ser uma Farmacia existente; se a sessão for farmácia-scoped
 *      — não ADMINISTRADOR/GESTOR_GRUPO — só pode agir sobre a sua
 *      própria farmácia, via `canAccessFarmaciaSync`).
 *
 * Nunca reutiliza `requirePlatformAdmin()` (app/admin/**) — essa é a
 * consola cross-tenant, sem relação com este ecrã per-tenant.
 */
import { revalidatePath } from "next/cache";
import { getPrisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { can, canAccessFarmaciaSync } from "@/lib/permissions-core";
import { logAudit } from "@/lib/audit";
import { resolveCurrentTenantSlug, TENANT_CATALOGO_MASSA } from "@/lib/tenant-context";
import {
  aplicarManutencaoMassa,
  listarIdsCorrespondentes,
  listarProdutosPagina,
  previewOperacao,
  reverterOperacao,
  validarFiltro,
  type DestinoInput,
  type ManutencaoMassaFiltro,
  type TipoManutencaoMassa,
} from "@/lib/catalogo/manutencao-massa";

/**
 * Guarda comum aos 3 primeiros passos. Devolve a sessão + prisma
 * tenant-scoped quando tudo bate certo, ou uma rejeição limpa.
 */
async function guardaBase() {
  const tenantSlug = await resolveCurrentTenantSlug();
  if (tenantSlug !== TENANT_CATALOGO_MASSA) {
    return { ok: false as const, error: "Funcionalidade não disponível para este tenant." };
  }
  const session = await getSession();
  if (!session || !can(session, "catalog.write")) {
    return { ok: false as const, error: "Sem permissão para editar o catálogo." };
  }
  const prisma = await getPrisma();
  return { ok: true as const, session, prisma };
}

/**
 * Valida que a farmácia pedida existe de facto no tenant e que a sessão
 * pode agir sobre ela (ADMINISTRADOR/GESTOR_GRUPO: qualquer uma;
 * GESTOR_FARMACIA/OPERADOR: só a sua própria).
 */
async function validarFarmaciaDoPedido(
  prisma: Awaited<ReturnType<typeof getPrisma>>,
  session: NonNullable<Awaited<ReturnType<typeof getSession>>>,
  farmaciaId: string | null | undefined
): Promise<string | null> {
  if (!farmaciaId) return "Farmácia é obrigatória.";
  if (!canAccessFarmaciaSync(session, farmaciaId)) {
    return "Sem acesso a esta farmácia.";
  }
  const farmacia = await prisma.farmacia.findUnique({ where: { id: farmaciaId }, select: { id: true } });
  if (!farmacia) return "Farmácia não encontrada.";
  return null;
}

/** Valida `filtro.*Id` contra a BD real do tenant (nunca confia cegamente no cliente). */
async function validarReferenciasDoFiltro(
  prisma: Awaited<ReturnType<typeof getPrisma>>,
  tipo: TipoManutencaoMassa,
  filtro: ManutencaoMassaFiltro
): Promise<string | null> {
  if (filtro.classificacaoNivel1Id) {
    const c = await prisma.classificacao.findUnique({ where: { id: filtro.classificacaoNivel1Id }, select: { id: true, tipo: true } });
    if (!c || c.tipo !== "NIVEL_1") return "Categoria inválida.";
  }
  if (filtro.classificacaoNivel2Id) {
    const c = await prisma.classificacao.findUnique({ where: { id: filtro.classificacaoNivel2Id }, select: { id: true, tipo: true } });
    if (!c || c.tipo !== "NIVEL_2") return "Subcategoria inválida.";
  }
  if (filtro.fabricanteAtualId) {
    const f = await prisma.fabricante.findUnique({ where: { id: filtro.fabricanteAtualId }, select: { id: true } });
    if (!f) return "Fabricante actual inválido.";
  }
  if (tipo === "FORNECEDOR" && filtro.fornecedorAtualId) {
    const f = await prisma.fornecedor.findUnique({ where: { id: filtro.fornecedorAtualId }, select: { id: true } });
    if (!f) return "Fornecedor actual inválido.";
  }
  return null;
}

async function validarPedido(
  prisma: Awaited<ReturnType<typeof getPrisma>>,
  session: NonNullable<Awaited<ReturnType<typeof getSession>>>,
  tipo: TipoManutencaoMassa,
  filtro: ManutencaoMassaFiltro
): Promise<string | null> {
  const erroFiltro = validarFiltro(tipo, filtro);
  if (erroFiltro) return erroFiltro;
  if (tipo === "FORNECEDOR") {
    const erroFarmacia = await validarFarmaciaDoPedido(prisma, session, filtro.farmaciaId);
    if (erroFarmacia) return erroFarmacia;
  }
  return validarReferenciasDoFiltro(prisma, tipo, filtro);
}

// ─── Consulta / grelha ──────────────────────────────────────────────────────

export type ListarProdutosInput = {
  tipo: TipoManutencaoMassa;
  filtro: ManutencaoMassaFiltro;
  page?: number;
  pageSize?: number;
};

export async function listarProdutosManutencaoMassaAction(input: ListarProdutosInput) {
  const guarda = await guardaBase();
  if (!guarda.ok) return guarda;
  const { session, prisma } = guarda;

  const erro = await validarPedido(prisma, session!, input.tipo, input.filtro);
  if (erro) return { ok: false as const, error: erro };

  try {
    const data = await listarProdutosPagina(prisma, input.tipo, input.filtro, {
      page: input.page ?? 1,
      pageSize: input.pageSize ?? 50,
    });
    return { ok: true as const, ...data };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : "Erro ao listar produtos." };
  }
}

export async function listarIdsCorrespondentesAction(input: { tipo: TipoManutencaoMassa; filtro: ManutencaoMassaFiltro }) {
  const guarda = await guardaBase();
  if (!guarda.ok) return guarda;
  const { session, prisma } = guarda;

  const erro = await validarPedido(prisma, session!, input.tipo, input.filtro);
  if (erro) return { ok: false as const, error: erro };

  try {
    const ids = await listarIdsCorrespondentes(prisma, input.tipo, input.filtro);
    return { ok: true as const, ids, total: ids.length };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : "Erro ao resolver selecção." };
  }
}

// ─── Preview ────────────────────────────────────────────────────────────────

export type PreviewManutencaoMassaInput = {
  tipo: TipoManutencaoMassa;
  filtro: ManutencaoMassaFiltro;
  destino: DestinoInput;
};

async function previewAction(input: PreviewManutencaoMassaInput) {
  const guarda = await guardaBase();
  if (!guarda.ok) return guarda;
  const { session, prisma } = guarda;

  const erro = await validarPedido(prisma, session!, input.tipo, input.filtro);
  if (erro) return { ok: false as const, error: erro };

  return previewOperacao(prisma, input.tipo, input.filtro, input.destino);
}

/** Preview para o tipo FABRICANTE. */
export async function previewManutencaoFabricanteAction(input: Omit<PreviewManutencaoMassaInput, "tipo">) {
  return previewAction({ ...input, tipo: "FABRICANTE" });
}

/** Preview para o tipo FORNECEDOR (farmácia obrigatória em `filtro.farmaciaId`). */
export async function previewManutencaoFornecedorAction(input: Omit<PreviewManutencaoMassaInput, "tipo">) {
  return previewAction({ ...input, tipo: "FORNECEDOR" });
}

// ─── Aplicar ────────────────────────────────────────────────────────────────

export type AplicarManutencaoMassaActionInput = {
  tipo: TipoManutencaoMassa;
  filtro: ManutencaoMassaFiltro;
  destino: DestinoInput;
  produtoIdsSubconjunto?: string[];
  motivo?: string | null;
};

async function aplicarAction(input: AplicarManutencaoMassaActionInput) {
  const guarda = await guardaBase();
  if (!guarda.ok) return guarda;
  const { session, prisma } = guarda;

  const erro = await validarPedido(prisma, session!, input.tipo, input.filtro);
  if (erro) return { ok: false as const, error: erro };

  const resultado = await aplicarManutencaoMassa(prisma, {
    tipo: input.tipo,
    filtro: input.filtro,
    destino: input.destino,
    produtoIdsSubconjunto: input.produtoIdsSubconjunto,
    utilizadorId: session!.sub,
    motivo: input.motivo,
  });

  if (resultado.ok) {
    await logAudit({
      actorId: session!.sub,
      action: "catalogo.manutencao_massa_aplicada",
      entity: "CatalogoManutencaoOperacao",
      entityId: resultado.operacaoId,
      meta: {
        tipo: input.tipo,
        farmaciaId: input.tipo === "FORNECEDOR" ? input.filtro.farmaciaId : null,
        quantidadeSolicitada: resultado.quantidadeSolicitada,
        quantidadeAlterada: resultado.quantidadeAlterada,
        quantidadeIgnorada: resultado.quantidadeIgnorada,
      },
    });
    revalidatePath("/catalogo/manutencao");
  }

  return resultado;
}

/** Aplica manutenção em massa de FABRICANTE (`filtro.farmaciaId` é ignorado). */
export async function aplicarManutencaoFabricanteAction(input: Omit<AplicarManutencaoMassaActionInput, "tipo">) {
  return aplicarAction({ ...input, tipo: "FABRICANTE" });
}

/** Aplica manutenção em massa de FORNECEDOR (`filtro.farmaciaId` obrigatório). */
export async function aplicarManutencaoFornecedorAction(input: Omit<AplicarManutencaoMassaActionInput, "tipo">) {
  return aplicarAction({ ...input, tipo: "FORNECEDOR" });
}

// ─── Histórico / reversão ───────────────────────────────────────────────────

export async function listarOperacoesRecentesAction(opts?: { page?: number; pageSize?: number }) {
  const guarda = await guardaBase();
  if (!guarda.ok) return guarda;
  const { prisma } = guarda;

  const page = Math.max(1, opts?.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, opts?.pageSize ?? 25));

  try {
    const [total, operacoes] = await Promise.all([
      prisma.catalogoManutencaoOperacao.count(),
      prisma.catalogoManutencaoOperacao.findMany({
        orderBy: { dataCriacao: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          utilizador: { select: { nome: true, email: true } },
          farmacia: { select: { nome: true } },
          _count: { select: { itens: true, reversoes: true } },
        },
      }),
    ]);
    return {
      ok: true as const,
      total,
      page,
      pageSize,
      operacoes: operacoes.map((op) => ({
        id: op.id,
        tipo: op.tipo,
        utilizadorNome: op.utilizador.nome,
        farmaciaNome: op.farmacia?.nome ?? null,
        dataCriacao: op.dataCriacao,
        quantidadeSolicitada: op.quantidadeSolicitada,
        quantidadeAlterada: op.quantidadeAlterada,
        quantidadeIgnorada: op.quantidadeIgnorada,
        motivo: op.motivo,
        origem: op.origem,
        operacaoOrigemId: op.operacaoOrigemId,
        totalItens: op._count.itens,
        jaTemReversao: op._count.reversoes > 0,
      })),
    };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : "Erro ao listar operações." };
  }
}

export async function reverterOperacaoAction(input: { operacaoId: string; motivo?: string | null }) {
  const guarda = await guardaBase();
  if (!guarda.ok) return guarda;
  const { session, prisma } = guarda;

  // A operação a reverter tem de pertencer a este tenant (implícito: só
  // existe na base tenant-scoped já resolvida por getPrisma()) — mas se
  // for tipo FORNECEDOR, a farmácia da operação original também tem de
  // ser acessível pela sessão corrente, senão um GESTOR_FARMACIA de uma
  // farmácia podia reverter uma operação de outra.
  const operacao = await prisma.catalogoManutencaoOperacao.findUnique({
    where: { id: input.operacaoId },
    select: { id: true, farmaciaId: true },
  });
  if (!operacao) return { ok: false as const, error: "Operação não encontrada." };
  if (operacao.farmaciaId && !canAccessFarmaciaSync(session!, operacao.farmaciaId)) {
    return { ok: false as const, error: "Sem acesso à farmácia desta operação." };
  }

  const resultado = await reverterOperacao(prisma, input.operacaoId, session!.sub, input.motivo);

  if (resultado.ok) {
    await logAudit({
      actorId: session!.sub,
      action: "catalogo.manutencao_massa_revertida",
      entity: "CatalogoManutencaoOperacao",
      entityId: resultado.novaOperacaoId,
      meta: {
        operacaoOrigemId: resultado.operacaoOrigemId,
        revertidos: resultado.revertidos,
        ignorados: resultado.ignorados.length,
      },
    });
    revalidatePath("/catalogo/manutencao");
  }

  return resultado;
}

// ─── Lookups para a UI (selectors/autocomplete) ────────────────────────────

export async function listarFarmaciasAction() {
  const guarda = await guardaBase();
  if (!guarda.ok) return guarda;
  const { session, prisma } = guarda;

  const isGrupo = session!.perfil === "ADMINISTRADOR" || session!.perfil === "GESTOR_GRUPO";
  const farmacias = await prisma.farmacia.findMany({
    where: { estado: "ATIVO", ...(isGrupo ? {} : { id: session!.farmaciaId ?? "__nenhuma__" }) },
    select: { id: true, nome: true },
    orderBy: { nome: "asc" },
  });
  return { ok: true as const, farmacias };
}

export async function listarClassificacoesAction(nivel1Id?: string | null) {
  const guarda = await guardaBase();
  if (!guarda.ok) return guarda;
  const { prisma } = guarda;

  if (nivel1Id) {
    const n2 = await prisma.classificacao.findMany({
      where: { tipo: "NIVEL_2", estado: "ATIVO", classificacaoPaiId: nivel1Id },
      select: { id: true, nome: true },
      orderBy: { nome: "asc" },
    });
    return { ok: true as const, classificacoes: n2 };
  }
  const n1 = await prisma.classificacao.findMany({
    where: { tipo: "NIVEL_1", estado: "ATIVO" },
    select: { id: true, nome: true },
    orderBy: { nome: "asc" },
  });
  return { ok: true as const, classificacoes: n1 };
}

export async function listarTiposArtigoAction() {
  const guarda = await guardaBase();
  if (!guarda.ok) return guarda;
  const { prisma } = guarda;

  const rows = await prisma.produto.findMany({
    where: { tipoArtigo: { not: null } },
    select: { tipoArtigo: true },
    distinct: ["tipoArtigo"],
    orderBy: { tipoArtigo: "asc" },
  });
  return { ok: true as const, tipos: rows.map((r) => r.tipoArtigo!).filter(Boolean) };
}

export async function pesquisarFabricantesAction(query: string) {
  const guarda = await guardaBase();
  if (!guarda.ok) return guarda;
  const { prisma } = guarda;

  const fabricantes = await prisma.fabricante.findMany({
    where: { estado: "ATIVO", nomeNormalizado: { contains: query, mode: "insensitive" } },
    select: { id: true, nomeNormalizado: true },
    orderBy: { nomeNormalizado: "asc" },
    take: 25,
  });
  return { ok: true as const, resultados: fabricantes.map((f) => ({ id: f.id, nome: f.nomeNormalizado })) };
}

export async function pesquisarFornecedoresAction(query: string) {
  const guarda = await guardaBase();
  if (!guarda.ok) return guarda;
  const { prisma } = guarda;

  const fornecedores = await prisma.fornecedor.findMany({
    where: {
      estado: "ATIVO",
      OR: [{ nomeNormalizado: { contains: query, mode: "insensitive" } }, { nome: { contains: query, mode: "insensitive" } }],
    },
    select: { id: true, nomeNormalizado: true, nome: true },
    orderBy: { nomeNormalizado: "asc" },
    take: 25,
  });
  return { ok: true as const, resultados: fornecedores.map((f) => ({ id: f.id, nome: f.nome ?? f.nomeNormalizado })) };
}
