/**
 * scripts/tests/test-knowledge-enrichment.ts
 *
 * Testes de segurança do knowledge-enrichment. Sem base de dados e sem
 * rede: tudo o que aqui está é a camada pura — validação de vocabulário
 * e decisão de escrita.
 *
 * O QUE ESTAS ASSERÇÕES PROTEGEM
 *
 * O modelo é a parte do sistema que não se pode testar por inspecção: não
 * há como ler o código dele e concluir que não vai inventar uma categoria.
 * Por isso as garantias não estão no prompt — estão em `validarResultado`
 * e `decidirEscrita`, que são determinísticas. Estes testes são a prova
 * de que essas duas funções seguram, mesmo alimentadas com a saída mais
 * hostil possível: categorias inventadas, slugs falsos, cnps que não
 * estavam no lote, confiança fabricada em cima de um "não sei".
 *
 * Se alguém relaxar uma destas funções, é aqui que parte — não em
 * produção, com um antipsicótico em "Analgésicos".
 *
 * Uso: npx tsx scripts/tests/test-knowledge-enrichment.ts
 */
import {
  CAMPOS_ESCRITOS,
  CAMPOS_PROIBIDOS,
  EVIDENCIA_PERMITIDA,
  KNOWLEDGE_MODEL,
  KNOWLEDGE_VERSION,
  LIMIAR_PERSISTENCIA,
  MAX_RETENTATIVAS,
  TIMEOUT_MS,
  avaliarGate,
  chaveCache,
  compararPassagens,
  deveRepetir,
  precisaVerificacao,
  resolverModelo,
  validarResultado,
  type KnowledgeResult,
} from "../../lib/catalog/knowledge-enrichment";
import {
  QUOTAS_CANARY,
  runKnowledgeEnrichment,
  selecionarCanary,
  type Estrato,
} from "../../lib/catalog/knowledge-enrichment-runner";
import { readFileSync } from "node:fs";
import { SOURCE_TIER_RANK } from "../../lib/catalog-types";

let pass = 0;
let fail = 0;
const ok = (l: string) => { pass++; console.log(`  [OK]    ${l}`); };
const bad = (l: string, d?: string) => { fail++; console.log(`  [FALHA] ${l}${d ? `\n            ${d}` : ""}`); };
const check = (cond: boolean, l: string, d?: string) => (cond ? ok(l) : bad(l, d));

const LOTE = new Set([1234567, 7654321]);

const SEM_CLASSIF = { categoria: null, subcategoria: null, productType: null };
const EM_FALLBACK = { categoria: "MEDICAMENTOS", subcategoria: "Outros Medicamentos", productType: null };
const ESPECIFICO = { categoria: "MEDICAMENTOS", subcategoria: "Cardiovascular", productType: null };

/** Resultado cru válido, para servir de base às variações hostis. */
function cru(over: Record<string, unknown> = {}) {
  return {
    cnp: 1234567,
    productType: "MEDICAMENTO",
    categoria: "MEDICAMENTOS",
    subcategoria: "Diabetes",
    forma: "solução injetável",
    utilizacoes: ["diabetes"],
    confidence: 0.95,
    evidenceType: "MARCA_CONHECIDA",
    rationale: "Ozempic é semaglutido, antidiabético injetável.",
    ...over,
  };
}

