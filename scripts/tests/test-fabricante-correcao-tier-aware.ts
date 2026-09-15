/**
 * scripts/tests/test-fabricante-correcao-tier-aware.ts
 *
 * Bloco F — correcção tier-aware de `Produto.fabricanteId` a partir de uma
 * listagem regulatória (RegulatoryRecord.titularAim), incluindo campos JÁ
 * PREENCHIDOS (não só vazios), sem nunca substituir uma fonte superior por
 * uma inferior.
 *
 * Cobre:
 *   1. `decideManufacturerCorrection` (função pura) — os três cenários do
 *      enunciado: sobrescrita permitida com fonte fraca; bloqueio por
 *      `validadoManualmente`; bloqueio quando a fonte actual já é tão forte
 *      quanto REGULATORY.
 *   2. `inferCurrentManufacturerTier` — mapeamento de fonte conhecida,
 *      fonte desconhecida de alta confiança, e ausência de log.
 *   3. `applyAuthoritativeManufacturerCorrections` com Prisma falso (sem
 *      BD viva) — contagem correcta de cada categoria do dry-run, e depois
 *      confirmação de que a aplicação real (`dryRun:false`) só escreve o
 *      que o relatório prometeu.
 *   4. Ponta-a-ponta com um ficheiro CSV sintético (linhas válidas, CNP
 *      duplicado, CNP inexistente, fabricante vazio, linha malformada),
 *      reaproveitando `readRows`/`parseRows`/`resolveMapping` de
 *      `import-regulatory-record.ts` e `dedupeByLastCnp` de
 *      `correct-fabricantes-listagem.ts` — exactamente o caminho que o
 *      script de correcção usa.
 *
 * Uso: npx tsx scripts/tests/test-fabricante-correcao-tier-aware.ts
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { PrismaClient } from "../../generated/prisma/client";
import {
  applyAuthoritativeManufacturerCorrections,
  decideManufacturerCorrection,
  inferCurrentManufacturerTier,
  type ManufacturerListingRow,
} from "../../lib/catalog-persistence";
import { normalizeFabricanteCanonico } from "../../lib/catalog-normalizers";
import { normalizarFabricante } from "../../lib/ingest/catalog-from-erp";
import { parseRows, readRows, resolveMapping } from "../import-regulatory-record";
import { dedupeByLastCnp, parseArgs } from "../correct-fabricantes-listagem";
import { AlvoRecusado, resolverAlvo, type TenantParaLigacao } from "../../lib/catalog/target-db";
import { readFileSync } from "node:fs";

let pass = 0;
let fail = 0;
const ok = (label: string, cond: boolean, extra?: string) => {
  if (cond) {
    pass++;
    console.log(`  [OK]    ${label}`);
  } else {
    fail++;
    console.log(`  [FALHA] ${label}${extra ? ` — ${extra}` : ""}`);
  }
};
const eq = <T>(label: string, obtido: T, esperado: T) =>
  ok(label, Object.is(obtido, esperado), `obtido ${JSON.stringify(obtido)}, esperado ${JSON.stringify(esperado)}`);

// ─────────────────────────────────────────────────────────────────────────
// 1. decideManufacturerCorrection — função pura
// ─────────────────────────────────────────────────────────────────────────

function testDecideManufacturerCorrection(): void {
  console.log("\n=== 1. decideManufacturerCorrection (função pura) ===");

  {
    const d = decideManufacturerCorrection({
      validadoManualmente: false,
      currentNormalized: "Fabricante Antigo",
      newNormalized: "Fabricante Novo",
      newTier: "REGULATORY",
      newConfidence: 0.95,
      currentTierEvidence: null, // fonte fraca/desconhecida
    });
    eq("fonte actual fraca → sobrescrita permitida", d.action, "update");
  }

  {
    const d = decideManufacturerCorrection({
      validadoManualmente: true,
      currentNormalized: "Fabricante Antigo",
      newNormalized: "Fabricante Novo",
      newTier: "REGULATORY",
      newConfidence: 0.95,
      currentTierEvidence: null,
    });
    eq("validadoManualmente=true → bloqueado", d.action, "blocked_manual");
  }

  {
    const d = decideManufacturerCorrection({
      validadoManualmente: false,
      currentNormalized: "Fabricante Antigo",
      newNormalized: "Fabricante Novo",
      newTier: "REGULATORY",
      newConfidence: 0.95,
      currentTierEvidence: "REGULATORY", // tão forte quanto a nova (empate)
    });
    eq("fonte actual tão forte quanto REGULATORY (empate), sem flag → bloqueado", d.action, "blocked_source");
    ok("empate sem flag → sameTier=true no diagnóstico", d.sameTier === true, JSON.stringify(d));
  }

  // ── (a) same-tier bloqueado por omissão (allowSameTierOverwrite ausente) ──
  {
    const d = decideManufacturerCorrection({
      validadoManualmente: false,
      currentNormalized: "Fabricante Antigo",
      newNormalized: "Fabricante Novo",
      newTier: "REGULATORY",
      newConfidence: 0.95,
      currentTierEvidence: "REGULATORY",
      // allowSameTierOverwrite omitido → default false, comportamento igual ao caso acima
    });
    eq("empate, allowSameTierOverwrite omitido (default false) → bloqueado", d.action, "blocked_source");
    ok("empate, flag omitida → sameTier=true", d.sameTier === true);
  }
  {
    const d = decideManufacturerCorrection({
      validadoManualmente: false,
      currentNormalized: "Fabricante Antigo",
      newNormalized: "Fabricante Novo",
      newTier: "REGULATORY",
      newConfidence: 0.95,
      currentTierEvidence: "REGULATORY",
      allowSameTierOverwrite: false,
    });
    eq("empate, allowSameTierOverwrite=false explícito → bloqueado", d.action, "blocked_source");
    ok("empate, flag=false → sameTier=true", d.sameTier === true);
  }

  // ── (b) same-tier permitido com a flag ──────────────────────────────────
  {
    const d = decideManufacturerCorrection({
      validadoManualmente: false,
      currentNormalized: "Fabricante Antigo",
      newNormalized: "Fabricante Novo",
      newTier: "REGULATORY",
      newConfidence: 0.95,
      currentTierEvidence: "REGULATORY",
      allowSameTierOverwrite: true,
    });
    eq("empate, allowSameTierOverwrite=true → permitido (update)", d.action, "update");
    ok("empate, flag=true → sameTier=true no diagnóstico", d.sameTier === true);
  }

  // ── (c) validadoManualmente bloqueia SEMPRE, mesmo com a flag activa e empate ──
  {
    const d = decideManufacturerCorrection({
      validadoManualmente: true,
      currentNormalized: "Fabricante Antigo",
      newNormalized: "Fabricante Novo",
      newTier: "REGULATORY",
      newConfidence: 0.95,
      currentTierEvidence: "REGULATORY", // empate
      allowSameTierOverwrite: true, // flag activa
    });
    eq("validadoManualmente=true bloqueia mesmo com allowSameTierOverwrite=true e empate de tier", d.action, "blocked_manual");
  }

  // ── (d) tier inferior nunca substitui superior, com ou sem a flag ───────
  {
    const base = {
      validadoManualmente: false,
      currentNormalized: "Fabricante Antigo",
      newNormalized: "Fabricante Novo",
      newTier: "MANUFACTURER" as const, // rank 1 — menos autoritário
      newConfidence: 0.95,
      currentTierEvidence: "REGULATORY" as const, // rank 0 — mais autoritário
    };
    const semFlag = decideManufacturerCorrection(base);
    eq("tier novo (MANUFACTURER) mais fraco que actual (REGULATORY), sem flag → bloqueado", semFlag.action, "blocked_source");
    ok("tier estritamente mais forte não é marcado sameTier", !semFlag.sameTier);

    const comFlag = decideManufacturerCorrection({ ...base, allowSameTierOverwrite: true });
    eq(
      "tier novo (MANUFACTURER) mais fraco que actual (REGULATORY), com allowSameTierOverwrite=true → continua bloqueado",
      comFlag.action,
      "blocked_source",
    );
    ok("tier estritamente mais forte com flag activa continua sem sameTier", !comFlag.sameTier);
  }

  {
    // MANUFACTURER é mais forte que REGULATORY? Não — MANUFACTURER tem rank
    // maior (1) que REGULATORY (0), logo é MAIS FRACA. Uma correcção
    // REGULATORY deve conseguir substituir um valor com evidência
    // MANUFACTURER.
    const d = decideManufacturerCorrection({
      validadoManualmente: false,
      currentNormalized: "Fabricante Antigo",
      newNormalized: "Fabricante Novo",
      newTier: "REGULATORY",
      newConfidence: 0.95,
      currentTierEvidence: "MANUFACTURER",
    });
    eq("REGULATORY corrige valor com evidência MANUFACTURER (mais fraca)", d.action, "update");
  }

  {
    const d = decideManufacturerCorrection({
      validadoManualmente: false,
      currentNormalized: null,
      newNormalized: "Fabricante Novo",
      newTier: "REGULATORY",
      newConfidence: 0.95,
      currentTierEvidence: null,
    });
    eq("campo vazio → preenche independentemente de tier evidence", d.action, "update");
  }

  {
    const d = decideManufacturerCorrection({
      validadoManualmente: false,
      currentNormalized: "Mesmo Fabricante",
      newNormalized: "Mesmo Fabricante",
      newTier: "REGULATORY",
      newConfidence: 0.95,
      currentTierEvidence: "REGULATORY",
    });
    eq("valor novo igual ao actual → unchanged (mesmo com fonte forte)", d.action, "unchanged");
  }

  {
    const d = decideManufacturerCorrection({
      validadoManualmente: false,
      currentNormalized: "Fabricante Antigo",
      newNormalized: null,
      newTier: "REGULATORY",
      newConfidence: 0.95,
      currentTierEvidence: null,
    });
    eq("valor novo vazio → empty", d.action, "empty");
  }

  {
    const d = decideManufacturerCorrection({
      validadoManualmente: false,
      currentNormalized: "Fabricante Antigo",
      newNormalized: "Fabricante Novo",
      newTier: "RETAIL", // tier não-autoritário
      newConfidence: 0.95,
      currentTierEvidence: null,
    });
    eq("tier não-autoritário (RETAIL) → sempre bloqueado", d.action, "blocked_source");
  }

  {
    const d = decideManufacturerCorrection({
      validadoManualmente: false,
      currentNormalized: "Fabricante Antigo",
      newNormalized: "Fabricante Novo",
      newTier: "REGULATORY",
      newConfidence: 0.3, // abaixo do limiar THRESHOLD_PARTIAL=0.50
      currentTierEvidence: null,
    });
    eq("confiança abaixo do limiar → bloqueado", d.action, "blocked_low_confidence");
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 2. inferCurrentManufacturerTier
// ─────────────────────────────────────────────────────────────────────────

function testInferCurrentManufacturerTier(): void {
  console.log("\n=== 2. inferCurrentManufacturerTier ===");

  eq(
    "sem log → null (fraca/desconhecida)",
    inferCurrentManufacturerTier(null),
    null,
  );
  eq(
    "fonte conhecida 'infarmed' → REGULATORY",
    inferCurrentManufacturerTier({ source: "infarmed", confidence: 0.95 }),
    "REGULATORY",
  );
  eq(
    "fonte conhecida 'spharm_erp' → ERP_FARMACIA",
    inferCurrentManufacturerTier({ source: "spharm_erp", confidence: 0.9 }),
    "ERP_FARMACIA",
  );
  eq(
    "fonte desconhecida com confiança ≥0.95 → tratada como REGULATORY",
    inferCurrentManufacturerTier({ source: "cedime_anf_2026-05_correction", confidence: 0.95 }),
    "REGULATORY",
  );
  eq(
    "fonte desconhecida com confiança baixa → null (fraca)",
    inferCurrentManufacturerTier({ source: "algum_import_manual", confidence: 0.6 }),
    null,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// 3. applyAuthoritativeManufacturerCorrections — Prisma falso, sem BD
// ─────────────────────────────────────────────────────────────────────────

type ProdutoFalso = {
  id: string;
  cnp: number;
  designacao: string;
  validadoManualmente: boolean;
  fabricante: { nomeNormalizado: string } | null;
};

type LogFalso = { produtoId: string; source: string; confidence: number | null; createdAt: Date };

function prismaFalso(produtos: ProdutoFalso[], logs: LogFalso[]) {
  const calls = { produtoUpdate: 0, logCreate: 0, fabricanteUpsert: 0, aliasUpsert: 0 };
  const logCalls: Record<string, unknown>[] = [];
  const fabricantesConhecidos = new Map<string, string>();
  for (const p of produtos) {
    if (p.fabricante) fabricantesConhecidos.set(p.fabricante.nomeNormalizado, `fab-${p.id}`);
  }

  const prisma = {
    produto: {
      findMany: async (args: { where: { cnp: { in: number[] } } }) =>
        produtos.filter((p) => args.where.cnp.in.includes(p.cnp)),
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        calls.produtoUpdate++;
        const p = produtos.find((x) => x.id === args.where.id)!;
        if ("fabricanteId" in args.data) {
          const fabId = args.data.fabricanteId as string;
          const nome = [...fabricantesConhecidos.entries()].find(([, id]) => id === fabId)?.[0] ?? null;
          p.fabricante = nome ? { nomeNormalizado: nome } : null;
        }
        return p;
      },
    },
    enrichmentSourceLog: {
      findMany: async (args: { where: { produtoId: { in: string[] } } }) =>
        logs
          .filter((l) => args.where.produtoId.in.includes(l.produtoId))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
      create: async (args: { data: Record<string, unknown> }) => {
        calls.logCreate++;
        logCalls.push(args.data);
        return {};
      },
    },
    fabricante: {
      // applyAuthoritativeManufacturerCorrections passa a ler TODOS os
      // fabricantes (sem `where`) para poder deduplicar por forma canónica
      // mesmo quando um já existente está gravado numa grafia diferente —
      // ver o comentário em lib/catalog-persistence.ts. O mock replica isso:
      // devolve tudo o que já foi criado, ignorando qualquer `where`.
      findMany: async () =>
        [...fabricantesConhecidos.entries()].map(([nome, id]) => ({ id, nomeNormalizado: nome })),
      upsert: async (args: { where: { nomeNormalizado: string }; create: { nomeNormalizado: string } }) => {
        calls.fabricanteUpsert++;
        const id = fabricantesConhecidos.get(args.where.nomeNormalizado) ?? `fab-novo-${calls.fabricanteUpsert}`;
        fabricantesConhecidos.set(args.where.nomeNormalizado, id);
        return { id };
      },
    },
    fabricanteAlias: {
      upsert: async () => {
        calls.aliasUpsert++;
        return {};
      },
    },
  };
  return { prisma: prisma as unknown as PrismaClient, calls, logCalls };
}

function cenarioProdutos(): ProdutoFalso[] {
  return [
    { id: "p1", cnp: 5000001, designacao: "Produto A", validadoManualmente: false, fabricante: { nomeNormalizado: "Bayer Portugal" } },
    { id: "p2", cnp: 5000002, designacao: "Produto B", validadoManualmente: false, fabricante: { nomeNormalizado: "Roche" } },
    { id: "p3", cnp: 5000003, designacao: "Produto C", validadoManualmente: false, fabricante: { nomeNormalizado: "Sandoz" } },
    { id: "p5", cnp: 5000005, designacao: "Produto E", validadoManualmente: false, fabricante: { nomeNormalizado: "Antigo Vazio" } },
    { id: "p6", cnp: 5000006, designacao: "Produto G", validadoManualmente: true, fabricante: { nomeNormalizado: "Old Fab" } },
    { id: "p7", cnp: 5000007, designacao: "Produto H", validadoManualmente: false, fabricante: { nomeNormalizado: "Old Fab2" } },
  ];
}

function cenarioLogs(): LogFalso[] {
  return [
    {
      produtoId: "p7",
      source: "infarmed",
      confidence: 0.95,
      createdAt: new Date("2026-01-01"),
    },
  ];
}

/** As mesmas linhas que o CSV sintético da secção 4 produz, já deduplicadas. */
function cenarioLinhas(): ManufacturerListingRow[] {
  return [
    { cnp: 5000001, titularAim: "Bayer AG" }, // corrige (fonte fraca/desconhecida)
    { cnp: 5000002, titularAim: "Roche" }, // sem alteração
    { cnp: 5000003, titularAim: "Sandoz Internacional" }, // corrige (última ocorrência do duplicado)
    { cnp: 5000004, titularAim: "Generic Labs" }, // CNP não encontrado
    { cnp: 5000005, titularAim: null }, // fabricante vazio
    { cnp: 5000006, titularAim: "New Fab" }, // bloqueado — validadoManualmente
    { cnp: 5000007, titularAim: "New Fab2" }, // bloqueado — fonte actual tão forte (infarmed=REGULATORY)
  ];
}

