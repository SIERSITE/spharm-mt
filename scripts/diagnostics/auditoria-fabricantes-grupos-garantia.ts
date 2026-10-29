/**
 * scripts/diagnostics/auditoria-fabricantes-grupos-garantia.ts
 *
 * Auditoria SOMENTE LEITURA do agrupamento de fabricantes nos filtros do tenant garantia. Corre DENTRO do contentor
 * `migrate` (imagem `migrator`), sem receber nem mostrar URL de base de dados:
 *   · a ligação ao tenant resolve-se pelo MESMO mecanismo do `tenancy:*` — `CONTROL_DATABASE_URL` + tabela `Tenant`
 *     do control plane + password decifrada com `TENANT_ENCRYPTION_SECRET` (`buildTenantConnectionString`, que respeita
 *     `TENANT_DB_SSLMODE`) — tudo a partir do ambiente do contentor. Não há `--url` nem URL posicional;
 *   · só corre com `--confirmo-read-only`; o slug (por omissão `garantia`) tem de existir e estar ACTIVE no control plane;
 *   · as duas ligações (control plane e tenant) abrem com `default_transaction_read_only=on`; a consulta corre numa
 *     transacção `READ ONLY` (REPEATABLE READ: um retrato coerente) e antes de QUALQUER consulta confirma
 *     `SHOW transaction_read_only = on`; só há SELECT;
 *   · nunca imprime URL, utilizador, password nem host:porta (mascarados em todas as saídas, incluindo erros);
 *   · grava `auditoria-fabricantes-<slug>-<UTC>.md` e `.json` em `--out-dir` (por omissão `/relatorios`), que TEM de
 *     existir e ser gravável — não cria caminhos nem escreve fora dele; na consola só sai um resumo curto.
 *
 * O que o relatório contém: opções ANTES (uma por fabricante) e DEPOIS (grupos + fabricantes sem prova) do agrupamento;
 * grupos com mais variantes e quantos têm mais de 10; por grupo, nome canónico, fabricantes membros (nome, id, tipo de
 * associação, validadoManualmente = relações manuais), aliases (do grupo e de cada fabricante), nº de produtos distintos,
 * regras CNP e produtos manuais (CNP), produtos incluídos por regra CNP/snapshot/manual/alias cujo fabricante NÃO é
 * membro; ambiguidades e sobreposições; e fabricantes semelhantes que ficaram separados (SÓ candidatos para revisão
 * humana — a semelhança de nomes nunca agrupa nada).
 *
 * Uso (dentro do contentor; ver notes/auditoria-fabricantes-garantia-comando.md):
 *   npx tsx scripts/diagnostics/auditoria-fabricantes-grupos-garantia.ts --confirmo-read-only [--tenant garantia] \
 *       [--out-dir /relatorios] [--top 15]
 */
import { accessSync, constants as fsConstants, existsSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { PrismaClient } from "../../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { buildTenantConnectionString, type TenantRecord } from "../../lib/control-plane";
import { decryptTenantSecret } from "../../lib/tenant-crypto";
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
  /** Regras CNP (RegraGrupoLaboratorialPorCnp) deste grupo: o CNP, o estado e onde o produto está de facto. */
  regrasCnp: RegraCnpAuditada[];
  /** Produtos colocados manualmente (origem MANUAL ou validadoManualmente) neste grupo, com CNP. */
  produtosManuais: Array<{ cnp: number; designacao: string; fabricante: string | null; origem: string; fabricanteEMembro: boolean }>;
  produtosDeMembrosForaDoGrupo: { total: number; amostra: Array<{ produtoId: string; cnp: number; designacao: string; fabricante: string; grupoAtual: string | null; origemAtual: string | null }> };
};

export type RegraCnpAuditada = {
  cnp: number;
  estado: string;
  validadoManualmente: boolean;
  /** `false` quando nenhum produto tem este CNP (regra órfã). */
  produtoExiste: boolean;
  fabricante: string | null;
  fabricanteEMembro: boolean;
  grupoAtualDoProduto: string | null;
  origemAtual: string | null;
};

