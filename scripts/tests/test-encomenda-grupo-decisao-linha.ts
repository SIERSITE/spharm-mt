/**
 * scripts/tests/test-encomenda-grupo-decisao-linha.ts
 *
 * Bloco D — encomenda de grupo com decisão por linha
 * (ENCOMENDAR / TRANSFERIR / NÃO FAZER).
 *
 *   A  sugestão inicial a partir do `estado` do motor
 *   B  o resumo por balde — conta certo, e nunca inventa uma linha
 *   C  quantidade 0 não é accionável — cai em "não fazer"
 *   D  preservação de `acao` ao regenerar (equivalente a `origem-linha.ts`)
 *   E  `agruparParaGeracao` nunca devolve um balde vazio
 *   F  origem === destino não é uma transferência
 *   G  as pontas estão ligadas (schema, migration, cliente, acção)
 *
 * Corre com:  npm run test:encomenda-grupo-decisao-linha
 */
import { readFileSync } from "node:fs";
import {
  ACOES_LINHA_GRUPO,
  agruparParaGeracao,
  calcularResumoGrupo,
  chaveDirecao,
  ehAcaoLinhaGrupo,
  fundirDecisoesGrupo,
  mapaDecisoes,
  parseDirecao,
  sugerirDecisao,
  type DecisaoLinha,
  type LinhaComDecisao,
} from "../../lib/encomendas/decisao-grupo";
import type { ExcessoInfo } from "../../lib/encomendas/proposal";

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

/** Uma decisão completa, com omissões preenchidas por omissão. */
function decisao(partial: Partial<DecisaoLinha> & { produtoId: string }): DecisaoLinha {
  return {
    acao: "NAO_FAZER",
    acaoTocada: false,
    farmaciaEncomendaId: null,
    quantidadeFinal: 0,
    farmaciaOrigemId: null,
    farmaciaDestinoId: null,
    quantidadeTransferir: 0,
    ...partial,
  };
}

/** Uma "linha do ecrã" mínima, para os testes de `fundirDecisoesGrupo`. */
function linhaCliente(partial: Partial<LinhaComDecisao> & { produtoId: string }): LinhaComDecisao {
  return {
    acao: "NAO_FAZER",
    acaoTocada: false,
    farmaciaEncomendaId: null,
    farmaciaOrigemId: null,
    farmaciaDestinoId: null,
    finalQty: "0",
    ...partial,
  };
}

function excesso(farmaciaId: string, farmaciaNome = farmaciaId): ExcessoInfo {
  return { farmaciaId, farmaciaNome, disponivelUnidades: 999 };
}

// ═════════════════════════════════════════════════════════════════════
// A · Sugestão inicial a partir do estado do motor
// ═════════════════════════════════════════════════════════════════════
console.log("\nA · sugerirDecisao deriva a decisão do estado calculado\n");

eq(ACOES_LINHA_GRUPO.length, 3, "há três acções possíveis");
check(ACOES_LINHA_GRUPO.every(ehAcaoLinhaGrupo), "todas passam a validação");
check(!ehAcaoLinhaGrupo("encomendar"), "minúsculas não são válidas — os nomes são os do enum");
check(!ehAcaoLinhaGrupo(""), "vazio não é acção");
check(!ehAcaoLinhaGrupo(null), "null não é acção");

