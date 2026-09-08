/**
 * scripts/tests/test-mapper-porta-de-entrada.ts
 *
 * A mesma designação tem de dar a mesma classificação, venha por onde
 * vier.
 *
 * ── O defeito que isto guarda ────────────────────────────────────────
 *
 * `catalog-taxonomy-map.ts` tem dois conjuntos de regras: um dicionário
 * por N1, usado quando o nível 1 já é conhecido, e uma rota de salvamento
 * plana, usada quando não é. Os tokens de material de curativo —
 * `compressa`, `penso`, `gaze`, `adesivo`, `ligadura`, `algodão` —
 * estavam nos DOIS, apontados a famílias DIFERENTES.
 *
 * Resultado medido com o mapper de então:
 *
 *   "Leukotape K Lig Elast Ades"
 *     sem productType ............ PRIMEIROS SOCORROS > Ligaduras
 *     productType=DISPOSITIVO_MEDICO  DISPOSITIVOS MÉDICOS > Material de Curativo
 *
 * Não era o modelo a discordar da regra, nem uma farmácia a discordar de
 * outra: era o mapper determinístico a discordar de si próprio consoante
 * a porta de entrada. E acabava em `CatalogoGlobalRevisao` a parecer
 * desacordo entre tenants.
 *
 * O segundo defeito era de ordem: na rota plana os pensos vinham antes
 * dos antissépticos, e `resolverSalvamento` devolve o PRIMEIRO match.
 * "BETADINE GAZE IMPREGNADA" saía Pensos e Compressas — com `betadine`
 * escrito no padrão dos antissépticos, três linhas abaixo, sem nunca ser
 * alcançado. O par prova-o: "BETADINE SOLUÇÃO CUTÂNEA", sem a palavra
 * "gaze", já dava Antissépticos.
 *
 * ── A asserção que fecha isto ────────────────────────────────────────
 *
 * Não basta testar cada caso: testa-se que os QUATRO contextos dão UM
 * resultado. É a invariante que apanha um token novo posto nos dois
 * sítios, mesmo que os casos conhecidos continuem a passar.
 *
 * Corre com:  npm run test:mapper-porta-de-entrada
 */
import { mapToCanonical, type TaxonomyMapInput } from "../../lib/catalog-taxonomy-map";
import type { ProductType } from "../../lib/catalog-types";

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, extra?: string) => {
  if (cond) {
    ok++;
    console.log(`  [OK]    ${label}`);
  } else {
    ko++;
    console.log(`  [FALHA] ${label}${extra ? `  — ${extra}` : ""}`);
  }
};

const base = (designacao: string): TaxonomyMapInput => ({
  productType: "OUTRO",
  productTypeConfidence: 0,
  externalCategory: null,
  externalSubcategory: null,
  designacao,
  atc: null,
});

const comTipo = (designacao: string, productType: ProductType): TaxonomyMapInput => ({
  ...base(designacao),
  productType,
  productTypeConfidence: 0.9,
});

const comBreadcrumb = (designacao: string, cat: string): TaxonomyMapInput => ({
  ...base(designacao),
  externalCategory: cat,
});

/** Os quatro caminhos por onde um produto chega ao mapper. */
const CONTEXTOS: Array<{ nome: string; input: (d: string) => TaxonomyMapInput }> = [
  { nome: "sem nada", input: base },
  { nome: "productType=DISPOSITIVO_MEDICO", input: (d) => comTipo(d, "DISPOSITIVO_MEDICO") },
  { nome: "breadcrumb Dispositivos Médicos", input: (d) => comBreadcrumb(d, "Dispositivos Médicos") },
  { nome: "breadcrumb Primeiros Socorros", input: (d) => comBreadcrumb(d, "Primeiros Socorros") },
];

const par = (i: TaxonomyMapInput): string => {
  const r = mapToCanonical(i);
  return r ? `${r.nivel1} > ${r.nivel2}` : "(null)";
};

