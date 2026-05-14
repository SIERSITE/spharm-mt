/**
 * agent/src/config.ts
 *
 * Carrega e valida configuração do `.env` local. Não importa nada do
 * repo SaaS — duplicação consciente para que o agent seja deployable
 * standalone (sem `lib/env.ts` do SaaS).
 *
 * Cada comando declara que envs precisa via `loadConfig(scope)`. O
 * scope determina quais envs são obrigatórias para esse comando.
 */

import "dotenv/config";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Estratégia de paths: tudo relativo a `process.cwd()`. Em distribuição
 * packaged, os `.bat` wrappers começam com `cd /d "%~dp0"` que põe o
 * cwd na pasta SPharmMT-Agent\ junto ao executável; em dev (tsx via
 * npm), cwd é o agent/ ou repo root consoante o script. Não usamos
 * `import.meta.url` para evitar shenanigans entre ESM (tsx) e CJS
 * (esbuild bundle).
 */

/** Path do JSON config (preferido em distribuição packaged). */
export const JSON_CONFIG_PATH = path.resolve(process.cwd(), "agent.config.json");

export type Scope =
  /** Comandos que só falam com a SaaS (ex: heartbeat futuro). */
  | "saas"
  /** Comandos que só falam com o SQL Server (ex: discover). */
  | "sql"
  /** Comandos que precisam de ambos (test-connection, bootstrap, daily-sync). */
  | "both";

/**
 * Configuração obrigatória quando `ordersWriteMode === "insert"`.
 *
 * Todos os campos vêm do operador SPharm — não há defaults seguros
 * sem o conhecimento local do ERP. Validação acontece no loadConfig
 * (falha cedo se incompleta em modo insert).
 *
 * Mapeamento para colunas SPharm:
 *   - userIdForInsert       → dbo.Encomendas.[User ID]                (smallint)
 *   - fornecedorIdForOrders → dbo.Encomendas.[Fornecedor ID]          (int)
 *   - armazemId             → dbo.Encomendas.[ArmazemID]              (tinyint)
 *   - tipoEncomendaId       → dbo.Encomendas.[TipoEncomendaID]        (tinyint)
 *   - encomendaSituacaoInitial → dbo.Encomendas.[EncomendaSituacaoID] (char(1))
 *   - productLookupColumn   → nome da coluna em dbo.Stocks que contém
 *                              o CNP individual do produto.
 *                              **NÃO** `CodCNPEM` (grupo homogéneo —
 *                              identifica grupos de produtos equivalentes,
 *                              não o produto individual).
 *                              Identificar via `inspect-product-identifiers`.
 *
 * Idempotência: gerida via tabela auxiliar `dbo.SPharmMT_OrderWriteLog`
 * (NÃO em nenhuma coluna operacional do SPharm). Tabela criada por
 * `setup-orders-write-log`. Schema-only — nenhuma coluna do ERP é
 * tocada para tracking. O writer falha cedo se a tabela não existir.
 */
export type OrdersInsertConfig = {
  userIdForInsert: number;
  fornecedorIdForOrders: number;
  armazemId: number;
  tipoEncomendaId: number;
  encomendaSituacaoInitial: string;
  productLookupColumn: string;
};

export type AgentConfig = {
  // SaaS
  saasEndpoint: string;
  tenantSlug: string;
  ingestKey: string;
  farmacia?: string;
  // Healthchecks.io (optional external dead-man switch)
  // Quando definido, o daily-pipeline POSTa ao endpoint no start e
  // GET de sucesso/falha no fim. Best-effort — falha de ping nunca
  // afecta o pipeline em si.
  healthcheckUrl?: string;
  // SQL Server
  sqlHost: string;
  sqlPort: number;
  sqlDatabase: string;
  sqlUser: string;
  sqlPassword: string;
  sqlEncrypt: boolean;
  sqlTrustCert: boolean;
  // Output
  outputDir: string;
  // Outbox / orders export
  // Como escrever encomendas finalizadas no SPharm:
  //   · stub   (default) — escreve um JSON por encomenda em
  //     `<outputDir>/orders-export/...` e ACK ao SaaS com docId STUB-...
  //   · insert — INSERT real nas tabelas SPharm. Requer `ordersInsert`
  //     populado e SQL login com db_datawriter (ou INSERT grant) em
  //     dbo.Encomendas + dbo.Encomendas Detalhe.
  ordersWriteMode?: "stub" | "insert";
  /** Obrigatório quando ordersWriteMode === "insert". Apenas populado
   *  se ordersWriteMode=insert E todos os campos passarem validação.
   *  Caso contrário fica undefined e o motivo concreto vai para
   *  `ordersInsertConfigError`. */
  ordersInsert?: OrdersInsertConfig;
  /** Quando ordersWriteMode=insert mas a secção ordersInsert está
   *  incompleta/inválida, contém a mensagem detalhada com a lista de
   *  campos em falta. `loadConfig` NÃO atira — apenas guarda aqui.
   *  Comandos read-only (`inspect-*`) podem ignorar; comandos de
   *  escrita (`export-orders`, `test-order-write`) chamam
   *  `assertOrdersWriteReady(cfg)` para falhar cedo com esta mensagem. */
  ordersInsertConfigError?: string;
  // Misc
  agentVersion: string;
};

