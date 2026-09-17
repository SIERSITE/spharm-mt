/**
 * lib/vendas-manutencao/tipos.ts
 *
 * Tipos partilhados entre a camada de dados (lib/vendas-manutencao-data.ts),
 * as server actions (app/vendas/manutencao/**\/actions.ts) e a UI
 * (components/vendas-manutencao/*.tsx).
 *
 * `quantidade` viaja sempre como `number` inteiro nesta camada — a
 * conversão de/para `Prisma`'s `Int`/`Decimal` fica isolada em
 * lib/vendas-manutencao-data.ts, para que nem a lógica pura
 * (distribuicao.ts/peso.ts/validacao.ts/valorizacao.ts) nem os Client
 * Components alguma vez importem tipos do Prisma.
 */

export type OrigemDistribuicao = "AUTOMATICA" | "MANUAL_AJUSTADA";
export type EstadoManutencao = "ATIVA" | "ANULADA";

export type CelulaManutencao = {
  farmaciaId: string;
  farmaciaNome: string;
  ano: number;
  mes: number;
  quantidade: number;
};

/**
 * O PVP de referência de UMA farmácia dentro de uma manutenção —
 * snapshot imutável, capturado só na criação (ver `VendaManutencaoFarmacia`
 * no schema). `null` = sem PVP válido no momento da captura; nunca 0
 * como substituto silencioso (secção 6 do pedido).
 */
export type FarmaciaComPvpReferencia = {
  farmaciaId: string;
  farmaciaNome: string;
  pvpReferencia: number | null;
};

export type ManutencaoResumo = {
  id: string;
  cnp: number;
  designacao: string;
  quantidadeTotal: number;
  numMeses: number;
  mesInicialAno: number;
  mesInicialMes: number;
  origemDistribuicao: OrigemDistribuicao;
  estado: EstadoManutencao;
  criadoPorNome: string;
  atualizadoPorNome: string | null;
  dataCriacao: string;
  dataAtualizacao: string;
};

export type ManutencaoDetalhe = ManutencaoResumo & {
  produtoId: string;
  celulas: CelulaManutencao[];
  /** Um por farmácia com alguma célula — nunca duplicado por mês. */
  farmaciasPvp: FarmaciaComPvpReferencia[];
};

/** Uma farmácia sem histórico suficiente para o cálculo automático (secção 1.7). */
export type AvisoSemHistorico = {
  tipo: "SEM_HISTORICO_NENHUM" | "SEM_HISTORICO_PARCIAL";
  /** Farmácias do âmbito sem qualquer venda NORMAL na janela de 12 meses. */
  farmaciasSemHistorico: string[];
};

/**
 * Transparência do peso histórico de FARMÁCIA usado numa proposta — de
 * onde vieram as percentagens que decidiram "esta farmácia leva X% da
 * quantidade total" (ver a tabela "Farmácia · Peso hist. · Total" na
 * UI). Nunca persistido — é sempre recalculado junto com a proposta,
 * exactamente para nunca ficar dessincronizado dela.
 */
export type PesoFarmaciaExibicao = {
  farmaciaId: string;
  farmaciaNome: string;
  /** Fracção 0..1 do total histórico usada para repartir a quantidade total. */
  peso: number;
  temHistorico: boolean;
};

/** De onde veio o peso mensal efectivamente aplicado a UMA farmácia — nunca uma caixa preta. */
export type OrigemPesoMensal = "FARMACIA" | "GLOBAL" | "NEUTRO";

export type PesoMesExibicao = {
  ano: number;
  mes: number;
  /** Fracção 0..1 entre os meses DESTA farmácia (soma 1 dentro da mesma farmácia). */
  peso: number;
};

/** O perfil mensal aplicado a UMA farmácia — a mesma farmácia pode usar uma origem diferente da farmácia ao lado (uma tem perfil próprio, outra cai para o global). */
export type PesosMensaisPorFarmacia = {
  farmaciaId: string;
  origem: OrigemPesoMensal;
  pesos: PesoMesExibicao[];
};

/** Resultado de calcular SÓ a distribuição (peso + meses) — nunca inclui PVP. */
export type PropostaDistribuicao = {
  celulas: CelulaManutencao[];
  aviso: AvisoSemHistorico | null;
  /** Transparência do peso por farmácia usado nesta proposta. */
  pesosFarmacia: PesoFarmaciaExibicao[];
  /** Transparência do peso mensal aplicado a cada farmácia desta proposta. */
  pesosMensais: PesosMensaisPorFarmacia[];
};

/** Resultado de uma proposta completa NOVA — distribuição + PVP capturado agora. */
export type PropostaCompleta = PropostaDistribuicao & {
  farmaciasPvp: FarmaciaComPvpReferencia[];
};
