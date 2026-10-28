/**
 * agent/src/classificacao-erp.test.ts
 *
 * Mapeamento OPCIONAL de Ético / NETT / Serviço (agent.config.json →
 * classificacaoErp). Sem SQL Server: tudo sobre funções puras e sobre a
 * query GERADA (a prova final é o dry-run contra o ERP real).
 *
 * Garante:
 *   · sem secção → nenhum SQL extra e nenhum campo etico/nett/servico;
 *   · identificadores validados (sem injecção) e confirmados no schema;
 *   · interpretação de valores sem adivinhar (fora do mapeamento → null);
 *   · a query completa continua válida (validarSelect) com e sem mapeamento;
 *   · genericoErp tri-estado derivado da coluna já lida.
 *
 * Uso: npx tsx agent/src/classificacao-erp.test.ts
 */
import {
  parseClassificacaoErpConfig,
  interpretarValor,
  construirPlanoClassificacao,
  buildClassificacaoSqlFragments,
  classificacaoParaPayload,
  novaEstatisticaClassificacao,
  resumoEstatisticaClassificacao,
  EMPTY_CLASSIFICACAO_PLAN,
  identificadorValido,
  type ClassificacaoErpConfig,
} from "./classificacao-erp.js";
import { buildProductsSql, rowToProductPayload, type SchemaCapabilities } from "./commands/daily-sync-runner.js";
import { sqlTopValores, sqlResumoColuna, sqlCruzamento, likeMatch, q, PADROES_COLUNA } from "./commands/classification-audit.js";
import { validarSelect } from "./sql-validador.js";

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string, extra?: string) => {
  if (cond) {
    pass++;
    console.log(`  [OK]    ${label}`);
  } else {
    fail++;
    console.log(`  [FALHA] ${label}${extra ? ` — ${extra}` : ""}`);
  }
};
const eq = (label: string, obtido: unknown, esperado: unknown) =>
  ok(JSON.stringify(obtido) === JSON.stringify(esperado), label, `obtido ${JSON.stringify(obtido)}, esperado ${JSON.stringify(esperado)}`);

const CAPS: SchemaCapabilities = { hasStocksMov: true, stocksMovDateCol: "DataMov", hasDataActualiz: true };

// Schema simulado (nomes SINTÉTICOS — nada disto é conhecimento do ERP real).
const SCHEMA: Record<string, string[]> = {
  stocks: ["CodigoID", "ColA", "ColB", "Coluna C"],
  tabx: ["Chave", "ValorX"],
};
const existe = {
  tabela: (t: string) => t.toLowerCase() in SCHEMA,
  coluna: (t: string, c: string) => SCHEMA[t.toLowerCase()]?.find((x) => x.toLowerCase() === c.toLowerCase()) ?? null,
};

console.log("\n=== A. parse da configuração ===");
{
  eq("sem secção → vazio e sem erros", parseClassificacaoErpConfig(undefined), { config: {}, erros: [] });
  const bom = parseClassificacaoErpConfig({
    etico: { coluna: "ColA", valoresVerdadeiros: [1] },
    nett: { tabela: "TabX", chave: "Chave", coluna: "ValorX", valoresVerdadeiros: ["S"], valoresFalsos: ["N"] },
  });
  eq("config válida sem erros", bom.erros, []);
  ok(bom.config.etico?.coluna === "ColA" && bom.config.nett?.tabela === "TabX", "campos mantidos");
  ok(bom.config.servico === undefined, "campo não configurado fica de fora");

  const inj = parseClassificacaoErpConfig({ etico: { coluna: "ColA]; DROP TABLE x;--", valoresVerdadeiros: [1] } });
  ok(inj.erros.length === 1 && inj.config.etico === undefined, "coluna com injecção é rejeitada");
  ok(!identificadorValido("a]b") && !identificadorValido("a'b") && !identificadorValido(" x") && identificadorValido("Coluna C") && identificadorValido("Ético"), "identificadorValido: sem brackets/aspas, aceita espaço e acentos");

  ok(parseClassificacaoErpConfig({ etico: { coluna: "ColA" } }).erros.some((e) => e.includes("valoresVerdadeiros")), "valoresVerdadeiros é obrigatório");
  ok(parseClassificacaoErpConfig({ etico: { coluna: "ColA", valoresVerdadeiros: [] } }).erros.length > 0, "valoresVerdadeiros vazio é rejeitado");
  ok(parseClassificacaoErpConfig({ etico: { coluna: "ColA", valoresVerdadeiros: [1], valoresFalsos: ["1"] } }).erros.some((e) => e.includes("verdadeiro e falso")), "valor verdadeiro e falso em simultâneo é rejeitado");
  ok(parseClassificacaoErpConfig({ etico: { tabela: "TabX", coluna: "ValorX", valoresVerdadeiros: [1] } }).erros.some((e) => e.includes("chave")), "tabela sem chave é rejeitada");
  ok(parseClassificacaoErpConfig({ foo: {} }).erros.some((e) => e.includes("desconhecido")), "campo desconhecido é sinalizado");
  ok(parseClassificacaoErpConfig([1]).erros.length === 1, "secção que não é objecto é rejeitada");
  const parcial = parseClassificacaoErpConfig({ etico: { coluna: "ColA", valoresVerdadeiros: [1] }, nett: { coluna: "x]", valoresVerdadeiros: [1] } });
  ok(parcial.config.etico !== undefined && parcial.config.nett === undefined, "um campo inválido não invalida os outros");
}

