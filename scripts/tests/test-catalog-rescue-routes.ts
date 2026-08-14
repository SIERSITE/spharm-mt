/**
 * scripts/tests/test-catalog-rescue-routes.ts
 *
 * Fixa a revisão de classificação de Agosto de 2026: rotas de
 * salvamento, fronteira sensível a acentos, precedência entre dosagem e
 * marca, e substância lida da designação.
 *
 * O QUE ESTAS ASSERÇÕES PROTEGEM
 *
 * 1. A INVARIANTE DE NÃO-DEGRADAÇÃO. As rotas de salvamento só podem
 *    correr quando o resultado ia ser "Outros <X>" ou nada. Se alguém as
 *    puser a correr antes da resolução normal, um champô com ATC deixa
 *    de ser classificado pelo ATC — e o sintoma é uma categoria pior,
 *    não um erro. É a asserção mais importante do ficheiro.
 *
 * 2. A FRONTEIRA DE PALAVRA. `\b` em JavaScript só conhece [A-Za-z0-9_]:
 *    `/\b[ií]ntim/` NUNCA casa com "Íntima", porque entre o espaço e o
 *    "Í" não há fronteira nenhuma. Cada padrão deste módulo que comece
 *    por classe acentuada usa `(?<![a-zA-ZÀ-ÿ0-9])`. Um `\b` que volte a
 *    entrar apaga silenciosamente a regra.
 *
 * 3. AS ABREVIATURAS DO ERP. "Ch" é champô, "Past Dent" é pasta
 *    dentífrica, "Ch.Chu" é o código de família de chupetas. Não são
 *    curiosidades: são como este catálogo escreve, e valem milhares de
 *    produtos.
 *
 * Uso: npx tsx scripts/tests/test-catalog-rescue-routes.ts
 */
import { mapToCanonical } from "../../lib/catalog-taxonomy-map";
import { classifyProductType } from "../../lib/catalog-classifier";
import { isValidNivel1, isValidNivel2 } from "../../lib/catalog-taxonomy";
import { avaliarProduto } from "../../lib/catalog/utilizacoes-ciclo";
import { MIN_CONFIANCA } from "../../lib/catalog/utilizacoes-regras";
import type { ProductType } from "../../lib/catalog-types";

let pass = 0;
let fail = 0;
const ok = (l: string) => { pass++; console.log(`  [OK]    ${l}`); };
const bad = (l: string, d?: string) => { fail++; console.log(`  [FALHA] ${l}${d ? `\n            ${d}` : ""}`); };
const check = (cond: boolean, l: string, d?: string) => (cond ? ok(l) : bad(l, d));

function mapear(designacao: string, productType: ProductType = "OUTRO", conf = 0.3) {
  return mapToCanonical({
    productType,
    productTypeConfidence: conf,
    externalCategory: null,
    externalSubcategory: null,
    designacao,
    atc: null,
  });
}

/**
 * Um par (nivel1, nivel2) esperado, validado contra a taxonomia canónica.
 *
 * Sem productType, simula um produto por classificar (confiança 0.3, o
 * que o mapper trata como "sem nível 1"). Com productType, simula um já
 * classificado — e aí a confiança tem de ser realista: abaixo de 0.60 o
 * mapper ignora o tipo e devolveria null por outra razão que não a regra
 * em teste.
 */
function esperaCategoria(
  designacao: string,
  nivel1: string,
  nivel2: string,
  productType: ProductType = "OUTRO",
) {
  const r = mapear(designacao, productType, productType === "OUTRO" ? 0.3 : 0.9);
  const got = r ? `${r.nivel1} > ${r.nivel2}` : "NULL";
  check(
    r?.nivel1 === nivel1 && r?.nivel2 === nivel2,
    `"${designacao}" → ${nivel1} > ${nivel2}`,
    got === `${nivel1} > ${nivel2}` ? undefined : `obteve: ${got}`,
  );
}

