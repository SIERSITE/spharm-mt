/**
 * lib/db-providers/manual-url.ts
 *
 * Provider para o caso em que o operador (humano) trouxe a URL Postgres
 * completa — tipicamente porque criou DB+role manualmente na UI do
 * provider (Neon, Supabase, RDS, on-prem). O provider:
 *
 *  · Parse da URL extraindo host/port/db/user/password
 *  · Preserva a URL verbatim como `connectionUrl` (mantém query
 *    params como sslmode, channel_binding, application_name)
 *  · Valida conectividade antes de devolver
 *  · destroyDatabase é no-op (operador detém o ciclo de vida)
 */

import { URL } from "node:url";
import type { ConnectionTargets, DatabaseProvider } from "./types";
import { testTenantDbReachable } from "./connectivity";

export class ManualUrlProvider implements DatabaseProvider {
  readonly name = "manual";

  constructor(private readonly url: string) {}

  /**
   * Parse + valida formato. Expor estático para que callers/testes
   * possam validar a URL antes de instanciar e tentar conectar.
   */
  static parse(raw: string): ConnectionTargets {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error(
        `URL inválida: não parseable. Esperado postgresql://user:pass@host:port/dbname?...`
      );
    }
    if (!/^postgres(ql)?:$/.test(parsed.protocol)) {
      throw new Error(
        `URL inválida: protocolo "${parsed.protocol}" — usa postgresql:// ou postgres://`
      );
    }
    const host = parsed.hostname;
    const port = parsed.port ? Number(parsed.port) : 5432;
    const dbName = parsed.pathname.replace(/^\//, "");
    const dbUser = decodeURIComponent(parsed.username);
    const dbPassword = decodeURIComponent(parsed.password);
    const missing = [
      !host && "host",
      !dbName && "dbname",
      !dbUser && "user",
      !dbPassword && "password",
    ].filter(Boolean);
    if (missing.length > 0) {
      throw new Error(`URL incompleta. Faltam campos: ${missing.join(", ")}`);
    }
    return { host, port, dbName, dbUser, dbPassword, connectionUrl: raw };
  }

  async createDatabase(_opts: { slug: string }): Promise<ConnectionTargets> {
    const targets = ManualUrlProvider.parse(this.url);
    await testTenantDbReachable(targets.connectionUrl);
    return targets;
  }

  async destroyDatabase(_opts: { dbName: string; dbUser: string }): Promise<void> {
    // ManualUrlProvider não detém o ciclo de vida da DB. Operador é
    // responsável por DROP manual no provider externo se quiser limpar.
  }
}
