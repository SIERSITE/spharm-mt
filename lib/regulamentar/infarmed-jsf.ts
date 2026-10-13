/**
 * lib/regulamentar/infarmed-jsf.ts
 *
 * Download do ficheiro «allPackages» do INFARMED por HTTP simples, SEM
 * browser, SEM credenciais e SEM valores de sessão fixos.
 *
 * O portal público «Pesquisa do medicamento» (o iframe do INFARMED)
 *
 *     https://extranet.infarmed.pt/CITS-pesquisamedicamento-fo/pesquisaMedicamento.jsf
 *
 * cria sozinho uma sessão HTTP anónima (cookie JSESSIONID) e um `ViewState` no
 * 1.º GET; o botão `form:export-all-button` é um `type="submit"` que faz o POST
 * do formulário e devolve `allPackages.xls` (Excel 97-2003). Este módulo faz
 * exatamente isso: GET → recolhe cookies e campos do formulário (incluindo o
 * ViewState) → POST com o botão na mesma sessão.
 *
 * Deliberadamente simples: se a estrutura da página mudar (formulário ou botão
 * em falta, resposta que não é Excel), falha com um erro claro. NÃO tenta
 * contornar o portal — a atualização falha, a versão ativa fica intacta, é
 * enviado o email e o ficheiro pode ser carregado à mão em /admin/infarmed.
 *
 * O portal responde por vezes `503` (balanceador); tenta-se um número pequeno
 * de vezes, com espera crescente, e só nesses casos (5xx/rede).
 */

import { FicheiroInfarmedInvalido, validarAssinatura } from "./infarmed-ficheiro";

export const PESQUISA_URL_OMISSAO =
  "https://extranet.infarmed.pt/CITS-pesquisamedicamento-fo/pesquisaMedicamento.jsf";
export const BOTAO_EXPORTAR = "form:export-all-button";

export type CodigoDownload = "HTTP" | "TIPO" | "TIMEOUT" | "REDE" | "URL" | "ESTRUTURA";

export class DownloadInfarmedFalhou extends Error {
  constructor(
    public readonly codigo: CodigoDownload,
    mensagem: string,
  ) {
    super(mensagem);
    this.name = "DownloadInfarmedFalhou";
  }
}

export type FetchLike = (
  url: string,
  init?: {
    method?: "GET" | "POST";
    body?: string;
    signal?: AbortSignal;
    headers?: Record<string, string>;
    redirect?: "follow" | "manual";
  },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null; getSetCookie?: () => string[] };
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}>;

const UA = "Mozilla/5.0 (compatible; SPharmMT-regulamentar/1.0)";

export type OpcoesJsf = {
  urlPagina?: string;
  fetchImpl?: FetchLike;
  tentativas?: number;
  /** Espera entre tentativas (ms, multiplicada pelo nº da tentativa). Injetável nos testes. */
  esperaMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function atributo(tag: string, nome: string): string | null {
  const m = new RegExp(`\\b${nome}="([^"]*)"`, "i").exec(tag);
  return m ? decodeHtml(m[1]) : null;
}

export type FormularioJsf = { action: string; campos: Array<[string, string]> };

/**
 * Extrai o formulário que contém o botão de exportar: ação, TODOS os campos
 * (hidden, texto, selects) com o valor que a página já traz — incluindo o
 * `javax.faces.ViewState` — e o próprio botão. Falha se a estrutura mudou.
 */
export function extrairFormulario(html: string, base: string, botao = BOTAO_EXPORTAR): FormularioJsf {
  const formRe = /<form\b[^>]*>[\s\S]*?<\/form>/gi;
  let formHtml: string | null = null;
  for (const m of html.matchAll(formRe)) {
    if (m[0].includes(`name="${botao}"`)) {
      formHtml = m[0];
      break;
    }
  }
  if (!formHtml) {
    throw new DownloadInfarmedFalhou("ESTRUTURA", `A página já não tem o formulário com o botão «${botao}».`);
  }
  const abre = /<form\b[^>]*>/i.exec(formHtml)![0];
  const action = atributo(abre, "action");
  if (!action) throw new DownloadInfarmedFalhou("ESTRUTURA", "O formulário não tem atributo action.");

  const campos: Array<[string, string]> = [];
  for (const m of formHtml.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0];
    const nome = atributo(tag, "name");
    if (!nome) continue;
    const tipo = (atributo(tag, "type") ?? "text").toLowerCase();
    if (["button", "submit", "image", "file", "reset"].includes(tipo)) continue;
    if ((tipo === "checkbox" || tipo === "radio") && !/\bchecked\b/i.test(tag)) continue;
    campos.push([nome, atributo(tag, "value") ?? ""]);
  }
  for (const m of formHtml.matchAll(/<select\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/gi)) {
    const nome = decodeHtml(m[1]);
    const opcoes = [...m[2].matchAll(/<option\b[^>]*>/gi)].map((o) => o[0]);
    const escolhida = opcoes.find((o) => /\bselected\b/i.test(o)) ?? opcoes[0];
    campos.push([nome, escolhida ? (atributo(escolhida, "value") ?? "") : ""]);
  }
  if (!campos.some(([n]) => n === "javax.faces.ViewState")) {
    throw new DownloadInfarmedFalhou("ESTRUTURA", "O formulário já não traz o javax.faces.ViewState.");
  }
  const tagBotao = [...formHtml.matchAll(/<button\b[^>]*>/gi)].map((b) => b[0]).find((b) => atributo(b, "name") === botao);
  campos.push([botao, tagBotao ? (atributo(tagBotao, "value") ?? "") : ""]);
  return { action: new URL(decodeHtml(action), base).toString(), campos };
}

