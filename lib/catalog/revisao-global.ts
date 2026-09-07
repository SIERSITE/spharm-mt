/**
 * lib/catalog/revisao-global.ts
 *
 * Leitura e resolução das divergências entre o catálogo global e um
 * tenant. A porta ÚNICA — CLI e UI entram os dois por aqui.
 *
 * ─────────────────────────────────────────────────────────────────────
 * O QUE ISTO FECHA
 *
 * `CatalogoGlobalRevisao` era escrita e nunca lida. Sempre que a
 * projecção encontra no tenant uma classificação específica diferente da
 * global, `avaliarProjeccao` devolve `REVISAO`, o store abre uma linha —
 * e mais nada acontece. Não havia página, comando ou consulta que a
 * mostrasse. Cada divergência detectada era uma linha que ninguém via.
 *
 * A tabela é exactamente o mecanismo que torna a projecção segura: é para
 * onde vai o que o global NÃO pode sobrepor. Escrevê-la sem a ler é ter a
 * contenção do risco sem a parte em que alguém olha para ele.
 *
 * ─────────────────────────────────────────────────────────────────────
 * O QUE ISTO **NÃO** FAZ
 *
 * Resolver uma revisão marca-a como tratada e mais nada. Não escreve em
 * `Produto`, não escreve em `CatalogoGlobal`, não promove, não projecta.
 *
 * A separação é deliberada. Quem resolve está a dizer «isto foi visto e
 * decidido», e o que decidiu fica escrito. Mudar a classificação por
 * causa disso é outro acto, com outras guardas — `catalog:promote-global`
 * de um lado, a validação manual no tenant do outro — e juntá-los aqui
 * daria a um clique num ecrã de triagem o poder de reescrever o catálogo
 * nacional.
 */
import { controlPrisma } from "../control-plane";

/**
 * O cliente do control plane.
 *
 * Parametro em vez de import fixo para os testes poderem passar um duplo.
 * Em producao ninguem o passa — o default e o cliente real, e nao ha
 * segundo caminho de execucao: sao as mesmas consultas, noutro cliente.
 *
 * Sem isto, provar "a segunda resolucao nao sobrepoe a primeira" exigia
 * um control plane a serio, e essa e' precisamente a garantia que nao
 * pode ficar por testar.
 */
export type ClienteControl = typeof controlPrisma;

/** Uma revisão, com o estado global do CNP a que diz respeito. */
export type RevisaoGlobal = {
  id: string;
  cnp: number;
  tenantSlug: string;
  tipo: string;
  valorGlobal: string | null;
  valorLocal: string | null;
  detalhe: string | null;
  detectadoEm: Date;
  resolvidoEm: Date | null;
  resolucao: string | null;
  resolvidoPor: string | null;
  /** Estado actual do global — pode ter mudado desde a detecção. */
  globalCategoria: string | null;
  globalSubcategoria: string | null;
  globalOrigem: string | null;
  globalConfidence: number | null;
  globalVersaoRegras: string | null;
};

export type EstadoRevisao = "PENDENTE" | "RESOLVIDA" | "TODAS";

export type FiltrosRevisao = {
  estado?: EstadoRevisao;
  tenantSlug?: string;
  cnp?: number;
  tipo?: string;
  page?: number;
  pageSize?: number;
};

export const PAGINA_REVISAO = 25;
const PAGINA_MAX = 200;

export function whereRevisao(f: FiltrosRevisao) {
  const estado = f.estado ?? "PENDENTE";
  return {
    ...(estado === "PENDENTE" ? { resolvidoEm: null } : {}),
    ...(estado === "RESOLVIDA" ? { resolvidoEm: { not: null } } : {}),
    ...(f.tenantSlug ? { tenantSlug: f.tenantSlug } : {}),
    ...(f.cnp ? { cnp: f.cnp } : {}),
    ...(f.tipo ? { tipo: f.tipo } : {}),
  };
}

const achatar = (r: {
  id: string; cnp: number; tenantSlug: string; tipo: string;
  valorGlobal: string | null; valorLocal: string | null; detalhe: string | null;
  detectadoEm: Date; resolvidoEm: Date | null; resolucao: string | null;
  resolvidoPor: string | null;
  produto: {
    categoria: string | null; subcategoria: string | null;
    origem: string; confidence: number; versaoRegras: string;
  } | null;
}): RevisaoGlobal => ({
  id: r.id,
  cnp: r.cnp,
  tenantSlug: r.tenantSlug,
  tipo: r.tipo,
  valorGlobal: r.valorGlobal,
  valorLocal: r.valorLocal,
  detalhe: r.detalhe,
  detectadoEm: r.detectadoEm,
  resolvidoEm: r.resolvidoEm,
  resolucao: r.resolucao,
  resolvidoPor: r.resolvidoPor,
  globalCategoria: r.produto?.categoria ?? null,
  globalSubcategoria: r.produto?.subcategoria ?? null,
  globalOrigem: r.produto?.origem ?? null,
  globalConfidence: r.produto?.confidence ?? null,
  globalVersaoRegras: r.produto?.versaoRegras ?? null,
});

