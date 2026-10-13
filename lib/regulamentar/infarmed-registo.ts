/**
 * lib/regulamentar/infarmed-registo.ts
 *
 * REGISTO REVERSÍVEL DURÁVEL da reconciliação do catálogo com o INFARMED.
 *
 * Toda a reconciliação que escreve em `Produto.formaFarmaceutica/dosagem/embalagem/dci`
 * — `--reconciliar --apply`, download mensal automático e upload manual — grava, NA
 * MESMA TRANSAÇÃO das alterações, uma linha de `AuditLog` da base do tenant:
 *
 *   action   = INFARMED_RECONCILIACAO
 *   entity   = InfarmedReconciliacao
 *   entityId = <operacaoId>            (o mesmo nas bases de todos os tenants da operação)
 *   metaJson = { formato, operacaoId, origem, tenant, utilizadorEmail, data, importacaoId,
 *                sha256, integridade, campos, porCampo, alteracoes[] }
 *
 * Porquê aqui (sem migration): a tabela já existe em todos os tenants, vive na mesma base
 * (e nas mesmas cópias de segurança) que os dados que protege, e partilha a transação — se o
 * registo não puder ser gravado, as alterações ao catálogo NÃO confirmam; e uma falha num
 * tenant nunca apaga o registo dos tenants já concluídos (bases e transações separadas).
 * Não depende do sistema de ficheiros efémero do contentor.
 *
 * O ficheiro `reconciliacao-<operacaoId>.json` (formato `infarmed-reconciliacao/v1`, o MESMO
 * que o comando de reversão aceita) é reconstruído a partir daqui — ver `obterRelatorio`.
 * Uma operação sem alterações não grava nada (nunca há relatório vazio).
 *
 * Reverter marca a operação (action INFARMED_RECONCILIACAO_REVERTIDA, mesma entityId).
 */

import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import {
  CAMPOS_RECONCILIADOS,
  reconciliarProdutos,
  type AlteracaoCampo,
  type ContadoresReconciliacao,
  type FonteReconciliacao,
} from "./infarmed-reconciliar";
import {
  FORMATO_RELATORIO_RECONCILIACAO,
  alteracoesParaRelatorio,
  integridadeDe,
  validarRelatorio,
  ACAO_REVERTIDA,
  ENTIDADE_RECONCILIACAO,
  FalhaRegistoReversivel,
  type RelatorioReconciliacao,
  type TenantRelatorio,
} from "./infarmed-reverter";

export const ACAO_RECONCILIACAO = "INFARMED_RECONCILIACAO";
export { ACAO_REVERTIDA, ENTIDADE_RECONCILIACAO, FalhaRegistoReversivel };
export type OrigemReversivel = "RECONCILIACAO_MANUAL" | "DOWNLOAD_AUTOMATICO" | "UPLOAD_MANUAL";

/** A origem do motor de importação → a origem do registo (a CLI de carga/manual é uma operação manual). */
export function origemReversivelDe(origemImportacao: string): OrigemReversivel {
  if (origemImportacao === "MENSAL") return "DOWNLOAD_AUTOMATICO";
  if (origemImportacao === "UPLOAD_MANUAL") return "UPLOAD_MANUAL";
  return "RECONCILIACAO_MANUAL";
}

export type ContextoRegisto = {
  operacaoId: string;
  origem: OrigemReversivel;
  tenant: string;
  utilizadorEmail?: string | null;
  importacaoId?: string | null;
  sha256?: string | null;
  /** Data da operação (a mesma em todos os tenants); omissão: agora. */
  data?: string;
};

export const novaOperacaoId = () => randomUUID();

type Db = Pick<PrismaClient, "$queryRaw" | "$executeRaw" | "auditLog" | "infarmedImportacao">;

/** Conteúdo gravado em `AuditLog.metaJson` (compacto: o que se repete é reconstruído na exportação). */
export type RegistoGravado = {
  formato: typeof FORMATO_RELATORIO_RECONCILIACAO;
  operacaoId: string;
  origem: OrigemReversivel;
  tenant: string;
  utilizadorEmail: string | null;
  data: string;
  importacaoId: string;
  sha256: string;
  /** sha256 das alterações EXPANDIDAS (as do ficheiro) — verificada na exportação. */
  integridade: string;
  campos: number;
  porCampo: Record<string, number>;
  alteracoes: AlteracaoCampo[];
};

