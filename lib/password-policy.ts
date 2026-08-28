/**
 * lib/password-policy.ts
 *
 * As regras da nova password, sem base de dados e sem sessão.
 *
 * Vivem à parte porque são a única parte da troca de password que se
 * pode exercitar sem Postgres, sem cookies e sem um pedido HTTP — e
 * porque são a parte onde um engano passa despercebido. Uma confirmação
 * que não é comparada, ou uma password nova igual à temporária aceite em
 * silêncio, deixam o reset por fazer com ar de feito.
 *
 * ─────────────────────────────────────────────────────────────────────
 * A REGRA: UMA PASSWORD NUNCA É APARADA
 *
 * Nem no login, nem na criação, nem no reset, nem na troca. Uma password
 * é uma sequência exacta de caracteres: se alguém a definir com um
 * espaço no início ou no fim, esse espaço faz parte dela e tem de ser
 * escrito na altura de entrar.
 *
 * ── PORQUE É QUE ISTO ESTÁ ESCRITO AQUI ────────────────────────────
 *
 * Porque a regra estava meia aplicada, e meia regra é pior do que
 * nenhuma. O `loginAction` fazia `.trim()`; as três escritas não faziam.
 * O hash ficava sobre `"segredo "` e a comparação era sempre contra
 * `"segredo"` — quem definisse a password com um espaço nas pontas
 * ficava trancado fora da conta para sempre, e a mensagem que via,
 * "Credenciais inválidas", apontava para o sítio errado. Nenhum dos dois
 * lados estava errado sozinho: era a diferença entre eles.
 *
 * O EMAIL continua a ser normalizado — `.trim().toLowerCase()` — porque
 * é um identificador e não um segredo: as duas grafias são a mesma
 * pessoa. Uma password não tem duas grafias.
 *
 * Consequência a assumir: uma password só de espaços é curta, não é
 * vazia. `"   "` tem três caracteres e é recusada pelo mínimo — não por
 * "ficar vazia depois de limpar". Só a string de comprimento zero
 * significa "não alterar".
 */

/** Mínimo de caracteres da nova password. */
export const MIN_CARACTERES = 10;

export type ResultadoValidacao = { ok: true } | { ok: false; erro: string };

export function validarNovaPassword(
  actual: string,
  nova: string,
  confirmacao: string,
): ResultadoValidacao {
  if (!actual || !nova || !confirmacao) {
    return { ok: false, erro: "Preenche os três campos." };
  }
  if (nova !== confirmacao) {
    return { ok: false, erro: "A nova password e a confirmação não coincidem." };
  }
  if (nova.length < MIN_CARACTERES) {
    return {
      ok: false,
      erro: `A nova password tem de ter pelo menos ${MIN_CARACTERES} caracteres.`,
    };
  }
  // Trocar a temporária pela mesma temporária limparia
  // `mustChangePassword` sem nada ter mudado: o utilizador ficava a
  // usar a password que o administrador lhe ditou, e o sistema a dizer
  // que já tinha sido trocada.
  if (nova === actual) {
    return { ok: false, erro: "A nova password tem de ser diferente da actual." };
  }
  return { ok: true };
}
