/**
 * lib/admin/ops/create-tenant.ts
 *
 * Camada `ops` da criação de clientes: traduz HTTP para o workflow que
 * já existe e traduz o resultado de volta. NADA de lógica de negócio
 * aqui — quem cria bases, regista o tenant, corre migrations, semeia o
 * admin e emite a ingest key é `lib/admin/create-client-workflow.ts`, o
 * mesmo módulo que o `tenant:create` usa desde sempre.
 *
 * Se um dia esta camada e o CLI divergirem no comportamento, é bug: os
 * dois têm de ser janelas para o mesmo workflow.
 *
 * O que esta camada acrescenta, e só isto:
 *   1. tipagem e normalização do corpo JSON (o CLI recebe flags, o HTTP
 *      recebe um objecto de proveniência desconhecida);
 *   2. tradução de falhas em códigos HTTP com significado — em
 *      particular o 409, para que uma criação repetida seja recusada de
 *      forma inequívoca em vez de devolver 500;
 *   3. garantia de que nada de secreto sai para os logs.
 */

import {
  createClient,
  type CreateClientInput,
  type CreateClientResult,
  type Reporter,
} from "@/lib/admin/create-client-workflow";
import type { ProviderKind } from "@/lib/db-providers";
import { AdminApiError } from "@/lib/admin/api-token";

/** Providers aceites no corpo. Igual ao CLI — nenhum modo novo. */
const PROVIDERS: readonly ProviderKind[] = ["neon", "manual", "local"] as const;

export type CreateTenantBody = Record<string, unknown>;

export type CreateTenantOutcome = {
  status: number;
  body: Record<string, unknown>;
  /** Passos executados, sem valores. Para o log de auditoria. */
  steps: string[];
};

function str(v: unknown): string | undefined {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s === "" ? undefined : s;
}

function bool(v: unknown): boolean {
  return v === true || v === "true" || v === 1 || v === "1";
}

/**
 * Farmácias: aceita array (JSON idiomático) ou string separada por
 * vírgulas (o que a flag `--farmacias` do CLI recebe). As duas formas
 * circulam na documentação de onboarding; recusar uma delas seria mudar
 * o contrato para quem já o conhece.
 */
function farmacias(v: unknown): string[] | undefined {
  if (v == null) return undefined;
  const list = Array.isArray(v)
    ? v.map((x) => String(x))
    : String(v).split(",");
  const clean = list.map((s) => s.trim()).filter((s) => s !== "");
  return clean.length > 0 ? clean : undefined;
}

/**
 * Traduz o resultado do workflow em estado HTTP. O workflow não lança em
 * falha de negócio: devolve `ok:false` com o `step` onde parou. É esse
 * step que carrega o significado.
 */
function statusForFailure(result: CreateClientResult): number {
  switch (result.step) {
    // Slug ocupado. É o caso da operação repetida — e tem de ser
    // distinguível de um erro do servidor, senão o wizard não consegue
    // dizer ao técnico "este cliente já existe" em vez de "falhou".
    case "check-slug-free":
      return 409;
    // Entrada recusada pelas validações do workflow.
    case "validate-inputs":
    case "select-provider":
      return 400;
    // Tudo o resto rebentou a meio de uma operação com efeitos.
    default:
      return 500;
  }
}

export async function createTenant(body: CreateTenantBody): Promise<CreateTenantOutcome> {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    throw new AdminApiError(400, "corpo tem de ser um objecto JSON", "bad_request");
  }

  const provider = str(body.provider);
  if (provider !== undefined && !PROVIDERS.includes(provider as ProviderKind)) {
    throw new AdminApiError(
      400,
      `provider inválido: "${provider}". Valores: ${PROVIDERS.join(", ")}`,
      "bad_request"
    );
  }

  // `nome` e `name` ambos aceites, como no CLI.
  const input: CreateClientInput = {
    slug: str(body.slug) ?? "",
    nome: str(body.nome) ?? str(body.name) ?? "",
    adminEmail: str(body.adminEmail) ?? str(body["admin-email"]) ?? "",
    adminNome: str(body.adminNome) ?? str(body["admin-nome"]),
    adminPassword: str(body.adminPassword) ?? str(body["admin-password"]),
    farmacias: farmacias(body.farmacias),
    region: str(body.region),
    provider: provider as ProviderKind | undefined,
    databaseUrl: str(body.databaseUrl) ?? str(body["database-url"]),
    createDb: bool(body.createDb ?? body["create-db"]),
    dryRun: bool(body.dryRun ?? body["dry-run"]),
  };

  // O reporter recolhe NOMES DE PASSOS e nada mais. O workflow já promete
  // não lhe passar segredos (as connection strings vão mascaradas), mas
  // guardar apenas `step` torna isso estrutural em vez de confiado: por
  // muito que o workflow mude, daqui não sai um valor.
  const steps: string[] = [];
  const reporter: Reporter = {
    step: (name) => steps.push(name),
    info: () => {},
    warn: () => {},
  };

  const result = await createClient({ ...input, reporter });

  if (!result.ok) {
    return {
      status: statusForFailure(result),
      steps,
      body: {
        ok: false,
        step: result.step,
        error: result.error ?? "falha sem mensagem",
        slug: result.slug,
        durationMs: result.durationMs,
        // Sobras de uma criação parcial. Sem isto, o operador não sabe
        // que ficou um tenant meio-criado para limpar.
        failedTenantId: result.failedTenantId,
        rollbackStatus: result.rollbackStatus,
        manualActions: result.manualActions,
      },
    };
  }

  if (input.dryRun) {
    return {
      status: 200,
      steps,
      body: {
        ok: true,
        dryRun: true,
        slug: result.slug,
        provider: result.provider,
        step: result.step,
        durationMs: result.durationMs,
      },
    };
  }

  // 201: houve criação. Os dois segredos aparecem AQUI e só aqui — não
  // são recuperáveis depois, e é por isso que a resposta os traz uma vez.
  // Quem consome tem de os mostrar ao operador imediatamente.
  return {
    status: 201,
    steps,
    body: {
      ok: true,
      // `step` vem também no sucesso, com o mesmo valor que o CLI imprime
      // em `--json` ("done"). Quem já consome a saída do CLI não precisa
      // de um segundo formato.
      step: result.step,
      slug: result.slug,
      tenantId: result.tenantId,
      provider: result.provider,
      adminEmail: result.adminEmail,
      adminPassword: result.adminPassword,
      ingestKey: result.ingestKey,
      farmacias: result.farmaciasCreated ?? [],
      smokeOk: result.smokeOk,
      schemaVersion: result.schemaVersion,
      durationMs: result.durationMs,
      shownOnce: ["adminPassword", "ingestKey"],
    },
  };
}
