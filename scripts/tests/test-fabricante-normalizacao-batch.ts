/**
 * scripts/tests/test-fabricante-normalizacao-batch.ts
 *
 * Lógica pura de lib/catalog-fabricante-normalizacao-batch.ts — sem BD
 * viva (secção I usa um Prisma falso, mesma convenção de
 * test-fabricante-merge.ts). Prova as regras do plano
 * (scripts/data/plano-normalizacao-garantia-achatado-checkpoint.json):
 * ids inexistentes/inactivos são ignorados e reportados, source_id
 * repetido entre grupos só conta uma vez, self-merge é ignorado, cadeias
 * source→canonical entre grupos são recusadas (secção F2), do_not_merge
 * nunca vira merge, canonical_name renomeia o canónico preservando o
 * nome anterior como alias (secção G) DENTRO da mesma transacção que os
 * merges do grupo (secção I), um erro a meio da transacção propaga-se em
 * vez de ser engolido — condição necessária para o rollback real do
 * Prisma (secção I3) —, um plano de outro tenant é recusado por
 * carregarPlano (secção H2), e o parsing de CLI aceita só
 * --tenant=garantia.
 *
 * Corre com: npx tsx scripts/tests/test-fabricante-normalizacao-batch.ts
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  combinarGrupos,
  combinarGruposAchatado,
  compararDivergencias,
  ehPlanoAchatado,
  executarNormalizacaoBatch,
  normalizarDoNotMerge,
  planearNormalizacaoBatch,
  type DoNotMergeEntry,
  type FabricanteDb,
  type GrupoNormalizacao,
  type PlanoNormalizacaoArquivo,
  type PlanoNormalizacaoArquivoAchatado,
} from "../../lib/catalog-fabricante-normalizacao-batch";
import type { ProdutoDoLoser } from "../../lib/catalog-fabricante-merge";
import type { PrismaClient } from "../../generated/prisma/client";
import { carregarPlano, parseArgs } from "../normalizar-fabricantes-garantia";

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
// F2 · cadeia source→canonical entre grupos — recusada explicitamente,
//      não apenas ausente por acaso nos dados
// ══════════════════════════════════════════════════════════════════════
console.log("\nF2 · cadeia source→canonical entre grupos");
{
  // grupo 0 pede "a←b" (b seria absorvido por a). grupo 1 pede "b←c" (c
  // seria absorvido por b). Mas "b" é, ao mesmo tempo, source no grupo 0
  // E canonical_id no grupo 1 — se os dois corressem, "b" ficaria INATIVO
  // (grupo 0) e seria simultaneamente o destino de "c" (grupo 1): uma
  // cadeia. "b" enquanto SOURCE é recusado (motivo "cadeia"); o grupo 1
  // continua válido, porque "b" enquanto CANONICAL nunca é tocado por
  // este mecanismo — só a aparição de "b" como source é que é uma cadeia.
  const grupos: GrupoNormalizacao[] = [
    { kind: "orthographic", canonical_id: "a", source_ids: ["b"] },
    { kind: "orthographic", canonical_id: "b", source_ids: ["c"] },
  ];
  const fabricantesPorId = new Map<string, FabricanteDb>([
    ["a", fab("a", "A LDA")],
    ["b", fab("b", "B LDA")],
    ["c", fab("c", "C LDA")],
  ]);
  const relatorio = planearNormalizacaoBatch({
    grupos,
    fabricantesPorId,
    produtosPorFabricanteId: new Map(),
    doNotMerge: [],
  });
  eq(relatorio.grupos.length, 1, "F2.1: só o grupo 1 (b←c) fica válido — o grupo 0 fica sem sources válidos");
  eq(relatorio.grupos[0].canonicalId, "b", "F2.2: o grupo válido é b←c");
  const excluidoCadeia = relatorio.sourcesExcluidos.find((s) => s.sourceId === "b");
  check(!!excluidoCadeia, "F2.3: 'b' aparece excluído (enquanto source do grupo 0)");
  eq(excluidoCadeia?.motivo, "cadeia", "F2.4: motivo é 'cadeia', não outro");
  eq(excluidoCadeia?.groupIndex, 0, "F2.5: reportado no grupo #0 (a←b)");
}
{
  // A ORDEM dos grupos no plano não deve importar: mesmo que o grupo cujo
  // source é uma cadeia venha DEPOIS do grupo que o usa como canonical, a
  // exclusão continua a acontecer — o conjunto de todos os canonical_id é
  // construído com TODOS os grupos antes de qualquer validação, não
  // incrementalmente durante a iteração.
  const grupos: GrupoNormalizacao[] = [
    { kind: "orthographic", canonical_id: "b", source_ids: ["c"] },
    { kind: "orthographic", canonical_id: "a", source_ids: ["b"] },
  ];
  const fabricantesPorId = new Map<string, FabricanteDb>([
    ["a", fab("a", "A LDA")],
    ["b", fab("b", "B LDA")],
    ["c", fab("c", "C LDA")],
  ]);
  const relatorio = planearNormalizacaoBatch({
    grupos,
    fabricantesPorId,
    produtosPorFabricanteId: new Map(),
    doNotMerge: [],
  });
  const excluidoCadeia = relatorio.sourcesExcluidos.find((s) => s.sourceId === "b");
  eq(excluidoCadeia?.motivo, "cadeia", "F2.6: cadeia detectada independentemente da ordem dos grupos no plano");
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
  check(args.planoPath.endsWith("plano-normalizacao-garantia-achatado-checkpoint.json"), "H3: plano por omissão aponta para o checkpoint achatado (o ponto de partida actual)", args.planoPath);
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
// H2 · carregarPlano recusa um ficheiro cujo tenant não é "garantia"
// ══════════════════════════════════════════════════════════════════════
console.log("\nH2 · carregarPlano — tentativa de usar outro tenant");
{
  const dir = mkdtempSync(join(tmpdir(), "plano-outro-tenant-"));
  const path = join(dir, "plano-outro-tenant.json");
  writeFileSync(
    path,
    JSON.stringify({ tenant: "outro-tenant", do_not_merge: [], groups: [] }),
    "utf8",
  );
  let lancou = false;
  let mensagem = "";
  try {
    carregarPlano(path);
  } catch (err) {
    lancou = true;
    mensagem = err instanceof Error ? err.message : String(err);
  }
  check(lancou, "H2.1: um plano com tenant != garantia é recusado com erro, não silenciosamente aceite");
  check(mensagem.includes("outro-tenant") && mensagem.includes("garantia"), "H2.2: a mensagem identifica o tenant errado e o tenant travado", mensagem);
}
{
  // Confirma também o caminho feliz: tenant correcto carrega sem lançar.
  const dir = mkdtempSync(join(tmpdir(), "plano-garantia-"));
  const path = join(dir, "plano-garantia.json");
  writeFileSync(path, JSON.stringify({ tenant: "garantia", do_not_merge: [], groups: [] }), "utf8");
  const plano = carregarPlano(path);
  eq(plano.achatado, true, "H2.3: tenant correcto carrega normalmente (formato achatado detectado)");
}

// ══════════════════════════════════════════════════════════════════════
// J · formato achatado (checkpoint) — combinarGruposAchatado,
//     normalizarDoNotMerge, ehPlanoAchatado
// ══════════════════════════════════════════════════════════════════════
console.log("\nJ · formato achatado (plano-normalizacao-garantia-achatado-checkpoint.json)");
{
  const planoOriginal: PlanoNormalizacaoArquivo = {
    tenant: "garantia",
    verified_business_changes: [],
    orthographic_merges: [],
    do_not_merge: [],
  };
  const planoAchatado: PlanoNormalizacaoArquivoAchatado = {
    tenant: "garantia",
    do_not_merge: [],
    groups: [],
  };
  eq(ehPlanoAchatado(planoOriginal), false, "J1: o formato original NÃO é reconhecido como achatado");
  eq(ehPlanoAchatado(planoAchatado), true, "J2: o formato achatado é reconhecido pela presença de groups[]");
}
{
  // canonical_name_after vira canonical_name; sources[].source_id vira source_ids; origin vira kind.
  const plano: PlanoNormalizacaoArquivoAchatado = {
    tenant: "garantia",
    do_not_merge: [],
    groups: [
      {
        origin: "supplemental_research",
        canonical_id: "c1",
        canonical_name_before: "NOME ANTIGO",
        canonical_name_after: "NOME NOVO LDA",
        canonical_rename_required: true,
        sources: [
          { source_id: "s1", source_name: "S1 LDA", products: 12 },
          { source_id: "s2", source_name: "S2 LDA", products: 0 },
        ],
      },
    ],
  };
  const grupos = combinarGruposAchatado(plano);
  eq(grupos.length, 1, "J3: um grupo traduzido");
  eq(grupos[0].kind, "supplemental_research", "J4: origin vira kind, tal-qual");
  eq(grupos[0].canonical_id, "c1", "J5: canonical_id preservado");
  eq(grupos[0].canonical_name, "NOME NOVO LDA", "J6: canonical_name_after vira canonical_name");
  eq(grupos[0].source_ids, ["s1", "s2"], "J7: sources[].source_id vira source_ids");
}
{
  // combinarGruposAchatado alimenta planearNormalizacaoBatch sem alteração nenhuma na lógica de planeamento.
  const plano: PlanoNormalizacaoArquivoAchatado = {
    tenant: "garantia",
    do_not_merge: [],
    groups: [
      {
        origin: "initial_orthographic",
        canonical_id: "c1",
        canonical_name_before: "X LDA",
        canonical_name_after: "X LDA",
        canonical_rename_required: false,
        sources: [{ source_id: "s1", source_name: "X L DA", products: 3 }],
      },
    ],
  };
  const grupos = combinarGruposAchatado(plano);
  const fabricantesPorId = new Map<string, FabricanteDb>([
    ["c1", fab("c1", "X LDA")],
    ["s1", fab("s1", "X L DA")],
  ]);
  const relatorio = planearNormalizacaoBatch({ grupos, fabricantesPorId, produtosPorFabricanteId: new Map(), doNotMerge: [] });
  eq(relatorio.grupos.length, 1, "J8: o grupo achatado passa pelo planeamento normal");
  check(!relatorio.grupos[0].renomeacao, "J9: canonical_name_after igual ao actual → sem renomeação (mesma regra de sempre)");
}
{
  // normalizarDoNotMerge junta os dois formatos: arrays nus (achatado) e {names,reason} (original).
  const misto: (string[] | DoNotMergeEntry)[] = [
    ["MYLAN", "VIATRIS"],
    { names: ["PENTAFARMA", "TECNIMEDE"], reason: "entidades distintas" },
  ];
  const normalizado = normalizarDoNotMerge(misto);
  eq(normalizado.length, 2, "J10: as duas entradas sobrevivem");
  eq(normalizado[0], { names: ["MYLAN", "VIATRIS"] }, "J11: array nu vira {names} sem reason");
  eq(normalizado[1], { names: ["PENTAFARMA", "TECNIMEDE"], reason: "entidades distintas" }, "J12: {names,reason} original passa tal-qual");
}
{
  // do_not_merge sem reason continua a bloquear — só a mensagem fica genérica.
  const grupos: GrupoNormalizacao[] = [{ kind: "initial_orthographic", canonical_id: "viatris", source_ids: ["mylan"] }];
  const fabricantesPorId = new Map<string, FabricanteDb>([
    ["viatris", fab("viatris", "VIATRIS")],
    ["mylan", fab("mylan", "MYLAN")],
  ]);
  const doNotMerge = normalizarDoNotMerge([["MYLAN", "UPJOHN EESV", "VIATRIS"]]);
  const relatorio = planearNormalizacaoBatch({ grupos, fabricantesPorId, produtosPorFabricanteId: new Map(), doNotMerge });
  eq(relatorio.grupos.length, 0, "J13: MYLAN→VIATRIS continua bloqueado sem reason nenhum");
  eq(relatorio.sourcesExcluidos[0]?.motivo, "do_not_merge", "J14: motivo correcto mesmo sem reason no ficheiro");
  check(!!relatorio.sourcesExcluidos[0]?.detalhe, "J15: a mensagem tem um texto genérico, não undefined/vazio");
}

// ══════════════════════════════════════════════════════════════════════
// L · compararDivergencias — o que o plano DECLAROU vs o que a base REAL diz
// ══════════════════════════════════════════════════════════════════════
console.log("\nL · compararDivergencias");
{
  const planoAchatado: PlanoNormalizacaoArquivoAchatado = {
    tenant: "garantia",
    summary: { groups: 1, source_manufacturers_to_deactivate: 1, canonical_renames_required: 0, products_to_reassign_unique: 5, active_before: 10, active_after_estimated: 9 },
    do_not_merge: [],
    groups: [
      {
        origin: "initial_orthographic",
        canonical_id: "c1",
        canonical_name_before: "C1 LDA",
        canonical_name_after: "C1 LDA",
        canonical_rename_required: false,
        sources: [{ source_id: "s1", source_name: "S1 LDA", products: 5 }],
      },
    ],
  };
  const grupos = combinarGruposAchatado(planoAchatado);
  const fabricantesPorId = new Map<string, FabricanteDb>([
    ["c1", fab("c1", "C1 LDA")],
    ["s1", fab("s1", "S1 LDA")],
  ]);
  // Base real diz 3 produtos, plano dizia 5 — divergência de propósito.
  const produtosPorFabricanteId = new Map<string, ProdutoDoLoser[]>([
    ["s1", [{ id: "p1", validadoManualmente: false }, { id: "p2", validadoManualmente: false }, { id: "p3", validadoManualmente: false }]],
  ]);
  const relatorio = planearNormalizacaoBatch({ grupos, fabricantesPorId, produtosPorFabricanteId, doNotMerge: [] });
  const divergencias = compararDivergencias({ planoAchatado, relatorio, produtosPorFabricanteId, totalFabricantesAtivosAntes: 10 });

  eq(divergencias.produtos.length, 1, "L1: uma divergência de produtos por source");
  eq(divergencias.produtos[0].produtosEsperados, 5, "L2: o esperado vem do plano");
  eq(divergencias.produtos[0].produtosReais, 3, "L3: o real vem da base");

  const porCampo = new Map(divergencias.resumo.map((r) => [r.campo, r]));
  check(porCampo.get("groups")?.bate === true, "L4: groups bate (1 declarado, 1 real)");
  check(porCampo.get("products_to_reassign_unique")?.bate === false, "L5: products_to_reassign_unique (vs base real) NÃO bate (5 declarado, 3 reais)", JSON.stringify(porCampo.get("products_to_reassign_unique")));
  check(porCampo.get("products_to_reassign_unique_vs_soma_por_source_no_plano")?.bate === true, "L5b: mas a soma DECLARADA no plano bate consigo própria (5 == 5) — a divergência é só contra a base");
  check(porCampo.get("active_before")?.bate === true, "L6: active_before bate (10 declarado, 10 real)");
  check(porCampo.get("active_after_estimated")?.bate === true, "L7: active_after_estimated bate (9 declarado, 10-1=9 real)");
}
{
  // Sem summary no plano: compararDivergencias não rebenta, só devolve resumo vazio.
  const planoSemSummary: PlanoNormalizacaoArquivoAchatado = { tenant: "garantia", do_not_merge: [], groups: [] };
  const relatorioVazio = planearNormalizacaoBatch({ grupos: [], fabricantesPorId: new Map(), produtosPorFabricanteId: new Map(), doNotMerge: [] });
  const divergencias = compararDivergencias({ planoAchatado: planoSemSummary, relatorio: relatorioVazio, produtosPorFabricanteId: new Map(), totalFabricantesAtivosAntes: 0 });
  eq(divergencias.resumo, [], "L8: sem summary, resumo fica vazio (nada a comparar)");
  eq(divergencias.produtos, [], "L9: sem grupos, sem divergências de produtos");
}

// ══════════════════════════════════════════════════════════════════════
// M · validação estrutural do CHECKPOINT REAL em disco — não é lógica de
//     lib/, é uma prova de que o ficheiro que vai para a VPS está limpo:
//     sem cadeias, sem sources repetidos, do_not_merge respeitado, e as
//     contagens declaradas em summary batem com o que o ficheiro contém
// ══════════════════════════════════════════════════════════════════════
console.log("\nM · validação estrutural do checkpoint real em disco");
{
  const planoPath = resolve(__dirname, "..", "data", "plano-normalizacao-garantia-achatado-checkpoint.json");
  const plano = JSON.parse(readFileSync(planoPath, "utf8")) as PlanoNormalizacaoArquivoAchatado;

  eq(plano.tenant, "garantia", "M1: tenant é garantia");
  eq(plano.status, "RESEARCH_CONCLUDED_READY_FOR_IMPLEMENTATION_DRY_RUN_DO_NOT_APPLY", "M2: status ainda não autoriza --apply");
  eq(plano.groups.length, plano.summary?.groups, "M3: groups.length bate com summary.groups");

  const sourceOwner = new Map<string, number>();
  const dupSources: string[] = [];
  const selfMerges: string[] = [];
  const canonicalIds = new Set<string>();
  let totalSources = 0;
  let renamesRequired = 0;
  let somaProdutos = 0;
  plano.groups.forEach((g, idx) => {
    canonicalIds.add(g.canonical_id);
    if (g.canonical_rename_required) renamesRequired++;
    for (const s of g.sources) {
      totalSources++;
      somaProdutos += s.products ?? 0;
      if (s.source_id === g.canonical_id) selfMerges.push(s.source_id);
      if (sourceOwner.has(s.source_id)) dupSources.push(s.source_id);
      else sourceOwner.set(s.source_id, idx);
    }
  });
  const chains = [...canonicalIds].filter((cid) => sourceOwner.has(cid));

  eq(dupSources.length, 0, "M4: nenhum source_id repetido entre grupos");
  eq(selfMerges.length, 0, "M5: nenhum self-merge (source_id === canonical_id do próprio grupo)");
  eq(chains.length, 0, "M6: nenhuma cadeia winner→loser→winner (canonical também source noutro grupo)");
  eq(canonicalIds.size, plano.groups.length, "M7: nenhum canonical_id repetido entre grupos");
  eq(totalSources, plano.summary?.source_manufacturers_to_deactivate, "M8: total de sources bate com summary");
  eq(renamesRequired, plano.summary?.canonical_renames_required, "M9: total de renomeações bate com summary");
  eq(somaProdutos, plano.summary?.products_to_reassign_unique, "M10: soma de products por source bate com summary");

  // do_not_merge (arrays de nomes) tem de ser aceite por normalizarDoNotMerge sem rebentar.
  const doNotMerge = normalizarDoNotMerge(plano.do_not_merge);
  check(doNotMerge.length === plano.do_not_merge.length, "M11: normalizarDoNotMerge preserva o número de entradas");
  check(doNotMerge.every((e) => !("reason" in e) || e.reason === undefined), "M12: entradas do checkpoint não têm reason (formato achatado)");

  // O plano inteiro passa pelo planeamento puro sem excepções nem grupos bloqueados —
  // é exactamente o que "checkpoint tecnicamente consistente" quer dizer.
  const grupos = combinarGruposAchatado(plano);
  const fabricantesPorId = new Map<string, FabricanteDb>();
  for (const id of [...canonicalIds, ...sourceOwner.keys()]) fabricantesPorId.set(id, fab(id, `NOME-${id}`));
  // Como os nomes sintéticos acima são todos distintos e iguais ao nome "actual" de cada id,
  // nenhuma renomeação dispara aqui (não é isso que esta secção testa) — o que interessa é
  // que NENHUM grupo fica bloqueado e NENHUM source é excluído por duplicação/self-merge/cadeia.
  const relatorio = planearNormalizacaoBatch({ grupos, fabricantesPorId, produtosPorFabricanteId: new Map(), doNotMerge: [] });
  eq(relatorio.gruposBloqueados.length, 0, "M13: nenhum grupo bloqueado quando todos os IDs existem e estão ATIVO");
  const exclusoesEstruturais = relatorio.sourcesExcluidos.filter((s) => s.motivo === "duplicado_noutro_grupo" || s.motivo === "self_merge");
  eq(exclusoesEstruturais.length, 0, "M14: nenhuma exclusão por duplicação ou self-merge — o ficheiro é mesmo limpo");
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

  // ══════════════════════════════════════════════════════════════════════
  // I2 · dry-run isolado — prova, com um Prisma falso NUNCA antes chamado
  //      neste teste, que dry-run não toca em NENHUM método do Prisma
  // ══════════════════════════════════════════════════════════════════════
  console.log("\nI2 · dry-run isolado — zero chamadas ao Prisma, prova limpa");
  {
    const chamadasIsoladas: string[] = [];
    const fakeIsolado = {
      produto: { updateMany: async () => { chamadasIsoladas.push("produto.updateMany"); return { count: 0 }; } },
      fabricanteAlias: {
        upsert: async () => { chamadasIsoladas.push("fabricanteAlias.upsert"); return {}; },
        deleteMany: async () => { chamadasIsoladas.push("fabricanteAlias.deleteMany"); return { count: 0 }; },
      },
      fabricante: { update: async () => { chamadasIsoladas.push("fabricante.update"); return {}; } },
      enrichmentSourceLog: { createMany: async () => { chamadasIsoladas.push("enrichmentSourceLog.createMany"); return { count: 0 }; } },
      $transaction: async (fn: (tx: unknown) => Promise<void>) => { chamadasIsoladas.push("$transaction"); return fn(fakeIsolado); },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const resultadoIsolado = await executarNormalizacaoBatch(fakeIsolado as PrismaClient, { relatorio, source: "teste", dryRun: true });
    eq(resultadoIsolado.canonicaisRenomeados, 1, "I2.1: dry-run isolado ainda soma as contagens do relatório corretamente");
    eq(chamadasIsoladas.length, 0, "I2.2: NENHUMA chamada ao Prisma falso — nem $transaction sequer abre");
  }

  // ══════════════════════════════════════════════════════════════════════
  // I3 · rollback integral — um erro A MEIO da transacção propaga-se para
  //      fora de executarNormalizacaoBatch (nunca é engolido), que é a
  //      condição necessária para o $transaction real do Prisma reverter
  //      tudo. Aqui simula-se com um Prisma falso cujo segundo grupo
  //      lança a meio, depois de o primeiro já ter "escrito".
  // ══════════════════════════════════════════════════════════════════════
  console.log("\nI3 · rollback integral — erro a meio da transacção propaga-se (não é engolido)");
  {
    const gruposRollback: GrupoNormalizacao[] = [
      { kind: "initial_orthographic", canonical_id: "r1", source_ids: ["r1s1"] },
      { kind: "initial_orthographic", canonical_id: "r2", source_ids: ["r2s1"] },
    ];
    const fabricantesPorIdRollback = new Map<string, FabricanteDb>([
      ["r1", fab("r1", "R1 LDA")],
      ["r1s1", fab("r1s1", "R1S1 LDA")],
      ["r2", fab("r2", "R2 LDA")],
      ["r2s1", fab("r2s1", "R2S1 LDA")],
    ]);
    const relatorioRollback = planearNormalizacaoBatch({
      grupos: gruposRollback,
      fabricantesPorId: fabricantesPorIdRollback,
      produtosPorFabricanteId: new Map(),
      doNotMerge: [],
    });
    eq(relatorioRollback.gruposBloqueados.length, 0, "I3.1: nenhum conflito — o abort pré-transacção não se aplica aqui");
    eq(relatorioRollback.sourcesExcluidos.length, 0, "I3.2: nenhum conflito — idem");

    let transacaoFoiRevertida = false;
    let chamadasAntesDoErro = 0;
    const fakeRollback = {
      produto: { updateMany: async () => ({ count: 0 }) },
      fabricanteAlias: { upsert: async () => ({}), deleteMany: async () => ({ count: 0 }) },
      fabricante: {
        update: async (args: { where: { id: string } }) => {
          chamadasAntesDoErro++;
          // r1s1 (loser do primeiro grupo) é desactivado com sucesso; r2s1
          // (loser do segundo grupo) é onde a falha simulada acontece — ou
          // seja, DEPOIS de o primeiro grupo já ter "escrito" de verdade.
          if (args.where.id === "r2s1") {
            throw new Error("falha simulada a meio da transação (ex.: violação de unicidade na BD real)");
          }
          return {};
        },
      },
      enrichmentSourceLog: { createMany: async () => ({ count: 0 }) },
      $transaction: async (fn: (tx: unknown) => Promise<void>) => {
        try {
          return await fn(fakeRollback);
        } catch (err) {
          // É EXACTAMENTE isto que o Prisma real faz: um erro dentro do
          // callback da transacção interactiva faz ROLLBACK automático.
          transacaoFoiRevertida = true;
          throw err;
        }
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    let lancouRollback = false;
    let mensagemRollback = "";
    try {
      await executarNormalizacaoBatch(fakeRollback as PrismaClient, { relatorio: relatorioRollback, source: "teste", dryRun: false });
    } catch (err) {
      lancouRollback = true;
      mensagemRollback = err instanceof Error ? err.message : String(err);
    }
    check(lancouRollback, "I3.3: o erro a meio da transação propaga-se para fora de executarNormalizacaoBatch");
    check(mensagemRollback.includes("falha simulada"), "I3.4: a mensagem original do erro não é substituída nem engolida", mensagemRollback);
    check(transacaoFoiRevertida, "I3.5: o wrapper $transaction viu o erro e reverteu (o que o Prisma real faria)");
    eq(chamadasAntesDoErro, 2, "I3.6: o primeiro grupo (r1) chegou a chamar fabricante.update antes do segundo (r2) falhar — prova que a falha é MESMO a meio, não antes de começar");
  }

  // ══════════════════════════════════════════════════════════════════════
  // K · --apply aborta TUDO perante qualquer conflito — nunca aplica só
  //     os itens limpos e ignora os outros em silêncio
  // ══════════════════════════════════════════════════════════════════════
  console.log("\nK · executarNormalizacaoBatch — abortar tudo perante qualquer conflito (só em --apply)");
  {
    // Um grupo válido + um grupo bloqueado (canonical inexistente) no MESMO relatório.
    const grupos: GrupoNormalizacao[] = [
      { kind: "initial_orthographic", canonical_id: "c1", source_ids: ["s1"] },
      { kind: "initial_orthographic", canonical_id: "naoexiste", source_ids: ["s2"] },
    ];
    const fabricantesPorId = new Map<string, FabricanteDb>([
      ["c1", fab("c1", "C1 LDA")],
      ["s1", fab("s1", "S1 LDA")],
      ["s2", fab("s2", "S2 LDA")],
    ]);
    const relatorioComConflito = planearNormalizacaoBatch({
      grupos,
      fabricantesPorId,
      produtosPorFabricanteId: new Map(),
      doNotMerge: [],
    });
    eq(relatorioComConflito.grupos.length, 1, "K1: o primeiro grupo continua válido no relatório");
    eq(relatorioComConflito.gruposBloqueados.length, 1, "K2: o segundo fica bloqueado (canonical_id inexistente)");

    const chamadasK: string[] = [];
    const fakeK = {
      produto: { updateMany: async () => { chamadasK.push("produto.updateMany"); return { count: 0 }; } },
      fabricanteAlias: {
        upsert: async () => { chamadasK.push("fabricanteAlias.upsert"); return {}; },
        deleteMany: async () => { chamadasK.push("fabricanteAlias.deleteMany"); return { count: 0 }; },
      },
      fabricante: { update: async () => { chamadasK.push("fabricante.update"); return {}; } },
      enrichmentSourceLog: { createMany: async () => { chamadasK.push("enrichmentSourceLog.createMany"); return { count: 0 }; } },
      $transaction: async (fn: (tx: unknown) => Promise<void>) => fn(fakeK),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    let lancou = false;
    let mensagem = "";
    try {
      await executarNormalizacaoBatch(fakeK as PrismaClient, { relatorio: relatorioComConflito, source: "teste", dryRun: false });
    } catch (err) {
      lancou = true;
      mensagem = err instanceof Error ? err.message : String(err);
    }
    check(lancou, "K3: --apply lança erro em vez de aplicar parcialmente");
    check(mensagem.includes("1 grupo(s) bloqueado(s)"), "K4: a mensagem diz quantos grupos estão bloqueados", mensagem);
    eq(chamadasK.length, 0, "K5: NADA foi chamado no Prisma — nem sequer o grupo #1, que era válido sozinho");
  }
  {
    // Relatório 100% limpo: --apply corre normalmente (nenhum abort).
    const grupos: GrupoNormalizacao[] = [{ kind: "initial_orthographic", canonical_id: "c1", source_ids: ["s1"] }];
    const fabricantesPorId = new Map<string, FabricanteDb>([
      ["c1", fab("c1", "C1 LDA")],
      ["s1", fab("s1", "S1 LDA")],
    ]);
    const relatorioLimpo = planearNormalizacaoBatch({ grupos, fabricantesPorId, produtosPorFabricanteId: new Map(), doNotMerge: [] });
    eq(relatorioLimpo.gruposBloqueados.length, 0, "K6: nenhum grupo bloqueado");
    eq(relatorioLimpo.sourcesExcluidos.length, 0, "K7: nenhum source excluído");

    const chamadasLimpo: string[] = [];
    const fakeLimpo = {
      produto: { updateMany: async () => { chamadasLimpo.push("produto.updateMany"); return { count: 0 }; } },
      fabricanteAlias: {
        upsert: async () => { chamadasLimpo.push("fabricanteAlias.upsert"); return {}; },
        deleteMany: async () => { chamadasLimpo.push("fabricanteAlias.deleteMany"); return { count: 0 }; },
      },
      fabricante: { update: async () => { chamadasLimpo.push("fabricante.update"); return {}; } },
      enrichmentSourceLog: { createMany: async () => { chamadasLimpo.push("enrichmentSourceLog.createMany"); return { count: 0 }; } },
      $transaction: async (fn: (tx: unknown) => Promise<void>) => fn(fakeLimpo),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const resultadoLimpo = await executarNormalizacaoBatch(fakeLimpo as PrismaClient, {
      relatorio: relatorioLimpo,
      source: "teste",
      dryRun: false,
    });
    eq(resultadoLimpo.fabricantesInativados, 1, "K8: um relatório limpo aplica normalmente, sem abortar");
    check(chamadasLimpo.includes("fabricante.update"), "K9: o Prisma foi mesmo chamado desta vez");
  }

  console.log(`\n${ok} ok, ${ko} falhas`);
  process.exit(ko === 0 ? 0 : 1);
}

principal();
