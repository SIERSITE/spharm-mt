"use client";

/**
 * lib/workspace/estado-separador.ts
 *
 * ESTADO POR SEPARADOR — o que faz de um separador do workspace um «documento aberto» e não só um atalho com título e URL.
 *
 * ── Porquê isto existe (causa raiz) ────────────────────────────────────
 * Cada separador é uma ROTA do Next.js (App Router). Mudar de separador é uma navegação: o Next DESMONTA a página anterior
 * e monta a nova. O separador só guardava metadados (id, título, href — `task-bar-context.tsx`), por isso, ao voltar, o título
 * e o URL estavam lá mas o `useState` da página já tinha desaparecido. Só os CRITÉRIOS de 5 módulos sobreviviam
 * (`use-workspace-state.ts`, sessionStorage); resultados, seleção, expansões, rascunhos e scroll perdiam-se.
 *
 * ── Alternativas avaliadas ─────────────────────────────────────────────
 *   · `cacheComponents` do Next 16 (mantém rotas escondidas em <Activity>): preserva no máximo 3 rotas, chaveadas por rota
 *     (não por separador), e obriga a que TODAS as páginas (todas dinâmicas: sessão/tenant/BD) passem a viver sob <Suspense>
 *     com opt-ins de cache — reescrita transversal e arriscada. Rejeitado.
 *   · manter várias rotas montadas num layout: o `children` do layout é só a rota activa; uma rota guardada volta a ser
 *     avaliada contra o URL ACTUAL do router. Impossível sem iframes.
 *   · estado em sessionStorage/localStorage: não aguenta resultados grandes (quota), serializa Sets/Maps e mistura dados de
 *     tenant em armazenamento persistente. Rejeitado para resultados.
 *
 * ── Solução ────────────────────────────────────────────────────────────
 * Um armazém EM MEMÓRIA (módulo singleton, vive no JS do browser enquanto a aplicação não recarrega), indexado por
 * escopo (tenant:utilizador) → separador (identidade estável) → chave. Está acima do router, logo sobrevive às navegações.
 * As páginas trocam `useState` por `useEstadoSeparador(chave, inicial)` — mesma assinatura — nos estados que valem a pena
 * preservar (resultados, seleção, expansões, rascunhos). Nada é copiado nem serializado (referências), por isso resultados
 * grandes não pagam quota nem JSON.
 *
 *   · isolamento: a chave inclui a identidade do separador (`/vendas?workspace=<id>`), nunca só a rota;
 *   · mesma rota, outro separador (mudança de `?workspace=`) com a página montada: o hook re-hidrata para o novo separador;
 *   · pedidos em curso: o setter escreve no armazém do separador que o originou, mesmo que a página já esteja desmontada
 *     — o resultado de uma geração concluída com o separador em segundo plano está lá ao regressar (e nada repete a consulta);
 *   · ciclo de vida: fechar separador / evicção libertam o seu estado; terminar sessão ou mudar de tenant limpam tudo
 *     (`TaskBarProvider`); refresh completo do browser limpa a memória (os critérios continuam em sessionStorage como antes).
 *
 * Scroll: `[data-scroll-key]` em qualquer contentor com scroll + o scroll da janela — guardado/restaurado por
 * `components/layout/scroll-separadores.tsx` sem integração por página.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { identidadeDoSeparador } from "@/lib/workspace/rotas";
import { useEscopoSeparadores, useTaskBar } from "@/lib/workspace/task-bar-context";
import { estadoSeparadores } from "@/lib/workspace/armazem-separadores";

export { estadoSeparadores };

// ─────────────────────────────────────────────────────────────────────────
// Hooks
// ─────────────────────────────────────────────────────────────────────────

/** Identidade do separador desta localização (ver `identidadeDoSeparador`). */
export function useIdSeparador(): string | null {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  return identidadeDoSeparador(pathname, searchParams.get("workspace"));
}

type Setter<T> = (u: T | ((prev: T) => T)) => void;

/**
 * `useState` que sobrevive à troca de separador. `chave` identifica o campo dentro do separador (ex.: "rows", "selecao").
 *
 * · `inicial` só é usado se o separador ainda não tem valor para a chave (1.ª abertura, ou separador novo/reaberto).
 * · O valor guardado é a MESMA referência (sem cópias): não pôr aqui estado que a página mute no sítio.
 * · O setter escreve SEMPRE no armazém do separador que o criou, mesmo depois de a página desmontar (pedidos em curso).
 * · Sem escopo (sessão não resolvida) ou fora de um separador: comporta-se como `useState` normal.
 */
