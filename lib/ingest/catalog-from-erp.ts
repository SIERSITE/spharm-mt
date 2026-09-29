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
 *
 * ── Fabricante partilhado entre várias farmácias do MESMO tenant ───────
 * `dci`/`codigoATC`/`grupoHomogeneo` seguem as três regras acima
 * (`decidirEscrita`, por confiança). `fabricante` é diferente: quando
 * várias farmácias do mesmo tenant partilham o MESMO `Produto` (catálogo
 * comum), cada uma tem o seu próprio ERP, e podem discordar. Duas
 * situações:
 *
 *   - Tenant SEM farmácia autoritativa configurada (`Farmacia.
 *     autoridadeCatalogo`, ver lib/farmacia-catalogo.ts — é o default
 *     histórico, para todos os tenants): `decidirFabricanteBaseline`
 *     decide por farmácia+CNP, simetricamente — nenhuma farmácia manda
 *     mais do que outra, cada uma só reage a MUDANÇAS no que ELA PRÓPRIA
 *     observou.
 *   - Tenant COM farmácia autoritativa: essa farmácia manda sempre
 *     (excepto `validadoManualmente`) — `decidirFabricanteDaAutoridade`
 *     substitui a decisão de escrita, comparando sempre contra o
 *     catálogo ACTUAL, nunca contra a história da própria farmácia. As
 *     restantes farmácias do tenant nunca alteram `Produto.fabricanteId`
 *     — o valor delas fica só em `ProdutoFarmacia.fabricanteErpAtual`,
 *     como informação local.
 */

import type { PrismaClient } from "@/generated/prisma/client";
import { classifyProductType, CLASSIFICATION_VERSION } from "@/lib/catalog-classifier";
import { normalizeFabricanteCanonico } from "@/lib/catalog-normalizers";
import { getFarmaciaAutoridadeCatalogo } from "@/lib/farmacia-catalogo";

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

/**
 * Delega em `normalizeFabricanteCanonico` (lib/catalog-normalizers.ts) —
 * mesma função usada pela correcção via listagem regulatória e por
 * `getOrCreateFabricante`. Manteve o nome/assinatura originais deste
 * ficheiro por compatibilidade com quem já importa `normalizarFabricante`
 * daqui (ex. scripts/tests/test-catalog-from-erp.ts); a única mudança de
 * comportamento é que pontos de abreviatura ("Lda.", "S.A.") deixam de
 * sobreviver à normalização — eram precisamente a causa de "Lda." e "Lda"
 * nunca convergirem.
 */
export function normalizarFabricante(v: string | null): string | null {
  const t = limpar(v);
  if (!t) return null;
  return normalizeFabricanteCanonico(t);
}

export type Decisao = "preencher" | "substituir" | "preservar" | "nada";

export type DecisaoFabricanteBaseline = {
  /** true = escrever `Produto.fabricanteId` com `novoCanonico`. */
  escrever: boolean;
  /** true só na primeira observação desta farmácia+CNP (baseline era null). */
  primeiroCiclo: boolean;
  /** true quando `ProdutoFarmacia.fabricanteErpBaseline` deve avançar para `novoCanonico`. */
  avancaBaseline: boolean;
  /** true só quando é uma mudança REAL pós-baseline (nunca no 1º ciclo). */
  mudou: boolean;
  motivo: string;
};

/**
 * Baseline de fabricante ERP por farmácia+CNP — substitui `fonteForte`
 * (RegulatoryRecord/EnrichmentSourceLog) como autoridade para ESTE campo
 * neste caminho. Isolada e pura para ser exaustivamente testável sem BD.
 *
 * Porque substitui `fonteForte` em vez de se somar a ela: uma correcção
 * via listagem regulatória escreve `RegulatoryRecord.titularAim`, o que
 * tornaria `fonteForte` verdadeiro para sempre — bloqueando até uma
 * mudança FUTURA legítima no ERP da farmácia. O baseline decide por
 * frescura observada (mudou desde a última vez que olhámos PARA ESTA
 * FARMÁCIA?), não por hierarquia de fonte estática.
 *
 * `validadoManualmente` continua a ser avaliado — é a ÚNICA protecção que
 * sobrevive deste campo, exactamente como antes.
 *
 * Ordem de avaliação:
 *   1. baseline === null (nunca observámos esta farmácia+CNP antes):
 *        estabelece baseline sempre; só ESCREVE se o campo estiver vazio
 *        e não houver validadoManualmente — nunca substitui um valor já
 *        existente no primeiro ciclo (é aí que uma correcção via listagem
 *        fica protegida contra o ERP antigo).
 *   2. baseline === novoCanonico: sem mudança desde a última vez — nunca
 *      escreve, mesmo que difira do que está gravado no SPharm.MT.
 *   3. baseline !== novoCanonico: mudança REAL confirmada — escreve e
 *      avança o baseline, EXCEPTO se validadoManualmente bloquear (nesse
 *      caso o baseline NÃO avança, para a mudança continuar a ser
 *      reportada em cada ciclo enquanto a protecção manual existir).
 */
