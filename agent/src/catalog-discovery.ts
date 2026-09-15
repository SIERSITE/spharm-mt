/**
 * agent/src/catalog-discovery.ts
 *
 * Descoberta e leitura do catálogo regulamentar (DCI, ATC, Grupo
 * Homogéneo, Fabricante) a partir do ERP da farmácia.
 *
 * Extraído de `commands/bootstrap-upload.ts` (rev46-52) para ser
 * partilhado com `commands/daily-sync-runner.ts` — o pipeline diário
 * agendado tinha o mesmo catálogo `dbo.Stocks` à sua frente, mas nunca
 * corria esta descoberta e por isso nunca enviava fabricante (nem os
 * outros três campos). A lógica de descoberta em si não mudou uma
 * vírgula: só saiu de um ficheiro de comando para um módulo que os dois
 * comandos importam.
 *
 * Os nomes das colunas variam entre instalações Softreis, por isso são
 * descobertos em runtime via `sys.columns` e não escritos à mão. Uma
 * coluna/FK que não exista nesta instalação cai a NULL no SELECT em vez
 * de partir a query — ver `buildCatalogSqlFragments`.
 */

import sql from "mssql";
import type { SqlPool } from "./sql-client.js";

/**
 * Plano de leitura do catálogo regulamentar. Para cada conceito
 * escolhe-se a coluna TEXTUAL com nome mais específico. Colunas
 * numéricas são ignoradas de propósito: um código interno do ERP (17)
 * não é uma DCI nem um ATC, e enviá-lo poluiria o catálogo central com
 * valores sem significado fora daquela instalação. Quando o valor real
 * vive numa tabela de lookup, `catalog-audit` mostra a chave e o JOIN
 * pode ser acrescentado aqui com evidência.
 */
export type CatalogPlan = {
  dci: string | null;
  atc: string | null;
  /** Coluna textual directa em Stocks (raro). */
  fabricante: string | null;
  /**
   * rev48 — fabricante por lookup, confirmado pelo catalog-audit da
   * Silveirense: Stocks.[GamaFabricanteID] (smallint, 98,8% preenchido,
   * 1084 distintos) contra dbo.tblGamaFabricante, PK GamaFabricanteID do
   * mesmo tipo, texto em [Descricao] varchar(74).
   *
   * Não há FK declarada — o Softreis quase não as declara — por isso a
   * ligação é confirmada por três evidências e não pela nomenclatura:
   * nome igual, tipo igual, e a coluna do lado do lookup é a PK.
   */
  fabricanteFk: { stocksColumn: string; table: string; pk: string; textColumn: string } | null;
  /**
   * rev52 — Grupo Homogéneo. Relação OBSERVADA na Silveirense em
   * 2026-08-11, não inferida por nomenclatura:
   *
   *   Stocks.[GrupoHomID] -> dbo.Stocks_GrupoHom.[GrupoHomID] -> [Descr]
   *
   * Porque está correcta: os dois lados contêm o mesmo código de domínio
   * (GH0052, GH0379) e não um inteiro que possa coincidir por acaso; o
   * lookup tem 1 002 linhas, zero GrupoHomID repetidos, logo o LEFT JOIN
   * não multiplica produtos. Medido: 18 743 produtos, 6 916 com
   * GrupoHomID, 3 944 resolvidos pelo lookup.
   *
   * Não é procurado por padrão de nome — foi exactamente isso que fez o
   * catalog-audit falhar esta coluna (nenhum de %homog%, %grupo hom%, %gh%
   * casa com "GrupoHomID"). Aqui só se confirma que existe.
   */
  grupoHomogeneoLookup: boolean;
};

/** Nomes fixos porque foram observados, não adivinhados. */
export const GH = { coluna: "GrupoHomID", tabela: "Stocks_GrupoHom", texto: "Descr" } as const;

/** Sentinela do ERP para "sem grupo homogéneo". */
export const GH_SEM_GRUPO = "GH0000";

/**
 * O plano de "nada detectado" — mesmo efeito de uma instalação sem
 * nenhuma destas colunas. Usado quando a descoberta ainda não correu
 * (ou não corre nesse caminho) para que `buildCatalogSqlFragments`
 * continue a produzir SQL válido em vez de exigir um plano de todos os
 * chamadores.
 */
export const EMPTY_CATALOG_PLAN: CatalogPlan = {
  dci: null,
  atc: null,
  fabricante: null,
  fabricanteFk: null,
  grupoHomogeneoLookup: false,
};

