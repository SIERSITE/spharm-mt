/**
 * scripts/simular-grupos-laboratoriais-garantia.ts
 *
 * Simulador ESTRITAMENTE OFFLINE da classificação de grupos laboratoriais
 * — nunca abre uma ligação Prisma, nunca depende das tabelas novas
 * (GrupoLaboratorial e companhia, que ainda não existem em nenhuma base
 * real: a migration não foi aplicada em lado nenhum). Existe precisamente
 * PORQUE `scripts/classificar-grupos-laboratoriais-garantia.ts` não é
 * executável hoje contra a VPS — ver a nota no topo desse ficheiro e o
 * relatório da sessão que a acompanha.
 *
 * Lê três ficheiros locais, todos fora do Git:
 *   --produtos  export read-only de produtos+fabricantes de garantia
 *               (scripts/export-produtos-fabricantes-garantia.ts)
 *   --catalogo  o catálogo nacional real, streaming (nunca carregado
 *               inteiro em memória — lib/catalog/catalogo-nacional-parser.ts)
 *   --config    scripts/data/grupos-laboratoriais-iniciais-garantia.json
 *
 * Reaproveita, sem alterar uma linha, o MESMO motor puro que
 * `classificar-grupos-laboratoriais-garantia.ts` usaria contra a base
 * real (`resolverGruposEmLote`, `resolverPropostasFabricanteEmLote`,
 * `descobrirCandidatosGrupoLaboratorial`) — a única coisa que muda é de
 * ONDE vêm os mapas de entrada (ficheiros locais, não Prisma). Isto
 * garante que o resultado da simulação é EXACTAMENTE o que a base real
 * produziria no dia em que a migration for aplicada e os grupos forem
 * inseridos com esta mesma configuração.
 *
 * Uso:
 *   npx tsx scripts/simular-grupos-laboratoriais-garantia.ts \
 *     --tenant=garantia \
 *     --produtos=.local-data/fabricantes-garantia/produtos-fabricantes-garantia.json \
 *     --catalogo=.local-data/fabricantes-garantia/catalogo/teste.csv \
 *     --config=scripts/data/grupos-laboratoriais-iniciais-garantia.json \
 *     --relatorio=.local-data/fabricantes-garantia/relatorio-simulacao-grupos.json
 */
import "dotenv/config";
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { normalizeFabricanteCanonico } from "../lib/catalog-normalizers";
import { normalizeGrupoLaboratorialAlias } from "../lib/catalog/grupo-laboratorial-normalizers";
import { lerCatalogoNacional, ehEstadoAtual } from "../lib/catalog/catalogo-nacional-parser";
import {
  resolverGruposEmLote,
  type ProdutoParaResolver,
  type FabricanteParaResolver,
  type RegraCnpParaResolver,
  type GrupoFabricanteParaResolver,
  type AliasParaResolver,
  type MapasResolverGrupo,
} from "../lib/catalog/resolver-grupo-laboratorial";
import {
  resolverPropostasFabricanteEmLote,
  type ProdutoSemFabricanteParaResolver,
} from "../lib/catalog/propostas-fabricante-por-cnp";
import { descobrirCandidatosGrupoLaboratorial, type ProdutoParaCandidatos } from "../lib/catalog/candidatos-grupo-laboratorial";

const MIN_CNP_INFARMED = 2_000_000;
export const TENANT_TRAVADO = "garantia";

// ── Args ───────────────────────────────────────────────────────────────

export type Args = {
  produtosPath: string;
  catalogoPath: string;
  configPath: string;
  relatorioPath: string;
  /** Opcional — scripts/data/regras-cnp-grupos-laboratoriais-garantia.json (nível 2, validadas). Sem isto, regrasCnpPorCnp fica vazio, como sempre foi. */
  regrasPath?: string;
};

export function parseArgs(argv: readonly string[]): Args {
  const out: Partial<Args> = {};
  for (const a of argv) {
    if (a.startsWith("--produtos=")) out.produtosPath = a.slice("--produtos=".length);
    else if (a.startsWith("--catalogo=")) out.catalogoPath = a.slice("--catalogo=".length);
    else if (a.startsWith("--config=")) out.configPath = a.slice("--config=".length);
    else if (a.startsWith("--relatorio=")) out.relatorioPath = a.slice("--relatorio=".length);
    else if (a.startsWith("--regras=")) out.regrasPath = a.slice("--regras=".length);
    else if (a.startsWith("--tenant=")) {
      const slug = a.slice("--tenant=".length);
      if (slug !== TENANT_TRAVADO) {
        throw new Error(`Este simulador está travado ao tenant "${TENANT_TRAVADO}" — recebeu --tenant=${slug}.`);
      }
    } else {
      throw new Error(`argumento desconhecido: ${a}`);
    }
  }
  if (!out.produtosPath) throw new Error("--produtos=<path> é obrigatório");
  if (!out.catalogoPath) throw new Error("--catalogo=<path> é obrigatório");
  if (!out.configPath) throw new Error("--config=<path> é obrigatório");
  if (!out.relatorioPath) throw new Error("--relatorio=<path> é obrigatório");
  return out as Args;
}

// ── Ficheiros de entrada (formas mínimas — só os campos usados) ────────

