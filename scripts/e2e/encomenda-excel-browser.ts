/**
 * scripts/e2e/encomenda-excel-browser.ts
 *
 * Excel por encomenda finalizada — browser REAL contra o build de produção, control plane + PostgreSQL descartáveis:
 *   · botão «Excel» junto de Imprimir/PDF/Email em CADA encomenda finalizada (ecrã imediatamente depois de finalizar);
 *   · o ficheiro descarregado é aberto com a biblioteca de leitura: 3 colunas, sem cabeçalho, 1.ª linha = 1.º produto,
 *     tipos, uma folha, sem quantidades zero — e IGUAL ao detalhe persistido da encomenda (comparado com a BD);
 *   · cada encomenda/fornecedor só tem as SUAS linhas;
 *   · o mesmo Excel no detalhe da encomenda gravada («Imprimir · PDF · Email» → modal);
 *   · transferências NÃO têm Excel;
 *   · autorização: sem sessão 401, perfil sem permissão 403, outra farmácia 403, id inexistente (ex.: de outro tenant) 404.
 *
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres npx tsx scripts/e2e/encomenda-excel-browser.ts
 */
import fs from "node:fs";
import path from "node:path";
import Module from "node:module";
import { SignJWT } from "jose";
import * as XLSX from "xlsx";
import { chromium, type Page } from "playwright";
import { baseFor, criarAmbiente, SECRET, type Ambiente } from "./_ambiente-silveira";
import { abrirContexto, abrirModalEEscolher, gerarPropostaGrupo, semear } from "./_grupo-comum";

const M = Module as unknown as { _resolveFilename: (r: string, ...a: unknown[]) => string };
const resolverOriginal = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "server-only" ? __filename : resolverOriginal.call(this, request, ...rest);
};