{
  const d = sugerirDecisao({
    farmaciaId: "farmA",
    estado: "COMPRAR",
    suggestedQty: 12,
    transferirQty: 0,
    excessoFonte: [],
  });
  eq(d.acao, "ENCOMENDAR", "COMPRAR ⇒ sugere ENCOMENDAR");
  eq(d.farmaciaEncomendaId, "farmA", "…nesta farmácia");
  eq(d.quantidadeFinal, 12, "…com a quantidade sugerida");
  eq(d.acaoTocada, false, "…e a sugestão nasce por tocar");
}
{
  const d = sugerirDecisao({
    farmaciaId: "farmB",
    estado: "TRANSFERÊNCIA",
    suggestedQty: 0,
    transferirQty: 8,
    excessoFonte: [excesso("farmA", "Alfa"), excesso("farmC", "Gama")],
  });
  eq(d.acao, "TRANSFERIR", "TRANSFERÊNCIA ⇒ sugere TRANSFERIR");
  eq(d.farmaciaOrigemId, "farmA", "…a PRIMEIRA farmácia de excesso é a origem");
  eq(d.farmaciaDestinoId, "farmB", "…e esta farmácia (a que precisa) é o destino");
  eq(d.quantidadeTransferir, 8, "…com a quantidade a transferir");
}
{
  // Transferência parcial: suggestedQty > 0 E transferirQty > 0 na mesma
  // linha (ver `generateGroupProposal`, ramo COMPRAR com excesso
  // parcial). A sugestão simplifica para ENCOMENDAR — só TRANSFERÊNCIA
  // sugere TRANSFERIR.
  const d = sugerirDecisao({
    farmaciaId: "farmB",
    estado: "COMPRAR",
    suggestedQty: 5,
    transferirQty: 3,
    excessoFonte: [excesso("farmA")],
  });
  eq(d.acao, "ENCOMENDAR", "COMPRAR com transferência parcial ainda sugere ENCOMENDAR (simplificação deliberada)");
}
{
  const dAguardar = sugerirDecisao({
    farmaciaId: "f1", estado: "AGUARDAR", suggestedQty: 0, transferirQty: 0, excessoFonte: [],
  });
  const dAdequado = sugerirDecisao({
    farmaciaId: "f1", estado: "ADEQUADO", suggestedQty: 0, transferirQty: 0, excessoFonte: [],
  });
  eq(dAguardar.acao, "NAO_FAZER", "AGUARDAR ⇒ NÃO FAZER");
  eq(dAdequado.acao, "NAO_FAZER", "ADEQUADO ⇒ NÃO FAZER");
}
{
  // Dado inconsistente: TRANSFERÊNCIA sem nenhuma excessoFonte. Não
  // deveria acontecer (o motor só marca TRANSFERÊNCIA com excesso
  // encontrado), mas não pode produzir TRANSFERIR sem origem.
  const d = sugerirDecisao({
    farmaciaId: "f1", estado: "TRANSFERÊNCIA", suggestedQty: 0, transferirQty: 5, excessoFonte: [],
  });
  eq(d.acao, "NAO_FAZER", "TRANSFERÊNCIA sem excessoFonte não produz TRANSFERIR");
  eq(d.farmaciaOrigemId, null, "…nem inventa uma origem");
}

// ═════════════════════════════════════════════════════════════════════
// B · O resumo por balde
// ═════════════════════════════════════════════════════════════════════
console.log("\nB · calcularResumoGrupo conta por farmácia e por direcção\n");

{
  const decisoes = [
    decisao({ produtoId: "p1", acao: "ENCOMENDAR", farmaciaEncomendaId: "A", quantidadeFinal: 10 }),
    decisao({ produtoId: "p2", acao: "ENCOMENDAR", farmaciaEncomendaId: "A", quantidadeFinal: 4 }),
    decisao({ produtoId: "p3", acao: "ENCOMENDAR", farmaciaEncomendaId: "B", quantidadeFinal: 6 }),
    decisao({ produtoId: "p4", acao: "TRANSFERIR", farmaciaOrigemId: "A", farmaciaDestinoId: "B", quantidadeTransferir: 3 }),
    decisao({ produtoId: "p5", acao: "TRANSFERIR", farmaciaOrigemId: "A", farmaciaDestinoId: "B", quantidadeTransferir: 7 }),
    decisao({ produtoId: "p6", acao: "TRANSFERIR", farmaciaOrigemId: "B", farmaciaDestinoId: "A", quantidadeTransferir: 2 }),
    decisao({ produtoId: "p7", acao: "NAO_FAZER" }),
  ];
  const resumo = calcularResumoGrupo(decisoes);

  eq(resumo.total, 7, "total = todas as linhas, incluindo NÃO FAZER");
  eq(resumo.naoFazer, 1, "uma linha não fazer");
  eq(
    resumo.encomendas.sort((a, b) => a.farmaciaId.localeCompare(b.farmaciaId)),
    [{ farmaciaId: "A", nLinhas: 2 }, { farmaciaId: "B", nLinhas: 1 }],
    "Encomenda A: 2 linhas · Encomenda B: 1 linha",
  );
  eq(
    resumo.transferencias.sort((a, b) => a.origemId.localeCompare(b.origemId)),
    [{ origemId: "A", destinoId: "B", nLinhas: 2 }, { origemId: "B", destinoId: "A", nLinhas: 1 }],
    "A→B: 2 linhas · B→A: 1 linha — as duas direcções contam-se À PARTE",
  );
}
{
  // Vazio não rebenta.
  const resumo = calcularResumoGrupo([]);
  eq(resumo, { encomendas: [], transferencias: [], naoFazer: 0, total: 0 }, "sem decisões, resumo vazio");
}
{
  eq(chaveDirecao("X", "Y"), "X>Y", "chaveDirecao é estável e legível");
  eq(parseDirecao("X>Y"), { origemId: "X", destinoId: "Y" }, "parseDirecao inverte chaveDirecao");
}

