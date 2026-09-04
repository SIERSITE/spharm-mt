/**
 * lib/catalog/escrita-classificacao.ts
 *
 * O ÚNICO sítio onde `Produto.classificacaoNivel1Id/Nivel2Id` são
 * escritos pelo pipeline de conhecimento — pelo runner do enrichment e
 * pelo reprocessamento da cache.
 *
 * Existe por duas razões, e a segunda é a que o motivou:
 *
 *   1. A hierarquia de escrita tem de estar num sítio só. Duas cópias do
 *      mesmo WHERE divergem, e a divergência aparece como "este produto
 *      foi sobreposto e não devia" meses depois, sem nada que a explique.
 *
 *   2. O rollback precisa do estado ANTERIOR. Um UPDATE normal não o
 *      devolve, e um SELECT antes do UPDATE abre uma janela em que outra
 *      coisa escreve pelo meio — o journal ficaria a descrever um estado
 *      que já não era o que lá estava. O CTE abaixo lê e escreve na mesma
 *      instrução: o que o journal regista é exactamente o que foi
 *      substituído.
 *
 * ─── A HIERARQUIA ────────────────────────────────────────────────────
 *
 *      MANUAL  >  CANONICA  >  PROVISORIA  >  "Outros X"  >  vazio
 *
 *   · MANUAL (`validadoManualmente = true`) nunca é tocado por ninguém.
 *   · CANONICA substitui PROVISORIA, "Outros X" e vazio.
 *   · PROVISORIA substitui "Outros X" e vazio — e mais nada.
 *   · PROVISORIA NÃO substitui PROVISORIA.
 *
 * A última é a que não é óbvia. Assim que uma provisória é escrita, o
 * produto passa a ter nível 2 específico e o guarda antigo
 * (`is null or ilike 'Outros %'`) fecha-se sobre ela — o que está certo
 * contra outra dedução e errado contra uma classificação canónica, que
 * deve poder corrigi-la. É por isso que o WHERE tem um terceiro ramo, e
 * só um: se a provisória se pudesse sobrepor a si própria, a classificação
 * final de um produto passava a depender da ordem por que os lotes
 * correram.
 */
import type { PrismaClient } from "@/generated/prisma/client";

export type EstadoClassificacao = "AUSENTE" | "PROVISORIA" | "CANONICA";

/**
 * Proveniências conhecidas. Texto e não enum na base — um valor novo não
 * deve custar uma migração — mas enumerado aqui para que o compilador
 * apanhe os erros de escrita, que numa coluna de auditoria passariam
 * despercebidos até alguém tentar agrupar por ela.
 */
export type OrigemClassificacao =
  | "REGRA"
  | "MODELO"
  | "MODELO_PROVISORIO"
  | "MODELO_PROPAGADO"
  | "ERP"
  | "GLOBAL"
  | "MANUAL"
  /** Escrito antes de a proveniência existir — ver a migração do backfill. */
  | "PRE_PROVENIENCIA";

/**
 * Uma linha do journal: tudo o que é preciso para desfazer esta escrita
 * e nada mais.
 *
 * Os IDs são o que o rollback repõe; os nomes são para quem lê o ficheiro.
 * Guardar só os nomes obrigaria o rollback a resolvê-los outra vez contra
 * a taxonomia — que pode ter mudado entretanto — e repor por nome o que
 * foi retirado por id é o tipo de aproximação que transforma um rollback
 * numa segunda alteração.
 */
export type LinhaJournal = {
  cnp: number;
  n1AntesId: string | null;
  n2AntesId: string | null;
  n1Antes: string | null;
  n2Antes: string | null;
  estadoAntes: EstadoClassificacao;
  origemAntes: string | null;
  confiancaAntes: number | null;
  versaoAntes: string | null;
  n1DepoisId: string;
  n2DepoisId: string;
  n1Depois: string;
  n2Depois: string;
  estadoDepois: EstadoClassificacao;
  origemDepois: string;
  confiancaDepois: number | null;
  versaoDepois: string | null;
};

type FilaSql = {
  cnp: number;
  n1AntesId: string | null;
  n2AntesId: string | null;
  n1Antes: string | null;
  n2Antes: string | null;
  estadoAntes: EstadoClassificacao;
  origemAntes: string | null;
  confiancaAntes: number | null;
  versaoAntes: string | null;
  escrito: boolean;
};

export type PedidoEscrita = {
  cnp: number;
  n1Id: string;
  n2Id: string;
  /** Nomes só para o journal — não são escritos em lado nenhum. */
  n1Nome: string;
  n2Nome: string;
  estado: Extract<EstadoClassificacao, "PROVISORIA" | "CANONICA">;
  origem: OrigemClassificacao;
  confianca: number | null;
  versao: string | null;
};

/**
 * Escreve a classificação, respeitando a hierarquia, e devolve o que foi
 * substituído.
 *
 * `null` quando não escreveu — produto inexistente, manual, ou já com uma
 * classificação de autoridade igual ou superior. Não é erro: é o guarda a
 * fazer o que existe para fazer, e o chamador conta-o como "não aplicado".
 */
