import type { PrismaClient, Prisma, EstadoTransferencia } from "@/generated/prisma/client";
import type { SessionUser } from "@/lib/session-claims";

/**
 * lib/transferencias/manutencao-data.ts
 *
 * Data loader da manutenção de Transferências (/transferencias/manutencao)
 * — equivalente, para `Transferencia`, do que `lib/encomendas/orders-data.ts`
 * já faz para `ListaEncomenda`. Substitui a listagem embutida e sem
 * filtros de `lib/transferencias/registadas-data.ts` (essa fica só para o
 * pequeno resumo dentro de `/transferencias`, não é tocada aqui).
 *
 * Aplica escopo REAL por farmácia (`farmaciaScopeFromSession`) — nem
 * `loadOrderListData` nem `loadTransferenciasRegistadas` o fazem hoje
 * (as suas queries correm sem filtro de farmácia da sessão); esta
 * listagem nova não repete essa lacuna. Segue a MESMA regra que
 * `canAccessFarmaciaSync` (lib/permissions-core.ts) já aplica a um único
 * id: ADMINISTRADOR/GESTOR_GRUPO vêem tudo; GESTOR_FARMACIA/OPERADOR só
 * veem transferências onde a sua farmácia primária é origem OU destino.
 */

export type FarmaciaScope = { irrestrito: true } | { irrestrito: false; farmaciaId: string };

export function farmaciaScopeFromSession(session: SessionUser): FarmaciaScope {
  if (session.perfil === "ADMINISTRADOR" || session.perfil === "GESTOR_GRUPO") return { irrestrito: true };
  return { irrestrito: false, farmaciaId: session.farmaciaId ?? "" };
}

export type TransferenciaManutencaoRow = {
  id: string;
  numero: string | null;
  estado: EstadoTransferencia;
  farmaciaOrigemId: string;
  farmaciaOrigemNome: string;
  farmaciaDestinoId: string;
  farmaciaDestinoNome: string;
  criadoPorNome: string;
  dataCriacao: Date;
  dataFinalizacao: Date | null;
  nReferencias: number;
  totalUnidades: number;
  motivoAnulacao: string | null;
  anuladoPorNome: string | null;
  anuladoEm: Date | null;
};

export type TransferenciaManutencaoFilters = {
  scope: FarmaciaScope;
  search?: string;
  farmaciaOrigemId?: string;
  farmaciaDestinoId?: string;
  estado?: EstadoTransferencia;
  dateFrom?: Date;
  dateTo?: Date;
  page: number;
  pageSize: number;
};

export type TransferenciaManutencaoData = {
  transferencias: TransferenciaManutencaoRow[];
  farmacias: { id: string; nome: string }[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

export const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 200;

export function clampPageSize(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.max(1, Math.floor(n)), MAX_PAGE_SIZE);
}

export function clampPage(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.max(1, Math.floor(n));
}

export async function loadTransferenciasManutencao(
  prisma: PrismaClient,
  filters: TransferenciaManutencaoFilters
): Promise<TransferenciaManutencaoData> {
  const page = clampPage(filters.page);
  const pageSize = clampPageSize(filters.pageSize);

  const where: Prisma.TransferenciaWhereInput = {};
  // Cada restrição independente (escopo por farmácia, pesquisa por
  // número) entra como o SEU PRÓPRIO membro de `AND` — nunca partilhando
  // o mesmo array `OR`. Duas cláusulas `OR` distintas escritas na mesma
  // propriedade `where.OR` substituiriam uma à outra (a segunda apagaria
  // a primeira) ou, se concatenadas, tornar-se-iam uma única disjunção —
  // "origem=X OU destino=X OU número~termo" — o que deixaria QUALQUER
  // transferência de QUALQUER farmácia visível a um utilizador restrito,
  // bastando pesquisar por um número exacto. É exactamente o isolamento
  // por farmácia que este loader existe para garantir.
  const and: Prisma.TransferenciaWhereInput[] = [];

  if (!filters.scope.irrestrito) {
    // Farmácia sem id primário (nunca deveria acontecer para
    // GESTOR_FARMACIA/OPERADOR) não vê nada — nunca "tudo" por omissão.
    and.push({
      OR: [
        { farmaciaOrigemId: filters.scope.farmaciaId },
        { farmaciaDestinoId: filters.scope.farmaciaId },
      ],
    });
  }
  if (filters.farmaciaOrigemId) where.farmaciaOrigemId = filters.farmaciaOrigemId;
  if (filters.farmaciaDestinoId) where.farmaciaDestinoId = filters.farmaciaDestinoId;
  if (filters.estado) {
    where.estado = filters.estado;
  } else {
    // Soft-delete (ver enum EstadoTransferencia): sem filtro explícito,
    // uma transferência ELIMINADA (rascunho descartado) nunca aparece
    // aqui. ANULADA continua visível por omissão — é um documento
    // finalizado, só marcado, nunca escondido (ver anulacao.ts).
    where.estado = { not: "ELIMINADA" };
  }
  if (filters.search && filters.search.trim().length > 0) {
    const termo = filters.search.trim();
    and.push({ numero: { contains: termo, mode: "insensitive" } });
  }
  if (filters.dateFrom || filters.dateTo) {
    const range: Prisma.DateTimeFilter = {};
    if (filters.dateFrom) range.gte = filters.dateFrom;
    if (filters.dateTo) range.lte = filters.dateTo;
    where.dataCriacao = range;
  }
  if (and.length > 0) where.AND = and;

  const skip = (page - 1) * pageSize;

  const [transferencias, total, farmacias] = await Promise.all([
    prisma.transferencia.findMany({
      where,
      orderBy: { dataCriacao: "desc" },
      skip,
      take: pageSize,
      include: {
        farmaciaOrigem: { select: { nome: true } },
        farmaciaDestino: { select: { nome: true } },
        criadoPor: { select: { nome: true } },
        anuladoPor: { select: { nome: true } },
        linhas: { select: { quantidade: true } },
      },
    }),
    prisma.transferencia.count({ where }),
    prisma.farmacia.findMany({
      where: { estado: "ATIVO" },
      select: { id: true, nome: true },
      orderBy: { nome: "asc" },
    }),
  ]);

  const rows: TransferenciaManutencaoRow[] = transferencias.map((t) => ({
    id: t.id,
    numero: t.numero,
    estado: t.estado,
    farmaciaOrigemId: t.farmaciaOrigemId,
    farmaciaOrigemNome: t.farmaciaOrigem.nome,
    farmaciaDestinoId: t.farmaciaDestinoId,
    farmaciaDestinoNome: t.farmaciaDestino.nome,
    criadoPorNome: t.criadoPor.nome,
    dataCriacao: t.dataCriacao,
    dataFinalizacao: t.dataFinalizacao,
    nReferencias: t.linhas.length,
    totalUnidades: t.linhas.reduce((acc, l) => acc + Number(l.quantidade), 0),
    motivoAnulacao: t.motivoAnulacao,
    anuladoPorNome: t.anuladoPor?.nome ?? null,
    anuladoEm: t.anuladoEm,
  }));

  return {
    transferencias: rows,
    farmacias,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}
