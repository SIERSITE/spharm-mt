/**
 * agent/src/plano-integracao.test.ts
 *
 * Integração do comando REAL `daily-pipeline --plan` (processo filho, cli.ts) contra um SaaS simulado em HTTP
 * local — sem ERP, sem Internet, sem escrever nada. Prova, ponta a ponta:
 *   · o arranque confirma no SaaS o último dia concluído e recupera o dia em falta ANTES do dia normal;
 *   · o dry-run (`--plan`) não executa nem escreve nada (nenhum POST, nenhum registo);
 *   · se o SaaS não consegue informar, deixa um diagnóstico claro e usa a pista local;
 *   · as retentativas HTTP do planeamento aplicam-se (503 → sucesso);
 *   · o log não contém o token;
 *   · uma configuração rev97 (sem as opções novas) funciona.
 *
 * Uso: npx tsx agent/src/plano-integracao.test.ts
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { deslocarDia } from "./catch-up.js";
import { ontemNaFarmacia } from "./janela.js";
import { registarPendente } from "./estado-local.js";

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${label}`); }
  else { ko++; console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`); }
};
const secao = (t: string) => console.log(`\n${t}`);

const TOKEN = "TOKEN-SECRETO-DE-TESTE-9f8e7d6c";
const FARM_ID = "cfarm0000000000000000001";

type Modo = { dias: string[] | "503" | "503-uma-vez" };
async function iniciarSaas(modo: Modo) {
  const pedidos: Array<{ metodo: string; caminho: string }> = [];
  let diasChamadas = 0;
  const server = http.createServer((req, res) => {
    const caminho = (req.url ?? "").split("?")[0]!;
    pedidos.push({ metodo: req.method ?? "", caminho });
    req.resume();
    req.on("end", () => {
      const json = (status: number, corpo: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(corpo)); };
      if (caminho === "/api/ingest/v1/farmacias") return json(200, { ok: true, tenantSlug: "silveira", farmacias: [{ id: FARM_ID, nome: "Farmácia Silveirense", estado: "ATIVO" }] });
      if (caminho === "/api/ingest/v1/pipeline/dias-concluidos") {
        diasChamadas++;
        if (modo.dias === "503") return json(503, { ok: false, error: "indisponível" });
        if (modo.dias === "503-uma-vez" && diasChamadas === 1) return json(503, { ok: false });
        return json(200, { ok: true, farmaciaId: FARM_ID, from: "x", to: "y", dias: Array.isArray(modo.dias) ? modo.dias : [] });
      }
      return json(404, { ok: false });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, pedidos, fechar: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

function correrPlano(url: string, runDir: string, extraEnv: Record<string, string> = {}): Promise<{ status: number | null; saida: string }> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of Object.keys(env)) if (/^(SPHARMMT_|ERP_SQLSERVER_)/.test(k)) delete env[k];
    Object.assign(env, {
      SPHARMMT_ENDPOINT: url,
      SPHARMMT_TENANT_SLUG: "silveira",
      SPHARMMT_INGEST_KEY: TOKEN,
      SPHARMMT_FARMACIA: "Farmácia Silveirense",
      ERP_SQLSERVER_HOST: "localhost",
      ERP_SQLSERVER_DATABASE: "x",
      ERP_SQLSERVER_USER: "u",
      ERP_SQLSERVER_PASSWORD: "p",
      SPHARMMT_RUN_DIR: runDir,
      SPHARMMT_HTTP_RETRY_ESPERAS_MS: "10,10",
      SPHARMMT_HTTP_RETRY_JITTER: "0",
      ...extraEnv,
    });
    const p = spawn(process.execPath, ["--import", "tsx", path.resolve("agent/src/cli.ts"), "daily-pipeline", "--plan"], { env, cwd: process.cwd() });
    let saida = "";
    p.stdout.on("data", (d) => (saida += d));
    p.stderr.on("data", (d) => (saida += d));
    const timer = setTimeout(() => p.kill(), 60_000);
    p.on("close", (status) => { clearTimeout(timer); resolve({ status, saida }); });
  });
}

async function main() {
  const ontem = ontemNaFarmacia();
  const anteontem = deslocarDia(ontem, -1);
  const feitos = [deslocarDia(ontem, -5), deslocarDia(ontem, -4), deslocarDia(ontem, -3), deslocarDia(ontem, -2)];

  secao("A · o SaaS confirma o último dia concluído; falta anteontem");
  {
    const saas = await iniciarSaas({ dias: feitos });
    const run = fs.mkdtempSync(path.join(os.tmpdir(), "spharm-plan-"));
    const r = await correrPlano(saas.url, run);
    check(r.status === 0, `--plan termina com exit 0 (${r.status})`, r.saida.slice(-600));
    check(r.saida.includes(`Último dia concluído confirmado pelo SaaS: ${feitos[3]}`), "o log diz qual foi o último dia concluído confirmado pelo SaaS");
    check(r.saida.includes(`[plan] Dias que seriam processados (por ordem): ${anteontem} → ${ontem}`), "recupera o dia em falta ANTES do dia normal (cronológico)");
    check(r.saida.includes("Política HTTP: 1 + 2 retentativas") === true, "mostra a política HTTP efetiva (aqui reduzida pelo ambiente de teste)");
    check(r.saida.includes("Nada foi executado"), "dry-run: declara que nada foi executado");
    check(saas.pedidos.every((p) => p.metodo === "GET"), "dry-run: NENHUM pedido de escrita ao SaaS");
    check(!fs.existsSync(path.join(run, "pipeline-pendentes.json")) && !fs.existsSync(path.join(run, "pipeline.lock")), "dry-run: não cria estado local nem lock");
    check(!r.saida.includes(TOKEN), "o token não aparece na saída");
    await saas.fechar();
    fs.rmSync(run, { recursive: true, force: true });
  }

  secao("B · tudo concluído até ontem: nada em falta");
  {
    const saas = await iniciarSaas({ dias: [...feitos, anteontem, ontem] });
    const run = fs.mkdtempSync(path.join(os.tmpdir(), "spharm-plan-"));
    const r = await correrPlano(saas.url, run);
    check(r.status === 0 && /\(nenhum\)/.test(r.saida), "o dia normal já está concluído: nenhum dia a processar");
    await saas.fechar();
    fs.rmSync(run, { recursive: true, force: true });
  }

  secao("C · o SaaS não consegue informar (503 persistente): diagnóstico claro + pista local");
  {
    const saas = await iniciarSaas({ dias: "503" });
    const run = fs.mkdtempSync(path.join(os.tmpdir(), "spharm-plan-"));
    registarPendente(run, { dia: anteontem, estado: "ERROR", causa: "daily-sync: fetch failed" });
    const r = await correrPlano(saas.url, run);
    check(r.status === 0 && /o SaaS não conseguiu informar o último dia concluído/.test(r.saida), "diagnóstico explícito de que o SaaS não informou");
    check(r.saida.includes(`[plan] Dias que seriam processados (por ordem): ${anteontem} → ${ontem}`), "usa a pista local (run/pipeline-pendentes.json): recupera anteontem e depois ontem");
    check(saas.pedidos.filter((p) => p.caminho.endsWith("dias-concluidos")).length === 3, "retentativas HTTP no planeamento (1 + 2 retentativas configuradas)");
    await saas.fechar();
    fs.rmSync(run, { recursive: true, force: true });
  }

  secao("D · 503 transitório no planeamento recupera por retentativa");
  {
    const saas = await iniciarSaas({ dias: "503-uma-vez" });
    const run = fs.mkdtempSync(path.join(os.tmpdir(), "spharm-plan-"));
    const r = await correrPlano(saas.url, run);
    check(r.status === 0 && /tentativa 1\/3 falhou/.test(r.saida) && /concluído na tentativa 2\/3/.test(r.saida), "log HTTP: «tentativa 1/3 falhou … concluído na tentativa 2/3»");
    check(!/Não foi possível consultar os dias concluídos/.test(r.saida), "não cai no modo degradado");
    check(!r.saida.includes(TOKEN), "o token não aparece nos logs HTTP");
    await saas.fechar();
    fs.rmSync(run, { recursive: true, force: true });
  }

  console.log(`\n${ok} OK, ${ko} falhas`);
  process.exit(ko === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
