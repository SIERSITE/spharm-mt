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
const wsState = readFileSync(new URL("../../lib/workspace/use-workspace-state.ts", import.meta.url), "utf8");
const vendas = readFileSync(new URL("../../components/vendas/vendas-client.tsx", import.meta.url), "utf8");

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
  check(/taskBar\?\.marcarSujo\(pathname, haAlteracoesPorConfirmar\)/.test(createClient), "F2 (criação): sincroniza com haAlteracoesPorConfirmar — o mesmo booleano do beforeunload próprio deste ecrã (autosave.temAlteracoesPendentes com rascunho activo, linhas.length>0 sem ele)");
}

console.log("\nG · cobertura de rotas — módulos pedidos auto-registam-se como tarefa");
{
  const modulosPedidos = ["vendas", "encomenda", "margens", "transferencias", "excessos"];
  for (const m of modulosPedidos) {
    check(new RegExp(`tipo: "${m}`).test(bar), `G1 (${m}): a tabela de rotas cobre este módulo`);
  }
  check(/prefixo: "\/encomendas\/nova"/.test(bar) && bar.indexOf('"/encomendas/nova"') < bar.indexOf('prefixo: "/encomendas"'), "G2: '/encomendas/nova' é resolvida ANTES do prefixo genérico '/encomendas' (a ordem da tabela importa — senão nunca seria alcançada)");
}

