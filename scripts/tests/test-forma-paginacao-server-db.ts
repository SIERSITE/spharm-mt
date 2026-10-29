/**
 * scripts/tests/test-forma-paginacao-server-db.ts
 *
 * Filtro «Forma farmacêutica» em EXCESSOS, TRANSFERÊNCIAS, DEVOLUÇÕES e na LISTA DE ENCOMENDAS, com os produtos que
 * correspondem APENAS depois do ponto de corte do servidor (top-200 dos Excessos/Transferências; página 3 da lista de
 * Encomendas), contra PostgreSQL REAL e DESCARTÁVEL (recusa hosts não locais), dados SINTÉTICOS.
 *
 *   E · Excessos        — corte servidor dos 200 artigos mais relevantes: o filtro tem de ir ANTES do corte
 *   T · Transferências  — idem (200 linhas por prioridade/cobertura do destino)
 *   D · Devoluções      — sem corte servidor (dataset completo + filtro cliente): prova que o cliente é correcto
 *   O · Lista de Encomendas — paginação servidor (skip/take) + contagem + nº de páginas
 *
 * Cada área prova: aparecem · contagem · totais EXACTOS (somas feitas à mão sobre o dataset) · «Sem forma farmacêutica»
 * · união de várias formas · filtro vazio = comportamento actual · «Limpar filtros» repõe o conjunto inicial ·
 * combinação com fabricante/grupo (Garantia), pesquisa e farmácias · variantes de espaços/acentos/maiúsculas = uma só.
 *
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres npx tsx scripts/tests/test-forma-paginacao-server-db.ts
 */
import Module from "node:module";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";