export async function discoverCatalogPlan(pool: SqlPool): Promise<CatalogPlan> {
  const r = await pool.request().query<{ nome: string; tipo: string }>(`
    SELECT c.name AS nome, ty.name AS tipo
    FROM sys.columns c
    JOIN sys.tables t  ON c.object_id = t.object_id
    JOIN sys.schemas s ON t.schema_id = s.schema_id
    JOIN sys.types ty  ON c.user_type_id = ty.user_type_id
    WHERE s.name = 'dbo' AND t.name = 'Stocks'
    ORDER BY c.column_id
  `);
  const textuais = r.recordset.filter((c) => /char|text/i.test(c.tipo));

  /** Primeira coluna textual que case com um dos padrões, por ordem de preferência. */
  const escolher = (padroes: RegExp[]): string | null => {
    for (const p of padroes) {
      const hit = textuais.find((c) => p.test(c.nome));
      if (hit) return hit.nome;
    }
    return null;
  };

  return {
    dci: escolher([/^dci$/i, /dci/i, /subst.nc/i, /princ.pio/i]),
    atc: escolher([/^atc$/i, /atc/i]),
    fabricante: escolher([/fabricante/i, /laborat/i, /titular/i, /marca/i]),
    fabricanteFk: await discoverFabricanteFk(pool, r.recordset),
    grupoHomogeneoLookup: await confirmarLookupGrupoHomogeneo(pool),
  };
}

/**
 * Confirma que a relação do Grupo Homogéneo existe nesta instalação. Não
 * procura nada: verifica os três nomes observados. Faltando um, o campo
 * vai NULL em vez de o upload rebentar numa instalação diferente.
 */
export async function confirmarLookupGrupoHomogeneo(pool: SqlPool): Promise<boolean> {
  const r = await pool.request().query<{ emStocks: number; noLookup: number }>(`
    SELECT
      (SELECT COUNT(*) FROM sys.columns
        WHERE object_id = OBJECT_ID('dbo.Stocks') AND name = '${GH.coluna}')      AS emStocks,
      (SELECT COUNT(*) FROM sys.columns
        WHERE object_id = OBJECT_ID('dbo.${GH.tabela}')
          AND name IN ('${GH.coluna}', '${GH.texto}'))                            AS noLookup
  `);
  const x = r.recordset[0];
  return Number(x?.emStocks ?? 0) === 1 && Number(x?.noLookup ?? 0) === 2;
}

/**
 * Procura o par (coluna de código em Stocks, tabela de lookup) para o
 * fabricante. Exige as três evidências, e devolve null se faltar uma —
 * sem lookup confirmado o payload leva fabricante=null em vez de um
 * código interno que não significa nada fora desta instalação.
 */
export async function discoverFabricanteFk(
  pool: SqlPool,
  stocksCols: Array<{ nome: string; tipo: string }>,
): Promise<CatalogPlan["fabricanteFk"]> {
  const candidatas = stocksCols.filter(
    (c) => /fabricante|laborat|titular/i.test(c.nome) && /int/i.test(c.tipo),
  );
  for (const col of candidatas) {
    // A tabela de lookup tem o nome da coluna sem o sufixo ID.
    const base = col.nome.replace(/id$/i, "");
    const r = await pool.request().input("b", sql.NVarChar, `%${base}%`).query<{
      tabela: string; pk: string; texto: string;
    }>(`
      SELECT TOP 1
        t.name AS tabela,
        pkc.name AS pk,
        txt.name AS texto
      FROM sys.tables t
      JOIN sys.schemas s ON s.schema_id = t.schema_id
      JOIN sys.indexes i ON i.object_id = t.object_id AND i.is_primary_key = 1
      JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
      JOIN sys.columns pkc ON pkc.object_id = ic.object_id AND pkc.column_id = ic.column_id
      JOIN sys.columns txt ON txt.object_id = t.object_id
      JOIN sys.types ty ON ty.user_type_id = txt.user_type_id
      WHERE s.name = 'dbo' AND t.name LIKE @b
        AND pkc.name = '${col.nome.replace(/'/g, "''")}'
        AND ty.name IN ('varchar','nvarchar','char','nchar')
      ORDER BY txt.max_length DESC
    `);
    const hit = r.recordset[0];
    if (hit) {
      return { stocksColumn: col.nome, table: hit.tabela, pk: hit.pk, textColumn: hit.texto };
    }
  }
  return null;
}

