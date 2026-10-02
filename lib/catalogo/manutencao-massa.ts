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
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
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
 * Produtos com `fabricanteErpAtual` divergente entre farmácias do tenant (≥ 2 valores
 * distintos e não vazios). Sinal informativo — nunca resolve nada sozinho.
 *
 * Agregação NO POSTGRESQL (`GROUP BY … HAVING COUNT(DISTINCT …) > 1`): só devolve os ids dos
 * produtos divergentes — nunca carrega `ProdutoFarmacia` em memória. Quando os restantes critérios já
 * reduziram o universo, passa-se `candidatos` e a agregação só olha para esses produtos.
 */
export async function resolverProdutosComFabricanteDivergente(
  prisma: Tx | PrismaClient,
  candidatos?: readonly string[] | null
): Promise<Set<string>> {
  const rows =
    candidatos == null
      ? await prisma.$queryRaw<Array<{ produtoId: string }>>(Prisma.sql`
          SELECT "produtoId" FROM "ProdutoFarmacia"
          WHERE "fabricanteErpAtual" IS NOT NULL AND "fabricanteErpAtual" <> ''
          GROUP BY "produtoId" HAVING COUNT(DISTINCT "fabricanteErpAtual") > 1`)
      : candidatos.length === 0
        ? []
        : await prisma.$queryRaw<Array<{ produtoId: string }>>(Prisma.sql`
            SELECT "produtoId" FROM "ProdutoFarmacia"
            WHERE "produtoId" = ANY(${[...candidatos]}::text[])
              AND "fabricanteErpAtual" IS NOT NULL AND "fabricanteErpAtual" <> ''
            GROUP BY "produtoId" HAVING COUNT(DISTINCT "fabricanteErpAtual") > 1`);
  return new Set(rows.map((r) => r.produtoId));
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

  // «Fabricante divergente»: primeiro reduz-se o universo pelos restantes critérios (candidatos) e só depois
  // se calcula a divergência, no PostgreSQL, sobre esses candidatos.
  let divergentes: Set<string> | null = null;
  if (tipo === "FABRICANTE" && f.fabricanteDivergente) {
    const semDivergencia = whereFabricante({ ...f, fabricanteDivergente: false }, { vazio: false, prefiltroIds, periodoPorFarmacia, divergentes: null, farmacias });
    const restringe = (semDivergencia.AND as Prisma.ProdutoWhereInput[]).some((c) => Object.keys(c).length > 0);
    const candidatos = restringe ? (await prisma.produto.findMany({ where: semDivergencia, select: { id: true } })).map((p) => p.id) : null;
    divergentes = await resolverProdutosComFabricanteDivergente(prisma, candidatos);
    if (divergentes.size === 0) return vazio;
  }

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
  if (f.tiposArtigo && f.tiposArtigo.length > 0) AND.push({ tipoArtigo: { in: f.tiposArtigo } });
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

/**
 * Tecto de alvos (produtos, ou pares produto×farmácia) por operação. A operação inteira corre numa só
 * transacção (atomicidade); medido em PostgreSQL local, ~72 000 alvos demoram ~40 s dentro da transacção
 * (custo dominado pelos triggers de chave estrangeira e pela manutenção de índices), com `timeout` de 120 s.
 * Acima do tecto recusa-se com uma mensagem clara em vez de arriscar um timeout a meio.
 */
export const LIMITE_ALVOS_POR_OPERACAO = 150_000;
const MSG_LIMITE = (n: number) =>
  `A selecção tem ${n.toLocaleString("pt-PT")} alvos — acima do limite de ${LIMITE_ALVOS_POR_OPERACAO.toLocaleString("pt-PT")} por operação. Restrinja os filtros (por exemplo por categoria ou farmácia) e repita em mais do que uma operação.`;
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
  if (selecionados.length > LIMITE_ALVOS_POR_OPERACAO) return { ok: false, error: MSG_LIMITE(selecionados.length) };
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

/** Tempos (ms) de cada fase do apply — para auditar desempenho e atomicidade (tudo o que escreve está em `transacaoMs`). */
export type TemposApply = {
  /** Fora da transacção: resolver alvos + validar selecção. */
  alvosMs: number;
  hashMs: number;
  /** Dentro da transacção (total). */
  transacaoMs: number;
  destinoMs: number;
  updateMs: number;
  operacaoMs: number;
  itensMs: number;
  totalMs: number;
};

export type AplicarManutencaoMassaResultado =
  | {
      ok: true;
      tempos: TemposApply;
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
  const t0 = Date.now();
  const erroFiltro = validarFiltro(input.tipo, input.filtro);
  if (erroFiltro) return { ok: false, error: erroFiltro };
  const filtro = normalizarFiltro(input.filtro);

  const todos = await resolverAlvos(prisma, input.tipo, filtro);
  const alvo = aplicarSelecao(todos, input.selecao);
  const tAlvos = Date.now();
  if (alvo.length === 0) return { ok: false, error: "Nenhum produto corresponde aos filtros indicados." };
  if (alvo.length > LIMITE_ALVOS_POR_OPERACAO) return { ok: false, error: MSG_LIMITE(alvo.length) };
  if (!input.snapshotHash || hashSnapshot(input.tipo, filtro, alvo) !== input.snapshotHash) {
    return {
      ok: false,
      code: "PREVIEW_DESACTUALIZADO",
      error: "Os produtos abrangidos mudaram desde a pré-visualização (ou a selecção não corresponde) — volte a pré-visualizar antes de aplicar.",
    };
  }
  const tHash = Date.now();
  const parcial = { destinoMs: 0, updateMs: 0, operacaoMs: 0, itensMs: 0 };

  try {
    const tTx0 = Date.now();
    const operacoes = await prisma.$transaction(
      async (tx) => {
        const tD = Date.now();
        const destinoResolvido = await resolverDestinoParaAplicar(tx, input.tipo, input.destino);
        if (!destinoResolvido.ok) throw new ErroNegocio(destinoResolvido.error);
        const destinoId = destinoResolvido.id;
        parcial.destinoMs += Date.now() - tD;

        const porFarmacia = new Map<string | null, Alvo[]>();
        for (const a of alvo) {
          const g = porFarmacia.get(a.farmaciaId) ?? [];
          g.push(a);
          porFarmacia.set(a.farmaciaId, g);
        }

        const criadas: OperacaoCriada[] = [];
        for (const [farmaciaId, lista] of porFarmacia) {
          // Agrupa por valor anterior → UM `UPDATE` set-based por valor anterior, em compare-and-set no
          // próprio WHERE (`IS NOT DISTINCT FROM`): se alguma linha já não tem esse valor, a contagem
          // não bate e a operação inteira reverte (nada fica alterado).
          let alterados = 0;
          let ignorados = 0;
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
          const tU = Date.now();
          for (const [valorAnterior, produtoIds] of porValor) {
            const n = await atualizarEmBloco(tx, input.tipo, farmaciaId, produtoIds, valorAnterior, destinoId);
            if (n !== produtoIds.length) {
              throw new ErroNegocio("Os dados mudaram durante a aplicação (outra operação alterou estes produtos) — nada foi alterado.", "CONCORRENCIA");
            }
            alterados += n;
          }
          parcial.updateMs += Date.now() - tU;

          const tO = Date.now();
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
          parcial.operacaoMs += Date.now() - tO;
          const tI = Date.now();
          await inserirItensEmBloco(
            tx,
            operacao.id,
            lista.map((a) => ({ produtoId: a.produtoId, valorAnteriorId: a.valorAnteriorId, valorNovoId: destinoId }))
          );
          parcial.itensMs += Date.now() - tI;
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
    const tFim = Date.now();

    return {
      ok: true,
      tempos: { alvosMs: tAlvos - t0, hashMs: tHash - tAlvos, transacaoMs: tFim - tTx0, ...parcial, totalMs: tFim - t0 },
      operacoes,
      operacaoId: operacoes[0].operacaoId,
      quantidadeSolicitada: operacoes.reduce((s, o) => s + o.quantidadeSolicitada, 0),
      quantidadeAlterada: operacoes.reduce((s, o) => s + o.quantidadeAlterada, 0),
      quantidadeIgnorada: operacoes.reduce((s, o) => s + o.quantidadeIgnorada, 0),
    };
  } catch (err) {
    if (err instanceof ErroNegocio) return { ok: false, error: err.message, ...(err.code ? { code: err.code } : {}) };
    // Erro inesperado (ex.: falha da base de dados a meio): a transacção já reverteu TUDO. Não se mostra
    // ao utilizador a mensagem técnica do driver.
    console.error("[manutencao-massa] apply falhou — transacção revertida:", err);
    return { ok: false, error: "Não foi possível aplicar a operação (erro na base de dados) — nada foi alterado." };
  }
}

/**
 * UPDATE set-based em compare-and-set: só altera as linhas cujo valor actual AINDA é `valorAnterior`.
 * Devolve quantas alterou; o chamador compara com o esperado e, se diferir, reverte a transacção.
 * `dataAtualizacao` replica o `@updatedAt` do Prisma (que o SQL directo não aplica) — em Produto e em ProdutoFarmacia.
 */
async function atualizarEmBloco(
  tx: Tx,
  tipo: TipoManutencaoMassa,
  farmaciaId: string | null,
  produtoIds: readonly string[],
  valorAnterior: string | null,
  valorNovo: string
): Promise<number> {
  const ids = [...produtoIds];
  if (tipo === "FABRICANTE") {
    return tx.$executeRaw(Prisma.sql`
      UPDATE "Produto" SET "fabricanteId" = ${valorNovo}, "dataAtualizacao" = (now() AT TIME ZONE 'UTC')
      WHERE id = ANY(${ids}::text[]) AND "fabricanteId" IS NOT DISTINCT FROM ${valorAnterior}::text`);
  }
  return tx.$executeRaw(Prisma.sql`
    UPDATE "ProdutoFarmacia" SET "fornecedorHabitualId" = ${valorNovo}, "dataAtualizacao" = (now() AT TIME ZONE 'UTC')
    WHERE "farmaciaId" = ${farmaciaId}::text AND "produtoId" = ANY(${ids}::text[])
      AND "fornecedorHabitualId" IS NOT DISTINCT FROM ${valorAnterior}::text`);
}

type ItemAuditoria = { produtoId: string; valorAnteriorId: string | null; valorNovoId: string };

/** Auditoria por CONJUNTO: um `INSERT … SELECT FROM unnest(…)` por bloco (em vez de milhares de linhas por round-trip). */
async function inserirItensEmBloco(tx: Tx, operacaoId: string, itens: readonly ItemAuditoria[]): Promise<void> {
  for (const bloco of chunks(itens, 20_000)) {
    const produtoIds = bloco.map((i) => i.produtoId);
    const anteriores = bloco.map((i) => i.valorAnteriorId);
    const novos = bloco.map((i) => i.valorNovoId);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "CatalogoManutencaoOperacaoItem" (id, "operacaoId", "produtoId", "valorAnteriorId", "valorNovoId")
      SELECT gen_random_uuid()::text, ${operacaoId}::text, t.pid, t.ant, t.novo
      FROM unnest(${produtoIds}::text[], ${anteriores}::text[], ${novos}::text[]) AS t(pid, ant, novo)`);
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
        // Produtos tocados por uma operação POSTERIOR do mesmo tipo/farmácia — uma só consulta no PostgreSQL.
        const posteriores = await tx.$queryRaw<Array<{ produtoId: string }>>(Prisma.sql`
          SELECT DISTINCT i."produtoId"
          FROM "CatalogoManutencaoOperacaoItem" i
          JOIN "CatalogoManutencaoOperacao" o ON o.id = i."operacaoId"
          WHERE i."produtoId" = ANY(${produtoIds}::text[])
            AND o.tipo = ${original.tipo}::"TipoManutencaoMassa"
            AND o."farmaciaId" IS NOT DISTINCT FROM ${original.farmaciaId}::text
            AND o."dataCriacao" > ${original.dataCriacao}`);
        const tocadosDepois = new Set(posteriores.map((p) => p.produtoId));

        // valores actuais — uma só consulta
        const atual = new Map<string, string | null>();
        if (original.tipo === "FABRICANTE") {
          const ps = await tx.$queryRaw<Array<{ id: string; v: string | null }>>(Prisma.sql`
            SELECT id, "fabricanteId" AS v FROM "Produto" WHERE id = ANY(${produtoIds}::text[])`);
          for (const p of ps) atual.set(p.id, p.v);
        } else {
          const pfs = await tx.$queryRaw<Array<{ id: string; v: string | null }>>(Prisma.sql`
            SELECT "produtoId" AS id, "fornecedorHabitualId" AS v FROM "ProdutoFarmacia"
            WHERE "farmaciaId" = ${original.farmaciaId}::text AND "produtoId" = ANY(${produtoIds}::text[])`);
          for (const p of pfs) atual.set(p.id, p.v);
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
          const n = await atualizarEmBloco(tx, original.tipo, original.farmaciaId, ids, de, para);
          if (n !== ids.length) throw new Error("Os dados mudaram durante a reversão — nada foi alterado.");
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
        await inserirItensEmBloco(
          tx,
          novaOperacao.id,
          elegiveis.map((e) => ({ produtoId: e.produtoId, valorAnteriorId: e.de, valorNovoId: e.para }))
        );
        return { novaOperacaoId: novaOperacao.id, revertidos: elegiveis.length, ignorados };
      },
      { maxWait: 10_000, timeout: 120_000 }
    );

    return { ok: true, operacaoOrigemId, novaOperacaoId: resultado.novaOperacaoId, revertidos: resultado.revertidos, ignorados: resultado.ignorados };
  } catch (err) {
    if (err instanceof Error && err.message === "NENHUM_ELEGIVEL") {
      return { ok: false, error: "Nenhum produto elegível para reversão — todos foram alterados desde então." };
    }
    if (err instanceof Error && err.message.startsWith("Os dados mudaram durante a reversão")) return { ok: false, error: err.message };
    console.error("[manutencao-massa] reversão falhou — transacção revertida:", err);
    return { ok: false, error: "Não foi possível reverter a operação (erro na base de dados) — nada foi alterado." };
  }
}
