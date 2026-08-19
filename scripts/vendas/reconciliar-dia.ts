/**
 * scripts/vendas/reconciliar-dia.ts
 *
 * O gate de produção da correcção VSG. Read-only.
 *
 * ── PORQUE EXISTE ────────────────────────────────────────────────────
 *
 * O reader passou a ler duas fontes em vez de uma. Isso corrige um erro
 * por defeito (vendas VSG invisíveis) e abre a porta a um erro por
 * excesso (a mesma nota de crédito contada duas vezes). Os dois são
 * plausíveis à vista: o total muda para um número que ninguém sabe de
 * cor. A única forma de os distinguir é contar cada peça em separado e
 * confrontá-la com o ERP.
 *
 * Este comando não decide nada nem escreve nada. Conta, num dia:
 *
 *   · unidades G, unidades VSG, e as duas em separado
 *   · devoluções/anulações, e por que circuito entraram
 *   · líquido G+VSG e valor bruto líquido
 *   · número de documentos distintos por série
 *   · duplicados pela chave canónica (farmacia, namespace, linha)
 *   · os CNP conhecidos, um a um
 *
 * ── O QUE NÃO FAZ ────────────────────────────────────────────────────
 *
 * Não lê o ERP e não abre ligação a SQL Server: compara o que está no
 * SaaS com o que o operador vê no SPharm. A comparação é humana de
 * propósito — é o ERP que é a fonte da verdade, não este script.
 *
 * Uso:
 *   npm run vendas:reconciliar -- --tenant=silveira --dia=2026-08-01
 *   npm run vendas:reconciliar -- --tenant=silveira --dia=2026-08-01 \
 *     --cnps=9599258,3626884
 */

import "dotenv/config";
import { parseArgs } from "node:util";
import {
  controlPrisma,
  getTenantBySlug,
  buildTenantConnectionString,
} from "@/lib/control-plane";
import { PrismaClient, Prisma } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { SQL_LINHAS_ELEGIVEIS, SQL_QUANTIDADE_ASSINADA } from "@/lib/aggregate/vendamensal";

const RULE = "─".repeat(78);
const DOUBLE = "═".repeat(78);

/**
 * A população que faltava: as unidades do circuito VSG, por CNP, em
 * 01/08/2026 na Silveirense.
 *
 * ── O GATE É SOBRE VSG, NÃO SOBRE O TOTAL DO PRODUTO ─────────────────
 *
 * Estes números são o componente que o SPharm.MT não via — as vendas
 * suspensas — e NÃO o total diário do artigo. O mesmo CNP pode ter
 * vendas de balcão no mesmo dia, e tem:
 *
 *   9599258   VSG/54684 10:26:38 qtd 2   +   G 12:48:26 qtd 1   → 3 no dia
 *   3742780   VSG/54685 10:39:04 qtd 1   +   G 18:17:16 qtd 1   → 2 no dia
 *
 * São documentos distintos: `externalSaleId` distinto, `externalSaleLineId`
 * distinto, hora distinta. Não há duplicação nenhuma — há dois eventos.
 *
 * Um gate sobre o líquido total acusaria estes dois como divergentes e
 * mandaria procurar um erro que não existe. O gate certo é o que mede a
 * população que estava em falta.
 *
 * NÚMEROS, não strings. `Produto.cnp` é `Int @unique` no schema, e o
 * Postgres devolve-o como número — foi comparar um com o outro por `===`
 * que fez esta secção reportar `liquido=0` para CNPs que existiam no raw.
 */
const CNPS_PROVADOS: Array<{ cnp: number; nome: string; esperadoVsg: number }> = [
  { cnp: 9599258, nome: "NIMED", esperadoVsg: 2 },
  { cnp: 3626884, nome: "ENALAPRIL", esperadoVsg: 1 },
  { cnp: 5667761, nome: "", esperadoVsg: 1 },
  { cnp: 5002639, nome: "", esperadoVsg: 1 },
  { cnp: 5304472, nome: "", esperadoVsg: 1 },
  { cnp: 7888784, nome: "", esperadoVsg: 1 },
  { cnp: 7888800, nome: "", esperadoVsg: 1 },
  { cnp: 5674239, nome: "", esperadoVsg: 1 },
  { cnp: 3742780, nome: "", esperadoVsg: 1 },
  { cnp: 5736335, nome: "", esperadoVsg: 1 },
  { cnp: 9629113, nome: "", esperadoVsg: 1 },
];

