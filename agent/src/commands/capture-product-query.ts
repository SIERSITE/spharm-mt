/**
 * agent/src/commands/capture-product-query.ts
 *
 * Captura a(s) query(s) que o próprio SPharm executa ao abrir a ficha de
 * um produto, e escreve-as em run/product-query.sql.
 *
 * Porquê: descobrir a estrutura da base por auditoria esgotou o retorno —
 * provou o Fabricante e falhou o Grupo Homogéneo, a DCI e o ATC. O ERP
 * mostra os quatro campos no ecrã, portanto a lógica existe e está
 * escrita. É mais barato lê-la do que reconstruí-la.
 *
 * Faz tudo sozinho: cria a sessão de Extended Events, espera pelo
 * operador, pára, lê o ficheiro, filtra o que interessa e apaga a sessão.
 * Nada fica para trás no servidor, mesmo que falhe a meio.
 *
 * Serve qualquer instalação, não só esta: o mesmo diagnóstico vai ser
 * preciso na próxima farmácia com um SPharm diferente.
 *
 * Requer no SQL Server: VIEW SERVER STATE e ALTER ANY EVENT SESSION. A
 * conta read-only do agent NÃO chega — ver a verificação de permissões,
 * que falha cedo e diz o que falta em vez de rebentar a meio.
 *
 * Uso: agent capture-product-query
 */
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import sql from "mssql";
import { loadConfig } from "../config.js";
import { withPool, type SqlPool } from "../sql-client.js";

const RULE = "=".repeat(72);
const SESSAO = "SPharmMT_FichaProduto";
/** No servidor, não no PC de quem corre o agent. */
const DIR_XEL = "C:\\Temp";

/** Sinais de que uma query serve para o que queremos. */
const RELEVANTE = /GrupoHom|SPRAct|\bDCI\b|Generico|GamaFabricante|Fabricante|Laborat|\bATC\b/i;

async function esperarEnter(msg: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>((resolve) => rl.question(msg, () => resolve()));
  rl.close();
}

