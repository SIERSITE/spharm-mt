/**
 * lib/reporting/resolver-laboratorio-selecionado.ts
 *
 * Resolve os valores seleccionados no filtro "Laboratório ou grupo"
 * (Vendas, Margens, Inventário) para os `Produto.id` correspondentes —
 * o MESMO resolvedor usado pelos três relatórios, para nunca poderem
 * divergir entre si nem face ao catálogo (`lib/catalogo-data.ts`).
 *
 * ── Correcção de UX de 2026-09-24 ─────────────────────────────────────
 * Até aqui, um valor seleccionado era sempre um NOME em texto simples
 * (o campo `SharedReportFilters.fabricantes: string[]` continua com
 * este nome por compatibilidade — só o CONTEÚDO mudou), resolvido por
 * correspondência exacta contra `GrupoLaboratorial.nome` OU
 * `Fabricante.nomeNormalizado`, sem forma de distinguir os dois só pelo
 * texto. Agora, no tenant garantia, os valores vêm com prefixo explícito
 * — `grupo:<id>` / `fabricante:<id>` (`lib/catalog/laboratorio-filtro.ts`,
 * a MESMA convenção já usada pelo catálogo) — nunca ambíguos, nunca
 * inferidos pelo texto. Valores SEM prefixo continuam a ser resolvidos
 * pelo caminho ANTIGO (nome exacto de grupo, senão de fabricante) —
 * comportamento 100% inalterado para os restantes tenants (que nunca
 * viram nem verão um valor com prefixo) e para qualquer link/estado
 * antigo já guardado.
 *
 * Selecção de grupo: inclui TODOS os produtos com uma linha em
 * `ProdutoGrupoLaboratorial` para esse grupo — fabricante inequívoco E
 * regra por CNP validada (ambos escrevem essa linha), NUNCA propostas
 * pendentes (nunca escrevem lá).
 * Selecção de fabricante: filtra exclusivamente por `fabricanteId` —
 * nunca inclui outros fabricantes do grupo nem regras de CNP de outros
 * fabricantes.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { resolveCurrentTenantSlug, TENANT_GRUPOS_LABORATORIAIS } from "@/lib/tenant-context";
import { parseValorLaboratorio } from "@/lib/catalog/laboratorio-filtro";

type PrismaParaResolucao = Pick<PrismaClient, "grupoLaboratorial" | "produtoGrupoLaboratorial" | "fabricante" | "produto">;

export async function resolverProdutoIdsPorLaboratoriosSelecionados(
  prisma: PrismaParaResolucao,
  valoresSelecionados: readonly string[],
  // Injectável só para testes de integração (scripts/tests/*) — permite
  // simular tenantSlug="garantia" sem um pedido Next.js real, que
  // `resolveCurrentTenantSlug()` não sabe fazer fora de um request (ver o
  // seu próprio doc comment). NUNCA passado por nenhum caller de produção
  // — todos usam o default, comportamento 100% inalterado.
  resolverTenant: () => Promise<string | null> = resolveCurrentTenantSlug,
): Promise<string[]> {
  if (valoresSelecionados.length === 0) return [];

  // GrupoLaboratorial/ProdutoGrupoLaboratorial só têm sentido — e só têm
  // GARANTIA de existir como tabelas reais — no tenant garantia. Nos
  // restantes tenants (e em qualquer ambiente onde a migration ainda não
  // tenha corrido, incluindo garantia antes de aplicada) NUNCA são
  // consultadas — nem para valores tipados "grupo:", nem para nomes soltos.
  const tenantSlug = await resolverTenant();
  const gruposPodemExistir = tenantSlug === TENANT_GRUPOS_LABORATORIAIS;

  const idsGrupoTipados: string[] = [];
  const idsFabricanteTipados: string[] = [];
  const nomesSoltos: string[] = [];
  for (const valor of valoresSelecionados) {
    const parsed = parseValorLaboratorio(valor);
    if (parsed?.tipo === "grupo") idsGrupoTipados.push(parsed.id);
    else if (parsed?.tipo === "fabricante") idsFabricanteTipados.push(parsed.id);
    else nomesSoltos.push(valor);
  }

  const conjuntos: string[][] = [];

  // ── Valores tipados "grupo:<id>" ──────────────────────────────────
  if (gruposPodemExistir && idsGrupoTipados.length > 0) {
    const rows = await prisma.produtoGrupoLaboratorial.findMany({
      where: { grupoLaboratorialId: { in: idsGrupoTipados } },
      select: { produtoId: true },
    });
    conjuntos.push(rows.map((r) => r.produtoId));
  }

  // ── Valores tipados "fabricante:<id>" — id directo, seguro em qualquer tenant ──
  if (idsFabricanteTipados.length > 0) {
    const produtos = await prisma.produto.findMany({
      where: { fabricanteId: { in: idsFabricanteTipados } },
      select: { id: true },
    });
    conjuntos.push(produtos.map((p) => p.id));
  }

  // ── Valores SEM prefixo — caminho antigo, inalterado ──────────────
  if (nomesSoltos.length > 0) {
    const grupos = gruposPodemExistir
      ? await prisma.grupoLaboratorial.findMany({ where: { nome: { in: nomesSoltos } }, select: { id: true, nome: true } })
      : [];
    const nomesDeGrupo = new Set(grupos.map((g) => g.nome));
    const nomesFabricante = nomesSoltos.filter((n) => !nomesDeGrupo.has(n));

    if (grupos.length > 0) {
      const rows = await prisma.produtoGrupoLaboratorial.findMany({
        where: { grupoLaboratorialId: { in: grupos.map((g) => g.id) } },
        select: { produtoId: true },
      });
      conjuntos.push(rows.map((r) => r.produtoId));
    }

    if (nomesFabricante.length > 0) {
      const fabs = await prisma.fabricante.findMany({
        where: { nomeNormalizado: { in: nomesFabricante }, estado: "ATIVO" },
        select: { id: true },
      });
      if (fabs.length > 0) {
        const produtos = await prisma.produto.findMany({
          where: { fabricanteId: { in: fabs.map((f) => f.id) } },
          select: { id: true },
        });
        conjuntos.push(produtos.map((p) => p.id));
      }
    }
  }

  // União (OR) entre todas as selecções — mesmo comportamento
  // multi-selecção que já existia, agora sobre 3 origens em vez de 2.
  const uniao = new Set<string>();
  for (const conjunto of conjuntos) for (const id of conjunto) uniao.add(id);
  return [...uniao];
}
