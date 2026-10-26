"use server";

/**
 * app/stock/artigo/designacao-actions.ts
 *
 * Server Actions da correção MANUAL da designação na ficha do artigo (Stock e Catálogo usam estas mesmas ações). Só
 * autenticam/autorizam e delegam em `lib/catalogo/designacao-ficha.ts` (validação, transação, proteção manual, auditoria).
 *
 * Autorização: `catalog.write` (o mesmo modelo da manutenção do catálogo e do fabricante). Isolamento por tenant: o cliente
 * Prisma vem de `getPrisma()` (tenant da SESSÃO); o tenant gravado na auditoria vem do pedido autenticado, nunca do cliente.
 */
import { getSession } from "@/lib/auth";
import { can } from "@/lib/permissions-core";
import { getPrisma } from "@/lib/prisma";
import { resolveCurrentTenantSlug } from "@/lib/tenant-context";
import {
  aplicarDesignacaoFicha,
  permitirAtualizacaoDesignacao,
  validarDesignacao,
  type ResultadoAplicarDesignacao,
  type ResultadoPermitirDesignacao,
} from "@/lib/catalogo/designacao-ficha";

async function guarda() {
  const session = await getSession();
  if (!session) return { ok: false as const, mensagem: "Sessão expirada. Entre novamente." };
  if (!can(session, "catalog.write")) return { ok: false as const, mensagem: "Sem permissão para alterar o catálogo." };
  return { ok: true as const, session, tenant: (await resolveCurrentTenantSlug()) ?? "desconhecido" };
}

/** Validação para o formulário (mensagem imediata); a escrita revalida sempre no servidor. */
export async function validarDesignacaoAction(texto: string): Promise<{ ok: true; valor: string } | { ok: false; mensagem: string }> {
  const g = await guarda();
  if (!g.ok) return g;
  return validarDesignacao(String(texto ?? "").slice(0, 2000));
}

export async function aplicarDesignacaoFichaAction(input: {
  cnp: number;
  designacaoAnterior: string;
  nova: string;
  confirmado: boolean;
}): Promise<ResultadoAplicarDesignacao | { ok: false; codigo: "sem_permissao"; mensagem: string }> {
  const g = await guarda();
  if (!g.ok) return { ok: false, codigo: "sem_permissao", mensagem: g.mensagem };
  if (!Number.isInteger(input.cnp) || input.cnp <= 0) return { ok: false, codigo: "sem_produto", mensagem: "CNP inválido." };
  return aplicarDesignacaoFicha(await getPrisma(), {
    cnp: input.cnp,
    designacaoAnterior: String(input.designacaoAnterior ?? ""),
    nova: String(input.nova ?? "").slice(0, 2000),
    confirmado: input.confirmado === true,
    ator: { id: g.session.sub },
    tenant: g.tenant,
  });
}

export async function permitirAtualizacaoDesignacaoAction(input: {
  cnp: number;
  confirmado: boolean;
}): Promise<ResultadoPermitirDesignacao | { ok: false; codigo: "sem_permissao"; mensagem: string }> {
  const g = await guarda();
  if (!g.ok) return { ok: false, codigo: "sem_permissao", mensagem: g.mensagem };
  if (!Number.isInteger(input.cnp) || input.cnp <= 0) return { ok: false, codigo: "sem_produto", mensagem: "CNP inválido." };
  return permitirAtualizacaoDesignacao(await getPrisma(), {
    cnp: input.cnp,
    confirmado: input.confirmado === true,
    ator: { id: g.session.sub },
    tenant: g.tenant,
  });
}
