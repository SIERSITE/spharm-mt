/**
 * scripts/catalog-master/classify-backfill.ts
 *
 * Aplica o classificador de tipo de produto ao universo que nunca foi
 * classificado. Não é enriquecimento: não vai à Internet, não escreve
 * categoria nem laboratório. Só decide *o que é* cada produto, para que o
 * builder possa depois escolher os conectores certos.
 *
 * ── Porque é que existem produtos por classificar ────────────────────
 * Não é um problema de limiar de confiança: os 18 698 estavam todos em
 * verificationStatus=PENDING com lastVerificationAttemptAt=NULL. A
 * classificação nunca lhes chegou. Este script fecha essa lacuna de uma vez.
 *
 * ── Política de escrita ──────────────────────────────────────────────
 *  1. Nunca toca em produtos que já tenham productType.
 *  2. Nunca toca em CNP < 2 000 000 (códigos internos da farmácia).
 *  3. Só escreve com confiança >= MIN_CONFIDENCE.
 *  4. Nunca escreve OUTRO. OUTRO não é uma classificação, é a ausência de
 *     uma — gravá-lo transformaria "não sei" em "já tratado" e escondia o
 *     trabalho que falta. Fica NULL, e conta como universo por resolver.
 *
 * Uso:
 *   npx tsx scripts/catalog-master/classify-backfill.ts --db=spharmmt_t_silveira --dry-run
 *   npx tsx scripts/catalog-master/classify-backfill.ts --db=spharmmt_t_silveira
 */
import "dotenv/config";
import pg from "pg";
import {
  classifyProductType,
  CLASSIFICATION_VERSION,
} from "../../lib/catalog-classifier";
import type { ProductType } from "../../lib/catalog-types";

const MIN_CNP = 2_000_000;
const MIN_CONFIDENCE = 0.70;
const BATCH = 500;

