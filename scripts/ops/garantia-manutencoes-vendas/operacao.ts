/**
 * scripts/ops/garantia-manutencoes-vendas/operacao.ts
 *
 * OPERAÇÃO ADMINISTRATIVA ÚNICA — reposição, na base do tenant `garantia`, dos
 * 36 registos históricos da «Manutenção de Evolução de Vendas» do sistema
 * anterior (dados.json). NÃO é uma funcionalidade: não há interface, endpoint,
 * importador genérico, tarefa nem sincronização. Só serve estes 36 registos.
 *
 * ── Mapeamento JSON → modelo real (ver notes/…garantia-manutencoes-vendas.md) ──
 *
 *   registo                   → 1 × VendaManutencao (cabeçalho)
 *   cada (mês × farmácia)     → 1 × VendaManutencaoCelula (30 por registo de 6 meses,
 *                               zeros incluídos — a matriz é guardada inteira)
 *   cada farmácia             → 1 × VendaManutencaoFarmacia com pvpReferencia = NULL
 *                               (o sistema antigo não tem PVP; nunca se inventa, nunca 0)
 *   cnp                       → Produto.cnp (resolvido no catálogo do tenant)
 *   quantidadeTotal           → Σ de TODAS as células. O modelo exige
 *                               Σ células === quantidadeTotal «sem excepção»
 *                               (validarSomaTotal); a «quantity» antiga é POR farmácia.
 *   mesInicial / numMeses     → primeiro mês da matriz / nº de linhas (contíguas)
 *   purchase_date, quantity antiga, totals antigos, designação antiga, prints de
 *   origem, derived_months    → NÃO existem no schema: ficam no AuditLog
 *                               (action venda_manutencao.reposicao_historica, uma
 *                               linha por registo) e no relatório da operação.
 *   origemDistribuicao        → MANUAL_AJUSTADA (não foi calculada pelo sistema)
 *   estado                    → ATIVA
 *
 * Identificadores TÉCNICOS determinísticos (prefixo `hg1`), derivados do conteúdo
 * completo do registo — nunca apresentados como número de documento do sistema
 * antigo (esse não foi transcrito). O prefixo é também o que identifica, de forma
 * inequívoca, os registos desta operação para a reversão.
 */
import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "../../../generated/prisma/client";

export const TENANT_ALVO = "garantia";
export const PREFIXO_ID = "hg1_";
const PREFIXO_CELULA = "hg1c_";
const PREFIXO_PVP = "hg1f_";
export const ACAO_AUDITORIA = "venda_manutencao.reposicao_historica";
export const ACAO_AUDITORIA_REVERSAO = "venda_manutencao.reposicao_historica_revertida";
/** Ordem das colunas da matriz do ficheiro de dados. */
export const COLUNAS = ["Garantia", "Principal", "Castelo", "Pereiro", "Nogueira"] as const;
export type Coluna = (typeof COLUNAS)[number];

// ─── Tipos do ficheiro ───────────────────────────────────────────────

export type RegistoJson = {
  source?: string;
  completion_source?: string;
  side?: string;
  cnp: string;
  designation: string;
  purchase_date: string;
  quantity: number;
  number_months: number;
  complete: boolean;
  derived_months?: string[];
  totals: number[];
  months: Array<[string, number, number, number, number, number]>;
  [k: string]: unknown;
};
export type DocumentoJson = { source_columns?: string[]; notes?: string[]; records: RegistoJson[] };

export type Registo = {
  indice: number;
  cnp: number;
  designacaoLegada: string;
  dataCompra: string;
  quantidadeLegada: number;
  numMeses: number;
  mesInicialAno: number;
  mesInicialMes: number;
  meses: Array<{ ano: number; mes: number; valores: number[] }>;
  totaisLegados: number[];
  quantidadeTotal: number;
  origem: { source?: string; completion_source?: string; side?: string; derived_months?: string[] };
  hash: string;
  headerId: string;
};

// ─── Validação (antes de qualquer escrita) ───────────────────────────

const dataValida = (s: unknown): boolean => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const inteiroNaoNeg = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

