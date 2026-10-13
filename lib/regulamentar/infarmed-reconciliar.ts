/**
 * lib/regulamentar/infarmed-reconciliar.ts
 *
 * Reconciliação dos campos canónicos do catálogo (`Produto`) com os dados
 * regulamentares do INFARMED (versão ativa de `ProdutoRegulamentar`).
 *
 * UM só motor, usado por:
 *   1. a atualização mensal automática   (dentro da transação de `aplicarVersaoInfarmed`);
 *   2. o upload manual em /admin/infarmed (idem — é o mesmo `aplicarVersaoInfarmed`);
 *   3. o comando `ops:infarmed-carga --reconciliar` sobre a versão JÁ ativa
 *      (sem importação fictícia, sem alterar o SHA, sem descarregar, sem
 *      desativar/substituir a versão ativa, sem tocar no histórico).
 *
 * Mapeamento INFARMED → `Produto` (campos que JÁ existem; nada novo):
 *
 *   ProdutoRegulamentar.formaFarmaceutica → Produto.formaFarmaceutica
 *   ProdutoRegulamentar.dosagem           → Produto.dosagem
 *   ProdutoRegulamentar.tamanhoEmbalagem  → Produto.embalagem
 *   ProdutoRegulamentar.substanciaAtiva   → Produto.dci
 *
 * Regras (campo a campo, avaliadas em SQL, set-based):
 *   · valor do INFARMED vazio  → nunca apaga nem altera (ignorado por «vazio»);
 *   · campo protegido (`'<campo>' = ANY(camposManuais)`) → nunca é substituído;
 *   · campo vazio no catálogo  → é PREENCHIDO;
 *   · campo preenchido e diferente (não manual) → é ATUALIZADO;
 *   · igual                    → nada a fazer (idempotente: 2.ª execução = 0 alterações).
 *
 * Só escreve `Produto.formaFarmaceutica/dosagem/embalagem/dci` e
 * `dataAtualizacao`. `Produto.designacao` (e a regra da designação autoritativa
 * da Silveirense), fabricante, fornecedor, custos, stock, classificação e
 * preços NÃO são lidos nem escritos. O `flagGenerico` não tem equivalência
 * inequívoca (um booleano que nunca é «vazio») e fica de fora; o ATC não consta
 * do ficheiro. Só entram linhas `presenteNoFicheiro = true` (um CNP que deixou
 * de constar do ficheiro não volta a escrever no catálogo).
 */

import { Prisma, type PrismaClient } from "@/generated/prisma/client";

export const CAMPOS_RECONCILIADOS = ["formaFarmaceutica", "dosagem", "embalagem", "dci"] as const;
export type CampoReconciliado = (typeof CAMPOS_RECONCILIADOS)[number];

/** Mapeamento exato, também usado na documentação e nos testes. */
export const MAPEAMENTO_INFARMED_PRODUTO: Record<CampoReconciliado, { infarmed: string; produto: string }> = {
  formaFarmaceutica: { infarmed: "Forma farmacêutica", produto: "Produto.formaFarmaceutica" },
  dosagem: { infarmed: "Dosagem", produto: "Produto.dosagem" },
  embalagem: { infarmed: "Tamanho da embalagem", produto: "Produto.embalagem" },
  dci: { infarmed: "Substância Ativa/DCI", produto: "Produto.dci" },
};

export type ContadoresCampo = {
  /** O catálogo estava vazio e passa a ter o valor do INFARMED. */
  preenchidos: number;
  /** O catálogo tinha outro valor (não manual) e passa a ter o do INFARMED. */
  atualizados: number;
  /** Valor do INFARMED diferente do catálogo, mas o campo está em `camposManuais`. */
  ignoradosManual: number;
  /** O INFARMED não tem valor: nada é apagado nem alterado. */
  ignoradosVazio: number;
  /** O catálogo já tem exatamente o valor do INFARMED. */
  jaIguais: number;
};

export type ContadoresReconciliacao = {
  /** Linhas regulamentares consideradas (versão ativa, presentes no ficheiro). */
  produtosAnalisados: number;
  /** Dessas, as que correspondem a um `Produto` do tenant (por `Produto.id` = CNP). */
  produtosAssociados: number;
  /** CNP do ficheiro sem produto neste tenant (da importação; só quando a fonte é a versão ativa). */
  semCorrespondencia: number | null;
  /** Produtos com pelo menos um campo escrito (ou a escrever, em dry-run). */
  produtosAlterados: number;
  campos: Record<CampoReconciliado, ContadoresCampo>;
  /** Só com `apply` + `registarAlteracoes`: o que foi gravado, com o valor anterior. */
  alteracoes?: AlteracaoCampo[];
};

