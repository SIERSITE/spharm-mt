/**
 * scripts/diagnostics/auditoria-fabricantes-grupos-garantia.ts
 *
 * Auditoria SOMENTE LEITURA do agrupamento de fabricantes nos filtros do tenant garantia. Pensada para correr contra a
 * base REAL do Garantia (por isso NÃO se restringe a localhost) — a segurança vem de ela nunca poder escrever:
 *   · só corre com `--confirmo-read-only` e com a URL passada EXPLICITAMENTE (`--url <url>`, 1.º argumento posicional ou
 *     `AUDITORIA_DATABASE_URL`; nunca `DATABASE_URL`, para não apanhar uma base por engano);
 *   · a sessão abre com `default_transaction_read_only=on`, a consulta corre numa transacção `READ ONLY` (REPEATABLE
 *     READ: um retrato coerente) e antes de qualquer consulta confirma `transaction_read_only = on`; só há SELECT;
 *   · nunca imprime a password (a URL é mascarada em todas as saídas, incluindo mensagens de erro);
 *   · `--out ficheiro.md|.json` escreve o relatório num FICHEIRO local (não na base).
 *
 * O que produz (consola e `--out`): fabricantes apresentados antes / opções depois do agrupamento; grupos com mais
 * variantes e quantos têm mais de 10; por grupo, nome canónico, fabricantes membros (nome, id, tipo de associação,
 * validadoManualmente), aliases, produtos abrangidos e produtos incluídos por regra CNP/snapshot/manual/alias cujo
 * fabricante NÃO é membro; fabricantes semelhantes que ficaram separados (SÓ candidatos para revisão humana — a
 * semelhança de nomes nunca agrupa nada); ambiguidades e sobreposições; e a secção «casos com mais de dez nomes».
 *
 * Uso:
 *   npx tsx scripts/diagnostics/auditoria-fabricantes-grupos-garantia.ts --confirmo-read-only \
 *       --url postgresql://utilizador:***@host:5432/base [--out relatorio.md|relatorio.json] [--top 15]
 */
import { writeFileSync } from "node:fs";
import { Client } from "pg";
import { PrismaClient } from "../../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { carregarLaboratoriosGarantia } from "../../lib/catalog/carregar-laboratorios-garantia";
import { agruparOpcoesLaboratorio, type CatalogoFilterOptionLaboratorio } from "../../lib/catalog/laboratorio-filtro";

// ─── Tipos do relatório ──────────────────────────────────────────────────────────────────────────────────────────────

export type MembroGrupo = {
  id: string;
  nome: string;
  tipoAssociacao: string;
  validadoManualmente: boolean;
  aliases: string[];
  produtos: number;
};

export type ProdutoForaDoGrupo = {
  produtoId: string;
  cnp: number;
  designacao: string;
  fabricante: string | null;
  origem: string;
  validadoManualmente: boolean;
  /** `incluido_por_regra` = base aprovada (regra CNP / manual / alias / snapshot); `obsoleto` = FABRICANTE_INEQUIVOCO sem membro (a reconciliação diária remove). */
  motivo: "incluido_por_regra" | "obsoleto_sem_base_atual";
  fabricanteMembroDeOutroGrupo: string | null;
};

export type GrupoAuditado = {
  id: string;
  nome: string;
  aliases: string[];
  membros: MembroGrupo[];
  nomesTotal: number;
  produtosAbrangidos: number;
  produtosPorOrigem: Record<string, number>;
  produtosForaDoGrupo: { total: number; porOrigem: Record<string, number>; amostra: ProdutoForaDoGrupo[] };
  produtosDeMembrosForaDoGrupo: { total: number; amostra: Array<{ produtoId: string; cnp: number; designacao: string; fabricante: string; grupoAtual: string | null; origemAtual: string | null }> };
};

export type CandidatoRevisao = { fabricante: string; fabricanteId: string; produtos: number; grupo: string; razao: string };
export type ClusterSolto = { chave: string; fabricantes: Array<{ id: string; nome: string; produtos: number }> };
export type Ambiguidade = { tipo: string; detalhe: string };

export type CasoMaisDeDezNomes = {
  grupo: string;
  variantes: number;
  nomes: number;
  todasAgrupadas: boolean;
  /** Variantes que NÃO estão (como variante) nas opções do filtro ou que ainda aparecem como opção de topo. */
  variantesEmFalta: string[];
  produtosDosMembros: number;
  produtosDosMembrosNoGrupo: number;
};

