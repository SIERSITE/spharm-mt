/**
 * lib/movimentos-data.ts
 *
 * Read-model do extrato de movimentos de um produto × farmácia.
 *
 * Modelo (rev36 — ERP parity):
 *   Cada linha corresponde a UMA `MovimentoArtigo` (= UMA dbo.StocksMov).
 *   Sem agregados. Sem "Venda mensal"/"Venda diária". O ERP imprime
 *   movimento-a-movimento e nós fazemos o mesmo.
 *
 * ── PORQUE É QUE O RAMO LEGACY DESAPARECEU ───────────────────────────
 *
 * Havia dois ramos, escolhidos por `Farmacia.useMovimentosCanonical`.
 * O ramo legacy lia `Venda`/`Compra`/`Devolucao`/`AjusteStock`. E a
 * tabela `Venda` NUNCA é escrita: não existe um único
 * `prisma.venda.create/upsert/createMany` nem um `INSERT INTO "Venda"`
 * em todo o código — as vendas vivem em `IngestVendaLinhaRaw` e são
 * agregadas para `VendaMensal`. As transferências entre farmácias não
 * têm sequer tabela legacy.
 *
 * O ramo era portanto estruturalmente incapaz de mostrar uma venda ou
 * uma transferência. Em produção, com a flag a `false` nas duas
 * farmácias, o extrato da Aspirina (CNP 3045580) em Agosto/2026 mostrava
 * UMA linha — a recepção de +240 — e o resumo "+240 / −0", quando o ERP
 * tem 240 de entradas, 144 de saídas e saldo +96. Nem sequer havia
 * saldo: `stockAntes`/`stockDepois` eram zero fixo no legacy.
 *
 * `MovimentoArtigo` está populada e é o ledger: 553 112 movimentos na
 * Silveirense e 339 209 na Segurado, desde 2024-01-02. A flag estava a
 * escolher a fonte errada de duas, e uma delas nunca poderia estar certa.
 *
 * Uma farmácia sem ledger ingerido passa a dizê-lo — ver
 * `getCoberturaMovimentos`. Ausência explícita, não um extrato parcial
 * que parece completo.
 *
 * NÃO toca em dashboard / ingest / export-orders. Só SELECTs.
 */

import { getPrisma } from "@/lib/prisma";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";

// ── Vocabulário ─────────────────────────────────────────────
//
// Tipos, rótulos e direcção vivem em `movimentos-tipos.ts` porque são
// precisos no browser e este módulo importa Prisma. Ver o cabeçalho
// desse ficheiro. Re-exportados aqui para os chamadores server-side não
// terem de saber que a divisão existe.

export type {
  ContraparteTipo,
  MovimentoDirecao,
  MovimentoRow,
  MovimentoTipo,
  MovimentosFilters,
} from "@/lib/movimentos-tipos";
export { TIPOS_ACERTO_STOCK, getTiposDisponiveis } from "@/lib/movimentos-tipos";

import {
  TIPO_LABELS,
  direcaoForTipo,
  expandirTiposFiltro,
  type ContraparteTipo,
  type MovimentoRow,
  type MovimentoTipo,
  type MovimentosFilters,
} from "@/lib/movimentos-tipos";

// ── Constantes ───────────────────────────────────────────

/** Janela default do extrato — espelho do ERP ("Da Data: AAAA-01-01 ..hoje"). */
function startOfYearIso(d = new Date()): string {
  return `${d.getUTCFullYear()}-01-01`;
}

/**
 * Janela por defeito (ano corrente → hoje) em ISO yyyy-mm-dd.
 * Vive aqui (e não no render do server component) para a página passar
 * a mesma janela ao loader e aos inputs sem chamar `Date.now()` no render.
 */
export function getDefaultMovimentosWindow(): { from: string; to: string } {
  const isoDay = (d: Date) => d.toISOString().slice(0, 10);
  return { from: startOfYearIso(), to: isoDay(new Date()) };
}

// ── Helpers ──────────────────────────────────────────────

