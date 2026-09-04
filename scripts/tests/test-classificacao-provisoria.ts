/**
 * scripts/tests/test-classificacao-provisoria.ts
 *
 * A fronteira desta alteração, em asserções.
 *
 * O que se mudou: o gate ganhou uma segunda porta que escreve
 * classificações deduzidas (`evidenceType = CATEGORIA_PRODUTO`) marcadas
 * como PROVISORIA, quando cinco critérios se verificam em simultâneo. E o
 * REVIEW, que morria num registo de cache, passa a alimentar a fila humana.
 *
 * O risco: uma alteração ao gate que mude, sem querer, o que ele já
 * decidia. São 22 mil produtos classificados a depender do comportamento
 * antigo, e uma regressão aqui não dá erro — dá classificações diferentes,
 * em silêncio, e só se vê num relatório meses depois.
 *
 * Por isso a secção A é a mais importante de todas: prova que o caminho
 * canónico devolve EXACTAMENTE o mesmo que devolvia. As outras provam que
 * o caminho novo faz o que diz.
 *
 * Secções:
 *   A  o comportamento CANÓNICO não muda — nem num caso
 *   B  a segunda porta: quando abre e quando não abre
 *   C  a fronteira da confiança, dos dois lados
 *   D  a restrição clínica
 *   E  a hierarquia de escrita (o SQL, lido)
 *   F  a fila humana: o que entra e o que não entra
 *   G  a regra do CNP catalogável, uma só
 *   H  os brutos: nunca mais se perde uma resposta
 *
 * Corre com:  npm run test:classificacao-provisoria
 */
