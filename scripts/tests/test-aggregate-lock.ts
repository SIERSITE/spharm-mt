/**
 * scripts/tests/test-aggregate-lock.ts
 *
 * O advisory lock da agregação mensal de vendas.
 *
 * ─────────────────────────────────────────────────────────────────────
 * O DEFEITO QUE ISTO GUARDA, MEDIDO EM PRODUÇÃO
 *
 * Em 2026-08-31 02:01 o `aggregate-month` devolveu HTTP 500 ao agent da
 * Farmácia Segurado:
 *
 *   Unique constraint failed on the fields:
 *     (farmaciaId, produtoId, ano, mes, naturezaVenda)
 *
 * O endpoint agrega o tenant inteiro e cada agent on-prem chama-o no fim
 * do seu pipeline. Dois PCs, ambos às 03:00, e as chamadas
 * sobrepuseram-se por 550 ms. O agent que apanhou o 500 abortou a
 * execução, e os dias que ainda não tinham sido enviados ficaram por
 * carregar — dois dias de vendas em falta.
 *
 * `aggregate-compras` e `aggregate-devolucoes` já se protegiam com
 * `pg_try_advisory_xact_lock`. A das vendas era a única sem lock, e era
 * a única que falhava.
 *
 * ─────────────────────────────────────────────────────────────────────
 * O QUE ESTE FICHEIRO EXERCITA — E O QUE NÃO EXERCITA
 *
 * Exercita a `writeAggregation` REAL, importada do módulo, contra um
 * duplo de Prisma que modela três coisas do Postgres:
 *
 *   · advisory locks de transacção — exclusivos, soltos no fim;
 *   · o índice único (farmaciaId, produtoId, ano, mes, naturezaVenda);
 *   · visibilidade READ COMMITTED — o DELETE de uma transacção não vê
 *     as linhas que outra inseriu e ainda não confirmou. É daqui que a
 *     colisão real nasce: B apaga contra um snapshot sem as linhas de
 *     A, e depois insere as mesmas chaves que A entretanto confirmou.
 *
 * NÃO exercita o Postgres. Não há base de dados nesta máquina, e um
 * duplo não prova semântica de motor — prova que ESTE código, sob estas
 * regras, se comporta como deve. O controlo negativo é o que dá valor
 * ao resto: a mesma bateria com o lock desligado TEM de falhar, e falha.
 *
 * Uso: npx tsx scripts/tests/test-aggregate-lock.ts
 */
import { readFileSync } from "node:fs";
import { Prisma } from "../../generated/prisma/client";
import type { PrismaClient } from "../../generated/prisma/client";
import { writeAggregation, type AggRow, type MonthRange } from "../../lib/aggregate/vendamensal";

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

const AGOSTO: MonthRange = {
  ano: 2026,
  mes: 8,
  fromInclusive: new Date(Date.UTC(2026, 7, 1)),
  toExclusive: new Date(Date.UTC(2026, 8, 1)),
};

function linha(farmacia: string, produto: string, valor: number): AggRow {
  return {
    farmaciaId: farmacia,
    produtoId: produto,
    naturezaVenda: "NORMAL",
    quantidadeLiquida: new Prisma.Decimal(1),
    valorBruto: new Prisma.Decimal(valor),
    valorPagoUtente: new Prisma.Decimal(valor),
    valorComparticipado: new Prisma.Decimal(0),
    linhasVenda: 1,
    atendimentos: 1,
  };
}

/** A chave do índice único. */
const chaveDe = (r: { farmaciaId: string; produtoId: string; ano: number; mes: number; naturezaVenda: string }) =>
  `${r.farmaciaId}|${r.produtoId}|${r.ano}|${r.mes}|${r.naturezaVenda}`;

type LinhaGravada = {
  farmaciaId: string; produtoId: string; ano: number; mes: number;
  naturezaVenda: string; origemAgregacao: string; valorBruto: unknown;
};

class ErroUnicidade extends Error {
  constructor(chave: string) {
    super(
      `Unique constraint failed on the fields: ("farmaciaId","produtoId",ano,mes,"naturezaVenda") [${chave}]`,
    );
  }
}

/**
 * Duplo de Prisma. `comLock=false` reproduz o código anterior à
 * correcção — é o controlo negativo.
 */
