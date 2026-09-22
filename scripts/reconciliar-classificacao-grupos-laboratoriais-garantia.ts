/**
 * scripts/reconciliar-classificacao-grupos-laboratoriais-garantia.ts
 *
 * Produz uma reconciliação EXPLÍCITA e AUDITÁVEL da classificação de
 * grupos laboratoriais, respondendo à confusão apontada em 2026-09-22:
 * um relatório anterior mostrava, lado a lado, "71 propostas pendentes"
 * (a contagem FINAL, depois de aplicar as 342 regras por CNP) e "29
 * pares / 147 produtos promovidos a regra_cnp" (uma contagem de uma fase
 * INTERMÉDIA — a decomposição das propostas ANTES da promoção) sem
 * deixar claro que eram dois MOMENTOS diferentes do mesmo pipeline. Os
 * 147 nunca poderiam ser um subconjunto dos 71 — são exactamente os
 * produtos que SAÍRAM da categoria "pendente" para entrar em
 * "definitivo" via regra_cnp.
 *
 * Este script corre o pipeline em DOIS momentos concretos, nomeados sem
 * ambiguidade, e imprime uma reconciliação linha a linha entre eles:
 *
 *   MOMENTO 1 — "antes da promoção desta sessão": config com os 5 grupos
 *   originais (Viatris/Alfasigma/Teva/Kenvue/Tecnimede) tal como existiam
 *   no commit 6bd1c2e (a precedência já corrigida, mas SEM os grupos
 *   Towa/Organon/Sandoz/Zentiva/Opella, SEM as regras por CNP geradas
 *   nesta sessão). É o ficheiro scripts/data/grupos-laboratoriais-iniciais-garantia.json
 *   nesse commit — lido directamente do git via `git show`, nunca
 *   reconstruído de memória.
 *
 *   MOMENTO 2 — "depois da promoção desta sessão": config e regras tal
 *   como estão HOJE no branch (os 10 grupos, as 342 regras validadas).
 *
 * Cada produto tem de estar em EXACTAMENTE UMA categoria final em cada
 * momento — isto é uma propriedade estrutural de `resolverGrupoDoProduto`
 * (retorna um único `ClassificacaoGrupoResultado`), mas o script verifica-o
 * de qualquer forma, activamente, e FALHA (exit 1) se:
 *   - definitivos + pendentes + semGrupo != total de produtos analisados;
 *   - o mesmo produtoId aparecer em mais de uma categoria final;
 *   - a soma dos 6 níveis mutuamente exclusivos não bater com o total.
 *
 * Zero escritas, zero Prisma.
 *
 * Uso:
 *   npx tsx scripts/reconciliar-classificacao-grupos-laboratoriais-garantia.ts \
 *     --produtos=<path> --catalogo=<path> \
 *     --config-antes=<path-ou-git-ref:path> --config-depois=<path> \
 *     --regras-depois=<path>
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolverGruposEmLote, type ProdutoParaResolver, type MapasResolverGrupo } from "../lib/catalog/resolver-grupo-laboratorial";
import {
  carregarCatalogoStreaming,
  construirMapasResolver,
  type ExportProdutosFabricantes,
  type ConfigGruposIniciais,
} from "./simular-grupos-laboratoriais-garantia";

function arg(name: string): string {
  const a = process.argv.slice(2).find((x) => x.startsWith(`--${name}=`));
  if (!a) throw new Error(`--${name}=<valor> é obrigatório`);
  return a.slice(name.length + 3);
}
function argOpt(name: string): string | undefined {
  const a = process.argv.slice(2).find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : undefined;
}

/** "gitref:path/no/repo" → conteúdo via `git show`; caminho normal → readFileSync. */
function lerConfig(caminho: string): ConfigGruposIniciais {
  if (caminho.includes(":") && !caminho.match(/^[A-Za-z]:[\\/]/)) {
    // não é um caminho absoluto Windows (C:\...) — trata como <ref>:<path-no-repo>
    const conteudo = execSync(`git show "${caminho}"`, { cwd: __dirname + "/..", encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    return JSON.parse(conteudo) as ConfigGruposIniciais;
  }
  return JSON.parse(readFileSync(caminho, "utf8")) as ConfigGruposIniciais;
}

type RegrasFicheiro = { regras: Array<{ cnp: number; grupoLaboratorialNomeNormalizado: string; estado: "ATIVO" | "INATIVO"; validadoManualmente: boolean }> };

function construirRegras(
  regrasPath: string | undefined,
  gruposPorId: Map<string, { id: string; nomeNormalizado: string }>,
): MapasResolverGrupo["regrasCnpPorCnp"] {
  if (!regrasPath) return new Map();
  const grupoIdPorNome = new Map<string, string>();
  for (const [id, g] of gruposPorId) grupoIdPorNome.set(g.nomeNormalizado, id);
  const ficheiro = JSON.parse(readFileSync(regrasPath, "utf8")) as RegrasFicheiro;
  const mapa = new Map<number, { id: string; grupoLaboratorialId: string; estado: "ATIVO" | "INATIVO"; validadoManualmente: boolean }>();
  ficheiro.regras.forEach((r, idx) => {
    const grupoId = grupoIdPorNome.get(r.grupoLaboratorialNomeNormalizado);
    if (!grupoId) return;
    mapa.set(r.cnp, { id: `regra${idx}`, grupoLaboratorialId: grupoId, estado: r.estado, validadoManualmente: r.validadoManualmente });
  });
  return mapa;
}

type Momento = {
  nome: string;
  totais: ReturnType<typeof resolverGruposEmLote>["totais"];
  porProdutoId: Map<string, string>; // produtoId -> tipo ("mantido_manual" | "regra_cnp" | ... | "sem_grupo")
};

async function correr(
  nome: string,
  configPath: string,
  regrasPath: string | undefined,
  exportado: ExportProdutosFabricantes,
  snapshotsPorCnp: MapasResolverGrupo["snapshotsPorCnp"],
): Promise<Momento> {
  const config = lerConfig(configPath);
  const { mapas: mapasBase, gruposPorId } = construirMapasResolver(config, exportado.fabricantes);
  const regrasCnpPorCnp = construirRegras(regrasPath, gruposPorId);
  const mapas: MapasResolverGrupo = { ...mapasBase, snapshotsPorCnp, regrasCnpPorCnp };

  const produtosParaResolver: ProdutoParaResolver[] = exportado.produtos
    .filter((p): p is (typeof exportado.produtos)[number] & { cnp: number } => p.cnp !== null)
    .map((p) => ({ id: p.id, cnp: p.cnp, fabricanteId: p.fabricanteId, grupoExistente: null }));

  const relatorio = resolverGruposEmLote(produtosParaResolver, mapas);
  const porProdutoId = new Map(relatorio.resultados.map((r) => [r.produtoId, r.resultado.tipo]));

  return { nome, totais: relatorio.totais, porProdutoId };
}

function imprimirTotais(m: Momento): void {
  const t = m.totais;
  console.log(`\n── ${m.nome} ──`);
  console.log(`  produtos analisados (cnp != null): ${t.produtos}`);
  console.log(`  1. mantido_manual:        ${t.mantidoManual}`);
  console.log(`  2. regra_cnp:             ${t.regraCnp}`);
  console.log(`  3. fabricante_inequivoco: ${t.fabricanteInequivoco}`);
  console.log(`  4. proposta_snapshot_cnp: ${t.propostaSnapshotCnp}`);
  console.log(`  5. alias_inequivoco:      ${t.aliasInequivoco}`);
  console.log(`  6. sem_grupo:             ${t.semGrupo}`);
  const definitivo = t.mantidoManual + t.regraCnp + t.fabricanteInequivoco + t.aliasInequivoco;
  console.log(`  ─────────────────────────────────────`);
  console.log(`  DEFINITIVO (1+2+3+5):     ${definitivo}`);
  console.log(`  PENDENTE (4):             ${t.propostaSnapshotCnp}`);
  console.log(`  SEM GRUPO (6):            ${t.semGrupo}`);
  const soma = definitivo + t.propostaSnapshotCnp + t.semGrupo;
  console.log(`  soma = ${soma}  (produtos analisados = ${t.produtos})  ${soma === t.produtos ? "✓ bate certo" : "✗ NÃO BATE"}`);
}

async function main(): Promise<void> {
  const produtosPath = arg("produtos");
  const catalogoPath = arg("catalogo");
  const configAntes = arg("config-antes");
  const configDepois = arg("config-depois");
  const regrasDepois = argOpt("regras-depois");

  const exportado = JSON.parse(readFileSync(produtosPath, "utf8")) as ExportProdutosFabricantes;
  const { snapshotsPorCnp } = await carregarCatalogoStreaming(catalogoPath);

  const antes = await correr("MOMENTO 1 — antes da promoção desta sessão (5 grupos originais, sem regras por CNP)", configAntes, undefined, exportado, snapshotsPorCnp);
  const depois = await correr("MOMENTO 2 — depois da promoção desta sessão (10 grupos, 342 regras validadas)", configDepois, regrasDepois, exportado, snapshotsPorCnp);

  imprimirTotais(antes);
  imprimirTotais(depois);

  // ── Verificações estruturais (falham com exit 1, nunca só avisam) ──
  let falhas = 0;
  const falhar = (msg: string) => { console.error(`\n✗ FALHA: ${msg}`); falhas++; };

  for (const m of [antes, depois]) {
    const t = m.totais;
    const definitivo = t.mantidoManual + t.regraCnp + t.fabricanteInequivoco + t.aliasInequivoco;
    if (definitivo + t.propostaSnapshotCnp + t.semGrupo !== t.produtos) {
      falhar(`${m.nome}: definitivos(${definitivo}) + pendentes(${t.propostaSnapshotCnp}) + semGrupo(${t.semGrupo}) != produtos analisados(${t.produtos})`);
    }
    if (definitivo + t.propostaSnapshotCnp + t.semGrupo !== exportado.produtos.length) {
      falhar(`${m.nome}: total reconciliado (${definitivo + t.propostaSnapshotCnp + t.semGrupo}) != total de produtos exportados (${exportado.produtos.length})`);
    }
  }

  // Nenhum produto pode aparecer em mais de UMA categoria final dentro do MESMO momento —
  // trivial dado o desenho de resolverGrupoDoProduto (Map produtoId->tipo, uma entrada cada),
  // mas verificado activamente: `resultados.length` tem de bater com o número de chaves
  // ÚNICAS do Map — se resolverGruposEmLote alguma vez devolvesse duas entradas para o
  // mesmo produtoId, o Map colapsava-as silenciosamente e este total divergia.
  for (const m of [antes, depois]) {
    if (m.porProdutoId.size !== m.totais.produtos) {
      falhar(`${m.nome}: produtoId duplicado detectado na classificação (${m.totais.produtos} produtos analisados, só ${m.porProdutoId.size} chaves únicas no resultado)`);
    }
  }

  // ── Reconciliação MOMENTO 1 → MOMENTO 2, produto a produto ──────────
  console.log(`\n── Reconciliação produto-a-produto (MOMENTO 1 → MOMENTO 2) ──`);
  const transicoes = new Map<string, number>(); // "tipoAntes→tipoDepois" -> contagem
  for (const [produtoId, tipoAntes] of antes.porProdutoId) {
    const tipoDepois = depois.porProdutoId.get(produtoId) ?? "?";
    const chave = `${tipoAntes} → ${tipoDepois}`;
    transicoes.set(chave, (transicoes.get(chave) ?? 0) + 1);
  }
  const linhas = [...transicoes.entries()].sort((a, b) => b[1] - a[1]);
  for (const [transicao, n] of linhas) console.log(`  ${String(n).padStart(6)}  ${transicao}`);

  const totalTransicoes = linhas.reduce((s, [, n]) => s + n, 0);
  console.log(`  ${String(totalTransicoes).padStart(6)}  TOTAL`);
  if (totalTransicoes !== antes.totais.produtos) falhar(`total de transições (${totalTransicoes}) != produtos no MOMENTO 1 (${antes.totais.produtos})`);

  // Quantos migraram de pendente (proposta_snapshot_cnp) para regra_cnp especificamente — é ISTO que "os 147" tinham de significar.
  const pendenteParaRegraCnp = transicoes.get("proposta_snapshot_cnp → regra_cnp") ?? 0;
  const pendenteParaFabricanteInequivoco = transicoes.get("proposta_snapshot_cnp → fabricante_inequivoco") ?? 0;
  const semGrupoParaFabricanteInequivoco = transicoes.get("sem_grupo → fabricante_inequivoco") ?? 0;
  const semGrupoParaRegraCnp = transicoes.get("sem_grupo → regra_cnp") ?? 0;
  const pendenteAindaPendente = transicoes.get("proposta_snapshot_cnp → proposta_snapshot_cnp") ?? 0;
  console.log(`\n  pendente(M1) → regra_cnp(M2):             ${pendenteParaRegraCnp}   (promovidos via RegraGrupoLaboratorialPorCnp — os pares B da decomposição original)`);
  console.log(`  pendente(M1) → fabricante_inequivoco(M2): ${pendenteParaFabricanteInequivoco}   (promovidos via associação integral — os pares A: Sigma-Tau, Alfa Wasserman, Cephalon)`);
  console.log(`  sem_grupo(M1) → fabricante_inequivoco(M2): ${semGrupoParaFabricanteInequivoco}   (produtos de Organon/Sandoz/Zentiva/Opella/Towa cujo PRÓPRIO fabricante passou a integral de um grupo NOVO)`);
  console.log(`  sem_grupo(M1) → regra_cnp(M2):             ${semGrupoParaRegraCnp}   (produtos MSD/Novartis/Sanofi/Boehringer com regra por CNP para um grupo NOVO)`);
  console.log(`  pendente(M1) → pendente(M2):               ${pendenteAindaPendente}   (continuam pendentes — não foram tocados)`);

  console.log(`\n${falhas === 0 ? "✓ Todas as verificações estruturais passaram." : `✗ ${falhas} verificação(ões) falharam.`}`);
  process.exitCode = falhas === 0 ? 0 : 1;
}

main().catch((err) => { console.error("[erro fatal]", err); process.exitCode = 1; });
