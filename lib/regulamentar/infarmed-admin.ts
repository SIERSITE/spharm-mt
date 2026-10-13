/**
 * lib/regulamentar/infarmed-admin.ts
 *
 * Lógica da página /admin/infarmed (upload manual dos dados do INFARMED,
 * estado e repetição por tenant), SEM dependência de Next: recebe a sessão e
 * as dependências, para se poder testar com bases reais e sem browser.
 *
 * Segurança:
 *   · TODAS as ações validam a sessão (`isPlatformAdminSession`) — esconder o
 *     link não é autorização;
 *   · o ficheiro NUNCA toca no disco: valida-se e aplica-se a partir da memória
 *     (não há caminhos, nem área temporária, nem nada para limpar ou expor);
 *     o nome só serve de rótulo (sanitizado);
 *   · a extensão e o nome não provam nada: a assinatura OLE2, a folha e as 13
 *     colunas são verificadas sobre o conteúdo;
 *   · aplicar exige confirmação explícita e o SHA-256 do ficheiro validado.
 */

import type { SessionUser } from "@/lib/auth";
import { isPlatformAdminSession } from "@/lib/admin/auth";
import { FicheiroInfarmedInvalido } from "./infarmed-ficheiro";
import { listarOperacoes, obterRelatorio, type OperacaoReversivel } from "./infarmed-registo";
import type { RelatorioReconciliacao } from "./infarmed-reverter";
import {
  aplicarFicheiroManual,
  executarAtualizacaoAutomatica,
  previsualizarFicheiro,
  type Dependencias,
  type PreviewUpload,
  type ResultadoAtualizacao,
} from "./infarmed-atualizacao";

export const UPLOAD_MAX_BYTES = 12 * 1024 * 1024;
export const CONFIRMACAO = "APLICAR";

export type Falha = { ok: false; erro: string; codigo: "NAO_AUTORIZADO" | "FICHEIRO" | "CONFIRMACAO" | "INESPERADO" };
export type FicheiroUpload = { name: string; size: number; arrayBuffer(): Promise<ArrayBuffer> };

const NAO_AUTORIZADO: Falha = { ok: false, erro: "Sem permissão para esta operação.", codigo: "NAO_AUTORIZADO" };