export function decidirFabricanteBaseline(input: {
  baseline: string | null;
  novoCanonico: string;
  fabricanteAtualNormalizado: string | null;
  validadoManualmente: boolean;
}): DecisaoFabricanteBaseline {
  const { baseline, novoCanonico, fabricanteAtualNormalizado, validadoManualmente } = input;

  if (baseline === null) {
    const podeEscrever = !validadoManualmente && fabricanteAtualNormalizado === null;
    return {
      escrever: podeEscrever,
      primeiroCiclo: true,
      avancaBaseline: true,
      mudou: false,
      motivo: podeEscrever
        ? "primeiro ciclo desta farmácia+CNP, campo vazio — preenche"
        : "primeiro ciclo desta farmácia+CNP — só estabelece baseline, nunca substitui",
    };
  }

  if (baseline === novoCanonico) {
    return {
      escrever: false,
      primeiroCiclo: false,
      avancaBaseline: false,
      mudou: false,
      motivo: "ERP sem mudança desde o baseline — não toca, mesmo que difira do SPharm.MT",
    };
  }

  if (validadoManualmente) {
    return {
      escrever: false,
      primeiroCiclo: false,
      avancaBaseline: false,
      mudou: false,
      motivo: "mudança real detectada desde o baseline, mas bloqueada por validadoManualmente",
    };
  }

  return {
    escrever: true,
    primeiroCiclo: false,
    avancaBaseline: true,
    mudou: true,
    motivo: "mudança real confirmada desde o baseline — corrige mesmo que o valor actual viesse de listagem corrigida",
  };
}

export type DecisaoFabricanteAutoridade = {
  /** true = escrever `Produto.fabricanteId` com `novoFabricanteId`. */
  escrever: boolean;
  /** true quando o valor resolvido difere do que está gravado — só para diagnóstico/bookkeeping, nunca decide sozinho (validadoManualmente pode bloquear mesmo com mudou=true). */
  mudou: boolean;
  motivo: string;
};

/**
 * Decisão de escrita quando a origem é a farmácia AUTORITATIVA de
 * catálogo do tenant (ver Farmacia.autoridadeCatalogo,
 * lib/farmacia-catalogo.ts) — substitui `decidirFabricanteBaseline`
 * para ESTA farmácia especificamente. Diferença central: compara-se
 * sempre contra o `Produto.fabricanteId` ACTUAL do catálogo partilhado,
 * nunca contra a observação anterior da PRÓPRIA farmácia — para poder
 * REAFIRMAR o valor correcto mesmo que outra farmácia (ou qualquer
 * outro processo) o tenha alterado entretanto. `decidirFabricanteBaseline`
 * continua a correr em paralelo só para manter o bookkeeping por-farmácia
 * (fabricanteErpBaseline/Atual/*SeenAt) — nunca para decidir a escrita
 * aqui.
 *
 * Compara por ID resolvido (já passado por alias, ver `fabPorNome` em
 * `applyErpCatalogFields`), nunca por texto normalizado — dois nomes
 * textualmente diferentes ("GENERIS DIRECTO" vs "GENERIS FARMACEUTICA
 * S A PORTUGAL") podem resolver ao MESMO Fabricante.id via
 * FabricanteAlias, e nesse caso NÃO há mudança nenhuma a fazer.
 *
 * A ÚNICA protecção que sobrevive é `validadoManualmente` — a mesma
 * regra de bloqueio de sempre, e a mesma dos outros campos deste
 * ficheiro.
 */
