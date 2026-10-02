/**
 * lib/catalogo/manutencao-massa.ts
 *
 * Manutenção em massa do catálogo — EXCLUSIVO do tenant silveira (gate no
 * caller, ver `TENANT_CATALOGO_MASSA` em `lib/tenant-constants.ts`; este módulo
 * não lê o tenant sozinho, confia em quem o chama).
 *
 * Dois tipos de operação:
 *   FABRICANTE  — escreve `Produto.fabricanteId` (catálogo do tenant, NÃO por farmácia).
 *   FORNECEDOR  — escreve `ProdutoFarmacia.fornecedorHabitualId` (por produto E por
 *                 farmácia). Só toca nas farmácias listadas em `filtro.farmaciaIds`.
 *
 * ── Filtros = os de Vendas ──────────────────────────────────────────────
 * O universo é definido pelas MESMAS funções que Vendas usa (ver
 * `lib/catalogo/manutencao-massa-filtro.ts`): `resolverPrefiltroProdutos`
 * (lib/reporting/prefiltro-produtos.ts) e, quando há período, `getVendasData`
 * (lib/vendas-data.ts). Tudo é aplicado no servidor sobre o universo completo
 * — nunca sobre as linhas já carregadas no browser.
 *
 * ── Preview verificável (snapshot) ──────────────────────────────────────
 * O preview devolve um `snapshotHash` = SHA-256 de (tipo, filtro normalizado,
 * conjunto seleccionado de chaves com o VALOR ANTERIOR de cada uma). O apply
 * recalcula-o: se o universo, a selecção ou algum valor mudou, recusa
 * (`PREVIEW_DESACTUALIZADO`) em vez de aplicar a produtos que o utilizador
 * não viu. Dentro da transacção cada escrita é compare-and-set (`updateMany`
 * com o valor anterior no `where`): uma alteração concorrente reverte tudo.
 *
 * Nunca apaga/funde Fabricante/Fornecedor/aliases/grupos laboratoriais.
 */
import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { temFabricanteDivergenteEntreFarmacias } from "@/lib/ingest/catalog-from-erp";
import { normalizeFabricanteCanonico, normalizeFornecedorCanonico } from "@/lib/catalog-normalizers";
import { resolverOuCriarFornecedor } from "@/lib/catalogo/resolver-fornecedor";
import { resolverOuCriarFabricante } from "@/lib/catalogo/resolver-fabricante";
import { resolverPrefiltroProdutos } from "@/lib/reporting/prefiltro-produtos";
import { getVendasData } from "@/lib/vendas-data";
import {
  aplicarSelecao,
  chaveAlvo,
  normalizarFiltro,
  periodoActivo,
  validarFiltro,
  type DestinoInput,
  type ManutencaoMassaFiltro,
  type SelecaoManutencao,
  type TipoManutencaoMassa,
} from "@/lib/catalogo/manutencao-massa-filtro";

export { validarFiltro, normalizarFiltro, chaveAlvo, aplicarSelecao };
export type { DestinoInput, ManutencaoMassaFiltro, SelecaoManutencao, TipoManutencaoMassa };

type Tx = Prisma.TransactionClient;

