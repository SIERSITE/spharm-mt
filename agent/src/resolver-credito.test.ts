/**
 * agent/src/resolver-credito.test.ts
 *
 * O resolver do circuito `[Atendimento Credito]`, contra o schema REAL
 * da Silveirense. Sem base de dados.
 *
 * ── O DEFEITO QUE ISTO IMPEDE DE VOLTAR ──────────────────────────────
 *
 * A rev77 abortou o bootstrap com
 *
 *     Atendimento Credito (serie decide a natureza): a tabela existe
 *     mas nao foi possivel liga-la. Faltam: data, tipo de documento.
 *
 * numa base onde a rev76 já tinha impresso `data = Data Venda` e
 * `tipoDoc = Tipo Documento ID`. As colunas estavam lá.
 *
 * O erro estava na escolha da TABELA: `find()` sobre um `SELECT` de
 * `sys.tables` sem `ORDER BY`, e um padrão de PK não ancorado
 * (`/credito\s*id$/i`) que aceitava qualquer coluna terminada em
 * "Credito ID". Bastava outra tabela com "credito" no nome vir primeiro
 * para ser escolhida como cabeçalho — e num cabeçalho errado a
 * `Data Venda` não existe mesmo.
 *
 * A prova aqui é directa: o mesmo conjunto de tabelas, com uma intrusa
 * que ordena ANTES da verdadeira, e o resolver tem de escolher o par
 * certo à mesma.
 *
 * Uso: npx tsx agent/src/resolver-credito.test.ts
 */
import { readFileSync } from "node:fs";
import {
  resolverColuna,
  sqlAtendimentoCredito,
  type SchemaFonteCredito,
} from "./vendas-fontes.js";
import { ALIAS_FONTE_VENDA, validarSelect } from "./sql-validador.js";

