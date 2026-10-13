/**
 * lib/regulamentar/infarmed-reverter.ts
 *
 * Reversão OPERACIONAL da reconciliação do catálogo com o INFARMED.
 *
 * O `ops:infarmed-carga --reconciliar --apply` grava um relatório
 * (`reconciliacao-<operacaoId>.json`) com, por campo alterado: tenant,
 * `Produto.id`, CNP, campo, valor anterior (incluindo `null`), valor aplicado,
 * tipo (preenchimento/atualização), data e identificador da operação. Este
 * módulo lê esse relatório e repõe EXATAMENTE os valores anteriores, sem
 * precisar de nenhuma cópia da base.
 *
 * Regras, por campo alterado (avaliadas contra o valor ATUAL do produto):
 *   · atual = aplicado           → repõe o anterior;
 *   · atual = anterior           → já revertido / nunca chegou a ser gravado: nada a fazer
 *                                  (é o que torna a reversão idempotente);
 *   · atual ≠ aplicado e ≠ anterior → alguém editou depois: CONFLITO, não toca
 *                                  (nunca se destrói uma edição posterior);
 *   · o campo está agora em `camposManuais` → protegido, não toca;
 *   · o produto já não existe     → registado, não toca.
 *
 * Só escreve as 4 colunas reconciliadas e `dataAtualizacao`. Nunca `designacao`.
 * Um tenant de cada vez, numa transação, com o mesmo lock da importação/rollback.
 * A integridade do ficheiro é verificada (sha256 das alterações) antes de qualquer leitura da base.
 */

import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { CAMPOS_RECONCILIADOS, type AlteracaoCampo, type CampoReconciliado } from "./infarmed-reconciliar";

export const FORMATO_RELATORIO_RECONCILIACAO = "infarmed-reconciliacao/v1";
const LOCK_INFARMED = 7203201001;

export const ACAO_REVERTIDA = "INFARMED_RECONCILIACAO_REVERTIDA";
export const ENTIDADE_RECONCILIACAO = "InfarmedReconciliacao";

/** O registo reversível (ou a marca de reversão) não pôde ser gravado: a transação NÃO deve confirmar. */
export class FalhaRegistoReversivel extends Error {
  constructor(causa: unknown) {
    super(`Falha ao guardar o registo reversível da reconciliação (as alterações ao catálogo NÃO foram confirmadas): ${causa instanceof Error ? causa.message : String(causa)}`);
    this.name = "FalhaRegistoReversivel";
  }
}

/** Uma alteração tal como fica no ficheiro (autossuficiente para auditoria). */
export type AlteracaoRelatorio = AlteracaoCampo & { tenant: string; operacaoId: string; data: string };

export type TenantRelatorio = {
  tenant: string;
  importacaoId: string;
  sha256: string;
  /** PENDENTE = gravado em disco antes de a transação confirmar; CONFIRMADO = transação confirmada. */
  estado: "PENDENTE" | "CONFIRMADO";
  /** sha256 do JSON de `alteracoes` — deteta ficheiros editados ou truncados. */
  integridade: string;
  alteracoes: AlteracaoRelatorio[];
  /** Quem/como (relatórios gerados a partir do registo durável). */
  origem?: string;
  utilizadorEmail?: string | null;
  data?: string;
};

export type RelatorioReconciliacao = {
  formato: typeof FORMATO_RELATORIO_RECONCILIACAO;
  operacaoId: string;
  geradoEm: string;
  modo: "APPLY";
  /** RECONCILIACAO_MANUAL | DOWNLOAD_AUTOMATICO | UPLOAD_MANUAL (ausente nos relatórios antigos da CLI). */
  origem?: string;
  tenants: TenantRelatorio[];
};

export const integridadeDe = (alteracoes: readonly AlteracaoRelatorio[]) =>
  createHash("sha256").update(JSON.stringify(alteracoes)).digest("hex");

export function alteracoesParaRelatorio(tenant: string, operacaoId: string, data: string, alteracoes: readonly AlteracaoCampo[]): AlteracaoRelatorio[] {
  return alteracoes.map((a) => ({ tenant, operacaoId, data, ...a }));
}