const CHUNK = 2000;
function chunks<T>(arr: readonly T[], n = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// ─── Escopo: tudo o que o filtro decide ANTES de ler os alvos ──────────────

export type Alvo = {
  chave: string;
  produtoId: string;
  /** `null` em FABRICANTE (o fabricante é do produto, não da farmácia). */
  farmaciaId: string | null;
  valorAnteriorId: string | null;
};

type FarmaciaInfo = { id: string; nome: string };

type Escopo = {
  /** `true` = o filtro não pode ter resultados (ex.: lista de CNP vazia). */
  vazio: boolean;
  prefiltroIds: string[] | null;
  /** farmácia → produtos com movimento no período; `null` = sem período. */
  periodoPorFarmacia: Map<string, Set<string>> | null;
  divergentes: Set<string> | null;
  farmacias: FarmaciaInfo[];
};

async function resolverFarmacias(prisma: PrismaClient, tipo: TipoManutencaoMassa, f: ManutencaoMassaFiltro): Promise<FarmaciaInfo[]> {
  const ids = f.farmaciaIds ?? [];
  return prisma.farmacia.findMany({
    where: { estado: "ATIVO", ...(ids.length > 0 || tipo === "FORNECEDOR" ? { id: { in: ids } } : {}) },
    select: { id: true, nome: true },
    orderBy: { nome: "asc" },
  });
}

/** Pares (farmácia, produto) com movimento no período — via o MESMO loader de Vendas. */
async function resolverParesPeriodo(
  prisma: PrismaClient,
  f: ManutencaoMassaFiltro,
  farmacias: FarmaciaInfo[]
): Promise<Map<string, Set<string>>> {
  const res = await getVendasData(
    {
      from: f.from!,
      to: f.to!,
      farmaciaNomes: farmacias.map((x) => x.nome),
      pesquisa: f.pesquisa ?? undefined,
      cnps: f.cnps,
      categorias: f.categorias,
      subcategorias: f.subcategorias,
      utilizacoes: f.utilizacoes,
      distribuidores: f.distribuidores,
      apenasSemClassif: f.apenasSemClassif,
      incluirCredito: f.incluirCredito,
      incluirTransferencias: f.incluirTransferencias,
      apenasComStock: f.apenasComStock,
      incluirManutencao: f.incluirManutencao,
    },
    prisma
  );
  const idPorNome = new Map(farmacias.map((x) => [x.nome, x.id]));
  const cnps = [...new Set(res.rows.map((r) => Number(r.codigo)).filter((n) => Number.isFinite(n)))];
  const produtoPorCnp = new Map<number, string>();
  for (const parte of chunks(cnps, 10_000)) {
    const ps = await prisma.produto.findMany({ where: { cnp: { in: parte } }, select: { id: true, cnp: true } });
    for (const p of ps) produtoPorCnp.set(p.cnp, p.id);
  }
  const mapa = new Map<string, Set<string>>(farmacias.map((x) => [x.id, new Set<string>()]));
  for (const r of res.rows) {
    const fid = idPorNome.get(r.farmacia);
    const pid = produtoPorCnp.get(Number(r.codigo));
    if (fid && pid) mapa.get(fid)!.add(pid);
  }
  return mapa;
}

/**
 * Produtos com `fabricanteErpAtual` divergente entre farmácias do tenant.
 * Sinal informativo — nunca resolve nada sozinho. Varre `ProdutoFarmacia` inteira
 * do tenant (aceitável para o volume de um grupo; não escala indefinidamente).
 */
export async function resolverProdutosComFabricanteDivergente(prisma: Tx): Promise<Set<string>> {
  const rows = await prisma.produtoFarmacia.findMany({
    select: { produtoId: true, farmaciaId: true, fabricanteErpAtual: true },
  });
  const porProduto = new Map<string, Array<{ farmaciaId: string; fabricanteErpAtual: string | null }>>();
  for (const r of rows) {
    const arr = porProduto.get(r.produtoId) ?? [];
    arr.push({ farmaciaId: r.farmaciaId, fabricanteErpAtual: r.fabricanteErpAtual });
    porProduto.set(r.produtoId, arr);
  }
  const result = new Set<string>();
  for (const [produtoId, valores] of porProduto) {
    if (temFabricanteDivergenteEntreFarmacias(valores)) result.add(produtoId);
  }
  return result;
}

async function resolverEscopo(prisma: PrismaClient, tipo: TipoManutencaoMassa, filtro: ManutencaoMassaFiltro): Promise<Escopo> {
  const f = normalizarFiltro(filtro);
  const farmacias = await resolverFarmacias(prisma, tipo, f);
  const vazio: Escopo = { vazio: true, prefiltroIds: null, periodoPorFarmacia: null, divergentes: null, farmacias };
  if (tipo === "FORNECEDOR" && farmacias.length === 0) return vazio;

  // Regra ÚNICA de Vendas para o pré-filtro de produto.
  const prefiltroIds = await resolverPrefiltroProdutos(prisma, {
    categorias: f.categorias,
    apenasSemClassif: f.apenasSemClassif,
    subcategorias: f.subcategorias,
    utilizacoes: f.utilizacoes,
    cnps: f.cnps,
    pesquisa: f.pesquisa ?? undefined,
  });
  if (prefiltroIds && prefiltroIds.length === 0) return vazio;

  let periodoPorFarmacia: Map<string, Set<string>> | null = null;
  if (periodoActivo(f)) {
    periodoPorFarmacia = await resolverParesPeriodo(prisma, f, farmacias);
    if ([...periodoPorFarmacia.values()].every((s) => s.size === 0)) return vazio;
  }

  const divergentes = tipo === "FABRICANTE" && f.fabricanteDivergente ? await resolverProdutosComFabricanteDivergente(prisma) : null;
  if (divergentes && divergentes.size === 0) return vazio;

  return { vazio: false, prefiltroIds, periodoPorFarmacia, divergentes, farmacias };
}

function condicaoValorAtual(campo: "fabricanteId" | "fornecedorHabitualId", ids: string[] | undefined, sem: boolean | undefined) {
  if (ids && ids.length > 0 && sem) return { OR: [{ [campo]: { in: ids } }, { [campo]: null }] };
  if (ids && ids.length > 0) return { [campo]: { in: ids } };
  if (sem) return { [campo]: null };
  return null;
}

/** Condições ao nível de `Produto` — partilhadas pelos dois tipos. */
function whereProduto(f: ManutencaoMassaFiltro, esc: Escopo): Prisma.ProdutoWhereInput {
  const AND: Prisma.ProdutoWhereInput[] = [];
  if (esc.prefiltroIds) AND.push({ id: { in: esc.prefiltroIds } });
  if (f.tipoArtigo) AND.push({ tipoArtigo: f.tipoArtigo });
  const fab = condicaoValorAtual("fabricanteId", f.fabricanteAtualIds, f.semFabricante);
  if (fab) AND.push(fab as Prisma.ProdutoWhereInput);
  return AND.length > 0 ? { AND } : {};
}

/** Where completo para FABRICANTE — sobre `Produto`. */
function whereFabricante(f: ManutencaoMassaFiltro, esc: Escopo): Prisma.ProdutoWhereInput {
  const AND: Prisma.ProdutoWhereInput[] = [whereProduto(f, esc)];
  if (esc.divergentes) AND.push({ id: { in: [...esc.divergentes] } });
  const idsFarmacias = f.farmaciaIds ?? [];
  if (idsFarmacias.length > 0) AND.push({ produtosFarmacia: { some: { farmaciaId: { in: idsFarmacias } } } });
  if (f.distribuidores && f.distribuidores.length > 0) {
    AND.push({
      produtosFarmacia: {
        some: {
          ...(idsFarmacias.length > 0 ? { farmaciaId: { in: idsFarmacias } } : {}),
          fornecedorOrigem: { in: f.distribuidores },
        },
      },
    });
  }
  if (esc.periodoPorFarmacia) {
    const uniao = new Set<string>();
    for (const s of esc.periodoPorFarmacia.values()) for (const id of s) uniao.add(id);
    AND.push({ id: { in: [...uniao] } });
  }
  return { AND };
}

/** Where completo para FORNECEDOR — sobre `ProdutoFarmacia`, só as farmácias pedidas. */
function whereFornecedor(f: ManutencaoMassaFiltro, esc: Escopo): Prisma.ProdutoFarmaciaWhereInput {
  const AND: Prisma.ProdutoFarmaciaWhereInput[] = [{ farmaciaId: { in: esc.farmacias.map((x) => x.id) } }];
  const prod = whereProduto(f, esc);
  if (Object.keys(prod).length > 0) AND.push({ produto: prod });
  const forn = condicaoValorAtual("fornecedorHabitualId", f.fornecedorAtualIds, f.semFornecedor);
  if (forn) AND.push(forn as Prisma.ProdutoFarmaciaWhereInput);
  if (f.distribuidores && f.distribuidores.length > 0) AND.push({ fornecedorOrigem: { in: f.distribuidores } });
  if (esc.periodoPorFarmacia) {
    AND.push({
      OR: [...esc.periodoPorFarmacia.entries()].map(([farmaciaId, set]) => ({ farmaciaId, produtoId: { in: [...set] } })),
    });
  }
  return { AND };
}

// ─── Leitura: grelha e alvos ────────────────────────────────────────────────

export type ItemManutencaoMassa = {
  chave: string;
  produtoId: string;
  farmaciaId: string | null;
  farmaciaNome: string | null;
  cnp: number;
  designacao: string;
  valorAtualId: string | null;
  valorAtualNome: string | null;
};

/** Página (para a grelha) — contagem total SEMPRE exacta, sobre o universo completo. */
export async function listarProdutosPagina(
  prisma: PrismaClient,
  tipo: TipoManutencaoMassa,
  filtroEntrada: ManutencaoMassaFiltro,
  opts: { page: number; pageSize: number }
): Promise<{ totalCount: number; items: ItemManutencaoMassa[] }> {
  const erro = validarFiltro(tipo, filtroEntrada);
  if (erro) throw new Error(erro);
  const filtro = normalizarFiltro(filtroEntrada);
  const page = Math.max(1, Math.floor(opts.page));
  const pageSize = Math.min(500, Math.max(1, Math.floor(opts.pageSize)));
  const esc = await resolverEscopo(prisma, tipo, filtro);
  if (esc.vazio) return { totalCount: 0, items: [] };
  const nomeFarmacia = new Map(esc.farmacias.map((x) => [x.id, x.nome]));

  if (tipo === "FABRICANTE") {
    const where = whereFabricante(filtro, esc);
    const [totalCount, produtos] = await Promise.all([
      prisma.produto.count({ where }),
      prisma.produto.findMany({
        where,
        select: { id: true, cnp: true, designacao: true, fabricanteId: true, fabricante: { select: { nomeNormalizado: true } } },
        orderBy: [{ designacao: "asc" }, { cnp: "asc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return {
      totalCount,
      items: produtos.map((p) => ({
        chave: chaveAlvo(p.id, null),
        produtoId: p.id,
        farmaciaId: null,
        farmaciaNome: null,
        cnp: p.cnp,
        designacao: p.designacao,
        valorAtualId: p.fabricanteId,
        valorAtualNome: p.fabricante?.nomeNormalizado ?? null,
      })),
    };
  }

  const where = whereFornecedor(filtro, esc);
  const [totalCount, linhas] = await Promise.all([
    prisma.produtoFarmacia.count({ where }),
    prisma.produtoFarmacia.findMany({
      where,
      select: {
        produtoId: true,
        farmaciaId: true,
        fornecedorHabitualId: true,
        fornecedorHabitual: { select: { nomeNormalizado: true, nome: true } },
        produto: { select: { cnp: true, designacao: true } },
      },
      orderBy: [{ produto: { designacao: "asc" } }, { produto: { cnp: "asc" } }, { farmaciaId: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);
  return {
    totalCount,
    items: linhas.map((l) => ({
      chave: chaveAlvo(l.produtoId, l.farmaciaId),
      produtoId: l.produtoId,
      farmaciaId: l.farmaciaId,
      farmaciaNome: nomeFarmacia.get(l.farmaciaId) ?? null,
      cnp: l.produto.cnp,
      designacao: l.produto.designacao,
      valorAtualId: l.fornecedorHabitualId,
      valorAtualNome: l.fornecedorHabitual?.nome ?? l.fornecedorHabitual?.nomeNormalizado ?? null,
    })),
  };
}

/** TODOS os alvos que correspondem ao filtro, com o valor actual — a base do preview, do hash e do apply. */
export async function resolverAlvos(
  prisma: PrismaClient,
  tipo: TipoManutencaoMassa,
  filtroEntrada: ManutencaoMassaFiltro
): Promise<Alvo[]> {
  const erro = validarFiltro(tipo, filtroEntrada);
  if (erro) throw new Error(erro);
  const filtro = normalizarFiltro(filtroEntrada);
  const esc = await resolverEscopo(prisma, tipo, filtro);
  if (esc.vazio) return [];
  if (tipo === "FABRICANTE") {
    const rows = await prisma.produto.findMany({ where: whereFabricante(filtro, esc), select: { id: true, fabricanteId: true } });
    return rows.map((r) => ({ chave: chaveAlvo(r.id, null), produtoId: r.id, farmaciaId: null, valorAnteriorId: r.fabricanteId }));
  }
  const rows = await prisma.produtoFarmacia.findMany({
    where: whereFornecedor(filtro, esc),
    select: { produtoId: true, farmaciaId: true, fornecedorHabitualId: true },
  });
  return rows.map((r) => ({
    chave: chaveAlvo(r.produtoId, r.farmaciaId),
    produtoId: r.produtoId,
    farmaciaId: r.farmaciaId,
    valorAnteriorId: r.fornecedorHabitualId,
  }));
}

/** Hash verificável do que o utilizador viu no preview (ver cabeçalho do módulo). */
export function hashSnapshot(tipo: TipoManutencaoMassa, filtro: ManutencaoMassaFiltro, alvos: readonly Alvo[]): string {
  const ordenados = [...alvos].sort((a, b) => (a.chave < b.chave ? -1 : a.chave > b.chave ? 1 : 0));
  return createHash("sha256")
    .update(JSON.stringify([tipo, normalizarFiltro(filtro), ordenados.map((a) => [a.chave, a.valorAnteriorId])]))
    .digest("hex");
}

// ─── Destino ────────────────────────────────────────────────────────────────

export type DestinoResolvido =
  | { status: "existente"; id: string; nome: string }
  | { status: "novo"; nomeCanonico: string }
  | { status: "ambiguo"; candidatos: string[] }
  | { status: "invalido" };

/**
 * Resolve o destino SEM criar nada — usado no preview e, com `tx`, dentro da
 * transacção do apply para revalidar um destino "existente" em tempo real.
 */
export async function resolverDestinoPreview(prisma: Tx, tipo: TipoManutencaoMassa, destino: DestinoInput): Promise<DestinoResolvido> {
  if (destino.modo === "existente") {
    if (tipo === "FABRICANTE") {
      const f = await prisma.fabricante.findUnique({ where: { id: destino.id }, select: { id: true, nomeNormalizado: true, estado: true } });
      if (!f || f.estado !== "ATIVO") return { status: "invalido" };
      return { status: "existente", id: f.id, nome: f.nomeNormalizado };
    }
    const f = await prisma.fornecedor.findUnique({ where: { id: destino.id }, select: { id: true, nomeNormalizado: true, nome: true, estado: true } });
    if (!f || f.estado !== "ATIVO") return { status: "invalido" };
    return { status: "existente", id: f.id, nome: f.nome ?? f.nomeNormalizado };
  }

  if (tipo === "FABRICANTE") {
    const r = await resolverOuCriarFabricante(prisma, destino.nome, { criarSeInexistente: false });
    if (r.status === "resolvido") {
      const f = await prisma.fabricante.findUnique({ where: { id: r.fabricanteId }, select: { nomeNormalizado: true } });
      return { status: "existente", id: r.fabricanteId, nome: f?.nomeNormalizado ?? "" };
    }
    if (r.status === "ambiguo") return { status: "ambiguo", candidatos: r.candidatos };
    const canonico = normalizeFabricanteCanonico(destino.nome);
    return canonico ? { status: "novo", nomeCanonico: canonico } : { status: "invalido" };
  }

  const r = await resolverOuCriarFornecedor(prisma, destino.nome, { criarSeInexistente: false });
  if (r.status === "resolvido") {
    const f = await prisma.fornecedor.findUnique({ where: { id: r.fornecedorId }, select: { nomeNormalizado: true, nome: true } });
    return { status: "existente", id: r.fornecedorId, nome: f?.nome ?? f?.nomeNormalizado ?? "" };
  }
  if (r.status === "ambiguo") return { status: "ambiguo", candidatos: r.candidatos };
  const canonico = normalizeFornecedorCanonico(destino.nome);
  return canonico ? { status: "novo", nomeCanonico: canonico } : { status: "invalido" };
}

/**
 * Resolve o destino PARA APLICAR — cria quando `modo:"novo"` e não existir ainda.
 * Corre SEMPRE dentro da transacção do apply: uma falha posterior reverte também
 * a criação (nunca fica um Fabricante/Fornecedor órfão).
 */
async function resolverDestinoParaAplicar(tx: Tx, tipo: TipoManutencaoMassa, destino: DestinoInput): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (destino.modo === "existente") {
    const check = await resolverDestinoPreview(tx, tipo, destino);
    if (check.status !== "existente") return { ok: false, error: "Destino inválido." };
    return { ok: true, id: check.id };
  }
  if (tipo === "FABRICANTE") {
    const r = await resolverOuCriarFabricante(tx, destino.nome, { criarSeInexistente: true });
    if (r.status !== "resolvido") return { ok: false, error: r.status === "ambiguo" ? "Nome de fabricante ambíguo." : "Nome de fabricante inválido." };
    return { ok: true, id: r.fabricanteId };
  }
  const r = await resolverOuCriarFornecedor(tx, destino.nome, { criarSeInexistente: true });
  if (r.status !== "resolvido") return { ok: false, error: r.status === "ambiguo" ? "Nome de fornecedor ambíguo." : "Nome de fornecedor inválido." };
  return { ok: true, id: r.fornecedorId };
}

// ─── Preview ────────────────────────────────────────────────────────────────

export type GrupoValorAnterior = { valorAnteriorId: string | null; valorAnteriorNome: string | null; count: number };

export type PreviewFarmacia = {
  farmaciaId: string | null;
  farmaciaNome: string | null;
  /** Produtos abrangidos (seleccionados) nesta farmácia. */
  abrangidos: number;
  alterados: number;
  ignorados: number;
  agrupadoPorValorAnterior: GrupoValorAnterior[];
};

export type PreviewOperacaoResultado =
  | {
      ok: true;
      tipo: TipoManutencaoMassa;
      /** Filtro em forma canónica — o que o snapshot cobre. */
      filtro: ManutencaoMassaFiltro;
      /** Quantos correspondem ao filtro, antes da selecção. */
      totalCorrespondentes: number;
      /** Quantos estão seleccionados (= o âmbito desta operação). */
      totalCount: number;
      agrupadoPorValorAnterior: GrupoValorAnterior[];
      porFarmacia: PreviewFarmacia[];
      jaNoDestinoCount: number;
      iraAlterarCount: number;
      ignoradosPorMotivo: Array<{ motivo: string; count: number }>;
      destino: DestinoResolvido;
      amostra: ItemManutencaoMassa[];
      snapshotHash: string;
    }
  | { ok: false; error: string };

const AMOSTRA_LIMITE = 200;
export const MOTIVO_JA_NO_DESTINO = "Já tem o valor de destino";

async function nomesPorId(prisma: PrismaClient, tipo: TipoManutencaoMassa, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  if (tipo === "FABRICANTE") {
    for (const parte of chunks(ids, 5000)) {
      const rows = await prisma.fabricante.findMany({ where: { id: { in: parte } }, select: { id: true, nomeNormalizado: true } });
      for (const r of rows) out.set(r.id, r.nomeNormalizado);
    }
  } else {
    for (const parte of chunks(ids, 5000)) {
      const rows = await prisma.fornecedor.findMany({ where: { id: { in: parte } }, select: { id: true, nome: true, nomeNormalizado: true } });
      for (const r of rows) out.set(r.id, r.nome ?? r.nomeNormalizado);
    }
  }
  return out;
}

function agrupar(alvos: readonly Alvo[], nomes: Map<string, string>): GrupoValorAnterior[] {
  const m = new Map<string | null, number>();
  for (const a of alvos) m.set(a.valorAnteriorId, (m.get(a.valorAnteriorId) ?? 0) + 1);
  return [...m.entries()]
    .map(([id, count]) => ({ valorAnteriorId: id, valorAnteriorNome: id ? (nomes.get(id) ?? null) : null, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Preview obrigatório antes de aplicar. Contagens SEMPRE exactas; só a amostra
 * é capada. Respeita a selecção do utilizador e devolve o snapshot verificável.
 */
export async function previewOperacao(
  prisma: PrismaClient,
  tipo: TipoManutencaoMassa,
  filtroEntrada: ManutencaoMassaFiltro,
  destinoInput: DestinoInput,
  selecao?: SelecaoManutencao
): Promise<PreviewOperacaoResultado> {
  const erroFiltro = validarFiltro(tipo, filtroEntrada);
  if (erroFiltro) return { ok: false, error: erroFiltro };
  const filtro = normalizarFiltro(filtroEntrada);

  const destino = await resolverDestinoPreview(prisma, tipo, destinoInput);
  if (destino.status === "invalido") return { ok: false, error: "Nome de destino inválido." };
  if (destino.status === "ambiguo") return { ok: false, error: "Nome de destino ambíguo — corresponde a mais do que um registo existente." };
  const destinoId = destino.status === "existente" ? destino.id : null;

  const todos = await resolverAlvos(prisma, tipo, filtro);
  const selecionados = aplicarSelecao(todos, selecao);
  const snapshotHash = hashSnapshot(tipo, filtro, selecionados);

  const valorIds = [...new Set(selecionados.map((a) => a.valorAnteriorId).filter((x): x is string => !!x))];
  const nomes = await nomesPorId(prisma, tipo, valorIds);
  const jaNoDestino = destinoId ? selecionados.filter((a) => a.valorAnteriorId === destinoId) : [];

  const farmacias = tipo === "FORNECEDOR"
    ? await prisma.farmacia.findMany({ where: { id: { in: [...new Set(selecionados.map((a) => a.farmaciaId!))] } }, select: { id: true, nome: true } })
    : [];
  const nomeFarmacia = new Map(farmacias.map((f) => [f.id, f.nome]));

  const grupos = new Map<string | null, Alvo[]>();
  for (const a of selecionados) {
    const g = grupos.get(a.farmaciaId) ?? [];
    g.push(a);
    grupos.set(a.farmaciaId, g);
  }
  const porFarmacia: PreviewFarmacia[] = [...grupos.entries()]
    .map(([farmaciaId, lista]) => {
      const ignorados = destinoId ? lista.filter((a) => a.valorAnteriorId === destinoId).length : 0;
      return {
        farmaciaId,
        farmaciaNome: farmaciaId ? (nomeFarmacia.get(farmaciaId) ?? null) : null,
        abrangidos: lista.length,
        alterados: lista.length - ignorados,
        ignorados,
        agrupadoPorValorAnterior: agrupar(lista, nomes),
      };
    })
    .sort((a, b) => (a.farmaciaNome ?? "").localeCompare(b.farmaciaNome ?? ""));

  // Amostra: primeiras N linhas seleccionadas, na ordem da grelha (designação), com nomes.
  const idsAmostra = selecionados.slice(0, 5000);
  const amostra = await amostraDeAlvos(prisma, idsAmostra, nomeFarmacia, nomes);

  return {
    ok: true,
    tipo,
    filtro,
    totalCorrespondentes: todos.length,
    totalCount: selecionados.length,
    agrupadoPorValorAnterior: agrupar(selecionados, nomes),
    porFarmacia,
    jaNoDestinoCount: jaNoDestino.length,
    iraAlterarCount: selecionados.length - jaNoDestino.length,
    ignoradosPorMotivo: jaNoDestino.length > 0 ? [{ motivo: MOTIVO_JA_NO_DESTINO, count: jaNoDestino.length }] : [],
    destino,
    amostra,
    snapshotHash,
  };
}

async function amostraDeAlvos(
  prisma: PrismaClient,
  alvos: readonly Alvo[],
  nomeFarmacia: Map<string, string>,
  nomesValor: Map<string, string>
): Promise<ItemManutencaoMassa[]> {
  if (alvos.length === 0) return [];
  const ids = [...new Set(alvos.map((a) => a.produtoId))];
  const produtos: Array<{ id: string; cnp: number; designacao: string }> = [];
  for (const parte of chunks(ids, 5000)) {
    produtos.push(...(await prisma.produto.findMany({ where: { id: { in: parte } }, select: { id: true, cnp: true, designacao: true } })));
  }
  const porId = new Map(produtos.map((p) => [p.id, p]));
  return alvos
    .map((a) => ({ a, p: porId.get(a.produtoId) }))
    .filter((x): x is { a: Alvo; p: { id: string; cnp: number; designacao: string } } => !!x.p)
    .sort((x, y) => x.p.designacao.localeCompare(y.p.designacao) || x.p.cnp - y.p.cnp)
    .slice(0, AMOSTRA_LIMITE)
    .map(({ a, p }) => ({
      chave: a.chave,
      produtoId: a.produtoId,
      farmaciaId: a.farmaciaId,
      farmaciaNome: a.farmaciaId ? (nomeFarmacia.get(a.farmaciaId) ?? null) : null,
      cnp: p.cnp,
      designacao: p.designacao,
      valorAtualId: a.valorAnteriorId,
      valorAtualNome: a.valorAnteriorId ? (nomesValor.get(a.valorAnteriorId) ?? null) : null,
    }));
}

// ─── Apply ──────────────────────────────────────────────────────────────────

export type AplicarManutencaoMassaInput = {
  tipo: TipoManutencaoMassa;
  filtro: ManutencaoMassaFiltro;
  destino: DestinoInput;
  /** Selecção do utilizador — sempre intersectada com o que o filtro confirma no servidor. */
  selecao?: SelecaoManutencao;
  /** Hash devolvido pelo preview que o utilizador confirmou. Obrigatório. */
  snapshotHash: string;
  utilizadorId: string;
  motivo?: string | null;
};

export type OperacaoCriada = {
  operacaoId: string;
  farmaciaId: string | null;
  quantidadeSolicitada: number;
  quantidadeAlterada: number;
  quantidadeIgnorada: number;
};

export type AplicarManutencaoMassaResultado =
  | {
      ok: true;
      /** Uma operação por farmácia (FORNECEDOR) ou uma só (FABRICANTE). */
      operacoes: OperacaoCriada[];
      operacaoId: string;
      quantidadeSolicitada: number;
      quantidadeAlterada: number;
      quantidadeIgnorada: number;
    }
  | { ok: false; error: string; code?: "PREVIEW_DESACTUALIZADO" | "CONCORRENCIA" };

class ErroNegocio extends Error {
  constructor(message: string, readonly code?: "CONCORRENCIA") {
    super(message);
  }
}

/**
 * Aplica a operação, totalmente transaccional (incluindo a resolução/criação do
 * destino). Valida SEMPRE no servidor: filtro, selecção e snapshot contra os
 * dados reais; cada escrita é compare-and-set sobre o valor anterior.
 */
export async function aplicarManutencaoMassa(prisma: PrismaClient, input: AplicarManutencaoMassaInput): Promise<AplicarManutencaoMassaResultado> {
  const erroFiltro = validarFiltro(input.tipo, input.filtro);
  if (erroFiltro) return { ok: false, error: erroFiltro };
  const filtro = normalizarFiltro(input.filtro);

  const todos = await resolverAlvos(prisma, input.tipo, filtro);
  const alvo = aplicarSelecao(todos, input.selecao);
  if (alvo.length === 0) return { ok: false, error: "Nenhum produto corresponde aos filtros indicados." };
  if (!input.snapshotHash || hashSnapshot(input.tipo, filtro, alvo) !== input.snapshotHash) {
    return {
      ok: false,
      code: "PREVIEW_DESACTUALIZADO",
      error: "Os produtos abrangidos mudaram desde a pré-visualização (ou a selecção não corresponde) — volte a pré-visualizar antes de aplicar.",
    };
  }

  try {
    const operacoes = await prisma.$transaction(
      async (tx) => {
        const destinoResolvido = await resolverDestinoParaAplicar(tx, input.tipo, input.destino);
        if (!destinoResolvido.ok) throw new ErroNegocio(destinoResolvido.error);
        const destinoId = destinoResolvido.id;

        const porFarmacia = new Map<string | null, Alvo[]>();
        for (const a of alvo) {
          const g = porFarmacia.get(a.farmaciaId) ?? [];
          g.push(a);
          porFarmacia.set(a.farmaciaId, g);
        }

        const criadas: OperacaoCriada[] = [];
        for (const [farmaciaId, lista] of porFarmacia) {
          let alterados = 0;
          let ignorados = 0;

          // Agrupa por valor anterior → um `updateMany` por (valor anterior, bloco), em
          // compare-and-set: se alguma linha já não tem esse valor, a operação inteira reverte.
          const porValor = new Map<string | null, string[]>();
          for (const a of lista) {
            if (a.valorAnteriorId === destinoId) {
              ignorados++;
              continue;
            }
            const g = porValor.get(a.valorAnteriorId) ?? [];
            g.push(a.produtoId);
            porValor.set(a.valorAnteriorId, g);
          }
          for (const [valorAnterior, produtoIds] of porValor) {
            for (const bloco of chunks(produtoIds)) {
              const r =
                input.tipo === "FABRICANTE"
                  ? await tx.produto.updateMany({
                      where: { id: { in: bloco }, fabricanteId: valorAnterior },
                      data: { fabricanteId: destinoId, dataAtualizacao: new Date() },
                    })
                  : await tx.produtoFarmacia.updateMany({
                      where: { farmaciaId: farmaciaId!, produtoId: { in: bloco }, fornecedorHabitualId: valorAnterior },
                      data: { fornecedorHabitualId: destinoId },
                    });
              if (r.count !== bloco.length) {
                throw new ErroNegocio("Os dados mudaram durante a aplicação (outra operação alterou estes produtos) — nada foi alterado.", "CONCORRENCIA");
              }
              alterados += r.count;
            }
          }

          const operacao = await tx.catalogoManutencaoOperacao.create({
            data: {
              tipo: input.tipo,
              utilizadorId: input.utilizadorId,
              farmaciaId: input.tipo === "FORNECEDOR" ? farmaciaId : null,
              filtrosJson: JSON.stringify({ filtro, selecao: input.selecao ? { modo: input.selecao.modo } : { modo: "todos" }, snapshotHash: input.snapshotHash }),
              valorNovoId: destinoId,
              quantidadeSolicitada: lista.length,
              quantidadeAlterada: alterados,
              quantidadeIgnorada: ignorados,
              motivo: input.motivo ?? null,
              origem: "MANUTENCAO_MASSA",
            },
            select: { id: true },
          });
          for (const bloco of chunks(lista, 5000)) {
            await tx.catalogoManutencaoOperacaoItem.createMany({
              data: bloco.map((a) => ({ operacaoId: operacao.id, produtoId: a.produtoId, valorAnteriorId: a.valorAnteriorId, valorNovoId: destinoId })),
            });
          }
          criadas.push({
            operacaoId: operacao.id,
            farmaciaId: input.tipo === "FORNECEDOR" ? farmaciaId : null,
            quantidadeSolicitada: lista.length,
            quantidadeAlterada: alterados,
            quantidadeIgnorada: ignorados,
          });
        }
        return criadas;
      },
      { maxWait: 10_000, timeout: 120_000 }
    );

    return {
      ok: true,
      operacoes,
      operacaoId: operacoes[0].operacaoId,
      quantidadeSolicitada: operacoes.reduce((s, o) => s + o.quantidadeSolicitada, 0),
      quantidadeAlterada: operacoes.reduce((s, o) => s + o.quantidadeAlterada, 0),
      quantidadeIgnorada: operacoes.reduce((s, o) => s + o.quantidadeIgnorada, 0),
    };
  } catch (err) {
    if (err instanceof ErroNegocio) return { ok: false, error: err.message, ...(err.code ? { code: err.code } : {}) };
    return { ok: false, error: err instanceof Error ? err.message : "Erro desconhecido ao aplicar manutenção em massa." };
  }
}

/** Moda (valor mais frequente) — só usado como resumo informativo no cabeçalho da reversão. */
export function modaValorNovoId(itens: Array<{ valorNovoId: string }>): string {
  const counts = new Map<string, number>();
  for (const i of itens) counts.set(i.valorNovoId, (counts.get(i.valorNovoId) ?? 0) + 1);
  let melhor = itens[0].valorNovoId;
  let melhorCount = -1;
  for (const [id, c] of counts) {
    if (c > melhorCount) {
      melhor = id;
      melhorCount = c;
    }
  }
  return melhor;
}

export type ReverterOperacaoResultado =
  | { ok: true; operacaoOrigemId: string; novaOperacaoId: string; revertidos: number; ignorados: Array<{ produtoId: string; motivo: string }> }
  | { ok: false; error: string };

/**
 * Reverte uma operação: cada item só é revertido se (a) tiver valor anterior
 * registado (restaurar para «vazio» não é representável — `valorNovoId` é NOT
 * NULL), (b) nenhuma operação POSTERIOR do mesmo tipo/farmácia tocou o produto e
 * (c) o valor actual ainda for o que esta operação escreveu. Cria uma NOVA
 * operação (`origem: "REVERSAO"`). Escritas em bloco, compare-and-set.
 */
export async function reverterOperacao(prisma: PrismaClient, operacaoOrigemId: string, utilizadorId: string, motivo?: string | null): Promise<ReverterOperacaoResultado> {
  const original = await prisma.catalogoManutencaoOperacao.findUnique({ where: { id: operacaoOrigemId }, include: { itens: true } });
  if (!original) return { ok: false, error: "Operação não encontrada." };

  try {
    const resultado = await prisma.$transaction(
      async (tx) => {
        const produtoIds = original.itens.map((i) => i.produtoId);
        const tocadosDepois = new Set<string>();
        for (const bloco of chunks(produtoIds)) {
          const posteriores = await tx.catalogoManutencaoOperacaoItem.findMany({
            where: {
              produtoId: { in: bloco },
              operacao: { tipo: original.tipo, farmaciaId: original.farmaciaId, dataCriacao: { gt: original.dataCriacao } },
            },
            select: { produtoId: true },
          });
          for (const p of posteriores) tocadosDepois.add(p.produtoId);
        }

        // valores actuais, em bloco
        const atual = new Map<string, string | null>();
        for (const bloco of chunks(produtoIds)) {
          if (original.tipo === "FABRICANTE") {
            const ps = await tx.produto.findMany({ where: { id: { in: bloco } }, select: { id: true, fabricanteId: true } });
            for (const p of ps) atual.set(p.id, p.fabricanteId);
          } else {
            const pfs = await tx.produtoFarmacia.findMany({
              where: { farmaciaId: original.farmaciaId!, produtoId: { in: bloco } },
              select: { produtoId: true, fornecedorHabitualId: true },
            });
            for (const p of pfs) atual.set(p.produtoId, p.fornecedorHabitualId);
          }
        }

        const ignorados: Array<{ produtoId: string; motivo: string }> = [];
        const elegiveis: Array<{ produtoId: string; de: string; para: string }> = [];
        for (const item of original.itens) {
          if (item.valorAnteriorId === null) {
            ignorados.push({ produtoId: item.produtoId, motivo: "Sem valor anterior registado — reversão para vazio não suportada." });
          } else if (tocadosDepois.has(item.produtoId)) {
            ignorados.push({ produtoId: item.produtoId, motivo: "Produto alterado por uma operação posterior." });
          } else if ((atual.get(item.produtoId) ?? null) !== item.valorNovoId) {
            ignorados.push({ produtoId: item.produtoId, motivo: "Valor actual já não corresponde ao valor aplicado por esta operação." });
          } else if (item.valorAnteriorId === item.valorNovoId) {
            ignorados.push({ produtoId: item.produtoId, motivo: "A operação original não alterou este produto." });
          } else {
            elegiveis.push({ produtoId: item.produtoId, de: item.valorNovoId, para: item.valorAnteriorId });
          }
        }
        if (elegiveis.length === 0) throw new Error("NENHUM_ELEGIVEL");

        const porPar = new Map<string, string[]>();
        for (const e of elegiveis) {
          const k = `${e.de}>${e.para}`;
          const g = porPar.get(k) ?? [];
          g.push(e.produtoId);
          porPar.set(k, g);
        }
        for (const [k, ids] of porPar) {
          const [de, para] = k.split(">");
          for (const bloco of chunks(ids)) {
            const r =
              original.tipo === "FABRICANTE"
                ? await tx.produto.updateMany({ where: { id: { in: bloco }, fabricanteId: de }, data: { fabricanteId: para, dataAtualizacao: new Date() } })
                : await tx.produtoFarmacia.updateMany({
                    where: { farmaciaId: original.farmaciaId!, produtoId: { in: bloco }, fornecedorHabitualId: de },
                    data: { fornecedorHabitualId: para },
                  });
            if (r.count !== bloco.length) throw new Error("Os dados mudaram durante a reversão — nada foi alterado.");
          }
        }

        const novaOperacao = await tx.catalogoManutencaoOperacao.create({
          data: {
            tipo: original.tipo,
            utilizadorId,
            farmaciaId: original.farmaciaId,
            filtrosJson: original.filtrosJson,
            valorNovoId: modaValorNovoId(elegiveis.map((i) => ({ valorNovoId: i.para }))),
            quantidadeSolicitada: original.itens.length,
            quantidadeAlterada: elegiveis.length,
            quantidadeIgnorada: ignorados.length,
            motivo: motivo ?? null,
            origem: "REVERSAO",
            operacaoOrigemId: original.id,
          },
          select: { id: true },
        });
        for (const bloco of chunks(elegiveis, 5000)) {
          await tx.catalogoManutencaoOperacaoItem.createMany({
            data: bloco.map((e) => ({ operacaoId: novaOperacao.id, produtoId: e.produtoId, valorAnteriorId: e.de, valorNovoId: e.para })),
          });
        }
        return { novaOperacaoId: novaOperacao.id, revertidos: elegiveis.length, ignorados };
      },
      { maxWait: 10_000, timeout: 120_000 }
    );

    return { ok: true, operacaoOrigemId, novaOperacaoId: resultado.novaOperacaoId, revertidos: resultado.revertidos, ignorados: resultado.ignorados };
  } catch (err) {
    if (err instanceof Error && err.message === "NENHUM_ELEGIVEL") {
      return { ok: false, error: "Nenhum produto elegível para reversão — todos foram alterados desde então." };
    }
    return { ok: false, error: err instanceof Error ? err.message : "Erro desconhecido ao reverter." };
  }
}