/**
 * Uma alteração gravada pela reconciliação: o suficiente para auditar e para
 * repor EXATAMENTE o valor anterior (incluindo `null` e strings vazias), sem
 * guardar mais nada do produto.
 */
export type AlteracaoCampo = {
  produtoId: string;
  cnp: number;
  campo: CampoReconciliado;
  /** Valor antes (tal como estava na base; `null` se estava vazio). */
  anterior: string | null;
  /** Valor gravado. */
  aplicado: string;
  tipo: "PREENCHIMENTO" | "ATUALIZACAO";
};

export type LinhaParaReconciliar = {
  produtoId: string;
  formaFarmaceutica: string | null;
  dosagem: string | null;
  embalagem: string | null;
  dci: string | null;
};

export type FonteReconciliacao =
  | { tipo: "importacao"; importacaoId: string }
  | { tipo: "linhas"; linhas: LinhaParaReconciliar[] };

type Db = Pick<PrismaClient, "$queryRaw" | "$executeRaw" | "infarmedImportacao">;

function fonteSql(f: FonteReconciliacao): Prisma.Sql {
  if (f.tipo === "importacao") {
    return Prisma.sql`
      SELECT pr."produtoId" AS pid,
             NULLIF(btrim(pr."formaFarmaceutica"), '') AS forma,
             NULLIF(btrim(pr."dosagem"), '')           AS dosagem,
             NULLIF(btrim(pr."tamanhoEmbalagem"), '')  AS embalagem,
             NULLIF(btrim(pr."substanciaAtiva"), '')   AS dci
        FROM "ProdutoRegulamentar" pr
       WHERE pr."importacaoId" = ${f.importacaoId} AND pr."presenteNoFicheiro"`;
  }
  const t = (k: keyof LinhaParaReconciliar) => f.linhas.map((l) => (l[k] === null ? null : String(l[k])));
  return Prisma.sql`
    SELECT u.pid,
           NULLIF(btrim(u.forma), '')     AS forma,
           NULLIF(btrim(u.dosagem), '')   AS dosagem,
           NULLIF(btrim(u.embalagem), '') AS embalagem,
           NULLIF(btrim(u.dci), '')       AS dci
      FROM unnest(${t("produtoId")}::text[], ${t("formaFarmaceutica")}::text[], ${t("dosagem")}::text[], ${t("embalagem")}::text[], ${t("dci")}::text[])
           AS u(pid, forma, dosagem, embalagem, dci)`;
}

/** Fragmentos SQL por campo (nome da coluna em `Produto`, coluna na fonte). */
const COL: Record<CampoReconciliado, { produto: string; fonte: string }> = {
  formaFarmaceutica: { produto: "formaFarmaceutica", fonte: "forma" },
  dosagem: { produto: "dosagem", fonte: "dosagem" },
  embalagem: { produto: "embalagem", fonte: "embalagem" },
  dci: { produto: "dci", fonte: "dci" },
};

function condicoes(campo: CampoReconciliado) {
  const { produto, fonte } = COL[campo];
  const cur = Prisma.raw(`NULLIF(btrim(p."${produto}"), '')`);
  const src = Prisma.raw(`s.${fonte}`);
  const manual = Prisma.raw(`'${produto}' = ANY(p."camposManuais")`);
  return {
    vazio: Prisma.sql`${src} IS NULL`,
    igual: Prisma.sql`(${src} IS NOT NULL AND ${cur} = ${src})`,
    manualDiferente: Prisma.sql`(${src} IS NOT NULL AND ${manual} AND ${cur} IS DISTINCT FROM ${src})`,
    preenche: Prisma.sql`(${src} IS NOT NULL AND NOT (${manual}) AND ${cur} IS NULL)`,
    atualiza: Prisma.sql`(${src} IS NOT NULL AND NOT (${manual}) AND ${cur} IS NOT NULL AND ${cur} <> ${src})`,
    escreve: Prisma.sql`(${src} IS NOT NULL AND NOT (${manual}) AND ${cur} IS DISTINCT FROM ${src})`,
  };
}

