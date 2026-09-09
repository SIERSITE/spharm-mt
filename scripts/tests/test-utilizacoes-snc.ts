/**
 * scripts/tests/test-utilizacoes-snc.ts
 *
 * Fixa a correcção de Setembro de 2026 ao pipeline de Utilizações: o
 * bloco do sistema nervoso no vocabulário e nas regras, e o gatilho do
 * backfill.
 *
 * O QUE ESTAS ASSERÇÕES PROTEGEM
 *
 * 1. O GATILHO DO BACKFILL. Era `IngestProdutoRun.estado = 'FINALIZADA'`
 *    e o backfill NUNCA correu em produção — nem uma vez, em nenhum dos
 *    três tenants. Não por avaria: só o `products-upload` chama
 *    `/bootstrap/products/finalize`, e a sincronização diária é um upload
 *    delta que não o chama nem deve (o `/finalize` dispara o sweep de
 *    `flagRetirado`, e varrer a partir de um delta marcaria como retirado
 *    o catálogo todo). O sinal certo é o catálogo ter mudado. Se alguém
 *    voltar a ligar isto a uma corrida de ingestão, o backfill volta a
 *    ficar mudo — e o sintoma é silêncio, não um erro.
 *
 * 2. O PISO DE 6 HORAS. Sem ele, o gatilho novo põe uma varredura de
 *    35 000 produtos a correr de 10 em 10 minutos, porque em produção há
 *    escrita em `Produto` quase contínua.
 *
 * 3. A FRONTEIRA DA CONFIANÇA. `PENALIZACAO_DESIGNACAO` é o que separa
 *    "esta substância veio do Grupo Homogéneo, que é do INFARMED via
 *    ERP" de "esta palavra estava na designação, que é texto livre". As
 *    substâncias ambíguas estão calibradas a 0.80 exactamente para
 *    passarem pela primeira e serem recusadas pela segunda. Uma subida
 *    distraída para 0.85 apaga essa distinção sem dar erro.
 *
 * 4. QUE O ATC NÃO CHEGA. As regras ATC do bloco SNC estão escritas mas
 *    dormentes: dependem de `RegulatoryRecord`, e não há nenhum nos
 *    tenants de produção — todos os `codigoATC` de lá foram inferidos
 *    pelo modelo. Quem cobre o bloco hoje é o Grupo Homogéneo. Se alguém
 *    abrir o gate do ATC a pensar que assim "activa" as regras, passa a
 *    alimentar a faceta com inferência do modelo.
 *
 * 5. QUE NÃO HÁ REGRA DE SUBCATEGORIA PARA "Sistema Nervoso". Seria a
 *    correcção preguiçosa e é a errada: essa subcategoria abrange sete
 *    necessidades que mandam a pessoa a prateleiras diferentes.
 *
 * Uso: npx tsx scripts/tests/test-utilizacoes-snc.ts
 */
import { avaliarProduto, precisaBackfill, INTERVALO_MINIMO_BACKFILL_MS } from "../../lib/catalog/utilizacoes-ciclo";
import {
  MIN_CONFIANCA,
  PENALIZACAO_DESIGNACAO,
  REGRAS_ATC,
  REGRAS_SUBCATEGORIA,
  REGRAS_SUBSTANCIA,
} from "../../lib/catalog/utilizacoes-regras";
import { UTILIZACOES, UTILIZACOES_POR_SLUG } from "../../lib/catalog/utilizacoes";

let pass = 0;
let fail = 0;
const ok = (l: string) => { pass++; console.log(`  [OK]    ${l}`); };
const bad = (l: string, d?: string) => { fail++; console.log(`  [FALHA] ${l}${d ? `\n            ${d}` : ""}`); };
const check = (cond: boolean, l: string, d?: string) => (cond ? ok(l) : bad(l, d));

/** Um produto como ele sai da query do backfill. */
function produto(over: Partial<Parameters<typeof avaliarProduto>[0]> = {}) {
  return {
    id: "p1",
    designacao: "Produto Sem Nome",
    productType: "MEDICAMENTO",
    categoria: "MEDICAMENTOS",
    subcategoria: "Sistema Nervoso",
    codigoATC: null,
    grupoHomogeneo: null,
    temRegulatorio: false,
    ...over,
  };
}

