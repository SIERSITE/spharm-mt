/**
 * agent/src/commands/test-order-write.ts
 *
 * Smoke test do caminho de escrita de encomenda no SPharm local.
 *
 * Cria UMA encomenda sintética (1 linha) com dados controlados pelo
 * operador (--cnp, --quantidade) e invoca `writeOrderToSpharm` contra
 * a config corrente.
 *
 * Modo default: **dry-run** (rollback automático no fim) — valida que
 * o INSERT funciona end-to-end sem deixar nada permanente.
 *
 * Modo `--commit`: escrita real. O operador assume responsabilidade —
 * o ficheiro é criado em SPharm e fica visível imediatamente.
 *
 * Modo `--mode=stub|insert`: força um modo específico, sobrepondo a
 * config. Útil para testar ambos os caminhos sem editar agent.config.json.
 *
 * Idempotência do teste:
 *   - Default: outboxId é gerado ad-hoc (`test-<timestamp>`) — cada
 *     run cria nova encomenda
 *   - `--outbox-id <id>`: força um outboxId específico. Permite re-run
 *     com mesmo ID para verificar que NÃO duplica em SPharm
 *
 * Uso típico (BAT interactivo):
 *   agent.cjs test-order-write --synthetic --cnp 5440987 --quantidade 1 --dry-run
 *   agent.cjs test-order-write --synthetic --cnp 5440987 --quantidade 1 --commit
 *   agent.cjs test-order-write --synthetic --cnp 5440987 --outbox-id testfix01 --commit
 *   agent.cjs test-order-write --synthetic --cnp 5440987 --outbox-id testfix01 --commit  # 2nd run → idempotent
 *
 * Exit codes:
 *   0  OK (com ou sem commit)
 *   1  Config inválida ou erro fatal antes do INSERT
 *   2  INSERT falhou (mensagem detalhada em stderr)
 */

import { parseArgs } from "node:util";
import { loadConfig, ConfigError, type AgentConfig } from "../config.js";
import { openPool } from "../sql-client.js";
import type { SqlPool } from "../sql-client.js";
import {
  writeOrderToSpharm,
  WriteOrderError,
  describeOrdersWriteMode,
} from "../spharm-orders-writer.js";
import type { PendingOrder } from "../http-client.js";

type Args = {
  synthetic: boolean;
  cnp?: string;
  quantidade: number;
  commit: boolean;
  outboxId?: string;
  designacao?: string;
  forceMode?: "stub" | "insert";
  help?: boolean;
};

