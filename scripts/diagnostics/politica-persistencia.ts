/**
 * scripts/diagnostics/politica-persistencia.ts
 *
 * Diagnóstico READ-ONLY da POLÍTICA DE PERSISTÊNCIA da classificação.
 * Não escreve, não persiste, não corre enrichment, não altera limiares
 * nem taxonomia. Simula — e imprime o que teria acontecido.
 *
 * ══════════════════════════════════════════════════════════════════════
 * A REGRA SOB AUDITORIA
 * ══════════════════════════════════════════════════════════════════════
 *
 * `lib/catalog/knowledge-enrichment.ts:1262`:
 *
 *     export const EVIDENCIA_PERMITIDA = new Set([
 *       "MARCA_CONHECIDA",
 *       "SUBSTANCIA_CONHECIDA",
 *     ]);
 *
 * `CATEGORIA_PRODUTO` está de fora. A justificação está escrita, e é um
 * argumento a sério — não um resto histórico:
 *
 *     "é a evidência que o modelo dá quando deduziu pela forma ou por
 *      parte do nome — exactamente o tipo de raciocínio que as regras
 *      determinísticas já fazem melhor e de graça. Se chegou aqui é
 *      porque as regras não conseguiram; uma dedução do modelo sobre o
 *      mesmo texto não é sinal novo, é o mesmo sinal com mais passos.
 *      Vai para revisão."
 *
 * ══════════════════════════════════════════════════════════════════════
 * DUAS PREMISSAS QUE ESTE FICHEIRO PÕE À PROVA
 * ══════════════════════════════════════════════════════════════════════
 *
 * **"as regras determinísticas já fazem melhor"** — para esta população,
 * as regras não fizeram melhor: não fizeram nada. Estes produtos estão
 * Por Classificar. A alternativa à dedução do modelo não é a resposta das
 * regras; é a ausência de resposta. O argumento compara com um
 * concorrente que não apareceu.
 *
 * **"vai para revisão"** — não vai. O `REVIEW` do enriquecimento por
 * conhecimento é gravado em `KnowledgeEnrichmentCache` com
 * `persistido=false`, e mais nada. `FilaRevisao` é populada por outro
 * caminho (`lib/catalog-enrichment.ts:398`), o dos conectores. E o
 * comentário de `gravarCache` diz para que serve o registo:
 *
 *     "guardar os REVIEW é o que impede o job de voltar a perguntar
 *      todos os dias por produtos que já se sabe que não passam o gate"
 *
 * É um registo de SUPRESSÃO, não uma fila de trabalho. Na prática, o
 * produto não vai a lado nenhum — fica por classificar e deixa de ser
 * perguntado.
 *
 * Nada disto torna a regra errada. Torna-a testável, e é o que se faz
 * abaixo: contar quantas propostas recusadas passariam por cada critério
 * de segurança, com três limiares, e mostrar exemplos para se poder
 * julgar em vez de acreditar.
 *
 *   npx tsx scripts/diagnostics/politica-persistencia.ts --tenant=silveira
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "../../generated/prisma/client";
import { buildTenantConnectionString, getTenantBySlug } from "../../lib/control-plane";
import { AlvoRecusado, descreverAlvo, resolverAlvo } from "../../lib/catalog/target-db";
import {
  EVIDENCIA_PERMITIDA,
  KNOWLEDGE_VERSION,
  LIMIAR_PERSISTENCIA,
} from "../../lib/catalog/knowledge-enrichment";
import { isValidNivel2 } from "../../lib/catalog-taxonomy";
import { MIN_CNP } from "../../lib/catalog/knowledge-enrichment-runner";

const linha = (t = "") => console.log(t);
const nf = (n: number) => n.toLocaleString("pt-PT");
const pct = (n: number, total: number) =>
  total > 0 ? `${((n / total) * 100).toFixed(1)}%` : "—";
const col = (n: number, total: number, w = 8) =>
  `${String(nf(n)).padStart(w)}  ${pct(n, total).padStart(6)}`;

function titulo(t: string) {
  linha("");
  linha("═".repeat(78));
  linha(t);
  linha("═".repeat(78));
}
const corta = (s: string | null, n: number) => {
  const v = (s ?? "").replace(/\s+/g, " ").trim();
  return v.length > n ? `${v.slice(0, n - 1)}…` : v.padEnd(n);
};

/**
 * O productType do produto e a categoria proposta contradizem-se?
 *
 * "Contradição FORTE" e não "diferença": um SUPLEMENTO proposto para
 * MEDICAMENTOS é uma troca de estatuto regulamentar. Um DERMOCOSMETICA
 * proposto para HIGIENE CORPORAL é uma fronteira comercial, e discordar
 * dela não é sinal de erro.
 */
