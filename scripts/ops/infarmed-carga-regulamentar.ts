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

async function main(): Promise<number> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    ajuda();
    return 0;
  }
  const apply = arg("apply") === "true";
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
