/**
 * scripts/tests/test-similaridade-nomes-fabricante.ts
 *
 * Testa lib/catalog/similaridade-nomes-fabricante.ts — o motor de
 * correspondência textual aproximada, GERAL (sem nenhuma entidade
 * concreta no algoritmo). Inclui, como casos de REGRESSÃO, os nomes
 * reais exactos da consulta à Garantia que expôs a falta disto
 * (Ferring, 6 linhas; Labialfarma, 2 linhas) — mas a maioria dos testes
 * usa nomes sintéticos, para provar que a regra é geral.
 *
 * Corre com: npx tsx scripts/tests/test-similaridade-nomes-fabricante.ts
 */
import { tokenizarNomeFabricante, tokensEquivalentes, calcularSimilaridadeNomes } from "../../lib/catalog/similaridade-nomes-fabricante";
import { normalizarTitularAimGarantia } from "../../lib/catalog/fabricante-normalizacao-garantia";

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${label}`); }
  else { ko++; console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`); }
};

function norm(s: string): string {
  return normalizarTitularAimGarantia(s)!;
}

console.log("A · tokenizarNomeFabricante — hífen e & são separadores, nunca parte de uma palavra");
{
  check(JSON.stringify(tokenizarNomeFabricante("FERRING PORTUG - P F SOC UN")) === JSON.stringify(["FERRING", "PORTUG", "P", "F", "SOC", "UN"]), "A1: hífen entre espaços desaparece como separador");
  check(JSON.stringify(tokenizarNomeFabricante("JOHNSON & JOHNSON")) === JSON.stringify(["JOHNSON", "JOHNSON"]), "A2: & é separador, nunca token");
  check(JSON.stringify(tokenizarNomeFabricante("A-B-C LDA")) === JSON.stringify(["A", "B", "C", "LDA"]), "A3: hífens consecutivos sem espaço também separam");
}

console.log("\nB · tokensEquivalentes — abreviatura por prefixo (genérico, sem lista de palavras)");
{
  check(tokensEquivalentes("PORTUG", "PORTUGUESA"), "B1: PORTUG~PORTUGUESA (prefixo, >=2 chars)");
  check(tokensEquivalentes("PROD", "PRODUTOS"), "B2: PROD~PRODUTOS");
  check(tokensEquivalentes("FARM", "FARMACEUTICOS"), "B3: FARM~FARMACEUTICOS");
  check(tokensEquivalentes("UN", "UNIPESSOAL"), "B4: UN~UNIPESSOAL (limiar exacto, 2 chars)");
  check(tokensEquivalentes("SOC", "SOCIEDADE"), "B5: SOC~SOCIEDADE");
  check(!tokensEquivalentes("P", "PRODUTOS"), "B6: 1 char nunca conta como abreviatura por PREFIXO (só por iniciais, ver contarParesCasados)");
  check(tokensEquivalentes("FARM", "FARMACIA"), "B7: a regra é puramente textual (prefixo), não semântica — FARM É prefixo literal de FARMACIA; o falso positivo ocasional é aceitável e mitigado pelo limiar agregado sobre TODOS os tokens do nome");
  check(!tokensEquivalentes("LDA", "SA"), "B8: palavras sem relação de prefixo nunca são equivalentes");
  check(!tokensEquivalentes("A", "AB"), "B9: 1 char nunca conta, mesmo sendo prefixo literal (A de AB)");
}

console.log("\nC · calcularSimilaridadeNomes — casos SINTÉTICOS (a regra é geral, não específica de nenhuma entidade)");
{
  check(calcularSimilaridadeNomes("ACME PORTUGUESA LDA", "ACME PORTUG LDA") >= 0.6, "C1: abreviatura simples de um nome fictício — pontuação alta");
  check(calcularSimilaridadeNomes("ACME PORTUGUESA LDA", "BETA PORTUGUESA LDA") === 0, "C2: marca diferente (ACME vs BETA) — pontuação ZERO (porta de entrada do primeiro token), mesmo partilhando PORTUGUESA/LDA");
  check(calcularSimilaridadeNomes("XPTO INDUSTRIA FARMACEUTICA SA", "XPTO IND FARM SA") >= 0.6, "C3: várias abreviaturas simultâneas do mesmo nome fictício");
  check(calcularSimilaridadeNomes("NOME COMPLETAMENTE DIFERENTE LDA", "OUTRO NOME QUALQUER SA") < 0.4, "C4: nomes genuinamente distintos — pontuação baixa");
  check(calcularSimilaridadeNomes("QUALQUER LDA", "QUALQUER LDA") === 1, "C5: nomes idênticos — pontuação máxima");
  check(calcularSimilaridadeNomes("", "QUALQUER LDA") === 0, "C6: string vazia nunca produz divisão por zero nem falso positivo");
}

