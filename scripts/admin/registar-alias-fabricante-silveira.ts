/**
 * scripts/admin/registar-alias-fabricante-silveira.ts
 *
 * Regista um `FabricanteAlias` na base do tenant `silveira` — ferramenta
 * pontual e deliberadamente ESTREITA (só este tenant, nunca genérica
 * para qualquer tenant) para o caso real "GENERIS DIRECTO" (ver
 * lib/ingest/catalog-from-erp.ts): o ERP da Farmácia Silveirense envia
 * "GENERIS DIRECTO", que é uma designação alternativa do fabricante já
 * existente "Generis Farmacêutica, S.A. Portugal" — sem este alias
 * registado, `applyErpCatalogFields` não teria como saber disso e criaria
 * um `Fabricante` duplicado literal "GENERIS DIRECTO".
 *
 * O alias é gravado já normalizado pela MESMA função que
 * `catalog-from-erp.ts` aplica ao valor do ERP antes de procurar em
 * `FabricanteAlias` — um alias gravado em bruto nunca seria encontrado
 * pelo caminho real de ingestão.
 *
 * Uso (SEMPRE --tenant silveira — qualquer outro valor é recusado):
 *
 *   Dry-run (mostra o que faria, não escreve nada):
 *     npx tsx scripts/admin/registar-alias-fabricante-silveira.ts \
 *       --tenant silveira --alias "GENERIS DIRECTO" --fabricante-id <id>
 *
 *   Escrita real (exige confirmação explícita):
 *     npx tsx scripts/admin/registar-alias-fabricante-silveira.ts \
 *       --tenant silveira --alias "GENERIS DIRECTO" --fabricante-id <id> --confirmar
 *
 *   Em vez de --fabricante-id, pode identificar o fabricante por uma
 *   pesquisa (substring, case-insensitive) sobre o nome canónico — só
 *   prossegue se encontrar exactamente 1 resultado, nunca escolhe entre
 *   vários arbitrariamente:
 *     npx tsx scripts/admin/registar-alias-fabricante-silveira.ts \
 *       --tenant silveira --alias "GENERIS DIRECTO" --fabricante-nome "Generis Farmac" --confirmar
 *
 * Idempotente: se o alias já estiver correctamente associado ao mesmo
 * fabricante, a operação é um no-op bem-sucedido — nunca cria uma
 * segunda row.
 *
 * NUNCA correr contra a VPS ou qualquer base real a partir daqui sem
 * revisão humana explícita — esta ferramenta escreve directamente na
 * base do tenant resolvido pelo control-plane.
 */
import "dotenv/config";
import { parseArgs } from "node:util";
import { getTenantBySlug, buildTenantConnectionString } from "@/lib/control-plane";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { normalizarFabricante } from "@/lib/ingest/catalog-from-erp";

const TENANT_PERMITIDO = "silveira";

