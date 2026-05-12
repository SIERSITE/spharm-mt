/**
 * lib/admin/ingest-key.ts
 *
 * Geração + persistência da ingest key de um tenant, sem qualquer
 * verificação de estado. Função reutilizável pelo workflow de
 * create-client (que emite a key DURANTE provisioning, antes do
 * estado ACTIVE) e por scripts CLI standalone (`issue-ingest-key.ts`)
 * que adicionam validações próprias.
 *
 * Política:
 *   · Chave em claro = `randomBytes(32).toString("hex")` (256-bit
 *     entropy, 64 hex chars).
 *   · Hash bcrypt cost 10 persistido em Tenant.ingestApiKeyHash.
 *   · Plain key devolvida só nesta chamada — caller responsável por
 *     a mostrar UMA VEZ ao operador. Nunca persistida em claro.
 *   · `Tenant.ingestApiKeyIssuedAt` actualizado em UTC.
 *   · NÃO escreve TenantEvent — caller decide se isto é "issued"
 *     (primeiro emit) ou "rotated" (substituição). Audit fica a
 *     cargo do caller.
 */

import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { controlPrisma } from "@/lib/control-plane";

export const BCRYPT_COST = 10;
/** 32 bytes = 64 hex chars. ~256 bits de entropia. */
export const KEY_BYTES = 32;

export type IssueIngestKeyResult = {
  plainKey: string;
  issuedAt: Date;
};

export async function issueIngestKey(tenantId: string): Promise<IssueIngestKeyResult> {
  const plainKey = randomBytes(KEY_BYTES).toString("hex");
  const hash = await bcrypt.hash(plainKey, BCRYPT_COST);
  const issuedAt = new Date();

  await controlPrisma.tenant.update({
    where: { id: tenantId },
    data: {
      ingestApiKeyHash: hash,
      ingestApiKeyIssuedAt: issuedAt,
    },
  });

  return { plainKey, issuedAt };
}