let ok = 0;
let falhas = 0;
const check = (cond: boolean, msg: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${msg}`); }
  else { falhas++; console.log(`  [FALHA] ${msg}${detalhe ? `\n            ${detalhe}` : ""}`); }
};
const secao = (t: string) => console.log(`\n── ${t}`);
const EVID = path.resolve("docs/validacao-visual/2026-10-encomenda-excel");

type Linha = [number, string, number];

async function linhasDaBd(amb: Ambiente, listaId: string, fornecedor?: string | null): Promise<Linha[]> {
  const rows = await amb.prisma.linhaEncomenda.findMany({
    where: { listaEncomendaId: listaId, ...(fornecedor === undefined ? {} : { fornecedorSugeridoId: fornecedor }) },
    include: { produto: { select: { cnp: true, designacao: true } } },
  });
  return rows
    .map((l): Linha => [l.produto.cnp, l.designacaoSnapshot ?? l.produto.designacao, Number(l.quantidadeAjustada ?? 0)])
    .filter((l) => l[2] > 0)
    .sort((a, b) => a[0] - b[0]);
}

async function descarregar(page: Page, localizador: ReturnType<Page["locator"]>, nome: string): Promise<{ aoa: unknown[][]; ws: XLSX.WorkSheet; wb: XLSX.WorkBook; ficheiro: string; nomeSugerido: string }> {
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), localizador.click()]);
  const ficheiro = path.join(EVID, nome);
  await dl.saveAs(ficheiro);
  const wb = XLSX.readFile(ficheiro, { cellNF: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return { aoa: XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: true }) as unknown[][], ws, wb, ficheiro, nomeSugerido: dl.suggestedFilename() };
}

function estruturaCorreta(x: Awaited<ReturnType<typeof descarregar>>, esperado: Linha[], rotulo: string) {
  const ordenadas = [...x.aoa].map((r) => [r[0], r[1], r[2]] as Linha).sort((a, b) => a[0] - b[0]);
  check(x.wb.SheetNames.length === 1 && x.wb.SheetNames[0] === "Encomenda", `${rotulo}: uma única folha «Encomenda»`);
  check(x.aoa.length === esperado.length && x.ws["!ref"] === `A1:C${esperado.length}` && x.aoa.every((r) => r.length === 3), `${rotulo}: ${x.aoa.length} linhas × 3 colunas, nenhuma linha em branco (${x.ws["!ref"]})`);
  check(x.aoa.every((r) => typeof r[0] === "number" && typeof r[1] === "string" && typeof r[2] === "number"), `${rotulo}: CNP e quantidade são números, designação é texto`);
  check(typeof x.aoa[0][0] === "number" && !/^(CNP|Designa|Quantidade)/i.test(String(x.aoa[0][1])) && x.ws["A1"].z === "0", `${rotulo}: sem cabeçalho — a 1.ª linha é já o 1.º produto (CNP ${x.aoa[0][0]} · ${x.aoa[0][1]} · ${x.aoa[0][2]})`);
  check(JSON.stringify(ordenadas) === JSON.stringify(esperado), `${rotulo}: conteúdo IGUAL ao detalhe persistido (${esperado.length} produtos, quantidades a encomendar)`, `obtido=${JSON.stringify(ordenadas.slice(0, 3))} esperado=${JSON.stringify(esperado.slice(0, 3))}`);
  check(x.aoa.every((r) => (r[2] as number) > 0) && !Object.values(x.ws).some((c) => c && typeof c === "object" && "f" in (c as object)), `${rotulo}: nenhuma quantidade zero e nenhuma fórmula`);
}

async function main() {
  fs.mkdirSync(EVID, { recursive: true });
  const amb = await criarAmbiente("xl");
  const browser = await chromium.launch({ args: ["--host-resolver-rules=MAP silveira.localhost [::1]"] });
  try {
    const seed = await semear(amb, { multiFornecedor: true });
    const ctx = await abrirContexto(amb, browser, seed);
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 1600, height: 900 });

    // ═══ Finalizar (modo Grupo, separada por farmácia, com vários fornecedores por farmácia) ═══
    secao("1 · Imediatamente depois de finalizar");
    await gerarPropostaGrupo(page);
    await abrirModalEEscolher(page, "separada");
    await page.getByRole("button", { name: /Confirmar e finalizar/ }).click();
    await page.getByText("Encomenda finalizada").waitFor({ timeout: 40000 });
    await page.screenshot({ path: path.join(EVID, "painel-finalizacao.png"), fullPage: true });

    const secEnc = page.locator("section", { has: page.getByText("Encomendas finalizadas") });
    const itens = secEnc.locator("ul > li");
    const nEnc = await itens.count();
    check(nEnc >= 2, `a finalização gerou ${nEnc} encomendas (cada uma com os seus botões)`);
    const links = await secEnc.locator('a[href^="/encomendas/"]').evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute("href")!));
    const ids = links.map((h) => h.split("/").pop()!);
    check(new Set(ids).size === ids.length && ids.length === nEnc, "uma ligação «abrir» por encomenda (ids distintos)");

    // botões por documento: Imprimir · PDF · Excel · Email (por esta ordem) em CADA encomenda
    for (let i = 0; i < nEnc; i++) {
      const blocos = itens.nth(i).locator("div.rounded-lg");
      const nBlocos = await blocos.count();
      let todosCom4 = nBlocos > 0;
      for (let b = 0; b < nBlocos; b++) {
        const botoes = (await blocos.nth(b).locator("button, a").allInnerTexts()).map((t) => t.trim());
        if (botoes.join("|") !== "Imprimir|PDF|Excel|Email") todosCom4 = false;
      }
      check(todosCom4, `encomenda ${i + 1}: cada documento tem «Imprimir · PDF · Excel · Email» (${nBlocos} documento(s))`);
    }
    check((await page.locator("section", { has: page.getByText("Transferências geradas") }).locator('[data-testid="excel-encomenda"]').count()) === 0 && (await page.locator("section", { has: page.getByText("Transferências geradas") }).getByRole("button", { name: "Excel" }).count()) === 0, "as TRANSFERÊNCIAS não têm Excel");

    // descarregar o Excel de cada documento e comparar com a BD
    const guardados: Record<string, Linha[]> = {};
    for (let i = 0; i < nEnc; i++) {
      const id = ids[i];
      const excelLinks = itens.nth(i).locator('[data-testid="excel-encomenda"]');
      const n = await excelLinks.count();
      for (let k = 0; k < n; k++) {
        const href = (await excelLinks.nth(k).getAttribute("href"))!;
        const fornecedor = new URL(href, "http://x").searchParams.get("fornecedor");
        const esperado = await linhasDaBd(amb, id, fornecedor === null ? undefined : fornecedor === "sem" ? null : fornecedor);
        const x = await descarregar(page, excelLinks.nth(k), `enc${i + 1}-${k + 1}.xlsx`);
        estruturaCorreta(x, esperado, `encomenda ${i + 1} · documento ${k + 1}`);
        check(/^encomenda-[a-z0-9-]+\.xlsx$/.test(x.nomeSugerido), `nome do ficheiro sanitizado: ${x.nomeSugerido}`);
        guardados[`${id}|${fornecedor ?? ""}`] = esperado;
      }
    }
    // cada encomenda só tem as SUAS linhas (as farmácias partilham CNPs mas não linhas)
    const totalBd = await amb.prisma.linhaEncomenda.count({ where: { quantidadeAjustada: { gt: 0 } } });
    const totalXlsx = Object.values(guardados).reduce((s, l) => s + l.length, 0);
    check(totalXlsx === totalBd, `a soma das linhas dos Excel (${totalXlsx}) = linhas com quantidade > 0 na BD (${totalBd}): nada duplicado nem em falta`);

    // ═══ Detalhe da encomenda gravada ═══
    secao("2 · Mais tarde, no detalhe da encomenda");
    const idDet = ids[0];
    await page.goto(baseFor("silveira") + `/encomendas/${idDet}`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /Imprimir · PDF · Email/ }).click();
    await page.getByText("Documentos da encomenda").waitFor();
    await page.locator('[data-testid="excel-encomenda"]').first().waitFor({ timeout: 20000 });
    const hrefDet = (await page.locator('[data-testid="excel-encomenda"]').first().getAttribute("href"))!;
    const fornDet = new URL(hrefDet, "http://x").searchParams.get("fornecedor");
    const xDet = await descarregar(page, page.locator('[data-testid="excel-encomenda"]').first(), "detalhe.xlsx");
    estruturaCorreta(xDet, await linhasDaBd(amb, idDet, fornDet === null ? undefined : fornDet === "sem" ? null : fornDet), "detalhe");
    const guard = guardados[`${idDet}|${fornDet ?? ""}`];
    check(!!guard && JSON.stringify(xDet.aoa.map((r) => [r[0], r[1], r[2]]).sort((a, b) => (a[0] as number) - (b[0] as number))) === JSON.stringify(guard), "o Excel do detalhe é o mesmo do momento da finalização");
    await page.screenshot({ path: path.join(EVID, "detalhe-modal.png") });

    // ═══ Autorização / isolamento ═══
    secao("3 · Autorização e isolamento");
    const url = (id: string) => baseFor("silveira") + `/api/encomendas/${id}/excel`;
    const semSessao = await browser.newContext();
    const r401 = await semSessao.request.get(url(idDet));
    check(r401.status() === 401, `sem sessão → 401 (${r401.status()})`);
    const jwt = (perfil: string, farmaciaId: string | null) =>
      new SignJWT({ sub: seed.userId, email: "x@spharm.test", nome: "X", perfil, farmaciaId, tenant: "silveira" }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("1h").sign(new TextEncoder().encode(SECRET));
    const comPerfil = async (perfil: string, farmaciaId: string | null) => {
      const c = await browser.newContext();
      await c.addCookies([{ name: "session", value: await jwt(perfil, farmaciaId), url: baseFor("silveira") }]);
      return c;
    };
    const lista = await amb.prisma.listaEncomenda.findUniqueOrThrow({ where: { id: idDet }, select: { farmaciaId: true } });
    const outraFarmacia = seed.farmaciaIds.find((f) => f !== lista.farmaciaId)!;
    const rOperador = await (await comPerfil("OPERADOR", lista.farmaciaId)).request.get(url(idDet));
    check(rOperador.status() === 403, `perfil só de leitura (OPERADOR) → 403 (${rOperador.status()})`);
    const rOutra = await (await comPerfil("GESTOR_FARMACIA", outraFarmacia)).request.get(url(idDet));
    check(rOutra.status() === 403, `gestor de OUTRA farmácia → 403 (${rOutra.status()})`);
    const rPropria = await (await comPerfil("GESTOR_FARMACIA", lista.farmaciaId)).request.get(url(idDet) + (fornDet ? `?fornecedor=${fornDet}` : ""));
    check(rPropria.status() === 200 && (rPropria.headers()["content-type"] ?? "").includes("spreadsheetml"), `gestor da PRÓPRIA farmácia → 200 (${rPropria.status()})`);
    const r404 = await page.request.get(url("cmoutrotenant0000000000000"));
    check(r404.status() === 404, `id inexistente nesta base (ex.: encomenda de outro tenant) → 404 (${r404.status()})`);
    const r409 = await page.request.get(url(idDet) + "?fornecedor=fornecedor-sem-linhas");
    check(r409.status() === 409, `fornecedor sem linhas a encomendar → 409 (${r409.status()})`);
    check(rPropria.headers()["cache-control"] === "no-store", "resposta sem cache");
  } finally {
    await browser.close();
    await amb.parar();
  }
  console.log(`\n${falhas === 0 ? "PASSOU" : "FALHOU"} — ${ok} OK, ${falhas} falhas\n`);
  process.exit(falhas === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