// ═════════════════════════════════════════════════════════════════════
// C · Quantidade 0 (ou farmácia em falta) não é accionável
// ═════════════════════════════════════════════════════════════════════
console.log("\nC · quantidade 0 cai em \"não fazer\", mesmo com acção nominal diferente\n");

{
  const decisoes = [
    decisao({ produtoId: "p1", acao: "ENCOMENDAR", farmaciaEncomendaId: "A", quantidadeFinal: 0 }),
    decisao({ produtoId: "p2", acao: "TRANSFERIR", farmaciaOrigemId: "A", farmaciaDestinoId: "B", quantidadeTransferir: 0 }),
    decisao({ produtoId: "p3", acao: "ENCOMENDAR", farmaciaEncomendaId: null, quantidadeFinal: 10 }),
    decisao({ produtoId: "p4", acao: "TRANSFERIR", farmaciaOrigemId: "A", farmaciaDestinoId: null, quantidadeTransferir: 10 }),
  ];
  const resumo = calcularResumoGrupo(decisoes);
  eq(resumo.encomendas, [], "sem farmácia OU sem quantidade: nenhum balde de encomenda");
  eq(resumo.transferencias, [], "sem farmácia OU sem quantidade: nenhum balde de transferência");
  eq(resumo.naoFazer, 4, "as quatro caem em não fazer");

  const { porFarmacia, porDirecao } = agruparParaGeracao(decisoes);
  eq(porFarmacia.size, 0, "agruparParaGeracao: nenhuma farmácia");
  eq(porDirecao.size, 0, "agruparParaGeracao: nenhuma direcção");
}

// ═════════════════════════════════════════════════════════════════════
// D · Preservação de `acao` ao regenerar — equivalente a `origem-linha.ts`
// ═════════════════════════════════════════════════════════════════════
console.log("\nD · a decisão tocada à mão sobrevive a um recálculo\n");