export function validarDocumento(doc: DocumentoJson, esperados = 36): string[] {
  const erros: string[] = [];
  const recs = doc?.records;
  if (!Array.isArray(recs)) return ["`records` não é uma lista."];
  if (recs.length !== esperados) erros.push(`Esperados exactamente ${esperados} registos, recebidos ${recs.length}.`);
  const principais = new Set<string>();
  recs.forEach((r, i) => {
    const t = `registo ${i + 1} (CNP ${r?.cnp})`;
    if (r.complete !== true) erros.push(`${t}: complete !== true.`);
    if ("missing_months" in r || "missing_totals" in r) erros.push(`${t}: contém os campos antigos missing_months/missing_totals.`);
    if (typeof r.cnp !== "string" || !/^\d{7}$/.test(r.cnp)) erros.push(`${t}: CNP com formato inválido.`);
    if (!dataValida(r.purchase_date)) erros.push(`${t}: purchase_date inválida.`);
    if (!inteiroNaoNeg(r.quantity)) erros.push(`${t}: quantity inválida.`);
    if (!Array.isArray(r.months) || r.months.length !== r.number_months || !Number.isInteger(r.number_months) || r.number_months < 1) {
      erros.push(`${t}: nº de linhas mensais (${r.months?.length}) ≠ number_months (${r.number_months}).`);
      return;
    }
    if (!Array.isArray(r.totals) || r.totals.length !== COLUNAS.length || !r.totals.every(inteiroNaoNeg)) {
      erros.push(`${t}: totals inválidos.`);
      return;
    }
    const soma = COLUNAS.map(() => 0);
    const vistos = new Set<string>();
    let anterior: number | null = null;
    for (const linha of r.months) {
      const [ym, ...valores] = linha;
      const m = /^(\d{4})-(\d{2})$/.exec(String(ym));
      if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) {
        erros.push(`${t}: mês inválido «${ym}».`);
        continue;
      }
      if (vistos.has(ym)) erros.push(`${t}: mês duplicado ${ym}.`);
      vistos.add(ym);
      const ordinal = Number(m[1]) * 12 + Number(m[2]) - 1;
      if (anterior !== null && ordinal !== anterior + 1) erros.push(`${t}: meses não contíguos/ascendentes em ${ym} (o modelo guarda mês inicial + nº de meses).`);
      anterior = ordinal;
      if (valores.length !== COLUNAS.length || !valores.every(inteiroNaoNeg)) {
        erros.push(`${t}: ${ym} não tem ${COLUNAS.length} valores inteiros ≥ 0.`);
        continue;
      }
      valores.forEach((v, k) => (soma[k] += v));
    }
    COLUNAS.forEach((c, k) => {
      if (soma[k] !== r.totals[k]) erros.push(`${t}: soma mensal da coluna ${c} (${soma[k]}) ≠ totals (${r.totals[k]}).`);
    });
    const chave = `${r.cnp}|${r.months[0]?.[0]}|${r.number_months}`;
    if (principais.has(chave)) erros.push(`${t}: dois registos com a mesma identidade principal (CNP, mês inicial, nº de meses).`);
    principais.add(chave);
  });
  return erros;
}

// ─── Identidade determinística ───────────────────────────────────────

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export function normalizarRegistos(doc: DocumentoJson): Registo[] {
  return doc.records.map((r, indice) => {
    const meses = r.months.map(([ym, ...valores]) => {
      const [ano, mes] = ym.split("-").map(Number);
      return { ano, mes, valores };
    });
    const hash = sha(
      JSON.stringify({
        v: 1,
        tenant: TENANT_ALVO,
        cnp: r.cnp,
        dataCompra: r.purchase_date,
        quantidade: r.quantity,
        numMeses: r.number_months,
        colunas: COLUNAS,
        meses: r.months,
      }),
    );
    return {
      indice: indice + 1,
      cnp: Number(r.cnp),
      designacaoLegada: r.designation,
      dataCompra: r.purchase_date,
      quantidadeLegada: r.quantity,
      numMeses: r.number_months,
      mesInicialAno: meses[0].ano,
      mesInicialMes: meses[0].mes,
      meses,
      totaisLegados: r.totals,
      quantidadeTotal: meses.reduce((s, m) => s + m.valores.reduce((a, b) => a + b, 0), 0),
      origem: { source: r.source, completion_source: r.completion_source, side: r.side, derived_months: r.derived_months },
      hash,
      headerId: PREFIXO_ID + hash.slice(0, 24),
    };
  });
}

