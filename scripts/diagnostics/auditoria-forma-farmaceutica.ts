/**
 * scripts/diagnostics/auditoria-forma-farmaceutica.ts
 *
 * Auditoria SOMENTE LEITURA da cobertura e da qualidade de `Produto.formaFarmaceutica` — o que alimenta o filtro «Forma
 * farmacêutica» dos mapas. Responde, para a base apontada:
 *
 *   · quantos produtos (activos e catalogáveis) têm / não têm forma;
 *   · o mesmo para MEDICAMENTOS (`productType = 'MEDICAMENTO'`, o critério já usado em lib/encomendas-data.ts);
 *   · quantas variantes de CAIXA / ACENTOS / ESPAÇOS existem para a mesma forma (e quanto o filtro as junta);
 *   · quantas formas parecem ABREVIATURAS (não são expandidas: o filtro não faz fuzzy) e quantas são COMPOSTAS
 *     («comprimido de libertação prolongada» — mantêm-se como opções próprias);
 *   · nº de opções ANTES (DISTINCT cru) e DEPOIS (por chave normalizada);
 *   · produtos protegidos por `camposManuais ∋ 'formaFarmaceutica'` (a reconciliação INFARMED não lhes toca).
 *
 * SEGURANÇA: corre contra uma base DESCARTÁVEL/SINTÉTICA passada por parâmetro ou ambiente — nunca a real.
 *   · URL: 1.º argumento, ou AUDITORIA_DATABASE_URL (NÃO usa DATABASE_URL por omissão, para não apanhar a real por engano);
 *   · recusa qualquer host que não seja localhost/127.0.0.1 e qualquer URL que pareça de produção (spharmmt_t_*, prod).
 *   · não escreve nada.
 *
 * NÃO afirma cobertura de produção: os números descrevem SÓ a base que lhe for passada.
 *
 * Uso: AUDITORIA_DATABASE_URL=postgresql://postgres:test@localhost:15433/<base_sintetica> \
 *        npx tsx scripts/diagnostics/auditoria-forma-farmaceutica.ts
 */
import { PrismaClient } from "../../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { MIN_CNP_CATALOGAVEL } from "../../lib/catalog/cnp-catalogavel";
import { SEM_FORMA, chaveFormaFarmaceutica, opcoesFormaFarmaceutica, type ValorFormaComContagem } from "../../lib/catalog/forma-farmaceutica-filtro";
import { validarUrlDescartavel } from "./auditoria-fabricantes-grupos-garantia";

export { validarUrlDescartavel };

export type LinhaAuditoria = { valor: string | null; total: number; medicamentos: number; manuais: number };

export type RelatorioFormaFarmaceutica = {
  produtos: number;
  comForma: number;
  semForma: number;
  medicamentos: number;
  medicamentosComForma: number;
  medicamentosSemForma: number;
  protegidosManualmente: number;
  opcoesAntes: number;
  opcoesDepois: number;
  /** Formas com mais de uma grafia (caixa/acentos/espaços): quantas, e o excesso de grafias que o filtro junta. */
  formasComVariantes: number;
  variantesJuntadas: number;
  topVariantes: Array<{ chave: string; grafias: string[]; produtos: number }>;
  /** Heurística: valores que parecem abreviaturas (terminam em ponto ou têm um token curto conhecido). NÃO são expandidos. */
  possiveisAbreviaturas: Array<{ valor: string; produtos: number }>;
  /** Formas compostas (várias palavras com «de/para/e/com/por» ou vírgula): ficam como opções próprias. */
  compostas: number;
  /** Os 15 valores crus mais frequentes que NÃO têm forma normalizada reconhecível (vazios/só espaços). */
  vaziosOuEspacos: number;
};

const TOKENS_ABREVIADOS = /(^|\s)(comp|caps|sol|susp|supos|sup|amp|xar|pom|cr|gel\.|inj|orl)\.?(\s|$)/i;
const COMPOSTA = /( de | para | e | com | por |,)/i;

