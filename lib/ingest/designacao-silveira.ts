/**
 * lib/ingest/designacao-silveira.ts
 *
 * Autoridade da DESIGNAÇÃO do produto — EXCLUSIVA do tenant `silveira`
 * (`TENANT_DESIGNACAO_AUTORITATIVA`) e EXCLUSIVA do campo `Produto.designacao`.
 * NÃO é uma "farmácia principal" genérica nem um mecanismo reutilizável: não
 * toca em fabricante, fornecedor, fornecedor habitual, preços, stock, vendas,
 * classificações nem em nenhum outro campo, e não existe fora deste tenant.
 *
 * ── A regra ──────────────────────────────────────────────────────────
 *
 * No tenant `silveira` há duas farmácias que enviam o mesmo catálogo.
 * Quem escreve `Produto.designacao` depende de QUEM está a sincronizar:
 *
 *   farmácia Silveirense (autoritativa)
 *       a designação não vazia recebida É a designação do produto: se
 *       difere da actual, substitui-a — em cada sincronização (diária,
 *       "Sincronizar agora", onboarding), sem depender de o ERP ter marcado
 *       o produto como alterado.
 *
 *   qualquer outra farmácia do tenant (Segurado)
 *       só ESCREVE a designação ao CRIAR o produto (para não nascer sem
 *       nome). Num produto que já existe, nunca a altera — é isto que
 *       impede a Segurado de reverter a designação da Silveirense, no mesmo
 *       dia ou no seguinte, em qualquer ordem de execução.
 *
 * Nunca usa fabricante, fornecedor, ordem de execução nem "primeira farmácia
 * sincronizada" para decidir. Um produto que nunca aparece na Silveirense
 * fica com a designação com que foi criado.
 *
 * Designações vazias/só espaços NUNCA substituem nada. O valor escrito é a
 * designação enviada pelo ERP, só com os espaços exteriores e as repetições
 * de espaço técnicas (NBSP, tabs, quebras) normalizados — capitalização e
 * pontuação preservadas.
 *
 * `camposManuais`: a designação é a ÚNICA excepção. O CNP identifica um
 * produto comum a todas as farmácias e a designação é única no catálogo
 * partilhado; por isso a designação válida da Silveirense substitui a actual
 * MESMO que `"designacao"` esteja em `camposManuais`. Todos os outros campos
 * em `camposManuais` (flagGenerico, flagMnsrmNCompart, …) continuam
 * protegidos — esta regra nem lhes toca. As outras farmácias nunca alteram a
 * designação de um produto existente, manual ou não.
 *
 * ── Que farmácia é a Silveirense ─────────────────────────────────────
 *
 * Pelo identificador estável que a base já tem — `Farmacia.codigoANF` —
 * comparado com a variável de ambiente `SILVEIRA_DESIGNACAO_AUTORITATIVA_CODIGO_ANF`.
 * Nunca pelo texto visível do nome, nunca por um id aleatório gravado no
 * código, nunca "a primeira farmácia". Se a configuração não identificar
 * EXACTAMENTE uma farmácia ACTIVA, a resolução falha de forma explícita
 * (erro tipado, registado e devolvido na resposta da ingestão) e o tenant
 * fica em modo seguro: NINGUÉM altera designações existentes até se corrigir
 * a configuração (criação de produtos novos continua a funcionar).
 *
 * Sem migration: usa uma coluna que já existe.
 */
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { TENANT_DESIGNACAO_AUTORITATIVA } from "@/lib/tenant-constants";
import { bulkUpsertProdutosByCnp } from "@/lib/ingest/bulk";

export const ENV_CODIGO_ANF_DESIGNACAO = "SILVEIRA_DESIGNACAO_AUTORITATIVA_CODIGO_ANF";

// ─── Regra pura ──────────────────────────────────────────────────────

/**
 * A designação como se escreve na base: sem espaços exteriores e com
 * qualquer sequência de espaços/NBSP/tabs/quebras reduzida a um espaço.
 * `null` se não sobrar nada (vazio, só espaços, null/undefined).
 * Não mexe em capitalização, acentos nem pontuação.
 */
export function normalizarDesignacao(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/[\s\p{Z}]+/gu, " ").trim();
  return s === "" ? null : s;
}

/**
 * `LEGACY`        — comportamento de sempre (todos os outros tenants).
 * `AUTORITATIVA`  — farmácia Silveirense no tenant silveira.
 * `SO_CRIACAO`    — outra farmácia do tenant silveira (ou configuração inválida):
 *                   a designação só é escrita quando o produto é criado.
 */
export type ModoDesignacao = "LEGACY" | "AUTORITATIVA" | "SO_CRIACAO";

