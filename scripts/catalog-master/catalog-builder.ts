/**
 * scripts/catalog-master/catalog-builder.ts
 *
 * Construtor de catálogo. DOIS motores, porque são dois problemas:
 *
 *   Motor A — produtos comerciais (dermocosmética, suplementos, OTC, ...)
 *     Pesquisa em farmácias online portuguesas, confirma identidade pelo
 *     CNP na PÁGINA DO PRODUTO, extrai categoria, laboratório e imagem.
 *
 *   Motor B — medicamentos
 *     INFOMED (INFARMED). A web comercial não serve: medicamentos sujeitos
 *     a receita não se vendem online e não têm ficha em retalho. Medido:
 *     1 em 6 encontrado, e o único era parafarmácia.
 *
 * ── Confirmação de identidade ───────────────────────────────────────
 * Uma página de PESQUISA devolve 404/410 e mesmo assim contém o CNP,
 * porque ele vem no URL e é ecoado. Confirmar por "o CNP aparece na
 * página" daria falsos positivos em massa. Só conta o CNP encontrado na
 * página do PRODUTO, e o URL da pesquisa é sempre descartado.
 *
 * ── Política de escrita ─────────────────────────────────────────────
 * Só preenche campos a NULL. Nunca sobrepõe valor existente — é a forma
 * mais simples de garantir que dados de maior confiança (regulamentares)
 * nunca são substituídos por dados de menor confiança (comerciais).
 *
 * Retomável: checkpoint em JSONL. Cache de rede em JSONL. Interromper e
 * recomeçar salta o que já foi feito e não repete pedidos.
 *
 * Uso:
 *   npx tsx scripts/catalog-master/catalog-builder.ts --limit=500
 *   npx tsx scripts/catalog-master/catalog-builder.ts --limit=500 --dry-run
 *   npx tsx scripts/catalog-master/catalog-builder.ts --engine=A --limit=200
 */
import "dotenv/config";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

const MIN_CNP = 2_000_000;
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const OUT_DIR = path.join(process.cwd(), ".catalog-builder");
const CACHE_FILE = path.join(OUT_DIR, "cache.jsonl");
const CKPT_FILE = path.join(OUT_DIR, "checkpoint.jsonl");

type Args = {
  limit: number;
  engine: "A" | "B" | "both";
  dryRun: boolean;
  concurrency: number;
  tenantDb: string;
};

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (k: string) => a.find((x) => x.startsWith(`--${k}=`))?.split("=")[1];
  return {
    limit: parseInt(get("limit") ?? "500", 10),
    engine: (get("engine") as Args["engine"]) ?? "both",
    dryRun: a.includes("--dry-run"),
    concurrency: parseInt(get("concurrency") ?? "6", 10),
    tenantDb: get("db") ?? "spharmmt_t_grupo_silveira",
  };
}

// ── Cache e checkpoint ───────────────────────────────────────────────

const cache = new Map<string, unknown>();
const done = new Set<number>();

function loadState(): void {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const [file, sink] of [
    [CACHE_FILE, (o: any) => cache.set(o.k, o.v)],
    [CKPT_FILE, (o: any) => done.add(o.cnp)],
  ] as const) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { sink(JSON.parse(line)); } catch { /* linha truncada por interrupção */ }
    }
  }
}
const appendJson = (f: string, o: unknown) => fs.appendFileSync(f, JSON.stringify(o) + "\n");

// ── Rede, com cortesia por domínio ───────────────────────────────────

const lastHit = new Map<string, number>();
const MIN_GAP_MS = 1200;

async function polite(url: string): Promise<void> {
  const host = new URL(url).hostname;
  const wait = (lastHit.get(host) ?? 0) + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastHit.set(host, Date.now());
}

async function fetchCached(url: string, timeoutMs = 25000): Promise<string> {
  const key = `GET ${url}`;
  if (cache.has(key)) return cache.get(key) as string;
  await polite(url);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let html = "";
  try {
    const r = await fetch(url, {
      headers: { "user-agent": UA, "accept-language": "pt-PT,pt;q=0.9" },
      signal: ctrl.signal,
      redirect: "follow",
    });
    html = r.ok ? await r.text() : "";
  } catch { html = ""; } finally { clearTimeout(t); }
  cache.set(key, html);
  appendJson(CACHE_FILE, { k: key, v: html.slice(0, 400_000) });
  return html;
}

