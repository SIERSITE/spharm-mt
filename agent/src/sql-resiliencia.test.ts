/**
 * agent/src/sql-resiliencia.test.ts
 *
 * Falhas do SQL Server: o que se repete (transitório) e o que nunca se repete (permanente). Usa as CLASSES REAIS da
 * biblioteca (`mssql`: ConnectionError/RequestError) e uma ligação REAL a uma porta fechada, sem depender de um SQL Server.
 *
 * Uso: npx tsx agent/src/sql-resiliencia.test.ts
 */
import sql from "mssql";
import { classificarErroSql, esperasSqlDoAmbiente } from "./sql-erros.js";
import { withPool, type SqlPool } from "./sql-client.js";
import { eFalhaTransitoria, houveFalhaTransitoriaDefinitiva, repor, ErroDeConfiguracao } from "./politica-retry.js";
import { planearDiasDoPipeline } from "./plano-diario.js";
import { listarPendentes, registarPendente } from "./estado-local.js";
import { correrComRetoma } from "./retoma-pipeline.js";
import type { AgentConfig } from "./config.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let ok = 0;
let ko = 0;
const check = (c: boolean, label: string, det?: string) => {
  if (c) { ok++; console.log(`  [OK]    ${label}`); }
  else { ko++; console.log(`  [FALHA] ${label}${det ? `\n            ${det}` : ""}`); }
};
const secao = (t: string) => console.log(`\n${t}`);

const cfg = { sqlHost: "127.0.0.1", sqlPort: 1, sqlDatabase: "x", sqlUser: "u", sqlPassword: "SEGREDO-SQL-123456", sqlEncrypt: false, sqlTrustCert: true, sqlRequestTimeoutMs: 1000 } as unknown as AgentConfig;

type Cod = ConstructorParameters<typeof sql.ConnectionError>[1];
const conn = (msg: string, code: string, extra: Record<string, unknown> = {}) => Object.assign(new sql.ConnectionError(msg, code as Cod), extra);
const req = (msg: string, number: number, code = "EREQUEST") => Object.assign(new sql.RequestError(msg, code as Cod), { number });

/** Pool falso: `connect()` e a função do cliente decidem o que acontece em cada tentativa. */
function fabricaPools(roteiro: Array<(() => Promise<void>) | "ok">) {
  let n = 0;
  const fechados: number[] = [];
  return {
    abrir: (): SqlPool => {
      const i = n++;
      return {
        connect: async () => { const p = roteiro[Math.min(i, roteiro.length - 1)]; if (p && p !== "ok") await p(); },
        close: async () => { fechados.push(i); },
      } as unknown as SqlPool;
    },
    aberturas: () => n,
    fechados,
  };
}

