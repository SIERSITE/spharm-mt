/**
 * lib/catalog-fabricante-merge.ts
 *
 * Unificação de dois registos `Fabricante` que representam a MESMA
 * entidade jurídica sob denominações diferentes (rebranding, fusão,
 * mudança de firma) — ex.: "Alfa Wassermann – Produtos Farmacêuticos,
 * Lda." e "Alfasigma Portugal, Lda." são o MESMO NIF (502857722),
 * renomeado em Abril/2018 (ver o relatório de diagnóstico para as
 * fontes). QUAL par unificar é uma decisão tomada FORA desta função
 * (validada contra fontes oficiais/credíveis, nunca só por semelhança
 * de nome) — este módulo só executa mecanicamente a unificação depois
 * de decidida.
 *
 * ── O que "unificar" significa aqui ──────────────────────────────────
 *
 *   1. Todo o `Produto.fabricanteId` do PERDEDOR passa a apontar para
 *      o VENCEDOR (a denominação oficial mais actual).
 *   2. O nome do perdedor (e os seus aliases já existentes) tornam-se
 *      `FabricanteAlias` do vencedor — nunca se perde uma grafia
 *      histórica, e uma pesquisa pela denominação actual passa a
 *      encontrar também os produtos que estavam na antiga (ver
 *      `getOrCreateFabricante` em `lib/catalog-persistence.ts`, que já
 *      resolve por alias — este merge é o que faz um alias apontar
 *      para o `Fabricante` CERTO em vez de para uma segunda linha).
 *   3. O registo do perdedor NUNCA é apagado — fica `estado: INATIVO`.
 *      Isso já é suficiente para desaparecer dos dropdowns de filtro
 *      (`lib/reporting-filter-options.ts` só lista `estado = 'ATIVO'`)
 *      sem precisar de nenhuma migration nova, e preserva o histórico
 *      (auditoria, referências externas que ainda apontem para o ID).
 *
 * `Produto.validadoManualmente=true` — por omissão, um produto validado
 * à mão NÃO é reatribuído automaticamente (mesma cautela que
 * `persistResolvedProduct`/`applyAuthoritativeManufacturerCorrections`
 * já aplicam a outros campos autoritários), fica listado à parte para
 * revisão manual. `incluirValidadosManualmente: true` é um opt-in
 * explícito para quem decidir que, neste caso concreto (identidade da
 * empresa, não um palpite de conteúdo), a cautela não se justifica.
 *
 * Puro (planearMergeFabricantes) + uma função de aplicação com Prisma
 * injectado (executarMergeFabricantes) — mesma separação de
 * `lib/catalog-persistence.ts`, testável sem BD viva.
 */
import type { PrismaClient } from "@/generated/prisma/client";

export type ProdutoDoLoser = { id: string; validadoManualmente: boolean };

export type PlanoMergeFabricantes = {
  /** IDs de Produto cujo fabricanteId vai ser reatribuído ao vencedor. */
  produtosAReatribuir: string[];
  /** IDs de Produto com validadoManualmente=true, excluídos por omissão — precisam de revisão manual. */
  produtosBloqueadosValidadoManualmente: string[];
  /** Nomes que vão nascer como FabricanteAlias do vencedor (nome do perdedor + os seus aliases já existentes). */
  aliasesACriar: string[];
  /** Nomes que já existiam como alias do vencedor — não duplicados, só reportados. */
  aliasesJaExistentes: string[];
};

/**
 * Decide o que fazer — sem tocar em nada. Chamar isto primeiro (sempre)
 * para mostrar ao operador exactamente o que `executarMergeFabricantes`
 * vai fazer, antes de decidir aplicar.
 */
