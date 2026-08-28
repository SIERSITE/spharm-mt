"use server";

import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getPrisma } from "@/lib/prisma";
import { createSessionToken, LEGACY_TENANT } from "@/lib/auth";
import { resolveCurrentTenantSlug } from "@/lib/tenant-context";
import { sessionCookieOptions } from "@/lib/runtime-config";

type LoginState = {
  error: string;
};

/**
 * Autenticação de um utilizador do tenant.
 *
 * ─────────────────────────────────────────────────────────────────────
 * O QUE NÃO SE REGISTA, E PORQUÊ
 *
 * Este caminho teve durante mais de dois meses um bloco de diagnóstico
 * que escrevia, por cada tentativa de login, um JSON com o email, o
 * comprimento da password, o resultado do `bcrypt.compare`, o prefixo do
 * hash e a base de dados ligada. Foi acrescentado para investigar um
 * problema de resolução de tenant num alojamento que já não é o nosso, e
 * ficou marcado "REMOVER depois do diagnóstico concluído".
 *
 * Um log de autenticação que diz QUEM tentou entrar e SE acertou na
 * password é um registo de quem tem conta e de quando alguém falhou —
 * material útil a quem não devia tê-lo, guardado onde ninguém o
 * procura. E o comprimento da password é informação sobre a password.
 *
 * O que fica: nada por tentativa. Quem precisa de saber que houve um
 * login tem a `AuditLog` e o campo `ultimoLogin`, que são registos com
 * dono, retenção e um sítio próprio.
 *
 * Não se regista, nem aqui nem em lado nenhum deste ficheiro: a
 * password, o `passwordHash`, qualquer parte de um deles, ou a string de
 * ligação à base de dados.
 */
export async function loginAction(
  _prevState: LoginState,
  formData: FormData
): Promise<LoginState> {
  // O EMAIL normaliza-se; a PASSWORD não.
  //
  // Um email é um identificador: " F.Silveirense@Gmail.com " e
  // "f.silveirense@gmail.com" são a mesma pessoa, e a base guarda a
  // forma normalizada. Uma password é uma sequência exacta de
  // caracteres — se alguém a definiu com um espaço no fim, o espaço é
  // parte dela.
  //
  // ── O QUE ISTO REPARA, E FOI MEDIDO ────────────────────────────────
  //
  // Aqui fazia-se `.trim()`; nas escritas — `createUtilizador`,
  // `updateUtilizador`, `alterarPassword` — não se fazia. O hash ficava
  // sobre `"segredo "` e a comparação era sempre contra `"segredo"`.
  // Quem definisse uma password com um espaço nas pontas ficava de fora
  // da sua conta para sempre, com a mensagem "Credenciais inválidas" a
  // apontar para o sítio errado. Nenhum dos dois lados estava errado
  // sozinho: era a diferença entre eles.
  //
  // A regra passa a ser a mesma nos quatro caminhos: NUNCA se apara uma
  // password. Ver lib/password-policy.ts.
  const email = String(formData.get("email") || "").trim().toLowerCase();
  const password = String(formData.get("password") || "");

  if (!email || !password) {
    return { error: "Preencha o email e a password." };
  }

  const prisma = await getPrisma();

  const utilizador = await prisma.utilizador.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      nome: true,
      perfil: true,
      farmaciaId: true,
      estado: true,
      passwordHash: true,
      mustChangePassword: true,
    },
  });

  // A MESMA mensagem para utilizador inexistente, sem password definida,
  // conta inactiva e password errada. Distingui-las diria a quem tenta
  // qual dos quatro é — e isso é meio caminho andado.
  if (!utilizador || !utilizador.passwordHash || utilizador.estado !== "ATIVO") {
    return { error: "Credenciais inválidas." };
  }

  const passwordConfere = await bcrypt.compare(password, utilizador.passwordHash);
  if (!passwordConfere) {
    return { error: "Credenciais inválidas." };
  }

  // Vincula a sessão ao tenant em que o login foi efectuado. Em cada
  // request autenticado, o portão do middleware compara este claim com o
  // tenant resolvido do request — se não bater, a sessão não vale.
  const tenant = (await resolveCurrentTenantSlug()) ?? LEGACY_TENANT;

  const token = await createSessionToken({
    sub: utilizador.id,
    email: utilizador.email,
    nome: utilizador.nome,
    perfil: utilizador.perfil,
    farmaciaId: utilizador.farmaciaId ?? null,
    tenant,
    // Vai no TOKEN porque quem o verifica é o middleware, em Edge, sem
    // acesso à base de dados. É isto que torna o bloqueio impossível de
    // contornar escrevendo outra rota no browser.
    mustChangePassword: utilizador.mustChangePassword === true,
  });

  const cookieStore = await cookies();
  // `secure: false` estava fixo no código: correcto em HTTP, e uma falha
  // de segurança assim que houvesse TLS. Passa a vir de
  // SESSION_COOKIE_SECURE / PUBLIC_APP_URL — ver lib/runtime-config.ts.
  // O maxAge acompanha a expiração do JWT (8h) definida em lib/auth.ts.
  cookieStore.set("session", token, sessionCookieOptions(60 * 60 * 8));

  // Password reposta por um administrador: o destino é a troca, não o
  // dashboard. O middleware bloqueava na mesma, mas mandar directo poupa
  // um salto e diz ao utilizador o que se passa à primeira.
  redirect(utilizador.mustChangePassword === true ? "/alterar-password" : "/dashboard");
}
