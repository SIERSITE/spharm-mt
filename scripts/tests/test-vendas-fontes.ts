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
  ESTADOS_VENDA_G,
  NAMESPACES,
  NATUREZA_POR_NAMESPACE,
  REGRA_TRANSFERENCIA,
  SERIE_CIRCUITO_CREDITO,
  namespaceDaSerieCredito,
  assinarQuantidade,
  classificarDocumento,
  comporDocumento,
  filtroEstadoG,
  naturezaDe,
  normalizar,
  paraPayload,
  sqlAtendimentoCredito,
  sqlAtendimentoDetalhe,
  sqlAtendimentoSuspDetalhe,
  sqlDistribuicaoEstadoG,
  type SchemaFonteCredito,
  type FonteRow,
  type SchemaCabecalhoSusp,
  type SchemaFonteSusp,
  type SchemaAtendimento,
} from "../../agent/src/vendas-fontes";
import { ALIAS_FONTE_VENDA, validarSelect } from "../../agent/src/sql-validador";
import {
  DEFAULT_INCLUIR_CREDITO,
  DEFAULT_INCLUIR_TRANSFERENCIAS,
  naturezasIncluidas,
} from "../../lib/reporting/natureza-venda";
import {
  ANTES_SPHARM_MT_2026,
  GATES_SILVEIRENSE_2026,
  TOLERANCIA_UNIDADES,
  avaliarGate,
  nomeMes,
} from "../../agent/src/gates-silveirense";

const G = NAMESPACES.ATENDIMENTO_DETALHE;
const VSG = NAMESPACES.ATENDIMENTO_SUSP_DETALHE;

/** Os namespaces que têm reader. Os outros existem só para a dimensão. */
const NAMESPACES_LIDOS = [G, VSG] as const;

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
  // No circuito G a classe é propriedade do TIPO: o sinal da quantidade
  // não a muda. Por isso passa-se `+1` em todos e o resultado é o mesmo.
  eq(classificarDocumento(7, G, 1), "VENDA", "tipo 7 em G = VENDA");
  eq(classificarDocumento(27, G, -1), "DEVOLUCAO_ANULACAO", "tipo 27 em G = DEVOLUCAO_ANULACAO");
  eq(classificarDocumento(104, G, -1), "DEVOLUCAO_ANULACAO", "tipo 104 em G = DEVOLUCAO_ANULACAO");
  eq(classificarDocumento(104, VSG, -1), null, "tipo 104 em VSG = recusado");

  // O tipo 2: 9 linhas / 9 unidades em dois anos e meio, todas positivas.
  // Documento G/669909 inspeccionado ao detalhe — 5 linhas positivas — e
  // confirmado pelo operador como factura normal da série G.
  eq(classificarDocumento(2, G, 1), "VENDA", "tipo 2 em G = VENDA");
  eq(classificarDocumento(2, VSG, 1), null, "…e recusado no circuito VSG");
  {
    const l = normOk(linha({ tipoDocumento: 2, quantidade: 5, valorLinha: 21.4 }), G);
    eq(l.classe, "VENDA", "uma linha de tipo 2 entra como venda");
    eq(l.quantidadeAssinada, 5, "…com a quantidade positiva");
  }

  // O 77 sai. Não é compatibilidade histórica: o seed da migração
  // `20260514100000` descreve-o como "default Softreis" e descreve o 7
  // como "detectado 2024-01-01 sample". Nunca houve instalação a usá-lo.
  eq(classificarDocumento(77, G, 1), null, "tipo 77 recusado — era o default do fornecedor");
  eq(classificarDocumento(77, VSG, 1), null, "…nos dois circuitos");
  check(!CLASSIFICACAO[G].venda.has(77), "77 não está declarado em G");
  check(CLASSIFICACAO[G].venda.has(7), "…e 7 está");
  eq([...CLASSIFICACAO[G].venda], [7, 2], "G: venda = {7, 2}");
  eq([...CLASSIFICACAO[G].reversao], [104, 27], "G: reversao = {104, 27}");
  eq([...CLASSIFICACAO[G].peloSinal], [], "G: nenhum tipo depende do sinal");
  eq([...CLASSIFICACAO[VSG].peloSinal], [107, 102], "suspenso: {107, 102} pelo sinal");
  eq([...CLASSIFICACAO[VSG].venda], [], "suspenso: nenhuma venda de classe fixa");
  eq([...CLASSIFICACAO[VSG].reversao], [], "suspenso: nenhuma reversão de classe fixa");
}

