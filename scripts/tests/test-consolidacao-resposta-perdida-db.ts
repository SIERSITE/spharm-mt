/**
 * scripts/tests/test-consolidacao-resposta-perdida-db.ts
 *
 * PostgreSQL REAL e DESCARTÁVEL (recusa correr fora de localhost):
 *
 *   docker run -d --name spharm-ws-test-pg -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:16-alpine
 *   npm run test:consolidacao-resposta-perdida-db
 *
 * Cobre, com o serviço REAL de servidor (dependências injectadas — sem sessão real):
 *   P · permissões por farmácia, reconciliação, isolamento entre utilizadores e tenants
 *   L · resposta perdida: o cliente NUNCA cria um segundo lote sozinho
 *   U · transições puras do estado da operação
 */
import Module from "node:module";
import { execSync } from "node:child_process";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";

const M = Module as unknown as { _resolveFilename: (r: string, ...a: unknown[]) => string };
const resolverOriginal = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "server-only" ? __filename : resolverOriginal.call(this, request, ...rest);
};

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  [OK]    ${msg}`); }
  else { failed++; console.log(`  [FALHA] ${msg}`); }
}

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgresql://postgres:test@localhost:55432/postgres";
const host = new URL(ADMIN_URL).hostname;
if (host !== "localhost" && host !== "127.0.0.1") {
  console.error(`RECUSADO: ${host} não é uma base local descartável.`);
  process.exit(2);
}
const urlDe = (db: string) => { const u = new URL(ADMIN_URL); u.pathname = `/${db}`; return u.toString(); };

async function main() {
  const sufixo = Date.now().toString(36);
  const dbT1 = `spharm_cons_${sufixo}`;
  const dbT2 = `spharm_cons2_${sufixo}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbT1}`);
  try {
    execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: urlDe(dbT1) }, encoding: "utf8" });

    const { PrismaClient } = await import("../../generated/prisma/client");
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(dbT1) }) });
    const serv = await import("../../lib/encomendas/consolidacao-servico");
    const op = await import("../../lib/encomendas/operacao-consolidacao");
    const { deriveFarmaciaIdempotencyKey } = await import("../../lib/ingest/orders");

    // ── dados base (tenant 1) ────────────────────────────────────────
    const farms = [];
    for (const n of ["F1", "F2", "F3"]) farms.push(await prisma.farmacia.create({ data: { nome: n } }));
    const [f1, f2, f3] = farms;
    const mk = (email: string, perfil: "ADMINISTRADOR" | "GESTOR_GRUPO" | "GESTOR_FARMACIA" | "OPERADOR", farmaciaId: string | null) =>
      prisma.utilizador.create({ data: { email, nome: email, perfil, farmaciaId } });
    const uAdmin = await mk("admin@t.pt", "ADMINISTRADOR", null);
    const uGrupo = await mk("grupo@t.pt", "GESTOR_GRUPO", null);
    const uOutroAdmin = await mk("admin2@t.pt", "ADMINISTRADOR", null);
    const uOper = await mk("oper@t.pt", "OPERADOR", f1.id);
    const uGestFarm = await mk("gf@t.pt", "GESTOR_FARMACIA", f1.id);
    const prods: Array<{ id: string }> = [];
    for (let i = 1; i <= 3; i++) prods.push(await prisma.produto.create({ data: { cnp: 7000 + i, designacao: `P${i}` } }));

    // template para o 2.º tenant (mesma forma, base separada)
    await prisma.$disconnect();
    await admin.query(`CREATE DATABASE ${dbT2} TEMPLATE ${dbT1}`);
    const prisma1 = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(dbT1) }) });
    const prisma2 = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(dbT2) }) });

    const sessao = (u: { id: string; perfil: string; farmaciaId: string | null }) => ({ sub: u.id, perfil: u.perfil, farmaciaId: u.farmaciaId });
    const deps = (u: { id: string; perfil: string; farmaciaId: string | null }, p = prisma1, audit?: () => Promise<void>) => ({
      prisma: p, tenantSlug: "t", sessao: sessao(u), auditar: audit,
    });
    const linhas = (qtd: number, i: number) => [
      { produtoId: prods[0].id, quantidadeSugerida: 5, quantidadeAjustada: qtd + i, notas: null, origem: "PROPOSTA" as const },
      { produtoId: prods[1].id, quantidadeSugerida: null, quantidadeAjustada: 2, notas: `n${i}`, origem: "MANUAL" as const },
    ];
    const snapshotDe = (qtd = 3, finalize = true, ids = [f1.id, f2.id, f3.id]) => ({
      nome: "Cons", finalize, contexto: '{"version":1,"mode":"consolidacao"}',
      lotes: ids.map((farmaciaId, i) => ({ farmaciaId, linhas: linhas(qtd, i) })),
    });
    const chavesDe = (k: string) => [f1.id, f2.id, f3.id].map((f) => deriveFarmaciaIdempotencyKey(k, f));
    const chaveNova = () => Array.from({ length: 24 }, () => "abcdefghijklmnop"[Math.floor(Math.random() * 16)]).join("");
    const contar = async (p = prisma1) => ({
      listas: await p.listaEncomenda.count({ where: { nome: { startsWith: "Cons" } } }),
      outbox: await p.orderOutbox.count(),
    });

    // ═══ P · PERMISSÕES ══════════════════════════════════════════════
    console.log("\nP · permissões e isolamento (servidor, antes da transacção de escrita)");
    const kP1 = chaveNova();
    const rAdmin = await serv.criarConsolidacaoServico(deps(uAdmin), { batchKey: kP1, ...snapshotDe(), lotes: snapshotDe().lotes });
    check(rAdmin.ok && rAdmin.listas.length === 3 && !rAdmin.reutilizado, "P1: administrador cria a consolidação de 3 farmácias");
    const c1 = await contar();
    check(c1.listas === 3 && c1.outbox === 3, "P1b: 3 listas e 3 outbox (finalize)");

    const rGrupo = await serv.criarConsolidacaoServico(deps(uGrupo), { batchKey: chaveNova(), ...snapshotDe() });
    check(rGrupo.ok, "P2: gestor de grupo mantém o comportamento autorizado");
    const antes = await contar();

    const rOper = await serv.criarConsolidacaoServico(deps(uOper), { batchKey: chaveNova(), ...snapshotDe() });
    check(!rOper.ok && rOper.code === "REJEITADO", "P3: operador da F1 com [F1,F2,F3] é recusado (F2/F3 não autorizadas)");
    check(JSON.stringify(await contar()) === JSON.stringify(antes), "P3b: lote com 1 farmácia não autorizada → ZERO listas e ZERO outbox novas");
    const rOperSo = await serv.criarConsolidacaoServico(deps(uOper), { batchKey: chaveNova(), ...snapshotDe(3, true, [f1.id]) });
    check(!rOperSo.ok && rOperSo.code === "REJEITADO", "P4: mesmo só com a sua farmácia, sem perfil de grupo é recusado");
    const rGF = await serv.criarConsolidacaoServico(deps(uGestFarm), { batchKey: chaveNova(), ...snapshotDe() });
    check(!rGF.ok && rGF.code === "REJEITADO", "P5: gestor de farmácia com farmácias alheias é recusado");
    check(JSON.stringify(await contar()) === JSON.stringify(antes), "P5b: nada gravado pelas recusas");

    const inval = await serv.criarConsolidacaoServico(deps(uAdmin), { batchKey: "curta", ...snapshotDe() });
    check(!inval.ok && inval.code === "REJEITADO", "P6: chave inválida recusada antes de escrever");
    const vazio = await serv.criarConsolidacaoServico(deps(uAdmin), { batchKey: chaveNova(), ...snapshotDe(), lotes: [{ farmaciaId: f1.id, linhas: [] }] });
    check(!vazio.ok && vazio.code === "REJEITADO", "P6b: farmácia sem linhas recusada antes de escrever");
    check(JSON.stringify(await contar()) === JSON.stringify(antes), "P6c: nada gravado pelas validações");

    // reconciliação
    const eAdmin = await serv.obterEstadoConsolidacaoServico(deps(uAdmin), { batchKey: kP1, farmaciaIds: [f1.id, f2.id, f3.id] });
    check(eAdmin.ok && eAdmin.estado === "CONCLUIDA" && eAdmin.listas.length === 3, "P7: o próprio utilizador reconcilia e obtém os 3 IDs");
    check(eAdmin.ok && eAdmin.estado === "CONCLUIDA" && eAdmin.listas.every((l) => l.versao === 0), "P7b: com as versões");
    const eOper = await serv.obterEstadoConsolidacaoServico(deps(uOper), { batchKey: kP1, farmaciaIds: [f1.id, f2.id] });
    check(!eOper.ok && eOper.code === "REJEITADO", "P8: a reconciliação também recusa farmácia não autorizada");
    const eOutro = await serv.obterEstadoConsolidacaoServico(deps(uOutroAdmin), { batchKey: kP1, farmaciaIds: [f1.id, f2.id, f3.id] });
    check(eOutro.ok && eOutro.estado === "CONFLITO" && !("listas" in eOutro), "P9: outro utilizador não reconcilia a chave alheia (sem IDs devolvidos)");
    const criaOutro = await serv.criarConsolidacaoServico(deps(uOutroAdmin), { batchKey: kP1, ...snapshotDe() });
    check(!criaOutro.ok && criaOutro.code === "IDEMPOTENCY_CONFLICT", "P9b: nem cria com a chave de outro utilizador");
    const eT2 = await serv.obterEstadoConsolidacaoServico(deps(uAdmin, prisma2), { batchKey: kP1, farmaciaIds: [f1.id, f2.id, f3.id] });
    check(eT2.ok && eT2.estado === "NAO_ENCONTRADA", "P10: outro tenant nunca encontra o lote");
    const c2antes = await contar(prisma2);
    const criaT2 = await serv.criarConsolidacaoServico(deps(uAdmin, prisma2), { batchKey: kP1, ...snapshotDe() });
    check(criaT2.ok && JSON.stringify(await contar()) === JSON.stringify(await contar(prisma1)) && (await contar(prisma2)).listas === c2antes.listas + 3,
      "P10b: criar noutro tenant com a mesma chave é independente e não altera o lote do tenant 1");
    check((await contar(prisma1)).listas === antes.listas, "P10c: o tenant 1 ficou intacto");

    let auditou = 0;
    const rAud = await serv.criarConsolidacaoServico(
      deps(uAdmin, prisma1, async () => { auditou++; throw new Error("auditoria em baixo"); }),
      { batchKey: chaveNova(), ...snapshotDe() }
    );
    check(rAud.ok && auditou === 3, "P11: falha da auditoria DEPOIS do commit não transforma sucesso em erro");

    // ═══ L · RESPOSTA PERDIDA ═════════════════════════════════════════
    console.log("\nL · resposta perdida: nunca um segundo lote automático");
    const fake = () => {
      const dados = new Map<string, string>();
      return { dados, getItem: (k: string) => dados.get(k) ?? null, setItem: (k: string, v: string) => void dados.set(k, v), removeItem: (k: string) => void dados.delete(k) };
    };
    type Modo = { perderResposta: boolean; falharAntesDeChegar: boolean; aoReconciliar?: () => Promise<void> };
    const mkApi = (u: typeof uAdmin, modo: Modo) => ({
      async criar(i: Parameters<typeof serv.criarConsolidacaoServico>[1]) {
        if (modo.falharAntesDeChegar) throw new Error("ECONNREFUSED (o pedido nunca chegou ao servidor)");
        const r = await serv.criarConsolidacaoServico(deps(u), i); // o servidor faz commit…
        if (modo.perderResposta) throw new Error("ECONNRESET (a resposta perdeu-se)"); // …e a resposta perde-se
        return r;
      },
      async reconciliar(i: { batchKey: string; farmaciaIds: string[] }) {
        const r = await serv.obterEstadoConsolidacaoServico(deps(u), i);
        if (modo.aoReconciliar) await modo.aoReconciliar();
        return r;
      },
    });
    const mkDeps = (st: ReturnType<typeof fake>, api: ReturnType<typeof mkApi>, chaves: string[]) => ({
      api, storage: st, chaveLS: op.chaveArmazenamentoOperacao("t", uAdmin.id, "nova"), gerarChave: () => chaves.shift()!,
    });
    const base0 = await contar();

    // L1-L4: commit feito, resposta perdida
    {
      const st = fake();
      const chaveOriginal = chaveNova();
      const modo: Modo = { perderResposta: true, falharAntesDeChegar: false };
      const api = mkApi(uAdmin, modo);
      const r1 = await op.executarConsolidacao(mkDeps(st, api, [chaveOriginal, chaveNova()]), snapshotDe(3, false));
      check(r1.tipo === "DESCONHECIDO", "L1: envio de 3 farmácias, commit feito, resposta perdida → RESULTADO_DESCONHECIDO");
      const guardada = op.lerOperacao(st, op.chaveArmazenamentoOperacao("t", uAdmin.id, "nova"));
      check(guardada?.estado === "RESULTADO_DESCONHECIDO" && guardada.chave === chaveOriginal && guardada.farmaciaIds.length === 3,
        "L2: chave original, snapshot e lista de farmácias mantidos e persistidos");
      const c = await contar();
      check(c.listas === base0.listas + 3, "L3: o servidor tem as 3 listas (rascunho, sem outbox)");

      // utilizador altera uma quantidade e tenta prosseguir — o servidor já não perde a resposta
      modo.perderResposta = false;
      const editado = snapshotDe(99, false);
      const chavesPendentes = [chaveNova()]; // se o cliente gerasse chave nova, sairia desta lista
      const r2 = await op.executarConsolidacao(mkDeps(st, api, chavesPendentes), editado);
      check(r2.tipo === "RECUPERADA", "L4: antes de criar, reconcilia a chave antiga e RECUPERA o lote existente");
      check(chavesPendentes.length === 1, "L4b: nenhuma chave nova foi gerada");
      const ids = r2.tipo === "RECUPERADA" ? r2.listas.map((l) => l.listaEncomendaId).sort() : [];
      const bd = (await prisma1.listaEncomenda.findMany({ where: { clientIdempotencyKey: { in: chavesDe(chaveOriginal) } }, select: { id: true } })).map((l) => l.id).sort();
      check(JSON.stringify(ids) === JSON.stringify(bd) && ids.length === 3, "L5: o servidor devolveu os 3 IDs existentes");
      check((await contar()).listas === base0.listas + 3 && (await contar()).outbox === base0.outbox, "L6: continuam a existir apenas as 3 listas do lote original (nenhum 2.º lote)");
      const dep = op.lerOperacao(st, op.chaveArmazenamentoOperacao("t", uAdmin.id, "nova"));
      check(dep?.estado === "CONCLUIDA" && dep.recuperada === true && dep.chave === chaveOriginal, "L7: estado CONCLUIDA por recuperação, com a chave original");
      const linhaBd = await prisma1.linhaEncomenda.findFirst({ where: { listaEncomendaId: ids[0], produtoId: prods[0].id } });
      check(Number(linhaBd?.quantidadeAjustada) !== 99 + 0 && Number(linhaBd?.quantidadeAjustada) < 99, "L7b: a edição feita depois NÃO foi aplicada em silêncio ao lote recuperado");

      // continuar a clicar: nunca cria outro
      const r3 = await op.executarConsolidacao(mkDeps(st, api, chavesPendentes), editado);
      check(r3.tipo === "RECUPERADA" && (await contar()).listas === base0.listas + 3, "L8: voltar a submeter continua a só recuperar (bloqueado até decisão explícita)");

      // decisão explícita
      const r4 = await op.executarConsolidacao(mkDeps(st, api, chavesPendentes), editado, { novoLoteExplicito: true });
      check(r4.tipo === "CRIADA" && chavesPendentes.length === 0, "L9: só a acção explícita gera nova chave e cria outro lote");
      check((await contar()).listas === base0.listas + 6, "L9b: agora existem 2 lotes (o original e o novo, este com as alterações)");
      const novos = await prisma1.linhaEncomenda.count({ where: { produtoId: prods[0].id, quantidadeAjustada: { gte: 99 } } });
      check(novos === 3, "L9c: o novo lote contém as alterações");
    }
    const base1 = await contar();

    // L10-L11: refresh durante RESULTADO_DESCONHECIDO + recuperação posterior
    {
      const st = fake();
      const k = chaveNova();
      const modo: Modo = { perderResposta: true, falharAntesDeChegar: false };
      await op.executarConsolidacao(mkDeps(st, mkApi(uAdmin, modo), [k]), snapshotDe(3, false));
      const depsRefresh = mkDeps(st, mkApi(uAdmin, { perderResposta: false, falharAntesDeChegar: false }), []);
      const rec = await op.reconciliarPendente(depsRefresh);
      check(rec?.tipo === "RECUPERADA" && (await contar()).listas === base1.listas + 3, "L10: depois de um refresh, a reconciliação recupera o lote sem criar outro");
      const semComm = mkDeps(st, mkApi(uAdmin, { perderResposta: false, falharAntesDeChegar: false }), []);
      semComm.api.reconciliar = async () => { throw new Error("sem rede"); };
      const st2 = fake();
      op.guardarOperacao(st2, semComm.chaveLS, op.iniciarOperacao(chaveNova(), snapshotDe(3, false)));
      const desc = await op.reconciliarPendente({ ...semComm, storage: st2 });
      check(desc?.tipo === "DESCONHECIDO" && desc.op.estado === "RESULTADO_DESCONHECIDO", "L11: A_SUBMETER encontrado depois do refresh + sem rede → continua RESULTADO_DESCONHECIDO (nada é criado)");
    }
    const base2 = await contar();

    // L12-L14: o servidor realmente NÃO fez commit
    {
      const st = fake();
      const k = chaveNova();
      const modo: Modo = { perderResposta: false, falharAntesDeChegar: true };
      const api = mkApi(uAdmin, modo);
      const r1 = await op.executarConsolidacao(mkDeps(st, api, [k]), snapshotDe(3, false));
      check(r1.tipo === "DESCONHECIDO" && (await contar()).listas === base2.listas, "L12: o pedido nunca chegou ao servidor: nada criado, operação desconhecida");
      modo.falharAntesDeChegar = false;
      const editado = snapshotDe(77, false);
      const r2 = await op.executarConsolidacao(mkDeps(st, api, [chaveNova()]), editado);
      check(r2.tipo === "CRIADA", "L13: o servidor confirma NAO_ENCONTRADA → repete a submissão");
      check((await contar()).listas === base2.listas + 3, "L13b: o retry cria apenas UM lote");
      const usadas = await prisma1.listaEncomenda.count({ where: { clientIdempotencyKey: { in: chavesDe(k) } } });
      check(usadas === 3, "L13c: o retry reutilizou a chave ORIGINAL (mesma intenção): 3 listas com as chaves derivadas dela");
      const comEdicao = await prisma1.linhaEncomenda.count({ where: { produtoId: prods[0].id, quantidadeAjustada: { gte: 77, lte: 79 } } });
      check(comEdicao === 3, "L13d: o lote criado no retry traz o payload actual (edição incluída)");
    }
    const base3 = await contar();

    // L15: corrida — o envio original chega DEPOIS de a reconciliação dizer NAO_ENCONTRADA
    {
      const st = fake();
      const k = chaveNova();
      const original = snapshotDe(3, false);
      const modo: Modo = { perderResposta: false, falharAntesDeChegar: true };
      const api = mkApi(uAdmin, modo);
      await op.executarConsolidacao(mkDeps(st, api, [k]), original); // desconhecido; nada chegou
      modo.falharAntesDeChegar = false;
      let disparou = false;
      modo.aoReconciliar = async () => {
        if (disparou) return;
        disparou = true; // o pedido original, atrasado, chega e faz commit AGORA
        await serv.criarConsolidacaoServico(deps(uAdmin), { batchKey: k, ...original });
      };
      const r = await op.executarConsolidacao(mkDeps(st, api, [chaveNova()]), snapshotDe(55, false));
      check(r.tipo === "RECUPERADA", "L15: pedido original atrasado + reenvio com payload novo → conflito reconciliado, lote RECUPERADO");
      check((await contar()).listas === base3.listas + 3, "L15b: continua a existir apenas um lote (3 listas novas no total)");
    }
    const base4 = await contar();

    // L16-L17: estados que bloqueiam
    {
      const st = fake();
      const chaveLS = op.chaveArmazenamentoOperacao("t", uAdmin.id, "nova");
      const conflito = op.comoConflito(op.iniciarOperacao(chaveNova(), snapshotDe()), "CHAVE_USADA_POR_OUTRO_PEDIDO");
      op.guardarOperacao(st, chaveLS, conflito);
      const r = await op.executarConsolidacao(mkDeps(st, mkApi(uAdmin, { perderResposta: false, falharAntesDeChegar: false }), [chaveNova()]), snapshotDe());
      check(r.tipo === "BLOQUEADA" && (await contar()).listas === base4.listas, "L16: CONFLITO bloqueia a criação automática");

      // lote incompleto (INCONSISTENTE): apaga 1 das 3 listas de um lote real
      const kInc = chaveNova();
      const rr = await serv.criarConsolidacaoServico(deps(uAdmin), { batchKey: kInc, ...snapshotDe(3, false) });
      if (!rr.ok) throw new Error("setup");
      await prisma1.listaEncomenda.delete({ where: { id: rr.listas[1].listaEncomendaId } });
      const st2 = fake();
      op.guardarOperacao(st2, chaveLS, op.comoDesconhecida(op.iniciarOperacao(kInc, snapshotDe(3, false))));
      const depoisInc = await contar();
      const r2 = await op.executarConsolidacao(mkDeps(st2, mkApi(uAdmin, { perderResposta: false, falharAntesDeChegar: false }), [chaveNova()]), snapshotDe(3, false));
      check(r2.tipo === "BLOQUEADA" && (await contar()).listas === depoisInc.listas, "L17: lote INCONSISTENTE (só parte existe) bloqueia e não cria nada");
    }

    // L18: recusa definitiva limpa a operação
    {
      const st = fake();
      const r = await op.executarConsolidacao(mkDeps(st, mkApi(uOper, { perderResposta: false, falharAntesDeChegar: false }), [chaveNova()]), snapshotDe());
      check(r.tipo === "REJEITADA" && op.lerOperacao(st, op.chaveArmazenamentoOperacao("t", uAdmin.id, "nova")) === null,
        "L18: recusa por permissão é definitiva — nenhuma operação pendente fica registada");
    }

    // ═══ U · transições puras ═════════════════════════════════════════
    console.log("\nU · estado da operação");
    {
      const o = op.iniciarOperacao(chaveNova(), snapshotDe());
      check(o.estado === "A_SUBMETER", "U1: nasce A_SUBMETER");
      check(op.aoRetomar(o)?.estado === "RESULTADO_DESCONHECIDO", "U2: A_SUBMETER após refresh → RESULTADO_DESCONHECIDO");
      check(op.aoRetomar(null) === null, "U3: sem registo → NAO_SUBMETIDA (null)");
      check(op.aoRetomar(op.comoConcluida(o, [], true))?.estado === "CONCLUIDA", "U4: CONCLUIDA não regride");
      check(op.impressaoSnapshot(snapshotDe(3)) !== op.impressaoSnapshot(snapshotDe(4)), "U5: a impressão distingue snapshots diferentes");
      const st = fake();
      st.setItem("k", "{corrompido");
      check(op.lerOperacao(st, "k") === null, "U6: registo corrompido é ignorado");
      st.setItem("k", JSON.stringify({ versao: 1, estado: "INVENTADO", chave: "x", farmaciaIds: [], snapshot: { lotes: [] } }));
      check(op.lerOperacao(st, "k") === null, "U7: estado desconhecido é ignorado");
      check(op.chaveArmazenamentoOperacao("t1", "u1", "w") !== op.chaveArmazenamentoOperacao("t2", "u1", "w") &&
        op.chaveArmazenamentoOperacao("t1", "u1", "w") !== op.chaveArmazenamentoOperacao("t1", "u2", "w") &&
        op.chaveArmazenamentoOperacao("t1", "u1", "w") !== op.chaveArmazenamentoOperacao("t1", "u1", "w2"),
        "U8: o registo é isolado por tenant + utilizador + workspace");
    }

    await prisma1.$disconnect();
    await prisma2.$disconnect();
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${dbT2} WITH (FORCE)`);
    await admin.query(`DROP DATABASE IF EXISTS ${dbT1} WITH (FORCE)`);
    await admin.end();
  }

  console.log(`\n${passed} ok, ${failed} falhas`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