function criarPrismaFalso(opts: { comLock: boolean }) {
  const comprometidas: LinhaGravada[] = [];
  const locks = new Set<string>();
  let commits = 0;
  let tentativasLock = 0;
  let locksRecusados = 0;

  const prisma = {
    async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      const meusLocks: string[] = [];
      // Identidades que ESTA transacção decidiu apagar, capturadas no
      // momento do DELETE contra o que era visível então.
      let aApagar = new Set<LinhaGravada>();
      let aInserir: LinhaGravada[] = [];

      const tx = {
        async $queryRaw(sql: unknown): Promise<Array<{ ok: boolean }>> {
          tentativasLock++;
          const chave = String((sql as { values: unknown[] }).values[0]);
          if (!opts.comLock) return [{ ok: true }];
          if (locks.has(chave)) {
            locksRecusados++;
            return [{ ok: false }];
          }
          locks.add(chave);
          meusLocks.push(chave);
          return [{ ok: true }];
        },
        vendaMensal: {
          async deleteMany(args: {
            where: { ano: number; mes: number; farmaciaId: { in: string[] }; origemAgregacao: string };
          }): Promise<{ count: number }> {
            const w = args.where;
            const alvo = comprometidas.filter(
              (l) =>
                l.ano === w.ano && l.mes === w.mes &&
                w.farmaciaId.in.includes(l.farmaciaId) &&
                l.origemAgregacao === w.origemAgregacao,
            );
            aApagar = new Set(alvo);
            // Ponto de cedência: é aqui que a outra transacção corre.
            await new Promise((r) => setTimeout(r, 0));
            return { count: alvo.length };
          },
          async createMany(args: { data: LinhaGravada[] }): Promise<{ count: number }> {
            aInserir = args.data;
            return { count: args.data.length };
          },
        },
      };

      try {
        const out = await fn(tx);
        // COMMIT: aplica o que foi decidido e valida o índice único
        // contra o estado ENTRETANTO comprometido por outros.
        for (const l of aApagar) {
          const i = comprometidas.indexOf(l);
          if (i >= 0) comprometidas.splice(i, 1);
        }
        const existentes = new Set(comprometidas.map(chaveDe));
        for (const l of aInserir) {
          const k = chaveDe(l);
          if (existentes.has(k)) throw new ErroUnicidade(k);
          existentes.add(k);
          comprometidas.push(l);
        }
        commits++;
        return out;
      } finally {
        for (const k of meusLocks) locks.delete(k);
      }
    },
  } as unknown as PrismaClient;

  return {
    prisma,
    estado: () => comprometidas,
    metricas: () => ({ commits, tentativasLock, locksRecusados, locksActivos: locks.size }),
  };
}