console.log("\n=== circuito suspenso: o SINAL é que classifica ===");
{
  // Não é uma escolha de desenho — é o que as duas farmácias têm, no
  // mesmo período de 2024-01-01 a 2026-07-31:
  //
  //   Silveirense VSG 107   16 168 linhas +   /   2 078 linhas −
  //                         336 documentos negativos, em pares +N/−N
  //   Segurado    VSC 107    8 982 linhas +   /     583 linhas −
  //   Segurado    VSC 102       25 linhas +   /       5 linhas −
  //
  // Um `Set` de tipos não exprime isto: declarar 107 venda fazia as 2 078
  // negativas somar; declará-lo reversão fazia as 16 168 positivas
  // subtrair. As duas dão um total plausível e errado.
  eq(classificarDocumento(107, VSG, 2), "VENDA", "107 com +2 = VENDA");
  eq(classificarDocumento(107, VSG, -2), "DEVOLUCAO_ANULACAO", "107 com −2 = DEVOLUCAO_ANULACAO");
  eq(classificarDocumento(102, VSG, 1), "VENDA", "102 com +1 = VENDA");
  eq(classificarDocumento(102, VSG, -1), "DEVOLUCAO_ANULACAO", "102 com −1 = DEVOLUCAO_ANULACAO");

  // O sinal aplica-se UMA vez: a linha negativa do ERP fica negativa.
  const mais = normOk(linha({ externalLineId: 147214, tipoDocumento: 107, quantidade: 2 }), VSG);
  const menos = normOk(linha({ externalLineId: 147215, tipoDocumento: 107, quantidade: -2 }), VSG);
  eq(mais.classe, "VENDA", "a factura suspensa entra como venda");
  eq(mais.quantidadeAssinada, 2, "…com +2");
  eq(menos.classe, "DEVOLUCAO_ANULACAO", "a anulação entra como reversão");
  eq(menos.quantidadeAssinada, -2, "…com −2, sem o sinal ser aplicado duas vezes");
  eq(mais.quantidadeAssinada + menos.quantidadeAssinada, 0, "o par +2/−2 dá líquido ZERO");

  // O caso funcional confirmado da Segurado: VSC 102, documento 31187,
  // quatro linhas positivas e as quatro anulações.
  const doc31187 = [
    ...[1, 2, 3, 4].map((i) =>
      linha({ externalLineId: 311870 + i, tipoDocumento: 102, quantidade: 1, numero: 31187 }),
    ),
    ...[1, 2, 3, 4].map((i) =>
      linha({ externalLineId: 311880 + i, tipoDocumento: 102, quantidade: -1, numero: -31187 }),
    ),
  ].map((r) => normOk(r, VSG));
  eq(doc31187.filter((l) => l.classe === "VENDA").length, 4, "31187: quatro linhas de venda");
  eq(
    doc31187.filter((l) => l.classe === "DEVOLUCAO_ANULACAO").length,
    4,
    "31187: quatro linhas de anulação",
  );
  eq(
    doc31187.reduce((a, l) => a + l.quantidadeAssinada, 0),
    0,
    "31187: líquido ZERO — a factura VS e a sua anulação cancelam-se",
  );

  // Zero não é venda nem anulação: é uma linha sem operação. Classificá-la
  // como venda somava zero numa classe que não é a dela e escondia-a.
  eq(classificarDocumento(107, VSG, 0), null, "107 com quantidade ZERO = recusado");
  eq(classificarDocumento(102, VSG, 0), null, "102 com quantidade ZERO = recusado");
  {
    const z = normalizar(linha({ tipoDocumento: 107, quantidade: 0 }), VSG);
    check("erro" in z, "uma linha suspensa de quantidade zero não entra");
    if ("erro" in z) check(/zero/.test(z.erro), "…e o erro diz porquê");
  }
  // Sem quantidade legível também não há sinal — e sem sinal não há
  // classe. Devolver VENDA por defeito transformava cada anulação por
  // ler numa venda, que é a direcção de erro que não se detecta.
  eq(classificarDocumento(107, VSG, null), null, "107 sem quantidade = recusado");
  {
    const s = normalizar(linha({ tipoDocumento: 107, quantidade: null }), VSG);
    check("erro" in s, "uma linha suspensa sem quantidade não entra");
  }

  // No circuito G o sinal NÃO decide: a quantidade zero de um tipo com
  // classe fixa continua classificável, e soma zero. Fica escrito para
  // não se tornar ambíguo por omissão.
  eq(classificarDocumento(7, G, 0), "VENDA", "no circuito G o zero não muda a classe do tipo");
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
  eq(balcao.filter((l) => l.classe === "DEVOLUCAO_ANULACAO").length, 1, "a reversão do circuito G");
  eq(
    suspensas.filter((l) => l.classe === "DEVOLUCAO_ANULACAO").length,
    0,
    "e nenhuma no suspenso — porque estas duas linhas são positivas, não porque o circuito não as tenha",
  );
}

