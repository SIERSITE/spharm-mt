/**
 * lib/regulamentar/infarmed-atualizacao.ts
 *
 * Orquestra a atualização dos dados regulamentares do INFARMED para TODOS os
 * tenants ativos — a mensal automática (dia 1, Europe/Lisbon), a repetição por
 * tenant e o upload manual da página /admin/infarmed. As três usam
 * EXATAMENTE o mesmo motor de importação (`aplicarVersaoInfarmed`).
 *
 *   · o ficheiro é obtido/validado UMA vez e aplicado a cada tenant ativo
 *     (cada tenant mantém as suas associações, contagens e histórico);
 *   · uma falha num tenant fica identificada e não afeta os restantes;
 *   · o ledger GLOBAL (execução, alerta, notificação) vive no control plane;
 *   · falha ⇒ versão ativa intacta, nada de parcial, mês NÃO marcado como
 *     concluído, alerta pendente e UM email por falha (sem repetições);
 *   · o email nunca altera dados e a sua falha regista-se à parte.
 *
 * Tudo o que toca o exterior (ficheiro, tenants, SMTP, relógio) entra por
 * `Dependencias`: é o que torna isto testável sem rede nem SMTP.
 */

import type { PrismaClient } from "@/generated/prisma/client";
import type { PrismaClient as ControlClient } from "@/generated/prisma-control/client";
import { FicheiroInfarmedInvalido, lerFicheiroInfarmed, type FicheiroInfarmedLido } from "./infarmed-ficheiro";
import { aplicarVersaoInfarmed, type OrigemImportacao, type RelatorioImportacao } from "./infarmed-aplicar";
import { DownloadInfarmedFalhou, type FicheiroObtido } from "./infarmed-job";
import type { ContadoresReconciliacao } from "./infarmed-reconciliar";
import { novaOperacaoId } from "./infarmed-registo";

export type TenantAlvo = { slug: string; prisma: PrismaClient };
export type MensagemEmail = { assunto: string; texto: string };

export class EmailNaoConfigurado extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = "EmailNaoConfigurado";
  }
}

export type Dependencias = {
  control: ControlClient;
  /** Tenants ATIVOS (nunca uma lista fixa). */
  tenants: (opcoes?: { onlySlugs?: string[] }) => Promise<TenantAlvo[]>;
  /** Obtém o ficheiro (override direto ou formulário público). */
  obterFicheiro: () => Promise<FicheiroObtido>;
  /** Envia o email operacional. Lança `EmailNaoConfigurado` ou o erro do SMTP. */
  enviarEmail: (m: MensagemEmail) => Promise<void>;
  /** Link absoluto (ou caminho) da página de upload manual. */
  urlAdmin: string;
  agora?: () => Date;
  log?: (msg: string) => void;
};

export type ResultadoTenant = {
  slug: string;
  resultado: RelatorioImportacao["resultado"] | "ERRO";
  ok: boolean;
  importacaoId?: string | null;
  motivo?: string;
  produtosAssociados?: number;
  cnpNaoEncontrados?: number;
  registosNovos?: number;
  registosAlterados?: number;
  registosIguais?: number;
  deixaramDeEstarPresentes?: number;
  /** Reconciliação do catálogo (forma, dosagem, embalagem, DCI): feita (apply) ou prevista (dry-run). */
  reconciliacao?: ContadoresReconciliacao | null;
};

export type ResultadoAtualizacao = {
  estado: "CONCLUIDA" | "PARCIAL" | "FALHADA" | "SIMULADA";
  periodo: string;
  motivo?: string;
  motivoChave?: string;
  sha256?: string;
  linhasLidas?: number;
  tenants: ResultadoTenant[];
  execucaoId?: string;
  alerta?: { estado: "PENDENTE" | "RESOLVIDO"; notificacao: "ENVIADA" | "FALHOU" | "NAO_CONFIGURADA" | "NAO_ENVIADA" | "JA_NOTIFICADA" };
};

