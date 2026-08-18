/**
 * scripts/tests/test-filtros-catalogo.ts
 *
 * Fixa o filtro de catálogo dos relatórios operacionais.
 *
 * ── O DEFEITO QUE ISTO IMPEDE DE VOLTAR ──────────────────────────────
 *
 * Em Excessos, Transferências e Encomendas, o campo chamado `categoria`
 * recebia `resolveCategoria(...).grupo` — o NÍVEL 2 — e o dropdown
 * listava nomes de NÍVEL 1. A comparação é literal, portanto só acertava
 * em produtos SEM nível 2, onde o `grupo` cai para o nível 1.
 *
 * Ninguém reparava porque o filtro devolvia linhas — só que as erradas, e
 * cada vez menos: à medida que o enriquecimento preenche o nível 2, mais
 * produtos saem do alcance do filtro. Um teste que só verificasse "o
 * filtro devolve alguma coisa" teria passado durante meses.
 *
 * Sem base de dados e sem rede.
 *
 * Uso: npx tsx scripts/tests/test-filtros-catalogo.ts
 */
import { readFileSync } from "node:fs";
import { passaFiltroCatalogo, type LinhaClassificavel } from "../../lib/reporting/filters-shared";
import {
  resolverPar,
  resolveCategoria,
  SEM_CLASSIFICACAO_LABEL,
} from "../../lib/categoria-resolver";

let pass = 0;
let fail = 0;
const ok = (l: string) => { pass++; console.log(`  [OK]    ${l}`); };
const bad = (l: string, d?: string) => { fail++; console.log(`  [FALHA] ${l}${d ? `\n            ${d}` : ""}`); };
const check = (c: boolean, l: string, d?: string) => (c ? ok(l) : bad(l, d));

const linha = (over: Partial<LinhaClassificavel> = {}): LinhaClassificavel => ({
  categoria: "MEDICAMENTOS",
  subcategoria: "Cardiovascular",
  utilizacoes: ["tensao-arterial"],
  ...over,
});

console.log("=== resolverPar: cada nível com o nome que tem ===");
{
  const p = resolverPar({
    classificacaoNivel1: { nome: "MEDICAMENTOS" },
    classificacaoNivel2: { nome: "Cardiovascular" },
  });
  check(p.categoria === "MEDICAMENTOS", "categoria é o NÍVEL 1", p.categoria);
  check(p.subcategoria === "Cardiovascular", "subcategoria é o NÍVEL 2", p.subcategoria);
}
{
  // O caso que o defeito escondia: `grupo` cai para o nível 1 e ficava
  // num campo chamado `categoria`, comparado com uma lista de nível 1 —
  // por isso ESTES produtos, e só estes, continuavam a filtrar bem.
  const r = resolveCategoria({ classificacaoNivel1: { nome: "MEDICAMENTOS" } });
  check(r.grupo === "MEDICAMENTOS", "resolveCategoria: sem N2, `grupo` cai para o N1");
  const p = resolverPar({ classificacaoNivel1: { nome: "MEDICAMENTOS" } });
  check(p.categoria === "MEDICAMENTOS", "resolverPar: categoria continua o N1");
  check(p.subcategoria === "", "…e a subcategoria fica VAZIA, não repete o N1", p.subcategoria);
}
{
  const p = resolverPar({});
  check(p.categoria === SEM_CLASSIFICACAO_LABEL, "sem classificação: categoria é o rótulo de UI");
  check(
    p.subcategoria === "",
    "…e a subcategoria é vazia — 'Por Classificar' numa subcategoria seria uma opção que não corresponde a nada",
  );
}

console.log("\n=== Categoria filtra por N1, Subcategoria por N2 ===");
{
  const l = linha();
  check(passaFiltroCatalogo(l, { categorias: ["MEDICAMENTOS"] }), "N1=MEDICAMENTOS passa o filtro de Categoria");
  check(
    !passaFiltroCatalogo(l, { categorias: ["Cardiovascular"] }),
    "…e o NOME DO N2 no filtro de Categoria NÃO passa — era isto que estava trocado",
  );
  check(
    passaFiltroCatalogo(l, { subcategorias: ["Cardiovascular"] }),
    "N2=Cardiovascular passa o filtro de Subcategoria",
  );
  check(
    !passaFiltroCatalogo(l, { subcategorias: ["MEDICAMENTOS"] }),
    "…e o nome do N1 no filtro de Subcategoria não passa",
  );
}
{
  // Sem regressão para quem não tem N2: continua a aparecer enquanto
  // ninguém filtrar por subcategoria.
  const semN2 = linha({ subcategoria: "" });
  check(passaFiltroCatalogo(semN2, { categorias: ["MEDICAMENTOS"] }), "produto sem N2 continua a passar por Categoria");
  check(passaFiltroCatalogo(semN2, {}), "…e sem filtro nenhum, passa");
  check(
    !passaFiltroCatalogo(semN2, { subcategorias: ["Cardiovascular"] }),
    "…mas não aparece quando se pede uma subcategoria concreta",
  );
}

