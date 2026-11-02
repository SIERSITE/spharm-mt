/**
 * lib/reporting/layout-largura.ts
 *
 * REGRA DE LARGURA E PAPEL do Mapa de Vendas numa SÓ tabela contínua (2026-11).
 *
 * Antes, um período acima de 13 meses repartia-se em «blocos temporais» (Parte 1 de 2, Parte 2 de 2…): cada artigo repetia-se
 * em cada bloco. Isso acabou. Agora a falta de largura resolve-se SEMPRE com o papel e a tipografia — nunca repetindo artigos
 * nem separando meses por páginas. Esta função é PURA (sem DOM, sem I/O): dados os textos já formatados de cada coluna
 * (o maior número de dígitos, valores negativos e elevados incluídos), decide
 *
 *   1. papel: A4 horizontal (297 × 210 mm) se couber com folga, senão A3 horizontal (420 × 297 mm);
 *   2. densidade tipográfica (cozy → tight → ultratight, ver METRICAS);
 *   3. se nem o A3 chegar (período MUITO longo): degradação controlada — meses abreviados («J\n26»), margens de 6 mm e, no
 *      limite absoluto, um factor de escala (`zoom`) com aviso. Nunca blocos, nunca cortar um número.
 *
 * ── VALORES (todos em mm, salvo indicação; 1 px CSS = 25,4/96 mm) ────────────────────────────────────────────────────────
 *   Área útil A4 horizontal ........ 297 − 2×8 = 281 mm      Área útil A3 horizontal ........ 420 − 2×8 = 404 mm
 *   Margens laterais ............... 8 mm (6 mm só na degradação)   Margens verticais: 10 mm (inalteradas)
 *   Tipografia mínima (px CSS) ..... números 9,5 px = 7,1 pt (texto 8,5 px + 1 px dos números), texto 8,5 px = 6,4 pt,
 *                                    cabeçalhos 7,5 px = 5,6 pt (densidade ultratight — o piso; nunca abaixo, salvo o zoom do limite)
 *   Coluna de mês .................. mínimo 7,5 mm e a largura do SEU texto mais largo (até ao total do mês, com sinal e
 *                                    separador de milhares); confortável 11,8 mm (17,4 mm até 6 meses) se sobrar espaço
 *   Descrição ...................... mínimo legível 34 mm (≈ 12 % do A4) — abaixo disso passa-se ao A3; 31 mm na degradação
 *   Folga ........................... o mínimo de tudo tem de caber com 2 mm de sobra para se escolher um papel
 *
 * Cada medida de texto usa uma métrica CONSERVADORA (fonte larga, DejaVu, a que o Chromium do contentor usa se faltar Arial)
 * e +4 % de segurança: um número nunca fica «…» nem sobreposto.
 */

export type PapelRelatorio = "A4" | "A3";
export type DensidadeTabela = "cozy" | "tight" | "ultratight";

/** Dimensões do papel em orientação horizontal (mm). */
export const PAPEL_HORIZONTAL_MM: Record<PapelRelatorio, { largura: number; altura: number }> = {
  A4: { largura: 297, altura: 210 },
  A3: { largura: 420, altura: 297 },
};

/** Dimensões do papel em orientação vertical (mm). */
export const PAPEL_VERTICAL_MM: Record<PapelRelatorio, { largura: number; altura: number }> = {
  A4: { largura: 210, altura: 297 },
  A3: { largura: 297, altura: 420 },
};

export const PX_POR_MM = 96 / 25.4;
export const MARGEM_LATERAL_MM = 8;
export const MARGEM_LATERAL_DEGRADADA_MM = 6;
export const MARGEM_VERTICAL_MM = 10;
export const FOLGA_MM = 2;

export const MES_MINIMO_MM = 7.5;
/** Mínimo do mês na degradação (3 dígitos a 8,5 px). */
export const MES_MINIMO_COMPACTO_MM = 6.5;
export const MES_CONFORTO_MM = 11.8;
export const MES_CONFORTO_POUCOS_MM = 17.4;
/** Até este nº de meses os meses são «arejados» (cozy). */
export const POUCOS_MESES = 6;
export const DESCRICAO_MIN_MM = 34;
export const DESCRICAO_MIN_DEGRADADA_MM = 31;
/** Alvo de descrição quando sobra espaço (≈ 14 % do A4) e, com poucos meses, uma descrição mais larga. */
export const DESCRICAO_PREFERIDA_MM = 40;
export const DESCRICAO_PREFERIDA_POUCOS_MESES_MM = 62;