export type DecisaoDesignacao =
  | "CRIAR"
  | "ALTERAR"
  | "IGUAL"
  | "IGNORADA_ORIGEM"
  | "IGNORADA_MANUAL"
  | "IGNORADA_VAZIA";

export type DesignacaoExistente = { designacao: string; camposManuais: readonly string[] };

/** A decisão para UM produto. Pura; é o contrato que o SQL tem de cumprir. */
export function decidirDesignacao(input: {
  modo: ModoDesignacao;
  existente: DesignacaoExistente | null;
  recebida: unknown;
}): DecisaoDesignacao {
  const nova = normalizarDesignacao(input.recebida);
  if (nova === null) return "IGNORADA_VAZIA";
  if (input.existente === null) return "CRIAR";
  if (input.modo === "SO_CRIACAO") {
    return nova === input.existente.designacao ? "IGUAL" : "IGNORADA_ORIGEM";
  }
  // LEGACY (outros tenants): a protecção de `camposManuais` mantém-se. AUTORITATIVA
  // (Silveirense, tenant silveira): a designação ignora `camposManuais`.
  if (input.modo === "LEGACY" && input.existente.camposManuais.includes("designacao")) return "IGNORADA_MANUAL";
  return nova === input.existente.designacao ? "IGUAL" : "ALTERAR";
}

export type EstatisticasDesignacao = {
  /** Produtos criados nesta chamada (a designação inicial veio desta farmácia). */
  criadas: number;
  /** (só farmácia autoritativa) produtos existentes com designação recebida e comparada. */
  verificadas: number;
  /** (só autoritativa) designações realmente substituídas. */
  alteradas: number;
  /** (só autoritativa) já iguais ao valor recebido — nada escrito. */
  jaIguais: number;
  /** (só não autoritativa) designação recebida diferente da existente, ignorada. */
  ignoradasOrigemNaoAutoritativa: number;
  /** Recebida vazia/só espaços — ignorada. */
  ignoradasVazias: number;
  /** Protegida por `camposManuais` — só modo LEGACY; na Silveirense é sempre 0 (a designação ignora `camposManuais`). */
  ignoradasManual: number;
  /** Erros ao aplicar (itens que falharam no caminho de recurso). */
  erros: number;
};

export function estatisticasVazias(): EstatisticasDesignacao {
  return {
    criadas: 0,
    verificadas: 0,
    alteradas: 0,
    jaIguais: 0,
    ignoradasOrigemNaoAutoritativa: 0,
    ignoradasVazias: 0,
    ignoradasManual: 0,
    erros: 0,
  };
}

/** Acumula as decisões de um lote. Pura. */
export function contarDecisoes(
  modo: ModoDesignacao,
  decisoes: readonly DecisaoDesignacao[],
): EstatisticasDesignacao {
  const e = estatisticasVazias();
  for (const d of decisoes) {
    switch (d) {
      case "CRIAR":
        e.criadas++;
        break;
      case "ALTERAR":
        e.verificadas++;
        e.alteradas++;
        break;
      case "IGUAL":
        if (modo === "AUTORITATIVA") {
          e.verificadas++;
          e.jaIguais++;
        }
        break;
      case "IGNORADA_MANUAL":
        e.verificadas++;
        e.ignoradasManual++;
        break;
      case "IGNORADA_ORIGEM":
        e.ignoradasOrigemNaoAutoritativa++;
        break;
      case "IGNORADA_VAZIA":
        e.ignoradasVazias++;
        break;
    }
  }
  return e;
}

// ─── Identificação da farmácia ───────────────────────────────────────

export type CodigoErroAutoridade = "NAO_CONFIGURADO" | "NAO_ENCONTRADA" | "AMBIGUA" | "INATIVA";

export type EstadoAutoridadeDesignacao =
  | { aplica: false }
  | { aplica: true; valida: true; farmaciaId: string; farmaciaNome: string; codigoANF: string }
  | { aplica: true; valida: false; codigo: CodigoErroAutoridade; mensagem: string };

/** Comparação do código: sem espaços exteriores e sem distinguir maiúsculas. */
export function normalizarCodigoANF(v: string | null | undefined): string {
  return (v ?? "").trim().toLowerCase();
}

/**
 * Resolve qual é a farmácia autoritativa do tenant. Fora do tenant `silveira`
 * devolve `{ aplica: false }` SEM tocar na base nem na configuração.
 *
 * Falha de forma explícita (`valida: false` + código + mensagem) se a
 * configuração não identificar exactamente UMA farmácia activa.
 */
