/**
 * scripts/tests/test-fabricante-baseline-erp.ts
 *
 * Baseline de fabricante ERP por farmácia+CNP (2026-09).
 *
 * ── Porque existe ────────────────────────────────────────────────────
 *
 * Uma correcção via listagem regulatória (Bloco F) escreve
 * `RegulatoryRecord.titularAim`, o que tornaria `fonteForte` verdadeiro
 * para sempre — bloqueando não só o ERP antigo (bom) como qualquer
 * mudança FUTURA legítima no ERP da farmácia (mau). O baseline por
 * farmácia+CNP resolve os dois lados ao mesmo tempo: só uma mudança
 * REAL, observada depois do baseline, corrige o SPharm.MT — mesmo
 * quando o valor actual veio de uma listagem corrigida.
 *
 * Cobre exactamente os 8 cenários pedidos, mais um teste de protecção em
 * massa (o ponto central de todo o bloco): milhares de produtos
 * corrigidos pela listagem não podem ser destruídos pelo primeiro
 * daily-sync depois da correcção.
 *
 * Uso: npx tsx scripts/tests/test-fabricante-baseline-erp.ts
 */
import {
  applyErpCatalogFields,
  decidirFabricanteBaseline,
  type ErpCatalogRow,
} from "../../lib/ingest/catalog-from-erp";
import type { PrismaClient } from "../../generated/prisma/client";

let pass = 0;
let fail = 0;
const ok = (label: string, cond: boolean, extra?: string) => {
  if (cond) {
    pass++;
    console.log(`  [OK]    ${label}`);
  } else {
    fail++;
    console.log(`  [FALHA] ${label}${extra ? ` — ${extra}` : ""}`);
  }
};
const eq = <T>(label: string, obtido: T, esperado: T) =>
  ok(label, Object.is(obtido, esperado), `obtido ${JSON.stringify(obtido)}, esperado ${JSON.stringify(esperado)}`);

// ─────────────────────────────────────────────────────────────────────────
// Mundo falso: vários produtos × várias farmácias, estado que sobrevive
// entre corridas sucessivas de applyErpCatalogFields (para simular ciclos
// consecutivos de daily-sync).
// ─────────────────────────────────────────────────────────────────────────

type ProdutoRow = {
  id: string;
  cnp: number;
  fabricanteId: string | null;
  validadoManualmente: boolean;
  fabricanteNome: string | null; // nomeNormalizado do Fabricante ligado
};

type PfRow = {
  produtoId: string;
  farmaciaId: string;
  fabricanteErpBaseline: string | null;
  fabricanteErpAtual: string | null;
  fabricanteErpFirstSeenAt: Date | null;
  fabricanteErpLastSeenAt: Date | null;
  fabricanteErpChangedAt: Date | null;
};

class MundoFalso {
  produtos: ProdutoRow[] = [];
  pf: PfRow[] = [];
  fabricantes = new Map<string, string>(); // nomeNormalizado -> id
  /** aliasNome -> fabricanteId[] — array para poder representar o caso real de dado inconsistente (mesmo alias, fabricantes distintos). */
  aliases = new Map<string, string[]>();
  /** `null` = sem autoridade de catálogo configurada (comportamento histórico, todos os tenants por defeito). */
  autoridadeFarmaciaId: string | null = null;
  calls = { produtoUpdate: 0, logCreate: 0, pfUpsert: 0, fabricanteUpsert: 0 };
  private fabSeq = 0;

  definirAutoridade(farmaciaId: string | null): void {
    this.autoridadeFarmaciaId = farmaciaId;
  }

  registarAlias(aliasNome: string, fabricanteId: string): void {
    const existentes = this.aliases.get(aliasNome) ?? [];
    this.aliases.set(aliasNome, [...existentes, fabricanteId]);
  }

