/**
 * lib/catalog/plano-normalizacao-fabricantes-garantia.ts
 *
 * Leitor OPCIONAL do plano curado de normalização de fabricantes
 * (557 grupos, investigação empresarial externa — winner/loser por
 * entidade legal, ex.: "Alfa Wassermann" → "Alfasigma Portugal" após
 * rebranding). Esse plano existe noutra iniciativa (branch
 * `catalog/normalizacao-fabricantes-garantia`, ainda não aplicado —
 * `scripts/data/plano-normalizacao-garantia-achatado-checkpoint.json`)
 * e é uma fonte de mapeamento OPCIONAL aqui: a reconciliação de
 * fabricantes por CNP funciona por completo sem ele (cai para "criar um
 * Fabricante novo" quando não há nenhuma correspondência), mas quando o
 * ficheiro existir e for apontado (`--plano-curado=<path>` na CLI, ou o
 * parâmetro `planoPath` do serviço), as suas decisões winner/loser
 * evitam criar um Fabricante novo para um titular que o plano já saiba
 * ser o MESMO que um canónico existente — e sem nunca EXECUTAR nenhum
 * merge desse plano aqui (isso é responsabilidade exclusiva do executor
 * próprio dessa outra iniciativa; ler o plano para consulta é seguro e
 * não corre esse risco).
 *
 * Nunca copiado para este branch: o ficheiro real (10 000+ linhas,
 * proveniência de uma investigação empresarial externa) pertence à
 * iniciativa que o produziu. Este módulo só sabe **ler** o formato
 * "achatado" que essa iniciativa já documenta — puro, sem Prisma, sem
 * side-effects — para poder ser usado assim que esse ficheiro estiver
 * disponível no ambiente onde este serviço corre (dev, CI, ou a própria
 * VPS, uma vez as duas iniciativas integradas).
 */
import { readFileSync, existsSync } from "node:fs";
import { normalizarTitularAimGarantia } from "./fabricante-normalizacao-garantia";

/** nomeOrigemNormalizado → nomeCanonicoNormalizado. */
export type MapeamentoCuradoFabricantes = ReadonlyMap<string, string>;

type GrupoPlanoOrigemMinimo = {
  canonical_id: string;
  canonical_name?: string;
};
type FontePlanoMinima = { source_name?: string } | string;
type GrupoPlanoAchatadoMinimo = {
  origin: GrupoPlanoOrigemMinimo;
  sources: readonly FontePlanoMinima[];
};
type PlanoAchatadoMinimo = {
  tenant?: string;
  groups?: readonly GrupoPlanoAchatadoMinimo[];
};

/**
 * Traduz o formato "achatado" (ver o cabeçalho do ficheiro) para um
 * simples mapa nome-fonte→nome-canónico, já normalizado com a MESMA
 * função usada pelo resolvedor (`normalizarTitularAimGarantia`) — para
 * que uma consulta por `titularAim` normalizado encontre exactamente a
 * mesma chave que este mapa produz a partir do plano.
 *
 * Nunca lança: um grupo malformado é ignorado (o plano é uma fonte
 * OPCIONAL — um erro de parsing nunca pode impedir a reconciliação de
 * correr sem ele).
 */
export function construirMapeamentoCuradoDoPlano(plano: PlanoAchatadoMinimo): MapeamentoCuradoFabricantes {
  const mapa = new Map<string, string>();
  for (const grupo of plano.groups ?? []) {
    try {
      const nomeCanonico = normalizarTitularAimGarantia(grupo.origin.canonical_name ?? null);
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
    const bruto = JSON.parse(readFileSync(planoPath, "utf8")) as PlanoAchatadoMinimo;
    return construirMapeamentoCuradoDoPlano(bruto);
  } catch {
    return new Map();
  }
}
