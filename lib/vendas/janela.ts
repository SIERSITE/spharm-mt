/**
 * lib/vendas/janela.ts
 *
 * A janela temporal do relatório de Vendas. Aritmética de datas civis,
 * sem base de dados e sem rede — para poder ser testada a sério.
 *
 * ── O DEFEITO QUE ISTO FECHA ─────────────────────────────────────────
 *
 * `getVendasData` convertia `from`/`to` com um regex que lia apenas
 * `yyyy-mm`:
 *
 *     const m = /^(\d{4})-(\d{2})/.exec(iso);
 *
 * O DIA era deitado fora antes de chegar ao SQL. `01/08 → 17/08` e
 * `01/08 → 31/08` produziam o mesmo índice de mês e portanto o mesmo
 * universo. Pior: o loader devolvia como período aplicado o mês inteiro,
 * e a UI acreditava nele — a "média diária" dividia 6936 unidades por 31
 * dias em vez de 17, dando 223,7 quando a resposta era 408.
 *
 * Ninguém reparava porque o número mudava sempre que se mudava o MÊS. Só
 * não mudava dentro do mesmo mês, que é precisamente o caso operacional
 * ("como correu esta quinzena?").
 *
 * ── PORQUÊ DOIS CAMINHOS E NÃO UM ────────────────────────────────────
 *
 * `VendaMensal` é uma agregação por (farmácia, produto, ano, mês). Não
 * tem dia nenhum: nenhuma consulta lhe arranca um intervalo parcial, e
 * ratear o mês seria inventar dados. Mas para uma janela que cobre meses
 * inteiros ela é exactamente a mesma soma, já feita — e é muito mais
 * barata que varrer o raw.
 *
 * Daí `mesAlinhada()`: decide qual das duas fontes responde à pergunta
 * sem alterar a resposta. Não é uma optimização opcional que se pode
 * desligar — é a definição de quando as duas fontes são equivalentes.
 */

/** Intervalo de dias civis, AMBAS as pontas inclusivas, `YYYY-MM-DD`. */
export type JanelaVendas = {
  from: string;
  to: string;
};

const DIA_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` que existe mesmo no calendário (rejeita 2026-02-30). */
export function diaValido(v: string | null | undefined): v is string {
  if (!v) return false;
  const m = DIA_RE.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return (
    t.getUTCFullYear() === y && t.getUTCMonth() + 1 === mo && t.getUTCDate() === d
  );
}

/** Último dia do mês (28..31). UTC: é aritmética civil, não um instante. */
export function ultimoDiaDoMes(ano: number, mes: number): number {
  return new Date(Date.UTC(ano, mes, 0)).getUTCDate();
}

function iso(ano: number, mes: number, dia: number): string {
  return `${ano}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
}

/** Dia seguinte, civil. Serve para o `to` EXCLUSIVO das consultas SQL. */
export function diaSeguinte(dia: string): string {
  const m = DIA_RE.exec(dia);
  if (!m) return dia;
  const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1));
  return t.toISOString().slice(0, 10);
}

/**
 * A janela efectivamente aplicada.
 *
 * Defaults: início do ano corrente → hoje. O `to` NÃO é esticado ao fim
 * do mês — era essa esticadela que fazia a UI anunciar um período que o
 * utilizador não pediu e dividir por dias que não existiam.
 *
 * Datas inválidas caem no default em vez de rebentar: um `from` mal
 * escrito num link partilhado não deve dar erro 500, mas também não deve
 * ser silenciosamente interpretado como outra coisa — cai no default, que
 * é visível no cabeçalho do relatório.
 */
export function normalizarJanela(
  from: string | undefined,
  to: string | undefined,
  agora: Date = new Date(),
): JanelaVendas {
  const anoCorrente = agora.getUTCFullYear();
  const hoje = agora.toISOString().slice(0, 10);

  let f = diaValido(from) ? from : iso(anoCorrente, 1, 1);
  let t = diaValido(to) ? to : hoje;

  // Invertidas: troca-as em vez de devolver vazio. Um relatório vazio
  // por causa de dois campos trocados é indistinguível de "não há
  // vendas", que é a leitura errada e a mais cara.
  if (f > t) [f, t] = [t, f];

  return { from: f, to: t };
}

