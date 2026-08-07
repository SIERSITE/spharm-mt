import "dotenv/config";
import { spawnSync } from "node:child_process";

/**
 * Corre um comando `prisma` CLI contra o CONTROL schema usando a config
 * dedicada `prisma-control.config.ts` (que aponta para
 * `prisma-control/schema.prisma` + `prisma-control/migrations` + reads
 * CONTROL_DATABASE_URL como datasource).
 *
 * IMPORTANTE: NÃO passar `--schema` aqui. Em Prisma 7, se ambos
 * `--config` e `--schema` forem passados, o resolver de paths fica
 * inconsistente — `migrations.path` da config ganha mas alguns
 * comandos usam o `--schema` como referência para introspect. Manter
 * só `--config` e deixar a config controlar tudo.
 *
 * Histórico: havia um bug crítico em que `--schema prisma-control/...`
 * sem `--config` carregava `prisma.config.ts` (app) por default e
 * aplicava migrations de `prisma/migrations` à BD de control. Ver
 * comentário em `prisma-control.config.ts`.
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

  const args = [...prismaArgs, "--config", "prisma-control.config.ts"];
  const result = spawnSync("npx", ["prisma", ...args], {
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
