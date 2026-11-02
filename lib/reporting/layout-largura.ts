/**
 * lib/reporting/layout-largura.ts
 *
 * REGRA DE LARGURA do Mapa de Vendas: UMA só tabela, A4 horizontal (297 × 210 mm) SEMPRE (PDF, impressão, PDF do email e
 * pré-visualização), legível impresso diretamente em A4, sem ampliação. (2026-11, segundo desenho — o primeiro usava A3
 * automático e tipografia reduzida: REJEITADO pelo utilizador; foi removido.)
 *
 * Esta função é PURA (sem DOM, sem I/O). Dado o que a tabela vai mostrar (textos já formatados de cada coluna, o nº de meses e
 * as opções de preços), `capacidadeA4` diz se cabe numa página A4 legível e, se não, quantos meses caberiam.
 *
 * ── REGRAS (todas medidas em mm, salvo indicação; 1 px CSS = 25,4/96 mm; 1 pt = 4/3 px) ───────────────────────────────────
 *   Papel .......................... A4 horizontal, nunca A3, nunca escala. Margens: 6,5 mm laterais (seguras para impressoras
 *                                     de escritório, ≥ 5 mm), 10 mm em cima/baixo ⇒ largura útil 297 − 2×6,5 = 284 mm.
 *   Tipografia ..................... corpo da tabela (CNP, Descrição, Farmácia, PVP, custo, MESES, total, stock) 8,25 pt (11 px);
 *                                     cabeçalhos 8 pt NEGRITO. NUNCA abaixo de 8 pt. CNP e Descrição ≥ valores mensais (iguais).
 *   Ordem de poupança de largura ... 1. meses abreviados «Out/25» numa linha só (cabeçalho a negrito);
 *                                     2. margens pequenas mas seguras (6,5 mm);
 *                                     3. padding horizontal das células: 5 → 4 → 3 → 2,5 → 2 px, ANTES de tocar na letra;
 *                                     4. cada mês só com a largura do SEU maior texto (nº de dígitos do maior valor mensal,
 *                                        negativos e separador de milhares incluídos), medida com larguras reais de glifo
 *                                        (metricas-fonte.ts — Arial/Liberation Sans);
 *                                     5. Descrição com quebra de linha (mínimo legível 32 mm; preferida 48 mm);
 *                                     6. PVP e custo unitário compactos; totais financeiros acumulados FORA da tabela
 *                                        (resumo financeiro no fim do relatório);
 *                                     7. nunca truncar um número, nunca reticências num valor.
 *   Se mesmo assim as colunas não cabem (período muito longo) o relatório NÃO é gerado em PDF/impressão/pré-visualização:
 *   `cabe = false` e a mensagem de `mensagemExcesso` é mostrada (a API devolve 422). O Excel e a tabela do ecrã não têm limite.
 */
import { larguraTextoPx } from "./metricas-fonte";

export const PX_POR_MM = 96 / 25.4;
/** A4 horizontal. */
export const A4_HORIZONTAL_MM = { largura: 297, altura: 210 } as const;
export const MARGEM_LATERAL_MM = 8;
/** Margem lateral do Mapa de Vendas (A4 horizontal): pequena mas segura (≥ 5 mm de qualquer impressora de escritório). */
export const MARGEM_LATERAL_VENDAS_MM = 6.5;
export const MARGEM_VERTICAL_MM = 10;
/** Largura útil (mm) do A4 horizontal com as margens do Mapa de Vendas. */
export const LARGURA_UTIL_MM = A4_HORIZONTAL_MM.largura - 2 * MARGEM_LATERAL_VENDAS_MM;

/**
 * Tipografia (pt): piso de 8 pt para TUDO o que está na tabela. Corpo (CNP, Descrição, Farmácia, PVP, custo, MESES, totais, stock) a
 * 8,25 pt (= 11 px CSS — o mesmo tamanho dos números da solução A3 rejeitada, para a letra impressa nunca ser menor do que era) e
 * cabeçalhos a negrito a 8 pt. CNP e Descrição têm o mesmo tamanho dos valores mensais.
 */
export const FONTE_CORPO_PT = 8.25;
export const FONTE_CABECALHO_PT = 8;
export const FONTE_CORPO_PX = (FONTE_CORPO_PT * 4) / 3;
export const FONTE_CABECALHO_PX = (FONTE_CABECALHO_PT * 4) / 3;
export const MIN_FONTE_TABELA_PT = 8;

/** Paddings horizontais (px) tentados, do mais arejado ao mais apertado: reduz-se o padding ANTES de reduzir a letra. */
export const PADDINGS_PX = [5, 4, 3, 2.5, 2] as const;
/** Folga mínima (mm) exigida à soma das colunas mínimas para dar o relatório como «cabe». */
export const FOLGA_MM = 1;
/** Descrição: mínimo legível e largura preferida (mm). */
export const DESCRICAO_MIN_MM = 32;
export const DESCRICAO_PREFERIDA_MM = 48;
/** Largura «confortável» de um mês (mm) quando sobra espaço: arejada com poucos meses. */
export const MES_CONFORTO_MM = 11;
export const MES_CONFORTO_POUCOS_MM = 16;
export const POUCOS_MESES = 6;

