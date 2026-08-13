/**
 * lib/movimentos-tipos.ts
 *
 * O vocabulário do extrato de movimentos: tipos, rótulos e direcção.
 *
 * Vive num ficheiro separado de `lib/movimentos-data.ts` por causa da
 * fronteira Server/Client. O read-model importa `@/lib/prisma`, e o
 * Prisma arrasta consigo `node:module`, `fs`, `net` e `tls` — nada disso
 * existe no browser. Um Client Component que importe UM valor de runtime
 * desse módulo puxa a árvore inteira e o build parte com
 * "the chunking context does not support external modules".
 *
 * A regra prática: `import type { … } from "@/lib/movimentos-data"` é
 * sempre seguro (o TypeScript apaga-o na compilação), mas assim que o
 * import passa a ser de runtime — uma constante, uma função — a fronteira
 * quebra. Foi exactamente isso que aconteceu em a9ab5e4: o chip do
 * extrato passou a precisar de `TIPOS_ACERTO_STOCK`, que estava do lado
 * do read-model.
 *
 * Regra para quem acrescentar coisas aqui: este ficheiro não pode
 * importar `@/lib/prisma`, `@/generated/prisma/*`, nem nada que os
 * importe. Só tipos, constantes e funções puras. Se precisar de I/O,
 * pertence a `movimentos-data.ts`.
 *
 * `movimentos-data.ts` re-exporta tudo o que está aqui, portanto os
 * chamadores server-side não têm de saber que a divisão existe.
 */

export type MovimentoTipo =
  | "VENDA"
  | "DEVOLUCAO_CLIENTE"
  | "VENDA_CREDITO"
  | "RESERVA_SUSPENSA"
  | "COMPRA"
  | "DEVOLUCAO_FORNECEDOR"
  | "ACERTO_STOCK"
  | "DESCONHECIDO"
  // ── Internos retirados em rev60 ──────────────────────────────
  // A migração recolhe-os para ACERTO_STOCK, mas continuam aqui:
  // enquanto houver um tenant onde ela ainda não correu, a leitura tem
  // de os saber mostrar. Todos partilham o rótulo "Acerto de stock" —
  // o utilizador vê uma operação só, venha a linha de onde vier.
  | "INVENTARIO"
  | "AJUSTE"
  | "QUEBRA"
  | "PERDA"
  | "TRANSFERENCIA_ENTRADA"
  | "TRANSFERENCIA_SAIDA"
  // ── Legacy-only (eliminados quando o branch legacy sair) ──
  | "DEVOLUCAO_OUTRA"
  | "AJUSTE_POSITIVO"
  | "AJUSTE_NEGATIVO"
  | "AJUSTE_CORRECAO"
  | "AJUSTE_OUTRO";

/**
 * Todos os tipos que o utilizador vê como "Acerto de stock" — o
 * canónico, os seis que rev60 retirou e os do branch legacy.
 *
 * Existe para que o filtro e o rótulo usem a MESMA lista. Quando eram
 * duas listas, um tipo acrescentado a uma e esquecido na outra dava uma
 * linha que aparecia na grelha mas desaparecia ao clicar no chip.
 */
export const TIPOS_ACERTO_STOCK: readonly MovimentoTipo[] = [
  "ACERTO_STOCK",
  "INVENTARIO",
  "AJUSTE",
  "QUEBRA",
  "PERDA",
  "TRANSFERENCIA_ENTRADA",
  "TRANSFERENCIA_SAIDA",
  "AJUSTE_POSITIVO",
  "AJUSTE_NEGATIVO",
  "AJUSTE_CORRECAO",
  "AJUSTE_OUTRO",
];

export type MovimentoDirecao = "ENTRADA" | "SAIDA" | "NEUTRO";

export type ContraparteTipo =
  | "CLIENTE"
  | "FORNECEDOR"
  | "FARMACIA_ORIGEM"
  | "FARMACIA_DESTINO";

export type MovimentoRow = {
  /** Chave estável dentro da timeline — fonte + id original. */
  key: string;
  /** ISO datetime; ordenação é feita sobre este campo descendente. */
  data: string;
  farmaciaId: string;
  farmacia: string;
  tipo: MovimentoTipo;
  /** Label legível (ex: "Venda", "Devolução cliente"). */
  tipoLabel: string;
  direcao: MovimentoDirecao;

  // ── Documento (ERP "Movimento de Artigos") ───────────────────
  /** Rótulo do tipo de documento ("Factura", "Recepção", "Nota Crédito"…). */
  documentoTipo: string | null;
  /** Número visível ("G/783019", "60566", "VSG/25113", "VCG_1/2169"). */
  documentoNumero: string | null;
  /** Coluna "Externo" do ERP: factura do fornecedor, talão original duma NC. */
  referenciaExterna: string | null;

  // ── Contraparte (cliente / fornecedor / farmácia) ────────────
  contraparteNome: string | null;
  contraparteTipo: ContraparteTipo | null;

  // ── Quantidades / running balance ────────────────────────────
  /** Sinal preservado: +N entrada, −N saída. */
  quantidade: number;
  /** `existenciaApos − quantidade`. Derivado. */
  stockAntes: number;
  /** `existenciaApos` no ERP. */
  stockDepois: number;
  quantidadeBonusEnt: number;
  quantidadeBonusSai: number;
  existenciaBonusApos: number;

  // ── Económicos ────────────────────────────────────────────────
  precoUnitario: number | null;
  valorLinha: number | null;
  /** PMC novo (após este movimento). */
  pmcNovo: number | null;

  // ── Metadata ──────────────────────────────────────────────────
  armazemNome: string | null;
  utilizadorNome: string | null;
  /** Motivo livre do operador (`tblMovStocksCab_Motivo`). */
  observacao: string | null;
  /** 'A' = anulado, 'N' = normal, null para vendas/compras puras. */
  situacao: string | null;
};

