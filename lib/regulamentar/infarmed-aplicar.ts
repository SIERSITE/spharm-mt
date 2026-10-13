/**
 * lib/regulamentar/infarmed-aplicar.ts
 *
 * Aplica (ou simula) uma versão do ficheiro do INFARMED a UMA base de tenant e
 * faz o rollback para a versão anterior.
 *
 * Garantias:
 *   · só escreve em `InfarmedImportacao` e `ProdutoRegulamentar` — nunca em
 *     `Produto`, `ProdutoFarmacia`, vendas, stocks, encomendas ou preços;
 *   · associa EXCLUSIVAMENTE por `Nº registo` = `Produto.cnp` (igualdade);
 *   · atómica: a versão nova só fica ativa no fim de uma única transação —
 *     qualquer falha antes disso não deixa nada (a versão anterior continua);
 *   · idempotente: a mesma versão (sha256) já processada não se repete;
 *   · concorrência: `pg_advisory_xact_lock` serializa duas execuções do mesmo
 *     tenant; a segunda vê a versão da primeira e sai como JA_PROCESSADA. O
 *     índice único parcial da migration é a segunda trava.
 *   · o rollback só troca qual versão está ativa (os dados nunca se apagam).
 */

import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import type { FicheiroInfarmedLido, LinhaInfarmed } from "./infarmed-ficheiro";

export type OrigemImportacao = "CARGA_INICIAL" | "MENSAL" | "MANUAL";

export type OpcoesAplicar = {
  origem: OrigemImportacao;
  /** false (omissão) = dry-run: calcula tudo e não escreve nada. */
  apply?: boolean;
  urlOrigem?: string | null;
  nomeFicheiro?: string | null;
  descarregadoEm?: Date;
  /** Reaplica uma versão cujo sha256 já foi processado (ex.: depois de um rollback deliberado). */
  forcar?: boolean;
  /** Recusa um ficheiro com menos de X% das linhas da versão ativa (anti-ficheiro truncado). */
  minimoRelativoLinhas?: number;
  /** Só para testes: corre dentro da transação, depois de gravar os registos. */
  aposGravarRegistos?: () => void | Promise<void>;
};

const CAMPOS = [
  "cnpem", "substanciaAtiva", "nomeMedicamento", "formaFarmaceutica", "dosagem", "tamanhoEmbalagem",
  "pvp", "precoLivre", "pvpNotificado", "precoUtenteGeral", "precoUtenteEspecial",
  "estadoComercializacao", "generico",
] as const;
type Campo = (typeof CAMPOS)[number];

type Valores = Record<Campo, string | number | boolean | null>;

function valoresDe(l: LinhaInfarmed): Valores {
  return {
    cnpem: l.cnpem, substanciaAtiva: l.substanciaAtiva, nomeMedicamento: l.nomeMedicamento,
    formaFarmaceutica: l.formaFarmaceutica, dosagem: l.dosagem, tamanhoEmbalagem: l.tamanhoEmbalagem,
    pvp: l.pvp, precoLivre: l.precoLivre, pvpNotificado: l.pvpNotificado,
    precoUtenteGeral: l.precoUtenteGeral, precoUtenteEspecial: l.precoUtenteEspecial,
    estadoComercializacao: l.estadoComercializacao, generico: l.generico,
  };
}

type LinhaBd = Valores & { produtoId: string; presenteNoFicheiro: boolean };

function numOuNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export type Contagens = {
  produtos: number;
  produtosFarmacia: number;
  vendasMensais: number;
  listasEncomenda: number;
  linhasEncomenda: number;
  /** md5 de Produto (id, designacao, fabricanteId, dci, …) — prova que nada operacional mudou. */
  checksumProdutos: string;
  /** md5 de ProdutoFarmacia (pvp, pmc, puc, stock, fornecedor). */
  checksumProdutosFarmacia: string;
  regulamentarAtivo: number;
};

