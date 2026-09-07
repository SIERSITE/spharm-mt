/**
 * scripts/catalog/sincronizar-estado-classificacao.ts
 *
 * Põe `classificacaoEstado` de acordo com as colunas N1/N2.
 *
 * ── O que corrige, e o que NÃO corrige ───────────────────────────────
 *
 * CORRIGE apenas o enum. Nunca toca em `classificacaoNivel1Id`,
 * `classificacaoNivel2Id`, `validadoManualmente` nem em nada mais. Um
 * produto que tem classificação passa a dizer que tem; um que não tem
 * passa a dizer que não tem. A classificação em si fica exactamente como
 * está.
 *
 * ── Porque é preciso, e porque vai ser preciso outra vez ─────────────
 *
 * O backfill da migração `20260904120000` marcou `CANONICA` quem tinha
 * nível 1 À DATA EM QUE CORREU. Desde então, qualquer escrita de N1 por
 * um caminho que não seja `escreverClassificacao` deixa o enum para trás.
 * E há seis desses caminhos:
 *
 *     lib/catalog-persistence.ts            conectores / job diário
 *     lib/jobs/enrich-catalog.ts
 *     lib/catalog/global-catalog-store.ts   catalog:project-global
 *     scripts/catalog-master/fill-rules.ts
 *     scripts/copy-enriched-catalog-to-tenant.ts
 *     app/admin/catalogo/revisao/actions.ts validação manual
 *
 * Este comando é o penso, não a cura. Enquanto os seis não escreverem o
 * enum, vai continuar a haver casos novos — e é por isso que é
 * idempotente e feito para se correr as vezes que forem precisas, e não
 * uma vez só.
 *
 * ── A proveniência não é inventada ───────────────────────────────────
 *
 * Não há na base nada que diga qual dos seis caminhos escreveu. Onde a
 * origem já está preenchida, é respeitada; onde não está, fica
 * `ORIGEM_NAO_REGISTADA`, que é um facto e não um palpite.
 *
 * `classificacaoConfianca` e `classificacaoVersao` NÃO são preenchidas:
 * não se conhecem, e NULL é como se escreve "não se conhece".
 *
 * Uso:
 *   npm run catalog:sincronizar-estado -- --tenant=garantia
 *   npm run catalog:sincronizar-estado -- --tenant=garantia --apply
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";
import { buildTenantConnectionString, getTenantBySlug } from "../../lib/control-plane";
import { AlvoRecusado, descreverAlvo, resolverAlvo } from "../../lib/catalog/target-db";

/** Ver `OrigemClassificacao` em lib/catalog/escrita-classificacao.ts. */
const ORIGEM_NEUTRA = "ORIGEM_NAO_REGISTADA";

const nf = (n: number) => n.toLocaleString("pt-PT");
const pad = (n: number | string, w = 7) => String(nf(Number(n) || 0)).padStart(w);
const linha = (s = "") => console.log(s);