export function nomeSeguro(nome: string): string {
  const base = nome.split(/[\\/]/).pop() ?? "ficheiro";
  return base.replace(/[\u0000-\u001f<>:"|?*]/g, "_").slice(0, 120) || "ficheiro";
}

async function lerUpload(f: unknown): Promise<{ buffer: Buffer; nome: string } | Falha> {
  if (!f || typeof f !== "object" || typeof (f as FicheiroUpload).arrayBuffer !== "function") {
    return { ok: false, erro: "Selecione o ficheiro do INFARMED (.xls).", codigo: "FICHEIRO" };
  }
  const up = f as FicheiroUpload;
  const nome = nomeSeguro(up.name);
  if (!/\.xls$/i.test(nome)) {
    return { ok: false, erro: "O ficheiro tem de ser um Excel 97-2003 (.xls), como o allPackages.xls do INFARMED.", codigo: "FICHEIRO" };
  }
  if (up.size <= 0) return { ok: false, erro: "O ficheiro está vazio.", codigo: "FICHEIRO" };
  if (up.size > UPLOAD_MAX_BYTES) {
    return { ok: false, erro: `O ficheiro excede ${UPLOAD_MAX_BYTES / 1024 / 1024} MB.`, codigo: "FICHEIRO" };
  }
  return { buffer: Buffer.from(await up.arrayBuffer()), nome };
}

export function textoFalhaFicheiro(e: unknown): string {
  return e instanceof FicheiroInfarmedInvalido ? e.message : "Não foi possível processar o ficheiro.";
}

/** 1.º passo: valida o ficheiro e simula em todos os tenants. NÃO escreve nada. */
export async function acaoValidarUpload(
  deps: Dependencias,
  session: SessionUser | null,
  ficheiro: unknown,
): Promise<{ ok: true; preview: PreviewUpload } | Falha> {
  if (!isPlatformAdminSession(session)) return NAO_AUTORIZADO;
  const f = await lerUpload(ficheiro);
  if ("ok" in f) return f;
  try {
    return { ok: true, preview: await previsualizarFicheiro(deps, f.buffer, f.nome) };
  } catch (e) {
    if (e instanceof FicheiroInfarmedInvalido) return { ok: false, erro: e.message, codigo: "FICHEIRO" };
    (deps.log ?? console.error)(`[infarmed] validação do upload falhou: ${e instanceof Error ? e.message : String(e)}`);
    return { ok: false, erro: "Não foi possível validar o ficheiro.", codigo: "INESPERADO" };
  }
}

/** 2.º passo: confirmação explícita + mesmo ficheiro (SHA-256) ⇒ aplica pelo mesmo motor. */
export async function acaoAplicarUpload(
  deps: Dependencias,
  session: SessionUser | null,
  p: { ficheiro: unknown; sha256Esperado: string; confirmar: string; onlySlugs?: string[]; forcar?: boolean },
): Promise<{ ok: true; resultado: ResultadoAtualizacao } | Falha> {
  if (!isPlatformAdminSession(session)) return NAO_AUTORIZADO;
  if (p.confirmar !== CONFIRMACAO) {
    return { ok: false, erro: `Confirmação em falta: escreva «${CONFIRMACAO}» para aplicar.`, codigo: "CONFIRMACAO" };
  }
  const f = await lerUpload(p.ficheiro);
  if ("ok" in f) return f;
  try {
    const resultado = await aplicarFicheiroManual(deps, {
      buffer: f.buffer, nomeFicheiro: f.nome, utilizadorEmail: session!.email, sha256Esperado: p.sha256Esperado,
      onlySlugs: p.onlySlugs, forcar: p.forcar,
    });
    return { ok: true, resultado };
  } catch (e) {
    if (e instanceof FicheiroInfarmedInvalido) return { ok: false, erro: e.message, codigo: "FICHEIRO" };
    (deps.log ?? console.error)(`[infarmed] aplicação do upload falhou: ${e instanceof Error ? e.message : String(e)}`);
    return { ok: false, erro: "Não foi possível aplicar o ficheiro.", codigo: "INESPERADO" };
  }
}

/** Repete a atualização automática (um único download) para os tenants indicados — ou para todos. */
export async function acaoRepetir(
  deps: Dependencias,
  session: SessionUser | null,
  p: { onlySlugs?: string[]; forcar?: boolean },
): Promise<{ ok: true; resultado: ResultadoAtualizacao } | Falha> {
  if (!isPlatformAdminSession(session)) return NAO_AUTORIZADO;
  try {
    return { ok: true, resultado: await executarAtualizacaoAutomatica(deps, { onlySlugs: p.onlySlugs, forcar: p.forcar, utilizadorEmail: session!.email }) };
  } catch (e) {
    (deps.log ?? console.error)(`[infarmed] repetição falhou: ${e instanceof Error ? e.message : String(e)}`);
    return { ok: false, erro: "Não foi possível executar a atualização.", codigo: "INESPERADO" };
  }
}

// ── Estado para a página ─────────────────────────────────────────────

export type LinhaImportacao = {
  id: string; estado: string; origem: string; ativa: boolean; quando: string; sha256: string;
  nomeFicheiro: string | null; utilizadorEmail: string | null; linhasLidas: number; produtosAssociados: number; erro: string | null;
};
export type EstadoTenantInfarmed = {
  slug: string; nome: string; ativa: LinhaImportacao | null; recentes: LinhaImportacao[]; ultimaFalhou: boolean;
};
export type EstadoAdminInfarmed = {
  alertaPendente: null | {
    periodo: string; motivo: string; tentativas: number; tenantsFalhados: string[];
    notificacaoEstado: string; notificadoEm: string | null; notificacaoErro: string | null; criadoEm: string;
  };
  ultimaExecucao: ExecucaoLinha | null;
  ultimoDownloadAutomatico: ExecucaoLinha | null;
  execucoes: ExecucaoLinha[];
  tenants: EstadoTenantInfarmed[];
  /** Operações de reconciliação reversíveis (download automático, upload manual, CLI), mais recentes primeiro. */
  reconciliacoes: OperacaoReversivel[];
};
export type ExecucaoLinha = {
  id: string; periodo: string; origem: string; resultado: string; motivo: string | null; quando: string;
  utilizadorEmail: string | null; sha256: string | null;
  tenants: Array<{ slug: string; resultado: string; ok: boolean; motivo?: string }>;
};

function linha(r: {
  id: string; estado: string; origem: string; ativa: boolean; iniciadaEm: Date; sha256: string; nomeFicheiro: string | null;
  utilizadorEmail: string | null; linhasLidas: number; produtosAssociados: number; erro: string | null;
}): LinhaImportacao {
  return {
    id: r.id, estado: r.estado, origem: r.origem, ativa: r.ativa, quando: r.iniciadaEm.toISOString(), sha256: r.sha256,
    nomeFicheiro: r.nomeFicheiro, utilizadorEmail: r.utilizadorEmail, linhasLidas: r.linhasLidas,
    produtosAssociados: r.produtosAssociados, erro: r.erro,
  };
}

export async function lerEstadoAdmin(deps: Pick<Dependencias, "control" | "tenants">): Promise<EstadoAdminInfarmed> {
  const { control } = deps;
  const exec = (e: { id: string; periodo: string; origem: string; resultado: string; motivo: string | null; iniciadaEm: Date; utilizadorEmail: string | null; sha256: string | null; tenants: unknown }): ExecucaoLinha => ({
    id: e.id, periodo: e.periodo, origem: e.origem, resultado: e.resultado, motivo: e.motivo, quando: e.iniciadaEm.toISOString(),
    utilizadorEmail: e.utilizadorEmail, sha256: e.sha256,
    tenants: Array.isArray(e.tenants) ? (e.tenants as ExecucaoLinha["tenants"]) : [],
  });
  const [alerta, execs, ultimoAuto] = await Promise.all([
    control.infarmedAlerta.findFirst({ where: { estado: "PENDENTE" }, orderBy: { criadoEm: "desc" } }),
    control.infarmedExecucao.findMany({ orderBy: { iniciadaEm: "desc" }, take: 10 }),
    control.infarmedExecucao.findFirst({ where: { origem: { in: ["AUTOMATICA", "REPETICAO"] } }, orderBy: { iniciadaEm: "desc" } }),
  ]);
  const tenants: EstadoTenantInfarmed[] = [];
  for (const t of await deps.tenants()) {
    const [ativa, recentes] = await Promise.all([
      t.prisma.infarmedImportacao.findFirst({ where: { ativa: true } }),
      t.prisma.infarmedImportacao.findMany({ orderBy: { iniciadaEm: "desc" }, take: 5 }),
    ]);
    tenants.push({
      slug: t.slug, nome: (t as { nome?: string }).nome ?? t.slug,
      ativa: ativa ? linha(ativa) : null, recentes: recentes.map(linha), ultimaFalhou: recentes[0]?.estado === "FALHADA",
    });
  }
  const reconciliacoes = await listarOperacoes(await deps.tenants(), 30).catch((e) => {
    console.error(`[infarmed] não foi possível listar as reconciliações reversíveis: ${e instanceof Error ? e.message : String(e)}`);
    return [] as OperacaoReversivel[];
  });
  return {
    reconciliacoes,
    alertaPendente: alerta
      ? {
          periodo: alerta.periodo, motivo: alerta.motivo, tentativas: alerta.tentativas, tenantsFalhados: alerta.tenantsFalhados,
          notificacaoEstado: alerta.notificacaoEstado, notificadoEm: alerta.notificadoEm?.toISOString() ?? null,
          notificacaoErro: alerta.notificacaoErro, criadoEm: alerta.criadoEm.toISOString(),
        }
      : null,
    ultimaExecucao: execs[0] ? exec(execs[0]) : null,
    ultimoDownloadAutomatico: ultimoAuto ? exec(ultimoAuto) : null,
    execucoes: execs.map(exec),
    tenants,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Relatório reversível (formato aceite por `--reverter-reconciliacao`) de uma operação. Só platform admins. */
export async function acaoObterRelatorioReconciliacao(
  deps: Pick<Dependencias, "tenants">,
  session: SessionUser | null,
  operacaoId: string,
): Promise<{ ok: true; relatorio: RelatorioReconciliacao } | { ok: false; erro: string; codigo: "NAO_AUTORIZADO" | "INVALIDO" | "NAO_ENCONTRADO" | "INESPERADO" }> {
  if (!isPlatformAdminSession(session)) return { ok: false, erro: "Sem permissão para esta operação.", codigo: "NAO_AUTORIZADO" };
  if (!UUID.test(operacaoId)) return { ok: false, erro: "Identificador de operação inválido.", codigo: "INVALIDO" };
  try {
    const relatorio = await obterRelatorio(await deps.tenants(), operacaoId);
    if (!relatorio) return { ok: false, erro: "Operação não encontrada.", codigo: "NAO_ENCONTRADO" };
    return { ok: true, relatorio };
  } catch (e) {
    return { ok: false, erro: e instanceof Error ? e.message : "Não foi possível obter o relatório.", codigo: "INESPERADO" };
  }
}

/** Só o indicador: há uma atualização mensal falhada por resolver? (barato — usado no layout do admin) */
export async function existeAlertaPendente(control: Dependencias["control"]): Promise<boolean> {
  return (await control.infarmedAlerta.count({ where: { estado: "PENDENTE" } })) > 0;
}
