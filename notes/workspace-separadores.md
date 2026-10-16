# Workspace — estado por separador («documentos abertos»)

## Diagnóstico (arquitetura anterior)

1. **Lista de separadores:** `lib/workspace/task-bar-context.tsx` (`TaskBarProvider`, no `RootLayout`); metadados em `localStorage` por tenant+utilizador.
2. **Identidade:** módulos de relatório (Vendas, Margens, Inventário, Transferências, Excessos) = `pathname?workspace=<id>`; todas as outras rotas = `pathname`.
3. **Ativar outro separador:** `router.push(href)` — uma NAVEGAÇÃO do Next.js App Router.
4. **O conteúdo anterior é desmontado:** sim. Cada rota é uma página; o Next monta a nova e desmonta a antiga.
5. **O separador guardava só** `{id, título, tipo, href, sujo, workspaceId}` (e o `href` era só a rota, sem pesquisa/página).
6. **Porque o título ficava e o estado desaparecia:** o título/URL vivem no `RootLayout` (persiste); os `useState` vivem na página (desmontada). Só os *critérios* de 5 módulos sobreviviam (`use-workspace-state.ts`, sessionStorage); resultados, seleção, expansões, rascunhos, scroll e pesquisas ainda não aplicadas perdiam-se.
7. **Componentes globais:** `RootLayout` → `SessionProvider` → `TaskBarProvider`; `AppShell` (por página) → `TaskBar`, `ArtigoPanel` (`?ficha=`).
8. **Store/cache já previstos:** só `useWorkspaceState` (critérios, sessionStorage). Nada para resultados.
9. **Duas instâncias da mesma rota:** só nos 5 módulos `workspace: true`; os critérios eram isolados, os resultados não existiam fora da página.
10. **Estado local que se perdia:** ver inventário.

### Alternativas avaliadas
* `cacheComponents` do Next 16 (`<Activity>`): preserva ≤ 3 rotas, por rota (não por separador), e obriga a reescrever TODAS as páginas (dinâmicas por sessão/tenant/BD) para viverem sob `<Suspense>` com opt-in de cache. Rejeitado.
* Manter várias rotas montadas: o `children` do layout é só a rota ativa. Impossível sem iframes.
* sessionStorage/localStorage para resultados: quota, serialização de Set/Map, dados de tenant em armazenamento persistente. Rejeitado.

## Arquitetura implementada

| Peça | Papel |
|---|---|
| `lib/workspace/armazem-separadores.ts` | Armazém EM MEMÓRIA, `escopo(tenant:utilizador) → separador → chave`, referências (sem cópias/JSON). `limparSeparador`, `manterApenas`, `limparForaDoEscopo`. |
| `lib/workspace/estado-separador.ts` | `useEstadoSeparador(chave, inicial, {ativo?})` (substitui `useState`), `useAlteracoesPendentes(bool)`, `useIdSeparador()`. |
| `lib/workspace/rotas.ts` | Tabela de rotas, `identidadeDoSeparador`, `hrefDoSeparador` (fonte única). |
| `components/layout/scroll-separadores.tsx` | Scroll da janela + `[data-scroll-key]` guardado/restaurado por separador, sem integração por página. |
| `components/layout/voltar-origem.tsx` + `Tarefa.origemId` | «Voltar a …» com a origem REAL. |
| `TaskBarProvider` | `escopo`, `actualizarHref` (localização completa), limpeza ao fechar/evictar/terminar sessão/mudar de tenant. |

Regras do hook: o setter escreve sempre no armazém do separador que o criou, mesmo que a página já esteja desmontada (**um pedido concluído em segundo plano aparece ao regressar, sem repetir a consulta**); mudar de `?workspace=` com a página montada re-hidrata para o separador de destino; `ativo:false` suspende a persistência (ex.: proposta de encomenda fora do modo «farmácia»).

## Ciclo de vida
* mudar de separador: preserva; voltar: restaura no 1.º render (sem flash de página vazia);
* fechar / evictar (tecto de 14): liberta o estado (efeito do provider por diferença de ids);
* terminar sessão / mudar de tenant/utilizador: `limparForaDoEscopo` — nada fica na memória;
* sessão expirada: o `RootLayout` volta a render com `userId=null` → escopo nulo → limpa;
* refresh completo: a memória perde-se (como antes); critérios dos 5 módulos continuam em sessionStorage;
* **nunca** se usa localStorage/sessionStorage para resultados.

## Inventário auditado
| Área | Estado preservado | Fora (porquê) |
|---|---|---|
| Vendas | resultado, período, seleção, painéis, subtab (critério), scroll tabela/janela, ordenação (critério) | modal de encomenda (transitório) |
| Manutenção de Vendas | pesquisa/página via URL do separador; scroll da janela | — (sem integração própria) |
| Inventário / Transferências / Excessos | resultado gerado, painéis, snapshot, scroll da janela | pesquisa interna da tabela de Transferências/Excessos (`query`, transitória) |
| Margens | resultado, filtros do resultado, linhas expandidas, «Mostrar todos», cache e pedidos de comparação CNPEM, scroll | — |
| Encomendas — nova | critérios, filtros da tabela, página, ordenação, nome e (modo farmácia) proposta; rascunho recupera-se por `?rascunho=` | rascunho/autosave/consolidação (versões e idempotência vivem no servidor) |
| Encomendas — detalhe | seleção de linhas, fornecedor em massa | linhas (autosave no servidor) |
| Stock / Catálogo | pesquisa, página, ordenação, filtros (URL guardado no separador), texto da pesquisa, scroll | a lista é renderizada no servidor: o regresso faz um render RSC da rota |
| Fichas de artigo | separador próprio; «Voltar a …» com a origem real | painel lateral `?ficha=` (transitório) |
| Dashboard, Devoluções, Admin | scroll da janela (genérico) | sem estado local relevante; Admin fora do workspace |

## Memória e desempenho
O armazém guarda referências (sem JSON). Teto de 14 separadores; fechar liberta. Os resultados de Vendas/Margens (milhares de linhas) já existiam em memória enquanto a página estava aberta — agora persistem até se fechar o separador. Sem polling ou timers novos; as páginas não ficam montadas em segundo plano (não há efeitos, foco, atalhos ou IDs duplicados de separadores ocultos).

## Alterações pendentes
`useAlteracoesPendentes(bool)` → indicador no separador + confirmação ao fechar (já existente) e ao terminar sessão (agora para QUALQUER separador sujo). Integrado em Encomendas (quantidades editadas); as páginas só de leitura não pedem confirmação.

## Limitações
* regressar a uma rota repete o render de servidor dessa rota (filtros/listas leves; Stock/Catálogo/Encomendas listam no servidor), mas nenhuma geração de relatório, comparação ou Server Action;
* proposta de encomenda: rascunho recupera-se do servidor (não da memória);
* refresh do browser limpa a memória;
* scroll dentro de contentores só se guarda se declararem `data-scroll-key` (Vendas e Margens declaram; a janela é sempre guardada).