/** Uma página de revisões, mais o total que o filtro apanha. */
export async function listarRevisoesGlobais(
  f: FiltrosRevisao = {},
  cliente: ClienteControl = controlPrisma,
): Promise<{ linhas: RevisaoGlobal[]; total: number; page: number; pageSize: number }> {
  const page = Math.max(1, Math.floor(f.page ?? 1));
  const pageSize = Math.min(PAGINA_MAX, Math.max(1, Math.floor(f.pageSize ?? PAGINA_REVISAO)));
  const w = whereRevisao(f);

  const [linhas, total] = await Promise.all([
    cliente.catalogoGlobalRevisao.findMany({
      where: w,
      // Por resolver primeiro e mais recentes no topo: é a ordem de quem
      // vem triar, não a de quem vem auditar.
      orderBy: [{ resolvidoEm: { sort: "asc", nulls: "first" } }, { detectadoEm: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        produto: {
          select: { categoria: true, subcategoria: true, origem: true, confidence: true, versaoRegras: true },
        },
      },
    }),
    cliente.catalogoGlobalRevisao.count({ where: w }),
  ]);

  return { linhas: linhas.map(achatar), total, page, pageSize };
}

/** Uma revisão pelo id, com o estado global actual. */
export async function lerRevisaoGlobal(
  id: string,
  cliente: ClienteControl = controlPrisma,
): Promise<RevisaoGlobal | null> {
  const r = await cliente.catalogoGlobalRevisao.findUnique({
    where: { id },
    include: {
      produto: {
        select: { categoria: true, subcategoria: true, origem: true, confidence: true, versaoRegras: true },
      },
    },
  });
  return r ? achatar(r) : null;
}

/** Contagens por tenant e por tipo, sobre as que estão por resolver. */
export async function resumoRevisoesGlobais(cliente: ClienteControl = controlPrisma): Promise<{
  pendentes: number;
  resolvidas: number;
  porTenant: Array<{ tenantSlug: string; n: number }>;
  porTipo: Array<{ tipo: string; n: number }>;
  maisAntiga: Date | null;
}> {
  const [pendentes, resolvidas, porTenant, porTipo, antiga] = await Promise.all([
    cliente.catalogoGlobalRevisao.count({ where: { resolvidoEm: null } }),
    cliente.catalogoGlobalRevisao.count({ where: { resolvidoEm: { not: null } } }),
    cliente.catalogoGlobalRevisao.groupBy({
      by: ["tenantSlug"],
      where: { resolvidoEm: null },
      _count: { _all: true },
    }),
    cliente.catalogoGlobalRevisao.groupBy({
      by: ["tipo"],
      where: { resolvidoEm: null },
      _count: { _all: true },
    }),
    cliente.catalogoGlobalRevisao.findFirst({
      where: { resolvidoEm: null },
      orderBy: { detectadoEm: "asc" },
      select: { detectadoEm: true },
    }),
  ]);

  return {
    pendentes,
    resolvidas,
    porTenant: porTenant
      .map((r) => ({ tenantSlug: r.tenantSlug, n: r._count._all }))
      .sort((a, b) => b.n - a.n),
    porTipo: porTipo.map((r) => ({ tipo: r.tipo, n: r._count._all })).sort((a, b) => b.n - a.n),
    maisAntiga: antiga?.detectadoEm ?? null,
  };
}

/**
 * Grupos (cnp, tenantSlug, tipo) com mais do que uma revisão POR RESOLVER.
 *
 * Não deviam existir: o store faz `findFirst` antes de criar. Mas essa
 * guarda é do lado da aplicação e duas corridas em paralelo passam as
 * duas por ela — é precisamente o que uma restrição na base impediria.
 * Medir antes de a impor: um índice único parcial rebenta a migração se
 * já houver duplicados, e descobri-lo a meio de uma migração do control
 * plane é o pior sítio para o descobrir.
 */
export async function duplicadosRevisoesGlobais(
  cliente: ClienteControl = controlPrisma,
): Promise<Array<{ cnp: number; tenantSlug: string; tipo: string; n: number }>> {
  const grupos = await cliente.catalogoGlobalRevisao.groupBy({
    by: ["cnp", "tenantSlug", "tipo"],
    where: { resolvidoEm: null },
    _count: { _all: true },
    having: { cnp: { _count: { gt: 1 } } },
  });
  return grupos
    .map((g) => ({ cnp: g.cnp, tenantSlug: g.tenantSlug, tipo: g.tipo, n: g._count._all }))
    .sort((a, b) => b.n - a.n);
}

// ═════════════════════════════════════════════════════════════════════
// RESOLUÇÃO
// ═════════════════════════════════════════════════════════════════════

export type PedidoResolucao = {
  id: string;
  aprovador: string;
  motivo: string;
};

export type PedidoLimpo = { id: string; aprovador: string; motivo: string };

/**
 * As duas exigências, num sítio só e sem base de dados.
 *
 * Estão aqui — e não em cada chamador — porque são a definição de
 * resolução válida, e a CLI e a UI têm de a partilhar. Duas cópias
 * divergem, e o que diverge numa guarda de auditoria é sempre a mais
 * frouxa a ganhar.
 *
 * `trim` antes de medir: um espaço não é um aprovador.
 */
export function validarPedidoResolucao(
  p: Partial<PedidoResolucao>,
): { ok: true; limpo: PedidoLimpo } | { ok: false; erro: string } {
  const id = (p.id ?? "").trim();
  const aprovador = (p.aprovador ?? "").trim();
  const motivo = (p.motivo ?? "").trim();

  if (!id) return { ok: false, erro: "falta o id da revisão" };
  if (!aprovador) {
    return { ok: false, erro: "falta o aprovador — uma resolução sem autor não é auditável" };
  }
  if (!motivo) {
    return { ok: false, erro: "falta o motivo — é o que se lê quando alguém perguntar porquê" };
  }
  return { ok: true, limpo: { id, aprovador, motivo } };
}

export type ResultadoResolucao =
  | { ok: true; revisao: RevisaoGlobal }
  | { ok: false; erro: string; jaResolvida?: RevisaoGlobal };

/**
 * Marca uma revisão como resolvida. Nada mais é escrito em lado nenhum.
 *
 * ── Idempotência, e porque não é um `update` simples ─────────────────
 *
 * O `where` inclui `resolvidoEm: null`. Uma segunda resolução não escreve
 * — não porque se verificou antes e se escreveu depois (entre as duas há
 * uma janela), mas porque a condição vive na própria escrita.
 *
 * E não escrever em silêncio seria pior do que escrever: quem resolveu
 * ficava a pensar que a sua resolução ficou registada quando ficou a de
 * outra pessoa. Por isso o caso devolve `jaResolvida` com quem e quando —
 * é uma resposta, não um erro engolido.
 */
export async function resolverRevisaoGlobal(
  p: Partial<PedidoResolucao>,
  cliente: ClienteControl = controlPrisma,
): Promise<ResultadoResolucao> {
  const v = validarPedidoResolucao(p);
  if (!v.ok) return { ok: false, erro: v.erro };
  const { id, aprovador, motivo } = v.limpo;

  const n = await cliente.catalogoGlobalRevisao.updateMany({
    where: { id, resolvidoEm: null },
    data: { resolvidoEm: new Date(), resolucao: motivo, resolvidoPor: aprovador },
  });

  const actual = await lerRevisaoGlobal(id, cliente);
  if (!actual) return { ok: false, erro: `revisão ${id} não existe` };

  if (n.count === 0) {
    return {
      ok: false,
      erro:
        `já tinha sido resolvida por ${actual.resolvidoPor ?? "(sem autor registado)"} ` +
        `em ${actual.resolvidoEm?.toISOString() ?? "?"} — não foi sobreposta`,
      jaResolvida: actual,
    };
  }
  return { ok: true, revisao: actual };
}

// ═════════════════════════════════════════════════════════════════════
// ENCERRAMENTO EM BLOCO DOS FALSOS CONFLITOS
// ═════════════════════════════════════════════════════════════════════

/**
 * O snapshot que uma revisão gravou quando o global não classificava nada.
 *
 * `avaliarProjeccao` construía `valorGlobal` por template literal —
 * `${global.categoria} > ${global.subcategoria}` — e com os dois a null
 * isso dá esta string, literalmente. É feia, e é exactamente por ser
 * literal que serve de critério: identifica sem ambiguidade as linhas
 * nascidas do defeito.
 */
export const SNAPSHOT_SEM_CLASSIFICACAO = "null > null";

/**
 * Porque é o SNAPSHOT e não o estado actual do `CatalogoGlobal`.
 *
 * Em produção mediram-se 1 246 pendentes: 1 185 com o global HOJE sem
 * classificação, mas 1 212 gravadas com `"null > null"`. A diferença são
 * 27 revisões que nasceram falsas e cujo CNP entretanto ganhou
 * classificação global.
 *
 * Pelo estado actual, essas 27 pareceriam conflitos reais e ficariam para
 * uma pessoa decidir uma divergência que nunca existiu. Pelo snapshot,
 * são o que foram: ruído do defeito.
 *
 * A regra é a mesma que vale para qualquer rasto de auditoria — julga-se
 * o acto pelo que era verdade quando aconteceu, não pelo que é verdade
 * agora.
 */
export type ResumoEncerramento = {
  candidatas: number;
  encerradas: number;
  /** Pendentes que NÃO batem no critério — conflitos a sério. */
  preservadas: number;
  porTenant: Array<{ tenantSlug: string; n: number }>;
};

/**
 * As pendentes, separadas pelo SNAPSHOT e cruzadas com o estado de hoje.
 *
 * Contagens exactas, não amostra: com mais de mil pendentes uma página
 * de 200 dava um número que parecia exacto e não era — e este é
 * precisamente o número que decide o que se encerra em bloco.
 *
 * `falsosMasGlobalMudou` é o subconjunto dos falsos cujo CNP já ganhou
 * classificação global desde a detecção. Estão contados DENTRO de
 * `falsosSnapshot`, e existem como linha própria porque são os únicos que
 * o critério do snapshot e o critério do estado-de-hoje classificariam de
 * maneira diferente. Em produção eram 27.
 */
export async function contarPorSnapshot(cliente: ClienteControl = controlPrisma): Promise<{
  pendentes: number;
  falsosSnapshot: number;
  falsosMasGlobalMudou: number;
  conflitosReais: number;
}> {
  const [pendentes, falsosSnapshot, falsosMasGlobalMudou] = await Promise.all([
    cliente.catalogoGlobalRevisao.count({ where: { resolvidoEm: null } }),
    cliente.catalogoGlobalRevisao.count({
      where: { resolvidoEm: null, valorGlobal: SNAPSHOT_SEM_CLASSIFICACAO },
    }),
    cliente.catalogoGlobalRevisao.count({
      where: {
        resolvidoEm: null,
        valorGlobal: SNAPSHOT_SEM_CLASSIFICACAO,
        produto: { categoria: { not: null }, subcategoria: { not: null } },
      },
    }),
  ]);
  return {
    pendentes,
    falsosSnapshot,
    falsosMasGlobalMudou,
    conflitosReais: pendentes - falsosSnapshot,
  };
}

/**
 * Fecha as revisões que o defeito criou. Nada mais.
 *
 * Critério estrito e não parametrizável: `resolvidoEm is null` E
 * `valorGlobal = "null > null"`. Não recebe lista de ids nem filtro de
 * tenant — um encerramento em bloco com critério configurável é uma
 * maneira de fechar por engano o que se queria ler.
 *
 * Idempotente: a segunda corrida não encontra candidatas, porque a
 * primeira lhes pôs `resolvidoEm`.
 *
 * NÃO toca em `Produto` nem em `CatalogoGlobal`. Uma única escrita, na
 * própria tabela de revisões.
 */
export async function encerrarFalsosConflitos(
  p: { aprovador: string; motivo: string; dryRun?: boolean },
  cliente: ClienteControl = controlPrisma,
): Promise<{ ok: true; resumo: ResumoEncerramento } | { ok: false; erro: string }> {
  const aprovador = (p.aprovador ?? "").trim();
  const motivo = (p.motivo ?? "").trim();
  if (!aprovador) {
    return { ok: false, erro: "falta o aprovador — um encerramento em bloco sem autor não é auditável" };
  }
  if (!motivo) return { ok: false, erro: "falta o motivo" };

  const alvo = { resolvidoEm: null, valorGlobal: SNAPSHOT_SEM_CLASSIFICACAO };

  const [candidatas, pendentes, porTenant] = await Promise.all([
    cliente.catalogoGlobalRevisao.count({ where: alvo }),
    cliente.catalogoGlobalRevisao.count({ where: { resolvidoEm: null } }),
    cliente.catalogoGlobalRevisao.groupBy({
      by: ["tenantSlug"],
      where: alvo,
      _count: { _all: true },
    }),
  ]);

  const resumo: ResumoEncerramento = {
    candidatas,
    encerradas: 0,
    preservadas: pendentes - candidatas,
    porTenant: porTenant
      .map((t) => ({ tenantSlug: t.tenantSlug, n: t._count._all }))
      .sort((a, b) => b.n - a.n),
  };

  if (p.dryRun !== false) return { ok: true, resumo };

  const n = await cliente.catalogoGlobalRevisao.updateMany({
    where: alvo,
    data: { resolvidoEm: new Date(), resolucao: motivo, resolvidoPor: aprovador },
  });
  resumo.encerradas = n.count;
  return { ok: true, resumo };
}
