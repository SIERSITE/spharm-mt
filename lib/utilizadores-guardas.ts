/**
 * lib/utilizadores-guardas.ts
 *
 * As regras da gestão de utilizadores, em funções puras.
 *
 * ─────────────────────────────────────────────────────────────────────
 * PORQUE É QUE ISTO VIVE À PARTE
 *
 * As regras estavam dentro das server actions, misturadas com Prisma e
 * com `revalidatePath`. Uma regra assim só se pode exercitar montando
 * uma base de dados e uma sessão — e por isso nunca era exercitada. Foi
 * exactamente aí que se perderam duas: um GESTOR_GRUPO podia despromover
 * um administrador, e uma password curta era ignorada em silêncio com a
 * interface a dizer "guardado".
 *
 * Aqui não há base de dados, não há sessão e não há `server-only`: o
 * mesmo módulo serve o servidor (que decide) e o cliente (que esconde os
 * botões), e os testes chamam-no directamente.
 *
 * ─────────────────────────────────────────────────────────────────────
 * DEFESA EM PROFUNDIDADE
 *
 * Esconder o botão não é uma defesa — uma server action é um endpoint
 * HTTP e pode ser invocada directamente. Estas funções são chamadas
 * DENTRO de cada acção, antes de qualquer escrita, e são a defesa a
 * sério. O que a interface faz com elas é cosmética por cima.
 */
import { MIN_CARACTERES } from "@/lib/password-policy";

export type PerfilUtilizador =
  | "ADMINISTRADOR"
  | "GESTOR_GRUPO"
  | "GESTOR_FARMACIA"
  | "OPERADOR";

export type Veredicto = { ok: true } | { ok: false; erro: string };

const OK: Veredicto = { ok: true };

/**
 * Os perfis que podem gerir contas de outras pessoas.
 *
 * É uma lista de um elemento de propósito. Ter a constante — em vez de
 * comparar com a string em cinco sítios — significa que alargar isto um
 * dia é uma linha, e que os testes verificam a lista e não cinco cópias
 * dela.
 */
export const PERFIS_QUE_GEREM_UTILIZADORES: readonly PerfilUtilizador[] = [
  "ADMINISTRADOR",
];

export function podeGerirUtilizadores(perfil: string | null | undefined): boolean {
  if (!perfil) return false;
  return PERFIS_QUE_GEREM_UTILIZADORES.includes(perfil as PerfilUtilizador);
}

/** A recusa que qualquer acção de gestão devolve a quem não pode. */
export const ERRO_SEM_GESTAO =
  "Não tem permissão para gerir utilizadores. Só um Administrador o pode fazer.";

export function exigirGestaoUtilizadores(
  perfilDoActor: string | null | undefined,
): Veredicto {
  return podeGerirUtilizadores(perfilDoActor)
    ? OK
    : { ok: false, erro: ERRO_SEM_GESTAO };
}

/**
 * A password escrita por um administrador no formulário de utilizadores.
 *
 * ── O DEFEITO QUE ISTO FECHA ────────────────────────────────────────
 *
 * O `updateUtilizador` escrevia a password apenas `if (input.password &&
 * input.password.length >= 8)`. Abaixo disso saltava a escrita — e
 * devolvia `{ ok: true }`. A interface dizia "guardado", a password
 * ficava a anterior, e ninguém ficava a saber. O `createUtilizador`
 * recusava com mensagem; o update calava-se.
 *
 * ── NÃO HÁ `trim` AQUI ──────────────────────────────────────────────
 *
 * Uma password é uma sequência exacta de caracteres. Se alguém quiser
 * espaços nas pontas, são parte da password. Por isso `"   "` tem três
 * caracteres e é recusada por ser curta — não por ser "vazia depois de
 * limpar". A string vazia, e só ela, significa "não alterar".
 *
 * @param obrigatoria criação (true) exige password; edição (false)
 *   aceita campo vazio como "manter a actual".
 */
export function validarPasswordAdministrativa(
  password: string | null | undefined,
  obrigatoria: boolean,
): Veredicto {
  const ausente = password === undefined || password === null || password === "";
  if (ausente) {
    return obrigatoria
      ? {
          ok: false,
          erro: `Defina uma password com pelo menos ${MIN_CARACTERES} caracteres.`,
        }
      : OK;
  }
  if (password.length < MIN_CARACTERES) {
    return {
      ok: false,
      erro: `A password tem de ter pelo menos ${MIN_CARACTERES} caracteres. Nada foi guardado.`,
    };
  }
  return OK;
}

/** `true` quando o campo preenchido deve dar origem a uma escrita. */
export function devePersistirPassword(
  password: string | null | undefined,
): password is string {
  return typeof password === "string" && password.length > 0;
}

/**
 * Alterações de perfil que deixariam a instalação sem quem a administre.
 *
 * Duas situações, ambas vistas em produção ou a um passo dela:
 *
 *   1. Um administrador despromove-se a si próprio. Perde `users.manage`
 *      no mesmo instante e deixa de se conseguir repor — o perfil que
 *      lhe falta é precisamente o que era preciso para o devolver.
 *
 *   2. O último administrador é despromovido por quem quer que seja.
 *      A partir daí ninguém no tenant pode criar contas, repor passwords
 *      ou reactivar alguém, e a única saída é SQL directo na base.
 *
 * @param totalAdministradoresAtivos administradores ATIVOS antes desta
 *   alteração, o alvo incluído.
 */
export function validarAlteracaoDePerfil(args: {
  actorId: string;
  actorPerfil: string;
  alvoId: string;
  alvoPerfilActual: string;
  perfilPedido: string;
  totalAdministradoresAtivos: number;
}): Veredicto {
  const {
    actorId,
    alvoId,
    alvoPerfilActual,
    perfilPedido,
    totalAdministradoresAtivos,
  } = args;

  const perdeAdministracao =
    alvoPerfilActual === "ADMINISTRADOR" && perfilPedido !== "ADMINISTRADOR";
  if (!perdeAdministracao) return OK;

  if (actorId === alvoId) {
    return {
      ok: false,
      erro:
        "Não se pode retirar a si próprio o perfil Administrador — ficaria sem forma de o repor. Peça a outro administrador.",
    };
  }
  if (totalAdministradoresAtivos <= 1) {
    return {
      ok: false,
      erro:
        "Esta é a última conta com perfil Administrador activa. Promova outra antes de despromover esta.",
    };
  }
  return OK;
}

/**
 * Desactivar a própria conta tranca a pessoa para fora: o login exige
 * `estado === "ATIVO"`, e reactivar exige `users.manage`.
 */
export function validarAlteracaoDeEstado(args: {
  actorId: string;
  alvoId: string;
  alvoPerfil: string;
  estadoPedido: "ATIVO" | "INATIVO";
  totalAdministradoresAtivos: number;
}): Veredicto {
  const { actorId, alvoId, alvoPerfil, estadoPedido, totalAdministradoresAtivos } =
    args;
  if (estadoPedido !== "INATIVO") return OK;

  if (actorId === alvoId) {
    return { ok: false, erro: "Não pode desactivar a sua própria conta." };
  }
  if (alvoPerfil === "ADMINISTRADOR" && totalAdministradoresAtivos <= 1) {
    return {
      ok: false,
      erro:
        "Esta é a última conta com perfil Administrador activa. Promova outra antes de desactivar esta.",
    };
  }
  return OK;
}
