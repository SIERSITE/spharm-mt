/**
 * agent/src/qualificacao.test.ts
 *
 * Fixa a qualificação de nomes de tabela na sonda da venda suspensa.
 *
 * ── O DEFEITO QUE ISTO IMPEDE DE VOLTAR ──────────────────────────────
 *
 * A rev64 correu no ERP da farmácia e a §2 rebentou com:
 *
 *     Invalid object name 'dbo.dbo.Atendimento Susp'
 *
 * A causa: `listForeignKeysOut` devolve `toTable` JÁ qualificado
 * (`dbo.Atendimento Susp`), e o `full()` da sonda voltava a prefixar
 * `dbo.`, produzindo `[dbo].[dbo.Atendimento Susp]`. Uma função pura,
 * duas linhas, e custou uma ida ao PC da farmácia e uma ronda inteira —
 * porque só se vê contra um ERP real.
 *
 * É exactamente o tipo de coisa que um teste apanha em milissegundos, e
 * é por isso que estas duas funções estão exportadas.
 *
 * Uso: npx tsx agent/src/qualificacao.test.ts
 */
import { full, separar } from "./commands/vendas-susp-cadeia.js";

let pass = 0;
let fail = 0;
const eq = (label: string, obtido: unknown, esperado: unknown) => {
  if (obtido === esperado) {
    pass++;
    console.log(`  [OK]    ${label} (${String(obtido)})`);
  } else {
    fail++;
    console.log(`  [FALHA] ${label}: obtido "${String(obtido)}", esperado "${String(esperado)}"`);
  }
};

console.log("=== nome simples: assume dbo ===");
eq("tabela sem espacos", full("Atendimento"), "[dbo].[Atendimento]");
eq("tabela com espacos", full("Atendimento Susp"), "[dbo].[Atendimento Susp]");
eq("tabela com underscores", full("Atendimento_SuspFT_NC_Susp"), "[dbo].[Atendimento_SuspFT_NC_Susp]");

console.log("\n=== nome ja qualificado: NAO volta a prefixar ===");
// A regressão exacta da rev64.
eq("dbo.Atendimento Susp", full("dbo.Atendimento Susp"), "[dbo].[Atendimento Susp]");
eq("dbo.Atendimento Susp Detalhe", full("dbo.Atendimento Susp Detalhe"), "[dbo].[Atendimento Susp Detalhe]");
eq("outro schema preservado", full("vendas.Atendimento"), "[vendas].[Atendimento]");

console.log("\n=== idempotencia: qualificar duas vezes da o mesmo ===");
const uma = separar("dbo.Atendimento Susp");
const duas = separar(`${uma.schema}.${uma.table}`);
eq("schema estavel", duas.schema, "dbo");
eq("tabela estavel", duas.table, "Atendimento Susp");

console.log("\n=== o ponto so e separador se o prefixo for identificador ===");
// Um nome que comece por ponto, ou cujo prefixo tenha espaço, não é
// `schema.tabela` — é um nome esquisito e fica inteiro.
eq("prefixo com espaco fica inteiro", separar("meu schema.tabela").table, "meu schema.tabela");
eq("prefixo com espaco assume dbo", separar("meu schema.tabela").schema, "dbo");
eq("ponto inicial fica inteiro", separar(".oculto").table, ".oculto");
eq("prefixo numerico fica inteiro", separar("2024.dados").table, "2024.dados");

console.log("\n=== identificadores inseguros continuam a ser recusados ===");
let atirou = false;
try {
  full("Atendimento] DROP TABLE x --");
} catch {
  atirou = true;
}
eq("bracket no nome atira", atirou, true);

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail === 0 ? 0 : 1);
