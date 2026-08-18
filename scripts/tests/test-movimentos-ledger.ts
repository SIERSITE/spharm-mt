/**
 * scripts/tests/test-movimentos-ledger.ts
 *
 * Fixa o extrato de movimentos da ficha de artigo.
 *
 * ── O DEFEITO QUE ISTO IMPEDE DE VOLTAR ──────────────────────────────
 *
 * `lib/movimentos-data.ts` escolhia entre dois ramos com a flag
 * `Farmacia.useMovimentosCanonical`. O ramo legacy lia `Venda`,
 * `Compra`, `Devolucao` e `AjusteStock` — e a tabela `Venda` NUNCA é
 * escrita por código nenhum. Nem transferências entre farmácias têm
 * tabela legacy.
 *
 * Com a flag a `false` (o default) nas duas farmácias em produção, o
 * extrato da Aspirina (CNP 3045580) em Agosto/2026 mostrava UMA linha
 * — a recepção de +240 — e resumia "+240 / −0". O ERP tem, no mesmo
 * período: saldo anterior 33, entradas 240, saídas 144, líquido +96,
 * existência final 129.
 *
 * A fixture abaixo é essa realidade, com os tipos que a produção tem
 * mesmo para este artigo (COMPRA, VENDA, VENDA_CREDITO,
 * DEVOLUCAO_CLIENTE, RESERVA_SUSPENSA) e com `existenciaApos` a fechar
 * em 129. Não é uma cópia das ~40 linhas do cliente — é a mesma
 * semântica com o mesmo desfecho.
 *
 * Sem base de dados e sem rede.
 *
 * Uso: npx tsx scripts/tests/test-movimentos-ledger.ts
 */
import { readFileSync } from "node:fs";
import {
  TIPO_LABELS,
  direcaoForTipo,
  expandirTiposFiltro,
  type MovimentoTipo,
} from "../../lib/movimentos-tipos";

let pass = 0;
let fail = 0;
const ok = (l: string) => { pass++; console.log(`  [OK]    ${l}`); };
const bad = (l: string, d?: string) => { fail++; console.log(`  [FALHA] ${l}${d ? `\n            ${d}` : ""}`); };
const check = (c: boolean, l: string, d?: string) => (c ? ok(l) : bad(l, d));
const eq = (a: unknown, b: unknown, l: string) =>
  check(Object.is(a, b), l, `esperado ${String(b)}, veio ${String(a)}`);

// ── Fixture: Aspirina GR 100 mg, Silveirense, 01/08–17/08/2026 ───────
//
// Saldo anterior 33. As quantidades são as do ERP e `existenciaApos` é
// o running balance depois de cada movimento — a coluna "Exist." do
// relatório Movimento de Artigos.
const SALDO_ANTERIOR = 33;

type Mov = {
  data: string;
  tipo: MovimentoTipo;
  documentoTipo: string | null;
  documentoNumero: string | null;
  contraparteNome: string | null;
  quantidade: number;
  existenciaApos: number;
};

/**
 * Os movimentos DO PERÍODO, tal como o ERP os reporta. Os totais no fim
 * do relatório (240 / 144 / +96 / 129) são sobre exactamente estes — o
 * período não teve nota de crédito nem reserva, e acrescentá-los aqui
 * faria os totais deixarem de bater com o documento.
 */
