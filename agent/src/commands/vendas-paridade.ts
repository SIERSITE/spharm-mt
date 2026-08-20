/**
 * agent/src/commands/vendas-paridade.ts
 *
 * Dry-run 2026: as cinco populações por mês, comparadas automaticamente
 * com o relatório oficial do SPharm. Read-only, sem POST, sem escrita.
 *
 * ── O QUE ISTO RESPONDE ──────────────────────────────────────────────
 *
 *   NORMAL                             (circuito G + suspenso)
 *   CREDITO                            (reader por construir)
 *   TRANSFERENCIA                      (reader por construir)
 *   NORMAL + CREDITO                   -> gate contra o relatório modo A
 *   NORMAL + CREDITO + TRANSFERENCIA   -> gate contra o relatório modo B
 *
 * E, separadamente, quanto é que a população NORMAL cresceu por incluir
 * `TipoDoc 7 / Fim Venda = U` — que é o defeito que trouxe esta ronda.
 *
 * Uso:
 *   agent -- vendas-paridade [--ano 2026] [--db <base>]
 */

import { parseArgs } from "node:util";
import sql from "mssql";
import { loadConfig } from "../config.js";
import { withPool, type SqlPool } from "../sql-client.js";
import {
  CLASSIFICACAO,
  ESTADOS_VENDA_G,
  NAMESPACES,
  descobrirCabecalhoSusp,
  descobrirSchemaAtendimento,
  descobrirSchemaCredito,
  descobrirSchemaSusp,
  namespaceDaSerieCredito,
  sqlAtendimentoCredito,
} from "../vendas-fontes.js";
import {
  ANTES_SPHARM_MT_2026,
  GATES_SILVEIRENSE_2026,
  avaliarGate,
  nomeMes,
  renderGates,
} from "../gates-silveirense.js";
import { quoteIdent, tableExists } from "./probe-helpers.js";

const DOUBLE = "═".repeat(74);
const RULE = "─".repeat(74);

type Args = { ano: number; db?: string; help: boolean };

