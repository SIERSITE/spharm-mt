// Sem `import "server-only"` — server-only por design (consumido pelos
// route handlers /api/ingest/*), mas o marker quebraria a importação por
// scripts CLI via tsx (ex.: validação/reprocessamento). Mesma decisão que
// `lib/control-plane.ts`. Não importar de Client Components (code review).
import { randomUUID } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import type { PrismaClient } from "@/generated/prisma/client";

/**
 * lib/ingest/bulk.ts
 *
 * Bulk upsert para tabelas staging do bootstrap. Colapsa N upserts
 * linha-a-linha (N round-trips ao Neon) num único
 * `INSERT ... ON CONFLICT DO UPDATE` (1 round-trip) — o gargalo que
 * provocava HTTP 504 e lentidão em batches grandes.
 *
 * Mantém a semântica/contrato: mesmas colunas, mesma idempotência
 * (unique key), update-on-conflict preservado. O `id` (cuid Prisma é
 * app-side, sem default na BD) é gerado aqui para linhas NOVAS; em
 * conflito o id existente é preservado (ON CONFLICT não toca no id).
 *
 * Edge case: o mesmo conflict key duas vezes no MESMO batch faz o
 * Postgres recusar ("cannot affect row a second time") — por isso o
 * caller deve deduplicar por chave antes (ver `dedupeByKey`).
 */

type DbClient = PrismaClient | Prisma.TransactionClient;

export function dedupeByKey<T>(rows: T[], keyOf: (r: T) => string): T[] {
  // Mantém a ÚLTIMA ocorrência de cada chave (igual à semântica de
  // upserts sequenciais: o último a escrever ganha).
  const byKey = new Map<string, T>();
  for (const r of rows) byKey.set(keyOf(r), r);
  return [...byKey.values()];
}

export type SalesLineRow = {
  farmaciaId: string;
  /**
   * Tabela ERP de origem. Parte da identidade — ver a migração
   * `20260818120000_venda_source_namespace`. `externalSaleLineId` só é
   * comparável com linhas do mesmo namespace.
   */
  sourceNamespace: string;
  externalSaleId: number;
  externalSaleLineId: number;
  /** Série documental do cabeçalho ("G", "VSG"). */
  serie: string | null;
  /** "VSG/54688". Para reconciliar com o ERP sem recompor nada. */
  documento: string | null;
  sequencia: number | null;
  dataVenda: Date | null;
  tipoDocumento: number | null;
  tipoDocumentoClass: string;
  externalProductId: number;
  produtoId: string | null;
  isNonStockService: boolean;
  quantidade: number | null;
  pvpUnitario: number | null;
  valorLinha: number | null;
  ivaValor: number | null;
  descontoValor: number | null;
  comparticipacao1: number | null;
  comparticipacao2: number | null;
  entidadeId: number | null;
  rawJson: unknown;
};

/**
 * Bulk upsert de `IngestVendaLinhaRaw` por
 * `(farmaciaId, sourceNamespace, externalSaleLineId)`.
 *
 * A origem entra na chave desde 2026-08-18. Sem ela, ingerir
 * `[Atendimento Susp Detalhe]` sobrescreveria linhas de
 * `[Atendimento Detalhe]` assim que as duas sequências de IDs se
 * cruzassem — silenciosamente, e apagando vendas boas.
 *
 * Devolve o nº de linhas afectadas (insert + update). Lança em erro de SQL
 * (o caller pode cair para per-row para isolar a linha problemática).
 */
