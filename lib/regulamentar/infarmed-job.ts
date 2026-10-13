/**
 * lib/regulamentar/infarmed-job.ts
 *
 * Descarga + validação + aplicação MENSAL do ficheiro do INFARMED, para todos
 * os tenants. Centralizado na plataforma (worker/scheduler): não depende dos
 * agents das farmácias.
 *
 * O URL NÃO está fixo no código: vem de `INFARMED_ALLPACKAGES_URL`. A seta
 * «Exportar para Excel» do portal público é um formulário JSF com sessão e
 * `ViewState` (não um ficheiro estático) — ver `notes/infarmed-regulamentar.md`.
 * Sem URL configurado o job devolve NAO_CONFIGURADO e não toca em nada.
 *
 * Ordem: descarregar → validar (assinatura, folha, 13 colunas, limites) →
 * por tenant, aplicar numa transação. Qualquer falha antes da aplicação deixa
 * TODOS os tenants com a versão anterior intacta.
 */

import { createHash } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import {
  FicheiroInfarmedInvalido,
  LIMITE_BYTES,
  lerFicheiroInfarmed,
  validarAssinatura,
  type FicheiroInfarmedLido,
} from "./infarmed-ficheiro";
import { aplicarVersaoInfarmed, type RelatorioImportacao } from "./infarmed-aplicar";

export class DownloadInfarmedFalhou extends Error {
  constructor(
    public readonly codigo: "HTTP" | "TIPO" | "TIMEOUT" | "REDE" | "URL",
    mensagem: string,
  ) {
    super(mensagem);
    this.name = "DownloadInfarmedFalhou";
  }
}

export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

/** Descarrega e valida o formato (ainda sem ler o conteúdo). */
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
  const f: FetchLike = opcoes.fetchImpl ?? ((x, init) => fetch(x, init as RequestInit));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opcoes.timeoutMs ?? 120_000);
  try {
    const res = await f(u.toString(), { signal: ctrl.signal, headers: { "user-agent": "SPharmMT-regulamentar/1.0" } });
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

export type TenantAlvo = { slug: string; prisma: PrismaClient };

export type ResultadoJob = {
  estado: "NAO_CONFIGURADO" | "FALHA_DOWNLOAD" | "FALHA_VALIDACAO" | "CONCLUIDO";
  erro?: string;
  sha256?: string;
  linhasLidas?: number;
  tenants: Array<{
    slug: string;
    resultado?: RelatorioImportacao["resultado"];
    importacaoId?: string | null;
    motivo?: string;
    erro?: string;
  }>;
};

async function registarFalha(prisma: PrismaClient, url: string, sha256: string, erro: string, origem: "MENSAL" | "MANUAL") {
  await prisma.infarmedImportacao.create({
    data: {
      origem,
      urlOrigem: url,
      sha256,
      descarregadoEm: new Date(),
      estado: "FALHADA",
      ativa: false,
      erro: erro.slice(0, 1000),
      terminadaEm: new Date(),
    },
  });
}

export async function executarAtualizacaoInfarmed(opcoes: {
  url: string | null | undefined;
  tenants: TenantAlvo[];
  apply: boolean;
  origem?: "MENSAL" | "MANUAL";
  forcar?: boolean;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  log?: (msg: string) => void;
}): Promise<ResultadoJob> {
  const log = opcoes.log ?? (() => undefined);
  const origem = opcoes.origem ?? "MENSAL";
  if (!opcoes.url) {
    log("[infarmed] INFARMED_ALLPACKAGES_URL não configurado — nada a fazer");
    return { estado: "NAO_CONFIGURADO", tenants: [] };
  }
  const url = opcoes.url;

  let buf: Buffer;
  try {
    buf = await descarregarInfarmed(url, { fetchImpl: opcoes.fetchImpl, timeoutMs: opcoes.timeoutMs });
  } catch (e) {
    const erro = e instanceof Error ? e.message : String(e);
    log(`[infarmed] download/validação falhou: ${erro}`);
    if (opcoes.apply) {
      for (const t of opcoes.tenants) await registarFalha(t.prisma, url, "-", `download: ${erro}`, origem).catch(() => undefined);
    }
    return { estado: "FALHA_DOWNLOAD", erro, tenants: [] };
  }

  let ficheiro: FicheiroInfarmedLido;
  try {
    ficheiro = lerFicheiroInfarmed(buf);
  } catch (e) {
    const erro = e instanceof Error ? e.message : String(e);
    log(`[infarmed] ficheiro inválido: ${erro}`);
    const sha = createHash("sha256").update(buf).digest("hex");
    if (opcoes.apply) {
      for (const t of opcoes.tenants) await registarFalha(t.prisma, url, sha, `validação: ${erro}`, origem).catch(() => undefined);
    }
    return { estado: "FALHA_VALIDACAO", erro, sha256: sha, tenants: [] };
  }

  const tenants: ResultadoJob["tenants"] = [];
  for (const t of opcoes.tenants) {
    try {
      const rel = await aplicarVersaoInfarmed(t.prisma, ficheiro, {
        origem,
        apply: opcoes.apply,
        urlOrigem: url,
        forcar: opcoes.forcar,
        minimoRelativoLinhas: 0.5,
      });
      tenants.push({ slug: t.slug, resultado: rel.resultado, importacaoId: rel.importacaoId, motivo: rel.motivo });
      log(`[infarmed] ${t.slug}: ${rel.resultado}${rel.motivo ? ` (${rel.motivo})` : ""}`);
    } catch (e) {
      tenants.push({ slug: t.slug, erro: e instanceof Error ? e.message : String(e) });
      log(`[infarmed] ${t.slug}: erro ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { estado: "CONCLUIDO", sha256: ficheiro.sha256, linhasLidas: ficheiro.linhasLidas, tenants };
}
