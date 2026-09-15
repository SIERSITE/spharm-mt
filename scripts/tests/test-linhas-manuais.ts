/**
 * scripts/tests/test-linhas-manuais.ts
 *
 * Fase 3 — a linha manual sobrevive ao recálculo, e ganha-lhe.
 *
 * ── O que isto existe para impedir ───────────────────────────────────
 *
 * «Gerar nova proposta» fazia `setLinhas(novas)`. Tudo o que o
 * utilizador tinha acrescentado à mão desaparecia — e a linha manual é,
 * por construção, a que ele mais pensou: foi escolhida uma a uma,
 * contra a recomendação do cálculo.
 *
 * Havia um `confirm()` a avisar. Avisar de uma perda não é o mesmo que
 * não a causar, e um aviso que aparece sempre é um aviso que se lê sem
 * ler.
 *
 * Corre com:  npm run test:linhas-manuais
 */
import { readFileSync } from "node:fs";
import {
  ehOrigemLinha,
  fundirComProposta,
  ORIGENS_LINHA,
  rotuloOrigem,
  sobreviveARecalculo,
  type LinhaFundivel,
  type OrigemLinha,
} from "../../lib/encomendas/origem-linha";

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) {
    ok++;
    console.log(`  [OK]    ${label}`);
  } else {
    ko++;
    console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`);
  }
};
const eq = (a: unknown, b: unknown, label: string) =>
  check(
    JSON.stringify(a) === JSON.stringify(b),
    label,
    `esperado ${JSON.stringify(b)}, obtido ${JSON.stringify(a)}`,
  );

const src = (p: string) => readFileSync(p, "utf8");

/** Uma linha de teste com quantidade, para provar que ela não muda. */
type L = LinhaFundivel & { qtd: number };
const l = (produtoId: string, origem: OrigemLinha, qtd: number, farmaciaId: string | null = null): L => ({
  produtoId,
  origem,
  qtd,
  farmaciaId,
});

// ═════════════════════════════════════════════════════════════════════
// A. Quem sobrevive a um recálculo
// ═════════════════════════════════════════════════════════════════════
console.log("\nA. Só a PROPOSTA é descartável\n");

check(sobreviveARecalculo("MANUAL"), "MANUAL sobrevive");
check(sobreviveARecalculo("SUGESTAO"), "SUGESTAO sobrevive");
check(!sobreviveARecalculo("PROPOSTA"), "PROPOSTA não sobrevive — é o que se vai recalcular");

eq(ORIGENS_LINHA.length, 3, "há três origens");
check(ORIGENS_LINHA.every(ehOrigemLinha), "todas passam a validação");
check(!ehOrigemLinha("proposal"), "o nome antigo do cliente NÃO é uma origem válida");
check(!ehOrigemLinha(""), "vazio não é origem");
check(!ehOrigemLinha(null), "null não é origem");

eq(rotuloOrigem("MANUAL"), "manual", "a linha manual leva badge");
eq(rotuloOrigem("SUGESTAO"), "sugestão", "a de sugestão também");
eq(rotuloOrigem("PROPOSTA"), null, "a proposta NÃO leva badge — marcar tudo é não marcar nada");

// ═════════════════════════════════════════════════════════════════════
// B. Recalcular preserva o manual
// ═════════════════════════════════════════════════════════════════════
console.log("\nB. Recalcular não apaga o que foi decidido à mão\n");

{
  const existentes = [
    l("p1", "PROPOSTA", 10),
    l("p2", "MANUAL", 5),
    l("p3", "PROPOSTA", 7),
    l("p4", "SUGESTAO", 3),
  ];
  const nova = [l("p1", "PROPOSTA", 99), l("p5", "PROPOSTA", 20)];

  const r = fundirComProposta(existentes, nova);

  eq(r.linhas.map((x) => x.produtoId), ["p2", "p4", "p1", "p5"], "manual e sugestão ficam; as propostas velhas saem");
  eq(r.preservadas, 2, "duas linhas preservadas");
  eq(r.propostasIgnoradas, 0, "nenhuma proposta ignorada — não colidiram");
  check(!r.linhas.some((x) => x.produtoId === "p3"), "a proposta antiga que a nova não traz DESAPARECE");
  eq(r.linhas.find((x) => x.produtoId === "p1")!.qtd, 99, "a proposta recalculada traz o valor NOVO");
}
{
  // Recalcular sem nada manual: comportamento antigo, intacto.
  const r = fundirComProposta([l("p1", "PROPOSTA", 1)], [l("p2", "PROPOSTA", 2)]);
  eq(r.linhas.map((x) => x.produtoId), ["p2"], "sem linhas manuais, o recálculo substitui tudo");
  eq(r.preservadas, 0, "nada preservado");
}
{
  // Uma proposta vazia não apaga o manual.
  const r = fundirComProposta([l("p1", "MANUAL", 4)], []);
  eq(r.linhas.map((x) => x.produtoId), ["p1"], "proposta vazia deixa o manual em paz");
  eq(r.linhas[0].qtd, 4, "…com a quantidade intacta");
}
{
  // Recalcular DUAS vezes seguidas não acumula nem perde.
  const inicial = [l("p1", "MANUAL", 5), l("p2", "PROPOSTA", 1)];
  const r1 = fundirComProposta(inicial, [l("p2", "PROPOSTA", 2), l("p3", "PROPOSTA", 3)]);
  const r2 = fundirComProposta(r1.linhas, [l("p2", "PROPOSTA", 9)]);
  eq(r2.linhas.map((x) => x.produtoId), ["p1", "p2"], "dois recálculos seguidos: o manual persiste");
  eq(r2.linhas.find((x) => x.produtoId === "p1")!.qtd, 5, "…e a quantidade nunca foi tocada");
}

// ═════════════════════════════════════════════════════════════════════
// C. Precedência: a linha manual GANHA
// ═════════════════════════════════════════════════════════════════════
console.log("\nC. Quando colidem, o manual ganha\n");

{
  const existentes = [l("p1", "MANUAL", 5)];
  // O cálculo propõe 200 para o MESMO produto.
  const nova = [l("p1", "PROPOSTA", 200)];
  const r = fundirComProposta(existentes, nova);

  eq(r.linhas.length, 1, "fica UMA linha, não duas");
  eq(r.linhas[0].origem, "MANUAL", "…e é a manual");
  eq(r.linhas[0].qtd, 5, "a quantidade é a do utilizador, não a do cálculo");
  eq(r.propostasIgnoradas, 1, "e a proposta ignorada é CONTADA, para a UI o dizer");
}
{
  // A soma seria a alternativa tentadora, e está errada: 5 + 200 = 205
  // não é uma quantidade que alguém tenha decidido.
  const r = fundirComProposta([l("p1", "MANUAL", 5)], [l("p1", "PROPOSTA", 200)]);
  check(r.linhas[0].qtd !== 205, "as quantidades NÃO se somam");
}
{
  const r = fundirComProposta([l("p1", "SUGESTAO", 2)], [l("p1", "PROPOSTA", 50)]);
  eq(r.linhas[0].origem, "SUGESTAO", "a sugestão também ganha à proposta");
  eq(r.linhas[0].qtd, 2, "…com a sua quantidade");
}

// ═════════════════════════════════════════════════════════════════════
// D. Sem duplicados, nunca
// ═════════════════════════════════════════════════════════════════════
console.log("\nD. Nenhum produtoId aparece duas vezes\n");

{
  const existentes = [l("p1", "MANUAL", 1), l("p2", "SUGESTAO", 1)];
  const nova = [l("p1", "PROPOSTA", 1), l("p2", "PROPOSTA", 1), l("p3", "PROPOSTA", 1)];
  const r = fundirComProposta(existentes, nova);
  const ids = r.linhas.map((x) => x.produtoId);
  eq(new Set(ids).size, ids.length, "sem repetições");
  eq(ids, ["p1", "p2", "p3"], "e são exactamente os três produtos distintos");
  eq(r.propostasIgnoradas, 2, "duas propostas ignoradas");
}
{
  // Uma proposta com o mesmo produto duas vezes não deveria acontecer,
  // mas se acontecer a gravação falharia contra
  // `@@unique([listaEncomendaId, produtoId])` e o utilizador via um erro
  // de base de dados em vez de uma tabela.
  const r = fundirComProposta([], [l("p1", "PROPOSTA", 1), l("p1", "PROPOSTA", 2)]);
  eq(r.linhas.length, 1, "uma proposta com o produto repetido dá UMA linha");
  eq(r.linhas[0].qtd, 1, "a primeira vence");
  eq(r.propostasIgnoradas, 1, "a segunda é contada como ignorada");
}
{
  const r = fundirComProposta([], []);
  eq(r, { linhas: [], preservadas: 0, propostasIgnoradas: 0 }, "tudo vazio não rebenta");
}

// ═════════════════════════════════════════════════════════════════════
// E. Ordem: o que se acabou de decidir aparece primeiro
// ═════════════════════════════════════════════════════════════════════
console.log("\nE. As preservadas ficam no topo\n");

{
  const nova = Array.from({ length: 50 }, (_, i) => l(`n${i}`, "PROPOSTA", i));
  const r = fundirComProposta([l("meu", "MANUAL", 1)], nova);
  eq(r.linhas[0].produtoId, "meu", "o artigo posto à mão não se perde no meio de 50 gerados");
  eq(r.linhas.length, 51, "e as 50 entram todas");
}

// ═════════════════════════════════════════════════════════════════════
// F. Integração com a lista importada
// ═════════════════════════════════════════════════════════════════════
console.log("\nF. Produtos da lista sem vendas convivem com linhas manuais\n");

{
  // Um artigo que a lista trouxe e que não vendeu entra com proposta 0.
  // Pode depois ser acrescentado à mão — e passa a MANUAL, que o faz
  // sobreviver ao recálculo seguinte.
  const semVendas = l("p-sem-vendas", "PROPOSTA", 0);
  const depoisDeAdicionadoAMao: L = { ...semVendas, origem: "MANUAL", qtd: 12 };

  const r = fundirComProposta([depoisDeAdicionadoAMao], [l("p-sem-vendas", "PROPOSTA", 0)]);
  eq(r.linhas.length, 1, "não duplica com a linha da lista");
  eq(r.linhas[0].qtd, 12, "a quantidade que o utilizador escreveu fica");
  eq(r.linhas[0].origem, "MANUAL", "e a origem passou a manual");
}

// ═════════════════════════════════════════════════════════════════════
// G. Onde isto está ligado
// ═════════════════════════════════════════════════════════════════════
console.log("\nG. As pontas estão ligadas\n");

{
  const schema = src("prisma/schema.prisma");
  check(/enum OrigemLinhaEncomenda \{/.test(schema), "o enum existe no schema");
  check(
    /origem\s+OrigemLinhaEncomenda @default\(PROPOSTA\)/.test(schema),
    "…e a coluna tem default PROPOSTA — nenhuma linha histórica muda de significado",
  );
}
{
  const mig = src("prisma/migrations/20260914120000_origem_linha_encomenda/migration.sql");
  check(mig.includes("CREATE TYPE \"OrigemLinhaEncomenda\""), "a migration cria o tipo");
  check(mig.includes("DEFAULT 'PROPOSTA'"), "…e a coluna com default");
  check(!/UPDATE |DELETE |DROP /i.test(mig), "a migration NÃO reescreve nem apaga nada");
}
{
  const cli = src("components/encomendas/order-create-client.tsx");
  check(cli.includes("fundirComProposta"), "o cliente funde em vez de substituir");
  check(!/setLinhas\(lines\)/.test(cli), "…e o `setLinhas(lines)` destrutivo desapareceu");
  check(!/l\.source/.test(cli), "o campo local `source` deu lugar a `origem`");
  check(/origem: l\.origem,/.test(cli), "a origem viaja na gravação");
}
{
  const det = src("app/encomendas/[id]/actions.ts");
  check(/origem: "MANUAL"/.test(det), "a linha manual do detalhe nasce MANUAL");
  check(
    det.includes("já está na encomenda"),
    "…e o duplicado é recusado com mensagem, não com erro de BD",
  );
  const detUi = src("components/encomendas/order-detail-client.tsx");
  check(detUi.includes("rotuloOrigem"), "a encomenda reaberta mostra a origem");
  const detalhe = src("lib/encomendas/order-detail.ts");
  check(/origem: l\.origem,/.test(detalhe), "…porque o loader a devolve");
}
{
  const orders = src("lib/ingest/orders.ts");
  check(/origem: l\.origem \?\? "PROPOSTA"/.test(orders), "a gravação assume PROPOSTA por omissão");
}

// ═════════════════════════════════════════════════════════════════════
// H. Modo grupo — o MESMO produtoId em DUAS farmácias não é duplicado
// ═════════════════════════════════════════════════════════════════════
//
// Regressão (2026-09): `fundirComProposta` chaveava só por `produtoId`,
// tal como `mapaDecisoes`/`fundirDecisoesGrupo` chaveavam antes da
// correção em `decisao-grupo.ts` (ver secção equivalente em
// scripts/tests/test-encomenda-grupo-decisao-linha.ts). Numa proposta
// de grupo com duas farmácias a precisar do MESMO produto, a segunda
// entrava em `novaProposta` com o mesmo `produtoId` da primeira e era
// descartada como "duplicado" — a UI consolidada por CNP acabava a
// mostrar "1 farmácia" quando havia duas. A chave tem de ser
// produtoId+farmaciaId, exactamente como em decisao-grupo.ts.
console.log("\nH. Duas farmácias com o mesmo produto NÃO se pisam\n");

{
  // O cenário exacto do relatório: "Segurado" e "Silveirense" precisam
  // do mesmo CNP na mesma proposta de grupo.
  const nova = [
    l("p1", "PROPOSTA", 10, "farm-segurado"),
    l("p1", "PROPOSTA", 25, "farm-silveirense"),
  ];
  const r = fundirComProposta([], nova);

  eq(r.linhas.length, 2, "as DUAS farmácias sobrevivem — não é duplicado");
  eq(r.propostasIgnoradas, 0, "nenhuma foi descartada por engano");
  const porFarmacia = new Map(r.linhas.map((x) => [x.farmaciaId, x.qtd]));
  eq(porFarmacia.get("farm-segurado"), 10, "…cada farmácia mantém a SUA quantidade");
  eq(porFarmacia.get("farm-silveirense"), 25, "…sem uma sobrescrever a outra");
}
{
  // Uma das duas farmácias tem uma linha MANUAL para o mesmo produto —
  // só essa farmácia deve ganhar à proposta; a outra farmácia recebe a
  // proposta normalmente, porque a chave é produtoId+farmaciaId, não só
  // produtoId.
  const existentes = [l("p1", "MANUAL", 999, "farm-segurado")];
  const nova = [
    l("p1", "PROPOSTA", 10, "farm-segurado"), // ignorada: o manual desta farmácia ganha
    l("p1", "PROPOSTA", 25, "farm-silveirense"), // entra: farmácia diferente, sem colisão
  ];
  const r = fundirComProposta(existentes, nova);

  eq(r.linhas.length, 2, "duas linhas: a manual + a proposta da outra farmácia");
  eq(r.propostasIgnoradas, 1, "só UMA proposta foi ignorada — a da farmácia com manual");
  const porFarmacia = new Map(r.linhas.map((x) => [x.farmaciaId, { qtd: x.qtd, origem: x.origem }]));
  eq(porFarmacia.get("farm-segurado"), { qtd: 999, origem: "MANUAL" }, "Segurado mantém o manual");
  eq(
    porFarmacia.get("farm-silveirense"),
    { qtd: 25, origem: "PROPOSTA" },
    "Silveirense recebe a proposta — não herda o manual de Segurado",
  );
}
{
  // Recalcular duas vezes seguidas, com as duas farmácias, não acumula
  // nem funde as duas num par só.
  const inicial = [l("p1", "PROPOSTA", 1, "fA"), l("p1", "PROPOSTA", 2, "fB")];
  const r1 = fundirComProposta([], inicial);
  const r2 = fundirComProposta(r1.linhas, [l("p1", "PROPOSTA", 9, "fA"), l("p1", "PROPOSTA", 8, "fB")]);
  eq(r2.linhas.length, 2, "continuam duas linhas após um segundo recálculo");
  const porFarmacia = new Map(r2.linhas.map((x) => [x.farmaciaId, x.qtd]));
  eq(porFarmacia.get("fA"), 9, "fA actualizada para o novo valor");
  eq(porFarmacia.get("fB"), 8, "fB actualizada para o seu próprio novo valor, não o de fA");
}
{
  const cli = src("components/encomendas/order-create-client.tsx");
  check(
    cli.includes("agruparPorProduto"),
    "a UI consolida por produto — e depende de fundirComProposta preservar as duas farmácias antes disso",
  );
}

// ═════════════════════════════════════════════════════════════════════
console.log(`\n${ko === 0 ? "PASSOU" : "FALHOU"} — ${ok} OK, ${ko} falhas\n`);
process.exit(ko === 0 ? 0 : 1);
