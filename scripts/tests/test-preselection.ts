/**
 * scripts/tests/test-preselection.ts
 *
 * Fixa a lógica de pré-selecção do knowledge-enrichment.
 *
 * O caso central é a CHAVE DE FAMÍLIA. Uma primeira análise agrupou por
 * marca e concluiu que 47% do residual era propagável; os exemplos
 * desmentiram-na — "conjunto de cutículas Lycia" herdava a classificação
 * de "Lycia Deo Roll On". Propagar por marca é inventar com outro nome, e
 * é o que estas asserções impedem de voltar.
 *
 * Sem base de dados e sem rede.
 *
 * Uso: npx tsx scripts/tests/test-preselection.ts
 */
import { readFileSync } from "node:fs";
import {
  CUSTO_POR_PRODUTO,
  agruparFamilias,
  chaveFamiliaEstrita,
  coberturaPorSubcategoria,
  ehEspecifica,
  nomeOpaco,
  normalizar,
  subcategoriasExcluiveis,
  type ProdutoPreselecao,
} from "../../lib/catalog/preselection";

let pass = 0;
let fail = 0;
const ok = (l: string) => { pass++; console.log(`  [OK]    ${l}`); };
const bad = (l: string, d?: string) => { fail++; console.log(`  [FALHA] ${l}${d ? `\n            ${d}` : ""}`); };
const check = (c: boolean, l: string, d?: string) => (c ? ok(l) : bad(l, d));

let n = 0;
const prod = (designacao: string, nivel2: string | null = null, utilizacoes: string[] = [], nivel1: string | null = null): ProdutoPreselecao => ({
  cnp: 2_000_000 + n++,
  designacao,
  nivel1: nivel1 ?? (nivel2 ? "MEDICAMENTOS" : null),
  nivel2,
  utilizacoes,
});

console.log("=== normalização ===");
{
  check(normalizar("Ácido Alendrónico") === "acido alendronico", "acentos são removidos, não os caracteres à volta");
  check(normalizar("Tesoura") === "tesoura", "o 's' sobrevive (um regex de acentos mal escrito comia-o)");
  check(normalizar("PREGABALINA") === "pregabalina", "minúsculas");
}

console.log("\n=== chave de família: dosagem e embalagem não são identidade ===");
{
  const a = chaveFamiliaEstrita("PREGABALINA ZENTIVA 25 MG 14 CÁPSULA");
  const b = chaveFamiliaEstrita("Pregabalina Zentiva 75 mg x 56 cáps");
  check(a === b && a === "pregabalina zentiva", `mesma substância+laboratório, dosagens diferentes → mesma família (${a})`);
}
{
  const a = chaveFamiliaEstrita("Ben-u-ron 500 mg x 20 comp");
  const b = chaveFamiliaEstrita("Ben-u-ron 1 g x 18 comp");
  check(a === b, "gramas ou miligramas, é o mesmo produto");
}
{
  const a = chaveFamiliaEstrita("VLESI - SLIP COMPACT M 70-120CM 30U");
  const b = chaveFamiliaEstrita("VLESI - SLIP COMPACT M 70-120 CM 30 U");
  check(a === b, "espaçamento e pontuação não criam famílias diferentes");
}

console.log("\n=== a marca sozinha NÃO faz família (o erro que isto impede) ===");
{
  const casos: [string, string][] = [
    ["lycia art.221 conjunto cuticulas", "Lycia 2673 Deo Roll On 50 Ml"],
    ["Tesoura de Peles nº 31", "TESOURA P/ LIGADURA Nº 451/13"],
    ["PIC SPRAY GELO INSTANTANEO 400 ML", "PIC PENSO 15CM X 10CM X5"],
    ["Klorane Champoo Sh Oleo Vison 200 Ml", "KLORANE DERMO PRO PROT LABIAL 3,5 G"],
    ["UREADIN TABLETS", "UREADIN 10 LOCAO UREIA 10% 150 ML"],
  ];
  for (const [x, y] of casos) {
    check(
      chaveFamiliaEstrita(x) !== chaveFamiliaEstrita(y),
      `"${x.slice(0, 28)}" e "${y.slice(0, 28)}" NÃO são a mesma família`,
      `${chaveFamiliaEstrita(x)} vs ${chaveFamiliaEstrita(y)}`,
    );
  }
}
{
  check(chaveFamiliaEstrita("00") === null, "nome só de dígitos não tem família");
  check(chaveFamiliaEstrita("5109400") === null, "código não tem família");
}

console.log("\n=== conflito entre irmãos bloqueia a propagação ===");
{
  const fams = agruparFamilias([
    prod("Pregabalina Zentiva 25 mg 14 caps", "Sistema Nervoso"),
    prod("Pregabalina Zentiva 75 mg 56 caps", "Dor"),
    prod("Pregabalina Zentiva 150 mg 56 caps", null),
  ]);
  const f = fams.get("pregabalina zentiva")!;
  check(!!f && f.membros.length === 3, "os três ficam na mesma família");
  check(f.conflito !== null, "irmãos em classificações diferentes → conflito");
  check(f.conflito!.includes("Sistema Nervoso") && f.conflito!.includes("Dor"),
    "…e o conflito nomeia os dois lados", f.conflito!);
}
{
  const fams = agruparFamilias([
    prod("Ben u ron 500 mg 20 comp", "Dor e Febre", ["dor"]),
    prod("Ben u ron 1 g 18 comp", "Dor e Febre", ["febre"]),
  ]);
  const f = [...fams.values()][0]!;
  check(f.conflito !== null && f.conflito!.includes("utilizações"),
    "utilizações divergentes entre irmãos também são conflito");
}
{
  const fams = agruparFamilias([
    prod("Ben u ron 500 mg 20 comp", "Dor e Febre", ["dor", "febre"]),
    prod("Ben u ron 1 g 18 comp", "Dor e Febre", ["febre", "dor"]),
    prod("Ben u ron 125 mg supositorio", null),
  ]);
  const f = [...fams.values()][0]!;
  check(f.conflito === null, "mesma classificação e mesmas utilizações (por ordem diferente) → sem conflito");
  check(f.resolvidos.length === 2 && f.comUtilizacoes.length === 2, "os irmãos resolvidos são identificados");
}

