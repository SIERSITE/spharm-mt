/**
 * scripts/tests/test-isolamento-sier-recusa.ts
 *
 * A entrega NÃO ativa nada no Sier (nem em qualquer outro tenant que não seja silveira/garantia, nem sem tenant) e o
 * agrupamento de fabricantes é só do Garantia. Dados 100% sintéticos, PostgreSQL descartável (TEST_PG_ADMIN_URL, recusa
 * hosts não locais). Cada verificação diz PASSOU / FALHOU.
 *
 * As server actions, a página, `getSession`/`can`, `getReportingFilterOptions`, `loadCatalogo*` e os resolvedores são os
 * REAIS (via `_snapshot-tenant.ts`; só `next/headers`, `next/cache`, `@/lib/prisma` e a leitura do cabeçalho do tenant são
 * simulados). Cada tenant é fotografado nas duas árvores (base a69cbc5 e actual) sobre a mesma base semeada. A garantia
 * serve de CONTROLO POSITIVO (prova que os testes distinguem «ativo» de «recusado»).
 *
 *   TEST_PG_ADMIN_URL=postgresql://postgres:test@localhost:15433/postgres npx tsx scripts/tests/test-isolamento-sier-recusa.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { obterSnapshots, diferencas, classificarNaoGarantia, criarRunner, igual, git, SHA_BASE, ROOT_ATUAL } from "./_comparar-isolamento";

const { check, titulo, fim } = criarRunner();
const src = (f: string) => readFileSync(path.join(ROOT_ATUAL, f), "utf8").replace(/\r\n/g, "\n");

const NAO_PERMITIDOS = ["sier", "outro", "__nenhum__"] as const; // __nenhum__ = sem tenant resolvido (cabeçalho ausente)
const rotuloT = (t: string) => (t === "__nenhum__" ? "sem tenant" : t);

async function main() {
  const snaps = await obterSnapshots(["sier", "outro", "__nenhum__", "garantia", "silveira"]);
  const A = snaps.atual;
  const B = snaps.base;

  titulo("A · função central — tenant ausente / desconhecido / quase-igual são recusados");
  const TC = await import("../../lib/tenant-constants");
  const maus: Array<string | null | undefined> = ["sier", "outro", "", null, undefined, "Garantia", "GARANTIA", " garantia", "garantia ", "SILVEIRA", "silveira ", "__legacy__", "grupo-silveira"];
  check(maus.every((v) => !TC.catalogoManutencaoAtiva(v)), `A1: catalogoManutencaoAtiva recusa ${maus.length} valores (sier, outro, vazio, null, undefined, maiúsculas, espaços, legacy)`);
  check(maus.every((v) => !TC.gruposLaboratoriaisAtivos(v)) && !TC.gruposLaboratoriaisAtivos("silveira"), "A2: gruposLaboratoriaisAtivos recusa os mesmos valores e a silveira");
  check(TC.catalogoManutencaoAtiva("silveira") && TC.catalogoManutencaoAtiva("garantia") && TC.gruposLaboratoriaisAtivos("garantia"), "A3: controlo positivo: silveira/garantia ativas, grupos só garantia");
  check(igual([...TC.TENANTS_CATALOGO_MANUTENCAO].sort(), ["garantia", "silveira"]), "A4: lista central de manutenção = exactamente [garantia, silveira]");

  titulo("B · manutenção do catálogo recusada (página, server actions, menu)");
  for (const t of NAO_PERMITIDOS) {
    const s = A[t];
    check(s.gates.manutencaoCatalogo.ativo === false && B[t].gates.manutencaoCatalogo.ativo === false, `B1[${rotuloT(t)}]: gate da manutenção INATIVO (base e actual)`);
    check(s.pagina.resultado === "notFound", `B2[${rotuloT(t)}]: página /catalogo/manutencao -> notFound (404) real`);
    check(s.menu.visivel === false, `B3[${rotuloT(t)}]: item «Manutenção do catálogo» AUSENTE do menu`);
    check(s.permissoes.matriz.ADMINISTRADOR["catalog.write"] === true, `B4[${rotuloT(t)}]: ADMINISTRADOR tem catalog.write (a recusa é do tenant, não do perfil)`);
    const n = s.acoes.exportadas.length;
    const todas = ["ADMINISTRADOR", "GESTOR_GRUPO", "GESTOR_FARMACIA", "OPERADOR", "sem-sessao", "ADMINISTRADOR-de-outro-tenant"].every((cen) =>
      s.acoes.exportadas.every((acao: string) => {
        const r = s.acoes.resultados[cen][acao];
        return r && r.ok === false && /não disponível/.test(r.error ?? "");
      }),
    );
    check(n === 9 && todas, `B5[${rotuloT(t)}]: as ${n} server actions recusam («não disponível para este tenant») com ADMINISTRADOR, GESTOR_GRUPO, GESTOR_FARMACIA, OPERADOR, sem sessão e sessão de outro tenant`);
    check(s.acoes.baseInalterada === true, `B6[${rotuloT(t)}]: nenhuma acção alterou a base`);
    check(igual(s.acoes.resultados, B[t].acoes.resultados), `B7[${rotuloT(t)}]: resultado das acções idêntico ao base (já recusava)`);
    check(igual(s.acoes.exportadas, B[t].acoes.exportadas), `B8[${rotuloT(t)}]: nenhuma acção nova exportada vs base`);
  }
  // Controlo positivo: a garantia aceita ADMINISTRADOR; a silveira também.
  for (const t of ["garantia", "silveira"]) {
    check(A[t].acoes.resultados.ADMINISTRADOR.listarProdutosManutencaoMassaAction.ok === true && A[t].pagina.resultado === "renderizada" && A[t].menu.visivel === true, `B9[${t}]: CONTROLO POSITIVO: ADMINISTRADOR lista produtos, página renderiza, menu visível`);
  }

  titulo("C · sessão de outro tenant recusada (getSession real) mesmo num tenant permitido");
  for (const t of ["garantia", "silveira"]) {
    const r = A[t].acoes.resultados["ADMINISTRADOR-de-outro-tenant"];
    check(Object.values<any>(r).every((x) => x.ok === false && /Sem permiss/.test(x.error)), `C1[${t}]: JWT válido de ADMINISTRADOR emitido para OUTRO tenant -> TODAS as acções recusadas («Sem permissão»)`);
  }
  const auth = src("lib/auth.ts");
  check(/session\.tenant !== currentTenant/.test(auth) && /return null/.test(auth.slice(auth.indexOf("session.tenant !== currentTenant"))), "C2: getSession devolve null quando session.tenant != tenant do pedido (código)");
  const acoes = src("app/catalogo/manutencao/actions.ts");
  const guarda = acoes.slice(acoes.indexOf("async function guardaBase"), acoes.indexOf("type Prisma_"));
  check(guarda.indexOf("catalogoManutencaoAtiva") > 0 && guarda.indexOf("catalogoManutencaoAtiva") < guarda.indexOf("getSession()") && guarda.indexOf("getSession()") < guarda.indexOf("getPrisma()"), "C3: guarda das actions: tenant ANTES da sessão ANTES da base de dados");
  const pagina = src("app/catalogo/manutencao/page.tsx");
  check(pagina.indexOf("notFound()") > 0 && pagina.indexOf("notFound()") < pagina.indexOf("getPrisma()") && pagina.indexOf("notFound()") < pagina.indexOf("getReportingFilterOptions()"), "C4: a página faz notFound() ANTES de qualquer query");
  const exportadas = acoes.split(/^export async function /m).slice(1);
  check(exportadas.length === 9 && exportadas.every((c) => c.includes("await guardaBase()") || /(previewAction|aplicarAction)\(/.test(c)), "C5: as 9 server actions exportadas passam todas pela guarda (directa ou via previewAction/aplicarAction)");
  check(src("components/layout/app-shell.tsx").includes("soTenantFn: catalogoManutencaoAtiva"), "C6: o menu usa a função central (e é só apresentação — a recusa real é C3/C4)");

  titulo("D · agrupamento de fabricantes NÃO ativo fora do Garantia");
  for (const t of NAO_PERMITIDOS) {
    const s = A[t];
    const lab = s.catalogo.opcoes.laboratorios;
    check(s.gates.gruposLaboratoriais.ativo === false, `D1[${rotuloT(t)}]: gate dos grupos laboratoriais INATIVO`);
    check(s.filtros.opcoesRelatorio.laboratorios === undefined, `D2[${rotuloT(t)}]: opções dos relatórios SEM \`laboratorios\` (a UI usa a lista de fabricantes de sempre)`);
    check(igual(s.filtros.opcoesRelatorio.fabricantes, ["PFIZER LABORATORIOS", "SOLO LAB", "VIATRIS ALFA", "VIATRIS BETA", "VIATRIS GAMA", "VIATRIS PHARMA LDA"]), `D3[${rotuloT(t)}]: 6 fabricantes soltos; os 3 membros do grupo «Viatris» NÃO são fundidos nem aparece «Viatris»`);
    check(lab.every((o: any) => o.tipo === "fabricante" && !("variantes" in o)) && !JSON.stringify(s.filtros).includes("grupo:"), `D4[${rotuloT(t)}]: Catálogo e relatórios sem opções \`grupo\`, sem \`variantes\`, sem valor \`grupo:\``);
    const r = s.resolucao;
    check(r.idsProdutoPorSelecao.grupo.length === 0 && r.idsProdutoPorSelecao["nome-solto-grupo"].length === 0 && r.idsProdutoPorSelecao["fabricante-v1"].length === 2, `D5[${rotuloT(t)}]: seleccionar \`grupo:\` ou o nome do grupo NÃO resolve produtos (sem expansão por grupo); fabricante resolve só os seus`);
    check(igual(r.cnpsPorSelecao.grupo, []) && igual(r.cnpsPorSelecao["nome-solto-grupo"], []), `D6[${rotuloT(t)}]: resolvedor por CNP idem (grupo -> vazio)`);
    check(igual(r.agrupadoNoCliente, []), `D7[${rotuloT(t)}]: agruparOpcoesLaboratorio sobre as opções do tenant -> lista vazia (nada a agrupar)`);
    for (const cen of ["ADMINISTRADOR", "OPERADOR"]) {
      const a = s.acoesLaboratorio.resultados[cen];
      check(igual(a.grupo, []) && igual(a.nomeSoltoGrupo, []) && a.fabricante.length === 2, `D8[${rotuloT(t)}/${cen}]: server action resolverCnpsLaboratoriosAction: grupo -> []; fabricante -> só os seus 2 CNP`);
    }
    check(igual(s.acoesLaboratorio.resultados["sem-sessao"].fabricante, []) && igual(s.acoesLaboratorio.resultados["ADMINISTRADOR-de-outro-tenant"].fabricante, []), `D9[${rotuloT(t)}]: resolverCnpsLaboratoriosAction sem sessão / sessão de outro tenant -> []`);
    check(igual(A[t].catalogo.listagem["grupo:g-viatris"].cnps, B[t].catalogo.listagem["grupo:g-viatris"].cnps), `D10[${rotuloT(t)}]: o where/produtos do Catálogo para \`grupo:\` idêntico ao base (nada novo no Catálogo)`);
  }
  // Controlo positivo: na garantia o agrupamento EXISTE (se este bloco falhar, os D acima não provam nada).
  {
    const g = A.garantia;
    const grupo = (g.filtros.opcoesRelatorio.laboratorios ?? []).find((o: any) => o.tipo === "grupo" && o.nome === "Viatris");
    check(g.gates.gruposLaboratoriais.ativo === true && !!grupo && grupo.variantes.length === 3, "D11: CONTROLO POSITIVO garantia: opção de grupo «Viatris» com 3 variantes");
    check(g.resolucao.agrupadoNoCliente.length > 0 && g.resolucao.agrupadoNoCliente.some((i: any) => i.rotulo === "Viatris (3 variantes)"), "D12: CONTROLO POSITIVO garantia: lista agrupada «Viatris (3 variantes)»");
    check(g.resolucao.idsProdutoPorSelecao.grupo.length === 4 && g.acoesLaboratorio.resultados.ADMINISTRADOR.grupo.length === 4, "D13: CONTROLO POSITIVO garantia: `grupo:` resolve os 4 produtos do grupo");
    check(!B.garantia.filtros.opcoesRelatorio.laboratorios?.some?.((o: any) => o.variantes?.length), "D14: no base a garantia tinha grupos mas SEM variantes (as variantes são novas e só da garantia)");
  }

  titulo("E · prova estrutural — nenhum outro gate de slug espalhado no código alterado");
  const SLUG_LITERAL = /["'`](garantia|silveira|sier)["'`]/;
  const COMPARACAO = /\b(slug|tenant\w*|Slug)\w*\??\s*[!=]==|[!=]==\s*TENANT_|\bTENANT_\w+\s*[!=]==/;
  const diff = git("diff", "-U0", "--no-color", SHA_BASE, "--", "app", "lib", "components", "middleware.ts", ":!*.png", ":!*.pdf");
  const diffHead = git("diff", "-U0", "--no-color", SHA_BASE, "HEAD", "--", "app", "lib", "components", "middleware.ts", ":!*.png", ":!*.pdf");
  type Linha = { ficheiro: string; texto: string };
  const adicionadas = (d: string): Linha[] => {
    const out: Linha[] = [];
    let f = "";
    for (const l of d.split("\n")) {
      if (l.startsWith("+++ b/")) f = l.slice(6);
      else if (l.startsWith("+") && !l.startsWith("+++")) out.push({ ficheiro: f, texto: l.slice(1) });
    }
    return out;
  };
  const codigo = (l: Linha) => {
    const t = l.texto.trim();
    return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("{/*")) ? t.replace(/\s\/\/.*$/, "") : "";
  };
  for (const [rotulo, d] of [["a69cbc5..HEAD", diffHead], ["a69cbc5..disco (HEAD + por commitar)", diff]] as const) {
    const linhas = adicionadas(d).filter((l) => codigo(l));
    const fora = linhas.filter((l) => l.ficheiro !== "lib/tenant-constants.ts");
    const literais = fora.filter((l) => SLUG_LITERAL.test(codigo(l)));
    const comparacoes = fora.filter((l) => COMPARACAO.test(codigo(l)));
    check(literais.length === 0, `E1[${rotulo}]: ${linhas.length} linhas de código adicionadas; 0 literais «garantia»/«silveira»/«sier» fora de lib/tenant-constants.ts`, literais.map((l) => `${l.ficheiro}: ${l.texto.trim()}`).join("\n            "));
    check(comparacoes.length === 0, `E2[${rotulo}]: 0 comparações directas de slug/tenant (=== / !==) ou com TENANT_* fora de lib/tenant-constants.ts`, comparacoes.map((l) => `${l.ficheiro}: ${l.texto.trim()}`).join("\n            "));
  }
  // Os únicos literais de slug introduzidos estão em lib/tenant-constants.ts (a lista central) — listados.
  const emConstantes = adicionadas(diff).filter((l) => l.ficheiro === "lib/tenant-constants.ts" && codigo(l) && (SLUG_LITERAL.test(codigo(l)) || COMPARACAO.test(codigo(l))));
  console.log("  Literais/comparações de slug introduzidos (TODOS em lib/tenant-constants.ts):");
  for (const l of emConstantes) console.log(`    ${l.ficheiro}: ${l.texto.trim()}`);
  check(emConstantes.length === 3 && emConstantes.every((l) => l.ficheiro === "lib/tenant-constants.ts"), `E3: exactamente 3 linhas de gate novas, todas na lista/funções centrais (${emConstantes.length})`);

  // Comparação base × actual do código de produção: o conjunto de gates por slug não cresce (git grep no SHA base e no disco).
  const Q = "[\"'" + String.fromCharCode(96) + "]";
  const grepRe = String.raw`(${Q}(garantia|silveira|sier)${Q})|((slug|tenant)[A-Za-z]*\??\s*[!=]==)|([!=]==\s*TENANT_)|(TENANT_[A-Z_]+\s*[!=]==)`;
  const gerar = (rev: string | null) => {
    let saida = "";
    try {
      saida = git("grep", "-n", "-I", "-E", grepRe, ...(rev ? [rev] : []), "--", "app", "lib", "components", "middleware.ts");
    } catch { saida = ""; }
    const m = new Map<string, number>();
    for (const l0 of saida.split("\n")) {
      const l = l0.replace(/\r$/, ""); // o disco pode ter CRLF (autocrlf); o SHA base é LF
      if (!l.trim()) continue;
      const sem = rev ? l.slice(rev.length + 1) : l; // ficheiro:linha:texto
      const mm = /^([^:]+):\d+:(.*)$/.exec(sem);
      if (!mm) continue;
      const [, ficheiro, texto] = mm;
      const t = texto.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("{/*")) continue;
      if (ficheiro === "lib/tenant-constants.ts") continue;
      const chave = `${ficheiro}: ${t.replace(/\s\/\/.*$/, "")}`;
      m.set(chave, (m.get(chave) ?? 0) + 1);
    }
    return m;
  };
  const gBase = gerar(SHA_BASE);
  const gAtual = gerar(null);
  const novos = [...gAtual].filter(([k, n]) => n > (gBase.get(k) ?? 0)).map(([k]) => k);
  check(novos.length === 0, `E4: código de produção (app, lib, components, middleware) fora de tenant-constants: ${gAtual.size} linhas com literal/comparação de slug no disco vs ${gBase.size} no base; 0 NOVAS`, novos.join("\n            "));
  const removidos = [...gBase].filter(([k, n]) => (gAtual.get(k) ?? 0) < n).map(([k]) => k);
  console.log(`  (comparações pré-existentes removidas pela entrega, a trocar pela função central: ${removidos.length})`);
  for (const r of removidos) console.log(`    - ${r}`);
  // Os usos pré-existentes que ficam são os da ingestão (inalterada) — listados para auditoria.
  const ficam = [...gAtual].map(([k]) => k);
  console.log(`  Usos que permanecem no disco (todos pré-existentes): ${ficam.length}`);
  for (const k of ficam) console.log(`    · ${k}`);

  // Nenhuma server action nova sem passar pela guarda de tenant/sessão: as novas ficheiros "use server" da entrega.
  const novosFicheiros = [
    ...git("diff", "--name-only", "--diff-filter=A", SHA_BASE, "--", "app", "lib").split("\n"),
    ...git("ls-files", "--others", "--exclude-standard", "--", "app", "lib").split("\n"),
  ];
  const novasAcoes = novosFicheiros.filter((f) => /\.tsx?$/.test(f)).filter((f) => /^\s*["']use server["']/.test(src(f)));
  console.log(`  Ficheiros 'use server' NOVOS no HEAD+disco: ${novasAcoes.join(", ") || "(nenhum)"}`);
  check(novasAcoes.every((f) => f === "lib/reporting/laboratorio-actions.ts"), "E5: única server action nova = resolverCnpsLaboratoriosAction (leitura, reports.read, resolver tenant-aware); nenhuma de escrita", novasAcoes.join(", "));
  const lab = src("lib/reporting/laboratorio-actions.ts");
  check(/can\(session, "reports\.read"\)/.test(lab) && !/prisma\.\w+\.(create|update|delete|upsert)/.test(lab) && !/\$executeRaw/.test(lab), "E6: essa acção só lê (sem escrita) e exige sessão + reports.read");

  titulo("F · o resto do Sier/outro tenant igual ao base");
  for (const t of NAO_PERMITIDOS) {
    const ds = diferencas(B[t], A[t]);
    const inesp = ds.filter((d) => !classificarNaoGarantia(d).esperada);
    check(inesp.length === 0, `F1[${rotuloT(t)}]: 0 diferenças inesperadas vs base (${ds.length} diferenças, todas declaradas: ponto 6 forma, refactor de gate, módulos novos inertes)`, inesp.map((d) => `${d.caminho}: ${JSON.stringify(d.base)} -> ${JSON.stringify(d.atual)}`).join("\n            "));
    check(igual(B[t].gates.manutencaoCatalogo.ativo, A[t].gates.manutencaoCatalogo.ativo) && igual(B[t].gates.gruposLaboratoriais.ativo, A[t].gates.gruposLaboratoriais.ativo) && igual(B[t].menu.visivel, A[t].menu.visivel) && igual(B[t].pagina, A[t].pagina), `F2[${rotuloT(t)}]: gates, menu e página: booleanos/resultados iguais ao base`);
    check(igual(B[t].ingestao, A[t].ingestao) && igual(B[t].permissoes, A[t].permissoes), `F3[${rotuloT(t)}]: ingestão e permissões idênticas ao base`);
  }
  fim();
}

main().catch((e) => { console.error(e); process.exit(1); });
