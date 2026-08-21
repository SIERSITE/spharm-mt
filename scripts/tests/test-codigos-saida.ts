/**
 * scripts/tests/test-codigos-saida.ts
 *
 * O número que o encadeamento de lotes usa para decidir se continua.
 *
 * ─────────────────────────────────────────────────────────────────────
 * O DEFEITO QUE ISTO GUARDA
 *
 * O relatório do `catalog:knowledge-enrich` não imprimia `avisos` nem
 * `falhaInfraestrutura`, e o CLI saía com 0 em qualquer dos casos. Uma
 * corrida parada por saldo esgotado, credencial inválida ou 429
 * persistente era indistinguível de "já não havia trabalho": relatório
 * curto, código 0, fila intacta.
 *
 * À mão isso é um incómodo. Num encadeamento automático de lotes é o
 * pior caso possível: o lote seguinte arranca, falha da mesma maneira, e
 * a série inteira passa em branco — até ao tecto de custo, ou até alguém
 * reparar. O `backlog-knowledge.sh` decide continuar a partir deste
 * número, e por isso ele tem de ser exercitável sem base de dados e sem
 * chave da API.
 *
 * Uso: npx tsx scripts/tests/test-codigos-saida.ts
 */
import { SAIDA, codigoDeSaida } from "../../lib/catalog/knowledge-enrich-saida";
import { runKnowledgeEnrichment } from "../../lib/catalog/knowledge-enrichment-runner";
import { FalhaInfraestrutura, classificarFalhaInfra } from "../../lib/catalog/knowledge-enrichment";

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

// ─────────────────────────────────────────────────────────────────────
console.log("\n=== o contrato dos quatro códigos ===");
{
  check(SAIDA.OK === 0, "0 = correu e fechou");
  check(SAIDA.USO === 1, "1 = uso/ambiente");
  check(SAIDA.RECONCILIACAO === 2, "2 = reconciliação não fechou");
  check(SAIDA.INFRAESTRUTURA === 3, "3 = infraestrutura");
  check(
    new Set(Object.values(SAIDA)).size === Object.values(SAIDA).length,
    "…e são todos distintos — dois códigos iguais tornariam a decisão ambígua",
  );
}

console.log("\n=== a tabela de decisão ===");
{
  check(
    codigoDeSaida({ falhaInfraestrutura: false, semDestino: false }) === 0,
    "sucesso → 0",
  );
  check(
    codigoDeSaida({ falhaInfraestrutura: false, semDestino: true }) === 2,
    "reconciliação não fecha → 2",
  );
  check(
    codigoDeSaida({ falhaInfraestrutura: true, semDestino: false }) === 3,
    "falha de infraestrutura → 3",
  );
  // A ORDEM, e é o caso que importa. Quando a corrida é cortada a meio
  // por falta de saldo, a reconciliação também não fecha — mas a causa é
  // a primeira. Dizer "reconciliação não fechou" a quem ficou sem saldo
  // manda-o procurar um defeito que não existe.
  check(
    codigoDeSaida({ falhaInfraestrutura: true, semDestino: true }) === 3,
    "as duas ao mesmo tempo → 3: a infraestrutura é a causa, a contabilidade é o sintoma",
  );
}

console.log("\n=== saldo esgotado é classificado como infraestrutura ===");
{
  // O caminho real: o SDK levanta um 400 com "credit balance", o
  // `classificarFalhaInfra` reconhece-o, e o runner marca a corrida.
  const erroSaldo = Object.assign(new Error("Your credit balance is too low to access the API"), {
    status: 400,
  });
  const f = classificarFalhaInfra(erroSaldo);
  check(f instanceof FalhaInfraestrutura, "saldo esgotado é FalhaInfraestrutura", String(f));
  check(f?.categoria === "SALDO", `…da categoria SALDO (${f?.categoria})`);
  check(
    codigoDeSaida({ falhaInfraestrutura: !!f, semDestino: false }) === SAIDA.INFRAESTRUTURA,
    "…e leva o CLI ao código 3",
  );

  for (const [rotulo, err] of [
    ["autenticação", Object.assign(new Error("invalid x-api-key"), { status: 401 })],
    ["rate limit", Object.assign(new Error("rate limit"), { status: 429 })],
    ["serviço indisponível", Object.assign(new Error("overloaded"), { status: 529 })],
  ] as const) {
    const c = classificarFalhaInfra(err);
    check(c instanceof FalhaInfraestrutura, `${rotulo} também é infraestrutura`, String(c));
  }

  // E o contraste: um erro do PRODUTO não é infraestrutura. Se fosse, uma
  // designação que o modelo não percebe parava a série inteira.
  const produto = classificarFalhaInfra(new Error("não consegui classificar este produto"));
  check(produto === null, "um erro de produto NÃO é infraestrutura — a série continua");
}

