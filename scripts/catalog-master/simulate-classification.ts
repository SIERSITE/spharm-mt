/**
 * scripts/catalog-master/simulate-classification.ts
 *
 * Corre o pipeline de classificação inteiro sobre um CSV exportado do
 * catálogo, SEM tocar em base nenhuma, e mede o resultado.
 *
 * Porquê um simulador e não um `--dry-run` contra a base: para afinar
 * regras é preciso correr as mesmas 28 708 linhas dezenas de vezes. Contra
 * a base isso são dezenas de minutos e uma ligação de produção aberta; a
 * partir de um CSV são segundos, offline, e o mesmo ficheiro dá sempre o
 * mesmo número — que é o que permite dizer "esta regra ganhou 1 240
 * produtos" com confiança.
 *
 * As três fases são exactamente as de produção, pela mesma ordem e com as
 * mesmas funções:
 *
 *   1. classify-backfill.ts  → classifyProductType()   (+ consenso de marca)
 *   2. fill-rules.ts         → mapToCanonical()        (nível 1 + nível 2)
 *   3. backfill-utilizacoes  → avaliarProduto()        (utilizações)
 *
 * Se o simulador e a produção divergirem, é o simulador que está errado.
 *
 * Colunas esperadas (as do export de classificação):
 *   cnp, designacao, productType, productTypeConfidence, classificationSource,
 *   tipoArtigo, flagGenerico, flagMSRM, flagMNSRM, flagMnsrmNCompart,
 *   grupoHomogeneo, classificacaoNivel1Id, classificacaoNivel2Id,
 *   validadoManualmente, needsManualReview
 *
 * Uso:
 *   npx tsx scripts/catalog-master/simulate-classification.ts <ficheiro.csv[.gz]>
 *   npx tsx scripts/catalog-master/simulate-classification.ts <f.csv.gz> --amostras
 *   npx tsx scripts/catalog-master/simulate-classification.ts <f.csv.gz> --json=out.json
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { classifyProductType } from "../../lib/catalog-classifier";
import { mapToCanonical } from "../../lib/catalog-taxonomy-map";
import { avaliarProduto } from "../../lib/catalog/utilizacoes-ciclo";
import { MIN_CONFIANCA } from "../../lib/catalog/utilizacoes-regras";
import type { ProductType } from "../../lib/catalog-types";

/** Igual ao de classify-backfill.ts. */
const MIN_CONFIDENCE = 0.7;
const CONSENSO_MIN = 0.9;
const PRODUTOS_MIN = 2;

// ─── CSV ──────────────────────────────────────────────────────────────────────

/** Parser de CSV com aspas — as designações trazem vírgulas dentro. */
function parseCsv(texto: string): Array<Record<string, string>> {
  const linhas: string[][] = [];
  let campo = "";
  let linha: string[] = [];
  let dentroDeAspas = false;

  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (dentroDeAspas) {
      if (c === '"') {
        if (texto[i + 1] === '"') {
          campo += '"';
          i++;
        } else dentroDeAspas = false;
      } else campo += c;
      continue;
    }
    if (c === '"') dentroDeAspas = true;
    else if (c === ",") {
      linha.push(campo);
      campo = "";
    } else if (c === "\n") {
      linha.push(campo);
      linhas.push(linha);
      linha = [];
      campo = "";
    } else if (c !== "\r") campo += c;
  }
  if (campo || linha.length) {
    linha.push(campo);
    linhas.push(linha);
  }

  const [cabecalho, ...resto] = linhas;
  return resto
    .filter((l) => l.length === cabecalho.length)
    .map((l) => Object.fromEntries(cabecalho.map((h, i) => [h, l[i]])));
}

function lerCatalogo(caminho: string): Array<Record<string, string>> {
  const bruto = readFileSync(caminho);
  const texto = caminho.endsWith(".gz")
    ? gunzipSync(bruto).toString("utf8")
    : bruto.toString("utf8");
  return parseCsv(texto);
}

const bool = (v: string | undefined) => v === "t" || v === "true" || v === "1";
const vazio = (v: string | undefined) => (v && v.trim() ? v.trim() : null);

// ─── Consenso de marca (cópia fiel de classify-backfill.ts) ──────────────────

function marcaDe(designacao: string): string {
  const p = designacao
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/^ch\.\d+\s*/, "")
    .split(/[\s\-/,;:.()[\]]+/)
    .filter(Boolean);
  if (!p[0]) return "";
  return p[0].length <= 2 && p[1] ? `${p[0]} ${p[1]}` : p[0];
}