const LEDGER: Mov[] = [
  { data: "2026-08-03T09:05:09Z", tipo: "VENDA", documentoTipo: "Factura", documentoNumero: "G/816760", contraparteNome: "Joaquim Ferreira", quantidade: -1, existenciaApos: 32 },
  { data: "2026-08-03T15:24:55Z", tipo: "VENDA", documentoTipo: "Factura", documentoNumero: "G/816875", contraparteNome: "AMAVEL DOS SANTOS", quantidade: -2, existenciaApos: 30 },
  { data: "2026-08-03T18:07:58Z", tipo: "VENDA", documentoTipo: "Factura", documentoNumero: "G/816945", contraparteNome: "ANA TERESA JESUS", quantidade: -1, existenciaApos: 29 },
  // A entrada que a UI mostrava sozinha.
  { data: "2026-08-04T11:03:57Z", tipo: "COMPRA", documentoTipo: "Recepção", documentoNumero: "63707", contraparteNome: "BAYER PORTUGAL S.A.", quantidade: 240, existenciaApos: 269 },
  { data: "2026-08-04T11:07:16Z", tipo: "VENDA", documentoTipo: "Factura", documentoNumero: "G/817017", contraparteNome: "CELSO FRANCO GOMES", quantidade: -2, existenciaApos: 267 },
  // A transferência para a Segurado. No legacy não existia tabela nenhuma
  // que a pudesse conter — desaparecia sem deixar rasto.
  { data: "2026-08-04T11:42:09Z", tipo: "VENDA_CREDITO", documentoTipo: "G/Transferência", documentoNumero: "VCG_1/2671", contraparteNome: "FARMACIA SEGURADO", quantidade: -90, existenciaApos: 177 },
  { data: "2026-08-05T10:55:05Z", tipo: "VENDA", documentoTipo: "Factura", documentoNumero: "G/817208", contraparteNome: "GRACINDA JESUS ANTUNES", quantidade: -40, existenciaApos: 137 },
  { data: "2026-08-17T19:24:50Z", tipo: "VENDA", documentoTipo: "Factura", documentoNumero: "G/819504", contraparteNome: "MARIA LUISA GATO", quantidade: -8, existenciaApos: 129 },
];

/**
 * Os outros tipos que a produção tem mesmo para este artigo, fora da
 * janela reconciliada. Ficam num ledger próprio de propósito: somá-los
 * aos totais do ERP faria o teste "passar" contra números que o
 * documento não tem — que é o oposto do que ele serve.
 *
 * Saldo de partida: 129, a existência com que o período fechou.
 */
const SALDO_TIPOS = 129;
const LEDGER_TIPOS: Mov[] = [
  // Devolução de cliente: ENTRA. É o sinal que mais se troca.
  { data: "2026-08-19T09:08:25Z", tipo: "DEVOLUCAO_CLIENTE", documentoTipo: "Nota Crédito", documentoNumero: "NC/1201", contraparteNome: "Francisco Silva", quantidade: 3, existenciaApos: 132 },
  // Reserva suspensa: sai do disponível, com documento próprio.
  { data: "2026-08-19T17:46:43Z", tipo: "RESERVA_SUSPENSA", documentoTipo: "Reserva", documentoNumero: "R/338", contraparteNome: "Manuel Marques", quantidade: -2, existenciaApos: 130 },
  // Devolução ao fornecedor: SAI.
  { data: "2026-08-20T10:12:00Z", tipo: "DEVOLUCAO_FORNECEDOR", documentoTipo: "Devolução", documentoNumero: "DV/91", contraparteNome: "BAYER PORTUGAL S.A.", quantidade: -5, existenciaApos: 125 },
];

/**
 * O resumo do extrato: entradas, saídas, líquido e existência final.
 * É a mesma leitura que o rodapé do relatório do ERP faz.
 */
function resumir(movs: Mov[], saldoAnterior: number) {
  const entradas = movs.filter((m) => m.quantidade > 0).reduce((s, m) => s + m.quantidade, 0);
  const saidas = movs.filter((m) => m.quantidade < 0).reduce((s, m) => s + Math.abs(m.quantidade), 0);
  return {
    entradas,
    saidas,
    liquido: entradas - saidas,
    existenciaFinal: saldoAnterior + (entradas - saidas),
  };
}

