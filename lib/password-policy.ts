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