const n = (v: unknown) => Number(v ?? 0);

/**
 * Calcula os contadores e, com `apply`, escreve — tudo no mesmo cliente/transação
 * que o chamador passa (por isso é atómico com a ativação da versão, quando
 * chamado de dentro de `aplicarVersaoInfarmed`). Idempotente.
 */
export async function reconciliarProdutos(
  db: Db,
  fonte: FonteReconciliacao,
  opcoes: {
    apply: boolean;
    /** Devolve em `alteracoes` cada campo gravado com o valor anterior (para auditoria/reversão). */
    registarAlteracoes?: boolean;
    /**
     * Chamado com as alterações ANTES de o chamador confirmar a transação: se lançar,
     * o chamador deve anular tudo (é assim que o relatório de reversão fica gravado
     * em disco antes de qualquer alteração ficar definitiva).
     */
    antesDeConfirmar?: (alteracoes: AlteracaoCampo[]) => void | Promise<void>;
  },
): Promise<ContadoresReconciliacao> {
  const src = fonteSql(fonte);
  const c = Object.fromEntries(CAMPOS_RECONCILIADOS.map((k) => [k, condicoes(k)])) as Record<CampoReconciliado, ReturnType<typeof condicoes>>;
  const agg = (campo: CampoReconciliado, nome: keyof ReturnType<typeof condicoes>) =>
    Prisma.sql`count(*) FILTER (WHERE ${c[campo][nome]})`;
  const alguma = Prisma.sql`(${c.formaFarmaceutica.escreve} OR ${c.dosagem.escreve} OR ${c.embalagem.escreve} OR ${c.dci.escreve})`;

  const linhas = await db.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    WITH s AS (${src})
    SELECT
      (SELECT count(*) FROM s)                                AS analisados,
      count(p.id)                                             AS associados,
      count(*) FILTER (WHERE ${alguma})                       AS alterados,
      ${agg("formaFarmaceutica", "preenche")}  AS f_preenche, ${agg("formaFarmaceutica", "atualiza")} AS f_atualiza,
      ${agg("formaFarmaceutica", "manualDiferente")} AS f_manual, ${agg("formaFarmaceutica", "vazio")} AS f_vazio, ${agg("formaFarmaceutica", "igual")} AS f_igual,
      ${agg("dosagem", "preenche")}  AS d_preenche, ${agg("dosagem", "atualiza")} AS d_atualiza,
      ${agg("dosagem", "manualDiferente")} AS d_manual, ${agg("dosagem", "vazio")} AS d_vazio, ${agg("dosagem", "igual")} AS d_igual,
      ${agg("embalagem", "preenche")}  AS e_preenche, ${agg("embalagem", "atualiza")} AS e_atualiza,
      ${agg("embalagem", "manualDiferente")} AS e_manual, ${agg("embalagem", "vazio")} AS e_vazio, ${agg("embalagem", "igual")} AS e_igual,
      ${agg("dci", "preenche")}  AS i_preenche, ${agg("dci", "atualiza")} AS i_atualiza,
      ${agg("dci", "manualDiferente")} AS i_manual, ${agg("dci", "vazio")} AS i_vazio, ${agg("dci", "igual")} AS i_igual
    FROM s JOIN "Produto" p ON p.id = s.pid`);
  const r = linhas[0] ?? {};

  const campo = (pfx: string): ContadoresCampo => ({
    preenchidos: n(r[`${pfx}_preenche`]), atualizados: n(r[`${pfx}_atualiza`]), ignoradosManual: n(r[`${pfx}_manual`]),
    ignoradosVazio: n(r[`${pfx}_vazio`]), jaIguais: n(r[`${pfx}_igual`]),
  });
  const out: ContadoresReconciliacao = {
    produtosAnalisados: n(r.analisados),
    produtosAssociados: n(r.associados),
    semCorrespondencia: null,
    produtosAlterados: n(r.alterados),
    campos: { formaFarmaceutica: campo("f"), dosagem: campo("d"), embalagem: campo("e"), dci: campo("i") },
  };
  if (fonte.tipo === "importacao") {
    const imp = await db.infarmedImportacao.findUnique({ where: { id: fonte.importacaoId }, select: { cnpNaoEncontrados: true } });
    out.semCorrespondencia = imp?.cnpNaoEncontrados ?? null;
  }

  if (opcoes.apply && out.produtosAlterados > 0) {
    // SÓ estas 4 colunas (+ dataAtualizacao). Nunca `designacao`.
    const set = (campo: CampoReconciliado) =>
      Prisma.sql`${Prisma.raw(`"${COL[campo].produto}"`)} = CASE WHEN ${c[campo].escreve} THEN s.${Prisma.raw(COL[campo].fonte)} ELSE p.${Prisma.raw(`"${COL[campo].produto}"`)} END`;
    // `o` é a mesma linha lida ANTES do UPDATE (o mesmo snapshot): é de onde vêm os valores anteriores.
    const ret = (campo: CampoReconciliado) => {
      const col = Prisma.raw(`"${COL[campo].produto}"`);
      return Prisma.sql`o.${col} AS "ant_${Prisma.raw(campo)}", p.${col} AS "nov_${Prisma.raw(campo)}"`;
    };
    const gravadas = await db.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      WITH s AS (${src})
      UPDATE "Produto" p SET
        ${set("formaFarmaceutica")}, ${set("dosagem")}, ${set("embalagem")}, ${set("dci")},
        "dataAtualizacao" = now()
      FROM s, "Produto" o
      WHERE p.id = s.pid AND o.id = p.id AND ${alguma}
      RETURNING p.id AS pid, p.cnp AS cnp, ${ret("formaFarmaceutica")}, ${ret("dosagem")}, ${ret("embalagem")}, ${ret("dci")}`);
    if (opcoes.registarAlteracoes) {
      const alteracoes: AlteracaoCampo[] = [];
      for (const g of gravadas) {
        for (const campo of CAMPOS_RECONCILIADOS) {
          const ant = (g[`ant_${campo}`] as string | null) ?? null;
          const nov = (g[`nov_${campo}`] as string | null) ?? null;
          if (nov === null || nov === ant) continue;
          // «vazio» tem o mesmo critério da reconciliação: nulo ou só espaços.
          const estavaVazio = ant === null || ant.trim() === "";
          alteracoes.push({ produtoId: String(g.pid), cnp: Number(g.cnp), campo, anterior: ant, aplicado: nov, tipo: estavaVazio ? "PREENCHIMENTO" : "ATUALIZACAO" });
        }
      }
      alteracoes.sort((x, y) => x.cnp - y.cnp || x.campo.localeCompare(y.campo));
      out.alteracoes = alteracoes;
      if (opcoes.antesDeConfirmar) await opcoes.antesDeConfirmar(alteracoes);
    }
  }
  return out;
}

