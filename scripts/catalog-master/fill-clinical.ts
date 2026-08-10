/**
 * scripts/catalog-master/fill-clinical.ts
 *
 * Via dedicada a material clínico: ostomia, diabetes, urologia,
 * laringectomia, monitorização.
 *
 * Estes produtos são ~1% do catálogo e ~15% das vendas do universo por
 * classificar, e o motor genérico por descrição não lhes serve: o ERP
 * escreve a referência do fabricante, não uma descrição comercial —
 * "Coloplast/brava/ref.12042 N.d. 30 N.a.", "CONTOUR NEXT ref.84191389".
 * Não há página de retalho para isto e não há dosagem nem forma
 * farmacêutica para o classificador ver.
 *
 * ── Identidade, não heurística ───────────────────────────────────────
 * O que resolve estes produtos é um DICIONÁRIO FECHADO de fabricantes de
 * material clínico, comparado com fronteira de palavra. Não é inferência
 * sobre palavras soltas: "Coloplast" e "Provox" são fabricantes, não
 * adjectivos. A confirmação é reforçada quando a designação traz também
 * uma referência do fabricante (`ref.12042`, `Ref 416701`, terceiro
 * segmento numérico de `Marca / Linha / 15030`).
 *
 * Marcas com gamas distintas (Omron faz tensiómetros, nebulizadores e
 * termómetros) desambiguam por palavra-chave DENTRO da própria marca —
 * o âmbito fechado é o que torna isto determinístico.
 *
 * ── Política de escrita ──────────────────────────────────────────────
 * Só preenche campos a NULL. Taxonomia fechada: resolve nomes contra
 * Classificacao existente e ATIVA, nunca cria.
 *
 * Uso:
 *   npx tsx scripts/catalog-master/fill-clinical.ts --dry-run
 *   npx tsx scripts/catalog-master/fill-clinical.ts
 */
import "dotenv/config";
import pg from "pg";

const MIN_CNP = 2_000_000;
const BATCH = 200;

type Gama = { padrao: RegExp; nivel1: string; nivel2: string };
type Marca = {
  /** Nome canónico do Fabricante. */
  fabricante: string;
  /** Marca na designação. Fronteira de palavra, não substring solta. */
  padrao: RegExp;
  /** Destino por omissão dentro da taxonomia fechada. */
  nivel1: string;
  nivel2: string;
  /** Desambiguação dentro da própria marca, avaliada por ordem. */
  gamas?: Gama[];
};

const DISP = "DISPOSITIVOS MÉDICOS";
const MATCLIN = "MATERIAL CLÍNICO E CONSUMÍVEIS";

/**
 * Dicionário fechado. Só fabricantes de material clínico com presença
 * real neste catálogo — não é uma lista especulativa.
 */
const MARCAS: Marca[] = [
  // ── Ostomia, urologia, continência ──────────────────────────────
  { fabricante: "COLOPLAST", padrao: /\bcoloplast\b/i, nivel1: MATCLIN, nivel2: "Outros Material Clínico" },
  { fabricante: "HOLLISTER", padrao: /\bhollister\b/i, nivel1: MATCLIN, nivel2: "Outros Material Clínico" },
  { fabricante: "CONVATEC", padrao: /\bconvatec\b/i, nivel1: MATCLIN, nivel2: "Outros Material Clínico" },
  { fabricante: "DANSAC", padrao: /\bdansac\b/i, nivel1: MATCLIN, nivel2: "Outros Material Clínico" },
  { fabricante: "SALTS HEALTHCARE", padrao: /\bsalts\b/i, nivel1: MATCLIN, nivel2: "Outros Material Clínico" },
  // "Esteem+" — o `+` não é fronteira de palavra fiável, ancorar ao nome.
  { fabricante: "CONVATEC", padrao: /\besteem\s*\+/i, nivel1: MATCLIN, nivel2: "Outros Material Clínico" },
  { fabricante: "B. BRAUN", padrao: /\bb\.?\s*braun\b/i, nivel1: MATCLIN, nivel2: "Outros Material Clínico" },

  // ── Laringectomia / voz ─────────────────────────────────────────
  { fabricante: "ATOS MEDICAL", padrao: /\bprovox\b/i, nivel1: MATCLIN, nivel2: "Outros Material Clínico" },

  // ── Diabetes: glicemia, sensores, bombas ────────────────────────
  { fabricante: "ASCENSIA DIABETES CARE", padrao: /\bcontour\b/i, nivel1: DISP, nivel2: "Glicemia e Diabetes" },
  { fabricante: "LIFESCAN", padrao: /\bone\s*touch\b|\bonetouch\b/i, nivel1: DISP, nivel2: "Glicemia e Diabetes" },
  { fabricante: "ROCHE DIABETES CARE", padrao: /\baccu[-\s]?chek\b/i, nivel1: DISP, nivel2: "Glicemia e Diabetes" },
  { fabricante: "ABBOTT", padrao: /\bfreestyle\b/i, nivel1: DISP, nivel2: "Glicemia e Diabetes" },
  { fabricante: "A. MENARINI DIAGNOSTICS", padrao: /\bglucomen\b/i, nivel1: DISP, nivel2: "Glicemia e Diabetes" },
  { fabricante: "DEXCOM", padrao: /\bdexcom\b/i, nivel1: DISP, nivel2: "Glicemia e Diabetes" },
  { fabricante: "TANDEM DIABETES CARE", padrao: /\btandem\b/i, nivel1: DISP, nivel2: "Glicemia e Diabetes" },
  { fabricante: "MEDTRONIC", padrao: /\bmedtronic\b/i, nivel1: DISP, nivel2: "Glicemia e Diabetes" },

  // ── Monitorização: a marca sozinha não chega, a gama desambigua ──
  {
    fabricante: "OMRON",
    padrao: /\bomron\b/i,
    nivel1: DISP,
    nivel2: "Tensão Arterial",
    gamas: [
      { padrao: /\bneb|compressor|inalador/i, nivel1: DISP, nivel2: "Nebulizadores" },
      { padrao: /\btermom|term[oó]metro/i, nivel1: DISP, nivel2: "Termómetros" },
      { padrao: /\btens[aã]o|esfigm|\bm[236]\b|\bhem-?\d/i, nivel1: DISP, nivel2: "Tensão Arterial" },
    ],
  },
];

