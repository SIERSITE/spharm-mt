/**
 * scripts/tests/test-catalog-classifier.ts
 *
 * Fixa as regras FORTES do classificador de tipo de produto.
 *
 * O caso central é a distinção entre DOSAGEM CLÍNICA e VOLUME DE EMBALAGEM.
 * Até à v1.5 o padrão de dosagem aceitava `ml` e `g` isolados, e por isso
 * "champô 200ml" e "creme 15g" eram lidos como medicamentos. Medido sobre o
 * catálogo real: 4 655 produtos comerciais seriam classificados MEDICAMENTO
 * por causa do volume do frasco. Estes testes impedem o regresso disso.
 *
 * Uso: npx tsx scripts/tests/test-catalog-classifier.ts
 */
import {
  classifyProductType,
  type ProductClassificationInput,
} from "../../lib/catalog-classifier";
import type { ProductType } from "../../lib/catalog-types";

let pass = 0;
let fail = 0;

function base(designacao: string, over: Partial<ProductClassificationInput> = {}): ProductClassificationInput {
  return {
    designacao,
    tipoArtigo: null,
    flagMSRM: false,
    flagMNSRM: false,
    codigoATC: null,
    ...over,
  };
}

function check(
  label: string,
  input: ProductClassificationInput,
  expected: ProductType,
  opts: { semDosagem?: boolean; comDosagem?: boolean } = {},
) {
  const r = classifyProductType(input);
  const problems: string[] = [];
  if (r.productType !== expected) problems.push(`tipo=${r.productType}, esperado ${expected}`);
  if (opts.semDosagem && r.signals.includes("dosage_pattern")) problems.push("marcou dosagem onde só há embalagem");
  if (opts.comDosagem && !r.signals.includes("dosage_pattern")) problems.push("não reconheceu a dosagem clínica");

  if (problems.length === 0) {
    pass++;
    console.log(`  [OK]    ${label}`);
  } else {
    fail++;
    console.log(`  [FALHA] ${label}`);
    for (const p of problems) console.log(`            ${p}`);
    console.log(`            sinais: ${r.signals.join(", ") || "(nenhum)"}`);
  }
}

console.log("=== volume de embalagem NÃO é dosagem (regressão v1.5) ===");
// Produtos reais do catálogo, todos classificados MEDICAMENTO antes da v1.5.
// Fica OUTRO — sem marca conhecida e "Ch" é ambíguo (champô vs chá). O que
// importa aqui é que 200ml não o torna MEDICAMENTO.
check("champô 200ml", base("Tricovel Tricoage 45+ Ch Fortificante 200ml"), "OUTRO", { semDosagem: true });
check("emoliente 15g", base("Neostrata Skin Ac Line Lift St 2 Emol 15g"), "OUTRO", { semDosagem: true });
check("spray 400ml", base("Pic Solution Gelo Inst Spray 400ml"), "OUTRO", { semDosagem: true });
check("gel de banho 300ml", base("Policalm Gel Banho 300ml"), "HIGIENE_CUIDADO", { semDosagem: true });
check("creme de bebé 200ml", base("Klorane Bebe Cr Hidrat Vit 200ml"), "DERMOCOSMETICA", { semDosagem: true });
check("papa 250g", base("Holle Papa Creme Arroz 4M 250G"), "PUERICULTURA", { semDosagem: true });

console.log("\n=== dosagem clínica continua a contar ===");
check("mg", base("Lamisil, 250 mg x 14 comp"), "MEDICAMENTO", { comDosagem: true });
check("mcg/dose", base("Dilamax Inalador Sem CFC, 25 mcg/dose x 120 susp press inal"), "MEDICAMENTO", { comDosagem: true });
check("mg/ml", base("SORO FISIOLÓGICO B.BRAUN 9 MG/ML SOL. INJETÁVEL"), "MEDICAMENTO", { comDosagem: true });
check("percentagem", base("MICETINOFTALMINA - COLIRIO 0,5% 5 M"), "MEDICAMENTO", { comDosagem: true });
check("UI", base("Insulina Humana 100 UI/ml sol inj"), "MEDICAMENTO", { comDosagem: true });
check("razão g/ml", base("Solução Glucose 1 g/100 ml"), "MEDICAMENTO", { comDosagem: true });

