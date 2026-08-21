/**
 * scripts/tests/test-filtro-global-residual.ts
 *
 * O filtro do catálogo global tem de perguntar a coisa CERTA.
 *
 * ─────────────────────────────────────────────────────────────────────
 * O DEFEITO QUE ISTO GUARDA
 *
 * O runner filtrava por PRESENÇA: `conhecidos.has(cnp)`. Se o catálogo
 * global tivesse uma linha daquele CNP, o produto não ia ao modelo.
 *
 * O canary de 25 produtos de 2026-08-21 tornou isso visível — 25
 * entraram no residual, 25 foram saltados, 0 chamadas, custo $0 — e o
 * que o global sabia sobre eles era exactamente o contrário do que lhes
 * faltava:
 *
 *   19 SEM_UTILIZACOES      o global tinha classificação e 0 utilizações
 *    6 OUTROS_MEDICAMENTOS  o global tinha utilizações e 0 classificação
 *
 * À escala do catálogo, no mesmo dia: 7 692 dos 18 485 residuais eram
 * saltados, e em 7 690 o global não tinha nada que os ajudasse. Dois de
 * sete mil seiscentos e noventa e dois.
 *
 * Ficavam num limbo estável: o global não os classificava porque não
 * sabia, e o modelo nunca os via porque o global "conhecia-os". Nenhuma
 * corrida os desbloquearia. O relatório chamava-lhe "chamadas poupadas
 * 100%" — que soa a eficiência e era paralisia.
 *
 * Estas asserções falham na versão por presença e passam na versão por
 * necessidade.
 *
 * Sem base de dados e sem rede.
 *
 * Uso: npx tsx scripts/tests/test-filtro-global-residual.ts
 */
import {
  globalResolveResidual,
  type ConhecimentoGlobal,
  type EstratoResidual,
} from "../../lib/catalog/global-catalog";

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

const glob = (over: Partial<ConhecimentoGlobal> = {}): ConhecimentoGlobal => ({
  cnp: 1234567,
  categoria: "MEDICAMENTOS",
  subcategoria: "Diabetes",
  productType: "MEDICAMENTO",
  confidence: 0.95,
  origem: "DETERMINISTICA",
  versaoRegras: "ke-1.1",
  verificado: false,
  utilizacoes: [],
  ...over,
});

const util = { slug: "diabetes", confidence: 0.9, origem: "DETERMINISTICA" as const };

// ═════════════════════════════════════════════════════════════════════
console.log("\n=== O CANÁRIO REAL: o global tinha o oposto do que faltava ===");
{
  // Os 19 SEM_UTILIZACOES: classificação no global, zero utilizações.
  const d = globalResolveResidual("SEM_UTILIZACOES", glob({ utilizacoes: [] }));
  check(!d.resolve, "SEM_UTILIZACOES + global só com classificação → VAI ao modelo");
  check(
    d.motivo.includes("SEM utilizações"),
    "…e o motivo diz que é isso que falta",
    d.motivo,
  );

  // Os 6 OUTROS_MEDICAMENTOS: utilizações no global, zero classificação.
  const e = globalResolveResidual(
    "OUTROS_MEDICAMENTOS",
    glob({ categoria: null, subcategoria: null, utilizacoes: [util] }),
  );
  check(!e.resolve, "OUTROS_MEDICAMENTOS + global só com utilizações → VAI ao modelo");
  check(
    e.motivo.includes("SEM classificação específica"),
    "…e o motivo diz que é isso que falta",
    e.motivo,
  );
}

console.log("\n=== …e o global RESOLVE quando tem mesmo o que falta ===");
{
  const a = globalResolveResidual("SEM_UTILIZACOES", glob({ utilizacoes: [util] }));
  check(a.resolve, "SEM_UTILIZACOES + global com utilizações → dispensa a chamada");

  const b = globalResolveResidual("NAO_CLASSIFICADO", glob());
  check(b.resolve, "NAO_CLASSIFICADO + global com classificação específica → dispensa");

  const c = globalResolveResidual("OUTROS_MEDICAMENTOS", glob());
  check(c.resolve, "OUTROS_MEDICAMENTOS + global com classificação específica → dispensa");
}

