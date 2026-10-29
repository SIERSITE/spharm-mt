/**
 * scripts/diagnostics/auditoria-forma-farmaceutica.ts
 *
 * AUDITORIA SÓ DE LEITURA de `Produto.formaFarmaceutica` — o dado que alimenta o filtro «Forma farmacêutica» — para
 * UMA base de tenant de cada vez (pensada para correr nas bases reais, depois de revista).
 *
 *   npx tsx scripts/diagnostics/auditoria-forma-farmaceutica.ts \
 *       --url postgresql://utilizador:***@host:5432/spharmmt_t_<slug> --tenant <slug> --confirmo-read-only \
 *       [--out relatorio.md | relatorio.json] [--top 25]
 *
 * GARANTIAS
 *   · SÓ LEITURA, em três camadas independentes: (1) sessão com `default_transaction_read_only = on`; (2) uma única
 *     transacção `BEGIN READ ONLY` (o PostgreSQL recusa qualquer escrita nela); (3) só se executam instruções que
 *     começam por SELECT/WITH, verificado antes de cada envio. A transacção termina sempre em ROLLBACK.
 *   · EXIGE `--url` explícito (nunca lê DATABASE_URL do ambiente: não há forma de apanhar uma base por engano) e a flag
 *     `--confirmo-read-only`; sem ela recusa e não abre ligação.
 *   · EXIGE `--tenant <slug>`: o slug fica no relatório. O script liga-se a UMA base e nunca consulta outra — as formas
 *     de um tenant nunca são misturadas com as de outro. Se o nome da base não contiver o slug, avisa (não bloqueia).
 *   · NUNCA imprime a password: o relatório e as mensagens de erro só mostram `host:porta/base`.
 *   · A saída `--out` é um ficheiro LOCAL (.md ou .json); nunca se escreve na base.
 *
 * O QUE MEDE (descreve SÓ a base apontada)
 *   universo = produtos `estado <> 'INATIVO'` com `cnp > 2 000 000` (o mesmo universo das opções do filtro).
 *   · total, com e sem forma, % de cobertura;
 *   · principais formas (top N, por chave normalizada, com contagens);
 *   · variantes normalizadas: valores crus que colapsam na mesma chave (com contagem por variante);
 *   · colisões suspeitas: chaves que juntam valores crus que diferem em MAIS do que espaços/acentos/maiúsculas
 *     (verificado por uma normalização INDEPENDENTE da de produção — Unicode NFD); deve ser zero;
 *   · pares de formas muito parecidas que NÃO são agrupadas (distância de edição <= 2), para revisão humana;
 *   · produtos sem correspondência INFARMED e, desses, quantos não têm forma;
 *   · medicamentos vs não medicamentos (critério e limitação declarados no relatório).
 */
import { writeFileSync } from "node:fs";
import { Client } from "pg";
import { MIN_CNP_CATALOGAVEL } from "../../lib/catalog/cnp-catalogavel";
import {
  SEM_FORMA,
  ROTULO_SEM_FORMA,
  chaveFormaFarmaceutica,
  opcoesFormaFarmaceutica,
  type OpcaoFormaFarmaceutica,
} from "../../lib/catalog/forma-farmaceutica-filtro";

// ─── Argumentos ──────────────────────────────────────────────────────────────

export type ArgsAuditoria = {
  url: string;
  tenant: string;
  out: string | null;
  top: number;
};

export const FLAG_CONFIRMACAO = "--confirmo-read-only";

