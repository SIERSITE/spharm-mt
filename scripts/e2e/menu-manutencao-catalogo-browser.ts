/**
 * scripts/e2e/menu-manutencao-catalogo-browser.ts
 *
 * Ensaio de browser real (Chromium via Playwright) contra `next start` local +
 * PostgreSQL descartável: a entrada de menu «Manutenção do catálogo».
 *
 *   createdb … ; prisma migrate deploy ; next build ; _start-server.sh  (ver os restantes ensaios)
 *   E2E_DATABASE_URL=postgresql://postgres:test@localhost:55494/spharm_e2e_menu npx tsx scripts/e2e/menu-manutencao-catalogo-browser.ts
 *
 * SEM sessões forjadas e SEM forjar `x-tenant-slug`: o utilizador faz LOGIN pelo
 * formulário real em cada tenant (o tenant resolve-se pelo subdomínio do Host,
 * pelo middleware normal — `silveira.localhost`, `garantia.localhost`,
 * `sier.localhost`) e a sessão fica vinculada a esse tenant.
 *
 * Valida:
 *   · Silveira: o botão aparece imediatamente abaixo de «Catálogo», abre
 *     /catalogo/manutencao, fica activo nessa rota; «Catálogo» continua.
 *   · Garantia e Sier: NÃO vêem o botão; «Catálogo» continua disponível.
 *   · Acesso directo a /catalogo/manutencao fora da Silveira é recusado (404).
 */
import { chromium, type Browser, type Page } from "playwright";
import bcrypt from "bcryptjs";

const DB = process.env.E2E_DATABASE_URL ?? "postgresql://postgres:test@localhost:55494/spharm_e2e_menu";
const PORT = process.env.E2E_PORT ?? "3100";
{
  const h = new URL(DB).hostname;
  if (h !== "localhost" && h !== "127.0.0.1") { console.error(`RECUSADO: ${h} não é local.`); process.exit(2); }
}
process.env.DATABASE_URL = DB;
const baseFor = (slug: string) => `http://${slug}.localhost:${PORT}`;

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string, detalhe?: string) {
  if (cond) { passed++; console.log(`  [OK]    ${msg}`); }
  else { failed++; console.log(`  [FALHA] ${msg}${detalhe ? `\n            ${detalhe}` : ""}`); }
}

const EMAIL = "e2e-menu@spharm.test";
const PASSWORD = "E2e-Menu-Passw0rd!";

async function seed() {
  const { PrismaClient } = await import("../../generated/prisma/client");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB }) });
  try {
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    await prisma.utilizador.upsert({
      where: { email: EMAIL },
      update: { passwordHash, estado: "ATIVO", mustChangePassword: false },
      create: { email: EMAIL, nome: "E2E Menu", perfil: "ADMINISTRADOR", passwordHash, estado: "ATIVO" },
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function login(browser: Browser, slug: string): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.goto(`${baseFor(slug)}/login`, { waitUntil: "networkidle" });
  await page.locator('input[name="email"]').fill(EMAIL);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 });
  // O menu lateral vive no AppShell: abre uma página que o use (o dashboard redirecciona/pode não o ter).
  await page.goto(`${baseFor(slug)}/encomendas`, { waitUntil: "networkidle" });
  await page.locator("aside nav a").first().waitFor({ timeout: 20000 });
  return page;
}

/** Os itens do menu lateral, por ordem (texto dos links <a> dentro do <nav>). */
async function itensDoMenu(page: Page): Promise<Array<{ texto: string; href: string; ativo: boolean }>> {
  return page.locator("aside nav a").evaluateAll((els) =>
    els.map((e) => ({
      texto: (e.textContent ?? "").trim(),
      href: e.getAttribute("href") ?? "",
      ativo: /46997b/.test(e.getAttribute("class") ?? ""),
    }))
  );
}

async function main() {
  await seed();
  // O servidor escuta em localhost/IPv6: os subdomínios têm de resolver para ::1.
  const browser = await chromium.launch({
    args: ["--host-resolver-rules=MAP silveira.localhost [::1],MAP garantia.localhost [::1],MAP sier.localhost [::1]"],
  });
  try {
    console.log("\nSilveira · login real, botão visível, abre a manutenção");
    const s = await login(browser, "silveira");
    const menuS = await itensDoMenu(s);
    const iCat = menuS.findIndex((i) => i.href === "/catalogo");
    const iMan = menuS.findIndex((i) => i.href === "/catalogo/manutencao");
    check(iCat >= 0, "Silveira: «Catálogo» está no menu");
    check(iMan >= 0 && menuS[iMan].texto.includes("Manutenção do catálogo"), "Silveira: «Manutenção do catálogo» está no menu");
    check(iMan === iCat + 1, "Silveira: aparece IMEDIATAMENTE abaixo de «Catálogo»", JSON.stringify(menuS.map((i) => i.texto)));
    check(!menuS[iMan]?.ativo, "Silveira: fora da rota, o botão não está activo");
    await s.getByRole("link", { name: "Manutenção do catálogo" }).click();
    await s.waitForURL((u) => u.pathname === "/catalogo/manutencao", { timeout: 20000 });
    await s.getByRole("heading", { name: "Manutenção em massa do catálogo" }).waitFor({ timeout: 20000 });
    check(true, "Silveira: o clique abre /catalogo/manutencao (cabeçalho da página visível)");
    const menuS2 = await itensDoMenu(s);
    check(menuS2.find((i) => i.href === "/catalogo/manutencao")?.ativo === true && menuS2.find((i) => i.href === "/catalogo")?.ativo === false, "Silveira: na rota, «Manutenção do catálogo» fica visualmente activo");
    await s.context().close();

    for (const slug of ["garantia", "sier"]) {
      console.log(`\n${slug} · login real, SEM botão, «Catálogo» disponível, acesso directo recusado`);
      const p = await login(browser, slug);
      const menu = await itensDoMenu(p);
      check(menu.some((i) => i.href === "/catalogo"), `${slug}: «Catálogo» continua no menu`);
      check(!menu.some((i) => i.href === "/catalogo/manutencao" || /Manutenção do catálogo/.test(i.texto)), `${slug}: NÃO aparece «Manutenção do catálogo»`);
      const resp = await p.goto(`${baseFor(slug)}/catalogo/manutencao`, { waitUntil: "networkidle" });
      check(resp?.status() === 404, `${slug}: o acesso directo à rota é recusado (HTTP 404)`, `status=${resp?.status()}`);
      check((await p.getByRole("heading", { name: "Manutenção em massa do catálogo" }).count()) === 0, `${slug}: a página da manutenção nunca renderiza`);
      await p.context().close();
    }
  } finally {
    await browser.close();
  }
  console.log(`\n${passed} ok, ${failed} falhas`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
