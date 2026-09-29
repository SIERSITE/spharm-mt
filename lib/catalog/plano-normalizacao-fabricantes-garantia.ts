/**
 * lib/catalog/plano-normalizacao-fabricantes-garantia.ts
 *
 * Leitor OPCIONAL do plano curado de normalização de fabricantes.
 *
 * A fonte original (557 grupos, investigação empresarial externa —
 * winner/loser por entidade legal, ex.: "Merial Portuguesa" → "Boehringer
 * Ingelheim Animal Health Portugal" após a entidade ter mudado de
 * estrutura) existe noutra iniciativa (branch `catalog/normalizacao-
 * fabricantes-garantia`, ficheiro de 10 000+ linhas `scripts/data/plano-
 * normalizacao-garantia-achatado-checkpoint.json`, ainda `DRY_RUN_DO_NOT_
 * APPLY` nessa branch) e NUNCA é copiada para aqui inteira — pertence à
 * iniciativa que a produziu.
 *
 * O QUE ESTE MÓDULO LÊ, de facto, É O DERIVADO versionado NESTE branch:
 * `scripts/data/plano-curado-fabricantes-garantia.json`, gerado por
 * `scripts/gerar-plano-curado-fabricantes-garantia.ts` a partir da fonte
 * acima (ver a doc desse gerador para a análise de compatibilidade —
 * quais das 557 decisões são seguras para atribuir `Produto.
 * fabricanteId` e quais foram excluídas). Formato aceite (o do
 * derivado, não o da fonte de 10 000 linhas):
 *   { groups: [ { canonical_id, canonical_name_before, sources: [{ source_name }] } ] }
 * `canonical_name_before` é usado deliberadamente (nunca `canonical_
 * name_after`, ausente do derivado) — é o nome do Fabricante EXACTAMENTE
 * como existe hoje na base (a fonte ainda não tem nenhuma renomeação
 * aplicada); ver o gerador para a justificação completa.
 *
 * Fonte de mapeamento OPCIONAL: a reconciliação de fabricantes por CNP
 * funciona por completo sem este ficheiro (cai para "criar um Fabricante
 * novo" quando não há nenhuma correspondência). Quando apontado
 * (`--plano-curado=<path>` na CLI, ou o parâmetro `planoPath` do
 * serviço), as suas decisões evitam criar um Fabricante novo para um
 * titular que o plano já saiba ser o MESMO que um canónico existente —
 * sem nunca EXECUTAR nenhum merge (isso continua a ser responsabilidade
 * exclusiva do executor da outra iniciativa; ler para consulta é seguro
 * e não corre esse risco).
 */
import { readFileSync, existsSync } from "node:fs";
import { normalizarTitularAimGarantia } from "./fabricante-normalizacao-garantia";

/** nomeOrigemNormalizado → nomeCanonicoNormalizado. */
export type MapeamentoCuradoFabricantes = ReadonlyMap<string, string>;

type FontePlanoMinima = { source_name?: string } | string;
type GrupoPlanoCuradoMinimo = {
  canonical_id: string;
  canonical_name_before?: string;
  sources: readonly FontePlanoMinima[];
};
type PlanoCuradoMinimo = {
  groups?: readonly GrupoPlanoCuradoMinimo[];
};

/**
 * Traduz o formato curado (ver o cabeçalho do ficheiro) para um simples
 * mapa nome-fonte→nome-canónico, já normalizado com a MESMA função usada
 * pelo resolvedor (`normalizarTitularAimGarantia`) — para que uma
 * consulta por `titularAim` normalizado encontre exactamente a mesma
 * chave que este mapa produz a partir do plano.
 *
 * Nunca lança: um grupo malformado é ignorado (o plano é uma fonte
 * OPCIONAL — um erro de parsing nunca pode impedir a reconciliação de
 * correr sem ele).
 */
export function construirMapeamentoCuradoDoPlano(plano: PlanoCuradoMinimo): MapeamentoCuradoFabricantes {
  const mapa = new Map<string, string>();
  for (const grupo of plano.groups ?? []) {
    try {
      const nomeCanonico = normalizarTitularAimGarantia(grupo.canonical_name_before ?? null);
      if (!nomeCanonico) continue;
      for (const fonte of grupo.sources ?? []) {
        const nomeFonte = typeof fonte === "string" ? fonte : fonte.source_name;
        const nomeFonteNorm = normalizarTitularAimGarantia(nomeFonte ?? null);
        if (nomeFonteNorm && nomeFonteNorm !== nomeCanonico) {
          mapa.set(nomeFonteNorm, nomeCanonico);
        }
      }
    } catch {
      // grupo malformado — ignorado, ver doc do ficheiro.
    }
  }
  return mapa;
}

/**
 * Lê e traduz o ficheiro do plano, se existir. Devolve um mapa vazio
 * (nunca lança, nunca bloqueia a reconciliação) se `planoPath` for
 * omisso, o ficheiro não existir, ou o JSON for inválido.
 */
export function carregarMapeamentoCuradoDoPlano(planoPath: string | undefined | null): MapeamentoCuradoFabricantes {
  if (!planoPath || !existsSync(planoPath)) return new Map();
  try {
    const bruto = JSON.parse(readFileSync(planoPath, "utf8")) as PlanoCuradoMinimo;
    return construirMapeamentoCuradoDoPlano(bruto);
  } catch {
    return new Map();
  }
}
