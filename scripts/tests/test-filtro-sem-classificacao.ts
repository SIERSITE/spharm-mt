/**
 * scripts/tests/test-filtro-sem-classificacao.ts
 *
 * O toggle "Apenas produtos sem classificação" tem de significar
 * exactamente isso — produtos DE CATÁLOGO sem nível 1 — e tem de
 * significar o mesmo em todos os relatórios.
 *
 * ── O que isto existe para impedir ───────────────────────────────────
 *
 * Medido na Silveira: das 3 097 linhas que o Inventário mostrava com o
 * toggle ligado, 1 647 eram códigos internos do ERP — 1 122 dos 2 105 CNP
 * distintos. Mais de metade dos CNP que o filtro devolvia não eram um
 * problema de classificação: são taxas, serviços e atos clínicos, que
 * nunca poderiam ter nível 1.
 *
 * O `where` estava escrito TRÊS vezes, uma por loader, e faltava-lhe a
 * mesma condição nas três. Uma quarta cópia amanhã volta a faltar-lhe.
 * Por isso o teste verifica duas coisas distintas:
 *
 *   · o comportamento do helper central (secção A);
 *   · que nenhum loader tem cópia própria do `where` (secção B).
 *
 * A segunda é a que evita a regressão; a primeira é a que prova que o
 * helper faz o que diz.
 *
 * Corre com:  npm run test:filtro-sem-classificacao
 */
import { readFileSync } from "node:fs";
import { MIN_CNP_CATALOGAVEL } from "../../lib/catalog/cnp-catalogavel";
import { restringirSemClassificacao } from "../../lib/reporting/catalog-prefilter";
import type { PrismaClient } from "../../generated/prisma/client";

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

/**
 * Um Produto do universo de teste. Os CNP são escolhidos à volta da
 * fronteira de propósito: é aí que os erros de operador vivem.
 */
type P = {
  id: string;
  cnp: number;
  classificacaoNivel1Id: string | null;
  estado: string;
};

const UNIVERSO: P[] = [
  // ── catálogo, sem classificação: os que DEVEM aparecer ──────────
  { id: "cat-sem-1", cnp: 5_000_001, classificacaoNivel1Id: null, estado: "PENDENTE" },
  { id: "cat-sem-2", cnp: 7_300_053, classificacaoNivel1Id: null, estado: "NOVO" },
  // ── catálogo, classificado: não aparecem ────────────────────────
  { id: "cat-com-1", cnp: 5_000_002, classificacaoNivel1Id: "n1", estado: "PENDENTE" },
  // ── códigos internos sem classificação: NÃO devem aparecer ──────
  { id: "int-1", cnp: 12, classificacaoNivel1Id: null, estado: "PENDENTE" },
  { id: "int-2", cnp: 1_161_127, classificacaoNivel1Id: null, estado: "PENDENTE" },
  // A fronteira, dos dois lados. 2 000 000 é INTERNO — ver
  // lib/catalog/cnp-catalogavel.ts.
  { id: "fronteira-igual", cnp: MIN_CNP_CATALOGAVEL, classificacaoNivel1Id: null, estado: "PENDENTE" },
  { id: "fronteira-acima", cnp: MIN_CNP_CATALOGAVEL + 1, classificacaoNivel1Id: null, estado: "PENDENTE" },
  // ── inactivo: fora do universo, mesmo sendo catálogo sem N1 ─────
  { id: "inativo", cnp: 5_000_003, classificacaoNivel1Id: null, estado: "INATIVO" },
];

/**
 * Prisma falso que aplica o `where` que o helper monta.
 *
 * Interpreta o filtro em vez de o comparar a um literal: um teste que
 * comparasse o objecto passava com um `where` que o PostgreSQL rejeitaria,
 * e falharia por reordenação de campos que não muda nada.
 */
function prismaFalso(universo: P[] = UNIVERSO) {
  const visto: unknown[] = [];
  return {
    visto,
    prisma: {
      produto: {
        findMany: async (args: {
          where: {
            classificacaoNivel1Id?: null;
            estado?: { not?: string };
            cnp?: { gt?: number; lte?: number };
            id?: { in?: string[] };
          };
        }) => {
          visto.push(args.where);
          const w = args.where;
          return universo
            .filter((p) => (w.classificacaoNivel1Id === null ? p.classificacaoNivel1Id === null : true))
            .filter((p) => (w.estado?.not ? p.estado !== w.estado.not : true))
            .filter((p) => (w.cnp?.gt !== undefined ? p.cnp > w.cnp.gt : true))
            .filter((p) => (w.id?.in ? w.id.in.includes(p.id) : true))
            .map((p) => ({ id: p.id }));
        },
      },
    } as unknown as PrismaClient,
  };
}

