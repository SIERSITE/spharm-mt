/**
 * scripts/tests/test-fabricante-normalizacao-batch.ts
 *
 * Lógica pura de lib/catalog-fabricante-normalizacao-batch.ts — sem BD
 * viva (secção I usa um Prisma falso, mesma convenção de
 * test-fabricante-merge.ts). Prova as regras do plano
 * (scripts/data/plano-execucao-normalizacao-garantia.json):
 * ids inexistentes/inactivos são ignorados e reportados, source_id
 * repetido entre grupos só conta uma vez, self-merge é ignorado,
 * do_not_merge nunca vira merge, canonical_name renomeia o canónico
 * preservando o nome anterior como alias (secção G) DENTRO da mesma
 * transacção que os merges do grupo (secção I), e o parsing de CLI
 * aceita só --tenant=garantia.
 *
 * Corre com: npx tsx scripts/tests/test-fabricante-normalizacao-batch.ts
 */
import {
  combinarGrupos,
  executarNormalizacaoBatch,
  planearNormalizacaoBatch,
  type FabricanteDb,
  type GrupoNormalizacao,
  type PlanoNormalizacaoArquivo,
} from "../../lib/catalog-fabricante-normalizacao-batch";
import type { ProdutoDoLoser } from "../../lib/catalog-fabricante-merge";
import type { PrismaClient } from "../../generated/prisma/client";
import { parseArgs } from "../normalizar-fabricantes-garantia";

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
const eq = <T,>(a: T, b: T, label: string) =>
  check(JSON.stringify(a) === JSON.stringify(b), label, `esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);

function fab(id: string, nome: string, estado: "ATIVO" | "INATIVO" = "ATIVO", aliases: string[] = []): FabricanteDb {
  return { id, nomeNormalizado: nome, estado, aliases };
}

// ══════════════════════════════════════════════════════════════════════
// A · combinarGrupos — junta as duas secções do plano, rotuladas
// ══════════════════════════════════════════════════════════════════════
console.log("\nA · combinarGrupos");
{
  const plano: PlanoNormalizacaoArquivo = {
    tenant: "garantia",
    verified_business_changes: [{ canonical_id: "c1", source_ids: ["s1"] }],
    orthographic_merges: [{ canonical_id: "c2", source_ids: ["s2"] }],
    do_not_merge: [],
  };
  const grupos = combinarGrupos(plano);
  eq(grupos.length, 2, "A1: um de cada secção");
  eq(grupos[0].kind, "verified", "A2: o primeiro é verified");
  eq(grupos[1].kind, "orthographic", "A3: o segundo é orthographic");
}

// ══════════════════════════════════════════════════════════════════════
// B · planearNormalizacaoBatch — caso feliz
// ══════════════════════════════════════════════════════════════════════
console.log("\nB · planearNormalizacaoBatch — caso feliz");
{
  const grupos: GrupoNormalizacao[] = [
    { kind: "verified", canonical_id: "canon1", source_ids: ["loser1", "loser2"] },
  ];
  const fabricantesPorId = new Map<string, FabricanteDb>([
    ["canon1", fab("canon1", "ALFASIGMA PORTUGAL LDA")],
    ["loser1", fab("loser1", "ALFA WASSERMANN LDA")],
    ["loser2", fab("loser2", "BIOSAUDE LDA")],
  ]);
  const produtosPorFabricanteId = new Map<string, ProdutoDoLoser[]>([
    ["loser1", [{ id: "p1", validadoManualmente: false }]],
    ["loser2", [{ id: "p2", validadoManualmente: false }, { id: "p3", validadoManualmente: true }]],
  ]);
  const relatorio = planearNormalizacaoBatch({ grupos, fabricantesPorId, produtosPorFabricanteId, doNotMerge: [] });

  eq(relatorio.grupos.length, 1, "B1: um grupo válido");
  eq(relatorio.grupos[0].sources.length, 2, "B2: os dois losers resolvidos");
  eq(relatorio.gruposBloqueados.length, 0, "B3: nenhum grupo bloqueado");
  eq(relatorio.sourcesExcluidos.length, 0, "B4: nenhum source excluído");
  eq(relatorio.totais.produtosAReatribuir, 2, "B5: p1 e p2 reatribuídos (p3 validado à mão fica de fora)");
  eq(relatorio.totais.produtosBloqueadosValidadoManualmente, 1, "B6: p3 bloqueado");
  eq(relatorio.totais.fabricantesOrigemAInativar, 2, "B7: os dois losers vão ficar INATIVO");
}

// ══════════════════════════════════════════════════════════════════════
// C · canonical_id inexistente/inactivo → grupo inteiro bloqueado
// ══════════════════════════════════════════════════════════════════════
console.log("\nC · canonical_id inexistente/inactivo");
{
  const grupos: GrupoNormalizacao[] = [
    { kind: "orthographic", canonical_id: "naoexiste", source_ids: ["s1"] },
    { kind: "orthographic", canonical_id: "canonInativo", source_ids: ["s2"] },
  ];
  const fabricantesPorId = new Map<string, FabricanteDb>([
    ["canonInativo", fab("canonInativo", "X LDA", "INATIVO")],
    ["s1", fab("s1", "Y LDA")],
    ["s2", fab("s2", "Z LDA")],
  ]);
  const relatorio = planearNormalizacaoBatch({
    grupos,
    fabricantesPorId,
    produtosPorFabricanteId: new Map(),
    doNotMerge: [],
  });
  eq(relatorio.grupos.length, 0, "C1: nenhum grupo válido");
  eq(relatorio.gruposBloqueados.length, 2, "C2: os dois grupos bloqueados");
  eq(relatorio.gruposBloqueados[0].motivo, "canonical_inexistente", "C3: motivo certo — inexistente");
  eq(relatorio.gruposBloqueados[1].motivo, "canonical_inativo", "C4: motivo certo — já inactivo");
}

// ══════════════════════════════════════════════════════════════════════
// D · source_id inexistente/inactivo/self-merge → ignorado e reportado
// ══════════════════════════════════════════════════════════════════════
console.log("\nD · source_id inexistente/inactivo/self-merge");
{
  const grupos: GrupoNormalizacao[] = [
    { kind: "orthographic", canonical_id: "c1", source_ids: ["naoexiste", "jaInativo", "c1", "valido"] },
  ];
  const fabricantesPorId = new Map<string, FabricanteDb>([
    ["c1", fab("c1", "CANONICO LDA")],
    ["jaInativo", fab("jaInativo", "ANTIGO LDA", "INATIVO")],
    ["valido", fab("valido", "VALIDO LDA")],
  ]);
  const relatorio = planearNormalizacaoBatch({
    grupos,
    fabricantesPorId,
    produtosPorFabricanteId: new Map(),
    doNotMerge: [],
  });
  eq(relatorio.grupos.length, 1, "D1: o grupo sobrevive (tem 1 source válido)");
  eq(relatorio.grupos[0].sources.map((s) => s.sourceId), ["valido"], "D2: só o válido entra no plano");
  eq(relatorio.sourcesExcluidos.length, 3, "D3: os outros 3 são reportados");
  const motivos = relatorio.sourcesExcluidos.map((s) => s.motivo).sort();
  eq(motivos, ["id_inexistente", "ja_inativo", "self_merge"], "D4: motivos correctos, um de cada");
}

// ══════════════════════════════════════════════════════════════════════
// E · source_id repetido entre grupos → só o primeiro grupo fica com ele
// ══════════════════════════════════════════════════════════════════════
console.log("\nE · source_id duplicado entre grupos");
{
  const grupos: GrupoNormalizacao[] = [
    { kind: "orthographic", canonical_id: "c1", source_ids: ["dup"] },
    { kind: "orthographic", canonical_id: "c2", source_ids: ["dup"] },
  ];
  const fabricantesPorId = new Map<string, FabricanteDb>([
    ["c1", fab("c1", "C1 LDA")],
    ["c2", fab("c2", "C2 LDA")],
    ["dup", fab("dup", "DUP LDA")],
  ]);
  const relatorio = planearNormalizacaoBatch({
    grupos,
    fabricantesPorId,
    produtosPorFabricanteId: new Map(),
    doNotMerge: [],
  });
  eq(relatorio.grupos.length, 1, "E1: só o primeiro grupo fica válido (o segundo fica sem sources)");
  eq(relatorio.grupos[0].canonicalId, "c1", "E2: o primeiro grupo é o que ganha o source");
  eq(relatorio.sourcesExcluidos.length, 1, "E3: o segundo é reportado como duplicado");
  eq(relatorio.sourcesExcluidos[0].motivo, "duplicado_noutro_grupo", "E4: motivo correcto");
}

// ══════════════════════════════════════════════════════════════════════
// F · do_not_merge — nunca vira merge, mesmo que o plano peça
// ══════════════════════════════════════════════════════════════════════
console.log("\nF · do_not_merge");
{
  const grupos: GrupoNormalizacao[] = [
    { kind: "orthographic", canonical_id: "viatris", source_ids: ["mylan", "outro"] },
  ];
  const fabricantesPorId = new Map<string, FabricanteDb>([
    ["viatris", fab("viatris", "VIATRIS")],
    ["mylan", fab("mylan", "MYLAN")],
    ["outro", fab("outro", "OUTRO LDA")],
  ]);
  const relatorio = planearNormalizacaoBatch({
    grupos,
    fabricantesPorId,
    produtosPorFabricanteId: new Map(),
    doNotMerge: [{ names: ["MYLAN", "UPJOHN EESV", "VIATRIS"], reason: "grupo, entidades distintas" }],
  });
  eq(relatorio.grupos.length, 1, "F1: o grupo sobrevive (tem 1 source não-coberto)");
  eq(relatorio.grupos[0].sources.map((s) => s.sourceId), ["outro"], "F2: só 'outro' é reatribuído, nunca MYLAN→VIATRIS");
  const excluidoDoNotMerge = relatorio.sourcesExcluidos.find((s) => s.sourceId === "mylan");
  check(!!excluidoDoNotMerge, "F3: MYLAN aparece excluído");
  eq(excluidoDoNotMerge?.motivo, "do_not_merge", "F4: motivo é do_not_merge");
}
{
  // Duas denominações do MESMO do_not_merge, mas nomes normalizados diferentes
  // do que está sendo unificado — não deve bloquear merges não relacionados.
  const grupos: GrupoNormalizacao[] = [
    { kind: "orthographic", canonical_id: "c1", source_ids: ["s1"] },
  ];
  const fabricantesPorId = new Map<string, FabricanteDb>([
    ["c1", fab("c1", "BAYER PORTUGAL LDA")],
    ["s1", fab("s1", "BAYER LDA")],
  ]);
  const relatorio = planearNormalizacaoBatch({
    grupos,
    fabricantesPorId,
    produtosPorFabricanteId: new Map(),
    doNotMerge: [{ names: ["MYLAN", "VIATRIS"], reason: "x" }],
  });
  eq(relatorio.grupos.length, 1, "F5: merge não relacionado com do_not_merge continua a passar");
  eq(relatorio.sourcesExcluidos.length, 0, "F6: nenhuma exclusão");
}

// ══════════════════════════════════════════════════════════════════════
// G · canonical_name — renomeação do próprio canónico, com alias preservado
// ══════════════════════════════════════════════════════════════════════
console.log("\nG · canonical_name (renomeação do canónico)");
{
  // O caso concreto do pedido: Takeda/Haleon têm sources válidos E uma
  // renomeação — as duas coisas acontecem no mesmo grupo.
  const grupos: GrupoNormalizacao[] = [
    {
      kind: "verified",
      canonical_id: "takeda",
      canonical_name: "TAKEDA - FARMACEUTICOS PORTUGAL LDA",
      source_ids: ["nycomed"],
    },
  ];
  const fabricantesPorId = new Map<string, FabricanteDb>([
    ["takeda", fab("takeda", "TAKEDA - FARMACEUTICOS PORTUGAL")],
    ["nycomed", fab("nycomed", "NYCOMED PORTUGAL LDA")],
  ]);
  const relatorio = planearNormalizacaoBatch({
    grupos,
    fabricantesPorId,
    produtosPorFabricanteId: new Map(),
    doNotMerge: [],
  });
  eq(relatorio.renomeacoesBloqueadas.length, 0, "G1: nenhuma renomeação bloqueada");
  eq(relatorio.grupos.length, 1, "G2: o grupo sobrevive");
  eq(relatorio.grupos[0].renomeacao?.nomeAntes, "TAKEDA - FARMACEUTICOS PORTUGAL", "G3: canonicalNameBefore correcto");
  eq(relatorio.grupos[0].renomeacao?.nomeDepois, "TAKEDA - FARMACEUTICOS PORTUGAL LDA", "G4: canonicalNameAfter correcto");
  eq(relatorio.grupos[0].renomeacao?.aliasACriar, "TAKEDA - FARMACEUTICOS PORTUGAL", "G5: a denominação anterior vira o alias a criar");
  eq(relatorio.grupos[0].renomeacao?.aliasJaExistente, false, "G6: ainda não existia como alias");
  eq(relatorio.grupos[0].sources.map((s) => s.sourceId), ["nycomed"], "G7: o merge do grupo continua a acontecer normalmente");
  eq(relatorio.totais.canonicaisRenomeados, 1, "G8: total de renomeações");
  eq(relatorio.totais.aliasesCriadosPorRenomeacao, 1, "G9: total de aliases criados por renomeação");
}
{
  // Sem canonical_name: nenhuma renomeação, comportamento inalterado.
  const grupos: GrupoNormalizacao[] = [{ kind: "orthographic", canonical_id: "c1", source_ids: ["s1"] }];
  const fabricantesPorId = new Map<string, FabricanteDb>([
    ["c1", fab("c1", "X LDA")],
    ["s1", fab("s1", "Y LDA")],
  ]);
  const relatorio = planearNormalizacaoBatch({ grupos, fabricantesPorId, produtosPorFabricanteId: new Map(), doNotMerge: [] });
  check(!relatorio.grupos[0].renomeacao, "G10: sem canonical_name no plano, sem renomeação");
}
{
  // canonical_name igual ao nome já na base: no-op, não gera renomeação nem escreve nada.
  const grupos: GrupoNormalizacao[] = [
    { kind: "verified", canonical_id: "c1", canonical_name: "HALEON PORTUGAL", source_ids: [] },
  ];
  const fabricantesPorId = new Map<string, FabricanteDb>([["c1", fab("c1", "HALEON PORTUGAL")]]);
  const relatorio = planearNormalizacaoBatch({ grupos, fabricantesPorId, produtosPorFabricanteId: new Map(), doNotMerge: [] });
  eq(relatorio.grupos.length, 0, "G11: nome pedido == nome actual → grupo nem entra no relatório (nada a fazer)");
  eq(relatorio.totais.canonicaisRenomeados, 0, "G12: nenhuma renomeação contada");
}
{
  // Colisão: o nome pedido já é o nomeNormalizado de OUTRO Fabricante —
  // a renomeação é recusada, mas os merges do grupo continuam.
  const grupos: GrupoNormalizacao[] = [
    { kind: "verified", canonical_id: "c1", canonical_name: "JA EXISTE LDA", source_ids: ["s1"] },
  ];
  const fabricantesPorId = new Map<string, FabricanteDb>([
    ["c1", fab("c1", "NOME ANTIGO LDA")],
    ["outro", fab("outro", "JA EXISTE LDA")],
    ["s1", fab("s1", "S1 LDA")],
  ]);
  const relatorio = planearNormalizacaoBatch({ grupos, fabricantesPorId, produtosPorFabricanteId: new Map(), doNotMerge: [] });
  eq(relatorio.renomeacoesBloqueadas.length, 1, "G13: a renomeação é bloqueada por colisão");
  eq(relatorio.renomeacoesBloqueadas[0].motivo, "colisao_nome", "G14: motivo correcto");
  check(!relatorio.grupos[0]?.renomeacao, "G15: o grupo resolvido não carrega renomeação nenhuma");
  eq(relatorio.grupos[0]?.sources.map((s) => s.sourceId), ["s1"], "G16: mas o merge do grupo continua a acontecer");
}
{
  // A denominação anterior já existia como alias do próprio canónico —
  // não duplica, só assinala aliasJaExistente.
  const grupos: GrupoNormalizacao[] = [
    { kind: "verified", canonical_id: "c1", canonical_name: "NOVO NOME LDA", source_ids: [] },
  ];
  const fabricantesPorId = new Map<string, FabricanteDb>([
    ["c1", fab("c1", "NOME ANTIGO LDA", "ATIVO", ["NOME ANTIGO LDA"])],
  ]);
  const relatorio = planearNormalizacaoBatch({ grupos, fabricantesPorId, produtosPorFabricanteId: new Map(), doNotMerge: [] });
  eq(relatorio.grupos[0].renomeacao?.aliasJaExistente, true, "G17: aliasJaExistente=true");
  eq(relatorio.grupos[0].renomeacao?.aliasACriar, null, "G18: nada a criar — já lá estava");
  eq(relatorio.totais.aliasesCriadosPorRenomeacao, 0, "G19: não conta como alias novo");
}

// ══════════════════════════════════════════════════════════════════════
// H · parseArgs (scripts/normalizar-fabricantes-garantia.ts)
// ══════════════════════════════════════════════════════════════════════
console.log("\nH · parseArgs do CLI de normalização");
{
  const args = parseArgs(["--tenant=garantia", "--source=x"]);
  eq(args.apply, false, "H1: default é dry-run");
  eq(args.incluirValidadosManualmente, false, "H2: default não inclui validados manualmente");
  check(args.planoPath.endsWith("plano-execucao-normalizacao-garantia.json"), "H3: plano por omissão aponta para o ficheiro certo", args.planoPath);
}
{
  const args = parseArgs(["--tenant=garantia", "--source=x", "--apply", "--plano=outro.json", "--incluir-validados-manualmente"]);
  eq(args.apply, true, "H4: --apply liga o modo de escrita");
  eq(args.planoPath, "outro.json", "H5: --plano= sobrepõe o default");
  eq(args.incluirValidadosManualmente, true, "H6: --incluir-validados-manualmente liga a flag");
}
{
  check(
    (() => { try { parseArgs(["--tenant=garantia"]); return false; } catch { return true; } })(),
    "H7: falta --source é erro fatal",
  );
  check(
    (() => { try { parseArgs(["--tenant=garantia", "--source=x", "--desconhecido"]); return false; } catch { return true; } })(),
    "H8: argumento desconhecido é erro fatal",
  );
}

// ══════════════════════════════════════════════════════════════════════
// I · executarNormalizacaoBatch — renomeação dentro da MESMA transacção,
//     alias criado ANTES do rename, conforme pedido explicitamente
// ══════════════════════════════════════════════════════════════════════
async function principal() {
  console.log("\nI · executarNormalizacaoBatch — renomeação + merges, Prisma falso");

  const chamadas: string[] = [];
  const fake = {
    produto: {
      updateMany: async (args: { where: { id: { in: string[] } }; data: { fabricanteId: string } }) => {
        chamadas.push(`produto.updateMany(${JSON.stringify(args.where.id.in)} → ${args.data.fabricanteId})`);
        return { count: args.where.id.in.length };
      },
    },
    fabricanteAlias: {
      upsert: async (args: { where: { fabricanteId_aliasNome: { fabricanteId: string; aliasNome: string } } }) => {
        chamadas.push(`fabricanteAlias.upsert(${args.where.fabricanteId_aliasNome.fabricanteId}, "${args.where.fabricanteId_aliasNome.aliasNome}")`);
        return {};
      },
      deleteMany: async (args: { where: { fabricanteId: string } }) => {
        chamadas.push(`fabricanteAlias.deleteMany(${args.where.fabricanteId})`);
        return { count: 0 };
      },
    },
    fabricante: {
      update: async (args: { where: { id: string }; data: { estado?: string; nomeNormalizado?: string } }) => {
        chamadas.push(
          `fabricante.update(${args.where.id} → ${args.data.nomeNormalizado ? `nomeNormalizado=${args.data.nomeNormalizado}` : `estado=${args.data.estado}`})`,
        );
        return {};
      },
    },
    enrichmentSourceLog: {
      createMany: async (args: { data: unknown[] }) => {
        chamadas.push(`enrichmentSourceLog.createMany(${args.data.length})`);
        return { count: args.data.length };
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<void>) => fn(fake),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const grupos: GrupoNormalizacao[] = [
    { kind: "verified", canonical_id: "takeda", canonical_name: "TAKEDA - FARMACEUTICOS PORTUGAL LDA", source_ids: ["nycomed"] },
  ];
  const fabricantesPorId = new Map<string, FabricanteDb>([
    ["takeda", fab("takeda", "TAKEDA - FARMACEUTICOS PORTUGAL")],
    ["nycomed", fab("nycomed", "NYCOMED PORTUGAL LDA")],
  ]);
  const produtosPorFabricanteId = new Map<string, ProdutoDoLoser[]>([["nycomed", [{ id: "p1", validadoManualmente: false }]]]);
  const relatorio = planearNormalizacaoBatch({ grupos, fabricantesPorId, produtosPorFabricanteId, doNotMerge: [] });

  const resultado = await executarNormalizacaoBatch(fake as PrismaClient, { relatorio, source: "teste", dryRun: false });

  eq(resultado.canonicaisRenomeados, 1, "I1: um canónico renomeado");
  eq(resultado.produtosReatribuidos, 1, "I2: o merge continua a acontecer no mesmo grupo");
  check(
    chamadas.includes('fabricanteAlias.upsert(takeda, "TAKEDA - FARMACEUTICOS PORTUGAL")'),
    "I3: a denominação anterior é criada como alias do canónico",
    chamadas.join("\n"),
  );
  check(
    chamadas.includes("fabricante.update(takeda → nomeNormalizado=TAKEDA - FARMACEUTICOS PORTUGAL LDA)"),
    "I4: o canónico é renomeado",
    chamadas.join("\n"),
  );
  const idxAliasAntigo = chamadas.indexOf('fabricanteAlias.upsert(takeda, "TAKEDA - FARMACEUTICOS PORTUGAL")');
  const idxRename = chamadas.indexOf("fabricante.update(takeda → nomeNormalizado=TAKEDA - FARMACEUTICOS PORTUGAL LDA)");
  check(idxAliasAntigo >= 0 && idxRename >= 0 && idxAliasAntigo < idxRename, "I5: o alias é criado ANTES do rename, como pedido");
  check(
    chamadas.includes("fabricante.update(nycomed → estado=INATIVO)"),
    "I6: o loser do merge continua a ficar INATIVO na mesma transacção",
  );

  // dry-run: soma as contagens do relatório, incluindo a renomeação, sem tocar no Prisma falso.
  const resultadoDryRun = await executarNormalizacaoBatch(fake as PrismaClient, { relatorio, source: "teste", dryRun: true });
  eq(resultadoDryRun.canonicaisRenomeados, 1, "I7: dry-run também conta a renomeação");
  eq(resultadoDryRun.aliasesCriados, relatorio.totais.aliasesACriar + relatorio.totais.aliasesCriadosPorRenomeacao, "I8: dry-run soma aliases de merge + de renomeação");

  console.log(`\n${ok} ok, ${ko} falhas`);
  process.exit(ko === 0 ? 0 : 1);
}

principal();
