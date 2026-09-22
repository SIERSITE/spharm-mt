/**
 * scripts/gerar-regras-cnp-grupos-laboratoriais-garantia.ts
 *
 * Gera scripts/data/regras-cnp-grupos-laboratoriais-garantia.json —
 * a lista de RegraGrupoLaboratorialPorCnp VALIDADAS (nível 2 da
 * precedência, `validadoManualmente=true`) a partir de:
 *
 *   1. scripts/data/decomposicao-propostas-nao-redundantes.json (gerado
 *      por decompor-propostas-grupos-laboratoriais-garantia.ts) — os
 *      pares classificados como B (REGRA_CNP_SEGURA) em
 *      scripts/data/classificacao-pares-propostas-garantia.json.
 *   2. Os 5 pares de sucessão parcial investigados no ponto 4 (MSD→
 *      Organon, Novartis→Sandoz, Sanofi→Zentiva, Sanofi/Boehringer→
 *      Opella), com CNPs descobertos via
 *      scripts/descobrir-cnps-sucessao-por-par.ts.
 *
 * Nunca inclui os pares classificados A (esses tornam-se
 * fabricantesIntegrais na config principal) nem D (ficam em revisão
 * manual, nunca promovidos sem decisão humana adicional).
 *
 * Zero escritas em qualquer base — só produz este ficheiro JSON, que o
 * simulador e (no futuro) o importador real podem carregar como
 * `regrasCnpPorCnp`.
 *
 * Uso: npx tsx scripts/gerar-regras-cnp-grupos-laboratoriais-garantia.ts \
 *   --decomposicao=<path> --saida=<path>
 */
import { readFileSync, writeFileSync } from "node:fs";

type LinhaDecomposicao = {
  grupoProposto: string;
  fabricanteAtualGarantia: string;
  titularCatalogoAtual: string;
  estadoRegistoCatalogo: string;
  quantidadeProdutos: number;
  cnps: number[];
};

type Classificacao = {
  promovidosParaIntegral_A: string[];
  regraCnp_B: string[];
  revisaoManual_D_evidenciaInsuficienteOuConflitante: Array<{ chave: string; razao: string }>;
};

type RegraCnpGerada = {
  cnp: number;
  grupoLaboratorialNomeNormalizado: string;
  fabricanteLegalEsperadoNormalizado: string | null;
  evidencia: string;
  estado: "ATIVO";
  validadoManualmente: true;
};

function arg(name: string): string {
  const a = process.argv.slice(2).find((x) => x.startsWith(`--${name}=`));
  if (!a) throw new Error(`--${name}=<valor> é obrigatório`);
  return a.slice(name.length + 3);
}

// Os 5 pares de sucessão parcial investigados no ponto 4 — CNPs
// descobertos via scripts/descobrir-cnps-sucessao-por-par.ts em
// 2026-09-22 contra os dados reais de garantia (ver relatório da sessão
// para o comando exacto e a saída completa).
const SUCESSOES_PARCIAIS: Array<{ grupo: string; fabricanteOrigem: string; cnps: number[]; evidencia: string }> = [
  {
    grupo: "ORGANON",
    fabricanteOrigem: "MERCK SHARP & DOHME",
    evidencia: "Spin-off parcial MSD→Organon (2021-06-02) — apenas saúde da mulher/biossimilares/legacy brands. Fonte: organon.com/news/merck-to-focus-on-key-growth-pillars... (2020-02-05).",
    cnps: [2133189,2133387,2317584,2317782,2530889,2627883,2639680,2639789,2639987,2640084,2716181,2798486,2798585,2832681,2871382,3112885,3124989,3268984,3269081,3502382,3502481,3506888,3509486,3613387,3862380,3862786,3863180,3919180,3982782,4106282,4107686,4108080,4109088,4109385,4109484,4114583,4115986,4116281,4116380,4117388,4117685,4117784,4314787,4367587,4367785,5013859,5032255,5034426,5055660,5062500,5065156,5165584,5243480,5243886,5244280,5299631,5299649,5566781,5627781,5715032,5715040,5715131,5717756,5743554,5819172,8372532,8372557,8372573,8452912,8476010,8589556,8589804,8589812,8713115,8768739,8777300,8780502,8780510,9166900,9222109,9263004,9419309,9419408,9434613,9454504,9454611,9458323,9486514,9585000,9647800,9647909,9789917,9789933,9790006,9790014],
  },
  {
    grupo: "SANDOZ",
    fabricanteOrigem: "NOVARTIS FARMA - PRODUTOS FARMACEUTICOS",
    evidencia: "Spin-off parcial Novartis→Sandoz (2023-10-04) — apenas genéricos/biossimilares. Fonte: novartis.com/news/sandoz-spinoff.",
    cnps: [2055184,2055283,2055580,2328185,2328284,3818481,5418488],
  },
  {
    grupo: "ZENTIVA",
    fabricanteOrigem: "SANOFI - PRODUTOS FARMACEUTICOS",
    evidencia: "Divestment parcial Sanofi→Zentiva (fecho 2018-09-30, venda à Advent International) — apenas negócio europeu de genéricos. Fonte: pharmaceutical-technology.com/news/sanofi-sells-zentiva/ (2018-10-02).",
    cnps: [3080686,3531795,4026985,4622593,4740486,4768388,4768685,5025770,5047766,5047808,5107677,5156187,5156286,5156583,5285382,5286612,5374855,5374863,5403845,5408208,5408232,5414248,5414255,5414263,5427539,5443411,5467238,5476056,5480124,5480132,5564554,5565056,5565064,5565247,5579511,5583273,5595640,5595913,5595921,5639588,5657341,5661236,5665310,5665328,5691605,5742887,5914080],
  },
  {
    grupo: "OPELLA",
    fabricanteOrigem: "SANOFI - OTC S",
    evidencia: "Spin-off parcial Sanofi consumer health→Opella (fecho 2025-04-30). Fonte: sanofi.com/en/media-room/press-releases/2025/2025-04-30-11-00-00-3071167.",
    cnps: [2594984,2595189,3574589,3605995,5100920,5349964,5404603,5421375,5488325,5490578,5593322,5604277,5745377,5790183,5899463,6222752,6456590,6983023,6983031,8116707,8256727,8283309,8520809,8520825,8574913,8631119,8656504,8767004,9254813,9412809,9412817,9412908,9679704,9679712,9679720,9767004,9767103,9901710,9901728,9904805],
  },
  {
    grupo: "OPELLA",
    fabricanteOrigem: "BOEHRINGER INGELHEIM",
    evidencia: "Mesmo spin-off Opella — produtos de consumer health cedidos pela Boehringer Ingelheim (parceiro histórico de comercialização de OTC da Sanofi em Portugal). Fonte: idem Opella acima.",
    cnps: [3245586,5490248,8904912,8906404],
  },
];

