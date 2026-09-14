"use server";

/**
 * app/produtos/criar/actions.ts
 *
 * Criação manual de uma ficha de produto no catálogo do SPharm.MT.
 *
 * NÃO escreve no ERP de nenhuma farmácia. O que cria é uma linha em
 * `Produto` — o catálogo do tenant — e mais nada. `ProdutoFarmacia`
 * continua a nascer só quando uma farmácia reportar o artigo.
 *
 * ── «Pesquisar primeiro» não é uma optimização ───────────────────────
 *
 * `Produto.cnp` é `@unique`, portanto duas fichas para o mesmo CNP são
 * impossíveis — a base recusaria. O que esta acção faz é transformar
 * essa recusa em algo útil: quando o CNP já existe, devolve o produto
 * existente com `criado: false` em vez de um erro.
 *
 * É isso que faz o botão «Criar produto» nunca deixar o utilizador num
 * beco. Ou cria, ou entrega-lhe o que já lá estava — e nos dois casos
 * ele continua exactamente o que estava a fazer, que numa encomenda é
 * adicionar a linha.
 *
 * ── Porque não reutiliza `getOrCreateFabricante` ─────────────────────
 *
 * Porque `lib/catalog-persistence.ts` importa `legacyPrisma` — o cliente
 * do tenant legado, fixo. Chamá-lo daqui criaria o fabricante na base
 * ERRADA, em silêncio, e a ficha do tenant corrente ficaria com um
 * `fabricanteId` que aponta para nada. A resolução é feita aqui com o
 * prisma resolvido por `getPrisma()`.
 */
import { getPrisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { revalidatePath } from "next/cache";
import {
  normalizarFichaManual,
  validarFichaManual,
  type ContextoCriacao,
  type FichaManual,
  type ResultadoCriacao,
} from "@/lib/produtos/criar-produto";

export type CriarProdutoInput = FichaManual & {
  contexto: ContextoCriacao;
};

export async function criarProdutoManualAction(
  input: CriarProdutoInput,
): Promise<ResultadoCriacao> {
  // `catalog.write` e não `reports.write`: isto escreve no CATÁLOGO, que
  // é transversal a todas as farmácias do tenant. Um GESTOR_FARMACIA
  // pode preparar encomendas da sua farmácia; criar uma ficha que todas
  // as outras passam a ver é outra coisa.
  const session = await requirePermission("catalog.write");

  const erros = validarFichaManual(input);
  if (erros.length > 0) return { ok: false, erros };

  const ficha = normalizarFichaManual(input);
  const prisma = await getPrisma();

  // ── Já existe? ────────────────────────────────────────────────────
  const existente = await prisma.produto.findUnique({
    where: { cnp: ficha.cnp },
    select: { id: true, cnp: true, designacao: true },
  });
  if (existente) {
    return {
      ok: true,
      criado: false,
      produtoId: existente.id,
      cnp: existente.cnp,
      designacao: existente.designacao,
    };
  }

  // ── Fabricante ────────────────────────────────────────────────────
  //
  // Só resolve; não inventa. Sem nome, fica `null` — um produto sem
  // fabricante conhecido é um estado legítimo e frequente.
  let fabricanteId: string | null = null;
  if (ficha.fabricante) {
    const fab = await prisma.fabricante.upsert({
      where: { nomeNormalizado: ficha.fabricante },
      create: { nomeNormalizado: ficha.fabricante, estado: "ATIVO" },
      update: {},
      select: { id: true },
    });
    fabricanteId = fab.id;
  }

  // ── Classificação ─────────────────────────────────────────────────
  //
  // Por NOME, contra o vocabulário ATIVO, e sem criar nada. A taxonomia
  // é fechada: um nível 1 novo não nasce de um formulário de produto —
  // nasce do seed da taxonomia. Um nome que não exista fica a `null` e o
  // produto aparece como «por classificar», que é honesto.
  const [n1, n2] = await Promise.all([
    ficha.categoria
      ? prisma.classificacao.findFirst({
          where: { tipo: "NIVEL_1", estado: "ATIVO", nome: { equals: ficha.categoria, mode: "insensitive" } },
          select: { id: true },
        })
      : Promise.resolve(null),
    ficha.subcategoria
      ? prisma.classificacao.findFirst({
          where: { tipo: "NIVEL_2", estado: "ATIVO", nome: { equals: ficha.subcategoria, mode: "insensitive" } },
          select: { id: true },
        })
      : Promise.resolve(null),
  ]);

  try {
    const produto = await prisma.produto.create({
      data: {
        cnp: ficha.cnp,
        designacao: ficha.designacao,
        dci: ficha.dci,
        codigoATC: ficha.codigoATC,
        dosagem: ficha.dosagem,
        formaFarmaceutica: ficha.formaFarmaceutica,
        embalagem: ficha.embalagem,
        grupoHomogeneo: ficha.grupoHomogeneo,
        flagGenerico: ficha.flagGenerico,
        fabricanteId,
        classificacaoNivel1Id: n1?.id ?? null,
        classificacaoNivel2Id: n2?.id ?? null,
        // `MANUAL` já existia no enum e nunca tinha sido usado. É o que
        // faz o `ON CONFLICT` da ingestão saber que esta ficha tem um
        // «primeiro aparecimento numa farmácia» a registar.
        origemDados: "MANUAL",
        // A protecção contra a sincronização seguinte. Só os campos que
        // o utilizador preencheu E que o ERP realmente escreve — ver
        // `camposManuaisDe`.
        camposManuais: ficha.camposManuais,
        criadoPorId: session.sub,
        contextoCriacao: input.contexto,
        // NÃO marcamos `validadoManualmente`. Esse flag bloqueia o
        // enriquecimento INTEIRO (ver `catalog-persistence.evaluateField`),
        // e uma ficha criada à pressa numa encomenda é precisamente a que
        // mais precisa de ser enriquecida depois. A protecção fina é o
        // `camposManuais`; o cadeado global fica para quem o queira pôr
        // deliberadamente na ficha.
      },
      select: { id: true, cnp: true, designacao: true },
    });

    await logAudit({
      actorId: session.sub,
      action: "produto.created_manual",
      entity: "Produto",
      entityId: produto.id,
      meta: {
        cnp: ficha.cnp,
        contexto: input.contexto,
        camposManuais: ficha.camposManuais,
        camposPreenchidos: Object.entries(ficha)
          .filter(([k, v]) => k !== "camposManuais" && v !== null && v !== false)
          .map(([k]) => k),
      },
    });

    revalidatePath("/catalogo");
    revalidatePath("/stock");

    return {
      ok: true,
      criado: true,
      produtoId: produto.id,
      cnp: produto.cnp,
      designacao: produto.designacao,
    };
  } catch (err) {
    // Corrida: dois utilizadores a criar o mesmo CNP ao mesmo tempo. O
    // `@unique` ganha; nós devolvemos o que ficou, em vez de um erro que
    // não descreve nada de útil para quem está do outro lado.
    const emCorrida = await prisma.produto.findUnique({
      where: { cnp: ficha.cnp },
      select: { id: true, cnp: true, designacao: true },
    });
    if (emCorrida) {
      return {
        ok: true,
        criado: false,
        produtoId: emCorrida.id,
        cnp: emCorrida.cnp,
        designacao: emCorrida.designacao,
      };
    }
    return {
      ok: false,
      erros: [
        {
          campo: "geral",
          mensagem: err instanceof Error ? err.message : "Não foi possível criar a ficha.",
        },
      ],
    };
  }
}
