/**
 * scripts/catalog-master/audit-knowledge-preselection.ts
 *
 * Mede, na base REAL de um tenant, quanto do residual do
 * knowledge-enrichment pode ser resolvido ou excluído ANTES de gastar uma
 * chamada ao modelo.
 *
 * ── Porque existe ────────────────────────────────────────────────────
 * A mesma análise foi feita sobre um export do catálogo e deu 34,5% de
 * redução. Mas os estratos do export não batiam certo com os da base
 * (2 679/8 232/8 117 contra 4 389/8 785/6 858): os rácios transferem, os
 * absolutos não. Antes de implementar filtros que decidem o que NÃO vai
 * ao modelo, os números têm de vir de onde os filtros vão correr.
 *
 * ── O que este script NÃO faz ────────────────────────────────────────
 * Não escreve. Não chama a Anthropic. Não decide limiares — mostra <1%,
 * <2% e <5% e deixa a escolha a quem lê. Não implementa filtro nenhum: é
 * uma medição para uma decisão que ainda não foi tomada.
 *
 * A sessão PostgreSQL abre em READ ONLY, sempre. Não há `--apply`.
 *
 * Uso:
 *   npm run catalog:audit-knowledge-preselection -- --tenant=silveira
 *   npm run catalog:audit-knowledge-preselection -- --tenant=silveira --json=out.json
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import pg from "pg";
import { AlvoRecusado, descreverAlvo, resolverAlvo } from "../../lib/catalog/target-db";
import { buildTenantConnectionString, getTenantBySlug } from "../../lib/control-plane";
import { corpoResidual, MIN_CNP, type Estrato } from "../../lib/catalog/knowledge-enrichment-runner";
import { KNOWLEDGE_MODEL, KNOWLEDGE_VERSION } from "../../lib/catalog/knowledge-enrichment";
import {
  CUSTO_POR_PRODUTO,
  agruparFamilias,
  coberturaPorSubcategoria,
  ehEspecifica,
  nomeOpaco,
  subcategoriasExcluiveis,
  type ProdutoPreselecao,
} from "../../lib/catalog/preselection";

const ESTRATOS: Estrato[] = ["OUTROS_MEDICAMENTOS", "NAO_CLASSIFICADO", "SEM_UTILIZACOES"];
/** Limiares mostrados lado a lado. Nenhum é escolhido aqui. */
const LIMIARES = [1, 2, 5];
/** Abaixo disto uma percentagem de cobertura não significa nada. */
const POPULACAO_MINIMA = 30;

type LinhaCatalogo = {
  cnp: number;
  designacao: string;
  nivel1: string | null;
  nivel2: string | null;
  utilizacoes: string[] | null;
};

type LinhaResidual = { cnp: number; estrato: Estrato };