/** Bordas (px) que ocupam largura dentro da coluna: filete esquerdo (e o direito do último) do mês; os dois da «Total unid.». */
const BORDA_MES_PX = 2;
const BORDA_TOTAL_PX = 2;
/** Caixa/pastilha do indicador de stock (padding + moldura). */
const EXTRA_STOCK_PX = 8;
/** Margem de segurança sobre a largura medida (arredondamentos do motor de texto): +1 % e +1 px. */
const SEGURANCA_REL = 1.01;
const SEGURANCA_PX = 1;

/** Rótulos dos cabeçalhos (negrito, 8 pt); «\n» = cabeçalho em duas linhas. */
export const ROTULOS_CABECALHO = {
  codigo: "CNP",
  descricao: "Descrição",
  farmacia: "Farmácia",
  pvp: "PVP",
  custoUnitario: "Custo\nunit. est.",
  totalUnid: "Total\nunid.",
  stock: "Stock",
} as const;

/** Textos já formatados (como o HTML/PDF os vai desenhar) de cada coluna da tabela principal, para medir a largura. */
export type TextosDasColunas = {
  codigo: string[];
  farmacia: string[];
  pvp: string[];
  custoUnitario: string[];
  totalUnid: string[];
  stock: string[];
  /** Todos os textos das células dos meses (linhas, TOTAL ARTIGO e TOTAL GERAL). */
  mes: string[];
  /** Rótulos de cabeçalho dos meses, abreviados numa linha («Out/25»). */
  rotulosMes: string[];
};

export type OpcoesCapacidade = {
  /** «Incluir preços de venda»: existe a coluna PVP. */
  incluirVenda: boolean;
  /** «Incluir preços de compra»: existe a coluna Custo unitário. */
  incluirCompra: boolean;
};

export type DadosCapacidade = { nMeses: number; textos: TextosDasColunas };

/** Largura MÍNIMA (mm) de cada coluna fixa e do mês, ao padding escolhido. */
export type LarguraColunasMm = {
  codigo: number;
  farmacia: number;
  pvp: number;
  custoUnitario: number;
  totalUnid: number;
  stock: number;
  mes: number;
};

export type CapacidadeA4 = {
  /** O período (nº de meses) cabe numa página A4 horizontal legível (≥ 8 pt)? */
  cabe: boolean;
  nMeses: number;
  /** Nº máximo de meses que caberiam em A4 ≥ 8 pt com ESTES dados e opções (0 se nem as colunas fixas cabem). */
  mesesMax: number;
  /** Padding horizontal (px) das células. */
  padPx: number;
  larguraUtilMm: number;
  /** Largura mínima das colunas (fixas + N meses + Descrição mínima), mm. */
  larguraMinimaMm: number;
  minimos: LarguraColunasMm;
  descricaoMm: number;
  /** Larguras finais, em % da largura da tabela (soma 100). Descrição e mês incluídos (`mes` = por coluna de mês). */
  pct: LarguraColunasMm & { descricao: number };
  /** Mensagem em português quando `cabe` é falso. */
  mensagem?: string;
};

/** Texto da mensagem de excesso (UI e HTTP 422). */
export function mensagemExcesso(nMeses: number, mesesMax: number): string {
  return `O período de ${nMeses} meses não cabe numa página A4 legível (máximo ${mesesMax} meses com estas opções). Reduza o período, retire preços ou use o Excel.`;
}

const mm = (px: number) => px / PX_POR_MM;

/**
 * Largura (px) de uma coluna: o maior texto do corpo (a 8,25 pt, negrito, por excesso; + `extraCorpoPx` da caixa do stock) ou do
 * cabeçalho (a 8 pt, negrito; as linhas separadas por «\n»), + padding + bordas (`bordasPx`, que contam para o corpo E para o cabeçalho).
 */
function larguraColunaPx(textos: string[], cabecalho: string, pad: number, extraCorpoPx = 0, bordasPx = 0): number {
  let max = 0;
  for (const t of textos) max = Math.max(max, larguraTextoPx(t, FONTE_CORPO_PX, true) + extraCorpoPx);
  for (const linha of cabecalho.split("\n")) max = Math.max(max, larguraTextoPx(linha, FONTE_CABECALHO_PX, true));
  return max * SEGURANCA_REL + SEGURANCA_PX + 2 * pad + bordasPx;
}

/** O rótulo de cabeçalho mais largo (a 8 pt, negrito). */
const rotuloMaisLargo = (rotulos: string[]): string =>
  rotulos.reduce((m, r) => (larguraTextoPx(r, FONTE_CABECALHO_PX, true) > larguraTextoPx(m, FONTE_CABECALHO_PX, true) ? r : m), rotulos[0] ?? "");