export function decidirFabricanteDaAutoridade(input: {
  novoFabricanteId: string;
  fabricanteIdActual: string | null;
  validadoManualmente: boolean;
}): DecisaoFabricanteAutoridade {
  const { novoFabricanteId, fabricanteIdActual, validadoManualmente } = input;

  if (novoFabricanteId === fabricanteIdActual) {
    return { escrever: false, mudou: false, motivo: "origem autoritativa: valor já coincide com o catálogo partilhado — idempotente" };
  }
  if (validadoManualmente) {
    return { escrever: false, mudou: true, motivo: "origem autoritativa detectou mudança, mas bloqueada por validadoManualmente" };
  }
  return { escrever: true, mudou: true, motivo: "origem autoritativa — substitui o fabricante actual do catálogo partilhado" };
}

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
  /**
   * Farmácia de onde este batch veio — obrigatório desde que o fabricante
   * passou a usar baseline por farmácia+CNP em vez de `fonteForte`
   * (ver `decidirFabricanteBaseline`). Os outros campos (dci/codigoATC/
   * grupoHomogeneo) continuam a ignorar isto — só afecta fabricante.
   */
  farmaciaId: string,
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
      // Guarda extra para o fabricante: uma ficha validada à mão por um
      // humano é mais autoritativa que o ERP (SourceTier.MANUAL > ERP_FARMACIA)
      // mesmo sem o campo estar em `camposManuais`, que só cobre
      // designacao/flagGenerico/flagMnsrmNCompart.
      validadoManualmente: true,
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

  // Fabricantes: resolver nomes → ids, com alias — antes desta correcção
  // isto criava/reaproveitava só por `nomeNormalizado` exacto, ignorando
  // por completo `FabricanteAlias`; um valor de ERP como "GENERIS
  // DIRECTO" nunca resolvia ao canónico "GENERIS FARMACEUTICA S A
  // PORTUGAL" mesmo que esse alias já existisse (registado por revisão
  // manual, xlsx, ou correcção regulamentar) — criava sempre um
  // Fabricante novo, literal, com o nome do ERP. Geral, para todos os
  // tenants — nunca específico de nenhum nome de fabricante.
  const nomesFab = [...new Set(uteis.map((r) => r.fabricante).filter((x): x is string => !!x))];
  const fabPorNome = new Map<string, string>();
  if (nomesFab.length) {
    const jaExistem = await prisma.fabricante.findMany({
      where: { nomeNormalizado: { in: nomesFab } },
      select: { id: true, nomeNormalizado: true },
    });
    for (const f of jaExistem) fabPorNome.set(f.nomeNormalizado, f.id);

    const faltamPorNome = nomesFab.filter((n) => !fabPorNome.has(n));
    if (faltamPorNome.length) {
      const viaAlias = await prisma.fabricanteAlias.findMany({
        where: { aliasNome: { in: faltamPorNome } },
        select: { aliasNome: true, fabricanteId: true },
      });
      for (const a of viaAlias) fabPorNome.set(a.aliasNome, a.fabricanteId);

      for (const nome of faltamPorNome) {
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
  }

  // Autoridade de catálogo do tenant desta ligação (ver
  // lib/farmacia-catalogo.ts) — `null` preserva o comportamento
  // histórico (todas as farmácias simétricas, ver decidirFabricanteBaseline).
  const autoridade = await getFarmaciaAutoridadeCatalogo(prisma);

  // Baseline de fabricante ERP desta farmácia — ver decidirFabricanteBaseline.
  // Só os produtos com fabricante útil no payload precisam disto.
  const produtoIdsComFabricante = existentes
    .filter((p) => uteis.some((r) => r.cnp === p.cnp && r.fabricante))
    .map((p) => p.id);
  const baselinesExistentes = produtoIdsComFabricante.length
    ? await prisma.produtoFarmacia.findMany({
        where: { produtoId: { in: produtoIdsComFabricante }, farmaciaId },
        select: { produtoId: true, fabricanteErpBaseline: true },
      })
    : [];
  const baselinePorProduto = new Map(baselinesExistentes.map((pf) => [pf.produtoId, pf.fabricanteErpBaseline]));

  const agora = new Date();
  const pfUpdates: { produtoId: string; data: Record<string, string | Date> }[] = [];

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

    // Fabricante: baseline por farmácia+CNP (decidirFabricanteBaseline)
    // continua a correr SEMPRE, para TODAS as farmácias — é o que
    // mantém `ProdutoFarmacia.fabricanteErpAtual`/Baseline/*SeenAt
    // actualizados por farmácia (incluindo as que NÃO são autoridade —
    // o valor delas fica guardado como informação local, nunca perdido).
    // NÃO É esta decisão, porém, que manda escrever `Produto.fabricanteId`
    // quando o tenant tem uma farmácia autoritativa configurada — ver
    // `decidirFabricanteDaAutoridade` abaixo. `pfUpdates` grava o
    // bookkeeping em ProdutoFarmacia depois do loop, para AMBOS os casos.
    if (r.fabricante) {
      const baseline = baselinePorProduto.get(produto.id) ?? null;
      const decisaoBaseline = decidirFabricanteBaseline({
        baseline,
        novoCanonico: r.fabricante,
        fabricanteAtualNormalizado: produto.fabricante?.nomeNormalizado ?? null,
        validadoManualmente: produto.validadoManualmente,
      });

      const pfData: Record<string, string | Date> = {
        fabricanteErpAtual: r.fabricante,
        fabricanteErpLastSeenAt: agora,
      };
      if (decisaoBaseline.primeiroCiclo) pfData.fabricanteErpFirstSeenAt = agora;
      if (decisaoBaseline.avancaBaseline) pfData.fabricanteErpBaseline = r.fabricante;
      if (decisaoBaseline.mudou) pfData.fabricanteErpChangedAt = agora;
      pfUpdates.push({ produtoId: produto.id, data: pfData });

      const novoFabricanteId = fabPorNome.get(r.fabricante);
      let escrever = decisaoBaseline.escrever;
      let primeiroCicloOuVazio = decisaoBaseline.primeiroCiclo;

      if (autoridade) {
        if (farmaciaId === autoridade.id) {
          // Esta farmácia É a autoridade de catálogo do tenant — a sua
          // própria história de baseline deixa de gatilhar a escrita;
          // decide sempre contra o estado ACTUAL do catálogo partilhado,
          // para poder REAFIRMAR o valor correcto mesmo que outra
          // farmácia o tenha alterado entretanto.
          const decisaoAutoridade = novoFabricanteId
            ? decidirFabricanteDaAutoridade({
                novoFabricanteId,
                fabricanteIdActual: produto.fabricanteId,
                validadoManualmente: produto.validadoManualmente,
              })
            : { escrever: false, mudou: false, motivo: "sem Fabricante resolvido" };
          escrever = decisaoAutoridade.escrever;
          primeiroCicloOuVazio = produto.fabricanteId === null;
        } else {
          // Tenant TEM autoridade configurada e esta farmácia NÃO é ela
          // — o valor fica só como informação local (pfData acima),
          // nunca altera Produto.fabricanteId, seja qual for o veredicto
          // do baseline por-farmácia.
          escrever = false;
        }
      }

      if (escrever && novoFabricanteId) {
        dados.fabricanteId = novoFabricanteId;
        escritos.push("fabricante");
        if (primeiroCicloOuVazio) res.preenchidos.fabricante++;
        else res.substituidos.fabricante++;
      } else {
        res.preservados.fabricante++;
      }
    }

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

  // Baseline de fabricante ERP: grava/actualiza por último, depois de
  // todas as decisões de Produto.fabricanteId já terem sido tomadas.
  // Upsert (não update) porque `ProdutoFarmacia` desta farmácia pode
  // ainda não existir neste momento do pedido — `bulkUpsertProdutoFarmaciaProducts`
  // só corre depois disto no endpoint (ver bootstrap/products/route.ts).
  // As colunas aqui gravadas não colidem com as desse bulk (SET explícito
  // por coluna, ON CONFLICT DO UPDATE — ver lib/ingest/bulk.ts).
  for (const u of pfUpdates) {
    await prisma.produtoFarmacia.upsert({
      where: { produtoId_farmaciaId: { produtoId: u.produtoId, farmaciaId } },
      create: { produtoId: u.produtoId, farmaciaId, ...u.data },
      update: u.data,
    });
  }

  return res;
}
