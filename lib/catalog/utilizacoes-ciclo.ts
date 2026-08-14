/**
 * lib/catalog/utilizacoes-ciclo.ts
 *
 * Seed do vocabulário e backfill das associações, como funções que
 * correm dentro da aplicação — não como scripts de linha de comando.
 *
 * Porquê aqui: instalar uma farmácia não pode exigir SSH, npm nem
 * Prisma. O técnico corre o Wizard e o `run-products-upload.bat`, e o
 * resto acontece. Os scripts continuam a existir para reprocessamento
 * explícito, mas passam a ser a excepção e não o caminho normal.
 *
 * DECIDIR SE HÁ TRABALHO SEM FILA NENHUMA
 *
 * Não há tabela de pedidos pendentes, e é deliberado. O estado já existe
 * na base: `IngestProdutoRun.finalizadaEm` diz quando o último upload
 * fechou, e `CatalogoBackfillRun.executadoEm` diz quando o catálogo foi
 * processado pela última vez. Se o primeiro for posterior ao segundo, há
 * produtos novos por classificar.
 *
 * Isto é melhor do que uma fila por três razões: um pedido perdido não
 * existe (a comparação recupera-se sozinha na passagem seguinte), um
 * pedido duplicado não faz nada de diferente, e o `finalize` não ganha
 * escrita nenhuma no caminho crítico do upload.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { UTILIZACOES } from "./utilizacoes";
import {
  IMPLICACOES,
  MIN_CONFIANCA,
  PENALIZACAO_DESIGNACAO,
  REGRAS_ATC,
  REGRAS_CATEGORIA,
  REGRAS_SUBCATEGORIA,
  REGRAS_SUBSTANCIA,
  REGRAS_TEXTO,
} from "./utilizacoes-regras";

/** Códigos internos da farmácia não entram no catálogo regulamentar. */
const MIN_CNP = 2_000_000;
const FONTE = "REGRA";

export type ResultadoSeed = { novas: number; actualizadas: number; desactivadas: number };

/**
 * Alinha o vocabulário da base com `lib/catalog/utilizacoes.ts`.
 * Idempotente por `slug`. Nunca apaga: uma utilização retirada da lista
 * passa a INATIVO e mantém as associações já feitas.
 */
export async function seedUtilizacoes(prisma: PrismaClient): Promise<ResultadoSeed> {
  const activos = UTILIZACOES.filter((u) => !u.descontinuada);
  const antes = await prisma.utilizacao.findMany({ select: { slug: true, estado: true } });
  const conhecidos = new Set(antes.map((a) => a.slug));

  let novas = 0;
  let actualizadas = 0;
  for (const [ordem, u] of activos.entries()) {
    if (conhecidos.has(u.slug)) actualizadas++;
    else novas++;
    await prisma.utilizacao.upsert({
      where: { slug: u.slug },
      create: {
        slug: u.slug,
        nome: u.nome,
        descricao: u.descricao,
        sinonimos: u.sinonimos,
        grupo: u.grupo,
        ordem,
      },
      update: {
        nome: u.nome,
        descricao: u.descricao,
        sinonimos: u.sinonimos,
        grupo: u.grupo,
        estado: "ATIVO",
        ordem,
      },
    });
  }

  const slugsActivos = activos.map((u) => u.slug);
  const { count: desactivadas } = await prisma.utilizacao.updateMany({
    where: { slug: { notIn: slugsActivos }, estado: "ATIVO" },
    data: { estado: "INATIVO" },
  });

  return { novas, actualizadas, desactivadas };
}

export type ResultadoBackfill = {
  produtosAnalisados: number;
  produtosClassificados: number;
  associacoes: number;
  recusadas: number;
  coberturaPercent: number;
  escritas: number;
};

type ProdutoSinais = {
  id: string;
  designacao: string;
  productType: string | null;
  categoria: string | null;
  subcategoria: string | null;
  codigoATC: string | null;
  grupoHomogeneo: string | null;
  temRegulatorio: boolean;
};

type Candidata = { utilizacao: string; confianca: number; regra: string };

