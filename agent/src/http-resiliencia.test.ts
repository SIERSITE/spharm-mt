/**
 * agent/src/http-resiliencia.test.ts
 *
 * Retentativas do cliente HTTP — contra um servidor HTTP LOCAL (sem Internet), que consegue:
 *   · aceitar o pedido, «gravar» e fechar a ligação ANTES de devolver a resposta (o incidente de 15/10/2026);
 *   · fechar a ligação sem sequer ler o pedido;
 *   · devolver sequências de estados (com Retry-After);
 *   · demorar a responder (timeout);
 *   · contabilizar pedidos e provar idempotência (armazém chaveado pelo corpo).
 *
 * Uso: npx tsx agent/src/http-resiliencia.test.ts
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { SaasApiError, SaasClient, SaasNetworkError } from "./http-client.js";
import {
  POLITICA_PADRAO,
  calcularEspera,
  classificarErroDeRede,
  classificarStatus,
  houveFalhaTransitoriaDefinitiva,
  mesclarPolitica,
  parseRetryAfter,
  politicaDoAmbiente,
  redigir,
  repor,
  type PoliticaRetry,
} from "./politica-retry.js";

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${label}`); }
  else { ko++; console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`); }
};
const secao = (t: string) => console.log(`\n${t}`);

type Passo =
  | { acao: "responder"; status: number; json?: unknown; texto?: string; cabecalhos?: Record<string, string> }
  | { acao: "gravar-e-cair"; json?: unknown } // processa (grava) e destrói a ligação sem responder
  | { acao: "cair-sem-ler" } // fecha a ligação logo à chegada, sem ler nem gravar
  | { acao: "truncar" } // grava, envia cabeçalhos 200 e metade do corpo, e destrói
  | { acao: "demorar"; ms: number; gravar?: boolean };

type Servidor = {
  url: string;
  pedidos: Array<{ metodo: string; caminho: string; corpo: string; cabecalhos: http.IncomingHttpHeaders }>;
  /** «Base de dados» idempotente: chave = sha256 do corpo. */
  gravados: Map<string, number>;
  definirSequencia: (caminho: string, passos: Passo[]) => void;
  fechar: () => Promise<void>;
};

