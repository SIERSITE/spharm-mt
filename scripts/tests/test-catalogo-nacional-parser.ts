/**
 * scripts/tests/test-catalogo-nacional-parser.ts
 *
 * Testa lib/catalog/catalogo-nacional-parser.ts com amostras sintéticas
 * MÍNIMAS — nunca toca no ficheiro real de .local-data (que nem pode ser
 * commitado). As amostras aqui reproduzem, à mão, os padrões confirmados
 * na análise do ficheiro real: registo de uma linha, registo partido em
 * duas linhas com separador em branco a seguir, registo partido a meio
 * de uma palavra (`*FIML*` cortado em `*F` + `IML*`), e um EOF sem
 * marcador de fecho.
 *
 * Corre com: npx tsx scripts/tests/test-catalogo-nacional-parser.ts
 */
import { Readable } from "node:stream";
import { lerCatalogoNacional, ehEstadoAtual, MARCADOR_FIM_REGISTO } from "../../lib/catalog/catalogo-nacional-parser";

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${label}`); }
  else { ko++; console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`); }
};
const eq = <T,>(a: T, b: T, label: string) =>
  check(JSON.stringify(a) === JSON.stringify(b), label, `esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);

/** Constrói uma linha "física" de exactamente 200 caracteres, como o ficheiro real. */
function linha200(conteudo: string): string {
  if (conteudo.length > 200) throw new Error(`conteúdo de teste excede 200 chars: ${conteudo.length}`);
  return conteudo.padEnd(200, " ");
}

function campos(cnp: string, resto: string[]): string {
  return [cnp, ...resto].join("(;)");
}

async function coletar(linhas: string[]) {
  const input = Readable.from(linhas.map((l) => l + "\r\n"));
  const registos = [];
  const erros = [];
  for await (const evento of lerCatalogoNacional(input)) {
    if (evento.tipo === "registo") registos.push(evento.registo);
    else erros.push(evento.erro);
  }
  return { registos, erros };
}

async function principal() {
  console.log("A · registo de uma única linha física");
  {
    const linha = linha200(campos("2000099", ["9999.99", "6", "8309", "21", "2", "01-JUN-99", "14-MAY-20", "3960", "Revogado", "N", "Aspirina, 100 mg x 30 comp", "Bayer Portugal, Lda.", MARCADOR_FIM_REGISTO]));
    const { registos, erros } = await coletar([linha]);
    eq(erros.length, 0, "A1: sem erros");
    eq(registos.length, 1, "A2: um registo reconstruído");
    eq(registos[0]?.cnp, 2000099, "A3: cnp correcto");
    eq(registos[0]?.estado, "Revogado", "A4: estado (campo 9) correcto");
    eq(registos[0]?.designacao, "Aspirina, 100 mg x 30 comp", "A5: designação (campo 11) correcta");
    eq(registos[0]?.titular, "Bayer Portugal, Lda.", "A6: titular (campo 12) correcto");
  }

  console.log("\nB · registo partido em duas linhas físicas, com separador em branco a seguir");
  {
    const completo = campos("2047280", ["107.08", "6", "2953", "18", "2", "29-MAR-99", "02-JAN-26", "2678", "Autorizado", "S", "Decapeptyl , 3.75 mg/2 ml Frasco para injetáveis 2 ml Po+veic susp inj", "Ipsen Portugal - Produtos Farmaceuticos S.A.", MARCADOR_FIM_REGISTO]);
    const l1 = completo.slice(0, 200);
    const l2raw = completo.slice(200);
    const l2 = linha200(l2raw);
    const separador = linha200("");
    const { registos, erros } = await coletar([l1, l2, separador]);
    eq(erros.length, 0, "B1: sem erros");
    eq(registos.length, 1, "B2: um único registo reconstruído a partir de 2 linhas físicas");
    eq(registos[0]?.cnp, 2047280, "B3: cnp correcto");
    eq(registos[0]?.titular, "Ipsen Portugal - Produtos Farmaceuticos S.A.", "B4: titular reconstruído correctamente através do corte");
  }

  console.log("\nC · marcador *FIML* cortado a meio (*F + IML*) — o caso real mais extremo observado");
  {
    const completo = campos("2024099", ["9999.99", "6", "59", "", "", "28-AUG-19", "23-JUN-21", "249878", "Revogado", "N", "Salax , 1280 mg + 1140 mg + 60 mg Recipiente para comprimidos 10 Unidade(s) Comp eferv", "Bial - Portela & Ca S.A", MARCADOR_FIM_REGISTO]);
    const l1 = completo.slice(0, 200);
    const l2 = linha200(completo.slice(200));
    check(l1.endsWith("*F"), "C0 (pré-condição do teste): a linha 1 corta mesmo o marcador a meio");
    const separador = linha200("");
    const { registos, erros } = await coletar([l1, l2, separador]);
    eq(erros.length, 0, "C1: sem erros mesmo com o marcador cortado a meio");
    eq(registos.length, 1, "C2: um registo reconstruído");
    eq(registos[0]?.titular, "Bial - Portela & Ca S.A", "C3: titular correcto");
  }

  console.log("\nD · vários registos de uma linha seguidos, SEM separador em branco entre eles");
  {
    const l1 = linha200(campos("2000099", ["9999.99", "6", "8309", "21", "2", "01-JUN-99", "14-MAY-20", "3960", "Revogado", "N", "Aspirina", "Bayer Portugal, Lda.", MARCADOR_FIM_REGISTO]));
    const l2 = linha200(campos("2000396", ["9999.99", "6", "108", "18", "1", "11-JUL-99", "05-APR-21", "4641", "Revogado", "N", "Acnederma", "Confar Lda", MARCADOR_FIM_REGISTO]));
    const { registos, erros } = await coletar([l1, l2]);
    eq(erros.length, 0, "D1: sem erros");
    eq(registos.length, 2, "D2: dois registos distintos, mesmo sem separador entre eles");
    eq(registos.map((r) => r.cnp), [2000099, 2000396], "D3: cnps correctos, pela ordem certa");
  }

  console.log("\nE · nº de campos errado (não 14) — reportado como erro, não faz o parser rebentar");
  {
    const linha = linha200(`2000099(;)9999.99(;)só isto${MARCADOR_FIM_REGISTO}`);
    const { registos, erros } = await coletar([linha]);
    eq(registos.length, 0, "E1: nenhum registo válido");
    eq(erros.length, 1, "E2: um erro reportado");
    eq(erros[0]?.motivo, "campos_invalidos", "E3: motivo correcto");
  }

  console.log("\nF · cnp não numérico no campo 0 — reportado como erro, não crasha");
  {
    const linha = linha200(campos("NAO-E-UM-CNP", ["9999.99", "6", "8309", "21", "2", "01-JUN-99", "14-MAY-20", "3960", "Revogado", "N", "X", "Y", MARCADOR_FIM_REGISTO]));
    const { registos, erros } = await coletar([linha]);
    eq(registos.length, 0, "F1: nenhum registo válido");
    eq(erros.length, 1, "F2: um erro reportado");
    eq(erros[0]?.motivo, "cnp_invalido", "F3: motivo correcto");
  }

  console.log("\nG · EOF a meio de um registo (sem *FIML* a fechar) — reportado, não perdido em silêncio");
  {
    const l1 = campos("2000099", ["9999.99", "6", "8309", "21", "2", "01-JUN-99", "14-MAY-20", "3960", "Revogado", "N", "Aspirina", "Bayer"]).slice(0, 200);
    const { registos, erros } = await coletar([l1]);
    eq(registos.length, 0, "G1: nenhum registo (incompleto)");
    eq(erros.length, 1, "G2: um erro reportado");
    eq(erros[0]?.motivo, "eof_sem_marcador", "G3: motivo correcto");
  }

  console.log("\nH · campos sem valor (string vazia) ficam null, não string vazia");
  {
    const linha = linha200(campos("2005395", ["9999.99", "6", "5279", "", "", "16-JUL-13", "17-JUN-21", "249876", "Revogado", "N", "Produto sem titular", "", MARCADOR_FIM_REGISTO]));
    const { registos } = await coletar([linha]);
    eq(registos[0]?.titular, null, "H1: titular vazio vira null, não string vazia");
  }

  console.log("\nI · ehEstadoAtual — só os 3 valores confirmados no ficheiro real contam como 'actual'");
  {
    check(ehEstadoAtual("Ativo"), "I1: Ativo é actual");
    check(ehEstadoAtual("Activo"), "I2: Activo é actual");
    check(ehEstadoAtual("Autorizado"), "I3: Autorizado é actual");
    check(!ehEstadoAtual("Anulado"), "I4: Anulado NÃO é actual (o valor mais frequente no ficheiro real, 116 641 casos)");
    check(!ehEstadoAtual("Revogado"), "I5: Revogado NÃO é actual");
    check(!ehEstadoAtual("Suspenso"), "I6: Suspenso NÃO é actual");
    check(!ehEstadoAtual("Retirado pela Entidade Reguladora"), "I7: valor não previsto NÃO é actual (conservador por omissão)");
    check(!ehEstadoAtual(null), "I8: null não é actual");
    check(!ehEstadoAtual(""), "I9: string vazia não é actual");
  }

  console.log(`\n${ok} ok, ${ko} falhas`);
  process.exit(ko === 0 ? 0 : 1);
}

principal();
