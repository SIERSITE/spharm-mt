/**
 * scripts/tests/test-catalog-master.ts
 *
 * Testes das funções puras do catálogo mestre — as que decidem o que
 * entra no bundle e o que pode escrever por cima do quê. Não tocam em
 * nenhuma base de dados nem precisam de env.
 *
 * Correr:
 *   npm run test:catalog-master
 */

import {
  CATALOG_TABLES,
  EXCLUDED_TABLES,
  TABLE_SPECS,
  buildProdutoPatch,
  carriesCatalogValue,
  classificacaoDepth,
  maskConnection,
  naturalKeyClass,
  shouldOverwrite,
  stableStringify,
  chunk,
} from "../catalog-master/_shared";

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, `esperado ${e}, obtido ${a}`);
}

// ── carriesCatalogValue ──────────────────────────────────────────────

const vazio = {
  validadoManualmente: false,
  verificationStatus: "PENDING",
  codigoATC: null,
  dci: null,
  formaFarmaceutica: null,
  dosagem: null,
  embalagem: null,
  imagemUrl: null,
  fabricanteId: null,
  classificacaoNivel2Id: null,
};

check("produto vazio não carrega valor de catálogo", !carriesCatalogValue(vazio));
check("validado à mão carrega valor", carriesCatalogValue({ ...vazio, validadoManualmente: true }));
check("VERIFIED carrega valor", carriesCatalogValue({ ...vazio, verificationStatus: "VERIFIED" }));
check("PARTIALLY_VERIFIED carrega valor", carriesCatalogValue({ ...vazio, verificationStatus: "PARTIALLY_VERIFIED" }));
check("só um ATC já carrega valor", carriesCatalogValue({ ...vazio, codigoATC: "N02BE01" }));
check("só uma imagem já carrega valor", carriesCatalogValue({ ...vazio, imagemUrl: "https://x/y.jpg" }));
check("ERROR sem campos não carrega valor", !carriesCatalogValue({ ...vazio, verificationStatus: "ERROR" }));

// ── shouldOverwrite ──────────────────────────────────────────────────

check(
  "origem nula nunca escreve",
  !shouldOverwrite({ sourceValue: null, targetValue: "X", sourceIsManual: true, targetIsManual: false }),
);
check(
  "origem vazia nunca escreve",
  !shouldOverwrite({ sourceValue: "", targetValue: "X", sourceIsManual: true, targetIsManual: false }),
);
check(
  "destino vazio aceita sempre",
  shouldOverwrite({ sourceValue: "A", targetValue: null, sourceIsManual: false, targetIsManual: false }),
);
check(
  "destino preenchido não cede a origem fraca",
  !shouldOverwrite({ sourceValue: "A", targetValue: "B", sourceIsManual: false, targetIsManual: false }),
);
check(
  "destino preenchido cede a origem validada à mão",
  shouldOverwrite({ sourceValue: "A", targetValue: "B", sourceIsManual: true, targetIsManual: false }),
);
check(
  "destino validado à mão é intocável",
  !shouldOverwrite({ sourceValue: "A", targetValue: "B", sourceIsManual: true, targetIsManual: true }),
);

// ── buildProdutoPatch ────────────────────────────────────────────────

const semFracos = new Set<string>();

eq(
  "destino igual à origem → patch vazio (idempotência)",
  buildProdutoPatch(
    { codigoATC: "N02BE01", dci: "paracetamol", validadoManualmente: false, verificationStatus: "VERIFIED" },
    { codigoATC: "N02BE01", dci: "paracetamol", validadoManualmente: false, verificationStatus: "VERIFIED" },
    semFracos,
  ),
  {},
);

eq(
  "destino virgem recebe ATC e estado de verificação",
  buildProdutoPatch(
    { codigoATC: "N02BE01", validadoManualmente: false, verificationStatus: "VERIFIED", externallyVerified: true },
    { codigoATC: null, validadoManualmente: false, verificationStatus: "PENDING" },
    semFracos,
  ),
  { codigoATC: "N02BE01", verificationStatus: "VERIFIED", externallyVerified: true },
);

eq(
  "produto validado à mão no destino não é tocado",
  buildProdutoPatch(
    { codigoATC: "X99XX99", dci: "outra", validadoManualmente: true, verificationStatus: "VERIFIED" },
    { codigoATC: "N02BE01", dci: "paracetamol", validadoManualmente: true, verificationStatus: "VERIFIED" },
    semFracos,
  ),
  {},
);

