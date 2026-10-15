/**
 * agent/src/commands/daily-pipeline.ts
 *
 * Orquestrador autónomo do ciclo operacional diário:
 *
 *    1. compute `--date` = ontem se não dado (Europe/Lisbon)
 *    2. resolver farmaciaId no SaaS (ANTES do lock — ver nota abaixo)
 *    3. acquire lockfile (run/pipeline.lock) — abort se já corre
 *    4. correr daily-sync (lê ERP → POSTa staging), âmbito "hoje"
 *    5. correr fornecedores/compras/devoluções/movimentos
 *    6. refresh operacional (2026-09): re-ler TODO o catálogo activo
 *       (produtos+stock, sem filtro de dia) — fecha a lacuna do passo 4,
 *       que só relê um produto que vendeu/comprou/moveu NESSE dia. Ver
 *       `runOperationalRefresh` em `daily-sync-runner.ts`.
 *    7. correr aggregate-month server-side (chama API SaaS)
 *    8. validar safety conditions
 *    9. POST /api/admin/pipeline/record com status final
 *   10. release lockfile
 *   11. imprimir RESUMO operacional + escrever logs estruturados
 *
 * Ordem farmaciaId→lock (2026-09): antes, o lock era tentado primeiro, e
 * um lock ocupado abortava com `farmaciaId=""` — o `finally` só regista
 * `PipelineRun` `if (farmaciaId)`, por isso esse abort NUNCA chegava ao
 * SaaS (só ao log local). Resolver `farmaciaId` primeiro (é só uma
 * chamada HTTP de leitura, não toca no lock nem no ERP) garante que
 * QUALQUER abort — incluindo por lock ocupado — fica auditável em
 * `PipelineRun`, com `status="ABORTED"` e o motivo exacto.
 *
 * Logs locais (em `logs/`):
 *    · pipeline-YYYY-MM-DD.log    — resumo orquestrador
 *    · daily-sync-YYYY-MM-DD.log  — stdout dos passos daily-sync e
 *      refresh operacional (partilham o mesmo ficheiro)
 *    · aggregate-YYYY-MM.log      — resposta do aggregate-month
 *
 * Safety aborts (ver `lib/aggregate/vendamensal.ts` para os 3 server-side):
 *    · UNKNOWN > 0
 *    · operationalOrphans > 0
 *    · valorBruto total negativo
 *    · Plus client-side: lockfile presente, tenant não resolvível.
 *
 * Idempotente: re-correr o mesmo --date é seguro (daily-sync upserts via
 * unique constraints; aggregate delete-then-insert scoped). O refresh
 * operacional é idempotente por construção — não tem "--date" nenhum.
 */

