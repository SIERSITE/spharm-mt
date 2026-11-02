/**
 * lib/reporting/layout-largura.ts
 *
 * REGRA DE LARGURA do Mapa de Vendas: UMA só tabela, A4 horizontal (297 × 210 mm) SEMPRE (PDF, impressão, PDF do email e
 * pré-visualização), legível impresso diretamente em A4, sem ampliação. Sem A3, sem blocos, sem letra pequena.
 *
 * Função PURA (sem DOM, sem I/O). Dois regimes:
 *
 *  1. ATÉ 14 MESES — GARANTIA POR LIMITES NUMÉRICOS FIXOS (`LIMITES`). Se todos os valores do relatório estão dentro dos limites, os 14 meses
 *     (e menos) CABEM SEMPRE, com preços de venda E compra, corpo ≥ 8 pt e Descrição ≥ 45 mm. Não há heurística sobre os dados: a prova é o
 *     orçamento de largura do PIOR CASO SIMULTÂNEO (`orcamentoPiorCaso`), calculado com larguras reais de glifo e verificado por teste.
 *     Só se recusa (422 + mensagem com o limite concreto) quando algum valor ultrapassa os limites.
 *  2. ACIMA DE 14 MESES — a capacidade depende dos DADOS (largura do maior texto de cada coluna): `mesesMax` diz até quantos meses cabem.
 *
 * ── LIMITES (documentados em notes/vendas-tabela-unica.md) ───────────────────────────────────────────────────────────────────────────────
 *   PVP e custo unitário ............ até 9 999,99 € (em módulo)        qualquer valor MENSAL (célula, TOTAL ARTIGO, TOTAL GERAL) ... até 99 999 (±)
 *   Total unid. e Stock (linhas, TOTAL ARTIGO, TOTAL GERAL) ... até 999 999 (±)      Descrição ... qualquer comprimento (quebra), mínimo 45 mm
 *   Farmácia ... qualquer nome (quebra em várias linhas), coluna de, no máximo, 14,8 mm; «TOTAL ARTIGO» em duas linhas.
 *
 * ── REGRAS DE POUPANÇA DE LARGURA (por esta ordem; nunca baixam o corpo de 8 pt) ──────────────────────────────────────────────────────────
 *   cabeçalhos compactos («PVP €», «Custo unit. €», «Out/25» numa linha) · «€» fora das células (vai no cabeçalho; o Excel não muda) ·
 *   margens laterais de 6 mm (≥ 5 mm de segurança) · padding horizontal 5 → 1,5 px · Farmácia a quebrar linha · larguras por dígitos máximos ·
 *   Descrição é a coluna elástica (fica com o resto).
 */
import { larguraTextoPx } from "./metricas-fonte";
/** Formatação das mensagens: sempre com separador de milhares («9 999,99 €», «99 999»). */
const fmtEuro = (v: number) => `${new Intl.NumberFormat("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: "always" }).format(v)} €`;
const fmtInt = (v: number) => new Intl.NumberFormat("pt-PT", { maximumFractionDigits: 0, useGrouping: "always" }).format(v);

export const PX_POR_MM = 96 / 25.4;
/** A4 horizontal. */
export const A4_HORIZONTAL_MM = { largura: 297, altura: 210 } as const;
export const MARGEM_LATERAL_MM = 8;
/** Margem lateral do Mapa de Vendas (A4 horizontal): pequena mas segura (≥ 5 mm de qualquer impressora de escritório). */
export const MARGEM_LATERAL_VENDAS_MM = 6;
export const MARGEM_VERTICAL_MM = 10;
/** Largura útil (mm) do A4 horizontal com as margens do Mapa de Vendas. */
export const LARGURA_UTIL_MM = A4_HORIZONTAL_MM.largura - 2 * MARGEM_LATERAL_VENDAS_MM;

/** Tipografia: TUDO na tabela (corpo e cabeçalhos) a 10,7 px = 8,025 pt (o Chromium escreve ≥ 8,0 pt no PDF). Piso: 8 pt. */
export const FONTE_PX = 10.7;
export const FONTE_PT = (FONTE_PX * 3) / 4;
export const MIN_FONTE_TABELA_PT = 8;

/** Os 14 meses do pedido do utilizador: cabem sempre dentro dos `LIMITES`. */
export const MESES_GARANTIDOS = 14;

/** LIMITES NUMÉRICOS FIXOS que garantem os 14 meses numa página A4 (valores em módulo). */
export const LIMITES = {
  /** PVP e custo unitário (€). */
  preco: 9999.99,
  /** Qualquer valor mensal: célula, TOTAL ARTIGO e TOTAL GERAL. */
  mes: 99999,
  /** Total unid. (linhas, TOTAL ARTIGO, TOTAL GERAL). */
  total: 999999,
  /** Stock (linhas, TOTAL ARTIGO, TOTAL GERAL). */
  stock: 999999,
} as const;

