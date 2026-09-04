/**
 * scripts/diagnostics/reconciliar-provisorias.ts
 *
 * Escrevemos 2 071 provisórias. O catálogo mostra 1 638. Onde estão as 433?
 *
 * READ-ONLY sem excepção: sessão PostgreSQL em read-only, sem `--apply`,
 * sem chamadas ao modelo, sem tocar na cache nem na fila.
 *
 * ── Porque é que 433 desaparecerem NÃO é, à partida, um erro ─────────
 *
 * "PROVISORIA" no catálogo é contado como
 *
 *     validadoManualmente = false
 *       AND classificacaoEstado = 'PROVISORIA'
 *       AND estado <> 'INATIVO'
 *       AND cnp > MIN_CNP_CATALOGAVEL
 *
 * Um produto sai desta contagem por CINCO caminhos diferentes, e quatro
 * deles são o sistema a funcionar:
 *
 *   · alguém validou-o na fila de revisão   → passa a MANUAL
 *   · uma fonte melhor reclassificou-o      → passa a CANONICA
 *   · foi desactivado                       → sai do universo
 *   · deixou de existir                     → sai do universo
 *   · alguém escreveu N1/N2 por um caminho que NÃO actualiza o enum
 *
 * O último é o único que é defeito, e é o que mais interessa medir:
 * `escreverClassificacao` é o único escritor que mantém
 * `classificacaoEstado` em dia, mas há CINCO outros a escrever
 * `classificacaoNivel1Id` — `catalog-persistence`, `jobs/enrich-catalog`,
 * `global-catalog-store`, `fill-rules`, `copy-enriched-catalog` — e a
 * acção de revisão manual. Nenhum toca no enum.
 *
 * ── A lista autoritativa é o journal ────────────────────────────────
 *
 * `--journal=a.jsonl,b.jsonl` dá os CNP EXACTOS que foram escritos, com o
 * estado anterior de cada um. É a única forma de reconciliar sem
 * adivinhar: sem ele, um produto que tenha sido reclassificado é
 * indistinguível de um que nunca foi provisório.
 *
 * Sem journal o comando corre na mesma, em modo degradado, e usa
 * `classificacaoVersao = 'ke-2.1'` como aproximação — dizendo que o é.
 *
 * Uso:
 *   npx tsx scripts/diagnostics/reconciliar-provisorias.ts --tenant=silveira \
 *     --journal=/opt/spharmmt/journal/canario-200.jsonl,/opt/spharmmt/journal/restante.jsonl
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";
import { buildTenantConnectionString, getTenantBySlug } from "../../lib/control-plane";
import { AlvoRecusado, descreverAlvo, resolverAlvo } from "../../lib/catalog/target-db";
import { MIN_CNP_CATALOGAVEL } from "../../lib/catalog/cnp-catalogavel";
import { VERSAO_PROVISORIA } from "../../lib/catalog/knowledge-enrichment";

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

type EntradaJournal = { cnp: number; n2Antes: string | null; estadoAntes: string };

function lerJournais(caminhos: string[]): Map<number, EntradaJournal> {
  const m = new Map<number, EntradaJournal>();
  for (const c of caminhos) {
    const bruto = readFileSync(c, "utf8");
    let n = 0;
    for (const l of bruto.split(/\r?\n/)) {
      n++;
      const t = l.trim();
      if (!t) continue;
      let o: Partial<EntradaJournal>;
      try {
        o = JSON.parse(t) as Partial<EntradaJournal>;
      } catch {
        throw new Error(`${c}: linha ${n} não é JSON válido.`);
      }
      if (typeof o.cnp !== "number") throw new Error(`${c}: linha ${n} sem cnp.`);
      // O mesmo CNP nos dois ficheiros seria uma escrita repetida — fica a
      // PRIMEIRA, que é a que registou o estado verdadeiramente anterior.
      if (!m.has(o.cnp)) {
        m.set(o.cnp, {
          cnp: o.cnp,
          n2Antes: o.n2Antes ?? null,
          estadoAntes: o.estadoAntes ?? "?",
        });
      }
    }
  }
  return m;
}

type Estado = {
  cnp: number;
  designacao: string;
  existe: boolean;
  estadoProduto: string | null;
  classEstado: string | null;
  origem: string | null;
  versao: string | null;
  confianca: number | null;
  manual: boolean;
  n1: string | null;
  n2: string | null;
  interno: boolean;
};

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (n: string) => argv.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=");

  linha("SPharm.MT · reconciliacao das provisorias · diagnostico read-only");

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

  const caminhos = (arg("journal") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const journal = caminhos.length > 0 ? lerJournais(caminhos) : null;

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: alvo.url }) });
  await prisma.$executeRawUnsafe("set session default_transaction_read_only = on");

  linha("═".repeat(78));
  linha(`  ${descreverAlvo(alvo)}`);
  linha(`  carimbo das provisórias: classificacaoVersao = '${VERSAO_PROVISORIA}'`);
  if (journal) {
    linha(`  journal: ${caminhos.length} ficheiro(s), ${nf(journal.size)} CNP distintos escritos`);
  } else {
    linha("  journal: AUSENTE — modo degradado, ver PARTE 0");
  }
  linha("═".repeat(78));

  if (!journal) {
    titulo("PARTE 0 · Sem journal, isto é uma aproximação");
    linha("");
    linha("  Sem `--journal`, a lista do que foi escrito tem de ser inferida a");
    linha(`  partir de classificacaoVersao = '${VERSAO_PROVISORIA}' — e essa marca`);
    linha("  DESAPARECE quando outro caminho reescreve a classificação. Ou seja:");
    linha("  precisamente os produtos que se quer explicar são os que a inferência");
    linha("  não consegue ver.");
    linha("");
    linha("  Os journais foram escritos pelo `--apply`, tipicamente em:");
    linha("      /opt/spharmmt/journal/canario-200.jsonl");
    linha("      /opt/spharmmt/journal/restante.jsonl");
    linha("");
    linha("  Com eles, a reconciliação fecha produto a produto. Sem eles, o que");
    linha("  se segue conta só o que AINDA está marcado.");
  }

  // ── O estado actual dos CNP em causa ──────────────────────────────
  const cnps = journal ? [...journal.keys()] : [];
  const estados = await prisma.$queryRawUnsafe<Estado[]>(
    `
    select p.cnp,
           p.designacao,
           true                              as existe,
           p.estado::text                    as "estadoProduto",
           p."classificacaoEstado"::text     as "classEstado",
           p."classificacaoOrigem"           as origem,
           p."classificacaoVersao"           as versao,
           p."classificacaoConfianca"        as confianca,
           p."validadoManualmente"           as manual,
           c1.nome                           as n1,
           c2.nome                           as n2,
           (p.cnp <= ${MIN_CNP_CATALOGAVEL}) as interno
      from "Produto" p
      left join "Classificacao" c1 on c1.id = p."classificacaoNivel1Id"
      left join "Classificacao" c2 on c2.id = p."classificacaoNivel2Id"
     where ${journal ? "p.cnp = any($1::int[])" : `p."classificacaoVersao" = $1`}
    `,
    journal ? cnps : VERSAO_PROVISORIA,
  );
  const porCnp = new Map(estados.map((e) => [Number(e.cnp), e]));

  // ══════════════════════════════════════════════════════════════════
  // PARTE 1 · Onde está cada um dos que escrevemos
  //
  // Destinos MUTUAMENTE EXCLUSIVOS, por precedência. A ordem segue a
  // hierarquia real de autoridade — MANUAL ganha a CANONICA, que ganha a
  // PROVISORIA — para que um produto validado por uma pessoa e
  // reclassificado no mesmo dia conte uma vez só, do lado certo.
  // ══════════════════════════════════════════════════════════════════
  titulo("PARTE 1 · Destino de cada provisória escrita");

  const DESTINOS = [
    ["ainda PROVISORIA", "conta no catálogo — é o número que se vê"],
    ["→ MANUAL", "alguém validou na fila de revisão"],
    ["→ CANONICA", "uma fonte melhor reclassificou-o"],
    ["INATIVO", "produto desactivado — sai do universo contado"],
    ["INTERNO", "cnp abaixo do limite — excluído do KPI do catálogo"],
    ["N1 PERDIDO", "!! classificação apagada — o enum diz PROVISORIA e não há N1"],
    ["ENUM DESSINCRONIZADO", "!! tem N1 novo, o enum ficou para trás"],
    ["NÃO EXISTE", "!! o produto desapareceu da base"],
  ] as const;

  const conta = new Map<string, number>(DESTINOS.map(([k]) => [k, 0]));
  const exemplos = new Map<string, Estado[]>(DESTINOS.map(([k]) => [k, []]));
  const origensVistas = new Map<string, number>();

  const destinoDe = (e: Estado | undefined): string => {
    if (!e) return "NÃO EXISTE";
    if (e.estadoProduto === "INATIVO") return "INATIVO";
    if (e.interno) return "INTERNO";
    if (e.manual) return "→ MANUAL";
    if (e.classEstado === "CANONICA") return "→ CANONICA";
    if (e.classEstado === "PROVISORIA") {
      if (!e.n1) return "N1 PERDIDO";
      // O enum diz provisória e a versão já não é a nossa: outro caminho
      // reescreveu N1/N2 e não actualizou o estado. É o defeito real.
      if (e.versao !== VERSAO_PROVISORIA) return "ENUM DESSINCRONIZADO";
      return "ainda PROVISORIA";
    }
    // AUSENTE com N1 preenchido: escrita por um caminho que ignora o enum.
    if (e.n1) return "ENUM DESSINCRONIZADO";
    return "N1 PERDIDO";
  };

  const universo = journal ? cnps : estados.map((e) => Number(e.cnp));
  for (const cnp of universo) {
    const e = porCnp.get(cnp);
    const d = destinoDe(e);
    conta.set(d, (conta.get(d) ?? 0) + 1);
    const ex = exemplos.get(d)!;
    if (e && ex.length < 6) ex.push(e);
    if (e) {
      const chave = `${e.classEstado ?? "?"} · ${e.origem ?? "(sem origem)"} · ${e.versao ?? "(sem versão)"}`;
      origensVistas.set(chave, (origensVistas.get(chave) ?? 0) + 1);
    }
  }

  const total = universo.length;
  linha("");
  linha(`  universo: ${nf(total)} ${journal ? "CNP escritos (do journal)" : `produtos ainda com versão ${VERSAO_PROVISORIA}`}`);
  linha("");
  linha(`  ${padT("destino", 26)} ${"nº".padStart(7)}   ${"o que significa"}`);
  linha(`  ${"─".repeat(76)}`);
  let soma = 0;
  for (const [k, desc] of DESTINOS) {
    const v = conta.get(k) ?? 0;
    soma += v;
    if (v === 0 && k.startsWith("!!")) continue;
    linha(`  ${padT(k, 26)} ${pad(v)}   ${desc}`);
  }
  linha(`  ${"─".repeat(76)}`);
  linha(`  ${padT("TOTAL", 26)} ${pad(soma)}`);
  linha("");
  linha(
    `  reconciliação: ${soma === total ? "✓ fecha" : `!! NÃO fecha (${nf(soma)} ≠ ${nf(total)})`}`,
  );

  const defeitos =
    (conta.get("N1 PERDIDO") ?? 0) +
    (conta.get("ENUM DESSINCRONIZADO") ?? 0) +
    (conta.get("NÃO EXISTE") ?? 0);
  linha("");
  if (defeitos === 0) {
    linha("  ✓ Nenhum defeito: todos os desvios são o sistema a funcionar —");
    linha("    validação humana, reclassificação por fonte melhor, desactivação.");
  } else {
    linha(`  !! ${nf(defeitos)} produto(s) em estado que NÃO se explica por operação normal.`);
    linha("     Causa provável: há SEIS escritores de classificacaoNivel1Id e só");
    linha("     `escreverClassificacao` mantém `classificacaoEstado` em dia —");
    linha("     catalog-persistence, jobs/enrich-catalog, global-catalog-store,");
    linha("     fill-rules, copy-enriched-catalog e a acção de revisão manual");
    linha("     escrevem N1/N2 sem tocar no enum.");
  }

  // ══════════════════════════════════════════════════════════════════
  // PARTE 2 · Combinações (estado, origem, versão) encontradas
  //
  // É o que permite identificar QUEM reescreveu: cada caminho deixa uma
  // origem e uma versão diferentes, e os que não deixam nenhuma
  // identificam-se por isso mesmo.
  // ══════════════════════════════════════════════════════════════════
  titulo("PARTE 2 · Proveniência actual dos CNP escritos");
  linha("");
  linha(`  ${padT("classificacaoEstado · origem · versão", 62)} ${"nº".padStart(7)}`);
  linha(`  ${"─".repeat(72)}`);
  for (const [k, v] of [...origensVistas.entries()].sort((a, b) => b[1] - a[1])) {
    linha(`  ${padT(k, 62)} ${pad(v)}`);
  }
  linha("");
  linha("  Leitura: `MODELO_PROVISORIO · ke-2.1` é o que nós escrevemos. Qualquer");
  linha("  outra combinação nestes CNP é uma segunda escrita — e a origem diz");
  linha("  qual caminho a fez. `(sem origem)` é um caminho que não a regista.");

  // ══════════════════════════════════════════════════════════════════
  // PARTE 3 · Exemplos por destino
  // ══════════════════════════════════════════════════════════════════
  titulo("PARTE 3 · Exemplos");
  for (const [k, desc] of DESTINOS) {
    const ex = exemplos.get(k) ?? [];
    if (ex.length === 0) continue;
    linha("");
    linha(`  ${k} · ${desc}`);
    for (const e of ex) {
      const antes = journal?.get(Number(e.cnp));
      linha(
        `      ${String(e.cnp).padEnd(9)} ${padT(e.designacao, 30)} ` +
          `${padT(`${e.n1 ?? "—"} > ${e.n2 ?? "—"}`, 34)} ` +
          `${padT(`${e.classEstado ?? "?"}/${e.origem ?? "—"}/${e.versao ?? "—"}`, 30)}` +
          `${antes ? `  (antes: ${antes.n2Antes ?? "sem N2"})` : ""}`,
      );
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // PARTE 4 · O total do catálogo, para fechar a conta
  // ══════════════════════════════════════════════════════════════════
  titulo("PARTE 4 · Contra o número do catálogo");

  const [c] = await prisma.$queryRawUnsafe<Array<Record<string, bigint>>>(`
    select
      count(*) filter (where p."validadoManualmente" = false
                         and p."classificacaoEstado" = 'PROVISORIA')  as "provisoriasContadas",
      count(*) filter (where p."classificacaoEstado" = 'PROVISORIA')  as "provisoriasEnum",
      count(*) filter (where p."classificacaoVersao" = '${VERSAO_PROVISORIA}') as "comCarimbo"
      from "Produto" p
     where p.estado <> 'INATIVO'
       and p.cnp > ${MIN_CNP_CATALOGAVEL}
  `);
  const n = (k: string) => Number(c?.[k] ?? 0);

  linha("");
  linha(`  PROVISORIA no KPI (exclui MANUAL) ...... ${pad(n("provisoriasContadas"))}`);
  linha(`  PROVISORIA no enum (inclui MANUAL) ..... ${pad(n("provisoriasEnum"))}`);
  linha(`  com carimbo ${VERSAO_PROVISORIA} .................... ${pad(n("comCarimbo"))}`);
  linha("");
  const dif = n("provisoriasEnum") - n("provisoriasContadas");
  linha(`  diferença enum − KPI ................... ${pad(dif)}`);
  linha("     São produtos com o enum a PROVISORIA e `validadoManualmente=true`:");
  linha("     alguém validou-os na fila e a acção de revisão não actualiza o enum.");
  linha("     A UI mostra-os certos — `origemClassificacao()` dá precedência ao");
  linha("     MANUAL — mas o enum ficou a dizer outra coisa.");

  await prisma.$disconnect();
  linha("");
  linha("Fim. Nada foi escrito: sessão read-only, sem --apply, sem chamadas ao modelo.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