console.log("\n=== a NC da VSG é lida pelo circuito G, e SÓ por ele ===");
{
  // ISTO É O CENTRO DA RONDA. As 107 relações de
  // `Atendimento_SuspFT_NC_Susp` resolvem 107/107 para `[Atendimento]`,
  // tipo 104, e as suas linhas estão em `[Atendimento Detalhe]` — que o
  // reader G já lê. Se o namespace VSG também classificasse 104 como
  // reversão, a MESMA nota de crédito era subtraída duas vezes.
  eq(
    classificarDocumento(104, G, -1),
    "DEVOLUCAO_ANULACAO",
    "104 no circuito G é reversão — é por aqui que a NC entra",
  );
  // Continua recusado mesmo com sinal negativo, que é a forma em que
  // chegaria: o que o exclui é o TIPO não estar declarado neste
  // circuito, não o sinal com que veio.
  eq(
    classificarDocumento(104, VSG, -1),
    null,
    "104 no circuito VSG é RECUSADO — senão a mesma NC era subtraída duas vezes",
  );
  eq(classificarDocumento(104, VSG, 1), null, "…e com sinal positivo também");
  check(!CLASSIFICACAO[VSG].peloSinal.has(104), "104 não é dos tipos classificados pelo sinal");
  check(CLASSIFICACAO[VSG].peloSinal.has(107), "…107 é");

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
  // 7 e 2 sairam desta lista: sao os tipos REAIS da venda de balcao,
  // ambos observados no ERP. O que fica sao numeros que ninguem viu.
  // Testados com os DOIS sinais: um tipo por declarar é recusado venha
  // como vier. O sinal só classifica os tipos que foram declarados como
  // dependentes dele — não promove um número desconhecido a venda.
  for (const desconhecido of [1, 55, 77, 99, 200]) {
    for (const q of [1, -1]) {
      eq(classificarDocumento(desconhecido, G, q), null, `G: tipo ${desconhecido} (${q}) recusado`);
      eq(classificarDocumento(desconhecido, VSG, q), null, `VSG: tipo ${desconhecido} (${q}) recusado`);
    }
  }
  eq(classificarDocumento(null, G, 1), null, "sem tipo de documento não se adivinha");
  // Os dois circuitos numeram em colunas diferentes de tabelas
  // diferentes. O mesmo número não significa o mesmo dos dois lados.
  eq(classificarDocumento(7, G, 1), "VENDA", "7 é a venda de balcão");
  eq(classificarDocumento(7, VSG, 1), null, "…e não significa nada no circuito VSG");
  eq(classificarDocumento(107, VSG, 1), "VENDA", "107 é a factura suspensa");
  eq(classificarDocumento(107, G, 1), null, "…e não significa nada no circuito G");
  eq(classificarDocumento(102, G, 1), null, "102 também não significa nada no circuito G");
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
  // ── O gate de estado do circuito G ─────────────────────────────
  //
  // Era `[Fim Venda] = 'S'`, escrito à mão e nunca medido. Deixava de
  // fora todos os documentos com `U` — vendas reais de TipoDoc 7, com
  // produto e quantidade positiva. A assinatura mensal do que faltava no
  // SPharm.MT bate 1:1 com o que o gate excluía: Jan −408 contra 407,
  // Fev −358 contra 358, Jun −384 contra 384.
  check(!/\[Fim Venda\] = 'S'/.test(sqlG), "o gate `= 'S'` desapareceu");
  check(/IN \('S', 'U'\)/.test(sqlG), "…e passou a incluir os dois estados de venda");
  eq([...ESTADOS_VENDA_G], ["S", "U"], "os estados declarados são S e U");
  // `N` continua de fora: S+U reproduz o relatório oficial, S+U+N não
  // reproduziria nada medido. Um documento por fechar não é uma venda.
  check(!/'N'/.test(sqlG), "o estado N não entra — não é uma venda concretizada");
  {
    // Sem a coluna, NÃO se filtra. Ler a mais e reportar é recuperável;
    // ler a menos em silêncio custou 400 unidades por mês.
    const semEstado = sqlAtendimentoDetalhe({ ...at, fimVenda: null });
    check(!/Fim Venda/.test(semEstado), "sem a coluna de estado, não há filtro nenhum");
    check(/Data Venda/.test(semEstado), "…mas a janela temporal mantém-se");
    eq(filtroEstadoG({ ...at, fimVenda: null }), null, "filtroEstadoG devolve null sem coluna");
  }
  // E o gate tem de ser VISÍVEL: o anterior cortava ~400 unidades/mês e
  // não havia nada, em lado nenhum, que o dissesse.
  {
    const dist = sqlDistribuicaoEstadoG(at);
    check(dist !== null && /GROUP BY/.test(dist), "há uma query que reporta o que o gate corta");
    eq(sqlDistribuicaoEstadoG({ ...at, fimVenda: null }), null, "…e é null quando não há gate");
  }

  // ── NENHUM caminho do agent pode ficar com o gate antigo ────────
  //
  // `daily-sync` tem SQL próprio e ESCREVE. Corrigir só o reader do
  // bootstrap deixava o backfill certo e cada noite seguinte a perder
  // outra vez os documentos U — com dois totais consoante o comando que
  // o operador tivesse corrido. Os previews contam: um preview que
  // discorda do reader é exactamente o que deixou isto esconder-se.
  for (const f of [
    "daily-sync",
    "daily-sync-runner",
    "bootstrap-dry-run",
    "bootstrap-upload",
    "sales-preview",
    "sales-summary-preview",
  ]) {
    const src = readFileSync(
      new URL(`../../agent/src/commands/${f}.ts`, import.meta.url),
      "utf8",
    );
    check(
      !/\[Fim Venda\]\s*=\s*'S'/.test(src),
      `${f}: sem o gate \`= 'S'\``,
      "um caminho com o gate antigo lê menos 400 unidades/mês do que os outros",
    );
  }

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
  // Duas fontes LIDAS. Os outros dois namespaces existem para a dimensão
  // `naturezaVenda` estar completa de ponta a ponta, e os seus readers
  // ainda não foram escritos — ver `CLASSIFICACAO`, que os declara vazios.
  eq(NAMESPACES_LIDOS.length, 2, "só existem DUAS fontes de venda LIDAS");
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
  eq(NAMESPACES_LIDOS.length, 2, "só existem DUAS fontes de venda LIDAS");
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

  // A auditoria do circuito suspenso mostra [Fim Venda] como coluna,
  // porque é informação útil — mas nunca o usa para decidir. Foi
  // refutado como classificador com 11 868 linhas e zero matches.
  const audit = readFileSync(
    new URL("../../agent/src/commands/vendas-susp-tipos.ts", import.meta.url), "utf8");
  const codigoAudit = audit
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join("\n");
  check(
    /fimVenda/.test(codigoAudit),
    "a auditoria MOSTRA [Fim Venda] — é dado útil",
  );
  check(
    !/WHERE[^\n]*[Ff]im\s*Venda|AND[^\n]*[Ff]im\s*Venda/.test(codigoAudit),
    "…mas nunca o usa num WHERE ou AND",
    "usá-lo como filtro devolvia zero — já custou uma ronda inteira",
  );
  check(
    !/reversao: new Set/.test(codigoAudit) && !/CLASSIFICACAO\[[^\]]+\]\s*=/.test(codigoAudit),
    "…e a auditoria não classifica nada: só conta",
  );

  // ── A sonda não nomeia colunas à mão ───────────────────────────
  //
  // A §4 partiu nas DUAS farmácias com `Invalid column name 'Serie'`,
  // porque estava lá escrito `a.[Serie]`. Não foi um typo: foi uma
  // coluna nomeada à mão numa sonda cujo resto pergunta ao `sys.columns`
  // antes de nomear seja o que for. `[Atendimento]` não tem `Serie`.
  //
  // Este teste fecha a classe inteira, não o caso: qualquer coluna do
  // ERP escrita literalmente dentro de SQL volta a partir na instalação
  // seguinte, e a instalação seguinte é sempre a que não vimos.
  const sqlDaAuditoria = codigoAudit.replace(/console\.log\((?:[^()]|\([^()]*\))*\)/g, "");
  const nomeadasAMao = [
    "[Serie]",
    "[Tipo Documento]",
    "[Tipo Documento ID]",
    "[Atendimento ID]",
    "[Atendimento Susp ID]",
    "[Data Venda]",
    "[CodigoID]",
    "[Quantidade]",
    "[Detalhe ID]",
    "[Atendimento Susp ID_FT]",
    "[Atendimento ID_NC]",
  ].filter((c) => sqlDaAuditoria.includes(c));
  check(
    nomeadasAMao.length === 0,
    "a auditoria não nomeia nenhuma coluna ERP à mão no SQL",
    `nomeadas à mão: ${nomeadasAMao.join(", ")} — foi assim que a §4 partiu nas duas bases`,
  );

  // …e o que substituiu os nomes é descoberta a sério: FK declarada
  // primeiro, `sys.columns` depois, nome só como último recurso.
  for (const fn of ["descobrirCircuitoG", "descobrirRelacao"]) {
    check(codigoAudit.includes(fn), `a §4 resolve o circuito G via ${fn}()`);
  }
  for (const meta of ["listForeignKeysOut", "listColumns", "listPrimaryKey"]) {
    check(codigoAudit.includes(meta), `…e pergunta ao schema com ${meta}()`);
  }

  // O circuito G pode simplesmente não ter série — foi o que o ERP
  // respondeu. O cruzamento liga por identificador; a série é adorno.
  check(
    /g\.serie\s*\?\s*`a\.\$\{quoteIdent\(g\.serie\)\}`\s*:\s*"NULL"/.test(codigoAudit),
    "a série do lado G é opcional: sem coluna, sai NULL",
    "exigir série do circuito G bloqueava o cruzamento inteiro por causa de um adorno",
  );
}

