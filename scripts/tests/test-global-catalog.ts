/**
 * scripts/tests/test-global-catalog.ts
 *
 * Fixa as regras do catálogo global por CNP.
 *
 * O RISCO QUE ESTAS ASSERÇÕES CONTÊM
 *
 * Até agora um erro de classificação ficava dentro de um tenant. Com uma
 * camada global, um erro pode chegar a todas as farmácias de uma vez. É
 * uma mudança real no perfil de risco, e o que a torna aceitável são as
 * regras de projecção: nunca sobrepor uma classificação específica, nunca
 * tocar no que foi validado à mão, e mandar as divergências para revisão
 * humana em vez de as resolver sozinho.
 *
 * Se alguém relaxar `avaliarProjeccao`, é aqui que parte.
 *
 * Sem base de dados e sem rede.
 *
 * Uso: npx tsx scripts/tests/test-global-catalog.ts
 */
import {
  FATOR_PROJECCAO,
  ORIGEM_RANK,
  aprovacaoValida,
  avaliarProjeccao,
  avaliarPromocao,
  ehEspecifica,
  estaDesactualizado,
  maisAutoritaria,
  origemDaClassificacao,
  origemDaPromocao,
  origemDaUtilizacao,
  precisaAprovacaoHumana,
  registoPromocao,
  type AprovacaoHumana,
  type ConhecimentoCandidato,
  type ConhecimentoGlobal,
  type EstadoLocal,
  type OrigemGlobal,
  type UtilizacaoCandidata,
} from "../../lib/catalog/global-catalog";

let pass = 0;
let fail = 0;
const ok = (l: string) => { pass++; console.log(`  [OK]    ${l}`); };
const bad = (l: string, d?: string) => { fail++; console.log(`  [FALHA] ${l}${d ? `\n            ${d}` : ""}`); };
const check = (c: boolean, l: string, d?: string) => (c ? ok(l) : bad(l, d));

const util = (over: Partial<UtilizacaoCandidata> = {}): UtilizacaoCandidata => ({
  slug: "diabetes",
  confidence: 0.95,
  origem: "MODELO",
  fonteOriginal: "MODELO",
  motivo: "decisão do modelo",
  ...over,
});

const candidato = (over: Partial<ConhecimentoCandidato> = {}): ConhecimentoCandidato => ({
  cnp: 5678901,
  designacaoReferencia: "Ozempic 0.25 Mg Sol. Injetável",
  productType: "MEDICAMENTO",
  categoria: "MEDICAMENTOS",
  subcategoria: "Diabetes",
  utilizacoes: [util()],
  confidence: 0.95,
  evidenceType: "MARCA_CONHECIDA",
  origem: "MODELO",
  motivoOrigem: "decisão do modelo sobre este cnp",
  fonteOriginal: "MODEL_INFERRED",
  versaoRegras: "ke-1.1",
  verificado: true,
  tenantOrigem: "tenant-a",
  ...over,
});

/** Só a parte da classificação — é o que a maioria destes testes fixa. */
const classifica = (
  c: ConhecimentoCandidato,
  g: ConhecimentoGlobal | null,
  ctx?: Parameters<typeof avaliarPromocao>[2],
) => avaliarPromocao(c, g, ctx).classificacao;

const global = (over: Partial<ConhecimentoGlobal> = {}): ConhecimentoGlobal => ({
  cnp: 5678901,
  categoria: "MEDICAMENTOS",
  subcategoria: "Diabetes",
  productType: "MEDICAMENTO",
  confidence: 0.95,
  origem: "MODELO",
  versaoRegras: "ke-1.1",
  verificado: true,
  utilizacoes: [{ slug: "diabetes", confidence: 0.95, origem: "MODELO" }],
  ...over,
});

/** Uma aprovação humana completa: quem responde, e porquê. */
const APROVACAO: AprovacaoHumana = {
  aprovador: "Bruno Reis",
  motivo: "revisão do catálogo de diabetes, confirmada com o INFARMED",
};

