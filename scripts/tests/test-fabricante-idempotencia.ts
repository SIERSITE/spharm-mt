/**
 * scripts/tests/test-fabricante-idempotencia.ts
 *
 * Bloco C — o bug de idempotência do fabricante em `catalog-from-erp.ts`.
 *
 * ── O defeito ────────────────────────────────────────────────────────
 *
 * Em `aplicar()`, o "actual" passado para o campo `fabricante` era o
 * literal sentinela `"\0existe"` — nunca igual ao `novo` vindo do ERP.
 * `decidirEscrita` nunca via `actual === novo`, e por isso, sempre que
 * `fonteForte` era falso, a decisão caía sempre em "substituir" — UPDATE
 * mais `EnrichmentSourceLog` novo em TODA corrida, mesmo reenviando
 * exactamente o mesmo fabricante todos os dias.
 *
 * Este teste fixa o comportamento correcto directamente contra
 * `applyErpCatalogFields` (não só contra `decidirEscrita`, que já não
 * apanhava o bug — o bug estava no CALLER, na passagem do "actual"):
 *
 *   1. reenviar o MESMO fabricante não escreve nada;
 *   2. um fabricante DIFERENTE, sem fonte forte, substitui (é o caminho
 *      que continua a funcionar: o ERP CONSEGUE corrigir um fabricante
 *      cuja origem também foi o ERP);
 *   3. `Produto.validadoManualmente = true` protege o fabricante mesmo
 *      sem `RegulatoryRecord` nem `EnrichmentSourceLog` fortes — a guarda
 *      nova que `camposManuais` não cobria (não inclui `fabricanteId`).
 *
 * Uso: npx tsx scripts/tests/test-fabricante-idempotencia.ts
 */
import { applyErpCatalogFields, type ErpCatalogRow } from "../../lib/ingest/catalog-from-erp";
import type { PrismaClient } from "../../generated/prisma/client";

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

const CNP = 5000001;

type ProdutoFalso = {
  id: string;
  cnp: number;
  dci: string | null;
  codigoATC: string | null;
  grupoHomogeneo: string | null;
  fabricanteId: string | null;
  designacao: string;
  flagMSRM: boolean;
  flagMNSRM: boolean;
  flagGenerico: boolean;
  tipoArtigo: string | null;
  productType: string | null;
  productTypeConfidence: number | null;
  validadoManualmente: boolean;
  fabricante: { nomeNormalizado: string } | null;
};

/**
 * Um produto MEDICAMENTO já classificado com a confiança máxima
 * (flagMSRM), para que o ramo `productType` de `applyErpCatalogFields`
 * nunca escreva nada e não confunda as asserções sobre o fabricante.
 */
function produtoBase(overrides: Partial<ProdutoFalso>): ProdutoFalso {
  return {
    id: "p1",
    cnp: CNP,
    dci: null,
    codigoATC: null,
    grupoHomogeneo: null,
    fabricanteId: "fab-bayer-pt",
    designacao: "Produto Teste 500mg",
    flagMSRM: true,
    flagMNSRM: false,
    flagGenerico: false,
    tipoArtigo: null,
    productType: "MEDICAMENTO",
    productTypeConfidence: 0.99,
    validadoManualmente: false,
    fabricante: { nomeNormalizado: "BAYER PORTUGAL" },
    ...overrides,
  };
}