async function main() {
  secao("A · classificação: TRANSITÓRIAS (classes reais do mssql)");
  const trans: Array<[string, unknown]> = [
    ["ETIMEOUT — timeout ao estabelecer a ligação", conn("Failed to connect to srv:1433 in 15000ms", "ETIMEOUT")],
    ["ETIMEOUT — timeout do pedido", Object.assign(new sql.RequestError("Timeout: Request failed to complete in 30000ms", "ETIMEOUT"), {})],
    ["ESOCKET — socket falhou", conn("Failed to connect to srv:1433 - read ECONNRESET", "ESOCKET")],
    ["ESOCKET — ligação recusada (serviço a reiniciar)", conn("Failed to connect to srv:1433 - connect ECONNREFUSED 10.0.0.5:1433", "ESOCKET")],
    ["ECONNCLOSED — Connection is closed.", conn("Connection is closed.", "ECONNCLOSED")],
    ["ligação terminada/reset (originalError)", conn("Connection lost", "ESOCKET", { originalError: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) })],
    ["rede temporária — host inacessível", conn("x", "ESOCKET", { originalError: Object.assign(new Error("connect EHOSTUNREACH"), { code: "EHOSTUNREACH" }) })],
    ["DNS temporário (EAI_AGAIN)", conn("getaddrinfo EAI_AGAIN srv", "ESOCKET", { originalError: Object.assign(new Error("getaddrinfo EAI_AGAIN srv"), { code: "EAI_AGAIN" }) })],
    ["pool indisponível (a fechar)", new Error("Pool is closing")],
    ["pool indisponível (ligação ainda não aberta)", conn("Connection not yet open.", "ENOTOPEN")],
    ["deadlock (1205)", req("Transaction was deadlocked", 1205)],
    ["SQL Server a desligar (6005)", req("SQL Server is shutting down", 6005)],
    ["Winsock 10054", req("An existing connection was forcibly closed", 10054)],
  ];
  for (const [nome, e] of trans) check(classificarErroSql(e).transitoria === true, `transitória: ${nome}`, JSON.stringify(classificarErroSql(e)));

  secao("B · classificação: PERMANENTES (nunca se repetem)");
  const perm: Array<[string, unknown]> = [
    ["credenciais inválidas (ELOGIN 18456)", conn("Login failed for user 'spharm_readonly'.", "ELOGIN", { originalError: Object.assign(new Error("Login failed for user 'spharm_readonly'."), { number: 18456 }) })],
    ["credenciais inválidas (só a mensagem)", conn("Login failed for user 'x'.", "ELOGIN")],
    ["base inexistente (4060)", req("Cannot open database \"Spharm\" requested by the login. The login failed.", 4060)],
    ["tabela inexistente (208)", req("Invalid object name 'dbo.StocksMov'.", 208)],
    ["coluna inexistente (207)", req("Invalid column name 'GamaFabricanteID'.", 207)],
    ["erro de sintaxe (102)", req("Incorrect syntax near 'FROM'.", 102)],
    ["permissão negada (229)", req("The SELECT permission was denied on the object 'Stocks'", 229)],
    ["nome do servidor errado (ENOTFOUND)", conn("Failed to connect to srvx:1433 - getaddrinfo ENOTFOUND srvx", "ESOCKET")],
    ["certificado/encrypt mal configurado", conn("Failed to connect to srv:1433 - self signed certificate", "ESOCKET")],
    ["configuração inválida", new ErroDeConfiguracao("sqlHost em falta")],
    ["erro desconhecido", new Error("qualquer coisa inesperada")],
    ["EREQUEST genérico", req("Conversion failed when converting the varchar value", 245)],
  ];
  for (const [nome, e] of perm) check(classificarErroSql(e).transitoria === false, `permanente: ${nome}`, JSON.stringify(classificarErroSql(e)));
  check(esperasSqlDoAmbiente({}).join() === "5000,20000" && esperasSqlDoAmbiente({ SPHARMMT_SQL_RETRY_ESPERAS_MS: "" }).length === 0 && esperasSqlDoAmbiente({ SPHARMMT_SQL_RETRY_ESPERAS_MS: "lixo" }).join() === "5000,20000", "política SQL: defaults 5 s + 20 s; configurável; inválido → defaults");

  secao("C · withPool: retentativas só para o transitório");
  {
    repor();
    const esperas: number[] = [];
    const logs: string[] = [];
    const base = { dormir: async (ms: number) => { esperas.push(ms); }, log: (l: string) => logs.push(l) };

    // timeout seguido de sucesso
    const f1 = fabricaPools([async () => { throw conn("Failed to connect to srv:1433 in 15000ms", "ETIMEOUT"); }, "ok"]);
    const r1 = await withPool(cfg, async () => "dados", { ...base, abrirPool: f1.abrir });
    check(r1 === "dados" && f1.aberturas() === 2 && esperas.join() === "5000", "timeout seguido de sucesso: 2 ligações, espera de 5 s, pool novo");
    check(f1.fechados.includes(0) && f1.fechados.includes(1), "o pool falhado e o final são fechados (nada fica pendurado)");

    // socket fechado a meio da leitura seguido de sucesso (a função do cliente falha na 1.ª)
    esperas.length = 0;
    let chamadas = 0;
    const f2 = fabricaPools(["ok"]);
    const r2 = await withPool(cfg, async () => { if (++chamadas === 1) throw conn("Connection is closed.", "ECONNCLOSED"); return "lido"; }, { ...base, abrirPool: f2.abrir });
    check(r2 === "lido" && f2.aberturas() === 2, "socket fechado a meio + sucesso na repetição (pool recriado)");

    // esgotamento
    esperas.length = 0;
    const f3 = fabricaPools([async () => { throw conn("Failed to connect", "ETIMEOUT"); }]);
    let erro: unknown;
    try { await withPool(cfg, async () => 1, { ...base, abrirPool: f3.abrir }); } catch (e) { erro = e; }
    check(!!erro && f3.aberturas() === 3 && esperas.join() === "5000,20000", "esgotamento: 3 ligações no total (1 + 2 retentativas) e nada mais");
    check(eFalhaTransitoria(erro) && houveFalhaTransitoriaDefinitiva(), "esgotado: o erro sai marcado como TRANSITÓRIO (ativa a retoma do pipeline) e o comando sai com 75");
    check(logs.some((l) => /falha transitória persistente após 3\/3/.test(l)), "log da falha persistente");

    // login inválido: sem retentativas
    repor();
    esperas.length = 0;
    const f4 = fabricaPools([async () => { throw conn("Login failed for user 'u'.", "ELOGIN", { originalError: Object.assign(new Error("x"), { number: 18456 }) }); }]);
    let e4: unknown;
    const t0 = Date.now();
    try { await withPool(cfg, async () => 1, { ...base, abrirPool: f4.abrir }); } catch (e) { e4 = e; }
    check(f4.aberturas() === 1 && esperas.length === 0 && Date.now() - t0 < 1000 && !eFalhaTransitoria(e4) && !houveFalhaTransitoriaDefinitiva(), "login inválido: 1 ligação, nenhuma espera, não transitório");

    // coluna inexistente (erro dentro da função): sem retentativas
    esperas.length = 0;
    const f5 = fabricaPools(["ok"]);
    let e5: unknown;
    try { await withPool(cfg, async () => { throw req("Invalid column name 'X'.", 207); }, { ...base, abrirPool: f5.abrir }); } catch (e) { e5 = e; }
    check(f5.aberturas() === 1 && esperas.length === 0 && (e5 as { number?: number }).number === 207, "coluna inexistente: sem retentativas, o erro original sobe intacto");

    // erro do SaaS dentro da função não é «SQL transitório»: não se repete aqui
    esperas.length = 0;
    const f6 = fabricaPools(["ok"]);
    let n6 = 0;
    try { await withPool(cfg, async () => { n6++; throw Object.assign(new Error("SaaS POST … — falha de rede: fetch failed"), { transitoria: true }); }, { ...base, abrirPool: f6.abrir }); } catch { /* esperado */ }
    check(n6 === 1 && esperas.length === 0, "uma falha do SaaS (já tratada pelo cliente HTTP) não é repetida pelo withPool");

    // a palavra-passe do SQL nunca aparece nos logs
    check(!logs.join("\n").includes("SEGREDO-SQL-123456"), "a palavra-passe do SQL não aparece nos logs");
    // sem esperas = sem retry
    const f7 = fabricaPools([async () => { throw conn("x", "ETIMEOUT"); }]);
    let e7: unknown;
    try { await withPool(cfg, async () => 1, { ...base, esperasMs: [], abrirPool: f7.abrir }); } catch (e) { e7 = e; }
    check(f7.aberturas() === 1 && !!e7, "esperasMs=[] desliga as retentativas SQL");
  }

  secao("D · biblioteca REAL: ligação a uma porta fechada");
  {
    repor();
    const logs: string[] = [];
    let erro: unknown;
    try { await withPool(cfg, async () => 1, { esperasMs: [10, 10], dormir: async () => undefined, log: (l) => logs.push(l) }); } catch (e) { erro = e; }
    const c = classificarErroSql(erro);
    check(!!erro && c.transitoria && eFalhaTransitoria(erro), `SQL Server indisponível (ligação recusada, erro real do mssql: code=${(erro as { code?: string }).code}) ⇒ transitório e retomável`, JSON.stringify(c));
    check(logs.filter((l) => /nova ligação/.test(l)).length === 2, "2 retentativas feitas antes de desistir");
    repor();
  }

  secao("E · SQL Server em baixo: retoma do pipeline e recuperação automática no arranque seguinte");
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spharm-sql-"));
    const transit = conn("Failed to connect to srv:1433 in 15000ms", "ETIMEOUT");
    Object.assign(transit, { transitoria: true });
    const logs: string[] = [];
    const esperas: number[] = [];
    const r = await correrComRetoma({
      dia: "2026-10-14", totalTentativas: 4, esperaMs: 900_000, log: (l) => logs.push(l),
      dormir: async (ms) => { esperas.push(ms); },
      correr: async () => ({ rc: 1, status: "ERROR", transitoria: eFalhaTransitoria(transit), erro: transit.message, passoFalhado: "daily-sync" }),
      antesDeEsperar: (res, _i, retomaEm) => { registarPendente(dir, { dia: "2026-10-14", estado: res.status, causa: res.erro ?? "", retomaPrevistaEm: retomaEm }); },
    });
    check(r.tentativas === 4 && esperas.length === 3 && r.final.status === "ERROR", "SQL transitório persistente ⇒ 4 tentativas do pipeline (3 esperas de 15 min) e falha definitiva da execução");
    registarPendente(dir, { dia: "2026-10-14", estado: "ERROR", causa: r.final.erro ?? "" });
    const plano = planearDiasDoPipeline({ ontem: "2026-10-15", diasOkNoSaas: ["2026-10-13"], pendentesLocais: listarPendentes(dir), maxDias: 7 });
    check(JSON.stringify(plano.dias) === JSON.stringify(["2026-10-14", "2026-10-15"]), "no arranque seguinte o dia 14/10 é recuperado ANTES do dia normal (o SaaS não o tem como OK)");
    const plano2 = planearDiasDoPipeline({ ontem: "2026-10-15", diasOkNoSaas: null, pendentesLocais: listarPendentes(dir), maxDias: 7 });
    check(JSON.stringify(plano2.dias) === JSON.stringify(["2026-10-14", "2026-10-15"]), "…mesmo que o SaaS não consiga informar (pista local)");
    // erro permanente de SQL: sem retoma
    const perm = req("Invalid column name 'GamaFabricanteID'.", 207);
    const r2 = await correrComRetoma({
      dia: "2026-10-14", totalTentativas: 4, esperaMs: 900_000, log: () => undefined, dormir: async (ms) => { esperas.push(ms); },
      correr: async () => ({ rc: 1, status: "ERROR", transitoria: eFalhaTransitoria(perm) || classificarErroSql(perm).transitoria, erro: perm.message, passoFalhado: "daily-sync" }),
    });
    check(r2.tentativas === 1, "coluna inexistente: UMA tentativa — não vira um ciclo de horas (o dia fica pendente para o catch-up)");
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${ok} OK, ${ko} falhas`);
  process.exit(ko === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