/** Valida a forma do ficheiro e a integridade; lança com a razão em português. */
export function validarRelatorio(bruto: unknown): RelatorioReconciliacao {
  const r = bruto as Partial<RelatorioReconciliacao> | null;
  if (!r || typeof r !== "object") throw new Error("Relatório inválido: não é um objeto JSON.");
  if (r.formato !== FORMATO_RELATORIO_RECONCILIACAO) {
    throw new Error(`Relatório inválido: formato «${String(r.formato)}» (esperado «${FORMATO_RELATORIO_RECONCILIACAO}»). Só relatórios de um --reconciliar --apply podem ser revertidos.`);
  }
  if (r.modo !== "APPLY") throw new Error("Relatório inválido: não é de uma aplicação (--apply).");
  if (!r.operacaoId || typeof r.operacaoId !== "string") throw new Error("Relatório inválido: sem identificador da operação.");
  if (!Array.isArray(r.tenants)) throw new Error("Relatório inválido: sem lista de tenants.");
  for (const t of r.tenants) {
    if (!t || typeof t.tenant !== "string" || !Array.isArray(t.alteracoes)) throw new Error("Relatório inválido: entrada de tenant malformada.");
    if (integridadeDe(t.alteracoes) !== t.integridade) {
      throw new Error(`Relatório adulterado ou truncado (tenant ${t.tenant}): a soma de integridade não corresponde. Nada foi alterado.`);
    }
    for (const a of t.alteracoes) {
      const campoValido = (CAMPOS_RECONCILIADOS as readonly string[]).includes(a.campo);
      const valido = campoValido && typeof a.produtoId === "string" && Number.isInteger(a.cnp) && typeof a.aplicado === "string" && (a.anterior === null || typeof a.anterior === "string");
      if (!valido) throw new Error(`Relatório inválido (tenant ${t.tenant}): alteração malformada (cnp ${String(a.cnp)}, campo ${String(a.campo)}).`);
    }
  }
  return r as RelatorioReconciliacao;
}

export type ConflitoReversao = {
  cnp: number;
  campo: CampoReconciliado;
  motivo: "VALOR_ALTERADO_DEPOIS" | "CAMPO_PROTEGIDO_MANUAL" | "PRODUTO_INEXISTENTE";
  atual: string | null;
  esperado: string;
};

export type ResultadoReversaoTenant = {
  tenant: string;
  /** Alterações no relatório. */
  analisadas: number;
  /** Repostas (ou a repor, em dry-run). */
  revertidas: number;
  /** Já com o valor anterior: nada a fazer. */
  jaRevertidas: number;
  conflitos: ConflitoReversao[];
  porCampo: Record<CampoReconciliado, { revertidas: number; jaRevertidas: number; conflitos: number }>;
};

type Db = Pick<PrismaClient, "$queryRaw" | "$executeRaw">;

const vazioPorCampo = () => Object.fromEntries(CAMPOS_RECONCILIADOS.map((c) => [c, { revertidas: 0, jaRevertidas: 0, conflitos: 0 }])) as ResultadoReversaoTenant["porCampo"];