// ─── Farmácias ───────────────────────────────────────────────────────

const normalizarNome = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !["farmacia", "da", "do", "de", "das", "dos"].includes(t))
    .join(" ");

export type FarmaciaBd = { id: string; nome: string; estado: string };
export type ResolucaoFarmacias = {
  resolvidas: Partial<Record<Coluna, { id: string; nome: string; estado: string; via: "nome" | "id-explicito" }>>;
  erros: string[];
};

/**
 * Cada coluna tem de ter EXACTAMENTE uma farmácia (nome sem «Farmácia»/artigos/
 * acentos/maiúsculas igual ao rótulo) e nenhuma farmácia pode servir duas colunas.
 * `explicitas` (rótulo → id) permite fixar o id depois de ver o dry-run; tem de existir.
 */
export function resolverFarmacias(farmacias: readonly FarmaciaBd[], explicitas: Partial<Record<Coluna, string>> = {}): ResolucaoFarmacias {
  const out: ResolucaoFarmacias = { resolvidas: {}, erros: [] };
  for (const col of COLUNAS) {
    const fixo = explicitas[col];
    if (fixo) {
      const f = farmacias.find((x) => x.id === fixo);
      if (!f) out.erros.push(`${col}: o id explícito «${fixo}» não existe no tenant.`);
      else out.resolvidas[col] = { ...f, via: "id-explicito" };
      continue;
    }
    const cands = farmacias.filter((f) => normalizarNome(f.nome) === normalizarNome(col));
    if (cands.length === 0) out.erros.push(`${col}: nenhuma farmácia do tenant corresponde (zero correspondências).`);
    else if (cands.length > 1) out.erros.push(`${col}: correspondência ambígua (${cands.map((c) => `${c.nome} [${c.id}]`).join("; ")}).`);
    else out.resolvidas[col] = { ...cands[0], via: "nome" };
  }
  const usadas = new Map<string, string[]>();
  for (const [col, f] of Object.entries(out.resolvidas)) usadas.set(f!.id, [...(usadas.get(f!.id) ?? []), col]);
  for (const [id, cols] of usadas) if (cols.length > 1) out.erros.push(`A farmácia ${id} serve mais do que uma coluna (${cols.join(", ")}).`);
  return out;
}

// ─── Plano (dry-run) ─────────────────────────────────────────────────

export type EstadoRegisto = "NOVO" | "JA_EXISTENTE" | "CONFLITO" | "PRODUTO_INEXISTENTE" | "FARMACIAS_NAO_RESOLVIDAS";

export type ItemPlano = {
  indice: number;
  cnp: number;
  dataCompra: string;
  numMeses: number;
  mesInicial: string;
  quantidadeLegada: number;
  quantidadeTotal: number;
  totaisLegados: number[];
  totaisDiferemDaQuantidade: boolean;
  produtoId: string | null;
  headerId: string;
  estado: EstadoRegisto;
  detalhe?: string;
  existenteId?: string;
  celulas: number;
};

export type Plano = {
  errosValidacao: string[];
  farmacias: ResolucaoFarmacias;
  itens: ItemPlano[];
  bloqueios: string[];
};

type Existente = {
  id: string;
  produtoId: string;
  cnp: number;
  quantidadeTotal: Prisma.Decimal | number;
  numMeses: number;
  mesInicialAno: number;
  mesInicialMes: number;
  celulas: Array<{ farmaciaId: string; ano: number; mes: number; quantidade: Prisma.Decimal | number }>;
};

const chaveCelula = (f: string, a: number, m: number) => `${f}|${a}|${m}`;

function celulasEsperadas(r: Registo, farmacias: ResolucaoFarmacias["resolvidas"]) {
  const out: Array<{ farmaciaId: string; coluna: Coluna; ano: number; mes: number; quantidade: number }> = [];
  for (const m of r.meses) COLUNAS.forEach((c, k) => out.push({ farmaciaId: farmacias[c]!.id, coluna: c, ano: m.ano, mes: m.mes, quantidade: m.valores[k] }));
  return out;
}