console.log("\n=== abreviaturas de forma farmacêutica do ERP ===");
check("CAPS", base("SIRDALUD MR CAPS LM 6 MG X 30"), "MEDICAMENTO");
check("COMP", base("SOBREPINA COMP REV 30 MG X 60"), "MEDICAMENTO");
check("XAR", base("Diacol Xar 200 Ml"), "MEDICAMENTO");
check("AMP", base("FETRIVAL AMP BEB 40 MG X 20"), "MEDICAMENTO");
check("SUP", base("Asacol, 500 mg x 10 sup"), "MEDICAMENTO");

console.log("\n=== abreviaturas só por token exacto, nunca por substring ===");
// Se "amp"/"sup"/"comp" fossem comparados por substring, estes passariam a
// MEDICAMENTO por causa de "shampoo", "superfoods" e "composição".
check("shampoo não contém 'amp'", base("Shampoo Suave Cabelo Normal"), "HIGIENE_CUIDADO");
check("superfoods não contém 'sup'", base("Superfoods Spirulina Gold X180"), "SUPLEMENTO");
check("composição não contém 'comp'", base("Bioderma Composicao Rica Pele Seca"), "DERMOCOSMETICA");

console.log("\n=== suplemento em cápsulas continua suplemento ===");
// A forma farmacêutica não transforma um suplemento em medicamento: têm
// ambos comprimidos e dosagem. Quando é mesmo medicamento, um sinal
// regulamentar resolve antes de chegar às keywords.
check("Solgar em cápsulas com mcg", base("SOLGAR VIT K2 100MCG 50 CAPS"), "SUPLEMENTO");
check("spirulina em comprimidos", base("Superfoods Spirulina Gold Comp X180"), "SUPLEMENTO");
check("omega 3 em cápsulas", base("Arkocapsulas Omega 3 Caps X 60"), "SUPLEMENTO");
check("mas com ATC é medicamento", base("SOLGAR VIT K2 100MCG 50 CAPS", { codigoATC: "B02BA01" }), "MEDICAMENTO");

console.log("\n=== sinais regulamentares vencem o texto ===");
check("flagMSRM ligada", base("Produto Qualquer Sem Pistas", { flagMSRM: true }), "MEDICAMENTO");
check("flagGenerico", base("CELLULASE GOLD PLUS", { flagGenerico: true }), "MEDICAMENTO");
check("RegulatoryRecord", base("Mebocaína Forte, 20 pst", { hasRegulatoryRecord: true }), "MEDICAMENTO");
check("grupoHomogeneo", base("Produto Opaco", { hasGrupoHomogeneo: true }), "MEDICAMENTO");
check("ATC", base("Produto Opaco", { codigoATC: "N02BE01" }), "MEDICAMENTO");

console.log("\n=== confiança dos sinais regulamentares ===");
for (const [label, input, min] of [
  ["flagMSRM", base("x", { flagMSRM: true }), 0.99],
  ["ATC", base("x", { codigoATC: "A01AA01" }), 0.97],
  ["RegulatoryRecord", base("x", { hasRegulatoryRecord: true }), 0.96],
  ["flagGenerico", base("x", { flagGenerico: true }), 0.95],
] as const) {
  const r = classifyProductType(input);
  if (r.confidence >= min) {
    pass++;
    console.log(`  [OK]    ${label} conf=${r.confidence} >= ${min}`);
  } else {
    fail++;
    console.log(`  [FALHA] ${label} conf=${r.confidence}, esperado >= ${min}`);
  }
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail === 0 ? 0 : 1);
