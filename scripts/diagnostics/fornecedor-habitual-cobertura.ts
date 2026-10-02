/**
 * scripts/diagnostics/fornecedor-habitual-cobertura.ts
 *
 * Diagnóstico READ-ONLY: porque é que tantas linhas de uma proposta de encomenda
 * ficam «sem fornecedor»? Só faz SELECTs — não escreve, não altera, não cria
 * fornecedores nem aliases, não corre migrations.
 *
 *   DATABASE_URL=<base do tenant> npx tsx scripts/diagnostics/fornecedor-habitual-cobertura.ts
 *
 * A fonte de verdade do fornecedor habitual é `ProdutoFarmacia.fornecedorHabitualId`
 * (por produto E por farmácia). Esse campo só é preenchido por:
 *   1. a ingestão do agent — SÓ no tenant silveira, e só quando está nulo
 *      (lib/ingest/fornecedor-preferencial-silveira.ts);
 *   2. a manutenção em massa do catálogo — SÓ silveira.
 * Nos outros tenants fica nulo para sempre, mesmo com `fornecedorOrigem` (texto) preenchido.
 *
 * Por farmácia (apenas ProdutoFarmacia não retirados — o universo da proposta), classifica cada par
 * produto×farmácia numa categoria EXCLUSIVA:
 *
 *   HABITUAL_ATIVO        fornecedorHabitualId preenchido e Fornecedor ATIVO — a linha sai preenchida
 *   HABITUAL_INATIVO      preenchido mas o Fornecedor está INATIVO — NÃO é usado na proposta (sai «Sem fornecedor»)
 *   TEXTO_CANONICO        sem id; o texto do ERP coincide com o nome canónico de UM fornecedor ATIVO
 *   TEXTO_ALIAS           sem id; o texto é alias de exactamente UM fornecedor ATIVO
 *   TEXTO_FORN_INATIVO    sem id; a coincidência (canónica/alias) é um fornecedor INATIVO
 *   TEXTO_AMBIGUO         sem id; o texto é alias de mais do que um fornecedor
 *   TEXTO_SEM_FORNECEDOR  sem id; o texto não corresponde a nenhum Fornecedor/alias (fornecedor inexistente)
 *   SO_EXTERNAL_ID        sem id e sem texto, mas com `fornecedorExternalId` do ERP
 *   SEM_NADA              sem id, sem texto, sem external id — o ERP não tem habitual
 *
 * IMPORTANTE: as categorias TEXTO_* são APENAS informação para decidir, depois, uma atribuição em massa
 * (pela manutenção do catálogo). A PROPOSTA NÃO USA o texto do ERP: sem `fornecedorHabitualId` ativo
 * a linha sai sempre «Sem fornecedor». Este script não escreve nem influencia nada.
 *
 * Também mostra, para os rascunhos abertos, quantas linhas têm fornecedor nulo apesar de o
 * ProdutoFarmacia já ter habitual («semente perdida»: o rascunho foi criado antes de o habitual existir).
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";
import { normalizeFornecedorCanonico } from "../../lib/catalog-normalizers";

export const COLUNAS_COBERTURA = ["HABITUAL_ATIVO", "HABITUAL_INATIVO", "TEXTO_CANONICO", "TEXTO_ALIAS", "TEXTO_FORN_INATIVO", "TEXTO_AMBIGUO", "TEXTO_SEM_FORNECEDOR", "SO_EXTERNAL_ID", "SEM_NADA"] as const;
export type CategoriaCobertura = (typeof COLUNAS_COBERTURA)[number];

export type ResultadoCobertura = {
  porFarmacia: Array<{ farmacia: string; total: number; contagens: Record<CategoriaCobertura, number> }>;
  /** Linhas de rascunhos abertos sem fornecedor apesar de o ProdutoFarmacia já ter habitual. */
  sementePerdida: Array<{ farmacia: string; linhas: number }>;
};