const aceites = (p: Parameters<typeof avaliarProduto>[0]) =>
  avaliarProduto(p).filter((c) => c.confianca >= MIN_CONFIANCA);
const slugs = (p: Parameters<typeof avaliarProduto>[0]) => aceites(p).map((c) => c.utilizacao).sort();

const D = "─".repeat(70);

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${D}\n1. Vocabulário: as facetas novas existem e são coerentes\n${D}`);

const NOVAS = [
  "humor-e-depressao", "saude-mental", "epilepsia", "dor-neuropatica",
  "memoria-e-demencia", "parkinson", "vertigens-e-tonturas", "atencao-e-hiperatividade",
];
for (const slug of NOVAS) {
  check(UTILIZACOES_POR_SLUG.has(slug), `vocabulário tem "${slug}"`);
}
check(
  UTILIZACOES.every((u) => u.descricao.trim().length > 0 && u.sinonimos.length > 0),
  "toda a utilização tem descrição e pelo menos um sinónimo",
  "os sinónimos alimentam a pesquisa; sem eles a faceta só é encontrável pelo nome exacto",
);
// UTILIZACOES_POR_SLUG já atira em slug repetido ao carregar o módulo, mas
// a asserção fica explícita para quem lê o teste.
check(
  new Set(UTILIZACOES.map((u) => u.slug)).size === UTILIZACOES.length,
  "não há slugs repetidos no vocabulário",
);

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${D}\n2. Toda a regra aponta para uma utilização que existe\n${D}`);

// É a asserção que apanha um erro de escrita antes de ele chegar à
// produção: `backfillUtilizacoes` atira em runtime quando uma regra
// aponta para um slug inexistente, e aí já é a meio de uma corrida.
const orfas: string[] = [];
for (const r of REGRAS_ATC) if (!UTILIZACOES_POR_SLUG.has(r.utilizacao)) orfas.push(`ATC ${r.atc} → ${r.utilizacao}`);
for (const r of REGRAS_SUBSTANCIA) if (!UTILIZACOES_POR_SLUG.has(r.utilizacao)) orfas.push(`substância ${r.nome} → ${r.utilizacao}`);
for (const r of REGRAS_SUBCATEGORIA) if (!UTILIZACOES_POR_SLUG.has(r.utilizacao)) orfas.push(`subcat ${r.nome} → ${r.utilizacao}`);
check(orfas.length === 0, "nenhuma regra aponta para um slug que não existe", orfas.join(" · "));

const dup = REGRAS_SUBSTANCIA.map((r) => r.nome.toLowerCase())
  .filter((n, i, a) => a.indexOf(n) !== i);