eq(
  "validação manual da origem propaga-se a destino não validado",
  buildProdutoPatch(
    { dci: "ibuprofeno", validadoManualmente: true, verificationStatus: "VERIFIED" },
    { dci: "ibuprofen", validadoManualmente: false, verificationStatus: "VERIFIED" },
    semFracos,
  ),
  { dci: "ibuprofeno", validadoManualmente: true, verificationStatus: "VERIFIED" },
);

eq(
  "designação do destino é verdade local e nunca é sobreposta",
  buildProdutoPatch(
    { designacao: "PARACETAMOL 500 MG", validadoManualmente: true },
    { designacao: "Paracetamol 500mg 20 comp", validadoManualmente: false },
    semFracos,
  ),
  { validadoManualmente: true },
);

eq(
  "designação em falta no destino é preenchida",
  buildProdutoPatch(
    { designacao: "PARACETAMOL 500 MG", validadoManualmente: false },
    { designacao: null, validadoManualmente: false },
    semFracos,
  ),
  { designacao: "PARACETAMOL 500 MG" },
);

eq(
  "N1 fraco não substitui classificação existente",
  buildProdutoPatch(
    { classificacaoNivel1Id: "fraco-1", validadoManualmente: true },
    { classificacaoNivel1Id: "bom-1", validadoManualmente: false },
    new Set(["fraco-1"]),
  ),
  { validadoManualmente: true },
);

eq(
  "N1 fraco preenche destino vazio",
  buildProdutoPatch(
    { classificacaoNivel1Id: "fraco-1", validadoManualmente: false },
    { classificacaoNivel1Id: null, validadoManualmente: false },
    new Set(["fraco-1"]),
  ),
  { classificacaoNivel1Id: "fraco-1" },
);

// ── classificacaoDepth ───────────────────────────────────────────────

const arvore = [
  { id: "n2a", classificacaoPaiId: "n1a" },
  { id: "n1a", classificacaoPaiId: null },
  { id: "n3a", classificacaoPaiId: "n2a" },
  { id: "n1b", classificacaoPaiId: null },
];
const depth = classificacaoDepth(arvore);
eq("profundidade raiz = 0", depth.get("n1a"), 0);
eq("profundidade filho = 1", depth.get("n2a"), 1);
eq("profundidade neto = 2", depth.get("n3a"), 2);

const ciclo = [
  { id: "a", classificacaoPaiId: "b" },
  { id: "b", classificacaoPaiId: "a" },
];
check("ciclo não entra em loop infinito", classificacaoDepth(ciclo).size === 2);

// ── naturalKeyClass ──────────────────────────────────────────────────

eq(
  "chave natural é insensível a maiúsculas e espaços",
  naturalKeyClass("  Medicamentos  ", "NIVEL_1", null),
  naturalKeyClass("medicamentos", "NIVEL_1", null),
);
check(
  "pais diferentes dão chaves diferentes",
  naturalKeyClass("Analgésicos", "NIVEL_2", "p1") !== naturalKeyClass("Analgésicos", "NIVEL_2", "p2"),
);

// ── maskConnection ───────────────────────────────────────────────────

const masked = maskConnection("postgresql://utilizador:senha-secreta@ep-abcdefgh-pooler.eu-west-2.aws.neon.tech:5432/spharmmt_t_x?sslmode=require");
check("máscara não revela password", !masked.includes("senha-secreta"), masked);
check("máscara não revela utilizador", !masked.includes("utilizador"), masked);
check("máscara mantém o nome da base", masked.includes("spharmmt_t_x"), masked);
eq("url ilegível não rebenta", maskConnection("nao-e-uma-url"), "(url ilegível)");

// ── stableStringify ──────────────────────────────────────────────────

eq(
  "ordem das chaves é estável",
  stableStringify({ b: 1, a: 2 }),
  stableStringify({ a: 2, b: 1 }),
);
eq(
  "datas viram ISO",
  stableStringify({ d: new Date("2026-08-04T10:00:00.000Z") }),
  '{"d":"2026-08-04T10:00:00.000Z"}',
);
eq("undefined é omitido", stableStringify({ a: 1, b: undefined }), '{"a":1}');

// ── chunk ────────────────────────────────────────────────────────────

