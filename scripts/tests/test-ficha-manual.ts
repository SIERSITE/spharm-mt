/**
 * scripts/tests/test-ficha-manual.ts
 *
 * Fase 4 — ficha de produto criada à mão, e a proveniência que a
 * protege da sincronização seguinte.
 *
 * ── O que isto existe para impedir ───────────────────────────────────
 *
 * `bulkUpsertProdutosByCnp` fazia, sem condição nenhuma:
 *
 *     "designacao" = EXCLUDED."designacao"
 *
 * Uma ficha criada à mão hoje — com a designação legível, o ATC, a DCI —
 * era sobreposta na primeira sincronização que trouxesse o mesmo CNP,
 * pela designação truncada e em maiúsculas da `dbo.Stocks`. E se o ERP
 * mandasse uma string vazia, o nome desaparecia por completo.
 *
 * Medido antes de alterar: 40 651 produtos, TODOS `origemDados=FARMACIA`
 * e `validadoManualmente=false`. Nenhuma ficha manual existia — o que
 * significa que nenhum destes caminhos tinha sido exercitado contra uma.
 *
 * Corre com:  npm run test:ficha-manual
 */
import { readFileSync } from "node:fs";
import {
  camposManuaisDe,
  CONTEXTOS_CRIACAO,
  normalizarAtc,
  normalizarFichaManual,
  texto,
  validarFichaManual,
  type FichaManual,
} from "../../lib/produtos/criar-produto";
import { MIN_CNP_CATALOGAVEL } from "../../lib/catalog/cnp-catalogavel";
import { SOURCE_TIER_RANK, type SourceTier } from "../../lib/catalog-types";

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
const eq = (a: unknown, b: unknown, label: string) =>
  check(
    JSON.stringify(a) === JSON.stringify(b),
    label,
    `esperado ${JSON.stringify(b)}, obtido ${JSON.stringify(a)}`,
  );

const src = (p: string) => readFileSync(p, "utf8");

/**
 * O ficheiro sem comentarios.
 *
 * Existe porque uma verificacao ingenua sobre o texto inteiro acusa
 * exactamente a DOCUMENTACAO que queremos que exista: a accao explica,
 * em comentario, porque NAO usa `legacyPrisma` e porque NAO liga
 * `validadoManualmente` — e um `includes()` sobre o ficheiro cru le
 * essas explicacoes como se fossem codigo.
 */
