/**
 * scripts/tests/test-vendas-fontes.ts
 *
 * Fixa o universo de vendas: as DUAS fontes físicas, e o que cada uma
 * faz ao total.
 *
 * ── O DEFEITO QUE ISTO IMPEDE DE VOLTAR ──────────────────────────────
 *
 * O leitor de vendas lia uma tabela: `[Atendimento Detalhe]`. Uma
 * factura da série VSG — venda suspensa, que fiscalmente é uma venda
 * como outra qualquer — vive em `[Atendimento Susp Detalhe]` e nunca
 * era lida. Não entrava em `IngestVendaLinhaRaw`, logo não entrava em
 * `VendaMensal`, logo não aparecia no relatório.
 *
 * Só se via pelo lado do stock, porque `dbo.StocksMov` apanha as duas.
 * Silveirense, 01/08/2026: Nimed 9599258 com 2 unidades
 * (externalSuspDetalheId=147214) e Enalapril 3626884 com 1
 * (147219), entre outros, invisíveis no relatório e presentes no ledger.
 *
 * Sem base de dados e sem rede.
 *
 * Uso: npx tsx scripts/tests/test-vendas-fontes.ts
 */
import { readFileSync } from "node:fs";
import {
  NAMESPACES,
  TIPOS_DOC_REVERSAO,
  assinarQuantidade,
  classificarDocumento,
  comporDocumento,
  normalizar,
  paraPayload,
  sqlAtendimentoDetalhe,
  sqlAtendimentoSuspDetalhe,
  type FonteRow,
  type SchemaFonteSusp,
  type SchemaAtendimento,
} from "../../agent/src/vendas-fontes";