export type MovimentosFilters = {
  /** Se vazio/omitido, agrega todas as farmácias activas (não-Teste). */
  farmaciaIds?: string[];
  /** ISO date string inclusivo, opcional. */
  from?: string;
  to?: string;
  /** Se vazio/omitido, devolve todos os tipos. */
  tipos?: MovimentoTipo[];
};

export const TIPO_LABELS: Record<MovimentoTipo, string> = {
  VENDA: "Venda",
  DEVOLUCAO_CLIENTE: "Devolução cliente",
  VENDA_CREDITO: "Venda crédito",
  RESERVA_SUSPENSA: "Reserva",
  COMPRA: "Compra / Receção",
  DEVOLUCAO_FORNECEDOR: "Devolução fornecedor",
  ACERTO_STOCK: "Acerto de stock",
  DESCONHECIDO: "Movimento",
  DEVOLUCAO_OUTRA: "Devolução",
  // Os internos partilham todos o mesmo rótulo. Uma linha gravada antes
  // da migração e outra gravada depois descrevem a mesma operação, e o
  // utilizador não tem de saber qual é qual.
  INVENTARIO: "Acerto de stock",
  AJUSTE: "Acerto de stock",
  QUEBRA: "Acerto de stock",
  PERDA: "Acerto de stock",
  TRANSFERENCIA_ENTRADA: "Acerto de stock",
  TRANSFERENCIA_SAIDA: "Acerto de stock",
  AJUSTE_POSITIVO: "Acerto de stock",
  AJUSTE_NEGATIVO: "Acerto de stock",
  AJUSTE_CORRECAO: "Acerto de stock",
  AJUSTE_OUTRO: "Acerto de stock",
};

/** Lista usada pelo dropdown "Tipo de movimento" na UI. */
export function getTiposDisponiveis(): Array<{ value: MovimentoTipo; label: string }> {
  // Apenas tipos canónicos rev60. Os seis internos retirados não entram
  // aqui: escolher "Quebra" no dropdown daria resultados de uma janela
  // e nada da seguinte, conforme a migração já tivesse corrido.
  const canonical: MovimentoTipo[] = [
    "VENDA",
    "DEVOLUCAO_CLIENTE",
    "VENDA_CREDITO",
    "RESERVA_SUSPENSA",
    "COMPRA",
    "DEVOLUCAO_FORNECEDOR",
    "ACERTO_STOCK",
    "DESCONHECIDO",
  ];
  return canonical.map((v) => ({ value: v, label: TIPO_LABELS[v] }));
}

export function direcaoForTipo(tipo: MovimentoTipo, qty: number): MovimentoDirecao {
  switch (tipo) {
    case "VENDA":
    case "VENDA_CREDITO":
    case "DEVOLUCAO_FORNECEDOR":
    case "TRANSFERENCIA_SAIDA":
    case "QUEBRA":
    case "PERDA":
    case "AJUSTE_NEGATIVO":
      return "SAIDA";
    case "COMPRA":
    case "DEVOLUCAO_CLIENTE":
    case "TRANSFERENCIA_ENTRADA":
    case "AJUSTE_POSITIVO":
      return "ENTRADA";
    // Um acerto de stock não tem direcção própria — tem o sinal que o
    // ERP lhe deu. É por isso que colapsar os seis tipos não perde
    // informação de entrada/saída: essa nunca esteve no tipo, esteve
    // sempre em `quantidade`.
    case "ACERTO_STOCK":
    case "INVENTARIO":
    case "AJUSTE":
    case "AJUSTE_CORRECAO":
    case "AJUSTE_OUTRO":
    case "DEVOLUCAO_OUTRA":
    case "RESERVA_SUSPENSA":
    case "DESCONHECIDO":
      return qty > 0 ? "ENTRADA" : qty < 0 ? "SAIDA" : "NEUTRO";
  }
}

/**
 * Expande a selecção de tipos do filtro.
 *
 * Pedir ACERTO_STOCK traz também os tipos que ele substituiu. Sem isto,
 * a mesma escolha devolvia coisas diferentes conforme a migração de
 * recolha já tivesse corrido naquele tenant — e o utilizador via um
 * acerto na grelha desaparecer ao filtrar por acertos.
 */
export function expandirTiposFiltro(tipos: readonly MovimentoTipo[]): Set<MovimentoTipo> {
  const set = new Set(tipos);
  if (set.has("ACERTO_STOCK")) {
    for (const t of TIPOS_ACERTO_STOCK) set.add(t);
  }
  return set;
}
