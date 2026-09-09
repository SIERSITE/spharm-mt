/**
 * agent/src/catalogo-retirado-diario.test.ts
 *
 * Um artigo retirado que se mexeu no dia entra no catálogo do dia — e
 * entra marcado como retirado.
 *
 * ── O caso ───────────────────────────────────────────────────────────
 *
 * Farmácia Principal, CodigoID 11899, CNP 5057674, «Atorvastatina Alter
 * 10 Mg 56 Comp. Revest. Por Pel.», `Retirado = 1`,
 * `Processa_Stocks = -1`. Devolução/anulação a 2026-09-03 09:48.
 *
 * O catálogo diário filtrava `Retirado = 0`, portanto o artigo nunca
 * chegava ao SaaS; a linha de devolução chegava na mesma e ficava sem
 * `produtoId` — um *operational orphan*. Duas linhas assim bloquearam o
 * `aggregate-month` de Setembro das CINCO farmácias do tenant garantia,
 * porque o mês agrega uma vez para todas.
 *
 * A justificação do filtro estava escrita em `catalogo-historico.test.ts`:
 * «um artigo retirado não tem vendas nem stock novos para sincronizar».
 * É verdade para vendas. É falso para devoluções e anulações, que são
 * exactamente linhas novas de artigos retirados.
 *
 * ── O que este teste garante ─────────────────────────────────────────
 *
 * As quatro combinações que interessam, e a ordem por que se partem:
 *
 *   Retirado=1 · Processa_Stocks<>0 · mexeu no dia ....... ENTRA
 *   Retirado=1 · Processa_Stocks<>0 · não mexeu no dia ... fica fora
 *   Retirado=1 · Processa_Stocks=0  · mexeu no dia ....... fica fora
 *   Retirado=0 · Processa_Stocks<>0 · na janela de datas . ENTRA (como sempre)
 *
 * Verifica-se na query GERADA, não num sósia dela em JavaScript: uma
 * segunda implementação do predicado divergiria da primeira, e a que
 * divergiria em silêncio era a do teste. A prova executável final é o
 * `daily-sync-dry-run` contra o ERP — é o que o `sql-validador` também
 * diz de si próprio.
 *
 * Uso: npx tsx agent/src/catalogo-retirado-diario.test.ts
 */
import { buildProductsSql, type SchemaCapabilities } from "./commands/daily-sync-runner.js";
import { validarSelect } from "./sql-validador.js";

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
const ok = (cond: boolean, label: string, extra?: string) => {
  if (cond) {
    pass++;
    console.log(`  [OK]    ${label}`);
  } else {
    fail++;
    console.log(`  [FALHA] ${label}${extra ? ` — ${extra}` : ""}`);
  }
};

/** O ERP normal: tem StocksMov, tem Data_Actualiz. */
const COMPLETO: SchemaCapabilities = {
  hasStocksMov: true,
  stocksMovDateCol: "DataMov",
  hasDataActualiz: true,
};
/** Um ERP sem StocksMov — o pipeline de produtos tem de continuar a correr. */
const SEM_MOVIMENTOS: SchemaCapabilities = {
  hasStocksMov: false,
  stocksMovDateCol: null,
  hasDataActualiz: false,
};

const sql = buildProductsSql(COMPLETO);
const sqlSemMov = buildProductsSql(SEM_MOVIMENTOS);

/**
 * O WHERE de topo, sem o SELECT nem o ORDER BY.
 *
 * Ancorado no `LEFT JOIN [dbo].[Fornecedores]` e não no primeiro
 * "WHERE" do texto: o primeiro pertence ao `OUTER APPLY`, e recortar por
 * ele devolvia a sub-query. As contagens davam zero e passavam à mesma,
 * porque zero ocorrências de um filtro é indistinguível de zero
 * ocorrências de um filtro duplicado se ninguém olhar.
 */
