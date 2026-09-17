/**
 * lib/vendas-manutencao/tipos.ts
 *
 * Tipos partilhados entre a camada de dados (lib/vendas-manutencao-data.ts),
 * as server actions (app/vendas/manutencao/**\/actions.ts) e a UI
 * (components/vendas-manutencao/*.tsx).
 *
 * `quantidade` viaja sempre como `number` nesta camada — a conversão
 * de/para `Prisma.Decimal` fica isolada em lib/vendas-manutencao-data.ts,
 * para que nem a lógica pura (distribuicao.ts/peso.ts/validacao.ts) nem
 * os Client Components alguma vez importem Decimal.
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
};

/** Uma farmácia sem histórico suficiente para o cálculo automático (secção 1.7). */
export type AvisoSemHistorico = {
  tipo: "SEM_HISTORICO_NENHUM" | "SEM_HISTORICO_PARCIAL";
  /** Farmácias do âmbito sem qualquer venda NORMAL na janela de 12 meses. */
  farmaciasSemHistorico: string[];
};

export type PropostaDistribuicao = {
  celulas: CelulaManutencao[];
  aviso: AvisoSemHistorico | null;
};
