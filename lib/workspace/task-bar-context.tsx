"use client";

/**
 * lib/workspace/task-bar-context.tsx
 *
 * Barra de tarefas internas — navegação da aplicação, NUNCA um
 * substituto da persistência de dados (ver lib/encomendas/autosave.ts
 * para essa camada). Permite alternar entre vários contextos de
 * trabalho (Vendas, uma encomenda concreta, etc.) sem depender de
 * separadores do browser, Ctrl+clique ou várias janelas.
 *
 * ── Isolamento ───────────────────────────────────────────────────────
 * A lista de tarefas é guardada em localStorage, sob uma chave
 * prefixada por tenant+utilizador — nunca atravessa tenant nem
 * utilizador, mesmo que o mesmo browser aceda a subdomínios diferentes.
 * É PURO metadado de navegação (id, título, tipo, href, sujo): nunca
 * quantidades, preços nem nenhum dado de negócio — esses vivem sempre
 * no servidor (ListaEncomenda/LinhaEncomenda), nunca só aqui. Se a
 * lista visual não puder ser recuperada (localStorage bloqueado,
 * privado, quota excedida), a aplicação continua a funcionar
 * perfeitamente por navegação normal — só perde a barra, nunca dados.
 *
 * ── Instanciado no layout raiz ──────────────────────────────────────
 * Ao contrário da `AppShell` (renderizada de novo por cada página,
 * server ou client), o `RootLayout` é partilhado por TODAS as rotas —
 * é o único sítio onde o estado sobrevive a uma navegação Next.js.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Tarefa = {
  id: string;
  titulo: string;
  tipo: string;
  href: string;
  /** Há alterações locais/no ecrã que ainda não estão confirmadas no servidor. */
  sujo: boolean;
};

const MAX_TAREFAS = 14;

type EstadoPersistido = { tarefas: Tarefa[]; activaId: string | null };

function chave(tenant: string, userId: string): string {
  return `spharmmt:task-bar:${tenant}:${userId}`;
}

function ler(chaveLS: string): EstadoPersistido | null {
  try {
    const raw = window.localStorage.getItem(chaveLS);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as EstadoPersistido;
    if (!Array.isArray(parsed.tarefas)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function escrever(chaveLS: string, estado: EstadoPersistido): void {
  try {
    window.localStorage.setItem(chaveLS, JSON.stringify(estado));
  } catch {
    // Quota excedida/bloqueado — a barra fica só em memória nesta sessão.
  }
}

type ContextoTaskBar = {
  tarefas: Tarefa[];
  activaId: string | null;
  /** Regista ou activa uma tarefa existente com o mesmo id — actualiza título/href se já existir. */
  abrirOuActivar: (tarefa: Omit<Tarefa, "sujo">) => void;
  /** Cria sempre uma tarefa NOVA (id distinto), mesmo que o href coincida com outra já aberta — "nova análise do mesmo módulo". */
  abrirNova: (tarefa: Omit<Tarefa, "sujo" | "id">) => string;
  fechar: (id: string) => void;
  marcarSujo: (id: string, sujo: boolean) => void;
  actualizarTitulo: (id: string, titulo: string) => void;
};

const Contexto = createContext<ContextoTaskBar | null>(null);

export function TaskBarProvider({
  tenant,
  userId,
  children,
}: {
  tenant: string | null;
  userId: string | null;
  children: ReactNode;
}) {
  const chaveLS = tenant && userId ? chave(tenant, userId) : null;
  // Um ÚNICO state para tarefas+activaId — nunca duas chamadas setState
  // seguidas dentro do mesmo efeito/callback (cascading renders), e a
  // persistência em localStorage fica sempre a escrever exactamente o
  // que acabou de ser calculado, nunca dois valores desincronizados.
  const [estado, setEstado] = useState<EstadoPersistido>({ tarefas: [], activaId: null });
  const { tarefas, activaId } = estado;

  useEffect(() => {
    if (!chaveLS) return;
    const persistido = ler(chaveLS);
    // localStorage é uma fonte externa só-de-cliente — indisponível no
    // primeiro render (SSR) por definição. O estado inicial ({tarefas:
    // [], activaId: null}) tem de ser IDÊNTICO em servidor e cliente
    // para a hidratação não desalinhar; ler e sincronizar só pode
    // acontecer DEPOIS de montado. Isto é exactamente o caso são
    // (sincronizar de um sistema externo) que a própria regra
    // react-hooks/set-state-in-effect documenta como legítimo — só não
    // tem excepção automática para "uma leitura pontual no mount".
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (persistido) setEstado(persistido);
  }, [chaveLS]);

  useEffect(() => {
    if (!chaveLS) return;
    escrever(chaveLS, estado);
  }, [chaveLS, estado]);

  const abrirOuActivar = useCallback((tarefa: Omit<Tarefa, "sujo">) => {
    setEstado((prev) => {
      const existente = prev.tarefas.find((t) => t.id === tarefa.id);
      const tarefas = existente
        ? prev.tarefas.map((t) => (t.id === tarefa.id ? { ...t, titulo: tarefa.titulo, href: tarefa.href } : t))
        : (() => {
            const nova: Tarefa = { ...tarefa, sujo: false };
            const seguintes = [...prev.tarefas, nova];
            // Evicção: quando ultrapassa o tecto, remove a mais antiga SEM
            // alterações pendentes — nunca fecha uma tarefa suja silenciosamente.
            if (seguintes.length > MAX_TAREFAS) {
              const idx = seguintes.findIndex((t) => !t.sujo && t.id !== tarefa.id);
              if (idx >= 0) seguintes.splice(idx, 1);
            }
            return seguintes;
          })();
      return { tarefas, activaId: tarefa.id };
    });
  }, []);

  const abrirNova = useCallback((tarefa: Omit<Tarefa, "sujo" | "id">): string => {
    const id = `${tarefa.tipo}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    setEstado((prev) => ({ tarefas: [...prev.tarefas, { ...tarefa, id, sujo: false }], activaId: id }));
    return id;
  }, []);

  const fechar = useCallback((id: string) => {
    setEstado((prev) => ({
      tarefas: prev.tarefas.filter((t) => t.id !== id),
      activaId: prev.activaId === id ? null : prev.activaId,
    }));
  }, []);

  const marcarSujo = useCallback((id: string, sujo: boolean) => {
    setEstado((prev) => ({ ...prev, tarefas: prev.tarefas.map((t) => (t.id === id ? { ...t, sujo } : t)) }));
  }, []);

  const actualizarTitulo = useCallback((id: string, titulo: string) => {
    setEstado((prev) => ({ ...prev, tarefas: prev.tarefas.map((t) => (t.id === id ? { ...t, titulo } : t)) }));
  }, []);

  const valor = useMemo<ContextoTaskBar>(
    () => ({ tarefas, activaId, abrirOuActivar, abrirNova, fechar, marcarSujo, actualizarTitulo }),
    [tarefas, activaId, abrirOuActivar, abrirNova, fechar, marcarSujo, actualizarTitulo]
  );

  return <Contexto.Provider value={valor}>{children}</Contexto.Provider>;
}

/** `null` fora do provider — o chamador decide o que fazer (tipicamente: não mostrar a barra). */
export function useTaskBar(): ContextoTaskBar | null {
  return useContext(Contexto);
}