// ─────────────────────────────────────────────────────────────────────
console.log("=== invariante: o salvamento NÃO degrada classificação específica ===");

// Um champô que já foi classificado por keyword dentro de CAPILAR tem de
// continuar a sair por keyword — a rota nunca lhe toca.
{
  const r = mapToCanonical({
    productType: "MEDICAMENTO",
    productTypeConfidence: 0.95,
    externalCategory: null,
    externalSubcategory: null,
    designacao: "Ibuprofeno Generis 400 mg x 20 comp",
    atc: "M01AE01",
  });
  check(r?.nivel2 === "Analgésicos e Anti-inflamatórios", "ATC específico vence e não é substituído por rota");
  check(r?.method === "atc_prefix", `método continua atc_prefix (got ${r?.method})`);
}
{
  // Mesmo produto com uma palavra que existe numa rota ("gel de banho"):
  // como o ATC resolve, a rota não pode entrar.
  const r = mapToCanonical({
    productType: "MEDICAMENTO",
    productTypeConfidence: 0.95,
    externalCategory: null,
    externalSubcategory: null,
    designacao: "Ciclopirox Gel de Banho Medicinal 1,5%",
    atc: "D01AE14",
  });
  check(r?.nivel1 === "MEDICAMENTOS", "palavra de rota não rouba um produto já resolvido por ATC");
  check(r?.method !== "designacao_rota", `método não é designacao_rota (got ${r?.method})`);
}
{
  // Sem ATC e sem keyword que sirva, aí sim a rota entra. Um
  // desodorizante classificado como DERMOCOSMETICA não tem nível 2
  // possível nesse ramo — "Desodorizantes" vive em HIGIENE CORPORAL — e
  // é exactamente para isto que a rota existe.
  const r = mapear("Vichy Deo Stress Resist 50ml", "DERMOCOSMETICA", 0.8);
  check(r?.method === "designacao_rota", `sem nível 2 possível no ramo, a rota entra (got ${r?.method})`);
  check(r?.nivel1 === "HIGIENE CORPORAL" && r?.nivel2 === "Desodorizantes", "…e atravessa para o nível 1 certo");
}

// ─────────────────────────────────────────────────────────────────────
console.log("\n=== fronteira de palavra sensível a acentos (\\b não serve) ===");
esperaCategoria("Melagyn Gravidez Gel Hig Íntima 200ml", "HIGIENE CORPORAL", "Higiene Íntima");
esperaCategoria("Óculos Sol Junior", "OFTALMOLOGIA", "Outros Oftalmologia");
esperaCategoria("Éter Etílico 100 Ml", "MATERIAL CLÍNICO E CONSUMÍVEIS", "Consumíveis Clínicos");
esperaCategoria("Óleo de Amêndoas Doces 200ml", "DERMOCOSMÉTICA", "Corpo");
{
  // O reverso: a fronteira acentuada não pode passar a apanhar radicais
  // DENTRO de palavras. "gripe" dentro de "Cêgripe" não é a palavra.
  const r = mapear("Cêgripe 1 mg/500 mg x 20 comp", "MEDICAMENTO", 0.9);
  check(
    r?.nivel2 === "Constipação, Tosse e Gripe",
    "marca acentuada resolve pela entrada de marca, não por radical solto",
    `obteve: ${r?.nivel2}`,
  );
}

