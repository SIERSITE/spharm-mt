/**
 * scripts/tests/test-runner-promocao-clinica.ts
 *
 * O TESTE QUE FALTAVA.
 *
 * ─────────────────────────────────────────────────────────────────────
 * O DEFEITO QUE ISTO GUARDA
 *
 * `juntarCandidato`, no knowledge-enrichment-runner, foi escrito antes de
 * o catálogo global transportar clínica. Nunca preenchia
 * `ConhecimentoCandidato.clinica`. Como o campo era OPCIONAL, o
 * compilador não tinha nada a dizer — um campo opcional em falta é um
 * campo omitido, não um erro.
 *
 * O defeito só apareceu num E2E em produção, e apareceu pelos autores das
 * duas escritas no rasto de auditoria:
 *
 *   13:09:05.640  catalog:knowledge-enrich  classificação
 *   13:09:05.673  job:enrich-catalog        clínica ×5   ← outra fase
 *
 * Trinta e três milissegundos e dois processos diferentes. A fase 5 do
 * ciclo tapava o buraco no caminho do job. No runner isolado — o CLI
 * `catalog:knowledge-enrich`, que é como o backlog de dezenas de milhares
 * de produtos corre — não há fase 5, e a clínica acabada de pagar não
 * subia ao catálogo nacional.
 *
 * Estas asserções falham no código anterior e passam no corrigido. É essa
 * a única prova que interessa de um teste de regressão.
 *
 * Sem base de dados e sem rede: a promoção é injectada, pelo mesmo
 * mecanismo que já existia para `classificar` e `verificar`. O que se
 * verifica é a ESTRUTURA do candidato, não a persistência dele.
 *
 * Uso: npx tsx scripts/tests/test-runner-promocao-clinica.ts
 */
import { runKnowledgeEnrichment } from "../../lib/catalog/knowledge-enrichment-runner";
import { LIMIAR_CLINICO } from "../../lib/catalog/knowledge-enrichment";
import type { CampoClinico, ConhecimentoCandidato } from "../../lib/catalog/global-catalog";
import type { ResultadoPromocao } from "../../lib/catalog/global-catalog-store";
import { avaliarClinica, type ClinicaGlobal } from "../../lib/catalog/global-catalog";

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

type LinhaResidual = {
  cnp: number;
  designacao: string;
  productType: string | null;
  categoriaAtual: string | null;
  subcategoriaAtual: string | null;
  estrato: string;
};

/**
 * Prisma que aceita as escritas e as regista, para o runner poder correr
 * com `--apply`. Não valida SQL: o que se testa aqui é o que sai para a
 * promoção, não o que entra na base.
 */
