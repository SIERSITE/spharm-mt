/**
 * scripts/ensaio-volume-real-docker.ts
 *
 * Ensaio de VOLUME REAL (ponto 5) contra um PostgreSQL Docker local e
 * descartável — NUNCA uma base real, nunca a VPS. Orquestra, com o
 * código REAL (nunca reimplementado):
 *
 *   C. carrega fabricantes+produtos da exportação JSON da Garantia
 *      (só os campos necessários à simulação — nunca dados sensíveis
 *      fora do que já estava no export);
 *   D. importa os 294071 registos reais do CSV via
 *      `importarCatalogoNacional` (scripts/import-catalogo-nacional-completo.ts);
 *   E. cria os grupos e aliases configurados
 *      (scripts/data/grupos-laboratoriais-iniciais-garantia.json);
 *   F. cria as associações integrais (GrupoLaboratorialFabricante),
 *      resolvidas contra os Fabricante REAIS agora na base;
 *   G. cria as 342 regras validadas por CNP
 *      (scripts/data/regras-cnp-grupos-laboratoriais-garantia.json);
 *   H-K. corre `classificarGruposLaboratoriais` (scripts/classificar-
 *      grupos-laboratoriais-garantia.ts) em dry-run, depois valida
 *      totais, aplica de verdade (só nesta base descartável), e repete
 *      para provar idempotência (mesmo resultado, zero duplicados);
 *   L. corre consultas equivalentes aos filtros reais
 *      (`resolverProdutoIdsPorLaboratoriosSelecionados`).
 *
 * Mede e reporta: tempo de parsing do CSV, tempo de importação, tempo de
 * classificação, memória máxima aproximada (RSS), tamanho da base antes/
 * depois, nº de linhas por tabela, batches, resultado da 2ª execução,
 * conflitos, erros, produtos pendentes.
 *
 * Uso:
 *   DATABASE_URL=postgresql://test:test@localhost:55433/spharmmt_test \
 *     npx tsx scripts/ensaio-volume-real-docker.ts
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { importarCatalogoNacional } from "./import-catalogo-nacional-completo";
import { classificarGruposLaboratoriais } from "./classificar-grupos-laboratoriais-garantia";
import { normalizeFabricanteCanonico } from "../lib/catalog-normalizers";
import { resolverProdutoIdsPorLaboratoriosSelecionados } from "../lib/reporting/resolver-laboratorio-selecionado";

const PRODUTOS_PATH = "C:/projetos/spharm-mt/.local-data/fabricantes-garantia/produtos-fabricantes-garantia.json";
const CATALOGO_PATH = "C:/projetos/spharm-mt/.local-data/fabricantes-garantia/catalogo/teste.csv";
const CONFIG_PATH = "scripts/data/grupos-laboratoriais-iniciais-garantia.json";
const REGRAS_PATH = "scripts/data/regras-cnp-grupos-laboratoriais-garantia.json";
const SAIDA_PATH = "C:/projetos/spharm-mt/.local-data/fabricantes-garantia/ensaio-volume-real-docker.json";

type ExportProdutosFabricantes = {
  fabricantes: Array<{ id: string; nomeNormalizado: string; estado: string; produtosAssociados: number }>;
  produtos: Array<{ id: string; cnp: number | null; designacao: string; estado: string; fabricanteId: string | null }>;
};

type ConfigGrupo = {
  nome: string;
  nomeNormalizado: string;
  aliases: Array<{ alias: string; aliasNormalizado: string; origem?: string }>;
  fabricantesIntegrais: string[];
};

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function tamanhoBase(prisma: PrismaClient): Promise<string> {
  const r = await prisma.$queryRawUnsafe<Array<{ pg_size_pretty: string }>>(`SELECT pg_size_pretty(pg_database_size(current_database()))`);
  return r[0]!.pg_size_pretty;
}

async function contagemTabelas(prisma: PrismaClient): Promise<Record<string, number>> {
  const [produto, fabricante, importacao, registoImportado, regulatoryRecord, grupo, alias, grupoFabricante, regraCnp, produtoGrupo] = await Promise.all([
    prisma.produto.count(),
    prisma.fabricante.count(),
    prisma.catalogoNacionalImportacao.count(),
    prisma.catalogoNacionalRegistoImportado.count(),
    prisma.regulatoryRecord.count(),
    prisma.grupoLaboratorial.count(),
    prisma.grupoLaboratorialAlias.count(),
    prisma.grupoLaboratorialFabricante.count(),
    prisma.regraGrupoLaboratorialPorCnp.count(),
    prisma.produtoGrupoLaboratorial.count(),
  ]);
  return { Produto: produto, Fabricante: fabricante, CatalogoNacionalImportacao: importacao, CatalogoNacionalRegistoImportado: registoImportado, RegulatoryRecord: regulatoryRecord, GrupoLaboratorial: grupo, GrupoLaboratorialAlias: alias, GrupoLaboratorialFabricante: grupoFabricante, RegraGrupoLaboratorialPorCnp: regraCnp, ProdutoGrupoLaboratorial: produtoGrupo };
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL obrigatório (base descartável, nunca real)");
  if (/spharmmt_t_|prod|production/i.test(url)) throw new Error("[fatal] URL parece apontar para uma base real — recusado.");

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  const tempos: Record<string, number> = {};
  const memoriaMaxima = { rss: 0 };
  const registarMemoria = () => { const m = process.memoryUsage().rss; if (m > memoriaMaxima.rss) memoriaMaxima.rss = m; };
  const cronometro = setInterval(registarMemoria, 500);

  try {
    console.log("═".repeat(78));
    console.log("ENSAIO DE VOLUME REAL — PostgreSQL Docker descartável, local, NUNCA produção");
    console.log("═".repeat(78));
    console.log(`  DATABASE_URL: ${url.replace(/:[^:@]+@/, ":***@")}`);

    const tamanhoAntes = await tamanhoBase(prisma);
    console.log(`\n  Tamanho da base ANTES: ${tamanhoAntes}`);

    // ── C. Carregar fabricantes + produtos da exportação (campos mínimos) ──
    console.log("\n[C] Carregar fabricantes + produtos da exportação JSON...");
    let t0 = Date.now();
    const exportado = JSON.parse(readFileSync(PRODUTOS_PATH, "utf8")) as ExportProdutosFabricantes;

    const BATCH = 1000;
    for (let i = 0; i < exportado.fabricantes.length; i += BATCH) {
      const lote = exportado.fabricantes.slice(i, i + BATCH);
      await prisma.fabricante.createMany({
        data: lote.map((f) => ({ id: f.id, nomeNormalizado: f.nomeNormalizado, estado: f.estado as "ATIVO", dataAtualizacao: new Date() })),
        skipDuplicates: true,
      });
    }
    for (let i = 0; i < exportado.produtos.length; i += BATCH) {
      const lote = exportado.produtos.slice(i, i + BATCH);
      await prisma.produto.createMany({
        data: lote
          .filter((p) => p.cnp !== null)
          .map((p) => ({ id: p.id, cnp: p.cnp!, designacao: p.designacao, estado: p.estado as "PENDENTE", fabricanteId: p.fabricanteId, dataAtualizacao: new Date() })),
        skipDuplicates: true,
      });
    }
    tempos.carregarFabricantesProdutos = Date.now() - t0;
    console.log(`  ${exportado.fabricantes.length} fabricantes, ${exportado.produtos.length} produtos carregados em ${tempos.carregarFabricantesProdutos}ms (${BATCH} por batch)`);

    // ── D. Importar os 294071 registos reais do CSV ─────────────────────
    console.log("\n[D] Importar catálogo nacional completo (294071 registos reais)...");
    t0 = Date.now();
    let ultimoLog = Date.now();
    const statsImport = await importarCatalogoNacional(
      CATALOGO_PATH,
      { source: "ensaio_volume_real_docker", dryRun: false, force: false, batchSize: 500, limit: null },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
      (processados) => {
        if (Date.now() - ultimoLog > 5000) {
          console.log(`  … ${processados} registos processados (${Math.round((Date.now() - t0) / 1000)}s)`);
          ultimoLog = Date.now();
          registarMemoria();
        }
      },
    );
    tempos.importarCatalogo = Date.now() - t0;
    console.log(`  Importação concluída em ${tempos.importarCatalogo}ms (${(tempos.importarCatalogo / 1000).toFixed(1)}s)`);
    console.log(`  resultado=${statsImport.resultado} registosLidos=${statsImport.registosLidos} inseridos=${statsImport.totais.inserted} actualizados=${statsImport.totais.updatedSomeFields} inalterados=${statsImport.totais.unchanged} falhas=${statsImport.totais.failed}`);
    console.log(`  cnpDuplicadosNoFicheiro=${statsImport.cnpDuplicadosNoFicheiro} erros=${statsImport.erros.length}`);

    // ── E. Criar grupos e aliases ────────────────────────────────────────
    console.log("\n[E] Criar grupos e aliases configurados...");
    t0 = Date.now();
    const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as { grupos: ConfigGrupo[] };
    const grupoIdPorNomeNormalizado = new Map<string, string>();
    for (const g of config.grupos) {
      const grupo = await prisma.grupoLaboratorial.create({ data: { nome: g.nome, nomeNormalizado: g.nomeNormalizado, dataAtualizacao: new Date() } });
      grupoIdPorNomeNormalizado.set(g.nomeNormalizado, grupo.id);
      for (const a of g.aliases) {
        await prisma.grupoLaboratorialAlias.create({ data: { grupoLaboratorialId: grupo.id, alias: a.alias, aliasNormalizado: a.aliasNormalizado, origem: a.origem } });
      }
    }
    tempos.criarGruposEAliases = Date.now() - t0;
    console.log(`  ${config.grupos.length} grupos, ${config.grupos.reduce((s, g) => s + g.aliases.length, 0)} aliases criados em ${tempos.criarGruposEAliases}ms`);

    // ── F. Criar associações integrais ──────────────────────────────────
    console.log("\n[F] Criar associações integrais (GrupoLaboratorialFabricante)...");
    t0 = Date.now();
    const fabricantesPorNomeNorm = new Map<string, string>();
    for (const f of exportado.fabricantes) {
      const norm = normalizeFabricanteCanonico(f.nomeNormalizado);
      if (norm) fabricantesPorNomeNorm.set(norm, f.id);
    }
    let integraisCriadas = 0;
    let integraisNaoEncontradas = 0;
    for (const g of config.grupos) {
      const grupoId = grupoIdPorNomeNormalizado.get(g.nomeNormalizado)!;
      for (const nomeCru of g.fabricantesIntegrais) {
        const norm = normalizeFabricanteCanonico(nomeCru);
        const fabricanteId = norm ? fabricantesPorNomeNorm.get(norm) : undefined;
        if (!fabricanteId) { integraisNaoEncontradas++; continue; }
        await prisma.grupoLaboratorialFabricante.upsert({
          where: { fabricanteId },
          create: { grupoLaboratorialId: grupoId, fabricanteId, tipoAssociacao: "INEQUIVOCA", validadoManualmente: true },
          update: {},
        });
        integraisCriadas++;
      }
    }
    tempos.criarAssociacoesIntegrais = Date.now() - t0;
    console.log(`  ${integraisCriadas} associações integrais criadas, ${integraisNaoEncontradas} não encontradas (esperado — designações longas/variantes sem Fabricante real correspondente), em ${tempos.criarAssociacoesIntegrais}ms`);

    // ── G. Criar as regras validadas por CNP ────────────────────────────
    console.log("\n[G] Criar regras validadas por CNP...");
    t0 = Date.now();
    const regrasFicheiro = JSON.parse(readFileSync(REGRAS_PATH, "utf8")) as {
      regras: Array<{ cnp: number; grupoLaboratorialNomeNormalizado: string; evidencia: string; estado: "ATIVO"; validadoManualmente: boolean }>;
    };
    let regrasCriadas = 0;
    for (const r of regrasFicheiro.regras) {
      const grupoId = grupoIdPorNomeNormalizado.get(r.grupoLaboratorialNomeNormalizado);
      if (!grupoId) continue;
      await prisma.regraGrupoLaboratorialPorCnp.create({
        data: { cnp: r.cnp, grupoLaboratorialId: grupoId, evidencia: r.evidencia, estado: r.estado, validadoManualmente: r.validadoManualmente, dataAtualizacao: new Date() },
      });
      regrasCriadas++;
    }
    tempos.criarRegrasCnp = Date.now() - t0;
    console.log(`  ${regrasCriadas} regras por CNP criadas em ${tempos.criarRegrasCnp}ms`);

    // ── H. Classificador em DRY-RUN primeiro ────────────────────────────
    console.log("\n[H] Classificador — DRY-RUN primeiro...");
    t0 = Date.now();
    const dryRunResultado = await classificarGruposLaboratoriais(prisma, { apply: false });
    tempos.classificarDryRun = Date.now() - t0;
    console.log(`  Dry-run concluído em ${tempos.classificarDryRun}ms`);

    // ── I. Validar totais ────────────────────────────────────────────────
    console.log("\n[I] Validar totais...");
    const g = dryRunResultado.grupos;
    const definitivo = g.mantidoManual + g.regraCnp + g.fabricanteInequivoco + g.aliasInequivoco;
    const somaTotal = definitivo + g.propostaSnapshotCnp + g.semGrupo;
    console.log(`  definitivo=${definitivo} pendente=${g.propostaSnapshotCnp} semGrupo=${g.semGrupo} soma=${somaTotal} produtos=${g.produtos}`);
    if (somaTotal !== g.produtos) throw new Error(`[fatal] reconciliação falhou: soma(${somaTotal}) != produtos(${g.produtos})`);
    console.log("  ✓ reconciliação bate certo");

    // ── J. Aplicar a classificação NESTA base descartável ───────────────
    console.log("\n[J] Aplicar a classificação (só nesta base descartável)...");
    t0 = Date.now();
    const applyResultado = await classificarGruposLaboratoriais(prisma, { apply: true });
    tempos.classificarApply = Date.now() - t0;
    console.log(`  Apply concluído em ${tempos.classificarApply}ms — ${applyResultado.escritos} ProdutoGrupoLaboratorial escritos`);

    // ── K. Repetir o classificador — provar idempotência ────────────────
    console.log("\n[K] Repetir o classificador (apply) — provar idempotência...");
    const contagemAntesRepeticao = await prisma.produtoGrupoLaboratorial.count();
    t0 = Date.now();
    const segundaCorrida = await classificarGruposLaboratoriais(prisma, { apply: true });
    tempos.classificarApplyRepeticao = Date.now() - t0;
    const contagemDepoisRepeticao = await prisma.produtoGrupoLaboratorial.count();
    console.log(`  2ª corrida: ${segundaCorrida.escritos} upserts, ${tempos.classificarApplyRepeticao}ms`);
    console.log(`  ProdutoGrupoLaboratorial: ${contagemAntesRepeticao} antes → ${contagemDepoisRepeticao} depois (têm de ser IGUAIS — idempotência)`);
    const idempotente = contagemAntesRepeticao === contagemDepoisRepeticao && JSON.stringify(applyResultado.grupos) === JSON.stringify(segundaCorrida.grupos);
    console.log(`  ${idempotente ? "✓" : "✗"} idempotência confirmada: mesma contagem, mesmos totais por nível`);
    if (!idempotente) throw new Error("[fatal] segunda corrida NÃO é idempotente");

    // ── L. Consultas equivalentes aos filtros reais ─────────────────────
    console.log("\n[L] Consultas equivalentes aos filtros reais (Vendas/Margens/Inventário/Catálogo)...");
    const resolverTenantGarantia = async () => "garantia";
    const casos: Array<{ termo: string; esperaGrupo: string }> = [
      { termo: "MYLAN", esperaGrupo: "Viatris" },
      { termo: "UPJOHN", esperaGrupo: "Viatris" },
      { termo: "ALFA WASSERMANN", esperaGrupo: "Alfasigma" },
      { termo: "RATIOPHARM", esperaGrupo: "Teva" },
      { termo: "JNTL Consumer Health", esperaGrupo: "Kenvue" },
      { termo: "Pentafarma", esperaGrupo: "Tecnimede" },
    ];
    const resultadosFiltros: Record<string, unknown> = {};
    for (const c of casos) {
      const ids = await resolverProdutoIdsPorLaboratoriosSelecionados(prisma, [c.termo], resolverTenantGarantia);
      resultadosFiltros[c.termo] = { produtos: ids.length };
      console.log(`  "${c.termo}" (espera ${c.esperaGrupo}): ${ids.length} produtos`);
    }
    // JANSSEN não deve entrar em Kenvue — testa directamente por nome de fabricante (não é grupo).
    const janssenViaFabricante = await prisma.fabricante.findMany({ where: { nomeNormalizado: { contains: "JANSSEN" } }, select: { id: true } });
    const janssenEmKenvue = await prisma.produtoGrupoLaboratorial.findMany({
      where: { produto: { fabricanteId: { in: janssenViaFabricante.map((f) => f.id) } }, grupoLaboratorial: { nomeNormalizado: "KENVUE" } },
    });
    console.log(`  JANSSEN → Kenvue: ${janssenEmKenvue.length} produtos (tem de ser 0)`);
    resultadosFiltros["JANSSEN_em_Kenvue"] = janssenEmKenvue.length;

    // Pfizer: só os CNPs com regra validada entram em Viatris.
    const pfizerFabricantes = await prisma.fabricante.findMany({ where: { nomeNormalizado: { contains: "PFIZER" } }, select: { id: true } });
    const pfizerIntegralEmViatris = await prisma.grupoLaboratorialFabricante.findMany({
      where: { fabricanteId: { in: pfizerFabricantes.map((f) => f.id) }, grupoLaboratorial: { nomeNormalizado: "VIATRIS" } },
    });
    const pfizerViaRegraCnp = await prisma.produtoGrupoLaboratorial.count({
      where: { produto: { fabricanteId: { in: pfizerFabricantes.map((f) => f.id) } }, grupoLaboratorial: { nomeNormalizado: "VIATRIS" }, origem: "REGRA_CNP" },
    });
    console.log(`  Pfizer: ${pfizerIntegralEmViatris.length} associações INTEGRAIS com Viatris (tem de ser 0), ${pfizerViaRegraCnp} produtos via REGRA_CNP (positivo, esperado)`);
    resultadosFiltros["Pfizer_integral_Viatris"] = pfizerIntegralEmViatris.length;
    resultadosFiltros["Pfizer_via_regra_cnp"] = pfizerViaRegraCnp;

    // Produto sem grupo continua pesquisável pelo fabricante legal.
    const semGrupoExemplo = await prisma.produto.findFirst({ where: { grupoLaboratorial: null, fabricanteId: { not: null } }, select: { id: true, fabricante: { select: { nomeNormalizado: true } } } });
    if (semGrupoExemplo?.fabricante) {
      const idsViaFabricante = await resolverProdutoIdsPorLaboratoriosSelecionados(prisma, [semGrupoExemplo.fabricante.nomeNormalizado], resolverTenantGarantia);
      console.log(`  Produto sem grupo (fabricante "${semGrupoExemplo.fabricante.nomeNormalizado}"): ${idsViaFabricante.includes(semGrupoExemplo.id) ? "✓ continua pesquisável pelo nome legal" : "✗ FALHA"}`);
      resultadosFiltros["produto_sem_grupo_pesquisavel"] = idsViaFabricante.includes(semGrupoExemplo.id);
    }

    // ── Estatísticas finais ──────────────────────────────────────────────
    registarMemoria();
    const tamanhoDepois = await tamanhoBase(prisma);
    const linhasPorTabela = await contagemTabelas(prisma);

    console.log(`\n${"═".repeat(78)}`);
    console.log("RESUMO DO ENSAIO");
    console.log("═".repeat(78));
    console.log(`  Tamanho da base: ${tamanhoAntes} → ${tamanhoDepois}`);
    console.log(`  Memória RSS máxima observada: ${mb(memoriaMaxima.rss)}`);
    console.log(`  Tempos (ms): ${JSON.stringify(tempos, null, 2)}`);
    console.log(`  Linhas por tabela: ${JSON.stringify(linhasPorTabela, null, 2)}`);

    const relatorioFinal = {
      geradoEm: new Date().toISOString(),
      tempos,
      memoriaRssMaximaMB: Number((memoriaMaxima.rss / 1024 / 1024).toFixed(1)),
      tamanhoBaseAntes: tamanhoAntes,
      tamanhoBaseDepois: tamanhoDepois,
      linhasPorTabela,
      importacao: { resultado: statsImport.resultado, registosLidos: statsImport.registosLidos, batchSize: 500, totais: statsImport.totais, cnpDuplicadosNoFicheiro: statsImport.cnpDuplicadosNoFicheiro, erros: statsImport.erros.length },
      classificacaoDryRun: dryRunResultado.grupos,
      classificacaoApply: { escritos: applyResultado.escritos, totais: applyResultado.grupos },
      classificacaoSegundaCorrida: { escritos: segundaCorrida.escritos, idempotente },
      filtros: resultadosFiltros,
      integraisCriadas,
      integraisNaoEncontradas,
      regrasCriadas,
    };
    writeFileSync(SAIDA_PATH, JSON.stringify(relatorioFinal, null, 2), "utf8");
    console.log(`\nRelatório gravado em: ${SAIDA_PATH}`);
  } finally {
    clearInterval(cronometro);
    await prisma.$disconnect().catch(() => {});
  }
}

main().catch((err) => {
  console.error("[erro fatal]", err);
  process.exitCode = 1;
});
