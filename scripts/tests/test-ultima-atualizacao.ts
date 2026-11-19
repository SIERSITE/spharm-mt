/**
 * scripts/tests/test-ultima-atualizacao.ts
 *
 * «Última atualização» (menu lateral): lógica pura + guardas de estrutura (sem BD) e,
 * se TEST_DB_ATUALIZACAO (local) existir, o loader real contra Postgres.
 *
 *   npx tsx scripts/tests/test-ultima-atualizacao.ts
 */
import Module from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const M = Module as unknown as { _resolveFilename: (r: string, ...a: unknown[]) => string };
const orig = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "server-only" ? __filename : orig.call(this, request, ...rest);
};

let ok = 0;
let ko = 0;
const check = (c: boolean, label: string, d?: string) => {
  if (c) {
    ok++;
    console.log(`  [OK]    ${label}`);
  } else {
    ko++;
    console.log(`  [FALHA] ${label}${d ? ` — ${d}` : ""}`);
  }
};
const ler = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const semComentarios = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

async function main() {
  const core = await import("../../lib/ultima-atualizacao-core");
  const D = (s: string) => new Date(s);

  console.log("\nA · uma linha por farmácia, sem data global");
  const fs = [
    { id: "a", nome: "Farmácia A" },
    { id: "b", nome: "Farmácia B" },
    { id: "c", nome: "Farmácia C" },
  ];
  let r = core.ultimasAtualizacoes(fs, [
    { farmaciaId: "a", recebidaEm: D("2026-11-19T10:00:00Z") },
    { farmaciaId: "a", recebidaEm: D("2026-11-19T08:00:00Z") },
    { farmaciaId: "b", recebidaEm: D("2026-11-18T23:30:00Z") },
  ]);
  check(r.length === 3 && Array.isArray(r), "devolve uma entrada por farmácia (lista, não um agregado)");
  check(r[0].ate === "2026-11-19T10:00:00.000Z", "A: a corrida MAIS RECENTE dessa farmácia");
  check(r[1].ate === "2026-11-18T23:30:00.000Z", "B: a sua própria data (não é sobreposta pela de A)");
  check(r[2].ate === null, "C sem corrida → null («Sem atualização disponível»)");
  check(JSON.stringify(r.map((x) => x.nome)) === JSON.stringify(["Farmácia A", "Farmácia B", "Farmácia C"]), "mantém a ordem recebida");
  r = core.ultimasAtualizacoes(fs, [{ farmaciaId: "zzz", recebidaEm: D("2026-11-19T10:00:00Z") }]);
  check(r.every((x) => x.ate === null), "corrida de farmácia fora do conjunto é ignorada");
  r = core.ultimasAtualizacoes(fs, [{ farmaciaId: "a", recebidaEm: new Date("lixo") }]);
  check(r[0].ate === null, "data inválida é ignorada");
  check(core.ultimasAtualizacoes([], []).length === 0, "sem farmácias → vazio");

  console.log("\nB · formatação «DD/MM/AAAA às HH:mm» (Lisboa)");
  const f1 = core.formatarAtualizacao("2026-11-19T08:24:00Z");
  check(f1 === "19/11/2026 às 08:24", "inverno", f1);
  const f2 = core.formatarAtualizacao("2026-07-01T14:32:00Z");
  check(f2 === "01/07/2026 às 15:32", "verão (UTC+1)", f2);
  const f3 = core.formatarAtualizacao("2026-06-30T23:30:00Z");
  check(f3 === "01/07/2026 às 00:30", "meia-noite de Lisboa (00:30, não 24:30)", f3);
  check(core.TEXTO_SEM_ATUALIZACAO === "Sem atualização disponível", "texto sem atualização");
  check(core.TITULO_BLOCO === "Última atualização", "título do bloco");

  console.log("\nC · fonte");
  check(JSON.stringify(core.KINDS_ATUALIZACAO) === JSON.stringify(["daily-pipeline", "daily-sync"]), "só daily-pipeline e daily-sync");
  check(core.STATUS_ATUALIZACAO === "OK", "só status OK");
  const fonte = semComentarios(ler("lib/ultima-atualizacao.ts"));
  check(/_max:\s*\{\s*updatedAt/.test(fonte), "usa updatedAt (relógio do servidor), não finishedAt");
  check(!/heartbeat|lastAgent|syncRequest|sync-now/i.test(fonte + semComentarios(ler("lib/ultima-atualizacao-core.ts"))), "o código não usa heartbeat, SyncRequest nem sync-now");
  check(/canAccessFarmaciaSync/.test(fonte), "só farmácias acessíveis ao perfil");
  check(!/\.(create|update|upsert|delete|deleteMany|updateMany)\(/.test(fonte), "só leitura");

  console.log("\nD · interface");
  const ui = ler("components/layout/ultima-atualizacao.tsx");
  check(!/onClick|<button|<a[ >]|<Link|title=|role="button"|tabIndex/.test(ui), "sem clique, botão, ligação, tooltip");
  check(/Última atualização|TITULO_BLOCO/.test(ui) && /TEXTO_SEM_ATUALIZACAO/.test(ui), "título e texto «Sem atualização disponível»");
  const tecnico = /\b(agent|heartbeat|ingest\w*|fila|outbox|api|integra\w+)\b/i;
  const visivel = semComentarios(ui).match(/>\s*[^<>{}\n]+\s*</g)?.join(" ") ?? "";
  check(!tecnico.test(visivel), "sem termos técnicos visíveis", visivel.match(tecnico)?.[0]);
  const shell = ler("components/layout/app-shell.tsx");
  const ocorrencias = (shell.match(/<UltimaAtualizacaoMenu \/>/g) ?? []).length;
  check(ocorrencias === 1, "montada uma vez, no conteúdo partilhado do menu (desktop e móvel)", String(ocorrencias));
  const iConteudo = shell.indexOf("<UltimaAtualizacaoMenu />");
  const iUtilizador = shell.indexOf("{utilizador ? (\n", iConteudo) >= 0 ? shell.indexOf("{utilizador ? (", iConteudo) : shell.indexOf("{utilizador ? (\r\n", iConteudo);
  check(iConteudo > 0 && iUtilizador > iConteudo, "aparece ANTES do bloco do utilizador");
  const rota = ler("app/api/ultima-atualizacao/route.ts");
  check(/getSession\(\)/.test(rota) && /401/.test(rota) && /no-store/.test(rota), "rota exige sessão e não faz cache");

  console.log("\nE · âmbito da alteração");
  const base = "e7db04071af7edbedc001bf75c73ef3e0bc4e808";
  const alterados = execSync(`git diff --name-only ${base} -- . ":!generated"`, { encoding: "utf8" }).split("\n").filter(Boolean);
  const novos = execSync("git ls-files --others --exclude-standard", { encoding: "utf8" }).split("\n").filter(Boolean);
  const todos = [...new Set([...alterados, ...novos])];
  const proibidos = todos.filter((f) => /^(prisma|prisma-control|agent|installer)\//.test(f) || /^components\/(vendas|margens|inventario|excessos|transferencias|devolucoes|stock|encomendas)\//.test(f) || /^lib\/(vendas|margens|inventario|stock|encomendas|transferencias)/.test(f) || /^app\/(vendas|relatorios|excessos|transferencias|devolucoes|stock|encomendas)\//.test(f));
  check(proibidos.length === 0, "nenhum ecrã de relatório, cálculo, migration ou agent alterado", proibidos.join(", "));

  if (process.env.TEST_DB_ATUALIZACAO) {
    console.log("\nF · loader contra Postgres local");
    const u = new URL(process.env.TEST_DB_ATUALIZACAO);
    if (u.hostname !== "localhost" && u.hostname !== "127.0.0.1") {
      console.error("só localhost");
      process.exit(2);
    }
    const { PrismaPg } = await import("@prisma/adapter-pg");
    const { PrismaClient } = await import("../../generated/prisma/client");
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.TEST_DB_ATUALIZACAO }) });
    const { carregarUltimasAtualizacoesCom } = await import("../../lib/ultima-atualizacao");
    await prisma.pipelineRun.deleteMany();
    await prisma.syncRequest.deleteMany();
    await prisma.auditLog.deleteMany();
    await prisma.utilizadorFarmacia.deleteMany();
    await prisma.utilizador.deleteMany();
    await prisma.farmacia.deleteMany();
    const A = await prisma.farmacia.create({ data: { nome: "Farm A" } });
    const B = await prisma.farmacia.create({ data: { nome: "Farm B" } });
    await prisma.farmacia.create({ data: { nome: "Farm C" } });
    await prisma.farmacia.create({ data: { nome: "Farmácia Teste" } });
    await prisma.farmacia.create({ data: { nome: "Farm Inativa", estado: "INATIVO" } });
    const run = (farmaciaId: string, kind: string, status: string, updatedAt: string, k: string) =>
      prisma.pipelineRun.create({
        data: { farmaciaId, kind, status, updatedAt: new Date(updatedAt), startedAt: new Date("2020-01-01"), finishedAt: new Date("2030-01-01"), idempotencyKey: k },
      });
    await run(A.id, "daily-pipeline", "OK", "2026-11-19T06:00:00Z", "k1");
    await run(A.id, "sync-now", "OK", "2026-11-19T12:00:00Z", "k2");
    await run(A.id, "daily-pipeline", "PARTIAL", "2026-11-19T13:00:00Z", "k3");
    await run(A.id, "daily-pipeline", "ERROR", "2026-11-19T14:00:00Z", "k3b");
    await run(B.id, "daily-sync", "OK", "2026-11-19T05:00:00Z", "k4");
    await run(B.id, "aggregate-month", "OK", "2026-11-19T14:00:00Z", "k5");
    const gestor = { sub: "x", email: "x@x", nome: "x", perfil: "GESTOR_GRUPO", farmaciaId: null, tenant: "t" } as never;
    let d = await carregarUltimasAtualizacoesCom(prisma, gestor);
    check(d.map((f) => f.nome).join(",") === "Farm A,Farm B,Farm C", "só farmácias ATIVAS, sem «Farmácia Teste», por nome", d.map((f) => f.nome).join(","));
    check(d[0].ate === "2026-11-19T06:00:00.000Z", "A: ignora sync-now, PARTIAL, ERROR e o finishedAt do agent (2030)");
    check(d[1].ate === "2026-11-19T05:00:00.000Z", "B: daily-sync conta; aggregate-month não");
    check(d[2].ate === null, "C: sem corrida concluída → null");
    const op = { sub: "y", email: "y@y", nome: "y", perfil: "OPERADOR", farmaciaId: A.id, tenant: "t" } as never;
    d = await carregarUltimasAtualizacoesCom(prisma, op);
    check(d.length === 1 && d[0].nome === "Farm A", "operador só vê a sua farmácia");
    await prisma.$disconnect();
  } else {
    console.log("\n(F · loader contra Postgres: ignorado — defina TEST_DB_ATUALIZACAO)");
  }

  console.log(`\n${ok} OK, ${ko} falhas`);
  process.exit(ko ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