// ─────────────────────────────────────────────────────────────────────
console.log("\n=== abreviaturas do ERP ===");
esperaCategoria("Klorane Capilar Ch Centaureas Azuis 400ml", "CAPILAR", "Champôs");
esperaCategoria("Fluocaril Past Dent Sensiv 75ml", "HIGIENE ORAL", "Pastas Dentífricas");
esperaCategoria("Eludril Care Colut 500Ml", "HIGIENE ORAL", "Elixires");
esperaCategoria("Gum Bi-Direction 2714 Escov 1,4Mm X6", "HIGIENE ORAL", "Escovas de Dentes");
esperaCategoria("Isdin Fotoprot Act Oil Spf30 200Ml", "PROTEÇÃO SOLAR", "Solar Adulto");
esperaCategoria("Vichy Deo Stress Resist 50ml", "HIGIENE CORPORAL", "Desodorizantes");
esperaCategoria("TH NAILVARNISH VERNIZ N. 30 10 ML", "COSMÉTICA", "Maquilhagem");
esperaCategoria("Luvas Latex Peq. cx 100", "MATERIAL CLÍNICO E CONSUMÍVEIS", "Luvas");
esperaCategoria("LIGADURA ELAST 6cmX4m BV COR BRANCA", "PRIMEIROS SOCORROS", "Ligaduras");
esperaCategoria("BENGALA EXTENSIVEL ALUMINIO CINZA", "MOBILIDADE E APOIO DIÁRIO", "Apoio à Mobilidade");
esperaCategoria("Physiologica Soro Fisio 5ml X20", "OTORRINO", "Lavagens e Soluções");

console.log("\n=== código de família do fornecedor de puericultura ===");
esperaCategoria("Ch.Chu72735410000 Physio Air Lumi Sil 12m+", "PUERICULTURA E BEBÉ", "Chupetas e Biberões");
esperaCategoria("Ch.Ali16000100000 Prato Termico Girl 6m+", "PUERICULTURA E BEBÉ", "Alimentação do Bebé");
esperaCategoria("Ch.Ocu9801100000 Oculos Sol Boy 0m+", "PUERICULTURA E BEBÉ", "Acessórios de Bebé");
{
  // "Ch." de código NÃO pode ser lido como champô.
  const r = mapear("Ch.Chu72735410000 Physio Air Lumi Sil 12m+");
  check(r?.nivel1 !== "CAPILAR", "prefixo Ch. de código não é confundido com champô");
}

// ─────────────────────────────────────────────────────────────────────
console.log("\n=== solar: criança só quando é mesmo de criança ===");
esperaCategoria("AVENE SOLAR SPRAY 50+ CRIANÇA", "PROTEÇÃO SOLAR", "Solar Criança");
{
  const r = mapear("Eucerin Sunface Photoaging SPF50 Med 50", "DERMOCOSMETICA", 0.8);
  check(r?.nivel2 === "Solar Adulto", "SPF sem menção infantil não vai para Solar Criança", `obteve: ${r?.nivel2}`);
}

// ─────────────────────────────────────────────────────────────────────
console.log("\n=== substância na designação (genérico português) ===");
esperaCategoria("IRBESARTAN PHARMAKERN 300 MG 28 COMP.", "MEDICAMENTOS", "Cardiovascular", "MEDICAMENTO");
esperaCategoria("Pregabalina Krka 75 Mg 56 Cápsula", "MEDICAMENTOS", "Sistema Nervoso", "MEDICAMENTO");
esperaCategoria("Ciprofloxacina Alter 750 mg Comp Revestido", "MEDICAMENTOS", "Anti-infecciosos", "MEDICAMENTO");
esperaCategoria("Rosuvastatina Generis 10 Mg 28 Comp.", "MEDICAMENTOS", "Cardiovascular", "MEDICAMENTO");
esperaCategoria("Sildenafil Aurovitas 100 Mg 4 Comp.", "MEDICAMENTOS", "Urológicos", "MEDICAMENTO");
esperaCategoria("Montelucaste Sandoz 10 Mg 28 Comp.", "MEDICAMENTOS", "Respiratório", "MEDICAMENTO");