function iguais(e: Existente, r: Registo, produtoId: string, farmacias: ResolucaoFarmacias["resolvidas"]): string | null {
  if (e.produtoId !== produtoId) return "produto diferente";
  if (Number(e.quantidadeTotal) !== r.quantidadeTotal) return `quantidadeTotal ${Number(e.quantidadeTotal)} ≠ ${r.quantidadeTotal}`;
  if (e.numMeses !== r.numMeses || e.mesInicialAno !== r.mesInicialAno || e.mesInicialMes !== r.mesInicialMes) return "período diferente";
  const esperadas = celulasEsperadas(r, farmacias);
  if (e.celulas.length !== esperadas.length) return `${e.celulas.length} células ≠ ${esperadas.length}`;
  const mapa = new Map(e.celulas.map((c) => [chaveCelula(c.farmaciaId, c.ano, c.mes), Number(c.quantidade)]));
  for (const c of esperadas) {
    const v = mapa.get(chaveCelula(c.farmaciaId, c.ano, c.mes));
    if (v === undefined) return `falta a célula ${c.coluna} ${c.ano}-${String(c.mes).padStart(2, "0")}`;
    if (v !== c.quantidade) return `${c.coluna} ${c.ano}-${String(c.mes).padStart(2, "0")}: ${v} ≠ ${c.quantidade}`;
  }
  return null;
}

/** READ-ONLY: só consultas. */
export async function planear(
  prisma: Pick<PrismaClient, "produto" | "farmacia" | "vendaManutencao">,
  doc: DocumentoJson,
  opcoes: { farmaciasExplicitas?: Partial<Record<Coluna, string>>; esperados?: number } = {},
): Promise<Plano> {
  const errosValidacao = validarDocumento(doc, opcoes.esperados ?? 36);
  if (errosValidacao.length > 0) {
    return { errosValidacao, farmacias: { resolvidas: {}, erros: [] }, itens: [], bloqueios: [...errosValidacao] };
  }
  const registos = normalizarRegistos(doc);
  const farmacias = resolverFarmacias(await prisma.farmacia.findMany({ select: { id: true, nome: true, estado: true } }), opcoes.farmaciasExplicitas);
  const cnps = [...new Set(registos.map((r) => r.cnp))];
  const produtos = await prisma.produto.findMany({ where: { cnp: { in: cnps } }, select: { id: true, cnp: true } });
  const produtoPorCnp = new Map<number, string[]>();
  for (const p of produtos) produtoPorCnp.set(p.cnp, [...(produtoPorCnp.get(p.cnp) ?? []), p.id]);

  const sel = {
    id: true, produtoId: true, cnp: true, quantidadeTotal: true, numMeses: true, mesInicialAno: true, mesInicialMes: true,
    celulas: { select: { farmaciaId: true, ano: true, mes: true, quantidade: true } },
  } as const;
  const porId = new Map<string, Existente>(
    (await prisma.vendaManutencao.findMany({ where: { id: { in: registos.map((r) => r.headerId) } }, select: sel })).map((e) => [e.id, e as Existente]),
  );
  const candidatos = (await prisma.vendaManutencao.findMany({ where: { cnp: { in: cnps }, estado: "ATIVA" }, select: sel })) as Existente[];

  const bloqueios: string[] = [...farmacias.erros];
  const itens: ItemPlano[] = registos.map((r) => {
    const base = {
      indice: r.indice, cnp: r.cnp, dataCompra: r.dataCompra, numMeses: r.numMeses,
      mesInicial: `${r.mesInicialAno}-${String(r.mesInicialMes).padStart(2, "0")}`,
      quantidadeLegada: r.quantidadeLegada, quantidadeTotal: r.quantidadeTotal, totaisLegados: r.totaisLegados,
      totaisDiferemDaQuantidade: r.totaisLegados.some((t) => t !== r.quantidadeLegada),
      headerId: r.headerId, celulas: r.numMeses * COLUNAS.length,
    };
    const ids = produtoPorCnp.get(r.cnp) ?? [];
    if (ids.length !== 1) {
      const detalhe = ids.length === 0 ? "CNP inexistente no catálogo do tenant" : `CNP duplicado (${ids.length} produtos)`;
      bloqueios.push(`registo ${r.indice} (CNP ${r.cnp}): ${detalhe}.`);
      return { ...base, produtoId: null, estado: "PRODUTO_INEXISTENTE", detalhe } as ItemPlano;
    }
    const produtoId = ids[0];
    if (farmacias.erros.length > 0 || COLUNAS.some((c) => !farmacias.resolvidas[c])) {
      return { ...base, produtoId, estado: "FARMACIAS_NAO_RESOLVIDAS" } as ItemPlano;
    }
    const existentePorId = porId.get(r.headerId);
    if (existentePorId) {
      const dif = iguais(existentePorId, r, produtoId, farmacias.resolvidas);
      if (dif === null) return { ...base, produtoId, estado: "JA_EXISTENTE", existenteId: existentePorId.id } as ItemPlano;
      bloqueios.push(`registo ${r.indice} (CNP ${r.cnp}): o id ${r.headerId} existe com conteúdo divergente (${dif}).`);
      return { ...base, produtoId, estado: "CONFLITO", detalhe: dif, existenteId: existentePorId.id } as ItemPlano;
    }
    // Preexistente criado por outra via (ex.: à mão) com a mesma identidade principal.
    const mesmos = candidatos.filter((c) => c.produtoId === produtoId && c.mesInicialAno === r.mesInicialAno && c.mesInicialMes === r.mesInicialMes && c.numMeses === r.numMeses);
    for (const c of mesmos) {
      const dif = iguais(c, r, produtoId, farmacias.resolvidas);
      if (dif === null) return { ...base, produtoId, estado: "JA_EXISTENTE", existenteId: c.id, detalhe: "equivalente preexistente" } as ItemPlano;
    }
    if (mesmos.length > 0) {
      const dif = iguais(mesmos[0], r, produtoId, farmacias.resolvidas);
      bloqueios.push(`registo ${r.indice} (CNP ${r.cnp}): já existe uma manutenção ATIVA com o mesmo CNP/mês inicial/nº de meses mas conteúdo divergente (${dif}).`);
      return { ...base, produtoId, estado: "CONFLITO", detalhe: dif ?? "divergente", existenteId: mesmos[0].id } as ItemPlano;
    }
    return { ...base, produtoId, estado: "NOVO" } as ItemPlano;
  });
  return { errosValidacao, farmacias, itens, bloqueios };
}

