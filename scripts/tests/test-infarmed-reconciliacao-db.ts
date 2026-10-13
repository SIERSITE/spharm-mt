/**
 * scripts/tests/test-infarmed-reconciliacao-db.ts
 *
 * Reconciliação dos campos canónicos de Produto (forma, dosagem, embalagem, DCI)
 * com a versão regulamentar do INFARMED — contra PostgreSQL REAL e DESCARTÁVEL:
 *
 *   docker run -d --name spharm-mg-pg -e POSTGRES_PASSWORD=test -p 15433:5432 postgres:16-alpine
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres npx tsx scripts/tests/test-infarmed-reconciliacao-db.ts
 */
import Module from "node:module";
import { execSync, spawnSync } from "node:child_process";
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
const linha = (reg: string, o: { dci?: Cel; nome?: Cel; forma?: Cel; dos?: Cel; emb?: Cel } = {}): Cel[] => [
  reg, "dci" in o ? o.dci! : "Metformina", "nome" in o ? o.nome! : "Glucophage", "forma" in o ? o.forma! : "Comprimido",
  "dos" in o ? o.dos! : "1000 mg", "emb" in o ? o.emb! : "18 unidade(s)", 50000001, 5, null, 3, 2, "Comercializado", "Não",
];
const xls = (rows: Cel[][]): Buffer => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([CAB, ...rows]), "Medicamentos");
  return XLSX.write(wb, { type: "buffer", bookType: "biff8" }) as Buffer;
};

