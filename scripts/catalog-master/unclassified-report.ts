/**
 * scripts/catalog-master/unclassified-report.ts
 *
 * Caracteriza o universo que continua sem tipo depois do backfill.
 *
 * ATENÇÃO: tudo o que este relatório produz é ESTIMATIVA. Usa sinais fracos
 * (marca no início da designação, substantivos de categoria) que foram
 * deliberadamente recusados para escrita. Serve para decidir onde investir,
 * não para classificar. Nada aqui é persistido.
 *
 * O que ordena o trabalho não é o número de produtos, é o retorno
 * operacional: um produto sem tipo que nunca vendeu não custa nada; um que
 * representa milhares de euros de vendas é uma lacuna real no catálogo.
 * Por isso a marca é ranqueada por vendas, não só por contagem.
 *
 * Uso: npx tsx scripts/catalog-master/unclassified-report.ts [--db=...]
 */
import "dotenv/config";
import pg from "pg";

const MIN_CNP = 2_000_000;

/**
 * Léxico de ESTIMATIVA — mais largo e mais arriscado que o do classificador.
 * Inclui marcas e substantivos que sozinhos não bastam para escrever, mas
 * bastam para dizer "este bolo é sobretudo dermocosmética".
 */
const LEXICO: Array<{ tipo: string; termos: string[] }> = [
  { tipo: "DERMOCOSMETICA", termos: [
    "bioderma","roche","posay","uriage","avene","eucerin","cetaphil","vichy","caudalie",
    "nuxe","lierac","isdin","topicrem","svr","ducray","klorane","filorga","neostrata",
    "martiderm","sesderma","heliocare","rilastil","galenic","noreva","dermalex","cerave",
    "creme","cr","serum","hidratante","solar","spf","facial","corporal","tonico","mascara",
    "esfoliante","antirrugas","olho","labial","batom","maquilhagem","base","corretor",
  ]},
  { tipo: "HIGIENE_CUIDADO", termos: [
    "champo","ch","shampoo","gel","duche","banho","sabonete","dentifrico","pasta","dentes",
    "escova","elixir","colutorio","fio","dental","desodorizante","deo","intimo","toalhete",
    "lenco","absorvente","penso higienico","tampao","barbear","depilatorio","cabelo",
    "condicionador","oral b","colgate","elgydium","parodontax","listerine","sensodyne",
  ]},
  { tipo: "DISPOSITIVO_MEDICO", termos: [
    "seringa","agulha","lanceta","penso","compressa","ligadura","gaze","luva","adesivo",
    "tensiometro","termometro","glucometro","oximetro","nebulizador","aerocamara","tiras",
    "teste","autoteste","preservativo","medela","pic","hartmann","bd","accu","freestyle",
    "libre","contour","onetouch","mascara cirurgica","cateter","sonda","algalia","fralda incont",
  ]},
  { tipo: "ORTOPEDIA", termos: [
    "meia","meias","compressao","mediven","joelheira","tornozeleira","munhequeira","cinta",
    "colar","cervical","palmilha","muleta","bengala","andarilho","cadeira","rodas","tala",
    "ortotese","suporte","almofada","colchao","scholl","futuro","prim","sigvaris",
  ]},
  { tipo: "SUPLEMENTO", termos: [
    "vitamina","vit","magnesio","zinco","ferro","calcio","omega","probiotico","colagenio",
    "solgar","arkocapsulas","centrum","supradyn","cerebrum","absorvit","multicentrum",
    "melatonina","valeriana","ginseng","spirulina","proteina","aminoacido","suplemento",
  ]},
  { tipo: "PUERICULTURA", termos: [
    "bebe","infantil","chupeta","biberon","tetina","nuk","chicco","mam","avent","dodot",
    "huggies","fralda","papa","leite","aptamil","nan","nutriben","holle","mustela","muda",
  ]},
  { tipo: "VETERINARIA", termos: [
    "vet","veterinario","cao","caes","gato","gatos","antipulgas","desparasitante","coleira",
    "frontline","advantix","seresto","bravecto","virbac","royal canin","racao",
  ]},
  { tipo: "MEDICAMENTO", termos: [
    "comp","caps","xar","amp","sup","inj","pomada","colirio","gotas","supositorio",
    "comprimido","capsula","xarope","ampola","solucao","suspensao","po","granulado",
  ]},
];