/**
 * O produto dá o mesmo resultado nos quatro contextos — e é o esperado.
 *
 * As duas metades importam. Só "são todos iguais" passaria se todos
 * fossem iguais e errados; só "o esperado" passaria se um contexto
 * divergisse sem ninguém reparar.
 */
function estavel(designacao: string, esperado: string): void {
  const obtidos = CONTEXTOS.map((c) => ({ nome: c.nome, valor: par(c.input(designacao)) }));
  const distintos = new Set(obtidos.map((o) => o.valor));

  check(
    distintos.size === 1,
    `"${designacao.slice(0, 40)}" — um só resultado nos 4 contextos`,
    [...new Set(obtidos.map((o) => `${o.nome}=${o.valor}`))].join(" | "),
  );
  check(
    obtidos.every((o) => o.valor === esperado),
    `  …e é ${esperado}`,
    obtidos.filter((o) => o.valor !== esperado).map((o) => `${o.nome}=${o.valor}`).join(" | "),
  );
}

// Este ficheiro compila para CommonJS: sem top-level await.
async function main(): Promise<void> {
  // ── 1. Os casos com que o defeito foi reproduzido ──────────────────
  console.log("\n=== material de curativo: a porta deixa de decidir ===");
  {
    estavel("Leukotape K Lig Elast Ades 5x5cm Bege", "PRIMEIROS SOCORROS > Ligaduras");
    estavel("Leukotape K Lig Elast Ades 5x5cm Azul", "PRIMEIROS SOCORROS > Ligaduras");
    estavel("COMPRESSA NAO TECIDO 10CMX10CM X 5UNI BV", "PRIMEIROS SOCORROS > Pensos e Compressas");
    estavel("Compressa N Tecid Est 7,5x7,5 30g Ee1 X10 BV", "PRIMEIROS SOCORROS > Pensos e Compressas");
  }

  // ── 2. O específico ganha ao genérico ──────────────────────────────
  console.log("\n=== betadine: a marca vale mais que o formato ===");
  {
    estavel("BETADINE GAZE IMPREGNADA 10X10CM CAIXA", "PRIMEIROS SOCORROS > Antissépticos");
    // O par que revelou o defeito: o mesmo produto sem a palavra "gaze"
    // sempre esteve certo. Continua.
    estavel("BETADINE SOLUCAO CUTANEA 125ML", "PRIMEIROS SOCORROS > Antissépticos");
    estavel("Iodopovidona Solucao Dermica 100ml", "PRIMEIROS SOCORROS > Antissépticos");
  }

  // ── 3. O que NÃO podia mexer ───────────────────────────────────────
  console.log("\n=== agulhas e lancetas: intocadas ===");
  {
    estavel("Agulhas Clickfine 6mmx31g 100", "MATERIAL CLÍNICO E CONSUMÍVEIS > Seringas e Agulhas");
    estavel("Agulhas Clickfine 8mmx31g 100", "MATERIAL CLÍNICO E CONSUMÍVEIS > Seringas e Agulhas");
    estavel("Wellion Lancetas De Seguranca 23g 200", "MATERIAL CLÍNICO E CONSUMÍVEIS > Seringas e Agulhas");
    estavel("Seringa Insulina 1ml 100ui", "MATERIAL CLÍNICO E CONSUMÍVEIS > Seringas e Agulhas");
  }

  console.log("\n=== Material de Imobilização: intocado ===");
  {
    // Não foi tocado, e o teste tem de o provar no contexto onde vive:
    // com o N1 já conhecido, que é quando o dicionário corre.
    for (const d of ["Tala Imobilizadora Dedo Aluminio", "Ortotese Punho Direita M"]) {
      check(
        par(comTipo(d, "DISPOSITIVO_MEDICO")) === "DISPOSITIVOS MÉDICOS > Material de Imobilização",
        `"${d.slice(0, 34)}" continua Material de Imobilização`,
        par(comTipo(d, "DISPOSITIVO_MEDICO")),
      );
    }
  }

  console.log("\n=== Material de Curativo continua alcançável ===");
  {
    // `curativo` ficou no dicionário. Se alguém o retirar também, esta
    // subcategoria passa a inalcançável por regra e ninguém dá por isso.
    const d = "Kit Curativo Esteril Descartavel";
    check(
      par(comTipo(d, "DISPOSITIVO_MEDICO")) === "DISPOSITIVOS MÉDICOS > Material de Curativo",
      `"${d}" → Material de Curativo`,
      par(comTipo(d, "DISPOSITIVO_MEDICO")),
    );
  }

  // ── 4. Fora do âmbito: tem de ficar exactamente como estava ────────
  console.log("\n=== fora do âmbito desta correcção ===");
  {
    // CISTITONE: o mapper não o classifica, e continua a não classificar.
    // Foi isso que provou que o "Cabelo, Pele e Unhas" veio do modelo.
    check(
      par(base("CISTITONE FORTE BD X 60CAPS")) === "(null)",
      "CISTITONE continua sem classificação pelo mapper",
      par(base("CISTITONE FORTE BD X 60CAPS")),
    );
    check(
      par(comTipo("CISTITONE FORTE BD X 60CAPS", "SUPLEMENTO")) ===
        "SUPLEMENTOS ALIMENTARES > Outros Suplementos",
      "…e como suplemento continua no balde",
      par(comTipo("CISTITONE FORTE BD X 60CAPS", "SUPLEMENTO")),
    );

    // DERMOCOSMÉTICA: eixos misturados, resolvidos por ordem. Não foi
    // tocada — a asserção fixa o comportamento actual para que uma
    // alteração futura ali seja deliberada e não colateral.
    check(
      par(comTipo("Creme Hidratante Rosto 50ml", "DERMOCOSMETICA")) ===
        "DERMOCOSMÉTICA > Hidratação",
      "DERMOCOSMÉTICA continua a resolver por ordem (Hidratação antes de Rosto)",
      par(comTipo("Creme Hidratante Rosto 50ml", "DERMOCOSMETICA")),
    );

    // Glicemia: a regra por marca continua a apanhar os medidores.
    check(
      par(base("Contour Next Tiras Glicemia X50")) === "DISPOSITIVOS MÉDICOS > Glicemia e Diabetes",
      "as tiras de glicemia continuam em Glicemia e Diabetes",
      par(base("Contour Next Tiras Glicemia X50")),
    );
  }

  // ── 5. A invariante, no texto ──────────────────────────────────────
  //
  // As asserções acima cobrem os tokens conhecidos. Esta apanha o token
  // NOVO que alguém ponha nos dois sítios — o defeito a repetir-se com
  // outra palavra.
  console.log("\n=== nenhum token de curativo em dois N1 ===");
  {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("lib/catalog-taxonomy-map.ts", "utf8");
    const iDisp = src.indexOf('nivel2: "Material de Curativo"');
    const linhaDisp = src.slice(src.lastIndexOf("{", iDisp), iDisp);

    for (const token of ["compressa", "penso", "gaze", "adesivo", "soffix", "ligadura", "algod", "band-?aid"]) {
      check(
        !linhaDisp.includes(token),
        `"${token}" não está em Material de Curativo`,
      );
    }
    check(linhaDisp.includes("curativo"), '…e "curativo" continua lá');

    // A ordem na rota plana: antisséptico antes de penso.
    const iAnti = src.indexOf('nivel1: "PRIMEIROS SOCORROS", nivel2: "Antissépticos"');
    const iPenso = src.indexOf('nivel1: "PRIMEIROS SOCORROS", nivel2: "Pensos e Compressas"');
    check(iAnti > 0 && iPenso > 0, "as duas rotas existem");
    check(iAnti < iPenso, "o antisséptico vem antes do penso", `${iAnti} < ${iPenso}`);
  }

  console.log(`\n${ok} ok, ${ko} falhas`);
  process.exit(ko === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