let pass = 0;
let fail = 0;
const ok = (l: string) => { pass++; console.log(`  [OK]    ${l}`); };
const bad = (l: string, d?: string) => { fail++; console.log(`  [FALHA] ${l}${d ? `\n            ${d}` : ""}`); };
const check = (c: boolean, l: string, d?: string) => (c ? ok(l) : bad(l, d));
const eq = (a: unknown, b: unknown, l: string) =>
  check(a === b, l, `esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);

const col = (...nomes: string[]) => nomes.map((column) => ({ column }));

// ── O schema REAL medido na Silveirense ──────────────────────────────

const CAB_REAL = col(
  "Atendimento Credito ID",
  "Data Venda",
  "SerieFacturacao",
  "Numero Documento",
  "Tipo Documento ID",
  "Fim Venda",
);

const DET_REAL = col(
  "Atendimento Credito Detalhe ID",
  "Atendimento Credito ID",
  "CodigoID",
  "Quantidade",
  "Valor_EUR",
);

console.log("=== o schema real resolve, campo a campo ===");
{
  eq(resolverColuna(CAB_REAL, ["Data Venda", "Data"], [/^data\s*venda$/i]), "Data Venda", "data = Data Venda");
  eq(
    resolverColuna(CAB_REAL, ["Tipo Documento ID", "Tipo Documento"], [/^tipo\s*documento\s*id$/i]),
    "Tipo Documento ID",
    "tipoDoc = Tipo Documento ID",
  );
  eq(
    resolverColuna(CAB_REAL, ["SerieFacturacao", "Serie"], [/^serie\s*facturacao$/i]),
    "SerieFacturacao",
    "serie = SerieFacturacao",
  );
  eq(
    resolverColuna(CAB_REAL, ["Numero Documento", "Numero"], [/^numero\s*documento$/i]),
    "Numero Documento",
    "numero = Numero Documento",
  );
  eq(resolverColuna(CAB_REAL, ["Fim Venda"], [/fim\s*venda/i]), "Fim Venda", "estado = Fim Venda");
  eq(resolverColuna(DET_REAL, ["CodigoID"], [/^codigo\s*id$/i]), "CodigoID", "produto = CodigoID");
  eq(resolverColuna(DET_REAL, ["Quantidade"], [/^quantidade$/i]), "Quantidade", "qtd = Quantidade");
  eq(resolverColuna(DET_REAL, ["Valor_EUR", "Valor"], [/^valor_eur$/i]), "Valor_EUR", "valor = Valor_EUR");
  eq(
    resolverColuna(CAB_REAL, ["Atendimento Credito ID"], [/^atendimento\s*credito\s*id$/i]),
    "Atendimento Credito ID",
    "pk do cabeçalho",
  );
  eq(
    resolverColuna(DET_REAL, ["Atendimento Credito Detalhe ID"], [/detalhe\s*id$/i]),
    "Atendimento Credito Detalhe ID",
    "pk do detalhe",
  );
}

console.log("\n=== o nome exacto ganha ao padrão ===");
{
  // Um padrão apanha a primeira coluna que casa; um nome medido apanha
  // a certa. Numa tabela com `Data` e `Data Venda`, o padrão `/^data$/i`
  // testado antes escolheria a errada — por isso os exactos vêm sempre
  // primeiro, pela ordem em que foram observados.
  const ambiguo = col("Data", "Data Venda", "Data Fecho");
  eq(
    resolverColuna(ambiguo, ["Data Venda", "Data"], [/^data$/i]),
    "Data Venda",
    "com `Data` e `Data Venda`, ganha a que foi medida",
  );
  // …e a ordem dos exactos é a prioridade.
  eq(
    resolverColuna(ambiguo, ["Data", "Data Venda"], []),
    "Data",
    "a ordem da lista de exactos é a prioridade",
  );
}

console.log("\n=== o padrão continua a servir outras instalações ===");
{
  // Os nomes exactos não podem ser o ÚNICO caminho: outra instalação
  // Softreis pode nomear as colunas de outra forma, e é para isso que
  // os padrões existem.
  const variante = col("AtendimentoCreditoID", "DataVenda", "Serie", "TipoDocumento");
  eq(
    resolverColuna(variante, ["Data Venda"], [/^data\s*venda$/i]),
    "DataVenda",
    "`DataVenda` sem espaço resolve pelo padrão",
  );
  eq(
    resolverColuna(variante, ["SerieFacturacao"], [/^serie\s*facturacao$/i, /^serie$/i]),
    "Serie",
    "`Serie` resolve pelo fallback",
  );
  eq(
    resolverColuna(variante, ["Tipo Documento ID"], [/^tipo\s*documento\s*id$/i, /^tipo\s*documento$/i]),
    "TipoDocumento",
    "`TipoDocumento` resolve pelo padrão sem ID",
  );
  eq(resolverColuna(variante, ["Data Venda"], []), null, "sem exacto nem padrão → null, não um palpite");
  eq(resolverColuna(null, ["Data Venda"], [/data/i]), null, "tabela inexistente → null");
}

console.log("\n=== a tabela intrusa não rouba o cabeçalho ===");
{
  // ISTO É O DEFEITO DA REV77, reproduzido.
  //
  // `Atendimento Credito Anulados` ordena ANTES de `Atendimento
  // Credito` num ORDER BY? Não — mas `Alteracoes Credito` sim. O ponto
  // é que a escolha não pode depender da ordem: um cabeçalho só é
  // candidato se tiver a chave de ligação E uma data, e entre
  // candidatos ganha o mais completo.
  //
  // Esta é a simulação da regra de emparelhamento que
  // `descobrirSchemaCredito` aplica.
  const INTRUSA = col("Alteracoes Credito ID", "Utilizador", "Momento");
  const tabelas: Array<{ nome: string; cols: ReturnType<typeof col> }> = [
    { nome: "Alteracoes Credito", cols: INTRUSA },
    { nome: "Atendimento Credito", cols: CAB_REAL },
  ];
  const colsDet = DET_REAL;

  const candidatos = tabelas.filter((t) => {
    const chave = t.cols.find(
      (c) =>
        /credito.*id$/i.test(c.column) &&
        !/detalhe/i.test(c.column) &&
        colsDet.some((d) => d.column.toLowerCase() === c.column.toLowerCase()),
    );
    const data = resolverColuna(t.cols, ["Data Venda", "Data"], [/^data\s*venda$/i, /^data$/i]);
    return !!chave && !!data;
  });
  eq(candidatos.length, 1, "só UM par satisfaz chave-de-ligação + data");
  eq(candidatos[0]?.nome, "Atendimento Credito", "…e é o cabeçalho verdadeiro");

  // A intrusa tem uma coluna terminada em "Credito ID" — era isso que
  // o padrão não ancorado da rev77 aceitava.
  check(
    /credito\s*id$/i.test("Alteracoes Credito ID"),
    "a intrusa CASA no padrão não ancorado da rev77",
    "é por isso que a escolha não pode assentar só nesse padrão",
  );
  // …mas não partilha a chave com o detalhe, e é isso que a exclui.
  check(
    !colsDet.some((d) => d.column.toLowerCase() === "alteracoes credito id"),
    "…e é excluída por não partilhar a chave com o detalhe",
  );
}