/** Larguras mínimas (mm) de todas as colunas para um padding. */
export function minimosPara(t: TextosDasColunas, o: OpcoesCapacidade, pad: number): LarguraColunasMm {
  const rotuloMes = t.rotulosMes.length > 0 ? t.rotulosMes : ["Out/25"];
  return {
    codigo: mm(larguraColunaPx(t.codigo, ROTULOS_CABECALHO.codigo, pad)),
    farmacia: mm(larguraColunaPx(t.farmacia, ROTULOS_CABECALHO.farmacia, pad)),
    pvp: o.incluirVenda ? mm(larguraColunaPx(t.pvp, ROTULOS_CABECALHO.pvp, pad)) : 0,
    custoUnitario: o.incluirCompra ? mm(larguraColunaPx(t.custoUnitario, ROTULOS_CABECALHO.custoUnitario, pad)) : 0,
    totalUnid: mm(larguraColunaPx(t.totalUnid, ROTULOS_CABECALHO.totalUnid, pad, 0, BORDA_TOTAL_PX)),
    stock: mm(larguraColunaPx(t.stock, ROTULOS_CABECALHO.stock, pad, EXTRA_STOCK_PX)),
    // o mês: o maior entre o número mais largo (corpo, 8,25 pt) e o rótulo «Mmm/AA» mais largo (cabeçalho, 8 pt), + filetes verticais
    mes: mm(larguraColunaPx(t.mes, rotuloMaisLargo(rotuloMes), pad, 0, BORDA_MES_PX)),
  };
}

const somaFixos = (m: LarguraColunasMm) => m.codigo + m.farmacia + m.pvp + m.custoUnitario + m.totalUnid + m.stock;

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Capacidade do A4 horizontal (≥ 8 pt) para estes dados e opções. Determinística e pura. Escolhe o MAIOR padding (5…2 px) com que
 * a Descrição ainda fica na largura preferida; se nenhum chega, o menor padding que mantém a Descrição ≥ 32 mm; se nem esse chega,
 * `cabe = false` (e `mesesMax` diz até quantos meses se poderia ir).
 */
export function capacidadeA4(dados: DadosCapacidade, opcoes: OpcoesCapacidade): CapacidadeA4 {
  const n = Math.max(0, dados.nMeses);
  const util = LARGURA_UTIL_MM;
  const utilUsavel = util - FOLGA_MM;

  const maximoMeses = (pad: number): number => {
    const m = minimosPara(dados.textos, opcoes, pad);
    return Math.max(0, Math.floor((utilUsavel - somaFixos(m) - DESCRICAO_MIN_MM) / m.mes + 1e-9));
  };
  // maior nº de meses possível: com o padding mais pequeno
  const padMin = PADDINGS_PX[PADDINGS_PX.length - 1];
  const mesesMax = maximoMeses(padMin);

  // padding: o maior com que a Descrição preferida ainda cabe com os meses ao mínimo
  let pad: number = padMin;
  for (const p of PADDINGS_PX) {
    const m = minimosPara(dados.textos, opcoes, p);
    if (utilUsavel - somaFixos(m) - n * m.mes >= DESCRICAO_PREFERIDA_MM) { pad = p; break; }
  }
  const minimos = minimosPara(dados.textos, opcoes, pad);
  const fixos = somaFixos(minimos);
  const minimo = fixos + n * minimos.mes + DESCRICAO_MIN_MM;
  const cabe = n <= mesesMax && minimo <= utilUsavel + 1e-9;

  // Repartição: meses ao mínimo (+ conforto se sobrar), Descrição com o resto. Se nada cabe, o mínimo (mensagem, sem PDF).
  const base = Math.max(util, cabe ? util : fixos + n * minimos.mes + DESCRICAO_MIN_MM);
  const disponivel = base - fixos;
  const conforto = n <= POUCOS_MESES ? MES_CONFORTO_POUCOS_MM : MES_CONFORTO_MM;
  let porMes = n > 0 ? Math.max(minimos.mes, conforto) : 0;
  if (n > 0 && disponivel - porMes * n < DESCRICAO_PREFERIDA_MM) porMes = Math.max(minimos.mes, (disponivel - DESCRICAO_PREFERIDA_MM) / n);
  const descricao = Math.max(0, disponivel - porMes * n);
  const pc = (v: number) => (v / base) * 100;

  return {
    cabe,
    nMeses: n,
    mesesMax,
    padPx: pad,
    larguraUtilMm: util,
    larguraMinimaMm: r2(minimo),
    minimos,
    descricaoMm: r2(descricao),
    pct: {
      codigo: pc(minimos.codigo), farmacia: pc(minimos.farmacia), pvp: pc(minimos.pvp), custoUnitario: pc(minimos.custoUnitario),
      totalUnid: pc(minimos.totalUnid), stock: pc(minimos.stock), mes: pc(porMes), descricao: pc(descricao),
    },
    mensagem: cabe ? undefined : mensagemExcesso(n, mesesMax),
  };
}
