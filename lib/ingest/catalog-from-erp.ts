/**
 * lib/ingest/catalog-from-erp.ts
 *
 * Enriquecimento do catálogo central a partir do ERP da farmácia.
 *
 * O SPharm local já conhece DCI, ATC, Grupo Homogéneo e Fabricante —
 * são campos operacionais de que a farmácia precisa para dispensar e
 * substituir por genérico. Reconstruí-los pela Internet é trabalho a
 * dobrar e de pior qualidade. Cada instalação nova passa a melhorar o
 * catálogo central nestes quatro campos.
 *
 * ── Confiança ────────────────────────────────────────────────────────
 * O ERP é uma fonte forte (o Softreis sincroniza dados do INFARMED),
 * mas não é o INFARMED. Fica em 0.90: acima de qualquer inferência
 * (marca, retalho, consenso), abaixo de um registo regulamentar directo.
 *
 * Daí as três regras de escrita:
 *   1. Campo a NULL         → preenche.
 *   2. Campo com valor de confiança INFERIOR → substitui.
 *   3. Campo com valor de confiança IGUAL OU SUPERIOR → não toca.
 *
 * A confiança do valor existente lê-se de duas provas já disponíveis,
 * sem inventar schema: existir `RegulatoryRecord` para o CNP (o valor
 * veio, ou pode ter vindo, do INFARMED) e existir `EnrichmentSourceLog`
 * com confiança >= à nossa a declarar esse campo.
 *
 * ── Códigos internos ─────────────────────────────────────────────────
 * CNP < 2 000 000 são códigos internos da farmácia. Não são identidade
 * de catálogo e nunca alimentam o catálogo regulamentar central.
 */

import type { PrismaClient } from "@/generated/prisma/client";
import { classifyProductType, CLASSIFICATION_VERSION } from "@/lib/catalog-classifier";

/** Confiança atribuída ao ERP da farmácia como fonte de catálogo. */
export const ERP_CONFIDENCE = 0.9;

/** Tag de proveniência gravada em EnrichmentSourceLog.source. */
export const ERP_SOURCE = "spharm_erp";

const MIN_CNP = 2_000_000;

/** Campos que este caminho pode escrever. */
const CAMPOS = ["dci", "codigoATC", "grupoHomogeneo", "fabricante", "productType"] as const;
type Campo = (typeof CAMPOS)[number];

export type ErpCatalogRow = {
  cnp: number;
  dci: string | null;
  codigoATC: string | null;
  grupoHomogeneo: string | null;
  fabricante: string | null;
};

export type ErpCatalogResult = {
  /** Produtos considerados (CNP elegível e com pelo menos um campo). */
  candidatos: number;
  /** Campos escritos, por campo. */
  preenchidos: Record<Campo, number>;
  /** Campos substituídos por terem proveniência mais fraca. */
  substituidos: Record<Campo, number>;
  /** Campos não tocados por já terem fonte igual ou mais forte. */
  preservados: Record<Campo, number>;
};

function zeros(): Record<Campo, number> {
  return { dci: 0, codigoATC: 0, grupoHomogeneo: 0, fabricante: 0, productType: 0 };
}

export function limpar(v: string | null): string | null {
  if (v === null) return null;
  const t = v.trim();
  if (!t) return null;
  // "N/A", "-", "0" e afins aparecem no ERP como marcador de vazio.
  if (/^(n\/?a|-+|0|sem|nao definido|não definido)$/i.test(t)) return null;
  return t;
}

/**
 * ATC canónico: 1 letra + 2 dígitos + até 2 letras + até 2 dígitos.
 * Um valor que não case não é um ATC e não entra no catálogo — é
 * preferível não ter ATC a ter lixo que depois alimenta o mapeamento
 * de categorias.
 */
export function limparAtc(v: string | null): string | null {
  const t = limpar(v);
  if (!t) return null;
  const u = t.toUpperCase().replace(/\s+/g, "");
  return /^[A-Z]\d{2}([A-Z]{1,2}(\d{2})?)?$/.test(u) ? u : null;
}

export function normalizarFabricante(v: string | null): string | null {
  const t = limpar(v);
  if (!t) return null;
  const n = t
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9 &.\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return n.length >= 2 && n.length <= 60 ? n : null;
}

export type Decisao = "preencher" | "substituir" | "preservar" | "nada";

/**
 * Precedência do tipo de produto, isolada para poder ser testada.
 *
 * Ao contrário dos outros campos, aqui a confiança do valor existente é
 * legível directamente em `Produto.productTypeConfidence`. A regra é uma
 * só e não admite excepções: NUNCA despromover. Uma classificação por
 * consenso de marca (0.75) não pode substituir uma por flag MSRM (0.99),
 * por mais recente que seja.
 *
 * OUTRO nunca é escrito: não é uma classificação, é a ausência de uma.
 */