const pad = (n: number | string, w: number) => String(n).padStart(w);
const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : "—");
const corta = (s: string, n: number) => (s.length <= n ? s.padEnd(n) : `${s.slice(0, n - 1)}…`);

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const jsonOut = argv.find((a) => a.startsWith("--json="))?.slice(7);

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
  // Sem excepção e sem opção que o desligue: este script só lê.
  await db.query("set session default_transaction_read_only = on");

  console.log("═".repeat(78));
  console.log(`${descreverAlvo(alvo)}   (READ ONLY — não escreve nada)`);
  console.log(`regras ${KNOWLEDGE_VERSION} · modelo ${KNOWLEDGE_MODEL} · cnp >= ${MIN_CNP.toLocaleString("pt-PT")}`);
  console.log("═".repeat(78));

  // ── Catálogo inteiro: o contexto das famílias não é só o residual ───
  // Um irmão já classificado está, por definição, FORA do residual. Ler
  // só o residual tornaria invisível exactamente a informação que
  // queremos propagar.
  const { rows: catalogo } = await db.query<LinhaCatalogo>(
    `select p.cnp,
            p.designacao,
            c1.nome as nivel1,
            c2.nome as nivel2,
            coalesce(array_agg(u.slug) filter (where u.slug is not null), '{}') as utilizacoes
       from "Produto" p
       left join "Classificacao" c1 on c1.id = p."classificacaoNivel1Id"
       left join "Classificacao" c2 on c2.id = p."classificacaoNivel2Id"
       left join "ProdutoUtilizacao" pu on pu."produtoId" = p.id
       left join "Utilizacao" u on u.id = pu."utilizacaoId"
      where p.cnp >= $1
      group by p.cnp, p.designacao, c1.nome, c2.nome`,
    [MIN_CNP],
  );

  // ── Residual: a MESMA definição que o runner usa ────────────────────
  // `corpoResidual` vem do runner, de propósito. Uma segunda definição de
  // "residual" aqui podia divergir da que decide o que é processado, e a
  // auditoria passaria a medir outro universo.
  const { rows: residualRows } = await db.query<LinhaResidual>(
    `select p.cnp,
            case
              when p."classificacaoNivel2Id" is null then 'NAO_CLASSIFICADO'
              when c2.nome ilike 'Outros %'          then 'OUTROS_MEDICAMENTOS'
              else 'SEM_UTILIZACOES'
            end as estrato
     ${corpoResidual()}`,
    [MIN_CNP, KNOWLEDGE_VERSION, KNOWLEDGE_MODEL],
  );

  const produtos: ProdutoPreselecao[] = catalogo.map((r) => ({
    cnp: Number(r.cnp),
    designacao: r.designacao ?? "",
    nivel1: r.nivel1,
    nivel2: r.nivel2,
    utilizacoes: (r.utilizacoes ?? []).filter(Boolean),
  }));
  const porCnp = new Map(produtos.map((p) => [p.cnp, p]));
  const estratoDe = new Map(residualRows.map((r) => [Number(r.cnp), r.estrato]));

  console.log(`\ncatálogo lido: ${produtos.length} produtos · residual: ${residualRows.length}`);

  // ── Famílias ────────────────────────────────────────────────────────
  const familias = agruparFamilias(produtos);
  const familiaDe = new Map<number, string>();
  for (const [chave, f] of familias) for (const m of f.membros) familiaDe.set(m.cnp, chave);

  // ── Cobertura por subcategoria ──────────────────────────────────────
  const cobertura = coberturaPorSubcategoria(produtos);
  const excluiveisPorLimiar = new Map(
    LIMIARES.map((l) => [l, subcategoriasExcluiveis(cobertura, l, POPULACAO_MINIMA)]),
  );

  // ── Classificação de cada produto do residual ───────────────────────
  type Balde = {
    total: number;
    propagavel: number;
    opaco: number;
    excluivelPorLimiar: Record<number, number>;
    combinado: Record<number, number>;
  };
  const balde: Record<string, Balde> = {};
  for (const e of ESTRATOS) {
    balde[e] = {
      total: 0, propagavel: 0, opaco: 0,
      excluivelPorLimiar: Object.fromEntries(LIMIARES.map((l) => [l, 0])),
      combinado: Object.fromEntries(LIMIARES.map((l) => [l, 0])),
    };
  }

  const exemplosPropaga: { p: ProdutoPreselecao; chave: string; tamanho: number; via: string }[] = [];
  const exemplosDificeis: { p: ProdutoPreselecao; estrato: Estrato }[] = [];
  const opacos: ProdutoPreselecao[] = [];
  const conflitos = new Map<string, { chave: string; tamanho: number; conflito: string }>();
  const representanteVisto = new Set<string>();
  const famPropagaveis = new Map<string, { chave: string; noResidual: number; herdam: number; via: string }>();

  // Ordem estável: o representante de cada família é sempre o mesmo cnp.
  const residualOrdenado = [...estratoDe.entries()].sort((a, b) => a[0] - b[0]);

  for (const [cnp, estrato] of residualOrdenado) {
    const p = porCnp.get(cnp);
    if (!p) continue;
    const b = balde[estrato]!;
    b.total++;

    const chave = familiaDe.get(cnp) ?? null;
    const f = chave ? familias.get(chave) : null;

    if (f?.conflito && !conflitos.has(f.chave)) {
      conflitos.set(f.chave, { chave: f.chave, tamanho: f.membros.length, conflito: f.conflito });
    }

    // 1. Propagação — só sem conflito na família.
    let propagavel = false;
    let via = "";
    if (f && !f.conflito) {
      const querUtilizacoes = estrato === "SEM_UTILIZACOES";
      const fonte = querUtilizacoes
        ? f.comUtilizacoes.find((m) => m.cnp !== cnp)
        : f.resolvidos.find((m) => m.cnp !== cnp);
      if (fonte) {
        propagavel = true;
        via = querUtilizacoes
          ? `irmão ${fonte.cnp} → ${fonte.utilizacoes.join(", ")}`
          : `irmão ${fonte.cnp} → ${fonte.nivel1} > ${fonte.nivel2}`;
      } else {
        // Família inteira no residual: um representante paga, os outros
        // herdam a conclusão dele.
        const irmaosNoResidual = f.membros.filter((m) => estratoDe.get(m.cnp) === estrato);
        if (irmaosNoResidual.length > 1) {
          const marca = `${estrato}::${f.chave}`;
          if (representanteVisto.has(marca)) {
            propagavel = true;
            via = `herda do representante da família "${f.chave}"`;
          } else {
            representanteVisto.add(marca);
            const reg = famPropagaveis.get(marca) ?? {
              chave: f.chave, noResidual: irmaosNoResidual.length, herdam: irmaosNoResidual.length - 1,
              via: `representante paga 1, herdam ${irmaosNoResidual.length - 1}`,
            };
            famPropagaveis.set(marca, reg);
          }
        }
      }
    }
    if (propagavel) {
      b.propagavel++;
      if (exemplosPropaga.length < 60 && f) {
        exemplosPropaga.push({ p, chave: f.chave, tamanho: f.membros.length, via });
      }
    }

    // 2. Opacos — contados, ainda sem decidir que ficam fora.
    const eOpaco = nomeOpaco(p.designacao);
    if (eOpaco) { b.opaco++; if (opacos.length < 60) opacos.push(p); }

    // 3. Exclusão por subcategoria sem vocabulário — só SEM_UTILIZACOES.
    const chaveSub = ehEspecifica(p.nivel2) ? `${p.nivel1} > ${p.nivel2}` : null;
    for (const l of LIMIARES) {
      const excluivel = estrato === "SEM_UTILIZACOES" && !!chaveSub && excluiveisPorLimiar.get(l)!.has(chaveSub);
      if (excluivel) b.excluivelPorLimiar[l]!++;
      if (propagavel || excluivel || eOpaco) b.combinado[l]!++;
    }

    if (!propagavel && !eOpaco && exemplosDificeis.length < 60) {
      const chaveSubOk = !chaveSub || !excluiveisPorLimiar.get(2)!.has(chaveSub);
      if (chaveSubOk) exemplosDificeis.push({ p, estrato });
    }
  }

  // ── Relatório ───────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(78)}\nESTRATOS (base real)\n${"─".repeat(78)}`);
  console.log("estrato                 total   propagável   opaco   excl<1%   excl<2%   excl<5%");
  for (const e of ESTRATOS) {
    const b = balde[e]!;
    console.log(
      `${corta(e, 22)}${pad(b.total, 7)}${pad(b.propagavel, 13)}${pad(b.opaco, 8)}` +
        LIMIARES.map((l) => pad(b.excluivelPorLimiar[l]!, 10)).join(""),
    );
  }

  console.log(`\n${"─".repeat(78)}\nCUSTO — cada filtro isolado e a combinação\n${"─".repeat(78)}`);
  console.log("Custos por produto do canary de silveira:");
  for (const e of ESTRATOS) console.log(`  ${corta(e, 22)} $${CUSTO_POR_PRODUTO[e]!.toFixed(4)}/prod`);

  const custoDe = (n: number, e: string) => n * CUSTO_POR_PRODUTO[e]!;
  let atual = 0;
  for (const e of ESTRATOS) atual += custoDe(balde[e]!.total, e);
  console.log(`\ncusto actual projectado: $${atual.toFixed(2)}  (${residualRows.length} produtos)`);

  const linha = (nome: string, restantes: Record<string, number>) => {
    let c = 0;
    for (const e of ESTRATOS) c += custoDe(restantes[e]!, e);
    const poup = atual - c;
    console.log(
      `  ${corta(nome, 34)} $${pad(c.toFixed(2), 8)}   poupa $${pad(poup.toFixed(2), 7)}  ${pct(poup, atual)}`,
    );
  };

  console.log("\nsó propagação:");
  linha("propagação estrita", Object.fromEntries(ESTRATOS.map((e) => [e, balde[e]!.total - balde[e]!.propagavel])));
  console.log("\nsó exclusão por subcategoria:");
  for (const l of LIMIARES) {
    linha(`subcategorias <${l}% (pop>=${POPULACAO_MINIMA})`,
      Object.fromEntries(ESTRATOS.map((e) => [e, balde[e]!.total - balde[e]!.excluivelPorLimiar[l]!])));
  }
  console.log("\nsó nomes opacos:");
  linha("nomes opacos", Object.fromEntries(ESTRATOS.map((e) => [e, balde[e]!.total - balde[e]!.opaco])));
  console.log("\nCOMBINADO (propagação + opacos + subcategoria):");
  for (const l of LIMIARES) {
    linha(`combinado com limiar <${l}%`,
      Object.fromEntries(ESTRATOS.map((e) => [e, balde[e]!.total - balde[e]!.combinado[l]!])));
  }

  console.log(`\n${"─".repeat(78)}\nTOP 50 FAMÍLIAS PROPAGÁVEIS (uma conclusão paga, N herdam)\n${"─".repeat(78)}`);
  const topFam = [...famPropagaveis.values()].sort((a, b) => b.herdam - a.herdam).slice(0, 50);
  if (topFam.length === 0) console.log("  nenhuma");
  for (const f of topFam) {
    console.log(`  ${pad(f.noResidual, 4)} no residual · herdam ${pad(f.herdam, 4)}   chave: "${f.chave}"`);
  }

  console.log(`\n${"─".repeat(78)}\nTOP 50 SUBCATEGORIAS POR COBERTURA DE UTILIZAÇÕES\n${"─".repeat(78)}`);
  console.log("  total   c/util      %   subcategoria");
  for (const c of cobertura.filter((x) => x.total >= POPULACAO_MINIMA).sort((a, b) => a.percent - b.percent).slice(0, 50)) {
    const marca = c.percent < 1 ? "<1%" : c.percent < 2 ? "<2%" : c.percent < 5 ? "<5%" : "   ";
    console.log(`  ${pad(c.total, 5)}   ${pad(c.comUtilizacao, 6)}  ${pad(c.percent.toFixed(1), 5)}  ${marca}  ${c.chave}`);
  }

  console.log(`\n${"─".repeat(78)}\nCONFLITOS QUE IMPEDEM PROPAGAÇÃO\n${"─".repeat(78)}`);
  const listaConflitos = [...conflitos.values()].sort((a, b) => b.tamanho - a.tamanho);
  console.log(`  ${listaConflitos.length} famílias com conflito entre irmãos`);
  for (const c of listaConflitos.slice(0, 30)) {
    console.log(`  ${pad(c.tamanho, 4)}x  "${corta(c.chave, 30)}"  ${corta(c.conflito, 100)}`);
  }

  console.log(`\n${"─".repeat(78)}\n30 EXEMPLOS DE PROPAGAÇÃO\n${"─".repeat(78)}`);
  for (const x of exemplosPropaga.slice(0, 30)) {
    console.log(`  cnp ${pad(x.p.cnp, 8)}  ${corta(x.p.designacao, 40)}`);
    console.log(`      família "${corta(x.chave, 30)}" (${x.tamanho})  ← ${corta(x.via, 60)}`);
  }

  console.log(`\n${"─".repeat(78)}\nNOMES OPACOS (contados, ainda sem decisão)\n${"─".repeat(78)}`);
  let totalOpacos = 0;
  for (const e of ESTRATOS) totalOpacos += balde[e]!.opaco;
  console.log(`  ${totalOpacos} no total`);
  for (const p of opacos.slice(0, 30)) console.log(`  cnp ${pad(p.cnp, 8)}  ${p.designacao}`);

  console.log(`\n${"─".repeat(78)}\nTOP 50 AINDA DIFÍCEIS (vão mesmo ao modelo)\n${"─".repeat(78)}`);
  for (const x of exemplosDificeis.slice(0, 50)) {
    console.log(`  cnp ${pad(x.p.cnp, 8)}  [${corta(x.estrato, 20)}] ${corta(x.p.designacao, 44)}`);
  }

  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify({
      tenant: alvo.tenant, base: alvo.base,
      residual: residualRows.length, catalogo: produtos.length,
      estratos: balde, custoActualUsd: atual,
      cobertura, conflitos: listaConflitos, familias: topFam,
    }, null, 2));
    console.log(`\nJSON: ${jsonOut}`);
  }

  await db.end();
}

main().catch((err) => {
  console.error("\n[erro fatal]", err);
  process.exit(1);
});
