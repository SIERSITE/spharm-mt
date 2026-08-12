/**
 * scripts/tests/test-compras-qualidade.ts
 *
 * Fixa a classificação de qualidade dos documentos de compra e a regra
 * que a motivou.
 *
 * O caso real: recepção 58865 da Silveirense. O header diz 46,13 €; as
 * linhas que restam somam muito menos, e as que faltam não existem em
 * tabela nenhuma do ERP (provado pelo agent rev56, `--rec-deep`). Dividir
 * 46,13 € pela quantidade sobrevivente atribuiria a produtos conhecidos o
 * custo de produtos que desapareceram — e esse número alimentaria o
 * `ultimoPrecoCompra`, que é o custo que a plataforma mostra.
 *
 * Uso: npx tsx scripts/tests/test-compras-qualidade.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  QUALIDADE,
  TOLERANCIA_ABS_EUR,
  TOLERANCIA_REL,
  classificarDocumento,
  podeAlimentarCusto,
  tolerancia,
} from "../../lib/compras/qualidade";

let pass = 0;
let fail = 0;
const eq = (l: string, obtido: unknown, esperado: unknown) => {
  if (obtido === esperado) { pass++; console.log(`  [OK]    ${l}`); }
  else { fail++; console.log(`  [FALHA] ${l}: obtido "${String(obtido)}", esperado "${String(esperado)}"`); }
};
const ok = (l: string, c: boolean) => eq(l, c, true);

const doc = (totalDocumentoEur: number, valorExplicadoEur: number, nLinhas = 3) =>
  classificarDocumento({ totalDocumentoEur, valorExplicadoEur, nLinhas });

console.log("=== reconciliado ===");
eq("exacto", doc(100, 100), QUALIDADE.RECONCILIADA);
eq("um cêntimo de arredondamento", doc(100, 100.01), QUALIDADE.RECONCILIADA);
// Num documento pequeno é a tolerância ABSOLUTA que manda: a relativa
// (0,1% de 10 € = 1 cêntimo) seria mais apertada que o arredondamento.
eq("10 €, na tolerância absoluta", doc(10, 10 + TOLERANCIA_ABS_EUR), QUALIDADE.RECONCILIADA);
eq("10 €, acima da absoluta", doc(10, 10 + TOLERANCIA_ABS_EUR + 0.001), QUALIDADE.DETALHE_INCOMPLETO);
// A 100 € já é a relativa que manda (0,10 € > 0,02 €). Esta asserção
// existe porque a primeira versão do teste assumiu o contrário.
eq("100 €, dentro da relativa", doc(100, 100.09), QUALIDADE.RECONCILIADA);
eq("100 €, acima da relativa", doc(100, 100.2), QUALIDADE.DETALHE_INCOMPLETO);

console.log("\n=== documentos grandes: a tolerância relativa evita falsos positivos ===");
// 20 000 € com 10 € de diferença é 0,05% — arredondamento acumulado numa
// factura de centenas de linhas, não detalhe em falta.
eq("20 000 € com 10 € de diferença", doc(20000, 20010), QUALIDADE.RECONCILIADA);
eq("20 000 € com 30 € de diferença", doc(20000, 20030), QUALIDADE.DETALHE_INCOMPLETO);
eq("tolerância cresce com o documento", tolerancia(20000), 20000 * TOLERANCIA_REL);
eq("mas nunca abaixo da absoluta", tolerancia(1), TOLERANCIA_ABS_EUR);

console.log("\n=== o caso 58865: linhas a menos ===");
eq("soma muito abaixo do documento", doc(46.13, 12.5), QUALIDADE.DETALHE_INCOMPLETO);
// O sentido oposto conta na mesma: desconto não aplicado às linhas é
// tão "não explicado" como linhas em falta.
eq("soma acima do documento", doc(203.41, 275.83), QUALIDADE.DETALHE_INCOMPLETO);

console.log("\n=== não financeiro (ex.: tipo 38, G/Transferência) ===");
eq("total zero com linhas", doc(0, 150), QUALIDADE.NAO_FINANCEIRO);
eq("total zero e linhas a zero", doc(0, 0), QUALIDADE.NAO_FINANCEIRO);

console.log("\n=== sem linhas ===");
eq("documento sem detalhe", classificarDocumento({ totalDocumentoEur: 50, valorExplicadoEur: 0, nLinhas: 0 }), QUALIDADE.SEM_LINHAS);

console.log("\n=== só uma classe alimenta custo ===");
ok("RECONCILIADA alimenta", podeAlimentarCusto(QUALIDADE.RECONCILIADA));
ok("DETALHE_INCOMPLETO não alimenta", !podeAlimentarCusto(QUALIDADE.DETALHE_INCOMPLETO));
ok("NAO_FINANCEIRO não alimenta", !podeAlimentarCusto(QUALIDADE.NAO_FINANCEIRO));
ok("SEM_LINHAS não alimenta", !podeAlimentarCusto(QUALIDADE.SEM_LINHAS));
// Linhas agregadas antes desta classificação: estado desconhecido.
ok("null não alimenta", !podeAlimentarCusto(null));

console.log("\n=== a regra proibida continua proibida ===");
const agregacao = readFileSync(path.join(process.cwd(), "lib/aggregate/compras.ts"), "utf8");
// Ratear seria dividir um total do HEADER pela quantidade das linhas.
// Enquanto o valorTotal sair de SUM(quantidade × valorEurUnit), não há
// rateio — e é isto que falha se alguém "corrigir" o total com o header.
ok(
  "valorTotal continua a sair das linhas",
  /SUM\(s\."quantidade" \* s\."valorEurUnit"\)/.test(agregacao),
);
ok(
  "nenhum total do header é dividido por quantidade",
  !/headerTotal\w+\s*[\s\S]{0,80}\/\s*SUM\(s\."quantidade"\)/.test(agregacao),
);
ok(
  "Compra não recebe totais documentais",
  !/"valorDocumento"|"totalDocumentoEur"\s*=\s*EXCLUDED/.test(
    agregacao.slice(agregacao.indexOf('INSERT INTO "Compra"')),
  ),
);

console.log("\n=== o SQL da agregação usa os mesmos limiares ===");
// A classificação está duplicada — TypeScript aqui, SQL na agregação —
// por causa da escala. Esta asserção é o que impede as duas leituras de
// divergirem em silêncio.
ok("SQL injecta TOLERANCIA_ABS_EUR", agregacao.includes("TOLERANCIA_ABS_EUR"));
ok("SQL injecta TOLERANCIA_REL", agregacao.includes("TOLERANCIA_REL"));
ok("SQL usa GREATEST(absoluta, relativa)", /GREATEST\(\$\{TOLERANCIA_ABS_EUR\}/.test(agregacao));
ok("SQL classifica por valor e não por tipo documental",
   !/externalTipoDocumentoId[\s\S]{0,120}(RECONCILIADA|DETALHE_INCOMPLETO)/.test(agregacao));

console.log("\n=== o consumidor de custo filtra ===");
const ipf = readFileSync(path.join(process.cwd(), "lib/operational/ipf-populate.ts"), "utf8");
ok("ipf-populate exige custoFiavel", /c\."custoFiavel" IS TRUE/.test(ipf));

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail === 0 ? 0 : 1);
