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
  CLASSIFICACAO,
  NAMESPACES,
  assinarQuantidade,
  classificarDocumento,
  comporDocumento,
  normalizar,
  paraPayload,
  sqlAtendimentoDetalhe,
  sqlAtendimentoSuspDetalhe,
  type FonteRow,
  type SchemaCabecalhoSusp,
  type SchemaFonteSusp,
  type SchemaAtendimento,
} from "../../agent/src/vendas-fontes";

const G = NAMESPACES.ATENDIMENTO_DETALHE;
const VSG = NAMESPACES.ATENDIMENTO_SUSP_DETALHE;

/** O cabeçalho suspenso tal como o ERP da Silveirense o tem. */
const CAB: SchemaCabecalhoSusp = {
  existe: true,
  tabela: "Atendimento Susp",
  pk: "Atendimento Susp ID",
  serie: "SerieFacturacao",
  numero: "Numero Documento",
  tipoDocumento: "Tipo Documento ID",
  dataVenda: "Data Venda",
  totalBruto: "Total Bruto_EUR",
};

const SUSP: SchemaFonteSusp = {
  existe: true,
  tabela: "Atendimento Susp Detalhe",
  pk: "Atendimento Susp Detalhe ID",
  cabecalhoFk: "Atendimento Susp ID",
  codigoId: "CodigoID",
  sequencia: "Sequencia",
  quantidade: "Quantidade",
  pvpUnitario: "Preco Venda Publico_EUR",
  valorLinha: "Valor_EUR",
  ivaValor: "Val_IVA_EUR",
  descontoValor: "Val_Desc_EUR",
  comparticipacao1: "PrComp_EUR",
  comparticipacao2: "PrComp_EUR2",
  entidadeId: "Entidade ID",
  dataVenda: null,
};

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
  // 7, não 77: é o que o ERP real usa. Ver CLASSIFICACAO.
  tipoDocumento: 7,
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

/**
 * O Nimed do caso real: VSG/54684, tipoDoc 107, 2 unidades, 10,72 €.
 * Confirmado no ERP: linha 147214 → cabeçalho suspenso 83708.
 */
const NIMED_VSG = linha({
  externalLineId: 147214,
  externalDocumentId: 83708,
  tipoDocumento: 107,
  serie: "VSG",
  numero: 54684,
  externalProductId: 9599258,
  quantidade: 2,
  valorLinha: 10.72,
  dataVenda: new Date("2026-08-01T10:26:38.000Z"),
});

