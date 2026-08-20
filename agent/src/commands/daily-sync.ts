/**
 * agent/src/commands/daily-sync.ts
 *
 * Sync incremental de UM dia, pedido à mão. `--date` obrigatório.
 *
 * ── O QUE ESTE FICHEIRO DEIXOU DE TER ────────────────────────────────
 *
 * Tinha leitura própria. Um `SALES_SQL` fixo que lia só
 * `[Atendimento] JOIN [Atendimento Detalhe]` — o circuito G — com os
 * nomes das colunas escritos à mão, e mandava tudo com
 * `sourceNamespace: ATENDIMENTO_DETALHE` e `naturezaVenda: NORMAL`.
 *
 * O que isso significava, com números reais: um operador que corresse
 * `run-daily-sync.bat` para um dia gravava a fatia G desse dia e mais
 * nada. As vendas suspensas — 18 481 linhas no bootstrap da Silveirense
 * — e as guias de transferência não chegavam. O comando terminava com
 * sucesso, as contagens eram plausíveis, e a divergência só aparecia a
 * comparar com o balcão semanas depois.
 *
 * É a forma exacta do defeito do `Fim Venda = 'S'` e do `if (t === 77)`:
 * duas rotas de escrita a ler populações diferentes. A diferença é que
 * daquela vez foram seis sítios e três cópias; aqui era um só, mas com
 * um `.bat` em cima e um duplo-clique à distância.
 *
 * Agora este comando é UM WRAPPER. Argumentos, credenciais, cabeçalho,
 * resumo e o `aggregate-month` no fim. A leitura é `runPipelineForDay`,
 * a mesma que o `daily-pipeline` automático e a mesma família de fontes
 * do `bootstrap-upload` (`fontesDeVenda`). Não há aqui SQL de vendas
 * nenhum, e é isso que impede a próxima divergência.
 *
 * O dry-run também: é a MESMA leitura sem o POST no fim, e as amostras
 * que imprime são os payloads verdadeiros. Um dry-run que exercita outro
 * código não valida nada — foi o que se disse do `bootstrap-dry-run` e
 * vale igual aqui.
 *
 * Exports:
 *   · `dailySync()`        — lê e POSTa (e dispara aggregate-month)
 *   · `dailySyncDryRun()`  — lê, imprime amostras, não POSTa
 *
 * Garantias que se mantêm:
 *   · NÃO escreve em `Venda`, `VendaMensal`, `HistoricoStock` — só nos
 *     endpoints `/api/ingest/v1/bootstrap/*`;
 *   · idempotente por `(farmaciaId, sourceNamespace, externalSaleLineId)`;
 *   · feature flag `ENABLE_AGENT_BOOTSTRAP` no SaaS.
 */

import { parseArgs } from "node:util";
import { loadConfig, type AgentConfig } from "../config.js";
import { withPool } from "../sql-client.js";
import { SaasClient, SaasApiError } from "../http-client.js";
import { parseDateArg, tableExists, listColumns } from "./probe-helpers.js";
import {
  OPCOES_INCLUIR_HOJE,
  aplicarGuardaTemporal,
  leuIncluirHoje,
} from "../janela.js";
import {
  runPipelineForDay,
  amostrasVazias,
  type PipelineRunCounts,
} from "./daily-sync-runner.js";

const RULE = "─".repeat(70);
const DOUBLE_RULE = "═".repeat(70);

type Args = {
  date?: string;
  /** `--include-today`: aceita um `--date` que seja hoje. Ver `guardaTemporal`. */
  incluirHoje: boolean;
  help?: boolean;
};