type Row = {
  id: string;
  cnp: number;
  designacao: string;
  tipoArtigo: string | null;
  flagMSRM: boolean;
  flagMNSRM: boolean;
  flagGenerico: boolean;
  codigoATC: string | null;
  grupoHomogeneo: string | null;
  reg: number | null;
};

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const dbName = argv.find((a) => a.startsWith("--db="))?.split("=")[1];
  if (!dbName) {
    // Não há base por omissão, de propósito. O valor que aqui estava
    // ("spharmmt_t_grupo_silveira") deixou de existir, e um nome por
    // omissão é uma decisão tomada há meses por outra pessoa noutro
    // contexto — ver a nota em lib/catalog/target-db.ts.
    console.error("Falta --db=<base>. Produção: --db=spharmmt_t_silveira");
    process.exit(1);
  }

  const url = process.env.DATABASE_URL!.replace(
    /\/[^/?]+(\?|$)/,
    `/${dbName}$1`,
  );
  const db = new pg.Client({ connectionString: url });
  await db.connect();

  // O endpoint `-pooler` do Neon reutiliza ligações de servidor entre clientes
  // e não repõe parâmetros de sessão. Basta um script de diagnóstico ter feito
  // `SET default_transaction_read_only = on` para o valor ficar colado a uma
  // ligação do pool e as escritas de OUTRO processo passarem a falhar com
  // "cannot execute UPDATE in a read-only transaction". Limpar à entrada
  // torna este script imune a esse estado herdado.
  await db.query("set session default_transaction_read_only = off");

  console.log(`base: ${dbName}${dryRun ? "  (dry-run — não escreve)" : ""}`);
  console.log(`regras: versão ${CLASSIFICATION_VERSION}, confiança mínima ${MIN_CONFIDENCE}\n`);

  const { rows } = await db.query<Row>(
    `select p.id, p.cnp, p.designacao, p."tipoArtigo", p."flagMSRM", p."flagMNSRM",
            p."flagGenerico", p."codigoATC", p."grupoHomogeneo",
            (select r.cnp from "RegulatoryRecord" r where r.cnp = p.cnp) as reg
       from "Produto" p
      where p.cnp >= $1 and p."productType" is null`,
    [MIN_CNP],
  );
  console.log(`por classificar: ${rows.length}`);

  // ── Consenso de marca, aprendido do catálogo já classificado ─────────
  //
  // Quando uma marca tem vários produtos já classificados e todos (ou
  // quase) são do mesmo tipo, os irmãos por classificar são do mesmo
  // tipo. Não é heurística sobre palavras: é propagação de classificações
  // já estabelecidas para produtos da mesma marca.
  //
  // Exige >= 2 produtos já classificados e >= 90% de acordo. Marcas com
  // gamas mistas (um laboratório que faz medicamento e cosmético) não
  // atingem o consenso e ficam de fora — é o comportamento certo.
  const CONSENSO_MIN = 0.9;
  const PRODUTOS_MIN = 2;

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

  const classificados = await db.query<{ designacao: string; productType: string }>(
    `select p.designacao, p."productType" from "Produto" p
      where p.cnp >= $1 and p."productType" is not null`,
    [MIN_CNP],
  );
  const votos = new Map<string, Map<string, number>>();
  for (const p of classificados.rows) {
    const m = marcaDe(p.designacao);
    if (m.length < 3) continue;
    if (!votos.has(m)) votos.set(m, new Map());
    const v = votos.get(m)!;
    v.set(p.productType, (v.get(p.productType) ?? 0) + 1);
  }
  const marcaParaTipo = new Map<string, ProductType>();
  for (const [m, v] of votos) {
    const ord = [...v].sort((a, b) => b[1] - a[1]);
    const total = ord.reduce((s, x) => s + x[1], 0);
    if (ord[0][1] / total >= CONSENSO_MIN && ord[0][1] >= PRODUTOS_MIN) {
      marcaParaTipo.set(m, ord[0][0] as ProductType);
    }
  }
  console.log(`marcas com tipo consensual: ${marcaParaTipo.size}`);

  const escrever: Array<{ id: string; tipo: ProductType; conf: number; fonte: string }> = [];
  const porTipo = new Map<string, number>();
  const porFonte = new Map<string, number>();
  let semSinal = 0;
  let abaixoLimiar = 0;
  let porConsenso = 0;

  for (const r of rows) {
    const res = classifyProductType({
      designacao: r.designacao,
      tipoArtigo: r.tipoArtigo,
      flagMSRM: r.flagMSRM,
      flagMNSRM: r.flagMNSRM,
      codigoATC: r.codigoATC,
      flagGenerico: r.flagGenerico,
      hasRegulatoryRecord: r.reg != null,
      hasGrupoHomogeneo: r.grupoHomogeneo != null,
    });

    let productType = res.productType;
    let confidence = res.confidence;
    let fonte: string = res.classificationSource;

    // O classificador não viu nada, mas a marca pode já estar decidida
    // pelos irmãos. Confiança deliberadamente abaixo da de qualquer sinal
    // regulamentar: é inferência por vizinhança, não facto sobre o produto.
    if (productType === "OUTRO") {
      const porMarca = marcaParaTipo.get(marcaDe(r.designacao));
      if (porMarca) {
        productType = porMarca;
        confidence = 0.75;
        fonte = "BRAND_CONSENSUS";
        porConsenso++;
      }
    }

    if (productType === "OUTRO") {
      semSinal++;
      continue;
    }
    if (confidence < MIN_CONFIDENCE) {
      abaixoLimiar++;
      continue;
    }

    escrever.push({ id: r.id, tipo: productType, conf: confidence, fonte });
    porTipo.set(productType, (porTipo.get(productType) ?? 0) + 1);
    porFonte.set(fonte, (porFonte.get(fonte) ?? 0) + 1);
  }

  const pad = (n: number) => String(n).padStart(6);
  console.log(`a classificar:  ${escrever.length}`);
  console.log(`fica por resolver (sem sinal, mantém-se NULL): ${semSinal}`);
  console.log(`abaixo do limiar de confiança: ${abaixoLimiar}\n`);

  console.log("por tipo:");
  for (const [k, v] of [...porTipo].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pad(v)}  ${k}`);
  }
  console.log("\npor fonte do sinal:");
  for (const [k, v] of [...porFonte].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pad(v)}  ${k}`);
  }

  if (dryRun) {
    console.log("\ndry-run: nada foi escrito.");
    await db.end();
    return;
  }

  // Escrita em lotes, set-based: uma query por lote em vez de uma por produto.
  // A guarda `productType is null` no WHERE torna o script idempotente e
  // impede que uma segunda corrida sobreponha o que já foi decidido.
  let escritos = 0;
  for (let i = 0; i < escrever.length; i += BATCH) {
    const lote = escrever.slice(i, i + BATCH);
    const res = await db.query(
      `update "Produto" p
          set "productType" = v.tipo,
              "productTypeConfidence" = v.conf,
              "classificationSource" = v.fonte,
              "classificationVersion" = $1,
              "dataAtualizacao" = now()
         from (select unnest($2::text[]) as id,
                      unnest($3::text[]) as tipo,
                      unnest($4::float8[]) as conf,
                      unnest($5::text[]) as fonte) v
        where p.id = v.id and p."productType" is null`,
      [
        CLASSIFICATION_VERSION,
        lote.map((x) => x.id),
        lote.map((x) => x.tipo),
        lote.map((x) => x.conf),
        lote.map((x) => x.fonte),
      ],
    );
    escritos += res.rowCount ?? 0;
    process.stdout.write(`\r  escritos ${escritos}/${escrever.length}`);
  }
  console.log(`\n\nclassificados: ${escritos}`);

  await db.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