/** Lê e classifica; com `apply` repõe. Tudo no cliente/transação recebido. */
async function reverterComDb(db: Db, t: TenantRelatorio, apply: boolean): Promise<ResultadoReversaoTenant> {
  const res: ResultadoReversaoTenant = { tenant: t.tenant, analisadas: t.alteracoes.length, revertidas: 0, jaRevertidas: 0, conflitos: [], porCampo: vazioPorCampo() };
  const ids = [...new Set(t.alteracoes.map((a) => a.produtoId))];
  const atuais = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < ids.length; i += 5000) {
    const lote = ids.slice(i, i + 5000);
    const rows = await db.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT id, "formaFarmaceutica", "dosagem", "embalagem", "dci", "camposManuais" FROM "Produto" WHERE id = ANY(${lote}::text[])`);
    for (const r of rows) atuais.set(String(r.id), r);
  }

  const aRepor: Record<CampoReconciliado, AlteracaoRelatorio[]> = { formaFarmaceutica: [], dosagem: [], embalagem: [], dci: [] };
  for (const a of t.alteracoes) {
    const p = atuais.get(a.produtoId);
    const conflito = (motivo: ConflitoReversao["motivo"], atual: string | null) => {
      res.conflitos.push({ cnp: a.cnp, campo: a.campo, motivo, atual, esperado: a.aplicado });
      res.porCampo[a.campo].conflitos++;
    };
    if (!p) { conflito("PRODUTO_INEXISTENTE", null); continue; }
    const atual = (p[a.campo] as string | null) ?? null;
    if (atual === a.anterior) { res.jaRevertidas++; res.porCampo[a.campo].jaRevertidas++; continue; }
    if (atual !== a.aplicado) { conflito("VALOR_ALTERADO_DEPOIS", atual); continue; }
    const manuais = (p.camposManuais as string[] | null) ?? [];
    if (manuais.includes(a.campo)) { conflito("CAMPO_PROTEGIDO_MANUAL", atual); continue; }
    aRepor[a.campo].push(a);
    res.revertidas++;
    res.porCampo[a.campo].revertidas++;
  }

  if (apply && res.revertidas > 0) {
    for (const campo of CAMPOS_RECONCILIADOS) {
      const lista = aRepor[campo];
      if (lista.length === 0) continue;
      const col = Prisma.raw(`"${campo}"`); // `campo` vem da lista fechada (validada)
      const feitos = await db.$executeRaw(Prisma.sql`
        UPDATE "Produto" p SET ${col} = u.ant, "dataAtualizacao" = now()
          FROM unnest(${lista.map((a) => a.produtoId)}::text[], ${lista.map((a) => a.anterior)}::text[], ${lista.map((a) => a.aplicado)}::text[]) AS u(pid, ant, apl)
         WHERE p.id = u.pid AND p.${col} IS NOT DISTINCT FROM u.apl AND NOT (${campo} = ANY(p."camposManuais"))`);
      // Nunca mais nem menos do que o previsto: qualquer diferença anula a transação.
      if (feitos !== lista.length) throw new Error(`Reversão de «${campo}» no tenant ${t.tenant}: esperadas ${lista.length} linhas, escritas ${feitos}. Transação anulada.`);
    }
  }
  return res;
}

export type OpcoesReversao = {
  apply: boolean;
  /** Com apply, marca a operação como revertida (AuditLog) na MESMA transação. */
  operacaoId?: string;
};

/** Marca a reversão (dentro da transação da reversão). */
export async function gravarReversao(
  db: Pick<PrismaClient, "auditLog">,
  p: { operacaoId: string; tenant: string; revertidas: number; jaRevertidas: number; conflitos: number },
): Promise<void> {
  try {
    await db.auditLog.create({
      data: { action: ACAO_REVERTIDA, entity: ENTIDADE_RECONCILIACAO, entityId: p.operacaoId, metaJson: JSON.stringify({ ...p, data: new Date().toISOString() }) },
    });
  } catch (e) {
    throw new FalhaRegistoReversivel(e);
  }
}

/** Reverte UM tenant do relatório. `prisma` é o cliente desse tenant. */
export async function reverterReconciliacaoTenant(prisma: PrismaClient, t: TenantRelatorio, opcoes: OpcoesReversao): Promise<ResultadoReversaoTenant> {
  if (!opcoes.apply) return reverterComDb(prisma, t, false);
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_INFARMED})`;
      const r = await reverterComDb(tx as unknown as Db, t, true);
      if (opcoes.operacaoId && r.revertidas > 0) {
        await gravarReversao(tx, { operacaoId: opcoes.operacaoId, tenant: t.tenant, revertidas: r.revertidas, jaRevertidas: r.jaRevertidas, conflitos: r.conflitos.length });
      }
      return r;
    },
    { timeout: 300_000, maxWait: 60_000 },
  );
}