const clausulaWhere = (q: string): string => {
  const ancora = q.indexOf("LEFT JOIN [dbo].[Fornecedores]");
  if (ancora === -1) throw new Error("âncora do WHERE de topo não encontrada");
  const i = q.indexOf("WHERE", ancora);
  const j = q.indexOf("ORDER BY", i);
  return q.slice(i, j === -1 ? undefined : j);
};
const where = clausulaWhere(sql);

/** Sem espaços nem quebras: compara estrutura, não indentação. */
const denso = (s: string) => s.replace(/\s+/g, "");

// ── 1. A query inteira continua a ser uma query ─────────────────────
//
// Fragmentos correctos não fazem uma query correcta — foi o que deixou
// passar a lista de SELECT sem vírgulas. Isto valida o todo.
//
// `validarSelect` acusa duas coisas nesta query, e acusava-as ANTES
// desta alteração — confirmado a correr o validador contra a versão em
// HEAD. São limites do validador, não defeitos da query:
//
//   · `parametro` — a lista de parâmetros conhecidos é `@n/@from/@to/
//     @lastId`, escrita para os readers de vendas. O catálogo diário usa
//     `@date`, legitimamente.
//   · `keyset` — o padrão só reconhece colunas entre parêntesis rectos ou
//     sem qualificador; `s.CodigoID > @lastId` casa como `CodigoID` e não
//     bate com `ORDER BY s.CodigoID`. A paginação está correcta; é o
//     reconhecedor que não a lê.
//
// Fixa-se o CONJUNTO de regras, não a ausência delas: uma vírgula que
// desapareça, ou uma cláusula fora de ordem, acrescenta uma regra nova e
// isto falha. Baixar para "sem problemas" seria mentir; apagar a
// verificação seria pior.
const BASE_CONHECIDA = ["keyset", "parametro"];
console.log("\n=== a query gerada é válida ===");
{
  for (const [nome, q] of [["com StocksMov", sql], ["sem StocksMov", sqlSemMov]] as const) {
    const regras = [...new Set(validarSelect(q).map((p) => p.regra))].sort();
    eq(`${nome}: nenhum problema estrutural novo`, regras.join(","), BASE_CONHECIDA.join(","));
  }
  // Parêntesis: o ramo novo acrescenta um nível, e é onde se erra.
  for (const [nome, q] of [["com StocksMov", sql], ["sem StocksMov", sqlSemMov]] as const) {
    eq(
      `${nome}: parêntesis equilibrados`,
      (q.match(/\(/g) ?? []).length,
      (q.match(/\)/g) ?? []).length,
    );
  }
}

