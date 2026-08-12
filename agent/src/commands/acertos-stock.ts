/**
 * agent/src/commands/acertos-stock.ts
 *
 * `acertos-stock-dry-run` — read-only, sem POST.
 *
 * Conta os acertos de stock (origem MOV_INTERNO) de uma janela e diz se
 * a chave de idempotência proposta aguenta. Nada escreve, nem no ERP nem
 * no SaaS.
 *
 * Porque é que os totais vêm de agregações SQL e não de linhas lidas:
 * o `stocksmov-dry-run` lê um chunk de 50 000 linhas e extrapola, o que
 * chega para ver uma distribuição mas não para contar uma janela de
 * anos. Aqui as perguntas são "quantos" e "de que data a que data" sobre
 * a janela INTEIRA, e o SQL Server responde a isso num COUNT sem trazer
 * meio milhão de linhas pela rede. As amostras, essas, são lidas — e é
 * sobre elas que corre a verificação contra o classificador canónico.
 *
 * Âmbito, imposto no WHERE e não por convenção (ver `acertos-stock.ts`):
 * MovStocksDetID populado e as cinco FKs transaccionais vazias. Vendas,
 * vendas a crédito, compras, devoluções a fornecedor e reservas ficam
 * de fora por construção — têm pipelines próprios.
 *
 * Uso:
 *   node agent.cjs acertos-stock-dry-run --from 2024-01-01 --to 2026-08-11
 *                                        [--amostras 20] [--motivos 25]
 */

import { parseArgs } from "node:util";
import sql from "mssql";
import { loadConfig, type AgentConfig } from "../config.js";
import { withPool, type SqlPool } from "../sql-client.js";
import { parseDateArg } from "./probe-helpers.js";
import { janela } from "../janela.js";
import {
  ACERTO_STOCK,
  COLUNAS_FK,
  avaliarTotais,
  verificarAmostra,
  whereAcertoStock,
  type LinhaAmostra,
  type Totais,
} from "../acertos-stock.js";
import { classifyMovimento } from "../movimento-classifier.js";

const DOUBLE_RULE = "═".repeat(70);
const RULE = "─".repeat(70);

const DEFAULT_AMOSTRAS = 20;
const DEFAULT_MOTIVOS = 25;

// ── SQL ────────────────────────────────────────────────────────────

/**
 * As três JOINs auditadas (rev32), e mais nada. `dbo.Stocks` entra para
 * responder a "movimentos sem produto resolvido" — um CodigoID que não
 * existe na ficha do ERP também não vai existir no catálogo do SaaS.
 */
const JOINS_INTERNAS = [
  "  LEFT JOIN dbo.tblMovStocksDet det",
  "    ON det.MovStocksDetID = sm.MovStocksDetID",
  "  LEFT JOIN dbo.tblMovStocksCab cab",
  "    ON cab.MovStocksCabID = det.MovStocksCabID",
  "  LEFT JOIN dbo.tblMovStocksCab_Motivo mot",
  "    ON mot.MovStocksCabMotivoID = cab.MovStocksCabMotivoID",
].join("\n");

type TotaisRow = {
  total: number;
  totalDistinto: number;
  positivos: number;
  negativos: number;
  zeros: number;
  quantidadeLiquida: number | string | null;
  quantidadeEntrada: number | string | null;
  quantidadeSaida: number | string | null;
  produtosDistintos: number;
  dataMin: Date | null;
  dataMax: Date | null;
  semCodigoProduto: number;
  semFichaStocks: number;
  semDetalhe: number;
  semCabecalho: number;
  semMotivoId: number;
  semMotivoTexto: number;
};