async function testApplyDryRun(): Promise<void> {
  console.log("\n=== 3a. applyAuthoritativeManufacturerCorrections — dry-run ===");
  const { prisma, calls } = prismaFalso(cenarioProdutos(), cenarioLogs());
  const report = await applyAuthoritativeManufacturerCorrections(prisma, cenarioLinhas(), {
    source: "teste_dry_run",
    dryRun: true,
  });

  eq("linhas processadas", report.linhasProcessadas, 7);
  eq("produtos encontrados por CNP", report.produtosEncontrados, 6);
  eq("cnp não encontrados", report.cnpNaoEncontrado, 1);
  eq("fabricante vazio", report.fabricanteVazio, 1);
  eq("sem alteração", report.semAlteracao, 1);
  eq("fabricantes a actualizar", report.atualizados, 2);
  eq("conflitos (bloqueados)", report.conflitos, 2);
  eq("aplicado=false em dry-run", report.aplicado, false);
  eq("dry-run não chama produto.update", calls.produtoUpdate, 0);
  eq("dry-run não chama enrichmentSourceLog.create", calls.logCreate, 0);
  // p7 (cnp 5000007) tem log "infarmed" (REGULATORY) e a nova fonte também é
  // REGULATORY (default) — é exactamente um empate de tier. Sem
  // allowSameTierOverwrite (default desta chamada), fica na categoria
  // própria "bloqueadoMesmoTier", não na genérica "bloqueadoFonteForte".
  eq("same-tier bloqueado (flag OFF) = 1 (cnp 5000007)", report.mesmoTierBloqueado, 1);
  eq("same-tier actualizado (flag OFF) = 0", report.mesmoTierAtualizado, 0);

  const bloqueadoManual = report.detalhes.find((d) => d.cnp === 5000006);
  eq("cnp 5000006 categorizado como bloqueadoValidadoManualmente", bloqueadoManual?.categoria, "bloqueadoValidadoManualmente");
  const bloqueadoFonte = report.detalhes.find((d) => d.cnp === 5000007);
  eq("cnp 5000007 categorizado como bloqueadoMesmoTier (empate REGULATORY↔REGULATORY)", bloqueadoFonte?.categoria, "bloqueadoMesmoTier");
  eq("cnp 5000007 regista a fonte inferida REGULATORY", bloqueadoFonte?.fonteAtualInferida, "REGULATORY");
}