/** Paddings horizontais (px) tentados, do mais arejado ao mais apertado: reduz-se o padding ANTES de reduzir a letra. */
export const PADDINGS_PX = [5, 4, 3, 2.5, 2, 1.5] as const;
/** Padding com que a garantia dos 14 meses é calculada (o mais apertado). */
export const PAD_GARANTIA_PX = 1.5;
/** Folga mínima (mm) exigida à soma das colunas mínimas. */
export const FOLGA_MM = 1;
/** Descrição: mínimo GARANTIDO e largura preferida (mm). */
export const DESCRICAO_MIN_MM = 45;
export const DESCRICAO_PREFERIDA_MM = 55;
/**
 * Coluna Farmácia: o CONTEÚDO tem no máximo isto (px; cabe «Silveirense»); palavras mais compridas quebram dentro da palavra e os nomes com
 * várias palavras e «TOTAL ARTIGO» quebram linha.
 */
export const FARMACIA_CONTEUDO_MAX_PX = 54;
/** Largura «confortável» de um mês (mm) quando sobra espaço: arejada com poucos meses. */
export const MES_CONFORTO_MM = 11;
export const MES_CONFORTO_POUCOS_MM = 16;
export const POUCOS_MESES = 6;

/** Bordas (px) que ocupam largura dentro da coluna: filete esquerdo (e o direito do último) do mês; os dois da «Total unid.». */
const BORDA_MES_PX = 2;
const BORDA_TOTAL_PX = 2;
/** Caixa/pastilha do indicador de stock (padding + moldura). */
const EXTRA_STOCK_PX = 6;
/** Margem de segurança sobre a largura medida (arredondamentos do motor de texto): +1 % e +1 px. */
const SEGURANCA_REL = 1.01;
const SEGURANCA_PX = 1;

/** Rótulos dos cabeçalhos (negrito); «\n» = cabeçalho em duas linhas. O «€» das colunas de preço vai AQUI (as células não o repetem). */
export const ROTULOS_CABECALHO = {
  codigo: "CNP",
  descricao: "Descrição",
  farmacia: "Farmácia",
  pvp: "PVP €",
  custoUnitario: "Custo\nunit. €",
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

/** Maiores valores (em módulo) do relatório — para verificar os `LIMITES`. */
export type Maximos = { pvp: number; custoUnitario: number; mes: number; totalUnid: number; stock: number };

export type OpcoesCapacidade = {
  /** «Incluir preços de venda»: existe a coluna PVP. */
  incluirVenda: boolean;
  /** «Incluir preços de compra»: existe a coluna Custo unitário. */
  incluirCompra: boolean;
};

export type DadosCapacidade = { nMeses: number; textos: TextosDasColunas; maximos?: Maximos };

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
  /** Nº máximo de meses que cabem em A4 ≥ 8 pt: ≥ 14 dentro dos limites; acima de 14 depende dos dados. */
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
  /** Limites numéricos ultrapassados (só até 14 meses): uma frase por limite, com o valor e o limite concretos. */
  excessos: string[];
  /** Mensagem em português quando `cabe` é falso. */
  mensagem?: string;
};

/** Texto da mensagem de excesso de MESES (UI e HTTP 422). */
export function mensagemExcesso(nMeses: number, mesesMax: number): string {
  return `O período de ${nMeses} meses não cabe numa página A4 legível (máximo ${mesesMax} meses com estas opções). Reduza o período, retire preços ou use o Excel.`;
}

const SUFIXO_LIMITE = "do PDF A4 legível. Reduza a seleção, retire preços ou use o Excel.";

/** Limites ultrapassados por estes máximos (vazio = dentro dos limites). Mensagens com o valor e o limite concretos. */
export function verificarLimites(m: Maximos, o: OpcoesCapacidade): string[] {
  const out: string[] = [];
  if (o.incluirVenda && m.pvp > LIMITES.preco) out.push(`PVP de ${fmtEuro(m.pvp)} excede o limite de ${fmtEuro(LIMITES.preco)} ${SUFIXO_LIMITE}`);
  if (o.incluirCompra && m.custoUnitario > LIMITES.preco) out.push(`Custo unitário de ${fmtEuro(m.custoUnitario)} excede o limite de ${fmtEuro(LIMITES.preco)} ${SUFIXO_LIMITE}`);
  if (m.mes > LIMITES.mes) out.push(`Valor mensal de ${fmtInt(m.mes)} unidades excede o limite de ${fmtInt(LIMITES.mes)} ${SUFIXO_LIMITE}`);
  if (m.totalUnid > LIMITES.total) out.push(`Total de unidades de ${fmtInt(m.totalUnid)} excede o limite de ${fmtInt(LIMITES.total)} ${SUFIXO_LIMITE}`);
  if (m.stock > LIMITES.stock) out.push(`Stock de ${fmtInt(m.stock)} excede o limite de ${fmtInt(LIMITES.stock)} ${SUFIXO_LIMITE}`);
  return out;
}

