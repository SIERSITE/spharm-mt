/**
 * app/api/ingest/v1/bootstrap/fornecedores/route.ts
 *
 * POST /api/ingest/v1/bootstrap/fornecedores
 *
 * Fase 1a do pipeline compras/devoluções. Recebe um batch de fornecedores
 * vindo do agent local e faz:
 *   1. Resolve ou cria `Fornecedor` canónico (chaveado por `nomeNormalizado`).
 *   2. Upsert `FornecedorErpRef` por `(farmaciaId, externalFornecedorId)`
 *      com snapshot do ERP (nome abreviado, nome completo, NIF, tipo,
 *      flag inactivo).
 *   3. Adiciona aliases derivados ([Nome Abreviado] e [Nome Fornecedor])
 *      em `FornecedorAlias` quando diferem do `nomeNormalizado`. Nunca
 *      apaga aliases existentes — manualmente curados ou auto-gerados.
 *   4. Reflecte estado activo/inactivo do ERP em `Fornecedor.estado`.
 *
 * Idempotência: `(farmaciaId, externalFornecedorId)` é único. Re-runs do
 * mesmo batch actualizam in-place. Sem destruir nada.
 *
 * Auth: withIntegrationAuth (Bearer + X-Tenant-Slug).
 * Feature flag: ENABLE_AGENT_BOOTSTRAP=1. Sem isto → 503.
 *
 * Body:
 *   {
 *     farmaciaId: string,
 *     items: FornecedorPayload[]    // até BOOTSTRAP_MAX_BATCH_SIZE
 *   }
 *
 * Response 200 (success):
 *   {
 *     ok: true,
 *     accepted: N,
 *     upserted: N,                  // refs upserted (created + updated)
 *     fornecedoresCreated: N,       // novos Fornecedor canónicos
 *     fornecedoresUpdated: N,       // Fornecedor canónicos tocados
 *     refsCreated: N,
 *     refsUpdated: N,
 *     aliasesAdded: N,
 *     skipped: [{ index, reason, externalId? }],
 *     errors:  [{ index, reason, externalId?, message }],
 *     durationMs: number
 *   }
 */

import { NextResponse } from "next/server";
import { EntidadeEstado, FornecedorTipo, Prisma } from "@/generated/prisma/client";
import { withIntegrationAuth } from "@/lib/integracao/auth";
import {
  assertBootstrapEnabled,
  assertFarmaciaInTenant,
  parseBatchBody,
  isFailure,
  asIntOrNull,
  asStringOrNull,
  asBoolOrFalse,
  type BootstrapBatchResponse,
} from "@/lib/ingest/bootstrap";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type FornecedorPayload = {
  externalFornecedorId: unknown;
  nomeAbreviado: unknown;
  nomeFornecedor: unknown;
  nif: unknown;
  tipoId: unknown;
  tipoDescricao: unknown;
  inactivo: unknown;
  ingestBatchId: unknown;
};

type FornecedoresBootstrapResponse = BootstrapBatchResponse & {
  fornecedoresCreated: number;
  fornecedoresUpdated: number;
  refsCreated: number;
  refsUpdated: number;
  aliasesAdded: number;
};

/**
 * Normaliza um nome para uso em `Fornecedor.nomeNormalizado` (canónico
 * GLOBAL no tenant). Estratégia conservadora:
 *   · trim
 *   · colapsa runs de whitespace em único espaço
 *   · uppercase (case-insensitive efectivo via constraint UNIQUE)
 *
 * Não remove acentos — `nomeNormalizado` é human-readable. Diacritics
 * só seriam strip se descobríssemos colisões em produção (ex: "Açúcar"
 * vs "Acucar"). Por ora preservamos para evitar falsos positivos.
 */
function normalizeFornecedorName(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().toUpperCase();
}

/**
 * Mapeia o ID de `dbo.Tbl_Tipo_Fornecedores` (Softreis) para o enum
 * canónico `FornecedorTipo`. Conhecidos via rev24 inspection.md:
 *   1=Armazenista, 2=Laboratório, 3=Farmácia, 4=Grossista,
 *   5=Cooperativa, 6=(desconhecido)
 */