async function testApplyReal(): Promise<void> {
  console.log("\n=== 3b. applyAuthoritativeManufacturerCorrections — aplicação real ===");
  const produtos = cenarioProdutos();
  const { prisma, calls } = prismaFalso(produtos, cenarioLogs());
  const report = await applyAuthoritativeManufacturerCorrections(prisma, cenarioLinhas(), {
    source: "teste_aplicado",
    dryRun: false,
  });

  eq("aplicado=true", report.aplicado, true);
  eq("fabricantes a actualizar (mesma contagem que o dry-run)", report.atualizados, 2);
  eq("produto.update chamado exactamente 2 vezes (só os 'atualizado')", calls.produtoUpdate, 2);
  eq("enrichmentSourceLog.create chamado 2 vezes", calls.logCreate, 2);

  const p1 = produtos.find((p) => p.id === "p1")!;
  // Canónico (maiúsculas) — é o que fica GRAVADO. O "Bayer AG" cru da
  // listagem sobrevive como FabricanteAlias, não como nomeNormalizado.
  eq("p1 (cnp 5000001) passou a ter o fabricante novo", p1.fabricante?.nomeNormalizado, "BAYER AG");
  const p6 = produtos.find((p) => p.id === "p6")!;
  eq("p6 (validadoManualmente) manteve o fabricante original", p6.fabricante?.nomeNormalizado, "Old Fab");
  const p7 = produtos.find((p) => p.id === "p7")!;
  eq("p7 (fonte forte) manteve o fabricante original", p7.fabricante?.nomeNormalizado, "Old Fab2");
}