// Este ficheiro compila para CommonJS: sem top-level await.
async function main(): Promise<void> {

// ══════════════════════════════════════════════════════════════════════
// A · O helper central
// ══════════════════════════════════════════════════════════════════════
console.log("\nA · restringirSemClassificacao");
{
  const { prisma, visto } = prismaFalso();
  const ids = await restringirSemClassificacao(prisma, null);

  check(
    ids.includes("cat-sem-1") && ids.includes("cat-sem-2"),
    "devolve os produtos de catálogo sem nível 1",
    ids.join(","),
  );
  check(!ids.includes("cat-com-1"), "não devolve produtos já classificados");
  check(
    !ids.includes("int-1") && !ids.includes("int-2"),
    "NÃO devolve códigos internos — era isto que contaminava os 3 097",
    ids.join(","),
  );
  check(!ids.includes("inativo"), "não devolve produtos INATIVO");

  // A fronteira: a mesma regra do resto do pipeline, e não uma cópia
  // com o operador trocado.
  check(
    !ids.includes("fronteira-igual"),
    `cnp = ${MIN_CNP_CATALOGAVEL} é interno — fica de fora`,
  );
  check(
    ids.includes("fronteira-acima"),
    `cnp = ${MIN_CNP_CATALOGAVEL + 1} é catálogo — entra`,
  );

  check(ids.length === 3, `três produtos no total (veio ${ids.length})`, ids.join(","));

  // O `where` usa a regra central e não um literal repetido.
  const w = visto[0] as { cnp?: { gt?: number } };
  check(
    w?.cnp?.gt === MIN_CNP_CATALOGAVEL,
    "o where usa a constante central, não um número escrito à mão",
    JSON.stringify(w),
  );
}

console.log("\nA2 · composição com um filtro anterior");
{
  // O helper recebe o resultado dos filtros que correram antes e tem de o
  // INTERSECTAR, nunca o substituir. Se o substituísse, escolher uma
  // categoria e ligar o toggle devolvia produtos de outra categoria.
  const { prisma } = prismaFalso();
  const ids = await restringirSemClassificacao(prisma, ["cat-sem-1", "int-1", "cat-com-1"]);
  check(
    ids.length === 1 && ids[0] === "cat-sem-1",
    "intersecta com a lista anterior em vez de a substituir",
    ids.join(","),
  );
}

console.log("\nA3 · universo vazio");
{
  const { prisma } = prismaFalso([]);
  const ids = await restringirSemClassificacao(prisma, null);
  // Lista vazia e NÃO null: `null` significa "sem restrição" e faria o
  // relatório devolver tudo — exactamente o contrário do pedido.
  check(Array.isArray(ids) && ids.length === 0, "devolve [] e nunca null quando não há nada");
}

// ══════════════════════════════════════════════════════════════════════
// B · Nenhum loader tem cópia própria do where
// ══════════════════════════════════════════════════════════════════════
console.log("\nB · os loaders usam o helper, e só o helper");
{
  const LOADERS = ["lib/inventario-data.ts", "lib/vendas-data.ts", "lib/margens-data.ts"];

  for (const f of LOADERS) {
    const t = readFileSync(f, "utf8");
    check(
      t.includes("restringirSemClassificacao(prisma, produtoIdFilter)"),
      `${f}: delega no helper`,
    );
    // A assinatura da cópia antiga: o `where` com `classificacaoNivel1Id`
    // literal dentro do bloco do filtro. Se voltar, é uma quarta cópia.
    const bloco = t.slice(t.indexOf("filters.apenasSemClassif"));
    check(
      !/classificacaoNivel1Id:\s*null/.test(bloco.slice(0, 600)),
      `${f}: já não tem where próprio para o filtro`,
      bloco.slice(0, 260),
    );
  }
}

// ══════════════════════════════════════════════════════════════════════
// C · O que a UI promete é o que o filtro faz
// ══════════════════════════════════════════════════════════════════════
console.log("\nC · o rótulo diz a verdade");
{
  const ui = readFileSync("components/reporting/report-filters-bar.tsx", "utf8");
  check(
    ui.includes("Apenas produtos sem classificação<"),
    "o rótulo é «Apenas produtos sem classificação»",
  );
  // A promessa antiga: "canónica" passou a ser um recorte diferente no dia
  // em que passou a existir PROVISORIA, e o rótulo prometia incluí-las.
  //
  // A verificação olha para o que é RENDERIZADO, não para o ficheiro: o
  // comentário que explica a mudança cita necessariamente o texto antigo,
  // e uma procura no ficheiro inteiro acusava-o como se fosse o rótulo.
  const rotulos = [...ui.matchAll(/<span>([^<]*)<\/span>/g)].map((m) => m[1]);
  check(
    !rotulos.some((r) => /sem classifica..o can.nica/i.test(r)),
    "…e nenhum rótulo visível diz «canónica» — seria uma promessa por cumprir",
    rotulos.join(" | "),
  );

  const rel = readFileSync("lib/reporting/adapters/inventario.ts", "utf8");
  check(
    rel.includes("exclui códigos internos"),
    "o relatório exportado declara o que o filtro excluiu",
  );
}

// ══════════════════════════════════════════════════════════════════════
console.log(`\n${ok} ok, ${ko} falhas`);
process.exit(ko === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