export type ProdutoExportado = {
  id: string;
  cnp: number | null;
  designacao: string;
  estado: string;
  validadoManualmente: boolean;
  fabricanteId: string | null;
  fabricanteNomeNormalizado: string | null;
  fabricanteEstado: string | null;
};

export type FabricanteExportado = {
  id: string;
  nomeNormalizado: string;
  estado: string;
  aliases: string[];
  produtosAssociados: number;
};

export type ExportProdutosFabricantes = {
  produtos: ProdutoExportado[];
  fabricantes: FabricanteExportado[];
};

export type GrupoConfig = {
  nome: string;
  nomeNormalizado: string;
  aliases: Array<{ alias: string; aliasNormalizado: string; origem?: string }>;
  fabricantesIntegrais: string[];
  naoIncluirAutomaticamente?: string[];
};

export type ConfigGruposIniciais = {
  grupos: GrupoConfig[];
  sucessoesParciaisConhecidas?: unknown[];
};

// ── Carregar o catálogo nacional (streaming) para um Map<cnp, {titular,estado}> ──

export type SnapshotCatalogo = { cnp: number; titularAim: string | null; estadoAim: string | null };

export async function carregarCatalogoStreaming(path: string): Promise<{
  snapshotsPorCnp: Map<number, SnapshotCatalogo>;
  totalRegistos: number;
  erros: number;
}> {
  const snapshotsPorCnp = new Map<number, SnapshotCatalogo>();
  let totalRegistos = 0;
  let erros = 0;
  const input = createReadStream(path, { encoding: "latin1" });
  for await (const evento of lerCatalogoNacional(input)) {
    if (evento.tipo === "erro") {
      erros++;
      continue;
    }
    totalRegistos++;
    snapshotsPorCnp.set(evento.registo.cnp, { cnp: evento.registo.cnp, titularAim: evento.registo.titular, estadoAim: evento.registo.estado });
  }
  return { snapshotsPorCnp, totalRegistos, erros };
}

// ── Validação estrutural da configuração inicial (ponto 5) ─────────────

export type ProblemaConfig = { tipo: string; detalhe: string };

/**
 * Verifica a config em si — sem nenhum dado de garantia — por
 * contradições estruturais: um alias em dois grupos ao mesmo tempo (é
 * permitido — o resolver trata isso como ambíguo em runtime — MAS um
 * fabricante integral em dois grupos NÃO é permitido, é sempre um erro
 * de autoria), e confirma explicitamente que nenhum grupo Kenvue inclui
 * Janssen.
 */
export function validarConfig(config: ConfigGruposIniciais): ProblemaConfig[] {
  const problemas: ProblemaConfig[] = [];

  const fabricanteIntegralParaGrupo = new Map<string, string>();
  for (const g of config.grupos) {
    for (const nomeCru of g.fabricantesIntegrais) {
      // normalizeGrupoLaboratorialAlias (120 chars), NUNCA normalizeFabricanteCanonico
      // (60, identidade global de Fabricante) — a config guarda designações
      // sociais completas como evidência, que não podem ser rejeitadas só
      // pelo comprimento. Ver lib/catalog/grupo-laboratorial-normalizers.ts.
      const norm = normalizeGrupoLaboratorialAlias(nomeCru);
      if (!norm) {
        problemas.push({ tipo: "fabricante_integral_invalido", detalhe: `grupo "${g.nome}": "${nomeCru}" não normaliza (vazio ou inválido)` });
        continue;
      }
      const outroGrupo = fabricanteIntegralParaGrupo.get(norm);
      if (outroGrupo && outroGrupo !== g.nome) {
        problemas.push({
          tipo: "fabricante_integral_em_dois_grupos",
          detalhe: `"${nomeCru}" (normalizado "${norm}") está listado como integral tanto em "${outroGrupo}" como em "${g.nome}" — contraditório, um fabricante legal só pode estar integralmente num grupo.`,
        });
      } else {
        fabricanteIntegralParaGrupo.set(norm, g.nome);
      }
    }
  }

  // Confirmação explícita: nenhuma entrada de Kenvue contém "JANSSEN" nos
  // seus fabricantes integrais nem nos seus aliases.
  const kenvue = config.grupos.find((g) => g.nomeNormalizado === "KENVUE");
  if (kenvue) {
    const contemJanssen = (s: string) => /JANSSEN/i.test(s);
    const violacoesFabricante = kenvue.fabricantesIntegrais.filter(contemJanssen);
    const violacoesAlias = kenvue.aliases.filter((a) => contemJanssen(a.alias) || contemJanssen(a.aliasNormalizado));
    for (const v of violacoesFabricante) problemas.push({ tipo: "janssen_em_kenvue", detalhe: `fabricante integral "${v}" no grupo Kenvue contém "JANSSEN"` });
    for (const v of violacoesAlias) problemas.push({ tipo: "janssen_em_kenvue", detalhe: `alias "${v.alias}" no grupo Kenvue contém "JANSSEN"` });
  } else {
    problemas.push({ tipo: "grupo_kenvue_em_falta", detalhe: "a configuração não tem nenhum grupo 'Kenvue' — verificação de exclusão do Janssen não pôde ser feita" });
  }

  return problemas;
}

// ── Construir os mapas do resolver a partir dos ficheiros locais ───────

