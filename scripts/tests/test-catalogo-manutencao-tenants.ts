/**
 * scripts/tests/test-catalogo-manutencao-tenants.ts
 *
 * Manutenção em massa do catálogo disponível em silveira E garantia (e SÓ nestes):
 *   A · função central `catalogoManutencaoAtiva` / `gruposLaboratoriaisAtivos` (unidade);
 *   B · estrutura: sem comparações dispersas `=== TENANT_CATALOGO_MASSA` no gating da manutenção; todas as server
 *       actions passam pela guarda; o menu usa a função central; a ingestão da Silveira NÃO foi tocada;
 *   C · server actions DIRECTAS (PostgreSQL descartável, `getSession`/`resolveCurrentTenantSlug`/`getPrisma` simulados):
 *       tenant não permitido (sier, outro, sem tenant) -> recusado; sem sessão / sessão de outro tenant / perfil só de
 *       leitura -> recusado; nada escrito;
 *   D · garantia e silveira: preview -> aplicar -> auditoria gravada -> reverter -> auditoria gravada;
 *   E · isolamento por base de tenant: alterar numa base não toca na outra.
 *
 * PostgreSQL REAL e DESCARTÁVEL (recusa hosts que não sejam localhost):
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres npx tsx scripts/tests/test-catalogo-manutencao-tenants.ts
 */
import Module from "node:module";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";

type Estado = { tenant: string | null; session: Record<string, unknown> | null; prisma: unknown };
const estado: Estado = { tenant: null, session: null, prisma: null };

