/**
 * scripts/tests/test-manutencao-massa-filtros-db.ts
 *
 * PostgreSQL REAL e DESCARTÁVEL (recusa correr fora de localhost):
 *
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:55494/postgres npx tsx scripts/tests/test-manutencao-massa-filtros-db.ts
 *
 * Os filtros da Manutenção em massa são os de Vendas. Aqui prova-se, contra
 * dados reais:
 *
 *   V  EQUIVALÊNCIA — para os MESMOS valores, Vendas (`getVendasData`) e a
 *      manutenção identificam o MESMO universo (pares produto×farmácia e
 *      produtos): período, categoria, subcategoria, utilização, pesquisa,
 *      distribuidor, lista de CNP, fabricante (nome em Vendas ≡ ID aqui),
 *      «stock sem vendas» e guias de transferência.
 *   F  FABRICANTES — um, vários, «sem fabricante» (OU), combinados com
 *      categoria / subcategoria / tipo / farmácia / pesquisa; contagem total
 *      e paginação coerentes.
 *   S  SELECÇÃO e SNAPSHOT — manual / todos-menos / chaves forjadas; o
 *      preview respeita a selecção; uma alteração entre o preview e o apply
 *      recusa (PREVIEW_DESACTUALIZADO); uma alteração concorrente DENTRO da
 *      transacção reverte tudo (compare-and-set); zero escritas fora do snapshot.
 *   H  FORNECEDORES HABITUAIS — um, vários, «sem fornecedor habitual»;
 *      farmácia isolada (Silveirense / Segurado), ambas explícitas; uma
 *      farmácia nunca altera a outra; uma operação por farmácia; preview por
 *      farmácia; reversão.
 *   G  UNIVERSO GRANDE — 36 000 produtos: contagem, página, `in` enorme
 *      (categoria) e apply em bloco dentro do limite de tempo.
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
function check(cond: boolean, msg: string, detalhe?: string) {
  if (cond) { passed++; console.log(`  [OK]    ${msg}`); }
  else { failed++; console.log(`  [FALHA] ${msg}${detalhe ? `\n            ${detalhe}` : ""}`); }
}

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgresql://postgres:test@localhost:55493/postgres";
const host = new URL(ADMIN_URL).hostname;
if (host !== "localhost" && host !== "127.0.0.1") {
  console.error(`RECUSADO: ${host} não é uma base local descartável.`);
  process.exit(2);
}
function urlDe(db: string) {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${db}`;
  return u.toString();
}
const ordenado = (a: Iterable<string>) => [...a].sort().join(",");

async function main() {
  const db = `spharm_mmf_${Date.now().toString(36)}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${db}`);
  try {
    execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: urlDe(db) }, encoding: "utf8" });
    const { PrismaClient } = await import("../../generated/prisma/client");
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(db) }) });
    const M2 = await import("../../lib/catalogo/manutencao-massa");
    const { getVendasData } = await import("../../lib/vendas-data");
    const { periodoActivo } = await import("../../lib/catalogo/manutencao-massa-filtro");
    void periodoActivo;

    // ═══ Dados ═══════════════════════════════════════════════════════════
    const user = await prisma.utilizador.create({ data: { email: "mm@t.pt", nome: "MM", perfil: "ADMINISTRADOR" } });
    const fSilv = await prisma.farmacia.create({ data: { nome: "MF Silveirense" } });
    const fSeg = await prisma.farmacia.create({ data: { nome: "MF Segurado" } });
    const fabA = await prisma.fabricante.create({ data: { nomeNormalizado: "MF-FAB-A", estado: "ATIVO" } });
    const fabB = await prisma.fabricante.create({ data: { nomeNormalizado: "MF-FAB-B", estado: "ATIVO" } });
    const fabC = await prisma.fabricante.create({ data: { nomeNormalizado: "MF-FAB-C", estado: "ATIVO" } });
    const fabD = await prisma.fabricante.create({ data: { nomeNormalizado: "MF-FAB-DESTINO", estado: "ATIVO" } });
    const foX = await prisma.fornecedor.create({ data: { nomeNormalizado: "MF-FORN-X", estado: "ATIVO" } });
    const foY = await prisma.fornecedor.create({ data: { nomeNormalizado: "MF-FORN-Y", estado: "ATIVO" } });
    const foZ = await prisma.fornecedor.create({ data: { nomeNormalizado: "MF-FORN-DESTINO", estado: "ATIVO" } });
    const cat1 = await prisma.classificacao.create({ data: { nome: "MF Cat 1", tipo: "NIVEL_1" } });
    const cat2 = await prisma.classificacao.create({ data: { nome: "MF Cat 2", tipo: "NIVEL_1" } });
    const sub11 = await prisma.classificacao.create({ data: { nome: "MF Sub 1.1", tipo: "NIVEL_2", classificacaoPaiId: cat1.id } });
    const sub12 = await prisma.classificacao.create({ data: { nome: "MF Sub 1.2", tipo: "NIVEL_2", classificacaoPaiId: cat1.id } });
    const util = await prisma.utilizacao.create({ data: { slug: "mf-tosse", nome: "MF Tosse" } });

    type Def = { n: number; nome: string; cat?: string; sub?: string; tipo: string; fab?: string; tosse?: boolean };
    const defs: Def[] = [
      { n: 1, nome: "MF Alfa Xarope", cat: cat1.id, sub: sub11.id, tipo: "MEDICAMENTO", fab: fabA.id, tosse: true },
      { n: 2, nome: "MF Alfa Comprimidos", cat: cat1.id, sub: sub12.id, tipo: "MEDICAMENTO", fab: fabA.id },
      { n: 3, nome: "MF Beta Creme", cat: cat2.id, tipo: "PARAFARMACIA", fab: fabB.id },
      { n: 4, nome: "MF Beta Gel", cat: cat2.id, tipo: "PARAFARMACIA", fab: fabB.id, tosse: true },
      { n: 5, nome: "MF Gama Po", cat: cat1.id, sub: sub11.id, tipo: "MEDICAMENTO", fab: fabC.id },
      { n: 6, nome: "MF Delta Sem Fab", cat: cat2.id, tipo: "PARAFARMACIA" },
      { n: 7, nome: "MF Epsilon Sem Vendas", cat: cat1.id, tipo: "MEDICAMENTO", fab: fabA.id },
      { n: 8, nome: "MF Zeta Sem Nada", tipo: "PARAFARMACIA" },
    ];
    const prod: Record<number, { id: string; cnp: number }> = {};
    for (const d of defs) {
      const p = await prisma.produto.create({
        data: {
          cnp: 7_100_000 + d.n, designacao: d.nome, tipoArtigo: d.tipo, estado: "VALIDADO",
          fabricanteId: d.fab ?? null, classificacaoNivel1Id: d.cat ?? null, classificacaoNivel2Id: d.sub ?? null,
        },
      });
      prod[d.n] = { id: p.id, cnp: p.cnp };
      if (d.tosse) await prisma.produtoUtilizacao.create({ data: { produtoId: p.id, utilizacaoId: util.id, fonte: "TESTE" } });
    }
    // fornecedor habitual por (produto, farmácia) + texto do ERP (distribuidor)
    const habSilv: Record<number, string | null> = { 1: foX.id, 2: foX.id, 3: foY.id, 4: null, 5: foX.id, 6: null, 7: foY.id, 8: null };
    const habSeg: Record<number, string | null> = { 1: foY.id, 2: null, 3: foY.id, 4: foX.id, 5: null, 6: foX.id, 7: null, 8: null };
    const origSilv: Record<number, string | null> = { 1: "DIST-1", 2: "DIST-1", 3: "DIST-2" };
    const origSeg: Record<number, string | null> = { 1: "DIST-2", 4: "DIST-1" };
    for (const d of defs) {
      await prisma.produtoFarmacia.create({ data: { produtoId: prod[d.n].id, farmaciaId: fSilv.id, fornecedorHabitualId: habSilv[d.n], fornecedorOrigem: origSilv[d.n] ?? null, stockAtual: d.n === 7 ? 5 : 0 } });
      await prisma.produtoFarmacia.create({ data: { produtoId: prod[d.n].id, farmaciaId: fSeg.id, fornecedorHabitualId: habSeg[d.n], fornecedorOrigem: origSeg[d.n] ?? null, stockAtual: 0 } });
    }
    // vendas: dois meses completos anteriores
    const hoje = new Date();
    const mesesAtras = (k: number) => new Date(hoje.getFullYear(), hoje.getMonth() - k, 1);
    const m1 = mesesAtras(2);
    const m2 = mesesAtras(1);
    const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const from = iso(m1);
    const to = iso(new Date(m2.getFullYear(), m2.getMonth() + 1, 0));
    const vendas: Array<[number, string, "NORMAL" | "TRANSFERENCIA"]> = [
      [1, fSilv.id, "NORMAL"], [1, fSeg.id, "NORMAL"], [2, fSilv.id, "NORMAL"], [3, fSilv.id, "NORMAL"], [3, fSeg.id, "NORMAL"],
      [4, fSeg.id, "NORMAL"], [5, fSilv.id, "NORMAL"], [5, fSeg.id, "NORMAL"], [6, fSilv.id, "NORMAL"], [8, fSilv.id, "TRANSFERENCIA"],
    ];
    for (const [n, fid, nat] of vendas) {
      for (const m of [m1, m2]) {
        await prisma.vendaMensal.create({
          data: { farmaciaId: fid, produtoId: prod[n].id, ano: m.getFullYear(), mes: m.getMonth() + 1, quantidade: 10, valorTotal: 100, naturezaVenda: nat },
        });
      }
    }

    // ═══ V · equivalência com Vendas ═══════════════════════════════════
    console.log("\nV · os MESMOS valores dão o MESMO universo em Vendas e na manutenção");
    const nomeFarm = new Map([[fSilv.id, fSilv.nome], [fSeg.id, fSeg.nome]]);
    const cnpDe = new Map(Object.values(prod).map((p) => [p.id, p.cnp]));
    type Combo = { rotulo: string; v: Record<string, unknown>; m: Record<string, unknown> };
    const base = { from, to, farmaciaNomes: [fSilv.nome, fSeg.nome], incluirCredito: true, incluirTransferencias: false, apenasComStock: false, incluirManutencao: false };
    const baseM = { from, to, farmaciaIds: [fSilv.id, fSeg.id], incluirCredito: true, incluirTransferencias: false, apenasComStock: false, incluirManutencao: false };
    const combos: Combo[] = [
      { rotulo: "só período", v: {}, m: {} },
      { rotulo: "categoria Cat 1", v: { categorias: [cat1.nome] }, m: { categorias: [cat1.nome] } },
      { rotulo: "categoria Cat 2", v: { categorias: [cat2.nome] }, m: { categorias: [cat2.nome] } },
      { rotulo: "subcategoria 1.1", v: { subcategorias: [sub11.nome] }, m: { subcategorias: [sub11.nome] } },
      { rotulo: "categoria + subcategoria", v: { categorias: [cat1.nome], subcategorias: [sub12.nome] }, m: { categorias: [cat1.nome], subcategorias: [sub12.nome] } },
      { rotulo: "utilização", v: { utilizacoes: ["mf-tosse"] }, m: { utilizacoes: ["mf-tosse"] } },
      { rotulo: "pesquisa (designação)", v: { pesquisa: "Alfa" }, m: { pesquisa: "Alfa" } },
      { rotulo: "pesquisa (CNP parcial)", v: { pesquisa: "710000" }, m: { pesquisa: "710000" } },
      { rotulo: "distribuidor DIST-1", v: { distribuidores: ["DIST-1"] }, m: { distribuidores: ["DIST-1"] } },
      { rotulo: "distribuidor DIST-2", v: { distribuidores: ["DIST-2"] }, m: { distribuidores: ["DIST-2"] } },
      { rotulo: "lista de CNP", v: { cnps: [prod[1].cnp, prod[4].cnp, prod[6].cnp] }, m: { cnps: [prod[1].cnp, prod[4].cnp, prod[6].cnp] } },
      { rotulo: "fabricante A (nome em Vendas ≡ ID aqui)", v: { fabricantes: ["MF-FAB-A"] }, m: { fabricanteAtualIds: [fabA.id] } },
      { rotulo: "fabricantes A+B", v: { fabricantes: ["MF-FAB-A", "MF-FAB-B"] }, m: { fabricanteAtualIds: [fabA.id, fabB.id] } },
      { rotulo: "fabricante + categoria + distribuidor", v: { fabricantes: ["MF-FAB-A"], categorias: [cat1.nome], distribuidores: ["DIST-1"] }, m: { fabricanteAtualIds: [fabA.id], categorias: [cat1.nome], distribuidores: ["DIST-1"] } },
      { rotulo: "sem classificação", v: { apenasSemClassif: true }, m: { apenasSemClassif: true } },
      { rotulo: "stock sem vendas (P7 entra)", v: { apenasComStock: true }, m: { apenasComStock: true } },
      { rotulo: "guias de transferência (P8 entra)", v: { incluirTransferencias: true }, m: { incluirTransferencias: true } },
      { rotulo: "uma só farmácia (Segurado)", v: { farmaciaNomes: [fSeg.nome] }, m: { farmaciaIds: [fSeg.id] } },
    ];
    for (const c of combos) {
      const rows = (await getVendasData({ ...base, ...c.v } as never, prisma)).rows;
      const paresVendas = new Set(rows.map((r) => `${Number(r.codigo)}|${r.farmacia}`));
      const produtosVendas = new Set(rows.map((r) => Number(r.codigo)));
      const filtroM = { ...baseM, ...c.m } as never;
      const alvosF = await M2.resolverAlvos(prisma, "FORNECEDOR", filtroM);
      const paresManut = new Set(alvosF.map((a) => `${cnpDe.get(a.produtoId)}|${nomeFarm.get(a.farmaciaId!)}`));
      const alvosFab = await M2.resolverAlvos(prisma, "FABRICANTE", filtroM);
      const produtosManut = new Set(alvosFab.map((a) => cnpDe.get(a.produtoId)!));
      // FORNECEDOR: o par (produto, farmácia) tem de existir em ProdutoFarmacia — todos existem aqui.
      check(ordenado([...paresVendas].map(String)) === ordenado([...paresManut].map(String)), `V · ${c.rotulo}: mesmos pares produto×farmácia (${paresVendas.size})`, `vendas=${ordenado([...paresVendas].map(String))} manut=${ordenado([...paresManut].map(String))}`);
      check(ordenado([...produtosVendas].map(String)) === ordenado([...produtosManut].map(String)), `V · ${c.rotulo}: mesmos produtos (${produtosVendas.size})`);
    }

    // ═══ F · fabricantes (sem período = todo o catálogo) ═══════════════
    console.log("\nF · fabricante actual: um, vários, «sem fabricante», combinações, contagem e paginação");
    const cnpsDe = async (tipo: "FABRICANTE" | "FORNECEDOR", f: Record<string, unknown>) =>
      new Set((await M2.resolverAlvos(prisma, tipo, f as never)).map((a) => cnpDe.get(a.produtoId)!));
    const set = (...ns: number[]) => new Set(ns.map((n) => prod[n].cnp));
    const igual = (a: Set<number>, b: Set<number>) => ordenado([...a].map(String)) === ordenado([...b].map(String));
    check(igual(await cnpsDe("FABRICANTE", {}), set(1, 2, 3, 4, 5, 6, 7, 8)), "F1: sem filtros = todo o catálogo (8)");
    check(igual(await cnpsDe("FABRICANTE", { fabricanteAtualIds: [fabA.id] }), set(1, 2, 7)), "F2: um fabricante actual (A)");
    check(igual(await cnpsDe("FABRICANTE", { fabricanteAtualIds: [fabA.id, fabB.id] }), set(1, 2, 3, 4, 7)), "F3: vários fabricantes actuais (A+B)");
    check(igual(await cnpsDe("FABRICANTE", { semFabricante: true }), set(6, 8)), "F4: «sem fabricante»");
    check(igual(await cnpsDe("FABRICANTE", { fabricanteAtualIds: [fabC.id], semFabricante: true }), set(5, 6, 8)), "F5: «C OU sem fabricante»");
    check(igual(await cnpsDe("FABRICANTE", { fabricanteAtualIds: [fabA.id], categorias: [cat1.nome] }), set(1, 2, 7)), "F6: fabricante + categoria");
    check(igual(await cnpsDe("FABRICANTE", { fabricanteAtualIds: [fabA.id], categorias: [cat1.nome], subcategorias: [sub11.nome] }), set(1)), "F7: fabricante + categoria + subcategoria");
    check(igual(await cnpsDe("FABRICANTE", { fabricanteAtualIds: [fabA.id, fabB.id], tipoArtigo: "PARAFARMACIA" }), set(3, 4)), "F8: fabricantes + tipo de artigo");
    check(igual(await cnpsDe("FABRICANTE", { fabricanteAtualIds: [fabA.id], pesquisa: "Comprimidos" }), set(2)), "F9: fabricante + pesquisa textual");
    check(igual(await cnpsDe("FABRICANTE", { fabricanteAtualIds: [fabA.id], farmaciaIds: [fSeg.id], distribuidores: ["DIST-2"] }), set(1)), "F10: fabricante + farmácia + distribuidor (P1 tem DIST-2 no Segurado)");
    check(igual(await cnpsDe("FABRICANTE", { utilizacoes: ["mf-tosse"], fabricanteAtualIds: [fabB.id] }), set(4)), "F11: fabricante + utilização");
    check(igual(await cnpsDe("FABRICANTE", { fabricanteAtualIds: [fabA.id], tipoArtigo: "PARAFARMACIA" }), set()), "F12: combinação sem resultados = zero (nunca o catálogo inteiro)");
    check(igual(await cnpsDe("FABRICANTE", { cnps: [] }), set()), "F13: lista de CNP importada vazia = nenhum produto");
    const pag1 = await M2.listarProdutosPagina(prisma, "FABRICANTE", { fabricanteAtualIds: [fabA.id, fabB.id] }, { page: 1, pageSize: 2 });
    const pag2 = await M2.listarProdutosPagina(prisma, "FABRICANTE", { fabricanteAtualIds: [fabA.id, fabB.id] }, { page: 2, pageSize: 2 });
    const pag3 = await M2.listarProdutosPagina(prisma, "FABRICANTE", { fabricanteAtualIds: [fabA.id, fabB.id] }, { page: 3, pageSize: 2 });
    check(pag1.totalCount === 5 && pag2.totalCount === 5 && pag3.totalCount === 5, "F14: a paginação não altera a contagem total (5 em todas as páginas)");
    const todasPag = [...pag1.items, ...pag2.items, ...pag3.items].map((i) => i.cnp);
    check(todasPag.length === 5 && new Set(todasPag).size === 5, "F15: as páginas cobrem o universo sem repetir nem faltar");
    // selecção de TODOS os resultados não inclui produtos fora do filtro
    const prevTodos = await M2.previewOperacao(prisma, "FABRICANTE", { fabricanteAtualIds: [fabA.id] }, { modo: "existente", id: fabD.id }, { modo: "todos" });
    check(prevTodos.ok && prevTodos.totalCount === 3 && prevTodos.totalCorrespondentes === 3, "F16: «todos os resultados» = só os 3 do fabricante A");

    // ═══ S · selecção e snapshot ═══════════════════════════════════════
    console.log("\nS · selecção, snapshot verificável e zero alterações fora dele");
    const fA = { fabricanteAtualIds: [fabA.id] };
    const prevManual = await M2.previewOperacao(prisma, "FABRICANTE", fA, { modo: "existente", id: fabD.id }, { modo: "manual", chaves: [prod[1].id, prod[2].id, prod[3].id /* P3 é do fabricante B — fora do filtro */, "forjada"] });
    check(prevManual.ok && prevManual.totalCount === 2, "S1: chaves fora do filtro / forjadas NÃO entram na selecção (2, não 4)");
    const prevExcl = await M2.previewOperacao(prisma, "FABRICANTE", fA, { modo: "existente", id: fabD.id }, { modo: "todos", excluidas: [prod[7].id] });
    check(prevExcl.ok && prevExcl.totalCount === 2 && prevExcl.totalCorrespondentes === 3, "S2: «todos menos» exclui o que o utilizador desmarcou");
    if (!prevManual.ok || !prevExcl.ok) throw new Error("setup S");
    check(M2.hashSnapshot("FABRICANTE", fA, await M2.resolverAlvos(prisma, "FABRICANTE", fA)) !== prevManual.snapshotHash, "S3: o hash do conjunto completo difere do da selecção parcial");

    // apply com hash de OUTRA selecção → recusa, zero escritas
    const antes = await prisma.produto.findMany({ where: { fabricanteId: fabA.id }, select: { id: true } });
    const rHashErrado = await M2.aplicarManutencaoMassa(prisma, { tipo: "FABRICANTE", filtro: fA, destino: { modo: "existente", id: fabD.id }, selecao: { modo: "todos" }, snapshotHash: prevManual.snapshotHash, utilizadorId: user.id });
    check(!rHashErrado.ok && rHashErrado.code === "PREVIEW_DESACTUALIZADO", "S4: um snapshot que não corresponde à selecção enviada é recusado");
    const rSemHash = await M2.aplicarManutencaoMassa(prisma, { tipo: "FABRICANTE", filtro: fA, destino: { modo: "existente", id: fabD.id }, snapshotHash: "", utilizadorId: user.id });
    check(!rSemHash.ok, "S5: sem snapshot não se aplica");
    check((await prisma.produto.count({ where: { fabricanteId: fabA.id } })) === antes.length, "S6: nada foi escrito nas recusas");

    // alteração ENTRE o preview e o apply → recusa
    const prevOk = await M2.previewOperacao(prisma, "FABRICANTE", fA, { modo: "existente", id: fabD.id }, { modo: "manual", chaves: [prod[1].id, prod[2].id] });
    if (!prevOk.ok) throw new Error("setup S7");
    await prisma.produto.update({ where: { id: prod[2].id }, data: { fabricanteId: fabC.id } }); // outra pessoa alterou P2
    const rDesact = await M2.aplicarManutencaoMassa(prisma, { tipo: "FABRICANTE", filtro: fA, destino: { modo: "existente", id: fabD.id }, selecao: { modo: "manual", chaves: [prod[1].id, prod[2].id] }, snapshotHash: prevOk.snapshotHash, utilizadorId: user.id });
    check(!rDesact.ok && rDesact.code === "PREVIEW_DESACTUALIZADO", "S7: alteração entre preview e apply → PREVIEW_DESACTUALIZADO");
    check((await prisma.produto.findUniqueOrThrow({ where: { id: prod[1].id } })).fabricanteId === fabA.id, "S8: P1 não foi tocado");
    await prisma.produto.update({ where: { id: prod[2].id }, data: { fabricanteId: fabA.id } }); // repõe

    // alteração concorrente DENTRO da transacção (compare-and-set)
    const prev2 = await M2.previewOperacao(prisma, "FABRICANTE", fA, { modo: "existente", id: fabD.id }, { modo: "manual", chaves: [prod[1].id, prod[2].id] });
    if (!prev2.ok) throw new Error("setup S9");
    const opsAntes = await prisma.catalogoManutencaoOperacao.count();
    const prismaConcorrente = new Proxy(prisma as unknown as Record<string, unknown>, {
      get(t, prop, r) {
        if (prop === "$transaction") {
          const orig = Reflect.get(t, prop, r) as (...a: unknown[]) => unknown;
          return (fn: (tx: Record<string, unknown>) => unknown, opts?: unknown) =>
            orig.call(t, (tx: Record<string, unknown>) =>
              fn(new Proxy(tx, {
                get(tt, pp, rr) {
                  if (pp === "produto") {
                    const d = Reflect.get(tt, pp, rr) as Record<string, unknown>;
                    return new Proxy(d, {
                      get(dt, dp, dr) {
                        if (dp === "updateMany") {
                          return async (args: unknown) => {
                            // alguém altera P2 (fora desta transacção) logo antes de a escrita em bloco correr
                            await (prisma as unknown as { produto: { update: (a: unknown) => Promise<unknown> } }).produto.update({ where: { id: prod[2].id }, data: { fabricanteId: fabC.id } });
                            return (Reflect.get(dt, dp, dr) as (a: unknown) => Promise<unknown>).call(dt, args);
                          };
                        }
                        return Reflect.get(dt, dp, dr);
                      },
                    });
                  }
                  return Reflect.get(tt, pp, rr);
                },
              })), opts);
        }
        return Reflect.get(t, prop, r);
      },
    }) as unknown as typeof prisma;
    const rConc = await M2.aplicarManutencaoMassa(prismaConcorrente, { tipo: "FABRICANTE", filtro: fA, destino: { modo: "existente", id: fabD.id }, selecao: { modo: "manual", chaves: [prod[1].id, prod[2].id] }, snapshotHash: prev2.snapshotHash, utilizadorId: user.id });
    check(!rConc.ok && rConc.code === "CONCORRENCIA", "S9: alteração concorrente dentro da transacção → CONCORRENCIA (compare-and-set)", JSON.stringify(rConc));
    check((await prisma.produto.findUniqueOrThrow({ where: { id: prod[1].id } })).fabricanteId === fabA.id, "S10: rollback total — P1 (que ia ser escrito primeiro) continua com o fabricante original");
    check((await prisma.catalogoManutencaoOperacao.count()) === opsAntes, "S11: nenhuma operação de auditoria criada");
    await prisma.produto.update({ where: { id: prod[2].id }, data: { fabricanteId: fabA.id } });

    // apply verdadeiro, só o snapshot
    const prev3 = await M2.previewOperacao(prisma, "FABRICANTE", fA, { modo: "existente", id: fabD.id }, { modo: "manual", chaves: [prod[1].id, prod[2].id] });
    if (!prev3.ok) throw new Error("setup S12");
    const rOk = await M2.aplicarManutencaoMassa(prisma, { tipo: "FABRICANTE", filtro: fA, destino: { modo: "existente", id: fabD.id }, selecao: { modo: "manual", chaves: [prod[1].id, prod[2].id] }, snapshotHash: prev3.snapshotHash, utilizadorId: user.id });
    check(rOk.ok && rOk.quantidadeAlterada === 2, "S12: aplica exactamente o snapshot confirmado (2)");
    check((await prisma.produto.findUniqueOrThrow({ where: { id: prod[7].id } })).fabricanteId === fabA.id, "S13: P7 (do filtro mas NÃO seleccionado) não foi tocado");
    const fora = await prisma.produto.findMany({ where: { id: { notIn: [prod[1].id, prod[2].id] } }, select: { id: true, fabricanteId: true } });
    check(fora.every((p) => (p.id === prod[7].id ? p.fabricanteId === fabA.id : true)), "S14: zero alterações fora do snapshot");
    if (rOk.ok) {
      const rev = await M2.reverterOperacao(prisma, rOk.operacaoId, user.id);
      check(rev.ok && rev.revertidos === 2, "S15: reversão restaura os 2 (em bloco)");
      check((await prisma.produto.findUniqueOrThrow({ where: { id: prod[1].id } })).fabricanteId === fabA.id, "S16: P1 de volta ao fabricante A");
    }

    // ═══ H · fornecedor habitual por farmácia ═════════════════════════
    console.log("\nH · fornecedor habitual: filtros por valor actual, isolamento por farmácia, uma operação por farmácia");
    const alvosForn = async (f: Record<string, unknown>) => (await M2.resolverAlvos(prisma, "FORNECEDOR", f as never)).map((a) => `${cnpDe.get(a.produtoId)! - 7_100_000}|${a.farmaciaId === fSilv.id ? "S" : "G"}`).sort().join(",");
    check((await alvosForn({ farmaciaIds: [fSilv.id], fornecedorAtualIds: [foX.id] })) === "1|S,2|S,5|S", "H1: um fornecedor actual (X) na Silveirense");
    check((await alvosForn({ farmaciaIds: [fSilv.id], fornecedorAtualIds: [foX.id, foY.id] })) === "1|S,2|S,3|S,5|S,7|S", "H2: vários fornecedores actuais (X+Y) na Silveirense");
    check((await alvosForn({ farmaciaIds: [fSilv.id], semFornecedor: true })) === "4|S,6|S,8|S", "H3: «sem fornecedor habitual» na Silveirense");
    check((await alvosForn({ farmaciaIds: [fSeg.id], semFornecedor: true })) === "2|G,5|G,7|G,8|G", "H4: «sem fornecedor habitual» no Segurado — dados DIFERENTES do outro");
    check((await alvosForn({ farmaciaIds: [fSeg.id], fornecedorAtualIds: [foX.id], semFornecedor: true })) === "2|G,4|G,5|G,6|G,7|G,8|G", "H5: «X OU sem fornecedor» no Segurado");
    check((await alvosForn({ farmaciaIds: [fSilv.id, fSeg.id], fornecedorAtualIds: [foY.id] })) === "1|G,3|G,3|S,7|S", "H6: ambas as farmácias explícitas — cada par com o SEU valor");
    check((await alvosForn({ farmaciaIds: [fSilv.id], fornecedorAtualIds: [foX.id], fabricanteAtualIds: [fabA.id] })) === "1|S,2|S", "H7: fornecedor habitual + fabricante actual (filtro de Vendas)");

    // apply só Silveirense: Segurado intacto
    const filtroS = { farmaciaIds: [fSilv.id], semFornecedor: true };
    const pvS = await M2.previewOperacao(prisma, "FORNECEDOR", filtroS, { modo: "existente", id: foZ.id });
    check(pvS.ok && pvS.totalCount === 3 && pvS.porFarmacia.length === 1 && pvS.porFarmacia[0].farmaciaId === fSilv.id, "H8: preview só com a Silveirense (3), por farmácia");
    if (!pvS.ok) throw new Error("setup H");
    const snapSeg = JSON.stringify(await prisma.produtoFarmacia.findMany({ where: { farmaciaId: fSeg.id }, orderBy: { produtoId: "asc" }, select: { produtoId: true, fornecedorHabitualId: true } }));
    const rS = await M2.aplicarManutencaoMassa(prisma, { tipo: "FORNECEDOR", filtro: filtroS, destino: { modo: "existente", id: foZ.id }, snapshotHash: pvS.snapshotHash, utilizadorId: user.id });
    check(rS.ok && rS.operacoes.length === 1 && rS.operacoes[0].farmaciaId === fSilv.id, "H9: uma operação, da Silveirense");
    check(JSON.stringify(await prisma.produtoFarmacia.findMany({ where: { farmaciaId: fSeg.id }, orderBy: { produtoId: "asc" }, select: { produtoId: true, fornecedorHabitualId: true } })) === snapSeg, "H10: a Segurado NUNCA foi alterada pela operação da Silveirense");

    // apply ambas (explícitas) → duas operações, uma por farmácia
    const filtroAmbas = { farmaciaIds: [fSilv.id, fSeg.id], fornecedorAtualIds: [foY.id] };
    const pvA = await M2.previewOperacao(prisma, "FORNECEDOR", filtroAmbas, { modo: "existente", id: foZ.id });
    check(pvA.ok && pvA.porFarmacia.length === 2 && pvA.porFarmacia.every((f) => f.abrangidos > 0 && f.agrupadoPorValorAnterior.length > 0), "H11: preview mostra as DUAS farmácias, cada uma com o seu actual→destino");
    if (!pvA.ok) throw new Error("setup H2");
    const rA = await M2.aplicarManutencaoMassa(prisma, { tipo: "FORNECEDOR", filtro: filtroAmbas, destino: { modo: "existente", id: foZ.id }, snapshotHash: pvA.snapshotHash, utilizadorId: user.id });
    check(rA.ok && rA.operacoes.length === 2 && new Set(rA.operacoes.map((o) => o.farmaciaId)).size === 2, "H12: ambas explícitas → 2 operações (uma por farmácia)");
    check((await prisma.produtoFarmacia.count({ where: { fornecedorHabitualId: foY.id } })) === 0, "H13: todos os Y das duas farmácias passaram a Z");
    check((await prisma.produtoFarmacia.count({ where: { farmaciaId: fSeg.id, fornecedorHabitualId: foX.id } })) === 2, "H14: os X do Segurado (fora do filtro) ficaram intactos");
    if (rA.ok) {
      const opSeg = rA.operacoes.find((o) => o.farmaciaId === fSeg.id)!;
      const revSeg = await M2.reverterOperacao(prisma, opSeg.operacaoId, user.id);
      check(revSeg.ok, "H15: reversão da operação do Segurado");
      check((await prisma.produtoFarmacia.count({ where: { farmaciaId: fSeg.id, fornecedorHabitualId: foY.id } })) === opSeg.quantidadeAlterada, "H16: …restaura o Segurado");
      check((await prisma.produtoFarmacia.count({ where: { farmaciaId: fSilv.id, fornecedorHabitualId: foZ.id } })) >= 1, "H17: …e a Silveirense continua com o destino (reversão por farmácia)");
    }

    // ═══ G · universo grande ═══════════════════════════════════════════
    console.log("\nG · 36 000 produtos — contagem, página, `in` enorme e apply em bloco");
    const catG = await prisma.classificacao.create({ data: { nome: "MF Cat Grande", tipo: "NIVEL_1" } });
    const N = 36_000;
    for (let i = 0; i < N; i += 4000) {
      await prisma.produto.createMany({
        data: Array.from({ length: Math.min(4000, N - i) }, (_, k) => ({ cnp: 9_000_000 + i + k, designacao: `MF Grande ${i + k}`, estado: "VALIDADO" as const, classificacaoNivel1Id: catG.id, tipoArtigo: "PARAFARMACIA", fabricanteId: fabA.id })),
      });
    }
    const idsG = (await prisma.produto.findMany({ where: { classificacaoNivel1Id: catG.id }, select: { id: true } })).map((p) => p.id);
    for (let i = 0; i < idsG.length; i += 6000) {
      await prisma.produtoFarmacia.createMany({ data: idsG.slice(i, i + 6000).map((id) => ({ produtoId: id, farmaciaId: fSilv.id })) });
    }
    const filtroG = { categorias: [catG.nome] };
    const tG0 = Date.now();
    const lG = await M2.listarProdutosPagina(prisma, "FABRICANTE", filtroG, { page: 3, pageSize: 50 });
    check(lG.totalCount === N && lG.items.length === 50, `G1: contagem exacta (${lG.totalCount}) e página 3 com 50 itens (${Date.now() - tG0} ms)`);
    const pvG = await M2.previewOperacao(prisma, "FABRICANTE", filtroG, { modo: "existente", id: fabD.id }, { modo: "todos" });
    check(pvG.ok && pvG.totalCount === N && pvG.iraAlterarCount === N, "G2: preview de «todos os resultados» = 36 000");
    if (!pvG.ok) throw new Error("setup G");
    const tG1 = Date.now();
    const rG = await M2.aplicarManutencaoMassa(prisma, { tipo: "FABRICANTE", filtro: filtroG, destino: { modo: "existente", id: fabD.id }, selecao: { modo: "todos" }, snapshotHash: pvG.snapshotHash, utilizadorId: user.id });
    check(rG.ok && rG.quantidadeAlterada === N, `G3: apply em bloco de 36 000 produtos concluído (${Date.now() - tG1} ms)`, JSON.stringify(rG).slice(0, 200));
    check((await prisma.produto.count({ where: { classificacaoNivel1Id: catG.id, fabricanteId: fabD.id } })) === N, "G4: todos os 36 000 têm o destino");
    const pvGF = await M2.previewOperacao(prisma, "FORNECEDOR", { farmaciaIds: [fSilv.id], categorias: [catG.nome] }, { modo: "existente", id: foZ.id }, { modo: "todos" });
    check(pvGF.ok && pvGF.totalCount === N, "G5: FORNECEDOR sobre 36 000 pares produto×farmácia");
    if (rG.ok) {
      const tG2 = Date.now();
      const revG = await M2.reverterOperacao(prisma, rG.operacaoId, user.id);
      check(revG.ok && revG.revertidos === N, `G6: reversão em bloco de 36 000 dentro do limite (${Date.now() - tG2} ms)`);
    }

    await prisma.$disconnect();
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.end();
  }
  console.log(`\n${passed} ok, ${failed} falhas`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
