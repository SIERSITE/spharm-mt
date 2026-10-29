/**
 * agent/src/classification-audit-comando.test.ts
 *
 * O COMANDO `classification-audit` ponta a ponta, com config SINTÉTICA e um pool falso (nenhum SQL Server, nenhuma rede):
 *   · exige agent.config.json (recusa com mensagem clara se faltar) e NUNCA o altera (hash + mtime antes/depois);
 *   · a ligação pede read-only (readOnlyIntent, READ UNCOMMITTED, appName); o pool falso REJEITA qualquer escrita;
 *   · zero chamadas HTTP/rede (fetch, http, https e net.connect rebentam se forem chamados);
 *   · zero aquisição do lock operacional: nenhum ficheiro de lock/run é criado; o grafo de imports do comando e do entry
 *     point dedicado não contém lock-pipeline, guarda-escrita, http-client nem nenhum pipeline;
 *   · NÃO está em COMANDOS_DE_ESCRITA (o cli.ts da rev98 nem o conhece);
 *   · sem segredos (valores-sentinela únicos) na consola, nos avisos, nos relatórios nem em nada do que o processo escreveu;
 *   · só escreve o relatório pedido em --out.
 *
 * Uso: npx tsx agent/src/classification-audit-comando.test.ts
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { erpFalso, type Cenario, type RowStocks } from "./classificacao-erp-falso.js";

// Os módulos built-in em CJS são mutáveis (o namespace ESM não): é aí que se instalam as armadilhas de rede.
const requireCjs = createRequire(import.meta.url);
const http = requireCjs("node:http") as typeof import("node:http");
const https = requireCjs("node:https") as typeof import("node:https");
const net = requireCjs("node:net") as typeof import("node:net");

let pass = 0;
let fail = 0;
const check = (c: boolean, l: string, d?: string) => {
  if (c) { pass++; console.log(`  [OK]    ${l}`); }
  else { fail++; console.log(`  [FALHA] ${l}${d ? `\n            ${d}` : ""}`); }
};

const SENTINELA = {
  host: "sentinel-host-7f3a.example.invalid",
  user: "sentinel_user_91c2",
  senha: "SENTINEL_PWD_5d8e!x",
  ingest: "SENTINEL_INGEST_KEY_aa11bb22cc33dd44",
  tenant: "sentinel-tenant-x9",
  farmacia: "Farmacia Sentinela Lda",
  base: "SPharmSentinela",
};
const TODOS_OS_SEGREDOS = Object.values(SENTINELA).filter((v) => v !== SENTINELA.base);

const sha = (f: string) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const todosOsFicheiros = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? todosOsFicheiros(path.join(dir, e.name)) : [path.join(dir, e.name)]));

const dados: RowStocks[] = Array.from({ length: 50 }, (_, i) => ({
  Codigo: 8000000 + i, CodigoID: i + 1,
  Servico: i % 10 === 0 ? 1 : 0, Etico: i % 3 === 0 ? 1 : 0, NETT: i % 5 === 0 ? 1 : 0, Generico: i % 4 === 0 ? 1 : 0,
  Processa_Stocks: i % 10 === 0 ? 0 : 1, Retirado: 0,
  // valor malicioso vindo do ERP: nunca pode voltar ao SQL
  "Tipo X": i === 1 ? "1'; DROP TABLE [dbo].[Stocks]; --" : i % 2 ? "A" : "B",
}));
const cenario: Cenario = {
  stocksCols: [
    ["CodigoID", "int", 4], ["Codigo", "int", 4], ["Servico", "bit", 1], ["Etico", "bit", 1], ["NETT", "bit", 1], ["Generico", "bit", 1],
    ["Processa_Stocks", "bit", 1], ["Retirado", "bit", 1], ["Tipo X", "varchar", 60],
  ],
  dados,
  tabelas: [{ tabela: "Atendimento", cols: [["Atendimento ID", "int", 4]], linhas: 999 }],
  baseDados: SENTINELA.base,
  versaoTexto: `Microsoft SQL Server 2008 R2 (SP3) - 10.50.6000.34 (X64) ${SENTINELA.host}`,
};

async function main() {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), "cls-cmd-"));
  const pasta = path.join(raiz, "diagnostico");
  fs.mkdirSync(pasta, { recursive: true });
  const cwdOriginal = process.cwd();
  process.chdir(pasta); // config.ts fixa JSON_CONFIG_PATH no import: tem de ser depois do chdir
  const pastaRun = path.join(raiz, "RUN_NAO_DEVE_EXISTIR");
  process.env.SPHARMMT_RUN_DIR = pastaRun;
  const cmd = await import("./commands/classification-audit.js");

  const configPath = path.join(pasta, "agent.config.json");
  const configSintetico = {
    saas: { endpoint: "https://saas.sentinel.invalid", tenantSlug: SENTINELA.tenant, ingestKey: SENTINELA.ingest, farmacia: SENTINELA.farmacia },
    sqlServer: { host: SENTINELA.host, port: 1433, database: SENTINELA.base, user: SENTINELA.user, password: SENTINELA.senha, encrypt: false, trustServerCertificate: true },
    options: { outputDir: "output" },
  };

  // ── captura de TUDO o que o processo escreve na consola ─────────────
  const capturado: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  const capturar = () => {
    for (const k of ["log", "warn", "error", "info"] as const) console[k] = (...a: unknown[]) => { capturado.push(a.map(String).join(" ")); };
  };
  const repor = () => Object.assign(console, orig);

  // ── proibido: rede ──────────────────────────────────────────────────
  const chamadasRede: string[] = [];
  const guardaRede = (nome: string) => () => { chamadasRede.push(nome); throw new Error(`REDE PROIBIDA: ${nome}`); };
  const origFetch = globalThis.fetch;
  const origHttp = { request: http.request, get: http.get };
  const origHttps = { request: https.request, get: https.get };
  const origConnect = net.connect;
  const origSockConnect = net.Socket.prototype.connect;
  (globalThis as { fetch: unknown }).fetch = guardaRede("fetch");
  (http as { request: unknown }).request = guardaRede("http.request");
  (http as { get: unknown }).get = guardaRede("http.get");
  (https as { request: unknown }).request = guardaRede("https.request");
  (https as { get: unknown }).get = guardaRede("https.get");
  (net as { connect: unknown }).connect = guardaRede("net.connect");
  (net.Socket.prototype as { connect: unknown }).connect = guardaRede("net.Socket.connect");

  // ── pool falso: ERP sintético; rejeita QUALQUER escrita ──────────────
  type Estado = { queries: string[]; escritasRejeitadas: number; timeoutMs: number | null; abertos: number; fechados: number };
  const montar = (c: Cenario) => {
    const erp = erpFalso(c);
    const st: Estado = { queries: [], escritasRejeitadas: 0, timeoutMs: null, abertos: 0, fechados: 0 };
    const abrirPool = (_cfg: unknown, timeoutMs: number) => {
      st.timeoutMs = timeoutMs;
      st.abertos++;
      return {
        connect: async () => undefined,
        close: async () => { st.fechados++; },
        request: () => ({
          query: async (sql: string) => {
            st.queries.push(sql);
            if (!/^\s*SELECT\b/i.test(sql) || /\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE|TRUNCATE|EXEC|EXECUTE|INTO)\b/i.test(sql.replace(/'(?:[^']|'')*'/g, "''").replace(/\[[^\]]*\]/g, "[]"))) {
              st.escritasRejeitadas++;
              throw new Error("ERP SOMENTE LEITURA: escrita rejeitada");
            }
            return { recordset: await erp.ler(sql) };
          },
        }),
      } as never;
    };
    return { erp, st, abrirPool };
  };

  try {
    // ═══ 1. Sem config ═════════════════════════════════════════════════
    console.log("\n=== 1. Sem agent.config.json: recusa com mensagem clara ===");
    {
      const m = montar(cenario);
      const erros: string[] = [];
      const logs: string[] = [];
      const rc = await cmd.classificationAudit({ argv: ["--out", path.join(pasta, "output", "r.json")], cwd: pasta, abrirPool: m.abrirPool, log: (l) => logs.push(l), erro: (l) => erros.push(l) });
      check(rc === 1, "exit code 1");
      check(erros.join("\n").includes("agent.config.json não encontrado") && erros.join("\n").includes("Install-ClassificationAudit.ps1"), "mensagem clara que diz o que fazer");
      check(m.st.abertos === 0 && m.st.queries.length === 0, "nenhuma ligação nem query");
      check(!fs.existsSync(path.join(pasta, "output")), "nenhum relatório criado");
      check(!fs.existsSync(configPath), "o agent.config.json NÃO foi criado");
    }

    // ═══ 2. --help sem config; argumentos inválidos ═══════════════════
    console.log("\n=== 2. --help, argumentos inválidos ===");
    {
      const logs: string[] = [];
      const rc = await cmd.classificationAudit({ argv: ["--help"], cwd: pasta, log: (l) => logs.push(l) });
      check(rc === 0 && logs.join("\n").includes("DIAGNÓSTICO") && logs.join("\n").includes("--cnps"), "--help funciona sem config e identifica o pacote de diagnóstico");
      const erros: string[] = [];
      check((await cmd.classificationAudit({ argv: ["--naoexiste"], cwd: pasta, erro: (l) => erros.push(l) })) === 2, "opção desconhecida: exit 2");
      check((await cmd.classificationAudit({ argv: ["--out", "x.txt"], cwd: pasta, erro: (l) => erros.push(l) })) === 2, "--out com extensão inválida: exit 2");
    }

    // ═══ 3. Execução completa ═════════════════════════════════════════
    console.log("\n=== 3. Execução completa com config sintética ===");
    fs.writeFileSync(configPath, JSON.stringify(configSintetico, null, 2), "utf8");
    const hashAntes = sha(configPath);
    const mtimeAntes = fs.statSync(configPath).mtimeMs;
    const cnpsFicheiro = path.join(pasta, "cnps.txt");
    fs.writeFileSync(cnpsFicheiro, "8000001\n8000010,9999999\n", "utf8");

    const m = montar(cenario);
    capturar();
    const logs: string[] = [];
    const erros: string[] = [];
    let rc: number;
    try {
      rc = await cmd.classificationAudit({
        argv: ["--out", path.join(".", "output", "auditoria-classificacao.json"), "--cnps", "8000002", "--cnps-ficheiro", cnpsFicheiro, "--timeout-segundos", "17"],
        cwd: pasta,
        abrirPool: m.abrirPool,
        log: (l) => logs.push(l),
        erro: (l) => erros.push(l),
      });
    } finally {
      repor();
    }
    const saidaConsola = [...logs, ...erros, ...capturado].join("\n");
    check(rc === 0, "exit code 0", erros.join(" | "));
    check(m.st.timeoutMs === 17_000 && m.st.abertos === 1 && m.st.fechados === 1, "pool aberto com o timeout pedido e fechado no fim");
    check(m.st.queries.length > 30 && m.st.queries.every((q) => /^\s*SELECT\b/i.test(q)), `${m.st.queries.length} queries, todas SELECT`);
    check(m.st.escritasRejeitadas === 0, "o pool falso (que rejeita escritas) nunca viu uma escrita");
    check(!m.st.queries.some((q) => /DROP TABLE/i.test(q.replace(/\[[^\]]*\]/g, "[]")) ), "o valor malicioso vindo do ERP nunca voltou ao SQL");
    check(logs.join("\n").includes("pacote de DIAGNÓSTICO (base rev98), modo read-only, não instalável") && logs.join("\n").includes("diag-"), "consola identifica o pacote como DIAGNÓSTICO (base rev98, diag-…)");
    check(!/rev99/i.test(saidaConsola), "a consola nunca diz rev99");
    check(chamadasRede.length === 0, "ZERO chamadas de rede (fetch/http/https/net)", chamadasRede.join(","));

    console.log("\n--- config intacto ---");
    check(sha(configPath) === hashAntes, "agent.config.json: hash idêntico antes/depois");
    check(fs.statSync(configPath).mtimeMs === mtimeAntes, "agent.config.json: data de modificação inalterada");

    console.log("\n--- só o relatório pedido foi escrito ---");
    const out = path.join(pasta, "output");
    const ficheirosSaida = fs.readdirSync(out).sort();
    check(ficheirosSaida.join() === "auditoria-classificacao.json,auditoria-classificacao.md", "output/ tem só auditoria-classificacao.json e .md", ficheirosSaida.join());
    const arvore = todosOsFicheiros(raiz).map((f) => path.relative(raiz, f).replace(/\\/g, "/")).sort();
    check(arvore.join() === ["diagnostico/agent.config.json", "diagnostico/cnps.txt", "diagnostico/output/auditoria-classificacao.json", "diagnostico/output/auditoria-classificacao.md"].sort().join(), "a árvore só tem o config, o ficheiro de CNPs (do teste) e o relatório", arvore.join(", "));

    console.log("\n--- zero aquisição do lock operacional ---");
    check(!fs.existsSync(pastaRun) && !fs.existsSync(path.join(pasta, "run")), "nenhuma pasta run/ criada (nem a apontada por SPHARMMT_RUN_DIR)");
    check(!arvore.some((f) => /lock|heartbeat|\.hb$|pipeline/i.test(f)), "nenhum ficheiro de lock/heartbeat/pipeline criado");
    const srcDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
    const fecho = (entrada: string): Set<string> => {
      const vistos = new Set<string>();
      const visita = (f: string) => {
        if (vistos.has(f) || !fs.existsSync(f)) return;
        vistos.add(f);
        for (const im of fs.readFileSync(f, "utf8").matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g)) {
          visita(path.resolve(path.dirname(f), im[1]!.replace(/\.js$/, ".ts")));
        }
      };
      visita(entrada);
      return vistos;
    };
    const base = (s: Set<string>) => [...s].map((f) => path.basename(f).replace(/\.ts$/, ""));
    const grafo = new Set([...base(fecho(path.join(srcDir, "audit-cli.ts"))), ...base(fecho(path.join(srcDir, "commands", "classification-audit.ts")))]);
    const proibidos = ["lock-pipeline", "guarda-escrita", "http-client", "daily-pipeline", "daily-sync", "daily-sync-runner", "bootstrap-upload", "full-sync", "retoma-pipeline", "subprocesso", "plano-diario", "catch-up", "cli", "estado-local", "identidade-processo"];
    check(proibidos.every((p) => !grafo.has(p)), "grafo de imports do entry point e do comando NÃO contém lock-pipeline, http-client, guarda-escrita nem pipelines", [...grafo].join(", "));
    check([...grafo].every((g) => ["audit-cli", "classification-audit", "classificacao-auditoria", "classificacao-base", "classificacao-mapeamento", "classificacao-mt", "classificacao-secoes", "classificacao-universos", "sql-somente-leitura", "sql-validador", "diagnostico-pacote", "config", "sql-client", "sql-erros", "politica-retry"].includes(g)), "…e só contém os 15 módulos esperados (10 da v1 + 5 da extensão read-only v2)", [...grafo].sort().join(", "));
    const cli = fs.readFileSync(path.join(srcDir, "cli.ts"), "utf8");
    const conjunto = /COMANDOS_DE_ESCRITA = new Set\(\[([\s\S]*?)\]\)/.exec(cli)?.[1] ?? "";
    check(conjunto.length > 0 && !/classification/.test(conjunto) && !/classification/.test(cli), "classification-audit NÃO está em COMANDOS_DE_ESCRITA (o cli.ts da rev98 nem o conhece)");

    console.log("\n--- sem segredos ---");
    const relatorios = ficheirosSaida.map((f) => fs.readFileSync(path.join(out, f), "utf8")).join("\n");
    const tudo = [saidaConsola, relatorios, ...m.st.queries].join("\n");
    for (const [nome, valor] of Object.entries(SENTINELA)) {
      if (nome === "base") continue;
      check(!tudo.includes(valor), `valor-sentinela «${nome}» ausente da consola, dos relatórios e das queries`);
    }
    check(!/sqlPassword|ingestKey|connection ?string|ERP_SQLSERVER_PASSWORD/i.test(relatorios), "relatórios sem nomes de campos de credenciais");
    check(relatorios.includes(SENTINELA.base), "o NOME da base consultada aparece (sem credenciais)");
    check(!fs.readFileSync(path.join(out, "auditoria-classificacao.md"), "utf8").includes("saas.sentinel.invalid"), "endpoint do SaaS ausente do relatório");
    const rel = JSON.parse(fs.readFileSync(path.join(out, "auditoria-classificacao.json"), "utf8"));
    check(rel.conhecidos.length === 4 && rel.conhecidos.filter((c: { encontrado: boolean }) => c.encontrado).length === 3, "--cnps e --cnps-ficheiro combinados (4 CNPs, 3 existem)");
    check(rel.cabecalho.pacote.diagnostico === true && rel.cabecalho.pacote.instalavel === false && rel.cabecalho.pacote.baseRev === "98", "cabeçalho do JSON: diagnóstico, não instalável, base rev98");

    // ═══ 3b. --cnps-mt-ficheiro e opções novas (v2) ═════════════════════
    console.log("\n=== 3b. --cnps-mt-ficheiro: lê só o ficheiro local; relatório sem o seu nome ===");
    {
      const nomeMt = `cnps-mt-${SENTINELA.tenant}.txt`;
      const ficheiroMt = path.join(pasta, nomeMt);
      fs.writeFileSync(ficheiroMt, ["8000001;1;0", "8000002;0;0", "8000003;1;1", "8000004", "lixo", "7777777;0;0"].join("\r\n"), "utf8");
      const h0 = sha(configPath);
      const mt0 = fs.statSync(configPath).mtimeMs;
      const mm = montar(cenario);
      const logsM: string[] = [];
      const errosM: string[] = [];
      capturado.length = 0;
      capturar();
      let rcM: number;
      try {
        rcM = await cmd.classificationAudit({
          argv: ["--out", path.join(".", "output-mt", "r.json"), "--cnps-mt-ficheiro", ficheiroMt, "--max-pares", "7", "--max-tabelas", "30", "--max-linhas-historico", "1000"],
          cwd: pasta,
          abrirPool: mm.abrirPool,
          log: (l) => logsM.push(l),
          erro: (l) => errosM.push(l),
        });
      } finally {
        repor();
      }
      const consolaM = [...logsM, ...errosM, ...capturado].join("\n");
      check(rcM === 0, "exit code 0 com --cnps-mt-ficheiro", errosM.join(" | "));
      check(consolaM.includes("Ficheiro MT: 5 CNPs únicos (1 linhas inválidas") && consolaM.includes("Universo MT: 5 CNPs · encontrados no ERP: 4 · não encontrados: 1"), "consola resume o ficheiro MT (sem o seu nome) e a cobertura", consolaM.split("\n").filter((l) => /MT/.test(l)).join(" | "));
      check(!consolaM.includes(nomeMt), "o nome do ficheiro MT não aparece na consola");
      const outM = path.join(pasta, "output-mt");
      const relM = fs.readFileSync(path.join(outM, "r.json"), "utf8");
      const mdM = fs.readFileSync(path.join(outM, "r.md"), "utf8");
      check(!relM.includes(SENTINELA.tenant) && !mdM.includes(SENTINELA.tenant) && !relM.includes(nomeMt) && !mdM.includes(nomeMt), "o nome do ficheiro MT (que contém o tenant) não está no JSON nem no Markdown");
      const jM = JSON.parse(relM);
      check(jM.universos.coberturaMt.calculado === true && jM.universos.coberturaMt.encontradosNoErp === 4 && jM.universos.coberturaMt.naoEncontradosNoErp === 1, "JSON: cobertura MT calculada (4 encontrados, 1 não encontrado)");
      check(jM.universos.existenteNoMt.ficheiro.invalidas === 1 && jM.universos.existenteNoMt.ficheiro.comFlag === 4 && !("entradas" in jM.universos.existenteNoMt.ficheiro), "JSON: resumo do ficheiro (sem a lista de CNPs)");
      check(mm.st.queries.every((q) => /^\s*SELECT\b/i.test(q)) && mm.st.escritasRejeitadas === 0 && mm.st.queries.some((q) => / IN \(8000002, 7777777\)/.test(q)), "queries todas SELECT; o bloco MT usa IN-list numérica");
      check(jM.cruzadas.length <= 7 && jM.tabelasCandidatas.length <= 30, "--max-pares e --max-tabelas respeitados");
      check(chamadasRede.length === 0, "ZERO chamadas de rede com o ficheiro MT");
      check(sha(configPath) === h0 && fs.statSync(configPath).mtimeMs === mt0, "agent.config.json intacto (hash e mtime)");
      check(!fs.existsSync(pastaRun) && !fs.existsSync(path.join(pasta, "run")), "nenhum lock/run criado");
      check(fs.readdirSync(outM).sort().join() === "r.json,r.md", "só o relatório pedido foi escrito");
      const tudoM = [consolaM, relM, mdM, ...mm.st.queries].join("\n");
      check(TODOS_OS_SEGREDOS.every((v) => !tudoM.includes(v)), "valores-sentinela ausentes da consola, dos relatórios e das queries (também com --cnps-mt-ficheiro)");

      // sem o ficheiro (argumento ausente): universos MT «não calculado», exit 0 (já coberto em 3) — aqui: ficheiro inexistente / inválido
      const e1: string[] = [];
      const m1 = montar(cenario);
      const rc1 = await cmd.classificationAudit({ argv: ["--cnps-mt-ficheiro", path.join(pasta, "nao-existe.txt")], cwd: pasta, abrirPool: m1.abrirPool, erro: (l) => e1.push(l), log: () => undefined });
      check(rc1 === 2 && e1.join("\n").includes("--cnps-mt-ficheiro") && m1.st.abertos === 0, "ficheiro MT inexistente: exit 2, sem ligar ao ERP");
      fs.writeFileSync(ficheiroMt, "abc\n12x\n;;\n", "utf8");
      const e2: string[] = [];
      const m2 = montar(cenario);
      const rc2 = await cmd.classificationAudit({ argv: ["--cnps-mt-ficheiro", ficheiroMt], cwd: pasta, abrirPool: m2.abrirPool, erro: (l) => e2.push(l), log: () => undefined });
      check(rc2 === 2 && e2.join("\n").includes("nenhuma linha válida") && m2.st.abertos === 0 && !e2.join("\n").includes(nomeMt), "ficheiro MT sem linhas válidas: exit 2, mensagem de formato, sem ligar ao ERP");
      const l3: string[] = [];
      const rc3 = await cmd.classificationAudit({ argv: ["--help"], cwd: pasta, log: (l) => l3.push(l) });
      const ajuda = l3.join("\n");
      check(rc3 === 0 && ajuda.includes("--cnps-mt-ficheiro") && ajuda.includes("--max-pares") && ajuda.includes("--max-tabelas") && ajuda.includes("não chama o MT"), "--help documenta --cnps-mt-ficheiro, --max-pares e --max-tabelas");
      fs.rmSync(outM, { recursive: true, force: true });
      fs.rmSync(ficheiroMt, { force: true });
    }

    // ═══ 4. Config inválido ═══════════════════════════════════════════
    console.log("\n=== 4. Config inválido / incompleto ===");
    {
      const hashPre = sha(configPath);
      // o loadConfig exporta o config para process.env: limpar para o teste ver só o ficheiro
      for (const k of Object.keys(process.env)) if (/^(ERP_SQLSERVER_|SPHARMMT_(ENDPOINT|TENANT|INGEST|FARMACIA))/.test(k)) delete process.env[k];
      fs.writeFileSync(configPath, JSON.stringify({ sqlServer: { host: SENTINELA.host, password: SENTINELA.senha } }), "utf8");
      const h2 = sha(configPath);
      const erros2: string[] = [];
      capturado.length = 0;
      capturar();
      let rc2: number;
      try { rc2 = await cmd.classificationAudit({ argv: [], cwd: pasta, abrirPool: montar(cenario).abrirPool, erro: (l) => erros2.push(l), log: () => undefined }); } finally { repor(); }
      check(rc2 === 1 && erros2.join("\n").includes("inválido"), "config incompleto: exit 1 com mensagem clara");
      check(![...erros2, ...capturado].join("\n").includes(SENTINELA.senha) && ![...erros2, ...capturado].join("\n").includes(SENTINELA.host), "a mensagem de erro não mostra os valores do config");
      check(sha(configPath) === h2, "o config inválido também não é alterado");
      fs.writeFileSync(configPath, JSON.stringify(configSintetico, null, 2), "utf8");
      check(sha(configPath) === hashPre, "(config sintético restaurado)");
    }

    // ═══ 5. Falha do ERP ══════════════════════════════════════════════
    console.log("\n=== 5. Falha do SQL: mensagem redigida ===");
    {
      const falha = montar({ ...cenario, falhaSe: { contem: "@@VERSION", mensagem: `Login failed for user '${SENTINELA.user}' on ${SENTINELA.host} password=${SENTINELA.senha}` } });
      const erros3: string[] = [];
      const logs3: string[] = [];
      const rc3 = await cmd.classificationAudit({ argv: ["--out", path.join(pasta, "out2", "r.json")], cwd: pasta, abrirPool: falha.abrirPool, erro: (l) => erros3.push(l), log: (l) => logs3.push(l) });
      const t3 = [...erros3, ...logs3, fs.existsSync(path.join(pasta, "out2")) ? fs.readdirSync(path.join(pasta, "out2")).map((f) => fs.readFileSync(path.join(pasta, "out2", f), "utf8")).join("\n") : ""].join("\n");
      check(rc3 === 0 || rc3 === 1, "termina de forma controlada");
      check(!t3.includes(SENTINELA.senha) && !t3.includes(SENTINELA.host) && !t3.includes(SENTINELA.user), "erro do SQL redigido: sem utilizador, anfitrião nem palavra-passe", t3.slice(0, 300));
    }

    console.log("\n=== 5b. Falha de LIGAÇÃO: sem texto de retoma do pipeline e sem segredos ===");
    {
      const st = { tentativas: 0 };
      const abrirFalha = () => {
        st.tentativas++;
        return {
          connect: async () => { throw Object.assign(new Error(`Failed to connect to ${SENTINELA.host}:1433 - password=${SENTINELA.senha} user=${SENTINELA.user}`), { code: "ESOCKET" }); },
          close: async () => undefined,
          request: () => { throw new Error("não devia pedir nada"); },
        } as never;
      };
      const erros4: string[] = [];
      capturado.length = 0;
      capturar();
      let rc4: number;
      try {
        // sem esperas entre tentativas: SPHARMMT_SQL_RETRY_ESPERAS_MS=0 (lido pelo withPool real)
        process.env.SPHARMMT_SQL_RETRY_ESPERAS_MS = "0";
        rc4 = await cmd.classificationAudit({ argv: ["--out", path.join(pasta, "out3", "r.json")], cwd: pasta, abrirPool: abrirFalha, erro: (l) => erros4.push(l), log: () => undefined });
      } finally {
        delete process.env.SPHARMMT_SQL_RETRY_ESPERAS_MS;
        repor();
      }
      const t4 = [...erros4, ...capturado].join("\n");
      check(rc4 === 1 && t4.includes("Auditoria falhou"), "ligação falhada: exit 1 e «Auditoria falhou»", t4.slice(0, 200));
      check(!/retoma|catch-up/i.test(t4), "nenhuma referência a «dia pendente / retoma / catch-up» do pipeline");
      check(!t4.includes(SENTINELA.senha) && !t4.includes(SENTINELA.host) && !t4.includes(SENTINELA.user), "mensagens da ligação falhada redigidas");
      check(!fs.existsSync(path.join(pasta, "out3")), "sem ligação não há relatório");
    }

    // ═══ 6. Ligação read-only ═════════════════════════════════════════
    console.log("\n=== 6. Ligação: ApplicationIntent=ReadOnly, READ UNCOMMITTED, appName ===");
    const { loadConfig } = await import("./config.js");
    const cfg = loadConfig("sql");
    const pool = cmd.abrirPoolSoLeitura(cfg, 7_000);
    const opcoes = (pool as unknown as { config: { options: Record<string, unknown> } }).config.options;
    check(opcoes.readOnlyIntent === true, "readOnlyIntent = true (ApplicationIntent=ReadOnly)");
    check(opcoes.isolationLevel === 1, "isolationLevel = READ_UNCOMMITTED (1)");
    check(opcoes.appName === "SPharmMT-Diagnostico-ClassificationAudit", "appName identifica o diagnóstico nas ferramentas do DBA");
    check(opcoes.requestTimeout === 7_000 && opcoes.encrypt === false && opcoes.trustServerCertificate === true, "timeout aplicado e opções de segurança da instalação preservadas");
    check(cmd.depsReais([]).abrirPool === cmd.abrirPoolSoLeitura, "o comando usa SEMPRE abrirPoolSoLeitura (nunca o openPool simples)");
    check(chamadasRede.length === 0, "construir o pool não abriu rede");
  } finally {
    repor();
    (globalThis as { fetch: unknown }).fetch = origFetch;
    Object.assign(http, origHttp);
    Object.assign(https, origHttps);
    (net as { connect: unknown }).connect = origConnect;
    (net.Socket.prototype as { connect: unknown }).connect = origSockConnect;
    delete process.env.SPHARMMT_RUN_DIR;
    process.chdir(cwdOriginal);
    fs.rmSync(raiz, { recursive: true, force: true });
  }

  console.log(`\n${pass} ok, ${fail} falhas`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
