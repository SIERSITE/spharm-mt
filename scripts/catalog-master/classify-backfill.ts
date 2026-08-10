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
 *   npx tsx scripts/catalog-master/classify-backfill.ts --dry-run
 *   npx tsx scripts/catalog-master/classify-backfill.ts
 *   npx tsx scripts/catalog-master/classify-backfill.ts --db=spharmmt_t_xxx
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
  const dbName =
    argv.find((a) => a.startsWith("--db="))?.split("=")[1] ??
    "spharmmt_t_grupo_silveira";

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

  const escrever: Array<{ id: string; tipo: ProductType; conf: number; fonte: string }> = [];
  const porTipo = new Map<string, number>();
  const porFonte = new Map<string, number>();
  let semSinal = 0;
  let abaixoLimiar = 0;

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

    if (res.productType === "OUTRO") {
      semSinal++;
      continue;
    }
    if (res.confidence < MIN_CONFIDENCE) {
      abaixoLimiar++;
      continue;
    }

    escrever.push({
      id: r.id,
      tipo: res.productType,
      conf: res.confidence,
      fonte: res.classificationSource,
    });
    porTipo.set(res.productType, (porTipo.get(res.productType) ?? 0) + 1);
    porFonte.set(res.classificationSource, (porFonte.get(res.classificationSource) ?? 0) + 1);
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