const mm = (px: number) => px / PX_POR_MM;

/**
 * Largura (px) de uma coluna: o maior texto do corpo (negrito, por excesso; + `extraCorpoPx` da caixa do stock) ou do cabeçalho
 * (as linhas separadas por «\n»), + padding + bordas (`bordasPx`, que contam para o corpo E para o cabeçalho).
 */
function larguraColunaPx(textos: string[], cabecalho: string, pad: number, extraCorpoPx = 0, bordasPx = 0): number {
  let max = 0;
  for (const t of textos) max = Math.max(max, larguraTextoPx(t, FONTE_PX, true) + extraCorpoPx);
  for (const linha of cabecalho.split("\n")) max = Math.max(max, larguraTextoPx(linha, FONTE_PX, true));
  return max * SEGURANCA_REL + SEGURANCA_PX + 2 * pad + bordasPx;
}

/** O rótulo de cabeçalho mais largo. */
const rotuloMaisLargo = (rotulos: string[]): string =>
  rotulos.reduce((m, r) => (larguraTextoPx(r, FONTE_PX, true) > larguraTextoPx(m, FONTE_PX, true) ? r : m), rotulos[0] ?? "");

/** A palavra mais larga de cada nome (a Farmácia quebra linha entre palavras e, se preciso, dentro delas). */
const palavrasDe = (nomes: string[]): string[] => nomes.flatMap((n) => n.split(/\s+/)).filter((w) => w !== "" && w !== "TOTAL");

/** Larguras mínimas (mm) de todas as colunas para um padding. */
export function minimosPara(t: TextosDasColunas, o: OpcoesCapacidade, pad: number): LarguraColunasMm {
  const rotuloMes = t.rotulosMes.length > 0 ? t.rotulosMes : ["Out/25"];
  const farmacia = mm(Math.min(FARMACIA_CONTEUDO_MAX_PX, larguraColunaPx(palavrasDe(t.farmacia), ROTULOS_CABECALHO.farmacia, 0)) + 2 * pad);
  return {
    codigo: mm(larguraColunaPx(t.codigo, ROTULOS_CABECALHO.codigo, pad)),
    farmacia,
    pvp: o.incluirVenda ? mm(larguraColunaPx(t.pvp, ROTULOS_CABECALHO.pvp, pad)) : 0,
    custoUnitario: o.incluirCompra ? mm(larguraColunaPx(t.custoUnitario, ROTULOS_CABECALHO.custoUnitario, pad)) : 0,
    totalUnid: mm(larguraColunaPx(t.totalUnid, ROTULOS_CABECALHO.totalUnid, pad, 0, BORDA_TOTAL_PX)),
    stock: mm(larguraColunaPx(t.stock, ROTULOS_CABECALHO.stock, pad, EXTRA_STOCK_PX)),
    // o mês: o maior entre o número mais largo e o rótulo «Mmm/AA» mais largo, + filetes verticais
    mes: mm(larguraColunaPx(t.mes, rotuloMaisLargo(rotuloMes), pad, 0, BORDA_MES_PX)),
  };
}

const somaFixos = (m: LarguraColunasMm) => m.codigo + m.farmacia + m.pvp + m.custoUnitario + m.totalUnid + m.stock;

/** Textos do PIOR CASO simultâneo permitido pelos `LIMITES` (a Farmácia e o CNP são os de um relatório real: nomes longos quebram). */
export const TEXTOS_PIOR_CASO: TextosDasColunas = {
  codigo: ["6666666"],
  farmacia: ["Silveirense"],
  pvp: [formatMoeda(LIMITES.preco)],
  custoUnitario: [formatMoeda(LIMITES.preco)],
  totalUnid: [formatInteger_(-LIMITES.total)],
  stock: [formatInteger_(-LIMITES.stock)],
  mes: [formatInteger_(-LIMITES.mes)],
  rotulosMes: ["Nov/26"],
};

