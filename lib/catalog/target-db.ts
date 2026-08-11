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
  /** Slug do tenant, quando o destino foi resolvido por ele. */
  tenant?: string;
  /** Utilizador da ligação. Impresso para o operador ver com quem entra. */
  utilizador?: string;
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
 * Alvo a partir do slug do tenant, com as credenciais DO TENANT.
 *
 * É este o caminho normal em produção. O `DATABASE_URL` do container
 * traz o utilizador `spharmmt_app`, que serve o control plane e a base
 * legacy e NÃO tem CONNECT às bases dos tenants — de propósito, para que
 * um processo que serve tráfego não alcance dados de outro cliente.
 * Trocar só o nome da base nessa string dá um erro de ligação que parece
 * a base não existir, quando o que falta é a credencial certa.
 *
 * A password vem cifrada do control plane e é decifrada com
 * `TENANT_ENCRYPTION_SECRET`, exactamente como no `tenancy:migrate-all`.
 * Nada de alargar permissões ao `spharmmt_app`.
 */
export async function resolverAlvoTenant<T extends TenantParaLigacao>(
  argv: readonly string[],
  deps: {
    getTenantBySlug: (slug: string) => Promise<T | null>;
    buildTenantConnectionString: (t: T) => string;
  },
): Promise<AlvoDb> {
  const slug = argv.find((a) => a.startsWith("--tenant="))?.slice(9)?.trim();
  if (!slug) {
    throw new AlvoRecusado(
      "Falta --tenant=<slug>.\n" +
        "O destino é identificado pelo tenant, não pelo nome da base: é do\n" +
        "control plane que vêm a base, o host e a credencial que lhe pertence.",
    );
  }

  const tenant = await deps.getTenantBySlug(slug);
  if (!tenant) {
    throw new AlvoRecusado(`Tenant '${slug}' não existe no control plane.`);
  }

  const url = deps.buildTenantConnectionString(tenant);
  const host = tenant.dbHost;
  const externo = ehHostExterno(host);

  if (externo && !argv.includes("--permitir-externo")) {
    throw new AlvoRecusado(
      `Recusado: o tenant '${slug}' está em ${host}, que não é o PostgreSQL de produção.\n` +
        "Se é mesmo aí que queres escrever: --permitir-externo",
    );
  }

  return { url, host, base: tenant.dbName, externo, tenant: slug, utilizador: tenant.dbUser };
}

/** O que `resolverAlvoTenant` precisa de saber de um tenant. */
export type TenantParaLigacao = {
  slug: string;
  dbHost: string;
  dbPort: number;
  dbName: string;
  dbUser: string;
  dbPassEncrypted: string;
};

/**
 * Lê `--db=<base>` de argv e o `DATABASE_URL` do ambiente, e devolve o
 * alvo. Lança se faltar a base, se faltar o `DATABASE_URL`, ou se o host
 * não for de produção sem `--permitir-externo`.
 *
 * Caminho secundário: mantém o utilizador do `DATABASE_URL`, portanto só
 * serve quando essa credencial tem mesmo acesso à base indicada —
 * tipicamente desenvolvimento. Em produção usa-se `--tenant=<slug>`.
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

/** Cabeçalho obrigatório: quem corre isto vê onde vai escrever, e com quem. */
export function descreverAlvo(alvo: AlvoDb): string {
  const quem = alvo.utilizador ? ` como ${alvo.utilizador}` : "";
  const qual = alvo.tenant ? ` (tenant ${alvo.tenant})` : "";
  return (
    `Destino: ${alvo.base} @ ${alvo.host}${quem}${qual}` +
    (alvo.externo ? "   *** EXTERNO — não é produção ***" : "")
  );
}

/**
 * Escolhe o resolvedor conforme os argumentos. `--tenant` e `--db` são
 * alternativas, não complementos: aceitar os dois deixaria dúvida sobre
 * qual mandou, e é dessa dúvida que nascem escritas na base errada.
 */
export async function resolverAlvo<T extends TenantParaLigacao>(
  argv: readonly string[],
  deps: {
    getTenantBySlug: (slug: string) => Promise<T | null>;
    buildTenantConnectionString: (t: T) => string;
  },
): Promise<AlvoDb> {
  const temTenant = argv.some((a) => a.startsWith("--tenant="));
  const temDb = argv.some((a) => a.startsWith("--db="));

  if (temTenant && temDb) {
    throw new AlvoRecusado("--tenant e --db são alternativas. Escolhe um.");
  }
  if (temTenant) return resolverAlvoTenant(argv, deps);
  if (temDb) return resolverAlvoDb(argv);

  throw new AlvoRecusado(
    "Falta o destino.\n" +
      "  --tenant=<slug>   credenciais do tenant, vindas do control plane (produção)\n" +
      "  --db=<base>       usa o utilizador do DATABASE_URL (desenvolvimento)\n" +
      "Não há destino por omissão.",
  );
}
