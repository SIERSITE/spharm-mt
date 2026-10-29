/**
 * scripts/tests/test-auditoria-fabricantes-grupos-db.ts
 *
 * Auditoria READ-ONLY de fabricantes/grupos (scripts/diagnostics/auditoria-fabricantes-grupos-garantia.ts) — PostgreSQL
 * REAL e DESCARTÁVEL, dados sintéticos:
 *   A · argumentos: recusa sem --confirmo-read-only, sem URL explícita (DATABASE_URL não conta), URL inválida, --out inválido;
 *   B · conteúdo: antes/depois, top de grupos, >10 variantes (todas agrupadas?), membros com tipo/validação/aliases, produtos por
 *       grupo, incluídos por regra com fabricante fora do grupo (+ obsoleto), candidatos por semelhança (SÓ listados),
 *       ambiguidades (alias partilhado, regra contra o grupo do fabricante, produto com grupo ≠ grupo do fabricante);
 *   C · não escreve: contagens e xmin de todas as tabelas iguais antes/depois; a sessão rejeita escritas;
 *   D · CLI: recusa sem confirmação; com role só de leitura e password distinta, corre, escreve --out (.md e .json) e NUNCA
 *       imprime a password (nem em erros de autenticação).
 *
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres npx tsx scripts/tests/test-auditoria-fabricantes-grupos-db.ts
 */
