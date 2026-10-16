"use server";

/**
 * app/stock/artigo/fabricante-actions.ts
 *
 * Server Actions da edição do FABRICANTE na ficha do artigo. Só autenticam/autorizam e delegam em
 * `lib/catalogo/fabricante-ficha.ts` (as regras: duplicados, transação, proteção manual, auditoria).
 *
 * Autorização: `catalog.write` (ADMINISTRADOR e GESTOR_GRUPO — o mesmo modelo da manutenção do catálogo). Utilizadores só de
 * leitura continuam a ver o fabricante e nunca recebem as ações. Isolamento: o cliente Prisma vem de `getPrisma()` (tenant da
 * SESSÃO); o tenant gravado na auditoria vem do pedido autenticado, nunca do cliente.
 */
import { getSession } from "@/lib/auth";
import { can } from "@/lib/permissions-core";
import { getPrisma } from "@/lib/prisma";
import { resolveCurrentTenantSlug } from "@/lib/tenant-context";
import {
  aplicarFabricanteFicha,
  permitirAtualizacaoErp,
  pesquisarFabricantes,
  prepararCriacaoFabricante,
  type FabricanteOpcao,
  type PreparacaoCriacao,
  type ResultadoAplicar,
  type ResultadoPermitirErp,
} from "@/lib/catalogo/fabricante-ficha";

async function guarda() {
  const session = await getSession();
  if (!session) return { ok: false as const, mensagem: "Sessão expirada. Entre novamente." };
  if (!can(session, "catalog.write")) return { ok: false as const, mensagem: "Sem permissão para alterar o catálogo." };
  return { ok: true as const, session, tenant: (await resolveCurrentTenantSlug()) ?? "desconhecido" };
}

export async function pesquisarFabricantesAction(termo: string): Promise<{ ok: true; opcoes: FabricanteOpcao[] } | { ok: false; mensagem: string }> {
  const g = await guarda();
  if (!g.ok) return g;
  if (typeof termo !== "string" || termo.trim().length === 0) return { ok: true, opcoes: [] };
  return { ok: true, opcoes: await pesquisarFabricantes(await getPrisma(), termo.slice(0, 80)) };
}

export async function prepararCriacaoFabricanteAction(nome: string): Promise<(PreparacaoCriacao & { autorizado: true }) | { ok: false; mensagem: string }> {
  const g = await guarda();
  if (!g.ok) return g;
  const r = await prepararCriacaoFabricante(await getPrisma(), String(nome ?? "").slice(0, 120));
  return r.ok ? { ...r, autorizado: true } : { ok: false, mensagem: r.mensagem };
}

export async function aplicarFabricanteFichaAction(input: {
  cnp: number;
  fabricanteAnteriorId: string | null;
  destino: { tipo: "existente"; fabricanteId: string } | { tipo: "novo"; nome: string };
  confirmado: boolean;
}): Promise<ResultadoAplicar | { ok: false; codigo: "sem_permissao"; mensagem: string }> {
  const g = await guarda();
  if (!g.ok) return { ok: false, codigo: "sem_permissao", mensagem: g.mensagem };
  if (!Number.isInteger(input.cnp) || input.cnp <= 0) return { ok: false, codigo: "sem_produto", mensagem: "CNP inválido." };
  return aplicarFabricanteFicha(await getPrisma(), {
    cnp: input.cnp,
    fabricanteAnteriorId: input.fabricanteAnteriorId,
    destino: input.destino.tipo === "novo" ? { tipo: "novo", nome: String(input.destino.nome ?? "").slice(0, 120) } : { tipo: "existente", fabricanteId: String(input.destino.fabricanteId) },
    confirmado: input.confirmado === true,
    ator: { id: g.session.sub },
    tenant: g.tenant,
  });
}

export async function permitirAtualizacaoErpAction(input: {
  cnp: number;
  aplicarValorErp: boolean;
  confirmado: boolean;
}): Promise<ResultadoPermitirErp | { ok: false; codigo: "sem_permissao"; mensagem: string }> {
  const g = await guarda();
  if (!g.ok) return { ok: false, codigo: "sem_permissao", mensagem: g.mensagem };
  if (!Number.isInteger(input.cnp) || input.cnp <= 0) return { ok: false, codigo: "sem_produto", mensagem: "CNP inválido." };
  return permitirAtualizacaoErp(await getPrisma(), {
    cnp: input.cnp,
    aplicarValorErp: input.aplicarValorErp === true,
    confirmado: input.confirmado === true,
    ator: { id: g.session.sub },
    tenant: g.tenant,
  });
}