const local = (over: Partial<EstadoLocal> = {}): EstadoLocal => ({
  cnp: 5678901,
  validadoManualmente: false,
  categoria: null,
  subcategoria: null,
  productType: null,
  utilizacoes: [],
  ...over,
});

console.log("=== ordem de autoridade ===");
{
  const ordem: OrigemGlobal[] = ["HUMANO", "REGULATORY", "DETERMINISTICA", "MODELO", "PROPAGADO"];
  for (let i = 1; i < ordem.length; i++) {
    check(
      ORIGEM_RANK[ordem[i - 1]!] < ORIGEM_RANK[ordem[i]!],
      `${ordem[i - 1]} é mais autoritária que ${ordem[i]}`,
    );
  }
  check(maisAutoritaria("MODELO", "HUMANO") === "HUMANO", "maisAutoritaria escolhe o humano");
  check(maisAutoritaria("PROPAGADO", "MODELO") === "MODELO", "…e o directo sobre o propagado");
  // A mesma ordem do SOURCE_TIER_RANK: INTERNAL_INFERRED acima de
  // MODEL_INFERRED. Uma regra é auditável; o modelo não é.
  check(
    ORIGEM_RANK.DETERMINISTICA < ORIGEM_RANK.MODELO,
    "uma regra determinística vale mais do que uma inferência do modelo",
  );
}

console.log("\n=== 'Outros <X>' não é conhecimento ===");
{
  check(!ehEspecifica("Outros Medicamentos"), "'Outros Medicamentos' não é específica");
  check(!ehEspecifica(null), "null não é específica");
  check(ehEspecifica("Diabetes"), "'Diabetes' é específica");
  const d = classifica(candidato({ subcategoria: "Outros Medicamentos" }), null);
  check(!d.promover, "um fallback NÃO sobe como classificação específica");
}

console.log("\n=== promoção: entre dois conhecimentos, fica o mais autoritário ===");
{
  check(classifica(candidato(), null).promover, "cnp desconhecido é promovido");
}
{
  // Com aprovação — sem ela nem se chega à regra de autoridade, e é
  // isso que a secção "a validação manual local não sobe sozinha" fixa.
  const d = classifica(
    candidato({ origem: "HUMANO", confidence: 0.5 }),
    global({ origem: "MODELO", confidence: 1 }),
    { aprovacao: APROVACAO },
  );
  check(d.promover, "HUMANO aprovado com confiança 0.5 supera MODELO com confiança 1.0");
  check(d.motivo.includes("autoritária"), "…e o motivo diz porquê", d.motivo);
}
{
  const d = classifica(candidato({ origem: "MODELO", confidence: 1 }), global({ origem: "HUMANO", confidence: 0.5 }));
  check(!d.promover, "o inverso NÃO acontece: um modelo não desfaz uma validação humana");
}
{
  const d = classifica(candidato({ origem: "PROPAGADO" }), global({ origem: "MODELO" }));
  check(!d.promover, "PROPAGADO não substitui MODELO");
}
{
  const d = classifica(candidato({ origem: "MODELO" }), global({ origem: "DETERMINISTICA" }));
  check(!d.promover, "o modelo não desfaz uma regra determinística");
  const inverso = classifica(candidato({ origem: "DETERMINISTICA" }), global({ origem: "MODELO" }));
  check(inverso.promover, "…e a regra determinística desfaz o modelo");
}
{
  const d = classifica(candidato({ confidence: 0.99 }), global({ confidence: 0.90 }));
  check(d.promover, "mesma origem, confiança superior → promove");
}
{
  const d = classifica(candidato({ confidence: 0.90 }), global({ confidence: 0.90 }));
  check(!d.promover, "empate mantém o que lá está — reprocessar não gera escrita");
}
{
  // Idempotência: promover duas vezes o mesmo dá o mesmo resultado.
  const c = candidato();
  const g = global({ confidence: c.confidence, origem: c.origem! });
  const d = avaliarPromocao(c, g);
  check(!d.classificacao.promover, "promover o que já foi promovido é no-op");
  check(d.utilizacoes.promover.length === 0, "…e as utilizações também não voltam a subir");
  check(!d.promover, "…portanto o produto não gera escrita nenhuma");
}