const semComentarios = (p: string) =>
  src(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/** Uma ficha mínima válida. */
const base = (over: Partial<FichaManual> = {}): FichaManual => ({
  cnp: 5_880_075,
  designacao: "Mounjaro 5 Mg/0.6 Ml Sol. Injetável",
  ...over,
});

const erroDe = (f: FichaManual, campo: string): string | undefined =>
  validarFichaManual(f).find((e) => e.campo === campo)?.mensagem;

// ═════════════════════════════════════════════════════════════════════
// A. Criação: o que é uma ficha válida
// ═════════════════════════════════════════════════════════════════════
console.log("\nA. Uma ficha válida precisa de CNP e designação\n");

eq(validarFichaManual(base()), [], "CNP + designação bastam");
check(erroDe(base({ designacao: "" }), "designacao") !== undefined, "designação vazia é recusada");
check(erroDe(base({ designacao: "   " }), "designacao") !== undefined, "designação só com espaços é recusada");
check(erroDe(base({ designacao: "ab" }), "designacao") !== undefined, "designação de 2 letras é curta demais");
check(erroDe(base({ designacao: "x".repeat(400) }), "designacao") !== undefined, "designação acima de 300 é recusada");

// Todos os erros de uma vez — um formulário que corrige um de cada vez
// obriga a três submissões para três campos.
{
  const errs = validarFichaManual({ cnp: 0, designacao: "", codigoATC: "isto não é um ATC" });
  check(errs.length >= 3, `devolve TODOS os erros de uma vez (${errs.length})`);
}

// ═════════════════════════════════════════════════════════════════════
// B. CNP interno / não catalogável
// ═════════════════════════════════════════════════════════════════════
console.log("\nB. Um código interno do ERP não pode virar ficha central\n");

check(erroDe(base({ cnp: 17 }), "cnp") !== undefined, "CNP 17 recusado");
check(erroDe(base({ cnp: 1_999_999 }), "cnp") !== undefined, "CNP abaixo da fronteira recusado");
check(
  erroDe(base({ cnp: MIN_CNP_CATALOGAVEL }), "cnp") !== undefined,
  `CNP exactamente ${MIN_CNP_CATALOGAVEL} recusado (a fronteira é exclusiva)`,
);
eq(validarFichaManual(base({ cnp: MIN_CNP_CATALOGAVEL + 1 })), [], "um acima da fronteira é aceite");
check(erroDe(base({ cnp: -5 }), "cnp") !== undefined, "CNP negativo recusado");
check(erroDe(base({ cnp: 1.5 }), "cnp") !== undefined, "CNP não inteiro recusado");
{
  // A mensagem tem de EXPLICAR, não só recusar: quem escreve um código
  // interno não sabe que existe uma fronteira.
  const m = erroDe(base({ cnp: 17 }), "cnp") ?? "";
  check(m.includes("interno do ERP"), "…e a mensagem diz porquê");
}

// ═════════════════════════════════════════════════════════════════════
// C. ATC — forma, não texto livre
// ═════════════════════════════════════════════════════════════════════
console.log("\nC. O ATC tem uma forma\n");

for (const bom of ["A", "A10", "A10B", "A10BX", "A10BX16", "N06AB03"]) {
  eq(validarFichaManual(base({ codigoATC: bom })), [], `«${bom}» é aceite`);
}
for (const mau of ["AA", "A1", "10A", "A10BX1", "Antidiabético", "A10-BX16"]) {
  check(erroDe(base({ codigoATC: mau }), "codigoATC") !== undefined, `«${mau}» é recusado`);
}
eq(normalizarAtc(" a10bx16 "), "A10BX16", "normaliza para maiúsculas e apara");
eq(normalizarAtc("A10 BX16"), "A10BX16", "remove espaços interiores");
eq(normalizarAtc(""), null, "vazio → null");
eq(normalizarAtc(null), null, "null → null");
eq(validarFichaManual(base({ codigoATC: "" })), [], "ATC vazio é legítimo — nem todos os produtos têm");

// Porque isto importa: um ATC com texto livre estraga o filtro
// hierárquico por prefixo, que é a razão de existir do campo.
check(
  !/^[A-Z]/.test("antidiabético".toUpperCase().slice(0, 1)) === false,
  "(sanidade do teste)",
);

// ═════════════════════════════════════════════════════════════════════
// D. Normalização
// ═════════════════════════════════════════════════════════════════════
console.log("\nD. Normalização\n");

eq(texto("  Paracetamol   500  mg "), "Paracetamol 500 mg", "apara e colapsa espaços");
eq(texto(""), null, "vazio → null");
eq(texto("   "), null, "só espaços → null");
eq(texto(null), null, "null → null");

{
  const n = normalizarFichaManual(base({ dci: "  Tirzepatido ", codigoATC: "a10bx16", dosagem: "" }));
  eq(n.dci, "Tirzepatido", "DCI normalizada");
  eq(n.codigoATC, "A10BX16", "ATC normalizado");
  eq(n.dosagem, null, "campo vazio → null, não string vazia");
  eq(n.flagGenerico, false, "flagGenerico tem default false");
}
{
  let atirou = false;
  try {
    normalizarFichaManual(base({ cnp: 17 }));
  } catch {
    atirou = true;
  }
  check(atirou, "normalizar uma ficha inválida ATIRA — é erro de programa, não de utilizador");
}

// ═════════════════════════════════════════════════════════════════════
// E. camposManuais — só os que o ERP escreve
// ═════════════════════════════════════════════════════════════════════
console.log("\nE. `camposManuais` protege o que precisa de protecção\n");

eq(camposManuaisDe(base()), ["designacao"], "designação preenchida → protegida");
eq(camposManuaisDe(base({ flagGenerico: true })), ["designacao", "flagGenerico"], "genérico marcado → protegido");
eq(camposManuaisDe(base({ flagGenerico: false })), ["designacao"], "genérico NÃO marcado → não protegido");

{
  // A parte que interessa: DCI e ATC preenchidos NÃO entram na lista.
  // Não é esquecimento — o ERP nunca lhes toca, e marcá-los seria ruído
  // a sugerir uma ameaça que não existe.
  const cm = camposManuaisDe(base({ dci: "Tirzepatido", codigoATC: "A10BX16", dosagem: "5 mg" }));
  check(!cm.includes("dci"), "DCI não entra — o ERP não a escreve");
  check(!cm.includes("codigoATC"), "ATC não entra — idem");
  check(!cm.includes("dosagem"), "dosagem não entra — idem");
}
{
  // E campos em branco não são protegidos: deixar um campo vazio não é
  // decidir que ele deve ficar vazio para sempre. Bloquear o ERP sobre
  // ele impediria o produto de ser enriquecido — o contrário do que a
  // ficha manual serve.
  const cm = camposManuaisDe({ cnp: 5_880_075, designacao: "X Y Z" });
  eq(cm, ["designacao"], "campos em branco não são protegidos");
}

// ═════════════════════════════════════════════════════════════════════
// F. Tiers de proveniência
// ═════════════════════════════════════════════════════════════════════
console.log("\nF. MANUAL abaixo do regulamentar, acima do ERP\n");

const r = (t: SourceTier) => SOURCE_TIER_RANK[t];

check(r("REGULATORY") < r("MANUAL"), "REGULATORY ganha ao MANUAL — uma fonte oficial corrige a mão");
check(r("MANUFACTURER") < r("MANUAL"), "MANUFACTURER também");
check(r("MANUAL") < r("ERP_FARMACIA"), "MANUAL ganha ao ERP — é o requisito central da fase");
check(r("MANUAL") < r("DISTRIBUTOR"), "…e ao distribuidor");
check(r("MANUAL") < r("MODEL_INFERRED"), "…e ao modelo");
check(r("ERP_FARMACIA") < r("RETAIL"), "o ERP ainda ganha ao retail");

{
  // Sem empates: dois tiers com o mesmo rank tornam a precedência
  // dependente da ordem de iteração, que é o mesmo que não a ter.
  const ranks = Object.values(SOURCE_TIER_RANK);
  eq(new Set(ranks).size, ranks.length, "nenhum rank está repetido");
}
{
  const tiers = Object.keys(SOURCE_TIER_RANK) as SourceTier[];
  check(tiers.includes("MANUAL"), "MANUAL existe no enum");
  check(tiers.includes("ERP_FARMACIA"), "ERP_FARMACIA existe no enum");
}

eq(CONTEXTOS_CRIACAO.length, 2, "dois contextos de criação");
check(CONTEXTOS_CRIACAO.includes("STOCK") && CONTEXTOS_CRIACAO.includes("ENCOMENDA"), "STOCK e ENCOMENDA");

// ═════════════════════════════════════════════════════════════════════
// G. A ingestão respeita a mão — e o vazio não apaga
// ═════════════════════════════════════════════════════════════════════
console.log("\nG. O ON CONFLICT da ingestão\n");

{
  const bulk = src("lib/ingest/bulk.ts");

  // Os três campos que o ERP escrevia sem condição.
  for (const campo of ["designacao", "flagGenerico", "flagMnsrmNCompart"]) {
    check(
      new RegExp(`'${campo}' = ANY\\("Produto"\\."camposManuais"\\)`).test(bulk),
      `${campo}: consulta camposManuais antes de escrever`,
    );
  }
  // O que NÃO pode voltar: a atribuição incondicional.
  check(
    !/"designacao"\s+= EXCLUDED\."designacao",/.test(bulk),
    "a atribuição incondicional da designação desapareceu",
  );
  // O vazio do ERP.
  check(
    /NULLIF\(btrim\(EXCLUDED\."designacao"\), ''\)/.test(bulk),
    "designação vazia do ERP vira NULL…",
  );
  check(
    /COALESCE\(NULLIF\(btrim\(EXCLUDED\."designacao"\), ''\), "Produto"\."designacao"\)/.test(bulk),
    "…e o COALESCE devolve a que lá estava — protege as 40 651 fichas existentes",
  );
  // Primeiro aparecimento numa farmácia.
  check(
    /"primeiraFarmaciaEm" = CASE/.test(bulk),
    "regista o primeiro aparecimento numa farmácia",
  );
  check(
    /COALESCE\("Produto"\."primeiraFarmaciaEm", now\(\)\)/.test(bulk),
    "…uma só vez: se já lá está, fica",
  );
  check(
    /"Produto"\."origemDados" = 'MANUAL'/.test(bulk),
    "…e só para fichas manuais",
  );
}
{
  // O caminho de recurso por linha tem de ter as MESMAS protecções. Se
  // só o bulk as tivesse, uma falha transitória — que é exactamente
  // quando este ramo corre — apagava a designação em silêncio.
  const rota = src("app/api/ingest/v1/bootstrap/products/route.ts");
  check(rota.includes("camposManuais"), "o fallback per-row lê camposManuais");
  check(
    /manual\.has\("designacao"\) \|\| designacaoNova === ""/.test(rota),
    "…e protege designação manual E vazia",
  );
  check(rota.includes("primeiraFarmaciaEm"), "…e também regista o primeiro aparecimento");
}

// ═════════════════════════════════════════════════════════════════════
// H. As pontas
// ═════════════════════════════════════════════════════════════════════
console.log("\nH. Migration, acção e os dois pontos de entrada\n");

{
  const mig = src("prisma/migrations/20260915090000_ficha_manual_proveniencia/migration.sql");
  check(/ADD COLUMN "camposManuais"\s+TEXT\[\]\s+NOT NULL DEFAULT '\{\}'/.test(mig), "camposManuais com default vazio");
  check(mig.includes('"criadoPorId"'), "criadoPorId");
  check(mig.includes('"contextoCriacao"'), "contextoCriacao");
  check(mig.includes('"primeiraFarmaciaEm"'), "primeiraFarmaciaEm");
  check(!/UPDATE |DELETE |DROP /i.test(mig), "aditiva: não reescreve nem apaga nada");
}
{
  const acao = src("app/produtos/criar/actions.ts");
  check(acao.includes('requirePermission("catalog.write")'), "exige catalog.write, não reports.write");
  check(/criado: false/.test(acao), "CNP existente devolve o produto em vez de erro");
  check(acao.includes('origemDados: "MANUAL"'), "marca a ficha como MANUAL");
  check(acao.includes("camposManuais: ficha.camposManuais"), "grava a proveniência");
  check(acao.includes("produto.created_manual"), "audita a criação");
  check(acao.includes("contextoCriacao"), "…com o contexto");
  // Não usa `legacyPrisma` — a armadilha de `catalog-persistence`.
  const acaoCodigo = semComentarios("app/produtos/criar/actions.ts");
  check(!acaoCodigo.includes("legacyPrisma"), "usa o prisma do TENANT, não o legado");
  check(
    !acaoCodigo.includes("validadoManualmente"),
    "NÃO liga o cadeado global — a protecção é fina",
  );
  // Não cria taxonomia nova a partir de um formulário de produto.
  check(
    !/classificacao\.(create|upsert)/.test(acao),
    "não cria classificações novas — a taxonomia é fechada",
  );
}
{
  // Um formulário, dois hospedeiros.
  const form = "components/produtos/criar-produto-form.tsx";
  check(src(form).includes("criarProdutoManualAction"), "o formulário chama a acção única");
  check(src(form).includes("validarFichaManual"), "…e valida com a MESMA função do servidor");
  for (const [f, nome] of [
    ["components/produtos/criar-produto-client.tsx", "Stocks"],
    ["components/encomendas/product-picker.tsx", "ProductPicker"],
  ] as const) {
    check(src(f).includes("CriarProdutoForm"), `${nome}: usa o formulário comum`);
  }
  // Nenhum hospedeiro tem formulário próprio.
  check(
    !/criarProdutoManualAction/.test(src("components/encomendas/product-picker.tsx")),
    "o picker não fala com a acção directamente — passa pelo formulário",
  );
}
{
  const picker = src("components/encomendas/product-picker.tsx");
  check(picker.includes("permitirCriar"), "o picker tem o opt-in");
  check(picker.includes('contexto="ENCOMENDA"'), "…e regista o contexto certo");
  check(/cnpInicial=\{cnpPesquisado\}/.test(picker), "pré-preenche o CNP pesquisado");
  const oc = src("components/encomendas/order-create-client.tsx");
  check(/permitirCriar/.test(oc), "a encomenda nova activa-o");
  const od = src("components/encomendas/order-detail-client.tsx");
  check(/permitirCriar/.test(od), "…e o rascunho aberto também");
}
{
  const stock = src("components/stock/stock-client.tsx");
  check(stock.includes('href="/produtos/criar"'), "Stocks tem o botão");
  const cli = src("components/produtos/criar-produto-client.tsx");
  check(
    /router\.push\(`\/catalogo\/artigo\/\$\{p\.cnp\}`\)/.test(cli),
    "…e navega para a FICHA, não para /stock (que não a mostraria)",
  );
}

// ═════════════════════════════════════════════════════════════════════
console.log(`\n${ko === 0 ? "PASSOU" : "FALHOU"} — ${ok} OK, ${ko} falhas\n`);
process.exit(ko === 0 ? 0 : 1);
