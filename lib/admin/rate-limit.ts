/**
 * lib/admin/rate-limit.ts
 *
 * Limitador de taxa para a API de administração.
 *
 * Janela deslizante simples, em memória do processo. É o que faz sentido
 * para esta arquitectura e convém dizer porquê, para que ninguém o tome
 * por mais do que é:
 *
 *   · a stack self-hosted corre UM container `web`. Um contador em
 *     memória cobre-o inteiro;
 *   · com várias réplicas, cada uma teria o seu contador e o limite
 *     efectivo multiplicava. Nesse dia isto passa para o PostgreSQL ou
 *     para um Redis — a assinatura não muda;
 *   · reiniciar o container limpa os contadores. Aceitável: isto não é
 *     uma defesa contra um atacante determinado (a autenticação é que
 *     é), é uma rede contra repetição acidental e contra scripts em
 *     ciclo.
 *
 * O que protege de verdade: `tenant:create` cria uma base de dados e
 * corre migrations. Um duplo-clique no wizard, ou um `for` mal escrito,
 * chegava para deixar bases órfãs a ocupar disco. O limite aperta esse
 * caso concreto.
 *
 * A chave inclui o token: dois operadores com tokens diferentes não se
 * bloqueiam um ao outro. NUNCA se guarda o token em claro — só um hash
 * curto, porque as chaves deste mapa aparecem em traces de memória.
 */

import { createHash } from "node:crypto";

export type RateLimitDecision = {
  allowed: boolean;
  /** Pedidos ainda disponíveis na janela actual. */
  remaining: number;
  /** Segundos até a janela abrir espaço — 0 quando `allowed`. */
  retryAfterSec: number;
};

type Bucket = { hits: number[] };

const buckets = new Map<string, Bucket>();

/** Hash curto e estável, para não guardar o token em claro na memória. */
function tokenFingerprint(token: string | null): string {
  if (!token) return "anon";
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

/**
 * rateLimit — regista um pedido e decide se passa.
 *
 * @param scope   nome da operação (ex.: "create-tenant"). Cada scope tem
 *                o seu balde: listar tenants não consome a quota de os
 *                criar.
 * @param token   bearer do pedido, ou null.
 * @param limit   pedidos permitidos na janela.
 * @param windowMs duração da janela.
 */
export function rateLimit(
  scope: string,
  token: string | null,
  limit: number,
  windowMs: number,
  /**
   * `false` verifica sem consumir. Existe porque um pedido recusado na
   * validação (slug vazio, email inválido) não deve gastar quota: essas
   * respostas são baratas, e gastá-las esgotava o limite antes de haver
   * uma única criação a sério. Confirmado em teste live — quatro erros
   * de validação seguidos e a criação legítima levava 429.
   */
  record = true
): RateLimitDecision {
  const key = `${scope}:${tokenFingerprint(token)}`;
  const now = Date.now();
  const cutoff = now - windowMs;

  const bucket = buckets.get(key) ?? { hits: [] };
  // Descarta o que saiu da janela. A lista é curta por construção (nunca
  // passa de `limit` elementos), portanto o filtro é barato.
  bucket.hits = bucket.hits.filter((t) => t > cutoff);

  if (bucket.hits.length >= limit) {
    const oldest = bucket.hits[0];
    buckets.set(key, bucket);
    return {
      allowed: false,
      remaining: 0,
      retryAfterSec: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)),
    };
  }

  if (record) bucket.hits.push(now);
  buckets.set(key, bucket);

  // Limpeza oportunista: sem isto, um token usado uma vez ficava no mapa
  // para sempre. Corre raramente e só percorre o que já existe.
  if (buckets.size > 512) {
    for (const [k, b] of buckets) {
      if (b.hits.every((t) => t <= cutoff)) buckets.delete(k);
    }
  }

  return { allowed: true, remaining: limit - bucket.hits.length, retryAfterSec: 0 };
}

/** Extrai o bearer sem validar — só para derivar a chave do balde. */
export function bearerOf(req: { headers: { get(name: string): string | null } }): string | null {
  const raw = req.headers.get("authorization");
  if (!raw) return null;
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return m ? m[1].trim() : null;
}

/** Só para testes: esvazia o estado entre casos. */
export function __resetRateLimitState(): void {
  buckets.clear();
}