/** Um produto inteiramente humano: classificação validada e etiqueta à mão. */
const humano = (over: Partial<ConhecimentoCandidato> = {}): ConhecimentoCandidato =>
  candidato({
    origem: "HUMANO",
    utilizacoes: [util({ origem: "HUMANO", fonteOriginal: "MANUAL", confidence: 1 })],
    ...over,
  });

console.log("\n=== a validação manual local NÃO sobe sozinha ===");
{
  // A regra central desta secção. Uma pessoa que corrige um produto ao
  // balcão está a dizer «nesta farmácia isto é assim» — não «isto é
  // assim em Portugal». Tratar as duas frases como iguais tornaria cada
  // correcção local em verdade para todas as farmácias.
  const d = avaliarPromocao(humano(), null);
  check(!d.promover, "HUMANO sem aprovação NÃO promove NADA, nem num cnp desconhecido");
  check(!!d.aguardaAprovacao, "…e fica marcado como à espera, não como reprovado");
  check(d.motivo.includes("promoção humana explícita"), "…com o motivo a dizer o que falta", d.motivo);
  check(
    d.utilizacoes.promover.length === 0 && d.utilizacoes.recusadas[0]?.aguardaAprovacao === true,
    "…e a etiqueta posta à mão também espera",
  );
}
{
  check(precisaAprovacaoHumana("HUMANO"), "HUMANO exige aprovação");
  for (const o of ["REGULATORY", "DETERMINISTICA", "MODELO", "PROPAGADO"] as OrigemGlobal[]) {
    check(!precisaAprovacaoHumana(o), `${o} continua a subir sozinho`);
    const d = classifica(candidato({ origem: o }), null);
    check(d.promover && !d.aguardaAprovacao, `…e ${o} é mesmo promovido sem aprovação nenhuma`);
  }
}
{
  // Independência: a classificação validada à mão espera, mas a etiqueta
  // que veio de uma regra sobe. Antes, a parte humana contaminava tudo.
  const misto = candidato({ origem: "HUMANO", utilizacoes: [util({ origem: "DETERMINISTICA" })] });
  const d = avaliarPromocao(misto, null);
  check(!d.classificacao.promover, "classificação humana espera aprovação");
  check(d.utilizacoes.promover.length === 1, "…e a utilização determinística sobe na mesma");
  check(d.promover, "…portanto o produto promove alguma coisa");
}

console.log("\n=== a promoção humana explícita funciona ===");
{
  const d = avaliarPromocao(humano(), null, { aprovacao: APROVACAO });
  check(d.classificacao.promover, "com aprovador E motivo, o conhecimento humano sobe");
  check(!d.aguardaAprovacao, "…e deixa de aparecer como pendente");
  check(d.utilizacoes.promover.length === 1, "…e a etiqueta manual sobe com ele");
}
{
  // Uma aprovação sem motivo é um carimbo, e um carimbo não se audita.
  const meias: Array<[string, AprovacaoHumana]> = [
    ["sem aprovador", { aprovador: "", motivo: "porque sim" }],
    ["sem motivo", { aprovador: "Bruno Reis", motivo: "" }],
    ["só espaços", { aprovador: "   ", motivo: "   " }],
  ];
  for (const [nome, a] of meias) {
    check(!aprovacaoValida(a), `aprovação ${nome} é inválida`);
    const d = avaliarPromocao(humano(), null, { aprovacao: a });
    check(!d.promover && !!d.aguardaAprovacao, `…e não promove nada (${nome})`);
  }
}
{
  // A aprovação DESBLOQUEIA a origem; não dispensa o resto das regras.
  const fallback = humano({ subcategoria: "Outros Medicamentos" });
  check(
    !classifica(fallback, null, { aprovacao: APROVACAO }).promover,
    "uma aprovação não faz de um fallback conhecimento",
  );
  const jaMelhor = classifica(
    humano({ confidence: 0.5 }),
    global({ origem: "HUMANO", confidence: 0.9 }),
    { aprovacao: APROVACAO },
  );
  check(!jaMelhor.promover, "…nem desfaz o que no global já tem mais autoridade");
}

