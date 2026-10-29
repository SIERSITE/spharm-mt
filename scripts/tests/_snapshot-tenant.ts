/**
 * scripts/tests/_snapshot-tenant.ts
 *
 * Fotografia CANÓNICA (JSON com chaves ordenadas) do comportamento da aplicação para UM tenant simulado, sobre uma
 * base PostgreSQL descartável semeada de forma determinística (dados 100% sintéticos, ids fixos). Corre em QUALQUER
 * árvore do repositório (a árvore actual ou o worktree do SHA base) — o código sob teste é carregado de `--root`, por
 * caminho absoluto, e tudo o que for novo na entrega (que não existe no base) é registado como `{ __ausente: true }`
 * em vez de rebentar. Assim a MESMA fotografia pode ser comparada entre a base a69cbc5 e a entrega.
 *
 *   --root <dir>     árvore a fotografar (omissão: cwd; correr com cwd = a árvore, para o tsconfig/`@/` certos)
 *   --tenant <slug>  slug simulado no cabeçalho `x-tenant-slug` ("__nenhum__" = sem tenant)
 *   --db <url>       base descartável (recusa hosts não locais)
 *   --out <ficheiro> onde gravar o JSON
 *   --seed           só semeia a base (determinístico) e termina
 *
 * Simulado: apenas `next/headers` (cabeçalho do tenant + cookie de sessão), `next/cache`, `next/navigation` e
 * `@/lib/prisma` (aponta para a base descartável) e `@/lib/tenant-context` (só `resolveCurrentTenantSlug`, que lê o
 * cabeçalho; as constantes e gates re-exportados são os reais da árvore). `getSession`, `resolveCurrentTenantSlug`, `can`, as server actions,
 * `getReportingFilterOptions`, `loadCatalogo*` e a decisão de ingestão são os REAIS da árvore.
 */
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
import Module from "node:module";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