/** Valida os argumentos. Lança `Error` com mensagem SEM a password. */
export function lerArgs(argv: readonly string[]): ArgsAuditoria {
  const valor = (nome: string): string | null => {
    const i = argv.indexOf(nome);
    if (i >= 0) return argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
    const prefixo = `${nome}=`;
    const a = argv.find((x) => x.startsWith(prefixo));
    return a ? a.slice(prefixo.length) : null;
  };
  if (!argv.includes(FLAG_CONFIRMACAO)) {
    throw new Error(`Recusado: falta a flag ${FLAG_CONFIRMACAO}. Este comando é SÓ DE LEITURA, mas exige confirmação explícita antes de abrir qualquer ligação.`);
  }
  const url = valor("--url");
  if (!url) throw new Error("Recusado: passe a base a auditar com --url postgresql://… (explícito; DATABASE_URL do ambiente NÃO é usada).");
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("Recusado: --url não é um URL válido.");
  }
  if (u.protocol !== "postgresql:" && u.protocol !== "postgres:") throw new Error("Recusado: --url tem de ser postgresql://.");
  const tenant = valor("--tenant");
  if (!tenant || !/^[a-z0-9][a-z0-9_-]{0,62}$/i.test(tenant)) throw new Error("Recusado: passe --tenant <slug> (ex.: silveira, garantia).");
  const out = valor("--out");
  if (out && !/\.(md|json)$/i.test(out)) throw new Error("Recusado: --out tem de terminar em .md ou .json.");
  const topBruto = valor("--top");
  const top = topBruto ? Number(topBruto) : 25;
  if (!Number.isInteger(top) || top < 1 || top > 500) throw new Error("Recusado: --top tem de ser um inteiro entre 1 e 500.");
  return { url, tenant, out, top };
}

/** `host:porta/base` — nunca utilizador nem password. */
export function descreverDestino(url: string): string {
  const u = new URL(url);
  return `${u.hostname}${u.port ? `:${u.port}` : ""}${u.pathname}`;
}

/** Remove a password (crua e descodificada) de qualquer texto — mensagens de erro do driver incluídas. */
export function redigir(texto: string, url: string): string {
  let out = texto;
  try {
    const u = new URL(url);
    for (const seg of [u.password, safeDecode(u.password)]) if (seg) out = out.split(seg).join("***");
    out = out.split(url).join(descreverDestino(url));
  } catch {
    /* url inválido: nada a redigir */
  }
  return out;
}
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// ─── Tipos do relatório ──────────────────────────────────────────────────────

/** Uma linha por VALOR CRU (agregação única na base). */
export type LinhaForma = {
  valor: string | null;
  total: number;
  /** Critério de medicamento: `productType = 'MEDICAMENTO'` OU presente no INFARMED. */
  medicamentos: number;
  medicamentosPorTipo: number;
  /** Com correspondência INFARMED (ProdutoRegulamentar na versão ativa OU RegulatoryRecord). */
  comInfarmed: number;
  manuais: number;
};

export type RelatorioAuditoria = {
  tenant: string;
  destino: string;
  geradoEm: string;
  universo: string;
  somenteLeitura: true;
  fontesRegulamentares: { produtoRegulamentarAtiva: boolean; regulatoryRecord: boolean; versaoAtivaId: string | null };
  produtos: { total: number; comForma: number; semForma: number; coberturaPct: number | null; soEspacos: number };
  formasDistintas: { cruas: number; normalizadas: number };
  topFormas: Array<{ chave: string; rotulo: string; produtos: number; pct: number }>;
  variantes: {
    chavesComVariantes: number;
    grafiasJuntadas: number;
    detalhe: Array<{ chave: string; rotulo: string; produtos: number; grafias: Array<{ valor: string; produtos: number }> }>;
  };
  colisoesSuspeitas: Array<{ chave: string; valores: string[] }>;
  chavesDiscordantes: Array<{ valor: string; chaveProducao: string; chaveIndependente: string }>;
  paresParecidosNaoAgrupados: { total: number; detalhe: Array<{ a: string; b: string; produtosA: number; produtosB: number; distancia: number }> };
  possiveisAbreviaturas: Array<{ valor: string; produtos: number }>;
  infarmed: {
    produtosSemCorrespondencia: number;
    produtosComCorrespondencia: number;
    semCorrespondenciaESemForma: number;
    semCorrespondenciaMasComForma: number;
  };
  medicamentos: {
    criterio: string;
    limitacao: string;
    medicamentos: { total: number; comForma: number; semForma: number; coberturaPct: number | null };
    naoMedicamentos: { total: number; comForma: number; semForma: number; coberturaPct: number | null };
    medicamentosPorTipo: number;
    protegidosManualmente: number;
  };
  partilhaEntreTenants: string;
};