export async function contagens(prisma: PrismaClient): Promise<Contagens> {
  const r = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT
      (SELECT count(*) FROM "Produto")::int AS produtos,
      (SELECT count(*) FROM "ProdutoFarmacia")::int AS "produtosFarmacia",
      (SELECT count(*) FROM "VendaMensal")::int AS "vendasMensais",
      (SELECT count(*) FROM "ListaEncomenda")::int AS "listasEncomenda",
      (SELECT count(*) FROM "LinhaEncomenda")::int AS "linhasEncomenda",
      COALESCE((SELECT md5(string_agg(concat_ws('|', id, designacao, "fabricanteId", dci, "codigoATC", "formaFarmaceutica", dosagem, embalagem, "flagGenerico", "camposManuais"::text), ';' ORDER BY id)) FROM "Produto"), '') AS "checksumProdutos",
      COALESCE((SELECT md5(string_agg(concat_ws('|', id, pvp, pmc, puc, "stockAtual", "fornecedorHabitualId"), ';' ORDER BY id)) FROM "ProdutoFarmacia"), '') AS "checksumProdutosFarmacia",
      (SELECT count(*) FROM "ProdutoRegulamentar" pr JOIN "InfarmedImportacao" i ON i.id = pr."importacaoId" AND i."ativa")::int AS "regulamentarAtivo"`;
  const x = r[0];
  return {
    produtos: Number(x.produtos), produtosFarmacia: Number(x.produtosFarmacia), vendasMensais: Number(x.vendasMensais),
    listasEncomenda: Number(x.listasEncomenda), linhasEncomenda: Number(x.linhasEncomenda),
    checksumProdutos: String(x.checksumProdutos), checksumProdutosFarmacia: String(x.checksumProdutosFarmacia),
    regulamentarAtivo: Number(x.regulamentarAtivo),
  };
}

export type RelatorioImportacao = {
  geradoEm: string;
  origem: OrigemImportacao;
  modo: "DRY_RUN" | "APPLY";
  resultado: "SIMULADA" | "APLICADA" | "JA_PROCESSADA" | "RECUSADA" | "FALHADA";
  motivo?: string;
  ficheiro: { sha256: string; bytes: number; nome: string | null; url: string | null };
  importacaoId: string | null;
  versaoAnteriorId: string | null;
  linhasLidas: number;
  linhasValidas: number;
  linhasRejeitadas: number;
  cnpDistintos: number;
  duplicadosIdenticos: number;
  conflitos: number;
  produtosAssociados: number;
  cnpNaoEncontrados: number;
  registosNovos: number;
  registosAlterados: number;
  registosIguais: number;
  camposAlterados: number;
  camposAlteradosPorCampo: Record<string, number>;
  deixaramDeEstarPresentes: number;
  completados?: number;
  antes: Contagens;
  depois: Contagens | null;
  operacionalIntacto: boolean | null;
  /** Listas completas (o relatório em disco leva-as; a coluna JSON só uma amostra). */
  detalhe: {
    rejeitadas: Array<{ linha: number; registo: string | null; motivo: string }>;
    conflitos: Array<{ registo: string; linhas: number[] }>;
    cnpNaoEncontrados: string[];
  };
};

/** Chave do advisory lock por base de dados (uma execução por tenant de cada vez). */
const LOCK_KEY = 7_203_201_001;

async function versaoAtiva(prisma: PrismaClient | Prisma.TransactionClient) {
  return prisma.infarmedImportacao.findFirst({ where: { ativa: true } });
}

async function carregarLinhasAtivas(prisma: PrismaClient | Prisma.TransactionClient, importacaoId: string): Promise<Map<string, LinhaBd>> {
  const rows = await prisma.produtoRegulamentar.findMany({ where: { importacaoId } });
  const m = new Map<string, LinhaBd>();
  for (const r of rows) {
    m.set(r.produtoId, {
      produtoId: r.produtoId, presenteNoFicheiro: r.presenteNoFicheiro,
      cnpem: r.cnpem, substanciaAtiva: r.substanciaAtiva, nomeMedicamento: r.nomeMedicamento,
      formaFarmaceutica: r.formaFarmaceutica, dosagem: r.dosagem, tamanhoEmbalagem: r.tamanhoEmbalagem,
      pvp: numOuNull(r.pvp), precoLivre: r.precoLivre, pvpNotificado: numOuNull(r.pvpNotificado),
      precoUtenteGeral: numOuNull(r.precoUtenteGeral), precoUtenteEspecial: numOuNull(r.precoUtenteEspecial),
      estadoComercializacao: r.estadoComercializacao, generico: r.generico,
    });
  }
  return m;
}

async function associarPorCnp(prisma: PrismaClient | Prisma.TransactionClient, cnps: number[]): Promise<Map<number, string>> {
  const m = new Map<number, string>();
  const LOTE = 5000;
  for (let i = 0; i < cnps.length; i += LOTE) {
    const fatia = cnps.slice(i, i + LOTE);
    const rows = await prisma.produto.findMany({ where: { cnp: { in: fatia } }, select: { id: true, cnp: true } });
    for (const r of rows) m.set(r.cnp, r.id);
  }
  return m;
}

type Plano = {
  inserir: Array<{ produtoId: string; cnp: number; valores: Valores; presente: boolean }>;
  novos: number;
  alterados: number;
  iguais: number;
  camposAlterados: number;
  porCampo: Record<string, number>;
  deixaram: number;
  naoEncontrados: string[];
  associados: number;
};

function planear(
  ficheiro: FicheiroInfarmedLido,
  idPorCnp: Map<number, string>,
  anteriores: Map<string, LinhaBd> | null,
  cnpPorProduto: Map<string, number>,
): Plano {
  const plano: Plano = { inserir: [], novos: 0, alterados: 0, iguais: 0, camposAlterados: 0, porCampo: {}, deixaram: 0, naoEncontrados: [], associados: 0 };
  const vistos = new Set<string>();
  for (const l of ficheiro.linhas) {
    const produtoId = idPorCnp.get(l.cnp);
    if (!produtoId) {
      plano.naoEncontrados.push(l.registo);
      continue;
    }
    plano.associados += 1;
    vistos.add(produtoId);
    const novo = valoresDe(l);
    const ant = anteriores?.get(produtoId);
    if (!ant) plano.novos += 1;
    else {
      const dif = CAMPOS.filter((c) => (ant[c] ?? null) !== (novo[c] ?? null));
      if (dif.length === 0 && ant.presenteNoFicheiro) plano.iguais += 1;
      else {
        plano.alterados += 1;
        plano.camposAlterados += dif.length;
        for (const c of dif) plano.porCampo[c] = (plano.porCampo[c] ?? 0) + 1;
      }
    }
    plano.inserir.push({ produtoId, cnp: l.cnp, valores: novo, presente: true });
  }
  // Presentes na versão anterior e ausentes agora: NÃO se apagam — mantêm-se, assinalados.
  if (anteriores) {
    for (const [produtoId, ant] of anteriores) {
      if (vistos.has(produtoId)) continue;
      const cnp = cnpPorProduto.get(produtoId);
      if (cnp === undefined) continue;
      if (ant.presenteNoFicheiro) plano.deixaram += 1;
      const v = {} as Valores;
      for (const c of CAMPOS) v[c] = ant[c];
      plano.inserir.push({ produtoId, cnp, valores: v, presente: false });
    }
  }
  return plano;
}

function linhaParaCriar(importacaoId: string, r: Plano["inserir"][number], agora: Date): Prisma.ProdutoRegulamentarCreateManyInput {
  const v = r.valores;
  return {
    importacaoId, produtoId: r.produtoId, cnp: r.cnp,
    cnpem: v.cnpem as string | null, substanciaAtiva: v.substanciaAtiva as string | null,
    nomeMedicamento: v.nomeMedicamento as string | null, formaFarmaceutica: v.formaFarmaceutica as string | null,
    dosagem: v.dosagem as string | null, tamanhoEmbalagem: v.tamanhoEmbalagem as string | null,
    pvp: v.pvp as number | null, precoLivre: v.precoLivre as boolean, pvpNotificado: v.pvpNotificado as number | null,
    precoUtenteGeral: v.precoUtenteGeral as number | null, precoUtenteEspecial: v.precoUtenteEspecial as number | null,
    estadoComercializacao: v.estadoComercializacao as string | null, generico: v.generico as boolean | null,
    presenteNoFicheiro: r.presente, atualizadoEm: agora,
  };
}

function resumoParaBd(r: RelatorioImportacao): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify({
      ...r,
      detalhe: {
        rejeitadas: r.detalhe.rejeitadas.slice(0, 100),
        rejeitadasTotal: r.detalhe.rejeitadas.length,
        conflitos: r.detalhe.conflitos.slice(0, 100),
        conflitosTotal: r.detalhe.conflitos.length,
        cnpNaoEncontradosAmostra: r.detalhe.cnpNaoEncontrados.slice(0, 50),
        cnpNaoEncontradosTotal: r.detalhe.cnpNaoEncontrados.length,
      },
    }),
  );
}

function relatorioBase(
  ficheiro: FicheiroInfarmedLido,
  opcoes: OpcoesAplicar,
  antes: Contagens,
  versaoAnteriorId: string | null,
): RelatorioImportacao {
  return {
    geradoEm: new Date().toISOString(),
    origem: opcoes.origem,
    modo: opcoes.apply ? "APPLY" : "DRY_RUN",
    resultado: "SIMULADA",
    ficheiro: { sha256: ficheiro.sha256, bytes: ficheiro.bytes, nome: opcoes.nomeFicheiro ?? null, url: opcoes.urlOrigem ?? null },
    importacaoId: null,
    versaoAnteriorId,
    linhasLidas: ficheiro.linhasLidas,
    linhasValidas: ficheiro.linhas.length,
    linhasRejeitadas: ficheiro.rejeitadas.length,
    cnpDistintos: ficheiro.cnpDistintos,
    duplicadosIdenticos: ficheiro.duplicadosIdenticos,
    conflitos: ficheiro.conflitos.length,
    produtosAssociados: 0,
    cnpNaoEncontrados: 0,
    registosNovos: 0,
    registosAlterados: 0,
    registosIguais: 0,
    camposAlterados: 0,
    camposAlteradosPorCampo: {},
    deixaramDeEstarPresentes: 0,
    antes,
    depois: null,
    operacionalIntacto: null,
    detalhe: { rejeitadas: ficheiro.rejeitadas, conflitos: ficheiro.conflitos, cnpNaoEncontrados: [] },
  };
}

function preencherPlano(r: RelatorioImportacao, p: Plano) {
  r.produtosAssociados = p.associados;
  r.cnpNaoEncontrados = p.naoEncontrados.length;
  r.registosNovos = p.novos;
  r.registosAlterados = p.alterados;
  r.registosIguais = p.iguais;
  r.camposAlterados = p.camposAlterados;
  r.camposAlteradosPorCampo = p.porCampo;
  r.deixaramDeEstarPresentes = p.deixaram;
  r.detalhe.cnpNaoEncontrados = p.naoEncontrados;
}

export async function aplicarVersaoInfarmed(
  prisma: PrismaClient,
  ficheiro: FicheiroInfarmedLido,
  opcoes: OpcoesAplicar,
): Promise<RelatorioImportacao> {
  const antes = await contagens(prisma);
  const ativaInicial = await versaoAtiva(prisma);
  const rel = relatorioBase(ficheiro, opcoes, antes, ativaInicial?.id ?? null);

  // Guarda anti-ficheiro truncado: só quando há uma versão ativa para comparar.
  if (ativaInicial && opcoes.minimoRelativoLinhas && ativaInicial.linhasLidas > 0) {
    const minimo = Math.floor(ativaInicial.linhasLidas * opcoes.minimoRelativoLinhas);
    if (ficheiro.linhasLidas < minimo) {
      rel.resultado = "RECUSADA";
      rel.motivo = `O ficheiro tem ${ficheiro.linhasLidas} linhas, menos de ${Math.round(opcoes.minimoRelativoLinhas * 100)}% da versão ativa (${ativaInicial.linhasLidas}).`;
      return rel;
    }
  }

  const processada = await prisma.infarmedImportacao.findFirst({
    where: { sha256: ficheiro.sha256, estado: { in: ["APLICADA", "REVERTIDA"] } },
    orderBy: { iniciadaEm: "desc" },
  });
  const mesmaQueAtiva = !!processada && !!ativaInicial && processada.id === ativaInicial.id;
  if (processada && !opcoes.forcar && !mesmaQueAtiva) {
    rel.resultado = "JA_PROCESSADA";
    rel.motivo =
      processada.estado === "REVERTIDA"
        ? "Esta versão foi aplicada e depois revertida; não é reaplicada sem --forcar."
        : "Esta versão já foi processada.";
    return rel;
  }

  const idPorCnp = await associarPorCnp(prisma, ficheiro.linhas.map((l) => l.cnp));
  const cnpPorProduto = new Map<string, number>();
  const produtoIdsAnteriores = ativaInicial ? await carregarLinhasAtivas(prisma, ativaInicial.id) : null;
  if (produtoIdsAnteriores && produtoIdsAnteriores.size > 0) {
    const ps = await prisma.produto.findMany({ where: { id: { in: [...produtoIdsAnteriores.keys()] } }, select: { id: true, cnp: true } });
    for (const p of ps) cnpPorProduto.set(p.id, p.cnp);
  }

  // ── Mesma versão que a ativa: só COMPLETA (produtos entretanto criados) ──
  if (mesmaQueAtiva && !opcoes.forcar && ativaInicial && produtoIdsAnteriores) {
    const faltam: Plano["inserir"] = [];
    for (const l of ficheiro.linhas) {
      const pid = idPorCnp.get(l.cnp);
      if (pid && !produtoIdsAnteriores.has(pid)) faltam.push({ produtoId: pid, cnp: l.cnp, valores: valoresDe(l), presente: true });
    }
    rel.resultado = opcoes.apply ? "JA_PROCESSADA" : "SIMULADA";
    rel.motivo = "Mesma versão que a ativa: só se completam os produtos entretanto criados.";
    rel.importacaoId = ativaInicial.id;
    rel.completados = faltam.length;
    rel.produtosAssociados = idPorCnp.size;
    rel.detalhe.cnpNaoEncontrados = ficheiro.linhas.filter((l) => !idPorCnp.has(l.cnp)).map((l) => l.registo);
    rel.cnpNaoEncontrados = rel.detalhe.cnpNaoEncontrados.length;
    if (opcoes.apply && faltam.length > 0) {
      const agora = new Date();
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_KEY})`;
        for (let i = 0; i < faltam.length; i += 2000) {
          await tx.produtoRegulamentar.createMany({
            data: faltam.slice(i, i + 2000).map((r) => linhaParaCriar(ativaInicial.id, r, agora)),
            skipDuplicates: true,
          });
        }
      }, { timeout: 120_000 });
      rel.depois = await contagens(prisma);
      rel.operacionalIntacto = operacionalIgual(antes, rel.depois);
    }
    return rel;
  }

  const plano = planear(ficheiro, idPorCnp, produtoIdsAnteriores, cnpPorProduto);
  preencherPlano(rel, plano);

  if (!opcoes.apply) {
    rel.resultado = "SIMULADA";
    return rel;
  }

  // ── APPLY: uma transação, com lock ──────────────────────────────────
  const descarregadoEm = opcoes.descarregadoEm ?? new Date();
  try {
    const resultado = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_KEY})`;
      // Depois do lock: outra execução pode ter aplicado ESTA versão entretanto.
      const jaFeita = await tx.infarmedImportacao.findFirst({
        where: { sha256: ficheiro.sha256, estado: { in: ["APLICADA", "REVERTIDA"] } },
      });
      if (jaFeita && !opcoes.forcar) return { saltada: jaFeita.id } as const;
      const ativa = await versaoAtiva(tx);
      if ((ativa?.id ?? null) !== (ativaInicial?.id ?? null)) {
        throw new Error("A versão ativa mudou durante a preparação; repetir a execução.");
      }
      const imp = await tx.infarmedImportacao.create({
        data: {
          origem: opcoes.origem, urlOrigem: opcoes.urlOrigem ?? null, nomeFicheiro: opcoes.nomeFicheiro ?? null,
          sha256: ficheiro.sha256, descarregadoEm, estado: "EM_CURSO", ativa: false,
          versaoAnteriorId: ativa?.id ?? null,
        },
      });
      const agora = new Date();
      for (let i = 0; i < plano.inserir.length; i += 2000) {
        await tx.produtoRegulamentar.createMany({
          data: plano.inserir.slice(i, i + 2000).map((r) => linhaParaCriar(imp.id, r, agora)),
        });
      }
      if (opcoes.aposGravarRegistos) await opcoes.aposGravarRegistos();
      if (ativa) await tx.infarmedImportacao.update({ where: { id: ativa.id }, data: { ativa: false } });
      await tx.infarmedImportacao.update({
        where: { id: imp.id },
        data: {
          estado: "APLICADA", ativa: true, terminadaEm: new Date(),
          linhasLidas: ficheiro.linhasLidas, linhasRejeitadas: ficheiro.rejeitadas.length,
          cnpDistintos: ficheiro.cnpDistintos, produtosAssociados: plano.associados,
          cnpNaoEncontrados: plano.naoEncontrados.length, registosNovos: plano.novos,
          registosAlterados: plano.alterados, registosIguais: plano.iguais,
          camposAlterados: plano.camposAlterados, deixaramDeEstarPresentes: plano.deixaram,
        },
      });
      return { id: imp.id } as const;
    }, { timeout: 300_000, maxWait: 60_000 });

    if ("saltada" in resultado) {
      rel.resultado = "JA_PROCESSADA";
      rel.motivo = "Outra execução aplicou esta versão entretanto.";
      rel.importacaoId = resultado.saltada;
      return rel;
    }
    rel.importacaoId = resultado.id;
    rel.resultado = "APLICADA";
    rel.depois = await contagens(prisma);
    rel.operacionalIntacto = operacionalIgual(antes, rel.depois);
    await prisma.infarmedImportacao.update({ where: { id: resultado.id }, data: { relatorio: resumoParaBd(rel) } });
    return rel;
  } catch (e) {
    rel.resultado = "FALHADA";
    rel.motivo = e instanceof Error ? e.message : String(e);
    // A transação foi desfeita (nada ficou). Fica só o rasto da tentativa.
    try {
      const f = await prisma.infarmedImportacao.create({
        data: {
          origem: opcoes.origem, urlOrigem: opcoes.urlOrigem ?? null, nomeFicheiro: opcoes.nomeFicheiro ?? null,
          sha256: ficheiro.sha256, descarregadoEm, estado: "FALHADA", ativa: false,
          versaoAnteriorId: ativaInicial?.id ?? null, linhasLidas: ficheiro.linhasLidas,
          erro: rel.motivo.slice(0, 1000), terminadaEm: new Date(),
        },
      });
      rel.importacaoId = f.id;
    } catch {
      /* o rasto é best-effort */
    }
    rel.depois = await contagens(prisma).catch(() => null);
    return rel;
  }
}

export function operacionalIgual(a: Contagens, b: Contagens): boolean {
  return (
    a.produtos === b.produtos && a.produtosFarmacia === b.produtosFarmacia && a.vendasMensais === b.vendasMensais &&
    a.listasEncomenda === b.listasEncomenda && a.linhasEncomenda === b.linhasEncomenda &&
    a.checksumProdutos === b.checksumProdutos && a.checksumProdutosFarmacia === b.checksumProdutosFarmacia
  );
}

export type ResultadoReversao =
  | { ok: true; revertidaId: string; ativaAgoraId: string | null }
  | { ok: false; motivo: string };

/** Desfaz a versão ativa: a anterior volta a ser a ativa. Nenhum dado é apagado. */
export async function reverterVersaoInfarmed(prisma: PrismaClient, opcoes: { apply: boolean }): Promise<ResultadoReversao & { simulada: boolean }> {
  const ativa = await versaoAtiva(prisma);
  if (!ativa) return { ok: false, motivo: "Não há versão regulamentar ativa.", simulada: !opcoes.apply };
  const anterior = ativa.versaoAnteriorId
    ? await prisma.infarmedImportacao.findFirst({ where: { id: ativa.versaoAnteriorId, estado: { in: ["APLICADA", "REVERTIDA"] } } })
    : null;
  if (!opcoes.apply) return { ok: true, revertidaId: ativa.id, ativaAgoraId: anterior?.id ?? null, simulada: true };
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_KEY})`;
    const agora = await versaoAtiva(tx);
    if (!agora || agora.id !== ativa.id) throw new Error("A versão ativa mudou; repetir.");
    await tx.infarmedImportacao.update({ where: { id: ativa.id }, data: { ativa: false, estado: "REVERTIDA", revertidaEm: new Date() } });
    if (anterior) await tx.infarmedImportacao.update({ where: { id: anterior.id }, data: { ativa: true, estado: "APLICADA", revertidaEm: null } });
  });
  return { ok: true, revertidaId: ativa.id, ativaAgoraId: anterior?.id ?? null, simulada: false };
}