export function decidirTipo(
  novoTipo: string,
  novaConf: number,
  tipoActual: string | null,
  confActual: number | null,
): Decisao {
  if (novoTipo === "OUTRO") return "nada";
  if (tipoActual === null) return "preencher";
  if (novaConf > (confActual ?? 0)) {
    return tipoActual === novoTipo ? "nada" : "substituir";
  }
  return tipoActual === novoTipo ? "nada" : "preservar";
}

/**
 * A regra de escrita, isolada da base de dados para poder ser testada.
 *
 * `fonteForte` significa: já existe prova de que o valor actual veio de
 * uma fonte de confiança igual ou superior ao ERP (registo regulamentar
 * para o CNP, ou log de enriquecimento com confiança >= 0.90).
 *
 *   sem valor novo            → nada
 *   valor igual ao actual     → nada        (idempotência)
 *   campo vazio               → preencher   (regra 1)
 *   ocupado por fonte fraca   → substituir  (regra 2)
 *   ocupado por fonte forte   → preservar   (regra 3)
 */
export function decidirEscrita(
  novo: string | null,
  actual: string | null,
  fonteForte: boolean,
): Decisao {
  if (!novo) return "nada";
  if (actual === novo) return "nada";
  if (actual === null) return "preencher";
  if (fonteForte) return "preservar";
  return "substituir";
}

/**
 * Enriquece o catálogo central com os campos regulamentares vindos do ERP.
 *
 * Idempotente: uma segunda corrida com os mesmos dados não muda nada e
 * não volta a registar proveniência.
 */
