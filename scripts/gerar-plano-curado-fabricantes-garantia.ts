/**
 * scripts/gerar-plano-curado-fabricantes-garantia.ts
 *
 * Gerador OFFLINE (sem Prisma, sem BD, não corre no ingest nem na CLI de
 * backfill) do artefacto `scripts/data/plano-curado-fabricantes-garantia.
 * json` — a partir da fonte de 557 grupos da OUTRA iniciativa (branch
 * `catalog/normalizacao-fabricantes-garantia`, ficheiro achatado de
 * 10 000+ linhas `scripts/data/plano-normalizacao-garantia-achatado-
 * checkpoint.json`, ainda `RESEARCH_CONCLUDED_READY_FOR_IMPLEMENTATION_
 * DRY_RUN_DO_NOT_APPLY` nessa branch — não confundir "pronto para dry-run
 * NAQUELA iniciativa" com "seguro para ESTA reconciliação").
 *
 * ── Determinação de compatibilidade (por que este derivado é seguro) ──
 *
 * A fonte mistura vários TIPOS de decisão sobre `Fabricante`, nem todos
 * utilizáveis aqui:
 *   · identidade legal / variante textual da MESMA entidade (todos os 18
 *     valores de `relation` observados na fonte — variante_ortografica,
 *     truncamento, abreviacao, mudanca_de_denominacao_e_variantes, etc.
 *     — representam isto: "mesma entidade real, forma textual diferente")
 *     → é exactamente o que `MapeamentoCuradoFabricantes` precisa
 *     (nomeOrigemNormalizado → nomeCanonicoNormalizado) e é o ÚNICO tipo
 *     de decisão que este gerador extrai;
 *   · `do_not_merge` (15 famílias, entidades legalmente distintas que
 *     PARECEM relacionadas mas não são a mesma pessoa jurídica, ex.:
 *     Janssen-Cilag vs. Janssen Farmacêutica Portugal, Boehringer
 *     Ingelheim Portugal vs. Boehringer Ingelheim Animal Health) → nunca
 *     usado como fonte de alias; usado aqui só como FILTRO negativo (ver
 *     `violaDoNotMerge`) — confirmado programaticamente, nesta fonte, que
 *     NENHUM dos 557 grupos junta dois membros distintos da MESMA família
 *     (o filtro corre na mesma para proteger contra uma fonte futura que
 *     já não tenha essa garantia);
 *   · `canonical_name_after` / a mecânica de renomeação e "promoção de
 *     origem a canónico" (17 dos 557 grupos, `canonical_rename_required:
 *     true`) → NUNCA usada aqui. Esta fonte é `DRY_RUN_DO_NOT_APPLY`: a
 *     renomeação NUNCA foi aplicada à base real, logo `canonical_id`
 *     continua a existir HOJE com o nome `canonical_name_before` — é esse
 *     o nome que este gerador usa como alvo do mapeamento, para TODOS os
 *     557 grupos, sem distinguir se uma renomeação está pendente (o
 *     `Produto.fabricanteId` resultante aponta sempre para uma linha
 *     `Fabricante` REAL e já existente; uma futura renomeação/promoção,
 *     quando essa OUTRA iniciativa a aplicar, preserva o `id` do
 *     `Fabricante` vencedor — nunca o apaga — por isso o alias continua
 *     válido depois);
 *   · Grupo Laboratorial → esta fonte NUNCA o menciona; é pura
 *     identidade de `Fabricante`, sem qualquer risco de confundir os dois
 *     conceitos (ver a preocupação original da regra 3 da reconciliação).
 *
 * Resultado: os 557 grupos são TODOS elegíveis (nenhum precisa de ser
 * excluído por `canonical_rename_required`), sujeitos apenas ao filtro
 * `do_not_merge` (defensivo, zero exclusões nesta fonte) e à omissão de
 * grupos sem nenhuma fonte utilizável (nome canónico vazio, ou todas as
 * fontes iguais ao canónico depois de normalizar).
 *
 * Uso (manual, uma vez por actualização da fonte — nunca automático):
 *   npx tsx scripts/gerar-plano-curado-fabricantes-garantia.ts \
 *     --fonte=<path-para-o-achatado-de-557-grupos> \
 *     --commit=<sha-da-fonte> \
 *     [--saida=scripts/data/plano-curado-fabricantes-garantia.json]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { normalizarTitularAimGarantia } from "../lib/catalog/fabricante-normalizacao-garantia";

type FonteGrupo = {
  canonical_id: string;
  canonical_name_before?: string;
  canonical_name_after?: string;
  canonical_rename_required?: boolean;
  relation?: string;
  sources: readonly { source_id?: string; source_name?: string }[];
};
type FontePlano = {
  tenant?: string;
  do_not_merge?: readonly (readonly string[])[];
  groups?: readonly FonteGrupo[];
};

export type GrupoCurado = {
  canonical_id: string;
  canonical_name_before: string;
  sources: readonly { source_name: string }[];
};
export type PlanoCuradoGerado = {
  geradoEm: string;
  geradoDe: { branch: string; commit: string; ficheiro: string };
  totalGruposFonte: number;
  totalGruposExcluidosDoNotMerge: number;
  totalGruposSemFonteUtilizavel: number;
  groups: readonly GrupoCurado[];
};

/**
 * Verdadeiro se este grupo juntar, entre `canonical_name_before` e todas
 * as `sources[].source_name`, DOIS OU MAIS membros DISTINTOS da MESMA
 * família `do_not_merge` — comparação por igualdade EXACTA do nome
 * normalizado (nunca por prefixo/substring: os rótulos de `do_not_merge`
 * podem ser eles próprios prefixos uns dos outros, ex. "JANSSEN-CILAG"
 * vs. "JANSSEN-CILAG FARMACEUTICA", que são famílias DIFERENTES — uma
 * comparação por substring geraria falsos positivos aqui).
 */
