/**
 * lib/vendas-manutencao/peso.ts
 *
 * Peso histórico de cada farmácia nas vendas de um artigo — a base da
 * distribuição automática por farmácia (secção 1.2 do pedido).
 *
 * ── Janela: 12 meses completos, fixa na criação ──────────────────────
 *
 * "12 meses completos anteriores ao mês de referência da manutenção,
 * nunca uma janela que possa variar posteriormente" — a janela é
 * calculada a partir do PRÓPRIO mês inicial da manutenção
 * (`VendaManutencao.mesInicialAno/mesInicialMes`), nunca da data
 * corrente do servidor. Duas manutenções criadas em dias diferentes
 * para o MESMO mês inicial têm SEMPRE a mesma janela — e uma
 * manutenção já criada nunca vê a sua janela recalculada só porque o
 * tempo passou (é exactamente o que a secção 1.4 pede: "os pesos
 * históricos podem mudar no futuro e uma manutenção antiga não pode
 * alterar-se retroactivamente").
 *
 * "12 meses completos ANTERIORES" — o próprio mês de referência fica
 * de fora: o histórico do mês em que a manutenção está a começar ainda
 * pode estar incompleto no ERP.
 *
 * ── `naturezaVenda` ───────────────────────────────────────────────────
 *
 * Só "NORMAL" — vendas reais ao cliente. Exclui "CREDITO" (devoluções)
 * e "TRANSFERENCIA" (movimento interno entre farmácias, não é venda a
 * ninguém) — os dois distorceriam "onde este artigo se vende de facto"
 * exactamente pela razão oposta de cada um: uma devolução reduz um
 * total que nem devia ter contado a favor da farmácia onde a venda deu
 * problema; uma transferência interna não é comércio nenhum.
 *
 * A `VendaManutencaoCelula` nunca entra aqui — a query de peso lê
 * exclusivamente `VendaMensal` (ver lib/vendas-manutencao-data.ts),
 * nunca a tabela de manutenção. Garantia estrutural, não uma regra a
 * lembrar em cada chamada.
 *
 * Puro — sem Prisma. A leitura de `VendaMensal` vive em
 * lib/vendas-manutencao-data.ts; este módulo só sabe transformar
 * `{farmaciaId, qty}[]` já lido em pesos.
 */

/** Índice linear ano×12+mês-1 — comparável e ordenável sem casos especiais de virada de ano. */
function indiceMes(ano: number, mes: number): number {
  return ano * 12 + (mes - 1);
}

function deIndiceMes(idx: number): { ano: number; mes: number } {
  return { ano: Math.floor(idx / 12), mes: (idx % 12) + 1 };
}

export type JanelaHistorica = {
  /** Ano/mês do primeiro mês da janela (inclusive). */
  inicio: { ano: number; mes: number };
  /** Ano/mês do último mês da janela (inclusive) — sempre o mês anterior ao de referência. */
  fim: { ano: number; mes: number };
};

/**
 * Os 12 meses civis completos imediatamente ANTERIORES a
 * `(anoRef, mesRef)` — nunca inclui o próprio mês de referência.
 */
export function janelaHistoricaDozeMeses(anoRef: number, mesRef: number): JanelaHistorica {
  const idxFim = indiceMes(anoRef, mesRef) - 1;
  const idxInicio = idxFim - 11;
  return { inicio: deIndiceMes(idxInicio), fim: deIndiceMes(idxFim) };
}

export type QtyPorFarmacia = { farmaciaId: string; qty: number };

export type PesoFarmacia = {
  farmaciaId: string;
  /** Fracção 0..1 do total histórico. 0 quando esta farmácia não tem histórico algum. */
  peso: number;
  /** `false` quando esta farmácia, especificamente, não vendeu nada na janela. */
  temHistorico: boolean;
};

export type ResultadoPesos = {
  pesos: PesoFarmacia[];
  /**
   * `true` quando NENHUMA farmácia do âmbito tem histórico — a regra
   * "não inventar peso" (secção 1.7) aplica-se ao conjunto inteiro, e
   * quem chama tem de oferecer distribuição manual, nunca uma proposta
   * automática às cegas.
   */
  semHistoricoNenhum: boolean;
};

/**
 * Calcula o peso de cada farmácia do âmbito a partir do histórico já
 * lido (uma linha por farmácia COM vendas na janela — uma farmácia sem
 * nenhuma linha em `historico` é, por definição, sem histórico).
 *
 * Farmácias SEM histórico ficam com peso 0 — nunca uma divisão igual
 * forçada entre elas (isso inventaria um peso que o histórico não deu).
 * O utilizador ajusta manualmente se quiser incluir uma destas.
 */
export function calcularPesosFarmacia(
  historico: readonly QtyPorFarmacia[],
  farmaciasNoAmbito: readonly string[],
): ResultadoPesos {
  const qtyPorFarmacia = new Map(historico.map((h) => [h.farmaciaId, h.qty]));
  const comHistorico = farmaciasNoAmbito.filter((f) => (qtyPorFarmacia.get(f) ?? 0) > 0);

  if (comHistorico.length === 0) {
    return {
      pesos: farmaciasNoAmbito.map((f) => ({ farmaciaId: f, peso: 0, temHistorico: false })),
      semHistoricoNenhum: true,
    };
  }

  const totalHistorico = comHistorico.reduce((s, f) => s + (qtyPorFarmacia.get(f) ?? 0), 0);
  const pesos = farmaciasNoAmbito.map((f) => {
    const qty = qtyPorFarmacia.get(f) ?? 0;
    return {
      farmaciaId: f,
      peso: qty > 0 ? qty / totalHistorico : 0,
      temHistorico: qty > 0,
    };
  });

  return { pesos, semHistoricoNenhum: false };
}