export async function applyErpCatalogFields(
  prisma: PrismaClient,
  rows: ErpCatalogRow[],
): Promise<ErpCatalogResult> {
  const res: ErpCatalogResult = {
    candidatos: 0,
    preenchidos: zeros(),
    substituidos: zeros(),
    preservados: zeros(),
  };

  // Normalizar e descartar o que não tem nada de útil a dizer.
  const uteis = rows
    .filter((r) => Number.isInteger(r.cnp) && r.cnp >= MIN_CNP)
    .map((r) => ({
      cnp: r.cnp,
      dci: limpar(r.dci),
      codigoATC: limparAtc(r.codigoATC),
      grupoHomogeneo: limpar(r.grupoHomogeneo),
      fabricante: normalizarFabricante(r.fabricante),
    }))
    .filter((r) => r.dci || r.codigoATC || r.grupoHomogeneo || r.fabricante);

  if (uteis.length === 0) return res;
  res.candidatos = uteis.length;

  const cnps = uteis.map((r) => r.cnp);

  // Estado actual do catálogo para estes CNPs.
  const existentes = await prisma.produto.findMany({
    where: { cnp: { in: cnps } },
    select: {
      id: true,
      cnp: true,
      dci: true,
      codigoATC: true,
      grupoHomogeneo: true,
      fabricanteId: true,
      // Necessários para classificar o tipo com os sinais do ERP.
      designacao: true,
      flagMSRM: true,
      flagMNSRM: true,
      flagGenerico: true,
      tipoArtigo: true,
      productType: true,
      productTypeConfidence: true,
      // O nome normalizado é preciso para comparar com o do ERP: sem ele
      // cada corrida veria "valor diferente" e reescreveria o mesmo
      // fabricante para sempre.
      fabricante: { select: { nomeNormalizado: true } },
    },
  });
  const porCnp = new Map(existentes.map((p) => [p.cnp, p]));

  // Prova 1: o CNP tem registo regulamentar? Se tem, os campos que ele
  // cobre são de confiança superior à nossa e não se tocam.
  const regs = await prisma.regulatoryRecord.findMany({
    where: { cnp: { in: cnps } },
    select: { cnp: true, dci: true, codigoATC: true, titularAim: true },
  });
  const regPorCnp = new Map(regs.map((r) => [r.cnp, r]));

  // Prova 2: já houve uma fonte tão ou mais confiante a declarar o campo?
  const ids = existentes.map((p) => p.id);
  const logs = ids.length
    ? await prisma.enrichmentSourceLog.findMany({
        where: {
          produtoId: { in: ids },
          confidence: { gte: ERP_CONFIDENCE },
          source: { not: ERP_SOURCE },
        },
        select: { produtoId: true, fieldsReturned: true },
      })
    : [];
  const fortesPorProduto = new Map<string, Set<string>>();
  for (const l of logs) {
    if (!fortesPorProduto.has(l.produtoId)) fortesPorProduto.set(l.produtoId, new Set());
    const s = fortesPorProduto.get(l.produtoId)!;
    for (const f of l.fieldsReturned) s.add(f);
  }

  // Fabricantes: resolver nomes → ids, criando os que faltarem.
  const nomesFab = [...new Set(uteis.map((r) => r.fabricante).filter((x): x is string => !!x))];
  const fabPorNome = new Map<string, string>();
  if (nomesFab.length) {
    const jaExistem = await prisma.fabricante.findMany({
      where: { nomeNormalizado: { in: nomesFab } },
      select: { id: true, nomeNormalizado: true },
    });
    for (const f of jaExistem) fabPorNome.set(f.nomeNormalizado, f.id);
    for (const nome of nomesFab) {
      if (fabPorNome.has(nome)) continue;
      const criado = await prisma.fabricante.upsert({
        where: { nomeNormalizado: nome },
        create: { nomeNormalizado: nome },
        update: {},
        select: { id: true },
      });
      fabPorNome.set(nome, criado.id);
    }
  }

  for (const r of uteis) {
    const produto = porCnp.get(r.cnp);
    if (!produto) continue; // produto ainda não existe no catálogo central
    const reg = regPorCnp.get(r.cnp);
    const fortes = fortesPorProduto.get(produto.id) ?? new Set<string>();

    const dados: Record<string, string | null> = {};
    // Separado de `dados` porque leva números e não só strings.
    const dadosExtra: Record<string, string | number> = {};
    const escritos: string[] = [];

    const decidir = (
      campo: Campo,
      novo: string | null,
      actual: string | null,
      regTemValor: boolean,
    ) => decidirEscrita(novo, actual, regTemValor || fortes.has(campo));

    const aplicar = (campo: Campo, novo: string | null, actual: string | null, regTem: boolean) => {
      const acao = decidir(campo, novo, actual, regTem);
      if (acao === "nada") return;
      if (acao === "preservar") {
        res.preservados[campo]++;
        return;
      }
      if (campo === "fabricante") {
        const fabId = fabPorNome.get(novo!);
        if (!fabId) return;
        dados.fabricanteId = fabId;
      } else {
        dados[campo] = novo;
      }
      escritos.push(campo);
      if (acao === "preencher") res.preenchidos[campo]++;
      else res.substituidos[campo]++;
    };

    aplicar("dci", r.dci, produto.dci, !!reg?.dci);
    aplicar("codigoATC", r.codigoATC, produto.codigoATC, !!reg?.codigoATC);
    // O RegulatoryRecord não guarda Grupo Homogéneo, por isso não há
    // prova regulamentar a proteger este campo — só um log forte o faz.
    aplicar("grupoHomogeneo", r.grupoHomogeneo, produto.grupoHomogeneo, false);
    aplicar(
      "fabricante",
      r.fabricante,
      produto.fabricanteId ? " existe" : null,
      !!reg?.titularAim,
    );

    // ── ProductType ────────────────────────────────────────────────
    //
    // O ERP dá os sinais mais fortes que existem para decidir o que um
    // produto é: flagMSRM/MNSRM, genérico, ATC e grupo homogéneo. Aplicar
    // o classificador aqui evita que o builder vá descobrir depois, por
    // texto, algo que a farmácia já sabia.
    //
    // Precedência pela própria confiança, que já está gravada em
    // Produto.productTypeConfidence: só escreve se o campo estiver vazio
    // ou se a nova classificação for MAIS confiante. Nunca despromove.
    // Reutiliza os valores do ERP recém-decididos acima (ATC, grupo
    // homogéneo) mesmo antes de estarem gravados — é a informação mais
    // fresca que existe sobre este produto.
    const atcParaTipo = (dados.codigoATC as string | undefined) ?? produto.codigoATC;
    const ghParaTipo = (dados.grupoHomogeneo as string | undefined) ?? produto.grupoHomogeneo;
    const cls = classifyProductType({
      designacao: produto.designacao,
      tipoArtigo: produto.tipoArtigo,
      flagMSRM: produto.flagMSRM,
      flagMNSRM: produto.flagMNSRM,
      codigoATC: atcParaTipo,
      flagGenerico: produto.flagGenerico,
      hasRegulatoryRecord: !!reg,
      hasGrupoHomogeneo: !!ghParaTipo,
    });
    // OUTRO não é uma classificação, é a ausência de uma: gravá-lo
    // transformaria "não sei" em "já tratado".
    const acaoTipo = decidirTipo(
      cls.productType,
      cls.confidence,
      produto.productType,
      produto.productTypeConfidence,
    );
    if (acaoTipo === "preencher" || acaoTipo === "substituir") {
      dadosExtra.productType = cls.productType;
      dadosExtra.productTypeConfidence = cls.confidence;
      dadosExtra.classificationSource = cls.classificationSource;
      dadosExtra.classificationVersion = CLASSIFICATION_VERSION;
      escritos.push("productType");
      if (acaoTipo === "preencher") res.preenchidos.productType++;
      else res.substituidos.productType++;
    } else if (acaoTipo === "preservar") {
      res.preservados.productType++;
    }

    if (escritos.length === 0) continue;

    await prisma.produto.update({
      where: { id: produto.id },
      data: { ...dados, ...dadosExtra, dataAtualizacao: new Date() },
    });
    await prisma.enrichmentSourceLog.create({
      data: {
        produtoId: produto.id,
        source: ERP_SOURCE,
        status: "SUCCESS",
        confidence: ERP_CONFIDENCE,
        matchedBy: "cnp",
        fieldsReturned: escritos,
      },
    });
  }

  return res;
}
