/**
 * lib/catalog/target-db.ts
 *
 * Resolve — e trava — a base contra a qual um script de catálogo escreve.
 *
 * Porque existe: os scripts tinham `--db=spharmmt_t_grupo_silveira` como
 * valor por omissão e liam o `DATABASE_URL` do ambiente sem o mostrar.
 * Correr o backfill sem argumentos escrevia 6 324 linhas numa base do
 * Neon julgando-se estar a preparar produção. Não houve erro nenhum: o
 * comando correu bem, no sítio errado.
 *
 * Três regras, e todas existem por causa disso:
 *
 *  1. A base é sempre explícita. Não há omissão. Um nome por omissão é
 *     uma decisão tomada há meses por outra pessoa noutro contexto.
 *  2. Hosts que não são produção (Neon, Vercel) são recusados. A
 *     produção é a VPS; qualquer outro destino tem de ser pedido.
 *  3. O destino é impresso antes de se escrever fosse o que fosse.
 *
 * A recusa não apaga nem desliga o suporte a esses hosts — continuam a
 * funcionar com `--permitir-externo`. O que deixa de existir é o caminho
 * silencioso.
 */

export type AlvoDb = {
  /** String de ligação completa, já com a base trocada. */
  url: string;
  host: string;
  base: string;
  /** true quando o alvo NÃO é o PostgreSQL de produção. */
  externo: boolean;
};

/** Hosts que não podem ser destino de produção. */
const HOSTS_EXTERNOS: readonly RegExp[] = [
  /\bneon\.tech$/i,
  /\.vercel\.app$/i,
  /\bvercel-storage\.com$/i,
  /\.rds\.amazonaws\.com$/i,
  /\.postgres\.database\.azure\.com$/i,
];

export class AlvoRecusado extends Error {}

function hostDe(url: string): string {
  // Sem `new URL()`: passwords com caracteres não codificados fazem-no
  // rebentar, e aqui só interessa o host.
  const m = /^[a-z+]+:\/\/(?:[^@/]*@)?([^:/?#]+)/i.exec(url);
  return m?.[1] ?? "(desconhecido)";
}

function trocarBase(url: string, base: string): string {
  return url.replace(/\/[^/?]+(\?|$)/, `/${base}$1`);
}

export function ehHostExterno(host: string): boolean {
  return HOSTS_EXTERNOS.some((r) => r.test(host));
}

/**
 * Lê `--db=<base>` de argv e o `DATABASE_URL` do ambiente, e devolve o
 * alvo. Lança se faltar a base, se faltar o `DATABASE_URL`, ou se o host
 * não for de produção sem `--permitir-externo`.
 */
export function resolverAlvoDb(argv: readonly string[]): AlvoDb {
  const base = argv.find((a) => a.startsWith("--db="))?.slice(5)?.trim();
  if (!base) {
    throw new AlvoRecusado(
      "Falta --db=<base>.\n" +
        "Não há base por omissão: o nome tem de ser dito em cada execução.\n" +
        "Na VPS, o nome do tenant vem do control plane:\n" +
        `  SELECT "dbName" FROM "Tenant" WHERE slug='<slug>';`,
    );
  }

  const raiz = process.env.DATABASE_URL;
  if (!raiz) {
    throw new AlvoRecusado("DATABASE_URL não definido — sem ele não há destino nenhum.");
  }

  const url = trocarBase(raiz, base);
  const host = hostDe(url);
  const externo = ehHostExterno(host);

  if (externo && !argv.includes("--permitir-externo")) {
    throw new AlvoRecusado(
      `Recusado: ${host} não é o PostgreSQL de produção.\n` +
        "A produção do SPharm.MT é a VPS. Este host é externo (Neon/Vercel/cloud).\n" +
        "Se é mesmo aí que queres escrever, diz-lo: --permitir-externo",
    );
  }

  return { url, host, base, externo };
}

/** Cabeçalho obrigatório: quem corre isto vê onde vai escrever. */
export function descreverAlvo(alvo: AlvoDb): string {
  return `Destino: ${alvo.base} @ ${alvo.host}${alvo.externo ? "   *** EXTERNO — não é produção ***" : ""}`;
}
