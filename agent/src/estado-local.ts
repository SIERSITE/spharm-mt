/**
 * agent/src/estado-local.ts
 *
 * Estado LOCAL e durável do daily-pipeline (pasta `run/` do agent). Três coisas, todas pequenas,
 * todas escritas de forma atómica (ficheiro temporário + rename) para sobreviverem a um corte
 * de energia a meio:
 *
 *  1. PENDENTES — dias cuja corrida falhou (ou está à espera de retoma). É só uma PISTA: a fonte
 *     de verdade do que está concluído continua a ser o SaaS (`PipelineRun`, ver `catch-up.ts`).
 *     Serve para (a) o operador ver a falha sem abrir logs, (b) o catch-up não perder um dia
 *     quando o SaaS não consegue informar quais os dias concluídos, (c) a retoma depois de um
 *     reinício do computador durante a espera.
 *
 *  2. REGISTOS PENDENTES — o `PipelineRun` que não chegou ao SaaS. Guardado com a MESMA
 *     `idempotencyKey` e reenviado na corrida seguinte: o servidor faz upsert por essa chave, por
 *     isso nunca duplica.
 *
 *  3. ALERTAS — um por (farmácia, dia, causa). Garante que a notificação sai UMA vez por causa
 *     e que uma notificação falhada NUNCA apaga a causa: o alerta fica aberto e é tentado de novo.
 *
 * Nada aqui contém segredos, tokens, nem dados de produtos/vendas.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export type EstadoPipeline = "OK" | "PARTIAL" | "ERROR" | "ABORTED";

/** Pasta de estado por omissão: `<cwd>/run` (a mesma do `pipeline.lock`); `SPHARMMT_RUN_DIR` sobrepõe (testes). */
export function dirEstadoPadrao(): string {
  return process.env.SPHARMMT_RUN_DIR?.trim() || path.join(process.cwd(), "run");
}

function garantirDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/** Escrita atómica: nunca deixa um JSON a meio. */
export function escreverJsonAtomico(ficheiro: string, dados: unknown): void {
  garantirDir(path.dirname(ficheiro));
  const tmp = `${ficheiro}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(dados, null, 2) + "\n", { encoding: "utf8" });
  renameSync(tmp, ficheiro);
}

/** Lê JSON; ficheiro ausente, ilegível ou de forma errada → `padrao` (o estado local nunca derruba o pipeline). */
export function lerJson<T>(ficheiro: string, padrao: T): T {
  try {
    if (!existsSync(ficheiro)) return padrao;
    return JSON.parse(readFileSync(ficheiro, "utf8")) as T;
  } catch {
    return padrao;
  }
}

// ── 1) Pendentes ────────────────────────────────────────────────────

export type Pendente = {
  dia: string; // YYYY-MM-DD
  estado: EstadoPipeline;
  /** Causa legível e curta (sem dados de negócio). */
  causa: string;
  /** Tentativas do pipeline já feitas neste dia (acumula entre execuções). */
  tentativas: number;
  primeiraFalhaEm: string;
  ultimaFalhaEm: string;
  /** Se há uma retoma agendada dentro do próprio processo: quando. */
  retomaPrevistaEm?: string;
};

type FicheiroPendentes = { versao: 1; pendentes: Pendente[] };
const F_PENDENTES = "pipeline-pendentes.json";

export function listarPendentes(dir: string): Pendente[] {
  const f = lerJson<FicheiroPendentes>(path.join(dir, F_PENDENTES), { versao: 1, pendentes: [] });
  return Array.isArray(f.pendentes)
    ? f.pendentes.filter((p) => p && /^\d{4}-\d{2}-\d{2}$/.test(String(p.dia))).sort((a, b) => a.dia.localeCompare(b.dia))
    : [];
}

export function registarPendente(
  dir: string,
  p: { dia: string; estado: EstadoPipeline; causa: string; agora?: Date; retomaPrevistaEm?: Date | null },
): Pendente {
  const agora = (p.agora ?? new Date()).toISOString();
  const atuais = listarPendentes(dir);
  const antigo = atuais.find((x) => x.dia === p.dia);
  const novo: Pendente = {
    dia: p.dia,
    estado: p.estado,
    causa: p.causa.slice(0, 300),
    tentativas: (antigo?.tentativas ?? 0) + 1,
    primeiraFalhaEm: antigo?.primeiraFalhaEm ?? agora,
    ultimaFalhaEm: agora,
    ...(p.retomaPrevistaEm ? { retomaPrevistaEm: p.retomaPrevistaEm.toISOString() } : {}),
  };
  escreverJsonAtomico(path.join(dir, F_PENDENTES), {
    versao: 1,
    pendentes: [...atuais.filter((x) => x.dia !== p.dia), novo].sort((a, b) => a.dia.localeCompare(b.dia)),
  } satisfies FicheiroPendentes);
  return novo;
}

export function removerPendente(dir: string, dia: string): boolean {
  const atuais = listarPendentes(dir);
  if (!atuais.some((x) => x.dia === dia)) return false;
  escreverJsonAtomico(path.join(dir, F_PENDENTES), {
    versao: 1,
    pendentes: atuais.filter((x) => x.dia !== dia),
  } satisfies FicheiroPendentes);
  return true;
}

// ── 2) Registos pendentes (PipelineRun) ─────────────────────────────

export type RegistoPendente<B = Record<string, unknown>> = {
  idempotencyKey: string;
  body: B;
  criadoEm: string;
  tentativasEnvio: number;
  ultimoErro?: string;
};

function pastaRegistos(dir: string): string {
  return path.join(dir, "pipelinerun-pendentes");
}

function nomeRegisto(idempotencyKey: string): string {
  return `${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32)}.json`;
}

/** Guarda o registo (mesma chave ⇒ mesmo ficheiro ⇒ nunca duplica localmente). */
export function guardarRegistoPendente<B extends { idempotencyKey?: string }>(dir: string, body: B): RegistoPendente<B> | null {
  const chave = body.idempotencyKey;
  if (!chave) return null; // sem chave não há como garantir a ausência de duplicados no servidor
  const f = path.join(pastaRegistos(dir), nomeRegisto(chave));
  const antigo = lerJson<RegistoPendente<B> | null>(f, null);
  const reg: RegistoPendente<B> = {
    idempotencyKey: chave,
    body,
    criadoEm: antigo?.criadoEm ?? new Date().toISOString(),
    tentativasEnvio: antigo?.tentativasEnvio ?? 0,
    ultimoErro: antigo?.ultimoErro,
  };
  escreverJsonAtomico(f, reg);
  return reg;
}

export function listarRegistosPendentes(dir: string): RegistoPendente[] {
  const pasta = pastaRegistos(dir);
  if (!existsSync(pasta)) return [];
  const out: RegistoPendente[] = [];
  for (const nome of readdirSync(pasta)) {
    if (!nome.endsWith(".json")) continue;
    const r = lerJson<RegistoPendente | null>(path.join(pasta, nome), null);
    if (r && typeof r.idempotencyKey === "string" && r.body) out.push(r);
  }
  return out.sort((a, b) => a.criadoEm.localeCompare(b.criadoEm));
}

/** Registos com mais de `maxIdadeDias` ou 20 falhas de envio são arquivados (apagados), nunca reenviados para sempre. */
const MAX_TENTATIVAS_ENVIO = 20;
const MAX_IDADE_DIAS = 30;

/**
 * Reenvia os registos pendentes (mais antigos primeiro). `enviar` lança em caso de falha.
 * Um registo só sai do disco depois de o SaaS o aceitar.
 */
export async function reenviarRegistosPendentes(
  dir: string,
  enviar: (body: Record<string, unknown>) => Promise<unknown>,
  log: (s: string) => void,
  agora: Date = new Date(),
): Promise<{ enviados: number; falhados: number; arquivados: number }> {
  let enviados = 0;
  let falhados = 0;
  let arquivados = 0;
  for (const r of listarRegistosPendentes(dir)) {
    const f = path.join(pastaRegistos(dir), nomeRegisto(r.idempotencyKey));
    const idadeDias = (agora.getTime() - new Date(r.criadoEm).getTime()) / 86_400_000;
    if (r.tentativasEnvio >= MAX_TENTATIVAS_ENVIO || idadeDias > MAX_IDADE_DIAS) {
      log(`⚠ Registo pendente arquivado (${r.idempotencyKey}): ${r.tentativasEnvio} falhas de envio / ${idadeDias.toFixed(0)} dias — não é reenviado mais.`);
      try { unlinkSync(f); } catch { /* ignore */ }
      arquivados++;
      continue;
    }
    try {
      await enviar(r.body);
      try { unlinkSync(f); } catch { /* ignore */ }
      enviados++;
      log(`✓ Registo pendente enviado ao SaaS (${r.idempotencyKey}) — idempotente, sem duplicar.`);
    } catch (err) {
      falhados++;
      const msg = err instanceof Error ? err.message : String(err);
      escreverJsonAtomico(f, { ...r, tentativasEnvio: r.tentativasEnvio + 1, ultimoErro: msg.slice(0, 300) });
      log(`⚠ Registo pendente continua por enviar (${r.idempotencyKey}): ${msg.slice(0, 160)}`);
    }
  }
  return { enviados, falhados, arquivados };
}

// ── 3) Alertas ──────────────────────────────────────────────────────

export type Alerta = {
  chave: string; // farmácia|dia|causa
  farmacia: string;
  dia: string;
  causa: string;
  mensagem: string;
  abertoEm: string;
  /** `null` enquanto nenhuma notificação foi entregue. */
  notificadoEm: string | null;
  tentativasNotificacao: number;
  ultimoErroNotificacao?: string;
  resolvidoEm?: string;
};

type FicheiroAlertas = { versao: 1; alertas: Record<string, Alerta> };
const F_ALERTAS = "pipeline-alertas.json";

export const chaveAlerta = (farmacia: string, dia: string, causa: string) => `${farmacia}|${dia}|${causa}`;

export function listarAlertas(dir: string): Alerta[] {
  const f = lerJson<FicheiroAlertas>(path.join(dir, F_ALERTAS), { versao: 1, alertas: {} });
  return Object.values(f.alertas ?? {});
}

function guardarAlertas(dir: string, alertas: Record<string, Alerta>): void {
  escreverJsonAtomico(path.join(dir, F_ALERTAS), { versao: 1, alertas } satisfies FicheiroAlertas);
}

/**
 * Abre (ou reutiliza) o alerta e tenta notificar UMA vez por causa. A causa fica SEMPRE gravada
 * antes de qualquer tentativa de envio, e uma falha do envio nunca a apaga nem a esconde:
 * `notificadoEm` fica `null` e o alerta é reenviado por `reenviarAlertasPendentes`.
 */
export async function abrirAlerta(
  dir: string,
  a: { farmacia: string; dia: string; causa: string; mensagem: string },
  notificar: (alerta: Alerta) => Promise<void>,
  agora: Date = new Date(),
): Promise<{ alerta: Alerta; notificou: boolean; erroNotificacao?: string }> {
  const f = lerJson<FicheiroAlertas>(path.join(dir, F_ALERTAS), { versao: 1, alertas: {} });
  const alertas = f.alertas ?? {};
  const chave = chaveAlerta(a.farmacia, a.dia, a.causa);
  const existente = alertas[chave];
  const alerta: Alerta = existente
    ? { ...existente, mensagem: a.mensagem.slice(0, 500), resolvidoEm: undefined }
    : {
        chave, farmacia: a.farmacia, dia: a.dia, causa: a.causa, mensagem: a.mensagem.slice(0, 500),
        abertoEm: agora.toISOString(), notificadoEm: null, tentativasNotificacao: 0,
      };
  alertas[chave] = alerta;
  guardarAlertas(dir, alertas); // 1) a causa fica gravada ANTES de se tentar notificar

  if (alerta.notificadoEm) return { alerta, notificou: false }; // já notificado: sem emails/pings duplicados
  try {
    await notificar(alerta);
    alerta.notificadoEm = agora.toISOString();
    alerta.tentativasNotificacao += 1;
    alerta.ultimoErroNotificacao = undefined;
    alertas[chave] = alerta;
    guardarAlertas(dir, alertas);
    return { alerta, notificou: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    alerta.tentativasNotificacao += 1;
    alerta.ultimoErroNotificacao = msg.slice(0, 300);
    alertas[chave] = alerta;
    guardarAlertas(dir, alertas); // 2) a falha do envio fica registada; a causa original mantém-se
    return { alerta, notificou: false, erroNotificacao: msg };
  }
}

/** Tenta de novo as notificações que falharam (alertas abertos e nunca entregues). */
export async function reenviarAlertasPendentes(
  dir: string,
  notificar: (alerta: Alerta) => Promise<void>,
  agora: Date = new Date(),
): Promise<{ reenviados: number; falhados: number }> {
  const f = lerJson<FicheiroAlertas>(path.join(dir, F_ALERTAS), { versao: 1, alertas: {} });
  const alertas = f.alertas ?? {};
  let reenviados = 0;
  let falhados = 0;
  for (const a of Object.values(alertas)) {
    if (a.resolvidoEm || a.notificadoEm) continue;
    try {
      await notificar(a);
      a.notificadoEm = agora.toISOString();
      a.tentativasNotificacao += 1;
      a.ultimoErroNotificacao = undefined;
      reenviados++;
    } catch (err) {
      a.tentativasNotificacao += 1;
      a.ultimoErroNotificacao = (err instanceof Error ? err.message : String(err)).slice(0, 300);
      falhados++;
    }
  }
  guardarAlertas(dir, alertas);
  return { reenviados, falhados };
}

/** O dia ficou concluído: resolve os alertas desse dia (ficam no ficheiro como histórico, marcados). */
export function resolverAlertasDoDia(dir: string, farmacia: string, dia: string, agora: Date = new Date()): Alerta[] {
  const f = lerJson<FicheiroAlertas>(path.join(dir, F_ALERTAS), { versao: 1, alertas: {} });
  const alertas = f.alertas ?? {};
  const resolvidos: Alerta[] = [];
  for (const a of Object.values(alertas)) {
    if (a.farmacia === farmacia && a.dia === dia && !a.resolvidoEm) {
      a.resolvidoEm = agora.toISOString();
      resolvidos.push(a);
    }
  }
  if (resolvidos.length > 0) guardarAlertas(dir, alertas);
  return resolvidos;
}

/** Alertas ainda por resolver (para o operador / o resumo no arranque). */
export function alertasAbertos(dir: string): Alerta[] {
  return listarAlertas(dir).filter((a) => !a.resolvidoEm);
}
