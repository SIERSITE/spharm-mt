/**
 * scripts/ops/garantia-manutencoes-vendas/executar.ts
 *
 * Orquestração do dry-run / --apply e do relatório JSON (ver operacao.ts).
 * Função pura sobre um PrismaClient já resolvido — o CLI é que resolve o tenant.
 */
import type { PrismaClient } from "../../../generated/prisma/client";
import {
  COLUNAS, aplicarPlano, contar, normalizarRegistos, planear,
  type Coluna, type Contagens, type DocumentoJson, type ItemPlano, type ResultadoAplicacao,
} from "./operacao";

export type OpcoesExecucao = {
  doc: DocumentoJson;
  ficheiroHash: string;
  aplicar: boolean;
  utilizadorEmail?: string;
  farmaciasExplicitas?: Partial<Record<Coluna, string>>;
  /** Sem credenciais: `host:porta/base`. */
  baseDadosHint: string;
  revisao: string;
  tenant: string;
  falharNoRegisto?: number;
  esperados?: number;
};

export type Relatorio = {
  tipo: "dry-run" | "apply";
  revisaoCodigo: string;
  tenant: string;
  baseDados: string;
  ficheiroSha256: string;
  dataHora: string;
  totais: {
    manutencoesRecebidas: number;
    linhasMensais: number;
    cnpDistintos: number;
    cnpEncontrados: number;
    cnpNaoEncontrados: number[];
    novas: number;
    jaExistentes: number;
    conflitos: number;
    manutencoesComTotaisDiferentesDaQuantidade: number;
  };
  farmacias: Record<string, { id: string; nome: string; estado: string; via: string } | null>;
  errosValidacao: string[];
  bloqueios: string[];
  itens: ItemPlano[];
  contagensAntes: Contagens;
  contagensDepois: Contagens | null;
  criado: {
    cabecalhosCriados: number;
    linhasMensaisCriadas: number;
    celulasCriadas: number;
    itensPorFarmaciaCriados: number;
    manutencoesCriadas: ResultadoAplicacao["manutencoesCriadas"];
    celulaIds: string[];
    farmaciaPvpIds: string[];
  } | null;
  erros: string[];
  rollback: { confirmado: boolean; contagensRepostas: boolean } | null;
};

const mesmoConjunto = (a: Contagens, b: Contagens) => JSON.stringify(a) === JSON.stringify(b);

export async function executar(prisma: PrismaClient, o: OpcoesExecucao): Promise<Relatorio> {
  const antes = await contar(prisma);
  const plano = await planear(prisma, o.doc, { farmaciasExplicitas: o.farmaciasExplicitas, esperados: o.esperados });
  const registos = plano.errosValidacao.length === 0 ? normalizarRegistos(o.doc) : [];
  const encontrados = new Set(plano.itens.filter((i) => i.produtoId).map((i) => i.cnp));
  const todos = [...new Set(registos.map((r) => r.cnp))];

  const rel: Relatorio = {
    tipo: o.aplicar ? "apply" : "dry-run",
    revisaoCodigo: o.revisao,
    tenant: o.tenant,
    baseDados: o.baseDadosHint,
    ficheiroSha256: o.ficheiroHash,
    dataHora: new Date().toISOString(),
    totais: {
      manutencoesRecebidas: o.doc.records?.length ?? 0,
      linhasMensais: registos.reduce((s, r) => s + r.numMeses, 0),
      cnpDistintos: todos.length,
      cnpEncontrados: todos.filter((c) => encontrados.has(c)).length,
      cnpNaoEncontrados: todos.filter((c) => !encontrados.has(c)),
      novas: plano.itens.filter((i) => i.estado === "NOVO").length,
      jaExistentes: plano.itens.filter((i) => i.estado === "JA_EXISTENTE").length,
      conflitos: plano.itens.filter((i) => i.estado === "CONFLITO").length,
      manutencoesComTotaisDiferentesDaQuantidade: plano.itens.filter((i) => i.totaisDiferemDaQuantidade).length,
    },
    farmacias: Object.fromEntries(
      COLUNAS.map((c) => [c, plano.farmacias.resolvidas[c] ? { ...plano.farmacias.resolvidas[c]! } : null]),
    ),
    errosValidacao: plano.errosValidacao,
    bloqueios: plano.bloqueios,
    itens: plano.itens,
    contagensAntes: antes,
    contagensDepois: null,
    criado: null,
    erros: [],
    rollback: null,
  };

  if (!o.aplicar) {
    rel.contagensDepois = await contar(prisma);
    return rel;
  }

  try {
    if (!o.utilizadorEmail) throw new Error("--apply recusado: falta --utilizador-email (o utilizador que fica como criador dos registos).");
    const r = await aplicarPlano(prisma, o.doc, plano, { utilizadorEmail: o.utilizadorEmail, ficheiroHash: o.ficheiroHash, falharNoRegisto: o.falharNoRegisto });
    rel.criado = {
      cabecalhosCriados: r.cabecalhosCriados, linhasMensaisCriadas: r.linhasMensaisCriadas, celulasCriadas: r.celulasCriadas,
      itensPorFarmaciaCriados: r.itensPorFarmaciaCriados, manutencoesCriadas: r.manutencoesCriadas, celulaIds: r.celulaIds, farmaciaPvpIds: r.farmaciaPvpIds,
    };
    rel.contagensDepois = await contar(prisma);
  } catch (e) {
    rel.erros.push(e instanceof Error ? e.message : String(e));
    rel.contagensDepois = await contar(prisma);
    rel.rollback = { confirmado: true, contagensRepostas: mesmoConjunto(antes, rel.contagensDepois) };
  }
  return rel;
}
