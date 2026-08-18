/**
 * scripts/vendas/reaggregate.ts
 *
 * Reconstrói `VendaMensal` a partir do raw canónico. Nada mais.
 *
 * ── PORQUE EXISTE ────────────────────────────────────────────────────
 *
 * O rebuild histórico estava a ser feito com `daily-pipeline --date`, e
 * isso é errado por três razões:
 *
 *   · o `daily-pipeline` LÊ O ERP. Correr um mês de rebuild sobre a
 *     agregação obrigava a reler produtos, stock, vendas, compras,
 *     devoluções e movimentos desse dia — trabalho e risco que a
 *     reagregação não precisa.
 *   · escreve em sete sítios. Um rebuild da agregação não deve poder
 *     tocar em `Produto`, `ProdutoFarmacia` nem `MovimentoArtigo`.
 *   · corre na farmácia, contra o ERP. A reagregação é uma operação do
 *     lado do SaaS, sobre dados que já lá estão.
 *
 * Este comando faz UMA coisa: para cada mês do intervalo, reler
 * `IngestVendaLinhaRaw` e reescrever `VendaMensal`. O alcance da escrita
 * é o `DELETE` scoped por (ano, mês, farmácias presentes, origem) que
 * `writeAggregation` já faz — mais nada é tocado.
 *
 * ── SEGURANÇA ────────────────────────────────────────────────────────
 *
 * Dry-run por omissão. Sem `--apply` não escreve nada e imprime o que
 * mudaria, por mês e por farmácia. Um rebuild que escreve por omissão é
 * um rebuild que alguém corre por engano.
 *
 * Idempotente: `writeAggregation` faz DELETE scoped + INSERT em
 * transacção. Correr duas vezes o mesmo mês dá o mesmo resultado.
 *
 * ── USO ──────────────────────────────────────────────────────────────
 *
 *   npm run vendas:reaggregate -- --tenant=silveira --from=2024-01 --to=2026-08
 *   npm run vendas:reaggregate -- --tenant=silveira --from=2026-08 --to=2026-08 --apply
 */

import "dotenv/config";
import { parseArgs } from "node:util";
import {
  controlPrisma,
  getTenantBySlug,
  buildTenantConnectionString,
} from "@/lib/control-plane";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  aggregateMonth,
  parseMonth,
  AggregateAbortError,
  type MonthRange,
} from "@/lib/aggregate/vendamensal";

const RULE = "─".repeat(70);

/** Todos os meses de `de` até `ate`, inclusive. `YYYY-MM`. */
export function mesesEntre(de: string, ate: string): string[] {
  const a = parseMonth(de);
  const b = parseMonth(ate);
  const inicio = a.ano * 12 + a.mes;
  const fim = b.ano * 12 + b.mes;
  if (fim < inicio) {
    throw new Error(`--from (${de}) é posterior a --to (${ate}).`);
  }
  // Um intervalo absurdo é quase sempre um engano de escrita, e um
  // rebuild de 40 anos não é o que alguém queria pedir.
  if (fim - inicio > 120) {
    throw new Error(
      `intervalo de ${fim - inicio + 1} meses é demasiado largo (máx 121). ` +
        `Parte-o em pedaços.`,
    );
  }
  const out: string[] = [];
  for (let i = inicio; i <= fim; i++) {
    const ano = Math.floor((i - 1) / 12);
    const mes = ((i - 1) % 12) + 1;
    out.push(`${ano}-${String(mes).padStart(2, "0")}`);
  }
  return out;
}

