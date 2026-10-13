/**
 * lib/regulamentar/infarmed-job.ts
 *
 * Obtenção do ficheiro do INFARMED (uma vez por execução, para todos os
 * tenants). Duas formas, por esta ordem:
 *
 *   1. `INFARMED_ALLPACKAGES_URL` definido → GET direto a esse endereço https
 *      (permite apontar a outro sítio ou a um espelho, e substitui o portal);
 *   2. caso contrário → o formulário público «Pesquisa do medicamento»
 *      (`infarmed-jsf.ts`): GET para obter cookies+ViewState e POST do botão
 *      de exportar, em HTTP simples, sem browser nem credenciais.
 *
 * Em ambos os casos o resultado passa por `validarAssinatura` aqui e por
 * `lerFicheiroInfarmed` no orquestrador (folha, 13 colunas, limites).
 * A orquestração por tenant, o ledger e os emails estão em
 * `infarmed-atualizacao.ts`.
 */

import { FicheiroInfarmedInvalido, LIMITE_BYTES, validarAssinatura } from "./infarmed-ficheiro";
import {
  DownloadInfarmedFalhou,
  descarregarViaFormulario,
  nomeDoFicheiro,
  type FetchLike,
  type OpcoesJsf,
} from "./infarmed-jsf";

export { DownloadInfarmedFalhou, type FetchLike } from "./infarmed-jsf";

export type FicheiroObtido = { buffer: Buffer; nomeFicheiro: string | null; url: string };

/** GET direto a um URL https que devolve o ficheiro (override por INFARMED_ALLPACKAGES_URL). */
export async function descarregarInfarmed(
  url: string,
  opcoes: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<Buffer> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new DownloadInfarmedFalhou("URL", "INFARMED_ALLPACKAGES_URL não é um URL válido.");
  }
  if (u.protocol !== "https:") throw new DownloadInfarmedFalhou("URL", "O URL tem de ser https.");
  const f: FetchLike = opcoes.fetchImpl ?? ((x, init) => fetch(x, init as RequestInit) as ReturnType<FetchLike>);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opcoes.timeoutMs ?? 120_000);
  try {
    const res = await f(u.toString(), { method: "GET", signal: ctrl.signal, headers: { "user-agent": "SPharmMT-regulamentar/1.0" } });
    if (!res.ok) throw new DownloadInfarmedFalhou("HTTP", `Resposta HTTP ${res.status}.`);
    const tipo = (res.headers.get("content-type") ?? "").toLowerCase();
    if (tipo.includes("text/html") || tipo.includes("text/plain") || tipo.includes("json")) {
      throw new DownloadInfarmedFalhou("TIPO", `Content-Type inesperado: ${tipo}.`);
    }
    const declarado = Number(res.headers.get("content-length") ?? "0");
    if (declarado > LIMITE_BYTES) throw new DownloadInfarmedFalhou("TIPO", `Content-Length ${declarado} acima do limite.`);
    const buf = Buffer.from(await res.arrayBuffer());
    validarAssinatura(buf); // vazio, HTML, tamanho, assinatura OLE2
    return buf;
  } catch (e) {
    if (e instanceof DownloadInfarmedFalhou || e instanceof FicheiroInfarmedInvalido) throw e;
    if (e instanceof Error && e.name === "AbortError") throw new DownloadInfarmedFalhou("TIMEOUT", "O download excedeu o tempo limite.");
    throw new DownloadInfarmedFalhou("REDE", e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }
}

export type OpcoesObter = OpcoesJsf & {
  /** INFARMED_ALLPACKAGES_URL (se definido, substitui o portal). */
  urlDireto?: string | null;
};

/** Obtém o ficheiro (override direto ou formulário público). Lança DownloadInfarmedFalhou/FicheiroInfarmedInvalido. */
export async function obterFicheiroInfarmed(opcoes: OpcoesObter = {}): Promise<FicheiroObtido> {
  const direto = opcoes.urlDireto?.trim();
  if (direto) {
    const buffer = await descarregarInfarmed(direto, { fetchImpl: opcoes.fetchImpl, timeoutMs: opcoes.timeoutMs });
    return { buffer, nomeFicheiro: nomeDoFicheiro(null) ?? new URL(direto).pathname.split("/").pop() ?? null, url: direto };
  }
  return descarregarViaFormulario(opcoes);
}
