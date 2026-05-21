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
  externalSaleId: number;
  externalSaleLineId: number;
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
 * Bulk upsert de `IngestVendaLinhaRaw` por `(farmaciaId, externalSaleLineId)`.
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
      ${randomUUID()}, ${r.farmaciaId}, ${r.externalSaleId}, ${r.externalSaleLineId},
      ${r.sequencia}, ${r.dataVenda}, ${r.tipoDocumento}, ${r.tipoDocumentoClass},
      ${r.externalProductId}, ${r.produtoId}, ${r.isNonStockService},
      ${r.quantidade}, ${r.pvpUnitario}, ${r.valorLinha}, ${r.ivaValor},
      ${r.descontoValor}, ${r.comparticipacao1}, ${r.comparticipacao2}, ${r.entidadeId},
      ${JSON.stringify(r.rawJson ?? null)}::jsonb, now()
    )`
  );
  return db.$executeRaw`
    INSERT INTO "IngestVendaLinhaRaw" (
      "id", "farmaciaId", "externalSaleId", "externalSaleLineId", "sequencia",
      "dataVenda", "tipoDocumento", "tipoDocumentoClass", "externalProductId",
      "produtoId", "isNonStockService", "quantidade", "pvpUnitario", "valorLinha",
      "ivaValor", "descontoValor", "comparticipacao1", "comparticipacao2",
      "entidadeId", "rawJson", "importedAt"
    )
    VALUES ${Prisma.join(values)}
    ON CONFLICT ("farmaciaId", "externalSaleLineId") DO UPDATE SET
      "externalSaleId"     = EXCLUDED."externalSaleId",
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
