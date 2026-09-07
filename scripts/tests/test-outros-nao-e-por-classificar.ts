/**
 * scripts/tests/test-outros-nao-e-por-classificar.ts
 *
 * A regra funcional final: **"Outros X" não é "Por Classificar"**.
 *
 * Um produto em "Outros Medicamentos" é um medicamento. Conta como
 * medicamento, agrupa com medicamentos, aparece nos relatórios de
 * medicamentos e vende-se na prateleira dos medicamentos. O que falta é
 * saber QUAL — granularidade dentro da família, não classificação.
 *
 * Durante muito tempo os dois casos foram tratados como um só, e o efeito
 * era medível: na Silveira, 2 746 produtos com categoria a serem lidos
 * como se não tivessem nenhuma.
 *
 * ── Os três estados, e o que cada um significa ───────────────────────
 *
 *   ESPECIFICO   nível 1 e nível 2 reais
 *   FAMILIA      nível 1 real, nível 2 é um balde (ou não existe)
 *   AUSENTE      sem nível 1 — o único que é "por classificar"
 *
 * Secções:
 *   A  o resolver central devolve o nível de detalhe certo
 *   B  "Outros X" NUNCA é por classificar
 *   C  o par para relatórios não devolve baldes como subcategoria
 *   D  o agrupamento colapsa o balde na família
 *   E  as superfícies: KPI, dropdowns, grelhas
 *
 * Corre com:  npm run test:outros-nao-e-por-classificar
 */