// ─── Simulação ────────────────────────────────────────────────────────────────

type Linha = {
  cnp: string;
  designacao: string;
  productType: ProductType | null;
  productTypeConfidence: number;
  grupoHomogeneo: string | null;
  flagGenerico: boolean;
  flagMSRM: boolean;
  flagMNSRM: boolean;
  validadoManualmente: boolean;
  /** Classificação já existente no export (a não degradar). */
  n1Existente: string | null;
  n2Existente: string | null;
};

export type Resultado = {
  total: number;
  /** Antes: o que o export já trazia. */
  antes: { comTipo: number; comN1: number; comN2: number };
  depois: {
    comTipo: number;
    comN1: number;
    comN2: number;
    especificos: number;
    fallbackOutros: number;
    naoClassificados: number;
  };
  porMetodo: Record<string, number>;
  porDestino: Record<string, number>;
  porTipoNovo: Record<string, number>;
  semSinal: Array<{ cnp: string; designacao: string; productType: string | null }>;
  outrosPorN1: Record<string, number>;
  outrosAmostras: Record<string, string[]>;
  /** Uma linha por produto — para análise externa (frequência de tokens, etc). */
  detalhe: Array<{
    cnp: string;
    designacao: string;
    productType: string | null;
    nivel1: string | null;
    nivel2: string | null;
    metodo: string | null;
    utilizacoes: string[];
  }>;
  utilizacoes: {
    produtosCom: number;
    associacoes: number;
    porUtilizacao: Record<string, number>;
    amostras: Record<string, string[]>;
  };
};