// ─────────────────────────────────────────────────────────────────────────
// 3c. applyAuthoritativeManufacturerCorrections — allowSameTierOverwrite
// ─────────────────────────────────────────────────────────────────────────

async function testApplySameTierOverwriteDryRun(): Promise<void> {
  console.log("\n=== 3c. applyAuthoritativeManufacturerCorrections — same-tier, dry-run, flag ON ===");
  const { prisma, calls } = prismaFalso(cenarioProdutos(), cenarioLogs());
  const report = await applyAuthoritativeManufacturerCorrections(prisma, cenarioLinhas(), {
    source: "teste_same_tier_dry_run",
    dryRun: true,
    allowSameTierOverwrite: true,
  });

  eq("same-tier actualizado (flag ON, dry-run) = 1 (cnp 5000007)", report.mesmoTierAtualizado, 1);
  eq("same-tier bloqueado (flag ON) = 0 — já não há empates bloqueados", report.mesmoTierBloqueado, 0);
  eq("atualizados normais inalterados (2 — p1/p3, sem evidência de tier)", report.atualizados, 2);
  eq("conflitos cai para 1 (só p6 validadoManualmente; p7 deixou de ser conflito)", report.conflitos, 1);
  eq("dry-run não escreve mesmo com a flag activa", calls.produtoUpdate, 0);

  const linha7 = report.detalhes.find((d) => d.cnp === 5000007);
  eq("cnp 5000007 passa a categoria atualizadoMesmoTier", linha7?.categoria, "atualizadoMesmoTier");
}

