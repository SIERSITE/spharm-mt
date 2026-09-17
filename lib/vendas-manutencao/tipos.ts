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

/** Resultado de calcular SÓ a distribuição (peso + meses) — nunca inclui PVP. */
export type PropostaDistribuicao = {
  celulas: CelulaManutencao[];
  aviso: AvisoSemHistorico | null;
};

/** Resultado de uma proposta completa NOVA — distribuição + PVP capturado agora. */
export type PropostaCompleta = PropostaDistribuicao & {
  farmaciasPvp: FarmaciaComPvpReferencia[];
};