import { parseArgs } from "node:util";
import { promises as fs } from "node:fs";
import { appendFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { loadConfig, type AgentConfig } from "../config.js";
import { withPool } from "../sql-client.js";
import { SaasClient, SaasApiError, type PipelineAggregateResponse, type PipelineRecordBody } from "../http-client.js";
import { EXIT_TRANSITORIO, eFalhaTransitoria, redigir } from "../politica-retry.js";
import {
  abrirAlerta,
  alertasAbertos,
  dirEstadoPadrao,
  guardarRegistoPendente,
  listarPendentes,
  registarPendente,
  reenviarAlertasPendentes,
  reenviarRegistosPendentes,
  removerPendente,
  resolverAlertasDoDia,
  type Alerta,
} from "../estado-local.js";
import {
  classificarDesfecho,
  correrComRetoma,
  ROTULO_DESFECHO,
  type DesfechoDia,
  type InfoTentativa,
  type ResultadoTentativa,
} from "../retoma-pipeline.js";
import { planearDiasDoPipeline, type PlanoDiario } from "../plano-diario.js";
import { parseDateArg, tableExists, listColumns } from "./probe-helpers.js";
import {
  runPipelineForDay,
  runOperationalRefresh,
  runDesignacoesRefresh,
  type PipelineRunCounts,
  type OperationalRefreshCounts,
} from "./daily-sync-runner.js";
import { avaliarSaudeVendas, type VeredictoVendas } from "../saude-vendas.js";
import { ontemNaFarmacia } from "../janela.js";
import { janelaConsulta } from "../catch-up.js";
import { acquireLock, descreverLock, lockPertenceAEsteProcesso, releaseLock } from "../lock-pipeline.js";
import { eFalhaSqlTransitoria, esperasSqlDoAmbiente } from "../sql-erros.js";

const RULE = "─".repeat(70);
const DOUBLE_RULE = "═".repeat(70);

/* ---------- CLI ---------- */

type Args = {
  date?: string;
  help?: boolean;
  force?: boolean;
  skipAggregate?: boolean;
  /** `--no-catch-up`: volta ao "só ontem". O catch-up é o default. */
  semCatchUp?: boolean;
  maxCatchUp?: number;
  /** `--plan`: só mostra o plano (dias, política) — não corre nada, não escreve no SaaS. */
  plan?: boolean;
};

/**
 * Quantos dias em atraso se recuperam por execução.
 *
 * Sete cobre o caso realista — um PC desligado durante um fim-de-semana
 * prolongado ou uma semana de férias — sem que uma farmácia com meses
 * de atraso tente processar tudo numa corrida e bata no limite de tempo
 * da tarefa do Windows. O que fica de fora nunca é perdido: é escrito
 * no log e apanhado na corrida seguinte.
 */
const MAX_CATCH_UP_DEFAULT = 7;

/**
 * Código de saída de um dia PARTIAL.
 *
 * Distinto de 1 de propósito. Um dia parcial NÃO deve parar a sequência
 * do catch-up: o núcleo (produtos, stock, vendas) ficou gravado, e parar
 * aqui era exactamente o que mantinha o tenant permanentemente um dia
 * atrás — a Silveirense falhou 16/08 e o 17/08 nunca correu. Continua-se
 * para os dias seguintes e o dia parcial volta a ser proposto na corrida
 * seguinte, porque só `status="OK"` conta como concluído.
 *
 * Não-zero para que a tarefa agendada do Windows o mostre como falha.
 */
const EXIT_PARTIAL = 2;

function parseCmdArgs(): Args {
  const raw = parseArgs({
    args: process.argv.slice(3),
    options: {
      date: { type: "string" },
      help: { type: "boolean", short: "h" },
      force: { type: "boolean" },
      "skip-aggregate": { type: "boolean" },
      // Aceite e ignorado: era o interruptor de activação e continua em
      // `.bat` instalados. Removê-lo faria o `strict: true` rebentar com
      // "unknown option" nessas máquinas — uma actualização do agent
      // partia a tarefa agendada em vez de a melhorar.
      "catch-up": { type: "boolean" },
      "no-catch-up": { type: "boolean" },
      "max-catch-up": { type: "string" },
      plan: { type: "boolean" },
    },
    strict: true,
    allowPositionals: false,
  });
  const mcu = typeof raw.values["max-catch-up"] === "string" ? Number(raw.values["max-catch-up"]) : undefined;
  return {
    date: typeof raw.values.date === "string" ? raw.values.date : undefined,
    help: raw.values.help === true,
    force: raw.values.force === true,
    skipAggregate: raw.values["skip-aggregate"] === true,
    semCatchUp: raw.values["no-catch-up"] === true,
    maxCatchUp: mcu !== undefined && Number.isFinite(mcu) && mcu > 0 ? Math.floor(mcu) : undefined,
    plan: raw.values.plan === true,
  };
}

function printHelp(): void {
  console.log("Uso: daily-pipeline [--date YYYY-MM-DD] [--force] [--skip-aggregate]");
  console.log("");
  console.log("Orquestrador autónomo: daily-sync + aggregate-month.");
  console.log("");
  console.log("Flags:");
  console.log("  --date YYYY-MM-DD   corre SÓ este dia e desliga o catch-up");
  console.log("  --no-catch-up       corre só ontem (o catch-up é o default)");
  console.log(`  --max-catch-up N    máximo de dias em atraso por execução (default ${MAX_CATCH_UP_DEFAULT})`);
  console.log("  --plan              mostra o plano (dias em falta, política de retentativas) e termina — nada é executado");
  console.log("  --force             ignora lockfile existente (CUIDADO)");
  console.log("  --skip-aggregate    só corre daily-sync, salta agregação server-side");
  console.log("");
  console.log("Logs em ./logs/ (relativos ao directorio do agent).");
  console.log("Mapping doc: docs/operational-reporting-v1.md");
}

/* ---------- Date helpers ---------- */

/**
 * Ontem NA FARMÁCIA (Europe/Lisbon), YYYY-MM-DD.
 *
 * Era calculado em UTC. Em Portugal no Verão o UTC está uma hora atrás,
 * portanto entre a meia-noite e a uma da manhã locais o "hoje em UTC" é
 * ainda ontem — e o "ontem" derivado dele era anteontem. O dia certo
 * acabava por entrar na corrida seguinte, mas 24 horas atrasado, e
 * ninguém percebia porquê olhando para os logs.
 */
/**
 * Corre um comando-irmão do agent para o dia. Mesmo padrão do full-sync.
 *
 * Compras, devoluções e movimentos ficavam de fora do ciclo diário: o
 * daily-sync só cobre produtos, stock e vendas. Uma farmácia "actualizada
 * diariamente" tinha as compras congeladas no dia do bootstrap, e isso
 * não se via em lado nenhum — o pipeline terminava OK.
 *
 * Como subprocessos e não in-proc porque é assim que o full-sync já os
 * invoca: uma só implementação destes pipelines, com as mesmas flags e a
 * mesma idempotência.
 */
function correrComandoDoDia(cmd: string, date: string, extra: string[] = [], etapa?: string): number {
  const entry = process.argv[1] ?? "";
  const isTs = entry.endsWith(".ts");
  const args = [cmd, "--from", date, "--to", date, ...extra];
  const nodeArgs = isTs ? ["--import", "tsx", entry, ...args] : [entry, ...args];
  // O dia/etapa só servem para o log do cliente HTTP do subprocesso (nunca dados de negócio).
  const r = spawnSync(process.execPath, nodeArgs, { stdio: "inherit", env: { ...process.env, SPHARMMT_CTX_DIA: date, SPHARMMT_CTX_ETAPA: etapa ?? cmd } });
  if (r.error) {
    console.error(`✗ spawn ${cmd} falhou: ${r.error.message}`);
    return 1;
  }
  return typeof r.status === "number" ? r.status : 1;
}

/**
 * Corre um comando SEM janela temporal.
 *
 * `fornecedores-upload` sincroniza o catálogo inteiro e não aceita
 * `--from/--to` — o seu `parseArgs` corre com `strict: true`, portanto
 * passar-lhos não seria ignorado: rebentava com "unknown option".
 */
function correrComandoSemJanela(cmd: string, date?: string, etapa?: string): number {
  const entry = process.argv[1] ?? "";
  const isTs = entry.endsWith(".ts");
  const nodeArgs = isTs ? ["--import", "tsx", entry, cmd] : [entry, cmd];
  const r = spawnSync(process.execPath, nodeArgs, {
    stdio: "inherit",
    env: { ...process.env, ...(date ? { SPHARMMT_CTX_DIA: date } : {}), SPHARMMT_CTX_ETAPA: etapa ?? cmd },
  });
  if (r.error) {
    console.error(`✗ spawn ${cmd} falhou: ${r.error.message}`);
    return 1;
  }
  return typeof r.status === "number" ? r.status : 1;
}

/**
 * Pipelines transaccionais que o daily-sync não cobre, POR ORDEM.
 *
 * `fornecedores` vem primeiro e a ordem não é arbitrária — é a mesma
 * razão pela qual o full-sync o põe antes das compras. A agregação de
 * compras resolve `fornecedorId` via `FornecedorErpRef`; um fornecedor
 * criado no ERP depois do onboarding ainda não tem essa referência, e
 * a primeira compra que lhe seja feita fica órfã. Órfã não é um erro
 * visível: a compra entra em staging, a agregação conta-a como
 * `orphanFornecedores` e o pipeline termina OK.
 *
 * Sincronizar o catálogo antes de ingerir as compras do dia fecha essa
 * janela. Não altera a semântica das compras — só garante que o
 * fornecedor existe quando a agregação for procurá-lo.
 *
 * `janela: false` para o fornecedores porque é um snapshot do catálogo,
 * não um intervalo: um fornecedor criado ontem e usado hoje tem de
 * entrar, e não entraria se filtrássemos por data de criação.
 */
export const PIPELINES_DIARIOS_EXTRA = [
  { cmd: "fornecedores-upload", label: "fornecedores", janela: false },
  { cmd: "compras-upload", label: "compras", janela: true },
  { cmd: "devolucoes-fornecedor-upload", label: "devoluções", janela: true },
  { cmd: "stocksmov-upload", label: "movimentos", janela: true },
] as const;

function ontem(): string {
  return ontemNaFarmacia();
}

function monthOf(dateIso: string): string {
  return dateIso.slice(0, 7); // YYYY-MM
}

/* ---------- Logs ---------- */

function logsDir(): string {
  const dir = path.join(process.cwd(), "logs");
  mkdirSync(dir, { recursive: true });
  return dir;
}

class TeeLogger {
  private readonly chunks: string[] = [];
  constructor(private readonly filePath: string) {}
  /**
   * rev98: cada linha vai para o ficheiro NO MOMENTO (append), não só no fim. Uma execução longa (retoma de ~15 min entre
   * tentativas, ou um SaaS lento) deixa o log atualizado e legível enquanto corre — e sobrevive a uma morte abrupta.
   */
  private escrever(linha: string): void {
    try {
      appendFileSync(this.filePath, `${linha}\n`, { encoding: "utf8" });
    } catch {
      /* o log em disco nunca derruba o pipeline */
    }
  }
  log(line: string): void {
    const ts = new Date().toISOString();
    const formatted = `[${ts}] ${line}`;
    this.chunks.push(formatted);
    this.escrever(formatted);
    console.log(line);
  }
  raw(line: string): void {
    // Sem timestamp — preserva formatação ASCII art.
    this.chunks.push(line);
    this.escrever(line);
    console.log(line);
  }
  async flush(): Promise<void> {
    /* já escrito linha a linha */
  }
}

/* ---------- Pipeline body ---------- */

async function resolveFarmaciaId(client: SaasClient, hint: string): Promise<string> {
  const r = await client.listFarmacias(15_000);
  const isCuid = /^c[a-z0-9]{20,}$/i.test(hint);
  const match = isCuid
    ? r.farmacias.find((f) => f.id === hint)
    : r.farmacias.find((f) => f.nome.toLowerCase() === hint.toLowerCase());
  if (!match) {
    throw new Error(
      `Farmácia "${hint}" não encontrada (${r.farmacias.length} disponíveis).`
    );
  }
  if (match.estado !== "ATIVO") {
    throw new Error(`Farmácia "${match.nome}" inactiva (${match.estado}).`);
  }
  return match.id;
}

function fmtDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const hh = String(Math.floor(total / 3600)).padStart(2, "0");
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function fmtEur(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/* ---------- Falhas de rede ---------- */

/** Falha que vale a pena retomar mais tarde: SaaS (retentativas HTTP esgotadas) OU SQL Server transitório (ver sql-erros.ts). */
function ehTransitoria(err: unknown): boolean {
  return eFalhaTransitoria(err) || eFalhaSqlTransitoria(err);
}


/**
 * Uma falha de REDE não é uma resposta.
 *
 * `fetch failed` do undici é o que se vê quando o pedido nem chegou a ter
 * resposta: DNS, TCP, TLS, proxy em recarga. Mantida para compatibilidade
 * (e testes); a decisão de repetir vive agora, centralizada, em
 * `politica-retry.ts` + `http-client.ts` (rev98) — este helper deixou de
 * envolver chamadas individuais.
 */
export function ehFalhaDeRede(err: unknown): boolean {
  if (err instanceof SaasApiError) return false;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes("fetch failed") ||
    msg.includes("econnrefused") ||
    msg.includes("econnreset") ||
    msg.includes("enotfound") ||
    msg.includes("etimedout") ||
    msg.includes("socket hang up") ||
    msg.includes("network") ||
    msg.includes("aborted")
  );
}

/* ---------- Healthchecks.io ping ---------- */

/**
 * Posta um sinal ao endpoint configurado em `healthcheckUrl`. Convenção
 * Healthchecks.io:
 *   · POST `<url>/start`       — pipeline arrancou
 *   · POST `<url>`             — sucesso (default endpoint)
 *   · POST `<url>/fail`        — falha
 *
 * `enviarPing` LANÇA em caso de falha (o alerta precisa de saber se a
 * notificação saiu). `pingHealthcheck` é a versão best-effort: timeout curto
 * (5s), excepções engolidas, nunca afeta o exit code do pipeline.
 */
async function enviarPing(baseUrl: string, variant: "start" | "ok" | "fail", payload: string | null): Promise<void> {
  const suffix = variant === "start" ? "/start" : variant === "fail" ? "/fail" : "";
  const url = `${baseUrl.replace(/\/+$/, "")}${suffix}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain", "User-Agent": "spharmmt-agent/healthcheck" },
      body: payload?.slice(0, 10_000) ?? "",
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`healthcheck respondeu HTTP ${res.status}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function pingHealthcheck(
  baseUrl: string | undefined,
  variant: "start" | "ok" | "fail",
  payload: string | null,
  logger: TeeLogger
): Promise<void> {
  if (!baseUrl) return;
  try {
    await enviarPing(baseUrl, variant, payload);
    logger.log(`✓ healthcheck ping (${variant})`);
  } catch (err) {
    logger.log(
      `⚠ healthcheck ping ${variant} falhou (best-effort): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/* ---------- Alertas, pendentes e registo durável (rev98) ---------- */

/**
 * Evento no Registo de Eventos do Windows (Application / «SPharmMT-Agent») — visível sem abrir logs.
 * Best-effort: pode exigir privilégios para criar a origem; uma falha aqui nunca afeta nada.
 */
function escreverEventoWindows(texto: string): void {
  if (process.platform !== "win32") return;
  try {
    spawnSync("eventcreate", ["/T", "ERROR", "/ID", "901", "/L", "APPLICATION", "/SO", "SPharmMT-Agent", "/D", texto.slice(0, 900)], {
      timeout: 5_000,
      stdio: "ignore",
    });
  } catch {
    /* ignore */
  }
}

/**
 * Notificador do alerta. Reutiliza a infraestrutura existente (Healthchecks.io, `healthcheckUrl` do
 * agent.config.json) — não se introduz SMTP nem credenciais no pacote. SEM `healthcheckUrl`, os canais
 * são os locais (estado em `run/`, Registo de Eventos do Windows, PipelineRun ERROR no SaaS), e não há
 * nada a reenviar. COM `healthcheckUrl`, falhar o ping lança — o alerta fica aberto e é tentado de novo.
 */
function criarNotificador(cfg: AgentConfig): (a: Alerta) => Promise<void> {
  return async (a) => {
    const texto = `SPharm.MT daily-pipeline FALHOU\nfarmacia=${a.farmacia}\ndia=${a.dia}\ncausa=${a.causa}\n${a.mensagem}`;
    escreverEventoWindows(texto);
    if (cfg.healthcheckUrl) await enviarPing(cfg.healthcheckUrl, "fail", redigir(texto, [cfg.ingestKey]));
  };
}

function causaDaFalha(r: { passoFalhado?: string; transitoria: boolean; status: string }): string {
  return `${r.passoFalhado ?? "pipeline"}:${r.status}:${r.transitoria ? "transitoria" : "permanente"}`;
}

/**
 * Regista o `PipelineRun` no SaaS (com a política de retentativas) e, se o SaaS estiver inacessível, guarda-o
 * localmente com a MESMA `idempotencyKey` para ser reenviado — o servidor faz upsert por essa chave.
 */
async function registarPipelineRunDuravel(
  client: SaasClient,
  body: PipelineRecordBody,
  log: (s: string) => void,
): Promise<"enviado" | "guardado-localmente"> {
  try {
    await client.pipelineRecord(body, 15_000);
    return "enviado";
  } catch (err) {
    const guardado = guardarRegistoPendente(dirEstadoPadrao(), body);
    log(
      `⚠ Falha a registar PipelineRun no SaaS: ${redigir(err instanceof Error ? err.message : String(err))}. ` +
        (guardado
          ? `Registo guardado em run/pipelinerun-pendentes/ (idempotencyKey ${body.idempotencyKey}) — é reenviado na próxima corrida, sem duplicar.`
          : `Sem idempotencyKey: não é possível reenviar com segurança.`),
    );
    return "guardado-localmente";
  }
}

/** No arranque: reenvia registos e alertas que ficaram por entregar numa execução anterior. */
async function recuperarPendenciasDeEnvio(cfg: AgentConfig, client: SaasClient, log: (s: string) => void): Promise<void> {
  const dir = dirEstadoPadrao();
  try {
    const r = await reenviarRegistosPendentes(dir, (b) => client.pipelineRecord(b as unknown as PipelineRecordBody, 15_000), log);
    if (r.enviados + r.falhados + r.arquivados > 0) log(`Registos PipelineRun pendentes: enviados=${r.enviados} por enviar=${r.falhados} arquivados=${r.arquivados}`);
  } catch (err) {
    log(`⚠ Não foi possível processar os registos pendentes: ${redigir(err instanceof Error ? err.message : String(err))}`);
  }
  try {
    const a = await reenviarAlertasPendentes(dir, criarNotificador(cfg));
    if (a.reenviados + a.falhados > 0) log(`Alertas por notificar: reenviados=${a.reenviados} falhados=${a.falhados}`);
  } catch (err) {
    log(`⚠ Não foi possível reenviar alertas: ${redigir(err instanceof Error ? err.message : String(err))}`);
  }
  const abertos = alertasAbertos(dir);
  if (abertos.length > 0) {
    log(`⚠ ${abertos.length} alerta(s) de falha do pipeline por resolver: ${abertos.map((x) => `${x.dia} (${x.causa})`).join("; ")}`);
  }
}

/* ---------- Planeamento (catch-up) ---------- */

/**
 * Pergunta ao SaaS que dias já estão concluídos e devolve o plano.
 *
 * Se a consulta falhar — rede em baixo, endpoint ainda não deployado —
 * NÃO se assume que está tudo feito nem que não está feito nada: usa-se a
 * pista local (`run/pipeline-pendentes.json`, só acrescenta dias) + o dia
 * normal, e diz-se porquê. Assumir "nada feito" faria uma farmácia com o
 * SaaS temporariamente inacessível reprocessar uma semana; assumir "tudo
 * feito" perdia dias em silêncio.
 */
async function planearDias(
  cfg: AgentConfig,
  client: SaasClient,
  maxCatchUp: number,
  log: (s: string) => void,
): Promise<PlanoDiario> {
  const diaOntem = ontem();
  const pendentesLocais = listarPendentes(dirEstadoPadrao());
  const semSaas = (motivo: string): PlanoDiario => {
    log(`⚠ ${motivo}`);
    const plano = planearDiasDoPipeline({ ontem: diaOntem, diasOkNoSaas: null, pendentesLocais, maxDias: maxCatchUp });
    for (const l of plano.diagnostico) log(l);
    log(plano.resumo);
    return plano;
  };

  let farmaciaId: string;
  try {
    farmaciaId = await resolveFarmaciaId(client, cfg.farmacia!);
  } catch (err) {
    return semSaas(`Não foi possível resolver a farmácia para planear o catch-up: ${redigir(err instanceof Error ? err.message : String(err))}`);
  }

  const janela = janelaConsulta(diaOntem, maxCatchUp);
  try {
    const r = await client.pipelineDiasConcluidos({ farmaciaId, from: janela.from, to: janela.to }, 20_000);
    const plano = planearDiasDoPipeline({ ontem: diaOntem, diasOkNoSaas: r.dias, pendentesLocais, maxDias: maxCatchUp });
    log(`Dias concluídos no SaaS entre ${janela.from} e ${janela.to}: ${r.dias.length}`);
    for (const l of plano.diagnostico) log(l);
    log(plano.resumo);
    for (const d of plano.pendentesJaConcluidos) removerPendente(dirEstadoPadrao(), d);
    if (plano.adiados.length > 0) {
      // Nunca em silêncio: se o limite corta dias, eles ficam escritos no log com nome e número.
      log(`⚠ ADIADOS por limite --max-catch-up=${maxCatchUp}: ${plano.adiados.join(", ")}`);
    }
    return plano;
  } catch (err) {
    const msg = err instanceof SaasApiError ? `HTTP ${err.statusCode} em ${err.path}` : redigir(err instanceof Error ? err.message : String(err));
    return semSaas(
      `Não foi possível consultar os dias concluídos (${msg}). ` +
        `Se o endpoint /api/ingest/v1/pipeline/dias-concluidos ainda não está no deploy, actualiza o SaaS: sem ele não há forma de saber que dias faltam.`,
    );
  }
}

/* ---------- Entrypoint ---------- */

type ResultadoDia = ResultadoTentativa;

/** Memória partilhada entre as tentativas do MESMO dia (checkpoints, contadores, logs). */
type AcumuladoDia = {
  passosOk: Set<string>;
  dailySyncCounts: PipelineRunCounts | null;
  saudeVendas: VeredictoVendas | null;
  aggregateResp: PipelineAggregateResponse | null;
  refreshOperacional: OperationalRefreshCounts | null;
  pipelineLog: TeeLogger;
  dailySyncLog: TeeLogger;
  aggregateLog: TeeLogger;
  client: SaasClient;
  recuperadosHttpInicio: number;
  startedAtOriginal: Date;
};

type CtxTentativa = InfoTentativa & { diaEmFalta: boolean; acc: AcumuladoDia };

/**
 * Corre o dia COM retoma de nível superior (ver `retoma-pipeline.ts`): até `pipelineTentativas`
 * tentativas, ~15 min entre elas, SEMPRE para o mesmo dia de referência, com checkpoint dos passos já
 * confirmados e o lock mantido durante as esperas (nenhuma segunda execução entra no meio).
 */
async function correrDiaComRetoma(
  dia: string,
  args: Args,
  opts: { diaEmFalta: boolean },
): Promise<{ rc: number; desfecho: DesfechoDia; tentativas: number }> {
  const month = monthOf(dia);
  let cfg: AgentConfig | null = null;
  try {
    cfg = loadConfig("both");
  } catch {
    cfg = null; // o relato do erro de configuração é feito por `correrDiaCompleto`
  }
  const total = cfg?.pipelineTentativas ?? 4;
  const esperaMs = cfg?.pipelineEsperaMs ?? 15 * 60_000;
  const acc: AcumuladoDia = {
    passosOk: new Set(),
    dailySyncCounts: null,
    saudeVendas: null,
    aggregateResp: null,
    refreshOperacional: null,
    pipelineLog: new TeeLogger(path.join(logsDir(), `pipeline-${dia}.log`)),
    dailySyncLog: new TeeLogger(path.join(logsDir(), `daily-sync-${dia}.log`)),
    aggregateLog: new TeeLogger(path.join(logsDir(), `aggregate-${month}.log`)),
    client: cfg ? new SaasClient(cfg) : (undefined as unknown as SaasClient),
    recuperadosHttpInicio: 0,
    startedAtOriginal: new Date(),
  };
  acc.recuperadosHttpInicio = acc.client?.estatisticas().recuperadosPorRetentativa ?? 0;

  try {
    const r = await correrComRetoma({
      dia,
      totalTentativas: total,
      esperaMs,
      log: (l) => acc.pipelineLog.log(l),
      dormir: (ms) => new Promise((res) => setTimeout(res, ms)),
      correr: (info) => correrDiaCompleto(dia, args, { ...info, diaEmFalta: opts.diaEmFalta, acc }),
      antesDeEsperar: async (res, info, retomaEm) => {
        // Estado gravado ANTES de dormir: se o PC/processo reiniciar, o catch-up recupera o dia.
        registarPendente(dirEstadoPadrao(), {
          dia,
          estado: res.status,
          causa: `${res.passoFalhado ?? "pipeline"}: ${redigir(res.erro ?? "falha transitória", [cfg?.ingestKey])}`,
          retomaPrevistaEm: retomaEm,
        });
        await Promise.allSettled([acc.pipelineLog.flush(), acc.dailySyncLog.flush(), acc.aggregateLog.flush()]);
        void info;
      },
    });
    const desfecho = classificarDesfecho({
      status: r.final.status,
      tentativas: r.tentativas,
      pedidosRecuperadosHttp: (acc.client?.estatisticas().recuperadosPorRetentativa ?? 0) - acc.recuperadosHttpInicio,
      diaEmFalta: opts.diaEmFalta,
    });
    acc.pipelineLog.log(`RESULTADO ${dia}: ${ROTULO_DESFECHO[desfecho]} (tentativa ${r.tentativas}/${total})`);
    await Promise.allSettled([acc.pipelineLog.flush(), acc.dailySyncLog.flush(), acc.aggregateLog.flush()]);
    return { rc: r.final.rc, desfecho, tentativas: r.tentativas };
  } finally {
    // O lock é mantido durante as esperas; liberta-se aqui, no fim das tentativas.
    if (lockPertenceAEsteProcesso()) await releaseLock();
  }
}

export async function dailyPipeline(): Promise<number> {
  let args: Args;
  try {
    args = parseCmdArgs();
  } catch (err) {
    console.error("✗", err instanceof Error ? err.message : err);
    printHelp();
    return 1;
  }
  if (args.help) {
    printHelp();
    return 0;
  }

  // `--date` explícito desliga o catch-up: quem indica um dia quer esse
  // dia, e mais nenhum. É o caminho da recuperação manual e do
  // diagnóstico, e continua a comportar-se como sempre (agora também com
  // as retentativas HTTP e a retoma de nível superior).
  if (args.date) {
    let parsedDate: string;
    try {
      parsedDate = parseDateArg("--date", args.date) as string;
    } catch (err) {
      console.error("✗", err instanceof Error ? err.message : String(err));
      return 1;
    }
    if (args.plan) {
      console.log(`[plan] --date ${parsedDate}: correria só este dia (catch-up desligado). Nada foi executado.`);
      return 0;
    }
    return (await correrDiaComRetoma(parsedDate, args, { diaEmFalta: false })).rc;
  }

  let cfg: AgentConfig;
  try {
    cfg = loadConfig("both");
  } catch (err) {
    console.error(`✗ Config inválida: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (!cfg.farmacia) {
    console.error("✗ SPHARMMT_FARMACIA não está definido em agent.config.json.");
    return 1;
  }

  // `--no-catch-up` volta ao comportamento antigo para diagnóstico.
  if (args.semCatchUp) {
    const diaOntem = ontem();
    console.log(`Catch-up desligado por --no-catch-up. A correr ${diaOntem}.`);
    console.log("");
    if (args.plan) return 0;
    return (await correrDiaComRetoma(diaOntem, args, { diaEmFalta: false })).rc;
  }

  const maxCatchUp = args.maxCatchUp ?? cfg.catchUpMaxDias ?? MAX_CATCH_UP_DEFAULT;
  console.log(DOUBLE_RULE);
  console.log(`daily-pipeline — planeamento (catch-up)${args.plan ? " [--plan: só planeia, nada é executado]" : ""}`);
  console.log(DOUBLE_RULE);
  const clientePlano = new SaasClient(cfg);
  clientePlano.definirContexto({ etapa: "planeamento" });
  const politica = clientePlano.politicaEfetiva();
  console.log(
    `Política HTTP: 1 + ${politica.esperasMs.length} retentativas (${politica.esperasMs.map((m) => `${m / 1000}s`).join(", ") || "—"}), ` +
      `jitter ${Math.round(politica.jitter * 100)}%, timeout ${politica.timeoutMs / 1000}s por pedido. ` +
      `Retoma do pipeline: ${cfg.pipelineTentativas} tentativas, ${Math.round(cfg.pipelineEsperaMs / 60_000)} min entre elas.`,
  );
  console.log(
    `Política SQL Server: ${esperasSqlDoAmbiente().length} retentativa(s) só para falhas transitórias (${esperasSqlDoAmbiente().map((m) => `${m / 1000}s`).join(", ") || "—"}); credenciais/objeto/coluna/sintaxe/configuração nunca se repetem.`,
  );
  console.log(`Lock (run/pipeline.lock): ${descreverLock()}`);
  if (!args.plan) await recuperarPendenciasDeEnvio(cfg, clientePlano, (s) => console.log(s));
  const plano = await planearDias(cfg, clientePlano, maxCatchUp, (s) => console.log(s));
  const { dias, adiados } = plano;
  console.log("");

  if (args.plan) {
    console.log(`[plan] Dias que seriam processados (por ordem): ${dias.length > 0 ? dias.join(" → ") : "(nenhum)"}`);
    if (adiados.length > 0) console.log(`[plan] Adiados pelo limite: ${adiados.join(", ")}`);
    console.log("[plan] Nada foi executado, escrito no SaaS nem alterado no ERP.");
    return 0;
  }

  if (dias.length === 0) {
    console.log("Nada a fazer: o último dia fechado já está concluído no SaaS.");
    return 0;
  }

  // Ordem cronológica e halt-on-error. Um dia que falha PÁRA a
  // sequência: os seguintes dependem dele para o saldo de stock e para
  // a agregação mensal, e processá-los por cima de um buraco produz
  // números que parecem certos.
  let i = 0;
  let piorEstado = 0;
  const resumoDias: Array<{ dia: string; desfecho: DesfechoDia; tentativas: number }> = [];
  const imprimirResumo = () => {
    if (resumoDias.length === 0) return;
    console.log("");
    console.log(DOUBLE_RULE);
    console.log("RESUMO DA EXECUÇÃO");
    for (const r of resumoDias) console.log(`  ${r.dia}: ${ROTULO_DESFECHO[r.desfecho]} (tentativa ${r.tentativas})`);
    console.log(DOUBLE_RULE);
  };
  for (const dia of dias) {
    i++;
    if (dias.length > 1) {
      console.log(DOUBLE_RULE);
      console.log(`Dia ${i}/${dias.length}: ${dia}${dia === ontem() ? " (dia normal)" : " (dia em falta — recuperação)"}`);
      console.log(DOUBLE_RULE);
    }
    const r = await correrDiaComRetoma(dia, args, { diaEmFalta: dia !== ontem() });
    resumoDias.push({ dia, desfecho: r.desfecho, tentativas: r.tentativas });
    const rc = r.rc;
    if (rc === EXIT_PARTIAL) {
      // Parcial não pára a sequência — ver EXIT_PARTIAL.
      console.warn("");
      console.warn(
        `⚠ ${dia} ficou PARCIAL. Os dias seguintes continuam; ${dia} volta a ser proposto na próxima corrida.`,
      );
      console.warn("");
      piorEstado = piorEstado === 1 ? 1 : EXIT_PARTIAL;
      continue;
    }
    if (rc !== 0) {
      console.error("");
      console.error(`✗ ${dia} falhou (exit ${rc}). PARADO — os dias seguintes não correm.`);
      const porFazer = [...dias.slice(i), ...adiados];
      if (porFazer.length > 0) {
        console.error(`  Por processar: ${porFazer.join(", ")}`);
      }
      console.error(`  Corrige e volta a correr: a corrida seguinte retoma em ${dia}.`);
      imprimirResumo();
      return rc;
    }
  }

  if (adiados.length > 0) {
    console.log("");
    console.log(`⚠ Ficaram ${adiados.length} dia(s) por processar (limite --max-catch-up=${maxCatchUp}):`);
    console.log(`  ${adiados.join(", ")}`);
    console.log(`  A próxima corrida apanha-os. Para os fazer já: --max-catch-up ${maxCatchUp + adiados.length}`);
  }
  imprimirResumo();
  return piorEstado;
}

/**
 * UMA tentativa do dia. Era o corpo do `dailyPipeline` antes do catch-up; continua a fazer
 * exactamente o mesmo, com o dia recebido em vez de calculado. Um dia de catch-up e o dia de
 * ontem passam por aqui pelo mesmo caminho — mesmos passos, mesmos logs, mesmo registo no SaaS,
 * mesmo lockfile. Recuperar um dia em atraso não é um modo especial: se fosse, seria um modo que
 * ninguém testa e que diverge do normal sem ninguém reparar.
 *
 * rev98: devolve o resultado em vez de só um código; passos já concluídos numa tentativa anterior
 * (mesma execução, mesmo dia) NÃO se repetem; uma falha TRANSITÓRIA que ainda vai ser retomada não é
 * registada no SaaS nem alertada — só o desfecho final da execução.
 */
async function correrDiaCompleto(parsedDate: string, args: Args, ctx: CtxTentativa): Promise<ResultadoDia> {
  const month = monthOf(parsedDate);
  const { acc } = ctx;
  const { pipelineLog, dailySyncLog, aggregateLog } = acc;

  let cfg: AgentConfig;
  try {
    cfg = loadConfig("both");
  } catch (err) {
    pipelineLog.log(`✗ Config inválida: ${err instanceof Error ? err.message : String(err)}`);
    await pipelineLog.flush();
    return { rc: 1, status: "ERROR", transitoria: false, erro: "config inválida", passoFalhado: "config" };
  }
  if (!cfg.farmacia) {
    pipelineLog.log("✗ SPHARMMT_FARMACIA não está definido em agent.config.json.");
    await pipelineLog.flush();
    return { rc: 1, status: "ERROR", transitoria: false, erro: "SPHARMMT_FARMACIA em falta", passoFalhado: "config" };
  }

  const t0 = Date.now();
  // O registo no SaaS cobre a EXECUÇÃO inteira do dia (todas as tentativas): `startedAt` e a idempotencyKey são os da 1.ª tentativa.
  const startedAt = acc.startedAtOriginal;
  const steps: Array<{ name: string; status: "OK" | "ERROR" | "SKIPPED"; durationMs: number; message?: string }> = [];
  // Falhas desta tentativa, por natureza: só se retoma quando TODAS as falhas são transitórias.
  let falhasTransitorias = 0;
  let falhasPermanentes = 0;
  let passoFalhado: string | undefined;
  const marcarFalha = (passo: string, transitoria: boolean) => {
    if (transitoria) falhasTransitorias++;
    else falhasPermanentes++;
    passoFalhado = passoFalhado ?? passo;
  };

  pipelineLog.raw(DOUBLE_RULE);
  pipelineLog.raw(`daily-pipeline — autonomous run`);
  pipelineLog.raw(DOUBLE_RULE);
  pipelineLog.log(`SaaS endpoint     : ${cfg.saasEndpoint}`);
  pipelineLog.log(`Tenant slug       : ${cfg.tenantSlug}`);
  pipelineLog.log(`ERP database      : ${cfg.sqlDatabase}@${cfg.sqlHost}:${cfg.sqlPort}`);
  pipelineLog.log(`Dia               : ${parsedDate}${ctx.diaEmFalta ? " (dia em falta — recuperação)" : ""}`);
  pipelineLog.log(`Tentativa         : ${ctx.tentativa}/${ctx.total}`);
  pipelineLog.log(`Mês para agregar  : ${month}`);
  pipelineLog.log(`Skip aggregate    : ${args.skipAggregate ? "sim" : "não"}`);
  pipelineLog.log(`Healthcheck URL   : ${cfg.healthcheckUrl ? "configurado" : "(não configurado)"}`);
  if (acc.passosOk.size > 0) pipelineLog.log(`Checkpoint        : passos já concluídos nesta execução: ${[...acc.passosOk].join(", ")}`);
  pipelineLog.log("");

  // Ping /start ao endpoint Healthchecks.io (best-effort). Permite que o
  // dead-man switch detecte quando o agent nunca arranca.
  if (ctx.tentativa === 1) await pingHealthcheck(cfg.healthcheckUrl, "start", `daily-pipeline ${parsedDate}`, pipelineLog);

  let lockAcquired = false;
  // PARTIAL: o daily-sync passou mas um pipeline obrigatório falhou. É
  // diferente de ERROR (o núcleo falhou) e MUITO diferente de OK — só
  // OK conta como dia concluído, portanto um PARTIAL volta a ser
  // proposto pelo catch-up até fechar. O servidor confirma esta regra
  // de forma independente ao gravar (ver /api/admin/pipeline/record),
  // para que um agent antigo não consiga marcar OK um dia incompleto.
  let pipelineStatus: "OK" | "PARTIAL" | "ERROR" | "ABORTED" = "OK";
  let errorMessage: string | undefined;
  let farmaciaId: string = "";

  const client = acc.client ?? new SaasClient(cfg);
  client.definirContexto({ dia: parsedDate, etapa: "farmacia" });

  /** Resultado de uma saída antecipada (o `finally` regista, alerta e faz flush a seguir). */
  const sair = (rc: number): ResultadoDia => ({
    rc,
    status: pipelineStatus,
    transitoria: pipelineStatus !== "OK" && falhasTransitorias > 0 && falhasPermanentes === 0,
    erro: errorMessage,
    passoFalhado,
  });

  try {
    // Resolver farmaciaId ANTES do lock — de propósito, e na ordem
    // inversa da original.
    //
    // Antes (2026-09), o lock era tentado primeiro: se estivesse
    // ocupado (`sync-now`/`full-sync`/outra corrida presa), o pipeline
    // devolvia `return 1` com `farmaciaId` ainda `""`, e o bloco
    // `finally` só regista `PipelineRun` `if (farmaciaId)` — um abort
    // por lock ocupado NUNCA chegava ao SaaS. Resolvendo-a primeiro,
    // `farmaciaId` já está preenchido quando (e se) o lock falhar, e o
    // `finally` grava o `PipelineRun` com `status="ABORTED"` e o motivo
    // exacto — como qualquer outra falha.
    try {
      farmaciaId = await resolveFarmaciaId(client, cfg.farmacia);
    } catch (err) {
      pipelineStatus = "ERROR";
      errorMessage = redigir(err instanceof Error ? err.message : String(err), [cfg.ingestKey]);
      marcarFalha("farmacia", ehTransitoria(err) || ehFalhaDeRede(err));
      pipelineLog.log(`✗ ERROR [farmacia]: ${errorMessage}`);
      return sair(1);
    }
    pipelineLog.log(`Farmácia resolved : ${farmaciaId}`);
    pipelineLog.log("");

    // Lock acquire (mantido entre tentativas do mesmo processo: nenhuma segunda execução entra durante a espera)
    try {
      await acquireLock(args.force === true, "daily-pipeline", parsedDate);
      lockAcquired = true;
    } catch (err) {
      pipelineStatus = "ABORTED";
      errorMessage = err instanceof Error ? err.message : String(err);
      steps.push({ name: "lock", status: "ERROR", durationMs: 0, message: errorMessage });
      marcarFalha("lock", false);
      pipelineLog.log(`✗ ABORTED [lock]: ${errorMessage}`);
      return sair(1);
    }

    // 1) daily-sync
    if (acc.passosOk.has("daily-sync") && acc.dailySyncCounts) {
      steps.push({ name: "daily-sync", status: "OK", durationMs: 0, message: "já concluído na tentativa anterior (checkpoint)" });
      pipelineLog.log(`⏭ Step 1/2: daily-sync já concluído na tentativa anterior — não se repete.`);
    } else {
      const tDailySync = Date.now();
      client.definirContexto({ dia: parsedDate, etapa: "daily-sync" });
      pipelineLog.raw(RULE);
      pipelineLog.log(`▶ Step 1/2: daily-sync ${parsedDate}`);
      pipelineLog.raw(RULE);
      try {
        const counts = await withPool(cfg, async (pool) => {
          return runPipelineForDay({
            pool,
            client,
            farmaciaId,
            date: parsedDate,
            schemaProbes: { tableExists, listColumns },
            logger: dailySyncLog,
          });
        });
        acc.dailySyncCounts = counts;
        const dur = Date.now() - tDailySync;
        pipelineLog.log(`  products read=${counts.productsRead} upserted=${counts.productsUpserted} errors=${counts.productsErrors}`);
        pipelineLog.log(`  stock    read=${counts.stockRead} upserted=${counts.stockUpserted} errors=${counts.stockErrors}`);
        pipelineLog.log(`  sales    read=${counts.salesRead} upserted=${counts.salesUpserted} skipped=${counts.salesSkipped} non_stock=${counts.salesNonStockServices} op_orphans=${counts.salesOperationalOrphans} errors=${counts.salesErrors}`);

        // A pergunta que faltava: o que se leu chegou lá?
        //
        // O `daily-sync` não atirou — leu o dia todo sem um erro. Mas uma
        // leitura sem escrita não é um dia sincronizado, e era exactamente
        // assim que a Principal fechava OK com 93% das vendas recusadas.
        // Ver `saude-vendas.ts` para os números e para a escolha de
        // PARTIAL. A degradação é só num sentido: nada aqui promove um dia
        // que já estava pior.
        acc.saudeVendas = avaliarSaudeVendas(counts);
        if (acc.saudeVendas.saudavel) {
          steps.push({ name: "daily-sync", status: "OK", durationMs: dur });
          acc.passosOk.add("daily-sync");
          pipelineLog.log(`  daily-sync OK em ${fmtDuration(dur)}`);
          if (counts.salesSkipped > 0) pipelineLog.log(`  ℹ ${acc.saudeVendas.motivo}`);
        } else {
          steps.push({ name: "daily-sync", status: "ERROR", durationMs: dur, message: acc.saudeVendas.motivo });
          if (pipelineStatus === "OK") pipelineStatus = "PARTIAL";
          errorMessage = errorMessage ?? acc.saudeVendas.motivo;
          marcarFalha("daily-sync", false);
          pipelineLog.log(`✗ daily-sync PARCIAL em ${fmtDuration(dur)}: ${acc.saudeVendas.motivo}`);
          pipelineLog.log(
            "    O dia NÃO fica fechado e o catch-up volta a propô-lo. Declarar o tipo em " +
              "agent/src/vendas-fontes.ts (CLASSIFICACAO) e deixar o dia repetir.",
          );
        }
        pipelineLog.log("");
      } catch (err) {
        const dur = Date.now() - tDailySync;
        const msg = redigir(err instanceof Error ? err.message : String(err), [cfg.ingestKey]);
        steps.push({ name: "daily-sync", status: "ERROR", durationMs: dur, message: msg });
        pipelineStatus = "ERROR";
        errorMessage = `daily-sync falhou: ${msg}`;
        marcarFalha("daily-sync", ehTransitoria(err));
        pipelineLog.log(`✗ daily-sync ERROR: ${msg}`);
        return sair(1);
      }
    }

    // 1b) compras, devoluções e movimentos — o daily-sync não os cobre.
    //
    // Uma falha aqui NÃO aborta o pipeline: produtos, stock e vendas já
    // foram gravados e continuam correctos. Fica registada como ERROR no
    // relatório e o dia repete-se com o mesmo --date, que é idempotente.
    for (const p of PIPELINES_DIARIOS_EXTRA) {
      if (acc.passosOk.has(p.label)) {
        steps.push({ name: p.label, status: "OK", durationMs: 0, message: "já concluído na tentativa anterior (checkpoint)" });
        pipelineLog.log(`⏭ ${p.label} já concluído na tentativa anterior — não se repete.`);
        continue;
      }
      const t0 = Date.now();
      client.definirContexto({ dia: parsedDate, etapa: p.label });
      pipelineLog.raw(RULE);
      pipelineLog.log(`▶ ${p.label} ${parsedDate}`);
      pipelineLog.raw(RULE);
      const rc = p.janela
        ? correrComandoDoDia(p.cmd, parsedDate, [], p.label)
        : correrComandoSemJanela(p.cmd, parsedDate, p.label);
      const dur = Date.now() - t0;
      if (rc === 0) {
        steps.push({ name: p.label, status: "OK", durationMs: dur });
        acc.passosOk.add(p.label);
        pipelineLog.log(`  ${p.label} OK em ${fmtDuration(dur)}`);
      } else {
        steps.push({ name: p.label, status: "ERROR", durationMs: dur, message: `exit ${rc}` });
        // PARTIAL e não ERROR: produtos, stock e vendas já ficaram
        // gravados e correctos. Mas o dia NÃO está fechado, e é isso
        // que o estado tem de dizer — antes dizia ERROR ou, pior,
        // deixava o dia contar como feito.
        if (pipelineStatus === "OK") pipelineStatus = "PARTIAL";
        errorMessage = errorMessage ?? `${p.label} falhou (exit ${rc})`;
        marcarFalha(p.label, rc === EXIT_TRANSITORIO);
        pipelineLog.log(`✗ ${p.label} ERROR (exit ${rc}${rc === EXIT_TRANSITORIO ? ", falha transitória do SaaS" : ""}) — repetível com o mesmo --date`);
      }
    }

    // 1c) Refresh operacional — catálogo inteiro, sem filtro de dia.
    //
    // Fecha a lacuna do `daily-sync` (Passo 1): produtos sem
    // venda/compra/movimento NESSE dia nunca voltam a entrar no filtro
    // de `scope: "date"`, e o seu pmc/puc/stock em `ProdutoFarmacia`
    // fica congelado indefinidamente — mesmo que o ERP tenha mudado
    // entretanto. Corre sempre, mesmo com `--skip-aggregate` (é
    // independente da agregação de vendas). Uma falha aqui é PARTIAL,
    // nunca ERROR/ABORTED: produtos, stock e vendas do dia já foram
    // gravados correctamente por cima — só o catálogo INTEIRO é que fica
    // por refrescar até à corrida seguinte (idempotente, repete-se
    // sozinho). Ver `runOperationalRefresh` em `daily-sync-runner.ts`.
    if (acc.passosOk.has("refresh-operacional") && acc.refreshOperacional) {
      steps.push({ name: "refresh-operacional", status: "OK", durationMs: 0, message: "já concluído na tentativa anterior (checkpoint)" });
      pipelineLog.log(`⏭ Refresh operacional já concluído na tentativa anterior — não se repete.`);
    } else {
      const t0 = Date.now();
      client.definirContexto({ dia: parsedDate, etapa: "refresh-operacional" });
      pipelineLog.raw(RULE);
      pipelineLog.log(`▶ Refresh operacional (catálogo inteiro) ${parsedDate}`);
      pipelineLog.raw(RULE);
      try {
        const ro = await withPool(cfg, async (pool) => {
          return runOperationalRefresh({
            pool,
            client,
            farmaciaId,
            schemaProbes: { tableExists, listColumns },
            logger: dailySyncLog,
          });
        });
        acc.refreshOperacional = ro;
        const dur = Date.now() - t0;
        steps.push({ name: "refresh-operacional", status: "OK", durationMs: dur });
        acc.passosOk.add("refresh-operacional");
        pipelineLog.log(`  produtos read=${ro.productsRead} upserted=${ro.productsUpserted} errors=${ro.productsErrors}`);
        pipelineLog.log(
          ro.stockSaltado
            ? `  stock: saltado (sem dbo.StocksMov)`
            : `  stock    read=${ro.stockRead} upserted=${ro.stockUpserted} errors=${ro.stockErrors}`,
        );
        pipelineLog.log(`  refresh operacional OK em ${fmtDuration(dur)}`);
      } catch (err) {
        const dur = Date.now() - t0;
        const msg = redigir(err instanceof Error ? err.message : String(err), [cfg.ingestKey]);
        steps.push({ name: "refresh-operacional", status: "ERROR", durationMs: dur, message: msg });
        if (pipelineStatus === "OK") pipelineStatus = "PARTIAL";
        errorMessage = errorMessage ?? `refresh-operacional falhou: ${msg}`;
        marcarFalha("refresh-operacional", ehTransitoria(err));
        pipelineLog.log(`✗ refresh-operacional ERROR: ${msg} — repetível na corrida seguinte`);
      }
      pipelineLog.log("");
    }

    // 1d) Designações — SÓ farmácia autoritativa (tenant silveira / Silveirense).
    //
    // O SaaS decide (GET .../products/designacoes); em qualquer outra farmácia
    // isto é um único GET e nada mais. Compara o catálogo INTEIRO do ERP
    // (activos e retirados) com a designação da base, em cada corrida diária,
    // independentemente de o ERP ter marcado o produto como alterado. O
    // refresh operacional acima já passa por aqui pelo endpoint de produtos
    // para os activos; este passo cobre também os retirados e é a mesma regra
    // do servidor. Falha aqui é PARTIAL (idempotente, repete-se amanhã).
    if (acc.passosOk.has("designacoes")) {
      steps.push({ name: "designacoes", status: "OK", durationMs: 0, message: "já concluído na tentativa anterior (checkpoint)" });
    } else {
      const t0 = Date.now();
      client.definirContexto({ dia: parsedDate, etapa: "designacoes" });
      try {
        const dz = await withPool(cfg, async (pool) =>
          runDesignacoesRefresh({ pool, client, farmaciaId, logger: dailySyncLog }),
        );
        acc.passosOk.add("designacoes");
        if (dz.aplicavel) {
          const dur = Date.now() - t0;
          steps.push({ name: "designacoes", status: "OK", durationMs: dur });
          pipelineLog.log(
            `  designações: lidas=${dz.lidas} verificadas=${dz.verificadas} alteradas=${dz.alteradas} já iguais=${dz.jaIguais}`,
          );
        }
      } catch (err) {
        const dur = Date.now() - t0;
        const msg = redigir(err instanceof Error ? err.message : String(err), [cfg.ingestKey]);
        steps.push({ name: "designacoes", status: "ERROR", durationMs: dur, message: msg });
        if (pipelineStatus === "OK") pipelineStatus = "PARTIAL";
        errorMessage = errorMessage ?? `designações falhou: ${msg}`;
        marcarFalha("designacoes", ehTransitoria(err));
        pipelineLog.log(`✗ designações ERROR: ${msg} — repetível na corrida seguinte`);
      }
    }

    // 2) aggregate-month (skippable)
    if (args.skipAggregate) {
      steps.push({ name: "aggregate-month", status: "SKIPPED", durationMs: 0, message: "--skip-aggregate" });
      pipelineLog.log(`⏭ Step 2/2: aggregate-month SKIPPED (--skip-aggregate)`);
    } else if (acc.passosOk.has("aggregate-month") && acc.aggregateResp) {
      steps.push({ name: "aggregate-month", status: "OK", durationMs: 0, message: "já concluído na tentativa anterior (checkpoint)" });
      pipelineLog.log(`⏭ Step 2/2: aggregate-month já concluído na tentativa anterior — não se repete.`);
    } else {
      const tAgg = Date.now();
      client.definirContexto({ dia: parsedDate, etapa: "aggregate-month" });
      pipelineLog.raw(RULE);
      pipelineLog.log(`▶ Step 2/2: aggregate-month ${month}`);
      pipelineLog.raw(RULE);
      try {
        // Os gates vêm da POLÍTICA da farmácia (agent.config.json →
        // options.allowUnknowns / options.allowOrphans), não de uma
        // decisão tomada no momento.
        //
        // Sem isto, uma farmácia cujo onboarding correu com
        // --allow-unknowns ficava bloqueada na PRIMEIRA corrida diária
        // pelos mesmos dados: o histórico entrou, o dia seguinte
        // abortou com 409 unknowns_present. Foi o que aconteceu na
        // Silveirense — o full-sync passou com allow-unknowns=sim e o
        // diário parou em Agosto com 12 linhas.
        //
        // As linhas UNKNOWN nunca entram na soma (a query filtra
        // `tipoDocumentoClass IN ('VENDA','DEVOLUCAO_ANULACAO')`),
        // portanto isto não altera números — decide apenas se o mês
        // aborta ou avança deixando-as de fora.
        //
        // As retentativas por falha de rede/timeout/502-504 são do cliente HTTP (política
        // central); aqui só se vê o resultado final.
        const resp = await client.pipelineAggregateMonth(
          {
            month,
            write: true,
            allowUnknowns: cfg.allowUnknowns === true,
            allowOrphans: cfg.allowOrphans === true,
          },
          90_000,
        );
        acc.aggregateResp = resp;
        const dur = Date.now() - tAgg;
        steps.push({ name: "aggregate-month", status: "OK", durationMs: dur });
        acc.passosOk.add("aggregate-month");
        aggregateLog.log(`aggregate-month ${month} response: ${JSON.stringify(resp, null, 2)}`);
        pipelineLog.log(`  aggregate-month OK em ${fmtDuration(dur)}`);
        pipelineLog.log(`  rows inserted: ${resp.rowsInserted}  deleted: ${resp.rowsDeleted}`);
        pipelineLog.log(`  unknowns: ${resp.preflight.unknowns}`);
        pipelineLog.log(`  non-stock services: ${resp.preflight.nonStockServices}`);
        pipelineLog.log(`  operational orphans: ${resp.preflight.operationalOrphans}`);
        pipelineLog.log(`  valorBruto Σ: ${fmtEur(resp.totals.valorBruto)} EUR`);
        pipelineLog.log("");
      } catch (err) {
        const dur = Date.now() - tAgg;
        let msg: string;
        if (err instanceof SaasApiError) {
          // 409 abort vs 500
          msg = `${err.method} ${err.path} → HTTP ${err.statusCode}: ${err.bodySnippet ?? ""}`;
          if (err.statusCode === 409) pipelineStatus = "ABORTED";
          else pipelineStatus = "ERROR";
        } else {
          msg = redigir(err instanceof Error ? err.message : String(err), [cfg.ingestKey]);
          pipelineStatus = "ERROR";
        }
        steps.push({ name: "aggregate-month", status: "ERROR", durationMs: dur, message: msg });
        errorMessage = `aggregate-month falhou: ${msg}`;
        marcarFalha("aggregate-month", ehTransitoria(err));
        pipelineLog.log(`✗ aggregate-month ${pipelineStatus}: ${msg}`);
        aggregateLog.log(`aggregate-month ${month} ${pipelineStatus}: ${msg}`);
        return sair(1);
      }
    }
  } catch (err) {
    pipelineStatus = "ERROR";
    errorMessage = redigir(err instanceof Error ? err.message : String(err), [cfg.ingestKey]);
    marcarFalha("inesperado", ehTransitoria(err));
    pipelineLog.log(`✗ ERROR inesperado: ${errorMessage}`);
    return sair(1);
  } finally {
    const wallMs = Date.now() - t0;
    const finishedAt = new Date();
    // Só se retoma se TODAS as falhas desta tentativa foram transitórias.
    const transitoria = pipelineStatus !== "OK" && falhasTransitorias > 0 && falhasPermanentes === 0;
    const vaiRetomar = !ctx.ultima && transitoria;
    const statsHttp = client.estatisticas();

    // Resumo final desta tentativa
    pipelineLog.raw("");
    pipelineLog.raw(DOUBLE_RULE);
    pipelineLog.log(`DAILY PIPELINE ${pipelineStatus}${vaiRetomar ? " (falha transitória — será repetido)" : ""}`);
    pipelineLog.log(`Date: ${parsedDate}  |  Tentativa ${ctx.tentativa}/${ctx.total}`);
    pipelineLog.raw("");
    if (acc.dailySyncCounts) {
      pipelineLog.log(`Products synced: ${acc.dailySyncCounts.productsUpserted}`);
      pipelineLog.log(`Stock rows synced: ${acc.dailySyncCounts.stockUpserted}`);
      pipelineLog.log(`Sales lines synced: ${acc.dailySyncCounts.salesUpserted}`);
      pipelineLog.raw("");
    }
    if (acc.refreshOperacional) {
      pipelineLog.log(`Refresh operacional (catálogo inteiro):`);
      pipelineLog.log(`  products upserted: ${acc.refreshOperacional.productsUpserted}`);
      pipelineLog.log(
        acc.refreshOperacional.stockSaltado
          ? `  stock: saltado (sem StocksMov)`
          : `  stock upserted: ${acc.refreshOperacional.stockUpserted}`,
      );
      pipelineLog.raw("");
    }
    if (acc.aggregateResp) {
      pipelineLog.log(`VendaMensal:`);
      pipelineLog.log(`  rows inserted: ${acc.aggregateResp.rowsInserted}`);
      pipelineLog.log(`  valorBruto: ${fmtEur(acc.aggregateResp.totals.valorBruto)} EUR`);
      pipelineLog.log(`  devoluções: ${acc.aggregateResp.preflight.byClass.DEVOLUCAO_ANULACAO ?? 0}`);
      pipelineLog.raw("");
      pipelineLog.log(`Unknown TipoDocs: ${acc.aggregateResp.preflight.unknowns}`);
      pipelineLog.log(`Operational orphans: ${acc.aggregateResp.preflight.operationalOrphans}`);
      pipelineLog.raw("");
    }
    if (errorMessage) {
      pipelineLog.log(`Error: ${errorMessage}`);
      pipelineLog.raw("");
    }
    pipelineLog.log(
      `HTTP: pedidos=${statsHttp.pedidos} retentativas=${statsHttp.retentativas} recuperados=${statsHttp.recuperadosPorRetentativa} ` +
        `(após falha ambígua=${statsHttp.recuperadosAposAmbigua}) falhas definitivas=${statsHttp.falhasDefinitivas}`,
    );
    pipelineLog.log(`Duration total: ${fmtDuration(wallMs)}`);
    pipelineLog.raw(DOUBLE_RULE);

    if (!vaiRetomar) {
      const pedidosRecuperadosHttp = statsHttp.recuperadosPorRetentativa - acc.recuperadosHttpInicio;
      const desfecho = classificarDesfecho({
        status: pipelineStatus,
        tentativas: ctx.tentativa,
        pedidosRecuperadosHttp,
        diaEmFalta: ctx.diaEmFalta,
      });

      // Record run no SaaS (best effort — não falha o pipeline; se o SaaS estiver inacessível guarda-se localmente)
      if (farmaciaId) {
        const details = {
          dailyDate: parsedDate,
          aggregateMonth: month,
          steps,
          dailySync: acc.dailySyncCounts ?? undefined,
          refreshOperacional: acc.refreshOperacional ?? undefined,
          // O veredicto viaja para o SaaS com os tipos por declarar lá
          // dentro. É o que faz a diferença entre "salesSkipped=1117" —
          // que não diz o que fazer — e "ATENDIMENTO_DETALHE:77×1090",
          // que diz. Sem isto, diagnosticar exige o log da farmácia.
          saudeVendas: acc.saudeVendas
            ? {
                saudavel: acc.saudeVendas.saudavel,
                fraccaoSkipped: Number(acc.saudeVendas.fraccaoSkipped.toFixed(4)),
                motivo: acc.saudeVendas.motivo,
                tiposPorClassificar: acc.dailySyncCounts?.salesTiposPorClassificar ?? [],
              }
            : undefined,
          aggregate: acc.aggregateResp
            ? {
                ano: parseInt(month.slice(0, 4), 10),
                mes: parseInt(month.slice(5, 7), 10),
                rawLines: acc.aggregateResp.preflight.rawLines,
                produtosDistinct: acc.aggregateResp.preflight.produtosDistinct,
                atendimentosDistinct: acc.aggregateResp.preflight.atendimentosDistinct,
                byClass: acc.aggregateResp.preflight.byClass,
                unknowns: acc.aggregateResp.preflight.unknowns,
                nonStockServices: acc.aggregateResp.preflight.nonStockServices,
                operationalOrphans: acc.aggregateResp.preflight.operationalOrphans,
                rowsInserted: acc.aggregateResp.rowsInserted,
                rowsDeleted: acc.aggregateResp.rowsDeleted,
                valorBrutoSum: acc.aggregateResp.totals.valorBruto,
                quantidadeLiquidaSum: acc.aggregateResp.totals.quantidadeLiquida,
                linhasVendaSum: acc.aggregateResp.totals.linhasVenda,
                atendimentosSum: acc.aggregateResp.totals.atendimentos,
                aggregateRunId: acc.aggregateResp.pipelineRunId,
              }
            : undefined,
          // rev98 — como o dia foi concluído (ou não): sem dados de negócio.
          resiliencia: {
            desfecho,
            tentativaPipeline: ctx.tentativa,
            totalTentativasPipeline: ctx.total,
            diaEmFalta: ctx.diaEmFalta,
            http: statsHttp,
            falhaTransitoria: transitoria,
          },
        };
        // Idempotency key determinístico: retries da MESMA execução
        // (mesmo startedAt) produzem a mesma key → upsert server-side.
        // O `startedAt` é o da 1.ª tentativa do dia nesta execução: as retomas actualizam
        // o MESMO registo em vez de criar um por tentativa. Mudança de qualquer componente
        // (dia ou execução) gera key nova, preservando audit log para runs independentes.
        const idempotencyKey = `daily-pipeline:${farmaciaId}:${parsedDate}:${startedAt.toISOString()}`;
        client.definirContexto({ dia: parsedDate, etapa: "pipeline-record" });
        await registarPipelineRunDuravel(
          client,
          {
            farmaciaId,
            kind: "daily-pipeline",
            status: pipelineStatus,
            startedAt: startedAt.toISOString(),
            finishedAt: finishedAt.toISOString(),
            durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
            dateRef: parsedDate,
            errorMessage,
            details,
            triggeredBy: "agent",
            idempotencyKey,
          },
          (s) => pipelineLog.log(s),
        );
      }

      // Estado local + alerta operacional
      const dirE = dirEstadoPadrao();
      const farmaciaChave = farmaciaId || cfg.farmacia;
      try {
        if (pipelineStatus === "OK") {
          removerPendente(dirE, parsedDate);
          const res = resolverAlertasDoDia(dirE, farmaciaChave, parsedDate);
          if (res.length > 0) pipelineLog.log(`✓ Alerta(s) resolvido(s) para ${parsedDate}: ${res.map((a) => a.causa).join(", ")}`);
        } else {
          registarPendente(dirE, { dia: parsedDate, estado: pipelineStatus, causa: `${passoFalhado ?? "pipeline"}: ${redigir(errorMessage ?? "", [cfg.ingestKey])}` });
          const r = await abrirAlerta(
            dirE,
            {
              farmacia: farmaciaChave,
              dia: parsedDate,
              causa: causaDaFalha({ passoFalhado, transitoria, status: pipelineStatus }),
              mensagem: redigir(errorMessage ?? "falha do pipeline", [cfg.ingestKey]),
            },
            criarNotificador(cfg),
          );
          if (r.notificou) pipelineLog.log(`⚠ ALERTA enviado: ${r.alerta.causa} (${parsedDate})`);
          else if (r.erroNotificacao) pipelineLog.log(`⚠ ALERTA registado em run/pipeline-alertas.json mas a notificação FALHOU: ${r.erroNotificacao} — a causa mantém-se e será reenviada.`);
          else pipelineLog.log(`⚠ Alerta já existente para esta causa (${r.alerta.causa}, ${parsedDate}) — sem notificação duplicada.`);
        }
      } catch (err) {
        pipelineLog.log(`⚠ Não foi possível actualizar o estado local/alerta: ${redigir(err instanceof Error ? err.message : String(err), [cfg.ingestKey])}`);
      }
      pipelineLog.log(`RESULTADO ${parsedDate}: ${ROTULO_DESFECHO[desfecho]}`);

      // Ping final ao Healthchecks.io: OK → endpoint padrão. As FALHAS notificam-se pelo alerta
      // (uma vez por farmácia/dia/causa) — não se repete o /fail em cada tentativa ou corrida.
      if (pipelineStatus === "OK") {
        const summaryBody = [
          `daily-pipeline ${pipelineStatus}`,
          `date=${parsedDate}`,
          `duration=${fmtDuration(wallMs)}`,
          `desfecho=${desfecho}`,
          acc.dailySyncCounts ? `sales=${acc.dailySyncCounts.salesUpserted}` : null,
          acc.aggregateResp ? `agg_rows=${acc.aggregateResp.rowsInserted}` : null,
        ].filter(Boolean).join("\n");
        await pingHealthcheck(cfg.healthcheckUrl, "ok", summaryBody, pipelineLog);
      }
    }

    // Flush logs (e o lock mantém-se se há retoma; liberta-se no fim das tentativas)
    await Promise.allSettled([pipelineLog.flush(), dailySyncLog.flush(), aggregateLog.flush()]);
    void lockAcquired;
  }

  const rcSaida = pipelineStatus === "OK" ? 0 : pipelineStatus === "PARTIAL" ? EXIT_PARTIAL : 1;
  const transitoriaFinal = pipelineStatus !== "OK" && falhasTransitorias > 0 && falhasPermanentes === 0;
  return { rc: rcSaida, status: pipelineStatus, transitoria: transitoriaFinal, erro: errorMessage, passoFalhado };
}