console.log("\n=== naturezaVenda: dimensão, não classe ===");
{
  // `classe` diz se soma ou subtrai. `natureza` diz o que a linha É. São
  // perguntas independentes: uma devolução de venda a crédito é
  // DEVOLUCAO_ANULACAO + CREDITO, e numa coluna só nenhuma teria resposta.
  eq(naturezaDe(G), "NORMAL", "circuito G = NORMAL");
  eq(naturezaDe(VSG), "NORMAL", "circuito suspenso = NORMAL");
  eq(naturezaDe(NAMESPACES.VENDAS_CREDITO), "CREDITO", "vendas a crédito = CREDITO");
  eq(naturezaDe(NAMESPACES.GUIAS_TRANSFERENCIA), "TRANSFERENCIA", "guias = TRANSFERENCIA");
  // A venda suspensa é NORMAL: fiscalmente é uma venda como outra
  // qualquer, e é assim que o relatório oficial a conta. O que a
  // distingue é a tabela de onde vem, não a natureza comercial.
  check(
    NATUREZA_POR_NAMESPACE[VSG] === NATUREZA_POR_NAMESPACE[G],
    "a venda suspensa conta como venda normal",
    "não é um detalhe: pô-la noutra natureza tirava-a do mapa por defeito",
  );

  // A natureza viaja no payload — o servidor não a re-infere.
  const p = paraPayload(normOk(NIMED_VSG, VSG));
  eq(p.naturezaVenda, "NORMAL", "o payload leva a natureza");
  eq(p.sourceNamespace, VSG, "…e o namespace de onde veio");

  // Os readers de crédito/transferência não existem: os tipos estão
  // vazios e tudo é recusado. Inventar um tipo para "já ficar a
  // funcionar" era repetir o 77, declarado meses sem nunca ter sido visto.
  // O crédito REAL continua sem tipos declarados: as guias VCG_1 saem
  // pelo namespace das transferências, e nenhuma instalação confirmou
  // ainda um documento de crédito verdadeiro.
  {
    const ns = NAMESPACES.VENDAS_CREDITO;
    eq(CLASSIFICACAO[ns].venda.size, 0, `${ns}: nenhum tipo de venda declarado`);
    eq(CLASSIFICACAO[ns].reversao.size, 0, `${ns}: nenhuma reversão declarada`);
    eq(CLASSIFICACAO[ns].peloSinal.size, 0, `${ns}: nenhum tipo pelo sinal`);
    for (const t of [1, 7, 38, 102, 107]) {
      eq(classificarDocumento(t, ns, 1), null, `${ns}: tipo ${t} recusado — sem evidência`);
    }
  }
  // As guias têm o 38 declarado, e SÓ o 38.
  {
    const ns = NAMESPACES.GUIAS_TRANSFERENCIA;
    eq([...CLASSIFICACAO[ns].peloSinal], [38], `${ns}: só o tipo 38`);
    eq(CLASSIFICACAO[ns].venda.size, 0, `${ns}: nenhuma venda de classe fixa`);
    for (const t of [1, 7, 102, 107]) {
      eq(classificarDocumento(t, ns, 1), null, `${ns}: tipo ${t} recusado`);
    }
  }
}

console.log("\n=== ausência de FK NÃO é ausência de tabela ===");
{
  // O DEFEITO DA REV75. A lição de toda esta investigação foi "FK
  // declarada em vez de nome", porque escolher uma coluna pelo nome fez
  // o reader ler zero linhas durante uma ronda inteira. Aplicá-la à
  // descoberta transformou uma PREFERÊNCIA numa PRÉ-CONDIÇÃO, e a
  // ausência de FK passou a ser lida como ausência de dados:
  //
  //     "A FK nao existe nesta instalacao: nao ha universo de credito."
  //
  // `dbo.[Atendimento Credito]` e `dbo.[Atendimento Credito Detalhe]`
  // existem na Silveirense. A FK é que não.
  const probe = readFileSync(
    new URL("../../agent/src/commands/vendas-extra-discover.ts", import.meta.url),
    "utf8",
  );
  check(
    /sys\.tables/.test(probe),
    "a descoberta de crédito procura por sys.tables",
    "por FK, uma instalação sem constraints declaradas parecia não ter as tabelas",
  );
  check(
    /tabelasComNome/.test(probe),
    "…com uma função dedicada a encontrar tabelas por estrutura",
  );
  check(
    /origemLigacao/.test(probe) && /estrutura \(coluna comum\)/.test(probe),
    "a ligação detalhe→cabeçalho aceita coluna comum, não só FK",
  );
  {
    // A frase só pode sobreviver como CITAÇÃO do defeito, no comentário
    // que explica porque é que estava errada — nunca como conclusão que
    // o comando imprime.
    const semComentarios = probe
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join("\n");
    check(
      !/nao ha universo de credito/.test(semComentarios),
      "a conclusão errada da rev75 desapareceu do código",
    );
  }
  check(
    /READER OK \/ ZERO DOCUMENTOS/.test(probe),
    "…e 'zero documentos' distingue-se de 'sem reader'",
    "um zero sem essa distinção lê-se como facto sobre o ERP",
  );

  // O mesmo defeito bloqueava as transferências: exigia FK
  // StocksMov→tblMovStocksDet e uma coluna Serie que o cabeçalho não tem.
  check(
    /detChaveCab: tem\(colsDet, "MovStocksCabID"\)/.test(probe),
    "cabeçalho↔detalhe liga por coluna comum, sem exigir FK",
  );
  check(
    /smChaveDet: tem\(colsSm, "MovStocksDetID"\)/.test(probe),
    "…e StocksMov↔detalhe também",
    "é a ligação que o pipeline stocksmov usa em produção desde a rev33",
  );
  check(
    /nao tem coluna de serie/.test(probe),
    "a sonda diz que tblMovStocksCab não tem série",
    "por isso a regra não pode ser por nome de série — foi o que a rev75 exigiu",
  );
  // Sobreposição com NORMAL: um candidato já contado em G duplica.
  check(
    /smChaveAtendimento/.test(probe) && /SOBREPOSICAO COM NORMAL/.test(probe),
    "mede a sobreposição com a venda normal antes de aceitar um candidato",
    "[Detalhe ID] preenchido significa que a linha já entra pelo circuito G",
  );
  // Lookups: um motivo 44 não é interpretável; um nome é.
  check(
    /lookupDesignacoes/.test(probe),
    "procura as designações dos IDs documentais",
    "\"motivo 44\" não é uma regra que se defenda; o nome dele é",
  );
  // E o critério de aceitação continua a ser o gate, não a estética.
  check(
    /7\/7|GATES_SILVEIRENSE_2026/.test(probe) && /avaliarGate/.test(probe),
    "os candidatos são julgados pelo gate mensal",
  );
}