const FAMILIA_DE_TIPO: Record<string, string> = {
  MEDICAMENTO: "MEDICAMENTOS",
  SUPLEMENTO: "SUPLEMENTOS ALIMENTARES",
  DISPOSITIVO_MEDICO: "DISPOSITIVOS MÉDICOS",
  VETERINARIA: "VETERINÁRIA",
};
function contradicaoForte(productType: string | null, categoria: string | null): boolean {
  if (!productType || !categoria) return false;
  const esperada = FAMILIA_DE_TIPO[productType];
  if (!esperada) return false; // tipos "moles" não geram contradição
  const propostaEhForte = Object.values(FAMILIA_DE_TIPO).includes(categoria);
  if (!propostaEhForte) return false; // proposta fora do grupo forte: não é contradição
  return esperada !== categoria;
}

// ─────────────────────────────────────────────────────────────────────
type Linha = {
  cnp: number;
  designacao: string;
  productType: string | null;
  nivel1: string | null;
  nivel2: string | null;
  cCategoria: string | null;
  cSubcategoria: string | null;
  cProductType: string | null;
  cConfidence: number;
  cEvidence: string;
  cMotivo: string | null;
  cRationale: string | null;
  cAtc: string | null;
  validadoManualmente: boolean;
  naFila: boolean;
  temCache: boolean;
};

async function carregar(prisma: PrismaClient): Promise<Linha[]> {
  return prisma.$queryRaw<Linha[]>(Prisma.sql`
    SELECT
      p.cnp, p.designacao,
      p."productType"          AS "productType",
      c1.nome                  AS nivel1,
      c2.nome                  AS nivel2,
      p."validadoManualmente"  AS "validadoManualmente",
      k.categoria              AS "cCategoria",
      k.subcategoria           AS "cSubcategoria",
      k."productType"          AS "cProductType",
      COALESCE(k.confidence, 0) AS "cConfidence",
      COALESCE(k."evidenceType", '') AS "cEvidence",
      k.motivo                 AS "cMotivo",
      k.rationale              AS "cRationale",
      k."codigoATC"            AS "cAtc",
      (k.chave IS NOT NULL)    AS "temCache",
      EXISTS (SELECT 1 FROM "EnriquecimentoFila" f WHERE f."produtoId" = p.id) AS "naFila"
    FROM "Produto" p
    LEFT JOIN "Classificacao" c1 ON c1.id = p."classificacaoNivel1Id"
    LEFT JOIN "Classificacao" c2 ON c2.id = p."classificacaoNivel2Id"
    LEFT JOIN LATERAL (
      SELECT * FROM "KnowledgeEnrichmentCache" kk
      WHERE kk.cnp = p.cnp ORDER BY kk."criadoEm" DESC LIMIT 1
    ) k ON true
  `);
}

const ehBalde = (n: string | null) => !!n && /^outros\b/i.test(n);
const semClass = (r: Linha) => !r.nivel1 && !r.nivel2;

/** Os cinco critérios da política simulada, cada um em separado. */
type Criterio = {
  parValido: boolean;
  especifica: boolean;
  tipoCoerente: boolean;
  semConflito: boolean;
  confianca: (limiar: number) => boolean;
};
function criteriosDe(r: Linha): Criterio {
  const parValido = !!r.cCategoria && !!r.cSubcategoria && isValidNivel2(r.cCategoria, r.cSubcategoria);
  return {
    parValido,
    especifica: !!r.cSubcategoria && !ehBalde(r.cSubcategoria),
    tipoCoerente: !contradicaoForte(r.productType, r.cCategoria),
    // Sem conflito: o produto não tem já uma classificação ESPECÍFICA.
    // É a mesma doutrina do gate actual (`eraFallback`) — uma proposta
    // nunca substitui uma classificação específica que já lá esteja.
    semConflito: semClass(r) || ehBalde(r.nivel2),
    confianca: (l: number) => r.cConfidence >= l,
  };
}
function passaria(r: Linha, limiar: number): boolean {
  const c = criteriosDe(r);
  return c.parValido && c.especifica && c.tipoCoerente && c.semConflito && c.confianca(limiar);
}

