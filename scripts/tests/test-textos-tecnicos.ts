/**
 * scripts/tests/test-textos-tecnicos.ts
 *
 * Sem BD. Guarda de ESTRUTURA: o código de interface dos tenants (components/ e app/, exceto a consola de plataforma
 * `app/admin`, `components/admin`) não pode conter texto técnico visível ao cliente: agent, outbox, StagingCompraRawLine,
 * «pipeline de movimentos», «trigger explícito», «lê da BD», read-model/IPF, long-polling. Só olha para código (comentários
 * removidos). O comportamento (HTML/payload por perfil e por tenant) é provado em `scripts/e2e/textos-tecnicos.e2e.ts`.
 *
 *   npx tsx scripts/tests/test-textos-tecnicos.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

let ok = 0;
let ko = 0;
const check = (c: boolean, label: string, d?: string) => {
  if (c) { ok++; console.log(`  [OK]    ${label}`); } else { ko++; console.log(`  [FALHA] ${label}${d ? ` — ${d}` : ""}`); }
};
const ler = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const semComentarios = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
function listar(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(path.join(process.cwd(), dir))) {
    const rel = `${dir}/${n}`;
    if (statSync(path.join(process.cwd(), rel)).isDirectory()) listar(rel, out);
    else if (/\.tsx$/.test(n)) out.push(rel);
  }
  return out;
}

const ficheirosTenant = [...listar("components"), ...listar("app")].filter(
  (f) => !/^(components|app)\/admin\//.test(f) && !/^app\/api\//.test(f),
);

console.log("\nA · nenhum texto técnico nos ecrãs dos tenants");
const PROIBIDOS: Array<[RegExp, string]> = [
  [/StagingCompraRawLine/, "StagingCompraRawLine"],
  [/pipeline de movimentos/i, "«pipeline de movimentos»"],
  [/trigger explícito/i, "«trigger explícito»"],
  [/l[êe] da BD/i, "«lê da BD»"],
  [/movimentos ingeridos/i, "«movimentos ingeridos»"],
  [/running balance/i, "«running balance»"],
  [/IPF read-model|saúde do read-model/i, "IPF / read-model"],
  [/long-polling/i, "long-polling"],
  [/["'`>][^"'`<]*\bo agent\b[^"'`<]*["'`<]/i, "«o agent»"],
  [/Outbox: \$\{/, "«Outbox: id»"],
];
for (const [re, nome] of PROIBIDOS) {
  const achados = ficheirosTenant.filter((f) => re.test(semComentarios(ler(f))));
  check(achados.length === 0, `sem ${nome}`, achados.join(", "));
}

console.log("\nB · menu dos tenants sem «Integração»");
const shell = semComentarios(ler("components/layout/app-shell.tsx"));
check(!/label: "Integração"/.test(shell) && !/configuracoes\/integracao/.test(shell), "o menu lateral não tem a entrada «Integração»");
check(/\/admin\/integracao/.test(semComentarios(ler("components/admin/admin-shell.tsx"))), "a consola de plataforma tem a entrada (só técnicos)");
check(/redirect\(/.test(ler("app/configuracoes/integracao/page.tsx")) && !/getPrisma|prisma/.test(ler("app/configuracoes/integracao/page.tsx")), "/configuracoes/integracao só redireciona e não toca na BD");

console.log("\nC · mensagens que substituíram as técnicas");
check(/Ainda não há movimentos disponíveis/.test(ler("components/stock/extrato-movimentos.tsx")), "extrato: «Ainda não há movimentos disponíveis…»");
check(/taxa de IVA da última compra/.test(ler("components/margens/margens-client.tsx")) && /taxa de IVA da última compra/.test(ler("components/inventario/inventario-client.tsx")), "Margens e Inventário: explicação do IVA em linguagem corrente");
check(!/ipfFreshness/.test(ler("components/oportunidades/oportunidades-inbox.tsx")), "Oportunidades: sem cartão técnico do estado dos dados");
check(/Tentar enviar de novo esta encomenda\?/.test(ler("components/encomendas/order-detail-client.tsx")), "detalhe da encomenda: confirmações sem «agent»");

console.log(`\n${ok} OK, ${ko} falhas`);
process.exit(ko ? 1 : 0);