/** Erro tipado — caller pode imprimir lista completa de falhas. */
export class ConfigError extends Error {
  constructor(
    message: string,
    public readonly missing: string[]
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

function requireEnv(name: string, missing: string[]): string {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") {
    missing.push(name);
    return "";
  }
  return raw;
}

function optionalEnv(name: string): string | undefined {
  const raw = process.env[name];
  return raw && raw.trim() !== "" ? raw : undefined;
}

function boolEnv(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const norm = raw.toLowerCase().trim();
  return norm === "1" || norm === "true" || norm === "yes";
}

function intEnv(name: string, defaultValue: number, min?: number, max?: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return defaultValue;
  if (min !== undefined && n < min) return min;
  if (max !== undefined && n > max) return max;
  return n;
}

const REQUIRED_BY_SCOPE: Record<Scope, ("saas" | "sql")[]> = {
  saas: ["saas"],
  sql: ["sql"],
  both: ["saas", "sql"],
};

const SAAS_REQUIRED = ["SPHARMMT_ENDPOINT", "SPHARMMT_TENANT_SLUG", "SPHARMMT_INGEST_KEY"];
const SQL_REQUIRED = [
  "ERP_SQLSERVER_HOST",
  "ERP_SQLSERVER_DATABASE",
  "ERP_SQLSERVER_USER",
  "ERP_SQLSERVER_PASSWORD",
];

/**
 * Tenta ler `agent.config.json` do cwd (formato JSON estruturado,
 * preferido em distribuição packaged). Mapeia valores para o mesmo
 * namespace de envs que o `.env` usa, permitindo que o resto de
 * `loadConfig` valide igual em ambos os caminhos.
 *
 * JSON wins sobre `.env` quando ambos definem a mesma chave — é
 * intencional, o `.env` é dev-fallback.
 */
function applyJsonConfigIfPresent(): { source: "json" | "env"; path?: string } {
  if (!fs.existsSync(JSON_CONFIG_PATH)) return { source: "env" };
  let raw: string;
  try {
    raw = fs.readFileSync(JSON_CONFIG_PATH, "utf8");
  } catch (err) {
    throw new ConfigError(
      `agent.config.json existe mas não foi possível ler: ${err instanceof Error ? err.message : err}`,
      []
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(
      `agent.config.json inválido (JSON malformado): ${err instanceof Error ? err.message : err}`,
      []
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new ConfigError(`agent.config.json deve ser um objecto JSON.`, []);
  }
  const cfg = parsed as Record<string, unknown>;
  const saas = (cfg.saas as Record<string, unknown> | undefined) ?? {};
  const sqlServer = (cfg.sqlServer as Record<string, unknown> | undefined) ?? {};
  const options = (cfg.options as Record<string, unknown> | undefined) ?? {};

  const set = (envName: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    process.env[envName] = String(value);
  };

  set("SPHARMMT_ENDPOINT", saas.endpoint);
  set("SPHARMMT_TENANT_SLUG", saas.tenantSlug);
  set("SPHARMMT_INGEST_KEY", saas.ingestKey);
  set("SPHARMMT_FARMACIA", saas.farmacia);
  set("SPHARMMT_HEALTHCHECK_URL", saas.healthcheckUrl);

  set("ERP_SQLSERVER_HOST", sqlServer.host);
  set("ERP_SQLSERVER_PORT", sqlServer.port);
  set("ERP_SQLSERVER_DATABASE", sqlServer.database);
  set("ERP_SQLSERVER_USER", sqlServer.user);
  set("ERP_SQLSERVER_PASSWORD", sqlServer.password);
  if (typeof sqlServer.encrypt === "boolean")
    process.env.ERP_SQLSERVER_ENCRYPT = sqlServer.encrypt ? "1" : "0";
  if (typeof sqlServer.trustServerCertificate === "boolean")
    process.env.ERP_SQLSERVER_TRUST_CERT = sqlServer.trustServerCertificate ? "1" : "0";

  set("SPHARMMT_AGENT_OUTPUT_DIR", options.outputDir);
  set("SPHARMMT_AGENT_VERSION", options.agentVersion);
  set("SPHARMMT_ORDERS_WRITE_MODE", options.ordersWriteMode);

  // ordersInsert: secção dedicada no JSON. Cada campo mapeia para uma env
  // SPHARMMT_ORDERS_* para que o código de validação seja uniforme.
  const ordersInsert = (cfg.ordersInsert as Record<string, unknown> | undefined) ?? {};
  set("SPHARMMT_ORDERS_USER_ID", ordersInsert.userIdForInsert);
  set("SPHARMMT_ORDERS_FORNECEDOR_ID", ordersInsert.fornecedorIdForOrders);
  set("SPHARMMT_ORDERS_ARMAZEM_ID", ordersInsert.armazemId);
  set("SPHARMMT_ORDERS_TIPO_ENCOMENDA_ID", ordersInsert.tipoEncomendaId);
  set("SPHARMMT_ORDERS_SITUACAO_INITIAL", ordersInsert.encomendaSituacaoInitial);
  set("SPHARMMT_ORDERS_PRODUCT_LOOKUP_COLUMN", ordersInsert.productLookupColumn);
  if (ordersInsert.idempotencyColumn !== undefined) {
    // Compat: deprecated em rev17. Emite warning se presente (lemos no
    // loadConfig). Nenhuma escrita em coluna do SPharm — idempotência
    // agora vive em dbo.SPharmMT_OrderWriteLog.
    set("SPHARMMT_ORDERS_IDEMPOTENCY_COLUMN_DEPRECATED", ordersInsert.idempotencyColumn);
  }

  return { source: "json", path: JSON_CONFIG_PATH };
}

/**
 * Carrega config para o scope dado. Lança `ConfigError` listando
 * TODAS as envs em falta (não atira na primeira — diagnose completo
 * no primeiro arranque).
 *
 * Ordem de precedência: `agent.config.json` (cwd) ganha sobre `.env`.
 * Ambos populam o mesmo namespace de process.env.
 */
export function loadConfig(scope: Scope): AgentConfig {
  applyJsonConfigIfPresent();
  const groups = REQUIRED_BY_SCOPE[scope];
  const missing: string[] = [];

  const need = (name: string) => requireEnv(name, missing);

  // Sempre tenta carregar todos os campos (lê mesmo os opcionais
  // para popular a struct). Só marca em falta os que pertencem ao
  // scope pedido.
  const wantsSaas = groups.includes("saas");
  const wantsSql = groups.includes("sql");

  const saasEndpoint = wantsSaas
    ? need("SPHARMMT_ENDPOINT")
    : (optionalEnv("SPHARMMT_ENDPOINT") ?? "");
  const tenantSlug = wantsSaas
    ? need("SPHARMMT_TENANT_SLUG")
    : (optionalEnv("SPHARMMT_TENANT_SLUG") ?? "");
  const ingestKey = wantsSaas
    ? need("SPHARMMT_INGEST_KEY")
    : (optionalEnv("SPHARMMT_INGEST_KEY") ?? "");
  const farmacia = optionalEnv("SPHARMMT_FARMACIA");
  const healthcheckUrl = optionalEnv("SPHARMMT_HEALTHCHECK_URL");

  const sqlHost = wantsSql
    ? need("ERP_SQLSERVER_HOST")
    : (optionalEnv("ERP_SQLSERVER_HOST") ?? "");
  const sqlDatabase = wantsSql
    ? need("ERP_SQLSERVER_DATABASE")
    : (optionalEnv("ERP_SQLSERVER_DATABASE") ?? "");
  const sqlUser = wantsSql
    ? need("ERP_SQLSERVER_USER")
    : (optionalEnv("ERP_SQLSERVER_USER") ?? "");
  const sqlPassword = wantsSql
    ? need("ERP_SQLSERVER_PASSWORD")
    : (optionalEnv("ERP_SQLSERVER_PASSWORD") ?? "");

  // Validações que não envolvem env-missing (formato, etc.)
  if (wantsSaas && saasEndpoint && !/^https?:\/\//.test(saasEndpoint)) {
    missing.push(`SPHARMMT_ENDPOINT (formato inválido — deve começar por http(s)://)`);
  }
  if (wantsSaas && saasEndpoint && saasEndpoint.endsWith("/")) {
    // Sem trailing slash — concatenação fica previsível em http-client
    process.env.SPHARMMT_ENDPOINT = saasEndpoint.replace(/\/+$/, "");
  }

  if (missing.length > 0) {
    const labelled = missing.map((m) => `  · ${m}`).join("\n");
    throw new ConfigError(
      `${missing.length} env(s) obrigatória(s) em falta ou inválida(s) para scope=${scope}:\n${labelled}\n\nVer .env.example para o template completo.`,
      missing
    );
  }

  const sqlPort = intEnv("ERP_SQLSERVER_PORT", 1433, 1, 65535);
  const sqlEncrypt = boolEnv("ERP_SQLSERVER_ENCRYPT", false);
  const sqlTrustCert = boolEnv("ERP_SQLSERVER_TRUST_CERT", true);

  const outputDir =
    optionalEnv("SPHARMMT_AGENT_OUTPUT_DIR") ?? path.resolve(process.cwd(), "output");

  const agentVersion = optionalEnv("SPHARMMT_AGENT_VERSION") ?? "0.1.0";

  const rawOrdersMode = optionalEnv("SPHARMMT_ORDERS_WRITE_MODE")?.toLowerCase();
  const ordersWriteMode: "stub" | "insert" | undefined =
    rawOrdersMode === "stub" || rawOrdersMode === "insert" ? rawOrdersMode : undefined;

  // ordersInsert: leitura defensiva. Em vez de atirar, populamos a
  // struct se tudo OK, ou deixamos undefined + ordersInsertConfigError
  // se há campos em falta/inválidos. A validação estrita só importa
  // para comandos de escrita — comandos read-only (inspect-*) não
  // devem falhar por causa de config destinada a escrever.
  let ordersInsert: OrdersInsertConfig | undefined;
  let ordersInsertConfigError: string | undefined;
  if (ordersWriteMode === "insert") {
    const insertMissing: string[] = [];
    const userId = intOrMissing("SPHARMMT_ORDERS_USER_ID", insertMissing);
    const fornecedorId = intOrMissing("SPHARMMT_ORDERS_FORNECEDOR_ID", insertMissing);
    const armazemId = intOrMissing("SPHARMMT_ORDERS_ARMAZEM_ID", insertMissing);
    const tipoEncomendaId = intOrMissing("SPHARMMT_ORDERS_TIPO_ENCOMENDA_ID", insertMissing);
    const situacaoInitial = optionalEnv("SPHARMMT_ORDERS_SITUACAO_INITIAL") ?? "A";
    const productLookupColumn = optionalEnv("SPHARMMT_ORDERS_PRODUCT_LOOKUP_COLUMN") ?? "";

    if (situacaoInitial.length !== 1) {
      insertMissing.push(
        "SPHARMMT_ORDERS_SITUACAO_INITIAL (deve ser exactamente 1 char — schema é char(1))"
      );
    }

    if (productLookupColumn === "") {
      insertMissing.push(
        "ordersInsert.productLookupColumn (em falta — coluna de dbo.Stocks com o CNP individual; correr inspect-product-identifiers para identificar)"
      );
    } else if (!/^[A-Za-z0-9_ ]{1,128}$/.test(productLookupColumn)) {
      insertMissing.push(
        `ordersInsert.productLookupColumn ("${productLookupColumn}" inválido — caracteres permitidos A-Z a-z 0-9 _ espaço)`
      );
    } else if (productLookupColumn.toLowerCase() === "codcnpem") {
      insertMissing.push(
        `ordersInsert.productLookupColumn = "CodCNPEM" REJEITADO — é grupo homogéneo (Código Nacional Para Equivalência Medicamentosa), NÃO identifica produto individual. Correr inspect-product-identifiers para identificar a coluna real do CNP.`
      );
    }

    // Warning silencioso para configs antigas (pre-rev17) que ainda
    // declaram idempotencyColumn. Não bloqueia, apenas avisa via stderr.
    const deprecatedIdemColumn = optionalEnv(
      "SPHARMMT_ORDERS_IDEMPOTENCY_COLUMN_DEPRECATED"
    );
    if (deprecatedIdemColumn) {
      console.warn(
        `[config] AVISO: ordersInsert.idempotencyColumn ("${deprecatedIdemColumn}") foi REMOVIDO em rev17. ` +
          `Idempotência agora usa dbo.SPharmMT_OrderWriteLog (criada por setup-orders-write-log). ` +
          `Remove o campo de agent.config.json — nenhuma coluna do SPharm é escrita.`
      );
    }

    if (insertMissing.length > 0) {
      const labelled = insertMissing.map((m) => `  · ${m}`).join("\n");
      ordersInsertConfigError =
        `ordersWriteMode=insert exige config ordersInsert. ${insertMissing.length} campo(s) em falta ou inválido(s):\n${labelled}\n\nVer agent.config.example.json secção "ordersInsert".`;
      // NÃO atira aqui — comandos read-only (inspect-*) precisam de
      // continuar a funcionar. Comandos de escrita chamam
      // assertOrdersWriteReady() para falhar cedo se necessário.
    } else {
      ordersInsert = {
        userIdForInsert: userId,
        fornecedorIdForOrders: fornecedorId,
        armazemId,
        tipoEncomendaId,
        encomendaSituacaoInitial: situacaoInitial,
        productLookupColumn,
      };
    }
  }

  return {
    saasEndpoint: (process.env.SPHARMMT_ENDPOINT ?? saasEndpoint).replace(/\/+$/, ""),
    tenantSlug,
    ingestKey,
    farmacia,
    healthcheckUrl,
    sqlHost,
    sqlPort,
    sqlDatabase,
    sqlUser,
    sqlPassword,
    sqlEncrypt,
    sqlTrustCert,
    outputDir,
    ordersWriteMode,
    ordersInsert,
    ordersInsertConfigError,
    agentVersion,
  };
}

/**
 * Falha cedo se o config corrente NÃO está pronto para escrever
 * encomendas. Chamado por `export-orders` e `test-order-write` antes
 * de qualquer SQL. Comandos read-only (`inspect-*`, `setup-*`) NÃO
 * devem chamar esta função — só precisam do scope SQL básico.
 *
 * Regras:
 *   · ordersWriteMode=stub → OK em qualquer caso (writeStub é seguro)
 *   · ordersWriteMode=insert + ordersInsert populado → OK
 *   · ordersWriteMode=insert + ordersInsert undefined → atira com a
 *     mensagem detalhada acumulada em ordersInsertConfigError
 */
export function assertOrdersWriteReady(cfg: AgentConfig): void {
  const mode = cfg.ordersWriteMode ?? "stub";
  if (mode !== "insert") return;
  if (cfg.ordersInsert) return;
  throw new ConfigError(
    cfg.ordersInsertConfigError ??
      "ordersWriteMode=insert mas secção ordersInsert ausente em agent.config.json.",
    []
  );
}

function intOrMissing(name: string, missing: string[]): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") {
    missing.push(name);
    return 0;
  }
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    missing.push(`${name} (valor inválido: "${raw}" — esperado inteiro >= 0)`);
    return 0;
  }
  return n;
}

