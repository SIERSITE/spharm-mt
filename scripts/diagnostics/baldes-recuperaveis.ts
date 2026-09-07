/**
 * scripts/diagnostics/baldes-recuperaveis.ts
 *
 * Os 2 746 produtos em "Outros X": quantos saem de lá sem gastar um
 * cêntimo de IA, e porque é que os outros não saem.
 *
 * READ-ONLY sem excepção: sessão PostgreSQL em read-only, sem `--apply`,
 * sem chamadas ao modelo, sem tocar na cache nem na fila.
 *
 * ── Porque é que estes não foram apanhados pelo reprocessamento ──────
 *
 * Duas razões, e são diferentes uma da outra:
 *
 *   1. `corpoResidual` exclui do residual quem já tem linha de cache para
 *      a versão e o modelo actuais. É a idempotência a funcionar — mas
 *      significa que um produto em "Outros X" com cache NUNCA volta a ser
 *      perguntado enquanto `KNOWLEDGE_VERSION` e `KNOWLEDGE_MODEL` não
 *      mudarem. O scheduler não os vai resolver sozinho.
 *
 *   2. `reavaliar-cache-classificacao` só considera candidatas as linhas
 *      com `persistido = false`. E um produto que está em "Outros X"
 *      PORQUE o enriquecimento o escreveu lá tem `persistido = true` — a
 *      escrita correu bem, o valor escrito é que é um balde. Esses são
 *      invisíveis aos dois caminhos.
 *
 * A segunda é a que este diagnóstico existe sobretudo para medir. Por
 * isso NÃO filtra por `persistido`: olha para todas as linhas de cache
 * dos produtos que estão hoje num balde.
 *
 * ── A causa é única por produto ─────────────────────────────────────
 *
 * Por precedência, e a ordem responde a "o que teria de mudar primeiro".
 * `G` vem antes de `A` de propósito: uma proposta específica e confiante
 * que o gate recusa por outro critério não é recuperável, e contá-la em
 * `A` inflacionava o número que se vai usar para decidir.
 *
 * Uso:
 *   npx tsx scripts/diagnostics/baldes-recuperaveis.ts --tenant=silveira
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";
import { buildTenantConnectionString, getTenantBySlug } from "../../lib/control-plane";
import { AlvoRecusado, descreverAlvo, resolverAlvo } from "../../lib/catalog/target-db";
import { MIN_CNP_CATALOGAVEL } from "../../lib/catalog/cnp-catalogavel";
import {
  KNOWLEDGE_MODEL,
  KNOWLEDGE_VERSION,
  LIMIAR_PERSISTENCIA,
  avaliarGate,
  precisaVerificacao,
  type EvidenceType,
  type KnowledgeResult,
} from "../../lib/catalog/knowledge-enrichment";
import { ehBalde } from "../../lib/catalog/classificacao-coerencia";

const nf = (n: number) => n.toLocaleString("pt-PT");
const pad = (n: number | string, w = 7) => String(nf(Number(n) || 0)).padStart(w);
const padT = (s: string, w: number) => s.padEnd(w).slice(0, w);
const linha = (s = "") => console.log(s);
const titulo = (t: string) => {
  linha("");
  linha("═".repeat(84));
  linha(`  ${t}`);
  linha("═".repeat(84));
};
const pct = (n: number, t: number) => (t > 0 ? `${((n / t) * 100).toFixed(1)}%`.padStart(6) : "     —");

type Linha = {
  cnp: number;
  designacao: string;
  productType: string | null;
  n1: string | null;
  n2: string | null;
  classEstado: string | null;
  manual: boolean;
  temCache: boolean;
  persistido: boolean | null;
  evidenceType: string | null;
  categoria: string | null;
  subcategoria: string | null;
  categoriaBruta: string | null;
  subcategoriaBruta: string | null;
  confidence: number | null;
  motivo: string | null;
  reavaliadoVersao: string | null;
  cacheVersao: string | null;
  cacheModelo: string | null;
};

/** Reconstrói o resultado do modelo tal como o reprocessamento o faria. */
function reconstruir(l: Linha): KnowledgeResult {
  return {
    cnp: l.cnp,
    productType: null,
    categoria: l.categoria,
    subcategoria: l.subcategoria,
    forma: null,
    dci: null,
    codigoATC: null,
    dosagem: null,
    embalagem: null,
    utilizacoes: [],
    confidence: Number(l.confidence ?? 0),
    confidenceClinica: 0,
    evidenceType: (l.evidenceType ?? "DESCONHECIDO") as EvidenceType,
    rationale: "",
    categoriaBruta: l.categoriaBruta,
    subcategoriaBruta: l.subcategoriaBruta,
    motivoPar: null,
    alvo: "CLASSIFICACAO",
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  linha("SPharm.MT · baldes recuperaveis · diagnostico read-only");

  let alvo;
  try {
    alvo = await resolverAlvo(argv, { getTenantBySlug, buildTenantConnectionString });
  } catch (err) {
    if (err instanceof AlvoRecusado) {
      console.error(`\n${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }
  if (!alvo.tenant) {
    console.error("\nEste diagnóstico precisa de --tenant=<slug>.\n");
    process.exit(2);
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: alvo.url }) });
  await prisma.$executeRawUnsafe("set session default_transaction_read_only = on");

  linha("═".repeat(84));
  linha(`  ${descreverAlvo(alvo)}`);
  linha(`  versão/modelo em uso: ${KNOWLEDGE_VERSION} / ${KNOWLEDGE_MODEL}   limiar ${LIMIAR_PERSISTENCIA}`);
  linha("═".repeat(84));

  const rows = await prisma.$queryRawUnsafe<Linha[]>(`
    select p.cnp,
           p.designacao,
           p."productType"                as "productType",
           c1.nome                        as n1,
           c2.nome                        as n2,
           p."classificacaoEstado"::text  as "classEstado",
           p."validadoManualmente"        as manual,
           (k.chave is not null)          as "temCache",
           k.persistido,
           k."evidenceType"               as "evidenceType",
           k.categoria,
           k.subcategoria,
           k."categoriaBruta"             as "categoriaBruta",
           k."subcategoriaBruta"          as "subcategoriaBruta",
           k.confidence,
           k.motivo,
           k."reavaliadoVersao"           as "reavaliadoVersao",
           k.versao                       as "cacheVersao",
           k.modelo                       as "cacheModelo"
      from "Produto" p
      join "Classificacao" c2 on c2.id = p."classificacaoNivel2Id"
      left join "Classificacao" c1 on c1.id = p."classificacaoNivel1Id"
      left join lateral (
        select * from "KnowledgeEnrichmentCache" kk
         where kk.cnp = p.cnp order by kk."criadoEm" desc limit 1
      ) k on true
     where p.estado <> 'INATIVO'
       and p.cnp > ${MIN_CNP_CATALOGAVEL}
       and c2.nome ilike 'Outros %'
     order by p.cnp
  `);

  const TOTAL = rows.length;

  // ══════════════════════════════════════════════════════════════════
  // PARTE 1 · Distribuição por nível 1
  // ══════════════════════════════════════════════════════════════════
  titulo("PARTE 1 · Onde vivem os baldes");

  const porN1 = new Map<string, number>();
  for (const r of rows) {
    const k = r.n1 ?? "(sem nível 1)";
    porN1.set(k, (porN1.get(k) ?? 0) + 1);
  }
  linha("");
  linha(`  produtos catalogáveis em "Outros X" .... ${pad(TOTAL)}`);
  linha("");
  linha(`  ${padT("nível 1", 44)} ${"nº".padStart(7)} ${"%".padStart(7)}`);
  linha(`  ${"─".repeat(60)}`);
  const top = [...porN1.entries()].sort((a, b) => b[1] - a[1]);
  for (const [k, v] of top.slice(0, 20)) {
    linha(`  ${padT(k, 44)} ${pad(v)} ${pct(v, TOTAL)}`);
  }
  if (top.length > 20) {
    const resto = top.slice(20).reduce((a, [, v]) => a + v, 0);
    linha(`  ${padT(`(mais ${top.length - 20} famílias)`, 44)} ${pad(resto)} ${pct(resto, TOTAL)}`);
  }

  // ══════════════════════════════════════════════════════════════════
  // PARTE 2 · Estado actual — quem os pôs ali
  // ══════════════════════════════════════════════════════════════════
  titulo("PARTE 2 · Proveniência dos que estão em baldes");

  const est = { MANUAL: 0, CANONICA: 0, PROVISORIA: 0, AUSENTE: 0, OUTRO: 0 };
  for (const r of rows) {
    if (r.manual) est.MANUAL++;
    else if (r.classEstado === "CANONICA") est.CANONICA++;
    else if (r.classEstado === "PROVISORIA") est.PROVISORIA++;
    else if (r.classEstado === "AUSENTE") est.AUSENTE++;
    else est.OUTRO++;
  }
  linha("");
  for (const [k, v] of Object.entries(est)) {
    if (v === 0 && k === "OUTRO") continue;
    linha(`  ${padT(k, 44)} ${pad(v)} ${pct(v, TOTAL)}`);
  }
  linha("");
  linha("  MANUAL num balde é o caso a olhar primeiro: alguém escolheu");
  linha("  deliberadamente \"Outros X\", e essa decisão não se toca.");
  linha("  AUSENTE com nível 2 é incoerente — nível 2 sem nível 1.");

  // ══════════════════════════════════════════════════════════════════
  // PARTE 3 · A causa, uma por produto
  // ══════════════════════════════════════════════════════════════════
  titulo("PARTE 3 · Porque continuam em \"Outros X\"");

  const CAUSAS = [
    ["F", "sem cache — nunca foi perguntado"],
    ["D", "cache DESCONHECIDO — o modelo não reconheceu"],
    ["E", "par fora da taxonomia — respondeu, não coube"],
    ["C", "a proposta é ela própria um balde"],
    ["B", `proposta específica, confiança < ${LIMIAR_PERSISTENCIA}`],
    ["G", "proposta específica e confiante, gate recusa por outro critério"],
    ["A", "proposta específica que o gate ACEITA — recuperável"],
    ["H", "outro — investigar"],
  ] as const;

  const conta = new Map<string, number>(CAUSAS.map(([k]) => [k, 0]));
  const semReavaliar = new Map<string, number>(CAUSAS.map(([k]) => [k, 0]));
  const persistidoTrue = new Map<string, number>(CAUSAS.map(([k]) => [k, 0]));
  const motivosG = new Map<string, number>();
  const recuperaveis: Array<Linha & { proposta: string; provisorio: boolean }> = [];

  const causaDe = (r: Linha): string => {
    if (r.manual) return "H"; // decisão humana — fora de discussão
    if (!r.temCache) return "F";
    if (r.evidenceType === "DESCONHECIDO") return "D";
    if (!r.categoria || !r.subcategoria) return "E";
    if (ehBalde(r.subcategoria)) return "C";
    if (Number(r.confidence ?? 0) < LIMIAR_PERSISTENCIA) return "B";

    // Daqui para baixo há uma proposta específica e confiante. Quem decide
    // é o GATE, e é o mesmo `avaliarGate` que a escrita usaria — não uma
    // reimplementação das suas condições, que divergiria.
    const res = reconstruir(r);
    const exigeVerificacao = precisaVerificacao(res);
    const gate = avaliarGate(
      res,
      { categoria: r.n1, subcategoria: r.n2, productType: r.productType },
      exigeVerificacao ? { concorda: false, aplicavel: true } : { concorda: true, aplicavel: false },
    );
    if (gate.decisao === "APPLY" && gate.gravarCategoria) {
      recuperaveis.push({
        ...r,
        proposta: `${r.categoria} > ${r.subcategoria}`,
        provisorio: gate.provisorio,
      });
      return "A";
    }
    const m = exigeVerificacao
      ? "verificação clínica não reconstruível da cache"
      : gate.motivo;
    motivosG.set(m, (motivosG.get(m) ?? 0) + 1);
    return "G";
  };

  for (const r of rows) {
    const k = causaDe(r);
    conta.set(k, (conta.get(k) ?? 0) + 1);
    if (r.temCache && !r.reavaliadoVersao) semReavaliar.set(k, (semReavaliar.get(k) ?? 0) + 1);
    if (r.persistido === true) persistidoTrue.set(k, (persistidoTrue.get(k) ?? 0) + 1);
  }

  linha("");
  linha(`  ${padT("causa principal", 54)} ${"nº".padStart(7)} ${"%".padStart(7)} ${"persist.".padStart(9)} ${"s/reav.".padStart(8)}`);
  linha(`  ${"─".repeat(90)}`);
  let soma = 0;
  for (const [k, desc] of CAUSAS) {
    const v = conta.get(k) ?? 0;
    soma += v;
    linha(
      `  ${k}  ${padT(desc, 51)} ${pad(v)} ${pct(v, TOTAL)} ${pad(persistidoTrue.get(k) ?? 0, 9)} ${pad(semReavaliar.get(k) ?? 0, 8)}`,
    );
  }
  linha(`  ${"─".repeat(90)}`);
  linha(`  ${padT("TOTAL", 54)} ${pad(soma)} ${pct(soma, TOTAL)}`);
  linha(
    `  soma fecha com o universo: ${soma === TOTAL ? "✓ sim" : `!! NÃO (${nf(soma)} ≠ ${nf(TOTAL)})`}`,
  );
  linha("");
  linha("  «persist.» = a linha de cache diz `persistido = true`. São os que o");
  linha("  reprocessamento NÃO vê: `reavaliar-cache-classificacao` só considera");
  linha("  candidatas as linhas com `persistido = false`. Um produto que está no");
  linha("  balde PORQUE o enriquecimento o escreveu lá cai exactamente aqui.");
  linha("");
  linha("  «s/reav.» = tem cache e o reprocessamento nunca lhe tocou.");

  if (motivosG.size > 0) {
    linha("");
    linha("  ── G, em detalhe: o que o gate diz ──────────────────────────");
    for (const [m, v] of [...motivosG.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      linha(`  ${pad(v)}  ${m}`);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // PARTE 4 · Amostra dos recuperáveis
  // ══════════════════════════════════════════════════════════════════
  titulo("PARTE 4 · Amostra de 30 recuperáveis");

  if (recuperaveis.length === 0) {
    linha("");
    linha("  Nenhum. Os baldes que restam não têm proposta melhor em cache.");
  } else {
    // Ordenados por confiança decrescente: se alguém só olhar para dez,
    // que sejam os dez que mais depressa se confirmam.
    const amostra = [...recuperaveis]
      .sort((a, b) => Number(b.confidence ?? 0) - Number(a.confidence ?? 0))
      .slice(0, 30);
    linha("");
    linha(
      `  ${padT("cnp", 9)} ${padT("designação", 30)} ${padT("actual", 26)} ${padT("proposta", 30)} ${"conf".padStart(5)} ${padT("evidência", 20)}`,
    );
    linha(`  ${"─".repeat(126)}`);
    for (const r of amostra) {
      linha(
        `  ${padT(String(r.cnp), 9)} ${padT(r.designacao, 30)} ${padT(`${r.n1} > ${r.n2}`, 26)} ` +
          `${padT(r.proposta, 30)} ${(Number(r.confidence ?? 0)).toFixed(2).padStart(5)} ` +
          `${padT(r.evidenceType ?? "—", 20)}`,
      );
    }
    linha("");
    linha("  Todos estes estão em \"Outros X\" por uma razão só: o gate antigo");
    linha("  recusava `CATEGORIA_PRODUTO`, e o reprocessamento não os viu porque");
    linha("  a linha de cache diz `persistido = true` — a escrita correu bem, o");
    linha("  valor escrito é que era um balde.");
    const prov = recuperaveis.filter((r) => r.provisorio).length;
    linha("");
    linha(`  dos ${nf(recuperaveis.length)} recuperáveis: ${nf(recuperaveis.length - prov)} entrariam CANONICA, ${nf(prov)} PROVISORIA`);
  }

  // ══════════════════════════════════════════════════════════════════
  // PARTE 5 · O que o scheduler resolve sozinho
  // ══════════════════════════════════════════════════════════════════
  titulo("PARTE 5 · O scheduler resolve algum destes?");

  const comCacheActual = rows.filter(
    (r) => r.cacheVersao === KNOWLEDGE_VERSION && r.cacheModelo === KNOWLEDGE_MODEL,
  ).length;
  const semCacheActual = TOTAL - comCacheActual;

  linha("");
  linha(`  com cache da versão+modelo actuais ..... ${pad(comCacheActual)}  ${pct(comCacheActual, TOTAL)}`);
  linha(`  sem ela (voltam ao residual) ........... ${pad(semCacheActual)}  ${pct(semCacheActual, TOTAL)}`);
  linha("");
  linha("  `corpoResidual` exclui quem já tem linha de cache para a versão e o");
  linha("  modelo em uso. É a idempotência a funcionar — e significa que os");
  linha(`  ${nf(comCacheActual)} de cima NUNCA voltam a ser perguntados enquanto`);
  linha(`  KNOWLEDGE_VERSION (${KNOWLEDGE_VERSION}) e KNOWLEDGE_MODEL não mudarem.`);
  linha("");
  linha("  ⇒ o scheduler NÃO os resolve. Ou se reprocessa a cache, ou ficam.");

  // ══════════════════════════════════════════════════════════════════
  // PARTE 6 · Simulação
  // ══════════════════════════════════════════════════════════════════
  titulo("PARTE 6 · Simulação — o catálogo depois");

  const [tot] = await prisma.$queryRawUnsafe<Array<Record<string, bigint>>>(`
    select count(*) as n from "Produto" p
     where p.estado <> 'INATIVO' and p.cnp > ${MIN_CNP_CATALOGAVEL}
  `);
  const catalogaveis = Number(tot?.n ?? 0);
  const rec = recuperaveis.length;
  const resta = TOTAL - rec;

  linha("");
  linha(`  catalogáveis ........................... ${pad(catalogaveis)}`);
  linha(`  em "Outros X" agora .................... ${pad(TOTAL)}  ${pct(TOTAL, catalogaveis)}`);
  linha(`  recuperáveis sem IA .................... ${pad(rec)}  ${pct(rec, TOTAL)} dos baldes`);
  linha(`  restariam em "Outros X" ................ ${pad(resta)}  ${pct(resta, catalogaveis)} do catálogo`);
  linha("");
  linha(`  custo em IA: ZERO. As respostas já foram pagas e estão em cache.`);
  linha("");
  linha("  O que NÃO se resolve com cache: as causas D, E e F —");
  linha(
    `  ${nf((conta.get("D") ?? 0) + (conta.get("E") ?? 0) + (conta.get("F") ?? 0))} produtos que precisariam de uma pergunta nova, e a`,
  );
  linha("  pergunta nova só muda de resposta se o prompt ou o modelo mudarem.");

  await prisma.$disconnect();
  linha("");
  linha("Fim. Nada foi escrito: sessão read-only, sem --apply, sem chamadas ao modelo.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
