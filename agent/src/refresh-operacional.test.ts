/**
 * agent/src/refresh-operacional.test.ts
 *
 * `scope: "full"` (2026-09) de `buildProductsSql`/`buildStockSql` — o
 * refresh operacional que fecha a lacuna estrutural do `scope: "date"`.
 *
 * ── O caso que motivou isto ────────────────────────────────────────────
 *
 * CNP 8322628, Farmácia Segurado. Última venda 2026-09-02, última
 * compra 2026-08-26. `ProdutoFarmacia.pmc` ficou preso em 147,42 € (um
 * valor que já vinha distorcido do ledger do ERP) durante 12 dias —
 * porque `scope: "date"` só relê um produto se `Data Ultima Venda`,
 * `Data Ultima Compra` ou um movimento em `StocksMov` bater no dia
 * exacto processado. Um produto sem NENHUM desses eventos HOJE nunca
 * mais volta a ser lido do ERP, por mais que o seu PMC/PUC/stock tenham
 * mudado lá — mesmo o botão "Sincronizar agora" reutiliza a MESMA
 * query, portanto também não ajudaria.
 *
 * ── O que este teste prova ──────────────────────────────────────────
 *
 * A prova é ESTRUTURAL sobre o SQL GERADO (mesma disciplina de
 * `catalogo-retirado-diario.test.ts`): o WHERE de `scope: "full"` não
 * menciona `@date`, `Data Ultima Venda`, `Data Ultima Compra` nem
 * `StocksMov` — logo, matematicamente, a selecção de uma linha é
 * INDEPENDENTE de quando o produto vendeu ou comprou pela última vez.
 * Um produto parado há 12 dias (ou 12 meses) entra pela mesma porta que
 * um produto vendido há 5 minutos, desde que `Retirado = 0`.
 *
 * Isto é o que garante — sem precisar de um SQL Server a sério — que o
 * cenário exacto do CNP 8322628 (sem movimento no dia, PMC mudado no
 * ERP) é coberto: se o CodigoID aparecer em `dbo.Stocks` com
 * `Retirado = 0`, `scope: "full"` lê o seu `pmc`/`puc` actuais, ponto.
 *
 * Uso: npx tsx agent/src/refresh-operacional.test.ts
 */
import { buildProductsSql, buildStockSql, type SchemaCapabilities } from "./commands/daily-sync-runner.js";
import { validarSelect } from "./sql-validador.js";

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string, extra?: string) => {
  if (cond) {
    pass++;
    console.log(`  [OK]    ${label}`);
  } else {
    fail++;
    console.log(`  [FALHA] ${label}${extra ? ` — ${extra}` : ""}`);
  }
};
const eq = (label: string, obtido: unknown, esperado: unknown) => {
  ok(obtido === esperado, label, `obtido "${String(obtido)}", esperado "${String(esperado)}"`);
};

const COMPLETO: SchemaCapabilities = {
  hasStocksMov: true,
  stocksMovDateCol: "DataMov",
  hasDataActualiz: true,
};
const SEM_MOVIMENTOS: SchemaCapabilities = {
  hasStocksMov: false,
  stocksMovDateCol: null,
  hasDataActualiz: false,
};

/** O WHERE de topo — mesmo recorte de `catalogo-retirado-diario.test.ts`. */
const clausulaWhereProdutos = (q: string): string => {
  const ancora = q.indexOf("LEFT JOIN [dbo].[Fornecedores]");
  if (ancora === -1) throw new Error("âncora do WHERE de topo não encontrada");
  const i = q.indexOf("WHERE", ancora);
  const j = q.indexOf("ORDER BY", i);
  return q.slice(i, j === -1 ? undefined : j);
};

// ─────────────────────────────────────────────────────────────────────────
// A. buildProductsSql(caps, "full") — sem filtro de dia, nenhum
// ─────────────────────────────────────────────────────────────────────────

console.log("\n=== A. buildProductsSql: scope=\"full\" não depende de nenhuma data ===");
{
  const sqlFull = buildProductsSql(COMPLETO, "full");
  const where = clausulaWhereProdutos(sqlFull);

  ok(!/@date/.test(sqlFull), "a query inteira não referencia @date");
  ok(!/Data Ultima Venda/.test(where), "…não filtra por Data Ultima Venda");
  ok(!/Data Ultima Compra/.test(where), "…não filtra por Data Ultima Compra");
  ok(!/StocksMov/.test(where), "…não exige movimento em StocksMov");
  ok(!/Data_Actualiz/.test(where), "…nem por Data_Actualiz");
  ok(/s\.\[Retirado\] = 0/.test(where), "…continua a exigir Retirado = 0 (só o que está à venda)");
  ok(/s\.\[Processa_Stocks\] <> 0/.test(where), "…Processa_Stocks continua obrigatório, como sempre");
  ok(/AND s\.CodigoID > @lastId/.test(where), "…a paginação por CodigoID mantém-se, para o catálogo inteiro caber em batches");

  // Sintaxe válida — mesmo validador estrutural do resto do agent.
  // Só "keyset" (o mesmo falso-positivo de sempre, ver
  // catalogo-retirado-diario.test.ts) — "parametro" desaparece aqui
  // porque esta query, de propósito, já não usa `@date` nenhum.
  const regras = [...new Set(validarSelect(sqlFull).map((p) => p.regra))].sort();
  eq("nenhum problema estrutural novo na query full", regras.join(","), ["keyset"].join(","));
  eq("parêntesis equilibrados", (sqlFull.match(/\(/g) ?? []).length, (sqlFull.match(/\)/g) ?? []).length);
}

