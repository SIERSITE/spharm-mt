/**
 * scripts/tests/test-garantia-manutencoes-vendas-db.ts
 *
 * PostgreSQL REAL e DESCARTÁVEL (recusa hosts não locais), migrations reais:
 *
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:55490/postgres \
 *     npx tsx scripts/tests/test-garantia-manutencoes-vendas-db.ts
 *
 * Prova a operação única de reposição (scripts/ops/garantia-reposicao-manutencoes-vendas.ts):
 * funções (operacao/executar) sobre bases descartáveis e o CLI real, com o
 * tenant `garantia` resolvido por um control plane descartável.
 */
import { execSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import Module from "node:module";
import { Client } from "pg";
import bcrypt from "bcryptjs";
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

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgresql://postgres:test@localhost:55490/postgres";
{
  const h = new URL(ADMIN_URL).hostname;
  if (h !== "localhost" && h !== "127.0.0.1") { console.error(`RECUSADO: ${h} não é local.`); process.exit(2); }
}
const urlDe = (db: string) => { const u = new URL(ADMIN_URL); u.pathname = `/${db}`; return u.toString(); };
const raiz = path.resolve(__dirname, "../..");
const DADOS = path.join(raiz, "scripts/ops/garantia-manutencoes-vendas/dados.json");
const NOMES = ["Farmácia Garantia", "Farmácia Principal", "Farmácia Castelo", "Farmácia Pereiro", "Farmácia Nogueira"];

async function main() {
  const sufixo = Date.now().toString(36);
  const modelo = `spharm_test_gm_tpl_${sufixo}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const criadas: string[] = [modelo];
  await admin.query(`CREATE DATABASE ${modelo}`);
  execSync("npx prisma migrate deploy", { cwd: raiz, env: { ...process.env, DATABASE_URL: urlDe(modelo) }, encoding: "utf8", stdio: "pipe" });

  const { PrismaClient } = await import("../../generated/prisma/client");
  const O = await import("../ops/garantia-manutencoes-vendas/operacao");
  const E = await import("../ops/garantia-manutencoes-vendas/executar");
  const bruto = readFileSync(DADOS);
  const ficheiroHash = createHash("sha256").update(bruto).digest("hex");
  const doc = JSON.parse(bruto.toString("utf8")) as import("../ops/garantia-manutencoes-vendas/operacao").DocumentoJson;
  const cnps = [...new Set(doc.records.map((r) => Number(r.cnp)))];

  type Cliente = InstanceType<typeof PrismaClient>;
  const abertos: Cliente[] = [];
  /** Base nova (cópia do modelo migrado) com utilizador, farmácias, produtos e uma manutenção preexistente. */
  async function novaBase(opts: { semProduto?: number; semFarmacia?: string; extraFarmacia?: string } = {}) {
    const nome = `spharm_test_gm_${criadas.length}_${sufixo}`;
    criadas.push(nome);
    await admin.query(`CREATE DATABASE ${nome} TEMPLATE ${modelo}`);
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(nome) }) });
    abertos.push(prisma);
    const user = await prisma.utilizador.create({ data: { email: "admin@garantia.test", nome: "Admin", perfil: "ADMINISTRADOR" } });
    const farmacias = [];
    for (const n of NOMES) if (n !== opts.semFarmacia) farmacias.push(await prisma.farmacia.create({ data: { nome: n } }));
    if (opts.extraFarmacia) await prisma.farmacia.create({ data: { nome: opts.extraFarmacia } });
    const produtos = new Map<number, string>();
    for (const cnp of cnps) {
      if (cnp === opts.semProduto) continue;
      produtos.set(cnp, (await prisma.produto.create({ data: { cnp, designacao: `Produto ${cnp} (catálogo actual)`, estado: "VALIDADO" } })).id);
    }
    // manutenção PREEXISTENTE, sem relação com os 36 (CNP e período diferentes)
    const outro = [...produtos.entries()][0];
    const pre = await prisma.vendaManutencao.create({
      data: {
        produtoId: outro[1], cnp: outro[0], quantidadeTotal: 7, numMeses: 1, mesInicialAno: 2030, mesInicialMes: 1, criadoPorId: user.id,
        celulas: { create: [{ farmaciaId: farmacias[0].id, ano: 2030, mes: 1, quantidade: 7 }] },
        farmaciasPvp: { create: [{ farmaciaId: farmacias[0].id, pvpReferencia: 9.99 }] },
      },
    });
    return { prisma, nome, user, farmacias, produtos, preId: pre.id };
  }
  const opcoes = (extra: Partial<import("../ops/garantia-manutencoes-vendas/executar").OpcoesExecucao> = {}) => ({
    doc, ficheiroHash, aplicar: false, utilizadorEmail: "admin@garantia.test", baseDadosHint: "localhost:0/teste", revisao: "teste", tenant: "garantia", ...extra,
  });
  const linhasMensais = doc.records.reduce((s, r) => s + r.months.length, 0);

  try {
    // ═══ Validação do ficheiro (sem BD) ═══════════════════════════════
    console.log("\n=== V. Validação dos dados antes de escrever ===");
    {
      check(O.validarDocumento(doc).length === 0, "o ficheiro real passa em todas as validações (36 registos, somas, meses, formatos)");
      const clone = () => JSON.parse(JSON.stringify(doc));
      const c1 = clone(); c1.records.pop();
      check(O.validarDocumento(c1).some((e: string) => /exactamente 36/.test(e)), "35 registos ⇒ recusado");
      const c2 = clone(); c2.records[0].months[0][1] += 1;
      check(O.validarDocumento(c2).some((e: string) => /soma mensal/.test(e)), "soma de coluna ≠ totals ⇒ recusado");
      const c3 = clone(); c3.records[0].complete = false;
      check(O.validarDocumento(c3).some((e: string) => /complete/.test(e)), "complete=false ⇒ recusado");
      const c4 = clone(); c4.records[0].missing_months = [];
      check(O.validarDocumento(c4).some((e: string) => /missing_months/.test(e)), "campos antigos missing_* ⇒ recusado");
      const c5 = clone(); c5.records[0].months[1][0] = c5.records[0].months[0][0];
      check(O.validarDocumento(c5).some((e: string) => /duplicado/.test(e)), "mês duplicado ⇒ recusado");
      const c6 = clone(); c6.records[0].months[0][2] = 1.5;
      check(O.validarDocumento(c6).some((e: string) => /inteiros/.test(e)), "valor não inteiro ⇒ recusado");
      const c7 = clone(); c7.records[0].months[0][2] = -1;
      check(O.validarDocumento(c7).some((e: string) => /inteiros/.test(e)), "valor negativo ⇒ recusado");
      const c8 = clone(); c8.records[0].cnp = "12AB";
      check(O.validarDocumento(c8).some((e: string) => /CNP/.test(e)), "CNP inválido ⇒ recusado");
      const c9 = clone(); c9.records[0].purchase_date = "2026-02-30";
      check(O.validarDocumento(c9).some((e: string) => /purchase_date/.test(e)), "data inválida ⇒ recusado");
      const c10 = clone(); c10.records[0].number_months = 5;
      check(O.validarDocumento(c10).some((e: string) => /linhas mensais/.test(e)), "number_months ≠ nº de linhas ⇒ recusado");
      const b = await novaBase();
      const antes = await O.contar(b.prisma);
      const rel = await E.executar(b.prisma, opcoes({ doc: c2, aplicar: true }));
      const depois = await O.contar(b.prisma);
      check(rel.erros.length > 0 && JSON.stringify(antes) === JSON.stringify(depois), "dados inválidos + --apply: terminou sem qualquer escrita");
    }

    // ═══ Dry-run ═════════════════════════════════════════════════════
    console.log("\n=== D. Dry-run ===");
    const dry = await novaBase();
    {
      const logAntes = await dry.prisma.auditLog.count();
      const antes = await O.contar(dry.prisma);
      const rel = await E.executar(dry.prisma, opcoes());
      const depois = await O.contar(dry.prisma);
      check(JSON.stringify(antes) === JSON.stringify(depois) && (await dry.prisma.auditLog.count()) === logAntes, "15. o dry-run faz ZERO escritas (contagens e auditoria iguais)");
      check(rel.tipo === "dry-run" && rel.totais.manutencoesRecebidas === 36 && rel.totais.novas === 36 && rel.totais.jaExistentes === 0 && rel.totais.conflitos === 0 && rel.bloqueios.length === 0,
        "dry-run: 36 novas, 0 existentes, 0 conflitos, 0 bloqueios", JSON.stringify(rel.totais));
      check(rel.totais.linhasMensais === linhasMensais && rel.totais.cnpEncontrados === cnps.length && rel.totais.cnpNaoEncontrados.length === 0, `dry-run: ${linhasMensais} linhas mensais; ${cnps.length} CNP distintos, todos encontrados`);
      check(NOMES.every((_, k) => rel.farmacias[O.COLUNAS[k]]?.id === dry.farmacias[k].id), "dry-run: as 5 farmácias resolvidas pelos dados reais do tenant (ids correctos, por coluna)");
      check(rel.itens.every((i) => i.produtoId === dry.produtos.get(i.cnp)), "dry-run: cada CNP resolvido para o Produto.id certo");
      check(rel.totais.manutencoesComTotaisDiferentesDaQuantidade >= 5, `dry-run: assinala as ${rel.totais.manutencoesComTotaisDiferentesDaQuantidade} manutenções cujos totais diferem da quantidade (informação real, preservada)`);
      writeFileSync(path.join(tmpdir(), "dry-run-garantia-manutencoes.json"), JSON.stringify(rel, null, 2));
    }

    // ═══ Apply ═══════════════════════════════════════════════════════
    console.log("\n=== A. Apply ===");
    const ap = await novaBase();
    let relApply: import("../ops/garantia-manutencoes-vendas/executar").Relatorio;
    const preSnap = async (p: Cliente, id: string) => JSON.stringify(await p.vendaManutencao.findUnique({ where: { id }, include: { celulas: { orderBy: { id: "asc" } }, farmaciasPvp: true } }));
    const preAntes = await preSnap(ap.prisma, ap.preId);
    {
      const semUtil = await E.executar(ap.prisma, opcoes({ aplicar: true, utilizadorEmail: undefined }));
      check(semUtil.erros.length === 1 && /utilizador-email/.test(semUtil.erros[0]) && (await ap.prisma.vendaManutencao.count()) === 1, "apply sem utilizador: recusado, nada escrito");
      const utilErrado = await E.executar(ap.prisma, opcoes({ aplicar: true, utilizadorEmail: "naoexiste@x.pt" }));
      check(utilErrado.erros.length === 1 && (await ap.prisma.vendaManutencao.count()) === 1, "apply com utilizador inexistente: recusado, nada escrito");

      relApply = await E.executar(ap.prisma, opcoes({ aplicar: true }));
      const c = relApply.criado!;
      check(relApply.erros.length === 0 && c.cabecalhosCriados === 36 && c.linhasMensaisCriadas === linhasMensais && c.celulasCriadas === linhasMensais * 5 && c.itensPorFarmaciaCriados === 180,
        `1. apply: 36 cabeçalhos, ${linhasMensais} linhas mensais, ${linhasMensais * 5} células, 180 itens por farmácia`, JSON.stringify(relApply.erros));
      check(relApply.contagensDepois!.vendaManutencao === relApply.contagensAntes.vendaManutencao + 36 && relApply.contagensDepois!.desteConjunto.cabecalhos === 36, "contagens antes/depois coerentes (+36; 36 do conjunto)");

      // 2/3 matrizes e totais, lidos da BD
      let matrizesOk = true, totaisOk = true, dif = "";
      for (const r of doc.records) {
        const registo = O.normalizarRegistos(doc).find((x) => x.cnp === Number(r.cnp) && x.dataCompra === r.purchase_date && x.numMeses === r.number_months && x.totaisLegados.join() === r.totals.join())!;
        const m = await ap.prisma.vendaManutencao.findUnique({ where: { id: registo.headerId }, include: { celulas: true } });
        if (!m) { matrizesOk = false; dif = `falta ${registo.headerId}`; continue; }
        const mapa = new Map(m.celulas.map((x) => [`${x.farmaciaId}|${x.ano}|${x.mes}`, Number(x.quantidade)]));
        const somas = [0, 0, 0, 0, 0];
        for (const [ym, ...vals] of r.months) {
          const [ano, mes] = ym.split("-").map(Number);
          vals.forEach((v, k) => {
            const got = mapa.get(`${ap.farmacias[k].id}|${ano}|${mes}`);
            if (got !== v) { matrizesOk = false; dif = `${r.cnp} ${ym} col ${k}: ${got} ≠ ${v}`; }
            somas[k] += got ?? 0;
          });
        }
        if (somas.join() !== r.totals.join()) { totaisOk = false; dif = `${r.cnp}: ${somas} ≠ ${r.totals}`; }
        if (m.celulas.length !== r.months.length * 5 || m.numMeses !== r.number_months || Number(m.quantidadeTotal) !== somas.reduce((a, b) => a + b, 0)) { matrizesOk = false; dif = `${r.cnp}: cabeçalho`; }
        const [a0, m0] = r.months[0][0].split("-").map(Number);
        if (m.mesInicialAno !== a0 || m.mesInicialMes !== m0 || m.origemDistribuicao !== "MANUAL_AJUSTADA" || m.estado !== "ATIVA" || m.criadoPorId !== ap.user.id) { matrizesOk = false; dif = `${r.cnp}: campos do cabeçalho`; }
      }
      check(matrizesOk, "2. todas as matrizes preservadas exactamente (cada célula, incl. zeros; cabeçalhos coerentes)", dif);
      check(totaisOk, "3. totais por farmácia = totals do ficheiro, incl. os que diferem da quantidade (ex.: 60/60/92/37/53)", dif);

      const pvps = await ap.prisma.vendaManutencaoFarmacia.findMany({ where: { manutencaoId: { startsWith: "hg1_" } } });
      check(pvps.length === 180 && pvps.every((p) => p.pvpReferencia === null), "PVP de referência NULL em todos (nunca inventado, nunca 0)");

      const porCnp = new Map<number, Set<string>>();
      for (const m of await ap.prisma.vendaManutencao.findMany({ where: { id: { startsWith: "hg1_" } }, select: { id: true, cnp: true } })) porCnp.set(m.cnp, (porCnp.get(m.cnp) ?? new Set()).add(m.id));
      check(porCnp.get(5440987)!.size === 4 && porCnp.get(3854585)!.size === 3 && porCnp.get(5788484)!.size === 3 && porCnp.get(7395517)!.size === 3 && [...porCnp.values()].reduce((s, x) => s + x.size, 0) === 36, "4. vários registos independentes para o mesmo CNP (5440987×4, 3854585×3, 5788484×3, 7395517×3; 24 CNP, 36 registos)");

      const logs = await ap.prisma.auditLog.findMany({ where: { action: O.ACAO_AUDITORIA } });
      const meta = JSON.parse(logs.find((l) => l.metaJson!.includes("3311180"))!.metaJson!);
      check(logs.length === 36 && meta.dataCompra === "2024-04-03" && meta.quantidadeSistemaAnterior === 10 && meta.origem.derived_months[0] === "2025-03" && meta.ficheiroSha256 === ficheiroHash,
        "a data de compra, a quantidade antiga, a origem e `derived_months` ficam no AuditLog (36 linhas)");
      // O mapa de Vendas REAL consome estes registos (incluirManutencao) — a matriz é lida tal como foi gravada.
      const { getVendasData } = await import("../../lib/vendas-data");
      // O mapa só desenha pares produto×farmácia que existam em ProdutoFarmacia (como em produção).
      for (const f of ap.farmacias) await ap.prisma.produtoFarmacia.create({ data: { produtoId: ap.produtos.get(3311180)!, farmaciaId: f.id, stockAtual: 1, pvp: 5 } });
      const mapa = await getVendasData({ from: "2024-04-01", to: "2025-03-31", incluirManutencao: true, apenasComStock: true, pesquisa: "3311180" } as never, ap.prisma);
      const porFarm = new Map<string, number>();
      for (const row of mapa.rows) porFarm.set(row.farmacia, (porFarm.get(row.farmacia) ?? 0) + row.quantidadeManutencao);
      check(NOMES.every((n) => porFarm.get(n) === 10), "o mapa de Vendas (incluirManutencao) mostra, para o CNP 3311180, 10 unidades por farmácia (os totais do ficheiro)", JSON.stringify([...porFarm]));
      const orfaos = await ap.prisma.$queryRaw<Array<{ n: bigint }>>`
        SELECT (SELECT count(*) FROM "VendaManutencaoCelula" c WHERE NOT EXISTS (SELECT 1 FROM "VendaManutencao" m WHERE m.id = c."manutencaoId"))
             + (SELECT count(*) FROM "VendaManutencaoFarmacia" f WHERE NOT EXISTS (SELECT 1 FROM "VendaManutencao" m WHERE m.id = f."manutencaoId")) AS n`;
      check(Number(orfaos[0].n) === 0, "12. zero células/itens órfãos");
      check((await preSnap(ap.prisma, ap.preId)) === preAntes, "14. a manutenção preexistente ficou intocada");
      const dsg = await ap.prisma.produto.findMany({ where: { cnp: { in: cnps } }, select: { designacao: true } });
      check(dsg.every((p) => p.designacao.endsWith("(catálogo actual)")), "as designações do catálogo não foram alteradas");
      check(c.manutencoesCriadas.length === 36 && c.celulaIds.length === linhasMensais * 5 && relApply.rollback === null, "16. o relatório do apply traz os ids técnicos criados (36 cabeçalhos, todas as células, todos os PVP)");
      check(!JSON.stringify(relApply).includes("postgresql://") && relApply.baseDados === "localhost:0/teste" && relApply.ficheiroSha256 === ficheiroHash && relApply.revisaoCodigo === "teste" && !!relApply.dataHora, "16. o relatório não expõe credenciais e traz base, hash, revisão e hora");
    }

    // ═══ Idempotência ════════════════════════════════════════════════
    console.log("\n=== I. Idempotência e conflitos ===");
    {
      const antes = await O.contar(ap.prisma);
      const r2 = await E.executar(ap.prisma, opcoes({ aplicar: true }));
      const depois = await O.contar(ap.prisma);
      check(r2.totais.jaExistentes === 36 && r2.totais.novas === 0 && r2.criado!.cabecalhosCriados === 0 && JSON.stringify(antes) === JSON.stringify(depois), "5. segunda execução: 36 JA_EXISTENTE, nada criado");

      // conflito: alterar uma célula de um registo da operação
      const alvo = relApply.criado!.manutencoesCriadas[3];
      const cel = (await ap.prisma.vendaManutencaoCelula.findFirst({ where: { manutencaoId: alvo.id } }))!;
      await ap.prisma.vendaManutencaoCelula.update({ where: { id: cel.id }, data: { quantidade: Number(cel.quantidade) + 1 } });
      const rc = await E.executar(ap.prisma, opcoes({ aplicar: true }));
      check(rc.totais.conflitos === 1 && rc.bloqueios.length === 1 && rc.erros.length === 1 && rc.criado === null, "6. registo parcialmente diferente ⇒ CONFLITO que bloqueia o --apply (nunca actualiza)");
      const aposC = await ap.prisma.vendaManutencaoCelula.findUnique({ where: { id: cel.id } });
      check(Number(aposC!.quantidade) === Number(cel.quantidade) + 1, "…e o registo divergente não foi tocado");
      await ap.prisma.vendaManutencaoCelula.update({ where: { id: cel.id }, data: { quantidade: Number(cel.quantidade) } });

      // preexistente equivalente criado "à mão" (id diferente) ⇒ JA_EXISTENTE; divergente ⇒ CONFLITO
      const b = await novaBase();
      const regs = O.normalizarRegistos(doc);
      const r0 = regs[0];
      const f = b.farmacias;
      const celulas = r0.meses.flatMap((m) => m.valores.map((v, k) => ({ farmaciaId: f[k].id, ano: m.ano, mes: m.mes, quantidade: v })));
      const manual = await b.prisma.vendaManutencao.create({
        data: { produtoId: b.produtos.get(r0.cnp)!, cnp: r0.cnp, quantidadeTotal: r0.quantidadeTotal, numMeses: r0.numMeses, mesInicialAno: r0.mesInicialAno, mesInicialMes: r0.mesInicialMes, criadoPorId: b.user.id, celulas: { create: celulas } },
      });
      const p1 = await E.executar(b.prisma, opcoes());
      check(p1.itens[0].estado === "JA_EXISTENTE" && p1.itens[0].existenteId === manual.id && p1.totais.novas === 35, "equivalente preexistente (criado por outra via) ⇒ JA_EXISTENTE, não duplica");
      await b.prisma.vendaManutencaoCelula.updateMany({ where: { manutencaoId: manual.id, farmaciaId: f[0].id, ano: r0.mesInicialAno, mes: r0.mesInicialMes }, data: { quantidade: 99 } });
      const p2 = await E.executar(b.prisma, opcoes());
      check(p2.itens[0].estado === "CONFLITO" && p2.bloqueios.length === 1, "mesma identidade principal com conteúdo divergente ⇒ CONFLITO");
    }

    // ═══ Entidades ═══════════════════════════════════════════════════
    console.log("\n=== E. Entidades em falta ou ambíguas ===");
    {
      const b7 = await novaBase({ semProduto: 7408120 });
      const r7 = await E.executar(b7.prisma, opcoes({ aplicar: true }));
      check(r7.totais.cnpNaoEncontrados.join() === "7408120" && r7.bloqueios.length === 1 && r7.criado === null && (await b7.prisma.vendaManutencao.count()) === 1, "7. produto inexistente: identificado, --apply recusado, nada escrito");
      const b8 = await novaBase({ semFarmacia: "Farmácia Pereiro" });
      const r8 = await E.executar(b8.prisma, opcoes({ aplicar: true }));
      check(r8.farmacias.Pereiro === null && r8.bloqueios.some((x) => /Pereiro/.test(x)) && r8.criado === null && (await b8.prisma.vendaManutencao.count()) === 1, "8. farmácia inexistente: identificada, --apply recusado, nada escrito");
      const b9 = await novaBase({ extraFarmacia: "Castelo" });
      const r9 = await E.executar(b9.prisma, opcoes({ aplicar: true }));
      check(r9.farmacias.Castelo === null && r9.bloqueios.some((x) => /ambígua/.test(x)) && r9.criado === null && (await b9.prisma.vendaManutencao.count()) === 1, "9. farmácia ambígua (duas «Castelo»): --apply recusado, nada escrito");
      const idCastelo = b9.farmacias[2].id;
      const r9b = await E.executar(b9.prisma, opcoes({ farmaciasExplicitas: { Castelo: idCastelo } }));
      check(r9b.farmacias.Castelo?.id === idCastelo && r9b.farmacias.Castelo?.via === "id-explicito" && r9b.bloqueios.length === 0, "…fixando o id com --farmacias a ambiguidade resolve-se");
      const r9c = await E.executar(b9.prisma, opcoes({ farmaciasExplicitas: { Castelo: "id-que-nao-existe" } }));
      check(r9c.bloqueios.some((x) => /não existe/.test(x)), "…um id explícito inexistente é recusado");
    }

    // ═══ Rollback ════════════════════════════════════════════════════
    console.log("\n=== R. Falha a meio ⇒ rollback integral ===");
    {
      const b = await novaBase();
      const antes = await O.contar(b.prisma);
      const logs = await b.prisma.auditLog.count();
      const r = await E.executar(b.prisma, opcoes({ aplicar: true, falharNoRegisto: 36 }));
      const depois = await O.contar(b.prisma);
      check(r.erros.length === 1 && /FALHA_FORCADA/.test(r.erros[0]) && r.rollback?.confirmado === true && r.rollback.contagensRepostas, "11. falha no ÚLTIMO registo: erro reportado e rollback confirmado");
      check(JSON.stringify(antes) === JSON.stringify(depois) && depois.desteConjunto.cabecalhos === 0 && (await b.prisma.auditLog.count()) === logs, "…zero cabeçalhos, células, itens ou auditoria deixados");
      const ok = await E.executar(b.prisma, opcoes({ aplicar: true }));
      check(ok.criado?.cabecalhosCriados === 36, "…e depois da falha a operação completa-se normalmente");
    }

    // ═══ Reversão ════════════════════════════════════════════════════
    console.log("\n=== V. Reversão ===");
    {
      const lista = relApply.criado!.manutencoesCriadas;
      const antes = await O.contar(ap.prisma);
      const dryR = await O.reverter(ap.prisma, lista, { aplicar: false });
      check(dryR.removidos.length === 36 && !dryR.aplicado && JSON.stringify(await O.contar(ap.prisma)) === JSON.stringify(antes), "reversão em dry-run: lista 36 alvos e não escreve");
      await ap.prisma.vendaManutencaoCelula.updateMany({ where: { manutencaoId: lista[0].id }, data: { quantidade: 1000 } });
      await check_rejeita(() => O.reverter(ap.prisma, lista, { aplicar: true }), "reversão recusada se um registo foi alterado depois da operação");
      const cel0 = await ap.prisma.vendaManutencaoCelula.findMany({ where: { manutencaoId: lista[0].id } });
      void cel0;
      // repõe o valor original para poder reverter
      const orig = O.normalizarRegistos(doc).find((x) => x.headerId === lista[0].id)!;
      for (const m of orig.meses) for (let k = 0; k < 5; k++) await ap.prisma.vendaManutencaoCelula.updateMany({ where: { manutencaoId: lista[0].id, farmaciaId: ap.farmacias[k].id, ano: m.ano, mes: m.mes }, data: { quantidade: m.valores[k] } });
      await check_rejeita(() => O.reverter(ap.prisma, [{ id: ap.preId, celulas: 1, somaCelulas: 7 }], { aplicar: true }), "reversão recusa ids fora do prefixo da operação (a manutenção preexistente)");
      const r = await O.reverter(ap.prisma, lista, { aplicar: true, utilizadorEmail: "admin@garantia.test" });
      const depois = await O.contar(ap.prisma);
      check(r.aplicado && r.removidos.length === 36 && depois.desteConjunto.cabecalhos === 0 && depois.desteConjunto.celulas === 0 && depois.desteConjunto.farmaciasPvp === 0, "13. reversão remove os 36 cabeçalhos, as células e os itens por farmácia");
      check(depois.vendaManutencao === 1 && depois.vendaManutencaoCelula === 1 && depois.vendaManutencaoFarmacia === 1 && (await preSnap(ap.prisma, ap.preId)) === preAntes, "13/14. só os registos criados saíram: a preexistente continua exactamente igual");
      check((await ap.prisma.auditLog.count({ where: { action: O.ACAO_AUDITORIA } })) === 36 && (await ap.prisma.auditLog.count({ where: { action: O.ACAO_AUDITORIA_REVERSAO } })) === 36, "a auditoria da criação fica e ganha 36 linhas de reversão");
      const r2 = await O.reverter(ap.prisma, lista, { aplicar: true });
      check(r2.jaRevertidos.length === 36 && r2.removidos.length === 0, "reversão idempotente: segunda vez ⇒ 36 já revertidos");
      const re = await E.executar(ap.prisma, opcoes({ aplicar: true }));
      check(re.criado?.cabecalhosCriados === 36, "e é possível voltar a aplicar depois de reverter (ids determinísticos, sem resíduos)");
    }

    // ═══ CLI real com tenant resolvido pelo control plane ═════════════
    console.log("\n=== C. CLI real (tenant garantia via control plane) ===");
    {
      const base = await novaBase();
      const dbCtl = `spharm_test_gm_ctl_${sufixo}`;
      criadas.push(dbCtl);
      await admin.query(`CREATE DATABASE ${dbCtl}`);
      const ctlUrl = urlDe(dbCtl);
      const envCli = { ...process.env, CONTROL_DATABASE_URL: ctlUrl, TENANT_ENCRYPTION_SECRET: "gm-test-encryption-secret-0123456789abcdef", TENANT_DB_SSLMODE: "disable", DATABASE_URL: "postgresql://x:x@127.0.0.1:1/naousar" };
      execSync("npx prisma migrate deploy --config prisma-control.config.ts", { cwd: raiz, env: envCli, stdio: "pipe" });
      process.env.TENANT_ENCRYPTION_SECRET = envCli.TENANT_ENCRYPTION_SECRET;
      const { encryptTenantSecret } = await import("../../lib/tenant-crypto");
      const { PrismaClient: Ctl } = await import("../../generated/prisma-control/client");
      const ctl = new Ctl({ adapter: new PrismaPg({ connectionString: ctlUrl }) });
      const u = new URL(urlDe(base.nome));
      await ctl.tenant.create({ data: { slug: "garantia", nome: "Garantia (teste)", estado: "ACTIVE", dbHost: u.hostname, dbPort: Number(u.port), dbName: base.nome, dbUser: u.username, dbPassEncrypted: encryptTenantSecret(decodeURIComponent(u.password)), ingestApiKeyHash: await bcrypt.hash("x", 4) } });
      await ctl.tenant.create({ data: { slug: "silveira", nome: "Silveira (teste)", estado: "ACTIVE", dbHost: u.hostname, dbPort: Number(u.port), dbName: base.nome, dbUser: u.username, dbPassEncrypted: encryptTenantSecret(decodeURIComponent(u.password)), ingestApiKeyHash: await bcrypt.hash("x", 4) } });
      await ctl.$disconnect();
      const dir = mkdtempSync(path.join(tmpdir(), "gm-"));
      const cli = (args: string[]) => spawnSync("npx", ["tsx", "scripts/ops/garantia-reposicao-manutencoes-vendas.ts", ...args], { cwd: raiz, env: envCli, encoding: "utf8", shell: process.platform === "win32" });

      const c0 = cli(["--tenant=silveira"]);
      check(c0.status === 2 && /exclusivamente --tenant=garantia/.test(c0.stderr), "10. --tenant=silveira recusado (exit 2)");
      const c0b = cli([]);
      check(c0b.status === 2, "10. sem --tenant recusado (exit 2)");
      const c1 = cli(["--tenant=garantia", "--apply"]);
      check(c1.status === 2 && /confirmar-tenant/.test(c1.stderr) && (await base.prisma.vendaManutencao.count()) === 1, "--apply sem --confirmar-tenant=garantia recusado, nada escrito");
      const c1b = cli(["--tenant=garantia", "--apply", "--confirmar-tenant=silveira"]);
      check(c1b.status === 2, "--confirmar-tenant com outro valor recusado");

      const relDry = path.join(dir, "dry.json");
      const c2 = cli(["--tenant=garantia", `--relatorio=${relDry}`]);
      const d = JSON.parse(readFileSync(relDry, "utf8"));
      check(c2.status === 0 && d.tipo === "dry-run" && d.totais.novas === 36 && (await base.prisma.vendaManutencao.count()) === 1 && d.baseDados === `${u.hostname}:${u.port}/${base.nome}` && !readFileSync(relDry, "utf8").includes("postgresql://"),
        "CLI dry-run (por omissão): 36 novas, zero escritas, base sem credenciais", c2.stderr.slice(0, 300));

      const relAp = path.join(dir, "apply.json");
      const c3 = cli(["--tenant=garantia", "--apply", "--confirmar-tenant=garantia", "--utilizador-email=admin@garantia.test", `--relatorio=${relAp}`]);
      const a = JSON.parse(readFileSync(relAp, "utf8"));
      check(c3.status === 0 && a.tipo === "apply" && a.criado.cabecalhosCriados === 36 && (await base.prisma.vendaManutencao.count()) === 37, "CLI --apply: 36 criados no tenant garantia", c3.stderr.slice(0, 300));
      const c4 = cli(["--tenant=garantia", "--apply", "--confirmar-tenant=garantia", "--utilizador-email=admin@garantia.test", `--relatorio=${path.join(dir, "apply2.json")}`]);
      check(c4.status === 0 && JSON.parse(readFileSync(path.join(dir, "apply2.json"), "utf8")).totais.jaExistentes === 36 && (await base.prisma.vendaManutencao.count()) === 37, "CLI segunda execução: idempotente");

      const c5 = cli(["--tenant=garantia", `--reverter=${relAp}`, `--relatorio=${path.join(dir, "rev-dry.json")}`]);
      check(c5.status === 0 && (await base.prisma.vendaManutencao.count()) === 37, "CLI reversão em dry-run: não escreve");
      const c6 = cli(["--tenant=garantia", `--reverter=${relAp}`, "--apply", "--confirmar-tenant=garantia", "--utilizador-email=admin@garantia.test", `--relatorio=${path.join(dir, "rev.json")}`]);
      check(c6.status === 0 && (await base.prisma.vendaManutencao.count()) === 1, "CLI reversão --apply: repõe o estado inicial (só a preexistente)", c6.stderr.slice(0, 300));
      const c7 = cli(["--tenant=garantia", `--reverter=${relDry}`, "--apply", "--confirmar-tenant=garantia"]);
      check(c7.status === 2, "CLI reversão com o relatório de um dry-run: recusada");
      writeFileSync(path.join(tmpdir(), "apply-garantia-manutencoes.json"), JSON.stringify(a, null, 2));
    }
  } finally {
    for (const p of abertos) await p.$disconnect().catch(() => {});
    for (const n of criadas.reverse()) await admin.query(`DROP DATABASE IF EXISTS ${n} WITH (FORCE)`).catch(() => {});
    await admin.end();
  }
  console.log(`\n${failed === 0 ? "PASSOU" : "FALHOU"} — ${passed} OK, ${failed} falhas\n`);
  process.exit(failed === 0 ? 0 : 1);
}

async function check_rejeita(fn: () => Promise<unknown>, msg: string) {
  try { await fn(); check(false, msg); } catch { check(true, msg); }
}

main().catch((e) => { console.error(e); process.exit(1); });