import { readFileSync } from "node:fs";
import {
  EVIDENCIA_PERMITIDA,
  EVIDENCIA_PROVISORIA,
  LIMIAR_PERSISTENCIA,
  VERSAO_PROVISORIA,
  avaliarGate,
  precisaVerificacao,
  validarResultado,
  type EvidenceType,
  type KnowledgeResult,
} from "../../lib/catalog/knowledge-enrichment";
import { contradicaoForte, ehBalde } from "../../lib/catalog/classificacao-coerencia";
import {
  MIN_CNP_CATALOGAVEL,
  ehCnpCatalogavel,
} from "../../lib/catalog/cnp-catalogavel";
import { propostaAccionavel } from "../../lib/catalog/fila-revisao-classificacao";
import { origemClassificacao } from "../../lib/categoria-resolver";

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) {
    ok++;
    console.log(`  [OK]    ${label}`);
  } else {
    ko++;
    console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`);
  }
};

/** Um resultado do modelo, com o mínimo por omissão. */
function res(p: Partial<KnowledgeResult> = {}): KnowledgeResult {
  return {
    cnp: 5000000,
    productType: null,
    categoria: "DERMOCOSMÉTICA",
    subcategoria: "Rosto",
    forma: null,
    dci: null,
    codigoATC: null,
    dosagem: null,
    embalagem: null,
    utilizacoes: [],
    confidence: 0.9,
    confidenceClinica: 0,
    evidenceType: "CATEGORIA_PRODUTO",
    rationale: "",
    categoriaBruta: "DERMOCOSMÉTICA",
    subcategoriaBruta: "Rosto",
    motivoPar: null,
    alvo: "CLASSIFICACAO",
    ...p,
  };
}

/** Estado do produto na base. Por omissão: por classificar. */
function atual(p: Partial<Parameters<typeof avaliarGate>[1]> = {}) {
  return { categoria: null, subcategoria: null, productType: null, ...p };
}

// ══════════════════════════════════════════════════════════════════════
// A · O COMPORTAMENTO CANÓNICO NÃO MUDA
//
// A porta nova é ADITIVA por construção: só corre depois de o gate
// canónico ter falhado, e só quando a ÚNICA falha é a da evidência. Estas
// asserções são o que impede alguém de a tornar não-aditiva sem dar por
// isso.
// ══════════════════════════════════════════════════════════════════════
console.log("\nA · o caminho canónico intacto");
{
  for (const ev of ["MARCA_CONHECIDA", "SUBSTANCIA_CONHECIDA"] as EvidenceType[]) {
    const g = avaliarGate(res({ evidenceType: ev, confidence: 0.95 }), atual());
    check(
      g.decisao === "APPLY" && g.gravarCategoria && !g.provisorio,
      `${ev} continua a escrever como CANÓNICA`,
      `veio ${g.decisao} provisorio=${g.provisorio}`,
    );
  }

  // O caso que mais facilmente se partia: um produto SEM subcategoria com
  // uma proposta "Outros X". Hoje isso é APPLY canónico — o SKIP de
  // "proposta também é fallback" só dispara quando JÁ existe subcategoria.
  // Tornar `especifica` obrigatória para todos mudava isto em silêncio.
  const g = avaliarGate(
    res({ evidenceType: "MARCA_CONHECIDA", subcategoria: "Outros Dermocosmética", confidence: 0.95 }),
    atual(),
  );
  check(
    g.decisao === "APPLY" && !g.provisorio,
    "proposta 'Outros X' sobre produto sem subcategoria continua APPLY canónico",
    `veio ${g.decisao}`,
  );

  // Uma subcategoria específica já existente continua intocável.
  //
  // O alvo deriva do ESTADO do produto, não da pergunta: com subcategoria
  // específica, `alvoParaProduto` devolve UTILIZACOES (ou FORMA), e o
  // ramo da classificação nem chega a correr. Por isso a asserção é sobre
  // o que interessa — a classificação não é tocada — e não sobre um valor
  // de `decisao` que depende de qual dos dois ramos apanhou o caso.
  const s = avaliarGate(
    res({ evidenceType: "MARCA_CONHECIDA" }),
    atual({ categoria: "MEDICAMENTOS", subcategoria: "Diabetes" }),
  );
  check(
    !s.gravarCategoria && !s.provisorio,
    "subcategoria específica existente continua intocável",
    `decisao=${s.decisao} gravarCategoria=${s.gravarCategoria}`,
  );
  check(s.alvo !== "CLASSIFICACAO", "…e o alvo nem sequer é CLASSIFICACAO", `alvo=${s.alvo}`);

  // DESCONHECIDO nunca escreve, nem pela porta nova.
  const d = avaliarGate(res({ evidenceType: "DESCONHECIDO", confidence: 0.99 }), atual());
  check(d.decisao !== "APPLY", "DESCONHECIDO nunca escreve");

  check(
    !EVIDENCIA_PERMITIDA.has("CATEGORIA_PRODUTO"),
    "EVIDENCIA_PERMITIDA continua a NÃO incluir CATEGORIA_PRODUTO",
  );
  check(
    EVIDENCIA_PROVISORIA.has("CATEGORIA_PRODUTO") && EVIDENCIA_PROVISORIA.size === 1,
    "EVIDENCIA_PROVISORIA é exactamente CATEGORIA_PRODUTO",
  );
}

// ══════════════════════════════════════════════════════════════════════
// B · A SEGUNDA PORTA
// ══════════════════════════════════════════════════════════════════════
console.log("\nB · a porta provisória");
{
  const g = avaliarGate(res({ confidence: 0.9 }), atual());
  check(
    g.decisao === "APPLY" && g.provisorio && g.gravarCategoria,
    "CATEGORIA_PRODUTO segura → APPLY provisório",
    `veio ${g.decisao} provisorio=${g.provisorio} motivo="${g.motivo}"`,
  );

  // O productType NÃO é escrito por dedução: alimentaria o classificador e
  // a própria `contradicaoForte`, fechando um circuito sobre si próprio.
  check(!g.gravarProductType, "…e NUNCA escreve productType");
  check(g.utilizacoes.length === 0, "…nem utilizações");

  // ── cada critério, falhado sozinho ────────────────────────────────
  const semEspecifica = avaliarGate(res({ subcategoria: "Outros Dermocosmética" }), atual());
  check(
    semEspecifica.decisao === "REVIEW",
    "subcategoria 'Outros X' → REVIEW, não provisória",
    `veio ${semEspecifica.decisao}`,
  );

  const contradiz = avaliarGate(
    res({ categoria: "MEDICAMENTOS", subcategoria: "Diabetes" }),
    atual({ productType: "SUPLEMENTO" }),
  );
  check(
    contradiz.decisao === "REVIEW",
    "SUPLEMENTO proposto para MEDICAMENTOS → REVIEW (contradição forte)",
    `veio ${contradiz.decisao}`,
  );

  const forasDoVocabulario = avaliarGate(res({ categoria: null, subcategoria: null }), atual());
  check(forasDoVocabulario.decisao === "REVIEW", "par inválido → REVIEW, nunca provisória");

  // Mesma razão da secção A: com específica na base o alvo já não é
  // CLASSIFICACAO. O que a porta provisória tem de garantir é que não
  // escreve — e é isso que se afirma.
  const comConflito = avaliarGate(
    res(),
    atual({ categoria: "MEDICAMENTOS", subcategoria: "Diabetes" }),
  );
  check(
    !comConflito.gravarCategoria && !comConflito.provisorio,
    "conflito com específica existente → não escreve classificação",
    `decisao=${comConflito.decisao} gravarCategoria=${comConflito.gravarCategoria}`,
  );

  // Substitui um balde — é para isso que serve.
  const sobreBalde = avaliarGate(
    res(),
    atual({ categoria: "DERMOCOSMÉTICA", subcategoria: "Outros Dermocosmética" }),
  );
  check(
    sobreBalde.decisao === "APPLY" && sobreBalde.provisorio,
    "provisória substitui um 'Outros X'",
    `veio ${sobreBalde.decisao}`,
  );

  // Uma fronteira comercial NÃO é contradição.
  check(
    !contradicaoForte("DERMOCOSMETICA", "HIGIENE E CUIDADO PESSOAL"),
    "dermocosmética vs higiene não é contradição — é arrumação",
  );
  check(
    contradicaoForte("SUPLEMENTO", "MEDICAMENTOS"),
    "suplemento vs medicamento É contradição — é estatuto regulamentar",
  );
  check(!contradicaoForte(null, "MEDICAMENTOS"), "sem productType não há contradição a medir");
}

// ══════════════════════════════════════════════════════════════════════
// C · A FRONTEIRA DA CONFIANÇA
// ══════════════════════════════════════════════════════════════════════
console.log("\nC · o limiar, dos dois lados");
{
  const abaixo = avaliarGate(res({ confidence: 0.8499 }), atual());
  check(abaixo.decisao === "REVIEW", "0,8499 não passa");
  const igual = avaliarGate(res({ confidence: 0.85 }), atual());
  check(
    igual.decisao === "APPLY" && igual.provisorio,
    "0,85 passa",
    `veio ${igual.decisao} motivo="${igual.motivo}"`,
  );
  check(LIMIAR_PERSISTENCIA === 0.85, "o limiar continua a ser 0,85");
}

// ══════════════════════════════════════════════════════════════════════
// D · A RESTRIÇÃO CLÍNICA
//
// A cache não guarda se o verificador concordou. O reprocessamento passa
// `concorda: false` — que é a leitura honesta de "não sei" — e o gate tem
// de transformar isso num REVIEW, nunca numa escrita.
// ══════════════════════════════════════════════════════════════════════
console.log("\nD · clínica sem verificação reconstruível");
{
  const med = res({ categoria: "MEDICAMENTOS", subcategoria: "Diabetes", confidence: 0.97 });
  check(precisaVerificacao(med), "MEDICAMENTOS exige segunda passagem");

  const g = avaliarGate(med, atual(), { concorda: false, aplicavel: true });
  check(
    g.decisao === "REVIEW" && !g.provisorio,
    "verificação não reconstruível → REVIEW, nunca provisória",
    `veio ${g.decisao} provisorio=${g.provisorio}`,
  );

  // E o mesmo caso COM verificação a concordar passa — para provar que é
  // mesmo a verificação a decidir, e não outra coisa qualquer.
  const g2 = avaliarGate(med, atual(), { concorda: true, aplicavel: true });
  check(
    g2.decisao === "APPLY" && g2.provisorio,
    "…e passa quando a verificação concorda",
    `veio ${g2.decisao}`,
  );

  const derm = res({ categoria: "DERMOCOSMÉTICA", subcategoria: "Rosto" });
  check(!precisaVerificacao(derm), "dermocosmética não exige segunda passagem");
}

// ══════════════════════════════════════════════════════════════════════
// E · A HIERARQUIA DE ESCRITA
//
// Lida do SQL. Não há aqui base de dados, e um teste de integração custava
// um Postgres a cada corrida — mas o WHERE é o sítio onde a hierarquia
// vive, e apagá-lo por acidente não pode passar despercebido.
// ══════════════════════════════════════════════════════════════════════
console.log("\nE · a hierarquia, no SQL que a implementa");
{
  const sql = readFileSync("lib/catalog/escrita-classificacao.ts", "utf8");

  check(
    sql.includes('a.manual = false'),
    "MANUAL é soberano — o UPDATE exclui validadoManualmente",
  );
  check(
    sql.includes('a."n2AntesId" is null'),
    "PROVISORIA pode escrever onde não há nível 2",
  );
  check(
    sql.includes(`a."n2Antes" ilike 'Outros %'`),
    "…e sobre um 'Outros X'",
  );
  check(
    sql.includes(`a."estadoAntes" = 'PROVISORIA' and $4 = 'CANONICA'`),
    "CANONICA pode substituir PROVISORIA — e só nessa direcção",
  );
  // A ausência é a asserção: não pode existir um ramo que deixe uma
  // provisória sobrepor-se a outra, senão a classificação final passa a
  // depender da ordem dos lotes.
  check(
    !sql.includes(`$4 = 'PROVISORIA'`),
    "PROVISORIA não substitui PROVISORIA — não há ramo que o permita",
  );
  check(
    sql.includes("with antes as") && sql.includes("returning p.cnp"),
    "o estado anterior é lido na MESMA instrução que escreve (journal fiel)",
  );

  const rollback = sql.slice(sql.indexOf("reverterLinhaJournal"));
  check(
    rollback.includes('is not distinct from $8') && rollback.includes('p."classificacaoEstado"   = $9'),
    "o rollback só repõe se o produto ainda estiver no estado que esta escrita deixou",
  );
  check(
    rollback.includes('"classificacaoNivel2Id"  = $3'),
    "…e repõe o valor ANTERIOR, não null",
  );
}

// ══════════════════════════════════════════════════════════════════════
// F · A FILA HUMANA
// ══════════════════════════════════════════════════════════════════════
console.log("\nF · o que chega a uma pessoa");
{
  check(
    propostaAccionavel({ categoria: "DERMOCOSMÉTICA", subcategoria: "Rosto", evidenceType: "CATEGORIA_PRODUTO" }),
    "par válido entra na fila",
  );
  check(
    !propostaAccionavel({ categoria: null, subcategoria: null, evidenceType: "DESCONHECIDO" }),
    "DESCONHECIDO não entra na fila humana",
  );
  check(
    !propostaAccionavel({ categoria: "DERMOCOSMÉTICA", subcategoria: null, evidenceType: "CATEGORIA_PRODUTO" }),
    "par incompleto não entra — não há nada que uma pessoa possa decidir",
  );

  const fila = readFileSync("lib/catalog/fila-revisao-classificacao.ts", "utf8");
  check(
    fila.includes('estado: "PENDENTE"') && fila.includes("findFirst"),
    "deduplicado: no máximo uma entrada PENDENTE por produto",
  );
  check(
    fila.includes('prioridade = (await temMovimento') || fila.includes("temMovimento(prisma, produto.id)"),
    "a prioridade segue o movimento do produto, não a confiança do modelo",
  );

  const runner = readFileSync("lib/catalog/knowledge-enrichment-runner.ts", "utf8");
  check(
    runner.includes("enfileirarRevisaoClassificacao"),
    "o runner liga mesmo o REVIEW à fila",
  );
  // A ligação tem de estar ABAIXO da fronteira do dry-run: um dry-run que
  // escrevesse na fila deixava de ser um dry-run.
  const iFronteira = runner.indexOf("FRONTEIRA DO DRY-RUN");
  const iFila = runner.indexOf("enfileirarRevisaoClassificacao(prisma");
  check(
    iFronteira > 0 && iFila > iFronteira,
    "…e a chamada está ABAIXO da fronteira do dry-run",
  );
}

// ══════════════════════════════════════════════════════════════════════
// G · A REGRA DO CNP, UMA SÓ
// ══════════════════════════════════════════════════════════════════════
console.log("\nG · CNP catalogável");
{
  check(MIN_CNP_CATALOGAVEL === 2_000_000, "a fronteira é 2 000 000");
  // O caso que estava a divergir: `>=` num caminho e `>` noutro.
  check(
    !ehCnpCatalogavel(2_000_000),
    "CNP exactamente 2 000 000 é INTERNO — a intenção documentada",
  );
  check(ehCnpCatalogavel(2_000_001), "2 000 001 é catalogável");
  check(!ehCnpCatalogavel(null) && !ehCnpCatalogavel(undefined), "sem CNP não é catalogável");

  // Uma única definição do valor em todo o repositório.
  for (const f of [
    "lib/catalog/knowledge-enrichment-runner.ts",
    "lib/catalog-enrichment.ts",
    "scripts/catalog-master/backfill-utilizacoes.ts",
    "scripts/catalog-master/catalog-builder.ts",
  ]) {
    const t = readFileSync(f, "utf8");
    check(
      !/=\s*2_000_000\s*;/.test(t),
      `${f} já não tem cópia local da constante`,
    );
  }

  const runner = readFileSync("lib/catalog/knowledge-enrichment-runner.ts", "utf8");
  check(!runner.includes("cnp >= $1"), "o runner já não usa >= na fronteira do CNP");
  check(runner.includes("cnp > $1"), "…usa > , como o resto do pipeline");
}

// ══════════════════════════════════════════════════════════════════════
// H · NUNCA MAIS SE PERDE UMA RESPOSTA
// ══════════════════════════════════════════════════════════════════════
console.log("\nH · os brutos sobrevivem à validação");
{
  const cnps = new Set([5000000]);

  // Par que a taxonomia NÃO tem: os campos validados ficam null — como
  // sempre — mas o bruto e a razão sobrevivem.
  const invalido = validarResultado(
    {
      cnp: 5000000,
      categoria: "MEDICAMENTOS",
      subcategoria: "Antibióticos",
      confidence: 0.9,
      evidenceType: "CATEGORIA_PRODUTO",
    },
    cnps,
  );
  check(invalido !== null, "resultado com par inválido continua a ser devolvido");
  check(invalido?.categoria === null, "…com categoria validada a null, como antes");
  check(
    invalido?.categoriaBruta === "MEDICAMENTOS" && invalido?.subcategoriaBruta === "Antibióticos",
    "…mas o par BRUTO sobrevive",
    `veio ${invalido?.categoriaBruta} > ${invalido?.subcategoriaBruta}`,
  );
  check(
    !!invalido?.motivoPar && invalido.motivoPar.includes("fora da taxonomia"),
    "…e a razão fica escrita",
    `motivoPar="${invalido?.motivoPar}"`,
  );

  const incompleto = validarResultado(
    { cnp: 5000000, categoria: "MEDICAMENTOS", confidence: 0.9, evidenceType: "CATEGORIA_PRODUTO" },
    cnps,
  );
  check(
    !!incompleto?.motivoPar && incompleto.motivoPar.includes("incompleto"),
    "par incompleto tem motivo próprio",
    `motivoPar="${incompleto?.motivoPar}"`,
  );

  const semProposta = validarResultado(
    { cnp: 5000000, confidence: 0.4, evidenceType: "DESCONHECIDO" },
    cnps,
  );
  check(
    semProposta?.motivoPar === null && semProposta?.categoriaBruta === null,
    "sem proposta não há motivo a inventar — null é null",
  );

  // O balde, uma definição só.
  check(ehBalde("Outros Medicamentos") && ehBalde("outros x"), "ehBalde apanha 'Outros …'");
  check(!ehBalde("Outrora") && !ehBalde(null), "…e não apanha o que só começa igual");
}

// ══════════════════════════════════════════════════════════════════════
// I · A PROVENIÊNCIA APRESENTADA
// ══════════════════════════════════════════════════════════════════════
console.log("\nI · MANUAL / CANONICA / PROVISORIA / AUSENTE");
{
  check(
    origemClassificacao({ validadoManualmente: true, classificacaoEstado: "PROVISORIA" }) === "MANUAL",
    "MANUAL ganha a tudo — mesmo sobre uma provisória escrita depois",
  );
  check(
    origemClassificacao({ validadoManualmente: false, classificacaoEstado: "CANONICA" }) === "CANONICA",
    "CANONICA quando é canónica",
  );
  check(
    origemClassificacao({ validadoManualmente: false, classificacaoEstado: "PROVISORIA" }) === "PROVISORIA",
    "PROVISORIA quando é provisória",
  );
  check(
    origemClassificacao({}) === "AUSENTE",
    "sem informação → AUSENTE, e não um optimismo por omissão",
  );
  check(VERSAO_PROVISORIA === "ke-2.1", "as provisórias carimbam ke-2.1");
}

// ══════════════════════════════════════════════════════════════════════
console.log(`\n${ok} ok, ${ko} falhas`);
process.exit(ko === 0 ? 0 : 1);