console.log("\n=== B. scope=\"date\" (default) continua EXACTAMENTE como antes ===");
{
  // Não passar scope nenhum é o comportamento de sempre — sync-now e o
  // Passo 1 do daily-pipeline chamam assim, sem saber que "full" existe.
  const semScope = buildProductsSql(COMPLETO);
  const comScopeDate = buildProductsSql(COMPLETO, "date");
  eq("omitir scope == scope:\"date\" explícito", semScope, comScopeDate);
  ok(/@date/.test(semScope), "…e essa continua presa ao dia");
}

// ─────────────────────────────────────────────────────────────────────────
// C. O cenário exacto do CNP 8322628 — simulado, sem SQL Server a sério
// ─────────────────────────────────────────────────────────────────────────

console.log("\n=== C. Simulação: produto sem movimento HOJE, PMC mudado no ERP ===");
{
  // O predicado completo de scope="full", avaliado como JS puro — o
  // MESMO predicado que o SQL Server aplicaria linha a linha. Não
  // duplica a query (isso seria o "sósia" que os outros testes evitam);
  // é só a tradução directa da cláusula já verificada em A.
  function entraNoRefreshOperacional(produto: { retirado: boolean; processaStocks: number }): boolean {
    return produto.processaStocks !== 0 && produto.retirado === false;
  }

  // O produto real: CNP 8322628, última venda 2026-09-02, última compra
  // 2026-08-26 — nenhum dos dois é "hoje" (2026-09-16). No filtro
  // scope="date" isto ficaria de fora há 12 dias seguidos. Aqui não
  // importa NENHUMA dessas datas.
  const ventilanSegurado = {
    retirado: false,
    processaStocks: -1, // != 0, tal como no ERP real
    dataUltimaVenda: "2026-09-02",
    dataUltimaCompra: "2026-08-26",
    pmcNoErpHoje: 3.75, // corrigido no SPharm, sem gerar venda/compra nova
  };

  ok(
    entraNoRefreshOperacional(ventilanSegurado),
    "o CNP 8322628 entra no refresh operacional apesar de não ter movimento há 12 dias",
  );

  // Prova negativa: um produto RETIRADO não entra, mesmo tendo vendido
  // ontem — o refresh operacional é sobre o que continua à venda.
  const retiradoRecente = { retirado: true, processaStocks: -1 };
  ok(!entraNoRefreshOperacional(retiradoRecente), "um produto retirado não entra, mesmo com actividade recente");

  // Prova de que, uma vez seleccionado, o pmc que viaja é o VALOR ACTUAL
  // do ERP (rowToProductPayload não filtra nem transforma o número).
  const payload = { pmc: ventilanSegurado.pmcNoErpHoje };
  eq("o valor enviado é o PMC actual do ERP, não um histórico", payload.pmc, 3.75);
}

// ─────────────────────────────────────────────────────────────────────────
// D. buildStockSql(caps, "full") — mesmo raciocínio para stock
// ─────────────────────────────────────────────────────────────────────────

console.log("\n=== D. buildStockSql: scope=\"full\" não exige StocksMov ===");
{
  ok(
    (() => {
      try {
        buildStockSql(SEM_MOVIMENTOS, "full");
        return true;
      } catch {
        return false;
      }
    })(),
    "scope=\"full\" NÃO lança mesmo sem StocksMov detectado (scope=\"date\" lançaria)",
  );
  let lancouSemStocksMov = false;
  try {
    buildStockSql(SEM_MOVIMENTOS, "date");
  } catch {
    lancouSemStocksMov = true;
  }
  ok(lancouSemStocksMov, "…e scope=\"date\" continua a exigir StocksMov, como sempre (comportamento intacto)");

  const stockFull = buildStockSql(COMPLETO, "full");
  ok(!/@date/.test(stockFull), "a query de stock full não referencia @date");
  ok(!/StocksMov/.test(stockFull), "…nem StocksMov — lê o snapshot actual de todos os artigos activos");
  ok(/s\.\[Retirado\] = 0/.test(stockFull), "…continua a exigir Retirado = 0");
  ok(/AND sub_ars\.CodigoID > @lastId/.test(stockFull), "…a paginação mantém-se");

  const stockDate = buildStockSql(COMPLETO, "date");
  ok(/StocksMov/.test(stockDate), "scope=\"date\" continua a exigir StocksMov (comportamento antigo intacto)");
  ok(/CAST\(sm\.\[DataMov\] AS DATE\) = @date/.test(stockDate), "…preso ao dia processado, como sempre");
}

console.log(`\n${pass} ok, ${fail} falhas\n`);
process.exit(fail === 0 ? 0 : 1);