export function planearMergeFabricantes(input: {
  winnerNomeNormalizado: string;
  loserNomeNormalizado: string;
  loserAliases: readonly string[];
  winnerAliases: readonly string[];
  produtosDoLoser: readonly ProdutoDoLoser[];
  /** Default false — produtos validados à mão ficam de fora, listados à parte. */
  incluirValidadosManualmente?: boolean;
}): PlanoMergeFabricantes {
  const incluirValidadosManualmente = input.incluirValidadosManualmente ?? false;

  const produtosAReatribuir: string[] = [];
  const produtosBloqueadosValidadoManualmente: string[] = [];
  for (const p of input.produtosDoLoser) {
    if (p.validadoManualmente && !incluirValidadosManualmente) {
      produtosBloqueadosValidadoManualmente.push(p.id);
    } else {
      produtosAReatribuir.push(p.id);
    }
  }

  // Candidatos a alias do vencedor: o próprio nome do perdedor + os
  // aliases que já tinha — nunca o nome do próprio vencedor (seria um
  // alias de si mesmo, sem sentido) nem um que já lá esteja (reportado
  // à parte, não duplicado — `FabricanteAlias` já tem `@@unique`, mas
  // reportar aqui poupa uma viagem à BD só para descobrir isso).
  const jaExistentes = new Set(input.winnerAliases);
  const candidatos = [input.loserNomeNormalizado, ...input.loserAliases].filter(
    (nome) => nome !== input.winnerNomeNormalizado,
  );

  const aliasesACriar: string[] = [];
  const aliasesJaExistentes: string[] = [];
  const vistos = new Set<string>(); // evita propor o mesmo alias duas vezes no mesmo plano
  for (const nome of candidatos) {
    if (vistos.has(nome)) continue;
    vistos.add(nome);
    if (jaExistentes.has(nome)) aliasesJaExistentes.push(nome);
    else aliasesACriar.push(nome);
  }

  return { produtosAReatribuir, produtosBloqueadosValidadoManualmente, aliasesACriar, aliasesJaExistentes };
}

export type ResultadoMergeFabricantes = {
  produtosReatribuidos: number;
  aliasesCriados: number;
};

/**
 * Aplica o plano — SEMPRE numa única transacção (ou tudo, ou nada: um
 * merge a meio, com metade dos produtos já reatribuídos e o perdedor
 * ainda ATIVO, é o pior estado possível — dois nomes a apontar para o
 * mesmo sítio E o antigo continua a aparecer nos filtros).
 *
 * NUNCA apaga o Fabricante perdedor — só `estado: INATIVO`. NUNCA apaga
 * Produto nenhum. `dryRun` (default true) só calcula e devolve o plano,
 * sem abrir transacção nenhuma — mesma convenção de
 * `applyAuthoritativeManufacturerCorrections`.
 */
export async function executarMergeFabricantes(
  prisma: PrismaClient,
  input: {
    winnerId: string;
    loserId: string;
    plano: PlanoMergeFabricantes;
    /** Tag de proveniência gravada em EnrichmentSourceLog.source. */
    source: string;
    dryRun?: boolean;
  },
): Promise<ResultadoMergeFabricantes> {
  const { winnerId, loserId, plano, source } = input;
  const dryRun = input.dryRun ?? true;

  if (dryRun) {
    return { produtosReatribuidos: plano.produtosAReatribuir.length, aliasesCriados: plano.aliasesACriar.length };
  }

  await prisma.$transaction([
    ...(plano.produtosAReatribuir.length > 0
      ? [
          prisma.produto.updateMany({
            where: { id: { in: plano.produtosAReatribuir } },
            data: { fabricanteId: winnerId, dataAtualizacao: new Date() },
          }),
        ]
      : []),
    ...plano.aliasesACriar.map((aliasNome) =>
      prisma.fabricanteAlias.upsert({
        where: { fabricanteId_aliasNome: { fabricanteId: winnerId, aliasNome } },
        create: { fabricanteId: winnerId, aliasNome },
        update: {},
      }),
    ),
    // Os aliases do perdedor deixam de fazer sentido apontados para uma
    // linha INATIVA — foram todos migrados para o vencedor acima (ou já
    // lá estavam, `aliasesJaExistentes`). Limpa-os aqui, nunca antes.
    prisma.fabricanteAlias.deleteMany({ where: { fabricanteId: loserId } }),
    prisma.fabricante.update({ where: { id: loserId }, data: { estado: "INATIVO" } }),
  ]);

  // Auditoria — fora da transacção acima (não é crítico que falhe
  // atomicamente com ela; mesma tolerância que o resto do pipeline de
  // enriquecimento já usa para ProdutoVerificacaoHistorico).
  if (plano.produtosAReatribuir.length > 0) {
    try {
      await prisma.enrichmentSourceLog.createMany({
        data: plano.produtosAReatribuir.map((produtoId) => ({
          produtoId,
          source,
          status: "SUCCESS" as const,
          confidence: 1,
          matchedBy: "fabricante-merge",
          fieldsReturned: ["fabricante"],
          query: `merge-fabricantes: loserId=${loserId} → winnerId=${winnerId}`,
        })),
      });
    } catch {
      // Auxiliar — não interrompe o fluxo principal (mesmo padrão de
      // catalog-persistence.ts para ProdutoVerificacaoHistorico).
    }
  }

  return { produtosReatribuidos: plano.produtosAReatribuir.length, aliasesCriados: plano.aliasesACriar.length };
}