function prismaFalso(residual: LinhaResidual[], escritas: string[]) {
  return {
    $queryRawUnsafe: async (sql: string) => {
      if (/as nivel1/i.test(sql)) {
        // Contexto para famílias/cobertura: os mesmos produtos.
        return residual.map((r) => ({
          cnp: r.cnp,
          designacao: r.designacao,
          nivel1: r.categoriaAtual,
          nivel2: r.subcategoriaAtual,
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
      if (/count\(/i.test(sql)) return [{ n: residual.length }];
      return residual;
    },
    $executeRawUnsafe: async (sql: string) => {
      escritas.push(sql.slice(0, 60).replace(/\s+/g, " "));
      return 1;
    },
    knowledgeEnrichmentCache: { upsert: async () => ({}) },
    enriquecimentoFila: { updateMany: async () => ({ count: 0 }) },
  };
}

const linha = (cnp: number, designacao: string): LinhaResidual => ({
  cnp,
  designacao,
  productType: null,
  categoriaAtual: null,
  subcategoriaAtual: null,
  estrato: "NAO_CLASSIFICADO",
});

/** Resposta do modelo, completa e clinicamente confiante. */
const cru = (cnp: number, over: Record<string, unknown> = {}) => ({
  cnp,
  productType: "MEDICAMENTO",
  categoria: "MEDICAMENTOS",
  subcategoria: "Diabetes",
  utilizacoes: ["diabetes"],
  confidence: 0.95,
  evidenceType: "SUBSTANCIA_CONHECIDA",
  rationale: "Semaglutido, antidiabético injetável.",
  dci: "Semaglutido",
  codigoATC: "A10BJ06",
  forma: "solução injetável",
  dosagem: "0,25 mg",
  embalagem: "1 caneta",
  confidenceClinica: 0.95,
  ...over,
});

const resposta = (crus: Array<Record<string, unknown>>) => async () => ({
  resultados: crus,
  usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
});

const RESULTADO_VAZIO: ResultadoPromocao = {
  produtosPromovidos: 0,
  classificacoesPromovidas: 0,
  utilizacoesPromovidas: 0,
  recusasClassificacao: 0,
  recusasUtilizacao: 0,
  aguardamAprovacao: 0,
  porOrigemClassificacao: {},
  porOrigemUtilizacao: {},
  motivosClassificacao: {},
  motivosUtilizacao: {},
  clinicaPromovida: {},
  clinicaPorOrigem: {},
  motivosClinica: {},
  clinicaTotal: 0,
  recusasClinica: 0,
};

/**
 * Corre o runner e devolve os candidatos que ele mandou promover.
 *
 * `usarGlobal` fica LIGADO, e é preciso que fique: a mesma bandeira
 * governa a consulta ao global E a promoção no fim. Desligá-la — que foi
 * a minha primeira tentativa — fazia o teste medir o vazio e passar por
 * omissão, que é a pior maneira de um teste de regressão falhar.
 *
 * A consulta ao control plane falha aqui (não há control plane) e isso é
 * inofensivo: o runner apanha-a, regista um aviso e continua. A promoção
 * é injectada.
 *
 * `tenantSlug` vai sempre preenchido porque o runner exige uma origem
 * para registar — era exactamente isso que faltava no CLI.
 */
async function correr(
  residual: LinhaResidual[],
  crus: Array<Record<string, unknown>>,
): Promise<{ candidatos: ConhecimentoCandidato[]; escritas: string[] }> {
  const escritas: string[] = [];
  const capturados: ConhecimentoCandidato[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prisma = prismaFalso(residual, escritas) as any;
  await runKnowledgeEnrichment(prisma, {
    dryRun: false,
    tenantSlug: "tenant-teste",
    classificar: resposta(crus) as never,
    verificar: resposta(crus) as never,
    promover: (async (cands: readonly ConhecimentoCandidato[]) => {
      capturados.push(...cands);
      return RESULTADO_VAZIO;
    }) as never,
  });
  return { candidatos: capturados, escritas };
}

const clinicaDe = (c: ConhecimentoCandidato | undefined) =>
  new Map((c?.clinica ?? []).map((x) => [x.campo, x]));

// ═════════════════════════════════════════════════════════════════════
async function main(): Promise<void> {
  // ───────────────────────────────────────────────────────────────────
  console.log("\n=== REGRESSÃO: o runner isolado promove TAMBÉM a clínica ===");
  {
    const { candidatos } = await correr([linha(1234567, "Ozempic 0.25 Mg Sol. Injetável")], [cru(1234567)]);

    check(candidatos.length === 1, "houve um candidato a promover", `n=${candidatos.length}`);
    const cl = clinicaDe(candidatos[0]);
    check(cl.size === 5, "…com os CINCO campos clínicos", `n=${cl.size}`);
    for (const campo of ["CODIGO_ATC", "DCI", "FORMA_FARMACEUTICA", "DOSAGEM", "EMBALAGEM"] as CampoClinico[]) {
      check(cl.has(campo), `…inclui ${campo}`);
    }
    check(cl.get("CODIGO_ATC")?.valor === "A10BJ06", "o ATC vai com o valor certo");
    check(cl.get("DCI")?.valor === "Semaglutido", "a DCI vai com o valor certo");
    // A classificação continua a ir — a correcção acrescenta, não troca.
    check(candidatos[0]?.categoria === "MEDICAMENTOS", "a classificação continua a ir");
    check(candidatos[0]?.subcategoria === "Diabetes", "…com a subcategoria específica");
  }

  console.log("\n=== decisão DIRECTA → origem MODELO ===");
  {
    const { candidatos } = await correr([linha(1234567, "Ozempic 0.25 Mg Sol. Injetável")], [cru(1234567)]);
    const cl = clinicaDe(candidatos[0]);
    check(candidatos[0]?.origem === "MODELO", "a classificação é MODELO");
    check(
      [...cl.values()].every((c) => c.origem === "MODELO"),
      "…e TODOS os campos clínicos são MODELO",
    );
    check(
      [...cl.values()].every((c) => c.versaoRegras === "ke-2.0"),
      "…com a versão de regras ke-2.0",
    );
    check(
      [...cl.values()].every((c) => c.confianca === 0.95),
      "…e com a confiança CLÍNICA, não a da classificação",
    );
  }

  console.log("\n=== PROPAGAÇÃO: o irmão sobe, e sobe como PROPAGADO ===");
  {
    // Duas apresentações da mesma marca: família estrita.
    const { candidatos } = await correr(
      [
        linha(1111111, "Ozempic 0.25 Mg Sol. Injetável"),
        linha(2222222, "Ozempic 0.5 Mg Sol. Injetável"),
      ],
      [cru(1111111)],
    );

    const rep = candidatos.find((c) => c.cnp === 1111111);
    const dep = candidatos.find((c) => c.cnp === 2222222);

    check(!!rep, "o representante é candidato");
    check(!!dep, "o DEPENDENTE também é candidato (antes nunca era)");
    check(dep?.origem === "PROPAGADO", "…e a origem dele é PROPAGADO", String(dep?.origem));

    const cd = clinicaDe(dep);
    check(
      [...cd.values()].every((c) => c.origem === "PROPAGADO"),
      "…e a clínica dele também é PROPAGADO",
    );

    console.log("\n=== …mas o irmão NÃO herda a apresentação ===");
    check(cd.has("DCI"), "a DCI propaga — é a mesma substância");
    check(cd.has("CODIGO_ATC"), "o ATC propaga — é a mesma substância");
    check(!cd.has("DOSAGEM"), "a DOSAGEM não propaga (0.5 mg não é 0.25 mg)");
    check(!cd.has("FORMA_FARMACEUTICA"), "a FORMA não propaga");
    check(!cd.has("EMBALAGEM"), "a EMBALAGEM não propaga");
    // O representante continua a levar a dele inteira.
    check(clinicaDe(rep).size === 5, "o representante mantém os cinco campos");
  }

  console.log("\n=== clínica abaixo do limiar NÃO sobe ===");
  {
    const { candidatos } = await correr(
      [linha(1234567, "Ozempic 0.25 Mg Sol. Injetável")],
      [cru(1234567, { confidenceClinica: LIMIAR_CLINICO - 0.01 })],
    );
    check(clinicaDe(candidatos[0]).size === 0, "confiança clínica 0.89 → zero campos promovidos");
    check(candidatos[0]?.categoria === "MEDICAMENTOS", "…mas a CLASSIFICAÇÃO sobe na mesma");
  }

  console.log("\n=== ATC malformado NÃO sobe, e não leva o resto atrás ===");
  {
    const { candidatos } = await correr(
      [linha(1234567, "Ozempic 0.25 Mg Sol. Injetável")],
      [cru(1234567, { codigoATC: "A10" })],
    );
    const cl = clinicaDe(candidatos[0]);
    check(!cl.has("CODIGO_ATC"), "\"A10\" não é um ATC — não sobe");
    check(cl.has("DCI"), "…e a DCI sobe na mesma: um campo mau não contamina os outros");
    check(cl.size === 4, "…ficam quatro campos", `n=${cl.size}`);
  }

  console.log("\n=== um campo vazio não gera candidato (e nunca apaga) ===");
  {
    const { candidatos } = await correr(
      [linha(1234567, "Ozempic 0.25 Mg Sol. Injetável")],
      [cru(1234567, { embalagem: null, dosagem: "" })],
    );
    const cl = clinicaDe(candidatos[0]);
    check(!cl.has("EMBALAGEM"), "campo a null não vira candidato");
    check(!cl.has("DOSAGEM"), "campo vazio não vira candidato");
    check(cl.size === 3, "…sobram três", `n=${cl.size}`);
  }

  // ───────────────────────────────────────────────────────────────────
  console.log("\n=== IDEMPOTÊNCIA: segunda promoção = zero alterações ===");
  {
    const { candidatos } = await correr([linha(1234567, "Ozempic 0.25 Mg Sol. Injetável")], [cru(1234567)]);
    const clinica = candidatos[0]!.clinica;

    // Primeira: o global não sabe nada.
    const primeira = avaliarClinica(clinica, new Map());
    check(primeira.promover.length === 5, "primeira promoção escreve os cinco");

    // O global fica com o que subiu.
    const global = new Map<CampoClinico, ClinicaGlobal>(
      primeira.promover.map((p) => [
        p.campo,
        { campo: p.campo, valor: p.valor, origem: p.origem!, confianca: p.confianca, versaoRegras: p.versaoRegras },
      ]),
    );

    const segunda = avaliarClinica(clinica, global);
    check(segunda.promover.length === 0, "segunda promoção escreve ZERO");
    check(segunda.recusadas.length === 5, "…e recusa os cinco");
    check(
      segunda.recusadas.every((r) => r.motivo === "o global ja tem este valor"),
      "…todos por já lá estarem",
    );

    console.log("\n=== FASE 5 depois da promoção interna = zero alterações ===");
    // A fase 5 lê o TENANT e reconstrói os candidatos com origem MODELO,
    // porque foi o modelo que escreveu aqueles valores. Encontra o que o
    // runner acabou de promover, com a mesma origem e o mesmo valor.
    const daFase5 = clinica.map((c) => ({ ...c, motivoOrigem: "lido do tenant pela fase 5" }));
    const fase5 = avaliarClinica(daFase5, global);
    check(fase5.promover.length === 0, "a fase 5 não escreve nada por cima");
    check(fase5.recusadas.length === 5, "…e conta as cinco como já sabidas");
  }

  console.log("\n=== DEPENDENTE de representante RECUSADO fica com estado terminal ===");
  {
    // O representante devolve DESCONHECIDO: o gate recusa e nada é escrito
    // no produto dele nem no do irmão. Mas o irmão TEM de ficar com linha
    // de cache — senão volta ao residual, a mesma família escolhe o mesmo
    // representante, que falha da mesma maneira, para sempre.
    //
    // Medido no canary de 25 de 2026-08-21: 4 dependentes exactamente
    // nesta situação ficaram sem cache, sem estado e sem contagem.
    const escritas: string[] = [];
    const residual = [
      linha(1111111, "Ozempic 0.25 Mg Sol. Injetável"),
      linha(2222222, "Ozempic 0.5 Mg Sol. Injetável"),
    ];
    const cacheados: Array<{ cnp: number; persistido: boolean; propagadoDe: number | null }> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prisma = prismaFalso(residual, escritas) as any;
    prisma.knowledgeEnrichmentCache = {
      upsert: async (arg: {
        create: { cnp: number; persistido: boolean; propagadoDeCnp: number | null };
      }) => {
        cacheados.push({
          cnp: arg.create.cnp,
          persistido: arg.create.persistido,
          propagadoDe: arg.create.propagadoDeCnp ?? null,
        });
        return {};
      },
    };
    const recusado = [cru(1111111, { evidenceType: "DESCONHECIDO", confidence: 0.4, confidenceClinica: 0 })];
    await runKnowledgeEnrichment(prisma, {
      dryRun: false,
      tenantSlug: "tenant-teste",
      classificar: resposta(recusado) as never,
      verificar: resposta(recusado) as never,
      promover: (async () => RESULTADO_VAZIO) as never,
    });

    const rep = cacheados.find((c) => c.cnp === 1111111);
    const dep = cacheados.find((c) => c.cnp === 2222222);
    check(!!rep, "o representante recusado fica com linha de cache");
    check(rep?.persistido === false, "…com persistido=false");
    check(!!dep, "o DEPENDENTE também fica com linha de cache (antes não ficava)");
    check(dep?.persistido === false, "…também com persistido=false — não se escreveu nada");
    check(dep?.propagadoDe === 1111111, "…e com a proveniência do representante", String(dep?.propagadoDe));
  }

  console.log(`\n${pass} ok, ${fail} falhas`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
