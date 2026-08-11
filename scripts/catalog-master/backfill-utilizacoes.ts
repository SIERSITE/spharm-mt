/**
 * scripts/catalog-master/backfill-utilizacoes.ts
 *
 * Povoa ProdutoUtilizacao a partir dos sinais que o catálogo já tem.
 * Determinístico: sem rede, sem modelo de linguagem, sem heurística de
 * marca. As regras estão em lib/catalog/utilizacoes-regras.ts.
 *
 * O que este script garante:
 *  · nada é escrito abaixo de MIN_CONFIANCA, e o que foi recusado é
 *    contado e mostrado — "não classificado" e "classificado mal" são
 *    problemas diferentes e têm de se distinguir no relatório;
 *  · uma associação MANUAL nunca é tocada;
 *  · uma associação automática só é substituída por outra de confiança
 *    superior;
 *  · não existe regra de recurso: sem sinal forte, o produto fica sem
 *    utilização.
 *
 * ATC e DCI só são usados quando o produto tem RegulatoryRecord — isto é,
 * quando vieram do INFARMED. Um ATC inferido por nós não é fonte
 * regulatória e não pode alimentar a faceta.
 *
 * Uso:
 *   npx tsx scripts/catalog-master/backfill-utilizacoes.ts [--db=<base>] [--dry-run]
 */
import "dotenv/config";
import pg from "pg";
import { UTILIZACOES_POR_SLUG } from "../../lib/catalog/utilizacoes";
import {
  MIN_CONFIANCA,
  REGRAS_ATC,
  REGRAS_CATEGORIA,
  REGRAS_SUBCATEGORIA,
  REGRAS_SUBSTANCIA,
  REGRAS_TEXTO,
} from "../../lib/catalog/utilizacoes-regras";

const MIN_CNP = 2_000_000;
const FONTE = "REGRA";

type ProdutoRow = {
  id: string;
  designacao: string;
  productType: string | null;
  categoria: string | null;
  subcategoria: string | null;
  codigoATC: string | null;
  grupoHomogeneo: string | null;
  temRegulatorio: boolean;
};

type Candidata = { utilizacao: string; confianca: number; regra: string };