export const CRITERIO_MEDICAMENTO =
  "medicamento = `Produto.productType = 'MEDICAMENTO'` (critério de lib/encomendas-data.ts) OU produto com registo INFARMED " +
  "(ProdutoRegulamentar na versão ativa, ou RegulatoryRecord, por CNP).";
export const LIMITACAO_MEDICAMENTO =
  "`productType` vem do enriquecimento/classificação e pode estar por preencher ou errado; a presença no INFARMED só cobre CNP " +
  "já importados (uma base sem a versão ativa subestima os medicamentos); produtos de saúde/dispositivos presentes no INFARMED contam como " +
  "medicamentos. Os números separam populações, não são um registo clínico.";

// ─── Normalização INDEPENDENTE (Unicode NFD) — só para detectar colisões ─────

/** Aparar + colapsar espaços + NFD sem marcas combinantes + minúsculas. Não partilha código com a chave de produção. */
export function chaveIndependente(v: string | null | undefined): string {
  if (v == null) return SEM_FORMA;
  const s = v.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
  return s === "" ? SEM_FORMA : s;
}

/** Distância de edição com corte (devolve `max + 1` se exceder). */
export function distanciaEdicao(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let minLinha = cur[0];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < minLinha) minLinha = cur[j];
    }
    if (minLinha > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

const TOKENS_ABREVIADOS = /(^|\s)(comp|caps|sol|susp|supos|sup|amp|xar|pom|cr|inj|orl)\.?(\s|$)/i;

const pct = (a: number, b: number): number | null => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

/** PURA sobre as linhas agregadas — o que os testes exercitam com um dataset conhecido. */
export function construirRelatorio(
  linhas: readonly LinhaForma[],
  meta: { tenant: string; destino: string; geradoEm: string; fontes: RelatorioAuditoria["fontesRegulamentares"]; top: number },
): RelatorioAuditoria {
  const top = meta.top;
  const total = linhas.reduce((s, l) => s + l.total, 0);
  const ehSem = (l: LinhaForma) => chaveFormaFarmaceutica(l.valor) === SEM_FORMA;
  const semForma = linhas.filter(ehSem).reduce((s, l) => s + l.total, 0);
  const soEspacos = linhas.filter((l) => l.valor !== null && ehSem(l)).reduce((s, l) => s + l.total, 0);

  const opcoes: OpcaoFormaFarmaceutica[] = opcoesFormaFarmaceutica(linhas.map((l) => ({ valor: l.valor, count: l.total })));
  const porChave = new Map<string, LinhaForma[]>();
  for (const l of linhas) {
    if (ehSem(l)) continue;
    const c = chaveFormaFarmaceutica(l.valor);
    porChave.set(c, [...(porChave.get(c) ?? []), l]);
  }
  const rotuloDe = new Map(opcoes.map((o) => [o.chave, o.label]));

  // Variantes (valores crus DISTINTOS na mesma chave).
  const comVariantes = [...porChave.entries()].filter(([, ls]) => ls.length > 1);
  const detalheVariantes = comVariantes
    .map(([chave, ls]) => ({
      chave,
      rotulo: rotuloDe.get(chave) ?? chave,
      produtos: ls.reduce((s, x) => s + x.total, 0),
      grafias: ls.map((x) => ({ valor: x.valor ?? "", produtos: x.total })).sort((a, b) => b.produtos - a.produtos || a.valor.localeCompare(b.valor)),
    }))
    .sort((a, b) => b.grafias.length - a.grafias.length || b.produtos - a.produtos);

  // Colisões suspeitas: na mesma chave de produção, valores cuja chave INDEPENDENTE difere.
  const colisoes: RelatorioAuditoria["colisoesSuspeitas"] = [];
  const discordantes: RelatorioAuditoria["chavesDiscordantes"] = [];
  for (const [chave, ls] of porChave) {
    const independentes = new Set(ls.map((l) => chaveIndependente(l.valor)));
    if (independentes.size > 1) colisoes.push({ chave, valores: ls.map((l) => l.valor ?? "") });
    for (const l of ls) {
      const ind = chaveIndependente(l.valor);
      if (ind !== chave) discordantes.push({ valor: l.valor ?? "", chaveProducao: chave, chaveIndependente: ind });
    }
  }

  // Pares parecidos NÃO agrupados (chaves distintas, distância <= 2, comprimento mínimo 5 para evitar ruído).
  const chaves = [...porChave.keys()].filter((c) => c.length >= 5);
  const totalDe = (c: string) => porChave.get(c)!.reduce((s, x) => s + x.total, 0);
  const pares: RelatorioAuditoria["paresParecidosNaoAgrupados"]["detalhe"] = [];
  for (let i = 0; i < chaves.length; i++) {
    for (let j = i + 1; j < chaves.length; j++) {
      const d = distanciaEdicao(chaves[i], chaves[j], 2);
      if (d <= 2) pares.push({ a: chaves[i], b: chaves[j], produtosA: totalDe(chaves[i]), produtosB: totalDe(chaves[j]), distancia: d });
    }
  }
  pares.sort((x, y) => y.produtosA + y.produtosB - (x.produtosA + x.produtosB) || x.a.localeCompare(y.a));

  // INFARMED.
  const comInf = linhas.reduce((s, l) => s + l.comInfarmed, 0);
  const semInf = total - comInf;
  const semInfESemForma = linhas.filter(ehSem).reduce((s, l) => s + (l.total - l.comInfarmed), 0);

  // Medicamentos vs não medicamentos.
  const meds = linhas.reduce((s, l) => s + l.medicamentos, 0);
  const medsSem = linhas.filter(ehSem).reduce((s, l) => s + l.medicamentos, 0);
  const naoMeds = total - meds;
  const naoMedsSem = semForma - medsSem;

  return {
    tenant: meta.tenant,
    destino: meta.destino,
    geradoEm: meta.geradoEm,
    universo: `Produto com estado <> 'INATIVO' e cnp > ${MIN_CNP_CATALOGAVEL} (o universo das opções do filtro)`,
    somenteLeitura: true,
    fontesRegulamentares: meta.fontes,
    produtos: { total, comForma: total - semForma, semForma, coberturaPct: pct(total - semForma, total), soEspacos },
    formasDistintas: { cruas: new Set(linhas.map((l) => l.valor)).size, normalizadas: opcoes.length },
    topFormas: opcoes
      .filter((o) => o.chave !== SEM_FORMA)
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "pt-PT"))
      .slice(0, top)
      .map((o) => ({ chave: o.chave, rotulo: o.label, produtos: o.count, pct: pct(o.count, total) ?? 0 })),
    variantes: {
      chavesComVariantes: comVariantes.length,
      grafiasJuntadas: comVariantes.reduce((s, [, ls]) => s + ls.length - 1, 0),
      detalhe: detalheVariantes.slice(0, top),
    },
    colisoesSuspeitas: colisoes,
    chavesDiscordantes: discordantes,
    paresParecidosNaoAgrupados: { total: pares.length, detalhe: pares.slice(0, top) },
    possiveisAbreviaturas: linhas
      .filter((l) => !ehSem(l) && l.valor && (/\.\s*$/.test(l.valor) || TOKENS_ABREVIADOS.test(l.valor)))
      .map((l) => ({ valor: l.valor as string, produtos: l.total }))
      .sort((a, b) => b.produtos - a.produtos)
      .slice(0, top),
    infarmed: {
      produtosSemCorrespondencia: semInf,
      produtosComCorrespondencia: comInf,
      semCorrespondenciaESemForma: semInfESemForma,
      semCorrespondenciaMasComForma: semInf - semInfESemForma,
    },
    medicamentos: {
      criterio: CRITERIO_MEDICAMENTO,
      limitacao: LIMITACAO_MEDICAMENTO,
      medicamentos: { total: meds, comForma: meds - medsSem, semForma: medsSem, coberturaPct: pct(meds - medsSem, meds) },
      naoMedicamentos: { total: naoMeds, comForma: naoMeds - naoMedsSem, semForma: naoMedsSem, coberturaPct: pct(naoMeds - naoMedsSem, naoMeds) },
      medicamentosPorTipo: linhas.reduce((s, l) => s + l.medicamentosPorTipo, 0),
      protegidosManualmente: linhas.reduce((s, l) => s + l.manuais, 0),
    },
    partilhaEntreTenants:
      `Esta auditoria descreve APENAS a base do tenant «${meta.tenant}». As formas, contagens e opções de cada tenant vêm da sua própria ` +
      "base e nunca são partilhadas nem agregadas com as de outro tenant; para outro tenant, correr o comando de novo com o respectivo --url/--tenant.",
  };
}

