/**
 * lib/catalog/taxonomia-seed.ts
 *
 * Materializa a taxonomia canónica em `Classificacao`, na base de um
 * tenant.
 *
 * ─────────────────────────────────────────────────────────────────────
 * PORQUE É QUE ISTO EXISTE COMO BIBLIOTECA E NÃO SÓ COMO SCRIPT
 *
 * A lógica já vivia em `scripts/seed-taxonomy.ts`, que é um comando de
 * operador: alguém tem de se lembrar de o correr. E a criação de tenants
 * não se lembrava.
 *
 * O sintoma foi medido no tenant `sier`, num E2E de importação:
 *
 *   catalogoGlobal: { conhecidosNoGlobal: 3, classificacoesProjectadas: 0,
 *                     utilizacoesProjectadas: 6 }
 *
 * As utilizações projectavam — porque `create-client-workflow.ts` semeia
 * o vocabulário de utilizações. As classificações não — porque ninguém
 * semeava a taxonomia. Sem nomes em `Classificacao`, a projecção não tem
 * onde pousar a categoria que o global conhece: conta `semVocabulario` e
 * segue. O produto nasce com `productType` e utilizações, e sem N1/N2.
 *
 * E falha em silêncio. O resumo devolvido pela importação diz
 * `classificacoesProjectadas: 0`, que é indistinguível de "não havia
 * nada para projectar". Uma farmácia nova ficaria com o catálogo por
 * classificar sem nenhuma mensagem de erro em lado nenhum.
 *
 * O comentário do `seed-utilizacoes` no workflow já tinha escrito o
 * argumento todo — "um tenant criado pelo Wizard tem de sair completo" —
 * e aplica-se com mais força aqui: sem utilizações falha a pesquisa por
 * necessidade; sem taxonomia falha a classificação inteira.
 *
 * ─────────────────────────────────────────────────────────────────────
 * POLÍTICA DE ESCRITA — a mesma do script, deliberadamente
 *
 *  1. Só cria o que falta. Nunca apaga, nunca renomeia.
 *  2. Materializa EXACTAMENTE `CANONICAL_TAXONOMY`. Uma classificação que
 *     exista na base e não conste da taxonomia é deixada em paz: pode ser
 *     de uma versão anterior ou criada pelo admin, e em nenhum dos casos
 *     é a este código que compete decidir.
 *  3. Uma classificação canónica que exista com estado != ATIVO é
 *     CONTADA e devolvida, não reactivada. O mapper só lê ATIVO, portanto
 *     é um problema real — mas reactivar é desfazer a decisão de alguém.
 *  4. Idempotente. Correr duas vezes não cria nada na segunda.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { CANONICAL_TAXONOMY } from "@/lib/catalog-taxonomy";

export type ResultadoSeedTaxonomia = {
  nivel1Criados: number;
  nivel1Existentes: number;
  nivel2Criados: number;
  nivel2Existentes: number;
  /**
   * Classificações canónicas encontradas com estado != ATIVO.
   *
   * Não são tocadas. Ficam aqui porque são invisíveis para o mapper e
   * para a projecção, e quem chamou tem de poder dizê-lo.
   */
  inativas: string[];
};

/**
 * Semeia a taxonomia canónica na base recebida.
 *
 * `prisma` é o cliente do TENANT, não o da base legacy — é o chamador que
 * escolhe o destino. A versão anterior deste código, no script, importava
 * o cliente legacy directamente e semeou 26 níveis 1 na base errada sem
 * dar erro; o tenant ficou vazio e o sintoma só apareceu três fases à
 * frente.
 */
export async function seedTaxonomia(
  prisma: PrismaClient,
): Promise<ResultadoSeedTaxonomia> {
  const r: ResultadoSeedTaxonomia = {
    nivel1Criados: 0,
    nivel1Existentes: 0,
    nivel2Criados: 0,
    nivel2Existentes: 0,
    inativas: [],
  };

  // Uma leitura só, e o resto em memória: são 186 linhas, e 186 queries
  // de existência dentro de um fluxo de criação de tenant é latência que
  // não compra nada.
  const existentes = await prisma.classificacao.findMany({
    select: { id: true, nome: true, tipo: true, classificacaoPaiId: true, estado: true },
  });
  const n1PorNome = new Map<string, { id: string; estado: string }>();
  const n2PorChave = new Map<string, { id: string; estado: string }>();
  for (const c of existentes) {
    if (c.tipo === "NIVEL_1" && !c.classificacaoPaiId) {
      n1PorNome.set(c.nome, { id: c.id, estado: c.estado });
    } else if (c.tipo === "NIVEL_2" && c.classificacaoPaiId) {
      n2PorChave.set(`${c.classificacaoPaiId}::${c.nome}`, { id: c.id, estado: c.estado });
    }
  }

  for (const cat of CANONICAL_TAXONOMY) {
    const jaN1 = n1PorNome.get(cat.nivel1);
    let paiId: string;

    if (jaN1) {
      r.nivel1Existentes++;
      paiId = jaN1.id;
      if (jaN1.estado !== "ATIVO") {
        r.inativas.push(`${cat.nivel1} (nível 1, estado ${jaN1.estado})`);
      }
    } else {
      const criado = await prisma.classificacao.create({
        data: { nome: cat.nivel1, tipo: "NIVEL_1", classificacaoPaiId: null },
        select: { id: true },
      });
      paiId = criado.id;
      r.nivel1Criados++;
    }

    for (const sub of cat.nivel2) {
      const ja = n2PorChave.get(`${paiId}::${sub}`);
      if (ja) {
        r.nivel2Existentes++;
        if (ja.estado !== "ATIVO") {
          r.inativas.push(`${cat.nivel1} > ${sub} (nível 2, estado ${ja.estado})`);
        }
        continue;
      }
      await prisma.classificacao.create({
        data: { nome: sub, tipo: "NIVEL_2", classificacaoPaiId: paiId },
      });
      r.nivel2Criados++;
    }
  }

  return r;
}
