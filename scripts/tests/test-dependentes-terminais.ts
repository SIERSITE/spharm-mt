/**
 * scripts/tests/test-dependentes-terminais.ts
 *
 * Um dependente de família tem SEMPRE destino, e a cache diz a verdade
 * sobre o que aconteceu.
 *
 * ─────────────────────────────────────────────────────────────────────
 * OS TRÊS DEFEITOS QUE ISTO GUARDA
 *
 * 1. A PROPAGAÇÃO SÓ EXISTIA PARA O "SIM".
 *
 *    Toda a propagação vivia dentro de `if (gate.decisao === "APPLY")`.
 *    O representante recusado ficava com linha de cache e saía do
 *    residual; os dependentes não ficavam com nada — nem cache, nem
 *    estado, nem contador. No canary de 25 do silveira foram 4 produtos
 *    numa corrida e 2 na seguinte, e a família LOVENOX (7 embalagens do
 *    mesmo medicamento, todas a precisar de utilizações) pagava SETE
 *    chamadas em vez de uma: cada corrida enviava o irmão de cnp mais
 *    baixo, que saía com cache, e na corrida seguinte o lugar de
 *    representante passava ao seguinte.
 *
 * 2. A CACHE DIZIA "PERSISTIDO" SEM TER PERSISTIDO NADA.
 *
 *    Quando o representante era APPLY, o dependente recebia
 *    `gravarCache(..., true, ...)` com `true` FIXO. Mas o dependente
 *    volta a passar pelo gate contra o estado DELE, e esse gate pode
 *    recusar. Nesse caso `escrever()` não escrevia nada e a cache dizia
 *    `persistido = true, motivo = null`. A fila decide o estado a partir
 *    desse campo: o produto saía como SUCESSO sem uma única escrita.
 *    E `resumo.propagados` só contava o caso APPLY, portanto a
 *    reconciliação fechava a menos sem dizer porquê.
 *
 * 3. `if (!pre) continue`.
 *
 *    Um produto do residual sem linha no contexto desaparecia da corrida
 *    E da contabilidade, sem cache, sem contador e sem nome.
 *
 * Estas asserções falham no código anterior. O controlo negativo está
 * documentado no fim do ficheiro, com os números de cada reversão.
 *
 * Sem base de dados e sem rede.
 *
 * Uso: npx tsx scripts/tests/test-dependentes-terminais.ts
 */
import { runKnowledgeEnrichment, corpoResidual } from "../../lib/catalog/knowledge-enrichment-runner";
import type { KnowledgeResult } from "../../lib/catalog/knowledge-enrichment";

let pass = 0;
let fail = 0;
const check = (ok: boolean, label: string, extra = "") => {
  if (ok) {
    pass++;
    console.log(`  [OK]    ${label}`);
  } else {
    fail++;
    console.log(`  [FALHA] ${label}${extra ? `  — ${extra}` : ""}`);
  }
};

// ─────────────────────────────────────────────────────────────────────
// Duplos
// ─────────────────────────────────────────────────────────────────────

type Linha = {
  cnp: number;
  designacao: string;
  productType: string | null;
  categoriaAtual: string | null;
  subcategoriaAtual: string | null;
  estrato: string;
};

type Cache = { cnp: number; persistido: boolean; motivo: string | null; origem: string; propagadoDeCnp: number | null };

/**
 * Prisma que regista as escritas em vez de as fazer, e devolve o
 * `upsert` da cache com os argumentos que lhe passaram — é aí que está
 * a asserção que interessa.
 *
 * `contexto` é dado à parte do residual de propósito: é assim que se
 * constrói o caso do produto que está no residual e não está no
 * contexto, que era o `continue` mudo.
 */
