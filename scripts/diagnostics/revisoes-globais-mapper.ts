/**
 * scripts/diagnostics/revisoes-globais-mapper.ts
 *
 * Para cada divergência global por resolver: o que o mapper determinístico
 * diz HOJE sobre esse produto.
 *
 * ─────────────────────────────────────────────────────────────────────
 * PARA QUE SERVE
 *
 * As revisões pendentes são desacordos entre o catálogo nacional e um
 * tenant. Decidir uma a uma exige olhar para o produto; decidir um grupo
 * exige saber se há um terceiro parecer — e há: o mapper.
 *
 * O mapper não é árbitro. É um voto independente, determinístico e
 * auditável, e o que este diagnóstico faz é contá-lo:
 *
 *   MAPPER=GLOBAL         o mapper concorda com o catálogo nacional
 *   MAPPER=LOCAL          o mapper concorda com o tenant
 *   MAPPER=NENHUM         o mapper diz uma terceira coisa
 *   MAPPER=SEM_RESULTADO  o mapper não classifica este produto
 *
 * Um grupo inteiro em MAPPER=GLOBAL é um caso para resolver em bloco a
 * favor do global; um grupo em MAPPER=NENHUM é sinal de que nenhum dos
 * dois lados está bem e de que a taxonomia é que não separa; e
 * SEM_RESULTADO diz que a regra não tem opinião — a decisão é humana ou
 * do modelo, e não há atalho.
 *
 * O que NÃO faz: não decide, não resolve, não escreve. Só conta.
 *
 * ─────────────────────────────────────────────────────────────────────
 * READ-ONLY A SÉRIO
 *
 * Cada ligação — control plane e cada tenant — entra em
 * `default_transaction_read_only` ANTES da primeira consulta. Não é
 * disciplina de quem escreve o ficheiro: é a base a recusar.
 *
 * Sem chamadas ao modelo: `mapToCanonical` é uma função pura, sem rede.
 *
 * Uso:
 *   npm run diag:revisoes-globais-mapper
 *   npm run diag:revisoes-globais-mapper -- --tenant=garantia
 *   npm run diag:revisoes-globais-mapper -- --tudo     # tabela completa
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";
import {
  buildTenantConnectionString,
  controlPrisma,
  getTenantBySlug,
} from "../../lib/control-plane";
import { mapToCanonical, type TaxonomyMapInput } from "../../lib/catalog-taxonomy-map";
import type { ProductType } from "../../lib/catalog-types";

const nf = (n: number) => n.toLocaleString("pt-PT");
const pad = (n: number, w = 6) => String(nf(n)).padStart(w);
const linha = (s = "") => console.log(s);
const corta = (s: string | null, n: number) => (s ?? "—").slice(0, n).padEnd(n);

const valorArg = (argv: string[], nome: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${nome}=`))?.split("=").slice(1).join("=").trim();

/** Os quatro desfechos possíveis. A ordem é a do relatório. */
type Resultado = "MAPPER=GLOBAL" | "MAPPER=LOCAL" | "MAPPER=NENHUM" | "MAPPER=SEM_RESULTADO";
const RESULTADOS: readonly Resultado[] = [
  "MAPPER=GLOBAL",
  "MAPPER=LOCAL",
  "MAPPER=NENHUM",
  "MAPPER=SEM_RESULTADO",
];

type LinhaRevisao = {
  id: string;
  cnp: number;
  tenantSlug: string;
  valorGlobal: string | null;
  valorLocal: string | null;
  gOrigem: string | null;
  gConfidence: number | null;
  gVersao: string | null;
};

type LinhaProduto = {
  cnp: number;
  designacao: string;
  productType: string | null;
  productTypeConfidence: number | null;
  codigoATC: string | null;
  dci: string | null;
  n1: string | null;
  n2: string | null;
  origem: string | null;
  confianca: number | null;
  versao: string | null;
  manual: boolean;
  categoriaOrigem: string | null;
  subcategoriaOrigem: string | null;
};

type Caso = LinhaRevisao & {
  produto: LinhaProduto | null;
  mapper: string | null;
  resultado: Resultado;
};