console.log("=== vocabulário fechado: o modelo não pode inventar ===");
{
  const r = validarResultado(cru(), LOTE);
  check(r?.categoria === "MEDICAMENTOS" && r?.subcategoria === "Diabetes", "par válido passa intacto");
  check(r?.utilizacoes.join() === "diabetes", "slug válido passa");
}
{
  // O caso que mais interessa: uma categoria plausível que não existe.
  const r = validarResultado(cru({ subcategoria: "Antidiabéticos Orais" }), LOTE);
  check(r !== null, "resultado com subcategoria inventada não é descartado inteiro");
  check(r?.categoria === null && r?.subcategoria === null, "…mas a categoria inventada é descartada, não corrigida");
}
{
  const r = validarResultado(cru({ categoria: "FARMÁCIA GERAL" }), LOTE);
  check(r?.categoria === null, "nível 1 inventado é descartado");
}
{
  // Par cruzado: ambos existem, mas não são pai/filho.
  const r = validarResultado(cru({ categoria: "MEDICAMENTOS", subcategoria: "Champôs" }), LOTE);
  check(r?.subcategoria === null, "subcategoria de outro nível 1 é descartada");
}
{
  const r = validarResultado(cru({ utilizacoes: ["diabetes", "cura-tudo", "DIABETES"] }), LOTE);
  check(r?.utilizacoes.join() === "diabetes", "slugs falsos são filtrados, válidos sobrevivem");
}
{
  const r = validarResultado(cru({ productType: "MEDICAMENTO_FORTE" }), LOTE);
  check(r?.productType === null, "productType fora da união é descartado");
}
{
  const r = validarResultado(cru({ evidenceType: "TENHO_A_CERTEZA" }), LOTE);
  check(r?.evidenceType === "DESCONHECIDO", "evidenceType inválido cai para DESCONHECIDO (o valor seguro)");
}

console.log("\n=== linhas alucinadas ===");
{
  check(validarResultado(cru({ cnp: 999 }), LOTE) === null, "cnp que não estava no lote é rejeitado");
  check(validarResultado(cru({ cnp: "abc" }), LOTE) === null, "cnp não numérico é rejeitado");
  check(validarResultado(null, LOTE) === null, "null é rejeitado");
  check(validarResultado("texto", LOTE) === null, "string é rejeitada");
  check(validarResultado({}, LOTE) === null, "objecto vazio é rejeitado");
}
{
  const r = validarResultado(cru({ confidence: 7 }), LOTE);
  check(r?.confidence === 1, "confiança fora de 0–1 é limitada, não aceite");
  check(validarResultado(cru({ confidence: -3 }), LOTE)?.confidence === 0, "…nos dois sentidos");
}

console.log("\n=== não-degradação: uma classificação específica é intocável ===");
const base: KnowledgeResult = validarResultado(cru(), LOTE)!;
{
  const d = avaliarGate(base, SEM_CLASSIF);
  check(d.gravarCategoria, "produto sem categoria: escreve");
}
{
  const d = avaliarGate(base, EM_FALLBACK);
  check(d.gravarCategoria, "produto em fallback 'Outros': escreve");
}
{
  const d = avaliarGate(base, ESPECIFICO);
  check(!d.gravarCategoria, "produto JÁ específico: NÃO escreve, mesmo com confiança 0.95");
  check(d.decisao === "SKIP", "…e não vai para revisão — já está resolvido");
}
{
  // Confiança máxima e evidência forte não compram o direito de sobrepor.
  const forte = { ...base, confidence: 1, evidenceType: "MARCA_CONHECIDA" as const };
  const d = avaliarGate(forte, { categoria: "MEDICAMENTOS", subcategoria: "Sistema Nervoso", productType: null });
  check(!d.gravarCategoria, "confiança 1.0 continua a não sobrepor uma específica");
}
{
  const fallbackProposto = { ...base, subcategoria: "Outros Medicamentos" };
  const d = avaliarGate(fallbackProposto, EM_FALLBACK);
  check(!d.gravarCategoria, "trocar um 'Outros' por outro 'Outros' não conta como ganho");
}

console.log("\n=== limiar: abaixo dele não se escreve nada ===");
{
  const d = avaliarGate({ ...base, confidence: LIMIAR_PERSISTENCIA - 0.01 }, SEM_CLASSIF);
  check(!d.gravarCategoria, "abaixo do limiar não escreve categoria");
  check(d.utilizacoes.length === 0, "…nem utilizações");
  check(d.decisao === "REVIEW", "…e marca para revisão");
}
{
  const d = avaliarGate({ ...base, confidence: LIMIAR_PERSISTENCIA }, SEM_CLASSIF);
  check(d.gravarCategoria, "exactamente no limiar, escreve");
}
{
  const d = avaliarGate({ ...base, evidenceType: "DESCONHECIDO", confidence: 0.99 }, SEM_CLASSIF);
  check(!d.gravarCategoria, "DESCONHECIDO com confiança alta não escreve — a evidência manda");
  check(d.decisao === "REVIEW", "…vai para revisão");
}
{
  const semCategoria = { ...base, categoria: null, subcategoria: null };
  const d = avaliarGate(semCategoria, SEM_CLASSIF);
  check(!d.gravarCategoria && d.decisao === "REVIEW", "sem categoria válida (pós-filtro) vai para revisão");
}