export type OpcaoDepois = { tipo: "grupo" | "fabricante"; id: string; nome: string; produtos: number; variantes: number };

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
  /** `tenant <slug> · base <nome>` — nunca host, utilizador nem password. */
  base: string;
  tenant: string;
  fabricantesAtivos: number;
  /** Opções «antes»: fabricantes ATIVO com pelo menos um produto (a lista que os filtros mostravam, uma por fabricante). */
  fabricantesApresentadosAntes: number;
  /** A lista «antes», uma opção por fabricante ativo com produtos. */
  opcoesAntesLista: Array<{ id: string; nome: string; produtos: number }>;
  /** A lista «depois», pela mesma função da UI (grupos com contagem de variantes + fabricantes sem prova). */
  opcoesDepoisLista: OpcaoDepois[];
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

export type ArgumentosAuditoria = { tenant: string; outDir: string; top: number };

export const SLUG_TENANT = /^[a-z0-9][a-z0-9-]{1,40}[a-z0-9]$/;
export const DIRETORIO_RELATORIOS_PADRAO = "/relatorios";
const OPCOES_SESSAO_READ_ONLY = "-c default_transaction_read_only=on";

/**
 * Esconde segredos num texto: cada valor dado (URL, password, host:porta…) e as suas variantes (descodificada,
 * codificada, e — se for um URL — a password, o utilizador e o host), mais qualquer `postgres://u:p@` residual.
 */
export function mascararSegredos(texto: string, ...segredos: Array<string | null | undefined>): string {
  let out = texto.replace(/(postgres(?:ql)?:\/\/[^:\/\s@]+:)[^@\s]*@/gi, "$1***@");
  const valores = new Set<string>();
  const juntar = (v: string | null | undefined) => {
    if (!v || v.length < 4) return;
    valores.add(v);
    try {
      valores.add(decodeURIComponent(v));
    } catch {
      /* percent-encoding inválido — fica o literal */
    }
    valores.add(encodeURIComponent(v));
  };
  for (const sgr of segredos) {
    juntar(sgr);
    if (!sgr) continue;
    try {
      const u = new URL(sgr);
      juntar(u.password);
      juntar(u.username);
      if (u.host) juntar(u.host);
    } catch {
      /* não é URL */
    }
  }
  // Os mais longos primeiro: um URL inteiro antes da sua password.
  for (const v of [...valores].sort((a, b) => b.length - a.length)) out = out.split(v).join("***");
  return out;
}

export function lerArgumentos(argv: readonly string[]): ArgumentosAuditoria {
  let tenant = "garantia";
  let outDir = DIRETORIO_RELATORIOS_PADRAO;
  let top = 15;
  let confirmo = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--confirmo-read-only") confirmo = true;
    else if (a === "--tenant") tenant = argv[++i] ?? "";
    else if (a.startsWith("--tenant=")) tenant = a.slice("--tenant=".length);
    else if (a === "--out-dir") outDir = argv[++i] ?? "";
    else if (a.startsWith("--out-dir=")) outDir = a.slice("--out-dir=".length);
    else if (a === "--top") top = Number(argv[++i]);
    else if (a.startsWith("--top=")) top = Number(a.slice("--top=".length));
    else if (a === "--url" || a.startsWith("--url=") || /^postgres(ql)?:/i.test(a)) {
      // Não repete o valor: pode ser um URL com password.
      throw new Error("Recusado: este comando NÃO aceita URL de base de dados. A ligação vem do ambiente do contentor (CONTROL_DATABASE_URL + TENANT_ENCRYPTION_SECRET).");
    } else throw new Error(`Argumento desconhecido: ${a.startsWith("--") ? a.split("=")[0] : "(posicional)"}`);
  }
  if (!confirmo) throw new Error("Recusado: falta --confirmo-read-only. Este comando só LÊ, mas exige a confirmação explícita antes de abrir qualquer ligação.");
  if (!SLUG_TENANT.test(tenant)) throw new Error("--tenant inválido: use o slug do control plane (minúsculas, dígitos e hífens).");
  if (!outDir || outDir.includes("\0")) throw new Error("--out-dir inválido.");
  if (!Number.isInteger(top) || top < 1 || top > 1000) throw new Error("--top tem de ser um inteiro entre 1 e 1000.");
  return { tenant, outDir, top };
}

/**
 * O diretório de saída TEM de existir, ser um diretório e ser gravável. Nunca é criado (evita escrever em caminhos
 * arbitrários por engano): se faltar, o operador monta-o (`-v <pasta-no-host>:/relatorios`).
 */