/** Aumento dos NÚMEROS (valores, quantidades, stock, totais) face ao texto da tabela, em px — ver `.num` em report-html.ts. */
export const AUMENTO_NUMEROS_PX = 1;
/** Mais 2 px (as duas bordas finas) na coluna «Total unid.», que tem fundo e filetes próprios. */
export const EXTRA_COLUNA_DESTACADA_PX = 2;
/** +8 px: a caixa/inversão do indicador de stock (padding + moldura). */
export const EXTRA_COLUNA_STOCK_PX = 8;

/** Tipografia MÍNIMA documentada (px CSS) — os testes medem o PDF real contra estes pisos (× 0,75 = pt). */
export const MIN_FONTE_NUMERO_PX = 9;
export const MIN_FONTE_TEXTO_PX = 8.5;
export const MIN_FONTE_CABECALHO_PX = 7.5;

/** Fontes/paddings reais do CSS (report-html.ts, `.hierarchy-clean .table-density-*`). */
export const METRICAS: Record<DensidadeTabela, { td: number; th: number; pad: number }> = {
  cozy: { td: 10, th: 9, pad: 5 },
  tight: { td: 9, th: 8, pad: 4 },
  ultratight: { td: 8.5, th: 7.5, pad: 3 },
};

const ORDEM_DENSIDADE: DensidadeTabela[] = ["cozy", "tight", "ultratight"];

/** Densidade «natural» pelo nº de meses (a de sempre para ≤ 13 meses). */
export function densidadePreferida(nMeses: number): DensidadeTabela {
  if (nMeses <= POUCOS_MESES) return "cozy";
  if (nMeses <= 10) return "tight";
  return "ultratight";
}

/** Textos já formatados (como o HTML/PDF os vai desenhar) de cada coluna, para medir a largura. */
export type TextosDasColunas = {
  codigo: string[];
  farmacia: string[];
  pvp: string[];
  custoUnitario: string[];
  custoTotal: string[];
  valor: string[];
  totalUnid: string[];
  stock: string[];
  mes: string[];
};

