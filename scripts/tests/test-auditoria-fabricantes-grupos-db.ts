/**
 * scripts/tests/test-auditoria-fabricantes-grupos-db.ts
 *
 * Auditoria READ-ONLY de fabricantes/grupos (scripts/diagnostics/auditoria-fabricantes-grupos-garantia.ts), tal como corre
 * no contentor `migrate` — PostgreSQL REAL e DESCARTÁVEL, dados sintéticos, control plane + tenant descartáveis:
 *   A · argumentos: recusa sem --confirmo-read-only, recusa QUALQUER URL (--url e posicional) sem a repetir, valida o slug;
 *   B · conteúdo: antes/depois (listas), top de grupos, >10 variantes (todas agrupadas?), membros com tipo/validação/
 *       aliases, regras CNP e produtos manuais com CNP, produtos por grupo, incluídos por regra com fabricante fora do grupo
 *       (+ obsoleto), candidatos por semelhança (SÓ listados), ambiguidades;
 *   C · não escreve: contagens e xmin de todas as tabelas (tenant e control plane) iguais antes/depois; a sessão rejeita
 *       escritas; estrutura só com SELECT;
 *   D · CLI (processo real, como no contentor): ligação resolvida pelo control plane (CONTROL_DATABASE_URL +
 *       TENANT_ENCRYPTION_SECRET); recusa sem confirmação / slug inexistente / tenant inativo / --out-dir em falta;
 *       com role só de leitura E com superutilizador corre sem escrever; relatório .md/.json SÓ no --out-dir; password,
 *       host:porta, URLs e chaves NUNCA aparecem em stdout/stderr/ficheiros.
 *
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres npx tsx scripts/tests/test-auditoria-fabricantes-grupos-db.ts
 */
import { readFileSync, readdirSync, existsSync, rmSync, mkdtempSync, mkdirSync } from "node:fs";
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
  console.error(`RECUSADO: ${host} não é uma base local descartável (este TESTE só corre em bases descartáveis).`);
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
const CHAVE_TENANT = "chave-cifra-tenants-teste-0123456789abcdef";
const SCRIPT = "scripts/diagnostics/auditoria-fabricantes-grupos-garantia.ts";

