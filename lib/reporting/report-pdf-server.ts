/**
 * lib/reporting/report-pdf-server.ts
 *
 * SERVER-ONLY: usa puppeteer para gerar um PDF a partir do HTML
 * produzido por `renderReportHtml(report)`. Nunca importar num Client
 * Component — puxaria o Chromium para o bundle.
 *
 * O browser instance é mantido em cache module-level (singleton) para
 * amortizar o custo de arranque do Chromium — fazer launch+close a
 * cada pedido demora 2–4s cada, enquanto reutilizar ronda os 300ms.
 *
 * ── PORQUE É QUE ISTO PRECISOU DE UM HOME ────────────────────────────
 *
 * Em produção o Chromium não arrancava:
 *
 *     Failed to launch the browser process: Code: null
 *     chrome_crashpad_handler: --database is required
 *
 * A causa não é o crashpad — é o HOME. O container corre como `nextjs`
 * (uid 10001) e o `useradd --home /app` aponta o HOME para `/app`, que
 * é `root:root drwxr-xr-x`. O Chromium precisa de escrever o directório
 * de perfil e a base de dados de crashes algures debaixo do HOME; sem
 * poder criar nada, passa ao crashpad um `--database` vazio e o processo
 * morre antes de abrir a porta de DevTools. O puppeteer só vê o
 * processo a terminar sem código.
 *
 * Reproduzido dentro do container de produção, a 2026-09-03:
 *
 *   HOME=/app     chromium --headless --dump-dom about:blank  → rc=1
 *                 "Failed to create headless user data directory container"
 *   HOME=/tmp/…   idem, com --user-data-dir=/tmp/…            → rc=0
 *
 * A correcção é dar-lhe um HOME e um perfil onde possa MESMO escrever.
 * `/tmp` é tmpfs no compose (rw, 256m) precisamente para isto.
 */

import "server-only";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import puppeteer, { type Browser } from "puppeteer";
import type { Report } from "./report-types";
import { renderReportHtml } from "./report-html";
import { makeReportFilename } from "./report-filename";

// ─── Ambiente do Chromium ─────────────────────────────────────────────────────

type AmbienteChromium = {
  /** HOME do processo do browser. Tem de ser gravável. */
  home: string;
  /** `--user-data-dir`. Perfil isolado, descartável. */
  perfil: string;
};

let ambiente: AmbienteChromium | null = null;

/**
 * Cria (uma vez por processo) um HOME e um perfil graváveis debaixo de
 * `os.tmpdir()`.
 *
 * `mkdtemp` e não um caminho fixo: dois processos da aplicação na mesma
 * máquina — o `web` e o `worker`, ou dois containers a partilhar tmpfs —
 * não podem disputar o mesmo perfil. Um perfil partilhado por duas
 * instâncias do Chromium é um lock em disputa, e o segundo arranque
 * falha.
 */
function garantirAmbiente(): AmbienteChromium {
  if (ambiente) return ambiente;
  const raiz = mkdtempSync(path.join(tmpdir(), "spharmmt-chromium-"));
  ambiente = {
    home: path.join(raiz, "home"),
    perfil: path.join(raiz, "profile"),
  };
  // O puppeteer cria o `userDataDir` se não existir; o HOME não, e o
  // Chromium também não o cria. `recursive` cobre os dois casos.
  mkdirSync(ambiente.home, { recursive: true });
  mkdirSync(ambiente.perfil, { recursive: true });
  return ambiente;
}

/**
 * As flags, e a razão de cada uma. Nenhuma está aqui "por precaução".
 */
const ARGS_CHROMIUM = [
  // O container não tem privilégios para user namespaces; sem isto o
  // Chromium recusa-se a arrancar como não-root.
  "--no-sandbox",
  "--disable-setuid-sandbox",
  // /dev/shm no Docker tem 64 MB por omissão. Sem isto, uma página
  // grande esgota-o e o renderer morre a meio do PDF.
  "--disable-dev-shm-usage",
  // Não há GPU no container, e tentar usá-la custa arranque.
  "--disable-gpu",
  // O crashpad escreve dumps que ninguém recolhe, e é ele que emite o
  // `--database is required` quando não tem onde escrever. Desligado, a
  // falha de arranque deixa de ter esta causa possível.
  "--disable-crashpad",
  "--disable-breakpad",
];

// ─── Singleton browser ────────────────────────────────────────────────────────

let browserPromise: Promise<Browser> | null = null;
/**
 * Serializa os arranques.
 *
 * Sem isto, dois pedidos de PDF simultâneos com o browser em baixo
 * lançavam DOIS Chromium: o segundo sobrepunha-se ao `browserPromise` do
 * primeiro e o primeiro ficava órfão — um processo zombie por cada
 * corrida em paralelo, a segurar memória até o container reiniciar.
 */
let arranqueEmCurso: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (browserPromise) {
    try {
      const existing = await browserPromise;
      if (existing.connected) return existing;
    } catch {
      // Fall through — reinicia
    }
  }
  if (arranqueEmCurso) return arranqueEmCurso;

  const { home, perfil } = garantirAmbiente();
  arranqueEmCurso = puppeteer
    .launch({
      headless: true,
      // Vazio em desenvolvimento (o puppeteer usa o Chromium que
      // descarregou); em produção vem do Dockerfile,
      // PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium.
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      // O perfil isolado e gravável. Sem isto o puppeteer cria um
      // mkdtemp em os.tmpdir() — que funciona — mas o HOME continuava a
      // não ser gravável e é o HOME que parte o arranque.
      userDataDir: perfil,
      env: {
        ...process.env,
        // A CORRECÇÃO. Ver o cabeçalho deste ficheiro.
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, ".config"),
        XDG_CACHE_HOME: path.join(home, ".cache"),
        TMPDIR: process.env.TMPDIR || tmpdir(),
      },
      args: ARGS_CHROMIUM,
    })
    .then((b) => {
      browserPromise = Promise.resolve(b);
      return b;
    })
    .finally(() => {
      arranqueEmCurso = null;
    });
  return arranqueEmCurso;
}

// Cleanup em shutdown do processo (dev server reload, SIGINT…)
if (typeof process !== "undefined") {
  const close = async () => {
    try {
      if (browserPromise) {
        const b = await browserPromise;
        await b.close();
      }
    } catch {
      /* ignore */
    }
    // O perfil e o HOME são descartáveis: apagá-los evita encher a
    // tmpfs de 256 MB ao fim de muitos reinícios.
    try {
      if (ambiente) rmSync(path.dirname(ambiente.home), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  process.once("beforeExit", close);
}

// ─── Geração do PDF ───────────────────────────────────────────────────────────

export type PdfResult = {
  buffer: Buffer;
  filename: string;
  mime: string;
};

export async function buildReportPdfBuffer(report: Report): Promise<PdfResult> {
  const html = renderReportHtml(report);
  const landscape = report.meta?.orientation === "landscape";

  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.emulateMediaType("print");
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 30_000 });

    const pdfBytes = await page.pdf({
      format: "A4",
      landscape,
      printBackground: true,
      preferCSSPageSize: true,
      margin: {
        top: "10mm",
        right: "8mm",
        bottom: "10mm",
        left: "8mm",
      },
    });

    // puppeteer devolve Uint8Array em versões recentes — normalizar para Buffer
    const buffer = Buffer.isBuffer(pdfBytes) ? pdfBytes : Buffer.from(pdfBytes);

    return {
      buffer,
      filename: makeReportFilename(report, "pdf"),
      mime: "application/pdf",
    };
  } finally {
    await page.close().catch(() => {});
  }
}
