/**
 * lib/produtos/resolver-lista-codigos.ts
 *
 * Confronta os códigos lidos de um ficheiro com o catálogo do tenant.
 *
 * É o ÚNICO sítio onde um código de ficheiro se transforma em produto.
 * Os Relatórios e as Encomendas chamam o mesmo endpoint, que chama esta
 * função — nenhum dos dois módulos tem uma segunda forma de o fazer, e é
 * por isso que a mesma lista dá necessariamente o mesmo conjunto nos
 * dois.
 *
 * ── Porque só por CNP ────────────────────────────────────────────────
 *
 * `Produto.cnp` é `@unique`: é a identidade canónica do catálogo, e é o
 * que a app já usa em todo o lado onde alguém escreve um número —
 * `app/encomendas/nova/search.ts` resolve `/^\d+$/` como `{ cnp: n }`, e
 * a pesquisa dos relatórios faz o mesmo.
 *
 * A alternativa seria aceitar também `externalProductId` (o CodigoID do
 * ERP). Não aceita, e a razão está documentada em
 * `lib/aggregate/resolve-produto.ts`: esse campo NÃO é único. Em
 * grupo-silveira, 5 145 códigos mapeiam ≥2 produtos canónicos. Uma lista
 * importada que resolvesse por aí devolveria produtos diferentes
 * consoante a farmácia — e às vezes consoante o dia, porque o critério
 * de desempate usa `dataUltimaVenda`. Uma lista de trabalho tem de ser
 * estável.
 *
 * Um código do ficheiro que seja um CodigoID e não um CNP aparece ao
 * utilizador em `naoEncontrados`, que é a resposta honesta.
 *
 * ── Porque não filtra por `estado` ───────────────────────────────────
 *
 * A pergunta do utilizador é "este código existe no catálogo?", não
 * "este código está activo?". Um produto descontinuado que ele pôs na
 * lista EXISTE, e dizer-lhe que não existe mandava-o procurar um erro de
 * digitação que não há. Se o artigo não tiver linhas no período, o
 * relatório mostra-o vazio — que é outra informação, e a certa.
 *
 * ── Porque NÃO tem `import "server-only"` ────────────────────────────
 *
 * `server-only` é um módulo que só existe dentro do build do Next — não
 * está em `node_modules`. Qualquer script Node que o alcance, a qualquer
 * profundidade do grafo, morre em `Cannot find module 'server-only'`;
 * é o que `scripts/tests/test-diagnostico-tools.ts` existe para detectar.
 *
 * Este ficheiro aceita um `PrismaClient` por parâmetro precisamente para
 * ser testável fora do Next, como `lib/reporting/catalog-prefilter.ts`,
 * que segue a mesma convenção pela mesma razão. O que o mantém no
 * servidor não é a directiva: é ser importado só pelo route handler.
 */
import { getPrisma } from "@/lib/prisma";
import type { PrismaClient } from "@/generated/prisma/client";
import {
  MAX_CODIGOS,
  type ListaCodigosParseada,
  type ListaCodigosResolvida,
} from "./lista-codigos-tipos";

/**
 * Códigos por consulta.
 *
 * `cnp` é `@unique`, logo cada chunk é um index scan. O chunking não é
 * por performance — é para o texto da query não crescer sem limite: 25 000
 * inteiros num único `IN (...)` dá uma statement de centenas de KB, que o
 * pooler tem de transportar inteira.
 */
const CHUNK = 5_000;

export class ListaCodigosDemasiadoGrande extends Error {
  constructor(readonly total: number) {
    super(
      `A lista tem ${total.toLocaleString("pt-PT")} códigos; o máximo é ` +
        `${MAX_CODIGOS.toLocaleString("pt-PT")}.`,
    );
    this.name = "ListaCodigosDemasiadoGrande";
  }
}

/**
 * Resolve os códigos parseados contra o catálogo.
 *
 * O resultado preserva TODA a contabilidade do parse (lidos, duplicados,
 * ignorados) e acrescenta a do catálogo (encontrados, não encontrados).
 * É o objecto que a UI guarda e de onde sai o filtro.
 */
export async function resolverListaCodigos(
  parseada: ListaCodigosParseada,
  nomeFicheiro: string,
  client?: PrismaClient,
): Promise<ListaCodigosResolvida> {
  if (parseada.codigos.length > MAX_CODIGOS) {
    throw new ListaCodigosDemasiadoGrande(parseada.codigos.length);
  }

  const prisma = client ?? (await getPrisma());

  // `codigos` vem normalizado (só dígitos, sem zeros à esquerda), por
  // isso `Number` é total aqui. O Map guarda a forma ORIGINAL para que
  // os não-encontrados apareçam como o utilizador os escreveu.
  const porNumero = new Map<number, string>();
  for (const c of parseada.codigos) {
    const n = Number(c);
    if (Number.isSafeInteger(n) && !porNumero.has(n)) porNumero.set(n, c);
  }
  const numeros = [...porNumero.keys()];

  const encontrados = new Set<number>();
  for (let i = 0; i < numeros.length; i += CHUNK) {
    const fatia = numeros.slice(i, i + CHUNK);
    const hits = await prisma.produto.findMany({
      where: { cnp: { in: fatia } },
      select: { cnp: true },
    });
    for (const h of hits) encontrados.add(h.cnp);
  }

  // Ordem de aparição no ficheiro, nos dois arrays. É o que torna a
  // lista de não-encontrados percorrível com o ficheiro ao lado.
  const cnps: number[] = [];
  const naoEncontrados: string[] = [];
  for (const n of numeros) {
    if (encontrados.has(n)) cnps.push(n);
    else naoEncontrados.push(porNumero.get(n)!);
  }

  return {
    ...parseada,
    nomeFicheiro,
    cnps,
    encontrados: cnps.length,
    naoEncontrados,
  };
}
