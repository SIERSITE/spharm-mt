/**
 * lib/session-claims.ts
 *
 * Os claims da sessão e a sua verificação, sem nada que só exista em
 * Node.
 *
 * ─────────────────────────────────────────────────────────────────────
 * PORQUE É QUE ISTO NÃO VIVE EM `lib/auth.ts`
 *
 * O `lib/auth.ts` começa com `import "server-only"` e usa
 * `next/headers` — não pode ser importado pelo middleware, que corre no
 * runtime Edge. E é no middleware que a sessão TEM de ser verificada:
 * é o único ponto por onde passam todas as rotas.
 *
 * O `jose` funciona nos dois runtimes. O que este módulo faz é separar a
 * parte que funciona em ambos da parte que não funciona, para o
 * middleware e o servidor partilharem a MESMA verificação em vez de
 * terem cada um a sua — duas verificações divergem, e a que diverge para
 * o lado permissivo é a que se descobre tarde.
 */
import { jwtVerify } from "jose";

/**
 * Sentinel do claim `tenant` quando o login foi feito em contexto
 * legacy (sem slug no request). É string obrigatória de propósito: uma
 * sessão sem o claim é rejeitada, em vez de comparar null com null.
 */
export const LEGACY_TENANT = "__legacy__" as const;

export type SessionUser = {
  sub: string;
  email: string;
  nome: string;
  perfil: string;
  farmaciaId: string | null;
  /**
   * Tenant onde o login foi autenticado. Em cada request o claim é
   * comparado com o tenant corrente; se não bater, a sessão não vale.
   */
  tenant: string;
  /**
   * A password foi reposta administrativamente e ainda não foi trocada.
   *
   * VIVE NO TOKEN, e não só na base de dados, porque quem tem de o
   * verificar é o middleware — que corre em Edge e não tem acesso à BD.
   * Sem isto, o bloqueio só podia ser feito nas páginas que chamam
   * `requireSession()`, e essas são a minoria: o utilizador escrevia
   * /stock no browser e entrava à mesma.
   *
   * Opcional no tipo porque tokens emitidos antes desta alteração não o
   * têm. Ausente é tratado como `false` — um token antigo não fica
   * preso numa página de troca de password que não pediu.
   */
  mustChangePassword?: boolean;
};

/**
 * Verifica a assinatura e a forma dos claims. NÃO valida o tenant: isso
 * depende do request e é feito por quem chama.
 */
export async function verificarToken(
  token: string,
  secret: Uint8Array,
): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, secret);
    const user = payload as unknown as Partial<SessionUser>;
    if (!user || typeof user.sub !== "string" || typeof user.tenant !== "string") {
      return null;
    }
    return user as SessionUser;
  } catch {
    return null;
  }
}

/** A chave de assinatura, derivada da mesma variável nos dois runtimes. */
export function segredoDaSessao(): Uint8Array {
  return new TextEncoder().encode(process.env.AUTH_SECRET || "dev-secret-change-this");
}