/** "N1 > N2", na forma em que a revisão o gravou. */
const parDe = (n1: string | null, n2: string | null): string | null =>
  n1 ? `${n1} > ${n2 ?? "—"}` : null;

const igual = (a: string | null, b: string | null): boolean =>
  !!a && !!b && a.trim().toUpperCase() === b.trim().toUpperCase();

/**
 * O contexto REAL do produto, não um contexto inventado.
 *
 * É a diferença entre perguntar «o que diria o mapper sobre este nome?» e
 * «o que diz o mapper sobre este produto, como ele está na base». A
 * segunda é a pergunta que interessa para decidir a revisão — e é por
 * isso que `productType`, ATC, DCI e o breadcrumb do ERP entram todos.
 */
function contextoDoProduto(p: LinhaProduto): TaxonomyMapInput {
  return {
    productType: (p.productType ?? "OUTRO") as ProductType,
    productTypeConfidence: p.productTypeConfidence ?? 0,
    externalCategory: p.categoriaOrigem,
    externalSubcategory: p.subcategoriaOrigem,
    designacao: p.designacao,
    atc: p.codigoATC,
    dci: p.dci,
  };
}

/** Destaques pedidos: famílias de produtos que já apareceram na análise. */
const DESTAQUES: ReadonlyArray<{ nome: string; bate: (c: Caso) => boolean }> = [
  { nome: "Leukotape", bate: (c) => /leukotape/i.test(c.produto?.designacao ?? "") },
  { nome: "Compressas", bate: (c) => /compressa/i.test(c.produto?.designacao ?? "") },
  { nome: "Betadine gaze", bate: (c) => /betadine/i.test(c.produto?.designacao ?? "") },
  {
    nome: "Agulhas/Lancetas",
    bate: (c) => /agulha|lanceta|seringa/i.test(c.produto?.designacao ?? ""),
  },
  { nome: "CISTITONE", bate: (c) => /cistitone/i.test(c.produto?.designacao ?? "") },
  {
    nome: "DERMOCOSMÉTICA",
    bate: (c) =>
      /DERMOCOSM/i.test(c.valorGlobal ?? "") || /DERMOCOSM/i.test(c.valorLocal ?? ""),
  },
];

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const tenantFiltro = valorArg(argv, "tenant");
  const tudo = argv.includes("--tudo");

  linha("SPharm.MT · revisões globais × mapper determinístico · READ-ONLY");
  linha(`  revisão da imagem: ${process.env.APP_REVISION ?? "(não carimbada)"}`);

  // Read-only à porta da base, antes de qualquer consulta.
  await controlPrisma.$executeRawUnsafe("set session default_transaction_read_only = on");

  const revisoes = await controlPrisma.$queryRawUnsafe<LinhaRevisao[]>(
    `select r.id, r.cnp, r."tenantSlug",
            r."valorGlobal", r."valorLocal",
            g.origem::text  as "gOrigem",
            g.confidence    as "gConfidence",
            g."versaoRegras" as "gVersao"
       from "CatalogoGlobalRevisao" r
       left join "CatalogoGlobal" g on g.cnp = r.cnp
      where r."resolvidoEm" is null
        ${tenantFiltro ? `and r."tenantSlug" = '${tenantFiltro.replace(/'/g, "''")}'` : ""}
      order by r."tenantSlug", r.cnp`,
  );

  linha("═".repeat(120));
  linha(
    `  ${nf(revisoes.length)} revisões pendentes` +
      (tenantFiltro ? ` · tenant=${tenantFiltro}` : "") +
      "   ·   o mapper é um TERCEIRO parecer, não um árbitro",
  );
  linha("═".repeat(120));

  if (revisoes.length === 0) {
    linha("");
    linha("  Nada pendente com este filtro.");
    await controlPrisma.$disconnect();
    return;
  }

  // ── Os produtos, tenant a tenant ──────────────────────────────────
  //
  // Uma ligação por tenant, aberta e fechada. As revisões são agrupadas
  // primeiro para não abrir a mesma base 34 vezes.
  const porTenant = new Map<string, LinhaRevisao[]>();
  for (const r of revisoes) {
    const lista = porTenant.get(r.tenantSlug) ?? [];
    lista.push(r);
    porTenant.set(r.tenantSlug, lista);
  }

  const produtos = new Map<string, LinhaProduto>();
  const semAcesso: string[] = [];

  for (const [slug, lista] of porTenant) {
    const tenant = await getTenantBySlug(slug);
    if (!tenant) {
      semAcesso.push(`${slug} (não existe no control plane)`);
      continue;
    }
    const prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: buildTenantConnectionString(tenant) }),
    });
    try {
      await prisma.$executeRawUnsafe("set session default_transaction_read_only = on");
      const cnps = lista.map((r) => Number(r.cnp) | 0);
      const linhas = await prisma.$queryRawUnsafe<LinhaProduto[]>(
        `select p.cnp, p.designacao,
                p."productType", p."productTypeConfidence",
                p."codigoATC", p.dci,
                c1.nome as n1, c2.nome as n2,
                p."classificacaoOrigem"    as origem,
                p."classificacaoConfianca" as confianca,
                p."classificacaoVersao"    as versao,
                p."validadoManualmente"    as manual,
                -- O breadcrumb do ERP vive em ProdutoFarmacia (uma linha
                -- por farmácia). Qualquer não-nulo serve como contexto: o
                -- mapper usa-o como pista, não como autoridade.
                (select pf."categoriaOrigem" from "ProdutoFarmacia" pf
                  where pf."produtoId" = p.id and pf."categoriaOrigem" is not null
                  limit 1) as "categoriaOrigem",
                (select pf."subcategoriaOrigem" from "ProdutoFarmacia" pf
                  where pf."produtoId" = p.id and pf."subcategoriaOrigem" is not null
                  limit 1) as "subcategoriaOrigem"
           from "Produto" p
           left join "Classificacao" c1 on c1.id = p."classificacaoNivel1Id"
           left join "Classificacao" c2 on c2.id = p."classificacaoNivel2Id"
          where p.cnp = any('{${cnps.join(",")}}'::int[])`,
      );
      for (const l of linhas) produtos.set(`${slug}|${l.cnp}`, l);
    } catch (e) {
      semAcesso.push(`${slug} (${e instanceof Error ? e.message.slice(0, 80) : String(e)})`);
    } finally {
      await prisma.$disconnect();
    }
  }

  // ── O parecer do mapper ───────────────────────────────────────────
  const casos: Caso[] = revisoes.map((r) => {
    const produto = produtos.get(`${r.tenantSlug}|${r.cnp}`) ?? null;
    if (!produto) {
      return { ...r, produto: null, mapper: null, resultado: "MAPPER=SEM_RESULTADO" };
    }
    const m = mapToCanonical(contextoDoProduto(produto));
    const mapper = m ? `${m.nivel1} > ${m.nivel2}` : null;

    let resultado: Resultado;
    if (!mapper) resultado = "MAPPER=SEM_RESULTADO";
    else if (igual(mapper, r.valorGlobal)) resultado = "MAPPER=GLOBAL";
    else if (igual(mapper, r.valorLocal)) resultado = "MAPPER=LOCAL";
    else resultado = "MAPPER=NENHUM";

    return { ...r, produto, mapper, resultado };
  });

  // ── PARTE 1 · a tabela ────────────────────────────────────────────
  linha("");
  linha("  1 · CASO A CASO");
  const mostrar = tudo ? casos : casos.slice(0, 40);
  for (const c of mostrar) {
    linha("");
    linha(
      `  ${String(c.cnp).padEnd(9)} ${corta(c.produto?.designacao ?? "(produto não encontrado)", 52)} ` +
        `[${c.tenantSlug}]`,
    );
    linha(`     global ..... ${c.valorGlobal ?? "—"}`);
    linha(`     local ...... ${c.valorLocal ?? "—"}`);
    linha(`     mapper ..... ${c.mapper ?? "(não classifica)"}`);
    linha(
      `     >>> ${c.resultado}` +
        (c.produto
          ? `   ·   local: ${c.produto.origem ?? "sem origem"}` +
            `${c.produto.confianca !== null ? ` ${c.produto.confianca.toFixed(2)}` : ""}` +
            `${c.produto.versao ? ` (${c.produto.versao})` : ""}` +
            `${c.produto.manual ? " · MANUAL" : ""}` +
            `   ·   global: ${c.gOrigem ?? "—"}` +
            `${c.gConfidence !== null ? ` ${c.gConfidence.toFixed(2)}` : ""}` +
            `${c.gVersao ? ` (${c.gVersao})` : ""}`
          : ""),
    );
  }
  if (!tudo && casos.length > mostrar.length) {
    linha("");
    linha(`  (mais ${nf(casos.length - mostrar.length)} — usar --tudo)`);
  }

  // ── PARTE 2 · o resumo ────────────────────────────────────────────
  linha("");
  linha("  2 · RESUMO");
  for (const r of RESULTADOS) {
    const n = casos.filter((c) => c.resultado === r).length;
    linha(`      ${r.padEnd(24)} ${pad(n)}`);
  }
  linha(`      ${"TOTAL".padEnd(24)} ${pad(casos.length)}`);

  // ── PARTE 3 · por par, dentro de cada resultado ───────────────────
  //
  // É esta que diz se um desfecho é decidível em bloco: dez CNPs no
  // mesmo par e no mesmo resultado são uma decisão, não dez.
  linha("");
  linha("  3 · GRUPOS  (par global → local, dentro de cada resultado)");
  for (const r of RESULTADOS) {
    const doResultado = casos.filter((c) => c.resultado === r);
    if (doResultado.length === 0) continue;
    linha("");
    linha(`      ── ${r}  (${nf(doResultado.length)})`);
    const grupos = new Map<string, Caso[]>();
    for (const c of doResultado) {
      const chave = `${c.valorGlobal ?? "—"}   →   ${c.valorLocal ?? "—"}`;
      grupos.set(chave, [...(grupos.get(chave) ?? []), c]);
    }
    for (const [chave, lista] of [...grupos.entries()].sort((a, b) => b[1].length - a[1].length)) {
      linha(`         ${pad(lista.length, 4)} × ${chave}`);
      linha(`                ${lista.slice(0, 6).map((c) => c.cnp).join(", ")}${lista.length > 6 ? ", …" : ""}`);
    }
  }

  // ── PARTE 4 · os destaques ────────────────────────────────────────
  linha("");
  linha("  4 · DESTAQUES");
  for (const d of DESTAQUES) {
    const lista = casos.filter(d.bate);
    if (lista.length === 0) {
      linha(`      ${d.nome.padEnd(20)} ${pad(0)}   (nenhum entre as pendentes)`);
      continue;
    }
    const contagem = RESULTADOS.map((r) => {
      const n = lista.filter((c) => c.resultado === r).length;
      return n > 0 ? `${n} ${r.replace("MAPPER=", "")}` : null;
    }).filter(Boolean);
    linha(`      ${d.nome.padEnd(20)} ${pad(lista.length)}   ${contagem.join(" · ")}`);
    for (const c of lista.slice(0, 4)) {
      linha(`           ${String(c.cnp).padEnd(9)} ${corta(c.produto?.designacao ?? "—", 44)} ${c.resultado}`);
    }
  }

  // ── PARTE 5 · como se lê isto ─────────────────────────────────────
  linha("");
  linha("  5 · COMO SE LÊ");
  linha("      MAPPER=GLOBAL        a regra concorda com o catálogo nacional");
  linha("      MAPPER=LOCAL         a regra concorda com o tenant");
  linha("      MAPPER=NENHUM        a regra diz uma terceira coisa — nenhum dos");
  linha("                           dois lados tem apoio determinístico");
  linha("      MAPPER=SEM_RESULTADO a regra não opina; decide o modelo ou uma pessoa");
  linha("");
  linha("      O mapper é UM parecer, não o desempate. Um grupo inteiro no mesmo");
  linha("      resultado é candidato a decisão em bloco; um grupo repartido não é.");
  linha("");
  linha("      Nada foi escrito. Resolver continua a ser catalog:resolver-revisao.");

  if (semAcesso.length > 0) {
    linha("");
    linha("  !! tenants sem leitura — os produtos deles contam como SEM_RESULTADO:");
    for (const s of semAcesso) linha(`     ${s}`);
  }

  await controlPrisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
