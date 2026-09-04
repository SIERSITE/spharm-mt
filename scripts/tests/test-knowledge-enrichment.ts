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
  LIMIAR_CLINICO,
  MAX_RETENTATIVAS,
  TIMEOUT_MS,
  alvoParaProduto,
  avaliarGate,
  validarResultadoUtilizacoes,
  chaveCache,
  compararPassagens,
  deveRepetir,
  precisaVerificacao,
  resolverModelo,
  validarResultado,
  validarResultadoForma,
  TAMANHO_LOTE_FORMA,
  type KnowledgeResult,
} from "../../lib/catalog/knowledge-enrichment";
import {
  QUOTAS_CANARY,
  runKnowledgeEnrichment,
  MAX_TENTATIVAS_FILA,
  corpoResidual,
  lerJanelaCanary,
  type Estrato,
} from "../../lib/catalog/knowledge-enrichment-runner";
import { agruparFamilias } from "../../lib/catalog/preselection";
import { normalizarForma } from "../../lib/catalog/formas-farmaceuticas";
import { readFileSync } from "node:fs";
import { SOURCE_TIER_RANK } from "../../lib/catalog-types";

let pass = 0;
let fail = 0;
const ok = (l: string) => { pass++; console.log(`  [OK]    ${l}`); };
const bad = (l: string, d?: string) => { fail++; console.log(`  [FALHA] ${l}${d ? `\n            ${d}` : ""}`); };
const check = (cond: boolean, l: string, d?: string) => (cond ? ok(l) : bad(l, d));

const LOTE = new Set([1234567, 7654321]);

/**
 * Contexto que o runner lê para a pré-selecção (catálogo inteiro: famílias
 * e cobertura por subcategoria). Cada teste põe aqui o que quer que a
 * pré-selecção veja; os fakes de prisma devolvem-no quando reconhecem a
 * query pelo alias "as nivel1".
 */
type LinhaContexto = {
  cnp: number; designacao: string;
  nivel1: string | null; nivel2: string | null; utilizacoes: string[];
};
let CONTEXTO: LinhaContexto[] = [];
const ehQueryContexto = (sql: string) => /as nivel1/i.test(sql);

/** Nome alfabético único por índice: "aa", "ab", … Serve para gerar
 *  produtos que NÃO caem na mesma família estrita quando o teste não é
 *  sobre famílias. `Produto 1` e `Produto 2` teriam a mesma chave. */
const nomeUnico = (i: number) => `Zeta${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + (i % 26))}`;

/** Contexto trivial: um produto por cnp, sem famílias e sem subcategoria
 *  com cobertura baixa. A pré-selecção deixa passar tudo. */
function contextoNeutro(cnps: number[], nivel2: string | null = null): LinhaContexto[] {
  return cnps.map((cnp, i) => ({
    cnp,
    designacao: nomeUnico(i),
    nivel1: nivel2 ? "MEDICAMENTOS" : null,
    nivel2,
    utilizacoes: nivel2 ? ["diabetes"] : [],
  }));
}

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
    categoriaBruta: "MEDICAMENTOS",
    subcategoriaBruta: "Diabetes",
    motivoPar: null,
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
  check(!d.gravarCategoria, "produto JÁ específico: NÃO escreve categoria, mesmo com confiança 0.95");
  // MUDANÇA DELIBERADA. Antes isto era SKIP e não escrevia NADA — nem as
  // utilizações, que eram a única coisa que faltava e a única que o gate
  // teria autorizado. O canary pagou 35 destes a preço de classificação
  // completa com verificação em duas passagens, para não escrever nada.
  // Agora o alvo é UTILIZACOES e o que se escreve são só as etiquetas.
  check(d.alvo === "UTILIZACOES", "…o alvo passa a ser só utilizações");
  check(d.decisao === "APPLY" && d.utilizacoes.length > 0, "…e as utilizações são aplicadas");
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

console.log("\n=== ambito de escrita: ke-2.0 alarga aos clinicos; fabricante e imagem continuam fora ===");
{
  // A lista mudou em 2026-08-21 por decisao explicita do operador: os
  // campos clinicos passaram de proibidos a escritos porque nao existe
  // fonte melhor (RegulatoryRecord vazia, sem dataset INFARMED). O teste
  // acompanha a decisao em vez de a contrariar — mas continua a FIXAR a
  // lista, para que um alargamento futuro tenha de ser outra vez
  // deliberado em vez de acontecer por descuido.
  check(
    [...CAMPOS_ESCRITOS].sort().join() ===
      [
        "ProdutoUtilizacao", "classificacaoNivel1Id", "classificacaoNivel2Id", "productType",
        "dci", "codigoATC", "formaFarmaceutica", "dosagem", "embalagem",
      ].sort().join(),
    "a lista de campos escritos e exactamente a acordada",
    [...CAMPOS_ESCRITOS].join(", "),
  );
  // Estes dois continuam fora, por razoes que nao mudaram: o fabricante
  // ja vem do ERP em 95% do catalogo, e uma imagem nao e inferivel — um
  // modelo nao pode devolver um ficheiro que nunca viu.
  for (const campo of ["fabricanteId", "imagemUrl"]) {
    check(
      (CAMPOS_PROIBIDOS as readonly string[]).includes(campo) &&
        !(CAMPOS_ESCRITOS as readonly string[]).includes(campo),
      `${campo} e proibido e nao consta dos escritos`,
    );
  }
  for (const campo of ["codigoATC", "dci", "formaFarmaceutica", "dosagem", "embalagem"]) {
    check(
      (CAMPOS_ESCRITOS as readonly string[]).includes(campo) &&
        !(CAMPOS_PROIBIDOS as readonly string[]).includes(campo),
      `${campo} passou a escrito (ke-2.0) e saiu dos proibidos`,
    );
  }
}

console.log("\n=== ke-2.0: o gate clinico nao deixa passar ATC inventado ===");
{
  const cnps = new Set([5440987]);
  const base = {
    cnp: 5440987, productType: "MEDICAMENTO",
    categoria: "MEDICAMENTOS", subcategoria: "Analgésicos e Anti-inflamatórios",
    forma: "comprimido", utilizacoes: [], confidence: 0.97,
    evidenceType: "MARCA_CONHECIDA", rationale: "Ben-u-ron é paracetamol.",
    dosagem: "500 mg", embalagem: "20 comprimidos", confidenceClinica: 0.96,
  };

  const ok = validarResultado({ ...base, dci: "Paracetamol", codigoATC: "N02BE01" }, cnps);
  check(ok?.codigoATC === "N02BE01", "ATC completo e bem formado sobrevive");
  check(ok?.dci === "Paracetamol", "DCI plausivel sobrevive");

  // O caso que interessa: o modelo sabe o grupo mas nao a substancia.
  const truncado = validarResultado({ ...base, dci: "Paracetamol", codigoATC: "N02" }, cnps);
  check(truncado?.codigoATC === null, "ATC truncado 'N02' e rejeitado, nao completado");
  check(truncado?.dci === "Paracetamol", "...e a DCI sobrevive — os campos sao independentes");

  for (const mau of ["N02BE0", "N02BE011", "I02BE01", "NO2BE01", "", "  "]) {
    const r = validarResultado({ ...base, codigoATC: mau }, cnps);
    check(r?.codigoATC === null, `ATC invalido ${JSON.stringify(mau)} e rejeitado`);
  }
  // Minusculas e espacos sao normalizados, nao rejeitados: e a mesma
  // resposta escrita de outra maneira, nao outra resposta.
  const sujo = validarResultado({ ...base, codigoATC: " n02be01 " }, cnps);
  check(sujo?.codigoATC === "N02BE01", "ATC em minusculas com espacos e normalizado");

  // Uma frase no campo da DCI e o sinal classico de o modelo estar a
  // explicar em vez de nomear.
  const frase = validarResultado(
    { ...base, dci: "nao sei ao certo, possivelmente paracetamol ou ibuprofeno consoante a apresentacao" },
    cnps,
  );
  check(frase?.dci === null, "DCI demasiado longa (frase, nao denominacao) e rejeitada");

  const semClinica = validarResultado(
    { ...base, dci: "", codigoATC: "", dosagem: "", embalagem: "", confidenceClinica: 0.1 },
    cnps,
  );
  check(
    semClinica !== null && semClinica.dci === null && semClinica.codigoATC === null,
    "vazios ficam null e o resultado continua valido",
  );
  check(
    semClinica?.categoria === "MEDICAMENTOS",
    "...e a categoria sobrevive mesmo sem clinica nenhuma — a classificacao nao se perde",
  );
}