/** Soma de alterações (preenchidos + atualizados) — útil para resumos. */
export function totalEscrito(c: ContadoresReconciliacao): number {
  return CAMPOS_RECONCILIADOS.reduce((t, k) => t + c.campos[k].preenchidos + c.campos[k].atualizados, 0);
}

/** Reconcilia a versão ATIVA do tenant (sem importação nova). `null` se não há versão ativa. */
export async function reconciliarVersaoAtiva(
  prisma: PrismaClient,
  opcoes: { apply: boolean; registarAlteracoes?: boolean; antesDeConfirmar?: (alteracoes: AlteracaoCampo[]) => void | Promise<void> },
): Promise<{ importacaoId: string; sha256: string; contadores: ContadoresReconciliacao } | null> {
  const ativa = await prisma.infarmedImportacao.findFirst({ where: { ativa: true }, select: { id: true, sha256: true } });
  if (!ativa) return null;
  if (!opcoes.apply) {
    return { importacaoId: ativa.id, sha256: ativa.sha256, contadores: await reconciliarProdutos(prisma, { tipo: "importacao", importacaoId: ativa.id }, { apply: false }) };
  }
  const contadores = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(7203201001)`; // o mesmo lock da aplicação/rollback
      const ainda = await tx.infarmedImportacao.findFirst({ where: { ativa: true }, select: { id: true } });
      if (!ainda || ainda.id !== ativa.id) throw new Error("A versão ativa mudou durante a reconciliação; repetir.");
      return reconciliarProdutos(tx as unknown as Db, { tipo: "importacao", importacaoId: ativa.id }, { apply: true, registarAlteracoes: opcoes.registarAlteracoes, antesDeConfirmar: opcoes.antesDeConfirmar });
    },
    { timeout: 300_000, maxWait: 60_000 },
  );
  return { importacaoId: ativa.id, sha256: ativa.sha256, contadores };
}