/** Mês civil em Europe/Lisbon ("2026-11"): é este o «mês» da atualização. */
export function periodoLisboa(d: Date): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon", year: "numeric", month: "2-digit" }).formatToParts(d);
  const ano = p.find((x) => x.type === "year")!.value;
  const mes = p.find((x) => x.type === "month")!.value;
  return `${ano}-${mes}`;
}

function resumir(msg: string, max = 240): string {
  const s = msg.replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** Motivo legível + chave estável (sem texto variável) — a chave decide se um email é repetição. */
export function classificarFalha(e: unknown): { motivo: string; chave: string } {
  if (e instanceof DownloadInfarmedFalhou) return { motivo: `Download: ${resumir(e.message)}`, chave: `DOWNLOAD_${e.codigo}` };
  if (e instanceof FicheiroInfarmedInvalido) return { motivo: `Ficheiro inválido: ${resumir(e.message)}`, chave: `VALIDACAO_${e.codigo}` };
  return { motivo: `Erro inesperado: ${resumir(e instanceof Error ? e.message : String(e))}`, chave: "ERRO_INESPERADO" };
}

const ok = (r: ResultadoTenant["resultado"]) => r === "APLICADA" || r === "JA_PROCESSADA" || r === "SIMULADA";

/** Aplica (ou simula) o MESMO ficheiro validado a cada tenant. Nunca lança por causa de um tenant. */
export async function aplicarATenants(
  ficheiro: FicheiroInfarmedLido,
  tenants: TenantAlvo[],
  opcoes: {
    origem: OrigemImportacao;
    apply: boolean;
    forcar?: boolean;
    nomeFicheiro?: string | null;
    urlOrigem?: string | null;
    utilizadorEmail?: string | null;
    minimoRelativoLinhas?: number;
    /** Identificador da operação reversível (o mesmo em todos os tenants); omissão: novo. */
    operacaoId?: string;
  },
): Promise<ResultadoTenant[]> {
  const out: ResultadoTenant[] = [];
  const operacaoId = opcoes.operacaoId ?? novaOperacaoId();
  for (const t of tenants) {
    try {
      const r = await aplicarVersaoInfarmed(t.prisma, ficheiro, {
        origem: opcoes.origem,
        apply: opcoes.apply,
        forcar: opcoes.forcar,
        nomeFicheiro: opcoes.nomeFicheiro,
        urlOrigem: opcoes.urlOrigem,
        utilizadorEmail: opcoes.utilizadorEmail,
        minimoRelativoLinhas: opcoes.minimoRelativoLinhas,
        tenant: t.slug,
        operacaoId,
      });
      out.push({
        slug: t.slug,
        resultado: r.resultado,
        ok: ok(r.resultado),
        importacaoId: r.importacaoId,
        motivo: r.motivo,
        produtosAssociados: r.produtosAssociados,
        cnpNaoEncontrados: r.cnpNaoEncontrados,
        registosNovos: r.registosNovos,
        registosAlterados: r.registosAlterados,
        registosIguais: r.registosIguais,
        deixaramDeEstarPresentes: r.deixaramDeEstarPresentes,
        reconciliacao: r.reconciliacao ?? null,
      });
    } catch (e) {
      out.push({ slug: t.slug, resultado: "ERRO", ok: false, motivo: resumir(e instanceof Error ? e.message : String(e)) });
    }
  }
  return out;
}

async function registarFalhaNosTenants(tenants: TenantAlvo[], url: string | null, sha256: string, erro: string, origem: OrigemImportacao) {
  for (const t of tenants) {
    await t.prisma.infarmedImportacao
      .create({
        data: {
          origem, urlOrigem: url, sha256, descarregadoEm: new Date(), estado: "FALHADA", ativa: false,
          erro: erro.slice(0, 1000), terminadaEm: new Date(),
        },
      })
      .catch(() => undefined);
  }
}

// ── Ledger global e notificação ──────────────────────────────────────

export function montarEmailFalha(p: { periodo: string; motivo: string; urlAdmin: string; tenantsFalhados: string[] }): MensagemEmail {
  const linhas = [
    `A atualização mensal dos dados regulamentares do INFARMED (${p.periodo}) não foi possível.`,
    "",
    `Motivo: ${p.motivo}`,
    ...(p.tenantsFalhados.length ? [`Tenants com falha: ${p.tenantsFalhados.join(", ")}`] : []),
    "",
    "A versão regulamentar atualmente ativa foi mantida, sem alterações.",
    "",
    `Para carregar o ficheiro manualmente: ${p.urlAdmin}`,
    "",
    "(Esta mensagem é enviada uma só vez por falha. Quando o ficheiro for aplicado com sucesso, o alerta fica resolvido.)",
  ];
  return { assunto: `[SPharm.MT] Atualização mensal do INFARMED não foi possível (${p.periodo})`, texto: linhas.join("\n") };
}

type EstadoNotificacao = NonNullable<ResultadoAtualizacao["alerta"]>["notificacao"];

async function registarAlertaENotificar(
  deps: Dependencias,
  p: { periodo: string; motivo: string; chave: string; tenantsFalhados: string[] },
): Promise<NonNullable<ResultadoAtualizacao["alerta"]>> {
  const { control } = deps;
  const existente = await control.infarmedAlerta.findUnique({ where: { periodo: p.periodo } });
  const dados = { motivo: p.motivo, motivoChave: p.chave, tenantsFalhados: p.tenantsFalhados };
  let alerta;
  let reaberto = false;
  if (!existente) {
    alerta = await control.infarmedAlerta.create({ data: { periodo: p.periodo, ...dados } });
  } else {
    reaberto = existente.estado === "RESOLVIDO";
    alerta = await control.infarmedAlerta.update({
      where: { periodo: p.periodo },
      data: { ...dados, estado: "PENDENTE", tentativas: { increment: 1 }, ...(reaberto ? { resolvidoEm: null, resolvidoPor: null } : {}) },
    });
  }
  // Uma notificação por falha: só se este motivo ainda não foi notificado com sucesso
  // (alerta novo, reaberto depois de resolvido, ou motivo diferente).
  const jaNotificado = !reaberto && alerta.notificacaoEstado === "ENVIADA" && alerta.notificacaoMotivoChave === p.chave;
  if (jaNotificado) return { estado: "PENDENTE", notificacao: "JA_NOTIFICADA" };

  let notificacao: EstadoNotificacao;
  try {
    await deps.enviarEmail(montarEmailFalha({ periodo: p.periodo, motivo: p.motivo, urlAdmin: deps.urlAdmin, tenantsFalhados: p.tenantsFalhados }));
    notificacao = "ENVIADA";
    await control.infarmedAlerta.update({
      where: { periodo: p.periodo },
      data: { notificacaoEstado: "ENVIADA", notificadoEm: (deps.agora ?? (() => new Date()))(), notificacaoMotivoChave: p.chave, notificacaoErro: null },
    });
  } catch (e) {
    const semConfig = e instanceof EmailNaoConfigurado;
    notificacao = semConfig ? "NAO_CONFIGURADA" : "FALHOU";
    const erro = resumir(e instanceof Error ? e.message : String(e));
    (deps.log ?? console.error)(`[infarmed] a notificação por email não foi enviada (${notificacao}): ${erro}`);
    await control.infarmedAlerta
      .update({ where: { periodo: p.periodo }, data: { notificacaoEstado: semConfig ? "NAO_CONFIGURADA" : "FALHOU", notificacaoErro: erro, notificacaoMotivoChave: null } })
      .catch(() => undefined);
  }
  return { estado: "PENDENTE", notificacao };
}

/**
 * Resolve alertas pendentes. Uma execução que cobriu TODOS os tenants ativos
 * resolve todos; uma repetição parcial só resolve os alertas cujos tenants
 * falhados estão, todos, entre os que acabaram de ser atualizados (uma falha de
 * download/validação só se resolve com uma execução completa).
 */
export async function resolverAlertas(
  control: ControlClient,
  resolvidoPor: string,
  agora: Date,
  alcance: { todos: boolean; slugsOk: string[] } = { todos: true, slugsOk: [] },
): Promise<number> {
  const data = { estado: "RESOLVIDO" as const, resolvidoEm: agora, resolvidoPor };
  if (alcance.todos) return (await control.infarmedAlerta.updateMany({ where: { estado: "PENDENTE" }, data })).count;
  const pendentes = await control.infarmedAlerta.findMany({ where: { estado: "PENDENTE" } });
  const ids = pendentes
    .filter((a) => a.tenantsFalhados.length > 0 && a.tenantsFalhados.every((slug) => alcance.slugsOk.includes(slug)))
    .map((a) => a.id);
  if (ids.length === 0) return 0;
  return (await control.infarmedAlerta.updateMany({ where: { id: { in: ids } }, data })).count;
}

async function fecharExecucao(
  control: ControlClient,
  id: string,
  dados: {
    resultado: "CONCLUIDA" | "PARCIAL" | "FALHADA";
    motivo?: string; motivoChave?: string; sha256?: string; bytes?: number; nomeFicheiro?: string | null; tenants?: ResultadoTenant[];
  },
  agora: Date,
) {
  await control.infarmedExecucao.update({
    where: { id },
    data: {
      resultado: dados.resultado, motivo: dados.motivo ?? null, motivoChave: dados.motivoChave ?? null,
      sha256: dados.sha256 ?? null, bytes: dados.bytes ?? null, nomeFicheiro: dados.nomeFicheiro ?? null,
      terminadaEm: agora, tenants: dados.tenants ? (JSON.parse(JSON.stringify(dados.tenants)) as object) : undefined,
    },
  });
}

/** Fecha a execução e atualiza alerta/notificação consoante o resultado. */
async function concluir(
  deps: Dependencias,
  execucaoId: string,
  periodo: string,
  quem: string,
  r: { tenants: ResultadoTenant[]; sha256?: string; bytes?: number; nomeFicheiro?: string | null; falha?: { motivo: string; chave: string }; cobreTodos?: boolean },
): Promise<Pick<ResultadoAtualizacao, "estado" | "motivo" | "motivoChave" | "alerta">> {
  const agora = (deps.agora ?? (() => new Date()))();
  const falhados = r.tenants.filter((t) => !t.ok).map((t) => t.slug).sort();
  if (r.falha) {
    await fecharExecucao(deps.control, execucaoId, { resultado: "FALHADA", motivo: r.falha.motivo, motivoChave: r.falha.chave, tenants: r.tenants }, agora);
    const alerta = await registarAlertaENotificar(deps, { periodo, motivo: r.falha.motivo, chave: r.falha.chave, tenantsFalhados: [] });
    return { estado: "FALHADA", motivo: r.falha.motivo, motivoChave: r.falha.chave, alerta };
  }
  if (falhados.length > 0) {
    const detalhe = r.tenants.filter((t) => !t.ok).map((t) => `${t.slug}: ${t.motivo ?? t.resultado}`).join("; ");
    const motivo = `Falhou em ${falhados.length} tenant(s) — ${resumir(detalhe, 300)}`;
    const chave = `TENANTS_${falhados.join(",")}`;
    const todos = r.tenants.length;
    await fecharExecucao(deps.control, execucaoId, { resultado: falhados.length === todos ? "FALHADA" : "PARCIAL", motivo, motivoChave: chave, sha256: r.sha256, bytes: r.bytes, nomeFicheiro: r.nomeFicheiro, tenants: r.tenants }, agora);
    const alerta = await registarAlertaENotificar(deps, { periodo, motivo, chave, tenantsFalhados: falhados });
    return { estado: falhados.length === todos ? "FALHADA" : "PARCIAL", motivo, motivoChave: chave, alerta };
  }
  await fecharExecucao(deps.control, execucaoId, { resultado: "CONCLUIDA", sha256: r.sha256, bytes: r.bytes, nomeFicheiro: r.nomeFicheiro, tenants: r.tenants }, agora);
  await resolverAlertas(deps.control, quem, agora, { todos: r.cobreTodos !== false, slugsOk: r.tenants.filter((t) => t.ok).map((t) => t.slug) });
  return { estado: "CONCLUIDA", alerta: undefined };
}

// ── Casos de uso ─────────────────────────────────────────────────────

/**
 * Atualização automática (dia 1) ou repetição para alguns tenants. Descarrega
 * UMA vez. Em `dryRun` não escreve nada (nem ledger, nem emails, nem dados).
 */
export async function executarAtualizacaoAutomatica(
  deps: Dependencias,
  opcoes: { dryRun?: boolean; forcar?: boolean; onlySlugs?: string[]; origem?: "AUTOMATICA" | "REPETICAO"; utilizadorEmail?: string | null } = {},
): Promise<ResultadoAtualizacao> {
  const agora = (deps.agora ?? (() => new Date()))();
  const periodo = periodoLisboa(agora);
  const log = deps.log ?? (() => undefined);
  const origemExec = opcoes.onlySlugs?.length ? "REPETICAO" : (opcoes.origem ?? "AUTOMATICA");
  const tenants = await deps.tenants({ onlySlugs: opcoes.onlySlugs });
  const apply = !opcoes.dryRun;
  const quem = opcoes.utilizadorEmail ?? "automático";

  const exec = apply
    ? await deps.control.infarmedExecucao.create({
        data: { periodo, origem: origemExec, resultado: "FALHADA", utilizadorEmail: opcoes.utilizadorEmail ?? null, iniciadaEm: agora },
      })
    : null;
  // A execução nasce «FALHADA» e só passa a CONCLUIDA/PARCIAL no fim: se o processo morrer a meio, o mês NÃO fica marcado como concluído.

  let obtido: FicheiroObtido;
  try {
    obtido = await deps.obterFicheiro();
  } catch (e) {
    const falha = classificarFalha(e);
    log(`[infarmed] ${falha.motivo}`);
    if (!exec) return { estado: "SIMULADA", periodo, motivo: falha.motivo, motivoChave: falha.chave, tenants: [] };
    await registarFalhaNosTenants(tenants, null, "-", `download: ${falha.motivo}`, "MENSAL");
    const c = await concluir(deps, exec.id, periodo, quem, { tenants: [], falha });
    return { ...c, periodo, tenants: [], execucaoId: exec.id };
  }

  let ficheiro: FicheiroInfarmedLido;
  try {
    ficheiro = lerFicheiroInfarmed(obtido.buffer);
  } catch (e) {
    const falha = classificarFalha(e);
    log(`[infarmed] ${falha.motivo}`);
    if (!exec) return { estado: "SIMULADA", periodo, motivo: falha.motivo, motivoChave: falha.chave, tenants: [] };
    const { sha256 } = await import("./infarmed-ficheiro");
    await registarFalhaNosTenants(tenants, obtido.url, sha256(obtido.buffer), `validação: ${falha.motivo}`, "MENSAL");
    const c = await concluir(deps, exec.id, periodo, quem, { tenants: [], falha, bytes: obtido.buffer.length, nomeFicheiro: obtido.nomeFicheiro });
    return { ...c, periodo, tenants: [], execucaoId: exec.id };
  }

  const resultados = await aplicarATenants(ficheiro, tenants, {
    origem: "MENSAL", apply, forcar: opcoes.forcar, nomeFicheiro: obtido.nomeFicheiro, urlOrigem: obtido.url,
    utilizadorEmail: opcoes.utilizadorEmail ?? null, minimoRelativoLinhas: 0.5,
  });
  for (const t of resultados) log(`[infarmed] ${t.slug}: ${t.resultado}${t.motivo ? ` (${t.motivo})` : ""}`);
  if (!exec) return { estado: "SIMULADA", periodo, sha256: ficheiro.sha256, linhasLidas: ficheiro.linhasLidas, tenants: resultados };
  const c = await concluir(deps, exec.id, periodo, quem, { tenants: resultados, sha256: ficheiro.sha256, bytes: ficheiro.bytes, nomeFicheiro: obtido.nomeFicheiro, cobreTodos: !opcoes.onlySlugs?.length });
  return { ...c, periodo, sha256: ficheiro.sha256, linhasLidas: ficheiro.linhasLidas, tenants: resultados, execucaoId: exec.id };
}

export type PreviewUpload = {
  sha256: string;
  bytes: number;
  nomeFicheiro: string;
  linhasLidas: number;
  linhasValidas: number;
  linhasRejeitadas: number;
  rejeitadasAmostra: Array<{ linha: number; registo: string | null; motivo: string }>;
  duplicadosIdenticos: number;
  conflitos: number;
  cnpDistintos: number;
  tenants: ResultadoTenant[];
};

/** Valida e simula em todos os tenants. NÃO escreve nada. Lança FicheiroInfarmedInvalido. */
export async function previsualizarFicheiro(
  deps: Dependencias,
  buffer: Buffer,
  nomeFicheiro: string,
  opcoes: { onlySlugs?: string[] } = {},
): Promise<PreviewUpload> {
  const ficheiro = lerFicheiroInfarmed(buffer);
  const tenants = await deps.tenants({ onlySlugs: opcoes.onlySlugs });
  const resultados = await aplicarATenants(ficheiro, tenants, { origem: "UPLOAD_MANUAL", apply: false, nomeFicheiro, minimoRelativoLinhas: 0.5 });
  return {
    sha256: ficheiro.sha256, bytes: ficheiro.bytes, nomeFicheiro,
    linhasLidas: ficheiro.linhasLidas, linhasValidas: ficheiro.linhas.length, linhasRejeitadas: ficheiro.rejeitadas.length,
    rejeitadasAmostra: ficheiro.rejeitadas.slice(0, 20), duplicadosIdenticos: ficheiro.duplicadosIdenticos,
    conflitos: ficheiro.conflitos.length, cnpDistintos: ficheiro.cnpDistintos, tenants: resultados,
  };
}

/**
 * Aplica o ficheiro carregado à mão a todos os tenants ativos (ou só aos
 * indicados) pelo MESMO motor. `sha256Esperado` prova que é o ficheiro que foi
 * pré-visualizado. Regista a execução (origem UPLOAD_MANUAL) e, se tudo correu
 * bem, resolve os alertas pendentes. Lança FicheiroInfarmedInvalido.
 */
export async function aplicarFicheiroManual(
  deps: Dependencias,
  p: { buffer: Buffer; nomeFicheiro: string; utilizadorEmail: string; sha256Esperado: string; onlySlugs?: string[]; forcar?: boolean },
): Promise<ResultadoAtualizacao> {
  const ficheiro = lerFicheiroInfarmed(p.buffer);
  if (ficheiro.sha256 !== p.sha256Esperado) {
    throw new FicheiroInfarmedInvalido("ILEGIVEL", "O ficheiro enviado não é o que foi validado (SHA-256 diferente). Volte a selecioná-lo e validar.");
  }
  const agora = (deps.agora ?? (() => new Date()))();
  const periodo = periodoLisboa(agora);
  const tenants = await deps.tenants({ onlySlugs: p.onlySlugs });
  const exec = await deps.control.infarmedExecucao.create({
    data: {
      periodo, origem: "UPLOAD_MANUAL", resultado: "FALHADA", utilizadorEmail: p.utilizadorEmail,
      sha256: ficheiro.sha256, bytes: ficheiro.bytes, nomeFicheiro: p.nomeFicheiro, iniciadaEm: agora,
    },
  });
  const resultados = await aplicarATenants(ficheiro, tenants, {
    origem: "UPLOAD_MANUAL", apply: true, forcar: p.forcar, nomeFicheiro: p.nomeFicheiro, utilizadorEmail: p.utilizadorEmail, minimoRelativoLinhas: 0.5,
  });
  // Um upload parcial (alguns tenants) só resolve o alerta se NENHUM tenant ativo ficou por atualizar.
  const c = await concluir(deps, exec.id, periodo, p.utilizadorEmail, { tenants: resultados, sha256: ficheiro.sha256, bytes: ficheiro.bytes, nomeFicheiro: p.nomeFicheiro, cobreTodos: !p.onlySlugs?.length });
  return { ...c, periodo, sha256: ficheiro.sha256, linhasLidas: ficheiro.linhasLidas, tenants: resultados, execucaoId: exec.id };
}