async function main() {
  const { PrismaClient } = await import("../../generated/prisma/client");
  const { lerFicheiroInfarmed } = await import("../../lib/regulamentar/infarmed-ficheiro");
  const { aplicarVersaoInfarmed, contagens } = await import("../../lib/regulamentar/infarmed-aplicar");
  const rec = await import("../../lib/regulamentar/infarmed-reconciliar");
  const { aplicarATenants } = await import("../../lib/regulamentar/infarmed-atualizacao");

  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const db = `spharm_rec_${Date.now().toString(36)}`;
  await admin.query(`CREATE DATABASE ${db}`);
  try {
    execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: urlDe(db) }, encoding: "utf8" });
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(db) }) });

    const mk = (cnp: number, extra: Record<string, unknown> = {}) =>
      prisma.produto.create({ data: { cnp, designacao: `DESIGNACAO ERP ${cnp}`, ...extra } });
    // P1: tudo vazio · P2: valores diferentes (não manuais) · P3: dosagem e dci MANUAIS (forma/embalagem vazias)
    // P4: já igual · P5: o INFARMED traz campos vazios · P6: não consta do ficheiro · P7: espaços e igual com espaços
    const p1 = await mk(5000001);
    const p2 = await mk(5000002, { formaFarmaceutica: "Cápsula (ERP)", dosagem: "500 mg", embalagem: "10 un", dci: "Metformin (erp)" });
    const p3 = await mk(5000003, { dosagem: "850 mg MANUAL", dci: "Nome comercial manual", camposManuais: ["dosagem", "dci"] });
    const p4 = await mk(5000004, { formaFarmaceutica: "Comprimido", dosagem: "1000 mg", embalagem: "18 unidade(s)", dci: "Metformina" });
    const p5 = await mk(5000005, { formaFarmaceutica: "Xarope", dosagem: "5 mg/ml", embalagem: "1 frasco", dci: "Dci antiga" });
    const p6 = await mk(5000006, { formaFarmaceutica: "Pomada" });
    const p7 = await mk(5000007, { dosagem: "  1000 mg  " });
    // P8: designação autoritativa (simulação): campos manuais só da designação — esta NUNCA é lida/escrita
    const p8 = await mk(5000008, { camposManuais: ["designacao"] });

    const designacoes = async () => (await prisma.$queryRaw<Array<{ h: string }>>`SELECT md5(string_agg(id || designacao, ';' ORDER BY id)) AS h FROM "Produto"`)[0].h;
    const hDesignacao = await designacoes();
    const manuais = async () => (await prisma.$queryRaw<Array<{ h: string }>>`SELECT md5(string_agg(id || array_to_string("camposManuais", ','), ';' ORDER BY id)) AS h FROM "Produto"`)[0].h;
    const hManuais = await manuais();
    const outros = async () => (await prisma.$queryRaw<Array<{ h: string }>>`SELECT md5(string_agg(concat_ws('|', id, "fabricanteId", "codigoATC", "flagGenerico", "classificacaoNivel1Id", "estado"), ';' ORDER BY id)) AS h FROM "Produto"`)[0].h;
    const hOutros = await outros();

    const buf1 = xls([
      linha("5000001"),
      linha("5000002", { dci: "Metformina", forma: "Comprimido", dos: "1000 mg", emb: "18 unidade(s)" }),
      linha("5000003", { dci: "Metformina", forma: "Comprimido", dos: "1000 mg", emb: "18 unidade(s)" }),
      linha("5000004"),
      linha("5000005", { dci: null, forma: null, dos: null, emb: null }),
      linha("5000007", { dos: "1000 mg" }),
      linha("5000008"),
      linha("5000099"),                                     // CNP sem produto neste tenant
    ]);
    const f1 = lerFicheiroInfarmed(buf1);

    secao("A · pré-visualização (dry-run) = o que a aplicação vai fazer");
    const dry = await aplicarVersaoInfarmed(prisma, f1, { origem: "MENSAL" });
    check(dry.resultado === "SIMULADA" && !!dry.reconciliacao, "o dry-run da importação traz os contadores da reconciliação");
    const antesDry = await prisma.produto.findUniqueOrThrow({ where: { cnp: 5000001 } });
    check(antesDry.formaFarmaceutica === null && antesDry.embalagem === null, "…sem escrever nada em Produto");
    check((await prisma.infarmedImportacao.count()) === 0, "…nem criar importações");

    secao("B · aplicação (download automático = origem MENSAL) reconcilia na mesma transação");
    const antes = await contagens(prisma);
    const r1 = await aplicarATenants(f1, [{ slug: "t", prisma }], { origem: "MENSAL", apply: true, nomeFicheiro: "a.xls" });
    check(r1[0].resultado === "APLICADA" && r1[0].reconciliacao?.produtosAlterados === dry.reconciliacao!.produtosAlterados, "a aplicação reporta o mesmo nº de produtos alterados que o dry-run previu");
    const g = (c: { campos: Record<string, { preenchidos: number; atualizados: number }> }) => JSON.stringify(Object.values(c.campos).map((x) => [x.preenchidos, x.atualizados]));
    check(g(r1[0].reconciliacao!) === g(dry.reconciliacao!), "…e os mesmos contadores por campo (previsão = resultado)");
    const c = r1[0].reconciliacao!;
    check(c.produtosAnalisados === 7 && c.produtosAssociados === 7, `analisados=${c.produtosAnalisados}, associados por CNP=${c.produtosAssociados}`);
    const get = (cnp: number) => prisma.produto.findUniqueOrThrow({ where: { cnp } });
    const a1 = await get(5000001);
    check(a1.formaFarmaceutica === "Comprimido" && a1.dosagem === "1000 mg" && a1.embalagem === "18 unidade(s)" && a1.dci === "Metformina", "P1 (vazio): forma, dosagem, embalagem e DCI PREENCHIDAS");
    const a2 = await get(5000002);
    check(a2.formaFarmaceutica === "Comprimido" && a2.dosagem === "1000 mg" && a2.embalagem === "18 unidade(s)" && a2.dci === "Metformina", "P2 (valores diferentes, não manuais): ATUALIZADOS");
    const a3 = await get(5000003);
    check(a3.dosagem === "850 mg MANUAL" && a3.dci === "Nome comercial manual", "P3: dosagem e DCI protegidas em camposManuais NÃO são substituídas");
    check(a3.formaFarmaceutica === "Comprimido" && a3.embalagem === "18 unidade(s)", "P3: os campos NÃO protegidos (forma, embalagem) são preenchidos — a proteção é campo a campo");
    check(JSON.stringify(a3.camposManuais) === JSON.stringify(["dosagem", "dci"]), "camposManuais não é alterado");
    const a5 = await get(5000005);
    check(a5.formaFarmaceutica === "Xarope" && a5.dosagem === "5 mg/ml" && a5.embalagem === "1 frasco" && a5.dci === "Dci antiga", "P5: o INFARMED vazio NUNCA apaga nem altera valores");
    check((await get(5000006)).formaFarmaceutica === "Pomada", "P6 (fora do ficheiro) intacto");
    check((await get(5000007)).dosagem === "  1000 mg  ", "P7: igual ao do INFARMED a menos de espaços — não é tocado (conta como «já igual»)");
    const dep = await contagens(prisma);
    check(await designacoes() === hDesignacao, "Produto.designacao — de TODOS os produtos — ficou exatamente igual (checksum)");
    check(await manuais() === hManuais && await outros() === hOutros, "camposManuais, fabricante, ATC, flagGenerico, classificação e estado: intactos");
    check(r1[0].ok && dep.checksumProdutos === antes.checksumProdutos && dep.checksumProdutosFarmacia === antes.checksumProdutosFarmacia && dep.checksumCamposReconciliados !== antes.checksumCamposReconciliados, "só os 4 campos mudaram (o checksum «operacional» é igual; o dos campos reconciliados mudou)");
    const f = c.campos;
    check(f.formaFarmaceutica.preenchidos === 4 && f.formaFarmaceutica.atualizados === 1 && f.formaFarmaceutica.jaIguais === 1 && f.formaFarmaceutica.ignoradosVazio === 1 && f.formaFarmaceutica.ignoradosManual === 0, `forma: ${JSON.stringify(f.formaFarmaceutica)}`);
    check(f.dosagem.preenchidos === 2 && f.dosagem.atualizados === 1 && f.dosagem.ignoradosManual === 1 && f.dosagem.ignoradosVazio === 1 && f.dosagem.jaIguais === 2, `dosagem: ${JSON.stringify(f.dosagem)}`);
    check(f.dci.ignoradosManual === 1 && f.dci.ignoradosVazio === 1 && f.dci.atualizados === 1, `dci: ${JSON.stringify(f.dci)}`);
    check(f.embalagem.ignoradosVazio === 1 && f.embalagem.atualizados === 1, `embalagem: ${JSON.stringify(f.embalagem)}`);
    const imp = await prisma.infarmedImportacao.findFirstOrThrow({ where: { ativa: true } });
    check(imp.cnpNaoEncontrados === 1 && (imp.relatorio as { reconciliacao?: unknown } | null)?.reconciliacao !== undefined, "o relatório da importação guarda os contadores; 1 CNP sem correspondência");

    secao("C · idempotência e comando de reconciliação da versão ativa");
    const estado0 = { sha: imp.sha256, id: imp.id, n: await prisma.infarmedImportacao.count(), regs: await prisma.produtoRegulamentar.count() };
    const seco = await rec.reconciliarVersaoAtiva(prisma, { apply: false });
    check(!!seco && seco.contadores.produtosAlterados === 0, "dry-run da reconciliação sobre a versão ativa: 0 alterações (já reconciliada)");
    const outra = await rec.reconciliarVersaoAtiva(prisma, { apply: true, registo: { operacaoId: "00000000-0000-4000-8000-000000000001", origem: "RECONCILIACAO_MANUAL", tenant: "t" } });
    check(!!outra && outra.contadores.produtosAlterados === 0 && outra.sha256 === estado0.sha && outra.importacaoId === estado0.id, "2.ª reconciliação (apply): 0 alterações, mesmo SHA, mesma versão");
    // o catálogo fica «atrasado» (alguém limpa a forma de P1 e P4 passa a manual) → a reconciliação repõe, só o permitido
    await prisma.produto.update({ where: { cnp: 5000001 }, data: { formaFarmaceutica: null, embalagem: "outro" } });
    await prisma.produto.update({ where: { cnp: 5000004 }, data: { dosagem: "valor errado", camposManuais: ["dosagem"] } });
    const prev = await rec.reconciliarVersaoAtiva(prisma, { apply: false });
    check(prev!.contadores.campos.formaFarmaceutica.preenchidos === 1 && prev!.contadores.campos.embalagem.atualizados === 1 && prev!.contadores.campos.dosagem.ignoradosManual >= 1, "dry-run prevê: P1 forma preenchida, P1 embalagem atualizada, P4 dosagem ignorada por proteção manual");
    check((await get(5000001)).formaFarmaceutica === null, "…e não escreveu nada");
    const real = await rec.reconciliarVersaoAtiva(prisma, { apply: true, registo: { operacaoId: "00000000-0000-4000-8000-000000000002", origem: "RECONCILIACAO_MANUAL", tenant: "t" } });
    check(real!.contadores.produtosAlterados === 1 && (await get(5000001)).formaFarmaceutica === "Comprimido" && (await get(5000001)).embalagem === "18 unidade(s)", "apply: P1 reposto");
    check((await get(5000004)).dosagem === "valor errado", "P4: valor manual divergente respeitado");
    check((await prisma.infarmedImportacao.count()) === estado0.n && (await prisma.produtoRegulamentar.count()) === estado0.regs, "nenhuma importação fictícia, nenhum registo regulamentar novo");
    check((await prisma.infarmedImportacao.findFirstOrThrow({ where: { ativa: true } })).id === estado0.id && (await designacoes()) === hDesignacao, "a versão ativa é a mesma e a designação continua intacta");

    secao("D · o upload manual e a mesma versão usam o mesmo motor");
    const buf2 = xls([linha("5000001", { forma: "Comprimido revestido" }), linha("5000002")]);
    const r2 = await aplicarATenants(lerFicheiroInfarmed(buf2), [{ slug: "t", prisma }], { origem: "UPLOAD_MANUAL", apply: true, utilizadorEmail: "admin@x.pt", nomeFicheiro: "novo.xls" });
    check(r2[0].resultado === "APLICADA" && r2[0].reconciliacao!.campos.formaFarmaceutica.atualizados === 1, "versão nova (upload): a forma de P1 é ATUALIZADA (valor do INFARMED mudou)");
    check((await get(5000001)).formaFarmaceutica === "Comprimido revestido", "P1 com a forma nova");
    check((await prisma.infarmedImportacao.findFirstOrThrow({ where: { ativa: true } })).origem === "UPLOAD_MANUAL", "origem UPLOAD_MANUAL");
    const r3 = await aplicarATenants(lerFicheiroInfarmed(buf2), [{ slug: "t", prisma }], { origem: "UPLOAD_MANUAL", apply: true });
    check(r3[0].resultado === "JA_PROCESSADA" && r3[0].reconciliacao?.produtosAlterados === 0, "o mesmo ficheiro outra vez: JA_PROCESSADA, nada alterado (a reconciliação corre mas é idempotente)");
    // versão com CNP ausente: linhas presenteNoFicheiro=false não escrevem no catálogo
    const buf3 = xls([linha("5000002", { forma: "Solução" })]);
    await aplicarATenants(lerFicheiroInfarmed(buf3), [{ slug: "t", prisma }], { origem: "MENSAL", apply: true });
    check((await get(5000001)).formaFarmaceutica === "Comprimido revestido", "P1 deixou de constar do ficheiro: o catálogo NÃO é tocado (linha «presenteNoFicheiro=false» ignorada)");
    check((await get(5000002)).formaFarmaceutica === "Solução", "P2 (presente) atualizado");

    secao("E · comando (CLI): dry-run por omissão e --apply");
    const cli = (extra: string[]) => spawnSync("npx", ["tsx", "scripts/ops/infarmed-carga-regulamentar.ts", "--reconciliar", `--database-url=${urlDe(db)}`, `--relatorio-dir=${require("node:os").tmpdir()}`, ...extra], { encoding: "utf8", shell: process.platform === "win32" });
    await prisma.produto.update({ where: { cnp: 5000002 }, data: { formaFarmaceutica: null } });
    const sec = cli([]);
    check(sec.status === 0 && /DRY-RUN/.test(sec.stdout) && /formaFarmaceutica\s+preenchidos 1/.test(sec.stdout), "CLI dry-run imprime os contadores por campo");
    check((await get(5000002)).formaFarmaceutica === null, "…e não escreveu");
    const apl = cli(["--apply"]);
    check(apl.status === 0 && /APPLY/.test(apl.stdout) && (await get(5000002)).formaFarmaceutica === "Solução", "CLI --apply reconcilia");
    check(/ignorados \(manual\)/.test(apl.stdout) && /sem correspondência/.test(apl.stdout), "o relatório mostra ignorados por proteção manual e produtos sem correspondência");

    secao("F · desempenho (set-based): 8 000 produtos");
    const grande = 8000;
    await prisma.produto.createMany({ data: Array.from({ length: grande }, (_, i) => ({ cnp: 6000000 + i, designacao: `GRANDE ${i}` })) });
    const bufG = xls(Array.from({ length: grande }, (_, i) => linha(String(6000000 + i), { dos: `${i} mg` })));
    const t0 = Date.now();
    const rg = await aplicarATenants(lerFicheiroInfarmed(bufG), [{ slug: "t", prisma }], { origem: "MENSAL", apply: true });
    const ms = Date.now() - t0;
    check(rg[0].resultado === "APLICADA" && rg[0].reconciliacao!.campos.dosagem.preenchidos === grande, `${grande} produtos reconciliados numa só instrução em ${ms} ms`);
    check(ms < 30000, "dentro de um orçamento razoável (< 30 s)");

    void [p1, p2, p3, p4, p5, p6, p7, p8];
    await prisma.$disconnect();
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => undefined);
    await admin.end();
  }
  console.log(`\n${passed} OK, ${failed} falhas`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