export type AlvoCnp = { cnp: number; nome: string; esperadoVsg: number };

/** Uma linha do raw, reduzida ao que a secção 5 precisa. */
export type LinhaCnp = {
  cnp: number;
  designacao: string | null;
  sourceNamespace: string;
  classe: string;
  unidades: number;
  documentos: string | null;
};

export type ResumoCnp = {
  cnp: number;
  nome: string;
  /** Unidades do circuito VSG. É sobre isto que o gate decide. */
  vsg: number;
  /** Unidades de venda do circuito G (balcão), sem as reversões. */
  g: number;
  /** Reversões, de qualquer circuito. Negativas. */
  reversoes: number;
  /** Tudo somado — o que o artigo fez no dia. Informativo. */
  liquido: number;
  esperadoVsg: number;
  bate: boolean | null;
  linhas: LinhaCnp[];
};

/** Um CNP pedido na linha de comandos, com ou sem VSG esperado. */
export type CnpPedido = { cnp: number; esperadoVsg: number };

/**
 * `--cnps=9599258,3626884` → sem expectativa.
 * `--cnps=9599258:2,3742780:1` → com o VSG esperado por CNP.
 *
 * A segunda forma existe para o comando não ficar soldado a um dia: a
 * lista embutida é a de 01/08/2026 na Silveirense, e outra reconciliação
 * precisa dos seus próprios números sem editar código.
 *
 * Recusa o que não for inteiro em vez de o deixar cair em silêncio: um
 * CNP mal escrito que desaparecesse da lista daria uma reconciliação
 * "sem problemas" que nunca chegou a olhar para ele.
 */
export function parseCnps(bruto: string | undefined): CnpPedido[] {
  if (!bruto) return [];
  const partes = bruto.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  const maus = partes.filter((p) => !/^\d+(:\d+)?$/.test(p));
  if (maus.length > 0) {
    throw new Error(
      `--cnps: não são CNP válidos: ${maus.join(", ")}. ` +
        `Formato: 9599258 ou 9599258:2 (CNP:unidades VSG esperadas).`,
    );
  }
  return partes.map((p) => {
    const [cnp, esperado] = p.split(":");
    return {
      cnp: Number(cnp),
      esperadoVsg: esperado === undefined ? Number.NaN : Number(esperado),
    };
  });
}

/**
 * Os alvos, sem duplicados, com os provados primeiro.
 *
 * Um CNP repetido na linha de comandos não sobrepõe o valor provado sem
 * o dizer: se trouxer um esperado diferente, é um conflito e atira. Dois
 * números para a mesma coisa, com um deles a ganhar em silêncio, é como
 * se perde a confiança num relatório.
 */
export function alvosCnp(extra: CnpPedido[]): AlvoCnp[] {
  const porCnp = new Map(CNPS_PROVADOS.map((c) => [c.cnp, c]));
  for (const e of extra) {
    const provado = porCnp.get(e.cnp);
    if (!provado) {
      porCnp.set(e.cnp, { cnp: e.cnp, nome: "", esperadoVsg: e.esperadoVsg });
      continue;
    }
    if (!Number.isNaN(e.esperadoVsg) && e.esperadoVsg !== provado.esperadoVsg) {
      throw new Error(
        `--cnps: ${e.cnp} pede VSG=${e.esperadoVsg} mas o valor provado é ` +
          `${provado.esperadoVsg}. Corrigir um dos dois — não se escolhe em silêncio.`,
      );
    }
  }
  return [...porCnp.values()];
}

/**
 * Agrupa as linhas por CNP e confronta com o esperado.
 *
 * Puro de propósito: o defeito que isto fecha não estava no SQL — a
 * query devolvia as linhas certas. Estava na comparação em JavaScript,
 * onde `9599258 === "9599258"` é falso e o total dava sempre zero. Um
 * teste sem base de dados apanha isso; um teste que precisasse de
 * Postgres nunca teria sido escrito.
 */