eq("chunk divide certo", chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
eq("chunk de vazio", chunk([], 10), []);

// ── inventário de tabelas ────────────────────────────────────────────

check(
  "toda a tabela do catálogo tem spec",
  CATALOG_TABLES.every((t) => TABLE_SPECS[t] !== undefined),
);
check(
  "nenhuma tabela está simultaneamente incluída e excluída",
  CATALOG_TABLES.every((t) => EXCLUDED_TABLES[TABLE_SPECS[t].model] === undefined),
);
check(
  "as tabelas operacionais críticas estão explicitamente excluídas",
  ["ProdutoFarmacia", "Venda", "MovimentoArtigo", "Utilizador", "Farmacia", "IngestStocksMovRaw"].every(
    (m) => EXCLUDED_TABLES[m] !== undefined,
  ),
);
check(
  "todos os ficheiros do bundle têm nome distinto",
  new Set(CATALOG_TABLES.map((t) => TABLE_SPECS[t].file)).size === CATALOG_TABLES.length,
);

// ── round-trip do bundle em disco (NDJSON + checksums) ───────────────
// Cobre o caminho de ficheiros do export/import sem tocar em base de
// dados: escrita, releitura linha-a-linha, checksum e detecção de
// corrupção. Usa um directório temporário que é limpo no fim.

async function bundleRoundTrip(): Promise<void> {
  const { mkdtempSync, rmSync, writeFileSync, appendFileSync } = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { NdjsonWriter, readNdjson, sha256File, verifyBundle, MANIFEST_VERSION, TOOL_VERSION } =
    await import("../catalog-master/_shared");

  const dir = mkdtempSync(path.join(os.tmpdir(), "catalog-master-test-"));
  try {
    const dataDir = path.join(dir, "data");
    const filePath = path.join(dataDir, "produto.ndjson");
    const writer = new NdjsonWriter(filePath);
    const rows = [
      { cnp: 1, designacao: "A", lastVerifiedAt: new Date("2026-01-01T00:00:00.000Z") },
      { cnp: 2, designacao: "B", lastVerifiedAt: null },
    ];
    for (const r of rows) writer.write(r);
    const res = await writer.close();

    eq("writer conta as linhas", res.rows, 2);
    check("writer produz sha256", /^[0-9a-f]{64}$/.test(res.sha256), res.sha256);
    eq("sha256 do writer bate com o do ficheiro", await sha256File(filePath), res.sha256);

    const relidos: Array<Record<string, unknown>> = [];
    for await (const r of readNdjson<Record<string, unknown>>(filePath)) relidos.push(r);
    eq("round-trip preserva o número de linhas", relidos.length, 2);
    eq("round-trip preserva o CNP", relidos[0].cnp, 1);
    eq("round-trip serializa datas em ISO", relidos[0].lastVerifiedAt, "2026-01-01T00:00:00.000Z");

    const manifest = {
      manifestVersion: MANIFEST_VERSION,
      tool: TOOL_VERSION,
      exportedAt: new Date().toISOString(),
      source: { label: "teste", kind: "url-env" as const, tenantSlug: null, schemaVersion: null },
      options: { filter: "enriched" as const, includeHistory: false, includeTipoDoc: false, regulatory: "all" as const },
      tables: [
        { table: "produto" as const, model: "Produto", file: "produto.ndjson", rows: 2, sha256: res.sha256, bytes: res.bytes },
      ],
      coverage: {
        produtos: 2, comATC: 0, comDCI: 0, comFormaFarmaceutica: 0, comDosagem: 0,
        comEmbalagem: 0, comImagem: 0, comFabricante: 0, comNivel1: 0, comNivel2: 0,
        validadosManualmente: 0,
      },
      omittedProdutoFields: [],
      excludedTables: {},
    };
    writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

    eq("bundle íntegro não gera problemas", (await verifyBundle(dir, manifest)).length, 0);

    appendFileSync(filePath, '{"cnp":3,"designacao":"C"}\n', "utf8");
    const problemas = await verifyBundle(dir, manifest);
    check("bundle adulterado é detectado", problemas.length === 1, JSON.stringify(problemas));
    check("mensagem de corrupção identifica o ficheiro", problemas[0]?.includes("produto.ndjson"), problemas[0]);

    const inexistente = { ...manifest, tables: [{ ...manifest.tables[0], file: "nao-existe.ndjson" }] };
    check(
      "ficheiro em falta é detectado",
      (await verifyBundle(dir, inexistente)).some((p) => p.includes("em falta")),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── resultado ────────────────────────────────────────────────────────

bundleRoundTrip()
  .then(() => {
    console.log(`\ncatalog-master — ${passed} asserções passaram, ${failures.length} falharam.`);
    if (failures.length > 0) {
      for (const f of failures) console.error(`  ✗ ${f}`);
      process.exit(1);
    }
    console.log("✓ todos os testes passaram");
  })
  .catch((err) => {
    console.error("✗ round-trip do bundle rebentou:", err);
    process.exit(1);
  });