console.log("\n=== âmbito de escrita: só 4 campos, e nunca os que têm fonte melhor ===");
{
  check(
    [...CAMPOS_ESCRITOS].sort().join() ===
      ["ProdutoUtilizacao", "classificacaoNivel1Id", "classificacaoNivel2Id", "productType"].sort().join(),
    "a lista de campos escritos é exactamente a acordada",
    [...CAMPOS_ESCRITOS].join(", "),
  );
  for (const campo of ["codigoATC", "dci", "fabricanteId", "imagemUrl", "formaFarmaceutica"]) {
    check(
      (CAMPOS_PROIBIDOS as readonly string[]).includes(campo) &&
        !(CAMPOS_ESCRITOS as readonly string[]).includes(campo),
      `${campo} é proibido e não consta dos escritos`,
    );
  }
}
{
  // A garantia real não é a constante — é não existir UPDATE que lhes toque.
  const runner = readFileSync(
    new URL("../../lib/catalog/knowledge-enrichment-runner.ts", import.meta.url),
    "utf8",
  );
  const updates = runner.match(/update "Produto"[\s\S]*?where/g) ?? [];
  for (const campo of CAMPOS_PROIBIDOS) {
    check(
      !updates.some((u) => u.includes(`"${campo}"`)),
      `nenhum UPDATE em Produto escreve ${campo}`,
    );
  }
  check(updates.length > 0, "o teste encontrou mesmo os UPDATEs (senão não provava nada)");
}
{
  // Guarda de texto sobre o SQL, deliberadamente. O furo que fecha não é
  // observável com um prisma falso — precisaria de Postgres a avaliar
  // `NULL not ilike`, que devolve NULL e não FALSE. Um produto com
  // `classificacaoNivel2Id` a apontar para uma Classificacao inexistente
  // ficava elegível pelo filtro combinado e fora dos TRÊS filtros por
  // estrato: desaparecia do canary sem aparecer em défice nenhum.
  const runner = readFileSync(
    new URL("../../lib/catalog/knowledge-enrichment-runner.ts", import.meta.url),
    "utf8",
  );
  check(
    /estrato === "OUTROS_MEDICAMENTOS"[\s\S]{0,120}classificacaoNivel2Id" is not null and c2\.nome ilike/.test(runner),
    "filtro OUTROS_MEDICAMENTOS exige nível 2 preenchido (não confia no ilike sobre NULL)",
  );
  check(
    /estrato === "SEM_UTILIZACOES"[\s\S]{0,220}c2\.nome is null or c2\.nome not ilike/.test(runner),
    "filtro SEM_UTILIZACOES aceita c2.nome NULL — senão o produto órfão não cai em estrato nenhum",
  );
}
{
  const d = avaliarGate(base, SEM_CLASSIF);
  check(d.gravarProductType, "productType escreve-se quando falta");
  const e = avaliarGate(base, { ...SEM_CLASSIF, productType: "SUPLEMENTO" });
  check(!e.gravarProductType, "productType já decidido não é substituído");
}

