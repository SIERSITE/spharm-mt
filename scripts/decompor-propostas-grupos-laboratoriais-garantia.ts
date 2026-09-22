/**
 * scripts/decompor-propostas-grupos-laboratoriais-garantia.ts
 *
 * Decompõe TODAS as classificações `proposta_snapshot_cnp` (nível 4) que
 * `simular-grupos-laboratoriais-garantia.ts` produz, agrupadas por
 * (grupo proposto, fabricante ATUAL na Garantia, titular ATUAL no
 * catálogo, estado do registo) — a tabela pedida explicitamente, nunca
 * apenas 5 exemplos por grupo.
 *
 * NOTA HISTÓRICA (2026-09-22): este script foi o que revelou que a
 * precedência original (proposta ANTES de fabricante inequívoco) escondia
 * 1153 de 1336 "propostas" que já estavam definitivamente resolvidas ao
 * nível do fabricante legal — o resolver foi corrigido para avaliar o
 * fabricante inequívoco (agora nível 3) ANTES da proposta bruta (agora
 * nível 4). Por isso, ao correr HOJE contra os dados reais, a categoria
 * "REDUNDANTES_SEGURAS" abaixo deve estar vazia (o nível 3 já as
 * intercepta antes de chegarem ao nível 4) — o código continua a marcá-la
 * explicitamente, como salvaguarda de regressão caso a precedência volte
 * a mudar no futuro.
 *
 * Para cada linha, marca se o fabricante ATUAL da Garantia já está
 * `fabricante_inequivoco` do MESMO grupo — chamamos a isto
 * "REDUNDANTE_SEGURA".
 *
 * Zero escritas. Zero ligação Prisma. Reaproveita as funções puras do
 * simulador sem as duplicar.
 *
 * Uso:
 *   npx tsx scripts/decompor-propostas-grupos-laboratoriais-garantia.ts \
 *     --produtos=.local-data/fabricantes-garantia/produtos-fabricantes-garantia.json \
 *     --catalogo=.local-data/fabricantes-garantia/catalogo/teste.csv \
 *     --config=scripts/data/grupos-laboratoriais-iniciais-garantia.json \
 *     --saida=.local-data/fabricantes-garantia/decomposicao-propostas.json
 */
import { existsSync, readFileSync } from "node:fs";
import { resolverGruposEmLote, type ProdutoParaResolver, type MapasResolverGrupo } from "../lib/catalog/resolver-grupo-laboratorial";
import {
  carregarCatalogoStreaming,
  construirMapasResolver,
  escreverAtomico,
  type ExportProdutosFabricantes,
  type ConfigGruposIniciais,
} from "./simular-grupos-laboratoriais-garantia";

type Args = { produtosPath: string; catalogoPath: string; configPath: string; saidaPath: string };

function parseArgs(argv: readonly string[]): Args {
  const out: Partial<Args> = {};
  for (const a of argv) {
    if (a.startsWith("--produtos=")) out.produtosPath = a.slice("--produtos=".length);
    else if (a.startsWith("--catalogo=")) out.catalogoPath = a.slice("--catalogo=".length);
    else if (a.startsWith("--config=")) out.configPath = a.slice("--config=".length);
    else if (a.startsWith("--saida=")) out.saidaPath = a.slice("--saida=".length);
    else throw new Error(`argumento desconhecido: ${a}`);
  }
  if (!out.produtosPath || !out.catalogoPath || !out.configPath || !out.saidaPath) {
    throw new Error("--produtos, --catalogo, --config e --saida são obrigatórios");
  }
  return out as Args;
}

