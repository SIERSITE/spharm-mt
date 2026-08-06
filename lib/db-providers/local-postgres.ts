/**
 * lib/db-providers/local-postgres.ts
 *
 * Provider para Postgres self-hosted ou managed onde temos super-user
 * access (POSTGRES_ADMIN_URL com CREATEDB+CREATEROLE). Equivalente ao
 * modo legacy `--create-db` do `provision-tenant.ts` original.
 *
 * Em Neon partilhado tipicamente FALHA com `42501 must be able to SET
 * ROLE` — usar ManualUrlProvider ou (PR2) NeonProvider.
 *
 * Operações:
 *  · createDatabase: CREATE ROLE + CREATE DATABASE + GRANT CONNECT
 *  · destroyDatabase: DROP DATABASE + DROP ROLE (best-effort, ignora
 *    erros para que cleanup parcial não atire por sua vez)
 */

import pg from "pg";
import {
  slugToDbNames,
  generatePassword,
  quoteIdent,
  quoteLiteral,
  buildPgUrl,
} from "../../scripts/tenancy/_shared";
import type { ConnectionTargets, DatabaseProvider } from "./types";

export class LocalPostgresProvider implements DatabaseProvider {
  readonly name = "local-postgres";

  constructor(
    private readonly adminUrl: string,
    private readonly host: string,
    private readonly port: number = 5432
  ) {}

  private async openAdmin(): Promise<pg.Client> {
    const client = new pg.Client({ connectionString: this.adminUrl });
    await client.connect();
    return client;
  }

  async createDatabase({ slug }: { slug: string }): Promise<ConnectionTargets> {
    const { dbUser, dbName } = slugToDbNames(slug);
    const dbPassword = generatePassword();

    const admin = await this.openAdmin();
    let roleCreated = false;
    let dbCreated = false;
    try {
      await admin.query(
        `CREATE ROLE ${quoteIdent(dbUser)} LOGIN PASSWORD ${quoteLiteral(dbPassword)}`
      );
      roleCreated = true;

      // Necessário quando o role administrativo NÃO é superutilizador —
      // que é o caso desde que a criação de clientes passou a poder vir
      // da API (o serviço `web` usa um role com CREATEDB + CREATEROLE e
      // mais nada).
      //
      // A partir do PostgreSQL 16, quem cria um role com CREATEROLE fica
      // com ADMIN OPTION sobre ele mas SEM SET — e `CREATE DATABASE ...
      // OWNER x` exige poder fazer SET ROLE x. Sem esta linha:
      //
      //   ERROR: must be able to SET ROLE "spharmmt_t_<slug>"
      //
      // Reproduzido num PostgreSQL 17.6 limpo, com e sem esta linha.
      // Para um superutilizador é inofensiva: ele já podia SET ROLE, e o
      // GRANT é aceite na mesma (verificado).
      await admin.query(`GRANT ${quoteIdent(dbUser)} TO CURRENT_USER WITH SET TRUE`);

      await admin.query(
        `CREATE DATABASE ${quoteIdent(dbName)} OWNER ${quoteIdent(dbUser)}`
      );
      dbCreated = true;
      await admin.query(
        `REVOKE CONNECT ON DATABASE ${quoteIdent(dbName)} FROM PUBLIC`
      );
      await admin.query(
        `GRANT CONNECT ON DATABASE ${quoteIdent(dbName)} TO ${quoteIdent(dbUser)}`
      );
    } catch (err) {
      // Rollback parcial — ainda dentro da fronteira deste provider.
      // Erro propaga para o caller depois de tentar limpar.
      if (dbCreated) {
        try {
          await admin.query(`DROP DATABASE ${quoteIdent(dbName)}`);
        } catch {}
      }
      if (roleCreated) {
        try {
          await admin.query(`DROP ROLE ${quoteIdent(dbUser)}`);
        } catch {}
      }
      throw err;
    } finally {
      await admin.end();
    }

    return {
      host: this.host,
      port: this.port,
      dbName,
      dbUser,
      dbPassword,
      connectionUrl: buildPgUrl({
        host: this.host,
        port: this.port,
        dbName,
        user: dbUser,
        password: dbPassword,
      }),
    };
  }

  async destroyDatabase({
    dbName,
    dbUser,
  }: {
    dbName: string;
    dbUser: string;
  }): Promise<void> {
    const admin = await this.openAdmin();
    try {
      try {
        await admin.query(`DROP DATABASE ${quoteIdent(dbName)}`);
      } catch {}
      try {
        await admin.query(`DROP ROLE ${quoteIdent(dbUser)}`);
      } catch {}
    } finally {
      await admin.end();
    }
  }
}