console.log("\n=== B. interpretação de valores (sem adivinhar) ===");
{
  const so = { valoresVerdadeiros: [1, "S"] };
  eq("1 → true", interpretarValor(1, so).valor, true);
  eq("'s ' (aparado, minúsculas) → true", interpretarValor("s ", so).valor, true);
  eq("true (bit) equivale a 1", interpretarValor(true, so).valor, true);
  eq("sem valoresFalsos: outro valor → false", interpretarValor(0, so), { valor: false, foraDoMapeamento: false });
  eq("NULL → desconhecido", interpretarValor(null, so), { valor: null, foraDoMapeamento: false });
  eq("texto vazio → desconhecido", interpretarValor("  ", so), { valor: null, foraDoMapeamento: false });
  const comF = { valoresVerdadeiros: ["S"], valoresFalsos: ["N"] };
  eq("com valoresFalsos: 'N' → false", interpretarValor("N", comF).valor, false);
  eq("com valoresFalsos: 'X' fora → null + foraDoMapeamento", interpretarValor("X", comF), { valor: null, foraDoMapeamento: true });
  eq("boolean false equivale a 0", interpretarValor(false, { valoresVerdadeiros: [1], valoresFalsos: [0] }).valor, false);
}

console.log("\n=== C. plano contra o schema ===");
const CFG: ClassificacaoErpConfig = {
  etico: { coluna: "cola", valoresVerdadeiros: [1] },
  nett: { tabela: "TabX", chave: "Chave", coluna: "ValorX", valoresVerdadeiros: ["S"], valoresFalsos: ["N"] },
  servico: { coluna: "NaoExiste", valoresVerdadeiros: [1] },
};
const PLANO = construirPlanoClassificacao(CFG, existe);
{
  eq("campos resolvidos: etico e nett", PLANO.campos.map((c) => c.campo), ["etico", "nett"]);
  ok(PLANO.avisos.length === 1 && PLANO.avisos[0]!.includes("servico") && PLANO.avisos[0]!.includes("NÃO enviado"), "coluna inexistente → aviso e campo NÃO enviado");
  ok(PLANO.campos[0]!.selectExpr === "s.[ColA]", "usa o nome REAL da coluna (sys.columns), não o escrito");
  ok(/OUTER APPLY \(\s*SELECT TOP 1 t\.\[ValorX\] AS v\s*FROM \[dbo\]\.\[TabX\] t\s*WHERE t\.\[Chave\] = s\.\[CodigoID\]\s*\) cls_nett/.test(PLANO.campos[1]!.joinClause), "tabela ligada por OUTER APPLY TOP 1 (nunca multiplica produtos)");
  const semTab = construirPlanoClassificacao({ nett: { tabela: "Outra", chave: "k", coluna: "c", valoresVerdadeiros: [1] } }, existe);
  ok(semTab.campos.length === 0 && semTab.avisos.length === 1, "tabela inexistente → campo não enviado");
}