export function montarRegisto(ctx: ContextoRegisto, alteracoes: readonly AlteracaoCampo[]): RegistoGravado {
  const data = ctx.data ?? new Date().toISOString();
  const expandidas = alteracoesParaRelatorio(ctx.tenant, ctx.operacaoId, data, alteracoes);
  const porCampo: Record<string, number> = Object.fromEntries(CAMPOS_RECONCILIADOS.map((c) => [c, 0]));
  for (const a of alteracoes) porCampo[a.campo]++;
  return {
    formato: FORMATO_RELATORIO_RECONCILIACAO,
    operacaoId: ctx.operacaoId,
    origem: ctx.origem,
    tenant: ctx.tenant,
    utilizadorEmail: ctx.utilizadorEmail ?? null,
    data,
    importacaoId: ctx.importacaoId ?? "",
    sha256: ctx.sha256 ?? "",
    integridade: integridadeDe(expandidas),
    campos: alteracoes.length,
    porCampo,
    alteracoes: alteracoes.map((a) => ({ produtoId: a.produtoId, cnp: a.cnp, campo: a.campo, anterior: a.anterior, aplicado: a.aplicado, tipo: a.tipo })),
  };
}

/** Grava o registo no cliente/transação recebido. Sem alterações: não grava nada. */
export async function gravarRegisto(db: Db, ctx: ContextoRegisto, alteracoes: readonly AlteracaoCampo[]): Promise<RegistoGravado | null> {
  if (alteracoes.length === 0) return null;
  const registo = montarRegisto(ctx, alteracoes);
  try {
    await db.auditLog.create({
      data: { action: ACAO_RECONCILIACAO, entity: ENTIDADE_RECONCILIACAO, entityId: ctx.operacaoId, metaJson: JSON.stringify(registo) },
    });
  } catch (e) {
    throw new FalhaRegistoReversivel(e);
  }
  return registo;
}

export type ContadoresComRegisto = Omit<ContadoresReconciliacao, "alteracoes"> & {
  /** Preenchido quando houve alterações (e portanto registo reversível). */
  registoReversivel: { operacaoId: string; origem: OrigemReversivel; campos: number } | null;
};

/**
 * Reconcilia (apply) E grava o registo reversível, no mesmo cliente/transação.
 * `extra` corre depois, ainda antes de o chamador confirmar (ex.: o ficheiro da CLI): se lançar, tudo é anulado.
 */
export async function reconciliarComRegisto(
  db: Db & Parameters<typeof reconciliarProdutos>[0],
  fonte: FonteReconciliacao,
  ctx: ContextoRegisto,
  extra?: (alteracoes: AlteracaoCampo[]) => void | Promise<void>,
): Promise<ContadoresComRegisto> {
  let gravado: RegistoGravado | null = null;
  const r = await reconciliarProdutos(db, fonte, {
    apply: true,
    registarAlteracoes: true,
    antesDeConfirmar: async (alt) => {
      gravado = await gravarRegisto(db, ctx, alt);
      if (extra) await extra(alt);
    },
  });
  const { alteracoes: _omitidas, ...resumo } = r;
  void _omitidas;
  const g = gravado as RegistoGravado | null;
  return { ...resumo, registoReversivel: g ? { operacaoId: g.operacaoId, origem: g.origem, campos: g.campos } : null };
}

// ── Consulta e exportação ────────────────────────────────────────────

export type OperacaoReversivel = {
  operacaoId: string;
  origem: OrigemReversivel;
  data: string;
  utilizadorEmail: string | null;
  /** Um registo por tenant. */
  tenants: Array<{ tenant: string; campos: number; porCampo: Record<string, number>; estado: "APLICADA" | "REVERTIDA" }>;
  campos: number;
  estado: "APLICADA" | "REVERTIDA" | "PARCIALMENTE_REVERTIDA";
};

type LinhaResumo = { entityId: string; criadoEm: Date; origem: string; tenant: string; utilizador: string | null; data: string; campos: number; porCampo: Record<string, number> };

/** Lê só o cabeçalho de cada registo (sem carregar as alterações). */
async function resumos(prisma: Pick<PrismaClient, "$queryRaw">, limite: number): Promise<LinhaResumo[]> {
  const rows = await prisma.$queryRaw<Array<{ entityId: string; createdAt: Date; m: Record<string, unknown> }>>(Prisma.sql`
    SELECT "entityId", "createdAt",
           (("metaJson"::jsonb) - 'alteracoes') AS m
      FROM "AuditLog"
     WHERE "action" = ${ACAO_RECONCILIACAO}
     ORDER BY "createdAt" DESC
     LIMIT ${limite}`);
  return rows.map((r) => ({
    entityId: r.entityId, criadoEm: r.createdAt, origem: String(r.m.origem), tenant: String(r.m.tenant),
    utilizador: (r.m.utilizadorEmail as string | null) ?? null, data: String(r.m.data), campos: Number(r.m.campos ?? 0),
    porCampo: (r.m.porCampo as Record<string, number>) ?? {},
  }));
}

