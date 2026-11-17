"use server";

/**
 * app/stock/artigo/renomear-fabricante-actions.ts
 *
 * Server actions de «Editar nome do fabricante» (ficha do artigo). A guarda
 * corre AQUI em cada chamada — esconder o botão não protege nada, uma server
 * action é um endpoint POST que qualquer sessão pode invocar. Mesma função
 * que a página usa para mostrar o botão (`podeRenomearFabricante`).
 *
 * Nada do que vem do browser decide o tenant nem o fabricante: o cliente
 * Prisma é o do tenant do pedido (`getPrisma()`), o tenant gravado na
 * auditoria vem do pedido autenticado, e o fabricante é o do artigo (CNP).
 */
import { revalidatePath } from "next/cache";
import { getSession } from "@/lib/auth";
import { getPrisma } from "@/lib/prisma";
import { resolveCurrentTenantSlug } from "@/lib/tenant-context";
import { podeRenomearFabricante } from "@/lib/catalogo/fabricante-renomear-scope";
import {
  aplicarEdicaoFabricante,
  previsualizarEdicaoFabricante,
  type ModoEdicaoFabricante,
  type PreviewEdicaoFabricante,
  type ResultadoEdicaoFabricante,
} from "@/lib/catalogo/fabricante-renomear";

const SEM_PERMISSAO = "Sem permissão para editar o nome do fabricante.";
const MAX_NOME = 300;

async function autorizar() {
  const session = await getSession();
  const tenant = await resolveCurrentTenantSlug();
  if (!session || !tenant || !podeRenomearFabricante(session, tenant)) return null;
  return { session, tenant };
}

const cnpValido = (cnp: unknown): cnp is number => typeof cnp === "number" && Number.isSafeInteger(cnp) && cnp > 0;
const nomeValido = (nome: unknown): nome is string => typeof nome === "string" && nome.length <= MAX_NOME;

export async function previsualizarRenomearFabricanteAction(cnp: number, novoNome: string): Promise<PreviewEdicaoFabricante> {
  const auth = await autorizar();
  if (!auth) return { ok: false, erro: SEM_PERMISSAO };
  if (!cnpValido(cnp) || !nomeValido(novoNome)) return { ok: false, erro: "Pedido inválido." };
  return previsualizarEdicaoFabricante(await getPrisma(), { cnp, novoNome });
}

export async function aplicarRenomearFabricanteAction(input: {
  cnp: number;
  novoNome: string;
  modo: ModoEdicaoFabricante;
  artigosConfirmados: number;
}): Promise<ResultadoEdicaoFabricante> {
  const auth = await autorizar();
  if (!auth) return { ok: false, codigo: "INVALIDO", erro: SEM_PERMISSAO };
  if (
    !input ||
    !cnpValido(input.cnp) ||
    !nomeValido(input.novoNome) ||
    (input.modo !== "RENOMEACAO" && input.modo !== "CONSOLIDACAO") ||
    !Number.isSafeInteger(input.artigosConfirmados) ||
    input.artigosConfirmados < 0
  ) {
    return { ok: false, codigo: "INVALIDO", erro: "Pedido inválido." };
  }
  const resultado = await aplicarEdicaoFabricante(await getPrisma(), {
    cnp: input.cnp,
    novoNome: input.novoNome,
    modo: input.modo,
    artigosConfirmados: input.artigosConfirmados,
    actorId: auth.session.sub,
    tenantSlug: auth.tenant,
  });
  if (resultado.ok) {
    // A ficha (e o painel) atualizam já, sem recarregar a página.
    revalidatePath("/stock/artigo/[cnp]", "page");
    revalidatePath("/catalogo");
  }
  return resultado;
}
