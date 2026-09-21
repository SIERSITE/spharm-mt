/**
 * scripts/tests/test-fabricante-normalizacao-batch.ts
 *
 * Lógica pura de lib/catalog-fabricante-normalizacao-batch.ts — sem BD
 * viva. Prova as regras do plano
 * (scripts/data/plano-execucao-normalizacao-garantia.json):
 * ids inexistentes/inactivos são ignorados e reportados, source_id
 * repetido entre grupos só conta uma vez, self-merge é ignorado,
 * do_not_merge nunca vira merge, e o parsing de CLI aceita só
 * --tenant=garantia.
 *
 * Corre com: npx tsx scripts/tests/test-fabricante-normalizacao-batch.ts
 */
import {
  combinarGrupos,
  planearNormalizacaoBatch,
  type FabricanteDb,
  type GrupoNormalizacao,
  type PlanoNormalizacaoArquivo,
} from "../../lib/catalog-fabricante-normalizacao-batch";
import type { ProdutoDoLoser } from "../../lib/catalog-fabricante-merge";
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
// G · parseArgs (scripts/normalizar-fabricantes-garantia.ts)
// ══════════════════════════════════════════════════════════════════════
console.log("\nG · parseArgs do CLI de normalização");
{
  const args = parseArgs(["--tenant=garantia", "--source=x"]);
  eq(args.apply, false, "G1: default é dry-run");
  eq(args.incluirValidadosManualmente, false, "G2: default não inclui validados manualmente");
  check(args.planoPath.endsWith("plano-execucao-normalizacao-garantia.json"), "G3: plano por omissão aponta para o ficheiro certo", args.planoPath);
}
{
  const args = parseArgs(["--tenant=garantia", "--source=x", "--apply", "--plano=outro.json", "--incluir-validados-manualmente"]);
  eq(args.apply, true, "G4: --apply liga o modo de escrita");
  eq(args.planoPath, "outro.json", "G5: --plano= sobrepõe o default");
  eq(args.incluirValidadosManualmente, true, "G6: --incluir-validados-manualmente liga a flag");
}
{
  check(
    (() => { try { parseArgs(["--tenant=garantia"]); return false; } catch { return true; } })(),
    "G7: falta --source é erro fatal",
  );
  check(
    (() => { try { parseArgs(["--tenant=garantia", "--source=x", "--desconhecido"]); return false; } catch { return true; } })(),
    "G8: argumento desconhecido é erro fatal",
  );
}

console.log(`\n${ok} ok, ${ko} falhas`);
process.exit(ko === 0 ? 0 : 1);