type LinhaDecomposicao = {
  grupoProposto: string;
  fabricanteAtualGarantia: string;
  fabricanteAtualJaIntegralDoMesmoGrupo: boolean;
  fabricanteAtualIntegralDeOutroGrupo: string | null;
  titularCatalogoAtual: string;
  estadoRegistoCatalogo: string;
  quantidadeProdutos: number;
  cnps: number[];
  exemploDesignacao: string;
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  for (const [label, path] of [["--produtos", args.produtosPath], ["--catalogo", args.catalogoPath], ["--config", args.configPath]] as const) {
    if (!existsSync(path)) throw new Error(`${label} não encontrado: ${path}`);
  }

  const exportado = JSON.parse(readFileSync(args.produtosPath, "utf8")) as ExportProdutosFabricantes;
  const config = JSON.parse(readFileSync(args.configPath, "utf8")) as ConfigGruposIniciais;
  const { snapshotsPorCnp } = await carregarCatalogoStreaming(args.catalogoPath);
  const { mapas: mapasBase, gruposPorId } = construirMapasResolver(config, exportado.fabricantes);
  const mapas: MapasResolverGrupo = { ...mapasBase, snapshotsPorCnp };

  const produtosParaResolver: ProdutoParaResolver[] = exportado.produtos
    .filter((p): p is typeof p & { cnp: number } => p.cnp !== null)
    .map((p) => ({ id: p.id, cnp: p.cnp, fabricanteId: p.fabricanteId, grupoExistente: null }));
  const relatorio = resolverGruposEmLote(produtosParaResolver, mapas);
  const produtosPorId = new Map(exportado.produtos.map((p) => [p.id, p]));

  // fabricanteId -> nome do grupo a que é integral (se algum)
  const grupoIntegralPorFabricanteId = new Map<string, string>();
  for (const [fabId, gf] of mapas.gruposFabricantePorFabricanteId) {
    grupoIntegralPorFabricanteId.set(fabId, gruposPorId.get(gf.grupoLaboratorialId)!.nome);
  }

  const grupos = new Map<string, LinhaDecomposicao>();
  for (const { produtoId, resultado } of relatorio.resultados) {
    if (resultado.tipo !== "proposta_snapshot_cnp") continue;
    const produto = produtosPorId.get(produtoId)!;
    const grupoNome = gruposPorId.get(resultado.grupoLaboratorialId)!.nome;
    const snap = snapshotsPorCnp.get(produto.cnp!);
    const fabricanteAtual = produto.fabricanteNomeNormalizado ?? "(sem fabricante)";
    const titular = snap?.titularAim ?? "(desconhecido)";
    const estado = snap?.estadoAim ?? "(desconhecido)";

    const grupoIntegralDoFabricanteAtual = produto.fabricanteId ? grupoIntegralPorFabricanteId.get(produto.fabricanteId) ?? null : null;
    const jaIntegralMesmoGrupo = grupoIntegralDoFabricanteAtual === grupoNome;
    const integralDeOutroGrupo = grupoIntegralDoFabricanteAtual && grupoIntegralDoFabricanteAtual !== grupoNome ? grupoIntegralDoFabricanteAtual : null;

    const chave = `${grupoNome}|||${fabricanteAtual}|||${titular}|||${estado}`;
    const existente = grupos.get(chave);
    if (existente) {
      existente.quantidadeProdutos++;
      if (!existente.cnps.includes(produto.cnp!)) existente.cnps.push(produto.cnp!);
    } else {
      grupos.set(chave, {
        grupoProposto: grupoNome,
        fabricanteAtualGarantia: fabricanteAtual,
        fabricanteAtualJaIntegralDoMesmoGrupo: jaIntegralMesmoGrupo,
        fabricanteAtualIntegralDeOutroGrupo: integralDeOutroGrupo,
        titularCatalogoAtual: titular,
        estadoRegistoCatalogo: estado,
        quantidadeProdutos: 1,
        cnps: [produto.cnp!],
        exemploDesignacao: produto.designacao,
      });
    }
  }

  const linhas = [...grupos.values()].sort((a, b) => b.quantidadeProdutos - a.quantidadeProdutos);

  const redundantesSeguras = linhas.filter((l) => l.fabricanteAtualJaIntegralDoMesmoGrupo);
  const naoRedundantes = linhas.filter((l) => !l.fabricanteAtualJaIntegralDoMesmoGrupo);

  console.log("═".repeat(100));
  console.log(`Decomposição de propostas — ${linhas.length} pares distintos (fabricante atual × titular catálogo), ${relatorio.totais.propostaSnapshotCnp} produtos no total`);
  console.log("═".repeat(100));
  console.log(`\nREDUNDANTES_SEGURAS (fabricante atual já é fabricante_inequivoco do MESMO grupo — nível 4 só confirma o nível 3, não é uma ambiguidade real):`);
  console.log(`  ${redundantesSeguras.length} pares, ${redundantesSeguras.reduce((s, l) => s + l.quantidadeProdutos, 0)} produtos`);
  for (const l of redundantesSeguras) {
    console.log(`    [${l.quantidadeProdutos}x, ${l.cnps.length} cnp] ${l.grupoProposto} ← "${l.fabricanteAtualGarantia}" (já integral) | catálogo: "${l.titularCatalogoAtual}" (${l.estadoRegistoCatalogo})`);
  }

  console.log(`\nNÃO REDUNDANTES (fabricante atual NÃO é integral do grupo proposto — requerem decisão real):`);
  console.log(`  ${naoRedundantes.length} pares, ${naoRedundantes.reduce((s, l) => s + l.quantidadeProdutos, 0)} produtos`);
  for (const l of naoRedundantes) {
    const aviso = l.fabricanteAtualIntegralDeOutroGrupo ? `  ⚠ fabricante atual É integral de "${l.fabricanteAtualIntegralDeOutroGrupo}" (grupo DIFERENTE!)` : "";
    console.log(`    [${l.quantidadeProdutos}x, ${l.cnps.length} cnp] ${l.grupoProposto} ← "${l.fabricanteAtualGarantia}" | catálogo: "${l.titularCatalogoAtual}" (${l.estadoRegistoCatalogo})${aviso}`);
  }

  escreverAtomico(
    args.saidaPath,
    JSON.stringify(
      {
        geradoEm: new Date().toISOString(),
        totalPropostas: relatorio.totais.propostaSnapshotCnp,
        totalParesDistintos: linhas.length,
        redundantesSeguras,
        naoRedundantes,
      },
      null,
      2,
    ),
  );
  console.log(`\nGuardado em: ${args.saidaPath}`);
}

main().catch((err) => {
  console.error("[erro fatal]", err);
  process.exitCode = 1;
});