console.log("\n=== filtro de Utilização ===");
{
  const uma = linha({ utilizacoes: ["tosse"] });
  check(passaFiltroCatalogo(uma, { utilizacoes: ["tosse"] }), "produto com UMA utilização é encontrado");
  check(!passaFiltroCatalogo(uma, { utilizacoes: ["diabetes"] }), "…e não aparece noutra");
}
{
  // OU entre utilizações: um xarope que serve para tosse e para
  // constipação tem de aparecer nas duas pesquisas.
  const varias = linha({ utilizacoes: ["tosse", "constipacao-e-gripe", "dor-e-febre"] });
  check(passaFiltroCatalogo(varias, { utilizacoes: ["tosse"] }), "produto com VÁRIAS aparece por uma delas");
  check(passaFiltroCatalogo(varias, { utilizacoes: ["dor-e-febre"] }), "…e por outra");
  check(
    passaFiltroCatalogo(varias, { utilizacoes: ["diabetes", "tosse"] }),
    "…e basta corresponder a QUALQUER uma das escolhidas (OU, não E)",
  );
  check(!passaFiltroCatalogo(varias, { utilizacoes: ["diabetes"] }), "…mas não a uma que não tem");
}
{
  const sem = linha({ utilizacoes: [] });
  check(passaFiltroCatalogo(sem, {}), "produto sem utilizações passa quando ninguém filtra por elas");
  check(!passaFiltroCatalogo(sem, { utilizacoes: ["tosse"] }), "…e não passa quando se pede uma");
}

console.log("\n=== combinações ===");
{
  const l = linha({
    categoria: "MEDICAMENTOS",
    subcategoria: "Cardiovascular",
    utilizacoes: ["tensao-arterial", "colesterol"],
  });
  check(
    passaFiltroCatalogo(l, {
      categorias: ["MEDICAMENTOS"],
      subcategorias: ["Cardiovascular"],
      utilizacoes: ["tensao-arterial"],
    }),
    "Categoria + Subcategoria + Utilização, todas a bater",
  );
  // E lógico entre eixos: falhar UM chega para excluir.
  check(
    !passaFiltroCatalogo(l, { categorias: ["MEDICAMENTOS"], subcategorias: ["Diabetes"] }),
    "categoria certa + subcategoria errada → não passa",
  );
  check(
    !passaFiltroCatalogo(l, { categorias: ["COSMÉTICA"], subcategorias: ["Cardiovascular"] }),
    "categoria errada + subcategoria certa → não passa",
  );
  check(
    !passaFiltroCatalogo(l, {
      categorias: ["MEDICAMENTOS"],
      subcategorias: ["Cardiovascular"],
      utilizacoes: ["tosse"],
    }),
    "classificação certa + utilização errada → não passa",
  );
}
{
  // Selecção vazia nunca filtra — nem `[]` nem `undefined`.
  const l = linha();
  check(passaFiltroCatalogo(l, { categorias: [], subcategorias: [], utilizacoes: [] }), "arrays vazios não filtram");
  check(passaFiltroCatalogo(l, {}), "filtros ausentes não filtram");
}
{
  // Linha sem classificação nenhuma: passa quando ninguém filtra, e não
  // passa um filtro concreto por acidente.
  //
  // O TIPO já não deixa passar uma linha à qual falte um dos três campos
  // — era `Partial<>` e permitia que um cliente com cópia local do tipo
  // da linha compilasse sem eles, filtrando tudo para fora em silêncio.
  const vazia = { categoria: "", subcategoria: "", utilizacoes: [] };
  check(passaFiltroCatalogo(vazia, {}), "linha sem classificação e sem filtros: passa");
  check(!passaFiltroCatalogo(vazia, { categorias: ["MEDICAMENTOS"] }), "…e não passa um filtro concreto");
}

console.log("\n=== os loaders não fazem N+1 ===");
{
  // Asserção sobre o CÓDIGO porque é aí que está o risco: uma consulta
  // dentro do laço que percorre produtos nunca falha um teste de
  // unidade — falha na VPS, com 27.602 produtos.
  const LOADERS = [
    "../../lib/transferencias-data.ts",
    "../../lib/encomendas-data.ts",
    "../../lib/vendas-data.ts",
    "../../lib/stock-data.ts",
    "../../lib/catalogo-data.ts",
  ];
  for (const caminho of LOADERS) {
    const nome = caminho.split("/").pop()!;
    const src = readFileSync(new URL(caminho, import.meta.url), "utf8");
    const codigo = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join("\n");

    // Um `await prisma.` dentro do CORPO de um `for`/`forEach`. O corpo
    // delimita-se por contagem de chavetas — uma janela de N caracteres
    // apanhava o que vinha depois do laço e acusava toda a gente.
    const inicios = [...codigo.matchAll(/\bfor\s*\(|\.forEach\s*\(|\.map\s*\(\s*async/g)];
    const dentroDeLaco: string[] = [];
    for (const m of inicios) {
      const abre = codigo.indexOf("{", m.index ?? 0);
      if (abre === -1) continue;
      let nivel = 0;
      let fim = abre;
      for (let i = abre; i < codigo.length; i++) {
        if (codigo[i] === "{") nivel++;
        else if (codigo[i] === "}") {
          nivel--;
          if (nivel === 0) { fim = i; break; }
        }
      }
      const corpo = codigo.slice(abre, fim);
      if (/await\s+(prisma|controlPrisma)\./.test(corpo)) {
        dentroDeLaco.push(codigo.slice(m.index ?? 0, (m.index ?? 0) + 60).split("\n")[0]!);
      }
    }
    check(
      dentroDeLaco.length === 0,
      `${nome} não consulta a base dentro de um laço`,
      dentroDeLaco.join(" | "),
    );
  }
}

console.log("\n=== determinismo ===");
{
  const l = linha();
  const f = { categorias: ["MEDICAMENTOS"], subcategorias: ["Cardiovascular"], utilizacoes: ["tensao-arterial"] };
  check(passaFiltroCatalogo(l, f) === passaFiltroCatalogo(l, f), "passaFiltroCatalogo é puro");
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail === 0 ? 0 : 1);