console.log("\n=== o reader de crédito existe e é fail-closed ===");
{
  // Schema suficiente → PRONTA. Schema incompleto → POR_LIGAR com a
  // lista do que falta, nunca um silêncio.
  const COMPLETO: SchemaFonteCredito = {
    existe: true,
    cabecalhoTabela: "Atendimento Credito",
    detalheTabela: "Atendimento Credito Detalhe",
    cabecalhoPk: "Atendimento Credito ID",
    detalhePk: "Atendimento Credito Detalhe ID",
    chaveLigacao: "Atendimento Credito ID",
    data: "Data Venda",
    serie: "SerieFacturacao",
    numero: "Numero Documento",
    tipoDocumento: "Tipo Documento ID",
    codigoId: "CodigoID",
    quantidade: "Quantidade",
    pvpUnitario: null,
    valorLinha: null,
    ivaValor: "IVA",
    entidadeId: null,
    sequencia: null,
    estado: "Fim Venda",
    candidatas: ["Atendimento Credito", "Atendimento Credito Detalhe"],
  };
  const r = sqlAtendimentoCredito(COMPLETO);
  eq(r.estado, "PRONTA", "schema completo → fonte pronta");
  if (r.estado === "PRONTA") {
    const p = validarSelect(r.sql, ALIAS_FONTE_VENDA);
    check(p.length === 0, "a query de crédito é válida e completa", JSON.stringify(p));
    check(
      /JOIN \[dbo\]\.\[Atendimento Credito\] h ON h\.\[Atendimento Credito ID\] = d\.\[Atendimento Credito ID\]/.test(r.sql),
      "liga pela chave lógica comum às duas tabelas",
    );
    check(/d\.\[Atendimento Credito Detalhe ID\] > @lastId/.test(r.sql), "keyset pela PK do detalhe");
    check(!/Fim Venda/.test(r.sql), "não filtra por [Fim Venda] — não é classificador");
  }
  // Sem tabela → AUSENTE. Faltando uma peça → POR_LIGAR, com diagnóstico.
  eq(sqlAtendimentoCredito({ ...COMPLETO, existe: false }).estado, "AUSENTE", "sem circuito → AUSENTE");
  const semQtd = sqlAtendimentoCredito({ ...COMPLETO, quantidade: null });
  eq(semQtd.estado, "POR_LIGAR", "sem quantidade → POR_LIGAR");
  if (semQtd.estado === "POR_LIGAR") {
    check(semQtd.faltam.includes("quantidade"), "…e diz exactamente o que falta");
  }
  const semLig = sqlAtendimentoCredito({ ...COMPLETO, chaveLigacao: null });
  eq(semLig.estado, "POR_LIGAR", "sem chave de ligação → POR_LIGAR");

  // A natureza e o namespace são os declarados, e não se misturam.
  eq(naturezaDe(NAMESPACES.VENDAS_CREDITO), "CREDITO", "crédito não entra como NORMAL");
  // Continua fail-closed na classificação: os tipos do circuito de
  // crédito ainda não foram observados em ERP nenhum.
  eq(
    classificarDocumento(1, NAMESPACES.VENDAS_CREDITO, 1),
    null,
    "nenhum tipo de crédito está declarado — fail-closed até haver evidência",
  );
}