/** Pura sobre as linhas já agregadas — reutilizada pelos testes. */
export function auditarFormas(linhas: readonly LinhaAuditoria[], topN = 10): RelatorioFormaFarmaceutica {
  const total = linhas.reduce((s, l) => s + l.total, 0);
  const semForma = linhas.filter((l) => chaveFormaFarmaceutica(l.valor) === SEM_FORMA).reduce((s, l) => s + l.total, 0);
  const meds = linhas.reduce((s, l) => s + l.medicamentos, 0);
  const medsSem = linhas.filter((l) => chaveFormaFarmaceutica(l.valor) === SEM_FORMA).reduce((s, l) => s + l.medicamentos, 0);
  const valores: ValorFormaComContagem[] = linhas.map((l) => ({ valor: l.valor, count: l.total }));
  const opcoes = opcoesFormaFarmaceutica(valores);

  const grafiasPorChave = new Map<string, Array<{ grafia: string; n: number }>>();
  for (const l of linhas) {
    const chave = chaveFormaFarmaceutica(l.valor);
    if (chave === SEM_FORMA) continue;
    const lista = grafiasPorChave.get(chave) ?? [];
    lista.push({ grafia: l.valor ?? "", n: l.total });
    grafiasPorChave.set(chave, lista);
  }
  const comVariantes = [...grafiasPorChave.entries()].filter(([, g]) => g.length > 1);
  const naoVazias = linhas.filter((l) => chaveFormaFarmaceutica(l.valor) !== SEM_FORMA);

  return {
    produtos: total,
    comForma: total - semForma,
    semForma,
    medicamentos: meds,
    medicamentosComForma: meds - medsSem,
    medicamentosSemForma: medsSem,
    protegidosManualmente: linhas.reduce((s, l) => s + l.manuais, 0),
    opcoesAntes: new Set(linhas.map((l) => l.valor)).size,
    opcoesDepois: opcoes.length,
    formasComVariantes: comVariantes.length,
    variantesJuntadas: comVariantes.reduce((s, [, g]) => s + g.length - 1, 0),
    topVariantes: comVariantes
      .map(([chave, g]) => ({ chave, grafias: g.map((x) => JSON.stringify(x.grafia)), produtos: g.reduce((s, x) => s + x.n, 0) }))
      .sort((a, b) => b.grafias.length - a.grafias.length || b.produtos - a.produtos)
      .slice(0, topN),
    possiveisAbreviaturas: naoVazias
      .filter((l) => l.valor && (/\.\s*$/.test(l.valor) || TOKENS_ABREVIADOS.test(l.valor)))
      .map((l) => ({ valor: l.valor as string, produtos: l.total }))
      .sort((a, b) => b.produtos - a.produtos)
      .slice(0, topN),
    compostas: opcoes.filter((o) => o.chave !== SEM_FORMA && COMPOSTA.test(o.chave)).length,
    vaziosOuEspacos: linhas.filter((l) => l.valor !== null && chaveFormaFarmaceutica(l.valor) === SEM_FORMA).reduce((s, l) => s + l.total, 0),
  };
}

async function main() {
  const url = validarUrlDescartavel(process.argv[2] ?? process.env.AUDITORIA_DATABASE_URL);
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    // UMA agregação (activos e catalogáveis): valor cru, total, medicamentos, protegidos manualmente.
    const rows = await prisma.$queryRawUnsafe<Array<{ valor: string | null; total: bigint; medicamentos: bigint; manuais: bigint }>>(
      `SELECT p."formaFarmaceutica" AS valor,
              count(*) AS total,
              count(*) FILTER (WHERE p."productType" = 'MEDICAMENTO') AS medicamentos,
              count(*) FILTER (WHERE 'formaFarmaceutica' = ANY(p."camposManuais")) AS manuais
         FROM "Produto" p
        WHERE p.estado <> 'INATIVO' AND p.cnp > ${MIN_CNP_CATALOGAVEL}
        GROUP BY p."formaFarmaceutica"`,
    );
    const r = auditarFormas(rows.map((x) => ({ valor: x.valor, total: Number(x.total), medicamentos: Number(x.medicamentos), manuais: Number(x.manuais) })));
    const pct = (a: number, b: number) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : "—");
    console.log("Auditoria de formaFarmaceutica (só leitura) — descreve SÓ a base apontada, não a produção");
    console.log(`  Produtos activos/catalogáveis:         ${r.produtos}`);
    console.log(`    com forma:                           ${r.comForma}  (${pct(r.comForma, r.produtos)})`);
    console.log(`    sem forma (nulo ou só espaços):      ${r.semForma}  (${pct(r.semForma, r.produtos)})  [dos quais só espaços/vazio: ${r.vaziosOuEspacos}]`);
    console.log(`  Medicamentos (productType=MEDICAMENTO): ${r.medicamentos}`);
    console.log(`    com forma:                           ${r.medicamentosComForma}  (${pct(r.medicamentosComForma, r.medicamentos)})`);
    console.log(`    sem forma:                           ${r.medicamentosSemForma}  (${pct(r.medicamentosSemForma, r.medicamentos)})`);
    console.log(`  Protegidos (camposManuais ∋ formaFarmaceutica): ${r.protegidosManualmente}`);
    console.log(`  Opções ANTES (DISTINCT cru):           ${r.opcoesAntes}`);
    console.log(`  Opções DEPOIS (por chave normalizada): ${r.opcoesDepois}  (inclui «Sem forma farmacêutica» se houver)`);
    console.log(`  Formas com variantes de caixa/acentos/espaços: ${r.formasComVariantes}  (${r.variantesJuntadas} grafias juntadas)`);
    for (const v of r.topVariantes) console.log(`    ${v.chave}: ${v.grafias.join(" | ")}  (${v.produtos} produtos)`);
    console.log(`  Possíveis abreviaturas (NÃO expandidas): ${r.possiveisAbreviaturas.length}`);
    for (const a of r.possiveisAbreviaturas) console.log(`    ${JSON.stringify(a.valor)}  (${a.produtos})`);
    console.log(`  Formas compostas (mantidas como opções próprias): ${r.compostas}`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