/**
 * A janela cobre exactamente meses inteiros?
 *
 * Só então `VendaMensal` dá a MESMA soma que o raw. Um único dia a
 * menos numa das pontas e a agregação mensal passa a incluir vendas que
 * o utilizador não pediu.
 */
export function mesAlinhada(j: JanelaVendas): boolean {
  const a = DIA_RE.exec(j.from);
  const b = DIA_RE.exec(j.to);
  if (!a || !b) return false;
  const comecaNoDia1 = Number(a[3]) === 1;
  const acabaNoUltimo =
    Number(b[3]) === ultimoDiaDoMes(Number(b[1]), Number(b[2]));
  return comecaNoDia1 && acabaNoUltimo;
}

/**
 * Os meses tocados pela janela, em ordem cronológica. São as colunas
 * do relatório — mesmo numa janela parcial, porque a pergunta "quanto
 * vendi em Agosto até dia 17" continua a ter Agosto como coluna.
 */
export function bucketsDaJanela(j: JanelaVendas): Array<{ ano: number; mes: number }> {
  const a = DIA_RE.exec(j.from);
  const b = DIA_RE.exec(j.to);
  if (!a || !b) return [];
  const inicio = Number(a[1]) * 12 + Number(a[2]);
  const fim = Number(b[1]) * 12 + Number(b[2]);
  const out: Array<{ ano: number; mes: number }> = [];
  for (let i = inicio; i <= fim; i++) {
    out.push({ ano: Math.floor((i - 1) / 12), mes: ((i - 1) % 12) + 1 });
  }
  return out;
}

/**
 * Divide a janela em meses INTEIROS (que `VendaMensal` responde) e
 * pontas PARCIAIS (que só as linhas respondem).
 *
 * Sem isto, a janela por omissão — 1 de Janeiro até hoje — cairia toda
 * no raw só porque hoje não é o último dia do mês, e varreria um ano de
 * linhas para responder ao que a agregação já tinha somado. Com a
 * decomposição, Janeiro..Julho vêm da agregação e só os 18 dias de
 * Agosto tocam nas linhas.
 *
 * Cada mês pertence a EXACTAMENTE uma das duas partes, portanto somar as
 * duas nunca conta nada duas vezes. É essa a invariante que o teste fixa.
 */
export type DecomposicaoJanela = {
  /** Índices `ano*12+mes` inclusivos, ou null se não houver mês inteiro. */
  mesesInteiros: { minIdx: number; maxIdx: number } | null;
  /** Sub-janelas de dias, no máximo duas (cabeça e cauda). */
  parciais: JanelaVendas[];
};

export function decomporJanela(j: JanelaVendas): DecomposicaoJanela {
  const a = DIA_RE.exec(j.from);
  const b = DIA_RE.exec(j.to);
  if (!a || !b) return { mesesInteiros: null, parciais: [] };

  const [ay, am, ad] = [Number(a[1]), Number(a[2]), Number(a[3])];
  const [by, bm, bd] = [Number(b[1]), Number(b[2]), Number(b[3])];
  const idxA = ay * 12 + am;
  const idxB = by * 12 + bm;

  // Um só mês: ou é inteiro, ou é um pedaço. Não há meio-termo.
  if (idxA === idxB) {
    return mesAlinhada(j)
      ? { mesesInteiros: { minIdx: idxA, maxIdx: idxA }, parciais: [] }
      : { mesesInteiros: null, parciais: [j] };
  }

  const parciais: JanelaVendas[] = [];
  const cabecaInteira = ad === 1;
  const caudaInteira = bd === ultimoDiaDoMes(by, bm);

  if (!cabecaInteira) {
    parciais.push({ from: j.from, to: iso(ay, am, ultimoDiaDoMes(ay, am)) });
  }
  if (!caudaInteira) {
    parciais.push({ from: iso(by, bm, 1), to: j.to });
  }

  const minIdx = cabecaInteira ? idxA : idxA + 1;
  const maxIdx = caudaInteira ? idxB : idxB - 1;

  return {
    mesesInteiros: maxIdx >= minIdx ? { minIdx, maxIdx } : null,
    parciais,
  };
}

/** Dias cobertos, ambas as pontas incluídas. É o divisor da média diária. */
export function diasInclusive(j: JanelaVendas): number {
  const a = Date.parse(`${j.from}T00:00:00Z`);
  const b = Date.parse(`${j.to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 1;
  return Math.max(1, Math.round((b - a) / 86_400_000) + 1);
}