console.log("\n=== global HUMANO continua a ser autoridade máxima ===");
{
  const g = global({ origem: "HUMANO", confidence: 0.5 });
  for (const o of ["REGULATORY", "DETERMINISTICA", "MODELO", "PROPAGADO"] as OrigemGlobal[]) {
    check(
      !classifica(candidato({ origem: o, confidence: 1 }), g).promover,
      `${o} com confiança 1.0 não desfaz um HUMANO global com 0.5`,
    );
  }
  check(
    classifica(humano({ confidence: 0.9 }), g, { aprovacao: APROVACAO }).promover,
    "só outro HUMANO aprovado, com mais confiança, o substitui",
  );
  // E o mesmo por utilização: cada slug tem a sua própria autoridade.
  const comUtilHumana = global({ utilizacoes: [{ slug: "diabetes", confidence: 0.5, origem: "HUMANO" }] });
  const d = avaliarPromocao(candidato({ utilizacoes: [util({ origem: "DETERMINISTICA", confidence: 1 })] }), comUtilHumana);
  check(d.utilizacoes.promover.length === 0, "uma regra não desfaz uma utilização humana global");
}

console.log("\n=== idempotência da promoção humana ===");
{
  // Correr o comando duas vezes com a mesma aprovação: a segunda não
  // escreve. Sem isto, cada re-corrida enchia o rasto de auditoria de
  // linhas que não registam decisão nenhuma.
  const c = humano();
  const primeira = avaliarPromocao(c, null, { aprovacao: APROVACAO });
  const depois = global({
    origem: "HUMANO",
    confidence: c.confidence,
    utilizacoes: [{ slug: "diabetes", confidence: 1, origem: "HUMANO" }],
  });
  const segunda = avaliarPromocao(c, depois, { aprovacao: APROVACAO });
  check(primeira.promover && !segunda.promover, "promover duas vezes o mesmo é no-op à segunda");
  check(segunda.classificacao.motivo.includes("igual ou melhor"), "…e diz porquê", segunda.classificacao.motivo);
  check(segunda.utilizacoes.promover.length === 0, "…e nem as utilizações voltam a subir");
  const terceira = avaliarPromocao(c, depois, { aprovacao: { aprovador: "Outra Pessoa", motivo: "outro motivo" } });
  check(!terceira.promover, "…e outro aprovador não reabre o que já está decidido");
}

console.log("\n=== proveniência: nada é carimbado por conveniência ===");
{
  // O defeito real: 15.260 candidatos, TODOS marcados MODELO. A causa
  // foi um `else` final que carimbava MODELO em tudo o que não
  // reconhecia — e o que não reconhecia era quase tudo, porque a
  // classificação N1/N2 do fill-rules não deixa proveniência própria.
  const r = origemDaClassificacao({ validadoManualmente: false, cacheOrigem: null });
  check(r.origem === "DETERMINISTICA", "classificação sem cache é DETERMINISTICA, não MODELO", r.origem ?? "null");
  check(
    origemDaClassificacao({ validadoManualmente: true, cacheOrigem: null }).origem === "HUMANO",
    "validadoManualmente é HUMANO",
  );
  check(
    origemDaClassificacao({ validadoManualmente: false, cacheOrigem: "CLAUDE" }).origem === "MODELO",
    "só o que o modelo decidiu é MODELO",
  );
  check(
    origemDaClassificacao({ validadoManualmente: false, cacheOrigem: "PROPAGADO" }).origem === "PROPAGADO",
    "…e o que foi propagado é PROPAGADO",
  );
  const desconhecida = origemDaClassificacao({ validadoManualmente: false, cacheOrigem: "XPTO" });
  check(desconhecida.origem === null, "uma origem de cache por mapear NÃO é promovida");
  check(desconhecida.motivo.includes("XPTO"), "…e o relatório diz qual era", desconhecida.motivo);
}
{
  // O ciclo de lavagem: o global escreve no tenant, o tenant devolve-o
  // ao global como se fosse regra local — e com MAIS autoridade que o
  // modelo que o produziu.
  const eco = origemDaClassificacao({ validadoManualmente: false, cacheOrigem: "CATALOGO_GLOBAL" });
  check(eco.origem === null, "o que veio do global NÃO volta a subir ao global");
  check(eco.motivo.includes("catálogo global"), "…e diz porquê", eco.motivo);
  const c = candidato({ origem: eco.origem, motivoOrigem: eco.motivo });
  check(!classifica(c, null).promover, "…nem sequer num cnp que o global desconheça");
}
{
  const casos: Array<[string | null, OrigemGlobal | null]> = [
    ["MANUAL", "HUMANO"],
    ["REGRA", "DETERMINISTICA"],
    ["MODELO", "MODELO"],
    ["MODELO_PROPAGADO", "PROPAGADO"],
    ["CATALOGO_GLOBAL", null],
    ["ERP", null],
    [null, null],
  ];
  for (const [fonte, esperado] of casos) {
    const m = origemDaUtilizacao(fonte);
    check(m.origem === esperado, `utilização de fonte ${fonte ?? "(nula)"} → ${esperado ?? "não sobe"}`, m.motivo);
  }
}
{
  const c = candidato({ utilizacoes: [util({ origem: null, fonteOriginal: "ERP", motivo: "sem mapeamento seguro" })] });
  const d = avaliarPromocao(c, null);
  check(d.utilizacoes.promover.length === 0, "uma utilização sem mapeamento seguro não sobe");
  check(d.utilizacoes.recusadas[0]?.motivo.includes("mapeamento"), "…e o motivo fica no relatório");
}

