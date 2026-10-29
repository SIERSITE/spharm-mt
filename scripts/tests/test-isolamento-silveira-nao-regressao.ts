/**
 * scripts/tests/test-isolamento-silveira-nao-regressao.ts
 *
 * A entrega NÃO regride a Silveira, comparada com a base a69cbc5. Dados 100% sintéticos, PostgreSQL descartável
 * (TEST_PG_ADMIN_URL, recusa hosts não locais). Cada verificação diz PASSOU / FALHOU.
 *
 * Método: `_comparar-isolamento.ts` corre `_snapshot-tenant.ts` na árvore BASE (worktree a69cbc5, só lida/executada) e na
 * árvore ACTUAL, para o tenant `silveira`, sobre a MESMA base semeada, e devolve duas fotografias canónicas
 * (permissões, gates, menu, página, server actions reais, opções de fabricante, where do Catálogo, resolvedores, decisões
 * de ingestão, hashes dos ficheiros de ingestão). Cada ponto compara as duas E confronta com valores esperados fixos
 * (extraídos do comportamento do base).
 *
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres npx tsx scripts/tests/test-isolamento-silveira-nao-regressao.ts
 *
 * Nota: a árvore actual é lida TAL COMO ESTÁ no disco (HEAD + alterações por commitar de quem esteja a trabalhar nela).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { obterSnapshots, diferencas, classificarNaoGarantia, criarRunner, igual, git, SHA_BASE, ROOT_ATUAL } from "./_comparar-isolamento";

const { check, titulo, fim } = criarRunner();

async function main() {
  const snaps = await obterSnapshots(["silveira"]);
  const b = snaps.base.silveira;
  const a = snaps.atual.silveira;

  titulo("A · permissões — mapa da Silveira idêntico ao base (nenhuma permissão/acção nova)");
  check(b.tenant === "silveira" && a.tenant === "silveira", "A0: fotografias do tenant silveira");
  check(igual(b.permissoes, a.permissoes), "A1: matriz perfil × permissão idêntica ao base");
  check(igual(b.permissoes.nomes, a.permissoes.nomes), `A2: o conjunto de permissões é o mesmo (${a.permissoes.nomes.length}): sem permissões novas`);
  const m = a.permissoes.matriz;
  check(m.ADMINISTRADOR["catalog.write"] && m.GESTOR_GRUPO["catalog.write"] && !m.GESTOR_FARMACIA["catalog.write"] && !m.OPERADOR["catalog.write"], "A3: catalog.write = ADMINISTRADOR e GESTOR_GRUPO (valor fixo do base)");
  check(m.OPERADOR["catalog.read"] && !m.OPERADOR["reports.write"] && !m.OPERADOR["stock.sync"], "A4: OPERADOR continua só de leitura (valor fixo do base)");
  check(igual(b.permissoes.acessoFarmaciaAlheia, a.permissoes.acessoFarmaciaAlheia), "A5: visibilidade por farmácia (canAccessFarmaciaSync) idêntica");
  check(igual(b.acoes.exportadas, a.acoes.exportadas), `A6: as server actions exportadas são as mesmas (${a.acoes.exportadas.length}): nenhuma acção nova`, JSON.stringify({ base: b.acoes.exportadas, atual: a.acoes.exportadas }));

  titulo("B · manutenção do catálogo — rotas continuam acessíveis e dão o MESMO resultado");
  check(b.gates.manutencaoCatalogo.ativo === true && a.gates.manutencaoCatalogo.ativo === true, "B1: gate da manutenção ATIVO na Silveira (base e actual)");
  check(b.menu.visivel === true && a.menu.visivel === true, "B2: «Manutenção do catálogo» visível no menu (base e actual)");
  check(b.pagina.resultado === "renderizada" && a.pagina.resultado === "renderizada", "B3: página /catalogo/manutencao renderiza (base e actual), sem notFound");
  const ra = a.acoes.resultados;
  check(a.acoes.baseInalterada === true && b.acoes.baseInalterada === true, "B4: nenhuma das acções (incl. apply/revert forjados) alterou a base de dados");
  for (const perfil of ["ADMINISTRADOR", "GESTOR_GRUPO"]) {
    check(igual(b.acoes.resultados[perfil], ra[perfil]), `B5[${perfil}]: resultado de TODAS as acções (listar, preview, pesquisar, histórico, apply/revert recusados) idêntico ao base`);
    check(ra[perfil].listarProdutosManutencaoMassaAction.ok === true && ra[perfil].listarProdutosManutencaoMassaAction.totalCount === 10, `B6[${perfil}]: listar devolve os 10 produtos semeados (valor fixo)`);
    check(ra[perfil].previewManutencaoFabricanteAction.ok === true && ra[perfil].pesquisarFabricantesAction.resultados.length === 4, `B7[${perfil}]: preview de fabricante ok e pesquisa devolve 4 fabricantes (valor fixo)`);
    check(ra[perfil].aplicarManutencaoFabricanteAction.ok === false && ra[perfil].aplicarManutencaoFabricanteAction.code === "PREVIEW_DESACTUALIZADO", `B8[${perfil}]: apply com hash forjado recusado (PREVIEW_DESACTUALIZADO)`);
  }
  for (const perfil of ["GESTOR_FARMACIA", "OPERADOR", "sem-sessao", "ADMINISTRADOR-de-outro-tenant"]) {
    check(igual(b.acoes.resultados[perfil], ra[perfil]), `B9[${perfil}]: resultado idêntico ao base`);
    check(Object.values<any>(ra[perfil]).every((r) => r.ok === false && /Sem permiss/.test(r.error)), `B10[${perfil}]: TODAS as acções recusadas com «Sem permissão» (valor fixo do base)`);
  }

  titulo("C · ingestão — nada alterado (ficheiros e comportamento)");
  const caminhos = ["app/api/ingest", "lib/ingest"];
  const diffHead = git("diff", "--stat", SHA_BASE, "HEAD", "--", ...caminhos).trim();
  check(diffHead === "", "C1: `git diff --stat a69cbc5 HEAD -- app/api/ingest lib/ingest` VAZIO", diffHead);
  const diffTrabalho = git("diff", "--stat", SHA_BASE, "--", ...caminhos).trim();
  check(diffTrabalho === "", "C2: idem incluindo as alterações por commitar no disco (`git diff --stat a69cbc5 -- …`) VAZIO", diffTrabalho);
  const novos = git("ls-files", "--others", "--exclude-standard", "--", ...caminhos).trim();
  check(novos === "", "C3: nenhum ficheiro novo (não rastreado) em app/api/ingest nem lib/ingest", novos);
  const nHashes = Object.keys(a.ingestao.hashes).length;
  check(nHashes > 10 && igual(b.ingestao.hashes, a.ingestao.hashes), `C4: SHA-1 do conteúdo dos ${nHashes} ficheiros de ingestão idêntico entre as duas árvores`);
  const ing = a.ingestao;
  check(igual(b.ingestao.decidirFabricanteSilveira, ing.decidirFabricanteSilveira), "C5: decidirFabricanteSilveira idêntico ao base (4 entradas fixas)");
  check(igual(ing.decidirFabricanteSilveira.map((d: any) => d.escrever), [true, false, false, false]), "C6: decidirFabricanteSilveira: só escreve com campo vazio e sem validação manual (valor fixo)");
  check(igual(b.ingestao.decidirFabricanteBaseline, ing.decidirFabricanteBaseline), "C7: decidirFabricanteBaseline (outros tenants) idêntico ao base");
  check(igual(b.ingestao.decidirDesignacao, ing.decidirDesignacao) && igual(b.ingestao.normalizarDesignacao, ing.normalizarDesignacao), `C8: decidirDesignacao idêntico ao base (${Object.keys(ing.decidirDesignacao).length} combinações modo × existente × recebida)`);
  const dd = ing.decidirDesignacao;
  check(dd['AUTORITATIVA|diferente|"X"'] === "ALTERAR" && dd['AUTORITATIVA|manual|"X"'] === "IGNORADA_MANUAL" && dd['SO_CRIACAO|diferente|"X"'] === "IGNORADA_ORIGEM" && dd['LEGACY|sem-existente|"X"'] === "CRIAR" && dd['AUTORITATIVA|igual|"  "'] === "IGNORADA_VAZIA", "C9: designação autoritativa: alterar / proteger manual / só-criação / criar / vazia (valores fixos)");
  const modos = ing.modoDesignacao;
  check(igual(b.ingestao.modoDesignacao, modos), "C10: resolverModoDesignacao (real, sobre a base) idêntico ao base");
  check(modos["silveira|farm-1"].modo === "AUTORITATIVA" && modos["silveira|farm-2"].modo === "SO_CRIACAO" && modos["garantia|farm-1"].modo === "LEGACY" && modos["sier|farm-1"].modo === "LEGACY", "C11: Silveirense AUTORITATIVA, outra farmácia da Silveira SO_CRIACAO, garantia/sier LEGACY (valores fixos)");
  check(b.gates.ingestaoFabricanteNuncaReescrever === true && a.gates.ingestaoFabricanteNuncaReescrever === true && a.gates.designacaoAutoritativa === true, "C12: gates de ingestão da Silveira intactos (modoNuncaReescreverFabricante, designação autoritativa)");
  const rota = readFileSync(path.join(ROOT_ATUAL, "app/api/ingest/v1/bootstrap/products/route.ts"), "utf8");
  check((rota.match(/ctx\.tenant\.slug === TENANT_CATALOGO_MASSA/g) ?? []).length === 2, "C13: a rota de ingestão continua a comparar o tenant só com TENANT_CATALOGO_MASSA (2 usos)");
  check(igual(b.constantes.TENANT_CATALOGO_MASSA, "silveira") && igual(a.constantes.TENANT_CATALOGO_MASSA, "silveira") && igual(a.constantes.TENANT_DESIGNACAO_AUTORITATIVA, "silveira"), "C14: constantes de ingestão = silveira");

  titulo("D · fabricantes da Silveira — opções, filtros e agrupamentos inalterados e SEM agrupamento");
  const fo = (x: any) => ({ ...x.filtros.opcoesRelatorio, formas: undefined });
  check(igual(fo(b), fo(a)), "D1: opções dos relatórios (fabricantes, distribuidores, categorias, …) idênticas ao base (exceto `formas`, ponto 6)");
  check(igual(a.filtros.opcoesRelatorio.fabricantes, ["PFIZER LABORATORIOS", "SOLO LAB", "VIATRIS ALFA", "VIATRIS BETA", "VIATRIS GAMA", "VIATRIS PHARMA LDA"]), "D2: lista de fabricantes = 6 fabricantes soltos, ordenados (valor fixo do base; sem «Viatris» como grupo)");
  check(a.filtros.opcoesRelatorio.laboratorios === undefined && b.filtros.opcoesRelatorio.laboratorios === undefined, "D3: `laboratorios` (opções agrupadas) AUSENTE na Silveira, como no base");
  check(!JSON.stringify(a.filtros.opcoesRelatorio).includes("variante") && !JSON.stringify(a.filtros.opcoesRelatorio).includes("grupo:"), "D4: nenhuma opção com «variantes» nem valor `grupo:` nas opções dos relatórios");
  const labsCat = a.catalogo.opcoes.laboratorios;
  check(igual(b.catalogo.opcoes.laboratorios, labsCat) && igual(b.catalogo.opcoes.classificacoesN1, a.catalogo.opcoes.classificacoesN1), "D5: opções de laboratório do Catálogo idênticas ao base");
  check(labsCat.length === 7 && labsCat.every((o: any) => o.tipo === "fabricante" && o.produtos === 0 && !("variantes" in o)), "D6: Catálogo da Silveira: 7 opções (todos os fabricantes ATIVOS, incl. o sem produtos), todas `fabricante`, sem `variantes`, sem grupos (valor fixo)");
  check(!labsCat.some((o: any) => String(o.id).startsWith("grupo:") || o.tipo === "grupo"), "D7: nenhuma opção `grupo`/`grupo:` no Catálogo da Silveira");
  check(igual(b.catalogo.listagem, a.catalogo.listagem), "D8: where do Catálogo por laboratório + produtos devolvidos idênticos ao base (5 cenários)");
  const l = a.catalogo.listagem;
  check(igual(l["fabricante:fab-v1"].where, { fabricanteId: "fab-v1" }) && igual(l["id-nu-fab-solo"].where, { fabricanteId: "fab-solo" }), "D9: where por fabricante = { fabricanteId } (valor fixo)");
  check(igual(l["fabricante:fab-v1"].cnps, [8400001, 8400002]) && igual(l["fabricante:fab-pfizer"].cnps, [8400005, 8400006]), "D10: produtos por fabricante (valores fixos)");
  const r = a.resolucao;
  check(igual(b.resolucao.idsProdutoPorSelecao, r.idsProdutoPorSelecao), "D11: resolverProdutoIdsPorLaboratoriosSelecionados idêntico ao base (6 selecções)");
  check(r.idsProdutoPorSelecao.grupo.length === 0 && r.idsProdutoPorSelecao["nome-solto-grupo"].length === 0 && r.idsProdutoPorSelecao["fabricante-v1"].length === 2, "D12: na Silveira «grupo:» e o nome de um grupo NUNCA resolvem produtos; fabricante resolve só os seus (valores fixos)");
  check(igual(b.resolucao.whereLaboratorio, r.whereLaboratorio) && igual(b.resolucao.pesquisa, r.pesquisa), "D13: resolverFiltroLaboratorioWhere e pesquisarLaboratorios idênticos ao base");
  check(igual(r.agrupadoNoCliente, []), "D14: o agrupamento (agruparOpcoesLaboratorio) sobre as opções da Silveira dá lista VAZIA — não há grupos");

  titulo("E · tudo o resto igual — diferenças TOTAIS base × actual na Silveira");
  const ds = diferencas(b, a);
  const inesperadas = ds.filter((d) => !classificarNaoGarantia(d).esperada);
  check(inesperadas.length === 0, `E1: 0 diferenças inesperadas (de ${ds.length} diferenças, todas declaradas)`, inesperadas.map((d) => `${d.caminho}: ${JSON.stringify(d.base)} -> ${JSON.stringify(d.atual)}`).join("\n            "));
  const razoes = new Map<string, number>();
  for (const d of ds) { const c = classificarNaoGarantia(d); if (c.esperada) razoes.set(c.razao, (razoes.get(c.razao) ?? 0) + 1); }
  console.log("  Diferenças esperadas (declaradas):");
  for (const [rz, n] of razoes) console.log(`    x${n}  ${rz}`);
  fim();
}

main().catch((e) => { console.error(e); process.exit(1); });