// ── 2. Retirado + movimento no dia → ENTRA ──────────────────────────
console.log("\n=== o retirado que se mexeu no dia entra ===");
{
  ok(
    /EXISTS \(\s*SELECT 1 FROM \[dbo\]\.\[StocksMov\] sm/.test(where),
    "há um ramo por movimento em StocksMov",
    where,
  );
  ok(
    /WHERE sm\.CodigoID = s\.CodigoID/.test(where),
    "…ligado ao artigo pelo CodigoID",
  );
  // O OR é o que faz o ramo ser uma alternativa ao activo, e não mais
  // uma condição obrigatória. Sem ele, isto não recupera nada.
  ok(
    /\)\s*OR EXISTS \(/.test(where),
    "…em OR com o ramo do activo, não em AND",
    where,
  );
}

// ── 3. Retirado SEM movimento no dia → fica fora ────────────────────
console.log("\n=== o retirado que não se mexeu no dia não entra ===");
{
  // O ramo do movimento está preso ao dia. Sem esta ligação, o primeiro
  // dia de catch-up arrastava o histórico inteiro de retirados.
  ok(
    /AND CAST\(sm\.\[DataMov\] AS DATE\) = @date/.test(where),
    "o movimento é o do dia processado (@date)",
    where,
  );
  ok(
    !/sm\.\[DataMov\] >=|sm\.\[DataMov\] <|@histFrom|@histTo/.test(where),
    "…um dia, não uma janela histórica",
  );
  // `Retirado = 0` existe UMA vez e vive DENTRO do ramo do activo.
  // É isto que garante que um retirado só tem uma porta de entrada: a
  // do movimento. Se alguém o subir para o topo do WHERE, o ramo novo
  // fica inalcançável e ninguém dá por isso.
  eq("`Retirado = 0` aparece uma só vez", (where.match(/s\.\[Retirado\] = 0/g) ?? []).length, 1);
  ok(
    /\(\s*s\.\[Retirado\] = 0\s*AND \(/.test(where),
    "…dentro do ramo do activo, colado à janela de datas",
    where,
  );
  ok(
    !/WHERE s\.\[Retirado\] = 0/.test(where),
    "…e nunca como primeira condição do WHERE",
  );
}

// ── 4. Processa_Stocks continua obrigatório ─────────────────────────
console.log("\n=== Processa_Stocks <> 0 é obrigatório, fora do OR ===");
{
  // Serviços também têm ficha em dbo.Stocks nesta instalação
  // (CHECKSAUDE, vacinação, ***DIVERSOS***). Sem este filtro entram no
  // catálogo como medicamentos — e um serviço retirado que se mexeu no
  // dia passaria a entrar pela porta nova.
  ok(
    /WHERE s\.\[Processa_Stocks\] <> 0\s*AND s\.CodigoID > @lastId/.test(where),
    "está no topo do WHERE, antes do grupo do âmbito",
    where,
  );
  eq(
    "aparece uma só vez",
    (where.match(/s\.\[Processa_Stocks\] <> 0/g) ?? []).length,
    1,
  );
  // Se estivesse dentro de um dos ramos, o outro ramo escapava-lhe.
  ok(
    !/OR[\s\S]{0,80}Processa_Stocks/.test(where),
    "…e não dentro de nenhum dos ramos do OR",
  );
}

// ── 5. O ramo do activo não mudou ───────────────────────────────────
console.log("\n=== o artigo activo entra pelo critério de sempre ===");
{
  ok(
    /CAST\(s\.\[Data Ultima Venda\] AS DATE\) = @date/.test(where),
    "janela: última venda no dia",
  );
  ok(
    /OR CAST\(s\.\[Data Ultima Compra\] AS DATE\) = @date/.test(where),
    "janela: última compra no dia",
  );
  ok(
    /OR CAST\(s\.\[Data_Actualiz\] AS DATE\) = @date/.test(sql),
    "janela: Data_Actualiz quando a coluna existe",
  );
  ok(
    !/Data_Actualiz/.test(sqlSemMov),
    "…e não aparece quando a coluna não existe",
  );
  // Paginação por CodigoID: intocada. Perdê-la fazia o batch repetir-se.
  ok(/AND s\.CodigoID > @lastId/.test(where), "a paginação por CodigoID mantém-se");
  ok(/ORDER BY s\.CodigoID/.test(sql), "…e a ordem que a sustenta");
}

// ── 6. Sem StocksMov, volta ao filtro antigo ────────────────────────
console.log("\n=== sem StocksMov no ERP, degrada em vez de rebentar ===");
{
  // O pipeline de PRODUTOS tem de correr onde a tabela não existe. É o
  // de STOCK que a exige — e esse lança erro, de propósito.
  ok(!/StocksMov/.test(sqlSemMov), "a query não menciona StocksMov");
  ok(
    /WHERE s\.\[Processa_Stocks\] <> 0/.test(sqlSemMov),
    "Processa_Stocks continua obrigatório",
  );
  ok(
    denso(clausulaWhere(sqlSemMov)).includes(denso("s.[Retirado] = 0")),
    "e o filtro do activo volta a ser a única porta",
  );
}

// ── 7. Retirado viaja como metadado ─────────────────────────────────
console.log("\n=== recuperar não é reactivar ===");
{
  // O artigo entra MARCADO. O endpoint faz
  // `flagRetirado: asBoolOrFalse(raw.retirado)`, e todas as superfícies
  // operacionais filtram `flagRetirado = false`.
  ok(
    /s\.\[Retirado\]\s+AS retirado/.test(sql),
    "o SELECT leva o flag Retirado para o payload",
  );
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail === 0 ? 0 : 1);
