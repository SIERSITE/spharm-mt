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
  FATOR_CONFIANCA_PROPAGADA,
  LIMIAR_COBERTURA_PERCENT,
  POPULACAO_MINIMA_SUBCATEGORIA,
  preselecionar,
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
/** Sufixo alfabético: mantém cada produto numa família própria. */
const nomeAlfa = (i: number) => `${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + (i % 26))}`;
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

console.log("\n=== partição do residual ===");
{
  const contexto = [
    // Família de 3 sem conflito, toda no residual.
    prod("Pregabalina Zentiva 25 mg 14 caps", "Outros Medicamentos"),
    prod("Pregabalina Zentiva 75 mg 56 caps", "Outros Medicamentos"),
    prod("Pregabalina Zentiva 150 mg 56 caps", "Outros Medicamentos"),
    // Família em conflito.
    prod("Lyrica 25 mg", "Sistema Nervoso"),
    prod("Lyrica 75 mg", "Dor"),
    prod("Lyrica 150 mg", "Outros Medicamentos"),
    // Sozinho.
    prod("Edarbi 20 mg 14 comp", "Outros Medicamentos"),
    // Opaco.
    prod("00", "Outros Medicamentos"),
  ];
  const residual = contexto.map((p) => ({ cnp: p.cnp, estrato: "OUTROS_MEDICAMENTOS" }));
  const pre = preselecionar(residual, contexto);

  const destinos = (cnps: number[]) => cnps.map((c) => pre.get(c)!.destino);
  const preg = contexto.slice(0, 3).map((p) => p.cnp);
  check(destinos(preg).filter((d) => d === "REPRESENTANTE").length === 1, "família sem conflito tem UM representante");
  check(destinos(preg).filter((d) => d === "PROPAGAR").length === 2, "…e os outros dois propagam");
  check(pre.get(preg[1]!)!.representanteCnp === preg[0]!, "o representante é o cnp mais baixo (determinístico)");

  const lyrica = contexto.slice(3, 6).map((p) => p.cnp);
  check(
    destinos(lyrica).every((d) => d === "ENVIAR"),
    "família EM CONFLITO não propaga — os três vão sozinhos ao modelo",
    destinos(lyrica).join(","),
  );
  check(pre.get(lyrica[0]!)!.motivo.includes("conflito"), "…e o motivo di-lo");

  check(pre.get(contexto[6]!.cnp)!.destino === "ENVIAR", "produto sem irmãos vai sozinho");
  check(pre.get(contexto[7]!.cnp)!.destino === "EXCLUIR_OPACO", "nome opaco é excluído antes de tudo");
}
{
  // Exclusão por baixa cobertura: só em SEM_UTILIZACOES.
  const contexto = [
    ...Array.from({ length: 40 }, (_, i) => prod(`Alicate modelo ${nomeAlfa(i)}`, "Acessórios de Beleza", [], "COSMÉTICA")),
  ];
  const residual = contexto.map((p) => ({ cnp: p.cnp, estrato: "SEM_UTILIZACOES" }));
  const pre = preselecionar(residual, contexto);
  const excluidos = [...pre.values()].filter((x) => x.destino === "EXCLUIR_BAIXA_COBERTURA").length;
  check(excluidos === 40, `os 40 de uma subcategoria a 0% são excluídos (${excluidos})`);

  // O MESMO produto noutro estrato NÃO é excluído por esta regra: a
  // pergunta lá não é sobre utilizações.
  const residualOutro = contexto.map((p) => ({ cnp: p.cnp, estrato: "OUTROS_MEDICAMENTOS" }));
  const pre2 = preselecionar(residualOutro, contexto);
  check(
    [...pre2.values()].every((x) => x.destino !== "EXCLUIR_BAIXA_COBERTURA"),
    "a exclusão por baixa cobertura NÃO se aplica fora de SEM_UTILIZACOES",
  );
}
{
  // População insuficiente: 10 produtos a 0% não autorizam exclusão.
  const contexto = Array.from({ length: 10 }, (_, i) => prod(`Coisa rara ${nomeAlfa(i)}`, "Homeopatia", [], "SAÚDE NATURAL"));
  const residual = contexto.map((p) => ({ cnp: p.cnp, estrato: "SEM_UTILIZACOES" }));
  const pre = preselecionar(residual, contexto);
  check(
    [...pre.values()].every((x) => x.destino !== "EXCLUIR_BAIXA_COBERTURA"),
    `abaixo de ${POPULACAO_MINIMA_SUBCATEGORIA} produtos a percentagem não decide nada`,
  );
}
{
  check(LIMIAR_COBERTURA_PERCENT === 2, "o limiar é 2% — não 5%");
  check(POPULACAO_MINIMA_SUBCATEGORIA === 30, "a população mínima é 30");
  check(FATOR_CONFIANCA_PROPAGADA < 1, "a confiança propagada é ESTRITAMENTE menor que a original");
}

console.log("\n=== o runner não propaga através de conflitos ===");
{
  // Guarda sobre o código: a propagação parte de `dependentes`, que só é
  // preenchido pelo destino PROPAGAR — e `preselecionar` nunca o atribui
  // a uma família com conflito.
  const runner = readFileSync(
    new URL("../../lib/catalog/knowledge-enrichment-runner.ts", import.meta.url),
    "utf8",
  );
  check(/case "PROPAGAR"/.test(runner), "o runner só enfileira dependentes no destino PROPAGAR");
  check(
    /if \(gate\.decisao === "APPLY"\)[\s\S]{0,400}dependentes\.get\(r\.cnp\)/.test(runner),
    "a propagação só corre depois de o representante ser APPLY",
  );
  check(
    /FONTE_PROPAGADA/.test(runner) && /MODEL_PROPAGATED/.test(runner),
    "a proveniência do valor propagado é distinta na escrita",
  );
  check(
    /FATOR_CONFIANCA_PROPAGADA/.test(runner),
    "a confiança propagada passa pelo factor de redução",
  );
  // As exclusões não podem tocar em escrita: são contadas e vão para o
  // relatório, e o `switch` que as trata não chama `escrever`.
  const bloco = runner.slice(runner.indexOf('case "EXCLUIR_OPACO"'), runner.indexOf("resumo.familiasPropagaveis"));
  check(!/escrever\(|executeRawUnsafe/.test(bloco), "o ramo das exclusões não escreve nada");
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
