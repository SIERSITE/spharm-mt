/**
 * scripts/tests/test-vendas-stock-sempre-ativo.ts
 *
 * Ponto 5 — "Incluir stock sem vendas" nasce sempre ligado no Relatório
 * de Vendas. Teste ESTÁTICO (lê o código-fonte), no mesmo espírito de
 * `test-task-bar.ts`: confirma o DEFAULT no componente, sem montar React.
 *
 * A lógica em si (produtos vendas=0/stock>0 entram no universo quando
 * `apenasComStock=true`) já está coberta por `test-vendas-apenas-com-
 * stock.ts` contra `lib/vendas-data.ts` — este ficheiro só garante que o
 * VALOR INICIAL do toggle no ecrã é `true`, não `false`.
 */
import { readFileSync } from "node:fs";

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  [OK]    ${msg}`); }
  else { failed++; console.log(`  [FALHA] ${msg}`); }
}

const src = readFileSync(new URL("../../components/vendas/vendas-client.tsx", import.meta.url), "utf8");

console.log("\nA · valor inicial do toggle");
{
  // O valor inicial vem da fonte única `ESTADO_INICIAL_MOVIMENTO` (partilhada com a Manutenção em massa e com «Limpar filtros»).
  const m = src.match(/apenasComStock:\s*(true|false|ESTADO_INICIAL_MOVIMENTO\.apenasComStock)/);
  check(!!m, "A1: encontra o valor inicial de apenasComStock no estado inicial");
  const fonteUnica = readFileSync(new URL("../../lib/reporting/estado-inicial-movimento.ts", import.meta.url), "utf8");
  const nasceLigado = m?.[1] === "true" || (m?.[1] === "ESTADO_INICIAL_MOVIMENTO.apenasComStock" && /apenasComStock:\s*true/.test(fonteUnica));
  check(nasceLigado, "A2: nasce ligado (true) — nunca depende do utilizador o activar");
}

console.log("\nB · o toggle continua visível e ligado ao mesmo estado");
{
  check(src.includes('label="Incluir stock sem vendas"'), "B1: o checkbox «Incluir stock sem vendas» continua na UI (não foi removido)");
  check(/checked=\{apenasComStock\}/.test(src), "B2: o checkbox reflecte o mesmo estado apenasComStock (continua editável)");
}

console.log(`\n${passed} ok, ${failed} falhas`);
if (failed > 0) process.exit(1);
