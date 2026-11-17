/**
 * scripts/tests/test-fabricante-renomear.ts
 *
 * «Editar nome do fabricante» (Stock › Artigo) — Silveirense + Garantia.
 *
 * Corre a lógica REAL (lib/catalogo/fabricante-renomear.ts) contra TRÊS bases
 * Postgres descartáveis e separadas, uma por "tenant" (tal como em
 * produção: uma BD por tenant). NUNCA toca em bases reais: recusa correr
 * se algum URL não for localhost.
 *
 *   TEST_DB_SILVEIRA=postgresql://user:pw@localhost:5432/t_silveira
 *   TEST_DB_GARANTIA=postgresql://user:pw@localhost:5432/t_garantia
 *   TEST_DB_OUTRO=postgresql://user:pw@localhost:5432/t_outro
 *   (todas com as migrations aplicadas)
 *
 * Corre com: npx tsx scripts/tests/test-fabricante-renomear.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "../../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  aplicarEdicaoFabricante,
  previsualizarEdicaoFabricante,
  ACAO_AUDIT_CONSOLIDADO,
  ACAO_AUDIT_RENOMEADO,
} from "../../lib/catalogo/fabricante-renomear";
import { podeRenomearFabricante } from "../../lib/catalogo/fabricante-renomear-scope";
import { catalogoManutencaoAtiva } from "../../lib/tenant-constants";
import { applyErpCatalogFields } from "../../lib/ingest/catalog-from-erp";
import type { SessionUser } from "../../lib/session-claims";

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) {
    ok++;
    console.log(`  [OK]    ${label}`);
  } else {
    ko++;
    console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`);
  }
};

function cliente(envVar: string): PrismaClient {
  const url = process.env[envVar];
  if (!url) {
    console.error(`Falta ${envVar}. Ver o cabeçalho deste ficheiro.`);
    process.exit(2);
  }
  const host = new URL(url).hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    console.error(`[recusado] ${envVar} aponta para "${host}" — só bases locais descartáveis.`);
    process.exit(2);
  }
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}

const sil = cliente("TEST_DB_SILVEIRA");
const gar = cliente("TEST_DB_GARANTIA");
const outro = cliente("TEST_DB_OUTRO");

let cnpSeq = 7_000_000;
async function seedProduto(db: PrismaClient, fabricanteId: string | null, extra: object = {}) {
  cnpSeq += 1;
  return db.produto.create({
    data: { cnp: cnpSeq, designacao: `Artigo ${cnpSeq}`, fabricanteId, ...extra },
  });
}
async function seedFab(db: PrismaClient, nome: string, extra: object = {}) {
  return db.fabricante.create({ data: { nomeNormalizado: nome, ...extra } });
}
async function limpar(db: PrismaClient) {
  await db.enrichmentSourceLog.deleteMany();
  await db.produtoFarmacia.deleteMany();
  await db.produto.deleteMany();
  await db.grupoLaboratorial.deleteMany();
  await db.fabricanteAlias.deleteMany();
  await db.fabricante.deleteMany();
  await db.auditLog.deleteMany();
  await db.utilizador.deleteMany();
  await db.farmacia.deleteMany();
}

const sessao = (perfil: string, tenant: string): SessionUser => ({
  sub: "u1",
  email: "u@x.pt",
  nome: "U",
  perfil,
  farmaciaId: null,
  tenant,
});

async function main() {
  for (const db of [sil, gar, outro]) await limpar(db);
  const userSil = await sil.utilizador.create({
    data: { email: "admin@sil.pt", nome: "Admin Sil", perfil: "ADMINISTRADOR" },
  });
  const userGar = await gar.utilizador.create({
    data: { email: "admin@gar.pt", nome: "Admin Gar", perfil: "ADMINISTRADOR" },
  });

  // ── A · tenants e permissões (a MESMA função da página e da action)
  console.log("\nA · tenants e permissões");
  const pode = (perfil: string, claim: string, pedido: string | null) => podeRenomearFabricante(sessao(perfil, claim), pedido);
  check(pode("ADMINISTRADOR", "silveira", "silveira"), "silveira (ADMINISTRADOR) pode");
  check(pode("GESTOR_GRUPO", "garantia", "garantia"), "garantia (GESTOR_GRUPO) pode");
  for (const t of ["silveirense", "grupo-silveira", "segurado", "sier", "__legacy__", "", "garantia2", "xgarantia", "Garantia", "SILVEIRA"]) {
    check(!pode("ADMINISTRADOR", t, t), `tenant ${JSON.stringify(t)} NÃO tem a funcionalidade (nem «silveirense»)`);
  }
  check(!podeRenomearFabricante(sessao("ADMINISTRADOR", "silveira"), null), "pedido sem tenant: não");
  check(!podeRenomearFabricante(sessao("ADMINISTRADOR", "silveira"), undefined), "pedido com tenant indefinido: não");
  check(!pode("GESTOR_FARMACIA", "silveira", "silveira"), "GESTOR_FARMACIA não pode (sem catalog.write)");
  check(!pode("OPERADOR", "garantia", "garantia"), "OPERADOR não pode");
  check(!pode("ADMINISTRADOR", "silveira", "garantia"), "claim da Silveira num pedido da Garantia: não pode");
  check(!pode("ADMINISTRADOR", "garantia", "silveira"), "claim da Garantia num pedido da Silveira: não pode");
  check(!pode("ADMINISTRADOR", "segurado", "silveira"), "claim de outro tenant num pedido da Silveira: não pode");
  check(!podeRenomearFabricante(null, "silveira"), "sem sessão não pode");

  // ── B · a action impõe a guarda ANTES de tocar na BD (verificação estática)
  console.log("\nB · server action impõe a guarda");
  {
    const src = readFileSync(join(process.cwd(), "app/stock/artigo/renomear-fabricante-actions.ts"), "utf8");
    const corpo = (nome: string) => src.slice(src.indexOf(`export async function ${nome}`));
    for (const nome of ["previsualizarRenomearFabricanteAction", "aplicarRenomearFabricanteAction"]) {
      const c = corpo(nome);
      const iAuth = c.indexOf("await autorizar()");
      const iPrisma = c.indexOf("getPrisma()");
      check(iAuth > 0 && iPrisma > iAuth, `${nome}: autorizar() corre antes de getPrisma()`);
    }
    check(
      /podeRenomearFabricante\(session, tenant\)/.test(src),
      "autorizar() usa podeRenomearFabricante (mesma regra da página)",
    );
    check(src.startsWith('"use server"'), "ficheiro é 'use server'");
  }

  // ── C · renomear na Silveirense (vários artigos)
  console.log("\nC · renomear na Silveirense");
  const fSil = await seedFab(sil, "LABORATORIOS ALFA LDA");
  const pSil = [await seedProduto(sil, fSil.id), await seedProduto(sil, fSil.id), await seedProduto(sil, fSil.id, { validadoManualmente: true })];
  const pSilOutroFab = await seedProduto(sil, (await seedFab(sil, "OUTRA MARCA LDA")).id);
  {
    const prev = await previsualizarEdicaoFabricante(sil, { cnp: pSil[0].cnp, novoNome: "  Laboratórios Alfa Pharma, Lda. " });
    check(prev.ok && prev.avaliacao.estado === "renomear", "preview: renomear");
    check(prev.ok && prev.nomeAtual === "LABORATORIOS ALFA LDA" && prev.novoNome === "LABORATORIOS ALFA PHARMA LDA" && prev.artigosAfetados === 3,
      "preview: nome atual, novo nome e 3 artigos afectados", JSON.stringify(prev));

    // Cancelar = não chamar aplicar: nada mudou.
    const aposPreview = await sil.fabricante.findUnique({ where: { id: fSil.id } });
    check(aposPreview?.nomeNormalizado === "LABORATORIOS ALFA LDA", "cancelar/preview não altera nada");
    check((await sil.auditLog.count()) === 0, "preview não escreve AuditLog");

    const r = await aplicarEdicaoFabricante(sil, {
      cnp: pSil[0].cnp, novoNome: "Laboratórios Alfa Pharma, Lda.", modo: "RENOMEACAO",
      artigosConfirmados: 3, actorId: userSil.id, tenantSlug: "silveira",
    });
    check(r.ok && r.modo === "RENOMEACAO" && r.artigosAfetados === 3, "aplicar: renomeação OK em 3 artigos", JSON.stringify(r));
    const depois = await sil.produto.findMany({ where: { id: { in: pSil.map((p) => p.id) } }, include: { fabricante: true } });
    check(depois.every((p) => p.fabricante?.nomeNormalizado === "LABORATORIOS ALFA PHARMA LDA"), "todos os 3 artigos mostram o novo nome");
    check(depois.every((p) => p.fabricanteId === fSil.id), "mesmo id de fabricante (nenhum artigo reatribuído)");
    check((await sil.fabricante.count()) === 2, "não criou fabricante duplicado");
    const outroArt = await sil.produto.findUnique({ where: { id: pSilOutroFab.id }, include: { fabricante: true } });
    check(outroArt?.fabricante?.nomeNormalizado === "OUTRA MARCA LDA", "artigos de outros fabricantes intactos");
    const alias = await sil.fabricanteAlias.findMany({ where: { fabricanteId: fSil.id } });
    check(alias.some((a) => a.aliasNome === "LABORATORIOS ALFA LDA"), "nome antigo guardado como alias");

    // AuditLog
    const logs = await sil.auditLog.findMany();
    check(logs.length === 1, "1 registo de AuditLog");
    const l = logs[0];
    const meta = JSON.parse(l?.metaJson ?? "{}");
    check(l?.actorId === userSil.id && l.action === ACAO_AUDIT_RENOMEADO && l.entity === "Fabricante" && l.entityId === fSil.id, "AuditLog: utilizador, acção e entidade");
    check(meta.tenant === "silveira" && meta.fabricanteAnterior === "LABORATORIOS ALFA LDA" && meta.fabricanteNovo === "LABORATORIOS ALFA PHARMA LDA" && meta.artigosAfetados === 3 && meta.modo === "RENOMEACAO" && !!meta.em,
      "AuditLog: tenant, anterior, novo, nº artigos, modo, data/hora", l?.metaJson ?? "");
    check(Math.abs(Date.now() - l!.createdAt.getTime()) < 120_000, "AuditLog: createdAt recente");
  }

  // ── D · renomear na Garantia + isolamento (mesmo nome em ambos os tenants)
  console.log("\nD · Garantia e isolamento entre tenants");
  const NOME_COMUM = "LABORATORIOS BETA LDA";
  const fGarA = await seedFab(gar, NOME_COMUM);
  const pGar = [await seedProduto(gar, fGarA.id), await seedProduto(gar, fGarA.id)];
  const fSilB = await seedFab(sil, NOME_COMUM);
  const pSilB = [await seedProduto(sil, fSilB.id), await seedProduto(sil, fSilB.id), await seedProduto(sil, fSilB.id), await seedProduto(sil, fSilB.id)];
  const fOutro = await seedFab(outro, NOME_COMUM);
  const pOutro = [await seedProduto(outro, fOutro.id)];
  {
    const r = await aplicarEdicaoFabricante(gar, {
      cnp: pGar[0].cnp, novoNome: "Laboratórios Beta Portugal Lda", modo: "RENOMEACAO",
      artigosConfirmados: 2, actorId: userGar.id, tenantSlug: "garantia",
    });
    check(r.ok && r.artigosAfetados === 2, "Garantia: renomeação OK em 2 artigos", JSON.stringify(r));
    const gNome = (await gar.fabricante.findUnique({ where: { id: fGarA.id } }))?.nomeNormalizado;
    check(gNome === "LABORATORIOS BETA PORTUGAL LDA", "Garantia: nome alterado");
    const sNome = (await sil.fabricante.findUnique({ where: { id: fSilB.id } }))?.nomeNormalizado;
    check(sNome === NOME_COMUM, "Silveirense: fabricante homónimo NÃO foi alterado");
    check((await sil.produto.count({ where: { fabricanteId: fSilB.id } })) === 4, "Silveirense: 4 artigos do homónimo intactos");
    const oNome = (await outro.fabricante.findUnique({ where: { id: fOutro.id } }))?.nomeNormalizado;
    check(oNome === NOME_COMUM && (await outro.auditLog.count()) === 0, "terceiro tenant: nome e AuditLog intactos");
    check((await sil.auditLog.count()) === 1, "AuditLog só no tenant onde houve a alteração (Silveirense continua com 1)");
    check((await gar.auditLog.count()) === 1, "AuditLog da Garantia: 1");
    // Mesmo CNP em tenants diferentes não se cruza: o preview vê só a BD do cliente recebido.
    const prevOutro = await previsualizarEdicaoFabricante(outro, { cnp: pGar[0].cnp, novoNome: "X Y" });
    check(!prevOutro.ok, "CNP de outro tenant não existe na BD deste: preview recusa");
  }

  // ── E · nome vazio / igual / equivalente / duplicado
  console.log("\nE · validações");
  const fE = await seedFab(sil, "FARMA GAMA LDA");
  const pE = [await seedProduto(sil, fE.id), await seedProduto(sil, fE.id)];
  const fE2 = await seedFab(sil, "FARMA DELTA LDA");
  const pE2 = [await seedProduto(sil, fE2.id), await seedProduto(sil, fE2.id), await seedProduto(sil, fE2.id)];
  const aplicar = (nome: string, modo: "RENOMEACAO" | "CONSOLIDACAO", n: number) =>
    aplicarEdicaoFabricante(sil, { cnp: pE[0].cnp, novoNome: nome, modo, artigosConfirmados: n, actorId: userSil.id, tenantSlug: "silveira" });
  const logsAntes = await sil.auditLog.count();
  {
    for (const [nome, rotulo] of [["", "vazio"], ["   ", "só espaços"], ["!", "sem caracteres válidos"], ["A", "1 carácter"]] as const) {
      const r = await aplicar(nome, "RENOMEACAO", 2);
      check(!r.ok && r.codigo === "INVALIDO", `rejeita nome ${rotulo}`, JSON.stringify(r));
    }
    for (const nome of ["FARMA GAMA LDA", "  farma gama lda  ", "Farma  Gama, Lda.", "fármá gáma lda"]) {
      const r = await aplicar(nome, "RENOMEACAO", 2);
      check(!r.ok && r.codigo === "IGUAL", `rejeita igual/equivalente ao atual: ${JSON.stringify(nome)}`, JSON.stringify(r));
    }
    // Duplicado: pedido de renomeação contra nome existente NÃO cria duplicado nem consolida sozinho.
    const dup = await aplicar("farma delta, lda", "RENOMEACAO", 2);
    check(!dup.ok && dup.codigo === "CONFLITO", "rejeita renomear para nome existente (equivalente por normalização)", JSON.stringify(dup));
    check((await sil.fabricante.count({ where: { nomeNormalizado: "FARMA DELTA LDA" } })) === 1, "não criou duplicado");
    check((await sil.produto.count({ where: { fabricanteId: fE.id } })) === 2, "nada consolidado automaticamente");
    // Consolidar sem existir destino.
    const semDestino = await aplicar("Nome Que Nao Existe", "CONSOLIDACAO", 2);
    check(!semDestino.ok && semDestino.codigo === "SEM_CONFLITO", "consolidar sem destino existente é recusado");
    // Contagem desatualizada.
    const stale = await aplicar("Farma Epsilon Lda", "RENOMEACAO", 99);
    check(!stale.ok && stale.codigo === "DESATUALIZADO", "contagem confirmada diferente da real: recusa");
    check((await sil.fabricante.findUnique({ where: { id: fE.id } }))?.nomeNormalizado === "FARMA GAMA LDA", "nenhuma das recusas alterou o nome");
    check((await sil.auditLog.count()) === logsAntes, "recusas não escrevem AuditLog");
    // Preview do conflito mostra destino.
    const prev = await previsualizarEdicaoFabricante(sil, { cnp: pE[0].cnp, novoNome: "Farma Delta Lda" });
    check(prev.ok && prev.avaliacao.estado === "conflito" && prev.avaliacao.destino.artigos === 3 && prev.artigosAfetados === 2,
      "preview detecta conflito e mostra destino (3 artigos) e afectados (2)", JSON.stringify(prev));
  }

  // ── F · consolidação
  console.log("\nF · consolidação");
  {
    await sil.fabricanteAlias.create({ data: { fabricanteId: fE.id, aliasNome: "Farma Gama, Lda." } });
    await sil.produto.update({ where: { id: pE[1].id }, data: { validadoManualmente: true } });
    const antes = await sil.produto.count();
    const r = await aplicar("Farma Delta Lda", "CONSOLIDACAO", 2);
    check(r.ok && r.modo === "CONSOLIDACAO" && r.artigosAfetados === 2 && r.fabricanteId === fE2.id, "consolidação OK, 2 artigos", JSON.stringify(r));
    check((await sil.produto.count()) === antes, "nenhum artigo perdido/duplicado");
    check((await sil.produto.count({ where: { fabricanteId: fE2.id } })) === 5, "destino ficou com 3 + 2 = 5 artigos");
    check((await sil.produto.count({ where: { fabricanteId: fE.id } })) === 0, "origem sem artigos");
    check((await sil.fabricante.findUnique({ where: { id: fE.id } }))?.estado === "INATIVO", "origem INATIVA (não apagada)");
    const aliasDest = (await sil.fabricanteAlias.findMany({ where: { fabricanteId: fE2.id } })).map((a) => a.aliasNome).sort();
    check(aliasDest.includes("FARMA GAMA LDA") && aliasDest.includes("Farma Gama, Lda."), "nome e alias da origem passaram para o destino", JSON.stringify(aliasDest));
    check((await sil.fabricanteAlias.count({ where: { fabricanteId: fE.id } })) === 0, "origem sem aliases");
    check((await sil.produto.findUnique({ where: { id: pE[1].id } }))?.validadoManualmente === true, "flag validadoManualmente preservada");
    const l = (await sil.auditLog.findMany({ where: { action: ACAO_AUDIT_CONSOLIDADO } }))[0];
    const m = JSON.parse(l?.metaJson ?? "{}");
    check(!!l && m.modo === "CONSOLIDACAO" && m.fabricanteAnterior === "FARMA GAMA LDA" && m.fabricanteNovo === "FARMA DELTA LDA" && m.artigosAfetados === 2 && m.tenant === "silveira" && l.actorId === userSil.id,
      "AuditLog da consolidação completo", l?.metaJson ?? "");
    check(Array.isArray(m.produtoIdsMovidos) && m.produtoIdsMovidos.length === 2 && pE.every((p) => m.produtoIdsMovidos.includes(p.id)), "AuditLog guarda os ids dos artigos movidos (rollback exacto)");
    // Idempotente/seguro: repetir já não há nada.
    const again = await aplicarEdicaoFabricante(sil, { cnp: pE[0].cnp, novoNome: "Farma Gama Lda", modo: "RENOMEACAO", artigosConfirmados: 5, actorId: userSil.id, tenantSlug: "silveira" });
    check(!again.ok, "repetir sobre o artigo já consolidado não duplica nada", JSON.stringify(again));
  }

  // ── G · aliases e sincronização, POR TENANT
  console.log("\nG · sincronização do ERP e aliases (por tenant)");
  {
    const linha = (cnp: number, fab: string) => ({ cnp, dci: null, codigoATC: null, grupoHomogeneo: null, fabricante: fab });
    const nomeDe = async (db: PrismaClient, c: number) =>
      (await db.produto.findUnique({ where: { cnp: c }, include: { fabricante: true } }))?.fabricante?.nomeNormalizado ?? null;
    const NOME_ERP = "Lab Zeta Antigo Lda";
    const ANTIGO = "LAB ZETA ANTIGO LDA";
    const NOVO = "LAB ZETA CORRIGIDO LDA";

    /** Replica o que o endpoint faz: o gate vem do tenant AUTENTICADO. */
    const opcoesDoTenant = (slug: string) => ({
      modoNuncaReescreverFabricante: slug === "silveira",
      resolverFabricantePorAlias: catalogoManutencaoAtiva(slug),
    });
    check(opcoesDoTenant("silveira").resolverFabricantePorAlias && opcoesDoTenant("garantia").resolverFabricantePorAlias, "gate do ingest: silveira e garantia ligados");
    check(!opcoesDoTenant("segurado").resolverFabricantePorAlias && !opcoesDoTenant("silveirense").resolverFabricantePorAlias, "gate do ingest: outros tenants desligados");

    // a) Silveira e Garantia: nome antigo → fabricante renomeado.
    for (const [slug, db, uid] of [["silveira", sil, userSil.id], ["garantia", gar, userGar.id]] as const) {
      const farm = await db.farmacia.create({ data: { nome: `Farmácia ${slug}` } });
      const [c1, c2, c3] = slug === "silveira" ? [8_100_001, 8_100_002, 8_100_003] : [8_200_001, 8_200_002, 8_200_003];
      for (const c of [c1, c2, c3]) await db.produto.create({ data: { cnp: c, designacao: `Z ${c}` } });
      await applyErpCatalogFields(db, [linha(c1, NOME_ERP), linha(c2, NOME_ERP)], farm.id, opcoesDoTenant(slug)); // 1.º ciclo
      check((await db.fabricante.count({ where: { nomeNormalizado: ANTIGO } })) === 1, `[${slug}] (setup) ERP criou o fabricante com o nome antigo`);
      const r = await aplicarEdicaoFabricante(db, { cnp: c1, novoNome: "Lab Zeta Corrigido Lda", modo: "RENOMEACAO", artigosConfirmados: 2, actorId: uid, tenantSlug: slug });
      check(r.ok, `[${slug}] (setup) renomeado`, JSON.stringify(r));
      // 2.º ciclo: o ERP continua a enviar o nome ANTIGO + um CNP novo (d).
      await applyErpCatalogFields(db, [linha(c1, NOME_ERP), linha(c2, NOME_ERP), linha(c3, NOME_ERP)], farm.id, opcoesDoTenant(slug));
      check((await nomeDe(db, c1)) === NOVO && (await nomeDe(db, c2)) === NOVO, `[${slug}] artigos existentes mantêm o nome corrigido`);
      check((await nomeDe(db, c3)) === NOVO, `[${slug}] (a)(d) artigo NOVO do ERP com o nome antigo fica no fabricante corrigido`);
      check((await db.fabricante.count({ where: { nomeNormalizado: ANTIGO } })) === 0, `[${slug}] o nome antigo não foi recriado`);
      await applyErpCatalogFields(db, [linha(c1, NOME_ERP), linha(c2, NOME_ERP), linha(c3, NOME_ERP)], farm.id, opcoesDoTenant(slug));
      check((await nomeDe(db, c3)) === NOVO && (await db.fabricante.count({ where: { nomeNormalizado: ANTIGO } })) === 0, `[${slug}] ciclos seguintes estáveis`);
    }

    // b) Terceiro tenant com o MESMO alias: comportamento idêntico ao de f35ea57 (sem a opção).
    {
      const farm = await outro.farmacia.create({ data: { nome: "Farmácia outro" } });
      const dono = await seedFab(outro, NOVO);
      await outro.fabricanteAlias.create({ data: { fabricanteId: dono.id, aliasNome: ANTIGO } });
      const c = 8_300_001;
      await outro.produto.create({ data: { cnp: c, designacao: "Z outro" } });
      await applyErpCatalogFields(outro, [linha(c, NOME_ERP)], farm.id, opcoesDoTenant("segurado"));
      check((await nomeDe(outro, c)) === ANTIGO, "(b) tenant não autorizado: ignora o alias e usa o nome do ERP (como em f35ea57)");
      check((await outro.fabricante.count({ where: { nomeNormalizado: ANTIGO } })) === 1, "(b) tenant não autorizado: o fabricante pelo nome do ERP foi criado como sempre");
      // Mesma resposta com a opção OMITIDA (chamada antiga) — prova de equivalência.
      const c2 = 8_300_002;
      await outro.produto.create({ data: { cnp: c2, designacao: "Z outro 2" } });
      await applyErpCatalogFields(outro, [linha(c2, NOME_ERP)], farm.id);
      check((await nomeDe(outro, c2)) === ANTIGO, "(b) sem opções (chamada antiga): igual");
    }

    // c) Um alias de um tenant nunca resolve um fabricante de outro tenant.
    {
      const NOME_SO_NA_GARANTIA = "Zeta Exclusivo Lda";
      const dono = await seedFab(gar, "ZETA EXCLUSIVO RENOMEADO LDA");
      await gar.fabricanteAlias.create({ data: { fabricanteId: dono.id, aliasNome: "ZETA EXCLUSIVO LDA" } });
      const farm = await sil.farmacia.create({ data: { nome: "Farmácia sil 2" } });
      const c = 8_400_001;
      await sil.produto.create({ data: { cnp: c, designacao: "Z cruzado" } });
      await applyErpCatalogFields(sil, [linha(c, NOME_SO_NA_GARANTIA)], farm.id, opcoesDoTenant("silveira"));
      check((await nomeDe(sil, c)) === "ZETA EXCLUSIVO LDA", "(c) alias da Garantia não resolve na Silveira (cria o seu próprio)");
      check((await sil.fabricante.count({ where: { nomeNormalizado: "ZETA EXCLUSIVO RENOMEADO LDA" } })) === 0, "(c) o fabricante da Garantia não existe na Silveira");
      check((await gar.produto.count({ where: { fabricanteId: dono.id } })) === 0, "(c) a Garantia não ganhou artigos");
    }

    // Alias AMBÍGUO (dois fabricantes com o mesmo alias) nunca resolve sozinho — mesmo nos tenants autorizados.
    {
      const f1 = await seedFab(sil, "AMBIGUO UM LDA");
      const f2 = await seedFab(sil, "AMBIGUO DOIS LDA");
      for (const f of [f1, f2]) await sil.fabricanteAlias.create({ data: { fabricanteId: f.id, aliasNome: "AMBIGUO ANTIGO LDA" } });
      const farm = (await sil.farmacia.findFirst())!;
      const c = 8_500_001;
      await sil.produto.create({ data: { cnp: c, designacao: "Z amb" } });
      await applyErpCatalogFields(sil, [linha(c, "Ambiguo Antigo Lda")], farm.id, opcoesDoTenant("silveira"));
      check((await nomeDe(sil, c)) === "AMBIGUO ANTIGO LDA", "alias ambíguo não resolve: cai na criação habitual");
    }
  }

  // ── F2 · Garantia: grupos laboratoriais
  console.log("\nF2 · consolidação e grupos laboratoriais (Garantia)");
  {
    const g1 = await gar.grupoLaboratorial.create({ data: { nome: "Grupo Um", nomeNormalizado: "GRUPO UM" } });
    const g2 = await gar.grupoLaboratorial.create({ data: { nome: "Grupo Dois", nomeNormalizado: "GRUPO DOIS" } });
    const mk = async (nome: string, grupoId: string | null) => {
      const f = await seedFab(gar, nome);
      if (grupoId) await gar.grupoLaboratorialFabricante.create({ data: { fabricanteId: f.id, grupoLaboratorialId: grupoId } });
      return { f, p: await seedProduto(gar, f.id) };
    };
    const a = await mk("GRP ORIGEM LDA", g1.id);
    await mk("GRP DESTINO OUTRO GRUPO LDA", g2.id);
    await mk("GRP DESTINO SEM GRUPO LDA", null);
    const bMesmoGrupo = await mk("GRP DESTINO MESMO GRUPO LDA", g1.id);
    const tenta = (nome: string, n = 1) => aplicarEdicaoFabricante(gar, { cnp: a.p.cnp, novoNome: nome, modo: "CONSOLIDACAO", artigosConfirmados: n, actorId: userGar.id, tenantSlug: "garantia" });
    const r1 = await tenta("GRP DESTINO OUTRO GRUPO LDA");
    check(!r1.ok && r1.codigo === "GRUPO", "consolidar entre grupos diferentes é recusado", JSON.stringify(r1));
    const r2 = await tenta("GRP DESTINO SEM GRUPO LDA");
    check(!r2.ok && r2.codigo === "GRUPO", "consolidar grupo → sem grupo é recusado", JSON.stringify(r2));
    check((await gar.produto.count({ where: { fabricanteId: a.f.id } })) === 1 && (await gar.fabricante.findUnique({ where: { id: a.f.id } }))?.estado === "ATIVO", "recusa não alterou nada");
    const rn = await aplicarEdicaoFabricante(gar, { cnp: a.p.cnp, novoNome: "GRP ORIGEM RENOMEADO LDA", modo: "RENOMEACAO", artigosConfirmados: 1, actorId: userGar.id, tenantSlug: "garantia" });
    check(rn.ok && (await gar.grupoLaboratorialFabricante.findUnique({ where: { fabricanteId: a.f.id } }))?.grupoLaboratorialId === g1.id, "renomear mantém a pertença ao grupo");
    const r3 = await aplicarEdicaoFabricante(gar, { cnp: a.p.cnp, novoNome: "GRP DESTINO MESMO GRUPO LDA", modo: "CONSOLIDACAO", artigosConfirmados: 1, actorId: userGar.id, tenantSlug: "garantia" });
    check(r3.ok && (await gar.produto.count({ where: { fabricanteId: bMesmoGrupo.f.id } })) === 2, "consolidar dentro do MESMO grupo é permitido", JSON.stringify(r3));
  }

  // ── H · artigo sem fabricante / inexistente
  console.log("\nH · casos limite");
  {
    const semFab = await seedProduto(sil, null);
    const r = await aplicarEdicaoFabricante(sil, { cnp: semFab.cnp, novoNome: "Qualquer Lda", modo: "RENOMEACAO", artigosConfirmados: 0, actorId: userSil.id, tenantSlug: "silveira" });
    check(!r.ok && r.codigo === "ARTIGO", "artigo sem fabricante: recusa");
    const inexistente = await aplicarEdicaoFabricante(sil, { cnp: 999_999_999, novoNome: "Qualquer Lda", modo: "RENOMEACAO", artigosConfirmados: 0, actorId: userSil.id, tenantSlug: "silveira" });
    check(!inexistente.ok && inexistente.codigo === "ARTIGO", "artigo inexistente: recusa");
  }

  console.log(`\n${ok} OK, ${ko} FALHA`);
  for (const db of [sil, gar, outro]) await db.$disconnect();
  process.exit(ko === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