function mapTipoFornecedor(tipoId: number | null): FornecedorTipo {
  switch (tipoId) {
    case 1:
      return FornecedorTipo.DISTRIBUIDOR; // Armazenista
    case 2:
      return FornecedorTipo.LABORATORIO_DIRETO;
    case 4:
      return FornecedorTipo.DISTRIBUIDOR; // Grossista
    case 5:
      return FornecedorTipo.COOPERATIVA;
    default:
      return FornecedorTipo.OUTRO;
  }
}

export const POST = withIntegrationAuth(async (ctx, req) => {
  const t0 = Date.now();

  const disabled = assertBootstrapEnabled();
  if (disabled) return disabled;

  const parsed = await parseBatchBody<FornecedorPayload>(req);
  if (isFailure(parsed)) return parsed.response;
  const { farmaciaId, items } = parsed;

  const farmaciaErr = await assertFarmaciaInTenant(ctx.prisma, farmaciaId);
  if (farmaciaErr) return farmaciaErr;

  console.log(
    `[bootstrap/fornecedores] start ${JSON.stringify({
      tenant: ctx.tenant.slug,
      farmaciaId,
      received: items.length,
    })}`
  );

  const skipped: FornecedoresBootstrapResponse["skipped"] = [];
  const errors: FornecedoresBootstrapResponse["errors"] = [];
  let fornecedoresCreated = 0;
  let fornecedoresUpdated = 0;
  let refsCreated = 0;
  let refsUpdated = 0;
  let aliasesAdded = 0;

  for (let i = 0; i < items.length; i++) {
    const raw = items[i] ?? ({} as FornecedorPayload);

    const externalFornecedorId = asIntOrNull(raw.externalFornecedorId);
    const nomeAbreviadoRaw = asStringOrNull(raw.nomeAbreviado);
    const nomeFornecedorRaw = asStringOrNull(raw.nomeFornecedor);
    const nifRaw = asStringOrNull(raw.nif);
    const tipoIdRaw = asIntOrNull(raw.tipoId);
    const tipoDescRaw = asStringOrNull(raw.tipoDescricao);
    const inactivoRaw = asBoolOrFalse(raw.inactivo);
    const ingestBatchIdRaw = asStringOrNull(raw.ingestBatchId);

    if (externalFornecedorId === null) {
      skipped.push({ index: i, reason: "missing_external_id" });
      continue;
    }
    if (nomeAbreviadoRaw === null) {
      skipped.push({
        index: i,
        reason: "missing_nome_abreviado",
        externalId: externalFornecedorId,
      });
      continue;
    }

    const nomeNormalizado = normalizeFornecedorName(nomeAbreviadoRaw);
    // Nome canónico SaaS: preferir [Nome Fornecedor] (mais legível) com
    // fallback para [Nome Abreviado] quando o ERP não preencheu.
    const nomeCanonico = nomeFornecedorRaw ?? nomeAbreviadoRaw;
    const tipoEnum = mapTipoFornecedor(tipoIdRaw);
    const estado = inactivoRaw ? EntidadeEstado.INATIVO : EntidadeEstado.ATIVO;

    try {
      // ── 1. Detectar se ref já existe (drives created/updated counts) ──
      const existingRef = await ctx.prisma.fornecedorErpRef.findUnique({
        where: {
          farmaciaId_externalFornecedorId: {
            farmaciaId,
            externalFornecedorId,
          },
        },
        select: { id: true, fornecedorId: true },
      });

      // ── 2. Resolver/criar Fornecedor canónico por nomeNormalizado ──
      // Se a ref já existir e apontar para um fornecedor, manter esse
      // link (preserva história, mesmo que o ERP tenha mudado o nome).
      // Caso contrário, upsert por nomeNormalizado.
      let fornecedorId: string;
      let fornecedorWasCreated = false;

      if (existingRef) {
        fornecedorId = existingRef.fornecedorId;
        // Update metadados canónicos do Fornecedor — não-destrutivo
        // excepto estado, que reflecte sempre o ERP (decisão de mapping).
        await ctx.prisma.fornecedor.update({
          where: { id: fornecedorId },
          data: {
            nome: nomeCanonico,
            nif: nifRaw ?? undefined,
            tipo: tipoEnum,
            estado,
          },
        });
        fornecedoresUpdated++;
      } else {
        const existingByNome = await ctx.prisma.fornecedor.findUnique({
          where: { nomeNormalizado },
          select: { id: true },
        });
        if (existingByNome) {
          fornecedorId = existingByNome.id;
          await ctx.prisma.fornecedor.update({
            where: { id: fornecedorId },
            data: {
              nome: nomeCanonico,
              nif: nifRaw ?? undefined,
              tipo: tipoEnum,
              estado,
            },
          });
          fornecedoresUpdated++;
        } else {
          const created = await ctx.prisma.fornecedor.create({
            data: {
              nomeNormalizado,
              nome: nomeCanonico,
              nif: nifRaw,
              tipo: tipoEnum,
              estado,
            },
            select: { id: true },
          });
          fornecedorId = created.id;
          fornecedoresCreated++;
          fornecedorWasCreated = true;
        }
      }

      // ── 3. Upsert FornecedorErpRef (snapshot ERP) ──
      if (existingRef) {
        await ctx.prisma.fornecedorErpRef.update({
          where: { id: existingRef.id },
          data: {
            nomeAbreviadoErp: nomeAbreviadoRaw,
            nomeFornecedorErp: nomeFornecedorRaw,
            nifErp: nifRaw,
            tipoFornecedorErpId: tipoIdRaw,
            tipoFornecedorErpDesc: tipoDescRaw,
            inactivoErp: inactivoRaw,
            ingestBatchId: ingestBatchIdRaw,
          },
        });
        refsUpdated++;
      } else {
        await ctx.prisma.fornecedorErpRef.create({
          data: {
            fornecedorId,
            farmaciaId,
            externalFornecedorId,
            nomeAbreviadoErp: nomeAbreviadoRaw,
            nomeFornecedorErp: nomeFornecedorRaw,
            nifErp: nifRaw,
            tipoFornecedorErpId: tipoIdRaw,
            tipoFornecedorErpDesc: tipoDescRaw,
            inactivoErp: inactivoRaw,
            ingestBatchId: ingestBatchIdRaw,
          },
        });
        refsCreated++;
      }

      // ── 4. Aliases: adicionar [Nome Abreviado] e [Nome Fornecedor] ──
      // se diferem do canónico. NUNCA apagar — alias existente fica
      // intacto (preserva curação manual, ainda que não tenhamos UI para
      // isso). `@@unique([fornecedorId, aliasNome])` evita duplicados.
      const aliasCandidates = new Set<string>();
      if (nomeAbreviadoRaw && nomeAbreviadoRaw !== nomeNormalizado) {
        aliasCandidates.add(nomeAbreviadoRaw);
      }
      if (
        nomeFornecedorRaw &&
        nomeFornecedorRaw !== nomeNormalizado &&
        nomeFornecedorRaw !== nomeAbreviadoRaw
      ) {
        aliasCandidates.add(nomeFornecedorRaw);
      }
      for (const aliasNome of aliasCandidates) {
        try {
          await ctx.prisma.fornecedorAlias.create({
            data: { fornecedorId, aliasNome },
          });
          aliasesAdded++;
        } catch (err) {
          // P2002 = unique violation → alias já existe, OK.
          if (
            err instanceof Prisma.PrismaClientKnownRequestError &&
            err.code === "P2002"
          ) {
            // silent: alias já existe
          } else {
            throw err;
          }
        }
      }

      void fornecedorWasCreated;
    } catch (err) {
      errors.push({
        index: i,
        reason: "upsert_failed",
        externalId: externalFornecedorId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const durationMs = Date.now() - t0;
  const upserted = refsCreated + refsUpdated;
  const response: FornecedoresBootstrapResponse = {
    ok: true,
    accepted: items.length,
    upserted,
    fornecedoresCreated,
    fornecedoresUpdated,
    refsCreated,
    refsUpdated,
    aliasesAdded,
    skipped,
    errors,
    durationMs,
  };

  console.log(
    `[bootstrap/fornecedores] done ${JSON.stringify({
      tenant: ctx.tenant.slug,
      farmaciaId,
      accepted: items.length,
      fornecedoresCreated,
      fornecedoresUpdated,
      refsCreated,
      refsUpdated,
      aliasesAdded,
      skipped: skipped.length,
      errors: errors.length,
      durationMs,
    })}`
  );

  return NextResponse.json(response);
});
