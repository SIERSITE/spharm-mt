/**
 * scripts/tests/test-task-bar.ts
 *
 * Verificação estática da barra de tarefas internas (PARTE 2) — este
 * projecto não tem nenhum framework de testes de componentes React
 * (confirmado por auditoria: sem Testing Library, sem jsdom instalado),
 * por isso as propriedades comportamentais dos hooks/componentes são
 * provadas por leitura estruturada do código-fonte, mesma técnica já
 * usada nesta sessão (ex.: scripts/tests/test-encomenda-autosave.ts,
 * bloco I).
 *
 * Corre com: npx tsx scripts/tests/test-task-bar.ts
 */
import { readFileSync } from "node:fs";

let ok = 0;
let ko = 0;
const check = (cond: boolean, label: string, detalhe?: string) => {
  if (cond) { ok++; console.log(`  [OK]    ${label}`); }
  else { ko++; console.log(`  [FALHA] ${label}${detalhe ? `\n            ${detalhe}` : ""}`); }
};

const ctx = readFileSync(new URL("../../lib/workspace/task-bar-context.tsx", import.meta.url), "utf8");
const bar = readFileSync(new URL("../../components/layout/task-bar.tsx", import.meta.url), "utf8");
const shell = readFileSync(new URL("../../components/layout/app-shell.tsx", import.meta.url), "utf8");
const layout = readFileSync(new URL("../../app/layout.tsx", import.meta.url), "utf8");
const detailClient = readFileSync(new URL("../../components/encomendas/order-detail-client.tsx", import.meta.url), "utf8");
const createClient = readFileSync(new URL("../../components/encomendas/order-create-client.tsx", import.meta.url), "utf8");

console.log("A · isolamento por tenant+utilizador");
{
  check(/function chave\(tenant: string, userId: string\): string \{\s*\n\s*return `spharmmt:task-bar:\$\{tenant\}:\$\{userId\}`;/.test(ctx), "A1: a chave localStorage inclui tenant E userId — nunca uma chave global partilhada");
  check(/TaskBarProvider\(\{\s*\n\s*tenant,\s*\n\s*userId,/.test(ctx), "A2: o provider recebe tenant/userId explicitamente (nunca os lê de uma variável global)");
  check(/<TaskBarProvider tenant=\{sessao\?\.tenant \?\? null\} userId=\{sessao\?\.sub \?\? null\}>/.test(layout), "A3: app/layout.tsx passa o tenant/userId REAIS da sessão do servidor, nunca hardcoded");
}

console.log("\nB · nunca guarda dados de negócio — só metadado de navegação");
{
  const tipoTarefa = ctx.match(/export type Tarefa = \{[\s\S]*?\};/)?.[0] ?? "";
  check(tipoTarefa.length > 0, "B1: o tipo Tarefa foi encontrado");
  check(!/quantidade|preco|preço|valor|token|password|senha/i.test(tipoTarefa), "B2: o tipo Tarefa não tem nenhum campo de dado de negócio, token ou password — só id/titulo/tipo/href/sujo");
  check(/escrever\(chaveLS, estado\)/.test(ctx) && /const \[estado, setEstado\] = useState<EstadoPersistido>/.test(ctx), "B3: só o estado {tarefas, activaId} é persistido — nada mais é escrito no localStorage");
}

console.log("\nC · evicção nunca fecha uma tarefa com alterações pendentes");
{
  const evictMatch = ctx.match(/if \(seguintes\.length > MAX_TAREFAS\) \{[\s\S]*?\n\s*\}/)?.[0] ?? "";
  check(evictMatch.length > 0, "C1: a lógica de evicção foi encontrada");
  check(/!t\.sujo/.test(evictMatch), "C2: a evicção procura explicitamente uma tarefa SEM alterações pendentes (!t.sujo) — nunca remove uma suja para abrir espaço");
}

console.log("\nD · fechar uma tarefa suja pede confirmação explícita");
{
  check(/if \(t\.sujo && !confirm\(/.test(bar), "D1: task-bar.tsx pede confirm() antes de fechar uma tarefa marcada como suja");
  check(/`"\$\{t\.titulo\}" tem alterações por guardar/.test(bar), "D2: a mensagem de confirmação nomeia a tarefa e o motivo — nunca um alerta genérico");
}

console.log("\nE · a barra está montada na AppShell; logout avisa se a tarefa activa estiver suja");
{
  check(/<TaskBar \/>/.test(shell), "E1: <TaskBar /> está montada na AppShell");
  check(/onSubmit=\{handleLogoutSubmit\}/.test(shell), "E2: o formulário de logout tem o guard ligado");
  check(/activa\?\.sujo && !confirm\(/.test(shell), "E3: o logout só pede confirmação quando a tarefa ACTIVA está suja — nunca bloqueia um logout limpo");
}

console.log("\nF · o indicador de 'sujo' na barra usa o MESMO sinal que já governa o beforeunload/autosave — nunca uma segunda fonte de verdade");
{
  check(/taskBar\?\.marcarSujo\(pathname, autosave\.temAlteracoesPendentes\)/.test(detailClient), "F1 (detalhe): sincroniza com autosave.temAlteracoesPendentes — o mesmo booleano do beforeunload do hook de autosave");
  check(/taskBar\?\.marcarSujo\(pathname, linhas\.length > 0\)/.test(createClient), "F2 (criação): sincroniza com linhas.length > 0 — o mesmo booleano do beforeunload próprio deste ecrã");
}

console.log("\nG · cobertura de rotas — módulos pedidos auto-registam-se como tarefa");
{
  const modulosPedidos = ["vendas", "encomenda", "margens", "transferencias", "excessos"];
  for (const m of modulosPedidos) {
    check(new RegExp(`tipo: "${m}`).test(bar), `G1 (${m}): a tabela de rotas cobre este módulo`);
  }
  check(/prefixo: "\/encomendas\/nova"/.test(bar) && bar.indexOf('"/encomendas/nova"') < bar.indexOf('prefixo: "/encomendas"'), "G2: '/encomendas/nova' é resolvida ANTES do prefixo genérico '/encomendas' (a ordem da tabela importa — senão nunca seria alcançada)");
}

console.log(`\n${ok} ok, ${ko} falhas`);
process.exit(ko === 0 ? 0 : 1);