async function revertidas(prisma: Pick<PrismaClient, "$queryRaw">): Promise<Set<string>> {
  const rows = await prisma.$queryRaw<Array<{ entityId: string }>>(Prisma.sql`
    SELECT DISTINCT "entityId" FROM "AuditLog" WHERE "action" = ${ACAO_REVERTIDA}`);
  return new Set(rows.map((r) => r.entityId));
}

/** Operações reversíveis (mais recentes primeiro) reunindo os tenants indicados. */
export async function listarOperacoes(tenants: Array<{ slug: string; prisma: Pick<PrismaClient, "$queryRaw"> }>, limite = 30): Promise<OperacaoReversivel[]> {
  const porOp = new Map<string, OperacaoReversivel>();
  for (const t of tenants) {
    const rev = await revertidas(t.prisma);
    for (const r of await resumos(t.prisma, limite)) {
      const op = porOp.get(r.entityId) ?? { operacaoId: r.entityId, origem: r.origem as OrigemReversivel, data: r.data, utilizadorEmail: r.utilizador, tenants: [], campos: 0, estado: "APLICADA" as const };
      op.tenants.push({ tenant: r.tenant || t.slug, campos: r.campos, porCampo: r.porCampo, estado: rev.has(r.entityId) ? "REVERTIDA" : "APLICADA" });
      op.campos += r.campos;
      porOp.set(r.entityId, op);
    }
  }
  const ops = [...porOp.values()];
  for (const op of ops) {
    const n = op.tenants.filter((t) => t.estado === "REVERTIDA").length;
    op.estado = n === 0 ? "APLICADA" : n === op.tenants.length ? "REVERTIDA" : "PARCIALMENTE_REVERTIDA";
    op.tenants.sort((a, b) => a.tenant.localeCompare(b.tenant));
  }
  return ops.sort((a, b) => b.data.localeCompare(a.data)).slice(0, limite);
}

/**
 * Reconstrói o relatório (formato v1, o aceite por `--reverter-reconciliacao`) de uma operação,
 * a partir dos registos dos tenants indicados. Verifica a integridade de cada registo.
 * Devolve `null` se nenhum tenant tem registo dessa operação.
 */
export async function obterRelatorio(
  tenants: Array<{ slug: string; prisma: Pick<PrismaClient, "auditLog"> }>,
  operacaoId: string,
): Promise<RelatorioReconciliacao | null> {
  const entradas: TenantRelatorio[] = [];
  let geradoEm = "";
  let origem: OrigemReversivel | undefined;
  for (const t of tenants) {
    const linhas = await t.prisma.auditLog.findMany({ where: { action: ACAO_RECONCILIACAO, entityId: operacaoId }, orderBy: { createdAt: "asc" } });
    for (const l of linhas) {
      const g = JSON.parse(l.metaJson ?? "{}") as RegistoGravado;
      const alteracoes = alteracoesParaRelatorio(g.tenant, g.operacaoId, g.data, g.alteracoes);
      if (integridadeDe(alteracoes) !== g.integridade) throw new Error(`Registo corrompido (tenant ${g.tenant}, operação ${operacaoId}): a soma de integridade não corresponde.`);
      entradas.push({ tenant: g.tenant, importacaoId: g.importacaoId, sha256: g.sha256, estado: "CONFIRMADO", integridade: g.integridade, alteracoes, origem: g.origem, utilizadorEmail: g.utilizadorEmail, data: g.data });
      if (!geradoEm || g.data < geradoEm) geradoEm = g.data;
      origem = origem ?? g.origem;
    }
  }
  if (entradas.length === 0) return null;
  entradas.sort((a, b) => a.tenant.localeCompare(b.tenant));
  const relatorio: RelatorioReconciliacao = { formato: FORMATO_RELATORIO_RECONCILIACAO, operacaoId, geradoEm, modo: "APPLY", origem, tenants: entradas };
  return validarRelatorio(JSON.parse(JSON.stringify(relatorio)));
}