/** Largura estimada, em px, de um texto — por excesso (dígito de uma fonte larga ≈ 0.64 em). */
export function larguraTextoPx(texto: string, fontPx: number, negrito: boolean): number {
  let em = 0;
  for (const ch of texto) {
    if (/[0-9€]/.test(ch)) em += 0.64;
    else if (/[\s.,  ·–—'-]/.test(ch)) em += 0.34;
    else if (/[A-Z]/.test(ch)) em += 0.72;
    else em += 0.62;
  }
  return em * fontPx * (negrito ? 1.1 : 1);
}

/** Largura, em mm, de uma coluna que tem de mostrar TODOS estes textos e este cabeçalho (linhas separadas por «\n») sem cortar. */
export function larguraColunaMm(textos: string[], cabecalho: string, d: DensidadeTabela, extraPx = 0, numerico = true, padPx?: number): number {
  const m = { ...METRICAS[d], ...(padPx !== undefined ? { pad: padPx } : {}) };
  let max = 0;
  const tdPx = m.td + (numerico ? AUMENTO_NUMEROS_PX : 0);
  // negrito por excesso: as linhas de subtotal/total partilham a coluna.
  for (const t of textos) max = Math.max(max, larguraTextoPx(t, tdPx, true));
  max += extraPx;
  for (const linha of cabecalho.split("\n")) max = Math.max(max, larguraTextoPx(linha, m.th, true));
  const px = max + 2 * m.pad + 3; // padding + bordas
  return (px / PX_POR_MM) * 1.04;
}

export type EntradaLayout = {
  nMeses: number;
  /** Preços de venda (PVP, valor de vendas) e de compra (custos): colunas que não existem quando a classe está desligada. */
  incluirVenda: boolean;
  incluirCompra: boolean;
  textos: TextosDasColunas;
  /** Opcional: força o papel (testes); omitido = decide a regra. */
  papelForcado?: PapelRelatorio;
};

/** Largura MÍNIMA (mm) de cada coluna fixa e do mês, na densidade escolhida. */
export type LarguraColunasMm = {
  codigo: number;
  farmacia: number;
  pvp: number;
  custoUnitario: number;
  custoTotal: number;
  totalUnid: number;
  stock: number;
  valor: number;
  mes: number;
};

export type DecisaoLayout = {
  papel: PapelRelatorio;
  densidade: DensidadeTabela;
  margemLateralMm: number;
  /** Largura útil do papel horizontal menos as margens (mm). */
  larguraUtilMm: number;
  /** Largura mínima legível de todas as colunas (fixas + N meses + descrição mínima), em mm. */
  larguraMinimaMm: number;
  /** Larguras mínimas por coluna (mm). */
  minimos: LarguraColunasMm;
  /** Larguras finais, em % da largura da tabela (a soma é 100). */
  pct: LarguraColunasMm & { descricao: number };
  /** Rótulos de mês abreviados («J\n26»): só na degradação. */
  mesesAbreviados: boolean;
  /** Factor de escala (< 1) só no limite absoluto (nem o A3 degradado chega); 1 = sem escala. */
  zoom: number;
  /** `true` se foi preciso abreviar meses / reduzir margens / escalar. */
  degradado: boolean;
  /** Alguma densidade normal (sem degradar) cabe em A4 horizontal com folga? (`papel` é «A3» exatamente quando é `false`.) */
  cabeEmA4: boolean;
  /** Nenhum papel chega ao piso tipográfico: aplicado o zoom e registado o aviso. */
  excedeLimite: boolean;
  aviso?: string;
};

type Candidato = { papel: PapelRelatorio; densidade: DensidadeTabela; margem: number; abreviado: boolean; descMin: number };

/** Degradação: células dos meses com 1,5 px de padding lateral e números SEM o +1 px (piso: texto 8,5 px). */
export const PAD_MES_COMPACTO_PX = 1.5;

function minimosPara(e: EntradaLayout, d: DensidadeTabela, abreviado: boolean): LarguraColunasMm {
  const t = e.textos;
  return {
    codigo: larguraColunaMm(t.codigo, "CNP", d, 0, false),
    farmacia: larguraColunaMm([...t.farmacia, "TOTAL ARTIGO"], "Farmácia", d, 0, false),
    pvp: e.incluirVenda ? larguraColunaMm(t.pvp, "PVP", d) : 0,
    custoUnitario: e.incluirCompra ? larguraColunaMm(t.custoUnitario, "Custo\nunit. est.", d) : 0,
    custoTotal: e.incluirCompra ? larguraColunaMm(t.custoTotal, "Custo total\nest.", d) : 0,
    totalUnid: larguraColunaMm(t.totalUnid, "Total\nUnid.", d, EXTRA_COLUNA_DESTACADA_PX),
    stock: larguraColunaMm(t.stock, "Stock", d, EXTRA_COLUNA_STOCK_PX),
    valor: e.incluirVenda ? larguraColunaMm(t.valor, "Valor Vendas\n(s/IVA)", d) : 0,
    mes: abreviado
      ? Math.max(MES_MINIMO_COMPACTO_MM, larguraColunaMm(t.mes, "M\n00", d, 0, false, PAD_MES_COMPACTO_PX))
      : Math.max(MES_MINIMO_MM, larguraColunaMm(t.mes, "Mmm\n00", d)),
  };
}

const somaFixos = (m: LarguraColunasMm) => m.codigo + m.farmacia + m.pvp + m.custoUnitario + m.custoTotal + m.totalUnid + m.stock + m.valor;

/** Descrição preferida (mm) para o nº de meses (arejado com poucos meses). */
function descricaoPreferida(nMeses: number): number {
  return nMeses <= POUCOS_MESES ? DESCRICAO_PREFERIDA_POUCOS_MESES_MM : DESCRICAO_PREFERIDA_MM;
}

/** Sequência de candidatos, do mais confortável (A4, densidade natural) ao mais apertado (A3 degradado). */
function candidatos(nMeses: number, papelForcado?: PapelRelatorio): Candidato[] {
  const out: Candidato[] = [];
  const pref = ORDEM_DENSIDADE.indexOf(densidadePreferida(nMeses));
  const papeis: PapelRelatorio[] = papelForcado ? [papelForcado] : ["A4", "A3"];
  for (const papel of papeis) {
    // A4: parte da densidade natural dos meses e aperta; A3: parte da mais confortável (o papel maior paga o conforto).
    const desde = papel === "A4" ? pref : 0;
    for (let i = desde; i < ORDEM_DENSIDADE.length; i++) {
      out.push({ papel, densidade: ORDEM_DENSIDADE[i], margem: MARGEM_LATERAL_MM, abreviado: false, descMin: DESCRICAO_MIN_MM });
    }
  }
  const ultimo = papelForcado ?? "A3";
  out.push({ papel: ultimo, densidade: "ultratight", margem: MARGEM_LATERAL_DEGRADADA_MM, abreviado: true, descMin: DESCRICAO_MIN_DEGRADADA_MM });
  return out;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function decidirLayout(e: EntradaLayout): DecisaoLayout {
  const cands = candidatos(e.nMeses, e.papelForcado);
  let escolhido: Candidato | null = null;
  let minimos!: LarguraColunasMm;
  let minimo = 0;
  let util = 0;
  for (const c of cands) {
    const m = minimosPara(e, c.densidade, c.abreviado);
    const necessario = somaFixos(m) + e.nMeses * m.mes + c.descMin;
    const u = PAPEL_HORIZONTAL_MM[c.papel].largura - 2 * c.margem;
    // última tentativa (degradada): fica com ela mesmo que não caiba (ver `excedeLimite`)
    const ultima = c === cands[cands.length - 1];
    if (necessario + FOLGA_MM <= u || ultima) {
      escolhido = c; minimos = m; minimo = necessario; util = u;
      if (necessario + FOLGA_MM <= u) break;
    }
  }
  const c = escolhido!;
  const cabe = minimo + FOLGA_MM <= util;
  const degradado = c.abreviado;
  const excedeLimite = !cabe;
  // Largura sobre a qual se repartem as percentagens: a útil, ou — se nada chega — a necessária (o zoom devolve-a à útil).
  const base = excedeLimite ? minimo : util;
  const zoom = excedeLimite ? util / minimo : 1;

  const fixos = somaFixos(minimos);
  const disponivel = base - fixos;
  const n = e.nMeses;
  const conforto = n <= POUCOS_MESES ? MES_CONFORTO_POUCOS_MM : MES_CONFORTO_MM;
  const descAlvo = Math.max(c.descMin, descricaoPreferida(n));
  let porMes = n > 0 ? Math.max(minimos.mes, conforto) : 0;
  if (n > 0 && disponivel - porMes * n < descAlvo) porMes = Math.max(minimos.mes, (disponivel - descAlvo) / n);
  const descricao = Math.max(0, disponivel - porMes * n);
  const pc = (mm: number) => (mm / base) * 100;

  const aviso = excedeLimite
    ? `Período de ${n} meses acima do limite legível do ${c.papel} horizontal: tipografia escalada a ${Math.round(zoom * 100)} % para caber numa só tabela (abaixo do piso de leitura).`
    : degradado
      ? `Período de ${n} meses: meses abreviados e margens de ${c.margem} mm para caber numa só tabela em ${c.papel} horizontal.`
      : undefined;

  return {
    papel: c.papel,
    densidade: c.densidade,
    margemLateralMm: c.margem,
    larguraUtilMm: util,
    larguraMinimaMm: r2(minimo),
    minimos,
    pct: {
      codigo: pc(minimos.codigo), farmacia: pc(minimos.farmacia), pvp: pc(minimos.pvp), custoUnitario: pc(minimos.custoUnitario),
      custoTotal: pc(minimos.custoTotal), totalUnid: pc(minimos.totalUnid), stock: pc(minimos.stock), valor: pc(minimos.valor),
      mes: pc(porMes), descricao: pc(descricao),
    },
    mesesAbreviados: c.abreviado,
    zoom,
    degradado,
    cabeEmA4: c.papel === "A4" && cabe,
    excedeLimite,
    aviso,
  };
}

/**
 * Nº máximo de meses que cabem SEM degradar (A3, densidade ultratight, margens de 8 mm) para estes textos de coluna — o limite
 * «confortável» documentado. Acima dele entra a degradação controlada; ver `decidirLayout`.
 */
export function maximoMesesSemDegradar(base: Omit<EntradaLayout, "nMeses">, limite = 240): number {
  let ultimo = 0;
  for (let n = 1; n <= limite; n++) {
    const d = decidirLayout({ ...base, nMeses: n });
    if (d.degradado || d.excedeLimite) break;
    ultimo = n;
  }
  return ultimo;
}
