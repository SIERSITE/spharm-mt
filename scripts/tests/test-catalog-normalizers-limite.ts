/**
 * scripts/tests/test-catalog-normalizers-limite.ts
 *
 * Testa especificamente o limite de comprimento de
 * `normalizeFabricanteCanonico` (lib/catalog-normalizers.ts) — levantado
 * de 60 para 120 caracteres em 2026-09-22, depois de confirmar que
 * designações sociais completas reais (Ratiopharm, Pentafarma) excediam
 * os 60 e eram silenciosamente descartadas (normalizavam para `null`).
 * A base de dados nunca teve esse limite — `Fabricante.nomeNormalizado`
 * é `String` (TEXT) sem `@db.VarChar` no schema Prisma.
 *
 * Corre com: npx tsx scripts/tests/test-catalog-normalizers-limite.ts
 */
import { normalizeFabricanteCanonico } from "../../lib/catalog-normalizers";

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${label}`); }
  else { ko++; console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`); }
};

console.log("A · designações sociais reais longas (60–120 chars) já não são descartadas");
{
  const casos: Array<{ nome: string; entrada: string }> = [
    { nome: "Ratiopharm", entrada: "Ratiopharm - Comércio E Indústria De Produtos Farmacêuticos Lda" },
    { nome: "Pentafarma Genéricos", entrada: "Pentafarma Genéricos - Sociedade Técnico Medicinal, Unipessoal Lda." },
    { nome: "Expanscience", entrada: "Laboratoires Expanscience" },
    { nome: "Sigma-Tau (exactamente 60)", entrada: "Sigma-Tau Industrie Farmaceutiche Riunite Societa Per Azioni" },
  ];
  for (const c of casos) {
    const r = normalizeFabricanteCanonico(c.entrada);
    check(r !== null, `A.${c.nome}: normaliza (não é descartado)`, `entrada="${c.entrada}"`);
  }
}

console.log("\nB · o limite superior é 120, não infinito — continua a rejeitar strings absurdamente longas");
{
  const gigante = "A".repeat(121);
  const r = normalizeFabricanteCanonico(gigante);
  check(r === null, "B1: 121 caracteres é rejeitado (provavelmente erro de leitura de coluna, não um nome real)");

  const exatos120 = "A".repeat(120);
  const r2 = normalizeFabricanteCanonico(exatos120);
  check(r2 !== null && r2.length === 120, "B2: exactamente 120 caracteres é aceite (limite inclusivo)");
}

console.log("\nC · comportamento inalterado nos extremos que já estavam correctos antes");
{
  check(normalizeFabricanteCanonico("") === null, "C1: string vazia continua null");
  check(normalizeFabricanteCanonico(null) === null, "C2: null continua null");
  check(normalizeFabricanteCanonico("A") === null, "C3: 1 carácter continua rejeitado (mínimo 2)");
  check(normalizeFabricanteCanonico("Bayer Portugal, Lda.") === "BAYER PORTUGAL LDA", "C4: normalização de um nome curto comum continua idêntica");
}

console.log(`\n${ok} ok, ${ko} falhas`);
process.exit(ko === 0 ? 0 : 1);