// ─────────────────────────────────────────────────────────────────────
console.log("\n=== precedência: dosagem+forma vence marca de fabricante ===");
{
  const r = classifyProductType({
    designacao: "SORO FISIOLÓGICO B.BRAUN 9 MG/ML SOL. INJETÁVEL",
    tipoArtigo: null, flagMSRM: false, flagMNSRM: false, codigoATC: null,
  });
  check(r.productType === "MEDICAMENTO", "dosagem clínica + forma vence marca de dispositivos", `obteve ${r.productType}`);
}
{
  // ...mas não vence a palavra que descreve o próprio produto.
  const r = classifyProductType({
    designacao: "SOLGAR VIT K2 100MCG 50 CAPS",
    tipoArtigo: null, flagMSRM: false, flagMNSRM: false, codigoATC: null,
  });
  check(r.productType === "SUPLEMENTO", "suplemento em cápsulas com dosagem continua suplemento", `obteve ${r.productType}`);
}

// ─────────────────────────────────────────────────────────────────────
console.log("\n=== utilizações ===");
function utilizacoesDe(designacao: string, subcategoria: string | null = null, categoria: string | null = null) {
  return avaliarProduto({
    id: "x", designacao, productType: "MEDICAMENTO",
    categoria, subcategoria, codigoATC: null, grupoHomogeneo: null, temRegulatorio: false,
  }).filter((c) => c.confianca >= MIN_CONFIANCA).map((c) => c.utilizacao);
}
{
  const u = utilizacoesDe("Ambroxol Farmoz 30 Mg Comprimidos");
  check(u.includes("tosse-produtiva"), "substância da designação dá a utilização específica");
  check(u.includes("tosse"), "…e a geral por implicação");
}
{
  const u = utilizacoesDe("Bisoltussin Tosse Seca 2 Mg/ml Sol. Oral");
  check(u.includes("tosse-seca"), "sintoma escrito na designação resolve tosse seca");
  check(u.includes("tosse"), "tosse seca implica tosse");
}
{
  const u = utilizacoesDe("Irbesartan Pharmakern 300 Mg 28 Comp.");
  check(u.includes("tensao-arterial"), "anti-hipertensor pela substância");
  check(!u.includes("tosse"), "não há implicação inventada");
}
{
  const u = utilizacoesDe("Xarope Expectorante Mel 13.33 Mg/ml");
  check(u.includes("tosse-produtiva") && u.includes("tosse"), "expectoração → tosse produtiva + tosse");
}
{
  // Uma marca sem substância nem sintoma não pode ganhar utilização.
  const u = utilizacoesDe("Zeldox, 40 mg x 56 cáps");
  check(u.length === 0, "sem sinal seguro não há utilização", `obteve: ${u.join(", ")}`);
}
{
  const u = utilizacoesDe("Molicare Slip Frald Extra Plus M X30");
  check(u.includes("incontinencia"), "fralda de adulto → incontinência");
}

// ─────────────────────────────────────────────────────────────────────
console.log("\n=== integridade: nada fora da taxonomia canónica ===");
{
  // Percorre um lote representativo e garante que nenhum resultado
  // inventa nomes. É o contrato do mapper.
  const amostras = [
    "Klorane Capilar Ch 400ml", "Luvas Latex M", "Ch.Chu1808000000 Physio Soft",
    "Eludril Colut 500Ml", "BENGALA 550", "Óculos Sol Junior",
    "Isdin Fotoprot Spf30", "Éter Etílico", "Vichy Deo 50ml",
    "Melagyn Gel Hig Íntima", "Preservat Nature Xl X12", "Chá Camomila 10 Saq",
  ];
  let invalidos = 0;
  for (const d of amostras) {
    const r = mapear(d);
    if (!r) continue;
    if (!isValidNivel1(r.nivel1) || !isValidNivel2(r.nivel1, r.nivel2)) {
      invalidos++;
      console.log(`            fora da taxonomia: "${d}" → ${r.nivel1} > ${r.nivel2}`);
    }
  }
  check(invalidos === 0, "todas as saídas pertencem à taxonomia canónica");
}
{
  // "NÃO CLASSIFICADO" continua a existir: sem sinal, devolve null.
  check(mapear("00") === null, "texto sem sinal nenhum devolve null");
  check(mapear("Kit 11") === null, "código interno sem sinal devolve null");
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail === 0 ? 0 : 1);
