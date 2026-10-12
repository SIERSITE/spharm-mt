/**
 * scripts/ops/garantia-reposicao-manutencoes-vendas.ts
 *
 * OPERAÇÃO ADMINISTRATIVA ÚNICA (não é uma funcionalidade): repõe na base do
 * tenant `garantia` os 36 registos históricos da Manutenção de Evolução de
 * Vendas do sistema anterior (scripts/ops/garantia-manutencoes-vendas/dados.json).
 *
 *   DRY-RUN (por omissão — zero escritas):
 *     npx tsx scripts/ops/garantia-reposicao-manutencoes-vendas.ts --tenant=garantia
 *
 *   APPLY (ESCREVE na base do tenant; uma só transacção):
 *     npx tsx scripts/ops/garantia-reposicao-manutencoes-vendas.ts --tenant=garantia \
 *       --apply --confirmar-tenant=garantia --utilizador-email=<email de um utilizador do tenant>
 *
 *   REVERSÃO (remove SÓ os registos do relatório do --apply):
 *     npx tsx scripts/ops/garantia-reposicao-manutencoes-vendas.ts --tenant=garantia \
 *       --reverter=<relatorio-apply.json>                          (dry-run da reversão)
 *       --reverter=<relatorio-apply.json> --apply --confirmar-tenant=garantia
 *
 * Opções: --relatorio=<caminho do JSON de saída>; --farmacias="Garantia=<id>,Principal=<id>,…"
 * (fixa os ids das farmácias depois de os ver no dry-run).
 *
 * Aceita EXCLUSIVAMENTE --tenant=garantia, resolvido pelo control plane real
 * (lib/control-plane). Nunca usa uma ligação global.
 * Exit codes: 0 OK · 1 recusado/bloqueado/erro · 2 erro de uso.
 */
import "dotenv/config";
import { parseArgs } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import path from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";
import { COLUNAS, TENANT_ALVO, contar, reverter, type Coluna, type DocumentoJson } from "./garantia-manutencoes-vendas/operacao";
import { executar } from "./garantia-manutencoes-vendas/executar";

const AJUDA = [
  "Reposição ÚNICA do histórico da Manutenção de Vendas no tenant garantia (36 registos).",
  "",
  "  --tenant=garantia                 obrigatório; qualquer outro valor é recusado (exit 2)",
  "  (sem --apply)                     DRY-RUN: zero escritas",
  "  --apply --confirmar-tenant=garantia --utilizador-email=<email>",
  "                                    ESCREVE na base do tenant (uma só transacção)",
  "  --relatorio=<ficheiro.json>       destino do relatório (em Docker: /relatorios/…)",
  "  --farmacias=\"Garantia=<id>,Principal=<id>,…\"   fixa os ids das farmácias",
  "  --reverter=<relatorio-apply.json> [--apply --confirmar-tenant=garantia]",
  "                                    reversão (dry-run sem --apply)",
  "  --ficheiro=<dados.json>           por omissão o dados.json versionado",
  "  --help                            esta ajuda (exit 0)",
  "",
  "Exit codes: 0 OK · 1 recusado/bloqueado/erro · 2 erro de uso.",
].join("\n");

const usar = (msg: string): never => {
  console.error(`✗ ${msg}`);
  process.exit(2);
};

