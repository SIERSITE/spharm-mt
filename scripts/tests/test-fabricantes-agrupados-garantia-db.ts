/**
 * scripts/tests/test-fabricantes-agrupados-garantia-db.ts
 *
 * Fabricantes agrupados nos filtros — SÓ em garantia. PostgreSQL REAL e DESCARTÁVEL (recusa hosts não locais), dados
 * sintéticos:
 *   A · opções agrupadas: grupo com 10 variantes aparece 1 vez ("Nome (10 variantes)"), variantes dentro do grupo,
 *       ordem alfabética, contagem sem duplicados, fabricante sem prova separado, nomes parecidos NÃO agrupam;
 *   B · pesquisa por nome do grupo / alias do grupo / nome da variante / alias da variante (sem acentos);
 *   C · resolução: grupo -> produtos de TODAS as variantes (+ manual) sem duplicar; variante -> só a sua; união dedupe;
 *   D · tenants: garantia agrupado; silveira e sier com opções e resolução INALTERADAS (getReportingFilterOptions);
 *   E · Excessos/Transferências/Devoluções/Encomendas: seleccionar grupo devolve linhas (filtro por CNP) e o modo
 *       legado (outros tenants) compara nomes como sempre; proposta de Encomenda nova (SQL) idem;
 *   F · export (adapters): rótulo lógico "Grupo: X", nunca a lista de variantes; outros tenants iguais;
 *   G · estrutura: clientes e proposta ligados ao mecanismo; script de auditoria.
 *
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres npx tsx scripts/tests/test-fabricantes-agrupados-garantia-db.ts
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
  const db = `spharm_fabagr_${Date.now().toString(36)}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${db}`);
  try {
    execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: urlDe(db) }, encoding: "utf8" });
    const { PrismaClient } = await import("../../generated/prisma/client");
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(db) }) });
    estado.prisma = prisma;

    const L = await import("../../lib/catalog/laboratorio-filtro");
    const { carregarLaboratoriosGarantia } = await import("../../lib/catalog/carregar-laboratorios-garantia");
    const { resolverProdutoIdsPorLaboratoriosSelecionados } = await import("../../lib/reporting/resolver-laboratorio-selecionado");
    const { resolverCnpsPorLaboratoriosSelecionados } = await import("../../lib/reporting/resolver-cnps-laboratorios");
    const { passaFiltroLaboratorioLinha } = await import("../../lib/reporting/filtro-laboratorio-linhas");
    const { getReportingFilterOptions } = await import("../../lib/reporting-filter-options");
    const { generateOrderProposal } = await import("../../lib/encomendas/proposal");
    const { auditarOpcoes, validarUrlDescartavel } = await import("../diagnostics/auditoria-fabricantes-grupos-garantia");

    // ── Fixture sintética ────────────────────────────────────────────────────────────────────────────────────────
    const farm = await prisma.farmacia.create({ data: { nome: "FAG Farmácia" } });
    let cnpSeq = 8_300_000;
    const mkProd = async (nome: string, fabricanteId: string | null) =>
      prisma.produto.create({ data: { cnp: ++cnpSeq, designacao: nome, estado: "VALIDADO", fabricanteId } });
    const mkPf = async (produtoId: string) => {
      await prisma.produtoFarmacia.create({ data: { produtoId, farmaciaId: farm.id, stockAtual: 0, stockMinimo: 0, stockMaximo: 10 } });
      const hoje = new Date();
      for (let m = 1; m <= 3; m++) {
        const dt = new Date(hoje.getFullYear(), hoje.getMonth() - m, 1);
        await prisma.vendaMensal.create({ data: { farmaciaId: farm.id, produtoId, ano: dt.getFullYear(), mes: dt.getMonth() + 1, quantidade: 300, valorTotal: 3000, naturezaVenda: "NORMAL" } });
      }
    };

    const viatris = await prisma.grupoLaboratorial.create({ data: { nome: "Viatris", nomeNormalizado: "VIATRIS" } });
    await prisma.grupoLaboratorialAlias.create({ data: { grupoLaboratorialId: viatris.id, alias: "Upjohn", aliasNormalizado: "UPJOHN" } });
    const membros: Array<{ id: string; nome: string }> = [];
    const produtosViatris: Array<{ id: string; cnp: number; fabricante: string }> = [];
    for (let i = 1; i <= 10; i++) {
      const nome = `VIATRIS MEMBRO ${String(i).padStart(2, "0")}`;
      const f = await prisma.fabricante.create({ data: { nomeNormalizado: nome, estado: "ATIVO" } });
      membros.push({ id: f.id, nome });
      await prisma.grupoLaboratorialFabricante.create({ data: { grupoLaboratorialId: viatris.id, fabricanteId: f.id } });
      if (i === 1) await prisma.fabricanteAlias.create({ data: { fabricanteId: f.id, aliasNome: "MYLAN IRELAND" } });
      for (let k = 1; k <= 2; k++) {
        const p = await mkProd(`Viatris p${i}-${k}`, f.id);
        await mkPf(p.id);
        await prisma.produtoGrupoLaboratorial.create({ data: { produtoId: p.id, grupoLaboratorialId: viatris.id, origem: "FABRICANTE_INEQUIVOCO" } });
        produtosViatris.push({ id: p.id, cnp: p.cnp, fabricante: nome });
      }
    }
    // Produto de um fabricante NÃO membro, associado ao grupo por prova manual (sucessão parcial por CNP).
    const fabOutro = await prisma.fabricante.create({ data: { nomeNormalizado: "OUTRO LAB SUCESSAO", estado: "ATIVO" } });
    const pManual = await mkProd("Viatris manual", fabOutro.id);
    await mkPf(pManual.id);
    await prisma.produtoGrupoLaboratorial.create({ data: { produtoId: pManual.id, grupoLaboratorialId: viatris.id, origem: "MANUAL", validadoManualmente: true } });
    // Nome PARECIDO com o grupo mas SEM prova: nunca agrupa.
    const fabParecido = await prisma.fabricante.create({ data: { nomeNormalizado: "VIATRIS PHARMA LDA", estado: "ATIVO" } });
    const pParecido = await mkProd("Parecido p1", fabParecido.id);
    await mkPf(pParecido.id);
    // Independente.
    const fabPfizer = await prisma.fabricante.create({ data: { nomeNormalizado: "PFIZER LABORATORIOS", estado: "ATIVO" } });
    const pPfizer = await mkProd("Pfizer p1", fabPfizer.id);
    await mkPf(pPfizer.id);
    // Segundo grupo, com acento, para ordenação e pesquisa sem acentos.
    const alfa = await prisma.grupoLaboratorial.create({ data: { nome: "Álfa Saúde", nomeNormalizado: "ALFA SAUDE" } });
    const fabAlfa = await prisma.fabricante.create({ data: { nomeNormalizado: "LABORATÓRIOS ÁLFA", estado: "ATIVO" } });
    await prisma.grupoLaboratorialFabricante.create({ data: { grupoLaboratorialId: alfa.id, fabricanteId: fabAlfa.id } });
    const pAlfa = await mkProd("Alfa p1", fabAlfa.id);
    await mkPf(pAlfa.id);
    await prisma.produtoGrupoLaboratorial.create({ data: { produtoId: pAlfa.id, grupoLaboratorialId: alfa.id, origem: "FABRICANTE_INEQUIVOCO" } });

    const totalFabricantes = 10 + 1 + 1 + 1 + 1; // membros + outro + parecido + pfizer + alfa
    const opcoes = await carregarLaboratoriosGarantia(prisma);

    console.log("A · opções agrupadas");
    const itens = L.agruparOpcoesLaboratorio(opcoes);
    const itemViatris = itens.filter((i) => i.opcao.tipo === "grupo" && i.opcao.nome === "Viatris");
    check(itemViatris.length === 1, "A1: o grupo com 10 variantes aparece UMA vez");
    check(itemViatris[0]?.variantes.length === 10 && itemViatris[0]?.rotulo === "Viatris (10 variantes)", `A2: rótulo "Viatris (10 variantes)" (veio ${itemViatris[0]?.rotulo})`);
    const idsMembros = new Set(membros.map((m) => m.id));
    check(!itens.some((i) => i.opcao.tipo === "fabricante" && idsMembros.has(i.opcao.id)), "A3: nenhuma das 10 variantes aparece como opção de topo");
    check(itens.length === 5, `A4: opções de topo = 2 grupos + 3 fabricantes sem prova (veio ${itens.length})`);
    const nomes = itens.map((i) => L.nomeDeLaboratorio(i.opcao));
    check(JSON.stringify(nomes) === JSON.stringify([...nomes].sort((a, b) => a.localeCompare(b, "pt-PT"))), `A5: ordem alfabética (${nomes.join(" | ")})`);
    const grupoOpcao = itemViatris[0]?.opcao;
    check(grupoOpcao?.tipo === "grupo" && grupoOpcao.produtos === 21, `A6: produtos do grupo contados uma vez (20 de variantes + 1 manual = 21; veio ${grupoOpcao?.produtos})`);
    const somaVariantes = (itemViatris[0]?.variantes ?? []).reduce((s, v) => s + v.produtos, 0);
    check(somaVariantes === 20, "A7: soma das variantes = 20 (o produto manual não é de nenhuma variante)");
    check(itens.some((i) => i.opcao.tipo === "fabricante" && i.opcao.nomeNormalizado === "PFIZER LABORATORIOS"), "A8: fabricante sem prova de grupo permanece separado");
    const parecido = itens.find((i) => i.opcao.tipo === "fabricante" && i.opcao.nomeNormalizado === "VIATRIS PHARMA LDA");
    check(!!parecido && !itemViatris[0]?.variantes.some((v) => v.nome === "VIATRIS PHARMA LDA"), "A9: nome parecido (sem prova) NÃO agrupa — fica à parte e fora das variantes");
    check(itens.some((i) => i.opcao.tipo === "fabricante" && i.opcao.nomeNormalizado === "OUTRO LAB SUCESSAO"), "A10: fabricante só ligado por regra/manual a um produto continua separado");
    const rel = auditarOpcoes(opcoes);
    check(rel.fabricantes === totalFabricantes && rel.opcoesAntes === totalFabricantes && rel.opcoesDepois === 5, `A11: auditoria — ${rel.fabricantes} fabricantes, ${rel.opcoesAntes} antes, ${rel.opcoesDepois} depois`);
    check(rel.gruposComMaisVariantes[0]?.grupo === "Viatris" && rel.gruposComMaisVariantes[0]?.variantes === 10, "A12: auditoria — Viatris é o grupo com mais variantes");
    check(rel.fabricantesSemProva.map((f) => f.fabricante).sort().join("|") === ["OUTRO LAB SUCESSAO", "PFIZER LABORATORIOS", "VIATRIS PHARMA LDA"].sort().join("|"), "A13: auditoria — lista os fabricantes sem prova de grupo");
    let recusouReal = false;
    try { validarUrlDescartavel("postgresql://u:p@db.exemplo.pt:5432/spharmmt_t_garantia"); } catch { recusouReal = true; }
    check(recusouReal && validarUrlDescartavel(urlDe(db)) === urlDe(db), "A14: o script de auditoria recusa hosts remotos / bases reais");

    console.log("\nB · pesquisa");
    const achaGrupo = (q: string) => L.agruparOpcoesLaboratorio(opcoes, q).filter((i) => i.opcao.tipo === "grupo" && i.opcao.nome === "Viatris");
    check(achaGrupo("viatris").length === 1, "B1: pelo nome do grupo");
    check(achaGrupo("UPJOHN").length === 1, "B2: pelo alias do grupo");
    const porVariante = achaGrupo("membro 07");
    check(porVariante.length === 1 && porVariante[0].variantesCorrespondentes.length === 1 && porVariante[0].variantesCorrespondentes[0].nome === "VIATRIS MEMBRO 07", "B3: pelo nome de uma variante — devolve o grupo com a variante correspondente");
    check(achaGrupo("mylan ireland").length === 1, "B4: pelo alias de uma variante");
    const alfaPorSemAcentos = L.agruparOpcoesLaboratorio(opcoes, "laboratorios alfa");
    check(alfaPorSemAcentos.length === 1 && alfaPorSemAcentos[0].opcao.tipo === "grupo" && alfaPorSemAcentos[0].opcao.nome === "Álfa Saúde", "B5: sem acentos nem maiúsculas ('laboratorios alfa' encontra LABORATÓRIOS ÁLFA no grupo Álfa Saúde)");
    const resViatris = L.agruparOpcoesLaboratorio(opcoes, "viatris");
    check(resViatris.length === 2 && resViatris.some((i) => i.opcao.tipo === "fabricante" && i.opcao.nomeNormalizado === "VIATRIS PHARMA LDA"), "B6: 'viatris' devolve o grupo E o fabricante parecido, separados");
    check(L.agruparOpcoesLaboratorio(opcoes, "viatrs").length === 0, "B7: sem fuzzy — um erro de escrita não encontra nada");
    check(L.agruparOpcoesLaboratorio(opcoes, "zzz").length === 0, "B8: sem resultados");

    console.log("\nC · resolução de produtos");
    const garantia = async () => "garantia" as string | null;
    const idsGrupo = await resolverProdutoIdsPorLaboratoriosSelecionados(prisma, [`grupo:${viatris.id}`], garantia);
    const esperadosGrupo = [...produtosViatris.map((p) => p.id), pManual.id];
    check(idsGrupo.length === 21 && new Set(idsGrupo).size === 21 && esperadosGrupo.every((id) => idsGrupo.includes(id)), "C1: grupo -> produtos de TODAS as variantes + o manual, sem duplicados");
    check(!idsGrupo.includes(pParecido.id) && !idsGrupo.includes(pPfizer.id), "C2: o fabricante de nome parecido e o independente ficam de fora");
    const idsVar = await resolverProdutoIdsPorLaboratoriosSelecionados(prisma, [`fabricante:${membros[2].id}`], garantia);
    check(idsVar.length === 2, "C3: seleccionar UMA variante dá só os seus 2 produtos");
    const idsUniao = await resolverProdutoIdsPorLaboratoriosSelecionados(prisma, [`grupo:${viatris.id}`, `fabricante:${membros[2].id}`, `fabricante:${fabPfizer.id}`], garantia);
    check(idsUniao.length === 22 && new Set(idsUniao).size === 22, "C4: grupo + variante + outro fabricante = união SEM contar o produto duas vezes (21 + 1)");
    const idsNomeSolto = await resolverProdutoIdsPorLaboratoriosSelecionados(prisma, ["Viatris"], garantia);
    check(idsNomeSolto.length === 21, "C5: valor antigo solto (nome do grupo) continua a funcionar (caminho legado)");

    console.log("\nD · tenants (getReportingFilterOptions)");
    await prisma.fabricante.count();
    estado.tenant = "garantia";
    const optG = await getReportingFilterOptions();
    check(!!optG.laboratorios && optG.laboratorios.some((o) => o.tipo === "grupo" && o.nome === "Viatris"), "D1: garantia: `laboratorios` povoado com o grupo");
    check(optG.fabricantes.includes("Viatris") && !optG.fabricantes.includes("VIATRIS MEMBRO 01") && optG.fabricantes.includes("VIATRIS PHARMA LDA"), "D2: garantia: lista de nomes = grupos + fabricantes sem prova");
    const todosComProdutos = (await prisma.fabricante.findMany({ where: { estado: "ATIVO", produtos: { some: {} } }, select: { nomeNormalizado: true } })).map((f) => f.nomeNormalizado).sort((a, b) => a.localeCompare(b, "pt-PT"));
    for (const t of ["silveira", "sier"]) {
      estado.tenant = t;
      const o = await getReportingFilterOptions();
      check(o.laboratorios === undefined, `D3[${t}]: sem \`laboratorios\``);
      check(JSON.stringify(o.fabricantes) === JSON.stringify(todosComProdutos), `D4[${t}]: fabricantes = um por fabricante real, sem grupos (${o.fabricantes.length})`);
      const semGrupo = await resolverProdutoIdsPorLaboratoriosSelecionados(prisma, [`grupo:${viatris.id}`, "Viatris"], async () => t);
      check(semGrupo.length === 0, `D5[${t}]: o where não consulta grupos (valor grupo: e nome do grupo não devolvem nada)`);
      const porNome = await resolverProdutoIdsPorLaboratoriosSelecionados(prisma, ["PFIZER LABORATORIOS"], async () => t);
      check(porNome.length === 1 && porNome[0] === pPfizer.id, `D6[${t}]: nome de fabricante continua a resolver por fabricanteId`);
    }

    console.log("\nE · listas operacionais: seleccionar grupo devolve linhas");
    const linhas = [
      ...produtosViatris.map((p) => ({ cnp: String(p.cnp), fabricante: p.fabricante })),
      { cnp: String(pManual.cnp), fabricante: "OUTRO LAB SUCESSAO" },
      { cnp: String(pParecido.cnp), fabricante: "VIATRIS PHARMA LDA" },
      { cnp: String(pPfizer.cnp), fabricante: "PFIZER LABORATORIOS" },
    ];
    const cnpsGrupo = new Set(await resolverCnpsPorLaboratoriosSelecionados(prisma, [`grupo:${viatris.id}`], garantia));
    const estadoG = { modoGrupos: true, cnps: cnpsGrupo };
    const grupoSel = [`grupo:${viatris.id}`];
    const passam = linhas.filter((l) => passaFiltroLaboratorioLinha(l, grupoSel, estadoG));
    check(passam.length === 21, `E1: seleccionar o grupo devolve as 21 linhas (variantes + manual); veio ${passam.length}`);
    check(passam.some((l) => l.fabricante === "OUTRO LAB SUCESSAO"), "E2: inclui a linha cujo fabricante legal NÃO é membro (decidida por CNP)");
    check(!passam.some((l) => l.fabricante === "VIATRIS PHARMA LDA" || l.fabricante === "PFIZER LABORATORIOS"), "E3: nome parecido e independente ficam de fora");
    const cnpsVar = new Set(await resolverCnpsPorLaboratoriosSelecionados(prisma, [`fabricante:${membros[0].id}`], garantia));
    check(linhas.filter((l) => passaFiltroLaboratorioLinha(l, [`fabricante:${membros[0].id}`], { modoGrupos: true, cnps: cnpsVar })).length === 2, "E4: seleccionar uma variante devolve só as suas linhas");
    check(linhas.every((l) => passaFiltroLaboratorioLinha(l, [], estadoG)), "E5: sem selecção, todas as linhas passam");
    check(linhas.every((l) => !passaFiltroLaboratorioLinha(l, grupoSel, { modoGrupos: true, cnps: null })), "E6: enquanto o servidor resolve (cnps=null) não mostra linhas erradas");
    const cnpsPfizer = new Set(await resolverCnpsPorLaboratoriosSelecionados(prisma, ["PFIZER LABORATORIOS"], garantia));
    check(linhas.filter((l) => passaFiltroLaboratorioLinha(l, ["PFIZER LABORATORIOS"], { modoGrupos: true, cnps: cnpsPfizer })).length === 1, "E7: valor antigo solto (nome de fabricante) continua a filtrar em garantia");
    const legado = { modoGrupos: false, cnps: null };
    check(linhas.filter((l) => passaFiltroLaboratorioLinha(l, ["VIATRIS MEMBRO 01"], legado)).length === 2, "E8: outros tenants: comparação por nome do fabricante, exactamente como antes");
    check(linhas.filter((l) => passaFiltroLaboratorioLinha(l, ["Viatris"], legado)).length === 0, "E9: outros tenants: o nome de um grupo não filtra nada (não há grupos)");

    // Proposta de Encomenda nova (SQL real).
    const input = {
      farmaciaId: farm.id,
      farmaciaNome: "FAG",
      startDate: new Date(new Date().getFullYear(), new Date().getMonth() - 6, 1),
      endDate: new Date(),
      considerStock: true,
      baseRule: "total" as const,
      targetCoverageDays: 30,
    };
    const prod = async (fabricantes: string[], tenant: string) =>
      (await generateOrderProposal({ ...input, filters: { fabricantes } }, prisma, { resolverTenant: async () => tenant })).rows.map((r) => r.produtoId);
    const pg = await prod([`grupo:${viatris.id}`], "garantia");
    check(pg.length === 21 && esperadosGrupo.every((id) => pg.includes(id)), `E10: proposta (garantia) com grupo devolve as 21 linhas (veio ${pg.length})`);
    const pv = await prod([`fabricante:${membros[0].id}`], "garantia");
    check(pv.length === 2, "E11: proposta (garantia) com variante devolve só as suas linhas");
    const pl = await prod(["Viatris"], "garantia");
    check(pl.length === 21, "E12: proposta (garantia) com o nome solto do grupo (estado antigo) também funciona");
    const pn = await prod(["PFIZER LABORATORIOS"], "garantia");
    check(pn.length === 1 && pn[0] === pPfizer.id, "E13: proposta (garantia) com nome de fabricante continua a funcionar");
    for (const t of ["silveira", "sier"]) {
      const a = await prod(["Viatris"], t);
      const b = await prod(["VIATRIS MEMBRO 01"], t);
      check(a.length === 0 && b.length === 2, `E14[${t}]: proposta por nome de fabricante exactamente como antes (grupo não existe; fabricante filtra)`);
    }
    const semFiltro = await prod([], "garantia");
    check(semFiltro.length === 24, `E15: sem filtro de fabricantes a proposta traz tudo (24; veio ${semFiltro.length})`);

    console.log("\nF · export (adapters)");
    const { buildExcessosReport } = await import("../../lib/reporting/adapters/excessos");
    const { buildTransferenciasReport } = await import("../../lib/reporting/adapters/transferencias");
    const { buildDevolucoesReport } = await import("../../lib/reporting/adapters/devolucoes");
    const { buildEncomendasReport } = await import("../../lib/reporting/adapters/encomendas");
    const labs = optG.laboratorios!;
    const selF = [`grupo:${viatris.id}`, `fabricante:${membros[3].id}`];
    const valorFiltro = (r: { filtersApplied?: Array<{ label: string; value: string }> }) => r.filtersApplied?.find((f) => /Fabricantes|Laboratório/.test(f.label));
    const comuns = { farmacias: ["F"], fornecedores: [] as string[], fabricantes: optG.fabricantes, categorias: [] as string[], prioridades: [] as string[] };
    const rels = {
      excessos: buildExcessosReport({ rows: [], filters: { fabricantesSelecionados: selF }, universe: { ...comuns, laboratorios: labs }, organization: "o" }),
      transferencias: buildTransferenciasReport({ rows: [], filters: { fabricantesSelecionados: selF }, universe: { ...comuns, laboratorios: labs }, organization: "o" }),
      devolucoes: buildDevolucoesReport({ rows: [], filters: { selectedManufacturers: selF }, universe: { pharmacies: ["F"], suppliers: [], manufacturers: optG.fabricantes, categories: [], laboratorios: labs }, organization: "o" }),
      encomendas: buildEncomendasReport({ rows: [], filters: { fabricantesSelecionados: selF }, universe: { ...comuns, laboratorios: labs }, organization: "o" }),
    };
    for (const [nome, r] of Object.entries(rels)) {
      const f = valorFiltro(r as never);
      check(!!f && /^Laborat/.test(f.label) && f.value === "Fabricante: VIATRIS MEMBRO 04; Grupo: Viatris", `F1[${nome}]: rótulos lógicos (${f?.label} = ${f?.value})`);
      check(!!f && !/grupo:|fabricante:/.test(f.value) && !f.value.includes("VIATRIS MEMBRO 01"), `F2[${nome}]: nunca ids internos nem a lista de variantes`);
    }
    const rl = valorFiltro(buildExcessosReport({ rows: [], filters: { fabricantesSelecionados: ["PFIZER LABORATORIOS"] }, universe: comuns, organization: "o" }) as never);
    check(rl?.label === "Fabricantes" && rl.value === "PFIZER LABORATORIOS", "F3: outros tenants: «Fabricantes» com o nome, como antes");
    check(L.filtroLaboratorioParaExport([], labs) === null && L.filtroLaboratorioParaExport(["x"], undefined) === null, "F4: sem selecção / sem laboratorios -> null (comportamento antigo)");
    check(L.nomeLegivelLaboratorio(`grupo:${viatris.id}`, labs) === "Viatris" && L.nomeLegivelLaboratorio("PFIZER", labs) === "PFIZER" && L.nomeLegivelLaboratorio("grupo:removido", labs) === "", "F5: nome legível para títulos (sem ids)");

    console.log("\nG · estrutura");
    for (const [f, k] of [
      ["components/excessos/excessos-client.tsx", "excessos"],
      ["components/transferencias/transferencias-client.tsx", "transferencias"],
      ["components/devolucoes/devolucoes-client.tsx", "devolucoes"],
      ["components/encomendas/encomendas-client.tsx", "encomendas"],
    ] as const) {
      const s = src(f);
      check(s.includes("passaFiltroLaboratorioLinha(") && s.includes("useFiltroLaboratorio(") && s.includes("FiltroFabricante"), `G1[${k}]: usa o filtro por CNP + o selector agrupado`);
      check(!/fabricantesSelecionados\.includes\(row\.fabricante\)/.test(s), `G2[${k}]: já não compara o grupo com o nome legal da linha`);
      check(s.includes("laboratorios") && /universe:[^}]*laboratorios|laboratorios,/.test(s), `G3[${k}]: o export recebe os laboratórios`);
    }
    const oc = src("components/encomendas/order-create-client.tsx");
    check(oc.includes("LaboratorioMultiSelect") && oc.includes("filterOptions.laboratorios"), "G4: nova encomenda usa o selector agrupado em garantia");
    check(src("lib/encomendas/proposal.ts").includes("resolverFiltroFabricantesProposta") && !src("lib/encomendas/proposal.ts").includes("fabFilter"), "G5: a proposta resolve grupos no servidor");
    for (const f of ["lib/catalogo-data.ts", "lib/reporting-filter-options.ts", "lib/reporting/resolver-laboratorio-selecionado.ts"]) {
      const s = src(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      check(s.includes("gruposLaboratoriaisAtivos(") && !/===\s*TENANT_GRUPOS_LABORATORIAIS/.test(s), `G6: ${f} usa o gate central dos grupos`);
    }

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
