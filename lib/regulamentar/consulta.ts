/**
 * lib/regulamentar/consulta.ts
 *
 * Leitura dos dados regulamentares do INFARMED (versão ATIVA). Só leitura:
 * nenhuma função aqui escreve. A ligação ao catálogo é `ProdutoRegulamentar.produtoId`
 * (obtida por CNP na importação), e a versão em vigor é a de `InfarmedImportacao.ativa`.
 */

import type { PrismaClient } from "@/generated/prisma/client";

export type FichaRegulamentar = {
  cnpem: string | null;
  substanciaAtiva: string | null;
  nomeMedicamento: string | null;
  formaFarmaceutica: string | null;
  dosagem: string | null;
  tamanhoEmbalagem: string | null;
  /** PVP regulamentar numérico; NULL quando o preço é livre ou não existe. */
  pvp: number | null;
  precoLivre: boolean;
  pvpNotificado: number | null;
  /** Preço do utente — regime geral. */
  precoUtenteGeral: number | null;
  /** Preço do utente — regime especial (pensionistas). */
  precoUtenteEspecial: number | null;
  estadoComercializacao: string | null;
  generico: boolean | null;
  /** false = deixou de constar do ficheiro; os valores são os da última versão em que constou. */
  presenteNoFicheiro: boolean;
  atualizadoEm: Date;
  versao: { importacaoId: string; sha256: string; origem: string; descarregadoEm: Date };
};

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

type LinhaComVersao = {
  cnpem: string | null;
  substanciaAtiva: string | null;
  nomeMedicamento: string | null;
  formaFarmaceutica: string | null;
  dosagem: string | null;
  tamanhoEmbalagem: string | null;
  pvp: unknown;
  precoLivre: boolean;
  pvpNotificado: unknown;
  precoUtenteGeral: unknown;
  precoUtenteEspecial: unknown;
  estadoComercializacao: string | null;
  generico: boolean | null;
  presenteNoFicheiro: boolean;
  atualizadoEm: Date;
  importacao: { id: string; sha256: string; origem: string; descarregadoEm: Date };
};

function paraFicha(r: LinhaComVersao): FichaRegulamentar {
  return {
    cnpem: r.cnpem,
    substanciaAtiva: r.substanciaAtiva,
    nomeMedicamento: r.nomeMedicamento,
    formaFarmaceutica: r.formaFarmaceutica,
    dosagem: r.dosagem,
    tamanhoEmbalagem: r.tamanhoEmbalagem,
    pvp: num(r.pvp),
    precoLivre: r.precoLivre,
    pvpNotificado: num(r.pvpNotificado),
    precoUtenteGeral: num(r.precoUtenteGeral),
    precoUtenteEspecial: num(r.precoUtenteEspecial),
    estadoComercializacao: r.estadoComercializacao,
    generico: r.generico,
    presenteNoFicheiro: r.presenteNoFicheiro,
    atualizadoEm: r.atualizadoEm,
    versao: {
      importacaoId: r.importacao.id,
      sha256: r.importacao.sha256,
      origem: r.importacao.origem,
      descarregadoEm: r.importacao.descarregadoEm,
    },
  };
}

/** Ficha regulamentar ativa de um produto, ou null se nunca foi associada. */
export async function carregarFichaRegulamentar(prisma: PrismaClient, produtoId: string): Promise<FichaRegulamentar | null> {
  const r = await prisma.produtoRegulamentar.findFirst({
    where: { produtoId, importacao: { ativa: true } },
    include: { importacao: { select: { id: true, sha256: true, origem: true, descarregadoEm: true } } },
  });
  return r ? paraFicha(r) : null;
}
