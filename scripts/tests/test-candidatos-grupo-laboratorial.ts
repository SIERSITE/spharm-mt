/**
 * scripts/tests/test-candidatos-grupo-laboratorial.ts
 *
 * Testa lib/catalog/candidatos-grupo-laboratorial.ts — o motor GENÉRICO
 * de descoberta de candidatos, não limitado aos 5 grupos iniciais.
 *
 * Corre com: npx tsx scripts/tests/test-candidatos-grupo-laboratorial.ts
 */
import { readFileSync } from "node:fs";
import {
  classificarPar,
  descobrirCandidatosGrupoLaboratorial,
  type ProdutoParaCandidatos,
  type SnapshotParaCandidatos,
} from "../../lib/catalog/candidatos-grupo-laboratorial";

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${label}`); }
  else { ko++; console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`); }
};
const eq = <T,>(a: T, b: T, label: string) =>
  check(JSON.stringify(a) === JSON.stringify(b), label, `esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);

console.log("A · classificarPar");
{
  eq(classificarPar("PERRIGO PORTUGAL", "PERRIGO PORTUGAL"), "identico", "A1: idêntico");
  eq(classificarPar("PERRIGO PORTUGAL", "PERRIGO PORTUGAL LDA"), "truncamento", "A2: truncamento por sufixo em falta");
  eq(classificarPar("LAB EXPANSCIENCE LDA", "LABORATORIOS EXPANSCIENCE PRODUTOS DE HIGIENE SOCIEDADE UNIPESSOAL LDA"), "genuinamente_diferente", "A3: 'LAB' vs 'LABORATORIOS' — radicais diferentes (heurística conservadora, fica genuinamente_diferente)");
  eq(classificarPar("NOVARTIS FARMA PRODUTOS FARMACEUTICOS", "SANDOZ FARMACEUTICA LDA"), "genuinamente_diferente", "A4: Novartis → Sandoz — sucessão real, radical diferente");
  eq(classificarPar("MERCK SHARP DOHME", "MERCK SHARP DOHME"), "identico", "A5: idêntico (radical não chega a ser avaliado)");
}

console.log("\nB · descobrirCandidatosGrupoLaboratorial — agrupa por par e ordena por frequência, nunca aplica nada");
{
  const produtos: ProdutoParaCandidatos[] = [
    { cnp: 1, fabricanteNomeNormalizado: "NOVARTIS FARMA PRODUTOS FARMACEUTICOS" },
    { cnp: 2, fabricanteNomeNormalizado: "NOVARTIS FARMA PRODUTOS FARMACEUTICOS" },
    { cnp: 3, fabricanteNomeNormalizado: "NOVARTIS FARMA PRODUTOS FARMACEUTICOS" },
    { cnp: 4, fabricanteNomeNormalizado: "MERCK SHARP DOHME" },
    { cnp: 5, fabricanteNomeNormalizado: "PERRIGO PORTUGAL" }, // truncamento — nunca aparece como candidato
    { cnp: 6, fabricanteNomeNormalizado: null }, // sem fabricante — ignorado
  ];
  const snapshotsPorCnp = new Map<number, SnapshotParaCandidatos>([
    [1, { titularAim: "Sandoz Farmacêutica, Lda", estadoAim: "Ativo" }],
    [2, { titularAim: "Sandoz Farmacêutica, Lda", estadoAim: "Activo" }],
    [3, { titularAim: "Sandoz Farmacêutica, Lda", estadoAim: "Anulado" }], // histórico — não conta
    [4, { titularAim: "Organon Portugal, Sociedade Unipessoal Lda", estadoAim: "Autorizado" }],
    [5, { titularAim: "Perrigo Portugal, Lda.", estadoAim: "Ativo" }],
  ]);

  const candidatos = descobrirCandidatosGrupoLaboratorial(produtos, snapshotsPorCnp);

  eq(candidatos.length, 2, "B1: só 2 pares genuinamente diferentes (Novartis→Sandoz, Merck→Organon) — truncamento e histórico excluídos");
  eq(candidatos[0]?.fabricanteGarantia, "NOVARTIS FARMA PRODUTOS FARMACEUTICOS", "B2: o mais frequente primeiro");
  eq(candidatos[0]?.ocorrencias, 2, "B3: 2 ocorrências (cnp 1 e 2 — cnp 3 é histórico, não conta)");
  eq(candidatos[0]?.cnpsExemplo, [1, 2], "B4: cnps de exemplo correctos, sem o histórico");
  eq(candidatos[1]?.ocorrencias, 1, "B5: o segundo par, 1 ocorrência");
  check(!candidatos.some((c) => c.fabricanteGarantia === "PERRIGO PORTUGAL"), "B6: truncamento (Perrigo) nunca aparece como candidato");
}

console.log("\nC · nenhum grupo é criado — a função só devolve dados, não tem efeitos secundários (verificação estática)");
{
  const src = readFileSync(new URL("../../lib/catalog/candidatos-grupo-laboratorial.ts", import.meta.url), "utf8");
  check(!/prisma\.|tx\.|\.create\(|\.upsert\(/.test(src), "C1: sem qualquer referência a escrita/Prisma — só lê e agrupa");
}

console.log(`\n${ok} ok, ${ko} falhas`);
process.exit(ko === 0 ? 0 : 1);