export function useEstadoSeparador<T>(
  chave: string,
  inicial: T | (() => T),
  opcoes?: {
    /**
     * `false` suspende a persistência (a chamada comporta-se como `useState`): para estado que só deve sobreviver em certos
     * modos (ex.: a proposta de uma encomenda só em modo «farmácia», onde o rascunho é recuperável pelo servidor).
     */
    ativo?: boolean;
  },
): [T, Setter<T>] {
  const escopo = useEscopoSeparadores();
  const id = useIdSeparador();
  const ativo = opcoes?.ativo !== false;
  const inicialRef = useRef(inicial);
  const resolverInicial = (): T => {
    const i = inicialRef.current;
    return typeof i === "function" ? (i as () => T)() : i;
  };
  const ler = (): T => {
    if (ativo && escopo && id && estadoSeparadores.tem(escopo, id, chave)) return estadoSeparadores.ler<T>(escopo, id, chave) as T;
    return resolverInicial();
  };

  const [suporte, setSuporte] = useState<{ escopo: string | null; id: string | null; valor: T }>(() => ({ escopo, id, valor: ler() }));

  // Mesma página, outro separador (ex.: `?workspace=` diferente) ou escopo diferente: re-hidrata para o novo.
  // (A identidade é a do separador — `ativo` não conta: alternar a persistência não re-hidrata nem repõe nada.)
  let atual = suporte;
  if (suporte.id !== id || suporte.escopo !== escopo) {
    atual = { escopo, id, valor: ler() };
    setSuporte(atual);
  }

  // Último valor mostrado — fallback das atualizações funcionais quando não há valor no armazém (ex.: `ativo` falso).
  const valorRef = useRef(atual.valor);
  useEffect(() => {
    valorRef.current = atual.valor;
  });

  // `ativo` mudou a meio da vida do separador: ao ligar, o valor corrente passa a estar guardado; ao desligar, apaga-se
  // o que lá estava (nunca fica um valor antigo para ser restaurado por engano).
  const ativoAnterior = useRef(ativo);
  useEffect(() => {
    if (ativoAnterior.current === ativo) return;
    ativoAnterior.current = ativo;
    if (!escopo || !id) return;
    if (ativo) estadoSeparadores.escrever(escopo, id, chave, valorRef.current);
    else estadoSeparadores.apagar(escopo, id, chave);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ativo]);

  const setter = useCallback<Setter<T>>(
    (u) => {
      // O armazém é a fonte de verdade para atualizações funcionais (a página pode já estar desmontada).
      const anterior: T =
        ativo && escopo && id && estadoSeparadores.tem(escopo, id, chave) ? (estadoSeparadores.ler<T>(escopo, id, chave) as T) : valorRef.current;
      const proximo = typeof u === "function" ? (u as (p: T) => T)(anterior) : u;
      valorRef.current = proximo; // duas atualizações funcionais seguidas no mesmo tick compõem-se
      if (escopo && id) {
        if (ativo) estadoSeparadores.escrever(escopo, id, chave, proximo);
        else estadoSeparadores.apagar(escopo, id, chave);
      }
      // Só atualiza o ecrã se ESTE separador ainda é o desta instância (um pedido tardio de outro separador não lhe mexe).
      setSuporte((prev) => (prev.id === id && prev.escopo === escopo ? { escopo, id, valor: proximo } : prev));
    },
    [escopo, id, chave, ativo],
  );

  return [atual.valor, setter];
}

/**
 * Declara que o separador activo tem alterações por confirmar (rascunho, decisões, edições). A barra de separadores
 * mostra o indicador, pede confirmação ao FECHAR esse separador e a AppShell ao TERMINAR SESSÃO. Páginas só de leitura
 * não chamam isto (nem recebem confirmações). O valor persiste enquanto o separador existir — ao regressar a página
 * volta a declará-lo a partir do estado restaurado.
 */
export function useAlteracoesPendentes(pendentes: boolean): void {
  const taskBar = useTaskBar();
  const id = useIdSeparador();
  const marcarSujo = taskBar?.marcarSujo;
  const registado = !!id && !!taskBar?.tarefas.some((t) => t.id === id);
  useEffect(() => {
    if (marcarSujo && id && registado) marcarSujo(id, pendentes);
  }, [marcarSujo, id, registado, pendentes]);
}