console.log("=== o ledger reconcilia com o ERP ===");
{
  const r = resumir(LEDGER, SALDO_ANTERIOR);
  eq(r.entradas, 240, "entradas = 240 (ERP: Total Entradas 240)");
  eq(r.saidas, 144, "saídas = 144 (ERP: Total Saídas 144)");
  eq(r.liquido, 96, "líquido = +96 (ERP: Total 96)");
  eq(r.existenciaFinal, 129, "existência final = 129 (ERP: Existência 129)");
  eq(
    LEDGER[LEDGER.length - 1]!.existenciaApos,
    r.existenciaFinal,
    "…e o `existenciaApos` do último movimento diz o mesmo",
  );
}
{
  // O running balance tem de ser coerente movimento a movimento — é o
  // que permite ler o extrato de cima a baixo sem recalcular nada.
  const conferirSaldo = (movs: Mov[], inicial: number, rotulo: string) => {
    let saldo = inicial;
    for (const m of movs) {
      saldo += m.quantidade;
      if (saldo !== m.existenciaApos) {
        bad(`${rotulo}: existenciaApos desalinhado`, `${m.data} ${m.documentoNumero}: esperado ${saldo}, gravado ${m.existenciaApos}`);
        return;
      }
    }
    ok(`${rotulo}: existenciaApos acompanha o saldo em TODOS os movimentos`);
  };
  conferirSaldo(LEDGER, SALDO_ANTERIOR, "período ERP");
  conferirSaldo(LEDGER_TIPOS, SALDO_TIPOS, "tipos adicionais");
}
{
  // Devolução de cliente e devolução a fornecedor têm de mover o saldo
  // em direcções OPOSTAS. Trocá-las é o erro clássico e não dá erro
  // nenhum — só um extrato que engana.
  const r = resumir(LEDGER_TIPOS, SALDO_TIPOS);
  eq(r.entradas, 3, "a devolução de cliente é a única entrada dos tipos adicionais");
  eq(r.saidas, 7, "reserva (2) + devolução a fornecedor (5) saem");
  eq(r.existenciaFinal, 125, "…e o saldo fecha em 125");
}

console.log("\n=== o que o ramo legacy conseguia mostrar ===");
{
  // O legacy lia Compra/Devolucao/AjusteStock. Vendas e transferências
  // ficavam de fora por construção.
  const legacyConseguia = LEDGER.filter((m) => m.tipo === "COMPRA");
  const r = resumir(legacyConseguia, SALDO_ANTERIOR);
  eq(legacyConseguia.length, 1, "o legacy via UMA linha das dez");
  eq(r.entradas, 240, "…mostrava as entradas certas");
  eq(r.saidas, 0, "…e ZERO saídas — o '+240 / −0' que apareceu em produção");
  check(
    r.existenciaFinal !== 129,
    "…logo a existência final nunca podia fechar em 129",
    `dava ${r.existenciaFinal}`,
  );
}

console.log("\n=== sinais por tipo ===");
{
  // `direcaoForTipo` é o que a UI usa para colorir e para somar. Um
  // sinal trocado aqui é um extrato que engana em silêncio.
  const casos: Array<[MovimentoTipo, number, "ENTRADA" | "SAIDA"]> = [
    ["COMPRA", 240, "ENTRADA"],
    ["VENDA", -9, "SAIDA"],
    ["VENDA_CREDITO", -90, "SAIDA"],
    ["DEVOLUCAO_CLIENTE", 3, "ENTRADA"],
    ["DEVOLUCAO_FORNECEDOR", -5, "SAIDA"],
    ["RESERVA_SUSPENSA", -2, "SAIDA"],
  ];
  for (const [tipo, qtd, esperada] of casos) {
    eq(direcaoForTipo(tipo, qtd), esperada, `${tipo} com ${qtd} é ${esperada}`);
  }
}
{
  const todos = [...LEDGER, ...LEDGER_TIPOS];
  for (const m of todos) {
    const esperada = m.quantidade >= 0 ? "ENTRADA" : "SAIDA";
    if (direcaoForTipo(m.tipo, m.quantidade) !== esperada) {
      bad(`${m.tipo} ${m.quantidade}: direcção contradiz o sinal`);
    }
  }
  ok("nenhum movimento da fixture tem direcção a contradizer o seu sinal");

  for (const m of todos) {
    if (!TIPO_LABELS[m.tipo]) bad(`${m.tipo} sem rótulo em TIPO_LABELS`);
  }
  ok("todos os tipos da fixture têm rótulo legível");
}

