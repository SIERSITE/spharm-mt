/**
 * lib/workspace/armazem-separadores.ts
 *
 * Armazém EM MEMÓRIA do estado por separador — sem React, sem DOM (testável com tsx). Ver a explicação completa e as
 * alternativas rejeitadas em `estado-separador.ts`. Indexado por escopo (`tenant:utilizador`) → separador (identidade) → chave.
 */
const SEP = "\u0001";
const armazem = new Map<string, Map<string, unknown>>();
const k = (escopo: string, separador: string) => `${escopo}${SEP}${separador}`;

export const estadoSeparadores = {
  tem(escopo: string, separador: string, chave: string): boolean {
    return armazem.get(k(escopo, separador))?.has(chave) ?? false;
  },
  ler<T>(escopo: string, separador: string, chave: string): T | undefined {
    return armazem.get(k(escopo, separador))?.get(chave) as T | undefined;
  },
  escrever(escopo: string, separador: string, chave: string, valor: unknown): void {
    const id = k(escopo, separador);
    let m = armazem.get(id);
    if (!m) {
      m = new Map();
      armazem.set(id, m);
    }
    m.set(chave, valor);
  },
  /** Remove uma chave (estado que deixou de dever sobreviver). */
  apagar(escopo: string, separador: string, chave: string): void {
    armazem.get(k(escopo, separador))?.delete(chave);
  },
  /** Fechar um separador liberta TODO o seu estado. */
  limparSeparador(escopo: string, separador: string): void {
    armazem.delete(k(escopo, separador));
  },
  /** Mantém só os separadores listados (os outros foram fechados/evictados). */
  manterApenas(escopo: string, abertos: ReadonlySet<string>): void {
    const prefixo = `${escopo}${SEP}`;
    for (const chave of [...armazem.keys()]) {
      if (chave.startsWith(prefixo) && !abertos.has(chave.slice(prefixo.length))) armazem.delete(chave);
    }
  },
  /** Mudar de tenant/utilizador ou terminar sessão: nada do escopo anterior pode ficar na memória. */
  limparForaDoEscopo(escopo: string | null): void {
    const prefixo = escopo ? `${escopo}${SEP}` : null;
    for (const chave of [...armazem.keys()]) {
      if (!prefixo || !chave.startsWith(prefixo)) armazem.delete(chave);
    }
  },
  limparTudo(): void {
    armazem.clear();
  },
  /** Diagnóstico (testes/suporte): só identidades e nº de chaves — nunca valores. */
  diagnostico(): Array<{ escopo: string; separador: string; chaves: number }> {
    return [...armazem.entries()].map(([id, m]) => {
      const [escopo, separador] = id.split(SEP);
      return { escopo, separador, chaves: m.size };
    });
  },
};

if (typeof window !== "undefined") {
  // Só leitura de metadados (ver `diagnostico`): usado pelos E2E para provar a libertação do estado ao fechar/terminar sessão.
  (window as unknown as { __spharmSeparadores?: () => ReturnType<typeof estadoSeparadores.diagnostico> }).__spharmSeparadores = () =>
    estadoSeparadores.diagnostico();
}