export function simular(linhasCsv: Array<Record<string, string>>): Resultado {
  const linhas: Linha[] = linhasCsv.map((r) => ({
    cnp: r.cnp,
    designacao: r.designacao ?? "",
    productType: (vazio(r.productType) as ProductType | null) ?? null,
    productTypeConfidence: Number(r.productTypeConfidence) || 0.5,
    grupoHomogeneo: vazio(r.grupoHomogeneo),
    flagGenerico: bool(r.flagGenerico),
    flagMSRM: bool(r.flagMSRM),
    flagMNSRM: bool(r.flagMNSRM),
    validadoManualmente: bool(r.validadoManualmente),
    n1Existente: vazio(r.classificacaoNivel1Id),
    n2Existente: vazio(r.classificacaoNivel2Id),
  }));

  const antes = {
    comTipo: linhas.filter((l) => l.productType).length,
    comN1: linhas.filter((l) => l.n1Existente).length,
    comN2: linhas.filter((l) => l.n2Existente).length,
  };

  // ── Fase 1: productType para quem não tem ──────────────────────────────
  const votos = new Map<string, Map<string, number>>();
  for (const l of linhas) {
    if (!l.productType) continue;
    const m = marcaDe(l.designacao);
    if (m.length < 3) continue;
    if (!votos.has(m)) votos.set(m, new Map());
    const v = votos.get(m)!;
    v.set(l.productType, (v.get(l.productType) ?? 0) + 1);
  }
  const marcaParaTipo = new Map<string, ProductType>();
  for (const [m, v] of votos) {
    const ord = [...v].sort((a, b) => b[1] - a[1]);
    const total = ord.reduce((s, x) => s + x[1], 0);
    if (ord[0][1] / total >= CONSENSO_MIN && ord[0][1] >= PRODUTOS_MIN) {
      marcaParaTipo.set(m, ord[0][0] as ProductType);
    }
  }

  const porTipoNovo: Record<string, number> = {};
  for (const l of linhas) {
    if (l.productType) continue;
    const res = classifyProductType({
      designacao: l.designacao,
      tipoArtigo: null,
      flagMSRM: l.flagMSRM,
      flagMNSRM: l.flagMNSRM,
      codigoATC: null,
      flagGenerico: l.flagGenerico,
      hasRegulatoryRecord: false,
      hasGrupoHomogeneo: l.grupoHomogeneo != null,
    });
    let tipo = res.productType;
    let conf = res.confidence;
    if (tipo === "OUTRO") {
      const porMarca = marcaParaTipo.get(marcaDe(l.designacao));
      if (porMarca) {
        tipo = porMarca;
        conf = 0.75;
      }
    }
    if (tipo === "OUTRO" || conf < MIN_CONFIDENCE) continue;
    l.productType = tipo;
    l.productTypeConfidence = conf;
    porTipoNovo[tipo] = (porTipoNovo[tipo] ?? 0) + 1;
  }

  // ── Fase 2: nível 1 / nível 2 ──────────────────────────────────────────
  const porMetodo: Record<string, number> = {};
  const porDestino: Record<string, number> = {};
  const outrosPorN1: Record<string, number> = {};
  const outrosAmostras: Record<string, string[]> = {};
  const semSinal: Resultado["semSinal"] = [];
  let comN1 = 0;
  let comN2 = 0;
  let especificos = 0;
  let fallbackOutros = 0;

  const classificadas = new Map<string, { n1: string; n2: string; metodo: string }>();

  for (const l of linhas) {
    const canon = mapToCanonical({
      productType: l.productType ?? "OUTRO",
      productTypeConfidence: l.productTypeConfidence,
      externalCategory: null,
      externalSubcategory: null,
      designacao: l.designacao,
      atc: null,
      dci: l.grupoHomogeneo ? (l.grupoHomogeneo.split("|")[0] ?? "").trim() : null,
    });

    if (!canon) {
      semSinal.push({
        cnp: l.cnp,
        designacao: l.designacao,
        productType: l.productType,
      });
      continue;
    }

    comN1++;
    comN2++;
    classificadas.set(l.cnp, { n1: canon.nivel1, n2: canon.nivel2, metodo: canon.method });
    porMetodo[canon.method] = (porMetodo[canon.method] ?? 0) + 1;
    const destino = `${canon.nivel1} > ${canon.nivel2}`;
    porDestino[destino] = (porDestino[destino] ?? 0) + 1;

    if (canon.method === "others_fallback") {
      fallbackOutros++;
      outrosPorN1[canon.nivel1] = (outrosPorN1[canon.nivel1] ?? 0) + 1;
      const amostras = (outrosAmostras[canon.nivel1] ??= []);
      if (amostras.length < 40) amostras.push(l.designacao);
    } else especificos++;
  }

  // ── Fase 3: utilizações ────────────────────────────────────────────────
  const porUtilizacao: Record<string, number> = {};
  const amostras: Record<string, string[]> = {};
  const detalhe: Resultado["detalhe"] = [];
  let produtosCom = 0;
  let associacoes = 0;

  for (const l of linhas) {
    const c = classificadas.get(l.cnp);
    const candidatas = avaliarProduto({
      id: l.cnp,
      designacao: l.designacao,
      productType: l.productType,
      categoria: c?.n1 ?? null,
      subcategoria: c?.n2 ?? null,
      // Sem RegulatoryRecord neste export: ATC nunca entra.
      codigoATC: null,
      grupoHomogeneo: l.grupoHomogeneo,
      temRegulatorio: false,
    });
    const aceites = candidatas.filter((x) => x.confianca >= MIN_CONFIANCA);
    if (aceites.length) produtosCom++;
    for (const a of aceites) {
      associacoes++;
      porUtilizacao[a.utilizacao] = (porUtilizacao[a.utilizacao] ?? 0) + 1;
      const am = (amostras[a.utilizacao] ??= []);
      if (am.length < 5) am.push(l.designacao);
    }
    detalhe.push({
      cnp: l.cnp,
      designacao: l.designacao,
      productType: l.productType,
      nivel1: c?.n1 ?? null,
      nivel2: c?.n2 ?? null,
      metodo: c?.metodo ?? null,
      utilizacoes: aceites.map((a) => a.utilizacao),
    });
  }

  return {
    total: linhas.length,
    antes,
    depois: {
      comTipo: linhas.filter((l) => l.productType).length,
      comN1,
      comN2,
      especificos,
      fallbackOutros,
      naoClassificados: semSinal.length,
    },
    porMetodo,
    porDestino,
    porTipoNovo,
    semSinal,
    outrosPorN1,
    outrosAmostras,
    detalhe,
    utilizacoes: { produtosCom, associacoes, porUtilizacao, amostras },
  };
}

// ─── Relatório ────────────────────────────────────────────────────────────────

function pct(n: number, total: number): string {
  return `${((n / total) * 100).toFixed(1)}%`;
}