console.log("\n=== VCG_1 é TRANSFERÊNCIA, não crédito ===");
{
  // A tabela chama-se `Atendimento Credito`. Os documentos VCG_1 que lá
  // vivem NÃO são vendas a crédito — são guias de transferência. É
  // conhecimento funcional do operador e prevalece sobre o nome físico:
  // um nome de tabela é uma escolha de quem a criou; a semântica é de
  // quem a usa.
  eq(
    namespaceDaSerieCredito("VCG_1"),
    NAMESPACES.GUIAS_TRANSFERENCIA,
    "VCG_1 → GUIAS_TRANSFERENCIA",
  );
  eq(
    naturezaDe(namespaceDaSerieCredito("VCG_1")!),
    "TRANSFERENCIA",
    "…e a natureza é TRANSFERENCIA",
  );
  check(
    namespaceDaSerieCredito("VCG_1") !== NAMESPACES.VENDAS_CREDITO,
    "VCG_1 NUNCA é crédito",
    "se fosse, a Silveirense veria 3 228 unidades aparecer em Janeiro ao ligar 'vendas a crédito'",
  );
  eq(namespaceDaSerieCredito("vcg_1"), NAMESPACES.GUIAS_TRANSFERENCIA, "…e não depende de maiúsculas");
  eq(namespaceDaSerieCredito("  VCG_1  "), NAMESPACES.GUIAS_TRANSFERENCIA, "…nem de espaços");

  // A Segurado tem VCC_1, tipo 38, no mesmo circuito. Parece-se — e
  // "parece-se" foi o que declarou o 77, o Fim Venda='S' e o 107 sem
  // sinal. Sem confirmação funcional, fica de fora.
  eq(namespaceDaSerieCredito("VCC_1"), null, "VCC_1 NÃO é automaticamente transferência");
  eq(namespaceDaSerieCredito("VCG"), null, "…nem VCG");
  eq(namespaceDaSerieCredito(null), null, "…nem uma série nula");
  eq(namespaceDaSerieCredito(""), null, "…nem uma série vazia");
  eq(Object.keys(SERIE_CIRCUITO_CREDITO), ["VCG_1"], "só UMA série está declarada");

  // Tipo 38, pelo SINAL. Resolve sozinho os dois casos observados: os
  // documentos `Fim Venda='A'` têm quantidade ZERO e são recusados, e
  // uma guia estornada chega negativa e sai como anulação.
  const T = NAMESPACES.GUIAS_TRANSFERENCIA;
  eq(classificarDocumento(38, T, 5), "VENDA", "tipo 38 positivo → VENDA");
  eq(classificarDocumento(38, T, -5), "DEVOLUCAO_ANULACAO", "tipo 38 negativo → anulação");
  eq(
    classificarDocumento(38, T, 0),
    null,
    "tipo 38 com quantidade ZERO é RECUSADO",
    );
  {
    const anulado = normalizar(linha({ tipoDocumento: 38, quantidade: 0 }), T);
    check("erro" in anulado, "um documento anulado (estado A, qtd 0) não vira venda");
  }
  const guia = normOk(linha({ tipoDocumento: 38, quantidade: 12 }), T);
  eq(guia.natureza, "TRANSFERENCIA", "a linha sai com natureza TRANSFERENCIA");
  eq(guia.quantidadeAssinada, 12, "…e quantidade positiva, sem alterar NORMAL");
  eq(paraPayload(guia).sourceNamespace, T, "o payload leva o namespace certo");
  eq(paraPayload(guia).naturezaVenda, "TRANSFERENCIA", "…e a natureza certa");

  // Não se filtra por [Fim Venda]: já foi refutado como classificador
  // duas vezes, e o zero trata dos anulados sozinho.
  const fontes = readFileSync(new URL("../../agent/src/vendas-fontes.ts", import.meta.url), "utf8");
  const r = sqlAtendimentoCredito({
    existe: true, cabecalhoTabela: "Atendimento Credito",
    detalheTabela: "Atendimento Credito Detalhe",
    cabecalhoPk: "Atendimento Credito ID", detalhePk: "Atendimento Credito Detalhe ID",
    chaveLigacao: "Atendimento Credito ID", data: "Data Venda",
    serie: "SerieFacturacao", numero: "Numero Documento",
    tipoDocumento: "Tipo Documento ID", codigoId: "CodigoID", quantidade: "Quantidade",
    pvpUnitario: null, valorLinha: "Valor_EUR", ivaValor: "IVA",
    entidadeId: null, sequencia: null, estado: "Fim Venda",
    candidatas: ["Atendimento Credito", "Atendimento Credito Detalhe"],
  });
  if (r.estado === "PRONTA") {
    check(!/Fim Venda/.test(r.sql), "o reader não filtra por [Fim Venda]");
    check(/AS serie/.test(r.sql), "…e traz a série, que é quem decide a natureza");
  }
  check(
    !/tblMovStocks/i.test(fontes),
    "as guias NÃO vêm de tblMovStocksCab",
    "a rev76 avaliou esse universo contra o gate e não reproduziu",
  );
}

console.log("\n=== a MESMA regra no backfill e no daily ===");
{
  // Foi precisamente este o defeito do `Fim Venda`: o backfill ficava
  // certo e cada noite voltava a divergir. As três fontes e a resolução
  // por série têm de estar nos DOIS caminhos.
  for (const f of ["bootstrap-upload", "daily-sync-runner"]) {
    const src = readFileSync(
      new URL(`../../agent/src/commands/${f}.ts`, import.meta.url),
      "utf8",
    );
    check(
      /sqlAtendimentoCredito\(credito\)/.test(src),
      `${f}: lê o circuito [Atendimento Credito]`,
    );
    check(
      /namespacePorLinha: \(row\) => namespaceDaSerieCredito\(txtSerie\(row\.serie\)\)/.test(src),
      `${f}: resolve a natureza pela SÉRIE, por linha`,
    );
    check(
      /namespacePorLinha \? [^\n]*\(row\) : fonte\.namespace/.test(src),
      `${f}: e usa esse namespace ao normalizar`,
    );
    check(
      /GUIAS_TRANSFERENCIA/.test(src),
      `${f}: conhece o namespace das guias`,
    );
  }
}

console.log("\n=== transferências não falseiam procura ===");
{
  // Uma transferência entre as nossas farmácias não é procura de utente.
  // Contá-la como tal inflaria a oportunidade de substituição, a
  // rotação e as sugestões de reposição com stock que só mudou de sítio.
  const opp = readFileSync(new URL("../../app/oportunidades/page.tsx", import.meta.url), "utf8");
  check(
    /vm\."naturezaVenda" = 'NORMAL'/.test(opp),
    "oportunidades conta apenas NORMAL",
  );
  // E o default do mapa mantém as guias FORA.
  eq(
    naturezasIncluidas({}),
    ["NORMAL", "CREDITO"],
    "o default do mapa NÃO inclui transferências",
  );
  check(
    !naturezasIncluidas({ incluirCredito: true }).includes("TRANSFERENCIA"),
    "ligar 'vendas a crédito' NÃO traz as guias",
    "é o ponto todo de a natureza ser decidida pela série e não pela tabela",
  );
  check(
    naturezasIncluidas({ incluirTransferencias: true }).includes("TRANSFERENCIA"),
    "…e ligar 'guias de transferência' traz",
  );
}

console.log("\n=== os três gates, e a aritmética entre eles ===");
{
  // Os totais são FIXTURES de regressão, nunca lógica de produção: o
  // reader lê o ERP e o gate compara. Se algum dia um deles for usado
  // para produzir um número, isto deixa de ser uma verificação.
  for (const g of GATES_SILVEIRENSE_2026) {
    eq(
      g.normalMaisCredito + g.transferencias,
      g.comTransferencias,
      `${nomeMes(g.mes)}: NORMAL + TRANSFERENCIA = modo B`,
    );
  }
  const par = readFileSync(
    new URL("../../agent/src/commands/vendas-paridade.ts", import.meta.url),
    "utf8",
  );
  check(/TRANSFERENCIA isolada \(serie VCG_1\)/.test(par), "vendas-paridade testa a transferência isolada");
  check(/MODO A/.test(par) && /MODO B/.test(par), "…e os dois modos do relatório");
  check(
    /OS TRES GATES PASSAM 7\/7 COM DESVIO ZERO/.test(par),
    "…e dá um veredicto único",
    "sem ele, fechar a fase depende de alguém ler três tabelas e somar de cabeça",
  );
  check(
    /SERIES DO CIRCUITO \[Atendimento Credito\] POR DECLARAR/.test(par),
    "…e reporta as séries que recusou, com as unidades",
  );
}