let pass = 0;
let fail = 0;
const ok = (l: string) => { pass++; console.log(`  [OK]    ${l}`); };
const bad = (l: string, d?: string) => { fail++; console.log(`  [FALHA] ${l}${d ? `\n            ${d}` : ""}`); };
const check = (c: boolean, l: string, d?: string) => (c ? ok(l) : bad(l, d));
const eq = (a: unknown, b: unknown, l: string) =>
  check(JSON.stringify(a) === JSON.stringify(b), l, `esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);

// ── Fixtures: o dia real, 01/08/2026, Silveirense ───────────────────

const linha = (over: Partial<FonteRow> = {}): FonteRow => ({
  externalLineId: 1,
  externalDocumentId: 900,
  sequencia: 1,
  dataVenda: new Date("2026-08-01T10:26:38.000Z"),
  tipoDocumento: 77,
  serie: "G",
  numero: 816760,
  externalProductId: 5001,
  processaStocks: 1,
  quantidade: 1,
  pvpUnitario: 6.55,
  valorLinha: 6.55,
  ivaValor: 0.37,
  descontoValor: 0,
  comparticipacao1: 0,
  comparticipacao2: 0,
  entidadeId: null,
  ...over,
});

/** O Nimed do caso real: VSG, 2 unidades. */
const NIMED_VSG = linha({
  externalLineId: 147214,
  serie: "VSG",
  numero: 54684,
  externalProductId: 9599258,
  quantidade: 2,
  dataVenda: new Date("2026-08-01T10:26:38.000Z"),
});

/** O Enalapril do caso real: VSG, 1 unidade, ao fim do dia. */
const ENALAPRIL_VSG = linha({
  externalLineId: 147219,
  serie: "VSG",
  numero: 54688,
  externalProductId: 3626884,
  quantidade: 1,
  dataVenda: new Date("2026-08-01T18:44:50.000Z"),
});

function normOk(r: FonteRow, ns: typeof NAMESPACES[keyof typeof NAMESPACES]) {
  const res = normalizar(r, ns);
  if ("erro" in res) throw new Error(`normalização falhou: ${res.erro}`);
  return res.linha;
}

console.log("=== VSG simples entra como venda ===");
{
  const l = normOk(NIMED_VSG, NAMESPACES.ATENDIMENTO_SUSP_DETALHE);
  eq(l.classe, "VENDA", "uma factura VSG é VENDA, não reserva");
  eq(l.quantidadeAssinada, 2, "2 unidades, positivas");
  eq(l.documento, "VSG/54684", "documento composto de série e número");
  eq(l.serie, "VSG", "a série viaja no canónico");
  eq(l.sourceNamespace, "ATENDIMENTO_SUSP_DETALHE", "com a origem física");
  eq(l.externalLineId, 147214, "e a PK da SUA tabela");
  eq(l.valorBruto, 6.55, "valor histórico da linha, não recalculado");
}
{
  const l = normOk(ENALAPRIL_VSG, NAMESPACES.ATENDIMENTO_SUSP_DETALHE);
  eq(l.quantidadeAssinada, 1, "Enalapril VSG: 1 unidade");
  eq(l.documento, "VSG/54688", "documento VSG/54688");
  eq(l.dataVenda, "2026-08-01T18:44:50.000Z", "hora preservada — 18:44:50");
}

console.log("\n=== G simples continua igual ===");
{
  const l = normOk(linha(), NAMESPACES.ATENDIMENTO_DETALHE);
  eq(l.classe, "VENDA", "factura G é VENDA");
  eq(l.quantidadeAssinada, 1, "quantidade positiva");
  eq(l.documento, "G/816760", "documento G");
  eq(l.sourceNamespace, "ATENDIMENTO_DETALHE", "namespace da venda de balcão");
}

console.log("\n=== G + VSG no mesmo dia somam, e não se sobrepõem ===");
{
  const g = normOk(linha({ externalLineId: 147214, quantidade: 3 }), NAMESPACES.ATENDIMENTO_DETALHE);
  const v = normOk(NIMED_VSG, NAMESPACES.ATENDIMENTO_SUSP_DETALHE);
  // MESMO externalLineId, tabelas diferentes. É o caso que a chave
  // antiga não distinguia — e que faria a segunda apagar a primeira.
  eq(g.externalLineId, v.externalLineId, "o mesmo ID existe nas duas tabelas");
  check(
    g.sourceNamespace !== v.sourceNamespace,
    "…mas o namespace separa-os",
    "sem isto, ingerir a suspensa sobrescrevia a venda de balcão",
  );
  const chave = (l: { sourceNamespace: string; externalLineId: number }) =>
    `f1|${l.sourceNamespace}|${l.externalLineId}`;
  check(chave(g) !== chave(v), "…e as chaves lógicas são distintas");
  eq(g.quantidadeAssinada + v.quantidadeAssinada, 5, "o total soma as duas: 3 + 2");
}

console.log("\n=== NC / anulação reduzem a venda, nas DUAS séries ===");
{
  for (const tipo of [...TIPOS_DOC_REVERSAO]) {
    eq(classificarDocumento(tipo), "DEVOLUCAO_ANULACAO", `tipoDocumento ${tipo} é reversão`);
  }
  eq(classificarDocumento(77), "VENDA", "tipoDocumento 77 é venda");
  eq(classificarDocumento(null), null, "sem tipo de documento não se adivinha");
}
{
  // NC de G.
  const nc = normOk(linha({ tipoDocumento: 104, quantidade: 2 }), NAMESPACES.ATENDIMENTO_DETALHE);
  eq(nc.classe, "DEVOLUCAO_ANULACAO", "NC de G é reversão");
  eq(nc.quantidadeAssinada, -2, "…e a quantidade fica NEGATIVA");
  // O ERP grava positivo nas duas classes; quem soma tem de ver o sinal.
  eq(assinarQuantidade(2, "DEVOLUCAO_ANULACAO"), -2, "o ERP grava positivo, nós assinamos");
  eq(assinarQuantidade(-2, "DEVOLUCAO_ANULACAO"), -2, "…e assinar duas vezes não vira o sinal");
}
{
  // NC de VSG — o caso que antes não existia de todo.
  const nc = normOk(
    { ...NIMED_VSG, tipoDocumento: 104, quantidade: 2 },
    NAMESPACES.ATENDIMENTO_SUSP_DETALHE,
  );
  eq(nc.classe, "DEVOLUCAO_ANULACAO", "NC de VSG é reversão");
  eq(nc.quantidadeAssinada, -2, "…e reduz a venda");
  const venda = normOk(NIMED_VSG, NAMESPACES.ATENDIMENTO_SUSP_DETALHE);
  eq(venda.quantidadeAssinada + nc.quantidadeAssinada, 0, "venda + NC = zero líquido");
}
{
  const anul = normOk({ ...ENALAPRIL_VSG, tipoDocumento: 27 }, NAMESPACES.ATENDIMENTO_SUSP_DETALHE);
  eq(anul.classe, "DEVOLUCAO_ANULACAO", "anulação de VSG (tipo 27) reverte");
  eq(anul.quantidadeAssinada, -1, "…com sinal negativo");
}

console.log("\n=== linha por classificar NÃO entra em silêncio ===");
{
  // Antes: tipo desconhecido → "UNKNOWN", gravado e depois filtrado.
  // Perder com passos extra.
  const r = normalizar(linha({ tipoDocumento: null }), NAMESPACES.ATENDIMENTO_DETALHE);
  check("erro" in r, "sem tipo de documento a linha é recusada, não arrumada em UNKNOWN");
  const r2 = normalizar(linha({ externalProductId: null as unknown as number }), NAMESPACES.ATENDIMENTO_DETALHE);
  check("erro" in r2, "sem CodigoID também");
}

console.log("\n=== o payload leva a origem e a quantidade assinada ===");
{
  const p = paraPayload(normOk(NIMED_VSG, NAMESPACES.ATENDIMENTO_SUSP_DETALHE));
  eq(p.sourceNamespace, "ATENDIMENTO_SUSP_DETALHE", "sourceNamespace no payload");
  eq(p.externalSaleLineId, 147214, "externalSaleLineId é a PK da fonte");
  eq(p.documento, "VSG/54684", "documento no payload");
  eq(p.tipoDocumentoClass, "VENDA", "classe já decidida por quem leu o documento");
  eq(p.quantidade, 2, "quantidade assinada");
}

console.log("\n=== composição do documento ===");
{
  eq(comporDocumento("VSG", 54688), "VSG/54688", "série + número");
  eq(comporDocumento("G", "816760.0"), "G/816760", "número decimal do SQL Server é truncado");
  eq(comporDocumento(null, 1), null, "sem série não se inventa documento");
  eq(comporDocumento("VSG", null), null, "sem número também não");
}

console.log("\n=== SQL: as duas fontes, e a janela ===");
{
  const at: SchemaAtendimento = {
    serie: "Serie", numero: "Numero", tipoDocumento: "Tipo Documento",
    dataVenda: "Data Venda", fimVenda: "Fim Venda",
  };
  const sqlG = sqlAtendimentoDetalhe(at);
  check(sqlG.includes("[Atendimento Detalhe]"), "a fonte G lê Atendimento Detalhe");
  check(
    sqlG.includes(">= @from") && sqlG.includes("< @to"),
    "janela meio-aberta — `BETWEEN ... 23:59:59` perdia o último segundo do dia",
  );
  check(sqlG.includes("[Fim Venda] = 'S'"), "só vendas fechadas");

  const susp: SchemaFonteSusp = {
    existe: true, tabela: "Atendimento Susp Detalhe",
    pk: "Atendimento Susp Detalhe ID", atendimentoFk: "Atendimento ID",
    codigoId: "CodigoID", sequencia: "Sequencia", quantidade: "Quantidade",
    pvpUnitario: "Preco Venda Publico_EUR", valorLinha: "Valor_EUR",
    ivaValor: "Val_IVA_EUR", descontoValor: "Val_Desc_EUR",
    comparticipacao1: "PrComp_EUR", comparticipacao2: "PrComp_EUR2",
    entidadeId: "Entidade ID", dataVenda: null,
  };
  const sqlV = sqlAtendimentoSuspDetalhe(susp, at);
  check(sqlV !== null, "a fonte VSG produz SQL quando o schema resolve");
  check(sqlV!.includes("[Atendimento Susp Detalhe]"), "…e lê a tabela certa");
  check(
    sqlV!.includes("JOIN [dbo].[Atendimento] a"),
    "INNER JOIN ao cabeçalho: sem cabeçalho não é uma venda facturada",
  );
  check(sqlV!.includes("[Fim Venda] = 'S'"), "…e o mesmo filtro de venda fechada");
  check(
    sqlV!.includes("a.[Serie]") && sqlV!.includes("a.[Tipo Documento]"),
    "série e tipo de documento vêm do cabeçalho — é de lá que sai VENDA vs NC",
  );
}
{
  // Instalação sem a tabela: a fonte fica inactiva, não rebenta.
  const semTabela: SchemaFonteSusp = {
    existe: false, tabela: "Atendimento Susp Detalhe", pk: null, atendimentoFk: null,
    codigoId: null, sequencia: null, quantidade: null, pvpUnitario: null,
    valorLinha: null, ivaValor: null, descontoValor: null,
    comparticipacao1: null, comparticipacao2: null, entidadeId: null, dataVenda: null,
  };
  const at: SchemaAtendimento = {
    serie: null, numero: null, tipoDocumento: "Tipo Documento",
    dataVenda: "Data Venda", fimVenda: "Fim Venda",
  };
  eq(sqlAtendimentoSuspDetalhe(semTabela, at), null, "instalação sem a tabela: fonte saltada, sem erro");
  const sqlG = sqlAtendimentoDetalhe(at);
  check(sqlG.includes("NULL AS serie"), "coluna em falta cai para NULL em vez de partir a query");
}

console.log("\n=== rerun idempotente / sem dupla contagem ===");
{
  // A chave lógica é determinística: correr duas vezes dá a mesma.
  const a = paraPayload(normOk(NIMED_VSG, NAMESPACES.ATENDIMENTO_SUSP_DETALHE));
  const b = paraPayload(normOk(NIMED_VSG, NAMESPACES.ATENDIMENTO_SUSP_DETALHE));
  eq(
    `${a.sourceNamespace}|${a.externalSaleLineId}`,
    `${b.sourceNamespace}|${b.externalSaleLineId}`,
    "a mesma linha produz sempre a mesma chave — o upsert actualiza, não duplica",
  );
  eq(a.quantidade, b.quantidade, "…e a mesma quantidade");
}

console.log("\n=== transferências NÃO são vendas ===");
{
  // As transferências não têm FK para nenhuma das tabelas de detalhe de
  // venda: entram pelo mov-interno (tblMovStocksDet) e nenhuma das duas
  // fontes lhes toca. A garantia é estrutural, e é isso que se fixa.
  const at: SchemaAtendimento = {
    serie: "Serie", numero: "Numero", tipoDocumento: "Tipo Documento",
    dataVenda: "Data Venda", fimVenda: "Fim Venda",
  };
  const susp: SchemaFonteSusp = {
    existe: true, tabela: "Atendimento Susp Detalhe", pk: "Atendimento Susp Detalhe ID",
    atendimentoFk: "Atendimento ID", codigoId: "CodigoID", sequencia: null,
    quantidade: "Quantidade", pvpUnitario: null, valorLinha: null, ivaValor: null,
    descontoValor: null, comparticipacao1: null, comparticipacao2: null,
    entidadeId: null, dataVenda: null,
  };
  for (const [nome, s] of [
    ["Atendimento Detalhe", sqlAtendimentoDetalhe(at)],
    ["Atendimento Susp Detalhe", sqlAtendimentoSuspDetalhe(susp, at)!],
  ] as const) {
    check(!/tblMovStocks/i.test(s), `${nome} não toca em tblMovStocks (transferências)`);
    check(!/Transfer/i.test(s), `${nome} não lê transferências`);
  }
  eq([...NAMESPACES ? Object.values(NAMESPACES) : []].length, 2, "só existem DUAS fontes de venda");
}

console.log("\n=== o caminho antigo desapareceu ===");
{
  const daily = readFileSync(
    new URL("../../agent/src/commands/daily-sync-runner.ts", import.meta.url), "utf8");
  const boot = readFileSync(
    new URL("../../agent/src/commands/bootstrap-upload.ts", import.meta.url), "utf8");
  for (const [nome, src] of [["daily-sync-runner", daily], ["bootstrap-upload", boot]] as const) {
    check(
      !/if \(t === 77\) return "VENDA"/.test(src),
      `${nome}: o classificador de dois números fixos saiu`,
      "77 e 104 eram venda e devolução; tudo o resto virava UNKNOWN e era filtrado",
    );
    check(src.includes("vendas-fontes.js"), `${nome}: usa o normalizador comum`);
    check(
      src.includes("sqlAtendimentoSuspDetalhe"),
      `${nome}: lê também a venda suspensa`,
    );
  }
  check(
    !/JOIN \[dbo\]\.\[Atendimento Detalhe\] d ON/.test(daily),
    "daily-sync já não tem SQL de vendas próprio",
  );
}

console.log("\n=== a identidade inclui a origem, de ponta a ponta ===");
{
  const schema = readFileSync(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");
  check(
    schema.includes("@@unique([farmaciaId, sourceNamespace, externalSaleLineId])"),
    "a chave única do raw discrimina a origem",
  );
  check(schema.includes("sourceNamespace String @default"), "…com default para as linhas já existentes");

  const bulk = readFileSync(new URL("../../lib/ingest/bulk.ts", import.meta.url), "utf8");
  check(
    bulk.includes('ON CONFLICT ("farmaciaId", "sourceNamespace", "externalSaleLineId")'),
    "o upsert em massa usa a chave completa",
  );
  const rota = readFileSync(
    new URL("../../app/api/ingest/v1/bootstrap/sales-lines/route.ts", import.meta.url), "utf8");
  check(
    rota.includes("farmaciaId_sourceNamespace_externalSaleLineId"),
    "o fallback per-row também",
  );
  check(
    rota.includes('"ATENDIMENTO_DETALHE"'),
    "um agent antigo, sem sourceNamespace, cai no namespace que ele de facto lia",
  );
}

console.log("\n=== VendaMensal continua a derivar do raw ===");
{
  const agg = readFileSync(new URL("../../lib/aggregate/vendamensal.ts", import.meta.url), "utf8");
  check(
    agg.includes('FROM "IngestVendaLinhaRaw"'),
    "a agregação lê o raw canónico e mais nada",
  );
  check(
    !/sourceNamespace/.test(agg),
    "…e não precisa de saber que fontes existem — soma o que lá está",
  );
  const loader = readFileSync(new URL("../../lib/vendas-data.ts", import.meta.url), "utf8");
  check(
    !/susp|SUSP/i.test(loader),
    "o loader do relatório não sabe o que é uma venda suspensa — nem deve",
  );
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail === 0 ? 0 : 1);
