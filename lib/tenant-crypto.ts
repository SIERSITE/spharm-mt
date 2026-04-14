import "server-only";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/**
 * Cifra usada exclusivamente para credenciais de tenants no control
 * plane (Tenant.dbPassEncrypted). MESMO algoritmo que lib/email-crypto.ts
 * (AES-256-GCM + scrypt), mas com:
 *
 *   · env var separada  → TENANT_ENCRYPTION_SECRET
 *   · salt separado     → "sphmt-tenant-v1"
 *
 * Razão: domain separation. Uma password cifrada aqui nunca pode ser
 * descifrada pelo módulo de email nem vice-versa, mesmo que a chave de
 * uma caixa caia. Evita blast radius cruzado.
 *
 * ⚠️ AVISO OPERACIONAL: perder TENANT_ENCRYPTION_SECRET torna todas as
 * connection strings de tenants ilegíveis. Backup desta chave num
 * secret manager externo (Bitwarden / Vault / paper-in-safe) é
 * obrigatório em produção.
 */

const ALGO = "aes-256-gcm";
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;
const SALT = "sphmt-tenant-v1";

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const secret = process.env.TENANT_ENCRYPTION_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error(
      "TENANT_ENCRYPTION_SECRET em falta ou demasiado curto (>=16 chars). Define no .env."
    );
  }
  cachedKey = scryptSync(secret, SALT, KEY_LEN);
  return cachedKey;
}

export function encryptTenantSecret(plain: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64");
}

export function decryptTenantSecret(payload: string): string {
  const key = getKey();
  const buf = Buffer.from(payload, "base64");
  if (buf.length < IV_LEN + TAG_LEN) throw new Error("Payload cifrado inválido");
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
