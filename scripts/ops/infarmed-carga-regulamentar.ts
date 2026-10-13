/**
 * scripts/ops/infarmed-carga-regulamentar.ts
 *
 * Carga (inicial ou manual) do ficheiro «allPackages» do INFARMED para a base
 * de UM tenant, e rollback da última versão aplicada.
 *
 *   DRY-RUN por omissão (nada é escrito, só o relatório JSON):
 *     npx tsx scripts/ops/infarmed-carga-regulamentar.ts --tenant=silveira --file=/caminho/allPackages.xls
 *
 *   Aplicar:
 *     … --apply
 *
 *   Reverter a versão ativa (volta à anterior; não apaga dados):
 *     … --tenant=silveira --reverter            (dry-run)
 *     … --tenant=silveira --reverter --apply
 *
 *   Listar o histórico:
 *     … --tenant=silveira --listar
 *
 *   Reconciliar o catálogo (forma, dosagem, embalagem, DCI) com a versão JÁ ativa —
 *   sem importação nova, sem tocar no SHA/histórico, sem descarregar nada:
 *     … --reconciliar --tenant=silveira,segurado,garantia          (dry-run: só contadores)
 *     … --reconciliar --tenant=silveira,segurado,garantia --apply
 *     … --reconciliar --todos [--apply]                            (todos os tenants ativos)
 *   O --apply grava reconciliacao-<operacaoId>.json (valor anterior de cada campo alterado), ANTES de
 *   confirmar cada transação. É esse ficheiro que permite reverter:
 *
 *   Reverter uma reconciliação (repõe exatamente os valores anteriores; edições posteriores nunca se perdem):
 *     … --reverter-reconciliacao=/relatorios/reconciliacao-<id>.json            (dry-run)
 *     … --reverter-reconciliacao=/relatorios/reconciliacao-<id>.json --apply
 *     … --reverter-reconciliacao=<ficheiro> --tenant=a,b                        (só alguns tenants do relatório)
 *
 * Opções:
 *   --tenant=<slug>        tenant do control plane (produção/Docker)
 *   --database-url=<url>   alternativa para bases LOCAIS descartáveis (só localhost)
 *   --file=<xls>           ficheiro original (Excel 97-2003)
 *   --origem=CARGA_INICIAL|MANUAL   (omissão: CARGA_INICIAL se ainda não há versão)
 *   --forcar               reaplica uma versão já processada (ex.: após rollback deliberado)
 *   --relatorio-dir=<dir>  onde gravar o relatório JSON (omissão: /relatorios se existir, senão ./relatorios)
 *
 * Só escreve em InfarmedImportacao e ProdutoRegulamentar. Nunca altera Produto,
 * ProdutoFarmacia, vendas, stocks, encomendas nem preços.
 */

import Module from "node:module";
import fs from "node:fs";
import path from "node:path";

const M = Module as unknown as { _resolveFilename: (r: string, ...a: unknown[]) => string };
const resolverOriginal = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "server-only" ? __filename : resolverOriginal.call(this, request, ...rest);
};

function arg(nome: string): string | undefined {
  const a = process.argv.slice(2).find((x) => x === `--${nome}` || x.startsWith(`--${nome}=`));
  if (!a) return undefined;
  return a.includes("=") ? a.slice(a.indexOf("=") + 1) : "true";
}

function ajuda() {
  process.stdout.write(
    [
      "Carga dos dados regulamentares do INFARMED (um tenant de cada vez).",
      "",
      "  --tenant=<slug> | --database-url=<url-local>   (obrigatório um deles)",
      "  --file=<allPackages.xls>        ficheiro original",
      "  --apply                         aplica (omissão: dry-run, só relatório)",
      "  --reverter [--apply]            volta à versão anterior",
      "  --listar                        histórico de importações",
      "  --reconciliar [--apply]         reconcilia o catálogo com a versão ativa (--tenant=a,b,c | --todos)",
      "  --reverter-reconciliacao=<json> [--apply]   repõe os valores anteriores de uma reconciliação aplicada",
      "  --origem=CARGA_INICIAL|MANUAL   --forcar   --relatorio-dir=<dir>",
      "",
    ].join("\n"),
  );
}