/** SÓ LEITURA (apenas SELECTs). Exportada para ser testada; `main` só imprime. */
export async function diagnosticarCobertura(prisma: PrismaClient): Promise<ResultadoCobertura> {
  const farmacias = await prisma.farmacia.findMany({ where: { estado: "ATIVO" }, select: { id: true, nome: true }, orderBy: { nome: "asc" } });
  // Mapas só-leitura para classificar o texto do ERP (informativo — nunca usado pela proposta).
  const fornecedores = await prisma.fornecedor.findMany({ select: { id: true, nomeNormalizado: true, estado: true } });
  const porCanonico = new Map(fornecedores.map((f) => [f.nomeNormalizado, f]));
  const estadoPorId = new Map(fornecedores.map((f) => [f.id, f.estado]));
  const idsPorAlias = new Map<string, Set<string>>();
  for (const a of await prisma.fornecedorAlias.findMany({ select: { aliasNome: true, fornecedorId: true } })) {
    const s = idsPorAlias.get(a.aliasNome) ?? new Set<string>();
    s.add(a.fornecedorId);
    idsPorAlias.set(a.aliasNome, s);
  }
  type CatTexto = "TEXTO_CANONICO" | "TEXTO_ALIAS" | "TEXTO_FORN_INATIVO" | "TEXTO_AMBIGUO" | "TEXTO_SEM_FORNECEDOR";
  function classificarTexto(txt: string): CatTexto {
    const canonico = normalizeFornecedorCanonico(txt);
    const direto = canonico ? porCanonico.get(canonico) : undefined;
    if (direto) return direto.estado === "ATIVO" ? "TEXTO_CANONICO" : "TEXTO_FORN_INATIVO";
    const ids = idsPorAlias.get(txt);
    if (!ids || ids.size === 0) return "TEXTO_SEM_FORNECEDOR";
    if (ids.size > 1) return "TEXTO_AMBIGUO";
    return estadoPorId.get([...ids][0]) === "ATIVO" ? "TEXTO_ALIAS" : "TEXTO_FORN_INATIVO";
  }

  const porFarmacia: ResultadoCobertura["porFarmacia"] = [];
  for (const f of farmacias) {
    const pfs = await prisma.produtoFarmacia.findMany({
      where: { farmaciaId: f.id, flagRetirado: false },
      select: { fornecedorHabitualId: true, fornecedorOrigem: true, fornecedorExternalId: true, fornecedorHabitual: { select: { estado: true } } },
    });
    const c = Object.fromEntries(COLUNAS_COBERTURA.map((k) => [k, 0])) as Record<CategoriaCobertura, number>;
    for (const p of pfs) {
      const txt = p.fornecedorOrigem?.trim() || null;
      if (p.fornecedorHabitualId) c[p.fornecedorHabitual?.estado === "ATIVO" ? "HABITUAL_ATIVO" : "HABITUAL_INATIVO"]++;
      else if (txt) c[classificarTexto(txt)]++;
      else if (p.fornecedorExternalId != null) c.SO_EXTERNAL_ID++;
      else c.SEM_NADA++;
    }
    porFarmacia.push({ farmacia: f.nome, total: pfs.length, contagens: c });
  }

  const perdidas = await prisma.$queryRaw<Array<{ farmacia: string; linhas: bigint }>>`
    SELECT f.nome AS farmacia, COUNT(*)::bigint AS linhas
    FROM "LinhaEncomenda" le
    JOIN "ListaEncomenda" l ON l.id = le."listaEncomendaId" AND l.estado = 'RASCUNHO'
    JOIN "ProdutoFarmacia" pf ON pf."produtoId" = le."produtoId" AND pf."farmaciaId" = l."farmaciaId"
    JOIN "Farmacia" f ON f.id = l."farmaciaId"
    WHERE le."fornecedorSugeridoId" IS NULL AND pf."fornecedorHabitualId" IS NOT NULL
    GROUP BY f.nome`;
  return { porFarmacia, sementePerdida: perdidas.map((r) => ({ farmacia: r.farmacia, linhas: Number(r.linhas) })) };
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL em falta (base do tenant a diagnosticar).");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  const r = await diagnosticarCobertura(prisma);
  console.log(["farmácia", "total", ...COLUNAS_COBERTURA].join(" | "));
  for (const f of r.porFarmacia) console.log([f.farmacia, f.total, ...COLUNAS_COBERTURA.map((k) => f.contagens[k])].join(" | "));
  console.log("\nLinhas de rascunhos abertos SEM fornecedor mas com habitual já preenchido (semente perdida):");
  if (r.sementePerdida.length === 0) console.log("  nenhuma");
  for (const x of r.sementePerdida) console.log(`  ${x.farmacia}: ${x.linhas}`);
  await prisma.$disconnect();
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
