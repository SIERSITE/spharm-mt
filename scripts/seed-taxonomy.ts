/**
 * scripts/seed-taxonomy.ts
 *
 * Materializa a taxonomia canónica em `Classificacao`, na base de um
 * tenant.
 *
 * ── Porque é que isto foi reescrito ──────────────────────────────────
 * A versão anterior importava `legacyPrisma`: o destino estava fixado no
 * import, e nenhum argumento o mudava. Correu, disse que tinha semeado
 * 26 níveis 1, e semeou-os na base legacy. O tenant ficou com a tabela
 * vazia, e o sintoma só apareceu três fases à frente:
 *
 *   fill-rules --tenant=silveira --dry-run
 *   taxonomia: 0 nível 1, 0 nível 2
 *
 * Um script de seed que não deixa escolher a base não é um script com uma
 * omissão infeliz — é um script que só serve uma base. Passa a usar
 * `lib/catalog/target-db.ts`, como o resto do bootstrap do catálogo.
 *
 * ── Política de escrita ──────────────────────────────────────────────
 *  1. Dry-run é o default. Escrever exige `--apply`.
 *  2. Só cria o que falta. Nunca apaga, nunca renomeia, nunca desactiva.
 *  3. Materializa EXACTAMENTE `CANONICAL_TAXONOMY`. Uma classificação que
 *     exista na base e não conste da taxonomia é reportada e deixada em
 *     paz: pode ser de uma versão anterior ou criada pelo admin, e em
 *     nenhum dos casos é a este script que compete decidir.
 *  4. Uma classificação canónica que exista com estado != ATIVO é
 *     reportada, não reactivada. O mapper só lê ATIVO, portanto isso é um
 *     problema real — mas reactivar é desfazer uma decisão de alguém.
 *
 * Uso:
 *   npm run catalog:seed-taxonomy -- --tenant=silveira            # dry-run
 *   npm run catalog:seed-taxonomy -- --tenant=silveira --apply
 *   npx tsx scripts/seed-taxonomy.ts --db=<base> --apply          # dev
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { CANONICAL_TAXONOMY } from "../lib/catalog-taxonomy";
import { AlvoRecusado, descreverAlvo, resolverAlvo } from "../lib/catalog/target-db";
import { buildTenantConnectionString, getTenantBySlug } from "../lib/control-plane";

type Linha = {
  id: string;
  nome: string;
  tipo: string;
  pai: string | null;
  estado: string;
};

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const dryRun = !apply;

  // O destino é resolvido, não construído: nada aqui troca o nome da base
  // no DATABASE_URL, e não há base por omissão.
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

  const db = new pg.Client({ connectionString: alvo.url });
  await db.connect();
  // Sem `--apply` a sessão fica read-only na própria base — o código já
  // não escreve, e isto é a tranca do lado do Postgres. Com `--apply`
  // repõe-se `off`, porque um pooler pode ter deixado `on` colado à
  // ligação por causa de outro processo.
  await db.query(`set session default_transaction_read_only = ${dryRun ? "on" : "off"}`);

  const sep = "─".repeat(66);
  console.log(sep);
  console.log(`${descreverAlvo(alvo)}${dryRun ? "   (dry-run — nada é escrito)" : ""}`);
  console.log(`Taxonomia canónica: ${CANONICAL_TAXONOMY.length} níveis 1, ` +
    `${CANONICAL_TAXONOMY.reduce((s, c) => s + c.nivel2.length, 0)} níveis 2`);
  console.log(sep);

  // Uma leitura só. O estado inteiro cabe em memória — são dezenas de
  // linhas — e assim a decisão de cada nome é tomada contra o mesmo
  // retrato, sem uma consulta por nome.
  const { rows: existentes } = await db.query<Linha>(
    `select id, nome, tipo, "classificacaoPaiId" as pai, estado::text as estado
       from "Classificacao"`,
  );

  const n1PorNome = new Map<string, Linha>();
  const n2PorChave = new Map<string, Linha>();
  for (const r of existentes) {
    if (r.tipo === "NIVEL_1" && !r.pai) n1PorNome.set(r.nome, r);
  }
  for (const r of existentes) {
    if (r.tipo === "NIVEL_2" && r.pai) n2PorChave.set(`${r.pai}::${r.nome}`, r);
  }

  const inativas: string[] = [];
  let n1Criados = 0;
  let n2Criados = 0;
  let n1Existentes = 0;
  let n2Existentes = 0;

  const criar = async (nome: string, tipo: "NIVEL_1" | "NIVEL_2", pai: string | null): Promise<string> => {
    const id = randomUUID();
    // `id` e `dataAtualizacao` não têm default na base — o Prisma
    // preenche-os do lado do cliente, e aqui o cliente somos nós.
    //
    // `where not exists` e não `on conflict`: o índice único inclui
    // `classificacaoPaiId`, que é NULL nos níveis 1, e em Postgres dois
    // NULL são distintos — um `on conflict` não impediria um segundo
    // "MEDICAMENTOS". Isto impede.
    await db.query(
      `insert into "Classificacao" (id, nome, tipo, "classificacaoPaiId", estado, "dataAtualizacao")
       select $1, $2, $3::"TipoClassificacao", $4, 'ATIVO', now()
        where not exists (
              select 1 from "Classificacao" c
               where c.nome = $2 and c.tipo = $3::"TipoClassificacao"
                 and c."classificacaoPaiId" is not distinct from $4
        )`,
      [id, nome, tipo, pai],
    );
    return id;
  };

  for (const cat of CANONICAL_TAXONOMY) {
    const jaN1 = n1PorNome.get(cat.nivel1);
    let paiId: string | null = jaN1?.id ?? null;
    let marcaN1 = "·";

    if (jaN1) {
      n1Existentes++;
      if (jaN1.estado !== "ATIVO") inativas.push(`${cat.nivel1}  (nível 1, estado ${jaN1.estado})`);
    } else {
      n1Criados++;
      marcaN1 = "+";
      if (apply) paiId = await criar(cat.nivel1, "NIVEL_1", null);
    }

    let novosSubs = 0;
    for (const sub of cat.nivel2) {
      // Em dry-run sem pai criado não há chave para procurar — e a
      // resposta certa é que TODOS os filhos faltam, não que nenhum
      // falta. A versão anterior devolvia zero aqui, e o relatório de
      // dry-run dizia que não havia nada a fazer.
      const ja = paiId ? n2PorChave.get(`${paiId}::${sub}`) : undefined;
      if (ja) {
        n2Existentes++;
        if (ja.estado !== "ATIVO") inativas.push(`${cat.nivel1} > ${sub}  (nível 2, estado ${ja.estado})`);
        continue;
      }
      n2Criados++;
      novosSubs++;
      if (apply && paiId) await criar(sub, "NIVEL_2", paiId);
    }

    const detalhe = novosSubs > 0 ? `${novosSubs} de ${cat.nivel2.length} em falta` : `${cat.nivel2.length} ok`;
    console.log(`  ${marcaN1} ${cat.nivel1.padEnd(34)} ${detalhe}`);
  }

  // ── Fora da taxonomia: reportado, nunca tocado ──────────────────────
  const canonN1 = new Set(CANONICAL_TAXONOMY.map((c) => c.nivel1));
  const canonN2 = new Set<string>();
  for (const c of CANONICAL_TAXONOMY) {
    const id = n1PorNome.get(c.nivel1)?.id;
    if (id) for (const s of c.nivel2) canonN2.add(`${id}::${s}`);
  }
  const extra: string[] = [];
  for (const [nome, r] of n1PorNome) if (!canonN1.has(nome)) extra.push(`${nome}  (nível 1, ${r.estado})`);
  for (const [chave, r] of n2PorChave) {
    if (canonN2.has(chave)) continue;
    const pai = existentes.find((e) => e.id === r.pai);
    extra.push(`${pai?.nome ?? "?"} > ${r.nome}  (nível 2, ${r.estado})`);
  }

  console.log(`\n${sep}`);
  console.log("RESUMO");
  console.log(sep);
  const verbo = apply ? "criados" : "em falta";
  console.log(`  nível 1:  ${String(n1Existentes).padStart(4)} já existiam · ${String(n1Criados).padStart(4)} ${verbo}`);
  console.log(`  nível 2:  ${String(n2Existentes).padStart(4)} já existiam · ${String(n2Criados).padStart(4)} ${verbo}`);

  if (inativas.length) {
    console.log(`\n  ⚠ ${inativas.length} classificação(ões) canónica(s) com estado != ATIVO.`);
    console.log("    O mapper só lê ATIVO, portanto estas não são usadas — mas reactivar");
    console.log("    seria desfazer uma decisão de alguém, e não é deste script.");
    for (const i of inativas.slice(0, 20)) console.log(`      ${i}`);
    if (inativas.length > 20) console.log(`      … e mais ${inativas.length - 20}`);
  }

  if (extra.length) {
    console.log(`\n  ${extra.length} classificação(ões) na base fora da taxonomia canónica.`);
    console.log("    Preservadas. Podem ser de uma versão anterior ou criadas pelo admin.");
    for (const e of extra.slice(0, 20)) console.log(`      ${e}`);
    if (extra.length > 20) console.log(`      … e mais ${extra.length - 20}`);
  }

  if (dryRun && (n1Criados > 0 || n2Criados > 0)) {
    console.log(`\n  dry-run — nada foi escrito. Para aplicar: --apply`);
  }
  console.log(sep);

  await db.end();
}

main().catch(async (err) => {
  console.error("\n[erro fatal]", err);
  process.exit(1);
});