export function violaDoNotMerge(
  nomes: ReadonlySet<string>,
  familias: readonly (readonly string[])[],
): boolean {
  for (const familia of familias) {
    const presentes = familia.filter((m) => nomes.has(normalizarTitularAimGarantia(m) ?? ""));
    if (presentes.length > 1) return true;
  }
  return false;
}

export function gerarPlanoCurado(fonte: FontePlano, geradoDe: PlanoCuradoGerado["geradoDe"]): PlanoCuradoGerado {
  const familias = fonte.do_not_merge ?? [];
  const gruposFonte = fonte.groups ?? [];
  const groups: GrupoCurado[] = [];
  let excluidosDoNotMerge = 0;
  let semFonteUtilizavel = 0;

  for (const g of gruposFonte) {
    const nomeCanonico = normalizarTitularAimGarantia(g.canonical_name_before ?? null);
    if (!nomeCanonico) {
      semFonteUtilizavel++;
      continue;
    }

    const nomesFontesBrutas = (g.sources ?? []).map((s) => s.source_name).filter((n): n is string => !!n);
    const todosOsNomes = new Set([nomeCanonico, ...nomesFontesBrutas.map((n) => normalizarTitularAimGarantia(n)).filter((n): n is string => !!n)]);
    if (violaDoNotMerge(todosOsNomes, familias)) {
      excluidosDoNotMerge++;
      continue;
    }

    const sourcesUteis = nomesFontesBrutas
      .filter((nomeBruto) => {
        const norm = normalizarTitularAimGarantia(nomeBruto);
        return !!norm && norm !== nomeCanonico;
      })
      .map((source_name) => ({ source_name }));

    if (sourcesUteis.length === 0) {
      semFonteUtilizavel++;
      continue;
    }

    groups.push({ canonical_id: g.canonical_id, canonical_name_before: g.canonical_name_before!, sources: sourcesUteis });
  }

  return {
    geradoEm: new Date().toISOString(),
    geradoDe,
    totalGruposFonte: gruposFonte.length,
    totalGruposExcluidosDoNotMerge: excluidosDoNotMerge,
    totalGruposSemFonteUtilizavel: semFonteUtilizavel,
    groups,
  };
}

function parseArgs(argv: readonly string[]): { fonte: string; commit: string; saida: string } {
  const out: Partial<{ fonte: string; commit: string; saida: string }> = {
    saida: "scripts/data/plano-curado-fabricantes-garantia.json",
  };
  for (const a of argv) {
    if (a.startsWith("--fonte=")) out.fonte = a.slice("--fonte=".length);
    else if (a.startsWith("--commit=")) out.commit = a.slice("--commit=".length);
    else if (a.startsWith("--saida=")) out.saida = a.slice("--saida=".length);
    else throw new Error(`argumento desconhecido: ${a}`);
  }
  if (!out.fonte) throw new Error("--fonte=<path> é obrigatório");
  if (!out.commit) throw new Error("--commit=<sha> é obrigatório (proveniência do derivado)");
  return out as { fonte: string; commit: string; saida: string };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const fonte = JSON.parse(readFileSync(args.fonte, "utf8")) as FontePlano;
  const plano = gerarPlanoCurado(fonte, {
    branch: "catalog/normalizacao-fabricantes-garantia",
    commit: args.commit,
    ficheiro: "scripts/data/plano-normalizacao-garantia-achatado-checkpoint.json",
  });
  writeFileSync(args.saida, JSON.stringify(plano, null, 2), "utf8");
  console.log(`grupos na fonte:                    ${plano.totalGruposFonte}`);
  console.log(`excluídos por do_not_merge:          ${plano.totalGruposExcluidosDoNotMerge}`);
  console.log(`excluídos sem fonte utilizável:      ${plano.totalGruposSemFonteUtilizavel}`);
  console.log(`grupos no derivado:                  ${plano.groups.length}`);
  console.log(`aliases (sources) no derivado:       ${plano.groups.reduce((n, g) => n + g.sources.length, 0)}`);
  console.log(`gravado em: ${args.saida}`);
}

if (/[\\/]gerar-plano-curado-fabricantes-garantia\.(ts|js|mjs|cjs)$/.test(process.argv[1] ?? "")) {
  main();
}