console.log("\nD · REGRESSÃO — os nomes REAIS exactos da consulta à Garantia (Ferring, 6 linhas)");
{
  const titularReal = norm("Ferring Portuguesa-Prod Farm, Soc.Unipessoal L.da");
  const fPharmA = norm("FERRING PHARMACEUTICALS A S");
  const fPortug1 = norm("FERRING PORTUG - P F SOC UN"); // 0 produtos
  const fPortug2 = norm("FERRING PORTUG. - P.F. SOC. UN"); // 5 produtos
  const fPortugCompleto = norm("FERRING PORTUGUESA - PRODUTOS FARMACEUTICOS SOCIE"); // 1 produto, truncado a "SOCIE"
  const fSAU1 = norm("FERRING S A U"); // 0 produtos
  const fSAU2 = norm("FERRING S.A.U."); // 6 produtos

  const sPharmA = calcularSimilaridadeNomes(titularReal, fPharmA);
  const sPortug1 = calcularSimilaridadeNomes(titularReal, fPortug1);
  const sPortug2 = calcularSimilaridadeNomes(titularReal, fPortug2);
  const sPortugCompleto = calcularSimilaridadeNomes(titularReal, fPortugCompleto);
  const sSAU1 = calcularSimilaridadeNomes(titularReal, fSAU1);
  const sSAU2 = calcularSimilaridadeNomes(titularReal, fSAU2);

  check(sPharmA < 0.4, "D1: Ferring Pharmaceuticals A/S (entidade dinamarquesa) — pontuação BAIXA, nunca fundida com a portuguesa", `score=${sPharmA}`);
  check(sSAU1 < 0.4 && sSAU2 < 0.4, "D2: Ferring S.A.U. (entidade espanhola) — pontuação BAIXA nas duas grafias, nunca fundida com a portuguesa", `sSAU1=${sSAU1} sSAU2=${sSAU2}`);
  check(sPortug2 >= 0.6, "D3: 'FERRING PORTUG. - P.F. SOC. UN' (5 produtos, iniciais P/F) — pontuação FORTE via o passo de iniciais", `score=${sPortug2}`);
  check(sPortugCompleto >= 0.6, "D4: 'FERRING PORTUGUESA - PRODUTOS FARMACEUTICOS SOCIE' (1 produto, truncado) — pontuação FORTE, a que o relatório anterior omitiu indevidamente", `score=${sPortugCompleto}`);
  check(sPortug1 < sPortug2 + 0.01, "D5: a variante SEM produtos não pontua mais alto que a variante COM 5 produtos (mesmo texto, pontuação idêntica é aceitável — o desempate é por evidência, não por esta função)", `sPortug1=${sPortug1} sPortug2=${sPortug2}`);
  check(sPharmA < sPortug2 && sSAU2 < sPortug2, "D6: as duas variantes portuguesas pontuam claramente acima das duas entidades estrangeiras", `sPharmA=${sPharmA} sSAU2=${sSAU2} sPortug2=${sPortug2}`);
}

