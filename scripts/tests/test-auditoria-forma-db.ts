/**
 * scripts/tests/test-auditoria-forma-db.ts
 *
 * Auditoria READ-ONLY de `formaFarmaceutica` (scripts/diagnostics/auditoria-forma-farmaceutica.ts) contra PostgreSQL
 * DESCARTÁVEL (recusa hosts não locais), dados SINTÉTICOS:
 *
 *   R · recusas: sem --confirmo-read-only, sem --url (DATABASE_URL do ambiente NÃO conta), sem --tenant, --out inválido
 *       — todas ANTES de abrir ligação, e sem a password nas mensagens;
 *   W · NÃO ESCREVE: hash das linhas (incluindo xmin) de Produto/ProdutoRegulamentar/RegulatoryRecord/InfarmedImportacao
 *       igual antes e depois; a sessão é READ ONLY (um UPDATE é recusado pelo PostgreSQL mesmo com um papel SUPERUSER);
 *   P · NUNCA imprime a password (stdout, stderr, ficheiros, erro de autenticação);
 *   V · valores certos num dataset conhecido (total, com/sem forma, cobertura, top, variantes, pares, INFARMED na versão
 *       ativa, medicamentos vs não medicamentos, universo sem INATIVO/códigos internos);
 *   C · colisões: a chave de produção coincide com a independente (NFD) para todas as letras acentuadas suportadas; uma
 *       letra fora da lista é assinalada como discordância; nada é agrupado para além de espaços/acentos/maiúsculas;
 *   T · tenant: o slug fica no relatório e as formas de uma base NUNCA aparecem no relatório da outra.
 *
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres npx tsx scripts/tests/test-auditoria-forma-db.ts
 */
import Module from "node:module";
import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";