function fmt(n: number): string {
  return n.toLocaleString("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      tenant: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      apply: { type: "boolean", default: false },
      "allow-unknowns": { type: "boolean", default: false },
      "allow-orphans": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help || !values.tenant || !values.from || !values.to) {
    console.log("Uso: vendas:reaggregate --tenant=<slug> --from=YYYY-MM --to=YYYY-MM [--apply]");
    console.log("");
    console.log("Reconstrói VendaMensal a partir de IngestVendaLinhaRaw.");
    console.log("NÃO lê o ERP. NÃO toca em produtos, stock nem movimentos.");
    console.log("");
    console.log("  --apply             escreve. Sem isto é dry-run.");
    console.log("  --allow-unknowns    não aborta com linhas por classificar");
    console.log("  --allow-orphans     não aborta com órfãos operacionais");
    return values.help ? 0 : 1;
  }

  const meses = mesesEntre(values.from, values.to);
  const modo = values.apply ? "APPLY (escreve)" : "DRY-RUN (não escreve)";

  console.log(RULE);
  console.log(`vendas:reaggregate — ${modo}`);
  console.log(RULE);
  console.log(`tenant : ${values.tenant}`);
  console.log(`meses  : ${meses[0]} .. ${meses[meses.length - 1]}  (${meses.length})`);
  console.log("");

  const tenant = await getTenantBySlug(values.tenant);
  if (!tenant) {
    console.error(`✗ tenant "${values.tenant}" não existe no control plane.`);
    return 1;
  }
  const url = await buildTenantConnectionString(tenant);
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

  let totalInseridas = 0;
  let totalApagadas = 0;
  let mesesComErro = 0;

  try {
    for (const mes of meses) {
      let range: MonthRange;
      try {
        range = parseMonth(mes);
      } catch (err) {
        console.error(`✗ ${mes}: ${err instanceof Error ? err.message : String(err)}`);
        mesesComErro++;
        continue;
      }

      try {
        const r = await aggregateMonth(prisma, {
          range,
          write: values.apply === true,
          allowUnknowns: values["allow-unknowns"] === true,
          allowOrphans: values["allow-orphans"] === true,
        });

        // Por farmácia, porque um grupo esconde uma farmácia parada.
        const porFarmacia = new Map<string, { qtd: number; valor: number; linhas: number }>();
        for (const row of r.aggRows) {
          const acc = porFarmacia.get(row.farmaciaId) ?? { qtd: 0, valor: 0, linhas: 0 };
          acc.qtd += row.quantidadeLiquida.toNumber();
          acc.valor += row.valorBruto.toNumber();
          acc.linhas += 1;
          porFarmacia.set(row.farmaciaId, acc);
        }
        const nomes = await prisma.farmacia.findMany({
          where: { id: { in: [...porFarmacia.keys()] } },
          select: { id: true, nome: true },
        });
        const nomePorId = new Map(nomes.map((f) => [f.id, f.nome]));

        console.log(
          `${mes}  raw=${r.preflight.rawLines}  produtos=${r.aggRows.length}  ` +
            `un=${fmt(r.totals.quantidadeLiquida)}  eur=${fmt(r.totals.valorBruto)}  ` +
            (values.apply
              ? `apagadas=${r.deleted} inseridas=${r.inserted}`
              : "(dry-run)"),
        );
        for (const [id, a] of porFarmacia) {
          console.log(
            `        ${(nomePorId.get(id) ?? id).padEnd(24)} ` +
              `produtos=${String(a.linhas).padStart(6)}  un=${fmt(a.qtd).padStart(12)}  eur=${fmt(a.valor).padStart(14)}`,
          );
        }
        if (r.preflight.unknowns > 0) {
          console.log(
            `        ⚠ ${r.preflight.unknowns} linha(s) por classificar — NÃO entram na soma`,
          );
        }
        totalInseridas += r.inserted;
        totalApagadas += r.deleted;
      } catch (err) {
        mesesComErro++;
        if (err instanceof AggregateAbortError) {
          console.error(`✗ ${mes}: ABORTADO (${err.code}) — ${err.message}`);
        } else {
          console.error(`✗ ${mes}: ${err instanceof Error ? err.message : String(err)}`);
        }
        // Continua: um mês que aborta não deve impedir os outros de
        // serem reconstruídos. O relatório final diz quantos falharam.
      }
    }
  } finally {
    await prisma.$disconnect();
    await controlPrisma.$disconnect();
  }

  console.log("");
  console.log(RULE);
  if (values.apply) {
    console.log(`Escrito: ${totalInseridas} linhas inseridas, ${totalApagadas} apagadas.`);
  } else {
    console.log("Dry-run: nada foi escrito. Repete com --apply.");
  }
  if (mesesComErro > 0) {
    console.log(`⚠ ${mesesComErro} mês(es) com erro — ver acima.`);
  }
  console.log(RULE);
  return mesesComErro > 0 ? 1 : 0;
}

main()
  .then((c) => process.exit(c))
  .catch((err) => {
    console.error("✗", err instanceof Error ? err.message : err);
    process.exit(1);
  });
