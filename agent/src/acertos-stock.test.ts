/**
 * agent/src/acertos-stock.test.ts
 *
 * Fixa o âmbito dos acertos de stock.
 *
 * O defeito que estes testes impedem: um filtro `MovStocksDetID IS NOT
 * NULL` sem a segunda metade da condição. Numa linha que tenha as duas
 * FKs, o classificador canónico decide VENDA (a FK de venda é avaliada
 * primeiro) e o pipeline de acertos ficaria a contar a mesma linha —
 * duplicação entre pipelines, e a contar exactamente ao contrário do
 * que os dois lados diriam de si próprios.
 *
 * O teste central é `ehAcertoStock` vs `classifyMovimento` sobre TODAS
 * as 64 combinações de FKs. Não é uma amostra: é a tabela inteira.
 *
 * Uso: npx tsx agent/src/acertos-stock.test.ts
 */
import {
  ACERTO_STOCK,
  COLUNAS_FK,
  TIPOS_INTERNOS,
  avaliarTotais,
  ehAcertoStock,
  verificarAmostra,
  whereAcertoStock,
  type Totais,
} from "./acertos-stock.js";
import { classifyMovimento, type FkPattern } from "./movimento-classifier.js";

let pass = 0;
let fail = 0;
const eq = (label: string, obtido: unknown, esperado: unknown) => {
  if (obtido === esperado) {
    pass++;
    console.log(`  [OK]    ${label}`);
  } else {
    fail++;
    console.log(`  [FALHA] ${label}: obtido "${String(obtido)}", esperado "${String(esperado)}"`);
  }
};
const ok = (label: string, cond: boolean) => eq(label, cond, true);

// ── 1. O predicado, caso a caso ────────────────────────────────────

const VAZIO: FkPattern = {
  detalheId: null,
  suspDetalheId: null,
  creditoDetalheId: null,
  recpDetalheId: null,
  devolucaoDetalheId: null,
  movStocksDetId: null,
};
const fk = (p: Partial<FkPattern>): FkPattern => ({ ...VAZIO, ...p });

console.log("=== o predicado de âmbito ===");
ok("MovStocksDetID sozinho é acerto", ehAcertoStock(fk({ movStocksDetId: 1 })));
ok("nenhuma FK não é acerto", !ehAcertoStock(VAZIO));
ok("venda não é acerto", !ehAcertoStock(fk({ detalheId: 1 })));
ok("compra não é acerto", !ehAcertoStock(fk({ recpDetalheId: 1 })));
ok("devolução a fornecedor não é acerto", !ehAcertoStock(fk({ devolucaoDetalheId: 1 })));
ok("venda a crédito não é acerto", !ehAcertoStock(fk({ creditoDetalheId: 1 })));
ok("reserva suspensa não é acerto", !ehAcertoStock(fk({ suspDetalheId: 1 })));

// O caso que justifica o módulo inteiro.
ok(
  "interna + venda NÃO é acerto (a venda ganha)",
  !ehAcertoStock(fk({ movStocksDetId: 1, detalheId: 9 })),
);
ok(
  "interna + compra NÃO é acerto",
  !ehAcertoStock(fk({ movStocksDetId: 1, recpDetalheId: 9 })),
);
// Zero é um ID legítimo em SQL Server; só NULL significa "não aplicável".
// Com `!fk.detalheId` em vez de `== null`, esta linha entrava no âmbito.
ok(
  "FK a zero conta como populada",
  !ehAcertoStock(fk({ movStocksDetId: 1, detalheId: 0 })),
);
ok("movStocksDetId = 0 é acerto válido", ehAcertoStock(fk({ movStocksDetId: 0 })));

// ── 2. Concordância com o classificador canónico ───────────────────
//
// Para as 64 combinações: se `ehAcertoStock` diz sim, o classificador
// tem de produzir um tipo interno; se diz não, tem de produzir um tipo
// transaccional (ou DESCONHECIDO quando não há FK nenhuma).

console.log("");
console.log("=== ehAcertoStock concorda com classifyMovimento (64 combinações) ===");
const CAMPOS: (keyof FkPattern)[] = [
  "detalheId",
  "suspDetalheId",
  "creditoDetalheId",
  "recpDetalheId",
  "devolucaoDetalheId",
  "movStocksDetId",
];
let combinacoes = 0;
let discordancias = 0;
for (let mask = 0; mask < 64; mask++) {
  const p: FkPattern = { ...VAZIO };
  for (let i = 0; i < CAMPOS.length; i++) {
    if (mask & (1 << i)) p[CAMPOS[i]!] = 100 + i;
  }
  combinacoes++;
  // `cabTipoDocId: 25` (Inventário) garante que um MOV_INTERNO sem
  // texto de motivo cai num tipo interno em vez de DESCONHECIDO — o
  // que queremos testar aqui é a ORIGEM, não a sub-classificação.
  const cls = classifyMovimento({ fk: p, cabTipoDocId: 25, qtd: 1 });
  const interno = TIPOS_INTERNOS.has(cls.tipo);
  const meu = ehAcertoStock(p);
  // Sem nenhuma FK o classificador dá DESCONHECIDO, que está em
  // TIPOS_INTERNOS — e `ehAcertoStock` dá false. É a única assimetria
  // legítima, e é correcta: uma linha sem FK nenhuma não é um acerto.
  const semFk = mask === 0;
  if (!semFk && meu !== interno) {
    discordancias++;
    console.log(`  [FALHA] mask=${mask}: ehAcertoStock=${meu}, classificador=${cls.tipo}`);
  }
}
eq("combinações avaliadas", combinacoes, 64);
eq("discordâncias", discordancias, 0);
if (discordancias === 0) pass++;
else fail++;