function toF(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Resolve o universo de farmácias a considerar. */
async function resolveFarmaciaIds(
  prisma: PrismaClient,
  filters: MovimentosFilters,
): Promise<{ ids: string[]; nomeById: Map<string, string> }> {
  const farmacias = await prisma.farmacia.findMany({
    where: {
      estado: "ATIVO",
      nome: { not: "Farmácia Teste" },
      ...(filters.farmaciaIds && filters.farmaciaIds.length > 0
        ? { id: { in: filters.farmaciaIds } }
        : {}),
    },
    select: { id: true, nome: true },
  });
  return {
    ids: farmacias.map((f) => f.id),
    nomeById: new Map(farmacias.map((f) => [f.id, f.nome])),
  };
}

/** Uma farmácia e o estado do seu ledger canónico. */
export type CoberturaMovimentos = {
  farmaciaId: string;
  farmacia: string;
  /** Há pelo menos um `MovimentoArtigo` para esta farmácia. */
  temLedger: boolean;
  /** Data do movimento mais recente ingerido, ISO. Null se não houver. */
  ultimoMovimento: string | null;
};

/**
 * O ledger existe para estas farmácias?
 *
 * Sem isto, uma farmácia sem `MovimentoArtigo` ingerido é
 * indistinguível de um artigo sem movimento no período — as duas
 * mostram uma tabela vazia, e só uma delas é uma resposta.
 *
 * Uma consulta agregada para todas as farmácias, não uma por farmácia.
 */
export async function getCoberturaMovimentos(
  farmaciaIds?: string[],
): Promise<CoberturaMovimentos[]> {
  const prisma = await getPrisma();
  const farmacias = await prisma.farmacia.findMany({
    where: {
      estado: "ATIVO",
      nome: { not: "Farmácia Teste" },
      ...(farmaciaIds && farmaciaIds.length > 0 ? { id: { in: farmaciaIds } } : {}),
    },
    select: { id: true, nome: true },
    orderBy: { nome: "asc" },
  });
  if (farmacias.length === 0) return [];

  const agregado = await prisma.movimentoArtigo.groupBy({
    by: ["farmaciaId"],
    where: { farmaciaId: { in: farmacias.map((f) => f.id) } },
    _max: { dataMovimento: true },
    _count: { _all: true },
  });
  const porFarmacia = new Map(agregado.map((a) => [a.farmaciaId, a]));

  return farmacias.map((f) => {
    const a = porFarmacia.get(f.id);
    return {
      farmaciaId: f.id,
      farmacia: f.nome,
      temLedger: (a?._count._all ?? 0) > 0,
      ultimoMovimento: a?._max.dataMovimento?.toISOString() ?? null,
    };
  });
}

// ── Canónico (rev36) ──────────────────────────────────────────────

/**
 * Lê `MovimentoArtigo` para (produtoId × farmaciaIds × janela). Já no
 * shape final `MovimentoRow` que a UI consome. Sem JOINs adicionais —
 * todos os campos vêm directamente da tabela (foram populados pelo
 * agent rev36 a partir dos JOINs SoftReis).
 */
async function readCanonicalMovimentos(
  prisma: PrismaClient,
  produtoId: string,
  farmaciaIds: string[],
  effFrom: Date,
  effTo: Date,
  nomeById: Map<string, string>,
): Promise<MovimentoRow[]> {
  if (farmaciaIds.length === 0) return [];
  const rows = await prisma.movimentoArtigo.findMany({
    where: {
      produtoId,
      farmaciaId: { in: farmaciaIds },
      dataMovimento: { gte: effFrom, lte: effTo },
    },
    select: {
      id: true,
      farmaciaId: true,
      dataMovimento: true,
      tipo: true,
      quantidade: true,
      existenciaApos: true,
      // ── rev36 — ERP parity ────────────────────────────────
      documentoTipo: true,
      documentoNumero: true,
      referenciaExterna: true,
      contraparteNome: true,
      contraparteTipo: true,
      armazemNome: true,
      utilizadorNome: true,
      quantidadeBonusEnt: true,
      quantidadeBonusSai: true,
      existenciaBonusApos: true,
      precoUnitario: true,
      valorLinha: true,
      pmcNovo: true,
      // ── Legacy enrichment (para fallback de display em rows pré-rev36) ──
      custoUnitario: true,
      movStocksCabNDocExterno: true,
      movStocksCabMotivoTexto: true,
      movStocksCabSituacao: true,
      externalSaleId: true,
      externalRecpDetalheId: true,
      externalDevolucaoDetalheId: true,
    },
    orderBy: { dataMovimento: "desc" },
  });

  return rows.map((r): MovimentoRow => {
    const qty = r.quantidade;
    const tipo = r.tipo as MovimentoTipo;
    const direcao = direcaoForTipo(tipo, qty);
    const existencia = r.existenciaApos;

    // Fallback display para rows uploaded por agents pré-rev36 (não têm
    // documentoNumero populado): cair para o que existe.
    const documentoNumeroFallback =
      r.movStocksCabNDocExterno ??
      (r.externalSaleId != null
        ? `#${r.externalSaleId}`
        : r.externalRecpDetalheId != null
          ? `Rec #${r.externalRecpDetalheId}`
          : r.externalDevolucaoDetalheId != null
            ? `Dev #${r.externalDevolucaoDetalheId}`
            : null);

    return {
      key: `mov:${r.id}`,
      data: r.dataMovimento.toISOString(),
      farmaciaId: r.farmaciaId,
      farmacia: nomeById.get(r.farmaciaId) ?? "—",
      tipo,
      tipoLabel: TIPO_LABELS[tipo],
      direcao,
      documentoTipo: r.documentoTipo,
      documentoNumero: r.documentoNumero ?? documentoNumeroFallback,
      referenciaExterna: r.referenciaExterna,
      contraparteNome: r.contraparteNome,
      contraparteTipo: r.contraparteTipo as ContraparteTipo | null,
      quantidade: qty,
      stockAntes: existencia - qty,
      stockDepois: existencia,
      quantidadeBonusEnt: r.quantidadeBonusEnt,
      quantidadeBonusSai: r.quantidadeBonusSai,
      existenciaBonusApos: r.existenciaBonusApos,
      precoUnitario:
        r.precoUnitario != null
          ? toF(r.precoUnitario)
          : r.custoUnitario != null
            ? toF(r.custoUnitario)
            : null,
      valorLinha: r.valorLinha != null ? toF(r.valorLinha) : null,
      pmcNovo: r.pmcNovo != null ? toF(r.pmcNovo) : null,
      armazemNome: r.armazemNome,
      utilizadorNome: r.utilizadorNome,
      observacao: r.movStocksCabMotivoTexto?.trim() || null,
      situacao: r.movStocksCabSituacao,
    };
  });
}

// ── Entry point ───────────────────────────────────────────────────

/**
 * Carrega o extrato de movimentos de um produto. Devolve array ordenado
 * por data desc (mais recente primeiro). Ignora `Prisma`/`PrismaClient`
 * exterior — usa o cliente partilhado via `getPrisma()`.
 */
export async function getMovimentosProduto(
  cnp: number,
  filters: MovimentosFilters = {},
): Promise<MovimentoRow[]> {
  const prisma = await getPrisma();
  // 1. Resolver produto
  const produto = await prisma.produto.findUnique({
    where: { cnp },
    select: { id: true },
  });
  if (!produto) return [];

  // 2. Resolver farmácias
  const { ids: farmaciaIds, nomeById } = await resolveFarmaciaIds(prisma, filters);
  if (farmaciaIds.length === 0) return [];

  // 3. Janela. Sem `from` ⇒ início do ano corrente. Sem `to` ⇒ agora.
  const effFrom = filters.from
    ? new Date(filters.from)
    : new Date(`${startOfYearIso()}T00:00:00Z`);
  const effTo = filters.to ? new Date(filters.to) : new Date();
  effTo.setHours(23, 59, 59, 999);

  // 4. O ledger. Uma fonte só.
  let rows = await readCanonicalMovimentos(
    prisma,
    produto.id,
    farmaciaIds,
    effFrom,
    effTo,
    nomeById,
  );

  // 5. Filtro de tipos + ordem desc por data
  if (filters.tipos && filters.tipos.length > 0) {
    const set = expandirTiposFiltro(filters.tipos);
    rows = rows.filter((r) => set.has(r.tipo));
  }
  rows.sort((a, b) => b.data.localeCompare(a.data));
  return rows;
}

// Prisma import preservado para callers que necessitem do tipo (re-export
// implícito via type imports). Não é usado runtime nesta versão.
void Prisma;