function guardarCookies(jar: Map<string, string>, res: { headers: { getSetCookie?: () => string[] } }) {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [kv] = c.split(";");
    const i = kv.indexOf("=");
    if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
  }
}

const cabecalhoCookies = (jar: Map<string, string>) => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

export function nomeDoFicheiro(contentDisposition: string | null): string | null {
  if (!contentDisposition) return null;
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(contentDisposition);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]).replace(/[^\w.\- ]/g, "_").slice(0, 120);
  } catch {
    return m[1].replace(/[^\w.\- ]/g, "_").slice(0, 120);
  }
}

/** Faz uma tentativa de GET+POST. 5xx/rede → erro retentável; o resto → definitivo. */
async function umaTentativa(
  f: FetchLike,
  urlPagina: string,
  timeoutMs: number,
): Promise<{ buffer: Buffer; nomeFicheiro: string | null }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const jar = new Map<string, string>();
    const r1 = await f(urlPagina, { method: "GET", signal: ctrl.signal, headers: { "user-agent": UA, accept: "text/html", "accept-language": "pt-PT" } });
    guardarCookies(jar, r1);
    if (!r1.ok) throw new DownloadInfarmedFalhou("HTTP", `A página do portal respondeu HTTP ${r1.status}.`);
    const form = extrairFormulario(await r1.text(), urlPagina);

    const r2 = await f(form.action, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "user-agent": UA,
        cookie: cabecalhoCookies(jar),
        "content-type": "application/x-www-form-urlencoded",
        referer: urlPagina,
        origin: new URL(urlPagina).origin,
      },
      body: new URLSearchParams(form.campos).toString(),
    });
    if (!r2.ok) throw new DownloadInfarmedFalhou("HTTP", `O pedido de exportação respondeu HTTP ${r2.status}.`);
    const tipo = (r2.headers.get("content-type") ?? "").toLowerCase();
    if (tipo.includes("html") || tipo.includes("json") || tipo.startsWith("text/")) {
      throw new DownloadInfarmedFalhou("TIPO", `A exportação devolveu «${tipo}» em vez de um ficheiro Excel.`);
    }
    const buffer = Buffer.from(await r2.arrayBuffer());
    validarAssinatura(buffer); // vazio, HTML, tamanho, assinatura OLE2
    return { buffer, nomeFicheiro: nomeDoFicheiro(r2.headers.get("content-disposition")) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Descarrega o ficheiro pelo formulário público. Tenta até `tentativas` vezes
 * SÓ perante falhas transitórias (HTTP 5xx, rede, timeout); erros estruturais
 * (formulário mudou, resposta não é Excel) falham logo.
 */
export async function descarregarViaFormulario(opcoes: OpcoesJsf = {}): Promise<{ buffer: Buffer; nomeFicheiro: string | null; url: string }> {
  const urlPagina = opcoes.urlPagina ?? PESQUISA_URL_OMISSAO;
  let u: URL;
  try {
    u = new URL(urlPagina);
  } catch {
    throw new DownloadInfarmedFalhou("URL", "O endereço do portal não é um URL válido.");
  }
  if (u.protocol !== "https:") throw new DownloadInfarmedFalhou("URL", "O endereço do portal tem de ser https.");
  const f: FetchLike = opcoes.fetchImpl ?? ((x, init) => fetch(x, init as RequestInit) as ReturnType<FetchLike>);
  const tentativas = Math.max(1, opcoes.tentativas ?? 5);
  const espera = opcoes.esperaMs ?? 4000;
  const dormir = opcoes.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let ultimo: unknown = null;
  for (let i = 1; i <= tentativas; i++) {
    try {
      const r = await umaTentativa(f, urlPagina, opcoes.timeoutMs ?? 120_000);
      return { ...r, url: urlPagina };
    } catch (e) {
      ultimo = e;
      const transitorio =
        (e instanceof DownloadInfarmedFalhou && e.codigo === "HTTP" && /HTTP 5\d\d/.test(e.message)) ||
        (!(e instanceof DownloadInfarmedFalhou) && !(e instanceof FicheiroInfarmedInvalido));
      if (!transitorio || i === tentativas) break;
      await dormir(espera * i);
    }
  }
  if (ultimo instanceof DownloadInfarmedFalhou || ultimo instanceof FicheiroInfarmedInvalido) throw ultimo;
  if (ultimo instanceof Error && ultimo.name === "AbortError") throw new DownloadInfarmedFalhou("TIMEOUT", "O download excedeu o tempo limite.");
  throw new DownloadInfarmedFalhou("REDE", ultimo instanceof Error ? ultimo.message : String(ultimo));
}