console.log("\n=== gate: a confiança do modelo não é prova suficiente ===");
{
  // Confiança máxima, tudo o resto a falhar → não escreve.
  const d = avaliarGate({ ...base, evidenceType: "CATEGORIA_PRODUTO", confidence: 1 }, SEM_CLASSIF);
  check(d.decisao === "REVIEW", "confiança 1.0 sozinha não abre a porta");
  check(!d.criterios.evidencia && d.criterios.confianca, "…o critério que falhou é a evidência, não a confiança");
}
{
  check(!EVIDENCIA_PERMITIDA.has("CATEGORIA_PRODUTO"), "CATEGORIA_PRODUTO não autoriza escrita automática");
  check(!EVIDENCIA_PERMITIDA.has("DESCONHECIDO"), "DESCONHECIDO não autoriza escrita automática");
  check(EVIDENCIA_PERMITIDA.has("MARCA_CONHECIDA") && EVIDENCIA_PERMITIDA.has("SUBSTANCIA_CONHECIDA"),
    "marca e substância autorizam");
}
{
  const d = avaliarGate(base, SEM_CLASSIF, { concorda: false, aplicavel: true });
  check(d.decisao === "REVIEW", "verificador em desacordo bloqueia, mesmo com tudo o resto a passar");
  check(!d.criterios.verificado, "…e o critério fica registado como falhado");
  check(d.utilizacoes.length === 0, "…e não passam utilizações");
}
{
  const d = avaliarGate(base, SEM_CLASSIF);
  const todos = Object.values(d.criterios).every(Boolean);
  check(d.decisao === "APPLY" && todos, "APPLY exige TODOS os critérios");
}

console.log("\n=== segunda passagem: onde é exigida e como se compara ===");
{
  check(precisaVerificacao(base), "MEDICAMENTOS exige verificação");
  const supl = { ...base, categoria: "SUPLEMENTOS ALIMENTARES", subcategoria: "Vitaminas e Minerais", utilizacoes: ["vitaminas-e-minerais"] };
  check(!precisaVerificacao(supl), "utilização de bem-estar não exige verificação");
  const clinico = { ...base, categoria: "DISPOSITIVOS MÉDICOS", subcategoria: "Termómetros", utilizacoes: ["dor-e-febre"] };
  check(precisaVerificacao(clinico), "utilização clínica exige verificação mesmo fora de MEDICAMENTOS");
}
{
  const v = compararPassagens(base, base);
  check(v.concorda, "duas passagens idênticas concordam");
  check(v.utilizacoesConfirmadas.join() === "diabetes", "utilização vista pelas duas é confirmada");
}
{
  const divergente = { ...base, subcategoria: "Cardiovascular" };
  const v = compararPassagens(base, divergente);
  check(!v.concorda, "subcategoria diferente = desacordo (acertar no nível 1 não salva)");
}
{
  const v = compararPassagens(base, null);
  check(!v.concorda, "verificador sem resposta para o produto = desacordo, não acordo por omissão");
}
{
  const v = compararPassagens(base, { ...base, evidenceType: "DESCONHECIDO" });
  check(!v.concorda, "verificador que não reconhece = desacordo");
}
{
  // Interseção: uma utilização que só uma passagem viu não é escrita.
  const p = { ...base, utilizacoes: ["diabetes", "dor-e-febre"] };
  const q = { ...base, utilizacoes: ["diabetes"] };
  const v = compararPassagens(p, q);
  check(v.concorda, "categoria igual → concorda");
  check(v.utilizacoesConfirmadas.join() === "diabetes", "…mas só a utilização vista pelas duas sobrevive");
}

console.log("\n=== autoridade: o modelo perde sempre o desempate ===");
{
  check(
    SOURCE_TIER_RANK.MODEL_INFERRED > SOURCE_TIER_RANK.INTERNAL_INFERRED,
    "MODEL_INFERRED é menos autoritário que INTERNAL_INFERRED",
  );
  const outros = Object.entries(SOURCE_TIER_RANK).filter(([k]) => k !== "MODEL_INFERRED");
  check(
    outros.every(([, v]) => v < SOURCE_TIER_RANK.MODEL_INFERRED),
    "MODEL_INFERRED é o último de todos os tiers",
    outros.map(([k, v]) => `${k}=${v}`).join(" "),
  );
}