async function main() {
  console.log("\n=== 1. duas execuções SIMULTÂNEAS não colidem ===");
  {
    const f = criarPrismaFalso({ comLock: true });
    const rows = [linha("farmA", "p1", 10), linha("farmB", "p2", 20)];

    const [a, b] = await Promise.all([
      writeAggregation(f.prisma, AGOSTO, rows),
      writeAggregation(f.prisma, AGOSTO, rows),
    ]);

    check(true, "nenhuma das duas atirou violação de unicidade");
    const m = f.metricas();
    check(m.commits === 2, "as duas transacções fecharam", `commits=${m.commits}`);
    check(m.locksRecusados >= 1, "uma delas foi recusada no lock e repetiu", `recusas=${m.locksRecusados}`);
    check(m.locksActivos === 0, "nenhum lock ficou por soltar", `activos=${m.locksActivos}`);
    check(
      f.estado().length === rows.length,
      "o estado final tem exactamente as linhas calculadas — sem duplicação",
      `linhas=${f.estado().length}`,
    );
    check(
      new Set(f.estado().map(chaveDe)).size === rows.length,
      "todas as chaves são distintas",
    );
    // A segunda apagou o que a primeira escreveu e reescreveu-o.
    check(a.inserted === 2 && b.inserted === 2, "ambas inseriram as 2 linhas", `a=${a.inserted} b=${b.inserted}`);
    check(a.deleted + b.deleted === 2, "no total apagaram-se as 2 da primeira", `${a.deleted}+${b.deleted}`);
  }

  console.log("\n=== 2. CONTROLO NEGATIVO: sem lock, colide ===");
  {
    const f = criarPrismaFalso({ comLock: false });
    const rows = [linha("farmA", "p1", 10), linha("farmB", "p2", 20)];

    let erro: unknown = null;
    try {
      await Promise.all([
        writeAggregation(f.prisma, AGOSTO, rows),
        writeAggregation(f.prisma, AGOSTO, rows),
      ]);
    } catch (e) {
      erro = e;
    }
    check(erro !== null, "sem lock, as duas simultâneas REBENTAM");
    check(
      erro instanceof ErroUnicidade,
      "…e o erro é o mesmo que produção viu: violação do índice único",
      erro instanceof Error ? erro.message.slice(0, 70) : String(erro),
    );
    // Sem isto, o teste 1 não valeria nada: provaria que o cenário não
    // colide, não que o lock o impede.
  }

  console.log("\n=== 3. reexecução SEQUENCIAL é idempotente ===");
  {
    const f = criarPrismaFalso({ comLock: true });
    const rows = [linha("farmA", "p1", 10), linha("farmA", "p2", 20), linha("farmB", "p3", 30)];

    const r1 = await writeAggregation(f.prisma, AGOSTO, rows);
    const depois1 = f.estado().map(chaveDe).sort();
    const r2 = await writeAggregation(f.prisma, AGOSTO, rows);
    const depois2 = f.estado().map(chaveDe).sort();
    const r3 = await writeAggregation(f.prisma, AGOSTO, rows);
    const depois3 = f.estado().map(chaveDe).sort();

    check(r1.deleted === 0 && r1.inserted === 3, "1ª corrida: 0 apagadas, 3 inseridas");
    check(r2.deleted === 3 && r2.inserted === 3, "2ª corrida: apaga as 3 e reescreve as 3");
    check(r3.deleted === 3 && r3.inserted === 3, "3ª corrida: igual");
    check(f.estado().length === 3, "o estado não cresce", `linhas=${f.estado().length}`);
    check(
      JSON.stringify(depois1) === JSON.stringify(depois2) &&
        JSON.stringify(depois2) === JSON.stringify(depois3),
      "o conjunto de chaves é idêntico nas três",
    );
    check(f.metricas().locksActivos === 0, "sem locks pendurados no fim");
  }

  console.log("\n=== 4. dias novos no MESMO mês entram sem duplicar ===");
  {
    const f = criarPrismaFalso({ comLock: true });
    // Primeira corrida: o mês até dia 28.
    const ate28 = [linha("farmA", "p1", 10), linha("farmA", "p2", 20)];
    await writeAggregation(f.prisma, AGOSTO, ate28);
    check(f.estado().length === 2, "mês parcial: 2 chaves");

    // Recuperação de 29 e 30: o mesmo mês, agora com mais produtos e
    // valores maiores nos que já existiam. É o caso real da Segurado.
    const mesInteiro = [
      linha("farmA", "p1", 15),
      linha("farmA", "p2", 25),
      linha("farmA", "p9", 8),
      linha("farmB", "p3", 30),
    ];
    const r = await writeAggregation(f.prisma, AGOSTO, mesInteiro);

    check(r.deleted === 2 && r.inserted === 4, "apaga as 2 antigas e escreve as 4 novas", `${r.deleted}/${r.inserted}`);
    check(f.estado().length === 4, "o estado final tem 4 chaves, não 6", `linhas=${f.estado().length}`);
    check(
      new Set(f.estado().map(chaveDe)).size === 4,
      "nenhuma chave repetida",
    );
    const p1 = f.estado().find((l) => l.produtoId === "p1");
    check(
      String(p1?.valorBruto) === "15",
      "o valor de p1 foi ACTUALIZADO, não somado nem mantido",
      `valorBruto=${String(p1?.valorBruto)}`,
    );
    check(
      f.estado().some((l) => l.produtoId === "p9"),
      "o produto novo dos dias recuperados está lá",
    );
  }

  console.log("\n=== 5. meses diferentes correm em paralelo ===");
  {
    // A chave do lock leva ano e mês: agregar Julho não deve esperar por
    // Agosto. Se a chave fosse constante, isto serializava tudo.
    const f = criarPrismaFalso({ comLock: true });
    const julho: MonthRange = { ...AGOSTO, mes: 7 };
    await Promise.all([
      writeAggregation(f.prisma, AGOSTO, [linha("farmA", "p1", 10)]),
      writeAggregation(f.prisma, julho, [linha("farmA", "p1", 10)]),
    ]);
    check(f.metricas().locksRecusados === 0, "nenhum lock foi recusado — chaves diferentes", `recusas=${f.metricas().locksRecusados}`);
    check(f.estado().length === 2, "as duas linhas coexistem (mês faz parte da chave)");
  }

  console.log("\n=== 6. o código tem a forma dos irmãos ===");
  {
    const src = readFileSync("lib/aggregate/vendamensal.ts", "utf8");
    const corpo = src.slice(src.indexOf("export async function writeAggregation"));

    check(/withRetry\(\(\) =>/.test(corpo), "withRetry envolve a transacção");
    check(
      /pg_try_advisory_xact_lock\(hashtextextended\(\$\{chaveLock\}, 0\)\)/.test(corpo),
      "usa pg_try_advisory_xact_lock com hashtextextended",
    );
    check(
      /const chaveLock = `aggregate-vendamensal:\$\{range\.ano\}-\$\{range\.mes\}`/.test(corpo),
      "a chave do lock é aggregate-vendamensal:<ano>-<mes>",
    );
    check(
      /if \(!lock\[0\]\?\.ok\) throw new Error\("acquire_lock failed \(retry\)"\)/.test(corpo),
      "recusa do lock atira `acquire_lock`, que o withRetry reconhece",
    );

    // Ordem: lock ANTES de qualquer escrita.
    const posLock = corpo.indexOf("pg_try_advisory_xact_lock");
    const posDelete = corpo.indexOf("deleteMany");
    const posInsert = corpo.indexOf("createMany");
    check(posLock < posDelete, "o lock vem antes do deleteMany");
    check(posDelete < posInsert, "o deleteMany vem antes do createMany");

    // Sem comentários: a nota que EXPLICA porque não se usa
    // `skipDuplicates` tem de poder nomeá-lo.
    const codigo = corpo.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    check(!/skipDuplicates/.test(codigo), "NÃO usa skipDuplicates");
    check(/tx\.vendaMensal\.deleteMany/.test(corpo), "mantém deleteMany");
    check(/tx\.vendaMensal\.createMany/.test(corpo), "mantém createMany");
    check(
      /maxWait: 15_000/.test(corpo) && /timeout: 120_000/.test(corpo),
      "mantém os timeouts da transacção",
    );

    // O mesmo padrão nos três ficheiros.
    for (const irmao of ["lib/aggregate/compras.ts", "lib/aggregate/devolucoes.ts"]) {
      const s = readFileSync(irmao, "utf8");
      check(
        /withRetry\(\(\) =>/.test(s) && /pg_try_advisory_xact_lock/.test(s) &&
          /acquire_lock failed \(retry\)/.test(s),
        `${irmao.split("/").pop()} usa o mesmo padrão`,
      );
    }

    // A semântica dos valores não foi tocada.
    const head = readFileSync("lib/aggregate/vendamensal.ts", "utf8");
    for (const marca of [
      "SQL_QUANTIDADE_ASSINADA",
      "SQL_VALOR_BRUTO_ASSINADO",
      "SQL_LINHAS_ELEGIVEIS",
      'origemAgregacao: ORIGEM_AGREGACAO',
      "quantidade: r.quantidadeLiquida",
      "valorTotal: r.valorBruto",
    ]) {
      check(head.includes(marca), `semântica intacta: ${marca}`);
    }
  }

  console.log("\n=== 7. `acquire_lock` é mesmo retentável ===");
  {
    const { withRetry } = await import("../../lib/aggregate/chunk-util");
    let n = 0;
    const r = await withRetry(async () => {
      n++;
      if (n < 3) throw new Error("acquire_lock failed (retry)");
      return "ok";
    }, { baseMs: 1 });
    check(r === "ok" && n === 3, "withRetry repete até passar", `tentativas=${n}`);

    // Controlo negativo: um erro que NÃO é transitório não é repetido.
    let m = 0;
    let propagou = false;
    try {
      await withRetry(async () => {
        m++;
        throw new Error("Unique constraint failed on the fields");
      }, { baseMs: 1 });
    } catch {
      propagou = true;
    }
    check(propagou && m === 1, "erro não-transitório propaga à primeira", `tentativas=${m}`);
  }

  console.log(`\n${pass} ok, ${fail} falhas`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
