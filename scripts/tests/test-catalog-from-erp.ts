/**
 * scripts/tests/test-catalog-from-erp.ts
 *
 * Fixa as regras de persistência do catálogo vindo do ERP da farmácia.
 *
 * A regra que mais interessa é a que não se vê a olho: NUNCA substituir
 * dados de confiança igual ou superior. Se isto regredir, uma ingestão
 * de rotina pode apagar DCI e ATC vindos do INFARMED e substituí-los por
 * valores do ERP — silenciosamente, em todo o catálogo.
 *
 * Uso: npx tsx scripts/tests/test-catalog-from-erp.ts
 */
import {
  decidirEscrita,
  decidirTipo,
  limpar,
  limparAtc,
  normalizarFabricante,
  ERP_CONFIDENCE,
  type Decisao,
} from "../../lib/ingest/catalog-from-erp";

let pass = 0;
let fail = 0;

function eq<T>(label: string, actual: T, expected: T) {
  if (Object.is(actual, expected)) {
    pass++;
    console.log(`  [OK]    ${label}`);
  } else {
    fail++;
    console.log(`  [FALHA] ${label}: obtido ${JSON.stringify(actual)}, esperado ${JSON.stringify(expected)}`);
  }
}

function decisao(label: string, novo: string | null, actual: string | null, forte: boolean, esperado: Decisao) {
  eq(label, decidirEscrita(novo, actual, forte), esperado);
}

console.log("=== regra 1: campo vazio preenche ===");
decisao("vazio + valor do ERP", "Paracetamol", null, false, "preencher");
decisao("vazio, mesmo com fonte forte noutro campo", "N02BE01", null, true, "preencher");

console.log("\n=== regra 3: fonte igual ou superior NUNCA é substituída ===");
decisao("DCI regulamentar não é tocada", "Paracetamol ERP", "Paracetamol INFARMED", true, "preservar");
decisao("ATC regulamentar não é tocado", "N02BE01", "N02BA01", true, "preservar");

console.log("\n=== regra 2: fonte inferior pode ser substituída ===");
decisao("valor inferido é substituído pelo ERP", "BAYER PORTUGAL", "BAYER", false, "substituir");

console.log("\n=== idempotência ===");
decisao("valor igual não reescreve", "Paracetamol", "Paracetamol", false, "nada");
decisao("valor igual não reescreve, com fonte forte", "Paracetamol", "Paracetamol", true, "nada");
decisao("ERP sem valor não faz nada", null, "Paracetamol", false, "nada");
decisao("ERP sem valor não apaga o existente", null, "Paracetamol", true, "nada");

console.log("\n=== productType: nunca despromover ===");
// Aqui a confiança do valor existente é legível directamente em
// Produto.productTypeConfidence, por isso a regra é aritmética e sem
// excepções. Uma classificação por consenso de marca (0.75) não pode
// substituir uma por flag MSRM (0.99), por mais recente que seja.
const tipo = (l: string, nt: string, nc: number, at: string | null, ac: number | null, esp: Decisao) =>
  eq(l, decidirTipo(nt, nc, at, ac), esp);

tipo("vazio preenche", "MEDICAMENTO", 0.99, null, null, "preencher");
tipo("flag MSRM vence consenso de marca", "MEDICAMENTO", 0.99, "DERMOCOSMETICA", 0.75, "substituir");
tipo("consenso NAO substitui flag MSRM", "DERMOCOSMETICA", 0.75, "MEDICAMENTO", 0.99, "preservar");
tipo("confianca igual nao substitui", "DERMOCOSMETICA", 0.9, "MEDICAMENTO", 0.9, "preservar");
tipo("mesmo tipo, mais confianca, nao reescreve", "MEDICAMENTO", 0.99, "MEDICAMENTO", 0.75, "nada");
tipo("mesmo tipo, menos confianca, nao mexe", "MEDICAMENTO", 0.75, "MEDICAMENTO", 0.99, "nada");
tipo("OUTRO nunca e escrito", "OUTRO", 0.3, null, null, "nada");
tipo("OUTRO nao apaga classificacao existente", "OUTRO", 0.3, "MEDICAMENTO", 0.99, "nada");
tipo("confianca actual nula conta como zero", "SUPLEMENTO", 0.72, "OUTRO", null, "substituir");

console.log("\n=== ATC: só o que é mesmo um ATC entra ===");
eq("ATC nível 5", limparAtc("N02BE01"), "N02BE01");
eq("ATC minúsculas", limparAtc("n02be01"), "N02BE01");
eq("ATC com espaços", limparAtc(" N02 BE01 "), "N02BE01");
eq("ATC nível 1", limparAtc("N"), null);
eq("ATC nível 2", limparAtc("N02"), "N02");
eq("ATC nível 3", limparAtc("N02B"), "N02B");
eq("ATC nível 4", limparAtc("N02BE"), "N02BE");
eq("código interno do ERP não é ATC", limparAtc("17"), null);
eq("texto livre não é ATC", limparAtc("Analgesico"), null);
eq("ATC inválido é rejeitado", limparAtc("NN02BE01"), null);

console.log("\n=== marcadores de vazio do ERP ===");
eq("N/A", limpar("N/A"), null);
eq("n/a", limpar("n/a"), null);
eq("traço", limpar("---"), null);
eq("zero", limpar("0"), null);
eq("espaços", limpar("   "), null);
eq("não definido", limpar("Não definido"), null);
eq("valor real passa", limpar("  Ibuprofeno "), "Ibuprofeno");

console.log("\n=== normalização de fabricante ===");
eq("acentos e caixa", normalizarFabricante("Laboratórios Vitória"), "LABORATORIOS VITORIA");
eq("espaços a mais", normalizarFabricante("BAYER   PORTUGAL"), "BAYER PORTUGAL");
eq("uma letra é rejeitada", normalizarFabricante("X"), null);
eq("vazio é rejeitado", normalizarFabricante("   "), null);
eq("nome longo demais é rejeitado", normalizarFabricante("A".repeat(61)), null);

console.log("\n=== confiança do ERP fica entre inferência e regulamentar ===");
eq("acima de consenso de marca (0.75)", ERP_CONFIDENCE > 0.75, true);
eq("acima de retalho (0.80)", ERP_CONFIDENCE > 0.8, true);
eq("abaixo de RegulatoryRecord (0.96)", ERP_CONFIDENCE < 0.96, true);
eq("abaixo de flag MSRM (0.99)", ERP_CONFIDENCE < 0.99, true);

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail === 0 ? 0 : 1);