// ─── Contagens e aplicação ───────────────────────────────────────────

export type Contagens = {
  vendaManutencao: number;
  vendaManutencaoCelula: number;
  vendaManutencaoFarmacia: number;
  farmacia: number;
  produto: number;
  desteConjunto: { cabecalhos: number; celulas: number; farmaciasPvp: number };
};

export async function contar(prisma: PrismaClient): Promise<Contagens> {
  const [a, b, c, d, e, f] = await Promise.all([
    prisma.vendaManutencao.count(),
    prisma.vendaManutencaoCelula.count(),
    prisma.vendaManutencaoFarmacia.count(),
    prisma.farmacia.count(),
    prisma.produto.count(),
    prisma.$queryRaw<Array<{ h: bigint; c: bigint; f: bigint }>>`
      SELECT (SELECT count(*) FROM "VendaManutencao" WHERE left("id", 4) = 'hg1_') AS h,
             (SELECT count(*) FROM "VendaManutencaoCelula" WHERE left("manutencaoId", 4) = 'hg1_') AS c,
             (SELECT count(*) FROM "VendaManutencaoFarmacia" WHERE left("manutencaoId", 4) = 'hg1_') AS f`,
  ]);
  return {
    vendaManutencao: a, vendaManutencaoCelula: b, vendaManutencaoFarmacia: c, farmacia: d, produto: e,
    desteConjunto: { cabecalhos: Number(f[0].h), celulas: Number(f[0].c), farmaciasPvp: Number(f[0].f) },
  };
}

export type ResultadoAplicacao = {
  cabecalhosCriados: number;
  linhasMensaisCriadas: number;
  itensPorFarmaciaCriados: number;
  celulasCriadas: number;
  manutencoesCriadas: Array<{ id: string; cnp: number; headerId: string; indice: number; celulas: number; somaCelulas: number }>;
  celulaIds: string[];
  farmaciaPvpIds: string[];
};

/**
 * Escreve os registos NOVOS numa única transacção. Recusa se houver qualquer
 * bloqueio. Qualquer erro (inclusive a verificação final) reverte tudo.
 * `falharNoRegisto` existe só para o teste de rollback.
 */