// ── Simulação dos módulos que dependem de um pedido Next.js (cookies/headers) ──────────────────────────────────────
const M = Module as unknown as {
  _resolveFilename: (r: string, ...a: unknown[]) => string;
  _load: (r: string, ...a: unknown[]) => unknown;
};
const resolverOriginal = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "server-only" ? __filename : resolverOriginal.call(this, request, ...rest);
};
const loadOriginal = M._load;
M._load = function (request: string, ...rest: unknown[]) {
  if (request === "next/cache") return { revalidatePath: () => undefined };
  if (request === "@/lib/prisma") return { getPrisma: async () => estado.prisma };
  if (request === "@/lib/tenant-context") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const constantes = require("../../lib/tenant-constants");
    return { ...constantes, resolveCurrentTenantSlug: async () => estado.tenant };
  }
  if (request === "@/lib/auth") {
    // Réplica do contrato real de `getSession`: sessão ligada a OUTRO tenant é tratada como inexistente.
    return { getSession: async () => (estado.session && estado.session.tenant === estado.tenant ? estado.session : null) };
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

function sessao(tenant: string, perfil: string, sub: string) {
  return { sub, email: `${sub}@teste.local`, nome: "Teste", perfil, farmaciaId: null, tenant };
}

async function main() {
  const { catalogoManutencaoAtiva, gruposLaboratoriaisAtivos, TENANTS_CATALOGO_MANUTENCAO, TENANT_CATALOGO_MASSA, TENANT_DESIGNACAO_AUTORITATIVA } =
    await import("../../lib/tenant-constants");

  console.log("A · função central");
  check(catalogoManutencaoAtiva("garantia") && catalogoManutencaoAtiva("silveira"), "A1: garantia e silveira ativas");
  for (const v of ["sier", "outro", "", null, undefined, "Garantia", " garantia", "garantia ", "SILVEIRA", "__legacy__"] as Array<string | null | undefined>) {
    check(!catalogoManutencaoAtiva(v), `A2: ${JSON.stringify(v)} -> false`);
  }
  check(JSON.stringify([...TENANTS_CATALOGO_MANUTENCAO].sort()) === JSON.stringify(["garantia", "silveira"]), "A3: lista é exactamente [garantia, silveira]");
  check(gruposLaboratoriaisAtivos("garantia") && !["silveira", "sier", "", null, undefined, "Garantia"].some((v) => gruposLaboratoriaisAtivos(v as string | null | undefined)), "A4: gruposLaboratoriaisAtivos só para garantia");
  check(TENANT_CATALOGO_MASSA === "silveira" && TENANT_DESIGNACAO_AUTORITATIVA === "silveira", "A5: constantes da ingestão da Silveira intactas");

  console.log("\nB · estrutura");
  const acoes = src("app/catalogo/manutencao/actions.ts");
  const pagina = src("app/catalogo/manutencao/page.tsx");
  const shell = src("components/layout/app-shell.tsx");
  const semComentarios = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const [nome, conteudo] of [["actions", acoes], ["page", pagina], ["app-shell", shell]] as const) {
    check(!/[!=]==\s*TENANT_CATALOGO_MASSA|TENANT_CATALOGO_MASSA\s*[!=]==/.test(semComentarios(conteudo)), `B1: ${nome} sem comparação directa com TENANT_CATALOGO_MASSA`);
  }
  check(semComentarios(acoes).includes("catalogoManutencaoAtiva(tenantSlug)") && semComentarios(pagina).includes("catalogoManutencaoAtiva(tenantSlug)"), "B2: página e guarda das actions usam catalogoManutencaoAtiva");
  check(shell.includes("soTenantFn: catalogoManutencaoAtiva"), "B3: o menu «Manutenção do catálogo» usa a função central");
  const exportadas = acoes.split(/^export async function /m).slice(1);
  check(exportadas.length >= 8, `B4: ${exportadas.length} server actions exportadas`);
  const guardadas = exportadas.filter((c) => c.includes("await guardaBase()") || /(previewAction|aplicarAction)\(/.test(c));
  check(guardadas.length === exportadas.length, "B5: TODAS passam por guardaBase (directamente ou via previewAction/aplicarAction)");
  const guarda = acoes.slice(acoes.indexOf("async function guardaBase"), acoes.indexOf("type Prisma_"));
  check(guarda.indexOf("catalogoManutencaoAtiva") < guarda.indexOf("getSession()") && guarda.indexOf("getSession()") < guarda.indexOf("getPrisma()"), "B6: guarda: tenant ANTES da sessão ANTES da BD");
  check(/can\(session, "catalog\.write"\)/.test(guarda), "B7: a guarda exige catalog.write");
  check(/session\.tenant !== currentTenant/.test(src("lib/auth.ts")), "B8: getSession descarta a sessão de outro tenant");
  check(pagina.indexOf("notFound()") > 0 && pagina.indexOf("notFound()") < pagina.indexOf("getPrisma()"), "B9: a página recusa o tenant antes de qualquer query");
  const ingestao = src("app/api/ingest/v1/bootstrap/products/route.ts");
  check((ingestao.match(/ctx\.tenant\.slug === TENANT_CATALOGO_MASSA/g) ?? []).length === 2, "B10: a ingestão da Silveira continua a comparar com TENANT_CATALOGO_MASSA (inalterada)");
  check(!/silveira|fornecedor-preferencial|designacao-silveira|decidirFabricanteSilveira/i.test(semComentarios(src("lib/catalogo/manutencao-massa.ts"))), "B11: a manutenção em massa não contém lógica específica da Silveira");

  // ── Bases descartáveis ───────────────────────────────────────────────────────────────────────────────────────────
  const sufixo = Date.now().toString(36);
  const bases = { garantia: `spharm_mt_g_${sufixo}`, silveira: `spharm_mt_s_${sufixo}` };
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  for (const db of Object.values(bases)) await admin.query(`CREATE DATABASE ${db}`);

  try {
    for (const db of Object.values(bases)) execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: urlDe(db) }, encoding: "utf8" });
    const { PrismaClient } = await import("../../generated/prisma/client");
    const prismaG = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(bases.garantia) }) });
    const prismaS = new PrismaClient({ adapter: new PrismaPg({ connectionString: urlDe(bases.silveira) }) });
    const prismaPorTenant: Record<string, typeof prismaG> = { garantia: prismaG, silveira: prismaS };

    const A = await import("../../app/catalogo/manutencao/actions");

    const fixtures: Record<string, { admin: string; fabA: string; fabB: string; cnp: number; produtoId: string; cnpOutro: number }> = {};
    let cnpSeq = 7_100_000;
    for (const t of ["garantia", "silveira"] as const) {
      const p = prismaPorTenant[t];
      const u = await p.utilizador.create({ data: { email: `admin@${t}.local`, nome: `Admin ${t}`, perfil: "ADMINISTRADOR" } });
      const fabA = await p.fabricante.create({ data: { nomeNormalizado: `FAB-A-${t}`, estado: "ATIVO" } });
      const fabB = await p.fabricante.create({ data: { nomeNormalizado: `FAB-B-${t}`, estado: "ATIVO" } });
      const prod = await p.produto.create({ data: { cnp: ++cnpSeq, designacao: `Produto ${t}`, fabricanteId: fabA.id } });
      const outro = await p.produto.create({ data: { cnp: ++cnpSeq, designacao: `Outro ${t}`, fabricanteId: fabA.id } });
      fixtures[t] = { admin: u.id, fabA: fabA.id, fabB: fabB.id, cnp: prod.cnp, produtoId: prod.id, cnpOutro: outro.cnp };
    }

    const contarEscritas = async (p: typeof prismaG) => ({
      ops: await p.catalogoManutencaoOperacao.count(),
      audit: await p.auditLog.count(),
    });
    const todasAsAcoes = (fx: (typeof fixtures)[string]) => ({
      listar: () => A.listarProdutosManutencaoMassaAction({ tipo: "FABRICANTE", filtro: {} }),
      previewFab: () => A.previewManutencaoFabricanteAction({ filtro: { cnps: [fx.cnp] }, destino: { modo: "existente", id: fx.fabB } }),
      previewForn: () => A.previewManutencaoFornecedorAction({ filtro: { farmaciaIds: ["x"] }, destino: { modo: "existente", id: "x" } }),
      aplicarFab: () => A.aplicarManutencaoFabricanteAction({ filtro: { cnps: [fx.cnp] }, destino: { modo: "existente", id: fx.fabB }, snapshotHash: "forjado" }),
      aplicarForn: () => A.aplicarManutencaoFornecedorAction({ filtro: { farmaciaIds: ["x"] }, destino: { modo: "existente", id: "x" }, snapshotHash: "forjado" }),
      recentes: () => A.listarOperacoesRecentesAction(),
      reverter: () => A.reverterOperacaoAction({ operacaoId: "inexistente" }),
      pesqFab: () => A.pesquisarFabricantesAction("FAB"),
      pesqForn: () => A.pesquisarFornecedoresAction("F"),
    });
    const recusada = (r: unknown) => !!r && typeof r === "object" && (r as { ok?: boolean }).ok === false;
    const erroDe = (r: unknown) => String((r as { error?: string }).error ?? "");

    console.log("\nC · recusas (tenant / sessão / perfil) — nenhuma escrita");
    {
      const fx = fixtures.garantia;
      estado.prisma = prismaG;
      const antes = await contarEscritas(prismaG);
      const fabAntes = (await prismaG.produto.findUnique({ where: { id: fx.produtoId } }))?.fabricanteId;
      for (const tenant of ["sier", "outro", "", null]) {
        estado.tenant = tenant;
        estado.session = sessao(tenant ?? "", "ADMINISTRADOR", fx.admin);
        let todas = true;
        for (const [nome, f] of Object.entries(todasAsAcoes(fx))) {
          const r = await f();
          if (!recusada(r) || !/não disponível/.test(erroDe(r))) { todas = false; console.log(`            ${nome} -> ${JSON.stringify(r).slice(0, 120)}`); }
        }
        check(todas, `C1: tenant ${JSON.stringify(tenant)} (ADMINISTRADOR): TODAS as ${Object.keys(todasAsAcoes(fx)).length} actions recusadas`);
      }

      estado.tenant = "garantia";
      estado.session = null;
      let semSessao = true;
      for (const f of Object.values(todasAsAcoes(fx))) { const r = await f(); if (!recusada(r) || !/Sem permissão/.test(erroDe(r))) semSessao = false; }
      check(semSessao, "C2: sem sessão -> todas recusadas");

      estado.session = sessao("silveira", "ADMINISTRADOR", fx.admin); // sessão autenticada noutro tenant
      let outroTenant = true;
      for (const f of Object.values(todasAsAcoes(fx))) { const r = await f(); if (!recusada(r)) outroTenant = false; }
      check(outroTenant, "C3: sessão de OUTRO tenant (silveira) em garantia -> todas recusadas");

      for (const perfil of ["OPERADOR", "GESTOR_FARMACIA"]) {
        estado.session = sessao("garantia", perfil, fx.admin);
        let leitura = true;
        for (const f of Object.values(todasAsAcoes(fx))) { const r = await f(); if (!recusada(r) || !/Sem permissão/.test(erroDe(r))) leitura = false; }
        check(leitura, `C4: perfil ${perfil} (sem catalog.write) -> todas recusadas, incluindo as de leitura/pesquisa`);
      }

      const depois = await contarEscritas(prismaG);
      const fabDepois = (await prismaG.produto.findUnique({ where: { id: fx.produtoId } }))?.fabricanteId;
      check(JSON.stringify(antes) === JSON.stringify(depois) && fabAntes === fabDepois, "C5: nenhuma operação, auditoria ou alteração de produto foi escrita");
    }

    console.log("\nD · garantia e silveira: preview -> aplicar -> auditoria -> reverter");
    for (const t of ["garantia", "silveira"] as const) {
      const fx = fixtures[t];
      const p = prismaPorTenant[t];
      estado.tenant = t;
      estado.prisma = p;
      estado.session = sessao(t, "ADMINISTRADOR", fx.admin);

      const lista = await A.listarProdutosManutencaoMassaAction({ tipo: "FABRICANTE", filtro: { cnps: [fx.cnp] } });
      check(lista.ok === true, `D1[${t}]: listar produtos permitido`);
      const pesq = await A.pesquisarFabricantesAction("FAB");
      check(pesq.ok === true && "resultados" in pesq && pesq.resultados.length === 2, `D2[${t}]: pesquisar fabricantes devolve os da base do tenant`);

      const preview = await A.previewManutencaoFabricanteAction({ filtro: { cnps: [fx.cnp] }, destino: { modo: "existente", id: fx.fabB } });
      check(preview.ok === true && "snapshotHash" in preview, `D3[${t}]: preview ok`);
      if (!preview.ok || !("snapshotHash" in preview)) continue;
      const catalogoAntes = await p.produto.findMany({ select: { cnp: true, fabricanteId: true }, orderBy: { cnp: "asc" } });
      check(catalogoAntes.every((x) => x.fabricanteId === fx.fabA), `D4[${t}]: preview não altera dados`);

      const aplicado = await A.aplicarManutencaoFabricanteAction({
        filtro: { cnps: [fx.cnp] },
        destino: { modo: "existente", id: fx.fabB },
        snapshotHash: preview.snapshotHash,
        motivo: "teste",
      });
      check(aplicado.ok === true, `D5[${t}]: aplicar ok`);
      const alterado = await p.produto.findUnique({ where: { id: fx.produtoId } });
      const intacto = await p.produto.findFirst({ where: { cnp: fx.cnpOutro } });
      check(alterado?.fabricanteId === fx.fabB && intacto?.fabricanteId === fx.fabA, `D6[${t}]: só o produto filtrado mudou de fabricante`);
      const auditoria = await p.auditLog.findMany({ where: { action: "catalogo.manutencao_massa_aplicada" } });
      check(auditoria.length === 1 && auditoria[0].actorId === fx.admin && auditoria[0].entity === "CatalogoManutencaoOperacao", `D7[${t}]: auditoria catalogo.manutencao_massa_aplicada gravada pelo utilizador`);

      if (aplicado.ok && "operacaoId" in aplicado) {
        const rev = await A.reverterOperacaoAction({ operacaoId: aplicado.operacaoId, motivo: "teste" });
        check(rev.ok === true, `D8[${t}]: reverter ok`);
        const reposto = await p.produto.findUnique({ where: { id: fx.produtoId } });
        check(reposto?.fabricanteId === fx.fabA, `D9[${t}]: fabricante reposto`);
        const audRev = await p.auditLog.count({ where: { action: "catalogo.manutencao_massa_revertida" } });
        check(audRev === 1, `D10[${t}]: auditoria catalogo.manutencao_massa_revertida gravada`);
        const recentes = await A.listarOperacoesRecentesAction();
        check(recentes.ok === true && "operacoes" in recentes && recentes.operacoes.length >= 2, `D11[${t}]: histórico lista aplicação + reversão`);
      } else {
        check(false, `D8[${t}]: aplicar devolveu operacaoId`);
      }
    }

    console.log("\nE · isolamento por base de tenant");
    {
      // Nova alteração só em garantia: a base da silveira não pode mudar.
      const fxG = fixtures.garantia;
      const fxS = fixtures.silveira;
      const antesS = JSON.stringify({ prods: await prismaS.produto.findMany({ select: { cnp: true, fabricanteId: true }, orderBy: { cnp: "asc" } }), ...(await contarEscritas(prismaS)) });
      estado.tenant = "garantia";
      estado.prisma = prismaG;
      estado.session = sessao("garantia", "ADMINISTRADOR", fxG.admin);
      const pv = await A.previewManutencaoFabricanteAction({ filtro: { cnps: [fxG.cnp, fxG.cnpOutro] }, destino: { modo: "existente", id: fxG.fabB } });
      if (pv.ok && "snapshotHash" in pv) {
        const ap = await A.aplicarManutencaoFabricanteAction({ filtro: { cnps: [fxG.cnp, fxG.cnpOutro] }, destino: { modo: "existente", id: fxG.fabB }, snapshotHash: pv.snapshotHash });
        check(ap.ok === true, "E1: aplicar em garantia ok");
      } else check(false, "E1: preview em garantia");
      const depoisS = JSON.stringify({ prods: await prismaS.produto.findMany({ select: { cnp: true, fabricanteId: true }, orderBy: { cnp: "asc" } }), ...(await contarEscritas(prismaS)) });
      check(antesS === depoisS, "E2: a base da silveira ficou exactamente igual");
      // Um id de fabricante da silveira não existe na base da garantia: a validação do tenant recusa.
      const cruzado = await A.previewManutencaoFabricanteAction({ filtro: { cnps: [fxG.cnp], fabricanteAtualIds: [fxS.fabA] }, destino: { modo: "existente", id: fxG.fabB } });
      check(recusada(cruzado), "E3: id de outra base (silveira) é recusado em garantia");
    }

    await prismaG.$disconnect();
    await prismaS.$disconnect();
  } finally {
    for (const db of Object.values(bases)) {
      await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => undefined);
    }
    await admin.end();
  }

  console.log(`\n${ok} ok, ${ko} falhas`);
  process.exit(ko === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