console.log("\n=== utilizações sobem sem classificação específica ===");
{
  // Os 832 "recusados por sem classificação específica" do dry-run real
  // tinham utilizações válidas, e eram deitadas fora inteiras.
  const semN2 = candidato({ categoria: null, subcategoria: null, utilizacoes: [util({ origem: "DETERMINISTICA" })] });
  const d = avaliarPromocao(semN2, null);
  check(!d.classificacao.promover, "sem N2 específica a classificação não sobe");
  check(d.utilizacoes.promover.length === 1, "…mas a utilização sobe");
  check(d.promover, "…e o produto conta como promovido");
}
{
  const fallback = candidato({ subcategoria: "Outros Medicamentos", utilizacoes: [util({ origem: "DETERMINISTICA" })] });
  const d = avaliarPromocao(fallback, null);
  check(!d.classificacao.promover, "um 'Outros <X>' continua a não subir como classificação");
  check(d.utilizacoes.promover.length === 1, "…e as utilizações dele sobem à mesma");
}
{
  // A recíproca: uma classificação que sobe não arrasta utilizações que
  // o global já tem melhores.
  const g = global({
    categoria: "COSMÉTICA", subcategoria: "Solares", origem: "PROPAGADO",
    utilizacoes: [{ slug: "diabetes", confidence: 1, origem: "HUMANO" }],
  });
  const d = avaliarPromocao(candidato({ origem: "DETERMINISTICA" }), g);
  check(d.classificacao.promover, "a classificação mais autoritária sobe");
  check(d.utilizacoes.promover.length === 0, "…e mesmo assim não mexe na utilização humana global");
}