{
  // O utilizador mudou p1 de ENCOMENDAR (sugestão) para TRANSFERIR à
  // mão. A proposta é recalculada: p1 continua a existir (nova
  // sugestão: ENCOMENDAR outra vez, com outra farmácia/quantidade), mas
  // a decisão do utilizador tem de vencer.
  const antigas = [
    linhaCliente({ produtoId: "p1", acao: "TRANSFERIR", acaoTocada: true, farmaciaOrigemId: "A", farmaciaDestinoId: "B", finalQty: "9" }),
    linhaCliente({ produtoId: "p2", acao: "ENCOMENDAR", acaoTocada: false, farmaciaEncomendaId: "A", finalQty: "5" }),
  ];
  const novasSugeridas = [
    linhaCliente({ produtoId: "p1", acao: "ENCOMENDAR", acaoTocada: false, farmaciaEncomendaId: "B", finalQty: "20" }),
    linhaCliente({ produtoId: "p2", acao: "ENCOMENDAR", acaoTocada: false, farmaciaEncomendaId: "A", finalQty: "6" }),
    linhaCliente({ produtoId: "p3", acao: "NAO_FAZER", acaoTocada: false, finalQty: "0" }),
  ];

  const resultado = fundirDecisoesGrupo(novasSugeridas, mapaDecisoes(antigas));

  const p1 = resultado.find((l) => l.produtoId === "p1")!;
  eq(p1.acao, "TRANSFERIR", "p1: a decisão TOCADA (TRANSFERIR) vence a nova sugestão (ENCOMENDAR)");
  eq(p1.farmaciaOrigemId, "A", "…com a origem que o utilizador escolheu");
  eq(p1.farmaciaDestinoId, "B", "…e o destino");
  eq(p1.finalQty, "9", "…e a quantidade que ele escreveu, não a nova sugestão (20)");

  const p2 = resultado.find((l) => l.produtoId === "p2")!;
  eq(p2.acao, "ENCOMENDAR", "p2: nunca tocada — livre para a nova sugestão");
  eq(p2.finalQty, "6", "…inclui a quantidade recalculada (6), não a antiga (5)");

  const p3 = resultado.find((l) => l.produtoId === "p3")!;
  eq(p3.acao, "NAO_FAZER", "p3: produto novo na proposta — fica com a sua própria sugestão");
}
{
  // Duas vezes seguidas: a decisão tocada não se perde nem se acumula.
  const inicial = [linhaCliente({ produtoId: "p1", acao: "TRANSFERIR", acaoTocada: true, farmaciaOrigemId: "X", farmaciaDestinoId: "Y", finalQty: "3" })];
  const r1 = fundirDecisoesGrupo(
    [linhaCliente({ produtoId: "p1", acao: "ENCOMENDAR", acaoTocada: false, farmaciaEncomendaId: "Y", finalQty: "40" })],
    mapaDecisoes(inicial),
  );
  const r2 = fundirDecisoesGrupo(
    [linhaCliente({ produtoId: "p1", acao: "ENCOMENDAR", acaoTocada: false, farmaciaEncomendaId: "Y", finalQty: "41" })],
    mapaDecisoes(r1),
  );
  eq(r2[0].acao, "TRANSFERIR", "dois recálculos seguidos: a decisão tocada persiste");
  eq(r2[0].finalQty, "3", "…com a quantidade original, nunca tocada pelo recálculo");
}
{
  // Sem nenhuma decisão tocada, o comportamento é "livre": a nova
  // sugestão passa sempre, exactamente como se não houvesse merge.
  const antigas = [linhaCliente({ produtoId: "p1", acao: "ENCOMENDAR", acaoTocada: false, farmaciaEncomendaId: "A", finalQty: "1" })];
  const novas = [linhaCliente({ produtoId: "p1", acao: "NAO_FAZER", acaoTocada: false, finalQty: "0" })];
  const resultado = fundirDecisoesGrupo(novas, mapaDecisoes(antigas));
  eq(resultado[0].acao, "NAO_FAZER", "sem toque, a nova sugestão substitui livremente a anterior");
}
{
  // Um produto que nunca existiu antes (sem entrada no mapa) não rebenta.
  const resultado = fundirDecisoesGrupo(
    [linhaCliente({ produtoId: "novo", acao: "ENCOMENDAR", acaoTocada: false, farmaciaEncomendaId: "A", finalQty: "1" })],
    new Map(),
  );
  eq(resultado[0].acao, "ENCOMENDAR", "produto sem histórico: fica como veio");
}

// ═════════════════════════════════════════════════════════════════════
// E · `agruparParaGeracao` nunca devolve um balde vazio
// ═════════════════════════════════════════════════════════════════════
console.log("\nE · nunca um documento vazio\n");

