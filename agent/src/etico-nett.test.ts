/**
 * agent/src/etico-nett.test.ts
 *
 * Classificação Ético/NETT no agent (rev99), SEM SQL Server: um «pool» falso devolve o que o ERP devolveria.
 *
 *   A · descoberta: sem coluna; coluna + lookup; lookup em falta; colunas não reconhecidas; erro de leitura;
 *   B · lookups de farmácias DIFERENTES (códigos distintos) -> a decisão é pela descrição;
 *   C · payload: ETICO/NETT, Serviço/desconhecido/ambíguo/órfão -> null (aviso), sem código -> omitido;
 *   D · SQL gerado: o universo (WHERE) é IDÊNTICO com e sem classificação; a coluna cai a NULL sem plano;
 *   E · compatibilidade rev98: payload sem plano = payload anterior (sem chaves novas); `.map` não confunde índice com plano;
 *   F · logs: só estrutura e contagens (nunca o lookup nem descrições nem segredos).
 *
 * Uso: npx tsx agent/src/etico-nett.test.ts
 */
import {
  descobrirEticoNett,
  descreverContagensEticoNett,
  descreverPlanoEticoNett,
  eticoNettParaPayload,
  eticoNettSelect,
  resolverLookupEticoNett,
  type PlanoEticoNett,
} from "./etico-nett.js";
import { buildProductsSql, rowToProductPayload, type SchemaCapabilities } from "./commands/daily-sync-runner.js";
import type { SqlPool } from "./sql-client.js";

let pass = 0;
let fail = 0;
const ok = (label: string, cond: boolean, extra?: string) => {
  if (cond) { pass++; console.log(`  [OK]    ${label}`); }
  else { fail++; console.log(`  [FALHA] ${label}${extra ? ` — ${extra}` : ""}`); }
};

type Col = { tabela: string; nome: string; tipo: string };
function poolFalso(opts: { colunas: Col[]; lookup?: Array<{ codigo: unknown; descricao: unknown }>; falhaNaLeitura?: boolean }): SqlPool {
  return {
    request: () => ({
      query: async (texto: string) => {
        if (/sys\.columns/i.test(texto)) return { recordset: opts.colunas };
        if (/FROM \[dbo\]\.\[Etico_NETT\]/i.test(texto)) {
          if (opts.falhaNaLeitura) throw new Error("Login failed for user 'sa' on server SECRETO\\SQL (senha=abc123)");
          return { recordset: opts.lookup ?? [] };
        }
        return { recordset: [] };
      },
    }),
  } as unknown as SqlPool;
}
const COL_STOCKS: Col = { tabela: "Stocks", nome: "Etico_NETT", tipo: "tinyint" };
const COLS_LOOKUP: Col[] = [
  { tabela: "Etico_NETT", nome: "Codigo", tipo: "tinyint" },
  { tabela: "Etico_NETT", nome: "Tipo", tipo: "nvarchar" },
];