console.log("\n=== rasto de auditoria: quem, onde, quando, porquê ===");
{
  const c = humano({ tenantOrigem: "tenant-b" });
  const d = avaliarPromocao(c, null, { aprovacao: APROVACAO });
  const reg = registoPromocao(c, d, { actor: APROVACAO.aprovador, aprovacao: APROVACAO })!;
  check(!!reg, "uma promoção que acontece gera registo");
  check(reg.aprovador === "Bruno Reis", "o registo guarda QUEM aprovou");
  check(reg.tenantOrigem === "tenant-b", "…de ONDE veio o conhecimento");
  check(reg.motivo === APROVACAO.motivo, "…e PORQUÊ — o motivo da pessoa, não o da regra");
  check(reg.cnp === c.cnp && reg.origem === "HUMANO", "…sobre que produto e com que origem");
  check(reg.versaoRegras === c.versaoRegras, "…e com que versão de regras");
}
{
  // As promoções automáticas também deixam rasto: o actor é o processo.
  const c = candidato({ origem: "MODELO" });
  const d = avaliarPromocao(c, null);
  const reg = registoPromocao(c, d, { actor: "catalog:knowledge-enrich" })!;
  check(reg.aprovador === null, "promoção automática não inventa um aprovador");
  check(reg.actor === "catalog:knowledge-enrich", "…mas identifica o processo que a fez");
  check(reg.motivo === d.motivo, "…e guarda o motivo da decisão automática");
  check(reg.origem === "MODELO", "…e a origem é a da classificação que subiu");
}
{
  // Quando só sobem utilizações, a origem registada é a delas — não a de
  // uma classificação que ficou para trás.
  const c = candidato({
    categoria: null, subcategoria: null,
    origem: "MODELO",
    utilizacoes: [util({ origem: "DETERMINISTICA" }), util({ slug: "gripe", origem: "MODELO" })],
  });
  const d = avaliarPromocao(c, null);
  check(origemDaPromocao(c, d) === "DETERMINISTICA", "só-utilizações regista a origem mais autoritária delas");
  const reg = registoPromocao(c, d, { actor: "catalog:bootstrap-global" })!;
  check(reg.origem === "DETERMINISTICA", "…e é essa que vai para o rasto");
  check(reg.motivo.includes("só utilizações"), "…com o motivo a dizer que a classificação não subiu", reg.motivo);
}
{
  const c = candidato({ origem: null, motivoOrigem: "por mapear", utilizacoes: [] });
  const d = avaliarPromocao(c, null);
  check(registoPromocao(c, d, { actor: "x" }) === null, "o que não promove nada não gera registo");
}
{
  const reg = registoPromocao(candidato(), avaliarPromocao(candidato(), null), { actor: "  " })!;
  check(reg.actor === "desconhecido", "um actor vazio nunca fica em branco no rasto");
}

console.log("\n=== projecção: validadoManualmente é intocável ===");
{
  const d = avaliarProjeccao(global(), local({ validadoManualmente: true, subcategoria: "Cardiovascular" }));
  check(d.accao === "INTOCAVEL", "produto validado à mão não é tocado");
  check(d.utilizacoes.length === 0, "…nem recebe utilizações");
  check(!d.escreverProductType, "…nem productType");
  check(d.revisao === null, "…e nem sequer levanta revisão: é decisão humana, não divergência");
}

console.log("\n=== projecção: uma específica local nunca é sobreposta ===");
{
  const d = avaliarProjeccao(global(), local({ categoria: "MEDICAMENTOS", subcategoria: "Cardiovascular" }));
  check(d.accao === "REVISAO", "específica DIFERENTE → revisão, não escrita");
  check(d.revisao?.tipo === "CLASSIFICACAO", "…do tipo certo");
  check(
    !!d.revisao?.valorGlobal.includes("Diabetes") && !!d.revisao?.valorLocal.includes("Cardiovascular"),
    "…com os dois lados registados",
    JSON.stringify(d.revisao),
  );
  check(d.utilizacoes.length === 0, "…e não escreve utilizações enquanto a divergência não for resolvida");
}
{
  const jaCompleto = local({
    categoria: "MEDICAMENTOS", subcategoria: "Diabetes", productType: "MEDICAMENTO",
    utilizacoes: [{ slug: "diabetes", fonte: "REGRA", confianca: 0.99 }],
  });
  const d = avaliarProjeccao(global(), jaCompleto);
  check(d.accao === "NO_OP", "específica IGUAL e nada em falta → no-op silencioso");
  check(d.revisao === null, "…sem revisão nenhuma");
}
{
  // O caso que mais interessa ao objectivo: classificação já certa, mas
  // faltam etiquetas. É o estrato SEM_UTILIZACOES visto do global.
  const jaTudo = local({
    categoria: "MEDICAMENTOS", subcategoria: "Diabetes", productType: "MEDICAMENTO",
    utilizacoes: [{ slug: "diabetes", fonte: "REGRA", confianca: 0.99 }],
  });
  const d = avaliarProjeccao(global(), jaTudo);
  const comFalta = avaliarProjeccao(
    global({ utilizacoes: [{ slug: "diabetes", confidence: 0.95, origem: "MODELO" }] }),
    local({ categoria: "MEDICAMENTOS", subcategoria: "Diabetes", utilizacoes: [] }),
  );
  check(d.accao === "NO_OP" && comFalta.accao === "ESCREVER_CLASSIFICACAO",
    "classificação igual mas utilizações em falta → escreve só as utilizações");
  check(comFalta.utilizacoes.join() === "diabetes", "…as que faltavam");
}

