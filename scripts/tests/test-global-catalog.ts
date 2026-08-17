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
  avaliarProjeccao,
  avaliarPromocao,
  ehEspecifica,
  estaDesactualizado,
  maisAutoritaria,
  type ConhecimentoCandidato,
  type ConhecimentoGlobal,
  type EstadoLocal,
  type OrigemGlobal,
} from "../../lib/catalog/global-catalog";

let pass = 0;
let fail = 0;
const ok = (l: string) => { pass++; console.log(`  [OK]    ${l}`); };
const bad = (l: string, d?: string) => { fail++; console.log(`  [FALHA] ${l}${d ? `\n            ${d}` : ""}`); };
const check = (c: boolean, l: string, d?: string) => (c ? ok(l) : bad(l, d));

const candidato = (over: Partial<ConhecimentoCandidato> = {}): ConhecimentoCandidato => ({
  cnp: 5678901,
  designacaoReferencia: "Ozempic 0.25 Mg Sol. Injetável",
  productType: "MEDICAMENTO",
  categoria: "MEDICAMENTOS",
  subcategoria: "Diabetes",
  utilizacoes: [{ slug: "diabetes", confidence: 0.95 }],
  confidence: 0.95,
  evidenceType: "MARCA_CONHECIDA",
  origem: "MODELO",
  versaoRegras: "ke-1.1",
  verificado: true,
  tenantOrigem: "tenant-a",
  ...over,
});

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
  const ordem: OrigemGlobal[] = ["HUMANO", "REGULATORY", "MODELO", "PROPAGADO"];
  for (let i = 1; i < ordem.length; i++) {
    check(
      ORIGEM_RANK[ordem[i - 1]!] < ORIGEM_RANK[ordem[i]!],
      `${ordem[i - 1]} é mais autoritária que ${ordem[i]}`,
    );
  }
  check(maisAutoritaria("MODELO", "HUMANO") === "HUMANO", "maisAutoritaria escolhe o humano");
  check(maisAutoritaria("PROPAGADO", "MODELO") === "MODELO", "…e o directo sobre o propagado");
}

console.log("\n=== 'Outros <X>' não é conhecimento ===");
{
  check(!ehEspecifica("Outros Medicamentos"), "'Outros Medicamentos' não é específica");
  check(!ehEspecifica(null), "null não é específica");
  check(ehEspecifica("Diabetes"), "'Diabetes' é específica");
  const d = avaliarPromocao(candidato({ subcategoria: "Outros Medicamentos" }), null);
  check(!d.promover, "um fallback NÃO é promovido ao global");
}

console.log("\n=== promoção: entre dois conhecimentos, fica o mais autoritário ===");
{
  check(avaliarPromocao(candidato(), null).promover, "cnp desconhecido é promovido");
}
{
  const d = avaliarPromocao(candidato({ origem: "HUMANO", confidence: 0.5 }), global({ origem: "MODELO", confidence: 1 }));
  check(d.promover, "HUMANO com confiança 0.5 supera MODELO com confiança 1.0");
  check(d.motivo.includes("autoritária"), "…e o motivo diz porquê", d.motivo);
}
{
  const d = avaliarPromocao(candidato({ origem: "MODELO", confidence: 1 }), global({ origem: "HUMANO", confidence: 0.5 }));
  check(!d.promover, "o inverso NÃO acontece: um modelo não desfaz uma validação humana");
}
{
  const d = avaliarPromocao(candidato({ origem: "PROPAGADO" }), global({ origem: "MODELO" }));
  check(!d.promover, "PROPAGADO não substitui MODELO");
}
{
  const d = avaliarPromocao(candidato({ confidence: 0.99 }), global({ confidence: 0.90 }));
  check(d.promover, "mesma origem, confiança superior → promove");
}
{
  const d = avaliarPromocao(candidato({ confidence: 0.90 }), global({ confidence: 0.90 }));
  check(!d.promover, "empate mantém o que lá está — reprocessar não gera escrita");
}
{
  // Idempotência: promover duas vezes o mesmo dá o mesmo resultado.
  const c = candidato();
  const g = global({ confidence: c.confidence, origem: c.origem });
  check(!avaliarPromocao(c, g).promover, "promover o que já foi promovido é no-op");
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

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail === 0 ? 0 : 1);
