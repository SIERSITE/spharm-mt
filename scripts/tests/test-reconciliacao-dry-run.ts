/**
 * scripts/tests/test-reconciliacao-dry-run.ts
 *
 * Todo o produto lido tem de receber um destino contabilizado — e o
 * número tem de ser o MESMO com ou sem escrita.
 *
 * ── O defeito que isto guarda ────────────────────────────────────────
 *
 * O canary da Garantia (dry-run, 505 produtos lidos) fechou com:
 *
 *     505 lidos = 3 global + 65 enviados + 11 propagados + 421 fora
 *               = 500                                    ← faltam 5
 *
 * Os 5 eram dependentes cujos representantes voltaram com REVIEW ou SKIP.
 * A contagem deles vivia no bloco de escrita, ABAIXO do `continue` do
 * dry-run — inalcançável quando não se escreve. E o representante estava
 * em `comResultado`, portanto o bloco dos órfãos também os saltava.
 *
 * Passavam entre as duas redes, e só em dry-run. Foi por isso que as
 * corridas `--apply` da Silveira nunca o mostraram.
 *
 * ── A asserção que fecha isto para sempre ────────────────────────────
 *
 * Não basta testar que o dry-run fecha. O que se afirma é mais forte: a
 * contabilidade é IDÊNTICA nos dois modos, sobre os mesmos dados. Se um
 * dia a contagem voltar a viver dentro de um ramo condicional, este teste
 * acusa — mesmo que o total, por acaso, ainda feche.
 *
 * Corre com:  npm run test:reconciliacao-dry-run
 */
import { runKnowledgeEnrichment, type RunnerResumo } from "../../lib/catalog/knowledge-enrichment-runner";
import type { KnowledgeResult } from "../../lib/catalog/knowledge-enrichment";
import type { PrismaClient } from "../../generated/prisma/client";

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, extra?: string) => {
  if (cond) {
    ok++;
    console.log(`  [OK]    ${label}`);
  } else {
    ko++;
    console.log(`  [FALHA] ${label}${extra ? `  — ${extra}` : ""}`);
  }
};

type Linha = {
  cnp: number;
  designacao: string;
  productType: string | null;
  categoriaAtual: string | null;
  subcategoriaAtual: string | null;
  estrato: string;
};

const irmao = (cnp: number): Linha => ({
  cnp,
  designacao: "Movalis Comprimidos",
  productType: null,
  categoriaAtual: null,
  subcategoriaAtual: null,
  estrato: "NAO_CLASSIFICADO",
});

const ctx = (l: Linha) => ({
  cnp: l.cnp,
  designacao: l.designacao,
  nivel1: l.categoriaAtual,
  nivel2: l.subcategoriaAtual,
});

/**
 * Prisma que nunca escreve.
 *
 * Em dry-run isso é a garantia que interessa; em `--apply` a escrita não
 * é o objecto deste teste — o que se compara é a CONTAGEM, e ela não pode
 * depender de o `upsert` ter acontecido.
 */
function prismaFalso(residual: Linha[], contexto: ReturnType<typeof ctx>[]) {
  return {
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
    $executeRawUnsafe: async () => 1,
    knowledgeEnrichmentCache: { upsert: async () => ({}) },
    produto: { findUnique: async () => null },
    filaRevisao: { findFirst: async () => null, create: async () => ({}), update: async () => ({}) },
    produtoFarmacia: { findFirst: async () => null },
  } as unknown as PrismaClient;
}

const resposta = (crus: Array<Record<string, unknown>>) => async () => ({
  resultados: crus as unknown as KnowledgeResult[],
  usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
});

async function correr(
  residual: Linha[],
  crus: Array<Record<string, unknown>>,
  dryRun: boolean,
): Promise<RunnerResumo> {
  const prisma = prismaFalso(residual, residual.map(ctx));
  const chamada = resposta(crus);
  return runKnowledgeEnrichment(prisma, {
    dryRun,
    usarGlobal: false,
    limite: 50,
    classificar: chamada,
    verificar: chamada,
    classificarUtilizacoes: chamada,
    verificarUtilizacoes: chamada,
    promover: async () => {
      throw new Error("promoção não interessa a este teste");
    },
  });
}

/** A soma que tem de fechar em TODAS as corridas, nos dois modos. */
const semDestino = (r: RunnerResumo) =>
  r.residualLido -
  (r.jaConhecidosGlobal +
    r.excluidosBaixaCobertura +
    r.excluidosOpacos +
    r.enviadosAoModelo +
    r.propagados +
    r.dependentesOrfaos +
    r.semContexto +
    r.foraDaJanela);

/** Os contadores de destino, para comparar dry-run com apply. */
const destinos = (r: RunnerResumo) => ({
  lidos: r.residualLido,
  global: r.jaConhecidosGlobal,
  baixaCobertura: r.excluidosBaixaCobertura,
  opacos: r.excluidosOpacos,
  enviados: r.enviadosAoModelo,
  propagados: r.propagados,
  propagadosSemEscrita: r.propagadosSemEscrita,
  orfaos: r.dependentesOrfaos,
  semContexto: r.semContexto,
  fora: r.foraDaJanela,
});