async function main() {
  const sufixo = Date.now().toString(36);
  const db = `spharm_audit_t_${sufixo}`;
  const dbControl = `spharm_audit_c_${sufixo}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${db}`);
  await admin.query(`CREATE DATABASE ${dbControl}`);
  const tmp = mkdtempSync(join(tmpdir(), "audit-fab-"));
  try {
    execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: urlDe(db) }, encoding: "utf8", stdio: "pipe" });
    execSync("npx prisma migrate deploy --config prisma-control.config.ts", { env: { ...process.env, CONTROL_DATABASE_URL: urlDe(dbControl) }, encoding: "utf8", stdio: "pipe" });
    const { PrismaClient } = await import("../../generated/prisma/client");
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(db) }) });
    process.env.TENANT_ENCRYPTION_SECRET = CHAVE_TENANT;
    const A = await import("../diagnostics/auditoria-fabricantes-grupos-garantia");
    const { encryptTenantSecret } = await import("../../lib/tenant-crypto");

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
    await prisma.regraGrupoLaboratorialPorCnp.create({ data: { cnp: pCruzado.cnp, grupoLaboratorialId: grupoViatris.id, validadoManualmente: true } });
    // regra órfã (nenhum produto com este CNP)
    const CNP_ORFAO = 9_999_001;
    await prisma.regraGrupoLaboratorialPorCnp.create({ data: { cnp: CNP_ORFAO, grupoLaboratorialId: grupoOrganon.id } });
    // semelhantes sem prova
    const fabParecido = await prisma.fabricante.create({ data: { nomeNormalizado: "VIATRIS HEALTHCARE LDA" } });
    await mkProd("Parecido p", fabParecido.id);
    const fabSolto1 = await prisma.fabricante.create({ data: { nomeNormalizado: "NOVARTIS FARMA LDA" } });
    const fabSolto2 = await prisma.fabricante.create({ data: { nomeNormalizado: "NOVARTIS PORTUGAL SA" } });
    await mkProd("Novartis a", fabSolto1.id);
    await mkProd("Novartis b", fabSolto2.id);
    const fabIndep = await prisma.fabricante.create({ data: { nomeNormalizado: "SERVIER" } });
    await mkProd("Servier p", fabIndep.id);

    // ── Control plane descartável + tenants ─────────────────────────────────────────────────────────────────────
    await admin.query(`CREATE ROLE auditor_ro LOGIN PASSWORD '${SEGREDO}'`);
    await admin.query(`GRANT CONNECT ON DATABASE ${db} TO auditor_ro`);
    const c2 = new Client({ connectionString: urlDe(db) });
    await c2.connect();
    await c2.query(`GRANT USAGE ON SCHEMA public TO auditor_ro; GRANT SELECT ON ALL TABLES IN SCHEMA public TO auditor_ro;`);
    await c2.end();
    const { PrismaClient: ControlClient } = await import("../../generated/prisma-control/client");
    const control = new ControlClient({ adapter: new PrismaPg({ connectionString: urlDe(dbControl) }) });
    const adminU = new URL(ADMIN_URL);
    const novoTenant = (slug: string, dbUser: string, pass: string, estado: "ACTIVE" | "SUSPENDED" = "ACTIVE", cifrada?: string) =>
      control.tenant.create({
        data: { slug, nome: slug, estado, dbHost: adminU.hostname, dbPort: Number(adminU.port), dbName: db, dbUser, dbPassEncrypted: cifrada ?? encryptTenantSecret(pass) },
      });
    const tRo = await novoTenant("garantia", "auditor_ro", SEGREDO);
    await novoTenant("privilegiado", decodeURIComponent(adminU.username), decodeURIComponent(adminU.password));
    await novoTenant("suspenso", "auditor_ro", SEGREDO, "SUSPENDED");
    await novoTenant("senha-errada", "auditor_ro", "palavra-passe-errada-XYZ");
    await control.$disconnect();
    const cifradaGarantia = tRo.dbPassEncrypted;

    const envBase = (extra: Record<string, string | undefined> = {}) => {
      const e: Record<string, string | undefined> = { ...process.env, CONTROL_DATABASE_URL: urlDe(dbControl), TENANT_ENCRYPTION_SECRET: CHAVE_TENANT, ...extra };
      delete e.DATABASE_URL;
      return e as NodeJS.ProcessEnv;
    };
    const cli = (args: string[], extra: Record<string, string | undefined> = {}) =>
      spawnSync("npx", ["tsx", SCRIPT, ...args], { encoding: "utf8", shell: true, env: envBase(extra) });
    const tudo = (r: { stdout: string; stderr: string }) => r.stdout + r.stderr;
    // Valores que NUNCA podem aparecer em saída nenhuma.
    const PROIBIDOS = [SEGREDO, "palavra-passe-errada-XYZ", CHAVE_TENANT, cifradaGarantia, "auditor_ro:", "postgresql://", "postgres://", `${adminU.hostname}:${adminU.port}`, decodeURIComponent(adminU.password) === "test" ? ":test@" : decodeURIComponent(adminU.password)];
    const semSegredos = (txt: string) => PROIBIDOS.every((v) => !txt.includes(v));

    // ── A · argumentos ──────────────────────────────────────────────────────────────────────────────────────────
    console.log("A · argumentos e recusas");
    const recusa = (argv: string[]) => { try { A.lerArgumentos(argv); return null; } catch (e) { return (e as Error).message; } };
    check(/--confirmo-read-only/.test(recusa([]) ?? ""), "A1: recusa sem --confirmo-read-only");
    const mUrl = recusa(["--confirmo-read-only", "--url", urlDe(db, "u", SEGREDO)]) ?? "";
    check(/NÃO aceita URL/.test(mUrl) && !mUrl.includes(SEGREDO) && !mUrl.includes("postgresql"), "A2: recusa --url e não repete o valor");
    const mPos = recusa(["--confirmo-read-only", urlDe(db, "u", SEGREDO)]) ?? "";
    check(/NÃO aceita URL/.test(mPos) && !mPos.includes(SEGREDO), "A3: recusa URL posicional e não a repete");
    check(/tenant inválido/.test(recusa(["--confirmo-read-only", "--tenant", "../x"]) ?? "") && /tenant inválido/.test(recusa(["--confirmo-read-only", "--tenant", "A_B"]) ?? ""), "A4: valida o slug (sem caminhos nem maiúsculas)");
    const defeitos = A.lerArgumentos(["--confirmo-read-only"]);
    check(defeitos.tenant === "garantia" && defeitos.outDir === "/relatorios" && defeitos.top === 15, "A5: por omissão tenant=garantia, --out-dir=/relatorios, --top=15");
    check(/--top/.test(recusa(["--confirmo-read-only", "--top", "0"]) ?? "") && /desconhecido/.test(recusa(["--confirmo-read-only", "--x"]) ?? ""), "A6: --top e argumentos desconhecidos validados");
    check(/^auditoria-fabricantes-garantia-\d{8}T\d{6}Z$/.test(A.nomeBaseRelatorio("garantia", new Date("2026-10-29T08:09:10.123Z"))) && A.nomeBaseRelatorio("garantia", new Date("2026-10-29T08:09:10.123Z")) === "auditoria-fabricantes-garantia-20261029T080910Z", "A7: nome do ficheiro = auditoria-fabricantes-<slug>-<UTC>");
    let semDir = "";
    try { A.verificarDiretorioSaida(join(tmp, "nao-existe")); } catch (e) { semDir = (e as Error).message; }
    check(/não existe/.test(semDir) && !existsSync(join(tmp, "nao-existe")), "A8: --out-dir inexistente é recusado e NÃO é criado");
    const m = A.mascararSegredos(`falhou em postgresql://auditor_ro:${SEGREDO}@h:5432/x e ${SEGREDO} em db.interno:5432`, urlDe(db, "auditor_ro", SEGREDO), "db.interno:5432");
    check(!m.includes(SEGREDO) && !m.includes("db.interno"), "A9: mascararSegredos remove password, URL e host:porta de qualquer texto");

    // ── C0 · instantâneo antes ──────────────────────────────────────────────────────────────────────────────────
    const tabelas = ["Fabricante", "FabricanteAlias", "Produto", "GrupoLaboratorial", "GrupoLaboratorialAlias", "GrupoLaboratorialFabricante", "ProdutoGrupoLaboratorial", "RegraGrupoLaboratorialPorCnp"];
    const instantaneo = async (conn: string, lista: string[]) => {
      const c = new Client({ connectionString: conn });
      await c.connect();
      const out: Record<string, string> = {};
      for (const t of lista) {
        const r = await c.query(`SELECT count(*)::text AS n, coalesce(md5(string_agg(xmin::text || ':' || ctid::text, ',' ORDER BY ctid)), '') AS h FROM "${t}"`);
        out[t] = `${r.rows[0].n}/${r.rows[0].h}`;
      }
      await c.end();
      return out;
    };
    const tabelasControl = ["Tenant", "TenantEvent"];
    await new Promise((r) => setTimeout(r, 600)); // deixa as estatísticas assentarem
    const antes = await instantaneo(urlDe(db), tabelas);
    const antesControl = await instantaneo(urlDe(dbControl), tabelasControl);

    // ── B · conteúdo ────────────────────────────────────────────────────────────────────────────────────────────
    console.log("\nB · conteúdo do relatório");
    const rel = await A.executarAuditoria(urlDe(db), 5, "tenant garantia · base teste", "garantia");
    const totalFab = await prisma.fabricante.count();
    check(rel.fabricantesAtivos === totalFab && rel.fabricantesApresentadosAntes === totalFab, `B1: antes = fabricantes ativos com produtos (${rel.fabricantesApresentadosAntes} de ${totalFab})`);
    check(rel.opcoesDepois === totalFab - 12 - 1 + 2, `B2: depois = ${rel.opcoesDepois} (2 grupos + ${totalFab - 13} fabricantes sem prova; as 13 variantes vivem nos grupos)`);
    check(rel.opcoesAntesLista.length === totalFab && rel.opcoesDepoisLista.length === rel.opcoesDepois, "B2b: as listas antes/depois estão completas (uma entrada por opção)");
    const dViatris = rel.opcoesDepoisLista.find((o) => o.tipo === "grupo" && o.nome === "Viatris");
    check(!!dViatris && dViatris.variantes === 12 && !rel.opcoesDepoisLista.some((o) => o.tipo === "fabricante" && o.nome.startsWith("VIATRIS UNIDADE")), "B2c: depois — Viatris com 12 variantes e nenhuma variante como opção de topo");
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
    const rv = gv.regrasCnp.find((r) => r.cnp === pRegra.cnp);
    check(gv.regrasCnp.length === 2 && !!rv && rv.produtoExiste && rv.validadoManualmente && !rv.fabricanteEMembro && rv.origemAtual === "REGRA_CNP" && gv.regrasCnp.some((r) => r.cnp === pCruzado.cnp && r.grupoAtualDoProduto === "Viatris"), "B20: regras CNP do grupo com CNP, estado, validação e onde o produto está");
    check(go.regrasCnp.length === 1 && go.regrasCnp[0]!.cnp === CNP_ORFAO && !go.regrasCnp[0]!.produtoExiste, "B21: regra CNP órfã (sem produto) assinalada");
    check(gv.produtosManuais.length === 2 && gv.produtosManuais.some((p) => p.cnp === pManual.cnp && !p.fabricanteEMembro) && gv.produtosManuais.some((p) => p.cnp === pCruzado.cnp), "B22: produtos colocados manualmente listados com CNP");
    const md = A.renderizarMarkdown(rel, 5);
    const secoes = ["## Resumo", "Top 5 grupos por variantes", "## Casos com mais de dez nomes", "TODAS agrupadas", "## Opções ANTES", "## Opções DEPOIS", "Nome canónico: Viatris", "RELAÇÃO MANUAL", "Regras CNP (2)", `CNP ${pRegra.cnp}`, `CNP ${CNP_ORFAO}`, "SEM produto com este CNP", "Produtos colocados manualmente (2)", "aliases: MYLAN ANTIGA", "REVISÃO HUMANA", "## Ambiguidades"];
    const emFalta = secoes.filter((x) => !md.includes(x));
    check(emFalta.length === 0, "B23: o Markdown tem as secções pedidas", emFalta.join(" | "));
    check(!md.includes(":test@") && !JSON.stringify(rel).includes(":test@") && !/postgres(ql)?:\/\//.test(md + JSON.stringify(rel)), "B24: o relatório não contém credenciais nem URLs");

    // ── C · não escreve ─────────────────────────────────────────────────────────────────────────────────────────
    console.log("\nC · não escreve");
    await new Promise((r) => setTimeout(r, 600));
    const depois = await instantaneo(urlDe(db), tabelas);
    const diferentes = Object.keys(antes).filter((k) => antes[k] !== depois[k]);
    check(diferentes.length === 0, `C1: contagens e xmin de ${tabelas.length} tabelas iguais antes/depois`, diferentes.join(", "));
    const ro = new Client({ connectionString: urlDe(db), options: "-c default_transaction_read_only=on" });
    await ro.connect();
    let escritaRecusada = false;
    try { await ro.query(`UPDATE "Fabricante" SET "nomeNormalizado" = "nomeNormalizado"`); } catch (e) { escritaRecusada = /read-only/i.test((e as Error).message); }
    await ro.end();
    check(escritaRecusada, "C3: com as opções de sessão do script, uma escrita é rejeitada pela própria base («read-only transaction»)");
    const fonte = readFileSync(SCRIPT, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    check(!/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE)\b\s+(INTO|"|TABLE|FROM|SET)/i.test(fonte.replace(/`[^`]*SELECT[^`]*`/g, "")) && !/\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/.test(fonte), "C4: estrutural — o script só tem SELECT (nenhum create/update/delete)");
    check((fonte.match(/transaction_read_only/g) ?? []).length >= 4 && (fonte.match(/default_transaction_read_only=on|OPCOES_SESSAO_READ_ONLY/g) ?? []).length >= 3 && (fonte.match(/READ ONLY/g) ?? []).length >= 2, "C5: estrutural — as DUAS ligações (control plane e tenant) com transacção READ ONLY, sessão read-only e SHOW antes de consultar");

    // ── D · CLI (como no contentor) ─────────────────────────────────────────────────────────────────────────────
    console.log("\nD · CLI (processo real, ligação pelo control plane)");
    const saida = (nome: string) => { const d = join(tmp, nome); mkdirSync(d); return d; };
    const vazio = (d: string) => readdirSync(d).length === 0;
    const dRecusa = saida("recusas");

    const semConf = cli(["--out-dir", dRecusa]);
    check(semConf.status !== 0 && /--confirmo-read-only/.test(semConf.stderr) && semSegredos(tudo(semConf)) && vazio(dRecusa), "D1: sem --confirmo-read-only recusa (código ≠ 0), não escreve nada");
    const comUrl = cli(["--confirmo-read-only", "--url", urlDe(db, "auditor_ro", SEGREDO), "--out-dir", dRecusa]);
    check(comUrl.status !== 0 && /NÃO aceita URL/.test(comUrl.stderr) && semSegredos(tudo(comUrl)) && vazio(dRecusa), "D2: --url é recusado sem repetir o valor");
    const slugMau = cli(["--confirmo-read-only", "--tenant", "garantia-que-nao-existe", "--out-dir", dRecusa]);
    check(slugMau.status !== 0 && /não existe no control plane/.test(slugMau.stderr) && semSegredos(tudo(slugMau)) && vazio(dRecusa), "D3: slug inexistente é recusado (lista os slugs registados) e não escreve nada");
    const suspenso = cli(["--confirmo-read-only", "--tenant", "suspenso", "--out-dir", dRecusa]);
    check(suspenso.status !== 0 && /SUSPENDED/.test(suspenso.stderr) && vazio(dRecusa), "D4: tenant não ACTIVE é recusado");
    const semDirCli = cli(["--confirmo-read-only", "--out-dir", join(tmp, "nao-existe-2")]);
    check(semDirCli.status !== 0 && /não existe/.test(semDirCli.stderr) && !existsSync(join(tmp, "nao-existe-2")) && semSegredos(tudo(semDirCli)), "D5: --out-dir inexistente: erro claro, diretório NÃO criado");
    const semEnv = cli(["--confirmo-read-only", "--out-dir", dRecusa], { CONTROL_DATABASE_URL: "" });
    check(semEnv.status !== 0 && /CONTROL_DATABASE_URL em falta/.test(semEnv.stderr) && vazio(dRecusa), "D6: sem CONTROL_DATABASE_URL no ambiente recusa");
    const chaveErrada = cli(["--confirmo-read-only", "--out-dir", dRecusa], { TENANT_ENCRYPTION_SECRET: "outra-chave-qualquer-0123456789abcdef" });
    check(chaveErrada.status !== 0 && /decifrar/.test(chaveErrada.stderr) && semSegredos(tudo(chaveErrada)) && !tudo(chaveErrada).includes("outra-chave-qualquer") && vazio(dRecusa), "D7: chave de cifra errada: erro sem revelar chaves");
    const senhaErrada = cli(["--confirmo-read-only", "--tenant", "senha-errada", "--out-dir", dRecusa]);
    check(senhaErrada.status !== 0 && semSegredos(tudo(senhaErrada)) && vazio(dRecusa), "D8: falha de autenticação no tenant não revela password, host:porta nem URL", tudo(senhaErrada).slice(0, 300));

    const dOk = saida("ok");
    const r1 = cli(["--confirmo-read-only", "--out-dir", dOk, "--top", "5"]);
    check(r1.status === 0 && /Auditoria de fabricantes \(só leitura\) — tenant garantia/.test(r1.stdout), "D9: com role só-de-leitura (tenant por omissão = garantia) corre e imprime o resumo", r1.stderr.slice(0, 400));
    check(semSegredos(tudo(r1)) && !/VIATRIS|Pfizer/i.test(r1.stdout), "D10: a consola só tem o resumo — sem credenciais, hosts nem dados do relatório");
    const ficheiros = readdirSync(dOk).sort();
    check(ficheiros.length === 2 && ficheiros.filter((f) => /^auditoria-fabricantes-garantia-\d{8}T\d{6}Z\.md$/.test(f)).length === 1 && ficheiros.filter((f) => /^auditoria-fabricantes-garantia-\d{8}T\d{6}Z\.json$/.test(f)).length === 1, `D11: grava exatamente .md e .json em --out-dir (${ficheiros.join(", ")})`);
    const mdCli = readFileSync(join(dOk, ficheiros.find((f) => f.endsWith(".md"))!), "utf8");
    const jsonTxt = readFileSync(join(dOk, ficheiros.find((f) => f.endsWith(".json"))!), "utf8");
    const j = JSON.parse(jsonTxt);
    check(semSegredos(mdCli) && semSegredos(jsonTxt), "D12: nem o .md nem o .json contêm password, host:porta, URLs ou chaves");
    check(secoes.every((x) => mdCli.includes(x)), "D13: o .md gravado tem todas as secções");
    check(j.tenant === "garantia" && j.gruposAtivos === 2 && j.casosMaisDeDezNomes[0]?.todasAgrupadas === true && j.opcoesAntesLista.length === totalFab && j.grupos.find((g: { nome: string }) => g.nome === "Viatris")?.regrasCnp.length === 2, "D14: .json válido (tenant, grupos, >10 variantes agrupadas, listas antes/depois, regras CNP)");
    check(j.base === "tenant garantia · base " + db, "D15: o relatório identifica tenant e nome da base, nunca o host");

    const dPriv = saida("privilegiado");
    const r2 = cli(["--confirmo-read-only", "--tenant", "privilegiado", "--out-dir", dPriv]);
    check(r2.status === 0 && readdirSync(dPriv).length === 2 && semSegredos(tudo(r2)), "D16: mesmo ligado com SUPERUTILIZADOR a auditoria corre (a sessão é read-only por construção)", r2.stderr.slice(0, 300));
    // O mesmo diretório pai não ganha ficheiros: só os dois ficheiros dentro de cada --out-dir.
    check(readdirSync(tmp).sort().join(",") === ["ok", "privilegiado", "recusas"].join(","), "D17: nada é escrito fora dos --out-dir");

    await new Promise((r) => setTimeout(r, 300));
    const depoisCli = await instantaneo(urlDe(db), tabelas);
    const depoisControl = await instantaneo(urlDe(dbControl), tabelasControl);
    check(Object.keys(antes).every((k) => antes[k] === depoisCli[k]), "D18: após as execuções CLI as tabelas do tenant continuam idênticas (contagens + xmin)");
    check(Object.keys(antesControl).every((k) => antesControl[k] === depoisControl[k]), "D19: o control plane continua idêntico (nenhum TenantEvent, nenhuma linha alterada)");

    await prisma.$disconnect();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS ${dbControl} WITH (FORCE)`).catch(() => undefined);
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
