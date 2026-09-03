/**
 * scripts/catalog-master/forma-canary.ts
 *
 * O canary do pedido de FORMA. Read-only sem excepção: não escreve na
 * base, não escreve na cache, não mexe na fila.
 *
 * ── Porque existe ────────────────────────────────────────────────────
 *
 * A auditoria de 2026-09-03 mediu o backlog que cobre 95% das unidades
 * vendidas: 1 776 produtos, dos quais 1 169 têm categoria e subcategoria
 * decididas e falta-lhes SÓ a forma farmacêutica. Antes de gastar uma
 * chamada por cada 50 desses, olha-se para 50.
 *
 * ── Dois modos, e o default não gasta nada ───────────────────────────
 *
 *   sem flags   mostra o que SERIA enviado: os produtos escolhidos, o
 *               prompt e o vocabulário fechado. Zero chamadas, zero euros.
 *   --chamar    faz a chamada do canary e mostra a resposta produto a
 *               produto, com a decisão do gate. Continua a não escrever.
 *
 * O default é o que não custa porque a pergunta «o que é que isto ia
 * pedir?» é a que se faz primeiro, e porque um comando que gasta dinheiro
 * por omissão acaba por ser corrido por engano.
 *
 * ── O que este comando NUNCA faz ─────────────────────────────────────
 *
 *   · não escreve `Produto.formaFarmaceutica` — nem com `--chamar`;
 *   · não escala: `--limite` está travado em MAX_CANARY, e passar mais
 *     é recusado em vez de silenciosamente cortado. Correr o backlog é
 *     outro comando, e é uma decisão diferente;
 *   · não toca em categoria, subcategoria, utilizações, DCI nem ATC.
 *
 * ── A ordem é comercial ──────────────────────────────────────────────
 *
 * Os 50 não são os primeiros 50 por cnp: são os 50 que mais unidades
 * venderam na janela. Um canary sobre a cauda mede a cauda.
 *
 * Uso:
 *   npm run catalog:forma-canary -- --tenant=<slug>
 *   npm run catalog:forma-canary -- --tenant=<slug> --chamar
 *   npm run catalog:forma-canary -- --tenant=<slug> --limite=25 --chamar
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";
import { buildTenantConnectionString, getTenantBySlug } from "../../lib/control-plane";
import { AlvoRecusado, descreverAlvo, resolverAlvo } from "../../lib/catalog/target-db";
import { MIN_CNP } from "../../lib/catalog/knowledge-enrichment-runner";
import { estimarCusto } from "../../lib/catalog/knowledge-enrichment-runner";
import {
  KNOWLEDGE_MODEL,
  KNOWLEDGE_VERSION,
  LIMIAR_CLINICO,
  TAMANHO_LOTE_FORMA,
  alvoParaProduto,
  avaliarGate,
  classificarFormaLote,
  type ProdutoResidual,
} from "../../lib/catalog/knowledge-enrichment";
import { FORMAS_CANONICAS } from "../../lib/catalog/formas-farmaceuticas";

/** Tecto do canary. Não é um default: é um limite. */
const MAX_CANARY = 200;

const pad = (n: number | string, w = 6) => String(n).padStart(w);

type LinhaCanary = ProdutoResidual & {
  formaAtual: string | null;
  unidades: number;
  linhas: number;
  ultimoMes: number | null;
};

/**
 * Os candidatos: classificação específica, sem forma, por importância
 * comercial.
 *
 * `validadoManualmente` fica de fora como em todo o resto do módulo — uma
 * decisão humana não se reconfirma a pagar tokens. E `cnp >= MIN_CNP`
 * porque abaixo disso são códigos internos, não catálogo.
 */