// Este ficheiro compila para CommonJS: sem top-level await.
async function main(): Promise<void> {
  // Os três desfechos possíveis do representante. O primeiro sempre
  // funcionou; os outros dois eram os que perdiam o dependente.
  const CASOS: Array<[string, Record<string, unknown>]> = [
    [
      "representante APPLY",
      {
        categoria: "MEDICAMENTOS",
        subcategoria: "Diabetes",
        confidence: 0.95,
        evidenceType: "SUBSTANCIA_CONHECIDA",
        utilizacoes: ["diabetes"],
        rationale: "Meloxicam.",
      },
    ],
    [
      "representante REVIEW (evidência não autoriza)",
      {
        categoria: "MEDICAMENTOS",
        subcategoria: "Diabetes",
        confidence: 0.5,
        evidenceType: "SUBSTANCIA_CONHECIDA",
        utilizacoes: [],
        rationale: "sem certeza.",
      },
    ],
    [
      "representante SKIP/REVIEW (modelo não reconheceu)",
      {
        categoria: null,
        subcategoria: null,
        confidence: 0.2,
        evidenceType: "DESCONHECIDO",
        utilizacoes: [],
        rationale: "não sei.",
      },
    ],
  ];

  for (const [nome, over] of CASOS) {
    console.log(`\n=== ${nome} ===`);
    const rep = irmao(2_000_001);
    const dep = irmao(2_000_002);
    const crus = [{ cnp: rep.cnp, productType: "MEDICAMENTO", confidenceClinica: 0, ...over }];

    const seco = await correr([rep, dep], crus, true);
    const molhado = await correr([rep, dep], crus, false);

    check(
      semDestino(seco) === 0,
      `dry-run: todo o produto lido tem destino (${semDestino(seco)})`,
      JSON.stringify(destinos(seco)),
    );
    check(
      semDestino(molhado) === 0,
      `apply:   todo o produto lido tem destino (${semDestino(molhado)})`,
      JSON.stringify(destinos(molhado)),
    );

    // A asserção forte: os dois modos contam IGUAL. É esta que apanha uma
    // contagem que volte a viver dentro de um ramo condicional, mesmo que
    // o total feche por outra via.
    check(
      JSON.stringify(destinos(seco)) === JSON.stringify(destinos(molhado)),
      "…e os dois modos contam exactamente o mesmo",
      `seco=${JSON.stringify(destinos(seco))}\n            molhado=${JSON.stringify(destinos(molhado))}`,
    );

    // O dependente existe e foi contado — não é um zero a fazer a soma
    // fechar por ausência.
    check(
      seco.propagados === 1,
      `o dependente foi contado como propagado (${seco.propagados})`,
    );
  }

  // ── O caso do defeito, nomeado ──────────────────────────────────────
  console.log("\n=== o dependente de um representante recusado NÃO desaparece ===");
  {
    const rep = irmao(2_000_001);
    const dep = irmao(2_000_002);
    const crus = [
      {
        cnp: rep.cnp,
        productType: "MEDICAMENTO",
        categoria: null,
        subcategoria: null,
        confidence: 0.2,
        evidenceType: "DESCONHECIDO",
        utilizacoes: [],
        rationale: "não sei.",
        confidenceClinica: 0,
      },
    ];
    const r = await correr([rep, dep], crus, true);

    check(r.enviadosAoModelo === 1, `só o representante foi ao modelo (${r.enviadosAoModelo})`);
    check(r.propagados === 1, `o dependente foi contado (${r.propagados})`);
    check(
      r.propagadosSemEscrita === 1,
      `…e contado como decisão que NÃO escreve (${r.propagadosSemEscrita})`,
    );
    check(
      r.dependentesOrfaos === 0,
      `…e NÃO como órfão: o representante teve decisão (${r.dependentesOrfaos})`,
    );
    check(semDestino(r) === 0, `a reconciliação fecha (${semDestino(r)})`);
  }

  // ── A contagem não pode voltar a viver dentro de um ramo ────────────
  console.log("\n=== a contagem está acima da fronteira do dry-run ===");
  {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("lib/catalog/knowledge-enrichment-runner.ts", "utf8");
    const iContagem = src.indexOf("const dependentesRecusados");
    const iFronteira = src.indexOf("FRONTEIRA DO DRY-RUN");
    check(
      iContagem > 0 && iFronteira > 0 && iContagem < iFronteira,
      "a contagem dos dependentes recusados precede a fronteira",
      `contagem=${iContagem} fronteira=${iFronteira}`,
    );
    // E a escrita continua abaixo — a fronteira não foi enfraquecida.
    const iGravar = src.indexOf('"PROPAGADO",\n          r.cnp,'.replace("\n", "\r\n"));
    const iGravar2 = src.indexOf("representante ${r.cnp} não aplicável");
    check(
      iGravar2 > iFronteira,
      "…e a gravação da cache continua abaixo dela",
      `gravar=${iGravar2 >= 0 ? iGravar2 : iGravar} fronteira=${iFronteira}`,
    );
  }

  console.log(`\n${ok} ok, ${ko} falhas`);
  process.exit(ko === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
