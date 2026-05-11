/**
 * lib/sync/control-client-cli.ts
 *
 * Pequeno construtor singleton de `PrismaClient` ligado ao control
 * plane, **sem `import "server-only"`**. Existe especificamente para
 * desbloquear o uso CLI dos helpers de Fase 1 WS-B
 * (`lib/sync/sync-run.ts`, `lib/tenancy/for-each-tenant.ts`) sem
 * remover `server-only` de `lib/control-plane.ts` (que arrastaria 25
 * outros ficheiros do runtime web).
 *
 * Não duplica a lógica funcional de `control-plane.ts`: este módulo
 * só constrói o cliente. Tudo o que envolve descifrar tenant secrets,
 * heartbeats, etc., continua em `control-plane.ts` (server-only).
 *
 * Regras de uso:
 *   - NUNCA importar a partir de Client Components — o build do Next
 *     vai aceitar mas o output não vai funcionar (PrismaClient não é
 *     bundlable para client).
 *   - Sempre que possível, preferir `controlPrisma` de `control-plane`
 *     no runtime web (esse caminho tem o marker `server-only` e
 *     resolve-se no bundler).
 */

import { PrismaClient } from "@/generated/prisma-control/client";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForCli = global as unknown as {
  controlClientCli: PrismaClient | undefined;
};

/**
 * Devolve uma instância PrismaClient do control plane. Lazy — só
 * constrói quando chamado. Atira se `CONTROL_DATABASE_URL` estiver em
 * falta (mensagem clara, intencional — sem CONTROL_DATABASE_URL não
 * há onde escrever SyncRun).
 */
export function getControlPrismaCli(): PrismaClient {
  if (globalForCli.controlClientCli) return globalForCli.controlClientCli;
  const url = process.env.CONTROL_DATABASE_URL;
  if (!url) {
    throw new Error(
      "CONTROL_DATABASE_URL em falta. SyncRun ledger e iteração tenant-aware " +
        "requerem o control plane configurado. Define no .env ou omite as " +
        "flags --record-sync-run / --tenant=.",
    );
  }
  const adapter = new PrismaPg({ connectionString: url });
  const client = new PrismaClient({ adapter });
  globalForCli.controlClientCli = client;
  return client;
}