export async function bulkUpsertSalesLines(
  db: DbClient,
  rows: SalesLineRow[]
): Promise<number> {
  if (rows.length === 0) return 0;
  const values = rows.map(
    (r) => Prisma.sql`(
      ${randomUUID()}, ${r.farmaciaId}, ${r.sourceNamespace},
      ${r.externalSaleId}, ${r.externalSaleLineId}, ${r.serie}, ${r.documento},
      ${r.sequencia}, ${r.dataVenda}, ${r.tipoDocumento}, ${r.tipoDocumentoClass},
      ${r.externalProductId}, ${r.produtoId}, ${r.isNonStockService},
      ${r.quantidade}, ${r.pvpUnitario}, ${r.valorLinha}, ${r.ivaValor},
      ${r.descontoValor}, ${r.comparticipacao1}, ${r.comparticipacao2}, ${r.entidadeId},
      ${JSON.stringify(r.rawJson ?? null)}::jsonb, now()
    )`
  );
  return db.$executeRaw`
    INSERT INTO "IngestVendaLinhaRaw" (
      "id", "farmaciaId", "sourceNamespace",
      "externalSaleId", "externalSaleLineId", "serie", "documento", "sequencia",
      "dataVenda", "tipoDocumento", "tipoDocumentoClass", "externalProductId",
      "produtoId", "isNonStockService", "quantidade", "pvpUnitario", "valorLinha",
      "ivaValor", "descontoValor", "comparticipacao1", "comparticipacao2",
      "entidadeId", "rawJson", "importedAt"
    )
    VALUES ${Prisma.join(values)}
    ON CONFLICT ("farmaciaId", "sourceNamespace", "externalSaleLineId") DO UPDATE SET
      "externalSaleId"     = EXCLUDED."externalSaleId",
      "serie"              = EXCLUDED."serie",
      "documento"          = EXCLUDED."documento",
      "sequencia"          = EXCLUDED."sequencia",
      "dataVenda"          = EXCLUDED."dataVenda",
      "tipoDocumento"      = EXCLUDED."tipoDocumento",
      "tipoDocumentoClass" = EXCLUDED."tipoDocumentoClass",
      "externalProductId"  = EXCLUDED."externalProductId",
      "produtoId"          = EXCLUDED."produtoId",
      "isNonStockService"  = EXCLUDED."isNonStockService",
      "quantidade"         = EXCLUDED."quantidade",
      "pvpUnitario"        = EXCLUDED."pvpUnitario",
      "valorLinha"         = EXCLUDED."valorLinha",
      "ivaValor"           = EXCLUDED."ivaValor",
      "descontoValor"      = EXCLUDED."descontoValor",
      "comparticipacao1"   = EXCLUDED."comparticipacao1",
      "comparticipacao2"   = EXCLUDED."comparticipacao2",
      "entidadeId"         = EXCLUDED."entidadeId",
      "rawJson"            = EXCLUDED."rawJson"
  `;
}

// ─── Produtos (catálogo, chave canónica cnp) ─────────────────────────

export type ProdutoRow = {
  cnp: number;
  externalProductId: number | null;
  designacao: string;
  flagGenerico: boolean;
  flagMnsrmNCompart: boolean;
};

/**
 * Bulk upsert de `Produto` por `cnp`. Update ADITIVO: só mexe em
 * designacao + flags + externalProductId (COALESCE: não apaga o existente
 * se vier null). NUNCA toca campos fortes do catálogo (dci, codigoATC,
 * fabricanteId, estado, verificationStatus, etc.). Devolve mapa cnp→id
 * (via RETURNING) para encadear o upsert de ProdutoFarmacia.
 */
export async function bulkUpsertProdutosByCnp(
  db: DbClient,
  rows: ProdutoRow[]
): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  if (rows.length === 0) return map;
  const values = rows.map(
    (r) => Prisma.sql`(
      ${randomUUID()}, ${r.cnp}, ${r.externalProductId}, ${r.designacao},
      ${r.flagGenerico}, ${r.flagMnsrmNCompart}, 'FARMACIA'::"ProdutoOrigemDados", now()
    )`
  );
  const ret = await db.$queryRaw<Array<{ id: string; cnp: number }>>`
    INSERT INTO "Produto" (
      "id", "cnp", "externalProductId", "designacao",
      "flagGenerico", "flagMnsrmNCompart", "origemDados", "dataAtualizacao"
    )
    VALUES ${Prisma.join(values)}
    ON CONFLICT ("cnp") DO UPDATE SET
      "externalProductId" = COALESCE(EXCLUDED."externalProductId", "Produto"."externalProductId"),
      "designacao"        = EXCLUDED."designacao",
      "flagGenerico"      = EXCLUDED."flagGenerico",
      "flagMnsrmNCompart" = EXCLUDED."flagMnsrmNCompart",
      "dataAtualizacao"   = now()
    RETURNING "id", "cnp"
  `;
  for (const r of ret) map.set(Number(r.cnp), r.id);
  return map;
}