export function resumirPorCnp(linhas: LinhaCnp[], alvos: AlvoCnp[]): ResumoCnp[] {
  const soma = (ls: LinhaCnp[]) => ls.reduce((a, l) => a + l.unidades, 0);
  return alvos.map((alvo) => {
    const minhas = linhas.filter((l) => l.cnp === alvo.cnp);
    const reversao = (l: LinhaCnp) => l.classe === "DEVOLUCAO_ANULACAO";
    // O gate mede a venda suspensa. As reversões do circuito VSG não
    // existem por construção (as NC entram por [Atendimento Detalhe]),
    // mas se aparecerem contam aqui na mesma — é assim que se veria.
    const vsg = soma(minhas.filter((l) => l.sourceNamespace === NS_VSG));
    const g = soma(minhas.filter((l) => l.sourceNamespace === NS_G && !reversao(l)));
    return {
      cnp: alvo.cnp,
      nome: minhas[0]?.designacao ?? alvo.nome,
      vsg,
      g,
      reversoes: soma(minhas.filter(reversao)),
      liquido: soma(minhas),
      esperadoVsg: alvo.esperadoVsg,
      bate: Number.isNaN(alvo.esperadoVsg) ? null : vsg === alvo.esperadoVsg,
      linhas: minhas,
    };
  });
}

const NS_G = "ATENDIMENTO_DETALHE";
const NS_VSG = "ATENDIMENTO_SUSP_DETALHE";

function n(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}
function fmt(v: unknown, casas = 2): string {
  return n(v).toLocaleString("pt-PT", {
    minimumFractionDigits: casas,
    maximumFractionDigits: casas,
  });
}

