/**
 * lib/encomendas/operacao-consolidacao.ts
 *
 * Estado EXPLÍCITO de uma operação de criação de consolidação, no cliente.
 *
 * Uma chave de idempotência identifica uma INTENÇÃO de criação — não o
 * conteúdo actual do formulário. Depois de uma tentativa cujo resultado o
 * cliente não viu (timeout, ligação perdida, resposta interrompida, refresh,
 * browser fechado), a chave original, o snapshot submetido e a lista de
 * farmácias mantêm-se, e o cliente RECONCILIA junto do servidor antes de
 * qualquer nova tentativa. Nunca há uma chave nova automática: só a decisão
 * explícita do utilizador («Criar novo lote com as alterações») a gera.
 *
 * Estados (`EstadoOperacao`):
 *   NAO_SUBMETIDA           sem operação registada (ausência de registo)
 *   A_SUBMETER              gravada ANTES de enviar; se sobrevive a um refresh
 *                           é porque não se viu a resposta → passa a DESCONHECIDO
 *   RESULTADO_DESCONHECIDO  não se sabe se o servidor fez commit
 *   CONCLUIDA               o servidor tem o lote (criado agora ou recuperado)
 *   NAO_ENCONTRADA          o servidor confirmou que a chave não existe
 *   CONFLITO                a chave existe com outro pedido/utilizador, ou o
 *                           lote está incompleto — bloqueia criação automática
 *
 * O registo persiste por `tenant + utilizador + workspace` em localStorage
 * (sobrevive a refresh e ao fecho do browser). Contém apenas o pedido que o
 * próprio utilizador submeteu (produtos/quantidades/notas) — nenhum segredo.
 */
import type { StorageLike } from "@/lib/workspace/use-workspace-state";

export type EstadoOperacao =
  | "NAO_SUBMETIDA"
  | "A_SUBMETER"
  | "RESULTADO_DESCONHECIDO"
  | "CONCLUIDA"
  | "NAO_ENCONTRADA"
  | "CONFLITO";

export type LinhaSnapshot = {
  produtoId: string;
  quantidadeSugerida: number | null;
  quantidadeAjustada: number;
  notas: string | null;
  origem: "PROPOSTA" | "MANUAL" | "SUGESTAO";
};

export type SnapshotConsolidacao = {
  nome: string;
  finalize: boolean;
  contexto: string | null;
  lotes: Array<{ farmaciaId: string; linhas: LinhaSnapshot[] }>;
};

export type ListaConsolidada = { farmaciaId: string; listaEncomendaId: string };

export type OperacaoConsolidacao = {
  versao: 1;
  estado: Exclude<EstadoOperacao, "NAO_SUBMETIDA">;
  chave: string;
  /** Farmácias do lote ORIGINAL — as chaves por farmácia derivam da chave + estas ids. */
  farmaciaIds: string[];
  /** O que foi realmente submetido (não o formulário actual). */
  snapshot: SnapshotConsolidacao;
  criadoEm: string;
  /** Preenchido em CONCLUIDA. */
  listas?: ListaConsolidada[];
  /** CONCLUIDA por recuperação (o lote já existia) e não por criação nesta sessão. */
  recuperada?: boolean;
  /** CONFLITO: porquê. */
  motivo?: "CHAVE_USADA_POR_OUTRO_PEDIDO" | "LOTE_INCOMPLETO";
};

// ─── Persistência ────────────────────────────────────────────────────────

export function chaveArmazenamentoOperacao(tenant: string, userId: string, workspace: string): string {
  return `spharmmt:consolidacao-pendente:${tenant}:${userId}:${workspace}`;
}

const ESTADOS_VALIDOS = new Set<string>([
  "A_SUBMETER",
  "RESULTADO_DESCONHECIDO",
  "CONCLUIDA",
  "NAO_ENCONTRADA",
  "CONFLITO",
]);

export function lerOperacao(storage: StorageLike | null, chaveLS: string): OperacaoConsolidacao | null {
  try {
    const raw = storage?.getItem(chaveLS);
    if (!raw) return null;
    const o = JSON.parse(raw) as Partial<OperacaoConsolidacao>;
    if (
      o?.versao !== 1 ||
      typeof o.estado !== "string" ||
      !ESTADOS_VALIDOS.has(o.estado) ||
      typeof o.chave !== "string" ||
      !Array.isArray(o.farmaciaIds) ||
      !o.snapshot ||
      !Array.isArray(o.snapshot.lotes)
    ) {
      return null;
    }
    return o as OperacaoConsolidacao;
  } catch {
    return null;
  }
}

