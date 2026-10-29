/**
 * scripts/tests/test-fabricantes-grupo-resolucao-db.ts
 *
 * Resolução do filtro «grupo de fabricantes» do Garantia — PostgreSQL REAL e DESCARTÁVEL, SQL real, dados sintéticos.
 * Prova (ver notes/fabricantes-grupos-resolucao.md):
 *   A · TODOS os produtos dos fabricantes membros (e aliases) entram; produto de fabricante fora do grupo, sem regra, NÃO
 *       entra; nome PARECIDO sem prova NÃO entra; vários fabricantes + aliases;
 *   B · semântica aprovada mantida: produtos incluídos por regra CNP / prova manual / alias de grupo cujo fabricante NÃO é
 *       membro ENTRAM (igual a Vendas/Margens/Inventário e ao catálogo) e são EXACTAMENTE os que a auditoria lista;
 *   C · várias farmácias: sem duplicação, coerente com a selecção de farmácias (proposta por farmácia);
 *   D · opção estável e ordenada (ordem total, ids estáveis entre chamadas e independentes da ordem de inserção);
 *   E · nº de QUERIES por selecção: constante, igual com 10 e com 1000 produtos (sem N+1);
 *   F · filtro LOCAL == resolução no servidor (mesmas linhas) para todos os tipos de valor; sem pedidos por produto;
 *   G · estrutura: sem ida ao servidor por selecção (clientes/hook), reserva cancelável e sequenciada.
 *
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres npx tsx scripts/tests/test-fabricantes-grupo-resolucao-db.ts
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
const src = (f: string) => readFileSync(f, "utf8").replace(/\r\n/g, "\n");
const semComentarios = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

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
const igualConj = (a: Iterable<string>, b: Iterable<string>) => {
  const A = new Set(a);
  const B = new Set(b);
  return A.size === B.size && [...A].every((x) => B.has(x));
};

async function main() {
  const db = `spharm_fabres_${Date.now().toString(36)}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${db}`);
  try {
    execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: urlDe(db) }, encoding: "utf8" });
    const { PrismaClient } = await import("../../generated/prisma/client");
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(db) }), log: [{ emit: "event", level: "query" }] });
    estado.prisma = prisma;

    // Contador de queries SQL reais (eventos do Prisma/adapter), sem BEGIN/COMMIT.
    let queries: string[] = [];
    (prisma as unknown as { $on: (e: string, cb: (ev: { query: string }) => void) => void }).$on("query", (ev) => {
      if (!/^\s*(BEGIN|COMMIT|ROLLBACK|SET )/i.test(ev.query)) queries.push(ev.query);
    });
    const contar = async <T,>(fn: () => Promise<T>): Promise<{ r: T; n: number }> => {
      queries = [];
      const r = await fn();
      await new Promise((res) => setTimeout(res, 30)); // os eventos de log chegam em microtarefas
      return { r, n: queries.length };
    };

    const L = await import("../../lib/catalog/laboratorio-filtro");
    const { carregarLaboratoriosGarantia } = await import("../../lib/catalog/carregar-laboratorios-garantia");
    const { carregarPertencaGruposPorCnp } = await import("../../lib/catalog/pertenca-grupos-laboratoriais");
    const { resolverProdutoIdsPorLaboratoriosSelecionados } = await import("../../lib/reporting/resolver-laboratorio-selecionado");
    const { resolverCnpsPorLaboratoriosSelecionados } = await import("../../lib/reporting/resolver-cnps-laboratorios");
    const { passaFiltroLaboratorioLinha, construirEstadoFiltroLaboratorio } = await import("../../lib/reporting/filtro-laboratorio-linhas");
    const { getReportingFilterOptions } = await import("../../lib/reporting-filter-options");
    const { generateOrderProposal } = await import("../../lib/encomendas/proposal");
    const garantia = async () => "garantia" as string | null;

    // ── Fixture ─────────────────────────────────────────────────────────────────────────────────────────────────
    const farms = await Promise.all(["FR A", "FR B", "FR C"].map((nome) => prisma.farmacia.create({ data: { nome } })));
    let cnpSeq = 9_000_000;
    const mkProd = (nome: string, fabricanteId: string | null) => prisma.produto.create({ data: { cnp: ++cnpSeq, designacao: nome, estado: "VALIDADO", fabricanteId } });
    const vender = async (produtoId: string, farmaciasIdx: number[]) => {
      const hoje = new Date();
      for (const i of farmaciasIdx) {
        await prisma.produtoFarmacia.create({ data: { produtoId, farmaciaId: farms[i]!.id, stockAtual: 0, stockMinimo: 0, stockMaximo: 10 } });
        for (let m = 1; m <= 3; m++) {
          const dt = new Date(hoje.getFullYear(), hoje.getMonth() - m, 1);
          await prisma.vendaMensal.create({ data: { farmaciaId: farms[i]!.id, produtoId, ano: dt.getFullYear(), mes: dt.getMonth() + 1, quantidade: 300, valorTotal: 3000, naturezaVenda: "NORMAL" } });
        }
      }
    };

    // Grupo ALFA: 3 fabricantes membros (criados fora de ordem alfabética), 1 com alias, produtos em 1-3 farmácias.
    const alfa = await prisma.grupoLaboratorial.create({ data: { nome: "Alfa Group", nomeNormalizado: "ALFA GROUP" } });
    await prisma.grupoLaboratorialAlias.create({ data: { grupoLaboratorialId: alfa.id, alias: "Alfinha", aliasNormalizado: "ALFINHA" } });
    const nomesMembros = ["ALFA ZULU LDA", "ALFA BETA LDA", "ALFA MEIO LDA"];
    const membros: Array<{ id: string; nome: string }> = [];
    const prodMembros: Array<{ id: string; cnp: number; fab: string }> = [];
    for (const nome of nomesMembros) {
      const f = await prisma.fabricante.create({ data: { nomeNormalizado: nome } });
      membros.push({ id: f.id, nome });
      await prisma.grupoLaboratorialFabricante.create({ data: { grupoLaboratorialId: alfa.id, fabricanteId: f.id } });
      for (let k = 0; k < 2; k++) {
        const p = await mkProd(`${nome} p${k}`, f.id);
        await vender(p.id, k === 0 ? [0, 1, 2] : [1]);
        await prisma.produtoGrupoLaboratorial.create({ data: { produtoId: p.id, grupoLaboratorialId: alfa.id, origem: "FABRICANTE_INEQUIVOCO" } });
        prodMembros.push({ id: p.id, cnp: p.cnp, fab: nome });
      }
    }
    await prisma.fabricanteAlias.create({ data: { fabricanteId: membros[0]!.id, aliasNome: "ALFA OLD NAME" } });

    // Fabricante FORA do grupo, sem regra: NÃO entra. Fabricante de nome PARECIDO, sem prova: NÃO entra.
    const fabFora = await prisma.fabricante.create({ data: { nomeNormalizado: "SUCESSAO PARCIAL LDA" } });
    const pForaLivre = await mkProd("Fora livre", fabFora.id);
    await vender(pForaLivre.id, [0]);
    const fabParecido = await prisma.fabricante.create({ data: { nomeNormalizado: "ALFA GROUP PHARMA" } });
    const pParecido = await mkProd("Parecido", fabParecido.id);
    await vender(pParecido.id, [0]);
    // Mesmo fabricante «fora» mas com 3 produtos incluídos por BASE APROVADA diferente (sucessão parcial):
    const pRegra = await mkProd("Fora por regra CNP", fabFora.id);
    const regra = await prisma.regraGrupoLaboratorialPorCnp.create({ data: { cnp: pRegra.cnp, grupoLaboratorialId: alfa.id, validadoManualmente: true, estado: "ATIVO" } });
    await prisma.produtoGrupoLaboratorial.create({ data: { produtoId: pRegra.id, grupoLaboratorialId: alfa.id, origem: "REGRA_CNP", regraCnpId: regra.id } });
    const pManual = await mkProd("Fora por prova manual", fabFora.id);
    await prisma.produtoGrupoLaboratorial.create({ data: { produtoId: pManual.id, grupoLaboratorialId: alfa.id, origem: "MANUAL", validadoManualmente: true } });
    const fabAliasGrupo = await prisma.fabricante.create({ data: { nomeNormalizado: "ALFINHA" } });
    const pAlias = await mkProd("Fora por alias do grupo", fabAliasGrupo.id);
    await prisma.produtoGrupoLaboratorial.create({ data: { produtoId: pAlias.id, grupoLaboratorialId: alfa.id, origem: "ALIAS_INEQUIVOCO" } });
    for (const p of [pRegra, pManual, pAlias]) await vender(p.id, [0, 2]);
    // E um caso OBSOLETO: linha FABRICANTE_INEQUIVOCO de um produto cujo fabricante já não é membro (a reconciliação diária remove).
    const pObsoleto = await mkProd("Obsoleto (fabricante saiu do grupo)", fabFora.id);
    await prisma.produtoGrupoLaboratorial.create({ data: { produtoId: pObsoleto.id, grupoLaboratorialId: alfa.id, origem: "FABRICANTE_INEQUIVOCO" } });

    // Grupo BETA (outro grupo) e um grupo/fabricante com o MESMO nome (desempate determinístico).
    const beta = await prisma.grupoLaboratorial.create({ data: { nome: "Beta Lab", nomeNormalizado: "BETA LAB" } });
    const fabBeta = await prisma.fabricante.create({ data: { nomeNormalizado: "BETA LAB" } });
    await prisma.grupoLaboratorialFabricante.create({ data: { grupoLaboratorialId: beta.id, fabricanteId: fabBeta.id } });
    const pBeta = await mkProd("Beta p", fabBeta.id);
    await prisma.produtoGrupoLaboratorial.create({ data: { produtoId: pBeta.id, grupoLaboratorialId: beta.id, origem: "FABRICANTE_INEQUIVOCO" } });

    const baseIdsGrupo = [...prodMembros.map((p) => p.id), pRegra.id, pManual.id, pAlias.id, pObsoleto.id];

    // ── A · membros entram, fora não ────────────────────────────────────────────────────────────────────────────
    console.log("A · quem entra no grupo");
    const idsAlfa = await resolverProdutoIdsPorLaboratoriosSelecionados(prisma, [`grupo:${alfa.id}`], garantia);
    check(prodMembros.every((p) => idsAlfa.includes(p.id)), "A1: TODOS os produtos dos 3 fabricantes membros entram (6)");
    check(!idsAlfa.includes(pForaLivre.id), "A2: produto de fabricante fora do grupo e SEM regra NÃO entra");
    check(!idsAlfa.includes(pParecido.id), "A3: fabricante de nome parecido («ALFA GROUP PHARMA») sem prova NÃO entra");
    check(!idsAlfa.includes(pBeta.id), "A4: produto de outro grupo não entra");
    check(new Set(idsAlfa).size === idsAlfa.length && igualConj(idsAlfa, baseIdsGrupo), `A5: conjunto exacto = membros + base aprovada (+1 obsoleto) = ${baseIdsGrupo.length}; veio ${idsAlfa.length}`);
    const idsVar0 = await resolverProdutoIdsPorLaboratoriosSelecionados(prisma, [`fabricante:${membros[0]!.id}`], garantia);
    check(igualConj(idsVar0, prodMembros.filter((p) => p.fab === nomesMembros[0]).map((p) => p.id)), "A6: seleccionar UMA variante dá só os produtos dessa variante (nem os dos irmãos, nem os da regra CNP)");
    const idsVarios = await resolverProdutoIdsPorLaboratoriosSelecionados(prisma, [`fabricante:${membros[0]!.id}`, `fabricante:${membros[1]!.id}`, `grupo:${beta.id}`], garantia);
    check(idsVarios.length === 5 && new Set(idsVarios).size === 5, "A7: vários fabricantes + grupo: união sem duplicados (2 + 2 + 1)");
    // alias de fabricante é só pesquisa: o alias não cria pertença própria
    const opcoes = await carregarLaboratoriosGarantia(prisma);
    const gAlfa = opcoes.find((o) => o.tipo === "grupo" && o.id === alfa.id);
    check(gAlfa?.tipo === "grupo" && gAlfa.variantes?.length === 3 && gAlfa.termosBusca.includes("ALFA OLD NAME"), "A8: o alias do fabricante membro encontra o grupo (pesquisa), as 3 variantes estão no grupo");
    check(L.agruparOpcoesLaboratorio(opcoes, "alfa old name").some((i) => i.opcao.id === alfa.id), "A9: pesquisar pelo alias da variante devolve o grupo");
    check(L.agruparOpcoesLaboratorio(opcoes).some((i) => i.opcao.tipo === "fabricante" && i.opcao.id === fabParecido.id), "A10: o fabricante parecido continua como opção PRÓPRIA (separado)");

    // ── B · semântica aprovada: base por regra com fabricante fora do grupo ─────────────────────────────────────
    console.log("\nB · incluídos por base aprovada com fabricante FORA do grupo");
    const comFabForaDoGrupo = await prisma.$queryRawUnsafe<Array<{ pid: string; origem: string }>>(`
      SELECT pgl."produtoId" AS pid, pgl.origem FROM "ProdutoGrupoLaboratorial" pgl JOIN "Produto" p ON p.id = pgl."produtoId"
       WHERE pgl."grupoLaboratorialId" = '${alfa.id}'
         AND NOT EXISTS (SELECT 1 FROM "GrupoLaboratorialFabricante" gf WHERE gf."fabricanteId" = p."fabricanteId" AND gf."grupoLaboratorialId" = pgl."grupoLaboratorialId")`);
    check(igualConj(comFabForaDoGrupo.map((r) => r.pid), [pRegra.id, pManual.id, pAlias.id, pObsoleto.id]), "B1: fabricante fora do grupo mas produto dentro = REGRA_CNP, MANUAL, ALIAS_INEQUIVOCO (+ 1 obsoleto)");
    check(comFabForaDoGrupo.every((r) => idsAlfa.includes(r.pid)), "B2: por omissão ENTRAM no grupo (coerente com Vendas/Margens/Inventário — semântica aprovada mantida)");
    const viaWhere = await prisma.produto.findMany({ where: L.resolverFiltroLaboratorioWhere(`grupo:${alfa.id}`)!, select: { id: true } });
    check(igualConj(viaWhere.map((p) => p.id), idsAlfa), "B3: o resolvedor de Vendas/Margens/Inventário e o `where` do catálogo dão o MESMO conjunto");
    const cnpsAlfa = await resolverCnpsPorLaboratoriosSelecionados(prisma, [`grupo:${alfa.id}`], garantia);
    const pert = await carregarPertencaGruposPorCnp(prisma);
    check(igualConj(pert[alfa.id] ?? [], cnpsAlfa), "B4: a pertença local (um SELECT) == resolução do servidor para o grupo");
    const obsoletos = comFabForaDoGrupo.filter((r) => r.origem === "FABRICANTE_INEQUIVOCO");
    check(obsoletos.length === 1 && obsoletos[0]!.pid === pObsoleto.id, "B5: único caso SEM base actual = linha FABRICANTE_INEQUIVOCO obsoleta (a reconciliação diária remove; a auditoria lista)");

    // ── C · várias farmácias ────────────────────────────────────────────────────────────────────────────────────
    console.log("\nC · várias farmácias");
    check(cnpsAlfa.length === baseIdsGrupo.length && new Set(cnpsAlfa).size === cnpsAlfa.length, `C1: produto com stock/vendas em 3 farmácias aparece UMA vez na resolução (${cnpsAlfa.length} CNP distintos)`);
    const input = (i: number) => ({
      farmaciaId: farms[i]!.id, farmaciaNome: farms[i]!.nome,
      startDate: new Date(new Date().getFullYear(), new Date().getMonth() - 6, 1), endDate: new Date(),
      considerStock: true, baseRule: "total" as const, targetCoverageDays: 30,
    });
    const proposta = async (i: number, fabricantes: string[]) =>
      (await generateOrderProposal({ ...input(i), filters: { fabricantes } }, prisma, { resolverTenant: garantia })).rows.map((r) => r.produtoId);
    const pA = await proposta(0, [`grupo:${alfa.id}`]);
    const pB = await proposta(1, [`grupo:${alfa.id}`]);
    const pC = await proposta(2, [`grupo:${alfa.id}`]);
    const vendidosAC = [...prodMembros.filter((_, i) => i % 2 === 0).map((p) => p.id), pRegra.id, pManual.id, pAlias.id]; // k=0 (3 farmácias) + regra/manual/alias (A e C)
    check(new Set(pA).size === pA.length && igualConj(pA, vendidosAC), `C2: farmácia A — cada produto do grupo vendido em A, uma vez (${pA.length})`);
    check(new Set(pB).size === pB.length && igualConj(pB, prodMembros.map((p) => p.id)), `C3: farmácia B — só os 6 dos membros (regra/manual/alias não vendem em B) (${pB.length})`);
    check(igualConj(pC, vendidosAC), "C4: farmácia C — coerente com as vendas de C");
    check(!pA.includes(pForaLivre.id) && !pA.includes(pParecido.id), "C5: fora do grupo/parecido não entram em nenhuma farmácia");
    // lista operacional multi-farmácia: o mesmo CNP em 3 linhas (uma por farmácia) passa as 3, coerente com a selecção de farmácias
    const linhasMulti = prodMembros.flatMap((p) => farms.map((f) => ({ cnp: String(p.cnp), fabricante: p.fab, farmacia: f.nome })));
    const estLocal = construirEstadoFiltroLaboratorio([`grupo:${alfa.id}`], opcoes, pert);
    const passam = linhasMulti.filter((l) => passaFiltroLaboratorioLinha(l, [`grupo:${alfa.id}`], estLocal));
    check(passam.length === linhasMulti.length, "C6: lista com o mesmo produto em 3 farmácias: o filtro de grupo não depende da farmácia (linhas todas, sem perder nem duplicar)");
    const soFarmB = linhasMulti.filter((l) => l.farmacia === "FR B");
    check(soFarmB.filter((l) => passaFiltroLaboratorioLinha(l, [`grupo:${alfa.id}`], estLocal)).length === 6, "C7: ao seleccionar só a farmácia B (filtro de farmácia) + grupo -> 6 linhas");

    // ── D · estabilidade e ordem ────────────────────────────────────────────────────────────────────────────────
    console.log("\nD · opção estável e ordenada");
    const op1 = await carregarLaboratoriosGarantia(prisma);
    const op2 = await carregarLaboratoriosGarantia(prisma);
    const ag1 = L.agruparOpcoesLaboratorio(op1);
    const ag2 = L.agruparOpcoesLaboratorio(op2);
    check(JSON.stringify(ag1) === JSON.stringify(ag2), "D1: duas chamadas dão exactamente a mesma lista agrupada (mesmos ids, ordem e variantes)");
    check(JSON.stringify(ag1.map((i) => i.opcao.id)) === JSON.stringify(L.agruparOpcoesLaboratorio([...op1].reverse()).map((i) => i.opcao.id)), "D2: a ordem não depende da ordem de entrada (inversa dá o mesmo)");
    const nomes = ag1.map((i) => L.nomeDeLaboratorio(i.opcao));
    check(JSON.stringify(nomes) === JSON.stringify([...nomes].sort((a, b) => a.localeCompare(b, "pt-PT"))), `D3: ordem alfabética (${nomes.join(" | ")})`);
    const alfaItem = ag1.find((i) => i.opcao.id === alfa.id)!;
    check(JSON.stringify(alfaItem.variantes.map((v) => v.nome)) === JSON.stringify([...nomesMembros].sort()), `D4: variantes do grupo ordenadas (${alfaItem.variantes.map((v) => v.nome).join(" | ")})`);
    const betaItens = ag1.filter((i) => L.nomeDeLaboratorio(i.opcao).toLowerCase() === "beta lab");
    check(betaItens.length === 1 && betaItens[0]!.opcao.tipo === "grupo", "D5: grupo «Beta Lab» e fabricante-variante «BETA LAB»: uma só opção (a variante vive no grupo)");
    check(ag1.every((i) => L.valorDeLaboratorio(i.opcao) === `${i.opcao.tipo}:${i.opcao.id}`), "D6: o valor da opção é sempre tipo:id (estável; nunca o nome)");
    const pert2 = await carregarPertencaGruposPorCnp(prisma);
    check(JSON.stringify(pert) === JSON.stringify(pert2) && Object.values(pert).every((l) => JSON.stringify(l) === JSON.stringify([...l].sort((a, b) => Number(a) - Number(b)))), "D7: a pertença por CNP é estável e ordenada por CNP");
    const tie = L.agruparOpcoesLaboratorio([
      { tipo: "fabricante", id: "z2", nomeNormalizado: "Igual", produtos: 1 },
      { tipo: "grupo", id: "z1", nome: "Igual", termosBusca: [], resumoAlcance: [], produtos: 1 },
      { tipo: "fabricante", id: "a1", nomeNormalizado: "Igual", produtos: 1 },
    ]);
    check(tie.map((i) => `${i.opcao.tipo}:${i.opcao.id}`).join(",") === "fabricante:a1,fabricante:z2,grupo:z1", `D8: empate de nome desempata por tipo e id, determinístico (${tie.map((i) => `${i.opcao.tipo}:${i.opcao.id}`).join(",")})`);

    // ── E · nº de queries ───────────────────────────────────────────────────────────────────────────────────────
    console.log("\nE · nº de queries por selecção (sem N+1)");
    const qOpcAntes = await contar(() => carregarLaboratoriosGarantia(prisma));
    const pequeno = await prisma.grupoLaboratorial.create({ data: { nome: "Pequeno", nomeNormalizado: "PEQUENO" } });
    const grande = await prisma.grupoLaboratorial.create({ data: { nome: "Grande", nomeNormalizado: "GRANDE" } });
    const popular = async (grupoId: string, nFab: number, nProd: number, prefixo: string) => {
      const fabs: string[] = [];
      for (let i = 0; i < nFab; i++) {
        const f = await prisma.fabricante.create({ data: { nomeNormalizado: `${prefixo} F${String(i).padStart(3, "0")}` } });
        await prisma.grupoLaboratorialFabricante.create({ data: { grupoLaboratorialId: grupoId, fabricanteId: f.id } });
        fabs.push(f.id);
      }
      const base = cnpSeq;
      cnpSeq += nProd;
      await prisma.produto.createMany({ data: Array.from({ length: nProd }, (_, i) => ({ cnp: base + i + 1, designacao: `${prefixo} ${i}`, estado: "VALIDADO" as const, fabricanteId: fabs[i % nFab]! })) });
      const prods = await prisma.produto.findMany({ where: { cnp: { gt: base, lte: base + nProd } }, select: { id: true } });
      await prisma.produtoGrupoLaboratorial.createMany({ data: prods.map((p) => ({ produtoId: p.id, grupoLaboratorialId: grupoId, origem: "FABRICANTE_INEQUIVOCO" })) });
      return { fabs, n: prods.length };
    };
    const peq = await popular(pequeno.id, 2, 10, "PEQ");
    const gra = await popular(grande.id, 40, 1000, "GRA");
    check(peq.n === 10 && gra.n === 1000, "E0: grupos de 10 produtos/2 fabricantes e de 1000 produtos/40 fabricantes");
    const medir = async (rotulo: string, f: (sel: string[]) => Promise<unknown>, selPeq: string[], selGra: string[], max: number) => {
      const a = await contar(() => f(selPeq));
      const b = await contar(() => f(selGra));
      check(a.n === b.n && a.n <= max, `E[${rotulo}]: ${a.n} queries com 10 produtos, ${b.n} com 1000 (iguais; ≤ ${max})`);
      return { a: a.n, b: b.n };
    };
    const qIds = await medir("produtoIds grupo", (sel) => resolverProdutoIdsPorLaboratoriosSelecionados(prisma, sel, garantia), [`grupo:${pequeno.id}`], [`grupo:${grande.id}`], 1);
    const qCnps = await medir("cnps grupo", (sel) => resolverCnpsPorLaboratoriosSelecionados(prisma, sel, garantia), [`grupo:${pequeno.id}`], [`grupo:${grande.id}`], 2);
    await medir("cnps 2 fabricantes", (sel) => resolverCnpsPorLaboratoriosSelecionados(prisma, sel, garantia), peq.fabs.slice(0, 2).map((f) => `fabricante:${f}`), gra.fabs.slice(0, 2).map((f) => `fabricante:${f}`), 2);
    await medir("cnps 40 fabricantes + grupo", (sel) => resolverCnpsPorLaboratoriosSelecionados(prisma, sel, garantia), [...peq.fabs.map((f) => `fabricante:${f}`), `grupo:${pequeno.id}`], [...gra.fabs.map((f) => `fabricante:${f}`), `grupo:${grande.id}`], 3);
    const qNome = await medir("cnps nome solto do grupo", (sel) => resolverCnpsPorLaboratoriosSelecionados(prisma, sel, garantia), ["Pequeno"], ["Grande"], 3);
    const qPert = await contar(() => carregarPertencaGruposPorCnp(prisma));
    check(qPert.n === 1, `E[pertença local]: ${qPert.n} query para TODOS os grupos (carregada uma vez com a página; ${Object.values(qPert.r).reduce((t, l) => t + l.length, 0)} CNP)`);
    const qOpc = await contar(() => carregarLaboratoriosGarantia(prisma));
    check(qOpc.n === qOpcAntes.n && qOpc.n <= 8, `E[opções]: ${qOpc.n} queries para TODAS as opções (6 consultas + relações aninhadas), as mesmas antes (${qOpcAntes.n}) e depois de juntar 1000 produtos/42 fabricantes`);
    estado.tenant = "garantia";
    const qOptComPert = await contar(() => getReportingFilterOptions({ comPertencaGrupos: true }));
    const qOptSem = await contar(() => getReportingFilterOptions());
    check(qOptComPert.n - qOptSem.n === 1, `E[página]: a pertença local custa +1 query à página (${qOptSem.n} -> ${qOptComPert.n}); seleccionar/limpar filtros custa 0`);
    check(qOptComPert.r.pertencaGrupos !== undefined && qOptSem.r.pertencaGrupos === undefined, "E[página]: só é carregada quando pedida (Vendas/Margens/Inventário não pagam)");
    estado.tenant = "silveira";
    const outro = await getReportingFilterOptions({ comPertencaGrupos: true });
    check(outro.pertencaGrupos === undefined && outro.laboratorios === undefined, "E[tenants]: silveira/sier não têm `pertencaGrupos` nem `laboratorios` (opções inalteradas)");
    // proposta de Encomenda: nº de queries do filtro de fabricantes constante
    const pq = async (sel: string[]) => (await contar(() => generateOrderProposal({ ...input(0), filters: { fabricantes: sel } }, prisma, { resolverTenant: garantia })));
    const semFiltro = await pq([]);
    const pPeq = await pq([`grupo:${pequeno.id}`]);
    const pGra = await pq([`grupo:${grande.id}`]);
    check(pPeq.n === pGra.n && pPeq.n - semFiltro.n <= 2, `E[proposta]: ${semFiltro.n} queries sem filtro, ${pPeq.n} com grupo de 10 e ${pGra.n} com grupo de 1000 (+${pGra.n - semFiltro.n}; uma resolução por «Gerar»)`);
    console.log(`        (medição: produtoIds=${qIds.a}, cnps=${qCnps.a}, nome solto=${qNome.a}, pertença=${qPert.n}, opções=${qOpc.n})`);

    // ── F · filtro local == servidor; nenhum pedido por produto ─────────────────────────────────────────────────
    console.log("\nF · filtro LOCAL equivale ao servidor");
    estado.tenant = "garantia";
    const optsF = await getReportingFilterOptions({ comPertencaGrupos: true });
    const labs = optsF.laboratorios!;
    const pertF = optsF.pertencaGrupos!;
    const todos = await prisma.produto.findMany({ select: { cnp: true, fabricante: { select: { nomeNormalizado: true } } } });
    const linhasTodas = todos.map((p) => ({ cnp: String(p.cnp), fabricante: p.fabricante?.nomeNormalizado ?? "" }));
    const cenarios: Array<[string, string[]]> = [
      ["grupo", [`grupo:${alfa.id}`]],
      ["variante", [`fabricante:${membros[1]!.id}`]],
      ["fabricante fora do grupo", [`fabricante:${fabFora.id}`]],
      ["grupo + fabricante fora + outro grupo", [`grupo:${alfa.id}`, `fabricante:${fabFora.id}`, `grupo:${beta.id}`]],
      ["nome solto de grupo", ["Alfa Group"]],
      ["nome solto de fabricante", ["ALFA GROUP PHARMA"]],
      ["grupo grande (1000)", [`grupo:${grande.id}`]],
      ["id removido", ["fabricante:inexistente"]],
    ];
    for (const [nome, sel] of cenarios) {
      const cnpsServ = new Set(await resolverCnpsPorLaboratoriosSelecionados(prisma, sel, garantia));
      const est = construirEstadoFiltroLaboratorio(sel, labs, pertF);
      const local = linhasTodas.filter((l) => passaFiltroLaboratorioLinha(l, sel, est)).map((l) => l.cnp);
      const serv = linhasTodas.filter((l) => passaFiltroLaboratorioLinha(l, sel, { modoGrupos: true, cnps: cnpsServ })).map((l) => l.cnp);
      check(igualConj(local, serv), `F[${nome}]: local == servidor (${local.length} linhas)`);
    }
    const semSel = construirEstadoFiltroLaboratorio([], labs, pertF);
    check(linhasTodas.every((l) => passaFiltroLaboratorioLinha(l, [], semSel)), "F-sel: sem selecção passam todas");
    const estTeste = construirEstadoFiltroLaboratorio([`grupo:${alfa.id}`], labs, pertF);
    check(estTeste.cnps !== null, "F-sync: o estado local nunca é `null` (não há estado «a resolver» a esconder linhas)");

    // ── G · estrutura ───────────────────────────────────────────────────────────────────────────────────────────
    console.log("\nG · estrutura (sem pedidos por selecção/produto; reserva sequenciada)");
    const hook = semComentarios(src("components/reporting/use-cnps-laboratorios.ts"));
    check(/resolveLocalmente/.test(hook) && /if \(!modoGrupos \|\| resolveLocalmente/.test(hook), "G1: o hook só chama o servidor quando NÃO resolve localmente");
    check(/let cancelado = false/.test(hook) && /if \(!cancelado\)/.test(hook) && /return \(\) => \{\s*cancelado = true/.test(hook), "G2: o caminho de reserva é cancelável (resposta antiga descartada)");
    check(/resolvido\.chave === chave/.test(hook), "G3: o resultado só vale para a chave de selecção actual (sem corrida)");
    check((hook.match(/resolverCnpsLaboratoriosAction\(/g) ?? []).length === 1, "G4: uma única chamada ao servidor no hook, sobre a SELECÇÃO inteira (nunca por produto)");
    for (const [f, k] of [
      ["components/excessos/excessos-client.tsx", "excessos"],
      ["components/transferencias/transferencias-client.tsx", "transferencias"],
      ["components/devolucoes/devolucoes-client.tsx", "devolucoes"],
      ["components/encomendas/encomendas-client.tsx", "encomendas"],
    ] as const) {
      const t = semComentarios(src(f));
      check(/useFiltroLaboratorio\([^)]*pertencaGrupos: filterOptions\.pertencaGrupos/.test(t), `G5[${k}]: passa a pertença ao hook (filtro local)`);
      check(!t.includes("resolverCnpsLaboratoriosAction"), `G6[${k}]: o cliente não chama a server action (nenhum pedido por selecção/produto)`);
    }
    for (const p of ["app/excessos/page.tsx", "app/transferencias/page.tsx", "app/devolucoes/page.tsx"]) {
      check(src(p).includes("getReportingFilterOptions({ comPertencaGrupos: true })"), `G7: ${p} carrega a pertença uma vez, no servidor`);
    }
    for (const p of ["app/vendas/page.tsx", "app/relatorios/margens/page.tsx", "app/relatorios/inventario/page.tsx"]) {
      check(!src(p).includes("comPertencaGrupos"), `G8: ${p} não carrega a pertença (sem custo extra)`);
    }
    const acao = semComentarios(src("lib/reporting/laboratorio-actions.ts"));
    check(/resolverCnpsPorLaboratoriosSelecionados\(prisma, limpos\)/.test(acao) && !/for \(|\.map\(async/.test(acao), "G9: a server action de reserva resolve a selecção inteira numa chamada (sem ciclo por produto)");
    const prop = semComentarios(src("lib/encomendas/proposal.ts"));
    check((prop.match(/resolverFiltroFabricantesProposta\(/g) ?? []).length === 1, "G10: a proposta resolve o filtro de fabricantes UMA vez por «Gerar» (no SQL da proposta), não por clique");
    const oc = semComentarios(src("components/encomendas/order-create-client.tsx"));
    check(!oc.includes("resolverCnpsLaboratoriosAction"), "G11: a Encomenda nova não faz pedidos ao seleccionar fabricantes (só no «Gerar»)");

    await prisma.$disconnect();
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => undefined);
    await admin.end();
  }

  console.log(`\n${ok} ok, ${ko} falhas`);
  process.exit(ko === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