async function testApplySameTierOverwriteApply(): Promise<void> {
  console.log("\n=== 3d. applyAuthoritativeManufacturerCorrections — same-tier, --apply, flag ON ===");
  const produtos = cenarioProdutos();
  const { prisma, calls, logCalls } = prismaFalso(produtos, cenarioLogs());
  const report = await applyAuthoritativeManufacturerCorrections(prisma, cenarioLinhas(), {
    source: "teste_same_tier_apply",
    dryRun: false,
    allowSameTierOverwrite: true,
  });

  eq("aplicado=true", report.aplicado, true);
  eq("same-tier actualizado (aplicado) = 1", report.mesmoTierAtualizado, 1);
  eq("atualizados normais (aplicado) = 2", report.atualizados, 2);
  eq("produto.update chamado 3 vezes (2 normais + 1 same-tier)", calls.produtoUpdate, 3);
  eq("enrichmentSourceLog.create chamado 3 vezes", calls.logCreate, 3);

  const p6 = produtos.find((p) => p.id === "p6")!;
  eq("p6 (validadoManualmente) continua protegido mesmo com allowSameTierOverwrite=true", p6.fabricante?.nomeNormalizado, "Old Fab");

  const p7 = produtos.find((p) => p.id === "p7")!;
  // Canónico — "New Fab2" cru sobrevive como alias, não como chave.
  eq("p7 (empate REGULATORY↔REGULATORY, flag ON) foi corrigido para o valor novo", p7.fabricante?.nomeNormalizado, "NEW FAB2");

  const p1 = produtos.find((p) => p.id === "p1")!;
  eq("p1 (correcção normal, sem evidência forte) continua a ser corrigido normalmente", p1.fabricante?.nomeNormalizado, "BAYER AG");

  const logP7 = logCalls.find((d) => d.produtoId === "p7");
  ok(
    "log same-tier de p7 tem o marcador sameTierOverwrite em fieldsReturned",
    !!logP7 && Array.isArray(logP7.fieldsReturned) && (logP7.fieldsReturned as string[]).includes("sameTierOverwrite"),
    JSON.stringify(logP7),
  );
  // rawBrand grava `currentNormalized` — já canónico (re-canonicalizado a
  // partir do valor gravado "Old Fab2", que era Title Case legado).
  eq("log same-tier de p7 regista o valor ANTERIOR (Old Fab2) em rawBrand", logP7?.rawBrand, "OLD FAB2");
  ok(
    "log same-tier de p7 regista a fonte/tier anterior (REGULATORY) em query",
    typeof logP7?.query === "string" && (logP7!.query as string).includes("REGULATORY"),
    JSON.stringify(logP7),
  );

  const logP1 = logCalls.find((d) => d.produtoId === "p1");
  eq("log normal (p1) NÃO tem o marcador sameTierOverwrite", (logP1?.fieldsReturned as string[] | undefined)?.includes("sameTierOverwrite"), false);
  eq("log normal (p1) não usa rawBrand para valor anterior", logP1?.rawBrand, undefined);
}

// ─────────────────────────────────────────────────────────────────────────
// 4. Ponta-a-ponta com ficheiro CSV sintético
// ─────────────────────────────────────────────────────────────────────────