function parseCmdArgs(): Args {
  const raw = parseArgs({
    args: process.argv.slice(3),
    options: {
      date: { type: "string" },
      ...OPCOES_INCLUIR_HOJE,
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });
  return {
    date: typeof raw.values.date === "string" ? raw.values.date : undefined,
    incluirHoje: leuIncluirHoje(raw.values),
    help: raw.values.help === true,
  };
}

function printHelp(isDryRun: boolean): void {
  const name = isDryRun ? "daily-sync-dry-run" : "daily-sync";
  console.log(`Uso: ${name} --date YYYY-MM-DD`);
  console.log("");
  if (isDryRun) {
    console.log("DRY-RUN: lê o ERP e imprime contagens + amostras, SEM POST.");
    console.log("A leitura é a MESMA do daily-sync — só falta o envio.");
  } else {
    console.log("Sync incremental: lê o ERP no dia e POSTa para /bootstrap/*.");
    console.log("  --include-today  aceita --date = hoje (dia AINDA ABERTO — parcial).");
  }
  console.log("");
  console.log("Granularidade:");
  console.log("  · produtos — Stocks.[Data Ultima Venda] OU [Data Ultima Compra]");
  console.log("               (OU [Data_Actualiz] se existir)");
  console.log("  · stock    — produtos com StocksMov.[DataMov] no dia, snapshot ArmazensStocks");
  console.log("  · vendas   — AS TRES fontes: circuito G, suspenso e [Atendimento Credito]");
  console.log("               (as mesmas do bootstrap-upload e do daily-pipeline)");
  console.log("");
  console.log("Pré-requisitos:");
  if (!isDryRun) console.log("  · ENABLE_AGENT_BOOTSTRAP=1 no SaaS");
  if (!isDryRun) console.log("  · SPHARMMT_FARMACIA no agent.config.json");
  console.log("  · agent.config.json com credenciais SQL Server");
  console.log("");
  console.log("Idempotente: reupload do mesmo --date é seguro.");
  console.log("");
  console.log("Mapping canónico: docs/spharm-erp-canonical-mapping.md §9");
}

// ─────────────────────────────────────────────────────────────────────
// Resolução de farmaciaId via SaaS
// ─────────────────────────────────────────────────────────────────────

async function resolveFarmaciaId(client: SaasClient, hint: string): Promise<string> {
  const r = await client.listFarmacias(15_000);
  const isCuid = /^c[a-z0-9]{20,}$/i.test(hint);
  const match = isCuid
    ? r.farmacias.find((f) => f.id === hint)
    : r.farmacias.find((f) => f.nome.toLowerCase() === hint.toLowerCase());
  if (!match) {
    throw new Error(`Farmácia "${hint}" não encontrada no tenant.`);
  }
  if (match.estado !== "ATIVO") {
    throw new Error(`Farmácia "${match.nome}" inactiva (estado=${match.estado}).`);
  }
  return match.id;
}

// ─────────────────────────────────────────────────────────────────────
// Resumo
// ─────────────────────────────────────────────────────────────────────

function renderResumo(c: PipelineRunCounts, dryRun: boolean): void {
  const linha = (rotulo: string, valor: number) =>
    console.log(`  ${rotulo.padEnd(19)}: ${valor}`);
  console.log("Pipeline PRODUTOS:");
  linha("Linhas ERP lidas", c.productsRead);
  if (!dryRun) {
    linha("Upserted", c.productsUpserted);
    linha("Skipped", c.productsSkipped);
    linha("Errors", c.productsErrors);
  }
  console.log("");
  console.log("Pipeline STOCK:");
  linha("Linhas ERP lidas", c.stockRead);
  if (!dryRun) {
    linha("Upserted", c.stockUpserted);
    linha("Errors", c.stockErrors);
  }
  console.log("");
  console.log("Pipeline SALES-LINES:");
  linha("Linhas ERP lidas", c.salesRead);
  // `salesSkipped` conta também as linhas recusadas pelo reader — série
  // por declarar, tipo desconhecido, quantidade zero. Aparece nos dois
  // modos de propósito: um zero recusado que ninguém vê é um zero que se
  // lê como facto.
  linha("Recusadas/skipped", c.salesSkipped);
  if (!dryRun) {
    linha("Upserted", c.salesUpserted);
    linha("Servicos non-stock", c.salesNonStockServices);
    linha("Orfaos operacionais", c.salesOperationalOrphans);
    linha("Errors", c.salesErrors);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Entrypoints
// ─────────────────────────────────────────────────────────────────────

type RunMode = "dry-run" | "write";

async function runCommon(mode: RunMode): Promise<number> {
  const dryRun = mode === "dry-run";
  let args: Args;
  try {
    args = parseCmdArgs();
  } catch (err) {
    console.error("✗ Argumentos inválidos:", err instanceof Error ? err.message : err);
    printHelp(dryRun);
    return 1;
  }
  if (args.help) {
    printHelp(dryRun);
    return 0;
  }
  if (!args.date) {
    console.error("✗ --date é obrigatório (YYYY-MM-DD).");
    printHelp(dryRun);
    return 1;
  }

  let date: string;
  try {
    date = parseDateArg("--date", args.date) as string;
  } catch (err) {
    console.error("✗", err instanceof Error ? err.message : String(err));
    return 1;
  }

  // Só no modo que ESCREVE. Um dia ainda aberto gravado como se
  // estivesse fechado é um dia parcial que ninguém volta a reenviar; um
  // dry-run de hoje não grava nada e é um diagnóstico legítimo.
  if (!dryRun && !aplicarGuardaTemporal(date, args.incluirHoje)) return 1;

  let cfg: AgentConfig;
  try {
    cfg = loadConfig(dryRun ? "sql" : "both");
  } catch (err) {
    console.error("✗ Config inválida:");
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  let client: SaasClient | null = null;
  let farmaciaId = "";
  if (!dryRun) {
    if (!cfg.farmacia) {
      console.error("✗ SPHARMMT_FARMACIA não está definido.");
      return 1;
    }
    client = new SaasClient(cfg);
    try {
      farmaciaId = await resolveFarmaciaId(client, cfg.farmacia);
    } catch (err) {
      console.error("✗ Resolução de farmácia falhou:");
      console.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }

  const t0 = Date.now();
  console.log(RULE);
  console.log(`${dryRun ? "daily-sync-dry-run" : "daily-sync"} — incremental ${date}`);
  console.log(RULE);
  console.log(`SaaS endpoint     : ${dryRun ? "(dry-run: sem POST)" : cfg.saasEndpoint}`);
  if (!dryRun) console.log(`Tenant slug       : ${cfg.tenantSlug}`);
  if (farmaciaId) console.log(`Farmácia          : ${farmaciaId}`);
  console.log(`ERP database      : ${cfg.sqlDatabase}@${cfg.sqlHost}:${cfg.sqlPort}`);
  console.log(`Dia               : ${date}`);
  console.log("");

  const amostras = dryRun ? amostrasVazias() : undefined;
  const logger = { log: (l: string) => console.log(l), raw: (l: string) => console.log(l) };

  try {
    return await withPool(cfg, async (pool) => {
      const counts = await runPipelineForDay({
        pool,
        client,
        farmaciaId,
        date,
        schemaProbes: { tableExists, listColumns },
        logger,
        dryRun,
        amostras,
      });

      console.log("");
      console.log(DOUBLE_RULE);
      console.log(`RESUMO FINAL — ${dryRun ? "DRY-RUN" : "DAILY-SYNC"} ${date}`);
      console.log(DOUBLE_RULE);
      console.log("");
      renderResumo(counts, dryRun);
      console.log("");

      if (amostras) {
        console.log("Amostras (até 5 por pipeline) — os payloads REAIS que seriam enviados:");
        for (const [rotulo, lista] of [
          ["PRODUTOS", amostras.produtos],
          ["STOCK", amostras.stock],
          ["SALES", amostras.vendas],
        ] as const) {
          if (lista.length === 0) continue;
          console.log("");
          console.log(`  ${rotulo}:`);
          lista.forEach((p, i) => console.log(`    [${i + 1}] ${JSON.stringify(p)}`));
        }
        console.log("");
      }

      const wallMs = Date.now() - t0;
      console.log(RULE);
      console.log(`Wall time         : ${(wallMs / 1000).toFixed(1)}s`);

      if (dryRun) {
        console.log(`✓ Dry-run concluído. Sem POSTs. Para escrever, corre 'daily-sync --date ${date}'.`);
        return 0;
      }

      const totalErrors = counts.productsErrors + counts.stockErrors + counts.salesErrors;
      if (totalErrors > 0) {
        console.error(
          `✗ daily-sync ${date} concluído com ${totalErrors} erros — ver detalhes acima. aggregate-month NÃO disparado.`,
        );
        return 1;
      }

      // ── Catch-up automático: vendas raw → VendaMensal ───────────────
      // Após o daily-sync de um dia, dispara aggregate-month para o mês
      // que o contém. Idempotente (deleteMany+createMany por mês).
      // `allowOrphans/allowUnknowns=true` porque isto corre em cron e
      // uma linha individual não pode bloquear o mês; os gaps ficam
      // visíveis na ficha.
      const month = date.slice(0, 7);
      console.log("");
      console.log(DOUBLE_RULE);
      console.log(`▶ A propagar vendas raw → VendaMensal (aggregate-month ${month})`);
      console.log(DOUBLE_RULE);
      try {
        const agg = await client!.pipelineAggregateMonth(
          { month, write: true, allowOrphans: true, allowUnknowns: true },
          120_000,
        );
        console.log(
          `  ✓ aggregate-month OK: month=${month} ` +
            `inserted=${agg.rowsInserted} deleted=${agg.rowsDeleted} (${agg.durationMs}ms)`,
        );
      } catch (err) {
        if (err instanceof SaasApiError) {
          console.error(`✗ aggregate-month HTTP ${err.statusCode}: ${err.bodySnippet ?? err.message}`);
        } else {
          console.error(`✗ aggregate-month falhou:`, err instanceof Error ? err.message : err);
        }
        console.error(
          `  ⚠ Vendas ingeridas mas VendaMensal NÃO actualizada para ${month}. ` +
            `Re-correr 'daily-sync --date ${date}' depois de corrigir, OU correr ` +
            `'npx tsx scripts/admin/aggregate-vendamensal-window.ts --tenant <slug> --from-month ${month} --to-month ${month} --write --allow-orphans --allow-unknowns'.`,
        );
        return 1;
      }
      console.log("");
      console.log(`✓ daily-sync ${date} concluído sem erros (catch-up VendaMensal incluído).`);
      return 0;
    });
  } catch (err) {
    console.error(`\n✗ Falha no ${dryRun ? "dry-run" : "daily-sync"}:`);
    if (err instanceof SaasApiError) {
      console.error(`  SaaS ${err.method} ${err.path} → HTTP ${err.statusCode}`);
      if (err.bodySnippet) console.error(`  body: ${err.bodySnippet}`);
      if (err.statusCode === 503) {
        console.error(`  Hint: ENABLE_AGENT_BOOTSTRAP precisa estar a "1" no SaaS.`);
      }
    } else {
      console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    }
    return 1;
  }
}

export async function dailySync(): Promise<number> {
  return runCommon("write");
}

export async function dailySyncDryRun(): Promise<number> {
  return runCommon("dry-run");
}
