/**
 * lib/server-actions-origins.ts
 *
 * Lista de origens autorizadas a invocar Server Actions.
 *
 * O Next valida, em cada Server Action, que o `Origin` do browser
 * corresponde ao `Host` do pedido. Atrás de um reverse proxy os dois
 * podem divergir de forma perfeitamente legítima — acesso por IP, por
 * túnel SSH, ou por um domínio que o container não conhece — e o
 * pedido é recusado com `Invalid Server Actions request`, uma mensagem
 * que não diz qual das duas pontas está errada.
 *
 * Esta lista é a excepção explícita a essa regra. Por isso mesmo:
 * nunca contém curingas globais e nunca é preenchida por adivinhação.
 *
 * Lido em BUILD TIME (`next.config.ts`). Não é possível fazê-lo em
 * runtime: o Next fixa esta configuração no bundle do servidor. Mudar
 * as origens obriga a reconstruir a imagem — o que também significa que
 * a lista é auditável a partir do artefacto.
 *
 * Sem `import "server-only"`: é consumido pelo `next.config.ts` e pelos
 * testes, fora do bundler.
 */

export class ServerActionsOriginsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerActionsOriginsError";
  }
}

export type ParseOptions = {
  /** Valor bruto de SERVER_ACTIONS_ALLOWED_ORIGINS. */
  raw?: string | null;
  /** PUBLIC_APP_URL, usado como último recurso seguro. */
  publicAppUrl?: string | null;
  /** Em produção a ausência de origens é fatal; em dev não. */
  isProduction: boolean;
};

/**
 * Normaliza uma entrada: sem protocolo, sem barras, sem espaços,
 * minúsculas. `https://App.SPharm.pt/` e `app.spharm.pt` são a mesma
 * coisa, e quem escreve a variável não tem de saber qual é a forma certa.
 *
 * Devolve null para entradas que não sobrevivem à normalização.
 */
export function normalizeOrigin(entry: string): string | null {
  let value = entry.trim().toLowerCase();
  if (value === "") return null;

  // Protocolo, se vier.
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  // Caminho, query ou fragmento — só interessa host[:porto].
  value = value.replace(/[/?#].*$/, "");
  // Credenciais embutidas (user:pass@host) nunca pertencem a uma lista
  // destas, e aceitá-las silenciosamente esconderia um erro de cópia.
  if (value.includes("@")) return null;
  value = value.trim();

  if (value === "") return null;
  return value;
}

/**
 * `true` para entradas que autorizam tudo. Um curinga global aqui anula
 * a única protecção que o Next tem contra invocações de Server Actions a
 * partir de outros sítios.
 */
export function isGlobalWildcard(value: string): boolean {
  return value === "*" || value === "*.*" || value === "**" || value === "*:*";
}

/**
 * Host de PUBLIC_APP_URL, com porto se o URL o tiver. Usado como último
 * recurso quando a variável dedicada não foi definida.
 */
export function hostFromPublicAppUrl(url: string | null | undefined): string | null {
  if (!url || url.trim() === "") return null;
  const candidate = url.trim();
  try {
    const parsed = new URL(candidate.includes("://") ? candidate : `http://${candidate}`);
    return parsed.host.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * Devolve a lista final, já normalizada e sem duplicados.
 *
 * Regras, por ordem:
 *   1. `SERVER_ACTIONS_ALLOWED_ORIGINS` quando definida;
 *   2. senão, o host de `PUBLIC_APP_URL` — e só ele;
 *   3. em produção, se não sobrar nada, ATIRA e o build falha.
 *
 * Uma origem vazia nunca é tratada como curinga: entradas que não
 * sobrevivem à normalização são descartadas, e se a lista ficar vazia
 * cai-se na regra 2 ou 3. É a diferença entre "não configurado" e
 * "configurado para aceitar tudo".
 */
export function resolveAllowedOrigins(options: ParseOptions): string[] {
  const { raw, publicAppUrl, isProduction } = options;

  const fromVar: string[] = [];
  if (raw != null && raw.trim() !== "") {
    for (const piece of raw.split(",")) {
      const normalized = normalizeOrigin(piece);
      if (normalized === null) continue;
      if (isGlobalWildcard(normalized)) {
        throw new ServerActionsOriginsError(
          `SERVER_ACTIONS_ALLOWED_ORIGINS contém um curinga global ("${normalized}"). ` +
            "Isso anula a protecção do Next contra invocações de Server Actions a partir " +
            "de outras origens. Lista os hosts explicitamente — subdomínios podem usar " +
            "o formato *.exemplo.pt.",
        );
      }
      fromVar.push(normalized);
    }
  }

  const resolved = fromVar.length > 0 ? fromVar : [];

  if (resolved.length === 0) {
    const derived = hostFromPublicAppUrl(publicAppUrl);
    if (derived) resolved.push(derived);
  }

  if (resolved.length === 0 && isProduction) {
    throw new ServerActionsOriginsError(
      "SERVER_ACTIONS_ALLOWED_ORIGINS não está definida e PUBLIC_APP_URL também não.\n" +
        "Em produção não há default seguro: sem lista, as Server Actions são recusadas\n" +
        "com 'Invalid Server Actions request' assim que o Host e o Origin diferirem —\n" +
        "que é o caso normal atrás de um reverse proxy.\n" +
        "Define, por exemplo:\n" +
        "  SERVER_ACTIONS_ALLOWED_ORIGINS=127.0.0.1:8080,203.0.113.10,app.exemplo.pt",
    );
  }

  // Sem duplicados, ordem estável — a lista entra no artefacto de build e
  // uma ordem instável faria dois builds do mesmo código diferirem.
  return Array.from(new Set(resolved)).sort();
}
