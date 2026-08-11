/**
 * scripts/admin/enrich-audit-compare.ts
 * Comparação histórica do enriquecimento: usa ProdutoVerificacaoHistorico.fieldsUpdated
 * como evidência primária (não confundir com lastVerifiedAt).
 * Uso: npx tsx --env-file=.env.local scripts/admin/enrich-audit-compare.ts
 */
import { getPrisma } from "@/lib/prisma";

const PREV = {
  date: "2026-07-17",
  total: 7526,
  semATC: 3549,
  semDCI: 3546,
  semForma: 3546,
  semDosagem: 3546,
  semEmbalagem: 3546,
  semImagem: 5742,
  completos: 3977,
};

async function main() {
  const prisma = await getPrisma();
  const now = new Date();

  const med = { productType: "MEDICAMENTO" as const, estado: { not: "INATIVO" as const } };

  const [total, semATC, semDCI, semForma, semDosagem, semEmbalagem, semImagem, completos] =
    await Promise.all([
      prisma.produto.count({ where: med }),
      prisma.produto.count({ where: { ...med, codigoATC: null } }),
      prisma.produto.count({ where: { ...med, dci: null } }),
      prisma.produto.count({ where: { ...med, formaFarmaceutica: null } }),
      prisma.produto.count({ where: { ...med, dosagem: null } }),
      prisma.produto.count({ where: { ...med, embalagem: null } }),
      prisma.produto.count({ where: { ...med, imagemUrl: null } }),
      prisma.produto.count({
        where: {
          ...med,
          codigoATC: { not: null },
          dci: { not: null },
          formaFarmaceutica: { not: null },
          dosagem: { not: null },
          embalagem: { not: null },
        },
      }),
    ]);

  const cur = { total, semATC, semDCI, semForma, semDosagem, semEmbalagem, semImagem, completos };

  const line = "─".repeat(76);
  console.log(`\n${"═".repeat(76)}`);
  console.log("  ENRIQUECIMENTO — COMPARAÇÃO 2026-07-17  ↔  " + now.toISOString());
  console.log("═".repeat(76));

  // 1. Estado actual
  console.log(`\n${line}`);
  console.log("1. ESTADO ACTUAL");
  console.log(line);
  console.log(`  Data consulta:               ${now.toISOString()}`);
  console.log(`  Total MEDICAMENTOs vivos:    ${total}`);
  console.log(`  Com ATC:                     ${total - semATC}       Sem ATC:        ${semATC}`);
  console.log(`  Com DCI:                     ${total - semDCI}       Sem DCI:        ${semDCI}`);
  console.log(`  Com forma:                   ${total - semForma}       Sem forma:      ${semForma}`);
  console.log(`  Com dosagem:                 ${total - semDosagem}       Sem dosagem:    ${semDosagem}`);
  console.log(`  Com embalagem:               ${total - semEmbalagem}       Sem embalagem:  ${semEmbalagem}`);
  console.log(`  Com imagem:                  ${total - semImagem}       Sem imagem:     ${semImagem}`);
  console.log(`  Com todos 5 campos clínicos: ${completos} (${((completos / total) * 100).toFixed(1)}%)`);

  // 2. Comparação
  console.log(`\n${line}`);
  console.log("2. COMPARAÇÃO vs 2026-07-17");
  console.log(line);
  const fmt = (label: string, prev: number, curV: number) => {
    const diff = curV - prev;
    const pct = prev === 0 ? "n/a" : `${((diff / prev) * 100).toFixed(2)}%`;
    const sign = diff > 0 ? "+" : "";
    console.log(
      `  ${label.padEnd(24)} anterior=${String(prev).padStart(6)}  actual=${String(curV).padStart(6)}  Δ=${sign}${String(diff).padStart(5)}  ${pct.padStart(8)}`
    );
  };
  fmt("Total medicamentos", PREV.total, cur.total);
  fmt("Sem ATC", PREV.semATC, cur.semATC);
  fmt("Sem DCI", PREV.semDCI, cur.semDCI);
  fmt("Sem forma", PREV.semForma, cur.semForma);
  fmt("Sem dosagem", PREV.semDosagem, cur.semDosagem);
  fmt("Sem embalagem", PREV.semEmbalagem, cur.semEmbalagem);
  fmt("Sem imagem", PREV.semImagem, cur.semImagem);
  fmt("Completos (5 campos)", PREV.completos, cur.completos);

  // 3-4. ProdutoVerificacaoHistorico por mês, com fieldsUpdated não vazio
  console.log(`\n${line}`);
  console.log("3. HISTÓRICO DE ENRIQUECIMENTO — apenas fieldsUpdated não vazio");
  console.log(line);

  const months = [
    { name: "2026-05", start: new Date("2026-05-01T00:00:00Z"), end: new Date("2026-06-01T00:00:00Z") },
    { name: "2026-06", start: new Date("2026-06-01T00:00:00Z"), end: new Date("2026-07-01T00:00:00Z") },
    { name: "2026-07", start: new Date("2026-07-01T00:00:00Z"), end: new Date("2026-08-01T00:00:00Z") },
    { name: "2026-08", start: new Date("2026-08-01T00:00:00Z"), end: new Date("2026-09-01T00:00:00Z") },
  ];

  const fields = [
    "codigoATC",
    "dci",
    "formaFarmaceutica",
    "dosagem",
    "embalagem",
    "imagemUrl",
    "classificacaoNivel1Id",
    "classificacaoNivel2Id",
  ];

  console.log(
    `  ${"MÊS".padEnd(10)} ${"registos".padEnd(10)} ${"prod.distintos".padEnd(16)}`
  );
  for (const m of months) {
    // Registos com pelo menos um campo actualizado
    const rowsWithUpdates = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count
      FROM "ProdutoVerificacaoHistorico"
      WHERE "verificadoEm" >= ${m.start}
        AND "verificadoEm" <  ${m.end}
        AND array_length("fieldsUpdated", 1) IS NOT NULL
    `;
    const distinctProducts = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(DISTINCT "produtoId")::bigint AS count
      FROM "ProdutoVerificacaoHistorico"
      WHERE "verificadoEm" >= ${m.start}
        AND "verificadoEm" <  ${m.end}
        AND array_length("fieldsUpdated", 1) IS NOT NULL
    `;
    console.log(
      `  ${m.name.padEnd(10)} ${String(rowsWithUpdates[0].count).padEnd(10)} ${String(distinctProducts[0].count).padEnd(16)}`
    );
  }

  console.log(`\n${line}`);
  console.log("4. CAMPOS PREENCHIDOS POR MÊS (contagem de fieldsUpdated)");
  console.log(line);
  console.log(
    "  MÊS       " + fields.map((f) => f.substring(0, 12).padStart(12)).join(" ")
  );
  for (const m of months) {
    const perField: Record<string, number> = {};
    for (const f of fields) {
      const rows = await prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*)::bigint AS count
        FROM "ProdutoVerificacaoHistorico"
        WHERE "verificadoEm" >= ${m.start}
          AND "verificadoEm" <  ${m.end}
          AND ${f} = ANY("fieldsUpdated")
      `;
      perField[f] = Number(rows[0].count);
    }
    console.log(
      "  " + m.name.padEnd(10) +
      fields.map((f) => String(perField[f]).padStart(12)).join(" ")
    );
  }

  // 5. Últimos eventos
  console.log(`\n${line}`);
  console.log("5. ÚLTIMOS EVENTOS");
  console.log(line);

  const lastHistUpdated = await prisma.$queryRaw<
    { verificadoEm: Date; produtoId: string; fieldsUpdated: string[] }[]
  >`
    SELECT "verificadoEm", "produtoId", "fieldsUpdated"
    FROM "ProdutoVerificacaoHistorico"
    WHERE array_length("fieldsUpdated", 1) IS NOT NULL
    ORDER BY "verificadoEm" DESC
    LIMIT 1
  `;
  console.log(
    `  Último ProdutoVerificacaoHistorico c/ fieldsUpdated:  ${
      lastHistUpdated[0]?.verificadoEm?.toISOString() ?? "NUNCA"
    }` +
      (lastHistUpdated[0]
        ? `\n    produtoId=${lastHistUpdated[0].produtoId}  fields=[${lastHistUpdated[0].fieldsUpdated.join(", ")}]`
        : "")
  );

  const lastLog = await prisma.enrichmentSourceLog.findFirst({
    orderBy: { createdAt: "desc" },
    select: { createdAt: true, source: true, status: true, produtoId: true },
  });
  console.log(
    `  Último EnrichmentSourceLog:                          ${
      lastLog?.createdAt?.toISOString() ?? "NUNCA"
    }` +
      (lastLog
        ? `\n    source=${lastLog.source}  status=${lastLog.status}  produtoId=${lastLog.produtoId}`
        : "")
  );

  const lastJob = await prisma.regulatoryAcquisitionJob.findFirst({
    where: { status: { in: ["DONE", "PARTIAL"] as never } },
    orderBy: { updatedAt: "desc" },
    select: { updatedAt: true, status: true, cnp: true },
  });
  console.log(
    `  Último RegulatoryAcquisitionJob DONE/PARTIAL:        ${
      lastJob?.updatedAt?.toISOString() ?? "NUNCA"
    }` + (lastJob ? `\n    status=${lastJob.status}  cnp=${lastJob.cnp}` : "")
  );

  // Último Produto cujo codigoATC passou de null para preenchido — via histórico
  const lastAtcFilled = await prisma.$queryRaw<
    { verificadoEm: Date; produtoId: string }[]
  >`
    SELECT "verificadoEm", "produtoId"
    FROM "ProdutoVerificacaoHistorico"
    WHERE 'codigoATC' = ANY("fieldsUpdated")
    ORDER BY "verificadoEm" DESC
    LIMIT 1
  `;
  console.log(
    `  Último Produto com codigoATC preenchido (histórico): ${
      lastAtcFilled[0]?.verificadoEm?.toISOString() ?? "NUNCA"
    }` +
      (lastAtcFilled[0] ? `\n    produtoId=${lastAtcFilled[0].produtoId}` : "")
  );

  console.log(`\n${"═".repeat(76)}\n`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