console.log("\n=== 'Outros <X>' não é classificação de onde herdar ===");
{
  check(!ehEspecifica("Outros Medicamentos"), "'Outros Medicamentos' não é específica");
  check(!ehEspecifica(null), "null não é específica");
  check(ehEspecifica("Diabetes"), "'Diabetes' é específica");
  const fams = agruparFamilias([
    prod("Edarbi 20 mg 14 comp", "Outros Medicamentos"),
    prod("Edarbi 40 mg 28 comp", "Outros Medicamentos"),
  ]);
  const f = [...fams.values()][0]!;
  check(f.resolvidos.length === 0, "família inteira em fallback não tem de quem herdar");
  check(f.conflito === null, "…e isso não é um conflito, é falta de fonte");
}

console.log("\n=== cobertura por subcategoria ===");
{
  const produtos = [
    ...Array.from({ length: 40 }, (_, i) => prod(`Alicate ${i}`, "Acessórios de Beleza", [], "COSMÉTICA")),
    ...Array.from({ length: 10 }, (_, i) => prod(`Xarope ${i}`, "Tosse", ["tosse"], "MEDICAMENTOS")),
    prod("Xarope raro", "Tosse", [], "MEDICAMENTOS"),
  ];
  const cob = coberturaPorSubcategoria(produtos);
  const beleza = cob.find((c) => c.nivel2 === "Acessórios de Beleza")!;
  const tosse = cob.find((c) => c.nivel2 === "Tosse")!;
  check(beleza.total === 40 && beleza.comUtilizacao === 0 && beleza.percent === 0,
    "subcategoria sem utilização nenhuma tem 0%");
  check(tosse.total === 11 && Math.round(tosse.percent) === 91, `subcategoria coberta tem ~91% (${tosse.percent.toFixed(1)})`);

  const ex2 = subcategoriasExcluiveis(cob, 2, 30);
  check(ex2.has("COSMÉTICA > Acessórios de Beleza"), "com pop>=30 e <2%, Acessórios de Beleza é excluível");
  check(!ex2.has("MEDICAMENTOS > Tosse"), "Tosse não é excluível");
  const exPop = subcategoriasExcluiveis(cob, 2, 100);
  check(exPop.size === 0, "população mínima alta desqualifica — 40 produtos não são amostra para 100");
  const ex1 = subcategoriasExcluiveis(cob, 1, 30);
  check(ex1.has("COSMÉTICA > Acessórios de Beleza"), "e a 1% continua excluível (está a 0%)");
}

console.log("\n=== nomes opacos ===");
{
  for (const s of ["00", "5109400", "000", "X1", "  "]) check(nomeOpaco(s), `"${s}" é opaco`);
  for (const s of ["Ben-u-ron 500mg", "OCULOS SOL JUNIOR", "shield mask"]) check(!nomeOpaco(s), `"${s}" NÃO é opaco`);
}

console.log("\n=== custos observados ===");
{
  check(CUSTO_POR_PRODUTO.OUTROS_MEDICAMENTOS === 0.0131, "OUTROS_MEDICAMENTOS $0.0131/prod");
  check(CUSTO_POR_PRODUTO.NAO_CLASSIFICADO === 0.0067, "NAO_CLASSIFICADO $0.0067/prod");
  check(CUSTO_POR_PRODUTO.SEM_UTILIZACOES === 0.0057, "SEM_UTILIZACOES $0.0057/prod");
}

console.log("\n=== o auditor é read-only e não chama o modelo ===");
{
  const src = readFileSync(
    new URL("../catalog-master/audit-knowledge-preselection.ts", import.meta.url),
    "utf8",
  );
  const codigo = src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
  check(/default_transaction_read_only = on/.test(codigo), "abre a sessão em READ ONLY");
  check(!/default_transaction_read_only = off/.test(codigo), "…e não tem caminho que a desligue");
  check(!/--apply/.test(codigo), "não tem --apply");
  check(!/\b(insert|update|delete)\s+into|\bupdate\s+"/i.test(codigo), "nenhum INSERT/UPDATE/DELETE");
  check(!/classificarLote|classificarUtilizacoesLote|Anthropic/.test(codigo), "não chama o modelo");
  check(/resolverAlvo\s*\(/.test(codigo) && /connectionString:\s*alvo\.url/.test(codigo),
    "resolve o destino por target-db");
  check(/corpoResidual\(\)/.test(codigo),
    "usa a definição de residual do runner — uma segunda definição podia divergir");
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail === 0 ? 0 : 1);