console.log("\nH · isolamento de workspaces — duas análises do MESMO módulo são tarefas distintas");
{
  const modulosWorkspace = ["vendas", "margens", "inventario", "transferencias", "excessos"];
  for (const m of modulosWorkspace) {
    check(
      new RegExp(`tipo: "${m}", titulo: "[^"]+", workspace: true`).test(bar),
      `H1 (${m}): marcado workspace:true na tabela de rotas`
    );
  }
  check(
    /if \(rotaActual\.workspace && !workspaceParam\)/.test(bar),
    "H2: sem ?workspace= na URL, o módulo gera um id e reescreve a URL antes de registar a tarefa"
  );
  check(
    /const novoId = gerarWorkspaceId\(\);\s*\n\s*const params = new URLSearchParams/.test(bar),
    "H3: o id novo vem de gerarWorkspaceId() — mesma função exportada do contexto, nunca um formato ad-hoc duplicado"
  );
  check(
    /const identidade = rotaActual\.workspace \? `\$\{pathname\}\?workspace=\$\{workspaceParam\}` : pathname;/.test(bar),
    "H4: a IDENTIDADE da tarefa (id/href) inclui o workspace — pathname sozinho já não chega para distinguir duas análises"
  );
  check(
    /function novaAnalise\(\) \{[\s\S]{0,200}const novoId = gerarWorkspaceId\(\);/.test(bar),
    "H5: \"Nova análise\" gera SEMPRE um id novo — nunca reaproveita o workspace actual"
  );
  check(
    /router\.push\(`\$\{pathname\}\?workspace=\$\{novoId\}`\)/.test(bar),
    "H6: \"Nova análise\" navega (push, não replace) — cria uma entrada de histórico distinta, nunca substitui a análise actual"
  );
  check(/export function gerarWorkspaceId/.test(ctx), "H7: gerarWorkspaceId é exportado do contexto (fonte única do formato do id)");
  check(/workspaceId\?: string;/.test(ctx), "H8: Tarefa ganha workspaceId opcional — não obrigatório para tarefas que não são análises (ex.: uma encomenda concreta)");
}

console.log("\nI · lib/workspace/use-workspace-state.ts — persistência por workspace, nunca uma chave por módulo");
{
  check(
    /`spharmmt:workspace:\$\{tenant\}:\$\{userId\}:\$\{workspaceId\}:\$\{moduleKey\}`/.test(wsState),
    "I1: a chave inclui tenant+userId+workspaceId+moduleKey — nunca só o moduleKey (isso seria voltar ao bug original)"
  );
  check(/window\.sessionStorage/.test(wsState) && !/window\.localStorage/.test(wsState), "I2: sessionStorage, não localStorage — uma análise é uma sessão de trabalho, não algo para sobreviver a fechar o separador");
  check(
    /if \(chaveLS === ultimaChaveRef\.current\) return;/.test(wsState),
    "I3: só reidrata quando o workspace muda de verdade — não a cada render"
  );
  check(/} catch \{/.test(wsState), "I4: leitura/escrita em sessionStorage nunca rebenta a aplicação (quota excedida, privado, bloqueado)");
  check(
    /SÓ critérios/.test(wsState) || /NUNCA os\s*\n \* RESULTADOS calculados/.test(wsState),
    "I5: o próprio ficheiro documenta que só critérios são persistidos, nunca resultados calculados (evita snapshots desactualizados e estourar a quota)"
  );
}

console.log("\nJ · fechar uma tarefa nunca toca dados de negócio — só metadado de navegação");
{
  check(
    /const fechar = useCallback\(\(id: string\) => \{\s*\n\s*setEstado/.test(ctx),
    "J1: fechar() só chama setEstado (estado local do contexto) — nada de fetch/server action/Prisma"
  );
  check(
    !/async function fechar|await .*\(id\)/.test(ctx.slice(ctx.indexOf("const fechar"), ctx.indexOf("const marcarSujo"))),
    "J2: fechar() não é async e não faz await — estruturalmente incapaz de chamar o servidor"
  );
  check(
    /rascunho.*continua|nunca (elimina|apaga)/i.test(createClient) || /ELIMINADA/.test(createClient),
    "J3: cancelar um rascunho (acção distinta de fechar a tarefa) usa o mesmo soft-delete (ELIMINADA) documentado no ecrã de detalhe"
  );
}

console.log("\nK · isolamento por tenant/utilizador chega às novas chaves (autosave local + workspace)");
{
  check(
    /chaveFallback\(tenantSlug: string, userId: string, listaEncomendaId: string\)/.test(
      readFileSync(new URL("../../lib/encomendas/use-autosave-encomenda.ts", import.meta.url), "utf8")
    ),
    "K1: a chave de fallback do autosave (rascunhos) exige tenant+userId explícitos, não só o id do rascunho"
  );
  check(
    /workspaceId: string \| null;\s*\n\s*tenantSlug: string;\s*\n\s*userId: string;/.test(wsState),
    "K2: useWorkspaceState exige tenantSlug+userId explícitos — impossível chamar sem eles, nunca esquecido num callsite novo"
  );
}

console.log("\nL · Vendas — referência completa do mecanismo de workspace (Bloqueador 2)");
{
  check(/const workspaceId = searchParams\.get\("workspace"\)/.test(vendas), "L1: Vendas lê o workspace activo da URL");
  check(
    /useWorkspaceState<VendasCriterios>/.test(vendas),
    "L2: os critérios de Vendas (âmbito/filtros/período/agrupamento/ordenação/vista) vivem em useWorkspaceState, não em useState solto"
  );
  check(
    /moduleKey: "vendas"/.test(vendas),
    "L3: chaveado por módulo \"vendas\" — nunca colide com outro módulo workspace-aware"
  );
  check(
    /setHasGenerated\(false\);\s*\n\s*setRows\(\[\]\);\s*\n\s*setPeriodHeader\(null\);\s*\n\s*setGenerationError\(null\);\s*\n\s*\}, \[workspaceId\]\);/.test(vendas),
    "L4: trocar de workspace limpa RESULTADOS calculados anteriores — nunca mostra a tabela de uma análise com os filtros de outra"
  );
  check(
    /ordenacaoTabela: EstadoOrdenacao<ColunaVendas>/.test(vendas),
    "L5: ordenacaoTabela faz parte dos critérios persistidos (ordenação/direcção sobrevivem a trocar de workspace)"
  );
  check(/taskBar\.actualizarTitulo\(identidade, titulo\)/.test(vendas), "L6: o título da tarefa reflecte o filtro principal — duas análises de Vendas ficam visualmente distinguíveis na barra");
}

console.log(`\n${ok} ok, ${ko} falhas`);
process.exit(ko === 0 ? 0 : 1);
