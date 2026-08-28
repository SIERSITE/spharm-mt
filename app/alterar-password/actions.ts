"use server";

import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getPrisma } from "@/lib/prisma";
import { getSession, createSessionToken } from "@/lib/auth";
import { sessionCookieOptions } from "@/lib/runtime-config";
import { logAudit } from "@/lib/audit";
import { validarNovaPassword } from "@/lib/password-policy";

/**
 * Troca da password pelo próprio utilizador.
 *
 * ─────────────────────────────────────────────────────────────────────
 * O DEFEITO QUE ISTO FECHA
 *
 * `mustChangePassword` existia no schema desde o início, era escrito por
 * todos os caminhos de reset — o script `admin:reset-user-password`, a
 * acção `resetPasswordUtilizador`, a criação de tenants — e NUNCA era
 * lido para decidir nada. O login lia-o apenas para o incluir num log de
 * diagnóstico e depois redireccionava para /dashboard na mesma.
 *
 * Pior: não havia página nenhuma para trocar a password. O utilizador
 * não era forçado a trocar E não podia trocar mesmo que quisesse. A
 * password temporária que um administrador lhe desse por telefone era a
 * password definitiva, e ficava a valer até alguém fazer novo reset.
 *
 * As duas mensagens que o sistema mostrava — "Será forçado a definir
 * nova password" no script, "Será forçado a alterar no próximo login" na
 * interface — eram ambas falsas.
 *
 * ─────────────────────────────────────────────────────────────────────
 * PORQUE É QUE A PASSWORD ACTUAL É PEDIDA
 *
 * Não é cerimónia. Um cookie de sessão roubado permitiria, sem isto,
 * mudar a password da vítima e tomar a conta de vez. Pedir a actual
 * transforma um roubo de sessão (temporário, 8h) em algo que continua
 * temporário.
 */

/** O que a página mostra ao utilizador. Nunca mais do que isto. */
export type EstadoTroca = { erro?: string };

export async function alterarPassword(
  _anterior: EstadoTroca,
  formData: FormData,
): Promise<EstadoTroca> {
  const sessao = await getSession();
  if (!sessao) redirect("/login");

  const actual = String(formData.get("actual") ?? "");
  const nova = String(formData.get("nova") ?? "");
  const confirmacao = String(formData.get("confirmacao") ?? "");

  const regras = validarNovaPassword(actual, nova, confirmacao);
  if (!regras.ok) return { erro: regras.erro };

  const prisma = await getPrisma();
  const utilizador = await prisma.utilizador.findUnique({
    where: { id: sessao.sub },
    select: { id: true, email: true, nome: true, perfil: true, farmaciaId: true, estado: true, passwordHash: true },
  });

  // A sessão é válida mas o utilizador pode ter sido desactivado entre o
  // login e agora.
  if (!utilizador || utilizador.estado !== "ATIVO" || !utilizador.passwordHash) {
    redirect("/login");
  }

  const confere = await bcrypt.compare(actual, utilizador.passwordHash);
  if (!confere) {
    return { erro: "A password actual não está correcta." };
  }

  // Mesmo custo que o resto da aplicação usa — login, reset por CLI,
  // reset pela interface. Um custo diferente aqui seria uma password
  // mais fraca ou mais lenta do que todas as outras, sem ninguém saber.
  const passwordHash = await bcrypt.hash(nova, 10);
  await prisma.utilizador.update({
    where: { id: utilizador.id },
    data: { passwordHash, mustChangePassword: false },
  });

  await logAudit({
    actorId: utilizador.id,
    action: "user.password_changed",
    entity: "Utilizador",
    entityId: utilizador.id,
    meta: { email: utilizador.email },
  });

  // O TOKEN TEM DE SER REEMITIDO.
  //
  // O `mustChangePassword` que o middleware lê está no JWT, não na base
  // de dados — é o que lhe permite decidir sem tocar em Postgres. Se o
  // cookie antigo ficasse, o utilizador continuava a ser mandado para
  // esta página depois de já ter trocado, até a sessão expirar.
  const token = await createSessionToken({
    sub: utilizador.id,
    email: utilizador.email,
    nome: utilizador.nome,
    perfil: utilizador.perfil,
    farmaciaId: utilizador.farmaciaId ?? null,
    tenant: sessao.tenant,
    mustChangePassword: false,
  });
  const cookieStore = await cookies();
  cookieStore.set("session", token, sessionCookieOptions(60 * 60 * 8));

  redirect("/dashboard");
}