export function guardarOperacao(storage: StorageLike | null, chaveLS: string, op: OperacaoConsolidacao): void {
  try {
    storage?.setItem(chaveLS, JSON.stringify(op));
  } catch {
    // Quota/bloqueado: a operação fica só em memória — a chave continua a proteger esta sessão.
  }
}

export function limparOperacao(storage: StorageLike & { removeItem?: (k: string) => void }, chaveLS: string): void {
  try {
    if (storage.removeItem) storage.removeItem(chaveLS);
    else storage.setItem(chaveLS, "");
  } catch {
    // idem
  }
}

// ─── Transições (puras) ──────────────────────────────────────────────────

export function iniciarOperacao(chave: string, snapshot: SnapshotConsolidacao, agora: Date = new Date()): OperacaoConsolidacao {
  return {
    versao: 1,
    estado: "A_SUBMETER",
    chave,
    farmaciaIds: snapshot.lotes.map((l) => l.farmaciaId),
    snapshot,
    criadoEm: agora.toISOString(),
  };
}

/** Um registo `A_SUBMETER` que sobrevive a um refresh significa «enviado, resposta nunca vista». */
export function aoRetomar(op: OperacaoConsolidacao | null): OperacaoConsolidacao | null {
  if (!op) return null;
  return op.estado === "A_SUBMETER" ? { ...op, estado: "RESULTADO_DESCONHECIDO" } : op;
}

export function comoDesconhecida(op: OperacaoConsolidacao): OperacaoConsolidacao {
  return { ...op, estado: "RESULTADO_DESCONHECIDO" };
}

export function comoConcluida(op: OperacaoConsolidacao, listas: ListaConsolidada[], recuperada: boolean): OperacaoConsolidacao {
  return { ...op, estado: "CONCLUIDA", listas, recuperada, motivo: undefined };
}

export function comoConflito(op: OperacaoConsolidacao, motivo: NonNullable<OperacaoConsolidacao["motivo"]>): OperacaoConsolidacao {
  return { ...op, estado: "CONFLITO", motivo };
}

/** O servidor confirmou que a chave não existe: mantém a chave, actualiza o snapshot para o que vai ser reenviado. */
export function comoNaoEncontradaEReenviar(op: OperacaoConsolidacao, snapshot: SnapshotConsolidacao): OperacaoConsolidacao {
  return {
    ...op,
    estado: "A_SUBMETER",
    snapshot,
    farmaciaIds: snapshot.lotes.map((l) => l.farmaciaId),
    listas: undefined,
    recuperada: undefined,
    motivo: undefined,
  };
}

/** Impressão do snapshot, para a UI saber se o formulário mudou desde a submissão. */
export function impressaoSnapshot(s: SnapshotConsolidacao): string {
  return JSON.stringify([
    s.nome,
    s.finalize,
    s.contexto,
    s.lotes.map((l) => [l.farmaciaId, l.linhas.map((x) => [x.produtoId, x.quantidadeSugerida, x.quantidadeAjustada, x.notas, x.origem])]),
  ]);
}

// ─── Orquestração ────────────────────────────────────────────────────────

export type RespostaCriacao =
  | { ok: true; reutilizado: boolean; listas: Array<{ farmaciaId: string; listaEncomendaId: string }> }
  | { ok: false; error: string; code?: "REJEITADO" | "IDEMPOTENCY_CONFLICT" | "ERRO_SERVIDOR" };

export type RespostaEstado =
  | { ok: true; estado: "NAO_ENCONTRADA" }
  | { ok: true; estado: "CONCLUIDA"; listas: Array<{ farmaciaId: string; listaEncomendaId: string }> }
  | { ok: true; estado: "INCONSISTENTE"; encontradas: number; esperadas: number }
  | { ok: true; estado: "CONFLITO" }
  | { ok: false; error: string; code?: string };

export type ApiConsolidacao = {
  /** Pode LANÇAR (transporte) — o resultado é então desconhecido. */
  criar(input: {
    batchKey: string;
    nome: string;
    finalize: boolean;
    contexto: string | null;
    lotes: SnapshotConsolidacao["lotes"];
  }): Promise<RespostaCriacao>;
  reconciliar(input: { batchKey: string; farmaciaIds: string[] }): Promise<RespostaEstado>;
};

