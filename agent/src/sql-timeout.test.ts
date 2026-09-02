/**
 * agent/src/sql-timeout.test.ts
 *
 * O tecto de cada pedido SQL era 30 000 ms fixo no código. Numa base
 * grande, a leitura de produtos do onboarding histórico não cabe lá —
 * varre `StocksMov` da janela inteira — e a única saída era encurtar o
 * período, ou seja, deixar de fora produtos antigos para o import caber
 * no relógio. Trocar dados por conveniência.
 *
 * Estes testes fixam as três coisas que interessam: que o valor existe
 * como configuração, que continua a haver um tecto, e que o cliente SQL
 * usa o valor configurado em vez de um número escrito no código.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ_AGENT = path.resolve(AQUI, "..");

const ler = (rel: string) => readFileSync(path.join(RAIZ_AGENT, rel), "utf8");

test("o cliente SQL usa o valor do config, não um número fixo", () => {
  const fonte = ler("src/sql-client.ts");
  assert.match(
    fonte,
    /requestTimeout:\s*cfg\.sqlRequestTimeoutMs/,
    "sql-client.ts tem de ler o timeout do config",
  );
  assert.ok(
    !/requestTimeout:\s*\d/.test(fonte),
    "não pode restar um requestTimeout numérico no código",
  );
});

test("o config expõe a chave, com chão e tecto", () => {
  const fonte = ler("src/config.ts");
  assert.match(fonte, /sqlRequestTimeoutMs:\s*number/, "falta no tipo AgentConfig");
  assert.match(
    fonte,
    /ERP_SQLSERVER_REQUEST_TIMEOUT_MS/,
    "falta a leitura de sqlServer.requestTimeoutMs",
  );
  // O default tem de continuar a ser 30 s: quem não mexe em nada não
  // pode ver o comportamento mudar por baixo dos pés.
  assert.match(
    fonte,
    /"ERP_SQLSERVER_REQUEST_TIMEOUT_MS",\s*30_000,\s*5_000,\s*1_800_000/,
    "default 30 s, chão 5 s, tecto 30 min",
  );
});

test("o template de config documenta a chave", () => {
  const cfg = JSON.parse(ler("agent.config.example.json")) as {
    sqlServer: Record<string, unknown>;
  };
  assert.equal(
    cfg.sqlServer.requestTimeoutMs,
    30000,
    "o template tem de trazer o default explícito",
  );
  assert.ok(
    typeof cfg.sqlServer._requestTimeoutMs_doc === "string",
    "sem a nota explicativa, ninguém sabe quando mexer nisto",
  );
});

test("o âmbito histórico dos produtos não mudou", () => {
  // Este trabalho é sobre o relógio, não sobre que produtos entram. Se
  // o predicado mudar, o conjunto devolvido muda com ele — e isso teria
  // de ser uma decisão explícita, não um efeito secundário de mexer num
  // timeout.
  const fonte = ler("src/commands/bootstrap-upload.ts");
  assert.match(
    fonte,
    /const catalogoActivo = `s\.\[Retirado\] = 0 AND s\.\[Processa_Stocks\] <> 0`/,
    "o filtro de catálogo activo mudou",
  );
  assert.match(
    fonte,
    /EXISTS \(\s*\n\s*SELECT 1 FROM \[dbo\]\.\[StocksMov\] sm/,
    "o predicado histórico por StocksMov mudou",
  );
});
