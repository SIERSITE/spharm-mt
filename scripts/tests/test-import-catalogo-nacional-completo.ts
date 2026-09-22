/**
 * scripts/tests/test-import-catalogo-nacional-completo.ts
 *
 * Testa scripts/import-catalogo-nacional-completo.ts com um ficheiro
 * sintético MÍNIMO escrito para um directório temporário — nunca toca em
 * .local-data. Prova: parseArgs, mapeamento registo→ParsedRow, streaming
 * em batches, dry-run sem escritas, e detecção de CNP duplicado dentro
 * do próprio ficheiro.
 *
 * Corre com: npx tsx scripts/tests/test-import-catalogo-nacional-completo.ts
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, registoParaParsedRow, importarCatalogoNacional } from "../import-catalogo-nacional-completo";
import { MARCADOR_FIM_REGISTO } from "../../lib/catalog/catalogo-nacional-parser";

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${label}`); }
  else { ko++; console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`); }
};
const eq = <T,>(a: T, b: T, label: string) =>
  check(JSON.stringify(a) === JSON.stringify(b), label, `esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);

function linha200(conteudo: string): string {
  return conteudo.padEnd(200, " ");
}
function registoLinha(cnp: string, estado: string, designacao: string, titular: string): string {
  return linha200([cnp, "9999.99", "6", "1", "1", "1", "01-JAN-99", "01-JAN-20", "1", estado, "N", designacao, titular, MARCADOR_FIM_REGISTO].join("(;)"));
}

console.log("A · parseArgs");
{
  let lancou = false;
  try { parseArgs(["--tenant=garantia"]); } catch { lancou = true; }
  check(lancou, "A1: falta --file= é recusado");
}
{
  let lancou = false;
  try { parseArgs(["--tenant=garantia", "--file=x.csv"]); } catch { lancou = true; }
  check(lancou, "A2: falta --source= é recusado");
}
{
  const args = parseArgs(["--tenant=garantia", "--file=x.csv", "--source=tag", "--dry-run", "--batch-size=100", "--limit=5"]);
  eq(args.file, "x.csv", "A3: --file= correcto");
  eq(args.source, "tag", "A4: --source= correcto");
  eq(args.dryRun, true, "A5: --dry-run correcto");
  eq(args.force, false, "A6: force default correcto");
  eq(args.batchSize, 100, "A7: --batch-size= correcto");
  eq(args.limit, 5, "A8: --limit= correcto");
}

console.log("\nB · registoParaParsedRow — só os 4 campos com correspondência em RegulatoryRecord");
{
  const parsed = registoParaParsedRow({
    cnp: 2000099, estado: "Revogado", designacao: "Aspirina", titular: "Bayer Portugal, Lda.",
    outrosCampos: ["9999.99", "6", "1", "1", "1", "01-JAN-99", "01-JAN-20", "1", "N"],
    indiceRegisto: 1,
  });
  eq(parsed, { cnp: 2000099, designacaoOficial: "Aspirina", titularAim: "Bayer Portugal, Lda.", estadoAim: "Revogado" }, "B1: mapeamento correcto");
}

async function principal() {
  console.log("\nC · importarCatalogoNacional — streaming de um ficheiro sintético mínimo, em batches");
  {
    const dir = mkdtempSync(join(tmpdir(), "import-catalogo-teste-"));
    try {
      const path = join(dir, "amostra.csv");
      const linhas = [
        registoLinha("2000099", "Ativo", "Aspirina", "Bayer Portugal, Lda."),
        registoLinha("2000396", "Anulado", "Acnederma", "Confar Lda"),
        registoLinha("2000594", "Autorizado", "Afonina", "Farmacoope"),
      ];
      writeFileSync(path, linhas.join("\r\n") + "\r\n", "latin1");

      const chamadas: string[] = [];
      const registosNaFake = new Map<number, { cnp: number }>();
      const fakePrisma = {
        regulatoryRecord: {
          findMany: async (args: { where: { cnp: { in: number[] } } }) => {
            chamadas.push("findMany");
            return args.where.cnp.in.filter((c) => registosNaFake.has(c)).map((c) => registosNaFake.get(c)!);
          },
          createMany: async (args: { data: Array<{ cnp: number }> }) => {
            chamadas.push("createMany");
            for (const r of args.data) registosNaFake.set(r.cnp, { cnp: r.cnp });
            return { count: args.data.length };
          },
          update: async () => { chamadas.push("update"); return {}; },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      const stats = await importarCatalogoNacional(path, { source: "teste", dryRun: false, force: false, batchSize: 500, limit: null }, fakePrisma);

      eq(stats.registosLidos, 3, "C1: 3 registos lidos do ficheiro sintético");
      eq(stats.erros.length, 0, "C2: sem erros de reconstrução");
      eq(stats.cnpDuplicadosNoFicheiro, 0, "C3: sem duplicados");
      eq(stats.totais.inserted, 3, "C4: 3 inseridos (live)");
      check(chamadas.includes("createMany"), "C5: createMany foi mesmo chamado (modo live)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log("\nD · dry-run — lê (findMany), mas ZERO escritas (createMany/update nunca chamados)");
  {
    const dir = mkdtempSync(join(tmpdir(), "import-catalogo-teste-"));
    try {
      const path = join(dir, "amostra.csv");
      writeFileSync(path, registoLinha("2000099", "Ativo", "Aspirina", "Bayer Portugal, Lda.") + "\r\n", "latin1");

      const chamadas: string[] = [];
      const fakePrisma = {
        regulatoryRecord: {
          findMany: async () => { chamadas.push("findMany"); return []; },
          createMany: async () => { chamadas.push("createMany"); return { count: 0 }; },
          update: async () => { chamadas.push("update"); return {}; },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      const stats = await importarCatalogoNacional(path, { source: "teste", dryRun: true, force: false, batchSize: 500, limit: null }, fakePrisma);

      check(chamadas.includes("findMany"), "D1: findMany foi chamado (precisa de ler para simular insert vs update)");
      check(!chamadas.includes("createMany"), "D2: createMany NUNCA chamado em dry-run");
      check(!chamadas.includes("update"), "D3: update NUNCA chamado em dry-run");
      eq(stats.totais.inserted, 1, "D4: o dry-run ainda conta quantos SERIAM inseridos, sem escrever");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log("\nE · CNP duplicado dentro do próprio ficheiro é detectado (mesmo o catálogo real não ter nenhum)");
  {
    const dir = mkdtempSync(join(tmpdir(), "import-catalogo-teste-"));
    try {
      const path = join(dir, "amostra.csv");
      const linhas = [
        registoLinha("2000099", "Ativo", "Aspirina", "Bayer Portugal, Lda."),
        registoLinha("2000099", "Ativo", "Aspirina (repetido)", "Bayer Portugal, Lda."),
      ];
      writeFileSync(path, linhas.join("\r\n") + "\r\n", "latin1");

      const fakePrisma = {
        regulatoryRecord: {
          findMany: async () => [],
          createMany: async (args: { data: unknown[] }) => ({ count: args.data.length }),
          update: async () => ({}),
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      const stats = await importarCatalogoNacional(path, { source: "teste", dryRun: false, force: false, batchSize: 500, limit: null }, fakePrisma);
      eq(stats.cnpDuplicadosNoFicheiro, 1, "E1: 1 duplicado detectado");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log("\nF · --limit respeitado — pára de ler depois de N registos");
  {
    const dir = mkdtempSync(join(tmpdir(), "import-catalogo-teste-"));
    try {
      const path = join(dir, "amostra.csv");
      const linhas = [1, 2, 3, 4, 5].map((i) => registoLinha(`200000${i}`, "Ativo", `Produto ${i}`, "Fabricante X"));
      writeFileSync(path, linhas.join("\r\n") + "\r\n", "latin1");

      const fakePrisma = {
        regulatoryRecord: { findMany: async () => [], createMany: async (a: { data: unknown[] }) => ({ count: a.data.length }), update: async () => ({}) },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      const stats = await importarCatalogoNacional(path, { source: "teste", dryRun: false, force: false, batchSize: 500, limit: 2 }, fakePrisma);
      eq(stats.registosLidos, 2, "F1: só 2 registos lidos, respeitando --limit=2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log(`\n${ok} ok, ${ko} falhas`);
  process.exit(ko === 0 ? 0 : 1);
}

principal();