console.log("\n=== idempotência da chave de cache ===");
{
  check(chaveCache(1, "Ozempic 0.25 Mg") === chaveCache(1, "Ozempic 0.25 Mg"), "mesma entrada → mesma chave");
  check(chaveCache(1, "OZEMPIC 0.25 MG") === chaveCache(1, "ozempic 0.25 mg"), "maiúsculas não geram nova chave");
  check(chaveCache(1, " Ozempic ") === chaveCache(1, "Ozempic"), "espaços à volta não geram nova chave");
  check(chaveCache(1, "Ozempic") !== chaveCache(2, "Ozempic"), "cnp diferente → chave diferente");
  check(chaveCache(1, "Ozempic 0.25") !== chaveCache(1, "Ozempic 0.5"), "designação diferente → chave diferente");
}

console.log("\n=== modelo: fixo, configurável, nunca um alias móvel ===");
{
  check(KNOWLEDGE_MODEL === resolverModelo(undefined), "KNOWLEDGE_MODEL vem de resolverModelo");
  check(!/latest/i.test(KNOWLEDGE_MODEL), "o modelo em uso não é um alias 'latest'");
  check(resolverModelo("claude-opus-5") === "claude-opus-5", "id explícito é aceite");
  check(resolverModelo("  claude-opus-5  ") === "claude-opus-5", "espaços à volta são aparados");

  for (const mau of ["claude-opus-latest", "claude-3-5-sonnet-latest", "LATEST", "claude-*"]) {
    let rebentou = false;
    try { resolverModelo(mau); } catch { rebentou = true; }
    check(rebentou, `alias móvel "${mau}" é recusado`);
  }
  let vazioRebentou = false;
  try { resolverModelo("   "); } catch { vazioRebentou = true; }
  check(vazioRebentou, "env definida mas vazia é recusada (não cai em silêncio para o default)");

  check(chaveCache(1, "x").includes(KNOWLEDGE_MODEL), "o modelo entra na chave de cache");
  check(chaveCache(1, "x").includes(KNOWLEDGE_VERSION), "…e a versão das regras também");
}

console.log("\n=== retentativas: só o transitório ===");
{
  const httpErr = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

  for (const s of [429, 408, 500, 502, 503, 529]) {
    check(deveRepetir(httpErr(s)), `${s} é repetido (transitório)`);
  }
  for (const s of [400, 401, 403, 404, 413, 422]) {
    check(!deveRepetir(httpErr(s)), `${s} NÃO é repetido (erro funcional — repetir dá o mesmo)`);
  }
  check(!deveRepetir(new Error("qualquer coisa")), "erro sem status não é repetido");
  check(!deveRepetir(null), "null não é repetido");
  check(MAX_RETENTATIVAS > 0 && MAX_RETENTATIVAS <= 5, `tecto de retentativas é limitado (${MAX_RETENTATIVAS})`);
  check(TIMEOUT_MS > 0 && TIMEOUT_MS <= 600_000, `timeout por pedido é explícito (${TIMEOUT_MS}ms)`);
}

/**
 * Os dois testes que correm a volta completa do runner. Ficam numa função
 * async porque este ficheiro compila para CommonJS — não há top-level
 * await.
 */