export async function resolverAutoridadeDesignacao(
  prisma: Pick<PrismaClient, "farmacia">,
  tenantSlug: string,
  env: Record<string, string | undefined> = process.env,
): Promise<EstadoAutoridadeDesignacao> {
  if (tenantSlug !== TENANT_DESIGNACAO_AUTORITATIVA) return { aplica: false };

  const configurado = normalizarCodigoANF(env[ENV_CODIGO_ANF_DESIGNACAO]);
  if (configurado === "") {
    return {
      aplica: true,
      valida: false,
      codigo: "NAO_CONFIGURADO",
      mensagem: `${ENV_CODIGO_ANF_DESIGNACAO} não está definida: nenhuma farmácia é autoritativa para a designação.`,
    };
  }

  const farmacias = await prisma.farmacia.findMany({
    select: { id: true, nome: true, codigoANF: true, estado: true },
  });
  const candidatas = farmacias.filter((f) => normalizarCodigoANF(f.codigoANF) === configurado);
  if (candidatas.length === 0) {
    return {
      aplica: true,
      valida: false,
      codigo: "NAO_ENCONTRADA",
      mensagem: `Nenhuma farmácia do tenant tem codigoANF "${configurado}".`,
    };
  }
  if (candidatas.length > 1) {
    return {
      aplica: true,
      valida: false,
      codigo: "AMBIGUA",
      mensagem: `${candidatas.length} farmácias do tenant têm codigoANF "${configurado}" — tem de ser exactamente uma.`,
    };
  }
  const f = candidatas[0];
  if (f.estado !== "ATIVO") {
    return {
      aplica: true,
      valida: false,
      codigo: "INATIVA",
      mensagem: `A farmácia com codigoANF "${configurado}" não está ACTIVA (${f.estado}).`,
    };
  }
  return { aplica: true, valida: true, farmaciaId: f.id, farmaciaNome: f.nome, codigoANF: f.codigoANF ?? configurado };
}

/** O modo de escrita da designação para a farmácia que está a sincronizar. */
export function modoParaFarmacia(estado: EstadoAutoridadeDesignacao, farmaciaId: string): ModoDesignacao {
  if (!estado.aplica) return "LEGACY";
  if (estado.valida && estado.farmaciaId === farmaciaId) return "AUTORITATIVA";
  // Outra farmácia, ou configuração inválida: modo seguro (nada se altera).
  return "SO_CRIACAO";
}

// ─── Aplicação em lote (apenas produtos que JÁ existem) ──────────────

export type ItemDesignacao = { cnp: number; designacao: unknown };

/**
 * Passo "só designações" da farmácia autoritativa: aplica o valor recebido aos
 * produtos que JÁ existem (nunca cria produtos — a criação é do caminho
 * normal de produtos). Escreve apenas onde o valor efectivo difere e a
 * designação não está protegida; o resto não gera escrita nenhuma.
 *
 * É a MESMA regra de `decidirDesignacao` (modo AUTORITATIVA), em SQL
 * set-based: o contador `alteradas` é o nº de linhas realmente actualizadas.
 *
 * O chamador tem de ter confirmado que a farmácia é a autoritativa.
 */
export async function aplicarDesignacoesAutoritativas(
  prisma: Pick<PrismaClient, "produto" | "$queryRaw">,
  itens: readonly ItemDesignacao[],
): Promise<EstatisticasDesignacao & { semProduto: number }> {
  const modo: ModoDesignacao = "AUTORITATIVA";
  // Último valor por CNP (como o upsert por lote).
  const porCnp = new Map<number, string | null>();
  const decisoesVazias: DecisaoDesignacao[] = [];
  for (const it of itens) {
    const nova = normalizarDesignacao(it.designacao);
    if (nova === null) {
      decisoesVazias.push("IGNORADA_VAZIA");
      continue;
    }
    porCnp.set(it.cnp, nova);
  }
  const cnps = [...porCnp.keys()];
  const existentes = cnps.length
    ? await prisma.produto.findMany({
        where: { cnp: { in: cnps } },
        select: { cnp: true, designacao: true, camposManuais: true },
      })
    : [];
  const porCnpExistente = new Map(existentes.map((p) => [p.cnp, p]));

  const decisoes: DecisaoDesignacao[] = [...decisoesVazias];
  const aAlterar: Array<{ cnp: number; designacao: string }> = [];
  let semProduto = 0;
  for (const [cnp, nova] of porCnp) {
    const ex = porCnpExistente.get(cnp);
    if (!ex) {
      semProduto++;
      continue;
    }
    const d = decidirDesignacao({ modo, existente: ex, recebida: nova });
    decisoes.push(d);
    if (d === "ALTERAR") aAlterar.push({ cnp, designacao: nova! });
  }
  const est = contarDecisoes(modo, decisoes);

  if (aAlterar.length > 0) {
    const valores = aAlterar.map((a) => Prisma.sql`(${a.cnp}::int, ${a.designacao}::text)`);
    const escritas = await prisma.$queryRaw<{ cnp: number }[]>(Prisma.sql`
      UPDATE "Produto" p
      SET "designacao" = v.d, "dataAtualizacao" = now()
      FROM (VALUES ${Prisma.join(valores)}) AS v(cnp, d)
      WHERE p."cnp" = v.cnp
        AND p."designacao" IS DISTINCT FROM v.d
      RETURNING p."cnp"
    `);
    // O nº REAL de escritas manda (uma alteração concorrente entre a leitura
    // e o UPDATE nunca é contada em duplicado).
    est.alteradas = escritas.length;
    est.jaIguais += aAlterar.length - escritas.length;
  }
  return { ...est, semProduto };
}