// ── Extracção ────────────────────────────────────────────────────────

function jsonLdObjects(html: string): any[] {
  const out: any[] = [];
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const j = JSON.parse(m[1].trim());
      out.push(...(Array.isArray(j) ? j : [j]));
    } catch { /* JSON-LD inválido é comum; ignorar */ }
  }
  return out;
}

function findProductNode(objs: any[]): any | null {
  const walk = (o: any): any => {
    if (!o || typeof o !== "object") return null;
    const t = o["@type"];
    if (t === "Product" || (Array.isArray(t) && t.includes("Product"))) return o;
    for (const v of Object.values(o)) {
      const r = Array.isArray(v) ? v.map(walk).find(Boolean) : walk(v);
      if (r) return r;
    }
    return null;
  };
  for (const o of objs) { const r = walk(o); if (r) return r; }
  return null;
}

const meta = (html: string, prop: string): string | null =>
  html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)`, "i"))?.[1] ?? null;

type Extracted = {
  categoria: string | null;
  subcategoria: string | null;
  laboratorio: string | null;
  imagemUrl: string | null;
  nome: string | null;
  fonte: string;
};

function extractCommercial(html: string, url: string): Extracted {
  const prod = findProductNode(jsonLdObjects(html));
  const brand = prod ? (typeof prod.brand === "object" ? prod.brand?.name : prod.brand) : null;
  const img = prod ? (Array.isArray(prod.image) ? prod.image[0] : prod.image) : null;

  // Breadcrumb do JSON-LD dá a hierarquia de categorias com mais fiabilidade
  // do que qualquer heurística sobre o HTML.
  let cats: string[] = [];
  for (const o of jsonLdObjects(html)) {
    const walk = (n: any): void => {
      if (!n || typeof n !== "object") return;
      if (n["@type"] === "BreadcrumbList" && Array.isArray(n.itemListElement)) {
        cats = n.itemListElement
          .map((e: any) => (typeof e?.name === "string" ? e.name : e?.item?.name))
          .filter((s: unknown): s is string => typeof s === "string" && s.length > 1);
      }
      for (const v of Object.values(n)) Array.isArray(v) ? v.forEach(walk) : walk(v);
    };
    walk(o);
  }
  if (!cats.length && typeof prod?.category === "string") cats = prod.category.split(/[>/|]/).map((s: string) => s.trim());
  // O primeiro nível é quase sempre "Início"/"Home" e o último o produto.
  const clean = cats.filter((c) => !/^(in[ií]cio|home|homepage)$/i.test(c));
  const semProduto = clean.length > 1 ? clean.slice(0, -1) : clean;

  return {
    categoria: semProduto[0] ?? null,
    subcategoria: semProduto[1] ?? null,
    laboratorio: (typeof brand === "string" && brand.trim()) || null,
    imagemUrl: (typeof img === "string" && img.startsWith("http") ? img : null) ?? meta(html, "og:image"),
    nome: (typeof prod?.name === "string" ? prod.name : null) ?? meta(html, "og:title"),
    fonte: new URL(url).hostname.replace(/^www\./, ""),
  };
}

// ── Motor A ──────────────────────────────────────────────────────────

/** Sites com pesquisa própria. Preferidos a motores de busca: mais
 *  estáveis, mais educados, e o CNP costuma vir no slug do produto. */
const SITES: { host: string; search: (q: string | number) => string; linkRe: RegExp }[] = [
  { host: "farmaciasportuguesas.pt",
    search: (q) => `https://www.farmaciasportuguesas.pt/catalogsearch/result/?q=${q}`,
    linkRe: /href="(https:\/\/www\.farmaciasportuguesas\.pt\/[a-z0-9][^"?#]*\.html)"/gi },
  { host: "auchan.pt",
    search: (q) => `https://www.auchan.pt/pt/pesquisa?q=${q}`,
    linkRe: /href="(https:\/\/www\.auchan\.pt\/pt\/[^"?#]*\.html)"/gi },
  { host: "farmaciaspt.pt",
    search: (q) => `https://www.farmaciaspt.pt/pesquisa?controller=search&s=${q}`,
    linkRe: /href="(https:\/\/www\.farmaciaspt\.pt\/[^"?#]+\.html)"/gi },
  { host: "farmaciachaves.pt",
    search: (q) => `https://www.farmaciachaves.pt/pesquisa?controller=search&s=${q}`,
    linkRe: /href="(https:\/\/www\.farmaciachaves\.pt\/[^"?#]+\.html)"/gi },
  { host: "pharmascalabis.com",
    search: (q) => `https://www.pharmascalabis.com/?s=${q}&post_type=product`,
    linkRe: /href="(https:\/\/www\.pharmascalabis\.com\/store\/[^"?#]+\/)"/gi },
  { host: "asmpd.pt",
    search: (q) => `https://loja.asmpd.pt/Pesquisa?texto=${q}`,
    linkRe: /href="(\/FichaProduto\/Produto\/[^"?#]+)"/gi },
  { host: "farmaciagarcia.pt",
    search: (q) => `https://www.farmaciagarcia.pt/pesquisa?controller=search&s=${q}`,
    linkRe: /href="(https:\/\/www\.farmaciagarcia\.pt\/[^"?#]+\.html)"/gi },
  { host: "myfarma.pt",
    search: (q) => `https://www.myfarma.pt/pesquisa?controller=search&s=${q}`,
    linkRe: /href="(https:\/\/www\.myfarma\.pt\/[^"?#]+\.html)"/gi },
];

async function ddgUrls(cnp: number): Promise<string[]> {
  const html = await fetchCached(`https://html.duckduckgo.com/html/?q=%22${cnp}%22`);
  const urls: string[] = [];
  for (const m of html.matchAll(/uddg=([^"&]+)/g)) {
    try {
      const u = decodeURIComponent(m[1]);
      if (/^https?:\/\/[^/]*\.pt\//i.test(u)) urls.push(u);
    } catch { /* percent-encoding partido */ }
  }
  return [...new Set(urls)].slice(0, 4);
}

async function motorA(cnp: number): Promise<{ hits: Extracted[]; tried: number }> {
  const candidates: string[] = [];
  for (const s of SITES) {
    const html = await fetchCached(s.search(cnp));
    const links = [...new Set([...html.matchAll(s.linkRe)].map((m) => m[1]))];
    // Descarta links de navegação: o produto certo traz o CNP no slug.
    candidates.push(...links.filter((l) => l.includes(String(cnp))).slice(0, 2));
  }
  if (candidates.length === 0) candidates.push(...(await ddgUrls(cnp)));

  const hits: Extracted[] = [];
  for (const url of candidates.slice(0, 4)) {
    const html = await fetchCached(url);
    if (!html) continue;
    // Confirmação de identidade NA PÁGINA DO PRODUTO.
    if (!html.includes(String(cnp))) continue;
    const e = extractCommercial(html, url);
    if (e.laboratorio || e.imagemUrl || e.categoria) hits.push(e);
  }
  return { hits, tried: candidates.length };
}

/** Consenso: um valor visto em mais domínios independentes ganha. */
function consensus(values: (string | null)[]): string | null {
  const counts = new Map<string, number>();
  for (const v of values) {
    if (!v) continue;
    const k = v.trim();
    if (k.length < 2) continue;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let best: string | null = null; let n = 0;
  for (const [k, c] of counts) if (c > n) { best = k; n = c; }
  return best;
}

// ── Resolução de entidades ───────────────────────────────────────────
// Categoria e laboratório são chaves estrangeiras. Sem isto, os valores
// extraídos ficavam a ser deitados fora — era o que faltava.

const norm = (s: string): string =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "")
   .toUpperCase().replace(/[^A-Z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

type Taxo = { id: string; nome: string; norm: string; nivel: 1 | 2; paiId: string | null };
let TAXO: Taxo[] = [];

async function loadTaxonomy(db: pg.Client): Promise<void> {
  const { rows } = await db.query<{ id: string; nome: string; tipo: string; classificacaoPaiId: string | null }>(
    `select id, nome, tipo, "classificacaoPaiId" from "Classificacao" where estado='ATIVO'`);
  TAXO = rows.map((r) => ({
    id: r.id, nome: r.nome, norm: norm(r.nome),
    nivel: r.tipo === "NIVEL_1" ? 1 : 2, paiId: r.classificacaoPaiId,
  }));
}

/**
 * Mapeia termos vindos da web para a taxonomia EXISTENTE. Nunca cria
 * categorias: a taxonomia é controlada (15 de nível 1, 88 de nível 2) e
 * deixar entrar "Bebé e Mama" de um breadcrumb qualquer degradava-a de
 * forma difícil de desfazer.
 *
 * Correspondência por contenção normalizada em ambos os sentidos —
 * "PROTECAO SOLAR" casa com "Solares", "Proteção Solar", "solar".
 */
function mapCategoria(termos: (string | null)[]): { n1: string | null; n2: string | null } {
  const cand = termos.filter((t): t is string => !!t && t.length > 2).map(norm);
  let n1: Taxo | null = null, n2: Taxo | null = null;
  for (const t of cand) {
    for (const c of TAXO) {
      const hit = c.norm === t || (t.length >= 4 && c.norm.includes(t)) || (c.norm.length >= 4 && t.includes(c.norm));
      if (!hit) continue;
      if (c.nivel === 1 && !n1) n1 = c;
      if (c.nivel === 2 && !n2) n2 = c;
    }
  }
  // Uma subcategoria só vale com o pai coerente; senão fica só o nível 1.
  if (n2 && n1 && n2.paiId && n2.paiId !== n1.id) n2 = null;
  if (n2 && !n1 && n2.paiId) n1 = TAXO.find((c) => c.id === n2!.paiId) ?? null;
  return { n1: n1?.id ?? null, n2: n2?.id ?? null };
}

const fabCache = new Map<string, string>();

/** Marcas são abertas — aqui criar é legítimo, ao contrário das categorias. */
async function resolveFabricante(db: pg.Client, nome: string, dry: boolean): Promise<string | null> {
  const n = norm(nome);
  if (n.length < 2 || n.length > 60) return null;
  if (fabCache.has(n)) return fabCache.get(n)!;

  const found = await db.query<{ id: string }>(
    `select f.id from "Fabricante" f where f."nomeNormalizado"=$1
     union select a."fabricanteId" from "FabricanteAlias" a where upper(a."aliasNome")=$1 limit 1`, [n]);
  if (found.rows[0]) { fabCache.set(n, found.rows[0].id); return found.rows[0].id; }
  if (dry) return null;

  const ins = await db.query<{ id: string }>(
    `insert into "Fabricante" ("id","nomeNormalizado","dataAtualizacao")
     values (gen_random_uuid()::text, $1, now())
     on conflict ("nomeNormalizado") do update set "nomeNormalizado"=excluded."nomeNormalizado"
     returning id`, [n]);
  const id = ins.rows[0].id;
  fabCache.set(n, id);
  return id;
}

// ── Motor B ──────────────────────────────────────────────────────────

type RegFields = { dci: string | null; codigoATC: string | null; titularAim: string | null;
                   formaFarmaceutica: string | null; dosagem: string | null };

async function motorB(cnp: number, designacao: string): Promise<RegFields | null> {
  const { startSearchSession, searchByDesignacao, clickRowAndFetchDetail, normalizeForSearch } =
    await import("../../lib/regulatory-sources/infomed-search-resolver");
  try {
    const session = await startSearchSession();
    const termo = normalizeForSearch(designacao);
    // Assinaturas reais: searchByDesignacao(session, term) e
    // clickRowAndFetchDetail(session, LISTAGEM, ÍNDICE) — não a linha.
    const listagem = await searchByDesignacao(session, termo);
    const rows = (listagem as any)?.rows ?? [];
    if (!rows.length) return null;
    const detail: any = await clickRowAndFetchDetail(session, listagem, 0);
    if (!detail) return null;
    return {
      dci: detail.dci ?? null,
      codigoATC: detail.codigoATC ?? null,
      titularAim: detail.titularAim ?? null,
      formaFarmaceutica: detail.formaFarmaceutica ?? null,
      dosagem: detail.dosagem ?? null,
    };
  } catch {
    return null;
  }
}

// ── Base de dados ────────────────────────────────────────────────────

type Row = {
  id: string; cnp: number; designacao: string; productType: string | null;
  codigoATC: string | null; dci: string | null; imagemUrl: string | null;
  fabricanteId: string | null; classificacaoNivel1Id: string | null;
  grupoHomogeneo: string | null; isMedicamento: boolean;
};

const FIELDS = ["categoria", "laboratorio", "dci", "atc", "grupoHomogeneo", "imagem"] as const;
type Field = (typeof FIELDS)[number];

async function main(): Promise<void> {
  const args = parseArgs();
  loadState();

  const base = process.env.DATABASE_URL!;
  const url = base.replace(/\/[^/?]+(\?|$)/, `/${args.tenantDb}$1`);
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  // O endpoint `-pooler` do Neon não repõe parâmetros de sessão entre clientes:
  // um `SET default_transaction_read_only = on` feito por qualquer outro
  // processo fica colado a uma ligação do pool e mata as escritas daqui a meio
  // da corrida. Limpar à entrada torna a corrida imune a esse estado herdado.
  await db.query("set session default_transaction_read_only = off");
  await loadTaxonomy(db);

  const { rows } = await db.query<Row>(`
    select p.id, p.cnp, p.designacao, p."productType", p."codigoATC", p.dci,
           p."imagemUrl", p."fabricanteId", p."classificacaoNivel1Id", p."grupoHomogeneo",
           (p."productType" = 'MEDICAMENTO' or r.cnp is not null) as "isMedicamento"
    from "Produto" p left join "RegulatoryRecord" r on r.cnp = p.cnp
    where p.cnp >= $1 and p.estado <> 'INATIVO' and p."validadoManualmente" = false
      and p.cnp <> all($3::int[])
      -- Segunda fase, e só isso. A primeira é a ingestão: o ERP da
      -- farmácia já entrega fabricante, DCI, ATC, grupo homogéneo e tipo
      -- durante o products-upload. Ir à Internet buscar o que a farmácia
      -- já sabia é trabalho a dobrar e de pior qualidade. Aqui só entram
      -- produtos a quem falta mesmo alguma coisa.
      and (p."classificacaoNivel1Id" is null
           or p."fabricanteId" is null
           or p."imagemUrl" is null
           or (p."productType" = 'MEDICAMENTO'
               and (p.dci is null or p."codigoATC" is null or p."grupoHomogeneo" is null)))
    order by (p.cnp::bigint * 7919) % 100003
    limit $2`, [MIN_CNP, args.limit, [...done]]);

  const pending = rows;

  const before = coverage(rows.slice(0, args.limit));
  console.log(`universo lido: ${rows.length} · por processar: ${pending.length} · já feitos: ${done.size}`);
  console.log(`motor A (comercial): ${pending.filter((p) => !p.isMedicamento).length} · motor B (medicamentos): ${pending.filter((p) => p.isMedicamento).length}`);
  if (args.dryRun) console.log("MODO DRY-RUN — nada será escrito\n");

  let processados = 0, enriquecidos = 0, camposEscritos = 0;
  const porCampo = new Map<string, number>();
  const semMapa = new Map<string, number>();
  const bloqueios = new Map<string, number>();
  const exemplos: string[] = [];
  const nota = (k: string) => bloqueios.set(k, (bloqueios.get(k) ?? 0) + 1);

  const queue = [...pending];
  const worker = async (): Promise<void> => {
    for (;;) {
      const p = queue.shift();
      if (!p) return;
      processados++;
      const sets: string[] = [];
      const vals: unknown[] = [];
      const got: string[] = [];

      try {
        if (p.isMedicamento && args.engine !== "A") {
          const reg = await motorB(p.cnp, p.designacao);
          if (!reg) nota("motor B: INFOMED sem resultado");
          else {
            if (!p.dci && reg.dci) { vals.push(reg.dci); sets.push(`dci=$${vals.length}`); got.push("dci"); }
            if (!p.codigoATC && reg.codigoATC) { vals.push(reg.codigoATC); sets.push(`"codigoATC"=$${vals.length}`); got.push("atc"); }
          }
        } else if (!p.isMedicamento && args.engine !== "B") {
          const { hits, tried } = await motorA(p.cnp);
          if (tried === 0) nota("motor A: sem candidatos na pesquisa");
          else if (hits.length === 0) nota("motor A: candidatos sem confirmação de identidade");
          else {
            const lab = consensus(hits.map((h) => h.laboratorio));
            const img = consensus(hits.map((h) => h.imagemUrl));
            const { n1, n2 } = mapCategoria(hits.flatMap((h) => [h.categoria, h.subcategoria]));

            if (!p.imagemUrl && img) { vals.push(img); sets.push(`"imagemUrl"=$${vals.length}`); got.push("imagem"); }
            if (!p.fabricanteId && lab) {
              const fid = await resolveFabricante(db, lab, args.dryRun);
              if (fid) { vals.push(fid); sets.push(`"fabricanteId"=$${vals.length}`); got.push("laboratorio"); }
              else nota("laboratório extraído mas não resolvido em Fabricante");
            }
            if (!p.classificacaoNivel1Id && n1) {
              vals.push(n1); sets.push(`"classificacaoNivel1Id"=$${vals.length}`); got.push("categoria");
              if (n2) { vals.push(n2); sets.push(`"classificacaoNivel2Id"=$${vals.length}`); got.push("subcategoria"); }
            } else if (!p.classificacaoNivel1Id && hits.some((h) => h.categoria)) {
              nota("categoria da web sem correspondência na taxonomia");
              for (const h of hits) if (h.categoria) semMapa.set(h.categoria, (semMapa.get(h.categoria) ?? 0) + 1);
            }
          }
        }
      } catch (e) { nota(`excepção: ${String((e as Error).message).slice(0, 60)}`); }

      if (sets.length && !args.dryRun) {
        vals.push(p.id);
        await db.query(`update "Produto" set ${sets.join(", ")} where id=$${vals.length}`, vals);
      }
      if (got.length) {
        enriquecidos++;
        camposEscritos += got.length;
        for (const g of got) porCampo.set(g, (porCampo.get(g) ?? 0) + 1);
        if (exemplos.length < 10) exemplos.push(`  ${p.cnp}  ${p.designacao.slice(0, 44).padEnd(44)} → ${got.join(", ")}`);
      }
      appendJson(CKPT_FILE, { cnp: p.cnp, got });
      if (processados % 25 === 0) console.log(`  ... ${processados}/${pending.length} processados, ${enriquecidos} enriquecidos`);
    }
  };

  await Promise.all(Array.from({ length: args.concurrency }, worker));

  // Releitura para medir o depois com dados reais, não com o que julgamos ter escrito.
  const { rows: after } = await db.query<Row>(`
    select p.id, p.cnp, p.designacao, p."productType", p."codigoATC", p.dci, p."imagemUrl",
           p."fabricanteId", p."classificacaoNivel1Id", p."grupoHomogeneo",
           (p."productType"='MEDICAMENTO' or r.cnp is not null) as "isMedicamento"
    from "Produto" p left join "RegulatoryRecord" r on r.cnp=p.cnp
    where p.cnp = any($1)`, [pending.map((p) => p.cnp)]);

  console.log(`\n═══ RESULTADO ═══`);
  console.log(`produtos enriquecidos : ${enriquecidos}`);
  console.log(`CAMPOS enriquecidos   : ${camposEscritos}`);
  if (porCampo.size) {
    console.log(`
campos escritos por tipo`);
    [...porCampo].sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log(`  ${String(n).padStart(5)}  ${k}`));
  }
  const aft = coverage(after);
  console.log(`\ncobertura (antes → depois)`);
  for (const f of FIELDS) console.log(`  ${f.padEnd(16)} ${pct(before[f])} → ${pct(aft[f])}`);
  if (exemplos.length) { console.log(`\nexemplos:`); exemplos.forEach((e) => console.log(e)); }
  // Cobertura por tipo de produto — a média global esconde que
  // dermocosmética e medicamentos são realidades diferentes.
  const { rows: porTipo } = await db.query(`
    select coalesce(p."productType",'(por classificar)') tipo, count(*)::int n,
      round(100.0*count(p."classificacaoNivel1Id")/count(*),1) cat,
      round(100.0*count(p."fabricanteId")/count(*),1) lab,
      round(100.0*count(p."imagemUrl")/count(*),1) img
    from "Produto" p where p.cnp >= $1 and p.estado <> 'INATIVO'
    group by 1 order by 2 desc limit 12`, [MIN_CNP]);
  console.log(`
cobertura por tipo de produto (catálogo completo)`);
  console.log(`  ${"tipo".padEnd(22)} ${"n".padStart(6)}  cat%   lab%   img%`);
  for (const t of porTipo as any[])
    console.log(`  ${String(t.tipo).padEnd(22)} ${String(t.n).padStart(6)}  ${String(t.cat).padStart(5)} ${String(t.lab).padStart(6)} ${String(t.img).padStart(6)}`);

  const { rows: piores } = await db.query(`
    select coalesce(f."nomeNormalizado",'(sem fabricante)') fab, count(*)::int n,
      round(100.0*count(p."classificacaoNivel1Id")/count(*),1) cat,
      round(100.0*count(p."imagemUrl")/count(*),1) img
    from "Produto" p left join "Fabricante" f on f.id=p."fabricanteId"
    where p.cnp >= $1 and p.estado <> 'INATIVO' and p."fabricanteId" is not null
    group by 1 having count(*) >= 10 order by img asc, n desc limit 20`, [MIN_CNP]);
  if (piores.length) {
    console.log(`
top 20 fabricantes com pior cobertura (>=10 produtos)`);
    for (const f of piores as any[])
      console.log(`  ${String(f.fab).slice(0,30).padEnd(30)} n=${String(f.n).padStart(5)}  cat=${String(f.cat).padStart(5)}%  img=${String(f.img).padStart(5)}%`);
  }

  if (semMapa.size) {
    console.log(`
breadcrumbs SEM correspondência na taxonomia (para revisão)`);
    [...semMapa].sort((a, b) => b[1] - a[1]).slice(0, 15).forEach(([k, n]) => console.log(`  ${String(n).padStart(4)}  ${k}`));
    appendJson(path.join(OUT_DIR, "breadcrumbs-por-mapear.jsonl"), { at: new Date().toISOString(), termos: [...semMapa] });
  }

  if (bloqueios.size) {
    console.log(`\nbloqueios:`);
    [...bloqueios].sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log(`  ${String(n).padStart(4)}  ${k}`));
  }
  await db.end();
}

type Cov = Record<Field, { n: number; d: number }>;
function coverage(rows: Row[]): Cov {
  const c: Cov = Object.fromEntries(FIELDS.map((f) => [f, { n: 0, d: 0 }])) as Cov;
  for (const r of rows) {
    c.categoria.d++; if (r.classificacaoNivel1Id) c.categoria.n++;
    c.laboratorio.d++; if (r.fabricanteId) c.laboratorio.n++;
    c.imagem.d++; if (r.imagemUrl) c.imagem.n++;
    // ATC/DCI/GH só contam sobre medicamentos — é a regra de negócio.
    if (r.isMedicamento) {
      c.dci.d++; if (r.dci) c.dci.n++;
      c.atc.d++; if (r.codigoATC) c.atc.n++;
      c.grupoHomogeneo.d++; if (r.grupoHomogeneo) c.grupoHomogeneo.n++;
    }
  }
  return c;
}
const pct = (x: { n: number; d: number }) =>
  `${x.d ? ((100 * x.n) / x.d).toFixed(1) : "0.0"}% (${x.n}/${x.d})`;

main().catch((e) => { console.error(e); process.exit(1); });
