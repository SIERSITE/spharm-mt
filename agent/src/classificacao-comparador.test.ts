/**
 * agent/src/classificacao-comparador.test.ts
 *
 * Testa o comparador OFFLINE agent/audit/Compare-AuditReports.ps1 com relatórios SINTÉTICOS gerados pela própria
 * auditoria (ERP falso): «Silveirense» (lookup padrão), «Garantia» (lookup diferente, coluna a menos, Generico NOT NULL)
 * e um relatório no formato v1 (sem secções v2). O comparador só lê os .json e só escreve em stdout / no -Out pedido.
 *
 * Uso: npx tsx agent/src/classificacao-comparador.test.ts
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { criarLeitorSeguro, executarAuditoria, pacoteOmissao } from "./classificacao-auditoria.js";
import { erpFalso, type Cenario, type ColDef, type RowStocks } from "./classificacao-erp-falso.js";

let pass = 0;
let fail = 0;
const check = (c: boolean, l: string, d?: string) => {
  if (c) { pass++; console.log(`  [OK]    ${l}`); }
  else { fail++; console.log(`  [FALHA] ${l}${d ? `\n            ${d}` : ""}`); }
};

const COLS: ColDef[] = [
  ["CodigoID", "int", 4], ["Codigo", "int", 4], ["Generico", "bit", 1], ["Etico_NETT", "int", 4], ["Processa_Stocks", "int", 4], ["Retirado", "bit", 1],
  ["Campo10", "varchar", 20], ["Campo11", "varchar", 20],
];
function dados(n: number, cods: Array<number | null>): RowStocks[] {
  return Array.from({ length: n }, (_, i) => ({
    CodigoID: i + 1, Codigo: 4_000_000 + i, Generico: i % 4 === 0 ? 1 : 0, Etico_NETT: cods[i % cods.length]!, Processa_Stocks: i % 9 === 0 ? 0 : -1, Retirado: 0,
    Campo10: "x", Campo11: "y",
  }));
}
const LOOKUP_SILV: RowStocks[] = [
  { Codigo: 1, Descricao: "Éticos" }, { Codigo: 2, Descricao: "NETT" }, { Codigo: 3, Descricao: "Serviços" }, { Codigo: 4, Descricao: "Sacos L." }, { Codigo: 5, Descricao: "Outros" },
];
const LOOKUP_GAR: RowStocks[] = [
  { Codigo: 1, Descricao: "Éticos" }, { Codigo: 2, Descricao: "NETT" }, { Codigo: 3, Descricao: "Serviços Farmacêuticos" }, { Codigo: 6, Descricao: "Sacos" }, { Codigo: 7, Descricao: "Genéricos" },
];
const TAB: ColDef[] = [["Codigo", "int", 4], ["Descricao", "varchar", 30]];
const cen = (base: string, lookup: RowStocks[], cols: ColDef[], n: number, cods: Array<number | null>, gnull: boolean): Cenario => ({
  stocksCols: cols,
  dados: dados(n, cods),
  tabelas: [{ tabela: "Etico_NETT", cols: TAB, linhas: lookup.length }],
  conteudo: { Etico_NETT: lookup },
  fks: [{ coluna: "Etico_NETT", tabelaRef: "Etico_NETT", colunaRef: "Codigo" }],
  anulavel: { Stocks: { Generico: gnull } },
  baseDados: base,
});

async function gerar(c: Cenario) {
  const erp = erpFalso(c);
  const rel = await executarAuditoria(criarLeitorSeguro(erp.ler, []), { agora: () => new Date("2026-10-29T10:00:00Z"), pacote: pacoteOmissao("abc1234") });
  return rel;
}

function ps(args: string[]) {
  const script = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "audit", "Compare-AuditReports.ps1");
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, ...args], { encoding: "utf8" });
  return { exit: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
const sha = (f: string) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-rel-"));
  try {
    const silv = await gerar(cen("SPharmSilveirense", LOOKUP_SILV, COLS, 90, [1, 2, 2, 3, 4, 5, null], true));
    const gar = await gerar(cen("SPharmGarantia", LOOKUP_GAR, COLS.filter((c) => c[0] !== "Campo11"), 60, [1, 2, 3, 6, 7, 9], false));
    const v1 = JSON.parse(JSON.stringify(silv)) as Record<string, unknown>;
    for (const k of ["stocksColunas", "parametros", "historico", "camposMeta", "mapeamentoEticoNett", "universos"]) delete v1[k];
    delete (v1.cabecalho as Record<string, unknown>).impressao;
    delete (v1.cabecalho as Record<string, unknown>).schemaRelatorio;
    (v1.cabecalho as Record<string, unknown>).baseDados = "SPharmAntigo";
    const fS = path.join(dir, "silveirense.json");
    const fG = path.join(dir, "garantia.json");
    const fV = path.join(dir, "antigo-v1.json");
    fs.writeFileSync(fS, JSON.stringify(silv, null, 2), "utf8");
    fs.writeFileSync(fG, JSON.stringify(gar, null, 2), "utf8");
    fs.writeFileSync(fV, JSON.stringify(v1, null, 2), "utf8");
    const antes = [fS, fG, fV].map(sha);
    const listaAntes = fs.readdirSync(dir).sort().join();

    console.log("\n=== Comparador: Silveirense x Garantia ===");
    const r = ps(["-Reports", `${fS},${fG}`]);
    check(r.exit === 0, "exit 0", r.out.slice(0, 400));
    check(r.out.includes("Relatorios: SPharmSilveirense | SPharmGarantia"), "rótulos = nome da base de dados de cada relatório");
    check(/impressao combinada \(curta\)\s+\S+ \| \S+\s+<-- DIFERENTE/.test(r.out) && r.out.includes("impressoes DIFERENTES"), "impressões diferentes assinaladas");
    check(/impressao do lookup[^\n]*<-- DIFERENTE/.test(r.out) && /impressao colunas Stocks[^\n]*<-- DIFERENTE/.test(r.out), "impressão do lookup e das colunas diferentes");
    check(/codigo 3[^\n]*Servicos -> servicos \[SERVICO\][^\n]*Servicos Farmaceuticos -> servicos farmaceuticos \[SERVICO\][^\n]*<-- DIFERENTE/.test(r.out), "lookup: código 3 com descrição diferente (mesma categoria)", r.out.split("\n").filter((l) => /codigo/.test(l)).join("\n"));
    check(/codigo 4[^\n]*Sacos L\. -> sacos l \[SACOS\][^\n]*\(ausente\)[^\n]*<-- DIFERENTE/.test(r.out) && /codigo 6[^\n]*\(ausente\)[^\n]*Sacos -> sacos \[SACOS\]/.test(r.out), "lookup: códigos 4 / 6 presentes só num dos lados");
    check(/codigo 7[^\n]*Genericos -> genericos \[UNKNOWN\]/.test(r.out), "lookup: descrição que não mapeia (UNKNOWN) visível");
    check(/coluna 'campo11' NAO existe em: SPharmGarantia/.test(r.out), "colunas de Stocks: Campo11 não existe na Garantia");
    check(/dbo\.Stocks\.Generico[^\n]*anulavel=sim[^\n]*anulavel=nao[^\n]*<-- DIFERENTE/.test(r.out), "Generico: anulável numa, NOT NULL na outra");
    check(/total ERP: ETICO\s+\d+ \| \d+/.test(r.out) && /Processa_Stocks = 0\s+\d+ \| \d+/.test(r.out), "contagens por categoria e Processa_Stocks lado a lado");
    check(/alertas de SPharmGarantia:[\s\S]*órfãos|alertas de SPharmGarantia:[\s\S]*orfaos|alertas de SPharmGarantia:[\s\S]*Silveirense/.test(r.out), "alertas do mapeamento da Garantia (códigos diferentes da Silveirense / órfãos) listados");
    check(/Universo MT calculado\s+nao \| nao/.test(r.out) || /universo MT calculado\s+nao \| nao/i.test(r.out), "sem ficheiro MT: universo MT «nao» nos dois");
    check(/\d+ diferenca\(s\) estrutural/.test(r.out), "resumo com o nº de diferenças");

    console.log("\n=== Comparador: três relatórios (um no formato v1) e -Out ===");
    const out3 = path.join(dir, "saida", "comparacao.txt");
    const r3 = ps(["-Reports", `${fS},${fG},${fV}`, "-Out", out3, "-Labels", "SILV,GAR,ANT"]);
    check(r3.exit === 0 && r3.out.includes("Relatorios: SILV | GAR | ANT"), "3 relatórios com rótulos próprios", r3.out.slice(0, 300));
    check(/impressao combinada \(curta\)[^\n]*n\/d/.test(r3.out) && r3.out.includes("relatorio nao tem impressao"), "relatório v1 aceite: campos em falta = n/d, com aviso", r3.out.split("\n").filter((l) => /impressao/.test(l)).join("\n"));
    check(fs.existsSync(out3) && fs.readFileSync(out3, "utf8").includes("Comparacao de relatorios") && fs.readFileSync(out3, "utf8").includes("Resumo"), "-Out gravou a comparação (cria a pasta pedida)");
    check([fS, fG, fV].map(sha).join() === antes.join(), "os relatórios de entrada ficam byte a byte inalterados");
    check(fs.readdirSync(dir).sort().join() === [...listaAntes.split(","), "saida"].sort().join() && fs.readdirSync(path.join(dir, "saida")).join() === "comparacao.txt", "nada foi escrito além do -Out pedido");

    console.log("\n=== Comparador: mesmo relatório duas vezes = sem diferenças ===");
    const f2 = path.join(dir, "silveirense-copia.json");
    fs.copyFileSync(fS, f2);
    const rIg = ps(["-Reports", `${fS},${f2}`]);
    check(rIg.exit === 0 && rIg.out.includes("impressoes IGUAIS") && rIg.out.includes("Nenhuma diferenca estrutural relevante") && !rIg.out.includes("<-- DIFERENTE"), "relatórios iguais: «impressões IGUAIS» e nenhuma diferença", rIg.out.slice(0, 500));
    check(rIg.out.includes("Relatorios: SPharmSilveirense | SPharmSilveirense#2"), "rótulos repetidos desambiguados");

    console.log("\n=== Comparador: erros ===");
    const e1 = ps(["-Reports", fS]);
    check(e1.exit === 1 && /pelo menos 2/.test(e1.out), "um só relatório: exit 1");
    fs.writeFileSync(path.join(dir, "lixo.json"), "isto nao e json", "utf8");
    const e2 = ps(["-Reports", `${fS},${path.join(dir, "lixo.json")}`]);
    check(e2.exit === 1 && /JSON invalido/.test(e2.out), "JSON inválido: exit 1");
    fs.writeFileSync(path.join(dir, "outro.json"), JSON.stringify({ a: 1 }), "utf8");
    const e3 = ps(["-Reports", `${fS},${path.join(dir, "outro.json")}`]);
    check(e3.exit === 1 && /nao parece um relatorio/.test(e3.out), "JSON que não é relatório: exit 1");
    const e4 = ps(["-Reports", `${fS},${fG}`, "-Out", fS]);
    check(e4.exit === 1 && /-Out nao pode ser um dos relatorios/.test(e4.out) && sha(fS) === antes[0], "-Out igual a um relatório: recusado, relatório intacto");
    const e5 = ps(["-Reports", `${fS},${path.join(dir, "nao-existe.json")}`]);
    check(e5.exit === 1 && /nao encontrado/.test(e5.out), "relatório inexistente: exit 1");
    const e6 = ps(["-Reports", `${fS},${fG}`, "-Labels", "so-um"]);
    check(e6.exit === 1 && /numero de -Labels/.test(e6.out), "nº de rótulos ≠ nº de relatórios: exit 1");
    const e7 = ps(["-Reports", `${fS},${path.join(dir, "silveirense.md")}`]);
    check(e7.exit === 1, "só .json (um .md/inexistente é recusado)");

    console.log("\n=== Comparador: só lê e escreve em stdout/-Out (análise estática) ===");
    const src = fs.readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "audit", "Compare-AuditReports.ps1"), "utf8");
    const proibidos = /Invoke-WebRequest|Invoke-RestMethod|Start-Process|Set-Content|Add-Content|Out-File|Remove-Item|Copy-Item|Move-Item|Rename-Item|Set-ItemProperty|New-PSDrive|Register-|Start-Job|sqlcmd|Invoke-Sqlcmd|System\.Net|Invoke-Expression|\biex\b/i;
    check(!proibidos.test(src), "sem cmdlets de rede, SQL, remoção, cópia nem Set-Content/Out-File");
    check(!/[^\x00-\x7F]/.test(src), "script em ASCII (PowerShell 5.1 sem BOM)");
    const escritas = [...src.matchAll(/WriteAllText|New-Item/g)].length;
    check(escritas === 2 && /WriteAllText\(\$outFull/.test(src), "única escrita: WriteAllText no -Out (e New-Item da sua pasta)");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\n${pass} ok, ${fail} falhas`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
