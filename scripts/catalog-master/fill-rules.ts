/**
 * scripts/catalog-master/fill-rules.ts
 *
 * Preenche campos operacionais a partir do que já está DENTRO da base.
 * Não vai à Internet. Determinístico, idempotente, sobre o catálogo todo.
 *
 * Duas fontes, ambas locais:
 *
 *  1. Categoria / Subcategoria — lib/catalog-taxonomy-map.mapToCanonical(),
 *     alimentado pelo productType agora conhecido, pela designação, pelo ATC
 *     e pela DCI. O mapper é fechado à taxonomia canónica e devolve null
 *     quando não há sinal suficiente.
 *
 *     A taxonomia é FECHADA: este script só resolve nomes contra linhas
 *     Classificacao já existentes e ATIVAS. Nunca cria uma categoria. Se o
 *     mapper devolver um nome que não existe na base, o produto fica por
 *     classificar e o nome vai para o relatório de revisão — criar a
 *     categoria em silêncio faria a taxonomia crescer sozinha, que é
 *     exactamente o que não se quer.
 *
 *  2. Laboratório — RegulatoryRecord.titularAim (titular da AIM). É fonte
 *     regulamentar, tier REGULATORY, ligada por CNP. Fabricante não é
 *     taxonomia fechada: nomes novos são criados, com alias quando o nome
 *     original difere do normalizado.
 *
 * DCI e ATC também vêm do RegulatoryRecord pelo mesmo join.
 *
 * ── Política de escrita ──────────────────────────────────────────────
 * Só preenche campos a NULL. Nunca sobrepõe. Uma segunda corrida não
 * desfaz nem repete nada.
 *
 * `validadoManualmente = true` é excluído já no SELECT. O `coalesce` da
 * escrita bastaria para não sobrepor o que o admin preencheu, mas não
 * para o que ele deixou VAZIO de propósito — e "vazio de propósito"
 * também é uma decisão dele. Fora do SELECT, o produto nunca chega a ser
 * considerado.
 *
 * Uso:
 *   npx tsx scripts/catalog-master/fill-rules.ts --db=spharmmt_t_silveira --dry-run
 *   npx tsx scripts/catalog-master/fill-rules.ts --db=spharmmt_t_silveira
 */
import "dotenv/config";
import pg from "pg";
import { mapToCanonical } from "../../lib/catalog-taxonomy-map";
import type { ProductType } from "../../lib/catalog-types";

const MIN_CNP = 2_000_000;
const BATCH = 400;

