/**
 * scripts/catalog-master/_shared.ts
 *
 * Núcleo partilhado das três ferramentas do CATÁLOGO MESTRE:
 *   · export-catalog.ts  — extrai o catálogo de uma base explícita
 *   · import-catalog.ts  — semeia esse catálogo numa base nova
 *   · audit-catalog.ts   — mede cobertura e integridade referencial
 *
 * ── Porquê um catálogo mestre ────────────────────────────────────────
 * Na migração para VPS os dados operacionais (stock, vendas, movimentos,
 * compras, devoluções, raw) NÃO são migrados — cada farmácia reimporta
 * do seu ERP via agent. O único activo que não se consegue reconstruir
 * é o catálogo validado e enriquecido: classificação canónica, ATC/DCI,
 * forma/dosagem/embalagem, fabricantes normalizados, imagens, registos
 * regulamentares e — sobretudo — as validações manuais feitas à mão.
 *
 * ── Fronteira do que é "catálogo" ────────────────────────────────────
 * Catálogo = tudo o que é verdade sobre um PRODUTO independentemente da
 * farmácia que o vende. Operacional = tudo o que só faz sentido no
 * contexto de uma farmácia (preço, stock, fornecedor, movimento).
 * `CATALOG_TABLES` e `EXCLUDED_TABLES` abaixo são a aplicação literal
 * dessa regra e a única fonte de verdade das ferramentas.
 *
 * ── Segurança ────────────────────────────────────────────────────────
 * · Nenhuma ferramenta usa `DATABASE_URL` implicitamente. A origem e o
 *   destino são SEMPRE explícitos (`--tenant` ou `--url-env`).
 * · Nada do que é escrito em disco (manifest, NDJSON, logs) contém
 *   credenciais: as URLs são mascaradas por `maskConnection()`.
 * · Os tenants de teste (`demo-neon`, `piloto-demo`) estão em blocklist.
 */

import "dotenv/config";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  controlPrisma,
  getTenantBySlug,
  buildTenantConnectionString,
} from "@/lib/control-plane";

// ─────────────────────────────────────────────────────────────────────
// Inventário de tabelas
// ─────────────────────────────────────────────────────────────────────

/**
 * Ordem canónica de exportação E importação. É a ordem topológica das
 * foreign keys: nenhuma tabela aparece antes daquela de que depende.
 *
 *   Classificacao ──┐ (auto-referência: pai antes de filho, resolvido
 *                   │  por `depth` dentro do próprio ficheiro)
 *   Fabricante ─────┤
 *   FabricanteAlias ┘ (→ Fabricante)
 *   Produto           (→ Fabricante, Classificacao ×2)
 *   RegulatoryRecord  (sem FK; junta-se a Produto por `cnp`)
 *   InfarmedSnapshot  (sem FK; idem)
 *   ProdutoVerificacaoHistorico (→ Produto)  [opcional]
 *   TipoDocumentoClassificacao  (sem FK)     [opcional]
 */
export const CATALOG_TABLES = [
  "classificacao",
  "fabricante",
  "fabricanteAlias",
  "produto",
  "regulatoryRecord",
  "infarmedSnapshot",
  "produtoVerificacaoHistorico",
  "tipoDocumentoClassificacao",
] as const;

export type CatalogTable = (typeof CATALOG_TABLES)[number];

export type TableSpec = {
  table: CatalogTable;
  /** Nome do modelo Prisma / tabela SQL (para mensagens e SQL cru). */
  model: string;
  /** Ficheiro NDJSON dentro de `data/`. */
  file: string;
  /** Chave natural que sobrevive à mudança de base. */
  naturalKey: string;
  /** `true` → só exportada com a flag correspondente. */
  optional: boolean;
  /** Motivo pelo qual pertence (ou não, por omissão) ao catálogo. */
  rationale: string;
};