export async function aplicarPlano(
  prisma: PrismaClient,
  doc: DocumentoJson,
  plano: Plano,
  ctx: { utilizadorEmail: string; ficheiroHash: string; falharNoRegisto?: number },
): Promise<ResultadoAplicacao> {
  if (plano.bloqueios.length > 0) throw new Error(`--apply recusado: ${plano.bloqueios.length} bloqueio(s): ${plano.bloqueios.slice(0, 5).join(" | ")}`);
  const utilizador = await prisma.utilizador.findFirst({ where: { email: { equals: ctx.utilizadorEmail.trim(), mode: "insensitive" } }, select: { id: true } });
  if (!utilizador) throw new Error(`--apply recusado: o utilizador «${ctx.utilizadorEmail}» não existe neste tenant.`);

  const registos = normalizarRegistos(doc);
  const novos = plano.itens.filter((i) => i.estado === "NOVO");
  const f = plano.farmacias.resolvidas;
  const fid = (c: Coluna) => f[c]!.id;
  const res: ResultadoAplicacao = {
    cabecalhosCriados: 0, linhasMensaisCriadas: 0, itensPorFarmaciaCriados: 0, celulasCriadas: 0,
    manutencoesCriadas: [], celulaIds: [], farmaciaPvpIds: [],
  };

  await prisma.$transaction(
    async (tx) => {
      let n = 0;
      for (const item of novos) {
        n++;
        const r = registos.find((x) => x.indice === item.indice)!;
        await tx.vendaManutencao.create({
          data: {
            id: r.headerId,
            produtoId: item.produtoId!,
            cnp: r.cnp,
            quantidadeTotal: r.quantidadeTotal,
            numMeses: r.numMeses,
            mesInicialAno: r.mesInicialAno,
            mesInicialMes: r.mesInicialMes,
            origemDistribuicao: "MANUAL_AJUSTADA",
            estado: "ATIVA",
            criadoPorId: utilizador.id,
          },
        });
        const celulas = celulasEsperadas(r, f).map((c) => ({
          id: PREFIXO_CELULA + sha(`${r.hash}|${c.coluna}|${c.ano}-${c.mes}`).slice(0, 24),
          manutencaoId: r.headerId, farmaciaId: c.farmaciaId, ano: c.ano, mes: c.mes, quantidade: c.quantidade,
        }));
        await tx.vendaManutencaoCelula.createMany({ data: celulas });
        const pvps = COLUNAS.map((c) => ({
          id: PREFIXO_PVP + sha(`${r.hash}|${c}`).slice(0, 24), manutencaoId: r.headerId, farmaciaId: fid(c), pvpReferencia: null,
        }));
        await tx.vendaManutencaoFarmacia.createMany({ data: pvps });
        await tx.auditLog.create({
          data: {
            actorId: utilizador.id,
            action: ACAO_AUDITORIA,
            entity: "VendaManutencao",
            entityId: r.headerId,
            metaJson: JSON.stringify({
              operacao: "garantia-reposicao-manutencoes-vendas",
              ficheiroSha256: ctx.ficheiroHash,
              cnp: r.cnp,
              designacaoSistemaAnterior: r.designacaoLegada,
              dataCompra: r.dataCompra,
              quantidadeSistemaAnterior: r.quantidadeLegada,
              totaisSistemaAnterior: Object.fromEntries(COLUNAS.map((c, k) => [c, r.totaisLegados[k]])),
              quantidadeTotalGravada: r.quantidadeTotal,
              origem: r.origem,
              pvpReferencia: null,
            }),
          },
        });
        if (ctx.falharNoRegisto === n) throw new Error(`FALHA_FORCADA_TESTE no registo ${n}`);
        res.cabecalhosCriados++;
        res.linhasMensaisCriadas += r.numMeses;
        res.itensPorFarmaciaCriados += pvps.length;
        res.celulasCriadas += celulas.length;
        res.celulaIds.push(...celulas.map((c) => c.id));
        res.farmaciaPvpIds.push(...pvps.map((p) => p.id));
        res.manutencoesCriadas.push({
          id: r.headerId, cnp: r.cnp, headerId: r.headerId, indice: r.indice, celulas: celulas.length,
          somaCelulas: celulas.reduce((s, c) => s + c.quantidade, 0),
        });
      }
      // Verificação final DENTRO da transacção: nada órfão, nada a mais, nada a menos.
      const ids = res.manutencoesCriadas.map((m) => m.id);
      const [h, c, p] = await Promise.all([
        tx.vendaManutencao.count({ where: { id: { in: ids } } }),
        tx.vendaManutencaoCelula.count({ where: { manutencaoId: { in: ids } } }),
        tx.vendaManutencaoFarmacia.count({ where: { manutencaoId: { in: ids } } }),
      ]);
      if (h !== res.cabecalhosCriados || c !== res.celulasCriadas || p !== res.itensPorFarmaciaCriados) {
        throw new Error(`Verificação final falhou (cabeçalhos ${h}/${res.cabecalhosCriados}, células ${c}/${res.celulasCriadas}, pvp ${p}/${res.itensPorFarmaciaCriados}).`);
      }
    },
    { timeout: 120_000, maxWait: 20_000 },
  );
  return res;
}

