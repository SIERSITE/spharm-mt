/**
 * scripts/descobrir-cnps-sucessao-por-par.ts
 *
 * Utilitário de investigação ONE-OFF: dado um par (substring do fabricante
 * ATUAL em garantia, substring do titular ATUAL no catálogo), lista os
 * CNPs exactos que correspondem — usado para transformar candidatos de
 * texto livre (ex.: "MSD → Organon, ~80 CNPs") em listas de CNP concretas,
 * auditáveis, antes de as promover a RegraGrupoLaboratorialPorCnp.
 *
 * Zero escritas, zero Prisma. Reaproveita o carregamento de dados do
 * simulador.
 *
 * Uso:
 *   npx tsx scripts/descobrir-cnps-sucessao-por-par.ts \
 *     --produtos=... --catalogo=... \
 *     --fabricante="MERCK SHARP" --titular="Organon"
 */
import { readFileSync } from "node:fs";
import { carregarCatalogoStreaming, type ExportProdutosFabricantes } from "./simular-grupos-laboratoriais-garantia";
import { ehEstadoAtual } from "../lib/catalog/catalogo-nacional-parser";

function arg(name: string): string {
  const a = process.argv.slice(2).find((x) => x.startsWith(`--${name}=`));
  if (!a) throw new Error(`--${name}=<valor> é obrigatório`);
  return a.slice(name.length + 3);
}

async function main() {
  const produtosPath = arg("produtos");
  const catalogoPath = arg("catalogo");
  const fabricanteSub = arg("fabricante").toUpperCase();
  const titularSub = arg("titular").toUpperCase();

  const exportado = JSON.parse(readFileSync(produtosPath, "utf8")) as ExportProdutosFabricantes;
  const { snapshotsPorCnp } = await carregarCatalogoStreaming(catalogoPath);

  const encontrados: Array<{ cnp: number; designacao: string; fabricanteAtual: string; titularCatalogo: string; estado: string }> = [];
  for (const p of exportado.produtos) {
    if (p.cnp === null) continue;
    const fab = (p.fabricanteNomeNormalizado ?? "").toUpperCase();
    if (!fab.includes(fabricanteSub)) continue;
    const snap = snapshotsPorCnp.get(p.cnp);
    if (!snap || !snap.titularAim) continue;
    if (!snap.titularAim.toUpperCase().includes(titularSub)) continue;
    if (!ehEstadoAtual(snap.estadoAim)) continue;
    encontrados.push({ cnp: p.cnp, designacao: p.designacao, fabricanteAtual: p.fabricanteNomeNormalizado ?? "", titularCatalogo: snap.titularAim, estado: snap.estadoAim ?? "" });
  }

  console.log(`${encontrados.length} produto(s) — fabricante atual contém "${fabricanteSub}", titular catálogo (estado ACTUAL) contém "${titularSub}"`);
  console.log(JSON.stringify(encontrados.map((e) => e.cnp), null, 0));
  for (const e of encontrados) console.log(`  ${e.cnp}  ${e.designacao}  |  "${e.fabricanteAtual}" → "${e.titularCatalogo}" (${e.estado})`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
