/**
 * lib/operational/policy.ts
 *
 * A calibração operacional de cada farmácia, num sítio só. Puro: sem
 * Prisma, sem `next/headers`, sem `server-only` — é lido pelo servidor,
 * pelo cliente e pelos scripts do perfil `tools`.
 *
 * ══════════════════════════════════════════════════════════════════════
 * DUAS CATEGORIAS QUE NÃO SE MISTURAM
 * ══════════════════════════════════════════════════════════════════════
 *
 * **Invariantes técnicos** — respostas a defeitos de implementação. Não
 * são opinião de ninguém e valem para toda a gente:
 *
 *   · a origem nunca fica abaixo da sua própria cobertura-alvo;
 *   · o stock residual nunca é negativo;
 *   · o `Math.round` do excesso não pode engolir a reserva.
 *
 * NÃO estão neste ficheiro como parâmetros porque não são parâmetros.
 * Vivem no motor, e `reservaOrigemDias` abaixo é derivada, não escolhida.
 *
 * **Parâmetros de negócio** — decisões que dependem do universo de cada
 * farmácia e que só se fixam depois de medir:
 *
 *   · a partir de que cobertura é que stock passa a ser excesso;
 *   · até onde se enche um destino;
 *   · abaixo de que quantidade a sobra é ruído;
 *   · o que conta como rotura crítica.
 *
 * São estes, e só estes, que este ficheiro parametriza.
 *
 * ══════════════════════════════════════════════════════════════════════
 * PORQUE É QUE ISTO EXISTE
 * ══════════════════════════════════════════════════════════════════════
 *
 * Os valores 120/45/3 foram calibrados com o funil da Silveirense —
 * 45 194 linhas, 2 144 roturas, 812 CNP com excesso. Aplicá-los à
 * Garantia, que tem outro universo e outra rotação, seria transportar a
 * conclusão sem transportar a medição. Uma farmácia com stock mais
 * apertado veria de repente "excesso" onde tem cobertura normal.
 *
 * O default global é o comportamento ANTERIOR. Quem não foi medido não
 * muda.
 */

// ─────────────────────────────────────────────────────────────────────
// A forma
// ─────────────────────────────────────────────────────────────────────

/**
 * Como o Dashboard trata a rotura.
 *
 *   `classica`     um cartão só: sem stock E com vendas na janela.
 *   `tres-niveis`  crítica / ocasional / sem procura recente.
 *
 * Só afecta o CARTÃO. Os três filtros de /stock existem sempre, para
 * toda a gente — são aditivos, não alteram contagem nenhuma, e são
 * precisamente como se mede uma farmácia antes de decidir por ela.
 */
export type ModoRotura = "classica" | "tres-niveis";

export type PoliticaExcesso = {
  /** Acima desta cobertura (dias) há excesso. */
  thresholdDias: number;
  /**
   * Cobertura-alvo, em dias. Faz duas coisas ao mesmo tempo:
   * define quanto da origem é excedente E até onde se enche o destino.
   */
  targetDias: number;
  /** Excessos abaixo disto contam como zero. */
  minimoUnidades: number;
};

export type PoliticaRotura = {
  modo: ModoRotura;
  /** Última venda até há tantos dias conta como procura activa. */
  recenciaDias: number;
  /** Meses distintos com venda (em 12) que provam recorrência. */
  mesesMinimos: number;
  /** Unidades em 3 meses que provam procura sem precisar de histórico. */
  unidadesMinimas: number;
};

export type OperationalPolicy = {
  /** O tenant a que esta policy pertence. `null` = defaults globais. */
  slug: string | null;
  /** `true` quando existe override — para os diagnósticos o dizerem. */
  calibrada: boolean;
  excesso: PoliticaExcesso;
  rotura: PoliticaRotura;
};

// ─────────────────────────────────────────────────────────────────────
// Defaults globais — o comportamento ANTERIOR, deliberadamente
// ─────────────────────────────────────────────────────────────────────