function normalizar(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

/** Todas as utilizações que os sinais deste produto sustentam. */
export function avaliarProduto(p: ProdutoSinais): Candidata[] {
  const out: Candidata[] = [];

  // ATC só quando é regulatório: um ATC inferido por nós não é fonte
  // regulatória e não pode alimentar a faceta.
  if (p.codigoATC && p.temRegulatorio) {
    const atc = p.codigoATC.toUpperCase();
    for (const r of REGRAS_ATC) {
      if (atc.startsWith(r.atc)) out.push({ utilizacao: r.utilizacao, confianca: r.confianca, regra: `ATC ${r.atc}` });
    }
  }

  if (p.grupoHomogeneo) {
    const substancia = normalizar(p.grupoHomogeneo.split("|")[0] ?? "");
    for (const r of REGRAS_SUBSTANCIA) {
      if (substancia.includes(normalizar(r.nome))) {
        out.push({ utilizacao: r.utilizacao, confianca: r.confianca, regra: `GH ${r.nome}` });
      }
    }
  }

  // A substância também aparece na própria designação — em Portugal o
  // genérico chama-se pela substância ("Irbesartan Pharmakern 300 Mg").
  // O Grupo Homogéneo só existe para 18% do catálogo; sem esta passagem,
  // 4 em cada 5 medicamentos ficavam sem utilização por falta de um
  // campo, não por falta de sinal.
  //
  // Limite de palavra dos dois lados: sem ele "codeina" apanhava
  // "codeinato" e, pior, radicais dentro de marcas.
  const desig = normalizar(p.designacao);
  for (const r of REGRAS_SUBSTANCIA) {
    const nome = normalizar(r.nome);
    if (!new RegExp(`(?:^|[^a-z0-9])${escapar(nome)}(?:[^a-z0-9]|$)`).test(desig)) continue;
    out.push({
      utilizacao: r.utilizacao,
      confianca: Number((r.confianca - PENALIZACAO_DESIGNACAO).toFixed(2)),
      regra: `Designação ${r.nome}`,
    });
  }

  if (p.subcategoria) {
    for (const r of REGRAS_SUBCATEGORIA) {
      if (r.nome === p.subcategoria) out.push({ utilizacao: r.utilizacao, confianca: r.confianca, regra: `Subcat ${r.nome}` });
    }
  }

  if (p.categoria) {
    for (const r of REGRAS_CATEGORIA) {
      if (r.nome === p.categoria) out.push({ utilizacao: r.utilizacao, confianca: r.confianca, regra: `Cat ${r.nome}` });
    }
  }

  for (const r of REGRAS_TEXTO) {
    if (r.tipos && !r.tipos.includes(p.productType ?? "")) continue;
    if (r.padrao.test(p.designacao)) {
      out.push({ utilizacao: r.utilizacao, confianca: r.confianca, regra: `Texto ${r.padrao.source.slice(0, 24)}` });
    }
  }

  // Utilizações implicadas: quem procura "Tosse" tem de encontrar também
  // os antitússicos e os expectorantes. Herda a confiança da origem — a
  // implicação é lógica, não um sinal novo — e só se aplica ao que já
  // passaria o limiar, para não promover um sinal fraco a duas linhas.
  for (const c of [...out]) {
    const geral = IMPLICACOES[c.utilizacao];
    if (geral && c.confianca >= MIN_CONFIANCA) {
      out.push({ utilizacao: geral, confianca: c.confianca, regra: `Implicação de ${c.utilizacao}` });
    }
  }

  // Duas regras podem apontar à mesma utilização. Fica a mais confiante —
  // não se somam sinais, porque duas pistas fracas não fazem uma forte.
  const melhor = new Map<string, Candidata>();
  for (const c of out) {
    const j = melhor.get(c.utilizacao);
    if (!j || c.confianca > j.confianca) melhor.set(c.utilizacao, c);
  }
  return [...melhor.values()];
}

/** Escapa metacaracteres para uso literal dentro de uma RegExp. */
function escapar(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Aplica as regras ao catálogo do tenant e regista a execução.
 *
 * Idempotente: uma associação MANUAL nunca é tocada, e uma automática só
 * cede a confiança superior. Correr duas vezes seguidas escreve zero na
 * segunda.
 */
export async function backfillUtilizacoes(
  prisma: PrismaClient,
  opts: { versaoRegras?: string | null } = {},
): Promise<ResultadoBackfill> {
  const vocab = await prisma.utilizacao.findMany({
    where: { estado: "ATIVO" },
    select: { id: true, slug: true },
  });
  const idPorSlug = new Map(vocab.map((v) => [v.slug, v.id]));
  if (idPorSlug.size === 0) {
    throw new Error("vocabulário vazio — correr seedUtilizacoes primeiro");
  }

  const produtos = await prisma.$queryRawUnsafe<ProdutoSinais[]>(
    `select p.id,
            p.designacao,
            p."productType",
            c1.nome as categoria,
            c2.nome as subcategoria,
            p."codigoATC",
            p."grupoHomogeneo",
            (r.cnp is not null) as "temRegulatorio"
       from "Produto" p
       left join "Classificacao"    c1 on c1.id = p."classificacaoNivel1Id"
       left join "Classificacao"    c2 on c2.id = p."classificacaoNivel2Id"
       left join "RegulatoryRecord" r  on r.cnp = p.cnp
      where p.cnp >= ${MIN_CNP}`,
  );

  const porUtilizacao = new Map<string, number>();
  const recusadasPorRegra = new Map<string, number>();
  const porTipo = new Map<string, { total: number; com: number }>();
  let recusadas = 0;
  let produtosCom = 0;
  let escritas = 0;

  for (const p of produtos) {
    const tipo = p.productType ?? "(por classificar)";
    const t = porTipo.get(tipo) ?? { total: 0, com: 0 };
    t.total++;

    const candidatas = avaliarProduto(p);
    for (const r of candidatas.filter((c) => c.confianca < MIN_CONFIANCA)) {
      recusadas++;
      recusadasPorRegra.set(r.regra, (recusadasPorRegra.get(r.regra) ?? 0) + 1);
    }
    const aceites = candidatas.filter((c) => c.confianca >= MIN_CONFIANCA);
    if (aceites.length) {
      t.com++;
      produtosCom++;
    }
    porTipo.set(tipo, t);

    for (const c of aceites) {
      const uid = idPorSlug.get(c.utilizacao);
      if (!uid) throw new Error(`regra aponta para utilização inexistente: ${c.utilizacao}`);
      porUtilizacao.set(c.utilizacao, (porUtilizacao.get(c.utilizacao) ?? 0) + 1);

      // MANUAL nunca é tocada; automática só cede a confiança superior.
      const n = await prisma.$executeRawUnsafe(
        `insert into "ProdutoUtilizacao" ("produtoId", "utilizacaoId", fonte, confianca)
         values ($1, $2, $3, $4)
         on conflict ("produtoId", "utilizacaoId") do update
            set fonte = excluded.fonte, confianca = excluded.confianca
          where "ProdutoUtilizacao".fonte <> 'MANUAL'
            and excluded.confianca > coalesce("ProdutoUtilizacao".confianca, 0)`,
        p.id,
        uid,
        FONTE,
        c.confianca,
      );
      escritas += Number(n) || 0;
    }
  }

  const associacoes = [...porUtilizacao.values()].reduce((s, n) => s + n, 0);
  const coberturaPercent = produtos.length
    ? Number(((produtosCom / produtos.length) * 100).toFixed(2))
    : 0;

  await prisma.catalogoBackfillRun.create({
    data: {
      kind: "utilizacoes",
      produtosAnalisados: produtos.length,
      produtosClassificados: produtosCom,
      associacoes,
      recusadas,
      coberturaPercent,
      limiarConfianca: MIN_CONFIANCA,
      versaoRegras: opts.versaoRegras ?? null,
      detalhes: {
        porTipo: Object.fromEntries(porTipo),
        topUtilizacoes: Object.fromEntries(
          [...porUtilizacao.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20),
        ),
        recusadasPorRegra: Object.fromEntries(recusadasPorRegra),
      },
    },
  });

  return {
    produtosAnalisados: produtos.length,
    produtosClassificados: produtosCom,
    associacoes,
    recusadas,
    coberturaPercent,
    escritas,
  };
}

/**
 * Há uploads fechados depois do último backfill?
 *
 * É esta comparação que substitui uma fila de pedidos. Pura, para se
 * poder testar sem base: recebe os dois instantes e decide.
 */
export function precisaBackfill(input: {
  ultimoUploadFinalizadoEm: Date | null;
  ultimoBackfillEm: Date | null;
}): boolean {
  const { ultimoUploadFinalizadoEm, ultimoBackfillEm } = input;
  // Sem upload nenhum não há produtos vindos do ERP para classificar.
  if (!ultimoUploadFinalizadoEm) return false;
  // Houve upload e nunca houve backfill: há trabalho.
  if (!ultimoBackfillEm) return true;
  return ultimoUploadFinalizadoEm > ultimoBackfillEm;
}