async function lerCandidatos(prisma: PrismaClient, limite: number): Promise<LinhaCanary[]> {
  return prisma.$queryRawUnsafe<LinhaCanary[]>(
    `select p.cnp,
            p.designacao,
            p."productType",
            c1.nome as "categoriaAtual",
            c2.nome as "subcategoriaAtual",
            p."formaFarmaceutica" as "formaAtual",
            coalesce(v.unidades, 0)::float8 as unidades,
            coalesce(v.linhas, 0)::int      as linhas,
            v."ultimoMes"                   as "ultimoMes"
       from "Produto" p
       join "Classificacao" c1 on c1.id = p."classificacaoNivel1Id"
       join "Classificacao" c2 on c2.id = p."classificacaoNivel2Id"
       left join lateral (
            select sum(coalesce(vm."quantidadeLiquida", vm.quantidade)) as unidades,
                   sum(coalesce(vm."linhasVenda", 0))                   as linhas,
                   max(vm.ano * 100 + vm.mes)                           as "ultimoMes"
              from "VendaMensal" vm
             where vm."produtoId" = p.id
               and vm."naturezaVenda" <> 'TRANSFERENCIA'
       ) v on true
      where p.cnp >= $1
        and p."validadoManualmente" = false
        and p."formaFarmaceutica" is null
        and c2.nome not ilike 'Outros %'
      order by coalesce(v.unidades, 0) desc, p.cnp
      limit $2`,
    MIN_CNP,
    limite,
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const chamar = argv.includes("--chamar");
  const pedido = Number(argv.find((a) => a.startsWith("--limite="))?.split("=")[1] ?? TAMANHO_LOTE_FORMA);
  if (!Number.isFinite(pedido) || pedido < 1) {
    console.error("\n--limite tem de ser um inteiro positivo.\n");
    process.exit(2);
  }
  if (pedido > MAX_CANARY) {
    // Recusar em vez de cortar: quem pediu 5 000 queria 5 000, e devolver
    // 200 em silêncio faria passar por canary o que era backlog.
    console.error(
      `\nO canary está travado em ${MAX_CANARY} produtos e foram pedidos ${pedido}.\n` +
        `Correr o backlog é outro comando e outra decisão — ver catalog:knowledge-enrich.\n`,
    );
    process.exit(2);
  }

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
    console.error("\nO canary precisa de --tenant=<slug>.\n");
    process.exit(2);
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: alvo.url }) });
  // READ-ONLY na própria sessão. Não é decorativo: é o que garante que um
  // bug neste ficheiro não consegue escrever mesmo que tente.
  await prisma.$executeRawUnsafe("set session default_transaction_read_only = on");

  console.log("═".repeat(74));
  console.log(`${descreverAlvo(alvo)}   (canary FORMA — READ-ONLY, nada é escrito)`);
  console.log(`modelo: ${KNOWLEDGE_MODEL}   versão de regras: ${KNOWLEDGE_VERSION}   effort: low`);
  console.log(`vocabulário fechado: ${FORMAS_CANONICAS.length} formas   lote: ${TAMANHO_LOTE_FORMA}`);
  console.log("═".repeat(74));

  const candidatos = await lerCandidatos(prisma, pedido);
  console.log(`\n── candidatos ─────────────────────────────────────────`);
  console.log(`  ${pad(candidatos.length)}  produtos com categoria+subcategoria específica e SEM forma`);
  console.log(`  ${pad(candidatos.filter((c) => c.unidades > 0).length)}  …destes, com vendas na janela`);

  if (candidatos.length === 0) {
    console.log("\nNada a fazer: não há produtos neste estado.");
    await prisma.$disconnect();
    return;
  }

  // O alvo é derivado, não assumido: se algum destes não der FORMA, é um
  // erro de selecção e vê-se aqui, antes de gastar a chamada.
  const alvosErrados = candidatos.filter(
    (c) => alvoParaProduto({ subcategoria: c.subcategoriaAtual, forma: c.formaAtual }) !== "FORMA",
  );
  if (alvosErrados.length > 0) {
    console.log(`\n  ATENÇÃO: ${alvosErrados.length} candidatos não derivam alvo FORMA — selecção e alvo discordam.`);
    for (const c of alvosErrados.slice(0, 5)) console.log(`     ${c.cnp}  ${c.designacao}`);
  }

  console.log(`\n── o que vai ser enviado (input) ──────────────────────`);
  console.log(`  ${pad("cnp")}  ${"designação".padEnd(46)}  ${pad("unid", 8)}  ${pad("linhas", 7)}  último`);
  for (const c of candidatos) {
    console.log(
      `  ${pad(c.cnp, 9)}  ${c.designacao.slice(0, 46).padEnd(46)}  ` +
        `${pad(Math.round(c.unidades), 8)}  ${pad(c.linhas, 7)}  ${c.ultimoMes ?? "-"}`,
    );
  }

  if (!chamar) {
    console.log(`\n── o pedido (não enviado) ─────────────────────────────`);
    console.log(`  system:   prompt de forma + lista fechada de ${FORMAS_CANONICAS.length} formas`);
    console.log(`  user:     ${candidatos.length} linhas  "- cnp=… designacao=…"`);
    console.log(`  schema:   { cnp, forma, confidence }`);
    console.log(`  effort:   low        segunda passagem: NÃO`);
    console.log(`\nNenhuma chamada foi feita. Para correr o canary a sério:`);
    console.log(`  npm run catalog:forma-canary -- --tenant=${alvo.tenant} --chamar\n`);
    await prisma.$disconnect();
    return;
  }

  // ── Canary a sério: chama o modelo, NÃO escreve ────────────────────
  console.log(`\n── chamada ────────────────────────────────────────────`);
  const lote: ProdutoResidual[] = candidatos.map((c) => ({
    cnp: c.cnp,
    designacao: c.designacao,
    productType: c.productType,
    categoriaAtual: c.categoriaAtual,
    subcategoriaAtual: c.subcategoriaAtual,
    formaAtual: c.formaAtual,
  }));
  const t0 = Date.now();
  const resposta = await classificarFormaLote(lote);
  const ms = Date.now() - t0;

  const porCnp = new Map(candidatos.map((c) => [c.cnp, c]));
  const contagem = { apply: 0, review: 0, skip: 0, semResposta: 0 };
  const motivos = new Map<string, number>();

  console.log(`\n── resultado ──────────────────────────────────────────`);
  console.log(`  ${pad("cnp")}  ${"forma proposta".padEnd(38)}  ${pad("conf", 5)}  decisão`);
  for (const r of resposta.resultados) {
    const p = porCnp.get(r.cnp);
    if (!p) continue;
    const gate = avaliarGate(r, {
      categoria: p.categoriaAtual,
      subcategoria: p.subcategoriaAtual,
      productType: p.productType,
      forma: p.formaAtual,
    });
    if (gate.decisao === "APPLY") contagem.apply++;
    else if (gate.decisao === "REVIEW") contagem.review++;
    else contagem.skip++;
    if (gate.decisao !== "APPLY") motivos.set(gate.motivo, (motivos.get(gate.motivo) ?? 0) + 1);
    console.log(
      `  ${pad(r.cnp, 9)}  ${(r.forma ?? "(vazio)").padEnd(38)}  ` +
        `${pad(r.confidenceClinica.toFixed(2), 5)}  ${gate.decisao}`,
    );
  }
  contagem.semResposta = candidatos.length - resposta.resultados.length;

  const n = candidatos.length;
  const pct = (x: number) => `${((100 * x) / n).toFixed(1)}%`;
  console.log(`\n── taxas ──────────────────────────────────────────────`);
  console.log(`  ${pad(n)}  produtos enviados                 (${ms} ms)`);
  console.log(`  ${pad(contagem.apply)}  preenchidos e aceites pelo gate   ${pct(contagem.apply)}`);
  console.log(`  ${pad(contagem.review)}  em revisão (confiança < ${LIMIAR_CLINICO})   ${pct(contagem.review)}`);
  console.log(`  ${pad(contagem.skip)}  recusados                         ${pct(contagem.skip)}`);
  console.log(`  ${pad(contagem.semResposta)}  sem resposta do modelo            ${pct(contagem.semResposta)}`);

  if (motivos.size > 0) {
    console.log(`\n── motivos de recusa ──────────────────────────────────`);
    for (const [motivo, quantos] of [...motivos].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${pad(quantos)}  ${motivo}`);
    }
  }

  const u = resposta.usage;
  const custo = estimarCusto(u);
  console.log(`\n── custo desta chamada ────────────────────────────────`);
  console.log(`  input ${u.inputTokens}  output ${u.outputTokens}  cacheRead ${u.cacheReadTokens}  cacheWrite ${u.cacheWriteTokens}`);
  console.log(`  ${custo.toFixed(4)} USD   →   ${(custo / n).toFixed(5)} USD por produto`);
  console.log(`\nNada foi escrito. O canary não escala sozinho: ler as taxas acima é o passo seguinte.\n`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
