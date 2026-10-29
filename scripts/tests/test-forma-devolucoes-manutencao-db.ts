/**
 * scripts/tests/test-forma-devolucoes-manutencao-db.ts
 *
 * Filtro «Forma farmacêutica» em DEVOLUÇÕES e na MANUTENÇÃO EM MASSA DO CATÁLOGO, e os requisitos transversais do filtro,
 * contra PostgreSQL REAL e DESCARTÁVEL (recusa hosts não locais), dados SINTÉTICOS:
 *
 *   D · Devoluções: `formaChave` na linha vem do SELECT que já existia (0 consultas a `produto`, 1 a `devolucao`); filtro,
 *       totais, agrupamento e exportação derivam das mesmas linhas filtradas; PDF/HTML/Excel com a linha dos filtros aplicados;
 *       «Limpar filtros»; estado por separador;
 *   M · Manutenção: o eixo é aditivo (resolverPrefiltroProdutos): lista, total (antes da paginação), selecção, preview/apply
 *       com snapshot, período, tipo FORNECEDOR; sem a forma = comportamento anterior (mesmo hash); chaves forjadas
 *       re-normalizadas; só silveira e garantia têm a funcionalidade; a manutenção em massa continua a funcionar;
 *   Q · requisitos: todos os tenants; usa Produto.formaFarmaceutica (não o INFARMED); não altera o valor guardado; agrupa SÓ
 *       espaços/acentos/maiúsculas; «Sem forma farmacêutica»; selecção consistente; antes de paginação/selecção/totais;
 *       «Limpar filtros» limpa; Margens não regenera automaticamente.
 *
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres npx tsx scripts/tests/test-forma-devolucoes-manutencao-db.ts
 */
