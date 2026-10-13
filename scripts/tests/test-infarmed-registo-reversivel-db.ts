/**
 * scripts/tests/test-infarmed-registo-reversivel-db.ts
 *
 * Registo reversível DURÁVEL (AuditLog do tenant) das três vias que escrevem em
 * Produto.formaFarmaceutica/dosagem/embalagem/dci — contra PostgreSQL REAL e DESCARTÁVEL:
 *
 *   docker run -d --name spharm-mg-pg -e POSTGRES_PASSWORD=test -p 15433:5432 postgres:16-alpine
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres npx tsx scripts/tests/test-infarmed-registo-reversivel-db.ts
 *
 * Testa só o que é novo: download automático e upload manual criam registo; falha ao guardar
 * impede a confirmação; sem alterações não há relatório; o relatório das três vias é aceite pelo
 * MESMO comando de reversão; compare-and-set; designação intacta; listagem e download (admin).
 */
import Module from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
const linha = (reg: string, o: { dci?: Cel; forma?: Cel; dos?: Cel; emb?: Cel } = {}): Cel[] => [
  reg, "dci" in o ? o.dci! : "Metformina", "Glucophage", "forma" in o ? o.forma! : "Comprimido",
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
  const { aplicarATenants } = await import("../../lib/regulamentar/infarmed-atualizacao");
  const reg = await import("../../lib/regulamentar/infarmed-registo");
  const rev = await import("../../lib/regulamentar/infarmed-reverter");
  const adm = await import("../../lib/regulamentar/infarmed-admin");

  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const sufixo = Date.now().toString(36);
  const dbs = { a: `spharm_rr_a_${sufixo}`, b: `spharm_rr_b_${sufixo}` };
  for (const d of Object.values(dbs)) await admin.query(`CREATE DATABASE ${d}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spharm-rr-"));
  try {
    for (const d of Object.values(dbs)) execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: urlDe(d) }, encoding: "utf8" });
    const mkPrisma = (d: string) => new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(d) }) });
    const A = mkPrisma(dbs.a);
    const B = mkPrisma(dbs.b);

    const semear = async (p: InstanceType<typeof PrismaClient>) => {
      for (let i = 1; i <= 4; i++) {
        await p.produto.upsert({
          where: { cnp: 5100000 + i }, update: { formaFarmaceutica: i === 2 ? "Cápsula (ERP)" : null, dosagem: i === 2 ? "500 mg" : null, embalagem: null, dci: null },
          create: { cnp: 5100000 + i, designacao: `DESIGNACAO ERP ${i}`, ...(i === 2 ? { formaFarmaceutica: "Cápsula (ERP)", dosagem: "500 mg" } : {}) },
        });
      }
    };
    await semear(A);
    await semear(B);
    const quatro = async (p: InstanceType<typeof PrismaClient>) =>
      JSON.stringify(await p.$queryRawUnsafe(`SELECT cnp, "formaFarmaceutica", "dosagem", "embalagem", "dci" FROM "Produto" ORDER BY cnp`));
    const designacoes = async (p: InstanceType<typeof PrismaClient>) =>
      (await p.$queryRaw<Array<{ h: string }>>`SELECT md5(string_agg(id || designacao, ';' ORDER BY id)) AS h FROM "Produto"`)[0].h;
    const nRegistos = (p: InstanceType<typeof PrismaClient>) => p.auditLog.count({ where: { action: reg.ACAO_RECONCILIACAO } });
    const hDesA = await designacoes(A);
    const hDesB = await designacoes(B);

    const ficheiro1 = lerFicheiroInfarmed(xls([1, 2, 3, 4].map((i) => linha(String(5100000 + i)))));

    // ═══ 1 · download automático (origem MENSAL) ═══
    secao("1 · download automático com alterações cria o registo reversível (um por tenant, mesma operação)");
    const r1 = await aplicarATenants(ficheiro1, [{ slug: "a", prisma: A }, { slug: "b", prisma: B }], { origem: "MENSAL", apply: true });
    check(r1.every((t) => t.resultado === "APLICADA"), "aplicada nos dois tenants");
    const op1 = r1[0].reconciliacao?.registoReversivel?.operacaoId;
    check(!!op1 && r1[1].reconciliacao?.registoReversivel?.operacaoId === op1, "a mesma operacaoId em todos os tenants da execução");
    check(r1[0].reconciliacao?.registoReversivel?.origem === "DOWNLOAD_AUTOMATICO", "origem DOWNLOAD_AUTOMATICO");
    check((await nRegistos(A)) === 1 && (await nRegistos(B)) === 1, "uma linha de AuditLog por tenant");
    const linhaA = await A.auditLog.findFirstOrThrow({ where: { action: reg.ACAO_RECONCILIACAO } });
    const gA = JSON.parse(linhaA.metaJson!) as import("../../lib/regulamentar/infarmed-registo").RegistoGravado;
    check(linhaA.entityId === op1 && gA.tenant === "a" && gA.utilizadorEmail === null && !!gA.data && gA.formato === "infarmed-reconciliacao/v1", "registo: operação, tenant, utilizador (null no automático), data, formato");
    const contA = r1[0].reconciliacao!;
    const nCampos = Object.values(contA.campos).reduce((t, c) => t + c.preenchidos + c.atualizados, 0);
    check(gA.campos === nCampos && gA.alteracoes.length === nCampos && nCampos >= 10, `campo a campo: ${gA.alteracoes.length} alterações = contadores (${nCampos})`);
    const alt2 = gA.alteracoes.find((x) => x.cnp === 5100002 && x.campo === "dosagem");
    check(alt2?.anterior === "500 mg" && alt2.aplicado === "1000 mg" && alt2.tipo === "ATUALIZACAO", "valor anterior e aplicado (atualização)");
    check(gA.alteracoes.find((x) => x.cnp === 5100001 && x.campo === "dci")?.anterior === null, "valor anterior null (preenchimento)");
    check(JSON.stringify(r1[0]).includes("alteracoes\":[{") === false, "o resumo do ledger (ResultadoTenant) não leva as alterações detalhadas");
    const imp = await A.infarmedImportacao.findFirstOrThrow({ where: { ativa: true } });
    check(!JSON.stringify(imp.relatorio).includes("\"anterior\""), "o relatório da importação também não");
    const rel1 = await reg.obterRelatorio([{ slug: "a", prisma: A }, { slug: "b", prisma: B }], op1!);
    check(!!rel1 && rel1.tenants.length === 2 && rel1.origem === "DOWNLOAD_AUTOMATICO" && rel1.formato === "infarmed-reconciliacao/v1", "o relatório reconstruído tem os 2 tenants e passa a validação do comando de reversão");
    check(!!rel1 && rev.validarRelatorio(JSON.parse(JSON.stringify(rel1))).operacaoId === op1, "…validarRelatorio (a do CLI) aceita-o");

    // ═══ 2 · sem alterações: sem relatório ═══
    secao("2 · operação sem alterações não cria relatório vazio");
    const antes2 = (await nRegistos(A)) + (await nRegistos(B));
    const r2 = await aplicarATenants(ficheiro1, [{ slug: "a", prisma: A }, { slug: "b", prisma: B }], { origem: "MENSAL", apply: true });
    check(r2.every((t) => t.resultado === "JA_PROCESSADA"), "versão já processada");
    check((await nRegistos(A)) + (await nRegistos(B)) === antes2, "…sem novo registo");
    // nova versão do ficheiro SEM diferenças nos 4 campos (só muda o nome do medicamento) → aplica, mas não há alterações ao catálogo
    const f2 = lerFicheiroInfarmed(xls([1, 2, 3, 4].map((i) => { const l = linha(String(5100000 + i)); l[2] = "Outro nome comercial"; return l; })));
    const r2b = await aplicarATenants(f2, [{ slug: "a", prisma: A }], { origem: "MENSAL", apply: true });
    check(r2b[0].resultado === "APLICADA" && (r2b[0].reconciliacao?.produtosAlterados ?? 0) === 0 && r2b[0].reconciliacao?.registoReversivel === null, "versão nova aplicada sem alterações ao catálogo: registoReversivel = null");
    check((await nRegistos(A)) === 1, "…nenhum relatório vazio");

    // ═══ 3 · falha ao guardar o registo ═══
    secao("3 · falha ao guardar o registo reversível impede a confirmação (e não afeta os outros tenants)");
    await semear(A);
    await semear(B);
    await A.$executeRawUnsafe(`UPDATE "Produto" SET "formaFarmaceutica" = NULL, "dosagem" = NULL WHERE cnp = 5100002`);
    await B.$executeRawUnsafe(`UPDATE "Produto" SET "formaFarmaceutica" = NULL, "dosagem" = NULL WHERE cnp = 5100002`);
    await A.$executeRawUnsafe(`CREATE FUNCTION falha_registo() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'falha simulada do registo'; END $$ LANGUAGE plpgsql`);
    await A.$executeRawUnsafe(`CREATE TRIGGER t_falha BEFORE INSERT ON "AuditLog" FOR EACH ROW WHEN (NEW.action = 'INFARMED_RECONCILIACAO') EXECUTE FUNCTION falha_registo()`);
    const f3 = lerFicheiroInfarmed(xls([1, 2, 3, 4].map((i) => linha(String(5100000 + i), { dos: "250 mg" }))));
    const antesA3 = await quatro(A);
    const nAntesA = await nRegistos(A);
    const nAntesB = await nRegistos(B);
    const versaoAntesA = (await A.infarmedImportacao.findFirstOrThrow({ where: { ativa: true } })).id;
    const r3 = await aplicarATenants(f3, [{ slug: "a", prisma: A }, { slug: "b", prisma: B }], { origem: "UPLOAD_MANUAL", apply: true, utilizadorEmail: "admin@spharm.test", nomeFicheiro: "x.xls" });
    check(r3[0].resultado === "FALHADA" && !r3[0].ok && /registo reversível/i.test(r3[0].motivo ?? ""), `tenant A falha com a razão explícita («${(r3[0].motivo ?? "").slice(0, 90)}…»)`);
    check(await quatro(A) === antesA3, "tenant A: nenhuma alteração ao catálogo foi confirmada");
    check((await A.infarmedImportacao.findFirstOrThrow({ where: { ativa: true } })).id === versaoAntesA, "tenant A: a versão ativa não mudou");
    check((await nRegistos(A)) === nAntesA, "tenant A: nenhum registo parcial");
    check(r3[1].resultado === "APLICADA" && (await nRegistos(B)) === nAntesB + 1, "tenant B (concluído) tem o seu registo — a falha de A não o apaga nem o impede");
    check((await B.auditLog.count({ where: { action: reg.ACAO_RECONCILIACAO } })) === 2, "os registos anteriores do tenant B continuam lá");
    await A.$executeRawUnsafe(`DROP TRIGGER t_falha ON "AuditLog"`);
    // O alerta mensal usa `${slug}: ${motivo}` do ResultadoTenant → o motivo tem de dizer que foi o registo.
    check(/Falha ao guardar o registo reversível/.test(r3[0].motivo ?? ""), "o motivo (que o alerta mensal e o ecrã de upload mostram) menciona o registo reversível");

    // ═══ 4 · upload manual com alterações ═══
    secao("4 · upload manual com alterações cria o registo reversível (com o utilizador)");
    const opB3 = r3[1].reconciliacao?.registoReversivel?.operacaoId;
    check(!!opB3 && r3[1].reconciliacao?.registoReversivel?.origem === "UPLOAD_MANUAL", "B: origem UPLOAD_MANUAL");
    const gB = JSON.parse((await B.auditLog.findFirstOrThrow({ where: { action: reg.ACAO_RECONCILIACAO, entityId: opB3 } })).metaJson!) as import("../../lib/regulamentar/infarmed-registo").RegistoGravado;
    check(gB.utilizadorEmail === "admin@spharm.test" && gB.tenant === "b", "…com o email de quem carregou");
    // repetição do upload só em A (sem o trigger) → A fica com o seu registo (mesma origem)
    const r4 = await aplicarATenants(f3, [{ slug: "a", prisma: A }], { origem: "UPLOAD_MANUAL", apply: true, utilizadorEmail: "admin@spharm.test", nomeFicheiro: "x.xls" });
    check(r4[0].resultado === "APLICADA" && (r4[0].reconciliacao?.registoReversivel?.campos ?? 0) > 0, "A: repetido sem a falha, aplica e regista");

    // ═══ 5 · mesma ferramenta de reversão, para as três origens ═══
    secao("5 · o relatório das três vias é aceite pelo MESMO comando de reversão");
    // (a) reconciliação manual por CLI — base «local» = A, recriada com alterações pendentes
    await semear(A);
    await A.$executeRawUnsafe(`UPDATE "Produto" SET "dosagem" = NULL WHERE cnp = 5100002`);
    const cli = (args: string[]) => spawnSync("npx", ["tsx", "scripts/ops/infarmed-carga-regulamentar.ts", `--database-url=${urlDe(dbs.a)}`, `--relatorio-dir=${dir}`, ...args], { encoding: "utf8", shell: process.platform === "win32" });
    // a versão ativa de A (f3: 250 mg): a reconciliação CLI tem de ter algo para fazer
    const antesCli = await quatro(A);
    const apl = cli(["--reconciliar", "--apply"]);
    check(apl.status === 0 && /relatório REVERSÍVEL/.test(apl.stdout), `CLI --reconciliar --apply${apl.status === 0 ? "" : ` (${(apl.stdout + apl.stderr).slice(-300)})`}`);
    const fich = fs.readdirSync(dir).filter((f) => /^reconciliacao-[0-9a-f-]{36}\.json$/.test(f));
    const opCli = fich[0]?.slice("reconciliacao-".length, -".json".length);
    check(!!opCli && (await A.auditLog.count({ where: { action: reg.ACAO_RECONCILIACAO, entityId: opCli } })) === 1, "a CLI grava TAMBÉM o registo durável na base (não só o ficheiro)");
    const gCli = JSON.parse((await A.auditLog.findFirstOrThrow({ where: { entityId: opCli, action: reg.ACAO_RECONCILIACAO } })).metaJson!) as import("../../lib/regulamentar/infarmed-registo").RegistoGravado;
    check(gCli.origem === "RECONCILIACAO_MANUAL", "origem RECONCILIACAO_MANUAL");
    const ls = cli(["--listar-reconciliacoes"]);
    check(ls.status === 0 && ls.stdout.includes(opCli!) && /RECONCILIACAO_MANUAL/.test(ls.stdout) && /UPLOAD_MANUAL/.test(ls.stdout) && /DOWNLOAD_AUTOMATICO/.test(ls.stdout), "--listar-reconciliacoes mostra as 3 origens");
    fs.rmSync(path.join(dir, fich[0]));
    const ex = cli([`--exportar-reconciliacao=${opCli}`]);
    check(ex.status === 0 && fs.existsSync(path.join(dir, `reconciliacao-${opCli}.json`)), "--exportar-reconciliacao regenera o ficheiro a partir da base");
    const exportado = JSON.parse(fs.readFileSync(path.join(dir, `reconciliacao-${opCli}.json`), "utf8"));
    check(exportado.tenants[0].integridade === gCli.integridade, "…com a mesma soma de integridade");
    const rv = cli([`--reverter-reconciliacao=${path.join(dir, `reconciliacao-${opCli}.json`)}`, "--apply"]);
    check(rv.status === 0 && /APPLY/.test(rv.stdout), `CLI --reverter-reconciliacao --apply aceita o relatório exportado${rv.status === 0 ? "" : ` (${(rv.stdout + rv.stderr).slice(-300)})`}`);
    check(await quatro(A) === antesCli, "reconciliação manual: valores anteriores repostos EXATAMENTE");
    check((await A.auditLog.count({ where: { action: rev.ACAO_REVERTIDA, entityId: opCli } })) === 1, "a reversão fica marcada na base");

    // (b) download automático (op1) — A e B, repor o estado inicial anterior
    const relMensal = (await reg.obterRelatorio([{ slug: "a", prisma: A }, { slug: "b", prisma: B }], op1!))!;
    // entretanto os tenants evoluíram (passos 3–4): o compare-and-set protege o que mudou depois.
    const dosA2 = (await A.produto.findUniqueOrThrow({ where: { cnp: 5100002 } })).dosagem;
    const rMensalA = await rev.reverterReconciliacaoTenant(A, relMensal.tenants.find((t) => t.tenant === "a")!, { apply: false });
    check(rMensalA.revertidas === 0 && rMensalA.conflitos.length > 0, `compare-and-set: o que mudou depois (${dosA2}) é conflito, nada é revertido por engano (${rMensalA.conflitos.length} conflitos)`);
    // para provar a reversão exata do download automático, usa-se um tenant novo e limpo
    const mensalNovo = await (async () => {
      const dbC = `spharm_rr_c_${sufixo}`;
      await admin.query(`CREATE DATABASE ${dbC}`);
      execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: urlDe(dbC) }, encoding: "utf8" });
      const C = mkPrisma(dbC);
      await semear(C);
      const hDes = await designacoes(C);
      const antes = await quatro(C);
      const f = lerFicheiroInfarmed(xls([1, 2, 3, 4].map((i) => linha(String(5100000 + i), { dci: "Outra DCI" }))));
      const rM = await aplicarATenants(f, [{ slug: "c", prisma: C }], { origem: "MENSAL", apply: true });
      const opM = rM[0].reconciliacao!.registoReversivel!.operacaoId;
      const depois = await quatro(C);
      // edição posterior: compare-and-set
      await C.produto.update({ where: { cnp: 5100003 }, data: { dci: "EDITADO DEPOIS" } });
      const relM = (await reg.obterRelatorio([{ slug: "c", prisma: C }], opM))!;
      const seco = await rev.reverterReconciliacaoTenant(C, relM.tenants[0], { apply: false, operacaoId: opM });
      check(await quatro(C) !== antes && seco.revertidas > 0, "download automático: o dry-run da reversão não escreve");
      const feita = await rev.reverterReconciliacaoTenant(C, relM.tenants[0], { apply: true, operacaoId: opM });
      const restantes = JSON.parse(await quatro(C)) as Array<{ cnp: number; dci: string | null }>;
      const esperado = JSON.parse(antes) as Array<{ cnp: number; dci: string | null }>;
      const semEditado = (l: Array<{ cnp: number; dci: string | null }>) => JSON.stringify(l.filter((x) => x.cnp !== 5100003));
      check(semEditado(restantes) === semEditado(esperado), "download automático: valores anteriores repostos exatamente (exceto o editado depois)");
      check(restantes.find((x) => x.cnp === 5100003)!.dci === "EDITADO DEPOIS" && feita.conflitos.some((c) => c.motivo === "VALOR_ALTERADO_DEPOIS"), "…a edição posterior sobrevive (compare-and-set) e fica listada como conflito");
      check(await designacoes(C) === hDes, "Produto.designacao intacta");
      const ops = await reg.listarOperacoes([{ slug: "c", prisma: C }]);
      check(ops.length === 1 && ops[0].estado === "REVERTIDA" && ops[0].origem === "DOWNLOAD_AUTOMATICO" && ops[0].campos > 0, "listagem: origem, campos alterados e estado «REVERTIDA»");
      void depois;
      await C.$disconnect();
      await admin.query(`DROP DATABASE IF EXISTS ${dbC} WITH (FORCE)`);
      return opM;
    })();
    void mensalNovo;

    // (c) upload manual (B, opB3): reversão com o relatório obtido da base
    const relUp = (await reg.obterRelatorio([{ slug: "b", prisma: B }], opB3!))!;
    check(relUp.origem === "UPLOAD_MANUAL" && relUp.tenants[0].utilizadorEmail === "admin@spharm.test", "upload manual: o relatório indica origem e utilizador");
    const antesRevB = await quatro(B);
    const dryUp = await rev.reverterReconciliacaoTenant(B, relUp.tenants[0], { apply: false });
    check(dryUp.revertidas > 0 && (await quatro(B)) === antesRevB, "upload manual: dry-run da reversão sem escritas");
    const feitaUp = await rev.reverterReconciliacaoTenant(B, relUp.tenants[0], { apply: true, operacaoId: opB3 });
    check(feitaUp.revertidas === dryUp.revertidas && (await quatro(B)) !== antesRevB, "upload manual: reversão real aceite pelo mesmo comando");
    check(await designacoes(B) === hDesB && await designacoes(A) === hDesA, "Produto.designacao permanece intacta em todos os tenants");
    const outra = await rev.reverterReconciliacaoTenant(B, relUp.tenants[0], { apply: true, operacaoId: opB3 });
    check(outra.revertidas === 0, "idempotente: repetir não reverte nada");

    // ═══ 6 · admin: listagem e download ═══
    secao("6 · /admin/infarmed: listagem e obtenção do relatório (só platform admins)");
    process.env.PLATFORM_ADMIN_EMAILS = "admin@spharm.test";
    const sessAdmin = { sub: "u1", email: "admin@spharm.test", nome: "Admin", perfil: "ADMINISTRADOR", farmaciaId: null, tenant: "__legacy__" } as never;
    const sessComum = { sub: "u2", email: "gestor@spharm.test", nome: "G", perfil: "GESTOR_FARMACIA", farmaciaId: null, tenant: "a" } as never;
    const deps = { tenants: async () => [{ slug: "a", prisma: A }, { slug: "b", prisma: B }] } as never;
    const ops = await reg.listarOperacoes([{ slug: "a", prisma: A }, { slug: "b", prisma: B }]);
    const origens = new Set(ops.map((o) => o.origem));
    check(origens.has("DOWNLOAD_AUTOMATICO") && origens.has("UPLOAD_MANUAL") && origens.has("RECONCILIACAO_MANUAL"), "a lista inclui as três origens");
    const o1 = ops.find((o) => o.operacaoId === op1)!;
    check(o1.tenants.length === 2 && o1.campos > 0 && !!o1.data && o1.estado === "APLICADA", "linha: data, origem, tenants, campos alterados, identificador e estado");
    check((await adm.acaoObterRelatorioReconciliacao(deps, null, op1!)).ok === false, "sem sessão: recusado");
    const rComum = await adm.acaoObterRelatorioReconciliacao(deps, sessComum, op1!);
    check(!rComum.ok && rComum.codigo === "NAO_AUTORIZADO", "utilizador comum: recusado");
    const rInv = await adm.acaoObterRelatorioReconciliacao(deps, sessAdmin, "../etc/passwd");
    check(!rInv.ok && rInv.codigo === "INVALIDO", "identificador inválido: recusado");
    const rNe = await adm.acaoObterRelatorioReconciliacao(deps, sessAdmin, "00000000-0000-4000-8000-0000000000ff");
    check(!rNe.ok && rNe.codigo === "NAO_ENCONTRADO", "operação inexistente: 404");
    const rOk = await adm.acaoObterRelatorioReconciliacao(deps, sessAdmin, op1!);
    check(rOk.ok && rOk.relatorio.operacaoId === op1 && rOk.relatorio.tenants.length === 2, "platform admin obtém o relatório completo");
    // integridade: um registo corrompido não é entregue
    await B.$executeRawUnsafe(`UPDATE "AuditLog" SET "metaJson" = replace("metaJson", '"aplicado":"1000 mg"', '"aplicado":"9999 mg"') WHERE "entityId" = '${op1}'`);
    const rCorr = await adm.acaoObterRelatorioReconciliacao(deps, sessAdmin, op1!);
    check(!rCorr.ok && /corrompido|integridade/i.test(rCorr.erro), "registo corrompido: o download recusa (soma de integridade)");

    await A.$disconnect();
    await B.$disconnect();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    for (const d of Object.values(dbs)) await admin.query(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`).catch(() => undefined);
    await admin.end();
  }
  console.log(`\n${passed} OK, ${failed} falhas`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