// ─── Markdown ────────────────────────────────────────────────────────────────

const p = (v: number | null) => (v === null ? "—" : `${v.toFixed(1)}%`);
const celula = (v: string) => v.replace(/\|/g, "\\|").replace(/\s+/g, " ");

export function renderMarkdown(r: RelatorioAuditoria): string {
  const L: string[] = [];
  L.push(`# Auditoria de formaFarmaceutica — tenant \`${r.tenant}\``);
  L.push("");
  L.push(`- Base: \`${r.destino}\` (password nunca registada)`);
  L.push(`- Gerado em: ${r.geradoEm} — **só leitura** (transacção READ ONLY, só SELECT)`);
  L.push(`- Universo: ${r.universo}`);
  L.push(`- Fontes INFARMED: ProdutoRegulamentar (versão ativa${r.fontesRegulamentares.versaoAtivaId ? ` ${r.fontesRegulamentares.versaoAtivaId}` : ": nenhuma"}): ${r.fontesRegulamentares.produtoRegulamentarAtiva ? "sim" : "não"}; RegulatoryRecord: ${r.fontesRegulamentares.regulatoryRecord ? "sim" : "não"}`);
  L.push(`- ${r.partilhaEntreTenants}`);
  L.push("");
  L.push("## Cobertura");
  L.push("");
  L.push("| Indicador | Valor |");
  L.push("|---|---|");
  L.push(`| Total de produtos | ${r.produtos.total} |`);
  L.push(`| Com forma | ${r.produtos.comForma} (${p(r.produtos.coberturaPct)}) |`);
  L.push(`| Sem forma (nulo ou só espaços) | ${r.produtos.semForma} (${p(pct(r.produtos.semForma, r.produtos.total))}) — dos quais só espaços/vazio: ${r.produtos.soEspacos} |`);
  L.push(`| Valores crus distintos | ${r.formasDistintas.cruas} |`);
  L.push(`| Opções após normalização (inclui «${ROTULO_SEM_FORMA}» se existir) | ${r.formasDistintas.normalizadas} |`);
  L.push("");
  L.push(`## Principais formas (top ${r.topFormas.length})`);
  L.push("");
  L.push("| Forma | Chave | Produtos | % |");
  L.push("|---|---|---:|---:|");
  for (const f of r.topFormas) L.push(`| ${celula(f.rotulo)} | \`${celula(f.chave)}\` | ${f.produtos} | ${f.pct.toFixed(1)}% |`);
  L.push("");
  L.push("## Variantes normalizadas (valores crus que colapsam na mesma chave)");
  L.push("");
  L.push(`Chaves com mais de uma grafia: **${r.variantes.chavesComVariantes}** (${r.variantes.grafiasJuntadas} grafias juntadas). O valor guardado nunca é alterado.`);
  L.push("");
  for (const v of r.variantes.detalhe) {
    L.push(`- \`${celula(v.chave)}\` (${v.produtos} produtos): ${v.grafias.map((g) => `${JSON.stringify(g.valor)} ×${g.produtos}`).join(" · ")}`);
  }
  L.push("");
  L.push("## Colisões suspeitas (juntam valores que diferem em mais do que espaços/acentos/maiúsculas)");
  L.push("");
  if (r.colisoesSuspeitas.length === 0 && r.chavesDiscordantes.length === 0) {
    L.push("Nenhuma — como esperado.");
  } else {
    for (const c of r.colisoesSuspeitas) L.push(`- **COLISÃO** \`${celula(c.chave)}\`: ${c.valores.map((v) => JSON.stringify(v)).join(" · ")}`);
    for (const c of r.chavesDiscordantes) L.push(`- **DISCORDÂNCIA** ${JSON.stringify(c.valor)}: produção \`${c.chaveProducao}\` ≠ independente \`${c.chaveIndependente}\``);
  }
  L.push("");
  L.push("## Formas muito parecidas NÃO agrupadas (para revisão humana)");
  L.push("");
  L.push(`Pares com distância de edição <= 2 entre chaves distintas: **${r.paresParecidosNaoAgrupados.total}** (a lista mostra os de maior volume). O filtro NÃO os junta: pode haver diferença clínica real («Comprimido» ≠ «Comprimido revestido»).`);
  L.push("");
  for (const x of r.paresParecidosNaoAgrupados.detalhe) L.push(`- \`${celula(x.a)}\` (${x.produtosA}) ↔ \`${celula(x.b)}\` (${x.produtosB}) — distância ${x.distancia}`);
  L.push("");
  L.push("## Possíveis abreviaturas (NÃO expandidas)");
  L.push("");
  if (r.possiveisAbreviaturas.length === 0) L.push("Nenhuma detectada.");
  for (const a of r.possiveisAbreviaturas) L.push(`- ${JSON.stringify(a.valor)} (${a.produtos})`);
  L.push("");
  L.push("## Correspondência INFARMED");
  L.push("");
  L.push("| Indicador | Valor |");
  L.push("|---|---|");
  L.push(`| Produtos COM correspondência | ${r.infarmed.produtosComCorrespondencia} |`);
  L.push(`| Produtos SEM correspondência | ${r.infarmed.produtosSemCorrespondencia} (${p(pct(r.infarmed.produtosSemCorrespondencia, r.produtos.total))}) |`);
  L.push(`| …dos quais SEM forma | ${r.infarmed.semCorrespondenciaESemForma} |`);
  L.push(`| …dos quais com forma (não vinda do INFARMED) | ${r.infarmed.semCorrespondenciaMasComForma} |`);
  L.push("");
  L.push("## Medicamentos vs não medicamentos");
  L.push("");
  L.push(`Critério: ${r.medicamentos.criterio}`);
  L.push("");
  L.push(`Limitação: ${r.medicamentos.limitacao}`);
  L.push("");
  L.push("| População | Produtos | Com forma | Sem forma | Cobertura |");
  L.push("|---|---:|---:|---:|---:|");
  const m = r.medicamentos.medicamentos;
  const n = r.medicamentos.naoMedicamentos;
  L.push(`| Medicamentos | ${m.total} | ${m.comForma} | ${m.semForma} | ${p(m.coberturaPct)} |`);
  L.push(`| Não medicamentos | ${n.total} | ${n.comForma} | ${n.semForma} | ${p(n.coberturaPct)} |`);
  L.push("");
  L.push(`Só por \`productType = 'MEDICAMENTO'\`: ${r.medicamentos.medicamentosPorTipo}. Protegidos por \`camposManuais ∋ formaFarmaceutica\`: ${r.medicamentos.protegidosManualmente}.`);
  L.push("");
  return L.join("\n");
}