type Incoerente = {
  cnp: number;
  designacao: string;
  n1: string | null;
  n2: string | null;
  estado: string;
  origem: string | null;
  manual: boolean;
};

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");

  linha("SPharm.MT · sincronizar estado da classificacao · " + (apply ? "APPLY" : "DRY-RUN"));

  let alvo;
  try {
    alvo = await resolverAlvo(argv, { getTenantBySlug, buildTenantConnectionString });
  } catch (err) {
    if (err instanceof AlvoRecusado) {
      console.error(`\n${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }
  if (!alvo.tenant) {
    console.error("\nEste comando precisa de --tenant=<slug>.\n");
    process.exit(2);
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: alvo.url }) });
  if (!apply) {
    await prisma.$executeRawUnsafe("set session default_transaction_read_only = on");
  }

  linha("═".repeat(76));
  linha(`  ${descreverAlvo(alvo)}`);
  linha("  corrige SÓ o enum. N1/N2, validadoManualmente e tudo o resto: intocados.");
  linha("═".repeat(76));

  // ── O que está por sincronizar ────────────────────────────────────
  //
  // Dois sentidos, e são problemas diferentes:
  //   · tem N1 e o enum diz AUSENTE  → aparece por classificar e não está
  //   · não tem N1 e o enum diz outra coisa → o contrário
  //
  // O segundo é o mais perigoso dos dois — um produto contado como
  // classificado sem o estar — e por isso é medido mesmo quando é zero.
  const paraCanonica = await prisma.$queryRawUnsafe<Incoerente[]>(`
    select p.cnp, p.designacao,
           c1.nome as n1, c2.nome as n2,
           p."classificacaoEstado"::text as estado,
           p."classificacaoOrigem"       as origem,
           p."validadoManualmente"       as manual
      from "Produto" p
      left join "Classificacao" c1 on c1.id = p."classificacaoNivel1Id"
      left join "Classificacao" c2 on c2.id = p."classificacaoNivel2Id"
     where p."classificacaoNivel1Id" is not null
       and p."classificacaoEstado" = 'AUSENTE'
     order by p.cnp
  `);

  const paraAusente = await prisma.$queryRawUnsafe<Incoerente[]>(`
    select p.cnp, p.designacao,
           null::text as n1, null::text as n2,
           p."classificacaoEstado"::text as estado,
           p."classificacaoOrigem"       as origem,
           p."validadoManualmente"       as manual
      from "Produto" p
     where p."classificacaoNivel1Id" is null
       and p."classificacaoEstado" <> 'AUSENTE'
     order by p.cnp
  `);

  linha("");
  linha(`  tem N1, enum diz AUSENTE ......... ${pad(paraCanonica.length)}  → CANONICA`);
  linha(`  sem N1, enum diz classificado .... ${pad(paraAusente.length)}  → AUSENTE`);
  const semOrigem = paraCanonica.filter((r) => !r.origem).length;
  linha(`  …dos primeiros, sem origem ....... ${pad(semOrigem)}  → ${ORIGEM_NEUTRA}`);

  if (paraCanonica.length === 0 && paraAusente.length === 0) {
    linha("");
    linha("  Nada a fazer: o enum e as colunas já contam a mesma história.");
    await prisma.$disconnect();
    return;
  }

  const amostra = [...paraCanonica, ...paraAusente].slice(0, 20);
  if (amostra.length > 0) {
    linha("");
    linha("  ── amostra ────────────────────────────────────────────────");
    for (const r of amostra) {
      linha(
        `  ${String(r.cnp).padEnd(9)} ${r.designacao.slice(0, 34).padEnd(34)} ` +
          `${`${r.n1 ?? "—"} > ${r.n2 ?? "—"}`.slice(0, 30).padEnd(30)} ` +
          `${r.estado}${r.manual ? " · MANUAL" : ""}${r.origem ? ` · ${r.origem}` : ""}`,
      );
    }
    if (paraCanonica.length + paraAusente.length > 20) {
      linha(`  (mais ${nf(paraCanonica.length + paraAusente.length - 20)})`);
    }
  }

  if (!apply) {
    linha("");
    linha("  DRY-RUN: nada foi escrito. Para aplicar, acrescentar --apply.");
    await prisma.$disconnect();
    return;
  }

  // ── A escrita ─────────────────────────────────────────────────────
  //
  // `coalesce` na origem: onde já há proveniência, é respeitada. O valor
  // neutro só preenche o vazio — reescrevê-la seria apagar informação
  // verdadeira e substituí-la por "não sei".
  const n1 = await prisma.$executeRawUnsafe(
    `update "Produto"
        set "classificacaoEstado" = 'CANONICA',
            "classificacaoOrigem" = coalesce("classificacaoOrigem", $1),
            "dataAtualizacao"     = now()
      where "classificacaoNivel1Id" is not null
        and "classificacaoEstado" = 'AUSENTE'`,
    ORIGEM_NEUTRA,
  );

  const n2 = await prisma.$executeRawUnsafe(
    `update "Produto"
        set "classificacaoEstado" = 'AUSENTE',
            "dataAtualizacao"     = now()
      where "classificacaoNivel1Id" is null
        and "classificacaoEstado" <> 'AUSENTE'`,
  );

  linha("");
  linha(`  ${pad(Number(n1))}  corrigidos para CANONICA`);
  linha(`  ${pad(Number(n2))}  corrigidos para AUSENTE`);
  linha("");
  linha("  Rollback: não é preciso journal. A regra é derivável das colunas —");
  linha("  correr de novo em dry-run devolve zero, e é essa a verificação.");

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