async function testesDoRunner(): Promise<void> {
console.log("\n=== dry-run é read-only: prova pela volta completa ===");
{
  /**
   * Prisma falso. Deixa passar leituras e REBENTA em qualquer escrita.
   * É isto que torna a asserção uma prova e não uma inspecção: a volta
   * completa corre mesmo — selecção do residual, proposta, verificação,
   * gate, relatório — e qualquer escrita que aparecesse pelo caminho
   * levantava excepção em vez de passar despercebida.
   */
  function prismaFalso(registo: string[]) {
    const escrita = (o: string) => { registo.push(o); throw new Error(`ESCRITA PROIBIDA EM DRY-RUN: ${o}`); };
    return {
      $queryRawUnsafe: async (sql: string) => {
        if (!/^\s*select/i.test(sql)) escrita(`queryRaw não-select: ${sql.slice(0, 40)}`);
        if (/from "Classificacao"/i.test(sql)) {
          return [
            { id: "n1", nome: "MEDICAMENTOS", pai: null },
            { id: "n2", nome: "Diabetes", pai: "n1" },
          ];
        }
        if (/from "Utilizacao"/i.test(sql)) return [{ id: "u1", slug: "diabetes" }];
        return [{
          cnp: 1234567,
          designacao: "Ozempic 0.25 Mg Sol. Injetável",
          productType: null,
          categoriaAtual: null,
          subcategoriaAtual: null,
          estrato: "NAO_CLASSIFICADO",
        }];
      },
      $executeRawUnsafe: async (sql: string) => escrita(`executeRaw: ${sql.slice(0, 40)}`),
      knowledgeEnrichmentCache: { upsert: async () => escrita("KnowledgeEnrichmentCache.upsert") },
    };
  }

  const resposta = (r: Partial<KnowledgeResult> = {}) => async () => ({
    resultados: [{ ...base, ...r }],
    usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });

  const tentativas: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fake = prismaFalso(tentativas) as any;

  const seco = await runKnowledgeEnrichment(fake, {
    dryRun: true,
    classificar: resposta(),
    verificar: resposta(),
  });

  check(tentativas.length === 0, "dry-run não tentou UMA escrita sequer", tentativas.join(" | "));
  check(seco.residualAnalisado === 1, "…e a volta correu mesmo (leu o residual)");
  check(seco.relatorio.length === 1, "…e produziu relatório");
  check(seco.chamadasProposta === 1 && seco.chamadasVerificacao === 1, "…proposta e verificação foram feitas");
  check(seco.categoriasEscritas === 0 && seco.utilizacoesEscritas === 0 && seco.productTypesEscritos === 0,
    "…e os contadores de escrita ficaram a zero");

  // O contraprova: sem dryRun a MESMA volta tenta escrever. Sem isto, o
  // teste acima passaria também se o runner nunca escrevesse nada.
  const molhado: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fake2 = prismaFalso(molhado) as any;
  await runKnowledgeEnrichment(fake2, {
    dryRun: false,
    classificar: resposta(),
    verificar: resposta(),
  }).catch(() => {});
  check(molhado.length > 0, "com --apply a mesma volta TENTA escrever (o dry-run não estava vazio)");
}

console.log("\n=== canary estratificado: quotas, unicidade e défice ===");
{
  /**
   * Prisma falso com um residual COMPOSTO: muitos NAO_CLASSIFICADO, poucos
   * OUTROS_MEDICAMENTOS, zero SEM_UTILIZACOES. É a forma do problema real:
   * o canary devolveu 30 produtos de um só estrato e o relatório não disse
   * que os outros dois não tinham vindo.
   */
  function prismaEstratos(pop: Record<string, number>) {
    const consultas: string[] = [];
    // O estrato lê-se do WHERE e só do WHERE. O `case` do SELECT contém
    // `is null` e `ilike 'Outros %'` em TODAS as consultas — olhar para o
    // SQL inteiro fazia passar por NAO_CLASSIFICADO a consulta dos três
    // estratos, e o fixture mentia antes de o código ter oportunidade de
    // errar.
    const estratoDe = (sql: string): Estrato => {
      const where = sql.slice(sql.indexOf("where p.cnp >= $1"));
      if (/classificacaoNivel2Id" is null/.test(where)) return "NAO_CLASSIFICADO";
      if (/c2\.nome ilike 'Outros %'/.test(where)) return "OUTROS_MEDICAMENTOS";
      return "SEM_UTILIZACOES";
    };

    // cnp determinístico e distinto por estrato — assim um duplicado entre
    // estratos seria visível, e a unicidade não passa por acidente.
    const baseCnp: Record<Estrato, number> = {
      NAO_CLASSIFICADO: 3_000_000,
      OUTROS_MEDICAMENTOS: 4_000_000,
      SEM_UTILIZACOES: 5_000_000,
    };

    return {
      consultas,
      prisma: {
        $queryRawUnsafe: async (sql: string, ...params: unknown[]) => {
          if (/from "Classificacao"/i.test(sql)) return [];
          if (/from "Utilizacao"/i.test(sql)) return [];
          const est = estratoDe(sql);
          const disponivel = pop[est] ?? 0;
          if (/count\(\*\)/i.test(sql)) {
            consultas.push(`count:${est}`);
            return [{ n: disponivel }];
          }
          consultas.push(`rows:${est}`);
          const limite = Number(params[3] ?? 0);
          const n = Math.min(disponivel, limite);
          return Array.from({ length: n }, (_, i) => ({
            cnp: baseCnp[est] + i,
            designacao: `${est} ${i}`,
            productType: null,
            categoriaAtual: null,
            subcategoriaAtual: null,
            estrato: est,
          }));
        },
        $executeRawUnsafe: async () => 0,
        knowledgeEnrichmentCache: { upsert: async () => ({}) },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    };
  }

  // ── Caso 1: os três estratos com produtos de sobra ──────────────────
  {
    const { prisma, consultas } = prismaEstratos({
      OUTROS_MEDICAMENTOS: 500,
      NAO_CLASSIFICADO: 500,
      SEM_UTILIZACOES: 500,
    });
    const a = await selecionarCanary(prisma, QUOTAS_CANARY);

    check(a.linhas.length === 100, `100 produtos no total (obtidos ${a.linhas.length})`);
    const porEstrato = a.linhas.reduce<Record<string, number>>((m, l) => {
      m[l.estrato] = (m[l.estrato] ?? 0) + 1;
      return m;
    }, {});
    check(porEstrato.OUTROS_MEDICAMENTOS === 40, `40 OUTROS_MEDICAMENTOS (obtidos ${porEstrato.OUTROS_MEDICAMENTOS ?? 0})`);
    check(porEstrato.NAO_CLASSIFICADO === 30, `30 NAO_CLASSIFICADO (obtidos ${porEstrato.NAO_CLASSIFICADO ?? 0})`);
    check(porEstrato.SEM_UTILIZACOES === 30, `30 SEM_UTILIZACOES (obtidos ${porEstrato.SEM_UTILIZACOES ?? 0})`);

    check(new Set(a.linhas.map((l) => l.cnp)).size === a.linhas.length, "sem cnp duplicados");
    check(
      consultas.filter((c) => c.startsWith("rows:")).length === 3,
      "uma consulta de linhas por estrato — os três foram mesmo consultados",
      consultas.join(" "),
    );
    check(a.quotas.every((q) => q.defice === 0), "nenhum défice quando há elegíveis de sobra");
  }

  // ── Caso 2: a forma do problema real ────────────────────────────────
  {
    const { prisma } = prismaEstratos({
      OUTROS_MEDICAMENTOS: 0,
      NAO_CLASSIFICADO: 500,
      SEM_UTILIZACOES: 0,
    });
    const a = await selecionarCanary(prisma, QUOTAS_CANARY);

    check(a.linhas.length === 30, "com dois estratos vazios vêm 30 produtos — o número que apareceu em produção");
    const q = Object.fromEntries(a.quotas.map((x) => [x.estrato, x]));
    check(q.OUTROS_MEDICAMENTOS.defice === 40, "…e o défice de OUTROS_MEDICAMENTOS é reportado (40)");
    check(q.SEM_UTILIZACOES.defice === 30, "…e o de SEM_UTILIZACOES também (30)");
    check(q.NAO_CLASSIFICADO.defice === 0, "…e o estrato servido não reporta défice");
    check(
      q.OUTROS_MEDICAMENTOS.elegiveis === 0 && q.SEM_UTILIZACOES.elegiveis === 0,
      "…e distingue-se 'zero elegíveis' de 'não consultado'",
    );
    check(
      a.quotas.length === 3,
      "os três estratos aparecem no relatório de quotas, mesmo os vazios",
    );
  }

  // ── Caso 3: quota parcial ───────────────────────────────────────────
  {
    const { prisma } = prismaEstratos({
      OUTROS_MEDICAMENTOS: 12,
      NAO_CLASSIFICADO: 500,
      SEM_UTILIZACOES: 500,
    });
    const a = await selecionarCanary(prisma, QUOTAS_CANARY);
    const q = Object.fromEntries(a.quotas.map((x) => [x.estrato, x]));
    check(q.OUTROS_MEDICAMENTOS.obtido === 12 && q.OUTROS_MEDICAMENTOS.defice === 28,
      "estrato com 12 elegíveis dá 12 e reporta défice de 28");
    check(a.linhas.length === 72, "o total encolhe para 72 — e não se enche com produtos de outro estrato");
  }

  // ── Caso 4: o resumo do runner leva as quotas ───────────────────────
  {
    const { prisma } = prismaEstratos({
      OUTROS_MEDICAMENTOS: 0,
      NAO_CLASSIFICADO: 500,
      SEM_UTILIZACOES: 0,
    });
    const r = await runKnowledgeEnrichment(prisma, {
      dryRun: true,
      canary: QUOTAS_CANARY,
      classificar: async () => ({
        resultados: [],
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }),
      verificar: async () => ({
        resultados: [],
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }),
    });
    check(r.quotasCanary !== null, "o resumo do runner traz as quotas no modo canary");
    check(
      (r.quotasCanary ?? []).reduce((s, q) => s + q.defice, 0) === 70,
      "…com o défice total de 70 visível a quem lê o relatório",
    );
    check(r.residualAnalisado === 30, "…e residualAnalisado continua a dizer a verdade (30)");
  }

  // ── Caso 5: fora do canary não há quotas a reportar ─────────────────
  {
    const { prisma } = prismaEstratos({ NAO_CLASSIFICADO: 5 });
    const r = await runKnowledgeEnrichment(prisma, {
      dryRun: true,
      limite: 5,
      classificar: async () => ({
        resultados: [],
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }),
    });
    check(r.quotasCanary === null, "corrida normal (sem canary) não inventa quotas");
  }
}

console.log("\n=== tecto de custo corta imediatamente ===");
{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fake: any = {
    $queryRawUnsafe: async (sql: string) => {
      if (/from "Classificacao"/i.test(sql)) return [];
      if (/from "Utilizacao"/i.test(sql)) return [];
      return Array.from({ length: 60 }, (_, i) => ({
        cnp: 2_000_001 + i,
        designacao: `Produto ${i}`,
        productType: null,
        categoriaAtual: null,
        subcategoriaAtual: null,
        estrato: "NAO_CLASSIFICADO" as const,
      }));
    },
    $executeRawUnsafe: async () => 0,
    knowledgeEnrichmentCache: { upsert: async () => ({}) },
  };

  let chamadas = 0;
  // Cada chamada custa bem mais que o tecto, por isso a primeira já o
  // ultrapassa: a segunda passagem não pode chegar a sair.
  const caro = async () => {
    chamadas++;
    return {
      resultados: [{ ...base, cnp: 2_000_001 }],
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  };

  const r = await runKnowledgeEnrichment(fake, {
    dryRun: true,
    tectoUsd: 0.01,
    classificar: caro,
    verificar: caro,
  });

  check(chamadas === 1, `parou à primeira chamada, sem sair a verificação (chamadas=${chamadas})`);
  check(r.cortadoPorTecto, "o corte por tecto fica registado no resumo");
  check(r.residualAnalisado === 60 && r.chamadasProposta === 1, "…e não percorreu os 3 lotes que tinha pela frente");
}
}

console.log("\n=== determinismo: a mesma entrada dá sempre a mesma decisão ===");
{
  const a = avaliarGate(base, EM_FALLBACK);
  const b = avaliarGate(base, EM_FALLBACK);
  check(JSON.stringify(a) === JSON.stringify(b), "avaliarGate é puro");
  const v1 = validarResultado(cru(), LOTE);
  const v2 = validarResultado(cru(), LOTE);
  check(JSON.stringify(v1) === JSON.stringify(v2), "validarResultado é pura");
}

testesDoRunner()
  .then(() => {
    console.log(`\n${pass} ok, ${fail} falhas`);
    process.exit(fail === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error("\n[FALHA] os testes do runner rebentaram:", e);
    process.exit(1);
  });