// ─── Orquestração partilhada (endpoint de produtos + testes) ─────────

/**
 * Resolve a autoridade e o modo da farmácia que sincroniza. Nunca lança: uma
 * falha a ler a base (ou uma configuração inválida) dá modo `SO_CRIACAO` com
 * o erro explícito em `autoridade` — o modo seguro, em que ninguém altera
 * designações existentes.
 */
export async function resolverModoDesignacao(
  prisma: Pick<PrismaClient, "farmacia">,
  tenantSlug: string,
  farmaciaId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<{ autoridade: EstadoAutoridadeDesignacao; modo: ModoDesignacao }> {
  let autoridade: EstadoAutoridadeDesignacao;
  try {
    autoridade = await resolverAutoridadeDesignacao(prisma, tenantSlug, env);
  } catch (err) {
    autoridade = {
      aplica: true,
      valida: false,
      codigo: "NAO_ENCONTRADA",
      mensagem: `falha a resolver a farmácia autoritativa: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
    };
  }
  return { autoridade, modo: modoParaFarmacia(autoridade, farmaciaId) };
}

export type LinhaProdutoDesignacao = {
  cnp: number;
  externalProductId: number | null;
  designacao: string;
  flagGenerico: boolean;
  flagMnsrmNCompart: boolean;
};

/**
 * Upsert de `Produto` por CNP COM a regra da designação do modo dado, e as
 * contagens dessa regra. Nos modos `AUTORITATIVA`/`SO_CRIACAO` os valores são
 * normalizados (espaços técnicos) antes de comparar e de escrever; em `LEGACY`
 * é exactamente `bulkUpsertProdutosByCnp` de sempre, sem leitura extra.
 *
 * `existentes` é o nº de CNP do lote que já existiam (antes do upsert).
 */
export async function upsertProdutosComDesignacao(
  prisma: PrismaClient,
  modo: ModoDesignacao,
  linhas: readonly LinhaProdutoDesignacao[],
): Promise<{ cnpToId: Map<number, string>; existentes: number; estatisticas: EstatisticasDesignacao | null }> {
  const cnps = linhas.map((l) => l.cnp);
  if (modo === "LEGACY") {
    const existentes = await prisma.produto.count({ where: { cnp: { in: cnps } } });
    const cnpToId = await bulkUpsertProdutosByCnp(prisma, [...linhas]);
    return { cnpToId, existentes, estatisticas: null };
  }
  // Linhas com designação vazia/só espaços (o btrim do SQL não apanha NBSP etc.)
  // nunca chegam ao upsert: um produto não nasce sem nome e um existente não
  // perde o seu. Contam-se como ignoradasVazias.
  const linhasNorm: LinhaProdutoDesignacao[] = [];
  let vazias = 0;
  for (const l of linhas) {
    const d = normalizarDesignacao(l.designacao);
    if (d === null) vazias++;
    else linhasNorm.push({ ...l, designacao: d });
  }
  const lidos = await prisma.produto.findMany({
    where: { cnp: { in: cnps } },
    select: { cnp: true, designacao: true, camposManuais: true },
  });
  const porCnp = new Map(lidos.map((e) => [e.cnp, e]));
  const estatisticas = contarDecisoes(
    modo,
    linhasNorm.map((l) => decidirDesignacao({ modo, existente: porCnp.get(l.cnp) ?? null, recebida: l.designacao })),
  );
  estatisticas.ignoradasVazias += vazias;
  const cnpToId = await bulkUpsertProdutosByCnp(prisma, linhasNorm, { designacao: modo });
  return { cnpToId, existentes: lidos.length, estatisticas };
}