function parseCmd(): Args {
  const raw = parseArgs({
    args: process.argv.slice(3),
    options: {
      synthetic: { type: "boolean" },
      cnp: { type: "string" },
      quantidade: { type: "string" },
      commit: { type: "boolean" },
      "dry-run": { type: "boolean" },
      "outbox-id": { type: "string" },
      designacao: { type: "string" },
      mode: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  const qtyRaw = raw.values.quantidade ? Number(raw.values.quantidade) : 1;
  const quantidade = Number.isFinite(qtyRaw) && qtyRaw > 0 ? qtyRaw : 1;

  let forceMode: "stub" | "insert" | undefined;
  if (raw.values.mode === "stub" || raw.values.mode === "insert") {
    forceMode = raw.values.mode;
  } else if (raw.values.mode !== undefined) {
    throw new Error(`--mode "${raw.values.mode}" inválido (esperado stub|insert).`);
  }

  // --commit e --dry-run são mutuamente exclusivos. Default = dry-run.
  const dryRunFlag = raw.values["dry-run"] === true;
  const commitFlag = raw.values.commit === true;
  if (commitFlag && dryRunFlag) {
    throw new Error("--commit e --dry-run são mutuamente exclusivos.");
  }

  return {
    synthetic: raw.values.synthetic !== false, // default true
    cnp: raw.values.cnp,
    quantidade,
    commit: commitFlag, // default false → dry-run
    outboxId: raw.values["outbox-id"],
    designacao: raw.values.designacao,
    forceMode,
    help: raw.values.help === true,
  };
}

function printHelp(): void {
  console.log("Uso: test-order-write --synthetic --cnp <NNNNNNN> [opções]");
  console.log("");
  console.log("Smoke test do caminho de escrita de encomenda no SPharm.");
  console.log("Por defeito faz DRY-RUN (rollback automático).");
  console.log("");
  console.log("Opções:");
  console.log("  --synthetic           Construir encomenda sintética (default)");
  console.log("  --cnp <NNNNNNN>       CNP a usar na linha (obrigatório se synthetic)");
  console.log("  --quantidade <N>      Quantidade da linha (default 1, inteiro)");
  console.log("  --designacao <texto>  Designação descritiva (label)");
  console.log("  --outbox-id <id>      Força um outboxId específico (max 25 chars, default `test-<ts>`)");
  console.log("                        Usar o mesmo id em 2 runs valida idempotência.");
  console.log("  --commit              Escrita REAL. Default é dry-run (rollback).");
  console.log("  --dry-run             Explícito — dry-run (equivale ao default).");
  console.log("  --mode stub|insert    Forçar modo (sobrepõe agent.config.json).");
  console.log("");
  console.log("Pré-requisitos para --mode=insert (ou config ordersWriteMode=insert):");
  console.log("  · SQL login com db_datawriter (ou INSERT grant em Encomendas/Encomendas Detalhe)");
  console.log("  · agent.config.json secção `ordersInsert` populada");
}

function buildSyntheticOrder(args: Args, tenantSlug: string): PendingOrder {
  if (!args.cnp) {
    throw new Error("--cnp é obrigatório em modo --synthetic.");
  }
  const outboxId = args.outboxId ?? `test-${Date.now().toString(36)}`;
  if (outboxId.length > 32) {
    throw new Error(
      `outboxId "${outboxId}" tem ${outboxId.length} chars; coluna outboxId em dbo.SPharmMT_OrderWriteLog é varchar(32). Encurta o ID.`
    );
  }
  return {
    outboxId,
    listaEncomendaId: "test-lista",
    farmaciaId: "test-farmacia",
    idempotencyKey: `test:${outboxId}`,
    payloadHash: "test-no-hash",
    attempt: 1,
    payload: {
      version: 1,
      tenantSlug,
      listaEncomendaId: "test-lista",
      farmaciaId: "test-farmacia",
      nome: "TESTE — test-order-write",
      criadoPorId: "test-user",
      criadoEm: new Date().toISOString(),
      linhas: [
        {
          produtoId: "test-produto-1",
          quantidadeSugerida: String(args.quantidade),
          quantidadeAjustada: null,
          fornecedorSugeridoId: null,
          notas: "test-order-write",
        },
      ],
    },
    enrichment: {
      linhas: [
        {
          produtoId: "test-produto-1",
          cnp: args.cnp,
          designacao: args.designacao ?? `(synthetic: CNP ${args.cnp})`,
        },
      ],
    },
  };
}

const RULE = "─".repeat(72);

export async function testOrderWrite(): Promise<number> {
  let args: Args;
  try {
    args = parseCmd();
  } catch (err) {
    console.error("✗", err instanceof Error ? err.message : String(err));
    console.error("");
    printHelp();
    return 1;
  }
  if (args.help) {
    printHelp();
    return 0;
  }

  let cfg: AgentConfig;
  try {
    // Se mode=insert (ou se config já está em insert), precisamos de SaaS+SQL.
    // Em stub puro precisamos só de SaaS para o tenantSlug.
    cfg = loadConfig("both");
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error("✗ Config inválida:");
      console.error(err.message);
      return 1;
    }
    throw err;
  }

  // Override de modo via --mode
  const effectiveCfg: AgentConfig = args.forceMode
    ? { ...cfg, ordersWriteMode: args.forceMode }
    : cfg;
  const description = describeOrdersWriteMode(effectiveCfg);
  if (description.configIssues.length > 0) {
    console.error("✗ Config insuficiente para modo escolhido:");
    for (const issue of description.configIssues) console.error(`  · ${issue}`);
    return 1;
  }

  let order: PendingOrder;
  try {
    order = buildSyntheticOrder(args, effectiveCfg.tenantSlug);
  } catch (err) {
    console.error("✗", err instanceof Error ? err.message : String(err));
    return 1;
  }

  const dryRun = !args.commit;

  console.log(RULE);
  console.log("test-order-write");
  console.log(RULE);
  console.log(`tenant         : ${effectiveCfg.tenantSlug}`);
  console.log(`mode           : ${description.mode}${args.forceMode ? " (forçado via --mode)" : ""}`);
  console.log(`dry-run        : ${dryRun ? "SIM (rollback automático)" : "NÃO — escrita REAL"}`);
  console.log(`outboxId       : ${order.outboxId}`);
  console.log(`CNP            : ${args.cnp}`);
  console.log(`Quantidade     : ${args.quantidade}`);
  if (description.mode === "insert" && effectiveCfg.ordersInsert) {
    const oc = effectiveCfg.ordersInsert;
    console.log(`fornecedor ID  : ${oc.fornecedorIdForOrders}`);
    console.log(`user ID        : ${oc.userIdForInsert}`);
    console.log(`armazém ID     : ${oc.armazemId}`);
    console.log(`tipo enc. ID   : ${oc.tipoEncomendaId}`);
    console.log(`situação inic. : ${oc.encomendaSituacaoInitial}`);
    console.log(`idempotência   : dbo.SPharmMT_OrderWriteLog (criada por setup-orders-write-log)`);
  }
  console.log("");

  let pool: SqlPool | null = null;
  if (description.needsSqlPool) {
    pool = openPool(effectiveCfg);
    try {
      await pool.connect();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`✗ SQL Server connect falhou: ${msg}`);
      return 1;
    }
  }

  try {
    const result = await writeOrderToSpharm(order, effectiveCfg, pool, { dryRun });
    console.log("─── Resultado ───");
    console.log(`spharmDocumentId : ${result.spharmDocumentId}`);
    console.log(`source           : ${result.source}`);
    console.log(`duration         : ${result.durationMs}ms`);
    console.log("");
    console.log("Detalhes:");
    for (const [k, v] of Object.entries(result.details)) {
      const s =
        typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null
          ? String(v)
          : JSON.stringify(v);
      const truncated = s.length > 200 ? s.slice(0, 200) + " …(truncated)" : s;
      console.log(`  ${k.padEnd(18)} ${truncated}`);
    }
    console.log("");
    console.log(RULE);
    if (dryRun) {
      console.log("DRY-RUN concluído. ROLLBACK aplicado — nada visível em SPharm.");
      console.log("");
      console.log("Para escrita real (apenas após validação operacional):");
      console.log(`  agent.cjs test-order-write --synthetic --cnp ${args.cnp} --quantidade ${args.quantidade} --commit`);
    } else {
      console.log("COMMIT aplicado. Verificar em SPharm UI:");
      console.log(`  · Encomenda ID = ${result.spharmDocumentId}`);
      console.log("  · A encomenda deve estar visível na lista de encomendas pendentes.");
      console.log("");
      console.log("Para validar idempotência:");
      console.log(`  agent.cjs test-order-write --synthetic --cnp ${args.cnp} --outbox-id ${order.outboxId} --commit`);
      console.log("  (segunda run com mesmo outboxId — source deve dar 'idempotent', sem nova encomenda em SPharm)");
    }
    console.log(RULE);
    return 0;
  } catch (err) {
    if (err instanceof WriteOrderError) {
      console.error(`✗ Write falhou (retryable=${err.retryable}): ${err.message}`);
      if (err.sqlError) {
        console.error(`  SQL error: code=${err.sqlError.code ?? "?"} number=${err.sqlError.number ?? "?"}`);
        if (err.sqlError.message) console.error(`  SQL msg  : ${err.sqlError.message}`);
      }
    } else {
      console.error("✗ Falha inesperada:", err instanceof Error ? err.message : String(err));
    }
    return 2;
  } finally {
    if (pool) {
      try {
        await pool.close();
      } catch {
        // ignore
      }
    }
  }
}