// Este ficheiro compila para CommonJS: sem top-level await.
async function main(): Promise<void> {
  console.log("\n=== ponta-a-ponta: saldo esgotado no runner ===");
  {
    // O runner corre com um duplo que rebenta com o erro de saldo. O que
    // se verifica é o que o CLI leria a seguir: falha marcada, fila
    // intacta, e o código de saída em 3.
    const residual = [
      {
        cnp: 2_000_001,
        designacao: "Zetaaa",
        productType: null,
        categoriaAtual: null,
        subcategoriaAtual: null,
        estrato: "NAO_CLASSIFICADO",
      },
    ];
    const sqls: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prisma: any = {
      $queryRawUnsafe: async (sql: string) => {
        if (/as nivel1/i.test(sql)) {
          return residual.map((r) => ({
            cnp: r.cnp,
            designacao: r.designacao,
            nivel1: null,
            nivel2: null,
            utilizacoes: [] as string[],
          }));
        }
        if (/from "Classificacao"/i.test(sql)) return [];
        if (/from "Utilizacao"/i.test(sql)) return [];
        if (/information_schema\.columns/i.test(sql)) return [{ n: 2 }];
        if (/count\(/i.test(sql)) return [{ n: residual.length }];
        return residual;
      },
      $executeRawUnsafe: async (sql: string) => {
        sqls.push(sql.replace(/\s+/g, " "));
        return 1;
      },
      knowledgeEnrichmentCache: { upsert: async () => ({}) },
      enriquecimentoFila: { updateMany: async () => ({ count: 0 }) },
    };

    const r = await runKnowledgeEnrichment(prisma, {
      dryRun: false,
      usarGlobal: false,
      limite: 10,
      classificar: async () => {
        throw Object.assign(new Error("Your credit balance is too low"), { status: 400 });
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      verificar: (async () => ({ resultados: [], usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } })) as any,
      promover: async () => {
        throw new Error("não devia promover nada");
      },
    });

    check(r.falhaInfraestrutura !== null, "o runner marcou falha de infraestrutura", JSON.stringify(r.falhaInfraestrutura));
    check(r.falhaInfraestrutura?.categoria === "SALDO", `…categoria SALDO (${r.falhaInfraestrutura?.categoria})`);
    check(
      !sqls.some((s) => /update "EnriquecimentoFila"/.test(s)),
      "…e a FILA não foi tocada: nenhum produto gastou tentativa",
      sqls.join(" | "),
    );
    check(
      r.avisos.some((a) => a.includes("fila NÃO alterada")),
      "…com aviso a dizê-lo, para o relatório o poder imprimir",
      r.avisos.join(" | "),
    );
    check(
      codigoDeSaida({ falhaInfraestrutura: r.falhaInfraestrutura !== null, semDestino: false }) === 3,
      "…e o CLI sairia com 3, que é o que pára a série",
    );
  }

  console.log("\n=== o CLI imprime mesmo as duas secções ===");
  {
    // Um teste sobre o texto do relatório, porque é dele que o
    // `backlog-knowledge.sh` lê. Se o CLI deixar de imprimir isto, o
    // script deixa de conseguir distinguir uma paragem de um fim.
    const { readFileSync } = await import("node:fs");
    const cli = readFileSync("scripts/catalog-master/knowledge-enrich.ts", "utf8");
    check(cli.includes("── avisos"), "o relatório tem secção de avisos");
    check(cli.includes("── FALHA DE INFRAESTRUTURA"), "…e secção de falha de infraestrutura");
    check(cli.includes("r.falhaInfraestrutura.categoria"), "…que imprime a categoria");
    check(cli.includes("A fila NÃO foi tocada"), "…e diz que a fila ficou intacta");
    check(
      cli.includes("codigoDeSaida({") && cli.includes("process.exit(saida)"),
      "…e a saída passa por `codigoDeSaida`, que é o que está testado acima",
    );
  }
}

main().then(() => {
  console.log(`\n${pass} ok, ${fail} falhas`);
  process.exit(fail === 0 ? 0 : 1);
});
