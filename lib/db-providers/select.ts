/**
 * lib/db-providers/select.ts
 *
 * Selecção do `DatabaseProvider` a partir de flags + envs. Lógica
 * centralizada para que CLI scripts e o workflow programático
 * (`lib/admin/create-client-workflow.ts`) escolham igual.
 *
 * Ordem de precedência (primeiro match ganha):
 *
 *  1. `provider` flag explícita ("neon" | "manual" | "local")
 *  2. `databaseUrl` presente             → ManualUrlProvider
 *  3. `createDb` flag (alias legacy)     → LocalPostgresProvider
 *  4. Auto-detect via env:
 *       · NEON_API_KEY + NEON_PROJECT_ID → NeonProvider
 *       · POSTGRES_ADMIN_URL + TENANT_DB_HOST → LocalPostgresProvider
 *  5. Sem provider → ProviderSelectionError accionável
 *
 * Múltiplas flags explícitas simultâneas → erro mutuamente exclusivas.
 */

import { requireEnv, optionalEnv, intEnv } from "../env";
import type { DatabaseProvider } from "./types";
import { ManualUrlProvider } from "./manual-url";
import { LocalPostgresProvider } from "./local-postgres";
import { NeonProvider } from "./neon";

export type ProviderKind = "neon" | "manual" | "local";

export type ProviderInputs = {
  /** Selecção explícita; ganha sobre tudo o resto. */
  provider?: ProviderKind;
  /** URL completa para ManualUrlProvider. */
  databaseUrl?: string;
  /** Alias legacy de `provider="local"`. */
  createDb?: boolean;
};

export class ProviderSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderSelectionError";
  }
}

function detectFromEnv(): ProviderKind | null {
  const neonApiKey = optionalEnv("NEON_API_KEY");
  const neonProjectId = optionalEnv("NEON_PROJECT_ID");
  if (neonApiKey && neonProjectId) return "neon";

  const adminUrl = optionalEnv("POSTGRES_ADMIN_URL");
  const tenantHost = optionalEnv("TENANT_DB_HOST");
  if (adminUrl && tenantHost) return "local";

  return null;
}

function instantiate(kind: ProviderKind, inputs: ProviderInputs): DatabaseProvider {
  switch (kind) {
    case "manual": {
      const url = inputs.databaseUrl?.trim();
      if (!url) {
        throw new ProviderSelectionError(
          "provider=manual exige --database-url=<url> com a connection string completa."
        );
      }
      return new ManualUrlProvider(url);
    }
    case "local": {
      const adminUrl = requireEnv("POSTGRES_ADMIN_URL");
      const host = requireEnv("TENANT_DB_HOST");
      const port = intEnv("TENANT_DB_PORT", 5432, 1, 65535);
      return new LocalPostgresProvider(adminUrl, host, port);
    }
    case "neon": {
      const apiKey = requireEnv("NEON_API_KEY");
      const projectId = requireEnv("NEON_PROJECT_ID");
      const defaultRegion = optionalEnv("NEON_DEFAULT_REGION") ?? undefined;
      const apiBaseUrl = optionalEnv("NEON_API_BASE_URL") ?? undefined;
      return new NeonProvider({ apiKey, projectId, defaultRegion, apiBaseUrl });
    }
  }
}

export function selectProvider(inputs: ProviderInputs): DatabaseProvider {
  const databaseUrl = inputs.databaseUrl?.trim() || undefined;
  const createDb = !!inputs.createDb;

  // Detecção de flags em conflito. Lista todas as flags explícitas e
  // se mais de uma estiver presente para modos diferentes → erro.
  // Excepções legítimas:
  //   · --provider=manual + --database-url    (URL alimenta o manual)
  //   · --provider=local                       (não precisa de --create-db)
  const explicit: string[] = [];
  if (inputs.provider) explicit.push(`--provider=${inputs.provider}`);
  if (databaseUrl && inputs.provider !== "manual") explicit.push("--database-url");
  if (createDb && inputs.provider !== "local") explicit.push("--create-db");

  if (explicit.length > 1) {
    throw new ProviderSelectionError(
      `Múltiplas flags de provider, mutuamente exclusivas: ${explicit.join(", ")}. ` +
        "Escolhe apenas uma de: --provider=<kind>, --database-url, --create-db."
    );
  }

  // 1. Explicit provider flag — caller diz o que quer
  if (inputs.provider) return instantiate(inputs.provider, inputs);

  // 2. databaseUrl ⇒ manual (a forma mais comum em PR1)
  if (databaseUrl) return instantiate("manual", inputs);

  // 3. legacy createDb flag
  if (createDb) return instantiate("local", inputs);

  // 4. Auto-detect from env
  const fromEnv = detectFromEnv();
  if (fromEnv) return instantiate(fromEnv, inputs);

  // 5. Nada — erro accionável
  throw new ProviderSelectionError(
    "Sem provider seleccionado. Passa um de:\n" +
      "  · --provider=neon                      (requer NEON_API_KEY + NEON_PROJECT_ID)\n" +
      '  · --provider=manual --database-url "<url>"   (operador trouxe URL pronta)\n' +
      "  · --provider=local                     (requer POSTGRES_ADMIN_URL + TENANT_DB_HOST)\n" +
      "Ou define NEON_API_KEY+NEON_PROJECT_ID para auto-detect Neon."
  );
}