import Module from "node:module";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import * as XLSX from "xlsx";

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
  const db = `spharm_forma_dm_${Date.now().toString(36)}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${db}`);
  try {
    execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: urlDe(db) }, encoding: "utf8" });
    process.env.DATABASE_URL = urlDe(db);
    process.env.ALLOW_LEGACY_DATABASE_FALLBACK = "1";
    const { PrismaClient } = await import("../../generated/prisma/client");
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(db) }) });
    estado.prisma = prisma;
    estado.tenant = "silveira";

    const F = await import("../../lib/catalog/forma-farmaceutica-filtro");
    const { getDevolucoesData } = await import("../../lib/devolucoes-data");
    const { buildDevolucoesReport } = await import("../../lib/reporting/adapters/devolucoes");
    const { renderReportHtml } = await import("../../lib/reporting/report-html");
    const { buildReportWorkbook } = await import("../../lib/reporting/report-excel-buffer");
    const { getReportingFilterOptions } = await import("../../lib/reporting-filter-options");
    const M2 = await import("../../lib/catalogo/manutencao-massa");
    const { normalizarFiltro } = await import("../../lib/catalogo/manutencao-massa-filtro");
    const { catalogoManutencaoAtiva } = await import("../../lib/tenant-constants");
    const { SEM_FORMA } = F;

    // ── Fixture sintética ────────────────────────────────────────────────────────────────────────────────────
    const user = await prisma.utilizador.create({ data: { email: "dm@t.pt", nome: "DM", perfil: "ADMINISTRADOR" } });
    const f1 = await prisma.farmacia.create({ data: { nome: "DM Farmácia Um" } });
    const f2 = await prisma.farmacia.create({ data: { nome: "DM Farmácia Dois" } });
    const fabX = await prisma.fabricante.create({ data: { nomeNormalizado: "DM FAB X", estado: "ATIVO" } });
    const fabDestino = await prisma.fabricante.create({ data: { nomeNormalizado: "DM FAB DESTINO", estado: "ATIVO" } });
    const forn = await prisma.fornecedor.create({ data: { nomeNormalizado: "DM FORN", estado: "ATIVO" } });

    type Def = { cnp: number; nome: string; forma: string | null };
    const defs: Def[] = [
      { cnp: 8_300_001, nome: "DM comp A", forma: "Comprimido" },
      { cnp: 8_300_002, nome: "DM comp B", forma: " COMPRIMIDO " },
      { cnp: 8_300_003, nome: "DM comp C", forma: "comprimido" },
      { cnp: 8_300_004, nome: "DM revestido", forma: "Comprimido revestido" },
      { cnp: 8_300_005, nome: "DM libertacao", forma: "Comprimido de libertação prolongada" },
      { cnp: 8_300_006, nome: "DM capsula", forma: "Cápsula" },
      { cnp: 8_300_007, nome: "DM capsula sem acento", forma: "CAPSULA" },
      { cnp: 8_300_008, nome: "DM sem forma nulo", forma: null },
      { cnp: 8_300_009, nome: "DM sem forma espacos", forma: "   " },
    ];
    const prod = new Map<number, string>();
    for (const [i, d] of defs.entries()) {
      const p = await prisma.produto.create({ data: { cnp: d.cnp, designacao: d.nome, estado: "VALIDADO", fabricanteId: fabX.id, formaFarmaceutica: d.forma } });
      prod.set(d.cnp, p.id);
      for (const f of [f1, f2]) {
        await prisma.produtoFarmacia.create({ data: { produtoId: p.id, farmaciaId: f.id, pvp: 5, pmc: 2, puc: 2, stockAtual: 10, stockMinimo: 0, stockMaximo: 100, fornecedorHabitualId: forn.id } });
      }
      // Devolução (hoje -> dentro dos 90 dias por omissão): quantidade 1,2,3… ; valor = 10 × quantidade
      await prisma.devolucao.create({
        data: { farmaciaId: i % 2 === 0 ? f1.id : f2.id, produtoId: p.id, data: new Date(), quantidade: i + 1, valor: (i + 1) * 10, tipo: "FORNECEDOR", motivo: "m", fornecedorDestinoId: forn.id },
      });
      // vendas (para o filtro de período da manutenção)
      if (d.cnp <= 8_300_004) {
        await prisma.vendaMensal.create({ data: { farmaciaId: f1.id, produtoId: p.id, ano: 2026, mes: 2, quantidade: 3, valorTotal: 15, valorBruto: 15, naturezaVenda: "NORMAL" } });
      }
    }
    const valoresGuardados = async () => JSON.stringify((await prisma.produto.findMany({ select: { cnp: true, formaFarmaceutica: true }, orderBy: { cnp: "asc" } })));
    const guardadoAntes = await valoresGuardados();
    const cnpsDe = (...ns: number[]) => ordenado(ns);
    const COMP = cnpsDe(8_300_001, 8_300_002, 8_300_003);
    const REVEST = cnpsDe(8_300_004);
    const LIBERT = cnpsDe(8_300_005);
    const CAPS = cnpsDe(8_300_006, 8_300_007);
    const SEMF = cnpsDe(8_300_008, 8_300_009);
    const TODOS = cnpsDe(...defs.map((d) => d.cnp));

    // ═══ D · Devoluções ═══
    secao("D · Devoluções");
    let consultasProduto = 0;
    let consultasDevolucao = 0;
    const contar = (modelo: string) => new Proxy((prisma as unknown as Record<string, object>)[modelo], {
      get(t, prop, r) {
        const v = Reflect.get(t, prop, r);
        if (typeof v !== "function") return v;
        return (...a: unknown[]) => {
          if (modelo === "produto") consultasProduto++;
          if (modelo === "devolucao") consultasDevolucao++;
          return (v as (...x: unknown[]) => unknown).apply(t, a);
        };
      },
    });
    estado.prisma = new Proxy(prisma as unknown as Record<string, unknown>, {
      get(t, prop, r) {
        if (prop === "produto" || prop === "devolucao") return contar(prop);
        const v = Reflect.get(t, prop, r);
        return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(t) : v;
      },
    });
    const linhas = await getDevolucoesData();
    estado.prisma = prisma;
    check(linhas.length === defs.length, `D1: ${defs.length} devoluções carregadas`, String(linhas.length));
    check(consultasProduto === 0 && consultasDevolucao === 1, `D2: sem consultas extra — 0 a \`produto\`, 1 a \`devolucao\` (a forma vem da relação do SELECT existente) [produto=${consultasProduto}, devolucao=${consultasDevolucao}]`);
    check(linhas.every((l) => l.formaChave === F.chaveFormaFarmaceutica(defs.find((d) => String(d.cnp) === l.cnp)!.forma)), "D3: cada linha traz a chave normalizada do Produto.formaFarmaceutica");
    check((await valoresGuardados()) === guardadoAntes, "D4: o valor guardado em Produto.formaFarmaceutica não foi alterado");

    const filtrar = (chaves: string[]) => linhas.filter((l) => F.passaFiltroForma(l.formaChave, chaves));
    const cnpsLinhas = (ls: typeof linhas) => ordenado(ls.map((l) => l.cnp));
    const totais = (ls: typeof linhas) => ({ n: ls.length, qtd: ls.reduce((s, l) => s + l.quantidade, 0), valor: ls.reduce((s, l) => s + l.valor, 0) });
    check(mesmo(cnpsLinhas(filtrar(["comprimido"])), COMP), "D5: «comprimido» = ' COMPRIMIDO ' + 'comprimido' + 'Comprimido' (só espaços/caixa)");
    check(mesmo(cnpsLinhas(filtrar(["comprimido revestido"])), REVEST), "D6: «Comprimido revestido» ≠ «Comprimido»");
    check(mesmo(cnpsLinhas(filtrar(["comprimido de libertacao prolongada"])), LIBERT), "D7: «libertação prolongada» é outra forma");
    check(mesmo(cnpsLinhas(filtrar(["capsula"])), CAPS), "D8: Cápsula/CAPSULA juntas (acentos/caixa)");
    check(mesmo(cnpsLinhas(filtrar([SEM_FORMA])), SEMF), "D9: «Sem forma farmacêutica» = nulo + só espaços");
    check(mesmo(cnpsLinhas(filtrar(["comprimido", "capsula"])), ordenado([...COMP, ...CAPS])), "D10: união de várias formas");
    check(mesmo(cnpsLinhas(filtrar([])), TODOS) && mesmo(cnpsLinhas(filtrar([F.chaveFormaFarmaceutica("Comprimido"), "comprimido revestido", "comprimido de libertacao prolongada", "capsula", SEM_FORMA])), TODOS), "D11: sem selecção = tudo; todas as formas = tudo (baseline)");
    const tComp = totais(filtrar(["comprimido"]));
    const esperado = totais(linhas.filter((l) => COMP.includes(l.cnp)));
    check(tComp.n === 3 && tComp.qtd === esperado.qtd && tComp.valor === esperado.valor && tComp.qtd < totais(linhas).qtd, "D12: linhas, unidades e valor calculam-se SÓ sobre as linhas filtradas");

    const cli = src("components/devolucoes/devolucoes-client.tsx");
    const idxFiltered = cli.indexOf("const filteredRows = useMemo");
    const depoisFiltered = cli.slice(idxFiltered);
    check(/passaFiltroForma\(row\.formaChave, formasSelecionadas\)/.test(cli) && /formasSelecionadas,\s*\n\s*dateFrom,/.test(cli), "D13: o predicado de forma está em `filteredRows` e nas suas dependências");
    check(/const groupedBySupplier = useMemo\(\(\) => \{\s*\n\s*const groups = new Map<string, DevolucaoRow\[\]>\(\);\s*\n\s*for \(const r of filteredRows\)/.test(depoisFiltered) && /lines: filteredRows\.length/.test(cli) && /qty: filteredRows\.reduce/.test(cli) && /value: filteredRows\.reduce/.test(cli), "D14: agrupamento por fornecedor e totais derivam de `filteredRows` (filtro ANTES de agrupar/totalizar)");
    check(/const rowsParaExportacao = groupedBySupplier\.flatMap/.test(cli), "D15: a exportação usa as linhas filtradas e agrupadas");
    check(/selectedForms: formasSelecionadas/.test(cli) && /formas: filterOptions\.formas \?\? \[\]/.test(cli), "D16: o relatório recebe as formas aplicadas e as opções (rótulos)");
    check(/FiltroFormaFarmaceutica/.test(cli) && /ChipsFormaFarmaceutica/.test(cli) && !/SearchableMultiSelect/.test(cli), "D17: usa o componente partilhado (sem cópia local)");
    check(/const limparFiltros = \(\) => \{[\s\S]*?setFormasSelecionadas\(\[\]\);[\s\S]*?\};/.test(cli) && /onClick=\{limparFiltros\}/.test(cli), "D18: «Limpar filtros» limpa a forma (e os restantes eixos)");
    check(/useEstadoSeparador<string\[\]>\("devolucoes:formas", \[\]\)/.test(cli) && /useEstadoSeparador<DevolucaoRow\[\]>\("devolucoes:rows"/.test(cli), "D19: a forma e o resultado vivem no estado por separador (mecanismo existente)");

    const opt = await getReportingFilterOptions();
    const uni = { pharmacies: [], suppliers: [], manufacturers: [], categories: [], formas: opt.formas };
    const sel = ["comprimido", SEM_FORMA];
    const filtrado = filtrar(sel);
    const rep = buildDevolucoesReport({
      rows: filtrado.map((r) => ({ data: r.data, cnp: r.cnp, produto: r.produto, farmacia: r.farmacia, fornecedor: r.fornecedor, fabricante: r.fabricante, categoria: r.categoria, quantidade: r.quantidade, valor: r.valor, motivo: r.motivo })),
      filters: { selectedForms: sel }, universe: uni, organization: "Org",
    });
    const linhaForma = rep.filtersApplied?.find((f) => f.label === "Forma farmacêutica");
    check(linhaForma?.value === "Comprimido, Sem forma farmacêutica", `D20: filtros aplicados do relatório: «Forma farmacêutica: Comprimido, Sem forma farmacêutica» — ${linhaForma?.value}`);
    check(rep.rows.length === filtrado.length && rep.summary?.find((s) => s.label === "Linhas")?.value === filtrado.length, "D21: o relatório (PDF/impressão/Excel/email) só leva as linhas filtradas, com o resumo coerente");
    const html = renderReportHtml(rep);
    check(html.includes("Forma farmacêutica") && html.includes("Sem forma farmacêutica") && !html.includes(SEM_FORMA), "D22: o HTML (impressão/PDF/email) mostra a linha, nunca a chave interna");
    const wb = buildReportWorkbook(rep);
    const textoExcel = wb.SheetNames.map((n) => JSON.stringify(XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, blankrows: false }))).join("\n");
    check(textoExcel.includes("Comprimido, Sem forma farmacêutica") && !textoExcel.includes(SEM_FORMA), "D23: o Excel mostra a linha com rótulos");
    const repSem = buildDevolucoesReport({ rows: [], filters: { selectedForms: [] }, universe: uni, organization: "Org" });
    check(!repSem.filtersApplied?.some((f) => f.label === "Forma farmacêutica"), "D24: sem selecção não há linha (relatório anterior inalterado)");

    // ═══ M · Manutenção em massa ═══
    secao("M · Manutenção em massa do catálogo (silveira e garantia)");
    const lista = async (formas: string[] | undefined, extra: Record<string, unknown> = {}, pageSize = 50, page = 1) =>
      M2.listarProdutosPagina(prisma, "FABRICANTE", { formasFarmaceuticas: formas, ...extra }, { page, pageSize });
    const base = await lista(undefined);
    check(base.totalCount === defs.length, `M1: sem a forma = comportamento anterior (${base.totalCount} produtos)`);
    const lComp = await lista(["comprimido"]);
    check(lComp.totalCount === 3 && mesmo(ordenado(lComp.items.map((i) => i.cnp)), COMP), "M2: «comprimido» devolve os 3 (espaços/caixa)");
    check(mesmo(ordenado((await lista(["comprimido revestido"])).items.map((i) => i.cnp)), REVEST), "M3: «Comprimido revestido» ≠ «Comprimido»");
    check(mesmo(ordenado((await lista([SEM_FORMA])).items.map((i) => i.cnp)), SEMF), "M4: «Sem forma farmacêutica»");
    check((await lista(["comprimido", "capsula"])).totalCount === 5, "M5: várias formas = união");
    const pag1 = await lista(["comprimido"], {}, 2, 1);
    const pag2 = await lista(["comprimido"], {}, 2, 2);
    check(pag1.totalCount === 3 && pag1.items.length === 2 && pag2.items.length === 1 && pag2.totalCount === 3, "M6: o filtro corre ANTES da paginação — total 3, páginas de 2+1");
    const forjado = await lista([" COMPRIMIDO ", "Cápsula"]);
    check(forjado.totalCount === 5, "M7: chaves não normalizadas enviadas pelo cliente são re-normalizadas no servidor");
    check((await lista([])).totalCount === defs.length && (await lista(["inexistente"])).totalCount === 0, "M8: vazio = tudo; chave sem produtos = 0 (nunca ignora a restrição)");
    const emFab = await lista(["comprimido"], { pesquisa: "comp B" });
    check(emFab.totalCount === 1 && Number(emFab.items[0].cnp) === 8_300_002, "M9: combina (E) com a pesquisa");
    const comPeriodo = await lista(["comprimido", "capsula"], { from: "2026-01-01", to: "2026-12-31", apenasComStock: false });
    check(mesmo(ordenado(comPeriodo.items.map((i) => i.cnp)), COMP), "M10: combina com o período de vendas (sem «stock sem vendas», só os de comprimido (com vendas); as cápsulas sem vendas ficam fora)", JSON.stringify(comPeriodo.items.map((i) => i.cnp)));
    const lForn = await M2.listarProdutosPagina(prisma, "FORNECEDOR", { farmaciaIds: [f1.id], formasFarmaceuticas: ["capsula"] }, { page: 1, pageSize: 50 });
    check(lForn.totalCount === 2, "M11: tipo FORNECEDOR (por farmácia) também respeita a forma");

    // normalização do filtro e snapshot
    const nf = normalizarFiltro({ formasFarmaceuticas: ["Cápsula", "capsula", " COMPRIMIDO "] });
    check(mesmo(nf.formasFarmaceuticas, ["capsula", "comprimido"]), "M12: normalizarFiltro — re-normaliza, deduplica e ordena", JSON.stringify(nf));
    check(!("formasFarmaceuticas" in normalizarFiltro({ formasFarmaceuticas: [] })) && !("formasFarmaceuticas" in normalizarFiltro({})), "M13: sem forma o filtro canónico não muda (os previews/hash anteriores continuam válidos)");
    const muitas = normalizarFiltro({ formasFarmaceuticas: Array.from({ length: 500 }, (_, i) => `forma ${i}`) });
    check((muitas.formasFarmaceuticas?.length ?? 0) === F.MAX_CHAVES_FORMA, `M14: limite de ${F.MAX_CHAVES_FORMA} chaves no servidor`);

    // preview/apply com snapshot — a manutenção em massa não parte
    const antesFab = new Map((await prisma.produto.findMany({ select: { id: true, fabricanteId: true } })).map((p) => [p.id, p.fabricanteId]));
    const fComp = { formasFarmaceuticas: ["comprimido"] };
    const pv = await M2.previewOperacao(prisma, "FABRICANTE", fComp, { modo: "existente", id: fabDestino.id }, { modo: "todos" });
    check(pv.ok && pv.totalCorrespondentes === 3 && pv.totalCount === 3 && pv.iraAlterarCount === 3, "M15: preview — 3 correspondem, 3 seleccionados, 3 a alterar", JSON.stringify(pv.ok ? pv.totalCorrespondentes : pv));
    if (!pv.ok) throw new Error("setup M15");
    const pvManual = await M2.previewOperacao(prisma, "FABRICANTE", fComp, { modo: "existente", id: fabDestino.id }, { modo: "manual", chaves: [prod.get(8_300_001)!] });
    check(pvManual.ok && pvManual.totalCount === 1 && pvManual.totalCorrespondentes === 3, "M16: selecção manual dentro do filtro (1 de 3)");
    const pvTodosMenos = await M2.previewOperacao(prisma, "FABRICANTE", fComp, { modo: "existente", id: fabDestino.id }, { modo: "todos", excluidas: [prod.get(8_300_001)!] });
    check(pvTodosMenos.ok && pvTodosMenos.totalCount === 2, "M17: «todos menos 1» respeita o filtro (2 de 3)");
    const chaveForjada = await M2.previewOperacao(prisma, "FABRICANTE", fComp, { modo: "existente", id: fabDestino.id }, { modo: "manual", chaves: [prod.get(8_300_004)!] });
    check(chaveForjada.ok && chaveForjada.totalCount === 0, "M18: uma chave forjada fora do filtro nunca alarga o âmbito (0 seleccionados)");
    const apErrado = await M2.aplicarManutencaoMassa(prisma, { tipo: "FABRICANTE", filtro: { formasFarmaceuticas: ["capsula"] }, destino: { modo: "existente", id: fabDestino.id }, selecao: { modo: "todos" }, snapshotHash: pv.snapshotHash, utilizadorId: user.id });
    check(!apErrado.ok && apErrado.code === "PREVIEW_DESACTUALIZADO", "M19: mudar a forma depois do preview invalida o snapshot (nada é aplicado)");
    check((await prisma.produto.count({ where: { fabricanteId: fabDestino.id } })) === 0, "M20: nada foi escrito na recusa");
    const ap = await M2.aplicarManutencaoMassa(prisma, { tipo: "FABRICANTE", filtro: fComp, destino: { modo: "existente", id: fabDestino.id }, selecao: { modo: "todos" }, snapshotHash: pv.snapshotHash, utilizadorId: user.id });
    check(ap.ok && ap.quantidadeAlterada === 3, "M21: apply altera os 3 produtos do filtro");
    const depoisFab = new Map((await prisma.produto.findMany({ select: { id: true, fabricanteId: true } })).map((p) => [p.id, p.fabricanteId]));
    const alterados = [...depoisFab].filter(([id, v]) => antesFab.get(id) !== v).map(([id]) => id).sort();
    check(mesmo(alterados, COMP.map((c) => prod.get(Number(c))!).sort()), "M22: ZERO alterações fora do filtro (só os 3 de comprimido)");
    check((await valoresGuardados()) === guardadoAntes, "M23: a manutenção do fabricante não toca em formaFarmaceutica");
    if (ap.ok) {
      const rv = await M2.reverterOperacao(prisma, ap.operacaoId, user.id);
      const rep2 = new Map((await prisma.produto.findMany({ select: { id: true, fabricanteId: true } })).map((p) => [p.id, p.fabricanteId]));
      check(rv.ok && [...antesFab].every(([id, v]) => rep2.get(id) === v), "M24: a reversão repõe exactamente o estado anterior");
    }
    const hashSem = M2.hashSnapshot("FABRICANTE", {}, [{ chave: "a", valorAnteriorId: null } as never]);
    const hashVazio = M2.hashSnapshot("FABRICANTE", { formasFarmaceuticas: [] }, [{ chave: "a", valorAnteriorId: null } as never]);
    const hashForma = M2.hashSnapshot("FABRICANTE", { formasFarmaceuticas: ["comprimido"] }, [{ chave: "a", valorAnteriorId: null } as never]);
    check(hashSem === hashVazio && hashSem !== hashForma, "M25: o hash só muda quando há forma (previews anteriores mantêm-se válidos)");

    // Tenants
    check(catalogoManutencaoAtiva("silveira") && catalogoManutencaoAtiva("garantia"), "M26: a manutenção existe em silveira e garantia");
    check(!catalogoManutencaoAtiva("segurado") && !catalogoManutencaoAtiva("outro") && !catalogoManutencaoAtiva(null), "M27: noutros tenants continua inexistente (o filtro não a abre)");
    const page = src("app/catalogo/manutencao/page.tsx");
    check(/catalogoManutencaoAtiva\(tenantSlug\)/.test(page) && /notFound\(\)/.test(page), "M28: a página continua protegida pelo gate do tenant");
    const mcli = src("components/catalogo/manutencao-massa-client.tsx");
    check(/formas: opcoes\.filterOptions\.formas \?\? \[\]/.test(mcli) && /formas: campo\("formas"\)/.test(mcli) && /formasFarmaceuticas: f\.formas/.test(mcli), "M29: a grelha usa o painel partilhado e envia as chaves ao servidor");
    check(/const FORM_VAZIO[\s\S]*?formas: \[\],/.test(mcli) && /function limparFiltros\(\) \{\s*\n\s*setForm\(\(prev\) => \(\{ \.\.\.FORM_VAZIO/.test(mcli), "M30: «Limpar filtros» repõe as formas (FORM_VAZIO)");
    check(/const filtroKey = JSON\.stringify\(filtro\)/.test(mcli) && /a selecção foi limpa/.test(mcli), "M31: mudar a forma muda o filtro => a selecção é limpa com aviso (nunca fica selecção invisível)");
    check(/formasFarmaceuticas: filtro\.formasFarmaceuticas/.test(src("app/catalogo/manutencao/actions.ts")), "M32: o servidor valida o tamanho/forma do novo campo");

    // ═══ Q · requisitos transversais ═══
    secao("Q · requisitos do filtro");
    const opcoesPorTenant: Record<string, string> = {};
    for (const t of ["silveira", "garantia", "segurado", "novo-tenant", null as unknown as string]) {
      estado.tenant = t;
      opcoesPorTenant[String(t)] = JSON.stringify((await getReportingFilterOptions()).formas);
    }
    estado.tenant = "silveira";
    check(new Set(Object.values(opcoesPorTenant)).size === 1 && JSON.parse(opcoesPorTenant.silveira).length > 0, "Q1: as opções existem e são calculadas da mesma forma para qualquer tenant (nenhum gate por slug)");
    const sqlMod = src("lib/catalog/forma-farmaceutica-sql.ts");
    check(!/gruposLaboratoriaisAtivos|catalogoManutencaoAtiva|resolveCurrentTenantSlug|TENANT_/.test(sqlMod + src("lib/catalog/forma-farmaceutica-filtro.ts")), "Q2: o módulo do filtro não referencia tenants");
    check(/formaFarmaceutica/.test(sqlMod) && !/ProdutoRegulamentar|RegulatoryRecord|regulatory/i.test(sqlMod), "Q3: a fonte é Produto.formaFarmaceutica (nenhuma tabela do INFARMED)");
    // o INFARMED diverge do produto: o filtro segue o produto
    const importacao = await prisma.infarmedImportacao.create({ data: { origem: "TESTE", sha256: "c".repeat(64), descarregadoEm: new Date(), estado: "APLICADA", ativa: true } });
    await prisma.produtoRegulamentar.create({ data: { importacaoId: importacao.id, produtoId: prod.get(8_300_001)!, cnp: 8_300_001, formaFarmaceutica: "Solução injetável" } });
    check((await lista(["solucao injetavel"])).totalCount === 0 && (await lista(["comprimido"])).totalCount === 3, "Q4: mesmo com outra forma no INFARMED, o filtro usa Produto.formaFarmaceutica");
    check((await valoresGuardados()) === guardadoAntes, "Q5: após todas as operações o valor guardado é IDÊNTICO ao inicial");
    const pares: Array<[string, string, boolean]> = [
      ["Comprimido", "COMPRIMIDO", true], ["Comprimido", "  comprimido  ", true], ["Comprimido", "Comprimido\t", true], ["Cápsula", "CAPSULA", true],
      ["Comprimido", "Comprimido revestido", false], ["Comprimido", "Comprimido de libertação prolongada", false], ["Comprimido revestido", "Comprimido de libertação prolongada", false],
      ["Comprimido", "Comprimidos", false], ["Cápsula", "Cápsulas", false], ["Comprimido", "Comp.", false], ["Pó", "Po", true],
    ];
    check(pares.every(([a, b, igual]) => (F.chaveFormaFarmaceutica(a) === F.chaveFormaFarmaceutica(b)) === igual), "Q6: agrupa SÓ espaços/acentos/maiúsculas (nada de plural, abreviatura ou forma clinicamente diferente)");
    const opts = (await getReportingFilterOptions()).formas;
    const oSem = opts.find((o) => o.chave === SEM_FORMA);
    check(oSem?.label === "Sem forma farmacêutica" && oSem.count === 2 && opts[opts.length - 1].chave === SEM_FORMA, "Q7: «Sem forma farmacêutica» existe (2 produtos) e fica no fim");
    const oComp = opts.find((o) => o.chave === "comprimido");
    check(oComp?.count === 3 && opts.find((o) => o.chave === "comprimido revestido")?.count === 1, "Q8: contagens por opção coerentes com a listagem (3 / 1)");
    // selecção consistente: o que o filtro lista é o que a selecção «todos» alcança
    const alvos = await M2.previewOperacao(prisma, "FABRICANTE", { formasFarmaceuticas: ["capsula"] }, { modo: "existente", id: fabDestino.id }, { modo: "todos" });
    check(alvos.ok && alvos.totalCount === (await lista(["capsula"])).totalCount, "Q9: selecção «todos» alcança exactamente o que a listagem filtrada mostra");
    // Margens não regenera automaticamente
    const margens = src("components/margens/margens-client.tsx");
    const barra = src("components/reporting/report-filters-bar.tsx");
    check(!/passaFiltroForma|formaFarmaceutica/.test(margens) && /FiltroFormaFarmaceutica/.test(barra), "Q10: Margens — o filtro vive na barra partilhada e o cliente não filtra/gera a partir dele");
    check(!/useEffect\([^)]*formasFarmaceuticas/.test(margens) && !/formasFarmaceuticas[^;\n]*gerar\(/i.test(margens), "Q11: Margens — nenhuma dependência de efeito/gerar() na forma (alterar a forma só marca «alterações por aplicar»)");
    check(/lista\("formasFarmaceuticas"\)/.test(src("lib/reporting/filtros-aplicados.ts")), "Q12: a forma entra na comparação rascunho≠aplicado (aviso em vez de regeneração)");
    // estado por separador (áreas com mecanismo)
    const estadoSep = ["components/devolucoes/devolucoes-client.tsx", "components/encomendas/order-create-client.tsx"].map((f) => /useEstadoSeparador/.test(src(f)));
    check(estadoSep.every(Boolean), "Q13: Devoluções e a proposta de Encomenda guardam a forma no estado por separador");
    check(/formasSelecionadas/.test(src("components/vendas/vendas-client.tsx")) && /formasSelecionadas/.test(src("components/excessos/excessos-client.tsx")) && /formasSelecionadas/.test(src("components/transferencias/transferencias-client.tsx")), "Q14: Vendas/Excessos/Transferências mantêm a forma no estado de workspace");

    await prisma.$disconnect();
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => undefined);
    await admin.end();
  }
  console.log(`\n${ko === 0 ? "PASSOU" : "FALHOU"} — ${ok} OK, ${ko} falhas\n`);
  process.exit(ko === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