export const TABLE_SPECS: Record<CatalogTable, TableSpec> = {
  classificacao: {
    table: "classificacao",
    model: "Classificacao",
    file: "classificacao.ndjson",
    naturalKey: "(nome, tipo, classificacaoPaiId)",
    optional: false,
    rationale: "Árvore de classificação canónica N1/N2. Referenciada por Produto ×2.",
  },
  fabricante: {
    table: "fabricante",
    model: "Fabricante",
    file: "fabricante.ndjson",
    naturalKey: "nomeNormalizado",
    optional: false,
    rationale: "Fabricante normalizado — trabalho de deduplicação não reconstruível.",
  },
  fabricanteAlias: {
    table: "fabricanteAlias",
    model: "FabricanteAlias",
    file: "fabricante-alias.ndjson",
    naturalKey: "(fabricanteId, aliasNome)",
    optional: false,
    rationale: "Variantes de nome que alimentam o matching de fabricante no ingest.",
  },
  produto: {
    table: "produto",
    model: "Produto",
    file: "produto.ndjson",
    naturalKey: "cnp",
    optional: false,
    rationale:
      "Núcleo do catálogo: ATC, DCI, forma, dosagem, embalagem, imagem, flags, classificação e validação manual.",
  },
  regulatoryRecord: {
    table: "regulatoryRecord",
    model: "RegulatoryRecord",
    file: "regulatory-record.ndjson",
    naturalKey: "cnp (PK)",
    optional: false,
    rationale: "Camada regulamentar v2 — cache autoritária por CNP, cara de reconstruir.",
  },
  infarmedSnapshot: {
    table: "infarmedSnapshot",
    model: "InfarmedSnapshot",
    file: "infarmed-snapshot.ndjson",
    naturalKey: "cnp",
    optional: false,
    rationale: "Snapshot INFARMED — fallback do conector regulatório quando não há RegulatoryRecord.",
  },
  produtoVerificacaoHistorico: {
    table: "produtoVerificacaoHistorico",
    model: "ProdutoVerificacaoHistorico",
    file: "produto-verificacao-historico.ndjson",
    naturalKey: "id",
    optional: true,
    rationale:
      "Trilho de auditoria das verificações. OPCIONAL (--include-history): é histórico, não estado; pesa e não altera o catálogo.",
  },
  tipoDocumentoClassificacao: {
    table: "tipoDocumentoClassificacao",
    model: "TipoDocumentoClassificacao",
    file: "tipo-documento-classificacao.ndjson",
    naturalKey: "tipoDocumento (PK)",
    optional: true,
    rationale:
      "Mapa ERP tipoDocumento→classe. OPCIONAL (--include-tipodoc): é configuração de ingest, não catálogo de produto, mas é reutilizável entre tenants do mesmo ERP.",
  },
};

/**
 * Tabelas explicitamente EXCLUÍDAS do catálogo mestre, com o motivo.
 * Serve de checklist auditável — se aparecer um modelo novo no schema
 * que não esteja aqui nem em `CATALOG_TABLES`, `npm run catalog:audit`
 * assinala-o.
 */
export const EXCLUDED_TABLES: Record<string, string> = {
  // Identidade e acesso
  Farmacia: "Entidade da farmácia — recriada no onboarding de cada tenant.",
  Utilizador: "Contas e password hashes — nunca saem do tenant de origem.",
  UtilizadorFarmacia: "Vínculo utilizador↔farmácia.",
  EmailConfig: "Credenciais SMTP cifradas — segredo por farmácia.",
  AuditLog: "Trilho de auditoria operacional.",
  // Operacional por farmácia
  ProdutoFarmacia: "Preço, stock, margem, IVA — específico da farmácia.",
  ProdutoInterno: "Código interno do ERP — namespace local.",
  Venda: "Transacional.",
  VendaMensal: "Agregado transacional.",
  Compra: "Transacional.",
  Devolucao: "Transacional.",
  HistoricoStock: "Transacional.",
  AjusteStock: "Transacional.",
  Inventario: "Transacional.",
  LinhaInventario: "Transacional.",
  IndicadoresProdutoFarmacia: "Read-model derivado — recalculado por refresh-ipf.",
  MovimentoArtigo: "Movimentos canónicos — reimportados pelo agent.",
  ListaEncomenda: "Operacional.",
  LinhaEncomenda: "Operacional.",
  OrderOutbox: "Fila de exportação — estado em trânsito.",
  OrderExportAudit: "Log de exportação.",
  // Fornecedores (relação comercial, não catálogo)
  Fornecedor: "Relação comercial da farmácia, não atributo do produto.",
  FornecedorAlias: "Idem.",
  FornecedorErpRef: "Mapeamento para IDs do ERP local.",
  // Ingestão / raw
  LoteIngestao: "Metadados de lote de ingestão.",
  IngestVendaLinhaRaw: "Raw.",
  IngestStocksMovRaw: "Raw.",
  StagingCompraRawLine: "Raw/staging.",
  StagingDevolucaoFornecedorRawLine: "Raw/staging.",
  // Jobs, filas e logs
  RegulatoryAcquisitionJob: "Fila de jobs — recriada por enqueue-regulatory.",
  EnriquecimentoFila: "Fila técnica — recriada pelo pipeline.",
  FilaRevisao: "Fila de revisão humana — estado de trabalho, não catálogo.",
  EnrichmentSourceLog: "Log append-only por conector.",
  PipelineRun: "Log de execuções de pipeline.",
};