export function verificarDiretorioSaida(outDir: string): string {
  const dir = path.resolve(outDir);
  if (!existsSync(dir)) throw new Error(`O diretório de relatórios ${dir} não existe. Monte-o no contentor (-v <pasta-no-host>:${dir}) — o comando não cria diretórios.`);
  if (!statSync(dir).isDirectory()) throw new Error(`${dir} não é um diretório.`);
  try {
    accessSync(dir, fsConstants.W_OK);
  } catch {
    throw new Error(`O diretório ${dir} não é gravável por este utilizador.`);
  }
  return dir;
}

export function nomeBaseRelatorio(tenant: string, agora = new Date()): string {
  const ts = agora.toISOString().replace(/\.\d+Z$/, "Z").replace(/[-:]/g, "");
  return `auditoria-fabricantes-${tenant}-${ts}`;
}

/** Escreve `.md` e `.json` APENAS dentro de `dir` (nome fixo derivado do slug validado; nunca sobrescreve: flag `wx`). */
export function escreverRelatorios(dir: string, tenant: string, md: string, json: string, agora = new Date()): { md: string; json: string } {
  const base = nomeBaseRelatorio(tenant, agora);
  const alvo = (ext: string) => {
    const p = path.resolve(dir, `${base}.${ext}`);
    if (path.dirname(p) !== path.resolve(dir)) throw new Error("Recusado: o ficheiro de relatório ficaria fora do diretório de saída.");
    return p;
  };
  const f = { md: alvo("md"), json: alvo("json") };
  writeFileSync(f.md, md, { encoding: "utf8", flag: "wx", mode: 0o600 });
  writeFileSync(f.json, json, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return f;
}

export type LigacaoTenant = { url: string; baseLabel: string; segredos: string[] };

/**
 * Resolve a ligação ao tenant pelo MESMO mecanismo do tenancy, só em leitura: control plane (read-only, SELECT) →
 * `buildTenantConnectionString` (decifra a password com TENANT_ENCRYPTION_SECRET; respeita TENANT_DB_SSLMODE).
 * Devolve também os valores a mascarar em qualquer saída.
 */
export async function resolverLigacaoTenant(slug: string, env: Record<string, string | undefined> = process.env): Promise<LigacaoTenant> {
  const controlUrl = env.CONTROL_DATABASE_URL;
  const chave = env.TENANT_ENCRYPTION_SECRET;
  if (!controlUrl) throw new Error("CONTROL_DATABASE_URL em falta no ambiente (este comando corre no contentor `migrate`).");
  if (!chave) throw new Error("TENANT_ENCRYPTION_SECRET em falta no ambiente (este comando corre no contentor `migrate`).");
  const segredos: string[] = [controlUrl, chave];
  const control = new Client({ connectionString: controlUrl, options: OPCOES_SESSAO_READ_ONLY });
  try {
    await control.connect();
    await control.query("BEGIN TRANSACTION READ ONLY");
    const ro = await control.query("SHOW transaction_read_only");
    if (ro.rows[0]?.transaction_read_only !== "on") throw new Error("A sessão do control plane não ficou em modo só-leitura — abortado antes de qualquer consulta.");
    const r = await control.query(
      `SELECT id, slug, nome, estado::text AS estado, "dbHost", "dbPort", "dbName", "dbUser", "dbPassEncrypted" FROM "Tenant" WHERE slug = $1`,
      [slug],
    );
    const todos = r.rows.length === 0 ? (await control.query(`SELECT slug FROM "Tenant" ORDER BY slug`)).rows.map((x) => String(x.slug)) : [];
    await control.query("ROLLBACK");
    const t = r.rows[0];
    if (!t) throw new Error(`O tenant «${slug}» não existe no control plane. Tenants registados: ${todos.join(", ") || "(nenhum)"}.`);
    segredos.push(String(t.dbPassEncrypted), `${t.dbHost}:${t.dbPort}`, String(t.dbHost), String(t.dbUser));
    try {
      segredos.push(decryptTenantSecret(String(t.dbPassEncrypted)));
    } catch {
      throw new Error("Não foi possível decifrar a password do tenant (TENANT_ENCRYPTION_SECRET errada?).");
    }
    if (t.estado !== "ACTIVE") throw new Error(`O tenant «${slug}» está ${t.estado}; a auditoria só corre sobre tenants ACTIVE.`);
    const url = buildTenantConnectionString(t as unknown as TenantRecord);
    segredos.push(url);
    return { url, baseLabel: `tenant ${slug} · base ${t.dbName}`, segredos };
  } catch (e) {
    await control.query("ROLLBACK").catch(() => undefined);
    throw new Error(mascararSegredos(e instanceof Error ? e.message : String(e), ...segredos));
  } finally {
    await control.end().catch(() => undefined);
  }
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

const AMOSTRA_MAX = 500;

export async function executarAuditoria(url: string, topN = 15, baseLabel = "(tenant)", tenant = "garantia", segredos: readonly string[] = []): Promise<RelatorioAuditoria> {
  const opcoesLigacao = OPCOES_SESSAO_READ_ONLY;
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
    const manuaisRaw = await q(`
      SELECT pgl."grupoLaboratorialId" AS g, p.cnp, p.designacao, pgl.origem, f."nomeNormalizado" AS fnome, gf.id IS NOT NULL AS membro
        FROM "ProdutoGrupoLaboratorial" pgl
        JOIN "Produto" p ON p.id = pgl."produtoId"
        LEFT JOIN "Fabricante" f ON f.id = p."fabricanteId"
        LEFT JOIN "GrupoLaboratorialFabricante" gf ON gf."fabricanteId" = p."fabricanteId" AND gf."grupoLaboratorialId" = pgl."grupoLaboratorialId"
       WHERE pgl.origem = 'MANUAL' OR pgl."validadoManualmente"
       ORDER BY pgl."grupoLaboratorialId", p.cnp`);
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
    const regrasPorGrupo = new Map<string, RegraCnpAuditada[]>();
    for (const r of regras) {
      const lista = regrasPorGrupo.get(s(r.g)) ?? [];
      lista.push({
        cnp: n(r.cnp),
        estado: s(r.estado),
        validadoManualmente: !!r.val,
        produtoExiste: r.pid != null,
        fabricante: r.fnome == null ? null : s(r.fnome),
        fabricanteEMembro: r.fg != null && s(r.fg) === s(r.g),
        grupoAtualDoProduto: r.atual == null ? null : (nomeGrupo.get(s(r.atual)) ?? s(r.atual)),
        origemAtual: r.origem == null ? null : s(r.origem),
      });
      regrasPorGrupo.set(s(r.g), lista);
    }
    const manuaisPorGrupo = new Map<string, GrupoAuditado["produtosManuais"]>();
    for (const r of manuaisRaw) {
      const lista = manuaisPorGrupo.get(s(r.g)) ?? [];
      lista.push({ cnp: n(r.cnp), designacao: s(r.designacao), fabricante: r.fnome == null ? null : s(r.fnome), origem: s(r.origem), fabricanteEMembro: !!r.membro });
      manuaisPorGrupo.set(s(r.g), lista);
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
          regrasCnp: regrasPorGrupo.get(id) ?? [],
          produtosManuais: manuaisPorGrupo.get(id) ?? [],
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
      base: baseLabel,
      tenant,
      opcoesAntesLista: [...fabPorId.values()].filter((f) => f.estado === "ATIVO" && f.produtos > 0).map((f) => ({ id: f.id, nome: f.nome, produtos: f.produtos })),
      opcoesDepoisLista: agrupadas.map((i) => ({ tipo: i.opcao.tipo, id: i.opcao.id, nome: i.opcao.tipo === "grupo" ? i.opcao.nome : i.opcao.nomeNormalizado, produtos: i.opcao.produtos, variantes: i.variantes.length })),
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
    throw new Error(mascararSegredos(e instanceof Error ? e.message : String(e), url, ...segredos));
  } finally {
    await cliente.end().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
  }
}

// ─── Saída ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const LIMITE_MD = 25;

export function renderizarMarkdown(r: RelatorioAuditoria, topN = 15): string {
  const L: string[] = [];
  const nOrigem = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join(", ") || "—";
  const cortar = <T>(lista: readonly T[], limite = LIMITE_MD) => ({ vistos: lista.slice(0, limite), resto: Math.max(0, lista.length - limite) });
  L.push("# Auditoria de fabricantes e grupos (Garantia) — só leitura", "");
  L.push(`${r.base} · gerado em ${r.geradoEm}`, "");
  L.push("## Resumo", "");
  L.push(`- Fabricantes ATIVOS: ${r.fabricantesAtivos}`);
  L.push(`- Opções ANTES (fabricantes ativos com produtos, uma por fabricante): ${r.fabricantesApresentadosAntes}`);
  L.push(`- Opções DEPOIS (grupos + fabricantes sem prova): ${r.opcoesDepois}`);
  L.push(`- Grupos ATIVOS: ${r.gruposAtivos}; com mais de 10 variantes: ${r.gruposComMaisDeDezVariantes}`);
  L.push(`- Produtos incluídos num grupo cujo fabricante NÃO é membro: ${r.resumoForaDoGrupo.incluidosPorRegra} por regra/manual/alias (base aprovada) e ${r.resumoForaDoGrupo.obsoletosSemBase} obsoletos sem base atual (FABRICANTE_INEQUIVOCO — a reconciliação diária corrige)`);
  L.push(`- Produtos de fabricantes membros que NÃO estão no grupo do fabricante (sem linha ou noutro grupo): ${r.resumoForaDoGrupo.deMembroNoutroGrupoOuSemLinha}`);
  L.push(`- Ambiguidades e sobreposições: ${r.ambiguidades.length}; fabricantes semelhantes separados (candidatos para revisão humana): ${r.candidatosParaRevisao.length}`, "");
  L.push(`## Top ${topN} grupos por variantes`, "", "| Grupo | Variantes | Produtos |", "|---|---:|---:|");
  for (const g of r.gruposComMaisVariantes) L.push(`| ${g.grupo} | ${g.variantes} | ${g.produtos} |`);
  L.push("", "## Casos com mais de dez nomes", "");
  if (r.casosMaisDeDezNomes.length === 0) L.push("Nenhum grupo tem mais de 10 variantes.");
  for (const c of r.casosMaisDeDezNomes) {
    L.push(`- **${c.grupo}**: ${c.variantes} variantes (${c.nomes} nomes com aliases) — ${c.todasAgrupadas ? "TODAS agrupadas no filtro" : `NÃO agrupadas: ${c.variantesEmFalta.join("; ")}`}; produtos dos membros ${c.produtosDosMembros}, no grupo ${c.produtosDosMembrosNoGrupo}`);
  }

  L.push("", "## Opções ANTES — uma por fabricante apresentado nos filtros", "", `${r.opcoesAntesLista.length} opções.`, "");
  for (const o of r.opcoesAntesLista) L.push(`- ${o.nome} (${o.produtos} produtos) · id ${o.id}`);
  L.push("", "## Opções DEPOIS — o que o filtro agrupado mostra", "", `${r.opcoesDepoisLista.length} opções.`, "");
  for (const o of r.opcoesDepoisLista) L.push(o.tipo === "grupo" ? `- GRUPO ${o.nome} — ${o.variantes} variantes · ${o.produtos} produtos · id ${o.id}` : `- ${o.nome} (${o.produtos} produtos) · id ${o.id}`);

  L.push("", "## Grupos", "");
  for (const g of r.grupos) {
    L.push(`### ${g.nome}`, "", `- Nome canónico: ${g.nome} · id ${g.id}`, `- Aliases do grupo: ${g.aliases.join("; ") || "—"}`);
    L.push(`- Produtos abrangidos (distintos): ${g.produtosAbrangidos} (${nOrigem(g.produtosPorOrigem)})`);
    L.push(`- Variantes / fabricantes membros (${g.membros.length}):`);
    for (const m of g.membros) L.push(`  - ${m.nome} · id ${m.id} · ${m.tipoAssociacao}${m.validadoManualmente ? " · RELAÇÃO MANUAL (validado manualmente)" : ""} · ${m.produtos} produtos${m.aliases.length ? ` · aliases: ${m.aliases.join("; ")}` : ""}`);
    const manuais = g.membros.filter((m) => m.validadoManualmente);
    L.push(`- Relações manuais fabricante→grupo: ${manuais.length ? manuais.map((m) => m.nome).join("; ") : "nenhuma"}`);
    const regrasMd = cortar(g.regrasCnp);
    L.push(`- Regras CNP (${g.regrasCnp.length}):${g.regrasCnp.length === 0 ? " nenhuma" : ""}`);
    for (const x of regrasMd.vistos) L.push(`  - CNP ${x.cnp} · ${x.estado}${x.validadoManualmente ? " · validada manualmente" : ""} · ${x.produtoExiste ? `fabricante ${x.fabricante ?? "—"}${x.fabricanteEMembro ? " (membro)" : " (NÃO membro)"} · produto agora em ${x.grupoAtualDoProduto ?? "nenhum grupo"}${x.origemAtual ? ` (${x.origemAtual})` : ""}` : "SEM produto com este CNP"}`);
    if (regrasMd.resto) L.push(`  - … mais ${regrasMd.resto} (ver o JSON)`);
    const manMd = cortar(g.produtosManuais);
    L.push(`- Produtos colocados manualmente (${g.produtosManuais.length}):${g.produtosManuais.length === 0 ? " nenhum" : ""}`);
    for (const x of manMd.vistos) L.push(`  - CNP ${x.cnp} ${x.designacao} · fabricante ${x.fabricante ?? "—"}${x.fabricanteEMembro ? " (membro)" : " (NÃO membro)"} · ${x.origem}`);
    if (manMd.resto) L.push(`  - … mais ${manMd.resto} (ver o JSON)`);
    L.push(`- Incluídos cujo fabricante NÃO é membro: ${g.produtosForaDoGrupo.total} (${nOrigem(g.produtosForaDoGrupo.porOrigem)})`);
    for (const p of g.produtosForaDoGrupo.amostra.slice(0, LIMITE_MD)) L.push(`  - CNP ${p.cnp} ${p.designacao} · fabricante ${p.fabricante ?? "—"} · ${p.origem}${p.validadoManualmente ? " (validado)" : ""} · ${p.motivo}${p.fabricanteMembroDeOutroGrupo ? ` · fabricante é membro de ${p.fabricanteMembroDeOutroGrupo}` : ""}`);
    if (g.produtosForaDoGrupo.total > LIMITE_MD) L.push(`  - … mais ${g.produtosForaDoGrupo.total - LIMITE_MD} (ver o JSON)`);
    if (g.produtosDeMembrosForaDoGrupo.total > 0) {
      L.push(`- Produtos de membros que NÃO estão neste grupo: ${g.produtosDeMembrosForaDoGrupo.total}`);
      for (const p of g.produtosDeMembrosForaDoGrupo.amostra.slice(0, LIMITE_MD)) L.push(`  - CNP ${p.cnp} ${p.designacao} · ${p.fabricante} · agora em ${p.grupoAtual ?? "nenhum grupo"}${p.origemAtual ? ` (${p.origemAtual})` : ""}`);
      if (g.produtosDeMembrosForaDoGrupo.total > LIMITE_MD) L.push(`  - … mais ${g.produtosDeMembrosForaDoGrupo.total - LIMITE_MD} (ver o JSON)`);
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

/** Resumo curto para a consola: números e caminhos — nunca credenciais, hosts nem listas de dados. */
export function resumoConsola(r: RelatorioAuditoria, ficheiros: { md: string; json: string }): string {
  return [
    `Auditoria de fabricantes (só leitura) — ${r.base}`,
    `  fabricantes ativos: ${r.fabricantesAtivos} · opções antes: ${r.fabricantesApresentadosAntes} · opções depois: ${r.opcoesDepois}`,
    `  grupos ativos: ${r.gruposAtivos} · com mais de 10 variantes: ${r.gruposComMaisDeDezVariantes}`,
    `  ambiguidades: ${r.ambiguidades.length} · candidatos a revisão humana: ${r.candidatosParaRevisao.length}`,
    `  relatório: ${ficheiros.md}`,
    `  dados:     ${ficheiros.json}`,
  ].join("\n");
}

async function main() {
  let segredos: string[] = [];
  try {
    const args = lerArgumentos(process.argv.slice(2));
    // Falha cedo, antes de abrir qualquer ligação, se não houver onde gravar o relatório.
    const dir = verificarDiretorioSaida(args.outDir);
    const lig = await resolverLigacaoTenant(args.tenant);
    segredos = lig.segredos;
    const rel = await executarAuditoria(lig.url, args.top, lig.baseLabel, args.tenant, lig.segredos);
    const md = renderizarMarkdown(rel, args.top);
    const ficheiros = escreverRelatorios(dir, args.tenant, md, JSON.stringify(rel, null, 2));
    console.log(resumoConsola(rel, ficheiros));
  } catch (e) {
    console.error(mascararSegredos(e instanceof Error ? e.message : String(e), ...segredos));
    process.exit(1);
  }
}

if (require.main === module) {
  void main();
}
