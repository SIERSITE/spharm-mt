/**
 * lib/reporting/vendas-pvp-diferente.ts
 *
 * Filtro «Apenas artigos com PVP diferente entre farmácias» do mapa de Vendas — regra pura, partilhada pela tabela, pelo
 * Relatório, pela impressão, pelo PDF, pelo Excel e pelo email (todos derivam das mesmas linhas já filtradas).
 *
 * Um artigo entra quando, considerando APENAS as farmácias selecionadas:
 *   1. está associado a pelo menos duas delas (existe ficha `ProdutoFarmacia` em ≥ 2);
 *   2. existem pelo menos dois PVP CONHECIDOS (PVP em falta — nulo, inválido ou ≤ 0 — não conta nem se compara);
 *   3. esses PVP resultam em pelo menos dois valores DISTINTOS **ao cêntimo**.
 *
 * ── Comparação comercial, ao cêntimo ─────────────────────────────────────────────────────────────────────────────────────────
 * A base guarda o PVP com 4 casas (Decimal(12,4)), mas um preço de venda é comercial: diferenças inferiores a um cêntimo NÃO são
 * divergências. Cada PVP converte-se para CÊNTIMOS INTEIROS por `centimosDoPvp` e só então se comparam inteiros — nunca números
 * de vírgula flutuante. Regra de arredondamento (explícita e determinística): **meio cêntimo arredonda para cima** («half-up», para
 * preços positivos), sobre o valor DECIMAL exato:
 *     10,0049 → 10,00 · 10,0050 → 10,01 · 10,0149 → 10,01 · 10,0150 → 10,02
 * É a mesma regra com que o ecrã/PDF/Excel apresentam o dinheiro em pt-PT (`Intl.NumberFormat`, «half-expand»), logo o que se compara
 * é o que se vê: dois PVP que aparecem iguais nunca contam como diferentes, e dois que aparecem diferentes contam sempre.
 *
 * O PVP comparado é o ATUAL de cada farmácia (`ProdutoFarmacia.pvp`), nunca o histórico das vendas (`valorBruto`) nem a cascata para
 * o PMC. O PVP nunca é alterado nem «corrigido»: o filtro só assinala divergências, não escolhe um preço «certo».
 */

/**
 * Converte um PVP para cêntimos inteiros — meio cêntimo para cima — ou `null` se for desconhecido (nulo, inválido ou ≤ 0).
 *
 * Aceita os tipos reais: `Prisma.Decimal` (o que o PostgreSQL/Prisma devolve em `Decimal(12,4)`; usa-se a sua representação decimal
 * exata, `toFixed`/`toString`), `string` decimal («10.0050»), `number` (já convertido pelo carregador; reduz-se a 4 casas, a escala
 * da base, que recupera o decimal original sem erro binário) e `bigint`. A aritmética é toda sobre dígitos: nenhum `x * 100`.
 */
export function centimosDoPvp(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  let texto: string;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    texto = v.toFixed(4);
  } else if (typeof v === "bigint") {
    texto = v.toString();
  } else if (typeof v === "string") {
    texto = v.trim();
  } else if (typeof v === "object" && typeof (v as { toFixed?: unknown }).toFixed === "function") {
    // Prisma.Decimal / decimal.js: toFixed() sem argumentos devolve o decimal exato, sem notação científica.
    texto = (v as { toFixed: () => string }).toFixed();
  } else {
    texto = String(v).trim();
  }
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(texto);
  if (!m) return null;
  if (m[1] === "-") return null; // negativo ⇒ desconhecido
  const inteira = m[2];
  const decimais = (m[3] ?? "").padEnd(3, "0");
  const centimos = Number(inteira) * 100 + Number(decimais.slice(0, 2)) + (Number(decimais[2]) >= 5 ? 1 : 0);
  return Number.isSafeInteger(centimos) && centimos > 0 ? centimos : null;
}

/** Nome histórico mantido para os chamadores: agora devolve CÊNTIMOS (ver `centimosDoPvp`). */
export const pvpEscalado = centimosDoPvp;

/** O mínimo que uma linha de vendas tem de ter para entrar na comparação. */
export type LinhaParaPvp = {
  codigo: string;
  farmacia: string;
  pvpConhecido?: number | null;
  pvpPorFarmacia?: Record<string, number | null>;
};

/**
 * A regra para UM artigo: `pvps` = PVP por farmácia (a chave presente com `null` = associado mas sem PVP; valores em qualquer dos tipos de `centimosDoPvp`); `selecionadas` = as
 * farmácias que contam.
 */
export function artigoTemPvpDiferente(pvps: Readonly<Record<string, unknown>>, selecionadas: readonly string[]): boolean {
  const conjunto = new Set(selecionadas);
  let associadas = 0;
  const conhecidos = new Set<number>(); // cêntimos
  let nConhecidos = 0;
  for (const [farmacia, valor] of Object.entries(pvps)) {
    if (!conjunto.has(farmacia)) continue;
    associadas += 1;
    const e = pvpEscalado(valor);
    if (e !== null) {
      nConhecidos += 1;
      conhecidos.add(e);
    }
  }
  return associadas >= 2 && nConhecidos >= 2 && conhecidos.size >= 2;
}

/** Junta, por CNP, o PVP de cada farmácia vindo de `pvpPorFarmacia` e do `pvpConhecido` da própria linha. */
export function pvpsPorCodigo(linhas: readonly LinhaParaPvp[]): Map<string, Record<string, number | null>> {
  const porCodigo = new Map<string, Record<string, number | null>>();
  for (const l of linhas) {
    const mapa = porCodigo.get(l.codigo) ?? {};
    if (l.pvpPorFarmacia) for (const [f, v] of Object.entries(l.pvpPorFarmacia)) if (!(f in mapa) || mapa[f] === null) mapa[f] = v;
    if (l.pvpConhecido !== undefined && (!(l.farmacia in mapa) || mapa[l.farmacia] === null)) mapa[l.farmacia] = l.pvpConhecido;
    porCodigo.set(l.codigo, mapa);
  }
  return porCodigo;
}

/** Os CNP que passam o filtro, para as farmácias selecionadas. Calculado sobre as linhas CRUAS (antes de qualquer outro filtro). */
export function codigosComPvpDiferente(linhas: readonly LinhaParaPvp[], selecionadas: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const [codigo, pvps] of pvpsPorCodigo(linhas)) if (artigoTemPvpDiferente(pvps, selecionadas)) out.add(codigo);
  return out;
}

/** O filtro só se aplica com pelo menos duas farmácias selecionadas (com uma só não há com quem comparar). */
export function filtroPvpAplicavel(nFarmaciasEfetivas: number): boolean {
  return nFarmaciasEfetivas >= 2;
}
