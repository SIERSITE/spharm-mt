/**
 * scripts/catalog-master/encerrar-revisoes-falsas.ts
 *
 * Fecha em bloco as revisões que o defeito do global-sem-classificação
 * criou. Só essas.
 *
 * ── O defeito, e o que ele produziu ──────────────────────────────────
 *
 * `avaliarProjeccao` comparava uma classificação local específica com o
 * global ANTES de verificar se o global tinha alguma coisa com que
 * comparar. Com o global a null dos dois lados, a comparação dava sempre
 * "diferente" e abria-se uma revisão com
 * `valorGlobal = "null > null"` — a string que o template literal produz.
 *
 * Em produção: 1 246 pendentes, 1 212 nascidas assim.
 *
 * ── O critério é o SNAPSHOT, não o estado de hoje ────────────────────
 *
 * Das 1 246, 1 185 têm o global HOJE sem classificação — mas 1 212 foram
 * GRAVADAS com "null > null". As 27 de diferença nasceram falsas e o CNP
 * entretanto ganhou classificação global.
 *
 * Pelo estado actual, essas 27 pareceriam conflitos e ficavam a ocupar
 * uma pessoa com uma divergência que nunca existiu. Pelo snapshot, são o
 * que foram. Um rasto de auditoria julga o acto pelo que era verdade
 * quando aconteceu.
 *
 * As restantes 34 — nascidas com um global específico — NÃO são tocadas.
 * Essas são divergências a sério e é para elas que a fila existe.
 *
 * ── Correr DEPOIS do fix estar em produção ───────────────────────────
 *
 * Com o código antigo a correr, cada `project-global` e cada importação
 * criam mais. Encerrar antes é varrer para debaixo de um tapete que
 * continua a encher.
 *
 * Uso:
 *   npm run catalog:encerrar-revisoes-falsas -- --aprovador="Bruno Reis"
 *   npm run catalog:encerrar-revisoes-falsas -- --aprovador="Bruno Reis" --apply
 */
import "dotenv/config";
import { controlPrisma } from "../../lib/control-plane";
import {
  encerrarFalsosConflitos,
  SNAPSHOT_SEM_CLASSIFICACAO,
} from "../../lib/catalog/revisao-global";

const nf = (n: number) => n.toLocaleString("pt-PT");
const pad = (n: number) => String(nf(n)).padStart(7);
const linha = (s = "") => console.log(s);

const MOTIVO_OMISSAO =
  "Encerrada automaticamente: falso conflito criado por global sem classificação (bug corrigido).";

const valor = (argv: string[], nome: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${nome}=`))?.split("=").slice(1).join("=").trim();

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");

  linha("SPharm.MT · encerrar falsos conflitos globais · " + (apply ? "APPLY" : "DRY-RUN"));

  const aprovador = valor(argv, "aprovador");
  const motivo = valor(argv, "motivo") ?? MOTIVO_OMISSAO;

  if (!aprovador) {
    console.error("\nFalta --aprovador=\"Nome\".\n");
    console.error("  Um encerramento em bloco de centenas de linhas sem autor");
    console.error("  não é auditável, e é a auditoria a única coisa que fica.\n");
    process.exit(2);
  }

  linha("═".repeat(76));
  linha(`  critério: pendente E valorGlobal = "${SNAPSHOT_SEM_CLASSIFICACAO}"`);
  linha("  (o snapshot gravado na revisão, não o estado de hoje do global)");
  linha("═".repeat(76));

  const r = await encerrarFalsosConflitos({ aprovador, motivo, dryRun: !apply });
  if (!r.ok) {
    console.error(`\n${r.erro}\n`);
    await controlPrisma.$disconnect();
    process.exit(2);
  }

  const { resumo } = r;
  linha("");
  linha(`  candidatas (falsos conflitos) ..... ${pad(resumo.candidatas)}`);
  linha(`  preservadas (conflitos reais) ..... ${pad(resumo.preservadas)}`);
  if (resumo.porTenant.length > 0) {
    linha("");
    linha("  candidatas por tenant:");
    for (const t of resumo.porTenant) linha(`    ${t.tenantSlug.padEnd(24)} ${pad(t.n)}`);
  }

  linha("");
  linha(`  aprovador ... ${aprovador}`);
  linha(`  resolução ... ${motivo}`);

  if (!apply) {
    linha("");
    linha("  DRY-RUN: nada foi escrito. Para aplicar, acrescentar --apply.");
    linha("");
    linha("  Antes de aplicar: confirmar que o fix já está em produção. Com o");
    linha("  código antigo a correr, cada project-global cria mais.");
    await controlPrisma.$disconnect();
    return;
  }

  linha("");
  linha(`  ${pad(resumo.encerradas)}  encerradas`);
  linha(`  ${pad(resumo.preservadas)}  intocadas — continuam pendentes para revisão humana`);
  linha("");
  linha("  Nenhum Produto e nenhuma linha de CatalogoGlobal foi alterada.");
  linha("  Correr de novo devolve zero candidatas — é essa a verificação.");

  await controlPrisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