console.log("\nE · REGRESSÃO — Labialfarma (2 linhas reais)");
{
  const titularReal = norm("LABIALFARMA - LABORATORIO DE PRODUTOS FARMACEUTICOS E NUTRACEUTICOS SA");
  const cand1 = norm("LABIALFARMA-PROD FARM NUT LDA");
  const cand2 = norm("LABIALFARMA-PROD FARM. NUT LDA");
  const s1 = calcularSimilaridadeNomes(titularReal, cand1);
  const s2 = calcularSimilaridadeNomes(titularReal, cand2);
  check(s1 >= 0.5, "E1: 'LABIALFARMA-PROD FARM NUT LDA' pontua alto contra o titular real (LABORATORIO~?, PRODUTOS~PROD, FARMACEUTICOS~FARM)", `score=${s1}`);
  check(s2 >= 0.5, "E2: a variante com ponto (FARM.) pontua igual", `score=${s2}`);
  // As duas linhas Labialfarma são LDA (forma jurídica antiga); o titular
  // real é SA — sinal explícito de possível transformação jurídica, que
  // o resolver trata como bloqueio para revisão (nunca decide sozinho
  // Lda→SA), documentado no ficheiro que usa este módulo.
  check(calcularSimilaridadeNomes(cand1, cand2) >= 0.9, "E3: as duas linhas Labialfarma são, entre si, quase idênticas (mesma entidade, grafia mínima diferente)", `score=${calcularSimilaridadeNomes(cand1, cand2)}`);
}

console.log("\nF · Expomedica/Inserpor — confirma que, SEM nenhuma linha equivalente real, a pontuação fica sempre baixa contra nomes não relacionados (nunca inventa uma correspondência)");
{
  const titularExpomedica = norm("EXPOMEDICA - SOCIEDADE EXPORTADORA E IMPORTADORA DE MATERIAL MEDICO LDA");
  const naoRelacionados = ["BAYER PORTUGAL LDA", "SANDOZ FARMACEUTICA LDA", "TEVA PHARMA PRODUTOS FARMACEUTICOS LDA"].map(norm);
  for (const n of naoRelacionados) {
    check(calcularSimilaridadeNomes(titularExpomedica, n) < 0.3, `F1: Expomedica vs "${n}" — pontuação baixa`, `score=${calcularSimilaridadeNomes(titularExpomedica, n)}`);
  }
}

console.log("\nG · limiares de decisão usados por resolver-fabricante-por-cnp.ts (0.6 forte / 0.4 relevante) — confirma que os casos reais caem nas bandas certas");
{
  const titularFerring = norm("Ferring Portuguesa-Prod Farm, Soc.Unipessoal L.da");
  const sIniciais = calcularSimilaridadeNomes(titularFerring, norm("FERRING PORTUG. - P.F. SOC. UN"));
  const sTruncado = calcularSimilaridadeNomes(titularFerring, norm("FERRING PORTUGUESA - PRODUTOS FARMACEUTICOS SOCIE"));
  check(sIniciais >= 0.6, "G1: variante com iniciais P/F (5 produtos reais) cai na banda FORTE (>=0.6)", `score=${sIniciais}`);
  check(sTruncado >= 0.6, "G2: variante truncada a 'SOCIE' (1 produto real) cai na banda FORTE (>=0.6) — 'L.da' com ponto interno parte em dois tokens ('L','DA') na normalização partilhada, por isso o limiar não pode ser mais alto que isto", `score=${sTruncado}`);

  const titularLabialfarma = norm("LABIALFARMA - LABORATORIO DE PRODUTOS FARMACEUTICOS E NUTRACEUTICOS SA");
  const sLabial = calcularSimilaridadeNomes(titularLabialfarma, norm("LABIALFARMA-PROD FARM NUT LDA"));
  check(sLabial >= 0.4 && sLabial < 0.6, "G3: Labialfarma cai na banda FRACA/relevante (0.4-0.6) — sinal real de que É provavelmente a mesma entidade, mas insuficiente para associar sozinho sem decisão explícita sobre Lda→SA", `score=${sLabial}`);

  const sAcmeBeta = calcularSimilaridadeNomes(norm("ACME PORTUGUESA LDA"), norm("BETA PORTUGUESA LDA"));
  check(sAcmeBeta < 0.4, "G4: ACME vs BETA fica abaixo do limiar relevante — nunca é sequer reportado como candidato");
}

console.log(`\n${ok} ok, ${ko} falhas`);
process.exit(ko === 0 ? 0 : 1);