function prismaFalso(
  residual: Linha[],
  contexto: Array<{ cnp: number; designacao: string; nivel1: string | null; nivel2: string | null }>,
) {
  const caches: Cache[] = [];
  const sqls: string[] = [];
  return {
    caches,
    sqls,
    prisma: {
      $queryRawUnsafe: async (sql: string) => {
        if (/as nivel1/i.test(sql)) return contexto.map((c) => ({ ...c, utilizacoes: [] as string[] }));
        if (/from "Classificacao"/i.test(sql)) {
          return [
            { id: "n1", nome: "MEDICAMENTOS", pai: null },
            { id: "n2", nome: "Diabetes", pai: "n1" },
          ];
        }
        if (/from "Utilizacao"/i.test(sql)) return [{ id: "u1", slug: "diabetes" }];
        if (/information_schema\.columns/i.test(sql)) return [{ n: 2 }];
        if (/count\(/i.test(sql)) return [{ n: residual.length }];
        return residual;
      },
      $executeRawUnsafe: async (sql: string) => {
        sqls.push(sql.replace(/\s+/g, " "));
        return 1;
      },
      knowledgeEnrichmentCache: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        upsert: async (args: any) => {
          caches.push({
            cnp: args.create.cnp,
            persistido: args.update.persistido,
            motivo: args.update.motivo,
            origem: args.update.origem,
            propagadoDeCnp: args.update.propagadoDeCnp,
          });
          return {};
        },
      },
      enriquecimentoFila: { updateMany: async () => ({ count: 0 }) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  };
}

/** Família de irmãos: mesma designação, logo mesma chave estrita. */
const irmao = (cnp: number, over: Partial<Linha> = {}): Linha => ({
  cnp,
  designacao: "Movalis Comprimidos",
  productType: null,
  categoriaAtual: null,
  subcategoriaAtual: null,
  estrato: "NAO_CLASSIFICADO",
  ...over,
});

const ctx = (l: Linha, over: Partial<{ nivel1: string | null; nivel2: string | null }> = {}) => ({
  cnp: l.cnp,
  designacao: l.designacao,
  nivel1: l.categoriaAtual,
  nivel2: l.subcategoriaAtual,
  ...over,
});

const cru = (cnp: number, over: Record<string, unknown> = {}) => ({
  cnp,
  productType: "MEDICAMENTO",
  categoria: "MEDICAMENTOS",
  subcategoria: "Diabetes",
  utilizacoes: ["diabetes"],
  confidence: 0.95,
  evidenceType: "SUBSTANCIA_CONHECIDA",
  rationale: "Meloxicam.",
  dci: "Meloxicam",
  codigoATC: "M01AC06",
  forma: "comprimido",
  dosagem: "15 mg",
  embalagem: "20 comprimidos",
  confidenceClinica: 0.95,
  ...over,
});

const respostaCom = (crus: Array<Record<string, unknown>>) => async () => ({
  // O duplo devolve resultados CRUS de propósito: quem os valida é o
  // runner, pelo caminho normal, e é isso que se quer exercitar.
  resultados: crus as unknown as KnowledgeResult[],
  usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
});

async function correr(
  residual: Linha[],
  contexto: Array<{ cnp: number; designacao: string; nivel1: string | null; nivel2: string | null }>,
  crus: Array<Record<string, unknown>>,
) {
  const { prisma, caches, sqls } = prismaFalso(residual, contexto);
  const r = await runKnowledgeEnrichment(prisma, {
    dryRun: false,
    usarGlobal: false,
    limite: 50,
    classificar: respostaCom(crus),
    verificar: respostaCom(crus),
    classificarUtilizacoes: respostaCom(crus),
    verificarUtilizacoes: respostaCom(crus),
    promover: async () => {
      throw new Error("promoção não interessa a este teste");
    },
  });
  return { r, caches, sqls };
}

/** A soma que tem de fechar em TODAS as corridas. */
const semDestino = (r: Awaited<ReturnType<typeof correr>>["r"]) =>
  r.residualLido -
  (r.jaConhecidosGlobal +
    r.excluidosBaixaCobertura +
    r.excluidosOpacos +
    r.enviadosAoModelo +
    r.propagados +
    r.dependentesOrfaos +
    r.semContexto +
    r.foraDaJanela);

// Este ficheiro compila para CommonJS: sem top-level await.
async function main(): Promise<void> {
  // ═══════════════════════════════════════════════════════════════════
  console.log("\n=== representante APPLY, dependente APPLY: escreve-se ===");
  {
    const rep = irmao(2_000_001);
    const dep = irmao(2_000_002);
    const { r, caches } = await correr([rep, dep], [ctx(rep), ctx(dep)], [cru(2_000_001)]);

    check(r.enviadosAoModelo === 1, `só o representante foi ao modelo (${r.enviadosAoModelo})`);
    check(r.propagados === 1, `o dependente foi propagado (${r.propagados})`);
    check(r.propagadosSemEscrita === 0, "…e a decisão herdada escreve");
    const c = caches.find((x) => x.cnp === dep.cnp);
    check(c?.persistido === true, "cache do dependente: persistido = true", JSON.stringify(c));
    check(c?.origem === "PROPAGADO" && c?.propagadoDeCnp === rep.cnp, "…com proveniência a apontar ao representante");
    check(semDestino(r) === 0, `reconciliação fecha (${semDestino(r)})`);
  }

  console.log("\n=== representante SKIP: a recusa propaga-se ===");
  {
    // Sem utilizações na resposta e com o produto já classificado, o gate
    // devolve SKIP — "nenhuma utilização segura a acrescentar", que é o
    // motivo real dos LOVENOX.
    const rep = irmao(2_000_001, {
      estrato: "SEM_UTILIZACOES",
      categoriaAtual: "MEDICAMENTOS",
      subcategoriaAtual: "Cardiovascular",
    });
    const dep = irmao(2_000_002, {
      estrato: "SEM_UTILIZACOES",
      categoriaAtual: "MEDICAMENTOS",
      subcategoriaAtual: "Cardiovascular",
    });
    const { r, caches } = await correr(
      [rep, dep],
      [ctx(rep), ctx(dep)],
      [cru(2_000_001, { utilizacoes: [], sugestaoCategoria: "MEDICAMENTOS" })],
    );

    check(r.skip === 1, `o representante levou SKIP (${r.skip})`);
    check(r.propagados === 1, `o dependente foi contado (${r.propagados})`);
    check(r.propagadosSemEscrita === 1, "…como decisão que NÃO escreve");
    const c = caches.find((x) => x.cnp === dep.cnp);
    check(c !== undefined, "o dependente FICOU com linha de cache");
    check(c?.persistido === false, "…com persistido = false");
    check(
      (c?.motivo ?? "").includes("não aplicável (SKIP)"),
      "…e um motivo que nomeia a recusa do representante",
      String(c?.motivo),
    );
    check(c?.propagadoDeCnp === rep.cnp, "…e aponta ao representante que recusou");
    check(semDestino(r) === 0, `reconciliação fecha (${semDestino(r)})`);
  }

  console.log("\n=== representante REVIEW: a recusa propaga-se na mesma ===");
  {
    const rep = irmao(2_000_001, {
      estrato: "SEM_UTILIZACOES",
      categoriaAtual: "MEDICAMENTOS",
      subcategoriaAtual: "Cardiovascular",
    });
    const dep = irmao(2_000_002, {
      estrato: "SEM_UTILIZACOES",
      categoriaAtual: "MEDICAMENTOS",
      subcategoriaAtual: "Cardiovascular",
    });
    // Discordância forte: o modelo põe o produto noutro nível 1.
    const { r, caches } = await correr(
      [rep, dep],
      [ctx(rep), ctx(dep)],
      [cru(2_000_001, { sugestaoCategoria: "COSMÉTICA" })],
    );

    check(r.review === 1, `o representante levou REVIEW (${r.review})`);
    const c = caches.find((x) => x.cnp === dep.cnp);
    check(c?.persistido === false, "cache do dependente: persistido = false", JSON.stringify(c));
    check(
      (c?.motivo ?? "").includes("não aplicável (REVIEW)"),
      "…com o motivo a dizer REVIEW e não SKIP",
      String(c?.motivo),
    );
    check(r.propagados === 1 && r.propagadosSemEscrita === 1, "contado, e contado como sem escrita");
    check(semDestino(r) === 0, `reconciliação fecha (${semDestino(r)})`);
  }

  console.log("\n=== representante APPLY, gate PRÓPRIO do dependente recusa ===");
  {
    // O caso do defeito 2. O representante está em Cardiovascular e o
    // dependente em COSMÉTICA: para o representante a proposta do modelo
    // concorda com o nível 1 e passa; para o dependente é uma anomalia e
    // o gate dele devolve REVIEW. Nada é escrito no dependente.
    //
    // A divergência é forçada por fixture — o contexto e a linha do
    // residual são lidos por consultas diferentes e aqui discordam de
    // propósito. O que se está a guardar é o INVARIANTE, não a
    // frequência do gatilho: a cache não pode dizer "persistido" quando
    // não se escreveu nada.
    const rep = irmao(2_000_001, {
      estrato: "SEM_UTILIZACOES",
      categoriaAtual: "MEDICAMENTOS",
      subcategoriaAtual: "Cardiovascular",
    });
    const dep = irmao(2_000_002, {
      estrato: "SEM_UTILIZACOES",
      categoriaAtual: "COSMÉTICA",
      subcategoriaAtual: "Cardiovascular",
    });
    const contexto = [
      ctx(rep),
      // No contexto os dois estão na MESMA classificação — senão a
      // família entrava em conflito e não propagava de todo.
      ctx(dep, { nivel1: "MEDICAMENTOS", nivel2: "Cardiovascular" }),
    ];
    const { r, caches } = await correr(
      [rep, dep],
      contexto,
      [cru(2_000_001, { sugestaoCategoria: "MEDICAMENTOS" })],
    );

    check(r.apply === 1, `o representante foi APPLY (${r.apply})`);
    check(r.propagados === 1, `e o dependente É contado (${r.propagados})`);
    check(r.propagadosSemEscrita === 1, "…como decisão que não escreve");
    const c = caches.find((x) => x.cnp === dep.cnp);
    check(c?.persistido === false, "cache do dependente: persistido = FALSE, não true", JSON.stringify(c));
    check(
      (c?.motivo ?? "").includes("gate próprio"),
      "…e o motivo diz que foi o gate próprio a recusar",
      String(c?.motivo),
    );
    check(semDestino(r) === 0, `reconciliação fecha (${semDestino(r)})`);
  }

  console.log("\n=== representante sem resposta: órfão, e NÃO terminal ===");
  {
    const rep = irmao(2_000_001);
    const dep = irmao(2_000_002);
    // O modelo devolve um lote vazio: o representante nunca teve decisão.
    const { r, caches } = await correr([rep, dep], [ctx(rep), ctx(dep)], []);

    check(r.dependentesOrfaos === 1, `o dependente é órfão (${r.dependentesOrfaos})`);
    check(r.propagados === 0, "…e NÃO é contado como propagado — não houve decisão para herdar");
    check(caches.length === 0, "…e não ficou com cache nenhuma: volta ao residual, e é o que deve acontecer");
    check(semDestino(r) === 0, `reconciliação fecha na mesma (${semDestino(r)})`);
  }

  console.log("\n=== produto do residual sem contexto: contado, nunca mudo ===");
  {
    const a = irmao(2_000_001, { designacao: "Zetaaa" });
    const b = irmao(2_000_002, { designacao: "Zetaab" });
    // `b` não existe no contexto: `preselecionar` não lhe sabe dar destino.
    const { r } = await correr([a, b], [ctx(a)], [cru(2_000_001)]);

    check(r.semContexto === 1, `contado (${r.semContexto})`);
    check(r.cnpsSemContexto.includes(2_000_002), "…e o cnp é identificável no resumo");
    check(
      r.avisos.some((x) => x.includes("sem linha no contexto")),
      "…e há aviso explícito",
      r.avisos.join(" | "),
    );
    check(semDestino(r) === 0, `reconciliação fecha (${semDestino(r)})`);
  }

  console.log("\n=== a fila lê o `persistido` da cache, não a existência dela ===");
  {
    const rep = irmao(2_000_001, {
      estrato: "SEM_UTILIZACOES",
      categoriaAtual: "MEDICAMENTOS",
      subcategoriaAtual: "Cardiovascular",
    });
    const dep = irmao(2_000_002, {
      estrato: "SEM_UTILIZACOES",
      categoriaAtual: "MEDICAMENTOS",
      subcategoriaAtual: "Cardiovascular",
    });
    const { sqls } = await correr(
      [rep, dep],
      [ctx(rep), ctx(dep)],
      [cru(2_000_001, { utilizacoes: [], sugestaoCategoria: "MEDICAMENTOS" })],
    );
    const fecho = sqls.find((s) => s.includes('update "EnriquecimentoFila"') && s.includes("k.persistido"));
    check(fecho !== undefined, "a fila é fechada por uma consulta que olha para k.persistido");
    check(
      (fecho ?? "").includes("when k.persistido then 'SUCESSO'"),
      "…SUCESSO só quando persistido",
    );
    check(
      (fecho ?? "").includes("else 'REVISAO_NECESSARIA'"),
      "…e REVISAO_NECESSARIA quando não. Um dependente recusado NÃO sai como sucesso.",
    );
  }

  console.log("\n=== segunda passagem: uma decisão terminal não volta a pagar ===");
  {
    // A cláusula da cache no residual não olha para `persistido`: uma
    // linha desta versão basta para o produto não voltar. É isso que
    // torna terminal a recusa herdada — e é isso que faltava aos
    // dependentes, que não ficavam com linha nenhuma.
    const sql = corpoResidual();
    check(
      sql.includes('from "KnowledgeEnrichmentCache" k') && sql.includes("k.versao = $2"),
      "o residual exclui quem tem cache desta versão",
    );
    check(
      !/k\.persistido/.test(sql),
      "…e exclui INDEPENDENTEMENTE de persistido — recusa documentada também é decisão",
    );
  }

  console.log("\n=== condicionais NÃO recebem cache terminal ===");
  {
    // Baixa cobertura e opacidade dependem dos dados do tenant e têm de
    // poder voltar quando os dados mudarem. O que não podem é gastar API
    // nem ocupar a janela — isso é assunto do test-janela-residual.
    const opaco = irmao(2_000_001, { designacao: "-" });
    const bom = irmao(2_000_002, { designacao: "Zetaab" });
    const { r, caches } = await correr(
      [opaco, bom],
      [ctx(opaco), ctx(bom)],
      [cru(2_000_002)],
    );
    check(r.excluidosOpacos === 1, `o opaco foi excluído (${r.excluidosOpacos})`);
    check(!caches.some((c) => c.cnp === opaco.cnp), "…e NÃO ficou com cache: pode voltar se a designação melhorar");
    check(r.enviadosAoModelo === 1, "…e não consumiu chamada");
    check(semDestino(r) === 0, `reconciliação fecha (${semDestino(r)})`);
  }
}

// ─────────────────────────────────────────────────────────────────────
// CONTROLO NEGATIVO — medido, não afirmado
//
// Cada troço do código anterior, reposto sozinho, com o resultado real
// desta suíte (42 ok / 0 falhas no código corrigido):
//
//   propagação da recusa removida (`if (gate.decisao !== "APPLY")`)
//        31 ok / 11 falhas
//   `gravarCache(…, true, …)` fixo no ramo APPLY
//        40 ok /  2 falhas
//   contador só no APPLY (`if (efectivo.decisao === "APPLY")`)
//        39 ok /  3 falhas   — e a reconciliação acusa 1 sem destino
//   `if (!pre) continue` mudo (runner + janela)
//        38 ok /  4 falhas   — e a reconciliação acusa 1 sem destino
//
// Nos dois últimos casos foi a própria reconciliação a denunciar o
// buraco, que é exactamente para o que ela existe.
// ────────────────────────────────────────────────────────────────────

main().then(() => {
  console.log(`\n${pass} ok, ${fail} falhas`);
  process.exit(fail === 0 ? 0 : 1);
});
