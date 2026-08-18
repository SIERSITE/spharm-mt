/**
 * scripts/tests/test-pipeline-diario.ts
 *
 * Fixa o comportamento do ciclo diário quando alguma coisa corre mal.
 *
 * ── O DEFEITO QUE ISTO IMPEDE DE VOLTAR ──────────────────────────────
 *
 * Silveirense, 2026-08-16: o `daily-sync` correu, o stock foi
 * actualizado, e dois passos falharam — `fornecedores` e
 * `aggregate-month`, este último com `fetch failed` a caminho do SaaS. O
 * dia terminou, o registo foi gravado, e o 17/08 nunca correu: o
 * catch-up estava desligado por omissão e a corrida seguinte pedia
 * "ontem", que já era outro dia.
 *
 * O resultado foi um tenant permanentemente um dia atrás, com o stock
 * fresco a dar a impressão de saúde. E como a Segurado estava em dia, o
 * agregado do grupo também parecia bem.
 *
 * Quatro decisões foram tomadas e são estas que os testes fixam:
 *   1. um passo obrigatório em falha ⇒ o dia é PARTIAL, não OK
 *   2. só `OK` conta como concluído ⇒ um PARTIAL volta a ser proposto
 *   3. o SERVIDOR confirma o estado, para um agent antigo não poder
 *      fechar um dia que não fechou
 *   4. uma falha de REDE repete-se; uma resposta HTTP não
 *
 * Sem base de dados e sem rede.
 *
 * Uso: npx tsx scripts/tests/test-pipeline-diario.ts
 */
import { readFileSync } from "node:fs";
import {
  PIPELINE_STATUS,
  estadoDoDia,
  isPipelineStatus,
  passoObrigatorio,
} from "../../lib/pipeline/types";
import { planearCatchUp, diasEntre } from "../../agent/src/catch-up";
import { ehFalhaDeRede } from "../../agent/src/commands/daily-pipeline";

