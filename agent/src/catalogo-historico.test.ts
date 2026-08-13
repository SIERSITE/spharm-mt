/**
 * agent/src/catalogo-historico.test.ts
 *
 * O âmbito do catálogo no onboarding histórico.
 *
 * ── O defeito ─────────────────────────────────────────────────────
 *
 * `WHERE [Retirado] = 0 AND [Processa_Stocks] <> 0` é um filtro de
 * estado ACTUAL, e estava a ser aplicado a uma ingestão HISTÓRICA. Um
 * medicamento vendido em 2024 e retirado em 2026 nunca entrava no
 * catálogo: era excluído pelo que é hoje, não pelo que era quando foi
 * vendido. As vendas dele ficavam órfãs para sempre, e o mês em que
 * aconteceram ficava com `operationalOrphans > 0` — o que bloqueia a
 * agregação.
 *
 * Na Silveirense: 100 externalProductId órfãos, todos com ficha em
 * `dbo.Stocks`.
 *
 * ── A regra que NÃO se usa ────────────────────────────────────────
 *
 * "Existe em Stocks logo é produto" é falso neste ERP: os serviços
 * também lá têm ficha — CHECKSAUDE, vacinação, ***DIVERSOS***, serviço
 * de enfermagem. A existência da ficha não separa nada.
 *
 * O que separa é o COMPORTAMENTO. Um artigo que move stock deixa linhas
 * em `StocksMov`; um serviço normalmente não (é isso que
 * `Processa_Stocks=0` costuma significar na prática). Quem continuar
 * órfão depois desta recuperação é que é candidato a
 * `isNonStockService`.
 *
 * Uso: npx tsx agent/src/catalogo-historico.test.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { janela } from "./janela.js";

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

const raiz = path.join(import.meta.dirname, "..", "..");
const ler = (p: string) => readFileSync(path.join(raiz, p), "utf8");
const bootstrap = ler("agent/src/commands/bootstrap-upload.ts");
const fullSync = ler("agent/src/commands/full-sync.ts");
const dailyRunner = ler("agent/src/commands/daily-sync-runner.ts");

// Recorta a função dos produtos, para não confundir com o pipeline de
// stock que vive no mesmo ficheiro e mantém o filtro antigo.
const fnProdutos = bootstrap.slice(
  bootstrap.indexOf("export async function runProductsPipeline"),
  bootstrap.indexOf("export async function runStockPipeline"),
);

// ── 1. O âmbito histórico ─────────────────────────────────────────

console.log("=== o catálogo histórico inclui quem se mexeu na janela ===");
ok("aceita uma janela histórica", /janelaHistorica\?: \{ from: string; to: string \}/.test(fnProdutos));
ok("o predicado activo mantém-se", /const catalogoActivo = `s\.\[Retirado\] = 0 AND s\.\[Processa_Stocks\] <> 0`/.test(fnProdutos));
ok("com janela, é activo OU movimento", /\$\{catalogoActivo\} OR EXISTS \(/.test(fnProdutos));
ok("o movimento vem de StocksMov", /FROM \[dbo\]\.\[StocksMov\] sm/.test(fnProdutos));
ok("ligado pelo CodigoID", /WHERE sm\.CodigoID = s\.CodigoID/.test(fnProdutos));

console.log("");
console.log("=== a janela é meio-aberta, como todas as outras ===");
// Reutiliza `janela.ts` em vez de escrever outra aritmética. Uma segunda
// regra de datas acabaria por divergir da primeira.
ok("usa janela() para as fronteiras", /janela\(jh\.from, jh\.to\)\.inicio/.test(fnProdutos));
ok("e o fim exclusivo", /janela\(jh\.from, jh\.to\)\.fimExclusivo/.test(fnProdutos));
ok(">= from", /sm\.DataMov >= @histFrom/.test(fnProdutos));
ok("< to (exclusivo)", /sm\.DataMov <  @histTo/.test(fnProdutos));
// O último dia da janela entra inteiro — é o contrato de `janela()`.
const j = janela("2024-01-01", "2026-08-12");
eq("o fim é o dia seguinte", j.fimExclusivo, "2026-08-13 00:00:00");

// ── 2. Sem janela, nada muda ──────────────────────────────────────

console.log("");
console.log("=== sem janela, o comportamento é o de sempre ===");
// `daily-sync`, `products-upload` e `bootstrap-upload` não passam
// janela. Se o predicado sem janela deixasse de ser o filtro activo, o
// diário passava a trazer artigos retirados todos os dias.
ok(
  "sem janela o WHERE é só o catálogo activo",
  /: `\$\{catalogoActivo\}`/.test(fnProdutos),
);
ok("é uma expressão ternária sobre `jh`", /const whereAmbito = jh$/m.test(fnProdutos));

console.log("");
console.log("=== só o full-sync passa a janela ===");
ok("full-sync passa janelaHistorica", /janelaHistorica: \{ from, to \}/.test(fullSync));
eq(
  "e passa-a UMA vez",
  (fullSync.match(/janelaHistorica/g) ?? []).length,
  1,
);
// Os outros chamadores não podem tê-la ganho por acidente.
for (const [nome, fonte] of [
  ["products-upload", ler("agent/src/commands/products-upload.ts")],
  ["daily-sync-runner", dailyRunner],
]) {
  ok(`${nome} não passa janela histórica`, !/janelaHistorica/.test(fonte));
}

// ── 3. O daily e o stock snapshot ficam intactos ──────────────────

console.log("");
console.log("=== o diário e o snapshot de stock não foram tocados ===");
// O filtro activo continua palavra por palavra no daily-sync-runner: um
// artigo retirado não tem vendas nem stock novos para sincronizar.
eq(
  "daily-sync mantém o filtro em 3 queries",
  (dailyRunner.match(/WHERE s\.\[Retirado\] = 0/g) ?? []).length,
  3,
);
ok("daily-sync não conhece StocksMov no catálogo", !/EXISTS \(\s*\n?\s*SELECT 1 FROM \[dbo\]\.\[StocksMov\]/.test(dailyRunner));
// O pipeline de stock (mesmo ficheiro, outra função) mantém o filtro.
const fnStock = bootstrap.slice(bootstrap.indexOf("export async function runStockPipeline"));
ok(
  "runStockPipeline mantém o filtro activo",
  /WHERE s\.\[Retirado\] = 0\s*\n\s*AND s\.\[Processa_Stocks\] <> 0/.test(fnStock),
);
ok("runStockPipeline não usa a janela histórica", !/janelaHistorica|whereAmbito/.test(fnStock));

// ── 4. Os flags são metadados, não estado inventado ───────────────

console.log("");
console.log("=== retirado viaja como metadado ===");
// Um produto retirado entra no catálogo MARCADO como retirado. O
// endpoint faz `flagRetirado: asBoolOrFalse(raw.retirado)`, portanto
// recuperá-lo não o transforma em activo.
ok("o payload leva retirado", /retirado: boolOrNull\(r\.retirado\)|retirado:/.test(fnProdutos));
const rotaProdutos = ler("app/api/ingest/v1/bootstrap/products/route.ts");
ok(
  "o endpoint persiste em flagRetirado",
  /flagRetirado: asBoolOrFalse\(raw\.retirado\)/.test(rotaProdutos),
);

// ── 5. Proveniência: quantos foram recuperados ────────────────────

console.log("");
console.log("=== a corrida diz quantos recuperou ===");
// Sem esta contagem o operador vê "read=18416" e não sabe se a
// correcção fez alguma coisa. É também o número que responde a
// "quantos dos 100 órfãos foram recuperados".
ok("marca a proveniência no SELECT", /\$\{activoSelect\}\s+AS activoNoCatalogo/.test(fnProdutos));
ok("conta as duas origens", /recuperados\.activos\+\+|recuperados\.historicos\+\+/.test(fnProdutos));
ok("imprime o resumo", /Recuperados pela janela/.test(fnProdutos));
ok("só quando há janela", /if \(jh\) \{[\s\S]{0,200}Catalogo activo hoje/.test(fnProdutos));

// ── 6. A regra que não se usa ─────────────────────────────────────

console.log("");
console.log("=== a existência em Stocks não decide nada ===");
// Serviços também têm ficha. Se alguém voltar a usar "existe em Stocks"
// como critério de produto, os CHECKSAUDE entram no catálogo como
// medicamentos.
ok(
  "o comentário regista porquê",
  /Servicos tambem tem ficha em `dbo\.Stocks`/.test(fnProdutos),
);
ok(
  "e aponta para isNonStockService",
  /candidato a\s*\n?\s*\/\/ `isNonStockService`/.test(fnProdutos),
);
// A recuperação NÃO marca serviços — isso é do mecanismo existente.
ok("não classifica serviços aqui", !/isNonStockService\s*[:=]/.test(fnProdutos));

console.log("");
console.log(`${pass} ok, ${fail} falhas`);
process.exit(fail === 0 ? 0 : 1);