function parseCmdArgs(): Args {
  const raw = parseArgs({
    args: process.argv.slice(3),
    options: {
      ano: { type: "string" },
      db: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });
  return {
    ano: typeof raw.values.ano === "string" ? Number(raw.values.ano) : 2026,
    db: typeof raw.values.db === "string" ? raw.values.db : undefined,
    help: raw.values.help === true,
  };
}

type PorMes = Map<number, number>;

function vazio(): PorMes {
  return new Map<number, number>();
}

function soma(a: PorMes, b: PorMes): PorMes {
  const out = new Map(a);
  for (const [m, v] of b) out.set(m, (out.get(m) ?? 0) + v);
  return out;
}

function linhaMeses(rotulo: string, p: PorMes): string {
  const cells = GATES_SILVEIRENSE_2026.map((g) =>
    String(Math.round(p.get(g.mes) ?? 0)).padStart(8),
  ).join("");
  return `  ${rotulo.padEnd(34)}${cells}`;
}

/**
 * Unidades por mês do circuito G, com o filtro de estado que se lhe
 * passar. Chamado duas vezes — só com `S`, e com `S`+`U` — para se ver
 * exactamente o que o gate antigo escondia.
 */
async function unidadesG(
  pool: SqlPool,
  ano: number,
  colData: string,
  colTipo: string,
  colEstado: string | null,
  estados: readonly string[] | null,
): Promise<PorMes> {
  const venda = [...CLASSIFICACAO[NAMESPACES.ATENDIMENTO_DETALHE].venda];
  const reversao = [...CLASSIFICACAO[NAMESPACES.ATENDIMENTO_DETALHE].reversao];
  const filtroEstado =
    colEstado && estados
      ? ` AND a.${quoteIdent(colEstado)} IN (${estados.map((e) => `'${e}'`).join(", ")})`
      : "";
  const r = await pool
    .request()
    .input("ano", sql.Int, ano)
    .query<{ mes: number; unidades: number }>(`
      SELECT MONTH(a.${quoteIdent(colData)}) AS mes,
             SUM(CASE WHEN a.${quoteIdent(colTipo)} IN (${venda.join(",")})
                        THEN ABS(CAST(d.[Quantidade] AS FLOAT))
                      WHEN a.${quoteIdent(colTipo)} IN (${reversao.join(",")})
                        THEN -ABS(CAST(d.[Quantidade] AS FLOAT))
                      ELSE 0 END) AS unidades
        FROM [dbo].[Atendimento] a
        JOIN [dbo].[Atendimento Detalhe] d ON d.[Atendimento ID] = a.[Atendimento ID]
       WHERE YEAR(a.${quoteIdent(colData)}) = @ano${filtroEstado}
       GROUP BY MONTH(a.${quoteIdent(colData)})
    `);
  const out = vazio();
  for (const x of r.recordset) out.set(Number(x.mes), Number(x.unidades ?? 0));
  return out;
}

/** Unidades por mês do circuito suspenso, já com a regra do sinal. */
async function unidadesSusp(
  pool: SqlPool,
  ano: number,
  cabTabela: string,
  cabPk: string,
  suspTabela: string,
  suspFk: string,
  colData: string,
  colTipo: string,
  colQtd: string,
): Promise<PorMes> {
  const tipos = [...CLASSIFICACAO[NAMESPACES.ATENDIMENTO_SUSP_DETALHE].peloSinal];
  const r = await pool
    .request()
    .input("ano", sql.Int, ano)
    .query<{ mes: number; unidades: number }>(`
      SELECT MONTH(h.${quoteIdent(colData)}) AS mes,
             SUM(CAST(d.${quoteIdent(colQtd)} AS FLOAT)) AS unidades
        FROM [dbo].${quoteIdent(suspTabela)} d
        JOIN [dbo].${quoteIdent(cabTabela)} h ON h.${quoteIdent(cabPk)} = d.${quoteIdent(suspFk)}
       WHERE YEAR(h.${quoteIdent(colData)}) = @ano
         AND h.${quoteIdent(colTipo)} IN (${tipos.join(",")})
         AND d.${quoteIdent(colQtd)} <> 0
       GROUP BY MONTH(h.${quoteIdent(colData)})
    `);
  const out = vazio();
  // O sinal já vem do ERP e a regra do circuito suspenso é exactamente
  // essa: positivo soma, negativo subtrai. Somar cru dá o líquido.
  for (const x of r.recordset) out.set(Number(x.mes), Number(x.unidades ?? 0));
  return out;
}

export async function vendasParidade(): Promise<number> {
  let args: Args;
  try {
    args = parseCmdArgs();
  } catch (err) {
    console.error("✗", err instanceof Error ? err.message : err);
    return 1;
  }
  if (args.help) {
    console.log("Uso: vendas-paridade [--ano 2026] [--db <base>]");
    console.log("");
    console.log("Read-only. Imprime as cinco populacoes por mes e compara-as");
    console.log("automaticamente com o relatorio oficial do SPharm.");
    return 0;
  }

  const base = loadConfig("sql");
  const cfg = args.db ? { ...base, sqlDatabase: args.db } : base;

  return withPool(cfg, async (pool) => {
    console.log(DOUBLE);
    console.log(`vendas-paridade ${args.ano} — READ-ONLY`);
    console.log(DOUBLE);
    console.log(`ERP: ${cfg.sqlDatabase}@${cfg.sqlHost}`);

    const [at, susp, cab] = await Promise.all([
      descobrirSchemaAtendimento(pool),
      descobrirSchemaSusp(pool),
      descobrirCabecalhoSusp(pool),
    ]);
    if (!at.dataVenda || !at.tipoDocumento) {
      console.log("✗ [Atendimento] sem data ou sem tipo de documento — nada a comparar.");
      return 1;
    }
    console.log("");
    console.log(
      `Circuito G  : data=${at.dataVenda} tipo=${at.tipoDocumento} estado=${at.fimVenda ?? "(nao existe)"}`,
    );
    console.log(
      `Suspenso    : ${susp.existe && cab.existe ? `${cab.tabela} pk=${cab.pk} fk=${susp.cabecalhoFk}` : "AUSENTE"}`,
    );

    // ── 1. O defeito, medido ──────────────────────────────────────
    console.log("");
    console.log(RULE);
    console.log("1. O QUE O GATE ANTIGO ESCONDIA — TipoDoc 7 / Fim Venda U");
    console.log(RULE);
    let apenasS = vazio();
    let comU = vazio();
    if (at.fimVenda) {
      apenasS = await unidadesG(pool, args.ano, at.dataVenda, at.tipoDocumento, at.fimVenda, ["S"]);
      comU = await unidadesG(pool, args.ano, at.dataVenda, at.tipoDocumento, at.fimVenda, ESTADOS_VENDA_G);
      console.log(`  ${"".padEnd(34)}${GATES_SILVEIRENSE_2026.map((g) => nomeMes(g.mes).padStart(8)).join("")}`);
      console.log(linhaMeses("so [Fim Venda]='S' (o gate antigo)", apenasS));
      console.log(linhaMeses("com 'S' e 'U' (o gate novo)", comU));
      const delta = vazio();
      for (const g of GATES_SILVEIRENSE_2026) {
        delta.set(g.mes, (comU.get(g.mes) ?? 0) - (apenasS.get(g.mes) ?? 0));
      }
      console.log(linhaMeses("ganho", delta));
      console.log(
        linhaMeses("esperado (medido no ERP)", new Map(GATES_SILVEIRENSE_2026.map((g) => [g.mes, g.tipoDoc7EstadoU]))),
      );
      console.log("");
      const gDelta = GATES_SILVEIRENSE_2026.map((g) =>
        avaliarGate(g.mes, g.tipoDoc7EstadoU, Math.round(delta.get(g.mes) ?? 0)),
      );
      for (const l of renderGates("GATE — o ganho bate com o inventario do ERP?", gDelta)) {
        console.log(l);
      }
    } else {
      console.log("  [Fim Venda] nao existe nesta instalacao — sem gate de estado.");
      comU = await unidadesG(pool, args.ano, at.dataVenda, at.tipoDocumento, null, null);
    }

    // ── 2. As cinco populações ────────────────────────────────────
    let suspensas = vazio();
    if (
      susp.existe && cab.existe && cab.pk && susp.cabecalhoFk &&
      cab.dataVenda && cab.tipoDocumento && susp.quantidade
    ) {
      suspensas = await unidadesSusp(
        pool, args.ano, cab.tabela, cab.pk, susp.tabela, susp.cabecalhoFk,
        cab.dataVenda, cab.tipoDocumento, susp.quantidade,
      );
    }
    const normal = soma(comU, suspensas);

    // ── O circuito [Atendimento Credito], por SÉRIE ──────────────
    //
    // A tabela chama-se "Credito" e as suas séries não são todas
    // crédito: na Silveirense a VCG_1 são guias de transferência. Quem
    // decide é a série, e séries por declarar aparecem à parte — nunca
    // somadas a uma natureza que ninguém confirmou.
    const credito = vazio();
    const transferencia = vazio();
    const porDeclarar = new Map<string, number>();
    const esquemaCredito = await descobrirSchemaCredito(pool);
    const rc = sqlAtendimentoCredito(esquemaCredito);
    let estadoCredito: string;
    let estadoTransf: string;

    if (rc.estado === "AUSENTE") {
      estadoCredito = "SEM TABELAS — este ERP não tem o circuito";
      estadoTransf = "SEM TABELAS — este ERP não tem o circuito";
    } else if (rc.estado === "POR_LIGAR") {
      estadoCredito = `SEM READER — falta: ${rc.faltam.join(", ")}`;
      estadoTransf = estadoCredito;
    } else {
      const r = await pool
        .request()
        .input("from", sql.NVarChar, `${args.ano}-01-01`)
        .input("to", sql.NVarChar, `${args.ano + 1}-01-01`)
        .query<{ mes: number; serie: string | null; unidades: number }>(`
          SELECT MONTH(h.${quoteIdent(esquemaCredito.data!)}) AS mes,
                 h.${quoteIdent(esquemaCredito.serie!)} AS serie,
                 SUM(CAST(d.${quoteIdent(esquemaCredito.quantidade!)} AS FLOAT)) AS unidades
            FROM [dbo].${quoteIdent(esquemaCredito.detalheTabela!)} d
            JOIN [dbo].${quoteIdent(esquemaCredito.cabecalhoTabela!)} h
              ON h.${quoteIdent(esquemaCredito.chaveLigacao!)} = d.${quoteIdent(esquemaCredito.chaveLigacao!)}
           WHERE h.${quoteIdent(esquemaCredito.data!)} >= @from
             AND h.${quoteIdent(esquemaCredito.data!)} < @to
             AND d.${quoteIdent(esquemaCredito.quantidade!)} <> 0
           GROUP BY MONTH(h.${quoteIdent(esquemaCredito.data!)}),
                    h.${quoteIdent(esquemaCredito.serie!)}
        `);
      for (const x of r.recordset) {
        const mes = Number(x.mes);
        const un = Number(x.unidades ?? 0);
        const ns = namespaceDaSerieCredito(x.serie);
        if (ns === NAMESPACES.GUIAS_TRANSFERENCIA) {
          transferencia.set(mes, (transferencia.get(mes) ?? 0) + un);
        } else if (ns === NAMESPACES.VENDAS_CREDITO) {
          credito.set(mes, (credito.get(mes) ?? 0) + un);
        } else {
          const s = (x.serie ?? "(nula)").trim();
          porDeclarar.set(s, (porDeclarar.get(s) ?? 0) + un);
        }
      }
      const totalC = [...credito.values()].reduce((a, b) => a + b, 0);
      const totalT = [...transferencia.values()].reduce((a, b) => a + b, 0);
      estadoCredito =
        totalC === 0
          ? "READER OK / ZERO DOCUMENTOS de crédito no período"
          : `READER OK — ${Math.round(totalC)} unidades`;
      estadoTransf =
        totalT === 0
          ? "READER OK / ZERO DOCUMENTOS de transferência no período"
          : `READER OK — ${Math.round(totalT)} unidades (serie VCG_1)`;
    }

    console.log("");
    console.log(RULE);
    console.log("2. AS CINCO POPULACOES, POR MES");
    console.log(RULE);
    console.log(`  ${"".padEnd(34)}${GATES_SILVEIRENSE_2026.map((g) => nomeMes(g.mes).padStart(8)).join("")}`);
    console.log(linhaMeses("NORMAL (G + suspenso)", normal));
    console.log(linhaMeses("CREDITO", credito));
    console.log(`      estado: ${estadoCredito}`);
    console.log(linhaMeses("TRANSFERENCIA", transferencia));
    console.log(`      estado: ${estadoTransf}`);
    console.log(linhaMeses("NORMAL + CREDITO", soma(normal, credito)));
    console.log(linhaMeses("NORMAL + CREDITO + TRANSF", soma(soma(normal, credito), transferencia)));
    console.log("");
    console.log("  'ZERO DOCUMENTOS' e 'SEM READER' sao coisas diferentes:");
    console.log("  a primeira e um facto sobre o ERP, a segunda e uma lacuna");
    console.log("  nossa. Um zero sem essa distincao le-se como facto.");
    if (porDeclarar.size > 0) {
      console.log("");
      console.log("  ⚠ SERIES DO CIRCUITO [Atendimento Credito] POR DECLARAR:");
      for (const [s, un] of porDeclarar) {
        console.log(`      ${s.padEnd(12)} ${Math.round(un)} unidades — RECUSADAS`);
      }
      console.log("    Nao foram somadas a natureza nenhuma. Declarar em");
      console.log("    SERIE_CIRCUITO_CREDITO so com confirmacao funcional:");
      console.log("    a VCC_1 da Segurado parece-se com a VCG_1 e nao ha prova");
      console.log("    de que signifique o mesmo.");
    }

    // ── 3. Os gates ───────────────────────────────────────────────
    console.log("");
    console.log(RULE);
    console.log("3. GATES CONTRA O RELATORIO OFICIAL DO SPHARM");
    console.log(RULE);
    const modoA = soma(normal, credito);
    const modoB = soma(modoA, transferencia);
    const gA = GATES_SILVEIRENSE_2026.map((g) =>
      avaliarGate(g.mes, g.normalMaisCredito, Math.round(modoA.get(g.mes) ?? 0)),
    );
    const gT = GATES_SILVEIRENSE_2026.map((g) =>
      avaliarGate(g.mes, g.transferencias, Math.round(transferencia.get(g.mes) ?? 0)),
    );
    const gB = GATES_SILVEIRENSE_2026.map((g) =>
      avaliarGate(g.mes, g.comTransferencias, Math.round(modoB.get(g.mes) ?? 0)),
    );
    for (const l of renderGates("MODO A — credito=ON, transferencias=OFF", gA)) console.log(l);
    console.log("");
    for (const l of renderGates("TRANSFERENCIA isolada (serie VCG_1)", gT)) console.log(l);
    console.log("");
    for (const l of renderGates("MODO B — credito=ON, transferencias=ON", gB)) console.log(l);

    // O veredicto, numa linha. Sem isto, fechar a fase depende de alguém
    // ler três tabelas e somar de cabeça.
    const todos = [
      ["MODO A", gA],
      ["TRANSFERENCIA", gT],
      ["MODO B", gB],
    ] as const;
    console.log("");
    console.log(RULE);
    const falhados = todos.filter(([, r]) => r.some((x) => !x.passa)).map(([n]) => n);
    if (falhados.length === 0) {
      console.log("  ✓ OS TRES GATES PASSAM 7/7 COM DESVIO ZERO.");
      console.log("    A paridade com o relatorio oficial esta fechada.");
    } else {
      console.log(`  ✗ GATES POR PASSAR: ${falhados.join(", ")}`);
      console.log("    NAO fazer backfill ate os tres passarem.");
    }
    console.log(RULE);

    console.log("");
    console.log(RULE);
    console.log("4. ONDE ESTAVAMOS");
    console.log(RULE);
    console.log(`  ${"".padEnd(34)}${GATES_SILVEIRENSE_2026.map((g) => nomeMes(g.mes).padStart(8)).join("")}`);
    console.log(linhaMeses("SPharm.MT antes desta ronda", new Map(Object.entries(ANTES_SPHARM_MT_2026).map(([m, v]) => [Number(m), v]))));
    console.log(linhaMeses("relatorio oficial (modo A)", new Map(GATES_SILVEIRENSE_2026.map((g) => [g.mes, g.normalMaisCredito]))));
    console.log(linhaMeses("agora (NORMAL + CREDITO)", modoA));

    console.log("");
    console.log(DOUBLE);
    console.log("FIM — nada foi escrito. Nenhum POST ao SaaS.");
    console.log(DOUBLE);
    return 0;
  });
}