{
  // Só linhas NÃO FAZER: nenhuma farmácia, nenhuma direcção.
  const decisoes = [
    decisao({ produtoId: "p1", acao: "NAO_FAZER" }),
    decisao({ produtoId: "p2", acao: "NAO_FAZER" }),
  ];
  const { porFarmacia, porDirecao } = agruparParaGeracao(decisoes);
  eq(porFarmacia.size, 0, "nenhuma ListaEncomenda seria criada");
  eq(porDirecao.size, 0, "nenhuma Transferencia seria criada");
}
{
  // Uma única farmácia com ENCOMENDAR: só ESSA aparece, mais nenhuma.
  const decisoes = [
    decisao({ produtoId: "p1", acao: "ENCOMENDAR", farmaciaEncomendaId: "A", quantidadeFinal: 5 }),
    decisao({ produtoId: "p2", acao: "NAO_FAZER" }),
  ];
  const { porFarmacia, porDirecao } = agruparParaGeracao(decisoes);
  eq([...porFarmacia.keys()], ["A"], "só a farmácia A tem balde");
  eq(porDirecao.size, 0, "nenhuma transferência");
  eq(porFarmacia.get("A")!.length, 1, "…com a sua única linha");
}
{
  // Mistura realista: 2 farmácias ENCOMENDAM, 2 direcções TRANSFEREM.
  const decisoes = [
    decisao({ produtoId: "p1", acao: "ENCOMENDAR", farmaciaEncomendaId: "A", quantidadeFinal: 5 }),
    decisao({ produtoId: "p2", acao: "ENCOMENDAR", farmaciaEncomendaId: "B", quantidadeFinal: 2 }),
    decisao({ produtoId: "p3", acao: "TRANSFERIR", farmaciaOrigemId: "A", farmaciaDestinoId: "B", quantidadeTransferir: 4 }),
    decisao({ produtoId: "p4", acao: "TRANSFERIR", farmaciaOrigemId: "B", farmaciaDestinoId: "A", quantidadeTransferir: 1 }),
  ];
  const { porFarmacia, porDirecao } = agruparParaGeracao(decisoes);
  eq(porFarmacia.size, 2, "2 ListaEncomenda — uma por farmácia com ENCOMENDAR");
  eq(porDirecao.size, 2, "2 Transferencia — uma por direcção com TRANSFERIR");
  check(
    [...porFarmacia.values()].every((ls) => ls.length > 0) &&
      [...porDirecao.values()].every((ls) => ls.length > 0),
    "nenhum balde do Map está vazio — a garantia estrutural contra documento vazio",
  );
}

// ═════════════════════════════════════════════════════════════════════
// F · Origem === destino nunca é uma transferência
// ═════════════════════════════════════════════════════════════════════
console.log("\nF · a mesma farmácia como origem e destino não gera transferência\n");
{
  const decisoes = [
    decisao({ produtoId: "p1", acao: "TRANSFERIR", farmaciaOrigemId: "A", farmaciaDestinoId: "A", quantidadeTransferir: 10 }),
  ];
  eq(calcularResumoGrupo(decisoes).transferencias, [], "resumo: nenhuma direcção A→A");
  eq(agruparParaGeracao(decisoes).porDirecao.size, 0, "geração: nenhum balde A→A");
}

// ═════════════════════════════════════════════════════════════════════
// G · As pontas estão ligadas
// ═════════════════════════════════════════════════════════════════════
console.log("\nG · schema, migration, cliente e acção usam o mesmo mecanismo\n");

