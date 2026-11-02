/**
 * Despeja o HTML de relatórios que NÃO são o Mapa de Vendas (genérico confortável, compacto «normal», compacto «strong» como o de Margens, com
 * grupos e subtotais), para comparar árvores: o HTML dos outros relatórios tem de ser o mesmo que em a012428.
 *
 *   ROOT=<árvore> OUT=<ficheiro.json> npx tsx scripts/tests/_html-dump.ts      (cwd = ROOT)
 *
 * Saída: { nome: { corpo, css } } — `corpo` = o HTML sem o <style>; `css` = as regras do <style> que NÃO são do Mapa de Vendas (sem
 * `hierarchy-clean`, `bloco`, `mes-alt`), uma por linha, sem comentários. Se estas duas partes forem iguais, o PDF é igual.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.env.ROOT ?? process.cwd();
const OUT = process.env.OUT ?? "html.json";
const imp = (rel: string) => import(pathToFileURL(path.join(ROOT, rel)).href);

(async () => {
  const { renderReportHtml } = await imp("lib/reporting/report-html.ts");
  const GROUP_KEY = "__group", ROW_KIND_KEY = "__rowKind";
  const data = new Date("2026-11-02T14:00:00Z");
  const colunas = (extra: Record<string, unknown> = {}) => [
    { key: "codigo", label: "Código", format: "text", spanGroup: true, width: 12, ...extra },
    { key: "descricao", label: "Descrição", format: "text", spanGroup: true, width: 30 },
    { key: "farmacia", label: "Farmácia", format: "text", width: 16 },
    { key: "qtd", label: "Qtd", format: "integer", showTotal: true, width: 10, monthAlt: true },
    { key: "valor", label: "Valor", format: "currency", showTotal: true, width: 14, noClip: true, stockIndicator: true, toneWhenZero: "danger" },
  ];
  const linhas = Array.from({ length: 12 }, (_, i) => ({ codigo: String(7000000 + Math.floor(i / 2)), descricao: `Produto ${Math.floor(i / 2)}`, farmacia: i % 2 ? "B" : "A", qtd: i * 3 - 4, valor: i * 1.5, [GROUP_KEY]: String(7000000 + Math.floor(i / 2)), [ROW_KIND_KEY]: "detalhe" }));
  const comSub = linhas.flatMap((l, i) => (i % 2 === 1 ? [l, { codigo: l.codigo, descricao: l.descricao, farmacia: "TOTAL ARTIGO", qtd: 1, valor: 2, [GROUP_KEY]: l[GROUP_KEY], [ROW_KIND_KEY]: "subtotal" }] : [l]));
  const base = { title: "Relatório de teste", generatedAt: data, filtersApplied: [{ label: "Período", value: "2026" }], summary: [{ label: "Linhas", value: 12, format: "integer" }] };
  const relatorios: Record<string, unknown> = {
    confortavel: { ...base, columns: colunas(), rows: linhas.map((l) => ({ ...l, [GROUP_KEY]: undefined })), meta: { slug: "x", orientation: "landscape", footer: "rodapé" } },
    compacto: { ...base, columns: colunas(), rows: comSub, meta: { slug: "x", orientation: "landscape", density: "compact", footer: "rodapé", resumoFaixa: ["Linhas"] } },
    "compacto-strong-tight": { ...base, columns: colunas(), rows: comSub, meta: { slug: "x", orientation: "landscape", density: "compact", hierarchy: "strong", tableDensity: "tight", footer: "rodapé", totalLabel: "TOTAL GERAL", resumoFaixa: ["Linhas"] } },
    vertical: { ...base, columns: colunas().slice(0, 3), rows: linhas.slice(0, 4), meta: { slug: "x", orientation: "portrait" } },
  };
  const saida: Record<string, { corpo: string; css: string }> = {};
  for (const [nome, rel] of Object.entries(relatorios)) {
    const html: string = renderReportHtml(rel);
    const m = html.match(/<style>([\s\S]*?)<\/style>/);
    const css = (m?.[1] ?? "").replace(/\/\*[\s\S]*?\*\//g, "").split("}").map((r) => r.replace(/\s+/g, " ").trim()).filter((r) => r && !/hierarchy-clean|bloco|mes-alt/.test(r)).join("\n");
    saida[nome] = { corpo: html.replace(/<style>[\s\S]*?<\/style>/, "<style></style>"), css };
  }
  writeFileSync(OUT, JSON.stringify(saida));
  console.log(`${OUT}: ${Object.keys(saida).length} relatórios`);
})().catch((e) => { console.error(e); process.exit(1); });