export function logCatalogPlan(plan: CatalogPlan): void {
  const f = (label: string, col: string | null) =>
    console.log(`     ${label.padEnd(16)} ${col ? `Stocks.[${col}]` : "✗ não detectada — enviado NULL"}`);
  console.log("  Plano de catálogo regulamentar:");
  f("DCI:", plan.dci);
  f("ATC:", plan.atc);
  f("Fabricante:", plan.fabricante);
  console.log(
    `     ${"Grupo Homog. :".padEnd(16)} ${
      plan.grupoHomogeneoLookup
        ? `Stocks.[${GH.coluna}] -> ${GH.tabela}.[${GH.coluna}] -> [${GH.texto}]  (${GH_SEM_GRUPO} = sem grupo)`
        : "✗ lookup ausente — enviado NULL"
    }`,
  );
  if (plan.fabricanteFk) {
    const k = plan.fabricanteFk;
    console.log(`     ${"Fabricante (FK):".padEnd(16)} Stocks.[${k.stocksColumn}] -> ${k.table}.[${k.pk}] -> [${k.textColumn}]`);
  }
  if (!plan.dci && !plan.atc && !plan.grupoHomogeneoLookup && !plan.fabricante && !plan.fabricanteFk) {
    console.log("     Nenhum campo detectado nesta instalação — o catálogo vai sem enriquecimento do ERP.");
  }
}

/** Fragmentos SQL (SELECT + JOIN) resolvidos a partir de um `CatalogPlan`. */
export type CatalogSqlFragments = {
  dciSelect: string;
  atcSelect: string;
  ghSelect: string;
  ghJoin: string;
  fabricanteSelect: string;
  fabricanteJoin: string;
};

/**
 * Traduz um `CatalogPlan` nos fragmentos SQL a colar no SELECT/FROM
 * principal. Função pura — sem pool, sem I/O — por isso testável sem
 * SQL Server: dá-se-lhe um plano simulado e confirma-se o SQL gerado.
 *
 * Coluna/FK não detectada nesta instalação → `CAST(NULL AS NVARCHAR(200))`
 * em vez de um nome de coluna que rebentaria a query.
 */
export function buildCatalogSqlFragments(plan: CatalogPlan): CatalogSqlFragments {
  const col = (c: string | null) => (c ? `s.[${c}]` : `CAST(NULL AS NVARCHAR(200))`);
  const dciSelect = col(plan.dci);
  const atcSelect = col(plan.atc);
  // Grupo Homogéneo: descrição do lookup, nunca o código interno — GH0052
  // não significa nada fora desta instalação; "Paracetamol | A101 | Oral |
  // 1000 mg" significa em todas.
  const ghSelect = plan.grupoHomogeneoLookup
    ? `gh_lk.[${GH.texto}]`
    : `CAST(NULL AS NVARCHAR(200))`;
  // A sentinela fica de fora do JOIN: "sem grupo" tem de chegar ao SaaS
  // como NULL e não como uma descrição de grupo que não existe.
  //
  // Numa única linha (e não uma por cláusula, como na versão original em
  // bootstrap-upload.ts): `sql-validador.ts` só lê `ON` na MESMA linha do
  // `JOIN` — um `catalogo-retirado-diario.test.ts` que passe esta query
  // por `validarSelect` via `buildProductsSql` via-a partir aqui.
  const ghJoin = plan.grupoHomogeneoLookup
    ? `LEFT JOIN [dbo].[${GH.tabela}] gh_lk ON gh_lk.[${GH.coluna}] = s.[${GH.coluna}] AND s.[${GH.coluna}] <> '${GH_SEM_GRUPO}'`
    : ``;
  // Coluna directa se existir; senão o texto do lookup confirmado.
  const fabricanteSelect = plan.fabricante
    ? `s.[${plan.fabricante}]`
    : plan.fabricanteFk
      ? `fab_lk.[${plan.fabricanteFk.textColumn}]`
      : `CAST(NULL AS NVARCHAR(200))`;
  const fabricanteJoin = !plan.fabricante && plan.fabricanteFk
    ? `LEFT JOIN [dbo].[${plan.fabricanteFk.table}] fab_lk ON fab_lk.[${plan.fabricanteFk.pk}] = s.[${plan.fabricanteFk.stocksColumn}]`
    : ``;
  return { dciSelect, atcSelect, ghSelect, ghJoin, fabricanteSelect, fabricanteJoin };
}

/** Os quatro campos regulamentares, crus como vêm do driver SQL. */
export type CatalogFieldsRaw = {
  dci: unknown;
  codigoATC: unknown;
  grupoHomogeneo: unknown;
  fabricante: unknown;
};

/** Os mesmos quatro campos, coeridos para o payload canónico. */
export type CatalogFieldsPayload = {
  dci: string | null;
  codigoATC: string | null;
  grupoHomogeneo: string | null;
  fabricante: string | null;
};

function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s === "" ? null : s;
}

/** Mesma coerção defensiva usada no resto dos payloads do agent. */
export function catalogFieldsToPayload(r: CatalogFieldsRaw): CatalogFieldsPayload {
  return {
    dci: strOrNull(r.dci),
    codigoATC: strOrNull(r.codigoATC),
    grupoHomogeneo: strOrNull(r.grupoHomogeneo),
    fabricante: strOrNull(r.fabricante),
  };
}