/** Slugs que nunca podem ser origem nem destino (item 9 do briefing). */
export const BLOCKED_TENANT_SLUGS = new Set(["demo-neon", "piloto-demo"]);

/**
 * Campos de `Produto` que NÃO entram no catálogo mestre por serem
 * específicos do tenant/ERP de origem.
 */
export const PRODUTO_TENANT_FIELDS = [
  "externalProductId", // Stocks.CodigoID — namespace local, reciclável pelo ERP
  "lastVerificationAttemptAt", // estado transitório do worker
  "dataAtualizacao", // @updatedAt — regenerado no destino
] as const;

// ─────────────────────────────────────────────────────────────────────
// Resolução de ligação — sempre explícita
// ─────────────────────────────────────────────────────────────────────

export type Resolved = {
  /** Rótulo legível para logs e manifest. Nunca contém credenciais. */
  label: string;
  url: string;
  kind: "tenant" | "url-env";
  tenantSlug: string | null;
};

export class CatalogToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogToolError";
  }
}

/**
 * Reduz uma connection string ao par host-truncado + nome da base.
 * Exemplo: `postgresql://user:pass@ep-abc.neon.tech/spharmmt_t_x` passa
 * a `ep-abc***` mais o nome da base. Nunca devolve credenciais.
 */
export function maskConnection(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^([^.]{0,8}).*$/, "$1***");
    return `${host}/${u.pathname.replace(/^\//, "")}`;
  } catch {
    return "(url ilegível)";
  }
}

/**
 * Resolve uma base a partir de argumentos EXPLÍCITOS. Exactamente uma
 * das opções tem de ser dada — nunca há default para `DATABASE_URL`.
 */
export async function resolveDatabase(opts: {
  tenant?: string;
  urlEnv?: string;
  role: "origem" | "destino";
  allowBlockedTenant?: boolean;
}): Promise<Resolved> {
  const { tenant, urlEnv, role } = opts;
  if (!tenant && !urlEnv) {
    throw new CatalogToolError(
      `Falta identificar a base de ${role}. Usa exactamente uma opção:\n` +
        `  --${role === "origem" ? "source" : "target"}-tenant <slug>       (resolvido pelo control plane)\n` +
        `  --${role === "origem" ? "source" : "target"}-url-env <NOME_ENV>  (lê a connection string dessa env)\n` +
        `Nenhuma env é usada por omissão — nem DATABASE_URL.`,
    );
  }
  if (tenant && urlEnv) {
    throw new CatalogToolError(
      `--${role === "origem" ? "source" : "target"}-tenant e --${role === "origem" ? "source" : "target"}-url-env são mutuamente exclusivos.`,
    );
  }

  if (tenant) {
    if (BLOCKED_TENANT_SLUGS.has(tenant) && !opts.allowBlockedTenant) {
      throw new CatalogToolError(
        `Tenant "${tenant}" está em blocklist (tenant de teste) e não participa no catálogo mestre.\n` +
          `Se for mesmo intencional, passa --allow-test-tenant.`,
      );
    }
    const record = await getTenantBySlug(tenant);
    if (!record) {
      throw new CatalogToolError(`Tenant "${tenant}" não existe no control plane.`);
    }
    return {
      label: `tenant:${record.slug} (${record.dbName})`,
      url: buildTenantConnectionString(record),
      kind: "tenant",
      tenantSlug: record.slug,
    };
  }

  const raw = process.env[urlEnv!];
  if (!raw) {
    throw new CatalogToolError(
      `A env "${urlEnv}" está vazia ou não definida. Define-a no ambiente antes de correr.`,
    );
  }
  return {
    label: `env:${urlEnv} (${maskConnection(raw)})`,
    url: raw,
    kind: "url-env",
    tenantSlug: null,
  };
}