export async function escreverClassificacao(
  prisma: PrismaClient,
  pedido: PedidoEscrita,
): Promise<LinhaJournal | null> {
  const linhas = await prisma.$queryRawUnsafe<FilaSql[]>(
    `
    with antes as (
      select p.id,
             p.cnp,
             p."classificacaoNivel1Id"    as "n1AntesId",
             p."classificacaoNivel2Id"    as "n2AntesId",
             c1.nome                      as "n1Antes",
             c2.nome                      as "n2Antes",
             p."classificacaoEstado"      as "estadoAntes",
             p."classificacaoOrigem"      as "origemAntes",
             p."classificacaoConfianca"   as "confiancaAntes",
             p."classificacaoVersao"      as "versaoAntes",
             p."validadoManualmente"      as manual
        from "Produto" p
        left join "Classificacao" c1 on c1.id = p."classificacaoNivel1Id"
        left join "Classificacao" c2 on c2.id = p."classificacaoNivel2Id"
       where p.cnp = $1
    ),
    upd as (
      update "Produto" p
         set "classificacaoNivel1Id"  = $2,
             "classificacaoNivel2Id"  = $3,
             "classificacaoEstado"    = $4::"ClassificacaoEstado",
             "classificacaoOrigem"    = $5,
             "classificacaoConfianca" = $6,
             "classificacaoVersao"    = $7,
             "dataAtualizacao"        = now()
        from antes a
       where p.id = a.id
         -- MANUAL é soberano. A guarda está aqui e não só no chamador
         -- porque é a única que protege contra um chamador novo.
         and a.manual = false
         and (
               -- vazio
               a."n2AntesId" is null
               -- ou um balde: "Outros X" é um nível 2 literal da
               -- taxonomia, e um produto lá dentro está tão por
               -- classificar como um sem nível 2 nenhum.
            or a."n2Antes" ilike 'Outros %'
               -- ou uma provisória a ser corrigida por uma canónica.
               -- Só nesta direcção: ver o cabeçalho.
            or (a."estadoAntes" = 'PROVISORIA' and $4 = 'CANONICA')
         )
      returning p.cnp
    )
    select a.cnp,
           a."n1AntesId", a."n2AntesId", a."n1Antes", a."n2Antes",
           a."estadoAntes", a."origemAntes", a."confiancaAntes", a."versaoAntes",
           exists (select 1 from upd) as escrito
      from antes a
    `,
    pedido.cnp,
    pedido.n1Id,
    pedido.n2Id,
    pedido.estado,
    pedido.origem,
    pedido.confianca,
    pedido.versao,
  );

  const a = linhas[0];
  if (!a || !a.escrito) return null;

  return {
    cnp: Number(a.cnp),
    n1AntesId: a.n1AntesId,
    n2AntesId: a.n2AntesId,
    n1Antes: a.n1Antes,
    n2Antes: a.n2Antes,
    // A coluna tem NOT NULL DEFAULT 'AUSENTE', portanto o `?? "AUSENTE"`
    // nunca dispara. Fica como rede para o caso de a linha vir de uma
    // base a meio da migração — devolver `undefined` num campo do journal
    // produzia um ficheiro que o rollback não consegue ler.
    estadoAntes: a.estadoAntes ?? "AUSENTE",
    origemAntes: a.origemAntes,
    confiancaAntes: a.confiancaAntes === null ? null : Number(a.confiancaAntes),
    versaoAntes: a.versaoAntes,
    n1DepoisId: pedido.n1Id,
    n2DepoisId: pedido.n2Id,
    n1Depois: pedido.n1Nome,
    n2Depois: pedido.n2Nome,
    estadoDepois: pedido.estado,
    origemDepois: pedido.origem,
    confiancaDepois: pedido.confianca,
    versaoDepois: pedido.versao,
  };
}

/**
 * Desfaz uma linha do journal.
 *
 * Repõe EXACTAMENTE o que lá estava, incluindo um "Outros X" que tenha
 * sido substituído — que é a razão de o journal existir. O rollback por
 * SQL cego (`where estado = 'PROVISORIA' → null`) devolveria `null` a
 * esses produtos e teria apagado uma classificação que não foi esta
 * corrida que escreveu.
 *
 * IDEMPOTENTE, e a guarda é o `where`: só repõe se o estado actual ainda
 * for o que esta escrita deixou. Correr o rollback duas vezes não faz
 * nada da segunda; e uma classificação que alguém tenha corrigido à mão
 * entretanto não é revertida — a correcção humana ganha ao desfazer
 * automático.
 */
export async function reverterLinhaJournal(
  prisma: PrismaClient,
  l: LinhaJournal,
): Promise<boolean> {
  const n = await prisma.$executeRawUnsafe(
    `update "Produto" p
        set "classificacaoNivel1Id"  = $2,
            "classificacaoNivel2Id"  = $3,
            "classificacaoEstado"    = $4::"ClassificacaoEstado",
            "classificacaoOrigem"    = $5,
            "classificacaoConfianca" = $6,
            "classificacaoVersao"    = $7,
            "dataAtualizacao"        = now()
      where p.cnp = $1
        and p."validadoManualmente" = false
        and p."classificacaoNivel2Id" is not distinct from $8
        and p."classificacaoEstado"   = $9::"ClassificacaoEstado"`,
    l.cnp,
    l.n1AntesId,
    l.n2AntesId,
    l.estadoAntes,
    l.origemAntes,
    l.confiancaAntes,
    l.versaoAntes,
    l.n2DepoisId,
    l.estadoDepois,
  );
  return Number(n) > 0;
}