console.log("\n=== a escolha é determinística ===");
{
  // Sem ORDER BY, duas corridas na mesma base podiam escolher tabelas
  // diferentes — e o erro aparecia numa e não na outra.
  const fontes = readFileSync(new URL("./vendas-fontes.ts", import.meta.url), "utf8");
  check(
    /FROM sys\.tables t WHERE t\.is_ms_shipped = 0 ORDER BY t\.name/.test(fontes),
    "a listagem de tabelas tem ORDER BY",
  );
  check(
    /pares\.sort\(/.test(fontes),
    "…e os pares candidatos são ordenados antes de escolher",
  );
  check(
    /candidatas: comCredito/.test(fontes),
    "as tabelas candidatas viajam no schema, para a mensagem de erro",
    "a rev77 disse o que faltava e não onde procurou — custou uma ronda",
  );
}

console.log("\n=== ponta a ponta: o schema real produz uma query PRONTA ===");
{
  // O que a rev77 não conseguiu fazer nesta base.
  const schema: SchemaFonteCredito = {
    existe: true,
    cabecalhoTabela: "Atendimento Credito",
    detalheTabela: "Atendimento Credito Detalhe",
    cabecalhoPk: resolverColuna(CAB_REAL, ["Atendimento Credito ID"], []),
    detalhePk: resolverColuna(DET_REAL, ["Atendimento Credito Detalhe ID"], []),
    chaveLigacao: "Atendimento Credito ID",
    data: resolverColuna(CAB_REAL, ["Data Venda", "Data"], [/^data\s*venda$/i]),
    serie: resolverColuna(CAB_REAL, ["SerieFacturacao", "Serie"], [/^serie$/i]),
    numero: resolverColuna(CAB_REAL, ["Numero Documento", "Numero"], [/^numero$/i]),
    tipoDocumento: resolverColuna(CAB_REAL, ["Tipo Documento ID"], [/^tipo\s*documento$/i]),
    estado: resolverColuna(CAB_REAL, ["Fim Venda"], [/fim\s*venda/i]),
    codigoId: resolverColuna(DET_REAL, ["CodigoID"], [/^codigo\s*id$/i]),
    quantidade: resolverColuna(DET_REAL, ["Quantidade"], [/^quantidade$/i]),
    pvpUnitario: null,
    valorLinha: resolverColuna(DET_REAL, ["Valor_EUR", "Valor"], [/^valor$/i]),
    ivaValor: null,
    entidadeId: null,
    sequencia: null,
    candidatas: ["Atendimento Credito", "Atendimento Credito Detalhe"],
  };
  const r = sqlAtendimentoCredito(schema);
  eq(r.estado, "PRONTA", "o schema da Silveirense produz uma fonte PRONTA");
  if (r.estado === "POR_LIGAR") bad("faltas inesperadas", r.faltam.join(", "));
  if (r.estado === "PRONTA") {
    const p = validarSelect(r.sql, ALIAS_FONTE_VENDA);
    check(p.length === 0, "…e a query é válida", JSON.stringify(p));
    check(/h\.\[Data Venda\] AS dataVenda/.test(r.sql), "a data entra no SELECT");
    check(/h\.\[Tipo Documento ID\] AS tipoDocumento/.test(r.sql), "o tipo de documento entra");
    check(/h\.\[SerieFacturacao\] AS serie/.test(r.sql), "a série entra — é quem decide a natureza");
    check(/d\.\[Valor_EUR\] AS valorLinha/.test(r.sql), "o valor entra");
    check(
      /JOIN \[dbo\]\.\[Atendimento Credito\] h ON h\.\[Atendimento Credito ID\] = d\.\[Atendimento Credito ID\]/.test(r.sql),
      "a ligação é pela chave lógica comum",
    );
    check(!/\[Fim Venda\]/.test(r.sql), "[Fim Venda] NÃO entra em filtro nenhum");
  }
  // Sem série o circuito não pode correr: todas as linhas seriam
  // recusadas em silêncio, e isso é pior do que parar.
  const semSerie = sqlAtendimentoCredito({ ...schema, serie: null });
  eq(semSerie.estado, "POR_LIGAR", "sem série → POR_LIGAR");
  if (semSerie.estado === "POR_LIGAR") {
    check(semSerie.faltam.includes("serie"), "…e diz que falta a série");
    check(
      semSerie.faltam.some((f) => /cabecalho escolhido/.test(f)),
      "…e diz QUE tabelas escolheu e quais eram as candidatas",
      "a rev77 disse o que faltava e não onde procurou",
    );
  }
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail === 0 ? 0 : 1);