  addProduto(p: Partial<ProdutoRow> & { id: string; cnp: number }): ProdutoRow {
    const row: ProdutoRow = {
      fabricanteId: null,
      validadoManualmente: false,
      fabricanteNome: null,
      ...p,
    };
    this.produtos.push(row);
    if (row.fabricanteNome) this.fabricantes.set(row.fabricanteNome, row.fabricanteId ?? `fab-${row.id}`);
    return row;
  }

  pfFor(produtoId: string, farmaciaId: string): PfRow | undefined {
    return this.pf.find((r) => r.produtoId === produtoId && r.farmaciaId === farmaciaId);
  }

  prisma(): PrismaClient {
    const fake = {
      produto: {
        findMany: async (args: { where: { cnp: { in: number[] } } }) =>
          this.produtos
            .filter((p) => args.where.cnp.in.includes(p.cnp))
            .map((p) => ({
              id: p.id,
              cnp: p.cnp,
              dci: null,
              codigoATC: null,
              grupoHomogeneo: null,
              fabricanteId: p.fabricanteId,
              designacao: "Produto Teste",
              flagMSRM: true,
              flagMNSRM: false,
              flagGenerico: false,
              tipoArtigo: null,
              productType: "MEDICAMENTO",
              productTypeConfidence: 0.99,
              validadoManualmente: p.validadoManualmente,
              fabricante: p.fabricanteNome ? { nomeNormalizado: p.fabricanteNome } : null,
            })),
        update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
          this.calls.produtoUpdate++;
          const p = this.produtos.find((x) => x.id === args.where.id)!;
          if ("fabricanteId" in args.data) {
            const fabId = args.data.fabricanteId as string;
            p.fabricanteId = fabId;
            const nome = [...this.fabricantes.entries()].find(([, id]) => id === fabId)?.[0] ?? null;
            p.fabricanteNome = nome;
          }
          return p;
        },
      },
      regulatoryRecord: {
        findMany: async () => [] as Array<{ cnp: number; dci: null; codigoATC: null; titularAim: null }>,
      },
      enrichmentSourceLog: {
        findMany: async () => [] as Array<{ produtoId: string; fieldsReturned: string[] }>,
        create: async () => {
          this.calls.logCreate++;
          return {};
        },
      },
      produtoFarmacia: {
        findMany: async (args: { where: { produtoId: { in: string[] }; farmaciaId: string } }) =>
          this.pf
            .filter(
              (r) => args.where.produtoId.in.includes(r.produtoId) && r.farmaciaId === args.where.farmaciaId,
            )
            .map((r) => ({ produtoId: r.produtoId, fabricanteErpBaseline: r.fabricanteErpBaseline })),
        upsert: async (args: {
          where: { produtoId_farmaciaId: { produtoId: string; farmaciaId: string } };
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          this.calls.pfUpsert++;
          const { produtoId, farmaciaId } = args.where.produtoId_farmaciaId;
          let row = this.pfFor(produtoId, farmaciaId);
          if (!row) {
            row = {
              produtoId,
              farmaciaId,
              fabricanteErpBaseline: null,
              fabricanteErpAtual: null,
              fabricanteErpFirstSeenAt: null,
              fabricanteErpLastSeenAt: null,
              fabricanteErpChangedAt: null,
              ...args.create,
            } as PfRow;
            this.pf.push(row);
          } else {
            Object.assign(row, args.update);
          }
          return row;
        },
      },
      fabricante: {
        findMany: async (args: { where: { nomeNormalizado: { in: string[] } } | { autoridadeCatalogo: true } }) => {
          if ("nomeNormalizado" in args.where) {
            return args.where.nomeNormalizado.in
              .filter((n) => this.fabricantes.has(n))
              .map((n) => ({ id: this.fabricantes.get(n)!, nomeNormalizado: n }));
          }
          return [];
        },
        upsert: async (args: { where: { nomeNormalizado: string } }) => {
          this.calls.fabricanteUpsert++;
          let id = this.fabricantes.get(args.where.nomeNormalizado);
          if (!id) {
            id = `fab-novo-${++this.fabSeq}`;
            this.fabricantes.set(args.where.nomeNormalizado, id);
          }
          return { id };
        },
      },
      fabricanteAlias: {
        findMany: async (args: { where: { aliasNome: { in: string[] } } }) =>
          args.where.aliasNome.in.flatMap((n) => (this.aliases.get(n) ?? []).map((fabricanteId) => ({ aliasNome: n, fabricanteId }))),
      },
      farmacia: {
        findMany: async (args: { where: { autoridadeCatalogo: true } }) => {
          void args;
          return this.autoridadeFarmaciaId ? [{ id: this.autoridadeFarmaciaId, nome: "Farmácia Autoritativa Teste" }] : [];
        },
      },
    };
    return fake as unknown as PrismaClient;
  }
}

