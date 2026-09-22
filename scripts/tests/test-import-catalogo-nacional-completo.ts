/**
 * scripts/tests/test-import-catalogo-nacional-completo.ts
 *
 * Testa scripts/import-catalogo-nacional-completo.ts com um ficheiro
 * sintético MÍNIMO escrito para um directório temporário — nunca toca em
 * .local-data. Prova: parseArgs, mapeamento registo→ParsedRow, streaming
 * em batches, dry-run sem escritas, detecção de CNP duplicado dentro do
 * próprio ficheiro, e idempotência por hash (secção H).
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

/**
 * Fábrica de um `catalogoNacionalImportacao` falso que simula a
 * constraint `@unique` real de `hashSha256` — `create()` lança um erro
 * com `code: "P2002"` (o mesmo shape que o Prisma real usa para violação
 * de unicidade, replicado aqui para não depender do runtime Prisma nos
 * testes) sempre que o hash já existe no armazém partilhado. É este
 * armazém (`importacoesPorHash`) que representa a base de dados — os
 * testes de idempotência e de concorrência passam o MESMO objecto (ou
 * chamam `create` "em simultâneo") para provar que a protecção é real,
 * não apenas uma verificação de aplicação.
 */
function criarCatalogoNacionalImportacaoFake() {
  const importacoesPorHash = new Map<string, { id: string; totalRegistos: number; totalCnpValidos: number }>();
  const importacoesPorId = new Map<string, { id: string; totalRegistos: number; totalCnpValidos: number }>();
  let proximoId = 1;
  const chamadas: string[] = [];
  return {
    chamadas,
    importacoesPorHash,
    delegate: {
      create: async (args: { data: { hashSha256: string; totalRegistos: number; totalCnpValidos: number } }) => {
        chamadas.push("create");
        if (importacoesPorHash.has(args.data.hashSha256)) {
          throw Object.assign(new Error("Unique constraint failed on the fields: (`hashSha256`)"), { code: "P2002" });
        }
        const id = `imp${proximoId++}`;
        const row = { id, totalRegistos: args.data.totalRegistos, totalCnpValidos: args.data.totalCnpValidos };
        importacoesPorHash.set(args.data.hashSha256, row);
        importacoesPorId.set(id, row);
        return { id };
      },
      findFirst: async (args: { where: { hashSha256: string } }) => {
        chamadas.push("findFirst");
        const row = importacoesPorHash.get(args.where.hashSha256);
        return row ? { id: row.id } : null;
      },
      update: async (args: { where: { id: string }; data: { totalRegistos: number; totalCnpValidos: number } }) => {
        chamadas.push("update");
        const atual = importacoesPorId.get(args.where.id)!;
        Object.assign(atual, args.data);
        return atual;
      },
    },
  };
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
{
  let lancou = false;
  try { parseArgs(["--tenant=garantia", "--file=x.csv", "--source=tag", "--permitir-reimportacao"]); } catch { lancou = true; }
  check(lancou, "A9: --permitir-reimportacao já não existe — é um argumento desconhecido, recusado (a idempotência não tem escape hatch)");
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
      const registosImportadosNaFake: Array<{ importacaoId: string; cnp: number }> = [];
      const importacaoFake = criarCatalogoNacionalImportacaoFake();
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
        catalogoNacionalImportacao: importacaoFake.delegate,
        catalogoNacionalRegistoImportado: {
          createMany: async (args: { data: Array<{ importacaoId: string; cnp: number }> }) => {
            chamadas.push("catalogoNacionalRegistoImportado.createMany");
            registosImportadosNaFake.push(...args.data);
            return { count: args.data.length };
          },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      const stats = await importarCatalogoNacional(path, { source: "teste", dryRun: false, force: false, batchSize: 500, limit: null }, fakePrisma);

      eq(stats.registosLidos, 3, "C1: 3 registos lidos do ficheiro sintético");
      eq(stats.erros.length, 0, "C2: sem erros de reconstrução");
      eq(stats.cnpDuplicadosNoFicheiro, 0, "C3: sem duplicados");
      eq(stats.totais.inserted, 3, "C4: 3 inseridos (live)");
      check(chamadas.includes("createMany"), "C5: createMany foi mesmo chamado (modo live)");
      check(stats.importacaoId !== null, "C6: uma CatalogoNacionalImportacao foi criada (modo live)");
      eq(stats.resultado, "IMPORTADO", "C6b: resultado IMPORTADO");
      eq(registosImportadosNaFake.length, 3, "C7: 3 CatalogoNacionalRegistoImportado criados, um por registo");
      check(stats.hashSha256.length === 64, "C8: hash SHA-256 calculado (64 chars hex)", stats.hashSha256);
      const importacaoFinal = importacaoFake.importacoesPorHash.get(stats.hashSha256)!;
      eq(importacaoFinal.totalRegistos, 3, "C9: totalRegistos finalizado com o valor real (não fica a 0)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log("\nD · dry-run — lê (findMany), mas ZERO escritas (createMany/update nunca chamados), nem sequer tenta criar a CatalogoNacionalImportacao");
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
        catalogoNacionalImportacao: {
          create: async () => { chamadas.push("catalogoNacionalImportacao.create"); return { id: "nunca" }; },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      const stats = await importarCatalogoNacional(path, { source: "teste", dryRun: true, force: false, batchSize: 500, limit: null }, fakePrisma);

      check(chamadas.includes("findMany"), "D1: findMany foi chamado (precisa de ler para simular insert vs update)");
      check(!chamadas.includes("createMany"), "D2: createMany NUNCA chamado em dry-run");
      check(!chamadas.includes("update"), "D3: update NUNCA chamado em dry-run");
      check(!chamadas.includes("catalogoNacionalImportacao.create"), "D3b: catalogoNacionalImportacao.create NUNCA chamado em dry-run — nem sequer tenta criar a importação");
      eq(stats.resultado, "DRY_RUN", "D4: resultado DRY_RUN");
      eq(stats.totais.inserted, 1, "D5: o dry-run ainda conta quantos SERIAM inseridos, sem escrever");
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

      const importacaoFake = criarCatalogoNacionalImportacaoFake();
      const fakePrisma = {
        regulatoryRecord: {
          findMany: async () => [],
          createMany: async (args: { data: unknown[] }) => ({ count: args.data.length }),
          update: async () => ({}),
        },
        catalogoNacionalImportacao: importacaoFake.delegate,
        catalogoNacionalRegistoImportado: { createMany: async (a: { data: unknown[] }) => ({ count: a.data.length }) },
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

      const importacaoFake = criarCatalogoNacionalImportacaoFake();
      const fakePrisma = {
        regulatoryRecord: { findMany: async () => [], createMany: async (a: { data: unknown[] }) => ({ count: a.data.length }), update: async () => ({}) },
        catalogoNacionalImportacao: importacaoFake.delegate,
        catalogoNacionalRegistoImportado: { createMany: async (a: { data: unknown[] }) => ({ count: a.data.length }) },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      const stats = await importarCatalogoNacional(path, { source: "teste", dryRun: false, force: false, batchSize: 500, limit: 2 }, fakePrisma);
      eq(stats.registosLidos, 2, "F1: só 2 registos lidos, respeitando --limit=2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log("\nG · proveniência: uma importação POSTERIOR (ficheiro DIFERENTE, hash diferente) nunca toca no CatalogoNacionalRegistoImportado de uma importação ANTERIOR, mesmo repetindo o mesmo CNP");
  {
    const dir = mkdtempSync(join(tmpdir(), "import-catalogo-teste-"));
    try {
      const pathV1 = join(dir, "v1.csv");
      writeFileSync(pathV1, registoLinha("2000099", "Ativo", "Aspirina", "Bayer Portugal, Lda.") + "\r\n", "latin1");
      const pathV2 = join(dir, "v2.csv");
      // Mesmo CNP, titular MUDOU — simula uma importação posterior que
      // reflecte uma sucessão empresarial real (o mesmo padrão de
      // Mylan→Viatris no catálogo real). Conteúdo diferente ⇒ hash
      // diferente ⇒ tem de criar uma importação nova, nunca é bloqueado
      // pela protecção de idempotência (essa só actua em hashes IGUAIS).
      writeFileSync(pathV2, registoLinha("2000099", "Ativo", "Aspirina", "Nova Titular Sucessora Lda.") + "\r\n", "latin1");

      // Um único armazém partilhado entre as DUAS corridas — como duas
      // execuções reais do importador na mesma base fariam.
      const registosRegulatory = new Map<number, { cnp: number; titularAim: string | null }>();
      const registosImportados: Array<{ importacaoId: string; cnp: number; titularObservado: string | null }> = [];
      const importacaoFake = criarCatalogoNacionalImportacaoFake();
      const fakePrisma = {
        regulatoryRecord: {
          findMany: async (args: { where: { cnp: { in: number[] } } }) =>
            args.where.cnp.in.filter((c) => registosRegulatory.has(c)).map((c) => registosRegulatory.get(c)!),
          createMany: async (args: { data: Array<{ cnp: number; titularAim: string | null }> }) => {
            for (const r of args.data) if (!registosRegulatory.has(r.cnp)) registosRegulatory.set(r.cnp, r);
            return { count: args.data.length };
          },
          update: async (args: { where: { cnp: number }; data: Record<string, unknown> }) => {
            const atual = registosRegulatory.get(args.where.cnp)!;
            registosRegulatory.set(args.where.cnp, { ...atual, ...args.data } as { cnp: number; titularAim: string | null });
            return atual;
          },
        },
        catalogoNacionalImportacao: importacaoFake.delegate,
        catalogoNacionalRegistoImportado: {
          createMany: async (args: { data: Array<{ importacaoId: string; cnp: number; titularObservado: string | null }> }) => {
            registosImportados.push(...args.data);
            return { count: args.data.length };
          },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      const statsV1 = await importarCatalogoNacional(pathV1, { source: "importacao-2026-08", dryRun: false, force: true, batchSize: 500, limit: null }, fakePrisma);
      const statsV2 = await importarCatalogoNacional(pathV2, { source: "importacao-2026-09", dryRun: false, force: true, batchSize: 500, limit: null }, fakePrisma);

      check(statsV1.importacaoId !== statsV2.importacaoId, "G1: as duas corridas criaram DUAS CatalogoNacionalImportacao distintas (hashes diferentes)");
      eq(statsV1.resultado, "IMPORTADO", "G1b: V1 IMPORTADO");
      eq(statsV2.resultado, "IMPORTADO", "G1c: V2 IMPORTADO (hash diferente, nunca bloqueado)");

      const registoV1 = registosImportados.find((r) => r.importacaoId === statsV1.importacaoId && r.cnp === 2000099);
      const registoV2 = registosImportados.find((r) => r.importacaoId === statsV2.importacaoId && r.cnp === 2000099);

      eq(registoV1?.titularObservado, "Bayer Portugal, Lda.", "G2: o registo IMUTÁVEL da 1ª importação continua a dizer 'Bayer Portugal, Lda.'");
      eq(registoV2?.titularObservado, "Nova Titular Sucessora Lda.", "G3: o registo da 2ª importação (independente) diz o titular novo");
      eq(registosRegulatory.get(2000099)?.titularAim, "Nova Titular Sucessora Lda.", "G4: RegulatoryRecord (mutável) reflecte o titular MAIS RECENTE — é para isto que serve");
      check(
        registoV1?.titularObservado !== registosRegulatory.get(2000099)?.titularAim,
        "G5: a prova da 1ª classificação (registoV1) DIVERGE do RegulatoryRecord actual — exactamente o cenário que motivou snapshotRegistoId em vez de snapshotCnp",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log("\nH · idempotência por hash — reimportar EXACTAMENTE o mesmo ficheiro nunca duplica, não há flag de escape");
  {
    const dir = mkdtempSync(join(tmpdir(), "import-catalogo-teste-"));
    try {
      const path = join(dir, "amostra.csv");
      writeFileSync(path, registoLinha("2000099", "Ativo", "Aspirina", "Bayer Portugal, Lda.") + "\r\n", "latin1");

      const importacaoFake = criarCatalogoNacionalImportacaoFake();
      const registosImportadosNaFake: unknown[] = [];
      const fakePrisma = {
        regulatoryRecord: { findMany: async () => [], createMany: async (a: { data: unknown[] }) => ({ count: a.data.length }), update: async () => ({}) },
        catalogoNacionalImportacao: importacaoFake.delegate,
        catalogoNacionalRegistoImportado: {
          createMany: async (a: { data: unknown[] }) => { registosImportadosNaFake.push(...a.data); return { count: a.data.length }; },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      const stats1 = await importarCatalogoNacional(path, { source: "teste", dryRun: false, force: false, batchSize: 500, limit: null }, fakePrisma);
      eq(stats1.resultado, "IMPORTADO", "H1: primeira importação cria normalmente");
      eq(registosImportadosNaFake.length, 1, "H2: 1 registo importado na primeira corrida");

      const stats2 = await importarCatalogoNacional(path, { source: "teste-outra-vez", dryRun: false, force: false, batchSize: 500, limit: null }, fakePrisma);
      eq(stats2.resultado, "JA_IMPORTADO", "H3: segunda importação do MESMO ficheiro devolve JA_IMPORTADO, sem nenhuma flag");
      eq(stats2.importacaoId, stats1.importacaoId, "H4: aponta para a MESMA CatalogoNacionalImportacao, nunca cria uma segunda");
      eq(stats2.registosLidos, 0, "H5: zero registos processados na segunda corrida — nem sequer relê o ficheiro");
      eq(registosImportadosNaFake.length, 1, "H6: continua só 1 registo importado no total — a segunda corrida não criou NENHUMA linha nova");
      eq(stats2.hashSha256, stats1.hashSha256, "H7: mesmo hash, como esperado (mesmo ficheiro)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log("\nI · duas execuções CONCORRENTES do mesmo ficheiro nunca criam duplicados — a protecção é a constraint da base (P2002), não uma verificação prévia com janela de corrida");
  {
    const dir = mkdtempSync(join(tmpdir(), "import-catalogo-teste-"));
    try {
      const path = join(dir, "amostra.csv");
      writeFileSync(path, registoLinha("2000099", "Ativo", "Aspirina", "Bayer Portugal, Lda.") + "\r\n", "latin1");

      const importacaoFake = criarCatalogoNacionalImportacaoFake();
      const registosImportadosNaFake: unknown[] = [];
      const fakePrisma = {
        regulatoryRecord: { findMany: async () => [], createMany: async (a: { data: unknown[] }) => ({ count: a.data.length }), update: async () => ({}) },
        catalogoNacionalImportacao: importacaoFake.delegate,
        catalogoNacionalRegistoImportado: {
          createMany: async (a: { data: unknown[] }) => { registosImportadosNaFake.push(...a.data); return { count: a.data.length }; },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;

      // Duas chamadas disparadas em simultâneo (Promise.all) — nunca uma
      // depois da outra. Só uma pode ganhar a corrida ao create().
      const [statsA, statsB] = await Promise.all([
        importarCatalogoNacional(path, { source: "corrida-a", dryRun: false, force: false, batchSize: 500, limit: null }, fakePrisma),
        importarCatalogoNacional(path, { source: "corrida-b", dryRun: false, force: false, batchSize: 500, limit: null }, fakePrisma),
      ]);

      const resultados = [statsA.resultado, statsB.resultado].sort();
      eq(resultados, ["IMPORTADO", "JA_IMPORTADO"], "I1: exactamente UMA das duas corridas ganha (IMPORTADO), a outra recua (JA_IMPORTADO) — nunca as duas IMPORTADO");
      eq(statsA.importacaoId, statsB.importacaoId, "I2: ambas apontam para a MESMA CatalogoNacionalImportacao no final");
      eq(registosImportadosNaFake.length, 1, "I3: só 1 registo importado no total, mesmo com duas corridas simultâneas sobre o mesmo ficheiro");
      eq(importacaoFake.chamadas.filter((c) => c === "create").length, 2, "I4: create() foi tentado duas vezes (uma por corrida) — a segunda tentativa é que falha com P2002, apanhada explicitamente");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log(`\n${ok} ok, ${ko} falhas`);
  process.exit(ko === 0 ? 0 : 1);
}

principal();