/** Normalização de nome de fabricante — igual à do catalog-builder. */
function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9 &.\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type Produto = {
  id: string;
  cnp: number;
  designacao: string;
  productType: string | null;
  productTypeConfidence: number | null;
  classificacaoNivel1Id: string | null;
  classificacaoNivel2Id: string | null;
  fabricanteId: string | null;
  dci: string | null;
  codigoATC: string | null;
  regDci: string | null;
  regAtc: string | null;
  regTitular: string | null;
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

  const url = process.env.DATABASE_URL!.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  // Ver nota no catalog-builder: o pooler do Neon não repõe parâmetros de
  // sessão entre clientes.
  await db.query("set session default_transaction_read_only = off");

  console.log(`base: ${dbName}${dryRun ? "  (dry-run — não escreve)" : ""}\n`);

  // ── Taxonomia existente: nome → id. Só ATIVO. Nunca criada. ──────────
  const tax = await db.query<{ id: string; nome: string; pai: string | null }>(
    `select id, nome, "classificacaoPaiId" as pai from "Classificacao" where estado = 'ATIVO'`,
  );
  const n1ByName = new Map<string, string>();
  const n2ByKey = new Map<string, string>();
  for (const r of tax.rows) if (!r.pai) n1ByName.set(r.nome.toUpperCase(), r.id);
  for (const r of tax.rows) if (r.pai) n2ByKey.set(`${r.pai}::${r.nome.toUpperCase()}`, r.id);
  console.log(`taxonomia: ${n1ByName.size} nível 1, ${n2ByKey.size} nível 2 (fechada)\n`);

  const { rows } = await db.query<Produto>(
    `select p.id, p.cnp, p.designacao, p."productType", p."productTypeConfidence",
            p."classificacaoNivel1Id", p."classificacaoNivel2Id", p."fabricanteId",
            p.dci, p."codigoATC",
            r.dci as "regDci", r."codigoATC" as "regAtc", r."titularAim" as "regTitular"
       from "Produto" p
       left join "RegulatoryRecord" r on r.cnp = p.cnp
      where p.cnp >= $1
        and p."validadoManualmente" = false
        and (p."classificacaoNivel1Id" is null or p."fabricanteId" is null
             or p.dci is null or p."codigoATC" is null)`,
    [MIN_CNP],
  );
  console.log(`produtos com pelo menos um campo em falta: ${rows.length}`);

  // ── Fabricantes: cache nome normalizado → id ─────────────────────────
  const fabCache = new Map<string, string>();
  const fabExistentes = await db.query<{ id: string; n: string }>(
    `select f.id, f."nomeNormalizado" as n from "Fabricante" f
     union all select a."fabricanteId" as id, upper(a."aliasNome") as n from "FabricanteAlias" a`,
  );
  for (const r of fabExistentes.rows) if (!fabCache.has(r.n)) fabCache.set(r.n, r.id);
  console.log(`fabricantes conhecidos: ${fabCache.size}\n`);

  // ── Marca → laboratório, aprendido do próprio catálogo ───────────────
  //
  // Num catálogo de farmácia a marca no início da designação é, na
  // prática, o laboratório: "Bioderma Atoderm ...", "GUM Junior ...".
  // Em vez de adivinhar, aprende-se o mapeamento a partir dos produtos
  // que JÁ têm fabricante atribuído por fonte fiável, e propaga-se aos
  // restantes da mesma marca. Não inventa nada: só alarga informação já
  // verificada a produtos irmãos.
  //
  // Só marcas com consenso forte — ≥90% dos produtos da marca a apontar
  // para o mesmo fabricante e pelo menos 2 produtos. Marcas ambíguas
  // (revendedores, marcas brancas com vários titulares) ficam de fora.
  function marcaDe(designacao: string): string {
    const p = designacao
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      // "CH.71606000040 TET FISIOL" — prefixo de código do fornecedor.
      .replace(/^ch\.\d+\s*/, "")
      .split(/[\s\-/,;:.()[\]]+/)
      .filter(Boolean);
    if (!p[0]) return "";
    // Marcas de duas letras só identificam com a palavra seguinte
    // ("b braun", "a derma", "th pharma").
    return p[0].length <= 2 && p[1] ? `${p[0]} ${p[1]}` : p[0];
  }

  // Aprender sobre o catálogo INTEIRO, não só sobre `rows`: `rows` só traz
  // produtos com algum campo em falta, e os produtos já completos são
  // precisamente a melhor evidência de que marca pertence a que laboratório.
  const comFab = await db.query<{ designacao: string; fabricanteId: string }>(
    `select p.designacao, p."fabricanteId"
       from "Produto" p
      where p.cnp >= $1 and p."fabricanteId" is not null`,
    [MIN_CNP],
  );
  const votos = new Map<string, Map<string, number>>();
  for (const p of comFab.rows) {
    const m = marcaDe(p.designacao);
    if (m.length < 3) continue;
    if (!votos.has(m)) votos.set(m, new Map());
    const v = votos.get(m)!;
    v.set(p.fabricanteId, (v.get(p.fabricanteId) ?? 0) + 1);
  }
  const marcaParaFab = new Map<string, string>();
  let marcasAmbiguas = 0;
  for (const [m, v] of votos) {
    const ord = [...v].sort((a, b) => b[1] - a[1]);
    const total = ord.reduce((s, x) => s + x[1], 0);
    if (ord[0][1] / total >= 0.9 && ord[0][1] >= 2) marcaParaFab.set(m, ord[0][0]);
    else marcasAmbiguas++;
  }
  console.log(
    `marcas com laboratório consensual: ${marcaParaFab.size} ` +
      `(${marcasAmbiguas} ambíguas descartadas)\n`,
  );

  async function resolverFabricante(nome: string): Promise<string | null> {
    const n = norm(nome);
    if (n.length < 2 || n.length > 60) return null;
    const hit = fabCache.get(n);
    if (hit) return hit;
    if (dryRun) return "novo";
    const ins = await db.query<{ id: string }>(
      `insert into "Fabricante" ("id","nomeNormalizado","dataAtualizacao")
       values (gen_random_uuid()::text, $1, now())
       on conflict ("nomeNormalizado") do update set "nomeNormalizado" = excluded."nomeNormalizado"
       returning id`,
      [n],
    );
    const id = ins.rows[0].id;
    fabCache.set(n, id);
    if (norm(nome) !== nome.toUpperCase()) {
      await db.query(
        `insert into "FabricanteAlias" ("id","fabricanteId","aliasNome")
         values (gen_random_uuid()::text, $1, $2)
         on conflict ("fabricanteId","aliasNome") do nothing`,
        [id, nome],
      );
    }
    return id;
  }

  // ── Decidir o que escrever ───────────────────────────────────────────
  type Update = {
    id: string;
    n1: string | null;
    n2: string | null;
    fab: string | null;
    dci: string | null;
    atc: string | null;
  };
  const updates: Update[] = [];
  const campos = { categoria: 0, subcategoria: 0, laboratorio: 0, dci: 0, atc: 0 };
  const porRever = new Map<string, number>();
  // Onde é que a categoria vai efectivamente parar, e por que método. Sem
  // isto, "10 298 subcategorias preenchidas" pode ser quase tudo
  // "Outros <X>" — cobertura no número e nada de útil no ecrã.
  const porDestino = new Map<string, number>();
  const porMetodo = new Map<string, number>();
  let semTipo = 0;
  let mapperNull = 0;
  let labPorRegulamentar = 0;
  let labPorMarca = 0;

  for (const p of rows) {
    const u: Update = { id: p.id, n1: null, n2: null, fab: null, dci: null, atc: null };

    // Categoria / subcategoria
    if (!p.classificacaoNivel1Id) {
      if (!p.productType) {
        semTipo++;
      } else {
        const canon = mapToCanonical({
          productType: p.productType as ProductType,
          productTypeConfidence: p.productTypeConfidence ?? 0.5,
          externalCategory: null,
          externalSubcategory: null,
          designacao: p.designacao,
          atc: p.codigoATC ?? p.regAtc,
          dci: p.dci ?? p.regDci,
        });
        if (!canon) {
          mapperNull++;
        } else {
          const n1Id = n1ByName.get(canon.nivel1.toUpperCase());
          if (!n1Id) {
            // Taxonomia fechada: não cria. Regista para revisão.
            const k = `nível1 inexistente: ${canon.nivel1}`;
            porRever.set(k, (porRever.get(k) ?? 0) + 1);
          } else {
            u.n1 = n1Id;
            campos.categoria++;
            porDestino.set(
              `${canon.nivel1} > ${canon.nivel2}`,
              (porDestino.get(`${canon.nivel1} > ${canon.nivel2}`) ?? 0) + 1,
            );
            porMetodo.set(canon.method, (porMetodo.get(canon.method) ?? 0) + 1);
            const n2Id = n2ByKey.get(`${n1Id}::${canon.nivel2.toUpperCase()}`);
            if (n2Id) {
              u.n2 = n2Id;
              campos.subcategoria++;
            } else {
              const k = `nível2 inexistente: ${canon.nivel1} > ${canon.nivel2}`;
              porRever.set(k, (porRever.get(k) ?? 0) + 1);
            }
          }
        }
      }
    }

    // Laboratório: primeiro a fonte regulamentar (titular da AIM), que é
    // mais autoritária; só se não houver, a propagação por marca.
    if (!p.fabricanteId && p.regTitular) {
      const fid = await resolverFabricante(p.regTitular);
      if (fid) {
        u.fab = fid;
        campos.laboratorio++;
        labPorRegulamentar++;
      }
    } else if (!p.fabricanteId) {
      const fid = marcaParaFab.get(marcaDe(p.designacao));
      if (fid) {
        u.fab = fid;
        campos.laboratorio++;
        labPorMarca++;
      }
    }
    if (!p.dci && p.regDci) {
      u.dci = p.regDci;
      campos.dci++;
    }
    if (!p.codigoATC && p.regAtc) {
      u.atc = p.regAtc;
      campos.atc++;
    }

    if (u.n1 || u.fab || u.dci || u.atc) updates.push(u);
  }

  const total = Object.values(campos).reduce((a, b) => a + b, 0);
  console.log("campos a preencher:");
  for (const [k, v] of Object.entries(campos)) console.log(`  ${String(v).padStart(6)}  ${k}`);
  console.log(`  ${String(total).padStart(6)}  TOTAL\n`);
  console.log(`  laboratório: ${labPorRegulamentar} por titular da AIM, ${labPorMarca} por marca consensual`);
  console.log(`produtos ainda sem productType (mapper não corre): ${semTipo}`);
  console.log(`mapper devolveu null (sinal insuficiente): ${mapperNull}`);

  if (porMetodo.size) {
    console.log("\nmétodo do mapper:");
    for (const [k, v] of [...porMetodo].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(v).padStart(6)}  ${k}`);
    }
    console.log("\ndestino (top 20):");
    for (const [k, v] of [...porDestino].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
      console.log(`  ${String(v).padStart(6)}  ${k}`);
    }
  }

  if (porRever.size) {
    console.log("\npor rever (taxonomia fechada — NADA foi criado):");
    for (const [k, v] of [...porRever].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(v).padStart(6)}  ${k}`);
    }
  }

  if (dryRun) {
    console.log("\ndry-run: nada foi escrito.");
    await db.end();
    return;
  }

  // ── Escrita ──────────────────────────────────────────────────────────
  // As guardas `is null` no WHERE tornam a escrita idempotente e garantem
  // que nunca se sobrepõe um valor já existente, mesmo que outra corrida
  // (o builder, por exemplo) tenha preenchido o campo entretanto.
  let escritos = 0;
  for (let i = 0; i < updates.length; i += BATCH) {
    const lote = updates.slice(i, i + BATCH);
    const res = await db.query(
      `update "Produto" p
          set "classificacaoNivel1Id" = coalesce(p."classificacaoNivel1Id", v.n1),
              "classificacaoNivel2Id" = coalesce(p."classificacaoNivel2Id", v.n2),
              "fabricanteId"          = coalesce(p."fabricanteId", v.fab),
              dci                     = coalesce(p.dci, v.dci),
              "codigoATC"             = coalesce(p."codigoATC", v.atc),
              "dataAtualizacao"       = now()
         from (select unnest($1::text[]) as id,
                      unnest($2::text[]) as n1,
                      unnest($3::text[]) as n2,
                      unnest($4::text[]) as fab,
                      unnest($5::text[]) as dci,
                      unnest($6::text[]) as atc) v
        where p.id = v.id`,
      [
        lote.map((x) => x.id),
        lote.map((x) => x.n1),
        lote.map((x) => x.n2),
        lote.map((x) => x.fab),
        lote.map((x) => x.dci),
        lote.map((x) => x.atc),
      ],
    );
    escritos += res.rowCount ?? 0;
    process.stdout.write(`\r  produtos actualizados ${escritos}/${updates.length}`);
  }
  console.log(`\n\nprodutos actualizados: ${escritos} · campos preenchidos: ${total}`);

  await db.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
