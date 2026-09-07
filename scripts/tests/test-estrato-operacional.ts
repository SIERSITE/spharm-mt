/**
 * scripts/tests/test-estrato-operacional.ts
 *
 * `--estrato=NAO_CLASSIFICADO` tem de significar «até N produtos DESSE
 * estrato», e não «N lidos de onde calhar, dos quais uns quantos são».
 *
 * ── O problema operacional que isto resolve ──────────────────────────
 *
 * O residual tem três estratos e não está equilibrado. Na Garantia, uma
 * corrida de 2 000 gastou:
 *
 *     1 919  SEM_UTILIZACOES     produtos JÁ classificados, faltam etiquetas
 *        76  NAO_CLASSIFICADO    onde estão os 14 mil por classificar
 *         5  OUTROS_MEDICAMENTOS
 *
 * Não era um defeito: a ordem do residual é por cnp, não por prioridade.
 * O que faltava era poder dizer ao comando qual das três perguntas
 * interessa agora.
 *
 * ── O que este teste afirma ──────────────────────────────────────────
 *
 * Que o filtro é aplicado em SQL, DENTRO de `corpoResidual`, e portanto
 * antes de a janela ser enchida. É a diferença entre o limite contar
 * produtos do estrato e contar leituras — e é a única propriedade que
 * torna o `--limite=2000` útil para o objectivo.
 *
 * E que o filtro não toca em mais nada: gate, propagação e contabilidade
 * ficam exactamente como estão.
 *
 * Corre com:  npm run test:estrato-operacional
 */
import { readFileSync } from "node:fs";
import {
  corpoResidual,
  runKnowledgeEnrichment,
  type Estrato,
  type RunnerResumo,
} from "../../lib/catalog/knowledge-enrichment-runner";
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

/**
 * Designações DISTINTAS, e alfabéticas.
 *
 * As duas propriedades são necessárias e por razões diferentes:
 *
 *   · distintas — designações que só diferem no número colapsam numa
 *     família só, e a janela devolve 1 representante e N dependentes em
 *     vez de N processáveis. Foi assim que a primeira versão deste teste
 *     mediu «1 enviado» em vez de 10;
 *   · alfabéticas com palavras de 3+ letras — `nomeOpaco` exclui
 *     designações sem conteúdo reconhecível, e um universo todo opaco
 *     não tem processáveis nenhuns.
 *
 * Nada disto é o objecto do teste; é o que é preciso para o objecto do
 * teste — o filtro de estrato — ser observável.
 */
const AB = "abcdefghijklmnopqrstuvwxyz";
const palavra = (i: number) =>
  `${AB[i % 26]}${AB[Math.floor(i / 26) % 26]}${AB[Math.floor(i / 676) % 26]}ol`;
let seq = 0;

const produto = (cnp: number, estrato: Estrato): Linha => ({
  cnp,
  designacao: `${palavra(seq++)} ${palavra(seq + 999)}`,
  productType: null,
  categoriaAtual: estrato === "NAO_CLASSIFICADO" ? null : "MEDICAMENTOS",
  subcategoriaAtual:
    estrato === "NAO_CLASSIFICADO"
      ? null
      : estrato === "OUTROS_MEDICAMENTOS"
      ? "Outros Medicamentos"
      : "Diabetes",
  estrato,
});

/**
 * Prisma que APLICA o filtro de estrato lendo-o do SQL.
 *
 * É o ponto do teste: em vez de assumir que o runner filtra, verifica-se
 * que o SQL que ele monta contém a condição — e o duplo obedece-lhe. Um
 * fake que devolvesse sempre o mesmo passaria com um runner que não
 * filtra nada.
 */