function main() {
  const argv = process.argv.slice(2);
  const caminho = argv.find((a) => !a.startsWith("--"));
  if (!caminho) {
    console.error("uso: simulate-classification.ts <ficheiro.csv[.gz]> [--amostras] [--json=out.json]");
    process.exit(1);
  }
  const comAmostras = argv.includes("--amostras");
  const json = argv.find((a) => a.startsWith("--json="))?.split("=")[1];

  const r = simular(lerCatalogo(caminho));
  const t = r.total;
  const pad = (n: number) => String(n).padStart(6);

  console.log(`\ncatálogo: ${t} produtos  (${caminho})\n`);

  console.log("── cobertura ─────────────────────────────────────────────");
  console.log(`  productType   ${pad(r.antes.comTipo)} (${pct(r.antes.comTipo, t)})  →  ${pad(r.depois.comTipo)} (${pct(r.depois.comTipo, t)})`);
  console.log(`  nível 1       ${pad(r.antes.comN1)} (${pct(r.antes.comN1, t)})  →  ${pad(r.depois.comN1)} (${pct(r.depois.comN1, t)})`);
  console.log(`  nível 2       ${pad(r.antes.comN2)} (${pct(r.antes.comN2, t)})  →  ${pad(r.depois.comN2)} (${pct(r.depois.comN2, t)})`);
  console.log();
  console.log(`  específicos       ${pad(r.depois.especificos)} (${pct(r.depois.especificos, t)})`);
  console.log(`  fallback "Outros" ${pad(r.depois.fallbackOutros)} (${pct(r.depois.fallbackOutros, t)})`);
  console.log(`  NÃO CLASSIFICADO  ${pad(r.depois.naoClassificados)} (${pct(r.depois.naoClassificados, t)})`);

  console.log("\n── método do mapper ──────────────────────────────────────");
  for (const [k, v] of Object.entries(r.porMetodo).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pad(v)}  ${k}`);
  }

  if (Object.keys(r.porTipoNovo).length) {
    console.log("\n── productType inferido nesta corrida ───────────────────");
    for (const [k, v] of Object.entries(r.porTipoNovo).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${pad(v)}  ${k}`);
    }
  }

  console.log("\n── fallback \"Outros <X>\" por nível 1 ─────────────────────");
  for (const [k, v] of Object.entries(r.outrosPorN1).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pad(v)}  ${k}`);
  }

  console.log("\n── destino (top 25) ──────────────────────────────────────");
  for (const [k, v] of Object.entries(r.porDestino).sort((a, b) => b[1] - a[1]).slice(0, 25)) {
    console.log(`  ${pad(v)}  ${k}`);
  }

  const u = r.utilizacoes;
  console.log("\n── utilizações ───────────────────────────────────────────");
  console.log(`  produtos com ≥1 utilização: ${u.produtosCom} (${pct(u.produtosCom, t)})`);
  console.log(`  associações: ${u.associacoes}`);
  for (const [k, v] of Object.entries(u.porUtilizacao).sort((a, b) => b[1] - a[1]).slice(0, 30)) {
    console.log(`  ${pad(v)}  ${k}`);
  }

  if (comAmostras) {
    console.log("\n── amostras de \"Outros <X>\" ──────────────────────────────");
    for (const [n1, exs] of Object.entries(r.outrosAmostras).sort(
      (a, b) => (r.outrosPorN1[b[0]] ?? 0) - (r.outrosPorN1[a[0]] ?? 0),
    )) {
      console.log(`\n  ${n1} (${r.outrosPorN1[n1]}):`);
      for (const e of exs.slice(0, 25)) console.log(`     ${e}`);
    }
    console.log("\n── amostras NÃO CLASSIFICADO ─────────────────────────────");
    for (const s of r.semSinal.slice(0, 60)) {
      console.log(`     [${s.productType ?? "sem tipo"}] ${s.designacao}`);
    }
  }

  if (json) {
    writeFileSync(json, JSON.stringify(r, null, 2));
    console.log(`\njson: ${json}`);
  }
  const dump = argv.find((a) => a.startsWith("--dump="))?.split("=")[1];
  if (dump) {
    const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const linhas = [
      "cnp,designacao,productType,nivel1,nivel2,metodo,utilizacoes",
      ...r.detalhe.map((d) =>
        [
          d.cnp,
          esc(d.designacao),
          d.productType ?? "",
          esc(d.nivel1 ?? ""),
          esc(d.nivel2 ?? ""),
          d.metodo ?? "",
          esc(d.utilizacoes.join("|")),
        ].join(","),
      ),
    ];
    writeFileSync(dump, linhas.join("\n"), "utf8");
    console.log(`dump: ${dump}`);
  }
}

if (process.argv[1]?.includes("simulate-classification")) main();