/** O Enalapril do caso real: VSG/54688, tipoDoc 107, 1 unidade, 9,97 €. */
const ENALAPRIL_VSG = linha({
  externalLineId: 147219,
  externalDocumentId: 83712,
  tipoDocumento: 107,
  serie: "VSG",
  numero: 54688,
  externalProductId: 3626884,
  quantidade: 1,
  valorLinha: 9.97,
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
  eq(l.externalDocumentId, 83708, "o cabeçalho é o Atendimento Susp, não o Atendimento");
  eq(l.valorBruto, 10.72, "valor histórico da linha, não recalculado");
  eq(l.tipoDocumento, 107, "tipoDoc 107 — o da factura de venda suspensa");
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

console.log("\n=== a matriz de classificação, tipo a tipo ===");
{
  // Os quatro casos que a produção fixou, escritos um por um. A rev68
  // recusou 282 de 282 linhas de balcão porque a lista dizia 77 e o ERP
  // diz 7 — um número inventado custa um dia de produção.
  eq(classificarDocumento(7, G), "VENDA", "tipo 7 em G = VENDA");
  eq(classificarDocumento(104, G), "DEVOLUCAO_ANULACAO", "tipo 104 em G = DEVOLUCAO_ANULACAO");
  eq(classificarDocumento(107, VSG), "VENDA", "tipo 107 em VSG = VENDA");
  eq(classificarDocumento(104, VSG), null, "tipo 104 em VSG = recusado");

  // O 77 sai. Não é compatibilidade histórica: o seed da migração
  // `20260514100000` descreve-o como "default Softreis" e descreve o 7
  // como "detectado 2024-01-01 sample". Nunca houve instalação a usá-lo.
  eq(classificarDocumento(77, G), null, "tipo 77 recusado — era o default do fornecedor");
  eq(classificarDocumento(77, VSG), null, "…nos dois circuitos");
  check(!CLASSIFICACAO[G].venda.has(77), "77 não está declarado em G");
  check(CLASSIFICACAO[G].venda.has(7), "…e 7 está");
  eq([...CLASSIFICACAO[G].venda], [7], "G: venda = {7}");
  eq([...CLASSIFICACAO[G].reversao], [104, 27], "G: reversao = {104, 27}");
  eq([...CLASSIFICACAO[VSG].venda], [107], "VSG: venda = {107}");
  eq([...CLASSIFICACAO[VSG].reversao], [], "VSG: reversao = {}");
}

console.log("\n=== o dia combinado: G + VSG ===");
{
  // 01/08/2026, Silveirense. O que a rev68 leu do ERP: 282 linhas de
  // balcão e 15 suspensas. Aqui só interessa que as duas fontes somam
  // no mesmo universo sem se sobreporem.
  const balcao = [
    linha({ externalLineId: 900001, tipoDocumento: 7, quantidade: 3, valorLinha: 12.5 }),
    linha({ externalLineId: 900002, tipoDocumento: 7, quantidade: 1, valorLinha: 4.2 }),
    // A NC do circuito G: chega do ERP já negativa.
    linha({ externalLineId: 900003, tipoDocumento: 104, quantidade: -1, valorLinha: -4.2 }),
  ].map((r) => normOk(r, G));
  const suspensas = [NIMED_VSG, ENALAPRIL_VSG].map((r) => normOk(r, VSG));

  const unidadesG = balcao.reduce((a, l) => a + l.quantidadeAssinada, 0);
  const unidadesVSG = suspensas.reduce((a, l) => a + l.quantidadeAssinada, 0);
  eq(unidadesG, 3, "G: 3 + 1 − 1 = 3 unidades líquidas");
  eq(unidadesVSG, 3, "VSG: 2 + 1 = 3 unidades");
  eq(unidadesG + unidadesVSG, 6, "líquido G+VSG = 6");

  // Nenhuma linha se sobrepõe: a chave inclui a origem.
  const chaves = [...balcao, ...suspensas].map((l) => `${l.sourceNamespace}|${l.externalLineId}`);
  eq(new Set(chaves).size, chaves.length, "as 5 linhas têm 5 chaves canónicas distintas");
  // E as classes ficam separadas por circuito, como o ERP as tem.
  eq(balcao.filter((l) => l.classe === "DEVOLUCAO_ANULACAO").length, 1, "a única reversão é do circuito G");
  eq(suspensas.filter((l) => l.classe === "DEVOLUCAO_ANULACAO").length, 0, "o circuito VSG não traz reversões");
}

console.log("\n=== a NC da VSG é lida pelo circuito G, e SÓ por ele ===");
{
  // ISTO É O CENTRO DA RONDA. As 107 relações de
  // `Atendimento_SuspFT_NC_Susp` resolvem 107/107 para `[Atendimento]`,
  // tipo 104, e as suas linhas estão em `[Atendimento Detalhe]` — que o
  // reader G já lê. Se o namespace VSG também classificasse 104 como
  // reversão, a MESMA nota de crédito era subtraída duas vezes.
  eq(
    classificarDocumento(104, G),
    "DEVOLUCAO_ANULACAO",
    "104 no circuito G é reversão — é por aqui que a NC entra",
  );
  eq(
    classificarDocumento(104, VSG),
    null,
    "104 no circuito VSG é RECUSADO — senão a mesma NC era subtraída duas vezes",
  );
  eq(CLASSIFICACAO[VSG].reversao.size, 0, "o circuito VSG não tem reversões próprias");
  check(CLASSIFICACAO[VSG].venda.has(107), "…só a factura suspensa, tipo 107");

  const nc = normalizar({ ...NIMED_VSG, tipoDocumento: 104 }, VSG);
  check("erro" in nc, "uma linha suspensa com tipo 104 não entra como reversão");
  if ("erro" in nc) check(/104/.test(nc.erro), "…e o erro identifica o tipo recusado");
}
{
  // A NC verdadeira: vem do circuito G, e o ERP já a grava NEGATIVA.
  const nc = normOk(linha({ tipoDocumento: 104, quantidade: -2, valorLinha: -10.72 }), G);
  eq(nc.classe, "DEVOLUCAO_ANULACAO", "NC de G é reversão");
  eq(nc.quantidadeAssinada, -2, "…e continua negativa: o sinal é aplicado UMA vez");

  const venda = normOk(NIMED_VSG, VSG);
  eq(
    venda.quantidadeAssinada + nc.quantidadeAssinada,
    0,
    "venda VSG (+2) + NC pelo circuito G (−2) = zero líquido, sem duplicar",
  );
}
{
  // A idempotência do sinal não é elegância: as NC chegam negativas do
  // ERP. Sem o `abs`, −2 virava +2 e a devolução passava a venda.
  eq(assinarQuantidade(-2, "DEVOLUCAO_ANULACAO"), -2, "NC já negativa mantém-se negativa");
  eq(assinarQuantidade(2, "DEVOLUCAO_ANULACAO"), -2, "NC positiva passa a negativa");
  eq(assinarQuantidade(-2, "VENDA"), 2, "venda gravada negativa passa a positiva");
  eq(
    assinarQuantidade(assinarQuantidade(-2, "DEVOLUCAO_ANULACAO"), "DEVOLUCAO_ANULACAO"),
    -2,
    "aplicar o sinal duas vezes dá o mesmo — re-upload não vira o sinal",
  );
}

console.log("\n=== tipo NÃO declarado é RECUSADO, não promovido a venda ===");
{
  // A primeira versão devolvia VENDA para tudo o que não fosse reversão:
  // uma NC com tipo não listado virava venda e o total SUBIA em vez de
  // descer — um erro que soma na direcção errada e parece plausível.
  // 7 saiu desta lista: passou a ser o tipo REAL da venda de balcão.
  for (const desconhecido of [1, 2, 55, 77, 99, 200]) {
    eq(classificarDocumento(desconhecido, G), null, `G: tipo ${desconhecido} recusado`);
    eq(classificarDocumento(desconhecido, VSG), null, `VSG: tipo ${desconhecido} recusado`);
  }
  eq(classificarDocumento(null, G), null, "sem tipo de documento não se adivinha");
  // Os dois circuitos numeram em colunas diferentes de tabelas
  // diferentes. O mesmo número não significa o mesmo dos dois lados.
  eq(classificarDocumento(7, G), "VENDA", "7 é a venda de balcão");
  eq(classificarDocumento(7, VSG), null, "…e não significa nada no circuito VSG");
  eq(classificarDocumento(107, VSG), "VENDA", "107 é a factura suspensa");
  eq(classificarDocumento(107, G), null, "…e não significa nada no circuito G");
  const r = normalizar(linha({ tipoDocumento: 99 }), VSG);
  check("erro" in r, "uma linha VSG com tipo por declarar é recusada");
  if ("erro" in r) {
    check(/99/.test(r.erro), "…e o erro diz QUAL o tipo, para se declarar");
    check(/SUSP/.test(r.erro), "…e em que circuito, porque as listas são separadas");
  }
}

console.log("\n=== fonte que existe mas não liga: PARA, não salta ===");
{
  const meioLigada: SchemaFonteSusp = { ...SUSP, cabecalhoFk: null };
  const r = sqlAtendimentoSuspDetalhe(meioLigada, CAB);
  eq(r.estado, "POR_LIGAR", "tabela existe + FK por resolver = POR_LIGAR, não AUSENTE");
  if (r.estado === "POR_LIGAR") {
    check(
      r.faltam.some((f) => /FK declarada/.test(f)),
      "…e diz que falta a FK DECLARADA",
      "saltar em silêncio uma tabela que TEM vendas é o defeito original",
    );
  }
  // Sem `Tipo Documento ID` no cabeçalho suspenso não há classificação.
  eq(
    sqlAtendimentoSuspDetalhe(SUSP, { ...CAB, tipoDocumento: null }).estado,
    "POR_LIGAR",
    "sem [Tipo Documento ID] a fonte não arranca",
  );
  // E sem o próprio cabeçalho não há documento nenhum.
  eq(
    sqlAtendimentoSuspDetalhe(SUSP, { ...CAB, existe: false, pk: null }).estado,
    "POR_LIGAR",
    "sem [Atendimento Susp] a fonte não arranca",
  );
  eq(
    sqlAtendimentoSuspDetalhe(SUSP, { ...CAB, dataVenda: null }).estado,
    "POR_LIGAR",
    "sem data no cabeçalho não há janela — e uma janela errada é pior que nenhuma",
  );
}

console.log("\n=== os dois pipelines PARAM numa fonte por ligar ===");
{
  for (const f of ["daily-sync-runner", "bootstrap-upload"]) {
    const src = readFileSync(
      new URL(`../../agent/src/commands/${f}.ts`, import.meta.url), "utf8");
    check(
      /estado === "POR_LIGAR"[\s\S]{0,400}throw new Error/.test(src),
      `${f}: uma fonte que existe e não liga atira, não salta`,
    );
    check(
      /estado === "AUSENTE"[\s\S]{0,250}continue/.test(src),
      `${f}: …e uma tabela inexistente é saltada, que é correcto`,
    );
  }
}

console.log("\n=== o rebuild histórico tem comando próprio ===");
{
  // `daily-pipeline --date` lê o ERP e escreve em sete sítios. Um
  // rebuild da agregação não deve poder tocar em produtos, stock nem
  // movimentos.
  const re = readFileSync(new URL("../../scripts/vendas/reaggregate.ts", import.meta.url), "utf8");
  check(re.includes("aggregateMonth"), "reaggregate usa a agregação canónica");
  check(
    /apply: \{ type: "boolean", default: false \}/.test(re),
    "dry-run por omissão — sem --apply não escreve",
  );
  // Sem comentários: o cabeçalho EXPLICA que não toca nessas tabelas, e
  // um detector que leia prosa acusa a própria documentação.
  const reCodigo = re
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join("\n");
  check(
    !/StocksMov|bootstrapProducts|movimentoArtigo|produtoFarmacia/i.test(reCodigo),
    "…e não toca no ERP nem em produtos/stock/movimentos",
  );
  check(
    !/withPool|mssql/.test(reCodigo),
    "…nem sequer abre ligação ao SQL Server — é uma operação do lado do SaaS",
  );
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  check(
    typeof pkg.scripts["vendas:reaggregate"] === "string",
    "está registado como `vendas:reaggregate`",
  );
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

  const rV = sqlAtendimentoSuspDetalhe(SUSP, CAB);
  eq(rV.estado, "PRONTA", "a fonte VSG fica pronta quando o schema resolve");
  const sqlV = rV.estado === "PRONTA" ? rV.sql : "";
  check(sqlV.includes("[Atendimento Susp Detalhe]"), "…e lê a tabela certa");
  check(
    sqlV.includes(
      "JOIN [dbo].[Atendimento Susp] h ON h.[Atendimento Susp ID] = d.[Atendimento Susp ID]",
    ),
    "o JOIN é ao cabeçalho SUSPENSO, pela FK declarada",
    "ligar ao [Atendimento] devolvia zero linhas neste ERP",
  );
  check(
    !/\[Atendimento\]/.test(sqlV),
    "a fonte VSG não toca no [Atendimento]",
    "o cabeçalho da venda suspensa é outro, e foi essa confusão que a partiu",
  );
  // O GATE REFUTADO. 11 868 linhas tinham cabeçalho `Atendimento` e
  // NENHUMA passava `[Fim Venda]='S'`. As duas vendas confirmadas têm
  // `N`, e no mesmo dia há VSG tipo 107 com `N` e com `S`.
  check(
    !/Fim Venda/.test(sqlV),
    "…e NÃO filtra por [Fim Venda] — o campo não classifica uma VSG",
  );
  check(
    sqlV.includes("h.[SerieFacturacao]") && sqlV.includes("h.[Tipo Documento ID]"),
    "série e tipo vêm do cabeçalho suspenso",
  );
  check(
    sqlV.includes("h.[Data Venda] >= @from") && sqlV.includes("h.[Data Venda] < @to"),
    "a janela é a do cabeçalho suspenso, meio-aberta",
  );
}
{
  // Instalação sem a tabela: a fonte fica inactiva, não rebenta.
  eq(
    sqlAtendimentoSuspDetalhe({ ...SUSP, existe: false }, CAB).estado,
    "AUSENTE",
    "instalação sem a tabela: fonte ausente, saltada sem erro",
  );
  const at: SchemaAtendimento = {
    serie: null, numero: null, tipoDocumento: "Tipo Documento",
    dataVenda: "Data Venda", fimVenda: "Fim Venda",
  };
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
  for (const [nome, s] of [
    ["Atendimento Detalhe", sqlAtendimentoDetalhe(at)],
    ["Atendimento Susp Detalhe", (() => { const r = sqlAtendimentoSuspDetalhe(SUSP, CAB); return r.estado === "PRONTA" ? r.sql : ""; })()],
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

console.log("\n=== NÃO existe um segundo reader de NC (dupla contagem) ===");
{
  const fontes = readFileSync(new URL("../../agent/src/vendas-fontes.ts", import.meta.url), "utf8");
  // Só há duas fontes, e a segunda é a venda POSITIVA da VSG. Um reader
  // de `Atendimento_SuspFT_NC_Susp` significaria ler a mesma NC que o
  // circuito G já lê.
  eq(Object.values(NAMESPACES).length, 2, "só existem DUAS fontes de venda");
  check(
    !/Atendimento_SuspFT_NC_Susp|Atendimento_FT_NC_Susp/.test(
      fontes.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n"),
    ),
    "nenhuma fonte lê a tabela de relações FT→NC",
    "as NC de VSG entram por [Atendimento Detalhe]; lê-las aqui subtraía duas vezes",
  );
  for (const f of ["daily-sync-runner", "bootstrap-upload"]) {
    const src = readFileSync(new URL(`../../agent/src/commands/${f}.ts`, import.meta.url), "utf8");
    check(!/SuspFT_NC/.test(src), `${f}: não lê relações FT→NC`);
  }
  // E o cabeçalho suspenso é lido sem o gate refutado.
  check(
    !/\[Fim Venda\][^\n]*Susp|Susp[^\n]*\[Fim Venda\]/.test(fontes),
    "o reader VSG não usa [Fim Venda] em lado nenhum",
  );
}

console.log("\n=== o dry-run tem de exercitar o reader NOVO ===");
{
  // A armadilha: `bootstrap-dry-run` é um comando separado, com SQL
  // próprio, que NÃO passa por `vendas-fontes.ts`. Validar o VSG com ele
  // não valida nada — lê outro código. O dry-run que serve é o do
  // próprio `bootstrap-upload`.
  const dry = readFileSync(
    new URL("../../agent/src/commands/bootstrap-dry-run.ts", import.meta.url), "utf8");
  check(
    !dry.includes("vendas-fontes"),
    "bootstrap-dry-run NÃO lê a venda suspensa — é outro caminho",
    "se um dia passar a ler, esta asserção cai e o aviso no --help deixa de ser verdade",
  );
  const up = readFileSync(
    new URL("../../agent/src/commands/bootstrap-upload.ts", import.meta.url), "utf8");
  check(
    /"dry-run":\s*\{\s*type:\s*"boolean"/.test(up),
    "bootstrap-upload expõe --dry-run no CLI",
    "a plumbing dryRun existia nos três pipelines e não tinha flag: não havia como lá chegar",
  );
  for (const p of ["runProductsPipeline", "runStockPipeline", "runSalesPipeline"]) {
    check(
      new RegExp(`${p}\\([^)]*\\{[\\s\\S]{0,40}dryRun`).test(up),
      `…e passa-o ao ${p}`,
    );
  }
  check(
    /if \(dryRun\)[\s\S]{0,200}não enviado/.test(up),
    "…e no modo dry-run o batch não é enviado",
  );

  // `--only`: validar o reader de vendas não pode obrigar a reler o
  // catálogo e o stock inteiros primeiro.
  check(/only: \{ type: "string" \}/.test(up), "bootstrap-upload aceita --only");
  check(
    /const PIPELINES = \["products", "stock", "sales-lines"\]/.test(up),
    "…com os três pipelines nomeados",
  );
  check(
    /--only: valor\(es\) desconhecido\(s\)/.test(up),
    "…e um valor inválido ABORTA em vez de correr tudo",
    "quem escreve --only=sales não quer o catálogo inteiro por engano",
  );
  for (const p of ["products", "stock", "sales-lines"]) {
    check(
      new RegExp(`corre\\("${p}"\\)`).test(up),
      `…e ${p} respeita o filtro`,
    );
  }

  // O output tem de separar as fontes. Um agregado esconde o caso que
  // interessa: VSG a ler zero com o total global a parecer bem.
  check(
    /\$\{fonte\.namespace\}: read=\$\{lidasNestaFonte\} payloads=\$\{payloads\} recusadas=\$\{porClassificar\}/.test(up),
    "o dry-run reporta read/payloads/recusadas POR namespace",
  );
  check(
    /lidasNestaFonte === 0[\s\S]{0,200}ZERO linhas/.test(up),
    "…e avisa quando uma fonte lê zero linhas",
  );
}

console.log("\n=== a query é validada ANTES de ir ao servidor ===");
{
  // A rev67 foi para a farmácia com uma lista de SELECT sem vírgulas.
  // `Incorrect syntax near 'a'`, depois de sincronizar produtos e stock.
  for (const f of ["bootstrap-upload", "daily-sync-runner"]) {
    const src = readFileSync(
      new URL(`../../agent/src/commands/${f}.ts`, import.meta.url), "utf8");
    check(
      /validarSelect\([^)]*ALIAS_FONTE_VENDA\)/.test(src),
      `${f}: valida a query completa antes de a executar`,
    );
    check(
      /problemas\.length > 0[\s\S]{0,400}throw new Error/.test(src),
      `${f}: …e uma query inválida atira, com o SQL no log`,
    );
  }
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