async function main() {
  const { values } = parseArgs({
    options: {
      tenant: { type: "string" },
      alias: { type: "string" },
      "fabricante-id": { type: "string" },
      "fabricante-nome": { type: "string" },
      confirmar: { type: "boolean" },
    },
    strict: true,
  });

  if (values.tenant !== TENANT_PERMITIDO) {
    console.error(`✗ Esta ferramenta só aceita --tenant ${TENANT_PERMITIDO} — recebido "${values.tenant ?? ""}".`);
    process.exit(1);
  }
  const aliasNormalizado = normalizarFabricante(values.alias ?? null);
  if (!aliasNormalizado) {
    console.error("✗ --alias vazio ou inválido (depois de normalizado, ficou vazio).");
    process.exit(1);
  }
  if (!values["fabricante-id"] && !values["fabricante-nome"]) {
    console.error("✗ indica --fabricante-id <id> ou --fabricante-nome \"<busca>\".");
    process.exit(1);
  }
  if (values["fabricante-id"] && values["fabricante-nome"]) {
    console.error("✗ indica só um: --fabricante-id OU --fabricante-nome, nunca os dois.");
    process.exit(1);
  }

  const tenant = await getTenantBySlug(values.tenant);
  if (!tenant) {
    console.error(`✗ Tenant "${values.tenant}" não existe.`);
    process.exit(1);
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: buildTenantConnectionString(tenant) }) });
  try {
    let fabricanteId: string;
    let fabricanteNome: string;

    if (values["fabricante-id"]) {
      const alvo = await prisma.fabricante.findUnique({ where: { id: values["fabricante-id"] }, select: { id: true, nomeNormalizado: true } });
      if (!alvo) {
        console.error(`✗ Fabricante "${values["fabricante-id"]}" não existe neste tenant.`);
        process.exit(1);
      }
      fabricanteId = alvo.id;
      fabricanteNome = alvo.nomeNormalizado;
    } else {
      const busca = values["fabricante-nome"]!.trim();
      const candidatos = await prisma.fabricante.findMany({
        where: { nomeNormalizado: { contains: busca, mode: "insensitive" } },
        select: { id: true, nomeNormalizado: true },
      });
      if (candidatos.length === 0) {
        console.error(`✗ Nenhum fabricante encontrado para "${busca}".`);
        process.exit(1);
      }
      if (candidatos.length > 1) {
        console.error(
          `✗ ${candidatos.length} fabricantes encontrados para "${busca}" — ambíguo, não escolho arbitrariamente. Usa --fabricante-id com um destes:\n` +
            candidatos.map((c) => `    ${c.id}  ${c.nomeNormalizado}`).join("\n"),
        );
        process.exit(1);
      }
      fabricanteId = candidatos[0]!.id;
      fabricanteNome = candidatos[0]!.nomeNormalizado;
    }

    // Idempotência + detecção de conflito: o MESMO alias pode já estar
    // associado a outro fabricante (dado que `@@unique([fabricanteId,
    // aliasNome])` no schema não impede isso — ver o comentário em
    // catalog-from-erp.ts sobre ambiguidade). Aqui a regra é mais
    // rigorosa que a do ingest: esta ferramenta ESCREVE, por isso recusa
    // criar uma segunda associação em vez de só diagnosticar.
    const existentes = await prisma.fabricanteAlias.findMany({
      where: { aliasNome: aliasNormalizado },
      select: { id: true, fabricanteId: true, fabricante: { select: { nomeNormalizado: true } } },
    });
    const jaCorreto = existentes.find((e) => e.fabricanteId === fabricanteId);
    const conflito = existentes.find((e) => e.fabricanteId !== fabricanteId);

    if (conflito) {
      console.error(
        `✗ O alias "${aliasNormalizado}" já está associado a outro fabricante: "${conflito.fabricante.nomeNormalizado}" (${conflito.fabricanteId}). Recusado — nunca associa o mesmo alias a dois fabricantes.`,
      );
      process.exit(1);
    }

    if (jaCorreto) {
      console.log(`✓ Alias "${aliasNormalizado}" → "${fabricanteNome}" (${fabricanteId}) já estava correctamente registado — nada a fazer (idempotente).`);
      return;
    }

    console.log(`─ tenant=${values.tenant}: alias "${aliasNormalizado}" → "${fabricanteNome}" (${fabricanteId})`);
    if (!values.confirmar) {
      console.log("─ dry-run — nada foi escrito. Repete com --confirmar para aplicar.");
      return;
    }

    await prisma.fabricanteAlias.create({ data: { fabricanteId, aliasNome: aliasNormalizado } });
    const confirmacao = await prisma.fabricanteAlias.findFirst({ where: { fabricanteId, aliasNome: aliasNormalizado } });
    console.log(
      confirmacao
        ? `✓ Alias "${aliasNormalizado}" registado com sucesso → "${fabricanteNome}" (${fabricanteId}).`
        : `✗ A escrita não foi confirmada por uma leitura a seguir — reporta isto, não assumas sucesso.`,
    );
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

main().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : err);
  process.exit(1);
});
