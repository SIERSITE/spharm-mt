/**
 * scripts/tests/test-metricas-catalogo-grupo-laboratorial.ts
 *
 * Regressão para o bug real encontrado em 2026-09-22: a métrica
 * `registosCatalogoParaGrupo.atuais/historicos` (simular-grupos-laboratoriais-garantia.ts)
 * comparava o titular do catálogo (SEMPRE canonicalizado, sem pontuação)
 * contra a grafia CRUA de garantia dos fabricantes integrais resolvidos
 * (ex.: "ALFASIGMA PORTUGAL LDA." — COM o ponto final, nunca
 * re-canonicalizada) — uma comparação entre uma forma canónica e uma
 * forma crua nunca bate, mesmo quando é literalmente o mesmo fabricante.
 * Isto explicava as contagens "0 atuais" para Alfasigma/Tecnimede/Towa/
 * Zentiva, que ficaram corrigidas (0→79, 0→546, 0→1101, 0→937
 * respectivamente) depois de canonicalizar `nomesFabricantesIntegrais`
 * com `normalizeFabricanteCanonico` antes de o comparar.
 *
 * Este teste replica o mecanismo com dados sintéticos mínimos, sem
 * depender dos dados reais de garantia nem do ficheiro CSV completo —
 * chama directamente as funções exportadas de
 * simular-grupos-laboratoriais-garantia.ts.
 *
 * Corre com: npx tsx scripts/tests/test-metricas-catalogo-grupo-laboratorial.ts
 */
import { construirMapasResolver, type ConfigGruposIniciais, type FabricanteExportado } from "../simular-grupos-laboratoriais-garantia";
import { normalizeFabricanteCanonico } from "../../lib/catalog-normalizers";

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${label}`); }
  else { ko++; console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`); }
};

console.log("A · um fabricante real com pontuação residual (ex.: 'X LDA.' com ponto) resolve, e a sua forma RAW nunca bate com um titular de catálogo já canonicalizado — só a forma RE-canonicalizada bate");
{
  const fabricantes: FabricanteExportado[] = [
    { id: "f1", nomeNormalizado: "ALFASIGMA PORTUGAL LDA.", estado: "ATIVO", aliases: [], produtosAssociados: 6 },
  ];
  const config: ConfigGruposIniciais = {
    grupos: [
      {
        nome: "Alfasigma",
        nomeNormalizado: "ALFASIGMA",
        aliases: [],
        fabricantesIntegrais: ["ALFASIGMA PORTUGAL LDA."],
      },
    ],
  };

  const { fabricantesIntegraisResolvidos } = construirMapasResolver(config, fabricantes);
  const resolvidos = fabricantesIntegraisResolvidos.get("g0")!;
  check(resolvidos.length === 1, "A1: o fabricante resolveu");
  const fabricanteNomeRaw = resolvidos[0]!.fabricanteNome;
  check(fabricanteNomeRaw === "ALFASIGMA PORTUGAL LDA.", "A2: fabricanteNome preserva a grafia CRUA (com ponto)", fabricanteNomeRaw);

  // O titular de um registo de catálogo REAL para esta mesma entidade,
  // depois de passar por normalizeFabricanteCanonico (sem pontuação).
  const titularCatalogoCanonico = normalizeFabricanteCanonico("Alfasigma Portugal, Lda.");
  check(titularCatalogoCanonico === "ALFASIGMA PORTUGAL LDA", "A3: titular do catálogo canonicaliza sem pontuação", String(titularCatalogoCanonico));

  check(fabricanteNomeRaw !== titularCatalogoCanonico, "A4: a forma CRUA NUNCA bate directamente com a forma canónica (é exactamente o bug)");
  check(normalizeFabricanteCanonico(fabricanteNomeRaw) === titularCatalogoCanonico, "A5: mas re-canonicalizar a forma crua ANTES de comparar resolve — é a correcção aplicada");
}

console.log("\nB · fabricante sem qualquer pontuação (caso comum) nunca foi afectado — raw == canónico já antes da correcção");
{
  const fabricantes: FabricanteExportado[] = [
    { id: "f1", nomeNormalizado: "ALFASIGMA LDA", estado: "ATIVO", aliases: [], produtosAssociados: 1 },
  ];
  const config: ConfigGruposIniciais = {
    grupos: [{ nome: "Alfasigma", nomeNormalizado: "ALFASIGMA", aliases: [], fabricantesIntegrais: ["ALFASIGMA LDA"] }],
  };
  const { fabricantesIntegraisResolvidos } = construirMapasResolver(config, fabricantes);
  const fabricanteNomeRaw = fabricantesIntegraisResolvidos.get("g0")![0]!.fabricanteNome;
  check(fabricanteNomeRaw === normalizeFabricanteCanonico(fabricanteNomeRaw), "B1: sem pontuação, a forma crua já era igual à canónica — por isso este caso nunca mostrou o bug");
}

console.log(`\n${ok} ok, ${ko} falhas`);
process.exit(ko === 0 ? 0 : 1);
