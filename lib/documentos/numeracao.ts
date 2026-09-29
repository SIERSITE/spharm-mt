import "server-only";
import type { Prisma } from "@/generated/prisma/client";

/**
 * lib/documentos/numeracao.ts
 *
 * Número de documento legível e sequencial (ex.: "TR-000045",
 * "EN-000012"), atribuído SÓ no momento da finalização — nunca a um
 * rascunho, nunca retroactivamente às rows que já existiam antes desta
 * coluna (essas ficam com `numero = NULL` para sempre).
 *
 * Usa uma sequência Postgres dedicada por tipo de documento
 * (`seq_numero_encomenda`/`seq_numero_transferencia`, ver migration
 * 20260929130000). `nextval()` nunca repete um valor, mesmo sob
 * concorrência e mesmo que a transacção que o pediu faça rollback — a
 * consequência é apenas um número saltado, nunca um duplicado.
 */

type Tx = Prisma.TransactionClient;

const SEQUENCIAS = {
  ENC: "seq_numero_encomenda",
  TRF: "seq_numero_transferencia",
} as const;

const PREFIXOS = {
  ENC: "EN",
  TRF: "TR",
} as const;

export type TipoDocumentoNumerado = keyof typeof SEQUENCIAS;

export async function proximoNumeroDocumento(tx: Tx, tipo: TipoDocumentoNumerado): Promise<string> {
  const seq = SEQUENCIAS[tipo];
  const rows = await tx.$queryRaw<{ nextval: bigint }[]>`SELECT nextval(${seq}::regclass) AS nextval`;
  const n = rows[0].nextval;
  return `${PREFIXOS[tipo]}-${n.toString().padStart(6, "0")}`;
}