export type RelatorioAuditoria = {
  geradoEm: string;
  base: string;
  fabricantesAtivos: number;
  /** Opções «antes»: fabricantes ATIVO com pelo menos um produto (a lista que os filtros mostravam, uma por fabricante). */
  fabricantesApresentadosAntes: number;
  /** Opções «depois»: o que o filtro agrupado mostra (grupos + fabricantes sem prova), pela mesma função da UI. */
  opcoesDepois: number;
  gruposAtivos: number;
  gruposComMaisDeDezVariantes: number;
  gruposComMaisVariantes: Array<{ grupo: string; variantes: number; produtos: number }>;
  grupos: GrupoAuditado[];
  candidatosParaRevisao: CandidatoRevisao[];
  clustersSoltos: ClusterSolto[];
  ambiguidades: Ambiguidade[];
  casosMaisDeDezNomes: CasoMaisDeDezNomes[];
  resumoForaDoGrupo: { incluidosPorRegra: number; obsoletosSemBase: number; deMembroNoutroGrupoOuSemLinha: number };
};

// ─── Argumentos e segurança ──────────────────────────────────────────────────────────────────────────────────────────

export type ArgumentosAuditoria = { url: string; out: string | null; top: number };

/** Esconde a password de qualquer URL de ligação (e a sua versão codificada) num texto. */
export function mascararSegredos(texto: string, url?: string): string {
  let out = texto.replace(/(postgres(?:ql)?:\/\/[^:\/\s@]+:)[^@\s]*@/gi, "$1***@");
  if (url) {
    try {
      const pw = new URL(url).password;
      if (pw) for (const v of new Set([pw, decodeURIComponent(pw)])) if (v) out = out.split(v).join("***");
    } catch {
      /* URL inválida — já mascarada acima */
    }
  }
  return out;
}

