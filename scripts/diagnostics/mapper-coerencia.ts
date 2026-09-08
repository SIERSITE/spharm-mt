/**
 * scripts/diagnostics/mapper-coerencia.ts
 *
 * O equivalente operacional de `npm run test:mapper-porta-de-entrada`,
 * para correr DENTRO da imagem, onde `scripts/tests/` não existe.
 *
 * ── Porque é um diagnóstico e não um teste na imagem ─────────────────
 *
 * O Dockerfile do estágio `migrator` copia «só o que as migrations e os
 * comandos operacionais tocam», sub-directório a sub-directório, e tem um
 * `RUN audit-tools-entrypoints.mjs` que impõe essa lista. Um teste
 * unitário não é um comando operacional, e pôr `scripts/tests/` lá dentro
 * — 60 e tal ficheiros de desenvolvimento — contradiria a regra que
 * mantém a imagem auditável.
 *
 * `scripts/diagnostics/` já entra inteiro, e é a via documentada para
 * medir coisas dentro do container. Este ficheiro usa-a.
 *
 * ── A tabela de casos é a MESMA do teste ─────────────────────────────
 *
 * Vive em `lib/catalog/mapper-coerencia.ts`, que também já está na
 * imagem. Duas listas divergiriam, e a primeira a divergir seria esta —
 * a que ninguém corre todos os dias.
 *
 * ── O que valida, e o que não valida ─────────────────────────────────
 *
 * O mapper é PURO: sem base, sem rede, sem ambiente. Portanto isto prova
 * que o CÓDIGO desta imagem é coerente — não prova nada sobre os dados.
 * Para saber se a imagem traz a revisão certa, a resposta directa é o
 * `APP_REVISION` que ela carimba.
 *
 * READ-ONLY por construção: não abre uma ligação à base.
 *
 * Sai com 1 se alguma designação der resultados diferentes conforme a
 * porta — para poder ser usado numa verificação pós-deploy.
 *
 * Uso:
 *   npm run diag:mapper-coerencia
 */
import { verificarCoerenciaDoMapper } from "../../lib/catalog/mapper-coerencia";

const linha = (s = "") => console.log(s);

function main(): void {
  linha("SPharm.MT · coerência do mapper de taxonomia · READ-ONLY");
  linha(`  revisão da imagem: ${process.env.APP_REVISION ?? "(não carimbada)"}`);
  linha("═".repeat(88));
  linha("  A mesma designação tem de dar a mesma classificação em todas as portas.");
  linha("  Sem base de dados: isto mede o código desta imagem, não os dados.");
  linha("═".repeat(88));

  const { ok, resultados } = verificarCoerenciaDoMapper();
  let maus = 0;

  for (const r of resultados) {
    const bem = r.distintos === 1 && r.correcto;
    if (!bem) maus++;
    linha("");
    linha(`  ${bem ? "OK  " : "FALHA"}  ${r.designacao}`);
    if (bem) {
      linha(`         ${r.esperado}`);
      continue;
    }
    // Só se detalha o que falhou: uma lista de 11 casos todos certos não
    // precisa de 44 linhas para o dizer.
    for (const p of r.porPorta) {
      const marca = p.valor === r.esperado ? " " : "!";
      linha(`       ${marca} ${p.porta.padEnd(34)} ${p.valor}`);
    }
    linha(`         esperado: ${r.esperado}`);
  }

  linha("");
  linha("═".repeat(88));
  if (ok) {
    linha(`  ${resultados.length} designações, todas com um único resultado nas 4 portas.`);
  } else {
    linha(`  ${maus} de ${resultados.length} designações INCOERENTES.`);
    linha("");
    linha("  O mapper desta imagem depende da porta de entrada. Ver o histórico");
    linha("  de lib/catalog-taxonomy-map.ts — um token de curativo em dois N1,");
    linha("  ou uma regra genérica à frente de uma específica na rota plana.");
  }
  process.exit(ok ? 0 : 1);
}

main();