export type DepsExecucao = {
  api: ApiConsolidacao;
  storage: (StorageLike & { removeItem?: (k: string) => void }) | null;
  chaveLS: string;
  gerarChave: () => string;
  agora?: () => Date;
};

export type ResultadoExecucao =
  /** Criado agora, nesta chamada. */
  | { tipo: "CRIADA"; op: OperacaoConsolidacao; listas: ListaConsolidada[] }
  /** O servidor JÁ tinha o lote — nada novo foi criado. */
  | { tipo: "RECUPERADA"; op: OperacaoConsolidacao; listas: ListaConsolidada[] }
  /** Recusado antes de escrever (validação/permissão): definitivamente nada gravado. */
  | { tipo: "REJEITADA"; erro: string }
  /** Continua sem se saber (sem comunicação). Nada automático foi criado. */
  | { tipo: "DESCONHECIDO"; op: OperacaoConsolidacao; erro: string }
  /** Conflito/lote incompleto: criação automática bloqueada. */
  | { tipo: "BLOQUEADA"; op: OperacaoConsolidacao; motivo: string };

/**
 * Único ponto por onde o cliente cria uma consolidação. Regras:
 *   · sem operação registada → nova chave, envia;
 *   · operação registada (desconhecida/enviada/não encontrada) → RECONCILIA
 *     primeiro; só reenvia — com a MESMA chave — se o servidor confirmar que
 *     a chave não existe;
 *   · o servidor tem o lote → devolve-o (RECUPERADA); nunca cria outro;
 *   · nova chave só com `novoLoteExplicito` (decisão do utilizador).
 */
export async function executarConsolidacao(
  deps: DepsExecucao,
  snapshot: SnapshotConsolidacao,
  opcoes: { novoLoteExplicito?: boolean } = {}
): Promise<ResultadoExecucao> {
  const agora = deps.agora ?? (() => new Date());
  const persistir = (op: OperacaoConsolidacao) => guardarOperacao(deps.storage, deps.chaveLS, op);
  const esquecer = () => deps.storage && limparOperacao(deps.storage, deps.chaveLS);

  let op = aoRetomar(lerOperacao(deps.storage, deps.chaveLS));

  if (opcoes.novoLoteExplicito || !op) {
    return enviar(iniciarOperacao(deps.gerarChave(), snapshot, agora()));
  }

  if (op.estado === "CONCLUIDA") {
    return { tipo: "RECUPERADA", op, listas: op.listas ?? [] };
  }
  if (op.estado === "CONFLITO") {
    return { tipo: "BLOQUEADA", op, motivo: motivoConflito(op) };
  }

  // A_SUBMETER (já convertido), RESULTADO_DESCONHECIDO ou NAO_ENCONTRADA: reconciliar.
  persistir(op);
  let estado: RespostaEstado;
  try {
    estado = await deps.api.reconciliar({ batchKey: op.chave, farmaciaIds: op.farmaciaIds });
  } catch (err) {
    return { tipo: "DESCONHECIDO", op, erro: msg(err) };
  }
  if (!estado.ok) return { tipo: "DESCONHECIDO", op, erro: estado.error };
  switch (estado.estado) {
    case "CONCLUIDA": {
      op = comoConcluida(op, estado.listas, true);
      persistir(op);
      return { tipo: "RECUPERADA", op, listas: estado.listas };
    }
    case "NAO_ENCONTRADA":
      // O servidor confirmou: nada foi criado. MESMA chave, snapshot actual.
      return enviar(comoNaoEncontradaEReenviar(op, snapshot));
    case "INCONSISTENTE":
      op = comoConflito(op, "LOTE_INCOMPLETO");
      persistir(op);
      return { tipo: "BLOQUEADA", op, motivo: motivoConflito(op) };
    case "CONFLITO":
      op = comoConflito(op, "CHAVE_USADA_POR_OUTRO_PEDIDO");
      persistir(op);
      return { tipo: "BLOQUEADA", op, motivo: motivoConflito(op) };
  }

  async function enviar(o: OperacaoConsolidacao): Promise<ResultadoExecucao> {
    // Gravada ANTES de enviar: se o browser morrer a meio, o registo diz que houve um envio.
    persistir(o);
    let r: RespostaCriacao;
    try {
      r = await deps.api.criar({
        batchKey: o.chave,
        nome: o.snapshot.nome,
        finalize: o.snapshot.finalize,
        contexto: o.snapshot.contexto,
        lotes: o.snapshot.lotes,
      });
    } catch (err) {
      const desc = comoDesconhecida(o);
      persistir(desc);
      return { tipo: "DESCONHECIDO", op: desc, erro: msg(err) };
    }
    if (r.ok) {
      const feita = comoConcluida(o, r.listas, r.reutilizado);
      if (r.reutilizado) {
        persistir(feita);
        return { tipo: "RECUPERADA", op: feita, listas: r.listas };
      }
      esquecer(); // criada agora: o utilizador segue para as encomendas, nada pendente
      return { tipo: "CRIADA", op: feita, listas: r.listas };
    }
    if (r.code === "REJEITADO") {
      esquecer();
      return { tipo: "REJEITADA", erro: r.error };
    }
    if (r.code === "IDEMPOTENCY_CONFLICT") {
      // Provavelmente o envio original chegou depois: reconciliar antes de concluir seja o que for.
      const marcada = comoConflito(o, "CHAVE_USADA_POR_OUTRO_PEDIDO");
      try {
        const e = await deps.api.reconciliar({ batchKey: o.chave, farmaciaIds: o.farmaciaIds });
        if (e.ok && e.estado === "CONCLUIDA") {
          const rec = comoConcluida(o, e.listas, true);
          persistir(rec);
          return { tipo: "RECUPERADA", op: rec, listas: e.listas };
        }
      } catch {
        // fica bloqueada abaixo
      }
      persistir(marcada);
      return { tipo: "BLOQUEADA", op: marcada, motivo: motivoConflito(marcada) };
    }
    // ERRO_SERVIDOR ou erro sem código: o commit pode ter acontecido.
    const desc = comoDesconhecida(o);
    persistir(desc);
    return { tipo: "DESCONHECIDO", op: desc, erro: r.error };
  }
}