/** Prisma falso: só os métodos que `applyErpCatalogFields` chama. */
function prismaFalso(produto: ProdutoFalso) {
  const calls = { produtoUpdate: 0, logCreate: 0, fabricanteUpsert: 0 };
  const fabricantesConhecidos = new Map<string, string>([["BAYER PORTUGAL", "fab-bayer-pt"]]);
  const prisma = {
    produto: {
      findMany: async () => [produto],
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        calls.produtoUpdate++;
        Object.assign(produto, args.data);
        return produto;
      },
    },
    regulatoryRecord: {
      findMany: async () => [] as Array<{ cnp: number; dci: null; codigoATC: null; titularAim: null }>,
    },
    enrichmentSourceLog: {
      findMany: async () => [] as Array<{ produtoId: string; fieldsReturned: string[] }>,
      create: async () => {
        calls.logCreate++;
        return {};
      },
    },
    fabricante: {
      findMany: async (args: { where: { nomeNormalizado: { in: string[] } } }) =>
        args.where.nomeNormalizado.in
          .filter((n) => fabricantesConhecidos.has(n))
          .map((n) => ({ id: fabricantesConhecidos.get(n)!, nomeNormalizado: n })),
      upsert: async (args: { where: { nomeNormalizado: string }; create: { nomeNormalizado: string } }) => {
        calls.fabricanteUpsert++;
        const id = fabricantesConhecidos.get(args.where.nomeNormalizado) ?? `fab-novo-${calls.fabricanteUpsert}`;
        fabricantesConhecidos.set(args.where.nomeNormalizado, id);
        return { id };
      },
    },
  };
  return { prisma: prisma as unknown as PrismaClient, calls };
}

const linha = (fabricante: string | null): ErpCatalogRow => ({
  cnp: CNP,
  dci: null,
  codigoATC: null,
  grupoHomogeneo: null,
  fabricante,
});

async function main() {
  console.log("=== 1. reenviar o MESMO fabricante não escreve nada ===");
  {
    const produto = produtoBase({});
    const { prisma, calls } = prismaFalso(produto);
    const res = await applyErpCatalogFields(prisma, [linha("Bayer Portugal")]);
    eq("candidatos considerados", res.candidatos, 1);
    eq("nenhum campo preenchido", res.preenchidos.fabricante, 0);
    eq("nenhum campo substituído", res.substituidos.fabricante, 0);
    eq("produto.update NÃO foi chamado", calls.produtoUpdate, 0);
    eq("EnrichmentSourceLog NÃO foi criado", calls.logCreate, 0);
  }

  console.log("\n=== 2. fabricante DIFERENTE, sem fonte forte → substitui ===");
  {
    const produto = produtoBase({});
    const { prisma, calls } = prismaFalso(produto);
    const res = await applyErpCatalogFields(prisma, [linha("Bayer AG")]);
    eq("substituído (o ERP consegue corrigir o próprio ERP)", res.substituidos.fabricante, 1);
    eq("produto.update foi chamado uma vez", calls.produtoUpdate, 1);
    eq("EnrichmentSourceLog foi criado uma vez", calls.logCreate, 1);
    ok(
      "o fabricanteId gravado é o do novo nome, não o antigo",
      produto.fabricanteId !== "fab-bayer-pt" && typeof produto.fabricanteId === "string",
    );
  }

  console.log("\n=== 3. validadoManualmente protege o fabricante mesmo sem RegulatoryRecord ===");
  {
    const produto = produtoBase({ validadoManualmente: true });
    const { prisma, calls } = prismaFalso(produto);
    const res = await applyErpCatalogFields(prisma, [linha("Bayer AG")]);
    eq("preservado, não substituído", res.substituidos.fabricante, 0);
    eq("contabilizado como preservado", res.preservados.fabricante, 1);
    eq("produto.update NÃO foi chamado", calls.produtoUpdate, 0);
    eq("EnrichmentSourceLog NÃO foi criado", calls.logCreate, 0);
    eq("fabricanteId original mantido", produto.fabricanteId, "fab-bayer-pt");
  }

  console.log("\n=== 4. campo vazio no ERP nunca apaga o fabricante existente ===");
  {
    const produto = produtoBase({});
    const { prisma, calls } = prismaFalso(produto);
    const res = await applyErpCatalogFields(prisma, [linha(null)]);
    eq("nenhum candidato (linha sem nada de útil)", res.candidatos, 0);
    eq("produto.update NÃO foi chamado", calls.produtoUpdate, 0);
    eq("EnrichmentSourceLog NÃO foi criado", calls.logCreate, 0);
  }

  console.log(`\n${pass} ok, ${fail} falhas`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
