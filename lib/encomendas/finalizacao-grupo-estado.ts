/**
 * lib/encomendas/finalizacao-grupo-estado.ts
 *
 * Estados e regras PURAS da finalização de Encomendas (modo Grupo, e a
 * preparação dos documentos de qualquer modo). Sem React, sem rede — testável
 * em Node.
 *
 * ── O defeito que isto fecha ─────────────────────────────────────────────
 *
 * A finalização do grupo vivia dentro de `useTransition(async …)`, e a
 * preparação dos documentos abria OUTRA transição aninhada, com
 * `setCarregandoResultado(true)` e o `false` só no caminho feliz. Três
 * consequências, todas reproduzidas em browser (scripts/e2e/
 * encomendas-grupo-finalizacao-browser.ts):
 *
 *   1. uma rejeição da Server Action de documentos (rede, 5xx, erro de
 *      serialização) saltava o `setCarregandoResultado(false)` — o overlay
 *      «A preparar os documentos…» (fixed inset-0, z-50) ficava para sempre
 *      por cima do ecrã, sem mensagem;
 *   2. um erro de `gerarPlanoGrupoAction` mostrava a mensagem num `flash`
 *      que está ATRÁS do modal (z-50): o utilizador via só o modal, sem
 *      explicação;
 *   3. `gerandoPlano` e a transição de documentos ficam emaranhadas pelo
 *      React (transições assíncronas concorrentes partilham o estado
 *      pendente), pelo que a lentidão/falha dos documentos mantinha o modal
 *      em «A finalizar…».
 *
 * ── A máquina de estados ─────────────────────────────────────────────────
 *
 *   FINALIZAÇÃO (persistência — encomendas e transferências)
 *     inativo ──confirmar──▶ persistindo ──ok──▶ inativo  (e inicia DOCUMENTOS)
 *                               │
 *                               └──erro/rejeição──▶ erro  (modal aberto, desbloqueado;
 *                                                          «Tentar de novo» REUSA as chaves
 *                                                          de idempotência ⇒ nunca duplica)
 *
 *   DOCUMENTOS (só leitura do que já foi persistido)
 *     — ──preparar──▶ a-preparar ──ok──▶ resultado
 *                         │
 *                         └──erro/rejeição──▶ erro  (finalização JÁ concluída; painel com
 *                                                    «Tentar preparar documentos novamente»
 *                                                    e «Concluir»; usa só os ids guardados)
 *
 * Cada transição liberta o seu estado «ocupado» num `finally`. A finalização
 * e os documentos são fases DIFERENTES: a segunda nunca repete a primeira.
 */

/** Pedido de preparação dos documentos: só ids já persistidos. */
export type PedidoDocumentos = {
  listaEncomendaIds: string[];
  transferenciaIds: string[];
  incluirConsolidado?: boolean;
  /** Chave de correlação dos logs (a mesma da finalização). */
  correlacaoId?: string;
};

/** Documentos pendentes: o que foi finalizado + o último erro (se houve). */
export type DocumentosPendentes = PedidoDocumentos & { erro: string | null };

/** Fase da finalização persistente do grupo. */
export type FaseFinalizacaoGrupo =
  | { tipo: "inativo" }
  | { tipo: "persistindo"; correlacaoId: string }
  | { tipo: "erro"; mensagem: string };

/** Depois deste tempo sem resposta, a UI avisa (sem repetir nem desbloquear a operação em silêncio). */
export const TEMPO_AVISO_DEMORA_MS = 45_000;

export const CHAVE_SESSAO_DOCUMENTOS_PENDENTES = "spharm.encomendas.documentosPendentes.v1";
/** Um pedido guardado há mais do que isto já não é recuperado. */
export const VALIDADE_PENDENTE_MS = 24 * 60 * 60 * 1000;

/** Mensagem legível para QUALQUER coisa que possa ser lançada (Error, string, rejeição de rede). */
export function mensagemDeErro(e: unknown): string {
  if (e instanceof Error && e.message.trim() !== "") return e.message;
  if (typeof e === "string" && e.trim() !== "") return e;
  return "falha de comunicação com o servidor";
}

export function mensagemErroFinalizacaoInesperado(e: unknown): string {
  return (
    `Não foi possível confirmar a finalização (${mensagemDeErro(e)}). ` +
    "Pode tentar novamente: a operação é idempotente e não duplica encomendas nem transferências."
  );
}

/** Chaves de idempotência de UMA tentativa de finalização — reutilizadas nos «tentar de novo». */
export type ChavesFinalizacaoGrupo = { encomendaBatchKey: string; transferenciaBatchKey: string };

export function novasChavesFinalizacaoGrupo(uuid: () => string): ChavesFinalizacaoGrupo {
  return { encomendaBatchKey: uuid().replace(/-/g, ""), transferenciaBatchKey: uuid().replace(/-/g, "") };
}

type Armazem = Pick<Storage, "getItem" | "setItem" | "removeItem">;

type Guardado = PedidoDocumentos & { guardadoEm: number };

/** Guarda (best-effort) o que já foi persistido, para sobreviver a um refresh antes dos documentos. */
export function guardarDocumentosPendentes(armazem: Armazem | null, pedido: PedidoDocumentos, agora = Date.now()): void {
  if (!armazem) return;
  try {
    const v: Guardado = { ...pedido, guardadoEm: agora };
    armazem.setItem(CHAVE_SESSAO_DOCUMENTOS_PENDENTES, JSON.stringify(v));
  } catch {
    /* sessionStorage indisponível/cheio: a recuperação é um extra, nunca bloqueia */
  }
}

export function limparDocumentosPendentes(armazem: Armazem | null): void {
  if (!armazem) return;
  try {
    armazem.removeItem(CHAVE_SESSAO_DOCUMENTOS_PENDENTES);
  } catch {
    /* idem */
  }
}

const ehIds = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0 && x.length <= 64);

/** Lê o pedido guardado; `null` se não existe, expirou, está corrompido ou não tem nada a preparar. */
export function lerDocumentosPendentes(armazem: Armazem | null, agora = Date.now()): PedidoDocumentos | null {
  if (!armazem) return null;
  try {
    const bruto = armazem.getItem(CHAVE_SESSAO_DOCUMENTOS_PENDENTES);
    if (!bruto) return null;
    const v = JSON.parse(bruto) as Partial<Guardado>;
    if (!ehIds(v.listaEncomendaIds) || !ehIds(v.transferenciaIds)) return null;
    if (typeof v.guardadoEm !== "number" || agora - v.guardadoEm > VALIDADE_PENDENTE_MS || agora < v.guardadoEm - 60_000) return null;
    if (v.listaEncomendaIds.length === 0 && v.transferenciaIds.length === 0) return null;
    return {
      listaEncomendaIds: v.listaEncomendaIds,
      transferenciaIds: v.transferenciaIds,
      incluirConsolidado: v.incluirConsolidado === true,
      correlacaoId: typeof v.correlacaoId === "string" ? v.correlacaoId.slice(0, 64) : undefined,
    };
  } catch {
    return null;
  }
}