/** `dia` civil → fronteiras meio-abertas, como o resto do sistema. */
function janelaDoDia(dia: string): { de: Date; ate: Date } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) {
    throw new Error(`--dia deve ser YYYY-MM-DD (recebido: ${dia})`);
  }
  const [y, m, d] = dia.split("-").map((x) => parseInt(x, 10));
  return {
    de: new Date(Date.UTC(y!, m! - 1, d!)),
    ate: new Date(Date.UTC(y!, m! - 1, d! + 1)),
  };
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      tenant: { type: "string" },
      dia: { type: "string" },
      cnps: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help || !values.tenant || !values.dia) {
    console.log("Uso: vendas:reconciliar --tenant=<slug> --dia=YYYY-MM-DD [--cnps=a,b,c]");
    console.log("");
    console.log("Read-only. Conta G, VSG, reversões, documentos e duplicados no dia.");
    console.log("Não escreve nada. Não lê o ERP.");
    return values.help ? 0 : 1;
  }

  const { de, ate } = janelaDoDia(values.dia);
  // Resolvido AQUI, antes de abrir ligação nenhuma: um argumento mal
  // escrito tem de falhar em seco, e não a meio de um relatório já
  // meio-impresso contra a base de produção.
  let alvos: AlvoCnp[];
  try {
    const cnpsExtra: CnpPedido[] = parseCnps(values.cnps);
    alvos = alvosCnp(cnpsExtra);
  } catch (err) {
    console.error("✗", err instanceof Error ? err.message : String(err));
    return 1;
  }

  const tenant = await getTenantBySlug(values.tenant);
  if (!tenant) {
    console.error(`✗ tenant "${values.tenant}" não existe no control plane.`);
    return 1;
  }
  const url = await buildTenantConnectionString(tenant);
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

  let problemas = 0;

  try {
    console.log(DOUBLE);
    console.log(`RECONCILIACAO DO DIA — ${values.dia}   tenant=${values.tenant}`);
    console.log(DOUBLE);
    console.log("Read-only. Nada escrito. O ERP e a fonte da verdade; isto e o");
    console.log("que o SPharm.MT tem, para confronto manual.");

    // ── 1. Por circuito e por classe ─────────────────────────────
    const porFonte = await prisma.$queryRaw<
      Array<{
        farmacia: string;
        sourceNamespace: string;
        tipoDocumentoClass: string;
        linhas: bigint;
        unidades: Prisma.Decimal | null;
        valor: Prisma.Decimal | null;
        documentos: bigint;
      }>
    >(Prisma.sql`
      SELECT f."nome" AS farmacia,
             r."sourceNamespace",
             r."tipoDocumentoClass",
             COUNT(*) AS linhas,
             SUM(${SQL_QUANTIDADE_ASSINADA}) AS unidades,
             SUM(COALESCE(r."valorLinha", 0)) AS valor,
             COUNT(DISTINCT r."externalSaleId") AS documentos
        FROM "IngestVendaLinhaRaw" r
        JOIN "Farmacia" f ON f."id" = r."farmaciaId"
       WHERE r."dataVenda" >= ${de} AND r."dataVenda" < ${ate}
       GROUP BY f."nome", r."sourceNamespace", r."tipoDocumentoClass"
       ORDER BY f."nome", r."sourceNamespace", r."tipoDocumentoClass"
    `);

    console.log("");
    console.log(RULE);
    console.log("1. POR CIRCUITO E CLASSE");
    console.log(RULE);
    if (porFonte.length === 0) {
      console.log("  (nenhuma linha neste dia — o backfill correu?)");
      problemas++;
    }
    console.log(
      `  ${"farmacia".padEnd(22)}${"circuito".padEnd(26)}${"classe".padEnd(21)}` +
        `${"linhas".padStart(8)}${"unidades".padStart(12)}${"valor".padStart(14)}${"docs".padStart(7)}`,
    );
    for (const r of porFonte) {
      const circuito = r.sourceNamespace === NS_VSG ? "VSG (susp)" : "G (balcao)";
      console.log(
        `  ${r.farmacia.slice(0, 21).padEnd(22)}${circuito.padEnd(26)}` +
          `${r.tipoDocumentoClass.padEnd(21)}${String(r.linhas).padStart(8)}` +
          `${fmt(r.unidades, 0).padStart(12)}${fmt(r.valor).padStart(14)}` +
          `${String(r.documentos).padStart(7)}`,
      );
    }

    // ── 2. Os totais que têm de bater com o ERP ──────────────────
    const soma = (ns: string | null, classe: string | null) =>
      porFonte
        .filter((r) => (ns === null || r.sourceNamespace === ns))
        .filter((r) => (classe === null || r.tipoDocumentoClass === classe))
        .reduce((a, r) => a + n(r.unidades), 0);
    const somaValor = (ns: string | null, classe: string | null) =>
      porFonte
        .filter((r) => (ns === null || r.sourceNamespace === ns))
        .filter((r) => (classe === null || r.tipoDocumentoClass === classe))
        .reduce((a, r) => a + n(r.valor), 0);

    const unidadesG = soma(NS_G, "VENDA");
    const unidadesVSG = soma(NS_VSG, "VENDA");
    const reversoesG = soma(NS_G, "DEVOLUCAO_ANULACAO");
    const reversoesVSG = soma(NS_VSG, "DEVOLUCAO_ANULACAO");

    console.log("");
    console.log(RULE);
    console.log("2. O UNIVERSO CONTABILISTICO DO DIA");
    console.log(RULE);
    console.log(`  unidades G (venda)              ${fmt(unidadesG, 0).padStart(14)}`);
    console.log(`  unidades VSG (venda)            ${fmt(unidadesVSG, 0).padStart(14)}`);
    console.log(`  devolucoes/anulacoes            ${fmt(reversoesG + reversoesVSG, 0).padStart(14)}`);
    console.log(`    . pelo circuito G             ${fmt(reversoesG, 0).padStart(14)}`);
    console.log(`    . pelo circuito VSG           ${fmt(reversoesVSG, 0).padStart(14)}`);
    console.log(`  ${"─".repeat(46)}`);
    console.log(
      `  LIQUIDO G+VSG                   ${fmt(unidadesG + unidadesVSG + reversoesG + reversoesVSG, 0).padStart(14)}`,
    );
    console.log(`  valor bruto liquido (EUR)       ${fmt(somaValor(null, null)).padStart(14)}`);

    // O reader VSG não tem reversões próprias: as NC das VSG entram por
    // `[Atendimento Detalhe]`. Uma reversão no circuito VSG significa
    // que alguém declarou um tipo de reversão lá — e é dupla contagem.
    if (reversoesVSG !== 0) {
      console.log("");
      console.log("  ✗ HA REVERSOES NO CIRCUITO VSG.");
      console.log("    As NC das VSG entram por [Atendimento Detalhe], lidas pelo");
      console.log("    circuito G. Reversoes aqui significam a MESMA nota de credito");
      console.log("    subtraida duas vezes. Ver CLASSIFICACAO em vendas-fontes.ts.");
      problemas++;
    }

    // ── 3. Documentos por série ──────────────────────────────────
    const porSerie = await prisma.$queryRaw<
      Array<{ serie: string | null; tipoDocumento: number | null; docs: bigint; linhas: bigint }>
    >(Prisma.sql`
      SELECT r."serie", r."tipoDocumento",
             COUNT(DISTINCT r."externalSaleId") AS docs,
             COUNT(*) AS linhas
        FROM "IngestVendaLinhaRaw" r
       WHERE r."dataVenda" >= ${de} AND r."dataVenda" < ${ate}
       GROUP BY r."serie", r."tipoDocumento"
       ORDER BY r."serie", r."tipoDocumento"
    `);
    console.log("");
    console.log(RULE);
    console.log("3. DOCUMENTOS POR SERIE E TIPO");
    console.log(RULE);
    console.log(`  ${"serie".padEnd(12)}${"tipoDoc".padEnd(10)}${"docs".padStart(8)}${"linhas".padStart(9)}`);
    for (const r of porSerie) {
      console.log(
        `  ${(r.serie ?? "(nula)").padEnd(12)}${String(r.tipoDocumento ?? "-").padEnd(10)}` +
          `${String(r.docs).padStart(8)}${String(r.linhas).padStart(9)}`,
      );
    }

    // ── 4. Duplicados pela chave canónica ────────────────────────
    // A chave é `@@unique`, portanto a base não deixa duplicar. O que
    // isto apanha é o caso REAL: o mesmo documento contado duas vezes
    // por vir de dois namespaces — que é o modo de falha desta ronda.
    const dupsChave = await prisma.$queryRaw<Array<{ farmaciaId: string; ns: string; linha: number; n: bigint }>>(
      Prisma.sql`
        SELECT r."farmaciaId", r."sourceNamespace" AS ns, r."externalSaleLineId" AS linha, COUNT(*) AS n
          FROM "IngestVendaLinhaRaw" r
         WHERE r."dataVenda" >= ${de} AND r."dataVenda" < ${ate}
         GROUP BY r."farmaciaId", r."sourceNamespace", r."externalSaleLineId"
        HAVING COUNT(*) > 1
      `,
    );
    const dupsDocumento = await prisma.$queryRaw<
      Array<{ documento: string; namespaces: bigint; linhas: bigint }>
    >(Prisma.sql`
      SELECT r."documento",
             COUNT(DISTINCT r."sourceNamespace") AS namespaces,
             COUNT(*) AS linhas
        FROM "IngestVendaLinhaRaw" r
       WHERE r."dataVenda" >= ${de} AND r."dataVenda" < ${ate}
         AND r."documento" IS NOT NULL
       GROUP BY r."documento"
      HAVING COUNT(DISTINCT r."sourceNamespace") > 1
    `);
    console.log("");
    console.log(RULE);
    console.log("4. DUPLICADOS");
    console.log(RULE);
    console.log(`  pela chave canonica (farmacia, namespace, linha) : ${dupsChave.length}`);
    if (dupsChave.length > 0) {
      problemas++;
      for (const d of dupsChave.slice(0, 10)) {
        console.log(`    ✗ ${d.ns} linha ${d.linha} aparece ${d.n}x`);
      }
    }
    console.log(`  mesmo documento em DOIS circuitos                : ${dupsDocumento.length}`);
    if (dupsDocumento.length > 0) {
      problemas++;
      console.log("    ✗ o mesmo documento lido por duas fontes = dupla contagem");
      for (const d of dupsDocumento.slice(0, 10)) {
        console.log(`      ${d.documento}: ${d.namespaces} circuitos, ${d.linhas} linhas`);
      }
    }

    // ── 5. Os CNP conhecidos ─────────────────────────────────────
    //
    // A resolução é explícita e em três saltos, sem atalhos:
    //
    //     IngestVendaLinhaRaw."produtoId" → Produto."id" → Produto."cnp"
    //
    // O CNP não é o `produtoId` (cuid), nem o `externalProductId`
    // (CodigoID do ERP, um namespace local que pode ser reciclado). É a
    // identidade do catálogo, e é `Int`.
    //
    // A janela é a MESMA das secções 1/2 — o mesmo `dataVenda >= de AND
    // < ate`, sem restrição adicional. Uma linha do dia que aqui não
    // apareça tem de ter uma razão impressa, não desaparecer no JOIN.
    const listaCnp = alvos.map((c) => c.cnp);

    const detalhe = await prisma.$queryRaw<
      Array<{
        cnp: number;
        designacao: string | null;
        ns: string;
        classe: string;
        unidades: Prisma.Decimal | null;
        documentos: string | null;
      }>
    >(Prisma.sql`
      SELECT p."cnp", p."designacao", r."sourceNamespace" AS ns,
             r."tipoDocumentoClass" AS classe,
             SUM(${SQL_QUANTIDADE_ASSINADA}) AS unidades,
             STRING_AGG(DISTINCT r."documento", ', ') AS documentos
        FROM "IngestVendaLinhaRaw" r
        JOIN "Produto" p ON p."id" = r."produtoId"
       WHERE r."dataVenda" >= ${de} AND r."dataVenda" < ${ate}
         AND p."cnp" = ANY(${listaCnp}::int[])
       GROUP BY p."cnp", p."designacao", r."sourceNamespace", r."tipoDocumentoClass"
       ORDER BY p."cnp"
    `);

    // O CNP existe no catálogo? Distingue "produto desconhecido" de
    // "produto conhecido e não vendido" — dois zeros com causas
    // diferentes, que antes eram o mesmo `liquido=0`.
    const noCatalogo = await prisma.$queryRaw<Array<{ cnp: number; id: string }>>(Prisma.sql`
      SELECT "cnp", "id" FROM "Produto" WHERE "cnp" = ANY(${listaCnp}::int[])
    `);
    const idsConhecidos = new Set(noCatalogo.map((p) => p.cnp));

    // Linhas do dia que não chegam a ter produto resolvido. Não são
    // atribuíveis a CNP nenhum, e é isso que tem de ficar dito.
    const semProduto = await prisma.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`
      SELECT COUNT(*) AS n FROM "IngestVendaLinhaRaw"
       WHERE "dataVenda" >= ${de} AND "dataVenda" < ${ate} AND "produtoId" IS NULL
    `);

    const resumos = resumirPorCnp(
      detalhe.map((d) => ({
        cnp: Number(d.cnp),
        designacao: d.designacao,
        sourceNamespace: d.ns,
        classe: d.classe,
        unidades: n(d.unidades),
        documentos: d.documentos,
      })),
      alvos,
    );

    console.log("");
    console.log(RULE);
    console.log("5. OS CNP CONHECIDOS");
    console.log(RULE);
    console.log("  produtoId -> Produto.id -> Produto.cnp   (cnp e Int, nao string)");
    console.log("");
    console.log("  O GATE E SOBRE O CIRCUITO VSG, nao sobre o total do artigo.");
    console.log("  Estes CNP sao a populacao que faltava — as vendas suspensas.");
    console.log("  O mesmo artigo pode ter venda de balcao no mesmo dia, noutro");
    console.log("  documento e a outra hora: isso soma ao liquido e NAO e duplicacao.");
    const nSemProduto = Number(semProduto[0]?.n ?? 0);
    if (nSemProduto > 0) {
      console.log("");
      console.log(
        `  ⚠ ${nSemProduto} linha(s) do dia sem produtoId — nao atribuiveis a CNP nenhum`,
      );
    }
    console.log("");
    console.log(
      `  ${"CNP".padEnd(10)}${"designacao".padEnd(34)}${"VSG".padStart(6)}${"G".padStart(6)}` +
        `${"NC".padStart(6)}${"liquido".padStart(9)}   gate`,
    );
    for (const r of resumos) {
      const veredicto =
        r.bate === null ? "" : r.bate ? "OK" : `✗ VSG esperado ${r.esperadoVsg}`;
      if (r.bate === false) problemas++;
      console.log(
        `  ${String(r.cnp).padEnd(10)}${String(r.nome).slice(0, 33).padEnd(34)}` +
          `${fmt(r.vsg, 0).padStart(6)}${fmt(r.g, 0).padStart(6)}${fmt(r.reversoes, 0).padStart(6)}` +
          `${fmt(r.liquido, 0).padStart(9)}   ${veredicto}`,
      );
      if (r.linhas.length === 0) {
        console.log(
          idsConhecidos.has(r.cnp)
            ? "             (no catalogo, mas sem linhas de venda neste dia)"
            : "             (CNP nao existe em Produto — o catalogo nao o conhece)",
        );
      }
      for (const d of r.linhas) {
        const circuito = d.sourceNamespace === NS_VSG ? "VSG" : "G";
        console.log(
          `             ${circuito.padEnd(5)}${d.classe.padEnd(21)}` +
            `${fmt(d.unidades, 0).padStart(6)}  ${d.documentos ?? ""}`,
        );
      }
    }
    const gates = resumos.filter((r) => r.bate !== null);
    console.log("");
    console.log(
      `  gate VSG: ${gates.filter((r) => r.bate).length}/${gates.length} CNP com as ` +
        `unidades suspensas esperadas`,
    );

    // ── 6. Linhas por classificar ────────────────────────────────
    const naoElegiveis = await prisma.$queryRaw<Array<{ motivo: string; n: bigint }>>(Prisma.sql`
      SELECT CASE
               WHEN "tipoDocumentoClass" NOT IN ('VENDA', 'DEVOLUCAO_ANULACAO') THEN 'classe nao contabilizavel'
               WHEN "produtoId" IS NULL THEN 'sem produto resolvido'
               WHEN "isNonStockService" = true THEN 'servico sem stock'
               ELSE 'outro'
             END AS motivo,
             COUNT(*) AS n
        FROM "IngestVendaLinhaRaw"
       WHERE "dataVenda" >= ${de} AND "dataVenda" < ${ate}
         AND NOT (${SQL_LINHAS_ELEGIVEIS})
       GROUP BY 1
       ORDER BY 2 DESC
    `);
    console.log("");
    console.log(RULE);
    console.log("6. LINHAS QUE NAO ENTRAM NA SOMA");
    console.log(RULE);
    if (naoElegiveis.length === 0) console.log("  (nenhuma)");
    for (const r of naoElegiveis) {
      console.log(`  ${r.motivo.padEnd(34)}${String(r.n).padStart(8)}`);
    }

    console.log("");
    console.log(DOUBLE);
    if (problemas === 0) {
      console.log("SEM PROBLEMAS DETECTADOS AUTOMATICAMENTE.");
      console.log("Falta o passo que nenhum script faz: confrontar os numeros da");
      console.log("seccao 2 com o SPharm. Se baterem, a correccao esta fechada.");
    } else {
      console.log(`✗ ${problemas} PROBLEMA(S). NAO avancar para backfill historico.`);
    }
    console.log(DOUBLE);
  } finally {
    await prisma.$disconnect();
    await controlPrisma.$disconnect();
  }

  return problemas === 0 ? 0 : 1;
}

// Só corre quando é INVOCADO, não quando é importado.
//
// Sem esta guarda, importar o módulo para testar `resumirPorCnp` punha o
// CLI a arrancar: imprimia o "Uso:" e chamava `process.exit` a competir
// com o do teste. Um teste que morre com o exit code de outra coisa é um
// teste que às vezes passa.
// O separador no início não é decoração: sem ele, `test-reconciliar-dia.ts`
// também casa — e o teste voltava a arrancar o CLI.
if (/[\\/]reconciliar-dia\.(ts|js|mjs|cjs)$/.test(process.argv[1] ?? "")) {
  main()
    .then((c) => process.exit(c))
    .catch((err) => {
      console.error("✗", err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