function normalizar(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

/** Todas as utilizações que os sinais deste produto sustentam. */
function avaliar(p: ProdutoRow): Candidata[] {
  const out: Candidata[] = [];

  // ATC — só quando é regulatório. É o sinal mais forte que temos.
  if (p.codigoATC && p.temRegulatorio) {
    const atc = p.codigoATC.toUpperCase();
    for (const r of REGRAS_ATC) {
      if (atc.startsWith(r.atc)) out.push({ utilizacao: r.utilizacao, confianca: r.confianca, regra: `ATC ${r.atc}` });
    }
  }

  // Grupo Homogéneo: a substância vem no início ("Paracetamol | A101 | ...").
  if (p.grupoHomogeneo) {
    const substancia = normalizar(p.grupoHomogeneo.split("|")[0] ?? "");
    for (const r of REGRAS_SUBSTANCIA) {
      if (substancia.includes(normalizar(r.nome))) {
        out.push({ utilizacao: r.utilizacao, confianca: r.confianca, regra: `GH ${r.nome}` });
      }
    }
  }

  if (p.subcategoria) {
    for (const r of REGRAS_SUBCATEGORIA) {
      if (r.nome === p.subcategoria) {
        out.push({ utilizacao: r.utilizacao, confianca: r.confianca, regra: `Subcat "${r.nome}"` });
      }
    }
  }

  if (p.categoria) {
    for (const r of REGRAS_CATEGORIA) {
      if (r.nome === p.categoria) {
        out.push({ utilizacao: r.utilizacao, confianca: r.confianca, regra: `Cat "${r.nome}"` });
      }
    }
  }

  for (const r of REGRAS_TEXTO) {
    if (r.tipos && !r.tipos.includes(p.productType ?? "")) continue;
    if (r.padrao.test(p.designacao)) {
      out.push({ utilizacao: r.utilizacao, confianca: r.confianca, regra: `Texto ${r.padrao.source.slice(0, 24)}` });
    }
  }

  // Duas regras podem apontar à mesma utilização (ATC e subcategoria, por
  // exemplo). Fica a mais confiante — não se somam sinais, porque duas
  // pistas fracas não fazem uma forte.
  const melhor = new Map<string, Candidata>();
  for (const c of out) {
    const j = melhor.get(c.utilizacao);
    if (!j || c.confianca > j.confianca) melhor.set(c.utilizacao, c);
  }
  return [...melhor.values()];
}

async function main() {
  const argv = process.argv.slice(2);
  const dbName =
    argv.find((a) => a.startsWith("--db="))?.split("=")[1] ?? "spharmmt_t_grupo_silveira";
  const dryRun = argv.includes("--dry-run");

  const url = process.env.DATABASE_URL!.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
  const db = new pg.Client({ connectionString: url });
  await db.connect();

  console.log(`Base: ${dbName}${dryRun ? "   (dry-run — nada é escrito)" : ""}`);
  console.log(`Limiar de confiança: ${MIN_CONFIANCA}\n`);

  const { rows: vocab } = await db.query<{ id: string; slug: string }>(
    `select id, slug from "Utilizacao" where estado = 'ATIVO'`,
  );
  const idPorSlug = new Map(vocab.map((v) => [v.slug, v.id]));
  if (!idPorSlug.size) {
    console.error("Vocabulário vazio. Correr seed-utilizacoes.ts primeiro.");
    process.exit(1);
  }

  const { rows: produtos } = await db.query<ProdutoRow>(
    `select p.id,
            p.designacao,
            p."productType",
            c1.nome as categoria,
            c2.nome as subcategoria,
            p."codigoATC",
            p."grupoHomogeneo",
            (r.cnp is not null) as "temRegulatorio"
       from "Produto" p
       left join "Classificacao"    c1 on c1.id = p."classificacaoNivel1Id"
       left join "Classificacao"    c2 on c2.id = p."classificacaoNivel2Id"
       left join "RegulatoryRecord" r  on r.cnp = p.cnp
      where p.cnp >= $1`,
    [MIN_CNP],
  );

  const porTipo = new Map<string, { total: number; com: number }>();
  const porUtilizacao = new Map<string, number>();
  const recusadasPorRegra = new Map<string, number>();
  let escritas = 0;
  /** Já existiam iguais, mais fortes, ou são MANUAL — o UPSERT não mexeu. */
  let naoAlteradas = 0;
  let recusadas = 0;
  let produtosCom = 0;

  for (const p of produtos) {
    const tipo = p.productType ?? "(por classificar)";
    const t = porTipo.get(tipo) ?? { total: 0, com: 0 };
    t.total++;

    const candidatas = avaliar(p);
    const aceites = candidatas.filter((c) => c.confianca >= MIN_CONFIANCA);
    for (const r of candidatas.filter((c) => c.confianca < MIN_CONFIANCA)) {
      recusadas++;
      recusadasPorRegra.set(r.regra, (recusadasPorRegra.get(r.regra) ?? 0) + 1);
    }

    if (aceites.length) {
      t.com++;
      produtosCom++;
    }
    porTipo.set(tipo, t);

    for (const c of aceites) {
      const uid = idPorSlug.get(c.utilizacao);
      if (!uid) {
        console.error(`Regra aponta para utilização inexistente: ${c.utilizacao}`);
        process.exit(1);
      }
      porUtilizacao.set(c.utilizacao, (porUtilizacao.get(c.utilizacao) ?? 0) + 1);
      if (dryRun) continue;

      // Manual nunca é tocada. Automática só cede a confiança superior.
      const res = await db.query(
        `insert into "ProdutoUtilizacao" ("produtoId", "utilizacaoId", fonte, confianca)
         values ($1, $2, $3, $4)
         on conflict ("produtoId", "utilizacaoId") do update
            set fonte     = excluded.fonte,
                confianca = excluded.confianca
          where "ProdutoUtilizacao".fonte <> 'MANUAL'
            and excluded.confianca > coalesce("ProdutoUtilizacao".confianca, 0)
         returning 1 as escrito`,
        [p.id, uid, FONTE, c.confianca],
      );
      if (res.rowCount) escritas++;
      else naoAlteradas++;
    }
  }

  const estado = dryRun
    ? { total: "—", manuais: "—" }
    : (
        await db.query<{ total: string; manuais: string }>(
          `select count(*)::text as total,
                  count(*) filter (where fonte = 'MANUAL')::text as manuais
             from "ProdutoUtilizacao"`,
        )
      ).rows[0]!;

  // ── Relatório ──────────────────────────────────────────────────────
  const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : "—");
  const totalAssociacoes = [...porUtilizacao.values()].reduce((s, n) => s + n, 0);

  console.log("── Cobertura ──────────────────────────────────────────────");
  console.log(`  produtos (CNP >= ${MIN_CNP.toLocaleString("pt-PT")})   ${produtos.length}`);
  console.log(`  com >= 1 utilização                    ${produtosCom}  (${pct(produtosCom, produtos.length)})`);
  console.log(`  associações                            ${totalAssociacoes}`);
  console.log(`  média por produto classificado         ${produtosCom ? (totalAssociacoes / produtosCom).toFixed(2) : "—"}`);
  console.log(`  média sobre o catálogo                 ${(totalAssociacoes / produtos.length).toFixed(2)}`);

  console.log("\n── Cobertura por productType ──────────────────────────────");
  const tipos = [...porTipo.entries()].sort((a, b) => b[1].total - a[1].total);
  for (const [tipo, v] of tipos) {
    console.log(`  ${tipo.padEnd(22)} ${String(v.com).padStart(6)} / ${String(v.total).padStart(6)}   ${pct(v.com, v.total).padStart(6)}`);
  }

  console.log("\n── TOP utilizações ────────────────────────────────────────");
  const top = [...porUtilizacao.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  for (const [slug, n] of top) {
    const u = UTILIZACOES_POR_SLUG.get(slug);
    console.log(`  ${String(n).padStart(6)}  ${(u?.nome ?? slug).padEnd(30)} ${u?.grupo ?? ""}`);
  }

  console.log("\n── Recusadas por confiança baixa ──────────────────────────");
  if (!recusadas) {
    console.log("  nenhuma");
  } else {
    console.log(`  total ${recusadas} associações não escritas (< ${MIN_CONFIANCA})`);
    for (const [regra, n] of [...recusadasPorRegra.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(6)}  ${regra}`);
    }
  }

  if (!dryRun) {
    console.log("\n── Escrita ────────────────────────────────────────────────");
    console.log(`  escritas ou actualizadas               ${escritas}`);
    console.log(`  inalteradas (iguais, mais fortes ou manuais)  ${naoAlteradas}`);
    console.log(`  total na base                          ${estado.total}`);
    console.log(`  das quais MANUAL (nunca tocadas)       ${estado.manuais}`);
  }

  await db.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
