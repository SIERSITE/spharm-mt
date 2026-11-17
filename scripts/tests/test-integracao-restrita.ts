/**
 * scripts/tests/test-integracao-restrita.ts
 *
 * Sem BD. Cobre (1) a permissão «integration.read» (`podeVerIntegracao`) com a tabela de
 * verdade de perfis × contexto × email, (2) a projeção de estado de sincronização para o
 * cliente e (3) guardas de ESTRUTURA: o que não pode voltar a existir no código do tenant.
 *
 *   npx tsx scripts/tests/test-integracao-restrita.ts
 */
import Module from "node:module";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const M = Module as unknown as { _resolveFilename: (r: string, ...a: unknown[]) => string };
const resolverOriginal = M._resolveFilename;
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === "server-only" ? __filename : resolverOriginal.call(this, request, ...rest);
};

let ok = 0;
let ko = 0;
const check = (c: boolean, label: string, d?: string) => {
  if (c) { ok++; console.log(`  [OK]    ${label}`); }
  else { ko++; console.log(`  [FALHA] ${label}${d ? ` — ${d}` : ""}`); }
};
const ler = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

async function main() {
  process.env.PLATFORM_ADMIN_EMAILS = "Tecnico@Sier.test, outro@sier.test";
  const { podeVerIntegracao } = await import("../../lib/integracao/acesso");
  const { LEGACY_TENANT } = await import("../../lib/session-claims");
  const { estadoParaCliente } = await import("../../lib/sync-request/estado");

  const sess = (perfil: string, email: string, tenant: string) =>
    ({ sub: "u1", email, nome: "x", perfil, farmaciaId: null, tenant }) as never;

  console.log("\nA · permissão integration.read");
  check(podeVerIntegracao(sess("ADMINISTRADOR", "tecnico@sier.test", LEGACY_TENANT)) === true, "técnico (ADMINISTRADOR, contexto não-tenant, email na env) → permitido");
  check(podeVerIntegracao(sess("ADMINISTRADOR", "TECNICO@SIER.TEST", LEGACY_TENANT)) === true, "email comparado sem maiúsculas/minúsculas");
  check(podeVerIntegracao(null) === false, "sem sessão → recusado");
  for (const perfil of ["GESTOR_GRUPO", "GESTOR_FARMACIA", "OPERADOR"]) {
    check(podeVerIntegracao(sess(perfil, "tecnico@sier.test", LEGACY_TENANT)) === false, `${perfil} com email listado, contexto não-tenant → recusado`);
  }
  for (const tenant of ["silveira", "garantia", "segurado"]) {
    check(podeVerIntegracao(sess("ADMINISTRADOR", "tecnico@sier.test", tenant)) === false, `ADMINISTRADOR do tenant «${tenant}» COM o email do técnico → recusado (email sozinho não basta)`);
    check(podeVerIntegracao(sess("ADMINISTRADOR", "admin@cliente.pt", tenant)) === false, `ADMINISTRADOR do tenant «${tenant}» → recusado`);
    check(podeVerIntegracao(sess("GESTOR_GRUPO", "admin@cliente.pt", tenant)) === false, `GESTOR_GRUPO do tenant «${tenant}» → recusado`);
    check(podeVerIntegracao(sess("OPERADOR", "admin@cliente.pt", tenant)) === false, `OPERADOR do tenant «${tenant}» → recusado`);
  }
  check(podeVerIntegracao(sess("ADMINISTRADOR", "desconhecido@sier.test", LEGACY_TENANT)) === false, "ADMINISTRADOR não-tenant fora da lista → recusado");
  process.env.PLATFORM_ADMIN_EMAILS = "";
  check(podeVerIntegracao(sess("ADMINISTRADOR", "tecnico@sier.test", LEGACY_TENANT)) === false, "env vazia → ninguém tem a permissão (falha fechada)");
  delete process.env.PLATFORM_ADMIN_EMAILS;
  check(podeVerIntegracao(sess("ADMINISTRADOR", "tecnico@sier.test", LEGACY_TENANT)) === false, "env ausente → ninguém tem a permissão (falha fechada)");

  console.log("\nB · estado de sincronização para o cliente");
  const bruto = { estado: "FALHOU", resultado: { stockAtualizado: 1 }, erro: "SEGREDO", ultimaSincronizacaoOk: "2026-01-01T00:00:00Z", farmaciaId: "f" };
  const lim = estadoParaCliente(bruto);
  check(lim.resultado === null && lim.erro === null, "resultado e erro técnicos removidos");
  check(lim.estado === "FALHOU" && lim.ultimaSincronizacaoOk === bruto.ultimaSincronizacaoOk && lim.farmaciaId === "f", "estado e data da última atualização preservados");
  check(!JSON.stringify(lim).includes("SEGREDO") && !JSON.stringify(lim).includes("stockAtualizado"), "nada de técnico no JSON enviado");
  check(bruto.erro === "SEGREDO", "não muta o original");

  console.log("\nC · estrutura (o que não pode voltar)");
  check(!existsSync("app/configuracoes/integracao/actions.ts"), "as server actions de integração do tenant foram removidas (nada para chamar diretamente)");
  check(!existsSync("lib/integracao/outbox-data.ts") && !existsSync("components/integracao/outbox-client.tsx"), "o loader e o cliente de integração do tenant foram removidos");
  const pagTenant = ler("app/configuracoes/integracao/page.tsx");
  check(!/prisma|outbox|Outbox|MainShell/.test(pagTenant), "a rota antiga não carrega dados nem renderiza UI — só redireciona");
  check(/podeVerIntegracao/.test(pagTenant) && /redirect\(/.test(pagTenant), "a rota antiga decide o destino no servidor");
  const shell = ler("components/layout/app-shell.tsx");
  check(!/integra[cç]/i.test(shell), "o menu do tenant não tem «Integração» nem o seu href");
  check(/\/admin\/integracao/.test(ler("components/admin/admin-shell.tsx")), "o menu do console /admin tem «Integração»");
  const pagAdmin = ler("app/admin/integracao/page.tsx");
  check(/await requireIntegracao\(\)/.test(pagAdmin), "a página /admin/integracao repete o gate no servidor (não depende do layout)");
  const acesso = ler("lib/integracao/acesso.ts");
  check(!/@[a-z0-9-]+\.[a-z]{2,}/i.test(acesso.replace(/\/\*[\s\S]*?\*\//g, "")), "nenhum email/utilizador escrito no código do gate");
  const adminActions = ler("app/admin/actions.ts");
  check((adminActions.match(/export async function admin(Retry|Cancel)OutboxAction[\s\S]*?requirePlatformAdmin\(\)/g) ?? []).length === 2, "as operações manuais de outbox exigem o gate de plataforma");
  const detalhe = ler("components/encomendas/order-detail-client.tsx");
  check(!/Tentativas|Timeline de exportação|Último erro|spharmSqlError|httpStatus/.test(detalhe), "o detalhe da encomenda não mostra tentativas/timeline/erros");
  const loader = ler("lib/encomendas/order-detail.ts");
  check(!/lastError: true|attemptCount: true|orderExportAudit/.test(loader), "o loader do detalhe nem lê tentativas/erros/auditoria de exportação");
  const widget = ler("components/stock/sync-now-widget.tsx");
  check(!/long-polling|status\.erro|status\.resultado|fabricantesAlterados/.test(widget.replace(/\/\*[\s\S]*?\*\//g, "")), "o widget de sincronização não mostra erros/contagens/long-polling");
  const sync = ler("app/stock/sync-actions.ts");
  check((sync.match(/status: estadoParaCliente\(/g) ?? []).length === 2, "as actions do widget devolvem sempre o estado projetado");
  check(!/classificação de fabricantes|grupos laboratoriais/.test(sync.replace(/\/\*[\s\S]*?\*\//g, "")), "a mensagem de recusa ao cliente não expõe razões internas");

  console.log(`\n${ok} OK, ${ko} falhas`);
  process.exit(ko === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
