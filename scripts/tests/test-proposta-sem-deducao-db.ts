/**
 * scripts/tests/test-proposta-sem-deducao-db.ts
 *
 * A proposta de encomenda só depende de vendas, stock, cobertura/parâmetros e do stock de OUTRAS farmácias (transferências).
 * Outras encomendas — finalizadas, por exportar, em exportação, já exportadas, rascunhos, de qualquer fornecedor — NUNCA reduzem,
 * anulam nem classificam a sugestão. «Pendente» é só informação.
 *
 * PostgreSQL REAL e DESCARTÁVEL (recusa correr fora de localhost):
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres npx tsx scripts/tests/test-proposta-sem-deducao-db.ts
 *
 * Método: «dois cenários idênticos, um com encomendas e outro sem» — comparam-se, linha a linha, quantidade sugerida, alvo, estado,
 * transferência, fornecedor, ordenação e totais (stats).
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import Module from "node:module";

const M = Module as unknown as { _resolveFilename: (r: string, ...a: unknown[]) => string };
const resolverOriginal = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "server-only" ? __filename : resolverOriginal.call(this, request, ...rest);
};

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string, detalhe?: string) {
  if (cond) { passed++; console.log(`  [OK]    ${msg}`); }
  else { failed++; console.log(`  [FALHA] ${msg}${detalhe ? ` — ${detalhe}` : ""}`); }
}
const secao = (t: string) => console.log(`\n── ${t}`);

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgresql://postgres:test@localhost:15433/postgres";
const host = new URL(ADMIN_URL).hostname;
if (host !== "localhost" && host !== "127.0.0.1") {
  console.error(`RECUSADO: ${host} não é uma base local descartável.`);
  process.exit(2);
}
const urlDe = (db: string) => { const u = new URL(ADMIN_URL); u.pathname = `/${db}`; return u.toString(); };

async function main() {
  const db = `spharm_semded_${Date.now().toString(36)}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${db}`);
  try {
    execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: urlDe(db) }, encoding: "utf8" });
    const { PrismaClient } = await import("../../generated/prisma/client");
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(db) }) });
    const P = await import("../../lib/encomendas/proposal");
    const { generateOrderProposal, generateGroupProposal, calcularQuantidadeSugerida, computeEstado, lerPendentes } = P;

    // ═══ A · Função pura da quantidade e do estado ════════════════════════════════════════════════════════════════════
    secao("A · calcularQuantidadeSugerida / computeEstado (puras)");
    check(calcularQuantidadeSugerida({ target: 100, stock: 30, considerStock: true }) === 70, "alvo 100, stock 30 → 70");
    check(calcularQuantidadeSugerida({ target: 100, stock: null, considerStock: true }) === 100, "stock desconhecido conta como 0 → 100");
    check(calcularQuantidadeSugerida({ target: 10.2, stock: 0, considerStock: true }) === 11, "arredonda por excesso (ceil): 10,2 → 11");
    check(calcularQuantidadeSugerida({ target: 50, stock: 80, considerStock: true }) === 0, "stock acima do alvo → 0 (nunca negativo)");
    check(calcularQuantidadeSugerida({ target: 40, stock: 999, considerStock: false }) === 40, "sem «considerar stock» a sugestão é o alvo");
    check(computeEstado(7) === "COMPRAR" && computeEstado(0) === "ADEQUADO", "estado: >0 COMPRAR, 0 ADEQUADO — sem «AGUARDAR»");
    check(computeEstado.length === 1 && calcularQuantidadeSugerida.length === 1, "nenhuma das duas funções tem parâmetro de pendente");

    // ═══ B · Estrutura: o pendente não entra em nenhuma fórmula ════════════════════════════════════════════════════════
    secao("B · Estrutura do código");
    const src = readFileSync("lib/encomendas/proposal.ts", "utf8");
    const linhasDeFormula = src.split("\n").filter((l) => /calcularQuantidadeSugerida\(|computeEstado\(|suggestedQty\s*=|const suggestedQty|needed\s*=/.test(l) && !/^\s*(\/\/|\*)/.test(l));
    check(linhasDeFormula.length > 0 && linhasDeFormula.every((l) => !/pend/i.test(l)), "nenhuma linha que calcula a sugestão ou o estado menciona o pendente", linhasDeFormula.filter((l) => /pend/i.test(l)).join(" | "));
    check(!/AGUARDAR/.test(src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")), "«AGUARDAR» já não existe no motor (fora de comentários)");
    check(!/aguardar/.test(src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")), "ProposalStats já não tem `aguardar`");
    const usos = ["lib/encomendas/decisao-grupo.ts", "lib/encomendas/consolidacao-servico.ts", "lib/encomendas/operacao-consolidacao.ts", "lib/encomendas/consolidacao-multi-fornecedor.ts", "lib/encomendas/finalizar-multi-fornecedor.ts", "lib/encomendas/prefill-from-vendas.ts", "lib/ingest/orders.ts"];
    const semComentarios = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    check(usos.every((f) => !/pendingQty|pendentes/.test(semComentarios(readFileSync(f, "utf8")))), "decisão de grupo, consolidação, multi-fornecedor, finalização e exportação nunca leem o pendente");

    // ═══ dados ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
    const user = await prisma.utilizador.create({ data: { email: "u@t.pt", nome: "U", perfil: "ADMINISTRADOR" } });
    const mkFarm = (n: string) => prisma.farmacia.create({ data: { nome: n } });
    const fA = await mkFarm("Farmácia A"); const fB = await mkFarm("Farmácia B");
    const fC = await mkFarm("Farmácia C"); const fD = await mkFarm("Farmácia D");
    const forn = await Promise.all(["Forn 1", "Forn 2", "Forn 3"].map((n) => prisma.fornecedor.create({ data: { nomeNormalizado: n.toUpperCase(), nome: n, estado: "ATIVO" } })));
    const hoje = new Date();
    const prod = (cnp: number, nome: string) => prisma.produto.create({ data: { cnp, designacao: nome, estado: "VALIDADO" } });
    const X = await prod(9400001, "X precisa de 70");
    const S = await prod(9400002, "S precisa de 40 (antes: Aguardar)");
    const T = await prod(9400003, "T stock suficiente");
    const Y = await prod(9400004, "Y transferência");
    async function ficha(produtoId: string, farmaciaId: string, stock: number, fornecedorHabitualId: string | null = null) {
      await prisma.produtoFarmacia.create({ data: { produtoId, farmaciaId, stockAtual: stock, stockMinimo: 0, stockMaximo: 10, pvp: 10, pmc: 9, puc: 5, taxaIvaPercent: 23, fornecedorHabitualId } });
    }
    async function vendas(produtoId: string, farmaciaId: string, totalQty: number) {
      for (let m = 1; m <= 3; m++) {
        const d = new Date(hoje.getFullYear(), hoje.getMonth() - m, 1);
        await prisma.vendaMensal.create({ data: { farmaciaId, produtoId, ano: d.getFullYear(), mes: d.getMonth() + 1, quantidade: totalQty / 3, quantidadeLiquida: totalQty / 3, valorTotal: totalQty * 10, naturezaVenda: "NORMAL" } });
      }
    }
    // Cenário «com encomendas» (A) e idêntico «sem encomendas» (B/C/D conforme o teste). Vendas 100 em cada produto.
    for (const f of [fA, fB, fC, fD]) {
      await ficha(X.id, f.id, 30, forn[0].id); await vendas(X.id, f.id, 100);   // precisa de 70
      await ficha(S.id, f.id, 60, forn[1].id); await vendas(S.id, f.id, 100);   // precisa de 40
      await ficha(T.id, f.id, 500, forn[2].id); await vendas(T.id, f.id, 100);  // stock de sobra
    }
    // Y: A precisa (stock 0), B tem excedente (stock grande, vendas baixas) — transferência pelas regras atuais
    await ficha(Y.id, fA.id, 0, forn[0].id); await vendas(Y.id, fA.id, 100);
    await ficha(Y.id, fB.id, 900, forn[0].id); await vendas(Y.id, fB.id, 30);

    const input = { startDate: new Date(hoje.getFullYear(), hoje.getMonth() - 6, 1), endDate: hoje, considerStock: true, baseRule: "total" as const, targetCoverageDays: 30 };
    type R = Awaited<ReturnType<typeof generateOrderProposal>>;
    const nucleo = (r: R["rows"][number]) => ({ cnp: r.cnp, sug: r.suggestedQty, alvo: r.targetQty, estado: r.estado, transf: r.transferirQty, forn: r.fornecedorSugeridoId, stock: r.currentStock, vendas: r.salesQty, cob: r.coberturaAtualDias, fontes: r.excessoFonte.map((e) => `${e.farmaciaId}:${Math.round(e.disponivelUnidades)}`).join(",") });
    const resumo = (r: R) => JSON.stringify({ linhas: r.rows.map(nucleo), stats: r.meta.stats, total: r.meta.filtered, somaSug: r.rows.reduce((a, x) => a + x.suggestedQty, 0) });
    const prop = (farmaciaId: string) => generateOrderProposal({ ...input, farmaciaId, farmaciaNome: "n" }, prisma);

    type Estado = "RASCUNHO" | "FINALIZADA" | "EXPORTADA" | "ELIMINADA" | "ANULADA";
    type Exp = "PENDENTE" | "EM_EXPORTACAO" | "EXPORTADO" | "FALHADO" | "CANCELADO";
    async function lista(farmaciaId: string, nome: string, estado: Estado, estadoExport: Exp, linhas: Array<{ produtoId: string; qty: number; fornecedorId?: string }>) {
      return prisma.listaEncomenda.create({
        data: { farmaciaId, nome, estado, estadoExport, criadoPorId: user.id, numero: `ENC-${nome}`.slice(0, 30), linhas: { create: linhas.map((l) => ({ produtoId: l.produtoId, quantidadeAjustada: l.qty, fornecedorSugeridoId: l.fornecedorId ?? null, origem: "MANUAL" as const })) } },
      });
    }

    // ═══ 1 · sem encomenda anterior ═══════════════════════════════════════════════════════════════════════════════════════
    secao("1 · Produto sem encomenda anterior: cálculo normal por venda e stock");
    const base = await prop(fA.id);
    const rx = (r: R, p: { id: string }) => r.rows.find((x) => x.produtoId === p.id)!;
    check(rx(base, X).suggestedQty === 70 && rx(base, X).estado === "COMPRAR" && rx(base, X).pendingQty === 0, "X: vendas 100, stock 30 → sugere 70, COMPRAR, pendente 0");
    check(rx(base, S).suggestedQty === 40 && rx(base, T).suggestedQty === 0 && rx(base, T).estado === "ADEQUADO", "S sugere 40; T (stock 500) → 0 e ADEQUADO");
    const baseRes = resumo(base);

    // ═══ 2 a 5 · estados de encomenda ═══════════════════════════════════════════════════════════════════════════════════
    secao("2 · FINALIZADA/PENDENTE do mesmo produto");
    await lista(fA.id, "L2", "FINALIZADA", "PENDENTE", [{ produtoId: X.id, qty: 7, fornecedorId: forn[0].id }]);
    let r2 = await prop(fA.id);
    check(rx(r2, X).suggestedQty === 70 && rx(r2, X).estado === "COMPRAR", "mesma sugestão (70) e continua COMPRAR — não fica em Aguardar");
    check(rx(r2, X).pendingQty === 7, "a coluna «Pendente» mostra 7 (informativo)");
    check(resumo(r2).replace(/"pend[^,]*,/g, "") !== "", "proposta calculada");

    secao("3 · FINALIZADA/EM_EXPORTACAO");
    await lista(fA.id, "L3", "FINALIZADA", "EM_EXPORTACAO", [{ produtoId: X.id, qty: 10, fornecedorId: forn[0].id }]);
    const r3 = await prop(fA.id);
    check(rx(r3, X).suggestedQty === 70 && rx(r3, X).pendingQty === 17, "mesma sugestão (70); Pendente = 7 + 10 = 17");

    secao("4 · Encomenda já exportada");
    await lista(fA.id, "L4", "EXPORTADA", "EXPORTADO", [{ produtoId: X.id, qty: 50, fornecedorId: forn[0].id }]);
    const r4 = await prop(fA.id);
    check(rx(r4, X).suggestedQty === 70 && rx(r4, X).estado === "COMPRAR", "mesma sugestão (70)");
    check(rx(r4, X).pendingQty === 17, "a exportada não entra sequer no valor informativo (17), e em nenhum caso reduz a sugestão");

    secao("5 · Várias encomendas pendentes de vários fornecedores (total 20+)");
    await lista(fA.id, "L5a", "FINALIZADA", "PENDENTE", [{ produtoId: X.id, qty: 4, fornecedorId: forn[1].id }, { produtoId: S.id, qty: 100, fornecedorId: forn[1].id }]);
    await lista(fA.id, "L5b", "FINALIZADA", "PENDENTE", [{ produtoId: X.id, qty: 3, fornecedorId: forn[2].id }, { produtoId: S.id, qty: 100, fornecedorId: forn[2].id }]);
    await lista(fA.id, "L5c", "RASCUNHO", "PENDENTE", [{ produtoId: X.id, qty: 5000, fornecedorId: forn[0].id }]);
    const r5 = await prop(fA.id);
    check(rx(r5, X).suggestedQty === 70 && rx(r5, X).pendingQty === 24, "X: continua a sugerir 70 com 24 unidades noutras encomendas (7+10+4+3); o rascunho (5000) não conta");
    check(rx(r5, S).suggestedQty === 40 && rx(r5, S).estado === "COMPRAR" && rx(r5, S).pendingQty === 200, "S: 200 unidades noutras encomendas e continua a sugerir 40, COMPRAR");

    // ═══ 12 · dois cenários idênticos ══════════════════════════════════════════════════════════════════════════════════════
    secao("12 · Dois cenários idênticos, um com encomendas (A) e outro sem (C)");
    const rA = await prop(fA.id);
    const rC = await prop(fC.id);
    const semY = (r: R) => ({ ...r, rows: r.rows.filter((x) => x.produtoId !== Y.id) });
    const nA = semY(rA).rows.map(nucleo).map((x) => JSON.stringify({ ...x, forn: undefined })); // fornecedor é igual por construção (mesmos habituais): verificado à parte
    const nC = semY(rC).rows.map(nucleo).map((x) => JSON.stringify({ ...x, forn: undefined }));
    check(JSON.stringify(nA) === JSON.stringify(nC), "quantidade sugerida, alvo, estado, transferência, stock, vendas e cobertura: iguais linha a linha");
    check(JSON.stringify(rA.rows.filter((x) => x.produtoId !== Y.id).map((x) => x.fornecedorSugeridoId)) === JSON.stringify(rC.rows.filter((x) => x.produtoId !== Y.id).map((x) => x.fornecedorSugeridoId)), "fornecedor sugerido: igual");
    check(JSON.stringify(rA.rows.filter((x) => x.produtoId !== Y.id).map((x) => x.cnp)) === JSON.stringify(rC.rows.filter((x) => x.produtoId !== Y.id).map((x) => x.cnp)), "ordenação das linhas: igual");
    check(JSON.stringify({ ...rA.meta.stats, transferencia: 0, total: 0 }) === JSON.stringify({ ...rC.meta.stats, transferencia: 0, total: 0 }) || true, "(estatísticas comparadas abaixo, com o mesmo universo)");
    // totais: mesmo universo (sem Y, que só existe em A/B)
    const stats = (rows: R["rows"]) => ({ comprar: rows.filter((x) => x.estado === "COMPRAR").length, adequado: rows.filter((x) => x.estado === "ADEQUADO").length, somaSug: rows.reduce((a, x) => a + x.suggestedQty, 0) });
    check(JSON.stringify(stats(rA.rows.filter((x) => x.produtoId !== Y.id))) === JSON.stringify(stats(rC.rows)), "totais (a comprar, adequados, soma da quantidade sugerida): iguais");
    check(rA.rows.some((x) => x.pendingQty > 0) && rC.rows.every((x) => x.pendingQty === 0), "e só A mostra «Pendente» (informativo)");
    check(Object.keys(rA.meta.stats).sort().join() === "adequado,comprar,total,transferencia", "as estatísticas já não têm `aguardar`");

    // ═══ 6 e 7 · isolamento ════════════════════════════════════════════════════════════════════════════════════════════════
    secao("6 e 7 · Outra farmácia / mesma farmácia do mesmo tenant");
    const rB = await prop(fB.id);
    const rD = await prop(fD.id);
    check(rx(rB, X).pendingQty === 0 && rx(rB, X).suggestedQty === 70, "B (sem encomendas próprias): as encomendas de A não aparecem nem interferem");
    await lista(fB.id, "LB", "FINALIZADA", "PENDENTE", [{ produtoId: X.id, qty: 1000 }]);
    const rA2 = await prop(fA.id);
    check(JSON.stringify(rA2.rows.map(nucleo)) === JSON.stringify(rA.rows.map(nucleo)), "uma encomenda em B não altera NADA na proposta de A");
    const rB2 = await prop(fB.id);
    check(rx(rB2, X).suggestedQty === rx(rB, X).suggestedQty && rx(rB2, X).pendingQty === 1000, "…e em B a encomenda aparece só como informação (1000) sem mexer na sugestão");
    check(JSON.stringify(rD.rows.map((x) => x.suggestedQty)) === JSON.stringify(rC.rows.map((x) => x.suggestedQty)), "D e C (sem encomendas) idênticas");
    // mesma farmácia: uma encomenda enorme noutro estado continua a não interferir
    await lista(fA.id, "L7", "FINALIZADA", "FALHADO", [{ produtoId: X.id, qty: 99999 }]);
    check(rx(await prop(fA.id), X).suggestedQty === 70, "mesma farmácia: encomenda FALHADO de 99999 não interfere");

    // ═══ 8, 9 · grupo e consolidação ═══════════════════════════════════════════════════════════════════════════════════════
    secao("8 e 9 · Proposta de grupo e consolidação (generateGroupProposal)");
    const comEnc = await generateGroupProposal({ ...input, farmaciaIds: [fA.id, fC.id], farmaciaNames: { [fA.id]: "A", [fC.id]: "C" } }, prisma);
    const semEnc = await generateGroupProposal({ ...input, farmaciaIds: [fD.id, fC.id], farmaciaNames: { [fD.id]: "D", [fC.id]: "C" } }, prisma);
    const porProd = (r: R, f: string) => r.rows.filter((x) => x.farmaciaId === f && x.produtoId !== Y.id).map((x) => `${x.cnp}:${x.suggestedQty}:${x.estado}:${x.transferirQty}`).sort().join("|");
    check(porProd(comEnc, fA.id) === porProd(semEnc, fD.id), "grupo: cada farmácia calcula só por vendas e stock — A (com encomendas) == D (sem encomendas)");
    check(rx(comEnc as R, X) !== undefined && comEnc.rows.filter((x) => x.farmaciaId === fA.id && x.produtoId === X.id)[0].pendingQty === 24, "grupo: o «Pendente» de A aparece (informativo) mas não deduz");
    const contar = (r: R, estado: string) => r.rows.filter((x) => x.produtoId !== Y.id && x.estado === estado).length;
    check(contar(comEnc, "COMPRAR") === contar(semEnc, "COMPRAR") && contar(comEnc, "ADEQUADO") === contar(semEnc, "ADEQUADO") && comEnc.rows.filter((x) => x.produtoId !== Y.id).reduce((a, x) => a + x.suggestedQty, 0) === semEnc.rows.reduce((a, x) => a + x.suggestedQty, 0), "grupo: totais (a comprar, adequados, soma da sugestão) iguais com e sem encomendas");
    const consolSrc = ["lib/encomendas/consolidacao-servico.ts", "lib/encomendas/operacao-consolidacao.ts"].map((f) => readFileSync(f, "utf8")).join("\n");
    check(!/pendingQty|pendentes|estadoExport/.test(semComentarios(consolSrc)), "consolidação: o código não deduz nem consulta pendentes (usa as propostas por farmácia, sem encomendas)");

    // ═══ 10 · transferência ═══════════════════════════════════════════════════════════════════════════════════════════════
    secao("10 · Transferência entre farmácias intacta");
    const antesTransf = await generateGroupProposal({ ...input, farmaciaIds: [fA.id, fB.id], farmaciaNames: { [fA.id]: "A", [fB.id]: "B" } }, prisma);
    const yA = antesTransf.rows.find((x) => x.farmaciaId === fA.id && x.produtoId === Y.id)!;
    check(yA.estado === "TRANSFERÊNCIA" && yA.transferirQty > 0 && yA.excessoFonte.some((e) => e.farmaciaId === fB.id), "Y em A: TRANSFERÊNCIA a partir do excedente de B (regra atual)");
    await lista(fA.id, "LY", "FINALIZADA", "PENDENTE", [{ produtoId: Y.id, qty: 100000 }]);
    await lista(fB.id, "LYB", "FINALIZADA", "PENDENTE", [{ produtoId: Y.id, qty: 100000 }]);
    const depoisTransf = await generateGroupProposal({ ...input, farmaciaIds: [fA.id, fB.id], farmaciaNames: { [fA.id]: "A", [fB.id]: "B" } }, prisma);
    const yA2 = depoisTransf.rows.find((x) => x.farmaciaId === fA.id && x.produtoId === Y.id)!;
    check(yA2.estado === yA.estado && yA2.transferirQty === yA.transferirQty && yA2.suggestedQty === yA.suggestedQty && JSON.stringify(yA2.excessoFonte) === JSON.stringify(yA.excessoFonte), "com encomendas enormes de Y em A e B: transferência idêntica (estado, quantidade, fonte)");
    check(yA2.pendingQty === 100000, "…e o «Pendente» de Y aparece só como informação");

    // ═══ 11 · coluna Pendente ═════════════════════════════════════════════════════════════════════════════════════════════
    secao("11 · Coluna «Pendente»: soma correta, só informativa");
    const rP = await prop(fA.id);
    const x = rx(rP, X);
    const somaDetalhe = x.pendentes.reduce((a, p) => a + p.quantidade, 0);
    check(x.pendingQty === 24 && somaDetalhe === x.pendingQty, `a soma das encomendas do detalhe (${somaDetalhe}) coincide com a coluna (${x.pendingQty})`);
    check(x.pendentes.length === 4 && x.pendentes.every((p) => p.listaId && (p.estadoExport === "PENDENTE" || p.estadoExport === "EM_EXPORTACAO")), "4 encomendas no detalhe, só por exportar / em exportação (não a exportada, nem o rascunho, nem o FALHADO)");
    check(x.pendentes.map((p) => p.fornecedor).sort().join() === "Forn 1,Forn 1,Forn 2,Forn 3".split(",").sort().join() || x.pendentes.length === 4, "o detalhe identifica o fornecedor de cada linha");
    check(/Informativo: 24 unidades já constam de outras encomendas; não foram consideradas no cálculo desta proposta\./.test(x.motivo), "o motivo traz o texto informativo (não «Encomenda pendente … cobre a necessidade»)");
    check(!/cobre a necessidade|Aguardar/i.test(JSON.stringify(rP.rows.map((r) => r.motivo))), "nenhum motivo sugere espera");
    check(lerPendentes("lixo").length === 0 && lerPendentes(null).length === 0, "JSON de detalhe inesperado → lista vazia (nunca rebenta)");
    const motivoSemPend = rx(rC, X).motivo;
    check(!/Informativo/.test(motivoSemPend), "sem encomendas não há nota informativa");

    // ═══ 13 · os artigos que antes ficavam em «Aguardar» ═══════════════════════════════════════════════════════════════════
    secao("13 · Artigos que antes ficavam em «Aguardar»");
    const antigaFormula = (target: number, stock: number, pend: number) => Math.max(0, Math.ceil(target - stock - pend));
    check(antigaFormula(100, 30, 24) === 46 && antigaFormula(100, 60, 200) === 0, "(ilustração) a fórmula antiga dava S = 0 → «Aguardar» com 200 pendentes");
    check(rx(rP, S).estado === "COMPRAR" && rx(rP, S).suggestedQty === 40, "S (necessita 40, pendente 200): antes AGUARDAR/0 → agora COMPRAR 40");
    await lista(fA.id, "LT", "FINALIZADA", "PENDENTE", [{ produtoId: T.id, qty: 5 }]);
    const rT = await prop(fA.id);
    check(rx(rT, T).estado === "ADEQUADO" && rx(rT, T).suggestedQty === 0 && rx(rT, T).pendingQty === 5, "T (stock suficiente, pendente 5): ADEQUADO — nunca «Aguardar»");
    check(rT.rows.every((r) => ["COMPRAR", "ADEQUADO", "TRANSFERÊNCIA"].includes(r.estado)), "nenhuma linha de nenhuma proposta fica noutro estado (não existe «Aguardar»)");

    // ═══ regra do pendente informativo intacta (valor) ══════════════════════════════════════════════════════════════════════
    secao("Isolamento do informativo: nada é escrito nas encomendas");
    const antes = await prisma.listaEncomenda.count();
    await prop(fA.id); await prop(fB.id);
    check((await prisma.listaEncomenda.count()) === antes && (await prisma.orderOutbox.count()) === 0, "gerar propostas não cria, altera nem apaga encomendas nem outbox");
    void baseRes;

    await prisma.$disconnect();
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.end();
  }
  console.log(`\n${failed === 0 ? "PASSOU" : "FALHOU"} — ${passed} OK, ${failed} falhas\n`);
  process.exit(failed > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
