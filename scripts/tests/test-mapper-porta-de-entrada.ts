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
// A tabela de casos e as portas vivem em `lib/` — partilhadas com
// `scripts/diagnostics/mapper-coerencia.ts`, que corre a mesma
// verificação dentro da imagem operacional, onde `scripts/tests/` não
// entra. Duas listas divergiriam, e a primeira a divergir seria a do
// diagnóstico: a que ninguém corre todos os dias.
import { CASOS, verificarCaso } from "../../lib/catalog/mapper-coerencia";

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

const par = (i: TaxonomyMapInput): string => {
  const r = mapToCanonical(i);
  return r ? `${r.nivel1} > ${r.nivel2}` : "(null)";
};

// Este ficheiro compila para CommonJS: sem top-level await.
async function main(): Promise<void> {
  // ── 1. A tabela partilhada, caso a caso ────────────────────────────
  //
  // A asserção central não é "este produto dá isto": é que as QUATRO
  // portas dão UMA resposta. É o que apanha um token novo posto nos dois
  // conjuntos de regras, mesmo com os casos conhecidos a passar.
  console.log("\n=== a mesma designação em todas as portas ===");
  for (const c of CASOS) {
    const r = verificarCaso(c.designacao, c.esperado);
    check(
      r.distintos === 1,
      `"${c.designacao.slice(0, 42)}" — um só resultado nas 4 portas`,
      r.porPorta.map((p) => `${p.porta}=${p.valor}`).join(" | "),
    );
    check(
      r.correcto,
      `  …e é ${c.esperado}`,
      r.porPorta.filter((p) => p.valor !== c.esperado).map((p) => `${p.porta}=${p.valor}`).join(" | "),
    );
  }

  // A tabela é partilhada com a imagem, portanto encolher-lha em silêncio
  // enfraqueceria o diagnóstico operacional sem nada acusar aqui.
  console.log("\n=== a tabela partilhada cobre os três padrões ===");
  {
    const tem = (frag: string) => CASOS.some((c) => c.designacao.includes(frag));
    check(tem("Leukotape"), "ligadura (o caso que reproduziu o defeito)");
    check(tem("COMPRESSA") || tem("Compressa"), "compressa");
    check(tem("BETADINE GAZE"), "betadine gaze (ordem na rota plana)");
    check(tem("Lancetas"), "lancetas (o que NÃO podia mudar)");
    check(CASOS.length >= 11, `pelo menos 11 casos (${CASOS.length})`);
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
