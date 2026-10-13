/**
 * scripts/tests/test-infarmed-reverter-db.ts
 *
 * Reversão operacional da reconciliação do catálogo — contra PostgreSQL REAL e DESCARTÁVEL:
 *
 *   docker run -d --name spharm-mg-pg -e POSTGRES_PASSWORD=test -p 15433:5432 postgres:16-alpine
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres npx tsx scripts/tests/test-infarmed-reverter-db.ts
 *
 * Usa o CLI real (`ops:infarmed-carga`) para `--reconciliar --apply` e `--reverter-reconciliacao`.
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

  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  const db = `spharm_rev_${Date.now().toString(36)}`;
  await admin.query(`CREATE DATABASE ${db}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spharm-rev-"));
  try {
    execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: urlDe(db) }, encoding: "utf8" });
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(db) }) });
    const cli = (args: string[], relDir = dir) =>
      spawnSync("npx", ["tsx", "scripts/ops/infarmed-carga-regulamentar.ts", `--database-url=${urlDe(db)}`, `--relatorio-dir=${relDir}`, ...args], { encoding: "utf8", shell: process.platform === "win32" });

    const mk = (cnp: number, extra: Record<string, unknown> = {}) => prisma.produto.create({ data: { cnp, designacao: `DESIGNACAO ERP ${cnp}`, ...extra } });
    const estadoInicial: Record<number, Record<string, unknown>> = {
      6000001: {},                                                                                                   // tudo vazio
      6000002: { formaFarmaceutica: "Cápsula (ERP)", dosagem: "500 mg", embalagem: "10 un", dci: "Metformin (erp)" }, // diferentes
      6000003: { dosagem: "850 mg MANUAL", camposManuais: ["dosagem"] },                                             // manual
      6000004: { formaFarmaceutica: "", dosagem: " " },                                                              // strings vazias/espaços
      6000005: { formaFarmaceutica: "Comprimido", dosagem: "1000 mg", embalagem: "18 unidade(s)", dci: "Metformina" }, // já igual
      6000006: { formaFarmaceutica: "Xarope" },                                                                      // fora do ficheiro
    };
    for (const [cnp, extra] of Object.entries(estadoInicial)) await mk(Number(cnp), extra);

    const camposSql = `id, cnp, "formaFarmaceutica", "dosagem", "embalagem", "dci", "camposManuais"`;
    const quatro = async () => (await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`SELECT ${camposSql} FROM "Produto" ORDER BY cnp`));
    const designacoes = async () => (await prisma.$queryRaw<Array<{ h: string }>>`SELECT md5(string_agg(id || designacao, ';' ORDER BY id)) AS h FROM "Produto"`)[0].h;
    const outros = async () => (await prisma.$queryRaw<Array<{ h: string }>>`SELECT md5(string_agg(concat_ws('|', id, "fabricanteId", "codigoATC", "flagGenerico", "estado"), ';' ORDER BY id)) AS h FROM "Produto"`)[0].h;
    const hDes = await designacoes();
    const hOut = await outros();

    // Versão ativa SEM reconciliar os produtos (repõe-se o estado inicial a seguir à importação).
    const buf = xls([linha("6000001"), linha("6000002"), linha("6000003"), linha("6000004"), linha("6000005")]);
    const ap = await aplicarATenants(lerFicheiroInfarmed(buf), [{ slug: "t", prisma }], { origem: "MENSAL", apply: true, nomeFicheiro: "a.xls" });
    check(ap[0].resultado === "APLICADA", "versão ativa criada");
    for (const [cnp, extra] of Object.entries(estadoInicial)) {
      await prisma.produto.update({ where: { cnp: Number(cnp) }, data: { formaFarmaceutica: null, dosagem: null, embalagem: null, dci: null, camposManuais: [], ...extra } });
    }
    const antes = await quatro();

    secao("A · dry-run da reconciliação não grava relatório reversível");
    const dry = cli(["--reconciliar"]);
    check(dry.status === 0 && /DRY-RUN/.test(dry.stdout), "CLI dry-run corre");
    check(!fs.readdirSync(dir).some((f) => f.startsWith("reconciliacao-")), "…e não cria reconciliacao-<id>.json");
    check(JSON.stringify(await quatro()) === JSON.stringify(antes), "…nem altera produtos");

    secao("B · --apply grava o relatório reversível com os valores anteriores");
    const apl = cli(["--reconciliar", "--apply"]);
    check(apl.status === 0 && /relatório REVERSÍVEL/.test(apl.stdout), `CLI --apply corre${apl.status === 0 ? "" : ` (${apl.stderr.slice(0, 300)})`}`);
    const ficheiros = fs.readdirSync(dir).filter((f) => /^reconciliacao-[0-9a-f-]{36}\.json$/.test(f));
    check(ficheiros.length === 1, "existe exatamente um reconciliacao-<id>.json");
    const caminho = path.join(dir, ficheiros[0]);
    const rel = JSON.parse(fs.readFileSync(caminho, "utf8"));
    const alts = rel.tenants?.[0]?.alteracoes ?? [];
    check(rel.formato === "infarmed-reconciliacao/v1" && rel.modo === "APPLY" && !!rel.operacaoId && rel.tenants[0].estado === "CONFIRMADO", "formato, modo, operacaoId e estado CONFIRMADO");
    const a = alts.find((x: { cnp: number; campo: string }) => x.cnp === 6000002 && x.campo === "dosagem");
    check(!!a && a.anterior === "500 mg" && a.aplicado === "1000 mg" && a.tipo === "ATUALIZACAO" && a.tenant === "local" && a.operacaoId === rel.operacaoId && typeof a.produtoId === "string" && !!a.data, "atualização: tenant, id, CNP, campo, anterior, aplicado, tipo, data e operação");
    const b = alts.find((x: { cnp: number; campo: string }) => x.cnp === 6000001 && x.campo === "dci");
    check(!!b && b.anterior === null && b.tipo === "PREENCHIMENTO", "preenchimento: valor anterior = null");
    const c = alts.find((x: { cnp: number; campo: string }) => x.cnp === 6000004 && x.campo === "formaFarmaceutica");
    check(!!c && c.anterior === "" && c.tipo === "PREENCHIMENTO", "o valor anterior guarda a string vazia EXATA (não a normaliza para null)");
    check(!alts.some((x: { cnp: number; campo: string }) => x.cnp === 6000003 && x.campo === "dosagem") && !alts.some((x: { cnp: number }) => x.cnp === 6000005), "campo manual e produto já igual não constam do relatório");
    check(alts.every((x: Record<string, unknown>) => Object.keys(x).sort().join() === "anterior,aplicado,campo,cnp,data,operacaoId,produtoId,tenant,tipo"), "só os campos necessários (nada mais do produto)");
    const depois = await quatro();
    check(JSON.stringify(depois) !== JSON.stringify(antes), "a reconciliação alterou o catálogo");

    secao("C · falha ao gravar o relatório anula a reconciliação (nunca fica algo sem possibilidade de reversão)");
    await prisma.produto.update({ where: { cnp: 6000001 }, data: { dci: null } });
    const snapC = await quatro();
    const ficheiroNoLugarDaPasta = path.join(dir, "e-um-ficheiro");
    fs.writeFileSync(ficheiroNoLugarDaPasta, "x");
    const falha = cli(["--reconciliar", "--apply"], ficheiroNoLugarDaPasta);
    check(falha.status !== 0, "CLI termina com erro");
    check(JSON.stringify(await quatro()) === JSON.stringify(snapC), "…e nada foi gravado em Produto");
    await prisma.produto.update({ where: { cnp: 6000001 }, data: { dci: "Metformina" } });

    secao("D · ficheiro adulterado ou de outro tipo é recusado sem tocar na base");
    const adulterado = JSON.parse(JSON.stringify(rel));
    adulterado.tenants[0].alteracoes[0].anterior = "VALOR INVENTADO";
    const pAdult = path.join(dir, "reconciliacao-adulterado.json");
    fs.writeFileSync(pAdult, JSON.stringify(adulterado));
    const ra = cli([`--reverter-reconciliacao=${pAdult}`, "--apply"]);
    check(ra.status !== 0 && /adulterado|integridade/i.test(ra.stdout + ra.stderr), "integridade falha ⇒ recusado");
    const pResumo = fs.readdirSync(dir).find((f) => f.startsWith("infarmed-reconciliacao-"))!;
    const rb = cli([`--reverter-reconciliacao=${path.join(dir, pResumo)}`]);
    check(rb.status !== 0 && /formato/i.test(rb.stdout + rb.stderr), "relatório-resumo (sem alterações detalhadas) é recusado");
    check(JSON.stringify(await quatro()) === JSON.stringify(depois), "…nada alterado");

    secao("E · dry-run da reversão não escreve");
    const rd = cli([`--reverter-reconciliacao=${caminho}`]);
    check(rd.status === 0 && /DRY-RUN/.test(rd.stdout) && /Nada foi alterado/.test(rd.stdout), "CLI dry-run da reversão");
    check(JSON.stringify(await quatro()) === JSON.stringify(depois), "…nenhum produto alterado");

    secao("F · reversão real: repõe exatamente; edições posteriores e campos protegidos não se perdem");
    // Edição manual posterior (conflito) e campo protegido depois da reconciliação.
    await prisma.produto.update({ where: { cnp: 6000002 }, data: { dosagem: "EDITADO DEPOIS" } });
    await prisma.produto.update({ where: { cnp: 6000001 }, data: { camposManuais: ["dci"] } });
    const antesRev = await quatro();
    const rr = cli([`--reverter-reconciliacao=${caminho}`, "--apply"]);
    check(rr.status === 0 && /APPLY/.test(rr.stdout), `CLI --apply da reversão${rr.status === 0 ? "" : ` (${(rr.stdout + rr.stderr).slice(0, 400)})`}`);
    const pos = await quatro();
    const dePos = (cnp: number) => pos.find((p) => p.cnp === cnp)!;
    const deAntes = (cnp: number) => antes.find((p) => p.cnp === cnp)!;
    const igual = (cnp: number, campo: string) => dePos(cnp)[campo] === deAntes(cnp)[campo];
    check(["formaFarmaceutica", "embalagem", "dci"].every((k) => igual(6000002, k)), "P2: forma, embalagem e DCI voltam aos valores anteriores");
    check(dePos(6000002).dosagem === "EDITADO DEPOIS", "P2: a dosagem editada depois NÃO é revertida (conflito)");
    check(["formaFarmaceutica", "dosagem", "embalagem"].every((k) => igual(6000001, k)) && dePos(6000001).dci === "Metformina", "P1: repostos os campos livres; DCI marcada como manual depois fica protegida");
    check(dePos(6000004).formaFarmaceutica === "" && dePos(6000004).dosagem === " ", "P4: strings vazias/espaços repostas EXATAMENTE como estavam");
    check(JSON.stringify(dePos(6000005)) === JSON.stringify(deAntes(6000005)) && JSON.stringify(dePos(6000006)) === JSON.stringify(deAntes(6000006)) && dePos(6000003).dosagem === "850 mg MANUAL", "produtos não tocados pela reconciliação continuam iguais");
    check(await designacoes() === hDes && await outros() === hOut, "Produto.designacao e restantes campos operacionais: intactos");
    check(/conflitos \(não tocados\) 2/.test(rr.stdout), "o resumo indica os 2 conflitos (valor alterado depois, campo protegido)");
    const relRev = fs.readdirSync(dir).find((f) => f.startsWith("reversao-") && f.endsWith("-apply.json"));
    const jr = relRev ? JSON.parse(fs.readFileSync(path.join(dir, relRev), "utf8")) : null;
    const motivos = (jr?.resultados?.[0]?.conflitos ?? []).map((x: { motivo: string }) => x.motivo).sort().join();
    check(motivos === "CAMPO_PROTEGIDO_MANUAL,VALOR_ALTERADO_DEPOIS", `relatório da reversão lista os conflitos (${motivos})`);
    void antesRev;

    secao("G · idempotência: repetir a reversão não faz nada");
    const rr2 = cli([`--reverter-reconciliacao=${caminho}`, "--apply"]);
    const pos2 = await quatro();
    check(rr2.status === 0 && JSON.stringify(pos2) === JSON.stringify(pos), "2.ª execução não altera nada");
    check(/a reverter|revertidas 0/.test(rr2.stdout) && /revertidas 0/.test(rr2.stdout), "…e reporta 0 revertidas");

    secao("H · filtro por tenant");
    const rt = cli([`--reverter-reconciliacao=${caminho}`, "--tenant=inexistente"]);
    check(rt.status !== 0 || /não consta/.test(rt.stdout + rt.stderr), "tenant que não consta do relatório é recusado");

    await prisma.$disconnect();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => undefined);
    await admin.end();
  }
  console.log(`\n${passed} OK, ${failed} falhas`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