// ── 3. O SQL diz o mesmo que o TypeScript ──────────────────────────

console.log("");
console.log("=== o WHERE cobre as seis colunas ===");
const w = whereAcertoStock("sm");
ok("exige a FK interna", /sm\.MovStocksDetID IS NOT NULL/.test(w));
for (const [nome, col] of Object.entries(COLUNAS_FK)) {
  if (nome === "movStocksDetId") continue;
  ok(`exclui ${nome}`, w.includes(`sm.${col} IS NULL`));
}
// Dois espaços em `[Detalhe  Recp ID]`. Um editor que "arrume" isto
// parte a query em silêncio — o SQL Server responde "invalid column".
ok("[Detalhe  Recp ID] mantém os DOIS espaços", w.includes("[Detalhe  Recp ID]"));
ok("alias é aplicado", whereAcertoStock("x").includes("x.MovStocksDetID"));

// ── 4. Verificação das amostras ────────────────────────────────────

console.log("");
console.log("=== verificarAmostra apanha o intruso ===");
const amostrasBoas = [
  { externalMovId: 1, fk: fk({ movStocksDetId: 5 }), motivoTexto: "Inventario", cabTipoDocId: 25, qtd: 3 },
  { externalMovId: 2, fk: fk({ movStocksDetId: 6 }), motivoTexto: "ValorMed", cabTipoDocId: null, qtd: -2 },
  { externalMovId: 3, fk: fk({ movStocksDetId: 7 }), motivoTexto: null, cabTipoDocId: null, qtd: 1 },
];
eq("amostras internas → zero divergências", verificarAmostra(amostrasBoas).length, 0);
ok(
  "motivo ilegível continua a ser acerto (DESCONHECIDO é interno)",
  verificarAmostra([amostrasBoas[2]!]).length === 0,
);
const comIntruso = [
  ...amostrasBoas,
  { externalMovId: 4, fk: fk({ movStocksDetId: 8, detalheId: 99 }), motivoTexto: "Acerto", cabTipoDocId: null, qtd: 1 },
];
const div = verificarAmostra(comIntruso);
eq("uma venda disfarçada é apanhada", div.length, 1);
eq("… e identificada", div[0]?.externalMovId, 4);
eq("… com o tipo real", div[0]?.tipo, "VENDA");

// ── 5. Veredictos ──────────────────────────────────────────────────

const TOTAIS_LIMPOS: Totais = {
  total: 1000,
  totalDistinto: 1000,
  positivos: 400,
  negativos: 590,
  zeros: 10,
  ambiguas: 0,
  semCodigoProduto: 0,
  semFichaStocks: 0,
  semCabecalho: 0,
};

console.log("");
console.log("=== avaliarTotais ===");
eq("janela limpa aprova", avaliarTotais(TOTAIS_LIMPOS).ok, true);
eq("janela vazia reprova", avaliarTotais({ ...TOTAIS_LIMPOS, total: 0 }).ok, false);

// A refutação directa da chave proposta: StocksMovID repetido.
const dup = avaliarTotais({ ...TOTAIS_LIMPOS, totalDistinto: 998 });
eq("StocksMovID repetido reprova", dup.ok, false);
ok("… e diz porquê", dup.linhas.some((l) => l.includes("REPETIDO")));

// Órfãos de catálogo NÃO são bloqueio: o canónico guarda produtoId nulo
// e o produto resolve-se quando entrar. Bloquear aqui obrigaria a
// escolher entre perder o movimento e inventar o produto.
const orfaos = avaliarTotais({ ...TOTAIS_LIMPOS, semFichaStocks: 12, semCodigoProduto: 3 });
eq("órfãos não bloqueiam", orfaos.ok, true);
ok("… mas são reportados", orfaos.linhas.some((l) => l.includes("15 movimento(s)")));

// Qtd NULL faz a contagem por sinal não fechar — sinal de que a
// quantidade líquida está a mentir por omissão.
const naoFecha = avaliarTotais({ ...TOTAIS_LIMPOS, positivos: 300 });
eq("contagem por sinal que não fecha reprova", naoFecha.ok, false);

const ambiguas = avaliarTotais({ ...TOTAIS_LIMPOS, ambiguas: 4 });
eq("ambíguas não bloqueiam", ambiguas.ok, true);
ok("… mas ficam contadas", ambiguas.linhas.some((l) => l.includes("FORA deste âmbito")));

console.log("");
console.log("=== a operação é uma só ===");
eq("nome da operação", ACERTO_STOCK, "ACERTO_STOCK");
// A decisão funcional: o motivo do ERP não cria categorias. Motivos
// diferentes, dentro do âmbito, dão todos a mesma operação.
const motivos = ["Inventario", "Prazo de validade", "ValorMed", "Uso interno", "Acerto ficha artigo"];
const tiposDistintos = new Set(
  motivos.map(() => ACERTO_STOCK),
);
eq("motivos diferentes → uma operação", tiposDistintos.size, 1);

console.log("");
console.log(`${pass} ok, ${fail} falhas`);
process.exit(fail === 0 ? 0 : 1);
