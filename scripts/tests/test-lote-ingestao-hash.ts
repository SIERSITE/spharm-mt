/**
 * scripts/tests/test-lote-ingestao-hash.ts
 *
 * Testes puros para `hashFileContent` em `lib/ingest/lote-ingestao`.
 * Não toca em BD. Os helpers async (startLote, completeLote, etc.)
 * dependem de Prisma e ficam cobertos pelo smoke E2E.
 *
 * Correr: npx tsx scripts/tests/test-lote-ingestao-hash.ts
 */

import { hashFileContent } from "../../lib/ingest/lote-ingestao";

const errors: string[] = [];
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    errors.push(msg);
    console.error(`  ✗ ${msg}`);
  } else {
    console.log(`  ✓ ${msg}`);
  }
}

console.log("\n1. Determinismo:");
{
  const buf = Buffer.from("conteúdo de teste");
  const a = hashFileContent(buf);
  const b = hashFileContent(buf);
  assert(a === b, `mesmo input → mesmo hash (${a.slice(0, 12)}...)`);
  assert(a.length === 64, `hash tem 64 chars hex (got ${a.length})`);
  assert(/^[0-9a-f]{64}$/.test(a), "hash é hex lowercase");
}

console.log("\n2. Inputs distintos → hashes distintos:");
{
  const a = hashFileContent(Buffer.from("AAAA"));
  const b = hashFileContent(Buffer.from("BBBB"));
  assert(a !== b, "AAAA ≠ BBBB");
}

console.log("\n3. Sensível a single-byte change:");
{
  const a = hashFileContent(Buffer.from("teste"));
  const b = hashFileContent(Buffer.from("Teste"));
  assert(a !== b, "case-sensitive");
}

console.log("\n4. Uint8Array aceite:");
{
  const a = hashFileContent(new Uint8Array([1, 2, 3, 4, 5]));
  const b = hashFileContent(Buffer.from([1, 2, 3, 4, 5]));
  assert(a === b, "Uint8Array == Buffer com mesmos bytes");
}

console.log("\n5. Hash conhecido (sha256 of empty buffer):");
{
  const empty = hashFileContent(Buffer.alloc(0));
  assert(
    empty === "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    `sha256 do empty bytes (got ${empty})`,
  );
}

console.log("\n" + "─".repeat(78));
if (errors.length === 0) {
  console.log("✅ lote-ingestao hash: todos os testes passaram");
  process.exit(0);
} else {
  console.error(`❌ ${errors.length} testes falharam`);
  process.exit(1);
}
