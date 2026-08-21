#!/usr/bin/env node
/**
 * scripts/workers/scheduler.mjs
 *
 * Scheduler da plataforma — o ÚNICO agendador de produção.
 *
 * Não corre lógica de negócio nenhuma: dispara os endpoints
 * `/api/jobs/*` da própria aplicação, autenticados por `CRON_SECRET`.
 * É essa a razão de ser desta forma — o lock, o ledger `SyncRun`, a
 * iteração por tenant e o tratamento de erros vivem todos nos handlers,
 * e existe uma só implementação para manter correcta em vez de duas.
 *
 * JAVASCRIPT PURO, sem dependências: a imagem de produção é um build
 * standalone do Next e não leva `tsx` nem as devDependencies. Um
 * scheduler escrito em TypeScript exigiria um segundo pipeline de build
 * só para ele.
 *
 * DESLIGADO POR DEFEITO. Com `SCHEDULER_ENABLED` a falso o processo
 * arranca, diz que está desligado e fica parado. Fica assim
 * deliberadamente: o container está instalado e pronto, mas não toca em
 * dados. Sair com código 0 faria o Docker reiniciá-lo em ciclo, e sair
 * com erro poluiria o estado da stack com uma falha que não é falha.
 *
 * Uso:
 *   node scripts/workers/scheduler.mjs              # daemon
 *   node scripts/workers/scheduler.mjs --list       # mostra o plano e sai
 *   node scripts/workers/scheduler.mjs --once refresh-ipf   # dispara um job e sai
 *
 * Env:
 *   SCHEDULER_ENABLED     0|1   — sem isto a 1, nada é disparado
 *   SCHEDULER_JOBS              — lista de jobs activos, separada por
 *                                 vírgulas. Ausente ou vazia = todos.
 *                                 Ex.: SCHEDULER_JOBS=utilizacoes
 *   APP_INTERNAL_URL            — default http://web:3000
 *   CRON_SECRET                 — bearer exigido pelos endpoints
 *   SCHEDULER_TIMEZONE          — apenas "UTC" é suportado (ver nota)
 *   SCHEDULER_HEARTBEAT_FILE    — default /tmp/scheduler-heartbeat
 *   SCHEDULER_JOB_TIMEOUT_MS    — default 600000 (10 min)
 *
 * Saída: 0 fim normal (--list, --once ok, SIGTERM) · 1 erro de
 *        configuração ou job falhado em --once
 */

import { writeFile } from "node:fs/promises";

// ─────────────────────────────────────────────────────────────────────
// Plano
// ─────────────────────────────────────────────────────────────────────
//
// Esta tabela é o plano de produção, e é a única. O `vercel.json` na
// raiz do repositório é LEGADO de um alojamento abandonado: não é lido
// por nada nesta infraestrutura e não deve ser usado como referência.
// Alterar o agendamento faz-se aqui.
//
// Horas em UTC. A ordem é a das dependências: o refresh do read-model
// primeiro, o enriquecimento depois, a aquisição regulamentar por fim.
const JOBS = [
  { name: "enqueue-regulatory", path: "/api/jobs/enqueue-regulatory", hour: 2, minute: 0 },
  { name: "acquire-regulatory", path: "/api/jobs/acquire-regulatory", hour: 2, minute: 30 },
  { name: "refresh-ipf", path: "/api/jobs/refresh-ipf", hour: 3, minute: 0 },
  { name: "enrich-catalog", path: "/api/jobs/enrich-catalog", hour: 4, minute: 0 },
  { name: "enrich-retail", path: "/api/jobs/enrich-retail", hour: 5, minute: 0 },
  // Utilizações: não é diário. A sua função é reagir a um
  // products-upload que acabou de fechar — uma farmácia acabada de
  // instalar não pode esperar até de madrugada para ter a faceta de
  // pesquisa preenchida. Barato quando não há trabalho: o handler
  // compara dois timestamps por tenant e devolve logo.
  { name: "utilizacoes", path: "/api/jobs/utilizacoes", everyMinutes: 10 },
  // Ciclo curto do enriquecimento: processa SÓ o que está na
  // EnriquecimentoFila, onde a importação põe cada CNP que o catálogo
  // global ainda não conhece.
  //
  // Existe porque o `enrich-catalog` das 04:00 chegava tarde demais: uma
  // farmácia que importa às 09:00 ficava com produtos por classificar até
  // à madrugada seguinte. Aqui são minutos.
  //
  // Barato quando não há nada a fazer — o filtro da fila não devolve
  // linhas e o ciclo acaba sem uma única chamada ao modelo. O tecto de
  // custo baixo é a segunda tranca: mesmo com a fila cheia por engano,
  // um ciclo destes não pode gastar mais do que uns cêntimos, e o que
  // sobrar fica para o seguinte.
  //
  // A varredura das 04:00 continua a ser a rede de segurança: apanha o
  // que ficou PENDENTE ou FALHOU e o que nunca chegou a entrar em fila.

  {
    name: "enrich-fila",
    path: "/api/jobs/enrich-catalog?apenasFila=1&knowledgeLimit=100&knowledgeCapUsd=2",
    everyMinutes: 15,
  },
];

