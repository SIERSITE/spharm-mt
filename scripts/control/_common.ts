import "dotenv/config";
import { spawnSync } from "node:child_process";

/**
 * Corre um comando `prisma` CLI contra o CONTROL schema. Resolve
 * o problema de DATABASE_URL override injectando o valor de
 * CONTROL_DATABASE_URL na env antes do spawn — o prisma.config.ts
 * do projecto usa process.env.DATABASE_URL, portanto isto faz com
 * que a mesma config sirva os dois planos sem duplicação de ficheiros.
 *
 * Uso:
 *   runPrismaControl(["migrate", "deploy"])
 *   runPrismaControl(["generate"])
 */
export function runPrismaControl(prismaArgs: string[]): void {
  const controlUrl = process.env.CONTROL_DATABASE_URL;
  if (!controlUrl) {
    console.error(
      "[control] CONTROL_DATABASE_URL em falta. Define no .env antes de correr scripts do control plane."
    );
    process.exit(1);
  }

  const args = [...prismaArgs, "--schema", "prisma-control/schema.prisma"];
  const result = spawnSync("npx", ["prisma", ...args], {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: controlUrl },
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