// ═════════════════════════════════════════════════════════════════════
async function principal() {
  linha("SPharm.MT · política de persistência da classificação · read-only");
  linha("");

  let alvo;
  try {
    alvo = await resolverAlvo(process.argv.slice(2), {
      getTenantBySlug,
      buildTenantConnectionString,
    });
  } catch (e) {
    if (e instanceof AlvoRecusado) {
      linha(`ERRO: ${e.message}`);
      linha("");
      linha("Uso: npx tsx scripts/diagnostics/politica-persistencia.ts --tenant=<slug>");
      process.exit(2);
    }
    throw e;
  }
  linha(`Alvo: ${descreverAlvo(alvo)}`);
  linha("");
  linha(`Evidências que HOJE autorizam escrita: ${[...EVIDENCIA_PERMITIDA].join(", ")}`);
  linha(`Limiar de persistência: ${LIMIAR_PERSISTENCIA} · versão de conhecimento: ${KNOWLEDGE_VERSION}`);

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: alvo.url }) });

  try {
    const rows = await carregar(prisma);
    // A população em causa: tem proposta na cache, não foi persistida, e
    // o produto continua sem classificação útil.
    const recusadosPorClass = rows.filter(
      (r) => r.temCache && semClass(r) && !!r.cCategoria && !!r.cSubcategoria,
    );
    const recusadosBalde = rows.filter(
      (r) => r.temCache && ehBalde(r.nivel2) && !!r.cCategoria && !!r.cSubcategoria,
    );
    const alvoTotal = [...recusadosPorClass, ...recusadosBalde];

    // ══════════════════════════════════════════════════════════════════
    titulo("PARTE 1 · A população recusada");
    linha("");
    linha(`  Por Classificar com proposta na cache .... ${nf(recusadosPorClass.length)}`);
    linha(`  Em "Outros <X>" com proposta na cache .... ${nf(recusadosBalde.length)}`);
    linha(`  TOTAL a auditar .......................... ${nf(alvoTotal.length)}`);

    const porEvidencia = new Map<string, number>();
    for (const r of alvoTotal) porEvidencia.set(r.cEvidence, (porEvidencia.get(r.cEvidence) ?? 0) + 1);
    linha("");
    linha("  Por evidenceType:");
    for (const [e, n] of Array.from(porEvidencia.entries()).sort((a, b) => b[1] - a[1])) {
      const autoriza = EVIDENCIA_PERMITIDA.has(e as never) ? "autoriza" : "NÃO autoriza";
      linha(`    ${e.padEnd(24)} ${col(n, alvoTotal.length)}   ${autoriza}`);
    }

    const bandas = [
      ["0,85–0,89", 0.85, 0.9],
      ["0,90–0,94", 0.9, 0.95],
      [">= 0,95", 0.95, 1.01],
      ["< 0,85", 0, 0.85],
    ] as const;
    linha("");
    linha("  Por confiança:");
    for (const [rot, lo, hi] of bandas) {
      const n = alvoTotal.filter((r) => r.cConfidence >= lo && r.cConfidence < hi).length;
      linha(`    ${rot.padEnd(12)} ${col(n, alvoTotal.length)}`);
    }

    linha("");
    linha("  Motivos exactos de recusa (12 mais frequentes):");
    const motivos = new Map<string, number>();
    for (const r of alvoTotal) {
      const m = (r.cMotivo ?? "(sem motivo)").replace(/\d+[.,]\d+/g, "N");
      motivos.set(m, (motivos.get(m) ?? 0) + 1);
    }
    for (const [m, n] of Array.from(motivos.entries()).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
      linha(`    ${String(nf(n)).padStart(7)}  ${pct(n, alvoTotal.length).padStart(6)}  ${corta(m, 50)}`);
    }

    linha("");
    linha("  Famílias e categorias mais propostas:");
    const fams = new Map<string, number>();
    for (const r of alvoTotal) fams.set(r.cCategoria ?? "—", (fams.get(r.cCategoria ?? "—") ?? 0) + 1);
    for (const [f, n] of Array.from(fams.entries()).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
      linha(`    ${corta(f, 34)} ${col(n, alvoTotal.length)}`);
    }

    // ══════════════════════════════════════════════════════════════════
    titulo("PARTE 2 · Os critérios de segurança, um a um");
    linha("");
    linha("  Cada critério medido SOZINHO sobre a população recusada. É o");
    linha("  que permite ver qual deles é que corta, em vez de olhar só");
    linha("  para o total no fim.");
    linha("");
    const c = alvoTotal.map(criteriosDe);
    linha(`  par válido na taxonomia .................. ${col(c.filter((x) => x.parValido).length, alvoTotal.length)}`);
    linha(`  subcategoria ESPECÍFICA (não "Outros") ... ${col(c.filter((x) => x.especifica).length, alvoTotal.length)}`);
    linha(`  productType sem contradição forte ........ ${col(c.filter((x) => x.tipoCoerente).length, alvoTotal.length)}`);
    linha(`  sem conflito com classificação específica  ${col(c.filter((x) => x.semConflito).length, alvoTotal.length)}`);
    linha(`  confiança >= ${LIMIAR_PERSISTENCIA} ......................... ${col(alvoTotal.filter((r) => r.cConfidence >= LIMIAR_PERSISTENCIA).length, alvoTotal.length)}`);

    // ══════════════════════════════════════════════════════════════════
    titulo("PARTE 3 · Simulação — três limiares");
    linha("");
    linha("  Política simulada: CATEGORIA_PRODUTO passa a autorizar escrita");
    linha("  QUANDO os cinco critérios acima se verificam ao mesmo tempo.");
    linha("");
    linha("  LIMIAR    RECUPERADOS      CONTINUAM RECUSADOS     dos quais Por Classificar");
    linha("  " + "─".repeat(74));
    for (const l of [0.85, 0.9, 0.95]) {
      const rec = alvoTotal.filter((r) => passaria(r, l));
      const recPorClass = rec.filter(semClass);
      linha(
        `  >= ${l.toFixed(2)}  ${col(rec.length, alvoTotal.length)}   ` +
          `${col(alvoTotal.length - rec.length, alvoTotal.length)}   ` +
          `${String(nf(recPorClass.length)).padStart(8)}`,
      );
    }

    linha("");
    linha("  Porque é que os NÃO recuperados falham (limiar 0,85):");
    const naoRec = alvoTotal.filter((r) => !passaria(r, 0.85));
    const falha = { par: 0, esp: 0, tipo: 0, conf: 0, conflito: 0 };
    for (const r of naoRec) {
      const x = criteriosDe(r);
      if (!x.parValido) falha.par++;
      if (!x.especifica) falha.esp++;
      if (!x.tipoCoerente) falha.tipo++;
      if (!x.semConflito) falha.conflito++;
      if (!x.confianca(0.85)) falha.conf++;
    }
    linha(`    par inválido na taxonomia .............. ${col(falha.par, naoRec.length)}`);
    linha(`    subcategoria é "Outros <X>" ............ ${col(falha.esp, naoRec.length)}`);
    linha(`    contradição forte de productType ....... ${col(falha.tipo, naoRec.length)}`);
    linha(`    já tem classificação específica ........ ${col(falha.conflito, naoRec.length)}`);
    linha(`    confiança < 0,85 ....................... ${col(falha.conf, naoRec.length)}`);

    // ══════════════════════════════════════════════════════════════════
    titulo("PARTE 4 · Amostra de 100, estratificada por confiança e família");

    // Estratificação real: distribui as 100 pelas bandas de confiança na
    // proporção em que existem, e dentro de cada banda percorre famílias
    // à vez. Cem exemplos todos da mesma banda e do mesmo laboratório
    // não permitiriam julgar nada.
    const recuperaveis = alvoTotal.filter((r) => passaria(r, 0.85));
    const amostra: Linha[] = [];
    for (const [rot, lo, hi] of bandas.slice(0, 3)) {
      const banda = recuperaveis.filter((r) => r.cConfidence >= lo && r.cConfidence < hi);
      const quota = Math.round((banda.length / Math.max(1, recuperaveis.length)) * 100);
      // Percorre famílias à vez (round-robin) para não trazer 30 do mesmo sítio.
      const porFam = new Map<string, Linha[]>();
      for (const r of banda.slice().sort((a, b) => a.cnp - b.cnp)) {
        const k = r.cCategoria ?? "—";
        if (!porFam.has(k)) porFam.set(k, []);
        porFam.get(k)!.push(r);
      }
      const filas = [...porFam.values()];
      let i = 0;
      while (amostra.filter((x) => x.cConfidence >= lo && x.cConfidence < hi).length < quota) {
        const f = filas[i % Math.max(1, filas.length)];
        if (!f || f.length === 0) {
          if (filas.every((x) => x.length === 0)) break;
        } else {
          amostra.push(f.shift()!);
        }
        i++;
        if (i > 5000) break;
      }
      linha("");
      linha(`  ─── banda ${rot} · ${nf(banda.length)} recuperáveis · quota ${quota} ───`);
    }

    for (const r of amostra.slice(0, 100)) {
      linha("");
      linha(`  CNP ${r.cnp}  ${corta(r.designacao, 50)}`);
      linha(
        `      actual: ${semClass(r) ? "(sem classificação)" : `${corta(r.nivel1, 18)} / ${corta(r.nivel2, 22)}`}` +
          `  tipo=${corta(r.productType, 16)}`,
      );
      linha(
        `      proposta: ${corta(r.cCategoria, 22)} / ${corta(r.cSubcategoria, 26)}` +
          `  conf=${r.cConfidence.toFixed(2)}  ${r.cEvidence}`,
      );
      linha(`      recusa: ${corta(r.cMotivo, 56)}`);
      if (r.cRationale) linha(`      porquê: ${corta(r.cRationale, 58)}`);
    }

    // ══════════════════════════════════════════════════════════════════
    titulo("PARTE 5 · Os que nunca passaram por enrichment");
    linha("");
    linha("  Os filtros de elegibilidade, de knowledge-enrichment-runner.ts:");
    linha(`    · cnp >= ${nf(MIN_CNP)}  (códigos internos não são catálogo)`);
    linha("    · validadoManualmente = false  (decisão humana não se toca)");
    linha("    · residual: sem nível 2, OU em Outros, OU sem utilizações");
    linha(`    · ainda não visto na versão ${KNOWLEDGE_VERSION}`);
    linha("");
    const nunca = rows.filter((r) => !r.temCache && semClass(r));
    const nuncaCnpBaixo = nunca.filter((r) => r.cnp < MIN_CNP);
    const nuncaValidado = nunca.filter((r) => r.validadoManualmente);
    const nuncaNaFila = nunca.filter((r) => r.naFila);
    const elegiveisHoje = nunca.filter(
      (r) => r.cnp >= MIN_CNP && !r.validadoManualmente,
    );
    linha(`  Por Classificar SEM linha de cache ....... ${col(nunca.length, nunca.length)}`);
    linha(`  · cnp abaixo de ${nf(MIN_CNP)} (excluídos) ....... ${col(nuncaCnpBaixo.length, nunca.length)}`);
    linha(`  · validados manualmente (excluídos) ...... ${col(nuncaValidado.length, nunca.length)}`);
    linha(`  · já estão na EnriquecimentoFila ......... ${col(nuncaNaFila.length, nunca.length)}`);
    linha("");
    linha(`  ⇒ ELEGÍVEIS HOJE, sem qualquer alteração:  ${col(elegiveisHoje.length, nunca.length)}`);
    linha("");
    linha("  Se este número for próximo do total, não há filtro a excluí-los:");
    linha("  a corrida simplesmente ainda não chegou lá. É backlog, não bloqueio.");

    // ══════════════════════════════════════════════════════════════════
    titulo("PARTE 6 · Quanto se recupera a custo de IA zero");
    linha("");
    linha("  A cache guarda a resposta INTEGRAL, escrita ou não — é o que o");
    linha("  comentário de `KnowledgeEnrichmentCache.persistido` diz que faz.");
    linha("  Logo, mudar a política e reprocessar a cache não paga nada.");
    linha("");
    for (const l of [0.85, 0.9, 0.95]) {
      const pc = recusadosPorClass.filter((r) => passaria(r, l)).length;
      const bl = recusadosBalde.filter((r) => passaria(r, l)).length;
      linha(
        `  limiar ${l.toFixed(2)}:  Por Classificar ${String(nf(pc)).padStart(6)}` +
          `  ·  Outros ${String(nf(bl)).padStart(6)}  ·  TOTAL ${String(nf(pc + bl)).padStart(6)}`,
      );
    }
    linha("");
    linha("  Estes números NÃO exigem uma chamada nova ao modelo. Exigem uma");
    linha("  alteração de política e uma passagem pela cache.");
  } finally {
    await prisma.$disconnect();
  }
}

principal().catch((e) => {
  console.error(e);
  process.exit(1);
});