async function podeCriarSessao(pool: SqlPool): Promise<string | null> {
  try {
    const r = await pool.request().query<{ vss: number; alter: number }>(`
      SELECT
        CONVERT(int, HAS_PERMS_BY_NAME(NULL, NULL, 'VIEW SERVER STATE')) AS vss,
        CONVERT(int, HAS_PERMS_BY_NAME(NULL, NULL, 'ALTER ANY EVENT SESSION')) AS alter`);
    const p = r.recordset[0];
    if (!p) return "não foi possível verificar permissões";
    const faltam: string[] = [];
    if (!p.vss) faltam.push("VIEW SERVER STATE");
    if (!p.alter) faltam.push("ALTER ANY EVENT SESSION");
    return faltam.length ? faltam.join(" e ") : null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export async function captureProductQuery(): Promise<number> {
  let cfg;
  try {
    cfg = loadConfig("sql");
  } catch (err) {
    console.error("Config invalida:");
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  console.log(RULE);
  console.log("  Captura da query da ficha de produto do SPharm");
  console.log("  Read-only sobre os dados. Cria e apaga uma sessao de diagnostico.");
  console.log(RULE);

  return withPool(cfg, async (pool) => {
    const db = cfg.sqlDatabase;

    const faltam = await podeCriarSessao(pool);
    if (faltam) {
      console.error(`\nSem permissoes para capturar: falta ${faltam}.`);
      console.error("A conta read-only do agent nao chega para Extended Events.");
      console.error("Corre este comando com um login administrador do SQL Server");
      console.error("(sa ou Windows admin da maquina), so para este diagnostico.");
      return 2;
    }

    // Sessão de uma corrida anterior que tenha ficado para trás.
    await pool.request().query(
      `IF EXISTS (SELECT 1 FROM sys.server_event_sessions WHERE name = '${SESSAO}')
         DROP EVENT SESSION [${SESSAO}] ON SERVER;`,
    ).catch(() => undefined);

    let criada = false;
    try {
      const ficheiro = path.join(DIR_XEL, `${SESSAO}.xel`).replace(/\\/g, "\\\\");
      await pool.request().input("db", sql.NVarChar, db).query(`
        DECLARE @sql nvarchar(max) = N'
        CREATE EVENT SESSION [${SESSAO}] ON SERVER
        ADD EVENT sqlserver.sql_batch_completed (
            ACTION (sqlserver.sql_text, sqlserver.client_app_name)
            WHERE (sqlserver.database_name = N''' + @db + N''')),
        ADD EVENT sqlserver.rpc_completed (
            ACTION (sqlserver.sql_text, sqlserver.client_app_name)
            WHERE (sqlserver.database_name = N''' + @db + N'''))
        ADD TARGET package0.event_file (
            SET filename = N''${ficheiro}'', max_file_size = 50)
        WITH (MAX_DISPATCH_LATENCY = 5 SECONDS, STARTUP_STATE = OFF);';
        EXEC sp_executesql @sql;`);
      criada = true;
      await pool.request().query(`ALTER EVENT SESSION [${SESSAO}] ON SERVER STATE = START;`);
      console.log(`\nCaptura iniciada (base ${db}).`);

      console.log("");
      await esperarEnter(
        "  Abra agora a ficha do produto no SPharm e prima ENTER quando terminar. ",
      );

      await pool.request().query(`ALTER EVENT SESSION [${SESSAO}] ON SERVER STATE = STOP;`);
      console.log("\nCaptura terminada. A analisar...");

      const rows = await pool.request().query<{ app: string | null; query: string | null }>(`
        SELECT
          CAST(event_data AS xml).value('(event/action[@name="client_app_name"]/value)[1]','nvarchar(256)') AS app,
          CAST(event_data AS xml).value('(event/action[@name="sql_text"]/value)[1]','nvarchar(max)')      AS query
        FROM sys.fn_xe_file_target_read_file('${DIR_XEL}\\${SESSAO}*.xel', NULL, NULL, NULL)`);

      const todas = rows.recordset
        .map((r) => ({ app: r.app ?? "", query: (r.query ?? "").trim() }))
        .filter((r) => r.query.length > 0);

      // Dedup: o ERP repete a mesma query em cada abertura de ficha.
      const vistas = new Set<string>();
      const unicas = todas.filter((r) => {
        const k = r.query.replace(/\s+/g, " ").toLowerCase();
        if (vistas.has(k)) return false;
        vistas.add(k);
        return true;
      });

      const relevantes = unicas.filter((r) => RELEVANTE.test(r.query));
      const tocamStocks = unicas.filter((r) => /\bStocks\b/i.test(r.query) && !RELEVANTE.test(r.query));

      console.log(`  ${todas.length} eventos · ${unicas.length} queries distintas`);
      console.log(`  ${relevantes.length} com DCI / Grupo Homogeneo / ATC / Fabricante`);
      console.log(`  ${tocamStocks.length} outras que tocam em Stocks`);

      const L: string[] = [];
      L.push(`-- Queries capturadas do SPharm ao abrir a ficha de um produto.`);
      L.push(`-- Base: ${db} · ${new Date().toISOString()}`);
      L.push(`-- ${unicas.length} queries distintas de ${todas.length} eventos.`);
      L.push(``);
      const bloco = (titulo: string, lista: typeof unicas) => {
        if (!lista.length) return;
        L.push(`-- ${"=".repeat(68)}`);
        L.push(`-- ${titulo}`);
        L.push(`-- ${"=".repeat(68)}`);
        for (const r of lista) {
          L.push(``, `-- aplicacao: ${r.app || "(sem nome)"}`, r.query, ``, `GO`, ``);
        }
      };
      bloco("RELEVANTES — devolvem DCI, Grupo Homogeneo, ATC ou Fabricante", relevantes);
      bloco("OUTRAS que leem Stocks", tocamStocks);
      if (!relevantes.length && !tocamStocks.length) {
        L.push(`-- Nenhuma query tocou em Stocks nem nos campos procurados.`);
        L.push(`-- Ou a ficha nao foi aberta durante a captura, ou o SPharm`);
        L.push(`-- obtem estes dados fora do SQL Server (cache local, DLL).`);
      }

      if (!existsSync("./run")) mkdirSync("./run", { recursive: true });
      const destino = path.join("./run", "product-query.sql");
      writeFileSync(destino, L.join("\n"), "utf8");

      console.log(`\n${RULE}`);
      console.log(`  ${destino}`);
      console.log(RULE);
      if (relevantes.length) {
        console.log("\n  ENCONTRADO. Envie este ficheiro — a investigacao termina aqui.");
        for (const r of relevantes.slice(0, 3)) {
          console.log(`\n  ${r.query.replace(/\s+/g, " ").slice(0, 240)}`);
        }
      } else {
        console.log("\n  Nenhuma query com os campos procurados.");
        console.log("  Confirme que a ficha foi mesmo aberta entre o arranque e o ENTER.");
      }
      return 0;
    } finally {
      // Apagar SEMPRE. Uma sessao esquecida continua a escrever no disco
      // do servidor da farmacia muito depois de o diagnostico acabar.
      if (criada) {
        try {
          await pool.request().query(
            `IF EXISTS (SELECT 1 FROM sys.dm_xe_sessions WHERE name = '${SESSAO}')
               ALTER EVENT SESSION [${SESSAO}] ON SERVER STATE = STOP;
             IF EXISTS (SELECT 1 FROM sys.server_event_sessions WHERE name = '${SESSAO}')
               DROP EVENT SESSION [${SESSAO}] ON SERVER;`,
          );
          console.log("\n  Sessao de diagnostico removida do servidor.");
        } catch (err) {
          console.error(`\n  AVISO: nao foi possivel remover a sessao [${SESSAO}].`);
          console.error(`  Remova a mao:  DROP EVENT SESSION [${SESSAO}] ON SERVER;`);
          console.error(`  ${err instanceof Error ? err.message : err}`);
        }
      }
    }
  });
}