console.log("\n=== a regra da transferência está POR DECLARAR, e recusa ===");
{
  // Uma transferência tem dois lados e o nome da série não diz qual
  // deles o relatório conta. Enquanto o gate mensal não escolher, isto
  // fica vazio e o reader não corre. Um reader que soma o lado errado dá
  // um total plausível e errado — a forma de erro que já custou o 77, o
  // `Fim Venda='S'` e o 107 sem sinal.
  eq(REGRA_TRANSFERENCIA.direccao, null, "a direcção está por declarar");
  eq(REGRA_TRANSFERENCIA.series, [], "…e as séries também");
  check(
    /vendas-extra-discover/.test(REGRA_TRANSFERENCIA.evidencia),
    "…e a evidência diz que comando a resolve",
    "uma constante vazia sem proveniência acaba preenchida por palpite",
  );

  // A sonda tem de calcular as quatro leituras — não escolher uma.
  const probe = readFileSync(
    new URL("../../agent/src/commands/vendas-extra-discover.ts", import.meta.url),
    "utf8",
  );
  for (const h of ["SAIDAS", "ENTRADAS", "AMBAS_SINAL", "AMBAS_ABS"]) {
    check(probe.includes(h), `a sonda calcula a leitura ${h}`);
  }
  check(
    /GATES_SILVEIRENSE_2026/.test(probe) && /avaliarGate/.test(probe),
    "…e compara-as com o gate mensal, não com o olho",
  );
  check(
    /NENHUM CANDIDATO REPRODUZ O GATE/.test(probe),
    "…e diz o que fazer se nenhum bater",
    "sem isso, a ausência de match lê-se como erro da sonda e alguém força uma regra",
  );
  check(
    /MENOR\s*\n?\s*CONJUNTO DE INFORMACAO EM FALTA|MENOR/.test(probe),
    "…nomeando o menor conjunto de informação ainda em falta",
  );
  // Descoberta, não nomes à mão — a mesma lição da §4 do vendas-susp-tipos.
  check(
    /listPrimaryKey/.test(probe) && /listColumns/.test(probe),
    "a sonda resolve tudo por metadata",
  );
  // O crédito real continua fail-closed. As guias já não: o tipo 38 foi
  // confirmado funcionalmente e reproduz o gate mensal com desvio zero.
  eq(
    CLASSIFICACAO[NAMESPACES.VENDAS_CREDITO].venda.size +
      CLASSIFICACAO[NAMESPACES.VENDAS_CREDITO].reversao.size +
      CLASSIFICACAO[NAMESPACES.VENDAS_CREDITO].peloSinal.size,
    0,
    "VENDAS_CREDITO: nenhum tipo declarado — nada entra por engano",
  );
}

