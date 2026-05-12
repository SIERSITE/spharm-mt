/**
 * lib/db-providers/index.ts
 *
 * Barrel export do módulo de providers. Importadores devem usar este
 * entry point — não os ficheiros individuais — para que refactors
 * internos (split, rename) não exijam mudanças cross-module.
 */

export type { ConnectionTargets, DatabaseProvider } from "./types";
export { testTenantDbReachable } from "./connectivity";
export { ManualUrlProvider } from "./manual-url";
export { LocalPostgresProvider } from "./local-postgres";
export { NeonProvider } from "./neon";
export type { NeonProviderConfig, FetchLike } from "./neon";
export { selectProvider, ProviderSelectionError } from "./select";
export type { ProviderInputs, ProviderKind } from "./select";