async function main() {
  console.log("\n=== A. descoberta ===");
  const semColuna = await descobrirEticoNett(poolFalso({ colunas: [] }));
  ok("sem Stocks.Etico_NETT -> sem coluna, nada enviado", semColuna.stocksColuna === null && semColuna.lookup === null);
  ok("…e o SELECT cai a NULL (a query nunca se parte)", eticoNettSelect(semColuna) === "CAST(NULL AS INT)");
  ok("…e o payload não leva nenhuma chave", Object.keys(eticoNettParaPayload(semColuna, 1)).length === 0);

  const normal = await descobrirEticoNett(poolFalso({
    colunas: [COL_STOCKS, ...COLS_LOOKUP],
    lookup: [{ codigo: 1, descricao: "Éticos" }, { codigo: 2, descricao: "NETT" }, { codigo: 3, descricao: "Serviços" }, { codigo: 4, descricao: "Sacos L." }, { codigo: 5, descricao: "Outros" }],
  }));
  ok("coluna + lookup: 2 resolvidos, 3 ignorados", normal.lookup?.porCodigo.size === 2 && normal.lookup?.ignoradas === 3 && normal.lookupAusente === null);
  ok("…SELECT usa s.[Etico_NETT]", eticoNettSelect(normal) === "s.[Etico_NETT]");

  const semTabela = await descobrirEticoNett(poolFalso({ colunas: [COL_STOCKS] }));
  ok("coluna sem tabela de lookup -> lookup ausente (aviso), coluna mantém-se", semTabela.stocksColuna === "Etico_NETT" && semTabela.lookup === null && semTabela.lookupAusente === "SEM_TABELA");
  const colsEstranhas = await descobrirEticoNett(poolFalso({
    colunas: [COL_STOCKS, { tabela: "Etico_NETT", nome: "Codigo", tipo: "tinyint" }, { tabela: "Etico_NETT", nome: "A", tipo: "nvarchar" }, { tabela: "Etico_NETT", nome: "B", tipo: "nvarchar" }],
  }));
  ok("duas colunas de texto sem «Tipo» -> não adivinha", colsEstranhas.lookup === null && colsEstranhas.lookupAusente === "COLUNAS_NAO_RECONHECIDAS");
  const erro = await descobrirEticoNett(poolFalso({ colunas: [COL_STOCKS, ...COLS_LOOKUP], falhaNaLeitura: true }));
  ok("erro ao ler o lookup -> degrada para «sem lookup», não rebenta", erro.lookup === null && erro.lookupAusente === "ERRO_LEITURA");
  const logErro = descreverPlanoEticoNett(erro);
  ok("o aviso não repete a mensagem do SQL (servidor/utilizador/senha)", !/SECRETO|abc123|sa'|senha/i.test(logErro), logErro);

  console.log("\n=== B. lookups com códigos DIFERENTES entre farmácias ===");
  const fA = await descobrirEticoNett(poolFalso({ colunas: [COL_STOCKS, ...COLS_LOOKUP], lookup: [{ codigo: 1, descricao: "Éticos" }, { codigo: 2, descricao: "NETT" }] }));
  const fB = await descobrirEticoNett(poolFalso({ colunas: [COL_STOCKS, ...COLS_LOOKUP], lookup: [{ codigo: 9, descricao: "ETICO" }, { codigo: 7, descricao: "nett" }, { codigo: 1, descricao: "Serviços" }] }));
  ok("farmácia A: código 1 -> ETICO", eticoNettParaPayload(fA, 1).eticoNett === "ETICO");
  ok("farmácia B: o MESMO código 1 -> null (é Serviço lá)", eticoNettParaPayload(fB, 1).eticoNett === null);
  ok("farmácia B: 9 -> ETICO e 7 -> NETT", eticoNettParaPayload(fB, 9).eticoNett === "ETICO" && eticoNettParaPayload(fB, 7).eticoNett === "NETT");
  const variantes = await descobrirEticoNett(poolFalso({ colunas: [COL_STOCKS, ...COLS_LOOKUP], lookup: [{ codigo: 3, descricao: "  ÉTICOS. " }, { codigo: 4, descricao: "Nett" }] }));
  ok("capitalização/acentos/pontuação: «  ÉTICOS. » e «Nett» reconhecidos", eticoNettParaPayload(variantes, 3).eticoNett === "ETICO" && eticoNettParaPayload(variantes, 4).eticoNett === "NETT");

  console.log("\n=== C. payload ===");
  const p = eticoNettParaPayload(fA, 1);
  ok("ETICO leva código e descrição originais", p.eticoNett === "ETICO" && p.eticoNettCodigo === 1 && p.eticoNettDescricao === "Éticos");
  ok("código órfão (não existe no lookup) -> null, sem inventar", eticoNettParaPayload(fA, 42).eticoNett === null);
  ok("código ausente (NULL no ERP) -> campos omitidos", Object.keys(eticoNettParaPayload(fA, null)).length === 0);
  const ambiguo = await descobrirEticoNett(poolFalso({ colunas: [COL_STOCKS, ...COLS_LOOKUP], lookup: [{ codigo: 1, descricao: "Éticos" }, { codigo: 6, descricao: "ETICO" }, { codigo: 2, descricao: "NETT" }] }));
  ok("lookup ambíguo (2 códigos Ético) -> ambos null; NETT continua", eticoNettParaPayload(ambiguo, 1).eticoNett === null && eticoNettParaPayload(ambiguo, 6).eticoNett === null && eticoNettParaPayload(ambiguo, 2).eticoNett === "NETT");
  const semLookup = eticoNettParaPayload(semTabela, 1);
  ok("lookup em falta -> null (aviso), nunca ETICO por «código 1»", semLookup.eticoNett === null);
  const fC = await descobrirEticoNett(poolFalso({ colunas: [COL_STOCKS, ...COLS_LOOKUP], lookup: [{ codigo: 1, descricao: "Éticos" }, { codigo: 2, descricao: "NETT" }] }));
  eticoNettParaPayload(fC, 1); eticoNettParaPayload(fC, 2); eticoNettParaPayload(fC, 42); eticoNettParaPayload(fC, null);
  const c = fC.contagens;
  ok("contagens do ciclo", c.etico === 1 && c.nett === 1 && c.naoClassificados === 1 && c.semCodigo === 1, JSON.stringify(c));

  console.log("\n=== D. SQL gerado: o universo não muda ===");
  const BASE: SchemaCapabilities = { hasStocksMov: true, stocksMovDateCol: "DataMov", hasDataActualiz: true };
  const COM: SchemaCapabilities = { ...BASE, eticoNettPlano: normal };
  const semPlano = buildProductsSql(BASE);
  const comPlano = buildProductsSql(COM);
  const tiraClassificacao = (q: string) => q.replace(/,\s*s\.\[Etico_NETT\] AS eticoNettCodigo/, "").replace(/,\s*CAST\(NULL AS INT\) AS eticoNettCodigo/, "");
  ok("com plano: a única diferença é a coluna s.[Etico_NETT]", tiraClassificacao(comPlano) === tiraClassificacao(semPlano));
  ok("sem plano: coluna é CAST(NULL AS INT)", /CAST\(NULL AS INT\) AS eticoNettCodigo/.test(semPlano));
  const whereDe = (q: string) => q.slice(q.indexOf("WHERE"));
  ok("o WHERE (universo) é idêntico", whereDe(semPlano) === whereDe(comPlano));
  ok("o filtro Processa_Stocks/Retirado não foi tocado", /Retirado\] = 0/.test(comPlano));
  const full = buildProductsSql(COM, "full");
  ok("scope=full também só acrescenta a coluna", tiraClassificacao(full) === tiraClassificacao(buildProductsSql(BASE, "full")));
  ok("o SQL só lê (sem INSERT/UPDATE/DELETE/EXEC)", !/\b(INSERT|UPDATE|DELETE|MERGE|EXEC|ALTER|DROP|TRUNCATE)\b/i.test(comPlano));

  console.log("\n=== E. compatibilidade rev98 ===");
  const linha = { externalProductId: 1, cnp: 5000001, designacao: "X", pvp: 1, pmc: 1, puc: 1, dataUltimaVenda: null, dataUltimaCompra: null, retirado: false, generico: false, mnsrmNCompart: false, fornecedorHabitualId: null, fornecedorHabitualNome: null, dci: null, codigoATC: null, grupoHomogeneo: null, fabricante: null };
  const rev98 = rowToProductPayload(linha as never);
  ok("sem plano o payload NÃO tem chaves eticoNett*", !Object.keys(rev98).some((k) => k.startsWith("eticoNett")));
  const fresh = await descobrirEticoNett(poolFalso({ colunas: [COL_STOCKS, ...COLS_LOOKUP], lookup: [{ codigo: 2, descricao: "NETT" }] }));
  const comLinha = rowToProductPayload({ ...linha, eticoNettCodigo: 2 } as never, fresh);
  ok("com plano: NETT no payload, o resto igual", comLinha.eticoNett === "NETT" && comLinha.generico === false && comLinha.cnp === 5000001);
  const mapeado = [{ ...linha, eticoNettCodigo: 2 }].map((r) => rowToProductPayload(r as never, fresh));
  ok("generico continua a vir de Stocks.Generico (sem segunda classificação)", mapeado[0]!.generico === false && !("genericoErp" in mapeado[0]!));
  // `rs.recordset.map(rowToProductPayload)` passaria o ÍNDICE como plano: tem de ser inofensivo mesmo assim.
  const viaMapDireto = ([linha] as never[]).map(rowToProductPayload as never);
  ok("passar o índice do .map como 2.º argumento não rebenta nem classifica", viaMapDireto.length === 1);

  console.log("\n=== C2. transições: outra categoria conhecida vs desconhecido ===");
  const tr = await descobrirEticoNett(poolFalso({
    colunas: [COL_STOCKS, ...COLS_LOOKUP],
    lookup: [{ codigo: 1, descricao: "Éticos" }, { codigo: 2, descricao: "NETT" }, { codigo: 3, descricao: "Serviços" }, { codigo: 4, descricao: "Sacos L." }, { codigo: 5, descricao: "Outros" }, { codigo: 6, descricao: "Coisa nova" }, { codigo: 7, descricao: "" }],
  }));
  for (const [cod, desc] of [[3, "Serviços"], [4, "Sacos L."], [5, "Outros"]] as const) {
    const pl = eticoNettParaPayload(tr, cod);
    ok(`código ${cod} (${desc}) -> eticoNett null + eticoNettOutraCategoria + descrição`, pl.eticoNett === null && pl.eticoNettOutraCategoria === true && pl.eticoNettDescricao === desc);
  }
  ok("categoria desconhecida -> null SEM flag (preserva)", eticoNettParaPayload(tr, 6).eticoNettOutraCategoria === undefined && eticoNettParaPayload(tr, 6).eticoNett === null);
  ok("descrição vazia -> null SEM flag (preserva)", eticoNettParaPayload(tr, 7).eticoNettOutraCategoria === undefined);
  ok("contagens: 3 de outra categoria, 3 leituras sem categoria reconhecível (6 duas vezes, 7)", tr.contagens.outraCategoria === 3 && tr.contagens.naoClassificados === 3, JSON.stringify(tr.contagens));

  console.log("\n=== F. logs sem dados ===");
  const log = descreverPlanoEticoNett(normal) + " " + descreverContagensEticoNett(normal);
  ok("só contagens/estrutura (sem «Serviços», «Sacos», «Outros»)", !/Servi|Sacos|Outros/i.test(log), log);
  ok("sem a palavra password/secret/connection", !/password|secret|connection|senha/i.test(log));
  ok("resolverLookupEticoNett exportado e puro", resolverLookupEticoNett([]).porCodigo.size === 0);
  void (null as PlanoEticoNett | null);

  console.log(`\n${pass} OK, ${fail} FALHA(S)`);
  process.exit(fail === 0 ? 0 : 1);
}
main();