console.log("\n=== os chips da UI cobrem o ledger ===");
{
  // Um tipo que nenhum chip apanha é um movimento que existe e que o
  // utilizador não consegue isolar.
  const chips: MovimentoTipo[][] = [
    ["VENDA", "VENDA_CREDITO"],
    ["DEVOLUCAO_CLIENTE", "DEVOLUCAO_OUTRA"],
    ["COMPRA"],
    ["DEVOLUCAO_FORNECEDOR"],
    ["RESERVA_SUSPENSA"],
  ];
  const cobertos = new Set<MovimentoTipo>();
  for (const c of chips) for (const t of expandirTiposFiltro(c)) cobertos.add(t);
  const orfaos = [...new Set([...LEDGER, ...LEDGER_TIPOS].map((m) => m.tipo))].filter(
    (t) => !cobertos.has(t),
  );
  check(orfaos.length === 0, "todos os tipos da fixture são alcançáveis por um chip", orfaos.join(", "));
}
{
  const so = expandirTiposFiltro(["COMPRA"]);
  check(so.has("COMPRA"), "o chip Compra apanha COMPRA");
  check(!so.has("VENDA"), "…e não apanha VENDA");
}

console.log("\n=== documento e contraparte sobrevivem ===");
{
  const compra = LEDGER.find((m) => m.tipo === "COMPRA")!;
  eq(compra.documentoNumero, "63707", "a recepção mantém o número do documento do ERP");
  eq(compra.contraparteNome, "BAYER PORTUGAL S.A.", "…e o fornecedor");
  const transf = LEDGER.find((m) => m.tipo === "VENDA_CREDITO")!;
  eq(transf.documentoNumero, "VCG_1/2671", "a transferência mantém a série/número compostos");
  eq(transf.contraparteNome, "FARMACIA SEGURADO", "…e a farmácia de destino");
}

console.log("\n=== o ramo legacy saiu do código ===");
{
  const src = readFileSync(new URL("../../lib/movimentos-data.ts", import.meta.url), "utf8");
  const codigo = src.replace(/\/\*[\s\S]*?\*\//g, "");
  check(!/readLegacyMovimentos/.test(codigo), "readLegacyMovimentos desapareceu");
  check(!/function legacyRow/.test(codigo), "legacyRow desapareceu");
  check(
    !/useMovimentosCanonical/.test(codigo),
    "a flag já não escolhe fonte nenhuma no extrato",
  );
  check(
    !/prisma\.venda\.findMany/.test(codigo),
    "o extrato já não lê a tabela `Venda` — que nunca é escrita",
  );
  check(
    /readCanonicalMovimentos/.test(codigo),
    "…e continua a ler o ledger canónico",
  );
  check(
    /export async function getCoberturaMovimentos/.test(codigo),
    "há forma de distinguir 'sem movimentos' de 'sem ledger ingerido'",
  );
}
{
  // Ninguém no repositório escreve na tabela `Venda`. Se algum dia
  // alguém escrever, este teste falha e a decisão volta à mesa.
  const alvos = [
    "../../lib/aggregate/vendamensal.ts",
    "../../lib/ingest/bulk.ts",
    "../../lib/movimentos-data.ts",
  ];
  let escritas = 0;
  for (const a of alvos) {
    // Sem comentários: o cabeçalho de `movimentos-data.ts` CITA as
    // chamadas que não existem, e um detector que leia comentários
    // acusa a própria documentação.
    const s = readFileSync(new URL(a, import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join("\n");
    if (/\bprisma\.venda\.(create|createMany|upsert|update)/.test(s)) escritas++;
    if (/INSERT\s+INTO\s+"Venda"/i.test(s)) escritas++;
  }
  eq(escritas, 0, "a tabela `Venda` continua sem escritor — o legacy nunca poderia estar certo");
}

console.log("\n=== a UI diz quando não há ledger ===");
{
  const src = readFileSync(
    new URL("../../components/stock/extrato-movimentos.tsx", import.meta.url),
    "utf8",
  );
  check(src.includes("semLedger"), "o extrato distingue farmácia sem ledger");
  check(
    src.includes("Sem movimentos ingeridos para"),
    "…e diz qual, em vez de mostrar uma tabela vazia igual à de um artigo parado",
  );
  check(
    /import type \{ CoberturaMovimentos \}/.test(src),
    "a cobertura entra como `import type` — não arrasta o Prisma para o browser",
  );
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail === 0 ? 0 : 1);
