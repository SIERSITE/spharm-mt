/**
 * scripts/admin/definir-codigo-farmacia-designacao.ts
 *
 * Comando administrativo IDEMPOTENTE para identificar a farmácia Silveirense
 * como autoritativa da designação: atribui `Farmacia.codigoANF` (o identificador
 * estável que a regra usa — ver lib/ingest/designacao-silveira.ts).
 *
 *   · DRY-RUN por omissão (só mostra o que faria); `--apply` escreve.
 *   · O id da farmácia é OBRIGATÓRIO — nunca escolhe "a primeira" nem por nome.
 *   · Idempotente: se a farmácia já tem esse código, não escreve nada.
 *   · Recusa se outra farmácia já usa o código, ou se a farmácia já tem OUTRO
 *     código (o codigoANF aparece nos cabeçalhos dos relatórios) — `--forcar`.
 *   · Só toca em Farmacia.codigoANF. Nada mais.
 *
 * Passo 2 (fora deste script): definir no ambiente da app
 *   SILVEIRA_DESIGNACAO_AUTORITATIVA_CODIGO_ANF=<o mesmo código>
 * e reiniciar. Verificar com: npm run diag:designacao-silveira -- --tenant=silveira
 *
 * Uso:
 *   npm run admin:definir-codigo-farmacia-designacao -- --tenant=silveira --farmacia-id=<id> --codigo=<ANF>
 *   npm run admin:definir-codigo-farmacia-designacao -- --tenant=silveira --farmacia-id=<id> --codigo=<ANF> --apply
 *   (base local de teste: --database-url=postgresql://…@localhost/… em vez de --tenant)
 *
 * Exit codes: 0 OK (incl. sem alteração) · 1 recusado · 2 erro de uso.
 */
import "dotenv/config";
import { parseArgs } from "node:util";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";
import { ENV_CODIGO_ANF_DESIGNACAO } from "../../lib/ingest/designacao-silveira";
import { definirCodigoFarmacia } from "../../lib/ingest/designacao-silveira-admin";

async function main() {
  const { values } = parseArgs({
    options: {
      tenant: { type: "string" },
      "database-url": { type: "string" },
      "farmacia-id": { type: "string" },
      codigo: { type: "string" },
      apply: { type: "boolean", default: false },
      forcar: { type: "boolean", default: false },
    },
    strict: true,
  });
  const farmaciaId = values["farmacia-id"]?.trim();
  const codigo = values.codigo?.trim();
  if (!farmaciaId || !codigo) {
    console.error("✗ --farmacia-id e --codigo são obrigatórios (este comando nunca escolhe a farmácia).");
    process.exit(2);
  }

  let url = values["database-url"]?.trim();
  if (url) {
    const h = new URL(url).hostname;
    if (h !== "localhost" && h !== "127.0.0.1") {
      console.error(`--database-url recusado: ${h} não é local. Para produção use --tenant (control plane).`);
      process.exit(2);
    }
  } else {
    const slug = values.tenant?.trim();
    if (!slug) {
      console.error("✗ --tenant <slug> (ou --database-url local) é obrigatório.");
      process.exit(2);
    }
    const { getTenantBySlug, buildTenantConnectionString } = await import("../../lib/control-plane");
    const tenant = await getTenantBySlug(slug);
    if (!tenant) {
      console.error(`O tenant "${slug}" não existe no control plane.`);
      process.exit(2);
    }
    url = buildTenantConnectionString(tenant);
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    const r = await definirCodigoFarmacia(prisma, { farmaciaId, codigo, aplicar: values.apply === true, forcar: values.forcar === true });
    if (!r.ok) {
      console.error(`✗ ${r.erro}: ${r.mensagem}`);
      process.exit(1);
    }
    if (r.accao === "SEM_ALTERACAO") {
      console.log(`✓ Sem alteração: a farmácia já tem codigoANF "${r.codigoNovo}".`);
    } else if (r.aplicado) {
      console.log(`✓ codigoANF ${r.accao === "ATRIBUIR" ? "atribuído" : "substituído"}: "${r.codigoAnterior ?? "—"}" → "${r.codigoNovo}" (farmácia ${r.farmaciaId}).`);
    } else {
      console.log(`DRY-RUN: ${r.accao === "ATRIBUIR" ? "atribuiria" : "substituiria"} codigoANF "${r.codigoAnterior ?? "—"}" → "${r.codigoNovo}" na farmácia ${r.farmaciaId}. Repetir com --apply para escrever.`);
    }
    console.log("");
    console.log("Passo seguinte (ambiente da app, depois reiniciar):");
    console.log(`  ${ENV_CODIGO_ANF_DESIGNACAO}=${r.codigoNovo}`);
    console.log("Verificar:  npm run diag:designacao-silveira -- --tenant=silveira");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