check(dup.length === 0, "não há substâncias repetidas em REGRAS_SUBSTANCIA", dup.join(", "));

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${D}\n3. O caso que motivou tudo isto — sem excepção para ele\n${D}`);

// Sinais REAIS do CNP 5719422 no tenant garantia, 2026-09-09: sem ATC,
// sem RegulatoryRecord, com o Grupo Homogéneo escrito pelo ERP.
const escitalopram = produto({
  designacao: "Escitalopram Generis 10 Mg 56 Comp. Revest. Por Pel.",
  grupoHomogeneo: "Escitalopram | A101 | Oral | 10 mg | [21-60] unidades",
});
check(
  slugs(escitalopram).includes("humor-e-depressao"),
  "Escitalopram (GH do ERP, sem ATC, sem RegulatoryRecord) → humor-e-depressao",
  `obteve: ${JSON.stringify(aceites(escitalopram))}`,
);

// A designação sozinha também chega: em Portugal o genérico chama-se
// pela substância. Isto cobre as farmácias cujo ERP não manda GH.
check(
  slugs(produto({ designacao: "Escitalopram Generis 10 Mg 56 Comp" })).includes("humor-e-depressao"),
  "Escitalopram só pela designação → humor-e-depressao (0.95 − 0.05 = 0.90)",
);

// E o que o vazio significava: sem as regras novas isto era [].
check(
  slugs(produto({ designacao: "Sertralina Krka 50 Mg 60 Comp" })).includes("humor-e-depressao"),
  "Sertralina → humor-e-depressao",
);
check(
  slugs(produto({ designacao: "Quetiapina Generis 25 Mg 60 Comp" })).includes("saude-mental"),
  "Quetiapina → saude-mental",
);
check(
  slugs(produto({ designacao: "Levetiracetam Aurovitas 500 Mg 60 Comp" })).includes("epilepsia"),
  "Levetiracetam → epilepsia",
);
check(
  slugs(produto({ designacao: "Donepezilo Ratiopharm 10 Mg 28 Comp" })).includes("memoria-e-demencia"),
  "Donepezilo → memoria-e-demencia",
);
check(
  slugs(produto({ designacao: "Ropinirol Krka 2 Mg 28 Comp" })).includes("parkinson"),
  "Ropinirol → parkinson",
);
check(
  slugs(produto({ grupoHomogeneo: "Beta-histina | A101 | Oral | 24 mg | [21-60] unidades" })).includes("vertigens-e-tonturas"),
  "Beta-histina (com hífen, como o ERP a escreve) → vertigens-e-tonturas",
);
check(
  slugs(produto({ designacao: "Metilfenidato Sandoz 10 Mg 30 Comp" })).includes("atencao-e-hiperatividade"),
  "Metilfenidato → atencao-e-hiperatividade",
);

// Os gabapentinoides são N03A no ATC mas vão para dor, não para
// epilepsia: é a substância a desempatar o que o prefixo junta.
check(
  slugs(produto({ designacao: "Pregabalina Zentiva 75 Mg 56 Cáps" })).includes("dor-neuropatica"),
  "Pregabalina → dor-neuropatica (e não epilepsia)",
);
check(
  !slugs(produto({ designacao: "Pregabalina Zentiva 75 Mg 56 Cáps" })).includes("epilepsia"),
  "Pregabalina NÃO cai em epilepsia pela substância",
);

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${D}\n4. A fronteira da confiança: GH aceita, designação recusa\n${D}`);

// As ambíguas estão a 0.80 de propósito. Grupo Homogéneo passa (0.80),
// designação não (0.75). Se alguém subir estas para 0.85, as duas
// leituras passam a valer o mesmo e a distinção desaparece em silêncio.
const AMBIGUAS: Array<[string, string]> = [
  ["Amitriptilina", "humor-e-depressao"],
  ["Bupropiona", "humor-e-depressao"],
  ["Cinarizina", "vertigens-e-tonturas"],
];
for (const [nome, destino] of AMBIGUAS) {
  const regra = REGRAS_SUBSTANCIA.find((r) => r.nome.toLowerCase() === nome.toLowerCase());
  check(!!regra && regra.confianca === 0.8, `${nome} está calibrada a 0.80`, `obteve ${regra?.confianca}`);
  check(
    slugs(produto({ grupoHomogeneo: `${nome} | A101 | Oral | 10 mg | [21-60] unidades` })).includes(destino),
    `${nome} por Grupo Homogéneo → ${destino} (aceite)`,
  );
  check(
    !slugs(produto({ designacao: `${nome} Alter 10 Mg 60 Comp` })).includes(destino),
    `${nome} só pela designação → recusada (0.80 − ${PENALIZACAO_DESIGNACAO} < ${MIN_CONFIANCA})`,
  );
}

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${D}\n5. O gate do ATC continua fechado a inferência\n${D}`);

// Um produto com ATC mas sem RegulatoryRecord é o retrato de toda a
// produção: os ATC de lá vieram do modelo. A faceta não os pode usar.
check(
  slugs(produto({ codigoATC: "N06AB10", temRegulatorio: false })).length === 0,
  "ATC N06AB10 sem RegulatoryRecord não produz utilização nenhuma",
  "se isto falhar, a faceta passou a ser alimentada por ATC inferido pelo modelo",
);
check(
  slugs(produto({ codigoATC: "N06AB10", temRegulatorio: true })).includes("humor-e-depressao"),
  "ATC N06AB10 COM RegulatoryRecord → humor-e-depressao",
);
for (const [atc, destino] of [
  ["N05AH04", "saude-mental"],
  ["N03AX14", "epilepsia"],
  ["N06DA02", "memoria-e-demencia"],
  ["N04BC05", "parkinson"],
  ["N07CA01", "vertigens-e-tonturas"],
  ["N06BA04", "atencao-e-hiperatividade"],
] as const) {
  check(
    slugs(produto({ codigoATC: atc, temRegulatorio: true })).includes(destino),
    `ATC ${atc} (regulatório) → ${destino}`,
  );
}

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${D}\n6. "Sistema Nervoso" não é uma regra de subcategoria\n${D}`);