/**
 * CONGELADO, e em profundidade.
 *
 * Sem isto, `{ ...POLICY_DEFAULT }` copia a referência de `excesso` e de
 * `rotura`: quem recebesse a policy da Garantia e lhe mexesse num campo
 * estaria a mexer no default de TODA A GENTE, incluindo o das farmácias
 * calibradas. Um erro assim não dá erro — dá números errados noutro
 * tenant, mais tarde, sem ligação visível à causa.
 *
 * `getOperationalPolicy` devolve sempre cópias novas; o congelamento é a
 * segunda fechadura, para o caso de alguém acrescentar um caminho que se
 * esqueça disso.
 */
export const POLICY_DEFAULT: OperationalPolicy = Object.freeze({
  slug: null,
  calibrada: false,
  excesso: Object.freeze({
    thresholdDias: 180,
    targetDias: 30,
    minimoUnidades: 5,
  }),
  rotura: Object.freeze({
    // `classica` até haver diagnóstico da farmácia. Ver a nota sobre
    // roturas no fim deste ficheiro.
    modo: "classica" as ModoRotura,
    recenciaDias: 30,
    mesesMinimos: 2,
    unidadesMinimas: 4,
  }),
});

// ─────────────────────────────────────────────────────────────────────
// Overrides
// ─────────────────────────────────────────────────────────────────────

type OverridePolicy = {
  excesso?: Partial<PoliticaExcesso>;
  rotura?: Partial<PoliticaRotura>;
};

/**
 * As farmácias que já foram medidas.
 *
 * Uma entrada aqui é uma afirmação forte: "corri o diagnóstico nesta
 * farmácia e estes números sustentam-se". Sem diagnóstico, não há
 * entrada — o default é sempre a resposta segura.
 *
 * Chave = slug do tenant (o mesmo que o `--tenant` dos scripts e o
 * `x-tenant-slug` dos pedidos).
 */
const OVERRIDES: Record<string, OverridePolicy> = {
  /**
   * Silveirense · medida em 2026-09-04.
   *
   * Funil: 45 194 linhas produto×farmácia, 11 605 com stock > 0, 3 574
   * com cobertura > 180d, 945 com excesso >= 5, mas apenas **14** CNP
   * com excesso numa farmácia e necessidade noutra.
   *
   * O estrangulamento não eram os thresholds — era a coincidência de
   * CNP. Baixar a cobertura de origem aumenta a oferta, que já sobrava;
   * o que faltava era procura do outro lado, e é o `targetDias` que a
   * define. Daí 120/45/3 e não, por exemplo, 60/30/1.
   */
  silveira: {
    excesso: {
      thresholdDias: 120,
      targetDias: 45,
      minimoUnidades: 3,
    },
    // A classificação de roturas NÃO é activada aqui. Os três níveis
    // foram desenhados com estes dados, mas as contagens finais ainda
    // não foram confirmadas — e um cartão que muda de 2 144 para umas
    // centenas sem que ninguém tenha visto o número intermédio lê-se
    // como avaria. Passa a `tres-niveis` numa linha, quando for medido.
  },

  /**
   * Garantia · NÃO medida.
   *
   * Ausência deliberada, e escrita para que se veja que é deliberada:
   * uma entrada vazia aqui pareceria esquecimento, e nenhuma entrada
   * pareceria omissão. A Garantia corre com os defaults globais até ter
   * o seu próprio diagnóstico.
   */
};

// ─────────────────────────────────────────────────────────────────────
// A função central
// ─────────────────────────────────────────────────────────────────────

/**
 * A policy de uma farmácia. É por aqui que TODO o código pergunta.
 *
 * Nunca `if (tenant === "silveira")` espalhado pelo código: a lista de
 * quem está calibrado vive num sítio, e quem chama nem sabe que ela
 * existe.
 *
 * `null`, slug desconhecido, ou slug sem override ⇒ defaults globais.
 * As três respostas são a mesma de propósito — um tenant novo não deve
 * herdar a calibração de ninguém.
 */