import { readFileSync, existsSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${label}`); }
  else { ko++; console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`); }
};

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? "postgresql://postgres:test@localhost:15433/postgres";
const host = new URL(ADMIN_URL).hostname;
if (host !== "localhost" && host !== "127.0.0.1") {
  console.error(`RECUSADO: ${host} não é uma base local descartável (este TESTE só corre em bases descartáveis; o script de auditoria em si não tem essa restrição).`);
  process.exit(2);
}
const urlDe = (db: string, user?: string, pass?: string) => {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${db}`;
  if (user) u.username = user;
  if (pass) u.password = pass;
  return u.toString();
};
const SEGREDO = "Segr3doUnico_9xQ";

async function main() {
  const db = `spharm_audit_${Date.now().toString(36)}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${db}`);
  const tmp = mkdtempSync(join(tmpdir(), "audit-fab-"));
  try {
    execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: urlDe(db) }, encoding: "utf8" });
    const { PrismaClient } = await import("../../generated/prisma/client");
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(db) }) });
    const A = await import("../diagnostics/auditoria-fabricantes-grupos-garantia");

    // ── Fixture sintética ───────────────────────────────────────────────────────────────────────────────────────
    let cnp = 7_000_000;
    const mkProd = (nome: string, fabricanteId: string | null) => prisma.produto.create({ data: { cnp: ++cnp, designacao: nome, estado: "VALIDADO", fabricanteId } });
    const grupoViatris = await prisma.grupoLaboratorial.create({ data: { nome: "Viatris", nomeNormalizado: "VIATRIS" } });
    const grupoOrganon = await prisma.grupoLaboratorial.create({ data: { nome: "Organon", nomeNormalizado: "ORGANON" } });
    await prisma.grupoLaboratorialAlias.create({ data: { grupoLaboratorialId: grupoViatris.id, alias: "Upjohn", aliasNormalizado: "UPJOHN" } });
    await prisma.grupoLaboratorialAlias.create({ data: { grupoLaboratorialId: grupoOrganon.id, alias: "Upjohn", aliasNormalizado: "UPJOHN" } }); // alias partilhado entre 2 grupos
    const membros: Array<{ id: string; nome: string }> = [];
    for (let i = 1; i <= 12; i++) {
      const nome = `VIATRIS UNIDADE ${String(i).padStart(2, "0")}`;
      const f = await prisma.fabricante.create({ data: { nomeNormalizado: nome } });
      membros.push({ id: f.id, nome });
      await prisma.grupoLaboratorialFabricante.create({ data: { grupoLaboratorialId: grupoViatris.id, fabricanteId: f.id, validadoManualmente: i === 1 } });
      if (i === 2) await prisma.fabricanteAlias.create({ data: { fabricanteId: f.id, aliasNome: "MYLAN ANTIGA" } });
      const p = await mkProd(`Viatris p${i}`, f.id);
      await prisma.produtoGrupoLaboratorial.create({ data: { produtoId: p.id, grupoLaboratorialId: grupoViatris.id, origem: "FABRICANTE_INEQUIVOCO" } });
    }
    const fabOrg = await prisma.fabricante.create({ data: { nomeNormalizado: "ORGANON PORTUGAL" } });
    await prisma.grupoLaboratorialFabricante.create({ data: { grupoLaboratorialId: grupoOrganon.id, fabricanteId: fabOrg.id } });
    const pOrg = await mkProd("Organon p1", fabOrg.id);
    await prisma.produtoGrupoLaboratorial.create({ data: { produtoId: pOrg.id, grupoLaboratorialId: grupoOrganon.id, origem: "FABRICANTE_INEQUIVOCO" } });
    // fabricante fora, com produtos incluídos por regra / manual / alias, mais um obsoleto
    const fabFora = await prisma.fabricante.create({ data: { nomeNormalizado: "PFIZER LABORATORIOS" } });
    const pRegra = await mkProd("Pfizer por regra", fabFora.id);
    const regra = await prisma.regraGrupoLaboratorialPorCnp.create({ data: { cnp: pRegra.cnp, grupoLaboratorialId: grupoViatris.id, validadoManualmente: true } });
    await prisma.produtoGrupoLaboratorial.create({ data: { produtoId: pRegra.id, grupoLaboratorialId: grupoViatris.id, origem: "REGRA_CNP", regraCnpId: regra.id } });
    const pManual = await mkProd("Pfizer manual", fabFora.id);
    await prisma.produtoGrupoLaboratorial.create({ data: { produtoId: pManual.id, grupoLaboratorialId: grupoViatris.id, origem: "MANUAL", validadoManualmente: true } });
    const pObsoleto = await mkProd("Pfizer obsoleto", fabFora.id);
    await prisma.produtoGrupoLaboratorial.create({ data: { produtoId: pObsoleto.id, grupoLaboratorialId: grupoViatris.id, origem: "FABRICANTE_INEQUIVOCO" } });
    // produto de fabricante MEMBRO de Organon colocado manualmente em Viatris (grupo ≠ grupo do fabricante); e membro sem linha
    const pCruzado = await mkProd("Organon cruzado", fabOrg.id);
    await prisma.produtoGrupoLaboratorial.create({ data: { produtoId: pCruzado.id, grupoLaboratorialId: grupoViatris.id, origem: "MANUAL", validadoManualmente: true } });
    await mkProd("Viatris sem linha de grupo", membros[0]!.id);
    // regra CNP contra o grupo do fabricante: produto de membro Organon, regra → Viatris
    const regraContra = await prisma.regraGrupoLaboratorialPorCnp.create({ data: { cnp: pCruzado.cnp, grupoLaboratorialId: grupoViatris.id, validadoManualmente: true } });
    void regraContra;
    // semelhantes sem prova
    const fabParecido = await prisma.fabricante.create({ data: { nomeNormalizado: "VIATRIS HEALTHCARE LDA" } });
    await mkProd("Parecido p", fabParecido.id);
    const fabSolto1 = await prisma.fabricante.create({ data: { nomeNormalizado: "NOVARTIS FARMA LDA" } });
    const fabSolto2 = await prisma.fabricante.create({ data: { nomeNormalizado: "NOVARTIS PORTUGAL SA" } });
    await mkProd("Novartis a", fabSolto1.id);
    await mkProd("Novartis b", fabSolto2.id);
    const fabIndep = await prisma.fabricante.create({ data: { nomeNormalizado: "SERVIER" } });
    await mkProd("Servier p", fabIndep.id);

    // ── A · argumentos ──────────────────────────────────────────────────────────────────────────────────────────
    console.log("A · argumentos e recusas");
    const recusa = (argv: string[], env: Record<string, string | undefined> = {}) => { try { A.lerArgumentos(argv, env); return null; } catch (e) { return (e as Error).message; } };
    check(/--confirmo-read-only/.test(recusa(["--url", urlDe(db)]) ?? ""), "A1: recusa sem --confirmo-read-only");
    check(/URL explicitamente/.test(recusa(["--confirmo-read-only"], { DATABASE_URL: urlDe(db) }) ?? ""), "A2: recusa sem URL explícita — DATABASE_URL do ambiente NÃO é usada");
    check(/PostgreSQL válida/.test(recusa(["--confirmo-read-only", "--url", "mysql://x"]) ?? ""), "A3: recusa URL que não é PostgreSQL");
    check(/\.md ou \.json/.test(recusa(["--confirmo-read-only", "--url", urlDe(db), "--out", "x.txt"]) ?? ""), "A4: --out só .md/.json");
    check(A.lerArgumentos(["--confirmo-read-only", "--url", urlDe(db)], {}).url === urlDe(db) && A.lerArgumentos(["--confirmo-read-only", urlDe(db)], {}).url === urlDe(db), "A5: aceita --url e o 1.º argumento posicional");
    check(A.lerArgumentos(["--confirmo-read-only"], { AUDITORIA_DATABASE_URL: urlDe(db) }).url === urlDe(db), "A6: aceita AUDITORIA_DATABASE_URL (variável própria e explícita)");
    check(A.lerArgumentos(["--confirmo-read-only", "--url", "postgresql://u:p@db.remoto.exemplo.pt:5432/spharmmt_t_garantia"], {}).url.includes("remoto"), "A7: NÃO restringe a localhost (vai correr na base real do Garantia)");

    // ── C0 · instantâneo antes ──────────────────────────────────────────────────────────────────────────────────
    const tabelas = ["Fabricante", "FabricanteAlias", "Produto", "GrupoLaboratorial", "GrupoLaboratorialAlias", "GrupoLaboratorialFabricante", "ProdutoGrupoLaboratorial", "RegraGrupoLaboratorialPorCnp"];
    const instantaneo = async () => {
      const c = new Client({ connectionString: urlDe(db) });
      await c.connect();
      const out: Record<string, string> = {};
      for (const t of tabelas) {
        const r = await c.query(`SELECT count(*)::text AS n, coalesce(md5(string_agg(xmin::text || ':' || ctid::text, ',' ORDER BY ctid)), '') AS h FROM "${t}"`);
        out[t] = `${r.rows[0].n}/${r.rows[0].h}`;
      }
      await c.end();
      return out;
    };
    await new Promise((r) => setTimeout(r, 600)); // deixa as estatísticas assentarem
    const antes = await instantaneo();

    // ── B · conteúdo ────────────────────────────────────────────────────────────────────────────────────────────
    console.log("\nB · conteúdo do relatório");
    const rel = await A.executarAuditoria(urlDe(db), 5);
    const totalFab = await prisma.fabricante.count();
    check(rel.fabricantesAtivos === totalFab && rel.fabricantesApresentadosAntes === totalFab, `B1: antes = fabricantes ativos com produtos (${rel.fabricantesApresentadosAntes} de ${totalFab})`);
    check(rel.opcoesDepois === totalFab - 12 - 1 + 2, `B2: depois = ${rel.opcoesDepois} (2 grupos + ${totalFab - 13} fabricantes sem prova; as 13 variantes vivem nos grupos)`);
    check(rel.gruposAtivos === 2 && rel.gruposComMaisDeDezVariantes === 1 && rel.gruposComMaisVariantes[0]?.grupo === "Viatris" && rel.gruposComMaisVariantes[0]?.variantes === 12, "B3: Viatris é o grupo com mais variantes (12); 1 grupo com mais de 10");
    const gv = rel.grupos.find((g) => g.nome === "Viatris")!;
    check(gv.membros.length === 12 && gv.membros[0]!.tipoAssociacao === "INEQUIVOCA" && gv.membros.some((m) => m.validadoManualmente) && gv.membros.some((m) => m.aliases.includes("MYLAN ANTIGA")), "B4: membros com nome, id, tipo de associação, validação manual e aliases");
    check(gv.aliases.includes("Upjohn") && gv.nomesTotal === 12 + 1 + 1, `B5: nomes do grupo = 12 membros + 1 alias de membro + 1 alias do grupo (${gv.nomesTotal})`);
    check(gv.produtosAbrangidos === 12 + 4 && gv.produtosPorOrigem.MANUAL === 2 && gv.produtosPorOrigem.REGRA_CNP === 1, `B6: produtos abrangidos distintos = ${gv.produtosAbrangidos} (12 + regra + 2 manuais + obsoleto)`);
    const foraPids = new Set(gv.produtosForaDoGrupo.amostra.map((p) => p.produtoId));
    check(gv.produtosForaDoGrupo.total === 4 && [pRegra.id, pManual.id, pObsoleto.id, pCruzado.id].every((id) => foraPids.has(id)), "B7: lista os 4 produtos incluídos cujo fabricante NÃO é membro (regra CNP, manual, obsoleto, cruzado)");
    check(gv.produtosForaDoGrupo.amostra.find((p) => p.produtoId === pRegra.id)?.motivo === "incluido_por_regra" && gv.produtosForaDoGrupo.amostra.find((p) => p.produtoId === pObsoleto.id)?.motivo === "obsoleto_sem_base_atual", "B8: distingue «incluído por regra» (base aprovada) de «obsoleto sem base atual»");
    check(gv.produtosForaDoGrupo.amostra.find((p) => p.produtoId === pCruzado.id)?.fabricanteMembroDeOutroGrupo === "Organon", "B9: assinala que o fabricante é membro de OUTRO grupo");
    check(gv.produtosDeMembrosForaDoGrupo.total === 1 && gv.produtosDeMembrosForaDoGrupo.amostra[0]?.grupoAtual === null, "B10: lista o produto de fabricante membro SEM linha de grupo");
    const go = rel.grupos.find((g) => g.nome === "Organon")!;
    check(go.produtosDeMembrosForaDoGrupo.total === 1 && go.produtosDeMembrosForaDoGrupo.amostra[0]?.grupoAtual === "Viatris", "B11: Organon: o produto cruzado do seu membro está em Viatris");
    check(rel.resumoForaDoGrupo.incluidosPorRegra === 3 && rel.resumoForaDoGrupo.obsoletosSemBase === 1, "B12: resumo — 3 por regra/manual, 1 obsoleto");
    const cand = rel.candidatosParaRevisao.find((c) => c.fabricante === "VIATRIS HEALTHCARE LDA");
    check(!!cand && cand.grupo === "Viatris" && !gv.membros.some((m) => m.nome === "VIATRIS HEALTHCARE LDA"), "B13: «VIATRIS HEALTHCARE LDA» listado como CANDIDATO de revisão e NÃO agrupado");
    check(!rel.candidatosParaRevisao.some((c) => c.fabricante === "SERVIER"), "B14: fabricante sem semelhança não aparece como candidato");
    check(rel.clustersSoltos.some((c) => c.chave === "NOVARTIS" && c.fabricantes.length === 2), "B15: fabricantes sem grupo parecidos entre si (Novartis) listados para revisão");
    const dez = rel.casosMaisDeDezNomes.find((c) => c.grupo === "Viatris");
    check(rel.casosMaisDeDezNomes.length === 1 && !!dez && dez.variantes === 12 && dez.todasAgrupadas && dez.variantesEmFalta.length === 0, "B16: secção «mais de dez nomes»: as 12 variantes estão TODAS agrupadas");
    check(!!dez && dez.produtosDosMembros === 13 && dez.produtosDosMembrosNoGrupo === 12, `B17: produtos dos membros ${dez?.produtosDosMembros}, no grupo ${dez?.produtosDosMembrosNoGrupo} (1 sem linha)`);
    const tipos = new Set(rel.ambiguidades.map((a) => a.tipo));
    check(tipos.has("alias de grupo partilhado") && rel.ambiguidades.some((a) => /UPJOHN/.test(a.detalhe)), "B18: alias de grupo partilhado entre grupos (Upjohn)");
    check(tipos.has("regra CNP contra o grupo do fabricante") && tipos.has("produto com grupo ≠ grupo do fabricante"), "B19: regra CNP contra o grupo do fabricante e produto com grupo ≠ grupo do fabricante");
    const md = A.renderizarMarkdown(rel, 5);
    check(/Casos com mais de dez nomes/.test(md) && /TODAS agrupadas/.test(md) && /REVISÃO HUMANA/.test(md), "B20: o Markdown tem as secções pedidas");
        check(!md.includes("test@") && !JSON.stringify(rel).includes(":test@"), "B22: o relatório não contém credenciais");

    // ── C · não escreve ─────────────────────────────────────────────────────────────────────────────────────────
    console.log("\nC · não escreve");
    await new Promise((r) => setTimeout(r, 600));
    const depois = await instantaneo();
    const diferentes = Object.keys(antes).filter((k) => true && antes[k] !== depois[k]);
    check(diferentes.length === 0, `C1: contagens e xmin de ${tabelas.length} tabelas iguais antes/depois`, diferentes.join(", "));
        const ro = new Client({ connectionString: urlDe(db), options: "-c default_transaction_read_only=on" });
    await ro.connect();
    let escritaRecusada = false;
    try { await ro.query(`UPDATE "Fabricante" SET "nomeNormalizado" = "nomeNormalizado"`); } catch (e) { escritaRecusada = /read-only/i.test((e as Error).message); }
    await ro.end();
    check(escritaRecusada, "C3: com as opções de sessão do script, uma escrita é rejeitada pela própria base («read-only transaction»)");
    const fonte = readFileSync("scripts/diagnostics/auditoria-fabricantes-grupos-garantia.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    check(!/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE)\b\s+(INTO|"|TABLE|FROM|SET)/i.test(fonte.replace(/`[^`]*SELECT[^`]*`/g, "")) && !/\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/.test(fonte), "C4: estrutural — o script só tem SELECT (nenhum create/update/delete)");
    check(/READ ONLY/.test(fonte) && /default_transaction_read_only=on/.test(fonte) && /transaction_read_only/.test(fonte), "C5: estrutural — transacção READ ONLY, sessão read-only e verificação antes de consultar");

    // ── D · CLI ─────────────────────────────────────────────────────────────────────────────────────────────────
    console.log("\nD · CLI (processo real)");
    await admin.query(`CREATE ROLE auditor_ro LOGIN PASSWORD '${SEGREDO}'`);
    await admin.query(`GRANT CONNECT ON DATABASE ${db} TO auditor_ro`);
    const c2 = new Client({ connectionString: urlDe(db) });
    await c2.connect();
    await c2.query(`GRANT USAGE ON SCHEMA public TO auditor_ro; GRANT SELECT ON ALL TABLES IN SCHEMA public TO auditor_ro;`);
    await c2.end();
    const cli = (args: string[]) => spawnSync("npx", ["tsx", "scripts/diagnostics/auditoria-fabricantes-grupos-garantia.ts", ...args], { encoding: "utf8", shell: true, env: { ...process.env, DATABASE_URL: urlDe(db), AUDITORIA_DATABASE_URL: "" } });
    const urlRo = urlDe(db, "auditor_ro", SEGREDO);
    const semConf = cli(["--url", urlRo]);
    check(semConf.status !== 0 && /--confirmo-read-only/.test(semConf.stderr) && !(semConf.stdout + semConf.stderr).includes(SEGREDO), "D1: sem --confirmo-read-only recusa (código ≠ 0) e não imprime a password");
    const semUrl = cli(["--confirmo-read-only"]);
    check(semUrl.status !== 0 && /explicitamente/.test(semUrl.stderr), "D2: sem URL explícita recusa, mesmo com DATABASE_URL definida");
    const outMd = join(tmp, "rel.md");
    const outJson = join(tmp, "rel.json");
    const r1 = cli(["--confirmo-read-only", "--url", urlRo, "--out", outMd, "--top", "5"]);
    check(r1.status === 0 && /Auditoria de fabricantes/.test(r1.stdout), "D3: com role só-de-leitura corre e imprime o relatório", r1.stderr.slice(0, 300));
    check(!(r1.stdout + r1.stderr).includes(SEGREDO), "D4: a password NÃO aparece na consola (stdout/stderr)");
    check(existsSync(outMd) && !readFileSync(outMd, "utf8").includes(SEGREDO) && /Casos com mais de dez nomes/.test(readFileSync(outMd, "utf8")), "D5: --out .md escrito, sem password");
    const r2 = cli(["--confirmo-read-only", urlRo, "--out", outJson]);
    const j = existsSync(outJson) ? JSON.parse(readFileSync(outJson, "utf8")) : null;
    check(r2.status === 0 && !!j && j.gruposAtivos === 2 && !JSON.stringify(j).includes(SEGREDO) && !(r2.stdout + r2.stderr).includes(SEGREDO), "D6: --out .json válido (gruposAtivos=2), sem password");
    const r3 = cli(["--confirmo-read-only", "--url", urlDe(db, "auditor_ro", "palavra-passe-errada-XYZ")]);
    check(r3.status !== 0 && !(r3.stdout + r3.stderr).includes("palavra-passe-errada-XYZ") && !(r3.stdout + r3.stderr).includes(SEGREDO), "D7: falha de autenticação não revela a password usada");
    const r4 = cli(["--confirmo-read-only", "--url", urlDe("base_inexistente_zz", "auditor_ro", SEGREDO)]);
    check(r4.status !== 0 && !(r4.stdout + r4.stderr).includes(SEGREDO), "D8: base inexistente: erro sem password");
    const masc = A.mascararSegredos(`falhou em postgresql://auditor_ro:${SEGREDO}@h:5432/x e ${SEGREDO}`, urlRo);
    check(!masc.includes(SEGREDO), "D9: mascararSegredos remove a password de qualquer texto");
    await new Promise((r) => setTimeout(r, 300));
    const depoisCli = await instantaneo();
    check(Object.keys(antes).every((k) => antes[k] === depoisCli[k]), "D10: após as execuções CLI as tabelas continuam idênticas (xmin)");

    await prisma.$disconnect();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS auditor_ro`).catch(() => undefined);
    await admin.end();
  }

  console.log(`\n${ok} ok, ${ko} falhas`);
  process.exit(ko === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
