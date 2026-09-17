"use server";

/**
 * app/vendas/manutencao/actions.ts
 *
 * Server Actions da Manutenção de Vendas. Cada uma exige `reports.write`
 * — a mesma permissão que já governa emitir/gravar em Vendas/Encomendas
 * — porque uma manutenção altera o que o mapa de Vendas mostra, tal
 * como criar uma encomenda altera o que se propõe comprar.
 */
import { revalidatePath } from "next/cache";
import { getPrisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { getFarmaciasInfo } from "@/lib/farmacias-info";
import {
  anularManutencao,
  calcularDistribuicaoQuantidades,
  criarManutencao,
  gerarPropostaCompleta,
  guardarCelulasAjustadas,
  listarManutencoes,
  obterManutencao,
  substituirDistribuicao,
} from "@/lib/vendas-manutencao-data";
import { validarPvpReferencia, validarSomaTotal } from "@/lib/vendas-manutencao/validacao";
import type {
  CelulaManutencao,
  EstadoManutencao,
  FarmaciaComPvpReferencia,
  ManutencaoDetalhe,
  ManutencaoResumo,
  OrigemDistribuicao,
  PropostaCompleta,
  PropostaDistribuicao,
} from "@/lib/vendas-manutencao/tipos";

export async function listarManutencoesAction(
  estado?: EstadoManutencao,
): Promise<ManutencaoResumo[]> {
  await requirePermission("reports.write");
  const prisma = await getPrisma();
  return listarManutencoes(prisma, estado ? { estado } : undefined);
}

export async function obterManutencaoAction(id: string): Promise<ManutencaoDetalhe | null> {
  await requirePermission("reports.write");
  const prisma = await getPrisma();
  return obterManutencao(prisma, id);
}

export type ParametrosDistribuicao = {
  produtoId: string;
  quantidadeTotal: number;
  numMeses: number;
  mesInicialAno: number;
  mesInicialMes: number;
};

function validarParametros(p: ParametrosDistribuicao): string | null {
  if (!p.produtoId) return "Escolhe um artigo.";
  if (!Number.isFinite(p.quantidadeTotal) || p.quantidadeTotal <= 0) return "A quantidade tem de ser maior que zero.";
  if (!Number.isInteger(p.numMeses) || p.numMeses < 1 || p.numMeses > 36) return "O número de meses tem de estar entre 1 e 36.";
  if (!Number.isInteger(p.mesInicialMes) || p.mesInicialMes < 1 || p.mesInicialMes > 12) return "Mês inicial inválido.";
  if (!Number.isInteger(p.mesInicialAno) || p.mesInicialAno < 2000) return "Ano inicial inválido.";
  return null;
}

/**
 * Calcula a proposta COMPLETA — distribuição + PVP de referência
 * capturado agora. NUNCA persiste. Ver secção 1.1/1.4 do pedido.
 *
 * Só usada na CRIAÇÃO. Para recalcular uma manutenção EXISTENTE (onde
 * o PVP de referência tem de ficar exactamente como estava — secção 5
 * do pedido), ver `recalcularDistribuicaoAction`.
 */
export async function gerarPropostaAction(
  params: ParametrosDistribuicao,
): Promise<{ ok: true; proposta: PropostaCompleta } | { ok: false; erro: string }> {
  await requirePermission("reports.write");
  const erro = validarParametros(params);
  if (erro) return { ok: false, erro };

  const prisma = await getPrisma();
  const farmacias = await getFarmaciasInfo();
  const proposta = await gerarPropostaCompleta(prisma, {
    produtoId: params.produtoId,
    farmacias: farmacias.map((f) => ({ id: f.id, nome: f.nome })),
    quantidadeTotal: params.quantidadeTotal,
    numMeses: params.numMeses,
    mesInicialAno: params.mesInicialAno,
    mesInicialMes: params.mesInicialMes,
  });
  return { ok: true, proposta };
}

/**
 * Recalcula SÓ a distribuição (peso + meses) de uma manutenção
 * EXISTENTE — nunca toca no PVP de referência, que fica exactamente o
 * já persistido em `VendaManutencaoFarmacia` (secção 5 do pedido: "para
 * a primeira versão, mantém o PVP de referência original numa
 * edição"). Usada pelo botão "Recalcular" do ecrã de edição.
 */
export async function recalcularDistribuicaoAction(
  params: ParametrosDistribuicao,
): Promise<{ ok: true; proposta: PropostaDistribuicao } | { ok: false; erro: string }> {
  await requirePermission("reports.write");
  const erro = validarParametros(params);
  if (erro) return { ok: false, erro };

  const prisma = await getPrisma();
  const farmacias = await getFarmaciasInfo();
  const proposta = await calcularDistribuicaoQuantidades(prisma, {
    produtoId: params.produtoId,
    farmacias: farmacias.map((f) => ({ id: f.id, nome: f.nome })),
    quantidadeTotal: params.quantidadeTotal,
    numMeses: params.numMeses,
    mesInicialAno: params.mesInicialAno,
    mesInicialMes: params.mesInicialMes,
  });
  return { ok: true, proposta };
}

export type GravarNovaManutencaoInput = ParametrosDistribuicao & {
  cnp: number;
  origemDistribuicao: OrigemDistribuicao;
  celulas: CelulaManutencao[];
  farmaciasPvp: FarmaciaComPvpReferencia[];
};

export async function criarManutencaoAction(
  input: GravarNovaManutencaoInput,
): Promise<{ ok: true; id: string } | { ok: false; erro: string }> {
  const session = await requirePermission("reports.write");

  const erroParametros = validarParametros(input);
  if (erroParametros) return { ok: false, erro: erroParametros };

  const validacaoSoma = validarSomaTotal(input.celulas, input.quantidadeTotal);
  if (!validacaoSoma.ok) {
    return {
      ok: false,
      erro: `A soma das células (${validacaoSoma.soma}) não bate com a quantidade total (${validacaoSoma.quantidadeTotal}). Diferença: ${validacaoSoma.diferenca}.`,
    };
  }

  // Secção 6 — nunca gravar uma farmácia com quantidade atribuída e sem
  // PVP de referência válido (nunca 0 como substituto silencioso).
  const validacaoPvp = validarPvpReferencia(input.celulas, input.farmaciasPvp);
  if (!validacaoPvp.ok) {
    const nomes = validacaoPvp.farmaciasSemPvp
      .map((id) => input.farmaciasPvp.find((f) => f.farmaciaId === id)?.farmaciaNome ?? id)
      .join(", ");
    return {
      ok: false,
      erro: `Falta o PVP de referência para: ${nomes}. Indica um valor antes de gravar — nunca é assumido 0.`,
    };
  }

  const prisma = await getPrisma();
  const id = await criarManutencao(prisma, {
    produtoId: input.produtoId,
    cnp: input.cnp,
    quantidadeTotal: input.quantidadeTotal,
    numMeses: input.numMeses,
    mesInicialAno: input.mesInicialAno,
    mesInicialMes: input.mesInicialMes,
    origemDistribuicao: input.origemDistribuicao,
    celulas: input.celulas.map((c) => ({
      farmaciaId: c.farmaciaId,
      ano: c.ano,
      mes: c.mes,
      quantidade: c.quantidade,
    })),
    farmaciasPvp: input.farmaciasPvp.map((f) => ({
      farmaciaId: f.farmaciaId,
      pvpReferencia: f.pvpReferencia,
    })),
    criadoPorId: session.sub,
  });

  await logAudit({
    actorId: session.sub,
    action: "venda_manutencao.created",
    entity: "VendaManutencao",
    entityId: id,
    meta: {
      cnp: input.cnp,
      quantidadeTotal: input.quantidadeTotal,
      numMeses: input.numMeses,
      origemDistribuicao: input.origemDistribuicao,
      pvpReferencia: Object.fromEntries(input.farmaciasPvp.map((f) => [f.farmaciaNome, f.pvpReferencia])),
    },
  });

  revalidatePath("/vendas/manutencao");
  return { ok: true, id };
}

export type RecalcularEGuardarInput = ParametrosDistribuicao & {
  id: string;
  celulas: CelulaManutencao[];
  /** Só para a validação do PVP em falta — nunca gravado por esta acção. */
  farmaciasPvp: FarmaciaComPvpReferencia[];
};

/**
 * Persiste o resultado de um "Recalcular" explícito (secção 1.10) —
 * substitui a distribuição anterior e volta a
 * `origemDistribuicao: "AUTOMATICA"`. O PVP de referência (secção 5)
 * NUNCA é tocado aqui — `substituirDistribuicao` só mexe em células.
 */
export async function guardarRecalculoAction(
  input: RecalcularEGuardarInput,
): Promise<{ ok: true } | { ok: false; erro: string }> {
  const session = await requirePermission("reports.write");

  const erroParametros = validarParametros(input);
  if (erroParametros) return { ok: false, erro: erroParametros };

  const validacaoSoma = validarSomaTotal(input.celulas, input.quantidadeTotal);
  if (!validacaoSoma.ok) {
    return {
      ok: false,
      erro: `A soma das células (${validacaoSoma.soma}) não bate com a quantidade total (${validacaoSoma.quantidadeTotal}). Diferença: ${validacaoSoma.diferenca}.`,
    };
  }

  const validacaoPvp = validarPvpReferencia(input.celulas, input.farmaciasPvp);
  if (!validacaoPvp.ok) {
    const nomes = validacaoPvp.farmaciasSemPvp
      .map((id) => input.farmaciasPvp.find((f) => f.farmaciaId === id)?.farmaciaNome ?? id)
      .join(", ");
    return {
      ok: false,
      erro: `Falta o PVP de referência para: ${nomes}. A distribuição atribui-lhes quantidade, mas não têm PVP de referência gravado.`,
    };
  }

  const prisma = await getPrisma();
  await substituirDistribuicao(prisma, {
    id: input.id,
    quantidadeTotal: input.quantidadeTotal,
    numMeses: input.numMeses,
    mesInicialAno: input.mesInicialAno,
    mesInicialMes: input.mesInicialMes,
    celulas: input.celulas.map((c) => ({
      farmaciaId: c.farmaciaId,
      ano: c.ano,
      mes: c.mes,
      quantidade: c.quantidade,
    })),
    atualizadoPorId: session.sub,
  });

  await logAudit({
    actorId: session.sub,
    action: "venda_manutencao.recalculada",
    entity: "VendaManutencao",
    entityId: input.id,
    meta: { quantidadeTotal: input.quantidadeTotal, numMeses: input.numMeses },
  });

  revalidatePath("/vendas/manutencao");
  revalidatePath(`/vendas/manutencao/${input.id}`);
  return { ok: true };
}

/**
 * Grava ajustes manuais a células — sem alterar quantidade/nº meses/
 * período. `farmaciasPvp` vem do que já está persistido (nunca
 * editável aqui) — serve só para a validação da secção 6: uma célula
 * editada à mão pode atribuir quantidade a uma farmácia que já não
 * tinha PVP de referência gravado (0 na criação), e isso continua
 * bloqueado.
 */
export async function guardarCelulasAjustadasAction(input: {
  id: string;
  quantidadeTotal: number;
  celulas: CelulaManutencao[];
  farmaciasPvp: FarmaciaComPvpReferencia[];
}): Promise<{ ok: true } | { ok: false; erro: string }> {
  const session = await requirePermission("reports.write");

  const validacaoSoma = validarSomaTotal(input.celulas, input.quantidadeTotal);
  if (!validacaoSoma.ok) {
    return {
      ok: false,
      erro: `A soma das células (${validacaoSoma.soma}) não bate com a quantidade total (${validacaoSoma.quantidadeTotal}). Diferença: ${validacaoSoma.diferenca}.`,
    };
  }

  const validacaoPvp = validarPvpReferencia(input.celulas, input.farmaciasPvp);
  if (!validacaoPvp.ok) {
    const nomes = validacaoPvp.farmaciasSemPvp
      .map((id) => input.farmaciasPvp.find((f) => f.farmaciaId === id)?.farmaciaNome ?? id)
      .join(", ");
    return {
      ok: false,
      erro: `Falta o PVP de referência para: ${nomes}. Não é possível atribuir quantidade a uma farmácia sem PVP de referência.`,
    };
  }

  const prisma = await getPrisma();
  await guardarCelulasAjustadas(prisma, {
    id: input.id,
    celulas: input.celulas.map((c) => ({
      farmaciaId: c.farmaciaId,
      ano: c.ano,
      mes: c.mes,
      quantidade: c.quantidade,
    })),
    atualizadoPorId: session.sub,
  });

  await logAudit({
    actorId: session.sub,
    action: "venda_manutencao.celulas_ajustadas",
    entity: "VendaManutencao",
    entityId: input.id,
  });

  revalidatePath("/vendas/manutencao");
  revalidatePath(`/vendas/manutencao/${input.id}`);
  return { ok: true };
}

export async function anularManutencaoAction(
  id: string,
): Promise<{ ok: true } | { ok: false; erro: string }> {
  const session = await requirePermission("reports.write");
  const prisma = await getPrisma();

  await anularManutencao(prisma, { id, atualizadoPorId: session.sub });

  await logAudit({
    actorId: session.sub,
    action: "venda_manutencao.anulada",
    entity: "VendaManutencao",
    entityId: id,
  });

  revalidatePath("/vendas/manutencao");
  revalidatePath(`/vendas/manutencao/${id}`);
  return { ok: true };
}