// ─── ProdutoFarmacia: campos de PRODUTO (endpoint /products) ─────────

export type ProdutoFarmaciaProductRow = {
  produtoId: string;
  farmaciaId: string;
  externalProductId: number | null;
  pvp: number | null;
  pmc: number | null;
  puc: number | null;
  dataUltimaVenda: Date | null;
  dataUltimaCompra: Date | null;
  flagRetirado: boolean;
  fornecedorExternalId: number | null;
  fornecedorOrigem: string | null;
  /**
   * Taxa IVA canónica de farmácia: 6, 13, 23 ou null. Vem do agent rev39+
   * via discovery dinâmica de `dbo.Stocks.[IVA]` (ou colunas variantes).
   * Quando o agent envia, o endpoint marca `taxaIvaSource='STOCKS_MESTRE'`
   * — fonte mais autoritativa do pipeline de recuperação.
   */
  taxaIvaPercent: number | null;
};

/**
 * Bulk upsert de `ProdutoFarmacia` por (produtoId, farmaciaId) — campos
 * do endpoint /products. NÃO toca nos campos de stock (esses vêm de
 * /stock). COALESCE preserva valores existentes quando o novo é null
 * (igual ao `?? undefined` do upsert per-row). flagRetirado é
 * incondicional (o ERP é a verdade no momento).
 */
export async function bulkUpsertProdutoFarmaciaProducts(
  db: DbClient,
  rows: ProdutoFarmaciaProductRow[]
): Promise<number> {
  if (rows.length === 0) return 0;
  const values = rows.map(
    (r) => Prisma.sql`(
      ${randomUUID()}, ${r.produtoId}, ${r.farmaciaId}, ${r.externalProductId},
      ${r.pvp}, ${r.pmc}, ${r.puc}, ${r.dataUltimaVenda}, ${r.dataUltimaCompra},
      ${r.flagRetirado}, ${r.fornecedorExternalId}, ${r.fornecedorOrigem},
      ${r.taxaIvaPercent},
      ${r.taxaIvaPercent === null ? null : 'STOCKS_MESTRE'},
      ${r.taxaIvaPercent === null ? null : new Date()},
      now()
    )`
  );
  return db.$executeRaw`
    INSERT INTO "ProdutoFarmacia" (
      "id", "produtoId", "farmaciaId", "externalProductId",
      "pvp", "pmc", "puc", "dataUltimaVenda", "dataUltimaCompra",
      "flagRetirado", "fornecedorExternalId", "fornecedorOrigem",
      "taxaIvaPercent", "taxaIvaSource", "taxaIvaUpdatedAt",
      "dataAtualizacao"
    )
    VALUES ${Prisma.join(values)}
    ON CONFLICT ("produtoId", "farmaciaId") DO UPDATE SET
      "externalProductId"    = COALESCE(EXCLUDED."externalProductId", "ProdutoFarmacia"."externalProductId"),
      "pvp"                  = COALESCE(EXCLUDED."pvp", "ProdutoFarmacia"."pvp"),
      "pmc"                  = COALESCE(EXCLUDED."pmc", "ProdutoFarmacia"."pmc"),
      "puc"                  = COALESCE(EXCLUDED."puc", "ProdutoFarmacia"."puc"),
      "dataUltimaVenda"      = COALESCE(EXCLUDED."dataUltimaVenda", "ProdutoFarmacia"."dataUltimaVenda"),
      "dataUltimaCompra"     = COALESCE(EXCLUDED."dataUltimaCompra", "ProdutoFarmacia"."dataUltimaCompra"),
      "flagRetirado"         = EXCLUDED."flagRetirado",
      "fornecedorExternalId" = COALESCE(EXCLUDED."fornecedorExternalId", "ProdutoFarmacia"."fornecedorExternalId"),
      "fornecedorOrigem"     = COALESCE(EXCLUDED."fornecedorOrigem", "ProdutoFarmacia"."fornecedorOrigem"),
      -- IVA mestre: o ERP é a verdade. Quando o agent envia uma taxa
      -- (não-null), sobrescreve qualquer taxa anterior (incluindo as
      -- derivadas pelo recuperador). NULL no payload preserva o existente.
      "taxaIvaPercent"       = COALESCE(EXCLUDED."taxaIvaPercent", "ProdutoFarmacia"."taxaIvaPercent"),
      "taxaIvaSource"        = CASE
                                 WHEN EXCLUDED."taxaIvaPercent" IS NOT NULL THEN 'STOCKS_MESTRE'
                                 ELSE "ProdutoFarmacia"."taxaIvaSource"
                               END,
      "taxaIvaUpdatedAt"     = CASE
                                 WHEN EXCLUDED."taxaIvaPercent" IS NOT NULL THEN now()
                                 ELSE "ProdutoFarmacia"."taxaIvaUpdatedAt"
                               END,
      "dataAtualizacao"      = now()
  `;
}