function main(): void {
  const decomposicaoPath = arg("decomposicao");
  const saidaPath = arg("saida");

  const decomposicao = JSON.parse(readFileSync(decomposicaoPath, "utf8")) as { naoRedundantes: LinhaDecomposicao[] };
  const classificacao = JSON.parse(
    readFileSync("scripts/data/classificacao-pares-propostas-garantia.json", "utf8"),
  ) as Classificacao;

  const chaveDe = (l: LinhaDecomposicao) => `${l.grupoProposto}|||${l.fabricanteAtualGarantia}|||${l.titularCatalogoAtual}|||${l.estadoRegistoCatalogo}`;
  const linhasPorChave = new Map(decomposicao.naoRedundantes.map((l) => [chaveDe(l), l]));

  const regras: RegraCnpGerada[] = [];
  const naoEncontrados: string[] = [];

  for (const chave of classificacao.regraCnp_B) {
    const linha = linhasPorChave.get(chave);
    if (!linha) {
      naoEncontrados.push(chave);
      continue;
    }
    const grupoNorm = linha.grupoProposto.toUpperCase();
    for (const cnp of linha.cnps) {
      regras.push({
        cnp,
        grupoLaboratorialNomeNormalizado: grupoNorm,
        fabricanteLegalEsperadoNormalizado: linha.fabricanteAtualGarantia === "(sem fabricante)" ? null : linha.fabricanteAtualGarantia,
        evidencia: `Categoria B (REGRA_CNP_SEGURA): fabricante actual "${linha.fabricanteAtualGarantia}" na Garantia, titular ACTUAL no catálogo nacional = "${linha.titularCatalogoAtual}" (${linha.estadoRegistoCatalogo}) — evidência regulatória directa por CNP, nunca semelhança textual. Nunca promove o fabricante inteiro (associação integral), só este CNP.`,
        estado: "ATIVO",
        validadoManualmente: true,
      });
    }
  }

  for (const s of SUCESSOES_PARCIAIS) {
    for (const cnp of s.cnps) {
      regras.push({
        cnp,
        grupoLaboratorialNomeNormalizado: s.grupo,
        fabricanteLegalEsperadoNormalizado: s.fabricanteOrigem,
        evidencia: s.evidencia,
        estado: "ATIVO",
        validadoManualmente: true,
      });
    }
  }

  if (naoEncontrados.length > 0) {
    console.error(`[fatal] ${naoEncontrados.length} chave(s) em classificacao-pares-propostas-garantia.json não encontradas na decomposição:`);
    for (const c of naoEncontrados) console.error(`  ${c}`);
    process.exitCode = 1;
    return;
  }

  // Confirma que nenhum CNP recebe DUAS regras conflituosas (grupos diferentes) — nunca deve acontecer, mas nunca confiar sem verificar.
  const grupoPorCnp = new Map<number, string>();
  const conflitos: string[] = [];
  for (const r of regras) {
    const existente = grupoPorCnp.get(r.cnp);
    if (existente && existente !== r.grupoLaboratorialNomeNormalizado) {
      conflitos.push(`CNP ${r.cnp}: "${existente}" vs "${r.grupoLaboratorialNomeNormalizado}"`);
    } else {
      grupoPorCnp.set(r.cnp, r.grupoLaboratorialNomeNormalizado);
    }
  }
  if (conflitos.length > 0) {
    console.error(`[fatal] ${conflitos.length} CNP(s) com regras conflituosas (grupos diferentes):`);
    for (const c of conflitos) console.error(`  ${c}`);
    process.exitCode = 1;
    return;
  }

  const porGrupo = new Map<string, number>();
  for (const r of regras) porGrupo.set(r.grupoLaboratorialNomeNormalizado, (porGrupo.get(r.grupoLaboratorialNomeNormalizado) ?? 0) + 1);

  writeFileSync(saidaPath, JSON.stringify({ geradoEm: new Date().toISOString(), totalRegras: regras.length, regras }, null, 2), "utf8");
  console.log(`${regras.length} regras por CNP geradas, gravadas em ${saidaPath}`);
  for (const [g, n] of [...porGrupo].sort((a, b) => b[1] - a[1])) console.log(`  ${g}: ${n}`);
}

main();