const estado: { tenant: string | null; prisma: unknown } = { tenant: null, prisma: null };
const M = Module as unknown as { _resolveFilename: (r: string, ...a: unknown[]) => string; _load: (r: string, ...a: unknown[]) => unknown };
const resolverOriginal = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "server-only" ? __filename : resolverOriginal.call(this, request, ...rest);
};
const loadOriginal = M._load;
M._load = function (request: string, ...rest: unknown[]) {
  if (request === "@/lib/prisma") return { getPrisma: async () => estado.prisma };
  if (request === "@/lib/tenant-context") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const constantes = require("../../lib/tenant-constants");
    return { ...constantes, resolveCurrentTenantSlug: async () => estado.tenant };
  }
  return loadOriginal.call(this, request, ...rest);
};

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${label}`); }
  else { ko++; console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`); }
};
const secao = (t: string) => console.log(`\n── ${t}`);
const src = (f: string) => readFileSync(f, "utf8").replace(/\r\n/g, "\n");
const ordenado = (xs: Iterable<string | number>) => [...xs].map(String).sort();
const mesmo = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const soma = (xs: number[]) => xs.reduce((s, n) => s + n, 0);

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgresql://postgres:test@localhost:15433/postgres";
const host = new URL(ADMIN_URL).hostname;
if (host !== "localhost" && host !== "127.0.0.1") {
  console.error(`RECUSADO: ${host} não é uma base local descartável.`);
  process.exit(2);
}
const urlDe = (db: string) => {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${db}`;
  return u.toString();
};

async function main() {
  const db = `spharm_forma_pg_${Date.now().toString(36)}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${db}`);
  try {
    execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: urlDe(db) }, encoding: "utf8", stdio: "pipe" });
    process.env.DATABASE_URL = urlDe(db);
    process.env.ALLOW_LEGACY_DATABASE_FALLBACK = "1";
    const { PrismaClient } = await import("../../generated/prisma/client");
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(db) }) });
    estado.prisma = prisma;
    estado.tenant = null; // defaults da policy; limiares passados explicitamente abaixo

    const F = await import("../../lib/catalog/forma-farmaceutica-filtro");
    const { SEM_FORMA, chaveFormaFarmaceutica, passaFiltroForma } = F;
    const { getExcessosData, getTransferenciasData } = await import("../../lib/transferencias-data");
    const { getDevolucoesData } = await import("../../lib/devolucoes-data");
    const { carregarOpcoesFormaFarmaceutica } = await import("../../lib/catalog/forma-farmaceutica-sql");
    const { loadOrderListData } = await import("../../lib/encomendas/orders-data");
    const { passaFiltroLaboratorioLinha } = await import("../../lib/reporting/filtro-laboratorio-linhas");

    // ── Fixture sintética ────────────────────────────────────────────────────────────────────────────────────
    //
    // 230 produtos «cedo» (formas Xarope/Pomada/Solução oral) que enchem o topo de Excessos/Transferências e 9 produtos
    // «tarde» (as formas pesquisadas) que ficam DEPOIS da posição 200 em ambos os relatórios.
    //
    //   Farmácia 1 (origem):  vendas 9 na janela (média 0,1/dia) · stock S  -> cobertura 10·S dias; excesso = S − 3
    //   Farmácia 2 (destino): vendas 90 na janela (média 1/dia)  · stock T2 -> necessidade = 30 − T2; cobertura = T2 dias
    //   janela 2026-01-01..2026-03-31 (90 dias) · threshold 60 · alvo 30
    //
    // cedo : S = 500 + i  (cobertura ≥ 5000 -> topo dos Excessos) · T2 = 2  (cobertura 2 < 7 -> prioridade «alta»)
    // tarde: S = 40 + 3k  (cobertura ≥ 400)                         · T2 = 10 (cobertura 10 -> «media», depois das altas)
    const f1 = await prisma.farmacia.create({ data: { nome: "PG Farmácia Um" } });
    const f2 = await prisma.farmacia.create({ data: { nome: "PG Farmácia Dois" } });
    const user = await prisma.utilizador.create({ data: { email: "pg@t.pt", nome: "PG", perfil: "ADMINISTRADOR" } });
    const fabA = await prisma.fabricante.create({ data: { nomeNormalizado: "PG ALFA FAB", estado: "ATIVO" } });
    const fabB = await prisma.fabricante.create({ data: { nomeNormalizado: "PG BETA FAB", estado: "ATIVO" } });
    const forn = await prisma.fornecedor.create({ data: { nomeNormalizado: "PG FORN", estado: "ATIVO" } });

    const N_CEDO = 230;
    const FORMAS_CEDO = ["Xarope", "Pomada", "Solução oral"];
    const TARDE = [
      { k: 0, forma: "Comprimido" as string | null, fab: fabA },
      { k: 1, forma: " COMPRIMIDO ", fab: fabA },
      { k: 2, forma: "comprimido", fab: fabB },
      { k: 3, forma: "Comprimido revestido", fab: fabA },
      { k: 4, forma: "COMPRIMIDO   REVESTIDO", fab: fabA },
      { k: 5, forma: "Cápsula", fab: fabA },
      { k: 6, forma: "CAPSULA", fab: fabA },
      { k: 7, forma: null, fab: fabA },
      { k: 8, forma: "   ", fab: fabA },
    ];
    const cnpCedo = (i: number) => 8_400_000 + i;
    const cnpTarde = (k: number) => 8_450_000 + k;
    const sTarde = (k: number) => 40 + 3 * k;

    const prodId = new Map<number, string>();
    await prisma.produto.createMany({
      data: [
        ...Array.from({ length: N_CEDO }, (_, i) => ({ cnp: cnpCedo(i), designacao: `PG cedo ${i}`, estado: "VALIDADO" as const, fabricanteId: fabB.id, formaFarmaceutica: FORMAS_CEDO[i % 3] })),
        ...TARDE.map((t) => ({ cnp: cnpTarde(t.k), designacao: `PG tarde ${t.k}`, estado: "VALIDADO" as const, fabricanteId: t.fab.id, formaFarmaceutica: t.forma })),
      ],
    });
    for (const p of await prisma.produto.findMany({ select: { id: true, cnp: true } })) prodId.set(Number(p.cnp), p.id);
    const todosCnps = [...Array.from({ length: N_CEDO }, (_, i) => cnpCedo(i)), ...TARDE.map((t) => cnpTarde(t.k))];
    const pf = [];
    const vendas = [];
    for (const cnp of todosCnps) {
      const e = cnp < 8_450_000;
      const idx = e ? cnp - 8_400_000 : cnp - 8_450_000;
      const produtoId = prodId.get(cnp)!;
      pf.push({ produtoId, farmaciaId: f1.id, pvp: 5, pmc: 4, puc: 2, stockAtual: e ? 500 + idx : sTarde(idx), stockMinimo: 0, stockMaximo: 9999, fornecedorHabitualId: forn.id });
      pf.push({ produtoId, farmaciaId: f2.id, pvp: 5, pmc: 4, puc: 2, stockAtual: e ? 2 : 10, stockMinimo: 0, stockMaximo: 9999, fornecedorHabitualId: forn.id });
      vendas.push({ farmaciaId: f1.id, produtoId, ano: 2026, mes: 2, quantidade: 9, valorTotal: 45, valorBruto: 45, naturezaVenda: "NORMAL" as const });
      vendas.push({ farmaciaId: f2.id, produtoId, ano: 2026, mes: 2, quantidade: 90, valorTotal: 450, valorBruto: 450, naturezaVenda: "NORMAL" as const });
    }
    await prisma.produtoFarmacia.createMany({ data: pf });
    await prisma.vendaMensal.createMany({ data: vendas });

    const OPC = { thresholdDays: 60, targetDays: 30, dataInicio: "2026-01-01", dataFim: "2026-03-31" } as const;
    const kc = (...ks: number[]) => ks.map((k) => String(cnpTarde(k)));
    const COMP = kc(0, 1, 2);
    const REVEST = kc(3, 4);
    const CAPS = kc(5, 6);
    const SEMF = kc(7, 8);
    const TODOS_TARDE = kc(0, 1, 2, 3, 4, 5, 6, 7, 8);
    const KCOMP = chaveFormaFarmaceutica("Comprimido");
    const KREV = chaveFormaFarmaceutica("Comprimido revestido");
    const KCAPS = chaveFormaFarmaceutica("Cápsula");

    check(KCOMP === "comprimido" && KREV === "comprimido revestido" && KCAPS === "capsula", "pré-condição: as chaves normalizadas (sem acentos/caixa/espaços) são as esperadas");
    check(chaveFormaFarmaceutica("COMPRIMIDO   REVESTIDO") === KREV && chaveFormaFarmaceutica(" COMPRIMIDO ") === KCOMP, "pré-condição: variantes de espaços/maiúsculas têm a MESMA chave");

    // Somas à mão: excesso = S − 3 = 37 + 3k.   k0..2 = 37+40+43 = 120 · k3..4 = 46+49 = 95 · k5..6 = 52+55 = 107 · k7..8 = 58+61 = 119
    const EXC = { comp: 120, rev: 95, caps: 107, sem: 119 };
    // Transferência sugerida = min(excesso, 30 − T2 = 20, transferível ≥ 37) = 20 por linha.
    const porLinha = 20;

    const cnpsDe = (rows: Array<{ cnp: string }>) => ordenado(rows.map((r) => r.cnp));
    const exc = (formas?: string[]) => getExcessosData({ ...OPC, ...(formas ? { formasFarmaceuticas: formas } : {}) });
    const trf = (formas?: string[]) => getTransferenciasData({ ...OPC, ...(formas ? { formasFarmaceuticas: formas } : {}) });
    const tot = (rows: Awaited<ReturnType<typeof exc>>) => ({
      linhas: rows.length,
      referencias: new Set(rows.map((r) => r.cnp)).size,
      excesso: soma(rows.map((r) => r.excessoOrigem)),
      sugerida: soma(rows.map((r) => r.quantidadeSugerida)),
      custo: soma(rows.map((r) => r.valorCustoExcesso ?? 0)),
      pvp: soma(rows.map((r) => r.valorPvpExcesso ?? 0)),
    });

    // ═══ E · Excessos ═══
    secao("E · Excessos (corte servidor de 200 linhas)");
    const e0 = await exc();
    check(e0.length === 200, "E1: sem filtro o servidor devolve só 200 linhas (239 artigos com excesso)", `n=${e0.length}`);
    check(!e0.some((r) => TODOS_TARDE.includes(r.cnp)), "E2: nenhum dos 9 artigos «tarde» chega ao browser sem filtro -> um filtro SÓ no cliente devolveria 0 linhas");
    check(e0.filter((r) => passaFiltroForma(r.formaChave, [KCOMP])).length === 0, "E3: o filtro cliente antigo (row.formaChave sobre as 200 linhas) dava 0 para «Comprimido» — a razão desta mudança");

    const eComp = await exc([KCOMP]);
    check(mesmo(cnpsDe(eComp), ordenado(COMP)), "E4: «Comprimido» aparece — 3 linhas, as 3 variantes (Comprimido/ COMPRIMIDO /comprimido) como UMA forma", cnpsDe(eComp).join(","));
    check(tot(eComp).excesso === EXC.comp && tot(eComp).custo === 4 * EXC.comp && tot(eComp).pvp === 5 * EXC.comp, `E5: totais exactos de «Comprimido»: unidades em excesso = ${EXC.comp}, custo (PMC 4) = ${4 * EXC.comp}, PVP = ${5 * EXC.comp}`, JSON.stringify(tot(eComp)));
    check(tot(eComp).linhas === 3 && tot(eComp).referencias === 3 && tot(eComp).sugerida === 3 * porLinha, "E6: contagem (linhas/referências) e unidades sugeridas = 3 / 3 / 60", JSON.stringify(tot(eComp)));
    const eRev = await exc([KREV]);
    check(mesmo(cnpsDe(eRev), ordenado(REVEST)) && tot(eRev).excesso === EXC.rev, `E7: «Comprimido revestido» (2 variantes de espaços) = 2 linhas, ${EXC.rev} unidades`, JSON.stringify(tot(eRev)));
    const eCaps = await exc([KCAPS]);
    check(mesmo(cnpsDe(eCaps), ordenado(CAPS)) && tot(eCaps).excesso === EXC.caps, `E8: «Cápsula»/«CAPSULA» (acentos) = 2 linhas, ${EXC.caps} unidades`, JSON.stringify(tot(eCaps)));
    const eSem = await exc([SEM_FORMA]);
    check(mesmo(cnpsDe(eSem), ordenado(SEMF)) && tot(eSem).excesso === EXC.sem, `E9: «Sem forma farmacêutica» (nulo e só espaços, em posições tardias) = 2 linhas, ${EXC.sem} unidades`, JSON.stringify(tot(eSem)));
    check(eSem.every((r) => r.formaChave === SEM_FORMA), "E10: todas as linhas «sem forma» levam a chave SEM_FORMA");
    const eUniao = await exc([KCOMP, KCAPS, SEM_FORMA]);
    check(mesmo(cnpsDe(eUniao), ordenado([...COMP, ...CAPS, ...SEMF])) && tot(eUniao).excesso === EXC.comp + EXC.caps + EXC.sem, `E11: união Comprimido + Cápsula + Sem forma = 7 linhas, ${EXC.comp + EXC.caps + EXC.sem} unidades`, JSON.stringify(tot(eUniao)));
    const eTodasTarde = await exc([KCOMP, KREV, KCAPS, SEM_FORMA]);
    check(eTodasTarde.length === 9 && tot(eTodasTarde).excesso === EXC.comp + EXC.rev + EXC.caps + EXC.sem, "E12: as quatro formas «tardias» = 9 linhas, 441 unidades (120+95+107+119)", JSON.stringify(tot(eTodasTarde)));
    check((await exc([chaveFormaFarmaceutica("forma que não existe")])).length === 0, "E13: forma sem produtos -> 0 linhas (e não o conjunto completo)");
    const eInexistenteMisto = await exc([KCAPS, "inexistente"]);
    check(mesmo(cnpsDe(eInexistenteMisto), ordenado(CAPS)), "E14: chave inexistente + chave válida = só a válida");
    // Filtro vazio / «Limpar filtros»
    const eVazio = await exc([]);
    check(mesmo(eVazio.map((r) => r.cnp + r.farmaciaOrigem), e0.map((r) => r.cnp + r.farmaciaOrigem)) && tot(eVazio).excesso === tot(e0).excesso, "E15: filtro vazio ([]) = resultado e ordem idênticos ao pedido sem o parâmetro (200 linhas)");
    await exc([KCOMP]); // aplica um filtro
    const eLimpo = await exc([]); // «Limpar filtros» + novo pedido
    check(eLimpo.length === 200 && mesmo(eLimpo.map((r) => r.cnp), e0.map((r) => r.cnp)) && mesmo(tot(eLimpo), tot(e0)), "E16: «Limpar filtros» (voltar a pedir sem forma) repõe exactamente o conjunto e os totais iniciais");
    // Chaves forjadas / lixo
    const eForjada = await exc([" COMPRIMIDO ", "Comprimido"] as string[]);
    check(mesmo(cnpsDe(eForjada), ordenado(COMP)), "E17: o servidor re-normaliza chaves (input de Server Action): ' COMPRIMIDO ' + 'Comprimido' = a mesma forma, sem duplicar linhas");
    // Combinações (refinamento cliente sobre o resultado já filtrado no servidor)
    const lab = (cnps: string[]) => ({ modoGrupos: true, cnps: new Set(cnps) });
    const eFab = eComp.filter((r) => passaFiltroLaboratorioLinha(r, ["PG ALFA FAB"], { modoGrupos: false, cnps: null }));
    check(mesmo(cnpsDe(eFab), ordenado(kc(0, 1))) && tot(eFab).excesso === 37 + 40, "E18: Comprimido ∩ fabricante PG ALFA FAB = 2 linhas, 77 unidades (37+40)", JSON.stringify(tot(eFab)));
    const eGrupo = eComp.filter((r) => passaFiltroLaboratorioLinha(r, ["grupo:g1"], lab([...kc(1, 2), String(cnpCedo(5))])));
    check(mesmo(cnpsDe(eGrupo), ordenado(kc(1, 2))) && tot(eGrupo).excesso === 40 + 43, "E19: Comprimido ∩ grupo laboratorial (Garantia; pertença por CNP) = 2 linhas, 83 unidades (40+43)", JSON.stringify(tot(eGrupo)));
    const ePesq = eUniao.filter((r) => `${r.cnp} ${r.produto}`.toLowerCase().includes("tarde 5"));
    check(ePesq.length === 1 && ePesq[0].cnp === String(cnpTarde(5)), "E20: pesquisa por artigo ('tarde 5') sobre a união filtrada = 1 linha (a Cápsula k=5)");
    check(eUniao.every((r) => r.farmaciaOrigem === "PG Farmácia Um" && r.farmaciaDestino === "PG Farmácia Dois"), "E21: farmácia origem/destino correcta nas linhas filtradas (origem Um, destino Dois)");
    check(eUniao.filter((r) => r.farmaciaOrigem === "PG Farmácia Dois").length === 0, "E22: filtro cliente de farmácia origem = Dois sobre o resultado filtrado -> 0 linhas (sem erro)");
    // Corte aplicado DEPOIS do filtro: Xarope (77 produtos) cabe; verifica ordem por cobertura
    const eXarope = await exc([chaveFormaFarmaceutica("Xarope")]);
    check(eXarope.length === Math.ceil(N_CEDO / 3) && eXarope.every((r) => r.formaChave === "xarope"), "E23: forma «cedo» (Xarope, 77) = 77 linhas, todas Xarope (sem corte inesperado)", `n=${eXarope.length}`);
    check(eXarope.every((r, i, a) => i === 0 || a[i - 1].coberturaOrigem >= r.coberturaOrigem), "E24: a ordenação por cobertura da origem mantém-se nas linhas filtradas");
    const eXaropeMais = await exc([chaveFormaFarmaceutica("Xarope"), KCOMP]);
    check(eXaropeMais.length === 77 + 3, "E25: Xarope + Comprimido = 80 linhas (o corte de 200 age sobre o filtrado, não sobre o universo)");

    // ═══ T · Transferências ═══
    secao("T · Transferências (corte servidor de 200 linhas)");
    const t0 = await trf();
    check(t0.length === 200 && !t0.some((r) => TODOS_TARDE.includes(r.cnp)), "T1: sem filtro 200 linhas e nenhum artigo «tarde» (todas as 230 «cedo» são prioridade alta e ficam à frente)", `n=${t0.length}`);
    check(t0.every((r) => r.prioridade === "alta"), "T2: as 200 linhas do topo são todas de prioridade alta");
    check(t0.filter((r) => passaFiltroForma(r.formaChave, [KCOMP])).length === 0, "T3: o filtro cliente antigo dava 0 linhas para «Comprimido»");
    const tComp = await trf([KCOMP]);
    check(mesmo(cnpsDe(tComp), ordenado(COMP)) && tComp.every((r) => r.prioridade === "media"), "T4: «Comprimido» aparece — 3 linhas, prioridade média", cnpsDe(tComp).join(","));
    check(tot(tComp).sugerida === 3 * porLinha && tot(tComp).excesso === EXC.comp, `T5: totais exactos: ${3 * porLinha} unidades sugeridas (3×20), ${EXC.comp} em excesso`, JSON.stringify(tot(tComp)));
    const tSem = await trf([SEM_FORMA]);
    check(mesmo(cnpsDe(tSem), ordenado(SEMF)) && tot(tSem).sugerida === 2 * porLinha, "T6: «Sem forma farmacêutica» = 2 linhas (nulo e espaços), 40 unidades sugeridas", JSON.stringify(tot(tSem)));
    const tUniao = await trf([KCOMP, KREV, KCAPS, SEM_FORMA]);
    check(tUniao.length === 9 && tot(tUniao).sugerida === 9 * porLinha && tot(tUniao).excesso === 441, "T7: união das 4 formas = 9 linhas, 180 sugeridas, 441 em excesso", JSON.stringify(tot(tUniao)));
    check(mesmo(cnpsDe(await trf([])), cnpsDe(t0)), "T8: filtro vazio = resultado actual (as mesmas 200 linhas)");
    const tLimpo = await trf([]);
    check(mesmo(tLimpo.map((r) => r.cnp), t0.map((r) => r.cnp)) && mesmo(tot(tLimpo), tot(t0)), "T9: «Limpar filtros» repõe as linhas e os totais iniciais");
    const tFab = tUniao.filter((r) => passaFiltroLaboratorioLinha(r, ["PG BETA FAB"], { modoGrupos: false, cnps: null }));
    check(mesmo(cnpsDe(tFab), ordenado(kc(2))), "T10: união ∩ fabricante PG BETA FAB = só o Comprimido k=2");
    const tGrupo = tUniao.filter((r) => passaFiltroLaboratorioLinha(r, ["grupo:g1"], lab(kc(3, 5, 7))));
    check(mesmo(cnpsDe(tGrupo), ordenado(kc(3, 5, 7))) && tot(tGrupo).sugerida === 3 * porLinha, "T11: união ∩ grupo laboratorial (3 CNP) = 3 linhas, 60 unidades");
    check((await trf([chaveFormaFarmaceutica("Xarope")])).length === 77, "T12: forma «cedo» (Xarope) = 77 linhas");
    check(tUniao.every((r) => r.farmaciaOrigem === "PG Farmácia Um" && r.farmaciaDestino === "PG Farmácia Dois"), "T13: origem/destino correctos (emparelhamento por produto intacto com o filtro em SQL)");

    // ═══ D · Devoluções ═══
    secao("D · Devoluções (sem corte servidor: dataset completo + filtro/totais no cliente)");
    const codeDev = src("lib/devolucoes-data.ts");
    check(!/\btake\s*:/.test(codeDev) && !/\bskip\s*:/.test(codeDev) && !/\.slice\(0,\s*\d+\)(?!\s*[,;)]?\s*\/\/)/.test(codeDev.replace(/toISOString\(\)\.slice\(0, 10\)/g, "")), "D1: lib/devolucoes-data.ts não tem take/skip/slice(0,N) — nenhum corte servidor sobre as linhas");
    // 300 devoluções: 291 «Xarope» (mais recentes) + as 9 «tarde» (mais antigas), todas dentro do período
    const prodXarope = prodId.get(cnpCedo(0))!;
    const agora = Date.now();
    const dev = [];
    for (let i = 0; i < 291; i++) dev.push({ farmaciaId: i % 2 === 0 ? f1.id : f2.id, produtoId: prodXarope, data: new Date(agora - i * 60_000), quantidade: 1, valor: 10, tipo: "FORNECEDOR" as const, motivo: "m", fornecedorDestinoId: forn.id });
    for (const t of TARDE) dev.push({ farmaciaId: t.k % 2 === 0 ? f1.id : f2.id, produtoId: prodId.get(cnpTarde(t.k))!, data: new Date(agora - (300 + t.k) * 60_000), quantidade: t.k + 1, valor: (t.k + 1) * 10, tipo: "FORNECEDOR" as const, motivo: "m", fornecedorDestinoId: forn.id });
    await prisma.devolucao.createMany({ data: dev });
    const dRows = await getDevolucoesData();
    check(dRows.length === 300, "D2: o servidor entrega as 300 linhas (sem corte) — o filtro cliente vê TODAS", `n=${dRows.length}`);
    const filtroDev = (formas: string[]) => dRows.filter((r) => passaFiltroForma(r.formaChave, formas));
    const totDev = (rows: typeof dRows) => ({ linhas: rows.length, qty: soma(rows.map((r) => r.quantidade)), valor: soma(rows.map((r) => r.valor)) });
    // quantidade = k+1, valor = 10·(k+1): COMP k0..2 -> 1+2+3 = 6 / 60 · REV k3..4 -> 4+5 = 9 / 90 · CAPS k5..6 -> 6+7 = 13 / 130 · SEM k7..8 -> 8+9 = 17 / 170
    const dComp = filtroDev([KCOMP]);
    check(mesmo(cnpsDe(dComp), ordenado(COMP)) && mesmo(totDev(dComp), { linhas: 3, qty: 6, valor: 60 }), "D3: «Comprimido» (3 variantes) = 3 linhas, quantidade 6, valor 60", JSON.stringify(totDev(dComp)));
    const dSem = filtroDev([SEM_FORMA]);
    check(mesmo(cnpsDe(dSem), ordenado(SEMF)) && mesmo(totDev(dSem), { linhas: 2, qty: 17, valor: 170 }), "D4: «Sem forma farmacêutica» = 2 linhas, quantidade 17, valor 170", JSON.stringify(totDev(dSem)));
    const dUniao = filtroDev([KREV, KCAPS]);
    check(dUniao.length === 4 && mesmo(totDev(dUniao), { linhas: 4, qty: 22, valor: 220 }), "D5: união Revestido + Cápsula = 4 linhas, quantidade 22, valor 220", JSON.stringify(totDev(dUniao)));
    check(mesmo(totDev(filtroDev([])), totDev(dRows)) && totDev(dRows).linhas === 300, "D6: filtro vazio = as 300 linhas e os totais iniciais; «Limpar filtros» repõe-nos (mesma função, sem pedido)");
    const dFab = dComp.filter((r) => passaFiltroLaboratorioLinha(r, ["PG ALFA FAB"], { modoGrupos: false, cnps: null }));
    check(dFab.length === 2 && totDev(dFab).valor === 30, "D7: Comprimido ∩ fabricante PG ALFA FAB = 2 linhas, valor 30");
    check(dComp.filter((r) => r.farmacia === "PG Farmácia Um").length === 2 && dComp.filter((r) => r.fornecedor === "PG FORN").length === 3, "D8: combinação com farmácia (k=0,2 -> Um) e fornecedor correcta");
    check(dRows.filter((r) => r.produto.includes("tarde 3")).length === 1 && filtroDev([KREV]).filter((r) => r.produto.includes("tarde 3")).length === 1, "D9: pesquisa por artigo combina com a forma");
    const clienteDev = src("components/devolucoes/devolucoes-client.tsx");
    check(/passaFiltroForma\(/.test(clienteDev) && /filteredRows/.test(clienteDev) && /limparFiltros/.test(clienteDev), "D10: a página aplica passaFiltroForma em filteredRows (de onde vêm agrupamento, totais e exportação) e tem «Limpar filtros»");

    // ═══ O · Lista de Encomendas ═══
    secao("O · Lista de Encomendas (paginação servidor, skip/take)");
    const base = Date.UTC(2026, 0, 1);
    // 60 encomendas: índice i = 0 (mais antiga) .. 59. As 9 mais antigas (i = k) levam a linha «tarde k» + uma linha «cedo».
    for (let i = 0; i < 60; i++) {
      const produtosLinhas = i < 9 ? [prodId.get(cnpTarde(i))!, prodId.get(cnpCedo(i))!] : [prodId.get(cnpCedo(10 + (i % 50)))!];
      await prisma.listaEncomenda.create({
        data: {
          nome: `PG Enc ${String(i).padStart(2, "0")}`,
          estado: i === 4 ? "ANULADA" : "FINALIZADA",
          farmaciaId: i % 2 === 0 ? f1.id : f2.id,
          criadoPorId: user.id,
          dataCriacao: new Date(base + i * 86_400_000),
          linhas: { create: produtosLinhas.map((produtoId) => ({ produtoId, quantidadeAjustada: 1 })) },
        },
      });
    }
    const lista = (formas: string[] | undefined, extra: Record<string, unknown> = {}, pageSize = 25, page = 1) =>
      loadOrderListData(prisma, { page, pageSize, ...(formas ? { formas } : {}), ...extra } as Parameters<typeof loadOrderListData>[1]);
    const nomes = (d: Awaited<ReturnType<typeof lista>>) => d.orders.map((o) => o.nome);
    const nomeTarde = (...ks: number[]) => ks.map((k) => `PG Enc ${String(k).padStart(2, "0")}`);

    const o0 = await lista(undefined);
    check(o0.total === 59 && o0.totalPages === 3, "O1: sem filtro 59 encomendas (a ANULADA fica de fora), 3 páginas de 25", `total=${o0.total} pages=${o0.totalPages}`);
    const o0p1 = nomes(o0);
    const o0p2 = nomes(await lista(undefined, {}, 25, 2));
    check(!o0p1.some((n) => nomeTarde(0, 1, 2, 3, 5, 6, 7, 8).includes(n)) && !o0p2.some((n) => nomeTarde(0, 1, 2, 3, 5, 6, 7, 8).includes(n)), "O2: as encomendas com as formas pesquisadas só existem na página 3 (nem a 1 nem a 2 as têm) — um filtro SÓ no cliente nunca as veria");
    const oComp = await lista([KCOMP]);
    check(oComp.total === 3 && oComp.totalPages === 1 && mesmo(nomes(oComp).sort(), nomeTarde(0, 1, 2)), "O3: «Comprimido» (página 1) mostra as 3 encomendas que estavam na página 3; total 3; 1 página", `total=${oComp.total} ${nomes(oComp).join(",")}`);
    check(oComp.orders.every((o) => o.linhasCount === 2), "O4: a encomenda aparece INTEIRA (2 linhas: a da forma + a outra) — linhasCount é do documento");
    const oRev = await lista([KREV]);
    check(oRev.total === 1 && mesmo(nomes(oRev), nomeTarde(3)), "O5: «Comprimido revestido» = 1 (a Enc 04 está ANULADA e fica fora por omissão)", `total=${oRev.total}`);
    const oRevAn = await lista([KREV], { mostrarAnuladas: true });
    check(oRevAn.total === 2 && mesmo(nomes(oRevAn).sort(), nomeTarde(3, 4)), "O6: com «Mostrar anuladas» = 2 (Enc 03 e Enc 04)");
    const oSem = await lista([SEM_FORMA]);
    check(oSem.total === 2 && mesmo(nomes(oSem).sort(), nomeTarde(7, 8)), "O7: «Sem forma farmacêutica» = 2 encomendas (nulo e espaços), na página 3 sem filtro");
    const oUniao = await lista([KCOMP, KCAPS, SEM_FORMA]);
    check(oUniao.total === 7 && mesmo(nomes(oUniao).sort(), nomeTarde(0, 1, 2, 5, 6, 7, 8)), "O8: união Comprimido + Cápsula + Sem forma = 7");
    // Paginação sobre o resultado filtrado
    const p1 = await lista([KCOMP, KCAPS, SEM_FORMA], {}, 3, 1);
    const p2 = await lista([KCOMP, KCAPS, SEM_FORMA], {}, 3, 2);
    const p3 = await lista([KCOMP, KCAPS, SEM_FORMA], {}, 3, 3);
    check(p1.total === 7 && p1.totalPages === 3 && p1.orders.length === 3 && p2.orders.length === 3 && p3.orders.length === 1, "O9: pageSize 3 sobre 7 filtradas = 3 páginas (3+3+1); total 7 em todas", `${p1.orders.length}/${p2.orders.length}/${p3.orders.length}`);
    const todasPaginas = [...nomes(p1), ...nomes(p2), ...nomes(p3)];
    check(new Set(todasPaginas).size === 7 && mesmo([...todasPaginas].sort(), nomeTarde(0, 1, 2, 5, 6, 7, 8)), "O10: as páginas não repetem nem perdem encomendas (união das páginas = as 7)");
    check(mesmo(todasPaginas, [...todasPaginas].sort().reverse()), "O11: ordem por data desc mantida dentro e entre páginas filtradas");
    // Cabeçalho «x–y de N» é derivado de total/page/pageSize
    check(p3.page === 3 && p3.pageSize === 3, "O12: página/tamanho devolvidos coerentes com o pedido");
    // Combinações
    const oF1 = await lista([KCOMP], { farmaciaId: f1.id });
    check(oF1.total === 2 && mesmo(nomes(oF1).sort(), nomeTarde(0, 2)), "O13: Comprimido ∩ farmácia Um = 2 (Enc 00 e 02)");
    const oQ = await lista([KCOMP, KCAPS], { search: "enc 05" });
    check(oQ.total === 1 && mesmo(nomes(oQ), nomeTarde(5)), "O14: pesquisa por nome ('enc 05') ∩ formas = 1");
    const oData = await lista([KCOMP, KCAPS, SEM_FORMA], { dateFrom: new Date(base + 2 * 86_400_000), dateTo: new Date(base + 6 * 86_400_000) });
    check(oData.total === 3 && mesmo(nomes(oData).sort(), nomeTarde(2, 5, 6)), "O15: intervalo de datas (dias 2..6) ∩ formas = 3 (Enc 02, 05, 06)");
    const oEstado = await lista([KREV], { estado: "ANULADA" });
    check(oEstado.total === 1 && mesmo(nomes(oEstado), nomeTarde(4)), "O16: estado ANULADA ∩ Comprimido revestido = 1 (Enc 04)");
    // Vazio e «Limpar filtros»
    const oVazio = await lista([]);
    check(oVazio.total === o0.total && mesmo(nomes(oVazio), o0p1) && oVazio.totalPages === o0.totalPages, "O17: filtro vazio = resultado actual (59, 3 páginas, mesma 1ª página)");
    await lista([KCOMP]);
    const oLimpo = await lista(undefined);
    check(oLimpo.total === 59 && mesmo(nomes(oLimpo), o0p1) && oLimpo.totalPages === 3, "O18: «Limpar filtros» (navegar sem `forma`) repõe 59 encomendas / 3 páginas");
    check((await lista([chaveFormaFarmaceutica("não existe")])).total === 0, "O19: forma sem encomendas -> 0 (e não o conjunto completo)");
    const opcoes = await carregarOpcoesFormaFarmaceutica(prisma);
    check(opcoes.some((o) => o.chave === KCOMP && o.count === 3) && opcoes.some((o) => o.chave === SEM_FORMA && o.count === 2), "O20: as opções do filtro (com contagem de produtos) vêm do servidor (a página): Comprimido=3 e Sem forma=2");
    const urlPage = src("app/encomendas/page.tsx");
    const urlClient = src("components/encomendas/order-list-client.tsx");
    check(/lerChavesForma\(sp\.forma\)/.test(urlPage) && /params\.append\("forma"/.test(urlClient) && /router\.push\(pathname\)/.test(urlClient), "O21: o filtro viaja no URL (`forma` repetido) e «Limpar filtros» navega para o pathname limpo");
    const ordersData = src("lib/encomendas/orders-data.ts");
    check(/where\.linhas = \{ some: \{ produto: porForma \} \}/.test(ordersData) && ordersData.indexOf("where.linhas") < ordersData.indexOf("skip,") && /count\(\{ where \}\)/.test(ordersData), "O22: o filtro entra no `where` partilhado por findMany (skip/take) e count — antes da paginação e do total");

    // ═══ X · Transversais ═══
    secao("X · Transversais");
    const trData = src("lib/transferencias-data.ts");
    check(trData.indexOf("sqlFiltroForma(options?.formas)") > 0 && trData.indexOf("sqlFiltroForma(options?.formas)") < trData.indexOf("result.slice(0, 200)"), "X1: o filtro de forma está na query de origem (parametrizado), antes de qualquer `slice(0, 200)`");
    check(/formasFarmaceuticas: formasSelecionadas/.test(src("components/excessos/excessos-client.tsx")) && /formasFarmaceuticas: formasSelecionadas/.test(src("components/transferencias/transferencias-client.tsx")), "X2: Excessos e Transferências enviam as formas no pedido do «Gerar» (o snapshot fixa as mesmas)");
    check(/data-testid="excessos-limpar-filtros"/.test(src("components/excessos/excessos-client.tsx")) && /data-testid="transferencias-limpar-filtros"/.test(src("components/transferencias/transferencias-client.tsx")), "X3: Excessos e Transferências têm «Limpar filtros»");
    const valoresGuardados = await prisma.produto.findMany({ select: { cnp: true, formaFarmaceutica: true }, orderBy: { cnp: "asc" } });
    check(valoresGuardados.filter((p) => p.formaFarmaceutica === " COMPRIMIDO ").length === 1, "X4: o valor guardado em Produto.formaFarmaceutica não é alterado pelo filtro");

    await prisma.$disconnect();
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => undefined);
    await admin.end();
  }
  console.log(`\n${ko === 0 ? "PASSOU" : "FALHOU"} — ${ok} OK, ${ko} falhas\n`);
  process.exit(ko === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
