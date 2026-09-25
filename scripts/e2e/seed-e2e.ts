/**
 * scripts/e2e/seed-e2e.ts
 *
 * Dados mínimos e SINTÉTICOS para o ensaio de browser (workspaces-browser.ts).
 * Recusa correr fora de localhost.
 */
import { PrismaPg } from "@prisma/adapter-pg";

export const E2E_FARMACIAS = ["Farmacia Alfa", "Farmacia Beta", "Farmacia Gama"] as const;
export const E2E_FABRICANTES = ["LAB ALFA", "LAB BETA"] as const;

export type SeedResult = {
  userId: string;
  farmaciaIds: string[];
  produtos: Array<{ id: string; cnp: number; designacao: string; fabricante: string }>;
};

export async function seedE2E(databaseUrl: string): Promise<SeedResult> {
  const host = new URL(databaseUrl).hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Seed recusado: ${host} não é local.`);
  const { PrismaClient } = await import("../../generated/prisma/client");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  try {
    const user = await prisma.utilizador.upsert({
      where: { email: "e2e@spharm.test" },
      update: {},
      create: { email: "e2e@spharm.test", nome: "E2E Admin", perfil: "ADMINISTRADOR" },
    });
    const farmacias = [];
    for (const nome of E2E_FARMACIAS) {
      farmacias.push(await prisma.farmacia.upsert({ where: { nome }, update: {}, create: { nome } }));
    }
    const fabs = [];
    for (const nomeNormalizado of E2E_FABRICANTES) {
      fabs.push(await prisma.fabricante.upsert({ where: { nomeNormalizado }, update: {}, create: { nomeNormalizado } }));
    }
    // Artigos 1 e 2: excesso na Beta (dá matéria às Transferências/Excessos); os restantes: todas as
    // farmácias com stock 1 (as 3 compram → consolidação com 3 farmácias com linhas).
    const stockDe = (i: number, fi: number) => (i <= 2 && fi === 1 ? 60 + i : 1);
    const produtos: SeedResult["produtos"] = [];
    const now = new Date();
    for (let i = 1; i <= 6; i++) {
      const fab = fabs[i % 2];
      const cnp = 5000100 + i;
      const p = await prisma.produto.upsert({
        where: { cnp },
        update: {},
        create: { cnp, designacao: `ARTIGO E2E ${i}`, fabricanteId: fab.id, estado: "VALIDADO" },
      });
      produtos.push({ id: p.id, cnp, designacao: p.designacao, fabricante: E2E_FABRICANTES[i % 2] });
      for (const [fi, f] of farmacias.entries()) {
        const existe = await prisma.produtoFarmacia.findFirst({ where: { produtoId: p.id, farmaciaId: f.id } });
        if (existe) {
          await prisma.produtoFarmacia.update({ where: { id: existe.id }, data: { stockAtual: stockDe(i, fi) } });
        } else {
          await prisma.produtoFarmacia.create({
            data: {
              produtoId: p.id, farmaciaId: f.id,
              pvp: 10 + i, pmc: 12 + i, puc: 5 + i,
              stockAtual: stockDe(i, fi), stockMinimo: 5, stockMaximo: 30,
              taxaIvaPercent: 23,
            },
          });
        }
        // 6 meses de vendas por farmácia/produto
        for (let m = 1; m <= 6; m++) {
          const d = new Date(now.getFullYear(), now.getMonth() - m, 1);
          await prisma.vendaMensal.upsert({
            where: {
              farmaciaId_produtoId_ano_mes_naturezaVenda: {
                farmaciaId: f.id, produtoId: p.id, ano: d.getFullYear(), mes: d.getMonth() + 1, naturezaVenda: "NORMAL",
              },
            },
            update: {},
            create: {
              farmaciaId: f.id, produtoId: p.id, ano: d.getFullYear(), mes: d.getMonth() + 1,
              quantidade: 10 + i + fi * 5, valorTotal: (10 + i + fi * 5) * (10 + i),
            },
          });
        }
      }
    }
    return { userId: user.id, farmaciaIds: farmacias.map((f) => f.id), produtos };
  } finally {
    await prisma.$disconnect();
  }
}