async function iniciarServidor(): Promise<Servidor> {
  const sequencias = new Map<string, Passo[]>();
  const pedidos: Servidor["pedidos"] = [];
  const gravados = new Map<string, number>();
  const server = http.createServer((req, res) => {
    const partes: Buffer[] = [];
    req.on("data", (d) => partes.push(d));
    req.on("end", () => {
      const corpo = Buffer.concat(partes).toString("utf8");
      const caminho = (req.url ?? "").split("?")[0]!;
      pedidos.push({ metodo: req.method ?? "", caminho, corpo, cabecalhos: req.headers });
      const gravar = () => {
        const k = createHash("sha256").update(corpo).digest("hex");
        gravados.set(k, (gravados.get(k) ?? 0) + 1);
      };
      const fila = sequencias.get(caminho) ?? [];
      const passo: Passo = fila.length > 0 ? fila.shift()! : { acao: "responder", status: 200, json: { ok: true, accepted: 1, upserted: 1, skipped: [], errors: [], durationMs: 1 } };
      if (passo.acao === "responder") {
        if (passo.status >= 200 && passo.status < 300) gravar();
        res.writeHead(passo.status, { "content-type": "application/json", ...(passo.cabecalhos ?? {}) });
        res.end(passo.texto ?? JSON.stringify(passo.json ?? { ok: true }));
      } else if (passo.acao === "gravar-e-cair") {
        gravar();
        req.socket.destroy();
      } else if (passo.acao === "cair-sem-ler") {
        req.socket.destroy();
      } else if (passo.acao === "truncar") {
        gravar();
        res.writeHead(200, { "content-type": "application/json", "content-length": "500" });
        res.write('{"ok":true,"acc');
        setTimeout(() => req.socket.destroy(), 20);
      } else if (passo.acao === "demorar") {
        if (passo.gravar) gravar();
        setTimeout(() => {
          try { res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}'); } catch { /* ligação já fechada */ }
        }, passo.ms);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    pedidos,
    gravados,
    definirSequencia: (c, p) => sequencias.set(c, [...p]),
    fechar: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

const CHAVE = "chave-secreta-ABCDEF-123456";
const BATCH = { farmaciaId: "farm1", items: [{ cnp: 1, designacao: "ARTIGO" }] };
const URL_PRODUTOS = "/api/ingest/v1/bootstrap/products";

const POLITICA_TESTE: PoliticaRetry = { esperasMs: [5_000, 15_000, 30_000, 60_000], jitter: 0, retryAfterMaxMs: 120_000, timeoutMs: 300 };

function cliente(srv: Servidor, over: Partial<PoliticaRetry> = {}) {
  const esperas: number[] = [];
  const linhas: string[] = [];
  const c = new SaasClient(
    { saasEndpoint: srv.url, tenantSlug: "silveira", ingestKey: CHAVE, agentVersion: "rev98-teste" },
    {
      politica: { ...POLITICA_TESTE, ...over },
      dormir: async (ms) => { esperas.push(ms); },
      aleatorio: () => 0,
      log: (l) => linhas.push(l),
    },
  );
  c.definirContexto({ dia: "2026-10-14", etapa: "produtos" });
  return { c, esperas, linhas };
}

async function main() {
  // ═══ A · política pura ═══
  secao("A · política (pura)");
  check(
    JSON.stringify(POLITICA_PADRAO.esperasMs) === "[5000,15000,30000,60000]" && POLITICA_PADRAO.jitter > 0 && POLITICA_PADRAO.timeoutMs === 30_000,
    "padrão: original + 4 retentativas (5/15/30/60 s), jitter e timeout explícitos",
  );
  for (const s of [408, 425, 429, 502, 503, 504]) check(classificarStatus(s).retentavel, `HTTP ${s} é retentável`);
  for (const s of [400, 401, 403, 404, 409, 422, 500]) check(!classificarStatus(s).retentavel, `HTTP ${s} NÃO é retentável`);
  check(classificarErroDeRede(new TypeError("fetch failed")).retentavel, "fetch failed é retentável");
  check(classificarErroDeRede(Object.assign(new Error("x"), { name: "AbortError" })).tipo === "timeout", "AbortError = timeout");
  check(classificarErroDeRede(new TypeError("fetch failed", { cause: Object.assign(new Error("c"), { code: "ECONNRESET" }) })).ambigua, "ECONNRESET é ambíguo");
  const dns = classificarErroDeRede(new TypeError("fetch failed", { cause: Object.assign(new Error("c"), { code: "EAI_AGAIN" }) }));
  check(dns.tipo === "dns_temporario" && dns.retentavel && !dns.ambigua, "DNS temporário (EAI_AGAIN): retentável e NÃO ambíguo");
  check(parseRetryAfter("7", 0) === 7000 && parseRetryAfter(null, 0) === null && parseRetryAfter("lixo", 0) === null, "Retry-After em segundos / ausente / ilegível");
  check(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)! >= 5_000 && parseRetryAfter(new Date(10_000).toUTCString(), 4_000)! <= 6_000, "Retry-After em data HTTP");
  const p = mesclarPolitica({ esperasMs: [1000], jitter: 0 });
  check(calcularEspera(1, p, 20_000, () => 0.5) === 20_000, "Retry-After razoável prevalece");
  check(calcularEspera(1, p, 999_000, () => 0) === 1000, "Retry-After exagerado é ignorado");
  check(calcularEspera(1, mesclarPolitica({ esperasMs: [10_000], jitter: 0.2 }), 2_000, () => 1) === 12_000, "jitter só se soma (nunca encurta) e Retry-After pequeno não encurta a espera");
  check(politicaDoAmbiente({ SPHARMMT_HTTP_RETRY_ESPERAS_MS: "1000,2000" }).esperasMs.length === 2 && politicaDoAmbiente({}).esperasMs.length === 4, "configurável por ambiente, com defaults seguros");
  check(politicaDoAmbiente({ SPHARMMT_HTTP_RETRY_ESPERAS_MS: "lixo,1" }).esperasMs.length === 4, "valor inválido é ignorado (nunca parte o agent)");

  const srv = await iniciarServidor();
  try {
    // ═══ B · pedidos ═══
    secao("B · pedido concluído à primeira (comportamento normal inalterado)");
    {
      repor();
      const { c, esperas, linhas } = cliente(srv);
      const r = await c.bootstrapProducts(BATCH, undefined, { lote: 1 });
      check(r.ok === true && srv.pedidos.length === 1 && esperas.length === 0, "1 pedido, sem esperas");
      check(linhas.length === 0, "sem ruído no log quando não há retentativas");
      const st = c.estatisticas();
      check(st.pedidos === 1 && st.retentativas === 0 && st.recuperadosPorRetentativa === 0, "estatísticas: concluído à primeira");
      check(!houveFalhaTransitoriaDefinitiva(), "nenhuma falha transitória definitiva assinalada");
    }

    secao("C · «fetch failed» ANTES de o servidor receber o pedido");
    {
      srv.pedidos.length = 0; srv.gravados.clear();
      srv.definirSequencia(URL_PRODUTOS, [{ acao: "cair-sem-ler" }, { acao: "responder", status: 200, json: { ok: true, accepted: 1, upserted: 1, skipped: [], errors: [], durationMs: 2 } }]);
      const { c, esperas, linhas } = cliente(srv);
      const r = await c.bootstrapProducts(BATCH, undefined, { lote: 2 });
      check(r.upserted === 1, "recupera na 2.ª tentativa");
      check(esperas.length === 1 && esperas[0] === 5_000, "1.ª espera = 5 s");
      check(srv.gravados.size === 1, "uma só gravação");
      check(linhas.some((l) => /tentativa 1\/5 falhou/.test(l) && /lote=2/.test(l) && /dia=2026-10-14/.test(l) && /etapa=produtos/.test(l)), "log: endpoint, dia, etapa, lote, tentativa X/total");
      check(linhas.some((l) => /concluído na tentativa 2\/5/.test(l)), "log: concluído após retentativa");
    }

    secao("D · o servidor PROCESSA e a resposta perde-se (o incidente de 15/10)");
    {
      srv.pedidos.length = 0; srv.gravados.clear();
      srv.definirSequencia(URL_PRODUTOS, [{ acao: "gravar-e-cair" }]); // depois responde 200 por omissão
      const { c, linhas } = cliente(srv);
      const r = await c.bootstrapProducts(BATCH, undefined, { lote: 6 });
      check(r.ok === true, "aceita como sucesso a resposta idempotente da retentativa");
      check(srv.pedidos.length === 2, "2 pedidos chegaram ao servidor");
      check(srv.pedidos[0]!.corpo === srv.pedidos[1]!.corpo, "a retentativa reenvia EXATAMENTE o mesmo corpo");
      check(srv.gravados.size === 1 && [...srv.gravados.values()][0] === 2, "idempotência: 1 registo (chave = corpo), aplicado 2× sem duplicar");
      check(linhas.some((l) => /AMBÍGUA/.test(l)), "log marca a falha como AMBÍGUA (resultado potencialmente já gravado)");
      check(linhas.some((l) => /idempotente repetido com o mesmo corpo/.test(l)), "log do sucesso refere a repetição idempotente");
      check(c.estatisticas().recuperadosAposAmbigua === 1, "estatísticas: recuperado após falha ambígua");
    }

    secao("E · corpo da resposta truncado");
    {
      srv.pedidos.length = 0; srv.gravados.clear();
      srv.definirSequencia(URL_PRODUTOS, [{ acao: "truncar" }]);
      const { c, linhas } = cliente(srv);
      const r = await c.bootstrapProducts(BATCH);
      check(r.ok === true && srv.pedidos.length === 2, "resposta cortada a meio → repete e conclui");
      check(linhas.some((l) => /resposta_truncada/.test(l) && /AMBÍGUA/.test(l)), "classificada como resposta_truncada/ambígua");
    }

    secao("F · 502, 503 e 504 seguidos de sucesso");
    {
      srv.pedidos.length = 0;
      srv.definirSequencia(URL_PRODUTOS, [
        { acao: "responder", status: 502, texto: "bad gateway" },
        { acao: "responder", status: 503, texto: "unavailable" },
        { acao: "responder", status: 504, texto: "gateway timeout" },
      ]);
      const { c, esperas } = cliente(srv);
      const r = await c.bootstrapProducts(BATCH);
      check(r.ok === true && srv.pedidos.length === 4, "3 falhas + sucesso = 4 pedidos");
      check(JSON.stringify(esperas) === "[5000,15000,30000]", "esperas 5, 15 e 30 s");
    }

    secao("G · 429 com Retry-After");
    {
      srv.pedidos.length = 0;
      srv.definirSequencia(URL_PRODUTOS, [{ acao: "responder", status: 429, texto: "slow down", cabecalhos: { "retry-after": "20" } }]);
      const { c, esperas } = cliente(srv);
      await c.bootstrapProducts(BATCH);
      check(esperas.length === 1 && esperas[0] === 20_000, "respeita o Retry-After (20 s > 5 s da política)");
      srv.definirSequencia(URL_PRODUTOS, [{ acao: "responder", status: 429, texto: "x", cabecalhos: { "retry-after": "9999" } }]);
      const t = cliente(srv);
      await t.c.bootstrapProducts(BATCH);
      check(t.esperas[0] === 5_000, "Retry-After exagerado (9999 s) é ignorado — usa a política");
    }

    secao("H · 400/401/403/404/409/422 NÃO se repetem");
    for (const status of [400, 401, 403, 404, 409, 422]) {
      srv.pedidos.length = 0;
      srv.definirSequencia(URL_PRODUTOS, [{ acao: "responder", status, texto: "recusado" }]);
      const { c, esperas } = cliente(srv);
      let erro: unknown;
      const silenciar = console.error;
      console.error = () => undefined; // o diagnóstico de 401 imprime sem segredos; não polui este relatório
      try { await c.bootstrapProducts(BATCH); } catch (e) { erro = e; } finally { console.error = silenciar; }
      check(erro instanceof SaasApiError && erro.statusCode === status && srv.pedidos.length === 1 && esperas.length === 0, `HTTP ${status}: 1 pedido, sem espera, SaasApiError`);
    }

    secao("I · timeout seguido de sucesso");
    {
      srv.pedidos.length = 0; srv.gravados.clear();
      srv.definirSequencia(URL_PRODUTOS, [{ acao: "demorar", ms: 900, gravar: true }]);
      const { c, linhas } = cliente(srv);
      const r = await c.bootstrapProducts(BATCH);
      check(r.ok === true && srv.pedidos.length === 2, "1.ª tentativa excede o timeout (300 ms); a 2.ª conclui");
      check(srv.gravados.size === 1, "o servidor gravou o mesmo lote duas vezes sem duplicar");
      check(linhas.some((l) => /timeout/.test(l) && /AMBÍGUA/.test(l)), "timeout classificado como ambíguo");
    }

    secao("J · esgotamento das retentativas HTTP");
    {
      repor();
      srv.pedidos.length = 0;
      srv.definirSequencia(URL_PRODUTOS, Array.from({ length: 10 }, () => ({ acao: "responder" as const, status: 503, texto: "indisponível" })));
      const { c, esperas, linhas } = cliente(srv);
      let erro: unknown;
      try { await c.bootstrapProducts(BATCH); } catch (e) { erro = e; }
      check(erro instanceof SaasApiError && erro.statusCode === 503 && erro.tentativas === 5 && erro.transitoria, "SaasApiError 503, 5 tentativas, marcado como transitório");
      check(srv.pedidos.length === 5 && JSON.stringify(esperas) === "[5000,15000,30000,60000]", "5 pedidos e as 4 esperas da política");
      check(houveFalhaTransitoriaDefinitiva(), "sinaliza «falha transitória definitiva» (o orquestrador retoma mais tarde)");
      check(linhas.some((l) => /FALHA DEFINITIVA após 5\/5/.test(l)), "log: falha definitiva");
      check(c.estatisticas().falhasDefinitivas === 1, "estatísticas: 1 falha definitiva");
      repor();
      srv.definirSequencia(URL_PRODUTOS, Array.from({ length: 5 }, () => ({ acao: "cair-sem-ler" as const })));
      const n = cliente(srv);
      let e2: unknown;
      try { await n.c.bootstrapProducts(BATCH); } catch (e) { e2 = e; }
      check(e2 instanceof SaasNetworkError && /falha de rede/.test((e2 as Error).message) && e2.transitoria && e2.tentativas === 5, "falha de rede esgotada: SaasNetworkError com a mensagem histórica «falha de rede»");
      srv.definirSequencia(URL_PRODUTOS, []);
      repor();
    }

    secao("K · endpoints especiais");
    {
      // aggregate-month: 500 acquire_lock (pedido original ainda a correr) repete-se, com espera ≥ 30 s
      srv.pedidos.length = 0;
      srv.definirSequencia("/api/admin/pipeline/aggregate-month", [{ acao: "responder", status: 500, json: { ok: false, error: "internal", message: "acquire_lock failed (retry)" } }]);
      const { c, esperas } = cliente(srv);
      const body = { month: "2026-10", write: true };
      const agg = await c.pipelineAggregateMonth(body);
      check((agg as unknown as { ok: boolean }).ok === true && srv.pedidos.length === 2 && esperas[0]! >= 30_000, "aggregate-month: 500 acquire_lock → espera ≥ 30 s e repete");
      srv.definirSequencia("/api/admin/pipeline/aggregate-month", [{ acao: "responder", status: 500, json: { ok: false, error: "internal", message: "relation does not exist" } }]);
      const n = cliente(srv);
      let erro: unknown;
      try { await n.c.pipelineAggregateMonth(body); } catch (e) { erro = e; }
      check(erro instanceof SaasApiError && erro.statusCode === 500 && n.esperas.length === 0, "aggregate-month: outro 500 NÃO se repete");
      srv.definirSequencia("/api/admin/pipeline/aggregate-month", [{ acao: "responder", status: 409, json: { ok: false, error: "abort", code: "unknowns_present" } }]);
      const m = cliente(srv);
      let e409: unknown;
      try { await m.c.pipelineAggregateMonth(body); } catch (e) { e409 = e; }
      check(e409 instanceof SaasApiError && e409.statusCode === 409 && m.esperas.length === 0, "aggregate-month: 409 de gate de negócio NÃO se repete");

      // finalize: 409 sem_corrida_aberta DEPOIS de uma retentativa = já feito; à primeira tentativa é erro
      srv.definirSequencia("/api/ingest/v1/bootstrap/products/finalize", [{ acao: "gravar-e-cair" }, { acao: "responder", status: 409, json: { ok: false, error: "sem_corrida_aberta" } }]);
      const f = cliente(srv);
      const fin = await f.c.bootstrapProductsFinalize({ farmaciaId: "farm1", runStartedAt: "2026-10-15T00:00:00Z" });
      check(fin.ok === true && (fin as unknown as { jaFinalizado?: boolean }).jaFinalizado === true, "finalize: 409 sem_corrida_aberta após retentativa ambígua → aceite como já feito");
      srv.definirSequencia("/api/ingest/v1/bootstrap/products/finalize", [{ acao: "responder", status: 409, json: { ok: false, error: "sem_corrida_aberta" } }]);
      const f2 = cliente(srv);
      let ef: unknown;
      try { await f2.c.bootstrapProductsFinalize({ farmaciaId: "farm1", runStartedAt: "x" }); } catch (e) { ef = e; }
      check(ef instanceof SaasApiError && ef.statusCode === 409, "finalize: o mesmo 409 À PRIMEIRA tentativa continua a ser erro");

      // compras: 200 com errors[] depois de uma falha ambígua → repete uma vez
      srv.definirSequencia("/api/ingest/v1/bootstrap/compras", [
        { acao: "gravar-e-cair" },
        { acao: "responder", status: 200, json: { ok: true, accepted: 1, upserted: 0, skipped: [], errors: [{ index: 0, reason: "upsert_failed", message: "P2002" }], durationMs: 1 } },
        { acao: "responder", status: 200, json: { ok: true, accepted: 1, upserted: 1, skipped: [], errors: [], durationMs: 1 } },
      ]);
      const cp = cliente(srv);
      const rc = await cp.c.bootstrapCompras({ farmaciaId: "farm1", items: [{ x: 1 }] });
      check(rc.errors.length === 0, "compras: conflito P2002 após falha ambígua → repetido uma vez até limpar");

      // PipelineRun: a mesma idempotencyKey nas tentativas
      srv.gravados.clear();
      srv.pedidos.length = 0;
      srv.definirSequencia("/api/admin/pipeline/record", [{ acao: "gravar-e-cair" }]);
      const rec = cliente(srv);
      const corpoRec = { farmaciaId: "farm1", kind: "daily-pipeline" as const, status: "OK" as const, startedAt: "2026-10-15T02:00:00Z", finishedAt: "2026-10-15T02:03:00Z", idempotencyKey: "daily-pipeline:farm1:2026-10-14:2026-10-15T02:00:00.000Z" };
      await rec.c.pipelineRecord(corpoRec);
      const chaves = srv.pedidos.map((q) => (JSON.parse(q.corpo) as { idempotencyKey: string }).idempotencyKey);
      check(chaves.length === 2 && chaves[0] === chaves[1], "PipelineRun: a retentativa leva a MESMA idempotencyKey");
      check(srv.gravados.size === 1, "PipelineRun: 1 registo (sem duplicar)");

      // outbox/claims: sem retry
      srv.pedidos.length = 0;
      srv.definirSequencia("/api/outbox/v1/sync-requests/pending", [{ acao: "cair-sem-ler" }]);
      const ob = cliente(srv);
      let eo: unknown;
      try { await ob.c.pullPendingSyncRequests("farm1"); } catch (e) { eo = e; }
      check(eo instanceof SaasNetworkError && srv.pedidos.length === 1 && ob.esperas.length === 0, "claim do sync-now (long-poll): NÃO se repete às cegas");
    }

    secao("L · segredos nunca aparecem nos logs");
    {
      srv.pedidos.length = 0;
      srv.definirSequencia(URL_PRODUTOS, [{ acao: "responder", status: 503, texto: `erro com Bearer ${CHAVE} e ingestKey=${CHAVE}` }, { acao: "cair-sem-ler" }]);
      const { c, linhas } = cliente(srv);
      await c.bootstrapProducts({ farmaciaId: "farm1", items: [{ nome: "PACIENTE JOAO", nif: "123456789" }] });
      const tudo = linhas.join("\n");
      check(!tudo.includes(CHAVE), "o token não está em nenhuma linha de log");
      check(!/PACIENTE|123456789|Authorization/i.test(tudo), "nem o corpo dos pedidos nem os headers");
      check(!redigir(`falhou Bearer ${CHAVE}`, [CHAVE]).includes(CHAVE) && !redigir("ingestKey: abcdef123456").includes("abcdef123456"), "redigir() remove tokens e chaves");
    }

    secao("M · política configurável por pedido");
    {
      srv.pedidos.length = 0;
      srv.definirSequencia(URL_PRODUTOS, [{ acao: "responder", status: 503, texto: "x" }]);
      const { c } = cliente(srv, { esperasMs: [] });
      let erro: unknown;
      try { await c.bootstrapProducts(BATCH); } catch (e) { erro = e; }
      check(erro instanceof SaasApiError && srv.pedidos.length === 1, "esperasMs vazias = sem retry");
    }
  } finally {
    await srv.fechar();
  }

  console.log(`\n${ok} OK, ${ko} falhas`);
  process.exit(ko === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