// ─── Execução (só leitura) ───────────────────────────────────────────────────

const RE_SO_LEITURA = /^\s*(select|with)\b/i;

/** Executa SÓ instruções de leitura; qualquer outra coisa é um erro de programação e nunca chega à base. */
async function ler<T extends Record<string, unknown>>(c: Client, sql: string, params: unknown[] = []): Promise<T[]> {
  if (!RE_SO_LEITURA.test(sql)) throw new Error("[fatal] o auditor só executa SELECT/WITH.");
  return (await c.query(sql, params)).rows as T[];
}

/** Abre a ligação já em modo só de leitura (sessão + transacção). */
export async function abrirSoLeitura(url: string): Promise<Client> {
  const c = new Client({ connectionString: url, options: "-c default_transaction_read_only=on", statement_timeout: 120_000 });
  await c.connect();
  await c.query("BEGIN READ ONLY");
  await c.query("SET TRANSACTION READ ONLY");
  return c;
}

export async function recolherLinhas(c: Client): Promise<{ linhas: LinhaForma[]; fontes: RelatorioAuditoria["fontesRegulamentares"] }> {
  const t = await ler<{ pr: string | null; imp: string | null; rr: string | null }>(
    c,
    `SELECT to_regclass('"ProdutoRegulamentar"')::text AS pr, to_regclass('"InfarmedImportacao"')::text AS imp, to_regclass('"RegulatoryRecord"')::text AS rr`,
  );
  const temPr = !!t[0].pr && !!t[0].imp;
  const temRr = !!t[0].rr;
  let versaoAtivaId: string | null = null;
  if (temPr) {
    const v = await ler<{ id: string }>(c, `SELECT id FROM "InfarmedImportacao" WHERE ativa LIMIT 1`);
    versaoAtivaId = v[0]?.id ?? null;
  }
  const exPr = temPr && versaoAtivaId
    ? `EXISTS (SELECT 1 FROM "ProdutoRegulamentar" pr WHERE pr."produtoId" = p.id AND pr."importacaoId" = $2)`
    : `false`;
  const exRr = temRr ? `EXISTS (SELECT 1 FROM "RegulatoryRecord" rr WHERE rr.cnp = p.cnp)` : `false`;
  const params: unknown[] = [MIN_CNP_CATALOGAVEL];
  if (temPr && versaoAtivaId) params.push(versaoAtivaId);
  const rows = await ler<{ valor: string | null; total: string; medicamentos: string; por_tipo: string; com_infarmed: string; manuais: string }>(
    c,
    `SELECT x.valor,
            count(*) AS total,
            count(*) FILTER (WHERE x.tipo_med OR x.infarmed) AS medicamentos,
            count(*) FILTER (WHERE x.tipo_med) AS por_tipo,
            count(*) FILTER (WHERE x.infarmed) AS com_infarmed,
            count(*) FILTER (WHERE x.manual) AS manuais
       FROM (SELECT p."formaFarmaceutica" AS valor,
                    (p."productType" = 'MEDICAMENTO') AS tipo_med,
                    (${exPr} OR ${exRr}) AS infarmed,
                    ('formaFarmaceutica' = ANY(p."camposManuais")) AS manual
               FROM "Produto" p
              WHERE p.estado <> 'INATIVO' AND p.cnp > $1) x
      GROUP BY x.valor`,
    params,
  );
  return {
    linhas: rows.map((r) => ({
      valor: r.valor,
      total: Number(r.total),
      medicamentos: Number(r.medicamentos),
      medicamentosPorTipo: Number(r.por_tipo),
      comInfarmed: Number(r.com_infarmed),
      manuais: Number(r.manuais),
    })),
    fontes: { produtoRegulamentarAtiva: temPr && !!versaoAtivaId, regulatoryRecord: temRr, versaoAtivaId },
  };
}

