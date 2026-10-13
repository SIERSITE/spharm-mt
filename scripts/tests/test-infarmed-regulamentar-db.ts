/**
 * scripts/tests/test-infarmed-regulamentar-db.ts
 *
 * Leitor do ficheiro INFARMED + aplicação versionada + job mensal, contra um
 * PostgreSQL REAL e DESCARTÁVEL (nunca uma base verdadeira):
 *
 *   docker run -d --name spharm-mg-pg -e POSTGRES_PASSWORD=test -p 15433:5432 postgres:16-alpine
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres \
 *     INFARMED_XLS=_input/allPackages-original.xls npx tsx scripts/tests/test-infarmed-regulamentar-db.ts
 *
 * Sem INFARMED_XLS, a secção do ficheiro REAL é saltada (e dito); as sintéticas correm sempre.
 */
import Module from "node:module";
import fs from "node:fs";
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
type Cel = string | number | null;
type L = Cel[];
function linha(reg: Cel, o: Partial<Record<string, Cel>> = {}): L {
  const g = (k: string, d: Cel): Cel => (k in o ? (o[k] as Cel) : d);
  return [reg, g("dci", "Paracetamol"), g("nome", "Ben-u-ron"), g("forma", "Comprimido"), g("dos", "500 mg"), g("emb", "20 unidade(s)"),
    g("cnpem", 50000001), g("pvp", 3.5), g("notif", null), g("geral", 3.2), g("pens", 2.9), g("comerc", "Comercializado"), g("gen", "Não")];
}
function xls(rows: L[], opts: { cab?: string[]; folha?: string; bookType?: "biff8" | "xlsx" } = {}): Buffer {
  const ws = XLSX.utils.aoa_to_sheet([opts.cab ?? CAB, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, opts.folha ?? "Medicamentos");
  return XLSX.write(wb, { type: "buffer", bookType: opts.bookType ?? "biff8" }) as Buffer;
}

async function main() {
  const { lerFicheiroInfarmed, FicheiroInfarmedInvalido, COLUNAS_OBRIGATORIAS } = await import("../../lib/regulamentar/infarmed-ficheiro");
  const { aplicarVersaoInfarmed, reverterVersaoInfarmed, contagens } = await import("../../lib/regulamentar/infarmed-aplicar");
  const { descarregarInfarmed } = await import("../../lib/regulamentar/infarmed-job");

  // ═══ A · ficheiro REAL ═══════════════════════════════════════════════
  secao("A · ficheiro original do INFARMED");
  const real = process.env.INFARMED_XLS;
  if (real && fs.existsSync(real)) {
    const buf = fs.readFileSync(real);
    const r = lerFicheiroInfarmed(buf);
    check(r.sha256 === "058c70101d71cecba99806be3882f117929821de210d429f34f327f535d2ea07", "SHA-256 do ficheiro original confere");
    check(r.folha === "Medicamentos", "folha «Medicamentos»");
    check(r.cabecalhos.length === 13 && COLUNAS_OBRIGATORIAS.every((c, i) => r.cabecalhos[i] === c), "13 colunas, pela ordem original");
    check(r.linhasLidas === 20915, `20 915 linhas de dados (${r.linhasLidas})`);
    check(r.linhas.length + r.rejeitadas.length + r.conflitos.length + r.duplicadosIdenticos === 20915, "linhas = válidas + rejeitadas + conflitos + duplicados");
    check(r.rejeitadas.length === 19 && r.rejeitadas.every((x) => x.motivo === "Nº registo vazio"), "19 linhas sem Nº registo rejeitadas, com motivo");
    check(r.linhas.length === 20896 && r.cnpDistintos === 20896 && r.conflitos.length === 0 && r.duplicadosIdenticos === 0, "20 896 CNP únicos, sem duplicados nem conflitos");
    const livre = r.linhas.find((l) => l.registo === "5886726")!;
    check(livre.precoLivre && livre.pvp === null, "«preço livre» → precoLivre=true e pvp NULL (não zero)");
    check(livre.pvpNotificado === null && livre.precoUtenteGeral === null && livre.precoUtenteEspecial === null, "células vazias ficam NULL (não zero)");
    check(livre.cnpem === "50212591" && typeof livre.cnpem === "string", "CNPEM guardado como texto");
    const comPvp = r.linhas.find((l) => l.registo === "4604195")!;
    check(comPvp.pvp === 3.04 && !comPvp.precoLivre && comPvp.precoUtenteGeral === 3.04 && comPvp.precoUtenteEspecial === 3.04, "PVP numérico, Preço Utente (geral) e Pensionistas (especial)");
    check(comPvp.estadoComercializacao === "Não comercializado" && comPvp.generico === false, "estado de comercialização e genérico");
    const notif = r.linhas.find((l) => l.pvpNotificado !== null);
    check(!!notif && notif.pvpNotificado! > 0, "PVP Notificado lido quando existe");
    check(r.linhas.filter((l) => l.precoLivre).length === 3325 && r.linhas.filter((l) => l.pvp !== null).length === 17238, "3 325 preço livre + 17 238 PVP numérico");
    check(r.linhas.filter((l) => l.pvp === 0).length === 0, "nenhum PVP convertido em 0");
    check(r.linhas.every((l) => /^[1-9]\d*$/.test(l.registo) && String(l.cnp) === l.registo), "Nº registo preservado (sem perda de zeros nem de dígitos)");
  } else {
    console.log("  (INFARMED_XLS não definido — secção do ficheiro real saltada)");
  }

  // ═══ B · leitor, casos sintéticos ═══════════════════════════════════
  secao("B · leitor — validação do formato");
  const falha = (f: () => unknown, codigo: string) => { try { f(); return false; } catch (e) { return e instanceof FicheiroInfarmedInvalido && e.codigo === codigo; } };
  check(falha(() => lerFicheiroInfarmed(Buffer.alloc(0)), "VAZIO"), "ficheiro vazio recusado");
  check(falha(() => lerFicheiroInfarmed(Buffer.from("<!DOCTYPE html><html><body>Erro 500</body></html>")), "HTML"), "HTML recusado");
  check(falha(() => lerFicheiroInfarmed(Buffer.from("PK\u0003\u0004 não é xls".repeat(10))), "ASSINATURA") || falha(() => lerFicheiroInfarmed(Buffer.from("PK\u0003\u0004 não é xls".repeat(10))), "HTML"), "ficheiro que não é OLE2 recusado");
  check(falha(() => lerFicheiroInfarmed(xls([linha("5000001")], { bookType: "xlsx" })), "ASSINATURA"), ".xlsx (zip) recusado — só Excel 97-2003");
  check(falha(() => lerFicheiroInfarmed(xls([linha("5000001")], { folha: "Outra" })), "FOLHA"), "folha errada recusada");
  for (const c of CAB) {
    const cab = CAB.filter((x) => x !== c);
    const rows = [linha("5000001")].map((l) => l.filter((_, i) => CAB[i] !== c));
    check(falha(() => lerFicheiroInfarmed(xls(rows, { cab })), "COLUNAS"), `sem a coluna «${c}» → recusado`);
  }
  check(falha(() => lerFicheiroInfarmed(xls([])), "SEM_LINHAS"), "sem linhas de dados recusado");
  // ordem das colunas trocada: mapeia por NOME
  const ordem = [...CAB].reverse();
  const rowsRev = [linha("5000001", { nome: "NomeX", pvp: 9.9 })].map((l) => [...l].reverse());
  const rev = lerFicheiroInfarmed(xls(rowsRev, { cab: ordem }));
  check(rev.linhas[0]?.nomeMedicamento === "NomeX" && rev.linhas[0]?.pvp === 9.9, "colunas mapeadas pelo nome, não pela posição");

  secao("B2 · leitor — valores");
  const v = lerFicheiroInfarmed(xls([
    linha("5000001", { pvp: "preço livre" }),
    linha("5000002", { pvp: "Preço Livre" }),
    linha("5000003", { pvp: null }),
    linha("5000004", { pvp: "12,34", geral: "10.5" }),
    linha("5000005", { pvp: -1 }),
    linha("5000006", { pvp: "abc" }),
    linha("0123456"),
    linha("12ab"),
    linha(null),
    linha("5000007", { cnpem: null, gen: "Sim", notif: 4.5 }),
    linha("5000008"), linha("5000008"),                          // duplicado idêntico
    linha("5000009", { nome: "A" }), linha("5000009", { nome: "B" }), // conflito
  ]));
  const por = (r: string) => v.linhas.find((l) => l.registo === r);
  check(por("5000001")?.precoLivre === true && por("5000001")?.pvp === null, "«preço livre» → flag, sem valor");
  check(por("5000002")?.precoLivre === true, "«Preço Livre» (maiúsculas) também");
  check(por("5000003")?.precoLivre === false && por("5000003")?.pvp === null, "PVP vazio → NULL, sem preço livre");
  check(por("5000004")?.pvp === 12.34 && por("5000004")?.precoUtenteGeral === 10.5, "decimais com vírgula/ponto em texto");
  check(!por("5000005") && v.rejeitadas.some((x) => x.registo === "5000005" && /inválido/.test(x.motivo)), "PVP negativo rejeitado");
  check(!por("5000006") && v.rejeitadas.some((x) => x.registo === "5000006" && /não numérico/.test(x.motivo)), "PVP textual rejeitado");
  check(!por("0123456") && v.rejeitadas.some((x) => x.registo === "0123456" && /zeros à esquerda/.test(x.motivo)), "zeros à esquerda → rejeitado (identidade preservada, não normalizada)");
  check(v.rejeitadas.some((x) => x.registo === "12ab"), "registo não numérico rejeitado");
  check(v.rejeitadas.some((x) => x.registo === null && x.motivo === "Nº registo vazio"), "registo vazio rejeitado");
  check(por("5000007")?.cnpem === null && por("5000007")?.generico === true && por("5000007")?.pvpNotificado === 4.5, "CNPEM vazio → NULL; genérico Sim; PVP notificado");
  check(v.duplicadosIdenticos === 1 && !!por("5000008"), "duplicado idêntico: conta-se e mantém-se 1");
  check(!por("5000009") && v.conflitos.length === 1 && v.conflitos[0].registo === "5000009", "duplicado com conteúdo diferente = conflito, excluído");

  // ═══ C · base de dados ══════════════════════════════════════════════
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const dbName = `spharm_inf_${Date.now().toString(36)}`;
  await admin.query(`CREATE DATABASE ${dbName}`);
  try {
    execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: urlDe(dbName) }, encoding: "utf8" });
    const { PrismaClient } = await import("../../generated/prisma/client");
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(dbName) }) });

    const far = await prisma.farmacia.create({ data: { nome: "Farmácia Teste INF" } });
    const mk = async (cnp: number, designacao: string, extra: { dci?: string } = {}) => {
      const p = await prisma.produto.create({ data: { cnp, designacao, dci: extra.dci ?? null } });
      await prisma.produtoFarmacia.create({ data: { produtoId: p.id, farmaciaId: far.id, pvp: 9.99, pmc: 5, puc: 4, stockAtual: 7 } });
      await prisma.vendaMensal.create({ data: { farmaciaId: far.id, produtoId: p.id, ano: 2026, mes: 5, quantidade: 3, valorTotal: 30 } });
      return p;
    };
    const p1 = await mk(5000001, "BEN-U-RON 500 ERP", { dci: "Paracetamol ERP" });
    const p2 = await mk(5000002, "DESIGNACAO ERP 2");
    const p3 = await mk(5000003, "MESMA DCI MAS OUTRO CNP", { dci: "Paracetamol" });
    const antesCont = await contagens(prisma);

    const f1 = lerFicheiroInfarmed(xls([
      linha("5000001", { nome: "Ben-u-ron INFARMED", cnpem: 50000001 }),
      linha("5000002", { pvp: "preço livre", geral: null, pens: null, cnpem: 50000002 }),
      linha("5000099", { cnpem: 50000099 }),                      // não existe na base
      linha("9999999", { dci: "Paracetamol", nome: "Mesma DCI", cnpem: 50000001 }), // mesma DCI/CNPEM, CNP inexistente
    ]));

    secao("C1 · dry-run por omissão");
    const dry = await aplicarVersaoInfarmed(prisma, f1, { origem: "CARGA_INICIAL" });
    check(dry.modo === "DRY_RUN" && dry.resultado === "SIMULADA", "sem --apply é dry-run");
    check((await prisma.infarmedImportacao.count()) === 0 && (await prisma.produtoRegulamentar.count()) === 0, "dry-run não escreve nada");
    check(dry.produtosAssociados === 2 && dry.cnpNaoEncontrados === 2 && dry.registosNovos === 2, "dry-run calcula: 2 associados, 2 não encontrados, 2 novos");
    check(dry.detalhe.cnpNaoEncontrados.includes("5000099") && dry.detalhe.cnpNaoEncontrados.includes("9999999"), "CNP não encontrados listados");

    secao("C2 · apply — associação exata por CNP");
    const ap = await aplicarVersaoInfarmed(prisma, f1, { origem: "CARGA_INICIAL", apply: true, nomeFicheiro: "teste.xls" });
    check(ap.resultado === "APLICADA" && !!ap.importacaoId, "aplicada");
    const reg = await prisma.produtoRegulamentar.findMany({ include: { produto: true } });
    check(reg.length === 2 && reg.every((r) => r.produto.cnp === r.cnp), "só os 2 CNP existentes foram associados (igualdade exata do CNP)");
    check(!reg.some((r) => r.produtoId === p3.id), "produto com a MESMA DCI e outro CNP não foi associado");
    const r1 = reg.find((r) => r.cnp === 5000001)!;
    check(r1.nomeMedicamento === "Ben-u-ron INFARMED" && r1.cnpem === "50000001" && Number(r1.precoUtenteGeral) === 3.2 && Number(r1.precoUtenteEspecial) === 2.9, "dados regulamentares gravados (nome, CNPEM, regime geral/especial)");
    const r2 = reg.find((r) => r.cnp === 5000002)!;
    check(r2.precoLivre && r2.pvp === null && r2.precoUtenteGeral === null, "preço livre: flag e sem valor (NULL, não 0)");
    check(ap.operacionalIntacto === true, "contagens e checksums operacionais iguais antes/depois");
    const depois = await contagens(prisma);
    check(depois.checksumProdutos === antesCont.checksumProdutos && depois.checksumProdutosFarmacia === antesCont.checksumProdutosFarmacia, "Produto (designação, DCI, …) e ProdutoFarmacia (pvp, pmc, puc, stock) intactos");
    const pr1 = await prisma.produto.findUnique({ where: { id: p1.id } });
    check(pr1?.designacao === "BEN-U-RON 500 ERP" && pr1?.dci === "Paracetamol ERP", "Produto.designacao e Produto.dci NÃO foram substituídos pelo nome/DCI do INFARMED");
    const ativas = await prisma.infarmedImportacao.count({ where: { ativa: true } });
    check(ativas === 1, "exatamente uma versão ativa");

    secao("C3 · idempotência");
    const rep = await aplicarVersaoInfarmed(prisma, f1, { origem: "MANUAL", apply: true });
    check(rep.resultado === "JA_PROCESSADA", "repetir a mesma versão não reaplica");
    check((await prisma.infarmedImportacao.count({ where: { estado: "APLICADA" } })) === 1 && (await prisma.produtoRegulamentar.count()) === 2, "sem versões nem registos duplicados");

    secao("C4 · completar produtos entretanto criados (mesma versão)");
    const p4 = await mk(5000099, "PRODUTO CRIADO DEPOIS");
    const comp = await aplicarVersaoInfarmed(prisma, f1, { origem: "MANUAL", apply: true });
    check(comp.completados === 1, "a mesma versão completa o produto novo");
    check((await prisma.produtoRegulamentar.count({ where: { produtoId: p4.id } })) === 1 && (await prisma.infarmedImportacao.count({ where: { estado: "APLICADA" } })) === 1, "1 registo novo, sem nova versão");

    secao("C5 · versão nova: alterações, ausência e carry-forward");
    const f2 = lerFicheiroInfarmed(xls([
      linha("5000001", { nome: "Ben-u-ron INFARMED", cnpem: 50000001, geral: 3.3 }),   // preço utente mudou
      linha("5000099", { cnpem: 50000099 }),                                           // igual
      // 5000002 desapareceu do ficheiro
    ]));
    const v2 = await aplicarVersaoInfarmed(prisma, f2, { origem: "MENSAL", apply: true });
    check(v2.resultado === "APLICADA" && v2.registosAlterados === 1 && v2.camposAlterados === 1 && v2.camposAlteradosPorCampo.precoUtenteGeral === 1, "1 registo alterado, 1 campo (precoUtenteGeral)");
    check(v2.registosIguais === 1 && v2.deixaramDeEstarPresentes === 1, "1 igual; 1 deixou de estar presente");
    const ativa2 = await prisma.infarmedImportacao.findFirstOrThrow({ where: { ativa: true } });
    const ausente = await prisma.produtoRegulamentar.findFirstOrThrow({ where: { importacaoId: ativa2.id, produtoId: p2.id } });
    check(ausente.presenteNoFicheiro === false && ausente.precoLivre === true, "o produto ausente NÃO foi apagado: mantém os dados e fica assinalado");
    check(ativa2.versaoAnteriorId !== null && (await prisma.infarmedImportacao.count({ where: { ativa: true } })) === 1, "versão anterior registada; uma só ativa");

    secao("C6 · rollback da versão regulamentar");
    const rbSim = await reverterVersaoInfarmed(prisma, { apply: false });
    check(rbSim.ok && rbSim.simulada && (await prisma.infarmedImportacao.findFirstOrThrow({ where: { ativa: true } })).id === ativa2.id, "rollback em dry-run não altera nada");
    const rb = await reverterVersaoInfarmed(prisma, { apply: true });
    check(rb.ok && rb.ativaAgoraId === ativa2.versaoAnteriorId, "rollback devolve a versão anterior");
    const ativaRb = await prisma.infarmedImportacao.findFirstOrThrow({ where: { ativa: true } });
    check(ativaRb.id === ativa2.versaoAnteriorId && (await prisma.infarmedImportacao.findUniqueOrThrow({ where: { id: ativa2.id } })).estado === "REVERTIDA", "versão anterior ativa; a revertida fica REVERTIDA");
    check((await prisma.produtoRegulamentar.count({ where: { importacaoId: ativa2.id } })) > 0, "os dados da versão revertida não foram apagados");
    const r1b = await prisma.produtoRegulamentar.findFirstOrThrow({ where: { importacaoId: ativaRb.id, produtoId: p1.id } });
    check(Number(r1b.precoUtenteGeral) === 3.2, "os valores voltam aos da versão anterior");
    const semForcar = await aplicarVersaoInfarmed(prisma, f2, { origem: "MENSAL", apply: true });
    check(semForcar.resultado === "JA_PROCESSADA" && /revertida/.test(semForcar.motivo ?? ""), "a versão revertida não é reaplicada pelo job (sem --forcar)");
    const comForcar = await aplicarVersaoInfarmed(prisma, f2, { origem: "MANUAL", apply: true, forcar: true });
    check(comForcar.resultado === "APLICADA", "com --forcar reaplica");

    secao("C7 · falha a meio não deixa nada parcial");
    const ativaAntes = await prisma.infarmedImportacao.findFirstOrThrow({ where: { ativa: true } });
    const nRegAntes = await prisma.produtoRegulamentar.count();
    const f3 = lerFicheiroInfarmed(xls([linha("5000001", { nome: "NOVO NOME" }), linha("5000002")]));
    const fal = await aplicarVersaoInfarmed(prisma, f3, {
      origem: "MENSAL", apply: true,
      aposGravarRegistos: () => { throw new Error("FALHA_FORCADA_TESTE"); },
    });
    check(fal.resultado === "FALHADA" && /FALHA_FORCADA_TESTE/.test(fal.motivo ?? ""), "falha reportada");
    check((await prisma.produtoRegulamentar.count()) === nRegAntes, "nenhum registo parcial ficou gravado");
    check((await prisma.infarmedImportacao.findFirstOrThrow({ where: { ativa: true } })).id === ativaAntes.id, "a versão anterior continua ativa");
    check((await prisma.infarmedImportacao.count({ where: { estado: "FALHADA", sha256: f3.sha256 } })) === 1 && (await prisma.infarmedImportacao.count({ where: { estado: "EM_CURSO" } })) === 0, "fica o rasto FALHADA e nenhuma importação EM_CURSO");

    secao("C8 · concorrência: duas importações da mesma versão");
    const f4 = lerFicheiroInfarmed(xls([linha("5000001", { nome: "CONCORRENTE" }), linha("5000002", { nome: "CONCORRENTE 2" })]));
    const [ra, rb2] = await Promise.all([
      aplicarVersaoInfarmed(prisma, f4, { origem: "MENSAL", apply: true }),
      aplicarVersaoInfarmed(prisma, f4, { origem: "MENSAL", apply: true }),
    ]);
    const resultados = [ra.resultado, rb2.resultado].sort();
    check(resultados.join() === "APLICADA,JA_PROCESSADA" || resultados.join() === "APLICADA,FALHADA", `uma aplica, a outra não (${resultados.join(" / ")})`);
    check((await prisma.infarmedImportacao.count({ where: { sha256: f4.sha256, estado: "APLICADA" } })) === 1, "a versão foi importada UMA só vez");
    check((await prisma.infarmedImportacao.count({ where: { ativa: true } })) === 1, "continua só uma versão ativa");
    const ativaC = await prisma.infarmedImportacao.findFirstOrThrow({ where: { ativa: true } });
    check((await prisma.produtoRegulamentar.count({ where: { importacaoId: ativaC.id, produtoId: p1.id } })) === 1, "sem registos duplicados");
    let violou = false;
    try { await prisma.infarmedImportacao.create({ data: { origem: "MANUAL", sha256: "x", descarregadoEm: new Date(), ativa: true } }); } catch { violou = true; }
    check(violou, "a base recusa uma segunda versão ativa (índice único parcial)");

    secao("D · download direto (INFARMED_ALLPACKAGES_URL) — o job mensal e o formulário têm testes próprios (test-infarmed-atualizacao-db.ts)");
    const resp = (buf: Buffer, tipo = "application/vnd.ms-excel") => async () => ({
      ok: true, status: 200, headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? tipo : null) },
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, text: async () => "",
    });
    const recusa = async (f: () => Promise<unknown>, re: RegExp) => { try { await f(); return false; } catch (e) { return re.test(e instanceof Error ? e.message : String(e)); } };
    const boa = xls([linha("5000001")]);
    check((await descarregarInfarmed("https://exemplo.invalid/a.xls", { fetchImpl: resp(boa) })).length === boa.length, "download direto devolve o ficheiro validado");
    check(await recusa(() => descarregarInfarmed("https://exemplo.invalid/a.xls", { fetchImpl: resp(Buffer.from("<html>x</html>"), "text/html") }), /Content-Type/), "HTML (Content-Type) recusado");
    check(await recusa(() => descarregarInfarmed("https://exemplo.invalid/a.xls", { fetchImpl: resp(Buffer.from("<!DOCTYPE html><html>x</html>")) }), /HTML/), "HTML disfarçado de Excel recusado");
    check(await recusa(() => descarregarInfarmed("https://exemplo.invalid/a.xls", { fetchImpl: resp(Buffer.alloc(0)) }), /vazio/i), "ficheiro vazio recusado");
    check(await recusa(() => descarregarInfarmed("http://inseguro.invalid/a.xls"), /https/), "URL http recusado");

    secao("F · carga completa do ficheiro real contra uma base descartável");
    if (real && fs.existsSync(real)) {
      const fr = lerFicheiroInfarmed(fs.readFileSync(real));
      const amostra = fr.linhas.filter((_, i) => i % 7 === 0).slice(0, 2500);
      await prisma.produto.createMany({ data: amostra.map((l) => ({ cnp: l.cnp, designacao: `ERP ${l.cnp}` })), skipDuplicates: true });
      const antesF = await contagens(prisma);
      const t0 = Date.now();
      const dryF = await aplicarVersaoInfarmed(prisma, fr, { origem: "CARGA_INICIAL", nomeFicheiro: "allPackages-original.xls" });
      const nExist = await prisma.produto.count({ where: { cnp: { in: fr.linhas.map((l) => l.cnp) } } });
      check(dryF.resultado === "SIMULADA" && dryF.produtosAssociados === nExist, `dry-run real: ${dryF.produtosAssociados} produtos associados = ${nExist} existentes`);
      check(dryF.cnpNaoEncontrados === fr.linhas.length - nExist, `CNP não encontrados = ${dryF.cnpNaoEncontrados}`);
      const apF = await aplicarVersaoInfarmed(prisma, fr, { origem: "CARGA_INICIAL", apply: true, nomeFicheiro: "allPackages-original.xls" });
      check(apF.resultado === "APLICADA" && apF.operacionalIntacto === true, `carga real aplicada em ${Date.now() - t0} ms, operacional intacto`);
      check((await prisma.produtoRegulamentar.count({ where: { importacaoId: apF.importacaoId!, presenteNoFicheiro: true } })) === nExist, "um registo por produto existente no ficheiro (os de testes anteriores ficam assinalados como ausentes)");
      check((await contagens(prisma)).checksumProdutos === antesF.checksumProdutos, "Produto inalterado (checksum)");
      const livres = await prisma.produtoRegulamentar.count({ where: { importacaoId: apF.importacaoId!, precoLivre: true, pvp: null } });
      const pvpZero = await prisma.produtoRegulamentar.count({ where: { importacaoId: apF.importacaoId!, OR: [{ pvp: 0 }, { pvpNotificado: 0 }] } });
      const existentes = new Set((await prisma.produto.findMany({ where: { cnp: { in: fr.linhas.map((l) => l.cnp) } }, select: { cnp: true } })).map((x) => x.cnp));
      const zerosFicheiro = fr.linhas.filter((l) => existentes.has(l.cnp) && l.precoUtenteGeral === 0).length;
      const zerosBd = await prisma.produtoRegulamentar.count({ where: { importacaoId: apF.importacaoId!, presenteNoFicheiro: true, precoUtenteGeral: 0 } });
      const vaziosFicheiro = fr.linhas.filter((l) => existentes.has(l.cnp) && l.precoUtenteGeral === null).length;
      const vaziosBd = await prisma.produtoRegulamentar.count({ where: { importacaoId: apF.importacaoId!, presenteNoFicheiro: true, precoUtenteGeral: null } });
      check(livres > 0 && pvpZero === 0, `${livres} preços livres sem valor; nenhum PVP / PVP notificado a zero`);
      check(zerosBd === zerosFicheiro && vaziosBd === vaziosFicheiro, `preço utente: ${zerosBd} zeros genuínos do ficheiro preservados e ${vaziosBd} vazios continuam NULL (zero ≠ vazio)`);
      const rep2 = await aplicarVersaoInfarmed(prisma, fr, { origem: "MANUAL", apply: true });
      check(rep2.resultado === "JA_PROCESSADA" && !rep2.completados, "segunda carga do mesmo ficheiro: idempotente");
      const imp = await prisma.infarmedImportacao.findUniqueOrThrow({ where: { id: apF.importacaoId! } });
      check(imp.sha256 === fr.sha256 && imp.linhasLidas === 20915 && imp.cnpDistintos === 20896 && imp.linhasRejeitadas === 19, "histórico guarda sha256, linhas, CNP e rejeitadas");
    } else console.log("  (sem INFARMED_XLS — saltado)");

    await prisma.$disconnect();
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => undefined);
    await admin.end();
  }

  console.log(`\n${passed} OK, ${failed} falhas`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