function pastaRelatorios(): string {
  const dado = arg("relatorio-dir");
  if (dado) return dado;
  return fs.existsSync("/relatorios") ? "/relatorios" : path.resolve("relatorios");
}

async function obterPrisma(): Promise<{ prisma: import("@/generated/prisma/client").PrismaClient; nome: string }> {
  const tenant = arg("tenant");
  const url = arg("database-url");
  if ((tenant && url) || (!tenant && !url)) throw new Error("Indique exatamente um de --tenant=<slug> ou --database-url=<url-local>.");
  if (url) {
    const host = new URL(url).hostname;
    if (host !== "localhost" && host !== "127.0.0.1") throw new Error("--database-url só aceita localhost/127.0.0.1 (bases descartáveis).");
    const { PrismaPg } = await import("@prisma/adapter-pg");
    const { PrismaClient } = await import("@/generated/prisma/client");
    return { prisma: new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) }), nome: "local" };
  }
  const { getTenantPrismaOrLegacy } = await import("@/lib/tenant-registry");
  return { prisma: await getTenantPrismaOrLegacy(tenant!), nome: tenant! };
}

/** Reconciliação do catálogo com a versão ativa, em vários tenants. Um tenant a falhar não pára os outros. */
async function reconciliar(apply: boolean): Promise<number> {
  const { reconciliarVersaoAtiva, CAMPOS_RECONCILIADOS } = await import("@/lib/regulamentar/infarmed-reconciliar");
  type Alvo = { nome: string; prisma: import("@/generated/prisma/client").PrismaClient };
  const alvos: Alvo[] = [];
  const url = arg("database-url");
  const tenants = arg("tenant");
  if (url) {
    alvos.push({ nome: "local", prisma: (await obterPrisma()).prisma });
  } else if (arg("todos")) {
    const { listarTenantsAtivos } = await import("@/lib/regulamentar/infarmed-runtime");
    for (const t of await listarTenantsAtivos()) alvos.push({ nome: t.slug, prisma: t.prisma });
  } else if (tenants) {
    const { getTenantPrismaOrLegacy } = await import("@/lib/tenant-registry");
    for (const slug of tenants.split(",").map((x) => x.trim()).filter(Boolean)) alvos.push({ nome: slug, prisma: await getTenantPrismaOrLegacy(slug) });
  } else {
    throw new Error("Indique --tenant=a,b,c, --todos ou --database-url=<url-local>.");
  }
  const resultados: unknown[] = [];
  let falhas = 0;
  // Relatório de aplicação (reversível). Reescrito (tmp+rename+fsync) ANTES de cada transação confirmar:
  // se a escrita falhar, a transação é anulada e nada fica gravado sem possibilidade de reversão.
  type Rev = typeof import("@/lib/regulamentar/infarmed-reverter");
  const { randomUUID } = await import("node:crypto");
  const rev: Rev = await import("@/lib/regulamentar/infarmed-reverter");
  const operacaoId = randomUUID();
  const geradoEm = new Date().toISOString();
  const relatorioAplicacao: import("@/lib/regulamentar/infarmed-reverter").RelatorioReconciliacao = {
    formato: rev.FORMATO_RELATORIO_RECONCILIACAO, operacaoId, geradoEm, modo: "APPLY", tenants: [],
  };
  const dirRel = pastaRelatorios();
  const ficheiroApply = path.join(dirRel, `reconciliacao-${operacaoId}.json`);
  const gravarApply = () => {
    fs.mkdirSync(dirRel, { recursive: true });
    const tmp = `${ficheiroApply}.tmp`;
    const fd = fs.openSync(tmp, "w");
    try { fs.writeSync(fd, JSON.stringify(relatorioAplicacao, null, 1)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, ficheiroApply);
  };
  process.stdout.write(`\nRECONCILIAÇÃO DO CATÁLOGO COM A VERSÃO ATIVA DO INFARMED — ${apply ? "APPLY" : "DRY-RUN"}\n`);
  for (const a of alvos) {
    try {
      const entrada: Array<import("@/lib/regulamentar/infarmed-reverter").TenantRelatorio> = [];
      const r = await reconciliarVersaoAtiva(a.prisma, {
        apply,
        registarAlteracoes: apply,
        antesDeConfirmar: apply
          ? async (alt) => {
              const ativa = await a.prisma.infarmedImportacao.findFirst({ where: { ativa: true }, select: { id: true, sha256: true } });
              const alteracoes = rev.alteracoesParaRelatorio(a.nome, operacaoId, geradoEm, alt);
              const t = { tenant: a.nome, importacaoId: ativa?.id ?? "", sha256: ativa?.sha256 ?? "", estado: "PENDENTE" as const, integridade: rev.integridadeDe(alteracoes), alteracoes };
              entrada.push(t);
              relatorioAplicacao.tenants.push(t);
              gravarApply(); // se falhar, a transação é anulada
            }
          : undefined,
      });
      for (const t of entrada) t.estado = "CONFIRMADO";
      if (entrada.length > 0) gravarApply();
      if (!r) {
        process.stdout.write(`\n[${a.nome}] sem versão ativa — nada a reconciliar\n`);
        resultados.push({ tenant: a.nome, versaoAtiva: null });
        continue;
      }
      const c = r.contadores;
      process.stdout.write(`\n[${a.nome}] versão ativa ${r.sha256.slice(0, 12)} · analisados ${c.produtosAnalisados} · associados ${c.produtosAssociados} · sem correspondência ${c.semCorrespondencia ?? "—"} · produtos ${apply ? "alterados" : "a alterar"} ${c.produtosAlterados}\n`);
      for (const k of CAMPOS_RECONCILIADOS) {
        const f = c.campos[k];
        process.stdout.write(`    ${k.padEnd(18)} preenchidos ${f.preenchidos} · atualizados ${f.atualizados} · ignorados (manual) ${f.ignoradosManual} · ignorados (vazio) ${f.ignoradosVazio} · já iguais ${f.jaIguais}\n`);
      }
      // As alterações detalhadas vão para o relatório reversível, não para o resumo.
      const { alteracoes: _omitidas, ...contadoresResumo } = c;
      void _omitidas;
      resultados.push({ tenant: a.nome, importacaoId: r.importacaoId, sha256: r.sha256, contadores: contadoresResumo });
    } catch (e) {
      falhas++;
      process.stdout.write(`\n[${a.nome}] ERRO: ${e instanceof Error ? e.message : String(e)}\n`);
      resultados.push({ tenant: a.nome, erro: e instanceof Error ? e.message : String(e) });
    }
  }
  fs.mkdirSync(dirRel, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const destino = path.join(dirRel, `infarmed-reconciliacao-${ts}-${apply ? "apply" : "dryrun"}.json`);
  fs.writeFileSync(destino, JSON.stringify({ geradoEm: new Date().toISOString(), operacaoId: apply ? operacaoId : undefined, modo: apply ? "APPLY" : "DRY_RUN", resultados }, null, 2), "utf8");
  process.stdout.write(`\nrelatório (resumo): ${destino}\n`);
  if (apply) {
    if (relatorioAplicacao.tenants.length === 0) process.stdout.write("Nenhum campo foi alterado — não há nada a reverter.\n");
    else process.stdout.write(`relatório REVERSÍVEL: ${ficheiroApply}\nPara reverter: --reverter-reconciliacao=${ficheiroApply} [--apply]\n`);
  } else process.stdout.write("Nada foi escrito na base. Repita com --apply para aplicar.\n");
  for (const a of alvos) await a.prisma.$disconnect().catch(() => undefined);
  return falhas > 0 ? 1 : 0;
}

/** Reverte uma reconciliação a partir do relatório do --apply. Dry-run por omissão. */
async function reverterReconciliacao(apply: boolean): Promise<number> {
  const ficheiro = arg("reverter-reconciliacao");
  if (!ficheiro || ficheiro === "true") throw new Error("Indique --reverter-reconciliacao=<reconciliacao-<id>.json>.");
  const rev = await import("@/lib/regulamentar/infarmed-reverter");
  const relatorio = rev.validarRelatorio(JSON.parse(fs.readFileSync(ficheiro, "utf8")));
  const filtro = arg("tenant")?.split(",").map((x) => x.trim()).filter(Boolean);
  const alvos = relatorio.tenants.filter((t) => !filtro || filtro.includes(t.tenant));
  if (filtro) for (const f of filtro) if (!relatorio.tenants.some((t) => t.tenant === f)) throw new Error(`O tenant «${f}» não consta do relatório.`);
  if (alvos.length === 0) throw new Error("O relatório não tem tenants para reverter.");

  process.stdout.write(`\nREVERSÃO DA RECONCILIAÇÃO ${relatorio.operacaoId} (${relatorio.geradoEm}) — ${apply ? "APPLY" : "DRY-RUN"}\n`);
  const campos = ["formaFarmaceutica", "dosagem", "embalagem", "dci"] as const;
  const resultados: Array<import("@/lib/regulamentar/infarmed-reverter").ResultadoReversaoTenant> = [];
  const erros: Array<{ tenant: string; erro: string }> = [];
  const { getTenantPrismaOrLegacy } = await import("@/lib/tenant-registry");
  for (const t of alvos) {
    try {
      const prisma = arg("database-url") ? (await obterPrisma()).prisma : await getTenantPrismaOrLegacy(t.tenant);
      try {
        const r = await rev.reverterReconciliacaoTenant(prisma, t, { apply });
        resultados.push(r);
        process.stdout.write(`\n[${t.tenant}] alterações no relatório ${r.analisadas} · ${apply ? "revertidas" : "a reverter"} ${r.revertidas} · já no valor anterior ${r.jaRevertidas} · conflitos (não tocados) ${r.conflitos.length}\n`);
        for (const k of campos) {
          const f = r.porCampo[k];
          process.stdout.write(`    ${k.padEnd(18)} ${apply ? "revertidas" : "a reverter"} ${f.revertidas} · já anteriores ${f.jaRevertidas} · conflitos ${f.conflitos}\n`);
        }
        for (const c of r.conflitos.slice(0, 20)) process.stdout.write(`      conflito cnp ${c.cnp} ${c.campo}: ${c.motivo} (atual ${JSON.stringify(c.atual)}, esperado ${JSON.stringify(c.esperado)})\n`);
        if (r.conflitos.length > 20) process.stdout.write(`      … e mais ${r.conflitos.length - 20} (ver relatório)\n`);
      } finally {
        await prisma.$disconnect().catch(() => undefined);
      }
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      erros.push({ tenant: t.tenant, erro: m });
      process.stdout.write(`\n[${t.tenant}] ERRO (nada alterado neste tenant): ${m}\n`);
    }
  }
  const dir = pastaRelatorios();
  fs.mkdirSync(dir, { recursive: true });
  const destino = path.join(dir, `reversao-${relatorio.operacaoId}-${new Date().toISOString().replace(/[:.]/g, "-")}-${apply ? "apply" : "dryrun"}.json`);
  fs.writeFileSync(destino, JSON.stringify({ geradoEm: new Date().toISOString(), modo: apply ? "APPLY" : "DRY_RUN", operacaoId: relatorio.operacaoId, ficheiroOrigem: path.resolve(ficheiro), resultados, erros }, null, 2), "utf8");
  process.stdout.write(`\nrelatório: ${destino}\n${apply ? "" : "Nada foi alterado. Repita com --apply para reverter.\n"}`);
  return erros.length > 0 ? 1 : 0;
}

async function main(): Promise<number> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    ajuda();
    return 0;
  }
  const apply = arg("apply") === "true";
  if (arg("reverter-reconciliacao")) return reverterReconciliacao(apply);
  if (arg("reconciliar")) return reconciliar(apply);
  const { prisma, nome } = await obterPrisma();
  try {
    if (arg("listar")) {
      const rows = await prisma.infarmedImportacao.findMany({ orderBy: { iniciadaEm: "desc" }, take: 50 });
      for (const r of rows) {
        process.stdout.write(
          `${r.iniciadaEm.toISOString()}  ${r.id}  ${r.estado.padEnd(9)} ${r.ativa ? "ATIVA" : "     "} ${r.origem.padEnd(13)} sha=${r.sha256.slice(0, 12)} linhas=${r.linhasLidas} assoc=${r.produtosAssociados}${r.erro ? ` erro="${r.erro}"` : ""}\n`,
        );
      }
      return 0;
    }

    const { aplicarVersaoInfarmed, reverterVersaoInfarmed } = await import("@/lib/regulamentar/infarmed-aplicar");

    if (arg("reverter")) {
      const r = await reverterVersaoInfarmed(prisma, { apply });
      process.stdout.write(`${apply ? "REVERSÃO" : "REVERSÃO (dry-run)"} tenant=${nome}: ${JSON.stringify(r)}\n`);
      if (!apply) process.stdout.write("Nada foi alterado. Repita com --apply para reverter.\n");
      return r.ok ? 0 : 1;
    }

    const ficheiroArg = arg("file");
    if (!ficheiroArg) throw new Error("Falta --file=<allPackages.xls>.");
    const { lerFicheiroInfarmed } = await import("@/lib/regulamentar/infarmed-ficheiro");
    const buf = fs.readFileSync(ficheiroArg);
    const ficheiro = lerFicheiroInfarmed(buf);

    const jaHaVersao = (await prisma.infarmedImportacao.count({ where: { estado: { in: ["APLICADA", "REVERTIDA"] } } })) > 0;
    const origem = (arg("origem") as "CARGA_INICIAL" | "MANUAL" | undefined) ?? (jaHaVersao ? "MANUAL" : "CARGA_INICIAL");
    const rel = await aplicarVersaoInfarmed(prisma, ficheiro, {
      origem,
      apply,
      forcar: arg("forcar") === "true",
      nomeFicheiro: path.basename(ficheiroArg),
    });

    const dir = pastaRelatorios();
    fs.mkdirSync(dir, { recursive: true });
    const destino = path.join(dir, `infarmed-${nome}-${rel.geradoEm.replace(/[:.]/g, "-")}-${apply ? "apply" : "dryrun"}-${ficheiro.sha256.slice(0, 8)}.json`);
    fs.writeFileSync(destino, JSON.stringify(rel, null, 2), "utf8");

    const l = (k: string, v: unknown) => process.stdout.write(`  ${k.padEnd(32)} ${v}\n`);
    process.stdout.write(`\nINFARMED — ${apply ? "APPLY" : "DRY-RUN"} — tenant=${nome}\n`);
    l("resultado", rel.resultado + (rel.motivo ? ` (${rel.motivo})` : ""));
    l("sha256", rel.ficheiro.sha256);
    l("linhas lidas", rel.linhasLidas);
    l("CNP distintos", rel.cnpDistintos);
    l("linhas rejeitadas", rel.linhasRejeitadas);
    l("duplicados idênticos / conflitos", `${rel.duplicadosIdenticos} / ${rel.conflitos}`);
    l("produtos associados (por CNP)", rel.produtosAssociados);
    l("CNP não encontrados", rel.cnpNaoEncontrados);
    l("registos novos / alterados / iguais", `${rel.registosNovos} / ${rel.registosAlterados} / ${rel.registosIguais}`);
    l("campos alterados", rel.camposAlterados);
    l("deixaram de estar presentes", rel.deixaramDeEstarPresentes);
    l("regulamentar ativo antes → depois", `${rel.antes.regulamentarAtivo} → ${rel.depois?.regulamentarAtivo ?? "—"}`);
    l("operacional intacto", rel.operacionalIntacto === null ? "—" : rel.operacionalIntacto ? "sim" : "NÃO");
    l("relatório", destino);
    if (!apply) process.stdout.write("\nNada foi escrito na base. Repita com --apply para aplicar.\n");
    return rel.resultado === "FALHADA" || rel.resultado === "RECUSADA" ? 1 : 0;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

main().then(
  (c) => process.exit(c),
  (e) => {
    process.stderr.write(`ERRO: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  },
);