export async function auditar(args: ArgsAuditoria): Promise<RelatorioAuditoria> {
  const c = await abrirSoLeitura(args.url);
  try {
    const { linhas, fontes } = await recolherLinhas(c);
    return construirRelatorio(linhas, { tenant: args.tenant, destino: descreverDestino(args.url), geradoEm: new Date().toISOString(), fontes, top: args.top });
  } finally {
    // Nunca COMMIT: a transacção só leu, termina sempre em ROLLBACK.
    await c.query("ROLLBACK").catch(() => undefined);
    await c.end().catch(() => undefined);
  }
}

async function main() {
  let args: ArgsAuditoria;
  try {
    args = lerArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
  try {
    const nomeBase = new URL(args.url).pathname.replace(/^\//, "");
    if (!nomeBase.toLowerCase().includes(args.tenant.toLowerCase())) {
      console.error(`[aviso] o nome da base («${nomeBase}») não contém o slug «${args.tenant}» — confirme que é a base certa.`);
    }
    const r = await auditar(args);
    const saida = args.out && /\.json$/i.test(args.out) ? JSON.stringify(r, null, 2) : renderMarkdown(r);
    if (args.out) {
      writeFileSync(args.out, saida, "utf8");
      console.log(`Relatório escrito em ${args.out} (tenant ${args.tenant}, ${descreverDestino(args.url)}).`);
    } else {
      console.log(saida);
    }
  } catch (e) {
    console.error(redigir(e instanceof Error ? e.message : String(e), args.url));
    process.exit(1);
  }
}

if (require.main === module) void main();