const linha = (cnp: number, fabricante: string | null): ErpCatalogRow => ({
  cnp,
  dci: null,
  codigoATC: null,
  grupoHomogeneo: null,
  fabricante,
});

// ─────────────────────────────────────────────────────────────────────────
// 1. decidirFabricanteBaseline — função pura, todos os ramos
// ─────────────────────────────────────────────────────────────────────────

function testDecidirFabricanteBaselinePuro(): void {
  console.log("\n=== 1. decidirFabricanteBaseline (função pura) ===");

  {
    const d = decidirFabricanteBaseline({
      baseline: null,
      novoCanonico: "BAYER AG",
      fabricanteAtualNormalizado: null,
      validadoManualmente: false,
    });
    ok("1º ciclo, campo vazio → escreve e marca primeiroCiclo", d.escrever && d.primeiroCiclo && d.avancaBaseline);
  }
  {
    const d = decidirFabricanteBaseline({
      baseline: null,
      novoCanonico: "BAYER AG",
      fabricanteAtualNormalizado: "OUTRO FABRICANTE",
      validadoManualmente: false,
    });
    ok(
      "1º ciclo, campo já preenchido → NÃO escreve, mas estabelece baseline",
      !d.escrever && d.primeiroCiclo && d.avancaBaseline,
    );
  }
  {
    const d = decidirFabricanteBaseline({
      baseline: "BAYER AG",
      novoCanonico: "BAYER AG",
      fabricanteAtualNormalizado: "OUTRO FABRICANTE",
      validadoManualmente: false,
    });
    ok(
      "baseline == actual do ERP → não escreve, mesmo diferindo do SPharm.MT",
      !d.escrever && !d.avancaBaseline && !d.mudou,
    );
  }
  {
    const d = decidirFabricanteBaseline({
      baseline: "BAYER AG",
      novoCanonico: "BAYER PORTUGAL",
      fabricanteAtualNormalizado: "BAYER AG",
      validadoManualmente: false,
    });
    ok("mudança real → escreve, avança baseline, marca mudou", d.escrever && d.avancaBaseline && d.mudou && !d.primeiroCiclo);
  }
  {
    const d = decidirFabricanteBaseline({
      baseline: "BAYER AG",
      novoCanonico: "BAYER PORTUGAL",
      fabricanteAtualNormalizado: "BAYER AG",
      validadoManualmente: true,
    });
    ok(
      "mudança real mas validadoManualmente → bloqueia e NÃO avança baseline",
      !d.escrever && !d.avancaBaseline && !d.mudou,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 2-6. Os 8 cenários pedidos, ponta-a-ponta contra applyErpCatalogFields
// ─────────────────────────────────────────────────────────────────────────

async function testCiclosSucessivos(): Promise<void> {
  console.log("\n=== 2-6. Ciclos sucessivos (A→mantém B, A→C, C→D, maiúsculas/pontuação) ===");

  const mundo = new MundoFalso();
  const FARM = "farm-silveira";
  const CNP = 6100001;
  mundo.addProduto({ id: "p1", cnp: CNP, fabricanteId: "fab-B", fabricanteNome: "FABRICANTE B" });
  mundo.fabricantes.set("FABRICANTE B", "fab-B");

  // Cenário 1: primeiro ciclo, ERP=A, SPharm.MT=B (já corrigido pela
  // listagem) → mantém B, grava baseline A.
  {
    await applyErpCatalogFields(mundo.prisma(), [linha(CNP, "Fabricante A")], FARM);
    const p = mundo.produtos.find((x) => x.id === "p1")!;
    const pf = mundo.pfFor("p1", FARM)!;
    eq("1º ciclo: Produto.fabricanteId continua B", p.fabricanteNome, "FABRICANTE B");
    eq("1º ciclo: baseline gravado = A", pf.fabricanteErpBaseline, "FABRICANTE A");
    ok("1º ciclo: firstSeenAt gravado", pf.fabricanteErpFirstSeenAt !== null);
  }

  // Cenário 2: segundo ciclo, ERP continua A → mantém B.
  {
    const updatesAntes = mundo.calls.produtoUpdate;
    await applyErpCatalogFields(mundo.prisma(), [linha(CNP, "Fabricante A")], FARM);
    const p = mundo.produtos.find((x) => x.id === "p1")!;
    eq("2º ciclo (ERP continua A): Produto.fabricanteId continua B", p.fabricanteNome, "FABRICANTE B");
    eq("2º ciclo: nenhum produto.update adicional", mundo.calls.produtoUpdate, updatesAntes);
  }

  // Cenário 3: ERP muda A→C → actualiza MT para C.
  {
    await applyErpCatalogFields(mundo.prisma(), [linha(CNP, "Fabricante C")], FARM);
    const p = mundo.produtos.find((x) => x.id === "p1")!;
    const pf = mundo.pfFor("p1", FARM)!;
    eq("ERP muda A→C: Produto.fabricanteId passa a C", p.fabricanteNome, "FABRICANTE C");
    eq("baseline avança para C", pf.fabricanteErpBaseline, "FABRICANTE C");
    ok("changedAt gravado", pf.fabricanteErpChangedAt !== null);
  }

  // Cenário 4: ciclo seguinte continua C → não volta a actualizar.
  {
    const updatesAntes = mundo.calls.produtoUpdate;
    await applyErpCatalogFields(mundo.prisma(), [linha(CNP, "Fabricante C")], FARM);
    eq("ciclo seguinte (ERP continua C): nenhum produto.update novo", mundo.calls.produtoUpdate, updatesAntes);
  }

  // Cenário 5: ERP muda C→D → actualiza para D (prova que não foi "sorte
  // da primeira vez" — o mecanismo continua a funcionar em mudanças
  // sucessivas).
  {
    await applyErpCatalogFields(mundo.prisma(), [linha(CNP, "Fabricante D")], FARM);
    const p = mundo.produtos.find((x) => x.id === "p1")!;
    eq("ERP muda C→D: Produto.fabricanteId passa a D", p.fabricanteNome, "FABRICANTE D");
  }

  // Cenário 6: diferenças só de maiúsculas/pontuação não contam como
  // mudança — reenvia "D" com grafia diferente, mas canonicamente igual.
  {
    const updatesAntes = mundo.calls.produtoUpdate;
    await applyErpCatalogFields(mundo.prisma(), [linha(CNP, "Fabricante, D.")], FARM);
    eq(
      "grafia diferente do mesmo D (maiúsculas/pontuação) NÃO conta como mudança",
      mundo.calls.produtoUpdate,
      updatesAntes,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 7. Isolamento por farmácia
// ─────────────────────────────────────────────────────────────────────────

async function testIsoladoPorFarmacia(): Promise<void> {
  console.log("\n=== 7. Comportamento isolado por farmácia ===");

  const mundo = new MundoFalso();
  const CNP = 6200001;
  mundo.addProduto({ id: "p1", cnp: CNP, fabricanteId: "fab-B", fabricanteNome: "FABRICANTE B" });
  mundo.fabricantes.set("FABRICANTE B", "fab-B");

  // Baseline em farm-A e farm-B, ambas a reportar "Fabricante A" primeiro.
  await applyErpCatalogFields(mundo.prisma(), [linha(CNP, "Fabricante A")], "farm-A");
  await applyErpCatalogFields(mundo.prisma(), [linha(CNP, "Fabricante A")], "farm-B");

  // farm-A muda para C; farm-B continua A.
  await applyErpCatalogFields(mundo.prisma(), [linha(CNP, "Fabricante C")], "farm-A");

  const pfA = mundo.pfFor("p1", "farm-A")!;
  const pfB = mundo.pfFor("p1", "farm-B")!;
  eq("baseline de farm-A avançou para C", pfA.fabricanteErpBaseline, "FABRICANTE C");
  eq("baseline de farm-B continua A (não foi tocado pela mudança de farm-A)", pfB.fabricanteErpBaseline, "FABRICANTE A");

  // farm-B, correndo de novo com o MESMO valor A que já tinha, não deve
  // reagir à mudança que só aconteceu em farm-A.
  const updatesAntes = mundo.calls.produtoUpdate;
  await applyErpCatalogFields(mundo.prisma(), [linha(CNP, "Fabricante A")], "farm-B");
  eq("farm-B (ERP continua A) não dispara nenhum produto.update", mundo.calls.produtoUpdate, updatesAntes);
}

// ─────────────────────────────────────────────────────────────────────────
// 8. Protecção em massa — o ponto central de todo o bloco
// ─────────────────────────────────────────────────────────────────────────

async function testProtecaoEmMassa(): Promise<void> {
  console.log("\n=== 8. Nenhum valor antigo do ERP destrói em massa a correcção da listagem ===");

  const mundo = new MundoFalso();
  const FARM = "farm-silveira";
  const N = 500;
  const linhas: ErpCatalogRow[] = [];
  for (let i = 0; i < N; i++) {
    const cnp = 6300000 + i;
    // Todos os N produtos já foram corrigidos pela listagem: fabricanteId
    // aponta para "FABRICANTE CORRIGIDO" — nenhum ProdutoFarmacia.baseline
    // existe ainda (nunca correu daily-sync depois da correcção).
    mundo.addProduto({ id: `p${i}`, cnp, fabricanteId: "fab-corrigido", fabricanteNome: "FABRICANTE CORRIGIDO" });
    // O ERP de todas as farmácias ainda reporta o valor ANTIGO/errado.
    linhas.push(linha(cnp, "Fabricante Antigo Errado"));
  }
  mundo.fabricantes.set("FABRICANTE CORRIGIDO", "fab-corrigido");

  const res = await applyErpCatalogFields(mundo.prisma(), linhas, FARM);

  eq(`todos os ${N} candidatos considerados`, res.candidatos, N);
  eq("ZERO substituições — nada foi tocado no primeiro ciclo", res.substituidos.fabricante, 0);
  eq("ZERO produto.update — a correcção sobrevive intacta", mundo.calls.produtoUpdate, 0);
  ok(
    "todos os produtos continuam com o fabricante corrigido",
    mundo.produtos.every((p) => p.fabricanteNome === "FABRICANTE CORRIGIDO"),
  );
  ok(
    "todos os N baselines foram estabelecidos com o valor (errado) do ERP",
    mundo.pf.filter((r) => r.fabricanteErpBaseline === "FABRICANTE ANTIGO ERRADO").length === N,
  );

  // Segundo ciclo, ERP continua a reportar o mesmo valor antigo — a
  // protecção não é "sorte de uma corrida", mantém-se indefinidamente.
  await applyErpCatalogFields(mundo.prisma(), linhas, FARM);
  eq("2º ciclo, ERP continua igual: continua ZERO produto.update", mundo.calls.produtoUpdate, 0);
  ok(
    "2º ciclo: a correcção continua intacta em todos os produtos",
    mundo.produtos.every((p) => p.fabricanteNome === "FABRICANTE CORRIGIDO"),
  );
}

// ─────────────────────────────────────────────────────────────────────────
// 9. Farmácia autoritativa de catálogo — caso real Silveirense/Segurado
//    (CNP 5589312, "GENERIS DIRECTO" → canónico "Generis Farmacêutica,
//    S.A. Portugal"). Cobre os 12 cenários pedidos.
// ─────────────────────────────────────────────────────────────────────────

async function testFarmaciaAutoridadeCatalogo(): Promise<void> {
  console.log("\n=== 9. Farmácia autoritativa de catálogo (caso real Silveirense/Segurado) ===");

  const FARM_SILVEIRENSE = "farm-silveirense";
  const FARM_SEGURADO = "farm-segurado";
  const CNP = 5589312;
  const GENERIS_CANONICO = "GENERIS FARMACEUTICA S A PORTUGAL";

  const mundo = new MundoFalso();
  mundo.definirAutoridade(FARM_SILVEIRENSE);
  // O canónico já existe (criado por outra via — revisão manual, xlsx,
  // etc.) com "GENERIS DIRECTO" registado como alias seu — é isto que o
  // enunciado descreve como "o valor recebido pode ser normalizado".
  mundo.fabricantes.set(GENERIS_CANONICO, "fab-generis-canonico");
  mundo.registarAlias("GENERIS DIRECTO", "fab-generis-canonico");

  // 1. Produto começa com fabricante DIFERENTE (nunca null — cenário mais rigoroso).
  mundo.addProduto({ id: "p-5589312", cnp: CNP, fabricanteId: "fab-antigo-errado", fabricanteNome: "OUTRO FABRICANTE ANTIGO LDA" });
  mundo.fabricantes.set("OUTRO FABRICANTE ANTIGO LDA", "fab-antigo-errado");

  // 2. Silveirense (autoridade) envia "Generis Directo".
  const linhas = [linha(CNP, "Generis Directo")];
  const res1 = await applyErpCatalogFields(mundo.prisma(), linhas, FARM_SILVEIRENSE);

  // 3. O resolver reutiliza o canónico Generis já existente via alias — nunca cria "GENERIS DIRECTO" como Fabricante literal.
  ok("3. resolve via alias para o canónico Generis existente, nunca cria um Fabricante literal 'GENERIS DIRECTO'", !mundo.fabricantes.has("GENERIS DIRECTO"));
  eq("3b. zero fabricante.upsert (o canónico e o alias já existiam)", mundo.calls.fabricanteUpsert, 0);

  // 4. Produto.fabricanteId é actualizado para o canónico.
  const p1 = mundo.produtos.find((p) => p.id === "p-5589312")!;
  eq("4. Produto.fabricanteId actualizado para o Fabricante canónico Generis", p1.fabricanteId, "fab-generis-canonico");

  // 5. A ficha comum às duas farmácias mostra Generis — é o MESMO Produto,
  //    partilhado; não há "ficha da Segurado" separada para fabricante.
  eq("5. a ficha (Produto, comum às duas farmácias) mostra o nome canónico Generis", p1.fabricanteNome, GENERIS_CANONICO);

  // 6. O contador indica UMA alteração.
  eq("6. contador fabricantesAlterados = 1 (preenchidos+substituidos)", res1.preenchidos.fabricante + res1.substituidos.fabricante, 1);

  // 7. Repetir o MESMO payload é idempotente — zero alterações.
  const chamadasUpdateAntesRepeticao = mundo.calls.produtoUpdate;
  const res2 = await applyErpCatalogFields(mundo.prisma(), linhas, FARM_SILVEIRENSE);
  eq("7. repetição — fabricantesAlterados = 0", res2.preenchidos.fabricante + res2.substituidos.fabricante, 0);
  eq("7b. repetição — zero produto.update adicional", mundo.calls.produtoUpdate, chamadasUpdateAntesRepeticao);
  eq("7c. repetição — Produto.fabricanteId continua Generis", mundo.produtos.find((p) => p.id === "p-5589312")!.fabricanteId, "fab-generis-canonico");

  // 8. Segurado envia um fabricante DIFERENTE.
  const linhasSegurado = [linha(CNP, "Outro Fabricante Segurado Lda")];
  const res3 = await applyErpCatalogFields(mundo.prisma(), linhasSegurado, FARM_SEGURADO);

  // 9. O valor local da Segurado fica registado (ProdutoFarmacia), mas NÃO altera o fabricante global.
  const pfSegurado = mundo.pfFor("p-5589312", FARM_SEGURADO);
  eq("9. ProdutoFarmacia (Segurado) guarda o valor ERP local dela", pfSegurado?.fabricanteErpAtual, "OUTRO FABRICANTE SEGURADO LDA");
  eq("9b. Produto.fabricanteId permanece Generis — Segurado nunca substitui a autoridade", mundo.produtos.find((p) => p.id === "p-5589312")!.fabricanteId, "fab-generis-canonico");
  eq("9c. contador fabricantesAlterados = 0 (Segurado é só informação local)", res3.preenchidos.fabricante + res3.substituidos.fabricante, 0);
  eq("9d. contado como preservado, não como substituição", res3.preservados.fabricante, 1);

  // 10. Nova sincronização da Silveirense continua a prevalecer — mesmo
  //     que ALGO tenha alterado Produto.fabricanteId entretanto (ex.:
  //     uma acção administrativa directa), a autoridade REAFIRMA o
  //     valor correcto na próxima corrida, porque compara sempre contra
  //     o catálogo ACTUAL, nunca só contra a sua própria história.
  const pAlterado = mundo.produtos.find((p) => p.id === "p-5589312")!;
  pAlterado.fabricanteId = "fab-antigo-errado";
  pAlterado.fabricanteNome = "OUTRO FABRICANTE ANTIGO LDA";
  const res4 = await applyErpCatalogFields(mundo.prisma(), linhas, FARM_SILVEIRENSE);
  eq("10. Silveirense reafirma Generis mesmo depois de uma alteração externa", mundo.produtos.find((p) => p.id === "p-5589312")!.fabricanteId, "fab-generis-canonico");
  eq("10b. contador regista a reafirmação como alteração real", res4.preenchidos.fabricante + res4.substituidos.fabricante, 1);

  // 12. Campos manuais continuam protegidos — mesmo a autoridade não pode passar por cima de validadoManualmente.
  const pManual = mundo.addProduto({ id: "p-manual", cnp: 5589313, fabricanteId: "fab-antigo-errado", fabricanteNome: "OUTRO FABRICANTE ANTIGO LDA", validadoManualmente: true });
  const res5 = await applyErpCatalogFields(mundo.prisma(), [linha(5589313, "Generis Directo")], FARM_SILVEIRENSE);
  eq("12. validadoManualmente bloqueia mesmo a autoridade de catálogo", mundo.produtos.find((p) => p.id === "p-manual")!.fabricanteId, "fab-antigo-errado");
  eq("12b. contador não regista alteração nenhuma", res5.preenchidos.fabricante + res5.substituidos.fabricante, 0);
  void pManual;

  // 11. Tenants/farmácias SEM autoridade configurada permanecem inalterados
  //     — mundo SEPARADO, nunca chama definirAutoridade (comportamento
  //     histórico simétrico, o mesmo já coberto pelos blocos 1-8 acima).
  {
    const mundoSemAutoridade = new MundoFalso();
    mundoSemAutoridade.addProduto({ id: "p-outro-tenant-a", cnp: 6000099, fabricanteId: null });
    mundoSemAutoridade.addProduto({ id: "p-outro-tenant-b", cnp: 6000098, fabricanteId: null });
    const rA = await applyErpCatalogFields(mundoSemAutoridade.prisma(), [linha(6000099, "Fabricante Qualquer Lda")], "farm-qualquer-a");
    eq("11. sem autoridade configurada — farmácia A escreve normalmente (comportamento histórico)", rA.preenchidos.fabricante, 1);
    // CNP DIFERENTE, para provar simetria (nenhuma farmácia privilegiada)
    // sem tropeçar na protecção histórica "1º ciclo nunca substitui um
    // valor já preenchido por outra farmácia" — essa protecção já
    // existia antes desta correcção e continua correcta.
    const rB = await applyErpCatalogFields(mundoSemAutoridade.prisma(), [linha(6000098, "Fabricante Diferente Lda")], "farm-qualquer-b");
    eq("11b. sem autoridade configurada — farmácia B TAMBÉM escreve normalmente (nenhuma farmácia privilegiada)", rB.preenchidos.fabricante, 1);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 10. Alias associado inconsistentemente a fabricantes distintos —
//     nunca escolhido arbitrariamente, Produto.fabricanteId intocado,
//     diagnóstico explícito em ambiguidadesFabricante.
// ─────────────────────────────────────────────────────────────────────────

async function testAliasAmbiguo(): Promise<void> {
  console.log("\n=== 10. Alias associado inconsistentemente — nunca resolvido arbitrariamente ===");

  const FARM_SILVEIRENSE = "farm-silveirense-2";
  const CNP = 5589400;

  const mundo = new MundoFalso();
  mundo.definirAutoridade(FARM_SILVEIRENSE);
  mundo.fabricantes.set("FABRICANTE X", "fab-x");
  mundo.fabricantes.set("FABRICANTE Y", "fab-y");
  // Dado inconsistente real: o MESMO alias aponta para dois fabricantes
  // distintos (@@unique([fabricanteId, aliasNome]) no schema permite
  // isto — não é impossível, é só errado).
  mundo.registarAlias("NOME AMBIGUO", "fab-x");
  mundo.registarAlias("NOME AMBIGUO", "fab-y");

  mundo.addProduto({ id: "p-ambiguo", cnp: CNP, fabricanteId: "fab-antigo", fabricanteNome: "FABRICANTE ANTIGO" });
  mundo.fabricantes.set("FABRICANTE ANTIGO", "fab-antigo");

  const res = await applyErpCatalogFields(mundo.prisma(), [linha(CNP, "Nome Ambiguo")], FARM_SILVEIRENSE);

  eq("10a. Produto.fabricanteId NUNCA é tocado quando o alias é ambíguo", mundo.produtos.find((p) => p.id === "p-ambiguo")!.fabricanteId, "fab-antigo");
  eq("10b. contador fabricantesAlterados = 0 — nada foi realmente alterado", res.preenchidos.fabricante + res.substituidos.fabricante, 0);
  eq("10c. NÃO cria um Fabricante novo literal 'NOME AMBIGUO' por cima da ambiguidade", mundo.calls.fabricanteUpsert, 0);
  ok("10d. diagnóstico explícito: ambiguidadesFabricante regista o nome ambíguo", res.ambiguidadesFabricante.some((a) => a.nome === "NOME AMBIGUO"));
  const diag = res.ambiguidadesFabricante.find((a) => a.nome === "NOME AMBIGUO");
  ok(
    "10e. diagnóstico lista os DOIS fabricantes concorrentes, nunca só um (nunca escolhe arbitrariamente)",
    !!diag && diag.fabricanteIds.length === 2 && diag.fabricanteIds.includes("fab-x") && diag.fabricanteIds.includes("fab-y"),
  );
}

async function main() {
  testDecidirFabricanteBaselinePuro();
  await testCiclosSucessivos();
  await testIsoladoPorFarmacia();
  await testProtecaoEmMassa();
  await testFarmaciaAutoridadeCatalogo();
  await testAliasAmbiguo();

  console.log(`\n${pass} ok, ${fail} falhas`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