// ─── ProdutoFarmacia: campos de STOCK (endpoint /stock) ──────────────

export type ProdutoFarmaciaStockRow = {
  produtoId: string;
  farmaciaId: string;
  externalProductId: number;
  stockAtual: number | null;
  stockMinimo: number | null;
  stockMaximo: number | null;
  stockEncomenda: number | null;
  stockReserva: number | null;
};

/**
 * Bulk upsert de `ProdutoFarmacia` por (produtoId, farmaciaId) — campos
 * de STOCK. NÃO toca em pvp/datas/fornecedor (esses vêm de /products).
 * COALESCE preserva stock existente quando o novo é null (additive, igual
 * ao `?? undefined` per-row).
 */
export async function bulkUpsertProdutoFarmaciaStock(
  db: DbClient,
  rows: ProdutoFarmaciaStockRow[]
): Promise<number> {
  if (rows.length === 0) return 0;
  const values = rows.map(
    (r) => Prisma.sql`(
      ${randomUUID()}, ${r.produtoId}, ${r.farmaciaId}, ${r.externalProductId},
      ${r.stockAtual}, ${r.stockMinimo}, ${r.stockMaximo}, ${r.stockEncomenda}, ${r.stockReserva}, now()
    )`
  );
  return db.$executeRaw`
    INSERT INTO "ProdutoFarmacia" (
      "id", "produtoId", "farmaciaId", "externalProductId",
      "stockAtual", "stockMinimo", "stockMaximo", "stockEncomenda", "stockReserva", "dataAtualizacao"
    )
    VALUES ${Prisma.join(values)}
    ON CONFLICT ("produtoId", "farmaciaId") DO UPDATE SET
      "externalProductId" = COALESCE(EXCLUDED."externalProductId", "ProdutoFarmacia"."externalProductId"),
      "stockAtual"        = COALESCE(EXCLUDED."stockAtual", "ProdutoFarmacia"."stockAtual"),
      "stockMinimo"       = COALESCE(EXCLUDED."stockMinimo", "ProdutoFarmacia"."stockMinimo"),
      "stockMaximo"       = COALESCE(EXCLUDED."stockMaximo", "ProdutoFarmacia"."stockMaximo"),
      "stockEncomenda"    = COALESCE(EXCLUDED."stockEncomenda", "ProdutoFarmacia"."stockEncomenda"),
      "stockReserva"      = COALESCE(EXCLUDED."stockReserva", "ProdutoFarmacia"."stockReserva"),
      "dataAtualizacao"   = now()
  `;
}