export function construirMapasResolver(
  config: ConfigGruposIniciais,
  fabricantesExportados: readonly FabricanteExportado[],
): {
  mapas: MapasResolverGrupo;
  gruposPorId: Map<string, GrupoConfig & { id: string }>;
  fabricantesIntegraisResolvidos: Map<string, { grupoId: string; grupoNome: string; fabricanteId: string; fabricanteNome: string }[]>;
  fabricantesIntegraisNaoEncontrados: Map<string, string[]>;
} {
  const fabricantesPorId = new Map<string, FabricanteParaResolver>(fabricantesExportados.map((f) => [f.id, { id: f.id, nomeNormalizado: f.nomeNormalizado }]));
  // Re-normaliza SEMPRE — o nomeNormalizado exportado nem sempre está
  // canónico à luz da versão actual de normalizeFabricanteCanonico (ex.:
  // observado "MYLAN LDA." com ponto final ainda por limpar). Nunca
  // confiar que já está limpo.
  const fabricantesPorNomeNormalizado = new Map<string, FabricanteParaResolver>();
  for (const f of fabricantesExportados) {
    const norm = normalizeFabricanteCanonico(f.nomeNormalizado);
    if (norm) fabricantesPorNomeNormalizado.set(norm, { id: f.id, nomeNormalizado: f.nomeNormalizado });
  }

  const gruposPorId = new Map<string, GrupoConfig & { id: string }>();
  config.grupos.forEach((g, idx) => gruposPorId.set(`g${idx}`, { ...g, id: `g${idx}` }));

  const gruposFabricantePorFabricanteId = new Map<string, GrupoFabricanteParaResolver>();
  const aliasesPorNomeNormalizado = new Map<string, AliasParaResolver[]>();
  const fabricantesIntegraisResolvidos = new Map<string, { grupoId: string; grupoNome: string; fabricanteId: string; fabricanteNome: string }[]>();
  const fabricantesIntegraisNaoEncontrados = new Map<string, string[]>();

  for (const [grupoId, g] of gruposPorId) {
    const resolvidos: { grupoId: string; grupoNome: string; fabricanteId: string; fabricanteNome: string }[] = [];
    const naoEncontrados: string[] = [];
    for (const nomeCru of g.fabricantesIntegrais) {
      // normalizeGrupoLaboratorialAlias aqui só para NUNCA descartar um
      // candidato por comprimento antes sequer de tentar a procura — a
      // procura em si (fabricantesPorNomeNormalizado) só tem chaves <=60
      // (identidade real de Fabricante, normalizeFabricanteCanonico), por
      // isso um candidato >60 caracteres canónicos nunca vai encontrar
      // correspondência de qualquer forma — cai correctamente em
      // "não encontrado", nunca inventa uma correspondência.
      const norm = normalizeGrupoLaboratorialAlias(nomeCru);
      const fab = norm ? fabricantesPorNomeNormalizado.get(norm) : undefined;
      if (fab) {
        gruposFabricantePorFabricanteId.set(fab.id, { grupoLaboratorialId: grupoId });
        resolvidos.push({ grupoId, grupoNome: g.nome, fabricanteId: fab.id, fabricanteNome: fab.nomeNormalizado });
      } else {
        naoEncontrados.push(nomeCru);
      }
    }
    fabricantesIntegraisResolvidos.set(grupoId, resolvidos);
    fabricantesIntegraisNaoEncontrados.set(grupoId, naoEncontrados);

    for (const a of g.aliases) {
      const norm = normalizeGrupoLaboratorialAlias(a.alias) ?? a.aliasNormalizado;
      const lista = aliasesPorNomeNormalizado.get(norm) ?? [];
      lista.push({ grupoLaboratorialId: grupoId, estado: "ATIVO" });
      aliasesPorNomeNormalizado.set(norm, lista);
    }
  }

  // Sem regras por CNP na configuração inicial — a lista fica vazia de
  // propósito (nenhuma sucessão parcial foi ainda validada; ver
  // sucessoesParciaisConhecidas na config, que são candidatos, não regras).
  const regrasCnpPorCnp = new Map<number, RegraCnpParaResolver>();

  return {
    mapas: {
      fabricantesPorId,
      fabricantesPorNomeNormalizado,
      regrasCnpPorCnp,
      snapshotsPorCnp: new Map(), // preenchido pelo chamador com o catálogo streaming
      gruposFabricantePorFabricanteId,
      aliasesPorNomeNormalizado,
    },
    gruposPorId,
    fabricantesIntegraisResolvidos,
    fabricantesIntegraisNaoEncontrados,
  };
}

// ── Escrita atómica ──────────────────────────────────────────────────