function normalizar(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function tokens(s: string): Set<string> {
  const palavras = normalizar(s).split(/[\s\-\/,;:.()[\]]+/).filter(Boolean);
  const t = new Set(palavras);
  for (let i = 0; i < palavras.length - 1; i++) t.add(`${palavras[i]} ${palavras[i + 1]}`);
  return t;
}

/** Estima o tipo por contagem de termos; devolve null se nada bater. */
function estimar(designacao: string): { tipo: string; forca: number } | null {
  const t = tokens(designacao);
  let melhor: { tipo: string; forca: number } | null = null;
  for (const { tipo, termos } of LEXICO) {
    let n = 0;
    for (const termo of termos) if (t.has(termo)) n++;
    if (n > 0 && (!melhor || n > melhor.forca)) melhor = { tipo, forca: n };
  }
  return melhor;
}

/** Primeira palavra significativa = marca, na prática, neste catálogo. */
function marca(designacao: string): string {
  const p = normalizar(designacao).split(/[\s\-\/,;:.()[\]]+/).filter(Boolean);
  return p[0] ?? "(vazio)";
}

type Row = { cnp: number; designacao: string; vendas: string; unidades: string };

async function main() {
  const argv = process.argv.slice(2);
  const dbName =
    argv.find((a) => a.startsWith("--db="))?.split("=")[1] ??
    "spharmmt_t_grupo_silveira";
  const url = process.env.DATABASE_URL!.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
  const db = new pg.Client({ connectionString: url });
  await db.connect();

  const { rows } = await db.query<Row>(
    // Fonte de vendas: VendaMensal. As outras duas candidatas não servem —
    // "Venda" está vazia (0 linhas) desde a migração para o pipeline canónico,
    // e MovimentoArtigo tem os 549 866 movimentos de venda mas `valorLinha`
    // a NULL em todos (campo rev36 nunca preenchido neste tenant). Somar
    // qualquer uma delas dava 0 EUR e fazia este ranking medir nada.
    `select p.cnp, p.designacao,
            coalesce(sum(vm."valorTotal"), 0)::text as vendas,
            coalesce(sum(vm.quantidade), 0)::text as unidades
       from "Produto" p
       left join "VendaMensal" vm on vm."produtoId" = p.id
      where p.cnp >= $1 and p."productType" is null
      group by p.cnp, p.designacao`,
    [MIN_CNP],
  );
  await db.end();

  const totalVendas = rows.reduce((s, r) => s + Number(r.vendas), 0);
  console.log(`\nprodutos ainda sem tipo: ${rows.length}`);
  console.log(`vendas associadas: ${totalVendas.toLocaleString("pt-PT", { maximumFractionDigits: 0 })} EUR\n`);

  // ── Distribuição estimada ───────────────────────────────────────────
  const porTipo = new Map<string, { n: number; vendas: number }>();
  const semPista: Row[] = [];
  for (const r of rows) {
    const e = estimar(r.designacao);
    const k = e ? e.tipo : "(sem pista nenhuma)";
    if (!e) semPista.push(r);
    const cur = porTipo.get(k) ?? { n: 0, vendas: 0 };
    cur.n++;
    cur.vendas += Number(r.vendas);
    porTipo.set(k, cur);
  }

  console.log("=== DISTRIBUIÇÃO ESTIMADA (não escrita, só estimativa) ===\n");
  console.log("tipo provável".padEnd(24) + "     n     %  vendas EUR   % vendas");
  console.log("─".repeat(66));
  for (const [k, v] of [...porTipo].sort((a, b) => b[1].vendas - a[1].vendas)) {
    console.log(
      k.padEnd(24) +
        String(v.n).padStart(6) +
        `${((v.n / rows.length) * 100).toFixed(1)}%`.padStart(6) +
        Math.round(v.vendas).toLocaleString("pt-PT").padStart(12) +
        `${totalVendas ? ((v.vendas / totalVendas) * 100).toFixed(1) : "0.0"}%`.padStart(10),
    );
  }

  // ── Marcas, ordenadas por retorno operacional ───────────────────────
  const porMarca = new Map<string, { n: number; vendas: number; ex: string }>();
  for (const r of rows) {
    const m = marca(r.designacao);
    const cur = porMarca.get(m) ?? { n: 0, vendas: 0, ex: r.designacao };
    cur.n++;
    cur.vendas += Number(r.vendas);
    porMarca.set(m, cur);
  }

  console.log("\n=== TOP 30 MARCAS SEM TIPO, por vendas (onde está o retorno) ===\n");
  console.log("marca".padEnd(18) + "     n  vendas EUR   tipo provável        exemplo");
  console.log("─".repeat(100));
  for (const [m, v] of [...porMarca].sort((a, b) => b[1].vendas - a[1].vendas).slice(0, 30)) {
    const e = estimar(v.ex);
    console.log(
      m.padEnd(18) +
        String(v.n).padStart(6) +
        Math.round(v.vendas).toLocaleString("pt-PT").padStart(12) + "   " +
        (e?.tipo ?? "—").padEnd(20) +
        v.ex.slice(0, 40),
    );
  }

  console.log("\n=== TOP 20 MARCAS SEM TIPO, por número de produtos ===\n");
  for (const [m, v] of [...porMarca].sort((a, b) => b[1].n - a[1].n).slice(0, 20)) {
    console.log(`  ${String(v.n).padStart(5)}  ${m.padEnd(18)} ${v.ex.slice(0, 50)}`);
  }

  console.log(`\n=== SEM PISTA NENHUMA: ${semPista.length} produtos ===`);
  const semPistaVendas = semPista.reduce((s, r) => s + Number(r.vendas), 0);
  console.log(`vendas: ${Math.round(semPistaVendas).toLocaleString("pt-PT")} EUR ` +
    `(${totalVendas ? ((semPistaVendas / totalVendas) * 100).toFixed(1) : "0"}% do universo sem tipo)\n`);
  for (const r of [...semPista].sort((a, b) => Number(b.vendas) - Number(a.vendas)).slice(0, 15)) {
    console.log(`  ${String(Math.round(Number(r.vendas))).padStart(8)} EUR  ${r.cnp}  ${r.designacao.slice(0, 55)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
