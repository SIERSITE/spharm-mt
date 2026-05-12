/**
 * lib/db-providers/select.ts
 *
 * Selecção do `DatabaseProvider` a partir de flags + envs. Lógica
 * centralizada para que CLI scripts (`provision-tenant.ts`, futuro
 * `create-client.ts`) e o workflow programático
 * (`lib/admin/workflow.ts` em PR2) escolham igual.
 *
 * Regras (PR 1 — Neon API ainda não implementada):
 *  · `--database-url` presente               → ManualUrlProvider
 *  · `--create-db` presente                  → LocalPostgresProvider
 *  · Ambos presentes                         → erro (mutuamente exclusivos)
 *  · Nenhum presente                         → erro com mensagem accionável
 *
 * Em PR 2 será adicionada uma regra extra:
 *  · `NEON_API_KEY` + `NEON_PROJECT_ID` defs → NeonProvider (default
 *    em produção; pode ser desligado com `--database-url` explícito).
 */

import { requireEnv, intEnv } from "../env";
import type { DatabaseProvider } from "./types";
import { ManualUrlProvider } from "./manual-url";
import { LocalPostgresProvider } from "./local-postgres";

export type ProviderInputs = {
  /** URL completa Postgres passada pelo operador via flag `--database-url`. */
  databaseUrl?: string;
  /** Operador escolheu modo legacy SQL admin via flag `--create-db`. */
  createDb?: boolean;
};

export class ProviderSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderSelectionError";
  }
}

export function selectProvider(inputs: ProviderInputs): DatabaseProvider {
  const databaseUrl = inputs.databaseUrl?.trim() || undefined;
  const createDb = !!inputs.createDb;

  if (databaseUrl && createDb) {
    throw new ProviderSelectionError(
      "--database-url e --create-db são mutuamente exclusivos."
    );
  }
  if (databaseUrl) {
    return new ManualUrlProvider(databaseUrl);
  }
  if (createDb) {
    // Valida envs específicas — falham com mensagens accionáveis.
    const adminUrl = requireEnv("POSTGRES_ADMIN_URL");
    const host = requireEnv("TENANT_DB_HOST");
    const port = intEnv("TENANT_DB_PORT", 5432, 1, 65535);
    return new LocalPostgresProvider(adminUrl, host, port);
  }
  throw new ProviderSelectionError(
    "Sem provider seleccionado. Passa um de:\n" +
      '  · --database-url "<url>"   (operador já criou DB+role no provider, ex: Neon UI)\n' +
      "  · --create-db               (self-hosted Postgres com super-user access)"
  );
}