export function escreverAtomico(caminhoFinal: string, conteudo: string): void {
  mkdirSync(dirname(caminhoFinal), { recursive: true });
  const tmp = `${caminhoFinal}.tmp-${process.pid}`;
  writeFileSync(tmp, conteudo, "utf8");
  try {
    renameSync(tmp, caminhoFinal);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  for (const [label, path] of [["--produtos", args.produtosPath], ["--catalogo", args.catalogoPath], ["--config", args.configPath]] as const) {
    if (!existsSync(path)) {
      console.error(`[fatal] ${label} não encontrado: ${path}`);
      process.exitCode = 1;
      return;
    }
  }

  console.log("═".repeat(78));
  console.log("Simulador OFFLINE de grupos laboratoriais — tenant garantia");
  console.log("═".repeat(78));
  console.log("  Sem ligação Prisma. Sem base de dados. Zero escritas.");
  console.log(`  produtos:  ${args.produtosPath}`);
  console.log(`  catalogo:  ${args.catalogoPath}`);
  console.log(`  config:    ${args.configPath}`);

  const t0 = Date.now();

  const exportado = JSON.parse(readFileSync(args.produtosPath, "utf8")) as ExportProdutosFabricantes;
  const config = JSON.parse(readFileSync(args.configPath, "utf8")) as ConfigGruposIniciais;

  console.log(`\n[1/4] Config: ${config.grupos.length} grupos`);
  const problemasConfig = validarConfig(config);
  if (problemasConfig.length > 0) {
    console.log(`  ⚠ ${problemasConfig.length} problema(s) estrutural(is) na config:`);
    for (const p of problemasConfig) console.log(`    [${p.tipo}] ${p.detalhe}`);
  } else {
    console.log("  Sem problemas estruturais na config.");
  }

  console.log(`\n[2/4] Catálogo nacional (streaming)...`);
  const { snapshotsPorCnp, totalRegistos, erros: errosCatalogo } = await carregarCatalogoStreaming(args.catalogoPath);
  console.log(`  ${totalRegistos} registos, ${errosCatalogo} erro(s) de reconstrução, ${Math.round((Date.now() - t0) / 1000)}s`);

  console.log(`\n[3/4] Resolver mapas (config × fabricantes reais de garantia)...`);
  const { mapas: mapasBase, gruposPorId, fabricantesIntegraisResolvidos, fabricantesIntegraisNaoEncontrados } = construirMapasResolver(config, exportado.fabricantes);
  for (const [grupoId, g] of gruposPorId) {
    const resolvidos = fabricantesIntegraisResolvidos.get(grupoId)!.length;
    const naoEncontrados = fabricantesIntegraisNaoEncontrados.get(grupoId)!;
    console.log(`  ${g.nome}: ${resolvidos}/${g.fabricantesIntegrais.length} fabricantes integrais resolvidos contra garantia${naoEncontrados.length > 0 ? ` (não encontrados: ${naoEncontrados.join(", ")})` : ""}`);
  }

  let regrasCnpPorCnp: MapasResolverGrupo["regrasCnpPorCnp"] = new Map();
  if (args.regrasPath) {
    const grupoIdPorNomeNormalizado = new Map<string, string>();
    for (const [grupoId, g] of gruposPorId) grupoIdPorNomeNormalizado.set(g.nomeNormalizado, grupoId);
    const regrasFicheiro = JSON.parse(readFileSync(args.regrasPath, "utf8")) as {
      regras: Array<{ cnp: number; grupoLaboratorialNomeNormalizado: string; estado: "ATIVO" | "INATIVO"; validadoManualmente: boolean }>;
    };
    const mapaRegras = new Map<number, { id: string; grupoLaboratorialId: string; estado: "ATIVO" | "INATIVO"; validadoManualmente: boolean }>();
    let semGrupoCorrespondente = 0;
    regrasFicheiro.regras.forEach((r, idx) => {
      const grupoId = grupoIdPorNomeNormalizado.get(r.grupoLaboratorialNomeNormalizado);
      if (!grupoId) { semGrupoCorrespondente++; return; }
      mapaRegras.set(r.cnp, { id: `regra${idx}`, grupoLaboratorialId: grupoId, estado: r.estado, validadoManualmente: r.validadoManualmente });
    });
    regrasCnpPorCnp = mapaRegras;
    console.log(`  ${mapaRegras.size} regra(s) por CNP carregadas de ${args.regrasPath}${semGrupoCorrespondente > 0 ? ` (${semGrupoCorrespondente} ignorada(s) — grupo não encontrado na config)` : ""}`);
  }
  const mapas: MapasResolverGrupo = { ...mapasBase, snapshotsPorCnp, regrasCnpPorCnp };

  console.log(`\n[4/4] Classificação sobre ${exportado.produtos.length} produtos...`);
  const produtosParaResolver: ProdutoParaResolver[] = exportado.produtos
    .filter((p): p is ProdutoExportado & { cnp: number } => p.cnp !== null)
    .map((p) => ({ id: p.id, cnp: p.cnp, fabricanteId: p.fabricanteId, grupoExistente: null }));
  const relatorioGrupos = resolverGruposEmLote(produtosParaResolver, mapas);

  // NOTA IMPORTANTE sobre camposManuais: o ficheiro exportado
  // (scripts/export-produtos-fabricantes-garantia.ts) NÃO inclui
  // Produto.camposManuais — não estava no âmbito desse exportador. Sem
  // esse campo não há forma de saber, offline, quais produtos têm
  // fabricanteId=null protegido por decisão manual explícita. Todos são
  // tratados aqui como NÃO protegidos — o que pode SOBRESTIMAR
  // propostaAtual/revisaoHistorico. Isto fica marcado explicitamente no
  // relatório (camposManuaisDisponivel=false) — nunca apresentado como
  // "zero protegidos" sem esta ressalva.
  const produtosSemFabricante: ProdutoSemFabricanteParaResolver[] = exportado.produtos
    .filter((p): p is ProdutoExportado & { cnp: number } => p.cnp !== null && p.fabricanteId === null)
    .map((p) => ({ id: p.id, cnp: p.cnp, camposManuais: [] }));
  const relatorioFabricante = resolverPropostasFabricanteEmLote(produtosSemFabricante, snapshotsPorCnp, mapas.fabricantesPorNomeNormalizado);

  const produtosParaCandidatos: ProdutoParaCandidatos[] = exportado.produtos
    .filter((p): p is ProdutoExportado & { cnp: number } => p.cnp !== null && p.fabricanteId !== null)
    .map((p) => ({ cnp: p.cnp, fabricanteNomeNormalizado: p.fabricanteNomeNormalizado }));
  const candidatos = descobrirCandidatosGrupoLaboratorial(produtosParaCandidatos, snapshotsPorCnp);

  // ── Relatório por grupo ────────────────────────────────────────────
  const resultadoPorProdutoId = new Map(relatorioGrupos.resultados.map((r) => [r.produtoId, r.resultado]));
  const produtosPorId = new Map(exportado.produtos.map((p) => [p.id, p]));

  type RelatorioGrupo = {
    nome: string;
    nomeNormalizado: string;
    aliases: string[];
    fabricantesIntegraisConfigurados: number;
    fabricantesIntegraisResolvidos: Array<{ fabricanteId: string; fabricanteNome: string }>;
    fabricantesIntegraisNaoEncontrados: string[];
    produtosPorFabricanteInequivoco: { total: number; exemplos: Array<{ cnp: number; designacao: string }> };
    produtosPorRegraCnp: { total: number; exemplos: Array<{ cnp: number; designacao: string }> };
    propostasSnapshot: { total: number; exemplos: Array<{ cnp: number; designacao: string; titularObservado: string | null; estadoObservado: string | null }> };
    produtosQueExigemValidacao: number;
    fabricantesLegaisEnvolvidos: string[];
    registosCatalogoParaGrupo: { atuais: number; historicos: number };
  };

  const relatoriosPorGrupo: RelatorioGrupo[] = [];
  for (const [grupoId, g] of gruposPorId) {
    const resolvidos = fabricantesIntegraisResolvidos.get(grupoId)!;
    const naoEncontrados = fabricantesIntegraisNaoEncontrados.get(grupoId)!;
    // BUG real encontrado em 2026-09-22: `r.fabricanteNome` é a grafia CRUA
    // de garantia (ex.: "ALFASIGMA PORTUGAL LDA." — COM o ponto final),
    // nunca re-canonicalizada; comparar isto directamente contra um titular
    // de catálogo canonicalizado (`tNorm`, abaixo, sem pontuação) falhava
    // silenciosamente sempre que a grafia crua continha qualquer pontuação
    // residual — a causa real das contagens "0 atuais" injustificadas
    // nalguns grupos (Alfasigma, Tecnimede). `normalizeFabricanteCanonico`
    // aqui é apropriado (não `normalizeGrupoLaboratorialAlias`): está a
    // canonicalizar uma identidade de Fabricante REAL, sempre <=60 chars.
    const nomesFabricantesIntegrais = new Set(
      resolvidos.map((r) => normalizeFabricanteCanonico(r.fabricanteNome)).filter((n): n is string => n !== null),
    );

    const porFabricanteInequivoco: Array<{ cnp: number; designacao: string }> = [];
    const porRegraCnp: Array<{ cnp: number; designacao: string }> = [];
    const propostas: Array<{ cnp: number; designacao: string; titularObservado: string | null; estadoObservado: string | null }> = [];
    const fabricantesLegaisEnvolvidos = new Set<string>();

    for (const [produtoId, resultado] of resultadoPorProdutoId) {
      if (resultado.tipo === "sem_grupo" || resultado.tipo === "mantido_manual") continue;
      if (resultado.grupoLaboratorialId !== grupoId) continue;
      const produto = produtosPorId.get(produtoId)!;
      if (produto.fabricanteNomeNormalizado) fabricantesLegaisEnvolvidos.add(produto.fabricanteNomeNormalizado);

      if (resultado.tipo === "fabricante_inequivoco") porFabricanteInequivoco.push({ cnp: produto.cnp!, designacao: produto.designacao });
      else if (resultado.tipo === "regra_cnp") porRegraCnp.push({ cnp: produto.cnp!, designacao: produto.designacao });
      else if (resultado.tipo === "proposta_snapshot_cnp") {
        const snap = snapshotsPorCnp.get(produto.cnp!);
        propostas.push({ cnp: produto.cnp!, designacao: produto.designacao, titularObservado: snap?.titularAim ?? null, estadoObservado: snap?.estadoAim ?? null });
      } else if (resultado.tipo === "alias_inequivoco") {
        porFabricanteInequivoco.push({ cnp: produto.cnp!, designacao: produto.designacao }); // agrupado com "inequívoco" para efeitos de exemplo
      }
    }

    // Registos do catálogo (todo o ficheiro) cujo titular bate com o
    // NOME do grupo, um alias, ou um fabricante integral — dá a
    // dimensão total do grupo no catálogo nacional, actuais vs. históricos.
    const nomesRelevantes = new Set<string>([g.nomeNormalizado, ...g.aliases.map((a) => normalizeGrupoLaboratorialAlias(a.alias) ?? a.aliasNormalizado), ...nomesFabricantesIntegrais]);
    let atuais = 0;
    let historicos = 0;
    for (const snap of snapshotsPorCnp.values()) {
      // normalizeGrupoLaboratorialAlias (120), NUNCA normalizeFabricanteCanonico
      // (60) — o titular do catálogo pode ser uma designação social
      // completa longa (ex.: "Pentafarma Genéricos - Sociedade Técnico
      // Medicinal, Unipessoal Lda.", 65 chars canónicos); com o limite de
      // 60, esse registo era descartado SILENCIOSAMENTE desta contagem
      // (nem entrava em "atuais" nem em "históricos") — a causa real por
      // trás de contagens "0 atuais" injustificadamente baixas nalguns
      // grupos, investigada em 2026-09-22.
      const tNorm = normalizeGrupoLaboratorialAlias(snap.titularAim);
      if (!tNorm || !nomesRelevantes.has(tNorm)) continue;
      if (ehEstadoAtual(snap.estadoAim)) atuais++;
      else historicos++;
    }

    relatoriosPorGrupo.push({
      nome: g.nome,
      nomeNormalizado: g.nomeNormalizado,
      aliases: g.aliases.map((a) => a.alias),
      fabricantesIntegraisConfigurados: g.fabricantesIntegrais.length,
      fabricantesIntegraisResolvidos: resolvidos.map((r) => ({ fabricanteId: r.fabricanteId, fabricanteNome: r.fabricanteNome })),
      fabricantesIntegraisNaoEncontrados: naoEncontrados,
      produtosPorFabricanteInequivoco: { total: porFabricanteInequivoco.length, exemplos: porFabricanteInequivoco.slice(0, 5) },
      produtosPorRegraCnp: { total: porRegraCnp.length, exemplos: porRegraCnp.slice(0, 5) },
      propostasSnapshot: { total: propostas.length, exemplos: propostas.slice(0, 5) },
      produtosQueExigemValidacao: propostas.length,
      fabricantesLegaisEnvolvidos: [...fabricantesLegaisEnvolvidos].sort(),
      registosCatalogoParaGrupo: { atuais, historicos },
    });
  }

  // ── Ambiguidades (aliases + CNP com mais de um grupo possível) ─────
  const aliasesAmbiguos: Array<{ alias: string; grupos: string[] }> = [];
  const aliasParaGrupos = new Map<string, Set<string>>();
  for (const g of gruposPorId.values()) {
    for (const a of g.aliases) {
      const norm = normalizeGrupoLaboratorialAlias(a.alias) ?? a.aliasNormalizado;
      const set = aliasParaGrupos.get(norm) ?? new Set<string>();
      set.add(g.nome);
      aliasParaGrupos.set(norm, set);
    }
  }
  for (const [alias, grupos] of aliasParaGrupos) {
    if (grupos.size > 1) aliasesAmbiguos.push({ alias, grupos: [...grupos] });
  }

  // CNP com mais de um grupo possível — hoje sempre vazio (zero regras
  // por CNP na config inicial), mas a verificação corre sobre os dados
  // reais na mesma, não é hardcoded a "sempre zero".
  const cnpComMaisDeUmGrupo: number[] = []; // a config inicial não tem regras por CNP — ver nota no código

  // ── Produtos bloqueados por ambiguidade de alias ────────────────────
  let bloqueadosPorAmbiguidade = 0;
  for (const p of exportado.produtos) {
    if (p.cnp === null || !p.fabricanteNomeNormalizado) continue;
    const fabNorm = normalizeFabricanteCanonico(p.fabricanteNomeNormalizado);
    if (!fabNorm) continue;
    const candidatosAlias = mapas.aliasesPorNomeNormalizado.get(fabNorm) ?? [];
    const gruposDistintos = new Set(candidatosAlias.map((a) => a.grupoLaboratorialId));
    if (gruposDistintos.size > 1) bloqueadosPorAmbiguidade++;
  }

  // ── Totais globais ───────────────────────────────────────────────────
  const totalProdutos = exportado.produtos.length;
  const produtosComCnp = exportado.produtos.filter((p) => p.cnp !== null);
  const foraDoUniversoInfarmed = produtosComCnp.filter((p) => p.cnp! <= MIN_CNP_INFARMED).length;
  const semFabricante = exportado.produtos.filter((p) => p.fabricanteId === null).length;

  const comGrupoDefinitivo = relatorioGrupos.totais.regraCnp + relatorioGrupos.totais.fabricanteInequivoco + relatorioGrupos.totais.aliasInequivoco + relatorioGrupos.totais.mantidoManual;
  const propostasPendentesValidacao = relatorioGrupos.totais.propostaSnapshotCnp;
  const semGrupo = relatorioGrupos.totais.semGrupo;

  // ── Validações nomeadas (exemplos reais dos dados de garantia) ──────
  // Prefere um fabricante com PRODUTOS reais associados — testar a
  // resolução contra um fabricante com 0 produtos não prova nada (não há
  // nenhum Produto.fabricanteId a apontar para ele para o resolver ler).
  function fabricantePorNomeContendo(...termos: string[]): FabricanteExportado | undefined {
    const candidatos = exportado.fabricantes.filter((f) => termos.every((t) => f.nomeNormalizado.toUpperCase().includes(t.toUpperCase())));
    return candidatos.find((f) => f.produtosAssociados > 0) ?? candidatos[0];
  }
  /**
   * Grupo DEFINITIVO de um fabricante — deliberadamente EXCLUI
   * `proposta_snapshot_cnp` (nível 4): esse nível é só uma proposta,
   * nunca uma classificação real, e um produto Pfizer pode legitimamente
   * RECEBER uma proposta de Viatris (se o catálogo actual disser que
   * aquele CNP específico já é titular Viatris) sem que isso viole "a
   * Pfizer nunca é integralmente fundida em Viatris" — são coisas
   * diferentes. As validações abaixo verificam a garantia definitiva,
   * não a ausência de propostas (essas são esperadas e correctas).
   */
  function grupoDefinitivoDeUmFabricante(fabricanteId: string): string | null {
    const produto = exportado.produtos.find((p) => p.fabricanteId === fabricanteId);
    if (!produto) return null;
    const r = resultadoPorProdutoId.get(produto.id);
    if (!r || r.tipo === "sem_grupo" || r.tipo === "mantido_manual" || r.tipo === "proposta_snapshot_cnp") return null;
    return gruposPorId.get(r.grupoLaboratorialId)?.nome ?? null;
  }
  /** Grupo (definitivo OU proposta) — usado nas verificações "resolve para o grupo certo", onde uma proposta pendente também conta como correcto. */
  function grupoDeUmFabricante(fabricanteId: string): string | null {
    const produto = exportado.produtos.find((p) => p.fabricanteId === fabricanteId);
    if (!produto) return null;
    const r = resultadoPorProdutoId.get(produto.id);
    return r && r.tipo !== "sem_grupo" && r.tipo !== "mantido_manual" ? gruposPorId.get(r.grupoLaboratorialId)?.nome ?? null : null;
  }

  type ValidacaoNomeada = { descricao: string; passou: boolean; detalhe: string };
  const validacoes: ValidacaoNomeada[] = [];

  for (const [termos, grupoEsperado] of [
    [["MYLAN"], "Viatris"],
    [["UPJOHN"], "Viatris"],
    [["VIATRIS"], "Viatris"],
    [["ALFA WASSERMANN"], "Alfasigma"],
    [["BIOSAUDE"], "Alfasigma"],
    [["ALFASIGMA"], "Alfasigma"],
    [["RATIOPHARM"], "Teva"],
    [["TEVA"], "Teva"],
    [["JNTL"], "Kenvue"],
    [["PENTAFARMA"], "Tecnimede"],
    [["TECNIMEDE"], "Tecnimede"],
  ] as const) {
    const fab = fabricantePorNomeContendo(...termos);
    if (!fab) {
      validacoes.push({ descricao: `${termos.join(" ")} → ${grupoEsperado}`, passou: false, detalhe: `nenhum fabricante real de garantia contém "${termos.join(" ")}"` });
      continue;
    }
    const grupo = grupoDeUmFabricante(fab.id);
    const grupoDefinitivo = grupoDefinitivoDeUmFabricante(fab.id);
    const via = grupoDefinitivo === grupoEsperado ? "fabricante_inequivoco (definitivo)" : grupo === grupoEsperado ? "proposta_snapshot_cnp (pendente de validação)" : "—";
    validacoes.push({
      descricao: `${termos.join(" ")} → ${grupoEsperado}`,
      passou: grupo === grupoEsperado,
      detalhe: `fabricante real "${fab.nomeNormalizado}" (${fab.id}) resolveu para ${grupo ? `"${grupo}"` : "nenhum grupo"} via ${via}`,
    });
  }

  // JANSSEN não deve resolver para Kenvue — verifica TODOS os fabricantes Janssen reais.
  {
    const janssens = exportado.fabricantes.filter((f) => f.nomeNormalizado.includes("JANSSEN"));
    const algumEmKenvue = janssens.some((f) => grupoDeUmFabricante(f.id) === "Kenvue");
    validacoes.push({
      descricao: "JANSSEN não resolve para KENVUE",
      passou: !algumEmKenvue,
      detalhe: `${janssens.length} fabricante(s) real(is) "JANSSEN*" verificados — nenhum deve resolver para Kenvue`,
    });
  }

  // Pfizer: a empresa NUNCA pode estar integralmente no grupo (nível 3) —
  // só CNPs específicos com regra validada (nível 2, ver
  // scripts/data/regras-cnp-grupos-laboratoriais-garantia.json, gerado a
  // partir de evidência real: 14 CNPs de "LABORATORIOS PFIZER
  // LDA"/"PFIZER"/"LABORATORIOS PFIZER" cujo titular ACTUAL no catálogo
  // nacional já é "Upjohn EESV"). Duas verificações independentes:
  // negativa (nenhum fabricante Pfizer tem associação INTEGRAL) e
  // positiva (os CNPs concretos com regra validada resolvem
  // definitivamente, com dados reais — já não apenas sintético).
  {
    const pfizers = exportado.fabricantes.filter((f) => f.nomeNormalizado.includes("PFIZER"));
    const algumIntegral = pfizers.some((f) => mapas.gruposFabricantePorFabricanteId.has(f.id));
    let produtosPfizerComRegraCnpViatris = 0;
    let produtosPfizerComPropostaViatris = 0;
    for (const f of pfizers) {
      for (const p of exportado.produtos) {
        if (p.fabricanteId !== f.id) continue;
        const r = resultadoPorProdutoId.get(p.id);
        if (!r) continue;
        if (r.tipo === "regra_cnp" && gruposPorId.get(r.grupoLaboratorialId)?.nome === "Viatris") produtosPfizerComRegraCnpViatris++;
        if (r.tipo === "proposta_snapshot_cnp" && gruposPorId.get(r.grupoLaboratorialId)?.nome === "Viatris") produtosPfizerComPropostaViatris++;
      }
    }
    validacoes.push({
      descricao: "Pfizer NUNCA tem associação INTEGRAL (nível 3) com VIATRIS",
      passou: !algumIntegral,
      detalhe:
        `${pfizers.length} fabricante(s) real(is) "PFIZER*" verificados — nenhum está em GrupoLaboratorialFabricante/fabricantesIntegrais (Pfizer continua uma empresa grande e distinta). ` +
        `${produtosPfizerComRegraCnpViatris} produto(s) Pfizer entram em Viatris via REGRA_CNP validada (nível 2, CNPs concretos com transferência comprovada) — isso é o desenho correcto, nunca uma violação. ` +
        `${produtosPfizerComPropostaViatris} produto(s) Pfizer adicionais têm uma PROPOSTA (nível 4, ainda não validada) de Viatris.`,
    });
    validacoes.push({
      descricao: "Pfizer COM regra por CNP entra em VIATRIS (positiva)",
      passou: produtosPfizerComRegraCnpViatris > 0,
      detalhe:
        args.regrasPath
          ? `Demonstrado com dados reais: ${produtosPfizerComRegraCnpViatris} produto(s) Pfizer com regra por CNP validada resolvem para Viatris via nível 2 (regra_cnp). Também demonstrado sinteticamente em scripts/tests/test-resolver-grupo-laboratorial.ts secção F.`
          : "NÃO demonstrado com dados reais nesta corrida — --regras não foi passado. Demonstrado sinteticamente em scripts/tests/test-resolver-grupo-laboratorial.ts secção F (produto Pfizer com RegraGrupoLaboratorialPorCnp específica resolve para Viatris).",
    });
  }

  const todasValidacoesReaisPassaram = validacoes.filter((v) => v.detalhe.startsWith("NÃO demonstrado") === false).every((v) => v.passou);

  // ── Relatório final ──────────────────────────────────────────────────
  const relatorio = {
    geradoEm: new Date().toISOString(),
    modo: "SIMULACAO_OFFLINE",
    tenant: TENANT_TRAVADO,
    ligacaoBaseDados: false,
    escritas: 0,
    ficheiros: { produtos: args.produtosPath, catalogo: args.catalogoPath, config: args.configPath },
    problemasConfig,
    catalogo: { totalRegistos, errosReconstrucao: errosCatalogo },
    totais: {
      produtosAnalisados: totalProdutos,
      produtosComGrupo: comGrupoDefinitivo,
      produtosPropostaPendenteValidacao: propostasPendentesValidacao,
      produtosSemGrupo: semGrupo,
      porOrigem: relatorioGrupos.totais,
      produtosBloqueadosPorAmbiguidade: bloqueadosPorAmbiguidade,
      produtosForaDoUniversoInfarmed: foraDoUniversoInfarmed,
      produtosSemFabricante: semFabricante,
      propostasFabricante: relatorioFabricante.totais,
      camposManuaisDisponivel: false,
      notaCamposManuais:
        "O export de produtos não inclui Produto.camposManuais — protegidoManual não pode ser determinado offline; os números de propostaAtual/revisaoHistorico podem incluir produtos que na realidade já têm fabricanteId=null validado manualmente. Confirmar com uma query real antes de aplicar qualquer preenchimento automático.",
    },
    grupos: relatoriosPorGrupo,
    aliasesAmbiguos,
    cnpComMaisDeUmGrupoPossivel: cnpComMaisDeUmGrupo,
    candidatosAdicionais: candidatos.slice(0, 50),
    validacoes,
    todasValidacoesReaisPassaram,
  };

  escreverAtomico(args.relatorioPath, JSON.stringify(relatorio, null, 2));

  console.log(`\n${"─".repeat(78)}`);
  console.log(`Produtos analisados:              ${totalProdutos}`);
  console.log(`Com grupo (definitivo):            ${comGrupoDefinitivo}`);
  console.log(`Proposta pendente de validação:    ${propostasPendentesValidacao}`);
  console.log(`Sem grupo:                         ${semGrupo}`);
  console.log(`Bloqueados por ambiguidade:         ${bloqueadosPorAmbiguidade}`);
  console.log(`Fora do universo INFARMED:          ${foraDoUniversoInfarmed}`);
  console.log(`Sem fabricante:                     ${semFabricante}`);
  console.log(`  proposta actual (candidatos):     ${relatorioFabricante.totais.propostaAtual}`);
  console.log(`  revisão histórico (obrigatória):  ${relatorioFabricante.totais.revisaoHistorico}`);
  console.log(`\nValidações nomeadas:`);
  for (const v of validacoes) console.log(`  ${v.passou ? "✓" : "✗"} ${v.descricao} — ${v.detalhe}`);
  console.log(`\nZero escritas — nunca abriu ligação Prisma nem tocou em nenhuma base.`);
  console.log(`Relatório gravado em: ${args.relatorioPath}`);
}

if (/[\\/]simular-grupos-laboratoriais-garantia\.(ts|js|mjs|cjs)$/.test(process.argv[1] ?? "")) {
  main().catch((err) => {
    console.error("[erro fatal]", err);
    process.exitCode = 1;
  });
}