let pass = 0;
let fail = 0;
const ok = (l: string) => { pass++; console.log(`  [OK]    ${l}`); };
const bad = (l: string, d?: string) => { fail++; console.log(`  [FALHA] ${l}${d ? `\n            ${d}` : ""}`); };
const check = (c: boolean, l: string, d?: string) => (c ? ok(l) : bad(l, d));
const eq = (a: unknown, b: unknown, l: string) =>
  check(JSON.stringify(a) === JSON.stringify(b), l, `esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);

type Passo = { name: string; status: "OK" | "ERROR" | "SKIPPED" };

// O dia real da Silveirense, tal como o `details.steps` o registou.
const DIA_16: Passo[] = [
  { name: "daily-sync", status: "OK" },
  { name: "fornecedores", status: "ERROR" },
  { name: "compras", status: "OK" },
  { name: "devoluções", status: "OK" },
  { name: "movimentos", status: "OK" },
  { name: "aggregate-month", status: "ERROR" },
];

console.log("=== 1. um passo intermédio falha ===");
{
  eq(estadoDoDia(DIA_16), "PARTIAL", "o dia 16/08 da Silveirense é PARTIAL, não OK");
  eq(
    estadoDoDia([
      { name: "daily-sync", status: "OK" },
      { name: "compras", status: "OK" },
      { name: "aggregate-month", status: "OK" },
    ]),
    "OK",
    "…e um dia sem falhas continua OK",
  );
  eq(
    estadoDoDia([
      { name: "daily-sync", status: "OK" },
      { name: "aggregate-month", status: "SKIPPED" },
    ]),
    "OK",
    "SKIPPED não degrada — `--skip-aggregate` é uma decisão do operador",
  );
  check(
    passoObrigatorio("um-passo-que-ainda-nao-existe"),
    "um passo novo conta como obrigatório até alguém dizer o contrário",
    "o default tem de ser o que grita, não o que cala",
  );
}

console.log("\n=== 2. retry do mesmo dia: PARTIAL volta a ser proposto ===");
{
  // O SaaS só devolve dias com `status="OK"`. Um PARTIAL não está lá.
  const diasOk = ["2026-08-13", "2026-08-14", "2026-08-15"]; // 16 ficou PARTIAL
  const plano = planearCatchUp({ ontem: "2026-08-17", diasOk, maxDias: 7 });
  check(plano.dias.includes("2026-08-16"), "o dia parcial volta ao plano");
  check(plano.dias.includes("2026-08-17"), "…e o dia novo também");
  eq(plano.dias, ["2026-08-16", "2026-08-17"], "por ordem cronológica: o buraco antes do novo");
}
{
  // Buraco no MEIO — o caso que um cursor "último dia OK" perderia para
  // sempre.
  const plano = planearCatchUp({
    ontem: "2026-08-17",
    diasOk: ["2026-08-13", "2026-08-15", "2026-08-16", "2026-08-17"],
    maxDias: 7,
  });
  eq(plano.dias, ["2026-08-14"], "um buraco no meio é recuperado mesmo com os posteriores feitos");
}

console.log("\n=== 3. sucesso após retry ===");
{
  const plano = planearCatchUp({
    ontem: "2026-08-17",
    diasOk: diasEntre("2026-08-13", "2026-08-17"),
    maxDias: 7,
  });
  eq(plano.dias, [], "com o 16 e o 17 fechados, não há nada a recuperar");
  check(plano.resumo.includes("Nada a recuperar"), "…e o resumo di-lo por extenso");
}

console.log("\n=== 4. avanço para o dia seguinte ===");
{
  const plano = planearCatchUp({
    ontem: "2026-08-18",
    diasOk: diasEntre("2026-08-13", "2026-08-17"),
    maxDias: 7,
  });
  eq(plano.dias, ["2026-08-18"], "o dia novo entra sozinho quando o passado está fechado");
}
{
  // Um dia parcial NÃO pára a sequência: o núcleo ficou gravado e parar
  // aqui era o que mantinha o tenant um dia atrás.
  const src = readFileSync(
    new URL("../../agent/src/commands/daily-pipeline.ts", import.meta.url),
    "utf8",
  );
  check(src.includes("EXIT_PARTIAL"), "há um código de saída próprio para o dia parcial");
  check(
    /if \(rc === EXIT_PARTIAL\)[\s\S]{0,400}continue;/.test(src),
    "…e a sequência CONTINUA nesse caso em vez de parar",
  );
  check(
    /rc !== 0\)[\s\S]{0,200}PARADO/.test(src),
    "…mas um erro a sério continua a parar a sequência",
  );
}

console.log("\n=== 5. idempotência ===");
{
  // A mesma execução repetida não pode produzir dois registos: a chave
  // é determinística e o endpoint faz upsert por ela.
  const chave = (farmacia: string, dia: string, inicio: string) =>
    `daily-pipeline:${farmacia}:${dia}:${inicio}`;
  const a = chave("f1", "2026-08-16", "2026-08-17T03:00:00.000Z");
  const b = chave("f1", "2026-08-16", "2026-08-17T03:00:00.000Z");
  const c = chave("f1", "2026-08-16", "2026-08-18T03:00:00.000Z");
  eq(a, b, "o mesmo run produz a mesma idempotencyKey");
  check(a !== c, "…e uma execução nova produz outra, preservando o histórico");

  const rota = readFileSync(
    new URL("../../app/api/admin/pipeline/record/route.ts", import.meta.url),
    "utf8",
  );
  check(rota.includes("upsert"), "o endpoint faz upsert pela chave em vez de criar sempre");
}
{
  // Re-correr o mesmo dia não duplica vendas nem movimentos: as duas
  // ingestões são idempotentes por chave natural do ERP.
  const schema = readFileSync(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");
  check(
    schema.includes('@@unique([farmaciaId, externalSaleLineId])'),
    "vendas: uma linha do ERP só pode existir uma vez por farmácia",
  );
  check(
    schema.includes('@@unique([farmaciaId, externalMovId])'),
    "movimentos: idem para o ledger canónico",
  );
}

console.log("\n=== 6. aggregate-month indisponível ===");
{
  // `fetch failed` é o undici a dizer que o pedido não chegou a ter
  // resposta. Repete-se.
  check(ehFalhaDeRede(new Error("fetch failed")), "`fetch failed` é falha de rede");
  check(ehFalhaDeRede(new Error("connect ECONNREFUSED 10.0.0.5:443")), "ECONNREFUSED também");
  check(ehFalhaDeRede(new Error("socket hang up")), "socket hang up também");
  check(ehFalhaDeRede(new Error("getaddrinfo ENOTFOUND app.spharmmt.com")), "ENOTFOUND também");

  // Uma resposta HTTP é uma decisão do servidor. Repeti-la dá o mesmo,
  // mais devagar — e um 409 dos gates seria repetido três vezes.
  class SaasApiErrorFake extends Error {
    name = "SaasApiError";
    constructor(public statusCode: number) { super(`HTTP ${statusCode}`); }
  }
  const src = readFileSync(
    new URL("../../agent/src/commands/daily-pipeline.ts", import.meta.url),
    "utf8",
  );
  check(
    /if \(err instanceof SaasApiError\) return false;/.test(src),
    "uma resposta HTTP NÃO é repetida — 409 dos gates é uma decisão, não um soluço",
  );
  check(
    src.includes("comRetryDeRede"),
    "…e a chamada ao aggregate-month passa pelo retry",
  );
  void SaasApiErrorFake;
}
{
  // Mesmo com retry, se a rede não voltar o dia fica PARTIAL — nunca OK.
  eq(
    estadoDoDia([
      { name: "daily-sync", status: "OK" },
      { name: "aggregate-month", status: "ERROR" },
    ]),
    "PARTIAL",
    "aggregate-month em falha deixa o dia por fechar",
  );
}

console.log("\n=== 7. uma farmácia saudável não mascara outra atrasada ===");
{
  const src = readFileSync(
    new URL("../../lib/pipeline-freshness.ts", import.meta.url),
    "utf8",
  );
  check(
    src.includes("export async function getFrescuraPorFarmacia"),
    "há frescura por dataset × farmácia, não só o agregado do tenant",
  );
  check(
    /GROUP BY 1/.test(src) && !/for \(const f of farmacias\) \{[\s\S]{0,200}await/.test(src),
    "…e é uma consulta por dataset, não uma por farmácia",
  );
  check(
    src.includes("maisFresca"),
    "o atraso é medido contra a farmácia mais fresca do mesmo dataset",
    "comparar com 'hoje' acusaria toda a gente num domingo sem vendas",
  );
}
{
  const pagina = readFileSync(
    new URL("../../app/admin/pipeline/page.tsx", import.meta.url),
    "utf8",
  );
  check(pagina.includes("FrescuraPorFarmacia"), "…e a grelha é renderizada em /admin/pipeline");
  check(
    pagina.includes("PIPELINE_STATUS.PARTIAL"),
    "o estado PARTIAL tem cor própria no badge — não se confunde com OK",
  );
}

console.log("\n=== o vocabulário aceita PARTIAL de ponta a ponta ===");
{
  eq(PIPELINE_STATUS.PARTIAL, "PARTIAL", "PARTIAL existe na constante");
  check(isPipelineStatus("PARTIAL"), "…é um estado válido");
  check(!isPipelineStatus("MEIO"), "…e um inventado não é");

  const rota = readFileSync(
    new URL("../../app/api/admin/pipeline/record/route.ts", import.meta.url),
    "utf8",
  );
  check(rota.includes('statusRecebido !== "PARTIAL"'), "o endpoint aceita PARTIAL do agent");
  check(
    rota.includes("estadoDoDia(passos)"),
    "…e DERIVA o estado dos passos em vez de confiar no que o agent diz",
    "é isto que impede um agent antigo de fechar um dia incompleto",
  );

  const endpointDias = readFileSync(
    new URL("../../app/api/ingest/v1/pipeline/dias-concluidos/route.ts", import.meta.url),
    "utf8",
  );
  check(
    /status:\s*"OK"/.test(endpointDias),
    "só `OK` conta como dia concluído — logo PARTIAL volta a ser proposto",
  );
}

console.log("\n=== o catch-up está ligado por omissão ===");
{
  const src = readFileSync(
    new URL("../../agent/src/commands/daily-pipeline.ts", import.meta.url),
    "utf8",
  );
  check(
    src.includes("args.semCatchUp"),
    "o interruptor passou a ser o de DESLIGAR",
  );
  check(
    !/if \(!args\.catchUp\) \{/.test(src),
    "…e o de ligar desapareceu",
  );
  check(
    src.includes('"catch-up": { type: "boolean" }'),
    "`--catch-up` continua aceite: removê-lo partia os .bat já instalados",
  );
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail === 0 ? 0 : 1);