function arg(nome: string): string | undefined {
  const i = process.argv.indexOf(`--${nome}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const ROOT = path.resolve(arg("root") ?? process.cwd());
const TENANT_ARG = arg("tenant") ?? "silveira";
const DB_URL = arg("db") ?? "";
const OUT = arg("out");
const SO_SEMEAR = process.argv.includes("--seed");

if (!DB_URL) { console.error("--db obrigatório"); process.exit(2); }
{
  const h = new URL(DB_URL).hostname;
  if (h !== "localhost" && h !== "127.0.0.1") { console.error(`RECUSADO: ${h} não é uma base local descartável.`); process.exit(2); }
}

// ─── Simulação mínima do pedido Next.js ─────────────────────────────────────────────────────────────────────────────
const estado: { tenant: string | null; token: string | null; prisma: any } = { tenant: null, token: null, prisma: null };
const M = Module as unknown as { _resolveFilename: (r: string, ...a: unknown[]) => string; _load: (r: string, ...a: unknown[]) => unknown };
const resolverOriginal = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "server-only" ? __filename : resolverOriginal.call(this, request, ...rest);
};
const loadOriginal = M._load;
const Stub = () => null;
M._load = function (request: string, ...rest: unknown[]) {
  if (request === "next/cache") return { revalidatePath: () => undefined, revalidateTag: () => undefined, unstable_cache: (fn: unknown) => fn };
  if (request === "next/headers") {
    return {
      headers: async () => ({ get: (k: string) => (k.toLowerCase() === "x-tenant-slug" ? estado.tenant : null) }),
      cookies: async () => ({ get: (n: string) => (n === "session" && estado.token ? { value: estado.token } : undefined) }),
    };
  }
  if (request === "next/navigation") {
    return {
      notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
      redirect: (u: string) => { throw new Error(`NEXT_REDIRECT:${u}`); },
    };
  }
  if (request === "@/lib/tenant-context") {
    // `resolveCurrentTenantSlug` real só lê o cabeçalho `x-tenant-slug` via `await import("next/headers")` (não
    // interceptável fora de um pedido): réplica fiel; as constantes/gates são os REAIS da árvore (re-exportados).
    return { ...require(path.join(ROOT, "lib/tenant-constants.ts")), resolveCurrentTenantSlug: async () => estado.tenant };
  }
  if (request === "@/lib/prisma") return { getPrisma: async () => estado.prisma };
  if (request === "@/components/layout/app-shell") return { AppShell: Stub };
  if (request === "@/components/catalogo/manutencao-massa-client") return { ManutencaoMassaClient: Stub };
  return loadOriginal.call(this, request, ...rest);
};

const rootRequire = createRequire(path.join(ROOT, "package.json"));
const imp = (rel: string): any => require(path.join(ROOT, rel));
const tentar = (rel: string): any => (fs.existsSync(path.join(ROOT, rel)) ? imp(rel) : null);

// ─── Serialização canónica ──────────────────────────────────────────────────────────────────────────────────────────
function canon(v: any): any {
  if (v === undefined) return "__undefined__";
  if (v === null) return null;
  if (typeof v === "bigint") return `${v}n`;
  if (typeof v === "function") return "__function__";
  if (v instanceof Date) return "__date__";
  if (typeof v !== "object") return v;
  if (typeof (v as any).toNumber === "function" && typeof (v as any).toFixed === "function") return String(v); // Decimal
  if (Array.isArray(v)) return v.map(canon);
  const o: Record<string, any> = {};
  // Propriedade `undefined` == ausente (é o que o JSON/React/Next fazem): não conta como diferença.
  for (const k of Object.keys(v).sort()) if (v[k] !== undefined) o[k] = canon(v[k]);
  return o;
}
async function seccao(fn: () => Promise<any> | any): Promise<any> {
  try { return canon(await fn()); } catch (e) { return { __erro: String((e as Error).message ?? e).split("\n")[0].slice(0, 200) }; }
}
const AUSENTE = { __ausente: true };

// ─── Semente determinística ─────────────────────────────────────────────────────────────────────────────────────────
async function semear(prisma: any) {
  const farm1 = await prisma.farmacia.create({ data: { id: "farm-1", nome: "Farmacia A" } });
  await prisma.farmacia.create({ data: { id: "farm-2", nome: "Farmacia B" } });
  await prisma.utilizador.create({ data: { id: "u-admin", email: "admin@snapshot.local", nome: "Admin", perfil: "ADMINISTRADOR" } });
  await prisma.fornecedor.create({ data: { id: "forn-1", nomeNormalizado: "DISTRIBUIDOR UM", nome: "Distribuidor Um" } });
  await prisma.fornecedor.create({ data: { id: "forn-2", nomeNormalizado: "DISTRIBUIDOR DOIS", nome: "Distribuidor Dois" } });

  const fab = async (id: string, nome: string) => prisma.fabricante.create({ data: { id, nomeNormalizado: nome, estado: "ATIVO" } });
  await fab("fab-v1", "VIATRIS ALFA");
  await fab("fab-v2", "VIATRIS BETA");
  await fab("fab-v3", "VIATRIS GAMA");
  await fab("fab-pfizer", "PFIZER LABORATORIOS");
  await fab("fab-parecido", "VIATRIS PHARMA LDA"); // nome parecido SEM prova de grupo
  await fab("fab-solo", "SOLO LAB");
  await fab("fab-sem-produtos", "SEM PRODUTOS LDA");
  await prisma.fabricanteAlias.create({ data: { id: "alias-v1", fabricanteId: "fab-v1", aliasNome: "MYLAN IRELAND" } });

  await prisma.grupoLaboratorial.create({ data: { id: "g-viatris", nome: "Viatris", nomeNormalizado: "VIATRIS" } });
  await prisma.grupoLaboratorialAlias.create({ data: { id: "ga-1", grupoLaboratorialId: "g-viatris", alias: "Upjohn", aliasNormalizado: "UPJOHN" } });
  for (const [i, f] of ["fab-v1", "fab-v2", "fab-v3"].entries()) {
    await prisma.grupoLaboratorialFabricante.create({ data: { id: `gf-${i + 1}`, grupoLaboratorialId: "g-viatris", fabricanteId: f } });
  }

  let n = 0;
  const prod = async (fabricanteId: string | null, forma: string | null, grupo: boolean) => {
    n++;
    const id = `prod-${String(n).padStart(2, "0")}`;
    await prisma.produto.create({
      data: { id, cnp: 8_400_000 + n, designacao: `Produto sintetico ${n}`, estado: "VALIDADO", fabricanteId, formaFarmaceutica: forma },
    });
    await prisma.produtoFarmacia.create({
      data: { id: `pf-${n}`, produtoId: id, farmaciaId: farm1.id, stockAtual: n, stockMinimo: 0, stockMaximo: 10, fornecedorOrigem: n % 2 ? "DIST ORIGEM X" : "DIST ORIGEM Y", fornecedorHabitualId: n % 3 ? "forn-1" : "forn-2" },
    });
    await prisma.vendaMensal.create({
      data: { id: `vm-${n}`, farmaciaId: farm1.id, produtoId: id, ano: new Date().getUTCFullYear(), mes: 1, quantidade: 10 + n, valorTotal: 100 + n, naturezaVenda: "NORMAL" },
    });
    if (grupo) await prisma.produtoGrupoLaboratorial.create({ data: { id: `pgl-${n}`, produtoId: id, grupoLaboratorialId: "g-viatris", origem: "FABRICANTE_INEQUIVOCO" } });
    return id;
  };
  await prod("fab-v1", "Comprimido", true);
  await prod("fab-v1", "Comprimido revestido", true);
  await prod("fab-v2", "Cápsula", true);
  await prod("fab-v3", "Comprimido", true);
  await prod("fab-pfizer", "Comprimido ", false);
  await prod("fab-pfizer", "Solução injetável", false);
  await prod("fab-parecido", "Cápsula", false);
  await prod("fab-solo", null, false);
  await prod("fab-solo", "Xarope", false);
  await prod(null, "Comprimido", false);
}

// ─── Fotografia ─────────────────────────────────────────────────────────────────────────────────────────────────────
function hashesDe(dirs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const visitar = (rel: string) => {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) visitar(r);
      else out[r] = crypto.createHash("sha1").update(fs.readFileSync(path.join(ROOT, r), "utf8").replace(/\r\n/g, "\n")).digest("hex");
    }
  };
  for (const d of dirs) visitar(d);
  return out;
}

const PERFIS = ["ADMINISTRADOR", "GESTOR_GRUPO", "GESTOR_FARMACIA", "OPERADOR"] as const;

async function fotografar(prisma: any) {
  const slug: string | null = TENANT_ARG === "__nenhum__" ? null : TENANT_ARG;
  estado.tenant = slug;
  estado.prisma = prisma;
  estado.token = null;

  const TC = imp("lib/tenant-constants.ts");
  const out: Record<string, any> = { tenant: slug, constantes: {}, gates: {}, permissoes: {}, menu: {}, pagina: {}, acoes: {}, acoesLaboratorio: {}, filtros: {}, catalogo: {}, margens: {}, resolucao: {}, ingestao: {}, sql: {} };

  // Constantes e gates ─ descobre o gate certo em cada árvore.
  out.constantes = canon({
    TENANT_SYNC_BLOQUEADO: TC.TENANT_SYNC_BLOQUEADO,
    TENANT_GRUPOS_LABORATORIAIS: TC.TENANT_GRUPOS_LABORATORIAIS,
    TENANT_CATALOGO_MASSA: TC.TENANT_CATALOGO_MASSA,
    TENANT_DESIGNACAO_AUTORITATIVA: TC.TENANT_DESIGNACAO_AUTORITATIVA,
    TENANTS_CATALOGO_MANUTENCAO: TC.TENANTS_CATALOGO_MANUTENCAO ?? "__ausente__",
  });
  const gateManutencao = (s: string | null | undefined): { fn: string; ativo: boolean } =>
    typeof TC.catalogoManutencaoAtiva === "function"
      ? { fn: "catalogoManutencaoAtiva", ativo: TC.catalogoManutencaoAtiva(s) }
      : { fn: "slug === TENANT_CATALOGO_MASSA", ativo: s === TC.TENANT_CATALOGO_MASSA };
  const gateGrupos = (s: string | null | undefined): { fn: string; ativo: boolean } =>
    typeof TC.gruposLaboratoriaisAtivos === "function"
      ? { fn: "gruposLaboratoriaisAtivos", ativo: TC.gruposLaboratoriaisAtivos(s) }
      : { fn: "slug === TENANT_GRUPOS_LABORATORIAIS", ativo: s === TC.TENANT_GRUPOS_LABORATORIAIS };
  out.gates = canon({
    manutencaoCatalogo: gateManutencao(slug),
    gruposLaboratoriais: gateGrupos(slug),
    syncBloqueado: slug === TC.TENANT_SYNC_BLOQUEADO,
    ingestaoFabricanteNuncaReescrever: slug === TC.TENANT_CATALOGO_MASSA,
    designacaoAutoritativa: slug === TC.TENANT_DESIGNACAO_AUTORITATIVA,
  });

  // Permissões (matriz perfil → permissão) — nomes extraídos do tipo `Permission` do próprio ficheiro.
  out.permissoes = await seccao(() => {
    const P = imp("lib/permissions-core.ts");
    const fonte = fs.readFileSync(path.join(ROOT, "lib/permissions-core.ts"), "utf8");
    const bloco = fonte.slice(fonte.indexOf("export type Permission"), fonte.indexOf("const PERMISSIONS"));
    const nomes = Array.from(bloco.matchAll(/\|\s*"([a-z.]+)"/g)).map((m) => m[1]).sort();
    const matriz: Record<string, Record<string, boolean>> = {};
    for (const perfil of PERFIS) {
      matriz[perfil] = {};
      for (const nome of nomes) matriz[perfil][nome] = P.can({ perfil, sub: "x", email: "x", nome: "x", farmaciaId: null, tenant: slug ?? "" }, nome);
    }
    const acessoFarmacia: Record<string, boolean> = {};
    for (const perfil of PERFIS) acessoFarmacia[perfil] = P.canAccessFarmaciaSync({ perfil, farmaciaId: "farm-1" }, "farm-2");
    return { nomes, matriz, semSessao: nomes.map((n: string) => P.can(null, n)), acessoFarmaciaAlheia: acessoFarmacia };
  });

  // Menu: item «Manutenção do catálogo» (lido do app-shell da própria árvore; é só apresentação).
  out.menu = await seccao(() => {
    const shell = fs.readFileSync(path.join(ROOT, "components/layout/app-shell.tsx"), "utf8");
    const linha = shell.split("\n").find((l) => l.includes('label: "Manutenção do catálogo"')) ?? "";
    const fn = /soTenantFn:\s*(\w+)/.exec(linha)?.[1];
    const c = /soTenant:\s*(\w+)/.exec(linha)?.[1];
    let visivel: boolean | null = null;
    if (fn) visivel = !!TC[fn](slug);
    else if (c) visivel = slug === TC[c];
    else visivel = true;
    return { mecanismo: fn ? `soTenantFn:${fn}` : c ? `soTenant:${c}` : "sem gate", visivel };
  });

  // Página /catalogo/manutencao (real, com AppShell/cliente substituídos por stubs).
  out.pagina = await seccao(async () => {
    const Pagina = imp("app/catalogo/manutencao/page.tsx").default;
    try { await Pagina(); return { resultado: "renderizada" }; } catch (e) {
      return { resultado: String((e as Error).message) === "NEXT_NOT_FOUND" ? "notFound" : `erro:${(e as Error).message}` };
    }
  });

  // Server actions reais × (perfil | sem sessão | sessão de outro tenant).
  out.acoes = await seccao(async () => {
    const Auth = imp("lib/auth.ts");
    const A = imp("app/catalogo/manutencao/actions.ts");
    const nomes = Object.keys(A).filter((k) => typeof A[k] === "function").sort();
    const sessaoDe = async (perfil: string, tenantSessao: string) =>
      Auth.createSessionToken({ sub: "u-admin", email: "admin@snapshot.local", nome: "Admin", perfil, farmaciaId: null, tenant: tenantSessao });
    const tenantDaSessao = slug ?? Auth.LEGACY_TENANT;
    const cenarios: Array<[string, string | null]> = [];
    for (const p of PERFIS) cenarios.push([p, await sessaoDe(p, tenantDaSessao)]);
    cenarios.push(["sem-sessao", null]);
    cenarios.push(["ADMINISTRADOR-de-outro-tenant", await sessaoDe("ADMINISTRADOR", "__outro_tenant__")]);

    const args: Record<string, any> = {
      listarProdutosManutencaoMassaAction: { tipo: "FABRICANTE", filtro: {} },
      previewManutencaoFabricanteAction: { filtro: { cnps: [8_400_001, 8_400_002] }, destino: { modo: "existente", id: "fab-pfizer" } },
      previewManutencaoFornecedorAction: { filtro: { farmaciaIds: ["farm-1"] }, destino: { modo: "existente", id: "forn-2" } },
      aplicarManutencaoFabricanteAction: { filtro: { cnps: [8_400_001] }, destino: { modo: "existente", id: "fab-pfizer" }, snapshotHash: "forjado" },
      aplicarManutencaoFornecedorAction: { filtro: { farmaciaIds: ["farm-1"] }, destino: { modo: "existente", id: "forn-2" }, snapshotHash: "forjado" },
      listarOperacoesRecentesAction: undefined,
      reverterOperacaoAction: { operacaoId: "inexistente" },
      pesquisarFabricantesAction: "VIATRIS",
      pesquisarFornecedoresAction: "DISTRIBUIDOR",
    };
    const antes = await contagens(prisma);
    const resultados: Record<string, any> = {};
    for (const [rotulo, token] of cenarios) {
      estado.token = token;
      resultados[rotulo] = {};
      for (const nome of nomes) {
        try { resultados[rotulo][nome] = canon(await A[nome](args[nome])); } catch (e) { resultados[rotulo][nome] = { __lancou: String((e as Error).message).slice(0, 160) }; }
      }
    }
    estado.token = null;
    const depois = await contagens(prisma);
    return { exportadas: nomes, resultados, baseInalterada: JSON.stringify(antes) === JSON.stringify(depois) };
  });

  // Server action de leitura do filtro agrupado (só existe na entrega): `resolverCnpsLaboratoriosAction` (reports.read).
  out.acoesLaboratorio = await seccao(async () => {
    const M2 = tentar("lib/reporting/laboratorio-actions.ts");
    if (!M2) return AUSENTE;
    const Auth = imp("lib/auth.ts");
    const tenantDaSessao = slug ?? Auth.LEGACY_TENANT;
    const cenarios: Array<[string, string | null]> = [];
    for (const p of PERFIS) cenarios.push([p, await Auth.createSessionToken({ sub: "u-admin", email: "admin@snapshot.local", nome: "Admin", perfil: p, farmaciaId: null, tenant: tenantDaSessao })]);
    cenarios.push(["sem-sessao", null]);
    cenarios.push(["ADMINISTRADOR-de-outro-tenant", await Auth.createSessionToken({ sub: "u-admin", email: "admin@snapshot.local", nome: "Admin", perfil: "ADMINISTRADOR", farmaciaId: null, tenant: "__outro_tenant__" })]);
    const res: Record<string, any> = {};
    for (const [rotulo, token] of cenarios) {
      estado.token = token;
      res[rotulo] = {
        grupo: await M2.resolverCnpsLaboratoriosAction(["grupo:g-viatris"]),
        fabricante: await M2.resolverCnpsLaboratoriosAction(["fabricante:fab-v1"]),
        nomeSoltoFabricante: await M2.resolverCnpsLaboratoriosAction(["SOLO LAB"]),
        nomeSoltoGrupo: await M2.resolverCnpsLaboratoriosAction(["Viatris"]),
      };
    }
    estado.token = null;
    return { exportadas: Object.keys(M2).sort(), resultados: res };
  });

  // Filtros de fabricante/laboratório dos relatórios.
  const opcoesRel = await seccao(async () => imp("lib/reporting-filter-options.ts").getReportingFilterOptions());
  out.filtros = { opcoesRelatorio: opcoesRel };

  // Catálogo: opções + where do filtro de laboratório (capturado no `produto.count`) + resultado.
  out.catalogo = await seccao(async () => {
    const C = imp("lib/catalogo-data.ts");
    const opcoes = await C.loadCatalogoFilterOptions();
    const capturas: any[] = [];
    const proxy = new Proxy(prisma, {
      get(alvo: any, prop: string) {
        if (prop === "produto") {
          return new Proxy(alvo.produto, {
            get(a: any, m: string) {
              if (m === "count") return (q: any) => { capturas.push(q?.where); return a.count(q); };
              const v = a[m];
              return typeof v === "function" ? v.bind(a) : v;
            },
          });
        }
        const v = alvo[prop];
        return typeof v === "function" ? v.bind(alvo) : v;
      },
    });
    const cenarios: Record<string, string | undefined> = {
      "sem-filtro": undefined,
      "fabricante:fab-v1": "fabricante:fab-v1",
      "fabricante:fab-pfizer": "fabricante:fab-pfizer",
      "grupo:g-viatris": "grupo:g-viatris",
      "id-nu-fab-solo": "fab-solo",
    };
    const lista: Record<string, any> = {};
    estado.prisma = proxy;
    for (const [k, v] of Object.entries(cenarios)) {
      capturas.length = 0;
      const r = await C.loadCatalogoListData({ page: 1, pageSize: 50, laboratorio: v });
      lista[k] = { where: capturas[0], total: r.total, cnps: (r.rows ?? r.items ?? []).map((x: any) => x.cnp).sort((a: number, b: number) => a - b) };
    }
    estado.prisma = prisma;
    return { opcoes, listagem: lista };
  });

  // Mapa de Margens (dados reais da base semeada): linhas e totais; as chaves de stock são novas (comparação por campo).
  out.margens = await seccao(async () => {
    const G = imp("lib/margens-data.ts");
    const todos = await G.getMargensData({}, {});
    const solo = await G.getMargensData({ fabricantes: ["SOLO LAB"] }, {});
    return { todos, solo };
  });

  // Resolvedores de laboratório seleccionado (para os relatórios) e utilitários puros do filtro.
  out.resolucao = await seccao(async () => {
    const R = imp("lib/reporting/resolver-laboratorio-selecionado.ts");
    const L = imp("lib/catalog/laboratorio-filtro.ts");
    const sels: Record<string, string[]> = {
      grupo: ["grupo:g-viatris"],
      "fabricante-v1": ["fabricante:fab-v1"],
      "nome-solto-fabricante": ["SOLO LAB"],
      "nome-solto-grupo": ["Viatris"],
      "grupo+pfizer": ["grupo:g-viatris", "fabricante:fab-pfizer"],
      vazio: [],
    };
    const ids: Record<string, any> = {};
    for (const [k, v] of Object.entries(sels)) ids[k] = (await R.resolverProdutoIdsPorLaboratoriosSelecionados(prisma, v, async () => slug)).sort();
    const cnps: Record<string, any> = {};
    const RC = tentar("lib/reporting/resolver-cnps-laboratorios.ts");
    for (const [k, v] of Object.entries(sels)) cnps[k] = RC ? await seccao(async () => (await RC.resolverCnpsPorLaboratoriosSelecionados(prisma, v, async () => slug)).sort?.() ?? null) : AUSENTE;
    const wheres: Record<string, any> = {};
    for (const v of ["grupo:g-viatris", "fabricante:fab-v1", "fab-solo", "", undefined]) wheres[String(v)] = L.resolverFiltroLaboratorioWhere(v);
    const opcoes = (await seccao(async () => imp("lib/reporting-filter-options.ts").getReportingFilterOptions())).laboratorios;
    const base = Array.isArray(opcoes) ? opcoes : [];
    const pesquisa: Record<string, any> = {};
    for (const q of ["viatris", "mylan", "upjohn", "pfizer", "solo", "xyz"]) pesquisa[q] = L.pesquisarLaboratorios(base, q).map((o: any) => L.valorDeLaboratorio(o));
    const agrupar = typeof L.agruparOpcoesLaboratorio === "function"
      ? L.agruparOpcoesLaboratorio(base).map((i: any) => ({ rotulo: i.rotulo, variantes: i.variantes.map((v: any) => v.nome) }))
      : AUSENTE;
    return { idsProdutoPorSelecao: ids, cnpsPorSelecao: cnps, whereLaboratorio: wheres, pesquisa, agrupadoNoCliente: agrupar };
  });

  // Ingestão: decisões puras com entradas fixas + modo de designação (real, sobre a base semeada) + hashes dos ficheiros.
  out.ingestao = await seccao(async () => {
    const E = imp("lib/ingest/catalog-from-erp.ts");
    const D = imp("lib/ingest/designacao-silveira.ts");
    const fabEntradas = [
      { fabricanteAtualNormalizado: null, validadoManualmente: false },
      { fabricanteAtualNormalizado: "VIATRIS ALFA", validadoManualmente: false },
      { fabricanteAtualNormalizado: null, validadoManualmente: true },
      { fabricanteAtualNormalizado: "PFIZER LABORATORIOS", validadoManualmente: true },
    ];
    const baselineEntradas = [
      { baseline: null, novoCanonico: "A", fabricanteAtualNormalizado: null, validadoManualmente: false },
      { baseline: null, novoCanonico: "A", fabricanteAtualNormalizado: "B", validadoManualmente: false },
      { baseline: "A", novoCanonico: "A", fabricanteAtualNormalizado: "B", validadoManualmente: false },
      { baseline: "A", novoCanonico: "C", fabricanteAtualNormalizado: "A", validadoManualmente: false },
      { baseline: "A", novoCanonico: "C", fabricanteAtualNormalizado: "A", validadoManualmente: true },
    ];
    const desig: Record<string, any> = {};
    for (const modo of ["LEGACY", "AUTORITATIVA", "SO_CRIACAO"]) {
      for (const [rotulo, existente] of [["sem-existente", null], ["igual", { designacao: "X", camposManuais: [] }], ["diferente", { designacao: "Y", camposManuais: [] }], ["manual", { designacao: "Y", camposManuais: ["designacao"] }]] as const) {
        for (const recebida of ["X", "  ", null]) desig[`${modo}|${rotulo}|${JSON.stringify(recebida)}`] = D.decidirDesignacao({ modo, existente, recebida });
      }
    }
    const env = { [D.ENV_FARMACIA_ID_DESIGNACAO]: "farm-1" };
    const modos: Record<string, any> = {};
    for (const t of [slug ?? "", "silveira", "garantia", "sier", "outro"]) {
      for (const f of ["farm-1", "farm-2"]) modos[`${t}|${f}`] = await D.resolverModoDesignacao(prisma, t, f, env);
    }
    return {
      decidirFabricanteSilveira: fabEntradas.map((e) => E.decidirFabricanteSilveira(e)),
      decidirFabricanteBaseline: baselineEntradas.map((e) => E.decidirFabricanteBaseline(e)),
      decidirDesignacao: desig,
      modoDesignacao: modos,
      normalizarDesignacao: ["  A  b ", "", null, 5].map((v) => D.normalizarDesignacao(v)),
      hashes: hashesDe(["app/api/ingest", "lib/ingest"]),
    };
  });

  // SQL gerado por funções puras (existem só na entrega: no base ficam ausentes).
  out.sql = await seccao(async () => {
    const S = tentar("lib/catalog/forma-farmaceutica-sql.ts");
    if (!S) return AUSENTE;
    const f = (x: any) => (x ? { sql: x.sql.replace(/\s+/g, " ").trim(), values: x.values } : null);
    return {
      condicaoForma: f(S.sqlCondicaoForma(["comprimido"])),
      filtroFormaVazio: f(S.sqlFiltroForma([])),
    };
  });

  return out;
}

async function contagens(prisma: any) {
  return {
    produtos: await prisma.produto.findMany({ select: { id: true, fabricanteId: true, designacao: true }, orderBy: { id: "asc" } }),
    operacoes: await prisma.catalogoManutencaoOperacao.count(),
    auditoria: await prisma.auditLog.count(),
    pf: await prisma.produtoFarmacia.findMany({ select: { id: true, fornecedorHabitualId: true }, orderBy: { id: "asc" } }),
  };
}

async function main() {
  const { PrismaClient } = imp("generated/prisma/client");
  const { PrismaPg } = rootRequire("@prisma/adapter-pg");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
  try {
    if (SO_SEMEAR) { await semear(prisma); console.log("semeado"); return; }
    const resultado = await fotografar(prisma);
    const texto = JSON.stringify(canon(resultado), null, 2);
    if (OUT) fs.writeFileSync(OUT, texto);
    else console.log(texto);
  } finally {
    await prisma.$disconnect();
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
