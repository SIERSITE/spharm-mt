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
 *   3. Validação do payload contra os dados REAIS do tenant (cada farmácia tem
 *      de existir e estar ao alcance da sessão, via `canAccessFarmaciaSync`).
 *
 * Nunca reutiliza `requirePlatformAdmin()` (app/admin/**) — essa é a
 * consola cross-tenant, sem relação com este ecrã per-tenant.
 */
import { revalidatePath } from "next/cache";
import { getPrisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { can, canAccessFarmaciaSync } from "@/lib/permissions-core";
import { logAudit } from "@/lib/audit";
import { resolveCurrentTenantSlug } from "@/lib/tenant-context";
import { TENANT_CATALOGO_MASSA } from "@/lib/tenant-constants";
import {
  aplicarManutencaoMassa,
  listarProdutosPagina,
  previewOperacao,
  reverterOperacao,
  validarFiltro,
  type DestinoInput,
  type ManutencaoMassaFiltro,
  type SelecaoManutencao,
  type TipoManutencaoMassa,
} from "@/lib/catalogo/manutencao-massa";

/**
 * Guarda comum. Devolve a sessão + prisma tenant-scoped quando tudo bate certo,
 * ou uma rejeição limpa. Corre ANTES de qualquer query.
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

type Prisma_ = Awaited<ReturnType<typeof getPrisma>>;
type Sessao_ = NonNullable<Awaited<ReturnType<typeof getSession>>>;

const MAX_ITENS_LISTA = 5_000;
const MAX_CNPS = 25_000;
const MAX_SELECAO = 100_000;

/**
 * Valida o pedido contra os dados REAIS do tenant — nunca confia no cliente:
 *   · filtro (regras puras);
 *   · tamanhos máximos;
 *   · cada farmácia existe, está ativa e a sessão tem acesso a ela;
 *   · fabricantes/fornecedores actuais referidos existem.
 */
async function validarPedido(
  prisma: Prisma_,
  session: Sessao_,
  tipo: TipoManutencaoMassa,
  filtro: ManutencaoMassaFiltro,
  selecao?: SelecaoManutencao
): Promise<string | null> {
  const erroFiltro = validarFiltro(tipo, filtro);
  if (erroFiltro) return erroFiltro;

  for (const [nome, v] of Object.entries({
    farmaciaIds: filtro.farmaciaIds,
    categorias: filtro.categorias,
    subcategorias: filtro.subcategorias,
    utilizacoes: filtro.utilizacoes,
    distribuidores: filtro.distribuidores,
    fabricanteAtualIds: filtro.fabricanteAtualIds,
    fornecedorAtualIds: filtro.fornecedorAtualIds,
  })) {
    if (v !== undefined && (!Array.isArray(v) || v.length > MAX_ITENS_LISTA || v.some((x) => typeof x !== "string"))) {
      return `Filtro inválido (${nome}).`;
    }
  }
  if (filtro.cnps !== undefined && (!Array.isArray(filtro.cnps) || filtro.cnps.length > MAX_CNPS || filtro.cnps.some((n) => !Number.isSafeInteger(n)))) {
    return "Lista de CNP inválida.";
  }
  if (selecao) {
    const n = selecao.modo === "manual" ? selecao.chaves?.length : (selecao.excluidas?.length ?? 0);
    if (!Array.isArray(selecao.modo === "manual" ? selecao.chaves : selecao.excluidas ?? []) || (n ?? 0) > MAX_SELECAO) {
      return "Selecção inválida.";
    }
  }

  const farmaciaIds = [...new Set(filtro.farmaciaIds ?? [])];
  if (farmaciaIds.length > 0) {
    for (const id of farmaciaIds) {
      if (!canAccessFarmaciaSync(session, id)) return "Sem acesso a uma das farmácias seleccionadas.";
    }
    const existentes = await prisma.farmacia.count({ where: { id: { in: farmaciaIds }, estado: "ATIVO" } });
    if (existentes !== farmaciaIds.length) return "Farmácia não encontrada ou inactiva.";
  }
  const fab = [...new Set(filtro.fabricanteAtualIds ?? [])];
  if (fab.length > 0 && (await prisma.fabricante.count({ where: { id: { in: fab } } })) !== fab.length) {
    return "Fabricante actual inválido.";
  }
  const forn = [...new Set(filtro.fornecedorAtualIds ?? [])];
  if (forn.length > 0 && (await prisma.fornecedor.count({ where: { id: { in: forn } } })) !== forn.length) {
    return "Fornecedor habitual actual inválido.";
  }
  return null;
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

  const erro = await validarPedido(prisma, session, input.tipo, input.filtro);
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

// ─── Preview ────────────────────────────────────────────────────────────────

export type PreviewManutencaoMassaInput = {
  tipo: TipoManutencaoMassa;
  filtro: ManutencaoMassaFiltro;
  destino: DestinoInput;
  selecao?: SelecaoManutencao;
};

async function previewAction(input: PreviewManutencaoMassaInput) {
  const guarda = await guardaBase();
  if (!guarda.ok) return guarda;
  const { session, prisma } = guarda;

  const erro = await validarPedido(prisma, session, input.tipo, input.filtro, input.selecao);
  if (erro) return { ok: false as const, error: erro };

  try {
    return await previewOperacao(prisma, input.tipo, input.filtro, input.destino, input.selecao);
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : "Erro ao pré-visualizar." };
  }
}

/** Preview para o tipo FABRICANTE. */
export async function previewManutencaoFabricanteAction(input: Omit<PreviewManutencaoMassaInput, "tipo">) {
  return previewAction({ ...input, tipo: "FABRICANTE" });
}

/** Preview para o tipo FORNECEDOR (≥1 farmácia em `filtro.farmaciaIds`). */
export async function previewManutencaoFornecedorAction(input: Omit<PreviewManutencaoMassaInput, "tipo">) {
  return previewAction({ ...input, tipo: "FORNECEDOR" });
}

// ─── Aplicar ────────────────────────────────────────────────────────────────

export type AplicarManutencaoMassaActionInput = {
  tipo: TipoManutencaoMassa;
  filtro: ManutencaoMassaFiltro;
  destino: DestinoInput;
  selecao?: SelecaoManutencao;
  /** Snapshot devolvido pelo preview que o utilizador confirmou. */
  snapshotHash: string;
  motivo?: string | null;
};

async function aplicarAction(input: AplicarManutencaoMassaActionInput) {
  const guarda = await guardaBase();
  if (!guarda.ok) return guarda;
  const { session, prisma } = guarda;

  const erro = await validarPedido(prisma, session, input.tipo, input.filtro, input.selecao);
  if (erro) return { ok: false as const, error: erro };

  const resultado = await aplicarManutencaoMassa(prisma, {
    tipo: input.tipo,
    filtro: input.filtro,
    destino: input.destino,
    selecao: input.selecao,
    snapshotHash: input.snapshotHash,
    utilizadorId: session.sub,
    motivo: input.motivo,
  });

  if (resultado.ok) {
    for (const op of resultado.operacoes) {
      await logAudit({
        actorId: session.sub,
        action: "catalogo.manutencao_massa_aplicada",
        entity: "CatalogoManutencaoOperacao",
        entityId: op.operacaoId,
        meta: {
          tipo: input.tipo,
          farmaciaId: op.farmaciaId,
          quantidadeSolicitada: op.quantidadeSolicitada,
          quantidadeAlterada: op.quantidadeAlterada,
          quantidadeIgnorada: op.quantidadeIgnorada,
          snapshotHash: input.snapshotHash,
        },
      });
    }
    revalidatePath("/catalogo/manutencao");
  }

  return resultado;
}

/** Aplica manutenção em massa de FABRICANTE. */
export async function aplicarManutencaoFabricanteAction(input: Omit<AplicarManutencaoMassaActionInput, "tipo">) {
  return aplicarAction({ ...input, tipo: "FABRICANTE" });
}

/** Aplica manutenção em massa de FORNECEDOR habitual (≥1 farmácia em `filtro.farmaciaIds`). */
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
