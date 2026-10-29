/**
 * agent/src/classificacao-auditoria.test.ts
 *
 * A auditoria READ-ONLY da classificação, SEM SQL Server real: um ERP falso (classificacao-erp-falso.ts, dados
 * sintéticos em memória) responde às queries que a auditoria gera. CENÁRIOS (nenhum assume o modelo):
 *   A. campos separados (colunas 0/1/NULL)        B. categoria única (coluna de códigos)
 *   C. códigos numa tabela relacionada (lookup)    D. campos inexistentes
 *   E. NULL / vazio / valores desconhecidos        F. serviços excluídos por Processa_Stocks
 *   G. nomes de colunas diferentes (acentos, prefixos, plurais)   H. permissões de escrita do login
 * E propriedades transversais: só SELECT; sem credenciais nem dados pessoais; amostras só com CNP; relatório JSON+MD;
 * cabeçalho de DIAGNÓSTICO; lista das queries executadas; leitura assistida como HIPÓTESES.
 *
 * Uso: npx tsx agent/src/classificacao-auditoria.test.ts
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  criarLeitorSeguro,
  executarAuditoria,
  conceitoDoNome,
  FRASE_READ_ONLY,
  OMITIDO,
  pacoteOmissao,
  parseCnps,
  pareceDadoPessoal,
  pareceDadoSensivel,
  renderMarkdown,
  resumirCruzada,
  sanitizaTexto,
  type RelatorioAuditoria,
} from "./classificacao-auditoria.js";
import { validarQueryAuditoria } from "./sql-somente-leitura.js";
import { erpFalso, type Cenario, type ColDef, type RowStocks } from "./classificacao-erp-falso.js";
import { escreverRelatorio, resolverSaidas } from "./commands/classification-audit.js";
import { FRASE_PACOTE } from "./diagnostico-pacote.js";

let pass = 0;
let fail = 0;
const check = (c: boolean, l: string, d?: string) => {
  if (c) { pass++; console.log(`  [OK]    ${l}`); }
  else { fail++; console.log(`  [FALHA] ${l}${d ? `\n            ${d}` : ""}`); }
};

const SEGREDOS = { senha: "S3cr3t-Pass!", utilizador: "sa_farmacia", host: "10.20.30.40" };
const SEGREDOS_LISTA = [SEGREDOS.senha, SEGREDOS.utilizador, SEGREDOS.host];
const AGORA = new Date("2026-10-29T12:34:56.000Z");
const txt = (r: RowStocks, c: string): string | null => (r[c] === null || r[c] === undefined ? null : String(r[c]));

async function correr(c: Cenario, extra: Parameters<typeof executarAuditoria>[1] = {}) {
  const erp = erpFalso(c);
  const registo: string[] = [];
  const rel = await executarAuditoria(criarLeitorSeguro(erp.ler, registo), {
    agora: () => AGORA,
    segredos: SEGREDOS_LISTA,
    pacote: pacoteOmissao("abc1234"),
    queriesExecutadasTexto: () => registo,
    ...extra,
  });
  return { rel, erp, registo, md: renderMarkdown(rel), json: JSON.stringify(rel) };
}

const hip = (r: RelatorioAuditoria, conceito: string, h: string) =>
  r.leituraAssistida.conceitos.find((c) => c.conceito === conceito)!.hipoteses.find((x) => x.hipotese === h)!;

// ─────────────────────────────────────────────────────────────────────
// Cenário A — campos separados 0/1/NULL (dados sintéticos que PARECEM pessoais incluídos)
// ─────────────────────────────────────────────────────────────────────
function dadosA(): RowStocks[] {
  const rows: RowStocks[] = [];
  for (let i = 0; i < 120; i++) {
    let tipo: string = i % 2 ? "M" : "X";
    if (i === 3) tipo = "joao.silva@example.com";
    if (i === 5) tipo = "912345678";
    if (i === 7) tipo = `pwd=${SEGREDOS.senha}`;
    rows.push({
      Codigo: 1000000 + i, CodigoID: i + 1,
      Servico: i % 10 === 0 ? 1 : 0,
      Etico: i % 7 === 0 ? null : i % 3 === 0 ? 1 : 0,
      NETT: i % 5 === 1 ? 1 : 0,
      Generico: i % 4 === 0 ? 1 : i % 4 === 2 ? null : 0,
      Processa_Stocks: i % 10 === 0 || i % 37 === 5 ? 0 : 1,
      Retirado: i % 9 === 0 ? 1 : 0,
      "Tipo Artigo": tipo,
      "Classe Livre": `C${i % 80}`,
    });
  }
  return rows;
}
const COLS_A: ColDef[] = [
  ["CodigoID", "int", 4], ["Codigo", "int", 4], ["Nome Comercial", "varchar", 100], ["Servico", "bit", 1], ["Etico", "bit", 1],
  ["NETT", "bit", 1], ["Generico", "bit", 1], ["Processa_Stocks", "bit", 1], ["Retirado", "bit", 1],
  ["Tipo Artigo", "varchar", 20], ["Classe Livre", "varchar", 50], ["Observacao Tipo", "varchar", 2000],
  ["Data Classe", "datetime", 8], ["Grupo Utente", "varchar", 30], ["Nome Medico Tipo", "varchar", 60],
];
const cenarioA = (): Cenario => ({
  stocksCols: COLS_A,
  dados: dadosA(),
  tabelas: [
    { tabela: "Clientes", cols: [["ID", "int", 4], ["Tipo Cliente", "varchar", 20]], linhas: 300 },
    { tabela: "TipoArtigo", cols: [["ID", "int", 4], ["Tipo", "varchar", 10]], linhas: 12 },
    { tabela: "Atendimento", cols: [["Atendimento ID", "int", 4]], linhas: 5000 },
    { tabela: "TipoCliente", cols: [["Tipo", "varchar", 10], ["Nome", "varchar", 40]], linhas: 3 },
  ],
  candidatasExtra: [
    { esquema: "dbo", tabela: "Clientes", coluna: "Tipo Cliente", tipo: "varchar", tamanho: 20, anulavel: 1 },
    { esquema: "dbo", tabela: "TipoArtigo", coluna: "Tipo", tipo: "varchar", tamanho: 10, anulavel: 0 },
  ],
  fks: [{ coluna: "TipoArtigoID", tabelaRef: "TipoArtigo", colunaRef: "ID" }, { coluna: "ClienteID", tabelaRef: "Clientes", colunaRef: "ID" }],
  conteudo: { TipoArtigo: [{ ID: 1, Tipo: "M" }, { ID: 2, Tipo: "X" }] },
});

async function main() {
  // ═══ A. Campos separados ═══════════════════════════════════════════
  console.log("\n=== A. Cenário campos separados (0/1/NULL) — auditoria completa ===");
  const A = await correr(cenarioA(), { cnps: ["1000001", "1000010", "9999999"] });
  const { rel, erp, registo, md, json } = A;
  const DADOS = dadosA();

  check(erp.executadas.length > 30 && registo.length === erp.executadas.length, `${erp.executadas.length} queries executadas, todas registadas`);
  check(erp.executadas.every((s) => validarQueryAuditoria(s).length === 0), "TODAS as queries executadas passam guarda + validador");
  check(erp.executadas.every((s) => /^SELECT\b/.test(s)), "todas as queries começam por SELECT");
  check(![...erp.tabelasLidas].some((t) => /clientes/i.test(t)), "tabela Clientes (dado pessoal) nunca é lida");
  check(!erp.executadas.some((s) => /Grupo Utente|Nome Medico/.test(s) && /AS valor|COUNT\(DISTINCT/.test(s)), "colunas com nome pessoal nunca são lidas");

  console.log("\n--- cabeçalho de DIAGNÓSTICO ---");
  const h = rel.cabecalho;
  check(h.geradoEmUtc === "2026-10-29T12:34:56.000Z" && md.includes("2026-10-29T12:34:56.000Z"), "data/hora UTC no cabeçalho");
  check(h.pacote.diagnostico === true && h.pacote.instalavel === false && h.pacote.baseRev === "98" && h.pacote.id === "classification-audit", "pacote: diagnostico=true, instalavel=false, base rev98, id classification-audit");
  check(md.includes(FRASE_PACOTE) && FRASE_PACOTE === "pacote de DIAGNÓSTICO (base rev98), modo read-only, não instalável", "frase «pacote de DIAGNÓSTICO (base rev98), modo read-only, não instalável» no Markdown");
  check(!/rev99/i.test(md + json), "o relatório nunca diz rev99");
  check(h.modo === FRASE_READ_ONLY && md.includes(FRASE_READ_ONLY), `frase "${FRASE_READ_ONLY}"`);
  check(h.baseDados === "SPharmDemo" && md.includes("SPharmDemo"), "nome da base (DB_NAME), sem credenciais");
  check(h.sqlServer === "Microsoft SQL Server 2008 R2 (SP3) - 10.50.6000.34 (X64)", "versão do SQL Server (1.ª linha de @@VERSION)", String(h.sqlServer));
  check(rel.ambiente.produtoVersao === "10.50.6000.34" && rel.ambiente.nivel === "SP3" && rel.ambiente.compatibilidade === 100, "ambiente: versão/nível/compatibilidade");
  check(rel.ambiente.permissoesStocks?.inserir === false && rel.ambiente.permissoesStocks?.actualizar === false && rel.ambiente.permissoesStocks?.apagar === false, "login sem permissões de escrita (HAS_PERMS_BY_NAME)");
  check(rel.avisos.every((a) => !/ATENÇÃO/.test(a)), "sem aviso de escrita quando o login só lê");

  console.log("\n--- lista das queries executadas (auditoria humana) ---");
  check(rel.queries.length === erp.executadas.length, "o relatório lista TODAS as queries executadas");
  check(md.includes("## Anexo — queries executadas") && md.includes("SELECT TOP"), "anexo com o texto das queries no Markdown");
  check(!rel.queries.some((q) => q.includes("1000010") || /N'M'|N'X'/.test(q)), "texto das queries SEM dados (CNPs e valores mascarados)");
  check(rel.queries.some((q) => q.includes("N'<valor>'")), "valores substituídos por <valor>");

  console.log("\n--- tabelas-chave e estrutura ---");
  const tc = (n: string) => rel.tabelasChave.find((t) => t.nome === n)!;
  check(tc("Stocks").presente && tc("Stocks").linhas === 120 && tc("Atendimento").linhas === 5000, "tabelas-chave presentes com nº de linhas (só números)");
  check(!tc("StocksMov").presente && !tc("Fornecedores").presente && tc("StocksMov").linhas === null, "tabelas-chave ausentes marcadas como ausentes");
  check(md.includes("| StocksMov | NÃO |"), "ausência visível no Markdown");
  check(rel.tabelasCandidatas.some((t) => t.tabela === "dbo.TipoArtigo") && rel.tabelasCandidatas.some((t) => t.tabela === "dbo.Stocks"), "tabelas candidatas por nome (TipoArtigo, Stocks)");
  check(rel.tabelasCandidatas.find((t) => t.tabela === "dbo.TipoCliente")?.omitidaPorNome === true && !md.includes("Tipo Cliente") && !erp.tabelasLidas.has("dbo.TipoCliente"), "tabela com nome pessoal (TipoCliente) listada sem colunas e nunca lida");
  const stocksEstrut = rel.tabelasCandidatas.find((t) => t.tabela === "dbo.Stocks")!;
  check(!stocksEstrut.colunas.some((c) => /Nome|Grupo Utente/.test(c.coluna)) && stocksEstrut.colunasOmitidas >= 2, "colunas pessoais de Stocks não listadas (contadas como omitidas)");
  check(rel.conteudoTabelasDominio.some((c) => c.tabela === "dbo.TipoArtigo" && c.amostra.length === 2), "tabela de domínio pequena: conteúdo (códigos) lido");

  console.log("\n--- colunas candidatas e omissões ---");
  const cand = (t: string, c: string) => rel.colunasCandidatas.find((x) => x.tabela === t && x.coluna === c);
  check(cand("Stocks", "Etico")?.inspeccao === "inspeccionada" && cand("Stocks", "Generico")?.tipo === "bit", "Etico/Generico inspeccionadas, com tipo");
  check(cand("Clientes", "Tipo Cliente")?.inspeccao === "omitida-dado-pessoal", "Clientes.Tipo Cliente omitida (dado pessoal)");
  check(cand("Stocks", "Grupo Utente")?.inspeccao === "omitida-dado-pessoal" && cand("Stocks", "Nome Medico Tipo")?.inspeccao === "omitida-dado-pessoal", "colunas com nome pessoal omitidas");
  check(cand("Stocks", "Observacao Tipo")?.inspeccao === "texto-longo", "texto longo não é lido");
  check(cand("Stocks", "Data Classe")?.inspeccao === "tipo-nao-inspeccionavel", "tipo datetime não é inspeccionado");
  check(cand("TipoArtigo", "Tipo")?.linhasTabela === 12, "nº de linhas por tabela");
  check(!md.includes("Grupo Utente") && !md.includes("Nome Medico") && !md.includes("Tipo Cliente"), "nomes de colunas pessoais ocultados no Markdown");
  check(rel.fksDeStocks.length === 1 && rel.fksDeStocks[0]!.tabelaRef === "TipoArtigo", "FKs: a que aponta para Clientes é filtrada");

  console.log("\n--- NULL / vazio / 0 / outros e valores distintos ---");
  const pGen = rel.perfis.find((p) => p.tabela === "dbo.Stocks" && p.coluna === "Generico")!;
  const verdade = (c: string) => {
    const m = new Map<string | null, number>();
    for (const r of DADOS) m.set(txt(r, c), (m.get(txt(r, c)) ?? 0) + 1);
    return m;
  };
  const vg = verdade("Generico");
  check(pGen.valores.length === vg.size && pGen.valores.every((v) => vg.get(v.valor) === v.n), "Generico: valores distintos e contagens = verdade", JSON.stringify(pGen.valores));
  check(pGen.categorias.nulo === (vg.get(null) ?? 0) && pGen.categorias.zero === (vg.get("0") ?? 0) && pGen.categorias.um === (vg.get("1") ?? 0) && pGen.categorias.outros === 0 && pGen.categorias.vazio === 0, "Generico: categorias NULL / 0 / 1 / vazio / outros", JSON.stringify(pGen.categorias));
  check(rel.generico.encontrado && rel.generico.coluna === "Generico" && rel.generico.tipo === "bit" && rel.generico.amostras.length === pGen.valores.length, "auditoria própria do Generico: coluna, tipo, valores, amostras");
  check(rel.generico.amostras.every((a) => a.exemplos.length > 0 && a.exemplos.every((e) => /^\d{7}$/.test(e.cnp ?? ""))), "amostras de Genérico só com CNP/código");
  const gx = (outra: string) => rel.generico.cruzadas.find((t) => [t.colunaA, t.colunaB].includes(outra));
  check(!!gx("Retirado") && !!gx("Processa_Stocks"), "Generico cruzado com Retirado e com Processa_Stocks");
  const gp = gx("Processa_Stocks")!;
  const esperadoGP = DADOS.filter((r) => r.Generico === 1 && r.Processa_Stocks === 0).length;
  const celGP = gp.celulas.find((c) => (gp.colunaA === "Generico" ? c.a === "1" && c.b === "0" : c.b === "1" && c.a === "0"));
  check((celGP?.n ?? 0) === esperadoGP, `Generico=1 com Processa_Stocks=0: ${esperadoGP}`);
  const pLivre = rel.perfis.find((p) => p.coluna === "Classe Livre")!;
  check(pLivre.distintos === 80 && !pLivre.listaCompleta && pLivre.valores.length === 15, "texto livre com muitas variantes: só top-15, lista parcial");
  const pTipo = rel.perfis.find((p) => p.coluna === "Tipo Artigo")!;
  check(pTipo.valores.every((v) => v.valor === null || !/@|\d{9}/.test(v.valor)) && pTipo.valores.some((v) => v.valor === OMITIDO), "valores com e-mail / 9 dígitos mascarados e substituídos por [omitido]");
  check(!rel.amostras.some((a) => a.coluna === "Tipo Artigo" && a.valor === OMITIDO), "valor mascarado nunca vira WHERE nem amostra");
  check(!erp.executadas.some((s) => s.includes("joao.silva") || s.includes("912345678")), "dados pessoais nunca voltam ao SQL");

  console.log("\n--- tabulação cruzada (SQL agregado) ---");
  const cruz = rel.cruzadas.find((t) => t.colunaA === "Etico" && t.colunaB === "Servico") ?? rel.cruzadas.find((t) => t.colunaA === "Servico" && t.colunaB === "Etico");
  check(!!cruz, "par Etico × Servico presente");
  if (cruz) {
    const verdadeCruz = new Map<string, number>();
    for (const r of DADOS) {
      const k = `${txt(r, cruz.colunaA)}|${txt(r, cruz.colunaB)}`;
      verdadeCruz.set(k, (verdadeCruz.get(k) ?? 0) + 1);
    }
    check(cruz.celulas.length === verdadeCruz.size && cruz.celulas.every((c) => verdadeCruz.get(`${c.a}|${c.b}`) === c.n), "cada combinação tem a contagem correta", JSON.stringify(cruz.celulas));
    check(cruz.celulas.reduce((s, c) => s + c.n, 0) === DADOS.length, "a soma das células = nº de linhas");
    const esperadoAmbasUm = DADOS.filter((r) => r.Etico === 1 && r.Servico === 1).length;
    check(cruz.ambasUm === esperadoAmbasUm, `linhas com ambas=1 = ${esperadoAmbasUm}`, String(cruz.ambasUm));
  }
  check(rel.cruzadas.length === 21 && rel.avisos.every((a) => !/limitados/.test(a)), "21 pares (7 colunas de baixa cardinalidade), sem truncagem");
  check(resumirCruzada("A", "B", [{ a: "1", b: "1", n: 3 }, { a: "0", b: "1", n: 5 }, { a: null, b: "0", n: 2 }]).ambasUm === 3, "resumirCruzada: factos de uma matriz pequena");
  check(resumirCruzada("A", "B", [{ a: "M", b: "1", n: 3 }]).ambasUm === null, "colunas não 0/1: ambasUm = null (sem inventar)");

  console.log("\n--- serviços e Processa_Stocks (filtro do agent) ---");
  const s = rel.servicos;
  const ps0 = DADOS.filter((r) => r.Processa_Stocks === 0).length;
  check(s.disponivel && s.total === DADOS.length && s.zero === ps0 && s.diferenteDeZero === DADOS.length - ps0 && s.nulos === 0, `Processa_Stocks = 0: ${ps0}; <> 0: ${DADOS.length - ps0}`);
  check(s.incluidosPeloFiltro === DADOS.length - ps0 && s.excluidosPeloFiltro === ps0, "artigos incluídos / excluídos pelo filtro Processa_Stocks <> 0");
  check(s.ativosBootstrap === DADOS.filter((r) => r.Retirado === 0 && r.Processa_Stocks !== 0).length, "catálogo ativo do bootstrap (Retirado = 0 AND Processa_Stocks <> 0)");
  check(s.predicados.dailySync === "s.[Processa_Stocks] <> 0" && s.predicados.bootstrapAtivo === "s.[Retirado] = 0 AND s.[Processa_Stocks] <> 0", "predicados do agent reproduzidos EXACTAMENTE");
  check(s.filtroDoAgent.includes("daily-sync-runner.ts") && s.filtroDoAgent.includes("bootstrap-upload.ts") && s.filtroDoAgent.includes("NÃO provam"), "refere os ficheiros do agent e que não prova serviço");
  const mServ = s.marcadosVsFiltro.find((m) => m.coluna === "Servico")!;
  const nServ = DADOS.filter((r) => r.Servico === 1).length;
  check(mServ.marcados === nServ && mServ.marcadosExcluidos === nServ && mServ.marcadosIncluidos === 0, `candidatos a serviço (Servico=1): ${nServ}, todos fora do filtro`, JSON.stringify(mServ));
  const dServ = s.distinguemPorColuna.find((d) => d.coluna === "Servico");
  check(!!dServ && dServ.soExcluidos.some((v) => v.valor === "1" && v.n === nServ), "Servico=1 só aparece em artigos excluídos (facto observado)", JSON.stringify(dServ));
  check(!!dServ && dServ.emAmbos.some((v) => v.valor === "0" && v.excluidos > 0 && v.incluidos > 0), "Servico=0 aparece nos dois grupos");
  check(s.exemplosZero.length === 10 && s.exemplosZero.every((e) => /^\d{7}$/.test(e.cnp ?? "") && e.processaStocks === "0"), "exemplos CNP/código com Processa_Stocks = 0");
  check(s.exemplosZero.every((e) => !("Nome Comercial" in e)) && !/Nome Comercial|Preco/i.test(md), "exemplos sem nomes nem preços");

  console.log("\n--- CNPs conhecidos (opcional) ---");
  const k1 = rel.conhecidos.find((c) => c.cnp === "1000001")!;
  const r1 = DADOS.find((r) => r.Codigo === 1000001)!;
  check(k1.encontrado && k1.valores["Servico"] === txt(r1, "Servico") && k1.valores["Generico"] === txt(r1, "Generico"), "CNP existente mostra a classificação de cada coluna");
  check(rel.conhecidos.find((c) => c.cnp === "9999999")!.encontrado === false, "CNP inexistente marcado como não encontrado");
  check(rel.conhecidos.find((c) => c.cnp === "1000010")!.valores["Servico"] === "1", "serviço conhecido: Servico=1");
  const pc = parseCnps("1234567, 7654321\n0001234 abc 12;DROP 1234567 123456789012");
  check(pc.cnps.join(",") === "1234567,7654321,1234,12" && pc.invalidos === 3, "parseCnps: só dígitos, sem duplicados, tokens inválidos contados", JSON.stringify(pc));
  const injeccao = await correr(cenarioA(), { cnps: parseCnps("1000001'; DROP TABLE x;--, 1000002").cnps });
  check(injeccao.rel.conhecidos.length === 1 && !injeccao.erp.executadas.some((q) => /DROP/i.test(q)), "tentativa de injecção por CNP nunca chega ao SQL");
  const semCnps = await correr(cenarioA());
  check(semCnps.rel.conhecidos.length === 0 && !semCnps.erp.executadas.some((q) => /IN \('\d+'/.test(q)), "sem --cnps: nada é consultado por CNP (opcional)");

  console.log("\n--- leitura assistida: HIPÓTESES, nunca conclusões ---");
  const la = rel.leituraAssistida;
  check(la.conceitos.map((c) => c.conceito).join() === "generico,etico,nett,servico" && la.conceitos.every((c) => c.hipoteses.length === 5), "4 conceitos × 5 hipóteses (campos-independentes, categoria-unica, tabela-relacionada, propriedade-derivada, inexistente)");
  check(la.aviso.includes("HIPÓTESES a confirmar por uma pessoa") && md.includes("HIPÓTESES a confirmar por humano"), "marcada como hipóteses a confirmar por humano");
  check(hip(rel, "etico", "campos-independentes").estado === "suportada" && hip(rel, "etico", "inexistente").estado === "contradita", "Etico (0/1/NULL): campos independentes suportada; inexistente contradita");
  check(hip(rel, "servico", "propriedade-derivada").estado === "sem-dados" && hip(rel, "servico", "propriedade-derivada").evidencia.join(" ").includes(`todos os ${nServ} artigos marcados`), "Servico: marcados todos fora do filtro, mas não coincide por inteiro → sem-dados (sem concluir)");
  check(la.sobreposicoes.some((x) => /Etico × Servico|Servico × Etico/.test(x) && /ambas = 1/.test(x)), "sobreposições entre conceitos como factos");
  check(!/mutuamente exclusiv|são independentes|conclu[ií]mos que|é booleano|é um serviço/i.test(md), "o relatório não conclui exclusividade, independência nem significado");
  check(!/booleano/i.test(md + json), "nenhum pressuposto de «booleano» no relatório");

  // ═══ B. Categoria única ═════════════════════════════════════════════
  console.log("\n=== B. Cenário categoria única (coluna de códigos) ===");
  const dadosB: RowStocks[] = Array.from({ length: 60 }, (_, i) => ({
    Codigo: 2000000 + i, CodigoID: i + 1, Processa_Stocks: i % 6 === 0 ? 0 : 1, Retirado: 0,
    Classificacao: ["E", "N", "S", "G", null, "O"][i % 6]!, Generico: i % 6 === 3 ? 1 : 0,
  }));
  const B = await correr({
    stocksCols: [["CodigoID", "int", 4], ["Codigo", "int", 4], ["Processa_Stocks", "int", 4], ["Retirado", "int", 4], ["Classificacao", "char", 1], ["Generico", "int", 4]],
    dados: dadosB,
  });
  const pCls = B.rel.perfis.find((p) => p.coluna === "Classificacao")!;
  check(pCls.distintos === 5 && pCls.listaCompleta && pCls.categorias.nulo === 10 && pCls.categorias.outros === 50, "coluna de códigos: 5 distintos, 10 NULL");
  check(hip(B.rel, "etico", "inexistente").estado === "suportada", "Etico: nenhuma coluna com esse nome → inexistente «suportada» (por nome)");
  check(hip(B.rel, "etico", "categoria-unica").evidencia.join(" ").includes("Classificacao [5 valores]"), "categoria única: coluna de categoria candidata referida (a interpretar por humano)");
  check(hip(B.rel, "etico", "inexistente").evidencia.join(" ").includes("pode existir com outro nome"), "a ausência por nome não é dada como prova");
  check(hip(B.rel, "generico", "campos-independentes").estado === "suportada" && hip(B.rel, "generico", "campos-independentes").evidencia.join(" ").includes("0/1"), "Generico em coluna int 0/1: campos independentes suportada");
  check(B.rel.cruzadas.some((t) => [t.colunaA, t.colunaB].includes("Classificacao") && [t.colunaA, t.colunaB].includes("Processa_Stocks")), "Classificacao × Processa_Stocks cruzada");

  // ═══ C. Tabela relacionada (lookup) ════════════════════════════════
  console.log("\n=== C. Cenário códigos numa tabela relacionada ===");
  const dadosC: RowStocks[] = Array.from({ length: 80 }, (_, i) => ({
    Codigo: 3000000 + i, CodigoID: i + 1, Processa_Stocks: i % 8 === 0 ? 0 : 1, Retirado: 0, TipoProdutoID: (i % 4) + 1, Generico: i % 5 === 0 ? 1 : 0,
  }));
  const C = await correr({
    stocksCols: [["CodigoID", "int", 4], ["Codigo", "int", 4], ["Processa_Stocks", "int", 4], ["Retirado", "int", 4], ["TipoProdutoID", "int", 4], ["Generico", "int", 4]],
    dados: dadosC,
    tabelas: [{ tabela: "TipoProduto", cols: [["ID", "int", 4], ["Descricao", "varchar", 40]], linhas: 4 }],
    fks: [{ coluna: "TipoProdutoID", tabelaRef: "TipoProduto", colunaRef: "ID" }],
    conteudo: { TipoProduto: [{ ID: 1, Descricao: "Ético" }, { ID: 2, Descricao: "NETT" }, { ID: 3, Descricao: "Serviço" }, { ID: 4, Descricao: "Genérico" }] },
  });
  const lk = C.rel.lookups.find((l) => l.coluna === "TipoProdutoID")!;
  check(!!lk && lk.tabelaRef === "dbo.TipoProduto" && lk.linhasRef === 4 && lk.usoEmStocks.length === 4, "lookup declarado por FK lido: 4 códigos com contagens");
  check(lk.usoEmStocks.every((u) => u.n === 20) && lk.usoEmStocks.some((u) => u.codigo === "3" && u.descricao === "Serviço"), "código 3 ↔ «Serviço» ↔ 20 artigos (facto, sem interpretar)");
  check(C.rel.perfis.some((p) => p.coluna === "TipoProdutoID" && p.distintos === 4), "a coluna FK de Stocks é perfilada mesmo sem nome «candidato»");
  check(["etico", "nett", "servico", "generico"].every((c) => hip(C.rel, c, "tabela-relacionada").estado === "suportada"), "tabela-relacionada «suportada» para os 4 conceitos (descrições do lookup)");
  check(hip(C.rel, "servico", "tabela-relacionada").evidencia.join(" ").includes("dbo.TipoProduto"), "evidência cita a tabela");
  check(C.rel.conteudoTabelasDominio.some((t) => t.tabela === "dbo.TipoProduto" && t.amostra.length === 4), "conteúdo da tabela de domínio pequena");
  check(C.md.includes("### 1c. Tabelas relacionadas") && C.md.includes("`Serviço`"), "Markdown mostra o lookup");
  check(C.rel.cruzadas.some((t) => [t.colunaA, t.colunaB].includes("TipoProdutoID") && [t.colunaA, t.colunaB].includes("Processa_Stocks")), "código do lookup × Processa_Stocks");

  // ═══ D. Campos inexistentes ════════════════════════════════════════
  console.log("\n=== D. Cenário campos inexistentes ===");
  const D = await correr({
    stocksCols: [["CodigoID", "int", 4], ["Codigo", "int", 4], ["Nome Comercial", "varchar", 100], ["Processa_Stocks", "int", 4], ["Retirado", "int", 4]],
    dados: Array.from({ length: 10 }, (_, i) => ({ Codigo: 4000000 + i, CodigoID: i + 1, Processa_Stocks: i < 2 ? 0 : 1, Retirado: 0 })),
  });
  check(D.rel.generico.encontrado === false && D.rel.generico.coluna === null && D.md.includes("Coluna Generico não encontrada"), "sem Generico: dito claramente, sem falhar");
  check(["generico", "etico", "nett", "servico"].every((c) => hip(D.rel, c, "inexistente").estado === "suportada"), "os 4 conceitos: «inexistente» suportada (por nome)");
  check(hip(D.rel, "servico", "propriedade-derivada").evidencia.join(" ").includes("poderá ser derivado de Processa_Stocks"), "Serviço sem coluna: Processa_Stocks=0 apontado como pista a confirmar");
  check(D.rel.avisos.length === 0 || D.rel.avisos.every((a) => !/Error|falhou/i.test(a)), "sem erros");
  check(D.rel.servicos.excluidosPeloFiltro === 2, "2 artigos excluídos pelo filtro");

  // ═══ E. NULL / vazio / valores desconhecidos ═══════════════════════
  console.log("\n=== E. Cenário NULL / vazio / valores desconhecidos ===");
  const vals = [null, "", "  ", "0", "1", "S", "N", "?", "X9", "S", "S", null];
  const dadosE: RowStocks[] = vals.map((v, i) => ({ Codigo: 5000000 + i, CodigoID: i + 1, Processa_Stocks: 1, Retirado: 0, Etico: v }));
  const E = await correr({
    stocksCols: [["CodigoID", "int", 4], ["Codigo", "int", 4], ["Processa_Stocks", "int", 4], ["Retirado", "int", 4], ["Etico", "varchar", 5]],
    dados: dadosE,
  });
  const pE = E.rel.perfis.find((p) => p.coluna === "Etico")!;
  check(pE.total === 12 && pE.categorias.nulo === 2 && pE.categorias.vazio === 2 && pE.categorias.zero === 1 && pE.categorias.um === 1 && pE.categorias.outros === 6, "NULL=2, vazio=2 (''/espaços), 0=1, 1=1, outros=6", JSON.stringify(pE.categorias));
  check(pE.valores.some((v) => v.valor === "S" && v.n === 3) && pE.valores.some((v) => v.valor === "X9") && pE.valores.some((v) => v.valor === "?"), "valores desconhecidos listados com contagem");
  check(hip(E.rel, "etico", "campos-independentes").estado === "contradita" && hip(E.rel, "etico", "campos-independentes").evidencia.join(" ").includes("não só 0/1"), "valores S/N/?: não é só 0/1 → «campos independentes» contradita");
  check(hip(E.rel, "etico", "categoria-unica").estado === "suportada", "…e «categoria única» suportada pelos números");
  check(E.rel.amostras.some((a) => a.coluna === "Etico" && a.valor === null && a.exemplos.length > 0), "amostra de CNPs também para NULL");

  // ═══ F. Serviços excluídos por Processa_Stocks ═════════════════════
  console.log("\n=== F. Cenário serviços excluídos por Processa_Stocks (incl. NULL) ===");
  const dadosF: RowStocks[] = Array.from({ length: 40 }, (_, i) => ({
    Codigo: 6000000 + i, CodigoID: i + 1,
    Processa_Stocks: i < 8 ? 0 : i < 11 ? null : 1,
    Retirado: i % 20 === 0 ? 1 : 0,
    Servico: i < 6 ? 1 : i === 8 ? 1 : 0, // 6 serviços com PS=0, 1 serviço com PS NULL, 0 incluídos
  }));
  const F = await correr({
    stocksCols: [["CodigoID", "int", 4], ["Codigo", "int", 4], ["Processa_Stocks", "int", 4], ["Retirado", "int", 4], ["Servico", "int", 4]],
    dados: dadosF,
  });
  const sf = F.rel.servicos;
  check(sf.zero === 8 && sf.nulos === 3 && sf.diferenteDeZero === 29, "PS=0: 8; NULL: 3; <>0: 29");
  check(sf.incluidosPeloFiltro === 29 && sf.excluidosPeloFiltro === 11, "excluídos pelo filtro = zero + NULL (NULL <> 0 é desconhecido em SQL)");
  const mf = sf.marcadosVsFiltro.find((m) => m.coluna === "Servico")!;
  check(mf.marcados === 7 && mf.marcadosExcluidos === 7 && mf.marcadosIncluidos === 0, "7 candidatos a serviço, os 7 ficam fora do filtro (6 com PS=0, 1 com PS NULL)", JSON.stringify(mf));
  check(mf.naoMarcadosExcluidos === 4, "4 artigos fora do filtro não são «serviço» (PS=0 ou NULL)");
  check(F.md.includes("marcados EXCLUÍDOS") && F.md.includes("EXCLUÍDOS pelo filtro"), "Markdown mostra incluídos/excluídos e candidatos fora");
  check(F.erp.executadas.some((q) => q.includes("[Processa_Stocks] <> 0") && q.includes("WITH (NOLOCK)")), "o filtro <> 0 é reproduzido nas queries");

  // ═══ G. Nomes de colunas diferentes ════════════════════════════════
  console.log("\n=== G. Cenário nomes de colunas diferentes ===");
  check(conceitoDoNome("É_Ético") === "etico" && conceitoDoNome("Is_Nett") === "nett" && conceitoDoNome("Serviço_Flag") === "servico" && conceitoDoNome("FlagGenérico") === "generico" && conceitoDoNome("Eticos") === "etico", "conceitoDoNome: acentos, prefixos, plurais");
  check(conceitoDoNome("Tipo") === null && conceitoDoNome("Codigo") === null, "pista por nome só quando o nome refere o conceito");
  const dadosG: RowStocks[] = Array.from({ length: 30 }, (_, i) => ({
    Codigo: 7000000 + i, CodigoID: i + 1, Processa_Stocks: 1, Retirado: 0, "É_Ético": i % 2, Is_Nett: i % 3 === 0 ? 1 : 0, "Serviço_Flag": i === 0 ? 1 : 0, "FlagGenérico": i % 5 === 0 ? "S" : "N",
  }));
  const G = await correr({
    stocksCols: [["CodigoID", "int", 4], ["Codigo", "int", 4], ["Processa_Stocks", "int", 4], ["Retirado", "int", 4], ["É_Ético", "bit", 1], ["Is_Nett", "bit", 1], ["Serviço_Flag", "bit", 1], ["FlagGenérico", "char", 1]],
    dados: dadosG,
  });
  check(G.rel.perfis.length === 6 && ["É_Ético", "Is_Nett", "Serviço_Flag", "FlagGenérico"].every((c) => G.rel.perfis.some((p) => p.coluna === c)), "as 4 colunas com nomes diferentes são encontradas e perfiladas");
  check(G.rel.generico.encontrado === false, "«Generico» exacto não existe: a auditoria própria do Stocks.Generico diz que não encontrou (não adivinha)");
  check(["etico", "nett", "servico", "generico"].every((c) => G.rel.leituraAssistida.conceitos.find((x) => x.conceito === c)!.colunasPorNome.length === 1), "colunas por nome atribuídas a cada conceito");
  check(hip(G.rel, "generico", "campos-independentes").estado === "contradita", "FlagGenérico com S/N: não é 0/1 → campos-independentes contradita (sem assumir)");

  // ═══ H. Permissões de escrita do login ═════════════════════════════
  console.log("\n=== H. Permissões do login ===");
  const H = await correr({ ...cenarioA(), permissoes: { inserir: 1, actualizar: 1, apagar: 0 } });
  check(H.rel.ambiente.permissoesStocks?.inserir === true && H.rel.ambiente.permissoesStocks?.apagar === false, "permissões reportadas como facto");
  check(H.rel.avisos.some((a) => /ATENÇÃO: o login de ligação tem permissões de escrita/.test(a)) && H.erp.executadas.every((q) => /^SELECT\b/.test(q)), "aviso se o login pode escrever — e mesmo assim só SELECT");

  // ═══ I. Sanitização ═══════════════════════════════════════════════
  console.log("\n=== I. Sem credenciais nem dados pessoais no relatório ===");
  const falho = await correr(cenarioA(), { cnps: ["1000001"] }).then(() => correr({ ...cenarioA(), falhaCruzadaCom: { coluna: "Etico", mensagem: `timeout em ${SEGREDOS.host} password=${SEGREDOS.senha} user=${SEGREDOS.utilizador}` } }, { cnps: ["1000001"] }));
  const tudo = [json, md, falho.json, falho.md].join("\n");
  check(!tudo.includes(SEGREDOS.senha), "palavra-passe ausente (incl. valor de dados e mensagem de erro)");
  check(!tudo.includes(SEGREDOS.utilizador), "utilizador ausente");
  check(!tudo.includes(SEGREDOS.host), "anfitrião/IP ausente (incl. na versão e em erros)");
  check(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/i.test(tudo), "nenhum e-mail");
  check(!/\d{9,}/.test(tudo.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z/g, "")), "nenhuma sequência de ≥9 dígitos (NIF/telefone)");
  check(!/joao\.silva|912345678/.test(tudo), "valores pessoais sintéticos ausentes");
  check(falho.rel.avisos.some((a) => /cruzada Etico/.test(a)) && falho.rel.cruzadas.length < 21, "erro numa tabulação é aviso, não aborta a auditoria");
  check(falho.rel.avisos.every((a) => !a.includes(SEGREDOS.senha) && !a.includes(SEGREDOS.host) && !a.includes(SEGREDOS.utilizador)), "avisos de erro redigidos");
  check(sanitizaTexto("a@b.pt 912 345 678 123456789 ok") === `${OMITIDO} ${OMITIDO} ${OMITIDO} ok`, "sanitizaTexto: e-mail, telefone com espaços, NIF");
  check(pareceDadoPessoal("Nome Cliente") && pareceDadoPessoal("NIF") && pareceDadoPessoal("Morada") && pareceDadoPessoal("Telemóvel") && !pareceDadoPessoal("Etico") && !pareceDadoPessoal("Tipo Artigo"), "pareceDadoPessoal: pessoal vs classificação");
  check(pareceDadoSensivel("PVP") && pareceDadoSensivel("Preco Custo") && pareceDadoSensivel("Valor Venda") && !pareceDadoSensivel("Comparticipacao") && !pareceDadoSensivel("Servico"), "pareceDadoSensivel: preços/valores nunca lidos");
  const comPreco = await correr({
    stocksCols: [["CodigoID", "int", 4], ["Codigo", "int", 4], ["Processa_Stocks", "int", 4], ["Retirado", "int", 4], ["Preco Tipo", "money", 8], ["Tipo X", "char", 1]],
    dados: [{ Codigo: 1, CodigoID: 1, Processa_Stocks: 1, Retirado: 0, "Preco Tipo": 12, "Tipo X": "A" }],
  });
  check(!comPreco.erp.executadas.some((q) => /Preco Tipo/.test(q) && /COUNT|AS valor/.test(q)), "coluna monetária candidata (Preco Tipo) nunca é lida");

  // ═══ J. Limites ═══════════════════════════════════════════════════
  console.log("\n=== J. Limites ===");
  const lim = await correr(cenarioA(), { maxColunas: 3, maxPares: 2, top: 5 });
  check(lim.rel.colunasCandidatas.filter((c) => c.inspeccao === "inspeccionada").length === 3, "--max-colunas respeitado");
  check(lim.rel.colunasCandidatas.some((c) => c.inspeccao === "limite-de-colunas"), "colunas fora do limite marcadas");
  check(lim.rel.cruzadas.length <= 2, "maxPares respeitado");
  const semTempo = await correr(cenarioA(), { orcamentoMs: -1 });
  check(semTempo.rel.perfis.length === 0 && semTempo.rel.colunasCandidatas.some((c) => /orçamento/.test(c.nota ?? "")), "orçamento de tempo esgotado: pára de inspeccionar e diz porquê");

  // ═══ K. Exportação ════════════════════════════════════════════════
  console.log("\n=== K. Exportação (--out grava JSON e Markdown) ===");
  const dir = mkdtempSync(path.join(tmpdir(), "cls-audit-"));
  try {
    const fj = path.join(dir, "sub", "auditoria.json");
    const escritos = escreverRelatorio(rel, resolverSaidas(fj, dir, "ts"), SEGREDOS_LISTA);
    check(escritos.length === 2 && escritos.some((f) => f.endsWith("auditoria.json")) && escritos.some((f) => f.endsWith("auditoria.md")), "--out x.json grava x.json E x.md");
    const lido: RelatorioAuditoria = JSON.parse(readFileSync(escritos.find((f) => f.endsWith(".json"))!, "utf8"));
    check(lido.cabecalho.baseDados === "SPharmDemo" && lido.perfis.length === rel.perfis.length && lido.cabecalho.pacote.instalavel === false, "JSON válido com o mesmo conteúdo e cabeçalho de diagnóstico");
    const lidoMd = readFileSync(escritos.find((f) => f.endsWith(".md"))!, "utf8");
    check(lidoMd.startsWith("# classification-audit") && lidoMd.includes("## 5. Relação entre colunas") && lidoMd.includes("## 8. Leitura assistida"), "Markdown com cabeçalho e secções");
    check(![lidoMd, JSON.stringify(lido)].some((t) => t.includes(SEGREDOS.senha) || t.includes(SEGREDOS.host) || /@[a-z]+\.[a-z]/i.test(t)), "ficheiros exportados sem credenciais nem e-mails");
    check(resolverSaidas(path.join(dir, "y.md"), dir, "t").map((x) => x.formato).join() === "json,md", "--out x.md também grava os dois");
    check(resolverSaidas(undefined, dir, "T1").map((x) => x.formato).sort().join() === "json,md", "sem --out: .md e .json em out-dir");
    let erroExt = false;
    try { resolverSaidas(path.join(dir, "x.txt"), dir, "t"); } catch { erroExt = true; }
    check(erroExt, "--out com extensão inválida é recusado");
    check(readdirSync(dir).length >= 1, "ficheiros criados no destino indicado");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${pass} ok, ${fail} falhas`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