export function openClient(url: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}

/** Fecha o cliente do control plane se tiver sido usado. */
export async function closeControl(): Promise<void> {
  await controlPrisma.$disconnect().catch(() => {});
}

/** Última migração aplicada na base — usado para detectar schema drift. */
export async function readSchemaVersion(prisma: PrismaClient): Promise<string | null> {
  try {
    const rows = await prisma.$queryRaw<Array<{ migration_name: string }>>`
      SELECT migration_name FROM _prisma_migrations
      WHERE finished_at IS NOT NULL
      ORDER BY finished_at DESC LIMIT 1
    `;
    return rows[0]?.migration_name ?? null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Manifest
// ─────────────────────────────────────────────────────────────────────

export const MANIFEST_VERSION = 1 as const;
export const TOOL_VERSION = "catalog-master/1.0.0";

export type ManifestTable = {
  table: CatalogTable;
  model: string;
  file: string;
  rows: number;
  /** sha256 do ficheiro NDJSON, em hex. */
  sha256: string;
  bytes: number;
};

export type ManifestCoverage = {
  produtos: number;
  comATC: number;
  comDCI: number;
  comFormaFarmaceutica: number;
  comDosagem: number;
  comEmbalagem: number;
  comImagem: number;
  comFabricante: number;
  comNivel1: number;
  comNivel2: number;
  validadosManualmente: number;
};

export type CatalogManifest = {
  manifestVersion: typeof MANIFEST_VERSION;
  tool: string;
  exportedAt: string;
  source: {
    /** Rótulo mascarado — nunca contém credenciais. */
    label: string;
    kind: Resolved["kind"];
    tenantSlug: string | null;
    schemaVersion: string | null;
  };
  options: {
    filter: ProdutoFilter;
    includeHistory: boolean;
    includeTipoDoc: boolean;
    regulatory: RegulatoryScope;
  };
  tables: ManifestTable[];
  coverage: ManifestCoverage;
  /** Campos de Produto deliberadamente omitidos por serem do tenant. */
  omittedProdutoFields: string[];
  /** Tabelas excluídas + motivo, para o manifest ser auto-explicativo. */
  excludedTables: Record<string, string>;
};

export type ProdutoFilter = "enriched" | "all";
export type RegulatoryScope = "all" | "referenced" | "none";

export function readManifest(dir: string): CatalogManifest {
  const p = path.join(dir, "manifest.json");
  if (!existsSync(p)) {
    throw new CatalogToolError(`manifest.json não encontrado em ${dir}.`);
  }
  const parsed = JSON.parse(readFileSync(p, "utf8")) as CatalogManifest;
  if (parsed.manifestVersion !== MANIFEST_VERSION) {
    throw new CatalogToolError(
      `manifest.json tem versão ${parsed.manifestVersion}; esta ferramenta lê a versão ${MANIFEST_VERSION}.`,
    );
  }
  return parsed;
}

// ─────────────────────────────────────────────────────────────────────
// NDJSON + checksums
// ─────────────────────────────────────────────────────────────────────

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Serialização estável: chaves ordenadas, Date → ISO, BigInt → string. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) continue;
      out[key] = sortValue(v);
    }
    return out;
  }
  return value;
}

/** Escritor NDJSON que vai calculando o sha256 do que escreve. */
export class NdjsonWriter {
  private readonly stream: ReturnType<typeof createWriteStream>;
  private readonly hash = createHash("sha256");
  private bytes = 0;
  private count = 0;