/** Só reconcilia (leitura) — usado ao montar o ecrã depois de um refresh. */
export async function reconciliarPendente(deps: DepsExecucao): Promise<ResultadoExecucao | null> {
  const op = aoRetomar(lerOperacao(deps.storage, deps.chaveLS));
  if (!op) return null;
  if (op.estado === "CONCLUIDA") return { tipo: "RECUPERADA", op, listas: op.listas ?? [] };
  if (op.estado === "CONFLITO") return { tipo: "BLOQUEADA", op, motivo: motivoConflito(op) };
  guardarOperacao(deps.storage, deps.chaveLS, op);
  let estado: RespostaEstado;
  try {
    estado = await deps.api.reconciliar({ batchKey: op.chave, farmaciaIds: op.farmaciaIds });
  } catch (err) {
    return { tipo: "DESCONHECIDO", op, erro: msg(err) };
  }
  if (!estado.ok) return { tipo: "DESCONHECIDO", op, erro: estado.error };
  if (estado.estado === "CONCLUIDA") {
    const rec = comoConcluida(op, estado.listas, true);
    guardarOperacao(deps.storage, deps.chaveLS, rec);
    return { tipo: "RECUPERADA", op: rec, listas: estado.listas };
  }
  if (estado.estado === "NAO_ENCONTRADA") {
    // O servidor confirma que nada foi criado: a operação pendente já não protege nada.
    const nao = { ...op, estado: "NAO_ENCONTRADA" as const };
    guardarOperacao(deps.storage, deps.chaveLS, nao);
    return { tipo: "DESCONHECIDO", op: nao, erro: "O servidor confirma que o lote anterior não foi criado — pode tentar de novo." };
  }
  const c = comoConflito(op, estado.estado === "INCONSISTENTE" ? "LOTE_INCOMPLETO" : "CHAVE_USADA_POR_OUTRO_PEDIDO");
  guardarOperacao(deps.storage, deps.chaveLS, c);
  return { tipo: "BLOQUEADA", op: c, motivo: motivoConflito(c) };
}

export function motivoConflito(op: OperacaoConsolidacao): string {
  return op.motivo === "LOTE_INCOMPLETO"
    ? "Só parte do lote anterior existe no servidor. Não crie outro lote: contacte o suporte com esta referência: " + op.chave.slice(0, 8)
    : "Esta operação já existe no servidor com outro conteúdo. Não foi criado nada de novo.";
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : "Sem comunicação com o servidor.";
}