console.log("\n=== projecção: fallback e vazio recebem ===");
{
  const d = avaliarProjeccao(global(), local());
  check(d.accao === "ESCREVER_CLASSIFICACAO", "produto sem classificação recebe do global");
  check(d.escreverProductType, "…e o productType, que faltava");
}
{
  const d = avaliarProjeccao(global(), local({ categoria: "MEDICAMENTOS", subcategoria: "Outros Medicamentos" }));
  check(d.accao === "ESCREVER_CLASSIFICACAO", "produto em 'Outros' recebe do global");
}
{
  const d = avaliarProjeccao(global(), local({ productType: "SUPLEMENTO" }));
  check(!d.escreverProductType, "productType já decidido no tenant não é substituído");
}
{
  const g = global({ categoria: null, subcategoria: null, utilizacoes: [], productType: null });
  const d = avaliarProjeccao(g, local());
  check(d.accao === "NO_OP", "global sem classificação nem productType não escreve nada");
  // Mas se o global SÓ tem productType, isso ainda vale a pena projectar.
  const soTipo = avaliarProjeccao(global({ categoria: null, subcategoria: null, utilizacoes: [] }), local());
  check(soTipo.escreverProductType, "…mas um productType global preenche um NULL local");
}

console.log("\n=== projecção: utilizações ===");
{
  const d = avaliarProjeccao(
    global(),
    local({ utilizacoes: [{ slug: "diabetes", fonte: "MANUAL", confianca: null }] }),
  );
  check(d.utilizacoes.length === 0, "utilização MANUAL no tenant NUNCA é sobreposta");
}
{
  const d = avaliarProjeccao(
    global({ utilizacoes: [{ slug: "diabetes", confidence: 0.95, origem: "MODELO" }] }),
    local({ utilizacoes: [{ slug: "diabetes", fonte: "REGRA", confianca: 0.99 }] }),
  );
  check(d.utilizacoes.length === 0, "automática com confiança superior no tenant também ganha");
}
{
  const d = avaliarProjeccao(
    global({ utilizacoes: [{ slug: "diabetes", confidence: 0.95, origem: "MODELO" }] }),
    local({ utilizacoes: [{ slug: "diabetes", fonte: "REGRA", confianca: 0.5 }] }),
  );
  check(d.utilizacoes.join() === "diabetes", "automática mais fraca cede à global");
}
{
  // Autoridade inferior: com confianças IGUAIS, o global não desaloja o
  // local. É o factor de projecção a fazer o desempate.
  const d = avaliarProjeccao(
    global({ utilizacoes: [{ slug: "diabetes", confidence: 0.90, origem: "MODELO" }] }),
    local({ utilizacoes: [{ slug: "diabetes", fonte: "REGRA", confianca: 0.90 }] }),
  );
  check(d.utilizacoes.length === 0, "com confiança igual, a decisão LOCAL ganha (autoridade inferior do global)");
  check(FATOR_PROJECCAO < 1, "…e é isso que o factor de projecção garante");
}

console.log("\n=== versionamento ===");
{
  check(estaDesactualizado(global({ versaoRegras: "ke-1.0" }), "ke-1.1"), "versão antiga é detectada");
  check(!estaDesactualizado(global({ versaoRegras: "ke-1.1" }), "ke-1.1"), "versão actual não é reprocessada");
}

console.log("\n=== determinismo ===");
{
  const a = avaliarProjeccao(global(), local());
  const b = avaliarProjeccao(global(), local());
  check(JSON.stringify(a) === JSON.stringify(b), "avaliarProjeccao é pura");
  const c = avaliarPromocao(candidato(), global());
  const d = avaliarPromocao(candidato(), global());
  check(JSON.stringify(c) === JSON.stringify(d), "avaliarPromocao é pura");
}