// ─── Reversão ────────────────────────────────────────────────────────

export type ResultadoReversao = {
  alvos: number;
  jaRevertidos: string[];
  alteradosDepois: string[];
  removidos: string[];
  celulasRemovidas: number;
  aplicado: boolean;
};

/**
 * Remove EXCLUSIVAMENTE os registos listados no relatório do --apply (e só se o
 * id tiver o prefixo desta operação e o conteúdo não tiver sido alterado desde
 * então). Células e PVP saem por cascata. Nada mais é tocado; o AuditLog da
 * criação fica (e ganha uma linha de reversão).
 */
export async function reverter(
  prisma: PrismaClient,
  manutencoes: ReadonlyArray<{ id: string; celulas: number; somaCelulas: number }>,
  opcoes: { aplicar: boolean; utilizadorEmail?: string },
): Promise<ResultadoReversao> {
  const out: ResultadoReversao = { alvos: manutencoes.length, jaRevertidos: [], alteradosDepois: [], removidos: [], celulasRemovidas: 0, aplicado: false };
  for (const m of manutencoes) if (!m.id.startsWith(PREFIXO_ID)) throw new Error(`Reversão recusada: o id «${m.id}» não pertence a esta operação (prefixo ${PREFIXO_ID}).`);
  const existentes = await prisma.vendaManutencao.findMany({
    where: { id: { in: manutencoes.map((m) => m.id) } },
    select: { id: true, celulas: { select: { quantidade: true } } },
  });
  const porId = new Map(existentes.map((e) => [e.id, e]));
  const aRemover: string[] = [];
  for (const m of manutencoes) {
    const e = porId.get(m.id);
    if (!e) { out.jaRevertidos.push(m.id); continue; }
    const soma = e.celulas.reduce((s, c) => s + Number(c.quantidade), 0);
    if (e.celulas.length !== m.celulas || soma !== m.somaCelulas) { out.alteradosDepois.push(m.id); continue; }
    aRemover.push(m.id);
  }
  if (out.alteradosDepois.length > 0) throw new Error(`Reversão recusada: ${out.alteradosDepois.length} registo(s) foram alterados depois da operação (${out.alteradosDepois.join(", ")}).`);
  out.removidos = aRemover;
  out.celulasRemovidas = aRemover.length === 0 ? 0 : (await prisma.vendaManutencaoCelula.count({ where: { manutencaoId: { in: aRemover } } }));
  if (!opcoes.aplicar || aRemover.length === 0) return out;

  const utilizador = opcoes.utilizadorEmail
    ? await prisma.utilizador.findFirst({ where: { email: { equals: opcoes.utilizadorEmail.trim(), mode: "insensitive" } }, select: { id: true } })
    : null;
  await prisma.$transaction(async (tx) => {
    const r = await tx.vendaManutencao.deleteMany({ where: { id: { in: aRemover, }, AND: [{ id: { startsWith: PREFIXO_ID } }] } });
    if (r.count !== aRemover.length) throw new Error(`Reversão: removidos ${r.count} ≠ ${aRemover.length}.`);
    await tx.auditLog.createMany({
      data: aRemover.map((id) => ({ actorId: utilizador?.id ?? null, action: ACAO_AUDITORIA_REVERSAO, entity: "VendaManutencao", entityId: id, metaJson: JSON.stringify({ operacao: "garantia-reposicao-manutencoes-vendas" }) })),
    });
  });
  out.aplicado = true;
  return out;
}
