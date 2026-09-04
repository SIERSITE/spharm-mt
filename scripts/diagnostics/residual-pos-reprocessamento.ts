/**
 * scripts/diagnostics/residual-pos-reprocessamento.ts
 *
 * O que resta REALMENTE por classificar depois de escritas as 2 071
 * provisórias — e porquê, produto a produto.
 *
 * READ-ONLY sem excepção: abre a sessão PostgreSQL em read-only, não tem
 * `--apply`, não chama o modelo, não toca na cache nem na fila.
 *
 * ── A pergunta que isto responde ─────────────────────────────────────
 *
 * O ecrã do Inventário mostra 3 097 linhas com "Por Classificar" e o
 * filtro "sem classificação canónica" ligado. Duas coisas se confundem aí:
 *
 *   · o Inventário conta ARTIGO/FARMÁCIA — um CNP em três farmácias são
 *     três linhas. 3 097 linhas não são 3 097 produtos.
 *   · o filtro é `classificacaoNivel1Id IS NULL`, e NÃO exclui códigos
 *     internos do ERP. O KPI do catálogo exclui-os; este não.
 *
 * As duas diferenças juntas explicam por que 3 097 não bate com nenhum
 * número do catálogo. A PARTE 2 mede-as em vez de as estimar.
 *
 * ── O que NÃO é ──────────────────────────────────────────────────────
 *
 * Não é uma auditoria da taxonomia nem uma proposta de alteração. É uma
 * contagem, com uma causa única por produto, para se poder decidir o que
 * fazer a seguir com números em vez de impressões.
 *
 * Uso:
 *   npx tsx scripts/diagnostics/residual-pos-reprocessamento.ts --tenant=silveira
 *   …                                                          --cnps=6019224,1161127
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";
import { buildTenantConnectionString, getTenantBySlug } from "../../lib/control-plane";
import { AlvoRecusado, descreverAlvo, resolverAlvo } from "../../lib/catalog/target-db";
import { MIN_CNP_CATALOGAVEL } from "../../lib/catalog/cnp-catalogavel";
import { LIMIAR_PERSISTENCIA } from "../../lib/catalog/knowledge-enrichment";
import { contradicaoForte, ehBalde } from "../../lib/catalog/classificacao-coerencia";

/** Os CNP da imagem do Inventário, quando não vierem por `--cnps`. */
const CNPS_OMISSAO = [
  6019224, 1161127, 7300053, 7300012, 6936617, 6032359, 7391409,
  7749036, 7747626, 7733055, 7745307, 7700161, 7732198, 6813733,
];

const nf = (n: number) => n.toLocaleString("pt-PT");
const pad = (n: number | string, w = 7) => String(nf(Number(n) || 0)).padStart(w);
const padT = (s: string, w: number) => s.padEnd(w).slice(0, w);
const linha = (s = "") => console.log(s);
const titulo = (t: string) => {
  linha("");
  linha("═".repeat(78));
  linha(`  ${t}`);
  linha("═".repeat(78));
};