console.log("\n=== o segundo tenant não volta a pagar ===");
{
  // A simulação que responde à pergunta central: dois tenants, o mesmo
  // catálogo nacional. O primeiro paga; o segundo recebe.
  const catalogoNacional = [5678901, 5678902, 5678903, 5678904, 5678905];

  // Tenant A corre o pipeline e promove tudo o que passou o gate.
  const promovidos = new Map<number, ConhecimentoGlobal>();
  for (const cnp of catalogoNacional) {
    const c = candidato({ cnp, tenantOrigem: "tenant-a" });
    if (avaliarPromocao(c, promovidos.get(cnp) ?? null).promover) {
      promovidos.set(cnp, global({ cnp }));
    }
  }
  check(promovidos.size === 5, `tenant A promoveu os 5 CNPs (${promovidos.size})`);

  // Tenant B tem os mesmos CNPs, todos por classificar.
  const residualB = catalogoNacional.map((cnp) => local({ cnp }));
  const porPagar = residualB.filter((l) => !promovidos.has(l.cnp));
  check(porPagar.length === 0, "tenant B não tem NENHUM CNP por pagar — é este o objectivo");

  // E o que recebe é mesmo escrito, não apenas "conhecido".
  const escritas = residualB
    .map((l) => avaliarProjeccao(promovidos.get(l.cnp)!, l))
    .filter((d) => d.accao === "ESCREVER_CLASSIFICACAO");
  check(escritas.length === 5, `os 5 recebem classificação por projecção (${escritas.length})`);
  check(escritas.every((d) => d.utilizacoes.length > 0), "…e as utilizações vêm junto");

  // …e o que o tenant A corrigiu à mão NÃO viaja com o resto. É a única
  // coisa que fica para trás de propósito.
  const corrigidoAMao = humano({ cnp: 7777001, tenantOrigem: "tenant-a" });
  check(
    !avaliarPromocao(corrigidoAMao, null).promover,
    "a correcção manual do tenant A não chega ao tenant B sozinha",
  );
  check(
    avaliarPromocao(corrigidoAMao, null, { aprovacao: APROVACAO }).promover,
    "…chega quando alguém assina que vale para todas as farmácias",
  );

  // Um tenant C com um produto que A não tinha continua a pagar só esse.
  const residualC = [...catalogoNacional, 9999001].map((cnp) => local({ cnp }));
  const novosEmC = residualC.filter((l) => !promovidos.has(l.cnp));
  check(novosEmC.length === 1 && novosEmC[0]!.cnp === 9999001,
    "um CNP que ninguém conhece continua a ir ao modelo — e só esse");
}

console.log("\n=== o global não degrada o local ===");
{
  // O risco novo desta camada, em três formas. Todas têm de falhar.
  const errado = global({ categoria: "COSMÉTICA", subcategoria: "Perfumes" });

  const comEspecifica = local({ categoria: "MEDICAMENTOS", subcategoria: "Diabetes" });
  check(avaliarProjeccao(errado, comEspecifica).accao === "REVISAO",
    "um global errado NÃO sobrepõe uma específica local");

  const validado = local({ validadoManualmente: true, categoria: "MEDICAMENTOS", subcategoria: "Diabetes" });
  check(avaliarProjeccao(errado, validado).accao === "INTOCAVEL",
    "…nem toca no que foi validado à mão");

  const comManual = local({
    categoria: "MEDICAMENTOS", subcategoria: "Outros Medicamentos",
    utilizacoes: [{ slug: "diabetes", fonte: "MANUAL", confianca: null }],
  });
  const d = avaliarProjeccao(global({ utilizacoes: [{ slug: "diabetes", confidence: 1, origem: "HUMANO" }] }), comManual);
  check(!d.utilizacoes.includes("diabetes"), "…nem sobrepõe uma utilização MANUAL, venha de onde vier");
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail === 0 ? 0 : 1);