/** Mascara um string sensível para logs: "xxxxxxx" → "x*****x". */
export function maskSecret(value: string): string {
  if (!value) return "";
  if (value.length <= 4) return "*".repeat(value.length);
  return value[0] + "*".repeat(Math.max(value.length - 2, 4)) + value[value.length - 1];
}

/** Resumo público (sem secrets) — usado por `health`. */
export function describeConfig(cfg: AgentConfig): Record<string, string> {
  return {
    saasEndpoint: cfg.saasEndpoint || "(unset)",
    tenantSlug: cfg.tenantSlug || "(unset)",
    ingestKey: cfg.ingestKey ? maskSecret(cfg.ingestKey) : "(unset)",
    farmacia: cfg.farmacia ?? "(unset — usa SPHARMMT_FARMACIA para bind)",
    sqlHost: cfg.sqlHost ? `${cfg.sqlHost}:${cfg.sqlPort}` : "(unset)",
    sqlDatabase: cfg.sqlDatabase || "(unset)",
    sqlUser: cfg.sqlUser ? maskSecret(cfg.sqlUser) : "(unset)",
    sqlPassword: cfg.sqlPassword ? "***" : "(unset)",
    sqlEncrypt: String(cfg.sqlEncrypt),
    sqlTrustCert: String(cfg.sqlTrustCert),
    outputDir: cfg.outputDir,
    agentVersion: cfg.agentVersion,
  };
}