function sqlTotais(): string {
  return `
  SELECT
    COUNT(*)                        AS total,
    COUNT(DISTINCT sm.StocksMovID)  AS totalDistinto,
    SUM(CASE WHEN sm.Qtd > 0 THEN 1 ELSE 0 END) AS positivos,
    SUM(CASE WHEN sm.Qtd < 0 THEN 1 ELSE 0 END) AS negativos,
    SUM(CASE WHEN sm.Qtd = 0 THEN 1 ELSE 0 END) AS zeros,
    -- CAST a BIGINT antes de somar: uma janela de anos passa o INT.
    SUM(CAST(sm.Qtd AS BIGINT))     AS quantidadeLiquida,
    SUM(CASE WHEN sm.Qtd > 0 THEN CAST(sm.Qtd AS BIGINT) ELSE 0 END) AS quantidadeEntrada,
    SUM(CASE WHEN sm.Qtd < 0 THEN CAST(sm.Qtd AS BIGINT) ELSE 0 END) AS quantidadeSaida,
    COUNT(DISTINCT sm.CodigoID)     AS produtosDistintos,
    MIN(sm.DataMov)                 AS dataMin,
    MAX(sm.DataMov)                 AS dataMax,
    SUM(CASE WHEN sm.CodigoID IS NULL OR sm.CodigoID <= 0 THEN 1 ELSE 0 END) AS semCodigoProduto,
    -- Só conta como órfão de catálogo quem TEM CodigoID e mesmo assim
    -- não aparece em dbo.Stocks; sem esta guarda, quem não tem CodigoID
    -- era contado duas vezes.
    SUM(CASE WHEN sm.CodigoID IS NOT NULL AND sm.CodigoID > 0 AND st.CodigoID IS NULL
             THEN 1 ELSE 0 END)     AS semFichaStocks,
    SUM(CASE WHEN det.MovStocksDetID IS NULL THEN 1 ELSE 0 END) AS semDetalhe,
    SUM(CASE WHEN cab.MovStocksCabID IS NULL THEN 1 ELSE 0 END) AS semCabecalho,
    SUM(CASE WHEN cab.MovStocksCabMotivoID IS NULL THEN 1 ELSE 0 END) AS semMotivoId,
    SUM(CASE WHEN mot.Motivo IS NULL THEN 1 ELSE 0 END) AS semMotivoTexto
  FROM dbo.StocksMov sm
${JOINS_INTERNAS}
  LEFT JOIN dbo.Stocks st
    ON st.CodigoID = sm.CodigoID
  WHERE sm.DataMov >= @from
    AND sm.DataMov <  @to
    AND ${whereAcertoStock("sm")}
`;
}

/**
 * Quantas linhas têm a FK interna E outra FK transaccional.
 *
 * Não é curiosidade: é a prova de que o âmbito não se sobrepõe aos
 * pipelines existentes. Se for zero, "MOV_INTERNO" e "não é venda nem
 * compra nem devolução nem reserva" são a mesma coisa nesta instalação.
 * Se não for, as linhas ambíguas ficam de fora — e ficam contadas.
 */
function sqlAmbiguidade(): string {
  const outras = [
    COLUNAS_FK.detalheId,
    COLUNAS_FK.suspDetalheId,
    COLUNAS_FK.creditoDetalheId,
    COLUNAS_FK.recpDetalheId,
    COLUNAS_FK.devolucaoDetalheId,
  ]
    .map((c) => `sm.${c} IS NOT NULL`)
    .join(" OR ");
  return `
  SELECT
    SUM(CASE WHEN sm.MovStocksDetID IS NOT NULL THEN 1 ELSE 0 END) AS comFkInterna,
    SUM(CASE WHEN sm.MovStocksDetID IS NOT NULL AND (${outras})
             THEN 1 ELSE 0 END) AS ambiguas
  FROM dbo.StocksMov sm
  WHERE sm.DataMov >= @from
    AND sm.DataMov <  @to
`;
}

type MotivoRow = {
  motivoId: number | null;
  motivo: string | null;
  cabTipoDocId: number | null;
  n: number;
  qtdLiquida: number | string | null;
};

function sqlMotivos(): string {
  return `
  SELECT TOP (@limite)
    cab.MovStocksCabMotivoID AS motivoId,
    mot.Motivo               AS motivo,
    cab.[Tipo Documento ID]  AS cabTipoDocId,
    COUNT(*)                 AS n,
    SUM(CAST(sm.Qtd AS BIGINT)) AS qtdLiquida
  FROM dbo.StocksMov sm
${JOINS_INTERNAS}
  WHERE sm.DataMov >= @from
    AND sm.DataMov <  @to
    AND ${whereAcertoStock("sm")}
  GROUP BY cab.MovStocksCabMotivoID, mot.Motivo, cab.[Tipo Documento ID]
  ORDER BY COUNT(*) DESC
`;
}

type AmostraRow = {
  StocksMovID: number;
  CodigoID: number | null;
  DataMov: Date;
  Qtd: number;
  Existencia: number | null;
  MovStocksDetID: number | null;
  detalheId: number | null;
  suspDetalheId: number | null;
  creditoDetalheId: number | null;
  recpDetalheId: number | null;
  devolucaoDetalheId: number | null;
  cabMovStocksCabID: number | null;
  cabTipoDocId: number | null;
  cabMotivoId: number | null;
  cabMotivoTexto: string | null;
};