function pct(n: number, total: number): string {
  return total > 0 ? `${((n / total) * 100).toFixed(1)}%`.padStart(6) : "     —";
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (n: string) => argv.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=");

  const cnpsPedidos = (arg("cnps") ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  const CNPS = cnpsPedidos.length > 0 ? cnpsPedidos : CNPS_OMISSAO;

  // A linha de identidade sai ANTES de resolver o destino: e o que
  // permite distinguir "o diagnostico correu e recusou-se" de "o
  // ficheiro nem chegou a arrancar". O teste-guarda depende dela.
  linha("SPharm.MT · residual pos-reprocessamento · diagnostico read-only");

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
    console.error("\nEste diagnóstico precisa de --tenant=<slug>.\n");
    process.exit(2);
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: alvo.url }) });
  // Não é decorativo: garante que um bug neste ficheiro não consegue
  // escrever, mesmo que tente.
  await prisma.$executeRawUnsafe("set session default_transaction_read_only = on");

  linha("═".repeat(78));
  linha(`  ${descreverAlvo(alvo)}`);
  linha(`  residual pós-reprocessamento · READ-ONLY · limiar do gate ${LIMIAR_PERSISTENCIA}`);
  linha(`  fronteira do catálogo: cnp > ${nf(MIN_CNP_CATALOGAVEL)}`);
  linha("═".repeat(78));

  // ══════════════════════════════════════════════════════════════════
  // PARTE 1 · Estado do catálogo, POR PRODUTO
  //
  // Uma query, agregação condicional. A unidade é o Produto (um por CNP,
  // `cnp @unique`), nunca a ProdutoFarmacia — é a distinção que o número
  // do Inventário apaga.
  // ══════════════════════════════════════════════════════════════════
  titulo("PARTE 1 · Catálogo da farmácia, por PRODUTO (CNP)");

  const [c] = await prisma.$queryRawUnsafe<Array<Record<string, bigint>>>(`
    select
      count(*)                                                          as "totalAtivos",
      count(*) filter (where p.cnp >  ${MIN_CNP_CATALOGAVEL})           as "catalogaveis",
      count(*) filter (where p.cnp <= ${MIN_CNP_CATALOGAVEL})           as "internos",
      -- Estado, só entre os catalogáveis. MANUAL ganha ao enum, tal como
      -- em origemClassificacao() — senão um produto validado por uma
      -- pessoa aparecia em duas linhas desta tabela.
      count(*) filter (where p.cnp > ${MIN_CNP_CATALOGAVEL}
                         and p."validadoManualmente" = true)            as "manual",
      count(*) filter (where p.cnp > ${MIN_CNP_CATALOGAVEL}
                         and p."validadoManualmente" = false
                         and p."classificacaoEstado" = 'CANONICA')      as "canonica",
      count(*) filter (where p.cnp > ${MIN_CNP_CATALOGAVEL}
                         and p."validadoManualmente" = false
                         and p."classificacaoEstado" = 'PROVISORIA')    as "provisoria",
      count(*) filter (where p.cnp > ${MIN_CNP_CATALOGAVEL}
                         and p."validadoManualmente" = false
                         and p."classificacaoEstado" = 'AUSENTE')       as "ausente",
      -- Os dois níveis em separado: um produto pode ter N1 e não ter N2.
      count(*) filter (where p.cnp > ${MIN_CNP_CATALOGAVEL}
                         and p."classificacaoNivel1Id" is null)         as "n1Null",
      count(*) filter (where p.cnp > ${MIN_CNP_CATALOGAVEL}
                         and p."classificacaoNivel2Id" is null)         as "n2Null",
      count(*) filter (where p.cnp > ${MIN_CNP_CATALOGAVEL}
                         and c2.nome ilike 'Outros %')                  as "balde",
      count(*) filter (where p.cnp <= ${MIN_CNP_CATALOGAVEL}
                         and p."classificacaoNivel1Id" is null)         as "internosSemN1",
      -- Coerência: o enum e as colunas têm de contar a mesma história.
      count(*) filter (where p.cnp > ${MIN_CNP_CATALOGAVEL}
                         and p."classificacaoEstado" <> 'AUSENTE'
                         and p."classificacaoNivel1Id" is null)         as "incoerenteA",
      count(*) filter (where p.cnp > ${MIN_CNP_CATALOGAVEL}
                         and p."classificacaoEstado" = 'AUSENTE'
                         and p."classificacaoNivel1Id" is not null)     as "incoerenteB"
      from "Produto" p
      left join "Classificacao" c2 on c2.id = p."classificacaoNivel2Id"
     where p.estado <> 'INATIVO'
  `);
  const n = (k: string) => Number(c?.[k] ?? 0);
  const cat = n("catalogaveis");

  linha("");
  linha(`  Produto activos (todos) ................. ${pad(n("totalAtivos"))}`);
  linha(`    catalogáveis .......................... ${pad(cat)}`);
  linha(`    códigos internos (fora do âmbito) ..... ${pad(n("internos"))}   dos quais sem N1: ${nf(n("internosSemN1"))}`);
  linha("");
  linha("  ── proveniência, entre os catalogáveis ──────────────────────");
  linha(`    MANUAL (validadoManualmente) .......... ${pad(n("manual"))}  ${pct(n("manual"), cat)}`);
  linha(`    CANONICA .............................. ${pad(n("canonica"))}  ${pct(n("canonica"), cat)}`);
  linha(`    PROVISORIA ............................ ${pad(n("provisoria"))}  ${pct(n("provisoria"), cat)}`);
  linha(`    AUSENTE ............................... ${pad(n("ausente"))}  ${pct(n("ausente"), cat)}`);
  linha("");
  linha("  ── colunas de classificação ─────────────────────────────────");
  linha(`    sem nível 1 ........................... ${pad(n("n1Null"))}  ${pct(n("n1Null"), cat)}`);
  linha(`    sem nível 2 ........................... ${pad(n("n2Null"))}  ${pct(n("n2Null"), cat)}`);
  linha(`    em "Outros X" (tem N1, N2 é balde) .... ${pad(n("balde"))}  ${pct(n("balde"), cat)}`);
  linha("");
  const inc = n("incoerenteA") + n("incoerenteB");
  linha(`  coerência enum ↔ colunas .............. ${inc === 0 ? "✓ bate certo" : "!! " + nf(inc) + " INCOERENTES"}`);
  if (inc > 0) {
    linha(`      estado <> AUSENTE mas N1 null ....... ${pad(n("incoerenteA"))}`);
    linha(`      estado = AUSENTE mas N1 preenchido .. ${pad(n("incoerenteB"))}`);
    linha(`      (o segundo caso são classificações escritas por caminhos`);
    linha(`       anteriores a esta revisão — o backfill só marcou quem tinha N1`);
    linha(`       à data da migração.)`);
  }

  // ══════════════════════════════════════════════════════════════════
  // PARTE 2 · Os 3 097 do Inventário
  //
  // A MESMA consulta do relatório: `ProdutoFarmacia` com
  // `flagRetirado = false`, cruzada com o filtro `apenasSemClassif`
  // (`classificacaoNivel1Id is null and estado <> 'INATIVO'`).
  //
  // Reproduzida e não aproximada: um número parecido obtido por outro
  // caminho não prova nada sobre o ecrã que se está a explicar.
  // ══════════════════════════════════════════════════════════════════
  titulo("PARTE 2 · As linhas do Inventário, decompostas");

  const [inv] = await prisma.$queryRawUnsafe<Array<Record<string, bigint>>>(`
    select count(*)                              as linhas,
           count(distinct p.cnp)                 as cnps,
           count(distinct pf."produtoId")        as produtos,
           count(distinct pf."farmaciaId")       as farmacias,
           count(*) filter (where p.cnp <= ${MIN_CNP_CATALOGAVEL}) as "linhasInternas",
           count(distinct p.cnp) filter (where p.cnp <= ${MIN_CNP_CATALOGAVEL}) as "cnpsInternos"
      from "ProdutoFarmacia" pf
      join "Produto" p on p.id = pf."produtoId"
     where pf."flagRetirado" = false
       and p."classificacaoNivel1Id" is null
       and p.estado <> 'INATIVO'
  `);
  const iv = (k: string) => Number(inv?.[k] ?? 0);

  linha("");
  linha(`  linhas artigo/farmácia .................. ${pad(iv("linhas"))}   ← o número do ecrã`);
  linha(`  CNP distintos .......................... ${pad(iv("cnps"))}`);
  linha(`  produtos distintos ..................... ${pad(iv("produtos"))}`);
  linha(`  farmácias envolvidas ................... ${pad(iv("farmacias"))}`);
  linha("");
  linha(`  destas linhas, de códigos INTERNOS ..... ${pad(iv("linhasInternas"))}  ${pct(iv("linhasInternas"), iv("linhas"))}`);
  linha(`  …e em CNP distintos .................... ${pad(iv("cnpsInternos"))}`);
  linha("");
  const catSemN1 = iv("cnps") - iv("cnpsInternos");
  linha(`  ⇒ produtos de CATÁLOGO por classificar .. ${pad(catSemN1)}`);
  linha(`     (é este o número comparável com o KPI do catálogo;`);
  linha(`      os ${nf(iv("linhas"))} do ecrã são linhas, e incluem os internos)`);
  const mult = iv("cnps") > 0 ? iv("linhas") / iv("cnps") : 0;
  linha("");
  linha(`  multiplicador médio linhas/CNP ......... ${mult.toFixed(2)}`);

  const porFarmacia = await prisma.$queryRawUnsafe<Array<{ nome: string; linhas: bigint; internos: bigint }>>(`
    select f.nome,
           count(*)                                                  as linhas,
           count(*) filter (where p.cnp <= ${MIN_CNP_CATALOGAVEL})   as internos
      from "ProdutoFarmacia" pf
      join "Produto" p  on p.id = pf."produtoId"
      join "Farmacia" f on f.id = pf."farmaciaId"
     where pf."flagRetirado" = false
       and p."classificacaoNivel1Id" is null
       and p.estado <> 'INATIVO'
     group by f.nome
     order by 2 desc
  `);
  linha("");
  linha("  ── por farmácia ─────────────────────────────────────────────");
  linha(`  ${padT("farmácia", 34)} ${"linhas".padStart(9)} ${"internos".padStart(9)}`);
  for (const r of porFarmacia) {
    linha(`  ${padT(r.nome, 34)} ${pad(Number(r.linhas), 9)} ${pad(Number(r.internos), 9)}`);
  }

  // ══════════════════════════════════════════════════════════════════
  // PARTE 3 · Porque continuam AUSENTE — uma causa por produto
  //
  // A causa é atribuída por PRECEDÊNCIA, e a ordem é a de "o que teria de
  // mudar primeiro para este produto ser classificável":
  //
  //   A  não há resposta nenhuma          (nunca foi perguntado)
  //   B  a resposta foi "não sei"
  //   C  a resposta não coube na taxonomia
  //   F  a resposta era ela própria um balde
  //   E  a resposta não chega ao limiar
  //   D  a resposta é clínica e não há verificação reconstruível
  //   G  a resposta é uma dedução travada por outro critério
  //   I  nenhuma das anteriores
  //
  // E > D de propósito: abaixo do limiar o produto falha de qualquer
  // maneira, e a restrição clínica seria uma segunda razão para o mesmo
  // desfecho, não a razão principal.
  //
  // `FilaRevisao` NÃO é uma causa — é um DESTINO. Um produto travado pela
  // clínica está na fila E é clínico; contá-lo como "H" apagaria a razão
  // por que lá foi parar. Aparece como coluna cruzada, sem dupla
  // contagem.
  // ══════════════════════════════════════════════════════════════════
  titulo("PARTE 3 · Porque continuam por classificar");

  type Lr = {
    cnp: number;
    designacao: string;
    productType: string | null;
    validadoManualmente: boolean;
    temCache: boolean;
    evidenceType: string | null;
    categoria: string | null;
    subcategoria: string | null;
    categoriaBruta: string | null;
    subcategoriaBruta: string | null;
    confidence: number | null;
    motivo: string | null;
    reavaliadoVersao: string | null;
    naFila: boolean;
  };

  const residual = await prisma.$queryRawUnsafe<Lr[]>(`
    select p.cnp,
           p.designacao,
           p."productType"                       as "productType",
           p."validadoManualmente"               as "validadoManualmente",
           (k.chave is not null)                 as "temCache",
           k."evidenceType"                      as "evidenceType",
           k.categoria,
           k.subcategoria,
           k."categoriaBruta"                    as "categoriaBruta",
           k."subcategoriaBruta"                 as "subcategoriaBruta",
           k.confidence,
           k.motivo,
           k."reavaliadoVersao"                  as "reavaliadoVersao",
           exists (select 1 from "FilaRevisao" fr
                    where fr."produtoId" = p.id and fr.estado = 'PENDENTE') as "naFila"
      from "Produto" p
      left join lateral (
        select * from "KnowledgeEnrichmentCache" kk
         where kk.cnp = p.cnp order by kk."criadoEm" desc limit 1
      ) k on true
     where p.estado <> 'INATIVO'
       and p.cnp > ${MIN_CNP_CATALOGAVEL}
       and p."classificacaoNivel1Id" is null
  `);

  const CAUSAS = [
    ["A", "sem KnowledgeEnrichmentCache — nunca foi perguntado"],
    ["B", "cache DESCONHECIDO — o modelo não reconheceu"],
    ["C", "par fora da taxonomia — respondeu, não coube"],
    ["F", "proposta é ela própria um balde (Outros X)"],
    ["E", `confiança < ${LIMIAR_PERSISTENCIA}`],
    ["D", "clínica — verificação não reconstruível da cache"],
    ["G", "dedução travada por outro critério (contradição de tipo)"],
    ["I", "outro — investigar"],
  ] as const;

  const conta = new Map<string, number>(CAUSAS.map(([k]) => [k, 0]));
  const naFilaPorCausa = new Map<string, number>(CAUSAS.map(([k]) => [k, 0]));
  const naoReavaliados = new Map<string, number>(CAUSAS.map(([k]) => [k, 0]));
  const exemplos = new Map<string, Lr[]>(CAUSAS.map(([k]) => [k, []]));
  let manualSemN1 = 0;

  const causaDe = (r: Lr): string => {
    if (!r.temCache) return "A";
    if (r.evidenceType === "DESCONHECIDO") return "B";
    // Sem par válido: ou não propôs nada, ou propôs algo que a taxonomia
    // não tem. `categoriaBruta` distingue os dois — e só existe para as
    // linhas escritas depois de 80677cc.
    if (!r.categoria || !r.subcategoria) return "C";
    if (ehBalde(r.subcategoria)) return "F";
    if ((r.confidence ?? 0) < LIMIAR_PERSISTENCIA) return "E";
    if (r.categoria.toUpperCase() === "MEDICAMENTOS") return "D";
    if (contradicaoForte(r.productType, r.categoria)) return "G";
    return "I";
  };

  for (const r of residual) {
    if (r.validadoManualmente) manualSemN1++;
    const k = causaDe(r);
    conta.set(k, (conta.get(k) ?? 0) + 1);
    if (r.naFila) naFilaPorCausa.set(k, (naFilaPorCausa.get(k) ?? 0) + 1);
    if (!r.reavaliadoVersao) naoReavaliados.set(k, (naoReavaliados.get(k) ?? 0) + 1);
    const ex = exemplos.get(k)!;
    if (ex.length < 5) ex.push(r);
  }

  const total = residual.length;
  linha("");
  linha(`  produtos CATALOGÁVEIS sem nível 1 ...... ${pad(total)}`);
  linha(`  (destes, validados manualmente ......... ${pad(manualSemN1)} — caso raro, a investigar se > 0)`);
  linha("");
  linha(`  ${padT("causa principal", 56)} ${"nº".padStart(7)} ${"%".padStart(6)} ${"na fila".padStart(8)} ${"s/reav.".padStart(8)}`);
  linha(`  ${"─".repeat(88)}`);
  let soma = 0;
  for (const [k, desc] of CAUSAS) {
    const v = conta.get(k) ?? 0;
    soma += v;
    linha(
      `  ${k}  ${padT(desc, 53)} ${pad(v)} ${pct(v, total)} ${pad(naFilaPorCausa.get(k) ?? 0, 8)} ${pad(naoReavaliados.get(k) ?? 0, 8)}`,
    );
  }
  linha(`  ${"─".repeat(88)}`);
  linha(`  ${padT("TOTAL", 56)} ${pad(soma)} ${pct(soma, total)}`);
  linha(
    `  soma bate com o universo: ${soma === total ? "✓ sim" : `!! NÃO (${nf(soma)} ≠ ${nf(total)}) — investigar`}`,
  );
  linha("");
  linha("  «na fila» = tem entrada PENDENTE em FilaRevisao. Não é uma causa —");
  linha("  é o destino, e cruza-se com a causa em vez de a substituir.");
  linha("  «s/reav.» = o reprocessamento nunca chegou a esta linha de cache.");

  linha("");
  linha("  ── exemplos, até 5 por causa ────────────────────────────────");
  for (const [k, desc] of CAUSAS) {
    const ex = exemplos.get(k) ?? [];
    if (ex.length === 0) continue;
    linha("");
    linha(`  ${k} · ${desc}`);
    for (const r of ex) {
      const prop = r.categoria
        ? `${r.categoria} > ${r.subcategoria}`
        : r.categoriaBruta
        ? `(bruto: ${r.categoriaBruta} > ${r.subcategoriaBruta})`
        : "(nenhuma)";
      linha(
        `      ${String(r.cnp).padEnd(9)} ${padT(r.designacao, 34)} ${padT(r.evidenceType ?? "—", 21)} ` +
          `${(r.confidence ?? 0).toFixed(2)}  ${prop}`,
      );
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // PARTE 4 · Os CNP da imagem, um a um
  // ══════════════════════════════════════════════════════════════════
  titulo("PARTE 4 · Os CNP indicados, em detalhe");

  type Det = Lr & {
    n1: string | null;
    n2: string | null;
    estadoClass: string | null;
    origem: string | null;
    confiancaClass: number | null;
    versaoClass: string | null;
    existe: boolean;
    farmacias: number;
    rationale: string | null;
  };

  const det = await prisma.$queryRawUnsafe<Det[]>(
    `
    select p.cnp,
           p.designacao,
           p."productType"                        as "productType",
           p."validadoManualmente"                as "validadoManualmente",
           c1.nome                                as n1,
           c2.nome                                as n2,
           p."classificacaoEstado"::text          as "estadoClass",
           p."classificacaoOrigem"                as origem,
           p."classificacaoConfianca"             as "confiancaClass",
           p."classificacaoVersao"                as "versaoClass",
           true                                   as existe,
           (select count(*) from "ProdutoFarmacia" pf
             where pf."produtoId" = p.id and pf."flagRetirado" = false)::int as farmacias,
           (k.chave is not null)                  as "temCache",
           k."evidenceType"                       as "evidenceType",
           k.categoria, k.subcategoria,
           k."categoriaBruta"                     as "categoriaBruta",
           k."subcategoriaBruta"                  as "subcategoriaBruta",
           k.confidence, k.motivo, k.rationale,
           k."reavaliadoVersao"                   as "reavaliadoVersao",
           exists (select 1 from "FilaRevisao" fr
                    where fr."produtoId" = p.id and fr.estado = 'PENDENTE') as "naFila"
      from "Produto" p
      left join "Classificacao" c1 on c1.id = p."classificacaoNivel1Id"
      left join "Classificacao" c2 on c2.id = p."classificacaoNivel2Id"
      left join lateral (
        select * from "KnowledgeEnrichmentCache" kk
         where kk.cnp = p.cnp order by kk."criadoEm" desc limit 1
      ) k on true
     where p.cnp = any($1::int[])
    `,
    CNPS,
  );
  const porCnp = new Map(det.map((d) => [Number(d.cnp), d]));

  for (const cnp of CNPS) {
    const d = porCnp.get(cnp);
    linha("");
    linha(`  ┌─ ${cnp} ${"─".repeat(66 - String(cnp).length)}`);
    if (!d) {
      linha(`  │  NÃO EXISTE nesta base.`);
      linha(`  └${"─".repeat(70)}`);
      continue;
    }
    const interno = Number(d.cnp) <= MIN_CNP_CATALOGAVEL;
    linha(`  │  ${d.designacao}`);
    linha(`  │  âmbito ......... ${interno ? "CÓDIGO INTERNO do ERP — fora do catálogo" : "catalogável"}`);
    linha(`  │  presente em .... ${d.farmacias} farmácia(s) não-retiradas`);
    linha(
      `  │  estado ......... ${d.validadoManualmente ? "MANUAL (validadoManualmente)" : d.estadoClass ?? "—"}` +
        `${d.origem ? `  ·  origem ${d.origem}` : ""}`,
    );
    linha(`  │  N1 / N2 ....... ${d.n1 ?? "—"} / ${d.n2 ?? "—"}`);
    if (d.confiancaClass !== null || d.versaoClass) {
      linha(`  │  conf./versão ... ${d.confiancaClass ?? "—"} / ${d.versaoClass ?? "—"}`);
    }
    linha(`  │  cache ......... ${d.temCache ? "sim" : "NÃO — nunca foi perguntado"}`);
    if (d.temCache) {
      linha(`  │    evidência ... ${d.evidenceType ?? "—"}   confiança ${(d.confidence ?? 0).toFixed(2)}`);
      linha(
        `  │    proposta .... ${
          d.categoria ? `${d.categoria} > ${d.subcategoria}` : "(par não sobreviveu à validação)"
        }`,
      );
      if (!d.categoria && d.categoriaBruta) {
        linha(`  │    …em bruto ... ${d.categoriaBruta} > ${d.subcategoriaBruta}`);
      }
      linha(`  │    motivo ..... ${d.motivo ?? "—"}`);
      linha(`  │    reavaliada .. ${d.reavaliadoVersao ?? "NÃO — o reprocessamento não chegou aqui"}`);
      if (d.rationale) linha(`  │    modelo ..... "${d.rationale.slice(0, 120)}"`);
    }
    linha(`  │  FilaRevisao ... ${d.naFila ? "SIM, pendente" : "não"}`);
    // O veredicto é composto das linhas acima, e não de uma segunda
    // leitura — se discordasse delas, seria a linha errada a acreditar.
    const causa = d.n1
      ? `JÁ CLASSIFICADO (${d.estadoClass}) — não devia aparecer com o filtro ligado`
      : interno
      ? "código interno: nunca entra no enriquecimento, e não devia contar no KPI"
      : CAUSAS.find(([k]) => k === causaDe(d))?.[1] ?? "—";
    linha(`  │  ⇒ ${causa}`);
    linha(`  └${"─".repeat(70)}`);
  }

  await prisma.$disconnect();
  linha("");
  linha("Fim. Nada foi escrito: sessão read-only, sem --apply, sem chamadas ao modelo.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
