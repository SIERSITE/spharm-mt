/**
 * scripts/tests/test-global-sem-classificacao.ts
 *
 * Uma linha em `CatalogoGlobal` NÃO é uma classificação global.
 *
 * ── O defeito que isto guarda ────────────────────────────────────────
 *
 * `CatalogoGlobal` tem linhas sem classificação por desenho: quando só
 * sobem utilizações ou clínica, a linha do produto tem de existir para a
 * chave estrangeira e nasce com `categoria` e `subcategoria` a null.
 *
 * Dois sítios liam a existência da linha como se fosse uma opinião:
 *
 *   `avaliarProjeccao` comparava a classificação local específica com o
 *   global ANTES de verificar se o global tinha alguma coisa. Com null
 *   dos dois lados a comparação dava sempre "diferente" e abria-se uma
 *   revisão com `valorGlobal = "null > null"`. A guarda que trata este
 *   caso existia — e estava depois, portanto inalcançável.
 *
 *   `decidirClassificacao` só saltava a comparação de ranks com
 *   `!global`. Com a linha a existir, comparava a origem do candidato
 *   com a origem de uma linha que não classifica nada, e recusava com «o
 *   global já tem conhecimento igual ou melhor» sobre um global que não
 *   tinha conhecimento nenhum.
 *
 * Os dois lados do mesmo ponto cego: um enchia a fila de revisão com
 * falsos conflitos, o outro impedia que as classificações locais boas os
 * resolvessem subindo.
 *
 * Medido em produção antes da correcção: 1 246 revisões pendentes, 1 212
 * gravadas com "null > null".
 *
 * Corre com:  npm run test:global-sem-classificacao
 */
import {
  avaliarProjeccao,
  avaliarPromocao,
  type ConhecimentoCandidato,
  type ConhecimentoGlobal,
  type EstadoLocal,
} from "../../lib/catalog/global-catalog";

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

// ─────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────

/** A linha que uma promoção só-de-utilizações deixa no global. */
const globalSemClassificacao = (over: Partial<ConhecimentoGlobal> = {}): ConhecimentoGlobal => ({
  cnp: 2_000_101,
  categoria: null,
  subcategoria: null,
  productType: null,
  confidence: 0.9,
  evidenceType: null,
  // DETERMINISTICA de propósito: é a origem que a promoção de utilizações
  // deixou, e era ela que empatava com a origem local e bloqueava tudo.
  origem: "DETERMINISTICA",
  versaoRegras: "ke-2.0",
  verificado: false,
  utilizacoes: [{ slug: "diabetes", confidence: 0.9, origem: "MODELO" }],
  ...over,
});

const globalClassificado = (over: Partial<ConhecimentoGlobal> = {}): ConhecimentoGlobal =>
  globalSemClassificacao({ categoria: "MEDICAMENTOS", subcategoria: "Diabetes", ...over });

const localEspecifico = (over: Partial<EstadoLocal> = {}): EstadoLocal => ({
  cnp: 2_000_101,
  validadoManualmente: false,
  categoria: "MEDICAMENTOS",
  subcategoria: "Dor e Febre",
  productType: "MEDICAMENTO",
  utilizacoes: [],
  ...over,
});

const candidato = (over: Partial<ConhecimentoCandidato> = {}): ConhecimentoCandidato => ({
  cnp: 2_000_101,
  designacaoReferencia: "Ozempic 1 mg",
  productType: "MEDICAMENTO",
  categoria: "MEDICAMENTOS",
  subcategoria: "Dor e Febre",
  utilizacoes: [],
  confidence: 0.9,
  evidenceType: "SUBSTANCIA_CONHECIDA",
  origem: "DETERMINISTICA",
  motivoOrigem: "regras determinísticas do catálogo (fill-rules)",
  fonteOriginal: "TEXT_PATTERN",
  versaoRegras: "ke-2.0",
  verificado: true,
  tenantOrigem: "garantia",
  ...over,
  // `clinica` é opcional no tipo e o spread de um `Partial` traz-lhe um
  // `undefined` explícito, que `exactOptionalPropertyTypes` recusa. Fixá-la
  // aqui é mais honesto do que um cast: este ficheiro testa classificação,
  // e a clínica é sempre vazia de propósito.
  clinica: over.clinica ?? [],
});