import { readFileSync } from "node:fs";
import {
  SEM_CLASSIFICACAO_LABEL,
  resolveCategoria,
  resolverPar,
  type NivelDetalhe,
} from "../../lib/categoria-resolver";

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) {
    ok++;
    console.log(`  [OK]    ${label}`);
  } else {
    ko++;
    console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`);
  }
};

const src = (n1: string | null, n2: string | null) => ({
  classificacaoNivel1: n1 ? { nome: n1 } : null,
  classificacaoNivel2: n2 ? { nome: n2 } : null,
});

/** Os baldes reais da taxonomia, tal como aparecem na base. */
const BALDES: Array<[string, string]> = [
  ["DERMOCOSMÉTICA", "Outros Dermocosmética"],
  ["MEDICAMENTOS", "Outros Medicamentos"],
  ["DISPOSITIVOS MÉDICOS", "Outros Dispositivos Médicos"],
  ["HIGIENE CORPORAL", "Outros Higiene Corporal"],
  ["SUPLEMENTOS ALIMENTARES", "Outros Suplementos Alimentares"],
  ["VETERINÁRIA", "Outros Veterinária"],
];

// ══════════════════════════════════════════════════════════════════════
// A · O nível de detalhe
// ══════════════════════════════════════════════════════════════════════
console.log("\nA · resolveCategoria devolve o detalhe certo");
{
  const esp = resolveCategoria(src("DERMOCOSMÉTICA", "Rosto"));
  check(esp.detalhe === "ESPECIFICO", "N1 + N2 real → ESPECIFICO", esp.detalhe);
  check(esp.categoria === "DERMOCOSMÉTICA" && esp.grupo === "Rosto", "…e os dois níveis saem intactos");

  const fam = resolveCategoria(src("DERMOCOSMÉTICA", "Outros Dermocosmética"));
  check(fam.detalhe === "FAMILIA", "N1 + balde → FAMILIA", fam.detalhe);

  const soN1 = resolveCategoria(src("DERMOCOSMÉTICA", null));
  check(soN1.detalhe === "FAMILIA", "N1 sem N2 → FAMILIA (falta detalhe, não classificação)");

  const aus = resolveCategoria(src(null, null));
  check(aus.detalhe === "AUSENTE", "sem nada → AUSENTE");
  check(aus.categoria === SEM_CLASSIFICACAO_LABEL, "…e só este leva o rótulo «Por Classificar»");
}

// ══════════════════════════════════════════════════════════════════════
// B · A regra que dá nome ao ficheiro
// ══════════════════════════════════════════════════════════════════════
console.log("\nB · «Outros X» NUNCA é por classificar");
{
  for (const [n1, n2] of BALDES) {
    const r = resolveCategoria(src(n1, n2));
    check(
      !r.needsClassification,
      `${n2} → NÃO precisa de classificação`,
      `needsClassification=${r.needsClassification}`,
    );
    check(
      r.categoria === n1,
      `${n2} → conta como «${n1}»`,
      `veio "${r.categoria}"`,
    );
    check(
      r.categoria !== SEM_CLASSIFICACAO_LABEL && r.grupo !== SEM_CLASSIFICACAO_LABEL,
      `${n2} → nunca mostra o rótulo «${SEM_CLASSIFICACAO_LABEL}»`,
    );
  }

  // O nome do balde não é devolvido como se fosse um grupo real.
  const r = resolveCategoria(src("MEDICAMENTOS", "Outros Medicamentos"));
  check(
    r.grupo === "MEDICAMENTOS",
    "o grupo de um balde é a FAMÍLIA, não o nome do balde",
    `grupo="${r.grupo}"`,
  );

  // Falso positivo que a regra não pode apanhar: uma subcategoria real
  // cujo nome comece por "Outro…" sem ser um balde.
  const outrora = resolveCategoria(src("DERMOCOSMÉTICA", "Outrora Cosmética"));
  check(
    outrora.detalhe === "ESPECIFICO" && outrora.grupo === "Outrora Cosmética",
    "«Outrora Cosmética» é subcategoria a sério — a fronteira é a palavra inteira",
  );
}

// ══════════════════════════════════════════════════════════════════════
// C · O par dos relatórios
// ══════════════════════════════════════════════════════════════════════
console.log("\nC · resolverPar não devolve baldes como subcategoria");
{
  const p1 = resolverPar(src("DERMOCOSMÉTICA", "Rosto"));
  check(
    p1.categoria === "DERMOCOSMÉTICA" && p1.subcategoria === "Rosto",
    "subcategoria específica sai como está",
  );

  const p2 = resolverPar(src("DERMOCOSMÉTICA", "Outros Dermocosmética"));
  check(
    p2.categoria === "DERMOCOSMÉTICA" && p2.subcategoria === "",
    "balde → categoria certa, subcategoria VAZIA",
    JSON.stringify(p2),
  );
  check(p2.detalhe === "FAMILIA", "…e o detalhe diz porquê — não se confunde com ausência");

  const p3 = resolverPar(src(null, null));
  check(
    p3.categoria === SEM_CLASSIFICACAO_LABEL && p3.subcategoria === "" && p3.detalhe === "AUSENTE",
    "sem classificação → subcategoria vazia TAMBÉM, mas detalhe AUSENTE",
  );

  // As duas cadeias vazias significam coisas diferentes, e é `detalhe`
  // que as separa. Sem ele, um relatório não conseguia distinguir
  // "falta detalhe" de "falta tudo".
  check(
    p2.subcategoria === p3.subcategoria && p2.detalhe !== p3.detalhe,
    "duas subcategorias vazias, dois significados — só `detalhe` os separa",
  );
}

// ══════════════════════════════════════════════════════════════════════
// D · Agrupamento
// ══════════════════════════════════════════════════════════════════════
console.log("\nD · o balde colapsa na família ao agrupar");
{
  // É o que a vista "por grupo" do Inventário e das Margens faz: agrupa
  // por `grupo`. Antes, "Outros Medicamentos" era um grupo à parte — um
  // grupo que não é um grupo.
  const linhas = [
    resolveCategoria(src("MEDICAMENTOS", "Dor e febre")),
    resolveCategoria(src("MEDICAMENTOS", "Outros Medicamentos")),
    resolveCategoria(src("MEDICAMENTOS", null)),
    resolveCategoria(src("DERMOCOSMÉTICA", "Outros Dermocosmética")),
  ];
  const grupos = [...new Set(linhas.map((l) => l.grupo))].sort();
  check(
    grupos.length === 3 && grupos.includes("MEDICAMENTOS") && grupos.includes("Dor e febre"),
    "três grupos: «Dor e febre», «MEDICAMENTOS» e «DERMOCOSMÉTICA»",
    grupos.join(" | "),
  );
  check(
    !grupos.some((g) => /^outros/i.test(g)),
    "nenhum grupo se chama «Outros …» — deixaram de ser uma dimensão",
    grupos.join(" | "),
  );
}

// ══════════════════════════════════════════════════════════════════════
// E · As superfícies
// ══════════════════════════════════════════════════════════════════════
console.log("\nE · KPI, dropdowns e grelhas");
{
  const kpi = readFileSync("components/catalogo/catalogo-list-client.tsx", "utf8");
  for (const t of ["Classificados específicos", "Classificados na família", "Por classificar"]) {
    check(kpi.includes(t), `o KPI separa «${t}»`);
  }
  // A ordem importa para a leitura: detalhe decrescente.
  //
  // Procura os TÍTULOS DOS CARTÕES e não o texto solto: "Por classificar"
  // aparece antes, como opção do filtro de origem, e uma procura ingénua
  // media a posição da opção em vez da posição do cartão.
  const pos = (t: string) => kpi.indexOf(`titulo="${t}"`);
  const iEsp = pos("Classificados específicos");
  const iFam = pos("Classificados na família");
  const iPor = pos("Por classificar");
  check(
    iEsp >= 0 && iFam >= 0 && iPor >= 0 && iEsp < iFam && iFam < iPor,
    "…e por ordem de detalhe decrescente",
    `esp=${iEsp} fam=${iFam} por=${iPor}`,
  );

  const opts = readFileSync("lib/reporting-filter-options.ts", "utf8");
  check(
    /NOT:\s*\{\s*nome:\s*\{\s*startsWith:\s*"Outros "/.test(opts),
    "o dropdown de subcategoria dos relatórios não lista baldes",
  );

  // O catálogo admin CONTINUA a mostrá-los — é lá que a falta de
  // granularidade se vê e se corrige (ponto 5 da regra funcional).
  const cat = readFileSync("lib/catalogo-data.ts", "utf8");
  check(
    cat.includes(`ILIKE 'Outros %'`),
    "o catálogo admin continua a contar os baldes explicitamente",
  );

  const inv = readFileSync("components/inventario/inventario-client.tsx", "utf8");
  check(inv.includes("sem detalhe"), "o Inventário indica «sem detalhe» em vez do nome do balde");
  const mar = readFileSync("components/margens/margens-client.tsx", "utf8");
  check(mar.includes("sem detalhe"), "…e as Margens também");

  // O resolver é o ponto único: nenhum consumidor pode decidir por si
  // que "Outros" é ausência de classificação.
  const res = readFileSync("lib/categoria-resolver.ts", "utf8");
  check(
    res.includes('import { ehBalde }'),
    "o resolver usa a definição central de balde, não uma regex própria",
  );
}

// ══════════════════════════════════════════════════════════════════════
// F · O invariante que fecha o processo
// ══════════════════════════════════════════════════════════════════════
console.log("\nF · invariante");
{
  const casos: Array<[string | null, string | null, NivelDetalhe]> = [
    ["MEDICAMENTOS", "Dor e febre", "ESPECIFICO"],
    ["MEDICAMENTOS", "Outros Medicamentos", "FAMILIA"],
    ["MEDICAMENTOS", null, "FAMILIA"],
    [null, null, "AUSENTE"],
  ];
  for (const [n1, n2, esperado] of casos) {
    const r = resolveCategoria(src(n1, n2));
    check(r.detalhe === esperado, `(${n1 ?? "—"}, ${n2 ?? "—"}) → ${esperado}`, r.detalhe);
    // A equivalência que dá nome a tudo isto.
    check(
      r.needsClassification === (r.detalhe === "AUSENTE"),
      `…e «precisa de classificação» ⇔ AUSENTE`,
    );
  }
}

// ══════════════════════════════════════════════════════════════════════
console.log(`\n${ok} ok, ${ko} falhas`);
process.exit(ko === 0 ? 0 : 1);
