/**
 * scripts/tests/test-dados-atualizados.ts
 *
 * «Dados atualizados até» — lógica pura + guardas de estrutura (sem BD) e,
 * se TEST_DB_DADOS (local) existir, o loader real contra Postgres.
 *
 *   npx tsx scripts/tests/test-dados-atualizados.ts
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
  const core = await import("../../lib/dados-atualizados-core");
  const D = (s: string) => new Date(s);

  console.log("\nA · agregação");
  const fs = [
    { id: "a", nome: "Farmácia A" },
    { id: "b", nome: "Farmácia B" },
    { id: "c", nome: "Farmácia C" },
  ];
  let r = core.agregarDadosAtualizados(fs, [
    { farmaciaId: "a", recebidaEm: D("2026-11-19T10:00:00Z") },
    { farmaciaId: "a", recebidaEm: D("2026-11-19T08:00:00Z") },
    { farmaciaId: "b", recebidaEm: D("2026-11-18T23:30:00Z") },
  ]);
  check(r.ate === "2026-11-18T23:30:00.000Z", "cabeçalho = a MAIS ANTIGA entre as farmácias com informação");
  check(r.farmacias.find((f) => f.id === "a")?.ate === "2026-11-19T10:00:00.000Z", "por farmácia usa a corrida MAIS RECENTE");
  check(r.farmacias.find((f) => f.id === "c")?.ate === null, "farmácia sem informação → null");
  r = core.agregarDadosAtualizados(fs, []);
  check(r.ate === null && r.farmacias.every((f) => f.ate === null), "nenhuma corrida → null em tudo");
  r = core.agregarDadosAtualizados([], []);
  check(r.ate === null && r.farmacias.length === 0, "sem farmácias → vazio");
  r = core.agregarDadosAtualizados(fs, [{ farmaciaId: "zzz", recebidaEm: D("2026-11-19T10:00:00Z") }]);
  check(r.ate === null, "corrida de farmácia fora do conjunto é ignorada");
  r = core.agregarDadosAtualizados(fs, [{ farmaciaId: "a", recebidaEm: new Date("lixo") }]);
  check(r.ate === null, "data inválida é ignorada");

  console.log("\nB · formatação (fuso de Lisboa)");
  const f1 = core.formatarDataHora("2026-11-19T14:32:00Z");
  check(f1 === "19/11/2026, 14:32", "inverno (UTC+0)", f1);
  const f2 = core.formatarDataHora("2026-07-01T14:32:00Z");
  check(f2 === "01/07/2026, 15:32", "verão (UTC+1)", f2);
  const f3 = core.formatarDataHora("2026-12-31T23:59:00Z");
  check(f3 === "31/12/2026, 23:59", "23:59 sem passar para 24:xx", f3);
  const f4 = core.formatarDataHora("2026-06-30T23:30:00Z");
  check(f4 === "01/07/2026, 00:30", "meia-noite de Lisboa (00:30, não 24:30)", f4);
  check(core.textoCabecalho("2026-11-19T14:32:00Z") === "Dados atualizados até 19/11/2026, 14:32", "texto do cabeçalho");
  check(core.textoCabecalho(null) === "Atualização ainda não disponível", "sem informação");

  console.log("\nC · fonte");
  check(JSON.stringify(core.KINDS_DADOS) === JSON.stringify(["daily-pipeline", "daily-sync"]), "só daily-pipeline e daily-sync");
  check(!(core.KINDS_DADOS as readonly string[]).includes("sync-now"), "sync-now (pedido do utilizador) NÃO conta");
  check(core.STATUS_DADOS === "OK", "só status OK (PARTIAL não conta)");
  const fonte = semComentarios(ler("lib/dados-atualizados.ts"));
  check(/_max:\s*\{\s*updatedAt/.test(fonte), "usa updatedAt (relógio do servidor), não finishedAt (relógio do agent)");
  check(!/heartbeat|lastAgent|syncRequest/i.test(fonte + semComentarios(ler("lib/dados-atualizados-core.ts"))), "o código não usa heartbeat nem SyncRequest");
  check(/canAccessFarmaciaSync/.test(fonte), "respeita o âmbito de farmácias do perfil");
  check(!/\.(create|update|upsert|delete|deleteMany|updateMany)\(/.test(fonte), "só leitura");

  console.log("\nD · interface");
  const ui = ler("components/layout/dados-atualizados.tsx");
  const tecnico = /\b(agent|heartbeat|ingest\w*|fila|outbox|api)\b/i;
  const literais = [...ui.matchAll(/>\s*([^<>{}\n][^<>{}]*?)\s*</g)].map((m) => m[1]).join(" ") + " " + core.TEXTO_SEM_INFO;
  check(!tecnico.test(literais), "texto visível sem termos técnicos", literais.match(tecnico)?.[0]);
  check(/sm:hidden/.test(ui) && /hidden sm:inline/.test(ui), "versão móvel (texto curto) e desktop (texto completo)");
  check(/Escape/.test(ui) && /aria-expanded/.test(ui), "fecha com Esc e expõe aria-expanded");
  const shell = ler("components/layout/app-shell.tsx");
  check(/<DadosAtualizadosCabecalho \/>/.test(shell), "montado no cabeçalho da AppShell (todos os ecrãs)");
  const rota = ler("app/api/dados-atualizados/route.ts");
  check(/getSession\(\)/.test(rota) && /401/.test(rota) && /no-store/.test(rota), "rota exige sessão e não faz cache");

  console.log("\nE · sem migrations / sem schema");
  const diff = execSync(
    "git diff --name-only e7db04071af7edbedc001bf75c73ef3e0bc4e808 -- prisma prisma-control",
    { encoding: "utf8" },
  ).trim();
  check(diff === "", "nenhuma alteração em prisma/ nem prisma-control/", diff);

  if (process.env.TEST_DB_DADOS) {
    console.log("\nF · loader contra Postgres local");
    const u = new URL(process.env.TEST_DB_DADOS);
    if (u.hostname !== "localhost" && u.hostname !== "127.0.0.1") {
      console.error("só localhost");
      process.exit(2);
    }
    const { PrismaPg } = await import("@prisma/adapter-pg");
    const { PrismaClient } = await import("../../generated/prisma/client");
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.TEST_DB_DADOS }) });
    const { carregarDadosAtualizadosCom } = await import("../../lib/dados-atualizados");
    await prisma.pipelineRun.deleteMany();
    await prisma.syncRequest.deleteMany();
    await prisma.auditLog.deleteMany();
    await prisma.utilizadorFarmacia.deleteMany();
    await prisma.utilizador.deleteMany();
    await prisma.farmacia.deleteMany();
    const A = await prisma.farmacia.create({ data: { nome: "Farm A" } });
    const B = await prisma.farmacia.create({ data: { nome: "Farm B" } });
    await prisma.farmacia.create({ data: { nome: "Farmácia Teste" } });
    await prisma.farmacia.create({ data: { nome: "Farm Inativa", estado: "INATIVO" } });
    const run = (farmaciaId: string, kind: string, status: string, updatedAt: string, k: string) =>
      prisma.pipelineRun.create({
        data: {
          farmaciaId, kind, status, updatedAt: new Date(updatedAt),
          startedAt: new Date("2020-01-01"), finishedAt: new Date("2030-01-01"), idempotencyKey: k,
        },
      });
    await run(A.id, "daily-pipeline", "OK", "2026-11-19T06:00:00Z", "k1");
    await run(A.id, "sync-now", "OK", "2026-11-19T12:00:00Z", "k2");
    await run(A.id, "daily-pipeline", "PARTIAL", "2026-11-19T13:00:00Z", "k3");
    await run(B.id, "daily-sync", "OK", "2026-11-19T05:00:00Z", "k4");
    await run(B.id, "aggregate-month", "OK", "2026-11-19T14:00:00Z", "k5");
    const gestor = { sub: "x", email: "x@x", nome: "x", perfil: "GESTOR_GRUPO", farmaciaId: null, tenant: "t" } as never;
    let d = await carregarDadosAtualizadosCom(prisma, gestor);
    check(d.farmacias.length === 2, "só farmácias ATIVAS e sem «Farmácia Teste»", d.farmacias.map((f) => f.nome).join(","));
    check(d.farmacias.find((f) => f.nome === "Farm A")?.ate === "2026-11-19T06:00:00.000Z", "A: ignora sync-now, PARTIAL e o finishedAt do agent (2030)");
    check(d.farmacias.find((f) => f.nome === "Farm B")?.ate === "2026-11-19T05:00:00.000Z", "B: daily-sync conta; aggregate-month não");
    check(d.ate === "2026-11-19T05:00:00.000Z", "cabeçalho = a mais antiga (B)");
    const op = { sub: "y", email: "y@y", nome: "y", perfil: "OPERADOR", farmaciaId: A.id, tenant: "t" } as never;
    d = await carregarDadosAtualizadosCom(prisma, op);
    check(d.farmacias.length === 1 && d.farmacias[0].nome === "Farm A" && d.ate === "2026-11-19T06:00:00.000Z", "operador só vê a sua farmácia");
    await prisma.pipelineRun.deleteMany();
    d = await carregarDadosAtualizadosCom(prisma, gestor);
    check(d.ate === null && d.farmacias.every((f) => f.ate === null), "sem corridas → «ainda não disponível»");
    await prisma.$disconnect();
  } else {
    console.log("\n(F · loader contra Postgres: ignorado — defina TEST_DB_DADOS)");
  }

  console.log(`\n${ok} OK, ${ko} falhas`);
  process.exit(ko ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
