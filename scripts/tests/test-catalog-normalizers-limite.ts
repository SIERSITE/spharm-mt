/**
 * scripts/tests/test-catalog-normalizers-limite.ts
 *
 * Em 2026-09-22 o limite de `normalizeFabricanteCanonico` foi levantado
 * de 60 para 120 chars, depois revertido no dia seguinte: essa função é
 * a identidade de `Fabricante` partilhada por TODOS os tenants e fluxos
 * (ingest ERP, upsert, correcções regulatórias) — alterá-la arriscava
 * mudar silenciosamente o comportamento de ingestão fora de garantia.
 *
 * Este teste prova as DUAS metades da correcção:
 *   A. `normalizeFabricanteCanonico` está de volta a 60 — comportamento
 *      histórico, exactamente como antes de qualquer alteração.
 *   B. O problema original (designações sociais completas como
 *      "Ratiopharm - Comércio E Indústria De Produtos Farmacêuticos Lda",
 *      63 chars canónicos, sendo rejeitadas na configuração de grupos
 *      laboratoriais) continua resolvido — mas agora por uma função
 *      NOVA e ISOLADA, `normalizeGrupoLaboratorialAlias`
 *      (lib/catalog/grupo-laboratorial-normalizers.ts), que a função
 *      global nunca importa nem é importada por ela.
 *
 * Corre com: npx tsx scripts/tests/test-catalog-normalizers-limite.ts
 */
import { normalizeFabricanteCanonico } from "../../lib/catalog-normalizers";
import {
  normalizeGrupoLaboratorialCanonico,
  normalizeGrupoLaboratorialAlias,
  compararNomesTolerandoComprimento,
} from "../../lib/catalog/grupo-laboratorial-normalizers";

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${label}`); }
  else { ko++; console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`); }
};

console.log("A · normalizeFabricanteCanonico está DE VOLTA a 60 — comportamento global inalterado, todos os tenants");
{
  const ratiopharm = "Ratiopharm - Comércio E Indústria De Produtos Farmacêuticos Lda";
  const pentafarmaGenericos = "Pentafarma Genéricos - Sociedade Técnico Medicinal, Unipessoal Lda.";

  check(normalizeFabricanteCanonico(ratiopharm) === null, "A1: Ratiopharm (63 chars canónicos) é REJEITADO por normalizeFabricanteCanonico — comportamento histórico restaurado");
  check(normalizeFabricanteCanonico(pentafarmaGenericos) === null, "A2: Pentafarma Genéricos (65 chars canónicos) também é rejeitado");

  const exatos60 = "A".repeat(60);
  const excede60 = "A".repeat(61);
  check(normalizeFabricanteCanonico(exatos60) !== null, "A3: exactamente 60 caracteres continua aceite (limite inclusivo, inalterado)");
  check(normalizeFabricanteCanonico(excede60) === null, "A4: 61 caracteres continua rejeitado — o limite É 60, não 120");

  check(normalizeFabricanteCanonico("") === null, "A5: string vazia continua null");
  check(normalizeFabricanteCanonico(null) === null, "A6: null continua null");
  check(normalizeFabricanteCanonico("A") === null, "A7: 1 carácter continua rejeitado (mínimo 2)");
  check(normalizeFabricanteCanonico("Bayer Portugal, Lda.") === "BAYER PORTUGAL LDA", "A8: normalização de um nome curto comum é idêntica à de sempre");
}

console.log("\nB · normalizeGrupoLaboratorialCanonico/Alias (função NOVA, ISOLADA) aceitam os mesmos nomes longos até 120 — só usadas pelo pipeline de grupos");
{
  const casos: Array<{ nome: string; entrada: string }> = [
    { nome: "Ratiopharm", entrada: "Ratiopharm - Comércio E Indústria De Produtos Farmacêuticos Lda" },
    { nome: "Pentafarma Genéricos", entrada: "Pentafarma Genéricos - Sociedade Técnico Medicinal, Unipessoal Lda." },
    { nome: "Expanscience", entrada: "Laboratoires Expanscience" },
    { nome: "Sigma-Tau (exactamente 60)", entrada: "Sigma-Tau Industrie Farmaceutiche Riunite Societa Per Azioni" },
  ];
  for (const c of casos) {
    check(normalizeGrupoLaboratorialAlias(c.entrada) !== null, `B.alias.${c.nome}: normalizeGrupoLaboratorialAlias aceita (não descarta)`, `entrada="${c.entrada}"`);
    check(normalizeGrupoLaboratorialCanonico(c.entrada) !== null, `B.canonico.${c.nome}: normalizeGrupoLaboratorialCanonico aceita também`, `entrada="${c.entrada}"`);
  }

  const gigante = "A".repeat(121);
  check(normalizeGrupoLaboratorialAlias(gigante) === null, "B1: 121 caracteres continua rejeitado (limite é 120, não infinito)");
  const exatos120 = "A".repeat(120);
  const r120 = normalizeGrupoLaboratorialAlias(exatos120);
  check(r120 !== null && r120.length === 120, "B2: exactamente 120 caracteres é aceite (limite inclusivo)");
}

console.log("\nC · isolamento: as duas famílias de funções produzem o MESMO resultado para strings curtas (o algoritmo de limpeza é idêntico, só o limite muda) — nunca divergem em conteúdo");
{
  const casosCurtos = ["Bayer Portugal, Lda.", "MYLAN", "Viatris Healthcare, Lda.", "Ratiopharm Gmbh"];
  for (const s of casosCurtos) {
    check(
      normalizeFabricanteCanonico(s) === normalizeGrupoLaboratorialAlias(s),
      `C.${s}: mesmo resultado nas duas funções para uma string curta`,
      `global="${normalizeFabricanteCanonico(s)}" grupo="${normalizeGrupoLaboratorialAlias(s)}"`,
    );
  }
}

console.log("\nD · compararNomesTolerandoComprimento — usada só para SUGERIR candidatos, nunca para associação automática");
{
  check(
    // Formas JÁ canonicalizadas (maiúsculas, hífens já colapsados a espaço
    // pelo normalizador real) — é assim que esta função recebe os dois
    // lados na prática, nunca texto cru com pontuação original.
    compararNomesTolerandoComprimento("TECNIMEDE SOCIEDADE TECNICO MEDICINAL", "TECNIMEDE SOCIEDADE TECNICO MEDICINAL S A") === true,
    "D1: um nome curto que é PREFIXO exacto do nome completo é reconhecido",
  );
  check(compararNomesTolerandoComprimento("TECNIMEDE", "TEVA PHARMA") === false, "D2: nomes sem relação de prefixo não batem");
  check(compararNomesTolerandoComprimento(null, "TEVA") === false, "D3: null nunca bate com nada");
  check(compararNomesTolerandoComprimento("TEVA", "TEVA") === true, "D4: igualdade exacta continua a bater");
}

console.log(`\n${ok} ok, ${ko} falhas`);
process.exit(ko === 0 ? 0 : 1);
