/**
 * scripts/tests/test-namespaces-acordo.ts
 *
 * O agent decide o `sourceNamespace` de cada linha; o SaaS decide se o
 * aceita e que `naturezaVenda` lhe dá. São duas listas, em dois
 * repositórios de código que se deployam separadamente, e têm de dizer
 * o mesmo.
 *
 * ── O QUE MUDOU, E PORQUE ISTO PASSOU A SER PRECISO ──────────────────
 *
 * Até à rev85 o endpoint fazia fallback silencioso: um namespace que não
 * conhecesse era gravado como `ATENDIMENTO_DETALHE`. Uma divergência
 * entre as duas listas não dava erro — dava vendas a crédito contadas
 * como venda de balcão, com o total plausível e errado.
 *
 * Agora a linha é rejeitada e aparece em `errors[]`, o que torna a
 * divergência visível — mas visível já em produção, no meio de um sync.
 * Este teste apanha-a antes, no build.
 *
 * O SaaS é lido por texto e não importado: o ficheiro é uma rota Next
 * com wrapper de autenticação, e importá-la arrastava metade do
 * runtime. As duas constantes são literais e é isso que se lê.
 *
 * Corre com:  npm run test:namespaces-acordo
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  NAMESPACES,
  NATUREZA_POR_NAMESPACE,
  type SourceNamespace,
} from "../../agent/src/vendas-fontes";

const ROTA = path.join(
  process.cwd(),
  "app/api/ingest/v1/bootstrap/sales-lines/route.ts",
);

let ok = 0;
let ko = 0;
const v = (cond: boolean, label: string, extra = "") => {
  if (cond) {
    ok++;
    console.log(`  [OK]    ${label}`);
  } else {
    ko++;
    console.log(`  [FALHA] ${label}${extra ? `  — ${extra}` : ""}`);
  }
};

const fonte = readFileSync(ROTA, "utf8");

/** Extrai os literais de um `new Set([...])` ou de um objecto. */
function listaDoSet(nome: string): string[] {
  const m = new RegExp(`const ${nome} = new Set\\(\\[([\\s\\S]*?)\\]\\)`).exec(fonte);
  if (!m) return [];
  return [...m[1].matchAll(/"([A-Z_]+)"/g)].map((x) => x[1]);
}

function mapaDoObjecto(nome: string): Record<string, string> {
  const m = new RegExp(`const ${nome}: Record<string, string> = \\{([\\s\\S]*?)\\n\\};`).exec(fonte);
  if (!m) return {};
  const r: Record<string, string> = {};
  for (const [, k, val] of m[1].matchAll(/([A-Z_]+):\s*"([A-Z]+)"/g)) r[k] = val;
  return r;
}

console.log("\n=== 1. as duas listas de namespaces coincidem ===");
const doAgent = Object.values(NAMESPACES).sort();
const doSaas = listaDoSet("NAMESPACES_VALIDOS").sort();
v(doSaas.length > 0, "a lista do SaaS foi encontrada no ficheiro da rota");
v(
  JSON.stringify(doAgent) === JSON.stringify(doSaas),
  "agent e SaaS declaram exactamente os mesmos namespaces",
  `agent=${doAgent.join(",")} | saas=${doSaas.join(",")}`,
);

console.log("\n=== 2. a natureza é a mesma dos dois lados ===");
const natSaas = mapaDoObjecto("NATUREZA_POR_NAMESPACE");
v(Object.keys(natSaas).length > 0, "o mapa de naturezas do SaaS foi encontrado");
for (const ns of doAgent) {
  const doLadoAgent = NATUREZA_POR_NAMESPACE[ns as SourceNamespace];
  v(
    natSaas[ns] === doLadoAgent,
    `${ns}: ${doLadoAgent} dos dois lados`,
    `saas=${natSaas[ns] ?? "(ausente)"} agent=${doLadoAgent}`,
  );
}

console.log("\n=== 3. o crédito do balcão está declarado e é CREDITO ===");
v(
  doSaas.includes("ATENDIMENTO_DETALHE_CREDITO"),
  "o SaaS aceita ATENDIMENTO_DETALHE_CREDITO",
);
v(
  natSaas.ATENDIMENTO_DETALHE_CREDITO === "CREDITO",
  "…e mapeia-o para CREDITO",
  natSaas.ATENDIMENTO_DETALHE_CREDITO ?? "(ausente)",
);
v(
  NATUREZA_POR_NAMESPACE[NAMESPACES.ATENDIMENTO_DETALHE_CREDITO] === "CREDITO",
  "o agent também",
);

console.log("\n=== 4. não há fallback silencioso ===");
// O padrão antigo era um ternário que devolvia "ATENDIMENTO_DETALHE"
// quando o valor não estava na lista. Se voltar, esta verificação
// falha — e falha antes de chegar a produção.
v(
  /unknown_source_namespace/.test(fonte),
  "um namespace desconhecido é reportado em errors[]",
);
v(
  !/NAMESPACES_VALIDOS\.has\([^)]*\)\s*\?[\s\S]{0,120}:\s*"ATENDIMENTO_DETALHE"/.test(fonte),
  "o ternário de fallback silencioso desapareceu",
);
// Ausente continua a valer o default — é o que um payload anterior a
// esta dimensão produz, e é o default da própria coluna.
v(
  /nsRecebido \?\? "ATENDIMENTO_DETALHE"/.test(fonte),
  "o campo AUSENTE mantém o default de compatibilidade",
);
// A rejeição é por linha: um `continue`, não um return que abortasse o
// lote inteiro por causa de uma linha.
v(
  /reason: "unknown_source_namespace"[\s\S]{0,200}?continue;/.test(fonte),
  "a rejeição é por linha, e o lote continua",
);

console.log(`\nRESULTADO: ${ok} ok, ${ko} falhas`);
process.exit(ko === 0 ? 0 : 1);