function sqlAmostras(): string {
  return `
  SELECT TOP (@limite)
    sm.StocksMovID,
    sm.CodigoID,
    sm.DataMov,
    sm.Qtd,
    sm.Existencia,
    sm.MovStocksDetID,
    sm.${COLUNAS_FK.detalheId}          AS detalheId,
    sm.${COLUNAS_FK.suspDetalheId}      AS suspDetalheId,
    sm.${COLUNAS_FK.creditoDetalheId}   AS creditoDetalheId,
    sm.${COLUNAS_FK.recpDetalheId}      AS recpDetalheId,
    sm.${COLUNAS_FK.devolucaoDetalheId} AS devolucaoDetalheId,
    cab.MovStocksCabID       AS cabMovStocksCabID,
    cab.[Tipo Documento ID]  AS cabTipoDocId,
    cab.MovStocksCabMotivoID AS cabMotivoId,
    mot.Motivo               AS cabMotivoTexto
  FROM dbo.StocksMov sm
${JOINS_INTERNAS}
  WHERE sm.DataMov >= @from
    AND sm.DataMov <  @to
    AND ${whereAcertoStock("sm")}
  ORDER BY sm.StocksMovID DESC
`;
}

// ── helpers ────────────────────────────────────────────────────────

function n(v: unknown): number {
  if (v == null) return 0;
  const x = typeof v === "string" ? Number(v) : Number(v);
  return Number.isFinite(x) ? x : 0;
}

function dt(d: Date | null): string {
  return d ? d.toISOString().slice(0, 19).replace("T", " ") : "—";
}

function amostraParaLinha(r: AmostraRow): LinhaAmostra {
  return {
    externalMovId: r.StocksMovID,
    fk: {
      detalheId: r.detalheId,
      suspDetalheId: r.suspDetalheId,
      creditoDetalheId: r.creditoDetalheId,
      recpDetalheId: r.recpDetalheId,
      devolucaoDetalheId: r.devolucaoDetalheId,
      movStocksDetId: r.MovStocksDetID,
    },
    motivoTexto: r.cabMotivoTexto,
    cabTipoDocId: r.cabTipoDocId,
    qtd: r.Qtd,
  };
}

// ── CLI ────────────────────────────────────────────────────────────

type Args = { from?: string; to?: string; amostras: number; motivos: number; help: boolean };