{
  const schema = src("prisma/schema.prisma");
  check(/model Transferencia \{/.test(schema), "o modelo Transferencia existe no schema");
  check(/model LinhaTransferencia \{/.test(schema), "…e LinhaTransferencia");
  check(/enum EstadoTransferencia \{/.test(schema), "…e o enum de estado");
  check(
    /farmaciaOrigem\s+Farmacia\s+@relation\("TransferenciaOrigem"/.test(schema),
    "duas FK para Farmacia são distinguidas por @relation nomeada (origem)",
  );
  check(
    /farmaciaDestino\s+Farmacia\s+@relation\("TransferenciaDestino"/.test(schema),
    "…e destino",
  );
  check(
    /@@unique\(\[transferenciaId, produtoId\]\)/.test(schema),
    "LinhaTransferencia tem a mesma unicidade por produto que LinhaEncomenda",
  );
}
{
  const mig = src("prisma/migrations/20260915100000_transferencia_interna/migration.sql");
  check(mig.includes('CREATE TYPE "EstadoTransferencia"'), "a migration cria o enum");
  check(mig.includes('CREATE TABLE "Transferencia"'), "…e a tabela Transferencia");
  check(mig.includes('CREATE TABLE "LinhaTransferencia"'), "…e LinhaTransferencia");
  check(
    // `UPDATE "..."` seria uma reescrita de dados — distinto de "ON
    // UPDATE CASCADE", que é a cláusula normal de uma FK e não apaga
    // nem reescreve nada.
    !/\bUPDATE\s+"|DELETE FROM |DROP TABLE|DROP COLUMN/i.test(mig),
    "a migration é só aditiva — não reescreve nem apaga nada existente",
  );
}
{
  const acoes = src("app/encomendas/nova/actions.ts");
  check(acoes.includes("export async function gerarPlanoGrupoAction"), "a server action existe");
  check(
    acoes.includes("createEncomendaWithOutbox(prisma, tenantSlug,"),
    "as ListaEncomenda nascem pelo caminho único já existente",
  );
  check(
    acoes.includes("agruparParaGeracao(input.decisoes)"),
    "a acção usa o mesmo agrupamento testado acima, não uma cópia",
  );
  check(
    acoes.includes('session.perfil !== "ADMINISTRADOR" && session.perfil !== "GESTOR_GRUPO"'),
    "a mesma gate de perfil de `generateProposalAction` — sem porta nova",
  );
  check(
    !/prisma\.listaEncomenda\.create/.test(acoes),
    "nenhuma criação directa de ListaEncomenda fora de createEncomendaWithOutbox",
  );
  check(
    acoes.includes("tx.transferencia.create"),
    "a Transferencia é criada dentro da sua própria transacção",
  );
  check(
    !acoes.includes("OrderOutbox") || !/tx\.transferencia\.create[\s\S]{0,400}orderOutbox/.test(acoes),
    "nenhum OrderOutbox é criado a partir de uma Transferencia — sem exportação ao ERP",
  );
}
{
  const cliente = src("components/encomendas/order-create-client.tsx");
  check(
    cliente.includes('function buildProposalLine(r: ProposalRow, modoAtual: ProposalMode)'),
    "buildProposalLine recebe o modo explicitamente — não por fecho (o prefill de Vendas muda o modo antes do 1º render)",
  );
  check(
    /modoAtual === "grupo"[\s\S]{0,300}: r\.estado === "TRANSFERÊNCIA"\s*\n?\s*\?\s*0\s*\n?\s*:\s*r\.suggestedQty/.test(cliente),
    "fora do modo grupo, TRANSFERÊNCIA continua a nascer com Final=0 — comportamento de sempre, intacto em farmacia/consolidação",
  );
  check(cliente.includes("fundirDecisoesGrupo"), "o cliente funde a decisão em vez de a perder");
  check(cliente.includes("sugerirDecisao"), "…e pré-preenche a partir da sugestão do motor");
  check(cliente.includes("gerarPlanoGrupoAction"), "…e chama a nova acção para gerar");
  check(
    !cliente.includes("handleCriarTransferencia") && !cliente.includes("createInternalTransferAction"),
    "o botão antigo \"Criar transferência\" (que navegava para fora do ecrã) foi substituído pela decisão inline",
  );
  check(
    cliente.includes('import { CreateInternalTransferButton }') === false,
    "order-create-client não importa o botão partilhado — não era dele que se falava",
  );
}
{
  // O botão partilhado, usado por Transferências/Oportunidades/Dashboard,
  // continua intocado — Bloco D não mexeu nesse módulo.
  const botao = src("components/transferencias/create-internal-transfer-button.tsx");
  check(
    botao.includes("createInternalTransferAction"),
    "CreateInternalTransferButton continua a usar createInternalTransferAction — não foi tocado",
  );
}

// ═════════════════════════════════════════════════════════════════════
console.log(`\n${ko === 0 ? "PASSOU" : "FALHOU"} — ${ok} OK, ${ko} falhas\n`);
process.exit(ko === 0 ? 0 : 1);