const M = Module as unknown as { _resolveFilename: (r: string, ...a: unknown[]) => string };
const resolverOriginal = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "server-only" ? __filename : resolverOriginal.call(this, request, ...rest);
};

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${label}`); }
  else { ko++; console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`); }
};
const secao = (t: string) => console.log(`\n── ${t}`);

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgresql://postgres:test@localhost:15433/postgres";
const host = new URL(ADMIN_URL).hostname;
if (host !== "localhost" && host !== "127.0.0.1") {
  console.error(`RECUSADO: ${host} não é uma base local descartável.`);
  process.exit(2);
}
const urlDe = (db: string, user?: string, pass?: string) => {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${db}`;
  if (user) u.username = user;
  if (pass) u.password = pass;
  return u.toString();
};

const SCRIPT = "scripts/diagnostics/auditoria-forma-farmaceutica.ts";
function cli(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(`npx tsx ${SCRIPT} ${args.map((a) => `"${a}"`).join(" ")}`, {
    shell: true, encoding: "utf8", env: { ...process.env, DATABASE_URL: "", ...env },
  });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

const SENHA = "Zq9xK7pwUnica42";

async function main() {
  const suf = Date.now().toString(36);
  const dbA = `spharm_aud_a_${suf}`;
  const dbB = `spharm_aud_b_${suf}`;
  const papel = `aud_su_${suf}`;
  const pasta = mkdtempSync(path.join(tmpdir(), "aud-forma-"));
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  for (const d of [dbA, dbB]) await admin.query(`CREATE DATABASE ${d}`);
  // Papel SUPERUSER com password conhecida: se a sessão não fosse READ ONLY, este papel conseguiria escrever.
  await admin.query(`CREATE ROLE ${papel} LOGIN SUPERUSER PASSWORD '${SENHA}'`);
  try {
    for (const d of [dbA, dbB]) execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: urlDe(d) }, encoding: "utf8" });
    const { PrismaClient } = await import("../../generated/prisma/client");
    const novoPrisma = (d: string) => new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(d) }) });
    const prisma = novoPrisma(dbA);
    const prismaB = novoPrisma(dbB);

    // ── Dataset conhecido (base A) ──────────────────────────────────────────────────────────────────────────
    type Def = { cnp: number; forma: string | null; tipo?: "MEDICAMENTO" | "PARAFARMACIA" | null; estado?: "VALIDADO" | "INATIVO"; manual?: boolean };
    const defs: Def[] = [
      { cnp: 9_000_001, forma: "Comprimido", tipo: "MEDICAMENTO" }, // + ProdutoRegulamentar (versão ativa)
      { cnp: 9_000_002, forma: " COMPRIMIDO ", tipo: "MEDICAMENTO", manual: true },
      { cnp: 9_000_003, forma: "comprimido", tipo: "PARAFARMACIA" },
      { cnp: 9_000_004, forma: "Comprimido revestido", tipo: "MEDICAMENTO" }, // + RegulatoryRecord
      { cnp: 9_000_005, forma: "Comprimido de libertação prolongada", tipo: "MEDICAMENTO" },
      { cnp: 9_000_006, forma: "Cápsula", tipo: "PARAFARMACIA" }, // ProdutoRegulamentar SÓ na versão INATIVA -> não conta
      { cnp: 9_000_007, forma: "CAPSULA", tipo: null }, // + ProdutoRegulamentar (versão ativa) -> medicamento por INFARMED
      { cnp: 9_000_008, forma: "Capsulas", tipo: "PARAFARMACIA" }, // parecida (distância 1) e NÃO agrupada com «capsula»
      { cnp: 9_000_009, forma: null, tipo: "PARAFARMACIA" },
      { cnp: 9_000_010, forma: "   ", tipo: "MEDICAMENTO" }, // só espaços; + ProdutoRegulamentar (ativa)
      { cnp: 9_000_011, forma: "Pomada", tipo: "MEDICAMENTO", estado: "INATIVO" }, // fora do universo
      { cnp: 1_999_999, forma: "Xarope", tipo: "MEDICAMENTO" }, // código interno: fora do universo
    ];
    const id = new Map<number, string>();
    for (const d of defs) {
      const p = await prisma.produto.create({
        data: {
          cnp: d.cnp, designacao: `AUD ${d.cnp}`, estado: d.estado ?? "VALIDADO", formaFarmaceutica: d.forma,
          ...(d.tipo ? { productType: d.tipo } : {}), ...(d.manual ? { camposManuais: ["formaFarmaceutica"] } : {}),
        },
      });
      id.set(d.cnp, p.id);
    }
    const imp = (ativa: boolean, sha: string) => prisma.infarmedImportacao.create({
      data: { origem: "TESTE", sha256: sha, descarregadoEm: new Date(), estado: "APLICADA", ativa },
    });
    const antiga = await imp(false, "a".repeat(64));
    const ativa = await imp(true, "b".repeat(64));
    const pr = (importacaoId: string, cnp: number) => prisma.produtoRegulamentar.create({ data: { importacaoId, produtoId: id.get(cnp)!, cnp } });
    for (const c of [9_000_001, 9_000_007, 9_000_010]) await pr(ativa.id, c);
    await pr(antiga.id, 9_000_006); // só na versão inativa
    await prisma.regulatoryRecord.create({ data: { cnp: 9_000_004, source: "teste" } });

    // ── Dataset da base B (outro tenant) ────────────────────────────────────────────────────────────────────
    await prismaB.produto.create({ data: { cnp: 9_100_001, designacao: "B1", estado: "VALIDADO", formaFarmaceutica: "Supositório SOMENTE-B" } });
    await prismaB.produto.create({ data: { cnp: 9_100_002, designacao: "B2", estado: "VALIDADO", formaFarmaceutica: null } });

    const urlA = urlDe(dbA, papel, SENHA);
    const urlB = urlDe(dbB, papel, SENHA);

    // ═══ R · recusas ═══
    secao("R · recusas (nenhuma abre ligação)");
    {
      const semFlag = cli(["--url", urlA, "--tenant", "silveira"]);
      check(semFlag.code === 2 && /--confirmo-read-only/.test(semFlag.err) && semFlag.out === "", "R1: sem --confirmo-read-only recusa (exit 2) e não produz relatório");
      const semUrl = cli(["--tenant", "silveira", "--confirmo-read-only"], { DATABASE_URL: urlA });
      check(semUrl.code === 2 && /--url/.test(semUrl.err) && semUrl.out === "", "R2: sem --url recusa — DATABASE_URL do ambiente NÃO é usada");
      const semTenant = cli(["--url", urlA, "--confirmo-read-only"]);
      check(semTenant.code === 2 && /--tenant/.test(semTenant.err), "R3: sem --tenant recusa");
      const outMau = cli(["--url", urlA, "--tenant", "silveira", "--confirmo-read-only", "--out", path.join(pasta, "x.txt")]);
      check(outMau.code === 2 && /\.md ou \.json/.test(outMau.err) && !existsSync(path.join(pasta, "x.txt")), "R4: --out tem de ser .md/.json");
      const urlMau = cli(["--url", "mysql://u:p@h/db", "--tenant", "silveira", "--confirmo-read-only"]);
      check(urlMau.code === 2, "R5: URL que não é postgresql:// é recusado");
      for (const r of [semFlag, semUrl, semTenant, outMau, urlMau]) {
        if (r.out.includes(SENHA) || r.err.includes(SENHA)) { check(false, "R6: password na saída de uma recusa"); }
      }
      check(![semFlag, semUrl, semTenant, outMau].some((r) => (r.out + r.err).includes(SENHA)), "R6: nenhuma mensagem de recusa contém a password");
    }

    // ═══ W / V / P · execução real ═══
    const tabelas = ["Produto", "ProdutoRegulamentar", "RegulatoryRecord", "InfarmedImportacao"];
    const hash = async () => {
      const out: string[] = [];
      const c = new Client({ connectionString: urlDe(dbA) });
      await c.connect();
      for (const t of tabelas) {
        const r = await c.query(`SELECT count(*)::text AS n, coalesce(md5(string_agg(xmin::text || ':' || x::text, ',' ORDER BY x::text)), '') AS h FROM "${t}" x`);
        out.push(`${t}=${r.rows[0].n}/${r.rows[0].h}`);
      }
      await c.end();
      return out.join("|");
    };
    secao("W · não escreve");
    const antes = await hash();
    const outJson = path.join(pasta, "A.json");
    const outMd = path.join(pasta, "A.md");
    const rJson = cli(["--url", urlA, "--tenant", "silveira", "--confirmo-read-only", "--out", outJson, "--top", "50"]);
    const rMd = cli(["--url", urlA, "--tenant", "silveira", "--confirmo-read-only", "--out", outMd]);
    const rStdout = cli(["--url", urlA, "--tenant", "silveira", "--confirmo-read-only"]);
    check(rJson.code === 0 && rMd.code === 0 && rStdout.code === 0, "W0: corre com a flag (exit 0)", rJson.err + rMd.err + rStdout.err);
    const depois = await hash();
    check(antes === depois, "W1: hash (xmin + conteúdo) de Produto/ProdutoRegulamentar/RegulatoryRecord/InfarmedImportacao idêntico antes e depois", `${antes}\n${depois}`);
    check((await prisma.produto.count()) === defs.length && (await prisma.regulatoryRecord.count()) === 1 && (await prisma.produtoRegulamentar.count()) === 4, "W2: contagens inalteradas");
    {
      const aud = await import("../diagnostics/auditoria-forma-farmaceutica");
      const c = await aud.abrirSoLeitura(urlA);
      const show = (await c.query("SHOW transaction_read_only")).rows[0].transaction_read_only;
      const showDef = (await c.query("SHOW default_transaction_read_only")).rows[0].default_transaction_read_only;
      check(show === "on" && showDef === "on", "W3: a sessão é READ ONLY (transaction_read_only e default_transaction_read_only = on)");
      let recusou = "";
      try { await c.query(`UPDATE "Produto" SET designacao = 'ESCRITA' WHERE cnp = 9000001`); } catch (e) { recusou = e instanceof Error ? e.message : String(e); }
      check(/read-only transaction/i.test(recusou), "W4: mesmo com um papel SUPERUSER, um UPDATE é recusado pelo PostgreSQL", recusou);
      await c.query("ROLLBACK").catch(() => undefined);
      await c.end();
      const apos = await prisma.produto.findUniqueOrThrow({ where: { cnp: 9_000_001 } });
      check(apos.designacao === "AUD 9000001", "W5: nada foi escrito pela tentativa");
    }

    secao("P · nunca imprime a password");
    {
      const ficheiros = [readFileSync(outJson, "utf8"), readFileSync(outMd, "utf8")];
      const tudo = [rJson.out, rJson.err, rMd.out, rMd.err, rStdout.out, rStdout.err, ...ficheiros].join("\n");
      check(!tudo.includes(SENHA) && !tudo.includes(papel), "P1: nem a password nem o utilizador aparecem em stdout/stderr/ficheiros");
      check(tudo.includes(`localhost:${new URL(ADMIN_URL).port}/${dbA}`) || tudo.includes(`127.0.0.1:${new URL(ADMIN_URL).port}/${dbA}`), "P2: o relatório identifica a base só por host:porta/base");
      const urlErrada = urlDe(dbA, papel, "SenhaErradaXyz99");
      const rErr = cli(["--url", urlErrada, "--tenant", "silveira", "--confirmo-read-only"]);
      check(rErr.code === 1 && !(rErr.out + rErr.err).includes("SenhaErradaXyz99"), "P3: um erro de autenticação não revela a password usada", rErr.err.slice(0, 200));
      const rInexistente = cli(["--url", urlDe("nao_existe_" + suf, papel, SENHA), "--tenant", "silveira", "--confirmo-read-only"]);
      check(rInexistente.code === 1 && !(rInexistente.out + rInexistente.err).includes(SENHA), "P4: um erro de ligação (base inexistente) não revela a password");
    }

    secao("V · valores certos no dataset conhecido");
    const J = JSON.parse(readFileSync(outJson, "utf8"));
    check(J.tenant === "silveira" && J.somenteLeitura === true, "V0: tenant e somenteLeitura no relatório");
    check(J.produtos.total === 10, `V1: total 10 (INATIVO e código interno fora) — veio ${J.produtos.total}`);
    check(J.produtos.comForma === 8 && J.produtos.semForma === 2 && J.produtos.coberturaPct === 80 && J.produtos.soEspacos === 1, "V2: 8 com forma, 2 sem (1 só espaços), cobertura 80,0%");
    check(J.formasDistintas.cruas === 10 && J.formasDistintas.normalizadas === 6, `V3: 10 valores crus -> 6 opções (comprimido, revestido, libertação, cápsula, cápsulas, sem forma) — veio ${JSON.stringify(J.formasDistintas)}`);
    check(J.topFormas[0].chave === "comprimido" && J.topFormas[0].produtos === 3 && J.topFormas[0].pct === 30 && J.topFormas[1].chave === "capsula" && J.topFormas[1].produtos === 2, "V4: top = comprimido (3, 30%), capsula (2)");
    check(J.topFormas.every((f: { chave: string }) => f.chave !== "__sem_forma__"), "V5: o top não inclui «sem forma»");
    check(J.variantes.chavesComVariantes === 2 && J.variantes.grafiasJuntadas === 3, "V6: 2 chaves com variantes, 3 grafias juntadas");
    const vComp = J.variantes.detalhe.find((v: { chave: string }) => v.chave === "comprimido");
    check(vComp && vComp.grafias.length === 3 && vComp.grafias.every((g: { produtos: number }) => g.produtos === 1) && vComp.grafias.some((g: { valor: string }) => g.valor === " COMPRIMIDO "), "V7: variantes de «comprimido» com contagem por variante (valor cru preservado)");
    check(J.colisoesSuspeitas.length === 0 && J.chavesDiscordantes.length === 0, "V8: nenhuma colisão suspeita nem discordância");
    check(J.paresParecidosNaoAgrupados.total === 1 && J.paresParecidosNaoAgrupados.detalhe[0].a === "capsula" && J.paresParecidosNaoAgrupados.detalhe[0].b === "capsulas", "V9: «capsula» ↔ «capsulas» listados como parecidos NÃO agrupados (e «Comprimido»/«revestido» não)");
    check(J.infarmed.produtosComCorrespondencia === 4 && J.infarmed.produtosSemCorrespondencia === 6, "V10: INFARMED = 3 por ProdutoRegulamentar ATIVA + 1 por RegulatoryRecord; a versão inativa não conta");
    check(J.infarmed.semCorrespondenciaESemForma === 1 && J.infarmed.semCorrespondenciaMasComForma === 5, "V11: sem INFARMED: 6, dos quais 1 sem forma (o nulo; o de «só espaços» tem INFARMED)");
    const m = J.medicamentos;
    check(m.medicamentos.total === 6 && m.medicamentos.comForma === 5 && m.medicamentos.semForma === 1 && m.medicamentos.coberturaPct === 83.3, "V12: medicamentos = productType OU INFARMED: 6 (5 com forma, 1 sem)");
    check(m.naoMedicamentos.total === 4 && m.naoMedicamentos.comForma === 3 && m.naoMedicamentos.semForma === 1 && m.naoMedicamentos.coberturaPct === 75, "V13: não medicamentos: 4 (3 com forma, 1 sem)");
    check(m.medicamentosPorTipo === 5 && m.protegidosManualmente === 1, "V14: 5 só por productType; 1 protegido por camposManuais");
    check(/productType/.test(m.criterio) && /limit|pode estar|subestima/i.test(m.limitacao), "V15: critério e limitação declarados");
    const md = readFileSync(outMd, "utf8");
    check(md.includes("tenant `silveira`") && md.includes("## Cobertura") && md.includes("## Formas muito parecidas NÃO agrupadas") && md.includes("## Correspondência INFARMED") && md.includes("Medicamentos vs não medicamentos"), "V16: o markdown tem as secções pedidas e o slug do tenant");
    check(rStdout.out.includes("## Cobertura") && !existsSync(path.join(pasta, "stdout")), "V17: sem --out o markdown vai para stdout");

    secao("C · colisões e normalização independente");
    {
      const aud = await import("../diagnostics/auditoria-forma-farmaceutica");
      const F = await import("../../lib/catalog/forma-farmaceutica-filtro");
      const letras = [...F.ACENTOS_ORIGEM];
      const discord = letras.filter((l) => F.chaveFormaFarmaceutica(`x${l}x`) !== aud.chaveIndependente(`x${l}x`));
      check(discord.length === 0, `C1: a chave de produção coincide com a independente (NFD) para as ${letras.length} letras suportadas`, discord.join(" "));
      check(aud.chaveIndependente("  Cápsula   DURA ") === "capsula dura" && aud.chaveIndependente("   ") === "__sem_forma__", "C2: chave independente (aparar, colapsar, sem acentos, minúsculas)");
      check(aud.distanciaEdicao("capsula", "capsulas", 2) === 1 && aud.distanciaEdicao("comprimido", "comprimido revestido", 2) === 3, "C3: distância de edição com corte");
      const base = { medicamentos: 0, medicamentosPorTipo: 0, comInfarmed: 0, manuais: 0 };
      const rel = aud.construirRelatorio(
        [
          { valor: "Ōvulo", total: 2, ...base },
          { valor: "Ovulo", total: 3, ...base },
          { valor: "Comprimido", total: 5, ...base },
          { valor: "Comprimido revestido", total: 4, ...base },
        ],
        { tenant: "x", destino: "h/d", geradoEm: "agora", fontes: { produtoRegulamentarAtiva: false, regulatoryRecord: false, versaoAtivaId: null }, top: 10 },
      );
      check(rel.chavesDiscordantes.some((d: { valor: string }) => d.valor === "Ōvulo"), "C4: uma letra fora da lista («Ō») é assinalada como discordância para revisão");
      check(rel.paresParecidosNaoAgrupados.detalhe.some((p: { a: string; b: string }) => [p.a, p.b].sort().join() === ["ovulo", "ōvulo"].sort().join()), "C5: «Ōvulo»/«Ovulo» aparecem como pares parecidos NÃO agrupados (o filtro não os junta)");
      check(!rel.paresParecidosNaoAgrupados.detalhe.some((p: { a: string }) => p.a.startsWith("comprimido")), "C6: «Comprimido» e «Comprimido revestido» NÃO são pares a rever (clinicamente distintos, distância > 2)");
      check(rel.colisoesSuspeitas.length === 0, "C7: sem colisões (nada foi agrupado para além de espaços/acentos/maiúsculas)");
    }

    secao("T · tenant: cada base só mostra as suas formas");
    {
      const rB = cli(["--url", urlB, "--tenant", "garantia", "--confirmo-read-only", "--out", path.join(pasta, "B.json")]);
      check(rB.code === 0, "T0: corre na base B", rB.err);
      const JB = JSON.parse(readFileSync(path.join(pasta, "B.json"), "utf8"));
      check(JB.tenant === "garantia" && JB.produtos.total === 2 && JB.produtos.comForma === 1, "T1: relatório B: tenant garantia, 2 produtos, 1 com forma");
      const textoA = JSON.stringify(J);
      const textoB = JSON.stringify(JB);
      check(textoB.includes("somente-b") && !textoA.toLowerCase().includes("somente-b"), "T2: a forma exclusiva da B não aparece no relatório da A");
      check(!textoB.includes("comprimido") && !textoB.includes("capsula"), "T3: nenhuma forma da A aparece no relatório da B");
      check(/Esta auditoria descreve APENAS a base do tenant «garantia»/.test(JB.partilhaEntreTenants), "T4: o relatório declara que as formas não são partilhadas entre tenants");
      check(JB.infarmed.produtosComCorrespondencia === 0 && JB.fontesRegulamentares.produtoRegulamentarAtiva === false, "T5: base sem versão ativa do INFARMED: relatório honesto (0 correspondências, fonte inativa)");
    }

    await prisma.$disconnect();
    await prismaB.$disconnect();
  } finally {
    rmSync(pasta, { recursive: true, force: true });
    await admin.query(`DROP DATABASE IF EXISTS ${dbA} WITH (FORCE)`).catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS ${dbB} WITH (FORCE)`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${papel}`).catch(() => undefined);
    await admin.end();
  }
  console.log(`\n${ko === 0 ? "PASSOU" : "FALHOU"} — ${ok} OK, ${ko} falhas\n`);
  process.exit(ko === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