function parseCmdArgs(): Args {
  const raw = parseArgs({
    args: process.argv.slice(3),
    options: {
      from: { type: "string" },
      to: { type: "string" },
      amostras: { type: "string" },
      motivos: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });
  const num = (v: unknown, def: number) => {
    if (typeof v !== "string") return def;
    const x = Number(v);
    return Number.isFinite(x) && x > 0 ? Math.floor(x) : def;
  };
  return {
    from: typeof raw.values.from === "string" ? raw.values.from : undefined,
    to: typeof raw.values.to === "string" ? raw.values.to : undefined,
    amostras: num(raw.values.amostras, DEFAULT_AMOSTRAS),
    motivos: num(raw.values.motivos, DEFAULT_MOTIVOS),
    help: raw.values.help === true,
  };
}

function printHelp(): void {
  console.log("Uso: acertos-stock-dry-run --from YYYY-MM-DD --to YYYY-MM-DD [--amostras 20] [--motivos 25]");
  console.log("");
  console.log("Conta os acertos de stock (origem MOV_INTERNO) da janela. READ-ONLY, SEM POST.");
  console.log("");
  console.log("Âmbito: StocksMov.MovStocksDetID populado e as 5 FKs transaccionais vazias.");
  console.log("Vendas, vendas a crédito, compras, devoluções a fornecedor e reservas ficam");
  console.log("de fora por construção — têm pipelines próprios.");
  console.log("");
  console.log("--to é INCLUSIVO (contrato temporal: janela meio-aberta até ao dia seguinte).");
}

// ── DRY-RUN ────────────────────────────────────────────────────────

export async function acertosStockDryRun(): Promise<number> {
  let args: Args;
  try {
    args = parseCmdArgs();
  } catch (err) {
    console.error("✗ Argumentos inválidos:", err instanceof Error ? err.message : err);
    return 1;
  }
  if (args.help) {
    printHelp();
    return 0;
  }
  if (!args.from || !args.to) {
    console.error("✗ --from e --to são obrigatórios (YYYY-MM-DD).");
    printHelp();
    return 1;
  }
  let from: string;
  let to: string;
  try {
    from = parseDateArg("--from", args.from) as string;
    to = parseDateArg("--to", args.to) as string;
  } catch (err) {
    console.error("✗", err instanceof Error ? err.message : String(err));
    return 1;
  }
  if (from > to) {
    console.error(`✗ --from (${from}) é posterior a --to (${to}).`);
    return 1;
  }

  let cfg: AgentConfig;
  try {
    // "sql" e não "both": este comando não fala com o SaaS. Pedir
    // credenciais que não usa faria o dry-run falhar numa farmácia onde
    // só o lado ERP está configurado.
    cfg = loadConfig("sql");
  } catch (err) {
    console.error("✗ Config inválida:", err instanceof Error ? err.message : String(err));
    return 1;
  }

  const j = janela(from, to);

  console.log(DOUBLE_RULE);
  console.log("acertos-stock-dry-run — read-only, SEM POST");
  console.log(DOUBLE_RULE);
  console.log(`ERP database : ${cfg.sqlDatabase}@${cfg.sqlHost}:${cfg.sqlPort}`);
  console.log(`Janela       : ${j.inicio}  ≤ DataMov <  ${j.fimExclusivo}`);
  console.log(`               (--from ${from} a --to ${to}, ambos incluídos)`);
  console.log(`Operação     : ${ACERTO_STOCK} (todos os motivos ERP colapsam nesta)`);
  console.log("");

  try {
    return await withPool(cfg, async (pool) => {
      const bind = (r: ReturnType<SqlPool["request"]>) =>
        r.input("from", sql.NVarChar, j.inicio).input("to", sql.NVarChar, j.fimExclusivo);

      // ── 1. Totais ────────────────────────────────────────────────
      console.log("▶ Agregação sobre a janela inteira ...");
      const totaisRs = await bind(pool.request()).query<TotaisRow>(sqlTotais());
      const t = totaisRs.recordset[0];
      if (!t) {
        console.error("✗ A query de totais não devolveu linha. Abortado.");
        return 1;
      }

      const ambRs = await bind(pool.request()).query<{
        comFkInterna: number;
        ambiguas: number;
      }>(sqlAmbiguidade());
      const amb = ambRs.recordset[0] ?? { comFkInterna: 0, ambiguas: 0 };

      console.log(`  ✓ ${n(t.total)} acertos na janela`);
      console.log("");

      console.log(RULE);
      console.log("Contagem");
      console.log(RULE);
      console.log(`  Total MOV_INTERNO (âmbito)      : ${n(t.total)}`);
      console.log(`  Movimentos positivos (entradas) : ${n(t.positivos)}`);
      console.log(`  Movimentos negativos (saídas)   : ${n(t.negativos)}`);
      console.log(`  Movimentos com quantidade zero  : ${n(t.zeros)}`);
      console.log("");
      console.log(`  Quantidade entrada (+)          : ${n(t.quantidadeEntrada)}`);
      console.log(`  Quantidade saída   (−)          : ${n(t.quantidadeSaida)}`);
      console.log(`  Quantidade LÍQUIDA              : ${n(t.quantidadeLiquida)}`);
      console.log("");
      console.log(`  Produtos distintos (CodigoID)   : ${n(t.produtosDistintos)}`);
      console.log(`  Primeiro movimento              : ${dt(t.dataMin)}`);
      console.log(`  Último movimento                : ${dt(t.dataMax)}`);
      console.log("");

      console.log(RULE);
      console.log("Integridade e âmbito");
      console.log(RULE);
      console.log(`  StocksMovID distintos           : ${n(t.totalDistinto)} (de ${n(t.total)} linhas)`);
      console.log(`  Linhas com FK interna na janela : ${n(amb.comFkInterna)}`);
      console.log(`  … dessas, ambíguas (2ª FK)      : ${n(amb.ambiguas)}  → excluídas do âmbito`);
      console.log(`  Sem CodigoID                    : ${n(t.semCodigoProduto)}`);
      console.log(`  CodigoID ausente de dbo.Stocks  : ${n(t.semFichaStocks)}`);
      console.log(`  Sem linha tblMovStocksDet       : ${n(t.semDetalhe)}`);
      console.log(`  Sem cabeçalho tblMovStocksCab   : ${n(t.semCabecalho)}`);
      console.log(`  Sem MovStocksCabMotivoID        : ${n(t.semMotivoId)}`);
      console.log(`  Sem texto de motivo             : ${n(t.semMotivoTexto)}`);
      console.log("");

      const totais: Totais = {
        total: n(t.total),
        totalDistinto: n(t.totalDistinto),
        positivos: n(t.positivos),
        negativos: n(t.negativos),
        zeros: n(t.zeros),
        ambiguas: n(amb.ambiguas),
        semCodigoProduto: n(t.semCodigoProduto),
        semFichaStocks: n(t.semFichaStocks),
        semCabecalho: n(t.semCabecalho),
      };
      const veredicto = avaliarTotais(totais);
      console.log(RULE);
      console.log("Conclusões");
      console.log(RULE);
      for (const linha of veredicto.linhas) console.log(`  · ${linha}`);
      console.log("");

      // ── 2. Motivos ERP (diagnóstico) ─────────────────────────────
      // Rastreabilidade, não taxonomia: nenhum destes valores decide
      // lógica no SPharm.MT. Estão aqui para o operador reconhecer a
      // sua própria operação nos números.
      const motRs = await bind(pool.request())
        .input("limite", sql.Int, args.motivos)
        .query<MotivoRow>(sqlMotivos());
      console.log(RULE);
      console.log(`Motivos ERP (top ${args.motivos}) — diagnóstico, sem efeito funcional`);
      console.log(RULE);
      if (motRs.recordset.length === 0) {
        console.log("  (nenhum)");
      }
      for (const m of motRs.recordset) {
        const id = m.motivoId == null ? "—" : String(m.motivoId);
        const td = m.cabTipoDocId == null ? "—" : String(m.cabTipoDocId);
        console.log(
          `  ${String(n(m.n)).padStart(7)} × motivoId=${id.padEnd(5)} tipoDoc=${td.padEnd(4)} ` +
            `líq=${String(n(m.qtdLiquida)).padStart(8)}  ${m.motivo ?? "(sem texto)"}`,
        );
      }
      console.log("");

      // ── 3. Amostras + verificação ────────────────────────────────
      const amRs = await bind(pool.request())
        .input("limite", sql.Int, args.amostras)
        .query<AmostraRow>(sqlAmostras());
      const amostras = amRs.recordset;

      console.log(RULE);
      console.log(`Amostras (${amostras.length} mais recentes)`);
      console.log(RULE);
      for (const r of amostras) {
        const cls = classifyMovimento(amostraParaLinha(r));
        console.log(
          `  StocksMovID=${String(r.StocksMovID).padEnd(9)} ${dt(r.DataMov)} ` +
            `cnp=${String(r.CodigoID ?? "—").padEnd(8)} qt=${String(r.Qtd).padStart(6)} ` +
            `ex=${String(r.Existencia ?? "—").padStart(6)}`,
        );
        console.log(
          `      cab=${r.cabMovStocksCabID ?? "—"} motivoId=${r.cabMotivoId ?? "—"} ` +
            `tipoDoc=${r.cabTipoDocId ?? "—"} motivo="${r.cabMotivoTexto ?? "—"}"`,
        );
        console.log(`      → ${ACERTO_STOCK}   [ERP dizia: ${cls.tipo} via ${cls.reason}]`);
      }
      console.log("");

      // A dívida das duas versões da regra, paga aqui.
      const divergencias = verificarAmostra(amostras.map(amostraParaLinha));
      console.log(RULE);
      console.log("Verificação SQL ↔ classificador canónico");
      console.log(RULE);
      if (divergencias.length === 0) {
        console.log(
          `  ✓ As ${amostras.length} amostras são todas de origem interna. O filtro SQL`,
        );
        console.log(`    e o classificador concordam sobre o âmbito.`);
      } else {
        console.log(`  ✗ ${divergencias.length} amostra(s) NÃO são movimentos internos:`);
        for (const d of divergencias) {
          console.log(`      StocksMovID=${d.externalMovId} → ${d.tipo} (${d.reason})`);
        }
        console.log(`    O filtro SQL está a apanhar linhas de outro pipeline. PARAR.`);
      }
      console.log("");

      const ok = veredicto.ok && divergencias.length === 0;
      console.log(DOUBLE_RULE);
      if (ok) {
        console.log("Dry-run OK. Nada lido fora de SELECT, nada escrito, nada enviado.");
        console.log("Próximo passo: decisão sobre modelo e ingestão — ainda não implementada.");
      } else {
        console.log("Dry-run com bloqueios acima. Não avançar para ingestão.");
      }
      console.log(DOUBLE_RULE);
      return ok ? 0 : 1;
    });
  } catch (err) {
    console.error("\n✗ Falha:", err instanceof Error ? err.message : String(err));
    return 1;
  }
}