check(
  !REGRAS_SUBCATEGORIA.some((r) => r.nome === "Sistema Nervoso"),
  'não existe REGRAS_SUBCATEGORIA para "Sistema Nervoso"',
  "essa subcategoria cobre sete necessidades distintas; uma regra assim junta o que a faceta existe para separar",
);
// Um produto em Sistema Nervoso sem sinal de substância nem ATC
// regulatório continua — correctamente — sem utilização.
check(
  slugs(produto({ designacao: "Comprimidos Sem Substância Reconhecível 10 Mg" })).length === 0,
  "produto em Sistema Nervoso sem sinal nenhum fica vazio (não há regra de recurso)",
);

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${D}\n7. precisaBackfill: o gatilho novo\n${D}`);

const T = (iso: string) => new Date(iso);
const agora = T("2026-09-09T18:00:00Z");

check(
  precisaBackfill({ ultimaAlteracaoCatalogo: null, ultimoBackfillEm: null, agora }) === false,
  "catálogo vazio → não corre (tenant acabado de provisionar não paga nada)",
);
check(
  precisaBackfill({ ultimaAlteracaoCatalogo: T("2026-09-09T11:26:00Z"), ultimoBackfillEm: null, agora }) === true,
  "há catálogo e nunca houve backfill → corre",
  "é este ramo que recupera os tenants que ficaram para trás — em produção eram os três",
);
check(
  precisaBackfill({
    ultimaAlteracaoCatalogo: T("2026-09-08T10:00:00Z"),
    ultimoBackfillEm: T("2026-09-09T10:00:00Z"),
    agora,
  }) === false,
  "catálogo não mudou desde o último backfill → não corre",
);
check(
  precisaBackfill({
    ultimaAlteracaoCatalogo: T("2026-09-09T11:26:00Z"),
    ultimoBackfillEm: T("2026-09-09T00:00:00Z"),
    agora,
  }) === true,
  "catálogo mudou e passaram 18 h desde a última varredura → corre",
);
check(
  precisaBackfill({
    ultimaAlteracaoCatalogo: T("2026-09-09T17:50:00Z"),
    ultimoBackfillEm: T("2026-09-09T17:00:00Z"),
    agora,
  }) === false,
  "catálogo mudou mas varreu-se há 1 h → espera (piso de 6 h)",
  "sem este ramo, o job de 10 em 10 min varria 35 000 produtos seis vezes por hora",
);
check(
  precisaBackfill({
    ultimaAlteracaoCatalogo: T("2026-09-09T17:50:00Z"),
    ultimoBackfillEm: new Date(agora.getTime() - INTERVALO_MINIMO_BACKFILL_MS),
    agora,
  }) === true,
  "exactamente no piso de 6 h → corre (fronteira inclusiva)",
);

// A regressão de produção, escrita como teste: durante um mês inteiro o
// sinal antigo esteve sempre a false porque nenhuma corrida fechava.
// Este cenário — catálogo a mexer todos os dias, zero corridas
// finalizadas — tem de dar `true`.
check(
  precisaBackfill({
    ultimaAlteracaoCatalogo: T("2026-09-09T11:26:04Z"),
    ultimoBackfillEm: null,
    agora,
  }) === true,
  "regressão garantia: 31 corridas ABANDONADA, 0 FINALIZADA, catálogo a mexer → corre",
);

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${D}`);
console.log(`${pass} passaram · ${fail} falharam`);
console.log(D);
process.exit(fail === 0 ? 0 : 1);