console.log("\n=== os interruptores do mapa ===");
{
  // Os defaults são a configuração do relatório oficial contra o qual
  // reconciliamos: crédito = Sim, transferências = Não. Um default
  // errado aqui não dá erro nenhum — dá um mapa que não bate com o balcão.
  eq(naturezasIncluidas({}), ["NORMAL", "CREDITO"], "default: normal + crédito");
  eq(
    naturezasIncluidas({ incluirTransferencias: true }),
    ["NORMAL", "CREDITO", "TRANSFERENCIA"],
    "com transferências: as três",
  );
  eq(naturezasIncluidas({ incluirCredito: false }), ["NORMAL"], "sem crédito: só normal");
  eq(
    naturezasIncluidas({ incluirCredito: false, incluirTransferencias: true }),
    ["NORMAL", "TRANSFERENCIA"],
    "os dois interruptores são independentes",
  );
  // NORMAL está sempre lá: um mapa de vendas sem a venda de balcão não é
  // um mapa de vendas.
  for (const c of [true, false]) {
    for (const t of [true, false]) {
      check(
        naturezasIncluidas({ incluirCredito: c, incluirTransferencias: t }).includes("NORMAL"),
        `NORMAL presente com credito=${c} transf=${t}`,
      );
    }
  }
  eq(DEFAULT_INCLUIR_CREDITO, true, "o default de crédito é ON");
  eq(DEFAULT_INCLUIR_TRANSFERENCIAS, false, "o default de transferências é OFF");

  // A MESMA lista nos dois caminhos do loader. Se divergissem, um
  // relatório que atravessa o início de um mês somava populações
  // diferentes de cada lado da fronteira — e só nos períodos que
  // ninguém verifica à mão.
  const loader = readFileSync(new URL("../../lib/vendas-data.ts", import.meta.url), "utf8");
  const usos = (loader.match(/naturezaVenda"\s*=\s*ANY\(\$\{naturezas\}\)/g) ?? []).length;
  eq(usos, 2, "o filtro de natureza aplica-se aos DOIS caminhos (VendaMensal e raw)");
  check(
    /const naturezas = naturezasIncluidas\(filters\)/.test(loader),
    "…e a lista é calculada UMA vez",
  );
}

console.log("\n=== a agregação preserva a dimensão ===");
{
  // Somar as três naturezas na agregação seria irreversível: a partir daí
  // não há filtro que as separe, e ligar/desligar o crédito no mapa
  // obrigava a reprocessar o histórico.
  const agg = readFileSync(new URL("../../lib/aggregate/vendamensal.ts", import.meta.url), "utf8");
  check(
    /GROUP BY "farmaciaId", "produtoId", "naturezaVenda"/.test(agg),
    "a agregação agrupa POR natureza",
  );
  check(/naturezaVenda: r\.naturezaVenda/.test(agg), "…e escreve-a em VendaMensal");
  const schema = readFileSync(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");
  check(
    /@@unique\(\[farmaciaId, produtoId, ano, mes, naturezaVenda\]\)/.test(schema),
    "a natureza faz parte da CHAVE de VendaMensal",
    "sem isso, duas naturezas do mesmo produto/mês colidiam e uma sobrescrevia a outra",
  );
  // O default preserva o histórico: tudo o que está gravado veio dos dois
  // circuitos normais, portanto nada pode ter outra natureza.
  check(
    /naturezaVenda String @default\("NORMAL"\)/.test(schema),
    "o default é NORMAL — o histórico existente não precisa de reprocessamento",
  );
}

console.log("\n=== os gates do relatório oficial ===");
{
  // Enquanto os alvos viverem numa conversa, cada corrida acaba com
  // alguém a olhar para duas colunas e a decidir se está bom.
  eq(GATES_SILVEIRENSE_2026.length, 7, "sete meses com gate — Jan a Jul");
  check(
    !GATES_SILVEIRENSE_2026.some((g) => g.mes === 8),
    "Agosto está de fora",
    "os dois relatórios cobrem períodos diferentes (um até 19/08); comparar produziria um desvio que não é defeito",
  );
  for (const g of GATES_SILVEIRENSE_2026) {
    eq(
      g.comTransferencias - g.normalMaisCredito,
      g.transferencias,
      `${nomeMes(g.mes)}: modo B − modo A = população de transferências`,
    );
    // O que faltava no SPharm.MT tem de ser explicado pelo TipoDoc 7 / U.
    const faltava = g.normalMaisCredito - (ANTES_SPHARM_MT_2026[g.mes] ?? 0);
    check(
      Math.abs(faltava - g.tipoDoc7EstadoU) <= 1,
      `${nomeMes(g.mes)}: o buraco (${faltava}) bate com TipoDoc 7/U (${g.tipoDoc7EstadoU})`,
      "se deixar de bater, a causa raiz mudou e a correcção do reader deixou de ser suficiente",
    );
  }
  // O gate não arredonda: 0 unidades de tolerância.
  eq(TOLERANCIA_UNIDADES, 0, "a tolerância é ZERO — paridade, não aproximação");
  eq(avaliarGate(1, 13270, 13270).passa, true, "bate exactamente → PASSA");
  eq(avaliarGate(1, 13270, 13269).passa, false, "uma unidade a menos → FALHA");
  eq(avaliarGate(1, 13270, 12862).desvio, -408, "o desvio é reportado com sinal");
}

console.log("\n=== a regra do sinal tem de SOBREVIVER ao servidor ===");
{
  // ISTO É O PONTO QUE FAZ A REGRA VALER ALGUMA COISA.
  //
  // O agent classifica por circuito + tipo + sinal. O endpoint de
  // ingestão tinha uma tabela `TipoDocumentoClassificacao` indexada só
  // por `tipoDocumento`, e essa tabela GANHAVA ao payload. Uma linha
  // `107 → VENDA` lá dentro reescrevia as 2 078 anulações da
  // Silveirense como vendas, à entrada, e todo o trabalho do agent
  // desaparecia sem um único erro.
  const rota = readFileSync(
    new URL("../../app/api/ingest/v1/bootstrap/sales-lines/route.ts", import.meta.url),
    "utf8",
  );
  check(
    /CLASSES_DECIDIDAS\.has\(clientClass\)/.test(rota),
    "a decisão do agent é consultada PRIMEIRO",
    "só o agent conhece o circuito e o sinal; a tabela não vê nem um nem outro",
  );
  check(
    /if \(CLASSES_DECIDIDAS\.has\(clientClass\)\)[\s\S]{0,120}else if \([\s\S]{0,60}classifierMap\.has/.test(rota),
    "…e a tabela server-side é o FALLBACK, não o contrário",
  );
  check(
    !/CLASSES_DECIDIDAS = new Set\(\[[^\]]*"UNKNOWN"/.test(rota),
    "UNKNOWN não conta como decisão — cai para a tabela, como sempre caiu",
    "deixá-lo ganhar transformava um agent que não sabe num agent que impõe que não se sabe",
  );
  check(/origemClasse/.test(rota), "…e o log diz de onde veio a classe de cada linha");

  // O outro caminho por onde a regra podia ser desfeita: um UPDATE em
  // massa por tipo, sobre todos os circuitos, num só comando.
  const recl = readFileSync(
    new URL("../../scripts/reclassify-ingest-vendas.ts", import.meta.url),
    "utf8",
  );
  check(
    /foraDoSuspenso\s*=\s*\{ sourceNamespace: \{ not: NS_SUSPENSO \} \}/.test(recl),
    "reclassify-ingest-vendas exclui o circuito suspenso",
    "updateMany por tipo reescrevia as duas metades do 107 com a mesma classe",
  );
  // O filtro do UPDATE tem de ser o MESMO do diff que o operador viu.
  const nUpdate = (recl.match(/\.\.\.foraDoSuspenso/g) ?? []).length;
  check(nUpdate >= 3, `…no diff, no UPDATE e no aviso de não-classificados (${nUpdate} usos)`);
}

console.log("\n=== o dry-run tem de exercitar o reader NOVO ===");
{
  // A armadilha: `bootstrap-dry-run` é um comando separado, com SQL
  // próprio, que NÃO passa por `vendas-fontes.ts`. Validar o VSG com ele
  // não valida nada — lê outro código. O dry-run que serve é o do
  // próprio `bootstrap-upload`.
  const dry = readFileSync(
    new URL("../../agent/src/commands/bootstrap-dry-run.ts", import.meta.url), "utf8");
  // Importa a CLASSIFICAÇÃO de `vendas-fontes` — e deve, senão o preview
  // discorda do reader. O que continua a não fazer é LER a fonte
  // suspensa: não toca em `[Atendimento Susp Detalhe]` nem no namespace.
  check(
    !/Atendimento Susp/.test(dry) && !dry.includes("ATENDIMENTO_SUSP_DETALHE"),
    "bootstrap-dry-run NÃO lê a venda suspensa — é outro caminho",
    "se um dia passar a ler, esta asserção cai e o aviso no --help deixa de ser verdade",
  );
  check(
    dry.includes("classificarDocumento"),
    "…mas classifica com a MESMA regra do reader",
    "tinha uma cópia local com o 77, e mostrava a venda toda como UNKNOWN",
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
