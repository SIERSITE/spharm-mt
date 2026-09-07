/**
 * scripts/catalog-master/resolver-revisao-global.ts
 *
 * Marca uma divergência global como resolvida, com quem e porquê.
 *
 * ── O que escreve, e o que não ───────────────────────────────────────
 *
 * Escreve TRÊS campos numa linha de `CatalogoGlobalRevisao`:
 * `resolvidoEm`, `resolucao`, `resolvidoPor`.
 *
 * Não escreve em `Produto`. Não escreve em `CatalogoGlobal`. Não promove,
 * não projecta, não toca em classificação nenhuma. Quem resolve está a
 * dizer «isto foi visto e decidido»; mudar o catálogo por causa disso é
 * outro acto, com outras guardas — `catalog:promote-global` de um lado, a
 * validação manual no tenant do outro.
 *
 * ── Nada por omissão ─────────────────────────────────────────────────
 *
 *   --id=<id>            QUAL. Vem do diag:revisoes-globais.
 *   --aprovador="..."    QUEM responde por ter decidido.
 *   --motivo="..."       PORQUÊ — é o que se lê meses depois.
 *
 * Como no `catalog:promote-global`, nenhum destes tem valor por omissão:
 * uma resolução sem autor não é auditável, e a auditoria é a única coisa
 * que este comando produz.
 *
 * Dry-run é o default. `--apply` escreve.
 *
 * Uso:
 *   npm run catalog:resolver-revisao -- --id=<id> \
 *     --aprovador="Bruno Reis" --motivo="o global está certo; o local era um acordo local"
 *
 *   ... --apply
 */
import "dotenv/config";
import { controlPrisma } from "../../lib/control-plane";
import {
  lerRevisaoGlobal,
  resolverRevisaoGlobal,
  validarPedidoResolucao,
} from "../../lib/catalog/revisao-global";

const linha = (s = "") => console.log(s);

const valor = (argv: string[], nome: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${nome}=`))?.split("=").slice(1).join("=").trim();

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");

  linha("SPharm.MT · resolver revisão global · " + (apply ? "APPLY" : "DRY-RUN"));

  const pedido = {
    id: valor(argv, "id"),
    aprovador: valor(argv, "aprovador"),
    motivo: valor(argv, "motivo"),
  };

  // A validação corre ANTES de se tocar na base, e é a mesma função que a
  // UI usa. Recusar cedo e com o motivo à frente é a diferença entre um
  // comando que ensina e um que devolve "erro".
  const v = validarPedidoResolucao(pedido);
  if (!v.ok) {
    console.error(`\n${v.erro}\n`);
    console.error("  --id=<id>            de diag:revisoes-globais");
    console.error('  --aprovador="Nome"   quem responde por isto');
    console.error('  --motivo="..."       o que ficou decidido\n');
    process.exit(2);
  }

  const antes = await lerRevisaoGlobal(v.limpo.id);
  if (!antes) {
    console.error(`\nA revisão ${v.limpo.id} não existe.\n`);
    process.exit(2);
  }

  linha("═".repeat(76));
  linha(`  cnp ${antes.cnp} · tenant ${antes.tenantSlug} · tipo ${antes.tipo}`);
  linha(`  global ... ${antes.valorGlobal ?? "—"}`);
  linha(`  local .... ${antes.valorLocal ?? "—"}`);
  if (antes.globalOrigem) {
    linha(
      `  origem/confiança global ... ${antes.globalOrigem}` +
        ` / ${(antes.globalConfidence ?? 0).toFixed(2)}` +
        ` (${antes.globalVersaoRegras ?? "?"})`,
    );
  }
  linha(`  detectada em ${antes.detectadoEm.toISOString().slice(0, 10)}`);
  linha("═".repeat(76));

  if (antes.resolvidoEm) {
    linha("");
    linha(`  JÁ RESOLVIDA em ${antes.resolvidoEm.toISOString().slice(0, 10)}`);
    linha(`  por ...... ${antes.resolvidoPor ?? "(sem autor registado)"}`);
    linha(`  resolução  ${antes.resolucao ?? "—"}`);
    linha("");
    linha("  Não é sobreposta. Uma resolução escrita é um facto histórico —");
    linha("  substituí-la em silêncio apagaria a decisão de outra pessoa.");
    await controlPrisma.$disconnect();
    process.exit(3);
  }

  linha("");
  linha(`  aprovador ... ${v.limpo.aprovador}`);
  linha(`  motivo ...... ${v.limpo.motivo}`);

  if (!apply) {
    linha("");
    linha("  DRY-RUN: nada foi escrito. Para aplicar, acrescentar --apply.");
    await controlPrisma.$disconnect();
    return;
  }

  const r = await resolverRevisaoGlobal(v.limpo);
  linha("");
  if (!r.ok) {
    console.error(`  NÃO resolvida: ${r.erro}`);
    await controlPrisma.$disconnect();
    process.exit(3);
  }

  linha(`  Resolvida em ${r.revisao.resolvidoEm?.toISOString() ?? "?"} por ${r.revisao.resolvidoPor}.`);
  linha("");
  linha("  A classificação NÃO foi alterada — nem no tenant, nem no global.");
  linha("  Se for para mudar alguma, é catalog:promote-global ou a validação");
  linha("  manual no tenant, e cada uma tem as suas guardas.");

  await controlPrisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