  constructor(readonly filePath: string) {
    ensureDir(path.dirname(filePath));
    this.stream = createWriteStream(filePath, { encoding: "utf8" });
  }

  write(row: unknown): void {
    const line = `${stableStringify(row)}\n`;
    this.hash.update(line);
    this.bytes += Buffer.byteLength(line, "utf8");
    this.count += 1;
    this.stream.write(line);
  }

  async close(): Promise<{ rows: number; sha256: string; bytes: number }> {
    await new Promise<void>((resolve, reject) => {
      this.stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
    return { rows: this.count, sha256: this.hash.digest("hex"), bytes: this.bytes };
  }
}

/** Lê um NDJSON linha a linha sem carregar o ficheiro todo em memória. */
export async function* readNdjson<T>(filePath: string): AsyncGenerator<T> {
  if (!existsSync(filePath)) return;
  const rl = createInterface({ input: createReadStream(filePath, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    yield JSON.parse(trimmed) as T;
  }
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(filePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve())
      .on("error", reject);
  });
  return hash.digest("hex");
}

/**
 * Verifica todos os ficheiros do manifest contra os checksums gravados.
 * Devolve a lista de discrepâncias (vazia = bundle íntegro).
 */
export async function verifyBundle(dir: string, manifest: CatalogManifest): Promise<string[]> {
  const problems: string[] = [];
  for (const t of manifest.tables) {
    const file = path.join(dir, "data", t.file);
    if (!existsSync(file)) {
      if (t.rows > 0) problems.push(`${t.file}: em falta (manifest diz ${t.rows} linhas)`);
      continue;
    }
    const actual = await sha256File(file);
    if (actual !== t.sha256) {
      problems.push(`${t.file}: sha256 diferente (esperado ${t.sha256.slice(0, 12)}…, obtido ${actual.slice(0, 12)}…)`);
    }
  }
  return problems;
}

// ─────────────────────────────────────────────────────────────────────
// Regras de força (partilhadas entre import e auditoria)
// ─────────────────────────────────────────────────────────────────────

/** Estados de verificação considerados "fonte de confiança". */
export const STRONG_VERIFICATION = new Set(["VERIFIED", "PARTIALLY_VERIFIED"]);

/** Nível 1 usado como fallback fraco — nunca propagado sobre nada. */
export const WEAK_NIVEL1 = "outros medicamentos";

export type ProdutoStrength = {
  validadoManualmente: boolean;
  verificationStatus: string | null;
  codigoATC: string | null;
  dci: string | null;
  formaFarmaceutica: string | null;
  dosagem: string | null;
  embalagem: string | null;
  imagemUrl: string | null;
  fabricanteId: string | null;
  classificacaoNivel2Id: string | null;
};

/**
 * Um produto "carrega valor de catálogo" se foi validado à mão, se foi
 * verificado automaticamente com sucesso, ou se tem pelo menos um campo
 * enriquecido. Produtos sem nada disto são só uma designação de ERP —
 * o agent recria-os no primeiro import.
 */
export function carriesCatalogValue(p: ProdutoStrength): boolean {
  if (p.validadoManualmente) return true;
  if (p.verificationStatus && STRONG_VERIFICATION.has(p.verificationStatus)) return true;
  return Boolean(
    p.codigoATC ||
      p.dci ||
      p.formaFarmaceutica ||
      p.dosagem ||
      p.embalagem ||
      p.imagemUrl ||
      p.fabricanteId ||
      p.classificacaoNivel2Id,
  );
}

/**
 * Decide se um valor de origem pode escrever por cima do destino.
 *
 * Regras, por ordem:
 *   1. Origem nula/vazia nunca escreve (não se apaga informação).
 *   2. Destino vazio aceita sempre (é o caso do bootstrap).
 *   3. Destino preenchido só cede a uma origem ESTRITAMENTE mais forte
 *      — isto é, validada à mão quando o destino não está.
 *
 * `sourceIsManual`/`targetIsManual` referem-se a `validadoManualmente`.
 */
export function shouldOverwrite(args: {
  sourceValue: unknown;
  targetValue: unknown;
  sourceIsManual: boolean;
  targetIsManual: boolean;
}): boolean {
  const { sourceValue, targetValue, sourceIsManual, targetIsManual } = args;
  if (sourceValue === null || sourceValue === undefined || sourceValue === "") return false;
  if (targetValue === null || targetValue === undefined || targetValue === "") return true;
  if (targetIsManual) return false;
  return sourceIsManual;
}

/** Campos de Produto sujeitos à regra de força campo-a-campo no import. */
export const PRODUTO_MERGE_FIELDS = [
  "designacao",
  "tipoArtigo",
  "codigoATC",
  "dci",
  "imagemUrl",
  "formaFarmaceutica",
  "dosagem",
  "embalagem",
  "grupoHomogeneo",
  "productType",
  "productTypeConfidence",
  "classificationSource",
  "classificationVersion",
  "manualReviewReason",
  "fabricanteId",
  "classificacaoNivel1Id",
  "classificacaoNivel2Id",
] as const;

/**
 * Constrói o patch de UPDATE de um Produto aplicando as regras de força.
 * Devolve `{}` quando não há nada a mudar — é este caminho que garante a
 * idempotência do import (segunda corrida = zero escritas).
 *
 * Pura de propósito: é o núcleo de decisão do importador e está coberta
 * por `scripts/tests/test-catalog-master.ts`.
 */
export function buildProdutoPatch(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  weakNivel1Ids: Set<string>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const sourceIsManual = source.validadoManualmente === true;
  const targetIsManual = target.validadoManualmente === true;

  for (const field of PRODUTO_MERGE_FIELDS) {
    let sourceValue = source[field];
    // N1 fraco ("Outros Medicamentos") nunca escreve por cima de nada.
    if (
      field === "classificacaoNivel1Id" &&
      typeof sourceValue === "string" &&
      weakNivel1Ids.has(sourceValue) &&
      target[field] != null
    ) {
      continue;
    }
    // A designação do destino vem do ERP da farmácia — é verdade local.
    if (field === "designacao" && target[field]) continue;
    if (sourceValue === undefined) sourceValue = null;
    if (shouldOverwrite({ sourceValue, targetValue: target[field], sourceIsManual, targetIsManual })) {
      patch[field] = sourceValue;
    }
  }

  // Sinais de verificação: a validação manual propaga-se para um destino
  // não-validado; caso contrário só se preenche um destino ainda virgem.
  if (sourceIsManual && !targetIsManual) {
    patch.validadoManualmente = true;
    if (source.verificationStatus) patch.verificationStatus = source.verificationStatus;
    if (source.lastVerifiedAt) patch.lastVerifiedAt = source.lastVerifiedAt;
  } else if (!targetIsManual && target.verificationStatus === "PENDING" && source.verificationStatus) {
    patch.verificationStatus = source.verificationStatus;
    if (source.lastVerifiedAt) patch.lastVerifiedAt = source.lastVerifiedAt;
    if (source.externallyVerified === true) patch.externallyVerified = true;
  }

  return patch;
}

/** Chave natural de uma Classificacao já com o pai remapeado no destino. */
export function naturalKeyClass(nome: string, tipo: string, paiId: string | null): string {
  return `${tipo} ${nome.trim().toLowerCase()} ${paiId ?? ""}`;
}

/** Formata um número com separador de milhares pt-PT. */
export function fmt(n: number): string {
  return n.toLocaleString("pt-PT");
}

/** Divide um array em lotes de tamanho fixo. */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Calcula a profundidade de cada classificação na árvore (raiz = 0). */
export function classificacaoDepth(
  rows: Array<{ id: string; classificacaoPaiId: string | null }>,
): Map<string, number> {
  const parent = new Map<string, string | null>(rows.map((r) => [r.id, r.classificacaoPaiId]));
  const depth = new Map<string, number>();
  const resolve = (id: string, seen: Set<string>): number => {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return 0; // ciclo defensivo — trata como raiz
    seen.add(id);
    const pai = parent.get(id) ?? null;
    const d = pai === null || !parent.has(pai) ? 0 : resolve(pai, seen) + 1;
    depth.set(id, d);
    return d;
  };
  for (const r of rows) resolve(r.id, new Set());
  return depth;
}
