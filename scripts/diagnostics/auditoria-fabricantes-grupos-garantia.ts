/**
 * scripts/diagnostics/auditoria-fabricantes-grupos-garantia.ts
 *
 * Auditoria SOMENTE LEITURA do agrupamento de fabricantes nos filtros do tenant garantia: quantas opções o filtro tinha
 * (uma por fabricante) e quantas passa a ter (uma por grupo lógico + fabricantes sem prova de grupo), quais os grupos
 * com mais variantes e quais as variantes que NÃO foram agrupadas por falta de prova.
 *
 * SEGURANÇA: corre contra uma base DESCARTÁVEL/SINTÉTICA passada por parâmetro ou ambiente — nunca a real.
 *   · URL: 1.º argumento, ou AUDITORIA_DATABASE_URL (NÃO usa DATABASE_URL por omissão, para não apanhar a real por engano);
 *   · recusa qualquer host que não seja localhost/127.0.0.1 e qualquer URL que pareça de produção (spharmmt_t_*, prod).
 *   · não escreve nada.
 *
 * Uso: AUDITORIA_DATABASE_URL=postgresql://postgres:test@localhost:15433/<base_sintetica> \
 *        npx tsx scripts/diagnostics/auditoria-fabricantes-grupos-garantia.ts
 *   (ou: npx tsx scripts/diagnostics/auditoria-fabricantes-grupos-garantia.ts postgresql://...)
 */
import { PrismaClient } from "../../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { carregarLaboratoriosGarantia } from "../../lib/catalog/carregar-laboratorios-garantia";
import { agruparOpcoesLaboratorio } from "../../lib/catalog/laboratorio-filtro";

export type RelatorioAuditoria = {
  fabricantes: number;
  opcoesAntes: number;
  opcoesDepois: number;
  grupos: number;
  gruposComMaisVariantes: Array<{ grupo: string; variantes: number; produtos: number }>;
  fabricantesSemProva: Array<{ fabricante: string; produtos: number }>;
};

/** Pura sobre as opções já carregadas — reutilizada pelo teste. */
export function auditarOpcoes(opcoes: Parameters<typeof agruparOpcoesLaboratorio>[0], topN = 10): RelatorioAuditoria {
  const fabricantes = opcoes.filter((o) => o.tipo === "fabricante");
  const grupos = opcoes.filter((o) => o.tipo === "grupo");
  const agrupadas = agruparOpcoesLaboratorio(opcoes);
  const soltos = agrupadas.filter((i) => i.opcao.tipo === "fabricante");
  return {
    fabricantes: fabricantes.length,
    opcoesAntes: fabricantes.length,
    opcoesDepois: agrupadas.length,
    grupos: grupos.length,
    gruposComMaisVariantes: grupos
      .map((g) => ({ grupo: g.tipo === "grupo" ? g.nome : "", variantes: g.tipo === "grupo" ? (g.variantes ?? []).length : 0, produtos: g.produtos }))
      .sort((a, b) => b.variantes - a.variantes || a.grupo.localeCompare(b.grupo, "pt-PT"))
      .slice(0, topN),
    fabricantesSemProva: soltos
      .map((i) => ({ fabricante: i.opcao.tipo === "fabricante" ? i.opcao.nomeNormalizado : "", produtos: i.opcao.produtos }))
      .sort((a, b) => a.fabricante.localeCompare(b.fabricante, "pt-PT")),
  };
}

export function validarUrlDescartavel(url: string | undefined): string {
  if (!url) throw new Error("Passe a URL da base sintética como 1.º argumento ou em AUDITORIA_DATABASE_URL.");
  const host = new URL(url).hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`[fatal] ${host} não é uma base local descartável — recusado.`);
  if (/spharmmt_t_|prod|production/i.test(url)) throw new Error("[fatal] URL parece apontar para uma base real — recusado.");
  return url;
}

async function main() {
  const url = validarUrlDescartavel(process.argv[2] ?? process.env.AUDITORIA_DATABASE_URL);
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    const opcoes = await carregarLaboratoriosGarantia(prisma);
    const r = auditarOpcoes(opcoes);
    console.log("Auditoria de fabricantes agrupados (garantia) — só leitura");
    console.log(`  Fabricantes ATIVOS:                    ${r.fabricantes}`);
    console.log(`  Opções ANTES (uma por fabricante):     ${r.opcoesAntes}`);
    console.log(`  Opções DEPOIS (grupos + sem prova):    ${r.opcoesDepois}   (${r.grupos} grupos ATIVOS)`);
    console.log("\n  Grupos com mais variantes:");
    for (const g of r.gruposComMaisVariantes) console.log(`    ${String(g.variantes).padStart(4)} variantes  ${g.grupo}  (${g.produtos} produtos)`);
    console.log(`\n  Variantes NÃO agrupadas por falta de prova (${r.fabricantesSemProva.length}):`);
    for (const f of r.fabricantesSemProva) console.log(`    ${f.fabricante}  (${f.produtos} produtos)`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