// Este ficheiro compila para CommonJS: sem top-level await.
async function main(): Promise<void> {
  // ── 1. Projecção: ausência não é divergência ───────────────────────
  console.log("\n=== global sem classificação + local específica ===");
  {
    const d = avaliarProjeccao(globalSemClassificacao(), localEspecifico());

    check(d.accao !== "REVISAO", `NÃO abre revisão (${d.accao})`);
    check(d.revisao === null, "…e não há revisão para gravar");
    check(
      /não tem classificação específica/.test(d.motivo),
      `o motivo diz o que se passa (${d.motivo})`,
    );
    // O que o defeito produzia, agora como asserção nomeada: a string
    // literal que o template `${null} > ${null}` gerava.
    check(
      d.revisao === null,
      'nunca mais se grava valorGlobal = "null > null"',
    );
    // As utilizações seguem — são decididas à parte da classificação, e
    // é por isso que este ramo não pode ser um `continue` seco.
    check(
      d.utilizacoes.includes("diabetes"),
      `as utilizações do global continuam a ser projectadas (${JSON.stringify(d.utilizacoes)})`,
    );
  }

  // ── 2. Global com N1 mas sem N2 ────────────────────────────────────
  console.log("\n=== global com N1 e sem N2 ===");
  {
    const d = avaliarProjeccao(
      globalSemClassificacao({ categoria: "MEDICAMENTOS", subcategoria: null }),
      localEspecifico(),
    );
    check(d.accao !== "REVISAO", `também não é divergência (${d.accao})`);
  }

  // ── 3. Global com "Outros X" ───────────────────────────────────────
  console.log("\n=== global com subcategoria de fallback ===");
  {
    const d = avaliarProjeccao(
      globalSemClassificacao({ categoria: "MEDICAMENTOS", subcategoria: "Outros Medicamentos" }),
      localEspecifico(),
    );
    check(d.accao !== "REVISAO", `um balde não é conhecimento — não conflitua (${d.accao})`);
  }

  // ── 4. O conflito REAL continua a ser conflito ─────────────────────
  console.log("\n=== global específico DIFERENTE do local ===");
  {
    const d = avaliarProjeccao(globalClassificado(), localEspecifico());

    check(d.accao === "REVISAO", `abre revisão (${d.accao})`);
    check(
      d.revisao?.valorGlobal === "MEDICAMENTOS > Diabetes",
      `com o valor global real (${d.revisao?.valorGlobal})`,
    );
    check(
      d.revisao?.valorLocal === "MEDICAMENTOS > Dor e Febre",
      `e o local (${d.revisao?.valorLocal})`,
    );
  }

  // ── 5. Global específico IGUAL ─────────────────────────────────────
  console.log("\n=== global específico IGUAL ao local ===");
  {
    const semUtil = avaliarProjeccao(
      globalClassificado({ utilizacoes: [] }),
      localEspecifico({ subcategoria: "Diabetes" }),
    );
    check(semUtil.accao === "NO_OP", `no-op silencioso (${semUtil.accao})`);

    const comUtil = avaliarProjeccao(
      globalClassificado(),
      localEspecifico({ subcategoria: "Diabetes" }),
    );
    check(
      comUtil.accao === "ESCREVER_CLASSIFICACAO" && comUtil.utilizacoes.length === 1,
      `classificação igual, faltavam utilizações (${comUtil.accao})`,
    );
  }

  // ── 6. validadoManualmente ─────────────────────────────────────────
  console.log("\n=== validadoManualmente ===");
  {
    for (const [nome, g] of [
      ["global vazio", globalSemClassificacao()],
      ["global classificado", globalClassificado()],
    ] as Array<[string, ConhecimentoGlobal]>) {
      const d = avaliarProjeccao(g, localEspecifico({ validadoManualmente: true }));
      check(d.accao === "INTOCAVEL", `${nome}: intocável (${d.accao})`);
      check(d.utilizacoes.length === 0, `${nome}: nem utilizações`);
    }
  }

  // ── 7. Promoção: não há nada a perder para ─────────────────────────
  console.log("\n=== promoção contra um global sem classificação ===");
  {
    const g = globalSemClassificacao();
    const d = avaliarPromocao(candidato(), g);

    check(d.classificacao.promover, `promove (${d.classificacao.motivo})`);
    check(
      /não tem classificação/.test(d.classificacao.motivo),
      "…e o motivo diz porquê",
      d.classificacao.motivo,
    );

    // O empate de origem era o que bloqueava: DETERMINISTICA local contra
    // uma linha DETERMINISTICA criada por uma promoção de utilizações.
    check(
      candidato().origem === g.origem,
      "o cenário testado é mesmo o do empate de origem",
    );
    // …e sem confiança superior, que era a segunda porta fechada.
    const semVantagem = avaliarPromocao(candidato({ confidence: g.confidence }), g);
    check(
      semVantagem.classificacao.promover,
      "promove mesmo sem confiança superior ao da linha vazia",
      semVantagem.classificacao.motivo,
    );
  }

  // ── 8. A promoção não mexe no que já lá está ───────────────────────
  console.log("\n=== promover classificação preserva utilizações e clínica ===");
  {
    const g = globalSemClassificacao();
    const d = avaliarPromocao(candidato(), g);

    // A utilização que o global já tem não entra em `promover` (não há
    // nada para escrever) nem em lado nenhum que a apague: a decisão só
    // conhece "promover" e "recusadas".
    check(
      !d.utilizacoes.promover.some((u) => u.slug === "diabetes"),
      "a utilização global existente não é reescrita",
    );
    check(
      d.clinica.promover.length === 0,
      "sem candidatos clínicos, nada de clínica é decidido",
    );

    // A garantia estrutural: não há um único delete nestas duas tabelas.
    const { readFileSync } = await import("node:fs");
    const store = readFileSync("lib/catalog/global-catalog-store.ts", "utf8");
    check(
      !/catalogoGlobalUtilizacao\.delete/.test(store),
      "o store nunca apaga utilizações globais",
    );
    check(!/catalogoGlobalClinica\.delete/.test(store), "…nem clínica global");

    // E o upsert da classificação escreve campos de classificação — não
    // toca nas outras duas tabelas, que têm o seu próprio upsert.
    const i = store.indexOf("if (decisao.classificacao.promover) {");
    const upsert = store.slice(i, store.indexOf("} else {", i));
    check(
      !/utilizacoes|clinica/i.test(upsert),
      "o upsert da classificação não menciona utilizações nem clínica",
    );
  }

  // ── 9. Idempotência ────────────────────────────────────────────────
  console.log("\n=== idempotência ===");
  {
    // Depois de a classificação subir, o global passa a ter opinião. A
    // segunda passagem tem de recusar — senão cada corrida reescrevia.
    const depois = globalClassificado({ subcategoria: "Dor e Febre" });
    const d2 = avaliarPromocao(candidato(), depois);
    check(
      !d2.classificacao.promover,
      `a segunda promoção não escreve (${d2.classificacao.motivo})`,
    );
    check(
      /igual ou melhor/.test(d2.classificacao.motivo),
      "…pelo motivo de sempre",
      d2.classificacao.motivo,
    );

    // E a projecção sobre esse estado é um no-op, não uma revisão.
    const p2 = avaliarProjeccao(
      depois,
      localEspecifico({ subcategoria: "Dor e Febre", utilizacoes: [] }),
    );
    check(p2.accao !== "REVISAO", `a projecção também estabiliza (${p2.accao})`);
  }

  // ── 10. A ordem das guardas, no texto ──────────────────────────────
  //
  // O defeito não era uma condição errada: era uma condição certa no
  // sítio errado. Se voltar para baixo, volta a ser inalcançável — e
  // todas as asserções acima passariam à mesma se alguém a duplicasse.
  console.log("\n=== a guarda do global vazio precede a comparação ===");
  {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("lib/catalog/global-catalog.ts", "utf8");
    const inicio = src.indexOf("export function avaliarProjeccao");
    const corpo = src.slice(inicio, src.indexOf("\nexport function estaDesactualizado", inicio));

    const iGuarda = corpo.indexOf('!ehEspecifica(global.subcategoria) || !global.categoria');
    const iCompara = corpo.indexOf("if (ehEspecifica(local.subcategoria))");
    check(iGuarda > 0 && iCompara > 0, "as duas existem");
    check(iGuarda < iCompara, "a guarda do global vazio vem primeiro", `${iGuarda} < ${iCompara}`);
  }

  console.log(`\n${ok} ok, ${ko} falhas`);
  process.exit(ko === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
