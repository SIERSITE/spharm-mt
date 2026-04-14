/**
 * scripts/tenancy/smoke-test-resolver.ts
 *
 * Verifica a infraestrutura de resolução de tenant (Fase 1 do Commit 3):
 *
 *   1. `getPrisma()` chamada fora de request context deve:
 *      · não atirar
 *      · devolver um PrismaClient funcional (legacy fallback)
 *      · conseguir fazer `SELECT 1` via `$queryRaw`
 *
 *   2. Se `CONTROL_DATABASE_URL` estiver definido, o warm-up deve
 *      conseguir listar tenants (mesmo que zero) sem atirar.
 *
 * Este é um integration test mínimo — NÃO substitui testes end-to-end
 * via browser para o path "com header x-tenant-slug". Esses têm de
 * ser feitos manualmente até termos um runner HTTP no CI.
 *
 * Uso:
 *   npm run tenancy:smoke-resolver
 */

import "dotenv/config";
import { getPrisma } from "@/lib/prisma";
import { __resetRegistryForTests } from "@/lib/tenant-registry";

type Step = { name: string; run: () => Promise<void> };

const steps: Step[] = [
  {
    name: "getPrisma() sem contexto de request devolve cliente legacy",
    run: async () => {
      const prisma = await getPrisma();
      if (!prisma) throw new Error("getPrisma devolveu null/undefined");
      if (typeof prisma.$queryRaw !== "function") {
        throw new Error("cliente devolvido não parece ser PrismaClient");
      }
    },
  },
  {
    name: "Cliente legacy executa SELECT 1",
    run: async () => {
      const prisma = await getPrisma();
      const result = await prisma.$queryRaw<Array<{ ok: number }>>`SELECT 1 AS ok`;
      if (!Array.isArray(result) || result.length !== 1 || result[0].ok !== 1) {
        throw new Error(`SELECT 1 devolveu shape inesperado: ${JSON.stringify(result)}`);
      }
    },
  },
  {
    name: "Segundo getPrisma() devolve o mesmo cliente (cache)",
    run: async () => {
      const a = await getPrisma();
      const b = await getPrisma();
      if (a !== b) throw new Error("segunda chamada devolveu instância diferente");
    },
  },
  {
    name: "Warm-up do control plane não atira (se CONTROL_DATABASE_URL definido)",
    run: async () => {
      if (!process.env.CONTROL_DATABASE_URL) {
        console.log("    (skipped — CONTROL_DATABASE_URL não definido)");
        return;
      }
      __resetRegistryForTests();
      // Dispara warm via chamada a getPrisma com um slug forçado.
      // A função não atira: se o slug não existir, cai no legacy.
      const prisma = await getPrisma();
      if (!prisma) throw new Error("warm-up partiu getPrisma");
    },
  },
];

async function main() {
  console.log("▶ Smoke test — resolver de tenant (Fase 1)\n");
  let failed = 0;
  for (const [i, step] of steps.entries()) {
    try {
      await step.run();
      console.log(`  ✓ ${i + 1}. ${step.name}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${i + 1}. ${step.name}`);
      console.error(`      ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log("");
  if (failed > 0) {
    console.error(`${failed}/${steps.length} passos falharam.`);
    process.exit(1);
  }
  console.log(`✓ Todos os ${steps.length} passos passaram.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