console.log("\n=== D. SQL: SELECT só inclui colunas de classificação se configuradas ===");
{
  const sem = buildProductsSql(CAPS);
  ok(!/cls_/.test(sem) && !/classific/i.test(sem), "SEM mapeamento: nenhuma coluna cls_* no SELECT");
  const semExplicito = buildProductsSql({ ...CAPS, classificacaoPlan: EMPTY_CLASSIFICACAO_PLAN });
  eq("plano vazio gera exactamente o mesmo SQL", semExplicito.replace(/\s+/g, ""), sem.replace(/\s+/g, ""));
  const com = buildProductsSql({ ...CAPS, classificacaoPlan: PLANO });
  ok(/s\.\[ColA\]\s+AS cls_etico/.test(com) && /cls_nett\.v\s+AS cls_nett/.test(com), "COM mapeamento: etico e nett no SELECT");
  ok(!/cls_servico/.test(com), "campo descartado (coluna inexistente) não aparece");
  ok(/OUTER APPLY \(\s*SELECT TOP 1 t\.\[ValorX\]/.test(com), "join da tabela presente");
  ok((com.match(/\(/g) ?? []).length === (com.match(/\)/g) ?? []).length, "parêntesis equilibrados");
  const base = [...new Set(validarSelect(sem).map((p) => p.regra))].sort().join(",");
  const regrasCom = [...new Set(validarSelect(com).map((p) => p.regra))].sort().join(",");
  eq("validarSelect: o conjunto de regras não muda com o mapeamento", regrasCom, base);
  const frag = buildClassificacaoSqlFragments(PLANO);
  ok(frag.select.startsWith(",") && !frag.select.includes(";"), "fragmento começa por vírgula e não tem ';'");
  eq("plano vazio → fragmentos vazios", buildClassificacaoSqlFragments(EMPTY_CLASSIFICACAO_PLAN), { select: "", join: "" });
  const hostil = construirPlanoClassificacao({ etico: { coluna: "ColA", valoresVerdadeiros: ["x'; DROP TABLE y;--"] } }, existe);
  ok(!buildClassificacaoSqlFragments(hostil).select.includes("DROP"), "valores configurados NUNCA entram no SQL (comparados em JS)");
}

console.log("\n=== E. payload ===");
{
  const linha = { generico: 1, cls_etico: 1, cls_nett: "N" } as Record<string, unknown>;
  const p = classificacaoParaPayload(PLANO, linha);
  eq("etico/nett/genericoErp preenchidos", [p.etico, p.nett, p.genericoErp], [true, false, true]);
  ok(typeof p.classificacaoErpOrigem === "string" && (p.classificacaoErpOrigem as string).startsWith("spharm_erp:etico=Stocks.[ColA];nett=TabX.[ValorX]"), "origem identifica as colunas", String(p.classificacaoErpOrigem));
  ok(!("servico" in p), "campo não mapeado não vai no payload");

  const semMap = classificacaoParaPayload(EMPTY_CLASSIFICACAO_PLAN, { generico: 0 });
  eq("sem mapeamento: só genericoErp (false ≠ desconhecido)", semMap, { genericoErp: false });
  eq("Generico NULL → genericoErp null (desconhecido)", classificacaoParaPayload(EMPTY_CLASSIFICACAO_PLAN, { generico: null }), { genericoErp: null });
  eq("Generico texto não booleano → null", classificacaoParaPayload(EMPTY_CLASSIFICACAO_PLAN, { generico: "S" }), { genericoErp: null });

  const nulo = classificacaoParaPayload(PLANO, { generico: 0, cls_etico: null, cls_nett: "Z" });
  eq("NULL no ERP → null explícito; valor fora → null", [nulo.etico, nulo.nett], [null, null]);

  // rowToProductPayload: compat — o payload antigo mantém todas as chaves antigas.
  const row = {
    externalProductId: 1, cnp: 5000001, designacao: "X", pvp: 1, pmc: 1, puc: 1,
    dataUltimaVenda: null, dataUltimaCompra: null, retirado: 0, generico: 1, mnsrmNCompart: 0,
    fornecedorHabitualId: null, fornecedorHabitualNome: null, dci: null, codigoATC: null, grupoHomogeneo: null, fabricante: null,
  };
  const semCfg = rowToProductPayload(row);
  ok(semCfg.generico === true && semCfg.genericoErp === true, "generico mantém-se e genericoErp acompanha");
  ok(!("etico" in semCfg) && !("nett" in semCfg) && !("servico" in semCfg) && !("classificacaoErpOrigem" in semCfg), "sem mapeamento: nenhum campo etico/nett/servico/origem");
  const comCfg = rowToProductPayload({ ...row, cls_etico: 1, cls_nett: "S" } as typeof row, PLANO);
  eq("com mapeamento: etico/nett no payload", [comCfg.etico, comCfg.nett], [true, true]);
}

console.log("\n=== F. estatísticas (valores fora do mapeamento visíveis) ===");
{
  const st = novaEstatisticaClassificacao();
  for (const v of ["S", "N", "Z", "Z", null]) classificacaoParaPayload(PLANO, { generico: 1, cls_etico: 1, cls_nett: v }, st);
  eq("nett: sim=1 nao=1 desconhecido=3", st.porCampo.nett, { sim: 1, nao: 1, desconhecido: 3 });
  const linhas = resumoEstatisticaClassificacao(PLANO, st).join("\n");
  ok(linhas.includes('"Z"×2'), "resumo lista os valores fora do mapeamento", linhas);
}

console.log("\n=== G. classification-audit: SQL read-only e quoting ===");
{
  ok(q("a]b") === "[a]]b]", "q() escapa ']'");
  for (const s of [sqlResumoColuna("Etico"), sqlTopValores("Etico", 30), sqlCruzamento("Etico", ["Processa_Stocks", "Retirado"])]) {
    ok(/^SELECT /.test(s) && !/\b(INSERT|UPDATE|DELETE|DROP|EXEC|MERGE|ALTER|CREATE)\b/i.test(s), "só SELECT", s);
  }
  ok(/TOP 200/.test(sqlTopValores("x", 9999)), "TOP limitado");
  ok(PADROES_COLUNA.some((p) => likeMatch("Etico", p)) && PADROES_COLUNA.some((p) => likeMatch("Processa_Stocks", p)) && PADROES_COLUNA.some((p) => likeMatch("Generico", p)), "padrões apanham Etico/Processa_Stocks/Generico");
  ok(PADROES_COLUNA.some((p) => likeMatch("NETT", p)) && PADROES_COLUNA.some((p) => likeMatch("Servico", p)) && !PADROES_COLUNA.some((p) => likeMatch("Preco Venda Publico_EUR", p)), "NETT/Servico sim, preço não");
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail === 0 ? 0 : 1);