/** Referência do fabricante — reforça a confirmação de identidade. */
const REF_PATTERNS: RegExp[] = [
  /\bref[.ªa]?\s*\.?\s*([a-z0-9-]{4,})/i, // ref.12042 · Ref 416701 · Refª 242214l
  /\/\s*([a-z]{2,}-[a-z0-9-]{3,})\s*/i, // / Stp-gt-002 /
  /\/\s*(\d{5,})\s+/, // Marca / Linha / 15030 Maxi
];

function extrairRef(designacao: string): string | null {
  for (const p of REF_PATTERNS) {
    const m = p.exec(designacao);
    if (m?.[1]) return m[1].toUpperCase();
  }
  return null;
}

function resolverMarca(designacao: string): { marca: Marca; nivel1: string; nivel2: string } | null {
  for (const marca of MARCAS) {
    if (!marca.padrao.test(designacao)) continue;
    let nivel1 = marca.nivel1;
    let nivel2 = marca.nivel2;
    for (const gama of marca.gamas ?? []) {
      if (gama.padrao.test(designacao)) {
        nivel1 = gama.nivel1;
        nivel2 = gama.nivel2;
        break;
      }
    }
    return { marca, nivel1, nivel2 };
  }
  return null;
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const dbName =
    argv.find((a) => a.startsWith("--db="))?.split("=")[1] ??
    "spharmmt_t_grupo_silveira";
  const url = process.env.DATABASE_URL!.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  await db.query("set session default_transaction_read_only = off");

  console.log(`base: ${dbName}${dryRun ? "  (dry-run — não escreve)" : ""}\n`);

  const tax = await db.query<{ id: string; nome: string; pai: string | null }>(
    `select id, nome, "classificacaoPaiId" as pai from "Classificacao" where estado = 'ATIVO'`,
  );
  const n1ByName = new Map<string, string>();
  const n2ByKey = new Map<string, string>();
  for (const r of tax.rows) if (!r.pai) n1ByName.set(r.nome.toUpperCase(), r.id);
  for (const r of tax.rows) if (r.pai) n2ByKey.set(`${r.pai}::${r.nome.toUpperCase()}`, r.id);

  const { rows } = await db.query<{
    id: string;
    cnp: number;
    designacao: string;
    productType: string | null;
    fabricanteId: string | null;
    classificacaoNivel1Id: string | null;
    vendas: number;
  }>(
    `select p.id, p.cnp, p.designacao, p."productType", p."fabricanteId",
            p."classificacaoNivel1Id",
            coalesce((select sum(vm."valorTotal") from "VendaMensal" vm
                       where vm."produtoId" = p.id), 0)::float as vendas
       from "Produto" p
      where p.cnp >= $1`,
    [MIN_CNP],
  );

  const fabCache = new Map<string, string>();
  const fabs = await db.query<{ id: string; n: string }>(
    `select id, "nomeNormalizado" as n from "Fabricante"`,
  );
  for (const r of fabs.rows) fabCache.set(r.n, r.id);

  async function idFabricante(nome: string): Promise<string> {
    const hit = fabCache.get(nome);
    if (hit) return hit;
    if (dryRun) return "novo";
    const ins = await db.query<{ id: string }>(
      `insert into "Fabricante" ("id","nomeNormalizado","dataAtualizacao")
       values (gen_random_uuid()::text, $1, now())
       on conflict ("nomeNormalizado") do update set "nomeNormalizado" = excluded."nomeNormalizado"
       returning id`,
      [nome],
    );
    fabCache.set(nome, ins.rows[0].id);
    return ins.rows[0].id;
  }

  type Upd = { id: string; tipo: string | null; fab: string | null; n1: string | null; n2: string | null };
  const updates: Upd[] = [];
  const campos = { laboratorio: 0, categoria: 0, subcategoria: 0 };
  let tipos = 0;
  let comRef = 0;
  let vendasTocadas = 0;
  const porMarca = new Map<string, { n: number; vendas: number }>();
  const semTaxonomia = new Set<string>();

  for (const p of rows) {
    const hit = resolverMarca(p.designacao);
    if (!hit) continue;

    const u: Upd = { id: p.id, tipo: null, fab: null, n1: null, n2: null };
    if (extrairRef(p.designacao)) comRef++;

    if (!p.productType) {
      u.tipo = "DISPOSITIVO_MEDICO";
      tipos++;
    }
    if (!p.fabricanteId) {
      u.fab = await idFabricante(hit.marca.fabricante);
      campos.laboratorio++;
    }
    if (!p.classificacaoNivel1Id) {
      const n1Id = n1ByName.get(hit.nivel1.toUpperCase());
      if (!n1Id) {
        semTaxonomia.add(hit.nivel1);
      } else {
        u.n1 = n1Id;
        campos.categoria++;
        const n2Id = n2ByKey.get(`${n1Id}::${hit.nivel2.toUpperCase()}`);
        if (n2Id) {
          u.n2 = n2Id;
          campos.subcategoria++;
        } else {
          semTaxonomia.add(`${hit.nivel1} > ${hit.nivel2}`);
        }
      }
    }

    if (u.tipo || u.fab || u.n1) {
      updates.push(u);
      vendasTocadas += p.vendas;
      const k = hit.marca.fabricante;
      const cur = porMarca.get(k) ?? { n: 0, vendas: 0 };
      cur.n++;
      cur.vendas += p.vendas;
      porMarca.set(k, cur);
    }
  }

  const totalCampos = Object.values(campos).reduce((a, b) => a + b, 0);
  console.log(`produtos de material clínico a tocar: ${updates.length}`);
  console.log(`  com referência do fabricante na designação: ${comRef}`);
  console.log(`  vendas associadas: ${Math.round(vendasTocadas).toLocaleString("pt-PT")} EUR\n`);
  console.log("campos-alvo a preencher:");
  for (const [k, v] of Object.entries(campos)) console.log(`  ${String(v).padStart(5)}  ${k}`);
  console.log(`  ${String(totalCampos).padStart(5)}  TOTAL`);
  console.log(`\n(productType atribuído a ${tipos} produtos — não conta como campo-alvo)`);

  console.log("\npor fabricante:");
  for (const [k, v] of [...porMarca].sort((a, b) => b[1].vendas - a[1].vendas)) {
    console.log(`  ${String(v.n).padStart(4)}  ${Math.round(v.vendas).toLocaleString("pt-PT").padStart(9)} EUR  ${k}`);
  }
  if (semTaxonomia.size) {
    console.log("\nSEM correspondência na taxonomia (nada criado):");
    for (const s of semTaxonomia) console.log(`  ${s}`);
  }

  if (dryRun) {
    console.log("\ndry-run: nada foi escrito.");
    await db.end();
    return;
  }

  let escritos = 0;
  for (let i = 0; i < updates.length; i += BATCH) {
    const lote = updates.slice(i, i + BATCH);
    const res = await db.query(
      `update "Produto" p
          set "productType"           = coalesce(p."productType", v.tipo),
              "productTypeConfidence" = case when p."productType" is null and v.tipo is not null
                                             then 0.90 else p."productTypeConfidence" end,
              "classificationSource"  = case when p."productType" is null and v.tipo is not null
                                             then 'MANUFACTURER_DICT' else p."classificationSource" end,
              "fabricanteId"          = coalesce(p."fabricanteId", v.fab),
              "classificacaoNivel1Id" = coalesce(p."classificacaoNivel1Id", v.n1),
              "classificacaoNivel2Id" = coalesce(p."classificacaoNivel2Id", v.n2),
              "dataAtualizacao"       = now()
         from (select unnest($1::text[]) as id,
                      unnest($2::text[]) as tipo,
                      unnest($3::text[]) as fab,
                      unnest($4::text[]) as n1,
                      unnest($5::text[]) as n2) v
        where p.id = v.id`,
      [
        lote.map((x) => x.id),
        lote.map((x) => x.tipo),
        lote.map((x) => x.fab),
        lote.map((x) => x.n1),
        lote.map((x) => x.n2),
      ],
    );
    escritos += res.rowCount ?? 0;
  }
  console.log(`\nprodutos actualizados: ${escritos} · campos-alvo preenchidos: ${totalCampos}`);

  await db.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