export function getOperationalPolicy(slug: string | null | undefined): OperationalPolicy {
  const chave = (slug ?? "").trim().toLowerCase();
  const over = chave ? OVERRIDES[chave] : undefined;
  // Cópias NOVAS dos dois sub-objectos, com ou sem override. Um spread
  // de primeiro nível partilharia `excesso` e `rotura` com o default, e
  // quem lhes mexesse contaminava todas as farmácias.
  return {
    slug: chave || null,
    calibrada: Boolean(over),
    excesso: { ...POLICY_DEFAULT.excesso, ...over?.excesso },
    rotura: { ...POLICY_DEFAULT.rotura, ...over?.rotura },
  };
}

/** Os slugs com calibração própria. Para diagnósticos e testes. */
export function slugsCalibrados(): string[] {
  return Object.keys(OVERRIDES).sort();
}

// ─────────────────────────────────────────────────────────────────────
// A reserva da origem — DERIVADA, não configurada
// ─────────────────────────────────────────────────────────────────────

/**
 * Dias de cobertura que a origem tem de conservar depois de uma
 * transferência. **Igual ao `targetDias` da própria farmácia**, e é uma
 * relação, não uma coincidência.
 *
 * ── Porque não é um parâmetro ────────────────────────────────────────
 *
 * O excesso já é definido como o que sobra ACIMA do alvo:
 *
 *     excesso = (cobertura − alvo) × média
 *     stock − excesso = alvo × média
 *
 * Na aritmética exacta a origem fica sempre com o alvo. A reserva não
 * acrescenta regra nenhuma — repõe a regra que já lá estava.
 *
 * ── Porque então existe ──────────────────────────────────────────────
 *
 * Porque `excesso = Math.round(...)`. Quando `alvo × média <= 0,5` o
 * arredondamento engole a reserva inteira e o excesso passa a ser o
 * stock TODO. Um artigo com stock 5 que venda 6 unidades por ano cedia
 * as 5 e ficava a zero. É um defeito de implementação, não uma escolha
 * comercial — e por isso vale para todas as farmácias, incluindo as que
 * mantêm 180/30/5.
 *
 * ── Porque acompanha o alvo em vez de ser 30 fixo ────────────────────
 *
 * Fixá-la em 30 numa farmácia cujo alvo é 45 seria dizer "protege 30
 * dias" a quem decidiu que o objectivo eram 45 — uma segunda opinião
 * silenciosa sobre um número que já foi decidido. E fixá-la em 30 numa
 * farmácia com alvo 20 tornava-a uma regra de negócio nova, que ninguém
 * pediu.
 *
 * ── Quando deixaria de ser derivada ──────────────────────────────────
 *
 * Se alguém quiser uma reserva MAIOR do que o alvo — "cede excesso, mas
 * nunca fiques abaixo de dois meses" — isso é uma decisão comercial
 * nova e passa a merecer campo próprio em `PoliticaExcesso`. Não o
 * acrescentei porque ninguém o pediu, e um parâmetro que existe "para o
 * caso de" é um parâmetro que ninguém sabe afinar.
 */
export function reservaOrigemDias(p: OperationalPolicy): number {
  return p.excesso.targetDias;
}

/** Uma linha legível da policy, para cabeçalhos de diagnóstico. */
export function descreverPolicy(p: OperationalPolicy): string[] {
  return [
    `tenant: ${p.slug ?? "(nenhum)"}${p.calibrada ? "" : "  — sem calibração própria, defaults globais"}`,
    "policy:",
    `  excessoDias    = ${p.excesso.thresholdDias}`,
    `  targetDays     = ${p.excesso.targetDias}`,
    `  excessoMinimo  = ${p.excesso.minimoUnidades}`,
    `  reservaOrigem  = ${reservaOrigemDias(p)}  (derivada do targetDays)`,
    `  rotura         = ${p.rotura.modo}  (<=${p.rotura.recenciaDias}d · >=${p.rotura.mesesMinimos} meses · >=${p.rotura.unidadesMinimas} un)`,
  ];
}