console.log("\n=== ke-2.0: as escritas clinicas sao preenchimento, nunca correccao ===");
{
  const runnerSrc = readFileSync(
    new URL("../../lib/catalog/knowledge-enrichment-runner.ts", import.meta.url),
    "utf8",
  );
  // A guarda real contra sobrepor uma fonte melhor nao e o comentario —
  // e o `is null` no WHERE. Se alguem o tirar, este teste cai.
  for (const campo of ["dci", "codigoATC", "formaFarmaceutica", "dosagem", "embalagem"]) {
    check(
      runnerSrc.includes(`p."${campo}" is null`) ||
        runnerSrc.includes('p."${coluna}" is null'),
      `o UPDATE de ${campo} exige que a coluna esteja NULL`,
    );
  }
  check(
    runnerSrc.includes("r.confidenceClinica >= LIMIAR_CLINICO"),
    "nenhum campo clinico e escrito abaixo de LIMIAR_CLINICO",
  );
  check(
    runnerSrc.includes('"classificationVersion"'),
    "as escritas clinicas carimbam a versao — e o que as torna reversiveis em bloco",
  );
  check(
    LIMIAR_CLINICO > LIMIAR_PERSISTENCIA,
    "a barra para gravar um ATC e mais alta que a barra para gravar uma categoria",
    `clinico ${LIMIAR_CLINICO} > classificacao ${LIMIAR_PERSISTENCIA}`,
  );
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
  // MUDANÇA DELIBERADA (2026-09, classificação provisória).
  //
  // Esta asserção dizia "confiança 1.0 sozinha não abre a porta" e o caso
  // era `CATEGORIA_PRODUTO` com par válido e subcategoria específica —
  // que hoje entra pela porta PROVISÓRIA. A frase continua verdadeira e o
  // exemplo deixou de a ilustrar: não é a confiança que abre a porta, são
  // os cinco critérios juntos (par válido, subcategoria específica, sem
  // contradição de estatuto, sem conflito, e confiança >= 0,85), e o que
  // sai é uma escrita MARCADA e reversível, não uma verdade.
  //
  // O que se afirma agora, e é o que interessa: a evidência continua a
  // falhar — logo a escrita NUNCA é canónica.
  const d = avaliarGate({ ...base, evidenceType: "CATEGORIA_PRODUTO", confidence: 1 }, SEM_CLASSIF);
  check(!d.criterios.evidencia && d.criterios.confianca, "o critério que falha é a evidência, não a confiança");
  check(d.provisorio, "…e por isso a escrita é PROVISÓRIA");
  check(!d.gravarProductType, "…e uma dedução nunca decide o productType");

  // A confiança sozinha continua a não chegar: baixa-a e a porta fecha.
  const baixa = avaliarGate({ ...base, evidenceType: "CATEGORIA_PRODUTO", confidence: 0.8 }, SEM_CLASSIF);
  check(baixa.decisao === "REVIEW" && !baixa.provisorio, "confiança abaixo do limiar fecha as duas portas");

  // E sem subcategoria específica também não: o critério novo é mesmo
  // exigido, e não decorativo.
  const balde = avaliarGate(
    { ...base, evidenceType: "CATEGORIA_PRODUTO", confidence: 1, subcategoria: "Outros Medicamentos" },
    SEM_CLASSIF,
  );
  check(balde.decisao === "REVIEW" && !balde.provisorio, "proposta 'Outros X' não abre a porta provisória");
}
{
  // `EVIDENCIA_PERMITIDA` é a porta CANÓNICA e não se toca — é ela que
  // garante que uma dedução nunca passa por facto.
  check(!EVIDENCIA_PERMITIDA.has("CATEGORIA_PRODUTO"), "CATEGORIA_PRODUTO não autoriza escrita CANÓNICA");
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

console.log("\n=== alvo do pedido: não perguntar o que o gate nunca aplicaria ===");
{
  check(alvoParaProduto({ subcategoria: null }) === "CLASSIFICACAO", "sem subcategoria → classificação");
  check(alvoParaProduto({ subcategoria: "Outros Medicamentos" }) === "CLASSIFICACAO", "em 'Outros' → classificação");
  check(alvoParaProduto({ subcategoria: "Diabetes" }) === "UTILIZACOES", "N2 específica → só utilizações");
  // A mesma condição que o gate usa para a não-degradação. Se as duas
  // divergissem, voltávamos a pedir o que não se pode aplicar.
  check(
    avaliarGate(base, ESPECIFICO).alvo === alvoParaProduto({ subcategoria: ESPECIFICO.subcategoria }),
    "o alvo do gate é o mesmo que alvoParaProduto — não há duas verdades",
  );
}
{
  const so = validarResultadoUtilizacoes(
    { cnp: 1234567, utilizacoes: ["diabetes", "inventada"], confidence: 0.95,
      evidenceType: "MARCA_CONHECIDA", categoriaProvavel: "MEDICAMENTOS", rationale: "x" },
    LOTE,
  );
  check(so?.categoria === null && so?.subcategoria === null,
    "resultado de utilizações NUNCA traz categoria — nem por engano poderia ser escrita");
  check(so?.productType === null, "…nem productType");
  check(so?.utilizacoes.join() === "diabetes", "…e os slugs continuam filtrados pelo vocabulário");
  check(so?.sugestaoCategoria === "MEDICAMENTOS", "…a categoria provável é guardada à parte");
  const fora = validarResultadoUtilizacoes(
    { cnp: 1234567, utilizacoes: [], confidence: 0.9, evidenceType: "MARCA_CONHECIDA",
      categoriaProvavel: "FARMÁCIA GERAL", rationale: "x" },
    LOTE,
  );
  check(fora?.sugestaoCategoria === null, "categoria provável fora dos níveis 1 canónicos é descartada");
}
{
  const util = { ...base, categoria: null, subcategoria: null, productType: null,
    alvo: "UTILIZACOES" as const, utilizacoes: ["diabetes"] };
  const d = avaliarGate(util, ESPECIFICO);
  check(d.decisao === "APPLY" && !d.gravarCategoria && !d.gravarProductType,
    "APPLY de utilizações não escreve classificação nem productType");
  check(d.utilizacoes.join() === "diabetes", "…escreve as utilizações");
  check(d.criterios.semConflito, "…e semConflito é verdade porque não há classificação a colidir");
}
{
  const vazio = { ...base, categoria: null, subcategoria: null, alvo: "UTILIZACOES" as const, utilizacoes: [] };
  const d = avaliarGate(vazio, ESPECIFICO);
  check(d.decisao === "SKIP", "sem utilizações seguras é SKIP, não REVIEW — não há nada a decidir");
  check(d.utilizacoes.length === 0, "…e não escreve nada");
}
{
  const baixa = { ...base, categoria: null, subcategoria: null, alvo: "UTILIZACOES" as const,
    confidence: 0.5, utilizacoes: ["diabetes"] };
  const d = avaliarGate(baixa, ESPECIFICO);
  check(d.decisao === "REVIEW" && d.utilizacoes.length === 0,
    "o limiar 0.85 continua a valer no caminho de utilizações");
}
{
  const evid = { ...base, categoria: null, subcategoria: null, alvo: "UTILIZACOES" as const,
    evidenceType: "CATEGORIA_PRODUTO" as const, utilizacoes: ["diabetes"] };
  const d = avaliarGate(evid, ESPECIFICO);
  check(d.decisao === "REVIEW", "CATEGORIA_PRODUTO continua a não autorizar escrita");
}

console.log("\n=== anomalia: discordância forte é auditoria, nunca overwrite ===");
{
  const discorda = { ...base, categoria: null, subcategoria: null, alvo: "UTILIZACOES" as const,
    utilizacoes: ["diabetes"], sugestaoCategoria: "DERMOCOSMÉTICA" };
  const d = avaliarGate(discorda, ESPECIFICO);
  check(d.anomalia !== null, "modelo põe o produto noutro nível 1 → anomalia registada");
  check(d.decisao === "REVIEW", "…vai para revisão humana");
  check(!d.gravarCategoria, "…e NÃO sobrepõe a classificação existente");
  check(d.utilizacoes.length === 0,
    "…nem escreve as utilizações: se ele acha que é outro produto, as etiquetas são de outro produto");
  check(d.anomalia!.includes("DERMOCOSMÉTICA") && d.anomalia!.includes("MEDICAMENTOS"),
    "…e a anomalia diz os dois lados", d.anomalia!);
}
{
  const concorda = { ...base, categoria: null, subcategoria: null, alvo: "UTILIZACOES" as const,
    utilizacoes: ["diabetes"], sugestaoCategoria: "MEDICAMENTOS" };
  const d = avaliarGate(concorda, ESPECIFICO);
  check(d.anomalia === null && d.decisao === "APPLY", "concordar no nível 1 não levanta anomalia");
}
{
  // O caminho defensivo: um resultado em forma de classificação que
  // chegue a um produto já classificado. Antes era SKIP silencioso.
  const d = avaliarGate({ ...base, categoria: "SUPLEMENTOS ALIMENTARES", subcategoria: "Vitaminas e Minerais" }, ESPECIFICO);
  check(d.anomalia !== null && d.decisao === "REVIEW",
    "resultado de classificação que discorda do nível 1 também levanta anomalia");
}

console.log("\n=== comparação de passagens no caminho de utilizações ===");
{
  const p = { ...base, categoria: null, subcategoria: null, alvo: "UTILIZACOES" as const, utilizacoes: ["diabetes", "dor-e-febre"] };
  const q = { ...p, utilizacoes: ["diabetes"] };
  const v = compararPassagens(p, q);
  check(v.concorda, "interseção não vazia → concordam");
  check(v.utilizacoesConfirmadas.join() === "diabetes", "…e só a vista pelas duas sobrevive");
}
{
  const p = { ...base, categoria: null, subcategoria: null, alvo: "UTILIZACOES" as const, utilizacoes: ["diabetes"] };
  const q = { ...p, utilizacoes: ["tosse"] };
  const v = compararPassagens(p, q);
  check(!v.concorda,
    "interseção vazia → NÃO concordam (dois null não são acordo sobre coisa nenhuma)");
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
  // Os dois tiers de modelo são os últimos. Entre eles, o PROPAGATED é o
  // mais fraco: não é uma observação DESTE produto, é a conclusão sobre
  // um irmão da mesma família aplicada aqui.
  check(
    SOURCE_TIER_RANK.MODEL_PROPAGATED > SOURCE_TIER_RANK.MODEL_INFERRED,
    "MODEL_PROPAGATED é menos autoritário que MODEL_INFERRED",
  );
  const reais = Object.entries(SOURCE_TIER_RANK).filter(
    ([k]) => k !== "MODEL_INFERRED" && k !== "MODEL_PROPAGATED",
  );
  check(
    reais.every(([, v]) => v < SOURCE_TIER_RANK.MODEL_INFERRED),
    "qualquer fonte real ganha aos dois tiers de modelo",
    reais.map(([k, v]) => `${k}=${v}`).join(" "),
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
          if (ehQueryContexto(sql)) return CONTEXTO;
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

  CONTEXTO = contextoNeutro([1234567]);
  const seco = await runKnowledgeEnrichment(fake, {
    dryRun: true,
    // Offline: sem isto o runner tentava alcançar o control plane.
    usarGlobal: false,
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
  CONTEXTO = contextoNeutro([1234567]);
  await runKnowledgeEnrichment(fake2, {
    dryRun: false,
    // Offline: sem isto o runner tentava alcançar o control plane.
    usarGlobal: false,
    classificar: resposta(),
    verificar: resposta(),
  }).catch(() => {});
  check(molhado.length > 0, "com --apply a mesma volta TENTA escrever (o dry-run não estava vazio)");
}

// ══════════════════════════════════════════════════════════════════════
// ALVO FORMA — o pedido estreito para quem só precisa da forma
//
// Contexto medido (auditoria de 2026-09-03): no backlog que cobre 95% das
// unidades vendidas, 1 169 de 1 776 produtos têm categoria e subcategoria
// decididas e falta-lhes só a forma. Até aqui esses produtos derivavam
// alvo UTILIZACOES, e o esquema desse pedido NÃO tem campo `forma`: a
// resposta certa era impossível de dar. Estes testes seguram o caminho
// novo — e, sobretudo, seguram o que ele NÃO pode tocar.
// ══════════════════════════════════════════════════════════════════════

console.log("\n=== alvo FORMA: derivação ===");
{
  check(
    alvoParaProduto({ subcategoria: "Diabetes", forma: null }) === "FORMA",
    "classificado e sem forma → alvo FORMA",
  );
  check(
    alvoParaProduto({ subcategoria: "Diabetes", forma: "" }) === "FORMA",
    "…string vazia conta como sem forma",
  );
  check(
    alvoParaProduto({ subcategoria: "Diabetes", forma: "comprimido" }) === "UTILIZACOES",
    "classificado e COM forma → continua UTILIZACOES",
  );
  check(
    alvoParaProduto({ subcategoria: null, forma: null }) === "CLASSIFICACAO",
    "sem subcategoria → CLASSIFICACAO, mesmo sem forma",
  );
  check(
    alvoParaProduto({ subcategoria: "Outros Medicamentos", forma: null }) === "CLASSIFICACAO",
    "fallback 'Outros …' → CLASSIFICACAO, mesmo sem forma",
  );
  // O chamador que NÃO sabe da forma tem de continuar a ver o que via.
  // Sem esta distinção, todo o código antigo passaria a pedir formas.
  check(
    alvoParaProduto({ subcategoria: "Diabetes" }) === "UTILIZACOES",
    "chamador que não passa `forma` continua a derivar UTILIZACOES (compatibilidade)",
  );
}

console.log("\n=== alvo FORMA: validação da resposta ===");
{
  const LOTE_F = new Set([1234567]);
  const cru = (r: Record<string, unknown>) => validarResultadoForma(r, LOTE_F);

  const bom = cru({ cnp: 1234567, forma: "comprimido revestido", confidence: 0.97 });
  check(bom?.forma === "comprimido revestido", "forma do vocabulário é aceite");
  check(bom?.alvo === "FORMA", "…e o resultado vem marcado com o alvo");
  check(bom?.evidenceType === "FORMA_DEDUZIDA", "…com evidência própria");
  check(bom?.confidenceClinica === 0.97, "…e a confiança entra no campo CLÍNICO");
  check(bom?.confidence === 0, "…enquanto a confiança de CLASSIFICAÇÃO fica a zero");
  check(
    bom?.categoria === null && bom?.subcategoria === null && bom?.productType === null,
    "…e nem categoria, nem subcategoria, nem productType vêm preenchidos",
  );
  check(
    bom?.dci === null && bom?.codigoATC === null && bom?.dosagem === null && bom?.embalagem === null,
    "…nem DCI, ATC, dosagem ou embalagem — este pedido não os faz",
  );
  check(bom?.utilizacoes.length === 0, "…e a lista de utilizações vem vazia");

  check(
    cru({ cnp: 1234567, forma: "  COMPRIMIDO REVESTIDO  ", confidence: 0.95 })?.forma === "comprimido revestido",
    "maiúsculas e espaços são normalizados",
  );
  check(
    cru({ cnp: 1234567, forma: "comprimido para mastigar", confidence: 0.95 })?.forma === "comprimido mastigável",
    "sinónimo medido é resolvido para o canónico",
  );

  check(
    cru({ cnp: 1234567, forma: "pastilha elástica", confidence: 0.99 })?.forma === null,
    "forma fora do vocabulário fechado é DESCARTADA",
  );
  check(cru({ cnp: 1234567, forma: "", confidence: 0.99 })?.forma === null, "forma vazia é null");
  check(
    cru({ cnp: 1234567, forma: "pastilha elástica", confidence: 0.99 })?.confidenceClinica === 0,
    "…e sem forma a confiança cai a zero — não fica uma confiança órfã",
  );
  check(
    cru({ cnp: 7777777, forma: "comprimido", confidence: 0.99 }) === null,
    "cnp que não estava no lote é recusado (linha alucinada)",
  );
  check(
    normalizarForma("solução oral em gotas") === "gotas orais" && normalizarForma("xarope") === "xarope",
    "o normalizador é o mesmo dos dois lados",
  );
}

console.log("\n=== alvo FORMA: o gate ===");
{
  const ATUAL = {
    categoria: "MEDICAMENTOS",
    subcategoria: "Diabetes",
    productType: "MEDICAMENTO",
    forma: null,
  };
  const resultado = (forma: string | null, conf: number): KnowledgeResult => ({
    cnp: 1234567,
    productType: null,
    categoria: null,
    subcategoria: null,
    forma,
    dci: null,
    codigoATC: null,
    dosagem: null,
    embalagem: null,
    confidenceClinica: conf,
    categoriaBruta: null,
    subcategoriaBruta: null,
    motivoPar: null,
    utilizacoes: [],
    confidence: 0,
    evidenceType: "FORMA_DEDUZIDA",
    rationale: "",
    alvo: "FORMA",
  });

  const aceite = avaliarGate(resultado("comprimido", 0.95), ATUAL);
  check(aceite.decisao === "APPLY", "forma válida e confiança ≥ limiar → APPLY", aceite.motivo);
  check(aceite.alvo === "FORMA", "…e o gate reconhece o alvo");

  const fraco = avaliarGate(resultado("comprimido", LIMIAR_CLINICO - 0.01), ATUAL);
  check(fraco.decisao === "REVIEW", "confiança abaixo do limiar clínico → REVIEW, não escreve", fraco.motivo);

  const vazio = avaliarGate(resultado(null, 0.99), ATUAL);
  check(vazio.decisao === "SKIP", "forma vazia → SKIP, por muito confiante que venha", vazio.motivo);

  // Fora do vocabulário nunca chega aqui (o validador já o anula), mas o
  // gate tem de segurar na mesma: duas fechaduras, não uma.
  const inventado = avaliarGate(resultado("pastilha elástica", 0.99), ATUAL);
  check(inventado.decisao === "SKIP", "forma fora do vocabulário → SKIP também no gate", inventado.motivo);

  const intruso = avaliarGate({ ...resultado("comprimido", 0.99), evidenceType: "MARCA_CONHECIDA" }, ATUAL);
  check(
    intruso.decisao === "SKIP",
    "resultado que não veio do pedido de forma não escreve forma por aqui",
    intruso.motivo,
  );

  check(aceite.gravarCategoria === false, "APPLY de forma NUNCA grava categoria");
  check(aceite.gravarProductType === false, "…nem productType");
  check(aceite.utilizacoes.length === 0, "…nem utilizações");
  const forcado = avaliarGate(
    { ...resultado("comprimido", 0.99), categoria: "DERMOCOSMÉTICA", subcategoria: "Rosto" },
    ATUAL,
  );
  check(forcado.gravarCategoria === false, "…mesmo que o resultado traga categoria, o alvo FORMA não a grava");

  check(precisaVerificacao(resultado("comprimido", 0.99)) === false, "resultado de FORMA não pede verificação");
  check(
    precisaVerificacao({ ...resultado("comprimido", 0.99), categoria: "MEDICAMENTOS" }) === false,
    "…nem quando traz categoria MEDICAMENTOS — o alvo decide primeiro",
  );
  check(
    precisaVerificacao({
      ...resultado("comprimido", 0.99),
      alvo: "CLASSIFICACAO",
      categoria: "MEDICAMENTOS",
    }) === true,
    "…e a guarda é mesmo do alvo (sem ele, MEDICAMENTOS continua a exigir verificação)",
  );
}

console.log("\n=== alvo FORMA: comportamento antigo intacto ===");
{
  const R: KnowledgeResult = {
    cnp: 1234567,
    productType: "MEDICAMENTO",
    categoria: "MEDICAMENTOS",
    subcategoria: "Diabetes",
    forma: null,
    dci: null,
    codigoATC: null,
    dosagem: null,
    embalagem: null,
    confidenceClinica: 0,
    utilizacoes: ["diabetes"],
    confidence: 0.95,
    evidenceType: "MARCA_CONHECIDA",
    rationale: "Ozempic é semaglutido",
    categoriaBruta: "MEDICAMENTOS",
    subcategoriaBruta: "Diabetes",
    motivoPar: null,
  };
  const classifica = avaliarGate(R, { categoria: null, subcategoria: null, productType: null });
  check(
    classifica.decisao === "APPLY" && classifica.gravarCategoria,
    "classificação continua a escrever como antes",
  );
  const utiliza = avaliarGate(R, {
    categoria: "MEDICAMENTOS",
    subcategoria: "Diabetes",
    productType: "MEDICAMENTO",
    forma: "comprimido",
  });
  check(
    utiliza.alvo === "UTILIZACOES" && utiliza.decisao === "APPLY" && !utiliza.gravarCategoria,
    "utilizações continuam a escrever como antes, sem tocar na classificação",
  );
  check(
    EVIDENCIA_PERMITIDA.has("MARCA_CONHECIDA") && !EVIDENCIA_PERMITIDA.has("FORMA_DEDUZIDA"),
    "FORMA_DEDUZIDA não entrou na lista que autoriza escrita de categoria",
  );
}

console.log("\n=== alvo FORMA: no runner (lote de 50, sem segunda passagem) ===");
{
  // 60 produtos com N2 específica e SEM forma. Chegam todos ao alvo
  // FORMA, e o que se mede é como são partidos e quantas chamadas custam.
  const N = 60;
  const BASE = 6_000_000;
  const prisma = {
    $queryRawUnsafe: async (sql: string, ...params: unknown[]) => {
      if (ehQueryContexto(sql)) return CONTEXTO;
      if (/from "Classificacao"/i.test(sql)) return [];
      if (/from "Utilizacao"/i.test(sql)) return [];
      if (/count\(\*\)/i.test(sql)) return [{ n: N }];
      const limite = Number(params[3] ?? 0);
      const cursor = Number(params[4] ?? 0);
      return Array.from({ length: N }, (_, i) => BASE + i)
        .filter((cnp) => cnp > cursor)
        .slice(0, limite)
        .map((cnp) => ({
          cnp,
          designacao: `Zeta${cnp}`,
          productType: null,
          categoriaAtual: "MEDICAMENTOS",
          subcategoriaAtual: "Diabetes",
          formaAtual: null,
          estrato: "SEM_UTILIZACOES" as const,
        }));
    },
    $executeRawUnsafe: async () => 0,
    knowledgeEnrichmentCache: { upsert: async () => ({}) },
  };

  // Cobertura de "Diabetes" alta, para a pré-selecção não excluir nada
  // por baixa cobertura — este teste é sobre lotes, não sobre exclusões.
  CONTEXTO = [
    ...contextoNeutro(Array.from({ length: N }, (_, i) => BASE + i), "Diabetes").map((c) => ({ ...c, utilizacoes: [] })),
    ...contextoNeutro(Array.from({ length: N }, (_, i) => 9_500_000 + i), "Diabetes"),
  ];

  const tamanhos: number[] = [];
  const chamados = { classificacao: 0, utilizacoes: 0, verificacao: 0 };
  const respostaForma = async (produtos: { cnp: number }[]) => {
    tamanhos.push(produtos.length);
    return {
      resultados: produtos.map((p) => ({
        ...base,
        cnp: p.cnp,
        alvo: "FORMA" as const,
        categoria: null,
        subcategoria: null,
        productType: null,
        utilizacoes: [],
        confidence: 0,
        confidenceClinica: 0.97,
        forma: "comprimido",
        evidenceType: "FORMA_DEDUZIDA" as const,
        rationale: "",
      })),
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  };
  const naoDevia = (qual: keyof typeof chamados) => async (produtos: { cnp: number }[]) => {
    chamados[qual] += 1;
    return {
      resultados: produtos.map((p) => ({ ...base, cnp: p.cnp })),
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = await runKnowledgeEnrichment(prisma as any, {
    dryRun: true,
    usarGlobal: false,
    limite: N,
    classificarForma: respostaForma,
    classificar: naoDevia("classificacao"),
    classificarUtilizacoes: naoDevia("utilizacoes"),
    verificar: naoDevia("verificacao"),
  });

  check(TAMANHO_LOTE_FORMA === 50, `o lote de FORMA é 50 (${TAMANHO_LOTE_FORMA})`);
  check(tamanhos.length > 0, "o pedido de FORMA foi mesmo usado", `lotes=${tamanhos.join(",")}`);
  check(
    tamanhos.every((t) => t <= TAMANHO_LOTE_FORMA),
    `nenhum lote passa dos ${TAMANHO_LOTE_FORMA}`,
    `lotes=${tamanhos.join(",")}`,
  );
  check(
    tamanhos[0] === TAMANHO_LOTE_FORMA,
    `o primeiro lote leva os ${TAMANHO_LOTE_FORMA} — não fica pelos 25 do outro pedido`,
    `lotes=${tamanhos.join(",")}`,
  );
  check(
    tamanhos.reduce((a, b) => a + b, 0) === N,
    `os ${N} produtos foram todos enviados`,
    `lotes=${tamanhos.join(",")}`,
  );

  // 7 (ao nível do runner): a segunda passagem NÃO acontece.
  check(
    r.chamadasVerificacao === 0,
    `FORMA não faz segunda passagem (chamadasVerificacao=${r.chamadasVerificacao})`,
  );
  check(
    chamados.verificacao === 0 && chamados.classificacao === 0 && chamados.utilizacoes === 0,
    "…e nem o pedido de classificação nem o de utilizações foram chamados",
    JSON.stringify(chamados),
  );
  check(
    r.chamadasProposta === tamanhos.length,
    `uma chamada por lote e mais nenhuma (propostas=${r.chamadasProposta}, lotes=${tamanhos.length})`,
  );
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
      const where = sql.slice(sql.indexOf("where p.cnp > $1"));
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
          if (ehQueryContexto(sql)) return CONTEXTO;
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
          // O cursor é `$5` e a ordem é o cnp: a página seguinte começa
          // no primeiro cnp acima dele. Sem isto o duplo falso devolvia
          // sempre a mesma página e a paginação passava por acidente.
          const cursor = Number(params[4] ?? 0);
          const todos = Array.from({ length: disponivel }, (_, i) => baseCnp[est] + i);
          return todos
            .filter((cnp) => cnp > cursor)
            .slice(0, limite)
            .map((cnp) => ({
              cnp,
              designacao: `${est} ${cnp}`,
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

  // A janela precisa do contexto do tenant para saber o que é
  // processável. Nomes só de letras e únicos por cnp: com designações
  // repetidas todos os produtos cairiam na MESMA família, o estrato
  // teria um único processável, e as quotas passariam a medir outra
  // coisa sem se queixarem.
  const BASE_CNP: Record<string, number> = {
    NAO_CLASSIFICADO: 3_000_000,
    OUTROS_MEDICAMENTOS: 4_000_000,
    SEM_UTILIZACOES: 5_000_000,
  };
  const soLetras = (n: number) => {
    let s = "";
    let x = n;
    do {
      s = String.fromCharCode(97 + (x % 26)) + s;
      x = Math.floor(x / 26);
    } while (x > 0);
    return `Zeta${s}`;
  };
  const contextoDaPopulacao = (pop: Record<string, number>): LinhaContexto[] => {
    const out: LinhaContexto[] = [];
    for (const [est, n] of Object.entries(pop)) {
      for (let i = 0; i < n; i++) {
        const cnp = BASE_CNP[est] + i;
        out.push({ cnp, designacao: soLetras(cnp), nivel1: null, nivel2: null, utilizacoes: [] });
      }
    }
    return out;
  };
  const janelaCanary = async (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma: any,
    pop: Record<string, number>,
  ) => {
    const contexto = contextoDaPopulacao(pop);
    return lerJanelaCanary(prisma, QUOTAS_CANARY, {
      contexto,
      familias: agruparFamilias(contexto),
      subExcluidas: new Set<string>(),
    });
  };

  // ── Caso 1: os três estratos com produtos de sobra ──────────────────
  {
    const { prisma, consultas } = prismaEstratos({
      OUTROS_MEDICAMENTOS: 500,
      NAO_CLASSIFICADO: 500,
      SEM_UTILIZACOES: 500,
    });
    const a = await janelaCanary(prisma, {
      OUTROS_MEDICAMENTOS: 500,
      NAO_CLASSIFICADO: 500,
      SEM_UTILIZACOES: 500,
    });

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
    const a = await janelaCanary(prisma, {
      OUTROS_MEDICAMENTOS: 0,
      NAO_CLASSIFICADO: 500,
      SEM_UTILIZACOES: 0,
    });

    check(a.linhas.length === 30, "com dois estratos vazios vêm 30 produtos — o número que apareceu em produção");
    const q = Object.fromEntries(a.quotas.map((x) => [x.estrato, x]));
    check(q.OUTROS_MEDICAMENTOS.defice === 40, "…e o défice de OUTROS_MEDICAMENTOS é reportado (40)");
    check(q.SEM_UTILIZACOES.defice === 30, "…e o de SEM_UTILIZACOES também (30)");
    check(q.NAO_CLASSIFICADO.defice === 0, "…e o estrato servido não reporta défice");
    check(
      q.OUTROS_MEDICAMENTOS.universo === 0 && q.SEM_UTILIZACOES.universo === 0,
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
    const a = await janelaCanary(prisma, {
      OUTROS_MEDICAMENTOS: 12,
      NAO_CLASSIFICADO: 500,
      SEM_UTILIZACOES: 500,
    });
    const q = Object.fromEntries(a.quotas.map((x) => [x.estrato, x]));
    check(q.OUTROS_MEDICAMENTOS.enviados === 12 && q.OUTROS_MEDICAMENTOS.defice === 28,
      "estrato com 12 no universo dá 12 e reporta défice de 28");
    check(a.linhas.length === 72, "o total encolhe para 72 — e não se enche com produtos de outro estrato");
  }

  // ── Caso 4: o resumo do runner leva as quotas ───────────────────────
  {
    const { prisma } = prismaEstratos({
      OUTROS_MEDICAMENTOS: 0,
      NAO_CLASSIFICADO: 500,
      SEM_UTILIZACOES: 0,
    });
    CONTEXTO = contextoNeutro(Array.from({ length: 30 }, (_, i) => 3_000_000 + i));
    const r = await runKnowledgeEnrichment(prisma, {
      dryRun: true,
    // Offline: sem isto o runner tentava alcançar o control plane.
    usarGlobal: false,
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
    CONTEXTO = contextoNeutro([3_000_000, 3_000_001, 3_000_002, 3_000_003, 3_000_004]);
    const r = await runKnowledgeEnrichment(prisma, {
      dryRun: true,
    // Offline: sem isto o runner tentava alcançar o control plane.
    usarGlobal: false,
      limite: 5,
      classificar: async () => ({
        resultados: [],
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }),
    });
    check(r.quotasCanary === null, "corrida normal (sem canary) não inventa quotas");
  }
}

console.log("\n=== métricas e projecção por estrato ===");
{
  // Populações e custos DIFERENTES por estrato — é essa a razão de ser
  // desta secção. Uma média global multiplicada pela população total
  // daria um número redondo e errado.
  const POP = { OUTROS_MEDICAMENTOS: 7000, NAO_CLASSIFICADO: 2500, SEM_UTILIZACOES: 9000 };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prisma: any = {
    $queryRawUnsafe: async (sql: string, ...params: unknown[]) => {
          if (ehQueryContexto(sql)) return CONTEXTO;
      if (/from "Classificacao"/i.test(sql)) return [];
      if (/from "Utilizacao"/i.test(sql)) return [];
      const where = sql.slice(sql.indexOf("where p.cnp > $1"));
      const est: Estrato = /classificacaoNivel2Id" is null/.test(where)
        ? "NAO_CLASSIFICADO"
        : /c2\.nome ilike 'Outros %'/.test(where)
        ? "OUTROS_MEDICAMENTOS"
        : "SEM_UTILIZACOES";
      if (/count\(\*\)/i.test(sql)) return [{ n: POP[est] }];
      const n = Math.min(POP[est], Number(params[3] ?? 0));
      const bases = { NAO_CLASSIFICADO: 3_000_000, OUTROS_MEDICAMENTOS: 4_000_000, SEM_UTILIZACOES: 5_000_000 };
      return Array.from({ length: n }, (_, i) => ({
        cnp: bases[est] + i,
        designacao: `${est} ${i}`,
        productType: null,
        categoriaAtual: est === "NAO_CLASSIFICADO" ? null : "MEDICAMENTOS",
        // Só o SEM_UTILIZACOES tem N2 específica — é o que o torna alvo
        // de utilizações.
        subcategoriaAtual: est === "SEM_UTILIZACOES" ? "Diabetes"
          : est === "OUTROS_MEDICAMENTOS" ? "Outros Medicamentos" : null,
        // COM forma, de proposito. Este teste e' sobre o custo do pedido
        // de UTILIZACOES, e desde o alvo FORMA um produto especifico SEM
        // forma deixa de ir por ai' — vai pedir a forma primeiro. Sem
        // esta linha o fixture media outro caminho e dizia que o de
        // utilizacoes tinha parado de escrever.
        formaAtual: est === "SEM_UTILIZACOES" ? "comprimido" : null,
        estrato: est,
      }));
    },
    $executeRawUnsafe: async () => 0,
    knowledgeEnrichmentCache: { upsert: async () => ({}) },
  };

  const resposta = (outPorProduto: number, alvo: "CLASSIFICACAO" | "UTILIZACOES") =>
    async (produtos: { cnp: number }[]) => ({
      resultados: produtos.map((p) => ({
        ...base,
        cnp: p.cnp,
        alvo,
        ...(alvo === "UTILIZACOES"
          ? { categoria: null, subcategoria: null, productType: null, sugestaoCategoria: "MEDICAMENTOS" }
          : {}),
      })),
      usage: {
        inputTokens: 100 * produtos.length,
        outputTokens: outPorProduto * produtos.length,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    });

  // Diabetes tem 30 do residual + 30 com utilização: cobertura 50%, bem
  // acima dos 2%, logo a exclusão por baixa cobertura não dispara aqui.
  CONTEXTO = [
    ...contextoNeutro(Array.from({ length: 40 }, (_, i) => 4_000_000 + i)),
    ...contextoNeutro(Array.from({ length: 30 }, (_, i) => 3_000_000 + i)),
    ...contextoNeutro(Array.from({ length: 30 }, (_, i) => 5_000_000 + i), "Diabetes").map((c) => ({ ...c, utilizacoes: [] })),
    ...contextoNeutro(Array.from({ length: 30 }, (_, i) => 9_000_000 + i), "Diabetes"),
  ];
  const r = await runKnowledgeEnrichment(prisma, {
    dryRun: true,
    // Offline: sem isto o runner tentava alcançar o control plane.
    usarGlobal: false,
    canary: QUOTAS_CANARY,
    // O pedido de utilizações devolve MENOS output por produto: é essa a
    // poupança que a projecção tem de conseguir ver.
    classificar: resposta(400, "CLASSIFICACAO"),
    verificar: resposta(400, "CLASSIFICACAO"),
    classificarUtilizacoes: resposta(80, "UTILIZACOES"),
    verificarUtilizacoes: resposta(80, "UTILIZACOES"),
  });

  const porEstrato = Object.fromEntries(r.metricasPorEstrato.map((m) => [m.estrato, m]));
  check(r.metricasPorEstrato.length === 3, `os três estratos têm métricas (${r.metricasPorEstrato.length})`);
  check(porEstrato.SEM_UTILIZACOES.alvo === "UTILIZACOES", "SEM_UTILIZACOES é servido pelo pedido de utilizações");
  check(porEstrato.OUTROS_MEDICAMENTOS.alvo === "CLASSIFICACAO", "OUTROS_MEDICAMENTOS pelo de classificação");
  check(porEstrato.NAO_CLASSIFICADO.alvo === "CLASSIFICACAO", "NAO_CLASSIFICADO pelo de classificação");

  check(
    porEstrato.SEM_UTILIZACOES.custoPorProduto < porEstrato.OUTROS_MEDICAMENTOS.custoPorProduto,
    `utilizações custa menos por produto ($${porEstrato.SEM_UTILIZACOES.custoPorProduto.toFixed(5)} < ` +
      `$${porEstrato.OUTROS_MEDICAMENTOS.custoPorProduto.toFixed(5)})`,
  );
  check(
    porEstrato.SEM_UTILIZACOES.apply === 30,
    `SEM_UTILIZACOES passa a ESCREVER (apply=${porEstrato.SEM_UTILIZACOES.apply}, era 0 em SKIP)`,
  );

  // Lotes homogéneos: sem isso não há atribuição de tokens por estrato.
  const somaTokens = r.metricasPorEstrato.reduce((s, m) => s + m.usage.outputTokens, 0);
  check(somaTokens === r.usage.outputTokens, "os tokens por estrato somam o total — nada se perde na atribuição");
  const somaCusto = r.metricasPorEstrato.reduce((s, m) => s + m.custoUsd, 0);
  check(Math.abs(somaCusto - r.custoEstimadoUsd) < 1e-9, "e o custo por estrato soma o custo global");

  // Projecção com a população de cada estrato, não com a média global.
  for (const m of r.metricasPorEstrato) {
    check(m.elegiveis === POP[m.estrato], `${m.estrato} projecta sobre a sua população (${m.elegiveis})`);
    check(
      Math.abs((m.projecaoUsd ?? 0) - m.custoPorProduto * POP[m.estrato]) < 1e-9,
      `${m.estrato}: projecção = custo/produto × população`,
    );
  }
  const projTotal = r.metricasPorEstrato.reduce((s, m) => s + (m.projecaoUsd ?? 0), 0);
  const mediaGlobal = (r.custoEstimadoUsd / r.residualAnalisado) * (POP.OUTROS_MEDICAMENTOS + POP.NAO_CLASSIFICADO + POP.SEM_UTILIZACOES);
  check(
    Math.abs(projTotal - mediaGlobal) > 1,
    `a projecção por estrato difere da média global ($${projTotal.toFixed(0)} vs $${mediaGlobal.toFixed(0)}) — ` +
      "é por isso que a média global não servia",
  );
}

// ══════════════════════════════════════════════════════════════════════
// CANARY QUE NÃO MEDIU NADA — a corrida real da Silveira
//
// 1 193 SEM_UTILIZACOES, 7 NAO_CLASSIFICADO, 0 OUTROS_MEDICAMENTOS,
// quotas 40/30/30, e ZERO produtos enviados ao modelo. O relatório dizia
// «TOTAL … 1200» ao lado de `obtido=0`, que se lê como «havia 1200 e
// mandámos 0 por opção». Não era isso: a pré-selecção recusava-os todos
// — a subcategoria do estrato grande tinha cobertura abaixo de 2%, e as
// sete designações do outro estrato eram opacas — e o canary passou por
// lá sem medir nada, a parecer eficiente.
//
// Uma amostra de zero não é uma amostra barata. É a ausência de medição.
// ══════════════════════════════════════════════════════════════════════

console.log("\n=== canary forçado: a reprodução da Silveira ===");
{
  const POP_SILVEIRA: Record<Estrato, number> = {
    SEM_UTILIZACOES: 1193,
    NAO_CLASSIFICADO: 7,
    OUTROS_MEDICAMENTOS: 0,
  };
  const BASE_CNP_S: Record<Estrato, number> = {
    NAO_CLASSIFICADO: 3_000_000,
    OUTROS_MEDICAMENTOS: 4_000_000,
    SEM_UTILIZACOES: 5_000_000,
  };

  /** Nome único e LEGÍVEL — não é opaco, e não colide em família. */
  const nomeLegivel = (n: number) => {
    let s = "";
    let x = n;
    do {
      s = String.fromCharCode(97 + (x % 26)) + s;
      x = Math.floor(x / 26);
    } while (x > 0);
    return `Zeta${s}`;
  };
  /** Só dígitos: `nomeOpaco` recusa-o, e é o caso dos 7 da Silveira. */
  const nomeOpacoDe = (n: number) => `${n} 12 20`;

  const designacaoDe = (est: Estrato, cnp: number) =>
    est === "NAO_CLASSIFICADO" ? nomeOpacoDe(cnp) : nomeLegivel(cnp);

  function prismaSilveira() {
    const estratoDe = (sql: string): Estrato => {
      const where = sql.slice(sql.indexOf("where p.cnp > $1"));
      if (/classificacaoNivel2Id" is null/.test(where)) return "NAO_CLASSIFICADO";
      if (/c2\.nome ilike 'Outros %'/.test(where)) return "OUTROS_MEDICAMENTOS";
      return "SEM_UTILIZACOES";
    };
    return {
      $queryRawUnsafe: async (sql: string, ...params: unknown[]) => {
        if (ehQueryContexto(sql)) return CONTEXTO;
        if (/from "Classificacao"/i.test(sql)) return [];
        if (/from "Utilizacao"/i.test(sql)) return [];
        const est = estratoDe(sql);
        const disponivel = POP_SILVEIRA[est];
        if (/count\(\*\)/i.test(sql)) return [{ n: disponivel }];
        const limite = Number(params[3] ?? 0);
        const cursor = Number(params[4] ?? 0);
        return Array.from({ length: disponivel }, (_, i) => BASE_CNP_S[est] + i)
          .filter((cnp) => cnp > cursor)
          .slice(0, limite)
          .map((cnp) => ({
            cnp,
            designacao: designacaoDe(est, cnp),
            productType: null,
            categoriaAtual: est === "NAO_CLASSIFICADO" ? null : "MEDICAMENTOS",
            subcategoriaAtual: est === "SEM_UTILIZACOES" ? "Diabetes" : null,
            // COM forma: este teste é sobre o canary, não sobre o alvo FORMA.
            formaAtual: est === "SEM_UTILIZACOES" ? "comprimido" : null,
            estrato: est,
          }));
      },
      $executeRawUnsafe: async () => 0,
      knowledgeEnrichmentCache: { upsert: async () => ({}) },
    };
  }

  // Contexto: "MEDICAMENTOS > Diabetes" com 1 193 produtos e NENHUM com
  // utilização → cobertura 0% < 2% → subcategoria excluída. É a causa
  // real da exclusão do estrato grande na Silveira.
  CONTEXTO = [
    ...Array.from({ length: POP_SILVEIRA.SEM_UTILIZACOES }, (_, i) => {
      const cnp = BASE_CNP_S.SEM_UTILIZACOES + i;
      return { cnp, designacao: nomeLegivel(cnp), nivel1: "MEDICAMENTOS", nivel2: "Diabetes", utilizacoes: [] };
    }),
    ...Array.from({ length: POP_SILVEIRA.NAO_CLASSIFICADO }, (_, i) => {
      const cnp = BASE_CNP_S.NAO_CLASSIFICADO + i;
      return { cnp, designacao: nomeOpacoDe(cnp), nivel1: null, nivel2: null, utilizacoes: [] };
    }),
  ];

  // ── 1. A DOENÇA: sem forçar, o canary não mede nada ─────────────────
  const semForcar = await lerJanelaCanary(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prismaSilveira() as any,
    QUOTAS_CANARY,
    { contexto: CONTEXTO, familias: agruparFamilias(CONTEXTO), subExcluidas: new Set(["MEDICAMENTOS > Diabetes"]) },
  );
  const qs = Object.fromEntries(semForcar.quotas.map((x) => [x.estrato, x]));
  check(
    qs.SEM_UTILIZACOES.enviados === 0 && qs.NAO_CLASSIFICADO.enviados === 0,
    "sem forçar, o canary da Silveira envia ZERO — a doença, reproduzida",
    `sem_util=${qs.SEM_UTILIZACOES.enviados} nao_class=${qs.NAO_CLASSIFICADO.enviados}`,
  );
  check(
    qs.SEM_UTILIZACOES.universo === 1193 && qs.NAO_CLASSIFICADO.universo === 7,
    "…e o universo é o real (1193 / 7), não zero — o estrato existe",
  );

  // ── 2. A CURA: com forçar, a amostra é efectiva ─────────────────────
  const forcado = await lerJanelaCanary(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prismaSilveira() as any,
    QUOTAS_CANARY,
    {
      contexto: CONTEXTO,
      familias: agruparFamilias(CONTEXTO),
      subExcluidas: new Set(["MEDICAMENTOS > Diabetes"]),
      forcarExcluidos: true,
    },
  );
  const qf = Object.fromEntries(forcado.quotas.map((x) => [x.estrato, x]));

  check(qf.SEM_UTILIZACOES.enviados === 30, `SEM_UTILIZACOES envia 30 (quota) — deu ${qf.SEM_UTILIZACOES.enviados}`);
  check(qf.NAO_CLASSIFICADO.enviados === 7, `NAO_CLASSIFICADO envia os 7 que existem — deu ${qf.NAO_CLASSIFICADO.enviados}`);
  check(qf.OUTROS_MEDICAMENTOS.enviados === 0, "OUTROS_MEDICAMENTOS envia 0 — o estrato está vazio");

  // Défice SÓ onde faltaram candidatos. O estrato grande serviu a quota
  // inteira e não pode aparecer em défice nenhum.
  check(qf.SEM_UTILIZACOES.defice === 0, `SEM_UTILIZACOES sem défice — deu ${qf.SEM_UTILIZACOES.defice}`);
  check(qf.NAO_CLASSIFICADO.defice === 23, `NAO_CLASSIFICADO com défice 23 (30 pedidos, 7 existem) — deu ${qf.NAO_CLASSIFICADO.defice}`);
  check(qf.OUTROS_MEDICAMENTOS.defice === 40, `OUTROS_MEDICAMENTOS com défice 40 (estrato vazio) — deu ${qf.OUTROS_MEDICAMENTOS.defice}`);

  // ── 3. As quatro colunas dizem coisas diferentes ────────────────────
  check(
    qf.SEM_UTILIZACOES.universo === 1193,
    `universo do estrato grande = 1193 (deu ${qf.SEM_UTILIZACOES.universo})`,
  );
  check(
    qf.SEM_UTILIZACOES.elegiveis === 0,
    `…elegíveis = 0: nenhum passaria a pré-selecção (deu ${qf.SEM_UTILIZACOES.elegiveis})`,
  );
  check(
    qf.SEM_UTILIZACOES.forcados === 30,
    `…e os 30 enviados são TODOS forçados (deu ${qf.SEM_UTILIZACOES.forcados})`,
  );
  check(
    qf.SEM_UTILIZACOES.seleccionados >= qf.SEM_UTILIZACOES.enviados,
    "…seleccionados nunca é menor que enviados",
  );
  check(
    qf.NAO_CLASSIFICADO.universo === 7 && qf.NAO_CLASSIFICADO.forcados === 7,
    "os 7 opacos também entram por força, e o universo continua a ser 7",
  );
  // O TOTAL do relatório deixa de poder dizer 1200 ao lado de zero.
  const totalUniverso = forcado.quotas.reduce((s, q) => s + q.universo, 0);
  const totalEnviados = forcado.quotas.reduce((s, q) => s + q.enviados, 0);
  check(
    totalUniverso === 1200 && totalEnviados === 37,
    `TOTAL: universo 1200 e enviados 37 em colunas distintas (deu ${totalUniverso}/${totalEnviados})`,
  );

  // ── 4. Ponta a ponta pelo runner: 37 ao modelo, nada escrito ────────
  const enviados: number[] = [];
  const respostaCanary = async (produtos: { cnp: number }[]) => {
    enviados.push(...produtos.map((p) => p.cnp));
    return {
      resultados: produtos.map((p) => ({ ...base, cnp: p.cnp })),
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  };
  const escritas: string[] = [];
  const prismaComEscrita = {
    ...prismaSilveira(),
    $executeRawUnsafe: async (sql: string) => {
      // A sessão read-only é a outra tranca; esta apanha a tentativa.
      if (!/set session/i.test(sql)) escritas.push(sql.slice(0, 40));
      return 0;
    },
    knowledgeEnrichmentCache: {
      upsert: async () => {
        escritas.push("KnowledgeEnrichmentCache.upsert");
        return {};
      },
    },
  };

  const r = await runKnowledgeEnrichment(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prismaComEscrita as any,
    {
      dryRun: true,
      usarGlobal: false,
      canary: QUOTAS_CANARY,
      forcarExcluidos: true,
      classificar: respostaCanary,
      verificar: respostaCanary,
      classificarUtilizacoes: respostaCanary,
    },
  );

  check(r.enviadosAoModelo === 37, `o runner envia 37 ao modelo (30 + 7) — enviou ${r.enviadosAoModelo}`);
  check(enviados.length >= 37, `…e o modelo recebeu mesmo os produtos (${enviados.length} linhas)`);
  check(
    r.forcadosNoCanary === 37,
    `…todos por força do canary (forcadosNoCanary=${r.forcadosNoCanary})`,
  );
  check(
    r.excluidosBaixaCobertura + r.excluidosOpacos === 0,
    "…e nenhum foi contado como excluído: um produto que foi ao modelo não é um produto poupado",
    `baixa=${r.excluidosBaixaCobertura} opacos=${r.excluidosOpacos}`,
  );
  check(escritas.length === 0, "o canary NÃO escreveu nada", escritas.slice(0, 3).join(" | "));

  // A reconciliação tem de continuar a fechar com os forçados dentro.
  const contabilizados =
    r.jaConhecidosGlobal + r.excluidosBaixaCobertura + r.excluidosOpacos +
    r.enviadosAoModelo + r.propagados + r.dependentesOrfaos + r.semContexto + r.foraDaJanela;
  check(
    r.residualLido - contabilizados === 0,
    `a reconciliação fecha com os forçados dentro (lidos=${r.residualLido}, contabilizados=${contabilizados})`,
  );

  // ── 5. Sem --canary NADA disto muda ─────────────────────────────────
  const enviadosNormais: number[] = [];
  const respostaNormal = async (produtos: { cnp: number }[]) => {
    enviadosNormais.push(...produtos.map((p) => p.cnp));
    return {
      resultados: produtos.map((p) => ({ ...base, cnp: p.cnp })),
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  };
  const normal = await runKnowledgeEnrichment(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prismaSilveira() as any,
    {
      dryRun: true,
      usarGlobal: false,
      limite: 100,
      classificar: respostaNormal,
      verificar: respostaNormal,
      classificarUtilizacoes: respostaNormal,
    },
  );
  check(
    normal.enviadosAoModelo === 0 && enviadosNormais.length === 0,
    "a corrida NORMAL continua a poupar tudo — a forçagem não vazou para fora do canary",
    `enviados=${normal.enviadosAoModelo}`,
  );
  check(
    normal.forcadosNoCanary === 0,
    "…e não conta forçados nenhuns",
  );
  check(
    normal.excluidosBaixaCobertura + normal.excluidosOpacos > 0,
    "…e continua a contá-los como excluídos, que é o que eles são sem canary",
    `baixa=${normal.excluidosBaixaCobertura} opacos=${normal.excluidosOpacos}`,
  );

  // ── 6. O canary sem a flag continua a poder correr (compatibilidade) ─
  const canarySemFlag = await runKnowledgeEnrichment(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prismaSilveira() as any,
    {
      dryRun: true,
      usarGlobal: false,
      canary: QUOTAS_CANARY,
      classificar: respostaNormal,
      verificar: respostaNormal,
      classificarUtilizacoes: respostaNormal,
    },
  );
  check(
    canarySemFlag.enviadosAoModelo === 0,
    "canary SEM a flag mantém o comportamento antigo — a mudança é opt-in",
  );
}

console.log("\n=== tecto de custo corta imediatamente ===");
{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fake: any = {
    $queryRawUnsafe: async (sql: string) => {
          if (ehQueryContexto(sql)) return CONTEXTO;
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

  CONTEXTO = contextoNeutro(Array.from({ length: 60 }, (_, i) => 2_000_001 + i));
  const r = await runKnowledgeEnrichment(fake, {
    dryRun: true,
    // Offline: sem isto o runner tentava alcançar o control plane.
    usarGlobal: false,
    tectoUsd: 0.01,
    // Sequencial de propósito: o que este bloco fixa é a SEMÂNTICA do
    // tecto — que ele corta — e não o comportamento do pool. Com N>1 há
    // lotes já em voo quando o limite cai, e isso é medido no bloco
    // seguinte, onde é a propriedade em teste em vez de ruído.
    concorrencia: 1,
    classificar: caro,
    verificar: caro,
  });

  check(chamadas === 1, `parou à primeira chamada, sem sair a verificação (chamadas=${chamadas})`);
  check(r.cortadoPorTecto, "o corte por tecto fica registado no resumo");
  check(r.residualAnalisado === 60 && r.chamadasProposta === 1, "…e não percorreu os 3 lotes que tinha pela frente");
}

console.log("");
console.log("=== concorrencia: o tecto continua a cortar, com excesso limitado ===");
{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fake: any = {
    $queryRawUnsafe: async (sql: string) => {
      if (ehQueryContexto(sql)) return CONTEXTO;
      if (/from "Classificacao"/i.test(sql)) return [];
      if (/from "Utilizacao"/i.test(sql)) return [];
      return Array.from({ length: 500 }, (_, i) => ({
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
  let emVoo = 0;
  let picoEmVoo = 0;
  const caro = async () => {
    chamadas++;
    emVoo++;
    picoEmVoo = Math.max(picoEmVoo, emVoo);
    // Cede o controlo para que os outros trabalhadores arranquem — sem
    // isto o `await` resolvia já e o pool nunca ficaria com N em voo.
    await new Promise((r) => setTimeout(r, 0));
    emVoo--;
    return {
      resultados: [{ ...base, cnp: 2_000_001 }],
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  };

  const N = 4;
  CONTEXTO = contextoNeutro(Array.from({ length: 500 }, (_, i) => 2_000_001 + i));
  const r = await runKnowledgeEnrichment(fake, {
    dryRun: true,
    usarGlobal: false,
    tectoUsd: 0.01,
    concorrencia: N,
    classificar: caro,
    verificar: caro,
  });

  check(r.cortadoPorTecto, "o tecto corta na mesma com o pool ligado");
  // 500 produtos são 20 lotes. O que interessa é que pare quase logo, e
  // que o excesso seja proporcional a N e não ao tamanho da corrida.
  check(
    r.chamadasProposta <= N,
    `o excesso está limitado a N lotes em voo (propostas=${r.chamadasProposta}, N=${N})`,
  );
  check(picoEmVoo > 1, `houve mesmo paralelismo (pico em voo=${picoEmVoo})`);
  check(picoEmVoo <= N, `…e nunca passou de N (pico=${picoEmVoo}, N=${N})`);
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

console.log("\n=== ke-2.0: a propagacao por familia nao leva a apresentacao do irmao ===");
{
  const runnerSrc = readFileSync(
    new URL("../../lib/catalog/knowledge-enrichment-runner.ts", import.meta.url),
    "utf8",
  );
  // O HALDOL 5 MG herdou a dosagem "1 mg" do irmao de 1 mg na corrida de
  // validacao de 2026-08-21. A causa era `{ ...r, cnp: dep.cnp }`, que
  // espalhava o resultado inteiro do representante — incluindo o que
  // distingue os irmaos uns dos outros.
  check(
    runnerSrc.includes("semApresentacao"),
    "existe um filtro explicito do que nao se propaga",
  );
  check(
    !/escrever\(\s*\{ \.\.\.r, cnp: dep\.cnp \}/.test(runnerSrc),
    "a escrita do dependente ja nao espalha o resultado inteiro do representante",
  );
  check(
    !/gravarCache\(\s*prisma,\s*\{ \.\.\.r, cnp: dep\.cnp, confidence/.test(runnerSrc),
    "…e a cache do dependente tambem nao",
  );
  // dci e codigoATC SAO propriedades da substancia e continuam a
  // propagar: o ATC do haloperidol e N05AD01 em qualquer dosagem.
  const corpo = runnerSrc.slice(runnerSrc.indexOf("const semApresentacao"));
  const decl = corpo.slice(0, corpo.indexOf("});"));
  for (const campo of ["forma", "dosagem", "embalagem"]) {
    check(decl.includes(`${campo}: null`), `${campo} e limpo na propagacao`);
  }
  for (const campo of ["dci", "codigoATC"]) {
    check(!decl.includes(`${campo}: null`), `${campo} continua a propagar (e da substancia)`);
  }
}

console.log("");
console.log("=== fila: tres destinos distintos, e o DESCONHECIDO nao desaparece ===");
{
  const src = readFileSync(
    new URL("../../lib/catalog/knowledge-enrichment-runner.ts", import.meta.url),
    "utf8",
  );

  // O bug que isto fixa: tudo saia como SUCESSO_PARCIAL, o que tornava
  // um produto que o modelo nao reconheceu indistinguivel de um
  // classificado — e portanto incontavel.
  check(
    !src.includes("set estado = 'SUCESSO_PARCIAL'"),
    "a fila ja nao fecha tudo no mesmo estado",
  );
  check(
    src.includes("REVISAO_NECESSARIA"),
    "existe estado terminal para 'respondeu e nao escrevemos'",
  );
  check(
    src.includes("when k.persistido then 'SUCESSO'"),
    "o destino e decidido pelo `persistido` da cache, nao adivinhado",
  );
  check(
    src.includes("'FALHOU'") && src.includes("sem resposta do modelo nesta passagem"),
    "quem foi seleccionado e nao voltou com resposta e marcado FALHOU",
  );

  // Sem contar a tentativa, "retentativas limitadas" nao teria o que
  // limitar: o produto voltava de 15 em 15 minutos para sempre.
  const contagens = src.match(/"numeroTentativas" = f\."numeroTentativas" \+ 1/g) ?? [];
  check(
    contagens.length >= 2,
    `ambos os caminhos de fecho contam a tentativa (encontrados ${contagens.length})`,
  );
}

console.log("");
console.log("=== fila: FALHOU tem tecto e backoff, nao chamadas indefinidas ===");
{
  const filtro = corpoResidual(undefined, true);
  const semFila = corpoResidual(undefined, false);

  check(
    !semFila.includes("EnriquecimentoFila"),
    "sem apenasFila o SQL nao toca na fila (a varredura das 04:00 nao se restringe)",
  );
  check(
    filtro.includes("EnriquecimentoFila"),
    "com apenasFila o residual e restringido a fila",
  );
  check(
    filtro.includes("f.estado = 'PENDENTE'"),
    "PENDENTE entra sempre",
  );
  check(
    filtro.includes(`f."numeroTentativas" < ${MAX_TENTATIVAS_FILA}`),
    `FALHOU so volta abaixo do tecto de ${MAX_TENTATIVAS_FILA} tentativas`,
  );
  check(
    /power\(4, f\."numeroTentativas"\)/.test(filtro),
    "…e so depois do backoff exponencial",
  );
  check(
    !filtro.includes("REVISAO_NECESSARIA"),
    "REVISAO_NECESSARIA e TERMINAL — nunca volta a fila (repetir nao muda a resposta)",
  );
  check(
    !filtro.includes("estado in ('PENDENTE', 'FALHOU')"),
    "…e o filtro antigo sem tecto nem backoff desapareceu",
  );
}