function prismaFalso(universo: Linha[]) {
  const sqlsResidual: string[] = [];
  return {
    sqlsResidual,
    prisma: {
      $queryRawUnsafe: async (sql: string, ...params: unknown[]) => {
        if (/as nivel1/i.test(sql)) {
          return universo.map((p) => ({
            cnp: p.cnp,
            designacao: p.designacao,
            nivel1: p.categoriaAtual,
            nivel2: p.subcategoriaAtual,
            utilizacoes: [] as string[],
          }));
        }
        if (/from "Classificacao"/i.test(sql)) {
          return [
            { id: "n1", nome: "MEDICAMENTOS", pai: null },
            { id: "n2", nome: "Diabetes", pai: "n1" },
          ];
        }
        if (/from "Utilizacao"/i.test(sql)) return [{ id: "u1", slug: "diabetes" }];
        if (/information_schema\.columns/i.test(sql)) return [{ n: 2 }];

        // O filtro de estrato, lido do SQL que o runner montou.
        const filtra = (l: Linha): boolean => {
          if (/classificacaoNivel2Id" is null\s*\)?\s*$/m.test(sql) === false) {
            // fallthrough — decidido pelos testes abaixo
          }
          if (sql.includes(`and p."classificacaoNivel2Id" is null`) && !sql.includes("or c2.nome ilike")) {
            return l.estrato === "NAO_CLASSIFICADO";
          }
          if (sql.includes(`c2.nome ilike 'Outros %'`) && sql.includes("is not null")) {
            return l.estrato === "OUTROS_MEDICAMENTOS";
          }
          if (sql.includes("not ilike 'Outros %'")) {
            return l.estrato === "SEM_UTILIZACOES";
          }
          return true;
        };

        if (/count\(/i.test(sql)) {
          sqlsResidual.push(sql);
          return [{ n: universo.filter(filtra).length }];
        }
        sqlsResidual.push(sql);
        const cursor = Number(params[4] ?? 0);
        const limite = Number(params[3] ?? 0);
        return universo
          .filter(filtra)
          .filter((l) => l.cnp > cursor)
          .sort((a, b) => a.cnp - b.cnp)
          .slice(0, limite);
      },
      $executeRawUnsafe: async () => 1,
      knowledgeEnrichmentCache: { upsert: async () => ({}) },
      produto: { findUnique: async () => null },
      filaRevisao: { findFirst: async () => null, create: async () => ({}), update: async () => ({}) },
      produtoFarmacia: { findFirst: async () => null },
    } as unknown as PrismaClient,
  };
}

const resposta = async (produtos: { cnp: number }[]) => ({
  resultados: produtos.map((p) => ({
    cnp: p.cnp,
    productType: "MEDICAMENTO",
    categoria: "MEDICAMENTOS",
    subcategoria: "Diabetes",
    utilizacoes: ["diabetes"],
    confidence: 0.95,
    evidenceType: "SUBSTANCIA_CONHECIDA",
    rationale: ".",
    confidenceClinica: 0,
  })) as unknown as KnowledgeResult[],
  usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
});

async function correr(universo: Linha[], estrato: Estrato | undefined, limite: number) {
  const { prisma, sqlsResidual } = prismaFalso(universo);
  const r: RunnerResumo = await runKnowledgeEnrichment(prisma, {
    dryRun: true,
    usarGlobal: false,
    limite,
    estrato,
    classificar: resposta,
    verificar: resposta,
    classificarUtilizacoes: resposta,
    verificarUtilizacoes: resposta,
    promover: async () => {
      throw new Error("promoção não interessa a este teste");
    },
  });
  return { r, sqlsResidual };
}

// Este ficheiro compila para CommonJS: sem top-level await.
async function main(): Promise<void> {
  // ══════════════════════════════════════════════════════════════════
  // A · O SQL leva mesmo o filtro
  // ══════════════════════════════════════════════════════════════════
  console.log("\nA · corpoResidual filtra por estrato");
  {
    const sem = corpoResidual(undefined, false, false);
    const nc = corpoResidual("NAO_CLASSIFICADO", false, false);
    const om = corpoResidual("OUTROS_MEDICAMENTOS", false, false);
    const su = corpoResidual("SEM_UTILIZACOES", false, false);

    check(
      nc.includes(`and p."classificacaoNivel2Id" is null`) && !nc.includes("or c2.nome ilike"),
      "NAO_CLASSIFICADO → só o ramo do nível 2 nulo",
    );
    check(om.includes(`c2.nome ilike 'Outros %'`), "OUTROS_MEDICAMENTOS → só o ramo do balde");
    check(su.includes("not ilike 'Outros %'"), "SEM_UTILIZACOES → só o ramo das utilizações");
    check(
      sem.includes("or c2.nome ilike") && sem.includes("or not exists"),
      "sem filtro → os três ramos, como sempre",
    );
    // A propriedade que torna o limite útil: o filtro está no WHERE, não
    // numa filtragem posterior em memória.
    check(
      nc.includes("where") && nc.indexOf("where") < nc.indexOf(`classificacaoNivel2Id" is null`),
      "o filtro vive no WHERE — aplicado ANTES de a janela ser enchida",
    );
  }

  // ══════════════════════════════════════════════════════════════════
  // B · O limite conta produtos DO estrato
  // ══════════════════════════════════════════════════════════════════
  console.log("\nB · --limite conta produtos do estrato pedido");
  {
    // O desequilíbrio real da Garantia, em miniatura — e maior do que a
    // página de leitura (250), senão a janela engole o universo inteiro
    // e o corte nunca chega a morder, que é justamente o efeito a medir.
    const universo: Linha[] = [
      ...Array.from({ length: 400 }, (_, i) => produto(2_000_100 + i, "SEM_UTILIZACOES")),
      ...Array.from({ length: 50 }, (_, i) => produto(2_001_000 + i, "NAO_CLASSIFICADO")),
    ];

    // O custo do desequilíbrio NÃO é a janela nunca chegar ao estrato —
    // chega. É ter de ATRAVESSAR o resto para lá chegar: 400 linhas lidas,
    // pré-seleccionadas e descartadas para render 10 úteis. Numa base com
    // 35 mil produtos isso é a diferença entre um lote e uma tarde.
    const semFiltro = await correr(universo, undefined, 10);
    check(
      semFiltro.r.residualLido > 400,
      `sem filtro, leram-se ${semFiltro.r.residualLido} linhas para chegar ao estrato`,
      JSON.stringify(semFiltro.r.porEstrato),
    );

    const comFiltro = await correr(universo, "NAO_CLASSIFICADO", 10);
    check(
      (comFiltro.r.porEstrato["NAO_CLASSIFICADO"] ?? 0) === 10,
      "com --estrato, os 10 são todos NAO_CLASSIFICADO",
      JSON.stringify(comFiltro.r.porEstrato),
    );
    check(
      (comFiltro.r.porEstrato["SEM_UTILIZACOES"] ?? 0) === 0,
      "…e nenhum SEM_UTILIZACOES entra na janela",
    );
    check(
      comFiltro.r.residualLido < semFiltro.r.residualLido,
      `…lendo ${comFiltro.r.residualLido} linhas em vez de ${semFiltro.r.residualLido} para o mesmo rendimento`,
    );
    // Deliberadamente NÃO se afirma quantos vão ao modelo: isso depende
    // da pré-selecção (famílias, opacidade, cobertura), que este teste
    // não exercita nem deve exercitar. O que se afirma é que a janela é
    // toda do estrato pedido — a propriedade que o `--estrato` promete.
    const total = Object.values(comFiltro.r.porEstrato).reduce((a, b) => a + b, 0);
    check(
      total === (comFiltro.r.porEstrato["NAO_CLASSIFICADO"] ?? 0),
      `a janela é 100% do estrato pedido (${total} linhas)`,
      JSON.stringify(comFiltro.r.porEstrato),
    );
  }

  // ══════════════════════════════════════════════════════════════════
  // C · A contabilidade continua a fechar
  // ══════════════════════════════════════════════════════════════════
  console.log("\nC · reconciliação e idempotência intactas");
  {
    const universo: Linha[] = [
      ...Array.from({ length: 300 }, (_, i) => produto(2_000_100 + i, "SEM_UTILIZACOES")),
      ...Array.from({ length: 20 }, (_, i) => produto(2_001_000 + i, "NAO_CLASSIFICADO")),
    ];
    const { r } = await correr(universo, "NAO_CLASSIFICADO", 5);

    const semDestino =
      r.residualLido -
      (r.jaConhecidosGlobal +
        r.excluidosBaixaCobertura +
        r.excluidosOpacos +
        r.enviadosAoModelo +
        r.propagados +
        r.dependentesOrfaos +
        r.semContexto +
        r.foraDaJanela);
    check(semDestino === 0, `todo o produto lido tem destino (${semDestino})`);

    // O residual lido não inclui os do outro estrato: o filtro é de
    // leitura, não um descarte depois de ler. É o que evita pagar a
    // paginação de 14 mil linhas para tratar 2 000.
    check(
      r.residualLido <= 20,
      `só se leram linhas do estrato pedido (${r.residualLido} ≤ 20)`,
    );
  }

  // ══════════════════════════════════════════════════════════════════
  // D · O CLI valida, e recusa em vez de ignorar
  // ══════════════════════════════════════════════════════════════════
  console.log("\nD · o comando não deixa passar um estrato mal escrito");
  {
    const cli = readFileSync("scripts/catalog-master/knowledge-enrich.ts", "utf8");
    check(cli.includes('--estrato='), "o CLI aceita --estrato=");
    check(
      cli.includes("não é um estrato válido"),
      "…e recusa um nome inválido em vez de o tratar como «sem filtro»",
    );
    check(
      cli.includes("--canary e --estrato são incompatíveis"),
      "…e recusa a combinação com --canary, que tem quotas próprias",
    );
    check(
      cli.includes("estrato,") && cli.includes("runKnowledgeEnrichment"),
      "…e passa-o ao runner",
    );
  }

  console.log(`\n${ok} ok, ${ko} falhas`);
  process.exit(ko === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