console.log("\n=== um fallback no global não resolve um fallback no tenant ===");
{
  // É o mesmo não-saber, escrito duas vezes. Se isto passasse, um produto
  // em "Outros Medicamentos" seria dispensado por o global também não
  // saber — e ficava assim para sempre.
  for (const sub of ["Outros Medicamentos", "Outros Suplementos", "outros medicamentos"]) {
    const d = globalResolveResidual("OUTROS_MEDICAMENTOS", glob({ subcategoria: sub }));
    check(!d.resolve, `global com "${sub}" NÃO dispensa a chamada`);
  }
  const semCategoria = globalResolveResidual("NAO_CLASSIFICADO", glob({ categoria: null }));
  check(!semCategoria.resolve, "global sem categoria não dispensa");
  const semSub = globalResolveResidual("NAO_CLASSIFICADO", glob({ subcategoria: null }));
  check(!semSub.resolve, "global sem subcategoria não dispensa");
}

console.log("\n=== o global não conhecer o cnp é o caso trivial ===");
{
  for (const e of ["NAO_CLASSIFICADO", "OUTROS_MEDICAMENTOS", "SEM_UTILIZACOES"] as EstratoResidual[]) {
    const d = globalResolveResidual(e, undefined);
    check(!d.resolve, `${e} + cnp desconhecido → vai ao modelo`);
    check(d.motivo.includes("não conhece"), `…com motivo próprio (${e})`);
  }
}

console.log("\n=== CONTRASTE com o filtro antigo (por presença) ===");
{
  // Reprodução do filtro que existia. Serve para tornar explícita a
  // diferença: onde ele dizia "salta", a regra nova diz "vai".
  const porPresenca = (g: ConhecimentoGlobal | undefined) => !!g;

  const casos: Array<{ nome: string; estrato: EstratoResidual; g: ConhecimentoGlobal }> = [
    { nome: "19 do canary", estrato: "SEM_UTILIZACOES", g: glob({ utilizacoes: [] }) },
    {
      nome: "6 do canary",
      estrato: "OUTROS_MEDICAMENTOS",
      g: glob({ categoria: null, subcategoria: null, utilizacoes: [util] }),
    },
    { nome: "fallback vs fallback", estrato: "OUTROS_MEDICAMENTOS", g: glob({ subcategoria: "Outros Medicamentos" }) },
  ];
  for (const c of casos) {
    const antigo = porPresenca(c.g);
    const novo = globalResolveResidual(c.estrato, c.g).resolve;
    check(
      antigo === true && novo === false,
      `${c.nome}: o filtro antigo saltava, o novo envia ao modelo`,
      `antigo=${antigo} novo=${novo}`,
    );
  }

  // E onde o global serve mesmo, os dois concordam — a correcção não
  // desliga a poupança, só a torna verdadeira.
  const util_ok = globalResolveResidual("SEM_UTILIZACOES", glob({ utilizacoes: [util] })).resolve;
  const classe_ok = globalResolveResidual("NAO_CLASSIFICADO", glob()).resolve;
  check(util_ok && classe_ok, "onde o global serve, continua a poupar a chamada");
}

console.log("\n=== RECONCILIAÇÃO: todo o residual tem destino ===");
{
  // A contabilidade que o relatório passa a imprimir. Aqui verifica-se a
  // identidade que ela assume, com números arbitrários.
  const residual = 100;
  const jaConhecidosGlobal = 30;
  const excluidosBaixaCobertura = 5;
  const excluidosOpacos = 3;
  const enviadosAoModelo = 50;
  const propagados = 12;
  const soma =
    jaConhecidosGlobal + excluidosBaixaCobertura + excluidosOpacos + enviadosAoModelo + propagados;
  check(soma === residual, "os cinco destinos somam o residual", `${soma} != ${residual}`);

  // E o caso que a reconciliação existe para apanhar: um destino novo
  // que não seja contado deixa um resto diferente de zero.
  const comDestinoNovoNaoContado = 100 - (30 + 5 + 3 + 40 + 12);
  check(
    comDestinoNovoNaoContado !== 0,
    "um destino não contabilizado deixa resto — é isso que a reconciliação denuncia",
  );
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail === 0 ? 0 : 1);
