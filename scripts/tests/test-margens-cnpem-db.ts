/**
 * scripts/tests/test-margens-cnpem-db.ts
 *
 * Margens — margem unitária, preços do utente (INFARMED) e comparação por
 * CNPEM, contra um PostgreSQL REAL e DESCARTÁVEL:
 *
 *   docker run -d --name spharm-mg-pg -e POSTGRES_PASSWORD=test -p 15433:5432 postgres:16-alpine
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres npx tsx scripts/tests/test-margens-cnpem-db.ts
 */
import Module from "node:module";
import { execSync } from "node:child_process";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import * as XLSX from "xlsx";

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
const secao = (t: string) => console.log(`\n── ${t}`);

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgresql://postgres:test@localhost:15433/postgres";
const host = new URL(ADMIN_URL).hostname;
if (host !== "localhost" && host !== "127.0.0.1") {
  console.error(`RECUSADO: ${host} não é uma base local descartável.`);
  process.exit(2);
}
const urlDe = (db: string) => { const u = new URL(ADMIN_URL); u.pathname = `/${db}`; return u.toString(); };

const CAB = ["Nº registo", "Substância Ativa/DCI", "Nome do medicamento", "Forma farmacêutica", "Dosagem", "Tamanho da embalagem", "CNPEM", "Preço (PVP)", "PVP Notificado", "Preço Utente", "Preço Pensionistas", "Comerc.", "Genérico"];
function xlsBuf(rows: Array<Array<string | number | null>>): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([CAB, ...rows]), "Medicamentos");
  return XLSX.write(wb, { type: "buffer", bookType: "biff8" }) as Buffer;
}
const L = (reg: string, cnpem: number | null, nome: string, geral: number | null, esp: number | null, dci = "Ibuprofeno") =>
  [reg, dci, nome, "Comprimido", "400 mg", "20 unidade(s)", cnpem, 5, null, geral, esp, "Comercializado", "Não"];

async function correrNoutroTenant(urlB: string) {
  // Modo filho: o mesmo motor, noutra base (outro "tenant"), em processo separado.
  const { getMargensComparacaoCnpem } = await import("../../lib/margens-data");
  const r = await getMargensComparacaoCnpem({ from: "2026-01-01", to: "2026-12-31" }, 7000001);
  console.log("@@RESULT@@" + JSON.stringify(r.estado === "OK" ? { estado: r.estado, cnps: r.linhas.map((l) => l.cnp).sort() } : r));
  void urlB;
}

