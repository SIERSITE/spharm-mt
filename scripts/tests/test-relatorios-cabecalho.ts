/**
 * scripts/tests/test-relatorios-cabecalho.ts
 *
 * Sem BD. Guardas de ESTRUTURA das três correções de interface:
 *   1 · «Vista relatório» de Excessos/Transferências sem identificação fixa de nenhuma farmácia/cliente;
 *   2 · Vendas sem o botão «Ver em ecrã» (nunca teve ação);
 *   3 · cabeçalho com o título do ecrã (não o literal «Dashboard»).
 *
 *   npx tsx scripts/tests/test-relatorios-cabecalho.ts
 */
import { readFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

let ok = 0;
let ko = 0;
const check = (c: boolean, label: string, d?: string) => {
  if (c) {
    ok++;
    console.log(`  [OK]    ${label}`);
  } else {
    ko++;
    console.log(`  [FALHA] ${label}${d ? ` — ${d}` : ""}`);
  }
};
const ler = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
function listar(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(path.join(process.cwd(), dir))) {
    const rel = `${dir}/${n}`;
    const st = statSync(path.join(process.cwd(), rel));
    if (st.isDirectory()) listar(rel, out);
    else if (/\.(tsx?|css)$/.test(n)) out.push(rel);
  }
  return out;
}

async function main() {
  console.log("\nA · nenhum dado de cliente fixo no código da aplicação");
  const codigo = [...listar("components"), ...listar("app"), ...listar("lib")];
  const proibidos: Array<[RegExp, string]> = [
    [/507529930/, "NIF 507529930"],
    [/Farmácia Silveirense, Lda/, "«Farmácia Silveirense, Lda»"],
    [/SoftReis Informática<\/div>/, "rodapé fixo «SoftReis Informática»"],
    [/Página 1 de 1<\/div>/, "rodapé fixo «Página 1 de 1»"],
  ];
  for (const [re, nome] of proibidos) {
    const achados = codigo.filter((f) => re.test(ler(f)));
    check(achados.length === 0, `sem ${nome} em components/, app/ e lib/`, achados.join(", "));
  }

  console.log("\nB · Excessos e Transferências: «Vista relatório» usa o cabeçalho e a data reais");
  for (const f of ["components/excessos/excessos-client.tsx", "components/transferencias/transferencias-client.tsx"]) {
    const s = ler(f);
    check(/\{organizacaoRelatorio\}/.test(s), `${path.basename(f)}: cabeçalho da vista = organizacaoRelatorio`);
    check(/organization: organizacaoRelatorio/.test(s), `${path.basename(f)}: Imprimir/PDF/Excel/Email usam a MESMA constante`);
    check(/formatDatePt\(dataGeracaoRelatorio\)/.test(s) && !/formatDatePt\("20\d\d-\d\d-\d\d"\)/.test(s), `${path.basename(f)}: data = data de geração (sem data fixa)`);
  }
  const { hojeIsoLisboa } = await import("../../lib/relatorio-data");
  check(hojeIsoLisboa(new Date("2026-11-19T10:00:00Z")) === "2026-11-19", "hojeIsoLisboa: dia normal");
  check(hojeIsoLisboa(new Date("2026-06-30T23:30:00Z")) === "2026-07-01", "hojeIsoLisboa: 23:30 UTC no verão já é dia 1 em Lisboa");
  check(hojeIsoLisboa(new Date("2026-12-31T23:59:00Z")) === "2026-12-31", "hojeIsoLisboa: inverno sem desvio");

  console.log("\nC · Vendas sem «Ver em ecrã»");
  const todos = codigo.filter((f) => f.startsWith("components/") || f.startsWith("app/"));
  const comBotao = todos.filter((f) => /Ver em ecrã/.test(ler(f)) && !/encomendas-client\.tsx$/.test(f));
  check(comBotao.length === 0, "nenhum ficheiro (exceto o órfão encomendas-client) tem «Ver em ecrã»", comBotao.join(", "));
  check(!/function ActionButton/.test(ler("components/vendas/vendas-client.tsx")), "removido o componente que não aceitava ação");

  console.log("\nD · título do cabeçalho");
  const shell = ler("components/layout/app-shell.tsx");
  check(!/slate-500">Dashboard<\/div>/.test(shell), "o cabeçalho já não tem o literal «Dashboard»");
  check(/tituloDoEcra\(pathname\)/.test(shell) && /resolverRota/.test(shell), "usa a tabela de rotas dos separadores");

  console.log(`\n${ok} OK, ${ko} falhas`);
  process.exit(ko ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
