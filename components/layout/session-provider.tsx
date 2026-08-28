"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * O utilizador autenticado, disponível aos componentes de cliente.
 *
 * ─────────────────────────────────────────────────────────────────────
 * PORQUE É QUE ISTO EXISTE
 *
 * A barra lateral mostrava "Nuno / Administrador" — três literais
 * escritos à mão no `app-shell.tsx`. Não vinha da sessão, do JWT nem da
 * base de dados: era texto. Não existe nenhum Nuno no tenant `silveira`
 * nem em lado nenhum da aplicação; ficou de uma maquete.
 *
 * A `AppShell` é um componente de CLIENTE, e é renderizada de dois
 * sítios: pela `MainShell` (servidor) e directamente por oito
 * componentes de cliente — devoluções, encomendas, stock, vendas e
 * companhia. Passar o utilizador por props obrigava a atravessar os
 * oito, e bastava esquecer um para voltar a haver um nome inventado.
 *
 * Um contexto colocado no layout raiz resolve os dois casos de uma vez:
 * o servidor lê a sessão UMA vez e todos os consumidores vêem o mesmo.
 *
 * O valor pode ser `null` — no /login não há sessão — e nesse caso a
 * barra lateral não desenha o bloco. NÃO há valor por omissão: um nome
 * de reserva é exactamente o defeito que isto repara.
 */
export type UtilizadorSessao = {
  nome: string;
  email: string;
  perfil: string;
};

const Contexto = createContext<UtilizadorSessao | null>(null);

export function SessionProvider({
  utilizador,
  children,
}: {
  utilizador: UtilizadorSessao | null;
  children: ReactNode;
}) {
  return <Contexto.Provider value={utilizador}>{children}</Contexto.Provider>;
}

/** `null` quando não há sessão. Quem chama decide o que fazer com isso. */
export function useUtilizador(): UtilizadorSessao | null {
  return useContext(Contexto);
}