const TICK_MS = 30_000;

// ─────────────────────────────────────────────────────────────────────
// Configuração
// ─────────────────────────────────────────────────────────────────────

function boolEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const v = raw.toLowerCase().trim();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Lista de jobs activos. Vazia = todos (comportamento anterior).
 *
 * Existe para se poder ligar UM job sem ligar os outros. Sem isto, pôr o
 * scheduler a correr por causa de um job novo activava também os cinco
 * nocturnos — enriquecimento incluído — que podem não estar validados
 * naquela instalação. "Ligar o scheduler" e "ligar todos os jobs" eram a
 * mesma decisão, e não deviam ser.
 *
 *   SCHEDULER_JOBS=utilizacoes                 só este
 *   SCHEDULER_JOBS=utilizacoes,refresh-ipf     dois
 *   SCHEDULER_JOBS= (ou ausente)               todos
 */
function jobsPermitidos() {
  const raw = (process.env.SCHEDULER_JOBS || "").trim();
  if (!raw) return null; // null = sem filtro
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

const CONFIG = {
  enabled: boolEnv("SCHEDULER_ENABLED", false),
  jobsPermitidos: jobsPermitidos(),
  baseUrl: (process.env.APP_INTERNAL_URL || "http://web:3000").replace(/\/+$/, ""),
  secret: process.env.CRON_SECRET || "",
  heartbeatFile: process.env.SCHEDULER_HEARTBEAT_FILE || "/tmp/scheduler-heartbeat",
  jobTimeoutMs: Number.parseInt(process.env.SCHEDULER_JOB_TIMEOUT_MS || "600000", 10),
};

function log(level, msg, extra) {
  const line = { ts: new Date().toISOString(), level, component: "scheduler", msg };
  if (extra) Object.assign(line, extra);
  // JSON numa linha: o `docker logs` é a única superfície de observação
  // deste processo, e linhas estruturadas são filtráveis com `jq`.
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

// ─────────────────────────────────────────────────────────────────────
// Execução de um job
// ─────────────────────────────────────────────────────────────────────

async function runJob(job) {
  const url = `${CONFIG.baseUrl}${job.path}`;
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.jobTimeoutMs);

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${CONFIG.secret}` },
      signal: controller.signal,
    });
    const durationMs = Date.now() - t0;

    // 207 = falhas parciais por tenant, 503 = correu mas ficou unhealthy.
    // Nenhum dos dois é motivo para tratar o disparo como falhado — o
    // handler já registou o detalhe no ledger. Só <200 ou >=400 (fora do
    // 503 conhecido) é que indicam que o pedido em si não passou.
    const ok = res.status === 200 || res.status === 207 || res.status === 503;
    let body = null;
    try {
      body = await res.json();
    } catch {
      // Corpo não-JSON (proxy a devolver HTML de erro, por exemplo).
    }

    if (ok) {
      log("info", "job concluído", {
        job: job.name,
        status: res.status,
        durationMs,
        rollup: body?.rollup ?? null,
      });
    } else {
      log("error", "job devolveu estado inesperado", {
        job: job.name,
        status: res.status,
        durationMs,
        error: body?.error ?? null,
      });
    }
    return ok;
  } catch (err) {
    const aborted = err?.name === "AbortError";
    log("error", aborted ? "job excedeu o tempo limite" : "job inacessível", {
      job: job.name,
      durationMs: Date.now() - t0,
      error: aborted ? `timeout ${CONFIG.jobTimeoutMs}ms` : String(err?.message ?? err),
    });
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Loop
// ─────────────────────────────────────────────────────────────────────

/**
 * Chave do dia + hora agendada de um job. Registar a última chave
 * disparada é o que impede um segundo disparo dentro do mesmo minuto —
 * o tick corre a cada 30s, portanto passa duas vezes por cada minuto.
 */
function slotKey(job, now) {
  if (job.everyMinutes) {
    // Bloco do intervalo: dois ticks dentro do mesmo bloco de N minutos
    // partilham a chave, e o segundo não dispara.
    return `every:${job.everyMinutes}:${Math.floor(now.getTime() / (job.everyMinutes * 60_000))}`;
  }
  return `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}T${job.hour}:${job.minute}`;
}

/** Este job está ligado nesta instalação? */
function jobActivo(job) {
  return CONFIG.jobsPermitidos === null || CONFIG.jobsPermitidos.has(job.name);
}

/** Está na altura deste job? Diário por hora:minuto, ou por intervalo. */
function estaNaAltura(job, now) {
  // Nos jobs por intervalo é o slotKey que limita a cadência: aqui passa
  // sempre e o bloco é que decide se já disparou.
  if (job.everyMinutes) return true;
  return now.getUTCHours() === job.hour && now.getUTCMinutes() === job.minute;
}

async function heartbeat() {
  try {
    await writeFile(CONFIG.heartbeatFile, `${Date.now()}\n`, "utf8");
  } catch (err) {
    // O heartbeat é para o healthcheck do container; falhar a escrevê-lo
    // não é razão para parar de agendar.
    log("warn", "não foi possível escrever o heartbeat", { error: String(err?.message ?? err) });
  }
}

let stopping = false;
const lastFired = new Map();

async function tick() {
  await heartbeat();
  if (stopping) return;

  const now = new Date();
  for (const job of JOBS) {
    if (!jobActivo(job)) continue;
    if (!estaNaAltura(job, now)) continue;
    const key = slotKey(job, now);
    if (lastFired.get(job.name) === key) continue;
    lastFired.set(job.name, key);
    log("info", "a disparar job", {
      job: job.name,
      scheduled: job.everyMinutes
        ? `cada ${job.everyMinutes} min`
        : `${job.hour}:${String(job.minute).padStart(2, "0")} UTC`,
    });
    // Sem await: um job lento não pode atrasar o tick nem os restantes.
    // O lock cooperativo do lado do handler é que garante que não há
    // sobreposição do MESMO job.
    void runJob(job);
  }
}

function describePlan() {
  // Mostra TODOS os jobs, marcando os desligados. Listar só os activos
  // esconderia a razão de um job não estar a correr — que é exactamente
  // a pergunta que alguém faz ao correr --list.
  return JOBS.map((j) => {
    const quando = j.everyMinutes
      ? `cada ${String(j.everyMinutes).padStart(2, " ")} min`
      : `${String(j.hour).padStart(2, "0")}:${String(j.minute).padStart(2, "0")} UTC`;
    const marca = jobActivo(j) ? "[on ]" : "[off]";
    return `  ${marca} ${quando.padEnd(12)}  ${j.name.padEnd(20)} ${j.path}`;
  }).join("\n");
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(
      `Scheduler local do SPharm.MT\n\n` +
        `  --list           mostra o plano e sai\n` +
        `  --once <job>     dispara um job e sai\n\n` +
        `Plano (UTC):\n${describePlan()}\n\n` +
        `SCHEDULER_ENABLED=${CONFIG.enabled ? "1" : "0"}  APP_INTERNAL_URL=${CONFIG.baseUrl}\n`,
    );
    return 0;
  }

  if (args.includes("--list")) {
    process.stdout.write(`Plano (UTC):\n${describePlan()}\n`);
    return 0;
  }

  const onceIdx = args.indexOf("--once");
  if (onceIdx !== -1) {
    const name = args[onceIdx + 1];
    const job = JOBS.find((j) => j.name === name);
    if (!job) {
      process.stderr.write(`job desconhecido: ${name || "(nenhum)"}\nDisponíveis: ${JOBS.map((j) => j.name).join(", ")}\n`);
      return 1;
    }
    if (!CONFIG.secret) {
      process.stderr.write("CRON_SECRET não definido — os endpoints /api/jobs/* recusam sem ele.\n");
      return 1;
    }
    // `--once` ignora SCHEDULER_ENABLED de propósito: é o mecanismo de
    // validação manual, e ter de ligar o scheduler para testar um job
    // seria exactamente o oposto de seguro.
    const ok = await runJob(job);
    return ok ? 0 : 1;
  }

  if (!CONFIG.enabled) {
    log("info", "scheduler DESLIGADO (SCHEDULER_ENABLED não está a 1) — nenhum job será disparado", {
      plano: JOBS.map((j) => j.name),
    });
    log("info", "o processo fica vivo e ocioso; para disparar manualmente: node scripts/workers/scheduler.mjs --once <job>");
    // Heartbeat continua a ser escrito: o container está saudável, só
    // não tem trabalho. Um healthcheck a falhar aqui reportaria uma
    // avaria que não existe.
    //
    // O intervalo NÃO leva `unref()`: é ele que mantém o event loop
    // vivo. Com `unref()` o Node não tinha trabalho pendente, o processo
    // saía com 0, o Docker reiniciava-o pela política de restart e o
    // worker ficava em ciclo de arranque — a parecer avariado quando só
    // estava desligado.
    await heartbeat();
    const idleTimer = setInterval(heartbeat, TICK_MS);
    await new Promise((resolve) => {
      const stop = () => {
        clearInterval(idleTimer);
        resolve(undefined);
      };
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
    });
    log("info", "a terminar");
    return 0;
  }

  if (!CONFIG.secret) {
    process.stderr.write(
      "SCHEDULER_ENABLED=1 mas CRON_SECRET não está definido.\n" +
        "Os endpoints /api/jobs/* recusariam TODOS os disparos (503).\n",
    );
    return 1;
  }

  log("info", "scheduler activo", { baseUrl: CONFIG.baseUrl, jobs: JOBS.map((j) => j.name) });

  const interval = setInterval(() => {
    void tick();
  }, TICK_MS);
  await tick();

  await new Promise((resolve) => {
    const stop = (sig) => {
      stopping = true;
      clearInterval(interval);
      log("info", "sinal recebido — a terminar", { signal: sig });
      resolve(undefined);
    };
    process.once("SIGTERM", () => stop("SIGTERM"));
    process.once("SIGINT", () => stop("SIGINT"));
  });
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    log("error", "falha fatal do scheduler", { error: String(err?.stack ?? err) });
    process.exit(1);
  });