async function main() {
  if (process.argv.includes("--tenant-b")) { await correrNoutroTenant(process.env.DATABASE_URL!); process.exit(0); }

  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const suf = Date.now().toString(36);
  const dbA = `spharm_mg_a_${suf}`;
  const dbB = `spharm_mg_b_${suf}`;
  await admin.query(`CREATE DATABASE ${dbA}`);
  await admin.query(`CREATE DATABASE ${dbB}`);
  try {
    for (const db of [dbA, dbB]) execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: urlDe(db) }, encoding: "utf8" });

    process.env.DATABASE_URL = urlDe(dbA);
    process.env.ALLOW_LEGACY_DATABASE_FALLBACK = "1";
    const { PrismaClient } = await import("../../generated/prisma/client");
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(dbA) }) });
    const { getMargensData, getMargensComparacaoCnpem } = await import("../../lib/margens-data");
    const { lerFicheiroInfarmed } = await import("../../lib/regulamentar/infarmed-ficheiro");
    const { aplicarVersaoInfarmed } = await import("../../lib/regulamentar/infarmed-aplicar");

    const f1 = await prisma.farmacia.create({ data: { nome: "Farmácia Um" } });
    const f2 = await prisma.farmacia.create({ data: { nome: "Farmácia Dois" } });
    const f3 = await prisma.farmacia.create({ data: { nome: "Farmácia Três" } });

    type VM = { f: string; ano: number; mes: number; qty: number; bruto: number };
    const mk = async (cnp: number, designacao: string, pfs: Array<{ f: string; pmc?: number | null; iva?: number | null; retirado?: boolean }>, vendas: VM[], dci?: string) => {
      const p = await prisma.produto.create({ data: { cnp, designacao, dci: dci ?? null } });
      for (const pf of pfs) {
        await prisma.produtoFarmacia.create({ data: { produtoId: p.id, farmaciaId: pf.f, pvp: 9, pmc: pf.pmc === undefined ? 6 : pf.pmc, puc: 0, taxaIvaPercent: pf.iva === undefined ? 23 : pf.iva, flagRetirado: pf.retirado ?? false } });
      }
      for (const v of vendas) {
        await prisma.vendaMensal.create({ data: { farmaciaId: v.f, produtoId: p.id, ano: v.ano, mes: v.mes, quantidade: v.qty, valorTotal: v.bruto, valorBruto: v.bruto } });
      }
      return p;
    };
    // A: principal. 10 un a 123 € c/IVA 23% (=100 s/IVA), custo 6 → margem 40, unitária 4,00
    const A = await mk(7000001, "IBUPROFENO A 400", [{ f: f1.id }, { f: f2.id }], [
      { f: f1.id, ano: 2026, mes: 3, qty: 10, bruto: 123 },
      { f: f2.id, ano: 2026, mes: 3, qty: 5, bruto: 61.5 },
      { f: f1.id, ano: 2026, mes: 6, qty: 2, bruto: 24.6 },
    ], "Ibuprofeno");
    // B: mesmo CNPEM, em F1 com vendas
    const B = await mk(7000002, "IBUPROFENO B 400", [{ f: f1.id, pmc: 5 }], [{ f: f1.id, ano: 2026, mes: 3, qty: 4, bruto: 49.2 }], "Ibuprofeno");
    // C: mesmo CNPEM, existe em F1 SEM vendas no período (só vendeu em 2025)
    const C = await mk(7000003, "IBUPROFENO C 400", [{ f: f1.id }], [{ f: f1.id, ano: 2025, mes: 6, qty: 3, bruto: 36.9 }], "Ibuprofeno");
    // D: mesmo CNPEM, só existe em F3 (fora da seleção)
    const D = await mk(7000004, "IBUPROFENO D 400", [{ f: f3.id }], [{ f: f3.id, ano: 2026, mes: 3, qty: 9, bruto: 99 }], "Ibuprofeno");
    // E: MESMA DCI, CNPEM diferente
    const E = await mk(7000005, "IBUPROFENO E 600", [{ f: f1.id }], [{ f: f1.id, ano: 2026, mes: 3, qty: 7, bruto: 70 }], "Ibuprofeno");
    // F: mesmo CNPEM no ficheiro, existe no catálogo mas NÃO em nenhuma farmácia
    const F = await mk(7000006, "IBUPROFENO F 400 (só catálogo)", [], [], "Ibuprofeno");
    // G: sem CNPEM (CNP não consta do ficheiro)
    const G = await mk(7000007, "PRODUTO SEM CNPEM", [{ f: f1.id }], [{ f: f1.id, ano: 2026, mes: 3, qty: 1, bruto: 12.3 }]);
    // H: CNPEM sem alternativas
    const H = await mk(7000008, "PRODUTO SOZINHO NO CNPEM", [{ f: f1.id }], [{ f: f1.id, ano: 2026, mes: 3, qty: 1, bruto: 12.3 }]);
    // I: precisão (IVA 6 %, 3 un, bruto 10,07, custo 1,01) e quantidade líquida zero / negativa
    const I = await mk(7000009, "PRECISAO", [{ f: f1.id, pmc: 1.0149, iva: 6 }], [{ f: f1.id, ano: 2026, mes: 3, qty: 3, bruto: 10.11 }]);
    const Z = await mk(7000010, "QTD LIQUIDA ZERO", [{ f: f1.id }], [
      { f: f1.id, ano: 2026, mes: 3, qty: 5, bruto: 61.5 },
      { f: f1.id, ano: 2026, mes: 4, qty: -5, bruto: -61.5 },
    ]);
    const N = await mk(7000011, "QTD LIQUIDA NEGATIVA", [{ f: f1.id }], [{ f: f1.id, ano: 2026, mes: 3, qty: -2, bruto: -24.6 }]);
    const SI = await mk(7000012, "SEM IVA CONHECIDO", [{ f: f1.id, iva: null }], [{ f: f1.id, ano: 2026, mes: 3, qty: 2, bruto: 24.6 }]);
    const SC = await mk(7000013, "SEM CUSTO", [{ f: f1.id, pmc: 0 }], [{ f: f1.id, ano: 2026, mes: 3, qty: 2, bruto: 24.6 }]);
    void [F, G, H, I, Z, N, SI, SC, D, E, C, B];

    // ficheiro do INFARMED: inclui um CNP inexistente (7099999) com o MESMO CNPEM
    const ficheiro = lerFicheiroInfarmed(xlsBuf([
      L("7000001", 50000001, "Ibuprofeno A INFARMED", 3.5, 2.1),
      L("7000002", 50000001, "Ibuprofeno B INFARMED", 3.6, 2.2),
      L("7000003", 50000001, "Ibuprofeno C INFARMED", 3.7, null),
      L("7000004", 50000001, "Ibuprofeno D INFARMED", 3.8, 2.4),
      L("7000005", 50000002, "Ibuprofeno E INFARMED", 4.5, 3.1),
      L("7000006", 50000001, "Ibuprofeno F INFARMED", 3.9, 2.5),
      L("7000008", 50000008, "Sozinho INFARMED", 1, 0.5),
      L("7000009", 50000009, "Precisao INFARMED", 1, 0.5),
      L("7099999", 50000001, "SO NO FICHEIRO", 9.9, 9.9),
    ]));
    const ap = await aplicarVersaoInfarmed(prisma, ficheiro, { origem: "CARGA_INICIAL", apply: true });
    check(ap.resultado === "APLICADA" && ap.produtosAssociados === 8, "regulamentar carregado (8 produtos existentes, 1 CNP só no ficheiro)");

    const periodo = { from: "2026-01-01", to: "2026-12-31", farmaciaNomes: ["Farmácia Um", "Farmácia Dois"] };
    const umaFarm = { ...periodo, farmaciaNomes: ["Farmácia Um"] };

    secao("A · margem unitária");
    const principal = await getMargensData(umaFarm);
    const linhaA = principal.porProduto.find((r) => r.cnp === 7000001)!;
    // F1/A: 10 + 2 un = 12 un; bruto 147,60 → s/IVA 120; custo 12×6=72; margem 48; unitária 4
    check(linhaA.qtdVendida === 12 && linhaA.margemEur === 48, "linha A: 12 un, margem 48,00 € (motor existente inalterado)");
    check(linhaA.margemUnitaria !== null && Math.abs(linhaA.margemUnitaria - 4) < 1e-9, "margem unitária = margem total ÷ quantidade = 4,00");
    const linhaI = principal.porProduto.find((r) => r.cnp === 7000009)!;
    const brutoI = 10.11, custoI = 1.0149, qtdI = 3;
    const exato = (brutoI / 1.06 - qtdI * custoI) / qtdI;
    check(linhaI.margemUnitaria !== null && Math.abs(linhaI.margemUnitaria - exato) < 1e-12, `precisão interna mantida (${exato})`);
    const deArredondados = (linhaI.valorVendidoSemIva! - linhaI.custoEstimado!) / linhaI.qtdVendida;
        check(Math.abs(linhaI.margemUnitaria! - deArredondados) > 0 && Math.abs(linhaI.margemUnitaria! - deArredondados) < 0.01, "difere (ligeiramente) do que daria a partir de valores já arredondados — prova que não deriva deles");
    check(principal.porProduto.find((r) => r.cnp === 7000010)!.margemUnitaria === null, "quantidade líquida zero → null (apresentado «—»), sem dividir por zero");
    check(principal.porProduto.find((r) => r.cnp === 7000011)!.margemUnitaria === null, "quantidade líquida negativa → null");
    check(principal.porProduto.find((r) => r.cnp === 7000012)!.margemUnitaria === null, "IVA desconhecido → null (não se inventa)");
    check(principal.porProduto.find((r) => r.cnp === 7000013)!.margemUnitaria === null, "custo desconhecido → null (não se inventa)");
    const somaTotais = principal.totals.margemEur;
    check(typeof somaTotais === "number" && !("margemUnitaria" in principal.totals), "totais não têm margem unitária (não se soma)");

    secao("B · preços do utente (INFARMED)");
    check(linhaA.precoUtenteGeral === 3.5 && linhaA.precoUtenteEspecial === 2.1, "regime geral 3,50 e regime especial 2,10");
    check(principal.porProduto.find((r) => r.cnp === 7000013)!.precoUtenteGeral === null, "produto sem registo regulamentar → null (não 0)");
    const margemSemPrecos = linhaA.margemEur;
    await prisma.produtoRegulamentar.updateMany({ where: { produtoId: A.id }, data: { precoUtenteGeral: 99, precoUtenteEspecial: 88 } });
    const alt = (await getMargensData(umaFarm)).porProduto.find((r) => r.cnp === 7000001)!;
    check(alt.margemEur === margemSemPrecos && alt.valorVendido === linhaA.valorVendido && alt.precoUtenteGeral === 99, "os preços do utente NÃO entram no cálculo da margem");
    await prisma.produtoRegulamentar.updateMany({ where: { produtoId: A.id }, data: { precoUtenteGeral: 3.5, precoUtenteEspecial: 2.1 } });

    secao("C · comparação por CNPEM — uma farmácia");
    const c1 = await getMargensComparacaoCnpem(umaFarm, 7000001);
    check(c1.estado === "OK" && c1.cnpem === "50000001", "CNPEM resolvido no servidor a partir do CNP");
    if (c1.estado !== "OK") throw new Error("comparação falhou");
    const cnps1 = c1.linhas.map((l) => `${l.cnp}`).sort();
    check(cnps1.join() === ["7000001", "7000002", "7000003"].join(), `F1: A (analisado), B e C — [${cnps1}]`);
    check(!c1.linhas.some((l) => l.cnp === 7000005), "DCI igual com CNPEM diferente NÃO aparece");
    check(!c1.linhas.some((l) => l.cnp === 7000004), "mesmo CNPEM só noutra farmácia (não selecionada) NÃO aparece");
    check(!c1.linhas.some((l) => l.cnp === 7000006), "existe no catálogo mas em nenhuma farmácia → NÃO aparece");
    check(!c1.linhas.some((l) => l.cnp === 7099999), "produto que só existe no ficheiro do INFARMED NÃO aparece");
    const cC = c1.linhas.find((l) => l.cnp === 7000003)!;
    check(cC.semVendasNoPeriodo && cC.qtdVendida === 0 && cC.valorVendido === 0 && cC.margemEur === null && cC.margemUnitaria === null && cC.margemPct === null, "C existe na farmácia e não vendeu no período: aparece, qtd 0, margens null (não inventadas)");
    check(cC.custoUnitario === 6 && cC.precoUtenteGeral === 3.7 && cC.precoUtenteEspecial === null, "…com o custo unitário real e os preços do utente do INFARMED");
    check(c1.outrosArtigos === 2, "2 outros artigos (B e C)");

    secao("D · mesmo motor de cálculo");
    const iguais = (a: Record<string, unknown>, b: Record<string, unknown>) =>
      ["qtdVendida", "valorVendido", "valorVendidoSemIva", "custoUnitario", "custoEstimado", "margemEur", "margemPct", "margemUnitaria", "estado", "taxaIva", "pvpUnitario", "coberturaCusto"].every((k) => a[k] === b[k]);
    const lA = c1.linhas.find((l) => l.cnp === 7000001)!;
    const lB = c1.linhas.find((l) => l.cnp === 7000002)!;
    const bPrincipal = principal.porProduto.find((r) => r.cnp === 7000002)!;
    check(iguais(lA as never, linhaA as never), "o artigo analisado tem na expansão EXATAMENTE os valores do mapa principal");
    check(iguais(lB as never, bPrincipal as never), "um comparável tem os valores que teria no mapa principal");
    const apenasEsteSrc = (await import("node:fs")).readFileSync("lib/margens-data.ts", "utf8");
    check((apenasEsteSrc.match(/const margemEur =/g) ?? []).length === 1, "existe UMA só fórmula de margem em lib/margens-data.ts (sem 2.º motor)");

    secao("E · várias farmácias e período");
    const c2 = await getMargensComparacaoCnpem(periodo, 7000001);
    if (c2.estado !== "OK") throw new Error("comparação 2 falhou");
    const pares2 = c2.linhas.map((l) => `${l.cnp}@${l.farmacia}`).sort();
    check(pares2.join() === ["7000001@Farmácia Dois", "7000001@Farmácia Um", "7000002@Farmácia Um", "7000003@Farmácia Um"].join(), `F1+F2: pares artigo×farmácia — [${pares2}]`);
    check(!c2.linhas.some((l) => l.farmacia === "Farmácia Três"), "farmácias fora da seleção nunca entram");
    const todas = await getMargensComparacaoCnpem({ from: "2026-01-01", to: "2026-12-31" }, 7000001);
    if (todas.estado !== "OK") throw new Error("todas falhou");
    check(todas.linhas.some((l) => l.cnp === 7000004 && l.farmacia === "Farmácia Três"), "sem restrição de farmácias, D (em F3) aparece");
    const so2025 = await getMargensComparacaoCnpem({ from: "2025-01-01", to: "2025-12-31", farmaciaNomes: ["Farmácia Um"] }, 7000001);
    if (so2025.estado !== "OK") throw new Error("2025 falhou");
    const c2025 = so2025.linhas.find((l) => l.cnp === 7000003)!;
    check(c2025.qtdVendida === 3 && !c2025.semVendasNoPeriodo, "mudar o período muda os valores: em 2025 C já tem vendas");
    check(so2025.linhas.find((l) => l.cnp === 7000001)!.semVendasNoPeriodo, "…e A passa a não ter vendas em 2025");
    const maio = await getMargensComparacaoCnpem({ from: "2026-06-01", to: "2026-06-30", farmaciaNomes: ["Farmácia Um"] }, 7000001);
    if (maio.estado !== "OK") throw new Error("junho falhou");
    check(maio.linhas.find((l) => l.cnp === 7000001)!.qtdVendida === 2 && maio.linhas.find((l) => l.cnp === 7000002)!.semVendasNoPeriodo, "período de um mês: só A (2 un); B sem vendas nesse mês");

    secao("F · sem CNPEM / sem alternativas");
    check((await getMargensComparacaoCnpem(umaFarm, 7000007)).estado === "SEM_CNPEM", "produto sem CNPEM → SEM_CNPEM (sem comparação)");
    check((await getMargensComparacaoCnpem(umaFarm, 123)).estado === "SEM_CNPEM", "CNP inexistente → SEM_CNPEM");
    const h = await getMargensComparacaoCnpem(umaFarm, 7000008);
    check(h.estado === "OK" && h.outrosArtigos === 0 && h.linhas.length === 1, "CNPEM sem alternativas: só o próprio, outrosArtigos = 0");

    secao("G · filtros de seleção não escondem os comparáveis; só leitura");
    const comPesquisa = await getMargensComparacaoCnpem({ ...umaFarm, pesquisa: "7000001" }, 7000001);
    check(comPesquisa.estado === "OK" && comPesquisa.outrosArtigos === 2, "a pesquisa do mapa principal não esconde os artigos do mesmo CNPEM");
    const antes = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT (SELECT count(*) FROM "VendaMensal") + (SELECT count(*) FROM "ProdutoFarmacia") + (SELECT count(*) FROM "ProdutoRegulamentar") AS n`;
    await getMargensComparacaoCnpem(umaFarm, 7000001);
    const depois = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT (SELECT count(*) FROM "VendaMensal") + (SELECT count(*) FROM "ProdutoFarmacia") + (SELECT count(*) FROM "ProdutoRegulamentar") AS n`;
    check(antes[0].n === depois[0].n, "a comparação não altera dados");

    secao("H · versão regulamentar revertida: a comparação segue a versão ativa");
    const { reverterVersaoInfarmed } = await import("../../lib/regulamentar/infarmed-aplicar");
    await reverterVersaoInfarmed(prisma, { apply: true });
    check((await getMargensComparacaoCnpem(umaFarm, 7000001)).estado === "SEM_CNPEM", "sem versão ativa não há CNPEM (e nada é inventado)");

    secao("I · outro tenant com o mesmo CNPEM");
    const prismaB = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(dbB) }) });
    const fB = await prismaB.farmacia.create({ data: { nome: "Farmácia Um" } });
    const pa = await prismaB.produto.create({ data: { cnp: 7000001, designacao: "A no tenant B" } });
    const px = await prismaB.produto.create({ data: { cnp: 7000777, designacao: "ESTRANHO NO TENANT B" } });
    for (const p of [pa, px]) await prismaB.produtoFarmacia.create({ data: { produtoId: p.id, farmaciaId: fB.id, pmc: 6, taxaIvaPercent: 23 } });
    await aplicarVersaoInfarmed(prismaB, lerFicheiroInfarmed(xlsBuf([L("7000001", 50000001, "A B", 1, 1), L("7000777", 50000001, "X B", 1, 1)])), { origem: "CARGA_INICIAL", apply: true });
    // tenant A: volta a aplicar para ter versão ativa, e confirma que não vê o produto do tenant B
    await aplicarVersaoInfarmed(prisma, ficheiro, { origem: "MANUAL", apply: true, forcar: true });
    const cA = await getMargensComparacaoCnpem(umaFarm, 7000001);
    check(cA.estado === "OK" && !cA.linhas.some((l) => l.cnp === 7000777), "tenant A não vê o artigo do tenant B com o mesmo CNPEM");
    const out = execSync(`npx tsx scripts/tests/test-margens-cnpem-db.ts --tenant-b`, {
      env: { ...process.env, DATABASE_URL: urlDe(dbB), ALLOW_LEGACY_DATABASE_FALLBACK: "1" }, encoding: "utf8",
    });
    const j = JSON.parse(out.split("@@RESULT@@")[1].trim());
    check(j.estado === "OK" && j.cnps.join() === "7000001,7000777", "no tenant B (processo e base separados) a comparação vê só os artigos do tenant B");

    await prismaB.$disconnect();
    await prisma.$disconnect();
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${dbA} WITH (FORCE)`).catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS ${dbB} WITH (FORCE)`).catch(() => undefined);
    await admin.end();
  }
  console.log(`\n${passed} OK, ${failed} falhas`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