async function testCsvEndToEnd(): Promise<void> {
  console.log("\n=== 4. Ponta-a-ponta — CSV sintético (readRows → parseRows → dedupe) ===");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fabricante-correcao-"));
  const file = path.join(dir, "listagem.csv");
  // cnp;estadoAim;designacaoOficial;titularAim — sem header, formato base.
  const linhas = [
    "5000001;Autorizado;Produto A;Bayer AG",
    "5000002;Autorizado;Produto B;Roche",
    "5000003;Autorizado;Produto C;Sandoz", // duplicado — 1ª ocorrência
    "5000003;Autorizado;Produto C;Sandoz Internacional", // duplicado — última vence
    "5000004;Autorizado;Produto D;Generic Labs", // CNP não vai existir no catálogo
    "5000005;Autorizado;Produto E;", // fabricante vazio
    "abc;Autorizado;Produto F;Foo Labs", // linha malformada — cnp inválido
    "5000006;Autorizado;Produto G;New Fab",
    "5000007;Autorizado;Produto H;New Fab2",
  ];
  fs.writeFileSync(file, linhas.join("\n"), "utf-8");

  try {
    const rows = readRows(file);
    eq("readRows leu 9 linhas", rows.length, 9);

    const { mapping, hasHeader } = resolveMapping(rows, null);
    eq("sem header detectado (1ª célula é numérica)", hasHeader, false);
    eq("mapping default 4-col usado", JSON.stringify(mapping), JSON.stringify({ cnp: 0, estadoAim: 1, designacaoOficial: 2, titularAim: 3 }));

    const stats = parseRows(rows, mapping, hasHeader, null);
    eq("linha malformada (cnp='abc') contabilizada como cnp inválido", stats.skippedNoCnp, 1);
    eq("linhas úteis parseadas (9 − 1 malformada)", stats.parsed.length, 8);

    const { deduped, duplicateCount } = dedupeByLastCnp(stats.parsed);
    eq("1 CNP duplicado detectado (5000003 aparece 2x)", duplicateCount, 1);
    eq("linhas deduplicadas", deduped.length, 7);
    const linha3 = deduped.find((r) => r.cnp === 5000003);
    eq("duplicado: última ocorrência vence ('Sandoz Internacional')", linha3?.titularAim, "Sandoz Internacional");

    // Fase 2, com o mesmo catálogo sintético da secção 3 (CNP 5000004 não existe).
    const { prisma } = prismaFalso(cenarioProdutos(), cenarioLogs());
    const listingRows: ManufacturerListingRow[] = deduped.map((r) => ({ cnp: r.cnp, titularAim: r.titularAim ?? null }));
    const report = await applyAuthoritativeManufacturerCorrections(prisma, listingRows, {
      source: "teste_csv_e2e",
      dryRun: true,
    });

    eq("e2e: linhas processadas = 7 (deduplicadas)", report.linhasProcessadas, 7);
    eq("e2e: cnp não encontrado = 1 (5000004)", report.cnpNaoEncontrado, 1);
    eq("e2e: fabricante vazio = 1 (5000005)", report.fabricanteVazio, 1);
    eq("e2e: sem alteração = 1 (5000002 Roche)", report.semAlteracao, 1);
    eq("e2e: a actualizar = 2 (5000001, 5000003)", report.atualizados, 2);
    eq("e2e: conflitos = 2 (5000006 manual, 5000007 fonte forte)", report.conflitos, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 5. Segurança de tenant — --tenant obrigatório, sem fallback DATABASE_URL
// ─────────────────────────────────────────────────────────────────────────
//
// A falha real que isto impede: correr `correct-fabricantes-listagem.ts`
// sem pensar em tenant nenhum escrevia sempre em `process.env.DATABASE_URL`
// (o `legacyPrisma` de `lib/prisma.ts`) — sem avisar em que base, sem
// distinguir garantia de sier de grupo-silveira. `resolverAlvo` já existe e
// já é testado (`test-target-db.ts`); aqui só se prova que ESTE script o
// usa correctamente, incluindo os dois pontos que o motor genérico não
// cobre: o parser de opções PRÓPRIO deste script (`--file`, `--source`,
// `--apply`, ...) e a fase 1 (`upsertBatch`, RegulatoryRecord).

// Host "postgres" (VPS local, não Neon/Vercel) para não disparar a guarda
// de host externo de resolverAlvo — isso já está coberto por
// test-target-db.ts, não é o que esta secção testa.
const TENANTS: Record<string, TenantParaLigacao> = {
  "grupo-silveira": {
    slug: "grupo-silveira",
    dbHost: "postgres",
    dbPort: 5432,
    dbName: "spharmmt_t_grupo_silveira",
    dbUser: "spharmmt_t_grupo_silveira",
    dbPassEncrypted: "cifrado",
  },
  garantia: {
    slug: "garantia",
    dbHost: "postgres",
    dbPort: 5432,
    dbName: "spharmmt_t_garantia",
    dbUser: "spharmmt_t_garantia",
    dbPassEncrypted: "cifrado",
  },
};

const tenantDeps = {
  getTenantBySlug: async (slug: string) => TENANTS[slug] ?? null,
  buildTenantConnectionString: (t: TenantParaLigacao) =>
    `postgresql://${t.dbUser}:decifrada@${t.dbHost}:${t.dbPort}/${t.dbName}`,
};

async function resolve(argv: string[]) {
  try {
    return { alvo: await resolverAlvo(argv, tenantDeps) };
  } catch (err) {
    if (err instanceof AlvoRecusado) return { erro: err.message };
    throw err;
  }
}

async function testTenantSafety(): Promise<void> {
  console.log("\n=== 5. Segurança de tenant (--tenant obrigatório) ===");

  // ── --tenant é obrigatório ──────────────────────────────────────────
  {
    const semTenant = await resolve(["--file=x.csv", "--source=teste"]);
    ok("sem --tenant é recusado", semTenant.erro !== undefined, JSON.stringify(semTenant));
  }

  // ── tenant inexistente aborta, e aborta ANTES de abrir a BD do tenant ──
  {
    let buildFoiChamado = false;
    const depsQueContam = {
      getTenantBySlug: async (slug: string) => TENANTS[slug] ?? null,
      buildTenantConnectionString: (t: TenantParaLigacao) => {
        buildFoiChamado = true;
        return tenantDeps.buildTenantConnectionString(t);
      },
    };
    try {
      await resolverAlvo(["--tenant=nao-existe"], depsQueContam);
      fail++;
      console.log("  [FALHA] tenant inexistente deveria ter lançado AlvoRecusado");
    } catch (err) {
      ok("tenant inexistente é recusado", err instanceof AlvoRecusado, String(err));
    }
    ok(
      "tenant inexistente nunca chega a construir a connection string (não abre BD)",
      buildFoiChamado === false,
    );
  }

  // ── flag desconhecida é erro fatal, não aviso ──────────────────────────
  {
    let lancou = false;
    try {
      parseArgs(["--tenant=grupo-silveira", "--file=x.csv", "--source=teste", "--tenatn=grupo-silveira"]);
    } catch {
      lancou = true;
    }
    ok("flag desconhecida (typo em --tenant) faz parseArgs lançar, não avisar", lancou);
  }
  {
    let lancou = false;
    try {
      parseArgs(["--tenant=grupo-silveira", "--file=x.csv", "--source=teste", "--bogus"]);
    } catch {
      lancou = true;
    }
    ok("qualquer flag desconhecida faz parseArgs lançar", lancou);
  }
  {
    // --tenant= e --permitir-externo são reconhecidos por parseArgs (só
    // não fazem nada aqui — quem os consome é resolverAlvo) e NÃO devem
    // ser tratados como desconhecidos.
    let lancou = false;
    try {
      parseArgs(["--tenant=grupo-silveira", "--permitir-externo", "--file=x.csv", "--source=teste"]);
    } catch {
      lancou = true;
    }
    ok("--tenant= e --permitir-externo não são 'desconhecidos' para parseArgs", !lancou);
  }

  // ── slug é exacto — "silveira" não resolve por magia para "grupo-silveira" ──
  {
    const comSlugParcial = await resolve(["--tenant=silveira"]);
    ok(
      "'silveira' não é aceite quando o tenant real é 'grupo-silveira' (exact match only)",
      comSlugParcial.erro?.includes("não existe no control plane") === true,
      JSON.stringify(comSlugParcial),
    );
    const comSlugReal = await resolve(["--tenant=grupo-silveira"]);
    ok("'grupo-silveira' (slug real) resolve normalmente", comSlugReal.alvo !== undefined);
  }

  // ── só a BD do slug pedido é usada — nunca a de outro tenant ──────────
  {
    const paraGarantia = await resolve(["--tenant=garantia"]);
    const paraSilveira = await resolve(["--tenant=grupo-silveira"]);
    ok(
      "tenant=garantia resolve para a base de garantia, não a de grupo-silveira",
      paraGarantia.alvo?.base === "spharmmt_t_garantia",
    );
    ok(
      "tenant=grupo-silveira resolve para a base de grupo-silveira, não a de garantia",
      paraSilveira.alvo?.base === "spharmmt_t_grupo_silveira",
    );
    ok(
      "as duas connection strings resolvidas são diferentes",
      paraGarantia.alvo?.url !== paraSilveira.alvo?.url,
    );
  }

  // ── inspecção estática: o script não tem um caminho de fallback para
  //    DATABASE_URL/legacyPrisma, e a fase 1 recebe um prisma explícito ──
  {
    const src = readFileSync(new URL("../correct-fabricantes-listagem.ts", import.meta.url), "utf8");
    const codigo = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join("\n");

    ok("correct-fabricantes-listagem.ts chama resolverAlvo", /resolverAlvo\s*\(/.test(codigo));
    ok(
      "correct-fabricantes-listagem.ts NÃO importa legacyPrisma/lib/prisma",
      !/legacyPrisma|from ["'].*lib\/prisma["']/.test(codigo),
    );
    ok(
      "correct-fabricantes-listagem.ts liga-se com a URL resolvida (alvo.url)",
      /connectionString:\s*alvo\.url/.test(codigo),
    );
    ok(
      "correct-fabricantes-listagem.ts imprime Tenant/Database/Host/Modo antes de processar o ficheiro",
      /Tenant:\s*\$\{alvo\.tenant\}/.test(codigo) &&
        /Database:\s*\$\{alvo\.base\}/.test(codigo) &&
        /Host:\s*\$\{alvo\.host\}/.test(codigo) &&
        /Modo:\s*\$\{dryRun/.test(codigo),
    );
    ok(
      "correct-fabricantes-listagem.ts nunca imprime alvo.url (password incluída)",
      !/console\.log\([^)]*alvo\.url/.test(codigo),
    );
    ok(
      "fase 1 (upsertBatch) recebe o prisma do tenant explicitamente, não o default",
      /upsertBatch\(slice, args\.source, [^,]+, dryRun, prisma\)/.test(codigo),
    );
    ok(
      "sessão Postgres fica read-only em dry-run (mesma tranca dos scripts catalog-master)",
      /default_transaction_read_only = \$\{dryRun \? "on" : "off"\}/.test(codigo),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 6. normalizeFabricanteCanonico — a divergência ERP vs listagem regulatória
// ─────────────────────────────────────────────────────────────────────────
//
// A falha real que isto corrige: "BAYER PORTUGAL LDA" (ingest do ERP,
// maiúsculas) e "Bayer Portugal, Lda." (listagem regulatória, Title Case)
// nunca batiam certo — um dry-run real marcava 100% dos produtos
// encontrados como "a actualizar", mesmo quando o fabricante já estava
// certo. Esta secção prova que as três grafias convergem, que fabricantes
// genuinamente diferentes continuam diferentes, e que o ingest do ERP
// (`normalizarFabricante`) e a comparação (`normalizeFabricanteCanonico`)
// são agora LITERALMENTE a mesma função, não duas cópias sincronizadas à mão.

function testNormalizeFabricanteCanonico(): void {
  console.log("\n=== 6. normalizeFabricanteCanonico — equivalências e distinção ===");

  const variantes = ["BAYER PORTUGAL LDA", "Bayer Portugal, Lda.", "Bayer Portugal Lda"];
  const canonicos = variantes.map((v) => normalizeFabricanteCanonico(v));
  ok(
    "as três grafias de 'Bayer Portugal Lda' convergem para o mesmo canónico",
    canonicos.every((c) => c === canonicos[0]) && canonicos[0] !== null,
    JSON.stringify(canonicos),
  );
  eq("o canónico é maiúsculas sem pontuação", canonicos[0], "BAYER PORTUGAL LDA");

  eq("acentos são removidos", normalizeFabricanteCanonico("Laboratórios Vitória"), "LABORATORIOS VITORIA");
  eq("espaços a mais colapsam", normalizeFabricanteCanonico("Bayer    Portugal"), "BAYER PORTUGAL");
  eq("'&' sobrevive (ex.: Johnson & Johnson)", normalizeFabricanteCanonico("Johnson & Johnson"), "JOHNSON & JOHNSON");

  {
    const a = normalizeFabricanteCanonico("Bayer Portugal Lda");
    const b = normalizeFabricanteCanonico("Bayer AG");
    const c = normalizeFabricanteCanonico("Bayer Portugal SA");
    ok(
      "fabricantes genuinamente diferentes continuam diferentes",
      a !== b && a !== c && b !== c,
      JSON.stringify({ a, b, c }),
    );
  }

  eq("nulo/vazio continua nulo", normalizeFabricanteCanonico(null), null);
  eq("string vazia continua nula", normalizeFabricanteCanonico("   "), null);

  // O ingest do ERP e a comparação da correcção regulatória são a MESMA
  // função — não duas normalizações que só coincidem por acidente.
  for (const v of [...variantes, "Laboratórios Vitória", "X", null]) {
    eq(
      `normalizarFabricante (ERP) === normalizeFabricanteCanonico para "${v}"`,
      normalizarFabricante(v),
      normalizeFabricanteCanonico(v),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 7. applyAuthoritativeManufacturerCorrections não duplica Fabricante
//    quando já existe numa grafia diferente
// ─────────────────────────────────────────────────────────────────────────

async function testNaoDuplicaFabricanteExistente(): Promise<void> {
  console.log("\n=== 7. Sem duplicar Fabricante já existente numa grafia diferente ===");

  // p1 já tem fabricante gravado em Title Case LEGADO (pré-existente antes
  // desta correcção existir — não é tocado, não há backfill). p2 não tem
  // fabricante nenhum e vai receber, da listagem, uma grafia DIFERENTE do
  // mesmo fabricante real (maiúsculas + pontuação).
  const produtos: ProdutoFalso[] = [
    { id: "p1", cnp: 6000001, designacao: "Produto Legado", validadoManualmente: false, fabricante: { nomeNormalizado: "Bayer Portugal Lda" } },
    { id: "p2", cnp: 6000002, designacao: "Produto Novo", validadoManualmente: false, fabricante: null },
  ];
  const { prisma, calls } = prismaFalso(produtos, []);
  const rows: ManufacturerListingRow[] = [
    { cnp: 6000002, titularAim: "BAYER PORTUGAL, LDA." },
  ];

  const report = await applyAuthoritativeManufacturerCorrections(prisma, rows, {
    source: "teste_dedup",
    dryRun: false,
  });

  eq("p2: 1 produto actualizado", report.atualizados, 1);
  const p2 = produtos.find((p) => p.id === "p2")!;
  const p1 = produtos.find((p) => p.id === "p1")!;
  // p2 fica a apontar para o MESMO Fabricante que p1 já usava — a prova é a
  // grafia gravada continuar "Bayer Portugal Lda" (Title Case legado, nunca
  // reescrito) em vez de uma nova linha em maiúsculas: se tivesse sido
  // criado um Fabricante novo, p2 ficaria com "BAYER PORTUGAL LDA".
  eq(
    "p2 aponta para o MESMO Fabricante que p1 (grafia legada preservada, sem rewrite)",
    p2.fabricante?.nomeNormalizado,
    p1.fabricante?.nomeNormalizado,
  );
  eq(
    "nenhum Fabricante novo foi criado — reaproveitou o existente (fabricanteUpsert=0)",
    calls.fabricanteUpsert,
    0,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// 8. Amostra do dry-run — CNP/bruto/canónico/tier para os primeiros 10
// ─────────────────────────────────────────────────────────────────────────

async function testAmostraDryRun(): Promise<void> {
  console.log("\n=== 8. Amostra do dry-run distingue bruto de canónico ===");

  const produtos: ProdutoFalso[] = [
    { id: "p1", cnp: 7000001, designacao: "Produto X", validadoManualmente: false, fabricante: { nomeNormalizado: "Bayer Portugal Lda" } },
  ];
  const { prisma } = prismaFalso(produtos, []);
  const rows: ManufacturerListingRow[] = [{ cnp: 7000001, titularAim: "BAYER PORTUGAL, LDA." }];

  const report = await applyAuthoritativeManufacturerCorrections(prisma, rows, {
    source: "teste_amostra",
    dryRun: true,
  });

  const d = report.detalhes.find((x) => x.cnp === 7000001)!;
  eq("categoria = semAlteracao (mesmo fabricante, grafias diferentes)", d.categoria, "semAlteracao");
  eq("valorAtualBruto preserva a grafia gravada (Title Case legado)", d.valorAtualBruto, "Bayer Portugal Lda");
  eq("valorAtual (canónico) é maiúsculas", d.valorAtual, "BAYER PORTUGAL LDA");
  eq("valorNovoBruto preserva a grafia da listagem", d.valorNovoBruto, "BAYER PORTUGAL, LDA.");
  eq("valorNovo (canónico) bate com o actual — por isso é semAlteracao", d.valorNovo, d.valorAtual);
}

async function main() {
  testDecideManufacturerCorrection();
  testInferCurrentManufacturerTier();
  await testApplyDryRun();
  await testApplyReal();
  await testApplySameTierOverwriteDryRun();
  await testApplySameTierOverwriteApply();
  await testCsvEndToEnd();
  await testTenantSafety();
  testNormalizeFabricanteCanonico();
  await testNaoDuplicaFabricanteExistente();
  await testAmostraDryRun();

  console.log(`\n${pass} ok, ${fail} falhas`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