function formatMoeda(v: number): string {
  // «9999,99» (sem «€»: o símbolo vai no cabeçalho) — mesmo formato que as células do HTML/PDF
  return new Intl.NumberFormat("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
}

/**
 * ORÇAMENTO DE LARGURA DO PIOR CASO (mm), coluna a coluna, para `nMeses` meses ao padding da garantia. `sobraDescricao` é o que fica para a
 * Descrição na página de `LARGURA_UTIL_MM`; a garantia exige `sobraDescricao ≥ DESCRICAO_MIN_MM + FOLGA_MM` com `nMeses = 14`.
 */
export function orcamentoPiorCaso(o: OpcoesCapacidade, nMeses = MESES_GARANTIDOS, pad = PAD_GARANTIA_PX) {
  const m = minimosPara(TEXTOS_PIOR_CASO, o, pad);
  const fixos = somaFixos(m);
  const meses = nMeses * m.mes;
  return { colunas: m, fixos, meses, total: fixos + meses, sobraDescricao: LARGURA_UTIL_MM - fixos - meses, padPx: pad };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Capacidade do A4 horizontal (≥ 8 pt). Determinística e pura. Até 14 meses e dentro dos limites: SEMPRE cabe (e o padding é o maior com
 * que a Descrição preferida ainda cabe com os textos reais, nunca abaixo de `PAD_GARANTIA_PX`). Acima de 14 meses: depende dos textos.
 */
export function capacidadeA4(dados: DadosCapacidade, opcoes: OpcoesCapacidade): CapacidadeA4 {
  const n = Math.max(0, dados.nMeses);
  const util = LARGURA_UTIL_MM;
  const utilUsavel = util - FOLGA_MM;
  const padMin = PADDINGS_PX[PADDINGS_PX.length - 1];

  // A garantia dos 14 meses vale para os textos DENTRO dos limites: as larguras reais nunca excedem as do pior caso.
  const pior = orcamentoPiorCaso(opcoes);
  const garantiaOk = pior.sobraDescricao >= DESCRICAO_MIN_MM + FOLGA_MM;
  const excessos = dados.maximos && n <= MESES_GARANTIDOS ? verificarLimites(dados.maximos, opcoes) : [];

  // Larguras com os textos reais; dentro dos limites e ≤ 14 meses usam-se também os do pior caso como teto (a coluna nunca é mais larga).
  const textos = dados.textos;
  const dentroDosLimites = n <= MESES_GARANTIDOS && excessos.length === 0 && !!dados.maximos && garantiaOk;
  const minimosDe = (pad: number): LarguraColunasMm => {
    const real = minimosPara(textos, opcoes, pad);
    if (!dentroDosLimites) return real;
    const teto = minimosPara(TEXTOS_PIOR_CASO, opcoes, pad);
    return {
      codigo: real.codigo, farmacia: real.farmacia, pvp: Math.min(real.pvp, teto.pvp), custoUnitario: Math.min(real.custoUnitario, teto.custoUnitario),
      totalUnid: Math.min(real.totalUnid, teto.totalUnid), stock: Math.min(real.stock, teto.stock), mes: Math.min(real.mes, teto.mes),
    };
  };

  const maximoMeses = (pad: number): number => {
    const m = minimosDe(pad);
    return Math.max(0, Math.floor((utilUsavel - somaFixos(m) - DESCRICAO_MIN_MM) / m.mes + 1e-9));
  };
  const mesesMaxDados = maximoMeses(padMin);
  const mesesMax = dentroDosLimites ? Math.max(MESES_GARANTIDOS, mesesMaxDados) : mesesMaxDados;

  // padding: o maior com que a Descrição preferida ainda cabe com os meses ao mínimo
  let pad: number = padMin;
  for (const p of PADDINGS_PX) {
    const m = minimosDe(p);
    if (utilUsavel - somaFixos(m) - n * m.mes >= DESCRICAO_PREFERIDA_MM) { pad = p; break; }
  }
  const minimos = minimosDe(pad);
  const fixos = somaFixos(minimos);
  const minimo = fixos + n * minimos.mes + DESCRICAO_MIN_MM;
  const cabe = dentroDosLimites ? true : excessos.length > 0 ? false : n <= mesesMaxDados && minimo <= utilUsavel + 1e-9;

  // Repartição: meses ao mínimo (+ conforto se sobrar), Descrição com o resto.
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
    excessos,
    mensagem: cabe ? undefined : excessos.length > 0 ? excessos[0] : mensagemExcesso(n, mesesMax),
  };
}

/** Inteiro como a tabela o desenha (formatador do relatório; 4 dígitos sem separador, a partir de 5 com espaço). */
function formatInteger_(v: number): string {
  return new Intl.NumberFormat("pt-PT", { maximumFractionDigits: 0 }).format(v);
}