/** Identificação segura da base para o relatório: host:porta/base, sem utilizador nem password. */
export function descreverBase(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.port ? `:${u.port}` : ""}${u.pathname}`;
  } catch {
    return "(url inválida)";
  }
}

export function lerArgumentos(argv: readonly string[], env: Record<string, string | undefined> = process.env): ArgumentosAuditoria {
  let url: string | undefined;
  let out: string | null = null;
  let top = 15;
  let confirmo = false;
  const posicionais: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--confirmo-read-only") confirmo = true;
    else if (a === "--url") url = argv[++i];
    else if (a.startsWith("--url=")) url = a.slice("--url=".length);
    else if (a === "--out") out = argv[++i] ?? null;
    else if (a.startsWith("--out=")) out = a.slice("--out=".length);
    else if (a === "--top") top = Number(argv[++i]);
    else if (a.startsWith("--top=")) top = Number(a.slice("--top=".length));
    else if (!a.startsWith("--")) posicionais.push(a);
    else throw new Error(`Argumento desconhecido: ${a}`);
  }
  if (!confirmo) throw new Error("Recusado: falta --confirmo-read-only. Este comando só LÊ, mas exige a confirmação explícita antes de abrir a ligação.");
  url = url ?? posicionais[0] ?? env.AUDITORIA_DATABASE_URL;
  if (!url) throw new Error("Recusado: passe a URL explicitamente (--url <url>, 1.º argumento ou AUDITORIA_DATABASE_URL). DATABASE_URL NÃO é usada por omissão.");
  try {
    const p = new URL(url).protocol;
    if (p !== "postgresql:" && p !== "postgres:") throw new Error();
  } catch {
    throw new Error("Recusado: a URL não é uma URL PostgreSQL válida.");
  }
  if (!Number.isInteger(top) || top < 1 || top > 1000) throw new Error("--top tem de ser um inteiro entre 1 e 1000.");
  if (out && !/\.(md|json)$/i.test(out)) throw new Error("--out tem de terminar em .md ou .json.");
  return { url, out, top };
}

// ─── Comparação de nomes — SÓ para listar candidatos a revisão humana, nunca para agrupar ────────────────────────────

const PALAVRAS_GENERICAS = new Set([
  "LDA", "LIMITADA", "SA", "S", "A", "LABORATORIOS", "LABORATORIO", "LAB", "LABS", "LABORATORY", "LABORATORIES", "PHARMA", "PHARMACEUTICALS",
  "PHARMACEUTICAL", "FARMACEUTICA", "FARMACEUTICAS", "FARMACEUTICO", "PORTUGAL", "PRODUTOS", "INDUSTRIA", "INDUSTRIAS", "GMBH", "BV", "AG", "INC",
  "LTD", "DE", "DA", "DO", "DOS", "DAS", "E", "THE", "EESV", "UNIPESSOAL", "COMERCIO", "COMPANY", "CO", "SL", "SRL", "SPA", "NV", "KG", "AB", "AS", "OY",
  "PORTUGUESA", "LUSITANA", "IBERICA", "ESPANA", "EUROPE", "INTERNATIONAL", "GROUP", "HEALTH", "HEALTHCARE", "MEDICAL", "FARMA", "SAUDE",
]);

export function tokensSignificativos(nome: string): string[] {
  return nome
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((t) => t.length > 0 && !PALAVRAS_GENERICAS.has(t));
}

/** Razão da semelhança, ou null. Prefixo da string normalizada (≥4 letras) ou 1.º token significativo comum (≥4 letras). */
export function razaoSemelhanca(a: string, b: string): string | null {
  const ta = tokensSignificativos(a);
  const tb = tokensSignificativos(b);
  if (ta.length === 0 || tb.length === 0) return null;
  const ja = ta.join(" ");
  const jb = tb.join(" ");
  if (ja === jb) return "mesmos tokens significativos";
  if (ja.length >= 4 && jb.length >= 4 && (ja.startsWith(jb) || jb.startsWith(ja))) return "um nome é prefixo do outro";
  if (ta[0]!.length >= 4 && ta[0] === tb[0]) return `1.º token comum «${ta[0]}»`;
  return null;
}

// ─── Consulta ────────────────────────────────────────────────────────────────────────────────────────────────────────

type Linha = Record<string, unknown>;
const s = (v: unknown) => (v == null ? "" : String(v));
const n = (v: unknown) => Number(v ?? 0);

/** Pura sobre as opções já carregadas (mantida: usada pelos testes). */
export function auditarOpcoes(opcoes: readonly CatalogoFilterOptionLaboratorio[], topN = 10) {
  const fabricantes = opcoes.filter((o) => o.tipo === "fabricante");
  const grupos = opcoes.filter((o) => o.tipo === "grupo");
  const agrupadas = agruparOpcoesLaboratorio(opcoes);
  const soltos = agrupadas.filter((i) => i.opcao.tipo === "fabricante");
  return {
    fabricantes: fabricantes.length,
    opcoesAntes: fabricantes.length,
    opcoesDepois: agrupadas.length,
    grupos: grupos.length,
    gruposComMaisVariantes: grupos
      .map((g) => ({ grupo: g.tipo === "grupo" ? g.nome : "", variantes: g.tipo === "grupo" ? (g.variantes ?? []).length : 0, produtos: g.produtos }))
      .sort((a, b) => b.variantes - a.variantes || a.grupo.localeCompare(b.grupo, "pt-PT"))
      .slice(0, topN),
    fabricantesSemProva: soltos
      .map((i) => ({ fabricante: i.opcao.tipo === "fabricante" ? i.opcao.nomeNormalizado : "", produtos: i.opcao.produtos }))
      .sort((a, b) => a.fabricante.localeCompare(b.fabricante, "pt-PT")),
  };
}

const AMOSTRA_MAX = 50;

export async function executarAuditoria(url: string, topN = 15): Promise<RelatorioAuditoria> {
  const opcoesLigacao = "-c default_transaction_read_only=on";
  const cliente = new Client({ connectionString: url, options: opcoesLigacao });
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, options: opcoesLigacao }) });
  try {
    await cliente.connect();
    await cliente.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const ro = await cliente.query("SHOW transaction_read_only");
    if (ro.rows[0]?.transaction_read_only !== "on") throw new Error("A sessão não ficou em modo só-leitura — abortado antes de qualquer consulta.");
    const q = async (sql: string): Promise<Linha[]> => (await cliente.query(sql)).rows as Linha[];

    // Opções do filtro, pelas MESMAS funções da UI (sessão também só-leitura).
    const opcoes = await carregarLaboratoriosGarantia(prisma);
    const agrupadas = agruparOpcoesLaboratorio(opcoes);
    const opcoesGrupo = opcoes.filter((o): o is Extract<CatalogoFilterOptionLaboratorio, { tipo: "grupo" }> => o.tipo === "grupo");

    const fabricantes = await q(`
      SELECT f.id, f."nomeNormalizado" AS nome, f.estado::text AS estado, count(p.id)::int AS produtos
        FROM "Fabricante" f LEFT JOIN "Produto" p ON p."fabricanteId" = f.id
       GROUP BY f.id ORDER BY f."nomeNormalizado", f.id`);
    const fabAliases = await q(`SELECT "fabricanteId", "aliasNome" FROM "FabricanteAlias" ORDER BY "aliasNome", id`);
    const grupos = await q(`SELECT id, nome, "nomeNormalizado", estado::text AS estado FROM "GrupoLaboratorial" ORDER BY nome, id`);
    const gruposAliases = await q(`SELECT "grupoLaboratorialId" AS g, alias, "aliasNormalizado" AS norm, estado::text AS estado FROM "GrupoLaboratorialAlias" ORDER BY alias, id`);
    const membrosRaw = await q(`
      SELECT gf."grupoLaboratorialId" AS g, gf."fabricanteId" AS fid, gf."tipoAssociacao", gf."validadoManualmente" AS val
        FROM "GrupoLaboratorialFabricante" gf ORDER BY gf."fabricanteId"`);
    const pglPorGrupoOrigem = await q(`SELECT "grupoLaboratorialId" AS g, origem, count(*)::int AS n FROM "ProdutoGrupoLaboratorial" GROUP BY 1, 2`);
    const fora = await q(`
      SELECT pgl."grupoLaboratorialId" AS g, pgl.origem, pgl."validadoManualmente" AS val, p.id AS pid, p.cnp, p.designacao,
             f."nomeNormalizado" AS fnome, gfo."grupoLaboratorialId" AS outro
        FROM "ProdutoGrupoLaboratorial" pgl
        JOIN "Produto" p ON p.id = pgl."produtoId"
        LEFT JOIN "Fabricante" f ON f.id = p."fabricanteId"
        LEFT JOIN "GrupoLaboratorialFabricante" gf ON gf."fabricanteId" = p."fabricanteId" AND gf."grupoLaboratorialId" = pgl."grupoLaboratorialId"
        LEFT JOIN "GrupoLaboratorialFabricante" gfo ON gfo."fabricanteId" = p."fabricanteId"
       WHERE gf.id IS NULL
       ORDER BY pgl."grupoLaboratorialId", pgl.origem, p.cnp`);
    const membroForaRaw = await q(`
      SELECT gf."grupoLaboratorialId" AS g, p.id AS pid, p.cnp, p.designacao, f."nomeNormalizado" AS fnome,
             pgl."grupoLaboratorialId" AS atual, pgl.origem
        FROM "GrupoLaboratorialFabricante" gf
        JOIN "Produto" p ON p."fabricanteId" = gf."fabricanteId"
        JOIN "Fabricante" f ON f.id = gf."fabricanteId"
        LEFT JOIN "ProdutoGrupoLaboratorial" pgl ON pgl."produtoId" = p.id
       WHERE pgl.id IS NULL OR pgl."grupoLaboratorialId" <> gf."grupoLaboratorialId"
       ORDER BY gf."grupoLaboratorialId", p.cnp`);
    const regras = await q(`
      SELECT r.cnp, r."grupoLaboratorialId" AS g, r.estado::text AS estado, r."validadoManualmente" AS val,
             p.id AS pid, pgl."grupoLaboratorialId" AS atual, pgl.origem, gf."grupoLaboratorialId" AS fg, f."nomeNormalizado" AS fnome
        FROM "RegraGrupoLaboratorialPorCnp" r
        LEFT JOIN "Produto" p ON p.cnp = r.cnp
        LEFT JOIN "ProdutoGrupoLaboratorial" pgl ON pgl."produtoId" = p.id
        LEFT JOIN "GrupoLaboratorialFabricante" gf ON gf."fabricanteId" = p."fabricanteId"
        LEFT JOIN "Fabricante" f ON f.id = p."fabricanteId"
       ORDER BY r.cnp`);
    const aliasesGrupoPartilhados = await q(`
      SELECT "aliasNormalizado" AS norm, array_agg(DISTINCT "grupoLaboratorialId" ORDER BY "grupoLaboratorialId") AS gs
        FROM "GrupoLaboratorialAlias" WHERE estado = 'ATIVO' GROUP BY 1 HAVING count(DISTINCT "grupoLaboratorialId") > 1`);
    await cliente.query("ROLLBACK");

    // ── Índices ──
    const nomeGrupo = new Map(grupos.map((g) => [s(g.id), s(g.nome)]));
    const fabPorId = new Map(fabricantes.map((f) => [s(f.id), { id: s(f.id), nome: s(f.nome), estado: s(f.estado), produtos: n(f.produtos) }]));
    const aliasesFab = new Map<string, string[]>();
    for (const a of fabAliases) (aliasesFab.get(s(a.fabricanteId)) ?? aliasesFab.set(s(a.fabricanteId), []).get(s(a.fabricanteId))!).push(s(a.aliasNome));
    const aliasesGrupo = new Map<string, string[]>();
    for (const a of gruposAliases) if (s(a.estado) === "ATIVO") (aliasesGrupo.get(s(a.g)) ?? aliasesGrupo.set(s(a.g), []).get(s(a.g))!).push(s(a.alias));
    const grupoDoFabricante = new Map(membrosRaw.map((m) => [s(m.fid), s(m.g)]));
    const membrosPorGrupo = new Map<string, MembroGrupo[]>();
    for (const m of membrosRaw) {
      const f = fabPorId.get(s(m.fid));
      if (!f) continue;
      const lista = membrosPorGrupo.get(s(m.g)) ?? [];
      lista.push({ id: f.id, nome: f.nome, tipoAssociacao: s(m.tipoAssociacao), validadoManualmente: !!m.val, aliases: aliasesFab.get(f.id) ?? [], produtos: f.produtos });
      membrosPorGrupo.set(s(m.g), lista);
    }
    for (const lista of membrosPorGrupo.values()) lista.sort((a, b) => a.nome.localeCompare(b.nome, "pt-PT") || a.id.localeCompare(b.id));

    const produtosPorOrigem = new Map<string, Record<string, number>>();
    for (const r of pglPorGrupoOrigem) {
      const o = produtosPorOrigem.get(s(r.g)) ?? {};
      o[s(r.origem)] = n(r.n);
      produtosPorOrigem.set(s(r.g), o);
    }

    // ── Produtos incluídos num grupo cujo fabricante NÃO é membro desse grupo ──
    const foraPorGrupo = new Map<string, ProdutoForaDoGrupo[]>();
    for (const r of fora) {
      const origem = s(r.origem);
      const item: ProdutoForaDoGrupo = {
        produtoId: s(r.pid),
        cnp: n(r.cnp),
        designacao: s(r.designacao),
        fabricante: r.fnome == null ? null : s(r.fnome),
        origem,
        validadoManualmente: !!r.val,
        motivo: origem === "FABRICANTE_INEQUIVOCO" ? "obsoleto_sem_base_atual" : "incluido_por_regra",
        fabricanteMembroDeOutroGrupo: r.outro == null ? null : (nomeGrupo.get(s(r.outro)) ?? s(r.outro)),
      };
      (foraPorGrupo.get(s(r.g)) ?? foraPorGrupo.set(s(r.g), []).get(s(r.g))!).push(item);
    }
    const membroForaPorGrupo = new Map<string, Linha[]>();
    for (const r of membroForaRaw) (membroForaPorGrupo.get(s(r.g)) ?? membroForaPorGrupo.set(s(r.g), []).get(s(r.g))!).push(r);

    const gruposAuditados: GrupoAuditado[] = grupos
      .filter((g) => s(g.estado) === "ATIVO")
      .map((g) => {
        const id = s(g.id);
        const membros = membrosPorGrupo.get(id) ?? [];
        const foraLista = foraPorGrupo.get(id) ?? [];
        const porOrigemFora: Record<string, number> = {};
        for (const f of foraLista) porOrigemFora[f.origem] = (porOrigemFora[f.origem] ?? 0) + 1;
        const mf = membroForaPorGrupo.get(id) ?? [];
        const aliasesDoGrupo = aliasesGrupo.get(id) ?? [];
        const porOrigem = produtosPorOrigem.get(id) ?? {};
        return {
          id,
          nome: s(g.nome),
          aliases: aliasesDoGrupo,
          membros,
          nomesTotal: membros.length + membros.reduce((t, m) => t + m.aliases.length, 0) + aliasesDoGrupo.length,
          produtosAbrangidos: Object.values(porOrigem).reduce((t, v) => t + v, 0),
          produtosPorOrigem: porOrigem,
          produtosForaDoGrupo: { total: foraLista.length, porOrigem: porOrigemFora, amostra: foraLista.slice(0, AMOSTRA_MAX) },
          produtosDeMembrosForaDoGrupo: {
            total: mf.length,
            amostra: mf.slice(0, AMOSTRA_MAX).map((r) => ({
              produtoId: s(r.pid), cnp: n(r.cnp), designacao: s(r.designacao), fabricante: s(r.fnome),
              grupoAtual: r.atual == null ? null : (nomeGrupo.get(s(r.atual)) ?? s(r.atual)), origemAtual: r.origem == null ? null : s(r.origem),
            })),
          },
        };
      })
      .sort((a, b) => b.membros.length - a.membros.length || a.nome.localeCompare(b.nome, "pt-PT") || a.id.localeCompare(b.id));

    // ── Candidatos a revisão (nomes semelhantes SEM prova) — só listagem ──
    const referencias: Array<{ grupo: string; texto: string; origem: string }> = [];
    for (const g of gruposAuditados) {
      referencias.push({ grupo: g.nome, texto: g.nome, origem: "nome do grupo" });
      for (const a of g.aliases) referencias.push({ grupo: g.nome, texto: a, origem: "alias do grupo" });
      for (const m of g.membros) {
        referencias.push({ grupo: g.nome, texto: m.nome, origem: "fabricante membro" });
        for (const a of m.aliases) referencias.push({ grupo: g.nome, texto: a, origem: "alias de membro" });
      }
    }
    const soltos = [...fabPorId.values()].filter((f) => f.estado === "ATIVO" && !grupoDoFabricante.has(f.id));
    const candidatos: CandidatoRevisao[] = [];
    for (const f of soltos) {
      const vistos = new Set<string>();
      for (const ref of referencias) {
        if (vistos.has(ref.grupo)) continue;
        const razao = razaoSemelhanca(f.nome, ref.texto);
        if (razao) {
          vistos.add(ref.grupo);
          candidatos.push({ fabricante: f.nome, fabricanteId: f.id, produtos: f.produtos, grupo: ref.grupo, razao: `${razao} (${ref.origem}: ${ref.texto})` });
        }
      }
    }
    candidatos.sort((a, b) => b.produtos - a.produtos || a.fabricante.localeCompare(b.fabricante, "pt-PT") || a.grupo.localeCompare(b.grupo, "pt-PT"));

    const porChave = new Map<string, Array<{ id: string; nome: string; produtos: number }>>();
    for (const f of soltos) {
      const t = tokensSignificativos(f.nome);
      if (t.length === 0 || t[0]!.length < 4) continue;
      (porChave.get(t[0]!) ?? porChave.set(t[0]!, []).get(t[0]!)!).push({ id: f.id, nome: f.nome, produtos: f.produtos });
    }
    const clustersSoltos: ClusterSolto[] = [...porChave.entries()]
      .filter(([, l]) => l.length >= 2)
      .map(([chave, l]) => ({ chave, fabricantes: l.sort((a, b) => a.nome.localeCompare(b.nome, "pt-PT") || a.id.localeCompare(b.id)) }))
      .sort((a, b) => b.fabricantes.length - a.fabricantes.length || a.chave.localeCompare(b.chave));

    // ── Ambiguidades e sobreposições ──
    const ambiguidades: Ambiguidade[] = [];
    for (const r of aliasesGrupoPartilhados) {
      const gs = (r.gs as string[]).map((id) => nomeGrupo.get(id) ?? id);
      ambiguidades.push({ tipo: "alias de grupo partilhado", detalhe: `«${s(r.norm)}» é alias ativo de ${gs.length} grupos: ${gs.join(", ")}` });
    }
    const aliasPorTexto = new Map<string, Set<string>>();
    for (const a of fabAliases) {
      const k = s(a.aliasNome).toUpperCase();
      (aliasPorTexto.get(k) ?? aliasPorTexto.set(k, new Set()).get(k)!).add(s(a.fabricanteId));
    }
    for (const [texto, ids] of aliasPorTexto) {
      if (ids.size < 2) continue;
      const gs = new Set([...ids].map((id) => grupoDoFabricante.get(id) ?? "(sem grupo)"));
      if (gs.size > 1) {
        const nomes = [...ids].map((id) => `${fabPorId.get(id)?.nome ?? id} [${nomeGrupo.get(grupoDoFabricante.get(id) ?? "") ?? "sem grupo"}]`);
        ambiguidades.push({ tipo: "alias de fabricante partilhado entre grupos", detalhe: `«${texto}» em ${nomes.join("; ")}` });
      }
    }
    const nomeFabNorm = new Map<string, string[]>();
    for (const f of fabPorId.values()) (nomeFabNorm.get(f.nome.toUpperCase()) ?? nomeFabNorm.set(f.nome.toUpperCase(), []).get(f.nome.toUpperCase())!).push(f.id);
    for (const g of gruposAuditados) {
      for (const a of g.aliases) {
        for (const fid of nomeFabNorm.get(a.toUpperCase()) ?? []) {
          const outro = grupoDoFabricante.get(fid);
          if (outro && outro !== g.id) ambiguidades.push({ tipo: "alias de grupo = fabricante de outro grupo", detalhe: `alias «${a}» de ${g.nome} é o fabricante «${fabPorId.get(fid)?.nome}» do grupo ${nomeGrupo.get(outro)}` });
        }
      }
    }
    for (const r of regras) {
      const gNome = nomeGrupo.get(s(r.g)) ?? s(r.g);
      const ativa = s(r.estado) === "ATIVO";
      if (ativa && !!r.val && r.pid != null && (r.atual == null || s(r.atual) !== s(r.g))) {
        ambiguidades.push({ tipo: "regra CNP não refletida no produto", detalhe: `CNP ${s(r.cnp)}: regra → ${gNome}, produto está em ${r.atual == null ? "nenhum grupo" : (nomeGrupo.get(s(r.atual)) ?? s(r.atual))} (${s(r.origem) || "sem linha"})` });
      }
      if (ativa && r.fg != null && s(r.fg) !== s(r.g)) {
        ambiguidades.push({ tipo: "regra CNP contra o grupo do fabricante", detalhe: `CNP ${s(r.cnp)}: regra → ${gNome}, mas o fabricante «${s(r.fnome)}» é membro de ${nomeGrupo.get(s(r.fg)) ?? s(r.fg)}` });
      }
    }
    for (const g of gruposAuditados) {
      if (g.produtosDeMembrosForaDoGrupo.total > 0) {
        const noutro = membroForaPorGrupo.get(g.id)!.filter((r) => r.atual != null).length;
        if (noutro > 0) ambiguidades.push({ tipo: "produto com grupo ≠ grupo do fabricante", detalhe: `${g.nome}: ${noutro} produto(s) de fabricantes membros estão noutro grupo` });
      }
    }
    for (const m of membrosRaw) {
      if (!grupos.some((g) => s(g.id) === s(m.g) && s(g.estado) === "ATIVO")) ambiguidades.push({ tipo: "membro de grupo inativo", detalhe: `fabricante «${fabPorId.get(s(m.fid))?.nome ?? s(m.fid)}» associado a um grupo não ativo` });
    }
    ambiguidades.sort((a, b) => a.tipo.localeCompare(b.tipo) || a.detalhe.localeCompare(b.detalhe, "pt-PT"));

    // ── Casos com mais de dez nomes ──
    const topLevelFabricantes = new Set(agrupadas.filter((i) => i.opcao.tipo === "fabricante").map((i) => i.opcao.id));
    const casos: CasoMaisDeDezNomes[] = gruposAuditados
      .filter((g) => g.membros.length > 10)
      .map((g) => {
        const opc = opcoesGrupo.find((o) => o.id === g.id);
        const idsVariantes = new Set((opc?.variantes ?? []).map((v) => v.id));
        const emFalta = g.membros.filter((m) => !idsVariantes.has(m.id) || topLevelFabricantes.has(m.id)).map((m) => m.nome);
        const mf = membroForaPorGrupo.get(g.id) ?? [];
        const produtosDosMembros = g.membros.reduce((t, m) => t + m.produtos, 0);
        return {
          grupo: g.nome,
          variantes: g.membros.length,
          nomes: g.nomesTotal,
          todasAgrupadas: emFalta.length === 0,
          variantesEmFalta: emFalta,
          produtosDosMembros,
          produtosDosMembrosNoGrupo: produtosDosMembros - mf.length,
        };
      });

    const todosFora = gruposAuditados.flatMap((g) => foraPorGrupo.get(g.id) ?? []);
    const comMaisVariantes = gruposAuditados
      .map((g) => ({ grupo: g.nome, variantes: g.membros.length, produtos: g.produtosAbrangidos }))
      .sort((a, b) => b.variantes - a.variantes || a.grupo.localeCompare(b.grupo, "pt-PT"))
      .slice(0, topN);

    return {
      geradoEm: new Date().toISOString(),
      base: descreverBase(url),
      fabricantesAtivos: [...fabPorId.values()].filter((f) => f.estado === "ATIVO").length,
      fabricantesApresentadosAntes: [...fabPorId.values()].filter((f) => f.estado === "ATIVO" && f.produtos > 0).length,
      opcoesDepois: agrupadas.length,
      gruposAtivos: gruposAuditados.length,
      gruposComMaisDeDezVariantes: gruposAuditados.filter((g) => g.membros.length > 10).length,
      gruposComMaisVariantes: comMaisVariantes,
      grupos: gruposAuditados,
      candidatosParaRevisao: candidatos,
      clustersSoltos,
      ambiguidades,
      casosMaisDeDezNomes: casos,
      resumoForaDoGrupo: {
        incluidosPorRegra: todosFora.filter((f) => f.motivo === "incluido_por_regra").length,
        obsoletosSemBase: todosFora.filter((f) => f.motivo === "obsoleto_sem_base_atual").length,
        deMembroNoutroGrupoOuSemLinha: gruposAuditados.reduce((t, g) => t + g.produtosDeMembrosForaDoGrupo.total, 0),
      },
    };
  } catch (e) {
    await cliente.query("ROLLBACK").catch(() => undefined);
    throw new Error(mascararSegredos(e instanceof Error ? e.message : String(e), url));
  } finally {
    await cliente.end().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
  }
}

// ─── Saída ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export function renderizarMarkdown(r: RelatorioAuditoria, topN = 15): string {
  const L: string[] = [];
  const nOrigem = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join(", ") || "—";
  L.push("# Auditoria de fabricantes e grupos (Garantia) — só leitura", "");
  L.push(`Base: \`${r.base}\` · gerado em ${r.geradoEm}`, "");
  L.push("## Resumo", "");
  L.push(`- Fabricantes ATIVOS: ${r.fabricantesAtivos}`);
  L.push(`- Opções ANTES (fabricantes ativos com produtos, uma por fabricante): ${r.fabricantesApresentadosAntes}`);
  L.push(`- Opções DEPOIS (grupos + fabricantes sem prova): ${r.opcoesDepois}`);
  L.push(`- Grupos ATIVOS: ${r.gruposAtivos}; com mais de 10 variantes: ${r.gruposComMaisDeDezVariantes}`);
  L.push(`- Produtos incluídos num grupo cujo fabricante NÃO é membro: ${r.resumoForaDoGrupo.incluidosPorRegra} por regra/manual/alias (base aprovada) e ${r.resumoForaDoGrupo.obsoletosSemBase} obsoletos sem base atual (FABRICANTE_INEQUIVOCO — a reconciliação diária corrige)`);
  L.push(`- Produtos de fabricantes membros que NÃO estão no grupo do fabricante (sem linha ou noutro grupo): ${r.resumoForaDoGrupo.deMembroNoutroGrupoOuSemLinha}`, "");
  L.push(`## Top ${topN} grupos por variantes`, "", "| Grupo | Variantes | Produtos |", "|---|---:|---:|");
  for (const g of r.gruposComMaisVariantes) L.push(`| ${g.grupo} | ${g.variantes} | ${g.produtos} |`);
  L.push("", "## Casos com mais de dez nomes", "");
  if (r.casosMaisDeDezNomes.length === 0) L.push("Nenhum grupo tem mais de 10 variantes.");
  for (const c of r.casosMaisDeDezNomes) {
    L.push(`- **${c.grupo}**: ${c.variantes} variantes (${c.nomes} nomes com aliases) — ${c.todasAgrupadas ? "TODAS agrupadas no filtro" : `NÃO agrupadas: ${c.variantesEmFalta.join("; ")}`}; produtos dos membros ${c.produtosDosMembros}, no grupo ${c.produtosDosMembrosNoGrupo}`);
  }
  L.push("", "## Grupos", "");
  for (const g of r.grupos) {
    L.push(`### ${g.nome}`, "", `- Aliases do grupo: ${g.aliases.join("; ") || "—"}`);
    L.push(`- Produtos abrangidos (distintos): ${g.produtosAbrangidos} (${nOrigem(g.produtosPorOrigem)})`);
    L.push(`- Membros (${g.membros.length}):`);
    for (const m of g.membros) L.push(`  - ${m.nome} · id ${m.id} · ${m.tipoAssociacao}${m.validadoManualmente ? " · validado manualmente" : ""} · ${m.produtos} produtos${m.aliases.length ? ` · aliases: ${m.aliases.join("; ")}` : ""}`);
    L.push(`- Incluídos cujo fabricante NÃO é membro: ${g.produtosForaDoGrupo.total} (${nOrigem(g.produtosForaDoGrupo.porOrigem)})`);
    for (const p of g.produtosForaDoGrupo.amostra.slice(0, 10)) L.push(`  - CNP ${p.cnp} ${p.designacao} · fabricante ${p.fabricante ?? "—"} · ${p.origem}${p.validadoManualmente ? " (validado)" : ""} · ${p.motivo}${p.fabricanteMembroDeOutroGrupo ? ` · fabricante é membro de ${p.fabricanteMembroDeOutroGrupo}` : ""}`);
    if (g.produtosDeMembrosForaDoGrupo.total > 0) {
      L.push(`- Produtos de membros que NÃO estão neste grupo: ${g.produtosDeMembrosForaDoGrupo.total}`);
      for (const p of g.produtosDeMembrosForaDoGrupo.amostra.slice(0, 10)) L.push(`  - CNP ${p.cnp} ${p.designacao} · ${p.fabricante} · agora em ${p.grupoAtual ?? "nenhum grupo"}${p.origemAtual ? ` (${p.origemAtual})` : ""}`);
    }
    L.push("");
  }
  L.push("## Fabricantes semelhantes separados por falta de prova (candidatos para REVISÃO HUMANA — nada é agrupado por semelhança)", "");
  if (r.candidatosParaRevisao.length === 0) L.push("Nenhum candidato.");
  for (const c of r.candidatosParaRevisao.slice(0, 200)) L.push(`- ${c.fabricante} (${c.produtos} produtos) ~ grupo ${c.grupo}: ${c.razao}`);
  if (r.candidatosParaRevisao.length > 200) L.push(`- … mais ${r.candidatosParaRevisao.length - 200} (ver o JSON)`);
  L.push("", "### Fabricantes sem grupo que se parecem entre si", "");
  if (r.clustersSoltos.length === 0) L.push("Nenhum.");
  for (const c of r.clustersSoltos.slice(0, 100)) L.push(`- ${c.chave}: ${c.fabricantes.map((f) => `${f.nome} (${f.produtos})`).join("; ")}`);
  L.push("", "## Ambiguidades e sobreposições", "");
  if (r.ambiguidades.length === 0) L.push("Nenhuma.");
  for (const a of r.ambiguidades) L.push(`- [${a.tipo}] ${a.detalhe}`);
  L.push("");
  return L.join("\n");
}

async function main() {
  let args: ArgumentosAuditoria | null = null;
  try {
    args = lerArgumentos(process.argv.slice(2));
    const rel = await executarAuditoria(args.url, args.top);
    const md = renderizarMarkdown(rel, args.top);
    console.log(md);
    if (args.out) {
      writeFileSync(args.out, /\.json$/i.test(args.out) ? JSON.stringify(rel, null, 2) : md, "utf8");
      console.log(`\nRelatório escrito em ${args.out}`);
    }
  } catch (e) {
    console.error(mascararSegredos(e instanceof Error ? e.message : String(e), args?.url));
    process.exit(1);
  }
}

if (require.main === module) {
  void main();
}