async function main() {
  const { values } = parseArgs({
    options: {
      tenant: { type: "string" },
      apply: { type: "boolean", default: false },
      "confirmar-tenant": { type: "string" },
      "utilizador-email": { type: "string" },
      relatorio: { type: "string" },
      reverter: { type: "string" },
      farmacias: { type: "string" },
      ficheiro: { type: "string" },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });

  // Ajuda: não resolve tenant, não lê dados, não toca em nenhuma base.
  if (values.help) {
    console.log(AJUDA);
    return;
  }

  if (values.tenant !== TENANT_ALVO) usar(`Esta operação aceita exclusivamente --tenant=${TENANT_ALVO} (recebido: ${values.tenant ?? "nada"}).`);
  if (values.apply && values["confirmar-tenant"] !== TENANT_ALVO) usar(`--apply exige também --confirmar-tenant=${TENANT_ALVO}.`);

  const ficheiro = path.resolve(values.ficheiro ?? path.join(__dirname, "garantia-manutencoes-vendas", "dados.json"));
  const bruto = readFileSync(ficheiro);
  const ficheiroHash = createHash("sha256").update(bruto).digest("hex");
  const doc = JSON.parse(bruto.toString("utf8")) as DocumentoJson;

  const explicitas: Partial<Record<Coluna, string>> = {};
  for (const par of (values.farmacias ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [col, id] = par.split("=");
    if (!col || !id || !(COLUNAS as readonly string[]).includes(col)) usar(`--farmacias inválido: «${par}» (formato Garantia=<id>).`);
    explicitas[col as Coluna] = id;
  }

  // Resolução REAL do tenant (control plane) — nunca DATABASE_URL.
  const { getTenantBySlug, buildTenantConnectionString } = await import("../../lib/control-plane");
  const tenant = await getTenantBySlug(TENANT_ALVO);
  if (!tenant) usar(`O tenant "${TENANT_ALVO}" não existe no control plane.`);
  if (tenant!.estado !== "ACTIVE") usar(`O tenant "${TENANT_ALVO}" não está ACTIVE (${tenant!.estado}).`);
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: buildTenantConnectionString(tenant!) }) });
  const baseDadosHint = `${tenant!.dbHost}:${tenant!.dbPort}/${tenant!.dbName}`;
  let revisao = process.env.APP_REVISION ?? "";
  if (!revisao) {
    try { revisao = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim(); } catch { revisao = "(desconhecida)"; }
  }

  try {
    if (values.reverter) {
      const rel = JSON.parse(readFileSync(path.resolve(values.reverter), "utf8")) as { tipo?: string; tenant?: string; criado?: { manutencoesCriadas: Array<{ id: string; celulas: number; somaCelulas: number }> } | null };
      if (rel.tipo !== "apply" || rel.tenant !== TENANT_ALVO || !rel.criado) usar("O relatório indicado não é o de um --apply bem-sucedido do tenant garantia.");
      const antes = await contar(prisma);
      const r = await reverter(prisma, rel.criado!.manutencoesCriadas, { aplicar: values.apply === true, utilizadorEmail: values["utilizador-email"] });
      const depois = await contar(prisma);
      const saida = { tipo: values.apply ? "reversao-apply" : "reversao-dry-run", revisaoCodigo: revisao, tenant: TENANT_ALVO, baseDados: baseDadosHint, dataHora: new Date().toISOString(), resultado: r, contagensAntes: antes, contagensDepois: depois };
      const destino = values.relatorio ?? `relatorio-garantia-manutencoes-${saida.tipo}-${Date.now()}.json`;
      writeFileSync(destino, JSON.stringify(saida, null, 2));
      console.log(JSON.stringify({ ...saida, relatorioEm: destino }, null, 2));
      return;
    }

    const rel = await executar(prisma, {
      doc, ficheiroHash, aplicar: values.apply === true, utilizadorEmail: values["utilizador-email"],
      farmaciasExplicitas: explicitas, baseDadosHint, revisao, tenant: TENANT_ALVO,
    });
    const destino = values.relatorio ?? `relatorio-garantia-manutencoes-${rel.tipo}-${Date.now()}.json`;
    writeFileSync(destino, JSON.stringify(rel, null, 2));
    console.log(JSON.stringify({ ...rel, itens: undefined, relatorioEm: destino }, null, 2));
    if (rel.erros.length > 0 || (rel.bloqueios.length > 0 && values.apply)) process.exitCode = 1;
    else if (rel.bloqueios.length > 0) console.error(`\n⚠ ${rel.bloqueios.length} bloqueio(s) — o --apply seria recusado.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
